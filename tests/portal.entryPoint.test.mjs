// §8.1 유입 경로가 조회·리포트에 한 번도 도착하지 않았다.
//
// `session.started.entry_point` 는 네 경로(러너·런타임·브리지·스키마)에서 원장에 **쌓이고**,
// 저장소 전체에서 그 값을 **읽는 코드가 0줄이었다**. 증상은 전부 예외가 아니다:
//  - 상호작용 조회(§7 2.2)에 유입 경로 칸도 조건도 없어, 목록은 인바운드 문의와 아웃바운드
//    캠페인 콜을 한 덩어리로 보여 준다. 민원·조사에서 가장 먼저 묻는 "이 통화가 우리가 걸었던
//    건가"의 답이 화면에 없다.
//  - §13 리포트의 모든 수치가 유입 경로를 섞은 값이다. 아웃바운드 비중이 바뀌는 달마다
//    자동완결률·이관율이 함께 움직이는데, 그 움직임은 장애가 아니라 **그럴듯한 숫자**로
//    나타난다 — 가를 근거는 원장에 있었고 읽지 않은 것뿐이다(§13-3).
//  - §5.2 전환 링크 유입(`visual_link`)이 신규 문의와 같게 세어진다.
//
// 여기서 지키는 것은 "경로별 숫자가 나온다"가 아니라 **가르지 못한 범위를 적는다**는 규칙이다:
// 모르는 것을 한 경로에 몰아 넣으면 그 경로가 가장 큰 유입원으로 보인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let Q = null, EI = null, A = null, RR = null, S = null;
try {
  Q = await import('../src/portal/interactionQuery.ts');
  EI = await import('../src/portal/executeInteractions.ts');
  A = await import('../src/reports/aggregate.ts');
  RR = await import('../src/reports/executeReport.ts');
  S = await import('../src/events/schema.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: Q ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const T0 = '2026-10-21T00:10:00.000Z';
const T1 = '2026-10-21T00:20:00.000Z';

let seq = 0;
const started = (iid, entryPoint, at = T0) => ({
  event_id: `e_s_${++seq}`, schema_version: 1, type: 'session.started',
  occurred_at: at, tenant_id: 'goone', interaction_id: iid, channel: 'voice',
  pii_masked: false, pii_kinds: [], latency_ms: {},
  ...(entryPoint !== undefined ? { entry_point: entryPoint } : {}),
});
const ended = (iid, outcome, at = T1) => ({
  event_id: `e_e_${++seq}`, schema_version: 1, type: 'session.ended',
  occurred_at: at, tenant_id: 'goone', interaction_id: iid, channel: 'voice',
  pii_masked: false, pii_kinds: [], latency_ms: {},
  outcome, turn_count: 2, duration_ms: 1000,
});

// ── 1) 조회 규약 ────────────────────────────────────────────────────────────

test('유입 경로 목록을 다시 적지 않는다 — 선언은 §8.1 스키마 하나다(§2)', b, () => {
  assert.equal(Q.ENTRY_POINT_VALUES, S.ENTRY_POINTS);
});

const QUERY = (over = {}) => ({
  scope: SCOPE,
  period: { fromIso: '2026-10-21T00:00:00.000Z', toIso: '2026-10-22T00:00:00.000Z' },
  limit: 20,
  ...over,
});
const LIMITS = { maxPeriodDays: 31, maxLimit: 100 };

test('모르는 유입 경로는 조용히 무시하지 않고 거부한다(실패 경로)', b, () => {
  const issues = Q.validateQuery(QUERY({ entryPoints: ['inbound_call', 'fax_call'] }), LIMITS);
  const issue = issues.find((i) => i.code === 'entry_point');
  assert.ok(issue, '오타 하나로 조건이 꺼진 채 전 경로가 조회된다');
  assert.equal(issue.field, 'entryPoints');
});

test('아는 유입 경로만 넣으면 통과하고 저장소 조건으로 내려간다(정상 경로)', b, () => {
  assert.deepEqual(Q.validateQuery(QUERY({ entryPoints: ['outbound_call'] }), LIMITS), []);
  const f = Q.toStorageFilter(QUERY({ entryPoints: ['outbound_call', 'outbound_call'] }));
  const cond = f.conditions.find((c) => c.field === 'entry_point');
  assert.ok(cond, '조건이 저장소로 내려가지 않으면 대용량에서는 전수 스캔 후 걸러진다');
  assert.deepEqual(cond.value, ['outbound_call'], '중복이 정규화되지 않았다');
});

test('조건이 없으면 종전과 완전히 같다 — 조건 자체를 만들지 않는다(§13-3)', b, () => {
  const f = Q.toStorageFilter(QUERY());
  assert.equal(f.conditions.some((c) => c.field === 'entry_point'), false);
});

const row = (over = {}) => ({
  id: 'i1', tenantId: 'goone', startedAt: T0, channels: ['voice'], intents: [],
  transcriptMasked: '', ...over,
});

test('단건 판정이 유입 경로로 가른다(정상 경로)', b, () => {
  const q = QUERY({ entryPoints: ['outbound_call'] });
  assert.equal(Q.matchesQuery(row({ entryPoint: 'outbound_call' }), q), true);
  assert.equal(Q.matchesQuery(row({ entryPoint: 'inbound_call' }), q), false);
});

test('유입 경로를 선언하지 않은 행은 조건이 있으면 제외한다(경계)', b, () => {
  // 포함시키면 "아웃바운드만 보기"에 경로 미선언 통화가 섞여 들어온다.
  assert.equal(Q.matchesQuery(row(), QUERY({ entryPoints: ['outbound_call'] })), false);
  // 조건이 없으면 종전대로 보인다.
  assert.equal(Q.matchesQuery(row(), QUERY()), true);
});

// ── 2) 원장 → 조회 행 투영 ──────────────────────────────────────────────────

test('투영이 유입 경로를 행에 싣는다 — 종전에는 읽는 코드가 0줄이었다', b, () => {
  const r = EI.projectInteractions([started('i1', 'outbound_call'), ended('i1', 'AUTO_RESOLVED')], { scope: SCOPE });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].entryPoint, 'outbound_call');
  assert.equal(r.counters.sessionsMissingEntryPoint, 0);
});

test('선언이 없으면 행에 필드를 만들지 않고 건수로 드러낸다(§13-3)', b, () => {
  const r = EI.projectInteractions([started('i1', undefined), ended('i1', 'AUTO_RESOLVED')], { scope: SCOPE });
  assert.equal(Object.prototype.hasOwnProperty.call(r.rows[0], 'entryPoint'), false);
  assert.equal(r.counters.sessionsMissingEntryPoint, 1);
  assert.match(r.noteKo, /유입 경로 선언이 없는/);
});

test('계약 밖 값은 그대로 적지 않는다 — 조회 조건이 영영 맞지 않게 된다(실패 경로)', b, () => {
  const r = EI.projectInteractions([started('i1', 'fax_call'), ended('i1', 'FAILED')], { scope: SCOPE });
  assert.equal(r.rows[0].entryPoint, undefined);
  assert.equal(r.counters.sessionsMissingEntryPoint, 1);
});

test('한 세션에 어긋난 선언이 오면 고르지 않고 비운다(§2)', b, () => {
  const r = EI.projectInteractions([
    started('i1', 'inbound_call'), started('i1', 'outbound_call'), ended('i1', 'TRANSFERRED'),
  ], { scope: SCOPE });
  assert.equal(r.rows[0].entryPoint, undefined, '한쪽을 고르면 그 규칙이 조용히 실적을 옮긴다');
  assert.equal(r.counters.entryPointConflicts, 1);
  assert.match(r.noteKo, /어긋난/);
});

test('투영한 행이 같은 조건으로 조회된다 — 투영과 판정이 갈라지지 않는다', b, () => {
  const r = EI.projectInteractions([
    started('i1', 'outbound_call'), ended('i1', 'AUTO_RESOLVED'),
    started('i2', 'inbound_call'), ended('i2', 'AUTO_RESOLVED'),
  ], { scope: SCOPE });
  const page = Q.runQuery(r.rows, QUERY({ entryPoints: ['outbound_call'] }));
  assert.deepEqual(page.rows.map((x) => x.id), ['i1']);
});

// ── 3) 리포트 집계 ──────────────────────────────────────────────────────────

test('유입 경로별 시작 세션 수가 실측으로 집계된다(정상 경로)', b, () => {
  const r = A.aggregateReport([
    started('i1', 'inbound_call'), started('i2', 'inbound_call'), started('i3', 'outbound_call'),
  ], { scope: SCOPE, granularity: 'total' });
  assert.equal(r.total.entryPoints.inbound_call, 2);
  assert.equal(r.total.entryPoints.outbound_call, 1);
  assert.equal(r.total.entryPoints.visual_link, 0);
  assert.equal(r.total.sessionsMissingEntryPoint, 0);
});

test('선언이 없거나 계약 밖이면 어느 경로에도 넣지 않는다 — 한 칸에 몰면 그게 최대 유입원이 된다', b, () => {
  const r = A.aggregateReport([started('i1', undefined), started('i2', 'fax_call')], {
    scope: SCOPE, granularity: 'total',
  });
  assert.equal(r.total.sessionsMissingEntryPoint, 2);
  for (const p of S.ENTRY_POINTS) assert.equal(r.total.entryPoints[p], 0, `${p} 에 몰아 넣었다`);
});

test('유입 경로별 Outcome 이 시작 이벤트와 짝지어 갈린다 — 섞인 자동완결률이 갈라진다', b, () => {
  const r = A.aggregateReport([
    started('i1', 'inbound_call'), ended('i1', 'AUTO_RESOLVED'),
    started('i2', 'inbound_call'), ended('i2', 'TRANSFERRED'),
    started('i3', 'outbound_call'), ended('i3', 'ABANDONED'),
  ], { scope: SCOPE, granularity: 'total' });
  assert.equal(r.total.outcomesByEntryPoint.inbound_call.AUTO_RESOLVED, 1);
  assert.equal(r.total.outcomesByEntryPoint.inbound_call.TRANSFERRED, 1);
  assert.equal(r.total.outcomesByEntryPoint.outbound_call.ABANDONED, 1);
  assert.equal(r.total.outcomesByEntryPoint.outbound_call.AUTO_RESOLVED, 0);
  assert.equal(r.total.sessionsEndedWithUnknownEntryPoint, 0);
  // 섞어 센 종전 수치는 그대로 남는다(§2 — 같은 원장이 화면마다 다른 값을 내지 않는다).
  assert.equal(r.total.outcomes.AUTO_RESOLVED, 1);
});

test('짝지을 시작이 범위에 없는 종료는 어느 경로에도 넣지 않는다(경계)', b, () => {
  // 기간 경계에서 잘린 통화의 모양 — 종료만 들어왔다.
  const r = A.aggregateReport([ended('i9', 'AUTO_RESOLVED')], { scope: SCOPE, granularity: 'total' });
  assert.equal(r.total.sessionsEndedWithUnknownEntryPoint, 1);
  for (const p of S.ENTRY_POINTS) {
    assert.equal(r.total.outcomesByEntryPoint[p].AUTO_RESOLVED, 0, `${p} 의 실적으로 적혔다`);
  }
  assert.equal(r.total.outcomes.AUTO_RESOLVED, 1, '전체 집계는 종전대로 센다');
});

test('종료가 시작보다 먼저 온 원장에서도 같은 답이 나온다 — 추가 전용 원장은 순서를 보장하지 않는다', b, () => {
  const r = A.aggregateReport([
    ended('i1', 'AUTO_RESOLVED'), started('i1', 'outbound_call'),
  ], { scope: SCOPE, granularity: 'total' });
  assert.equal(r.total.outcomesByEntryPoint.outbound_call.AUTO_RESOLVED, 1);
  assert.equal(r.total.sessionsEndedWithUnknownEntryPoint, 0);
});

test('어긋난 선언이 온 세션의 종료는 모름으로 둔다(§2)', b, () => {
  const r = A.aggregateReport([
    started('i1', 'inbound_call'), started('i1', 'outbound_call'), ended('i1', 'AUTO_RESOLVED'),
  ], { scope: SCOPE, granularity: 'total' });
  assert.equal(r.total.sessionsEndedWithUnknownEntryPoint, 1);
  assert.equal(r.total.outcomesByEntryPoint.inbound_call.AUTO_RESOLVED, 0);
  assert.equal(r.total.outcomesByEntryPoint.outbound_call.AUTO_RESOLVED, 0);
});

test('유입 경로가 하나 늘면 빈 버킷의 키도 함께 는다 — 열거값을 손으로 적지 않았다(§2)', b, () => {
  const r = A.aggregateReport([], { scope: SCOPE, granularity: 'total' });
  assert.deepEqual(Object.keys(r.total.entryPoints).sort(), [...S.ENTRY_POINTS].sort());
  assert.deepEqual(Object.keys(r.total.outcomesByEntryPoint).sort(), [...S.ENTRY_POINTS].sort());
});

// ── 4) 리포트가 가르지 못한 범위를 적는다 ───────────────────────────────────

const projection = (events) => ({
  scope: SCOPE,
  events,
  counters: {
    eventsSeen: events.length, eventsCounted: events.length, eventsSkipped: 0, truncated: false,
    duplicatesDropped: 0, foreignTenantDropped: 0, eventsRejected: 0, outOfPeriodDropped: 0,
    timestampsRejected: 0, interactionsWithoutStartInPeriod: 0, interactionsWithoutEndInPeriod: 0,
    offsetFormsSeen: ['Z'],
  },
  limitsKo: [],
});

test('유입 경로 미선언이 있으면 리포트가 한계로 적는다 — 조용히 작게 세지 않는다(§13-3)', b, () => {
  const r = RR.runReport({ projection: projection([started('i1', undefined)]), granularity: 'total' });
  assert.ok(r.limitsKo.some((l) => l.includes('유입 경로 선언이 없습니다')), JSON.stringify(r.limitsKo));
});

test('짝을 못 찾은 종료가 있으면 그 사실과 [승인 필요] 를 함께 적는다', b, () => {
  const r = RR.runReport({ projection: projection([ended('i9', 'AUTO_RESOLVED')]), granularity: 'total' });
  const limit = r.limitsKo.find((l) => l.includes('짝지을 시작 이벤트'));
  assert.ok(limit, JSON.stringify(r.limitsKo));
  assert.match(limit, /승인 필요/, '이벤트 계약 변경은 사람이 정한다는 사실이 빠졌다');
});

test('전부 선언된 기간에는 유입 경로 한계를 적지 않는다 — 해당 없는 경고는 진짜 신호를 묻는다(경계)', b, () => {
  const r = RR.runReport({
    projection: projection([started('i1', 'inbound_call'), ended('i1', 'TRANSFERRED')]),
    granularity: 'total',
  });
  assert.equal(r.limitsKo.some((l) => l.includes('유입 경로')), false, JSON.stringify(r.limitsKo));
});
