import { test } from 'node:test';
import assert from 'node:assert/strict';

let r = null, sim = null;
try {
  r = await import('../src/knowledge/rag.ts');
  sim = await import('../src/adapters/sim.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: r ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 'acme' };
const ns = 't/acme/kb/faq';
const policy = { topK: 3, minScore: 0.5, minHits: 1, maxContextChars: 500, now: '2026-08-31T00:00:00.000Z' };

const hit = (over = {}) => ({
  id: 'd1#0', score: 0.9, namespace: ns, text: '영업시간은 평일 9시부터 18시까지입니다.',
  metadata: { docId: 'd1', title: '영업시간 안내', sourceUri: 'kb://d1', updatedAt: '2026-01-02T00:00:00.000Z', approved: true },
  ...over,
});

test('§5.2 청킹은 문단 경계를 지키고 상한을 넘지 않는다', behavioral, () => {
  const text = '가'.repeat(30) + '\n\n' + '나'.repeat(30);
  const chunks = r.chunkText(text, { maxChars: 40, overlapChars: 5 });
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 40, `청크 길이 초과: ${c.length}`);
  assert.deepEqual(r.chunkText('   ', { maxChars: 40, overlapChars: 0 }), []);
  assert.throws(() => r.chunkText('x', { maxChars: 10, overlapChars: 10 }), /overlapChars/);
});

test('§5.2 긴 문단도 상한 안에서 강제 분할된다', behavioral, () => {
  const chunks = r.chunkText('다'.repeat(250), { maxChars: 100, overlapChars: 20 });
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 100);
});

test('§10.3 인제스트 단계에서 개인정보가 마스킹되어 저장된다', behavioral, () => {
  const chunks = r.prepareIngest(scope, 'faq', {
    docId: 'd9', title: '접수 안내', text: '담당자 연락처는 010-1234-5678 입니다.',
    updatedAt: '2026-01-01T00:00:00.000Z', approved: true,
  }, { maxChars: 200, overlapChars: 0 });
  assert.equal(chunks.length, 1);
  assert.ok(!chunks[0].text.includes('010-1234-5678'));
  assert.equal(chunks[0].piiMasked, true);
  assert.deepEqual(chunks[0].piiKinds, ['phone']);
  assert.equal(chunks[0].metadata.tenantId, 'acme');
  assert.equal(chunks[0].id, 'd9#0');
});

test('§11.1 인제스트 입구에서 잘못된 스코프·kb id를 끊는다', behavioral, () => {
  const doc = { docId: 'd1', title: 't', text: '본문', updatedAt: '2026-01-01T00:00:00.000Z', approved: true };
  const o = { maxChars: 100, overlapChars: 0 };
  assert.throws(() => r.prepareIngest({ tenantId: '' }, 'faq', doc, o), /§11.1/);
  assert.throws(() => r.prepareIngest(scope, 'FAQ', doc, o), /knowledge_base_id/);
  assert.throws(() => r.prepareIngest(scope, 'faq', { ...doc, docId: '' }, o), /docId/);
});

test('§5.2 청크와 임베딩 개수가 어긋나면 스토어 입력을 만들지 않는다', behavioral, async () => {
  const chunks = r.prepareIngest(scope, 'faq', {
    docId: 'd1', title: 't', text: '가'.repeat(50) + '\n\n' + '나'.repeat(50),
    updatedAt: '2026-01-01T00:00:00.000Z', approved: true,
  }, { maxChars: 60, overlapChars: 0 });
  assert.throws(() => r.toVectorDocs(chunks, [[0.1]]), /개수가 다르다/);
  const emb = await sim.simEmbedding.embed(chunks.map((c) => c.text));
  const docs = r.toVectorDocs(chunks, emb);
  assert.equal(docs.length, chunks.length);
  assert.equal(docs[0].metadata.pii_masked, false);
  assert.equal(docs[0].embedding.length, emb[0].length);
});

test('§13-3 임계값은 기본값 없이 주입해야 하며 누락·모순이면 예외', behavioral, () => {
  assert.throws(() => r.assertRetrievalPolicy({ ...policy, topK: 0 }), /topK/);
  assert.throws(() => r.assertRetrievalPolicy({ ...policy, minScore: undefined }), /minScore/);
  assert.throws(() => r.assertRetrievalPolicy({ ...policy, minHits: 5 }), /minHits/);
});

test('§5.2 근거가 임계를 통과하면 인용 번호가 붙은 컨텍스트를 만든다', behavioral, () => {
  const d = r.decideGrounding([hit(), hit({ id: 'd2#0', score: 0.7, metadata: { docId: 'd2', title: '휴무 안내', approved: true } })], scope, policy);
  assert.equal(d.grounded, true);
  assert.equal(d.citations.length, 2);
  assert.deepEqual(d.citations.map((c) => c.marker), [1, 2]);
  assert.ok(d.context.startsWith('[1] '));
  assert.ok(d.context.includes('[2] '));
  assert.deepEqual(r.formatCitations(d.citations)[0], '[1] 영업시간 안내 (kb://d1)');
});

test('§5.2 점수 미달·결과 없음이면 근거 없이 답하지 않는다', behavioral, () => {
  assert.equal(r.decideGrounding([], scope, policy).reason, 'no_hits');
  const low = r.decideGrounding([hit({ score: 0.1 })], scope, policy);
  assert.equal(low.grounded, false);
  assert.equal(low.reason, 'below_threshold');
  assert.equal(low.filtered.belowScore, 1);
});

test('§7 미승인·만료·메타 누락 문서는 답변 근거가 될 수 없다', behavioral, () => {
  const unapproved = hit({ metadata: { docId: 'd1', title: 't', approved: false } });
  const expired = hit({ id: 'd3#0', metadata: { docId: 'd3', title: 't', approved: true, expiresAt: '2026-01-01T00:00:00.000Z' } });
  const noMeta = hit({ id: 'd4#0', metadata: { approved: true } });
  const d = r.decideGrounding([unapproved, expired, noMeta], scope, policy);
  assert.equal(d.grounded, false);
  assert.equal(d.reason, 'no_approved_source');
  assert.deepEqual(d.filtered, { unapproved: 1, expired: 1, missingMetadata: 1, belowScore: 0 });
  // 승인 예외를 명시로 열었을 때만 통과
  assert.equal(r.decideGrounding([unapproved], scope, { ...policy, allowUnapproved: true }).grounded, true);
});

test('§11.1 다른 테넌트 네임스페이스 히트는 프롬프트로 흘러가지 않는다', behavioral, () => {
  assert.throws(() => r.decideGrounding([hit({ namespace: 't/other/kb/faq' })], scope, policy), /교차 테넌트/);
});

test('§10.3 스토어 본문에 개인정보가 남아 있어도 프롬프트 직전 다시 마스킹된다', behavioral, () => {
  const d = r.decideGrounding([hit({ text: '카드번호 1234-5678-9012-3456 확인' })], scope, policy);
  assert.equal(d.grounded, true);
  assert.ok(!d.context.includes('1234-5678-9012-3456'));
});

test('§5.2 길이 상한을 못 맞추면 근거 부족으로 처리한다', behavioral, () => {
  const d = r.decideGrounding([hit()], scope, { ...policy, maxContextChars: 5 });
  assert.equal(d.grounded, false);
  assert.equal(d.reason, 'empty_context');
});

test('§5.1 근거가 없을 때의 행동은 기존 폴백 사다리를 그대로 쓴다', behavioral, () => {
  assert.equal(r.groundingFallback(1, true), 'retry');
  assert.equal(r.groundingFallback(2, true), 'switch_to_visual');
  assert.equal(r.groundingFallback(3, true), 'handoff_agent');
});
