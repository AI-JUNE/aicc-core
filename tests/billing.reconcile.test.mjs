import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null, schema = null;
try {
  m = await import('../src/billing/reconcile.ts');
  schema = await import('../src/events/schema.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't_koweon' };
const rounding = { unitSeconds: 60, mode: 'ceil', minimumUnits: 1 };
const tol = { absolute: 0, relative: 0 };

const meta = (n, over = {}) => ({
  eventId: `e${n}`, occurredAt: '2026-09-01T10:00:00.000Z',
  tenantId: 't_koweon', interactionId: `i${n}`, channel: 'voice', ...over,
});
/** 세션 1건 = billableMs. 통화 과금 근거는 billable_ms 만 신뢰한다(§11.2). */
const call = (n, billableMs, over) =>
  schema.sessionEnded(meta(n, over), { outcome: 'SELF_SERVED', turnCount: 2, billableMs });

const run = (events, statements, over = {}) => m.runReconciliationScenario(events, {
  scope, granularity: 'day', rounding, tolerance: tol, statements, ...over,
});

const stmt = (over = {}) => ({
  source: 'carrier_cdr', bucket: '2026-09-01', channel: 'voice',
  quantities: {}, ...over,
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('수량이 일치하면 청구 가능으로 판정한다', b, () => {
  const r = run([call(1, 60000), call(2, 120000)], [stmt({ quantities: { voice_units: 3, sessions: 2 } })]);
  assert.equal(r.verdict, 'billable');
  assert.equal(r.openIssues, 0);
  assert.match(r.verdictReasonKo, /허용오차/);
});

test('같은 입력이면 언제나 같은 판정이 나온다(재현 가능성)', b, () => {
  const events = [call(1, 60000)];
  const st = [stmt({ quantities: { voice_units: 1 } })];
  assert.deepEqual(JSON.stringify(run(events, st)), JSON.stringify(run(events, st)));
});

test('허용오차 안의 차이는 일치로 본다', b, () => {
  const r = run([call(1, 60000)], [stmt({ quantities: { voice_units: 2 } })], { tolerance: { absolute: 1, relative: 0 } });
  assert.equal(r.verdict, 'billable');
});

test('리포트는 판정과 미해소 항목만 담고 금액을 담지 않는다', b, () => {
  const r = run([call(1, 60000)], [stmt({ quantities: { voice_units: 5 } })]);
  const text = m.formatReconciliationReport(r);
  assert.match(text, /과금 근거 대사/);
  assert.match(text, /voice_units/);
  assert.ok(!/₩|KRW|단가|청구금액/.test(text), '금액·단가는 Core의 관심사가 아니다');
});

// ── 실패·분쟁 경로 ───────────────────────────────────────────────────────────

test('과다청구 방향 차이는 청구를 막는다', b, () => {
  const r = run([call(1, 600000)], [stmt({ quantities: { voice_units: 2 } })]);
  assert.equal(r.verdict, 'blocked');
  assert.match(r.verdictReasonKo, /과다청구/);
  assert.equal(r.findings.find((f) => f.status === 'mismatch').overBilledDirection, true);
});

test('과소청구 방향 차이는 막지 않고 확인 대상으로 남긴다', b, () => {
  const r = run([call(1, 60000)], [stmt({ quantities: { voice_units: 9 } })]);
  assert.equal(r.verdict, 'review_required');
  assert.equal(r.openIssues, 1);
});

test('외부 명세에만 있는 구간은 이벤트 유실 가설로 분류한다', b, () => {
  const r = run([call(1, 60000)], [
    stmt({ quantities: { voice_units: 1 } }),
    stmt({ bucket: '2026-09-02', quantities: { voice_units: 3 } }),
  ]);
  const f = r.findings.find((x) => x.status === 'missing_core');
  assert.ok(f);
  assert.equal(f.hypotheses[0].cause, 'missing_core');
  assert.equal(r.verdict, 'review_required');
});

test('대조할 명세가 없는 우리 수량은 과다청구 방향으로 보고 청구를 막는다', b, () => {
  const r = run([call(1, 60000)], []);
  const f = r.findings.find((x) => x.status === 'missing_external');
  assert.equal(f.hypotheses[0].cause, 'missing_external');
  assert.equal(r.verdict, 'blocked');
});

test('중복 이벤트가 제거되면 그 사실을 가설 근거로 붙인다(§8.1)', b, () => {
  const dup = call(1, 60000);
  const r = run([dup, dup, call(2, 60000)], [stmt({ quantities: { voice_units: 9 } })]);
  assert.equal(r.aggregate.duplicatesDropped, 1);
  assert.ok(r.findings.some((f) => f.hypotheses.some((h) => h.cause === 'duplicate_events')));
});

test('실측 누락 세션이 있으면 추정 대신 원인으로 보고한다(§13-3)', b, () => {
  const noBillable = schema.sessionEnded(meta(9), { outcome: 'SELF_SERVED', turnCount: 1 });
  const r = run([call(1, 60000), noBillable], [stmt({ quantities: { voice_units: 8 } })]);
  const causes = r.findings.flatMap((f) => f.hypotheses.map((h) => h.cause));
  assert.ok(causes.includes('incomplete_measurement'));
  assert.match(
    r.findings.flatMap((f) => f.hypotheses).find((h) => h.cause === 'incomplete_measurement').evidenceKo,
    /billable_ms 없는 세션 1건/,
  );
});

test('초↔분 환산 오류 크기의 차이는 unit_scale 가설로 잡는다', b, () => {
  // Core 60초 vs 외부 1(분) — 60배 관계
  const r = run([call(1, 60000)], [stmt({ quantities: { voice_seconds: 1 } })], { scaleCandidates: [60] });
  const causes = r.findings.flatMap((f) => f.hypotheses.map((h) => h.cause));
  assert.ok(causes.includes('unit_scale'));
});

test('배수 후보를 주지 않으면 환산 가설을 세우지 않는다(임의 기본값 금지 §13-3)', b, () => {
  const r = run([call(1, 60000)], [stmt({ quantities: { voice_seconds: 1 } })]);
  const causes = r.findings.flatMap((f) => f.hypotheses.map((h) => h.cause));
  assert.ok(!causes.includes('unit_scale'));
  assert.ok(causes.includes('unexplained'));
});

test('반올림 규칙으로 설명되는 크기는 rounding_rule 가설로 잡는다', b, () => {
  // 90초: ceil=2, floor=1 — 규칙 차이로 1 단위가 벌어질 수 있다
  const r = run([call(1, 90000)], [stmt({ quantities: { voice_units: 1 } })]);
  const causes = r.findings.flatMap((f) => f.hypotheses.map((h) => h.cause));
  assert.ok(causes.includes('rounding_rule'));
});

test('어떤 가설로도 설명되지 않으면 unexplained 로 남겨 사람에게 넘긴다', b, () => {
  const r = run([call(1, 60000)], [stmt({ quantities: { llm_prompt_tokens: 99999 } })]);
  const h = r.findings.flatMap((f) => f.hypotheses).find((x) => x.cause === 'unexplained');
  assert.ok(h);
  assert.match(h.evidenceKo, /사람이 확인/);
});

test('다른 테넌트 이벤트는 집계 전에 제외되고 판정문에 남는다(§11.1)', b, () => {
  const foreign = schema.sessionEnded(meta(5, { tenantId: 't_other' }), { outcome: 'SELF_SERVED', turnCount: 1, billableMs: 60000 });
  const r = run([call(1, 60000), foreign], [stmt({ quantities: { voice_units: 1 } })]);
  assert.equal(r.aggregate.foreignTenantDropped, 1);
  assert.match(r.verdictReasonKo, /다른 테넌트 이벤트 1건/);
});

test('빈 입력: 이벤트도 명세도 없으면 막지 않고 일치로 본다', b, () => {
  const r = run([], []);
  assert.equal(r.verdict, 'billable');
  assert.equal(r.findings.length, 0);
  assert.equal(r.openIssues, 0);
});

test('테넌트 스코프 없이는 대사를 시작할 수 없다(§11.1)', b, () => {
  assert.throws(() => m.runReconciliationScenario([], {
    scope: { tenantId: '' }, granularity: 'day', rounding, tolerance: tol, statements: [],
  }));
});
