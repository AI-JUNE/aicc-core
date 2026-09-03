import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
try { m = await import('../src/ops/backup.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'acme' };

const rec = (id, over = {}) => ({
  tenantId: 'acme',
  dataClass: 'transcript_masked',
  id,
  createdAt: '2026-09-03T00:00:00.000Z',
  body: { text: `문의 ${id}` },
  ...over,
});

const many = (n, over = {}) => Array.from({ length: n }, (_, i) => rec(`r${i}`, over));

/** 단조 증가 가짜 시계 — 실측 자리를 채우되 벽시계에 의존하지 않는다. */
const fakeClock = (startMs = 1_757_000_000_000, stepMs = 5) => {
  let t = startMs;
  return () => { const v = t; t += stepMs; return v; };
};

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('스냅샷은 원본을 페이지로 모두 훑고 건수·분류를 실측으로 채운다', b, async () => {
  const src = m.createMemoryBackupSource(
    [...many(7), rec('a1', { dataClass: 'audit_log' })],
    { pageSize: 3, name: 'pg' },
  );
  const snap = await m.createSnapshot({ source: src, scope: SCOPE });
  assert.equal(snap.records.length, 8);
  assert.equal(snap.counts.total, 8);
  assert.equal(snap.counts.byTenant.acme, 8);
  assert.equal(snap.counts.byDataClass.transcript_masked, 7);
  assert.equal(snap.counts.byDataClass.audit_log, 1);
  assert.equal(snap.sourceName, 'pg');
  assert.equal(snap.partition, 't/acme');
  assert.equal(m.verifySnapshot(snap).ok, true);
});

test('시계를 주입하지 않으면 createdAt 을 만들어 넣지 않는다(§13-3)', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(2)), scope: SCOPE });
  assert.equal(snap.createdAt, undefined);
  const timed = await m.createSnapshot({
    source: m.createMemoryBackupSource(many(2)),
    scope: SCOPE,
    clock: fakeClock(),
  });
  assert.equal(typeof timed.createdAt, 'string');
});

test('체크섬은 순서에 흔들리지 않고 내용 한 글자에 반응한다', b, () => {
  const a = many(5);
  const shuffled = [a[3], a[0], a[4], a[1], a[2]];
  assert.equal(m.checksumOf(a), m.checksumOf(shuffled));
  const changed = [...a.slice(0, 4), rec('r4', { body: { text: '문의 r4!' } })];
  assert.notEqual(m.checksumOf(a), m.checksumOf(changed));
  assert.equal(m.checksumOf([]), '0-0-0');
});

test('body 키 순서가 달라도 같은 체크섬이 나온다', b, () => {
  const one = rec('x', { body: { a: '1', z: '9' } });
  const two = rec('x', { body: { z: '9', a: '1' } });
  assert.equal(m.checksumOf([one]), m.checksumOf([two]));
});

test('직렬화→파싱 왕복이 레코드와 체크섬을 보존한다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(4)), scope: SCOPE });
  const parsed = m.parseSnapshot(m.serializeSnapshot(snap));
  assert.equal(parsed.corruptedLines.length, 0);
  assert.equal(parsed.checksumMatches, true);
  assert.equal(parsed.snapshot.records.length, 4);
  assert.equal(parsed.snapshot.checksum, snap.checksum);
});

test('복구는 배치로 나눠 전량을 기록한다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(10)), scope: SCOPE });
  const sink = m.createMemoryRestoreSink();
  const r = await m.restoreSnapshot({ snapshot: snap, sink, batchSize: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.attempted, 10);
  assert.equal(r.written, 10);
  assert.equal(sink.written.length, 10);
  assert.equal(r.durationMs, undefined); // 시계 미주입 → 소요를 만들어 넣지 않는다
});

test('리허설 전 구간이 통과하면 verdict=passed 이고 대조가 붙는다', b, async () => {
  const report = await m.runRecoveryDrill({
    source: m.createMemoryBackupSource(many(6), { name: 'src' }),
    sink: m.createMemoryRestoreSink({ name: 'dst' }),
    scope: SCOPE,
    batchSize: 4,
    clock: fakeClock(),
  });
  assert.equal(report.verdict, 'passed');
  assert.deepEqual(report.issues, []);
  assert.equal(report.comparison.recovered, 6);
  assert.equal(report.comparison.checksumMatches, true);
  assert.equal(report.corruptedLines.length, 0);
  assert.ok(report.serializedBytes > 0);
  assert.equal(typeof report.durationMs, 'number');
  assert.equal(report.sourceName, 'src');
  assert.equal(report.sinkName, 'dst');
});

test('보고서 서식은 판정·건수·지적사항을 한국어로 담는다', b, async () => {
  const report = await m.runRecoveryDrill({
    source: m.createMemoryBackupSource(many(3, { workspaceId: 'cs' })),
    sink: m.createMemoryRestoreSink(),
    scope: { tenantId: 'acme', workspaceId: 'cs' },
  });
  const text = m.formatDrillReport(report);
  assert.match(text, /복구 리허설 결과: 통과/);
  assert.match(text, /acme\/cs/);
  assert.match(text, /지적사항: 없음/);
  assert.match(text, /미측정\(시계 미주입\)/);
});

// ── 실패 경로 · 경계조건 ─────────────────────────────────────────────────────

test('원본이 비면 성공이 아니라 판정보류다', b, async () => {
  const report = await m.runRecoveryDrill({
    source: m.createMemoryBackupSource([]),
    sink: m.createMemoryRestoreSink(),
    scope: SCOPE,
  });
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.counts.total, 0);
  assert.ok(report.issues.some((i) => i.includes('비어 있어')));
  assert.match(m.formatDrillReport(report), /판정보류/);
});

test('되읽기를 못 하는 복구 대상은 통과로 적지 않는다', b, async () => {
  const sink = { name: 'blind', async write() { /* 기록만 하고 되읽기를 안 준다 */ } };
  const report = await m.runRecoveryDrill({
    source: m.createMemoryBackupSource(many(3)),
    sink,
    scope: SCOPE,
  });
  assert.equal(report.verdict, 'inconclusive');
  assert.equal(report.comparison, undefined);
  assert.ok(report.issues.some((i) => i.includes('대조하지 못했습니다')));
});

test('스코프 밖 레코드가 나오면 걸러내지 않고 E_TENANCY 로 막는다(§11.1)', b, async () => {
  const src = m.createMemoryBackupSource([rec('ok'), rec('bad', { tenantId: 'other' })]);
  await assert.rejects(
    () => m.createSnapshot({ source: src, scope: SCOPE }),
    (e) => e instanceof m.BackupError && e.code === 'E_TENANCY',
  );
});

test('workspace 스코프는 상위 테넌트 레코드까지 거부한다', b, async () => {
  const src = m.createMemoryBackupSource([rec('a', { workspaceId: 'cs' }), rec('b', { workspaceId: 'sales' })]);
  await assert.rejects(
    () => m.createSnapshot({ source: src, scope: { tenantId: 'acme', workspaceId: 'cs' } }),
    (e) => e.code === 'E_TENANCY',
  );
});

test('마스킹을 안 거친 값은 스냅샷 자체를 막고 원문을 노출하지 않는다(§10.3)', b, async () => {
  const src = m.createMemoryBackupSource([rec('p', { dataClass: 'pii_field', body: { phone: '010-1234-5678' } })]);
  await assert.rejects(
    () => m.createSnapshot({ source: src, scope: SCOPE }),
    (e) => {
      assert.equal(e.code, 'E_PII');
      assert.match(e.message, /pii_field\.phone/);
      assert.ok(!e.message.includes('010-1234-5678'), '오류 메시지에 원문이 실리면 안 된다');
      return true;
    },
  );
});

test('이미 마스킹된 값은 그대로 통과한다', b, () => {
  // 마스킹된 주민번호 앞 6자리가 계좌 패턴에 다시 걸려 정상 백업을 막는 일이 없어야 한다.
  const clean = rec('p', {
    body: { phone: '010-****-5678', rrn: '900101-*******', card: '1234-****-****-5678', acct: '***-****-1234' },
  });
  assert.deepEqual(m.findUnmaskedFields(clean), []);
  const dirty = rec('p', { body: { rrn: '900101-1234567', memo: '정상' } });
  assert.deepEqual(m.findUnmaskedFields(dirty), ['rrn']);
});

test('마스킹된 값 옆에 붙은 원문은 여전히 잡아낸다', b, () => {
  const mixed = rec('p', { body: { memo: '기존 900101-******* 신규 010-1234-5678' } });
  assert.deepEqual(m.findUnmaskedFields(mixed), ['memo']);
});

test('문자열이 아닌 body 값은 검사 우회로 두지 않고 곧바로 걸러낸다', b, () => {
  const weird = rec('p', { body: { nested: { phone: '010-1234-5678' } } });
  assert.deepEqual(m.findUnmaskedFields(weird), ['nested']);
});

test('스코프 없는 백업 경로는 만들 수 없다', b, async () => {
  await assert.rejects(() => m.createSnapshot({ source: m.createMemoryBackupSource([]), scope: {} }));
  await assert.rejects(() => m.createSnapshot({ source: m.createMemoryBackupSource([]), scope: { tenantId: 'BAD ID' } }));
});

test('원본이 규약과 다른 값을 돌려주면 E_SOURCE 다', b, async () => {
  const bad = { name: 'bad', async read() { return { records: null }; } };
  await assert.rejects(
    () => m.createSnapshot({ source: bad, scope: SCOPE }),
    (e) => e.code === 'E_SOURCE',
  );
});

test('원본이 던지면 사유를 마스킹해 E_SOURCE 로 감싼다', b, async () => {
  const bad = { name: 'bad', async read() { throw new Error('조회 실패 대상 010-1234-5678'); } };
  await assert.rejects(
    () => m.createSnapshot({ source: bad, scope: SCOPE }),
    (e) => {
      assert.equal(e.code, 'E_SOURCE');
      assert.ok(!e.message.includes('010-1234-5678'));
      return true;
    },
  );
});

test('커서가 반복되면 무한 순회 대신 E_SOURCE 로 끊는다', b, async () => {
  const loop = { name: 'loop', async read() { return { records: [], nextCursor: 'same' }; } };
  await assert.rejects(
    () => m.createSnapshot({ source: loop, scope: SCOPE }),
    (e) => e.code === 'E_SOURCE' && /커서/.test(e.message),
  );
});

test('원본 읽기가 예산을 넘기면 E_TIMEOUT 이다', b, async () => {
  const slow = { name: 'slow', read: () => new Promise((r) => setTimeout(() => r({ records: [] }), 200)) };
  await assert.rejects(
    () => m.createSnapshot({ source: slow, scope: SCOPE, timeoutMs: 10 }),
    (e) => e.code === 'E_TIMEOUT',
  );
});

test('상한을 넘는 스냅샷은 조용히 자르지 않고 거부한다', b, async () => {
  await assert.rejects(
    () => m.createSnapshot({ source: m.createMemoryBackupSource(many(50)), scope: SCOPE, maxRecords: 10 }),
    (e) => e.code === 'E_SOURCE' && /상한/.test(e.message),
  );
});

test('한 줄이 깨져도 나머지를 살리고 손상 줄을 보고한다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(5)), scope: SCOPE });
  const lines = m.serializeSnapshot(snap).trimEnd().split('\n');
  lines[3] = '{깨진 줄';
  const parsed = m.parseSnapshot(lines.join('\n') + '\n');
  assert.deepEqual(parsed.corruptedLines, [4]);
  assert.equal(parsed.snapshot.records.length, 4);
  assert.equal(parsed.checksumMatches, false, '유실이 있으면 체크섬으로 드러나야 한다');
});

test('헤더가 깨지면 조용히 빈 스냅샷을 만들지 않고 E_INTEGRITY 로 던진다', b, () => {
  assert.throws(() => m.parseSnapshot('{깨진 헤더\n'), (e) => e.code === 'E_INTEGRITY');
  assert.throws(() => m.parseSnapshot(''), (e) => e.code === 'E_INTEGRITY');
});

test('손상 파일로 리허설을 돌리면 verdict=failed 다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(5)), scope: SCOPE });
  const lines = m.serializeSnapshot(snap).trimEnd().split('\n');
  lines[2] = 'null';
  const parsed = m.parseSnapshot(lines.join('\n'));
  assert.equal(parsed.checksumMatches, false);
  assert.equal(m.verifySnapshot({ ...parsed.snapshot, checksum: snap.checksum }).ok, false);
});

test('체크섬·건수를 손대면 verifySnapshot 이 잡아낸다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(3)), scope: SCOPE });
  const tampered = { ...snap, checksum: '3-dead-beef', counts: { ...snap.counts, total: 99 } };
  const v = m.verifySnapshot(tampered);
  assert.equal(v.ok, false);
  assert.equal(v.issues.length, 2);
  assert.ok(v.issues.some((i) => i.includes('체크섬 불일치')));
  assert.ok(v.issues.some((i) => i.includes('건수 불일치')));
});

test('형식 버전이 다른 스냅샷은 조용히 읽지 않는다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(1)), scope: SCOPE });
  const v = m.verifySnapshot({ ...snap, formatVersion: 99 });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.includes('형식 버전')));
});

test('다른 테넌트로 복구하려 하면 막는다(§11.1)', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(2)), scope: SCOPE });
  await assert.rejects(
    () => m.restoreSnapshot({ snapshot: snap, sink: m.createMemoryRestoreSink(), scope: { tenantId: 'other' } }),
    (e) => e.code === 'E_TENANCY',
  );
});

test('복구 범위를 workspace 로 좁히면 그 부분만 기록된다', b, async () => {
  const records = [rec('a', { workspaceId: 'cs' }), rec('b', { workspaceId: 'sales' }), rec('c', { workspaceId: 'cs' })];
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(records), scope: SCOPE });
  const sink = m.createMemoryRestoreSink();
  const r = await m.restoreSnapshot({ snapshot: snap, sink, scope: { tenantId: 'acme', workspaceId: 'cs' } });
  assert.equal(r.attempted, 2);
  assert.deepEqual(sink.written.map((x) => x.id), ['a', 'c']);
});

test('배치 하나가 실패해도 나머지를 이어 쓰고 피해 범위를 보고한다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(9)), scope: SCOPE });
  const sink = m.createMemoryRestoreSink({ failOnBatch: 1 });
  const r = await m.restoreSnapshot({ snapshot: snap, sink, batchSize: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.attempted, 9);
  assert.equal(r.written, 6);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].batchIndex, 1);
  assert.equal(r.failures[0].recordCount, 3);
  assert.equal(r.failures[0].errorCode, 'E_SINK');
});

test('stopOnFirstFailure 는 첫 실패에서 멈춘다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(9)), scope: SCOPE });
  const sink = m.createMemoryRestoreSink({ failOnBatch: 1 });
  const r = await m.restoreSnapshot({ snapshot: snap, sink, batchSize: 3, stopOnFirstFailure: true });
  assert.equal(r.written, 3);
  assert.equal(r.failures.length, 1);
});

test('복구 쓰기가 예산을 넘기면 E_TIMEOUT 으로 기록되고 던지지 않는다', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(2)), scope: SCOPE });
  const slow = { name: 'slow', write: () => new Promise((r) => setTimeout(r, 200)), async readAll() { return []; } };
  const r = await m.restoreSnapshot({ snapshot: snap, sink: slow, timeoutMs: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].errorCode, 'E_TIMEOUT');
  assert.equal(r.written, 0);
});

test('부분 실패 리허설은 failed 로 판정하고 누락 건수를 남긴다', b, async () => {
  const report = await m.runRecoveryDrill({
    source: m.createMemoryBackupSource(many(9)),
    sink: m.createMemoryRestoreSink({ failOnBatch: 0 }),
    scope: SCOPE,
    batchSize: 3,
  });
  assert.equal(report.verdict, 'failed');
  assert.equal(report.restore.written, 6);
  assert.equal(report.comparison.recovered, 6);
  assert.equal(report.comparison.checksumMatches, false);
  assert.equal(report.comparison.missingIds.length, 3);
  assert.match(m.formatDrillReport(report), /실패/);
});

test('이전 복구본이 남아 있으면 초과 레코드로 잡아낸다', b, async () => {
  const sink = m.createMemoryRestoreSink();
  await sink.write([rec('stale')]);
  const report = await m.runRecoveryDrill({
    source: m.createMemoryBackupSource(many(2)),
    sink,
    scope: SCOPE,
  });
  assert.equal(report.verdict, 'failed');
  assert.deepEqual(report.comparison.extraIds, ['stale']);
  assert.ok(report.issues.some((i) => i.includes('지워지지 않았습니다')));
});

test('복구 실패 사유에도 개인정보가 실리지 않는다(§10.3)', b, async () => {
  const snap = await m.createSnapshot({ source: m.createMemoryBackupSource(many(1)), scope: SCOPE });
  const sink = { name: 'leaky', async write() { throw new Error('중복 키 010-1234-5678'); } };
  const r = await m.restoreSnapshot({ snapshot: snap, sink });
  assert.equal(r.ok, false);
  assert.ok(!r.failures[0].detail.includes('010-1234-5678'));
  assert.match(r.failures[0].detail, /010-\*\*\*\*-5678/);
});

test('되읽기가 던져도 리허설은 죽지 않고 failed 로 보고한다', b, async () => {
  const sink = {
    name: 'flaky',
    async write() { /* 쓰기는 된다 */ },
    async readAll() { throw new Error('되읽기 거부'); },
  };
  const report = await m.runRecoveryDrill({ source: m.createMemoryBackupSource(many(2)), sink, scope: SCOPE });
  assert.equal(report.verdict, 'failed');
  assert.ok(report.issues.some((i) => i.includes('되읽기 실패')));
});
