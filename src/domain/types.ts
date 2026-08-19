// AICC 도메인 모델 — 설계서 §4. 채널이 아니라 세션(Interaction)이 1급 객체다.

export type ChannelKind = 'voice' | 'visual' | 'chat';

/** §4.1 과금·KPI·SLA·ROI가 전부 여기서 나온다. 애매하면 정산 분쟁이 난다. */
export type Outcome = 'AUTO_RESOLVED' | 'TRANSFERRED' | 'ABANDONED' | 'FAILED';

export interface LatencyBreakdown {
  stt?: number;
  llm_ttft?: number;
  tts_ttfb?: number;
  total?: number;
}

export interface Turn {
  id: string;
  at: string;                 // ISO8601
  channel: ChannelKind;
  speaker: 'customer' | 'bot' | 'agent';
  utterance: string;
  intent?: string;
  confidence?: number;
  latency?: LatencyBreakdown;
}

export interface Handoff {
  at: string;
  reason: 'low_confidence' | 'customer_request' | 'policy' | 'error' | 'max_retry';
  toQueue?: string;
  summary?: string;           // 상담사에게 전달되는 요약 (§2 핸드오프 단절 해소)
}

export interface Interaction {
  id: string;
  tenantId: string;
  workspaceId?: string;
  startedAt: string;
  endedAt?: string;
  channels: ChannelKind[];    // 하나의 Interaction이 여러 채널을 가진다
  turns: Turn[];
  entities: Record<string, string>;  // 수집 슬롯(이름·생년월일 등)
  handoff?: Handoff;
  outcome?: Outcome;
  /** AUTO_RESOLVED 판정 보조: 24h 내 재문의 여부 (§4.1) */
  reContactWithin24h?: boolean;
}

/** §4.1 — "AI가 대충 끊은 콜"이 자동완결로 집계되지 않게 하는 판정기 */
export function resolveOutcome(i: Interaction): Outcome {
  if (i.outcome === 'FAILED') return 'FAILED';
  if (i.handoff) return 'TRANSFERRED';
  const goalDone = Boolean(i.entities['__goal_completed__']);
  if (!goalDone) return 'ABANDONED';
  if (i.reContactWithin24h) return 'ABANDONED';
  return 'AUTO_RESOLVED';
}
