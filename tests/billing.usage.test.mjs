import { test } from 'node:test';
import assert from 'node:assert/strict';

let bl = null, ev = null;
try {
  bl = await import('../src/billing/usage.ts');
  ev = await import('../src/events/schema.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: bl ? false : '타입 스트리핑 미지원 런타임' };

const rounding = { unitSeconds: 60, mode: 'ceil', minimumUnits: 1 };
const meta = (id, over = {}) => ({
  eventId: id, occurredAt: '2026-01-05T09:00:00.000Z',
  tenantId: 't1', interactionId: 'i1', channel: 'voice', ...over,
});

test('§11.2 통화 시간은 billable_ms만 신뢰하고, 없으면 추정하지 않는다', b, () => {
  const events = [
    ev.sessionEnded(meta('e1'), { outcome: 'AUTO_RESOLVED', turnCount: 2, durationMs: 300000, billableMs: 65000 }),
    ev.sessionEnded(meta('e2', { interactionId: 'i2' }), { outcome: 'TRANSFERRED', turnCount: 1, durationMs: 120000 }),
  ];
  const agg = bl.aggregateUsage(events, { scope: { tenantId: 't1' }, granularity: 'month', rounding });
  const t = bl.totalQuantities(agg);
  assert.equal(t.sessions, 2);
  assert.equal(t.voice_seconds, 65);
  assert.equal(t.voice_units, 2);                        // 65초 → 분 단위 올림 = 2
  assert.equal(agg.buckets[0].sessionsMissingBillableMs, 1);
});

test('§5.2 음성이 아닌 채널로 끝난 통화의 실측은 통화 분에 넣지 않되 버리지도 않는다', b, () => {
  // 통화 중 화면으로 전환되면 session.ended.channel 이 visual 이 된다. 자동으로 통화 시간에
  // 넣으면 잘못 선언된 채팅 세션까지 통화로 청구되고(과다청구), 조용히 버리면 매출이 사라진다.
  const switched = ev.sessionEnded(meta('e1', { channel: 'visual' }), { outcome: 'AUTO_RESOLVED', turnCount: 3, billableMs: 90000 });
  const agg = bl.aggregateUsage([switched], { scope: { tenantId: 't1' }, granularity: 'total', rounding });
  assert.equal(bl.totalQuantities(agg).voice_seconds, 0);
  assert.equal(agg.buckets[0].sessionsBillableMsOnNonVoice, 1);
  assert.equal(agg.buckets[0].sessionsMissingBillableMs, 0);   // 누락이 아니다 — 실측은 있었다
});

test('§11.2 실측으로 볼 수 없는 통화 구간은 통화 시간으로 세지 않는다', b, () => {
  const broken = ev.sessionEnded(meta('e1'), { outcome: 'AUTO_RESOLVED', turnCount: 1, billableMs: Number.NaN });
  const agg = bl.aggregateUsage([broken], { scope: { tenantId: 't1' }, granularity: 'total', rounding });
  assert.equal(bl.totalQuantities(agg).voice_seconds, 0);
  assert.equal(agg.buckets[0].sessionsMissingBillableMs, 1);
});

test('§11.2 쓸 수 없는 사용량 값은 0 으로도 그대로도 집계하지 않고 건수로 남긴다', b, () => {
  const t = ev.turnCompleted(meta('e1'), {
    turnId: 't1', speaker: 'customer', utterance: '네',
    usage: { llm_prompt_tokens: Number.NaN, llm_completion_tokens: 30 },
  });
  const agg = bl.aggregateUsage([t], { scope: { tenantId: 't1' }, granularity: 'total', rounding });
  const q = bl.totalQuantities(agg);
  assert.equal(q.llm_prompt_tokens, 0);
  assert.equal(q.llm_completion_tokens, 30);             // 멀쩡한 항목은 그대로 센다
  assert.equal(agg.buckets[0].usageValuesRejected, 1);
  assert.equal(agg.buckets[0].turnsMissingUsage, 0);     // 실측이 아예 없는 것과 구분한다
});

test('§8.1 중복 이벤트는 이중 과금되지 않는다', b, () => {
  const e = ev.sessionEnded(meta('e1'), { outcome: 'AUTO_RESOLVED', turnCount: 1, billableMs: 60000 });
  const agg = bl.aggregateUsage([e, e, e], { scope: { tenantId: 't1' }, granularity: 'total', rounding });
  assert.equal(agg.duplicatesDropped, 2);
  assert.equal(bl.totalQuantities(agg).sessions, 1);
});

test('§11.1 다른 테넌트 이벤트는 집계에서 제외된다', b, () => {
  const mine = ev.sessionEnded(meta('e1'), { outcome: 'AUTO_RESOLVED', turnCount: 1, billableMs: 60000 });
  const other = ev.sessionEnded(meta('e9', { tenantId: 't2' }), { outcome: 'AUTO_RESOLVED', turnCount: 1, billableMs: 600000 });
  const agg = bl.aggregateUsage([mine, other], { scope: { tenantId: 't1' }, granularity: 'total', rounding });
  assert.equal(agg.foreignTenantDropped, 1);
  assert.equal(bl.totalQuantities(agg).voice_seconds, 60);
});

test('§11.2 토큰·STT·TTS 사용량은 turn.completed 실측에서만 집계된다', b, () => {
  const withUsage = ev.turnCompleted(meta('e1'), {
    turnId: 't1', speaker: 'bot', utterance: '안내드립니다',
    usage: { llm_prompt_tokens: 120, llm_completion_tokens: 30, stt_audio_ms: 2000, tts_audio_ms: 3000 },
  });
  const without = ev.turnCompleted(meta('e2'), { turnId: 't2', speaker: 'customer', utterance: '네' });
  const agg = bl.aggregateUsage([withUsage, without], { scope: { tenantId: 't1' }, granularity: 'total', rounding });
  const t = bl.totalQuantities(agg);
  assert.equal(t.llm_prompt_tokens, 120);
  assert.equal(t.llm_completion_tokens, 30);
  assert.equal(t.stt_seconds, 2);
  assert.equal(t.tts_seconds, 3);
  assert.equal(agg.buckets[0].turnsMissingUsage, 1);
});

test('§11.2 반올림 규칙은 주입된 계약 값을 따른다', b, () => {
  assert.equal(bl.applyRounding(61, { unitSeconds: 60, mode: 'ceil', minimumUnits: 0 }), 2);
  assert.equal(bl.applyRounding(61, { unitSeconds: 60, mode: 'floor', minimumUnits: 0 }), 1);
  assert.equal(bl.applyRounding(5, { unitSeconds: 60, mode: 'floor', minimumUnits: 1 }), 1);
  assert.equal(bl.applyRounding(0, { unitSeconds: 60, mode: 'ceil', minimumUnits: 1 }), 0);
});

test('§11.2 대사: 허용 오차 안이면 matched, 벗어나면 mismatch', b, () => {
  const agg = bl.aggregateUsage(
    [ev.sessionEnded(meta('e1'), { outcome: 'AUTO_RESOLVED', turnCount: 1, billableMs: 120000 })],
    { scope: { tenantId: 't1' }, granularity: 'month', rounding },
  );
  const bucket = agg.buckets[0].bucket;
  const ok = bl.reconcile(agg, [{ source: 'carrier_cdr', bucket, channel: 'voice', quantities: { voice_seconds: 120 } }],
    { absolute: 0, relative: 0 });
  assert.equal(ok.lines[0].status, 'matched');
  const ng = bl.reconcile(agg, [{ source: 'carrier_cdr', bucket, channel: 'voice', quantities: { voice_seconds: 200 } }],
    { absolute: 1, relative: 0.01 });
  assert.equal(ng.lines[0].status, 'mismatch');
  assert.equal(ng.lines[0].diffs[0].diff, -80);
  assert.equal(ng.mismatchCount, 1);
});

// ── §5.2 임베딩 토큰(§11.2) ──────────────────────────────────────────────────
// 칸이 없던 동안 RAG 색인·질의의 임베딩 비용은 공급사 청구서에만 남고 원장에는 0줄이었다.
// 방향이 과소청구라 과다청구 차단에도 걸리지 않아, 대사에서 '미설명'으로만 돌아왔다.

test('§11.2 임베딩 토큰이 집계되고 공급사 리포트와 대사된다', b, () => {
  const t1 = ev.turnCompleted(meta('e1'), {
    turnId: 'tn1', speaker: 'customer', utterance: '잔액 알려줘',
    usage: { embedding_tokens: 14, llm_prompt_tokens: 200 },
  });
  const t2 = ev.turnCompleted(meta('e2'), {
    turnId: 'tn2', speaker: 'customer', utterance: '카드 재발급',
    usage: { embedding_tokens: 11 },
  });
  const agg = bl.aggregateUsage([t1, t2], { scope: { tenantId: 't1' }, granularity: 'total', rounding });
  const q = bl.totalQuantities(agg);
  assert.equal(q.embedding_tokens, 25);
  // LLM 칸과 섞이지 않는다 — 단가도 공급사 리포트도 따로다.
  assert.equal(q.llm_prompt_tokens, 200);
  // 공급사가 따로 내놓는 임베딩 리포트가 이제 **비교 대상을 갖는다**. 칸이 없던 동안
  // 이 명세는 `reconcile` 에서 core=undefined 와 만나 비교 자체가 성립하지 않았다.
  const r = bl.reconcile(
    agg,
    [{ source: 'llm_vendor_report', bucket: 'total', channel: 'voice', quantities: { embedding_tokens: 25 } }],
    { absolute: 0, relative: 0 },
  );
  assert.equal(r.lines[0].status, 'matched');
  assert.equal(r.lines[0].diffs[0].unit, 'embedding_tokens');
  assert.equal(r.lines[0].diffs[0].core, 25);
});

test('§11.2 임베딩 토큰 실패 경로: 못 쓰는 값은 0 으로도 그대로도 세지 않는다', b, () => {
  const bad = ev.turnCompleted(meta('e1'), {
    turnId: 'tn1', speaker: 'customer', utterance: '네',
    usage: { embedding_tokens: -5 },
  });
  const agg = bl.aggregateUsage([bad], { scope: { tenantId: 't1' }, granularity: 'total', rounding });
  assert.equal(bl.totalQuantities(agg).embedding_tokens, 0);
  assert.equal(agg.buckets[0].usageValuesRejected, 1);
  // 과다청구 차단 판정이 NaN 으로 비껴가지 않는지 — 음수 하나가 합계를 오염시키면 안 된다.
  const r = bl.reconcile(
    agg,
    [{ source: 'llm_vendor_report', bucket: 'total', channel: 'voice', quantities: { embedding_tokens: 40 } }],
    { absolute: 0, relative: 0 },
  );
  assert.equal(r.lines[0].diffs[0].diff, -40);
  assert.equal(r.lines[0].status, 'mismatch');
});

test('§11.2 대사: 외부에만 있는 구간은 missing_core로 보고한다', b, () => {
  const agg = bl.aggregateUsage([], { scope: { tenantId: 't1' }, granularity: 'month', rounding });
  const r = bl.reconcile(agg, [{ source: 'carrier_cdr', bucket: '2026-01', channel: 'voice', quantities: { voice_seconds: 10 } }],
    { absolute: 0, relative: 0 });
  assert.equal(r.lines[0].status, 'missing_core');
});

test('§11.2 버킷은 일·월 단위로 분리된다', b, () => {
  const jan = ev.sessionEnded(meta('e1', { occurredAt: '2026-01-05T00:00:00.000Z' }), { outcome: 'AUTO_RESOLVED', turnCount: 1, billableMs: 60000 });
  const feb = ev.sessionEnded(meta('e2', { occurredAt: '2026-02-05T00:00:00.000Z', interactionId: 'i2' }), { outcome: 'AUTO_RESOLVED', turnCount: 1, billableMs: 60000 });
  const agg = bl.aggregateUsage([jan, feb], { scope: { tenantId: 't1' }, granularity: 'month', rounding });
  assert.deepEqual(agg.buckets.map((x) => x.bucket), ['2026-01', '2026-02']);
});
