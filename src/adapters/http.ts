// 실엔진 HTTP 어댑터 — 설계서 §6.2(엔진 교체 가능)·§10.3(마스킹·국외이전)·§11.2(과금 근거)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// 지금까지 Core에는 sim 어댑터밖에 없었다. sim만 있으면 "엔진 종속 코드가 Core에 침투하지 않는다"(§6.2)는
// 약속이 검증되지 않는다. 실제 엔진은 HTTP·인증·타임아웃·사용량 환산·오류코드를 들고 오는데,
// 그것들이 들어올 자리를 미리 만들어 두지 않으면 결국 채널 저장소마다 제각각 붙게 된다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 기본 상태는 dry_run 이다. 이 상태에서는 **네트워크 호출을 하지 않고** [승인 필요] 오류를 던진다.
//  - 실키를 코드·로그·계획(plan)에 담지 않는다. 담는 것은 "어느 환경변수를 읽을 것인가"라는 참조 이름뿐이다.
//  - live 전환은 사람이 승인 근거(approvalRef)를 명시해야만 가능하다. 코드 기본값으로 켜지지 않는다.
//
// 프로토콜은 벤더 중립 JSON 규약이다. 벤더 차이는 이 어댑터의 설정·파서에서 흡수하고
// Core 상위 계층은 §6.2 인터페이스(SttAdapter/TtsAdapter/LlmAdapter/EmbeddingAdapter)만 본다.
import type {
  AudioChunk, EmbeddingAdapter, LlmAdapter, LlmMessage, SttAdapter, SttResult, TtsAdapter,
} from './index.ts';
import type { LatencyMs, UsageMetrics } from '../events/schema.ts';
import { maskPii } from '../core/policyGuard.ts';

export type Activation = 'dry_run' | 'live';

export type EngineErrorCode =
  | 'E_APPROVAL_REQUIRED'   // 승인 전 실호출 시도
  | 'E_CONFIG'              // 설정 자체가 성립하지 않음
  | 'E_INPUT'               // 빈 입력 등 호출 전 거절
  | 'E_LIMIT'               // 입력 상한 초과
  | 'E_TIMEOUT'             // 응답 지연
  | 'E_HTTP'                // 비2xx 응답
  | 'E_PROTOCOL';           // 응답 형식 위반

/** 엔진 오류는 삼키지 않는다(§9.3). 상위 계층이 코드로 분기할 수 있게 코드와 컴포넌트를 함께 싣는다. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly component: 'stt' | 'tts' | 'llm' | 'embedding' | 'config';
  readonly detail: Record<string, unknown>;
  constructor(
    code: EngineErrorCode,
    component: 'stt' | 'tts' | 'llm' | 'embedding' | 'config',
    messageKo: string,
    detail: Record<string, unknown> = {},
  ) {
    super(messageKo);
    this.name = 'EngineError';
    this.code = code;
    this.component = component;
    this.detail = detail;
  }
}

// ── 전송 계층 추상 (테스트·다른 런타임에서 교체 가능) ─────────────────────────
export interface HttpResponseLike { ok: boolean; status: number; text(): Promise<string> }
export interface HttpRequestInitLike { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
export type FetchLike = (url: string, init: HttpRequestInitLike) => Promise<HttpResponseLike>;

export interface HttpEnginePaths { stt?: string; tts?: string; llm?: string; embedding?: string }

export interface HttpEngineConfig {
  name: string;
  residency: 'domestic' | 'onprem' | 'overseas';
  /** 예: https://engine.example.co.kr — 경로는 paths 로 분리한다. */
  baseUrl: string;
  paths: HttpEnginePaths;
  /** 응답 대기 상한(ms). 계약·운영 합의값을 넣는다 — 권장 기본값을 코드에 박지 않는다(§13-3). */
  timeoutMs: number;
  /** 기본 dry_run. live 는 사람이 명시적으로 켠다. */
  activation: Activation;
  /** live 활성화 근거(승인자·티켓 번호). 비어 있으면 live 로 만들 수 없다. */
  approvalRef?: string;
  /** 인증키가 담긴 환경변수 **이름**. 값은 여기에 넣지 않는다. */
  apiKeyEnv?: string;
  /** 이름으로 실제 비밀값을 가져오는 함수. 주입하지 않으면 live 로 만들 수 없다. */
  resolveSecret?: (envName: string) => string | undefined;
  fetchImpl?: FetchLike;
  /** 외부 엔진으로 나가는 텍스트에 §10.3 마스킹을 적용한다. 기본 true — 끄려면 명시해야 한다. */
  maskOutbound?: boolean;
  /** STT 1회 요청 오디오 상한(byte). 초과 시 호출 전에 거절한다. */
  maxAudioBytes?: number;
  /** 지연 실측용 시계(ms). 테스트 결정성을 위해 주입 가능. */
  clock?: () => number;
}

/** 로그·검토용 요청 계획. 인증 값은 절대 담기지 않는다 — 참조 이름만 남는다(§10.3). */
export interface RequestPlan {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  activation: Activation;
  residency: HttpEngineConfig['residency'];
}

const AUTH_PLACEHOLDER = (envName: string | undefined): string =>
  envName ? `[승인 필요: env:${envName}]` : '[미설정]';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

// ── base64 (외부 의존 없이) ──────────────────────────────────────────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => B64.indexOf(clean[i + k] ?? 'A'));
    const v = ((n[0] as number) << 18) | ((n[1] as number) << 12) | ((n[2] as number) << 6) | (n[3] as number);
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (i + 2 < clean.length && o < out.length) out[o++] = (v >> 8) & 255;
    if (i + 3 < clean.length && o < out.length) out[o++] = v & 255;
  }
  return out.subarray(0, o);
}

// ── 응답 파서 (순수 함수 — 형식 위반은 조용히 넘기지 않는다) ──────────────────
function obj(raw: unknown, component: EngineError['component']): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EngineError('E_PROTOCOL', component, '엔진 응답이 JSON 객체가 아닙니다.');
  }
  return raw as Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 엔진마다 단위·필드명이 다르므로 여기서 §11.2 UsageMetrics 로 환산한다(§6.2). */
export function toUsageMetrics(raw: unknown): UsageMetrics | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const m: UsageMetrics = {};
  const p = num(u['prompt_tokens']); if (p !== undefined) m.llm_prompt_tokens = p;
  const c = num(u['completion_tokens']); if (c !== undefined) m.llm_completion_tokens = c;
  const s = num(u['stt_audio_ms']); if (s !== undefined) m.stt_audio_ms = s;
  const t = num(u['tts_audio_ms']); if (t !== undefined) m.tts_audio_ms = t;
  return Object.keys(m).length > 0 ? m : undefined;
}

export function parseLlmResponse(raw: unknown): { text: string; usage?: UsageMetrics } {
  const o = obj(raw, 'llm');
  const text = o['text'];
  if (typeof text !== 'string') throw new EngineError('E_PROTOCOL', 'llm', 'LLM 응답에 text 문자열이 없습니다.');
  const usage = toUsageMetrics(o['usage']);
  return usage === undefined ? { text } : { text, usage };
}

export function parseSttResponse(raw: unknown): { result: SttResult; usage?: UsageMetrics } {
  const o = obj(raw, 'stt');
  const text = o['text'];
  if (typeof text !== 'string') throw new EngineError('E_PROTOCOL', 'stt', 'STT 응답에 text 문자열이 없습니다.');
  const result: SttResult = { text, isFinal: o['is_final'] !== false };
  const conf = num(o['confidence']);
  if (conf !== undefined) result.confidence = conf;
  const usage = toUsageMetrics(o['usage']);
  return usage === undefined ? { result } : { result, usage };
}

export function parseTtsResponse(raw: unknown): { chunk: AudioChunk; usage?: UsageMetrics } {
  const o = obj(raw, 'tts');
  const b64 = o['audio_base64'];
  const mime = o['mime'];
  if (typeof b64 !== 'string' || typeof mime !== 'string') {
    throw new EngineError('E_PROTOCOL', 'tts', 'TTS 응답에 audio_base64·mime 이 없습니다.');
  }
  const usage = toUsageMetrics(o['usage']);
  const chunk: AudioChunk = { data: fromBase64(b64), mime };
  return usage === undefined ? { chunk } : { chunk, usage };
}

export function parseEmbeddingResponse(raw: unknown, expected: number): number[][] {
  const o = obj(raw, 'embedding');
  const arr = o['embeddings'];
  if (!Array.isArray(arr)) throw new EngineError('E_PROTOCOL', 'embedding', '임베딩 응답에 embeddings 배열이 없습니다.');
  if (arr.length !== expected) {
    throw new EngineError('E_PROTOCOL', 'embedding', `임베딩 개수 불일치: 요청 ${expected}건, 응답 ${arr.length}건.`);
  }
  return arr.map((v, i) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw new EngineError('E_PROTOCOL', 'embedding', `임베딩 ${i}번이 숫자 배열이 아닙니다.`);
    }
    return v as number[];
  });
}

// ── 어댑터 본체 ───────────────────────────────────────────────────────────────

export type HttpLlmAdapter = LlmAdapter & {
  completeOnce(messages: LlmMessage[]): Promise<{ text: string; usage?: UsageMetrics; latency: LatencyMs }>;
};

export interface HttpEngineSet {
  readonly config: Readonly<HttpEngineConfig>;
  readonly activation: Activation;
  stt: SttAdapter;
  tts: TtsAdapter;
  llm: HttpLlmAdapter;
  embedding?: EmbeddingAdapter;
  /** 검토용 요청 계획 — 실호출 없이 "무엇을 보낼 것인가"를 그대로 보여준다. */
  plan(component: 'stt' | 'tts' | 'llm' | 'embedding', body: Record<string, unknown>): RequestPlan;
  /** 마지막 호출의 실측 사용량(§11.2). 호출 전에는 undefined. */
  lastUsage(): UsageMetrics | undefined;
}

function requirePath(cfg: HttpEngineConfig, component: 'stt' | 'tts' | 'llm' | 'embedding'): string {
  const p = cfg.paths[component];
  if (!p) throw new EngineError('E_CONFIG', component, `${component} 경로가 설정되지 않았습니다.`);
  return p;
}

export function createHttpEngineSet(cfg: HttpEngineConfig): HttpEngineSet {
  if (!/^https?:\/\/./.test(cfg.baseUrl)) {
    throw new EngineError('E_CONFIG', 'config', `baseUrl 형식 위반: ${JSON.stringify(cfg.baseUrl)}`);
  }
  if (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs <= 0) {
    throw new EngineError('E_CONFIG', 'config', 'timeoutMs는 1 이상의 정수여야 합니다.');
  }
  const fetchImpl = cfg.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (cfg.activation === 'live') {
    if (!cfg.approvalRef) {
      throw new EngineError('E_APPROVAL_REQUIRED', 'config', '[승인 필요] live 활성화에는 승인 근거(approvalRef)가 필요합니다.');
    }
    if (cfg.apiKeyEnv && !cfg.resolveSecret) {
      throw new EngineError('E_CONFIG', 'config', 'apiKeyEnv를 설정했으면 resolveSecret도 주입해야 합니다.');
    }
    if (!fetchImpl) throw new EngineError('E_CONFIG', 'config', '전송 구현(fetchImpl)이 없습니다.');
  }
  const maskOutbound = cfg.maskOutbound !== false;
  const clock = cfg.clock ?? (() => Date.now());
  let lastUsage: UsageMetrics | undefined;

  const plan = (component: 'stt' | 'tts' | 'llm' | 'embedding', body: Record<string, unknown>): RequestPlan => ({
    method: 'POST',
    url: joinUrl(cfg.baseUrl, requirePath(cfg, component)),
    headers: { 'content-type': 'application/json', authorization: AUTH_PLACEHOLDER(cfg.apiKeyEnv) },
    body,
    activation: cfg.activation,
    residency: cfg.residency,
  });

  /** 실제 전송. dry_run 에서는 여기까지 오지 못한다. */
  async function post(
    component: 'stt' | 'tts' | 'llm' | 'embedding',
    body: Record<string, unknown>,
  ): Promise<{ json: unknown; elapsedMs: number }> {
    if (cfg.activation !== 'live') {
      throw new EngineError('E_APPROVAL_REQUIRED', component,
        `[승인 필요] ${cfg.name} 엔진 실호출은 승인 전까지 비활성입니다. 계획만 확인하세요(plan()).`,
        { plan: plan(component, body) });
    }
    const send = fetchImpl as FetchLike;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKeyEnv) {
      const secret = cfg.resolveSecret?.(cfg.apiKeyEnv);
      if (!secret) {
        throw new EngineError('E_CONFIG', component, `인증키 미설정: env:${cfg.apiKeyEnv} (값은 로그에 남기지 않습니다)`);
      }
      headers['authorization'] = `Bearer ${secret}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const startedMs = clock();
    try {
      const res = await send(joinUrl(cfg.baseUrl, requirePath(cfg, component)), {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });
      const elapsedMs = clock() - startedMs;
      const raw = await res.text();
      if (!res.ok) {
        // 본문을 그대로 싣지 않는다 — 엔진 오류 본문에 발화가 되돌아오는 사례가 있다(§10.3).
        throw new EngineError('E_HTTP', component, `엔진 응답 오류(status ${res.status})`, { status: res.status, elapsedMs });
      }
      try {
        return { json: JSON.parse(raw), elapsedMs };
      } catch {
        throw new EngineError('E_PROTOCOL', component, '엔진 응답을 JSON으로 해석할 수 없습니다.', { elapsedMs });
      }
    } catch (err) {
      if (err instanceof EngineError) throw err;
      const aborted = controller.signal.aborted;
      throw new EngineError(aborted ? 'E_TIMEOUT' : 'E_HTTP', component,
        aborted ? `엔진 응답 시간 초과(${cfg.timeoutMs}ms)` : '엔진 전송 실패',
        { cause: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
    }
  }

  async function collectAudio(audio: AsyncIterable<AudioChunk>): Promise<{ bytes: Uint8Array; mime: string }> {
    const parts: Uint8Array[] = [];
    let total = 0;
    let mime = '';
    for await (const c of audio) {
      if (mime === '') mime = c.mime;
      total += c.data.length;
      if (cfg.maxAudioBytes !== undefined && total > cfg.maxAudioBytes) {
        throw new EngineError('E_LIMIT', 'stt', `오디오 상한 초과: ${total} > ${cfg.maxAudioBytes} byte`);
      }
      parts.push(c.data);
    }
    if (total === 0) throw new EngineError('E_INPUT', 'stt', '빈 오디오는 STT로 보내지 않습니다.');
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    return { bytes, mime };
  }

  const stt: SttAdapter = {
    name: `${cfg.name}-stt`,
    residency: cfg.residency,
    async *stream(audio: AsyncIterable<AudioChunk>): AsyncIterable<SttResult> {
      const { bytes, mime } = await collectAudio(audio);
      const { json } = await post('stt', { audio_base64: toBase64(bytes), mime });
      const parsed = parseSttResponse(json);
      if (parsed.usage) lastUsage = parsed.usage;
      yield parsed.result;
    },
  };

  const tts: TtsAdapter = {
    name: `${cfg.name}-tts`,
    residency: cfg.residency,
    async *synthesize(text: string, voice?: string): AsyncIterable<AudioChunk> {
      if (text.trim() === '') throw new EngineError('E_INPUT', 'tts', '빈 문장은 TTS로 보내지 않습니다.');
      const body: Record<string, unknown> = { text: maskOutbound ? maskPii(text).text : text };
      if (voice !== undefined) body['voice'] = voice;
      const { json } = await post('tts', body);
      const parsed = parseTtsResponse(json);
      if (parsed.usage) lastUsage = parsed.usage;
      yield parsed.chunk;
    },
  };

  const llm: HttpLlmAdapter = {
    name: `${cfg.name}-llm`,
    residency: cfg.residency,
    async completeOnce(messages: LlmMessage[]): Promise<{ text: string; usage?: UsageMetrics; latency: LatencyMs }> {
      if (messages.length === 0) throw new EngineError('E_INPUT', 'llm', '빈 메시지 목록은 LLM으로 보내지 않습니다.');
      const body = {
        messages: messages.map((m) => ({ role: m.role, content: maskOutbound ? maskPii(m.content).text : m.content })),
      };
      const { json, elapsedMs } = await post('llm', body);
      const parsed = parseLlmResponse(json);
      if (parsed.usage) lastUsage = parsed.usage;
      // 스트리밍 미사용 응답이므로 첫 토큰 시각을 따로 알 수 없다 — 실측 가능한 total 만 채운다(§13-3).
      const out: { text: string; usage?: UsageMetrics; latency: LatencyMs } = { text: parsed.text, latency: { total_ms: elapsedMs } };
      if (parsed.usage) out.usage = parsed.usage;
      return out;
    },
    async *complete(messages: LlmMessage[]): AsyncIterable<string> {
      const r = await llm.completeOnce(messages);
      yield r.text;
    },
  };

  const set: HttpEngineSet = {
    config: cfg,
    activation: cfg.activation,
    stt,
    tts,
    llm,
    plan,
    lastUsage: () => lastUsage,
  };

  if (cfg.paths.embedding) {
    set.embedding = {
      name: `${cfg.name}-embedding`,
      residency: cfg.residency,
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];   // 빈 입력에 네트워크를 쓰지 않는다
        const body = { texts: texts.map((t) => (maskOutbound ? maskPii(t).text : t)) };
        const { json } = await post('embedding', body);
        return parseEmbeddingResponse(json, texts.length);
      },
    };
  }
  return set;
}

/**
 * 환경변수로부터 활성화 상태를 읽는다. 값이 없거나 해석 불가면 dry_run 이다 —
 * "실수로 켜지는" 경로를 만들지 않는다.
 */
export function activationFromEnv(env: Record<string, string | undefined>, key = 'AICC_ENGINE_ACTIVATION'): Activation {
  return env[key] === 'live' ? 'live' : 'dry_run';
}
