// OpenAI 호환 음성 규격 어댑터 — §6.2·§9.3·§10.3·§11.2·§13-3.
// 실제 네트워크는 절대 쓰지 않는다. 전송은 기록형 가짜다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let idx = null;
try {
  m = await import('../src/adapters/openaiAudio.ts');
  idx = await import('../src/adapters/index.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const BASE = {
  name: 'onprem-whisper', residency: 'onprem', baseUrl: 'http://voice.internal:8000',
  timeoutMs: 1000, activation: 'dry_run', apiKeyEnv: 'VOICE_KEY',
  sttModel: 'whisper-large-v3-ko', ttsModel: 'tts-ko-1', ttsVoice: 'nara',
  boundary: () => 'testboundary123',
};
const LIVE = { ...BASE, activation: 'live', approvalRef: 'TEST-승인', resolveSecret: () => 'super-secret' };

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}
const jsonRes = (obj, status = 200, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => JSON.stringify(obj),
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(obj)).buffer,
});
const binRes = (bytes, contentType = 'audio/mpeg', extra = {}) => ({
  ok: true, status: 200,
  headers: contentType === null ? undefined : { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => new TextDecoder().decode(bytes),
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  ...extra,
});
async function* chunks(...parts) { for (const p of parts) yield p; }
const wav = (n, fill = 7) => ({ data: new Uint8Array(n).fill(fill), mime: 'audio/wav' });
async function drain(it) { const out = []; for await (const x of it) out.push(x); return out; }

/** 가짜 전송이 받은 멀티파트 본문을 되읽는다(경계·필드 순서·바이너리 보존 확인용). */
function parseMultipart(bytes, boundary) {
  const text = new TextDecoder('latin1').decode(bytes);
  const parts = text.split(`--${boundary}`).slice(1);
  const out = [];
  for (const p of parts) {
    if (p.startsWith('--')) break;
    const [head, ...rest] = p.replace(/^\r\n/, '').split('\r\n\r\n');
    const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    out.push({ name, filename, head, body });
  }
  return out;
}

// ── 활성화·설정 ────────────────────────────────────────────────────────────────

test('dry_run 은 네트워크를 쓰지 않고 [승인 필요]로 거절한다 (STT·TTS 모두)', b, async () => {
  const f = fakeFetch(() => jsonRes({ text: 'x' }));
  const e = m.createOpenAiAudioEngines({ ...BASE, fetchImpl: f });
  assert.equal(e.activation, 'dry_run');
  await assert.rejects(() => drain(e.stt.stream(chunks(wav(10)))), (err) => {
    assert.equal(err.code, 'E_APPROVAL_REQUIRED');
    assert.match(err.message, /승인 필요/);
    // 거절 사유의 계획에도 오디오 바이트는 실리지 않는다 — 크기·mime 서술만.
    assert.deepEqual(err.detail.plan.body.file, { bytes: 10, mime: 'audio/wav', filename: 'audio.wav' });
    assert.match(err.detail.plan.headers['content-type'], /^multipart\/form-data/);
    return true;
  });
  await assert.rejects(() => drain(e.tts.synthesize('안녕하세요')), (err) => err.code === 'E_APPROVAL_REQUIRED');
  assert.equal(f.calls.length, 0);
});

test('요청 계획은 규격 경로를 담고 실키는 담지 않는다', b, () => {
  const e = m.createOpenAiAudioEngines(BASE);
  assert.equal(e.plan('stt', {}).url, 'http://voice.internal:8000/v1/audio/transcriptions');
  assert.equal(e.plan('tts', {}).url, 'http://voice.internal:8000/v1/audio/speech');
  assert.match(e.plan('tts', {}).headers.authorization, /VOICE_KEY/);
  assert.equal(JSON.stringify(e.plan('stt', {})).includes('super-secret'), false);
  const p = m.createOpenAiAudioEngines({ ...BASE, paths: { speech: '/gw/v1/audio/speech' } });
  assert.equal(p.plan('tts', {}).url, 'http://voice.internal:8000/gw/v1/audio/speech');
});

test('설정 거부: 모델 둘 다 없음·승인 없는 live·잘못된 상한·언어 형식', b, () => {
  assert.throws(() => m.createOpenAiAudioEngines({ ...BASE, sttModel: undefined, ttsModel: undefined }), (err) => err.code === 'E_CONFIG');
  assert.throws(() => m.createOpenAiAudioEngines({ ...BASE, activation: 'live', resolveSecret: () => 'k', fetchImpl: fakeFetch(() => jsonRes({})) }),
    (err) => err.code === 'E_APPROVAL_REQUIRED');
  assert.throws(() => m.createOpenAiAudioEngines({ ...BASE, maxAudioBytes: 0 }), (err) => err.code === 'E_CONFIG');
  assert.throws(() => m.createOpenAiAudioEngines({ ...BASE, maxTtsChars: 2.5 }), (err) => err.code === 'E_CONFIG');
  assert.throws(() => m.createOpenAiAudioEngines({ ...BASE, language: 'Korean' }), (err) => err.code === 'E_CONFIG');
});

test('모델을 하나만 주면 그 어댑터만 만들어진다(기본 모델 없음, §13-3)', b, () => {
  const onlyStt = m.createOpenAiAudioEngines({ ...BASE, ttsModel: undefined });
  assert.ok(onlyStt.stt); assert.equal(onlyStt.tts, undefined);
  const onlyTts = m.createOpenAiAudioEngines({ ...BASE, sttModel: undefined });
  assert.ok(onlyTts.tts); assert.equal(onlyTts.stt, undefined);
  assert.equal(onlyStt.stt.residency, 'onprem');
});

// ── STT ────────────────────────────────────────────────────────────────────────

test('STT: 청크를 모아 멀티파트로 보내고, 파일명은 확장자만 갖는다(§10.3)', b, async () => {
  const f = fakeFetch(() => jsonRes({ text: '상담원 연결해 주세요', duration: 2.5, language: 'ko' }));
  const e = m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: f, language: 'ko', sttResponseFormat: 'verbose_json' });
  const out = await drain(e.stt.stream(chunks(wav(3, 1), wav(2, 2))));
  assert.deepEqual(out, [{ text: '상담원 연결해 주세요', isFinal: true }]);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'http://voice.internal:8000/v1/audio/transcriptions');
  assert.equal(init.headers['content-type'], 'multipart/form-data; boundary=testboundary123');
  assert.equal(init.headers.authorization, 'Bearer super-secret');
  assert.ok(init.body instanceof Uint8Array);
  const parts = parseMultipart(init.body, 'testboundary123');
  assert.deepEqual(parts.map((p) => p.name), ['model', 'file', 'language', 'response_format']);
  assert.equal(parts[0].body, 'whisper-large-v3-ko');
  assert.equal(parts[1].filename, 'audio.wav');
  assert.match(parts[1].head, /content-type: audio\/wav/);
  assert.equal(parts[1].body, '\x01\x01\x01\x02\x02');   // 청크 순서·바이트 보존
  assert.equal(parts[2].body, 'ko');
  assert.equal(parts[3].body, 'verbose_json');
  // duration(초) → stt_audio_ms(§11.2)
  assert.deepEqual(e.lastUsage(), { stt_audio_ms: 2500 });
});

test('STT: 언어·응답 포맷을 주지 않으면 요청에 싣지 않고, duration 이 없으면 사용량을 만들지 않는다(§13-3)', b, async () => {
  const f = fakeFetch(() => jsonRes({ text: '' }));
  const e = m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: f });
  const out = await drain(e.stt.stream(chunks(wav(4))));
  assert.deepEqual(out, [{ text: '', isFinal: true }]);   // 무음은 오류가 아니다 — 무입력 처리는 Flow 몫
  const parts = parseMultipart(f.calls[0].init.body, 'testboundary123');
  assert.deepEqual(parts.map((p) => p.name), ['model', 'file']);
  assert.equal(e.lastUsage(), undefined);
});

test('STT 호출 전 거절: 빈 오디오·상한 초과·모르는 mime·섞인 mime (네트워크 0회)', b, async () => {
  const f = fakeFetch(() => jsonRes({ text: 'x' }));
  const e = m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: f, maxAudioBytes: 5 });
  await assert.rejects(() => drain(e.stt.stream(chunks())), (err) => err.code === 'E_INPUT');
  await assert.rejects(() => drain(e.stt.stream(chunks(wav(0)))), (err) => err.code === 'E_INPUT');
  await assert.rejects(() => drain(e.stt.stream(chunks(wav(3), wav(3)))), (err) => err.code === 'E_LIMIT');
  await assert.rejects(() => drain(e.stt.stream(chunks({ data: new Uint8Array(2), mime: 'audio/x-unknown' }))),
    (err) => err.code === 'E_INPUT' && /mime/.test(err.message));
  await assert.rejects(() => drain(e.stt.stream(chunks(wav(1), { data: new Uint8Array(1), mime: 'audio/mpeg' }))),
    (err) => err.code === 'E_INPUT' && /섞였/.test(err.message));
  assert.equal(f.calls.length, 0);
});

test('STT 응답 형식 위반·HTTP 오류·시간 초과는 코드로 드러난다(§9.3)', b, async () => {
  const bad = m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: fakeFetch(() => jsonRes({ segments: [] })) });
  await assert.rejects(() => drain(bad.stt.stream(chunks(wav(2)))), (err) => err.code === 'E_PROTOCOL');

  const http = m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: fakeFetch(() => jsonRes({ error: '발화 원문 010-1234-5678' }, 503)) });
  await assert.rejects(() => drain(http.stt.stream(chunks(wav(2)))), (err) => {
    assert.equal(err.code, 'E_HTTP');
    assert.equal(err.detail.retryable, true);
    assert.equal(JSON.stringify(err).includes('1234'), false);   // 오류 본문을 되돌리지 않는다(§10.3)
    return true;
  });

  const slow = m.createOpenAiAudioEngines({
    ...LIVE, timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await assert.rejects(() => drain(slow.stt.stream(chunks(wav(2)))), (err) => err.code === 'E_TIMEOUT');
});

test('parseTranscription: 음수·비수치 duration 은 사용량으로 만들지 않는다', b, () => {
  assert.equal(m.parseTranscription({ text: 'a', duration: -1 }).usage, undefined);
  assert.equal(m.parseTranscription({ text: 'a', duration: 'x' }).usage, undefined);
  assert.deepEqual(m.parseTranscription({ text: 'a', duration: 0.0004 }).usage, { stt_audio_ms: 0 });
  assert.throws(() => m.parseTranscription([]), (err) => err.code === 'E_PROTOCOL');
  assert.throws(() => m.parseTranscription({ text: 3 }), (err) => err.code === 'E_PROTOCOL');
});

// ── TTS ────────────────────────────────────────────────────────────────────────

test('TTS: 문장은 마스킹을 거쳐 JSON 으로 나가고, 오디오 바이트가 그대로 돌아온다', b, async () => {
  const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11]);
  const f = fakeFetch(() => binRes(audio, 'audio/mpeg; charset=binary'));
  const e = m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: f, ttsFormat: 'mp3' });
  const out = await drain(e.tts.synthesize('고객님 연락처 010-1234-5678 로 안내드립니다', 'minsu'));
  assert.equal(out.length, 1);
  assert.equal(out[0].mime, 'audio/mpeg');
  assert.deepEqual(Array.from(out[0].data), Array.from(audio));
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.model, 'tts-ko-1');
  assert.equal(body.voice, 'minsu');            // 호출 인자가 설정 기본 음성보다 우선
  assert.equal(body.response_format, 'mp3');
  assert.equal(body.input.includes('1234-5678'), false);   // §10.3
  assert.equal(f.calls[0].init.headers['content-type'], 'application/json');
  assert.equal(e.lastUsage(), undefined);       // tts_audio_ms 는 응답에 없으므로 만들지 않는다(§13-3)
});

test('TTS: 설정 음성이 쓰이고, 포맷을 주지 않으면 response_format 을 싣지 않는다', b, async () => {
  const f = fakeFetch(() => binRes(new Uint8Array([1, 2, 3]), 'audio/wav'));
  const e = m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: f });
  const out = await drain(e.tts.synthesize('안내드립니다'));
  assert.equal(out[0].mime, 'audio/wav');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.voice, 'nara');
  assert.equal('response_format' in body, false);
});

test('TTS 호출 전 거절: 빈 문장·음성 없음·문자 수 상한 (네트워크 0회)', b, async () => {
  const f = fakeFetch(() => binRes(new Uint8Array([1]), 'audio/wav'));
  const e = m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: f, ttsVoice: undefined, maxTtsChars: 5 });
  await assert.rejects(() => drain(e.tts.synthesize('   ')), (err) => err.code === 'E_INPUT');
  await assert.rejects(() => drain(e.tts.synthesize('안녕')), (err) => err.code === 'E_INPUT' && /voice/.test(err.message));
  await assert.rejects(() => drain(e.tts.synthesize('여섯글자문장', 'nara')), (err) => err.code === 'E_LIMIT');
  assert.equal(f.calls.length, 0);
});

test('TTS: 200 으로 싸인 JSON 오류·빈 본문·content-type 부재·비오디오 형식은 재생하지 않고 E_PROTOCOL', b, async () => {
  const mk = (res) => m.createOpenAiAudioEngines({ ...LIVE, fetchImpl: fakeFetch(() => res) });
  await assert.rejects(() => drain(mk(jsonRes({ error: 'quota' })).tts.synthesize('a')),
    (err) => err.code === 'E_PROTOCOL' && /application\/json/.test(err.message));
  await assert.rejects(() => drain(mk(binRes(new Uint8Array(0), 'audio/wav')).tts.synthesize('a')),
    (err) => err.code === 'E_PROTOCOL' && /비어/.test(err.message));
  await assert.rejects(() => drain(mk(binRes(new Uint8Array([1]), null)).tts.synthesize('a')),
    (err) => err.code === 'E_PROTOCOL' && /content-type/.test(err.message));
  await assert.rejects(() => drain(mk(binRes(new Uint8Array([1]), 'image/png')).tts.synthesize('a')),
    (err) => err.code === 'E_PROTOCOL' && /오디오가 아닌/.test(err.message));
  await assert.rejects(() => drain(mk(binRes(new Uint8Array([1]), 'audio/wav', { arrayBuffer: undefined })).tts.synthesize('a')),
    (err) => err.code === 'E_PROTOCOL' && /arrayBuffer/.test(err.message));
  await assert.rejects(() => drain(mk(jsonRes({ error: 'busy' }, 429)).tts.synthesize('a')),
    (err) => err.code === 'E_HTTP' && err.detail.retryable === true);
});

// ── 멀티파트·국외이전 ─────────────────────────────────────────────────────────

test('encodeMultipart: 경계 형식·필드 이름 개행을 거절하고, 닫는 경계로 끝난다', b, () => {
  assert.throws(() => m.encodeMultipart('bad boundary', []), (err) => err.code === 'E_CONFIG');
  assert.throws(() => m.encodeMultipart('ok', [{ name: 'a\r\nb', value: 'x' }]), (err) => err.code === 'E_INPUT');
  assert.throws(() => m.encodeMultipart('ok', [{ name: 'f', filename: 'a"b', mime: 'audio/wav', data: new Uint8Array(1) }]),
    (err) => err.code === 'E_INPUT');
  const body = new TextDecoder().decode(m.encodeMultipart('ok', [{ name: 'a', value: '1' }]));
  assert.ok(body.endsWith('--ok--\r\n'));
  assert.equal(m.audioExtensionOf('audio/x-wav; rate=16000'), 'wav');
  assert.equal(m.audioExtensionOf('video/mp4'), undefined);
});

test('국외 엔진은 국외이전 불가 테넌트에서 assertResidency 로 차단된다(§10.3)', b, () => {
  const e = m.createOpenAiAudioEngines({ ...BASE, residency: 'overseas' });
  const llm = { name: 'x', residency: 'domestic', async *complete() {} };
  assert.throws(() => idx.assertResidency({ stt: e.stt, tts: e.tts, llm }, false), /stt, tts/);
  assert.doesNotThrow(() => idx.assertResidency({ stt: e.stt, tts: e.tts, llm }, true));
});
