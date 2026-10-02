// 지식 응대 실행기 — 설계서 §5.2·§5.1·§9.3·§10.3·§11.1·§11.2·§13-3.
//
// 여기서 고정하는 것은 대부분 예외가 아니라 **조용한 오답**이다:
// 스토어 장애를 "해당 내용이 없습니다"로 답하는 것, 마스킹 전 질문이 LLM 으로 나가는 것,
// 못 답했을 때 Core 가 문안을 지어내는 것. 전부 통화는 정상으로 끝난다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let K = null;
try {
  K = await import('../src/knowledge/executeKnowledge.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: K ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const POLICY = { topK: 3, minScore: 0.5, minHits: 1, maxContextChars: 2000 };
const RAW = '제 번호 010-1234-5678 로 등록된 카드 수수료가 얼마예요?';
const MASKED = '제 번호 010-****-**** 로 등록된 카드 수수료가 얼마예요?';

const CITATIONS = [
  { marker: 1, chunkId: 'c1', docId: 'd1', title: '수수료 안내', sourceUri: 'kb://fee', score: 0.9 },
  { marker: 2, chunkId: 'c2', docId: 'd2', title: '이용 안내', score: 0.8 },
];

function retrieverOf(over = {}, opts = {}) {
  const calls = [];
  return {
    calls,
    contractVersion: 1,
    engine: { name: 'fake-embed', residency: 'onprem' },
    knowledgeBaseIds: ['kb_faq'],
    async retrieve(query, policy) {
      calls.push({ query, policy });
      if (opts.throws) throw opts.throws;
      return {
        status: 'grounded',
        grounding: { grounded: true, context: '[1] 수수료는 면제입니다', citations: CITATIONS, droppedForLength: 0 },
        failures: [],
        partial: false,
        reasonKo: '근거 2건',
        queryMasked: MASKED,
        piiMasked: true,
        usage: { embedChars: 20, storeQueries: 1, hits: 2, duplicatesDropped: 0 },
        engine: { name: 'fake-embed', residency: 'onprem' },
        ...over,
      };
    },
  };
}

function answererOf(over = {}, opts = {}) {
  const calls = [];
  return {
    calls,
    contractVersion: 1,
    engine: { name: 'fake-llm', residency: 'onprem' },
    plan: () => ({ messages: [], promptChars: 0 }),
    async answer(req) {
      calls.push(req);
      if (opts.throws) throw opts.throws;
      return {
        status: 'ok',
        answerKo: '수수료는 면제입니다 [1].',
        citations: [CITATIONS[0]],
        usedMarkers: [1],
        unusedMarkers: [2],
        invalidMarkers: [],
        reasonKo: '근거 2건 중 1건을 인용한 답변',
        engine: { name: 'fake-llm', residency: 'onprem' },
        piiMaskedInAnswer: false,
        promptChars: 120,
        responseChars: 40,
        ...over,
      };
    },
  };
}

const run = (retriever, answerer, text = RAW, scope = SCOPE) =>
  K.resolveKnowledgeTurn({ retriever, answerer, policy: POLICY }, { scope, channel: 'voice', text });

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('근거가 있으면 답변 단계·마스킹된 질문·각주가 나온다', b, async () => {
  const r = await run(retrieverOf(), answererOf());
  assert.equal(r.kind, 'answer');
  assert.equal(r.step.nodeId, K.ANSWER_NODE_ID);
  assert.equal(r.step.kind, 'Say');
  assert.equal(r.step.text, '수수료는 면제입니다 [1].');
  assert.equal(r.questionMasked, MASKED);
  assert.deepEqual(r.usedMarkers, [1]);
  assert.deepEqual(r.unusedMarkers, [2]);
});

test('각주는 번호·제목·출처만 싣는다 — 내부 식별자·점수는 채널로 가지 않는다(§10.3)', b, async () => {
  const r = await run(retrieverOf(), answererOf());
  assert.deepEqual(r.step.citations, [{ marker: 1, title: '수수료 안내', sourceUri: 'kb://fee' }]);
  const dumped = JSON.stringify(r.step);
  for (const leak of ['c1', 'd1', '0.9']) {
    assert.equal(dumped.includes(leak), false, `단계에 내부 값이 실렸다: ${leak}`);
  }
});

test('인용이 없는 답변이면 citations 필드를 만들지 않는다(§13-3)', b, async () => {
  // 인용 0건은 `uncited` 로 폐기되는 것이 정상이지만, 각주 배열만 비어 있는 상태를
  // "빈 배열"로 적지 않는지는 별개 규약이다 — 빈 배열은 "각주를 0건 실측했다"로 읽힌다.
  const step = K.renderAnswerStep('안내입니다.', [], 'chat');
  assert.equal('citations' in step, false);
});

test('채널이 달라도 답변 단계는 실제 렌더 함수를 지난다', b, async () => {
  const voice = K.renderAnswerStep('안내입니다 [1].', CITATIONS, 'voice');
  const visual = K.renderAnswerStep('안내입니다 [1].', CITATIONS, 'visual');
  assert.equal(voice.channel, 'voice');
  assert.equal(visual.channel, 'visual');
  assert.equal(voice.text, visual.text);
  assert.equal(voice.citations.length, 2);
});

// ── 마스킹 경계(§10.3) ───────────────────────────────────────────────────────

test('답변기에는 마스킹된 질문만 간다 — 원문은 프롬프트로 나가지 않는다(§10.3)', b, async () => {
  const a = answererOf();
  await run(retrieverOf(), a);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].questionMasked, MASKED);
  assert.equal(JSON.stringify(a.calls[0]).includes('010-1234-5678'), false);
});

test('결과 어디에도 원문 질문이 남지 않는다(§10.3)', b, async () => {
  const r = await run(retrieverOf(), answererOf());
  assert.equal(JSON.stringify(r).includes('010-1234-5678'), false);
});

test('질문을 다시 마스킹하지 않는다 — maskPii 는 멱등이 아니다', b, async () => {
  // 검색기가 돌려준 값을 그대로 쓴다. 한 번 더 마스킹하면 치환된 토큰이 또 뭉개진다.
  const a = answererOf();
  await run(retrieverOf({ queryMasked: '900101-*******' }), a);
  assert.equal(a.calls[0].questionMasked, '900101-*******');
});

// ── 실패를 뭉개지 않는다 ─────────────────────────────────────────────────────

test('빈 질문은 검색기·답변기를 부르지 않는다(§11.2)', b, async () => {
  const rt = retrieverOf();
  const a = answererOf();
  const r = await run(rt, a, '   ');
  assert.equal(r.kind, 'no_answer');
  assert.equal(r.cause, 'empty_question');
  assert.equal(r.infraFailed, false);
  assert.equal(rt.calls.length, 0);
  assert.equal(a.calls.length, 0);
});

test('스토어 장애는 답변기를 부르지 않고 store_failed 로 드러낸다 — 근거 없음과 섞지 않는다', b, async () => {
  const a = answererOf();
  const r = await run(retrieverOf({
    status: 'store_failed', grounding: undefined, errorCode: 'E_TIMEOUT',
    failures: [{ knowledgeBaseId: 'kb_faq', code: 'E_TIMEOUT', reasonKo: '시간 초과' }],
    reasonKo: '지식베이스 조회가 모두 실패했다(1곳) — 근거 없음이 아니다',
  }), a);
  assert.equal(r.kind, 'no_answer');
  assert.equal(r.cause, 'store_failed');
  assert.equal(r.infraFailed, true);
  assert.equal(r.errorCode, 'E_TIMEOUT');
  // **핵심 한 줄**: 답변기에 넘기면 `Answerer` 가 이것을 `not_grounded` 로 적는다 —
  // 그 순간 장애가 "해당 내용이 없습니다"로 바뀌고 어디에도 집계되지 않는다.
  assert.equal(a.calls.length, 0);
});

test('근거 기준 미달은 장애가 아니다 — not_grounded 는 infraFailed 가 아니다(§5.2)', b, async () => {
  const a = answererOf();
  const r = await run(retrieverOf({
    status: 'not_grounded', grounding: undefined,
    notGrounded: { grounded: false, reason: 'below_threshold', reasonKo: '신뢰도 미달', filtered: {} },
    reasonKo: '근거 신뢰도 미달',
  }), a);
  assert.equal(r.cause, 'not_grounded');
  assert.equal(r.infraFailed, false);
  assert.equal(a.calls.length, 0);
});

test('임베딩 실패는 장애다', b, async () => {
  const r = await run(retrieverOf({ status: 'embed_failed', grounding: undefined, errorCode: 'E_UPSTREAM', reasonKo: '질의 임베딩 실패' }), answererOf());
  assert.equal(r.cause, 'embed_failed');
  assert.equal(r.infraFailed, true);
});

test('설정 오류는 장애로 집계하지 않는다 — 켜 보기도 전에 지식 응대가 내려간다(§9.3)', b, async () => {
  const r = await run(retrieverOf({ status: 'config_error', grounding: undefined, errorCode: 'E_CONFIG', reasonKo: 'minHits 가 topK 보다 크다' }), answererOf());
  assert.equal(r.cause, 'config_error');
  assert.equal(r.infraFailed, false);
});

test('모델이 못 답하겠다고 하면 그 변명을 결과에 담지 않는다(§5.1·§13-3)', b, async () => {
  const r = await run(retrieverOf(), answererOf({
    status: 'insufficient', answerKo: undefined,
    reasonKo: '모델이 근거만으로는 답할 수 없다고 했다 — 폴백으로 넘긴다',
  }));
  assert.equal(r.kind, 'no_answer');
  assert.equal(r.cause, 'insufficient');
  assert.equal(r.infraFailed, false);          // 모델이 정직하게 거절한 것은 장애가 아니다
  assert.equal('answerKo' in r, false);
  assert.equal('step' in r, false);
});

test('근거 밖 인용·무인용은 모델 탓으로 적는다 — 질문 탓으로 적으면 품질 저하가 사라진다', b, async () => {
  const bad = await run(retrieverOf(), answererOf({
    status: 'bad_citation', answerKo: undefined, errorCode: 'E_PROTOCOL',
    invalidMarkers: [5], reasonKo: '근거에 없는 인용 번호를 썼다: [5]',
  }));
  assert.equal(bad.cause, 'bad_citation');
  assert.equal(bad.infraFailed, true);
  const uncited = await run(retrieverOf(), answererOf({ status: 'uncited', answerKo: undefined, reasonKo: '인용 없음' }));
  assert.equal(uncited.cause, 'uncited');
  assert.equal(uncited.infraFailed, true);
});

test('답변 호출 실패·규약 위반은 원인을 갈라 적고 오류코드를 그대로 전달한다', b, async () => {
  const err = await run(retrieverOf(), answererOf({ status: 'engine_error', answerKo: undefined, errorCode: 'E_TIMEOUT', reasonKo: '호출 실패' }));
  assert.equal(err.cause, 'answer_engine_error');
  assert.equal(err.errorCode, 'E_TIMEOUT');
  const un = await run(retrieverOf(), answererOf({ status: 'unparsable', answerKo: undefined, errorCode: 'E_PROTOCOL', reasonKo: 'JSON 없음' }));
  assert.equal(un.cause, 'answer_unparsable');
  assert.equal(un.infraFailed, true);
});

// ── 던지지 않는다(§9.3) — 격리 위반만 예외 ───────────────────────────────────

test('검색기가 예외로 끝나도 통화를 끊지 않는다 — 원문·스택은 싣지 않는다', b, async () => {
  const r = await run(retrieverOf({}, { throws: new TypeError(`스토어 응답 파싱 실패: ${RAW}`) }), answererOf());
  assert.equal(r.kind, 'no_answer');
  assert.equal(r.cause, 'store_failed');
  assert.equal(r.infraFailed, true);
  assert.match(r.reasonKo, /TypeError/);
  assert.equal(r.reasonKo.includes('010-1234-5678'), false);
  assert.equal(r.questionMasked, '');           // 마스킹된 질의를 지어내지 않는다(§13-3)
});

test('답변기가 예외로 끝나도 통화를 끊지 않고, 이미 든 검색 비용은 남는다(§11.2)', b, async () => {
  const r = await run(retrieverOf(), answererOf({}, { throws: new Error('boom') }));
  assert.equal(r.cause, 'answer_engine_error');
  assert.equal(r.usage.embedChars, 20);
  assert.equal(r.usage.storeQueries, 1);
  assert.equal(r.usage.promptChars, 0);         // 못 보낸 프롬프트를 실측으로 적지 않는다
});

test('테넌트 격리 위반은 폴백하지 않고 그대로 던진다(§11.1)', b, async () => {
  await assert.rejects(
    () => run(retrieverOf({}, { throws: new Error('교차 테넌트 벡터 히트 (설계서 §11.1)') }), answererOf()),
    /§11.1/,
  );
  await assert.rejects(() => run(retrieverOf(), answererOf(), RAW, { tenantId: '' }), /tenant/i);
});

// ── 실측(§11.2)·부분 실패 ────────────────────────────────────────────────────

test('실측은 문자·건수뿐이다 — 토큰을 만들지 않는다(§11.2)', b, async () => {
  const r = await run(retrieverOf(), answererOf());
  assert.deepEqual(r.usage, { embedChars: 20, storeQueries: 1, hits: 2, promptChars: 120, responseChars: 40 });
  assert.equal(JSON.stringify(r.usage).includes('token'), false);
});

test('일부 지식베이스가 빠진 채 답했으면 숨기지 않는다', b, async () => {
  const r = await run(retrieverOf({
    partial: true,
    failures: [{ knowledgeBaseId: 'kb_notice', code: 'E_TIMEOUT', reasonKo: '시간 초과' }],
    reasonKo: '근거 2건 — 지식베이스 1곳이 빠진 채 판정했다',
  }), answererOf());
  assert.equal(r.kind, 'answer');
  assert.equal(r.partial, true);
  assert.match(r.reasonKo, /1곳이 빠진/);
});

test('실패 결과도 partial·실측을 들고 나온다', b, async () => {
  const r = await run(retrieverOf({
    status: 'store_failed', grounding: undefined, partial: false,
    failures: [{ knowledgeBaseId: 'kb_faq', code: 'E_TIMEOUT', reasonKo: '시간 초과' }],
    usage: { embedChars: 11, storeQueries: 2, hits: 0, duplicatesDropped: 0 },
  }), answererOf());
  assert.equal(r.usage.embedChars, 11);
  assert.equal(r.usage.hits, 0);
  assert.equal(r.partial, false);
});

// ── 판정을 복사하지 않는다(§2) ───────────────────────────────────────────────

test('근거 판정·폴백 사다리 규칙이 이 파일에 없다(§2)', b, async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'knowledge', 'executeKnowledge.ts'),
    'utf8',
  );
  // 임계값 비교·사다리 판정이 여기서 되풀이되면 §2 의 이중 관리가 지식 규칙에서 재발한다.
  for (const name of ['minScore', 'minHits', 'decideGrounding', 'decideFallback', 'groundingFallback', 'maskPii']) {
    assert.equal(new RegExp(`\\b${name}\\s*[(=.]`).test(src), false, `판정을 복사하고 있다: ${name}`);
  }
});
