import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null, EV = null, DF = null, LC = null, CO = null, CN = null, HT = null;
try {
  HT = await import('../src/adapters/http.ts');
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

function build({ flows = [flowBilling], registry, port = fakePort(), ports, samples = [], policy = {}, components, newId, reprompt, timing, routing, connectors, channelSwitch, disclosure, intent, knowledge, consent, qa, observability, recovery, engines, retention, sessions } = {}) {
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
    newInteractionId: newId ?? (() => 'i_test1'),
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
    ...(observability !== undefined ? { observability } : {}),
    ...(recovery !== undefined ? { recovery } : {}),
    ...(engines !== undefined ? { engines } : {}),
    ...(retention !== undefined ? { retention } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
  });
  return { core, port, collector, health };
}

/**
 * 영속 저장소를 흉내 내는 세션 저장소 — `put` 시점에 **직렬화**하고 `get` 에서 되살린다.
 *
 * 인메모리 기본 구현은 레코드 객체를 그대로 담으므로, 저장 **뒤에** 레코드를 고치는 코드도
 * 조용히 반영된다. 운영 구현(DB·Redis)은 그렇지 않다 — `put` 이 곧 그 시점의 사본이다.
 * 그 차이가 숨기는 결함을 이 저장소가 드러낸다(§6.2: 저장소는 인터페이스 뒤로 교체된다).
 * 함수·시계는 세션 레코드에 담기지 않으므로 JSON 왕복으로 충분하다.
 */
function serializingSessionStore() {
  const map = new Map();
  return {
    get: (id) => { const raw = map.get(id); return raw === undefined ? undefined : JSON.parse(raw); },
    put: (r) => { map.set(r.interactionId, JSON.stringify(r)); },
    remove: (id) => { map.delete(id); },
    ids: () => [...map.keys()],
  };
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

test('헬스 보고는 **접수 범위**를 돌려준다 — 버려진 사실이 호출자에게 닿는다(§9.3·§13-3)', b, async () => {
  const { core } = build({ components: ['telephony'] });

  const ok = core.reportHealth({ adapter: 'callbot', observedAt: NOW, samples: [
    { component: 'telephony', state: 'degraded', observedAt: NOW },
    { component: 'llm', state: 'down', observedAt: NOW },
  ] });
  assert.equal(ok.registered, true);
  assert.equal(ok.offered, 2);
  assert.equal(ok.accepted, 1);
  assert.equal(ok.ignored, 1);
  assert.deepEqual(ok.declared, ['telephony']);

  // 등록되지 않은 채널: **한 건도** 기록되지 않았다는 사실이 수치로 돌아온다.
  const none = core.reportHealth({ adapter: 'chatbot', observedAt: NOW, samples: [
    { component: 'messaging', state: 'down', observedAt: NOW },
  ] });
  assert.equal(none.registered, false);
  assert.equal(none.offered, 1);
  assert.equal(none.accepted, 0);
  assert.deepEqual(none.declared, []);

  // 빈 보고는 "버려졌다"가 아니다 — 0 과 0 을 구분해 적는다.
  const empty = core.reportHealth({ adapter: 'callbot', observedAt: NOW, samples: [] });
  assert.equal(empty.registered, true);
  assert.equal(empty.offered, 0);
  assert.equal(empty.ignored, 0);

  // 선언 목록을 고쳐도 Core 가 가진 선언은 바뀌지 않는다(복사본이다).
  ok.declared.push('llm');
  assert.deepEqual(core.reportHealth({ adapter: 'callbot', observedAt: NOW, samples: [] }).declared, ['telephony']);
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

test('큐 배정 판정은 보관 복사본에도 남는다 — 늦은 입력이 "판정 없는 이관"을 돌려받지 않는다', b, async () => {
  // 큐에 들어간 건은 **요약 저장이 뒤따라서** 종전에도 우연히 남아 있었다(그 put 은 소진 수렴을
  // 위한 것이다) — 그래서 이 검사는 정상 경로의 회귀 고정이고, 결함이 드러나는 쪽은 다음 검사다.
  const { core } = build({ flows: [flowHandoff], routing: ROUTING(), sessions: serializingSessionStore() });
  await core.start(req({ flowId: 'care' }));
  const turn = await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  assert.equal(turn.handoff.placement.placement, 'queued');
  const late = await core.send('i_test1', { input: { kind: 'utterance', text: '여보세요?' } });
  assert.equal(late.events.length, 0, '늦은 입력은 새 이벤트를 만들지 않는다');
  assert.ok(late.handoff, '이관은 서 있는 사실이라 되풀이된다');
  assert.equal(late.handoff.placement?.placement, 'queued',
    '판정이 보관 복사본에 남지 않으면 호스트는 큐 배정을 "모름"으로 읽는다');
  assert.equal(late.handoff.placement.queueId, 'q_care');
});

test('대안으로 간 판정도 보관 복사본에 남는다 — 늦은 입력에도 상담사 연결을 안내하지 않는다', b, async () => {
  // 큐에 들어가지 못한 건은 요약을 남기는 그 put 보다 **먼저** 돌아간다(transfer 를 부르지
  // 않으므로) — 즉 판정이 보관 복사본에 적히는 경로가 없었다. 영속 저장소에서 그 세션의 늦은
  // 입력은 `placement` 없는 이관을 받고, 호스트는 판정 없음을 "라우팅 미배선(모름)"으로
  // 읽어야 한다(§13-3) — 큐 id 를 들고 있지 않아 `queue` 도 비어 있으므로, 그 응답은
  // "큐를 선언하지 않은 이관"과 같은 모양이 되어 **상담사 연결 안내**로 되돌아간다.
  const routing = ROUTING({ snapshots: () => [] });   // 상태 미확인 → 보수적으로 닫힘
  const { core } = build({ flows: [flowHandoff], routing, sessions: serializingSessionStore() });
  await core.start(req({ flowId: 'care' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '901010-1234567 입니다' } });
  const late = await core.send('i_test1', { input: { kind: 'utterance', text: '여보세요?' } });
  assert.equal(late.handoff.placement?.placement, 'alternative');
  assert.equal(late.handoff.placement.action, 'callback');
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

test('수용 판정의 운영값도 등록 시점에 거부된다 — 통화 중에는 되돌릴 수 없다', b, () => {
  // 큐 선언은 멀쩡하므로 `validateRoutingConfig` 는 통과한다. 이 두 값만 어디서도 안 걸렸고,
  // 틀린 채 돌면 "모든 이관이 콜백"(0·음수) 또는 "낡은 스냅샷이 영원히 신선"(NaN)이 된다.
  for (const admission of [{ staleAfterMs: 0 }, { staleAfterMs: Number.NaN }, { admitWithNoAgents: 'false' }]) {
    assert.throws(
      () => build({ flows: [flowHandoff], routing: ROUTING({ admission }) }),
      /라우팅 배선 거부/,
      `통과했다: ${JSON.stringify(admission)}`,
    );
  }
  // 주지 않거나 올바르면 종전과 완전히 같다.
  assert.doesNotThrow(() => build({ flows: [flowHandoff], routing: ROUTING() }));
  assert.doesNotThrow(() => build({ flows: [flowHandoff], routing: ROUTING({ admission: { staleAfterMs: 60_000 } }) }));
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

// ── 상담사 배정 오퍼 배선(§2·§9.3·§10.3·§11.1·§13-3) ────────────────────────
// 여기서 고정하는 것은 "오퍼가 동작한다"(그건 routing.executeOffer 테스트가 본다)가 아니라
// **큐에 놓는 것과 제안하는 것 사이가 실제로 꿰여 있다**는 사실이다. 그 사이가 비어 있는 동안
// 증상은 예외가 아니라 큐에 묶인 고객이고, 운영 화면에서 "대기 중"과 구분되지 않는다.
const OFFERS = (over = {}) => {
  const steps = [];
  let n = 0;
  return {
    steps,
    policy: { timeoutMs: 20000, maxAttempts: 3, ...(over.policy ?? {}) },
    // `in` 으로 본다 — `?? 기본값` 으로 쓰면 "조회기를 주지 않았다"를 검사할 수 없다.
    candidates: 'candidates' in over ? over.candidates : (() => ['a_kim', 'a_lee']),
    newOfferId: 'newOfferId' in over ? over.newOfferId : (() => { n += 1; return `o_${n}`; }),
    onStep: 'onStep' in over ? over.onStep : ((s) => { steps.push(s); }),
    ...(over.ledger !== undefined ? { ledger: over.ledger } : {}),
  };
};
/** 이관까지 한 통화를 돌린다. 기본 상호작용 id 는 `i_test1` 이다. */
const toAgent = async (core, iid = 'i_test1', text = '901010-1234567 입니다') => {
  await core.start(req({ flowId: 'care' }));
  return core.send(iid, { input: { kind: 'utterance', text } });
};

test('이관이 가능한 채널인데 큐 배정 배선이 없으면 드러낸다(W_ROUTING_UNBOUND)', b, () => {
  const { core } = build({ flows: [flowHandoff] });
  const w = core.warnings().find((x) => x.code === 'W_ROUTING_UNBOUND');
  assert.ok(w, '큐 선택·수용 판정이 한 번도 돌지 않는 상태는 조용해서는 안 된다');
  assert.match(w.messageKo, /대안/);
  // 이관을 못 하는 채널에는 적지 않는다 — 해당 없는 경고는 진짜 신호를 묻는다.
  const other = build({ flows: [flowRetry], port: fakePort('callbot', { transferToAgent: false }) });
  assert.equal(other.core.warnings().some((x) => x.code === 'W_ROUTING_UNBOUND'), false);
});

test('큐 배정만 배선하면 아무도 제안받지 않는다는 사실이 남는다(W_AGENT_OFFER_UNBOUND)', b, async () => {
  const { core, port } = build({ flows: [flowHandoff], routing: ROUTING() });
  assert.ok(core.warnings().some((x) => x.code === 'W_AGENT_OFFER_UNBOUND'));
  assert.equal(core.warnings().some((x) => x.code === 'W_ROUTING_UNBOUND'), false, '둘을 같이 적으면 안 된다');
  // 종전과 완전히 같다(§13-3): 전달은 그대로 되고 원장은 **만들어지지도 않는다**.
  await toAgent(core);
  assert.equal(port.log.some((l) => l[0] === 'transfer'), true);
  assert.equal(core.agentOffers(), undefined, '빈 원장은 "오퍼가 0건"으로 읽힌다');
});

test('이관 직후 같은 호출에서 첫 오퍼가 열린다(§2)', b, async () => {
  const offers = OFFERS();
  const { core, port } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  const r = await toAgent(core);
  assert.equal(r.handoff.placement.placement, 'queued');
  const ledger = core.agentOffers();
  assert.equal(ledger.offers.length, 1);
  assert.equal(ledger.offers[0].state, 'offered');
  assert.equal(ledger.offers[0].agentId, 'a_kim', '선언한 순서를 바꾸지 않는다');
  assert.equal(ledger.offers[0].attempt, 1);
  assert.equal(ledger.offers[0].queueId, 'q_care');
  assert.equal(offers.steps.length, 1);
  assert.equal(offers.steps[0].via, 'handoff');
  assert.equal(offers.steps[0].code, 'offered');
  assert.equal(offers.steps[0].interactionId, 'i_test1');
  // 오퍼가 열려도 이관 자체는 종전 그대로다.
  assert.equal(port.log.find((l) => l[0] === 'transfer')[2], 'q_care');
});

test('오버플로 수용 큐로 오퍼를 연다 — 요청 큐로 열면 아무도 안 보는 큐에 제안된다', b, async () => {
  const offers = OFFERS();
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({
    offers,
    snapshots: () => [
      { queueId: 'q_care', waiting: 1, availableAgents: 2, observedAt: NOW },
      { queueId: 'q_backup', waiting: 0, availableAgents: 1, observedAt: NOW },
    ],
  }) });
  await toAgent(core);
  assert.equal(core.agentOffers().offers[0].queueId, 'q_backup');
});

test('큐에 놓지 못했으면 오퍼를 열지 않는다(§9.3)', b, async () => {
  const offers = OFFERS();
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers, snapshots: () => [] }) });
  const r = await toAgent(core);
  assert.equal(r.handoff.placement.placement, 'alternative');
  assert.equal(core.agentOffers().offers.length, 0, '대안으로 간 고객에게 상담사를 배정하면 안 된다');
});

test('전달이 실패하면 오퍼가 열리지 않는다 — 고객 없는 통화에 상담사를 넣지 않는다', b, async () => {
  const offers = OFFERS();
  const port = fakePort('callbot', {}, { async transfer() { throw new Error('회선 전달 실패'); } });
  const { core } = build({ flows: [flowHandoff], port, routing: ROUTING({ offers }) });
  await assert.rejects(() => toAgent(core), /회선 전달 실패/);
  assert.equal(core.agentOffers().offers.length, 0);
});

test('오퍼 정책·조회기 결함은 통화 중이 아니라 생성 시점에 거부된다(§13-3)', b, () => {
  assert.throws(() => build({ flows: [flowHandoff], routing: ROUTING({
    offers: OFFERS({ policy: { timeoutMs: 0 } }),
  }) }), /배정 오퍼 정책 거부/);
  assert.throws(() => build({ flows: [flowHandoff], routing: ROUTING({
    offers: OFFERS({ policy: { maxAttempts: 0 } }),
  }) }), /배정 오퍼 정책 거부/);
  assert.throws(() => build({ flows: [flowHandoff], routing: ROUTING({
    offers: OFFERS({ candidates: undefined }),
  }) }), /후보 상담사 조회가 없다/);
  assert.throws(() => build({ flows: [flowHandoff], routing: ROUTING({
    offers: OFFERS({ newOfferId: null }),
  }) }), /오퍼 id 생성기가 없다/);
});

test('후보 조회가 예외로 끝나도 이관은 끝나고 사실이 남는다', b, async () => {
  const offers = OFFERS({ candidates: () => { throw new Error('근태 API 장애'); } });
  const { core, port } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  const r = await toAgent(core);
  assert.equal(r.status, 'transferred');
  assert.equal(port.log.some((l) => l[0] === 'transfer'), true);
  assert.equal(core.agentOffers().offers.length, 0);
  const w = core.warnings().find((x) => x.code === 'W_AGENT_OFFER');
  assert.ok(w);
  assert.equal(w.messageKo.includes('근태 API 장애'), false, '호스트 예외 원문을 경고에 싣지 않는다(§10.3)');
});

test('제안할 상담사가 없으면 큐에 그대로 두고 소진으로 적지 않는다(§9.3)', b, async () => {
  const offers = OFFERS({ candidates: () => [] });
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  assert.equal(core.agentOffers().offers.length, 0);
  assert.equal(offers.steps[0].code, 'waiting');
  assert.ok(core.warnings().some((x) => x.code === 'W_AGENT_OFFER' && /소진이 아닙니다/.test(x.messageKo)));
});

test('개인정보 형태의 상담사 id 는 원장에 들어가지 않는다(§10.3)', b, async () => {
  const offers = OFFERS({ candidates: () => ['010-3333-4444'] });
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  assert.equal(core.agentOffers().offers.length, 0);
  assert.equal(offers.steps[0].code, 'refused');
  assert.equal(JSON.stringify(offers.steps[0].issues).includes('010-3333-4444'), false,
    '차단한 값을 결과에 담으면 차단이 무의미해진다');
});

test('거절은 같은 호출에서 다음 후보로 이어진다 — 호스트가 기억하지 않는다', b, async () => {
  const offers = OFFERS();
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  const step = await core.settleAgentOffer({ offerId: 'o_1', event: 'decline' });
  assert.equal(step.code, 'offered');
  assert.equal(step.via, 'settle');
  assert.equal(step.offer.agentId, 'a_lee', '거절한 상담사에게 다시 제안하지 않는다');
  assert.equal(step.offer.attempt, 2);
  const ledger = core.agentOffers();
  assert.equal(ledger.offers.length, 2);
  assert.equal(ledger.offers.find((o) => o.offerId === 'o_1').state, 'declined');
});

test('수락은 후보를 다시 묻지 않는다 — 명부 조회 실패가 수락을 막으면 안 된다', b, async () => {
  let asked = 0;
  const offers = OFFERS({ candidates: () => { asked += 1; return asked > 1 ? (() => { throw new Error('장애'); })() : ['a_kim']; } });
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  const step = await core.settleAgentOffer({ offerId: 'o_1', event: 'accept' });
  assert.equal(step.code, 'assigned');
  assert.equal(asked, 1);
  assert.equal(core.agentOffers().offers[0].state, 'accepted');
});

test('재배정 한도를 다 쓰면 §9.3 대안으로 수렴하고 이관 요약이 함께 간다(§2)', b, async () => {
  const offers = OFFERS({ policy: { timeoutMs: 20000, maxAttempts: 1 } });
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  const r = await toAgent(core);
  const step = await core.settleAgentOffer({ offerId: 'o_1', event: 'decline' });
  assert.equal(step.code, 'alternative');
  assert.equal(step.placement.action, 'callback');
  assert.equal(step.placement.summaryMasked, r.handoff.summaryMasked, '가장 오래 기다린 고객만 요약이 비면 안 된다');
  assert.equal(step.placement.summaryMasked.includes('901010-1234567'), false, '§10.3');
});

test('종결된 오퍼의 중복 이벤트는 "응답 대기"가 아니라 거절이다', b, async () => {
  const offers = OFFERS();
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  await core.settleAgentOffer({ offerId: 'o_1', event: 'accept' });
  const again = await core.settleAgentOffer({ offerId: 'o_1', event: 'accept' });
  assert.equal(again.code, 'refused');
  const unknown = await core.settleAgentOffer({ offerId: 'o_없음', event: 'decline' });
  assert.equal(unknown.code, 'refused');
  assert.equal(core.agentOffers().offers.length, 1, '거절은 원장을 바꾸지 않는다');
});

test('만료는 부를 때 수렴한다 — 목록만 돌려주지 않는다', b, async () => {
  const offers = OFFERS();
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  const quiet = await core.runOfferExpiry(NOW);
  assert.equal(quiet.expired, 0, '한도 전에는 만료가 아니다');
  const later = '2026-09-01T09:00:21.000Z';
  const rep = await core.runOfferExpiry(later);
  assert.equal(rep.expired, 1);
  assert.deepEqual(rep.issues, []);
  assert.equal(rep.steps[0].code, 'offered', '무응답도 다음 후보로 이어져야 한다');
  assert.equal(rep.steps[0].via, 'expiry');
  assert.equal(core.agentOffers().offers.find((o) => o.offerId === 'o_1').state, 'timed_out');
});

test('만료 판정이 돌지 않은 것을 "만료 0건"으로 적지 않는다(§13-3)', b, async () => {
  const offers = OFFERS();
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  const rep = await core.runOfferExpiry('2026-09-01 09:00:30');   // 시간대 없음
  assert.equal(rep.expired, 0);
  assert.equal(rep.issues.length, 1);
  assert.equal(core.agentOffers().offers[0].state, 'offered', '판정이 돌지 않았으면 원장도 그대로다');
});

test('만료가 여러 건이면 앞 건의 재배정이 뒤 건에 덮이지 않는다', b, async () => {
  // 한 테넌트의 동시 통화 둘을 **같은 원장**에 올린다(운영에서는 같은 프로세스가 둘을 본다).
  const ledgerShared = R.createMemoryOfferLedger();
  const offers = OFFERS({ candidates: () => ['a_kim', 'a_lee', 'a_park'], ledger: ledgerShared });
  const first = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(first.core);
  const second = build({ flows: [flowHandoff], newId: () => 'i_test2', routing: ROUTING({ offers }) });
  await toAgent(second.core, 'i_test2', '010-1111-2222');
  assert.equal(ledgerShared.get().offers.length, 2);
  const later = '2026-09-01T09:00:21.000Z';
  const rep = await first.core.runOfferExpiry(later);
  assert.equal(rep.expired, 2);
  // 두 건 모두 전이가 반영돼 있어야 한다 — 하나라도 덮이면 그 고객은 영구히 `offered` 로 남는다.
  const timedOut = ledgerShared.get().offers.filter((o) => o.state === 'timed_out');
  assert.equal(timedOut.length, 2);
});

test('다른 상호작용의 오퍼가 열린 상담사는 후보에서 제외되고 그 사실이 드러난다', b, async () => {
  const ledgerShared = R.createMemoryOfferLedger();
  const only = OFFERS({ candidates: () => ['a_kim'], ledger: ledgerShared });
  const first = build({ flows: [flowHandoff], routing: ROUTING({ offers: only }) });
  await toAgent(first.core);
  const second = build({ flows: [flowHandoff], newId: () => 'i_test2', routing: ROUTING({ offers: only }) });
  await toAgent(second.core, 'i_test2', '010-1111-2222');
  const last = only.steps[only.steps.length - 1];
  assert.equal(last.code, 'waiting');
  assert.equal(last.skipped.length, 1);
  assert.match(last.skipped[0], /다른 상호작용/);
  assert.equal(ledgerShared.get().offers.length, 1, '같은 상담사에게 두 콜을 동시에 열지 않는다');
});

test('큐에서 기다리다 끊은 고객의 오퍼는 취소된다 — 상담사가 영구히 사라지지 않는다', b, async () => {
  const ledgerShared = R.createMemoryOfferLedger();
  const only = OFFERS({ candidates: () => ['a_kim'], ledger: ledgerShared });
  const first = build({ flows: [flowHandoff], routing: ROUTING({ offers: only }) });
  await toAgent(first.core);
  // 이관된 세션은 그 턴에서 이미 종료 상태다 — 그 분기에서 취소하지 않으면 영구히 열려 있다.
  await first.core.end('i_test1', '고객 종료');
  assert.equal(ledgerShared.get().offers[0].state, 'cancelled');
  assert.equal(only.steps[only.steps.length - 1].via, 'session_end');
  // 그 상담사는 다시 후보가 된다.
  const second = build({ flows: [flowHandoff], newId: () => 'i_test2', routing: ROUTING({ offers: only }) });
  await toAgent(second.core, 'i_test2', '010-1111-2222');
  assert.equal(ledgerShared.get().offers.length, 2);
  assert.equal(ledgerShared.get().offers[1].state, 'offered');
});

test('상담사가 수락한 오퍼는 종료에서 취소되지 않는다', b, async () => {
  const offers = OFFERS();
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  await core.settleAgentOffer({ offerId: 'o_1', event: 'accept' });
  await core.end('i_test1', '상담사 연결 후 종료');
  assert.equal(core.agentOffers().offers[0].state, 'accepted');
});

test('전이 보고가 던져도 통화·만료 수렴은 멈추지 않는다(§6.2)', b, async () => {
  const offers = OFFERS({ onStep: () => { throw new Error('데스크톱 알림 실패'); } });
  const { core, port } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  const r = await toAgent(core);
  assert.equal(r.status, 'transferred');
  assert.equal(port.log.some((l) => l[0] === 'transfer'), true);
  assert.equal(core.agentOffers().offers.length, 1, '보고 실패가 원장 반영을 되돌리면 안 된다');
  assert.ok(core.warnings().some((x) => x.code === 'W_AGENT_OFFER' && /onStep/.test(x.messageKo)));
});

test('남의 테넌트 오퍼가 섞인 원장은 조용히 걸러지지 않는다(§11.1)', b, async () => {
  const ledger = {
    offers: [{
      offerId: 'o_x', queueId: 'q_care', interactionId: 'i_x', tenantId: 'other',
      agentId: 'a_x', state: 'offered', offeredAt: NOW, timeoutMs: 1000, attempt: 1,
    }],
  };
  const store = { get: () => ledger, put: () => {} };
  const offers = OFFERS({ ledger: store });
  const { core } = build({ flows: [flowHandoff], routing: ROUTING({ offers }) });
  await toAgent(core);
  assert.equal(offers.steps[0].code, 'refused');
  assert.ok(offers.steps[0].issues.some((i) => /§11.1/.test(i)));
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
  // 종전 동작이지만 조용히 두지 않는다 — 무음은 적합성 검사·이벤트·헬스를 모두 통과한다.
  const w = core.warnings().filter((x) => x.code === 'W_CONNECTOR_UNBOUND');
  assert.equal(w.length, 1, '턴마다 쌓이면 진짜 신호가 묻힌다');
  assert.match(w[0].messageKo, /무음/);
});

test('Api 노드가 없는 시나리오에는 커넥터 미배선 경고를 적지 않는다', b, async () => {
  const { core } = build();
  await core.start(req());
  await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(core.warnings().some((x) => x.code === 'W_CONNECTOR_UNBOUND'), false,
    '해당 없는 경고는 진짜 신호를 묻는다');
});

test('커넥터를 배선하면 미배선 경고가 남지 않는다', b, async () => {
  const { core } = build({ flows: [flowApiOk()], connectors: wiring().binding });
  await core.start(req({ flowId: 'api' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(core.warnings().some((x) => x.code === 'W_CONNECTOR_UNBOUND'), false);
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

// 전환 사실이 **턴 결과에도** 실리는지. 종전에는 `port.invite` 한 곳에만 있었고,
// 그 경로는 Node 호스트에만 있다 — 비-Node 호스트에서는 전환이 조용히 반쪽만 일어났다.

test('전환 초대 사실이 턴 결과에 실린다 — 토큰·만료까지(§5.2)', b, async () => {
  const sw = switchWiring();
  const port = fakePort();
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });

  assert.equal(r.switchInvite.fromChannel, 'voice');
  assert.equal(r.switchInvite.toChannel, 'visual');
  assert.equal(r.switchInvite.ticketIssued, true);
  assert.equal(r.switchInvite.token, 'tk_switch_1');
  const inv = port.log.find((l) => l[0] === 'invite');
  assert.equal(r.switchInvite.expiresAt, inv[3].expiresAt, '포트와 결과가 같은 티켓을 본다(§2)');
  // 슬롯 값은 어느 쪽에도 실리지 않는다(§10.3).
  assert.equal(JSON.stringify(r.switchInvite).includes('customer_name'), false);

  // 전환이 없는 턴에는 실리지 않는다 — 매 턴 반복되면 호스트가 링크를 다시 보낸다.
  const again = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(again.switchInvite, undefined);
});

test('보관되는 세션 복사본에는 토큰이 남지 않는다 — 1회용 열쇠가 다음 응답에 다시 실리면 안 된다(§10.3)', b, async () => {
  const sw = switchWiring();
  const { core } = build({ flows: [flowRetry], ports: [fakePort(), darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  await core.send('i_test1', { input: { kind: 'timeout' } });

  const stored = core.sessions.get('i_test1').lastResult;
  assert.equal(stored.switchInvite.ticketIssued, true, '사실은 남는다');
  assert.equal(stored.switchInvite.token, undefined, '열쇠는 남지 않는다');
  assert.equal(JSON.stringify(stored).includes('tk_switch_1'), false);
});

test('발급이 막힌 전환은 결과에 사유가 적힌다 — 링크를 보낼 수 없다는 사실이 호스트에 닿는다', b, async () => {
  const sw = switchWiring({ newToken: () => 'tk_i_test1' });   // id 와 얽힌 토큰 → 발급 거절
  const port = fakePort();
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });

  assert.equal(r.switchInvite.ticketIssued, false);
  assert.equal(r.switchInvite.token, undefined);
  assert.match(r.switchInvite.notIssuedKo, /E_TOKEN_WEAK/);
  assert.equal(port.log.some((l) => l[0] === 'invite'), false, '매체 전달은 종전과 같이 하지 않는다');
});

// 초대 **지시가 거부된** 경우(발송 경로 장애). 종전에는 그 거부가 호출자까지 올라가 턴을
// 통째로 끝냈다 — 세션은 이미 화면 채널로 바뀌고 이벤트도 발행됐는데 그 턴의 단계·이관·종료
// 지시는 **아무것도 나가지 않았다**(전달이 `present` 보다 앞이다). 포트 메서드의 반환은
// "지시를 접수했다"까지만 뜻하므로 거부는 접수되지 않았다는 뜻이고, Core 는 사실을 적고
// 턴의 나머지를 그대로 내보낸다(§5.2·§9.3).

test('초대 지시가 거부돼도 턴의 나머지는 나간다 — 예외로 끝내지 않는다(§5.2)', b, async () => {
  const sw = switchWiring();
  const port = fakePort('callbot', {}, {
    async invite() { throw new Error('알림톡 발송 거부'); },
  });
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const before = port.log.filter((l) => l[0] === 'present').length;
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });

  // 발급은 됐다 — 막힌 것은 발송이다(고칠 곳이 다르므로 사유를 따로 적는다).
  assert.equal(r.switchInvite.ticketIssued, true);
  assert.match(r.switchInvite.notDeliveredKo, /링크가 나가지 않았습니다/);
  assert.match(r.switchInvite.notDeliveredKo, /알림톡 발송 거부/);
  assert.equal(r.switchInvite.notIssuedKo, undefined, '발급 사유와 발송 사유를 같게 적지 않는다');
  // 그 턴의 안내는 그대로 나간다 — 종전에는 이 호출이 통째로 예외였다.
  assert.ok(port.log.filter((l) => l[0] === 'present').length > before, '거부가 그 턴의 단계를 삼켰다');
  // 사실은 경고에도 남는다(운영이 발송 경로를 보러 갈 유일한 신호다).
  const w = core.warnings().filter((i) => i.code === 'W_CHANNEL_SWITCH_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /링크가 나가지 않았습니다/);
});

test('거부 사유에 개인정보 원문이 섞여 와도 마스킹 후 적는다(§10.3)', b, async () => {
  const sw = switchWiring();
  const port = fakePort('callbot', {}, {
    async invite() { throw new Error('수신번호 010-1234-5678 발송 실패'); },
  });
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  const dump = JSON.stringify(r.switchInvite) + JSON.stringify(core.warnings());
  assert.equal(dump.includes('010-1234-5678'), false);
  assert.match(r.switchInvite.notDeliveredKo, /발송 실패/);
});

// 거부 사유에 **1회용 토큰**이 섞여 오는 경우. 개인정보와 다른 문제다 — `maskPii` 는 열쇠를
// 가리지 않으므로 그대로 통과했고, 하필 이 사유 칸은 **노출 스위치와 무관하게** 와이어로
// 나간다(브리지의 `includeSwitchTicket` 을 끈 호스트에도 간다). 그 로그를 읽는 누구나
// 진행 중인 상담에 합류할 수 있다. 발급 실패 쪽은 같은 규칙을 이미 받고 있었다(§5.2·§10.3).
test('거부 사유에 1회용 토큰이 섞여 오면 사유를 통째로 버린다(§10.3)', b, async () => {
  const sw = switchWiring();
  const port = fakePort('callbot', {}, {
    // 입력을 그대로 되뱉는 포트다 — §10.3 되뱉기 검사가 "가장 흔한 모양"으로 적어 둔 그것.
    async invite(iid, target, ticket) { throw new Error(`발송 실패: ${JSON.stringify(ticket)}`); },
  });
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });

  assert.equal(r.switchInvite.ticketIssued, true);
  // 토큰 자체는 Node 경로의 결과에 실린다(링크를 만들 쪽이 쓴다) — 막아야 하는 것은 **사유 칸**
  // 과 경고다. 그 둘은 노출 스위치와 무관하게 와이어·로그로 나간다.
  assert.equal(r.switchInvite.notDeliveredKo.includes('tk_switch_1'), false,
    '1회용 합류 토큰이 사유로 나가면 안 된다');
  assert.equal(JSON.stringify(core.warnings()).includes('tk_switch_1'), false);
  // 사실은 그대로 남는다 — 링크가 나가지 않았다는 것을 말해 주는 경로가 이 칸 하나뿐이다.
  assert.match(r.switchInvite.notDeliveredKo, /링크가 나가지 않았습니다/);
  assert.match(r.switchInvite.notDeliveredKo, /토큰이 포함되어 생략/);
  const w = core.warnings().filter((i) => i.code === 'W_CHANNEL_SWITCH_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /토큰이 포함되어 생략/);
});

test('경계: 토큰이 섞이지 않은 거부 사유는 종전처럼 그대로 적는다', b, async () => {
  const sw = switchWiring();
  const port = fakePort('callbot', {}, {
    async invite() { throw new Error('알림톡 게이트웨이 5xx'); },
  });
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.match(r.switchInvite.notDeliveredKo, /알림톡 게이트웨이 5xx/);
  assert.equal(/토큰이 포함되어 생략/.test(r.switchInvite.notDeliveredKo), false);
});

test('접수된 초대에는 발송 사유를 적지 않는다 — 없는 칸을 실패로 읽히게 하지 않는다(경계)', b, async () => {
  const sw = switchWiring();
  const port = fakePort();
  const { core } = build({ flows: [flowRetry], ports: [port, darsPort()], channelSwitch: sw.binding });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });
  assert.equal(r.switchInvite.notDeliveredKo, undefined);
  assert.equal(core.warnings().some((i) => i.code === 'W_CHANNEL_SWITCH_UNBOUND'), false);
});

test('전환 배선이 없으면 토큰 없는 초대라는 사실을 결과에 적는다(§5.2·§10.3)', b, async () => {
  const { core, port } = build({ flows: [flowRetry] });
  await core.start(req({ flowId: 'retry' }));
  await core.send('i_test1', { input: { kind: 'timeout' } });
  const r = await core.send('i_test1', { input: { kind: 'timeout' } });

  assert.equal(r.switchInvite.tokenless, true);
  assert.equal(r.switchInvite.ticketIssued, false);
  assert.match(r.switchInvite.notIssuedKo, /세션의 열쇠/);
  // 매체 전달은 종전과 완전히 같다 — 티켓 없이 invite 를 부른다.
  assert.deepEqual(port.log.find((l) => l[0] === 'invite'), ['invite', 'i_test1', 'visual', undefined]);
});

test('초대를 수행할 수 없는 채널은 전환 자체가 선택되지 않는다 — 결과에도 실리지 않는다(§5.2)', b, async () => {
  // 교차채널 초대를 선언하지 않은 채널(챗봇)은 §5.1 사다리에서 전환을 고르지 않고 상담사로 간다.
  // 능력을 선언했는데 invite 가 없으면 **등록 자체가** 거부되므로, "링크를 못 보내는 전환"은 없다.
  const port = fakePort('chatbot');
  const { core } = build({ flows: [flowRetry], ports: [port], newId: () => 'i_chat1' });
  await core.start(req({ flowId: 'retry', adapter: 'chatbot', entryPoint: 'chat_widget' }));
  await core.send('i_chat1', { input: { kind: 'timeout' } });
  const r = await core.send('i_chat1', { input: { kind: 'timeout' } });

  assert.equal(r.switchInvite, undefined);
  assert.equal(r.state.channel, 'chat');
  assert.equal(r.status, 'transferred');

  const bad = fakePort('callbot');
  delete bad.invite;
  assert.throws(() => build({ flows: [flowRetry], ports: [bad] }), /invite 구현이 없습니다/);
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
    // 정리할 길이 없으면 발급된 초대가 레지스트리에서 영원히 나가지 않는다 — 상환·만료는
    // 상태만 바꾼다. 통화 중에는 드러나지 않으므로(발급·상환은 그대로 된다) 여기서 거른다(§10.3).
    [{ invites: { issue: () => {}, redeem: () => {} } }, /정리\(purge\)/],
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

// ── 지식 구성요소를 엔진 기동에서 꿴다(§5.2·§6.2·§9.3) ────────────────────────
//
// 분류기는 `engines.intent` 로 Core 가 만들어 주는데 §5.2 검색기·답변기는 그 자리가 없었다.
// 그래서 호스트는 `createRetriever`·`createAnswerer` 를 직접 불러야 했고, 그 조각에는
// **복원력도 헬스 기록도 붙지 않는다** — 붙일 방법 자체가 없었다(복원력이 붙은 묶음은
// `startEngines` 안에서 생기고, 그 호출은 런타임 생성 **중**이라 호스트 손에 들어오지 않는다).
// 결과는 침묵이다: 임베딩·LLM 이 전부 타임아웃이면 고객은 모든 질문에 "안내할 내용이 없다"를
// 듣는데 §9.3 판정은 normal 이고 지식베이스도 멀쩡하다.

/** 질의당 고정 벡터를 돌려주는 가짜 임베딩 어댑터. 네트워크에 닿지 않는다. */
const engEmbAd = { name: 'emb-x', residency: 'onprem', embed: async (texts) => texts.map(() => [0.1, 0.2]) };
const engEmbDown = {
  name: 'emb-dead',
  residency: 'onprem',
  embed: async () => { throw new HT.EngineError('E_TIMEOUT', 'embedding', '임베딩 응답 시간 초과'); },
};
const KB_NS = 't/goone/kb/kb_faq';
const KB_HIT = {
  id: 'd1#0', score: 0.9, namespace: KB_NS,
  text: '수수료는 면제입니다.',
  metadata: { docId: 'd1', title: '수수료 안내', sourceUri: 'kb://fee', approved: true },
};
/** `TenantVectorStore` 모양의 가짜 스토어. 스토어는 엔진이 아니라 호스트 인프라다. */
function kbStore(impl = async () => [KB_HIT]) {
  const calls = [];
  return {
    calls,
    store: {
      scope: SCOPE,
      upsert: async () => {},
      purge: async () => {},
      query: async (kbId, embedding, topK) => { calls.push({ kbId, topK, dim: embedding.length }); return impl(kbId); },
    },
  };
}
/** 임베딩·LLM 조각까지 들어 있는 엔진 선언. 지식 파생을 선언한다. */
function kbEngineDecl({ llm, embedding = engEmbAd, activation = 'live', over = {} } = {}) {
  return {
    scope: SCOPE,
    allowOverseas: false,
    sets: [{
      name: 'primary',
      parts: [{
        kind: 'preassembled', source: 'fake',
        engines: { activation, stt: engSttAd, tts: engTtsAd, llm: llm ?? engLlmOk('{"sufficient":true,"answerKo":"수수료는 면제입니다 [1]."}'), embedding },
      }],
    }],
    resilience: { attemptsPerCandidate: 1 },
    knowledge: { expectDim: 2 },
    answer: { systemKo: '근거만으로 존댓말로 답한다.' },
    ...over,
  };
}

test('엔진 기동이 검색기·답변기를 만들어 꿴다 — 질문이 근거까지 가고 답이 채널로 나간다(§5.2)', b, async () => {
  const f = kbStore();
  const { core, port } = build({
    flows: [flowFaq],
    engines: kbEngineDecl(),
    knowledge: { search: { store: f.store, knowledgeBaseIds: ['kb_faq'] }, policy: KB_POLICY },
  });
  const r = await core.start(faqReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  assert.deepEqual(after.steps.map((s) => s.nodeId), ['__answer', 'bye']);
  assert.equal(after.steps[0].text, '수수료는 면제입니다 [1].');
  assert.deepEqual(f.calls, [{ kbId: 'kb_faq', topK: 3, dim: 2 }]);
  assert.deepEqual(port.log.at(-1), ['present', 'i_test1', ['__answer', 'bye']]);
  // 질의는 마스킹을 지나 엔진으로 나가고 세션에도 마스킹된 것만 남는다(§10.3).
  assert.equal(JSON.stringify(after.state.slots).includes('010-1234-5678'), false);
  assert.equal(core.warnings().some((i) => i.code === 'W_KNOWLEDGE_UNBOUND'), false);
  assert.equal(core.warnings().some((i) => i.code === 'W_KNOWLEDGE_PARTS'), false);
});

test('그 경로의 임베딩 실패는 §9.3 레지스트리에 닿고 근거 없음과 섞이지 않는다', b, async () => {
  const reports = [];
  const { core, health } = build({
    flows: [flowFaq],
    engines: kbEngineDecl({ embedding: engEmbDown }),
    knowledge: {
      search: { store: kbStore().store, knowledgeBaseIds: ['kb_faq'] },
      policy: KB_POLICY,
      onResult: (x) => reports.push(x),
    },
  });
  const r = await core.start(faqReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: RAW_Q } });
  // 답하지 못한 것은 §5.1 사다리로 간다(문안을 만들지 않는다).
  assert.equal(after.steps.some((s) => s.nodeId === '__answer'), false);
  assert.equal(reports.at(-1).answered, false);
  assert.equal(reports.at(-1).infraFailed, true, '엔진 장애가 "근거 없음"으로 적혔다');
  // 호스트가 조각으로 만든 검색기였다면 이 샘플은 0건이고 폴백은 영원히 normal 이다.
  assert.equal(health.latest('rag').state, 'down', '임베딩 실패가 통화와 같은 레지스트리에 닿지 않았다');
});

test('검색기가 두 곳에서 오면 거부한다 — 어느 임베딩으로 검색하는지 읽을 수 없다(§2)', b, () => {
  assert.throws(
    () => build({
      flows: [flowFaq],
      engines: kbEngineDecl(),
      knowledge: { retriever: retrieverOf(), search: { store: kbStore().store, knowledgeBaseIds: ['kb_faq'] }, policy: KB_POLICY },
    }),
    /검색기가 두 곳에서 옵니다/,
  );
});

test('답변기가 두 곳에서 오면 거부한다 — 한쪽은 §9.3 에 닿지 않는다(§2)', b, () => {
  assert.throws(
    () => build({
      flows: [flowFaq],
      engines: kbEngineDecl(),
      knowledge: { search: { store: kbStore().store, knowledgeBaseIds: ['kb_faq'] }, answerer: answererOf(), policy: KB_POLICY },
    }),
    /답변기가 두 곳에서 옵니다/,
  );
});

test('임베딩을 선언하지 않은 엔진으로 search 를 주면 거부한다 — Core 는 임베딩을 만들지 않는다(§6.2)', b, () => {
  assert.throws(
    () => build({
      flows: [flowFaq],
      engines: engineDecl({ over: { answer: { systemKo: '근거만으로 답한다.' } } }),
      knowledge: { search: { store: kbStore().store, knowledgeBaseIds: ['kb_faq'] }, policy: KB_POLICY },
    }),
    /임베딩이 없습니다/,
  );
});

test('지식베이스 목록이 비었거나 남의 테넌트 스토어면 통화 전에 막는다(§13-3·§11.1)', b, () => {
  assert.throws(
    () => build({
      flows: [flowFaq],
      engines: kbEngineDecl(),
      knowledge: { search: { store: kbStore().store, knowledgeBaseIds: [] }, policy: KB_POLICY },
    }),
    /지식 응대 배선 거부/,
  );
  const other = kbStore();
  other.store.scope = { tenantId: 'other' };
  assert.throws(
    () => build({
      flows: [flowFaq],
      engines: kbEngineDecl(),
      knowledge: { search: { store: other.store, knowledgeBaseIds: ['kb_faq'] }, policy: KB_POLICY },
    }),
    /§11.1/,
  );
});

test('엔진이 기동된 상태에서 호스트 조립을 섞으면 경고로 드러낸다 — 그 호출만 §9.3 을 비껴간다', b, () => {
  const { core } = build({
    flows: [flowFaq],
    engines: engineDecl(),                     // 지식 파생을 선언하지 않은 엔진
    knowledge: kbBinding(retrieverOf(), answererOf()),
  });
  const w = core.warnings().find((i) => i.code === 'W_KNOWLEDGE_PARTS');
  assert.ok(w, `경고가 없다: ${JSON.stringify(core.warnings().map((i) => i.code))}`);
  assert.match(w.messageKo, /검색기\(retriever\)·답변기\(answerer\)/);
  // 엔진 미배선이면 호스트 조립이 유일한 경로다 — 같은 사실을 두 번 적지 않는다.
  const noEngines = build({ flows: [flowFaq], knowledge: kbBinding(retrieverOf(), answererOf()) });
  assert.equal(noEngines.core.warnings().some((i) => i.code === 'W_KNOWLEDGE_PARTS'), false);
  assert.equal(noEngines.core.warnings().some((i) => i.code === 'W_ENGINES_UNBOUND'), true);
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

test('점검 결과를 받는 훅이 던져도 종료는 그대로 가고 요약은 결과에 실린다', b, async () => {
  // 종전에는 판정과 보고가 같은 try 안에 있어서, **전문을 올리지 못한 것 때문에 요약까지
  // 사라졌다**(그 자리의 검사가 `r.compliance === undefined` 를 고정하고 있었다). 그런데
  // `reviewCompliance` 는 던지지 않으므로 그 catch 에 닿는 유일한 길은 호스트의 `onReport`
  // 이고, 그 훅은 **리뷰 큐 적재**다 — 적재 실패가 Core 가 이미 끝낸 점검 결과를 지울 이유가
  // 없다. 하필 그 요약이 비-Node 호스트가 점검 결과를 받는 유일한 자리다(§7 5.2·§6.2).
  const { core, port } = build({
    disclosure: DISC(),
    qa: qaWiring({ onReport: () => { throw new Error('리뷰 큐 장애'); } }).binding,
  });
  await core.start(req());
  const r = await core.end('i_test1', '고객 종료');
  assert.equal(r.status, 'completed');
  assert.equal(r.compliance.reviewed, true);
  assert.ok(port.log.some((l) => l[0] === 'end'));     // 채널에는 종료 지시가 나갔다
  // 보고가 전달되지 않은 사실은 다른 일곱 훅과 같은 경고로 남는다(훅 이름당 한 건).
  const w = core.warnings().filter((i) => i.code === 'W_HOST_REPORT');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /qa\.onReport/);
  assert.equal(/리뷰 큐 장애/.test(w[0].messageKo), false);
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

test('경고: 금칙어 미등록은 막지 않되 그 항목이 합격이 아님을 드러낸다', b, () => {
  const { core } = build({
    disclosure: DISC(),
    qa: qaWiring({ disclosureMarkers: [], forbiddenPhrases: [] }).binding,
  });
  const w = core.warnings().filter((i) => i.code === 'W_QA').map((x) => x.messageKo);
  assert.ok(w.some((m) => /skipped/.test(m)));
  // 표식을 등록하지 않아도 **배선된 고지 설정의 문구**가 표식이 되므로 고지 점검은 돈다(§2) —
  // 이 경고는 설정에서도 뽑을 문구가 없을 때만 나온다.
  assert.equal(w.some((m) => /표식이 없어/.test(m)), false);
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

// ── 관측 배선(§13·§9.3·§10.3·§11.1·§13-3) ────────────────────────────────────
//
// 고정하는 것은 "로그가 남는다"가 아니라 **배선이 없던 동안의 상태**(통화가 예외로 죽어도
// 아무 기록이 없다)와 **배선을 켰을 때 새로 생길 수 있는 사고**(발화가 로그로 새고,
// 선언된 장애가 알림 폭주가 되고, 로거 예외가 통화를 끊는 것)다.

let OBS = null, LG = null, EM = null;
try {
  OBS = await import('../src/obs/executeObservability.ts');
  LG = await import('../src/obs/logger.ts');
  EM = await import('../src/obs/errorMonitor.ts');
} catch { /* 구형 런타임 */ }
const bo = { skip: (R && OBS && LG && EM) ? false : '타입 스트리핑 미지원 런타임' };

function obsWiring(over = {}) {
  const records = [];
  // 계약 경고 줄은 따로 받는다 — 진입점 관측 검사가 미배선 경고 건수에 흔들리지 않게
  // 하기 위해서다(경고 줄 자체는 아래 '계약 경고' 절에서 본다).
  const warnings = [];
  const sent = [];
  const sink = (rec) => { (rec.event === OBS.WARNING_EVENT ? warnings : records).push(rec); };
  return {
    records,
    warnings,
    sent,
    binding: {
      logger: LG.createLogger({ minLevel: 'debug', sink }),
      monitor: EM.createErrorMonitor({ transport: (r) => sent.push(r) }),
      ...over,
    },
  };
}

test('배선이 없으면 종전과 완전히 같다 — 실측도 만들지 않는다(§13-3)', bo, async () => {
  const { core } = build();
  await core.start(req());
  assert.equal(core.observability(), undefined, '관측 실측을 0건으로 지어내지 않는다');
  assert.equal(core.flushObservability(), 0);
});

test('배선 전에는 턴이 예외로 죽어도 아무 기록이 남지 않았다(결함 재현)', bo, async () => {
  const { core } = build();
  await assert.rejects(() => core.send('없는_세션', { input: { kind: 'utterance', text: 'x' } }));
  assert.equal(core.observability(), undefined);
});

test('진입점 네 곳 모두가 관측된다 — 조기 반환 경로를 빠뜨리지 않는다', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  await core.start(req());
  await core.send('i_test1', { input: { kind: 'utterance', text: '홍길동' } });
  core.reportHealth({ adapter: 'callbot', samples: [], observedAt: NOW });
  await core.end('i_test1', '고객 종료');
  await core.end('i_test1', '중복 종료');      // 이미 종료된 세션 — 조기 반환 경로
  assert.deepEqual(w.records.map((r) => r.event), [
    'core.session.start', 'core.turn.send', 'core.health.report', 'core.session.end', 'core.session.end',
  ]);
  assert.equal(core.observability().recorded, 5);
});

test('예외는 error 로 기록되고 수집기로 올라가며 그대로 다시 던져진다', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  await assert.rejects(() => core.send('없는_세션', { input: { kind: 'utterance', text: 'x' } }));
  assert.equal(w.records.length, 1);
  assert.equal(w.records[0].level, 'error');
  assert.equal(w.records[0].fields.outcome, 'threw');
  assert.equal(w.records[0].tenantId, 'goone');
  assert.equal(w.sent.length, 1);
  assert.equal(core.observability().captured, 1);
});

test('테넌트 격리 위반도 기록된다 — 로그의 테넌트는 Core 가 강제하는 값이다(§11.1)', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  await assert.rejects(() => core.start(req({ scope: { tenantId: 'other' } })));
  assert.equal(w.records[0].tenantId, 'goone', '호스트가 주장한 테넌트를 적으면 그 로그로 격리 사고를 조사할 수 없다');
  assert.equal(w.records[0].fields.adapter, 'callbot');
});

test('발화·슬롯 값·상담사 요약은 로그 어디에도 남지 않는다(§10.3)', bo, async () => {
  const w = obsWiring();
  const { core } = build({ flows: [flowHandoff], observability: w.binding });
  await core.start(req({ flowId: 'care' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '제 이름은 홍길동이고 900101-1234567 입니다' } });
  const dump = w.records.map((r) => LG.formatLine(r)).join('\n');
  for (const leaked of ['홍길동', '900101', '주민등록번호']) {
    assert.ok(!dump.includes(leaked), `로그에 본문이 남았다(${leaked})`);
  }
  const last = w.records[w.records.length - 1];
  assert.equal(last.fields.handoffSummaryAttached, true);
  assert.equal(last.fields.status, 'transferred');
});

test('채널이 준 상관관계 id 로 세션 전체가 이어진다 — Core 가 id 를 만들지 않는다(§13-3)', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  await core.start(req({ correlationId: 'call_7f3a91' }));
  await core.send('i_test1', { input: { kind: 'utterance', text: '값' } });
  await core.end('i_test1', '종료');
  assert.deepEqual(w.records.map((r) => r.requestId), ['call_7f3a91', 'call_7f3a91', 'call_7f3a91']);

  const w2 = obsWiring();
  const { core: c2 } = build({ observability: w2.binding });
  await c2.start(req());
  assert.equal(w2.records[0].requestId, undefined, '주지 않으면 만들지 않는다');
});

test('상관관계 id 에 발신번호를 넣은 호스트의 값은 로그에 실리지 않고 건수로 드러난다', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  await core.start(req({ correlationId: '010-1234-5678' }));
  assert.equal(w.records[0].requestId, undefined);
  assert.ok(!LG.formatLine(w.records[0]).includes('1234'));
  assert.equal(core.observability().droppedIds, 1);
});

test('장애 폴백으로 끝난 세션도 기록되고, 수집기로는 올라가지 않는다(§9.3)', bo, async () => {
  const w = obsWiring();
  const { core } = build({
    samples: [{ component: 'telephony', state: 'down', observedAt: NOW }],
    policy: { legacyIvrAvailable: true },
    observability: w.binding,
  });
  await core.start(req());
  assert.equal(w.records[0].level, 'warn');
  assert.equal(typeof w.records[0].fields.fallbackMode, 'string');
  assert.equal(w.sent.length, 0, '선언된 장애를 턴마다 알림으로 올리면 진짜 예외가 상한에 밀려 버려진다');
});

test('선언하지 않은 컴포넌트의 헬스 샘플이 버려진 사실이 드러난다(§9.3)', bo, () => {
  const w = obsWiring();
  const { core } = build({ components: ['telephony'], observability: w.binding });
  core.reportHealth({
    adapter: 'callbot',
    samples: [
      { component: 'telephony', state: 'up', observedAt: NOW },
      { component: 'llm', state: 'down', observedAt: NOW },
    ],
    observedAt: NOW,
  });
  const rec = w.records[0];
  assert.equal(rec.level, 'warn');
  assert.equal(rec.fields.offered, 2);
  assert.equal(rec.fields.samples, 1);
  assert.equal(rec.fields.ignored, 1);
  assert.equal(rec.fields.registered, true);
});

test('등록되지 않은 채널의 헬스 보고는 통째로 버려진다는 사실이 남는다', bo, () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  core.reportHealth({ adapter: 'chatbot', samples: [{ component: 'llm', state: 'down', observedAt: NOW }], observedAt: NOW });
  assert.equal(w.records[0].level, 'warn');
  assert.equal(w.records[0].fields.registered, false);
  assert.equal(w.records[0].fields.offered, 1);
  assert.equal(w.records[0].fields.samples, 0);
});

test('시계를 주면 실측 소요가 남고, 주지 않으면 만들지 않는다(§13-3)', bo, async () => {
  let t = 0;
  const w = obsWiring({ clock: () => (t += 7) });
  const { core } = build({ observability: w.binding });
  await core.start(req());
  assert.equal(typeof w.records[0].durationMs, 'number');

  const w2 = obsWiring();
  const { core: c2 } = build({ observability: w2.binding });
  await c2.start(req());
  assert.equal(w2.records[0].durationMs, undefined);
  assert.equal(w2.records[0].at, undefined, '로거에 시계가 없으면 시각도 만들지 않는다');
});

test('로거가 던져도 통화는 끊기지 않고 실패가 집계된다(§9.3)', bo, async () => {
  const boom = () => { throw new Error('sink 폭발'); };
  const logger = {
    minLevel: 'info', debug: boom, info: boom, warn: boom, error: boom,
    child() { return logger; }, async time(_e, run) { return run(); },
  };
  const { core } = build({ observability: { logger } });
  const r = await core.start(req());
  assert.equal(r.status, 'running');
  // 턴 한 줄과 등록 시점 계약 경고 줄이 모두 던진다 — 건수는 배선에 따라 달라지지만
  // **삼키지 않고 센다**는 것이 요점이다.
  assert.ok(core.observability().failed >= 1, '로깅 실패를 삼키지 않고 센다');
  assert.equal(core.observability().logged, 0);
});

test('관측은 턴 결과에 아무것도 싣지 않는다 — 배선 유무로 결과가 달라지지 않는다', bo, async () => {
  const w = obsWiring();
  const a = build({ observability: w.binding });
  const c = build();
  const ra = await a.core.start(req());
  const rc = await c.core.start(req());
  assert.deepEqual(Object.keys(ra).sort(), Object.keys(rc).sort());
  assert.deepEqual(ra.state, rc.state);
  assert.equal(ra.events.length, rc.events.length);
});

test('과금 근거를 못 실은 종료는 warn 으로 드러난다(§11.2)', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  await core.start(req());
  await core.end('i_test1', '종료', { billableMs: -1 });
  const last = w.records[w.records.length - 1];
  assert.equal(last.level, 'warn');
  assert.equal(last.fields.billableMsRecorded, false);
});

// ── 계약 경고가 로그로 나간다(§13) ───────────────────────────────────────────
//
// 배선 전에는 `W_CONSENT_UNBOUND`·`W_QA_UNBOUND`·`W_KNOWLEDGE_UNBOUND` 같은 미배선 경고가
// 호스트가 `warnings()` 를 **읽어야만** 보였다. 읽지 않으면 동의·점검·지식 응대가 배선되지
// 않은 채로 도는데, 그 상태는 예외도 장애도 아니라 **아무 일도 일어나지 않는 것**이라
// 통화·이벤트·적합성 검사가 전부 정상이다. 여기서 고정하는 것은 그 경고가 **한 번만**
// 나가고 **문구는 나가지 않는다**는 것이다.

test('미배선 계약 경고는 첫 통화 전에 — 등록 시점에 — 로그로 나간다', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  assert.ok(w.warnings.length > 0, '한 통도 받지 않는 인스턴스도 미배선 사실을 알려야 한다');
  assert.equal(w.records.length, 0, '통화가 없었으므로 진입점 줄은 없다');
  for (const rec of w.warnings) {
    assert.equal(rec.level, 'warn');
    assert.match(rec.code, /^W_[A-Z_]+$/);
    assert.equal(rec.fields.outcome, 'warned');
  }
  assert.ok(w.warnings.some((r) => r.code === 'W_QA_UNBOUND'));
  assert.equal(core.observability().warned, w.warnings.length);
});

test('경고 문구는 로그로 나가지 않는다 — 보간된 자유 문장이다(§10.3)', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  const dump = w.warnings.map((r) => LG.formatLine(r)).join('\n');
  for (const issue of core.warnings()) {
    // 문구 전체가 로그에 실리지 않는다 — 전문은 warnings() 로만 읽는다.
    assert.ok(!dump.includes(issue.messageKo), `경고 문구가 로그로 샜다: ${issue.messageKo}`);
  }
  assert.ok(dump.includes('W_QA_UNBOUND'), '코드는 남는다');
});

test('같은 경고를 턴마다 되풀이하지 않는다 — 잡음이 진짜 신호를 묻는다', bo, async () => {
  const w = obsWiring();
  const { core } = build({ observability: w.binding });
  const atStart = w.warnings.length;
  const r = await core.start(req());
  await core.send(r.interactionId, { input: { kind: 'utterance', text: '홍길동' } });
  await core.end(r.interactionId, '고객 종료');
  assert.equal(w.warnings.length, atStart, '등록 시점 경고는 이미 나갔다');
  assert.equal(core.observability().warned, atStart);
});

test('통화 중 처음 드러난 경고는 그 턴 뒤에 한 번만 나간다', bo, async () => {
  const w = obsWiring();
  const { core } = build({ flows: INTENT_FLOWS, observability: w.binding });
  assert.equal(w.warnings.filter((r) => r.code === 'W_INTENT_UNBOUND').length, 0);
  const r = await core.start(triageReq());
  await core.send(r.interactionId, { input: { kind: 'utterance', text: '잔액 알려줘' } });
  await core.send(r.interactionId, { input: { kind: 'utterance', text: '다시 잔액' } });
  const lines = w.warnings.filter((rec) => rec.code === 'W_INTENT_UNBOUND');
  assert.equal(lines.length, 1, '두 턴 모두 미배선이지만 줄은 하나다');
  // 인과 순서가 보이게 턴 줄 뒤에 나간다 — 경고만 먼저 보면 어느 턴이 드러냈는지 알 수 없다.
  assert.ok(w.records.length > 0);
});

test('배선이 없으면 경고도 나가지 않는다 — 종전과 완전히 같다(§13-3)', bo, async () => {
  const { core } = build();
  assert.ok(core.warnings().length > 0);
  assert.equal(core.observability(), undefined);
});

// ── readiness 배선(§9.3·§13) ────────────────────────────────────────────────
//
// 배선이 없던 동안 `ops/health.ts` 의 `checkHealth`·`approvalPendingProbe` 를 부르는 곳은
// 저장소 전체에서 자기 테스트뿐이었다 — 즉 /health 응답을 만드는 자리가 Core 에 없었고,
// 호스트가 직접 짜면 §9.3 폴백 상태는 그 응답에 **닿지 않는다**(엔진 HTTP 는 200 인데
// 모든 통화가 상담사 직결로 떨어진 상태가 `up`·200 으로 보고된다).

const okProbe = (name, over = {}) => ({
  name, kind: 'db', critical: true, check: async () => ({ status: 'up' }), ...over,
});
const depOf = (r, name) => r.dependencies.find((d) => d.name === name);

test('readiness 가 등록된 채널의 선언 컴포넌트를 그대로 싣는다 — 목록을 만들지 않는다', bo, async () => {
  const { core } = build({ samples: P.CHANNEL_COMPONENTS.callbot.map((c) => ({ component: c, state: 'up', observedAt: NOW })) });
  const r = await core.readiness({ timeoutMs: 500 });
  assert.equal(r.kind, 'readiness');
  assert.equal(r.status, 'up');
  assert.deepEqual(
    r.core.components.map((c) => c.component).sort(),
    [...P.CHANNEL_COMPONENTS.callbot].sort(),
  );
  assert.deepEqual(r.core.fallback.map((f) => f.channel), ['voice']);
  assert.deepEqual(r.core.warningsKo, []);
});

test('통화가 올린 샘플을 그대로 읽는다 — readiness 가 다른 레지스트리를 보지 않는다', bo, async () => {
  const { core } = build();
  core.reportHealth({ adapter: 'callbot', samples: [{ component: 'stt', state: 'down', observedAt: NOW }] });
  const r = await core.readiness({ timeoutMs: 500 });
  assert.equal(depOf(r, 'core:stt').status, 'down');
  assert.equal(r.core.fallback[0].aiAllowed, false);
});

test('AI 응대가 멈춘 상태에서도 503 을 내지 않는다 — 폴백 경로가 이 프로세스를 지난다', bo, async () => {
  const { core } = build({ samples: [{ component: 'llm', state: 'down', observedAt: NOW }] });
  const r = await core.readiness({ timeoutMs: 500, probes: [okProbe('primary-db')] });
  assert.equal(r.core.fallback[0].aiAllowed, false);
  assert.equal(r.status, 'degraded');
  assert.equal(r.httpStatus, 200);
  assert.ok(r.core.components.every((c) => c.component !== 'llm' || c.state === 'down'));
  assert.ok(r.dependencies.filter((d) => d.name.startsWith('core:')).every((d) => d.critical === false));
});

test('호스트가 선언한 필수 프로브 장애는 그대로 503 이다(§6.2)', bo, async () => {
  const { core } = build({ samples: P.CHANNEL_COMPONENTS.callbot.map((c) => ({ component: c, state: 'up', observedAt: NOW })) });
  const r = await core.readiness({
    timeoutMs: 500,
    probes: [okProbe('primary-db', { check: async () => ({ status: 'down', detail: '접속 거부' }) })],
  });
  assert.equal(r.httpStatus, 503);
});

test('활성화 전 컴포넌트는 샘플을 읽지 않고 [승인 필요] 로 적힌다', bo, async () => {
  const { core } = build({ samples: [{ component: 'llm', state: 'up', observedAt: NOW, latencyMs: 5 }] });
  const r = await core.readiness({ timeoutMs: 500, approvalPending: ['llm'] });
  assert.equal(depOf(r, 'core:llm').status, 'degraded');
  assert.match(depOf(r, 'core:llm').detail, /\[승인 필요\]/);
  assert.equal(r.httpStatus, 200);
});

test('readiness 는 런타임 시계를 쓴다 — 자기 시계로 낡음을 다시 판정하지 않는다', bo, async () => {
  // NOW 보다 한참 전의 샘플. staleAfterMs(60s)를 넘겼으므로 up 으로 믿지 않는다.
  const { core } = build({ samples: [{ component: 'stt', state: 'up', observedAt: '2026-09-01T08:00:00.000Z' }] });
  const r = await core.readiness({ timeoutMs: 500 });
  assert.equal(r.core.components.find((c) => c.component === 'stt').state, 'unknown');
});

test('채널이 등록되지 않으면 점검하지 못한 사실을 적는다 — 0건을 정상으로 읽지 않는다', bo, async () => {
  const { core } = build({ ports: [] });
  const r = await core.readiness({ timeoutMs: 500 });
  assert.deepEqual(r.core.components, []);
  assert.deepEqual(r.core.fallback, []);
  assert.equal(r.core.warningsKo.length, 2);
});

test('readiness 는 던지지 않는다 — 프로브가 터져도 보고서가 나온다', bo, async () => {
  const { core } = build();
  const r = await core.readiness({
    timeoutMs: 500,
    probes: [okProbe('primary-db', { check() { throw new Error('동기 폭발'); } })],
  });
  assert.equal(depOf(r, 'primary-db').status, 'down');
  assert.ok(r.core);
});

// ── 복구 프로브 배선(§9.3) ──────────────────────────────────────────────────
//
// 배선이 없던 동안 `ops/recoveryProbe.ts` 를 부르는 곳은 자기 테스트뿐이었다 — 폴백이 걸리면
// 엔진 호출이 멈춰 새 샘플이 생기지 않으므로 **폴백에서 빠져나오는 길이 없었다.**

const upProbe = (component) => ({
  component,
  check: async () => ({ component, state: 'up', observedAt: NOW }),
});
const recoveryBinding = (component = 'llm', over = {}) => ({
  schedules: [{ probe: upProbe(component), intervalMs: 1000, timeoutMs: 500 }],
  ...over,
});

test('미배선: 폴백에서 빠져나올 길이 없다는 사실을 경고로 드러낸다(§9.3)', bo, () => {
  const { core } = build();
  const w = core.warnings().filter((i) => i.code === 'W_RECOVERY_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /폴백에서 빠져나오는 길/);
});

test('미배선: runRecoveryProbes 는 빈 보고서가 아니라 undefined 다(§13-3)', bo, async () => {
  const { core } = build();
  assert.equal(await core.runRecoveryProbes(), undefined);
  assert.equal(core.recoveryLastRunAt('llm'), undefined);
});

test('배선 있음: 나쁜 컴포넌트를 다시 확인해 같은 레지스트리에 복구를 기록한다', bo, async () => {
  const { core, health } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    recovery: recoveryBinding('llm'),
  });
  assert.equal(core.warnings().some((i) => i.code === 'W_RECOVERY_UNBOUND'), false);
  const r = await core.runRecoveryProbes();
  assert.deepEqual(r.recovered, ['llm']);
  // 통화가 올린 샘플과 **같은** 레지스트리여야 한다 — 다르면 보고서만 복구로 찍힌다.
  assert.equal(health.latest('llm').state, 'up');
  assert.equal(core.recoveryLastRunAt('llm'), NOW);
});

test('복구가 폴백 판정에 그대로 반영된다 — readiness 가 같은 사실을 본다', bo, async () => {
  const { core } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    recovery: recoveryBinding('llm'),
  });
  const before = await core.readiness({ timeoutMs: 500 });
  assert.equal(before.core.fallback[0].aiAllowed, false);
  await core.runRecoveryProbes();
  const after = await core.readiness({ timeoutMs: 500 });
  assert.equal(after.core.fallback[0].aiAllowed, true);
});

test('정상인 컴포넌트는 찌르지 않는다 — 합성 요청은 비용이다(§11.2)', bo, async () => {
  let calls = 0;
  const probe = { component: 'llm', check: async () => { calls += 1; return { component: 'llm', state: 'up', observedAt: NOW }; } };
  const { core } = build({
    samples: [{ component: 'llm', state: 'up', observedAt: NOW }],
    recovery: { schedules: [{ probe, intervalMs: 1000, timeoutMs: 500 }] },
  });
  const r = await core.runRecoveryProbes();
  assert.equal(calls, 0);
  assert.equal(r.attempts.find((a) => a.component === 'llm').skipped, 'healthy');
});

test('프로브가 없는 나쁜 컴포넌트는 "확인할 길이 없다"로 드러난다', bo, async () => {
  const { core } = build({
    samples: [{ component: 'stt', state: 'down', observedAt: NOW }, { component: 'llm', state: 'down', observedAt: NOW }],
    recovery: recoveryBinding('llm'),
  });
  const r = await core.runRecoveryProbes();
  assert.ok(r.unprobed.includes('stt'), '감시 목록은 등록된 채널의 선언 컴포넌트다');
});

test('등록된 채널이 올리지 않는 컴포넌트의 프로브는 생성 시점에 거부한다(§9.3)', bo, () => {
  assert.throws(
    () => build({ port: fakePort('chatbot'), recovery: recoveryBinding('stt') }),
    /등록된 채널이 올리지 않는 컴포넌트/,
  );
});

test('빈 배선은 "확인하고 있다"로 남으므로 거부한다(§13-3)', bo, () => {
  assert.throws(() => build({ recovery: { schedules: [] } }), /프로브가 없습니다/);
});

test('호스트는 레지스트리·정책·시계를 주장할 수 없다 — 받지 않는다', bo, async () => {
  const other = F.createHealthRegistry([]);
  const { core, health } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    // 넘겨도 무시된다(타입에 없다). 받으면 프로브가 아무도 읽지 않는 곳에 쓴다.
    recovery: { ...recoveryBinding('llm'), registry: other, policy: { staleAfterMs: 1 }, now: () => '2000-01-01T00:00:00.000Z' },
  });
  await core.runRecoveryProbes();
  assert.equal(health.latest('llm').state, 'up');
  assert.deepEqual(other.snapshot(), []);
});

test('복구 프로브는 던지지 않는다 — 프로브가 터져도 보고서가 나온다', bo, async () => {
  const probe = { component: 'llm', check() { throw new Error('동기 폭발'); } };
  const { core } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    recovery: { schedules: [{ probe, intervalMs: 1000, timeoutMs: 500 }] },
  });
  const r = await core.runRecoveryProbes();
  assert.deepEqual(r.recovered, []);
  assert.ok(r.attempts.some((a) => a.component === 'llm' && a.ran === true));
});

// ── 엔진 기동 배선(§6.2·§9.3) ────────────────────────────────────────────────
// 이 배선이 없는 동안 인텐트·지식 배선 주석이 약속한 "엔진 상태는 resilience.ts 가 이미
// 적는다"는 **참이 아니었다** — 헬스 레지스트리에 들어오는 샘플은 채널이 올리는 것뿐이었고,
// 채널이 올리는 것은 대개 자기 매체다. 그래서 LLM 이 전부 죽어도 폴백 판정은 normal 이다.

const engSttAd = { name: 'stt-x', residency: 'onprem', stream: async function* () { yield { text: '여보세요', isFinal: true }; } };
const engTtsAd = { name: 'tts-x', residency: 'onprem', synthesize: async function* () { yield { data: new Uint8Array([1]), mime: 'audio/wav' }; } };
const engLlmOk = (text) => ({ name: 'llm-x', residency: 'onprem', complete: async function* () { yield text; } });
/** 엔진이 알려 준 실패(타임아웃)다 — 이것만 엔진 상태로 집계된다. */
const engLlmDown = {
  name: 'llm-dead',
  residency: 'onprem',
  complete: async function* () { throw new HT.EngineError('E_TIMEOUT', 'llm', '응답 시간 초과'); },
};
/** 정체불명 예외. 엔진 탓으로 돌리지 않는다 — 우리 쪽 결함으로 전 채널을 내릴 수 없다. */
const engLlmBoom = {
  name: 'llm-boom',
  residency: 'onprem',
  complete: async function* () { throw new Error('우리 코드가 터졌다'); },
};

/** 미리 만들어진 조각으로만 기동한다 — 네트워크에 닿지 않는다. */
function engineDecl({ llm = engLlmOk('{"candidates":[]}'), activation = 'live', over = {} } = {}) {
  return {
    scope: SCOPE,
    allowOverseas: false,
    sets: [{
      name: 'primary',
      parts: [{ kind: 'preassembled', source: 'fake', engines: { activation, stt: engSttAd, tts: engTtsAd, llm } }],
    }],
    resilience: { attemptsPerCandidate: 1 },
    ...over,
  };
}

test('엔진 미배선: 종전과 완전히 같고(§13-3) 그 사실이 경고로 남는다', b, () => {
  const { core } = build();
  assert.equal(core.engines(), undefined, '배선이 없는데 빈 객체를 돌려줬다');
  assert.equal(core.warnings().some((i) => i.code === 'W_ENGINES_UNBOUND'), true);
});

test('배선하면 엔진이 서고 경고가 사라진다 — 후보·활성화·컴포넌트가 그대로 보인다', b, () => {
  const { core } = build({ engines: engineDecl() });
  const eng = core.engines();
  assert.equal(eng.activation, 'live');
  assert.deepEqual(eng.candidates, ['primary']);
  assert.deepEqual(eng.components, ['stt', 'tts', 'llm']);
  assert.equal(eng.healthRecorded, true);
  assert.equal(core.warnings().some((i) => i.code === 'W_ENGINES_UNBOUND'), false);
});

test('엔진 실패가 런타임의 레지스트리에 들어와 §9.3 폴백을 실제로 걸게 한다', b, async () => {
  const { core, port, health } = build({
    engines: engineDecl({ llm: engLlmDown }),
    policy: { legacyIvrAvailable: true },
  });
  // 배선 전에는 이 상태가 어디에도 기록되지 않았다 — 통화만 턴마다 개별적으로 실패했다.
  const first = await core.start(req());
  assert.equal(first.status, 'running', '엔진을 부르기 전부터 폴백이 걸렸다');

  await assert.rejects(async () => {
    for await (const _ of core.engines().engines.llm.complete([{ role: 'user', content: '안녕' }])) { /* 소비만 */ }
  });
  assert.equal(health.latest('llm').state, 'down', '엔진 실패가 통화가 올린 샘플과 같은 레지스트리에 닿지 않았다');

  const second = await core.start(req());
  assert.equal(second.fallback.mode, 'legacy_ivr');
  assert.equal(second.status, 'transferred');
  assert.ok(port.log.some((l) => l[0] === 'ivr'));
});

test('정체불명 예외는 엔진 장애로 집계하지 않는다 — 우리 쪽 결함으로 전 채널을 내릴 수 없다', b, async () => {
  const { core, health } = build({ engines: engineDecl({ llm: engLlmBoom }) });
  await assert.rejects(async () => {
    for await (const _ of core.engines().engines.llm.complete([{ role: 'user', content: '안녕' }])) { /* 소비만 */ }
  });
  assert.equal(health.latest('llm'), undefined, '정체불명 예외가 엔진 상태로 적혔다');
});

test('dry_run 엔진은 샘플을 남기지 않고 승인 대기로 적힌다 — readiness 가 실관측으로 읽지 않는다', b, async () => {
  const { core, health } = build({ engines: engineDecl({ activation: 'dry_run' }) });
  assert.equal(core.engines().healthRecorded, false);
  for await (const _ of core.engines().engines.llm.complete([{ role: 'user', content: '안녕' }])) { /* 가짜는 성공한다 */ }
  assert.equal(health.latest('llm'), undefined, 'dry_run 성공이 실엔진 관측으로 기록됐다');
  const r = await core.readiness({ timeoutMs: 1000 });
  const llm = r.core.components.find((c) => c.component === 'llm');
  assert.equal(llm.approvalPending, true);
});

test('호스트가 선언한 승인 대기 목록을 지우지 않고 합친다', b, async () => {
  const { core } = build({ engines: engineDecl({ activation: 'dry_run' }) });
  const r = await core.readiness({ timeoutMs: 1000, approvalPending: ['telephony'] });
  const pending = r.core.components.filter((c) => c.approvalPending === true).map((c) => c.component);
  assert.ok(pending.includes('telephony'), '호스트 선언이 사라졌다');
  assert.ok(pending.includes('llm'), 'Core 가 아는 활성화 전 컴포넌트가 빠졌다');
});

test('다른 테넌트의 엔진 선언은 조용히 덮어쓰지 않고 거부한다(§11.1)', b, () => {
  assert.throws(
    () => build({ engines: engineDecl({ over: { scope: { tenantId: 'other' } } }) }),
    /선언의 테넌트가 런타임과 다릅니다/,
  );
});

test('엔진 기동이 분류기를 만들어 꿴다 — 발화가 시나리오를 고른다(§5.1)', b, async () => {
  const { core } = build({
    flows: INTENT_FLOWS,
    engines: engineDecl({
      llm: engLlmOk('{"candidates":[{"intent":"balance","confidence":0.95}]}'),
      over: { intent: { systemKo: '너는 상담 분류기다.' } },
    }),
    intent: {
      catalog: INTENT_CATALOG, policy: INTENT_POLICY, table: INTENT_TABLE,
      clarifyPrompt: '어떤 업무를 도와드릴까요?',
    },
  });
  const r = await core.start(triageReq());
  const after = await core.send(r.interactionId, { input: { kind: 'utterance', text: '잔액 알려줘' } });
  assert.equal(after.state.flowId, 'f_balance');
  assert.equal(after.state.slots[INTENT_SLOT], 'balance');
});

test('분류기가 두 곳에서 오면 거부한다 — 한쪽은 §9.3 에 닿지 않는다(§2)', b, () => {
  assert.throws(
    () => build({
      flows: INTENT_FLOWS,
      engines: engineDecl({ over: { intent: { systemKo: '너는 상담 분류기다.' } } }),
      intent: intentBinding(classifierOf({ candidates: [] })),
    }),
    /분류기가 두 곳에서 옵니다/,
  );
});

test('엔진 기동도 분류기 주입도 없으면 인텐트 배선을 거부한다(§6.2)', b, () => {
  assert.throws(
    () => build({
      flows: INTENT_FLOWS,
      intent: {
        catalog: INTENT_CATALOG, policy: INTENT_POLICY, table: INTENT_TABLE,
        clarifyPrompt: '어떤 업무를 도와드릴까요?',
      },
    }),
    /분류기\(classifier\)가 없습니다/,
  );
});

test('엔진 기동 선언이 성립하지 않으면 런타임 생성 자체가 막힌다 — 통화 중이 아니다', b, () => {
  assert.throws(
    () => build({ engines: engineDecl({ over: { allowOverseas: undefined } }) }),
    /allowOverseas/,
  );
});

// ── 엔진 복구 프로브 배선(§9.3) ──────────────────────────────────────────────
//
// (38)이 러너를, 위 절이 기동을 배선했는데 그 사이의 `HealthProbe` **구현이 0건**이었다.
// 엔진 컴포넌트가 `down` 이 되면 통화가 내려가 엔진 호출이 멈추고, 새 샘플을 만들 주체는
// 프로브뿐인데 그 프로브가 없다 — 폴백에서 빠져나오는 길이 다시 막힌다.

const ENGINE_PROBE_SAMPLES = {
  stt: { data: new Uint8Array([1, 2]), mime: 'audio/wav' },
  tts: { text: '점검용 문장입니다', voice: 'v1' },
  llm: [{ role: 'user', content: '점검' }],
};

const engineDeclWithProbes = (activation = 'live') => engineDecl({
  activation,
  over: { probes: { samples: ENGINE_PROBE_SAMPLES } },
});

test('엔진 프로브를 선언하면 러너가 그것을 돌려 같은 레지스트리에 복구를 기록한다', b, async () => {
  const { core, health } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    engines: engineDeclWithProbes(),
    recovery: { schedules: [], engineProbes: [{ component: 'llm', intervalMs: 1000, timeoutMs: 500 }] },
  });
  assert.equal(core.warnings().some((i) => i.code === 'W_ENGINE_PROBES'), false);
  const r = await core.runRecoveryProbes();
  assert.deepEqual(r.recovered, ['llm']);
  assert.equal(health.latest('llm').state, 'up');
});

test('엔진은 기동됐는데 엔진 컴포넌트 프로브가 없으면 첫 고객의 턴보다 먼저 드러낸다', b, () => {
  const { core } = build({ engines: engineDecl(), recovery: recoveryBinding('telephony') });
  const w = core.warnings().filter((i) => i.code === 'W_ENGINE_PROBES_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /stt, tts, llm/);
});

test('엔진 프로브를 전부 덮으면 그 경고가 사라진다', b, () => {
  const { core } = build({
    engines: engineDeclWithProbes(),
    recovery: {
      schedules: [],
      engineProbes: [
        { component: 'stt', intervalMs: 1000, timeoutMs: 500 },
        { component: 'tts', intervalMs: 1000, timeoutMs: 500 },
        { component: 'llm', intervalMs: 1000, timeoutMs: 500 },
      ],
    },
  });
  assert.equal(core.warnings().some((i) => i.code === 'W_ENGINE_PROBES_UNBOUND'), false);
});

test('만들어지지 않은 엔진 프로브는 가짜를 끼우지 않고 사유와 함께 드러낸다(dry_run)', b, async () => {
  const { core } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    engines: engineDeclWithProbes('dry_run'),
    recovery: { schedules: [], engineProbes: [{ component: 'llm', intervalMs: 1000, timeoutMs: 500 }] },
  });
  const w = core.warnings().filter((i) => i.code === 'W_ENGINE_PROBES');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /승인 전\(dry_run\)/);
  // 승인 전이 기본 상태이므로 **등록을 막지 않는다**. 대신 "확인할 길이 없다"가 계속 보인다.
  const r = await core.runRecoveryProbes();
  assert.ok(r.unprobed.includes('llm'));
  assert.deepEqual(r.recovered, []);
});

test('엔진 프로브를 선언했는데 엔진이 미배선이면 거부한다 — 찌를 대상이 없다', b, () => {
  assert.throws(
    () => build({ recovery: { schedules: [], engineProbes: [{ component: 'llm', intervalMs: 1, timeoutMs: 1 }] } }),
    /엔진이 기동 선언으로 배선되지 않았습니다/,
  );
});

test('엔진 기동에 probes 선언이 없으면 거부한다 — 합성 입력은 Core 가 만들지 않는다(§13-3)', b, () => {
  assert.throws(
    () => build({
      engines: engineDecl(),
      recovery: { schedules: [], engineProbes: [{ component: 'llm', intervalMs: 1, timeoutMs: 1 }] },
    }),
    /probes 선언이 없습니다/,
  );
});

test('engineProbes 빈 목록은 "확인하고 있다"로 읽히므로 거부한다(§13-3)', b, () => {
  assert.throws(
    () => build({ engines: engineDeclWithProbes(), recovery: { schedules: [], engineProbes: [] } }),
    /engineProbes 가 빈 목록/,
  );
});

test('엔진 프로브도 등록된 채널이 올리지 않는 컴포넌트면 거부한다 — 레지스트리 직접 쓰기를 우회시킬 수 없다', b, () => {
  assert.throws(
    () => build({
      port: fakePort('chatbot'),
      engines: engineDeclWithProbes(),
      recovery: { schedules: [], engineProbes: [{ component: 'stt', intervalMs: 1, timeoutMs: 1 }] },
    }),
    /등록된 채널이 올리지 않는 컴포넌트/,
  );
});

test('호스트 프로브와 엔진 프로브가 같은 컴포넌트면 러너가 중복으로 거부한다 — 어느 쪽이 돌았는지 보고와 어긋난다', b, () => {
  assert.throws(
    () => build({
      engines: engineDeclWithProbes(),
      recovery: { ...recoveryBinding('llm'), engineProbes: [{ component: 'llm', intervalMs: 1, timeoutMs: 1 }] },
    }),
    /중복 선언/,
  );
});

test('간격·제한 시간을 주지 않은 엔진 프로브는 돌지 않고 그 사실이 보고서에 남는다(§13-3)', b, async () => {
  const { core, health } = build({
    samples: [{ component: 'llm', state: 'down', observedAt: NOW }],
    engines: engineDeclWithProbes(),
    recovery: { schedules: [], engineProbes: [{ component: 'llm' }] },
  });
  const r = await core.runRecoveryProbes();
  assert.equal(r.attempts.find((a) => a.component === 'llm').skipped, 'no_interval');
  assert.equal(health.latest('llm').state, 'down');
});

// ── 보존 게이트 배선(§8.2) ─────────────────────────────────────────────────────
//
// 여기서 고정하는 것은 "지워진다"가 아니라 **지울 수 없는 것을 먼저 쌓지 않는다**이다.
// 미배선의 증상은 예외가 아니라 되돌릴 수 없음이라, 통화가 정상인 동안 조용히 진행된다.

const retRule = (dataClass, over = {}) => ({
  dataClass, retentionDays: 30, disposition: 'delete', basisKo: '계약 제8조', approved: true, ...over,
});
const retPolicy = (rules, over = {}) => ({ tenantId: 'goone', rules, ...over });
/** Core 가 묻는 네 분류를 다 채운 정책(bus·consent 배선까지 켠 경우의 최소 집합). */
const retFull = (over = {}) => retPolicy([
  retRule('transcript_masked'), retRule('interaction_event'),
  retRule('pii_field'), retRule('consent_record', { disposition: 'archive' }),
], over);

test('보존 배선이 없으면 종전과 완전히 같고, 그 사실이 경고로 남는다(§13-3)', b, async () => {
  const { core, port } = build();
  const w = core.warnings().filter((i) => i.code === 'W_RETENTION_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /되돌릴 수 없|기산 시점/);
  // 종전 동작: 통화는 그대로 돌아간다(막지 않는다).
  const r = await core.start(req());
  assert.equal(r.status, 'running');
  assert.equal(port.log.length, 1);
});

test('개인정보 분류에 보존 규칙이 없으면 기동을 거절한다 — 기한 없이 먼저 쌓이면 되돌릴 수 없다(§8.2)', b, () => {
  assert.throws(
    () => build({ retention: { policy: retPolicy([retRule('transcript_masked'), retRule('interaction_event')]) } }),
    /보존 배선 거부[\s\S]*E_NO_RULE/,
  );
});

test('미승인 규칙도 기동을 거절한다 [승인 필요]', b, () => {
  assert.throws(
    () => build({
      retention: { policy: retPolicy([
        retRule('transcript_masked'), retRule('interaction_event'), retRule('pii_field', { approved: false }),
      ]) },
    }),
    /E_NOT_APPROVED/,
  );
});

test('거절 사유는 분류마다 한 번에 다 나온다 — 하나씩 고치며 재배포하지 않게 한다', b, () => {
  const c = consentWiring();
  try {
    build({ flows: [flowConsent()], consent: c.binding, retention: { policy: retPolicy([]) } });
    assert.fail('거절되어야 한다');
  } catch (e) {
    // 개인정보 분류 둘(동의 기록·수집 항목)이 같은 메시지에 함께 적힌다.
    assert.match(e.message, /동의 이력/);
    assert.match(e.message, /개인정보 수집 항목/);
    // 거절 사유에는 Core 가 그 분류를 왜 쓰는지가 함께 적힌다.
    assert.match(e.message, /collectsPii/);
  }
});

test('동의 배선이 없으면 동의 기록 분류는 묻지 않는다 — 쓰지 않는 저장소를 대신 통과시키지도, 막지도 않는다', b, () => {
  // consent_record 규칙이 없는 정책이지만 동의가 배선되지 않았으므로 기동된다.
  const { core } = build({
    retention: { policy: retPolicy([
      retRule('transcript_masked'), retRule('interaction_event'), retRule('pii_field'),
    ]) },
  });
  assert.equal(core.warnings().some((i) => /동의 이력/.test(i.messageKo)), false);
  // 같은 정책에 동의를 배선하면 그때는 거절된다.
  assert.throws(
    () => build({
      flows: [flowConsent()],
      consent: consentWiring().binding,
      retention: { policy: retPolicy([
        retRule('transcript_masked'), retRule('interaction_event'), retRule('pii_field'),
      ]) },
    }),
    /동의 이력/,
  );
});

test('개인정보를 수집하지 않는 테넌트는 collectsPii:false 로 선언하면 기동된다', b, async () => {
  const { core } = build({
    retention: {
      policy: retPolicy([retRule('transcript_masked'), retRule('interaction_event'), retRule('recording')]),
      collectsPii: false,
    },
  });
  assert.equal(core.warnings().some((i) => i.code === 'W_RETENTION_UNBOUND'), false);
  assert.equal(core.warnings().some((i) => i.code === 'W_RETENTION_NO_RULE'), false);
  const r = await core.start(req());
  assert.equal(r.status, 'running');
});

test('개인정보를 담지 않는 분류의 규칙 없음은 막지 않고 경고로 드러낸다 — 자동 파기 대상이 되지 않는다', b, () => {
  // 음성 채널이 아닌 포트로 녹취 경고를 떼어 놓고 본다.
  const { core } = build({ port: fakePort('chatbot'), retention: { policy: retPolicy([retRule('pii_field')]) } });
  const w = core.warnings().filter((i) => i.code === 'W_RETENTION_NO_RULE');
  // 마스킹된 전문 + §8.1 이벤트(버스 배선이 있다) 둘 다 규칙이 없다.
  assert.equal(w.length, 2);
  assert.ok(w.every((i) => /자동 파기/.test(i.messageKo)));
  assert.ok(w.some((i) => /이벤트/.test(i.messageKo)));
});

test('음성 채널에 녹취 규칙이 없으면 막지 않고 드러낸다 — 녹취는 Core 가 저장하지 않는다(§8.2)', b, () => {
  const policy = retPolicy([retRule('transcript_masked'), retRule('interaction_event'), retRule('pii_field')]);
  const { core } = build({ retention: { policy } });                       // callbot = voice
  const w = core.warnings().filter((i) => i.code === 'W_RETENTION_NO_RULE' && /녹취/.test(i.messageKo));
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /파기 목록에 한 번도 올라오지 않/);
  // 음성이 아닌 채널만 붙은 테넌트에는 적지 않는다(해당 없는 경고는 진짜 신호를 묻는다).
  const chat = build({ port: fakePort('chatbot'), retention: { policy } });
  assert.equal(chat.core.warnings().some((i) => /녹취/.test(i.messageKo)), false);
  // 규칙을 채우면 사라진다.
  const ok = build({ retention: { policy: retPolicy([...policy.rules, retRule('recording')]) } });
  assert.equal(ok.core.warnings().some((i) => i.code === 'W_RETENTION_NO_RULE'), false);
});

test('다른 테넌트·워크스페이스의 보존 정책은 거절한다(§11.1)', b, () => {
  assert.throws(() => build({ retention: { policy: retFull({ tenantId: 'other' }) } }), /§11\.1/);
  assert.throws(() => build({ retention: { policy: retFull({ workspaceId: 'ws_x' }) } }), /§11\.1/);
});

test('보존기간으로 기한을 산출할 수 없는 규칙은 저장을 막는다 — 파기 판정이 영구 보류된다', b, () => {
  assert.throws(
    () => build({
      retention: { policy: retPolicy([
        retRule('transcript_masked'), retRule('interaction_event'), retRule('pii_field', { retentionDays: 0 }),
      ]) },
    }),
    /E_RULE_INVALID/,
  );
});

test('판정을 복사하지 않는다 — 규칙 조건이 runtime.ts 에 없다(§2)', b, async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src/channels/runtime.ts'), 'utf8',
  );
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.equal(/mayContainPii/.test(code), false);
  assert.equal(/retentionDays/.test(code), false);
});

// ── 큐 대안과 채널 능력의 어긋남(§9.3) ───────────────────────────────────────
// 큐가 닫힌 **시각에만** 나타나는 결함이라 평시 검사로는 영영 드러나지 않는다.
// 대안 중 채널 계약에 대응하는 능력이 있는 것은 legacy_ivr 하나이므로 그것만 검사한다.

const IVR_QUEUES = (over = {}) => ([
  { id: 'q_care', tenantId: 'goone', titleKo: '케어', skills: [], closedAction: 'legacy_ivr', ...over },
]);
const ivrRouting = (over = {}) => ({
  config: { tenantId: 'goone', queues: IVR_QUEUES(), rules: [], defaultQueueId: 'q_care', ...(over.config ?? {}) },
  snapshots: () => [{ queueId: 'q_care', waiting: 0, availableAgents: 1, observedAt: NOW }],
});

test('기존 IVR 회귀를 못 하는 채널이 legacy_ivr 대안 큐에 닿으면 드러낸다(W_ROUTING_ALTERNATIVE)', b, () => {
  const { core } = build({ flows: [flowHandoff], routing: ivrRouting() });
  const w = core.warnings().find((x) => x.code === 'W_ROUTING_ALTERNATIVE');
  assert.ok(w, '큐가 닫힌 시각에 고객이 아무 곳에도 가지 못하는 조합은 조용해서는 안 된다');
  assert.match(w.messageKo, /q_care/);
  assert.match(w.messageKo, /routeToLegacyIvr/);
});

test('능력이 있는 채널에는 적지 않는다 — 해당 없는 경고는 진짜 신호를 묻는다', b, () => {
  const { core } = build({
    flows: [flowHandoff], port: fakePort('callbot', { routeToLegacyIvr: true }), routing: ivrRouting(),
  });
  assert.equal(core.warnings().some((x) => x.code === 'W_ROUTING_ALTERNATIVE'), false);
});

test('대안이 콜백·음성사서함이면 적지 않는다 — Core 가 검사할 능력이 없다(§13-3)', b, () => {
  const { core } = build({ flows: [flowHandoff], routing: ROUTING() });
  assert.equal(core.warnings().some((x) => x.code === 'W_ROUTING_ALTERNATIVE'), false);
});

test('기본 큐는 channels 로 좁혀도 모든 채널이 닿는다 — 좁힘을 신뢰하면 놓친다', b, () => {
  // selectQueue 는 **기본 큐에 대해서만** 채널 검사를 건너뛴다. 좁혀 선언했다는 사실만 보고
  // 경고를 빼면, 음성 전용으로 적어 둔 기본 큐의 대안이 채팅 고객에게 그대로 적용된다.
  const { core } = build({
    flows: [flowHandoff], port: fakePort('chatbot'),
    routing: ivrRouting({ config: { queues: IVR_QUEUES({ channels: ['voice'] }) } }),
  });
  assert.ok(core.warnings().some((x) => x.code === 'W_ROUTING_ALTERNATIVE'));
});

test('규칙으로만 닿는 큐는 규칙의 채널 조건과 큐의 channels 를 둘 다 본다', b, () => {
  const config = {
    tenantId: 'goone',
    queues: [
      { id: 'q_open', tenantId: 'goone', titleKo: '일반', skills: [], closedAction: 'callback' },
      { id: 'q_voice', tenantId: 'goone', titleKo: '음성전용', skills: [], closedAction: 'legacy_ivr', channels: ['voice'] },
    ],
    rules: [{ id: 'r1', priority: 10, when: { channels: ['voice'] }, toQueue: 'q_voice' }],
    defaultQueueId: 'q_open',
  };
  const snapshots = () => [{ queueId: 'q_open', waiting: 0, availableAgents: 1, observedAt: NOW }];
  // 채팅 채널은 규칙(voice 전용)에도, 큐의 channels 에도 걸리지 않으므로 닿을 수 없다.
  const chat = build({ flows: [flowHandoff], port: fakePort('chatbot'), routing: { config, snapshots } });
  assert.equal(chat.core.warnings().some((x) => x.code === 'W_ROUTING_ALTERNATIVE'), false);
  // 음성 채널은 닿는다 — 그리고 callbot 기본 프로파일에는 IVR 회귀 능력이 없다.
  const voice = build({ flows: [flowHandoff], routing: { config, snapshots } });
  const w = voice.core.warnings().find((x) => x.code === 'W_ROUTING_ALTERNATIVE');
  assert.ok(w);
  assert.match(w.messageKo, /q_voice/);
});

test('오버플로로만 닿는 큐도 센다 — admitToQueue 는 channels 를 아예 보지 않는다', b, () => {
  const config = {
    tenantId: 'goone',
    queues: [
      { id: 'q_care', tenantId: 'goone', titleKo: '케어', skills: [], closedAction: 'callback',
        maxWaiting: 1, overflowQueueId: 'q_last' },
      { id: 'q_last', tenantId: 'goone', titleKo: '최종', skills: [], closedAction: 'legacy_ivr', channels: ['voice'] },
    ],
    rules: [],
    defaultQueueId: 'q_care',
  };
  const { core } = build({
    flows: [flowHandoff], port: fakePort('chatbot'),
    routing: { config, snapshots: () => [{ queueId: 'q_care', waiting: 0, availableAgents: 1, observedAt: NOW }] },
  });
  const w = core.warnings().find((x) => x.code === 'W_ROUTING_ALTERNATIVE');
  assert.ok(w, '오버플로 연쇄는 채널 선언을 보지 않으므로 채팅 고객도 그 큐에서 닫힌다');
  assert.match(w.messageKo, /q_last/);
});

test('어떤 규칙·기본 큐·오버플로에도 걸리지 않은 큐는 적지 않는다', b, () => {
  const config = {
    tenantId: 'goone',
    queues: [
      { id: 'q_care', tenantId: 'goone', titleKo: '케어', skills: [], closedAction: 'callback' },
      { id: 'q_orphan', tenantId: 'goone', titleKo: '미사용', skills: [], closedAction: 'legacy_ivr' },
    ],
    rules: [],
    defaultQueueId: 'q_care',
  };
  const { core } = build({
    flows: [flowHandoff],
    routing: { config, snapshots: () => [{ queueId: 'q_care', waiting: 0, availableAgents: 1, observedAt: NOW }] },
  });
  assert.equal(core.warnings().some((x) => x.code === 'W_ROUTING_ALTERNATIVE'), false,
    '아직 일어날 수 없는 일의 경고는 진짜 신호를 묻는다');
});

test('라우팅 자체가 없으면 적지 않는다 — 그 상태는 W_ROUTING_UNBOUND 다', b, () => {
  const { core } = build({ flows: [flowHandoff] });
  assert.equal(core.warnings().some((x) => x.code === 'W_ROUTING_ALTERNATIVE'), false);
  assert.ok(core.warnings().some((x) => x.code === 'W_ROUTING_UNBOUND'));
});
