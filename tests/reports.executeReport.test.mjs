// 리포트 실행기 검사 — 설계서 §7 7.6·§8.1·§11.1·§13-3.
//
// 여기서 고정하는 것은 "표가 나온다"가 아니라 **잘린 표가 완전한 표처럼 보이지 않는다**다.
// 리포트는 되돌릴 수 없는 동작이 아니므로 멈추지 않는다 — 그래서 결측을 감추면 아무도 모른 채
// 멀쩡한 구간을 뒤지게 된다. 그리고 기간 경계는 **한 곳에서만** 해석돼야 한다(투영의 반개구간).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let rr = null, pl = null, ev = null;
try {
  rr = await import('../src/reports/executeReport.ts');
  pl = await import('../src/events/periodLedger.ts');
  ev = await import('../src/events/schema.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: rr ? false : '타입 스트리핑 미지원 런타임' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/reports/executeReport.ts');

const scope = { tenantId: 't1' };
const OCT = { fromIso: '2026-10-01T00:00:00.000Z', toIso: '2026-11-01T00:00:00.000Z' };

const meta = (eventId, interactionId, occurredAt, channel = 'voice', tenantId = 't1') =>
  ({ eventId, occurredAt, tenantId, interactionId, channel });

function call(id, { start = '2026-10-05T10:00:00.000Z', outcome = 'AUTO_RESOLVED', channel = 'voice', intent = 'billing', tenantId = 't1', handoff = false } = {}) {
  const out = [
    ev.sessionStarted(meta(`${id}_s`, id, start, channel, tenantId), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta(`${id}_t`, id, start, channel, tenantId), {
      turnId: 't1', speaker: 'customer', utterance: '제 번호는 010-1234-5678 입니다', intent, latency: { total_ms: 700 },
    }),
  ];
  if (handoff) out.push(ev.handoffRequested(meta(`${id}_h`, id, start, channel, tenantId), { reason: 'low_confidence', toQueue: 'general' }));
  out.push(ev.sessionEnded(meta(`${id}_e`, id, start, channel, tenantId), { outcome, turnCount: 1, durationMs: 60000 }));
  return out;
}

const project = (events, opts = {}) => pl.projectLedgerPeriod(events, { scope, period: OCT, ...opts });
const params = (events, over = {}) => ({ projection: project(events), granularity: 'day', ...over });

// ── 1) 리포트가 실제로 나온다 ─────────────────────────────────────────────────

test('기간 투영 → §7 7.6 리포트가 나온다 — 종전에는 aggregateReport 를 부르는 곳이 테스트뿐이었다', b, () => {
  const r = rr.runReport(params([...call('i1'), ...call('i2', { outcome: 'TRANSFERRED', handoff: true })]));

  assert.equal(r.status, 'reported');
  assert.equal(r.complete, true);
  assert.deepEqual(r.incompletenessKo, []);
  assert.equal(r.summary.total.sessionsStarted, 2);
  assert.equal(r.summary.total.sessionsEnded, 2);
  assert.equal(r.summary.total.handoffs, 1);
  assert.equal(r.outcomes.denominatorSessionsEnded, 2);
  assert.equal(r.outcomes.transferred.numerator, 1);
  assert.equal(r.handoff.ratio, 0.5);
  assert.equal(r.latency.total.sampleCount, 2);
  assert.deepEqual(r.topIntents, [{ intent: 'billing', count: 2 }]);
  assert.deepEqual(r.period, OCT);
});

test('§13-3 이벤트가 없으면 "통화가 0건이었다"가 아니라 "근거가 없었다"다 — 비율은 0% 가 아니라 null', b, () => {
  const r = rr.runReport(params([]));
  assert.equal(r.status, 'empty');
  assert.match(r.messageKo, /"통화가 0건이었다"와 다릅니다/);
  assert.equal(r.outcomes.autoResolved.ratio, null);
  assert.equal(r.unrecognized.ratio, null);
  assert.equal(r.latency.total.p95, null);
});

// ── 2) 기간은 한 곳에서만 해석된다 ───────────────────────────────────────────

test('§2 기간을 두 번 걸지 않는다 — 투영은 반개구간, aggregateReport 의 from·to 는 양쪽 포함이다', b, () => {
  const events = [...call('i_prev', { start: '2026-09-20T10:00:00.000Z' }), ...call('i1')];
  const r = rr.runReport(params(events));

  // 9월 통화는 투영에서 걸러졌고, 집계에는 기간이 넘어가지 않았다.
  assert.equal(r.summary.total.sessionsStarted, 1);
  assert.equal(r.summary.from, undefined);
  assert.equal(r.summary.to, undefined);
  assert.equal(r.summary.outOfRangeDropped, 0);
  const src = readFileSync(SRC, 'utf8');
  assert.equal(/from:\s*p\.|to:\s*p\./.test(src), false, '실행기가 집계에 기간을 넘기고 있다');
});

test('기간을 선언하지 않은 투영도 리포트는 돈다(전 기간) — 과금과 달리 막지 않는다', b, () => {
  const r = rr.runReport({ projection: pl.projectLedgerPeriod(call('i1'), { scope }), granularity: 'month' });
  assert.equal(r.status, 'reported');
  assert.equal(r.period, undefined);
});

// ── 3) 잘린 표를 완전한 표로 제시하지 않는다 ─────────────────────────────────

test('잘린 투영이면 멈추지 않지만 complete 가 false 다 — 결측을 감추면 멀쩡한 구간을 뒤진다', b, () => {
  const r = rr.runReport(params([...call('i1'), ...call('i2')], {}));
  assert.equal(r.complete, true);

  const cut = rr.runReport({ projection: project([...call('i1'), ...call('i2')], { maxEvents: 3 }), granularity: 'day' });
  assert.equal(cut.status, 'reported');
  assert.equal(cut.complete, false);
  assert.equal(cut.incompletenessKo.some((x) => /잘렸습니다/.test(x)), true);
});

test('기간에 놓을 수 없는 시각이 있으면 complete 가 false 다', b, () => {
  const [s, ...rest] = call('i1');
  const r = rr.runReport(params([{ ...s, occurred_at: '2026-10-05T10:00:00' }, ...rest]));
  assert.equal(r.complete, false);
  assert.equal(r.incompletenessKo.some((x) => /오프셋 명시 ISO8601/.test(x)), true);
});

test('event_id 없는 이벤트가 제외된 사실도 complete 에 반영된다(§8.1)', b, () => {
  const [s, ...rest] = call('i1');
  const r = rr.runReport(params([{ ...s, event_id: '' }, ...rest]));
  assert.equal(r.complete, false);
  assert.equal(r.incompletenessKo.some((x) => /event_id 없는/.test(x)), true);
});

// ── 4) 숨기지 않는다 ─────────────────────────────────────────────────────────

test('경계에 걸린 통화는 경고로 드러난다 — Outcome·이관율의 분모가 그만큼 작다', b, () => {
  const spanning = [
    ev.sessionStarted(meta('i9_s', 'i9', '2026-10-31T23:50:00.000Z'), { entryPoint: 'inbound_call' }),
    ev.sessionEnded(meta('i9_e', 'i9', '2026-11-01T00:02:00.000Z'), { outcome: 'AUTO_RESOLVED', turnCount: 1 }),
  ];
  const r = rr.runReport(params(spanning));
  assert.equal(r.summary.total.sessionsEnded, 0);
  assert.equal(r.outcomes.denominatorSessionsEnded, 0);
  assert.equal(r.warningsKo.some((w) => /작은 분모 위에서 계산됩니다/.test(w)), true);
  assert.equal(r.completeness.endedMinusStarted, -1);
});

test('시각 오프셋 혼재는 경고로 드러난다 — 같은 시점이 서로 다른 버킷으로 갈라진다(§7 7.6)', b, () => {
  const r = rr.runReport(params([...call('i1'), ...call('i2', { start: '2026-10-05T19:00:00+09:00' })], { granularity: 'hour' }));
  assert.equal(r.warningsKo.some((w) => /오프셋이 섞여/.test(w)), true);
  // 같은 시점인데 버킷이 둘이다 — 그 사실을 적는 것이 이 경고의 목적이다.
  assert.equal(r.summary.buckets.length, 2);
});

test('§11.1 다른 테넌트 이벤트가 걸러진 사실은 경고로 올라간다', b, () => {
  const r = rr.runReport(params([...call('i1'), ...call('x1', { tenantId: 'other' })]));
  assert.equal(r.summary.total.sessionsStarted, 1);
  assert.equal(r.warningsKo.some((w) => /다른 테넌트 이벤트/.test(w)), true);
});

test('계약에 없는 열거값은 NaN 을 만들지 않고 경고로 드러난다 — 어댑터를 점검하라고 적는다', b, () => {
  const events = call('i1');
  const broken = events.map((e) => (e.type === 'session.ended' ? { ...e, outcome: 'DONE' } : e));
  const r = rr.runReport(params(broken));

  assert.equal(Number.isNaN(r.summary.total.outcomes.AUTO_RESOLVED), false);
  assert.equal(r.summary.total.outcomesUnknown, 1);
  assert.equal(r.warningsKo.some((w) => /계약에 없는 열거값/.test(w)), true);
});

test('채널 필터가 적용되고 제외 건수가 경고로 드러난다', b, () => {
  const r = rr.runReport(params([...call('i1'), ...call('i2', { channel: 'chat' })], { channels: ['voice'] }));
  assert.equal(r.summary.total.sessionsStarted, 1);
  assert.equal(r.summary.outOfRangeDropped, 3);
  assert.equal(r.warningsKo.some((w) => /채널 필터로 제외/.test(w)), true);
});

test('빈 채널 목록은 거절한다 — 전 채널이 빠져 "통화가 없던 기간"으로 읽힌다', b, () => {
  assert.throws(() => rr.runReport(params(call('i1'), { channels: [] })), /빈 목록/);
});

test('투영의 한계가 결과로 그대로 옮겨진다', b, () => {
  const r = rr.runReport(params(call('i1')));
  assert.equal(r.limitsKo.some((l) => /기간 색인/.test(l)), true);
});

test('§10.3 결과 어디에도 발화 원문이 실리지 않는다', b, () => {
  const r = rr.runReport(params(call('i1')));
  assert.equal(/010-1234-5678|제 번호는/.test(JSON.stringify(r)), false);
});

// ── 5) 이 파일이 하지 않는 것 ─────────────────────────────────────────────────

test('§13-4 판정·목표치·증감률을 만들지 않는다 — 소스에 임계값도 기준선도 없다', b, () => {
  const src = readFileSync(SRC, 'utf8');
  for (const forbidden of ['threshold', 'target', 'baseline', 'Date.now', 'previousPeriod']) {
    assert.equal(src.includes(forbidden), false, `${forbidden} 가 실행기에 있다 — 기준선 없는 판정은 그 자체로 주장이 된다`);
  }
});

test('인텐트 상위 N 은 선언했을 때만 자른다(기본값 금지 §13-3)', b, () => {
  const events = [...call('i1', { intent: 'billing' }), ...call('i2', { intent: 'cancel' }), ...call('i3', { intent: 'address' })];
  assert.equal(rr.runReport(params(events)).topIntents.length, 3);
  assert.equal(rr.runReport(params(events, { topIntentLimit: 2 })).topIntents.length, 2);
});

test('계약 버전이 노출된다', b, () => {
  assert.equal(typeof rr.REPORT_RUN_CONTRACT_VERSION, 'number');
});
