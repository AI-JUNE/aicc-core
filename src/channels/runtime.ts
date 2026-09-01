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
import type { FlowState, RunStatus, RunnerContext } from '../flow/runner.ts';
import { start as runnerStart, send as runnerSend } from '../flow/runner.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { EventMeta, InteractionEvent, TurnCompletedEvent, HandoffRequestedEvent } from '../events/schema.ts';
import { sessionStarted, sessionEnded, handoffRequested } from '../events/schema.ts';
import type { EventBus, PublishResult } from '../events/bus.ts';
import type { ComponentId, FallbackDecision, FallbackPolicy, HealthRegistry, HealthSample } from '../ops/fallback.ts';
import { decideFallbackMode } from '../ops/fallback.ts';
import type { SummaryOptions } from '../core/handoffSummary.ts';
import { buildHandoffSummary, requiredSlotsOf } from '../core/handoffSummary.ts';
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
  summary?: SummaryOptions;
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
      const events = run.events;
      recordTurns(rec, events);
      const summaryMasked = rec.state.handoff ? attachSummary(rec, events) : undefined;
      rec.ended = rec.state.status !== 'running';
      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: run.steps, status: rec.state.status, events,
        ...(decision.mode === 'degraded_ai' ? { fallback: decision } : {}),
        ...(rec.state.handoff ? { handoff: { ...(rec.state.handoff.queue !== undefined ? { queue: rec.state.handoff.queue } : {}), ...(summaryMasked !== undefined ? { summaryMasked } : {}) } } : {}),
      };
      rec.lastResult = result;
      sessions.put(rec);                 // 전달 실패로 상태를 잃지 않도록 먼저 저장한다
      await publish(events);
      const shown = visibleSteps(run.steps);
      if (shown.length > 0) await reg.port.present(interactionId, shown);
      if (rec.state.handoff) await reg.port.transfer(interactionId, rec.state.handoff.queue, summaryMasked);
      return result;
    },

    async send(interactionId: string, turn: ChannelTurnInput): Promise<ChannelTurnResult> {
      const rec = sessions.get(interactionId);
      if (!rec) throw new Error(`세션을 찾을 수 없습니다: ${interactionId}`);
      const reg = registration(rec.adapter);
      // 종료된 세션에 늦게 도착한 입력은 새 이벤트를 만들지 않는다(멱등, §8.1).
      if (rec.ended || rec.state.status !== 'running') return rec.lastResult;

      const decision = health(rec.state.channel);
      const outage = await applyOutage(rec, decision, reg);
      if (outage) return outage;

      const prevChannel = rec.state.channel;
      const ctx = runnerCtx(rec, reg.port.capabilities);
      const run = runnerSend(rec.flow, rec.state, turn.input, ctx);
      rec.state = run.state;

      const events = run.events;
      if (turn.usage !== undefined) {
        // §11.2 과금 근거는 실측만 싣는다. 이번 턴의 고객 발화 이벤트에 붙인다.
        for (let idx = events.length - 1; idx >= 0; idx--) {
          const e = events[idx];
          if (e && e.type === 'turn.completed' && (e as TurnCompletedEvent).speaker === 'customer') {
            events[idx] = { ...(e as TurnCompletedEvent), usage: turn.usage };
            break;
          }
        }
      }
      const summaryMasked = rec.state.handoff ? attachSummary(rec, events) : undefined;
      if (!rec.state.handoff) recordTurns(rec, events);
      rec.ended = rec.state.status !== 'running';

      const result: ChannelTurnResult = {
        interactionId, state: rec.state, steps: run.steps, status: rec.state.status, events,
        ...(decision.mode === 'degraded_ai' ? { fallback: decision } : {}),
        ...(rec.state.handoff ? { handoff: { ...(rec.state.handoff.queue !== undefined ? { queue: rec.state.handoff.queue } : {}), ...(summaryMasked !== undefined ? { summaryMasked } : {}) } } : {}),
      };
      rec.lastResult = result;
      sessions.put(rec);
      await publish(events);
      await inviteIfSwitched(prevChannel, rec.state.channel, rec, reg);
      const shown = visibleSteps(run.steps);
      if (shown.length > 0) await reg.port.present(interactionId, shown);
      if (rec.state.handoff) await reg.port.transfer(interactionId, rec.state.handoff.queue, summaryMasked);
      return result;
    },

    async end(interactionId: string, reasonKo: string): Promise<ChannelTurnResult> {
      const rec = sessions.get(interactionId);
      if (!rec) throw new Error(`세션을 찾을 수 없습니다: ${interactionId}`);
      const reg = registration(rec.adapter);
      if (rec.ended) return rec.lastResult;      // 중복 종료 요청은 이벤트를 늘리지 않는다

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
