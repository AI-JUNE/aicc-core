// 원장 → 기간 이벤트 투영 검사 — 설계서 §8.1·§11.1·§11.2·§7 7.6·§13-3.
//
// 여기서 고정하는 것은 "이벤트가 나온다"가 아니라 **청구 근거가 조용히 작아지는 경로를 막는다**다.
// 잘린 집계는 언제나 작게 나오고, 작은 쪽은 과다청구 방향이 아니라 차단 판정을 비껴간다 —
// 그러면 운영은 "매출 누락"으로 읽고 그대로 청구한다. 예외로 나타나지 않는 실패다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let pl = null, ev = null, store = null, usage = null;
try {
  pl = await import('../src/events/periodLedger.ts');
  ev = await import('../src/events/schema.ts');
  store = await import('../src/events/store.ts');
  usage = await import('../src/billing/usage.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: pl ? false : '타입 스트리핑 미지원 런타임' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/events/periodLedger.ts');

const scope = { tenantId: 't1' };
const OCT = { fromIso: '2026-10-01T00:00:00.000Z', toIso: '2026-11-01T00:00:00.000Z' };
const NOV = { fromIso: '2026-11-01T00:00:00.000Z', toIso: '2026-12-01T00:00:00.000Z' };
const ROUNDING = { unitSeconds: 60, mode: 'ceil', minimumUnits: 1 };

const meta = (eventId, interactionId, occurredAt, channel = 'voice', tenantId = 't1') =>
  ({ eventId, occurredAt, tenantId, interactionId, channel });

/** 한 통화: 시작 → 고객 발화 → 종료(과금 구간 포함). */
function call(id, { start, mid, end, billableMs = 60000, channel = 'voice', tenantId = 't1', withEnd = true } = {}) {
  const out = [
    ev.sessionStarted(meta(`${id}_s`, id, start, channel, tenantId), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta(`${id}_t`, id, mid ?? start, channel, tenantId), {
      turnId: 'turn1', speaker: 'customer', utterance: '요금 알려주세요',
      usage: { llm_prompt_tokens: 10, llm_completion_tokens: 5 },
    }),
  ];
  if (withEnd) {
    out.push(ev.sessionEnded(meta(`${id}_e`, id, end ?? mid ?? start, channel, tenantId), {
      outcome: 'AUTO_RESOLVED', turnCount: 1, durationMs: 60000, billableMs,
    }));
  }
  return out;
}

// ── 1) 투영이 실제로 나오고 집계까지 통과한다 ─────────────────────────────────

test('기간 투영이 나오고 그대로 aggregateUsage 를 통과한다 — 종전에는 이 배열을 만드는 코드가 0줄이었다(§11.2)', b, () => {
  const events = call('i1', { start: '2026-10-05T10:00:00.000Z' });
  const p = pl.projectLedgerPeriod(events, { scope, period: OCT });

  assert.equal(p.counters.eventsCounted, 3);
  assert.equal(p.usableForBilling, true);
  assert.deepEqual(p.billingRefusalsKo, []);

  const agg = usage.aggregateUsage(p.events, { scope, granularity: 'month', rounding: ROUNDING });
  assert.equal(agg.buckets.length, 1);
  assert.equal(agg.buckets[0].bucket, '2026-10');
  assert.equal(agg.buckets[0].quantities.voice_seconds, 60);
  assert.equal(agg.buckets[0].quantities.voice_units, 1);
  assert.equal(agg.buckets[0].quantities.sessions, 1);
});

// ── 2) 반개구간 — 경계가 이중 계상되지 않는다 ─────────────────────────────────

test('반개구간 [from, to) — 경계 시점 이벤트는 다음 기간에만 한 번 잡힌다(이중 계상 = 과다청구)', b, () => {
  const onBoundary = call('i_b', { start: '2026-11-01T00:00:00.000Z' });
  const oct = pl.projectLedgerPeriod(onBoundary, { scope, period: OCT });
  const nov = pl.projectLedgerPeriod(onBoundary, { scope, period: NOV });

  assert.equal(oct.counters.eventsCounted, 0);
  assert.equal(oct.counters.outOfPeriodDropped, 3);
  assert.equal(nov.counters.eventsCounted, 3);
});

test('연속한 두 기간의 투영은 겹치지 않고 합이 전체와 같다', b, () => {
  const events = [
    ...call('i1', { start: '2026-10-31T23:59:59.999Z' }),
    ...call('i2', { start: '2026-11-01T00:00:00.000Z' }),
  ];
  const oct = pl.projectLedgerPeriod(events, { scope, period: OCT });
  const nov = pl.projectLedgerPeriod(events, { scope, period: NOV });

  assert.equal(oct.counters.eventsCounted + nov.counters.eventsCounted, events.length);
  const octIds = oct.events.map((e) => e.event_id);
  const novIds = nov.events.map((e) => e.event_id);
  assert.deepEqual(octIds.filter((id) => novIds.includes(id)), []);
});

test('from 은 포함이다 — 월초 첫 밀리초가 사라지지 않는다', b, () => {
  const p = pl.projectLedgerPeriod(call('i1', { start: '2026-10-01T00:00:00.000Z' }), { scope, period: OCT });
  assert.equal(p.counters.eventsCounted, 3);
});

// ── 3) 설정 오류는 통과시키지 않는다 ─────────────────────────────────────────

test('§13-3 오프셋 없는 기간 경계는 던진다 — 서버 시간대마다 다른 청구서가 나온다', b, () => {
  assert.throws(
    () => pl.projectLedgerPeriod([], { scope, period: { fromIso: '2026-10-01T00:00:00', toIso: '2026-11-01T00:00:00Z' } }),
    /오프셋 명시 ISO8601/,
  );
});

test('from >= to 인 기간은 던진다 — 반개구간이므로 그 기간에는 아무것도 들어갈 수 없다', b, () => {
  assert.throws(
    () => pl.projectLedgerPeriod([], { scope, period: { fromIso: NOV.fromIso, toIso: OCT.fromIso } }),
    /기간이 성립하지 않는다/,
  );
  assert.throws(
    () => pl.projectLedgerPeriod([], { scope, period: { fromIso: OCT.fromIso, toIso: OCT.fromIso } }),
    /기간이 성립하지 않는다/,
  );
});

test('§11.1 워크스페이스 스코프 투영은 거절한다 — 다른 부서 통화를 그 부서 청구서에 싣게 된다', b, () => {
  assert.throws(
    () => pl.projectLedgerPeriod([], { scope: { tenantId: 't1', workspaceId: 'w1' }, period: OCT }),
    /워크스페이스/,
  );
  assert.match(pl.WORKSPACE_PERIOD_UNSUPPORTED_KO, /\[승인 필요\]|워크스페이스/);
});

test('§13-3 maxEvents 는 1 이상의 정수여야 한다', b, () => {
  assert.throws(() => pl.projectLedgerPeriod([], { scope, period: OCT, maxEvents: 0 }), /1 이상의 정수/);
  assert.throws(() => pl.projectLedgerPeriod([], { scope, period: OCT, maxEvents: 1.5 }), /1 이상의 정수/);
});

// ── 4) 격리·멱등·식별자 ───────────────────────────────────────────────────────

test('§11.1 다른 테넌트 이벤트는 제외되고 상한에도 세지 않는다 — 세면 잘린 사유가 흐려진다', b, () => {
  const events = [
    ...call('i1', { start: '2026-10-05T10:00:00.000Z' }),
    ...call('x1', { start: '2026-10-05T11:00:00.000Z', tenantId: 'other' }),
  ];
  const p = pl.projectLedgerPeriod(events, { scope, period: OCT, maxEvents: 3 });
  assert.equal(p.counters.foreignTenantDropped, 3);
  assert.equal(p.counters.eventsCounted, 3);
  assert.equal(p.counters.truncated, false);
  assert.equal(p.events.every((e) => e.tenant_id === 't1'), true);
});

test('§8.1 같은 event_id 재전송은 한 번만 센다 — 집계기가 다시 세지 않게 여기서 걷어낸다', b, () => {
  const [s] = call('i1', { start: '2026-10-05T10:00:00.000Z' });
  const p = pl.projectLedgerPeriod([s, s, s], { scope, period: OCT });
  assert.equal(p.counters.duplicatesDropped, 2);
  assert.equal(p.counters.eventsCounted, 1);
});

test('§8.1 event_id 없는 이벤트는 멱등 처리가 불가능하므로 제외한다', b, () => {
  const [s] = call('i1', { start: '2026-10-05T10:00:00.000Z' });
  const p = pl.projectLedgerPeriod([{ ...s, event_id: '' }], { scope, period: OCT });
  assert.equal(p.counters.eventsRejected, 1);
  assert.equal(p.counters.eventsCounted, 0);
});

test('interaction_id 없는 이벤트는 집계에는 들어가되 통화로 묶지 않고 건수로 드러낸다', b, () => {
  const [s] = call('i1', { start: '2026-10-05T10:00:00.000Z' });
  const p = pl.projectLedgerPeriod([{ ...s, interaction_id: '' }], { scope, period: OCT });
  assert.equal(p.counters.interactionsUnidentified, 1);
  assert.equal(p.counters.eventsCounted, 1);
  assert.equal(p.counters.interactionsSeen, 0);
});

// ── 5) 시각 — 읽을 수 없으면 기간에 놓지 않는다 ───────────────────────────────

test('§13-3 오프셋 없는 이벤트 시각은 기간에 놓을 수 없어 제외하고, 그 사실을 한계로 적는다', b, () => {
  const [s] = call('i1', { start: '2026-10-05T10:00:00.000Z' });
  const p = pl.projectLedgerPeriod([{ ...s, occurred_at: '2026-10-05T10:00:00' }], { scope, period: OCT });
  assert.equal(p.counters.timestampsRejected, 1);
  assert.equal(p.counters.eventsCounted, 0);
  assert.equal(p.limitsKo.some((l) => /오프셋 명시 ISO8601/.test(l)), true);
});

test('시각 오프셋이 섞인 사실을 드러낸다 — 리포트 버킷만 갈라지고 과금 버킷은 갈라지지 않는다(§7 7.6)', b, () => {
  const events = [
    ...call('i1', { start: '2026-10-05T10:00:00.000Z' }),
    ...call('i2', { start: '2026-10-05T19:00:00+09:00' }),
  ];
  const p = pl.projectLedgerPeriod(events, { scope, period: OCT });
  assert.deepEqual(p.counters.offsetFormsSeen, ['+09:00', 'Z']);
  assert.equal(p.limitsKo.some((l) => /오프셋이 섞여/.test(l)), true);
  assert.match(p.noteKo, /오프셋 혼재/);
});

// ── 6) 잘림 — 청구 근거로 쓸 수 없다 ─────────────────────────────────────────

test('투영이 잘리면 청구 근거가 아니다 — 잘린 집계는 작게 나와 과다청구 차단을 비껴간다(§11.2)', b, () => {
  const events = [
    ...call('i1', { start: '2026-10-05T10:00:00.000Z' }),
    ...call('i2', { start: '2026-10-06T10:00:00.000Z' }),
  ];
  const p = pl.projectLedgerPeriod(events, { scope, period: OCT, maxEvents: 4 });
  assert.equal(p.counters.truncated, true);
  assert.equal(p.counters.eventsSkipped, 2);
  assert.equal(p.usableForBilling, false);
  assert.equal(p.billingRefusalsKo.some((r) => /잘렸다/.test(r)), true);
});

test('기간을 선언하지 않으면 청구 근거가 아니다 — 전 기간 집계는 대사에서 영구히 막힌다(§11.2)', b, () => {
  const p = pl.projectLedgerPeriod(call('i1', { start: '2026-10-05T10:00:00.000Z' }), { scope });
  assert.equal(p.usableForBilling, false);
  assert.equal(p.billingRefusalsKo.some((r) => /청구 기간을 선언하지 않았다/.test(r)), true);
  assert.equal(p.period, undefined);
  // 리포트는 전 기간도 뜻이 있으므로 이벤트는 그대로 나온다.
  assert.equal(p.counters.eventsCounted, 3);
});

test('기간 필터가 상한보다 먼저다 — 기간 밖 이벤트가 상한을 먹고 "잘렸다"로 적히지 않는다', b, () => {
  const events = [
    ...call('i_prev', { start: '2026-09-10T10:00:00.000Z' }),
    ...call('i1', { start: '2026-10-05T10:00:00.000Z' }),
  ];
  const p = pl.projectLedgerPeriod(events, { scope, period: OCT, maxEvents: 3 });
  assert.equal(p.counters.outOfPeriodDropped, 3);
  assert.equal(p.counters.eventsCounted, 3);
  assert.equal(p.counters.truncated, false);
  assert.equal(p.usableForBilling, true);
});

// ── 7) 경계에 걸친 통화 ───────────────────────────────────────────────────────

test('종료를 기간 안에서 못 본 통화를 건수로 드러낸다 — 그 통화 분은 이 기간에 잡히지 않는다', b, () => {
  const events = call('i1', { start: '2026-10-31T23:50:00.000Z', mid: '2026-10-31T23:55:00.000Z', end: '2026-11-01T00:02:00.000Z' });
  const p = pl.projectLedgerPeriod(events, { scope, period: OCT });

  assert.equal(p.counters.interactionsSeen, 1);
  assert.equal(p.counters.interactionsWithoutEndInPeriod, 1);
  assert.equal(p.counters.interactionsWithoutStartInPeriod, 0);
  assert.match(p.noteKo, /통화 분은 이 기간에 잡히지 않는다/);

  // 실제로 통화 분이 0 이고, 집계의 "실측 누락" 과도 구분된다(종료 이벤트 자체가 기간 밖이다).
  const agg = usage.aggregateUsage(p.events, { scope, granularity: 'month', rounding: ROUNDING });
  assert.equal(agg.buckets[0].quantities.voice_seconds, 0);
  assert.equal(agg.buckets[0].sessionsMissingBillableMs, 0);
});

test('시작을 기간 안에서 못 본 통화도 건수로 드러낸다(앞 경계)', b, () => {
  const events = call('i1', { start: '2026-09-30T23:59:00.000Z', mid: '2026-10-01T00:01:00.000Z', end: '2026-10-01T00:05:00.000Z' });
  const p = pl.projectLedgerPeriod(events, { scope, period: OCT });
  assert.equal(p.counters.interactionsWithoutStartInPeriod, 1);
  assert.equal(p.counters.interactionsWithoutEndInPeriod, 0);
});

// ── 8) 원장에서 바로 투영 ─────────────────────────────────────────────────────

function seeded() {
  const log = store.createMemoryEventLog(scope);
  log.appendAll([
    ...call('i1', { start: '2026-10-05T10:00:00.000Z' }),
    ...call('i2', { start: '2026-10-06T10:00:00.000Z' }),
  ]);
  return log;
}

test('원장에서 바로 투영한다 — 스코프는 원장이 가진 것이다(호스트가 테넌트를 주장하지 못한다, §11.1)', b, () => {
  const log = store.createMemoryEventLog({ tenantId: 'other' });
  log.appendAll(call('i1', { start: '2026-10-05T10:00:00.000Z', tenantId: 'other' }));
  const p = pl.projectLedgerPeriodFromLog(log, { period: OCT });
  assert.equal(p.scope.tenantId, 'other');
  assert.equal(p.counters.eventsCounted, 3);
});

test('원장 읽기 상한으로 잘린 것을 오프셋으로 잡는다 — 투영은 스스로 알 수 없다(limit 하나로 청구서가 작아진다)', b, () => {
  const log = seeded();
  const cut = pl.projectLedgerPeriodFromLog(log, { period: OCT }, { limit: 2 });
  assert.equal(cut.counters.truncated, true);
  assert.equal(cut.usableForBilling, false);
  assert.equal(cut.billingRefusalsKo.some((r) => /원장 읽기 상한/.test(r)), true);

  const full = pl.projectLedgerPeriodFromLog(log, { period: OCT });
  assert.equal(full.counters.truncated, false);
  assert.equal(full.usableForBilling, true);
  assert.equal(full.counters.eventsCounted, 6);
});

test('커서 끝까지 읽은 경우는 잘린 것이 아니다(읽을 것이 없었다)', b, () => {
  const log = seeded();
  const p = pl.projectLedgerPeriodFromLog(log, { period: OCT }, { afterOffset: log.lastOffset() });
  assert.equal(p.counters.truncated, false);
  assert.equal(p.counters.eventsCounted, 0);
});

test('types·interactionId 로 걸러 읽은 원장으로는 기간 투영을 만들지 않는다 — 경계 통화를 셀 수 없다', b, () => {
  const log = seeded();
  assert.throws(() => pl.projectLedgerPeriodFromLog(log, { period: OCT }, { types: ['session.ended'] }), /걸러 읽으면/);
  assert.throws(() => pl.projectLedgerPeriodFromLog(log, { period: OCT }, { interactionId: 'i1' }), /걸러 읽으면/);
});

test('빈 원장에서도 던지지 않고 "근거 없음"으로 끝난다', b, () => {
  const log = store.createMemoryEventLog(scope);
  const p = pl.projectLedgerPeriodFromLog(log, { period: OCT });
  assert.equal(p.counters.eventsCounted, 0);
  assert.equal(p.counters.truncated, false);
  assert.equal(p.noteKo, undefined);
});

// ── 9) 이 파일이 하지 않는 것 ─────────────────────────────────────────────────

test('§10.3 투영이 만든 문구에 발화·요약이 실리지 않는다', b, () => {
  const events = [
    ...call('i1', { start: '2026-10-05T10:00:00.000Z' }),
    ev.handoffRequested(meta('h1', 'i1', '2026-10-05T10:01:00.000Z'), { reason: 'policy', summary: '고객 주민번호 900101-1234567 확인' }),
  ];
  const p = pl.projectLedgerPeriod(events, { scope, period: OCT, maxEvents: 1 });
  const texts = [p.noteKo ?? '', ...p.limitsKo, ...p.billingRefusalsKo].join(' ');
  assert.equal(/주민번호|900101|요금 알려주세요/.test(texts), false);
});

test('§13-3 시계를 만들지 않고 판정을 복사하지 않는다 — 소스에 Date.now·허용오차·단가가 없다', b, () => {
  const src = readFileSync(SRC, 'utf8');
  for (const forbidden of ['Date.now', 'Tolerance', 'applyRounding', 'verdict', 'retentionDays']) {
    assert.equal(src.includes(forbidden), false, `${forbidden} 가 투영에 있다 — 판정·시계는 다른 모듈의 몫이다`);
  }
});

test('계약 버전이 노출된다', b, () => {
  assert.equal(typeof pl.PERIOD_LEDGER_CONTRACT_VERSION, 'number');
  assert.match(pl.PERIOD_FULL_SCAN_LIMIT_KO, /기간 색인/);
});

test('오프셋 명시 ISO 판정은 한 곳이다 — 보존기간 투영과 같은 함수를 쓴다(§2)', b, () => {
  assert.equal(pl.isZonedIso('2026-10-01T00:00:00Z'), true);
  assert.equal(pl.isZonedIso('2026-10-01T09:00:00+09:00'), true);
  assert.equal(pl.isZonedIso('2026-10-01T00:00:00'), false);
  assert.equal(pl.isZonedIso('어제'), false);
  assert.equal(pl.isZonedIso(undefined), false);
  const inv = readFileSync(join(ROOT, 'src/core/retentionInventory.ts'), 'utf8');
  assert.match(inv, /import \{ isZonedIso \} from '\.\.\/events\/periodLedger\.ts'/);
});
