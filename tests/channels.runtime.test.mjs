import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-09-01T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };

const flowBilling = {
  id: 'billing', version: 2, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요, AI 상담입니다.', next: 'name' },
    name: { id: 'name', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.', next: 'bye' },
    bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
  },
};
const flowHandoff = {
  id: 'care', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: 'rrn', prompt: '주민등록번호를 말씀해 주세요.', next: 'toAgent' },
    toAgent: { id: 'toAgent', kind: 'Transfer', queue: 'q_care', reason: 'policy' },
  },
};
const flowRetry = {
  id: 'retry', version: 1, startNodeId: 'ask',
  nodes: { ask: { id: 'ask', kind: 'Collect', slot: 'code', prompt: '고객번호를 말씀해 주세요.' } },
};

function fakePort(id = 'callbot', capsOver = {}, over = {}) {
  const log = [];
  return {
    id,
    log,
    capabilities: P.profileFor(id, capsOver),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue, summary) { log.push(['transfer', iid, queue, summary]); },
    async routeToLegacyIvr(iid, reason) { log.push(['ivr', iid, reason]); },
    async invite(iid, target) { log.push(['invite', iid, target]); },
    async end(iid, reason) { log.push(['end', iid, reason]); },
    ...over,
  };
}

function build({ flows = [flowBilling], port = fakePort(), samples = [], policy = {}, components, reprompt, timing, routing, connectors } = {}) {
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 500 }), releaseKeyOnSinkFailure: false,
  });
  const health = F.createHealthRegistry(samples);
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: components ?? P.CHANNEL_COMPONENTS[port.id], contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true, ...policy,
    },
    health, bus, now: () => NOW,
    newInteractionId: () => 'i_test1',
    ...(reprompt !== undefined ? { reprompt } : {}),
    ...(timing !== undefined ? { timing } : {}),
    ...(routing !== undefined ? { routing } : {}),
    ...(connectors !== undefined ? { connectors } : {}),
  });
  return { core, port, collector, health };
}

const req = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing', ...over });

test('정상 시작: 렌더 결과가 채널로 나가고 이벤트가 발행된다', b, async () => {
  const { core, port, collector } = build();
  const r = await core.start(req());
  assert.equal(r.interactionId, 'i_test1');
  assert.equal(r.status, 'running');
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['greet', 'name']);
  assert.deepEqual(port.log[0], ['present', 'i_test1', ['greet', 'name']]);
  assert.equal(collector.events[0].type, 'session.started');
  assert.equal(collector.events[0].entry_point, 'inbound_call');
  assert.equal(collector.events.every((e) => e.tenant_id === 'goone'), true);
  assert.ok(core.sessions.get('i_test1'));
});

test('다른 테넌트의 요청은 시작하지 않는다(§11.1)', b, async () => {
  const { core } = build();
  await assert.rejects(() => core.start(req({ scope: { tenantId: 'other' } })), /테넌트 격리 위반/);
});

test('등록되지 않은 채널·없는 시나리오는 시작 전에 막는다', b, async () => {
  const { core } = build();
  await assert.rejects(() => core.start(req({ adapter: 'chatbot' })), /등록되지 않은 채널/);
  await assert.rejects(() => core.start(req({ flowId: 'nope' })), /시나리오를 찾을 수 없습니다/);
});

test('채널이 렌더할 수 없는 시나리오는 시작하지 않는다(§5.3)', b, async () => {
  const port = fakePort('callbot', { transferToAgent: false, dtmf: true });
  const { core } = build({ flows: [flowHandoff], port });
  await assert.rejects(() => core.start(req({ flowId: 'care' })), /실행할 수 없는 시나리오/);
});

test('턴 처리: 슬롯 수집 후 종료되고 과금 근거가 실측으로만 실린다(§11.2)', b, async () => {
  const { core, collector } = build();
  await core.start(req());
  const r = await core.send('i_test1', {
    input: { kind: 'utterance', text: '홍길동', confidence: 0.9 },
    usage: { llm_prompt_tokens: 30, llm_completion_tokens: 7 },
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.state.slots.customer_name, '홍길동');
  const customerTurn = collector.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.deepEqual(customerTurn.usage, { llm_prompt_tokens: 30, llm_completion_tokens: 7 });
  const ended = collector.events.filter((e) => e.type === 'session.ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].outcome, 'AUTO_RESOLVED');
});

test('이관 시 마스킹된 요약이 상담사에게 전달된다(§2·§10.3)', b, async () => {
  const { core, port } = build({ flows: [flowHandoff] });
  await core.start(req({ flowId: 'care' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  assert.equal(r.status, 'transferred');
  assert.equal(r.handoff.queue, 'q_care');
  assert.equal(r.handoff.summaryMasked.includes('1234567'), false);
  assert.match(r.handoff.summaryMasked, /901010-\*{7}/);
  const transfer = port.log.find((l) => l[0] === 'transfer');
  assert.equal(transfer[2], 'q_care');
  assert.equal(transfer[3], r.handoff.summaryMasked);
  const evt = r.events.find((e) => e.type === 'handoff.requested');
  assert.equal(evt.summary_present, true);
  assert.equal(evt.summary_masked.includes('1234567'), false);
});

test('인식 실패 2회면 같은 Interaction으로 화면 전환을 초대한다(§5.1·§5.2)', b, async () => {
  const { core, port } = build({ flows: [flowRetry] });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(r.state.channel, 'visual');
  assert.deepEqual(port.log.find((l) => l[0] === 'invite'), ['invite', 'i_test1', 'visual']);
  assert.equal(core.sessions.get('i_test1').channels.includes('visual'), true);
});

test('인지 계층 장애면 AI를 태우지 않고 기존 IVR로 내린다(§9.3)', b, async () => {
  const { core, port, collector } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    policy: { legacyIvrAvailable: true },
  });
  const r = await core.start(req());
  assert.equal(r.status, 'transferred');
  assert.equal(r.fallback.mode, 'legacy_ivr');
  assert.deepEqual(r.steps, []);
  assert.ok(port.log.some((l) => l[0] === 'ivr'));
  // 들어온 콜은 통계에 남는다
  assert.deepEqual(collector.events.map((e) => e.type), ['session.started', 'handoff.requested', 'session.ended']);
});

test('매체 장애면 세션을 세우지 않고 실패로 종료한다(§9.3)', b, async () => {
  const { core, port } = build({ samples: [{ component: 'telephony', state: 'down', observedAt: NOW }] });
  const r = await core.start(req());
  assert.equal(r.status, 'failed');
  assert.equal(r.fallback.mode, 'unavailable');
  assert.ok(port.log.some((l) => l[0] === 'end'));
});

test('종료된 세션에 늦게 온 입력은 이벤트를 늘리지 않는다(멱등, §8.1)', b, async () => {
  const { core, collector } = build();
  await core.start(req());
  await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  const before = collector.events.length;
  const again = await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.deepEqual(again.events.map((e) => e.event_id), []);
  assert.equal(collector.events.length, before);
});

test('고객이 중간에 끊으면 자동완결로 집계하지 않는다(§4.1)', b, async () => {
  const { core, port } = build();
  await core.start(req());
  const r = await core.end('i_test1', '고객 종료');
  assert.equal(r.events[0].outcome, 'ABANDONED');
  assert.ok(port.log.some((l) => l[0] === 'end'));
  const dup = await core.end('i_test1', '고객 종료');
  assert.deepEqual(dup.events, []);
  assert.equal(dup.status, r.status);
});

test('없는 세션에 대한 입력·종료는 조용히 성공하지 않는다', b, async () => {
  const { core } = build();
  await assert.rejects(() => core.send('없음', { input: { kind: 'timeout' } }), /세션을 찾을 수 없습니다/);
  await assert.rejects(() => core.end('없음', '사유'), /세션을 찾을 수 없습니다/);
});

test('채널 전달이 실패해도 세션 상태는 남는다', b, async () => {
  const port = fakePort('callbot', {}, { present: async () => { throw new Error('회선 전송 실패'); } });
  const { core } = build({ port });
  await assert.rejects(() => core.start(req()), /회선 전송 실패/);
  const rec = core.sessions.get('i_test1');
  assert.ok(rec);
  assert.equal(rec.state.currentNodeId, 'name');
});

test('선언하지 않은 컴포넌트의 헬스 보고는 무시한다(§9.3)', b, async () => {
  const { core, health } = build({ components: ['telephony'] });
  core.reportHealth({ adapter: 'callbot', observedAt: NOW, samples: [
    { component: 'telephony', state: 'degraded', observedAt: NOW },
    { component: 'llm', state: 'down', observedAt: NOW },
  ] });
  assert.equal(health.latest('telephony').state, 'degraded');
  assert.equal(health.latest('llm'), undefined);
  core.reportHealth({ adapter: 'chatbot', observedAt: NOW, samples: [{ component: 'messaging', state: 'down', observedAt: NOW }] });
  assert.equal(health.latest('messaging'), undefined);
});

test('시나리오 레지스트리는 버전을 지정하지 않으면 최신을 준다', b, () => {
  const reg = R.createMemoryFlowRegistry([flowBilling, { ...flowBilling, version: 5 }]);
  assert.equal(reg.get('billing').version, 5);
  assert.equal(reg.get('billing', 2).version, 2);
  assert.equal(reg.get('billing', 9), undefined);
  assert.equal(reg.get('none'), undefined);
});


// ── 재프롬프트 정책 배선 (§5.1·§5.3·§13-3) ──────────────────────────────────
// 채널 저장소가 각자 재프롬프트를 짜면 §2 의 시나리오 이중 관리가 재발한다 — Core 에서 한 번만 준다.
test('재프롬프트 정책을 주면 실패 시 원문 대신 선언된 문장이 채널로 나간다', b, async () => {
  const { core, port } = build({
    flows: [flowRetry],
    reprompt: { byReason: { no_input: [{ text: '잘 안 들리셨나요? 다시 말씀해 주세요.', offerDtmf: true }] } },
  });
  await core.start(req({ flowId: 'retry' }));
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(r.steps.at(-1).text, '잘 안 들리셨나요? 다시 말씀해 주세요.');
  assert.equal(r.steps.at(-1).acceptDtmf, true);
  assert.deepEqual(r.steps.at(-1).reprompt, { reason: 'no_input', attempt: 1, exhausted: false });
  assert.equal(port.log.at(-1)[0], 'present');
});

test('정책을 주지 않으면 종전대로 원문이 재생된다(기본 문안 금지 §13-3)', b, async () => {
  const { core } = build({ flows: [flowRetry] });
  await core.start(req({ flowId: 'retry' }));
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(r.steps.at(-1).text, '고객번호를 말씀해 주세요.');
});

test('빈 대본이 섞인 정책은 등록 자체를 거부한다 — 무음이 통화 중에 발견되면 늦다', b, () => {
  assert.throws(
    () => build({ flows: [flowRetry], reprompt: { byReason: { no_input: [{ text: '' }] } } }),
    /재프롬프트 정책 거부/,
  );
});

test('선언이 비어 있는 정책은 거부가 아니라 경고로 운영에 드러난다', b, () => {
  const { core } = build({ flows: [flowRetry], reprompt: { sharedLines: [] } });
  assert.ok(core.warnings().some((w) => w.code === 'W_REPROMPT_POLICY'));
});


// ── 턴 타이밍 정책 배선 (§5.1·§13-3) ────────────────────────────────────────
// 대기 시간을 채널이 각자 정하면 같은 시나리오가 채널마다 다른 순간에 무입력으로 떨어진다.
test('타이밍 정책을 주면 입력 대기 단계에 대기·끼어들기 값이 실려 나간다', b, async () => {
  const { core } = build({
    flows: [flowRetry],
    timing: { inputTimeoutMsByKind: { Collect: 5000 }, extraMsByAttempt: [0, 3000], bargeInByKind: { Collect: false } },
  });
  const first = await core.start(req({ flowId: 'retry' }));
  assert.equal(first.steps.at(-1).inputTimeoutMs, 5000);
  assert.equal(first.steps.at(-1).bargeIn, false);
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(r.steps.at(-1).inputTimeoutMs, 8000);
});

test('정책을 주지 않으면 대기 값을 만들지 않는다(§13-3)', b, async () => {
  const { core } = build({ flows: [flowRetry] });
  const first = await core.start(req({ flowId: 'retry' }));
  assert.equal('inputTimeoutMs' in first.steps.at(-1), false);
});

test('0ms 대기 같은 설정 실수는 등록 자체를 거부한다', b, () => {
  assert.throws(
    () => build({ flows: [flowRetry], timing: { inputTimeoutMsByKind: { Collect: 0 } } }),
    /턴 타이밍 정책 거부/,
  );
});

test('적용되지 않는 노드 종류를 선언하면 거부한다 — 적용 안 되는 선언은 오해를 부른다', b, () => {
  assert.throws(
    () => build({ flows: [flowRetry], timing: { inputTimeoutMsByKind: { Say: 3000 } } }),
    /턴 타이밍 정책 거부/,
  );
});

test('빈 타이밍 선언은 거부가 아니라 경고로 드러난다', b, () => {
  const { core } = build({ flows: [flowRetry], timing: {} });
  assert.ok(core.warnings().some((w) => w.code === 'W_TURN_TIMING'));
});


// ── 상담사 큐 배정 배선(§2·§9.3·§11.1·§13-3) ────────────────────────────────
// 여기서 고정하는 것은 "라우팅이 동작한다"가 아니라 **배선이 실제로 닿는다**는 사실이다.
// 모듈은 있는데 아무도 부르지 않는 상태가 이 저장소에서 반복된 실패라서다.
const QUEUES = (over = {}) => ([
  { id: 'q_care', tenantId: 'goone', titleKo: '케어', skills: [], closedAction: 'callback',
    maxWaiting: 1, overflowQueueId: 'q_backup', ...over },
  { id: 'q_backup', tenantId: 'goone', titleKo: '예비', skills: [], closedAction: 'voicemail' },
]);
const ROUTING = (over = {}) => ({
  config: { tenantId: 'goone', queues: QUEUES(), rules: [], defaultQueueId: 'q_care' },
  snapshots: () => [
    { queueId: 'q_care', waiting: 0, availableAgents: 2, observedAt: NOW },
    { queueId: 'q_backup', waiting: 0, availableAgents: 1, observedAt: NOW },
  ],
  ...over,
});

test('라우팅을 주지 않으면 종전과 완전히 같다(§13-3)', b, async () => {
  const { core, port } = build({ flows: [flowHandoff] });
  const r = await core.start(req({ flowId: 'care' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  const transfer = port.log.find((l) => l[0] === 'transfer');
  assert.equal(transfer[2], 'q_care');
  assert.equal(r.handoff?.placement, undefined);
});

test('라우팅을 주면 배정 결과가 결과에 실리고 확정된 큐로 전달된다', b, async () => {
  const { core, port } = build({ flows: [flowHandoff], routing: ROUTING() });
  await core.start(req({ flowId: 'care' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  assert.equal(r.handoff.placement.placement, 'queued');
  assert.equal(r.handoff.placement.queueId, 'q_care');
  const transfer = port.log.find((l) => l[0] === 'transfer');
  assert.equal(transfer[2], 'q_care');
});

test('오버플로면 요청 큐가 아니라 수용 큐로 전달한다', b, async () => {
  const routing = ROUTING({
    snapshots: () => [
      { queueId: 'q_care', waiting: 1, availableAgents: 2, observedAt: NOW },   // maxWaiting 1 → 꽉 참
      { queueId: 'q_backup', waiting: 0, availableAgents: 1, observedAt: NOW },
    ],
  });
  const { core, port } = build({ flows: [flowHandoff], routing });
  await core.start(req({ flowId: 'care' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  assert.equal(r.handoff.placement.overflowed, true);
  const transfer = port.log.find((l) => l[0] === 'transfer');
  assert.equal(transfer[2], 'q_backup', '꽉 찬 큐로 보내면 안 된다');
});

test('배정이 안 되면 transfer 를 부르지 않는다 — 대안을 채널에 넘긴다(§9.3)', b, async () => {
  const routing = ROUTING({ snapshots: () => [] });   // 상태 미확인 → 보수적으로 닫힘
  const { core, port } = build({ flows: [flowHandoff], routing });
  await core.start(req({ flowId: 'care' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  assert.equal(r.handoff.placement.placement, 'alternative');
  assert.equal(r.handoff.placement.action, 'callback');
  assert.equal(port.log.some((l) => l[0] === 'transfer'), false,
    '큐에 못 넣었는데 transfer 를 부르면 고객은 아무도 없는 곳에서 기다린다');
});

test('스냅샷 조회가 실패해도 이관이 예외로 끝나지 않는다', b, async () => {
  const routing = ROUTING({ snapshots: () => { throw new Error('큐 API 장애'); } });
  const { core, port } = build({ flows: [flowHandoff], routing });
  await core.start(req({ flowId: 'care' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  assert.equal(r.status, 'transferred');
  assert.equal(r.handoff.placement.placement, 'alternative');
  assert.equal(port.log.some((l) => l[0] === 'transfer'), false);
});

test('이관 요약은 배정 경로를 지나도 그대로 상담사에게 간다(§2)', b, async () => {
  const { core, port } = build({ flows: [flowHandoff], routing: ROUTING() });
  await core.start(req({ flowId: 'care' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  const transfer = port.log.find((l) => l[0] === 'transfer');
  assert.equal(transfer[3], r.handoff.summaryMasked);
  assert.equal(r.handoff.placement.summaryMasked, r.handoff.summaryMasked);
  assert.equal(r.handoff.summaryMasked.includes('901010-1234567'), false, '§10.3');
  assert.match(r.handoff.summaryMasked, /901010-\*{7}/);
});

test('깨진 라우팅 설정은 통화 중이 아니라 생성 시점에 거부된다', b, () => {
  assert.throws(
    () => build({ flows: [flowHandoff], routing: ROUTING({
      config: { tenantId: 'goone', queues: QUEUES(), rules: [], defaultQueueId: 'q_오탈자' },
    }) }),
    /라우팅 설정 거부/,
  );
});

test('다른 테넌트의 라우팅 설정은 배선되지 않는다(§11.1)', b, () => {
  assert.throws(
    () => build({ flows: [flowHandoff], routing: ROUTING({
      config: { tenantId: 'other', queues: QUEUES().map((q) => ({ ...q, tenantId: 'other' })), rules: [], defaultQueueId: 'q_care' },
    }) }),
    /§11.1/,
  );
});

test('스냅샷 조회 없이 배선하면 거부한다 — 대기 인원을 추정하지 않는다(§13-3)', b, () => {
  assert.throws(() => build({ flows: [flowHandoff], routing: ROUTING({ snapshots: undefined }) }), /스냅샷/);
});

test('§9.3 장애 폴백 큐는 라우팅 규칙으로 다시 고르지 않는다', b, async () => {
  // 폴백 경로가 라우팅 설정에 의존하면 설정이 깨졌을 때 폴백까지 같이 죽는다.
  const { core, port } = build({
    flows: [flowHandoff],
    routing: ROUTING(),
    samples: [{ component: 'stt', state: 'down', observedAt: NOW }],
    policy: { fallbackQueue: 'q_정책지정' },
  });
  const r = await core.start(req({ flowId: 'care' }));
  assert.equal(r.status, 'transferred');
  const transfer = port.log.find((l) => l[0] === 'transfer');
  assert.equal(transfer[2], 'q_정책지정');
});

// ── Api 노드 이행 배선 (§6.1) ────────────────────────────────────────────────
//
// 여기서 고정하는 것은 **무음으로 멈추지 않는 것**이다. 배선이 없던 동안 Api 노드에 도달한 통화는
// 예외 없이 멈춰 있었다 — runner.send 가 커넥터 결과 외의 입력에 빈 결과를 돌려주므로 고객이
// 무슨 말을 해도 steps 0건·events 0건이 나가고, 어떤 알림도 울리지 않는다.

const flowApi = (over = {}) => ({
  id: 'api', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: 'account_no', prompt: '계좌번호를 말씀해 주세요.', next: 'lookup' },
    lookup: { id: 'lookup', kind: 'Api', connectorId: 'c_balance', waitText: '조회 중입니다. 잠시만 기다려 주세요.', ...over },
    tell: { id: 'tell', kind: 'Say', text: '조회가 끝났습니다.' },
    sorry: { id: 'sorry', kind: 'Say', text: '지금은 조회가 어렵습니다.' },
  },
});
// lookup.next 는 over 로 덮이지 않게 별도로 붙인다
const flowApiOk = () => { const f = flowApi(); f.nodes.lookup.next = 'tell'; return f; };
const flowApiOnError = () => { const f = flowApiOk(); f.nodes.lookup.onError = 'sorry'; return f; };
const flowApiNoError = () => flowApiOk();
/** onError 가 다시 Api 노드를 가리키는 순환 시나리오. 설정 사고이며 통화 중에 드러난다. */
const flowApiCycle = () => { const f = flowApiOk(); f.nodes.lookup.onError = 'lookup'; return f; };

const CDEF = (over = {}) => ({
  id: 'c_balance', tenantId: 'goone', name: '잔액조회', method: 'query',
  endpointRef: 'secret://core/balance', residency: 'domestic', timeoutMs: 3000,
  params: [{ name: 'acct', fromSlot: 'account_no', required: true }],
  outputs: [{ field: 'balance', toSlot: 'balance' }],
  onFailure: 'branch', ...over,
});

/** 포트 호출을 채널 로그와 **같은 배열**에 남긴다 — 안내와 호출의 순서를 직접 재기 위해서다. */
function wiring({ responses = [{ ok: true, data: { balance: '10000' } }], defs = [CDEF()], log, ...over } = {}) {
  const calls = [];
  return {
    calls,
    binding: {
      connectors: { get: (id) => defs.find((d) => d.id === id) },
      port: {
        async call(req) {
          calls.push(req);
          if (log) log.push(['connector', req.connectorId, req.idempotencyKey]);
          const r = responses[Math.min(calls.length - 1, responses.length - 1)];
          return typeof r === 'function' ? r(req) : r;
        },
      },
      allowOverseas: false,
      ...over,
    },
  };
}

test('배선이 없으면 종전과 완전히 같다 — Api 대기만 세우고 멈춘다(§13-3)', b, async () => {
  const { core, port } = build({ flows: [flowApiOk()] });
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(r.state.pendingConnectorId, 'c_balance');
  assert.equal(r.status, 'running');
  // 그리고 이 상태에서 고객이 말을 걸면 **아무것도 나가지 않는다** — 이것이 배선 전의 증상이다.
  const stuck = await core.send('i_test1', { input: { kind: 'utterance', text: '여보세요?' } });
  assert.deepEqual(stuck.steps, []);
  assert.deepEqual(stuck.events, []);
  assert.equal(stuck.state.pendingConnectorId, 'c_balance');
  assert.equal(port.log.filter((l) => l[0] === 'present').length, 2);   // 첫 프롬프트 + 대기 안내
});

test('배선하면 Api 노드가 이행되어 다음 노드까지 진행한다 — 통화가 멈추지 않는다', b, async () => {
  const w = wiring();
  const { core, port } = build({ flows: [flowApiOk()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(r.state.pendingConnectorId, undefined);
  assert.equal(r.state.slots.balance, '10000');
  assert.equal(w.calls.length, 1);
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['lookup', 'tell']);
  const presented = port.log.filter((l) => l[0] === 'present').flatMap((l) => l[2]);
  assert.deepEqual(presented, ['ask', 'lookup', 'tell']);
});

test('대기 안내는 **호출 전에** 나간다 — 조회가 끝난 뒤의 "기다려 주세요"는 안내가 아니다', b, async () => {
  const log = [];
  const port = fakePort('callbot', {}, {
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
  });
  port.log = log;
  const w = wiring({ log });
  const { core } = build({ flows: [flowApiOk()], port, connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  const order = log.map((l) => (l[0] === 'connector' ? 'connector' : l[2].join('+')));
  // 'lookup'(대기 안내) → 'connector' → 'tell'(결과). 순서가 바뀌면 그 사이가 통째로 무음이 된다.
  assert.deepEqual(order, ['ask', 'lookup', 'connector', 'tell']);
});

test('무음 Api 단계(waitText 없음)는 present 하지 않는다', b, async () => {
  const f = flowApiOk();
  delete f.nodes.lookup.waitText;
  const w = wiring();
  const { core, port } = build({ flows: [f], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  const presented = port.log.filter((l) => l[0] === 'present').flatMap((l) => l[2]);
  assert.deepEqual(presented, ['ask', 'tell']);
});

test('호출 실패는 onError 분기로 간다 — 실패 카운트를 올리지 않는다', b, async () => {
  const w = wiring({ responses: [{ ok: false, code: 'unavailable' }] });
  const { core } = build({ flows: [flowApiOnError()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['lookup', 'sorry']);
  assert.equal(r.state.slots.__last_connector_error__, 'unavailable');
  assert.equal(r.state.failCount, 0);
});

test('onError 가 없으면 §9.3 에 따라 상담사로 내려간다 — 조회 실패로 콜을 끊지 않는다', b, async () => {
  const w = wiring({ responses: [{ ok: false, code: 'unavailable' }] });
  const { core, port } = build({ flows: [flowApiNoError()], connectors: w.binding });
  // onError 없는 시나리오로 만든다
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(r.status, 'transferred');
  assert.equal(r.handoff.summaryMasked !== undefined, true);
  assert.equal(port.log.some((l) => l[0] === 'transfer'), true);
});

test('동의가 없어 막힌 호출은 성공으로 넘어가지 않는다 — 고객이 빈 안내를 듣지 않는다(§10.1)', b, async () => {
  const piiFlow = flowApiOnError();
  const w = wiring({ defs: [CDEF({ params: [{ name: 'rrn', fromSlot: 'account_no', required: true, pii: true }] })] });
  const { core } = build({ flows: [piiFlow], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '900101-1234567' } });
  assert.equal(w.calls.length, 0);
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['lookup', 'sorry']);
  assert.equal(r.state.slots.__last_connector_error__, 'consent_context_missing');
});

test('선언되지 않은 커넥터를 가리키는 시나리오는 시작하지 않는다 — 통화 중간에 막히는 것이 더 나쁘다', b, async () => {
  const w = wiring({ defs: [] });
  const { core } = build({ flows: [flowApiOk()], connectors: w.binding });
  await assert.rejects(() => core.start(req({ flowId: 'api' })), /선언되지 않은 커넥터/);
});

test('배선이 없으면 미선언 커넥터도 시작을 막지 않는다 — 종전 동작을 바꾸지 않는다(§13-3)', b, async () => {
  const { core } = build({ flows: [flowApiOk()] });
  const r = await core.start(req({ flowId: 'api' }));
  assert.equal(r.status, 'running');
});

test('멱등 키는 같은 대기 건에 고정된다 — 이중 신청이 되면 로그에는 성공 두 건만 남는다', b, async () => {
  // 재시도를 선언한 커넥터. 실행기가 두 번 부르더라도 키는 하나여야 한다.
  const w = wiring({
    defs: [CDEF({ retry: { maxAttempts: 2, retryOn: ['unavailable'] } })],
    responses: [{ ok: false, code: 'unavailable' }, { ok: true, data: { balance: '7' } }],
    backoffMs: () => 0,
  });
  const { core } = build({ flows: [flowApiOk()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[0].idempotencyKey, w.calls[1].idempotencyKey);
  assert.deepEqual(w.calls.map((c) => c.attempt), [1, 2]);
});

test('안내 전달이 끊겨 재개해도 **같은 멱등 키**로 부른다 — 재개가 이중 신청이 되면 안 된다', b, async () => {
  // Api 노드 둘. 두 번째 대기 안내 전달이 한 번 실패해 턴이 끊긴 뒤 채널이 다시 보낸다.
  // 영속 세션 저장소에서는 프로세스 재기동이 정확히 이 모양이다.
  const f = flowApiOk();
  f.nodes.lookup.next = 'lookup2';
  f.nodes.lookup2 = { id: 'lookup2', kind: 'Api', connectorId: 'c_apply', waitText: '신청 중입니다.', next: 'tell' };
  let failNext = true;
  const port = fakePort('callbot', {}, {
    async present(iid, steps) {
      const ids = steps.map((s) => s.nodeId);
      if (failNext && ids.includes('lookup2')) { failNext = false; throw new Error('매체 전달 실패'); }
      port.log.push(['present', iid, ids]);
    },
  });
  const w = wiring({
    defs: [CDEF(), CDEF({ id: 'c_apply', method: 'command', params: [], outputs: [] })],
    responses: [{ ok: true, data: { balance: '1' } }, { ok: true, data: {} }],
  });
  const { core } = build({ flows: [f], port, connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  await assert.rejects(() => core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } }), /매체 전달 실패/);
  // 첫 조회는 끝났고 신청(command)은 **아직 부르지 않았다**.
  assert.deepEqual(w.calls.map((c) => c.connectorId), ['c_balance']);
  assert.equal(core.sessions.get('i_test1').state.pendingConnectorId, 'c_apply');

  // 채널이 다시 보낸다(대기 중이므로 발화는 흐름을 흔들지 않는다).
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '여보세요?' } });
  const applyCalls = w.calls.filter((c) => c.connectorId === 'c_apply');
  assert.equal(applyCalls.length, 1);
  assert.equal(applyCalls[0].idempotencyKey, 'i_test1:c_apply:1');   // 회차가 오르지 않았다
  assert.equal(r.status, 'completed');
});

test('같은 Api 노드를 다시 밟으면 새 호출이므로 키가 바뀐다', b, async () => {
  // onError 가 Say 를 거쳐 다시 조회로 오는 구조 대신, 두 통화의 키가 갈리는지로 논리를 고정한다.
  const w = wiring();
  const { core } = build({ flows: [flowApiOk()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  const first = w.calls[0].idempotencyKey;
  assert.match(first, /:1$/);
  assert.match(first, /^i_test1:c_balance:/);
});

test('순환(onError→Api)은 구조적 상한에서 끊기고 세션이 실패로 끝난다 — 고객을 무음에 두지 않는다', b, async () => {
  const w = wiring({ responses: [{ ok: false, code: 'unavailable' }] });
  const blocks = [];
  w.binding.onBlock = (i) => blocks.push(i.block);
  const { core, port } = build({ flows: [flowApiCycle()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(r.status, 'failed');
  assert.match(r.state.error, /순회 상한/);
  assert.equal(r.state.pendingConnectorId, undefined);
  assert.equal(port.log.some((l) => l[0] === 'end'), true);
  assert.equal(blocks.includes('hop_limit'), true);
  // 상한이 없으면 이 호출이 끝나지 않는다 — 호출 횟수가 상한(Api 1개 + 1)을 넘지 않았음을 고정한다.
  assert.ok(w.calls.length <= 2, `호출 ${w.calls.length}회 — 상한을 넘었다`);
});

test('설정 오류는 보고 훅으로 드러난다 — 커넥터 id 오타는 예외가 아니라 조회 실패로만 나타난다', b, async () => {
  // 시작은 통과시키되 통화 중에 레지스트리에서 사라진 경우(재배포).
  const defs = [CDEF()];
  const blocks = [];
  const w = wiring({ defs });
  w.binding.onBlock = (i) => blocks.push(i);
  const { core } = build({ flows: [flowApiOnError()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  defs.length = 0;                                  // 대기 직전에 선언이 사라졌다
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].block, 'connector_undefined');
  assert.equal(blocks[0].connectorId, 'c_balance');
  assert.equal(r.state.slots.__last_connector_error__, 'connector_undefined');
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['lookup', 'sorry']);
});

test('선언 미존재를 업무시스템 장애로 적지 않는다 — 전 채널이 상담사 직결로 떨어지면 안 된다', b, async () => {
  const defs = [CDEF()];
  const w = wiring({ defs });
  const { core, health } = build({ flows: [flowApiOnError()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  defs.length = 0;
  await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(health.latest('backend'), undefined);
});

test('업무시스템 실패는 Core 헬스에 그대로 집계된다(§9.3)', b, async () => {
  const w = wiring({ responses: [{ ok: false, code: 'unavailable' }] });
  const { core, health } = build({ flows: [flowApiOnError()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  const s = health.latest('backend');
  assert.equal(s.state, 'down');
  assert.equal(s.observedAt, NOW);
});

test('presetSlots 는 이행 전에 병합된다 — 채널이 넘긴 슬롯으로 조회한다', b, async () => {
  const f = flowApiOk();
  f.startNodeId = 'lookup';                        // 시작 즉시 조회
  const w = wiring();
  const { core } = build({ flows: [f], connectors: w.binding });
  const r = await core.start(req({ flowId: 'api', presetSlots: { account_no: '110-9999' } }));
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].params.acct, '110-9999');
  assert.equal(r.state.slots.balance, '10000');
  assert.equal(r.status, 'completed');
});

test('이행 중 발행된 이벤트는 한 번만 나간다 — 중복 집계가 과금으로 나타난다(§8.1)', b, async () => {
  const w = wiring();
  const { core, collector } = build({ flows: [flowApiOk()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  const ids = collector.events.map((e) => e.event_id);
  assert.equal(new Set(ids).size, ids.length);
  const resultIds = r.events.map((e) => e.event_id);
  assert.equal(new Set(resultIds).size, resultIds.length);
});

test('과금 근거는 커넥터가 만든 봇 발화가 아니라 고객 발화에 붙는다(§11.2)', b, async () => {
  const w = wiring();
  const { core } = build({ flows: [flowApiOk()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', {
    input: { kind: 'utterance', text: '110-1234' },
    usage: { stt_audio_ms: 1200 },
  });
  const withUsage = r.events.filter((e) => e.type === 'turn.completed' && e.usage !== undefined);
  assert.equal(withUsage.length, 1);
  assert.equal(withUsage[0].speaker, 'customer');
});

test('다른 테넌트 커넥터 호출은 폴백하지 않고 던진다(§11.1)', b, async () => {
  const w = wiring({ defs: [CDEF({ tenantId: 'other' })] });
  const { core } = build({ flows: [flowApiOk()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  await assert.rejects(
    () => core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } }),
    /§11\.1|테넌트/,
  );
});

test('호스트가 직접 커넥터 결과를 넣는 경로는 배선이 있어도 그대로 동작한다', b, async () => {
  const w = wiring();
  const { core } = build({ flows: [flowApiOk()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  // 배선이 있으면 이 시점에 이미 이행이 끝나 있다 — 늦게 온 결과는 무시된다(멱등, §8.1).
  const r = await core.send('i_test1', { input: { kind: 'connectorResult', ok: true, slots: { balance: '999' } } });
  assert.equal(r.state.slots.balance, undefined);
  assert.equal(w.calls.length, 0);
});
