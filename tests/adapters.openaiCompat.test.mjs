// OpenAI 호환 규격 어댑터 — §6.2·§9.3·§10.3·§11.2·§13-3.
// 실제 네트워크는 절대 쓰지 않는다. 전송은 기록형 가짜다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let idx = null;
try {
  m = await import('../src/adapters/openaiCompat.ts');
  idx = await import('../src/adapters/index.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const BASE = {
  name: 'onprem-sllm', residency: 'onprem', baseUrl: 'http://sllm.internal:8000',
  timeoutMs: 1000, activation: 'dry_run', apiKeyEnv: 'SLLM_KEY',
  chatModel: 'company-sllm-7b', embeddingModel: 'company-embed-v1',
};
const LIVE = { ...BASE, activation: 'live', approvalRef: 'TEST-승인', resolveSecret: () => 'super-secret' };

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}
const jsonRes = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
const chatRes = (content, extra = {}) => jsonRes({
  id: 'chatcmpl-1', model: 'company-sllm-7b',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
  ...extra,
});

// ── 활성화·설정 ────────────────────────────────────────────────────────────────

test('dry_run 은 네트워크를 쓰지 않고 [승인 필요]로 거절한다', b, async () => {
  const f = fakeFetch(() => chatRes('답'));
  const e = m.createOpenAiCompatEngines({ ...BASE, fetchImpl: f });
  assert.equal(e.activation, 'dry_run');
  await assert.rejects(() => e.llm.completeOnce([{ role: 'user', content: '안녕' }]), (err) => {
    assert.equal(err.code, 'E_APPROVAL_REQUIRED');
    assert.match(err.message, /승인 필요/);
    return true;
  });
  await assert.rejects(() => e.embedding.embed(['문서']), (err) => err.code === 'E_APPROVAL_REQUIRED');
  assert.equal(f.calls.length, 0);
});

test('요청 계획은 규격 경로·모델을 담고 실키는 담지 않는다', b, () => {
  const e = m.createOpenAiCompatEngines(BASE);
  const plan = e.plan('llm', { model: 'x' });
  assert.equal(plan.url, 'http://sllm.internal:8000/v1/chat/completions');
  assert.equal(e.plan('embedding', {}).url, 'http://sllm.internal:8000/v1/embeddings');
  assert.match(plan.headers.authorization, /SLLM_KEY/);
  assert.equal(JSON.stringify(plan).includes('super-secret'), false);
  assert.equal(plan.residency, 'onprem');
  // 프리픽스 재정의(프록시 경유)
  const p = m.createOpenAiCompatEngines({ ...BASE, paths: { chat: '/gateway/openai/v1/chat/completions' } });
  assert.equal(p.plan('llm', {}).url, 'http://sllm.internal:8000/gateway/openai/v1/chat/completions');
});

test('설정 거부: 모델 둘 다 없음·승인 없는 live·잘못된 상한', b, () => {
  assert.throws(() => m.createOpenAiCompatEngines({ ...BASE, chatModel: undefined, embeddingModel: undefined }),
    (err) => err.code === 'E_CONFIG');
  assert.throws(() => m.createOpenAiCompatEngines({ ...BASE, activation: 'live', resolveSecret: () => 'k', fetchImpl: fakeFetch(() => chatRes('x')) }),
    (err) => err.code === 'E_APPROVAL_REQUIRED');
  assert.throws(() => m.createOpenAiCompatEngines({ ...BASE, maxTokens: 0 }), (err) => err.code === 'E_CONFIG');
  assert.throws(() => m.createOpenAiCompatEngines({ ...BASE, temperature: -1 }), (err) => err.code === 'E_CONFIG');
  assert.throws(() => m.createOpenAiCompatEngines({ ...BASE, maxEmbeddingBatch: 1.5 }), (err) => err.code === 'E_CONFIG');
});

test('모델을 하나만 주면 그 어댑터만 만들어진다(기본 모델 없음, §13-3)', b, () => {
  const onlyChat = m.createOpenAiCompatEngines({ ...BASE, embeddingModel: undefined });
  assert.ok(onlyChat.llm);
  assert.equal(onlyChat.embedding, undefined);
  const onlyEmbed = m.createOpenAiCompatEngines({ ...BASE, chatModel: undefined });
  assert.equal(onlyEmbed.llm, undefined);
  assert.ok(onlyEmbed.embedding);
});

// ── LLM 정상 경로 ─────────────────────────────────────────────────────────────

test('live: 규격 요청 본문·Bearer 헤더·응답 파싱·사용량·지연 실측', b, async () => {
  let t = 1000;
  const f = fakeFetch(() => chatRes('요금은 안내드리겠습니다.'));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f, clock: () => (t += 30), maxTokens: 256, temperature: 0.2 });
  const r = await e.llm.completeOnce([{ role: 'system', content: '상담사' }, { role: 'user', content: '요금 알려줘' }]);
  assert.equal(r.text, '요금은 안내드리겠습니다.');
  assert.equal(r.finishReason, 'stop');
  assert.equal(r.truncated, false);
  assert.equal(r.model, 'company-sllm-7b');
  assert.deepEqual(r.usage, { llm_prompt_tokens: 20, llm_completion_tokens: 7 });
  assert.equal(r.latency.total_ms, 30);
  assert.deepEqual(e.lastUsage(), r.usage);
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'http://sllm.internal:8000/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer super-secret');
  assert.equal(body.model, 'company-sllm-7b');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 256);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages.map((x) => x.role), ['system', 'user']);
});

test('주지 않은 max_tokens·temperature 는 요청에 실리지 않는다(§13-3)', b, async () => {
  const f = fakeFetch(() => chatRes('답'));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f });
  await e.llm.completeOnce([{ role: 'user', content: '안녕' }]);
  assert.equal('max_tokens' in f.calls[0].body, false);
  assert.equal('temperature' in f.calls[0].body, false);
});

test('나가는 발화는 마스킹을 지난다(§10.3) — 끄려면 명시해야 한다', b, async () => {
  const f = fakeFetch(() => chatRes('답'));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f });
  await e.llm.completeOnce([{ role: 'user', content: '제 번호는 010-1234-5678 입니다' }]);
  assert.equal(JSON.stringify(f.calls[0].body).includes('010-1234-5678'), false);
  const plain = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f, maskOutbound: false });
  await plain.llm.completeOnce([{ role: 'user', content: '제 번호는 010-1234-5678 입니다' }]);
  assert.equal(JSON.stringify(f.calls[1].body).includes('010-1234-5678'), true);
});

test('complete() 스트림 인터페이스(§6.2 LlmAdapter)도 같은 경로를 탄다', b, async () => {
  const f = fakeFetch(() => chatRes('한 번에'));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f });
  const parts = [];
  for await (const p of e.llm.complete([{ role: 'user', content: '안녕' }])) parts.push(p);
  assert.deepEqual(parts, ['한 번에']);
});

// ── LLM 실패 경로 ─────────────────────────────────────────────────────────────

test('빈 메시지·빈 내용은 호출 전에 거절한다', b, async () => {
  const f = fakeFetch(() => chatRes('답'));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f });
  await assert.rejects(() => e.llm.completeOnce([]), (err) => err.code === 'E_INPUT');
  await assert.rejects(() => e.llm.completeOnce([{ role: 'user', content: '   ' }]), (err) => err.code === 'E_INPUT');
  assert.equal(f.calls.length, 0);
});

test('잘림(length)은 오류가 아니라 사실로 드러낸다', b, async () => {
  const f = fakeFetch(() => jsonRes({ choices: [{ message: { content: '안내가 길어져서' }, finish_reason: 'length' }] }));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f });
  const r = await e.llm.completeOnce([{ role: 'user', content: '안녕' }]);
  assert.equal(r.truncated, true);
  assert.equal(r.finishReason, 'length');
  assert.equal(r.usage, undefined);   // 사용량이 없으면 만들어 넣지 않는다
});

test('콘텐츠 필터·도구 호출·choices 누락은 조용히 넘기지 않는다(§9.3)', b, async () => {
  const cases = [
    [{ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }, 'E_FILTERED'],
    [{ choices: [{ message: { content: null, tool_calls: [{ id: 'c1' }] }, finish_reason: 'tool_calls' }] }, 'E_PROTOCOL'],
    [{ choices: [] }, 'E_PROTOCOL'],
    [{ id: 'x' }, 'E_PROTOCOL'],
    [[], 'E_PROTOCOL'],
  ];
  for (const [raw, code] of cases) {
    const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: fakeFetch(() => jsonRes(raw)) });
    await assert.rejects(() => e.llm.completeOnce([{ role: 'user', content: '안녕' }]),
      (err) => err.code === code, `${JSON.stringify(raw)} → ${code}`);
  }
  assert.throws(() => m.parseChatCompletion({ choices: [{ message: { content: null, tool_calls: [] } }] }),
    (err) => /도구 호출/.test(err.message));
});

test('비2xx 는 상태만 싣고 본문(발화 반향)을 싣지 않으며 재시도 가능 여부를 표시한다', b, async () => {
  const f = fakeFetch(() => ({ ok: false, status: 429, text: async () => '{"error":{"message":"rate limited: 010-1234-5678"}}' }));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f });
  await assert.rejects(() => e.llm.completeOnce([{ role: 'user', content: '안녕' }]), (err) => {
    assert.equal(err.code, 'E_HTTP');
    assert.equal(err.detail.status, 429);
    assert.equal(err.detail.retryable, true);
    assert.equal(JSON.stringify({ m: err.message, d: err.detail }).includes('010-1234-5678'), false);
    return true;
  });
  const f4 = fakeFetch(() => ({ ok: false, status: 401, text: async () => '{}' }));
  const e4 = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f4 });
  await assert.rejects(() => e4.llm.completeOnce([{ role: 'user', content: '안녕' }]),
    (err) => err.code === 'E_HTTP' && err.detail.retryable === false);
});

test('응답 지연은 E_TIMEOUT 으로 끝난다(무한 대기 없음)', b, async () => {
  const f = async (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f, timeoutMs: 20 });
  await assert.rejects(() => e.llm.completeOnce([{ role: 'user', content: '안녕' }]), (err) => err.code === 'E_TIMEOUT');
});

// ── 임베딩 ─────────────────────────────────────────────────────────────────────

test('임베딩: 규격 요청·index 로 순서 복원·사용량은 기록하지 않는다', b, async () => {
  const f = fakeFetch(() => jsonRes({
    object: 'list',
    data: [
      { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
      { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
    ],
    usage: { prompt_tokens: 9, total_tokens: 9 },
  }));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f });
  const v = await e.embedding.embed(['첫째 010-1234-5678', '둘째']);
  assert.deepEqual(v, [[0.1, 0.2], [0.3, 0.4]]);
  const { url, body } = f.calls[0];
  assert.equal(url, 'http://sllm.internal:8000/v1/embeddings');
  assert.equal(body.model, 'company-embed-v1');
  assert.equal(body.encoding_format, 'float');
  assert.equal(body.input.length, 2);
  assert.equal(JSON.stringify(body).includes('010-1234-5678'), false);   // §10.3
  assert.equal(e.lastUsage(), undefined);   // 임베딩 토큰을 LLM 칸에 섞지 않는다(§11.2)
});

test('임베딩 실패 경로: 개수·index 중복/범위·차원·숫자 위반은 전부 E_PROTOCOL', b, () => {
  const bad = [
    { data: [{ index: 0, embedding: [1] }] },                                        // 개수 부족
    { data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] },         // 중복
    { data: [{ index: 0, embedding: [1] }, { index: 5, embedding: [2] }] },         // 범위 밖
    { data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [2] }] },      // 차원
    { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: ['x'] }] },       // 숫자 아님
    { data: [{ index: 0, embedding: [] }, { index: 1, embedding: [1] }] },          // 빈 벡터
    { data: 'nope' },
  ];
  for (const raw of bad) {
    assert.throws(() => m.parseEmbeddings(raw, 2), (err) => err.code === 'E_PROTOCOL', JSON.stringify(raw));
  }
  assert.deepEqual(m.parseEmbeddings({ data: [{ index: 0, embedding: [0.5] }] }, 1), [[0.5]]);
});

test('임베딩 경계: 빈 입력은 무호출 · 빈 문자열·배치 상한 초과는 호출 전 거절', b, async () => {
  const f = fakeFetch(() => jsonRes({ data: [] }));
  const e = m.createOpenAiCompatEngines({ ...LIVE, fetchImpl: f, maxEmbeddingBatch: 2 });
  assert.deepEqual(await e.embedding.embed([]), []);
  await assert.rejects(() => e.embedding.embed(['a', '']), (err) => err.code === 'E_INPUT');
  await assert.rejects(() => e.embedding.embed(['a', 'b', 'c']), (err) => err.code === 'E_LIMIT');
  assert.equal(f.calls.length, 0);
});

// ── §10.3 국외이전 가드와의 결합 ────────────────────────────────────────────────

test('해외 OpenAI 호환 엔진은 국외이전 불가 테넌트에서 사전 차단된다(§10.3)', b, () => {
  const overseas = m.createOpenAiCompatEngines({ ...BASE, residency: 'overseas', name: 'overseas-llm' });
  const sim = { name: 'sim', residency: 'domestic', stream: async function* () {}, synthesize: async function* () {} };
  const engines = { stt: sim, tts: sim, llm: overseas.llm, embedding: overseas.embedding };
  assert.throws(() => idx.assertResidency(engines, false), /llm, embedding/);
  assert.doesNotThrow(() => idx.assertResidency(engines, true));
  const onprem = m.createOpenAiCompatEngines(BASE);
  assert.doesNotThrow(() => idx.assertResidency({ stt: sim, tts: sim, llm: onprem.llm, embedding: onprem.embedding }, false));
});
