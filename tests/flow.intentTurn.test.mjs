// 인텐트 진입 턴 — 판정 결과를 세션 상태와 §8.1 이벤트로 옮기는 자리.
// 여기서 틀리면 증상이 예외가 아니라 **집계의 구멍**(유입 두 배, 사라진 슬롯, 못 본 실패)이라
// 통화는 멀쩡해 보인다. 그래서 이벤트 개수·종류를 직접 센다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, T = null;
try {
  R = await import('../src/flow/runner.ts');
  T = await import('../src/flow/types.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-09-29T00:00:00.000Z';
const ctx = (over = {}) => ({
  tenantId: 't1', interactionId: 'i1', channel: 'voice', visualAvailable: false, now: () => NOW, ...over,
});

/** 인텐트 진입 노드 하나짜리 대표 시나리오(§5.1). */
const triage = {
  id: 'triage', version: 1, startNodeId: 'ask',
  nodes: { ask: { id: 'ask', kind: 'Collect', slot: T?.INTENT_SLOT ?? '__intent__', prompt: '무엇을 도와드릴까요?' } },
};
const target = {
  id: 'balance', version: 3, startNodeId: 'say',
  nodes: {
    say: { id: 'say', kind: 'Say', text: '잔액을 안내합니다.', next: 'ask2' },
    ask2: { id: 'ask2', kind: 'Collect', slot: 'card', prompt: '카드 번호 뒤 4자리를 말씀해 주세요.' },
  },
};

function started() {
  const r = R.start(triage, ctx());
  // 고객 인증 정보처럼 채널이 미리 넣어 둔 슬롯을 하나 얹는다.
  r.state.slots['member_grade'] = 'vip';
  return r.state;
}

const utter = (text) => ({ kind: 'utterance', text });

// ── switchFlow ───────────────────────────────────────────────────────────────

test('시나리오를 갈아타도 session.started 를 다시 내지 않는다(§8.1 유입 집계)', b, () => {
  const r = R.switchFlow(target, started(), ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  assert.equal(r.events.filter((e) => e.type === 'session.started').length, 0);
});

test('이미 모은 슬롯은 유지되고 확정 인텐트가 예약 슬롯에 남는다', b, () => {
  const r = R.switchFlow(target, started(), ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  assert.equal(r.state.slots['member_grade'], 'vip');
  assert.equal(r.state.slots[T.INTENT_SLOT], 'balance');
  assert.equal(r.state.flowId, 'balance');
  assert.equal(r.state.flowVersion, 3);
});

test('실패 이력은 새 시나리오로 넘어가지 않는다 — 첫 질문은 아직 실패한 적이 없다', b, () => {
  const prev = started();
  prev.failCount = 2;
  prev.lastFailureReason = 'no_match';
  prev.lastFallback = 'retry';
  const r = R.switchFlow(target, prev, ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  assert.equal(r.state.failCount, 0);
  assert.equal(r.state.lastFailureReason, undefined);
  assert.equal(r.state.lastFallback, undefined);
  assert.deepEqual(r.state.visited, ['say', 'ask2']);
});

test('고객 발화 이벤트는 갈아타기 **전** 시나리오에 달리고 인텐트를 싣는다', b, () => {
  const r = R.switchFlow(target, started(), ctx(), 'say', { input: utter('잔액'), intent: 'balance', confidence: 0.91 });
  const cust = r.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.equal(cust.flow_id, 'triage');
  assert.equal(cust.node_id, 'ask');
  assert.equal(cust.intent, 'balance');
  assert.equal(cust.confidence, 0.91);
});

test('실측 신뢰도가 없으면 지어내지 않는다(§13-3)', b, () => {
  const r = R.switchFlow(target, started(), ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  const cust = r.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.equal(Object.prototype.hasOwnProperty.call(cust, 'confidence'), false);
});

test('진입 노드부터 새 시나리오가 진행된다', b, () => {
  const r = R.switchFlow(target, started(), ctx(), 'ask2', { input: utter('잔액'), intent: 'balance' });
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['ask2']);
  assert.equal(r.state.currentNodeId, 'ask2');
  assert.equal(r.state.status, 'running');
});

test('고객 발화는 마스킹을 거쳐 이벤트에 남는다(§10.3)', b, () => {
  const r = R.switchFlow(target, started(), ctx(), 'say', { input: utter('제 번호는 010-1234-5678 이에요'), intent: 'balance' });
  const cust = r.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.doesNotMatch(cust.utterance_masked, /010-1234-5678/);
});

test('끝난 세션에는 아무 일도 하지 않는다(멱등, §8.1)', b, () => {
  const prev = started();
  prev.status = 'transferred';
  const r = R.switchFlow(target, prev, ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.steps, []);
});

test('입력 state 를 변형하지 않는다(순수 함수)', b, () => {
  const prev = started();
  R.switchFlow(target, prev, ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  assert.equal(prev.flowId, 'triage');
  assert.equal(prev.slots[T.INTENT_SLOT], undefined);
});

// ── handoffFromIntent ────────────────────────────────────────────────────────

test('상담사 전용 인텐트는 이관 이벤트와 종료를 한 턴에 만든다', b, () => {
  const r = R.handoffFromIntent(started(), ctx(), 'policy', { input: utter('불만 접수'), intent: 'complaint' });
  assert.equal(r.state.status, 'transferred');
  assert.equal(r.state.currentNodeId, null);
  const types = r.events.map((e) => e.type);
  assert.deepEqual(types, ['turn.completed', 'handoff.requested', 'session.ended']);
  assert.equal(r.events[2].outcome, 'TRANSFERRED');
});

test('큐를 정하지 않는다 — 목적지는 §9.3 라우팅이 정한다', b, () => {
  const r = R.handoffFromIntent(started(), ctx(), 'error', { input: utter('x'), intent: 'balance' });
  assert.equal(r.state.handoff.queue, undefined);
  assert.equal(r.events[1].to_queue, undefined);
  assert.equal(r.events[1].reason, 'error');
});

// ── clarifyTurn ──────────────────────────────────────────────────────────────

const clarifyStep = { channel: 'voice', nodeId: '__clarify', kind: 'Choice', text: '1번 잔액, 2번 재발급', acceptDtmf: true };

test('되물어도 노드를 옮기지 않는다 — 다음 답도 같은 노드가 받는다', b, () => {
  const prev = started();
  const r = R.clarifyTurn(prev, ctx(), clarifyStep, { input: utter('그거 있잖아요') });
  assert.equal(r.state.currentNodeId, 'ask');
  assert.deepEqual(r.steps, [clarifyStep]);
});

test('명확화는 실패가 아니다 — 사다리 카운트를 올리지 않는다(§5.1)', b, () => {
  const r = R.clarifyTurn(started(), ctx(), clarifyStep, { input: utter('그거') });
  assert.equal(r.state.failCount, 0);
  assert.equal(r.state.lastFailureReason, undefined);
});

test('고객 발화와 되묻는 말이 각각 한 건씩 남는다(§8.1)', b, () => {
  const prev = started();
  const r = R.clarifyTurn(prev, ctx(), clarifyStep, { input: utter('그거') });
  assert.deepEqual(r.events.map((e) => e.speaker), ['customer', 'bot']);
  assert.equal(r.events[1].utterance_masked, clarifyStep.text);
  assert.equal(r.state.turnCount, prev.turnCount + 2);
});

// ── unrecognized 입력 ────────────────────────────────────────────────────────

test('미인식 발화는 Collect 에 저장되지 않는다 — 이 한 줄이 없으면 엉뚱한 값이 슬롯이 된다', b, () => {
  const prev = started();
  const r = R.send(triage, prev, { kind: 'unrecognized', text: '카드를 잃어버렸어요' }, ctx());
  assert.equal(r.state.slots[T.INTENT_SLOT], undefined);
  assert.equal(r.state.currentNodeId, 'ask');      // 흐름이 넘어가지 않았다
  assert.equal(r.state.failCount, 1);              // §5.1 사다리로 갔다
});

test('미인식은 저신뢰가 아니다 — 원인이 no_match 로 남는다', b, () => {
  const r = R.send(triage, started(), { kind: 'unrecognized', text: '카드를 잃어버렸어요' }, ctx({ minConfidence: 0.8 }));
  assert.equal(r.state.lastFailureReason, 'no_match');
  assert.equal(r.steps[0].reprompt.reason, 'no_match');
});

test('빈 미인식은 무입력으로 분류된다', b, () => {
  const r = R.send(triage, started(), { kind: 'unrecognized', text: '  ' }, ctx());
  assert.equal(r.state.lastFailureReason, 'no_input');
});

test('미인식이 쌓이면 §5.1 사다리가 상담사로 내린다', b, () => {
  let s = started();
  for (let i = 0; i < 3; i++) {
    s = R.send(triage, s, { kind: 'unrecognized', text: '음' }, ctx()).state;
  }
  assert.equal(s.status, 'transferred');
  assert.equal(s.handoff.reason, 'max_retry');
});

test('미인식 발화도 고객 턴으로 남는다 — 무엇을 말했는지 사라지면 원인 분석이 불가능하다', b, () => {
  const r = R.send(triage, started(), { kind: 'unrecognized', text: '카드 분실' }, ctx());
  const cust = r.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.equal(cust.utterance_masked, '카드 분실');
});

test('미인식 입력은 Api 대기 구간을 흔들지 않는다(§6.1)', b, () => {
  const api = {
    id: 'api', version: 1, startNodeId: 'call',
    nodes: { call: { id: 'call', kind: 'Api', connectorId: 'c1' } },
  };
  const s = R.start(api, ctx()).state;
  const r = R.send(api, s, { kind: 'unrecognized', text: '여보세요' }, ctx());
  assert.deepEqual(r.events, []);
  assert.equal(r.state.pendingConnectorId, 'c1');
});
