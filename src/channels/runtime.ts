// Conversation Core 런타임 — 채널 계약(§ channels/contract.ts)의 **Core 측 실구현**.
// 설계서 §1.2(Core 단일화)·§5.1(대화 폴백)·§5.2(채널 전환)·§5.3(단일 시나리오)·§8.1(이벤트)·
// §9.3(장애 폴백)·§10.3(마스킹)·§11.1(테넌트 격리)·§11.2(과금 근거).
//
// 지금까지 contract.ts 는 "이렇게 부르기로 한다"는 선언만 있었고, 실제로 그 계약을 이행하는
// 구현체가 없었다. 그러면 Callbot·챗봇·D-ARS 세 저장소가 각자 FlowRunner·이벤트·폴백을
// 조립하게 되고, 조립 방식이 세 벌로 갈라진다 — §2가 지적한 시나리오 이중 관리와 같은 실패다.
// 이 파일이 그 조립을 한 번만 한다. 채널은 ConversationCorePort 만 호출한다.
//
// 하지 않는 것: 실회선·실엔진·실발신. 매체 동작은 전부 ChannelPort 구현(각 채널 저장소)이 맡고,
// 여기서는 "무엇을 시킬지"만 정한다 — [승인 필요] 지점은 채널 저장소 쪽에 있다.
import type { ChannelKind, Handoff, Interaction, Turn } from '../domain/types.ts';
import { resolveOutcome } from '../domain/types.ts';
import type { Flow, RenderedStep } from '../flow/types.ts';
import { isIntentEntryNode, isKnowledgeEntryNode, renderNode } from '../flow/types.ts';
import type { FlowResolution } from '../flow/deployedFlows.ts';
import type { FlowInput, FlowState, IntentTurnInput, RunResult, RunStatus, RunnerContext } from '../flow/runner.ts';
import {
  start as runnerStart, send as runnerSend,
  clarifyTurn, handoffFromIntent, knowledgeTurn, switchFlow,
} from '../flow/runner.ts';
import type { RepromptPolicy } from '../flow/reprompt.ts';
import { repromptPolicyOk, validateRepromptPolicy } from '../flow/reprompt.ts';
import type { TurnTimingPolicy } from '../flow/timing.ts';
import { turnTimingPolicyOk, validateTurnTimingPolicy } from '../flow/timing.ts';
import type { TenantScope, TenantVectorStore } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { DataClass, RetentionPolicy } from '../core/retention.ts';
import { canStore } from '../core/retention.ts';
import type { EventMeta, InteractionEvent, LatencyMs, TurnCompletedEvent, HandoffRequestedEvent, UsageMetrics } from '../events/schema.ts';
import { measuredDurationMs, sessionStarted, sessionEnded, handoffRequested, turnCompleted } from '../events/schema.ts';
import type { EventBus, PublishResult } from '../events/bus.ts';
import type { ComponentId, FallbackDecision, FallbackPolicy, HealthRegistry, HealthSample } from '../ops/fallback.ts';
import { decideFallbackMode, mediaDisabledBy } from '../ops/fallback.ts';
import type { BuildInfo, DependencyProbe, Scheduler } from '../ops/health.ts';
import type { CoreReadinessReport } from '../ops/executeHealth.ts';
import { runReadiness } from '../ops/executeHealth.ts';
import type { ProbeSchedule, RecoveryProbeRunner, RecoveryRunReport } from '../ops/recoveryProbe.ts';
import { createRecoveryProbeRunner } from '../ops/recoveryProbe.ts';
import type { SummaryOptions } from '../core/handoffSummary.ts';
import { buildHandoffSummary, requiredSlotsOf } from '../core/handoffSummary.ts';
import type { AdmissionOptions, AssignmentOffer, OfferEvent, QueueSnapshot, RoutingConfig } from '../routing/agentQueue.ts';
import { reachableQueues, validateRoutingConfig } from '../routing/agentQueue.ts';
import type { HandoffPlacement } from '../routing/executeHandoff.ts';
import { executeHandoff } from '../routing/executeHandoff.ts';
import type { OfferLedger, OfferPolicy, OfferStep } from '../routing/executeOffer.ts';
import {
  emptyOfferLedger, expiredOffers, offerPolicyIssues, openOffer, openOfferOf, settleOffer,
} from '../routing/executeOffer.ts';
import type { InviteDeliveryKind, InviteRegistry, SlotCarryPolicy, SwitchReason, SwitchTargetChannel } from '../core/channelSwitch.ts';
import { issueSwitch, redeemSwitch } from '../core/executeSwitch.ts';
import type { AiDisclosureConfig } from '../portal/aiDisclosure.ts';
import { DISCLOSURE_NODE_ID, planDisclosure, validateDisclosureBinding } from '../core/executeDisclosure.ts';
import type { ConnectorPumpBinding } from '../integration/connectorPump.ts';
import { connectorHopLimit, hopLimitInput, missingConnectors, pumpConnectorHop } from '../integration/connectorPump.ts';
import { requiresConsent } from '../integration/connector.ts';
import type { IntentCatalog, IntentPolicy } from '../nlu/intent.ts';
import { validateIntentCatalog, validateIntentPolicy } from '../nlu/intent.ts';
import type { FlowLookup, IntentRoutingTable } from '../nlu/intentRouting.ts';
import { intentRoutingOk, validateIntentRouting } from '../nlu/intentRouting.ts';
import type { ClassifyStatus, IntentClassifier } from '../nlu/llmClassifier.ts';
import type { Embedder } from '../knowledge/embedding.ts';
import type { EngineRuntime, EngineStartupDeclaration } from '../adapters/executeEngines.ts';
import { startEngines } from '../adapters/executeEngines.ts';
import type { PendingClarify } from '../nlu/executeIntentEntry.ts';
import { resolveIntentEntry } from '../nlu/executeIntentEntry.ts';
import type { RetrievalPolicy } from '../knowledge/rag.ts';
import { assertRetrievalPolicy } from '../knowledge/rag.ts';
import type { Answerer } from '../knowledge/answer.ts';
import type { Retriever } from '../knowledge/retrieval.ts';
import { createRetriever } from '../knowledge/retrieval.ts';
import type { KnowledgeFailureCause, KnowledgeUsage } from '../knowledge/executeKnowledge.ts';
import { resolveKnowledgeTurn } from '../knowledge/executeKnowledge.ts';
import type { ConsentPolicy, ConsentPurpose, ConsentRecord } from '../consent/consent.ts';
import type { AcceptanceRecord, LegalDocument } from '../legal/documents.ts';
import type { LegalNoticeContext } from '../legal/executeLegal.ts';
import { checkConsentNotices } from '../legal/executeLegal.ts';
import type { ConsentStore } from '../consent/executeConsent.ts';
import {
  buildConsentLookup, consentNodeDefects, consentNodes, consentPurposeOf, isConsentNode,
  pendingRequiredConsents, planConsentTurn, validateConsentBinding,
} from '../consent/executeConsent.ts';
import type { TurnBillingNote, UsageContribution } from '../billing/turnUsage.ts';
import { attachTurnUsage, billingNoteOrUndefined, checkBillableMs, mergeTurnUsage, usageNote } from '../billing/turnUsage.ts';
import type { CoreOp, ObservabilityBinding, ObservedCall, Observer, ObserverStats } from '../obs/executeObservability.ts';
import { createObserver, isKnownAdapter } from '../obs/executeObservability.ts';
import type { RateLimiter } from '../api/rateLimit.ts';
import { enforceRateLimit, rateLimitKey } from '../api/rateLimit.ts';
import type { ForbiddenPhraseRule, QaReport, QaRuleSet } from '../qa/compliance.ts';
import type { ComplianceBuffer, ComplianceTurnNote } from '../qa/executeCompliance.ts';
import {
  appendForReview, buildQaRuleSet, newComplianceBuffer, reviewCompliance, validateComplianceBinding,
} from '../qa/executeCompliance.ts';
import type {
  ChannelAdapterId, ChannelEndInput, ChannelHealthReport, ChannelRegistration, ChannelSessionRequest,
  ChannelTurnInput, ChannelTurnResult, ConversationCorePort, ContractIssue, ChannelCapabilities,
} from './contract.ts';
import { ADAPTER_CHANNEL, CHANNEL_CONTRACT_VERSION, checkFlowSupported, registrationOk, validateRegistration } from './contract.ts';

/**
 * 시나리오 조회(§5.3).
 *
 * `forChannel` 이 있으면 **실행 경로는 그것만 쓴다** — 배포 단위가 "(Flow, 채널)"이므로
 * 채널을 모르는 조회로는 "지금 무엇이 돌고 있는가"에 답할 수 없다. `aicc-core/internal/flow/
 * deployedFlows` 의 `createDeployedFlowRegistry` 가 그 구현이다.
 *
 * `get` 만 있는 구현(아래 `createMemoryFlowRegistry` 포함)도 **종전과 완전히 같이** 동작한다 —
 * 다만 그 경로는 stage 를 보지 않으므로 편집본(draft)이 번호만 높으면 그대로 운영에 나가고,
 * 채널별 배포·롤백이 런타임에 닿지 않는다. 그 사실은 등록 시 `W_FLOW_DEPLOYMENT_UNBOUND`
 * 경고로 남긴다(§13-3 — 막지는 않되 조용히 두지도 않는다).
 */
export interface FlowRegistry {
  get(flowId: string, version?: number): Flow | undefined;
  /** 채널별 배포본. 있으면 세션 시작·인텐트 라우팅이 모두 이 경로를 쓴다. */
  forChannel?(flowId: string, channel: ChannelKind, version?: number): Flow | undefined;
  /**
   * 조회 실패 사유. 없으면 런타임은 "찾을 수 없습니다"로만 적는데, 그러면 **미배포와 오타가
   * 같은 문장으로 남는다** — 운영자는 오타를 찾으러 가고 원인은 미배포다.
   */
  explain?(flowId: string, channel: ChannelKind, version?: number): FlowResolution;
}

/**
 * 단일 프로세스·고정 시나리오용 조회. 같은 flowId 의 리비전이 여럿이면 **가장 높은 번호**를
 * 돌려주며 **stage 를 보지 않는다** — 배포 수명주기(§5.3)를 Core 밖에서 관리하는 호스트용이다.
 * 스튜디오 편집·승인·채널별 배포를 Core 가 관리해야 하면 `createDeployedFlowRegistry` 를 쓴다.
 */
export function createMemoryFlowRegistry(flows: Flow[]): FlowRegistry {
  const byId = new Map<string, Flow[]>();
  for (const f of flows) {
    const list = byId.get(f.id) ?? [];
    list.push(f);
    byId.set(f.id, list);
  }
  return {
    get(flowId, version) {
      const list = byId.get(flowId);
      if (!list || list.length === 0) return undefined;
      if (version !== undefined) return list.find((f) => f.version === version);
      return list.reduce((a, b) => (b.version > a.version ? b : a));
    },
  };
}

export interface SessionRecord {
  interactionId: string;
  adapter: ChannelAdapterId;
  scope: TenantScope;
  flow: Flow;
  state: FlowState;
  startedAt: string;
  channels: ChannelKind[];
  /** 마스킹을 통과한 턴만 보관한다(§10.3). 이관 요약의 원천이다(§2). */
  turns: Turn[];
  correlationId?: string;
  ended: boolean;
  lastResult: ChannelTurnResult;
  /**
   * 진행 중인 Api 대기 건의 호출 회차(§6.1). **논리적 호출 1건 = 멱등 키 1개**이므로 세션에 남긴다 —
   * 펌프가 부를 때마다 회차를 올리면 키가 매번 달라져 command 커넥터에서 이중 신청이 되고,
   * 장애 로그에는 성공 두 건만 남는다. 커넥터가 결과를 내면 지워지고, 시나리오가 onError 를 지나
   * 같은 Api 노드를 **다시 밟았을 때만** 회차가 올라간다(그때는 정말로 새 호출이다).
   */
  connectorCall?: { connectorId: string; call: number };
  /** 커넥터별 누적 호출 회차. 멱등 키가 논리적 호출 단위로 갈리게 한다. */
  connectorCalls?: Record<string, number>;
  /** 펌프 실행 중 표시. 같은 대기 건에 두 번 들어와 업무시스템을 두 번 부르는 것을 막는다. */
  connectorInFlight?: boolean;
  /**
   * 이 세션에서 AI 고지를 마친 채널(§10.1). 매 턴 다시 고지하면 안내가 잡음이 되고,
   * 채널이 바뀌면(§5.2) 새 매체에서는 아직 고지하지 않은 것이므로 채널 단위로 센다.
   */
  disclosedChannels?: ChannelKind[];
  /**
   * 인텐트 진입 노드(§5.1)의 진행 상태. `options` 가 비어 있으면 **되묻는 중이 아니다** —
   * 시도 횟수만 이어받는다. 미인식으로 사다리를 한 칸 내려갔다고 명확화 한도가 0 으로
   * 되돌아가면, 테넌트가 정한 `maxClarifyAttempts` 를 넘겨 같은 질문을 계속 되묻게 된다.
   */
  intentClarify?: PendingClarify;
  /**
   * §7 5.2 준수 점검용 이벤트 수집함. **점검이 배선된 경우에만 만들어진다** — 미배선이면
   * 종전과 완전히 같다(수집 비용도 0이다, §13-3). 담기는 것은 §8.1 이벤트 그대로이며
   * 전부 마스킹을 통과한 값이다(§10.3).
   */
  qa?: ComplianceBuffer;
  /**
   * 이 세션의 이관 요약(§2·§10.3 — **이미 마스킹된 값**). 오퍼가 소진돼 §9.3 대안으로
   * 수렴할 때 같이 넘긴다. 왜 남겨 두는가: 소진은 이관 턴이 아니라 **몇 분 뒤** 상담사의
   * 거절·무응답으로 일어나고, 그 시점에는 턴 문맥이 없다. 여기에 없으면 콜백·음성사서함으로
   * 간 건만 요약이 비어, §2 가 말한 "아까 다 말했는데요"가 **가장 오래 기다린 고객에게만**
   * 재현된다. 다시 만들지 않고(두 번 만들면 두 요약이 갈린다) 다시 마스킹하지도 않는다.
   */
  handoffSummaryMasked?: string;
}

/** 세션 저장소. 인메모리는 단일 프로세스용 — 영속 구현은 이 인터페이스 뒤로 교체한다(§6.2). */
export interface SessionStore {
  get(interactionId: string): SessionRecord | undefined;
  put(record: SessionRecord): void;
  remove(interactionId: string): void;
  ids(): string[];
}

export function createMemorySessionStore(): SessionStore {
  const map = new Map<string, SessionRecord>();
  return {
    get: (id) => map.get(id),
    put: (r) => { map.set(r.interactionId, r); },
    remove: (id) => { map.delete(id); },
    ids: () => [...map.keys()],
  };
}

/**
 * 보존 정책 배선(§8.2). `core/retention.ts` 의 `canStore` 는 "저장해도 되는가"를 묻는 자리를
 * 열어 두었지만, **그 자리를 부르는 코드가 저장소 어디에도 없었다** — 그래서 Core 는 보존기간이
 * 정해지지 않은 테넌트에서도 세션(슬롯 원문·마스킹된 전문)과 이벤트·동의 기록을 그대로 쌓았다.
 *
 * 이 미배선의 증상은 예외가 아니라 **되돌릴 수 없음**이다. 한 번 쌓인 건의 기산 시점은 나중에
 * 기한을 정해도 되돌릴 수 없고, 규칙이 없는 동안 `decide` 는 그 건을 영원히 `blocked` 로 적는다 —
 * 파기 스윕(§8.2)은 매번 "지울 수 없는 건"만 세고, 그 사이 개인정보는 계속 남는다. 통화·이벤트·
 * 적합성 검사·헬스는 전부 정상이라 드러나는 시점은 대개 감독기관 점검이고, 그때 대상은
 * **지나간 통화 전부**다.
 *
 * **주지 않으면 종전과 완전히 같다**(§13-3) — 아무것도 묻지 않고, 그 사실이
 * `W_RETENTION_UNBOUND` 경고로 남는다.
 *
 * 묻는 시점은 **생성 시점 한 번**이다. 통화 중에 물으면 거절이 곧 무음이 되고(고객은 아무 안내
 * 없이 끊긴 회선을 붙잡는다), 분류 집합은 세션마다 달라지지 않으므로 턴마다 물을 이유도 없다.
 * 설정 오류는 배포할 때 시끄럽게 드러나는 것이 맞다(라우팅·전환·동의 배선과 같은 규칙).
 *
 * **판정을 복사하지 않는다**(§2): 규칙 유무·승인·기한 산출 가능 여부는 `canStore` 하나가 본다 —
 * 검사가 이 파일에 `mayContainPii`·`retentionDays` 가 없음을 고정한다.
 */
export interface RetentionBinding {
  /** 테넌트 법적 검토로 확정된 보존 정책(§8.2). Core 는 기본값을 만들지 않는다(§13-3). */
  policy: RetentionPolicy;
  /**
   * 이 조립이 세션 슬롯에 개인정보를 담는가(§8.2 `pii_field`).
   *
   * Core 는 슬롯 이름만 보고 개인정보 여부를 알 수 없다 — `CollectNode` 에 분류 선언이 없고,
   * 추측해서 적으면 두 방향 모두 나쁘다(과하게 적으면 멀쩡한 테넌트의 기동이 막히고, 적게 적으면
   * 기한 없는 개인정보가 쌓인다). 그래서 선언을 받되 **기본값은 "담는다"** 다 — 여기서는
   * 빠뜨린 쪽이 안전한 방향으로 틀려야 한다(되돌릴 수 있는 쪽은 기동 거절이고, 되돌릴 수 없는
   * 쪽은 이미 쌓인 개인정보다).
   *
   * 개인정보를 한 건도 수집하지 않는 시나리오만 운영하는 테넌트는 `false` 로 선언한다.
   */
  collectsPii?: boolean;
}

/**
 * 상담사 큐 배정 연결(§2·§9.3). **주지 않으면 종전과 완전히 같다**(§13-3) —
 * 시나리오가 적어 둔 큐 id 를 그대로 `transfer` 에 넘긴다.
 *
 * 주면 Core 가 `routing/executeHandoff.ts` 로 목적지를 확정한다. 이 배선이 없으면
 * 큐 선택·수용 판정 모듈은 저장소에 있으나 **아무도 부르지 않는** 상태로 남고,
 * 채널 3곳이 각자 같은 20줄을 쓰게 된다(브리지 앞에 아무도 쓰지 않은 30줄을 남겼을 때와 같은 실패).
 */
export interface RoutingBinding {
  config: RoutingConfig;
  /**
   * 큐 실측 스냅샷. 호스트가 조회해 준다 — Core 는 대기 인원·상담사 수를 **추정하지 않는다**(§13-3).
   * 실패하면 던지지 말고 빈 배열을 주면 된다(그 큐는 "상태 미확인"으로 보수적으로 닫힌다).
   */
  snapshots(): Promise<readonly QueueSnapshot[]> | readonly QueueSnapshot[];
  admission?: AdmissionOptions;
  /**
   * 상담사 배정 오퍼(§2·§9.3). **주지 않으면 종전과 완전히 같다**(§13-3) — 큐에 놓는 데까지만
   * 하고 끝난다.
   *
   * 오퍼를 큐 배정 **안에** 둔 이유: 두 배선을 따로 두면 큐만 배선한 테넌트에서 고객이 큐에
   * 들어간 채 아무에게도 제안되지 않고, 그 상태는 운영 화면에서 "대기 중"과 구분되지 않는다.
   * 이 배선이 없는 동안 `routing/executeOffer.ts`(회차 계수·중복 오퍼 차단·소진 수렴)는
   * 저장소에 있으나 **아무도 부르지 않는** 상태로 남는다.
   *
   * **범위 밖을 적어 둔다**: §9.3 장애 폴백 이관(`fallbackQueue`)은 라우팅 설정을 지나지
   * 않으므로 — 폴백이 설정 결함과 함께 죽지 않게 한 결정이다 — 그 경로에서는 오퍼도 열리지
   * 않는다. 엔진이 죽어 상담사로 내려간 콜은 상담사 데스크톱·큐 시스템이 직접 본다.
   */
  offers?: AgentOfferBinding;
}

/**
 * 오퍼를 열기 직전에 호스트에게 묻는 것. **Core 가 상담사를 고르지 않는다**(§13-3) —
 * 스킬·숙련도·최근 통화 수 같은 배분 정책은 상담사 데스크톱·근태 시스템이 가진 정보다.
 */
export interface OfferCandidateRequest {
  interactionId: string;
  /** `executeHandoff` 가 확정한 **실제 목적지**(오버플로면 오버플로 큐). */
  queueId: string;
  /**
   * 세션을 찾을 수 있을 때만 싣는다 — **만들지 않는다**(§13-3). 재배정이 세션 종료·재기동
   * 뒤에 들어오면 Core 는 그 통화가 어느 매체였는지 알 방법이 없고, 아무 값이나 적으면
   * 호스트의 채널별 배분 정책이 **조용히 틀린 쪽으로** 고른다.
   */
  channel?: ChannelKind;
  /** 같은 이유로 선택이다(§13-3). */
  reason?: Handoff['reason'];
  /** 이번에 열리는 오퍼가 이 상호작용의 몇 번째인가 — **원장에서 센 값**이다(호스트가 세지 않는다). */
  attempt: number;
}

/**
 * 오퍼 원장 저장소. 인메모리는 단일 프로세스용이며 **재기동으로 사라진다** —
 * 그러면 열려 있던 오퍼가 전부 사라져 그 상담사들이 다시 후보가 되고, 같은 콜이 두 번
 * 제안될 수 있다. 영속 구현은 이 인터페이스 뒤로 교체한다(§6.2).
 */
export interface OfferLedgerStore {
  get(): OfferLedger;
  put(ledger: OfferLedger): void;
}

export function createMemoryOfferLedger(): OfferLedgerStore {
  let ledger = emptyOfferLedger();
  return { get: () => ledger, put: (next) => { ledger = next; } };
}

/** 오퍼 전이가 일어난 경로. 같은 `refused` 가 어디서 났는지 모르면 원인을 못 가른다. */
export type OfferStepVia = 'handoff' | 'settle' | 'expiry' | 'session_end';

export interface AgentOfferStep extends OfferStep {
  interactionId: string;
  via: OfferStepVia;
}

/**
 * 배정 오퍼 배선. **정책에 기본값이 없다**(§13-3) — 응답 한도 몇 초가 적당한지, 몇 명까지
 * 돌릴지는 회선·상품·상담사 수에 따라 다르다.
 */
export interface AgentOfferBinding {
  /** 형태가 틀리면 **생성 시점에 거부된다** — 통화 중에 만나면 모든 이관이 조용히 오퍼 없이 지나간다. */
  policy: OfferPolicy;
  /**
   * 제안 후보. 선언한 **순서 그대로** 쓴다(정렬을 넣는 순간 그것이 배분 정책이 된다, §13-3).
   * 실패하면 던져도 된다 — 이관은 이미 끝났으므로 통화를 깨지 않고 경고로 내린다.
   */
  candidates(req: OfferCandidateRequest): Promise<readonly string[]> | readonly string[];
  /** 오퍼 id 생성기. **Core 는 id 를 만들지 않는다** — 추측 가능한 id 는 그 자체가 열쇠다(§10.3). */
  newOfferId(req: OfferCandidateRequest): string;
  /** 원장. 주지 않으면 인메모리(단일 프로세스용). */
  ledger?: OfferLedgerStore;
  /**
   * 전이 보고 — **상담사 데스크톱에 알리는 자리**다. Core 는 상담사에게 직접 알리지 않는다(§6.2).
   * 소진(`code: 'alternative'`)은 여기로만 온다(이관 턴은 이미 끝났다) — 받지 않으면
   * 콜백·음성사서함 지시가 아무에게도 전달되지 않는다. 던져도 통화·만료 수렴은 계속된다.
   */
  onStep?(step: AgentOfferStep): void;
}

/**
 * 만료 수렴 결과. **빈 보고서를 "만료 0건"으로 읽히게 두지 않는다**(§13-3) —
 * `issues` 가 비어 있지 않으면 **판정이 돌지 않은 것**이다.
 */
export interface OfferExpiryReport {
  /** 응답 한도를 넘긴 열린 오퍼 수 */
  expired: number;
  /** 각 건의 수렴 결과(재배정·소진 대안·거절) */
  steps: readonly AgentOfferStep[];
  /** 시각 형태 오류 등. 비어 있지 않으면 `expired`·`steps` 는 판정 결과가 아니다. */
  issues: readonly string[];
}

/**
 * 채널 전환 배선(§5.2·§10.3·§11.1). **주지 않으면 종전과 완전히 같다**(§13-3) —
 * 전환 시 `port.invite(interactionId, target)` 를 토큰 없이 부르고, 합류(`joinInteractionId`)는
 * id 하나만 맞으면 통과한다. 그 상태에서는 **링크에 실리는 값이 곧 진행 중인 세션의 열쇠**이므로
 * 교차채널 초대가 가능한 채널이 등록되어 있으면 경고(`W_CHANNEL_SWITCH_UNBOUND`)로 드러낸다.
 *
 * 주면 Core 가 `core/executeSwitch.ts` 로 1회용·만료 토큰을 발급해 채널에 넘기고,
 * **합류에 그 토큰을 요구한다**. 이 배선이 없으면 `core/channelSwitch.ts`(발급·상환·회수·
 * 승계 allowlist)는 저장소에 있으나 **아무도 부르지 않는** 상태로 남는다.
 */
export interface ChannelSwitchBinding {
  /** 초대 레지스트리. 영속 구현으로 교체 가능(§6.2) — 인메모리는 단일 프로세스용이다. */
  invites: InviteRegistry;
  /** 1회용 토큰 발급기. 주입이다 — Core 가 만들면 추측 가능한 열쇠가 된다(§13-3). */
  newToken: () => string;
  /** 링크 유효기간(ms). 테넌트 운영값 — 기본값 없음(§13-3). */
  ttlMs: number;
  /** 승계 슬롯 allowlist(§10.3). 빈 배열이면 아무 슬롯도 초대에 싣지 않는다. */
  carry: SlotCarryPolicy;
  /**
   * 고객 단말이 링크를 받을 수 있다고 **확인**되었는가. 추정 금지 — 호스트가 관측한 값만(§13-3).
   * 확인하지 못했으면 false 를 주면 된다(전환은 성립하지 않고 §5.1 사다리의 다음 칸으로 간다).
   */
  reachable: (interactionId: string) => boolean;
  /** 발송 수단 기록값. Core 는 발송하지 않는다 — 실발신은 [승인 필요]. */
  delivery?: InviteDeliveryKind;
  /** 전환 사유 기록값(§7 7.6 전환 품질 축). 미지정 시 §5.1 사다리에서 온 전환으로 적는다. */
  reason?: SwitchReason;
}

/**
 * 인텐트 진입 배선(§5.1·§5.3·§2). **주지 않으면 종전과 완전히 같다**(§13-3) —
 * 채널은 시작할 시나리오 id 를 **이미 알고 있어야** 하고, 인텐트 진입 노드
 * (`INTENT_SLOT` 을 수집하는 Collect)는 평범한 Collect 로 동작한다.
 *
 * 주면 Core 가 고객의 답을 인텐트로 해석해 시나리오를 고른다
 * (`nlu/executeIntentEntry.ts` → 분류 → `decideIntent` → `routeIntent`).
 * 이 배선이 없으면 "무엇을 원하는지 듣고 시나리오를 고르는 일"이 채널 3곳에 남고,
 * 각자 `switch (intent)` 를 쓰면서 각자 다르게 틀린다(§2).
 */
export interface IntentBinding {
  catalog: IntentCatalog;
  policy: IntentPolicy;
  table: IntentRoutingTable;
  /**
   * 발화 → 후보(§6.2). 주입이다 — Core 는 엔진을 모르고, 실호출 승인도 호스트 쪽에 있다 **[승인 필요]**.
   *
   * `engines`(엔진 기동 선언)에 `intent` 를 선언했으면 **여기를 비운다** — 그러면 Core 가
   * 복원력·헬스 기록이 붙은 LLM 으로 분류기를 만들어 꿴다. 둘 다 주면 **거부한다**: 호스트가
   * 조각에서 직접 만든 분류기는 재시도·대체·§9.3 샘플 어디에도 닿지 않으므로, 분류가 전부
   * 타임아웃인데 폴백은 걸리지 않고 대시보드는 다른 엔진을 보고 있는 상태가 된다(§2·§9.3).
   */
  classifier?: IntentClassifier;
  /** 명확화 질문 문구. Core 는 문안을 만들지 않는다(§13-3) — 없으면 배선 자체를 거부한다. */
  clarifyPrompt: string;
  /**
   * 인텐트 턴에서 드러난 것을 호스트에 그대로 올린다(삼키지 않는다).
   * 분류기 장애와 "고객이 이상한 말을 했다"를 **여기서 갈라서** 받는다 — 합치면
   * 지식베이스가 통째로 내려가 있어도 그래프는 평온하다.
   *
   * 엔진 헬스 샘플은 여기서 만들지 않는다 — 엔진 상태는 `adapters/resilience.ts` 가
   * 이미 적는다. 두 곳에서 적으면 한 번의 장애가 두 번 집계된다(§2·§9.3).
   */
  onIssue?: (issue: {
    interactionId: string;
    kind: 'classifier_failed' | 'unrouted' | 'unmatched';
    reasonKo: string;
    intent?: string;
    status?: ClassifyStatus;
  }) => void;
}

/**
 * 지식 응대 배선(§5.2·§2). **주지 않으면 종전과 완전히 같다**(§13-3) —
 * 지식 응대 진입 노드(`KNOWLEDGE_SLOT` 을 수집하는 Collect)는 평범한 Collect 로 동작해
 * 고객의 질문을 슬롯 값으로 담고 다음 노드로 간다. 즉 **아무도 답하지 않는다**.
 *
 * 주면 Core 가 질문을 받아 근거를 찾고 인용까지 검증된 답변을 만든다
 * (`knowledge/executeKnowledge.ts` → `retriever` → `answerer`).
 * 이 배선이 없으면 `knowledge/retrieval.ts`·`knowledge/answer.ts` 는 저장소에 있으나
 * **아무도 부르지 않는** 상태로 남고, 채널 3곳이 각자 프롬프트와 실패 처리를 짜게 된다(§2).
 */
export interface KnowledgeBinding {
  /**
   * 질의 → 근거(§6.2). 주입이다 — 실엔진·실 벡터 DB 연결은 호스트 쪽이다 **[승인 필요]**.
   *
   * `engines`(엔진 기동 선언)에 `knowledge`(임베딩)를 선언하고 아래 `search` 를 주면
   * **여기를 비운다** — 그러면 Core 가 복원력·헬스 기록이 붙은 임베딩으로 검색기를 만들어 꿴다.
   * 둘 다 주면 **거부한다**(분류기와 같은 규칙, §2·§9.3).
   */
  retriever?: Retriever;
  /**
   * 근거 → 답변(§6.2). 같은 이유로 주입이다 **[승인 필요]**.
   *
   * `engines.answer` 를 선언했으면 **여기를 비운다**. 호스트가 조각에서 직접 만든 답변기는
   * 재시도·대체·§9.3 샘플에 닿지 않고, 그 증상은 예외가 아니라 **모든 질문이 "안내드릴
   * 내용이 없습니다"로 끝나는 것**이다 — 지식베이스는 멀쩡하므로 장애로 보이지 않는다.
   */
  answerer?: Answerer;
  /**
   * 검색기를 Core 가 만들게 하는 선언(§5.2·§11.1). `retriever` 를 주지 않을 때만 쓴다.
   *
   * 스토어는 **엔진이 아니라 호스트 인프라**라 엔진 기동 선언에 둘 수 없다. 대신 테넌트에
   * 묶인 스토어(`scopedVectorStore`)만 받는다 — 저수준 스토어를 받으면 네임스페이스를 Core 가
   * 만들 수 있게 되고 §11.1 방어선이 한 겹 사라진다.
   *
   * 지식베이스 id 에 **기본값은 없다**(§13-3) — 빈 목록은 "전체 검색"이 아니라 설정 오류다.
   */
  search?: {
    store: TenantVectorStore;
    knowledgeBaseIds: readonly string[];
    /** 지식베이스 한 곳당 조회 대기 상한(ms). 주지 않으면 제한하지 않는다(§13-3). */
    storeTimeoutMs?: number;
  };
  /** 근거 판정 정책(§5.2). 기본값 없음 — 성립하지 않는 정책은 **생성 시점에** 거부한다(§13-3). */
  policy: RetrievalPolicy;
  /**
   * 이번 지식 턴에 드러난 것을 호스트에 그대로 올린다(삼키지 않는다).
   * **성공한 턴도 올린다** — 실측(§11.2)은 성공 경로에만 있고, 실패만 올리면 임베딩·LLM
   * 비용 근거가 사라진다. 실측은 문자·건수뿐이다(토큰은 어댑터가 주지 않으므로 만들지 않는다).
   *
   * `cause` 는 **장애와 '근거 없음'을 갈라서** 받는다 — 합치면 지식베이스가 통째로
   * 내려가 있어도 운영 화면은 "고객이 없는 걸 물어봤다"로만 보인다.
   *
   * 엔진 헬스 샘플은 여기서 만들지 않는다 — 엔진 상태는 `adapters/resilience.ts` 가
   * 이미 적는다. 두 곳에서 적으면 한 번의 장애가 두 번 집계된다(§2·§9.3).
   */
  onResult?: (r: {
    interactionId: string;
    answered: boolean;
    /** 답하지 못한 경우에만 실린다. */
    cause?: KnowledgeFailureCause;
    /** 지식 응대 경로가 고장난 것인가. 설정 오류는 **장애가 아니다**. */
    infraFailed: boolean;
    /** 일부 지식베이스가 빠진 채 판정·응답했다. */
    partial: boolean;
    citations: number;
    reasonKo: string;
    usage: KnowledgeUsage;
  }) => void;
}

/**
 * 동의 배선(§10.1·§10.3·§6.1). **주지 않으면 종전과 완전히 같다**(§13-3) — 동의는 기록되지
 * 않고, 그 사실이 `W_CONSENT_UNBOUND` 경고로 남는다.
 *
 * 주면 Core 가 두 가지를 한다: (1) 시나리오의 동의 질문 노드(`__consent:<목적>` id 를 가진
 * `Confirm`)에서 확정된 답을 **추가 전용 기록 한 건**으로 바꿔 저장소에 넘기고,
 * (2) 그 이력으로 업무시스템 조회의 동의 컨텍스트를 만든다 — §6.1 게이트는 이미 있었으나
 * 그 입력을 만드는 코드가 저장소에 0건이어서 pii 파라미터를 선언한 커넥터는 **언제나 막혔다**.
 *
 * 이 배선이 없으면 `consent/consent.ts`(정책 검증·상태 판정·기록 생성)는 저장소에 있으나
 * **아무도 부르지 않는** 상태로 남고, 채널 3곳이 각자 동의 기록을 짜며 각자 다르게 틀린다(§2).
 *
 * 문구·법적 근거·보유기간은 Core 가 만들지 않는다 — 법무 검토를 거친 테넌트 정책만 싣는다 **[승인 필요]**.
 */
export interface ConsentBinding {
  /**
   * 테넌트 동의 정책. **고정 객체로 받는다** — 운영 중 정책을 고치면 버전이 달라지고, 살아 있는
   * 런타임에 그 객체가 물려 있으면 진행 중인 통화의 동의가 **다른 버전으로 기록된다**(어떤 문구로
   * 받은 동의인지 추적할 수 없게 된다, §10.1). 새 정책은 재배선으로 싣는다.
   */
  policy: ConsentPolicy;
  /** 추가 전용 동의 이력 저장소. 영속 구현으로 교체한다(§6.2) — 인메모리는 단일 프로세스용이다. */
  records: ConsentStore;
  /**
   * 동의 주체 참조. **호스트가 만든다** — 해시·고객키만이며 Core 는 만들지 않는다(§10.3·§13-3).
   *
   * 특히 `interactionId` 를 주체로 쓰지 않는다: 통화마다 주체가 달라져 재동의가 영영 쌓이지 않고,
   * 다음 통화에서는 **직전에 받은 동의를 찾을 수 없다**. 인증 전이면 `undefined` 를 주면 된다 —
   * 그 상태의 동의는 기록되지 않고, 그 사실이 턴 결과에 적힌다(없음을 통과로 읽지 않는다).
   * 던져도 통화는 끊지 않는다("없음"으로 본다).
   */
  subjectRef: (interactionId: string) => string | undefined;
  /** 증빙 참조(녹취 구간 키·서명 id). 증빙 원문을 넣지 않는다(§10.3). */
  evidenceRef?: (args: { interactionId: string; purpose: ConsentPurpose }) => string | undefined;
  /**
   * 이번 턴의 동의 처리 결과를 호스트에 그대로 올린다(삼키지 않는다).
   * **기록하지 못한 경우도 올린다** — 주체 미설정·미승인 정책·정책 미선언은 설정 문제이고,
   * 올리지 않으면 "동의를 받았다고 생각하는데 이력이 없다"가 몇 주 뒤에 발견된다.
   */
  onRecord?: (info: {
    interactionId: string;
    purpose?: ConsentPurpose;
    recorded: boolean;
    state?: 'granted' | 'denied';
    reasonKo?: string;
  }) => void;
  /**
   * §10.1 고지 문안 등록부. **주지 않으면 종전과 완전히 같다**(§13-3) — 문안 검사를 하지
   * 않고 동의 게이트 결과만 쓰며, 그 사실이 `W_LEGAL_UNBOUND` 경고로 남는다.
   */
  legal?: LegalNoticeBinding;
}

/**
 * 고지 문안 등록부 배선(§10.1). 동의 컨텍스트에 등록부를 실어 **통화 경로에서 실제로
 * 조회되게** 한다 — 이것이 없으면 `legal/documents.ts` 는 저장소에 있으나 아무도 부르지 않는다.
 *
 * 왜 Core 가 끼우는가: 등록부를 넣을 수 있는 자리는 커넥터 배선의 동의 컨텍스트(`connectors.consent`)
 * 하나인데, 그 자리는 동의 배선이 있으면 **Core 가 만들고 호스트 선언을 거부한다**(출처가 둘이면
 * 어느 쪽이 적용됐는지 알 수 없다, §2). 즉 지금까지 등록부를 통화에 넣을 길 자체가 없었다.
 */
export interface LegalNoticeBinding {
  /**
   * 등록부 내용(`LegalRegistry.list()` 결과 그대로). **고정 배열로 받는다** — `policy` 와 같은
   * 이유다: 운영 중 등록부가 바뀌면 진행 중인 통화가 **다른 문안을 근거로** 판정되고, 그러면
   * "어떤 문안으로 받은 동의인지"가 다시 추적 불가능해진다. 개정본은 재배선으로 싣는다.
   * 고정이라 기동 시점 검사와 통화 중 판정이 **같은 문서를 본다** — 경고와 실제 동작이
   * 어긋나지 않는다.
   */
  docs: readonly LegalDocument[];
  /**
   * 주체별 문안 수락 기록 조회. 수락은 통화 중에도 늘어나므로 조회로 받는다.
   * 주지 않으면 재수락 판정을 하지 않고 "대조할 수 없다"로 적힌다 — 없다는 사실만으로
   * 기존 동의를 무효로 보지 않는다(§10.1). 던지면 **기록 없음**으로 본다(미선언으로 적지
   * 않는다 — 선언은 했고 조회가 실패한 것이라, 두 상태의 대응이 다르다).
   */
  acceptances?: (subjectRef: string) => readonly AcceptanceRecord[];
  /** 고객에게 보여 준 언어(BCP-47). 기본 언어를 만들지 않는다(§13-3). */
  locale: string;
}

/**
 * QA·준수 점검 배선(§7 5.2·§10.1·§10.3). **주지 않으면 종전과 완전히 같다**(§13-3) —
 * 어떤 세션도 점검되지 않고, 그 사실이 `W_QA_UNBOUND` 경고로 남는다.
 *
 * 주면 Core 가 세션이 끝나는 **네 갈래 전부에서**(정상 종료·§9.3 폴백 중단·폴백 이관·커넥터
 * 순회 상한) 그 세션의 이벤트를 모아 한 번 점검하고, 요약을 턴 결과에 싣는다.
 * 이 배선이 없으면 `qa/compliance.ts` 는 저장소에 있으나 **아무도 부르지 않는** 상태로 남는다 —
 * 그리고 그 상태는 운영 화면에서 "위반이 없다"와 똑같이 보인다.
 *
 * 고지 필수 여부는 여기서 받지 않는다 — 출처는 `disclosure`(AiDisclosureConfig) 하나다(§2).
 * 표식·금칙어 문구는 Core 가 만들지 않는다 — 테넌트 법무·컴플라이언스가 등록한다 **[승인 필요]**.
 */
export interface ComplianceBinding {
  /** 고지 발화 판별용 핵심 어구(§10.1). 비어 있으면 고지 점검을 수행하지 않는다(경고로 남는다). */
  disclosureMarkers: readonly string[];
  /** 금칙어 규칙. 비어 있으면 금칙 표현 점검을 수행하지 않는다(합격이 아니라 skipped 다). */
  forbiddenPhrases: readonly ForbiddenPhraseRule[];
  /**
   * 세션당 점검용 이벤트 수집 상한. **기본값 없음**(§13-3) — 주지 않으면 세션 길이만큼 모은다.
   * 주면 상한을 넘은 뒤부터 담지 않고, 전수를 봐야 하는 규칙은 점검 결과에서 `skipped` 로 내려간다
   * (잘라낸 범위를 "위반 0건"으로 적지 않는다).
   */
  maxEvents?: number;
  /**
   * 점검 전문(`QaReport`)을 호스트에 그대로 올린다(삼키지 않는다). 리뷰 큐 적재·보존은
   * 호스트 몫이다(§6.2) — Core 는 저장하지 않는다.
   *
   * **수행하지 못한 점검도 올린다**: 수집 0건·격리 위반·판정 예외는 전부 "위반 0건"과 구분되어야
   * 하고, 올리지 않으면 "점검이 돌고 있다고 생각하는데 기록이 없다"가 몇 주 뒤에 발견된다.
   * 이 훅이 던져도 통화·종료는 영향받지 않는다(종료 경로의 예외는 세션 누수로 나타난다).
   */
  onReport?: (info: {
    interactionId: string;
    /** 점검을 수행하지 못했으면 실리지 않는다 — 빈 리포트를 "위반 없음"으로 읽지 않게. */
    report?: QaReport;
    note: ComplianceTurnNote;
  }) => void;
}

export interface ConversationCoreOptions {
  scope: TenantScope;
  flows: FlowRegistry;
  channels: ChannelRegistration[];
  policy: FallbackPolicy;
  health: HealthRegistry & { record(sample: HealthSample): void };
  bus?: EventBus;
  sessions?: SessionStore;
  /** 신뢰도 임계값(테넌트 설정). 미지정 시 게이팅하지 않는다(§13-3). */
  minConfidence?: number;
  /**
   * 재프롬프트 정책(§5.1). 여기 한 곳에서 주입해야 세 채널이 같은 문안을 쓴다 —
   * 채널 저장소가 각자 재프롬프트를 짜면 §2 의 시나리오 이중 관리가 그대로 재발한다.
   * 미지정 시 노드 원문이 그대로 재생된다(기본 문안 금지, §13-3).
   */
  reprompt?: RepromptPolicy;
  /**
   * 턴 타이밍 정책(§5.1). 대기 시간을 채널이 각자 정하면 같은 시나리오가 채널마다 다른 순간에
   * 무입력으로 떨어진다. 미지정 시 Core 는 어떤 값도 싣지 않는다(§13-3).
   */
  timing?: TurnTimingPolicy;
  summary?: SummaryOptions;
  /** 상담사 큐 배정(§2). 미지정 시 큐 판정을 하지 않는다 — 종전 동작과 동일하다(§13-3). */
  routing?: RoutingBinding;
  /**
   * Api 노드 이행(§6.1). **주지 않으면 종전과 완전히 같다**(§13-3) — Api 노드에서
   * `state.pendingConnectorId` 만 세운 채 멈추고, 호스트가 직접 커넥터를 불러
   * `send({ input: { kind: 'connectorResult', ... } })` 로 되돌려준다.
   *
   * 주면 Core 가 `integration/connectorPump.ts` 로 이행한다. 이 배선이 없으면 실행기(§14)는
   * **아무도 부르지 않는** 상태로 남고, 증상은 예외가 아니라 **무음**이다 — Api 대기 중
   * 커넥터 결과가 아닌 입력은 빈 결과가 되어 고객이 무슨 말을 해도 채널이 렌더할 것이 없다.
   */
  connectors?: ConnectorPumpBinding;
  /** 채널 전환 초대(§5.2). 미지정 시 종전 동작 — 합류에 토큰을 요구하지 않는다(§13-3). */
  channelSwitch?: ChannelSwitchBinding;
  /** 인텐트 진입(§5.1·§5.3). 미지정 시 인텐트 진입 노드는 평범한 Collect 로 동작한다(§13-3). */
  intent?: IntentBinding;
  /**
   * 지식 응대(§5.2). 미지정 시 지식 응대 진입 노드는 평범한 Collect 로 동작하며,
   * 그 사실이 `W_KNOWLEDGE_UNBOUND` 경고로 남는다(§13-3) — 증상은 예외가 아니라
   * **고객의 질문이 슬롯 값으로 저장된 채 흐름이 넘어가는 것**이다.
   */
  knowledge?: KnowledgeBinding;
  /**
   * AI 고지(§10.1·§7 7.4). **주지 않으면 종전과 완전히 같다**(§13-3) — 고지는 나가지 않고,
   * 그 사실이 `W_AI_DISCLOSURE_UNBOUND` 경고로 남는다.
   *
   * 주면 Core 가 고객이 실제로 보고·듣는 매체에 맞는 문구를 **AI 첫 응답보다 앞에** 끼운다.
   * 이 배선이 없으면 `portal/aiDisclosure.ts` 는 저장소에 있으나 **아무도 부르지 않는** 상태로
   * 남고, 채널 3곳이 각자 "세션 시작 시 문구를 한 번 내보낸다"를 짜며 각자 다르게 틀린다.
   *
   * 문구는 Core 가 만들지 않는다 — 법무 검토를 거친 테넌트 문구만 싣는다 **[승인 필요]**.
   */
  disclosure?: AiDisclosureConfig;
  /**
   * 동의(§10.1·§6.1). **주지 않으면 종전과 완전히 같다**(§13-3) — 동의 기록은 0건이고,
   * 개인정보 파라미터를 선언한 커넥터 조회는 동의 컨텍스트가 없어 항상 막힌다.
   * 그 사실이 `W_CONSENT_UNBOUND` 경고로 남는다.
   */
  consent?: ConsentBinding;
  /**
   * QA·준수 점검(§7 5.2). **주지 않으면 종전과 완전히 같다**(§13-3) — 어떤 세션도 점검되지
   * 않고, 그 사실이 `W_QA_UNBOUND` 경고로 남는다.
   */
  qa?: ComplianceBinding;
  /**
   * 관측(§13·§9.3·§10.3). **주지 않으면 종전과 완전히 같다**(§13-3) — 로그 한 줄도 남지 않는다.
   *
   * 이 배선이 없던 동안 `obs/logger.ts`·`obs/errorMonitor.ts` 는 저장소에 있으나 **아무도
   * 부르지 않는** 상태였다. 그 상태에서 통화가 예외로 죽으면 어디에도 테넌트·상호작용·
   * 실패 코드가 남지 않는데, 사후분석에서 필요한 것이 정확히 그 셋이다.
   *
   * 무엇을 싣고 무엇을 싣지 않을지는 `obs/executeObservability.ts` 가 정한다 —
   * 여기서 결과를 펼쳐 로그에 넘기면 발화·슬롯 값·상담사 요약이 그대로 따라 나간다
   * (`maskPii` 는 이름·주소를 가리지 않는다, §10.3).
   */
  observability?: ObservabilityBinding;
  /**
   * 복구 프로브(§9.3). **주지 않으면 종전과 완전히 같다**(§13-3) — `runRecoveryProbes()` 는
   * `undefined` 를 돌려주고(빈 보고서가 아니다: "확인했고 0건"과 "확인하지 않았다"는 다르다)
   * 컴포넌트를 올리는 채널이 등록돼 있으면 `W_RECOVERY_UNBOUND` 경고로 드러낸다.
   *
   * 이 배선이 없는 동안 `ops/recoveryProbe.ts` 는 저장소에 있으나 **아무도 부르지 않는**
   * 상태였고, 증상은 예외가 아니라 **폴백이 풀리지 않는 것**이다 — L2 가 `down` 이 되면
   * 엔진 호출 자체가 멈춰 새 샘플이 생기지 않으므로, 보수적 테넌트는 사람이 손대기 전까지
   * 영구 상담사 직결이고 그렇지 않은 테넌트는 **증거 없이** AI 를 재개한다.
   */
  recovery?: RecoveryBinding;
  /**
   * 엔진 기동(§6.2·§9.3·§10.3). **주지 않으면 종전과 완전히 같다**(§13-3) — Core 는 엔진을
   * 모르고, 헬스 레지스트리에는 채널이 `reportHealth` 로 올리는 샘플만 들어온다.
   *
   * 이 배선이 없는 동안 `adapters/engineSet.ts`·`adapters/resilience.ts` 는 저장소에 있으나
   * **아무도 부르지 않는** 상태였고, 그래서 위 인텐트·지식 배선 주석이 약속한
   * "엔진 상태는 `adapters/resilience.ts` 가 이미 적는다"가 **참이 아니었다**. 증상은 장애로
   * 보이지 않는다: LLM 이 전부 타임아웃이어도 §9.3 판정은 `normal` 이고, 통화는 턴마다
   * 개별적으로 실패하며(고객은 "말을 못 알아듣는다"로 겪는다) 폴백은 걸리지 않는다.
   *
   * **레지스트리·시계를 선언에 담지 않는다** — 런타임이 자기 것을 넘긴다. 호스트가 주장하면
   * 엔진 샘플이 통화가 올린 샘플과 다른 레지스트리에 쌓이고, 그러면 폴백 판정은 끝까지 그
   * 샘플을 보지 못한다(복구 프로브에서 이미 겪은 실패다). 테넌트가 어긋나면 **조용히 덮어쓰지
   * 않고 거부**한다(§11.1).
   *
   * 실엔진 연결·live 전환은 **[승인 필요]** — 기본 `dry_run` 이며 그 상태에서는 헬스 샘플도
   * 남기지 않는다(dry_run 성공은 실엔진 관측이 아니다).
   */
  engines?: EngineStartupDeclaration;
  /**
   * 보존 정책(§8.2). **주지 않으면 종전과 완전히 같다**(§13-3) — Core 는 저장해도 되는지
   * 묻지 않고, 그 사실이 `W_RETENTION_UNBOUND` 경고로 남는다. 자세한 내용은
   * `RetentionBinding` 주석.
   */
  retention?: RetentionBinding;
  /**
   * 요청 제한(§9.3·§11.1·§11.2). **주지 않으면 제한하지 않는다** — 한도 기본값을 코드에 두지
   * 않는다(§13-3). 한도는 계약·운영 합의값이다.
   *
   * 이 자리가 없던 동안 제한은 **브리지(JSONL) 경로에만** 있었다. 그런데 실제로 Core 를
   * 소비하기 시작한 두 저장소(챗봇·D-ARS)는 TypeScript 호스트라 이 경로를 쓴다 — 즉 보호는
   * 아무도 지나가지 않는 길에 걸려 있었고, `ChannelTurnInput.usage` 검증이 그랬던 것과 **같은
   * 모양의 비대칭**이다. 폭주는 악의보다 사고로 온다: 전송 계층의 재시도 루프, 웹훅 재전송,
   * 잘못 설정된 배치 한 번이 턴마다 LLM·임베딩을 부르고 그 비용은 공급사 청구서에 남는다.
   *
   * 키는 **테넌트 스코프 + 진입점**으로 Core 가 만든다(`rateLimitKey`) — 호스트가 키를 정하면
   * 테넌트 경계 없는 제한이 되고, 한 고객사의 폭주가 다른 고객사를 막는다(§11.1).
   * 버킷 이름은 `core.*` 이고 브리지는 `bridge.*` 다 — **같은 제한기를 둘에 주면 버킷이 둘**이다
   * (한 요청을 두 번 세지 않는다. 브리지는 자기 프로세스 경계를, 여기서는 Core 진입을 센다).
   *
   * 거절은 `E_RATE_LIMITED` **예외**다(`enforceRateLimit` 가 만든 그 오류 하나 — 판정과 오류
   * 문구를 여기서 다시 쓰지 않는다, §2). 계산된 `retryAfterMs` 가 함께 실리며 추정치가 아니다.
   * 거절된 호출은 세션 상태를 바꾸지 않는다 — 제한은 어떤 일을 하기 **전에** 판정한다.
   *
   * **`end` 는 어떤 경우에도 막지 않는다**: 막히면 세션이 열린 채 남고 그 누수는 장애가 아니라
   * 요금으로 나타난다(브리지와 같은 규칙).
   * **`reportHealth` 도 막지 않는다** — 브리지는 막지만 그쪽에서 막는 비용은 바깥 프로세스가
   * 보낸 줄을 해석하는 일이고, 여기서는 그 비용이 없다(엔진도 과금도 건드리지 않는 동기 호출이다).
   * 반면 샘플을 떨어뜨리면 **장애가 정상으로 집계된다**(§9.3) — 그 위험을 보호가 필요 없는
   * 자리에서 떠안지 않는다. 그래서 `reportHealth` 비용 선언은 **거부한다**(조용히 무시하면
   * "제한을 걸었다"는 기록만 남는다).
   */
  rateLimiter?: RateLimiter;
  /** 진입점별 비용. 주지 않으면 전부 1. `send` 는 엔진 호출을 동반하므로 무겁게 셀 수 있다. */
  rateLimitCost?: Partial<Record<RateLimitedEntry, number>>;
  now?: () => string;
  newInteractionId?: (req: ChannelSessionRequest) => string;
  onPublish?: (results: PublishResult[]) => void;
}

/** 한도 적용 대상 진입점. `end`·`reportHealth` 는 들어 있지 않다(위 `rateLimiter` 주석). */
export type RateLimitedEntry = 'start' | 'send';

export const RATE_LIMITED_ENTRIES: ReadonlySet<string> = new Set<RateLimitedEntry>(['start', 'send']);

/**
 * 복구 프로브 배선(§9.3). **레지스트리·정책·시계·감시 목록을 받지 않는다** — 호스트가 그것들을
 * 주장하면 /health 배선과 같은 사고가 난다: 프로브가 **통화가 올린 샘플과 다른 레지스트리**에
 * 샘플을 쓰고, 그러면 복구 보고서에는 `recovered` 가 찍히는데 채널은 계속 상담사 직결이다.
 * 정책이 어긋나면 "지금 나쁜 컴포넌트" 집합이 `decideFallbackMode` 와 갈라져 **엉뚱한 것을
 * 찌른다**(§2 가 지적한 이중 관리가 프로브 대상의 형태로 재발한다).
 *
 * 실프로브(합성콜·핑) 구현과 연결은 **[승인 필요]** — 여기서 받는 것은 그 구현이다.
 */
export interface RecoveryBinding {
  /** 컴포넌트별 프로브·간격·제한 시간. 간격·제한 시간 기본값 없음(§13-3). */
  schedules: ProbeSchedule[];
  /**
   * 엔진 컴포넌트는 **프로브를 호스트가 쓰지 않는다**(§6.2·§9.3). 엔진 기동(`engines.probes`)이
   * 만든 `HealthProbe` 를 여기 선언한 간격·제한 시간으로 돌린다 — 호스트가 직접 쓰면
   * `startEngines` 가 돌려준 `engines`(복원력이 붙은 묶음)로 만들기 쉽고, 그러면 **대체 엔진의
   * 응답이 주 엔진의 `up` 으로 기록된다**(`engineProbe.ts` 머리말 (가)).
   *
   * 간격·제한 시간은 여기서도 **기본값이 없다**(§13-3) — 주지 않으면 그 컴포넌트는 확인하지
   * 않고, 러너가 그 사실을 `skipped` 로 적는다.
   *
   * 엔진 기동이 그 컴포넌트 프로브를 만들지 못했으면(승인 전·합성 입력 미선언·슬롯 없음)
   * **가짜 프로브를 만들지 않고** 경고(`W_ENGINE_PROBES`)로 드러낸다 — 돌아가지 않는 프로브를
   * 배선해 두면 보고서에는 "확인 중"으로 남는다.
   */
  engineProbes?: { component: ComponentId; intervalMs?: number; timeoutMs?: number }[];
  /** 소요 실측용 단조 시계(ms). 없으면 `latencyMs` 를 만들지 않는다(§13-3). */
  monotonic?: () => number;
  /**
   * 몇 번 **연속** 성공해야 복구로 기록할지. 선언하지 않으면 관측한 그대로 적는다
   * (관측을 그대로 적는 것은 정책이 아니다) — 깜빡이는 엔진이 채널을 왕복시키는 대가를
   * 치를지는 테넌트가 정한다.
   */
  confirmSuccesses?: number;
  scheduler?: Scheduler;
}

/**
 * readiness 호출 옵션(§9.3·§13). 레지스트리·폴백 정책·선언된 컴포넌트·등록된 채널은 런타임이
 * 이미 가지고 있으므로 **호스트가 다시 꿰지 않는다** — 다시 꿰게 두면 그 자리에서 `/health` 가
 * 자기 레지스트리를 만들어 보고, 그러면 통화가 올린 샘플과 다른 레지스트리를 읽게 된다.
 */
export interface ReadinessRequest {
  /** 호스트가 주입하는 실점검 프로브(DB·스토리지 등, §6.2). 실연결은 **[승인 필요]**. */
  probes?: readonly DependencyProbe[];
  /** 프로브별 지정이 없을 때 쓰는 제한 시간. 운영 합의값이며 Core 가 만들지 않는다(§13-3). */
  timeoutMs: number;
  clock?: () => number;
  build?: BuildInfo;
  scheduler?: Scheduler;
  /**
   * 아직 활성화하지 않은 컴포넌트. 그 컴포넌트는 샘플을 읽지 않고 "[승인 필요] 활성화 전"으로
   * 적는다 — dry_run 어댑터가 올린 샘플을 실엔진 관측으로 읽으면 켜지지도 않은 엔진이
   * 정상으로 보고된다(`ops/executeHealth.ts` 의 (라)).
   */
  approvalPending?: readonly ComponentId[];
}

export interface ConversationCore extends ConversationCorePort {
  /** 등록 시 남은 경고(§9.3 폴백 경로 없음 등). 운영이 반드시 보게 노출한다. */
  warnings(): ContractIssue[];
  capabilitiesOf(adapter: ChannelAdapterId): ChannelCapabilities | undefined;
  sessions: SessionStore;
  /**
   * 관측 실측. 배선이 없으면 `undefined` — **0 건으로 적지 않는다**(§13-3).
   * `failed` 가 0 이 아니면 로거·수집기가 던지고 있다는 뜻이고, `droppedIds` 가 0 이 아니면
   * 호스트의 id 생성 규칙이 개인정보 패턴에 걸린다는 뜻이다(§10.3).
   */
  observability(): ObserverStats | undefined;
  /** 수집기에 남은 억제분 방출(프로세스 종료 직전). 배선이 없으면 0. */
  flushObservability(): number;
  /**
   * readiness(§9.3·§13). 호스트가 /health 를 직접 짜면 거기 들어가는 것은 DB·엔진 접속
   * 프로브이고, **§9.3 폴백 상태는 응답에 닿지 않는다** — L2 가 죽어 모든 통화가 상담사
   * 직결로 떨어진 순간에도 /health 는 `up`·200 이다. 이 메서드가 그 사이를 꿴다.
   *
   * **컴포넌트 저하는 503 을 만들지 않는다**(`critical: false` 고정) — 폴백 경로가 이
   * 프로세스를 지나므로 인스턴스를 빼면 상담사 이관까지 같이 죽는다. 필수/부가 구분은
   * 호스트 프로브에만 있다. 어떤 경우에도 던지지 않는다.
   */
  readiness(req: ReadinessRequest): Promise<CoreReadinessReport>;
  /**
   * 복구 프로브 1회 실행(§9.3). **타이머를 Core 가 돌리지 않는다** — 호스트가 부른다
   * (Core 가 몰래 켠 인터벌은 끌 수도 없고 프로세스 종료를 막는다). 배선이 없으면
   * `undefined` — **빈 보고서를 돌려주지 않는다**("확인했고 0건"으로 읽힌다, §13-3).
   * 어떤 경우에도 던지지 않는다(복구 확인 루프가 예외로 죽으면 복구도 같이 죽는다).
   */
  runRecoveryProbes(nowIso?: string): Promise<RecoveryRunReport | undefined>;
  /** 컴포넌트별 마지막 확인 시각. 배선이 없으면 `undefined`. */
  recoveryLastRunAt(component: ComponentId): string | undefined;
  /**
   * 기동된 엔진(§6.2). 배선이 없으면 `undefined` — **빈 객체를 돌려주지 않는다**("엔진이
   * 없다"와 "조립했는데 비었다"는 다르다, §13-3).
   *
   * 호스트는 이것으로 지식 인제스트(`embedder`)·검토용 서술(`describeKo`)·사용량 근거
   * (`lastUsage`)를 **같은 엔진 인스턴스에서** 얻는다. 따로 기동하면 같은 테넌트에 엔진이
   * 두 벌 서고, 그 둘은 헬스·사용량을 각자 적는다(§2·§11.2).
   */
  engines(): EngineRuntime | undefined;
  /**
   * 오퍼 원장 열람(§2). 배선이 없으면 `undefined` — **빈 원장을 돌려주지 않는다**("오퍼가
   * 0건"과 "오퍼가 돌지 않는다"는 다르다, §13-3).
   */
  agentOffers(): OfferLedger | undefined;
  /**
   * 상담사 응답 반영(§2·§9.3). 상담사 데스크톱의 수락·거절, 호스트의 취소가 들어오는 자리다.
   * 거절·무응답이면 **같은 호출에서** 다음 후보로 이어지고, 재배정 한도를 다 쓰면 §9.3
   * 대안(`step.placement`)까지 수렴한다 — 호출자가 빠뜨릴 수 없다.
   *
   * 배선이 없으면 `undefined`. 어떤 경우에도 던지지 않는다 — **테넌트 격리 위반만** 올라온다
   * (남의 테넌트 오퍼를 전이시키는 것은 폴백할 사안이 아니다, §11.1).
   */
  settleAgentOffer(p: { offerId: string; event: OfferEvent; nowIso?: string }): Promise<AgentOfferStep | undefined>;
  /**
   * 만료 수렴 1회(§9.3). **타이머를 Core 가 돌리지 않는다** — 호스트가 부른다(몰래 켠
   * 인터벌은 끌 수도 없고 프로세스 종료를 막는다, `runRecoveryProbes` 와 같은 이유).
   *
   * 목록만 돌려주지 않고 건마다 `tick` 을 반영하는 이유: 목록을 받아 다시 넘기는 자리가
   * 생기면 거기서 빠뜨려지고, 그러면 그 통화는 큐에 묶인 채 대안으로도 가지 않는다
   * (`executeOffer` (바)). 배선이 없으면 `undefined` — 빈 보고서는 "만료 0건"으로 읽힌다.
   */
  runOfferExpiry(nowIso?: string): Promise<OfferExpiryReport | undefined>;
}

function stubState(flowId: string, flowVersion: number, channel: ChannelKind, status: RunStatus): FlowState {
  return {
    flowId, flowVersion, channel, currentNodeId: null, slots: {},
    failCount: 0, turnCount: 0, eventSeq: 0, status, visited: [],
  };
}

/** 커넥터 대기 등 무음 단계는 채널이 렌더하지 않는다. */
function visibleSteps(steps: RenderedStep[]): RenderedStep[] {
  return steps.filter((s) => s.silent !== true);
}

/**
 * §8.1 `latency_ms` 의 키. **목록을 여기 한 곳에 둔다** — 브리지(JSONL)도 같은 목록으로
 * 검사하므로, 두 곳에 쓰면 키가 하나 늘어나는 날 한쪽만 늘고 그쪽을 지나지 않는 호스트에서만
 * 그 실측이 조용히 사라진다(§2).
 */
const TURN_LATENCY_KEYS = ['stt_ms', 'llm_ttft_ms', 'tts_ttfb_ms', 'total_ms'] as const;

export function createConversationCore(opts: ConversationCoreOptions): ConversationCore {
  assertTenantScope(opts.scope);

  const sessions = opts.sessions ?? createMemorySessionStore();
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newInteractionId ?? ((req) => `i_${req.adapter}_${Date.now().toString(36)}`);
  const warnings: ContractIssue[] = [];
  const regs = new Map<ChannelAdapterId, ChannelRegistration>();
  const declared = new Map<ChannelAdapterId, Set<ComponentId>>();
  // 배선을 선언하지 않으면 관측기를 만들지 않는다 — `record` 호출 자체가 없어 종전과 완전히 같다(§13-3).
  const observer: Observer | undefined = opts.observability === undefined
    ? undefined
    : createObserver(opts.observability);
  // 오퍼 원장은 **배선이 있을 때만** 만든다 — 없는데 빈 원장을 두면 `agentOffers()` 가
  // "오퍼가 0건"을 돌려주고, 그것은 "오퍼가 돌지 않는다"와 바깥에서 구분되지 않는다(§13-3).
  const offerStore: OfferLedgerStore | undefined = opts.routing?.offers === undefined
    ? undefined
    : (opts.routing.offers.ledger ?? createMemoryOfferLedger());

  // 제한기 **형태** 오류는 설정 오류다(제한기 **장애**는 아래에서 통과로 둔다, §9.3).
  // 둘을 같게 다루면 오타 하나로 제한이 조용히 꺼진 채 "적용했다"로 남는다 — 브리지와 같은 규칙.
  if (opts.rateLimiter !== undefined && typeof opts.rateLimiter.check !== 'function') {
    throw new Error('요청 제한 배선 거부: rateLimiter 는 check(key, cost) 를 가진 제한기여야 합니다 (설계서 §9.3)');
  }
  if (opts.rateLimitCost !== undefined) {
    for (const [entry, cost] of Object.entries(opts.rateLimitCost)) {
      if (!RATE_LIMITED_ENTRIES.has(entry)) {
        // `end`·`reportHealth` 가 여기 오면 조용히 무시하지 않는다 — 무시하면 "제한을 걸었다"는
        // 기록만 남고 실제로는 걸리지 않는다(막지 않는 이유는 `rateLimiter` 주석).
        throw new Error(`요청 제한 배선 거부: 한도 적용 대상이 아닌 진입점입니다: ${entry} (설계서 §9.3·§11.2)`);
      }
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
        throw new Error(`요청 제한 배선 거부: rateLimitCost.${entry} 는 양수여야 합니다 (설계서 §13-3)`);
      }
    }
    if (opts.rateLimiter === undefined) {
      throw new Error('요청 제한 배선 거부: rateLimitCost 를 주려면 rateLimiter 도 주어야 합니다 (설계서 §9.3)');
    }
  }

  /**
   * 한도 판정. 제한기가 없으면 통과한다(§13-3).
   *
   * 제한기 **자체의 예외**는 잠그는 쪽이 아니라 통과로 둔다 — 공유 저장소 장애로 전 통화가
   * 끊기면 제한이 막으려던 것보다 큰 사고다(§9.3). 거절 오류는 `enforceRateLimit` 하나가
   * 만든다(판정과 문구를 여기서 다시 쓰지 않는다, §2).
   */
  function enforceLimit(entry: RateLimitedEntry): void {
    const limiter = opts.rateLimiter;
    if (limiter === undefined) return;
    let err;
    try {
      err = enforceRateLimit(limiter, rateLimitKey(opts.scope, `core.${entry}`), opts.rateLimitCost?.[entry] ?? 1);
    } catch {
      return;
    }
    if (err !== undefined) throw err;
  }

  /**
   * 쌓인 계약 경고를 로그로 내보낸다 — **경고 하나당 딱 한 줄**이다(§13).
   *
   * 지금까지 `W_CONSENT_UNBOUND`·`W_QA_UNBOUND`·`W_KNOWLEDGE_UNBOUND` 같은 미배선 경고는
   * 호스트가 `warnings()` 를 **읽어야** 보였다. 읽지 않으면 동의·점검·지식 응대가 배선되지
   * 않은 채로 돌고, 그 상태는 예외도 장애도 아니라 **아무 일도 일어나지 않는 것**이라
   * 통화·이벤트·적합성 검사가 전부 정상이다.
   *
   * 커서(`warnedUpto`)가 **한 번만**을 보장한다 — 턴마다 전체를 찍으면 미배선 경고 하나가
   * 로그를 덮어 진짜 신호가 묻힌다. 커서를 먼저 올리는 이유는 관측이 던져도(호스트 로거가
   * 던지는 경우) 같은 경고를 영원히 되풀이하지 않기 위해서다.
   * **문구는 나가지 않는다** — 경고 문구에는 시나리오 id·인텐트·호스트 사유가 보간돼 있어
   * 고정 허용 목록을 지날 수 없다(§10.3). 로그에 가는 것은 코드뿐이고 전문은 `warnings()` 다.
   */
  let warnedUpto = 0;
  function drainWarnings(): void {
    if (observer === undefined) return;
    while (warnedUpto < warnings.length) {
      const w = warnings[warnedUpto];
      warnedUpto += 1;
      if (w === undefined) continue;
      observer.recordWarning({ scope: opts.scope, code: w.code });
    }
  }

  /** 실측 소요. 시계가 없으면 **필드를 만들지 않는다**(§13-3). */
  function durationOf(started: number | undefined): { durationMs?: number } {
    const d = observer?.elapsed(started);
    return d === undefined ? {} : { durationMs: d };
  }

  /**
   * 진입점 한 번을 관측한다. 성공·예외 **양쪽** 경로에서 기록하고 예외는 그대로 다시 던진다 —
   * 삼키면 채널이 실패를 모른 채 다음 턴을 보낸다(품질기준 §3).
   *
   * 결과를 감싸지 않고 **바깥에서** 재므로 `port.present`·이벤트 발행까지 포함한 실제 소요가 남고,
   * 조기 반환 경로(폴백 종료·이미 끝난 세션·합류)를 하나도 빠뜨리지 않는다.
   */
  async function observe(
    op: CoreOp,
    hint: { adapter?: ChannelAdapterId; correlationId?: string; interactionId?: string },
    run: () => Promise<ChannelTurnResult>,
  ): Promise<ChannelTurnResult> {
    if (observer === undefined) return run();
    const started = observer.startedAt();
    const facts = (result?: ChannelTurnResult): ObservedCall => {
      const id = hint.interactionId ?? result?.interactionId;
      const rec = id === undefined ? undefined : sessions.get(id);
      // 스코프는 **Core 가 강제하는 것**이다(§11.1). 세션 기록의 스코프는 테넌트가 일치할 때만
      // 쓴다 — 워크스페이스 구분이 로그에 보여야 하지만, 테넌트가 다른 값을 적으면 그 로그로는
      // 격리 사고를 조사할 수 없다.
      const scope = rec !== undefined && rec.scope.tenantId === opts.scope.tenantId ? rec.scope : opts.scope;
      const correlationId = hint.correlationId ?? rec?.correlationId;
      const adapter = hint.adapter ?? rec?.adapter;
      return {
        op,
        scope,
        ...(id !== undefined ? { interactionId: id } : {}),
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...(adapter !== undefined ? { adapter } : {}),
      };
    };
    try {
      const result = await run();
      observer.record({ ...facts(result), result, ...durationOf(started) });
      // 이 턴이 처음 드러낸 계약 경고를 턴 줄 **뒤에** 내보낸다(인과 순서가 보이게).
      drainWarnings();
      return result;
    } catch (e) {
      observer.record({ ...facts(), error: e, ...durationOf(started) });
      drainWarnings();
      throw e;
    }
  }

  /**
   * 실행할 시나리오 조회 — **배포본 경로가 있으면 그것만 쓴다**(§5.3).
   *
   * 두 경로를 섞지 않는 것이 요점이다. `forChannel` 이 미배포라고 답했을 때 `get` 으로
   * 되물으면, 배포하지 않은 버전이 "그래도 하나 있으니" 통화에 나간다 — 배포 게이트를
   * 둔 의미가 사라지고, 그 사고는 예외 없이 "왜 이 버전이 돌고 있지"로만 나타난다.
   */
  function resolveFlow(flowId: string, channel: ChannelKind, version?: number): Flow | undefined {
    const reg = opts.flows;
    if (typeof reg.forChannel === 'function') return reg.forChannel(flowId, channel, version);
    return reg.get(flowId, version);
  }

  /** 조회 실패 사유. 사유를 모르는 조회면 빈 문자열이다 — 없는 사유를 지어내지 않는다(§13-3). */
  function flowResolution(flowId: string, channel: ChannelKind, version?: number): FlowResolution | undefined {
    const reg = opts.flows;
    if (typeof reg.explain !== 'function') return undefined;
    try {
      return reg.explain(flowId, channel, version);
    } catch {
      // 사유 조회가 예외로 끝난 것 때문에 세션이 끊기면 안 된다 — 사유가 없는 것으로 본다.
      return undefined;
    }
  }

  function flowReasonKo(flowId: string, channel: ChannelKind, version?: number): string {
    const r = flowResolution(flowId, channel, version);
    return r === undefined || r.code === 'ok' ? '' : `${r.code}: ${r.reasonKo}`;
  }

  /**
   * 배포본으로 골랐는데 어긋난 사실이 있으면 드러낸다. 실행을 막지는 않는다 —
   * 지정본 실행과 단계 불일치는 운영 판단일 수 있지만, **아무도 모르는 채로 돌아가는 것**은 아니다.
   */
  function noteFlowResolution(flowId: string, channel: ChannelKind, version?: number): void {
    const r = flowResolution(flowId, channel, version);
    if (r === undefined || r.code !== 'ok') return;
    if (r.pinned && r.deployedVersion !== undefined && r.deployedVersion !== r.version) {
      warnOnce('W_FLOW_NOT_DEPLOYED',
        `${channel} 채널이 배포본(v${r.deployedVersion})이 아닌 지정본 v${r.version} 으로 ${flowId} 를 실행했습니다 — `
        + '채널이 버전을 지정하면 배포·롤백이 그 채널에 닿지 않습니다(§5.3).');
    }
    if (r.staleStage !== undefined) {
      warnOnce('W_FLOW_NOT_DEPLOYED',
        `${channel} 채널 배포가 가리키는 ${flowId} v${r.version} 의 단계가 published 가 아닙니다(stage=${r.staleStage}) — `
        + '배포 기록과 리비전 단계가 어긋나 있습니다(§5.3).');
    }
  }

  /**
   * 인텐트 라우팅이 쓰는 채널 고정 조회. 라우트가 가리키는 시나리오도 세션 시작과 **같은 경로**로
   * 고른다 — 여기만 빠뜨리면 시작은 배포본인데 인텐트로 갈아탄 시나리오는 미배포 편집본이 된다.
   */
  function channelFlows(channel: ChannelKind): FlowLookup {
    return { get: (flowId, version) => resolveFlow(flowId, channel, version) };
  }

  if (typeof opts.flows.forChannel !== 'function') {
    // 종전 동작이므로 막지 않는다. 다만 이 상태에서 일어나는 일은 조용하고 되돌리기 어렵다 —
    // 편집본이 저장되는 순간 신규 통화에 나가고, 롤백을 눌러도 런타임은 여전히 번호가 가장
    // 높은 버전을 돌린다(운영자는 "되돌렸다"를 보고 있다).
    warnings.push({
      code: 'W_FLOW_DEPLOYMENT_UNBOUND',
      severity: 'warning',
      messageKo: '시나리오 조회에 채널별 배포본 경로(forChannel)가 없습니다 — 버전 선택이 stage 와 무관하게 '
        + '가장 높은 번호로 이루어집니다(§5.3). 이 상태에서는 스튜디오 편집본(draft)이 신규 통화에 나갈 수 있고, '
        + '검증·승인 게이트와 채널별 롤백이 런타임에 닿지 않습니다. 배포를 Core 밖에서 관리한다면 이 경고는 그 사실의 기록입니다.',
    });
  }

  // §9.3 폴백 정책의 테넌트. 보존 정책(아래)·라우팅 설정·엔진 기동 선언은 전부 이 검사를
  // 하는데 **폴백 정책만 아무도 보지 않았다** — 이 정책은 장애 시각에 통화 전체의 행동을
  // 정하는 값이고, 그중 `fallbackQueue` 는 고객이 **실제로 가는 곳**이다. 남의 테넌트 값이
  // 들어오면 조용히 덮어쓰지 않는다: 옆 고객사 큐 id 로 전화가 넘어가는 일이 §11.1 위반이고,
  // 그 밖의 값(`staleAfterMs`·`treatUnknownAsDown`)이 어긋나면 같은 장애에 다른 판정이 난다.
  // 되돌릴 수 있는 쪽은 기동 거절이고, 되돌릴 수 없는 쪽은 이미 넘어간 통화다.
  if (opts.policy.tenantId !== opts.scope.tenantId) {
    throw new Error(
      `폴백 정책 거부: 다른 테넌트의 §9.3 정책입니다(기대=${opts.scope.tenantId} 실제=${opts.policy.tenantId}) — `
      + '장애 시각에 고객이 가는 큐가 여기서 정해집니다 (설계서 §11.1)',
    );
  }
  // 워크스페이스는 **선언했을 때만** 본다(§13-3 — 선언하지 않은 호스트는 종전과 완전히 같다).
  if (opts.policy.workspaceId !== undefined && opts.policy.workspaceId !== opts.scope.workspaceId) {
    throw new Error(
      `폴백 정책 거부: 다른 워크스페이스의 §9.3 정책입니다(기대=${String(opts.scope.workspaceId)} 실제=${opts.policy.workspaceId}) (설계서 §11.1)`,
    );
  }

  // §9.3 정책은 "기존 IVR 로 내릴 수 있다"고 하는데 그 채널에는 **회귀 구현이 없는** 조합.
  // 인지 계층이 죽으면 `decideFallbackMode` 는 `legacy_ivr` 을 내고 `applyOutage` 는 상담사
  // 이관으로 대신하므로, 판정과 실제 행동이 갈라진 채 결과·원장에는 `legacy_ivr` 만 남는다.
  // 통화가 끊기지 않아 장애로도 잡히지 않고, **인지 계층이 죽은 시각에만** 나타나므로
  // 평시 검사로는 영영 드러나지 않는다 — `W_ROUTING_ALTERNATIVE` 와 같은 모양이고 출처가
  // 다르다(저쪽은 큐 설정의 `closedAction`, 이쪽은 폴백 정책).
  //
  // **구현 유무로 본다**(§2 — 분기와 같은 기준이어야 한다). 능력 선언(`routeToLegacyIvr`)으로
  // 보면 경고와 실제 행동이 갈라진다: 그 선언은 채널 프로파일 기본값이라 셋 다 `false` 이고,
  // 회귀가 가능한지는 **테넌트 계약**(`policy.legacyIvrAvailable`)과 포트 구현이 정한다.
  // 막지는 않는다(§13-3): 상담사 이관이 서 있으면 고객이 갈 곳은 있다.
  if (opts.policy.legacyIvrAvailable) {
    for (const reg of opts.channels) {
      if (typeof reg.port.routeToLegacyIvr === 'function') continue;
      warnings.push({
        code: 'W_FALLBACK_LEGACY_IVR',
        severity: 'warning',
        messageKo: `§9.3 폴백 정책은 기존 IVR 회귀가 가능하다고 선언했으나 ${reg.port.capabilities.adapter} 채널에 `
          + 'routeToLegacyIvr 구현이 없습니다 — 인지 계층 장애에서 이 채널의 통화는 IVR 이 아니라 '
          + '상담사 이관으로 가는데 판정(fallback.mode)은 legacy_ivr 로 남습니다. 이 채널의 실질 '
          + '폴백 경로는 agentQueueAvailable·fallbackQueue 이며, 그 값이 비어 있으면 갈 곳이 없습니다.',
      });
    }
  }

  // 잘못된 재프롬프트 정책은 통화 중이 아니라 여기서 걸러야 한다 —
  // 빈 대본은 고객에게 무음으로 나가고, 무음은 장애와 구분되지 않는다.
  if (opts.reprompt !== undefined) {
    const rIssues = validateRepromptPolicy(opts.reprompt);
    if (!repromptPolicyOk(rIssues)) {
      throw new Error(`재프롬프트 정책 거부: ${rIssues.filter((i) => i.severity === 'error').map((i) => i.messageKo).join(' / ')}`);
    }
    for (const i of rIssues) warnings.push({ severity: 'warning', code: 'W_REPROMPT_POLICY', messageKo: i.messageKo });
  }

  if (opts.timing !== undefined) {
    const tIssues = validateTurnTimingPolicy(opts.timing);
    if (!turnTimingPolicyOk(tIssues)) {
      throw new Error(`턴 타이밍 정책 거부: ${tIssues.filter((i) => i.severity === 'error').map((i) => i.messageKo).join(' / ')}`);
    }
    for (const i of tIssues) warnings.push({ severity: 'warning', code: 'W_TURN_TIMING', messageKo: i.messageKo });
  }

  // 라우팅 설정은 **배포 시점에** 거른다. 통화 중에 "갈 곳 없는 이관"으로 터지면 이미 늦고,
  // 형태 오류를 통과로 두면 오타 하나로 큐 판정이 조용히 꺼진 채 "적용했다"로 남는다.
  if (opts.routing !== undefined) {
    if (typeof opts.routing.snapshots !== 'function') {
      throw new Error('라우팅 배선 거부: 큐 스냅샷 조회가 없다 — 대기 인원을 추정하지 않는다 (설계서 §13-3)');
    }
    if (opts.routing.config.tenantId !== opts.scope.tenantId
      || (opts.routing.config.workspaceId ?? undefined) !== (opts.scope.workspaceId ?? undefined)) {
      throw new Error('라우팅 배선 거부: 다른 테넌트·워크스페이스의 라우팅 설정 (설계서 §11.1)');
    }
    const rIssues = validateRoutingConfig(opts.routing.config);
    if (rIssues.length > 0) {
      throw new Error(`라우팅 설정 거부: ${rIssues.join(' / ')}`);
    }
    // 큐에 선언된 §9.3 대안이 **그 채널에서 수행 불가**한 조합을 등록 시점에 적는다.
    // 큐가 닫히면 고객이 가는 곳은 `closedAction` 이고, 그중 채널 계약에 대응하는 능력이 있는
    // 것은 `legacy_ivr` 하나다(`routeToLegacyIvr`). 그 능력이 false 인 채널로 들어온 이관이 그
    // 큐에서 닫히면 Core 는 "기존 IVR 로 보내라"를 돌려주는데 채널은 그걸 할 수 없다고 스스로
    // 선언한 상태다 — 큐에 못 넣었으니 `transfer` 도 부르지 않으므로 **아무 일도 일어나지 않고**
    // 고객만 남는다. 평시에는 전혀 드러나지 않고 **큐가 닫힌 시각에만** 나타나므로 지금 적는다.
    // **막지 않는다**(§13-3): 큐의 `channels` 를 좁히는 것이 맞는 설정일 수 있고, 좁혀져 있지
    // 않은 것이 곧 오류라고 단정할 근거가 Core 에는 없다.
    // 닿을 수 있는 큐 판정은 `reachableQueues` 하나다 — 규칙·기본 큐·오버플로가 `channels` 를
    // 각각 다르게 보므로(기본 큐와 오버플로는 아예 보지 않는다) 여기서 다시 읽으면 어긋난다(§2).
    for (const reg of opts.channels) {
      const caps = reg.port.capabilities;
      if (caps.routeToLegacyIvr) continue;
      for (const q of reachableQueues(opts.routing.config, caps.channel)) {
        if (q.closedAction !== 'legacy_ivr') continue;
        warnings.push({
          code: 'W_ROUTING_ALTERNATIVE',
          severity: 'warning',
          messageKo: `큐 ${q.id} 의 대안은 기존 IVR 회귀(legacy_ivr)인데 ${caps.adapter} 채널은 `
            + 'routeToLegacyIvr 능력이 없습니다 — 이 큐가 닫힌 시각에 이 채널로 들어온 이관은 '
            + '상담사에게도 대안으로도 가지 못하고 아무 안내 없이 남습니다(§9.3). '
            + '큐의 channels 를 좁히거나 대안을 바꾸십시오.',
        });
      }
    }
    // 오퍼 배선도 **배포 시점에** 거른다. 정책이 틀린 채 통과시키면 모든 이관이 첫 호출에서
    // `refused` 로만 끝나고, 통화·이벤트는 정상이라 "아무에게도 제안되지 않는 상태"가 유지된다.
    const offers = opts.routing.offers;
    if (offers !== undefined) {
      if (typeof offers.candidates !== 'function') {
        throw new Error('배정 오퍼 배선 거부: 후보 상담사 조회가 없다 — Core 는 상담사를 고르지 않는다 (설계서 §13-3)');
      }
      if (typeof offers.newOfferId !== 'function') {
        throw new Error('배정 오퍼 배선 거부: 오퍼 id 생성기가 없다 — Core 는 id 를 만들지 않는다 (설계서 §13-3·§10.3)');
      }
      const pIssues = offerPolicyIssues(offers.policy);
      if (pIssues.length > 0) {
        throw new Error(`배정 오퍼 정책 거부: ${pIssues.join(' / ')}`);
      }
    } else if (opts.channels.some((r) => r.port.capabilities.transferToAgent)) {
      warnings.push({
        code: 'W_AGENT_OFFER_UNBOUND',
        severity: 'warning',
        messageKo: '큐 배정은 배선됐으나 배정 오퍼 배선(routing.offers)이 없습니다 — 고객은 큐에 '
          + '들어간 채 어느 상담사에게도 제안되지 않습니다(§2·§9.3). 운영 화면에는 "대기 중"으로만 '
          + '보이고, 회차 계수·중복 오퍼 차단·재배정 한도 소진 후 대안 수렴이 모두 돌지 않습니다.',
      });
    }
  } else if (opts.channels.some((r) => r.port.capabilities.transferToAgent)) {
    // 이관이 가능한 채널이 붙어 있는데 큐 판정이 없으면, 시나리오에 적힌 큐 id 가 그대로 나간다 —
    // 닫힌 큐·넘친 큐·오탈자 큐에도 "상담사 연결 중"이 안내되고 §9.3 대안은 건너뛰어진다.
    warnings.push({
      code: 'W_ROUTING_UNBOUND',
      severity: 'warning',
      messageKo: '상담사 이관이 가능한 채널이 등록됐으나 큐 배정 배선(routing)이 없습니다 — '
        + '큐 선택·수용 판정이 한 번도 돌지 않고 시나리오에 적힌 큐 id 가 그대로 전달됩니다(§2·§9.3). '
        + '업무시간이 끝난 큐·대기가 넘친 큐에도 연결을 안내하게 되며, 그 큐에 선언된 '
        + '대안(콜백·음성사서함·기존 IVR)은 통째로 건너뛰어집니다.',
    });
  }

  // 전환 배선도 **배포 시점에** 거른다. 형태 오류를 통과로 두면 오타 하나로 토큰 요구가 조용히 꺼진 채
  // "적용했다"로 남고, 그 상태의 합류는 id 하나로 통과한다(라우팅·요청 제한기와 같은 규칙).
  if (opts.channelSwitch !== undefined) {
    const cs = opts.channelSwitch;
    if (typeof cs.newToken !== 'function') {
      throw new Error('채널 전환 배선 거부: 토큰 발급기가 없다 — Core 는 세션 열쇠를 만들지 않는다 (설계서 §13-3·§10.3)');
    }
    if (typeof cs.reachable !== 'function') {
      throw new Error('채널 전환 배선 거부: 고객 단말 수신 가능 여부를 확인할 길이 없다 — 추정하지 않는다 (설계서 §13-3)');
    }
    if (!Number.isFinite(cs.ttlMs) || cs.ttlMs <= 0) {
      throw new Error('채널 전환 배선 거부: 유효기간(ttlMs)이 양수가 아니다 — 만료 없는 링크는 영구 열쇠다 (설계서 §5.2)');
    }
    if (!cs.invites || typeof cs.invites.issue !== 'function' || typeof cs.invites.redeem !== 'function') {
      throw new Error('채널 전환 배선 거부: 초대 레지스트리가 없다 (설계서 §5.2)');
    }
    if (!Array.isArray(cs.carry?.allow)) {
      throw new Error('채널 전환 배선 거부: 승계 슬롯 allowlist 가 배열이 아니다 (설계서 §10.3)');
    }
  }

  /**
   * 배선 시점에 **복사해 둔** 고지 문안 등록부(§10.1).
   *
   * 호스트가 넘긴 배열을 그대로 들고 있으면, 그 배열을 나중에 비우거나 갈아끼웠을 때
   * 기동 시점 검사를 통과한 판정이 통화 중에 뒤집힌다 — 경고에는 "문제없음"이 남아 있는데
   * 실제로는 막히는(또는 그 반대의) 상태이고, 그 어긋남은 어디에도 예외로 나타나지 않는다.
   * 복사하면 **검사한 것과 판정하는 것이 같은 문서**임이 구조로 보장된다(§2).
   */
  let legalDocs: readonly LegalDocument[] | undefined;

  // 동의 배선도 **배포 시점에** 거른다. 미승인 정책·다른 테넌트 정책을 통과시키면 그 정책으로
  // 받은 동의가 이력에 쌓이는데, 그건 동의가 아니다(§10.1) — 그리고 통화·이벤트 어디에서도
  // 터지지 않으므로 점검에서 처음 드러난다(고지·라우팅·전환과 같은 규칙).
  if (opts.consent !== undefined) {
    const cb = opts.consent;
    if (typeof cb.subjectRef !== 'function') {
      throw new Error('동의 배선 거부: 주체 참조 조회(subjectRef)가 없다 — Core 는 동의 주체를 만들지 않는다 (설계서 §10.3·§13-3)');
    }
    if (!cb.records || typeof cb.records.list !== 'function' || typeof cb.records.append !== 'function') {
      throw new Error('동의 배선 거부: 동의 이력 저장소(records)가 없다 — Core 는 동의를 영속화하지 않는다 (설계서 §6.2)');
    }
    const cIssues = validateConsentBinding(cb.policy, opts.scope);
    if (cIssues.errorsKo.length > 0) {
      throw new Error(`동의 배선 거부: ${cIssues.errorsKo.join(' / ')}`);
    }
    for (const messageKo of cIssues.warningsKo) warnings.push({ code: 'W_CONSENT', severity: 'warning', messageKo });
    // 출처가 둘이면 **어느 쪽이 이겼는지가 화면마다 달라진다**(§2 의 이중 관리). 호스트가 자기
    // 컨텍스트를 만들고 있다면 Core 가 조용히 덮어쓰지 않고 설정 오류로 본다.
    if (opts.connectors?.consent !== undefined) {
      throw new Error(
        '동의 배선 거부: 커넥터 배선에 이미 동의 컨텍스트(connectors.consent)가 있다 — '
        + '같은 판정의 출처가 둘이면 어느 쪽이 적용됐는지 알 수 없다 (설계서 §10.1·§2)',
      );
    }

    // 고지 문안 등록부(§10.1). **형태 오류는 거부하고 문안 결함은 경고다** — 앞은 배선이 조용히
    // 꺼지는 경로이고(오타 하나로 검사가 돌지 않은 채 "적용했다"로 남는다), 뒤는 Core 가 대신
    // 결정할 일이 아니다(문안 하나가 미확정이라고 전 채널을 멈추면 원인과 증상이 아주 멀어진다).
    const lb = cb.legal;
    if (lb !== undefined) {
      if (!Array.isArray(lb.docs)) {
        throw new Error(
          '동의 배선 거부: 고지 문안 등록부(consent.legal.docs)가 배열이 아니다 — '
          + 'LegalRegistry.list() 결과를 그대로 넘긴다 (설계서 §10.1)',
        );
      }
      if (typeof lb.locale !== 'string' || lb.locale.trim() === '') {
        throw new Error(
          '동의 배선 거부: 고지 문안 언어(consent.legal.locale)가 없다 — '
          + 'Core 는 기본 언어를 만들지 않는다 (설계서 §13-3)',
        );
      }
      if (lb.acceptances !== undefined && typeof lb.acceptances !== 'function') {
        throw new Error(
          '동의 배선 거부: 문안 수락 기록 조회(consent.legal.acceptances)가 함수가 아니다 (설계서 §10.1)',
        );
      }
      legalDocs = [...lb.docs];
      // 판정은 `checkConsentNotices` 하나다 — 초안·미시행·버전 불일치 규칙을 여기서 다시 쓰지 않는다(§2).
      // 검사와 통화 중 판정이 **같은 사본**을 보므로 경고와 실제 동작이 어긋나지 않는다.
      const notices = checkConsentNotices({
        scope: opts.scope, policy: cb.policy, docs: legalDocs, locale: lb.locale, now: now(),
      });
      for (const messageKo of notices.blockersKo) {
        warnings.push({
          code: 'W_LEGAL_NOTICE',
          severity: 'warning',
          messageKo: `${messageKo} — 이 목적이 필수라면 통화 중 개인정보 조회(§6.1)가 `
            + 'legal_notice_not_final 로 막힙니다(업무시스템은 멀쩡하므로 장애로 보이지 않습니다).',
        });
      }
      for (const messageKo of notices.unverifiableKo) {
        // 확인하지 못한 것을 통과로도 실패로도 적지 않는다(§13-3) — 다만 사라지게 두지도 않는다.
        warnings.push({ code: 'W_LEGAL_NOTICE', severity: 'warning', messageKo });
      }
    } else {
      warnings.push({
        code: 'W_LEGAL_UNBOUND',
        severity: 'warning',
        messageKo: '동의는 배선됐으나 고지 문안 등록부(consent.legal)가 없습니다 — 통화 경로에서 '
          + '확정본 조회가 한 번도 일어나지 않습니다(§10.1). 초안 문안·시행일 전 문안으로 받은 동의, '
          + '처리방침이 개정됐는데 정책 버전이 그대로라 여전히 유효로 읽히는 동의가 전부 정상으로 '
          + '쌓이고, §6.1 근거 판정에는 "문안을 확인하지 않았다"만 적힙니다 — 그 기록은 "확인했고 '
          + '문제없었다"와 구분되지 않습니다. 드러나는 시점이 분쟁·점검이면 그 기간의 동의 전부가 대상입니다.',
      });
    }
  }

  // 보존 게이트(§8.2)도 **배포 시점에** 묻는다. 통화 중에 물으면 거절이 곧 무음이고, 분류
  // 집합은 세션마다 달라지지 않는다. **Core 가 실제로 쓰는 분류만** 기동 조건으로 삼는 것이
  // 요점이다 — 녹취(`recording`)·RAG 색인(`vector_index`)·감사로그(`audit_log`)를 쓰는 것은
  // 채널 저장소·벡터 DB·감사 저장소이고, 그쪽이 자기 저장 경로에서 같은 `canStore` 를 물어야
  // 한다. 여기서 대신 물어 통과시키면 "확인했다"는 남지만 확인한 주체는 아무도 없다(§13-3).
  // (녹취만은 음성 채널이 등록된 경우에 **경고로** 드러낸다 — 아래 주석 참조. 막지는 않는다.)
  if (opts.retention !== undefined) {
    const policy = opts.retention.policy;
    if (policy === null || typeof policy !== 'object') {
      throw new Error(
        '보존 배선 거부: 보존 정책이 없다 — 보존기간·근거·승인은 테넌트 법적 검토 결과이며 '
        + 'Core 가 만들지 않는다 (설계서 §8.2·§13-3)',
      );
    }
    if (policy.tenantId !== opts.scope.tenantId
      || (policy.workspaceId ?? undefined) !== (opts.scope.workspaceId ?? undefined)) {
      // 조용히 덮어쓰지 않는다: 남의 기한으로 이 테넌트의 개인정보를 재면 두 방향 모두 틀린다 —
      // 길면 기한이 지난 개인정보가 남고, 짧으면 분쟁 중인 건이 먼저 지워진다(되돌릴 수 없다).
      throw new Error('보존 배선 거부: 다른 테넌트·워크스페이스의 보존 정책 (설계서 §11.1)');
    }
    // 분류마다 **Core 가 그것을 왜 쓰는지**를 같이 적는다 — 거절 메시지만 보고 "우리는 그걸
    // 저장하지 않는데"로 막히면 운영은 규칙을 지어내거나 배선을 떼는 쪽으로 간다.
    const written: { dataClass: DataClass; whyKo: string }[] = [
      { dataClass: 'transcript_masked', whyKo: '세션에 마스킹된 턴을 쌓는다 — 이관 요약의 원천이다(§2·§10.3)' },
    ];
    if (opts.bus !== undefined) {
      written.push({ dataClass: 'interaction_event', whyKo: '턴마다 §8.1 이벤트를 발행한다' });
    }
    if (opts.consent !== undefined) {
      written.push({ dataClass: 'consent_record', whyKo: '동의 배선이 동의 기록을 이력 저장소에 남긴다(§10.1)' });
    }
    if (opts.retention.collectsPii !== false) {
      written.push({
        dataClass: 'pii_field',
        whyKo: '세션 슬롯에 고객이 입력한 값이 원문으로 남는다 — 개인정보를 수집하지 않는 테넌트는 '
          + 'retention.collectsPii: false 로 선언한다',
      });
    }
    const refusals: string[] = [];
    for (const w of written) {
      const verdict = canStore(policy, w.dataClass);
      if (verdict.allowed) {
        if (verdict.warningKo !== undefined) {
          warnings.push({
            code: 'W_RETENTION_NO_RULE',
            severity: 'warning',
            messageKo: `${verdict.warningKo} — ${w.whyKo}`,
          });
        }
        continue;
      }
      refusals.push(`${verdict.code}: ${verdict.reasonKo} (${w.whyKo})`);
    }
    // 녹취는 Core 가 저장하지 않으므로 **막지 않는다** — 막는 것은 그 저장소(채널)의 몫이고,
    // 여기서 막으면 녹음을 끄고 운영하는 테넌트의 기동까지 같이 막힌다. 다만 음성 채널이 등록된
    // 상태에서 녹취 규칙이 없다는 사실은 드러낸다: `recording` 은 §8.1 원장에 흔적이 없는 분류라
    // (`LEDGER_BLIND_CLASSES`) 규칙·선언이 없으면 **기한이 지난 통화 녹음이 파기 목록에 한 번도
    // 올라오지 않고**, 그 상태가 스윕 결과에서는 "오늘도 깨끗함"으로 보인다. 파기 투영이
    // `voiceSessions` 로 적는 것과 같은 사실을 **첫 통화보다 먼저** 적는 것이다.
    const recording = canStore(policy, 'recording');
    if (!recording.allowed && opts.channels.some((r) => r.port.capabilities.channel === 'voice')) {
      warnings.push({
        code: 'W_RETENTION_NO_RULE',
        severity: 'warning',
        messageKo: `음성 채널이 등록됐으나 녹취 보존 규칙이 성립하지 않습니다(${recording.code}) — 녹취는 채널 `
          + '저장소가 저장하므로 Core 는 기동을 막지 않습니다. 다만 §8.1 원장에는 녹취의 흔적이 없어, '
          + '규칙과 파기 선언이 없으면 기한이 지난 통화 녹음이 파기 목록에 한 번도 올라오지 않습니다 (설계서 §8.2)',
      });
    }
    // **전부 모아서** 거절한다 — 하나씩 드러내면 운영은 고치고 재배포하기를 분류 수만큼 되풀이한다.
    if (refusals.length > 0) {
      throw new Error(`보존 배선 거부: ${refusals.join(' / ')}`);
    }
  } else {
    warnings.push({
      code: 'W_RETENTION_UNBOUND',
      severity: 'warning',
      messageKo: '보존 정책이 배선되지 않았습니다(retention) — 저장해도 되는지 한 번도 묻지 않습니다(§8.2). '
        + '이 상태에서 보존기간이 정해지지 않은 분류의 데이터가 쌓이면 기산 시점을 되돌릴 수 없고, '
        + '파기 판정은 그 건을 영구히 보류(blocked)로 적습니다 — 지울 근거도 기한도 없는 개인정보가 남습니다. '
        + '통화·이벤트·헬스는 전부 정상이라 드러나는 시점이 감독기관 점검이면 지나간 통화 전부가 대상입니다.',
    });
  }

  /**
   * 호스트의 주체 참조 조회. **던져도 통화를 끊지 않는다** — "없음"으로 보고, 그 상태에서
   * 개인정보 조회만 막힌다(안전한 방향). 빈 문자열은 값이 아니라 누락으로 읽는다.
   */
  function consentSubjectRef(interactionId: string): string | undefined {
    const cb = opts.consent;
    if (!cb) return undefined;
    try {
      const ref = cb.subjectRef(interactionId);
      return typeof ref === 'string' && ref.trim() !== '' ? ref : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 커넥터 펌프에 넘기는 배선. 동의가 배선돼 있으면 **Core 가 동의 컨텍스트를 만들어 끼운다** —
   * §6.1 게이트(`executeConnector`)는 이미 있었지만 그 입력을 만드는 코드가 저장소에 0건이어서
   * 개인정보 파라미터를 선언한 커넥터는 통화 중 **언제나** `consent_context_missing` 으로 막혔다.
   * 호스트가 자기 컨텍스트를 넘기고 있으면 덮어쓰지 않는다(위에서 설정 오류로 거부된다).
   */
  /**
   * 이 주체의 §10.1 문안 검사 재료. 등록부는 배선 시점에 고정된 배열 그대로 넘기고,
   * 수락 기록만 주체별로 조회한다.
   *
   * 조회가 던지면 **기록 없음(빈 배열)** 으로 본다 — `undefined` 로 떨어뜨리면 판정이
   * "수락 기록을 선언하지 않았다"로 적히는데, 선언은 했고 조회가 실패한 것이라 그 기록은
   * 거짓이다. 빈 배열이면 `acceptanceStatus` 가 `none` 으로 적고(막지 않는다), 사실과 같다.
   */
  function consentLegalContext(subjectRef: string): LegalNoticeContext | undefined {
    const lb = opts.consent?.legal;
    if (lb === undefined || legalDocs === undefined) return undefined;
    let acceptances: readonly AcceptanceRecord[] | undefined;
    if (lb.acceptances !== undefined) {
      try {
        const rows = lb.acceptances(subjectRef);
        acceptances = Array.isArray(rows) ? rows : [];
      } catch {
        acceptances = [];
      }
    }
    return { docs: legalDocs, locale: lb.locale, ...(acceptances !== undefined ? { acceptances } : {}) };
  }

  const connectorBinding: ConnectorPumpBinding | undefined = (() => {
    const b = opts.connectors;
    if (b === undefined) return undefined;
    const cb = opts.consent;
    if (cb === undefined || b.consent !== undefined) return b;
    return {
      ...b,
      consent: ({ interactionId }) => {
        const subjectRef = consentSubjectRef(interactionId);
        return buildConsentLookup(
          cb.policy, cb.records, subjectRef, now(),
          subjectRef === undefined ? undefined : consentLegalContext(subjectRef),
        );
      },
    };
  })();

  for (const reg of opts.channels) {
    const issues = validateRegistration(reg);
    if (!registrationOk(issues)) {
      throw new Error(`채널 등록 거부(${reg.port.id}): ${issues.filter((i) => i.severity === 'error').map((i) => i.messageKo).join(' / ')}`);
    }
    warnings.push(...issues.filter((i) => i.severity === 'warning'));
    regs.set(reg.port.id, reg);
    declared.set(reg.port.id, new Set(reg.reportsComponents));
  }

  /** 등록된 채널들이 올리는 컴포넌트의 합집합. readiness·복구 프로브가 **같은 목록**을 본다(§2). */
  const watched = new Set<ComponentId>([...declared.values()].flatMap((set) => [...set]));

  /**
   * Core 가 **이번 턴에 엔진을 실제로 불렀는지** 세는 계수기(§11.2).
   *
   * 왜 세는가: `engineRuntime.lastUsage()` 는 조각당 **마지막 호출**의 실측이다. 호출 여부를 보지
   * 않고 매 턴 읽으면 엔진을 부르지 않은 턴(DTMF 선택·무입력·커넥터 재개)이 **직전 턴의 값을 한 번
   * 더** 싣는다. 그 이중 계상은 예외가 아니라 과다청구 방향의 **그럴듯한 숫자**이고, 몇 주 뒤 대사에서
   * 공급사 청구서보다 우리 수량이 많은 상태로 나타난다. 값 비교로는 가를 수 없다 — 같은 발화는 같은
   * 토큰 수를 내므로 "안 바뀌었다"가 곧 "안 불렀다"가 아니다(그렇게 가르면 반대로 실측이 사라진다).
   *
   * **엔진 기동이 만든 조각만** 센다. 호스트가 조립한 분류기·답변기·검색기는 `lastUsage()` 에 닿지
   * 않으므로 세어도 읽을 값이 없고, 그 사실은 이미 경고로 적힌다(`W_KNOWLEDGE_PARTS`).
   * `plan()` 은 실호출이 없으므로 세지 않는다.
   */
  let engineCalls = 0;

  function countedClassifier(inner: IntentClassifier): IntentClassifier {
    return {
      contractVersion: inner.contractVersion,
      engine: inner.engine,
      plan: (r) => inner.plan(r),
      classify: (r) => { engineCalls += 1; return inner.classify(r); },
    };
  }

  function countedAnswerer(inner: Answerer): Answerer {
    return {
      contractVersion: inner.contractVersion,
      engine: inner.engine,
      plan: (r) => inner.plan(r),
      answer: (r) => { engineCalls += 1; return inner.answer(r); },
    };
  }

  function countedEmbedder(inner: Embedder): Embedder {
    return {
      contractVersion: inner.contractVersion,
      engine: inner.engine,
      embedTexts: (t) => { engineCalls += 1; return inner.embedTexts(t); },
      embedChunks: (c) => { engineCalls += 1; return inner.embedChunks(c); },
      embedQuery: (q) => { engineCalls += 1; return inner.embedQuery(q); },
    };
  }

  // 엔진 기동(§6.2·§9.3). **레지스트리와 시계를 호스트에게서 받지 않는다** — 런타임의 것을
  // 그대로 넘긴다(ConversationCoreOptions.engines 주석). 테넌트가 어긋나면 거부한다(§11.1).
  let engineRuntime: EngineRuntime | undefined;
  if (opts.engines !== undefined) {
    const decl = opts.engines;
    const declScope = decl.scope;
    if (declScope === undefined || declScope.tenantId !== opts.scope.tenantId
        || (declScope.workspaceId ?? undefined) !== (opts.scope.workspaceId ?? undefined)) {
      // 조용히 덮어쓰지 않는다: 다른 테넌트의 엔진 선언으로 기동되면 그 테넌트의 계약(국외이전·
      // 모델·요율)이 이 테넌트의 통화에 적용되고, 그 사실은 어디에도 예외로 나타나지 않는다.
      throw new Error('엔진 기동 거부: 선언의 테넌트가 런타임과 다릅니다 — 다른 테넌트의 엔진 계약으로 통화를 처리할 수 없습니다 (설계서 §11.1)');
    }
    engineRuntime = startEngines(decl, {
      // 통화가 올린 샘플과 **같은 레지스트리**다. 엔진 실패가 여기 들어와야 §9.3 판정이 본다.
      record: (sample) => { opts.health.record(sample); },
      // 낡음 판정이 폴백과 같은 기준이어야 하므로 런타임의 시계 하나다(§2).
      now,
    });
  } else {
    // 종전 동작이므로 막지 않는다. 다만 이 상태에서 엔진이 죽으면 §9.3 가 그 사실을 영영 모른다 —
    // 채널이 매체(telephony·messaging)만 올리고 있으면 인지 계층은 관측되지 않는 셈이다.
    warnings.push({
      code: 'W_ENGINES_UNBOUND',
      severity: 'warning',
      messageKo: '엔진이 기동 선언으로 배선되지 않았습니다 — 엔진 실패가 §9.3 헬스 레지스트리에 닿지 않아 '
        + '엔진이 전부 죽은 상태에서도 폴백 판정은 normal 입니다 (설계서 §9.3·§6.2)',
    });
  }

  // 복구 프로브 배선(§9.3). 레지스트리·정책·시계·감시 목록은 **Core 가 강제한다**(RecoveryBinding 주석).
  let recovery: RecoveryProbeRunner | undefined;
  if (opts.recovery !== undefined) {
    const hostSchedules = Array.isArray(opts.recovery.schedules) ? opts.recovery.schedules : [];
    const engineDecls = opts.recovery.engineProbes;
    if (engineDecls !== undefined && (!Array.isArray(engineDecls) || engineDecls.length === 0)) {
      throw new Error('복구 프로브 배선 거부: engineProbes 가 빈 목록입니다 — 선언만 남은 배선은 "확인하고 있다"로 읽힙니다 (설계서 §13-3)');
    }
    if (engineDecls !== undefined && engineRuntime === undefined) {
      throw new Error('복구 프로브 배선 거부: 엔진 프로브를 선언했는데 엔진이 기동 선언으로 배선되지 않았습니다 — 찌를 대상이 없습니다 (설계서 §6.2·§9.3)');
    }
    if (engineDecls !== undefined && engineRuntime?.probes === undefined) {
      throw new Error('복구 프로브 배선 거부: 엔진 프로브를 선언했는데 엔진 기동에 probes 선언이 없습니다 — 확인용 합성 입력은 Core 가 만들지 않습니다 (설계서 §13-3·§10.3)');
    }
    // 엔진 프로브는 **기동이 만든 것만** 쓴다. 못 만든 컴포넌트는 가짜를 끼우지 않고 드러낸다.
    const engineSchedules: ProbeSchedule[] = [];
    if (engineDecls !== undefined) {
      const made = new Map((engineRuntime?.probes?.probes ?? []).map((p) => [p.component, p]));
      const missing: string[] = [];
      for (const d of engineDecls) {
        const probe = d === null || d === undefined ? undefined : made.get(d.component);
        if (probe === undefined) {
          const skip = (engineRuntime?.probes?.skipped ?? []).find((s) => s.component === d?.component);
          missing.push(`${String(d?.component)}: ${skip?.reasonKo ?? '엔진 기동이 그 컴포넌트 프로브를 만들지 않았습니다'}`);
          continue;
        }
        engineSchedules.push({
          probe,
          ...(d.intervalMs !== undefined ? { intervalMs: d.intervalMs } : {}),
          ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}),
        });
      }
      if (missing.length > 0) {
        warnings.push({
          code: 'W_ENGINE_PROBES',
          severity: 'warning',
          messageKo: `엔진 복구 프로브를 선언했으나 만들어지지 않은 컴포넌트가 있습니다 — ${missing.join(' · ')}`
            + ' (돌아가지 않는 프로브를 끼우지 않았습니다, 설계서 §9.3·§13-3)',
        });
      }
    }
    if (hostSchedules.length === 0 && engineDecls === undefined) {
      throw new Error('복구 프로브 배선 거부: 프로브가 없습니다 — 빈 배선은 "확인하고 있다"로 남습니다 (설계서 §13-3)');
    }
    // **선언했는데 만들어지지 않은 상태로는 막지 않는다.** 승인 전(dry_run)이 기본 상태이므로
    // 막으면 승인 전 테넌트는 채널 등록 자체가 실패한다 — 사유는 위 경고로 이미 드러났고,
    // 러너는 돌면서 보고서의 `unprobed` 로 "확인할 길이 없다"를 계속 적는다(§9.3·§13-3).
    const schedules = [...hostSchedules, ...engineSchedules];
    for (const sched of schedules) {
      const component = sched?.probe?.component;
      // 등록된 채널이 올리지 않는 컴포넌트의 프로브는 **거부**한다. `reportHealth` 는 선언하지
      // 않은 컴포넌트의 샘플을 버리는데(§9.3 — 아무 채널이나 전체 폴백을 유발할 수 없다),
      // 프로브는 레지스트리에 **직접** 쓰므로 그 방어선을 우회한다. 그 상태에서 프로브 한 개가
      // `down` 을 적으면 `CHANNEL_DEPENDENCIES` 를 통해 멀쩡한 채널까지 내려간다.
      if (component !== undefined && !watched.has(component)) {
        throw new Error(`복구 프로브 배선 거부: ${component} 는 등록된 채널이 올리지 않는 컴포넌트입니다 — 프로브는 레지스트리에 직접 써서 선언 검사를 우회합니다 (설계서 §9.3)`);
      }
    }
    recovery = createRecoveryProbeRunner({
      schedules,
      registry: opts.health,
      policy: opts.policy,
      now,
      watch: [...watched],
      ...(opts.recovery.monotonic !== undefined ? { monotonic: opts.recovery.monotonic } : {}),
      ...(opts.recovery.confirmSuccesses !== undefined ? { confirmSuccesses: opts.recovery.confirmSuccesses } : {}),
      ...(opts.recovery.scheduler !== undefined ? { scheduler: opts.recovery.scheduler } : {}),
    });
    // 엔진은 기동됐고 러너도 돌지만 **엔진 컴포넌트 프로브가 하나도 없는** 상태는 조용하다.
    // 그 컴포넌트가 `down` 이 되면 통화가 내려가 호출이 멈추고 — 새 샘플을 만들 주체가 없어
    // 폴백이 풀리지 않는다. 러너 보고서의 `unprobed` 는 **이미 나빠진 뒤에야** 보이므로,
    // 첫 고객의 턴보다 먼저 드러낸다(§9.3).
    if (engineRuntime !== undefined) {
      const covered = new Set(schedules.map((s) => s.probe.component));
      const bare = engineRuntime.components.filter((c) => !covered.has(c));
      if (bare.length > 0) {
        warnings.push({
          code: 'W_ENGINE_PROBES_UNBOUND',
          severity: 'warning',
          messageKo: `엔진 컴포넌트에 복구 프로브가 없습니다: ${bare.join(', ')} — 그 컴포넌트가 down 이 되면 `
            + '엔진 호출이 멈춰 새 샘플이 생기지 않으므로 폴백에서 빠져나올 수 없습니다 (설계서 §9.3)',
        });
      }
    }
  } else if (watched.size > 0) {
    warnings.push({
      code: 'W_RECOVERY_UNBOUND',
      severity: 'warning',
      messageKo: '복구 프로브가 배선되지 않았습니다 — 폴백이 걸리면 엔진 호출이 멈춰 새 샘플이 생기지 않으므로, 폴백에서 빠져나오는 길이 없습니다 (설계서 §9.3)',
    });
  }

  // 인텐트 배선도 **배포 시점에** 거른다. 통화 중에 "카탈로그에 없는 인텐트"로 터지면 이미 늦고,
  // 형태 오류를 통과로 두면 오타 하나로 인텐트 진입이 조용히 꺼진 채 "적용했다"로 남는다
  // (라우팅·전환·요청 제한기와 같은 규칙). 라우팅 표 검증은 `validateIntentRouting` 하나만 쓴다(§2).
  /**
   * 인텐트 분류기 출처는 **하나**다(§2). 엔진 기동이 분류기를 만들었으면 그것을 쓰고,
   * 호스트가 직접 주입했으면 그것을 쓴다 — 둘 다면 거부한다(IntentBinding.classifier 주석).
   */
  let intentClassifier: IntentClassifier | undefined;
  if (opts.intent !== undefined) {
    const it = opts.intent;
    if (it.classifier !== undefined && engineRuntime?.classifier !== undefined) {
      throw new Error('인텐트 배선 거부: 분류기가 두 곳에서 옵니다(engines.intent + intent.classifier) — 호스트가 만든 분류기는 재시도·대체·§9.3 샘플에 닿지 않습니다 (설계서 §2·§9.3)');
    }
    intentClassifier = it.classifier ?? engineRuntime?.classifier;
    if (!intentClassifier || typeof intentClassifier.classify !== 'function') {
      throw new Error('인텐트 배선 거부: 분류기(classifier)가 없습니다 — Core 는 엔진을 직접 부르지 않습니다 (설계서 §6.2)');
    }
    // 엔진 기동이 만든 분류기만 감싼다 — 호스트 조립본은 `lastUsage()` 에 닿지 않아 셀 이유가 없다.
    if (it.classifier === undefined) intentClassifier = countedClassifier(intentClassifier);
    if (typeof it.clarifyPrompt !== 'string' || it.clarifyPrompt.trim() === '') {
      throw new Error('인텐트 배선 거부: 명확화 문구(clarifyPrompt)가 없습니다 — Core 는 질문 문안을 만들지 않습니다 (설계서 §13-3)');
    }
    for (const [label, owner] of [['카탈로그', it.catalog], ['정책', it.policy], ['라우팅 표', it.table]] as const) {
      if (owner.tenantId !== opts.scope.tenantId) {
        throw new Error(`인텐트 배선 거부: 다른 테넌트의 ${label} 입니다 — 고객이 남의 회사 시나리오를 듣게 됩니다 (설계서 §11.1)`);
      }
      if (owner.workspaceId !== undefined && owner.workspaceId !== opts.scope.workspaceId) {
        throw new Error(`인텐트 배선 거부: 다른 워크스페이스의 ${label} 입니다 (설계서 §11.1)`);
      }
    }
    const catalogErrors = validateIntentCatalog(it.catalog);
    if (catalogErrors.length > 0) throw new Error(`인텐트 카탈로그 거부: ${catalogErrors.join(' / ')}`);
    const policyErrors = validateIntentPolicy(it.policy);
    if (policyErrors.length > 0) throw new Error(`인텐트 정책 거부: ${policyErrors.join(' / ')}`);

    // 라우트가 가리키는 시나리오의 **사유를 아는** 조회면 `validateIntentRouting` 보다 먼저 본다.
    // 그 함수는 조회가 비면 "없는 시나리오"라고 적는데, 편집본만 있거나 버전이 어긋난 경우
    // 그건 **틀린 진단**이다 — 운영자는 오타를 찾으러 가고 원인은 승인 누락이다.
    // `not_deployed` 는 단계적 배포(§5.3)의 정상 상태이므로 여기서 막지 않는다(아래에서 경고로 남는다).
    for (const route of it.table.routes) {
      for (const reg of opts.channels) {
        const r = flowResolution(route.flowId, reg.port.capabilities.channel, route.flowVersion);
        if (r === undefined || r.code === 'ok' || r.code === 'not_deployed' || r.code === 'no_revision') continue;
        throw new Error(`인텐트 라우팅 거부: ${route.intent} → ${route.flowId} (${r.code}: ${r.reasonKo})`);
      }
    }

    const rIssues = validateIntentRouting(it.table, it.catalog, opts.flows);
    if (!intentRoutingOk(rIssues)) {
      throw new Error(`인텐트 라우팅 거부: ${rIssues.filter((i) => i.severity === 'error').map((i) => i.messageKo).join(' / ')}`);
    }
    // 라우트 없는 활성 인텐트는 막지 않되 **반드시 드러낸다** — 확정돼도 갈 곳이 없다.
    for (const i of rIssues) warnings.push({ code: 'W_INTENT_ROUTING', severity: 'warning', messageKo: i.messageKo });

    // 라우트가 가리키는 시나리오도 `start()` 와 **같은 규칙**으로 미리 본다(§5.3).
    // 여기서 안 보면 그 시나리오는 **인텐트가 확정된 통화 한복판에서** 처음 검증되고,
    // 렌더 불가 노드·오타 커넥터는 그때 막힌다 — 고객은 이미 회선에 있다.
    for (const route of it.table.routes) {
      // 채널마다 따로 본다 — 배포 단위가 "(Flow, 채널)"이므로 같은 라우트가 콜봇에서는 되고
      // 챗봇에서는 안 되는 상태가 §5.3 의 **정상** 운영이다(단계적 배포).
      const resolved = new Set<Flow>();
      for (const reg of opts.channels) {
        const ch = reg.port.capabilities.channel;
        const flow = resolveFlow(route.flowId, ch, route.flowVersion);
        if (!flow) {
          // 리비전이 아예 없는 경우는 위 `validateIntentRouting` 이 이미 오류로 잡았다.
          // 여기 남는 것은 "있는데 이 채널에 배포되지 않았다" — 막지 않고 드러낸다.
          // 그 채널에서 이 인텐트가 확정되면 `unrouted` 로 이관되며, 그때 원인을 알 수 있어야 한다.
          const reasonKo = flowReasonKo(route.flowId, ch, route.flowVersion);
          if (reasonKo !== '') {
            warnings.push({
              code: 'W_FLOW_NOT_DEPLOYED',
              severity: 'warning',
              messageKo: `인텐트 ${route.intent} → ${route.flowId} 를 ${ch} 채널에서 시작할 수 없습니다(${reasonKo}). `
                + '그 채널에서 이 인텐트가 확정되면 상담사 이관으로 떨어집니다(§5.3).',
            });
          }
          continue;
        }
        resolved.add(flow);
        const unsupported = checkFlowSupported(flow, reg.port.capabilities).filter((i) => i.severity === 'error');
        if (unsupported.length > 0) {
          throw new Error(
            `인텐트 라우팅 거부: ${route.intent} → ${flow.id} 를 ${reg.port.id} 채널에서 실행할 수 없습니다: `
            + unsupported.map((i) => i.messageKo).join(' / '),
          );
        }
      }
      if (opts.connectors) {
        for (const flow of resolved) {
          const missing = missingConnectors(flow, opts.connectors.connectors);
          if (missing.length > 0) {
            throw new Error(
              `인텐트 라우팅 거부: ${route.intent} → ${flow.id} 에 선언되지 않은 커넥터가 있습니다: `
              + missing.map((m) => `${m.nodeId}→${m.connectorId}`).join(', ') + ' (설계서 §6.1)',
            );
          }
        }
      }
    }
  }

  // 지식 응대 배선도 **배포 시점에** 거른다. 성립하지 않는 정책(minHits > topK 등)을 통과시키면
  // 통화 중에 `config_error` 로만 나타나고, 그 상태의 증상은 "모든 질문에 답을 못 한다"다 —
  // 장애로 보이지 않아서 더 오래 산다(라우팅·전환·인텐트 배선과 같은 규칙).
  /**
   * 검색기·답변기 출처도 **각각 하나**다(§2) — 분류기와 같은 규칙이다. 엔진 기동이 만들었으면
   * 그것을 쓰고, 호스트가 직접 주입했으면 그것을 쓴다. 둘 다면 거부한다.
   *
   * 호스트 조립을 막지는 않는다(종전 동작이다). 다만 엔진이 기동된 상태에서 호스트 조립을
   * 섞으면 그 경로만 재시도·대체·§9.3 샘플을 비껴가므로 **경고로 드러낸다** — 비껴간 경로로
   * 나가는 것이 하필 고객 질문과 지식 원문이다(§10.3).
   */
  let knowledgeParts: { retriever: Retriever; answerer: Answerer } | undefined;
  if (opts.knowledge !== undefined) {
    const kb = opts.knowledge;
    if (kb.retriever !== undefined && kb.search !== undefined) {
      throw new Error('지식 응대 배선 거부: 검색기가 두 곳에서 옵니다(knowledge.retriever + knowledge.search) — 어느 임베딩으로 검색하는지 설정에서 읽을 수 없게 됩니다 (설계서 §2)');
    }
    if (kb.answerer !== undefined && engineRuntime?.answerer !== undefined) {
      throw new Error('지식 응대 배선 거부: 답변기가 두 곳에서 옵니다(engines.answer + knowledge.answerer) — 호스트가 만든 답변기는 재시도·대체·§9.3 샘플에 닿지 않습니다 (설계서 §2·§9.3)');
    }
    let retriever = kb.retriever;
    if (retriever === undefined && kb.search !== undefined) {
      const embedder = engineRuntime?.embedder;
      if (embedder === undefined) {
        throw new Error('지식 응대 배선 거부: knowledge.search 를 주었으나 엔진 기동 선언(engines.knowledge)에 임베딩이 없습니다 — Core 는 임베딩 엔진을 직접 만들지 않습니다 (설계서 §6.2·§5.2)');
      }
      try {
        // 지식베이스 id·스토어 테넌트·제한 시간 검증은 `createRetriever` 하나다(§2) —
        // 여기서 복사하면 한쪽만 고쳐지고, 고쳐지지 않은 쪽이 곧 §11.1 구멍이다.
        retriever = createRetriever({
          scope: opts.scope,
          embedder: countedEmbedder(embedder),
          store: kb.search.store,
          knowledgeBaseIds: kb.search.knowledgeBaseIds,
          ...(kb.search.storeTimeoutMs !== undefined ? { storeTimeoutMs: kb.search.storeTimeoutMs } : {}),
        });
      } catch (e) {
        throw new Error(`지식 응대 배선 거부: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!retriever || typeof retriever.retrieve !== 'function') {
      throw new Error('지식 응대 배선 거부: 검색기(retriever)가 없습니다 — Core 는 벡터 스토어를 직접 부르지 않습니다 (설계서 §6.2)');
    }
    const resolvedAnswerer = kb.answerer ?? engineRuntime?.answerer;
    if (!resolvedAnswerer || typeof resolvedAnswerer.answer !== 'function') {
      throw new Error('지식 응대 배선 거부: 답변기(answerer)가 없습니다 — Core 는 엔진을 직접 부르지 않습니다 (설계서 §6.2)');
    }
    const answerer = kb.answerer === undefined ? countedAnswerer(resolvedAnswerer) : resolvedAnswerer;
    try {
      // 판정 규칙을 복사하지 않는다 — 정책 검증은 `assertRetrievalPolicy` 하나다(§2).
      assertRetrievalPolicy(kb.policy);
    } catch (e) {
      throw new Error(`지식 응대 배선 거부: ${e instanceof Error ? e.message : String(e)}`);
    }
    knowledgeParts = { retriever, answerer };
    // 엔진이 기동된 상태에서만 경고한다 — 엔진 미배선이면 호스트 조립이 유일한 경로이고,
    // 그 사실은 이미 `W_ENGINES_UNBOUND` 가 적는다(같은 사실을 두 번 적지 않는다).
    if (engineRuntime !== undefined) {
      const hostBuilt: string[] = [];
      if (kb.retriever !== undefined) hostBuilt.push('검색기(retriever)');
      if (kb.answerer !== undefined) hostBuilt.push('답변기(answerer)');
      if (hostBuilt.length > 0) {
        warnings.push({
          code: 'W_KNOWLEDGE_PARTS',
          severity: 'warning',
          messageKo: `엔진은 기동됐는데 ${hostBuilt.join('·')}를 호스트가 조립했습니다 — 그 호출은 재시도·대체·§9.3 헬스 샘플에 닿지 않습니다. `
            + '엔진 기동 선언(engines.knowledge·engines.answer)으로 옮기면 Core 가 복원력이 붙은 엔진으로 만듭니다(§6.2·§9.3).',
        });
      }
    }
  }

  // AI 고지도 **배포 시점에** 거른다(§10.1). 미승인 문구·음성에 배너 같은 설정 오류를 통과시키면
  // 고지는 나가지 않거나 렌더되지 않는데 "적용했다"로 남는다. 검증 대상 채널은 **실제로 등록된
  // 채널만**이다 — 붙지도 않은 채널의 문구가 없다는 경고가 쌓이면 진짜 누락이 그 안에 묻힌다.
  if (opts.disclosure !== undefined) {
    const activeChannels = [...new Set(opts.channels.map((r) => r.port.capabilities.channel))];
    const issues = validateDisclosureBinding(opts.disclosure, opts.scope, activeChannels);
    if (issues.errorsKo.length > 0) {
      throw new Error(`AI 고지 배선 거부: ${issues.errorsKo.join(' / ')}`);
    }
    for (const messageKo of issues.warningsKo) {
      warnings.push({ code: 'W_AI_DISCLOSURE', severity: 'warning', messageKo });
    }
  } else {
    // 고지는 법적 의무이고 미배선의 증상은 **아무 일도 일어나지 않는 것**이다 — 통화도 이벤트도
    // 적합성 검사도 정상이라 어디서도 터지지 않는다. 종전 동작이므로 막지 않되 반드시 드러낸다.
    warnings.push({
      code: 'W_AI_DISCLOSURE_UNBOUND',
      severity: 'warning',
      messageKo: 'AI 고지 배선(disclosure)이 없습니다 — 어떤 채널에서도 고지가 나가지 않습니다(§10.1·§7 7.4). '
        + '문구는 법무 검토를 거친 테넌트 문안이어야 합니다 [승인 필요].',
    });
  }

  // QA·준수 점검도 **배포 시점에** 거른다(§7 5.2). 점검 설정 오류의 증상은 예외가 아니라
  // **리포트가 깨끗한 것**이고, 깨끗한 리포트는 아무도 다시 보지 않는다 — 비교할 수 없는 금칙어
  // 하나가 "등록했는데 한 번도 안 걸린다"로 끝나도 어디에서도 터지지 않는다.
  // 규칙은 **생성 시점에 한 번만** 조립한다: 운영 중 고지 설정·금칙어를 고치면 진행 중인 세션이
  // 다른 기준으로 점검되고, 같은 통화의 전반·후반이 서로 다른 규칙으로 판정된다. 새 규칙은 재배선이다.
  let qaRules: QaRuleSet | undefined;
  if (opts.qa !== undefined) {
    if (!Array.isArray(opts.qa.disclosureMarkers) || !Array.isArray(opts.qa.forbiddenPhrases)) {
      throw new Error('QA 점검 배선 거부: 고지 표식·금칙어 규칙이 배열이 아닙니다 (설계서 §7 5.2)');
    }
    const activeChannels = [...new Set(opts.channels.map((r) => r.port.capabilities.channel))];
    const ruleInput = {
      scope: opts.scope,
      disclosureMarkers: opts.qa.disclosureMarkers,
      forbiddenPhrases: opts.qa.forbiddenPhrases,
      channels: activeChannels,
      ...(opts.disclosure !== undefined ? { disclosure: opts.disclosure } : {}),
      ...(opts.qa.maxEvents !== undefined ? { maxEvents: opts.qa.maxEvents } : {}),
    };
    const issues = validateComplianceBinding(ruleInput);
    if (issues.errorsKo.length > 0) {
      throw new Error(`QA 점검 배선 거부: ${issues.errorsKo.join(' / ')}`);
    }
    for (const messageKo of issues.warningsKo) warnings.push({ code: 'W_QA', severity: 'warning', messageKo });
    qaRules = buildQaRuleSet(ruleInput);
  } else {
    // 미배선의 증상은 "위반이 없는 것"과 똑같이 보인다 — 종전 동작이므로 막지 않되 반드시 드러낸다.
    warnings.push({
      code: 'W_QA_UNBOUND',
      severity: 'warning',
      messageKo: 'QA·준수 점검 배선(qa)이 없습니다 — 어떤 세션도 점검되지 않습니다(§7 5.2). '
        + 'AI 고지 누락(§10.1)·금칙 표현·마스킹 누락(§10.3)이 한 건도 집계되지 않으며, '
        + '리포트가 비는 것이 아니라 리포트 자체가 없어 "점검이 돌고 있다"와 구분되지 않습니다.',
    });
  }

  // 전환이 가능한 채널이 붙어 있는데 배선이 없으면, 그 전환 링크는 **id 가 곧 열쇠**다.
  // 종전 동작이므로 막지는 않되 조용히 두지도 않는다 — 조용한 보안 결함이 가장 오래 산다.
  if (opts.channelSwitch === undefined && opts.channels.some((r) => r.port.capabilities.crossChannelInvite)) {
    warnings.push({
      code: 'W_CHANNEL_SWITCH_UNBOUND',
      severity: 'warning',
      messageKo: '교차채널 초대가 가능한 채널이 등록됐으나 전환 배선(channelSwitch)이 없습니다. '
        + '합류가 Interaction id 하나로 통과하므로 링크를 본 사람이 진행 중인 상담 화면을 열 수 있습니다(§5.2·§10.3).',
    });
  }

  function registration(adapter: ChannelAdapterId): ChannelRegistration {
    const reg = regs.get(adapter);
    if (!reg) throw new Error(`등록되지 않은 채널입니다: ${adapter} (채널 계약 v${CHANNEL_CONTRACT_VERSION})`);
    return reg;
  }

  function meta(rec: SessionRecord): EventMeta {
    rec.state.eventSeq += 1;
    return {
      eventId: `${rec.interactionId}_e${rec.state.eventSeq}`,
      occurredAt: now(),
      tenantId: rec.scope.tenantId,
      interactionId: rec.interactionId,
      channel: rec.state.channel,
      flowId: rec.flow.id,
      flowVersion: rec.flow.version,
    };
  }

  /**
   * 이 세션의 길이 실측(§8.1 `duration_ms`). 산출 규칙은 `measuredDurationMs` 하나다(§2) —
   * Runner 의 종료 경로도 같은 함수를 쓴다.
   *
   * **끝나는 길이 네 갈래라 한 자리에 모았다**: 정상 종료·§9.3 폴백 중단·폴백 이관·커넥터 순회
   * 상한. 자리마다 적으면 빠지는 쪽이 생기고, 빠진 쪽은 "그 종류로 끝난 통화만 길이가 없다"로
   * 나타나 평균이 조용히 한쪽으로 쏠린다(폴백으로 끝난 통화가 대개 가장 짧다).
   *
   * 값을 못 만들면 필드를 만들지 않는다 — 그 통화는 리포트·조회에서 `sessionsMissingDuration`
   * 으로 세어지고, 그것이 "재지 못했다"의 유일한 정직한 신호다(§13-3).
   */
  function sessionDuration(rec: SessionRecord, endedAtIso: string): { durationMs?: number } {
    const durationMs = measuredDurationMs(rec.startedAt, endedAtIso);
    return durationMs === undefined ? {} : { durationMs };
  }

  async function publish(events: InteractionEvent[]): Promise<void> {
    if (!opts.bus || events.length === 0) return;
    const results = await opts.bus.publishAll(events);
    opts.onPublish?.(results);
  }

  /** 이벤트에 담긴 마스킹 완료 발화만 대화 이력으로 남긴다(§10.3). */
  function recordTurns(rec: SessionRecord, events: InteractionEvent[]): void {
    for (const e of events) {
      if (e.type !== 'turn.completed') continue;
      const t = e as TurnCompletedEvent;
      const turn: Turn = { id: t.turn_id, at: t.occurred_at, channel: t.channel, speaker: t.speaker, utterance: t.utterance_masked };
      if (t.intent !== undefined) turn.intent = t.intent;
      if (t.confidence !== undefined) turn.confidence = t.confidence;
      rec.turns.push(turn);
    }
  }

  /**
   * Core 가 **이번 턴에** 부른 엔진의 §11.2 실측. 턴 안에서 호출이 있었을 때만 읽는다
   * (위 `engineCalls` 주석 — 호출 없이 읽으면 직전 턴의 값을 한 번 더 싣는다).
   *
   * 그동안 이 자리가 비어 있었다: 채널이 선언한 사용량만 이벤트에 실렸고, **Core 가 직접 부른
   * 엔진**(인텐트 분류·지식 검색·답변 생성)의 토큰은 어디에도 없었다. `UsageContribution.origin`
   * 주석이 `'engine_set'(Core 가 부른 엔진)` 을 예로 적어 두었는데 그 출처로 기여하는 코드가 0줄이다.
   * 결과는 예외가 아니다 — 그 비용은 공급사 청구서에만 남고 우리 집계에는 없어서, 몇 주 뒤 대사에서
   * **'미설명' 차이**로 돌아온다(그 방향은 과소청구이므로 청구는 막히지도 않는다).
   *
   * 값을 만들지 않는다(§13-3): 어댑터가 사용량을 주지 않으면 `undefined` 이고 0 으로 적지 않는다.
   */
  function engineTurnUsage(callsBefore: number): {
    usage: UsageMetrics; conflicts: string[]; rejected: string[]; calls: number;
  } | undefined {
    const rt = engineRuntime;
    if (rt === undefined) return undefined;
    const calls = engineCalls - callsBefore;
    if (calls <= 0) return undefined;
    const collected = rt.lastUsage();
    if (collected === undefined) return undefined;
    return {
      usage: collected.usage,
      conflicts: collected.conflicts.map((c) => c.key),
      rejected: collected.rejected.map((r) => `engine_set.${r.key}`),
      calls,
    };
  }

  /**
   * 이번 턴의 §11.2 실측을 이벤트에 싣는다. 출처는 **둘**이다 — 채널이 선언한 것과
   * Core 가 부른 엔진(위 `engineTurnUsage`).
   *
   * 검증·충돌 판정은 `billing/turnUsage.ts` 한 곳에서 한다 — 브리지(JSONL) 경로는 사용량을
   * 검사했지만 TypeScript 호스트가 `ChannelTurnInput.usage` 로 바로 넘기는 이 경로는 **아무 검사도
   * 없었다**. 그 비대칭의 결과는 같은 값이 경로에 따라 다르게 집계되는 것이고(§2), `NaN` 하나가
   * 그 테넌트의 월 집계 전체를 NaN 으로 만든다.
   *
   * 실을 자리가 없으면 **조용히 버리지 않는다** — 버려진 실측은 원장에도 집계에도 없는데 공급사
   * 청구서에는 남아 있어서, 대사에서 '이벤트 유실'로 오진된다.
   */
  function attachUsage(
    events: InteractionEvent[],
    declared: UsageMetrics | undefined,
    engine: ReturnType<typeof engineTurnUsage>,
  ): TurnBillingNote | undefined {
    if (declared === undefined && engine === undefined) return undefined;
    // 두 출처를 **한 번에** 넘긴다. 따로 붙이면 `attachTurnUsage` 가 두 번째를 "이미 실려 있다"로
    // 거절하고(덮어쓰지도 합치지도 않는 것이 그쪽 규약이다) 뒤쪽 실측이 통째로 사라진다.
    const contributions: UsageContribution[] = [];
    if (declared !== undefined) contributions.push({ origin: 'channel', usage: declared });
    if (engine !== undefined) contributions.push({ origin: 'engine_set', usage: engine.usage });
    const merged = mergeTurnUsage(contributions);
    const note = usageNote(merged, merged.usage === undefined ? undefined : attachTurnUsage(events, merged.usage));
    if (merged.usage === undefined) {
      note.usageAttached = false;
      note.usageReasonKo = '선언된 사용량에 실측으로 쓸 수 있는 항목이 없어 이벤트에 싣지 않았습니다(§11.2).';
    }
    if (engine !== undefined) {
      // 조각끼리 같은 키를 낸 것·실측으로 볼 수 없던 값은 `mergeTurnUsage` **앞에서** 이미 빠졌다.
      // 빠진 사실을 이어 붙이지 않으면 호스트는 그 항목이 애초에 없었다고 읽는다(§11.2).
      if (engine.conflicts.length > 0) note.usageConflicts = [...(note.usageConflicts ?? []), ...engine.conflicts];
      if (engine.rejected.length > 0) note.usageRejected = [...(note.usageRejected ?? []), ...engine.rejected];
      if (engine.calls > 1) {
        // 어댑터는 **마지막 호출**의 실측만 알려준다(§6.2 `lastUsage`). 한 턴에 두 번 이상 불렀으면
        // 앞 호출의 값은 같은 조각에서 덮였을 수 있다 — 추정해 더하지 않고 그 사실만 적는다(§13-3).
        const limit = `이 턴에 Core 가 엔진을 ${engine.calls}번 불렀습니다 — 어댑터는 마지막 호출의 `
          + '실측만 알려주므로 앞 호출의 사용량은 같은 조각에서 덮였을 수 있습니다(§11.2·§13-3).';
        note.usageReasonKo = note.usageReasonKo === undefined ? limit : `${note.usageReasonKo} ${limit}`;
      }
    }
    return billingNoteOrUndefined(note);
  }

  /**
   * 턴 단위로 선언된 응답시간을 입력 쪽 선언과 **키별로** 합친다.
   *
   * **고르지 않는다**: 같은 키가 둘에서 서로 다른 값으로 오면 입력 쪽을 그대로 두고 사실만
   * 적는다. 하나를 골라 주면 그 선택 규칙이 Core 에 생기고(§2), 그 규칙은 호스트의 어긋난
   * 선언을 조용히 덮는다 — `mergeTurnUsage` 가 같은 문제를 같은 방식으로 다룬다.
   */
  function mergedLatency(own: LatencyMs | undefined, declared: LatencyMs, whereKo: string): LatencyMs | undefined {
    const out: LatencyMs = { ...(own ?? {}) };
    const conflicts: string[] = [];
    for (const key of TURN_LATENCY_KEYS) {
      const v = declared[key];
      if (v === undefined) continue;
      const mine = out[key];
      if (mine !== undefined && mine !== v) { conflicts.push(key); continue; }
      out[key] = v;
    }
    if (conflicts.length > 0) {
      warnOnce('W_TURN_INPUT',
        `턴 응답시간 선언이 입력 쪽(${whereKo}) 선언과 어긋나 그 키를 입력 쪽 값으로 두었습니다: ${conflicts.join(', ')} — `
        + '어느 쪽이 실측인지 Core 는 고르지 않습니다(§2·§13-3).');
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }

  /**
   * 채널이 **턴 단위로** 선언한 실측을 입력에 싣는다(§13-3·§5.1).
   *
   * `ChannelTurnInput.latency`·`confidence` 는 채널 계약에 선언돼 있고 브리지(JSONL)가 형태까지
   * 검사해 채우는데, **런타임이 그 둘을 한 번도 읽지 않았다**. 실측이 §8.1 원장·§5.1 판정에
   * 도착하는 경로는 `FlowInput.latency`·`utterance.confidence` 하나뿐이어서, 계약대로 턴 단위로
   * 선언한 호스트의 값은 **경계에서 사라졌다**. 파이썬 참조 클라이언트가 바로 그 모양이다
   * (`send_utterance(latency=...)` → `turn["latency"]`) — 즉 Callbot 경로에서는 100% 유실이다.
   *
   * 사라진 쪽의 증상은 둘 다 예외가 아니다.
   *  - **응답시간**: `turn.completed.latency_ms` 가 언제나 비어 `turnsMissingLatency` 로만 집계된다 —
   *    §13 지연 지표(p50·p90·p95)에 표본이 **한 건도** 들어간 적이 없고, 리포트에서
   *    "측정하지 못했다"와 "선언했는데 유실됐다"가 구분되지 않는다.
   *  - **신뢰도**: `minConfidence` 를 선언한 테넌트에서도 저신뢰 인식이 **확신한 답으로 확정된다**
   *    (§5.1 신뢰도 조건을 건너뛴다). 재프롬프트도 예외도 없어 증상은 "엉뚱한 값이 수집된다" 뿐이다.
   *
   * 선언이 없으면 **종전과 완전히 같다**(§13-3). 실을 자리가 없는 입력 종류(무입력·커넥터 결과 —
   * 그 둘은 고객 발화가 아니라 `inputLatency` 가 애초에 싣지 않는다)도 조용히 버리지 않고 적는다.
   */
  function applyTurnFacts(turn: ChannelTurnInput): FlowInput {
    const input = turn.input;
    if (turn.latency === undefined && turn.confidence === undefined) return input;
    if (input.kind === 'timeout' || input.kind === 'connectorResult') {
      warnOnce('W_TURN_INPUT',
        `${input.kind} 입력에는 고객 발화가 없어 턴 단위로 선언된 실측(latency·confidence)을 실을 자리가 `
        + '없습니다 — 싣지 않았고, 그 값은 §8.1 원장에 들어가지 않습니다(§13-3).');
      return input;
    }
    const latency = turn.latency === undefined
      ? input.latency
      : mergedLatency(input.latency, turn.latency, `${input.kind} 입력`);

    if (input.kind === 'utterance') {
      let confidence = input.confidence;
      if (turn.confidence !== undefined) {
        if (confidence === undefined) confidence = turn.confidence;
        else if (confidence !== turn.confidence) {
          warnOnce('W_TURN_INPUT',
            '턴 신뢰도 선언이 입력 쪽 선언과 어긋나 입력 쪽 값을 그대로 두었습니다 — 어느 쪽이 '
            + '엔진 실측인지 Core 는 고르지 않습니다(§2·§13-3).');
        }
      }
      return {
        kind: 'utterance',
        text: input.text,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(latency !== undefined ? { latency } : {}),
      };
    }

    if (turn.confidence !== undefined) {
      warnOnce('W_TURN_INPUT',
        `${input.kind} 입력에는 인식 신뢰도 칸이 없어 턴 단위로 선언된 confidence 를 싣지 않았습니다 — `
        + '그 턴은 §5.1 신뢰도 조건을 지나지 않습니다(§13-3).');
    }
    if (input.kind === 'dtmf') {
      return { kind: 'dtmf', digits: input.digits, ...(latency !== undefined ? { latency } : {}) };
    }
    return { kind: 'unrecognized', text: input.text, ...(latency !== undefined ? { latency } : {}) };
  }

  /**
   * 종료 시 넘어온 통화 과금 구간의 처리 결과(§11.2). 사실만 적는다 — 보정·추정이 없다(§13-3).
   *
   * 음성이 아닌 채널로 **끝난** 세션을 따로 적는 이유: `aggregateUsage` 는 `channel === 'voice'` 인
   * 세션만 통화 시간으로 센다. §5.2 전환으로 통화가 화면 채널에서 끝나면 `session.ended.channel` 이
   * `visual` 이 되어 **그 통화의 billable_ms 가 집계에서 통째로 빠진다**. 여기서 채널을 음성으로
   * 고쳐 적지도, 집계 규칙을 바꾸지도 않는다 — 앞의 것은 거짓이고 뒤의 것은 잘못 선언된 채팅 세션을
   * 통화로 청구하는 과다청구 경로를 연다. 정책은 사람이 정하고, Core 는 사실을 드러낸다.
   */
  function endBillingNote(rec: SessionRecord, check: ReturnType<typeof checkBillableMs> | undefined): TurnBillingNote | undefined {
    if (check === undefined) return undefined;
    if (!check.ok) {
      return { billableMsRecorded: false, billableMsReasonKo: `${check.reasonKo} 통화 구간을 싣지 않고 종료는 그대로 진행했습니다(§11.2).` };
    }
    const note: TurnBillingNote = { billableMsRecorded: true };
    if (rec.state.channel !== 'voice') {
      note.billableMsReasonKo = `이벤트에는 실었으나 세션이 ${rec.state.channel} 채널로 끝나 통화 분 집계에서는 제외됩니다 `
        + `— 과금 집계는 음성 세션만 통화 시간으로 셉니다(§11.2·§5.2 전환).`;
    }
    return note;
  }

  /**
   * §7 5.2 준수 점검 — 이번 턴 이벤트를 수집함에 담고, **이 턴에 세션이 끝났으면** 한 번 점검한다.
   *
   * 결과에 실을 값을 돌려주므로 호출 지점은 **이벤트가 확정된 직후·결과 조립 직전**이다.
   * 세션이 끝나는 길은 네 갈래이고(정상 종료·폴백 중단·폴백 이관·커넥터 순회 상한) 네 갈래 전부에서
   * 불린다 — `end()` 에만 걸면 폴백으로 끝난 통화가 영영 점검되지 않는데, 하필 그 통화들이
   * 감독기관·민원에서 가장 먼저 열리는 통화다(경로별 검사로 고정한다).
   *
   * 지키는 것:
   * - **한 세션에 한 번.** `reviewed` 로 잠근다 — 두 번 올리면 리뷰 큐에 같은 통화가 두 건 쌓이고,
   *   위반 건수가 통화 수보다 많아진다(§13-3 의 "실측" 이 깨진다).
   * - **판정하지 않는다.** 위반·리뷰 분기·건수는 `qa/compliance.ts` 하나다(§2).
   * - **던지지 않는다.** 점검도, 점검 결과를 받는 훅도 종료를 막을 수 없다 — 이 경로에서 예외는
   *   채널의 `end` 지시가 호출되지 않는 것으로 나타나고, 그 세션 누수는 장애가 아니라 요금이다.
   */
  function complianceSlot(
    rec: SessionRecord, events: readonly InteractionEvent[],
  ): { compliance?: ComplianceTurnNote } {
    const binding = opts.qa;
    const rules = qaRules;
    if (binding === undefined || rules === undefined) return {};
    const buf = rec.qa ?? (rec.qa = newComplianceBuffer());
    appendForReview(buf, events, binding.maxEvents);
    if (!rec.ended || buf.reviewed) return {};
    buf.reviewed = true;
    try {
      const review = reviewCompliance({ buffer: buf, rules, scope: rec.scope });
      binding.onReport?.({
        interactionId: rec.interactionId,
        ...(review.report !== undefined ? { report: review.report } : {}),
        note: review.note,
      });
      return { compliance: review.note };
    } catch {
      // 점검 결과를 받는 쪽이 던진 경우다. 점검을 돌렸다는 사실은 남기되(reviewed) 종료는 그대로 간다.
      return {};
    }
  }

  function interactionOf(rec: SessionRecord, reason: Handoff['reason']): Interaction {
    const i: Interaction = {
      id: rec.interactionId,
      tenantId: rec.scope.tenantId,
      startedAt: rec.startedAt,
      channels: [...rec.channels],
      turns: rec.turns,
      entities: { ...rec.state.slots },
      handoff: { at: now(), reason },
    };
    if (rec.scope.workspaceId !== undefined) i.workspaceId = rec.scope.workspaceId;
    if (rec.state.handoff?.queue !== undefined && i.handoff) i.handoff.toQueue = rec.state.handoff.queue;
    return i;
  }

  /** 이관 요약 생성 + handoff.requested 이벤트에 마스킹 요약을 채워 넣는다(§2·§10.3). */
  function attachSummary(rec: SessionRecord, events: InteractionEvent[]): string | undefined {
    const h = rec.state.handoff;
    if (!h) return undefined;
    recordTurns(rec, events);          // 요약은 이번 턴까지 반영되어야 한다
    const summary = buildHandoffSummary(interactionOf(rec, h.reason), {
      ...opts.summary,
      requiredSlots: opts.summary?.requiredSlots ?? requiredSlotsOf(rec.flow),
    });
    for (let idx = 0; idx < events.length; idx++) {
      const e = events[idx];
      if (e && e.type === 'handoff.requested') {
        // 이미 마스킹을 통과한 text 다 — 재마스킹하지 않는다.
        events[idx] = { ...(e as HandoffRequestedEvent), summary_masked: summary.text, summary_present: true };
      }
    }
    return summary.text;
  }

  function runnerCtx(rec: SessionRecord, caps: ChannelCapabilities, entryPoint?: ChannelSessionRequest['entryPoint']): RunnerContext {
    const ctx: RunnerContext = {
      tenantId: rec.scope.tenantId,
      interactionId: rec.interactionId,
      channel: rec.state.channel,
      // §5.1 2회 실패 시 화면 전환은 "화면을 띄울 수 있는 채널"에서만 성립한다.
      // 전환이 배선되면 링크를 실제로 보낼 수 있는지까지 본다 — 사다리가 전환을 고른 뒤에
      // 발급이 막히면 고객은 통화 중인데 화면용 단계를 듣게 된다(switchFeasible 주석 참조).
      visualAvailable: caps.channel === 'visual' || switchFeasible(rec, caps),
      // Runner 가 끝내는 세션(End 노드 도달·순회 상한·재시도 소진 이관)의 길이도 **여기서 받은
      // 같은 시작 시각**으로 잰다. 넘기지 않으면 그 종료들만 `duration_ms` 가 비고, 증상은
      // "자동완결된 통화만 길이가 없다"가 된다 — 하필 가장 많은 종료 경로다(§8.1·§13-3).
      startedAt: rec.startedAt,
      now,
    };
    if (opts.minConfidence !== undefined) ctx.minConfidence = opts.minConfidence;
    if (opts.reprompt !== undefined) ctx.reprompt = opts.reprompt;
    if (opts.timing !== undefined) ctx.timing = opts.timing;
    if (entryPoint !== undefined) ctx.entryPoint = entryPoint;
    return ctx;
  }

  function health(channel: ChannelKind): FallbackDecision {
    return decideFallbackMode(channel, opts.health, opts.policy, now());
  }

  /**
   * §9.3 축소 지시를 이번 턴의 단계마다 찍는다(§6.2 — 끄는 주체는 매체다).
   *
   * **제자리에서 고친다.** 호출부의 `presented` 인덱스 계산·결과 `steps`·`port.present` 가 전부
   * 같은 배열을 본다(고지 끼우기와 같은 이유) — 새 배열을 만들어 돌려주면 한 곳이라도 옛 배열을
   * 들고 있으면 그 경로에서만 지시가 사라지고, 그건 "어떤 호스트에서만 TTS 가 안 꺼진다"가 된다.
   *
   * **단계마다 찍는다.** 턴 결과에 한 번만 실으면 커넥터 이행처럼 한 턴에 `present` 가 두 번
   * 나가는 경로에서 먼저 나간 안내는 지시 없이 나간다 — 하필 그 안내가 저하된 TTS 로 합성된다.
   *
   * 끌 것이 없으면 **아무것도 하지 않는다**(§13-3): 빈 배열을 찍으면 포트는 "축소 운영인데 끌
   * 것은 없다"와 "정상"을 구분하려 들고, 그 구분에는 근거가 없다.
   */
  function stampOutage(steps: RenderedStep[], decision: FallbackDecision): void {
    const disabled = mediaDisabledBy(decision);
    if (disabled.length === 0) return;
    for (const step of steps) {
      // 이미 찍힌 단계는 덮어쓰지 않는다 — 커넥터 이행 중에 판정이 바뀌어도 그 단계가 실제로
      // 나갈 때의 지시가 남아야 한다(나중 판정으로 덮으면 "무엇을 보고 합성했는가"가 사라진다).
      if (step.outage !== undefined) continue;
      step.outage = { disabled: [...disabled], reasonKo: decision.reasonKo };
    }
  }

  /** 장애 폴백 실행(§9.3). AI 응대를 계속할 수 있으면 undefined 를 돌려준다. */
  async function applyOutage(
    rec: SessionRecord,
    decision: FallbackDecision,
    reg: ChannelRegistration,
    prelude: InteractionEvent[] = [],
  ): Promise<ChannelTurnResult | undefined> {
    if (decision.mode === 'normal' || decision.mode === 'degraded_ai') return undefined;
    const events: InteractionEvent[] = [...prelude];
    const id = rec.interactionId;

    if (decision.mode === 'unavailable') {
      rec.state.status = 'failed';
      rec.state.currentNodeId = null;
      const mFailed = meta(rec);
      events.push(sessionEnded(mFailed, {
        outcome: 'FAILED', turnCount: rec.state.turnCount, ...sessionDuration(rec, mFailed.occurredAt),
      }));
      rec.ended = true;
      await publish(events);
      // 폴백으로 끝난 통화도 점검한다 — `end()` 에만 걸면 이 통화는 영영 점검되지 않는다(§7 5.2).
      const result: ChannelTurnResult = {
        interactionId: id, state: rec.state, steps: [], status: 'failed', events, fallback: decision,
        ...complianceSlot(rec, events),
      };
      rec.lastResult = result;
      sessions.put(rec);
      await reg.port.end(id, decision.reasonKo);
      return result;
    }

    const queue = decision.transferTo ?? opts.policy.fallbackQueue;
    rec.state.status = 'transferred';
    rec.state.currentNodeId = null;
    rec.state.handoff = { reason: 'error', ...(queue !== undefined ? { queue } : {}) };
    events.push(handoffRequested(meta(rec), { reason: 'error', ...(queue !== undefined ? { toQueue: queue } : {}) }));
    const mTransferred = meta(rec);
    events.push(sessionEnded(mTransferred, {
      outcome: 'TRANSFERRED', turnCount: rec.state.turnCount, ...sessionDuration(rec, mTransferred.occurredAt),
    }));
    const summaryMasked = attachSummary(rec, events);
    rec.ended = true;
    await publish(events);
    const result: ChannelTurnResult = {
      interactionId: id, state: rec.state, steps: [], status: 'transferred', events, fallback: decision,
      handoff: { ...(queue !== undefined ? { queue } : {}), ...(summaryMasked !== undefined ? { summaryMasked } : {}) },
      ...complianceSlot(rec, events),
    };
    rec.lastResult = result;
    sessions.put(rec);

    if (decision.mode === 'legacy_ivr' && typeof reg.port.routeToLegacyIvr === 'function') {
      await reg.port.routeToLegacyIvr(id, decision.reasonKo);
    } else {
      if (decision.mode === 'legacy_ivr') {
        // **판정과 실제 행동이 갈라지는 유일한 자리다.** 정책은 "기존 IVR 로 내린다"인데 그 채널에
        // 회귀 구현이 없어 상담사 이관으로 대신한다. 판정을 고쳐 적지는 않는다(무엇을 할지는
        // `decideFallbackMode` 하나다, §2) — 대신 **대신했다는 사실**을 남긴다. 남기지 않으면
        // 결과·원장에 남는 것은 `fallback.mode: 'legacy_ivr'` 뿐이고 사후 분석은 "IVR 로 내렸다"로
        // 읽는다(아무도 내리지 않았다). 통화가 끊기지도 않으므로 장애로도 잡히지 않는다.
        warnOnce('W_FALLBACK_LEGACY_IVR',
          `§9.3 판정은 기존 IVR 회귀(legacy_ivr)인데 ${reg.port.capabilities.adapter} 채널에 routeToLegacyIvr `
          + '구현이 없어 상담사 이관으로 대신했습니다 — 통화는 이어지지만 판정과 실제 행동이 다릅니다.');
      }
      await reg.port.transfer(id, queue, summaryMasked);
    }
    return result;
  }

  /** 이번 Api 대기 건의 호출 회차. 같은 대기 건에 다시 들어오면 **같은 회차**를 돌려준다. */
  function connectorCallNo(rec: SessionRecord, connectorId: string): number {
    if (rec.connectorCall && rec.connectorCall.connectorId === connectorId) return rec.connectorCall.call;
    const calls = rec.connectorCalls ?? {};
    const call = (calls[connectorId] ?? 0) + 1;
    calls[connectorId] = call;
    rec.connectorCalls = calls;
    rec.connectorCall = { connectorId, call };
    return call;
  }

  /**
   * Api 대기 이행(§6.1). 배선이 없으면 **아무것도 하지 않는다** — 종전과 완전히 같다(§13-3).
   *
   * 여기서 지키는 것:
   * - **대기 안내는 호출 전에 나간다.** `waitText` 가 선언된 Api 단계는 무음이 아니다. 호출이 끝난
   *   뒤에 "잠시만 기다려 주세요"를 내보내면 안내가 아니라 잡음이고, 그 사이는 통째로 무음이 된다.
   *   그래서 홉마다 **직전까지의 단계를 먼저 present** 하고 나서 업무시스템을 부른다.
   * - **재진입해도 업무시스템을 두 번 부르지 않는다**(`connectorInFlight`) — command 커넥터에서
   *   이중 신청으로 나타나고, 예외가 없어 장애로 보이지 않는다.
   * - **순환은 구조적 상한으로 끊는다.** `onError` 가 Api 노드를 다시 가리키면 영원히 돌 수 있다.
   *   상한에 걸리면 실패 입력을 한 번 넣어 §9.3 이관을 돌리고, 그래도 다시 대기가 서면
   *   `advance()` 의 순회 상한과 같이 **세션을 실패로 끝낸다** — 고객을 무음에 두지 않는다.
   * - **테넌트 격리 위반은 삼키지 않는다**(§11.1). 실행기가 던지는 유일한 경우이며 그대로 올린다.
   */
  async function drainConnectors(
    rec: SessionRecord, reg: ChannelRegistration, run: RunResult, decision: FallbackDecision,
  ): Promise<{ steps: RenderedStep[]; events: InteractionEvent[]; presented: number; endReasonKo?: string }> {
    const binding = connectorBinding;
    const steps: RenderedStep[] = [...run.steps];
    const events: InteractionEvent[] = [...run.events];
    let presented = 0;
    if (rec.state.pendingConnectorId === undefined) return { steps, events, presented };
    if (!binding) {
      // 배선이 없는데 Api 대기가 섰다. 이 상태는 **종전 동작**이므로 막지 않는다 — 호스트가
      // 직접 커넥터를 불러 `connectorResult` 로 되돌려주는 경로가 있다. 다만 조용히 두지
      // 않는다: 그 경로를 짜지 않은 호스트에서 증상은 예외가 아니라 **무음**이고, 고객이
      // 무슨 말을 해도 steps 0건·events 0건이 나가 어떤 알림도 울리지 않는다. 적합성 검사·
      // 이벤트·헬스가 전부 정상이라 "그 메뉴만 안 된다"로만 나타난다.
      warnOnce('W_CONNECTOR_UNBOUND',
        'Api 노드 대기가 섰는데 커넥터 이행 배선(connectors)이 없습니다 — 호스트가 직접 '
        + '호출해 connectorResult 로 되돌려주지 않으면 그 통화는 무음으로 멈춥니다(§6.1).');
      return { steps, events, presented };
    }
    // 같은 대기 건에 두 번 들어왔다. 두 번 부르지 않고 조용히 물러난다 — 이행은 앞의 호출이 끝낸다.
    if (rec.connectorInFlight) return { steps, events, presented };

    const limit = connectorHopLimit(rec.flow);
    rec.connectorInFlight = true;
    try {
      for (let hops = 0; rec.state.pendingConnectorId !== undefined; hops++) {
        const connectorId = rec.state.pendingConnectorId;
        // 호출 회차를 **안내·호출보다 먼저** 정하고 저장한다. 여기서 정해 두면 안내 전달이나
        // 호출 도중 턴이 끊겨도(영속 세션 저장소에서는 프로세스 재기동까지) 되살아난 세션이
        // **같은 멱등 키**로 재개한다 — 회차를 호출 직전에 만들면 재개가 곧 이중 신청이다.
        const call = connectorCallNo(rec, connectorId);
        sessions.put(rec);                       // 호출 전에 상태를 남긴다(호출 중 중단되어도 잃지 않게)
        const ahead = visibleSteps(steps.slice(presented));
        presented = steps.length;
        if (ahead.length > 0) await reg.port.present(rec.interactionId, ahead);

        let input: FlowInput;
        if (hops >= limit) {
          input = hopLimitInput();
        } else {
          const hop = await pumpConnectorHop({
            binding,
            connectorId,
            scope: rec.scope,
            interactionId: rec.interactionId,
            slots: { ...rec.state.slots },
            call,
            onHealth: (s) => opts.health.record(s),
            now,
          });
          input = hop.input;
          // 설정 오류·동의 조립 예외를 삼키지 않는다. 보고 훅이 없으면 조용히 진행한다(§13-3).
          if (binding.onBlock && (hop.block !== undefined || hop.consentError !== undefined)) {
            binding.onBlock({
              interactionId: rec.interactionId, connectorId,
              ...(hop.block !== undefined ? { block: hop.block } : {}),
              ...(hop.consentError !== undefined ? { consentError: hop.consentError } : {}),
            });
          }
        }
        if (hops >= limit && binding.onBlock) {
          binding.onBlock({ interactionId: rec.interactionId, connectorId, block: 'hop_limit' });
        }

        const next = runnerSend(rec.flow, rec.state, input, runnerCtx(rec, reg.port.capabilities));
        rec.state = next.state;
        // 이행이 만든 단계도 같은 지시를 받는다 — 여기서 빠뜨리면 조회 결과 안내만 지시 없이 나간다.
        stampOutage(next.steps, decision);
        steps.push(...next.steps);
        events.push(...next.events);
        delete rec.connectorCall;                // 결과가 왔다 — 다음에 같은 노드를 밟으면 새 호출이다

        if (hops >= limit && rec.state.pendingConnectorId !== undefined) {
          // 실패 입력조차 다시 Api 대기로 돌아왔다. 시나리오 순환이며 진행할 방법이 없다.
          delete rec.state.pendingConnectorId;
          rec.state.status = 'failed';
          rec.state.currentNodeId = null;
          rec.state.error = 'Api 노드 순회 상한 초과(커넥터 순환 의심)';
          const mHopLimit = meta(rec);
          events.push(sessionEnded(mHopLimit, {
            outcome: 'FAILED', turnCount: rec.state.turnCount, ...sessionDuration(rec, mHopLimit.occurredAt),
          }));
          rec.ended = true;
          sessions.put(rec);
          return { steps, events, presented, endReasonKo: rec.state.error };
        }
      }
    } finally {
      rec.connectorInFlight = false;
    }
    sessions.put(rec);
    return { steps, events, presented };
  }

  /**
   * 이번 턴의 시나리오 진행. 인텐트 진입 노드(§5.1)가 아니면 **종전과 완전히 같다** —
   * `runnerSend` 하나를 그대로 부른다(§13-3, 검사로 고정).
   *
   * 여기서 지키는 것:
   * - **분류 결과를 슬롯으로 저장하지 않는다.** 진입 노드는 `Collect` 라서 Runner 에 그냥
   *   넘기면 "카드를 잃어버렸어요"가 슬롯 값이 된 채 다음 노드로 넘어간다 — 예외도,
   *   재프롬프트도 없이 고객만 엉뚱한 안내를 듣는다. 그래서 이 노드의 입력은 가로챈다.
   * - **숫자는 인텐트가 아니다.** 되묻는 중이 아닐 때의 DTMF 는 분류기에 보내지 않는다
   *   (엔진 비용이고 의미도 없다, §11.2). 번호 메뉴가 필요하면 `Choice` 노드를 쓴다.
   *   되묻는 중이면 "2번"이 곧 선택이므로 그때는 선택지 해석으로 간다.
   * - **격리 위반은 삼키지 않는다**(§11.1) — 실행기가 던지는 유일한 경우이며 그대로 올린다.
   */
  /**
   * 지식 응대 턴(§5.2). 배선이 없으면 호출되지 않는다 — 그러면 질문은 슬롯 값이 된다(§13-3).
   *
   * 답하지 못했을 때 **문안을 만들지 않고** 미인식 입력으로 §5.1 사다리에 태운다.
   * 사다리 규칙(몇 번 실패하면 화면·상담사로 가는가)은 `decideFallback` 하나이며 여기서
   * 다시 쓰지 않는다(§2) — 지식 응대가 자기 사다리를 가지면 같은 통화에서 재시도 한도가
   * 두 개가 되고, 고객은 어느 쪽 규칙으로 이관됐는지 알 수 없는 상태로 넘겨진다.
   */
  async function runKnowledgeTurn(
    binding: NonNullable<ConversationCoreOptions['knowledge']>,
    rec: SessionRecord, ctx: RunnerContext, input: FlowInput, text: string,
    latency: { latency?: LatencyMs }, decision: FallbackDecision,
  ): Promise<RunResult> {
    if (decision.disable.includes('knowledge_grounding')) {
      // §9.3 이 **끄라고 판정한 기능**은 부르지 않는다. 그동안 이 목록은 아무도 읽지 않았고
      // (저장소 전체에서 `disable` 을 보는 코드가 없었다), 그 상태에서 지식 응대를 배선하면
      // 판정은 "지식검색을 끈다"인데 호출은 계속된다 — 저하된 엔진을 더 밀어붙이고(§11.2 비용),
      // 고객은 기다리고, **신뢰할 수 없다고 판정된 지식베이스로 답한다**.
      // 여기서 판정을 다시 하지 않는다(무엇을 끌지는 `decideFallbackMode` 하나다, §2) ·
      // **엔진 상태로 집계하지 않는다**(이미 그 상태 때문에 끈 것이다 — 또 적으면 한 번의 장애가
      // 두 번 집계되고 복구 판정이 그만큼 늦어진다, §9.3).
      binding.onResult?.({
        interactionId: rec.interactionId,
        answered: false,
        cause: 'disabled_by_fallback',
        infraFailed: false,
        partial: false,
        citations: 0,
        reasonKo: `§9.3 판정으로 지식 응대를 끈 상태라 호출하지 않았습니다: ${decision.reasonKo}`,
        usage: { embedChars: 0, storeQueries: 0, hits: 0, promptChars: 0, responseChars: 0 },
      });
      return runnerSend(rec.flow, rec.state, { kind: 'unrecognized', text, ...latency }, ctx);
    }
    // 구성요소는 **배선에서 확정한 한 벌**을 쓴다(`knowledgeParts`) — 턴마다 배선을 다시
    // 읽으면 엔진 기동이 만든 쪽과 호스트가 준 쪽이 호출 시점에 갈릴 수 있다(§2).
    const parts = knowledgeParts as NonNullable<typeof knowledgeParts>;
    const outcome = await resolveKnowledgeTurn(
      { retriever: parts.retriever, answerer: parts.answerer, policy: binding.policy },
      { scope: rec.scope, channel: rec.state.channel, text },
    );
    binding.onResult?.({
      interactionId: rec.interactionId,
      answered: outcome.kind === 'answer',
      ...(outcome.kind === 'no_answer' ? { cause: outcome.cause, infraFailed: outcome.infraFailed } : { infraFailed: false }),
      partial: outcome.partial,
      citations: outcome.kind === 'answer' ? outcome.citations.length : 0,
      reasonKo: outcome.reasonKo,
      usage: outcome.usage,
    });
    if (outcome.kind === 'answer') {
      return knowledgeTurn(rec.flow, rec.state, ctx, outcome.step, {
        input, questionMasked: outcome.questionMasked,
      });
    }
    return runnerSend(rec.flow, rec.state, { kind: 'unrecognized', text, ...latency }, ctx);
  }

  /**
   * `decision` 은 이 턴의 §9.3 판정이다. **다시 계산하지 않고 받는다** — `send` 가 이미
   * 같은 값으로 장애 경로(이관·IVR·종료)를 지났으므로, 여기서 또 조회하면 그 사이에 바뀐
   * 상태로 **한 턴 안에서 두 가지 판정**이 돌 수 있다(§2).
   */
  async function runTurn(
    rec: SessionRecord, ctx: RunnerContext, input: FlowInput, decision: FallbackDecision,
  ): Promise<RunResult> {
    const binding = opts.intent;
    const node = rec.state.currentNodeId === null ? undefined : rec.flow.nodes[rec.state.currentNodeId];
    const knowledge = opts.knowledge;
    if (knowledge && isKnowledgeEntryNode(node)) {
      // 무입력·커넥터 결과는 질문이 아니다 — 종전 경로(§5.1 무입력 사다리)로 간다.
      // **숫자도 질문이 아니다**: DTMF 로 지식베이스를 검색하면 비용(§11.2)만 쓰고 언제나
      // 근거를 못 찾는다(번호 메뉴가 필요하면 `Choice` 노드를 쓴다).
      if (input.kind === 'utterance') {
        const latency = input.latency !== undefined ? { latency: input.latency } : {};
        return runKnowledgeTurn(knowledge, rec, ctx, input, input.text, latency, decision);
      }
      if (input.kind === 'dtmf') {
        const latency = input.latency !== undefined ? { latency: input.latency } : {};
        return runnerSend(rec.flow, rec.state, { kind: 'unrecognized', text: input.digits, ...latency }, ctx);
      }
      return runnerSend(rec.flow, rec.state, input, ctx);
    }
    if (!binding || !isIntentEntryNode(node)) return runnerSend(rec.flow, rec.state, input, ctx);
    if (input.kind !== 'utterance' && input.kind !== 'dtmf') {
      // 무입력(timeout)·커넥터 결과는 인텐트가 아니다 — 종전 경로(§5.1 무입력 사다리)로 간다.
      return runnerSend(rec.flow, rec.state, input, ctx);
    }

    const text = input.kind === 'utterance' ? input.text : input.digits;
    const latency = input.latency !== undefined ? { latency: input.latency } : {};
    const clarifying = (rec.intentClarify?.options.length ?? 0) > 0;
    if (input.kind === 'dtmf' && !clarifying) {
      return runnerSend(rec.flow, rec.state, { kind: 'unrecognized', text, ...latency }, ctx);
    }

    const outcome = await resolveIntentEntry(
      {
        catalog: binding.catalog, policy: binding.policy, table: binding.table,
        // 인텐트로 갈아타는 시나리오도 세션 시작과 **같은 경로**로 고른다 — 여기만 빠뜨리면
        // 시작은 배포본인데 인텐트가 고른 시나리오는 미배포 편집본이 된다.
        // 분류기는 배선 시점에 출처가 하나로 정해졌다(위 `intentClassifier`) — 여기서 다시 고르지 않는다.
        flows: channelFlows(rec.state.channel), classifier: intentClassifier as IntentClassifier, clarifyPrompt: binding.clarifyPrompt,
      },
      {
        scope: rec.scope, channel: rec.state.channel, text,
        ...(rec.intentClarify !== undefined ? { pending: rec.intentClarify } : {}),
        ...(opts.timing !== undefined ? { timing: opts.timing } : {}),
      },
    );

    const turn: IntentTurnInput = { input };
    switch (outcome.kind) {
      case 'start_flow': {
        delete rec.intentClarify;
        return switchFlow(outcome.flow, rec.state, ctx, outcome.entryNodeId, {
          ...turn,
          intent: outcome.intent,
          ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
        });
      }
      case 'handoff': {
        delete rec.intentClarify;
        if (outcome.cause === 'unrouted') {
          // 설정 누락이다. 조용히 두면 "봇이 못 알아듣더라"로만 남는다 — 통화는 이관으로 살리되
          // 원인은 운영 화면과 호스트 양쪽에 드러낸다.
          warnOnce('W_INTENT_ROUTING', `확정된 인텐트에 연결된 시나리오가 없어 상담사로 넘겼습니다: ${outcome.intent}`);
          binding.onIssue?.({
            interactionId: rec.interactionId, kind: 'unrouted', reasonKo: outcome.reasonKo, intent: outcome.intent,
          });
        }
        return handoffFromIntent(rec.state, ctx, outcome.reason, { ...turn, intent: outcome.intent });
      }
      case 'clarify': {
        rec.intentClarify = outcome.pending;
        return clarifyTurn(rec.state, ctx, outcome.step, turn);
      }
      case 'fallback': {
        // 선택지는 버리고 **시도 횟수만 이어받는다** — 0 으로 되돌리면 명확화 한도가 무의미해진다.
        rec.intentClarify = { options: [], attempt: rec.intentClarify?.attempt ?? 0 };
        binding.onIssue?.({
          interactionId: rec.interactionId,
          kind: outcome.classifierFailed ? 'classifier_failed' : 'unmatched',
          reasonKo: outcome.reasonKo,
          ...(outcome.classifierStatus !== undefined ? { status: outcome.classifierStatus } : {}),
        });
        return runnerSend(rec.flow, rec.state, { kind: 'unrecognized', text, ...latency }, ctx);
      }
    }
  }

  /**
   * 상담사 큐 배정. 배선이 없으면 `undefined` 를 돌려주고 호출부는 종전 경로를 탄다(§13-3).
   *
   * 스냅샷 조회가 실패해도 **던지지 않는다** — 큐 상태를 못 읽었다는 이유로 이관이 예외로 끝나면
   * 고객은 봇에 갇힌다. 빈 배열로 진행하면 `admitToQueue` 가 "상태 미확인"으로 보수적으로 닫고
   * §9.3 대안이 나온다.
   */
  async function placeHandoff(rec: SessionRecord, summaryMasked: string | undefined): Promise<HandoffPlacement | undefined> {
    const binding = opts.routing;
    if (!binding || !rec.state.handoff) return undefined;
    let snapshots: readonly QueueSnapshot[] = [];
    try {
      snapshots = await binding.snapshots();
    } catch {
      snapshots = [];
    }
    // 내부 예약 슬롯(`__`)은 라우팅 규칙 비교에 넣지 않는다 — 시나리오 내부 상태가 큐를 고르면 안 된다.
    const slots: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec.state.slots)) {
      if (!k.startsWith('__')) slots[k] = v;
    }
    return executeHandoff(binding.config, {
      scope: rec.scope,
      channel: rec.state.channel,
      reason: rec.state.handoff.reason,
      slots,
      ...(summaryMasked !== undefined ? { summaryMasked } : {}),
      nowIso: now(),
      snapshots,
      ...(binding.admission !== undefined ? { admission: binding.admission } : {}),
    });
  }

  /**
   * 이관 전달. 배정 결과에 따라 **큐에 놓을 수 있을 때만** `transfer` 를 부른다.
   *
   * 배정이 대안(`alternative`)·목적지 불가(`unavailable`)인데도 `transfer` 를 부르면,
   * 채널은 "상담사 연결 중"을 안내하고 고객은 아무도 없는 곳에서 기다린다 —
   * §9.3 대안(콜백·음성사서함·기존 IVR)이 통째로 건너뛰어진다. 그래서 부르지 않고,
   * 무엇을 해야 하는지는 `result.handoff.placement` 로 채널에 그대로 넘긴다.
   */
  async function deliverHandoff(
    reg: ChannelRegistration,
    rec: SessionRecord,
    summaryMasked: string | undefined,
    result: ChannelTurnResult,
  ): Promise<void> {
    if (!rec.state.handoff) return;
    const placement = await placeHandoff(rec, summaryMasked);
    if (!placement) {
      await reg.port.transfer(rec.interactionId, rec.state.handoff.queue, summaryMasked);
      return;
    }
    if (result.handoff) result.handoff.placement = placement;
    if (placement.placement !== 'queued') return;
    await reg.port.transfer(rec.interactionId, placement.queueId, summaryMasked);
    // **전달 다음이다.** 먼저 열면 `transfer` 가 실패한 통화에 상담사가 배정되고, 그 상담사는
    // 고객이 없는 통화에 들어간다. 전달이 던지면 여기까지 오지 않는다(오퍼는 열리지 않는다).
    if (summaryMasked !== undefined) {
      rec.handoffSummaryMasked = summaryMasked;
      // 영속 저장소에서는 대입만으로 남지 않는다 — 소진 수렴(몇 분 뒤)이 요약을 못 찾으면
      // 콜백·음성사서함으로 간 건만 요약이 빈다. 제안이 서지 않아도 적어 둔다.
      sessions.put(rec);
    }
    await openAgentOffer(rec, placement.queueId, 'handoff');
  }

  // ── 상담사 배정 오퍼(§2·§9.3) ──────────────────────────────────────────────
  // 큐에 놓는 것과 제안하는 것 사이가 비어 있었다. `routing/executeOffer.ts` 가 판정을 다
  // 가지고 있는데 **부르는 곳이 테스트뿐**이어서, 지금까지 어떤 통화에서도 오퍼가 열린 적이
  // 없다. 전이·대안·격리 판정은 전부 그 파일 하나이며(§2) 여기서 상태표를 다시 쓰지 않는다 —
  // 이 자리가 하는 일은 셋이다: **이관 직후 같은 호출에서 첫 제안을 열고**, **호스트가 올린
  // 응답을 원장에 반영하면서 재배정을 이어 주고**, **만료분을 수렴시킨다**.

  /** 원장에서 센 다음 회차. 호스트가 선언할 자리를 두지 않는다(`executeOffer` (가)). */
  function nextAttempt(ledger: OfferLedger, interactionId: string): number {
    return ledger.offers.filter((o) => o.interactionId === interactionId).length + 1;
  }

  /**
   * 전이 반영. **거절(`refused`)이면 원장을 쓰지 않는다** — `executeOffer` 가 입력 원장을
   * 그대로 돌려주므로 써도 같지만, 쓰는 것을 규칙으로 두면 나중에 부분 반영이 섞인다.
   *
   * 보고(`onStep`)가 던져도 삼키는 이유: 상담사 데스크톱 알림이 실패한 것이고, 그것 때문에
   * 통화나 만료 수렴이 멈추면 **고객이 큐에 묶인다**. 대신 그 사실을 경고로 남긴다.
   */
  function applyOfferStep(rec: SessionRecord | undefined, interactionId: string, step: OfferStep, via: OfferStepVia): AgentOfferStep {
    const binding = opts.routing?.offers;
    if (step.code !== 'refused') offerStore?.put(step.ledger);
    const out: AgentOfferStep = { ...step, interactionId, via };
    if (step.code === 'refused') {
      warnOnce('W_AGENT_OFFER', `배정 오퍼가 거절됐습니다(${via}): ${step.reasonKo}`);
    } else if (step.code === 'waiting' && step.offer === undefined) {
      // 후보가 없어 큐에 그대로 둔 경우. **소진이 아니다** — 원인은 상담사 부재다.
      warnOnce('W_AGENT_OFFER', '제안할 상담사가 없어 고객을 큐에 그대로 둡니다 — 재배정 한도 소진이 아닙니다(§9.3).');
    } else if (step.code === 'requeue') {
      warnOnce('W_AGENT_OFFER', '재배정이 필요한데 다음 오퍼를 열지 못했습니다 — 해소하지 않으면 고객이 큐에 묶입니다(§9.3).');
    }
    if (binding?.onStep !== undefined) {
      try {
        binding.onStep(out);
      } catch {
        warnOnce('W_AGENT_OFFER', '오퍼 전이 보고(onStep)가 예외로 끝났습니다 — 상담사 데스크톱에 전달되지 않았습니다(§6.2).');
      }
    }
    if (rec !== undefined) sessions.put(rec);
    return out;
  }

  /** 다음 제안에 필요한 후보·id. 호스트 조회가 던지면 **통화를 깨지 않고** 비워 돌려준다. */
  async function askCandidates(req: OfferCandidateRequest): Promise<{ candidates?: readonly string[]; offerId?: string }> {
    const binding = opts.routing?.offers;
    if (binding === undefined) return {};
    let candidates: readonly string[];
    try {
      candidates = await binding.candidates(req);
    } catch {
      warnOnce('W_AGENT_OFFER', '후보 상담사 조회가 예외로 끝나 제안하지 못했습니다 — 고객은 큐에 남습니다(§9.3).');
      return {};
    }
    let offerId: string;
    try {
      offerId = binding.newOfferId(req);
    } catch {
      warnOnce('W_AGENT_OFFER', '오퍼 id 생성이 예외로 끝나 제안하지 못했습니다(§13-3).');
      return {};
    }
    return { candidates, offerId };
  }

  /**
   * 첫 제안을 연다. 배선이 없으면 아무 일도 하지 않는다(종전과 완전히 같다, §13-3).
   *
   * **이미 열린 오퍼가 있으면 열지 않는다** — 같은 세션이 이관 상태에서 턴을 한 번 더 받는
   * 것은 정상 경로이고(채널 재전송·중복 클릭), 거기서 두 번째 오퍼를 열면 두 상담사가 같은
   * 콜을 받는다(`executeOffer` (다)). 이미 열려 있는 것이 **의도한 상태**이므로 경고하지 않는다.
   */
  async function openAgentOffer(rec: SessionRecord, queueId: string, via: OfferStepVia): Promise<AgentOfferStep | undefined> {
    const binding = opts.routing?.offers;
    const cfg = opts.routing?.config;
    if (binding === undefined || cfg === undefined || offerStore === undefined) return undefined;
    const ledger = offerStore.get();
    if (openOfferOf(ledger, opts.scope, rec.interactionId) !== undefined) return undefined;
    const asked = await askCandidates({
      interactionId: rec.interactionId,
      queueId,
      channel: rec.state.channel,
      ...(rec.state.handoff !== undefined ? { reason: rec.state.handoff.reason } : {}),
      attempt: nextAttempt(ledger, rec.interactionId),
    });
    if (asked.candidates === undefined || asked.offerId === undefined) return undefined;
    const step = openOffer(cfg, ledger, binding.policy, {
      scope: opts.scope,
      queueId,
      interactionId: rec.interactionId,
      candidates: asked.candidates,
      offerId: asked.offerId,
      nowIso: now(),
      ...(rec.handoffSummaryMasked !== undefined ? { summaryMasked: rec.handoffSummaryMasked } : {}),
    });
    return applyOfferStep(rec, rec.interactionId, step, via);
  }

  /**
   * 오퍼 이벤트 반영 — `settleOffer` 를 부르고 재배정을 **같은 호출에서** 이어 준다.
   *
   * 후보·다음 id 를 호출자에게 맡기지 않는 이유: 그러면 거절·무응답마다 호스트가 다음 제안을
   * 기억해야 하고, 빠뜨리면 전이는 반영된 채 아무도 제안받지 않아 **고객만 큐에 묶인다**
   * (`executeOffer` (나)). 수락·취소에는 후보를 묻지 않는다 — 재배정이 없는데 상담사 명부를
   * 조회하면 그 실패가 수락을 막는다.
   */
  async function settleAgentOffer(offerId: string, event: OfferEvent, nowIso: string, via: OfferStepVia): Promise<AgentOfferStep | undefined> {
    const binding = opts.routing?.offers;
    const cfg = opts.routing?.config;
    if (binding === undefined || cfg === undefined || offerStore === undefined) return undefined;
    const ledger = offerStore.get();
    const target = ledger.offers.find((o) => o.offerId === offerId);
    const interactionId = target?.interactionId ?? '';
    const rec = interactionId === '' ? undefined : sessions.get(interactionId);
    let next: { candidates?: readonly string[]; offerId?: string } = {};
    if (target !== undefined && (event === 'decline' || event === 'tick')) {
      next = await askCandidates({
        interactionId,
        queueId: target.queueId,
        ...(rec !== undefined ? { channel: rec.state.channel } : {}),
        ...(rec?.state.handoff !== undefined ? { reason: rec.state.handoff.reason } : {}),
        attempt: nextAttempt(ledger, interactionId),
      });
    }
    const step = settleOffer(cfg, ledger, binding.policy, {
      scope: opts.scope,
      offerId,
      event,
      nowIso,
      ...(next.candidates !== undefined ? { candidates: next.candidates } : {}),
      ...(next.offerId !== undefined ? { nextOfferId: next.offerId } : {}),
      ...(rec?.handoffSummaryMasked !== undefined ? { summaryMasked: rec.handoffSummaryMasked } : {}),
    });
    return applyOfferStep(rec, interactionId, step, via);
  }

  /**
   * 고객이 끊었는데 오퍼가 열려 있으면 **취소한다**. 이 한 줄이 없으면 그 오퍼는 영구히
   * `offered` 로 남고, `pickAgent` 는 그 상담사를 "다른 상호작용의 오퍼가 열려 있다"로 보아
   * **모든 후보 목록에서 영구히 제외한다** — 상담사 한 명이 조용히 사라지고, 그 사실은
   * 장애가 아니라 "요즘 왜 이관이 느리지"로만 나타난다.
   */
  async function cancelAgentOffer(rec: SessionRecord): Promise<void> {
    if (offerStore === undefined) return;
    const open = openOfferOf(offerStore.get(), opts.scope, rec.interactionId);
    if (open === undefined) return;
    await settleAgentOffer(open.offerId, 'cancel', now(), 'session_end');
  }

  /** 통화 중 화면 전환(§5.2) — 채널이 초대 능력을 선언한 경우에만 실제 초대를 건다. */
  /** 같은 경고를 세션 수만큼 쌓지 않는다 — 운영 화면이 같은 줄로 가득 차면 아무도 읽지 않는다. */
  function warnOnce(code: ContractIssue['code'], messageKo: string): void {
    if (warnings.some((w) => w.code === code && w.messageKo === messageKo)) return;
    warnings.push({ code, severity: 'warning', messageKo });
  }

  /** 목적지 채널이 지금 등록되어 있는가. 추정하지 않는다 — 등록 사실만 본다(§13-3). */
  function targetRegistered(target: SwitchTargetChannel): boolean {
    for (const reg of regs.values()) {
      if (reg.port.capabilities.channel === target) return true;
    }
    return false;
  }

  /**
   * §5.1 사다리가 화면 전환을 고를 수 있는가. 배선이 없으면 **종전과 똑같이** 채널 능력만 본다(§13-3).
   *
   * 배선이 있으면 전환 성립 조건을 **사다리 판정 전에** 본다. 순서가 중요하다 — 전환을 고른 뒤에
   * 링크 발급이 막히면 `state.channel` 은 이미 화면으로 바뀌어 있고, 고객은 여전히 통화 중인데
   * 화면용으로 렌더된 단계를 듣게 된다. 미리 보면 사다리는 그냥 다음 칸(상담사)으로 간다.
   */
  function switchFeasible(rec: SessionRecord, caps: ChannelCapabilities): boolean {
    if (!caps.crossChannelInvite) return false;
    const cs = opts.channelSwitch;
    if (cs === undefined) return true;
    if (!targetRegistered('visual')) return false;
    try {
      return cs.reachable(rec.interactionId) === true;
    } catch {
      // 확인에 실패한 것을 "확인됨"으로 읽지 않는다. 전환하지 않으면 사다리가 상담사로 내려간다(§5.1).
      warnOnce('W_CHANNEL_SWITCH_UNBOUND', '고객 단말 수신 가능 여부 확인(reachable)이 예외로 끝났습니다 — 전환하지 않고 §5.1 사다리를 따릅니다.');
      return false;
    }
  }

  async function inviteIfSwitched(prev: ChannelKind, next: ChannelKind, rec: SessionRecord, reg: ChannelRegistration): Promise<void> {
    if (prev === next) return;
    if (!rec.channels.includes(next)) rec.channels.push(next);
    if (!reg.port.capabilities.crossChannelInvite || typeof reg.port.invite !== 'function') return;

    const cs = opts.channelSwitch;
    if (cs === undefined || (next !== 'visual' && next !== 'chat')) {
      // 종전 경로 — 토큰 없는 초대. 링크에 실릴 값이 Interaction id 뿐이라는 사실은 등록 시 경고로 남았다.
      await reg.port.invite(rec.interactionId, next);
      return;
    }

    const issued = issueSwitch({
      scope: rec.scope,
      interactionId: rec.interactionId,
      fromChannel: prev,
      toChannel: next,
      reason: cs.reason ?? 'recognition_failure',
      delivery: cs.delivery ?? 'manual',
      newToken: cs.newToken,
      issuedAt: now(),
      ttlMs: cs.ttlMs,
      carry: cs.carry,
      slots: rec.state.slots,
      crossChannelInviteSupported: true,
      targetChannelAvailable: targetRegistered(next),
      reachable: (() => { try { return cs.reachable(rec.interactionId) === true; } catch { return false; } })(),
      registry: cs.invites,
    });

    if (!issued.ok) {
      // **토큰 없는 링크를 만들게 두지 않는다.** invite 를 부르면 채널은 id 로 링크를 만들 수밖에 없고,
      // 그 링크는 1회용도 만료도 없다. 전환을 못 했다는 사실은 경고로 드러낸다(조용히 삼키지 않는다).
      warnOnce('W_CHANNEL_SWITCH_UNBOUND', `채널 전환 초대를 발급하지 못해 링크를 보내지 않았습니다: ${issued.code} ${issued.reasonKo}`);
      return;
    }
    await reg.port.invite(rec.interactionId, next, issued.ticket);
  }

  /**
   * AI 고지를 이번 턴 단계 **맨 앞에** 끼운다(§10.1). 배선이 없으면 아무것도 하지 않는다(§13-3).
   *
   * 여기서 지키는 것:
   * - **steps 배열을 제자리에서 고친다.** 호출부의 `presented` 인덱스 계산·결과 `steps`·
   *   `port.present` 가 전부 같은 배열을 본다. 새 배열을 만들어 돌려주면 한 곳이라도 옛 배열을
   *   들고 있으면 고지가 그 경로에서만 사라지고, 그건 "어떤 호스트에서만 고지가 안 된다"가 된다.
   * - **앞에 넣는다.** 뒤에 붙이면 AI 가 먼저 말한 뒤에 고지가 나가 §10.1 을 지키지 못한다
   *   (Api 대기 안내를 호출 뒤로 옮기면 안내가 아니라 잡음이 되는 것과 같은 자리다).
   * - **채널 단위로 한 번만.** 매 턴 반복하면 안내가 잡음이 되고, 채널이 바뀌면(§5.2) 새 매체는
   *   아직 고지하지 않은 것이므로 다시 낸다 — 고객은 화면을 처음 보는 중이다.
   * - **고지할 수 없으면 AI 응대를 시작하지 않는다.** 미승인 문구 상태로 응대하면 위반이
   *   조용히 누적되고, 드러나는 시점에는 지나간 통화 전부가 대상이다. 통화 1건이 예외로 끝나는
   *   쪽이 낫다 — 배선 시점 검증이 이미 같은 조건을 거르므로 이 경로는 설정 객체가 런타임에
   *   바뀐 경우에만 닿는다(그때는 조용히 넘기면 안 되는 상황이 맞다).
   *
   * 장애 폴백(§9.3)으로 이관·종료되는 경로에서는 부르지 않는다 — **AI 가 응대하지 않았으므로
   * 고지 대상이 없다**. 상담사로 넘기기 직전에 "AI 가 응대합니다"를 내보내면 고지가 아니라 오안내다.
   */
  /**
   * 고지를 이번 턴의 **맨 앞**에 끼운다 — 단계에도, §8.1 원장에도.
   *
   * 이벤트를 함께 남기는 이유(2026-10-04 추가): 고지 발화는 실제로 고객에게 나가는 봇 발화인데
   * **다른 모든 봇 발화와 달리 `turn.completed` 가 만들어지지 않았다.** 그래서 "고지했다"의 근거가
   * 휘발성 반환값(`result.disclosure`)과 채널 쪽 전송 로그밖에 없었고, 원장에는 아무 흔적이 없었다 —
   * 감독기관 점검에서 내놓을 수 있는 것은 턴 결과가 아니라 §8.1 기록이다. 같은 공백 때문에
   * 이벤트 위에서 도는 §7 5.2 준수 점검은 Core 가 **실제로 낸** 고지를 볼 수 없었고, 그대로 두면
   * 고지를 제대로 한 세션이 전부 `disclosure_missing`(critical)으로 잡혀 리뷰 큐가 통째로 잠긴다.
   *
   * **시각은 이 턴의 첫 이벤트에서 가져온다.** 여기서 `now()` 를 새로 부르면 시나리오 첫 발화보다
   * 1ms 늦게 찍히는 경우가 생기고, 그러면 "고지가 첫 응답보다 앞이었나"(§10.1)라는 판정이
   * **밀리초 경계에 따라 간헐적으로 뒤집힌다** — 간헐적으로 생기는 '지각' 위반은 신호가 아니라 잡음이다.
   * 없는 시각을 만드는 것이 아니라 같은 턴의 관측된 시각을 쓴다(§13-3).
   */
  function prependDisclosure(
    rec: SessionRecord, steps: RenderedStep[], events: InteractionEvent[],
  ): ChannelTurnResult['disclosure'] {
    const config = opts.disclosure;
    if (config === undefined) return undefined;
    const channel = rec.state.channel;
    const plan = planDisclosure({
      config, scope: rec.scope, channel, disclosedChannels: rec.disclosedChannels ?? [],
    });
    if (plan.action === 'block') {
      throw new Error(`AI 고지 거부(${plan.code}): ${plan.reasonKo}`);
    }
    if (plan.action === 'skip') {
      // 끈 것·이미 고지한 것은 정상이다. **등록된 채널의 문구 누락만** 드러낸다 —
      // 그 상태는 고지 없이 응대하는 것이고, 배선했다는 사실이 그걸 가려 준다.
      if (plan.code === 'channel_not_configured') warnOnce('W_AI_DISCLOSURE', plan.reasonKo);
      return undefined;
    }
    steps.unshift(plan.step);
    const m = meta(rec);
    const first = events[0];
    events.unshift(turnCompleted(
      { ...m, ...(first !== undefined ? { occurredAt: first.occurred_at } : {}) },
      { turnId: `t_${++rec.state.turnCount}`, speaker: 'bot', utterance: plan.step.text, nodeId: DISCLOSURE_NODE_ID },
    ));
    rec.disclosedChannels = [...(rec.disclosedChannels ?? []), channel];
    return { channel, placement: plan.placement, configVersion: plan.configVersion };
  }

  function consentEvidenceRef(interactionId: string, purpose: ConsentPurpose): string | undefined {
    const cb = opts.consent;
    if (!cb?.evidenceRef) return undefined;
    try {
      const ref = cb.evidenceRef({ interactionId, purpose });
      return typeof ref === 'string' && ref.trim() !== '' ? ref : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 이번 턴의 §10.1 동의 처리. 배선이 없으면 **아무것도 하지 않는다** — 종전과 완전히 같다(§13-3).
   *
   * `pendingNodeId` 는 **이 턴이 시작될 때 입력을 기다리던 노드**다. 턴 처리 후의 슬롯만 보고
   * 기록하면 확정된 `Confirm` 슬롯이 세션에 영구히 남으므로 이후 모든 턴에서 같은 동의가 다시
   * 쌓이고(한 통화에 수십 건), 감사에서는 어느 것이 진짜 동의 시점인지 알 수 없게 된다.
   *
   * 기록 실패는 **통화를 끊지 않는다**. 저장소 장애는 "동의 없음"으로 남아 개인정보 조회만
   * 막히는데(§6.1 게이트) 그것이 안전한 방향이다 — 반대로 하면 기록 없는 동의로 조회가 나간다.
   * 테넌트 격리 위반만 그대로 올라간다(§11.1 — 남의 테넌트 이력에 쌓이는 동의는 동의가 아니다).
   */
  function applyConsentTurn(rec: SessionRecord, pendingNodeId: string | null): ChannelTurnResult['consent'] {
    const cb = opts.consent;
    if (!cb) return undefined;
    const out: NonNullable<ChannelTurnResult['consent']> = {};
    const pendingNode = pendingNodeId === null ? undefined : rec.flow.nodes[pendingNodeId];
    if (isConsentNode(pendingNode)) {
      const purpose = consentPurposeOf(pendingNode.id);
      const evidenceRef = purpose === undefined ? undefined : consentEvidenceRef(rec.interactionId, purpose);
      const plan = planConsentTurn({
        policy: cb.policy,
        scope: rec.scope,
        pendingNode,
        slotsAfter: rec.state.slots,
        nodeAfter: rec.state.currentNodeId,
        failCountAfter: rec.state.failCount,
        subjectRef: consentSubjectRef(rec.interactionId),
        at: now(),
        via: rec.state.channel,
        interactionId: rec.interactionId,
        ...(evidenceRef !== undefined ? { evidenceRef } : {}),
      });
      if (plan.action === 'record') {
        let appended = true;
        try {
          cb.records.append(plan.record);
        } catch {
          appended = false;
        }
        if (appended) {
          out.recorded = { purpose: plan.purpose, state: plan.state, policyVersion: plan.record.policyVersion };
        } else {
          out.notRecordedKo = `${plan.purpose} 동의가 확정됐으나 이력 저장이 실패해 기록되지 않았습니다 — `
            + '그 동의는 근거가 없고, 개인정보 조회는 게이트에서 막힙니다(§10.1·§6.1).';
        }
        cb.onRecord?.({
          interactionId: rec.interactionId, purpose: plan.purpose, recorded: appended, state: plan.state,
          ...(out.notRecordedKo !== undefined ? { reasonKo: out.notRecordedKo } : {}),
        });
      } else if (plan.code !== 'not_consent_turn' && plan.code !== 'unanswered') {
        // 설정 문제다(주체 미설정·미승인 정책·정책 미선언). 삼키면 "동의를 받았다고 생각하는데
        // 이력이 없다"가 몇 주 뒤에 발견된다. 되묻는 중(`unanswered`)은 정상이므로 올리지 않는다.
        out.notRecordedKo = plan.reasonKo;
        cb.onRecord?.({
          interactionId: rec.interactionId, recorded: false, reasonKo: plan.reasonKo,
          ...(plan.purpose !== undefined ? { purpose: plan.purpose } : {}),
        });
      }
    }

    // 필수인데 아직 granted 가 아닌 목적. **막는 데 쓰지 않는다** — 거부 분기는 시나리오가 정한다.
    let records: readonly ConsentRecord[] = [];
    const subjectRef = consentSubjectRef(rec.interactionId);
    if (subjectRef !== undefined) {
      try {
        const listed = cb.records.list(subjectRef);
        if (Array.isArray(listed)) records = listed;
      } catch {
        records = [];   // 조회 실패를 "다 받았다"로 읽지 않는다 — 아래에서 미획득으로 적힌다
      }
    }
    const pending = pendingRequiredConsents(cb.policy, records, subjectRef, now());
    if (pending.length > 0) out.pendingRequired = pending;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function join(req: ChannelSessionRequest, interactionId: string): Promise<ChannelTurnResult> {
    const rec = sessions.get(interactionId);
    if (!rec) throw new Error(`합류할 Interaction이 없습니다: ${interactionId} (§5.2)`);
    if (rec.scope.tenantId !== req.scope.tenantId) {
      throw new Error(`테넌트 격리 위반(채널 합류): 기대=${rec.scope.tenantId} 실제=${req.scope.tenantId} (설계서 §11.1)`);
    }
    // 워크스페이스까지 봐야 격리가 성립한다. 테넌트만 보면 **같은 고객사의 다른 사업부**가
    // 진행 중인 상담에 합류한다 — 타입도 값도 멀쩡해서 어디서도 터지지 않는다(§11.1).
    if ((rec.scope.workspaceId ?? undefined) !== (req.scope.workspaceId ?? undefined)) {
      throw new Error('워크스페이스 격리 위반(채널 합류): 다른 워크스페이스의 Interaction 입니다 (설계서 §11.1)');
    }
    // **끝난 상담에는 합류하지 않는다**(§5.2·§8.1). 전환 링크는 고객의 손에 남으므로 통화가
    // 끊긴 뒤에 눌리는 일이 흔하고(링크가 도착한 순간 통화가 끝나 있는 경우가 가장 많다),
    // 그때 여기를 그냥 통과시키면 Core 는 **`session.ended` 뒤에 `turn.completed`** 를 더한다 —
    // §8.1 은 추가 전용이라 그 줄은 지울 수 없고, 하필 그 발화가 §10.1 AI 고지다. 게다가
    // 그 세션의 §7 5.2 준수 점검은 이미 잠겨 있어(`buf.reviewed`) **그 고지는 점검되지 않는다**.
    // 렌더할 노드도 없으므로(`currentNodeId === null`) 고객이 보는 것은 빈 화면이고, 어디서도
    // 터지지 않는다. `send` 가 늦은 입력에 새 이벤트를 만들지 않는 것과 같은 규칙이며, 여기서는
    // 돌려줄 "직전 결과"가 **다른 매체의 것**이라 거절로 적는다.
    if (rec.ended || rec.state.status !== 'running') {
      throw new Error(
        `합류 거부: 이미 끝난 상담입니다(status=${rec.state.status}) — 종료된 세션에는 새 이벤트를 `
        + '만들지 않습니다. 새 상담으로 시작하십시오 (설계서 §5.2·§8.1)',
      );
    }
    const reg = registration(req.adapter);
    const channel = ADAPTER_CHANNEL[req.adapter];

    // 합류 자격 — 배선이 있으면 **토큰이 있어야만** 합류한다. 없으면 종전과 같다(§13-3),
    // 다만 그 상태는 등록 시점에 경고로 남는다(id 가 곧 열쇠다).
    const cs = opts.channelSwitch;
    if (cs !== undefined) {
      const token = req.joinToken;
      if (typeof token !== 'string' || token.trim() === '') {
        throw new Error('합류 거부: 초대 토큰이 없습니다 — Interaction id 만으로는 합류할 수 없습니다 (설계서 §5.2·§10.3)');
      }
      const redeemed = redeemSwitch({
        registry: cs.invites,
        token,
        scope: req.scope,
        channel,
        at: now(),
        expectInteractionId: interactionId,
      });
      if (!redeemed.ok) {
        // 사유는 운영 로그용이다. 토큰·슬롯 값은 실리지 않는다(§10.3).
        throw new Error(`합류 거부(${redeemed.rejection}): ${redeemed.reasonKo}`);
      }
      // 승계 슬롯은 **덮어쓰지 않는다** — 초대는 발급 시점의 스냅샷이라, 그 사이 통화에서 고객이
      // 정정한 값을 오래된 값으로 되돌리면 방금 고친 내용이 사라진다(applyInvite 와 같은 규칙).
      for (const [k, v] of Object.entries(redeemed.carriedSlots)) {
        if (!k.startsWith('__') && rec.state.slots[k] === undefined) rec.state.slots[k] = v;
      }
    }
    rec.state.channel = channel;
    if (!rec.channels.includes(channel)) rec.channels.push(channel);
    // 같은 Interaction·같은 노드를 새 채널 렌더러로 다시 그린다. 새 발화가 아니므로 턴 이벤트를 만들지 않는다(§8.1).
    const node = rec.state.currentNodeId === null ? undefined : rec.flow.nodes[rec.state.currentNodeId];
    const steps = node ? [renderNode(node, channel)] : [];
    // 합류한 매체에서는 아직 고지하지 않았다 — 고객은 이 화면을 처음 본다(§5.2·§10.3).
    // 렌더할 단계가 없어도 고지는 나간다: 화면이 열린 것 자체가 AI 응대의 시작이다.
    // 고지는 **새 매체에서 처음 나가는 발화**이므로 §8.1 턴 이벤트가 생긴다(재렌더와 다르다).
    const events: InteractionEvent[] = [];
    const disclosure = prependDisclosure(rec, steps, events);
    // 합류는 새 발화가 아니므로 확정된 동의가 없다. 다만 화면이 열리는 이 지점이 §10.1 동의를
    // 받기 가장 좋은 자리이므로, 지금 미획득인 필수 목적은 그대로 드러낸다.
    const consent = applyConsentTurn(rec, null);
    // 합류한 매체에도 §9.3 축소 지시를 찍는다. 지금 열 수 있는 목적지(화면·채팅)는 STT·TTS 에
    // 의존하지 않아 대개 빈 목록이지만, **경로마다 따로 판단하지 않는다** — 빠뜨린 경로는
    // "그 채널에서만 안 꺼진다"로 나타나고 그건 재현이 가장 어려운 종류의 결함이다(§2).
    stampOutage(steps, health(channel));
    recordTurns(rec, events);
    const result: ChannelTurnResult = {
      interactionId: rec.interactionId, state: rec.state, steps, status: rec.state.status, events,
      ...(disclosure !== undefined ? { disclosure } : {}),
      ...(consent !== undefined ? { consent } : {}),
      ...complianceSlot(rec, events),
    };
    rec.lastResult = result;
    // **`lastResult` 까지 같은 `put` 에 담는다**(`start`·`send`·`end` 와 같은 순서). 지금까지는
    // `put` 이 결과 조립보다 앞에 있어서, 영속 `SessionStore` 를 끼운 호스트에서는 합류 턴의
    // `lastResult` 가 저장되지 않았다 — 인메모리 구현에서는 같은 객체라 보이지 않지만, 직렬화하는
    // 저장소에서는 다음 호출이 **합류 전(다른 매체) 결과**를 읽고, 그 값이 늦은 입력의 응답으로
    // 그대로 나간다(§5.2). 전달 실패로 상태를 잃지 않도록 발행·present 보다 먼저 저장한다.
    sessions.put(rec);
    await publish(events);
    const shown = visibleSteps(steps);
    if (shown.length > 0) await reg.port.present(rec.interactionId, shown);
    return result;
  }

  /**
   * 진입점 본체. 관측은 아래 `core` 에서 이 셋을 **감싸서** 한다 — 본체 안에 기록을 흩어 두면
   * 조기 반환 경로(장애 폴백 종료·이미 끝난 세션·합류·커넥터 조기 종료)에서 하나는 반드시 빠지고,
   * 빠진 쪽은 "로그에 없으니 그런 통화는 없었다"로 읽힌다.
   */
  const impl = {
    async start(req: ChannelSessionRequest): Promise<ChannelTurnResult> {
      // 한도는 **아무 일을 하기 전에** 본다 — 거절된 호출이 세션·이벤트·과금에 흔적을 남기면
      // 제한이 막으려던 폭주가 원장에 그대로 쌓인다(§11.2).
      enforceLimit('start');
      assertTenantScope(req.scope);
      if (req.scope.tenantId !== opts.scope.tenantId) {
        throw new Error(`테넌트 격리 위반(세션 시작): 코어=${opts.scope.tenantId} 요청=${req.scope.tenantId} (설계서 §11.1)`);
      }
      const reg = registration(req.adapter);
      if (req.joinInteractionId !== undefined) return join(req, req.joinInteractionId);

      const channel = ADAPTER_CHANNEL[req.adapter];
      // 배포본 경로가 있으면 **이 채널에 걸린 버전**을 고른다(§5.3). 없으면 종전과 같다(§13-3).
      const flow = resolveFlow(req.flowId, channel, req.flowVersion);
      if (!flow) {
        // 사유를 아는 조회면 그대로 싣는다 — "찾을 수 없습니다" 하나로 미배포·미승인·오타를
        // 뭉개면 운영자는 오타를 찾으러 가고 원인은 배포 누락이다.
        const reasonKo = flowReasonKo(req.flowId, channel, req.flowVersion);
        throw new Error(
          `시나리오를 찾을 수 없습니다: ${req.flowId}${req.flowVersion !== undefined ? ` v${req.flowVersion}` : ''}`
          + `${reasonKo !== '' ? ` — ${reasonKo}` : ''} (§5.3)`,
        );
      }
      noteFlowResolution(req.flowId, channel, req.flowVersion);
      const unsupported = checkFlowSupported(flow, reg.port.capabilities).filter((i) => i.severity === 'error');
      if (unsupported.length > 0) {
        // 렌더 불가 노드를 가진 시나리오는 시작하지 않는다 — 통화 중간에 막히는 것이 더 나쁘다(§5.3).
        throw new Error(`${req.adapter} 채널에서 실행할 수 없는 시나리오입니다: ${unsupported.map((i) => i.messageKo).join(' / ')}`);
      }
      // 동의 노드 결함은 **시작 전에** 거른다(렌더 불가 노드와 같은 이유, §5.3). 통화 중에
      // 드러나면 이미 늦고, 통과시키면 침묵을 동의로 적거나 받은 동의를 놓치는 두 사고 중
      // 하나가 반드시 일어난다 — 둘 다 예외가 아니라 **동의 이력의 거짓**으로 남는다(§10.1).
      const consentDefects = consentNodeDefects(flow);
      if (consentDefects.length > 0) {
        throw new Error(
          '동의 질문 노드가 성립하지 않습니다: '
          + consentDefects.map((d) => `${d.nodeId}(${d.defect})`).join(', ')
          + ' — 예약 id 는 Confirm 노드여야 하고, 뒤에 적힌 목적이 ConsentPurpose 여야 하며, '
          + '분기가 자기 자신을 가리키면 확정과 되묻는 중을 가를 수 없습니다 (설계서 §10.1)',
        );
      }
      const flowConsentNodes = consentNodes(flow);
      if (opts.consent === undefined && flowConsentNodes.length > 0) {
        // 묻고는 있는데 기록이 없다. 종전 동작이므로 막지 않되 조용히 두지도 않는다 —
        // 이 상태에서 고객의 "네"는 Confirm 슬롯 값으로만 남고 **동의 기록은 0건**이다.
        // 점검·분쟁에서 필요한 것은 슬롯이 아니라 목적·정책 버전·시각이 적힌 기록이다.
        warnOnce('W_CONSENT_UNBOUND',
          `시나리오 ${flow.id} v${flow.version} 에 동의 질문 노드가 ${flowConsentNodes.length}건 있으나 동의 배선(consent)이 없습니다 — `
          + '고객의 답이 동의 기록이 아니라 슬롯 값으로만 남습니다(§10.1).');
      }
      if (opts.consent !== undefined) {
        // 필수 목적을 묻는 노드가 이 시나리오에 없으면 그 동의는 **이 통화에서 영원히 미획득**이고,
        // 개인정보를 싣는 조회는 계속 막힌다. 막지는 않는다 — 다른 경로(포털·IVR 메뉴)에서 받은
        // 동의가 이력에 있을 수 있기 때문이다. 다만 아무도 모르는 채로 두지 않는다.
        const asked = new Set(flowConsentNodes.map((n) => n.purpose));
        const unasked = opts.consent.policy.requirements
          .filter((r) => r.required && !asked.has(r.purpose)).map((r) => r.purpose);
        if (unasked.length > 0) {
          warnOnce('W_CONSENT',
            `필수 동의 목적을 묻는 노드가 시나리오 ${flow.id} v${flow.version} 에 없습니다: ${unasked.join(', ')} — `
            + '다른 경로에서 받은 동의가 없으면 그 동의는 이 통화에서 획득되지 않습니다(§10.1).');
        }
      }
      if (opts.consent === undefined && opts.connectors !== undefined && opts.connectors.consent === undefined) {
        // 동의 컨텍스트 출처가 아무것도 없는데 개인정보를 싣는 커넥터가 있다. 그 조회는 통화 중
        // **언제나** `consent_context_missing` 으로 막히는데 업무시스템은 멀쩡하므로 장애로
        // 보이지 않고 "그 메뉴만 안 된다"로만 나타난다. 판정 조건은 `requiresConsent` 하나다(§2).
        const gated: string[] = [];
        for (const node of Object.values(flow.nodes)) {
          if (node.kind !== 'Api') continue;
          let def;
          try {
            def = opts.connectors.connectors.get(node.connectorId);
          } catch {
            def = undefined;      // 조회 실패는 위 missingConnectors 가 막는다
          }
          if (def !== undefined && requiresConsent(def)) gated.push(`${node.id}→${def.id}`);
        }
        if (gated.length > 0) {
          warnOnce('W_CONSENT_UNBOUND',
            `개인정보·국외이전이 선언된 커넥터를 부르는 Api 노드가 있으나 동의 컨텍스트 출처가 없습니다: ${gated.join(', ')} — `
            + '그 조회는 통화 중 언제나 동의 게이트에서 막힙니다(§10.1·§6.1).');
        }
      }
      if (opts.intent === undefined && Object.values(flow.nodes).some((n) => isIntentEntryNode(n))) {
        // 인텐트 진입 노드가 있는데 배선이 없다. 종전 동작이므로 막지 않되 조용히 두지도 않는다 —
        // 이 상태에서 고객의 "카드를 잃어버렸어요"는 **슬롯 값으로 저장된 채** 흐름이 그대로 진행된다.
        // 예외도 재프롬프트도 없어 어디서도 터지지 않고, 증상은 "봇이 엉뚱한 안내를 한다" 뿐이다.
        warnOnce('W_INTENT_UNBOUND',
          `시나리오 ${flow.id} v${flow.version} 에 인텐트 진입 노드가 있으나 인텐트 배선(intent)이 없습니다 — `
          + '고객의 답이 인텐트가 아니라 슬롯 값으로 저장됩니다(§5.1·§5.3).');
      }
      if (opts.knowledge === undefined && Object.values(flow.nodes).some((n) => isKnowledgeEntryNode(n))) {
        // 지식 응대 진입 노드가 있는데 배선이 없다. 종전 동작이므로 막지 않되 조용히 두지도 않는다 —
        // 이 상태에서 고객의 "수수료가 얼마예요"는 **슬롯 값으로 저장된 채** 흐름이 그대로 진행되고,
        // **아무도 답하지 않는다**. 예외도 재프롬프트도 없어 어디서도 터지지 않는다(§5.2).
        warnOnce('W_KNOWLEDGE_UNBOUND',
          `시나리오 ${flow.id} v${flow.version} 에 지식 응대 진입 노드가 있으나 지식 배선(knowledge)이 없습니다 — `
          + '고객의 질문이 답변 대신 슬롯 값으로 저장됩니다(§5.2).');
      }
      if (opts.connectors) {
        // 렌더 불가 노드와 같은 이유로 **시작 전에** 본다(§5.3). 커넥터 id 오타·미배포는 통화 중에
        // 예외가 아니라 조회 실패로만 나타나고, 그때는 이미 고객이 회선에 있다.
        const missing = missingConnectors(flow, opts.connectors.connectors);
        if (missing.length > 0) {
          throw new Error(
            `선언되지 않은 커넥터를 가리키는 Api 노드가 있습니다: ${missing.map((m) => `${m.nodeId}→${m.connectorId}`).join(', ')} (설계서 §6.1)`,
          );
        }
      }

      const interactionId = newId(req);
      const rec: SessionRecord = {
        interactionId, adapter: req.adapter, scope: req.scope, flow,
        state: stubState(flow.id, flow.version, channel, 'running'),
        startedAt: now(), channels: [channel], turns: [], ended: false,
        lastResult: { interactionId, state: stubState(flow.id, flow.version, channel, 'running'), steps: [], status: 'running', events: [] },
      };
      if (req.correlationId !== undefined) rec.correlationId = req.correlationId;

      const decision = health(channel);
      // 장애로 되돌려보내더라도 "콜이 들어왔다"는 사실은 남긴다 — 유입 통계가 비면 원인 분석이 불가능하다(§8.1).
      const prelude: InteractionEvent[] = [
        sessionStarted(meta(rec), req.entryPoint !== undefined ? { entryPoint: req.entryPoint } : {}),
      ];
      const outage = await applyOutage(rec, decision, reg, prelude);
      if (outage) {
        // 세션 자체가 성립하지 않았어도 §8.1 집계에는 "들어온 콜"로 남아야 한다.
        return outage;
      }

      const ctx = runnerCtx(rec, reg.port.capabilities, req.entryPoint);
      const run = runnerStart(flow, ctx);
      rec.state = run.state;
      for (const [k, v] of Object.entries(req.presetSlots ?? {})) {
        if (!k.startsWith('__')) rec.state.slots[k] = v;   // 예약 슬롯은 채널이 덮어쓸 수 없다
      }
      // 고지는 **첫 단계보다 앞에** 들어가야 하므로 커넥터 이행보다 먼저 끼운다(§10.1) —
      // Api 대기 안내가 먼저 present 되는 시나리오에서는 그 안내가 곧 첫 발화다.
      const disclosure = prependDisclosure(rec, run.steps, run.events);
      // §9.3 축소 지시는 **고지를 끼운 뒤에** 찍는다 — 고지 발화도 같은 매체로 나가므로
      // 끼우기 전에 찍으면 하필 첫 발화가 지시 없이 합성된다.
      stampOutage(run.steps, decision);
      // Api 노드는 여기서 이행한다. presetSlots 를 병합한 **뒤에** 부른다 — 커넥터 파라미터가
      // 채널이 넘긴 슬롯에서 오는 경우(발신번호·회원번호) 앞서 부르면 필수 슬롯 누락으로 막힌다.
      const drained = await drainConnectors(rec, reg, run, decision);
      const events = drained.events;
      // **이관 턴에서는 여기서 기록하지 않는다**(`send` 와 같은 규칙). 요약은 이번 턴까지
      // 반영되어야 하므로 `attachSummary` 가 스스로 전문을 기록하는데, 그 전에 한 번 더 기록하면
      // 같은 발화가 `rec.turns` 에 **두 벌** 쌓인다. 예외는 없고 증상은 상담사 화면에만 나타난다 —
      // 요약의 "직전 대화"에 같은 줄이 두 번 적히고 턴 수가 2배로 적히며, 그 통화의
      // §4.1 자동완결 판정(`resolveOutcome`)도 두 벌의 전문을 본다(§2·§13-3).
      // 첫 턴에 바로 상담사로 가는 시나리오(대표번호 직결·인텐트 `handoffOnly`·커넥터 순회 상한)가
      // 전부 이 경로다.
      const summaryMasked = rec.state.handoff ? attachSummary(rec, events) : undefined;
      if (!rec.state.handoff) recordTurns(rec, events);
      rec.ended = rec.state.status !== 'running';
      // 세션 시작에는 확정된 동의가 없다 — 아직 아무것도 묻지 않았다. 다만 **필수인데 지금
      // 미획득인 목적**은 첫 응답부터 드러낸다(그 동안 개인정보 조회가 막힌다는 뜻이다).
      const consent = applyConsentTurn(rec, null);
      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: drained.steps, status: rec.state.status, events,
        ...(decision.mode === 'degraded_ai' ? { fallback: decision } : {}),
        ...(disclosure !== undefined ? { disclosure } : {}),
        ...(consent !== undefined ? { consent } : {}),
        // 첫 턴에 끝난 세션(커넥터 순회 상한·즉시 종료 시나리오)도 점검 대상이다.
        ...complianceSlot(rec, events),
        ...(rec.state.handoff ? { handoff: { ...(rec.state.handoff.queue !== undefined ? { queue: rec.state.handoff.queue } : {}), ...(summaryMasked !== undefined ? { summaryMasked } : {}) } } : {}),
      };
      rec.lastResult = result;
      sessions.put(rec);                 // 전달 실패로 상태를 잃지 않도록 먼저 저장한다
      await publish(events);
      // 펌프가 이미 내보낸 단계는 다시 내보내지 않는다 — 대기 안내가 두 번 나가면 안내가 아니다.
      const shown = visibleSteps(drained.steps.slice(drained.presented));
      if (shown.length > 0) await reg.port.present(interactionId, shown);
      await deliverHandoff(reg, rec, summaryMasked, result);
      if (drained.endReasonKo !== undefined) await reg.port.end(interactionId, drained.endReasonKo);
      return result;
    },

    async send(interactionId: string, turn: ChannelTurnInput): Promise<ChannelTurnResult> {
      // 끝난 세션의 늦은 입력(아래 조기 반환)도 세어야 한다 — 전송 계층의 재시도 루프는
      // 대개 그 경로로 몰린다. 세지 않으면 제한을 걸어 둔 테넌트에서 그 폭주만 통과한다.
      enforceLimit('send');
      const rec = sessions.get(interactionId);
      if (!rec) throw new Error(`세션을 찾을 수 없습니다: ${interactionId}`);
      const reg = registration(rec.adapter);
      // 종료된 세션에 늦게 도착한 입력은 새 이벤트를 만들지 않는다(멱등, §8.1).
      // events를 비워 돌려준다 — 채널이 마지막 결과를 다시 발행해 중복 집계하는 경로를 막는다.
      if (rec.ended || rec.state.status !== 'running') {
        // 실측을 선언하지 않았으면 **직전 턴의 결과 그대로**다(종전과 완전히 같다, §13-3).
        if (turn.usage === undefined) return { ...rec.lastResult, events: [] };
        // 선언했으면 `billing` 을 그대로 돌려줄 수 없다. 그 필드는 "**이 호출의** 실측이 어디까지
        // 실렸는가"인데, 직전 턴의 `usageAttached: true` 를 그대로 되돌려주면 호스트는 방금
        // 보낸 실측이 원장에 들어갔다고 읽는다 — 들어가지 않았고, 그 차이는 예외가 아니라
        // 몇 주 뒤 대사의 '미설명' 차이로만 나타난다(§11.2). 전송 계층 재시도 루프가 이 경로로
        // 몰리므로 건수도 적지 않다. 종료된 세션에 `turn.completed` 를 뒤늦게 만들지는 않는다
        // (추가 전용, §8.1) — `end()` 가 늦은 `billableMs` 를 다루는 방식과 같은 규칙이다.
        return {
          ...rec.lastResult,
          events: [],
          billing: {
            usageAttached: false,
            usageReasonKo: '이미 종료된 세션에 늦게 도착한 입력이라 고객 발화 이벤트를 만들지 않았고 '
              + '실측을 실을 자리가 없었습니다(추가 전용 이벤트는 뒤늦게 고치지 않습니다, §8.1) — '
              + '그 사용량은 과금 집계에 들어가지 않습니다(§11.2).',
          },
        };
      }

      const decision = health(rec.state.channel);
      const outage = await applyOutage(rec, decision, reg);
      if (outage) {
        // 폴백으로 조기 종료된 턴에는 고객 발화 이벤트가 없다 — 그런데 채널은 이 입력을 만들려고
        // 이미 STT 를 돌렸고 그 비용은 공급사 청구서에 남는다. 지금까지는 그 실측이 조용히
        // 사라져 대사에서 '이벤트 유실'로 오진됐다. 싣지 못한다는 사실을 그대로 돌려준다(§11.2).
        if (turn.usage === undefined) return outage;
        return {
          ...outage,
          billing: {
            usageAttached: false,
            usageReasonKo: `장애 폴백(${decision.mode})으로 이 턴에 고객 발화 이벤트가 만들어지지 않아 실측을 실을 자리가 없었습니다 — 그 사용량은 과금 집계에 들어가지 않습니다(§9.3·§11.2).`,
          },
        };
      }

      const prevChannel = rec.state.channel;
      // 이 턴이 **기다리던** 노드. 동의 확정 판정의 기준이다(§10.1) — 턴 뒤의 슬롯만 보면
      // 확정된 Confirm 값이 세션에 영구히 남아 이후 모든 턴에서 같은 동의가 다시 쌓인다.
      const pendingNodeId = rec.state.currentNodeId;
      const ctx = runnerCtx(rec, reg.port.capabilities);
      // 엔진 호출 수를 **턴 전에** 기록한다 — 이 턴에 생긴 실측만 싣기 위한 기준점이다(§11.2).
      const engineCallsBefore = engineCalls;
      // 턴 단위로 선언된 실측(§13-3 응답시간·§5.1 신뢰도)을 입력에 싣는다 — 선언이 없으면
      // 종전과 완전히 같다. 이 한 줄이 없는 동안 그 둘은 경계에서 사라졌다(`applyTurnFacts`).
      const run = await runTurn(rec, ctx, applyTurnFacts(turn), decision);
      rec.state = run.state;

      // §11.2 과금 근거는 실측만 싣는다. 커넥터 이행 **전에** 붙인다 —
      // 이행이 만든 봇 발화가 뒤에 쌓여도 대상이 흔들리지 않게.
      const billing = attachUsage(run.events, turn.usage, engineTurnUsage(engineCallsBefore));
      // 채널이 이 턴에 바뀌었으면(§5.2) 새 매체는 아직 고지 전이다 — 이미 고지한 채널이면
      // 아무것도 하지 않으므로 턴마다 반복되지 않는다.
      const disclosure = prependDisclosure(rec, run.steps, run.events);
      // 동의는 **커넥터 이행보다 먼저** 반영한다(§10.1·§6.1). 같은 턴에서 동의를 받고 곧바로
      // 개인정보 조회로 넘어가는 시나리오(동의 → Api)가 가장 흔한 모양이고, 순서가 뒤면 방금 받은
      // 동의가 이력에 없는 상태로 게이트를 지나 그 조회만 조용히 막힌다.
      stampOutage(run.steps, decision);
      const consent = applyConsentTurn(rec, pendingNodeId);
      const drained = await drainConnectors(rec, reg, run, decision);
      const events = drained.events;
      const summaryMasked = rec.state.handoff ? attachSummary(rec, events) : undefined;
      if (!rec.state.handoff) recordTurns(rec, events);
      rec.ended = rec.state.status !== 'running';

      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: drained.steps, status: rec.state.status, events,
        ...(decision.mode === 'degraded_ai' ? { fallback: decision } : {}),
        ...(disclosure !== undefined ? { disclosure } : {}),
        ...(consent !== undefined ? { consent } : {}),
        ...(rec.state.handoff ? { handoff: { ...(rec.state.handoff.queue !== undefined ? { queue: rec.state.handoff.queue } : {}), ...(summaryMasked !== undefined ? { summaryMasked } : {}) } } : {}),
        ...(billing !== undefined ? { billing } : {}),
        ...complianceSlot(rec, events),
      };
      rec.lastResult = result;
      sessions.put(rec);
      await publish(events);
      await inviteIfSwitched(prevChannel, rec.state.channel, rec, reg);
      const shown = visibleSteps(drained.steps.slice(drained.presented));
      if (shown.length > 0) await reg.port.present(interactionId, shown);
      await deliverHandoff(reg, rec, summaryMasked, result);
      if (drained.endReasonKo !== undefined) await reg.port.end(interactionId, drained.endReasonKo);
      return result;
    },

    async end(interactionId: string, reasonKo: string, input?: ChannelEndInput): Promise<ChannelTurnResult> {
      const rec = sessions.get(interactionId);
      if (!rec) throw new Error(`세션을 찾을 수 없습니다: ${interactionId}`);
      const reg = registration(rec.adapter);
      // §11.2 통화 과금 구간. **던지지 않는다** — 과금 근거가 틀렸다는 이유로 종료를 막으면 세션이
      // 열린 채 남고, 그 누수는 장애가 아니라 요금으로 나타난다(브리지가 end 를 막지 않는 것과 같다).
      const check = input?.billableMs === undefined ? undefined : checkBillableMs(input.billableMs);
      // 열린 오퍼는 **`rec.ended` 분기보다 먼저** 취소한다. 이관된 세션은 그 턴에서 이미
      // `ended` 가 되므로(이관은 AI 세션의 끝이다), 아래 조기 반환 뒤에 두면 **큐에서 기다리다
      // 끊은 고객의 오퍼가 영구히 `offered` 로 남는다** — 그러면 그 상담사는 `pickAgent` 가
      // "다른 상호작용의 오퍼가 열려 있다"로 보아 모든 후보 목록에서 영구히 제외되고, 상담사
      // 한 명이 조용히 사라진다. 상담사가 이미 수락한 오퍼는 열려 있지 않으므로 손대지 않는다.
      await cancelAgentOffer(rec);
      if (rec.ended) {
        // 이미 종료된 세션에는 실을 수 없다. `session.ended` 는 추가 전용이므로 뒤늦게 고쳐 넣는
        // 경로를 만들지 않는다(§8.1) — 대신 그 통화의 과금 근거가 집계에 없다는 사실을 돌려준다.
        // 장애 폴백이 세션을 먼저 끝낸 통화가 전부 이 경로로 온다.
        const note: TurnBillingNote | undefined = check === undefined ? undefined : {
          billableMsRecorded: false,
          billableMsReasonKo: '세션이 이미 종료돼 session.ended 에 통화 구간을 실을 수 없었습니다 '
            + '(추가 전용 이벤트는 뒤늦게 고치지 않습니다, §8.1) — 이 통화는 통화 분 집계에서 빠집니다(§11.2).',
        };
        return { ...rec.lastResult, events: [], ...(note !== undefined ? { billing: note } : {}) };
      }

      // §4.1 — 목표 미달 상태에서 고객이 끊으면 자동완결이 아니다.
      const outcome = resolveOutcome({
        id: rec.interactionId, tenantId: rec.scope.tenantId, startedAt: rec.startedAt, endedAt: now(),
        channels: [...rec.channels], turns: rec.turns, entities: { ...rec.state.slots },
      });
      const mEnded = meta(rec);
      const events: InteractionEvent[] = [sessionEnded(mEnded, {
        outcome, turnCount: rec.state.turnCount,
        // 세션 전체 길이와 **과금 구간은 다른 값이다**(§11.2): 전자는 Core 가 재고, 후자는
        // 대기·호 설정을 포함할지가 계약 사항이라 채널이 선언한다. 길이로 과금 구간을 대신
        // 채우지 않는다 — 그 한 줄이 통화 요금의 근거를 추정으로 바꾼다(§13-3).
        ...sessionDuration(rec, mEnded.occurredAt),
        ...(check?.ok ? { billableMs: check.billableMs } : {}),
      })];
      rec.state.status = 'completed';
      rec.state.currentNodeId = null;
      rec.ended = true;
      const billing = endBillingNote(rec, check);
      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: [], status: 'completed', events,
        ...(billing !== undefined ? { billing } : {}),
        ...complianceSlot(rec, events),
      };
      rec.lastResult = result;
      sessions.put(rec);
      await publish(events);
      await reg.port.end(interactionId, reasonKo);
      return result;
    },
  };

  const core: ConversationCore = {
    contractVersion: CHANNEL_CONTRACT_VERSION,
    sessions,
    warnings: () => [...warnings],
    capabilitiesOf: (adapter) => regs.get(adapter)?.port.capabilities,
    observability: () => observer?.stats(),
    flushObservability: () => observer?.flush() ?? 0,

    // 배선이 없으면 `undefined` — 빈 보고서는 "확인했고 0건"으로 읽힌다(§13-3).
    runRecoveryProbes: (nowIso) => (recovery === undefined
      ? Promise.resolve(undefined)
      : recovery.runDue(nowIso)),
    recoveryLastRunAt: (component) => recovery?.lastRunAt(component),

    // 배선이 없으면 `undefined` — 빈 객체는 "조립했는데 비었다"로 읽힌다(§13-3).
    engines: () => engineRuntime,

    agentOffers: () => offerStore?.get(),
    settleAgentOffer: (p) => settleAgentOffer(p.offerId, p.event, p.nowIso ?? now(), 'settle'),
    async runOfferExpiry(nowIso) {
      if (offerStore === undefined) return undefined;
      const at = nowIso ?? now();
      let due: readonly AssignmentOffer[];
      try {
        // 시각 형태가 틀리면 `expiredOffers` 가 던진다 — 빈 목록으로 바꾸면 "만료된 오퍼가
        // 없다"로 읽히므로, 판정이 돌지 않았다는 사실을 보고서에 적어 올린다(§13-3).
        due = expiredOffers(offerStore.get(), opts.scope, at);
      } catch (e) {
        const whyKo = e instanceof Error ? e.message : String(e);
        warnOnce('W_AGENT_OFFER', `오퍼 만료 판정을 돌리지 못했습니다: ${whyKo}`);
        return { expired: 0, steps: [], issues: [whyKo] };
      }
      const steps: AgentOfferStep[] = [];
      for (const o of due) {
        // 건마다 **원장을 다시 읽는다** — 앞 건의 재배정이 같은 원장에 새 오퍼를 더하므로,
        // 한 번 읽은 원장으로 전부 처리하면 뒤 건이 앞 건의 반영을 덮어쓴다.
        const step = await settleAgentOffer(o.offerId, 'tick', at, 'expiry');
        if (step !== undefined) steps.push(step);
      }
      return { expired: due.length, steps, issues: [] };
    },

    readiness: (req) => runReadiness({
      timeoutMs: req.timeoutMs,
      ...(req.probes !== undefined ? { probes: req.probes } : {}),
      ...(req.clock !== undefined ? { clock: req.clock } : {}),
      ...(req.build !== undefined ? { build: req.build } : {}),
      ...(req.scheduler !== undefined ? { scheduler: req.scheduler } : {}),
      core: {
        // 시각은 런타임의 시계 하나다 — readiness 가 자기 시계를 쓰면 통화가 올린 샘플의
        // 낡음이 다른 기준으로 판정된다(§2·§13-3).
        nowIso: now(),
        registry: opts.health,
        policy: opts.policy,
        // **목록을 만들지 않는다**(§13-3): 채널 등록에서 선언된 컴포넌트와 실제로 등록된
        // 채널만 싣는다. 전 컴포넌트를 실으면 쓰지도 않는 엔진이 영구 `unknown` 으로 남아
        // 대시보드가 상시 노랑이 되고, 그러면 진짜 저하를 아무도 보지 않는다.
        components: [...watched],
        channels: [...new Set([...regs.values()].map((reg) => reg.port.capabilities.channel))],
        // 활성화 전 컴포넌트는 **Core 가 아는 것부터** 싣는다(§13-3). 호스트가 빠뜨리면
        // dry_run 엔진이 영구 `unknown` 으로 남아 대시보드가 상시 노랑이 되고, 그러면
        // 진짜 저하를 아무도 보지 않는다. 호스트 선언은 지우지 않고 합친다.
        ...(req.approvalPending !== undefined || engineRuntime !== undefined
          ? {
            approvalPending: [...new Set([
              ...(req.approvalPending ?? []),
              ...(engineRuntime?.approvalPending ?? []),
            ])],
          }
          : {}),
      },
    }),

    start: (req) => observe(
      'start',
      { adapter: req.adapter, ...(req.correlationId !== undefined ? { correlationId: req.correlationId } : {}) },
      () => impl.start(req),
    ),
    send: (interactionId, turn) => observe('send', { interactionId }, () => impl.send(interactionId, turn)),
    end: (interactionId, reasonKo, input) => observe('end', { interactionId }, () => impl.end(interactionId, reasonKo, input)),

    reportHealth(report: ChannelHealthReport): void {
      const allowed = declared.get(report.adapter);
      const accepted: HealthSample[] = [];
      let ignored = 0;
      if (allowed !== undefined) {
        for (const s of report.samples) {
          // 선언하지 않은 컴포넌트의 샘플은 무시한다 — 아무 채널이나 전체 폴백을 유발할 수 없다(§9.3).
          if (allowed.has(s.component)) {
            opts.health.record(s);
            accepted.push(s);
          } else {
            ignored += 1;
          }
        }
      }
      // 버려진 보고를 관측에 남긴다. 이 자리는 **조용한 실패의 전형**이었다 — 등록되지 않은
      // 채널이나 선언하지 않은 컴포넌트의 샘플은 통째로 사라지는데, 헬스를 성실히 올리는 채널과
      // 아무 신호도 전달되지 않는 채널이 바깥에서 구분되지 않았다(§9.3).
      observer?.record({
        op: 'health',
        scope: opts.scope,
        ...(isKnownAdapter(report.adapter) ? { adapter: report.adapter } : {}),
        health: {
          ...(isKnownAdapter(report.adapter) ? { adapter: report.adapter } : {}),
          registered: allowed !== undefined,
          // 등록되지 않은 채널의 보고는 순회하지 않으므로(종전 동작) 개수만 센다 —
          // 배열이 아닌 값을 0 으로 적지 않기 위해 형태를 확인한다.
          offered: Array.isArray(report.samples) ? report.samples.length : 0,
          accepted,
          ignored,
        },
      });
    },
  };

  // 등록 시점 경고는 **여기서** 나간다 — 첫 통화를 기다리면, 한 통도 받지 않는 인스턴스
  // (대기 중인 예비 인스턴스·배포 직후)는 미배선 사실을 끝까지 알리지 못한다.
  drainWarnings();
  return core;
}
