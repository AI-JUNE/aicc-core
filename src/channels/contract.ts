// 채널 어댑터 계약 — Callbot(voice)·Chatbot(chat)·D-ARS(visual)가 Core를 소비하는 공용 인터페이스.
// 설계서 §1.2(Core 단일화)·§5.3(하나의 Flow, 채널 렌더러)·§6.2(엔진 비종속)·§11.1(테넌트 격리)·§10.3(마스킹).
//
// 왜 계약을 따로 두는가:
// 채널 저장소 3개가 각자 Core를 "적당히" 호출하기 시작하면, 6개월 뒤 시나리오가 다시 세 벌이 된다(§2).
// 그래서 채널이 Core에게 줄 것(입력·사용량·헬스)과 Core가 채널에게 시킬 것(렌더·이관·종료)을
// 여기서 한 번만 정의한다. 채널 저장소는 이 인터페이스만 구현하고, Core 내부 타입을 직접 만지지 않는다.
//
// 이 파일에는 전송·프로토콜 코드가 없다. 실제 회선·웹소켓 연결은 승인 후 각 저장소에서 붙인다 — [승인 필요].
import type { HandoffPlacement } from '../routing/executeHandoff.ts';
import type { ChannelKind } from '../domain/types.ts';
import type { RenderedStep, Flow } from '../flow/types.ts';
import type { FlowInput, FlowState, RunStatus } from '../flow/runner.ts';
import type { EntryPoint, LatencyMs, UsageMetrics, InteractionEvent } from '../events/schema.ts';
import type { TenantScope } from '../core/tenancy.ts';
import type { SwitchTicket } from '../core/executeSwitch.ts';
import type { DisclosurePlacement } from '../portal/aiDisclosure.ts';
import type { ComponentId, HealthSample, FallbackDecision } from '../ops/fallback.ts';
import type { TurnBillingNote } from '../billing/turnUsage.ts';
import type { ConsentPurpose } from '../consent/consent.ts';
import type { ComplianceTurnNote } from '../qa/executeCompliance.ts';

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
  /**
   * 합류 자격 토큰(§5.2·§10.3). Core 에 채널 전환이 배선된 경우 **필수**다 —
   * id 만으로 합류를 허용하면 링크 URL·프록시 로그·상담 메모에 남는 Interaction id 가 곧
   * 진행 중인 세션의 열쇠가 되고, 이미 수집된 슬롯이 그려진 화면이 남에게 열린다.
   * 값은 `port.invite` 로 받은 티켓의 `token` 을 그대로 넘긴다(채널이 만들지 않는다).
   */
  joinToken?: string;
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
  /**
   * 이관 정보. `placement` 는 Core 에 라우팅이 배선된 경우에만 실린다(§2).
   * `placement.placement !== 'queued'` 면 **큐에 사람이 들어가지 않았다** — 채널은
   * `action`(콜백·음성사서함·기존 IVR)을 수행해야 하며, 상담사 연결 안내를 해서는 안 된다(§9.3).
   */
  handoff?: { queue?: string; summaryMasked?: string; placement?: HandoffPlacement };
  /**
   * 이번 턴에 AI 고지를 냈다는 사실(§10.1). 고지 문구 자체는 `steps` 맨 앞 단계에 실려 나간다 —
   * 여기 있는 것은 **감사 근거**(어느 매체에 어떤 버전으로 고지했는가)다. 호스트가 steps 를
   * 뒤져 찾아내게 두면 세 저장소가 각자 다르게 찾는다(§2).
   * 고지가 배선되지 않았거나 이미 고지한 채널이면 실리지 않는다.
   */
  disclosure?: { channel: ChannelKind; placement: DisclosurePlacement; configVersion: number };
  /**
   * §11.2 과금 근거가 이번 호출에서 **어디까지 실렸는가**. 아무 선언도 없었으면 실리지 않는다.
   *
   * 채널이 반드시 읽어야 하는 값이다 — `usageAttached: false` 인 실측과 `billableMsRecorded: false`
   * 인 통화 구간은 §8.1 원장에 **없다**. 즉 그 호의 엔진 비용·통화 시간은 공급사 청구서에만 남고
   * 우리 집계에는 없으며, 그 차이는 몇 주 뒤 대사(reconcile)에서 '미설명'으로 돌아온다.
   */
  billing?: TurnBillingNote;
  /**
   * §10.1 동의. 동의가 배선되지 않았으면 실리지 않는다(종전과 완전히 같다).
   *
   * `recorded` 는 **이번 턴에 확정돼 추가 전용 이력에 쌓인 동의**다. 동의 질문 자체는 시나리오의
   * `Confirm` 단계로 이미 나갔으므로 여기 있는 것은 감사 근거(어느 목적을 어떤 정책 버전으로
   * 받았는가)다. 호스트가 슬롯을 뒤져 찾아내게 두면 세 저장소가 각자 다르게 찾는다(§2).
   *
   * `pendingRequired` 는 필수로 선언됐는데 지금 `granted` 가 아닌 목적이다. **Core 는 이 값으로
   * 막지 않는다** — 거부 분기는 시나리오(`onNo`)와 테넌트가 정한다. 다만 이 목록이 비어 있지
   * 않은 동안 pii 파라미터를 선언한 업무시스템 조회(§6.1)는 동의 게이트에서 막힌다.
   */
  consent?: {
    recorded?: { purpose: ConsentPurpose; state: 'granted' | 'denied'; policyVersion: number };
    /** 확정된 답이 있었는데 기록하지 못한 사유. 정상 생략(동의 턴이 아님·확정 전)에는 실리지 않는다. */
    notRecordedKo?: string;
    pendingRequired?: ConsentPurpose[];
  };
  /**
   * §7 5.2 준수 점검 결과. **세션이 끝난 호출에만** 실린다(점검은 세션 전체를 한꺼번에 본다) —
   * 점검이 배선되지 않았으면 실리지 않는다(종전과 완전히 같다).
   *
   * 여기 있는 것은 **위반 요약**이다: 근거 이벤트 id·검출 표현·금칙어 문구는 싣지 않는다 —
   * 이 값은 고객 접점 프로세스까지 나가고, 금칙어 목록은 운영·리뷰 화면의 자료다(§2·§10.3).
   * 전문(`QaReport`)이 필요한 쪽은 Core 배선의 `onReport` 로 받는다.
   *
   * `reviewed: false` 는 **위반 0건이 아니다** — 점검을 수행하지 못했다는 뜻이고 사유가 함께 실린다.
   * 같은 이유로 `skipped` 가 비어 있지 않은 규칙은 합격이 아니다.
   */
  compliance?: ComplianceTurnNote;
}

/**
 * 세션 종료 시 채널이 넘기는 과금 근거(§11.2). 전부 생략 가능하며, 생략하면 종전과 완전히 같다.
 *
 * 왜 종료 시점에만 받는가: 통화 과금 구간은 끊긴 뒤에야 확정된다. 그런데 `session.ended` 는
 * 추가 전용 이벤트라 **나중에 고쳐 넣을 수 없다** — 그래서 종료를 지시하는 그 호출에서 함께 받는다.
 * 받을 자리가 없던 동안 `billable_ms` 를 채우는 코드는 저장소에 0건이었고, 그 결과 모든 음성 세션이
 * `sessionsMissingBillableMs`(실측 누락)로 집계돼 **통화 요금의 근거가 아예 없었다**.
 */
export interface ChannelEndInput {
  /**
   * 과금 대상 구간(ms). 대기·호 설정 구간을 포함할지는 **계약 사항**이므로 채널이 계약대로 채운다 —
   * Core 는 세션 전체 길이(`duration_ms`)로 대체 추정하지 않는다(§13-3). 측정하지 못했으면 **넣지 않는다**:
   * 0 은 "0초 통화를 실측했다"는 뜻이고, 누락과 0 을 같게 적는 것이 정산 분쟁의 출발점이다.
   */
  billableMs?: number;
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
  /**
   * 다른 채널 초대(§5.2). crossChannelInvite=false 면 미구현.
   *
   * `ticket` 은 Core 에 채널 전환이 배선된 경우에만 실린다. **실리면 링크에는 그 토큰을 쓴다** —
   * `interactionId` 로 링크를 만들면 1회용·만료·회수가 전부 무의미해진다(다른 경로로 같은 문이 열린다).
   * 배선이 없으면 `ticket` 은 `undefined` 이며, 그 상태의 전환 링크는 **id 가 곧 열쇠**다(§10.3).
   * 모르는 인자를 받아도 던지지 않아야 한다 — 배선을 켜는 일은 코드 배포가 아니라 설정 변경이다.
   */
  invite?(interactionId: string, target: ChannelKind, ticket?: SwitchTicket): Promise<void>;
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
  /**
   * 고객이 끊음·이탈. Outcome 확정은 Core가 §4.1 규칙으로 판정한다.
   *
   * `input` 은 선택이며 §11.2 과금 근거를 함께 넘기는 자리다. 넘기지 않으면 종전과 완전히 같다 —
   * 다만 그 세션은 통화 분 집계에서 빠지고 `sessionsMissingBillableMs` 로만 남는다. 값이 실렸는지는
   * 결과의 `billing` 에 사실대로 적힌다(무효값은 종료를 막지 않는다 — 막으면 세션이 샌다).
   */
  end(interactionId: string, reasonKo: string, input?: ChannelEndInput): Promise<ChannelTurnResult>;
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
  | 'W_NO_FALLBACK_PATH'
  /** 재프롬프트 정책이 비어 있어 실패 시 원문이 그대로 재생된다(§5.1). 금지는 아니지만 운영이 알아야 한다. */
  | 'W_REPROMPT_POLICY'
  /** 턴 타이밍이 선언되지 않아 채널이 각자의 대기 시간을 쓴다(§5.1). */
  | 'W_TURN_TIMING'
  /**
   * 교차채널 초대를 할 수 있는 채널이 등록됐는데 전환 배선이 없다(§5.2·§10.3).
   * 이 상태의 합류는 **Interaction id 하나로 통과**하므로, 링크를 본 사람은 누구나
   * 진행 중인 상담 화면을 열 수 있다. 금지는 아니지만(종전 동작) 운영이 반드시 알아야 한다.
   */
  | 'W_CHANNEL_SWITCH_UNBOUND'
  /** 고지 설정은 실렸으나 일부 채널 문구가 비어 있는 등, 막지는 않되 운영이 알아야 하는 상태(§10.1). */
  | 'W_AI_DISCLOSURE'
  /**
   * AI 고지가 배선되지 않았다(§10.1·§7 7.4). 이 상태에서는 **어떤 채널에서도 고지가 나가지 않는다** —
   * 통화는 정상으로 끝나고 이벤트도 정상이라 어디서도 터지지 않는다. 종전 동작이므로 막지는 않되
   * 조용히 두지도 않는다: 드러나는 시점이 감독기관 점검이면 이미 지나간 통화 전부가 대상이다.
   */
  | 'W_AI_DISCLOSURE_UNBOUND'
  /**
   * 인텐트 진입 노드가 있는 시나리오를 인텐트 배선 없이 시작했다(§5.1·§5.3).
   * 이 상태에서 고객의 답은 인텐트가 아니라 **슬롯 값**으로 저장된 채 흐름이 진행된다 —
   * 예외도 재프롬프트도 없어 "봇이 엉뚱한 안내를 한다"로만 나타난다.
   */
  | 'W_INTENT_UNBOUND'
  /**
   * 지식 응대 진입 노드가 있는 시나리오를 지식 배선 없이 시작했다(§5.2).
   * 이 상태에서 고객의 질문은 답변 대신 **슬롯 값**으로 저장되고 흐름은 그대로 넘어간다 —
   * 즉 **아무도 답하지 않는다**. 예외도 재프롬프트도 없어 "FAQ 가 안 되는 것 같다"로만 나타난다.
   */
  | 'W_KNOWLEDGE_UNBOUND'
  /**
   * 라우트가 없는 활성 인텐트가 있거나, 통화 중 확정된 인텐트에 연결된 시나리오가 없었다(§5.3).
   * 막지는 않되(이관으로 살린다) 드러낸다 — 설정 누락은 "봇이 못 알아듣더라"와 구분되어야 한다.
   */
  | 'W_INTENT_ROUTING'
  /**
   * 시나리오 조회에 채널별 배포본 경로가 없다(§5.3). 이 상태에서는 버전 선택이 **stage 와
   * 무관하게 가장 높은 번호**로 이루어지므로, 스튜디오 편집본(draft)이 저장되는 순간 신규
   * 통화에 나갈 수 있고 승인·검증 게이트와 채널별 롤백이 런타임에 닿지 않는다.
   * 종전 동작이므로 막지는 않되, 배포를 Core 밖에서 관리한다는 사실의 기록으로 남긴다.
   */
  | 'W_FLOW_DEPLOYMENT_UNBOUND'
  /**
   * 라우트가 가리키는 시나리오가 특정 채널에 배포되지 않았거나(단계적 배포 중일 수 있다),
   * 채널이 배포본이 아닌 지정 버전으로 실행했거나, 배포 기록과 리비전 단계가 어긋났다(§5.3).
   * 전부 막지 않는 상태이지만 **아무도 모르는 채로 돌아가서는 안 되는** 상태다.
   */
  | 'W_FLOW_NOT_DEPLOYED'
  /**
   * §10.1 동의가 배선되지 않았다. 이 상태에서 일어나는 일은 두 방향 모두 조용하다:
   * 시나리오가 동의를 **묻고 있어도** 고객의 "네"는 `Confirm` 슬롯 값으로만 남아 **동의 기록은
   * 0건**이고(점검·분쟁에서 필요한 것은 목적·버전·시각이 적힌 기록이다), 개인정보 파라미터를
   * 선언한 업무시스템 조회(§6.1)는 동의 컨텍스트가 없어 **통화 중 언제나 막힌다**(업무시스템은
   * 멀쩡하므로 장애로 보이지 않고 "그 메뉴만 안 된다"로 나타난다).
   * 종전 동작이므로 막지는 않되 조용히 두지도 않는다.
   */
  | 'W_CONSENT_UNBOUND'
  /**
   * 동의는 배선됐으나 어긋난 것이 있다(필수 목적을 묻는 노드가 시나리오에 없는 등, §10.1).
   * 막지는 않되 운영이 반드시 보아야 한다 — 그 상태에서는 필수 동의가 영원히 미획득이다.
   */
  | 'W_CONSENT'
  /**
   * §7 5.2 준수 점검이 배선되지 않았다. 이 상태에서는 **어떤 세션도 점검되지 않는다** —
   * 고지 누락(§10.1)·금칙 표현·마스킹 누락(§10.3)이 한 건도 집계되지 않는데, 리포트가
   * 비는 것이 아니라 **리포트 자체가 없어서** "점검이 돌고 있다"와 구분되지 않는다.
   * 종전 동작이므로 막지는 않되 조용히 두지도 않는다: 드러나는 시점이 감독기관 점검이면
   * 이미 지나간 통화 전부가 대상이다.
   */
  | 'W_QA_UNBOUND'
  /**
   * 점검은 배선됐으나 어긋난 것이 있다(고지 표식·금칙어 미등록, 적용되지 않는 규칙 등).
   * 막지는 않되 운영이 반드시 보아야 한다 — 그 항목은 합격이 아니라 **점검되지 않는다**.
   */
  | 'W_QA';

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
