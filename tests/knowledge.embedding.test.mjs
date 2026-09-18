// 임베딩 배선 — §5.2·§6.2·§10.3·§11.2·§13-3.
// 네트워크를 쓰지 않는다. 검사의 초점은 "엔진이 그럴듯하게 틀렸을 때 저장을 막는가" 다 —
// 이 모듈이 막는 사고는 전부 예외가 아니라 **조용한 오답**으로 나타나는 종류다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let rag = null;
try {
  m = await import('../src/knowledge/embedding.ts');
  rag = await import('../src/knowledge/rag.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 't1' };
const vec = (n, fill = 0.1) => Array.from({ length: n }, (_, i) => fill + i * 0.01);

/** 요청 건수만큼 n 차원 벡터를 돌려주는 가짜 엔진. */
function fakeEmb(impl, { residency = 'onprem', name = 'fake-emb' } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      name, residency,
      embed: async (texts) => { calls.push(texts); return impl(texts, calls.length); },
    },
  };
}
const normal = (dim = 4) => fakeEmb((texts) => texts.map(() => vec(dim)));
const make = (adapter, over = {}) => m.createEmbedder({ scope: SCOPE, embedding: adapter, ...over });

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('정상: 청크 → 저장 입력(VectorDoc)까지 이어진다', b, async () => {
  const chunks = rag.prepareIngest(SCOPE, 'kb1', {
    docId: 'd1', title: '요금 안내',
    text: '첫 문단입니다. 요금은 매월 청구됩니다.\n\n둘째 문단입니다. 자세한 내용은 고지서를 보세요.',
    updatedAt: '2026-01-01T00:00:00Z', approved: true,
  }, { maxChars: 24, overlapChars: 0 });
  assert.ok(chunks.length >= 2);

  const f = normal(4);
  const r = await make(f.adapter).embedChunks(chunks);
  assert.equal(r.status, 'ok');
  assert.equal(r.docs.length, chunks.length);
  assert.equal(r.dim, 4);
  assert.equal(r.docs[0].id, chunks[0].id);
  assert.equal(r.docs[0].embedding.length, 4);
  assert.equal(r.usage.texts, chunks.length);       // 실측만(§11.2)
  assert.equal(r.usage.batches, 1);
});

test('질의 벡터도 같은 경로로 나온다', b, async () => {
  const r = await make(normal(3).adapter).embedQuery('요금이 얼마인가요');
  assert.equal(r.status, 'ok');
  assert.equal(r.vector.length, 3);
  assert.equal(r.dim, 3);
});

test('batchSize 를 주면 나눠 보내고, 안 주면 한 번에 보낸다(§13-3)', b, async () => {
  const f = normal(2);
  const split = await make(f.adapter, { batchSize: 2 }).embedTexts(['a', 'b', 'c', 'd', 'e']);
  assert.equal(split.status, 'ok');
  assert.equal(split.vectors.length, 5);
  assert.deepEqual(f.calls.map((c) => c.length), [2, 2, 1]);

  const g = normal(2);
  const one = await make(g.adapter).embedTexts(['a', 'b', 'c']);
  assert.equal(one.usage.batches, 1);
  assert.equal(g.calls.length, 1);
});

// ── 개수 어긋남: 벡터가 다른 청크에 붙는 사고 ───────────────────────────────

test('개수를 맞춰 준 것처럼 보여도 어긋나면 저장 입력을 만들지 않는다', b, async () => {
  // 실패한 항목을 빼고 N-1 개를 준 엔진. 그대로 두면 이후 전부가 한 칸씩 밀린다.
  const f = fakeEmb((texts) => texts.slice(1).map(() => vec(4)));
  const r = await make(f.adapter).embedTexts(['a', 'b', 'c']);
  assert.equal(r.status, 'protocol_error');
  assert.deepEqual(r.vectors, []);
  assert.match(r.failures[0].reasonKo, /개수 불일치/);
  assert.deepEqual([r.failures[0].from, r.failures[0].to], [0, 3]);
});

test('배열이 아닌 응답도 배치째 실패로 확정한다', b, async () => {
  const r = await make(fakeEmb(() => ({ embeddings: [] })).adapter).embedTexts(['a']);
  assert.equal(r.status, 'protocol_error');
  assert.match(r.failures[0].reasonKo, /배열 아님/);
});

// ── 차원·성분: 조용히 망가지는 검색 ─────────────────────────────────────────

test('차원이 섞이면 거부한다 — 모델 교체 후 재인덱싱 누락이 여기서 잡힌다', b, async () => {
  const f = fakeEmb((texts) => texts.map((_, i) => vec(i === 1 ? 8 : 4)));
  const r = await make(f.adapter).embedTexts(['a', 'b', 'c']);
  assert.equal(r.status, 'protocol_error');
  assert.match(r.failures[0].reasonKo, /차원이 섞였다/);
});

test('expectDim 이 없어도 배치 간 드리프트는 잡는다 — 기준은 이번 호출의 첫 벡터다', b, async () => {
  const drift = fakeEmb((texts, call) => texts.map(() => vec(call === 1 ? 4 : 8)));
  const r = await make(drift.adapter, { batchSize: 1 }).embedTexts(['a', 'b']);
  assert.equal(r.status, 'protocol_error');
  assert.match(r.failures[0].reasonKo, /첫 벡터 관측값/);
});

test('expectDim 이 없으면 기존 저장 벡터와의 불일치는 못 잡으며, 그 사실을 숨기지 않는다(§13-3)', b, async () => {
  // 모델 교체 후 재인덱싱 누락 상황: 이번 호출은 8차원으로 완벽하게 자기 일관적이라
  // 관측만으로는 알 방법이 없다. expectDim 을 선언해야 비로소 잡힌다.
  const loose = await make(normal(8).adapter).embedTexts(['a', 'b']);
  assert.equal(loose.status, 'ok');
  assert.equal(loose.dim, 8);
  assert.equal(loose.dimUncheckedAgainstIndex, true, '검사 못 한 범위를 숨겼다');
  assert.match(loose.reasonKo, /기존 저장 벡터/);

  const strict = await make(normal(8).adapter, { expectDim: 4 }).embedTexts(['a', 'b']);
  assert.equal(strict.status, 'protocol_error');
  assert.equal(strict.dimUncheckedAgainstIndex, false);
  assert.match(strict.failures[0].reasonKo, /expectDim 선언값/);
});

test('NaN·Infinity 성분은 거부한다 — 유사도가 무의미해진다', b, async () => {
  for (const bad of [NaN, Infinity, -Infinity, '0.5', null]) {
    const f = fakeEmb(() => [[0.1, bad, 0.3]]);
    const r = await make(f.adapter).embedTexts(['a']);
    assert.equal(r.status, 'protocol_error', String(bad));
    assert.match(r.failures[0].reasonKo, /유한한 수가 아니다/);
  }
});

test('영벡터·빈 벡터는 거부한다 — 유사도 분모가 0 이 된다', b, async () => {
  const zero = await make(fakeEmb(() => [[0, 0, 0]]).adapter).embedTexts(['a']);
  assert.equal(zero.status, 'protocol_error');
  assert.match(zero.failures[0].reasonKo, /영벡터/);

  const empty = await make(fakeEmb(() => [[]]).adapter).embedTexts(['a']);
  assert.equal(empty.status, 'protocol_error');
  assert.match(empty.failures[0].reasonKo, /비어 있다/);
});

test('checkVector 는 순수 판정이라 단독으로도 쓸 수 있다', b, () => {
  assert.equal(m.checkVector([0.1, 0.2], 0), undefined);
  assert.match(m.checkVector('x', 3), /3번/);
  assert.match(m.checkVector([0, 0], 1), /영벡터/);
});

// ── 부분 실패: 절반 인덱싱 금지 ─────────────────────────────────────────────

test('배치 하나가 실패하면 성공분도 돌려주지 않는다 — 절반 인덱싱이 가장 늦게 발견된다', b, async () => {
  const f = fakeEmb((texts, call) => {
    if (call === 2) throw new Error('엔진 과부하 010-5555-6666');
    return texts.map(() => vec(4));
  });
  const r = await make(f.adapter, { batchSize: 2 }).embedTexts(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(r.status, 'engine_error');
  assert.deepEqual(r.vectors, []);
  assert.equal(r.failures.length, 1);
  assert.deepEqual([r.failures[0].from, r.failures[0].to], [2, 4]);   // 피해 범위가 확정된다
  assert.ok(!r.failures[0].reasonKo.includes('010-5555-6666'), '실패 사유에 개인정보가 남았다');
  assert.equal(r.usage.batches, 3);                                   // 실측은 남긴다(§11.2)
});

test('실패하면 embedChunks 는 docs 를 비워 돌려준다 — 저장 가능한 물건이 만들어지지 않는다', b, async () => {
  const chunks = rag.prepareIngest(SCOPE, 'kb1', {
    docId: 'd1', title: 't', text: '본문입니다.', updatedAt: '2026-01-01T00:00:00Z', approved: true,
  }, { maxChars: 50, overlapChars: 0 });
  const r = await make(fakeEmb(() => { throw new Error('down'); }).adapter).embedChunks(chunks);
  assert.notEqual(r.status, 'ok');
  assert.deepEqual(r.docs, []);
});

// ── 경계조건 ─────────────────────────────────────────────────────────────────

test('빈 입력은 엔진을 부르지 않는다', b, async () => {
  const f = normal(4);
  const e = make(f.adapter);
  assert.equal((await e.embedTexts([])).status, 'empty_input');
  assert.equal((await e.embedChunks([])).status, 'empty_input');
  assert.equal((await e.embedQuery('   ')).status, 'empty_input');
  assert.equal(f.calls.length, 0, '빈 입력으로 엔진을 불렀다');
});

test('빈 문자열이 섞이면 부르기 전에 끊는다 — 엔진마다 다르게 처리해 벡터가 밀린다', b, async () => {
  const f = normal(4);
  const r = await make(f.adapter).embedTexts(['a', '', 'c']);
  assert.equal(r.status, 'protocol_error');
  assert.match(r.reasonKo, /1번/);
  assert.equal(f.calls.length, 0);
});

test('타임아웃은 주었을 때만 적용된다(§13-3)', b, async () => {
  const slow = { name: 's', residency: 'onprem', embed: async () => { await new Promise((r) => setTimeout(r, 60)); return [vec(4)]; } };
  const late = await make(slow, { timeoutMs: 10 }).embedTexts(['a']);
  assert.equal(late.status, 'engine_error');
  assert.equal(late.failures[0].code, 'E_TIMEOUT');
  assert.equal((await make(slow).embedTexts(['a'])).status, 'ok');
});

test('벡터가 없으면 dim 을 0 으로 적지 않는다(§13-3)', b, async () => {
  const r = await make(normal(4).adapter).embedTexts([]);
  assert.equal(r.dim, undefined);
});

// ── 마스킹·국외이전(§10.3) ──────────────────────────────────────────────────

test('질의는 마스킹을 거쳐 엔진으로 나가고 원문은 결과에 남지 않는다', b, async () => {
  const f = normal(4);
  const r = await make(f.adapter).embedQuery('제 번호 010-1234-5678 로 연락 주세요');
  assert.ok(!f.calls[0][0].includes('010-1234-5678'), '원문 번호가 엔진으로 나갔다');
  assert.equal(r.piiMasked, true);
  assert.ok(!JSON.stringify(r).includes('010-1234-5678'));
});

test('해외 임베딩 엔진은 허용 없이는 생성 단계에서 거부된다', b, () => {
  const over = normal(4).adapter;
  assert.throws(() => make({ ...over, residency: 'overseas' }), /§10\.3/);
  assert.ok(make({ ...over, residency: 'overseas' }, { allowOverseas: true }));
});

test('설정 오류는 생성 시점에 던진다', b, () => {
  const a = normal(4).adapter;
  assert.throws(() => make(a, { expectDim: 0 }), /expectDim/);
  assert.throws(() => make(a, { batchSize: 1.5 }), /batchSize/);
  assert.throws(() => make(a, { timeoutMs: -1 }), /timeoutMs/);
  assert.throws(() => m.createEmbedder({ scope: { tenantId: '' }, embedding: a }), /./);
});
