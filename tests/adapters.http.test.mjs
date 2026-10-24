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

// ── TTS 응답 판정(중립 JSON 경로) ────────────────────────────────────────────
// 여기서 막는 것은 전부 예외가 아니라 **조용한 오답**이다 — 통화는 이어지고 고객만 무음·잡음을
// 듣는다. 같은 검사가 규격 어댑터(openaiAudio)에는 있었고 이 경로에만 없었다.

const ttsSet = (payload) => {
  const f = fakeFetch(() => jsonRes(payload));
  return h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
};
const drainTts = async (e) => { for await (const _ of e.tts.synthesize('안내드립니다')) { /* noop */ } };

test('오디오가 아닌 mime 은 거절한다 — 200 으로 싸인 오류 JSON 을 재생하지 않는다(§9.3)', b, async () => {
  const errorBody = h.toBase64(new TextEncoder().encode('{"error":"quota exceeded"}'));
  assert.throws(() => h.parseTtsResponse({ audio_base64: errorBody, mime: 'application/json' }), (err) => {
    assert.equal(err.code, 'E_PROTOCOL');
    assert.equal(err.component, 'tts');
    assert.match(err.message, /오디오가 아닌 응답 형식: application\/json/);
    return true;
  });
  assert.throws(() => h.parseTtsResponse({ audio_base64: errorBody, mime: 'text/html; charset=utf-8' }),
    (err) => err.code === 'E_PROTOCOL');
  // 어댑터 경로에서도 같은 판정이다 — 파서만 고치고 어댑터가 비껴가면 의미가 없다.
  await assert.rejects(() => drainTts(ttsSet({ audio_base64: errorBody, mime: 'application/json' })),
    (err) => err.code === 'E_PROTOCOL');
});

test('빈 오디오는 거절한다 — 0바이트를 내려보내면 고객에게는 무음이고 장애로 잡히지 않는다', b, async () => {
  for (const empty of ['', '  \n ']) {
    assert.throws(() => h.parseTtsResponse({ audio_base64: empty, mime: 'audio/wav' }), (err) => {
      assert.equal(err.code, 'E_PROTOCOL');
      assert.match(err.message, /비어 있습니다/);
      return true;
    });
  }
  await assert.rejects(() => drainTts(ttsSet({ audio_base64: '', mime: 'audio/mpeg' })),
    (err) => err.code === 'E_PROTOCOL');
});

test('base64 가 아닌 본문은 거절한다 — 디코더가 알파벳 밖 문자를 지우고 그럴듯한 바이트를 만든다', b, () => {
  // 디코더의 관용함을 그대로 확인해 둔다. 이것이 바로 호출 전에 걸러야 하는 이유다.
  assert.ok(h.fromBase64('{"error":"nope"}').length > 0);
  for (const bad of ['{"error":"nope"}', 'YWJj!', 'YWJ', '####']) {
    assert.throws(() => h.parseTtsResponse({ audio_base64: bad, mime: 'audio/wav' }), (err) => {
      assert.equal(err.code, 'E_PROTOCOL');
      assert.match(err.message, /base64 형태가 아닙니다/);
      return true;
    }, `거절되지 않았다: ${bad}`);
  }
});

test('정상 경로: 줄바꿈이 섞인 base64·매개변수가 붙은 mime 은 통과하고 mime 은 정규화된다', b, async () => {
  const raw = h.toBase64(new TextEncoder().encode('음성 바이트'));
  const wrapped = `${raw.slice(0, 4)}\n  ${raw.slice(4)}\n`;   // 일부 서버가 줄을 끊어 보낸다
  const r = h.parseTtsResponse({ audio_base64: wrapped, mime: 'Audio/MPEG; charset=utf-8' });
  assert.equal(new TextDecoder().decode(r.chunk.data), '음성 바이트');
  assert.equal(r.chunk.mime, 'audio/mpeg');
  assert.equal(r.usage, undefined);                            // 안 준 사용량을 만들지 않는다(§13-3)
  // 형식을 밝히지 않은 바이트는 실제 TTS 서버가 흔히 쓴다 — 막으면 정상 엔진이 붙지 못한다.
  assert.equal(h.parseTtsResponse({ audio_base64: raw, mime: 'application/octet-stream' }).chunk.mime,
    'application/octet-stream');
});

test('mime 판정은 한 곳이다 — 중립 경로와 규격 어댑터가 같은 함수를 쓴다(§2)', b, () => {
  assert.equal(h.isAudioMime('audio/wav'), true);
  assert.equal(h.isAudioMime('AUDIO/WAV; rate=8000'), true);
  assert.equal(h.isAudioMime('application/octet-stream'), true);
  assert.equal(h.isAudioMime('application/json'), false);
  assert.equal(h.isAudioMime(''), false);
  assert.equal(h.normalizeMime('  Audio/Wav ; x=1'), 'audio/wav');
  assert.deepEqual(h.base64Shape('YW Jj\n'), { ok: true, clean: 'YWJj' });
  assert.equal(h.base64Shape('YWJ').ok, false);
  assert.equal(h.base64Shape('').ok, false);
});

test('응답 형식 위반은 조용히 넘기지 않는다', b, async () => {
  const f = fakeFetch(() => jsonRes({ embeddings: [[0.1, 0.2]] }));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
  await assert.rejects(() => e.embedding.embed(['가', '나']), (err) => err.code === 'E_PROTOCOL');
  assert.throws(() => h.parseLlmResponse({ nope: 1 }), (err) => err.code === 'E_PROTOCOL');
  assert.throws(() => h.parseSttResponse('문자열'), (err) => err.code === 'E_PROTOCOL');
});

// ── §11.2 임베딩 실측 ─────────────────────────────────────────────────────────
// 중립 JSON 규약에도 `usage` 를 실을 자리가 있었는데 **읽는 코드가 한 줄도 없었다**.
// 그 토큰은 공급사 청구서에만 남고 §8.1 원장에는 0줄이라, 몇 주 뒤 대사에서 '미설명' 차이로만
// 돌아온다(방향이 과소청구라 과다청구 차단에도 걸리지 않는다).

test('임베딩 토큰이 lastUsage 로 올라온다 — 자리가 없던 동안은 통째로 사라졌다(§11.2)', b, async () => {
  const f = fakeFetch(() => jsonRes({ embeddings: [[0.1, 0.2]], usage: { embedding_tokens: 14 } }));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
  assert.deepEqual(await e.embedding.embed(['가']), [[0.1, 0.2]]);
  assert.deepEqual(e.lastUsage(), { embedding_tokens: 14 });
});

test('임베딩 실측 실패 경로: 없거나 못 쓰는 값은 만들지 않는다(§13-3)', b, async () => {
  // 실측이 없으면 `usage` 키 자체가 없다 — 빈 객체는 "0 토큰을 실측했다"로 읽힌다.
  assert.deepEqual(h.parseEmbeddingResponse({ embeddings: [[1]] }, 1), { vectors: [[1]] });
  assert.equal('usage' in h.parseEmbeddingResponse({ embeddings: [[1]] }, 1), false);
  assert.equal('usage' in h.parseEmbeddingResponse({ embeddings: [[1]], usage: { embedding_tokens: 'x' } }, 1), false);
  // 벡터 검증이 먼저다 — 실측이 멀쩡해도 어긋난 벡터는 색인에 들어가지 않는다(§5.2).
  assert.throws(
    () => h.parseEmbeddingResponse({ embeddings: [[1], [2]], usage: { embedding_tokens: 3 } }, 1),
    (err) => err.code === 'E_PROTOCOL',
  );
  // 엔진이 주지 않은 턴은 직전 호출 값을 되풀이하지 않는다(그 되풀이가 곧 이중 계상이다).
  const f = fakeFetch(() => jsonRes({ embeddings: [[0.1]] }));
  const e = h.createHttpEngineSet({ ...BASE, activation: 'live', approvalRef: 'T', fetchImpl: f, resolveSecret: () => 'k' });
  await e.embedding.embed(['가']);
  assert.equal(e.lastUsage(), undefined);
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
