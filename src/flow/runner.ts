// FlowRunner — 설계서 §5.3(단일 시나리오)·§5.1(폴백)·§8.1(이벤트).
// 하나의 Flow를 채널 렌더러만 바꿔 실행한다. 순수 함수: 입력 state를 변형하지 않고 새 state를 돌려준다.
// 실엔진·실회선은 호출하지 않는다(입력은 상위 계층이 어댑터로부터 받아 전달).
import type { ChannelKind, Handoff, Outcome } from '../domain/types.ts';
import type { Flow, FlowNode, RenderedStep } from './types.ts';
import { INTENT_SLOT, KNOWLEDGE_SLOT, renderNode } from './types.ts';
import { decideFallback, type FallbackAction } from '../core/session.ts';
import { buildReprompt, classifyFailure, type FailureSignal, type RepromptPolicy, type RepromptReason } from './reprompt.ts';
import { resolveTurnTiming, type TurnTimingPolicy } from './timing.ts';
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
   * 고객은 말했지만 **무엇을 원하는지 확정하지 못했다**(§5.1). 분류는 Core 밖(엔진)과
   * `nlu/` 판정 모듈이 하고, Runner 는 그 결과만 받는다(§6.2).
   *
   * `utterance` 로 넣지 않는 이유: `Collect` 노드는 비어 있지 않은 텍스트를 **무조건 수락**한다.
   * 미인식 발화를 그대로 넣으면 "카드를 잃어버렸어요"가 슬롯 값으로 저장된 채 다음 노드로 넘어간다 —
   * 예외도 없고 재프롬프트도 없어, 고객은 엉뚱한 안내를 듣고 그 사실은 어디에도 남지 않는다.
   * 이 입력은 항상 실패로 판정되어 §5.1 사다리를 탄다(사다리 규칙은 여기서 다시 쓰지 않는다).
   */
  | { kind: 'unrecognized'; text: string; latency?: LatencyMs }
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
  /** 직전 입력이 실패한 원인(§5.1). 성공하면 지워진다 — 남겨두면 이관 요약이 지난 실패를 말한다. */
  lastFailureReason?: RepromptReason;
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
  /**
   * 재프롬프트 정책(§5.1). 주지 않으면 종전대로 노드 원문을 그대로 재생한다 —
   * Core 가 기본 문안을 지어내지 않기 때문이다(§13-3).
   */
  reprompt?: RepromptPolicy;
  /**
   * 턴 타이밍 정책(§5.1). 주지 않으면 어떤 대기 값도 실리지 않고 채널이 종전 값을 쓴다(§13-3).
   */
  timing?: TurnTimingPolicy;
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

/** 입력 대기 노드에만 타이밍 힌트를 찍는다. attempt 는 1부터 세며 첫 제시가 1 이다. */
function stampTiming(step: RenderedStep, s: FlowState, ctx: RunnerContext, attempt: number): void {
  const t = resolveTurnTiming(ctx.timing, { kind: step.kind, attempt, channel: s.channel });
  if (t.inputTimeoutMs !== undefined) step.inputTimeoutMs = t.inputTimeoutMs;
  if (t.bargeIn !== undefined) step.bargeIn = t.bargeIn;
}

function clone(s: FlowState): FlowState {
  return { ...s, slots: { ...s.slots }, visited: [...s.visited] };
}

function inputText(input: FlowInput): string {
  if (input.kind === 'utterance') return input.text.trim();
  if (input.kind === 'dtmf') return input.digits.trim();
  if (input.kind === 'unrecognized') return input.text.trim();
  return '';
}

function inputLatency(input: FlowInput): LatencyMs {
  return input.kind === 'timeout' || input.kind === 'connectorResult' ? {} : (input.latency ?? {});
}

/** 실패 원인 분류에 필요한 최소 신호만 뽑는다. connectorResult 는 이 경로에 오지 않는다(상위에서 처리). */
function failureSignal(input: FlowInput): FailureSignal {
  if (input.kind === 'utterance') {
    return input.confidence === undefined
      ? { kind: 'utterance', text: input.text }
      : { kind: 'utterance', text: input.text, confidence: input.confidence };
  }
  if (input.kind === 'dtmf') return { kind: 'dtmf', text: input.digits };
  // 미인식은 **신뢰도 문제가 아니다**(인식은 됐고 의미를 못 찾았다). confidence 를 지어내 넣으면
  // 원인이 low_confidence 로 뒤바뀌어 "잘 안 들립니다" 문안이 나간다 — 고객은 또박또박 다시 말한다.
  if (input.kind === 'unrecognized') return { kind: 'utterance', text: input.text };
  return { kind: 'timeout' };
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
    stampTiming(step, s, ctx, 1);
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

// ── 인텐트 진입 턴 (§5.1·§5.3) ───────────────────────────────────────────────
// 인텐트 판정은 Runner 밖에서 끝난다(엔진은 §6.2 어댑터 뒤, 판정은 `nlu/`). Runner 가 맡는 것은
// 그 결과를 **세션 상태와 §8.1 이벤트로 옮기는 일**뿐이다. 이 세 함수가 없으면 그 자리를
// 채널 런타임이 직접 채우게 되고, 그러면 turn 번호·eventSeq·종료 판정이 두 곳에서 만들어진다.

/** 인텐트 진입 턴의 고객 입력. 확정된 인텐트가 있으면 함께 싣는다(§4 Turn.intent). */
export interface IntentTurnInput {
  input: FlowInput;
  intent?: string;
  /**
   * 엔진이 준 **실측** 신뢰도만 싣는다(§13-3). 고객이 명확화 선택지에서 직접 고른 경우에는
   * 넣지 않는다 — 1.0 을 적으면 §7 품질 지표에 "확신도 만점" 구간이 생겨 실제 인식률을 가린다.
   */
  confidence?: number;
}

/**
 * 인텐트 진입 턴의 고객 발화 이벤트. **한 곳에서만 만든다** — 두 곳에서 만들면 한쪽이
 * `intent` 를 빠뜨리고, 그 차이는 예외가 아니라 §7 인텐트 분포 통계의 구멍으로만 나타난다.
 */
function intentCustomerTurn(s: FlowState, ctx: RunnerContext, events: InteractionEvent[], t: IntentTurnInput): void {
  const nodeId = s.currentNodeId;
  events.push(turnCompleted(meta(s, ctx), {
    turnId: `t_${++s.turnCount}`,
    speaker: 'customer',
    utterance: inputText(t.input),
    ...(nodeId !== null ? { nodeId } : {}),
    ...(t.intent !== undefined ? { intent: t.intent } : {}),
    ...(t.confidence !== undefined ? { confidence: t.confidence } : {}),
    latency: inputLatency(t.input),
  }));
}

/**
 * 같은 Interaction 안에서 **다른 시나리오로 갈아탄다**(§5.3).
 *
 * `start()` 를 다시 부르지 않는 이유가 이 함수의 존재 이유다 — `start()` 는 `session.started` 를
 * 만들고 슬롯을 비운다. 인텐트가 확정될 때마다 그것을 부르면 유입 통계가 통화 수보다 커지고
 * (§8.1 집계가 통째로 어긋난다), 이미 인증된 회원번호 같은 슬롯이 사라져 고객이 다시 답하게 된다.
 *
 * 실패 카운트·마지막 실패 원인은 초기화한다 — 새 시나리오의 첫 질문은 아직 실패한 적이 없다.
 * 확정된 인텐트는 예약 슬롯(`INTENT_SLOT`)에 남아 이관 요약·분석의 근거가 된다.
 */
export function switchFlow(
  flow: Flow, prev: FlowState, ctx: RunnerContext, entryNodeId: string, t: IntentTurnInput,
): RunResult {
  const s = clone(prev);
  const steps: RenderedStep[] = [];
  const events: InteractionEvent[] = [];
  if (s.status !== 'running') return { state: s, steps, events };

  // 발화는 **갈아타기 전** 시나리오에서 일어났다 — 이벤트의 flow_id 도 그쪽이어야 한다.
  intentCustomerTurn(s, ctx, events, t);
  s.flowId = flow.id;
  s.flowVersion = flow.version;
  s.currentNodeId = entryNodeId;
  s.visited = [];
  s.failCount = 0;
  delete s.lastFallback;
  delete s.lastFailureReason;
  delete s.pendingConnectorId;
  if (t.intent !== undefined) s.slots[INTENT_SLOT] = t.intent;
  advance(flow, s, ctx, steps, events);
  return { state: s, steps, events };
}

/**
 * 인텐트 판정 결과로 **곧바로 상담사에게 넘긴다**(§2). 시나리오를 타지 않는다.
 *
 * 큐를 정하지 않는다 — 목적지는 §9.3 라우팅·폴백이 정하고, 여기서 고르면 그 판정이 두 곳이 된다.
 */
export function handoffFromIntent(
  prev: FlowState, ctx: RunnerContext, reason: Handoff['reason'], t: IntentTurnInput,
): RunResult {
  const s = clone(prev);
  const steps: RenderedStep[] = [];
  const events: InteractionEvent[] = [];
  if (s.status !== 'running') return { state: s, steps, events };

  intentCustomerTurn(s, ctx, events, t);
  s.handoff = { reason };
  events.push(handoffRequested(meta(s, ctx), { reason }));
  terminate(s, ctx, events, 'transferred', 'TRANSFERRED');
  return { state: s, steps, events };
}

/**
 * 되묻는다(§5.1 명확화). **노드를 옮기지 않는다** — 고객의 다음 답도 같은 인텐트 진입 노드가 받는다.
 *
 * 실패 카운트를 올리지 않는 이유: 명확화는 실패가 아니라 설계된 되물음이다. 여기서 사다리를
 * 올리면 두 번 되묻는 것만으로 상담사로 떨어져, 테넌트가 정한 `maxClarifyAttempts` 가 무의미해진다.
 * 무한 되물음은 그 한도(`decideIntent`)가 막는다 — 한도 규칙을 여기서 다시 쓰지 않는다.
 */
export function clarifyTurn(
  prev: FlowState, ctx: RunnerContext, step: RenderedStep, t: IntentTurnInput,
): RunResult {
  const s = clone(prev);
  const steps: RenderedStep[] = [];
  const events: InteractionEvent[] = [];
  if (s.status !== 'running') return { state: s, steps, events };

  intentCustomerTurn(s, ctx, events, t);
  steps.push(step);
  events.push(turnCompleted(meta(s, ctx), {
    turnId: `t_${++s.turnCount}`, speaker: 'bot', utterance: step.text, nodeId: step.nodeId,
  }));
  return { state: s, steps, events };
}

// ── 지식 응대 턴 (§5.2·§5.3) ─────────────────────────────────────────────────
// 근거 검색·답변 생성·인용 검증은 Runner 밖에서 끝난다(엔진은 §6.2 어댑터 뒤, 판정은 `knowledge/`).
// Runner 가 맡는 것은 그 결과를 **세션 상태와 §8.1 이벤트로 옮기는 일**뿐이다.

/**
 * 지식 응대로 답한 턴을 세션에 반영한다(§5.2).
 *
 * `clarifyTurn` 과 달리 **노드를 옮긴다** — 되묻는 것이 아니라 답한 것이므로, 다음에 무엇을
 * 할지(추가 질문을 받을지·설문으로 넘길지)는 시나리오가 정한다. 그 판단을 Core 에 두면
 * "한 번 더 물어보시겠어요?"라는 문안과 반복 한도가 Core 에 생기고, 둘 다 테넌트 값이다(§13-3).
 *
 * `questionMasked` 만 받는 이유: 세션 슬롯은 이관 요약·분석으로 흘러가므로(§2) 원문 질문이
 * 들어가면 그 경로 전체가 마스킹 밖이 된다(§10.3). 마스킹은 검색 단계가 이미 했다 —
 * 여기서 다시 하면 `maskPii` 가 멱등이 아니라 치환된 토큰이 또 뭉개진다.
 *
 * 실패 카운트는 **성공처럼 초기화한다**. 답을 받은 고객은 실패한 적이 없고, 남겨 두면
 * 다음 턴의 첫 실패가 곧바로 사다리 두 칸째(화면 전환·이관)로 떨어진다.
 */
export function knowledgeTurn(
  flow: Flow, prev: FlowState, ctx: RunnerContext, step: RenderedStep,
  t: { input: FlowInput; questionMasked: string },
): RunResult {
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

  // 고객 발화는 turnCompleted 내부에서 마스킹된다(§10.3).
  events.push(turnCompleted(meta(s, ctx), {
    turnId: `t_${++s.turnCount}`, speaker: 'customer', utterance: inputText(t.input), nodeId: node.id,
    ...(s.failCount > 0 ? { retryCount: s.failCount } : {}),
    latency: inputLatency(t.input),
  }));

  s.slots[KNOWLEDGE_SLOT] = t.questionMasked;
  s.failCount = 0;
  delete s.lastFallback;
  delete s.lastFailureReason;

  steps.push(step);
  events.push(turnCompleted(meta(s, ctx), {
    turnId: `t_${++s.turnCount}`, speaker: 'bot', utterance: step.text, nodeId: step.nodeId,
  }));

  s.currentNodeId = node.next ?? null;
  advance(flow, s, ctx, steps, events);
  return { state: s, steps, events };
}

interface Resolution { ok: boolean; next?: string | null; slot?: { key: string; value: string } }

function resolve(node: FlowNode, input: FlowInput, ctx: RunnerContext): Resolution {
  const v = inputText(input);
  if (input.kind === 'timeout' || v === '' || !confidenceOk(input, ctx)) return { ok: false };
  // 미인식은 어떤 노드에서도 수락되지 않는다. Collect 가 비어 있지 않은 텍스트를 무조건 받는 탓에
  // 이 한 줄이 없으면 "무엇을 원하는지 모르겠다"가 슬롯 값으로 저장되고 흐름은 그대로 진행된다.
  if (input.kind === 'unrecognized') return { ok: false };

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
      delete s.lastFailureReason;
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
    delete s.lastFailureReason;
    s.currentNodeId = r.next ?? null;
    advance(flow, s, ctx, steps, events);
    return { state: s, steps, events };
  }

  // 실패 — §5.1 폴백 사다리
  s.failCount += 1;
  // 원인을 먼저 정한다. 무입력·저신뢰·불일치는 필요한 다음 말이 서로 다르다.
  const reason = classifyFailure(failureSignal(input), ctx.minConfidence);
  s.lastFailureReason = reason;
  // 이관 요약·후속 분석이 "왜 못 알아들었는가"를 알 수 있게 남긴다. 원인 코드일 뿐 개인정보가 아니다.
  s.slots['__last_failure_reason__'] = reason;
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
  // 채널 전환이 일어났으면 전환된 채널 기준으로 고른다 — 화면으로 넘어간 뒤 DTMF 안내를 내면 안 된다.
  const plan = buildReprompt(ctx.reprompt, reason, s.failCount, s.channel);
  if (plan) {
    retryStep.text = plan.text;
    if (plan.acceptDtmf) retryStep.acceptDtmf = true;
  }
  retryStep.reprompt = { reason, attempt: s.failCount, exhausted: plan?.exhausted ?? false };
  // 재시도는 첫 제시 다음이므로 회차가 하나 올라간다 — §5.1 의 "조금 더 기다린다"가 여기서 적용된다.
  stampTiming(retryStep, s, ctx, s.failCount + 1);
  steps.push(retryStep);
  events.push(turnCompleted(meta(s, ctx), {
    turnId: `t_${++s.turnCount}`, speaker: 'bot', utterance: retryStep.text, nodeId: node.id, retryCount: s.failCount,
  }));
  return { state: s, steps, events };
}
