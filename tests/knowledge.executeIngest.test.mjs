// 지식 색인 실행기 — 설계서 §5.2·§7·§10.3·§11.1·§11.2·§13-3.
//
// 여기서 고정하는 것은 전부 **조용한 오답**이다: 개정으로 짧아진 문서의 옛 청크가 남아
// 철회된 안내가 계속 인용되는 것, 본문이 비워진 문서를 "0건 저장 성공"으로 적는 것,
// 어디까지 저장됐는지 모르는 상태를 0건으로 적는 것. 전부 예외 없이 지나간다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let I = null, T = null;
try {
  I = await import('../src/knowledge/executeIngest.ts');
  T = await import('../src/core/tenancy.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: I ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const CHUNK = { maxChars: 40, overlapChars: 0 };

/** 문단 3개 → 청크 3건. 마지막 문단에 개인정보가 섞여 있다(§10.3 경로 확인용). */
const DOC = {
  docId: 'd_fee',
  title: '수수료 안내',
  text: '첫 번째 문단입니다. 수수료는 면제입니다.\n\n두 번째 문단입니다. 조건이 있습니다.\n\n문의는 010-1234-5678 로 주세요.',
  sourceUri: 'kb://fee',
  updatedAt: '2026-10-01T00:00:00.000Z',
  approved: true,
};

function storeOf(opts = {}) {
  const calls = [];
  return {
    calls,
    scope: opts.scope ?? SCOPE,
    async upsert(kbId, docs) {
      calls.push({ method: 'upsert', kbId, ids: docs.map((d) => d.id), docs });
      if (opts.upsertThrows) throw opts.upsertThrows;
    },
    async query() { return []; },
    async purge(kbId) { calls.push({ method: 'purge', kbId }); },
  };
}

function embedderOf(over = {}) {
  const calls = [];
  return {
    calls,
    contractVersion: 1,
    engine: { name: 'fake-embed', residency: 'onprem' },
    async embedTexts() { throw new Error('이 검사에서는 쓰지 않는다'); },
    async embedChunks(chunks) {
      calls.push(chunks);
      return {
        status: 'ok',
        vectors: chunks.map(() => [0.1, 0.2]),
        dim: 2,
        docs: chunks.map((c) => ({ id: c.id, text: c.text, embedding: [0.1, 0.2], metadata: { ...c.metadata } })),
        failures: [],
        reasonKo: `청크 ${chunks.length}건`,
        usage: { texts: chunks.length, chars: chunks.reduce((a, c) => a + c.text.length, 0), batches: 1 },
        engine: { name: 'fake-embed', residency: 'onprem' },
        dimUncheckedAgainstIndex: true,
        ...over,
      };
    },
    async embedQuery() { throw new Error('이 검사에서는 쓰지 않는다'); },
  };
}

const run = (over = {}, input = {}) => I.ingestDocument(
  { scope: SCOPE, store: over.store ?? storeOf(), embedder: over.embedder ?? embedderOf(), chunk: over.chunk ?? CHUNK, ...(over.removeChunks !== undefined ? { removeChunks: over.removeChunks } : {}) },
  { knowledgeBaseId: 'kb_faq', doc: DOC, ...input },
);

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('청크가 저장되고 건수·id 가 실측으로 남는다', b, async () => {
  const store = storeOf();
  const r = await run({ store });
  assert.equal(r.status, 'stored');
  assert.equal(r.chunksPrepared, 3);
  assert.equal(r.chunksStored, 3);
  assert.deepEqual(r.storedChunkIds, ['d_fee#0', 'd_fee#1', 'd_fee#2']);
  assert.deepEqual(store.calls[0].ids, ['d_fee#0', 'd_fee#1', 'd_fee#2']);
});

test('저장되는 본문은 마스킹을 지난 값뿐이다(§10.3)', b, async () => {
  const store = storeOf();
  const r = await run({ store });
  const dumped = JSON.stringify(store.calls[0].docs);
  assert.equal(dumped.includes('010-1234-5678'), false);
  assert.equal(r.piiMaskedChunks, 1);
  assert.deepEqual(r.piiKinds, ['phone']);
});

test('재색인은 같은 청크 id 를 덮어쓴다 — 중복이 쌓이지 않는다', b, async () => {
  const store = storeOf();
  await run({ store });
  await run({ store }, { previousChunkCount: 3 });
  assert.deepEqual(store.calls[0].ids, store.calls[1].ids);
  assert.equal(store.calls.filter((c) => c.method === 'upsert').length, 2);
});

test('승인 여부를 색인이 판정하지 않는다 — 미승인 문서도 메타와 함께 저장된다(§7·§2)', b, async () => {
  const store = storeOf();
  const r = await I.ingestDocument(
    { scope: SCOPE, store, embedder: embedderOf(), chunk: CHUNK },
    { knowledgeBaseId: 'kb_faq', doc: { ...DOC, approved: false } },
  );
  assert.equal(r.status, 'stored');
  assert.equal(store.calls[0].docs[0].metadata.approved, false);
});

test('실측은 문자·건수뿐이다 — 토큰을 만들지 않는다(§11.2)', b, async () => {
  const r = await run();
  assert.equal(r.usage.embedTexts, 3);
  assert.ok(r.usage.embedChars > 0);
  assert.equal(r.usage.embedBatches, 1);
  assert.equal(JSON.stringify(r.usage).includes('token'), false);
  // 검사하지 못한 범위(이미 저장된 벡터와의 차원 일치)를 숨기지 않는다.
  assert.equal(r.dimUncheckedAgainstIndex, true);
});

// ── 개정으로 남는 청크 ───────────────────────────────────────────────────────

test('짧아진 개정의 고아 청크를 확정한다 — 지우지 못하면 지웠다고 적지 않는다', b, async () => {
  const r = await run({}, { previousChunkCount: 6 });
  assert.equal(r.status, 'stored');
  assert.deepEqual(r.orphanChunkIds, ['d_fee#3', 'd_fee#4', 'd_fee#5']);
  assert.equal(r.orphansRemoved, false);
  assert.equal(r.staleUnchecked, false);
  assert.match(r.reasonKo, /개정 전 본문이 계속 근거로 인용됩니다/);
});

test('삭제 수단이 있으면 저장 뒤에 정리한다 — 순서가 곧 안전장치다', b, async () => {
  const removed = [];
  const store = storeOf();
  const r = await run({ store, removeChunks: (kb, ids) => { removed.push([kb, [...ids]]); } }, { previousChunkCount: 5 });
  assert.equal(r.orphansRemoved, true);
  assert.deepEqual(removed, [['kb_faq', ['d_fee#3', 'd_fee#4']]]);
  // 저장이 **먼저** 끝났다 — 먼저 지우면 저장 실패 시 그 문서의 뒷부분이 색인에서 사라진다.
  assert.equal(store.calls[0].method, 'upsert');
});

test('정리 실패가 색인 결과를 뒤집지 않는다 — 저장은 됐고 남은 것은 남았다고 적는다', b, async () => {
  const r = await run({ removeChunks: () => { throw new Error('권한 없음'); } }, { previousChunkCount: 4 });
  assert.equal(r.status, 'stored');
  assert.equal(r.chunksStored, 3);
  assert.equal(r.orphansRemoved, false);
  assert.match(r.reasonKo, /정리에 실패했습니다/);
});

test('직전 청크 수를 모르면 고아를 검사하지 못했다고 적는다 — 추측하지 않는다(§13-3)', b, async () => {
  const r = await run();
  assert.equal(r.staleUnchecked, true);
  assert.deepEqual(r.orphanChunkIds, []);
});

test('길어진 개정에는 고아가 없다', b, async () => {
  const r = await run({}, { previousChunkCount: 2 });
  assert.deepEqual(r.orphanChunkIds, []);
  assert.equal(r.staleUnchecked, false);
});

test('고아 청크 계산은 순수 함수로 고정한다', b, () => {
  assert.deepEqual(I.orphanChunkIds('d', 5, 2), ['d#2', 'd#3', 'd#4']);
  assert.deepEqual(I.orphanChunkIds('d', 2, 5), []);
  assert.deepEqual(I.orphanChunkIds('d', 3, 3), []);
  assert.deepEqual(I.orphanChunkIds('d', 0, 0), []);
});

// ── 실패를 성공으로 적지 않는다 ──────────────────────────────────────────────

test('본문이 비워진 문서는 0건 저장 성공이 아니다 — 엔진·스토어를 부르지 않는다', b, async () => {
  const store = storeOf();
  const embedder = embedderOf();
  const r = await I.ingestDocument(
    { scope: SCOPE, store, embedder, chunk: CHUNK },
    { knowledgeBaseId: 'kb_faq', doc: { ...DOC, text: '   \n\n  ' }, previousChunkCount: 2 },
  );
  assert.equal(r.status, 'empty_document');
  assert.equal(r.chunksPrepared, 0);
  assert.equal(embedder.calls.length, 0);
  assert.equal(store.calls.length, 0);
  // 기존 청크가 그대로 남는다는 사실을 고아로 드러낸다 — 그러지 않으면 색인에 옛 본문만 남는다.
  assert.deepEqual(r.orphanChunkIds, ['d_fee#0', 'd_fee#1']);
  assert.match(r.reasonKo, /기존 색인은 그대로입니다/);
});

test('임베딩 실패는 아무것도 저장하지 않고, 고아도 지우지 않는다', b, async () => {
  const store = storeOf();
  const removed = [];
  const r = await run({
    store,
    embedder: embedderOf({
      status: 'protocol_error', docs: [], vectors: [], dim: undefined,
      failures: [{ from: 0, to: 3, code: 'E_PROTOCOL', reasonKo: '차원이 섞였다' }],
      reasonKo: '차원이 섞였다',
    }),
    removeChunks: (kb, ids) => { removed.push(ids); },
  }, { previousChunkCount: 6 });
  assert.equal(r.status, 'embed_failed');
  assert.equal(r.chunksStored, 0);
  assert.equal(r.errorCode, 'E_PROTOCOL');
  assert.equal(store.calls.length, 0);
  // 새 본문이 안 들어간 상태에서 옛 청크까지 지우면 그 문서는 색인에서 통째로 사라진다 —
  // 옛 본문이 인용되는 것보다 나쁘다(답을 아예 못 하게 된다).
  assert.deepEqual(removed, []);
  assert.equal(r.orphansRemoved, false);
});

test('저장 실패는 들어간 건수를 적지 않는다 — 0 으로 적으면 거짓 주장이다', b, async () => {
  const r = await run({ store: storeOf({ upsertThrows: new Error('연결 끊김') }) });
  assert.equal(r.status, 'store_failed');
  assert.equal('chunksStored' in r, false);
  assert.deepEqual(r.storedChunkIds, []);
  assert.match(r.reasonKo, /저장 범위를 확정할 수 없어/);
  assert.match(r.reasonKo, /같은 청크 id 를 덮어씁니다/);
});

test('설정·문서 형태 오류는 엔진을 부르기 전에 끊는다(§11.2)', b, async () => {
  const embedder = embedderOf();
  const bad = await run({ embedder, chunk: { maxChars: 0, overlapChars: 0 } });
  assert.equal(bad.status, 'config_error');
  assert.equal(bad.errorCode, 'E_CONFIG');
  assert.equal(embedder.calls.length, 0);

  const noId = await I.ingestDocument(
    { scope: SCOPE, store: storeOf(), embedder, chunk: CHUNK },
    { knowledgeBaseId: 'kb_faq', doc: { ...DOC, docId: '' } },
  );
  assert.equal(noId.status, 'config_error');
  assert.equal(embedder.calls.length, 0);
});

// ── 격리(§11.1) ──────────────────────────────────────────────────────────────

test('다른 테넌트·워크스페이스 스토어에는 색인하지 않는다(§11.1)', b, async () => {
  await assert.rejects(() => run({ store: storeOf({ scope: { tenantId: 'other' } }) }), /§11.1/);
  await assert.rejects(
    () => I.ingestDocument(
      { scope: SCOPE, store: storeOf({ scope: { tenantId: 'goone', workspaceId: 'ws2' } }), embedder: embedderOf(), chunk: CHUNK },
      { knowledgeBaseId: 'kb_faq', doc: DOC },
    ),
    /§11.1/,
  );
});

test('스토어가 격리 위반을 던지면 그대로 올린다 — 폴백할 사안이 아니다(§11.1)', b, async () => {
  await assert.rejects(
    () => run({ store: storeOf({ upsertThrows: new Error('네임스페이스 위반 (설계서 §11.1)') }) }),
    /§11.1/,
  );
});

// ── 판정을 복사하지 않는다(§2) ───────────────────────────────────────────────

test('근거 판정 규칙이 이 파일에 없다(§2·§7)', b, async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'knowledge', 'executeIngest.ts'),
    'utf8',
  );
  for (const name of ['decideGrounding', 'allowUnapproved', 'minScore', 'assertRetrievalPolicy']) {
    assert.equal(new RegExp(`\\b${name}\\s*[(=.]`).test(src), false, `판정을 복사하고 있다: ${name}`);
  }
});
