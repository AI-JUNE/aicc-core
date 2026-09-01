// FlowRunner — 설계서 §5.3(단일 시나리오)·§5.1(폴백)·§8.1(이벤트).
// 하나의 Flow를 채널 렌더러만 바꿔 실행한다. 순수 함수: 입력 state를 변형하지 않고 새 state를 돌려준다.
// 실엔진·실회선은 호출하지 않는다(입력은 상위 계층이 어댑터로부터 받아 전달).
import type { ChannelKind, Handoff, Outcome } from '../domain/types.ts';
import type { Flow, FlowNode, RenderedStep } from './types.ts';
import { renderNode } from './types.ts';
import { decideFallback, type FallbackAction } from '../core/session.ts';
import {
  sessionStarted, turnCompleted, handoffRequested, sessionEnded,
  type EntryPoint, type EventMeta, type InteractionEvent, type LatencyMs,
} from '../events/schema.ts';

export type RunStatus = 'running' | 'completed' | 'transferred' | 'failed';

export type FlowInput =
  | { kind: 'utterance'; text: string; confidence?: number; latency?: LatencyMs }
  | { kind: 'dtmf'; digits: string; latency?: LatencyMs }
  | { kind: 'timeout' }
  /**
   * 외부 연동 호출 결과(§6.1). Runner는 순수·동기 함수이므로 커넥터를 직접 부르지 않는다.
   * 호스트가 Api 단계를 보고 호출한 뒤, 결과만 이 입력으로 되돌려준다.
   * slots 는 applyResponse()를 통과한 값이어야 한다 — 마스킹 책임은 커넥터 계층에 있다(§10.3).
   */
  | { kind: 'connectorResult'; ok: boolean; slots?: Record<string, string>; errorCode?: string; latency?: LatencyMs };

export interface FlowState {
  flowId: string;
  flowVersion: number;
  channel: ChannelKind;             // 폴백으로 전환될 수 있다(§5.1)
  currentNodeId: string | null;
  slots: Record<string, string>;
  /** 현재 노드에서의 연속 실패 횟수 */
  failCount: number;
  turnCount: number;
  eventSeq: number;
  status: RunStatus;
  visited: string[];
  lastFallback?: FallbackAction;
  handoff?: { reason: Handoff['reason']; queue?: string };
  /** Api 노드에서 대기 중인 커넥터 id. 값이 있으면 호스트의 호출 결과를 기다리는 상태다(§6.1). */
  pendingConnectorId?: string;
  error?: string;
}

export interface RunnerContext {
  tenantId: string;
  interactionId: string;
  channel: ChannelKind;
  /** §5.1 — 2회 실패 시 화면 전환이 가능한 세션인지 */
  visualAvailable: boolean;
  /** 신뢰도 임계값. 테넌트 설정값이며 미지정 시 신뢰도 게이팅을 하지 않는다(임의 수치 금지 §13-3). */
  minConfidence?: number;
  entryPoint?: EntryPoint;
  /** 시각 주입 — 테스트 결정성을 위해 교체 가능 */
  now?: () => string;
}

export interface RunResult {
  state: FlowState;
  steps: RenderedStep[];
  events: InteractionEvent[];
}

const YES = ['1', 'y', 'yes', '네', '예', '응', '맞아요', '맞습니다', '그래요'];
const NO = ['2', 'n', 'no', '아니', '아니요', '아니오', '아닙니다', '틀려요'];

function nowOf(ctx: RunnerContext): string {
  return (ctx.now ?? (() => new Date().toISOString()))();
}

function meta(s: FlowState, ctx: RunnerContext): EventMeta {
  s.eventSeq += 1;
  return {
    eventId: `${ctx.interactionId}_e${s.eventSeq}`,
    occurredAt: nowOf(ctx),
    tenantId: ctx.tenantId,
    interactionId: ctx.interactionId,
    channel: s.channel,
    flowId: s.flowId,
    flowVersion: s.flowVersion,
  };
}

function clone(s: FlowState): FlowState {
  return { ...s, slots: { ...s.slots }, visited: [...s.visited] };
}

function inputText(input: FlowInput): string {
  if (input.kind === 'utterance') return input.text.trim();
  if (input.kind === 'dtmf') return input.digits.trim();
  return '';
}

function inputLatency(input: FlowInput): LatencyMs {
  return input.kind === 'timeout' || input.kind === 'connectorResult' ? {} : (input.latency ?? {});
}

/** 신뢰도 임계값이 설정된 테넌트에서만 게이팅한다 */
function confidenceOk(input: FlowInput, ctx: RunnerContext): boolean {
  if (ctx.minConfidence === undefined) return true;
  if (input.kind !== 'utterance' || input.confidence === undefined) return true;
  return input.confidence >= ctx.minConfidence;
}

function terminate(s: FlowState, ctx: RunnerContext, events: InteractionEvent[], status: RunStatus, outcome: Outcome): void {
  s.status = status;
  s.currentNodeId = null;
  events.push(sessionEnded(meta(s, ctx), { outcome, turnCount: s.turnCount }));
}

/** 입력이 필요 없는 노드(Say)를 연속 실행하고, 입력 대기 노드나 종료에서 멈춘다. */
function advance(flow: Flow, s: FlowState, ctx: RunnerContext, steps: RenderedStep[], events: InteractionEvent[]): void {
  const limit = Object.keys(flow.nodes).length + 1;  // 구조적 상한(순환 방어)
  for (let hops = 0; hops <= limit; hops++) {
    if (s.status !== 'running') return;
    if (s.currentNodeId === null) {
      s.slots['__goal_completed__'] = 'true';
      // 자연 종료. 최종 Outcome은 §4.1 resolveOutcome이 재문의 반영 후 확정한다.
      terminate(s, ctx, events, 'completed', 'AUTO_RESOLVED');
      return;
    }
    const node: FlowNode | undefined = flow.nodes[s.currentNodeId];
    if (!node) {
      s.error = `정의되지 않은 노드: ${s.currentNodeId}`;
      terminate(s, ctx, events, 'failed', 'FAILED');
      return;
    }
    if (!s.visited.includes(node.id)) s.visited.push(node.id);
    const step = renderNode(node, s.channel);
    steps.push(step);
    // 무음 단계(Api 대기)는 발화가 없으므로 턴으로 집계하지 않는다 — 없는 발화가 통계에 잡히면 §8.1 신뢰도가 깨진다.
    if (step.silent !== true) {
      events.push(turnCompleted(meta(s, ctx), {
        turnId: `t_${++s.turnCount}`, speaker: 'bot', utterance: step.text, nodeId: node.id,
      }));
    }

    if (node.kind === 'Api') {
      // 호출은 호스트가 한다(§6.2). Runner는 대기 상태만 표시하고 결과 입력을 기다린다.
      s.pendingConnectorId = node.connectorId;
      return;
    }

    if (node.kind === 'Transfer') {
      s.handoff = { reason: (node.reason as Handoff['reason']) ?? 'policy', queue: node.queue };
      events.push(handoffRequested(meta(s, ctx), { reason: s.handoff.reason, toQueue: node.queue }));
      terminate(s, ctx, events, 'transferred', 'TRANSFERRED');
      return;
    }
    if (node.kind === 'Say') { s.currentNodeId = node.next ?? null; continue; }
    return;  // Collect·Choice·Confirm — 고객 입력 대기
  }
  s.error = '노드 순회 상한 초과(순환 의심)';
  terminate(s, ctx, events, 'failed', 'FAILED');
}

export function start(flow: Flow, ctx: RunnerContext): RunResult {
  const s: FlowState = {
    flowId: flow.id, flowVersion: flow.version, channel: ctx.channel,
    currentNodeId: flow.startNodeId, slots: {}, failCount: 0, turnCount: 0,
    eventSeq: 0, status: 'running', visited: [],
  };
  const steps: RenderedStep[] = [];
  const events: InteractionEvent[] = [];
  events.push(sessionStarted(meta(s, ctx), ctx.entryPoint !== undefined ? { entryPoint: ctx.entryPoint } : {}));
  advance(flow, s, ctx, steps, events);
  return { state: s, steps, events };
}

interface Resolution { ok: boolean; next?: string | null; slot?: { key: string; value: string } }

function resolve(node: FlowNode, input: FlowInput, ctx: RunnerContext): Resolution {
  const v = inputText(input);
  if (input.kind === 'timeout' || v === '' || !confidenceOk(input, ctx)) return { ok: false };

  switch (node.kind) {
    case 'Collect':
      return { ok: true, next: node.next ?? null, slot: { key: node.slot, value: v } };
    case 'Choice': {
      const byValue = node.options.find(o => o.value === v || o.label === v);
      const idx = /^\d+$/.test(v) ? Number(v) - 1 : -1;
      const picked = byValue ?? (idx >= 0 && idx < node.options.length ? node.options[idx] : undefined);
      if (!picked) return { ok: false };
      return { ok: true, next: picked.next ?? node.next ?? null, slot: { key: node.id, value: picked.value } };
    }
    case 'Confirm': {
      const low = v.toLowerCase();
      if (YES.includes(low)) return { ok: true, next: node.onYes ?? node.next ?? null, slot: { key: `${node.id}__confirmed`, value: 'yes' } };
      if (NO.includes(low)) return { ok: true, next: node.onNo ?? node.next ?? null, slot: { key: `${node.id}__confirmed`, value: 'no' } };
      return { ok: false };
    }
    default:
      return { ok: false };
  }
}

/** 고객 입력 1건을 처리한다. 입력 state는 변형되지 않는다. */
export function send(flow: Flow, prev: FlowState, input: FlowInput, ctx: RunnerContext): RunResult {
  const s = clone(prev);
  const steps: RenderedStep[] = [];
  const events: InteractionEvent[] = [];
  if (s.status !== 'running' || s.currentNodeId === null) return { state: s, steps, events };

  const node: FlowNode | undefined = flow.nodes[s.currentNodeId];
  if (!node) {
    s.error = `정의되지 않은 노드: ${s.currentNodeId}`;
    terminate(s, ctx, events, 'failed', 'FAILED');
    return { state: s, steps, events };
  }

  // ── Api 노드 대기 구간 (§6.1) ───────────────────────────────────────────────
  // 커넥터 결과 외의 입력은 무시한다. 조회 중 고객이 말을 걸어도 흐름을 흔들지 않는다.
  if (node.kind === 'Api') {
    if (input.kind !== 'connectorResult') return { state: s, steps, events };
    delete s.pendingConnectorId;
    if (input.ok) {
      // slots 는 커넥터 계층에서 allowlist·마스킹을 마친 값이다(§10.3). 예약 슬롯은 덮어쓸 수 없다.
      for (const [k, v] of Object.entries(input.slots ?? {})) {
        if (!k.startsWith('__')) s.slots[k] = v;
      }
      s.failCount = 0;
      delete s.lastFallback;
      s.currentNodeId = node.next ?? null;
      advance(flow, s, ctx, steps, events);
      return { state: s, steps, events };
    }
    // 외부 장애는 고객 잘못이 아니다 — §5.1 실패 카운트를 올리지 않는다.
    s.slots['__last_connector_error__'] = input.errorCode ?? 'unknown';
    if (node.onError !== undefined && node.onError !== '') {
      s.currentNodeId = node.onError;
      advance(flow, s, ctx, steps, events);
      return { state: s, steps, events };
    }
    // 대체 분기가 없으면 §9.3에 따라 상담사로 내린다. 조회 실패로 콜을 끊지 않는다.
    s.handoff = { reason: 'error' };
    events.push(handoffRequested(meta(s, ctx), { reason: 'error' }));
    terminate(s, ctx, events, 'transferred', 'TRANSFERRED');
    return { state: s, steps, events };
  }
  // 커넥터 결과가 Api 노드 밖에서 도착하면 늦게 온 응답이다 — 무시한다(멱등, §8.1).
  if (input.kind === 'connectorResult') return { state: s, steps, events };

  // 고객 발화는 turnCompleted 내부에서 마스킹된다(§10.3).
  events.push(turnCompleted(meta(s, ctx), {
    turnId: `t_${++s.turnCount}`, speaker: 'customer', utterance: inputText(input), nodeId: node.id,
    ...(input.kind === 'utterance' && input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(s.failCount > 0 ? { retryCount: s.failCount } : {}),
    latency: inputLatency(input),
  }));

  const r = resolve(node, input, ctx);
  if (r.ok) {
    if (r.slot) s.slots[r.slot.key] = r.slot.value;
    s.failCount = 0;
    delete s.lastFallback;
    s.currentNodeId = r.next ?? null;
    advance(flow, s, ctx, steps, events);
    return { state: s, steps, events };
  }

  // 실패 — §5.1 폴백 사다리
  s.failCount += 1;
  const capped = node.kind === 'Collect' && node.maxRetry !== undefined && s.failCount > node.maxRetry;
  const action: FallbackAction = capped ? 'handoff_agent' : decideFallback(s.failCount, ctx.visualAvailable);
  s.lastFallback = action;

  if (action === 'handoff_agent') {
    s.handoff = { reason: 'max_retry' };
    events.push(handoffRequested(meta(s, ctx), { reason: 'max_retry' }));
    terminate(s, ctx, events, 'transferred', 'TRANSFERRED');
    return { state: s, steps, events };
  }
  if (action === 'switch_to_visual') s.channel = 'visual';   // §5.2 같은 Interaction 유지, 렌더러만 교체

  const retryStep = renderNode(node, s.channel);
  steps.push(retryStep);
  events.push(turnCompleted(meta(s, ctx), {
    turnId: `t_${++s.turnCount}`, speaker: 'bot', utterance: retryStep.text, nodeId: node.id, retryCount: s.failCount,
  }));
  return { state: s, steps, events };
}
