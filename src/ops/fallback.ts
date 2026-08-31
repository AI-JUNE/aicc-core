// 장애 폴백 정책 — 설계서 §9.3.
//
// 원칙 한 줄: "AI가 죽어도 전화는 받아져야 한다."
// AICC 도입의 최대 리스크는 성능이 아니라 가용성이다. AI 계층이 멈췄을 때 콜이 그냥 끊기면
// 그건 서비스 장애가 아니라 사고다. 그래서 엔진을 3계층으로 나눠 보고, 계층별로 무엇을 포기하고
// 무엇으로 넘길지 사전에 정해 둔다.
//
//  L1 매체(telephony·messaging) — 죽으면 아무것도 못 한다. 폴백 대상이 아니라 이중화 대상.
//  L2 인지(stt·tts·llm)       — 죽으면 AI 응대만 포기한다. 기존 IVR·상담사로 내린다.
//  L3 지식(rag·backend)       — 죽으면 답변 근거만 포기한다. 시나리오 흐름은 계속 갈 수 있다.
//
// 판정만 한다(순수 함수). 실제 회선 전환·상담사 호출은 승인 후 연동한다 — [승인 필요].
// 임계 시간·재시도 횟수의 "권장값"을 코드에 박지 않는다(§13-3). 정책은 테넌트가 계약대로 넣는다.
import type { FallbackAction } from '../core/session.ts';

export type EngineTier = 'L1_media' | 'L2_cognition' | 'L3_knowledge';

export type ComponentId =
  | 'telephony' | 'messaging'          // L1
  | 'stt' | 'tts' | 'llm'              // L2
  | 'rag' | 'backend';                 // L3

export const COMPONENT_TIER: Record<ComponentId, EngineTier> = {
  telephony: 'L1_media',
  messaging: 'L1_media',
  stt: 'L2_cognition',
  tts: 'L2_cognition',
  llm: 'L2_cognition',
  rag: 'L3_knowledge',
  backend: 'L3_knowledge',
};

export type HealthState = 'up' | 'degraded' | 'down' | 'unknown';

export interface HealthSample {
  component: ComponentId;
  state: HealthState;
  /** 관측 시각(ISO8601). 오래된 샘플은 up 으로 믿지 않는다. */
  observedAt: string;
  /** 관측된 실패율(0~1)·응답시간. 실측만 넣는다 — 추정 금지(§13-3). */
  errorRate?: number;
  latencyMs?: number;
  detail?: string;
}

/**
 * 엔진 헬스체크 인터페이스. 구현은 어댑터 쪽에 둔다 — Core는 엔진을 직접 부르지 않는다(§6.2).
 * 실제 프로브(핑·합성콜)는 승인 후 연결한다 — [승인 필요].
 */
export interface HealthProbe {
  readonly component: ComponentId;
  check(signal?: AbortSignal): Promise<HealthSample>;
}

export interface HealthRegistry {
  /** 컴포넌트별 최신 샘플. 없으면 unknown 으로 취급한다. */
  latest(component: ComponentId): HealthSample | undefined;
  snapshot(): HealthSample[];
}

/** 메모리 레지스트리 — 프로브 결과를 컴포넌트별 최신 1건만 유지한다. */
export function createHealthRegistry(initial: HealthSample[] = []): HealthRegistry & { record(s: HealthSample): void } {
  const map = new Map<ComponentId, HealthSample>();
  const record = (s: HealthSample): void => {
    const prev = map.get(s.component);
    // 늦게 도착한 과거 샘플이 최신 상태를 덮어쓰지 않게 한다.
    if (prev && prev.observedAt > s.observedAt) return;
    map.set(s.component, s);
  };
  for (const s of initial) record(s);
  return {
    record,
    latest: (c) => map.get(c),
    snapshot: () => [...map.values()],
  };
}

/** 폴백 정책. 값은 테넌트 계약·운영 합의로만 채운다. */
export interface FallbackPolicy {
  tenantId: string;
  /** 샘플이 이 시간보다 오래되면 unknown 으로 본다(ms). */
  staleAfterMs: number;
  /** unknown 을 장애로 볼 것인가. 보수적 운영이면 true. */
  treatUnknownAsDown: boolean;
  /** 기존 IVR 로 내릴 수 있는가. 없는 고객사도 있다 — 없으면 상담사로 간다. */
  legacyIvrAvailable: boolean;
  /** 상담사 큐 가용 여부(운영시간·잔여석). 게이트웨이가 실측으로 채운다. */
  agentQueueAvailable: boolean;
  /** 이관 대상 큐. 미지정 시 채널 어댑터의 기본 큐를 쓴다. */
  fallbackQueue?: string;
}

export type FallbackMode =
  | 'normal'            // 정상 — AI 응대 유지
  | 'degraded_ai'       // 일부 기능 축소(예: 지식검색 없이 시나리오만)
  | 'legacy_ivr'        // 기존 IVR 로 내림
  | 'agent_only'        // 상담사 직결
  | 'unavailable';      // 매체 자체가 죽음 — Core가 할 수 있는 게 없다

export interface FallbackDecision {
  mode: FallbackMode;
  /** 판정 근거가 된 컴포넌트 — 알림·사후분석에서 이게 없으면 원인 추적이 안 된다. */
  causes: { component: ComponentId; tier: EngineTier; state: HealthState }[];
  reasonKo: string;
  /** 이 판정에서 사용을 중단해야 하는 기능 */
  disable: ('ai_response' | 'knowledge_grounding' | 'voice_synthesis' | 'speech_recognition')[];
  transferTo?: string;
}

function effectiveState(s: HealthSample | undefined, policy: FallbackPolicy, nowMs: number): HealthState {
  if (!s) return policy.treatUnknownAsDown ? 'down' : 'unknown';
  const age = nowMs - Date.parse(s.observedAt);
  if (Number.isNaN(age)) return 'unknown';
  if (age > policy.staleAfterMs) return policy.treatUnknownAsDown ? 'down' : 'unknown';
  if (s.state === 'unknown' && policy.treatUnknownAsDown) return 'down';
  return s.state;
}

function isBad(st: HealthState): boolean {
  return st === 'down';
}

/** 채널이 실제로 의존하는 컴포넌트만 본다. 채팅에서 STT 장애로 상담사로 내리면 오탐이다. */
export const CHANNEL_DEPENDENCIES: Record<'voice' | 'visual' | 'chat', ComponentId[]> = {
  voice: ['telephony', 'stt', 'tts', 'llm', 'rag', 'backend'],
  visual: ['messaging', 'llm', 'rag', 'backend'],
  chat: ['messaging', 'llm', 'rag', 'backend'],
};

/**
 * §9.3 폴백 판정.
 *  - L1 down → unavailable (Core가 손 쓸 수 없음. 매체 이중화 문제)
 *  - L2 down → legacy_ivr(가능하면) 또는 agent_only. AI 응대는 즉시 중단한다.
 *  - L2 degraded → degraded_ai. 예: TTS 저하 시 합성 대신 사전녹음·텍스트로 내린다.
 *  - L3 down → degraded_ai. 근거 없는 자유 생성은 금지(§5.2)이므로 지식검색만 끈다.
 * 상담사·IVR 둘 다 불가하면 agent_only 로 두되 사유를 남긴다 — 조용히 끊는 경로를 만들지 않는다.
 */
export function decideFallbackMode(
  channel: 'voice' | 'visual' | 'chat',
  registry: HealthRegistry,
  policy: FallbackPolicy,
  nowIso: string,
): FallbackDecision {
  const nowMs = Date.parse(nowIso);
  const deps = CHANNEL_DEPENDENCIES[channel];
  const states = deps.map((c) => ({ component: c, tier: COMPONENT_TIER[c], state: effectiveState(registry.latest(c), policy, nowMs) }));

  const l1Down = states.filter((s) => s.tier === 'L1_media' && isBad(s.state));
  if (l1Down.length > 0) {
    return {
      mode: 'unavailable',
      causes: l1Down,
      reasonKo: `매체 계층 장애(${l1Down.map((s) => s.component).join(', ')}) — 회선 이중화로만 복구됩니다(§9.3).`,
      disable: ['ai_response', 'knowledge_grounding', 'voice_synthesis', 'speech_recognition'],
    };
  }

  const l2Down = states.filter((s) => s.tier === 'L2_cognition' && isBad(s.state));
  if (l2Down.length > 0) {
    const toIvr = policy.legacyIvrAvailable;
    const base = {
      causes: l2Down,
      disable: ['ai_response', 'knowledge_grounding', 'voice_synthesis', 'speech_recognition'] as FallbackDecision['disable'],
    };
    if (toIvr) {
      return { ...base, mode: 'legacy_ivr', reasonKo: `인지 계층 장애(${l2Down.map((s) => s.component).join(', ')}) — 기존 IVR로 전환합니다(§9.3).` };
    }
    return {
      ...base,
      mode: 'agent_only',
      reasonKo: policy.agentQueueAvailable
        ? `인지 계층 장애(${l2Down.map((s) => s.component).join(', ')}) — 상담사로 직접 연결합니다(§9.3).`
        : `인지 계층 장애(${l2Down.map((s) => s.component).join(', ')}) — 기존 IVR·상담사 모두 가용하지 않습니다. 운영 확인이 필요합니다(§9.3).`,
      ...(policy.fallbackQueue !== undefined ? { transferTo: policy.fallbackQueue } : {}),
    };
  }

  const l3Down = states.filter((s) => s.tier === 'L3_knowledge' && isBad(s.state));
  const degraded = states.filter((s) => s.state === 'degraded');
  if (l3Down.length > 0 || degraded.length > 0) {
    const causes = [...l3Down, ...degraded];
    const disable: FallbackDecision['disable'] = [];
    if (l3Down.length > 0) disable.push('knowledge_grounding');
    for (const d of degraded) {
      if (d.component === 'tts') disable.push('voice_synthesis');
      if (d.component === 'stt') disable.push('speech_recognition');
      if (d.component === 'rag' || d.component === 'backend') disable.push('knowledge_grounding');
    }
    return {
      mode: 'degraded_ai',
      causes,
      reasonKo: `축소 운영(${causes.map((s) => s.component).join(', ')}) — 해당 기능을 끄고 시나리오 흐름은 유지합니다(§9.3·§5.2).`,
      disable: [...new Set(disable)],
    };
  }

  const unknown = states.filter((s) => s.state === 'unknown');
  return {
    mode: 'normal',
    causes: unknown,
    reasonKo: unknown.length > 0
      ? `정상 — 다만 상태 미확인 컴포넌트가 있습니다(${unknown.map((s) => s.component).join(', ')}).`
      : '정상',
    disable: [],
  };
}

/** AI 응대를 계속해도 되는지 — 런타임이 매 턴 물어보는 단일 질문. */
export function aiResponseAllowed(d: FallbackDecision): boolean {
  return !d.disable.includes('ai_response');
}

/**
 * §5.1 대화 폴백(인식 실패 사다리)과 §9.3 장애 폴백을 합친 최종 판정.
 * 장애 폴백이 항상 우선한다 — 엔진이 죽었는데 "다시 말씀해 주세요"를 반복하는 게 최악이다.
 * conversational 에 'none' 을 넣으면 인식 실패가 없는 정상 턴을 뜻한다.
 */
export type RuntimeAction = 'continue_ai' | 'retry' | 'switch_to_visual' | 'handoff_agent' | 'route_legacy_ivr' | 'abort';

export function resolveRuntimeAction(
  d: FallbackDecision,
  conversational: FallbackAction | 'none',
): RuntimeAction {
  switch (d.mode) {
    case 'unavailable': return 'abort';
    case 'legacy_ivr': return 'route_legacy_ivr';
    case 'agent_only': return 'handoff_agent';
    case 'degraded_ai':
    case 'normal':
      return conversational === 'none' ? 'continue_ai' : conversational;
  }
}
