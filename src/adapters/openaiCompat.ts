// OpenAI 호환 규격 어댑터 — 설계서 §6.2(엔진 교체 가능)·§9.3(오류 비은폐)·§10.3(마스킹·국외이전)·§11.2·§13-3.
//
// 왜 이 파일이 필요한가:
// http.ts 의 중립 JSON 규약은 "벤더 차이가 들어올 자리"를 만들었지만, 그 규약을 말하는 엔진은 세상에 없다.
// 실제로 붙을 엔진 — 온프렘 sLLM 서빙(vLLM·Ollama·TGI 등)과 국내외 LLM API 대부분 — 이 공통으로 말하는 것은
// OpenAI 의 `chat/completions`·`embeddings` 요청/응답 형태다. 그 형태를 여기 한 곳에서 흡수해야
// 채널 저장소가 각자 `choices[0].message.content` 를 파고 각자 다르게 틀리는 일을 막는다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 승인 게이트·비밀값·타임아웃·오류 분류는 http.ts 의 createEngineTransport 가 책임진다. 여기서 복사하지 않는다.
//  - 기본 dry_run. plan() 으로 "정확히 무엇을 보낼 것인가"를 실호출 없이 확인할 수 있다.
//  - 모델 id·온도·토큰 상한에 기본값을 두지 않는다(§13-3). 주지 않은 값은 요청에 실리지 않는다.
//  - 도구 호출(tool_calls)·스트리밍(SSE)은 지원하지 않는다. 도구 호출 응답이 오면 조용히 빈 문자열을 내지 않고
//    E_PROTOCOL 로 드러낸다 — Core 시나리오는 Flow 가 밀지, 엔진이 밀지 않는다(§5.3).
//  - 임베딩 사용량은 UsageMetrics 에 자리가 없어 기록하지 않는다. LLM 프롬프트 토큰 칸에 섞어 넣으면
//    과금 대사(§11.2)에서 원인 불명 차이로 나타나므로, 자리가 생기기 전까지는 비워 둔다.
//
// STT(`audio/transcriptions`)·TTS(`audio/speech`)는 멀티파트·바이너리 응답이라 이 전송 계층(JSON)으로는
// 붙지 않는다. 음성은 http.ts 의 중립 규약(게이트웨이) 또는 별도 어댑터로 붙인다 — 이 파일의 범위 밖이다.
import type { EmbeddingAdapter, LlmMessage } from './index.ts';
import type { LatencyMs, UsageMetrics } from '../events/schema.ts';
import { maskPii } from '../core/policyGuard.ts';
import {
  EngineError, createEngineTransport, toUsageMetrics,
  type Activation, type EngineTransportConfig, type HttpLlmAdapter, type RequestPlan,
} from './http.ts';

/** OpenAI 호환 규격이 고정한 경로. 서빙 구현마다 프리픽스가 다를 수 있어 재정의는 허용한다. */
export const OPENAI_COMPAT_PATHS = Object.freeze({
  chat: '/v1/chat/completions',
  embeddings: '/v1/embeddings',
});

export interface OpenAiCompatConfig extends EngineTransportConfig {
  /** 채팅 모델 id. 없으면 llm 어댑터를 만들지 않는다 — 기본 모델을 Core 가 정하지 않는다(§13-3). */
  chatModel?: string;
  /** 임베딩 모델 id. 없으면 embedding 어댑터를 만들지 않는다. */
  embeddingModel?: string;
  /** 경로 재정의(프록시·프리픽스 차이 흡수). 생략하면 규격 경로. */
  paths?: { chat?: string; embeddings?: string };
  /** 외부 엔진으로 나가는 텍스트에 §10.3 마스킹을 적용한다. 기본 true — 끄려면 명시해야 한다. */
  maskOutbound?: boolean;
  /** 출력 토큰 상한. 주면 max_tokens 로 실린다. 기본값 없음. */
  maxTokens?: number;
  /** 샘플링 온도. 주면 temperature 로 실린다. 기본값 없음. */
  temperature?: number;
  /** 임베딩 1회 요청 입력 건수 상한. 주면 초과 시 호출 전에 거절한다. */
  maxEmbeddingBatch?: number;
}

export type ChatFinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'unknown';

export interface ChatCompletionResult {
  text: string;
  usage?: UsageMetrics;
  latency: LatencyMs;
  /** 엔진이 알려 준 종료 사유. `length` 면 답이 잘린 것이다 — 상위가 이어 말하기·재요청을 판단한다. */
  finishReason: ChatFinishReason;
  truncated: boolean;
  /** 엔진이 실제로 쓴 모델 id(응답의 model). 요청과 다르면 설정 실수를 여기서 본다. */
  model?: string;
}

export type OpenAiCompatLlmAdapter = HttpLlmAdapter & {
  completeOnce(messages: LlmMessage[]): Promise<ChatCompletionResult>;
};

export interface OpenAiCompatEngines {
  readonly config: Readonly<OpenAiCompatConfig>;
  readonly activation: Activation;
  llm?: OpenAiCompatLlmAdapter;
  embedding?: EmbeddingAdapter;
  /** 검토용 요청 계획. `body` 는 실제로 보낼 요청 본문과 같다(마스킹 적용 후). */
  plan(component: 'llm' | 'embedding', body: Record<string, unknown>): RequestPlan;
  /** 마지막 LLM 호출의 실측 사용량(§11.2). 호출 전에는 undefined. */
  lastUsage(): UsageMetrics | undefined;
}

// ── 응답 파서 (순수 함수 — 형식 위반은 조용히 넘기지 않는다) ──────────────────

function asObject(raw: unknown, component: 'llm' | 'embedding'): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EngineError('E_PROTOCOL', component, '엔진 응답이 JSON 객체가 아닙니다.');
  }
  return raw as Record<string, unknown>;
}

function finishReasonOf(v: unknown): ChatFinishReason {
  switch (v) {
    case 'stop': case 'length': case 'content_filter': case 'tool_calls': return v;
    default: return 'unknown';
  }
}

/**
 * `chat/completions` 응답 → 텍스트·사용량·종료 사유.
 * 잘림(length)은 오류가 아니라 사실이므로 그대로 싣고, 콘텐츠 필터·도구 호출·빈 본문은 오류로 드러낸다.
 */
export function parseChatCompletion(raw: unknown): Omit<ChatCompletionResult, 'latency'> {
  const o = asObject(raw, 'llm');
  const choices = o['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new EngineError('E_PROTOCOL', 'llm', 'chat/completions 응답에 choices 가 없습니다.');
  }
  const first = choices[0] as Record<string, unknown>;
  if (typeof first !== 'object' || first === null) {
    throw new EngineError('E_PROTOCOL', 'llm', 'choices[0] 이 객체가 아닙니다.');
  }
  const finishReason = finishReasonOf(first['finish_reason']);
  if (finishReason === 'content_filter') {
    throw new EngineError('E_FILTERED', 'llm', '엔진 콘텐츠 필터로 응답이 비워졌습니다(finish_reason=content_filter).');
  }
  const message = first['message'];
  if (typeof message !== 'object' || message === null) {
    throw new EngineError('E_PROTOCOL', 'llm', 'choices[0].message 가 없습니다.');
  }
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content !== 'string') {
    const why = finishReason === 'tool_calls' || 'tool_calls' in (message as Record<string, unknown>)
      ? '도구 호출 응답은 이 어댑터가 지원하지 않습니다(시나리오는 Flow 가 진행한다, §5.3).'
      : 'choices[0].message.content 가 문자열이 아닙니다.';
    throw new EngineError('E_PROTOCOL', 'llm', why, { finishReason });
  }
  const out: Omit<ChatCompletionResult, 'latency'> = {
    text: content,
    finishReason,
    truncated: finishReason === 'length',
  };
  const usage = toUsageMetrics(o['usage']);
  if (usage) out.usage = usage;
  if (typeof o['model'] === 'string') out.model = o['model'];
  return out;
}

/**
 * `embeddings` 응답 → 입력 순서대로 정렬된 벡터 배열.
 * 엔진은 `index` 로 순서를 알려 주므로 배열 순서를 믿지 않고 index 로 되돌린다.
 * 개수·index 누락/중복·차원 불일치는 전부 오류다 — 어긋난 벡터가 지식 색인에 들어가면 검색이 조용히 틀린다(§5.2).
 */
export function parseEmbeddings(raw: unknown, expected: number): number[][] {
  const o = asObject(raw, 'embedding');
  const data = o['data'];
  if (!Array.isArray(data)) throw new EngineError('E_PROTOCOL', 'embedding', 'embeddings 응답에 data 배열이 없습니다.');
  if (data.length !== expected) {
    throw new EngineError('E_PROTOCOL', 'embedding', `임베딩 개수 불일치: 요청 ${expected}건, 응답 ${data.length}건.`);
  }
  const out: (number[] | undefined)[] = new Array(expected).fill(undefined);
  let dim: number | undefined;
  for (const item of data) {
    if (typeof item !== 'object' || item === null) throw new EngineError('E_PROTOCOL', 'embedding', 'data 항목이 객체가 아닙니다.');
    const it = item as Record<string, unknown>;
    const idx = it['index'];
    if (!Number.isInteger(idx) || (idx as number) < 0 || (idx as number) >= expected) {
      throw new EngineError('E_PROTOCOL', 'embedding', `임베딩 index 가 범위 밖입니다: ${String(idx)}`);
    }
    if (out[idx as number] !== undefined) {
      throw new EngineError('E_PROTOCOL', 'embedding', `임베딩 index 중복: ${String(idx)}`);
    }
    const vec = it['embedding'];
    if (!Array.isArray(vec) || vec.length === 0 || vec.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw new EngineError('E_PROTOCOL', 'embedding', `임베딩 ${String(idx)}번이 숫자 배열이 아닙니다.`);
    }
    if (dim === undefined) dim = vec.length;
    else if (vec.length !== dim) {
      throw new EngineError('E_PROTOCOL', 'embedding', `임베딩 차원 불일치: ${dim} vs ${vec.length} (index ${String(idx)})`);
    }
    out[idx as number] = vec as number[];
  }
  return out as number[][];   // 개수 검사 + 중복 거부로 빈 칸은 남을 수 없다
}

// ── 어댑터 본체 ───────────────────────────────────────────────────────────────

export function createOpenAiCompatEngines(cfg: OpenAiCompatConfig): OpenAiCompatEngines {
  if (!cfg.chatModel && !cfg.embeddingModel) {
    throw new EngineError('E_CONFIG', 'config', 'chatModel 또는 embeddingModel 중 하나는 있어야 합니다 — 기본 모델을 Core 가 정하지 않습니다(§13-3).');
  }
  if (cfg.maxTokens !== undefined && (!Number.isInteger(cfg.maxTokens) || cfg.maxTokens <= 0)) {
    throw new EngineError('E_CONFIG', 'config', 'maxTokens 는 1 이상의 정수여야 합니다.');
  }
  if (cfg.temperature !== undefined && !(Number.isFinite(cfg.temperature) && cfg.temperature >= 0)) {
    throw new EngineError('E_CONFIG', 'config', 'temperature 는 0 이상의 수여야 합니다.');
  }
  if (cfg.maxEmbeddingBatch !== undefined && (!Number.isInteger(cfg.maxEmbeddingBatch) || cfg.maxEmbeddingBatch <= 0)) {
    throw new EngineError('E_CONFIG', 'config', 'maxEmbeddingBatch 는 1 이상의 정수여야 합니다.');
  }
  const transport = createEngineTransport(cfg);
  const maskOutbound = cfg.maskOutbound !== false;
  const chatPath = cfg.paths?.chat ?? OPENAI_COMPAT_PATHS.chat;
  const embeddingsPath = cfg.paths?.embeddings ?? OPENAI_COMPAT_PATHS.embeddings;
  const pathOf = (component: 'llm' | 'embedding') => (component === 'llm' ? chatPath : embeddingsPath);
  const outbound = (t: string) => (maskOutbound ? maskPii(t).text : t);
  let lastUsage: UsageMetrics | undefined;

  const set: OpenAiCompatEngines = {
    config: cfg,
    activation: transport.activation,
    plan: (component, body) => transport.plan(component, pathOf(component), body),
    lastUsage: () => lastUsage,
  };

  if (cfg.chatModel) {
    const model = cfg.chatModel;
    const buildChatBody = (messages: LlmMessage[]): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model,
        messages: messages.map((m) => ({ role: m.role, content: outbound(m.content) })),
        stream: false,   // SSE 미지원을 명시한다 — 서버 기본값에 기대지 않는다
      };
      if (cfg.maxTokens !== undefined) body['max_tokens'] = cfg.maxTokens;
      if (cfg.temperature !== undefined) body['temperature'] = cfg.temperature;
      return body;
    };
    const llm: OpenAiCompatLlmAdapter = {
      name: `${cfg.name}-llm`,
      residency: cfg.residency,
      async completeOnce(messages: LlmMessage[]): Promise<ChatCompletionResult> {
        if (messages.length === 0) throw new EngineError('E_INPUT', 'llm', '빈 메시지 목록은 LLM으로 보내지 않습니다.');
        if (messages.some((m) => typeof m.content !== 'string' || m.content.trim() === '')) {
          throw new EngineError('E_INPUT', 'llm', '빈 내용의 메시지는 LLM으로 보내지 않습니다.');
        }
        const { json, elapsedMs } = await transport.post('llm', chatPath, buildChatBody(messages));
        const parsed = parseChatCompletion(json);
        if (parsed.usage) lastUsage = parsed.usage;
        // 비스트리밍 응답이라 첫 토큰 시각은 알 수 없다 — 실측 가능한 total 만 채운다(§13-3).
        return { ...parsed, latency: { total_ms: elapsedMs } };
      },
      async *complete(messages: LlmMessage[]): AsyncIterable<string> {
        const r = await llm.completeOnce(messages);
        yield r.text;
      },
    };
    set.llm = llm;
  }

  if (cfg.embeddingModel) {
    const model = cfg.embeddingModel;
    set.embedding = {
      name: `${cfg.name}-embedding`,
      residency: cfg.residency,
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];   // 빈 입력에 네트워크를 쓰지 않는다
        if (cfg.maxEmbeddingBatch !== undefined && texts.length > cfg.maxEmbeddingBatch) {
          throw new EngineError('E_LIMIT', 'embedding', `임베딩 배치 상한 초과: ${texts.length} > ${cfg.maxEmbeddingBatch}`);
        }
        if (texts.some((t) => typeof t !== 'string' || t.trim() === '')) {
          throw new EngineError('E_INPUT', 'embedding', '빈 문자열은 임베딩으로 보내지 않습니다(빈 벡터가 색인에 들어간다).');
        }
        const body = { model, input: texts.map(outbound), encoding_format: 'float' };
        const { json } = await transport.post('embedding', embeddingsPath, body);
        return parseEmbeddings(json, texts.length);
      },
    };
  }

  return set;
}
