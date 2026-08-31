import { test } from 'node:test';
import assert from 'node:assert/strict';

let q = null;
try { q = await import('../src/portal/interactionQuery.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: q ? false : '타입 스트리핑 미지원 런타임' };

const limits = { maxPeriodDays: 92, maxLimit: 100 };
const base = () => ({
  scope: { tenantId: 't1' },
  period: { fromIso: '2026-01-01T00:00:00.000Z', toIso: '2026-01-31T00:00:00.000Z' },
  limit: 20,
});

const row = (over = {}) => ({
  id: 'i1', tenantId: 't1', startedAt: '2026-01-10T00:00:00.000Z',
  channels: ['voice'], outcome: 'AUTO_RESOLVED', intents: ['balance_inquiry'],
  transcriptMasked: '잔액을 안내드렸습니다', durationMs: 60000, ...over,
});

test('§7 2.2 기간 없는·역전된 조회는 막힌다', b, () => {
  const bad = { ...base(), period: { fromIso: '2026-02-01T00:00:00.000Z', toIso: '2026-01-01T00:00:00.000Z' } };
  assert.ok(q.validateQuery(bad, limits).some((i) => i.field === 'period'));
  const tooWide = { ...base(), period: { fromIso: '2020-01-01T00:00:00.000Z', toIso: '2026-01-01T00:00:00.000Z' } };
  assert.ok(q.validateQuery(tooWide, limits).some((i) => i.field === 'period'));
});

test('§10.3 개인정보 패턴은 검색어로 쓸 수 없다', b, () => {
  const issues = q.validateQuery({ ...base(), keyword: '900101-1234567' }, limits);
  assert.ok(issues.some((i) => i.field === 'keyword'));
  assert.equal(q.validateQuery({ ...base(), keyword: '잔액' }, limits).length, 0);
});

test('§11.1 스코프 없는 질의는 검증에서 걸린다', b, () => {
  const issues = q.validateQuery({ ...base(), scope: { tenantId: '' } }, limits);
  assert.ok(issues.some((i) => i.field === 'scope'));
});

test('§7 2.2 채널·인텐트·결과·키워드 필터가 동작한다', b, () => {
  const rows = [
    row(),
    row({ id: 'i2', channels: ['chat'], intents: ['card_lost'], outcome: 'TRANSFERRED', transcriptMasked: '카드 분실 접수', handoffReason: 'customer_request' }),
    row({ id: 'i3', startedAt: '2025-12-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(q.runQuery(rows, { ...base(), channels: ['chat'] }).rows.map((r) => r.id), ['i2']);
  assert.deepEqual(q.runQuery(rows, { ...base(), intents: ['balance_inquiry'] }).rows.map((r) => r.id), ['i1']);
  assert.deepEqual(q.runQuery(rows, { ...base(), outcomes: ['TRANSFERRED'] }).rows.map((r) => r.id), ['i2']);
  assert.deepEqual(q.runQuery(rows, { ...base(), keyword: '카드' }).rows.map((r) => r.id), ['i2']);
  assert.deepEqual(q.runQuery(rows, { ...base(), hasHandoff: true }).rows.map((r) => r.id), ['i2']);
  // 기간 밖(i3)은 제외
  assert.equal(q.runQuery(rows, base()).rows.length, 2);
});

test('§11.1 다른 테넌트 행은 결과에 오지 않고 위반으로 계수된다', b, () => {
  const page = q.runQuery([row(), row({ id: 'x1', tenantId: 't2' })], base());
  assert.deepEqual(page.rows.map((r) => r.id), ['i1']);
  assert.equal(page.scopeViolationsDropped, 1);
});

test('§7 2.2 커서 페이징은 중복·누락 없이 이어진다', b, () => {
  const rows = [1, 2, 3, 4, 5].map((n) => row({ id: `i${n}`, startedAt: `2026-01-0${n}T00:00:00.000Z` }));
  const p1 = q.runQuery(rows, { ...base(), limit: 2, sort: { field: 'started_at', order: 'asc' } });
  assert.deepEqual(p1.rows.map((r) => r.id), ['i1', 'i2']);
  const p2 = q.runQuery(rows, { ...base(), limit: 2, sort: { field: 'started_at', order: 'asc' }, cursor: p1.nextCursor });
  assert.deepEqual(p2.rows.map((r) => r.id), ['i3', 'i4']);
  const p3 = q.runQuery(rows, { ...base(), limit: 2, sort: { field: 'started_at', order: 'asc' }, cursor: p2.nextCursor });
  assert.deepEqual(p3.rows.map((r) => r.id), ['i5']);
  assert.equal(p3.nextCursor, undefined);
});

test('§11.1 저장소 필터는 테넌트 파티션에 묶인다', b, () => {
  const f = q.toStorageFilter({ ...base(), scope: { tenantId: 't1', workspaceId: 'w1' }, channels: ['voice'] });
  assert.equal(f.partition, 't/t1/w/w1');
  assert.ok(f.conditions.some((c) => c.field === 'started_at' && c.op === 'gte'));
  assert.ok(f.conditions.some((c) => c.field === 'started_at' && c.op === 'lt'));
});

test('§10 조회 감사 기록은 검색어를 마스킹해 남긴다', b, () => {
  const a = q.buildQueryAudit({ ...base(), keyword: '010-1234-5678' }, { actorId: 'u1', atIso: '2026-01-31T00:00:00.000Z', resultCount: 3 });
  assert.equal(a.tenantId, 't1');
  assert.equal(a.resultCount, 3);
  assert.ok(!a.keywordMasked.includes('1234-5678'));
});
