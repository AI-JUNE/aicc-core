import { test } from 'node:test';
import assert from 'node:assert/strict';

let h = null;
try { h = await import('../src/adapters/http.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: h ? false : '타입 스트리핑 미지원 런타임' };

const BASE = {
  name: 'demo', residency: 'domestic', baseUrl: 'https://engine.example.co.kr',
  paths: { stt: '/v1/stt', tts: '/v1/tts', llm: '/v1/chat', embedding: '/v1/embed' },
  timeoutMs: 1000, activation: 'dry_run', apiKeyEnv: 'DEMO_KEY',
};

/** 호출 기록형 가짜 전송. 실제 네트워크는 절대 쓰지 않는다. */
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

test('dry_run 은 네트워크를 쓰지 않고 [승인 필요]로 거절한다', b, async () => {
  const f = fakeFetch(() => jsonRes({ text: '안 됩니다' }));
  const e = h.createHttpEngineSet({ ...BASE, fetchImpl: f });
  await assert.rejects(() => e.llm.completeOnce([{ role: 'user', content: '안녕' }]), (err) => {
    assert.equal(err.code, 'E_APPROVAL_REQUIRED');
    assert.match(err.message, /승인 필요/);
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test('요청 계획에 실키가 담기지 않는다', b, () => {
  const e = h.createHttpEngineSet(BASE);
  const plan = e.plan('llm', { messages: [] });
  assert.equal(plan.url, 'https://engine.example.co.kr/v1/chat');
  assert.match(plan.headers.authorization, /DEMO_KEY/);
  assert.equal(plan.headers.authorization.includes('secret'), false);
  assert.equal(plan.activation, 'dry_run');
});

test('승인 근거 없이 live 로 만들 수 없다', b, () => {
  assert.throws(() => h.createHttpEngineSet({ ...BASE, activation: 'live', fetchImpl: fakeFetch(() => jsonRes({})) , resolveSecret: () => 'k' }),
    (err) => err.code === 'E_APPROVAL_REQUIRED');
});

test('live: 응답 파싱·사용량 환산·지연 실측', b, async () => {
  let t = 1000;
  const f = fakeFetch(() => jsonRes({ text: '답변', usage: { prompt_tokens: 12, completion_tokens: 5 } }));
  const e = h.createHttpEngineSet({
    ...BASE, activation: 'live', approvalRef: 'TEST-승인', fetchImpl: f,
    resolveSecret: () => 'super-secret', clock: () => (t += 40),
  });
  const r = await e.llm.completeOnce([{ role: 'user', content: '요금 알려줘' }]);
  assert.equal(r.text, '답변');
  assert.deepEqual(r.usage, { llm_prompt_tokens: 12, llm_completion_tokens: 5 });
  assert.equal(typeof r.latency.total_ms, 'number');
  assert.deepEqual(e.lastUsage(), { llm_prompt_tokens: 12, llm_completion_tokens: 5 });
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer super-secret');
});

test('외부로 나가는 텍스트는 마스킹을 거친다(§10.3)', b, async () => {
  const f = fakeFetch(() => jsonRes({ text: 'ok' }));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
  await e.llm.completeOnce([{ role: 'user', content: '제 주민번호는 901010-1234567 입니다' }]);
  const sent = f.calls[0].body.messages[0].content;
  assert.equal(sent.includes('1234567'), false);
  assert.match(sent, /901010-\*{7}/);
});

test('비2xx 응답은 본문을 되싣지 않고 E_HTTP 로 드러낸다', b, async () => {
  const f = fakeFetch(() => jsonRes({ echo: '고객 발화 010-1234-5678' }, 500));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
  await assert.rejects(() => e.llm.completeOnce([{ role: 'user', content: '안녕' }]), (err) => {
    assert.equal(err.code, 'E_HTTP');
    assert.equal(err.message.includes('1234'), false);
    assert.equal(err.detail.status, 500);
    return true;
  });
});

test('응답이 지연되면 타임아웃으로 끊는다', b, async () => {
  const f = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', timeoutMs: 10, fetchImpl: f, resolveSecret: () => 'k' });
  await assert.rejects(() => e.llm.completeOnce([{ role: 'user', content: '안녕' }]), (err) => err.code === 'E_TIMEOUT');
});

test('빈 입력은 호출 전에 거절한다', b, async () => {
  const f = fakeFetch(() => jsonRes({ text: 'x' }));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
  await assert.rejects(() => e.llm.completeOnce([]), (err) => err.code === 'E_INPUT');
  assert.deepEqual(await e.embedding.embed([]), []);
  const empty = (async function* () {})();
  await assert.rejects(async () => { for await (const _ of e.stt.stream(empty)) { /* noop */ } }, (err) => err.code === 'E_INPUT');
  assert.equal(f.calls.length, 0);
});

test('오디오 상한을 넘으면 보내지 않는다', b, async () => {
  const f = fakeFetch(() => jsonRes({ text: 'x' }));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', maxAudioBytes: 4, fetchImpl: f, resolveSecret: () => 'k' });
  const audio = (async function* () { yield { data: new Uint8Array([1, 2, 3]), mime: 'audio/l16' }; yield { data: new Uint8Array([4, 5, 6]), mime: 'audio/l16' }; })();
  await assert.rejects(async () => { for await (const _ of e.stt.stream(audio)) { /* noop */ } }, (err) => err.code === 'E_LIMIT');
  assert.equal(f.calls.length, 0);
});

test('STT·TTS 왕복과 base64 정합', b, async () => {
  const f = fakeFetch((url) => url.endsWith('/v1/stt')
    ? jsonRes({ text: '요금 문의', is_final: true, confidence: 0.82, usage: { stt_audio_ms: 1200 } })
    : jsonRes({ audio_base64: h.toBase64(new TextEncoder().encode('음성')), mime: 'audio/wav', usage: { tts_audio_ms: 900 } }));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
  const audio = (async function* () { yield { data: new Uint8Array([7, 8, 9, 10]), mime: 'audio/l16' }; })();
  const out = [];
  for await (const r of e.stt.stream(audio)) out.push(r);
  assert.deepEqual(out, [{ text: '요금 문의', isFinal: true, confidence: 0.82 }]);
  const chunks = [];
  for await (const c of e.tts.synthesize('안내드립니다')) chunks.push(c);
  assert.equal(new TextDecoder().decode(chunks[0].data), '음성');
  assert.deepEqual(e.lastUsage(), { tts_audio_ms: 900 });
});

test('응답 형식 위반은 조용히 넘기지 않는다', b, async () => {
  const f = fakeFetch(() => jsonRes({ embeddings: [[0.1, 0.2]] }));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
  await assert.rejects(() => e.embedding.embed(['가', '나']), (err) => err.code === 'E_PROTOCOL');
  assert.throws(() => h.parseLlmResponse({ nope: 1 }), (err) => err.code === 'E_PROTOCOL');
  assert.throws(() => h.parseSttResponse('문자열'), (err) => err.code === 'E_PROTOCOL');
});

test('활성화 상태는 환경변수로 실수로 켜지지 않는다', b, () => {
  assert.equal(h.activationFromEnv({}), 'dry_run');
  assert.equal(h.activationFromEnv({ AICC_ENGINE_ACTIVATION: 'true' }), 'dry_run');
  assert.equal(h.activationFromEnv({ AICC_ENGINE_ACTIVATION: 'live' }), 'live');
});

test('base64 왕복', b, () => {
  for (const s of ['', 'a', 'ab', 'abc', '한글 텍스트 12345']) {
    const bytes = new TextEncoder().encode(s);
    assert.equal(new TextDecoder().decode(h.fromBase64(h.toBase64(bytes))), s);
  }
});
