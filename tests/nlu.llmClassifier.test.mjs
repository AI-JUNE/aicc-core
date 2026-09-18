// LLM 인텐트 분류 배선 — §6.2·§5.1·§10.3·§13-3.
// 네트워크를 쓰지 않는다. LlmAdapter 는 전부 가짜이며, 검사의 초점은 "모델이 이상하게 답했을 때
// 무엇을 하는가" 다. 정상 경로 하나로는 이 모듈의 값어치가 증명되지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let intent = null;
try {
  m = await import('../src/nlu/llmClassifier.ts');
  intent = await import('../src/nlu/intent.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 't1' };
const CATALOG = {
  tenantId: 't1',
  intents: [
    { id: 'card_lost', titleKo: '카드 분실 신고' },
    { id: 'bill_inquiry', titleKo: '요금 조회' },
    { id: 'legacy_only', titleKo: '구 메뉴', disabled: true },
  ],
};

/** 정해진 문자열을 청크로 흘려보내는 가짜 LLM. */
function fakeLlm(reply, { residency = 'onprem', name = 'fake-llm', chunks = 1 } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      name,
      residency,
      complete: async function* (messages) {
        calls.push(messages);
        if (reply instanceof Error) throw reply;
        const size = Math.max(1, Math.ceil(reply.length / chunks));
        for (let i = 0; i < reply.length; i += size) yield reply.slice(i, i + size);
      },
    },
  };
}

const make = (llm, over = {}) =>
  m.createIntentClassifier({ scope: SCOPE, llm, systemKo: '당신은 카드사 상담 분류기다.', ...over });

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('정상: 후보를 그대로 decideIntent 에 넘길 수 있는 형태로 돌려준다', b, async () => {
  const f = fakeLlm('{"candidates":[{"intent":"card_lost","confidence":0.91},{"intent":"bill_inquiry","confidence":0.12}]}');
  const r = await make(f.adapter).classify({ utterance: '카드를 잃어버렸어요', catalog: CATALOG });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.candidates, [
    { intent: 'card_lost', confidence: 0.91 },
    { intent: 'bill_inquiry', confidence: 0.12 },
  ]);
  assert.deepEqual(r.hallucinated, []);
  // 실제로 decideIntent 가 이 입력을 받아 판정까지 간다 — 형태만 맞춘 것이 아님을 고정한다.
  const d = intent.decideIntent({
    scope: SCOPE, candidates: r.candidates, catalog: CATALOG, attempt: 0,
    policy: { tenantId: 't1', acceptThreshold: 0.8, rejectThreshold: 0.2, ambiguityMargin: 0.05, maxClarifyOptions: 3, maxClarifyAttempts: 2 },
  });
  assert.equal(d.kind, 'accepted');
  assert.equal(d.intent, 'card_lost');
});

test('코드펜스·앞뒤 산문이 붙어도 JSON 만 떼어낸다 — 형식은 관용한다', b, async () => {
  const reply = '네, 분류 결과입니다.\n```json\n{"candidates":[{"intent":"bill_inquiry","confidence":0.7}]}\n```\n도움이 되었길 바랍니다.';
  const r = await make(fakeLlm(reply).adapter).classify({ utterance: '요금이 얼마죠', catalog: CATALOG });
  assert.equal(r.status, 'ok');
  assert.equal(r.candidates[0].intent, 'bill_inquiry');
});

test('배열만 온 응답도 받는다 · 청크로 쪼개져 와도 이어 붙인다', b, async () => {
  const f = fakeLlm('[{"intent":"card_lost","confidence":0.5}]', { chunks: 9 });
  const r = await make(f.adapter).classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'ok');
  assert.equal(r.candidates.length, 1);
});

test('해당 없음(빈 배열)은 오류가 아니다 — unmatched 판정은 decideIntent 의 몫이다', b, async () => {
  const r = await make(fakeLlm('{"candidates":[]}').adapter).classify({ utterance: '날씨 어때요', catalog: CATALOG });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.candidates, []);
});

// ── 수치 검증: 이 모듈의 핵심 ────────────────────────────────────────────────

test('0..1 을 벗어난 confidence 를 잘라 맞추지 않고 전체를 버린다', b, async () => {
  // 0..100 으로 준 모델. 클램프하면 95→1.0 이 되어 어떤 임계값이든 무조건 통과한다.
  const r = await make(fakeLlm('{"candidates":[{"intent":"card_lost","confidence":95}]}').adapter)
    .classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'invalid_candidates');
  assert.deepEqual(r.candidates, []);
  assert.match(r.reasonKo, /0\.\.1/);
});

test('confidence 가 빠지거나 문자열·NaN 이면 채우지 않고 버린다(§13-3)', b, async () => {
  for (const bad of ['{"candidates":[{"intent":"card_lost"}]}',
    '{"candidates":[{"intent":"card_lost","confidence":"높음"}]}',
    '{"candidates":[{"intent":"card_lost","confidence":null}]}']) {
    const r = await make(fakeLlm(bad).adapter).classify({ utterance: '분실', catalog: CATALOG });
    assert.equal(r.status, 'invalid_candidates', bad);
    assert.deepEqual(r.candidates, []);
  }
});

test('일부만 어긋나도 후보 전체를 버린다 — 일부만 버리면 순위가 바뀐 채 확정된다', b, async () => {
  const r = await make(fakeLlm('{"candidates":[{"intent":"card_lost","confidence":0.9},{"intent":"bill_inquiry","confidence":7}]}').adapter)
    .classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'invalid_candidates');
  assert.deepEqual(r.candidates, []);
});

test('같은 인텐트가 두 번 오면 병합하지 않고 거부한다', b, async () => {
  const r = await make(fakeLlm('{"candidates":[{"intent":"card_lost","confidence":0.4},{"intent":"card_lost","confidence":0.9}]}').adapter)
    .classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'invalid_candidates');
  assert.match(r.reasonKo, /두 번/);
});

test('경계값 0 과 1 은 통과한다', b, async () => {
  const r = await make(fakeLlm('{"candidates":[{"intent":"card_lost","confidence":1},{"intent":"bill_inquiry","confidence":0}]}').adapter)
    .classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'ok');
  assert.equal(r.candidates.length, 2);
});

// ── 파싱 실패 ────────────────────────────────────────────────────────────────

test('JSON 이 없거나 잘린 응답은 unparsable 이며 던지지 않는다', b, async () => {
  for (const bad of ['죄송합니다, 잘 모르겠습니다.', '{"candidates":[{"intent":"card_lost",', '']) {
    const r = await make(fakeLlm(bad).adapter).classify({ utterance: '분실', catalog: CATALOG });
    assert.equal(r.status, 'unparsable', JSON.stringify(bad));
    assert.equal(r.errorCode, 'E_PROTOCOL');
  }
});

test('candidates 가 배열이 아니면 invalid_candidates', b, async () => {
  const r = await make(fakeLlm('{"candidates":"card_lost"}').adapter).classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'invalid_candidates');
});

test('문자열 안의 중괄호에 속지 않는다', b, async () => {
  const r = await make(fakeLlm('{"note":"a } b","candidates":[{"intent":"card_lost","confidence":0.3}]}').adapter)
    .classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'ok');
  assert.equal(r.candidates[0].confidence, 0.3);
});

// ── 환각: 버리지 않고 드러낸다 ───────────────────────────────────────────────

test('카탈로그에 없는 id 는 버리지 않고 hallucinated 로 드러낸다(판정 주체는 decideIntent 하나)', b, async () => {
  const r = await make(fakeLlm('{"candidates":[{"intent":"만들어낸_인텐트","confidence":0.95},{"intent":"card_lost","confidence":0.4}]}').adapter)
    .classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'ok');
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.hallucinated, ['만들어낸_인텐트']);
  const d = intent.decideIntent({
    scope: SCOPE, candidates: r.candidates, catalog: CATALOG, attempt: 0,
    policy: { tenantId: 't1', acceptThreshold: 0.8, rejectThreshold: 0.2, ambiguityMargin: 0.05, maxClarifyOptions: 3, maxClarifyAttempts: 2 },
  });
  assert.ok(d.ignoredCandidates.includes('만들어낸_인텐트'));   // 버리는 일은 저쪽이 한다
});

test('비활성 인텐트는 프롬프트에 싣지 않는다 — 실으면 모델이 그걸 고른다', b, async () => {
  const f = fakeLlm('{"candidates":[]}');
  await make(f.adapter).classify({ utterance: '구 메뉴', catalog: CATALOG });
  const system = f.calls[0][0].content;
  assert.ok(system.includes('card_lost'));
  assert.ok(!system.includes('legacy_only'), '비활성 인텐트가 프롬프트에 실렸다');
});

test('비활성 id 를 모델이 답하면 환각으로 드러난다', b, async () => {
  const r = await make(fakeLlm('{"candidates":[{"intent":"legacy_only","confidence":0.9}]}').adapter)
    .classify({ utterance: '구 메뉴', catalog: CATALOG });
  assert.deepEqual(r.hallucinated, ['legacy_only']);
});

// ── 마스킹·국외이전(§10.3) ──────────────────────────────────────────────────

test('고객 발화는 마스킹을 거쳐 프롬프트로 나가고, 원문은 결과 어디에도 없다', b, async () => {
  const f = fakeLlm('{"candidates":[]}');
  const raw = '제 번호는 010-1234-5678 입니다';
  const r = await make(f.adapter).classify({ utterance: raw, catalog: CATALOG });
  const user = f.calls[0].at(-1).content;
  assert.ok(!user.includes('010-1234-5678'), '원문 번호가 프롬프트로 나갔다');
  assert.equal(r.piiMasked, true);
  assert.ok(!JSON.stringify(r).includes('010-1234-5678'), '원문 번호가 결과에 남았다');
});

test('해외 LLM 은 허용 없이는 생성 단계에서 거부된다 — 통화 중이 아니라 배포 중에 막는다', b, () => {
  assert.throws(() => make(fakeLlm('{}', { residency: 'overseas' }).adapter), /§10\.3/);
  assert.ok(make(fakeLlm('{}', { residency: 'overseas' }).adapter, { allowOverseas: true }));
});

test('응답 원문을 결과에 싣지 않는다 — 모델은 발화를 되풀이한다', b, async () => {
  const echo = '{"candidates":[{"intent":"card_lost","confidence":0.9}],"echo":"010-9999-8888"}';
  const r = await make(fakeLlm(echo).adapter).classify({ utterance: '분실', catalog: CATALOG });
  assert.ok(!JSON.stringify(r).includes('010-9999-8888'));
  assert.equal(r.responseChars, echo.length);   // 실측 길이만 남는다(§11.2)
});

// ── 경계조건 ─────────────────────────────────────────────────────────────────

test('빈 발화는 엔진을 부르지 않는다', b, async () => {
  const f = fakeLlm('{"candidates":[]}');
  for (const u of ['', '   ']) {
    const r = await make(f.adapter).classify({ utterance: u, catalog: CATALOG });
    assert.equal(r.status, 'empty_input');
    assert.equal(r.promptChars, 0);
  }
  assert.equal(f.calls.length, 0, '빈 발화로 엔진을 불렀다');
});

test('엔진이 던져도 분류기는 던지지 않고 engine_error 로 드러낸다(§9.3)', b, async () => {
  const r = await make(fakeLlm(new Error('연결이 끊어졌습니다 010-1111-2222')).adapter)
    .classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'engine_error');
  assert.equal(r.errorCode, 'E_UNKNOWN');
  assert.ok(!r.reasonKo.includes('010-1111-2222'), '오류 사유에 개인정보가 남았다');
});

test('타임아웃은 주었을 때만 적용된다(§13-3)', b, async () => {
  const slow = {
    name: 'slow', residency: 'onprem',
    complete: async function* () { await new Promise((r) => setTimeout(r, 60)); yield '{"candidates":[]}'; },
  };
  const r = await make(slow, { timeoutMs: 10 }).classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'engine_error');
  assert.equal(r.errorCode, 'E_TIMEOUT');
  const ok = await make(slow).classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(ok.status, 'ok');   // 안 주면 종전과 같다
});

test('응답 길이 상한을 넘으면 잘라서 파싱하지 않고 E_LIMIT 으로 끊는다', b, async () => {
  const r = await make(fakeLlm('{"candidates":[{"intent":"card_lost","confidence":0.9}]}').adapter, { maxResponseChars: 10 })
    .classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'engine_error');
  assert.equal(r.errorCode, 'E_LIMIT');
});

test('다른 테넌트 카탈로그·깨진 카탈로그는 엔진을 부르기 전에 거부한다(§11.1)', b, async () => {
  const f = fakeLlm('{"candidates":[]}');
  const other = await make(f.adapter).classify({ utterance: '분실', catalog: { ...CATALOG, tenantId: 't2' } });
  assert.equal(other.status, 'invalid_candidates');
  assert.equal(other.errorCode, 'E_CONFIG');
  const empty = await make(f.adapter).classify({ utterance: '분실', catalog: { tenantId: 't1', intents: [] } });
  assert.equal(empty.status, 'invalid_candidates');
  assert.equal(f.calls.length, 0, '거부해야 할 요청으로 엔진을 불렀다');
});

test('설정 오류는 생성 시점에 던진다 — 기본 문안을 만들지 않는다(§13-3)', b, () => {
  const llm = fakeLlm('{}').adapter;
  assert.throws(() => m.createIntentClassifier({ scope: SCOPE, llm, systemKo: '  ' }), /§13-3/);
  assert.throws(() => m.createIntentClassifier({ scope: SCOPE, llm, systemKo: 'x', timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => m.createIntentClassifier({ scope: SCOPE, llm, systemKo: 'x', maxResponseChars: -1 }), /maxResponseChars/);
});

test('plan() 은 실호출 없이 프롬프트를 확인시켜 준다', b, () => {
  const f = fakeLlm('{"candidates":[]}');
  const p = make(f.adapter).plan({ utterance: '카드 분실', catalog: CATALOG });
  assert.equal(f.calls.length, 0);
  assert.equal(p.messages[0].role, 'system');
  assert.ok(p.promptChars > 0);
});

test('맥락(historyMasked)은 시스템 지시와 이번 발화 사이에 들어간다', b, async () => {
  const f = fakeLlm('{"candidates":[]}');
  await make(f.adapter).classify({
    utterance: '네', catalog: CATALOG,
    historyMasked: [{ role: 'assistant', content: '카드 분실 신고를 도와드릴까요?' }],
  });
  const msgs = f.calls[0];
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[2].content, '네');
});

test('스트림이 문자열 아닌 값을 내보내면 E_PROTOCOL 로 드러낸다', b, async () => {
  const badStream = { name: 'x', residency: 'onprem', complete: async function* () { yield 42; } };
  const r = await make(badStream).classify({ utterance: '분실', catalog: CATALOG });
  assert.equal(r.status, 'engine_error');
  assert.equal(r.errorCode, 'E_PROTOCOL');
});
