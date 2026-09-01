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

function build({ flows = [flowBilling], port = fakePort(), samples = [], policy = {}, components } = {}) {
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
