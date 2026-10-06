// 파기 대상 목록 투영 + 스윕 검사 — 설계서 §8.2·§8.1·§10.3·§11.1·§13-3·§9.3.
//
// 여기서 고정하는 것은 "목록이 나온다"가 아니라 **스윕이 돌았는데 목록이 비어 있던 상태를
// 다시 만들지 않는다**와 **근거 없는 레코드를 만들지 않는다**이다.
// 전자는 "오늘도 깨끗함"으로 보고되는 개인정보 미파기이고, 후자는 장부에만 파기로 남는 것이다.
// 둘 다 예외로 나타나지 않는 실패다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let inv = null, ret = null, ex = null, ev = null, store = null, audit = null;
try {
  inv = await import('../src/core/retentionInventory.ts');
  ret = await import('../src/core/retention.ts');
  ex = await import('../src/core/executeDisposition.ts');
  ev = await import('../src/events/schema.ts');
  store = await import('../src/events/store.ts');
  audit = await import('../src/audit/log.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: inv ? false : '타입 스트리핑 미지원 런타임' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/core/retentionInventory.ts');

const scope = { tenantId: 't1' };
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-01T00:05:00.000Z';
const T3 = '2026-01-20T00:00:00.000Z';
const NOW = '2026-03-01T00:00:00.000Z';
const ON = { activation: 'enabled', approvalRef: 'LEGAL-2026-001' };

const meta = (eventId, interactionId, occurredAt, channel = 'voice', tenantId = 't1') =>
  ({ eventId, occurredAt, tenantId, interactionId, channel });

/** 한 통화: 시작 → 고객 발화 → 종료. 발화에 개인정보를 넣으면 pii 흔적이 생긴다. */
function session(id, { start = T1, mid = T2, end = T3, utterance = '보험료 알려주세요', channel = 'voice', tenantId = 't1', withEnd = true, prefix = '' } = {}) {
  const out = [
    ev.sessionStarted(meta(`${prefix}${id}_s`, id, start, channel, tenantId), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta(`${prefix}${id}_t`, id, mid, channel, tenantId), { turnId: 'turn1', speaker: 'customer', utterance }),
  ];
  if (withEnd) out.push(ev.sessionEnded(meta(`${prefix}${id}_e`, id, end, channel, tenantId), { outcome: 'AUTO_RESOLVED', turnCount: 1 }));
  return out;
}

const rule = (dataClass, retentionDays, over = {}) =>
  ({ dataClass, retentionDays, disposition: 'delete', basisKo: '테넌트 법적 검토 결과', approved: true, ...over });

/** 개인정보 포함 분류 3종 + 투영이 만드는 분류 전부에 규칙이 있는 정책(검증 통과). */
const policy = (over = {}) => ({
  tenantId: 't1',
  rules: [
    rule('interaction_event', 30),
    rule('transcript_masked', 30),
    rule('pii_field', 30),
    rule('recording', 30),
    rule('consent_record', 365, { disposition: 'archive' }),
  ],
  ...over,
});

const ids = (records) => records.map((r) => r.id).sort();

// ── 1) 목록이 실제로 나온다 ────────────────────────────────────────────────────

test('원장에서 파기 대상 목록이 나온다 — 종전에는 이 배열을 만드는 코드가 0줄이었다(§8.2)', b, () => {
  const r = inv.projectRetainedRecords(session('i1', { utterance: '제 번호는 010-1234-5678 입니다' }), { scope });

  assert.deepEqual(ids(r.records), ['interaction_event:i1', 'pii_field:i1', 'transcript_masked:i1']);
  for (const rec of r.records) {
    assert.equal(rec.tenantId, 't1');
    // (2) 기산 시점은 세션에서 관측된 **가장 늦은** 시각이다.
    assert.equal(rec.createdAt, T3);
  }
  assert.equal(r.usable, true);
  assert.equal(r.counters.sessionsSeen, 1);
  assert.equal(r.counters.recordsBuilt, 3);
});

test('레코드 id 는 한 곳에서 만든다 — 호스트가 자기 형식을 만들면 disposed 장부와 어긋난다', b, () => {
  assert.equal(inv.retainedRecordId('recording', 'i9'), `recording${inv.RECORD_ID_SEPARATOR}i9`);
  const r = inv.projectRetainedRecords(session('i9'), { scope });
  assert.ok(r.records.some((x) => x.id === inv.retainedRecordId('interaction_event', 'i9')));
});

test('근거가 없는 분류의 레코드를 만들지 않는다 — 전문 없음·개인정보 흔적 없음(§13-3)', b, () => {
  const noPii = inv.projectRetainedRecords(session('i1'), { scope });
  assert.deepEqual(ids(noPii.records), ['interaction_event:i1', 'transcript_masked:i1']);

  // 발화가 빈 세션(봇 응답도 없음) — 전문 레코드까지 사라진다.
  const silent = [
    ev.sessionStarted(meta('s1', 'i2', T1), { entryPoint: 'inbound_call' }),
    ev.sessionEnded(meta('e1', 'i2', T3), { outcome: 'ABANDONED', turnCount: 0 }),
  ];
  const r = inv.projectRetainedRecords(silent, { scope });
  assert.deepEqual(ids(r.records), ['interaction_event:i2']);
});

test('기산 시점을 세션 시작으로 잡으면 아직 보존기간 내인 통화가 만료로 떨어진다(§8.2)', b, () => {
  // 시작 2026-01-01 · 마지막 2026-01-20 · 보존 30일. 기준 시각은 그 사이에 둔다.
  const at = '2026-02-05T00:00:00.000Z';
  const r = inv.projectRetainedRecords(session('i1'), { scope });
  const plan = ret.planDisposition(r.records, policy(), at);

  assert.equal(plan.due.length, 0, '마지막 관측 시각 기준이면 아직 보존기간 내다');
  const d = plan.decisions.find((x) => x.recordId === 'interaction_event:i1');
  assert.equal(d.status, 'retained');
  assert.equal(d.expiresAt, '2026-02-19T00:00:00.000Z');
  // 시작 시각(2026-01-01)으로 잡았다면 2026-01-31 만료라 이미 due 였다 — 그 차이가 이 검사다.
  assert.equal(ret.expiresAt(T1, 30), '2026-01-31T00:00:00.000Z');
});

test('종료 기록이 없는 세션도 목록에 들어온다 — 빼면 그 통화의 개인정보가 영구히 남는다', b, () => {
  const r = inv.projectRetainedRecords(session('i1', { withEnd: false }), { scope });
  assert.ok(r.records.some((x) => x.id === 'interaction_event:i1'));
  assert.equal(r.counters.sessionsWithoutEnd, 1);
  assert.match(r.noteKo, /종료 기록이 없는 세션 1건/);
  // 기산 시점은 마지막 관측 시각(턴)이므로 진행 중인 통화는 애초에 기한에 걸리지 않는다.
  assert.equal(r.records[0].createdAt, T2);
});

// ── 2) 멱등·격리·형식 ─────────────────────────────────────────────────────────

test('같은 event_id 재전송은 목록을 부풀리지 않는다(§8.1 멱등)', b, () => {
  const once = session('i1');
  const r = inv.projectRetainedRecords([...once, ...once], { scope });
  assert.equal(r.counters.duplicatesDropped, 3);
  assert.equal(r.counters.recordsBuilt, 2);
});

test('다른 테넌트 이벤트는 섞지 않고 건수로 드러낸다(§11.1)', b, () => {
  const r = inv.projectRetainedRecords(
    [...session('i1'), ...session('rival', { tenantId: 'rival', prefix: 'x' })],
    { scope },
  );
  assert.deepEqual(ids(r.records), ['interaction_event:i1', 'transcript_masked:i1']);
  assert.equal(r.counters.foreignTenantDropped, 3);
  assert.match(r.noteKo, /다른 테넌트 이벤트 3건 제외/);
});

test('event_id·interaction_id 가 없는 이벤트는 세션으로 묶을 수 없다(§8.1)', b, () => {
  const ok = session('i1');
  const broken = [{ ...ok[0], event_id: '' }, { ...ok[1], interaction_id: '' }];
  const r = inv.projectRetainedRecords([...ok, ...broken], { scope });
  assert.equal(r.counters.eventsRejected, 2);
  assert.match(r.noteKo, /식별자 없는 이벤트 2건 제외/);
});

test('시각을 읽을 수 없는 이벤트는 근거로도 쓰지 않는다 — 전부 그렇다면 레코드가 없다', b, () => {
  const s = session('i1');
  const r = inv.projectRetainedRecords(s.map((e) => ({ ...e, occurred_at: '언젠가' })), { scope });

  assert.deepEqual(r.records, []);
  assert.equal(r.counters.timestampsRejected, 3);
  assert.equal(r.counters.sessionsSeen, 1, '세션을 본 사실 자체는 지우지 않는다');
  assert.equal(r.counters.sessionsWithoutUsableTime, 1);
  assert.match(r.noteKo, /그 세션의 데이터는 파기되지 않는다/);
});

test('오프셋 없는 ISO 는 시각으로 받지 않는다 — 서버 시간대에 따라 기한이 움직인다', b, () => {
  const s = session('i1', { end: '2026-01-20T00:00:00' });
  const r = inv.projectRetainedRecords(s, { scope });
  assert.equal(r.counters.timestampsRejected, 1);
  // 남은 시각 중 가장 늦은 것으로 기산한다(없는 시각을 만들지 않는다).
  assert.equal(r.records[0].createdAt, T2);
});

test('일부 이벤트의 시각만 깨져도 나머지 세션은 그대로 돈다(§9.3)', b, () => {
  const good = session('i1');
  const bad = session('i2', { prefix: 'z' }).map((e) => ({ ...e, occurred_at: 'nope' }));
  const r = inv.projectRetainedRecords([...good, ...bad], { scope });
  assert.ok(r.records.some((x) => x.id === 'interaction_event:i1'));
  assert.equal(r.records.some((x) => x.id.endsWith(':i2')), false);
  assert.equal(r.counters.sessionsWithoutUsableTime, 1);
});

// ── 3) 잘린 투영·관측 경계 ────────────────────────────────────────────────────

test('수집 상한에 걸린 투영은 레코드를 만들지 않는다 — 기산 시점을 보장할 수 없다', b, () => {
  const r = inv.projectRetainedRecords(session('i1'), { scope, maxEvents: 2 });
  assert.deepEqual(r.records, []);
  assert.equal(r.counters.truncated, true);
  assert.equal(r.counters.eventsSkipped, 1);
  assert.equal(r.usable, false);
  assert.match(r.noteKo, /레코드를 만들지 않았다/);
});

test('관측 경계에 닿은 세션은 보류한다 — 뒷부분이 다음 조각에 있을 수 있다', b, () => {
  const events = [...session('i1'), ...session('i2', { start: T1, mid: T2, end: '2026-02-01T00:00:00.000Z', prefix: 'y' })];
  const r = inv.projectRetainedRecords(events, { scope, observedThrough: '2026-01-25T00:00:00.000Z' });

  assert.ok(r.records.every((x) => x.id.endsWith(':i1')));
  assert.equal(r.counters.sessionsAtBoundary, 1);
  assert.match(r.noteKo, /관측 경계에 닿아 보류한 세션 1건/);
  assert.equal(r.usable, true, '경계 보류는 목록 전체를 못 쓰게 만들지 않는다');
});

test('관측 경계를 선언하지 않으면 검사하지 않고 그 사실을 드러낸다(§13-3)', b, () => {
  const r = inv.projectRetainedRecords(session('i1'), { scope });
  assert.equal(r.counters.sessionsAtBoundary, 0);
  assert.ok(r.limitsKo.some((l) => l.includes('observedThrough')));
});

test('상한·경계 선언의 형태 오류는 투영 전에 거절한다(§13-3)', b, () => {
  assert.throws(() => inv.projectRetainedRecords([], { scope, maxEvents: 0 }), /1 이상의 정수/);
  assert.throws(() => inv.projectRetainedRecords([], { scope, observedThrough: '2026-01-25' }), /오프셋 명시/);
});

// ── 4) 식별자에 든 개인정보(§10.3) ────────────────────────────────────────────

test('식별자에 개인정보가 있는 세션은 목록에 넣지 않고 건수로 드러낸다(§10.3)', b, () => {
  const r = inv.projectRetainedRecords(session('call-01012345678'), { scope });
  assert.deepEqual(r.records, []);
  assert.equal(r.counters.identifiersRejected, 1);
  assert.match(r.noteKo, /통화 id 생성 규칙을 점검하라/);
  // 사유에도 그 값이 실리지 않는다.
  assert.equal(r.noteKo.includes('01012345678'), false);
});

// ── 5) 법적 보류·이미 처리된 건 ───────────────────────────────────────────────

test('법적 보류 선언이 그 통화의 레코드 전부에 적용된다 — 기한이 지나도 건드리지 않는다', b, () => {
  const r = inv.projectRetainedRecords([...session('i1'), ...session('i2', { prefix: 'y' })], {
    scope, legalHold: ['i1'],
  });
  for (const rec of r.records) assert.equal(rec.legalHold === true, rec.id.endsWith(':i1'));
  assert.equal(r.counters.recordsOnLegalHold, 2);

  const plan = ret.planDisposition(r.records, policy(), NOW);
  assert.equal(plan.held.length, 2);
  assert.ok(plan.due.every((d) => d.recordId.endsWith(':i2')));
});

test('어느 세션에도 걸리지 않은 보류 선언은 드러낸다 — 오타 하나가 분쟁 건을 기한대로 지운다', b, () => {
  const r = inv.projectRetainedRecords(session('i1'), { scope, legalHold: ['i1', 'i-typo'] });
  assert.equal(r.counters.holdsUnmatched, 1);
  assert.match(r.noteKo, /보류 id 를 확인하라/);
});

test('이미 처리된 레코드는 장부대로 적고, 쓸 수 없는 처리 시각은 거부한다', b, () => {
  const r = inv.projectRetainedRecords(session('i1'), {
    scope,
    disposed: { 'interaction_event:i1': '2026-02-20T00:00:00.000Z', 'transcript_masked:i1': '어제' },
  });
  const byId = new Map(r.records.map((x) => [x.id, x]));
  assert.equal(byId.get('interaction_event:i1').disposedAt, '2026-02-20T00:00:00.000Z');
  assert.equal(byId.get('transcript_masked:i1').disposedAt, undefined);
  assert.equal(r.counters.recordsAlreadyDisposed, 1);
  assert.equal(r.counters.disposedMarksRejected, 1);

  const plan = ret.planDisposition(r.records, policy(), NOW);
  assert.deepEqual(plan.decisions.filter((d) => d.status === 'disposed').map((d) => d.recordId), ['interaction_event:i1']);
});

// ── 6) 원장이 모르는 분류 ─────────────────────────────────────────────────────

test('원장에 근거가 없는 분류는 만들지 않고 드러낸다 — 없는 레코드는 장부에만 파기로 남는다', b, () => {
  const r = inv.projectRetainedRecords(session('i1'), { scope });
  assert.deepEqual([...r.classesWithoutEvidence].sort(), [...inv.LEDGER_BLIND_CLASSES].sort());
  assert.ok(r.records.every((x) => !x.id.startsWith('recording:')));
  assert.ok(r.limitsKo.some((l) => l.includes('녹취 레코드 선언이 없다')));
});

test('선언 레코드는 받는다 — 그 선언이 녹취·색인의 유일한 근거다', b, () => {
  const r = inv.projectRetainedRecords(session('i1'), {
    scope,
    declared: [{ id: 'rec/i1.wav', dataClass: 'recording', createdAt: T3 }],
  });
  const rec = r.records.find((x) => x.id === 'rec/i1.wav');
  assert.equal(rec.dataClass, 'recording');
  assert.equal(rec.createdAt, T3);
  assert.equal(r.counters.declaredAccepted, 1);
  assert.equal(r.classesWithoutEvidence.includes('recording'), false);
  assert.equal(r.limitsKo.some((l) => l.includes('녹취 레코드 선언이 없다')), false);
});

test('선언 레코드의 형식·분류·개인정보 식별자·중복은 받지 않고 사유를 남긴다', b, () => {
  const r = inv.projectRetainedRecords([], {
    scope,
    declared: [
      { id: '', dataClass: 'recording', createdAt: T3 },
      { id: 'a', dataClass: 'nope', createdAt: T3 },
      { id: 'b', dataClass: 'recording', createdAt: '2026-01-20' },
      { id: 'rec-01012345678', dataClass: 'recording', createdAt: T3 },
      { id: 'c', dataClass: 'recording', createdAt: T3 },
      { id: 'c', dataClass: 'vector_index', createdAt: T3 },
    ],
  });
  assert.deepEqual(ids(r.records), ['c']);
  assert.equal(r.counters.declaredRejected, 5);
  assert.equal(r.counters.declaredAccepted, 1);
  assert.ok(r.declaredRejectionsKo.some((x) => x.includes('개인정보')));
  assert.ok(r.declaredRejectionsKo.some((x) => x.includes('중복')));
  // 거절 사유에 호스트 값이 실리지 않는다(§10.3).
  assert.equal(r.declaredRejectionsKo.join(' ').includes('01012345678'), false);
});

test('선언 레코드도 투영 스코프의 테넌트로만 들어간다 — 호스트가 테넌트를 주장하지 못한다(§11.1)', b, () => {
  const r = inv.projectRetainedRecords([], {
    scope,
    declared: [{ id: 'rec1', dataClass: 'recording', createdAt: T3, tenantId: 'rival' }],
  });
  assert.equal(r.records[0].tenantId, 't1');
});

// ── 7) 분류 분할·불변식 ───────────────────────────────────────────────────────

test('분류 분할이 §8.2 전체를 덮는다 — 분류를 늘리면 결정을 강제한다', b, () => {
  const declared = [...inv.LEDGER_EVIDENCED_CLASSES, ...inv.LEDGER_BLIND_CLASSES].sort();
  assert.deepEqual(declared, ret.DATA_CLASSES.map((s) => s.id).sort());
  assert.equal(new Set(declared).size, declared.length, '한 분류가 양쪽에 들어가 있다');
});

test('투영은 입력을 고치지 않고 판정을 복사하지 않는다(§2·§13-3)', b, () => {
  const events = session('i1');
  const snapshot = JSON.stringify(events);
  inv.projectRetainedRecords(events, { scope });
  assert.equal(JSON.stringify(events), snapshot);

  const src = readFileSync(SRC, 'utf8');
  for (const forbidden of ['retentionDays', 'DAY_MS', 'Date.now(', 'new Date()']) {
    assert.equal(src.includes(forbidden), false, `보존 판정·시계를 복사하고 있다: ${forbidden}`);
  }
});

test('워크스페이스 단위 파기 목록은 만들지 않는다 — 다른 워크스페이스를 지운다(§11.1)', b, () => {
  assert.throws(
    () => inv.projectRetainedRecords([], { scope: { tenantId: 't1', workspaceId: 'w1' } }),
    /워크스페이스 단위 파기 목록을 만들지 않는다/,
  );
});

test('원장에서 바로 투영할 때 스코프는 원장이 가진 것을 쓴다(§11.1)', b, () => {
  const log = store.createMemoryEventLog(scope);
  log.appendAll(session('i1'));
  const r = inv.projectRetainedRecordsFromLog(log);
  assert.equal(r.scope.tenantId, 't1');
  assert.deepEqual(ids(r.records), ['interaction_event:i1', 'transcript_masked:i1']);
});

test('투영 결과가 planDisposition·executeDisposition 을 그대로 통과한다(배선 확인)', b, async () => {
  const log = store.createMemoryEventLog(scope);
  log.appendAll(session('i1', { utterance: '카드번호 1234-5678-9012-3456 입니다' }));
  const r = inv.projectRetainedRecordsFromLog(log);
  const plan = ret.planDisposition(r.records, policy(), NOW);
  const port = ex.createMemoryDisposalPort();
  const out = await ex.executeDisposition({ scope, plan, port, at: NOW, activation: ON, timeoutMs: 500 });

  assert.deepEqual(port.calls.delete.sort(), ['interaction_event:i1', 'pii_field:i1', 'transcript_masked:i1']);
  assert.equal(out.counts.disposed, 3);
  assert.equal(out.ok, true);
});

// ── 8) 스윕 ───────────────────────────────────────────────────────────────────

test('스윕이 목록을 만들어 실제로 지운다 — 세 호출을 호스트가 꿰지 않는다', b, async () => {
  const log = store.createMemoryEventLog(scope);
  log.appendAll(session('i1'));
  const port = ex.createMemoryDisposalPort();
  const r = await inv.runRetentionSweep({
    inventory: inv.projectRetainedRecordsFromLog(log),
    policy: policy(), port, at: NOW, activation: ON, timeoutMs: 500,
  });

  assert.equal(r.status, 'executed');
  assert.deepEqual(port.calls.delete.sort(), ['interaction_event:i1', 'transcript_masked:i1']);
  assert.equal(r.execution.counts.disposed, 2);
  assert.match(r.messageKo, /처리 2건/);
  assert.deepEqual(r.refusalsKo, []);
});

test('활성화 전에는 포트를 부르지 않는다 [승인 필요]', b, async () => {
  const port = ex.createMemoryDisposalPort();
  const r = await inv.runRetentionSweep({
    inventory: inv.projectRetainedRecords(session('i1'), { scope }),
    policy: policy(), port, at: NOW, timeoutMs: 500,
  });
  assert.equal(r.status, 'dry_run');
  assert.deepEqual(port.calls.delete, []);
  assert.equal(r.execution.counts.dryRun, 2);
  assert.ok(r.warningsKo.some((w) => w.includes('[승인 필요]')));
});

test('목록이 비면 "0건 처리"와 구분해서 적는다 — 스윕이 돈 것과 지울 것이 없는 것은 다르다', b, async () => {
  const port = ex.createMemoryDisposalPort();
  const r = await inv.runRetentionSweep({
    inventory: inv.projectRetainedRecords([], { scope }),
    policy: policy(), port, at: NOW, activation: ON,
  });
  assert.equal(r.status, 'empty');
  assert.match(r.messageKo, /파기 목록이 비었습니다/);
  assert.equal(r.execution, undefined);
  assert.deepEqual(port.calls.delete, []);
});

test('근거를 믿을 수 없는 목록으로는 지우지 않는다 — 저장소를 건드리지 않는다', b, async () => {
  const port = ex.createMemoryDisposalPort();
  const r = await inv.runRetentionSweep({
    inventory: inv.projectRetainedRecords(session('i1'), { scope, maxEvents: 2 }),
    policy: policy(), port, at: NOW, activation: ON,
  });
  assert.equal(r.status, 'refused');
  assert.ok(r.refusalsKo.some((x) => x.includes('근거로 쓸 수 없습니다')));
  assert.equal(r.plan, undefined);
  assert.deepEqual(port.calls.delete, []);
});

test('실행 시각이 오프셋 명시 ISO8601 이 아니면 거부한다(§13-3)', b, async () => {
  const port = ex.createMemoryDisposalPort();
  const r = await inv.runRetentionSweep({
    inventory: inv.projectRetainedRecords(session('i1'), { scope }),
    policy: policy(), port, at: '2026-03-01', activation: ON,
  });
  assert.equal(r.status, 'refused');
  assert.ok(r.refusalsKo.some((x) => x.includes('만료 판정 기준')));
  assert.deepEqual(port.calls.delete, []);
});

test('정책 결함은 스윕을 멈추지 않는다 — 멈추면 기한이 지난 개인정보가 그대로 남는다(§8.2)', b, async () => {
  // transcript_masked 규칙이 없는 정책: 그 분류만 blocked, 나머지는 지워진다.
  const half = { tenantId: 't1', rules: [rule('interaction_event', 30), rule('pii_field', 30)] };
  const port = ex.createMemoryDisposalPort();
  const r = await inv.runRetentionSweep({
    inventory: inv.projectRetainedRecords(session('i1'), { scope }),
    policy: half, port, at: NOW, activation: ON, timeoutMs: 500,
  });

  assert.equal(r.status, 'executed');
  assert.deepEqual(port.calls.delete, ['interaction_event:i1']);
  assert.deepEqual(r.execution.blocked.map((d) => d.recordId), ['transcript_masked:i1']);
  assert.ok(r.warningsKo.some((w) => w.includes('보존 정책 결함')));
  assert.ok(r.warningsKo.some((w) => w.includes('recording')), '규칙 없는 개인정보 분류가 드러나야 한다');
});

test('원장에 근거가 없는 분류는 스윕 경고로 올라온다 — 조용히 빠지지 않는다', b, async () => {
  const port = ex.createMemoryDisposalPort();
  const r = await inv.runRetentionSweep({
    inventory: inv.projectRetainedRecords(session('i1'), { scope }),
    policy: policy(), port, at: NOW, activation: ON, timeoutMs: 500,
  });
  assert.ok(r.classesWithoutEvidence.includes('recording'));
  assert.ok(r.warningsKo.some((w) => w.includes('해당 저장소가 레코드를 선언해야 파기됩니다')));
  assert.ok(r.limitsKo.some((l) => l.includes('이름·주소')));
});

test('다른 테넌트 정책으로 스윕을 돌릴 수 없다(§11.1)', b, async () => {
  await assert.rejects(
    () => inv.runRetentionSweep({
      inventory: inv.projectRetainedRecords(session('i1'), { scope }),
      policy: policy({ tenantId: 'rival' }), port: ex.createMemoryDisposalPort(), at: NOW,
    }),
    /파기 목록과 다릅니다/,
  );
});

test('스윕 결과에 감사 체인이 붙는다 — 기록은 executeDisposition 한 곳이 만든다(§2)', b, async () => {
  const hash = (s) => `h(${s.length})`;
  const r = await inv.runRetentionSweep({
    inventory: inv.projectRetainedRecords(session('i1'), { scope }),
    policy: policy(),
    port: ex.createMemoryDisposalPort(),
    at: NOW,
    activation: ON,
    timeoutMs: 500,
    audit: {
      chain: audit.emptyChain(scope),
      actor: { userId: 'worker', roles: ['tenant_admin'] },
      hash,
      newRecordId: (seq) => `aud${seq}`,
    },
  });
  assert.equal(r.execution.chain.records.length, 2);
  assert.ok(r.execution.chain.records.every((x) => x.result === 'success'));
});

// ── 9) retention.ts 결함 고정 ─────────────────────────────────────────────────

test('손상된 기산 시각 한 건이 그날 스윕 전체를 멈추지 않는다(§9.3)', b, () => {
  const records = [
    { id: 'a', tenantId: 't1', dataClass: 'interaction_event', createdAt: T1 },
    { id: 'broken', tenantId: 't1', dataClass: 'interaction_event', createdAt: '언젠가' },
    { id: 'c', tenantId: 't1', dataClass: 'pii_field', createdAt: T1 },
  ];
  const plan = ret.planDisposition(records, policy(), NOW);   // 구버전은 여기서 던졌다
  assert.deepEqual(plan.due.map((d) => d.recordId), ['a', 'c']);
  assert.deepEqual(plan.blocked.map((d) => d.recordId), ['broken']);
  assert.match(plan.blocked[0].reasonKo, /파기 기한을 산출할 수 없다/);
  // 값을 되싣지 않는다(§10.3).
  assert.equal(plan.blocked[0].reasonKo.includes('언젠가'), false);
});

test('현재 시각 오류는 여전히 던진다 — 모든 판정이 똑같이 무의미한 설정 오류다', b, () => {
  assert.throws(
    () => ret.decide({ id: 'a', tenantId: 't1', dataClass: 'interaction_event', createdAt: T1 }, policy(), '언젠가'),
    /현재 시각을 해석할 수 없다/,
  );
});

test('워크스페이스 정책은 다른 워크스페이스·미선언 레코드를 파기 계획에 담지 않는다(§11.1)', b, () => {
  const pol = policy({ workspaceId: 'w1' });
  const mine = { id: 'a', tenantId: 't1', workspaceId: 'w1', dataClass: 'interaction_event', createdAt: T1 };
  assert.equal(ret.planDisposition([mine], pol, NOW).due.length, 1);

  assert.throws(
    () => ret.planDisposition([mine, { ...mine, id: 'b', workspaceId: 'w2' }], pol, NOW),
    /다른 워크스페이스 레코드 포함/,
  );
  assert.throws(
    () => ret.planDisposition([{ ...mine, id: 'c', workspaceId: undefined }], pol, NOW),
    /미선언/,
  );
  // 테넌트 전역 정책은 종전과 같다 — 레코드의 워크스페이스를 보지 않는다.
  assert.equal(ret.planDisposition([{ ...mine, workspaceId: 'w2' }], policy(), NOW).due.length, 1);
});

test('격리 위반 사유에 식별자 원문이 실리지 않는다(§10.3)', b, () => {
  assert.throws(
    () => ret.planDisposition([{ id: 'call-01012345678', tenantId: 'rival', dataClass: 'recording', createdAt: T1 }], policy(), NOW),
    (e) => /타 테넌트 레코드/.test(e.message) && !e.message.includes('01012345678'),
  );
});

test('정책 검증은 채우는 중인 폼에서 던지지 않는다 — 빈 화면이 되면 오류를 못 본다', b, () => {
  const errs = ret.validateRetentionPolicy({ tenantId: 't1' });
  assert.ok(errs.some((e) => e.includes('보존 규칙 목록')));
  assert.ok(errs.some((e) => e.includes('recording')));

  const partial = ret.validateRetentionPolicy({ tenantId: 't1', rules: [{ dataClass: 'recording', retentionDays: 30, disposition: 'delete', approved: true }] });
  assert.ok(partial.some((e) => e.includes('보존 근거가 비어')));
  assert.deepEqual(ret.validateRetentionPolicy(policy()), []);
});
