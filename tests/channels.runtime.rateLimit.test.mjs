// TypeScript 호스트 경로의 요청 제한 — §9.3(과부하 보호)·§11.1(테넌트 경계)·§11.2(과금 남용)·§13-3.
//
// 제한은 그동안 **브리지(JSONL) 경로에만** 있었다. 그런데 실제로 Core 를 소비하기 시작한 두
// 저장소(챗봇·D-ARS)는 TypeScript 호스트라 이 경로를 쓴다 — 보호가 아무도 지나가지 않는 길에
// 걸려 있었던 셈이고, 폭주는 악의보다 사고로 온다(전송 계층 재시도 루프·웹훅 재전송).
//
// 지키려는 것: 거절된 호출은 세션·이벤트·과금에 흔적을 남기지 않고, **end 는 절대 막지 않는다**
// (막히면 세션이 열린 채 남고 그 누수는 장애가 아니라 요금으로 나타난다).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null, RL = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
  RL = await import('../src/api/rateLimit.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-17T09:00:00.000Z';
const flow = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'a1' },
    a1: { id: 'a1', kind: 'Collect', slot: 'q1', prompt: '문의 내용을 말씀해 주세요.', next: 'a2' },
    a2: { id: 'a2', kind: 'Collect', slot: 'q2', prompt: '더 말씀해 주세요.', next: 'a3' },
    a3: { id: 'a3', kind: 'Collect', slot: 'q3', prompt: '또 말씀해 주세요.', next: 'a1' },
  },
};

function fakePort(id = 'callbot') {
  const log = [];
  return {
    id, log,
    capabilities: P.profileFor(id),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue) { log.push(['transfer', iid, queue]); },
    async invite(iid, target) { log.push(['invite', iid, target]); },
    async end(iid, reason) { log.push(['end', iid, reason]); },
  };
}

function build({ tenantId = 'goone', over = {} } = {}) {
  const scope = { tenantId };
  const collector = B.createCollectorSink('t');
  const port = fakePort();
  const policy = {
    tenantId, staleAfterMs: 60000, treatUnknownAsDown: false,
    legacyIvrAvailable: false, agentQueueAvailable: true,
  };
  const health = F.createHealthRegistry([]);
  const core = R.createConversationCore({
    scope,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy,
    health,
    bus: B.createEventBus({
      scope, sinks: [collector],
      store: B.createMemoryIdempotencyStore({ maxKeys: 500 }), releaseKeyOnSinkFailure: false,
    }),
    now: () => NOW,
    newInteractionId: () => `i_${tenantId}`,
    ...over,
  });
  return { core, port, collector, scope, policy, health };
}

const req = (scope) => ({ scope, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing' });
const turn = { input: { kind: 'utterance', text: '요금 문의' } };

test('제한기를 주지 않으면 제한하지 않는다 — 기본 한도를 코드에 두지 않는다(§13-3)', b, async () => {
  const { core, scope } = build();
  await core.start(req(scope));
  for (let i = 0; i < 20; i++) {
    const r = await core.send(`i_${scope.tenantId}`, turn);
    assert.equal(r.status, 'running', `턴 ${i}`);
  }
});

test('한도를 넘긴 send 는 E_RATE_LIMITED 로 거절되고 세션·이벤트에 흔적을 남기지 않는다', b, async () => {
  let t = 0;
  const limiter = RL.createRateLimiter({ rule: { burst: 2, refillPerSec: 1 }, clock: () => t });
  const { core, collector, scope } = build({ over: { rateLimiter: limiter } });
  await core.start(req(scope));                       // start 는 자기 버킷(core.start)을 쓴다
  const r1 = await core.send('i_goone', turn);
  const r2 = await core.send('i_goone', turn);
  const beforeTurns = r2.state.turnCount;
  const beforeEvents = collector.events.length;

  await assert.rejects(() => core.send('i_goone', turn), (e) => {
    assert.equal(e.code, 'E_RATE_LIMITED');
    assert.ok(e.retryAfterMs > 0, '계산된 재시도 대기가 실려야 한다 — 추정치가 아니다(§13-3)');
    return true;
  });
  // 거절은 아무 일도 하기 **전에** 판정된다: 턴도 이벤트도 늘지 않았다(§11.2).
  assert.equal(core.sessions.get('i_goone').state.turnCount, beforeTurns);
  assert.equal(collector.events.length, beforeEvents);

  // 시간이 흐르면 다시 통과하고, 턴 증분은 정상 턴 한 번과 같다.
  t = 1000;
  const r4 = await core.send('i_goone', turn);
  const perTurn = r2.state.turnCount - r1.state.turnCount;
  assert.ok(perTurn > 0);
  assert.equal(r4.state.turnCount - beforeTurns, perTurn);
});

test('end 는 버킷이 비어도 절대 막히지 않는다 — 막히면 세션이 샌다', b, async () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 0.001 }, clock: () => 0 });
  const { core, port, scope } = build({ over: { rateLimiter: limiter } });
  await core.start(req(scope));
  await assert.rejects(() => core.start(req(scope)));   // core.start 버킷 소진
  await core.send('i_goone', turn);
  await assert.rejects(() => core.send('i_goone', turn));   // core.send 버킷 소진
  const e = await core.end('i_goone', '고객 종료');
  assert.ok(['ended', 'completed'].includes(e.state.status), e.state.status);
  assert.equal(port.log.some((l) => l[0] === 'end'), true);
});

test('헬스 보고는 막지 않는다 — 샘플을 떨어뜨리면 장애가 정상으로 집계된다(§9.3)', b, () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 0.001 }, clock: () => 0 });
  const { core, health, policy } = build({ over: { rateLimiter: limiter } });
  for (let i = 0; i < 10; i++) {
    core.reportHealth({
      adapter: 'callbot',
      samples: [{ component: 'stt', state: 'down', observedAt: NOW }],
      observedAt: NOW,
    });
  }
  const decision = F.decideFallbackMode('voice', health, policy, NOW);
  assert.notEqual(decision.mode, 'normal', 'down 샘플이 버려지면 판정이 normal 로 남아 장애가 숨는다');
});

test('한도 키는 테넌트 스코프를 포함한다 — 한 고객사의 폭주가 다른 고객사를 막지 않는다(§11.1)', b, async () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 0.001 }, clock: () => 0 });
  const a = build({ tenantId: 'tenant_a', over: { rateLimiter: limiter } });
  const c = build({ tenantId: 'tenant_c', over: { rateLimiter: limiter } });
  await a.core.start(req(a.scope));
  await assert.rejects(() => a.core.start(req(a.scope)));
  await c.core.start(req(c.scope));          // 같은 제한기, 다른 테넌트 → 영향 없음
  assert.equal(limiter.size, 2);
});

test('브리지와 버킷이 갈린다 — 같은 제한기를 둘에 줘도 한 요청을 두 번 세지 않는다', b, async () => {
  const BR = await import('../src/channels/bridge.ts');
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 0.001 }, clock: () => 0 });
  const { core, scope } = build({ over: { rateLimiter: limiter } });
  const bridge = BR.createBridge({ core, adapter: 'callbot', scope, rateLimiter: limiter });
  const r = await bridge.handleLine(JSON.stringify({
    id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' },
  }));
  assert.equal(r.ok, true, '버킷이 하나면 브리지가 먼저 써 버려 Core 진입에서 막힌다');
  assert.equal(limiter.size, 2);
});

test('진입점별 비용: send 를 무겁게 세면 그만큼 빨리 한도에 닿는다', b, async () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 3, refillPerSec: 0.001 }, clock: () => 0 });
  const { core, scope } = build({ over: { rateLimiter: limiter, rateLimitCost: { send: 2 } } });
  await core.start(req(scope));
  await core.send('i_goone', turn);                                  // 3 → 1
  await assert.rejects(() => core.send('i_goone', turn), (e) => {    // 비용 2 > 잔여 1
    assert.equal(e.code, 'E_RATE_LIMITED');
    assert.equal(e.retryAfterMs, 1_000_000);                         // 부족분 1 ÷ 0.001/s = 1000s (계산값)
    return true;
  });
});

test('끝난 세션의 늦은 입력도 센다 — 재시도 루프는 대개 그 경로로 몰린다', b, async () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 2, refillPerSec: 0.001 }, clock: () => 0 });
  const { core, scope } = build({ over: { rateLimiter: limiter } });
  await core.start(req(scope));                 // core.start 버킷
  await core.end('i_goone', '고객 종료');        // end 는 제한 대상이 아니다
  const late = await core.send('i_goone', turn); // 종료된 세션 — 조기 반환이지만 한도는 센다
  assert.deepEqual(late.events, []);
  await core.send('i_goone', turn);
  await assert.rejects(() => core.send('i_goone', turn), (e) => e.code === 'E_RATE_LIMITED');
});

test('설정 거부: 제한 대상이 아닌 진입점·0 이하 비용·제한기 없는 비용', b, () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 1 } });
  // 조용히 무시하면 "제한을 걸었다"는 기록만 남고 실제로는 걸리지 않는다.
  assert.throws(() => build({ over: { rateLimiter: limiter, rateLimitCost: { end: 1 } } }), /진입점/);
  assert.throws(() => build({ over: { rateLimiter: limiter, rateLimitCost: { reportHealth: 1 } } }), /진입점/);
  assert.throws(() => build({ over: { rateLimiter: limiter, rateLimitCost: { send: 0 } } }), /양수/);
  assert.throws(() => build({ over: { rateLimitCost: { send: 1 } } }), /rateLimiter/);
});

test('설정 거부: check 가 없는 제한기 — 형태 오류를 제한기 장애처럼 통과시키지 않는다', b, () => {
  assert.throws(() => build({ over: { rateLimiter: {} } }), /check/);
  assert.throws(() => build({ over: { rateLimiter: { check: 1 } } }), /check/);
});

test('제한기 자체가 던지면 잠그지 않고 통과시킨다 — 제한기 장애로 통화가 끊기면 안 된다(§9.3)', b, async () => {
  const broken = { check() { throw new Error('공유 저장소 장애'); }, peek() { throw new Error('x'); }, reset() {}, size: 0 };
  const { core, scope } = build({ over: { rateLimiter: broken } });
  const s = await core.start(req(scope));
  assert.equal(s.status, 'running');
  const t1 = await core.send('i_goone', turn);
  assert.equal(t1.status, 'running');
});

test('거절은 관측에 남는다 — 폭주를 막은 사실이 이 프로세스 밖에서도 보여야 한다', b, async () => {
  const LG = await import('../src/obs/logger.ts');
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 0.001 }, clock: () => 0 });
  const records = [];
  const { core, scope } = build({
    over: {
      rateLimiter: limiter,
      observability: { logger: LG.createLogger({ minLevel: 'debug', sink: (r) => records.push(r) }) },
    },
  });
  await core.start(req(scope));
  await assert.rejects(() => core.start(req(scope)));
  // 거절도 진입점 관측 한 줄이다. 남지 않으면 "폭주를 막았다"가 이 프로세스 밖에서 보이지 않는다.
  const threw = records.filter((r) => r.fields?.outcome === 'threw');
  assert.equal(threw.length, 1);
  assert.equal(threw[0].tenantId, 'goone');
  assert.equal(core.observability().recorded, 2);
});
