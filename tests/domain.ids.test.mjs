import { test } from 'node:test';
import assert from 'node:assert/strict';

let I = null, R = null, S = null, F = null, B = null, P = null;
try {
  I = await import('../src/domain/ids.ts');
  R = await import('../src/channels/runtime.ts');
  S = await import('../src/core/session.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: I ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const flow = {
  id: 'billing', version: 1, startNodeId: 'ask',
  nodes: { ask: { id: 'ask', kind: 'Collect', slot: 'code', prompt: '고객번호를 말씀해 주세요.' } },
};

function buildDefaultIdCore() {
  const port = {
    id: 'callbot', capabilities: P.profileFor('callbot', {}),
    async present() {}, async transfer() {}, async routeToLegacyIvr() {}, async invite() {}, async end() {},
  };
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 500 }), releaseKeyOnSinkFailure: false,
  });
  return R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]), bus, now: () => '2026-09-01T09:00:00.000Z',
  });
}

test('같은 밀리초에 불러도 ID 가 겹치지 않는다(시계 고정)', b, () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(I.uniqueSuffix(1_700_000_000_000));
  assert.equal(ids.size, 1000);
});

test('createInteraction 기본 ID 도 연속 호출에서 겹치지 않는다', b, () => {
  const a = S.createInteraction('goone', 'voice');
  const c = S.createInteraction('goone', 'voice');
  assert.notEqual(a.id, c.id);
  assert.equal(S.createInteraction('goone', 'voice', 'i_fixed').id, 'i_fixed');   // 명시한 ID 는 그대로
});

test('동시에 시작한 통화가 기본 ID 로 서로의 세션을 덮어쓰지 않는다(§11.1)', b, async () => {
  const core = buildDefaultIdCore();
  const req = { scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing' };
  const results = await Promise.all(Array.from({ length: 20 }, () => core.start(req)));
  const ids = new Set(results.map((r) => r.interactionId));
  assert.equal(ids.size, 20, '20개 통화가 20개의 서로 다른 세션이어야 한다');
});

test('연속 호출에서 값이 줄어들거나 빈 문자열이 되지 않는다(경계)', b, () => {
  const x = I.uniqueSuffix(0);
  assert.match(x, /^0_[0-9a-z]+$/);
  assert.notEqual(I.uniqueSuffix(0), x);
});
