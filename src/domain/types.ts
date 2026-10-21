// AICC 도메인 모델 — 설계서 §4. 채널이 아니라 세션(Interaction)이 1급 객체다.

export type ChannelKind = 'voice' | 'visual' | 'chat';

/** §4.1 과금·KPI·SLA·ROI가 전부 여기서 나온다. 애매하면 정산 분쟁이 난다. */
export type Outcome = 'AUTO_RESOLVED' | 'TRANSFERRED' | 'ABANDONED' | 'FAILED';

/**
 * 구간별 지연(ms). 실측으로만 채운다 — 기본값·목표치를 코드에 박지 않는다(§13-3).
 *
 * **이 선언이 유일하다.** 같은 측정이 두 층에 실리기 때문이다 — 도메인 턴 이력(§4 `Turn.latency`)과
 * §8.1 이벤트(`latency_ms`). 종전에는 양쪽이 **각자 선언했고 키 이름까지 달랐다**(`stt` vs `stt_ms`).
 * 그 상태에서 도메인 타입대로 `{ stt: 120 }` 을 채운 호스트의 실측은 원장·리포트의 어느 칸에도
 * 들어가지 않는다 — 타입은 통과하고 예외도 없어, 증상은 "§13 지연 지표에 표본이 없다"뿐이다.
 * 그래서 아래층(domain)에 한 번 선언하고 §8.1 은 `LatencyMs` 이름으로 이것을 가리킨다.
 */
export interface LatencyBreakdown {
  stt_ms?: number;
  llm_ttft_ms?: number;
  tts_ttfb_ms?: number;
  total_ms?: number;
}

/**
 * 위 타입의 키 목록. **타입에서 떼어 놓을 수 없게** 묶어 둔다 — `readonly (keyof …)[]` 대입이
 * 오타·없는 키를 막고, 아래 `_latencyKeysCover` 가 **빠뜨린 키**를 막는다.
 *
 * 왜 이 장치가 필요한가: 종전에는 이 목록이 코드에 세 벌(브리지 검증·런타임 병합·리포트 분기)
 * 복사돼 있었고 런타임 쪽 사본의 주석은 "목록을 여기 한 곳에 둔다"고 적어 두었다. 사실이
 * 아니었고, 키가 하나 늘어나는 날 늘어나지 않은 쪽은 **조용히 틀린다** — 브리지는 그 키가 실린
 * 턴을 `E_BAD_REQUEST` 로 거부하고(비-Node 호스트만), 런타임은 그 키를 병합에서 빠뜨리고,
 * 리포트는 그 표본을 세지 않는다. 지금은 타입에 키를 더하면 **컴파일이 멈춘다**.
 */
const LATENCY_KEY_TUPLE = ['stt_ms', 'llm_ttft_ms', 'tts_ttfb_ms', 'total_ms'] as const;

/** 없는 키·오타를 막는다(대입 자체가 컴파일 오류가 된다). */
export const LATENCY_KEYS: readonly (keyof LatencyBreakdown)[] = LATENCY_KEY_TUPLE;

/** 목록이 타입의 키를 **전부** 덮는지 — 빠뜨린 키가 있으면 이 대입이 컴파일 오류가 된다. */
const _latencyKeysCover: Exclude<keyof LatencyBreakdown, typeof LATENCY_KEY_TUPLE[number]> extends never
  ? true : never = true;
void _latencyKeysCover;

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
