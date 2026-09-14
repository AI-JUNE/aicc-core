// 턴 타이밍 정책 — §5.1(폴백 사다리)·§5.3(단일 시나리오)·§13-3(임의 수치 금지).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let T = null, runner = null;
try {
  T = await import('../src/flow/timing.ts');
  runner = await import('../src/flow/runner.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: T ? false : '타입 스트리핑 미지원 런타임' };

const policy = {
  inputTimeoutMsByKind: { Collect: 5000, Choice: 4000 },
  extraMsByAttempt: [0, 3000],
  maxInputTimeoutMs: 9000,
  bargeInByKind: { Collect: false, Choice: true },
};

// ── resolveTurnTiming ───────────────────────────────────────────────────────
test('정책이 없으면 어떤 값도 만들지 않는다 — 채널이 종전 값을 쓴다(§13-3)', b, () => {
  assert.deepEqual(T.resolveTurnTiming(undefined, { kind: 'Collect', attempt: 1, channel: 'voice' }), {});
});

test('선언된 노드 종류에만 대기 시간이 실린다', b, () => {
  assert.equal(T.resolveTurnTiming(policy, { kind: 'Collect', attempt: 1, channel: 'voice' }).inputTimeoutMs, 5000);
  assert.equal(T.resolveTurnTiming(policy, { kind: 'Confirm', attempt: 1, channel: 'voice' }).inputTimeoutMs, undefined);
});

test('입력을 기다리지 않는 노드에는 아무것도 실리지 않는다', b, () => {
  for (const kind of ['Say', 'Transfer', 'Api']) {
    assert.deepEqual(T.resolveTurnTiming(policy, { kind, attempt: 1, channel: 'voice' }), {}, kind);
  }
});

test('재시도 회차에 가산이 붙는다 — 첫 실패의 흔한 원인이 "말을 시작하기 전에 끊김"이다(§5.1)', b, () => {
  assert.equal(T.resolveTurnTiming(policy, { kind: 'Collect', attempt: 2, channel: 'voice' }).inputTimeoutMs, 8000);
});

test('선언된 회차를 넘으면 마지막 가산을 유지한다', b, () => {
  assert.equal(T.resolveTurnTiming(policy, { kind: 'Collect', attempt: 5, channel: 'voice' }).inputTimeoutMs, 8000);
});

test('상한을 넘지 않는다', b, () => {
  const capped = { ...policy, maxInputTimeoutMs: 6000 };
  assert.equal(T.resolveTurnTiming(capped, { kind: 'Collect', attempt: 2, channel: 'voice' }).inputTimeoutMs, 6000);
});

test('잘못된 회차는 가산을 적용하지 않는다 — 잘못된 대기가 조용히 통화에 나가면 안 된다', b, () => {
  for (const n of [0, -1, 1.5, Number.NaN]) {
    assert.equal(T.resolveTurnTiming(policy, { kind: 'Collect', attempt: n, channel: 'voice' }).inputTimeoutMs, 5000, `attempt=${n}`);
  }
});

test('끼어들기는 음성에만 실린다 — 화면 채널로 보내면 채널마다 제각기 해석한다', b, () => {
  assert.equal(T.resolveTurnTiming(policy, { kind: 'Choice', attempt: 1, channel: 'voice' }).bargeIn, true);
  assert.equal(T.resolveTurnTiming(policy, { kind: 'Collect', attempt: 1, channel: 'voice' }).bargeIn, false);
  assert.equal('bargeIn' in T.resolveTurnTiming(policy, { kind: 'Choice', attempt: 1, channel: 'visual' }), false);
});

test('대기 시간만 선언해도 동작한다(부분 선언)', b, () => {
  const only = { inputTimeoutMsByKind: { Confirm: 3000 } };
  assert.deepEqual(T.resolveTurnTiming(only, { kind: 'Confirm', attempt: 1, channel: 'chat' }), { inputTimeoutMs: 3000 });
});

// ── validateTurnTimingPolicy ────────────────────────────────────────────────
test('정상 정책은 오류·경고가 없다', b, () => {
  assert.deepEqual(T.validateTurnTimingPolicy(policy), []);
});

test('0·음수·NaN 대기는 오류다 — 0ms 는 모든 턴을 즉시 무입력으로 떨어뜨린다', b, () => {
  for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5000']) {
    const issues = T.validateTurnTimingPolicy({ inputTimeoutMsByKind: { Collect: v } });
    assert.equal(T.turnTimingPolicyOk(issues), false, String(v));
  }
});

test('입력을 기다리지 않는 노드 선언은 오류다 — 적용되지 않는 선언은 오해를 부른다', b, () => {
  assert.equal(T.turnTimingPolicyOk(T.validateTurnTimingPolicy({ inputTimeoutMsByKind: { Say: 3000 } })), false);
  assert.equal(T.turnTimingPolicyOk(T.validateTurnTimingPolicy({ bargeInByKind: { Transfer: true } })), false);
});

test('가산은 0 을 허용하되 음수·비수치는 거부한다', b, () => {
  assert.equal(T.turnTimingPolicyOk(T.validateTurnTimingPolicy({ inputTimeoutMsByKind: { Collect: 5000 }, extraMsByAttempt: [0, 1000] })), true);
  assert.equal(T.turnTimingPolicyOk(T.validateTurnTimingPolicy({ extraMsByAttempt: [-1] })), false);
  assert.equal(T.turnTimingPolicyOk(T.validateTurnTimingPolicy({ extraMsByAttempt: 'x' })), false);
});

test('끼어들기 값이 boolean 이 아니면 오류다', b, () => {
  assert.equal(T.turnTimingPolicyOk(T.validateTurnTimingPolicy({ bargeInByKind: { Collect: 'yes' } })), false);
});

test('상한이 선언 대기보다 짧으면 경고로 드러낸다(거부는 아니다)', b, () => {
  const issues = T.validateTurnTimingPolicy({ inputTimeoutMsByKind: { Collect: 8000 }, maxInputTimeoutMs: 3000 });
  assert.equal(T.turnTimingPolicyOk(issues), true);
  assert.ok(issues.some((i) => i.severity === 'warning' && i.path === 'maxInputTimeoutMs'));
});

test('아무것도 선언하지 않으면 경고이지 오류가 아니다', b, () => {
  const issues = T.validateTurnTimingPolicy({});
  assert.equal(T.turnTimingPolicyOk(issues), true);
  assert.ok(issues.some((i) => i.severity === 'warning'));
});

// ── Runner 배선 ─────────────────────────────────────────────────────────────
const flow = {
  id: 'f_tm', version: 1, startNodeId: 'hi',
  nodes: {
    hi: { id: 'hi', kind: 'Say', text: '안녕하세요.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'phone', prompt: '연락처를 말씀해 주세요.', next: 'done' },
    done: { id: 'done', kind: 'Say', text: '확인했습니다.' },
  },
};
const ctx = (extra = {}) => ({
  tenantId: 't1', interactionId: 'i1', channel: 'voice', visualAvailable: false,
  now: () => '2026-09-14T00:00:00.000Z', ...extra,
});

test('정책이 없으면 단계에 대기 값이 붙지 않는다', b, () => {
  const r = runner.start(flow, ctx());
  const ask = r.steps.find((s) => s.nodeId === 'ask');
  assert.equal('inputTimeoutMs' in ask, false);
  assert.equal('bargeIn' in ask, false);
});

test('첫 제시에는 회차 1 기준 값이, 재시도에는 회차 2 기준 값이 붙는다', b, () => {
  const c = ctx({ timing: policy });
  const r1 = runner.start(flow, c);
  const ask = r1.steps.find((s) => s.nodeId === 'ask');
  assert.equal(ask.inputTimeoutMs, 5000);
  assert.equal(ask.bargeIn, false);

  const r2 = runner.send(flow, r1.state, { kind: 'timeout' }, c);
  assert.equal(r2.steps.at(-1).inputTimeoutMs, 8000);
});

test('발화 단계(Say)에는 대기 값이 붙지 않는다', b, () => {
  const r = runner.start(flow, ctx({ timing: policy }));
  const hi = r.steps.find((s) => s.nodeId === 'hi');
  assert.equal('inputTimeoutMs' in hi, false);
});

test('화면으로 전환되면 끼어들기 값을 싣지 않는다(§5.2)', b, () => {
  const c = ctx({ timing: { ...policy, bargeInByKind: { Collect: true } }, visualAvailable: true });
  const r1 = runner.start(flow, c);
  const r2 = runner.send(flow, r1.state, { kind: 'timeout' }, c);
  const r3 = runner.send(flow, r2.state, { kind: 'timeout' }, c);
  assert.equal(r3.state.channel, 'visual');
  assert.equal('bargeIn' in r3.steps.at(-1), false);
});
