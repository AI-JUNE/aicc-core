// 채널 어댑터 계약 — Callbot(voice)·Chatbot(chat)·D-ARS(visual)가 Core를 소비하는 공용 인터페이스.
// 설계서 §1.2(Core 단일화)·§5.3(하나의 Flow, 채널 렌더러)·§6.2(엔진 비종속)·§11.1(테넌트 격리)·§10.3(마스킹).
//
// 왜 계약을 따로 두는가:
// 채널 저장소 3개가 각자 Core를 "적당히" 호출하기 시작하면, 6개월 뒤 시나리오가 다시 세 벌이 된다(§2).
// 그래서 채널이 Core에게 줄 것(입력·사용량·헬스)과 Core가 채널에게 시킬 것(렌더·이관·종료)을
// 여기서 한 번만 정의한다. 채널 저장소는 이 인터페이스만 구현하고, Core 내부 타입을 직접 만지지 않는다.
//
// 이 파일에는 전송·프로토콜 코드가 없다. 실제 회선·웹소켓 연결은 승인 후 각 저장소에서 붙인다 — [승인 필요].
import type { ChannelKind } from '../domain/types.ts';
import type { RenderedStep, Flow } from '../flow/types.ts';
import type { FlowInput, FlowState, RunStatus } from '../flow/runner.ts';
import type { EntryPoint, LatencyMs, UsageMetrics, InteractionEvent } from '../events/schema.ts';
import type { TenantScope } from '../core/tenancy.ts';
import type { ComponentId, HealthSample, FallbackDecision } from '../ops/fallback.ts';

export const CHANNEL_CONTRACT_VERSION = 1;

/** 채널 구현체 식별. 저장소 3개가 이 값으로 자기를 밝힌다. */
export type ChannelAdapterId = 'callbot' | 'chatbot' | 'dars';

export const ADAPTER_CHANNEL: Record<ChannelAdapterId, ChannelKind> = {
  callbot: 'voice',
  chatbot: 'chat',
  dars: 'visual',
};

/** 세션 시작 시 채널이 Core에 넘기는 최소 정보. 개인정보(발신번호 등)는 여기서 다루지 않는다(§10.3). */
export interface ChannelSessionRequest {
  scope: TenantScope;                 // §11.1 — 스코프 없는 진입 경로를 만들지 않는다
  adapter: ChannelAdapterId;
  entryPoint: EntryPoint;
  flowId: string;
  flowVersion?: number;
  /** 채널이 이미 알고 있는 슬롯(예: 인증 완료된 회원 등급). 값은 마스킹 대상이면 마스킹 후 넣는다. */
  presetSlots?: Record<string, string>;
  /**
   * 기존 Interaction 합류 — 통화 중 Visual IVR 링크를 열 때 D-ARS가 이 값을 넘긴다(§5.2).
   * 지정되면 새 세션을 만들지 않고 같은 Interaction에 채널을 붙인다.
   */
  joinInteractionId?: string;
  /** 상관관계 추적용 채널측 식별자(호 ID·대화 ID). 개인정보를 넣지 않는다. */
  correlationId?: string;
}

/** 채널이 Core에 올리는 사용자 입력. 원문은 Core 진입 시점에 마스킹된다(§10.3). */
export interface ChannelTurnInput {
  input: FlowInput;
  /** 실측 지연. 채널·엔진이 측정한 값만 넣는다 — 기본값 금지(§13-3). */
  latency?: LatencyMs;
  /** §11.2 과금 근거. 엔진 단위 차이는 어댑터가 환산해 채운다(§6.2). */
  usage?: UsageMetrics;
  /** 인식 신뢰도(음성·채팅 NLU). 없으면 폴백 판정에서 신뢰도 조건을 건너뛴다. */
  confidence?: number;
}

/** Core가 채널에게 돌려주는 실행 결과. 채널은 steps를 자기 표현으로 바꿔 내보내기만 한다(§5.3). */
export interface ChannelTurnResult {
  interactionId: string;
  state: FlowState;
  steps: RenderedStep[];
  status: RunStatus;
  /** 이번 턴에 발생한 §8.1 이벤트. 채널이 만들지 않는다 — Core가 만들고 채널은 전송만 돕는다. */
  events: InteractionEvent[];
  /** §9.3 판정. 채널은 이 값에 따라 회선을 내리거나 상담사로 넘긴다. */
  fallback?: FallbackDecision;
  handoff?: { queue?: string; summaryMasked?: string };
}

/**
 * Core가 채널에게 요구하는 능력. 채널마다 되는 게 다르므로 선언하게 한다.
 * Flow 검증기(§5.3)가 이 값으로 "이 시나리오를 이 채널에서 돌릴 수 있는가"를 사전 판정한다.
 */
export interface ChannelCapabilities {
  adapter: ChannelAdapterId;
  channel: ChannelKind;
  /** DTMF 입력 수용(음성 전용, §5.1 소음·고령 고객 폴백) */
  dtmf: boolean;
  /** 버튼·폼 등 화면 UI 렌더 */
  richUi: boolean;
  /** 음성 합성 출력 */
  speech: boolean;
  /** 상담사 이관 실행 가능 여부 */
  transferToAgent: boolean;
  /** 기존 IVR로 되돌릴 수 있는가(§9.3) */
  routeToLegacyIvr: boolean;
  /** 통화 중 다른 채널로 링크를 보낼 수 있는가(§5.2 voice→visual 전환) */
  crossChannelInvite: boolean;
}

/** 채널이 Core에 제공해야 하는 헬스 신호(§9.3). Core는 엔진을 직접 찌르지 않는다(§6.2). */
export interface ChannelHealthReport {
  adapter: ChannelAdapterId;
  samples: HealthSample[];
  observedAt: string;
}

/**
 * 채널 저장소가 구현하는 아웃바운드 포트 — Core가 채널에게 시키는 일.
 * 반환값은 "지시를 접수했다"까지만 뜻한다. 실제 매체 동작 결과는 헬스·이벤트로 돌아온다.
 */
export interface ChannelPort {
  readonly id: ChannelAdapterId;
  readonly capabilities: ChannelCapabilities;
  /** 렌더된 단계를 고객에게 내보낸다. */
  present(interactionId: string, steps: RenderedStep[]): Promise<void>;
  /** 상담사 이관. 요약은 이미 마스킹된 상태로 전달된다(§2·§10.3). */
  transfer(interactionId: string, queue: string | undefined, summaryMasked: string | undefined): Promise<void>;
  /** 기존 IVR 회귀(§9.3). routeToLegacyIvr=false 인 채널은 구현하지 않아도 된다. */
  routeToLegacyIvr?(interactionId: string, reasonKo: string): Promise<void>;
  /** 다른 채널 초대(§5.2). crossChannelInvite=false 면 미구현. */
  invite?(interactionId: string, target: ChannelKind): Promise<void>;
  end(interactionId: string, reasonKo: string): Promise<void>;
}

/**
 * Core가 채널에게 제공하는 인바운드 포트 — 채널이 Core에게 시키는 일.
 * 채널 저장소는 이 인터페이스 외의 Core 함수를 직접 호출하지 않는다. 그래야 Core 리팩터링이
 * 채널 3개를 동시에 깨뜨리지 않는다.
 */
export interface ConversationCorePort {
  readonly contractVersion: number;
  start(req: ChannelSessionRequest): Promise<ChannelTurnResult>;
  send(interactionId: string, turn: ChannelTurnInput): Promise<ChannelTurnResult>;
  /** 고객이 끊음·이탈. Outcome 확정은 Core가 §4.1 규칙으로 판정한다. */
  end(interactionId: string, reasonKo: string): Promise<ChannelTurnResult>;
  /** 헬스 보고 — 채널이 주기적으로 올린다(§9.3). */
  reportHealth(report: ChannelHealthReport): void;
}

/** 채널이 Core에 등록될 때 넘기는 묶음. Core는 이 값만 보고 채널을 다룬다. */
export interface ChannelRegistration {
  port: ChannelPort;
  /** 이 채널이 신호를 올리는 컴포넌트 목록(§9.3). 선언하지 않은 컴포넌트의 샘플은 무시한다. */
  reportsComponents: ComponentId[];
  contractVersion: number;
}

export type ContractIssueCode =
  | 'E_VERSION_MISMATCH'
  | 'E_CHANNEL_MISMATCH'
  | 'E_MISSING_CAPABILITY_IMPL'
  | 'E_UNDECLARED_COMPONENT'
  | 'W_NO_FALLBACK_PATH';

export interface ContractIssue {
  code: ContractIssueCode;
  severity: 'error' | 'warning';
  messageKo: string;
}

/**
 * 등록 시점 계약 검증. 런타임에 "그 함수 없는데요"로 죽는 대신 여기서 막는다.
 * 폴백 경로가 하나도 없는 채널은 경고로 남긴다 — 금지는 아니지만 §9.3 관점에서 위험 신호다.
 */
export function validateRegistration(reg: ChannelRegistration): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const { port } = reg;

  if (reg.contractVersion !== CHANNEL_CONTRACT_VERSION) {
    issues.push({
      code: 'E_VERSION_MISMATCH',
      severity: 'error',
      messageKo: `채널 계약 버전 불일치: 채널 ${reg.contractVersion} ≠ Core ${CHANNEL_CONTRACT_VERSION}.`,
    });
  }
  if (port.capabilities.adapter !== port.id) {
    issues.push({ code: 'E_CHANNEL_MISMATCH', severity: 'error', messageKo: `capabilities.adapter(${port.capabilities.adapter})가 포트 id(${port.id})와 다릅니다.` });
  }
  if (port.capabilities.channel !== ADAPTER_CHANNEL[port.id]) {
    issues.push({ code: 'E_CHANNEL_MISMATCH', severity: 'error', messageKo: `${port.id} 어댑터의 채널은 ${ADAPTER_CHANNEL[port.id]} 여야 합니다.` });
  }
  if (port.capabilities.routeToLegacyIvr && typeof port.routeToLegacyIvr !== 'function') {
    issues.push({ code: 'E_MISSING_CAPABILITY_IMPL', severity: 'error', messageKo: 'routeToLegacyIvr 능력을 선언했으나 구현이 없습니다(§9.3).' });
  }
  if (port.capabilities.crossChannelInvite && typeof port.invite !== 'function') {
    issues.push({ code: 'E_MISSING_CAPABILITY_IMPL', severity: 'error', messageKo: 'crossChannelInvite 능력을 선언했으나 invite 구현이 없습니다(§5.2).' });
  }
  const known = new Set<ComponentId>(['telephony', 'messaging', 'stt', 'tts', 'llm', 'rag', 'backend']);
  for (const c of reg.reportsComponents) {
    if (!known.has(c)) {
      issues.push({ code: 'E_UNDECLARED_COMPONENT', severity: 'error', messageKo: `알 수 없는 헬스 컴포넌트: ${String(c)}` });
    }
  }
  if (!port.capabilities.transferToAgent && !port.capabilities.routeToLegacyIvr) {
    issues.push({ code: 'W_NO_FALLBACK_PATH', severity: 'warning', messageKo: '상담사 이관·기존 IVR 회귀가 모두 불가한 채널입니다. AI 장애 시 고객이 갈 곳이 없습니다(§9.3).' });
  }
  return issues;
}

/**
 * Flow가 이 채널에서 실행 가능한지 사전 판정(§5.3).
 * "하나의 Flow를 렌더러만 바꿔 실행한다"는 약속은, 렌더 불가 노드를 배포 전에 걸러야만 지켜진다.
 */
export function checkFlowSupported(flow: Flow, caps: ChannelCapabilities): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const node of Object.values(flow.nodes)) {
    if (node.kind === 'Transfer' && !caps.transferToAgent) {
      issues.push({ code: 'E_MISSING_CAPABILITY_IMPL', severity: 'error', messageKo: `Transfer 노드(${node.id})가 있으나 ${caps.adapter} 채널은 상담사 이관을 지원하지 않습니다.` });
    }
    if (node.kind === 'Choice' && !caps.richUi && !caps.dtmf) {
      issues.push({ code: 'E_MISSING_CAPABILITY_IMPL', severity: 'error', messageKo: `Choice 노드(${node.id})를 렌더할 입력 수단이 없습니다(버튼·DTMF 모두 불가).` });
    }
  }
  return issues;
}

/** 등록 가능 여부 — error 0건일 때만 채널을 붙인다. */
export function registrationOk(issues: ContractIssue[]): boolean {
  return issues.every((i) => i.severity !== 'error');
}
