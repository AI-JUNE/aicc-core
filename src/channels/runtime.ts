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
import { renderNode } from '../flow/types.ts';
import type { FlowInput, FlowState, RunResult, RunStatus, RunnerContext } from '../flow/runner.ts';
import { start as runnerStart, send as runnerSend } from '../flow/runner.ts';
import type { RepromptPolicy } from '../flow/reprompt.ts';
import { repromptPolicyOk, validateRepromptPolicy } from '../flow/reprompt.ts';
import type { TurnTimingPolicy } from '../flow/timing.ts';
import { turnTimingPolicyOk, validateTurnTimingPolicy } from '../flow/timing.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { EventMeta, InteractionEvent, TurnCompletedEvent, HandoffRequestedEvent } from '../events/schema.ts';
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
import type { ConnectorPumpBinding } from '../integration/connectorPump.ts';
import { connectorHopLimit, hopLimitInput, missingConnectors, pumpConnectorHop } from '../integration/connectorPump.ts';
import type {
  ChannelAdapterId, ChannelHealthReport, ChannelRegistration, ChannelSessionRequest,
  ChannelTurnInput, ChannelTurnResult, ConversationCorePort, ContractIssue, ChannelCapabilities,
} from './contract.ts';
import { ADAPTER_CHANNEL, CHANNEL_CONTRACT_VERSION, checkFlowSupported, registrationOk, validateRegistration } from './contract.ts';

/** 시나리오 조회. 버전을 지정하지 않으면 가장 높은 버전을 준다(§5.3 배포 수명주기와 맞물린다). */
export interface FlowRegistry {
  get(flowId: string, version?: number): Flow | undefined;
}

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

  for (const reg of opts.channels) {
    const issues = validateRegistration(reg);
    if (!registrationOk(issues)) {
      throw new Error(`채널 등록 거부(${reg.port.id}): ${issues.filter((i) => i.severity === 'error').map((i) => i.messageKo).join(' / ')}`);
    }
    warnings.push(...issues.filter((i) => i.severity === 'warning'));
    regs.set(reg.port.id, reg);
    declared.set(reg.port.id, new Set(reg.reportsComponents));
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
      visualAvailable: caps.channel === 'visual' || caps.crossChannelInvite,
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
  async function inviteIfSwitched(prev: ChannelKind, next: ChannelKind, rec: SessionRecord, reg: ChannelRegistration): Promise<void> {
    if (prev === next) return;
    if (!rec.channels.includes(next)) rec.channels.push(next);
    if (reg.port.capabilities.crossChannelInvite && typeof reg.port.invite === 'function') {
      await reg.port.invite(rec.interactionId, next);
    }
  }

  async function join(req: ChannelSessionRequest, interactionId: string): Promise<ChannelTurnResult> {
    const rec = sessions.get(interactionId);
    if (!rec) throw new Error(`합류할 Interaction이 없습니다: ${interactionId} (§5.2)`);
    if (rec.scope.tenantId !== req.scope.tenantId) {
      throw new Error(`테넌트 격리 위반(채널 합류): 기대=${rec.scope.tenantId} 실제=${req.scope.tenantId} (설계서 §11.1)`);
    }
    const reg = registration(req.adapter);
    const channel = ADAPTER_CHANNEL[req.adapter];
    rec.state.channel = channel;
    if (!rec.channels.includes(channel)) rec.channels.push(channel);
    // 같은 Interaction·같은 노드를 새 채널 렌더러로 다시 그린다. 새 발화가 아니므로 턴 이벤트를 만들지 않는다(§8.1).
    const node = rec.state.currentNodeId === null ? undefined : rec.flow.nodes[rec.state.currentNodeId];
    const steps = node ? [renderNode(node, channel)] : [];
    sessions.put(rec);
    const shown = visibleSteps(steps);
    if (shown.length > 0) await reg.port.present(rec.interactionId, shown);
    const result: ChannelTurnResult = {
      interactionId: rec.interactionId, state: rec.state, steps, status: rec.state.status, events: [],
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

      const flow = opts.flows.get(req.flowId, req.flowVersion);
      if (!flow) {
        throw new Error(`시나리오를 찾을 수 없습니다: ${req.flowId}${req.flowVersion !== undefined ? ` v${req.flowVersion}` : ''} (§5.3)`);
      }
      const unsupported = checkFlowSupported(flow, reg.port.capabilities).filter((i) => i.severity === 'error');
      if (unsupported.length > 0) {
        // 렌더 불가 노드를 가진 시나리오는 시작하지 않는다 — 통화 중간에 막히는 것이 더 나쁘다(§5.3).
        throw new Error(`${req.adapter} 채널에서 실행할 수 없는 시나리오입니다: ${unsupported.map((i) => i.messageKo).join(' / ')}`);
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

      const channel = ADAPTER_CHANNEL[req.adapter];
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
      if (outage) return outage;

      const prevChannel = rec.state.channel;
      const ctx = runnerCtx(rec, reg.port.capabilities);
      const run = runnerSend(rec.flow, rec.state, turn.input, ctx);
      rec.state = run.state;

      if (turn.usage !== undefined) {
        // §11.2 과금 근거는 실측만 싣는다. 이번 턴의 고객 발화 이벤트에 붙인다.
        // 커넥터 이행 **전에** 붙인다 — 이행이 만든 봇 발화가 뒤에 쌓여도 대상이 흔들리지 않게.
        for (let idx = run.events.length - 1; idx >= 0; idx--) {
          const e = run.events[idx];
          if (e && e.type === 'turn.completed' && (e as TurnCompletedEvent).speaker === 'customer') {
            run.events[idx] = { ...(e as TurnCompletedEvent), usage: turn.usage };
            break;
          }
        }
      }
      const drained = await drainConnectors(rec, reg, run);
      const events = drained.events;
      const summaryMasked = rec.state.handoff ? attachSummary(rec, events) : undefined;
      if (!rec.state.handoff) recordTurns(rec, events);
      rec.ended = rec.state.status !== 'running';

      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: drained.steps, status: rec.state.status, events,
        ...(decision.mode === 'degraded_ai' ? { fallback: decision } : {}),
        ...(rec.state.handoff ? { handoff: { ...(rec.state.handoff.queue !== undefined ? { queue: rec.state.handoff.queue } : {}), ...(summaryMasked !== undefined ? { summaryMasked } : {}) } } : {}),
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

    async end(interactionId: string, reasonKo: string): Promise<ChannelTurnResult> {
      const rec = sessions.get(interactionId);
      if (!rec) throw new Error(`세션을 찾을 수 없습니다: ${interactionId}`);
      const reg = registration(rec.adapter);
      if (rec.ended) return { ...rec.lastResult, events: [] };   // 중복 종료 요청은 이벤트를 늘리지 않는다

      // §4.1 — 목표 미달 상태에서 고객이 끊으면 자동완결이 아니다.
      const outcome = resolveOutcome({
        id: rec.interactionId, tenantId: rec.scope.tenantId, startedAt: rec.startedAt, endedAt: now(),
        channels: [...rec.channels], turns: rec.turns, entities: { ...rec.state.slots },
      });
      const events: InteractionEvent[] = [sessionEnded(meta(rec), { outcome, turnCount: rec.state.turnCount })];
      rec.state.status = 'completed';
      rec.state.currentNodeId = null;
      rec.ended = true;
      const result: ChannelTurnResult = { interactionId, state: rec.state, steps: [], status: 'completed', events };
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
