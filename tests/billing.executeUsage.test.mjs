// 과금 집계·대사 실행기 검사 — 설계서 §11.2·§8.1·§11.1·§13-3.
//
// 여기서 고정하는 것은 "집계가 돈다"가 아니라 **판정문이 엉뚱한 말을 하는 경로를 막는다**다.
// 명세를 안 줬는데 "과다청구 의심", 단위를 잘못 선언했는데 "과다청구 의심", 지난달 명세를 댔는데
// "이벤트 유실" — 셋 다 숫자가 그럴듯하게 나오고, 그 문구가 그대로 정산 기록에 남는다.
// 그래서 거절(refused)은 `blocked` 도 `billable` 도 아닌 세 번째 상태여야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let run = null, pl = null, ev = null, usage = null, rec = null;
try {
  run = await import('../src/billing/executeUsage.ts');
  pl = await import('../src/events/periodLedger.ts');
  ev = await import('../src/events/schema.ts');
  usage = await import('../src/billing/usage.ts');
  rec = await import('../src/billing/reconcile.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: run ? false : '타입 스트리핑 미지원 런타임' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/billing/executeUsage.ts');

const scope = { tenantId: 't1' };
const OCT = { fromIso: '2026-10-01T00:00:00.000Z', toIso: '2026-11-01T00:00:00.000Z' };
const ROUNDING = { unitSeconds: 60, mode: 'ceil', minimumUnits: 1 };
const TOL = { absolute: 0, relative: 0 };

const meta = (eventId, interactionId, occurredAt, channel = 'voice', tenantId = 't1') =>
  ({ eventId, occurredAt, tenantId, interactionId, channel });

function call(id, { start = '2026-10-05T10:00:00.000Z', billableMs = 60000, tenantId = 't1', channel = 'voice' } = {}) {
  return [
    ev.sessionStarted(meta(`${id}_s`, id, start, channel, tenantId), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta(`${id}_t`, id, start, channel, tenantId), {
      turnId: 'turn1', speaker: 'customer', utterance: '제 번호는 010-1234-5678 입니다',
      usage: { llm_prompt_tokens: 10, llm_completion_tokens: 5 },
    }),
    ev.sessionEnded(meta(`${id}_e`, id, start, channel, tenantId), {
      outcome: 'AUTO_RESOLVED', turnCount: 1, durationMs: 60000, billableMs,
    }),
  ];
}

const project = (events, opts = {}) => pl.projectLedgerPeriod(events, { scope, period: OCT, ...opts });
const stmt = (over = {}) =>
  ({ source: 'carrier_cdr', bucket: '2026-10', channel: 'voice', quantities: { voice_seconds: 60, voice_units: 1 }, ...over });

const params = (events, over = {}) => ({ projection: project(events), granularity: 'month', rounding: ROUNDING, ...over });

// ── 1) 집계가 실제로 나온다 ───────────────────────────────────────────────────

test('기간 투영 → 과금 수량이 산출된다 — 종전에는 이 셋을 꿰는 코드가 0줄이었다(§11.2)', b, () => {
  const r = run.runUsageAggregation(params(call('i1')));
  assert.equal(r.status, 'aggregated');
  assert.deepEqual(r.refusalsKo, []);
  assert.equal(r.aggregate.buckets.length, 1);
  assert.equal(r.totals.sessions, 1);
  assert.equal(r.totals.voice_seconds, 60);
  assert.equal(r.totals.voice_units, 1);
  assert.equal(r.totals.llm_prompt_tokens, 10);
  assert.deepEqual(r.totals, usage.totalQuantities(r.aggregate));
});

test('§13-3 이벤트가 없으면 "사용량 0"이 아니라 "근거가 없었다"다', b, () => {
  const r = run.runUsageAggregation(params([]));
  assert.equal(r.status, 'empty');
  assert.match(r.messageKo, /근거가 없었다/);
  assert.equal(r.totals.sessions, 0);
});

// ── 2) 거절 — 수량표를 만들지 않는다 ─────────────────────────────────────────

test('기간을 선언하지 않은 투영으로는 수량표를 만들지 않는다 — 전 기간 집계는 대사에서 영구히 막힌다', b, () => {
  const r = run.runUsageAggregation({
    projection: pl.projectLedgerPeriod(call('i1'), { scope }),
    granularity: 'month',
    rounding: ROUNDING,
  });
  assert.equal(r.status, 'refused');
  assert.equal(r.aggregate, undefined);
  assert.equal(r.totals, undefined);
  assert.equal(r.refusalsKo.some((x) => /청구 기간을 선언하지 않았다/.test(x)), true);
});

test('잘린 투영으로는 수량표를 만들지 않는다 — 작게 나온 수량이 "매출 누락"으로 읽힌다', b, () => {
  const r = run.runUsageAggregation(params([...call('i1'), ...call('i2')], {}));
  assert.equal(r.status, 'aggregated');

  const cut = run.runUsageAggregation({
    projection: project([...call('i1'), ...call('i2')], { maxEvents: 4 }),
    granularity: 'month',
    rounding: ROUNDING,
  });
  assert.equal(cut.status, 'refused');
  assert.equal(cut.aggregate, undefined);
  assert.equal(cut.refusalsKo.some((x) => /잘렸다/.test(x)), true);
});

test('반올림 규칙 결함은 집계 전에 거절한다 — 종전에는 조용한 달은 통과하고 바쁜 달에만 터졌다', b, () => {
  const bad = { unitSeconds: 0, mode: 'ceil', minimumUnits: 1 };

  // 결함 자체를 고정한다: 같은 설정이 데이터에 따라 다르게 나타난다.
  assert.throws(() => usage.aggregateUsage(call('i1'), { scope, granularity: 'month', rounding: bad }), /unitSeconds/);
  assert.doesNotThrow(() => usage.aggregateUsage([], { scope, granularity: 'month', rounding: bad }));

  for (const events of [call('i1'), []]) {
    const r = run.runUsageAggregation(params(events, { rounding: bad }));
    assert.equal(r.status, 'refused');
    assert.equal(r.aggregate, undefined);
    assert.equal(r.refusalsKo.some((x) => /unitSeconds/.test(x)), true);
  }
});

test('알 수 없는 반올림 방식·음수 최소단위도 거절한다(§13-3)', b, () => {
  const r = run.runUsageAggregation(params(call('i1'), { rounding: { unitSeconds: 60, mode: '올림', minimumUnits: -1 } }));
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.length >= 2, true);
});

// ── 3) 대사 — 입력이 판정에 닿을 자격을 먼저 본다 ─────────────────────────────

test('대사가 실제로 돈다 — 일치하면 billable 이고 리포트가 함께 나온다', b, () => {
  const r = run.runReconciliation({ ...params(call('i1')), tolerance: TOL, statements: [stmt()] });
  assert.equal(r.status, 'reconciled');
  assert.equal(r.scenario.verdict, 'billable');
  assert.match(r.reportKo, /과금 근거 대사/);
  assert.match(r.messageKo, /billable/);
});

test('명세가 없으면 거절이다 — 종전에는 "대사 미실시"가 "과다청구 의심(blocked)"으로 기록됐다', b, () => {
  // 결함 자체를 고정한다.
  const direct = rec.runReconciliationScenario(call('i1'), {
    scope, granularity: 'month', rounding: ROUNDING, tolerance: TOL, statements: [],
  });
  assert.equal(direct.verdict, 'blocked');
  assert.match(direct.verdictReasonKo, /과다청구 방향/);

  const r = run.runReconciliation({ ...params(call('i1')), tolerance: TOL, statements: [] });
  assert.equal(r.status, 'refused');
  assert.equal(r.scenario, undefined);
  assert.equal(r.reportKo, undefined);
  assert.equal(r.refusalsKo.some((x) => /대사 미실시/.test(x)), true);
});

test('집계 단위와 버킷 모양이 다른 명세는 거절이다 — 두 쪽이 영영 만나지 않아 전 구간이 미해소로 갈린다', b, () => {
  const daily = stmt({ bucket: '2026-10-05' });
  const direct = rec.runReconciliationScenario(call('i1'), {
    scope, granularity: 'month', rounding: ROUNDING, tolerance: TOL, statements: [daily],
  });
  assert.equal(direct.verdict, 'blocked');

  const r = run.runReconciliation({ ...params(call('i1')), tolerance: TOL, statements: [daily] });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((x) => /버킷 모양이 다른/.test(x)), true);
});

test('투영 기간 밖의 명세는 거절이다 — 종전에는 멀쩡한 원장에 "이벤트 유실" 가설이 붙었다', b, () => {
  const lastMonth = stmt({ bucket: '2026-09' });
  const direct = rec.runReconciliationScenario(call('i1'), {
    scope, granularity: 'month', rounding: ROUNDING, tolerance: TOL, statements: [lastMonth],
  });
  assert.equal(direct.findings.some((f) => f.hypotheses.some((h) => h.cause === 'missing_core')), true);

  const r = run.runReconciliation({ ...params(call('i1')), tolerance: TOL, statements: [lastMonth] });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((x) => /투영 기간\(2026-10 ~ 2026-10\) 밖의 명세/.test(x)), true);
});

test('같은 구간에 명세가 둘이면 거절이다 — 대사는 배열에서 나중 것을 조용히 쓴다', b, () => {
  const a = stmt({ source: 'carrier_cdr', quantities: { voice_seconds: 60 } });
  const c = stmt({ source: 'vendor_report', quantities: { voice_seconds: 30 } });

  // 결함 자체를 고정한다: 순서만 바꿔도 판정이 달라진다.
  const first = rec.runReconciliationScenario(call('i1'), {
    scope, granularity: 'month', rounding: ROUNDING, tolerance: TOL, statements: [a, c],
  });
  const second = rec.runReconciliationScenario(call('i1'), {
    scope, granularity: 'month', rounding: ROUNDING, tolerance: TOL, statements: [c, a],
  });
  assert.notEqual(first.verdict, second.verdict);

  const r = run.runReconciliation({ ...params(call('i1')), tolerance: TOL, statements: [a, c] });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((x) => /같은 구간에 명세가 둘/.test(x)), true);
});

test('일 단위 대사에서는 일 버킷 명세가 정상이고 월 버킷이 거절된다(단위 선언 그대로 본다)', b, () => {
  const ok = run.runReconciliation({
    ...params(call('i1'), { granularity: 'day' }),
    tolerance: TOL,
    statements: [stmt({ bucket: '2026-10-05' })],
  });
  assert.equal(ok.status, 'reconciled');
  assert.equal(ok.scenario.verdict, 'billable');

  const bad = run.runReconciliation({
    ...params(call('i1'), { granularity: 'day' }),
    tolerance: TOL,
    statements: [stmt({ bucket: '2026-10' })],
  });
  assert.equal(bad.status, 'refused');
});

test('집계 단위 total 은 total 버킷 명세만 받는다', b, () => {
  const ok = run.runReconciliation({
    ...params(call('i1'), { granularity: 'total' }),
    tolerance: TOL,
    statements: [stmt({ bucket: 'total' })],
  });
  assert.equal(ok.status, 'reconciled');

  const bad = run.runReconciliation({
    ...params(call('i1'), { granularity: 'total' }),
    tolerance: TOL,
    statements: [stmt({ bucket: '2026-10' })],
  });
  assert.equal(bad.status, 'refused');
});

// ── 4) 판정을 복사하지 않는다 ─────────────────────────────────────────────────

test('과다청구 방향 차단은 그대로 통과시킨다 — 이 파일이 청구를 풀어 주지 않는다', b, () => {
  const r = run.runReconciliation({
    ...params(call('i1')),
    tolerance: TOL,
    statements: [stmt({ quantities: { voice_seconds: 30 } })],
  });
  assert.equal(r.status, 'reconciled');
  assert.equal(r.scenario.verdict, 'blocked');
  assert.match(r.messageKo, /blocked/);
});

test('과소청구 방향은 차단이 아니라 검토로 그대로 온다', b, () => {
  const r = run.runReconciliation({
    ...params(call('i1')),
    tolerance: TOL,
    statements: [stmt({ quantities: { voice_seconds: 120 } })],
  });
  assert.equal(r.scenario.verdict, 'review_required');
});

test('거절은 blocked 도 billable 도 아니다 — 결과 어디에도 판정이 없다', b, () => {
  const r = run.runReconciliation({ ...params(call('i1')), tolerance: TOL, statements: [] });
  assert.equal(r.status, 'refused');
  assert.equal(r.scenario, undefined);
  // 판정 자리 자체가 없다. 거절 사유 문구가 blocked 를 **설명**하는 것과, 결과가 blocked 를
  // **판정하는** 것은 다르다 — 후자가 있으면 정산 기록에 판정으로 남는다.
  assert.equal('verdict' in r, false);
  assert.equal(/"verdict"/.test(JSON.stringify(r)), false);
});

test('§2 판정 규칙을 복사하지 않는다 — 소스에 허용오차 비교·과다청구 방향 판정이 없다', b, () => {
  const src = readFileSync(SRC, 'utf8');
  for (const forbidden of ['withinTolerance', 'overBilledDirection', 'Date.now', 'hypothes']) {
    assert.equal(src.includes(forbidden), false, `${forbidden} 가 실행기에 있다 — 판정은 reconcile.ts 하나다`);
  }
});

// ── 5) 숨기지 않는다 ─────────────────────────────────────────────────────────

test('경계에 걸친 통화는 경고로 드러난다 — 그 통화 분은 이 기간에 잡히지 않고 실측 누락과도 다르다', b, () => {
  const spanning = [
    ev.sessionStarted(meta('i9_s', 'i9', '2026-10-31T23:50:00.000Z'), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta('i9_t', 'i9', '2026-10-31T23:55:00.000Z'), { turnId: 't1', speaker: 'customer', utterance: '여보세요' }),
    ev.sessionEnded(meta('i9_e', 'i9', '2026-11-01T00:02:00.000Z'), { outcome: 'AUTO_RESOLVED', turnCount: 1, billableMs: 720000 }),
  ];
  const r = run.runUsageAggregation(params(spanning));
  assert.equal(r.status, 'aggregated');
  assert.equal(r.totals.voice_seconds, 0);
  assert.equal(r.warningsKo.some((w) => /sessionsMissingBillableMs 에도 포함되지 않습니다/.test(w)), true);
});

test('§11.1 다른 테넌트 이벤트가 걸러진 사실은 경고로 올라간다(집계는 안전하다)', b, () => {
  const r = run.runUsageAggregation(params([...call('i1'), ...call('x1', { tenantId: 'other' })]));
  assert.equal(r.status, 'aggregated');
  assert.equal(r.totals.sessions, 1);
  assert.equal(r.warningsKo.some((w) => /다른 테넌트 이벤트 3건/.test(w)), true);
  // 같은 숫자를 두 곳에서 세지 않는다 — 집계기는 이미 걸러진 입력을 받는다(§2).
  assert.equal(r.aggregate.foreignTenantDropped, 0);
  assert.equal(r.aggregate.duplicatesDropped, 0);
});

test('§10.3 거절·경고 문구에 발화·개인정보가 실리지 않는다', b, () => {
  const r = run.runReconciliation({ ...params(call('i1')), tolerance: TOL, statements: [] });
  const texts = [r.messageKo, ...r.refusalsKo, ...r.warningsKo, ...r.limitsKo].join(' ');
  assert.equal(/010-1234-5678|제 번호는/.test(texts), false);
});

test('투영의 한계가 결과로 그대로 옮겨진다 — 전수 투영이라는 사실을 숨기지 않는다', b, () => {
  const r = run.runUsageAggregation(params(call('i1')));
  assert.equal(r.limitsKo.some((l) => /기간 색인/.test(l)), true);
});

test('계약 버전이 노출된다', b, () => {
  assert.equal(typeof run.USAGE_RUN_CONTRACT_VERSION, 'number');
});
