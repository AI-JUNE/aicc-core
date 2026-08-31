// 상담사 이관 라우팅·큐 규약 — 설계서 §2(핸드오프 단절 해소)·§9.3(장애 폴백)·§11.1(테넌트 격리)·§7 7.4(운영).
//
// handoffSummary(§2)가 "무엇을 넘길지"를 정한다면, 이 모듈은 "어디로, 넘길 수 있는지"를 정한다.
// 두 질문이 붙어 있으면 이관이 실패했을 때 무엇이 문제인지 알 수 없다 — 요약이 없었는지,
// 큐가 닫혔는지, 상담사가 안 받았는지. 그래서 라우팅은 세 단계로 쪼갠다.
//   (1) selectQueue  — 규칙으로 목적지 큐를 고른다 (결정적, 순수)
//   (2) admitToQueue — 그 큐가 지금 받을 수 있는지 판정한다 (운영시간·실측 스냅샷)
//   (3) 오퍼 상태기계 — 배정 제안의 수락/거절/타임아웃 전이
//
// 대기시간 "예상치"를 만들지 않는다(§13-3). 예상 대기 안내는 실측 통계가 쌓인 뒤 §8.1 이벤트에서
// 도출할 문제이고, 여기서 지어낸 숫자를 고객에게 읽어주면 그게 곧 클레임이 된다.
import type { ChannelKind, Handoff } from '../domain/types.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';

export const ROUTING_CONTRACT_VERSION = 1;

/** 요일 0=일 … 6=토. Date.getUTCDay()와 같은 규약. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** "HH:MM" 24시간. 종료는 열린 구간(close 시각은 영업 종료). */
export interface TimeWindow {
  open: string;
  close: string;
}

/**
 * 운영시간. IANA 타임존 DB에 의존하지 않고 고정 오프셋으로 판정한다 —
 * Core가 런타임 tz 데이터에 종속되면 온프렘 배포에서 판정이 갈린다(§6.2).
 * 서머타임을 쓰는 테넌트는 오프셋 변경을 운영 설정 변경으로 처리한다.
 */
export interface BusinessHours {
  utcOffsetMinutes: number;
  /** 요일별 영업 구간. 비어 있거나 없으면 그 요일은 휴무. */
  weekly: Partial<Record<Weekday, readonly TimeWindow[]>>;
  /** 휴무일 "YYYY-MM-DD" (오프셋 적용 후 현지 날짜 기준) */
  holidays?: readonly string[];
}

/** 큐가 닫혔거나 수용 불가일 때의 대안. 조용히 끊는 선택지는 두지 않는다(§9.3). */
export type ClosedAction = 'callback' | 'voicemail' | 'legacy_ivr' | 'reject';

export interface AgentQueue {
  id: string;
  tenantId: string;
  workspaceId?: string;
  titleKo: string;
  /** 이 큐가 처리 가능한 스킬 태그. 규칙이 스킬로 큐를 고를 때 쓴다. */
  skills: readonly string[];
  /** 이 큐가 받을 수 있는 채널. 비어 있으면 전 채널. */
  channels?: readonly ChannelKind[];
  hours?: BusinessHours;
  /** 동시에 대기시킬 수 있는 최대 인원. 운영 설정값이며 목표 지표가 아니다(§13-3). */
  maxWaiting?: number;
  /** 초과 시 넘길 큐. 순환 참조는 validateRoutingConfig가 잡는다. */
  overflowQueueId?: string;
  closedAction: ClosedAction;
}

/** 라우팅 규칙. 조건은 전부 AND, 지정하지 않은 조건은 무시된다. */
export interface RoutingRule {
  id: string;
  /** 큰 값이 먼저 평가된다. 동점이면 배열 정의 순서 — 판정은 항상 결정적이어야 한다. */
  priority: number;
  when: {
    intents?: readonly string[];
    channels?: readonly ChannelKind[];
    reasons?: readonly Handoff['reason'][];
    /** 수집된 슬롯이 이 값과 정확히 일치할 때만 (예: grade=vip) */
    slotEquals?: Readonly<Record<string, string>>;
    language?: readonly string[];
  };
  toQueue: string;
}

export interface RoutingConfig {
  tenantId: string;
  workspaceId?: string;
  queues: readonly AgentQueue[];
  rules: readonly RoutingRule[];
  /** 어떤 규칙에도 걸리지 않을 때의 큐. 없으면 설정 오류다 — 갈 곳 없는 이관을 만들지 않는다. */
  defaultQueueId: string;
}

/** 설정 검증. 배포 전에 잡지 못하면 장애 시각에 "갈 곳 없는 이관"으로 터진다. */
export function validateRoutingConfig(cfg: RoutingConfig): string[] {
  const errors: string[] = [];
  const byId = new Map<string, AgentQueue>();

  for (const q of cfg.queues) {
    if (byId.has(q.id)) errors.push(`큐 ID 중복: ${q.id}`);
    byId.set(q.id, q);
    if (q.tenantId !== cfg.tenantId) {
      errors.push(`큐 ${q.id}의 tenant_id가 설정과 다르다 (설계서 §11.1)`);
    }
    if ((q.workspaceId ?? undefined) !== (cfg.workspaceId ?? undefined)) {
      errors.push(`큐 ${q.id}의 workspace_id가 설정과 다르다 (설계서 §11.1)`);
    }
    if (q.maxWaiting !== undefined && (!Number.isInteger(q.maxWaiting) || q.maxWaiting < 0)) {
      errors.push(`큐 ${q.id}의 maxWaiting은 0 이상의 정수여야 한다`);
    }
    if (q.hours) errors.push(...validateBusinessHours(q.id, q.hours));
  }

  if (!byId.has(cfg.defaultQueueId)) {
    errors.push(`기본 큐가 정의되지 않았다: ${cfg.defaultQueueId} — 갈 곳 없는 이관을 만들 수 없다 (설계서 §2)`);
  }

  const ruleIds = new Set<string>();
  for (const r of cfg.rules) {
    if (ruleIds.has(r.id)) errors.push(`규칙 ID 중복: ${r.id}`);
    ruleIds.add(r.id);
    if (!byId.has(r.toQueue)) errors.push(`규칙 ${r.id}이 정의되지 않은 큐를 가리킨다: ${r.toQueue}`);
    if (!Number.isFinite(r.priority)) errors.push(`규칙 ${r.id}의 priority가 숫자가 아니다`);
    const w = r.when;
    if (!w.intents?.length && !w.channels?.length && !w.reasons?.length && !w.language?.length &&
        !(w.slotEquals && Object.keys(w.slotEquals).length)) {
      errors.push(`규칙 ${r.id}에 조건이 없다 — 무조건 매칭은 defaultQueueId로 표현한다`);
    }
  }

  // 오버플로 순환 — 장애 시각에 무한 루프로 도는 경로를 배포 전에 끊는다.
  for (const q of cfg.queues) {
    const seen = new Set<string>([q.id]);
    let cur = q.overflowQueueId;
    while (cur) {
      const next = byId.get(cur);
      if (!next) { errors.push(`큐 ${q.id}의 overflowQueueId가 정의되지 않았다: ${cur}`); break; }
      if (seen.has(cur)) { errors.push(`오버플로 순환: ${[...seen, cur].join(' → ')}`); break; }
      seen.add(cur);
      cur = next.overflowQueueId;
    }
  }
  return errors;
}

const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function validateBusinessHours(label: string, h: BusinessHours): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(h.utcOffsetMinutes) || Math.abs(h.utcOffsetMinutes) > 14 * 60) {
    errors.push(`${label}: utcOffsetMinutes 범위 오류(${h.utcOffsetMinutes})`);
  }
  for (const [day, windows] of Object.entries(h.weekly)) {
    for (const w of windows ?? []) {
      if (!HHMM_RE.test(w.open) || !HHMM_RE.test(w.close)) {
        errors.push(`${label}: 요일 ${day} 시각 형식 오류(${w.open}~${w.close})`);
        continue;
      }
      if (toMinutes(w.open) >= toMinutes(w.close)) {
        errors.push(`${label}: 요일 ${day} 구간이 뒤집혔다(${w.open}~${w.close}) — 자정 넘김은 두 구간으로 나눠 적는다`);
      }
    }
  }
  for (const d of h.holidays ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.push(`${label}: 휴무일 형식 오류(${d})`);
  }
  return errors;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export interface LocalClock {
  /** 오프셋 적용 후 현지 날짜 "YYYY-MM-DD" */
  date: string;
  weekday: Weekday;
  minutes: number;
}

/** UTC 시각을 큐 오프셋 기준 현지 시각으로 환산한다. */
export function localClock(nowIso: string, utcOffsetMinutes: number): LocalClock {
  const ms = Date.parse(nowIso);
  if (Number.isNaN(ms)) throw new Error(`시각 형식 오류: ${JSON.stringify(nowIso)}`);
  const d = new Date(ms + utcOffsetMinutes * 60_000);
  const date = d.toISOString().slice(0, 10);
  return {
    date,
    weekday: d.getUTCDay() as Weekday,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** 운영시간 판정. hours가 없으면 24시간 운영으로 본다(무인 채널 기본). */
export function isOpen(hours: BusinessHours | undefined, nowIso: string): boolean {
  if (!hours) return true;
  const c = localClock(nowIso, hours.utcOffsetMinutes);
  if (hours.holidays?.includes(c.date)) return false;
  const windows = hours.weekly[c.weekday] ?? [];
  return windows.some((w) => c.minutes >= toMinutes(w.open) && c.minutes < toMinutes(w.close));
}

export interface RouteContext {
  scope: TenantScope;
  channel: ChannelKind;
  reason: Handoff['reason'];
  intent?: string;
  language?: string;
  slots?: Readonly<Record<string, string>>;
}

export interface RouteSelection {
  queue: AgentQueue;
  /** 어떤 규칙이 골랐는지. 기본 큐로 떨어졌으면 undefined. */
  matchedRuleId?: string;
  reasonKo: string;
}

function ruleMatches(rule: RoutingRule, ctx: RouteContext): boolean {
  const w = rule.when;
  if (w.channels?.length && !w.channels.includes(ctx.channel)) return false;
  if (w.reasons?.length && !w.reasons.includes(ctx.reason)) return false;
  if (w.intents?.length && (ctx.intent === undefined || !w.intents.includes(ctx.intent))) return false;
  if (w.language?.length && (ctx.language === undefined || !w.language.includes(ctx.language))) return false;
  if (w.slotEquals) {
    for (const [k, v] of Object.entries(w.slotEquals)) {
      if ((ctx.slots ?? {})[k] !== v) return false;
    }
  }
  return true;
}

/**
 * 목적지 큐 선택. 우선순위 내림차순 → 정의 순서로 첫 매칭을 쓴다.
 * 채널을 받지 않는 큐로 보내는 규칙은 무시하고 다음 후보로 넘어간다 —
 * 규칙이 잘못돼도 이관 자체가 실패하지는 않게 한다.
 */
export function selectQueue(cfg: RoutingConfig, ctx: RouteContext): RouteSelection {
  assertTenantScope(ctx.scope);
  if (cfg.tenantId !== ctx.scope.tenantId) {
    throw new Error('다른 테넌트의 라우팅 설정으로 큐를 고를 수 없다 (설계서 §11.1)');
  }
  const byId = new Map(cfg.queues.map((q) => [q.id, q] as const));
  const ordered = cfg.rules.map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.priority - a.r.priority) || (a.i - b.i));

  for (const { r } of ordered) {
    if (!ruleMatches(r, ctx)) continue;
    const q = byId.get(r.toQueue);
    if (!q) continue;
    if (q.channels?.length && !q.channels.includes(ctx.channel)) continue;
    return { queue: q, matchedRuleId: r.id, reasonKo: `규칙 ${r.id} 매칭` };
  }

  const fallback = byId.get(cfg.defaultQueueId);
  if (!fallback) {
    throw new Error(`기본 큐를 찾을 수 없다: ${cfg.defaultQueueId} (설계서 §2)`);
  }
  return { queue: fallback, reasonKo: '매칭 규칙 없음 — 기본 큐' };
}

/** 큐의 현재 상태. 실측값만 담는다 — 예측·평균 대기시간은 넣지 않는다(§13-3). */
export interface QueueSnapshot {
  queueId: string;
  waiting: number;
  /** 지금 배정 가능한 상담사 수 */
  availableAgents: number;
  /** 로그인했지만 통화 중인 인원 포함 여부는 채널이 정한다 — 이 값은 참고용 */
  loggedInAgents?: number;
  observedAt: string;
}

export type AdmissionStatus = 'accepted' | 'overflow' | 'closed' | 'rejected';

export interface AdmissionDecision {
  status: AdmissionStatus;
  queueId: string;
  /** overflow 시 실제로 들어간 큐 */
  admittedQueueId?: string;
  /** accepted가 아닐 때 고객에게 제시할 대안 */
  action?: ClosedAction;
  reasonKo: string;
  /** 판정 경로. 오버플로 연쇄를 사후 추적하려면 이게 필요하다. */
  path: string[];
}

export interface AdmissionOptions {
  /** 상담사가 0명이어도 대기열에 넣을지. 운영 정책값. */
  admitWithNoAgents?: boolean;
  /** 스냅샷이 이보다 오래되면 신뢰하지 않고 닫힘으로 본다(ms). */
  staleAfterMs?: number;
}

/**
 * 수용 판정. 오버플로를 따라가되 순환·과도한 연쇄는 끊는다.
 * 어떤 경우에도 status만 던지지 않고 action(대안)을 함께 낸다 — §9.3.
 */
export function admitToQueue(
  cfg: RoutingConfig,
  queueId: string,
  snapshots: readonly QueueSnapshot[],
  nowIso: string,
  opts: AdmissionOptions = {},
): AdmissionDecision {
  const byId = new Map(cfg.queues.map((q) => [q.id, q] as const));
  const snapById = new Map(snapshots.map((s) => [s.queueId, s] as const));
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) throw new Error(`시각 형식 오류: ${JSON.stringify(nowIso)}`);

  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = queueId;

  while (cur) {
    const q: AgentQueue | undefined = byId.get(cur);
    if (!q) {
      return { status: 'rejected', queueId, action: 'reject', reasonKo: `정의되지 않은 큐: ${cur}`, path };
    }
    if (seen.has(cur)) {
      return { status: 'rejected', queueId, action: q.closedAction, reasonKo: `오버플로 순환 감지: ${cur}`, path };
    }
    seen.add(cur);
    path.push(cur);

    if (!isOpen(q.hours, nowIso)) {
      return { status: 'closed', queueId, action: q.closedAction, reasonKo: `${q.titleKo} 운영시간 외`, path };
    }

    const snap = snapById.get(cur);
    if (!snap) {
      return { status: 'closed', queueId, action: q.closedAction, reasonKo: `${q.titleKo} 상태 미확인 — 추정하지 않는다`, path };
    }
    const age = nowMs - Date.parse(snap.observedAt);
    if (Number.isNaN(age) || (opts.staleAfterMs !== undefined && age > opts.staleAfterMs)) {
      return { status: 'closed', queueId, action: q.closedAction, reasonKo: `${q.titleKo} 상태 정보가 오래되었다`, path };
    }

    const full = q.maxWaiting !== undefined && snap.waiting >= q.maxWaiting;
    const noAgents = snap.availableAgents <= 0 && !opts.admitWithNoAgents;

    if (!full && !noAgents) {
      const decision: AdmissionDecision = {
        status: path.length > 1 ? 'overflow' : 'accepted',
        queueId,
        admittedQueueId: cur,
        reasonKo: path.length > 1 ? `${q.titleKo}로 오버플로 수용` : `${q.titleKo} 수용`,
        path,
      };
      return decision;
    }

    const why = full ? '대기 한도 초과' : '배정 가능 상담사 없음';
    if (q.overflowQueueId) {
      cur = q.overflowQueueId;
      continue;
    }
    return { status: 'closed', queueId, action: q.closedAction, reasonKo: `${q.titleKo} ${why}`, path };
  }

  return { status: 'rejected', queueId, action: 'reject', reasonKo: '수용 가능한 큐 없음', path };
}

/** 배정 제안 상태. 상담사가 안 받는 경우가 실제로 제일 흔하다. */
export type OfferState = 'offered' | 'accepted' | 'declined' | 'timed_out' | 'cancelled';

export interface AssignmentOffer {
  offerId: string;
  queueId: string;
  interactionId: string;
  tenantId: string;
  agentId: string;
  offeredAt: string;
  /** 응답 대기 한도(ms). 운영값. */
  timeoutMs: number;
  state: OfferState;
  /** 이 상호작용이 오퍼를 받은 횟수 — 무한 재배정 방지 */
  attempt: number;
}

export interface OfferParams {
  scope: TenantScope;
  offerId: string;
  queueId: string;
  interactionId: string;
  agentId: string;
  offeredAt: string;
  timeoutMs: number;
  attempt: number;
}

export function offerAssignment(p: OfferParams): AssignmentOffer {
  assertTenantScope(p.scope);
  if (!Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) {
    throw new Error(`오퍼 응답 한도(timeoutMs)는 양수여야 한다: ${String(p.timeoutMs)}`);
  }
  if (!Number.isInteger(p.attempt) || p.attempt < 1) {
    throw new Error(`attempt는 1 이상의 정수여야 한다: ${String(p.attempt)}`);
  }
  return {
    offerId: p.offerId,
    queueId: p.queueId,
    interactionId: p.interactionId,
    tenantId: p.scope.tenantId,
    agentId: p.agentId,
    offeredAt: p.offeredAt,
    timeoutMs: p.timeoutMs,
    state: 'offered',
    attempt: p.attempt,
  };
}

export type OfferEvent = 'accept' | 'decline' | 'cancel' | 'tick';

export type OfferNext = 'assigned' | 'requeue' | 'exhausted' | 'waiting' | 'cancelled';

export interface OfferOutcome {
  offer: AssignmentOffer;
  next: OfferNext;
  reasonKo: string;
}

/**
 * 오퍼 전이. 거절·타임아웃은 재배정(requeue)이지만, 재시도 한도를 넘으면 exhausted다.
 * exhausted는 §9.3 대안(콜백·음성사서함·기존 IVR)으로 넘겨야 한다는 신호이지,
 * 세션을 끊으라는 뜻이 아니다.
 */
export function applyOfferEvent(
  offer: AssignmentOffer,
  event: OfferEvent,
  nowIso: string,
  maxAttempts: number,
): OfferOutcome {
  if (offer.state !== 'offered') {
    return { offer, next: 'waiting', reasonKo: `이미 종결된 오퍼: ${offer.state}` };
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts는 1 이상의 정수여야 한다: ${String(maxAttempts)}`);
  }

  const nowMs = Date.parse(nowIso);
  const offeredMs = Date.parse(offer.offeredAt);
  if (Number.isNaN(nowMs) || Number.isNaN(offeredMs)) {
    throw new Error('오퍼 시각 형식 오류');
  }
  const expired = nowMs - offeredMs >= offer.timeoutMs;
  const exhausted = offer.attempt >= maxAttempts;

  if (event === 'cancel') {
    return { offer: { ...offer, state: 'cancelled' }, next: 'cancelled', reasonKo: '고객 이탈 등으로 오퍼 취소' };
  }
  if (event === 'accept') {
    // 만료된 오퍼의 뒤늦은 수락은 받지 않는다 — 두 상담사가 같은 콜을 잡는 경합을 막는다.
    if (expired) {
      return { offer: { ...offer, state: 'timed_out' }, next: exhausted ? 'exhausted' : 'requeue', reasonKo: '응답 한도 초과 후 수락 — 무효' };
    }
    return { offer: { ...offer, state: 'accepted' }, next: 'assigned', reasonKo: '상담사 수락' };
  }
  if (event === 'decline') {
    return {
      offer: { ...offer, state: 'declined' },
      next: exhausted ? 'exhausted' : 'requeue',
      reasonKo: exhausted ? '거절 — 재배정 한도 소진' : '상담사 거절 — 재배정',
    };
  }
  // tick
  if (!expired) return { offer, next: 'waiting', reasonKo: '응답 대기 중' };
  return {
    offer: { ...offer, state: 'timed_out' },
    next: exhausted ? 'exhausted' : 'requeue',
    reasonKo: exhausted ? '응답 없음 — 재배정 한도 소진' : '응답 없음 — 재배정',
  };
}

/** exhausted 이후 무엇을 할지. 큐 설정의 closedAction을 그대로 쓴다 — 여기서 새 정책을 만들지 않는다. */
export function exhaustedAction(cfg: RoutingConfig, queueId: string): ClosedAction {
  const q = cfg.queues.find((x) => x.id === queueId);
  return q?.closedAction ?? 'reject';
}
