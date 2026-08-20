import { test } from 'node:test';
import assert from 'node:assert/strict';

let t = null;
try {
  t = await import('../src/core/tenancy.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: t ? false : '타입 스트리핑 미지원 런타임' };

test('§11.1 tenant_id 없거나 형식 위반이면 접근 자체가 막힌다', behavioral, () => {
  assert.throws(() => t.assertTenantScope({ tenantId: '' }), /§11.1/);
  assert.throws(() => t.assertTenantScope({ tenantId: 'ACME' }), /형식 위반/);
  assert.throws(() => t.assertTenantScope({ tenantId: 'a/b' }), /형식 위반/);
  assert.throws(() => t.assertTenantScope({ tenantId: 'acme', workspaceId: 'W 1' }), /workspace_id/);
  assert.doesNotThrow(() => t.assertTenantScope({ tenantId: 'acme', workspaceId: 'cs-team' }));
});

test('파티션 키·벡터 네임스페이스 왕복', behavioral, () => {
  assert.equal(t.partitionKey({ tenantId: 'acme' }), 't/acme');
  assert.equal(t.partitionKey({ tenantId: 'acme', workspaceId: 'cs' }), 't/acme/w/cs');

  const ns = t.vectorNamespace({ tenantId: 'acme', workspaceId: 'cs' }, 'faq');
  assert.equal(ns, 't/acme/w/cs/kb/faq');
  assert.deepEqual(t.parseVectorNamespace(ns), { tenantId: 'acme', workspaceId: 'cs', knowledgeBaseId: 'faq' });
  assert.deepEqual(t.parseVectorNamespace('t/acme/kb/faq'), { tenantId: 'acme', knowledgeBaseId: 'faq' });
  assert.throws(() => t.parseVectorNamespace('faq'), /§11.1/);
  assert.throws(() => t.vectorNamespace({ tenantId: 'acme' }, 'FAQ'), /knowledge_base_id/);
});

test('네임스페이스 소유 판정 — 워크스페이스 스코프는 좁게 본다', behavioral, () => {
  assert.equal(t.namespaceBelongsTo('t/acme/kb/faq', { tenantId: 'acme' }), true);
  assert.equal(t.namespaceBelongsTo('t/other/kb/faq', { tenantId: 'acme' }), false);
  assert.equal(t.namespaceBelongsTo('t/acme/w/cs/kb/faq', { tenantId: 'acme' }), true);
  assert.equal(t.namespaceBelongsTo('t/acme/w/sales/kb/faq', { tenantId: 'acme', workspaceId: 'cs' }), false);
  assert.equal(t.namespaceBelongsTo('쓰레기', { tenantId: 'acme' }), false);
});

test('RAG 교차유출: 남의 네임스페이스 결과는 예외로 끊는다', behavioral, () => {
  const mine = { id: '1', score: 0.9, namespace: 't/acme/kb/faq' };
  const theirs = { id: '2', score: 0.8, namespace: 't/rival/kb/faq' };
  assert.deepEqual(t.guardVectorHits([mine], { tenantId: 'acme' }), [mine]);
  assert.throws(() => t.guardVectorHits([mine, theirs], { tenantId: 'acme' }), /교차 테넌트/);
});

test('scopedVectorStore는 네임스페이스를 강제하고 결과를 재검증한다', behavioral, async () => {
  const calls = [];
  const leaky = {
    async upsert(ns, docs) { calls.push(['upsert', ns, docs.length]); },
    async query(ns) {
      calls.push(['query', ns]);
      // 스토어 구현이 필터를 빠뜨린 상황을 재현한다
      return [
        { id: 'a', score: 0.9, namespace: ns },
        { id: 'b', score: 0.7, namespace: 't/rival/kb/faq' },
      ];
    },
    async deleteNamespace(ns) { calls.push(['delete', ns]); },
  };

  const store = t.scopedVectorStore(leaky, { tenantId: 'acme' });
  await store.upsert('faq', [{ id: 'a', text: 'x', embedding: [0] }]);
  assert.deepEqual(calls[0], ['upsert', 't/acme/kb/faq', 1]);

  await assert.rejects(() => store.query('faq', [0], 3), /교차 테넌트/);

  await store.purge('faq');
  assert.deepEqual(calls.at(-1), ['delete', 't/acme/kb/faq']);
});

test('레코드 소유 검증과 조회 조건 강제 주입', behavioral, () => {
  const rows = [{ tenantId: 'acme' }, { tenantId: 'acme', workspaceId: 'cs' }];
  assert.doesNotThrow(() => t.assertOwned(rows, { tenantId: 'acme' }, 'interactions'));
  assert.throws(
    () => t.assertOwned([...rows, { tenantId: 'rival' }], { tenantId: 'acme' }, 'interactions'),
    /격리 위반\(interactions\)/,
  );
  // 호출자가 tenantId를 덮어써도 스코프가 이긴다
  assert.deepEqual(
    t.scopedFilter({ tenantId: 'acme' }, { tenantId: 'rival', status: 'open' }),
    { tenantId: 'acme', status: 'open' },
  );
});
