// 지식 응대 턴 — 답변 결과를 세션 상태와 §8.1 이벤트로 옮기는 자리(§5.2).
// 여기서 틀리면 증상이 예외가 아니라 **집계·요약의 구멍**이다(턴 수가 모자라거나,
// 마스킹 전 질문이 슬롯을 거쳐 이관 요약으로 흘러간다). 통화는 멀쩡해 보인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, T = null;
try {
  R = await import('../src/flow/runner.ts');
  T = await import('../src/flow/types.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-02T00:00:00.000Z';
const ctx = (over = {}) => ({
  tenantId: 't1', interactionId: 'i1', channel: 'voice', visualAvailable: false, now: () => NOW, ...over,
});

const SLOT = T?.KNOWLEDGE_SLOT ?? '__question__';

/** 질문을 받고(지식 진입) 답한 뒤 설문으로 넘어가는 시나리오. */
const faq = {
  id: 'faq', version: 2, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: SLOT, prompt: '무엇이 궁금하신가요?', next: 'survey' },
    survey: { id: 'survey', kind: 'Confirm', prompt: '도움이 되셨나요?' },
  },
};
/** 답한 뒤 갈 곳이 없는 시나리오 — 한 번 답하고 끝낸다. */
const oneShot = {
  id: 'faq1', version: 1, startNodeId: 'ask',
  nodes: { ask: { id: 'ask', kind: 'Collect', slot: SLOT, prompt: '무엇이 궁금하신가요?' } },
};

const answerStep = () => ({
  channel: 'voice', nodeId: '__answer', kind: 'Say', text: '수수료는 면제입니다 [1].',
  citations: [{ marker: 1, title: '수수료 안내' }],
});

function started(flow = faq) {
  const r = R.start(flow, ctx());
  r.state.slots['member_grade'] = 'vip';
  return r.state;
}

const turn = (over = {}) => ({
  input: { kind: 'utterance', text: '제 번호 010-1234-5678 수수료가 얼마예요?' },
  questionMasked: '제 번호 010-****-**** 수수료가 얼마예요?',
  ...over,
});

test('답변 단계가 나가고 시나리오는 다음 노드로 넘어간다(§5.2)', b, () => {
  const r = R.knowledgeTurn(faq, started(), ctx(), answerStep(), turn());
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['__answer', 'survey']);
  assert.equal(r.state.currentNodeId, 'survey');
  assert.equal(r.state.status, 'running');
  assert.equal(r.state.slots['member_grade'], 'vip');
});

test('세션 슬롯에는 마스킹된 질문만 남는다 — 원문은 이관 요약으로 흘러가지 않는다(§10.3)', b, () => {
  const r = R.knowledgeTurn(faq, started(), ctx(), answerStep(), turn());
  assert.equal(r.state.slots[SLOT], '제 번호 010-****-**** 수수료가 얼마예요?');
  assert.equal(JSON.stringify(r.state.slots).includes('010-1234-5678'), false);
});

test('고객 발화와 봇 답변이 각각 한 턴으로 집계된다(§8.1)', b, () => {
  const r = R.knowledgeTurn(faq, started(), ctx(), answerStep(), turn());
  const turns = r.events.filter((e) => e.type === 'turn.completed');
  assert.deepEqual(turns.map((e) => e.speaker), ['customer', 'bot', 'bot']);
  // 고객 발화 이벤트의 발화문은 이벤트 쪽에서 마스킹된다 — 원문이 그대로 남지 않는다.
  assert.equal(turns[0].utterance_masked.includes('010-1234-5678'), false);
  assert.equal(turns[0].pii_masked, true);
  assert.equal(turns[1].utterance_masked, '수수료는 면제입니다 [1].');
  assert.equal(turns[1].node_id, '__answer');
  // 시작 시 질문 단계(봇)가 1턴이었으므로 이 턴 뒤로 4턴이다 — 답변 단계를 턴으로 빠뜨리지 않는다.
  assert.equal(r.state.turnCount, 4);
});

test('답한 턴은 실패 이력을 지운다 — 다음 실패가 사다리 두 칸째로 떨어지지 않는다(§5.1)', b, () => {
  const prev = started();
  prev.failCount = 2;
  prev.lastFailureReason = 'no_match';
  prev.lastFallback = 'retry';
  const r = R.knowledgeTurn(faq, prev, ctx(), answerStep(), turn());
  assert.equal(r.state.failCount, 0);
  assert.equal(r.state.lastFailureReason, undefined);
  assert.equal(r.state.lastFallback, undefined);
  // 직전 실패 회차는 **고객 발화 이벤트에** 남는다(그 턴은 실제로 재시도였다).
  assert.equal(r.events.find((e) => e.type === 'turn.completed').retry_count, 2);
});

test('입력 state 를 변형하지 않는다(순수 함수)', b, () => {
  const prev = started();
  const snapshot = JSON.stringify(prev);
  R.knowledgeTurn(faq, prev, ctx(), answerStep(), turn());
  assert.equal(JSON.stringify(prev), snapshot);
});

test('다음 노드가 없으면 답하고 자연 종료한다 — 답변은 반드시 나간 뒤다', b, () => {
  const r = R.knowledgeTurn(oneShot, started(oneShot), ctx(), answerStep(), turn());
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['__answer']);
  assert.equal(r.state.status, 'completed');
  assert.equal(r.events.filter((e) => e.type === 'session.ended').length, 1);
});

test('이미 끝난 세션에는 아무것도 하지 않는다(멱등, §8.1)', b, () => {
  const prev = started();
  prev.status = 'transferred';
  const r = R.knowledgeTurn(faq, prev, ctx(), answerStep(), turn());
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.events, []);
  assert.equal(r.state.slots[SLOT], undefined);
});

test('현재 노드가 사라진 상태는 답변으로 덮지 않는다 — 실패로 끝낸다', b, () => {
  const prev = started();
  prev.currentNodeId = 'gone';
  const r = R.knowledgeTurn(faq, prev, ctx(), answerStep(), turn());
  assert.equal(r.state.status, 'failed');
  assert.match(r.state.error, /정의되지 않은 노드/);
  assert.deepEqual(r.steps, []);
});

test('지식 진입 노드 판정은 한 곳에만 있다', b, () => {
  assert.equal(T.isKnowledgeEntryNode(faq.nodes.ask), true);
  assert.equal(T.isKnowledgeEntryNode(faq.nodes.survey), false);
  assert.equal(T.isKnowledgeEntryNode({ id: 'x', kind: 'Collect', slot: 'name', prompt: 'p' }), false);
  assert.equal(T.isKnowledgeEntryNode(undefined), false);
  // 인텐트 진입 노드와 섞이지 않는다 — 두 예약 슬롯은 서로 다른 배선을 켠다.
  assert.equal(T.isKnowledgeEntryNode({ id: 'x', kind: 'Collect', slot: T.INTENT_SLOT, prompt: 'p' }), false);
  assert.equal(T.isIntentEntryNode(faq.nodes.ask), false);
});
