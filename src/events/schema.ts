// Interaction 이벤트 스키마 — 설계서 §8.1.
// 대시보드·리포트·QA·정산이 전부 이 이벤트를 원천으로 삼는다. 형식이 흔들리면 지표가 흔들린다.
// 모든 이벤트는 tenant_id로 스코프되며(§11.1), 본문 텍스트는 저장 전 마스킹된다(§10.3).
import type { ChannelKind, Outcome, Handoff } from '../domain/types.ts';
import { maskPii } from '../core/policyGuard.ts';

export const EVENT_SCHEMA_VERSION = 1;

export type InteractionEventType =
  | 'session.started'
  | 'turn.completed'
  | 'handoff.requested'
  | 'session.ended';

/** 구간별 지연(ms). 값은 실측으로만 채운다 — 기본값·목표치를 코드에 박지 않는다(§13-3). */
export interface LatencyMs {
  stt_ms?: number;
  llm_ttft_ms?: number;
  tts_ttfb_ms?: number;
  total_ms?: number;
}

export type EntryPoint = 'inbound_call' | 'outbound_call' | 'visual_link' | 'web_chat' | 'app_chat';

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

export function sessionEnded(
  m: EventMeta,
  p: { outcome: Outcome; turnCount: number; durationMs?: number; reContactWithin24h?: boolean; latency?: LatencyMs },
): SessionEndedEvent {
  return {
    ...base(m, 'session.ended', { masked: false, kinds: [] }, p.latency ?? {}),
    outcome: p.outcome,
    turn_count: p.turnCount,
    ...(p.durationMs !== undefined ? { duration_ms: p.durationMs } : {}),
    ...(p.reContactWithin24h !== undefined ? { re_contact_within_24h: p.reContactWithin24h } : {}),
  };
}

/** §11.1 — tenant_id 없는 이벤트는 저장·전송 경로에 올리지 않는다. */
export function assertTenantScoped(e: InteractionEvent): void {
  if (!e.tenant_id) throw new Error(`tenant_id 없는 이벤트는 저장할 수 없다: ${e.type} (설계서 §11.1)`);
}
