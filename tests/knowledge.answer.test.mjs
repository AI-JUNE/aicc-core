// 근거 → 답변 — §5.2·§6.2·§9.3·§10.3·§13-3.
// 네트워크를 쓰지 않는다. 검사의 초점은 **"근거를 안 본 문장이 고객에게 나가는가"** 다 —
// 여기서 막는 실패는 전부 예외가 아니라 그럴듯한 한 문단이라 사후에 신고되지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null, rag = null;
try {
  m = await import('../src/knowledge/answer.ts');
  rag = await import('../src/knowledge/rag.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'acme' };
const SYSTEM = '고원 고객센터 상담원으로서 존댓말로 답한다.';

/** 한 번에 한 문자열을 뱉는 가짜 LLM. impl 이 던지면 엔진 실패다. */
function fakeLlm(impl, { residency = 'onprem', name = 'fake-llm' } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      name, residency,
      complete: (messages) => {
        calls.push(messages);
        return (async function* () {
          const out = typeof impl === 'function' ? await impl(messages, calls.length) : impl;
          if (Array.isArray(out)) { for (const c of out) yield c; return; }
          yield out;
        })();
      },
    },
  };
}

const json = (o) => JSON.stringify(o);
const make = (adapter, over = {}) => m.createAnswerer({ scope: SCOPE, llm: adapter, systemKo: SYSTEM, ...over });

const citation = (marker, over = {}) => ({
  marker, chunkId: `d${marker}#0`, docId: `d${marker}`, title: `문서 ${marker}`,
  sourceUri: `kb://d${marker}`, score: 0.9, ...over,
});
const grounded = (n = 2) => ({
  grounded: true,
  context: Array.from({ length: n }, (_, i) => `[${i + 1}] 근거 본문 ${i + 1}`).join('\n\n'),
  citations: Array.from({ length: n }, (_, i) => citation(i + 1)),
  droppedForLength: 0,
});
const notGrounded = { grounded: false, reason: 'no_hits', reasonKo: '검색 결과가 없다', filtered: { unapproved: 0, expired: 0, missingMetadata: 0, belowScore: 0 } };

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('정상: 근거를 인용한 답변이 검증을 통과한다', b, async () => {
  const f = fakeLlm(json({ sufficient: true, answerKo: '평일 9시부터 18시까지입니다 [1].' }));
  const r = await make(f.adapter).answer({ questionMasked: '영업시간이요', grounding: grounded(2) });
  assert.equal(r.status, 'ok');
  assert.match(r.answerKo, /\[1\]/);
  assert.deepEqual(r.usedMarkers, [1]);
  assert.deepEqual(r.unusedMarkers, [2]);
  assert.deepEqual(r.invalidMarkers, []);
  assert.equal(r.citations.length, 1, '실제로 인용한 근거만 각주로 준다');
  assert.equal(r.citations[0].docId, 'd1');
  assert.ok(r.promptChars > 0 && r.responseChars > 0);
});

test('프롬프트에 근거 블록과 출력 규약이 실리고, 질문은 사용자 메시지로 간다', b, async () => {
  const f = fakeLlm(json({ sufficient: true, answerKo: '네 [1].' }));
  await make(f.adapter).answer({ questionMasked: '영업시간이요', grounding: grounded(1) });
  const msgs = f.calls[0];
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes(SYSTEM));
  assert.ok(msgs[0].content.includes('[1] 근거 본문 1'));
  assert.ok(msgs[0].content.includes(m.ANSWER_OUTPUT_FORMAT_INSTRUCTION));
  assert.deepEqual(msgs[msgs.length - 1], { role: 'user', content: '영업시간이요' });
});

test('plan 은 실호출 없이 프롬프트만 보여준다', b, () => {
  const f = fakeLlm('불려서는 안 된다');
  const p = make(f.adapter).plan({ questionMasked: '질문', grounding: grounded(1) });
  assert.equal(f.calls.length, 0);
  assert.ok(p.promptChars > 0);
  assert.equal(p.messages.length, 2);
});

test('코드펜스·앞뒤 산문이 섞여도 읽는다(형식은 관용, 값은 엄격)', b, async () => {
  const f = fakeLlm(['다음과 같습니다:\n```json\n', json({ sufficient: true, answerKo: '가능합니다 [2].' }), '\n```\n이상입니다.']);
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(2) });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.usedMarkers, [2]);
});

// ── 핵심: 근거 없는 문장을 내보내지 않는다 ────────────────────────────────────

test('§5.2 근거가 없으면 엔진을 부르지 않는다(부르는 순간 RAG 가 아니라 환각 생성기다)', b, async () => {
  const f = fakeLlm('불려서는 안 된다');
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: notGrounded });
  assert.equal(r.status, 'not_grounded');
  assert.equal(f.calls.length, 0);
  assert.equal(r.answerKo, undefined);
  assert.equal(r.promptChars, 0);
  assert.match(r.reasonKo, /검색 결과가 없다/);
});

test('근거 밖 인용 번호를 쓴 답변은 폐기한다(죽은 각주를 내보내지 않는다)', b, async () => {
  const f = fakeLlm(json({ sufficient: true, answerKo: '가능합니다 [1]. 추가로 무료입니다 [3].' }));
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(2) });
  assert.equal(r.status, 'bad_citation');
  assert.equal(r.answerKo, undefined);
  assert.deepEqual(r.invalidMarkers, [3]);
  assert.equal(r.errorCode, 'E_PROTOCOL');
});

test('인용이 하나도 없는 답변은 근거 없이 생성된 문장으로 본다', b, async () => {
  const f = fakeLlm(json({ sufficient: true, answerKo: '일반적으로 평일 9시부터 6시까지 운영합니다.' }));
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(2) });
  assert.equal(r.status, 'uncited');
  assert.equal(r.answerKo, undefined);
  assert.deepEqual(r.usedMarkers, []);
  assert.deepEqual(r.unusedMarkers, [1, 2]);
});

test('모델이 못 답하겠다고 하면 그 문장을 고객에게 읽어 주지 않는다(§5.1 폴백 신호)', b, async () => {
  const f = fakeLlm(json({ sufficient: false, answerKo: '근거에 없어서 모르겠습니다. 질문하신 홍길동 님의 계약은…' }));
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(2) });
  assert.equal(r.status, 'insufficient');
  assert.equal(r.answerKo, undefined);
  assert.ok(!JSON.stringify(r).includes('홍길동'), '모델의 변명이 결과에 실렸다');
});

test('sufficient 가 불리언이 아니면 참으로 읽지 않는다', b, async () => {
  for (const bad of ['true', 1, null, undefined]) {
    const f = fakeLlm(json({ sufficient: bad, answerKo: '네 [1].' }));
    const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(1) });
    assert.equal(r.status, 'unparsable', `sufficient=${JSON.stringify(bad)} 를 통과시켰다`);
  }
});

test('sufficient 가 참인데 본문이 비었으면 통과시키지 않는다', b, async () => {
  const f = fakeLlm(json({ sufficient: true, answerKo: '   ' }));
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(1) });
  assert.equal(r.status, 'unparsable');
});

test('JSON 이 아니거나 배열이면 unparsable 이다(모델 산문을 그대로 내보내지 않는다)', b, async () => {
  for (const raw of ['평일 9시부터 18시까지입니다 [1].', '[{"sufficient":true}]', '']) {
    const f = fakeLlm(raw);
    const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(1) });
    assert.equal(r.status, 'unparsable', `원문을 통과시켰다: ${raw}`);
    assert.equal(r.answerKo, undefined);
  }
});

test('extractMarkers 는 규약대로 된 표기만 읽는다', b, () => {
  assert.deepEqual(m.extractMarkers('가 [1] 나 [12] 다 [1]'), [1, 12]);
  assert.deepEqual(m.extractMarkers('[ 1 ] [1,2] [주석] []'), []);
  assert.deepEqual(m.extractMarkers('[0] [01]'), [1], '0 은 인용 번호가 아니다');
});

// ── 실패 경로·경계조건 ────────────────────────────────────────────────────────

test('§9.3 엔진 실패는 던지지 않고 status 로 드러낸다', b, async () => {
  const { EngineError } = await import('../src/adapters/http.ts');
  const f = fakeLlm(() => { throw new EngineError('E_TIMEOUT', 'llm', '응답 지연'); });
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(1) });
  assert.equal(r.status, 'engine_error');
  assert.equal(r.errorCode, 'E_TIMEOUT');
  assert.equal(r.answerKo, undefined);
});

test('EngineError 가 아닌 예외도 통화를 끊지 않는다', b, async () => {
  const f = fakeLlm(() => { throw new Error('소켓이 닫혔다'); });
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(1) });
  assert.equal(r.status, 'engine_error');
  assert.equal(r.errorCode, 'E_UNKNOWN');
});

test('timeoutMs·maxResponseChars 는 준 경우에만 적용된다(§13-3)', b, async () => {
  const slow = fakeLlm(() => new Promise((res) => { setTimeout(() => res(json({ sufficient: true, answerKo: '네 [1].' })), 120); }));
  const r = await make(slow.adapter, { timeoutMs: 20 }).answer({ questionMasked: '질문', grounding: grounded(1) });
  assert.equal(r.status, 'engine_error');
  assert.equal(r.errorCode, 'E_TIMEOUT');

  const big = fakeLlm(json({ sufficient: true, answerKo: `${'가'.repeat(500)} [1].` }));
  const r2 = await make(big.adapter, { maxResponseChars: 50 }).answer({ questionMasked: '질문', grounding: grounded(1) });
  assert.equal(r2.errorCode, 'E_LIMIT');

  const r3 = await make(fakeLlm(json({ sufficient: true, answerKo: `${'가'.repeat(500)} [1].` })).adapter)
    .answer({ questionMasked: '질문', grounding: grounded(1) });
  assert.equal(r3.status, 'ok', '상한을 주지 않으면 제한하지 않는다');
});

test('빈 질문으로는 엔진을 부르지 않는다', b, async () => {
  const f = fakeLlm('불려서는 안 된다');
  for (const q of ['', '   ']) {
    const r = await make(f.adapter).answer({ questionMasked: q, grounding: grounded(1) });
    assert.equal(r.status, 'empty_question');
  }
  assert.equal(f.calls.length, 0);
});

test('§10.3 답변에 남은 개인정보는 나가기 전에 치환된다(근거 청크발 되돌이 경로)', b, async () => {
  const f = fakeLlm(json({ sufficient: true, answerKo: '담당자 연락처는 010-1234-5678 입니다 [1].' }));
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(1) });
  assert.equal(r.status, 'ok');
  assert.equal(r.piiMaskedInAnswer, true);
  assert.ok(!r.answerKo.includes('010-1234-5678'), '원문 번호가 그대로 나갔다');
  assert.match(r.answerKo, /\[1\]/, '마스킹이 인용 번호를 망가뜨리지 않는다');
});

test('§10.3 모델 응답 원문은 결과에 담기지 않는다(길이만 남긴다)', b, async () => {
  const raw = json({ sufficient: true, answerKo: '네 [1].', 메모: '고객이 말한 주소는 서울시…' });
  const f = fakeLlm(raw);
  const r = await make(f.adapter).answer({ questionMasked: '질문', grounding: grounded(1) });
  assert.ok(!JSON.stringify(r).includes('서울시'), '응답 원문이 결과에 실렸다');
  assert.equal(r.responseChars, raw.length);
});

test('§10.3 해외 LLM 은 통화 중이 아니라 생성 시점에 거부된다', b, () => {
  const over = fakeLlm('x', { residency: 'overseas', name: 'far-llm' }).adapter;
  assert.throws(() => make(over), /§10\.3/);
  assert.ok(make(over, { allowOverseas: true }), '허용하면 만들어진다');
});

test('설정 오류는 통화 전에 던진다 — 지시문 없음·잘못된 상한(§13-3)', b, () => {
  const a = fakeLlm('x').adapter;
  assert.throws(() => m.createAnswerer({ scope: SCOPE, llm: a, systemKo: '  ' }), /systemKo|지시문/);
  assert.throws(() => make(a, { timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => make(a, { maxResponseChars: -1 }), /maxResponseChars/);
  assert.throws(() => m.createAnswerer({ scope: { tenantId: '' }, llm: a, systemKo: SYSTEM }), /.+/);
});

test('공개 계약: 버전과 엔진 정보가 드러난다', b, () => {
  const a = make(fakeLlm('x').adapter);
  assert.equal(a.contractVersion, m.ANSWER_CONTRACT_VERSION);
  assert.deepEqual(a.engine, { name: 'fake-llm', residency: 'onprem' });
});

test('폴백 사다리를 다시 쓰지 않는다 — §5.1 판정 이름이 이 파일에 없다(§2 이중 관리 방지)', b, async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/knowledge/answer.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
  for (const name of ['groundingFallback', 'decideFallback', 'failCount']) {
    assert.ok(!code.includes(name), `폴백 판정(${name})을 이 모듈이 하고 있다 — 사다리는 §5.1 한 곳이어야 한다`);
  }
});

test('경계: 답변 생성 결과는 검색 단계(retrieve)의 근거를 그대로 받는다', b, async () => {
  // 두 모듈이 실제로 이어지는지 확인한다 — 타입만 맞고 값이 안 맞는 일이 여기서 드러난다.
  const decision = rag.decideGrounding(
    [{ id: 'd1#0', score: 0.9, namespace: 't/acme/kb/faq', text: '평일 9시부터 18시까지', metadata: { docId: 'd1', title: '영업시간', approved: true } }],
    SCOPE,
    { topK: 3, minScore: 0.5, minHits: 1, maxContextChars: 500 },
  );
  assert.equal(decision.grounded, true);
  const f = fakeLlm(json({ sufficient: true, answerKo: '평일 9시부터 18시까지입니다 [1].' }));
  const r = await make(f.adapter).answer({ questionMasked: '영업시간이요', grounding: decision });
  assert.equal(r.status, 'ok');
  assert.equal(r.citations[0].title, '영업시간');
});
