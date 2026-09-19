// 질의 → 근거 파이프라인 — §5.2·§9.3·§10.3·§11.1·§13-3.
// 네트워크를 쓰지 않는다. 검사의 초점은 **"장애를 무근거로 적지 않는가"** 다 —
// 이 모듈이 막는 사고는 예외가 아니라 고객이 듣는 "해당 내용이 없습니다" 한 문장으로 나타난다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null, rag = null, emb = null, tenancy = null;
try {
  m = await import('../src/knowledge/retrieval.ts');
  rag = await import('../src/knowledge/rag.ts');
  emb = await import('../src/knowledge/embedding.ts');
  tenancy = await import('../src/core/tenancy.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'acme' };
const POLICY = { topK: 3, minScore: 0.5, minHits: 1, maxContextChars: 500 };
const vec = (n = 4) => Array.from({ length: n }, (_, i) => 0.1 + i * 0.01);

const embedder = (over = {}) => ({
  contractVersion: 1,
  engine: { name: 'fake-emb', residency: 'onprem' },
  embedTexts: async () => ({ status: 'ok', vectors: [vec()], failures: [], reasonKo: '', usage: { texts: 1, chars: 1, batches: 1 }, engine: { name: 'fake-emb', residency: 'onprem' }, dimUncheckedAgainstIndex: true }),
  embedChunks: async () => ({ status: 'ok', vectors: [], docs: [], failures: [], reasonKo: '', usage: { texts: 0, chars: 0, batches: 0 }, engine: { name: 'fake-emb', residency: 'onprem' }, dimUncheckedAgainstIndex: true }),
  embedQuery: async (q) => ({
    status: 'ok', vectors: [vec()], vector: vec(), dim: 4, failures: [],
    reasonKo: '', usage: { texts: 1, chars: q.length, batches: 1 },
    engine: { name: 'fake-emb', residency: 'onprem' }, dimUncheckedAgainstIndex: true,
    queryMasked: q, piiMasked: false,
  }),
  ...over,
});

/** 지식베이스별 동작을 지정하는 가짜 스토어. 함수가 던지면 그 지식베이스가 실패한 것이다. */
function fakeStore(byKb, scope = SCOPE) {
  const calls = [];
  return {
    calls,
    store: {
      scope,
      upsert: async () => {},
      purge: async () => {},
      query: async (kbId, embedding, topK) => {
        calls.push({ kbId, topK, dim: embedding.length });
        const impl = byKb[kbId];
        if (typeof impl === 'function') return impl();
        return impl ?? [];
      },
    },
  };
}

const hit = (over = {}) => ({
  id: 'd1#0', score: 0.9, namespace: 't/acme/kb/faq',
  text: '영업시간은 평일 9시부터 18시까지입니다.',
  metadata: { docId: 'd1', title: '영업시간 안내', sourceUri: 'kb://d1', approved: true },
  ...over,
});

const make = (over = {}) => m.createRetriever({
  scope: SCOPE, embedder: embedder(), store: fakeStore({ faq: [hit()] }).store,
  knowledgeBaseIds: ['faq'], ...over,
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('정상: 질의 → 벡터 → 조회 → 근거까지 한 번에 이어진다', b, async () => {
  const f = fakeStore({ faq: [hit()] });
  const r = await make({ store: f.store }).retrieve('영업시간 알려주세요', POLICY);
  assert.equal(r.status, 'grounded');
  assert.equal(r.grounding.citations.length, 1);
  assert.match(r.grounding.context, /\[1\]/);
  assert.equal(r.partial, false);
  assert.deepEqual(r.failures, []);
  assert.equal(r.usage.storeQueries, 1);
  assert.equal(r.usage.hits, 1);
});

test('스토어에 넘기는 topK 는 정책의 topK 와 같다(어긋나면 설정 실수가 품질 문제로 오진된다)', b, async () => {
  const f = fakeStore({ faq: [hit()], guide: [] });
  await m.createRetriever({ scope: SCOPE, embedder: embedder(), store: f.store, knowledgeBaseIds: ['faq', 'guide'] })
    .retrieve('질문', { ...POLICY, topK: 7, minHits: 1 });
  assert.deepEqual(f.calls.map((c) => c.topK), [7, 7]);
});

test('지식베이스는 동시에 조회한다(순차면 제한 시간이 개수만큼 곱해진다)', b, async () => {
  let active = 0, peak = 0;
  const slow = () => new Promise((res) => {
    active += 1; peak = Math.max(peak, active);
    setTimeout(() => { active -= 1; res([hit()]); }, 20);
  });
  const f = fakeStore({ a: slow, c: slow, d: slow });
  await m.createRetriever({ scope: SCOPE, embedder: embedder(), store: f.store, knowledgeBaseIds: ['a', 'c', 'd'] })
    .retrieve('질문', POLICY);
  assert.equal(peak, 3, `동시 실행이 아니다(peak=${peak})`);
});

test('같은 청크가 두 지식베이스에 있으면 인용이 두 번 달리지 않는다', b, async () => {
  const same = hit({ score: 0.7 });
  const f = fakeStore({ a: [same], c: [{ ...same, score: 0.95 }] });
  const r = await m.createRetriever({ scope: SCOPE, embedder: embedder(), store: f.store, knowledgeBaseIds: ['a', 'c'] })
    .retrieve('질문', POLICY);
  assert.equal(r.status, 'grounded');
  assert.equal(r.grounding.citations.length, 1);
  assert.equal(r.grounding.citations[0].score, 0.95, '중복 중 점수가 높은 쪽을 남긴다');
  assert.equal(r.usage.duplicatesDropped, 1);
});

test('dedupeHits 는 지식베이스가 달라도(namespace 가 다르면) 별개로 본다', b, () => {
  const a = { id: 'x', score: 0.5, namespace: 'ns1' };
  const c = { id: 'x', score: 0.6, namespace: 'ns2' };
  const out = m.dedupeHits([a, c]);
  assert.equal(out.hits.length, 2);
  assert.equal(out.dropped, 0);
});

// ── 핵심: 장애와 '근거 없음'을 섞지 않는다 ────────────────────────────────────

test('§9.3 조회가 전부 실패하면 store_failed 다 — no_hits 로 적지 않는다', b, async () => {
  const f = fakeStore({ faq: () => { throw new Error('connection refused'); } });
  const r = await make({ store: f.store }).retrieve('질문', POLICY);
  assert.equal(r.status, 'store_failed');
  assert.notEqual(r.status, 'not_grounded');
  assert.equal(r.grounding, undefined);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].knowledgeBaseId, 'faq');
  assert.match(r.reasonKo, /근거 없음이 아니다/);
});

test('§9.3 일부만 실패했고 근거도 못 만들었으면 store_failed 다(장애일 수 있다)', b, async () => {
  const f = fakeStore({ a: () => { throw new Error('timeout'); }, c: [] });
  const r = await m.createRetriever({ scope: SCOPE, embedder: embedder(), store: f.store, knowledgeBaseIds: ['a', 'c'] })
    .retrieve('질문', POLICY);
  assert.equal(r.status, 'store_failed');
  assert.equal(r.failures.length, 1);
  assert.equal(r.notGrounded, undefined);
});

test('일부 실패해도 근거를 만들었으면 답한다 — 대신 partial 로 드러낸다', b, async () => {
  const f = fakeStore({ a: () => { throw new Error('down'); }, c: [hit()] });
  const r = await m.createRetriever({ scope: SCOPE, embedder: embedder(), store: f.store, knowledgeBaseIds: ['a', 'c'] })
    .retrieve('질문', POLICY);
  assert.equal(r.status, 'grounded');
  assert.equal(r.partial, true);
  assert.equal(r.failures.length, 1);
  assert.match(r.reasonKo, /빠진 채/);
});

test('검색이 정상인데 기준 미달이면 not_grounded 이고 사유가 그대로 실린다', b, async () => {
  const f = fakeStore({ faq: [hit({ score: 0.1 })] });
  const r = await make({ store: f.store }).retrieve('질문', POLICY);
  assert.equal(r.status, 'not_grounded');
  assert.equal(r.notGrounded.grounded, false);
  assert.equal(r.notGrounded.reason, 'below_threshold');
  assert.deepEqual(r.failures, []);
});

test('미승인 문서만 있으면 근거가 아니다(§7) — 장애가 아니라 not_grounded 다', b, async () => {
  const f = fakeStore({ faq: [hit({ metadata: { docId: 'd1', title: 't', approved: false } })] });
  const r = await make({ store: f.store }).retrieve('질문', POLICY);
  assert.equal(r.status, 'not_grounded');
  assert.equal(r.notGrounded.reason, 'no_approved_source');
  assert.equal(r.notGrounded.filtered.unapproved, 1);
});

test('규약을 어긴 반환값(배열 아님)을 빈 결과로 읽지 않는다', b, async () => {
  const f = fakeStore({ faq: () => ({ hits: [] }) });
  const r = await make({ store: f.store }).retrieve('질문', POLICY);
  assert.equal(r.status, 'store_failed');
  assert.equal(r.failures[0].code, 'E_PROTOCOL');
});

test('storeTimeoutMs 를 주면 늦은 조회를 실패로 적는다(주지 않으면 제한하지 않는다, §13-3)', b, async () => {
  const slow = () => new Promise((res) => { const t = setTimeout(() => res([hit()]), 200); t.unref?.(); });
  const f = fakeStore({ faq: slow });
  const r = await make({ store: f.store, storeTimeoutMs: 20 }).retrieve('질문', POLICY);
  assert.equal(r.status, 'store_failed');
  assert.equal(r.failures[0].code, 'E_TIMEOUT');

  const f2 = fakeStore({ faq: () => new Promise((res) => { const t = setTimeout(() => res([hit()]), 30); t.unref?.(); }) });
  const r2 = await make({ store: f2.store }).retrieve('질문', POLICY);
  assert.equal(r2.status, 'grounded', '상한을 주지 않으면 기다린다');
});

// ── 경계조건 ─────────────────────────────────────────────────────────────────

test('빈 질의로는 엔진을 부르지 않는다(§11.2 정체불명 사용량 방지)', b, async () => {
  let called = 0;
  const e = embedder({ embedQuery: async () => { called += 1; throw new Error('불려서는 안 된다'); } });
  const f = fakeStore({ faq: [hit()] });
  for (const q of ['', '   ']) {
    const r = await make({ embedder: e, store: f.store }).retrieve(q, POLICY);
    assert.equal(r.status, 'empty_query');
    assert.equal(r.usage.embedChars, 0);
  }
  assert.equal(called, 0);
  assert.equal(f.calls.length, 0);
});

test('정책이 성립하지 않으면 엔진을 부르기 전에 config_error 다', b, async () => {
  let called = 0;
  const e = embedder({ embedQuery: async () => { called += 1; throw new Error('불려서는 안 된다'); } });
  const r = await make({ embedder: e }).retrieve('질문', { ...POLICY, minHits: 9 });   // minHits > topK
  assert.equal(r.status, 'config_error');
  assert.equal(r.errorCode, 'E_CONFIG');
  assert.equal(called, 0);
});

test('질의 임베딩이 실패하면 embed_failed 이고 조회하지 않는다', b, async () => {
  const e = embedder({
    embedQuery: async (q) => ({
      status: 'engine_error', vectors: [], failures: [{ from: 0, to: 1, code: 'E_TIMEOUT', reasonKo: '지연' }],
      reasonKo: '엔진 지연', usage: { texts: 1, chars: q.length, batches: 1 },
      engine: { name: 'fake-emb', residency: 'onprem' }, dimUncheckedAgainstIndex: true,
      queryMasked: q, piiMasked: false,
    }),
  });
  const f = fakeStore({ faq: [hit()] });
  const r = await make({ embedder: e, store: f.store }).retrieve('질문', POLICY);
  assert.equal(r.status, 'embed_failed');
  assert.equal(r.errorCode, 'E_TIMEOUT');
  assert.equal(f.calls.length, 0);
});

test('§10.3 질의 원문은 결과에 남지 않고 마스킹된 것만 실린다', b, async () => {
  const e = embedder({
    embedQuery: async (q) => {
      const masked = q.replace(/010-\d{4}-\d{4}/, '010-****-5678');
      return {
        status: 'ok', vectors: [vec()], vector: vec(), dim: 4, failures: [], reasonKo: '',
        usage: { texts: 1, chars: q.length, batches: 1 },
        engine: { name: 'fake-emb', residency: 'onprem' }, dimUncheckedAgainstIndex: true,
        queryMasked: masked, piiMasked: true,
      };
    },
  });
  const r = await make({ embedder: e }).retrieve('제 번호는 010-1234-5678 입니다', POLICY);
  assert.equal(r.piiMasked, true);
  assert.ok(!JSON.stringify(r).includes('010-1234-5678'), '원문이 결과에 남았다');
});

test('§11.1 교차 테넌트 결과는 폴백이 아니라 예외다', b, async () => {
  const foreign = hit({ namespace: 't/other/kb/faq' });
  const f = fakeStore({ faq: () => tenancy.guardVectorHits([foreign], SCOPE) });
  await assert.rejects(() => make({ store: f.store }).retrieve('질문', POLICY), /§11\.1/);
});

test('설정 오류는 통화 전에 던진다 — 빈 목록·중복·다른 테넌트 스토어', b, () => {
  assert.throws(() => make({ knowledgeBaseIds: [] }), /knowledgeBaseIds/);
  assert.throws(() => make({ knowledgeBaseIds: ['faq', 'faq'] }), /중복/);
  assert.throws(() => make({ knowledgeBaseIds: ['  '] }), /빈 문자열/);
  assert.throws(() => make({ storeTimeoutMs: 0 }), /storeTimeoutMs/);
  assert.throws(() => make({ store: fakeStore({}, { tenantId: 'other' }).store }), /§11\.1/);
});

test('공개 계약: 버전과 선언한 지식베이스 목록이 드러난다', b, () => {
  const r = make({ knowledgeBaseIds: ['faq', 'guide'] });
  assert.equal(r.contractVersion, m.RETRIEVAL_CONTRACT_VERSION);
  assert.deepEqual([...r.knowledgeBaseIds], ['faq', 'guide']);
  assert.equal(r.engine.residency, 'onprem');
});

test('근거 판정을 다시 하지 않는다 — 임계값 이름이 이 파일에 없다(§2 이중 관리 방지)', b, async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/knowledge/retrieval.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
  for (const name of ['minScore', 'minHits', 'allowUnapproved', 'expiresAt']) {
    assert.ok(!code.includes(name), `판정 기준(${name})을 이 모듈이 직접 읽고 있다 — decideGrounding 하나여야 한다`);
  }
});
