import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null, EV = null, DF = null, LC = null, CO = null, CN = null;
try {
  CO = await import('../src/consent/executeConsent.ts');
  CN = await import('../src/consent/consent.ts');
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
  EV = await import('../src/events/store.ts');
  DF = await import('../src/flow/deployedFlows.ts');
  LC = await import('../src/flow/lifecycle.ts');
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
    async invite(iid, target, ticket) { log.push(['invite', iid, target, ticket]); },
    async end(iid, reason) { log.push(['end', iid, reason]); },
    ...over,
  };
}

function build({ flows = [flowBilling], registry, port = fakePort(), ports, samples = [], policy = {}, components, reprompt, timing, routing, connectors, channelSwitch, disclosure, intent, knowledge, consent, qa } = {}) {
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 500 }), releaseKeyOnSinkFailure: false,
  });
  const health = F.createHealthRegistry(samples);
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: registry ?? R.createMemoryFlowRegistry(flows),
    channels: (ports ?? [port]).map((p) => ({
      port: p, reportsComponents: components ?? P.CHANNEL_COMPONENTS[p.id], contractVersion: 1,
    })),
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
    ...(channelSwitch !== undefined ? { channelSwitch } : {}),
    ...(disclosure !== undefined ? { disclosure } : {}),
    ...(intent !== undefined ? { intent } : {}),
    ...(knowledge !== undefined ? { knowledge } : {}),
    ...(consent !== undefined ? { consent } : {}),
    ...(qa !== undefined ? { qa } : {}),
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
  assert.deepEqual(port.log.find((l) => l[0] === 'invite'), ['invite', 'i_test1', 'visual', undefined]);
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

// ── 채널 전환 배선(§5.2·§10.3·§11.1) ────────────────────────────────────────
// 여기서 고정하는 결함은 **예외가 아니라 조용한 열림**이다. 배선이 없으면 합류는
// Interaction id 하나로 통과하고, 그 id 는 링크 URL·프록시 로그·상담 메모에 남는다.

let CS = null;
try { CS = await import('../src/core/channelSwitch.ts'); } catch { /* 구형 런타임 */ }

const darsPort = (over = {}) => fakePort('dars', {}, over);

function switchWiring(over = {}) {
  let n = 0;
  const invites = CS.createInviteRegistry();
  return {
    invites,
    binding: {
      invites,
      newToken: () => `tk_switch_${++n}`,
      ttlMs: 300000,
      carry: { allow: ['customer_name'] },
      reachable: () => true,
      delivery: 'sms',
      ...over,
    },
  };
}

test('배선 없음: 전환 링크에 실릴 것이 id 뿐이라는 사실을 경고로 드러낸다(§5.2)', b, async () => {
  const { core } = build({ flows: [flowRetry] });
  const w = core.warnings().filter((i) => i.code === 'W_CHANNEL_SWITCH_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /Interaction id/);
});

test('배선 있음: 전환 초대에 1회용 티켓이 실리고 토큰은 id 와 얽히지 않는다', b, async () => {
  const sw = switchWiring();
  const port = fakePort();
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  assert.equal(core.warnings().some((i) => i.code === 'W_CHANNEL_SWITCH_UNBOUND'), false);
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(r.state.channel, 'visual');
  const inv = port.log.find((l) => l[0] === 'invite');
  assert.equal(inv[2], 'visual');
  assert.equal(inv[3].token, 'tk_switch_1');
  assert.equal(inv[3].token.includes('i_test1'), false);
  assert.ok(inv[3].expiresAt > NOW);
  // 티켓에 슬롯 값이 실리지 않는다(§10.3).
  assert.equal(JSON.stringify(inv[3]).includes('customer_name'), false);
});

test('배선 있음: 고객 단말 수신이 확인되지 않으면 전환하지 않고 §5.1 사다리를 따른다', b, async () => {
  const sw = switchWiring({ reachable: () => false });
  const port = fakePort();
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  // 화면으로 넘어간 척하지 않는다 — 통화 중인 고객에게 화면용 단계를 내보내면 안 된다.
  assert.equal(r.state.channel, 'voice');
  assert.equal(port.log.some((l) => l[0] === 'invite'), false);
  assert.equal(r.status, 'transferred');
  assert.ok(port.log.some((l) => l[0] === 'transfer'));
});

test('배선 있음: 목적지 채널이 등록돼 있지 않으면 전환을 고르지 않는다(§9.3)', b, async () => {
  const sw = switchWiring();
  const port = fakePort();
  const { core } = build({ flows: [flowRetry], ports: [port], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(r.state.channel, 'voice');
  assert.equal(port.log.some((l) => l[0] === 'invite'), false);
});

test('발급이 막히면 토큰 없는 링크를 만들게 두지 않고 경고로 드러낸다(§10.3)', b, async () => {
  // 토큰이 Interaction id 를 품으면 발급이 거절된다 — 그 상태로 invite 를 부르면
  // 채널은 id 로 링크를 만들 수밖에 없다.
  const sw = switchWiring({ newToken: () => 'tk_i_test1' });
  const port = fakePort();
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(port.log.some((l) => l[0] === 'invite'), false);
  assert.ok(core.warnings().some((i) => i.messageKo.includes('E_TOKEN_WEAK')));
});

test('배선 있음: 토큰 없는 합류는 거부된다 — id 만으로는 들어올 수 없다(§5.2)', b, async () => {
  const sw = switchWiring();
  const dars = darsPort();
  const { core } = build({ flows: [flowBilling], ports: [fakePort(), dars], channelSwitch: sw.binding });
  await core.start(req());
  await assert.rejects(
    () => core.start(req({ adapter: 'dars', joinInteractionId: 'i_test1' })),
    /초대 토큰이 없습니다/,
  );
});

test('배선 있음: 상환된 토큰으로만 합류하고 재사용은 거부된다', b, async () => {
  const sw = switchWiring();
  const dars = darsPort();
  const { core } = build({ flows: [flowBilling], ports: [fakePort(), dars], channelSwitch: sw.binding });
  await core.start(req());
  const rec = core.sessions.get('i_test1');
  const issued = sw.invites.issue({
    scope: SCOPE, interactionId: 'i_test1', fromChannel: 'voice', toChannel: 'visual',
    reason: 'customer_request', delivery: 'sms', token: 'tk_join_1', issuedAt: NOW,
    ttlMs: 300000, slots: rec.state.slots, carry: { allow: [] }, crossChannelInviteSupported: true,
  });
  const joined = await core.start(req({ adapter: 'dars', joinInteractionId: 'i_test1', joinToken: issued.token }));
  assert.equal(joined.interactionId, 'i_test1');
  assert.equal(joined.state.channel, 'visual');
  await assert.rejects(
    () => core.start(req({ adapter: 'dars', joinInteractionId: 'i_test1', joinToken: issued.token })),
    /합류 거부\(already_redeemed\)/,
  );
});

test('배선 있음: 남의 Interaction 을 주장하면 토큰이 맞아도 합류하지 않는다(§1.2)', b, async () => {
  const sw = switchWiring();
  const { core } = build({ flows: [flowBilling], ports: [fakePort(), darsPort()], channelSwitch: sw.binding });
  await core.start(req());
  sw.invites.issue({
    scope: SCOPE, interactionId: 'i_other', fromChannel: 'voice', toChannel: 'visual',
    reason: 'customer_request', delivery: 'sms', token: 'tk_join_2', issuedAt: NOW,
    ttlMs: 300000, carry: { allow: [] }, crossChannelInviteSupported: true,
  });
  await assert.rejects(
    () => core.start(req({ adapter: 'dars', joinInteractionId: 'i_test1', joinToken: 'tk_join_2' })),
    /interaction_mismatch/,
  );
});

test('합류는 워크스페이스까지 본다 — 같은 고객사 다른 사업부는 들어올 수 없다(§11.1)', b, async () => {
  const dars = darsPort();
  const { core } = build({ flows: [flowBilling], ports: [fakePort(), dars] });
  await core.start(req());
  await assert.rejects(
    () => core.start(req({ adapter: 'dars', scope: { tenantId: 'goone', workspaceId: 'ws_other' }, joinInteractionId: 'i_test1' })),
    /워크스페이스 격리 위반/,
  );
});

test('전환 배선 형태 오류는 통화 중이 아니라 생성 시점에 거절한다(§13-3)', b, () => {
  const bad = [
    [{ newToken: undefined }, /토큰 발급기/],
    [{ reachable: undefined }, /수신 가능 여부/],
    [{ ttlMs: 0 }, /유효기간/],
    [{ invites: undefined }, /초대 레지스트리/],
    [{ carry: { allow: 'customer_name' } }, /allowlist/],
  ];
  for (const [over, re] of bad) {
    assert.throws(() => build({ channelSwitch: switchWiring(over).binding }), re);
  }
});

test('배선이 없으면 합류·초대 동작이 종전과 완전히 같다(§13-3)', b, async () => {
  const dars = darsPort();
  const { core } = build({ flows: [flowBilling], ports: [fakePort(), dars] });
  await core.start(req());
  const joined = await core.start(req({ adapter: 'dars', joinInteractionId: 'i_test1' }));
  assert.equal(joined.interactionId, 'i_test1');
  assert.equal(joined.state.channel, 'visual');
});

test('원장 위 버스(createLogBackedEventBus)를 실제로 물려도 통화가 끊기지 않는다', b, async () => {
  // (13)(14) 등이 반복해 지적한 것과 같은 모양의 공백에 대한 회귀 — 조립기가 없으면
  // 이 배선(createEventBus + createLogBackedIdempotencyStore, attach 없이)은 첫 턴에서 던진다.
  const log = EV.createMemoryEventLog(SCOPE);
  const eventBus = EV.createLogBackedEventBus({ scope: SCOPE, log });
  const health = F.createHealthRegistry([]);
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flowBilling]),
    channels: [{ port: fakePort(), reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: { tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false, legacyIvrAvailable: false, agentQueueAvailable: true },
    health, bus: eventBus, now: () => NOW,
    newInteractionId: () => 'i_test1',
  });
  const r = await core.start(req());
  assert.equal(r.status, 'running');
  assert.ok(log.size() >= 1, '세션 시작 이벤트가 원장에 실제로 기록돼야 한다');
  assert.equal(log.read()[0].event.type, 'session.started');
  assert.equal(log.read().every((row) => row.event.tenant_id === 'goone'), true);
});

test('원장 위 버스는 재개된 세션에서도 이벤트를 중복 없이 누적한다', b, async () => {
  const log = EV.createMemoryEventLog(SCOPE);
  const eventBus = EV.createLogBackedEventBus({ scope: SCOPE, log });
  const health = F.createHealthRegistry([]);
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flowBilling]),
    channels: [{ port: fakePort(), reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: { tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false, legacyIvrAvailable: false, agentQueueAvailable: true },
    health, bus: eventBus, now: () => NOW,
    newInteractionId: () => 'i_test1',
  });
  await core.start(req());
  const beforeTurn = log.size();
  await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.ok(log.size() > beforeTurn, '턴 진행 이벤트가 원장에 추가돼야 한다');
  const keys = log.read().map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length, '같은 멱등 키가 원장에 두 번 쌓이면 안 된다');
});

// ── AI 고지 배선(§10.1·§7 7.4·§13-3) ────────────────────────────────────────
//
// 여기서 고정하는 결함의 증상은 **아무 일도 일어나지 않는 것**이다. 배선이 없던 동안
// 어떤 채널에서도 고지가 나가지 않았고, 통화·이벤트·적합성 검사가 모두 정상이었다.

const DISC = (over = {}) => ({
  tenantId: 'goone', enabled: true, approved: true,
  approvedAt: '2026-08-20T00:00:00.000Z', approvedBy: 'legal_kim',
  version: 4, updatedAt: '2026-08-19T00:00:00.000Z', updatedBy: 'admin_lee',
  channels: {
    voice: { text: '본 상담은 AI 상담원이 진행합니다.', placement: 'before_first_response' },
    visual: { text: '이 화면은 AI가 안내합니다.', placement: 'persistent_banner' },
    chat: { text: 'AI 상담원이 답변드립니다.', placement: 'session_start' },
  },
  ...over,
});

test('배선 없음: 고지가 어디에서도 나가지 않는다는 사실을 경고로 드러낸다(§10.1)', b, async () => {
  const { core, port } = build();
  const w = core.warnings().filter((i) => i.code === 'W_AI_DISCLOSURE_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /승인 필요/);
  // 종전과 완전히 같다 — 단계에 고지가 섞이지 않는다(§13-3).
  const r = await core.start(req());
  assert.equal(r.steps.some((s) => s.nodeId === '__disclosure'), false);
  assert.equal(r.disclosure, undefined);
  assert.equal(port.log[0][2].includes('__disclosure'), false);
});

test('배선 있음: 고지가 시나리오 첫 단계보다 앞에 나간다(§10.1)', b, async () => {
  const { core, port } = build({ disclosure: DISC() });
  assert.equal(core.warnings().some((i) => i.code === 'W_AI_DISCLOSURE_UNBOUND'), false);
  const r = await core.start(req());
  // 뒤에 붙으면 AI 가 먼저 말한 뒤에 고지가 나간다 — 순서가 곧 §10.1 준수다.
  assert.equal(r.steps[0].nodeId, '__disclosure');
  assert.equal(r.steps[0].text, '본 상담은 AI 상담원이 진행합니다.');
  assert.deepEqual(r.steps[0].disclosure, { placement: 'before_first_response', configVersion: 4 });
  assert.equal(r.steps[1].nodeId, 'greet');
  // 채널에도 같은 순서로 나간다 — result 만 맞고 present 가 다르면 고지는 없던 일이 된다.
  assert.deepEqual(port.log[0][2][0], '__disclosure');
  assert.deepEqual(r.disclosure, { channel: 'voice', placement: 'before_first_response', configVersion: 4 });
});

test('배선 있음: 같은 채널에 턴마다 반복하지 않는다 — 안내가 잡음이 된다', b, async () => {
  const { core } = build({ disclosure: DISC() });
  await core.start(req());
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(r.steps.some((s) => s.nodeId === '__disclosure'), false);
  assert.equal(r.disclosure, undefined);
});

test('배선 있음: 대기 안내가 첫 발화인 시나리오에서도 고지가 그 앞이다(§6.1)', b, async () => {
  // Api 대기 안내는 커넥터 호출 **전에** present 되므로, 고지를 이행 뒤에 끼우면
  // 고객은 "조회 중입니다"를 먼저 듣는다.
  const w = wiring();
  const { core, port } = build({ flows: [flowApiOk()], connectors: w.binding, disclosure: DISC() });
  await core.start(req({ flowId: 'api', presetSlots: { account_no: '1234' } }));
  assert.equal(port.log[0][2][0], '__disclosure');
});

test('배선 있음: 화면으로 합류하면 그 매체의 고지가 새로 나간다(§5.2)', b, async () => {
  const dars = darsPort();
  const { core } = build({ flows: [flowBilling], ports: [fakePort(), dars], disclosure: DISC() });
  await core.start(req());
  const joined = await core.start(req({ adapter: 'dars', joinInteractionId: 'i_test1' }));
  assert.equal(joined.steps[0].nodeId, '__disclosure');
  assert.equal(joined.steps[0].text, '이 화면은 AI가 안내합니다.');
  assert.equal(joined.disclosure.channel, 'visual');
  // 두 번째 합류에서는 이미 고지한 매체다.
  const again = await core.start(req({ adapter: 'dars', joinInteractionId: 'i_test1' }));
  assert.equal(again.steps.some((s) => s.nodeId === '__disclosure'), false);
});

test('배선 있음: 장애 폴백으로 상담사에게 넘길 때는 고지하지 않는다(§9.3)', b, async () => {
  // AI 가 응대하지 않았으므로 고지 대상이 없다 — 이관 직전의 "AI 가 응대합니다"는 오안내다.
  const { core, port } = build({
    samples: [{ tenantId: 'goone', component: 'llm', state: 'down', observedAt: NOW }],
    disclosure: DISC(),
  });
  const r = await core.start(req());
  assert.equal(r.status, 'transferred');
  assert.equal(r.steps.length, 0);
  assert.equal(r.disclosure, undefined);
  assert.equal(port.log.some((l) => l[0] === 'present'), false);
});

test('배선 거부: 미승인 문구는 생성 시점에 막는다 — 통화 중에 알면 늦다', b, () => {
  assert.throws(() => build({ disclosure: DISC({ approved: false }) }), /AI 고지 배선 거부/);
});

test('배선 거부: 다른 테넌트의 고지 설정은 붙지 않는다(§11.1)', b, () => {
  assert.throws(() => build({ disclosure: DISC({ tenantId: 'other' }) }), /§11.1/);
});

test('배선 거부: 등록된 채널의 빈 문구는 막고, 등록 안 된 채널은 경고도 만들지 않는다', b, () => {
  assert.throws(
    () => build({ disclosure: DISC({ channels: { voice: { text: '', placement: 'session_start' } } }) }),
    /AI 고지 배선 거부/,
  );
  // callbot 하나만 등록된 상태 — visual·chat 문구가 없어도 경고가 생기지 않는다.
  const { core } = build({ disclosure: DISC({ channels: { voice: { text: 'AI 안내입니다.', placement: 'session_start' } } }) });
  assert.deepEqual(core.warnings().filter((i) => i.code === 'W_AI_DISCLOSURE'), []);
});

test('고지를 끈 설정은 붙되 경고로 남고 단계는 나가지 않는다', b, async () => {
  const { core } = build({ disclosure: DISC({ enabled: false }) });
  assert.equal(core.warnings().some((i) => i.code === 'W_AI_DISCLOSURE'), true);
  const r = await core.start(req());
  assert.equal(r.steps.some((s) => s.nodeId === '__disclosure'), false);
});

test('런타임에서 고지가 막히면 AI 응대를 시작하지 않는다', b, async () => {
  // 배선 시점 검증을 지나온 뒤 설정 객체가 바뀐 경우(운영 중 문구 수정 → 승인 무효화)다.
  // 고지 없이 계속하면 위반이 조용히 쌓이고, 드러나는 시점에는 지나간 통화 전부가 대상이다.
  const config = DISC();
  const { core } = build({ disclosure: config });
  config.approved = false;
  await assert.rejects(() => core.start(req()), /AI 고지 거부\(not_approved\)/);
});

test('고지 단계는 무음이 아니고 시나리오 노드도 아니다', b, async () => {
  const { core } = build({ disclosure: DISC() });
  const r = await core.start(req());
  assert.equal(r.steps[0].silent, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(flowBilling.nodes, '__disclosure'), false);
});

// ── 인텐트 진입 배선(§5.1·§5.3) ──────────────────────────────────────────────
// 이 배선이 없으면 "고객의 말을 듣고 시나리오를 고르는 일"이 채널 3곳에 남는다(§2).
// 막는 사고는 대부분 예외가 아니라 조용한 오답이라 검사로 고정하지 않으면 드러나지 않는다.

const INTENT_SLOT = '__intent__';

const flowTriage = {
  id: 'triage', version: 1, startNodeId: 'ask',
  nodes: { ask: { id: 'ask', kind: 'Collect', slot: INTENT_SLOT, prompt: '무엇을 도와드릴까요?' } },
};
const flowBalance = {
  id: 'f_balance', version: 1, startNodeId: 'say',
  nodes: { say: { id: 'say', kind: 'Say', text: '잔액을 안내합니다.' } },
};
const flowReissue = {
  id: 'f_reissue', version: 1, startNodeId: 'say',
  nodes: { say: { id: 'say', kind: 'Say', text: '재발급을 안내합니다.' } },
};
const INTENT_FLOWS = [flowTriage, flowBalance, flowReissue];

function classifierOf(result, opts = {}) {
  const calls = [];
  return {
    calls,
    contractVersion: 1,
    engine: { name: 'fake', residency: 'onprem' },
    plan: () => ({ messages: [], utteranceMasked: '', promptChars: 0 }),
    async classify(r) {
      calls.push(r);
      if (opts.throws) throw new Error('boom');
      const res = typeof result === 'function' ? result(calls.length) : result;
      return {
        status: 'ok', candidates: [], hallucinated: [], reasonKo: '판정',
        engine: { name: 'fake', residency: 'onprem' }, utteranceMasked: '', piiMasked: false,
        ...res,
      };
    },
  };
}

const INTENT_CATALOG = {
  tenantId: 'goone',
  intents: [
    { id: 'balance', titleKo: '잔액조회' },
    { id: 'reissue', titleKo: '카드재발급' },
    { id: 'complaint', titleKo: '불만접수', handoffOnly: true },
  ],
};
const INTENT_POLICY = {
  tenantId: 'goone', acceptThreshold: 0.7, rejectThreshold: 0.3,
  ambiguityMargin: 0.1, maxClarifyOptions: 3, maxClarifyAttempts: 1,
};
const INTENT_TABLE = {
  tenantId: 'goone',
  routes: [{ intent: 'balance', flowId: 'f_balance' }, { intent: 'reissue', flowId: 'f_reissue' }],
};

const intentBinding = (classifier, over = {}) => ({
  catalog: INTENT_CATALOG, policy: INTENT_POLICY, table: INTENT_TABLE,
  classifier, clarifyPrompt: '어떤 업무를 도와드릴까요?', ...over,
});

const triageReq = (over = {}) => req({ flowId: 'triage', ...over });

test('인텐트 미배선: 종전과 완전히 같고(§13-3) 그 사실이 경고로 남는다', b, async () => {
  const { core } = build({ flows: INTENT_FLOWS });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '잔액 알려줘' } });
  // 배선이 없으면 발화가 인텐트가 아니라 **슬롯 값**으로 저장된다 — 바로 그 상태를 경고로 드러낸다.
  assert.equal(after.state.slots[INTENT_SLOT], '잔액 알려줘');
  assert.equal(after.state.flowId, 'triage');
  assert.equal(core.warnings().some((i) => i.code === 'W_INTENT_UNBOUND'), true);
});

test('배선하면 발화가 시나리오를 고르고 그 단계가 채널로 나간다', b, async () => {
  const c = classifierOf({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const { core, port, collector } = build({ flows: INTENT_FLOWS, intent: intentBinding(c) });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '잔액 알려줘' } });
  assert.equal(after.state.flowId, 'f_balance');
  assert.equal(after.state.slots[INTENT_SLOT], 'balance');
  assert.deepEqual(after.steps.map((s) => s.nodeId), ['say']);
  assert.deepEqual(port.log.at(-1), ['present', 'i_test1', ['say']]);
  // 유입은 한 번만 집계되어야 한다 — 시나리오를 갈아탔다고 통화가 하나 더 생기지 않는다.
  assert.equal(collector.events.filter((e) => e.type === 'session.started').length, 1);
  assert.equal(core.warnings().some((i) => i.code === 'W_INTENT_UNBOUND'), false);
});

test('모호하면 되묻고, 다음 턴의 DTMF 는 선택지 번호로 읽는다', b, async () => {
  const c = classifierOf({
    candidates: [{ intent: 'balance', confidence: 0.8 }, { intent: 'reissue', confidence: 0.78 }],
  });
  const { core, port } = build({ flows: INTENT_FLOWS, intent: intentBinding(c) });
  const r = await core.start(triageReq());
  const asked = await core.send(r.interactionId, { input: { kind: 'utterance', text: '그거요' } });
  assert.deepEqual(asked.steps.map((s) => s.nodeId), ['__clarify']);
  assert.equal(asked.state.currentNodeId, 'ask');     // 노드를 옮기지 않았다
  assert.equal(asked.state.failCount, 0);             // 명확화는 실패가 아니다

  const picked = await core.send(r.interactionId, { input: { kind: 'dtmf', digits: '2' } });
  assert.equal(picked.state.flowId, 'f_reissue');
  assert.equal(c.calls.length, 1);                    // 선택지 답변으로 엔진을 다시 부르지 않았다
  assert.deepEqual(port.log.at(-1), ['present', 'i_test1', ['say']]);
});

test('되묻는 중이 아닌 DTMF 는 분류기를 부르지 않는다 — 숫자는 인텐트가 아니다', b, async () => {
  const c = classifierOf({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const { core } = build({ flows: INTENT_FLOWS, intent: intentBinding(c) });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'dtmf', digits: '1' } });
  assert.equal(c.calls.length, 0);
  assert.equal(after.state.failCount, 1);             // §5.1 사다리로 갔다
  assert.equal(after.state.slots[INTENT_SLOT], undefined);
});

test('무입력은 인텐트 경로를 타지 않는다 — 종전 사다리 그대로다', b, async () => {
  const c = classifierOf({ candidates: [] });
  const { core } = build({ flows: INTENT_FLOWS, intent: intentBinding(c) });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'timeout' } });
  assert.equal(c.calls.length, 0);
  assert.equal(after.state.lastFailureReason, 'no_input');
});

test('상담사 전용 인텐트는 시나리오를 타지 않고 이관된다(§2)', b, async () => {
  const c = classifierOf({ candidates: [{ intent: 'complaint', confidence: 0.99 }] });
  const { core, port } = build({ flows: INTENT_FLOWS, intent: intentBinding(c) });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '불만 있어요' } });
  assert.equal(after.status, 'transferred');
  assert.equal(after.state.flowId, 'triage');
  assert.equal(port.log.some((l) => l[0] === 'transfer'), true);
  assert.equal(after.handoff.summaryMasked !== undefined, true);
});

test('설정 누락(라우트 없음)은 이관으로 살리되 원인을 드러낸다', b, async () => {
  const c = classifierOf({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const issues = [];
  const { core } = build({
    flows: INTENT_FLOWS,
    intent: intentBinding(c, {
      table: { tenantId: 'goone', routes: [{ intent: 'reissue', flowId: 'f_reissue' }] },
      onIssue: (i) => issues.push(i),
    }),
  });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '잔액' } });
  assert.equal(after.status, 'transferred');
  assert.equal(after.events.find((e) => e.type === 'handoff.requested').reason, 'error');
  assert.equal(core.warnings().some((i) => i.code === 'W_INTENT_ROUTING'), true);
  assert.deepEqual(issues.map((i) => i.kind), ['unrouted']);
});

test('분류기가 죽어도 통화는 끊기지 않고, 미인식과 갈라서 보고된다(§9.3)', b, async () => {
  const issues = [];
  const c = classifierOf({ status: 'engine_error', reasonKo: '타임아웃' });
  const { core } = build({
    flows: INTENT_FLOWS,
    intent: intentBinding(c, { onIssue: (i) => issues.push(i) }),
    reprompt: { sharedLines: [{ text: '다시 한 번 말씀해 주시겠어요?' }] },
  });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '잔액' } });
  assert.equal(after.status, 'running');
  assert.equal(after.steps[0].text, '다시 한 번 말씀해 주시겠어요?');
  assert.deepEqual(issues.map((i) => i.kind), ['classifier_failed']);
  assert.equal(issues[0].status, 'engine_error');
});

test('분류기가 던져도 통화가 끊기지 않는다', b, async () => {
  const { core } = build({
    flows: INTENT_FLOWS, intent: intentBinding(classifierOf({}, { throws: true })),
  });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '잔액' } });
  assert.equal(after.status, 'running');
  assert.equal(after.state.failCount, 1);
});

test('미인식으로 내려가도 명확화 시도 횟수는 이어받는다', b, async () => {
  // 1턴: 모호 → 되묻기(attempt 1). 2턴: 선택지로 안 읽히는 답 → 다시 분류 → 한도 소진이라 미인식.
  // 3턴: 또 모호해도 되묻지 않는다 — 0 으로 되돌리면 같은 질문을 계속 되묻게 된다.
  const ambiguous = { candidates: [{ intent: 'balance', confidence: 0.8 }, { intent: 'reissue', confidence: 0.78 }] };
  const c = classifierOf(() => ambiguous);
  const { core } = build({ flows: INTENT_FLOWS, intent: intentBinding(c) });
  const r = await core.start(triageReq());
  const t1 = await core.send(r.interactionId, { input: { kind: 'utterance', text: '그거' } });
  assert.deepEqual(t1.steps.map((s) => s.nodeId), ['__clarify']);
  const t2 = await core.send(r.interactionId, { input: { kind: 'utterance', text: '음 그거요' } });
  assert.equal(t2.steps.some((s) => s.nodeId === '__clarify'), false);
  const t3 = await core.send(r.interactionId, { input: { kind: 'utterance', text: '아 그거' } });
  assert.equal(t3.steps.some((s) => s.nodeId === '__clarify'), false);
});

test('과금 근거는 인텐트 턴의 고객 발화에 붙는다(§11.2)', b, async () => {
  const c = classifierOf({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const { core } = build({ flows: INTENT_FLOWS, intent: intentBinding(c) });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, {
    input: { kind: 'utterance', text: '잔액' }, usage: { llm_prompt_tokens: 12 },
  });
  const cust = after.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.equal(cust.usage.llm_prompt_tokens, 12);
  assert.equal(cust.intent, 'balance');
});

test('배선 거부: 분류기·명확화 문구가 없으면 붙지 않는다', b, () => {
  assert.throws(
    () => build({ flows: INTENT_FLOWS, intent: intentBinding(undefined) }),
    /인텐트 배선 거부/,
  );
  assert.throws(
    () => build({ flows: INTENT_FLOWS, intent: intentBinding(classifierOf({}), { clarifyPrompt: '  ' }) }),
    /§13-3/,
  );
});

test('배선 거부: 다른 테넌트의 카탈로그·정책·라우팅 표(§11.1)', b, () => {
  for (const over of [
    { catalog: { ...INTENT_CATALOG, tenantId: 'other' } },
    { policy: { ...INTENT_POLICY, tenantId: 'other' } },
    { table: { ...INTENT_TABLE, tenantId: 'other' } },
  ]) {
    assert.throws(() => build({ flows: INTENT_FLOWS, intent: intentBinding(classifierOf({}), over) }), /§11.1/);
  }
});

test('배선 거부: 없는 시나리오·상담사 전용 인텐트에 걸린 라우트는 통화 전에 막는다', b, () => {
  assert.throws(
    () => build({
      flows: INTENT_FLOWS,
      intent: intentBinding(classifierOf({}), {
        table: { tenantId: 'goone', routes: [{ intent: 'balance', flowId: 'f_nope' }] },
      }),
    }),
    /인텐트 라우팅 거부/,
  );
  assert.throws(
    () => build({
      flows: INTENT_FLOWS,
      intent: intentBinding(classifierOf({}), {
        table: { tenantId: 'goone', routes: [{ intent: 'complaint', flowId: 'f_balance' }] },
      }),
    }),
    /인텐트 라우팅 거부/,
  );
});

test('배선 거부: 라우트가 가리키는 시나리오를 이 채널에서 못 돌리면 통화 전에 막는다(§5.3)', b, () => {
  // 이관 불가 채널에 Transfer 노드를 가진 시나리오가 걸려 있으면, 인텐트가 확정된 **통화 한복판**에서
  // 처음 막힌다 — 그때 고객은 이미 회선에 있다.
  const flowTransfer = {
    id: 'f_transfer', version: 1, startNodeId: 'go',
    nodes: { go: { id: 'go', kind: 'Transfer', queue: 'q1' } },
  };
  assert.throws(
    () => build({
      flows: [...INTENT_FLOWS, flowTransfer],
      port: fakePort('chatbot', { transferToAgent: false, routeToLegacyIvr: false }),
      intent: intentBinding(classifierOf({}), {
        table: { tenantId: 'goone', routes: [{ intent: 'balance', flowId: 'f_transfer' }] },
      }),
    }),
    /인텐트 라우팅 거부/,
  );
});

test('라우트 없는 활성 인텐트는 막지 않되 반드시 드러낸다', b, () => {
  const { core } = build({
    flows: INTENT_FLOWS,
    intent: intentBinding(classifierOf({}), {
      table: { tenantId: 'goone', routes: [{ intent: 'balance', flowId: 'f_balance' }] },
    }),
  });
  const w = core.warnings().filter((i) => i.code === 'W_INTENT_ROUTING');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /reissue/);
});

test('인텐트 진입 노드가 아니면 종전 경로 그대로다(§13-3)', b, async () => {
  const c = classifierOf({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const { core } = build({ flows: [flowBilling, flowBalance, flowReissue], intent: intentBinding(c) });
  const r = await core.start(req());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(c.calls.length, 0);
  assert.equal(after.state.slots['customer_name'], '홍길동');
});

// ── 채널별 배포본 배선(§5.3) ─────────────────────────────────────────────────
//
// 배선이 없으면 버전 선택이 **stage 와 무관하게 가장 높은 번호**로 이루어진다. 아래 첫 검사가
// 그 상태 자체를 고정한다 — 고쳤다는 말이 아니라 **고치기 전에 무슨 일이 일어나는지**를 적어 둔다.

const sayFlow = (id, version, text) => ({
  id, version, startNodeId: 'say', nodes: { say: { id: 'say', kind: 'Say', text } },
});
const billingV1 = sayFlow('billing', 1, '승인된 v1');
const billingV9 = sayFlow('billing', 9, '편집 중 v9');

/** 리비전·배포 레지스트리를 lifecycle 함수로만 만든다(손으로 쓰면 게이트 검사가 느슨해진다). */
function lifecycleRegistry(specs) {
  let reg = LC.emptyRegistry();
  for (const { flow, channels } of specs) {
    const ref = { scope: SCOPE, flowId: flow.id, version: flow.version };
    let r = LC.createDraft(reg, { scope: SCOPE, flow, by: 'author_kim', at: NOW });
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    reg = r.value;
    if (channels === undefined) continue;          // 편집본으로 둔다
    r = LC.submitForReview(reg, ref, 'author_kim', NOW);
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    r = LC.approve(r.value, ref, 'reviewer_lee', NOW);
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    reg = r.value;
    if (channels.length === 0) continue;           // 승인만 하고 배포하지 않는다
    r = LC.publish(reg, { scope: SCOPE, flowId: flow.id, version: flow.version, channels, by: 'ops_park', at: NOW });
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    reg = r.value;
  }
  return reg;
}

/** 배포 레지스트리를 **그때그때 읽는** 런타임 조회. 스냅샷을 붙들면 롤백이 닿지 않는다. */
function deployed(specs) {
  const box = { reg: lifecycleRegistry(specs) };
  return {
    box,
    registry: DF.createDeployedFlowRegistry({ registry: () => box.reg, scope: SCOPE }),
  };
}

test('배선이 없으면 편집본이 번호만 높아도 운영에 나간다 — 바로 그 상태를 경고로 드러낸다', b, async () => {
  const { core, port } = build({ flows: [billingV1, billingV9] });
  const r = await core.start(req());
  // 종전 동작이다(§13-3). 막지 않지만 조용히 두지도 않는다.
  assert.equal(r.steps[0].text, '편집 중 v9');
  assert.equal(r.state.flowVersion, 9);
  assert.equal(port.log[0][2].length, 1);
  const w = core.warnings().filter((i) => i.code === 'W_FLOW_DEPLOYMENT_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /draft/);
});

test('배선하면 배포본이 나가고 편집본은 어떤 경우에도 나가지 않는다', b, async () => {
  const { registry } = deployed([{ flow: billingV1, channels: ['voice'] }, { flow: billingV9 }]);
  const { core } = build({ registry });
  const r = await core.start(req());
  assert.equal(r.steps[0].text, '승인된 v1');
  assert.equal(r.state.flowVersion, 1);
  assert.equal(core.warnings().some((i) => i.code === 'W_FLOW_DEPLOYMENT_UNBOUND'), false);
  // 채널이 편집본을 **지정해도** 시작하지 않는다.
  await assert.rejects(() => core.start(req({ flowVersion: 9 })), /not_approved/);
});

test('미배포 채널은 시작을 막고 사유를 "찾을 수 없습니다"로 뭉개지 않는다', b, async () => {
  const { registry } = deployed([{ flow: billingV1, channels: ['voice'] }]);
  const { core } = build({ registry, port: fakePort('chatbot') });
  await assert.rejects(
    () => core.start(req({ adapter: 'chatbot' })),
    (e) => /not_deployed/.test(e.message) && /배포된 버전이 없습니다/.test(e.message),
  );
});

test('롤백은 신규 통화에 닿고, 진행 중인 통화의 버전은 바꾸지 않는다(§5.3)', b, async () => {
  const { box, registry } = deployed([
    { flow: billingV1, channels: ['voice'] },
    { flow: sayFlow('billing', 2, '승인된 v2'), channels: ['voice'] },
  ]);
  const { core } = build({ registry });
  const first = await core.start(req());
  assert.equal(first.state.flowVersion, 2);

  const rolled = LC.rollback(box.reg, { scope: SCOPE, flowId: 'billing', channel: 'voice', toVersion: 1, by: 'ops_park', at: NOW });
  assert.equal(rolled.ok, true);
  box.reg = rolled.value;

  // 진행 중 세션은 시작 시점의 시나리오를 그대로 들고 간다 — 통화 한복판에 바뀌면 상태가 갈라진다.
  assert.equal(core.sessions.get(first.interactionId).flow.version, 2);
  const next = await core.start(req());
  assert.equal(next.state.flowVersion, 1);
});

test('실행 경로는 forChannel 만 쓴다 — 미배포를 get 으로 되묻지 않는다', b, async () => {
  // get 이 다른 시나리오를 돌려주는 레지스트리. 두 경로를 섞으면 배포 게이트가 무의미해진다.
  const calls = [];
  const registry = {
    get(flowId, version) { calls.push(['get', flowId, version]); return billingV9; },
    forChannel(flowId, channel, version) { calls.push(['forChannel', flowId, channel, version]); return billingV1; },
  };
  const { core } = build({ registry });
  const r = await core.start(req());
  assert.equal(r.steps[0].text, '승인된 v1');
  assert.deepEqual(calls, [['forChannel', 'billing', 'voice', undefined]]);
});

test('사유 조회가 예외로 끝나도 통화가 끊기지 않는다', b, async () => {
  const registry = {
    get: () => undefined,
    forChannel: () => undefined,
    explain() { throw new Error('explain 폭발'); },
  };
  const { core } = build({ registry });
  await assert.rejects(() => core.start(req()), (e) => /시나리오를 찾을 수 없습니다/.test(e.message) && !/폭발/.test(e.message));
});

test('지정본으로 실행하면 배포·롤백이 그 채널에 닿지 않는다는 사실을 드러낸다', b, async () => {
  const { registry } = deployed([
    { flow: billingV1, channels: ['voice'] },
    { flow: sayFlow('billing', 2, '승인된 v2'), channels: [] },   // 승인만, 배포 전
  ]);
  const { core } = build({ registry });
  const r = await core.start(req({ flowVersion: 2 }));
  assert.equal(r.state.flowVersion, 2);
  const w = core.warnings().filter((i) => i.code === 'W_FLOW_NOT_DEPLOYED');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /배포본\(v1\)이 아닌 지정본 v2/);
});

test('인텐트가 고른 시나리오도 배포본 경로로 고른다', b, async () => {
  const balanceV1 = sayFlow('f_balance', 1, '배포된 잔액 안내');
  // v4 는 승인까지만 됐고 배포 전이다 — 채널 없는 조회(get)로는 v4 가 나오므로, 라우팅이
  // 그 경로를 타면 **아직 배포하지 않은 버전**이 통화 한복판에 들어간다.
  const balanceV4 = sayFlow('f_balance', 4, '배포 전 잔액 안내');
  const { registry } = deployed([
    { flow: flowTriage, channels: ['voice'] },
    { flow: balanceV1, channels: ['voice'] },
    { flow: balanceV4, channels: [] },
    { flow: flowReissue, channels: ['voice'] },
  ]);
  const c = classifierOf({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const { core } = build({ registry, intent: intentBinding(c) });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '잔액 알려줘' } });
  assert.equal(after.state.flowId, 'f_balance');
  assert.equal(after.state.flowVersion, 1);
  assert.equal(after.steps[0].text, '배포된 잔액 안내');
});

test('편집본만 있는 라우트는 "없는 시나리오"가 아니라 승인 누락으로 막는다', b, () => {
  const { registry } = deployed([
    { flow: flowTriage, channels: ['voice'] },
    { flow: flowBalance, channels: ['voice'] },
    { flow: flowReissue },                                // 편집본만 있다
  ]);
  assert.throws(
    () => build({ registry, intent: intentBinding(classifierOf({})) }),
    (e) => /인텐트 라우팅 거부/.test(e.message) && /not_approved/.test(e.message) && !/없는 시나리오/.test(e.message),
  );
});

test('라우트가 어떤 채널에 미배포면 등록 시 드러내고, 통화 중엔 이관으로 살린다', b, async () => {
  const { registry } = deployed([
    { flow: flowTriage, channels: ['voice'] },
    { flow: flowBalance, channels: ['voice'] },
    { flow: flowReissue, channels: [] },                 // 승인만, 어느 채널에도 배포 전
  ]);
  const issues = [];
  const c = classifierOf({ candidates: [{ intent: 'reissue', confidence: 0.95 }] });
  const { core, port } = build({ registry, intent: intentBinding(c, { onIssue: (i) => issues.push(i) }) });
  const w = core.warnings().filter((i) => i.code === 'W_FLOW_NOT_DEPLOYED');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /reissue → f_reissue/);
  assert.match(w[0].messageKo, /not_deployed/);

  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '재발급' } });
  assert.equal(after.status, 'transferred');
  assert.deepEqual(issues.map((i) => i.kind), ['unrouted']);
  assert.equal(port.log.some((l) => l[0] === 'transfer'), true);
});

// ── 지식 응대 배선(§5.2) ─────────────────────────────────────────────────────
// 이 배선이 없으면 `knowledge/retrieval.ts`·`knowledge/answer.ts` 는 저장소에 있으나
// **아무도 부르지 않는다** — 고객의 질문은 슬롯 값으로 저장되고 아무도 답하지 않는다.
// 막는 사고는 대부분 예외가 아니라 조용한 오답이라 검사로 고정하지 않으면 드러나지 않는다.

const KNOWLEDGE_SLOT = '__question__';
const RAW_Q = '제 번호 010-1234-5678 수수료가 얼마예요?';
const MASKED_Q = '제 번호 010-****-**** 수수료가 얼마예요?';
const KB_CITATIONS = [{ marker: 1, chunkId: 'c1', docId: 'd1', title: '수수료 안내', sourceUri: 'kb://fee', score: 0.9 }];

const flowFaq = {
  id: 'faq', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: KNOWLEDGE_SLOT, prompt: '무엇이 궁금하신가요?', next: 'bye' },
    bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
  },
};

function retrieverOf(over = {}) {
  const calls = [];
  return {
    calls,
    contractVersion: 1,
    engine: { name: 'fake-embed', residency: 'onprem' },
    knowledgeBaseIds: ['kb_faq'],
    async retrieve(query, policy) {
      calls.push({ query, policy });
      return {
        status: 'grounded',
        grounding: { grounded: true, context: '[1] 수수료는 면제입니다', citations: KB_CITATIONS, droppedForLength: 0 },
        failures: [], partial: false, reasonKo: '근거 1건',
        queryMasked: MASKED_Q, piiMasked: true,
        usage: { embedChars: 20, storeQueries: 1, hits: 1, duplicatesDropped: 0 },
        engine: { name: 'fake-embed', residency: 'onprem' },
        ...over,
      };
    },
  };
}

function answererOf(over = {}) {
  const calls = [];
  return {
    calls,
    contractVersion: 1,
    engine: { name: 'fake-llm', residency: 'onprem' },
    plan: () => ({ messages: [], promptChars: 0 }),
    async answer(r) {
      calls.push(r);
      return {
        status: 'ok', answerKo: '수수료는 면제입니다 [1].',
        citations: KB_CITATIONS, usedMarkers: [1], unusedMarkers: [], invalidMarkers: [],
        reasonKo: '근거 1건 중 1건을 인용한 답변',
        engine: { name: 'fake-llm', residency: 'onprem' },
        piiMaskedInAnswer: false, promptChars: 120, responseChars: 40,
        ...over,
      };
    },
  };
}

const KB_POLICY = { topK: 3, minScore: 0.5, minHits: 1, maxContextChars: 2000 };
const kbBinding = (retriever, answerer, over = {}) => ({ retriever, answerer, policy: KB_POLICY, ...over });
const faqReq = (over = {}) => req({ flowId: 'faq', ...over });

test('지식 미배선: 종전과 완전히 같고(§13-3) 그 사실이 경고로 남는다', b, async () => {
  const { core } = build({ flows: [flowFaq] });
  const r = await core.start(faqReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  // 배선이 없으면 질문이 **슬롯 값**으로 저장되고 아무도 답하지 않는다 — 그 상태를 경고로 드러낸다.
  assert.equal(after.state.slots[KNOWLEDGE_SLOT], RAW_Q);
  assert.deepEqual(after.steps.map((s) => s.nodeId), ['bye']);
  assert.equal(core.warnings().some((i) => i.code === 'W_KNOWLEDGE_UNBOUND'), true);
});

test('배선하면 질문에 답하고 그 단계가 채널로 나간다(§5.2)', b, async () => {
  const rt = retrieverOf();
  const an = answererOf();
  const { core, port } = build({ flows: [flowFaq], knowledge: kbBinding(rt, an) });
  const r = await core.start(faqReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  assert.deepEqual(after.steps.map((s) => s.nodeId), ['__answer', 'bye']);
  assert.equal(after.steps[0].text, '수수료는 면제입니다 [1].');
  assert.deepEqual(after.steps[0].citations, [{ marker: 1, title: '수수료 안내', sourceUri: 'kb://fee' }]);
  assert.deepEqual(port.log.at(-1), ['present', 'i_test1', ['__answer', 'bye']]);
  // 세션에는 **마스킹된 질문만** 남는다(§10.3) — 슬롯은 이관 요약으로 흘러간다.
  assert.equal(after.state.slots[KNOWLEDGE_SLOT], MASKED_Q);
  assert.equal(JSON.stringify(after.state.slots).includes('010-1234-5678'), false);
  assert.equal(core.warnings().some((i) => i.code === 'W_KNOWLEDGE_UNBOUND'), false);
  // 프롬프트로 나간 질문도 마스킹을 지난 값이다.
  assert.equal(an.calls[0].questionMasked, MASKED_Q);
});

test('스토어 장애는 답변기를 부르지 않고 장애로 보고된다 — 통화는 §5.1 사다리로 살린다', b, async () => {
  const reports = [];
  const an = answererOf();
  const rt = retrieverOf({
    status: 'store_failed', grounding: undefined, errorCode: 'E_TIMEOUT',
    failures: [{ knowledgeBaseId: 'kb_faq', code: 'E_TIMEOUT', reasonKo: '시간 초과' }],
    reasonKo: '지식베이스 조회가 모두 실패했다(1곳) — 근거 없음이 아니다',
  });
  const { core } = build({ flows: [flowFaq], knowledge: kbBinding(rt, an, { onResult: (x) => reports.push(x) }) });
  const r = await core.start(faqReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  assert.equal(an.calls.length, 0);
  assert.equal(after.state.failCount, 1);                 // 사다리 한 칸 — 규칙은 Core 한 곳에만 있다
  assert.equal(after.state.lastFailureReason, 'no_match');
  assert.equal(after.state.currentNodeId, 'ask');         // 답하지 못했으니 넘어가지 않는다
  assert.deepEqual(reports.map((x) => [x.answered, x.cause, x.infraFailed]), [[false, 'store_failed', true]]);
});

test('근거 없음은 장애로 보고하지 않는다 — 둘을 같은 값으로 적으면 장애가 묻힌다', b, async () => {
  const reports = [];
  const rt = retrieverOf({
    status: 'not_grounded', grounding: undefined, reasonKo: '근거 신뢰도 미달',
    notGrounded: { grounded: false, reason: 'below_threshold', reasonKo: '미달', filtered: {} },
  });
  const { core } = build({ flows: [flowFaq], knowledge: kbBinding(rt, answererOf(), { onResult: (x) => reports.push(x) }) });
  const r = await core.start(faqReq());
  await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  assert.deepEqual(reports.map((x) => [x.cause, x.infraFailed]), [['not_grounded', false]]);
});

test('성공한 턴도 실측과 함께 보고된다 — 실패만 올리면 비용 근거가 사라진다(§11.2)', b, async () => {
  const reports = [];
  const { core } = build({ flows: [flowFaq], knowledge: kbBinding(retrieverOf(), answererOf(), { onResult: (x) => reports.push(x) }) });
  const r = await core.start(faqReq());
  await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].answered, true);
  assert.equal(reports[0].citations, 1);
  assert.deepEqual(reports[0].usage, { embedChars: 20, storeQueries: 1, hits: 1, promptChars: 120, responseChars: 40 });
  assert.equal(JSON.stringify(reports[0].usage).includes('token'), false);
});

test('숫자·무입력은 지식베이스를 검색하지 않는다 — 비용만 쓰고 언제나 근거가 없다(§11.2)', b, async () => {
  const rt = retrieverOf();
  const { core } = build({ flows: [flowFaq], knowledge: kbBinding(rt, answererOf()) });
  const r = await core.start(faqReq());
  const dtmf = await core.send(r.interactionId, { input: { kind: 'dtmf', digits: '1' } });
  assert.equal(rt.calls.length, 0);
  assert.equal(dtmf.state.failCount, 1);
  const to = await core.send(r.interactionId, { input: { kind: 'timeout' } });
  assert.equal(rt.calls.length, 0);
  assert.equal(to.state.lastFailureReason, 'no_input');
});

test('지식 진입 노드가 아니면 종전 경로 그대로다(§13-3)', b, async () => {
  const rt = retrieverOf();
  const { core } = build({ knowledge: kbBinding(rt, answererOf()) });   // 평범한 Collect 시나리오
  const r = await core.start(req());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(rt.calls.length, 0);
  assert.equal(after.state.slots['customer_name'], '홍길동');
});

test('과금 근거는 지식 턴의 고객 발화에 붙는다(§11.2)', b, async () => {
  const { core } = build({ flows: [flowFaq], knowledge: kbBinding(retrieverOf(), answererOf()) });
  const r = await core.start(faqReq());
  const after = await core.send(r.interactionId, {
    input: { kind: 'utterance', text: RAW_Q }, usage: { llm_prompt_tokens: 7 },
  });
  const withUsage = after.events.filter((e) => e.type === 'turn.completed' && e.usage !== undefined);
  assert.equal(withUsage.length, 1);
  assert.equal(withUsage[0].speaker, 'customer');
});

test('§9.3 이 지식검색을 끈 상태에서는 엔진을 부르지 않는다 — 판정 목록을 실제로 읽는다', b, async () => {
  // `FallbackDecision.disable` 은 지금까지 **저장소 어디에서도 읽지 않는 값**이었다.
  // 그 상태로 지식 응대를 배선하면 판정은 "지식검색을 끈다"인데 호출은 계속되고,
  // 저하된 엔진을 더 밀어붙이면서 **신뢰할 수 없다고 판정된 지식베이스로 답한다**.
  const reports = [];
  const rt = retrieverOf();
  const an = answererOf();
  const { core } = build({
    flows: [flowFaq],
    samples: [{ component: 'rag', state: 'degraded', observedAt: NOW }],
    knowledge: kbBinding(rt, an, { onResult: (x) => reports.push(x) }),
  });
  const r = await core.start(faqReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  assert.equal(rt.calls.length, 0);
  assert.equal(an.calls.length, 0);
  assert.deepEqual(after.fallback.disable, ['knowledge_grounding']);
  assert.equal(after.state.failCount, 1);                  // 통화는 §5.1 사다리로 살린다
  // 조용히 끄지 않는다. 다만 **엔진 상태로 다시 집계하지 않는다**(그 상태 때문에 끈 것이다).
  assert.deepEqual(reports.map((x) => [x.cause, x.infraFailed]), [['disabled_by_fallback', false]]);
  assert.deepEqual(reports[0].usage, { embedChars: 0, storeQueries: 0, hits: 0, promptChars: 0, responseChars: 0 });
});

test('§9.3 이 끄라고 한 기능만 끈다 — LLM 저하는 지식 응대를 끄지 않는다', b, async () => {
  const rt = retrieverOf();
  const { core } = build({
    flows: [flowFaq],
    samples: [{ component: 'llm', state: 'degraded', observedAt: NOW }],
    knowledge: kbBinding(rt, answererOf()),
  });
  const r = await core.start(faqReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  assert.deepEqual(after.fallback.disable, []);
  assert.equal(rt.calls.length, 1);
  assert.deepEqual(after.steps.map((s) => s.nodeId), ['__answer', 'bye']);
});

// ── §11.2 과금 근거 배선 ────────────────────────────────────────────────────
// 여기서 막는 사고는 전부 "청구할 근거가 없다"로 끝난다. 통화는 정상으로 보이고 이벤트도 정상이라
// 어디서도 터지지 않으며, 드러나는 시점은 대사(reconcile)거나 고객사의 청구 이의다.

test('§11.2 종료 시 넘어온 통화 과금 구간이 session.ended 에 실린다', b, async () => {
  const { core, collector } = build();
  await core.start(req());
  const r = await core.end('i_test1', '고객 종료', { billableMs: 65000 });
  assert.equal(r.events[0].billable_ms, 65000);
  assert.deepEqual(r.billing, { billableMsRecorded: true });
  const ended = collector.events.find((e) => e.type === 'session.ended');
  assert.equal(ended.billable_ms, 65000);
});

test('§13-3 통화 구간을 넘기지 않으면 종전과 완전히 같다 — 0 으로 채우지 않는다', b, async () => {
  const { core } = build();
  await core.start(req());
  const r = await core.end('i_test1', '고객 종료');
  assert.equal('billable_ms' in r.events[0], false);
  assert.equal(r.billing, undefined);
});

test('§11.2 무효한 통화 구간은 종료를 막지 않고 싣지 않는다 — 막으면 세션이 샌다', b, async () => {
  for (const bad of [-1, Number.NaN, '65000', null]) {
    const { core, port } = build();
    await core.start(req());
    const r = await core.end('i_test1', '고객 종료', { billableMs: bad });
    assert.equal(r.status, 'completed');                      // 종료는 그대로 진행된다
    assert.equal('billable_ms' in r.events[0], false);
    assert.equal(r.billing.billableMsRecorded, false);
    assert.ok(r.billing.billableMsReasonKo);
    assert.ok(port.log.some((l) => l[0] === 'end'));
  }
});

test('§11.2 이미 종료된 세션에는 뒤늦게 싣지 않고 집계에서 빠진다는 사실을 돌려준다(§8.1)', b, async () => {
  // 장애 폴백이 세션을 먼저 끝낸 통화가 전부 이 경로로 온다 — 그 통화의 통화 분은 근거가 없다.
  const { core, collector } = build({ samples: [{ component: 'telephony', state: 'down', observedAt: NOW }] });
  const started = await core.start(req());
  assert.equal(started.fallback.mode, 'unavailable');
  const before = collector.events.length;
  const r = await core.end('i_test1', '회선 종료', { billableMs: 42000 });
  assert.deepEqual(r.events, []);                             // 추가 전용 이벤트를 고치지 않는다
  assert.equal(collector.events.length, before);
  assert.equal(r.billing.billableMsRecorded, false);
  assert.match(r.billing.billableMsReasonKo, /통화 분 집계에서 빠집니다/);
  assert.equal(collector.events.find((e) => e.type === 'session.ended').billable_ms, undefined);
});

test('§5.2 음성이 아닌 채널로 끝나면 이벤트에는 실리되 집계 제외 사실을 드러낸다', b, async () => {
  const chat = fakePort('chatbot');
  const { core } = build({ port: chat, components: ['messaging', 'llm', 'rag', 'backend'] });
  await core.start(req({ adapter: 'chatbot' }));
  const r = await core.end('i_test1', '대화 종료', { billableMs: 30000 });
  assert.equal(r.events[0].billable_ms, 30000);
  assert.equal(r.billing.billableMsRecorded, true);
  assert.match(r.billing.billableMsReasonKo, /통화 분 집계에서는 제외/);
});

test('§11.2 쓸 수 없는 사용량은 이벤트에 싣지 않고 거부 사실을 돌려준다', b, async () => {
  // 브리지(JSONL) 경로만 검사하고 이 경로는 아무 검사도 없었다 — NaN 하나가 월 집계를 무너뜨린다.
  const { core, collector } = build();
  await core.start(req());
  const r = await core.send('i_test1', {
    input: { kind: 'utterance', text: '홍길동' },
    usage: { llm_prompt_tokens: Number.NaN, gpu_seconds: 3 },
  });
  const turn = collector.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.equal(turn.usage, undefined);
  assert.equal(r.billing.usageAttached, false);
  assert.deepEqual(r.billing.usageRejected, ['channel.llm_prompt_tokens', 'channel.gpu_seconds']);
});

test('§11.2 정상 실측은 그대로 실리고 기록에도 사실대로 남는다', b, async () => {
  const { core } = build();
  await core.start(req());
  const r = await core.send('i_test1', {
    input: { kind: 'utterance', text: '홍길동' },
    usage: { llm_prompt_tokens: 30, stt_audio_ms: 2000 },
  });
  assert.equal(r.billing.usageAttached, true);
  assert.equal('usageRejected' in r.billing, false);
  const turn = r.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.deepEqual(turn.usage, { llm_prompt_tokens: 30, stt_audio_ms: 2000 });
});

test('§9.3 장애 폴백으로 조기 종료된 턴의 실측은 조용히 사라지지 않는다', b, async () => {
  // 그 턴의 STT 는 이미 돌았고 비용은 공급사 청구서에 남는다. 실을 자리가 없다는 사실을 드러낸다.
  const { core, health } = build();
  await core.start(req());
  health.record({ component: 'telephony', state: 'down', observedAt: NOW });
  const r = await core.send('i_test1', {
    input: { kind: 'utterance', text: '홍길동' },
    usage: { stt_audio_ms: 2500 },
  });
  assert.equal(r.fallback.mode, 'unavailable');
  assert.equal(r.events.some((e) => e.type === 'turn.completed'), false);
  assert.equal(r.billing.usageAttached, false);
  assert.match(r.billing.usageReasonKo, /과금 집계에 들어가지 않습니다/);
});

test('§13-3 사용량 선언이 없으면 과금 기록을 만들지 않는다', b, async () => {
  const { core } = build();
  await core.start(req());
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(r.billing, undefined);
});

test('배선 거부: 검색기·답변기 부재와 성립하지 않는 정책은 통화 전에 막는다', b, () => {
  assert.throws(() => build({ flows: [flowFaq], knowledge: { answerer: answererOf(), policy: KB_POLICY } }), /지식 응대 배선 거부/);
  assert.throws(() => build({ flows: [flowFaq], knowledge: { retriever: retrieverOf(), policy: KB_POLICY } }), /지식 응대 배선 거부/);
  assert.throws(
    () => build({
      flows: [flowFaq],
      knowledge: kbBinding(retrieverOf(), answererOf(), { policy: { topK: 2, minScore: 0.5, minHits: 5, maxContextChars: 100 } }),
    }),
    /지식 응대 배선 거부/,
  );
});

// ── 동의 배선 (§10.1·§6.1) ───────────────────────────────────────────────────
//
// 여기서 고정하는 것은 **동의 이력의 진실성**이다. 배선이 없던 동안 시나리오가 동의를 묻고
// 고객이 "네"라고 답해도 그 답은 Confirm 슬롯 값으로만 남았고 동의 기록은 0건이었다 —
// 통화·이벤트·적합성 검사가 모두 정상이라 드러나는 시점은 점검이거나 분쟁이다.
// 반대편에서는 개인정보 파라미터를 선언한 커넥터가 동의 컨텍스트가 없어 **언제나** 막혀 있었다.

const CPOLICY = (over = {}) => ({
  tenantId: 'goone',
  requirements: [
    { purpose: 'personal_data_collection', required: true, noticeRef: 'n1' },
    { purpose: 'marketing', required: false, noticeRef: 'n2' },
  ],
  version: 3, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'legal@goone', approved: true,
  ...over,
});

const PDC = '__consent:personal_data_collection';

/** 동의 → 개인정보 조회 시나리오. 실제 운영에서 가장 흔한 모양이다. */
const flowConsent = ({ onNo = 'bye' } = {}) => ({
  id: 'consent', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요, AI 상담입니다.', next: PDC },
    [PDC]: { id: PDC, kind: 'Confirm', prompt: '개인정보 수집·이용에 동의하십니까?', onYes: 'ask', onNo },
    ask: { id: 'ask', kind: 'Collect', slot: 'account_no', prompt: '주민등록번호를 말씀해 주세요.', next: 'lookup' },
    lookup: { id: 'lookup', kind: 'Api', connectorId: 'c_balance', waitText: '조회 중입니다.', next: 'tell', onError: 'sorry' },
    tell: { id: 'tell', kind: 'Say', text: '조회가 끝났습니다.' },
    sorry: { id: 'sorry', kind: 'Say', text: '지금은 조회가 어렵습니다.' },
    bye: { id: 'bye', kind: 'Say', text: '동의 없이는 진행할 수 없습니다.' },
  },
});

function consentWiring(over = {}) {
  const store = CO.createMemoryConsentStore();
  const recorded = [];
  return {
    store, recorded,
    binding: {
      policy: CPOLICY(),
      records: store,
      subjectRef: () => 'sha256:abc',
      onRecord: (i) => recorded.push(i),
      ...over,
    },
  };
}

/** pii 파라미터를 선언한 커넥터 — `requiresConsent` 가 참이므로 게이트를 지나야 한다. */
const piiWiring = (over) => wiring({
  defs: [CDEF({ params: [{ name: 'rrn', fromSlot: 'account_no', required: true, pii: true }] })],
  ...over,
});

test('§13-3 배선이 없으면 종전과 완전히 같다 — 동의는 슬롯 값으로만 남고 기록은 0건이다', b, async () => {
  const { core } = build({ flows: [flowConsent()] });
  await core.start(req({ flowId: 'consent' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  assert.equal(r.consent, undefined);                         // 결과에 아무것도 실리지 않는다
  assert.equal(r.state.slots[`${PDC}__confirmed`], 'yes');    // 답은 슬롯에만 남는다
  // 그 사실을 조용히 두지는 않는다.
  assert.equal(core.warnings().some((w) => w.code === 'W_CONSENT_UNBOUND'), true);
});

test('배선하면 확정된 "네"가 추가 전용 이력에 기록된다(§10.1)', b, async () => {
  const c = consentWiring();
  const { core } = build({ flows: [flowConsent()], consent: c.binding });
  const s = await core.start(req({ flowId: 'consent' }));
  // 아직 아무것도 묻지 않았으므로 기록은 없고, 필수 미획득 사실만 드러난다.
  assert.equal(s.consent.recorded, undefined);
  assert.deepEqual(s.consent.pendingRequired, ['personal_data_collection']);

  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  assert.deepEqual(r.consent.recorded, {
    purpose: 'personal_data_collection', state: 'granted', policyVersion: 3,
  });
  assert.equal(r.consent.pendingRequired, undefined);
  assert.equal(c.store.list('sha256:abc').length, 1);
  const rec = c.store.list('sha256:abc')[0];
  assert.equal(rec.state, 'granted');
  assert.equal(rec.via, 'voice');
  assert.equal(rec.interactionId, 'i_test1');
  assert.deepEqual(c.recorded, [{
    interactionId: 'i_test1', purpose: 'personal_data_collection', recorded: true, state: 'granted',
  }]);
});

test('같은 동의를 턴마다 다시 쌓지 않는다 — 확정된 슬롯은 세션에 영구히 남는다', b, async () => {
  const c = consentWiring();
  const w = piiWiring();
  const { core } = build({ flows: [flowConsent()], consent: c.binding, connectors: w.binding });
  await core.start(req({ flowId: 'consent' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  assert.equal(c.store.list('sha256:abc').length, 1);
  // 이후 턴들. 슬롯만 보고 기록하면 여기서 건수가 계속 늘어난다(한 통화에 수십 건).
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '900101-1234567' } });
  assert.equal(c.store.list('sha256:abc').length, 1);
  assert.equal(r.consent, undefined);          // 기록도 미획득도 없으면 아무것도 싣지 않는다
  assert.equal(c.recorded.length, 1);
});

test('실패 경로: 되묻는 중에는 기록하지 않는다 — 침묵은 동의가 아니다(§5.1)', b, async () => {
  const c = consentWiring();
  const { core } = build({ flows: [flowConsent()], consent: c.binding });
  await core.start(req({ flowId: 'consent' }));
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(c.store.list('sha256:abc').length, 0);
  assert.equal(r.consent.recorded, undefined);
  assert.equal(r.consent.notRecordedKo, undefined);          // 되묻는 중은 정상이라 사유를 올리지 않는다
  assert.deepEqual(r.consent.pendingRequired, ['personal_data_collection']);
  assert.deepEqual(c.recorded, []);
});

test('경계: 기록된 동의가 개인정보 조회를 **실제로** 통과시킨다(§6.1)', b, async () => {
  const c = consentWiring();
  const w = piiWiring();
  const { core } = build({ flows: [flowConsent()], consent: c.binding, connectors: w.binding });
  await core.start(req({ flowId: 'consent' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '900101-1234567' } });
  assert.equal(w.calls.length, 1);                            // 게이트를 지났다
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['lookup', 'tell']);
  assert.equal(r.state.slots.__last_connector_error__, undefined);
});

test('경계: 거부한 고객의 개인정보 조회는 막히고 onError 로 간다 — 성공으로 넘어가지 않는다', b, async () => {
  const c = consentWiring();
  const w = piiWiring();
  // 거부해도 흐름이 조회로 가는 시나리오(설정은 테넌트 몫이다) — 게이트가 마지막 방어선이다.
  const { core } = build({ flows: [flowConsent({ onNo: 'ask' })], consent: c.binding, connectors: w.binding });
  await core.start(req({ flowId: 'consent' }));
  const no = await core.send('i_test1', { input: { kind: 'utterance', text: '아니요' } });
  assert.equal(no.consent.recorded.state, 'denied');
  assert.deepEqual(no.consent.pendingRequired, ['personal_data_collection']);
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '900101-1234567' } });
  assert.equal(w.calls.length, 0);
  assert.equal(r.state.slots.__last_connector_error__, 'consent_denied');
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['lookup', 'sorry']);
});

test('실패 경로: 주체 참조가 없으면 기록하지 않고 사유를 올린다(§10.3)', b, async () => {
  const c = consentWiring({ subjectRef: () => undefined });
  const { core } = build({ flows: [flowConsent()], consent: c.binding });
  await core.start(req({ flowId: 'consent' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  assert.equal(r.consent.recorded, undefined);
  assert.match(r.consent.notRecordedKo, /주체 참조가 없어/);
  // 주체를 모르는 상태를 "다 받았다"로 적지 않는다.
  assert.deepEqual(r.consent.pendingRequired, ['personal_data_collection']);
  assert.equal(c.recorded[0].recorded, false);
});

test('실패 경로: 주체 조회가 던져도 통화는 끊기지 않는다', b, async () => {
  const c = consentWiring({ subjectRef: () => { throw new Error('auth down'); } });
  const { core } = build({ flows: [flowConsent()], consent: c.binding });
  await core.start(req({ flowId: 'consent' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  assert.equal(r.status, 'running');
  assert.match(r.consent.notRecordedKo, /주체 참조가 없어/);
});

test('실패 경로: 이력 저장이 실패해도 통화는 계속되고 사실이 드러난다', b, async () => {
  const c = consentWiring({
    records: { list: () => [], append() { throw new Error('DB down'); } },
  });
  const { core } = build({ flows: [flowConsent()], consent: c.binding });
  await core.start(req({ flowId: 'consent' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  assert.equal(r.status, 'running');
  assert.equal(r.consent.recorded, undefined);
  assert.match(r.consent.notRecordedKo, /이력 저장이 실패해/);
  assert.equal(c.recorded[0].recorded, false);
});

test('실패 경로: 이력 조회가 던져도 "다 받았다"로 읽지 않는다', b, async () => {
  const c = consentWiring({
    records: { list() { throw new Error('DB down'); }, append() {} },
  });
  const { core } = build({ flows: [flowConsent()], consent: c.binding });
  const s = await core.start(req({ flowId: 'consent' }));
  assert.deepEqual(s.consent.pendingRequired, ['personal_data_collection']);
});

test('증빙 참조는 호스트가 주며 조회가 던져도 기록을 막지 않는다', b, async () => {
  const c = consentWiring({ evidenceRef: ({ purpose }) => `rec:${purpose}` });
  const { core } = build({ flows: [flowConsent()], consent: c.binding });
  await core.start(req({ flowId: 'consent' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  assert.equal(c.store.list('sha256:abc')[0].evidenceRef, 'rec:personal_data_collection');

  const boom = consentWiring({ evidenceRef: () => { throw new Error('vault down'); } });
  const { core: core2 } = build({ flows: [flowConsent()], consent: boom.binding });
  await core2.start(req({ flowId: 'consent' }));
  await core2.send('i_test1', { input: { kind: 'utterance', text: '네' } });
  assert.equal(boom.store.list('sha256:abc').length, 1);
  assert.equal(boom.store.list('sha256:abc')[0].evidenceRef, undefined);
});

test('배선 거부: 미승인·다른 테넌트 정책과 주체·저장소 부재는 통화 전에 막는다', b, () => {
  const base = consentWiring().binding;
  assert.throws(
    () => build({ flows: [flowConsent()], consent: { ...base, policy: CPOLICY({ approved: false }) } }),
    /동의 배선 거부/,
  );
  assert.throws(
    () => build({ flows: [flowConsent()], consent: { ...base, policy: CPOLICY({ tenantId: 'rival' }) } }),
    /동의 배선 거부/,
  );
  assert.throws(
    () => build({ flows: [flowConsent()], consent: { ...base, subjectRef: undefined } }),
    /주체 참조 조회/,
  );
  assert.throws(
    () => build({ flows: [flowConsent()], consent: { ...base, records: {} } }),
    /동의 이력 저장소/,
  );
});

test('배선 거부: 동의 컨텍스트 출처가 둘이면 설정 오류다(§2)', b, () => {
  const w = piiWiring({ consent: () => undefined });
  assert.throws(
    () => build({ flows: [flowConsent()], consent: consentWiring().binding, connectors: w.binding }),
    /같은 판정의 출처가 둘이면/,
  );
});

test('시작 전 거부: 성립하지 않는 동의 노드는 통화를 시작하지 않는다', b, async () => {
  const bad = flowConsent();
  bad.nodes['__consent:모름'] = { id: '__consent:모름', kind: 'Confirm', prompt: '동의?', next: 'bye' };
  const { core } = build({ flows: [bad], consent: consentWiring().binding });
  await assert.rejects(() => core.start(req({ flowId: 'consent' })), /동의 질문 노드가 성립하지 않습니다/);

  const loop = flowConsent();
  loop.nodes[PDC] = { ...loop.nodes[PDC], onNo: PDC };
  const { core: core2 } = build({ flows: [loop], consent: consentWiring().binding });
  await assert.rejects(() => core2.start(req({ flowId: 'consent' })), /self_branch/);
});

test('경고: 필수 목적을 묻는 노드가 시나리오에 없으면 드러낸다(§10.1)', b, async () => {
  const { core } = build({ consent: consentWiring().binding });     // flowBilling — 동의 노드 없음
  await core.start(req());
  const w = core.warnings().find((x) => x.code === 'W_CONSENT');
  assert.ok(w);
  assert.match(w.messageKo, /personal_data_collection/);
});

test('경고: 개인정보 커넥터가 있는데 동의 컨텍스트 출처가 없으면 드러낸다(§6.1)', b, async () => {
  const w = piiWiring();
  const { core } = build({ flows: [flowApiOnError()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  const issue = core.warnings().find((x) => x.code === 'W_CONSENT_UNBOUND');
  assert.ok(issue);
  assert.match(issue.messageKo, /언제나 동의 게이트에서 막힙니다/);
});

test('개인정보를 싣지 않는 커넥터는 경고를 만들지 않는다 — 가짜 경고가 쌓이면 진짜 누락이 묻힌다', b, async () => {
  const w = wiring();                                               // pii 선언 없음·국내
  const { core } = build({ flows: [flowApiOnError()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  assert.equal(core.warnings().some((x) => x.code === 'W_CONSENT_UNBOUND'), false);
});

// ── QA·준수 점검 배선(§7 5.2·§10.1·§10.3·§13-3) ──────────────────────────────
//
// 여기서 고정하는 결함의 증상은 **리포트가 깨끗한 것**이다. 배선이 없던 동안 어떤 세션도
// 점검되지 않았고, 고지 누락·금칙 표현·마스킹 누락이 한 건도 집계되지 않았다 — 그런데
// "점검이 돌고 있다"와 "한 번도 돈 적이 없다"가 운영 화면에서 똑같이 보인다.

const FP = [{ id: 'f1', phrase: '무조건 승인', severity: 'major', reasonKo: '확정적 표현 금지' }];

function qaWiring(over = {}) {
  const reports = [];
  return {
    reports,
    binding: {
      disclosureMarkers: ['AI 상담'],
      forbiddenPhrases: FP,
      onReport: (info) => reports.push(info),
      ...over,
    },
  };
}

/** 봇 발화에 금칙 표현이 섞인 시나리오. 고객 발화가 아니라 **우리가** 말한 것이 문제다. */
const flowForbidden = {
  id: 'fp', version: 1, startNodeId: 'say',
  nodes: { say: { id: 'say', kind: 'Say', text: '고객님은 AI 상담 대상이며 무조건 승인됩니다.' } },
};

test('미배선: 어떤 세션도 점검되지 않는다는 사실을 경고로 드러낸다(§7 5.2)', b, async () => {
  const { core } = build();
  const w = core.warnings().filter((i) => i.code === 'W_QA_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /리포트 자체가 없어/);
  // 종전과 완전히 같다(§13-3) — 결과에 아무것도 실리지 않는다.
  await core.start(req());
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(r.status, 'completed');
  assert.equal(r.compliance, undefined);
  assert.equal(core.sessions.get('i_test1').qa, undefined);
});

test('배선 있음: 세션이 끝나면 점검이 한 번 돌고 요약이 결과에 실린다', b, async () => {
  const qa = qaWiring();
  const { core } = build({ disclosure: DISC(), qa: qa.binding });
  assert.equal(core.warnings().some((i) => i.code === 'W_QA_UNBOUND'), false);
  const started = await core.start(req());
  assert.equal(started.compliance, undefined);          // 아직 끝나지 않았다
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(r.status, 'completed');
  assert.equal(r.compliance.reviewed, true);
  assert.equal(r.compliance.requiresHumanReview, false);
  assert.deepEqual(r.compliance.counts, { critical: 0, major: 0, minor: 0 });
  assert.deepEqual(r.compliance.violated, []);
  assert.equal(qa.reports.length, 1);
  assert.equal(qa.reports[0].interactionId, 'i_test1');
  assert.equal(qa.reports[0].report.findings.length, 0);
});

test('Core 가 낸 고지가 점검에 보인다 — 시나리오 문구에 표식이 없어도 위반이 아니다(§10.1)', b, async () => {
  // 이 검사가 고정하는 것: 고지 발화의 §8.1 턴 이벤트. 그 이벤트가 없으면 고지를 제대로 낸
  // 세션이 전부 disclosure_missing(critical)으로 잡혀 리뷰 큐가 통째로 잠긴다.
  const qa = qaWiring();
  const { core, collector } = build({ flows: [flowRetry], disclosure: DISC(), qa: qa.binding });
  await core.start(req({ flowId: 'retry' }));
  const r = await core.end('i_test1', '고객 종료');
  assert.equal(r.compliance.reviewed, true);
  assert.deepEqual(r.compliance.violated, []);
  assert.equal(r.compliance.checked.includes('disclosure_missing'), true);
  // 원장에도 남는다 — "고지했다"의 근거는 휘발성 반환값이 아니라 §8.1 기록이다.
  const botTurns = collector.events.filter((e) => e.type === 'turn.completed' && e.speaker === 'bot');
  assert.equal(botTurns[0].node_id, '__disclosure');
  assert.equal(botTurns[0].utterance_masked, '본 상담은 AI 상담원이 진행합니다.');
  assert.equal(botTurns[0].occurred_at <= botTurns[1].occurred_at, true);
});

test('봇 발화의 금칙 표현을 잡는다 — 등급 분기는 복사하지 않는다(major 는 사람 리뷰가 아니다)', b, async () => {
  const qa = qaWiring();
  const { core } = build({ flows: [flowForbidden], disclosure: DISC(), qa: qa.binding });
  await core.start(req({ flowId: 'fp' }));
  const r = await core.end('i_test1', '종료');
  assert.deepEqual(r.compliance.violated, ['forbidden_phrase']);
  assert.equal(r.compliance.counts.major, 1);
  assert.equal(r.compliance.requiresHumanReview, false);
  assert.match(qa.reports[0].report.findings[0].messageKo, /확정적 표현 금지/);
});

test('장애 폴백으로 중단된 통화도 점검한다 — end() 에만 걸면 이 통화가 빠진다(§9.3)', b, async () => {
  const qa = qaWiring();
  const { core } = build({ samples: [{ component: 'telephony', state: 'down', observedAt: NOW }], qa: qa.binding });
  const r = await core.start(req());
  assert.equal(r.status, 'failed');
  assert.equal(r.compliance.reviewed, true);
  assert.equal(qa.reports.length, 1);
  // 봇 발화가 없으므로 고지 판정은 합격이 아니라 skipped 다.
  assert.ok(r.compliance.skipped.some((s) => s.ruleId === 'disclosure_missing'));
});

test('폴백 이관으로 끝난 통화도 점검한다(§9.3)', b, async () => {
  const qa = qaWiring();
  const { core } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    policy: { legacyIvrAvailable: true }, qa: qa.binding,
  });
  const r = await core.start(req());
  assert.equal(r.status, 'transferred');
  assert.equal(r.compliance.reviewed, true);
  assert.equal(qa.reports.length, 1);
});

test('한 세션에 한 번만 점검한다 — 두 번 올리면 리뷰 큐에 같은 통화가 두 건 쌓인다', b, async () => {
  const qa = qaWiring();
  const { core } = build({ disclosure: DISC(), qa: qa.binding });
  await core.start(req());
  await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  await core.send('i_test1', { input: { kind: 'utterance', text: '늦게 온 입력' } });
  const again = await core.end('i_test1', '고객 종료');
  assert.equal(qa.reports.length, 1);
  // 이미 끝난 세션의 응답은 직전 판정을 그대로 되돌려준다(새 판정을 만들지 않는다).
  assert.equal(again.compliance.reviewed, true);
});

test('요약에는 근거 이벤트 id·금칙어 문구가 실리지 않는다 — 전문에는 남는다(§10.3)', b, async () => {
  const qa = qaWiring();
  const { core } = build({ flows: [flowForbidden], disclosure: DISC(), qa: qa.binding });
  await core.start(req({ flowId: 'fp' }));
  const r = await core.end('i_test1', '종료');
  const note = JSON.stringify(r.compliance);
  assert.equal(note.includes('무조건 승인'), false);
  assert.equal(note.includes('i_test1_e'), false);
  const full = JSON.stringify(qa.reports[0].report);
  assert.equal(full.includes('무조건 승인'), true);
  assert.equal(full.includes('i_test1_e'), true);
});

test('수집 상한을 넘으면 전수 규칙을 점검 완료로 적지 않는다(§13-3)', b, async () => {
  const qa = qaWiring({ maxEvents: 1 });
  const { core } = build({ disclosure: DISC(), qa: qa.binding });
  await core.start(req());
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(core.sessions.get('i_test1').qa.truncated, true);
  assert.equal(r.compliance.checked.includes('forbidden_phrase'), false);
  assert.ok(r.compliance.skipped.some((s) => s.ruleId === 'pii_exposed' && /상한/.test(s.reasonKo)));
});

test('점검 결과를 받는 훅이 던져도 종료는 그대로 간다 — 그 예외는 세션 누수가 된다', b, async () => {
  const { core, port } = build({
    disclosure: DISC(),
    qa: qaWiring({ onReport: () => { throw new Error('리뷰 큐 장애'); } }).binding,
  });
  await core.start(req());
  const r = await core.end('i_test1', '고객 종료');
  assert.equal(r.status, 'completed');
  assert.equal(r.compliance, undefined);               // 올리지 못한 판정을 결과에 싣지 않는다
  assert.ok(port.log.some((l) => l[0] === 'end'));     // 채널에는 종료 지시가 나갔다
});

test('배선 거부: 비교할 수 없는 금칙어는 생성 시점에 막는다 — 통화 중에는 드러나지 않는다', b, () => {
  assert.throws(
    () => build({ qa: qaWiring({ forbiddenPhrases: [{ id: 'f1', phrase: '  ', severity: 'major', reasonKo: 'x' }] }).binding }),
    /QA 점검 배선 거부/,
  );
  assert.throws(
    () => build({ qa: qaWiring({ maxEvents: 0 }).binding }),
    /QA 점검 배선 거부/,
  );
});

test('경고: 고지 설정이 없으면 고지 점검을 하지 않는다는 사실이 드러난다(§2)', b, async () => {
  const qa = qaWiring();
  const { core } = build({ qa: qa.binding });           // disclosure 미배선
  const w = core.warnings().filter((i) => i.code === 'W_QA');
  assert.ok(w.some((x) => /출처는 AiDisclosureConfig 하나/.test(x.messageKo)));
  await core.start(req());
  const r = await core.end('i_test1', '종료');
  assert.equal(r.compliance.checked.includes('disclosure_missing'), false);
  assert.ok(r.compliance.skipped.some((s) => s.ruleId === 'disclosure_missing'));
});

test('경고: 표식·금칙어 미등록은 막지 않되 그 항목이 합격이 아님을 드러낸다', b, () => {
  const { core } = build({
    disclosure: DISC(),
    qa: qaWiring({ disclosureMarkers: [], forbiddenPhrases: [] }).binding,
  });
  const w = core.warnings().filter((i) => i.code === 'W_QA').map((x) => x.messageKo);
  assert.ok(w.some((m) => /표식이 없어/.test(m)));
  assert.ok(w.some((m) => /skipped/.test(m)));
});

test('호스트가 넘긴 동의 컨텍스트는 덮어쓰지 않는다 — 그 경로는 종전과 같다', b, async () => {
  const seeded = [{
    tenantId: 'goone', subjectRef: 'sha256:host', purpose: 'personal_data_collection',
    state: 'granted', at: '2026-08-01T00:00:00.000Z', via: 'web', policyVersion: 3,
  }];
  const w = piiWiring({
    consent: () => ({ policy: CPOLICY(), records: seeded, subjectRef: 'sha256:host', now: NOW }),
  });
  const { core } = build({ flows: [flowApiOnError()], connectors: w.binding });
  await core.start(req({ flowId: 'api' }));
  const r = await core.send('i_test1', { input: { kind: 'utterance', text: '900101-1234567' } });
  assert.equal(w.calls.length, 1);
  assert.equal(r.consent, undefined);
  assert.equal(
    CN.gateAction(CPOLICY(), seeded, 'call_backend_with_pii', 'sha256:host', NOW, SCOPE).allow,
    true,
  );
});
