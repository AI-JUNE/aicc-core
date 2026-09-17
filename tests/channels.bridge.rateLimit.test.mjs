// 브리지 진입점 요청 제한 — §9.3(과부하 보호)·§11.1(테넌트 경계)·§11.2(과금 남용)·§13-3(기본 한도 없음).
//
// 지키려는 것: 호스트의 재시도 루프·잘못 설정된 헬스 주기가 Core 와 엔진 과금을 끌어내리는 것을 막되,
// **end 는 절대 막지 않는다**(막히면 세션이 새고 장애가 아니라 요금으로 나타난다).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let BR = null, R = null, F = null, P = null, BP = null, RL = null;
try {
  BR = await import('../src/channels/bridge.ts');
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  P = await import('../src/channels/profiles.ts');
  BP = await import('../src/channels/basePort.ts');
  RL = await import('../src/api/rateLimit.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: BR ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-09-16T09:00:00.000Z';
const flow = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'q', prompt: '문의 내용을 말씀해 주세요.', next: 'ask2' },
    ask2: { id: 'ask2', kind: 'Collect', slot: 'q2', prompt: '더 말씀해 주세요.', next: 'ask3' },
    ask3: { id: 'ask3', kind: 'Collect', slot: 'q3', prompt: '또 말씀해 주세요.', next: 'ask' },
  },
};

function build(tenantId, bridgeOver = {}) {
  const scope = { tenantId };
  const port = BP.createChannelPort({ id: 'callbot' });
  const core = R.createConversationCore({
    scope,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: { tenantId, staleAfterMs: 60000, treatUnknownAsDown: false, legacyIvrAvailable: false, agentQueueAvailable: true },
    health: F.createHealthRegistry([]),
    now: () => NOW,
    newInteractionId: () => `i_${tenantId}`,
  });
  return BR.createBridge({ core, adapter: 'callbot', scope, ...bridgeOver });
}
const line = (o) => JSON.stringify(o);
const start = (bridge, id = 's') => bridge.handleLine(line({ id, op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
const send = (bridge, iid, id) => bridge.handleLine(line({ id, op: 'send', interactionId: iid, turn: { input: { kind: 'utterance', text: '요금 문의' } } }));

test('제한기를 주지 않으면 제한하지 않는다 — 기본 한도를 코드에 두지 않는다(§13-3)', b, async () => {
  const bridge = build('goone');
  const s = await start(bridge);
  assert.equal(s.ok, true);
  for (let i = 0; i < 20; i++) {
    const r = await send(bridge, s.result.interactionId, `t${i}`);
    assert.equal(r.ok, true, `턴 ${i}`);
  }
});

test('한도를 넘긴 send 는 E_RATE_LIMITED 와 계산된 retryAfterMs 로 거절되고 Core 에 닿지 않는다', b, async () => {
  let t = 0;
  const limiter = RL.createRateLimiter({ rule: { burst: 2, refillPerSec: 1 }, clock: () => t });
  const bridge = build('goone', { rateLimiter: limiter });
  const s = await start(bridge);            // start 는 자기 버킷(bridge.start)을 쓴다
  const iid = s.result.interactionId;
  const r1 = await send(bridge, iid, 'a'); assert.equal(r1.ok, true);
  const r2 = await send(bridge, iid, 'b'); assert.equal(r2.ok, true);
  const r3 = await send(bridge, iid, 'c');
  assert.equal(r3.ok, false);
  assert.equal(r3.id, 'c');                 // 거절도 상관 가능해야 한다 — 무응답이 아니다
  assert.equal(r3.error.code, 'E_RATE_LIMITED');
  assert.equal(r3.error.retryAfterMs, 1000);
  assert.match(r3.error.messageKo, /1000ms/);
  assert.equal(bridge.records.at(-1).errorCode, 'E_RATE_LIMITED');
  // 시간이 흐르면 다시 통과하고, 거절된 턴은 Core 상태를 바꾸지 않았다: 턴 증분이 정상 턴 한 번과 같다
  t = 1000;
  const r4 = await send(bridge, iid, 'd');
  assert.equal(r4.ok, true);
  const perTurn = r2.result.state.turnCount - r1.result.state.turnCount;
  assert.ok(perTurn > 0);
  assert.equal(r4.result.state.turnCount - r2.result.state.turnCount, perTurn);
});

test('hello 와 end 는 버킷이 비어도 절대 막히지 않는다 — end 가 막히면 세션이 샌다', b, async () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 0.001 }, clock: () => 0 });
  const bridge = build('goone', { rateLimiter: limiter });
  const s = await start(bridge);
  assert.equal(s.ok, true);
  const iid = s.result.interactionId;
  assert.equal((await send(bridge, iid, 'a')).ok, true);
  assert.equal((await send(bridge, iid, 'b')).error.code, 'E_RATE_LIMITED');
  assert.equal((await start(bridge, 's2')).error.code, 'E_RATE_LIMITED');   // 두 번째 start 도 막힌다
  for (let i = 0; i < 5; i++) assert.equal((await bridge.handleLine(line({ id: `h${i}`, op: 'hello' }))).ok, true);
  const e = await bridge.handleLine(line({ id: 'e', op: 'end', interactionId: iid, reasonKo: '통화 종료' }));
  assert.equal(e.ok, true);
  assert.ok(['ended', 'completed'].includes(e.result.state.status), e.result.state.status);
});

test('한도 키는 테넌트 스코프를 포함한다 — 한 고객사의 폭주가 다른 고객사를 막지 않는다(§11.1)', b, async () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 0.001 }, clock: () => 0 });
  const a = build('tenant_a', { rateLimiter: limiter });
  const c = build('tenant_c', { rateLimiter: limiter });
  assert.equal((await start(a)).ok, true);
  assert.equal((await start(a, 's2')).error.code, 'E_RATE_LIMITED');
  assert.equal((await start(c)).ok, true);   // 같은 제한기, 다른 테넌트 → 영향 없음
  assert.equal(limiter.size, 2);
});

test('op 별 비용: send 를 무겁게 세면 그만큼 빨리 한도에 닿는다', b, async () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 3, refillPerSec: 0.001 }, clock: () => 0 });
  const bridge = build('goone', { rateLimiter: limiter, rateLimitCost: { send: 2 } });
  const s = await start(bridge);
  const iid = s.result.interactionId;
  assert.equal((await send(bridge, iid, 'a')).ok, true);          // 3 → 1
  const r = await send(bridge, iid, 'b');                         // 비용 2 > 잔여 1
  assert.equal(r.error.code, 'E_RATE_LIMITED');
  assert.equal(r.error.retryAfterMs, 1_000_000);                  // 부족분 1 토큰 ÷ 0.001/s = 1000s (계산값 그대로, 추정치 아님)
});

test('설정 거부: 모르는 op 비용·0 이하 비용·제한기 없는 비용', b, () => {
  const limiter = RL.createRateLimiter({ rule: { burst: 1, refillPerSec: 1 } });
  assert.throws(() => build('goone', { rateLimiter: limiter, rateLimitCost: { fly: 1 } }), /모르는 op/);
  assert.throws(() => build('goone', { rateLimiter: limiter, rateLimitCost: { send: 0 } }), /양수/);
  assert.throws(() => build('goone', { rateLimitCost: { send: 1 } }), /rateLimiter/);
});

test('설정 거부: check 가 없는 제한기 — 형태 오류를 제한기 장애처럼 통과시키지 않는다', b, () => {
  // 런타임 장애는 통과가 맞지만(아래 검사), **형태**가 틀린 것까지 통과로 두면
  // 오타 하나로 제한이 조용히 꺼진 채 "적용했다"로 남는다. 둘은 다른 사건이다.
  assert.throws(() => build('goone', { rateLimiter: {} }), /check/);
  assert.throws(() => build('goone', { rateLimiter: { check: 1 } }), /check/);
});

test('제한기 자체가 던지면 잠그지 않고 통과시킨다 — 제한기 장애로 통화가 끊기면 안 된다(§9.3)', b, async () => {
  const broken = { check() { throw new Error('backend down'); }, peek() { throw new Error('x'); }, reset() {}, size: 0 };
  const bridge = build('goone', { rateLimiter: broken });
  const s = await start(bridge);
  assert.equal(s.ok, true);
  assert.equal((await send(bridge, s.result.interactionId, 'a')).ok, true);
});

// ── 실행기 경유(비-Node 호스트 경로) ───────────────────────────────────────
// 제한기를 createBridge 가 받는 것만으로는 Callbot 에 닿지 않는다. 파이썬 에이전트가 쓰는 것은
// CLI 실행기이고, 실행기가 넘기지 않으면 제한은 **아무도 지나가 보지 않은 길**로 남는다.
test('실행기는 Core 모듈이 내놓은 제한기를 브리지에 넘긴다', b, async () => {
  const { spawnSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  // send 에는 start 응답의 interactionId 가 필요해 한 줄씩 주고받아야 하므로,
  // 실행기 전달 여부는 start 버킷(burst 2)으로 확인한다 — 확인하려는 것은 한도 자체가 아니라
  // "모듈이 내놓은 제한기가 브리지까지 갔는가"다.
  const input = ['{"id":"1","op":"hello"}',
    '{"id":"2","op":"start","req":{"flowId":"f_reference_voice","entryPoint":"inbound_call"}}',
    '{"id":"3","op":"start","req":{"flowId":"f_reference_voice","entryPoint":"inbound_call"}}',
    '{"id":"4","op":"start","req":{"flowId":"f_reference_voice","entryPoint":"inbound_call"}}',
    ''].join('\n');
  const run = spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'channel-bridge.mjs'), '--core', './fixtures/reference-core-ratelimited.mjs',
     '--adapter', 'callbot'],
    { cwd: ROOT, input, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out[0].ok, true, 'hello 는 제한 대상이 아니다');
  assert.equal(out[1].ok, true);
  assert.equal(out[2].ok, true);
  assert.equal(out[3].ok, false, '실행기가 제한기를 넘기지 않았다 — 비-Node 호스트에서는 제한이 없다');
  assert.equal(out[3].error.code, 'E_RATE_LIMITED');
  assert.ok(out[3].error.retryAfterMs > 0, '계산된 재시도 대기가 실려 나가야 한다');
});

test('실행기: 제한기를 내놓지 않는 모듈은 종전과 같다(기본 한도 없음, §13-3)', b, async () => {
  const { spawnSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const input = Array.from({ length: 5 }, (_, n) =>
    `{"id":"${n + 1}","op":"start","req":{"flowId":"f_reference_voice","entryPoint":"inbound_call"}}`).join('\n') + '\n';
  const run = spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'channel-bridge.mjs'), '--core', './fixtures/reference-core.mjs', '--adapter', 'callbot'],
    { cwd: ROOT, input, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out.length, 5);
  assert.ok(out.every((r) => r.ok === true), '한도를 주지 않았는데 막혔다');
});
