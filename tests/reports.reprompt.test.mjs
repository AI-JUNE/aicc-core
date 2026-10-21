// §5.1 재시도 실측 — 원장에는 있고 리포트에는 한 번도 도착하지 않았다. 그리고 한 자리에서는
// 원장에도 실리지 않았다.
//
// `turn.completed.retry_count` 는 §8.1 계약에 있고 Runner 가 두 자리(`runTurn`·`knowledgeTurn`)에서
// 채운다. 그런데
//  1) **인텐트 진입 턴에는 없었다.** 미인식으로 한 번 되묻고 나서 확정된 인텐트 턴은 원장에서
//     첫 시도에 확정된 턴과 구분되지 않는다 — 인텐트 구간의 재시도는 언제나 0 으로 보였다.
//  2) **리포트가 그 필드를 읽지 않았다.** `reports/aggregate.ts` 는 턴 수와 미인식 비중까지
//     세면서 재시도는 한 번도 보지 않았다. 그래서 "한 번에 끝난 통화"와 "세 번 되물은 통화"가
//     같은 턴 수로 보이고, 재프롬프트 정책(§5.1)을 켠 뒤 되묻는 횟수가 줄었는지 확인할 실측이
//     Core 밖에 없었다.
//
// 비율은 만들지 않는다(§13-3) — 되물음률의 분모는 정의 문제이고, 근거 없이 고른 분모는 곧
// 대외 수치가 된다. 건수·최댓값·거부 건수만 올린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, T = null, RP = null, EV = null, XR = null, PL = null;
try {
  R = await import('../src/flow/runner.ts');
  T = await import('../src/flow/types.ts');
  RP = await import('../src/reports/aggregate.ts');
  EV = await import('../src/events/schema.ts');
  XR = await import('../src/reports/executeReport.ts');
  PL = await import('../src/events/periodLedger.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-21T00:00:00.000Z';
const SCOPE = { tenantId: 't1' };
const ctx = (over = {}) => ({
  tenantId: 't1', interactionId: 'i1', channel: 'voice', visualAvailable: false, now: () => NOW, ...over,
});

const triage = {
  id: 'triage', version: 1, startNodeId: 'ask',
  nodes: { ask: { id: 'ask', kind: 'Collect', slot: T?.INTENT_SLOT ?? '__intent__', prompt: '무엇을 도와드릴까요?' } },
};
const target = {
  id: 'balance', version: 3, startNodeId: 'say',
  nodes: { say: { id: 'say', kind: 'Say', text: '잔액을 안내합니다.' } },
};

const utter = (text) => ({ kind: 'utterance', text });
const custTurn = (r) => r.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');

/** 미인식으로 한 번 실패한 뒤의 상태 — 인텐트 진입 노드에서 가장 흔한 모양이다. */
function afterOneMiss() {
  const started = R.start(triage, ctx());
  const missed = R.send(triage, started.state, { kind: 'unrecognized', text: '어...' }, ctx());
  assert.equal(missed.state.failCount, 1);
  return missed.state;
}

// ── 1) 원장에 싣는 자리 세 곳이 같아야 한다 (§2) ─────────────────────────────

test('미인식 뒤 확정된 인텐트 턴에 재시도 회차가 실린다 — 첫 시도와 구분된다', b, () => {
  const r = R.switchFlow(target, afterOneMiss(), ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  assert.equal(custTurn(r).retry_count, 1);
});

test('미인식 뒤 상담사로 넘긴 인텐트 턴에도 실린다', b, () => {
  const r = R.handoffFromIntent(afterOneMiss(), ctx(), 'policy', { input: utter('사람 바꿔줘'), intent: 'agent' });
  assert.equal(custTurn(r).retry_count, 1);
});

test('미인식 뒤 되묻는(명확화) 턴에도 실린다 — 명확화는 실패가 아니지만 이력은 남는다', b, () => {
  const step = { kind: 'say', nodeId: '__clarify__', text: '둘 중 어느 것일까요?' };
  const r = R.clarifyTurn(afterOneMiss(), ctx(), step, { input: utter('그거요'), intent: undefined });
  assert.equal(custTurn(r).retry_count, 1);
});

test('첫 시도에 확정되면 회차를 만들어 넣지 않는다 — 0 을 적으면 "재시도 있었다"로 세어진다', b, () => {
  const started = R.start(triage, ctx());
  const r = R.switchFlow(target, started.state, ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  assert.equal('retry_count' in custTurn(r), false);
});

test('회차는 초기화 전에 읽는다 — 갈아타기가 0 으로 되돌려도 그 턴의 사실은 남는다', b, () => {
  const prev = afterOneMiss();
  prev.failCount = 2;
  const r = R.switchFlow(target, prev, ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  assert.equal(custTurn(r).retry_count, 2);
  assert.equal(r.state.failCount, 0);
});

// ── 2) 리포트까지 도착하는가 ─────────────────────────────────────────────────

let n = 0;
function meta(over = {}) {
  n += 1;
  return {
    eventId: over.eventId ?? `e-${n}`,
    occurredAt: over.occurredAt ?? '2026-10-21T10:00:00Z',
    tenantId: 't1',
    interactionId: over.interactionId ?? 'i-1',
    channel: 'voice',
  };
}
const agg = (events) => RP.aggregateReport(events, { scope: SCOPE, granularity: 'day' }).total;

test('봇 되물음과 고객 재응답을 **따로** 센다 — 되묻고 끊긴 통화가 그 차이로 드러난다', b, () => {
  const events = [
    EV.turnCompleted(meta(), { turnId: 't1', speaker: 'customer', utterance: '어...' }),
    EV.turnCompleted(meta(), { turnId: 't2', speaker: 'bot', utterance: '다시 말씀해 주세요.', retryCount: 1 }),
    EV.turnCompleted(meta(), { turnId: 't3', speaker: 'customer', utterance: '잔액', retryCount: 1 }),
    EV.turnCompleted(meta(), { turnId: 't4', speaker: 'bot', utterance: '다시 말씀해 주세요.', retryCount: 2 }),
    // 두 번째 되물음에는 고객이 답하지 않고 끊었다.
  ];
  const r = RP.repromptReport(agg(events));
  assert.equal(r.sent, 2);
  assert.equal(r.customerTurnsAfterRetry, 1);
  assert.equal(r.maxObserved, 2);
  assert.equal(r.rejected, 0);
});

test('재시도가 없는 기간은 0 이고 거부도 0 이다 — 둘을 섞지 않는다', b, () => {
  const events = [EV.turnCompleted(meta(), { turnId: 't1', speaker: 'customer', utterance: '잔액' })];
  const r = RP.repromptReport(agg(events));
  assert.deepEqual([r.sent, r.customerTurnsAfterRetry, r.maxObserved, r.rejected], [0, 0, 0, 0]);
});

test('명시적 0 은 되물음으로 세지 않는다 — 회차 0 은 "재시도 없음"이다', b, () => {
  const events = [EV.turnCompleted(meta(), { turnId: 't1', speaker: 'bot', utterance: '안내', retryCount: 0 })];
  const r = RP.repromptReport(agg(events));
  assert.equal(r.sent, 0);
  assert.equal(r.rejected, 0);
});

test('쓸 수 없는 회차(음수·소수·NaN)는 0 으로도 그대로도 세지 않고 거부로 센다', b, () => {
  const bad = [
    { ...EV.turnCompleted(meta(), { turnId: 't1', speaker: 'bot', utterance: 'x' }), retry_count: -1 },
    { ...EV.turnCompleted(meta(), { turnId: 't2', speaker: 'bot', utterance: 'x' }), retry_count: 1.5 },
    { ...EV.turnCompleted(meta(), { turnId: 't3', speaker: 'bot', utterance: 'x' }), retry_count: Number.NaN },
    { ...EV.turnCompleted(meta(), { turnId: 't4', speaker: 'bot', utterance: 'x' }), retry_count: '2' },
  ];
  const bucket = agg(bad);
  assert.equal(bucket.repromptsSent, 0);
  assert.equal(bucket.maxRetryObserved, 0);        // NaN 이 최댓값 비교를 오염시키지 않는다
  assert.equal(RP.repromptReport(bucket).rejected, 4);
  assert.equal(RP.completeness(bucket).turnsRetryRejected, 4);
});

test('런타임이 아니라 Runner 가 만든 이벤트를 그대로 집계한다 — 두 자리가 실제로 이어진다', b, () => {
  const started = R.start(triage, ctx());
  const missed = R.send(triage, started.state, { kind: 'unrecognized', text: '어...' }, ctx());
  const switched = R.switchFlow(target, missed.state, ctx(), 'say', { input: utter('잔액'), intent: 'balance' });
  const r = RP.repromptReport(agg([...started.events, ...missed.events, ...switched.events]));
  // 봇 재프롬프트 1건 · 그 뒤 고객이 다시 답한 턴 1건.
  assert.equal(r.sent, 1);
  assert.equal(r.customerTurnsAfterRetry, 1);
  assert.equal(r.maxObserved, 1);
});

test('리포트 실행기 결과에 되물음 실태가 미인식률과 함께 실린다(§7 7.6)', b, () => {
  const events = [
    EV.sessionStarted(meta({ occurredAt: '2026-10-21T10:00:00+09:00' }), { entryPoint: 'inbound_call' }),
    EV.turnCompleted(meta({ occurredAt: '2026-10-21T10:00:05+09:00' }), { turnId: 't1', speaker: 'customer', utterance: '어...' }),
    EV.turnCompleted(meta({ occurredAt: '2026-10-21T10:00:06+09:00' }), { turnId: 't2', speaker: 'bot', utterance: '다시 말씀해 주세요.', retryCount: 1 }),
    EV.sessionEnded(meta({ occurredAt: '2026-10-21T10:01:00+09:00' }), { outcome: 'ABANDONED', turnCount: 2, durationMs: 60000 }),
  ];
  const projection = PL.projectLedgerPeriod(events, { scope: SCOPE });
  const run = XR.runReport({ projection, granularity: 'day' });
  assert.equal(run.status, 'reported');
  assert.equal(run.reprompt.sent, 1);
  assert.equal(run.reprompt.customerTurnsAfterRetry, 0);
  assert.equal(run.unrecognized.numerator, 1);        // 인텐트 없는 고객 턴 1건
});

test('쓸 수 없는 회차가 있으면 완전한 표로 제시하지 않는다 — 건수가 작게 적힌 사실을 적는다', b, () => {
  const events = [
    EV.sessionStarted(meta({ occurredAt: '2026-10-21T10:00:00+09:00' }), { entryPoint: 'inbound_call' }),
    { ...EV.turnCompleted(meta({ occurredAt: '2026-10-21T10:00:06+09:00' }), { turnId: 't2', speaker: 'bot', utterance: '다시' }), retry_count: -3 },
  ];
  const projection = PL.projectLedgerPeriod(events, { scope: SCOPE });
  const run = XR.runReport({ projection, granularity: 'day' });
  assert.equal(run.complete, false);
  assert.ok(run.incompletenessKo.some((m) => m.includes('retry_count')), run.incompletenessKo.join(' / '));
});
