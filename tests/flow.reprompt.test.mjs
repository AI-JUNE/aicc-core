// 재프롬프트 정책 — §5.1(폴백 사다리)·§13-3(기본값 금지).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, runner = null;
try {
  R = await import('../src/flow/reprompt.ts');
  runner = await import('../src/flow/runner.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

// ── classifyFailure ─────────────────────────────────────────────────────────
test('타임아웃은 무입력이다', b, () => {
  assert.equal(R.classifyFailure({ kind: 'timeout' }), 'no_input');
});

test('빈 발화·공백만 있는 발화도 무입력이다 — 저신뢰로 적으면 침묵한 사람에게 되묻게 된다', b, () => {
  assert.equal(R.classifyFailure({ kind: 'utterance', text: '' }), 'no_input');
  assert.equal(R.classifyFailure({ kind: 'utterance', text: '   ' }, 0.9), 'no_input');
  assert.equal(R.classifyFailure({ kind: 'dtmf', text: '' }), 'no_input');
});

test('임계값을 주지 않으면 신뢰도로 판정하지 않는다(§13-3)', b, () => {
  assert.equal(R.classifyFailure({ kind: 'utterance', text: '카드', confidence: 0.01 }), 'no_match');
});

test('임계값 미만 발화만 저신뢰다 — 경계값은 통과로 본다', b, () => {
  assert.equal(R.classifyFailure({ kind: 'utterance', text: '카드', confidence: 0.4 }, 0.6), 'low_confidence');
  assert.equal(R.classifyFailure({ kind: 'utterance', text: '카드', confidence: 0.6 }, 0.6), 'no_match');
});

test('DTMF 는 신뢰도 개념이 없으므로 저신뢰가 되지 않는다', b, () => {
  assert.equal(R.classifyFailure({ kind: 'dtmf', text: '9', confidence: 0.1 }, 0.9), 'no_match');
});

test('어댑터가 신뢰도를 실측하지 않았으면 저신뢰로 몰지 않는다', b, () => {
  assert.equal(R.classifyFailure({ kind: 'utterance', text: '카드' }, 0.9), 'no_match');
});

// ── buildReprompt ───────────────────────────────────────────────────────────
const policy = {
  byReason: {
    no_input: [{ text: '잘 안 들리셨나요? 다시 말씀해 주세요.' }, { text: '들리시면 아무 번호나 눌러주세요.', offerDtmf: true }],
    no_match: [{ text: '보기 중에서 골라주세요.' }],
  },
  sharedLines: [{ text: '다시 한 번 부탁드립니다.' }],
};

test('정책이 없으면 아무것도 만들지 않는다 — Core 는 문안을 지어내지 않는다(§13-3)', b, () => {
  assert.equal(R.buildReprompt(undefined, 'no_input', 1, 'voice'), undefined);
});

test('원인별 사다리를 시도 회차대로 고른다', b, () => {
  assert.equal(R.buildReprompt(policy, 'no_input', 1, 'voice').text, '잘 안 들리셨나요? 다시 말씀해 주세요.');
  assert.equal(R.buildReprompt(policy, 'no_input', 2, 'voice').text, '들리시면 아무 번호나 눌러주세요.');
});

test('원인별 선언이 없으면 공통 사다리로 내려간다', b, () => {
  const p = R.buildReprompt(policy, 'low_confidence', 1, 'chat');
  assert.equal(p.source, 'shared');
  assert.equal(p.text, '다시 한 번 부탁드립니다.');
});

test('원인별·공통 어느 쪽도 없으면 undefined — Runner 가 원문을 재생한다', b, () => {
  assert.equal(R.buildReprompt({ byReason: { no_input: [] } }, 'no_input', 1, 'voice'), undefined);
  assert.equal(R.buildReprompt({}, 'no_match', 1, 'voice'), undefined);
});

test('사다리를 다 쓰면 마지막을 반복하되 exhausted 로 드러낸다 — 조용히 반복하면 잘못된 설정이 안 보인다', b, () => {
  const p1 = R.buildReprompt(policy, 'no_match', 1, 'voice');
  const p3 = R.buildReprompt(policy, 'no_match', 3, 'voice');
  assert.equal(p1.exhausted, false);
  assert.equal(p3.exhausted, true);
  assert.equal(p3.text, p1.text);
});

test('DTMF 안내는 음성 채널에서만 켜진다 — 화면으로 전환된 뒤 번호를 누르라고 하면 안 된다', b, () => {
  assert.equal(R.buildReprompt(policy, 'no_input', 2, 'voice').acceptDtmf, true);
  assert.equal(R.buildReprompt(policy, 'no_input', 2, 'visual').acceptDtmf, false);
  assert.equal(R.buildReprompt(policy, 'no_input', 1, 'voice').acceptDtmf, false);
});

test('잘못된 시도 회차는 문장을 지어내지 않는다', b, () => {
  for (const n of [0, -1, 1.5, Number.NaN]) {
    assert.equal(R.buildReprompt(policy, 'no_input', n, 'voice'), undefined, `attempt=${n}`);
  }
});

// ── validateRepromptPolicy ──────────────────────────────────────────────────
test('빈 대본은 오류다 — 재프롬프트 자리의 무음은 장애와 구분되지 않는다', b, () => {
  const issues = R.validateRepromptPolicy({ byReason: { no_input: [{ text: '  ' }] } });
  assert.equal(R.repromptPolicyOk(issues), false);
  assert.ok(issues.some((i) => i.path === 'byReason.no_input[0]'));
});

test('알 수 없는 원인 키는 조용히 무시하지 않고 오류로 드러낸다', b, () => {
  const issues = R.validateRepromptPolicy({ byReason: { no_inupt: [{ text: '다시요' }] } });
  assert.equal(R.repromptPolicyOk(issues), false);
});

test('배열이 아닌 값·객체가 아닌 항목은 오류다', b, () => {
  assert.equal(R.repromptPolicyOk(R.validateRepromptPolicy({ sharedLines: '다시요' })), false);
  assert.equal(R.repromptPolicyOk(R.validateRepromptPolicy({ sharedLines: [null] })), false);
});

test('빈 선언·미선언은 경고이지 오류가 아니다(정책 없이도 동작해야 한다)', b, () => {
  const empty = R.validateRepromptPolicy({});
  assert.equal(R.repromptPolicyOk(empty), true);
  assert.ok(empty.some((i) => i.severity === 'warning'));
  const emptyList = R.validateRepromptPolicy({ sharedLines: [] });
  assert.equal(R.repromptPolicyOk(emptyList), true);
});

test('정상 정책은 오류·경고가 없다', b, () => {
  assert.deepEqual(R.validateRepromptPolicy(policy), []);
});

// ── Runner 배선 ─────────────────────────────────────────────────────────────
const flow = {
  id: 'f_rp', version: 1, startNodeId: 'ask',
  nodes: {
    ask:  { id: 'ask',  kind: 'Collect', slot: 'phone', prompt: '연락처를 말씀해 주세요.', next: 'done' },
    done: { id: 'done', kind: 'Say', text: '확인했습니다.' },
  },
};
const ctx = (extra = {}) => ({
  tenantId: 't1', interactionId: 'i1', channel: 'voice', visualAvailable: false,
  now: () => '2026-09-08T00:00:00.000Z', ...extra,
});

test('정책이 없으면 종전대로 원문을 재생한다 — 기존 동작이 사라지지 않는다', b, () => {
  const c = ctx();
  const s = runner.start(flow, c).state;
  const r = runner.send(flow, s, { kind: 'timeout' }, c);
  const bot = r.steps[r.steps.length - 1];
  assert.equal(bot.text, '연락처를 말씀해 주세요.');
  assert.deepEqual(bot.reprompt, { reason: 'no_input', attempt: 1, exhausted: false });
});

test('정책이 있으면 원인에 맞는 문장으로 바뀌고 원인이 상태·슬롯에 남는다', b, () => {
  const c = ctx({ reprompt: policy });
  const s = runner.start(flow, c).state;
  const r1 = runner.send(flow, s, { kind: 'timeout' }, c);
  assert.equal(r1.steps.at(-1).text, '잘 안 들리셨나요? 다시 말씀해 주세요.');
  assert.equal(r1.state.lastFailureReason, 'no_input');
  assert.equal(r1.state.slots['__last_failure_reason__'], 'no_input');
});

test('음성에서 DTMF 를 선언한 시도는 재프롬프트에 DTMF 수용이 켜진다(§5.1)', b, () => {
  const dtmfFirst = { byReason: { no_input: [{ text: '들리시면 1번을 눌러주세요.', offerDtmf: true }] } };
  const c = ctx({ reprompt: dtmfFirst });
  const s = runner.start(flow, c).state;
  const r = runner.send(flow, s, { kind: 'timeout' }, c);
  assert.equal(r.steps.at(-1).text, '들리시면 1번을 눌러주세요.');
  assert.equal(r.steps.at(-1).acceptDtmf, true);
});

test('2회차는 §5.1 사다리대로 화면 전환·이관으로 넘어간다 — 재프롬프트가 사다리를 늦추지 않는다', b, () => {
  const c = ctx({ reprompt: policy });
  const r1 = runner.send(flow, runner.start(flow, c).state, { kind: 'timeout' }, c);
  const r2 = runner.send(flow, r1.state, { kind: 'timeout' }, c);
  assert.equal(r2.state.status, 'transferred');   // 화면이 없는 음성 세션
  assert.deepEqual(r2.steps, []);
});

test('저신뢰 발화는 무입력과 다른 문장으로 간다', b, () => {
  const c = ctx({ reprompt: policy, minConfidence: 0.7 });
  const s = runner.start(flow, c).state;
  const r = runner.send(flow, s, { kind: 'utterance', text: '어어', confidence: 0.2 }, c);
  assert.equal(r.state.lastFailureReason, 'low_confidence');
  assert.equal(r.steps.at(-1).text, '다시 한 번 부탁드립니다.');
});

test('성공하면 실패 원인이 지워진다 — 남겨두면 이관 요약이 지난 실패를 말한다', b, () => {
  const c = ctx({ reprompt: policy });
  const s = runner.start(flow, c).state;
  const bad = runner.send(flow, s, { kind: 'timeout' }, c);
  assert.equal(bad.state.lastFailureReason, 'no_input');
  const ok = runner.send(flow, bad.state, { kind: 'utterance', text: '01012345678' }, c);
  assert.equal(ok.state.lastFailureReason, undefined);
});

test('입력 state 는 변형되지 않는다', b, () => {
  const c = ctx({ reprompt: policy });
  const s = runner.start(flow, c).state;
  runner.send(flow, s, { kind: 'timeout' }, c);
  assert.equal(s.lastFailureReason, undefined);
  assert.equal(s.slots['__last_failure_reason__'], undefined);
});

test('화면으로 전환되면 DTMF 안내를 켜지 않는다(§5.2)', b, () => {
  const c = ctx({ reprompt: policy, visualAvailable: true });
  let s = runner.start(flow, c).state;
  const r1 = runner.send(flow, s, { kind: 'timeout' }, c);
  const r2 = runner.send(flow, r1.state, { kind: 'timeout' }, c);
  assert.equal(r2.state.channel, 'visual');
  assert.notEqual(r2.steps.at(-1).acceptDtmf, true);
});
