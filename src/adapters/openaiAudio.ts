// OpenAI 호환 음성 규격 어댑터 — 설계서 §6.2(엔진 교체 가능)·§9.3(오류 비은폐)·§10.3(마스킹·국외이전)·§11.2·§13-3.
//
// 왜 이 파일이 필요한가:
// openaiCompat.ts 는 텍스트(chat·embeddings)만 흡수했다. Callbot 이 실제로 붙어야 하는 것은 음성이고,
// 온프렘 Whisper 서빙(faster-whisper-server·speaches 등)과 TTS 서버 상당수가 말하는 형태는
// `audio/transcriptions`(멀티파트 업로드 → JSON)·`audio/speech`(JSON → 오디오 바이트)다.
// 이 둘은 JSON 왕복이 아니라서 지금까지 "범위 밖"이었고, 그 상태로 두면 음성 저장소가 멀티파트 조립과
// 바이너리 수신을 각자 짜게 된다 — 경계(boundary) 충돌·빈 응답·200 으로 싸인 오류 JSON 을 오디오로 재생하는
// 사고는 전부 그 자리에서 난다. 그래서 여기 한 곳에서 흡수한다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 승인 게이트·비밀값·타임아웃·오류 분류는 http.ts 의 createEngineTransport(`send`)가 책임진다. 복사하지 않는다.
//  - 기본 dry_run. plan() 으로 실호출 없이 요청을 확인한다 — 오디오 바이트는 계획에 싣지 않고 크기·mime 만 서술한다.
//  - 모델 id·음성(voice)·언어·응답 포맷에 기본값을 두지 않는다(§13-3). 주지 않은 값은 요청에 실리지 않는다.
//  - TTS 입력 문장은 §10.3 마스킹을 거쳐 나간다. STT 오디오는 그 자체가 원문이라 마스킹할 수 없다 —
//    그래서 residency 판정(assertResidency)이 STT 에 특히 중요하다. 전사 결과의 마스킹은 저장 경로(Core)가 한다.
//  - 스트리밍 STT(웹소켓)·실시간 TTS 청크 스트리밍은 지원하지 않는다. 한 발화 = 한 요청이다.
//  - TTS 오디오 길이(tts_audio_ms)는 응답에 없으므로 만들어 넣지 않는다(§13-3). STT 는 엔진이 duration 을
//    돌려줄 때만 stt_audio_ms 로 환산한다(verbose_json 응답 포맷에서 온다).
import type { AudioChunk, SttAdapter, SttResult, TtsAdapter } from './index.ts';
import type { UsageMetrics } from '../events/schema.ts';
import { maskPii } from '../core/policyGuard.ts';
import {
  EngineError, collectAudio, createEngineTransport,
  type Activation, type EngineTransportConfig, type RequestPlan,
} from './http.ts';

/** OpenAI 호환 규격이 고정한 경로. 서빙 구현마다 프리픽스가 다를 수 있어 재정의는 허용한다. */
export const OPENAI_AUDIO_PATHS = Object.freeze({
  transcriptions: '/v1/audio/transcriptions',
  speech: '/v1/audio/speech',
});

export type SttResponseFormat = 'json' | 'verbose_json';
export type TtsResponseFormat = 'mp3' | 'wav' | 'pcm' | 'opus' | 'aac' | 'flac';

export interface OpenAiAudioConfig extends EngineTransportConfig {
  /** STT 모델 id. 없으면 stt 어댑터를 만들지 않는다 — 기본 모델을 Core 가 정하지 않는다(§13-3). */
  sttModel?: string;
  /** TTS 모델 id. 없으면 tts 어댑터를 만들지 않는다. */
  ttsModel?: string;
  /** TTS 기본 음성. synthesize(text, voice) 의 voice 가 우선한다. 둘 다 없으면 호출 전에 거절한다. */
  ttsVoice?: string;
  /** TTS 응답 포맷. 주면 response_format 으로 실린다. mime 은 응답 content-type 에서 읽는다. */
  ttsFormat?: TtsResponseFormat;
  /** STT 응답 포맷. verbose_json 이어야 duration(→ stt_audio_ms)이 온다. 주지 않으면 서버 기본값. */
  sttResponseFormat?: SttResponseFormat;
  /** STT 언어 힌트(ISO-639-1, 예: ko). 주지 않으면 엔진이 감지한다. */
  language?: string;
  /** 경로 재정의(프록시·프리픽스 차이 흡수). 생략하면 규격 경로. */
  paths?: { transcriptions?: string; speech?: string };
  /** 외부 엔진으로 나가는 TTS 문장에 §10.3 마스킹을 적용한다. 기본 true — 끄려면 명시해야 한다. */
  maskOutbound?: boolean;
  /** STT 1회 요청 오디오 상한(byte). 초과 시 호출 전에 거절한다. */
  maxAudioBytes?: number;
  /** TTS 1회 요청 문자 수 상한. 초과 시 호출 전에 거절한다(엔진 상한을 코드에 박지 않는다, §13-3). */
  maxTtsChars?: number;
  /** 멀티파트 경계 문자열 생성기. 테스트 결정성용 — 생략하면 난수. */
  boundary?: () => string;
}

export interface OpenAiAudioEngines {
  readonly config: Readonly<OpenAiAudioConfig>;
  readonly activation: Activation;
  stt?: SttAdapter;
  tts?: TtsAdapter;
  /** 검토용 요청 계획. stt 는 멀티파트라 body 에 바이트가 아니라 서술(크기·mime)이 실린다. */
  plan(component: 'stt' | 'tts', body: Record<string, unknown>): RequestPlan;
  /** 마지막 STT 호출의 실측 사용량(§11.2). 호출 전·duration 미제공 시 undefined. */
  lastUsage(): UsageMetrics | undefined;
}

// ── mime → 파일 확장자 (멀티파트 filename 용) ─────────────────────────────────
// 규격 서버는 확장자로 컨테이너를 판별한다. 모르는 mime 을 임의 확장자로 보내면 "지원하지 않는 형식"이 아니라
// 잘못 해석된 전사가 돌아오므로, 모르는 것은 호출 전에 거절한다.
const MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg', 'audio/opus': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
});

export function audioExtensionOf(mime: string): string | undefined {
  return MIME_EXT[mime.split(';')[0]?.trim().toLowerCase() ?? ''];
}

// ── 멀티파트 조립 (외부 의존 없이, 순수 함수) ─────────────────────────────────
export type MultipartField =
  | { name: string; value: string }
  | { name: string; filename: string; mime: string; data: Uint8Array };

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** RFC 7578 멀티파트 본문. 필드 이름·파일명에 개행·따옴표가 있으면 헤더가 깨지므로 거절한다. */
export function encodeMultipart(boundary: string, fields: MultipartField[]): Uint8Array {
  if (!/^[A-Za-z0-9'()+_,\-.:=?]{1,70}$/.test(boundary)) {
    throw new EngineError('E_CONFIG', 'config', '멀티파트 boundary 형식 위반(RFC 2046).');
  }
  const bad = (s: string) => /[\r\n"]/.test(s);
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    if (bad(f.name) || ('filename' in f && bad(f.filename))) {
      throw new EngineError('E_INPUT', 'stt', '멀티파트 필드 이름·파일명에 개행·따옴표를 쓸 수 없습니다.');
    }
    if ('value' in f) {
      parts.push(enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`));
    } else {
      parts.push(enc.encode(
        `--${boundary}\r\ncontent-disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
        `content-type: ${f.mime}\r\n\r\n`,
      ));
      parts.push(f.data);
      parts.push(enc.encode('\r\n'));
    }
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  return concat(parts);
}

function randomBoundary(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'aicc-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── 응답 파서 (순수 함수 — 형식 위반은 조용히 넘기지 않는다) ──────────────────

/**
 * `audio/transcriptions` 응답 → 전사 결과. `text` 는 필수(빈 문자열은 무음이므로 허용 — 무입력 처리는 Flow 몫).
 * `duration`(초)이 오면 stt_audio_ms 로 환산한다. 없으면 사용량을 만들어 넣지 않는다(§13-3).
 */
export function parseTranscription(raw: unknown): { result: SttResult; usage?: UsageMetrics; language?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EngineError('E_PROTOCOL', 'stt', '엔진 응답이 JSON 객체가 아닙니다.');
  }
  const o = raw as Record<string, unknown>;
  const text = o['text'];
  if (typeof text !== 'string') throw new EngineError('E_PROTOCOL', 'stt', 'transcriptions 응답에 text 문자열이 없습니다.');
  const out: { result: SttResult; usage?: UsageMetrics; language?: string } = { result: { text, isFinal: true } };
  const d = o['duration'];
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0) out.usage = { stt_audio_ms: Math.round(d * 1000) };
  if (typeof o['language'] === 'string') out.language = o['language'];
  return out;
}

// ── 어댑터 본체 ───────────────────────────────────────────────────────────────

export function createOpenAiAudioEngines(cfg: OpenAiAudioConfig): OpenAiAudioEngines {
  if (!cfg.sttModel && !cfg.ttsModel) {
    throw new EngineError('E_CONFIG', 'config', 'sttModel 또는 ttsModel 중 하나는 있어야 합니다 — 기본 모델을 Core 가 정하지 않습니다(§13-3).');
  }
  if (cfg.maxAudioBytes !== undefined && (!Number.isInteger(cfg.maxAudioBytes) || cfg.maxAudioBytes <= 0)) {
    throw new EngineError('E_CONFIG', 'config', 'maxAudioBytes 는 1 이상의 정수여야 합니다.');
  }
  if (cfg.maxTtsChars !== undefined && (!Number.isInteger(cfg.maxTtsChars) || cfg.maxTtsChars <= 0)) {
    throw new EngineError('E_CONFIG', 'config', 'maxTtsChars 는 1 이상의 정수여야 합니다.');
  }
  if (cfg.language !== undefined && !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(cfg.language)) {
    throw new EngineError('E_CONFIG', 'config', `language 형식 위반(ISO-639-1 기대): ${JSON.stringify(cfg.language)}`);
  }
  const transport = createEngineTransport(cfg);
  const maskOutbound = cfg.maskOutbound !== false;
  const sttPath = cfg.paths?.transcriptions ?? OPENAI_AUDIO_PATHS.transcriptions;
  const ttsPath = cfg.paths?.speech ?? OPENAI_AUDIO_PATHS.speech;
  const nextBoundary = cfg.boundary ?? randomBoundary;
  let lastUsage: UsageMetrics | undefined;

  const set: OpenAiAudioEngines = {
    config: cfg,
    activation: transport.activation,
    plan: (component, body) => component === 'stt'
      ? transport.plan('stt', sttPath, body, 'multipart/form-data')
      : transport.plan('tts', ttsPath, body),
    lastUsage: () => lastUsage,
  };

  if (cfg.sttModel) {
    const model = cfg.sttModel;
    set.stt = {
      name: `${cfg.name}-stt`,
      residency: cfg.residency,
      async *stream(audio: AsyncIterable<AudioChunk>): AsyncIterable<SttResult> {
        const { bytes, mime } = await collectAudio(audio, cfg.maxAudioBytes);
        const ext = audioExtensionOf(mime);
        if (!ext) throw new EngineError('E_INPUT', 'stt', `지원하지 않는 오디오 mime: ${JSON.stringify(mime)}`);
        const fields: MultipartField[] = [
          { name: 'model', value: model },
          // 파일명은 확장자만 의미가 있다. 통화 id·번호가 파일명에 실려 나가면 안 되므로 고정 이름을 쓴다(§10.3).
          { name: 'file', filename: `audio.${ext}`, mime, data: bytes },
        ];
        if (cfg.language !== undefined) fields.push({ name: 'language', value: cfg.language });
        if (cfg.sttResponseFormat !== undefined) fields.push({ name: 'response_format', value: cfg.sttResponseFormat });
        const boundary = nextBoundary();
        const body = encodeMultipart(boundary, fields);
        const planBody: Record<string, unknown> = { model, file: { bytes: bytes.length, mime, filename: `audio.${ext}` } };
        if (cfg.language !== undefined) planBody['language'] = cfg.language;
        if (cfg.sttResponseFormat !== undefined) planBody['response_format'] = cfg.sttResponseFormat;
        const { json } = await transport.send('stt', sttPath,
          { contentType: `multipart/form-data; boundary=${boundary}`, body, accept: 'json' }, planBody);
        const parsed = parseTranscription(json);
        if (parsed.usage) lastUsage = parsed.usage;
        yield parsed.result;
      },
    };
  }

  if (cfg.ttsModel) {
    const model = cfg.ttsModel;
    set.tts = {
      name: `${cfg.name}-tts`,
      residency: cfg.residency,
      async *synthesize(text: string, voice?: string): AsyncIterable<AudioChunk> {
        if (typeof text !== 'string' || text.trim() === '') {
          throw new EngineError('E_INPUT', 'tts', '빈 문장은 TTS로 보내지 않습니다.');
        }
        const v = voice ?? cfg.ttsVoice;
        if (!v) throw new EngineError('E_INPUT', 'tts', '음성(voice)이 지정되지 않았습니다 — 기본 음성을 Core 가 정하지 않습니다(§13-3).');
        const input = maskOutbound ? maskPii(text).text : text;
        if (cfg.maxTtsChars !== undefined && input.length > cfg.maxTtsChars) {
          throw new EngineError('E_LIMIT', 'tts', `TTS 문자 수 상한 초과: ${input.length} > ${cfg.maxTtsChars}`);
        }
        const body: Record<string, unknown> = { model, input, voice: v };
        if (cfg.ttsFormat !== undefined) body['response_format'] = cfg.ttsFormat;
        const r = await transport.send('tts', ttsPath,
          { contentType: 'application/json', body: JSON.stringify(body), accept: 'binary' }, body);
        // send 가 binary 를 보장한다(빈 본문·JSON/텍스트 응답·content-type 부재는 E_PROTOCOL).
        const bytes = r.bytes as Uint8Array;
        const mime = (r.contentType as string).split(';')[0]?.trim().toLowerCase() ?? '';
        if (!mime.startsWith('audio/') && mime !== 'application/octet-stream') {
          throw new EngineError('E_PROTOCOL', 'tts', `오디오가 아닌 응답 형식: ${mime}`);
        }
        yield { data: bytes, mime };
      },
    };
  }

  return set;
}
