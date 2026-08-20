import { test } from 'node:test';
import assert from 'node:assert/strict';

let r = null;
try {
  r = await import('../src/core/retention.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: r ? false : '타입 스트리핑 미지원 런타임' };

const rule = (dataClass, retentionDays, over = {}) => ({
  dataClass,
  retentionDays,
  disposition: 'delete',
  basisKo: '테넌트 법적 검토 결과',
  approved: true,
  ...over,
});

// 개인정보 포함 분류 4종은 규칙이 반드시 있어야 통과한다
const fullPolicy = (over = []) => ({
  tenantId: 'acme',
  rules: [
    rule('recording', 30),
    rule('pii_field', 30),
    rule('consent_record', 365, { disposition: 'archive' }),
    rule('interaction_event', 90),
    ...over,
  ],
});

test('§8.2 데이터 분류에 임의 보존일수 기본값이 박혀 있지 않다(§13-3)', behavioral, () => {
  for (const spec of r.DATA_CLASSES) {
    assert.equal('retentionDays' in spec, false, spec.id);
    assert.ok(spec.titleKo.length > 0);
  }
  assert.throws(() => r.dataClassSpec('nope'), /알 수 없는 데이터 분류/);
});

test('정책 검증: 개인정보 분류에 규칙이 없으면 오류', behavioral, () => {
  assert.deepEqual(r.validateRetentionPolicy(fullPolicy()), []);

  const missing = r.validateRetentionPolicy({ tenantId: 'acme', rules: [rule('interaction_event', 90)] });
  assert.ok(missing.some((e) => e.includes('recording')));
  assert.ok(missing.some((e) => e.includes('pii_field')));
  assert.ok(missing.some((e) => e.includes('consent_record')));
});

test('정책 검증: 기간·근거·중복·미승인', behavioral, () => {
  const errs = r.validateRetentionPolicy({
    tenantId: '',
    rules: [
      rule('recording', 0),
      rule('recording', 30),
      rule('pii_field', 30, { basisKo: '  ' }),
      rule('consent_record', 365, { approved: false }),
    ],
  });
  assert.ok(errs.some((e) => e.includes('tenant_id 누락')));
  assert.ok(errs.some((e) => e.includes('1일 이상')));
  assert.ok(errs.some((e) => e.includes('분류 중복')));
  assert.ok(errs.some((e) => e.includes('근거가 비어')));
  assert.ok(errs.some((e) => e.includes('[승인 필요]')));
});

test('expiresAt은 기산 시각 + 보존기간', behavioral, () => {
  assert.equal(r.expiresAt('2026-01-01T00:00:00.000Z', 30), '2026-01-31T00:00:00.000Z');
  assert.throws(() => r.expiresAt('언젠가', 30), /해석할 수 없다/);
  assert.throws(() => r.expiresAt('2026-01-01T00:00:00.000Z', 0), /유효하지 않다/);
});

test('만료 판정: 보존중·만료·법적보류·처리완료·차단', behavioral, () => {
  const p = fullPolicy([rule('audit_log', 365, { approved: false, disposition: 'archive' })]);
  const now = '2026-03-01T00:00:00.000Z';
  const rec = (over) => ({ id: 'x', tenantId: 'acme', dataClass: 'recording', createdAt: '2026-02-25T00:00:00.000Z', ...over });

  assert.equal(r.decide(rec({}), p, now).status, 'retained');

  const old = rec({ createdAt: '2026-01-01T00:00:00.000Z' });
  const due = r.decide(old, p, now);
  assert.equal(due.status, 'due');
  assert.equal(due.disposition, 'delete');
  assert.equal(due.expiresAt, '2026-01-31T00:00:00.000Z');

  assert.equal(r.decide({ ...old, legalHold: true }, p, now).status, 'held');
  assert.equal(r.decide({ ...old, disposedAt: now }, p, now).status, 'disposed');
  assert.equal(r.decide(rec({ dataClass: 'vector_index' }), p, now).status, 'blocked');
  assert.equal(r.decide(rec({ dataClass: 'audit_log' }), p, now).status, 'blocked');
  assert.match(r.decide(rec({ dataClass: 'audit_log' }), p, now).reasonKo, /\[승인 필요\]/);
});

test('planDisposition은 계획만 만들고 타 테넌트 레코드를 거부한다(§11.1)', behavioral, () => {
  const p = fullPolicy();
  const now = '2026-03-01T00:00:00.000Z';
  const records = [
    { id: 'a', tenantId: 'acme', dataClass: 'recording', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', tenantId: 'acme', dataClass: 'recording', createdAt: '2026-02-28T00:00:00.000Z' },
    { id: 'c', tenantId: 'acme', dataClass: 'recording', createdAt: '2026-01-01T00:00:00.000Z', legalHold: true },
    { id: 'd', tenantId: 'acme', dataClass: 'vector_index', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const plan = r.planDisposition(records, p, now);
  assert.deepEqual(plan.due.map((d) => d.recordId), ['a']);
  assert.deepEqual(plan.held.map((d) => d.recordId), ['c']);
  assert.deepEqual(plan.blocked.map((d) => d.recordId), ['d']);
  assert.equal(plan.decisions.length, 4);
  assert.equal(plan.tenantId, 'acme');
  // 실행 부작용 없음 — 입력 레코드는 그대로다
  assert.equal(records[0].disposedAt, undefined);

  assert.throws(
    () => r.planDisposition([...records, { id: 'z', tenantId: 'rival', dataClass: 'recording', createdAt: now }], p, now),
    /타 테넌트 레코드/,
  );
});
