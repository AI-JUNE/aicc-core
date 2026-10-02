// 지식 응대 경계 검사 — 색인 → 검색 → 답변을 **실제 모듈로** 한 번에 통과시킨다.
// 설계서 §5.2·§7·§10.3·§11.1.
//
// 모듈별 단위 검사는 각각 통과하면서도 이어 붙인 순간 어긋나는 것이 이 경로의 특징이다
// (청크 id·메타데이터 키·마스킹 책임·네임스페이스). 가짜 판정기를 끼우지 않고 진짜
// `createEmbedder`·`createRetriever`·`createAnswerer` 를 쓰는 이유가 그것이다.
// 엔진과 스토어만 결정적인 가짜다 — 실호출은 **[승인 필요]**.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let I = null, E = null, R = null, A = null, K = null, T = null;
try {
  I = await import('../src/knowledge/executeIngest.ts');
  E = await import('../src/knowledge/embedding.ts');
  R = await import('../src/knowledge/retrieval.ts');
  A = await import('../src/knowledge/answer.ts');
  K = await import('../src/knowledge/executeKnowledge.ts');
  T = await import('../src/core/tenancy.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: I ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const KB = 'kb_faq';
const CHUNK = { maxChars: 60, overlapChars: 0 };
const POLICY = { topK: 3, minScore: 0.5, minHits: 1, maxContextChars: 1000 };

/**
 * 결정적 임베딩 — 주제어 두 개의 출현으로만 방향이 정해진다.
 * 영벡터는 `checkVector` 가 거부하므로 작은 상수를 둔다(0 성분은 유사도 분모를 0 으로 만든다).
 */
const embeddingAdapter = {
  name: 'fake-embed', residency: 'onprem',
  async embed(texts) {
    return texts.map((t) => [
      (t.includes('수수료') ? 1 : 0) + 0.01,
      (t.includes('해지') ? 1 : 0) + 0.01,
    ]);
  },
};

function cosine(a, v) {
  let dot = 0, na = 0, nv = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * v[i]; na += a[i] * a[i]; nv += v[i] * v[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nv));
}

function memoryStore() {
  const spaces = new Map();
  const raw = {
    async upsert(namespace, docs) {
      const m = spaces.get(namespace) ?? new Map();
      for (const d of docs) m.set(d.id, d);
      spaces.set(namespace, m);
    },
    async query(namespace, embedding, topK) {
      const m = spaces.get(namespace) ?? new Map();
      return [...m.values()]
        .map((d) => ({ id: d.id, score: cosine(d.embedding, embedding), namespace, text: d.text, metadata: d.metadata }))
        .sort((x, y) => y.score - x.score)
        .slice(0, topK);
    },
    async deleteNamespace(namespace) { spaces.delete(namespace); },
  };
  return { raw, spaces };
}

/** 규약대로 JSON 하나만 내놓는 LLM. 근거 번호를 그대로 인용한다. */
function llmOf(json) {
  const seen = [];
  return {
    seen,
    name: 'fake-llm', residency: 'onprem',
    complete(messages) {
      seen.push(messages);
      return (async function* () { yield json; })();
    },
  };
}

const docFee = {
  docId: 'd_fee', title: '수수료 안내', sourceUri: 'kb://fee',
  updatedAt: '2026-10-01T00:00:00.000Z', approved: true,
  text: '수수료는 면제입니다. 문의는 010-1234-5678 로 주세요.',
};
const docCancel = {
  docId: 'd_cancel', title: '해지 안내',
  updatedAt: '2026-10-01T00:00:00.000Z', approved: true,
  text: '해지는 영업점에서 가능합니다.',
};

function rig(over = {}) {
  const mem = over.mem ?? memoryStore();
  const scope = over.scope ?? SCOPE;
  const store = T.scopedVectorStore(mem.raw, scope);
  const embedder = E.createEmbedder({ scope, embedding: embeddingAdapter });
  const llm = over.llm ?? llmOf('{"sufficient":true,"answerKo":"수수료는 면제입니다 [1]."}');
  const retriever = R.createRetriever({ scope, embedder, store, knowledgeBaseIds: [KB] });
  const answerer = A.createAnswerer({ scope, llm, systemKo: '고객센터 상담원처럼 답한다.' });
  const removeChunks = async (kbId, ids) => {
    const m = mem.spaces.get(T.vectorNamespace(scope, kbId));
    for (const id of ids) m?.delete(id);
  };
  return {
    mem, scope, store, embedder, llm, retriever, answerer,
    ingest: (doc, input = {}) => I.ingestDocument(
      { scope, store, embedder, chunk: CHUNK, ...(over.cleanup ? { removeChunks } : {}) },
      { knowledgeBaseId: KB, doc, ...input },
    ),
    ask: (text) => K.resolveKnowledgeTurn(
      { retriever, answerer, policy: POLICY },
      { scope, channel: 'chat', text },
    ),
  };
}

test('색인한 문서가 그대로 답변 근거가 된다 — 모듈 셋이 실제로 이어진다', b, async () => {
  const r = rig();
  const stored = await r.ingest(docFee);
  assert.equal(stored.status, 'stored');

  const out = await r.ask('수수료가 얼마예요?');
  assert.equal(out.kind, 'answer');
  assert.equal(out.answerKo, '수수료는 면제입니다 [1].');
  assert.deepEqual(out.citations.map((c) => [c.marker, c.docId, c.title]), [[1, 'd_fee', '수수료 안내']]);
  assert.deepEqual(out.step.citations, [{ marker: 1, title: '수수료 안내', sourceUri: 'kb://fee' }]);
  assert.equal(out.usage.hits > 0, true);
});

test('색인 본문의 개인정보는 프롬프트에도 답변에도 나가지 않는다(§10.3)', b, async () => {
  const r = rig();
  await r.ingest(docFee);
  const out = await r.ask('제 번호 010-9876-5432 수수료가 얼마예요?');
  assert.equal(out.kind, 'answer');
  const prompt = JSON.stringify(r.llm.seen);
  // 질문의 번호(검색 단계에서 마스킹)와 지식 본문의 번호(색인 단계에서 마스킹) 둘 다다.
  assert.equal(prompt.includes('010-9876-5432'), false);
  assert.equal(prompt.includes('010-1234-5678'), false);
  assert.equal(JSON.stringify(out).includes('010-9876-5432'), false);
});

test('색인하지 않은 주제는 장애가 아니라 근거 없음이다(§5.2)', b, async () => {
  const r = rig();
  await r.ingest(docCancel);
  const out = await r.ask('수수료가 얼마예요?');
  assert.equal(out.kind, 'no_answer');
  assert.equal(out.cause, 'not_grounded');
  assert.equal(out.infraFailed, false);
  // 근거가 없으면 **엔진을 부르지 않는다** — 부르는 순간 환각 생성기가 된다.
  assert.equal(r.llm.seen.length, 0);
});

test('미승인 문서는 색인돼도 근거가 되지 않는다 — 판정은 검색 정책 한 곳이다(§7·§2)', b, async () => {
  const r = rig();
  const stored = await r.ingest({ ...docFee, approved: false });
  assert.equal(stored.status, 'stored');            // 색인은 거부하지 않는다
  const out = await r.ask('수수료가 얼마예요?');
  assert.equal(out.kind, 'no_answer');
  assert.equal(out.cause, 'not_grounded');
  assert.match(out.reasonKo, /승인/);
});

test('개정으로 짧아진 문서의 옛 청크는 정리하지 않으면 계속 인용된다', b, async () => {
  // 세 문단(3청크) → 한 문단(1청크)으로 개정. 옛 `#1`·`#2` 에는 **철회된 문구**가 남는다.
  const long = {
    ...docFee,
    text: '수수료는 면제입니다. 지금은 어떤 조건에서도 수수료를 받지 않습니다.'
      + '\n\n수수료 면제 조건은 따로 없으며 모든 고객에게 같게 적용됩니다.'
      + '\n\n수수료 관련 추가 안내는 가까운 영업점에서 받으실 수 있습니다.',
  };
  const revised = { ...docFee, updatedAt: '2026-10-02T00:00:00.000Z', text: '수수료는 월 1000원입니다.' };

  const dirty = rig();                               // 삭제 수단 미주입
  const first = await dirty.ingest(long);
  assert.equal(first.chunksStored, 3);
  const second = await dirty.ingest(revised, { previousChunkCount: 3 });
  assert.deepEqual(second.orphanChunkIds, ['d_fee#1', 'd_fee#2']);
  assert.equal(second.orphansRemoved, false);
  const hits = await dirty.store.query(KB, [1.01, 0.01], 10);
  assert.equal(hits.some((h) => h.text.includes('면제')), true, '옛 본문이 색인에 남아 있다');

  const clean = rig({ cleanup: true });              // 삭제 수단 주입
  await clean.ingest(long);
  const ok = await clean.ingest(revised, { previousChunkCount: 3 });
  assert.equal(ok.orphansRemoved, true);
  const after = await clean.store.query(KB, [1.01, 0.01], 10);
  assert.deepEqual(after.map((h) => h.id), ['d_fee#0']);
  assert.equal(after.some((h) => h.text.includes('면제')), false);
});

test('다른 테넌트의 지식은 검색되지 않는다(§11.1)', b, async () => {
  const mem = memoryStore();
  const mine = rig({ mem });
  await mine.ingest(docFee);
  const theirs = rig({ mem, scope: { tenantId: 'other' } });
  const out = await theirs.ask('수수료가 얼마예요?');
  assert.equal(out.kind, 'no_answer');
  assert.equal(out.cause, 'not_grounded');
  assert.equal(out.usage.hits, 0);
});

test('규약을 어긴 모델 응답은 답변으로 나가지 않는다(§5.2)', b, async () => {
  const r = rig({ llm: llmOf('{"sufficient":true,"answerKo":"수수료는 면제입니다 [3]."}') });
  await r.ingest(docFee);
  const out = await r.ask('수수료가 얼마예요?');
  assert.equal(out.kind, 'no_answer');
  assert.equal(out.cause, 'bad_citation');          // 근거 밖 각주 — 폐기한다
  assert.equal('answerKo' in out, false);
});
