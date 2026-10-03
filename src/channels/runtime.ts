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
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { EventMeta, InteractionEvent, LatencyMs, TurnCompletedEvent, HandoffRequestedEvent, UsageMetrics } from '../events/schema.ts';
import { sessionStarted, sessionEnded, handoffRequested } from '../events/schema.ts';
import type { EventBus, PublishResult } from '../events/bus.ts';
import type { ComponentId, FallbackDecision, FallbackPolicy, HealthRegistry, HealthSample } from '../ops/fallback.ts';
import { decideFallbackMode } from '../ops/fallback.ts';
import type { SummaryOptions } from '../core/handoffSummary.ts';
import { buildHandoffSummary, requiredSlotsOf } from '../core/handoffSummary.ts';
import type { AdmissionOptions, QueueSnapshot, RoutingConfig } from '../routing/agentQueue.ts';
import { validateRoutingConfig } from '../routing/agentQueue.ts';
import type { HandoffPlacement } from '../routing/executeHandoff.ts';
import { executeHandoff } from '../routing/executeHandoff.ts';
import type { InviteDeliveryKind, InviteRegistry, SlotCarryPolicy, SwitchReason, SwitchTargetChannel } from '../core/channelSwitch.ts';
import { issueSwitch, redeemSwitch } from '../core/executeSwitch.ts';
import type { AiDisclosureConfig } from '../portal/aiDisclosure.ts';
import { planDisclosure, validateDisclosureBinding } from '../core/executeDisclosure.ts';
import type { ConnectorPumpBinding } from '../integration/connectorPump.ts';
import { connectorHopLimit, hopLimitInput, missingConnectors, pumpConnectorHop } from '../integration/connectorPump.ts';
import type { IntentCatalog, IntentPolicy } from '../nlu/intent.ts';
import { validateIntentCatalog, validateIntentPolicy } from '../nlu/intent.ts';
import type { FlowLookup, IntentRoutingTable } from '../nlu/intentRouting.ts';
import { intentRoutingOk, validateIntentRouting } from '../nlu/intentRouting.ts';
import type { ClassifyStatus, IntentClassifier } from '../nlu/llmClassifier.ts';
import type { PendingClarify } from '../nlu/executeIntentEntry.ts';
import { resolveIntentEntry } from '../nlu/executeIntentEntry.ts';
import type { RetrievalPolicy } from '../knowledge/rag.ts';
import { assertRetrievalPolicy } from '../knowledge/rag.ts';
import type { Answerer } from '../knowledge/answer.ts';
import type { Retriever } from '../knowledge/retrieval.ts';
import type { KnowledgeFailureCause, KnowledgeUsage } from '../knowledge/executeKnowledge.ts';
import { resolveKnowledgeTurn } from '../knowledge/executeKnowledge.ts';
import type { TurnBillingNote } from '../billing/turnUsage.ts';
import { attachTurnUsage, billingNoteOrUndefined, checkBillableMs, mergeTurnUsage, usageNote } from '../billing/turnUsage.ts';
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
  /** 발화 → 후보(§6.2). 주입이다 — Core 는 엔진을 모르고, 실호출 승인도 호스트 쪽에 있다 **[승인 필요]**. */
  classifier: IntentClassifier;
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
  /** 질의 → 근거(§6.2). 주입이다 — 실엔진·실 벡터 DB 연결은 호스트 쪽이다 **[승인 필요]**. */
  retriever: Retriever;
  /** 근거 → 답변(§6.2). 같은 이유로 주입이다 **[승인 필요]**. */
  answerer: Answerer;
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
  now?: () => string;
  newInteractionId?: (req: ChannelSessionRequest) => string;
  onPublish?: (results: PublishResult[]) => void;
}

export interface ConversationCore extends ConversationCorePort {
  /** 등록 시 남은 경고(§9.3 폴백 경로 없음 등). 운영이 반드시 보게 노출한다. */
  warnings(): ContractIssue[];
  capabilitiesOf(adapter: ChannelAdapterId): ChannelCapabilities | undefined;
  sessions: SessionStore;
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

export function createConversationCore(opts: ConversationCoreOptions): ConversationCore {
  assertTenantScope(opts.scope);

  const sessions = opts.sessions ?? createMemorySessionStore();
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newInteractionId ?? ((req) => `i_${req.adapter}_${Date.now().toString(36)}`);
  const warnings: ContractIssue[] = [];
  const regs = new Map<ChannelAdapterId, ChannelRegistration>();
  const declared = new Map<ChannelAdapterId, Set<ComponentId>>();

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

  for (const reg of opts.channels) {
    const issues = validateRegistration(reg);
    if (!registrationOk(issues)) {
      throw new Error(`채널 등록 거부(${reg.port.id}): ${issues.filter((i) => i.severity === 'error').map((i) => i.messageKo).join(' / ')}`);
    }
    warnings.push(...issues.filter((i) => i.severity === 'warning'));
    regs.set(reg.port.id, reg);
    declared.set(reg.port.id, new Set(reg.reportsComponents));
  }

  // 인텐트 배선도 **배포 시점에** 거른다. 통화 중에 "카탈로그에 없는 인텐트"로 터지면 이미 늦고,
  // 형태 오류를 통과로 두면 오타 하나로 인텐트 진입이 조용히 꺼진 채 "적용했다"로 남는다
  // (라우팅·전환·요청 제한기와 같은 규칙). 라우팅 표 검증은 `validateIntentRouting` 하나만 쓴다(§2).
  if (opts.intent !== undefined) {
    const it = opts.intent;
    if (!it.classifier || typeof it.classifier.classify !== 'function') {
      throw new Error('인텐트 배선 거부: 분류기(classifier)가 없습니다 — Core 는 엔진을 직접 부르지 않습니다 (설계서 §6.2)');
    }
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
  if (opts.knowledge !== undefined) {
    const kb = opts.knowledge;
    if (!kb.retriever || typeof kb.retriever.retrieve !== 'function') {
      throw new Error('지식 응대 배선 거부: 검색기(retriever)가 없습니다 — Core 는 벡터 스토어를 직접 부르지 않습니다 (설계서 §6.2)');
    }
    if (!kb.answerer || typeof kb.answerer.answer !== 'function') {
      throw new Error('지식 응대 배선 거부: 답변기(answerer)가 없습니다 — Core 는 엔진을 직접 부르지 않습니다 (설계서 §6.2)');
    }
    try {
      // 판정 규칙을 복사하지 않는다 — 정책 검증은 `assertRetrievalPolicy` 하나다(§2).
      assertRetrievalPolicy(kb.policy);
    } catch (e) {
      throw new Error(`지식 응대 배선 거부: ${e instanceof Error ? e.message : String(e)}`);
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
   * 채널이 선언한 §11.2 실측을 이번 턴 이벤트에 싣는다.
   *
   * 검증·충돌 판정은 `billing/turnUsage.ts` 한 곳에서 한다 — 브리지(JSONL) 경로는 사용량을
   * 검사했지만 TypeScript 호스트가 `ChannelTurnInput.usage` 로 바로 넘기는 이 경로는 **아무 검사도
   * 없었다**. 그 비대칭의 결과는 같은 값이 경로에 따라 다르게 집계되는 것이고(§2), `NaN` 하나가
   * 그 테넌트의 월 집계 전체를 NaN 으로 만든다.
   *
   * 실을 자리가 없으면 **조용히 버리지 않는다** — 버려진 실측은 원장에도 집계에도 없는데 공급사
   * 청구서에는 남아 있어서, 대사에서 '이벤트 유실'로 오진된다.
   */
  function attachUsage(events: InteractionEvent[], declared: UsageMetrics | undefined): TurnBillingNote | undefined {
    if (declared === undefined) return undefined;
    const merged = mergeTurnUsage([{ origin: 'channel', usage: declared }]);
    const note = usageNote(merged, merged.usage === undefined ? undefined : attachTurnUsage(events, merged.usage));
    if (merged.usage === undefined) {
      note.usageAttached = false;
      note.usageReasonKo = '선언된 사용량에 실측으로 쓸 수 있는 항목이 없어 이벤트에 싣지 않았습니다(§11.2).';
    }
    return billingNoteOrUndefined(note);
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
      events.push(sessionEnded(meta(rec), { outcome: 'FAILED', turnCount: rec.state.turnCount }));
      rec.ended = true;
      await publish(events);
      const result: ChannelTurnResult = { interactionId: id, state: rec.state, steps: [], status: 'failed', events, fallback: decision };
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
    events.push(sessionEnded(meta(rec), { outcome: 'TRANSFERRED', turnCount: rec.state.turnCount }));
    const summaryMasked = attachSummary(rec, events);
    rec.ended = true;
    await publish(events);
    const result: ChannelTurnResult = {
      interactionId: id, state: rec.state, steps: [], status: 'transferred', events, fallback: decision,
      handoff: { ...(queue !== undefined ? { queue } : {}), ...(summaryMasked !== undefined ? { summaryMasked } : {}) },
    };
    rec.lastResult = result;
    sessions.put(rec);

    if (decision.mode === 'legacy_ivr' && typeof reg.port.routeToLegacyIvr === 'function') {
      await reg.port.routeToLegacyIvr(id, decision.reasonKo);
    } else {
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
    rec: SessionRecord, reg: ChannelRegistration, run: RunResult,
  ): Promise<{ steps: RenderedStep[]; events: InteractionEvent[]; presented: number; endReasonKo?: string }> {
    const binding = opts.connectors;
    const steps: RenderedStep[] = [...run.steps];
    const events: InteractionEvent[] = [...run.events];
    let presented = 0;
    if (!binding || rec.state.pendingConnectorId === undefined) return { steps, events, presented };
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
        steps.push(...next.steps);
        events.push(...next.events);
        delete rec.connectorCall;                // 결과가 왔다 — 다음에 같은 노드를 밟으면 새 호출이다

        if (hops >= limit && rec.state.pendingConnectorId !== undefined) {
          // 실패 입력조차 다시 Api 대기로 돌아왔다. 시나리오 순환이며 진행할 방법이 없다.
          delete rec.state.pendingConnectorId;
          rec.state.status = 'failed';
          rec.state.currentNodeId = null;
          rec.state.error = 'Api 노드 순회 상한 초과(커넥터 순환 의심)';
          events.push(sessionEnded(meta(rec), { outcome: 'FAILED', turnCount: rec.state.turnCount }));
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
    const outcome = await resolveKnowledgeTurn(
      { retriever: binding.retriever, answerer: binding.answerer, policy: binding.policy },
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
        flows: channelFlows(rec.state.channel), classifier: binding.classifier, clarifyPrompt: binding.clarifyPrompt,
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
  function prependDisclosure(rec: SessionRecord, steps: RenderedStep[]): ChannelTurnResult['disclosure'] {
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
    rec.disclosedChannels = [...(rec.disclosedChannels ?? []), channel];
    return { channel, placement: plan.placement, configVersion: plan.configVersion };
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
    const disclosure = prependDisclosure(rec, steps);
    sessions.put(rec);
    const shown = visibleSteps(steps);
    if (shown.length > 0) await reg.port.present(rec.interactionId, shown);
    const result: ChannelTurnResult = {
      interactionId: rec.interactionId, state: rec.state, steps, status: rec.state.status, events: [],
      ...(disclosure !== undefined ? { disclosure } : {}),
    };
    rec.lastResult = result;
    return result;
  }

  const core: ConversationCore = {
    contractVersion: CHANNEL_CONTRACT_VERSION,
    sessions,
    warnings: () => [...warnings],
    capabilitiesOf: (adapter) => regs.get(adapter)?.port.capabilities,

    async start(req: ChannelSessionRequest): Promise<ChannelTurnResult> {
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
      const disclosure = prependDisclosure(rec, run.steps);
      // Api 노드는 여기서 이행한다. presetSlots 를 병합한 **뒤에** 부른다 — 커넥터 파라미터가
      // 채널이 넘긴 슬롯에서 오는 경우(발신번호·회원번호) 앞서 부르면 필수 슬롯 누락으로 막힌다.
      const drained = await drainConnectors(rec, reg, run);
      const events = drained.events;
      recordTurns(rec, events);
      const summaryMasked = rec.state.handoff ? attachSummary(rec, events) : undefined;
      rec.ended = rec.state.status !== 'running';
      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: drained.steps, status: rec.state.status, events,
        ...(decision.mode === 'degraded_ai' ? { fallback: decision } : {}),
        ...(disclosure !== undefined ? { disclosure } : {}),
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
      const rec = sessions.get(interactionId);
      if (!rec) throw new Error(`세션을 찾을 수 없습니다: ${interactionId}`);
      const reg = registration(rec.adapter);
      // 종료된 세션에 늦게 도착한 입력은 새 이벤트를 만들지 않는다(멱등, §8.1).
      // events를 비워 돌려준다 — 채널이 마지막 결과를 다시 발행해 중복 집계하는 경로를 막는다.
      if (rec.ended || rec.state.status !== 'running') return { ...rec.lastResult, events: [] };

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
      const ctx = runnerCtx(rec, reg.port.capabilities);
      const run = await runTurn(rec, ctx, turn.input, decision);
      rec.state = run.state;

      // §11.2 과금 근거는 실측만 싣는다. 커넥터 이행 **전에** 붙인다 —
      // 이행이 만든 봇 발화가 뒤에 쌓여도 대상이 흔들리지 않게.
      const billing = attachUsage(run.events, turn.usage);
      // 채널이 이 턴에 바뀌었으면(§5.2) 새 매체는 아직 고지 전이다 — 이미 고지한 채널이면
      // 아무것도 하지 않으므로 턴마다 반복되지 않는다.
      const disclosure = prependDisclosure(rec, run.steps);
      const drained = await drainConnectors(rec, reg, run);
      const events = drained.events;
      const summaryMasked = rec.state.handoff ? attachSummary(rec, events) : undefined;
      if (!rec.state.handoff) recordTurns(rec, events);
      rec.ended = rec.state.status !== 'running';

      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: drained.steps, status: rec.state.status, events,
        ...(decision.mode === 'degraded_ai' ? { fallback: decision } : {}),
        ...(disclosure !== undefined ? { disclosure } : {}),
        ...(rec.state.handoff ? { handoff: { ...(rec.state.handoff.queue !== undefined ? { queue: rec.state.handoff.queue } : {}), ...(summaryMasked !== undefined ? { summaryMasked } : {}) } } : {}),
        ...(billing !== undefined ? { billing } : {}),
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
      const events: InteractionEvent[] = [sessionEnded(meta(rec), {
        outcome, turnCount: rec.state.turnCount,
        ...(check?.ok ? { billableMs: check.billableMs } : {}),
      })];
      rec.state.status = 'completed';
      rec.state.currentNodeId = null;
      rec.ended = true;
      const billing = endBillingNote(rec, check);
      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: [], status: 'completed', events,
        ...(billing !== undefined ? { billing } : {}),
      };
      rec.lastResult = result;
      sessions.put(rec);
      await publish(events);
      await reg.port.end(interactionId, reasonKo);
      return result;
    },

    reportHealth(report: ChannelHealthReport): void {
      const allowed = declared.get(report.adapter);
      if (!allowed) return;    // 등록되지 않은 채널의 보고는 받지 않는다
      for (const s of report.samples) {
        // 선언하지 않은 컴포넌트의 샘플은 무시한다 — 아무 채널이나 전체 폴백을 유발할 수 없다(§9.3).
        if (allowed.has(s.component)) opts.health.record(s);
      }
    },
  };

  return core;
}
