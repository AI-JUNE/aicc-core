import { test } from 'node:test';
import assert from 'node:assert/strict';

let rp = null, ev = null;
try {
  rp = await import('../src/reports/aggregate.ts');
  ev = await import('../src/events/schema.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: rp ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 'acme' };

let n = 0;
function meta(over = {}) {
  n += 1;
  return {
    eventId: over.eventId ?? `e-${n}`,
    occurredAt: over.occurredAt ?? '2026-09-01T10:00:00Z',
    tenantId: over.tenantId ?? 'acme',
    interactionId: over.interactionId ?? 'i-1',
    channel: over.channel ?? 'voice',
  };
}

test('§8.1 이벤트 → 버킷 집계: 세션·턴·이관·Outcome 이 채널과 함께 잡힌다', behavioral, () => {
  const events = [
    ev.sessionStarted(meta(), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta(), { turnId: 't1', speaker: 'customer', utterance: '요금 문의', intent: 'billing', latency: { total_ms: 700 } }),
    ev.turnCompleted(meta(), { turnId: 't2', speaker: 'bot', utterance: '안내드리겠습니다', latency: { total_ms: 300 } }),
    ev.handoffRequested(meta(), { reason: 'low_confidence', toQueue: 'general' }),
    ev.sessionEnded(meta(), { outcome: 'TRANSFERRED', turnCount: 2, durationMs: 60000 }),
  ];
  const r = rp.aggregateReport(events, { scope, granularity: 'day' });

  assert.equal(r.buckets.length, 1);
  const b = r.buckets[0];
  assert.equal(b.bucket, '2026-09-01');
  assert.equal(b.sessionsStarted, 1);
  assert.equal(b.sessionsEnded, 1);
  assert.equal(b.turns, 2);
  assert.equal(b.customerTurns, 1);
  assert.equal(b.botTurns, 1);
  assert.equal(b.handoffs, 1);
  assert.equal(b.handoffReasons.low_confidence, 1);
  assert.equal(b.outcomes.TRANSFERRED, 1);
  assert.equal(b.channels.voice, 5);
  assert.equal(b.intents.billing, 1);
  assert.equal(r.total.turns, 2);
});

test('§11.1 다른 테넌트 이벤트는 집계에서 제외되고 건수로 드러난다', behavioral, () => {
  const events = [
    ev.sessionEnded(meta(), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
    ev.sessionEnded(meta({ tenantId: 'globex' }), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
  ];
  const r = rp.aggregateReport(events, { scope, granularity: 'total' });
  assert.equal(r.foreignTenantDropped, 1);
  assert.equal(r.total.sessionsEnded, 1);
});

test('§8.1 같은 event_id 재전송은 지표를 부풀리지 않는다', behavioral, () => {
  const e = ev.sessionEnded(meta({ eventId: 'dup-1' }), { outcome: 'AUTO_RESOLVED', turnCount: 1 });
  const r = rp.aggregateReport([e, e, e], { scope, granularity: 'total' });
  assert.equal(r.duplicatesDropped, 2);
  assert.equal(r.total.sessionsEnded, 1);
});

test('기간·채널 필터가 적용되고 제외 건수를 함께 돌려준다', behavioral, () => {
  const events = [
    ev.sessionEnded(meta({ occurredAt: '2026-08-31T23:00:00Z' }), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
    ev.sessionEnded(meta({ occurredAt: '2026-09-01T10:00:00Z' }), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
    ev.sessionEnded(meta({ occurredAt: '2026-09-01T11:00:00Z', channel: 'chat' }), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
  ];
  const r = rp.aggregateReport(events, { scope, granularity: 'day', from: '2026-09-01T00:00:00Z', channels: ['voice'] });
  assert.equal(r.total.sessionsEnded, 1);
  assert.equal(r.outOfRangeDropped, 2);
});

test('버킷 단위(hour/day/month/total)가 키에 반영된다', behavioral, () => {
  const iso = '2026-09-01T10:30:00Z';
  assert.equal(rp.reportBucketKey(iso, 'hour'), '2026-09-01T10');
  assert.equal(rp.reportBucketKey(iso, 'day'), '2026-09-01');
  assert.equal(rp.reportBucketKey(iso, 'month'), '2026-09');
  assert.equal(rp.reportBucketKey(iso, 'total'), 'total');
});

test('§13-3 비율은 분모와 함께 나오고, 분모 0 이면 0% 가 아니라 null 이다', behavioral, () => {
  const empty = rp.aggregateReport([], { scope, granularity: 'total' });
  const rates = rp.outcomeRates(empty.total);
  assert.equal(rates.denominatorSessionsEnded, 0);
  assert.equal(rates.autoResolved.ratio, null);

  const events = [
    ev.sessionEnded(meta(), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
    ev.sessionEnded(meta(), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
    ev.sessionEnded(meta(), { outcome: 'TRANSFERRED', turnCount: 1 }),
    ev.sessionEnded(meta(), { outcome: 'ABANDONED', turnCount: 1 }),
  ];
  const r = rp.aggregateReport(events, { scope, granularity: 'total' });
  const rr = rp.outcomeRates(r.total);
  assert.equal(rr.autoResolved.numerator, 2);
  assert.equal(rr.autoResolved.denominator, 4);
  assert.equal(rr.autoResolved.ratio, 0.5);
  assert.equal(rp.handoffRate(r.total).ratio, 0.25);
});

test('§5.1 미인식률 — 인텐트 없는 고객 턴을 따로 센다', behavioral, () => {
  const events = [
    ev.turnCompleted(meta(), { turnId: 't1', speaker: 'customer', utterance: '어...', latency: { total_ms: 100 } }),
    ev.turnCompleted(meta(), { turnId: 't2', speaker: 'customer', utterance: '요금 문의', intent: 'billing', latency: { total_ms: 100 } }),
    ev.turnCompleted(meta(), { turnId: 't3', speaker: 'bot', utterance: '안내드립니다', latency: { total_ms: 100 } }),
  ];
  const r = rp.aggregateReport(events, { scope, granularity: 'total' });
  const u = rp.unrecognizedRate(r.total);
  assert.equal(u.numerator, 1);
  assert.equal(u.denominator, 2, '분모는 고객 턴만');
  assert.equal(u.ratio, 0.5);
});

test('지연은 백분위로만 내보내고, 표본이 없으면 null 이다', behavioral, () => {
  assert.equal(rp.percentile([], 50), null);
  assert.equal(rp.percentile([10, 20, 30, 40], 50), 20);
  assert.equal(rp.percentile([10, 20, 30, 40], 100), 40);
  assert.throws(() => rp.percentile([1], 0));

  const events = [1, 2, 3, 4, 5].map((i) =>
    ev.turnCompleted(meta(), { turnId: `t${i}`, speaker: 'bot', utterance: '안내', latency: { total_ms: i * 100, llm_ttft_ms: i * 10 } }),
  );
  events.push(ev.turnCompleted(meta(), { turnId: 't6', speaker: 'bot', utterance: '지연 미측정' }));

  const r = rp.aggregateReport(events, { scope, granularity: 'total' });
  const lat = rp.latencyReport(r.total);
  assert.equal(lat.total.sampleCount, 5);
  assert.equal(lat.total.p50, 300);
  assert.equal(lat.total.max, 500);
  assert.equal(lat.total.missing, 1, '측정값 없는 턴은 0 으로 채우지 않고 결측으로 센다');
  assert.equal(lat.stt.sampleCount, 0);
  assert.equal(lat.stt.p95, null);
});

test('결측 현황이 리포트와 함께 나온다 — 완전한 표처럼 보이지 않게', behavioral, () => {
  const events = [
    ev.sessionStarted(meta(), {}),
    ev.sessionStarted(meta(), {}),
    ev.sessionEnded(meta(), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
  ];
  const r = rp.aggregateReport(events, { scope, granularity: 'total' });
  const c = rp.completeness(r.total);
  assert.equal(c.sessionsStarted, 2);
  assert.equal(c.sessionsEnded, 1);
  assert.equal(c.endedMinusStarted, -1);
  assert.equal(c.sessionsMissingDuration, 1);
});

test('§10.3 마스킹이 발생한 턴 수를 운영 점검용으로 집계한다', behavioral, () => {
  const events = [
    ev.turnCompleted(meta(), { turnId: 't1', speaker: 'customer', utterance: '제 번호는 010-1234-5678 입니다' }),
    ev.turnCompleted(meta(), { turnId: 't2', speaker: 'customer', utterance: '감사합니다' }),
  ];
  const r = rp.aggregateReport(events, { scope, granularity: 'total' });
  assert.equal(r.total.turnsWithPiiMasked, 1);
});

test('인텐트 상위 목록은 빈도순·동률 시 이름순으로 안정 정렬된다', behavioral, () => {
  const mk = (intent, i) => ev.turnCompleted(meta(), { turnId: `t${i}`, speaker: 'customer', utterance: '문의', intent });
  const events = [mk('billing', 1), mk('billing', 2), mk('address', 3), mk('cancel', 4)];
  const r = rp.aggregateReport(events, { scope, granularity: 'total' });
  assert.deepEqual(rp.topIntents(r.total), [
    { intent: 'billing', count: 2 },
    { intent: 'address', count: 1 },
    { intent: 'cancel', count: 1 },
  ]);
  assert.deepEqual(rp.topIntents(r.total, 1), [{ intent: 'billing', count: 2 }]);
});
