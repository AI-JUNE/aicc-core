// Interaction 이벤트 스키마 — 설계서 §8.1.
// 대시보드·리포트·QA·정산이 전부 이 이벤트를 원천으로 삼는다. 형식이 흔들리면 지표가 흔들린다.
// 모든 이벤트는 tenant_id로 스코프되며(§11.1), 본문 텍스트는 저장 전 마스킹된다(§10.3).
import type { ChannelKind, Outcome, Handoff, LatencyBreakdown } from '../domain/types.ts';
import { maskPii } from '../core/policyGuard.ts';

export const EVENT_SCHEMA_VERSION = 1;

export type InteractionEventType =
  | 'session.started'
  | 'turn.completed'
  | 'handoff.requested'
  | 'session.ended';

/**
 * 구간별 지연(ms). 값은 실측으로만 채운다 — 기본값·목표치를 코드에 박지 않는다(§13-3).
 *
 * §8.1 의 이름은 `latency_ms` 이고 §4 턴 이력의 이름은 `Turn.latency` 지만 **측정은 하나**다.
 * 그래서 선언은 `domain/types.ts` 에 한 번만 두고 여기서는 그것을 가리킨다(그 파일 주석 참조) —
 * 두 벌로 두었던 동안 키 이름이 갈라져 한쪽을 채운 실측이 반대쪽 집계에 도착하지 못했다.
 */
export type LatencyMs = LatencyBreakdown;

export { LATENCY_KEYS } from '../domain/types.ts';

/**
 * 과금 근거가 되는 사용량(§11.2). 실측값만 넣는다 — 추정·기본값 금지(§13-3).
 * 엔진마다 단위가 다르므로(초 vs ms, 토큰 정의) 어댑터가 이 형태로 환산해 채운다(§6.2).
 */
export interface UsageMetrics {
  /** LLM 입력 토큰 */
  llm_prompt_tokens?: number;
  /** LLM 출력 토큰 */
  llm_completion_tokens?: number;
  /** STT가 처리한 오디오 길이(ms) */
  stt_audio_ms?: number;
  /** TTS가 합성한 오디오 길이(ms) */
  tts_audio_ms?: number;
  /**
   * 임베딩 엔진이 처리한 토큰 수(§5.2 RAG 색인·질의).
   *
   * 이 칸이 없던 동안 임베딩 비용은 **어디에도 실리지 않았다**. 규격 어댑터
   * (`adapters/openaiCompat.ts`)는 응답의 `usage` 를 아예 읽지 않았고, 그 머리말은 그 이유를
   * "UsageMetrics 에 자리가 없어 기록하지 않는다 … 자리가 생기기 전까지는 비워 둔다"로 적어
   * 두었다. 결과는 예외가 아니다 — 그 토큰은 **공급사 청구서에만** 남고 §8.1 원장에는 0줄이며,
   * 몇 주 뒤 §11.2 대사에서 '미설명' 차이로 돌아온다. 방향이 과소청구라 과다청구 차단
   * (`blocked`)에도 걸리지 않아, 아무도 보지 않으면 영원히 그대로다.
   *
   * **LLM 토큰 칸에 섞어 넣지 않는다**: 두 모델은 단가가 다르고 공급사 리포트도 따로 나오므로,
   * 합쳐 적는 순간 대사는 "둘 다 맞지 않는다"만 말할 수 있다. 입력/출력으로 나누지도 않는다 —
   * 임베딩은 출력 토큰이 없고, 없는 칸을 0 으로 채우면 "0 을 실측했다"가 된다(§13-3).
   */
  embedding_tokens?: number;
}

/**
 * 위 사용량 항목의 키 목록. `LATENCY_KEYS` 와 같은 이유로 **타입에 묶어** 둔다 —
 * 종전에는 이 목록이 브리지 검증·엔진셋 수집·턴 귀속에 각각 복사돼 있었다.
 *
 * 과금 근거에서는 어긋남의 값이 더 비싸다: 키가 하나 늘었는데 브리지만 모르면 **비-Node 호스트의
 * 그 턴 전체가 거부**되고(§11.2 근거가 아예 안 쌓인다), 반대로 턴 귀속만 모르면 그 항목이 조용히
 * 집계에서 빠져 몇 주 뒤 대사에서 '미설명' 차이로 돌아온다(그 방향은 과소청구라 청구도 막히지 않는다).
 */
const USAGE_METRIC_KEY_TUPLE = [
  'llm_prompt_tokens', 'llm_completion_tokens', 'stt_audio_ms', 'tts_audio_ms', 'embedding_tokens',
] as const;

/** 없는 키·오타를 막는다. */
export const USAGE_METRIC_KEYS: readonly (keyof UsageMetrics)[] = USAGE_METRIC_KEY_TUPLE;

/** 목록이 `UsageMetrics` 의 키를 **전부** 덮는지. 덮지 못하면 컴파일 오류다. */
const _usageKeysCover: Exclude<keyof UsageMetrics, typeof USAGE_METRIC_KEY_TUPLE[number]> extends never
  ? true : never = true;
void _usageKeysCover;

export type EntryPoint = 'inbound_call' | 'outbound_call' | 'visual_link' | 'web_chat' | 'app_chat';

/**
 * 위 유입 경로의 값 목록. 유니온은 **실행 시점에 검사할 수 없으므로** 경계(브리지 JSONL)가
 * 목록을 따로 들고 있었다 — 유입 경로가 하나 늘면 그 경로로 들어오는 **세션 시작 자체가 거부된다**
 * (`E_BAD_REQUEST`). 비-Node 호스트에서만 그러므로 증상은 "그 채널에서만 통화가 안 열린다"다.
 */
const ENTRY_POINT_TUPLE = [
  'inbound_call', 'outbound_call', 'visual_link', 'web_chat', 'app_chat',
] as const;

/** 없는 값·오타를 막는다. */
export const ENTRY_POINTS: readonly EntryPoint[] = ENTRY_POINT_TUPLE;

/** 목록이 `EntryPoint` 를 **전부** 덮는지. 덮지 못하면 컴파일 오류다. */
const _entryPointsCover: Exclude<EntryPoint, typeof ENTRY_POINT_TUPLE[number]> extends never
  ? true : never = true;
void _entryPointsCover;

/** 이벤트 생성 시 호출자가 제공하는 식별 정보 (id·시각은 주입 — 순수 함수 유지) */
export interface EventMeta {
  eventId: string;
  occurredAt: string;
  tenantId: string;
  interactionId: string;
  channel: ChannelKind;
  flowId?: string;
  flowVersion?: number;
}

export interface EventBase {
  event_id: string;
  schema_version: number;
  type: InteractionEventType;
  occurred_at: string;          // ISO8601
  tenant_id: string;            // §11.1 파티션 키 — 없으면 저장 금지
  interaction_id: string;
  channel: ChannelKind;
  flow_id?: string;
  flow_version?: number;
  /** §10.3 — 본문에 마스킹이 적용되었는지 */
  pii_masked: boolean;
  /** 마스킹된 항목 종류(rrn·card·account·phone). 원문은 담지 않는다. */
  pii_kinds: string[];
  latency_ms: LatencyMs;
}

export interface SessionStartedEvent extends EventBase {
  type: 'session.started';
  entry_point?: EntryPoint;
}

export interface TurnCompletedEvent extends EventBase {
  type: 'turn.completed';
  turn_id: string;
  node_id?: string;
  speaker: 'customer' | 'bot' | 'agent';
  /** 마스킹 통과 후의 발화만 보관 (§10.3) */
  utterance_masked: string;
  intent?: string;
  confidence?: number;
  retry_count?: number;
  /** §11.2 과금 근거 — 어댑터가 실측으로 채운 경우에만 존재한다. */
  usage?: UsageMetrics;
}

export interface HandoffRequestedEvent extends EventBase {
  type: 'handoff.requested';
  reason: Handoff['reason'];
  to_queue?: string;
  summary_masked?: string;
  summary_present: boolean;
}

export interface SessionEndedEvent extends EventBase {
  type: 'session.ended';
  outcome: Outcome;
  turn_count: number;
  duration_ms?: number;
  /** §4.1 최종 Outcome 확정은 재문의 반영 후 resolveOutcome이 담당한다 */
  re_contact_within_24h?: boolean;
  /**
   * §11.2 통화 과금 대상 구간(ms). duration_ms(세션 전체)와 다를 수 있다 —
   * 대기·호 설정 구간을 과금에 포함할지는 계약에 달렸으므로 채널 어댑터가 계약대로 채운다.
   * 미제공 시 과금 집계는 이 세션을 통화 분 집계에서 제외한다(임의 추정 금지 §13-3).
   */
  billable_ms?: number;
}

export type InteractionEvent =
  | SessionStartedEvent
  | TurnCompletedEvent
  | HandoffRequestedEvent
  | SessionEndedEvent;

function base<T extends InteractionEventType>(
  m: EventMeta,
  type: T,
  pii: { masked: boolean; kinds: string[] },
  latency: LatencyMs,
): EventBase & { type: T } {
  return {
    event_id: m.eventId,
    schema_version: EVENT_SCHEMA_VERSION,
    type,
    occurred_at: m.occurredAt,
    tenant_id: m.tenantId,
    interaction_id: m.interactionId,
    channel: m.channel,
    ...(m.flowId !== undefined ? { flow_id: m.flowId } : {}),
    ...(m.flowVersion !== undefined ? { flow_version: m.flowVersion } : {}),
    pii_masked: pii.masked,
    pii_kinds: pii.kinds,
    latency_ms: latency,
  };
}

export function sessionStarted(m: EventMeta, p: { entryPoint?: EntryPoint; latency?: LatencyMs } = {}): SessionStartedEvent {
  return {
    ...base(m, 'session.started', { masked: false, kinds: [] }, p.latency ?? {}),
    ...(p.entryPoint !== undefined ? { entry_point: p.entryPoint } : {}),
  };
}

/** 발화는 이 함수 안에서 반드시 마스킹된다. 원문을 이벤트에 넣는 경로를 만들지 말 것(§10.3). */
export function turnCompleted(
  m: EventMeta,
  p: {
    turnId: string;
    speaker: 'customer' | 'bot' | 'agent';
    utterance: string;
    nodeId?: string;
    intent?: string;
    confidence?: number;
    retryCount?: number;
    latency?: LatencyMs;
    usage?: UsageMetrics;
  },
): TurnCompletedEvent {
  const masked = maskPii(p.utterance);
  return {
    ...base(m, 'turn.completed', { masked: masked.masked, kinds: masked.hits }, p.latency ?? {}),
    turn_id: p.turnId,
    speaker: p.speaker,
    utterance_masked: masked.text,
    ...(p.nodeId !== undefined ? { node_id: p.nodeId } : {}),
    ...(p.intent !== undefined ? { intent: p.intent } : {}),
    ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
    ...(p.retryCount !== undefined ? { retry_count: p.retryCount } : {}),
    ...(p.usage !== undefined ? { usage: p.usage } : {}),
  };
}

export function handoffRequested(
  m: EventMeta,
  p: { reason: Handoff['reason']; toQueue?: string; summary?: string; latency?: LatencyMs },
): HandoffRequestedEvent {
  const masked = p.summary === undefined ? undefined : maskPii(p.summary);
  return {
    ...base(m, 'handoff.requested', { masked: masked?.masked ?? false, kinds: masked?.hits ?? [] }, p.latency ?? {}),
    reason: p.reason,
    summary_present: masked !== undefined,
    ...(p.toQueue !== undefined ? { to_queue: p.toQueue } : {}),
    ...(masked !== undefined ? { summary_masked: masked.text } : {}),
  };
}

/**
 * 세션 길이 실측(ms) — `session.ended.duration_ms` 의 **유일한 산출 규칙**이다(§2·§13-3).
 *
 * 규칙을 여기 한 곳에 두는 이유: 이 값을 만드는 자리가 다섯이다(Runner 의 종료 네 갈래와
 * 채널 런타임의 폴백·커넥터 상한·정상 종료). 자리마다 각자 재면 같은 통화가 경로에 따라 다른
 * 길이로 적히고, 그 차이는 예외가 아니라 **리포트와 상호작용 조회의 숫자가 갈리는 것**으로만
 * 나타난다(두 화면 모두 이 필드만 읽고 이벤트 시각으로 다시 계산하지 않는다).
 *
 * 읽을 수 없는 시각·거꾸로 간 시계는 **값을 만들지 않는다**(§13-3). 0 으로 적으면 "0초 통화를
 * 실측했다"가 되고, 음수를 그대로 적으면 소비자가 그 값을 거부로 센다 — 둘 다 "재지 못했다"와
 * 다른 사실이다. 없을 때의 정직한 신호는 소비자의 `sessionsMissingDuration` 하나다.
 * 두 시각이 같으면 `0` 이다 — 그것은 누락이 아니라 같은 시점을 가리키는 실측이다.
 */
export function measuredDurationMs(startedAtIso: string | undefined, endedAtIso: string): number | undefined {
  if (startedAtIso === undefined) return undefined;
  const started = Date.parse(startedAtIso);
  const ended = Date.parse(endedAtIso);
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return undefined;
  return ended - started;
}

export function sessionEnded(
  m: EventMeta,
  p: {
    outcome: Outcome;
    turnCount: number;
    durationMs?: number;
    reContactWithin24h?: boolean;
    latency?: LatencyMs;
    billableMs?: number;
  },
): SessionEndedEvent {
  return {
    ...base(m, 'session.ended', { masked: false, kinds: [] }, p.latency ?? {}),
    outcome: p.outcome,
    turn_count: p.turnCount,
    ...(p.durationMs !== undefined ? { duration_ms: p.durationMs } : {}),
    ...(p.reContactWithin24h !== undefined ? { re_contact_within_24h: p.reContactWithin24h } : {}),
    ...(p.billableMs !== undefined ? { billable_ms: p.billableMs } : {}),
  };
}

/** §11.1 — tenant_id 없는 이벤트는 저장·전송 경로에 올리지 않는다. */
export function assertTenantScoped(e: InteractionEvent): void {
  if (!e.tenant_id) throw new Error(`tenant_id 없는 이벤트는 저장할 수 없다: ${e.type} (설계서 §11.1)`);
}
