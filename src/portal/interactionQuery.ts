// Interaction 이력 검색·필터 규약 — 설계서 §7 2.2.
// 관리 포털의 "상호작용 조회"는 편의 기능이 아니라 감사 대상 화면이다. 그래서 규약이 세 가지를 강제한다.
//  1) 기간 없는 조회를 허용하지 않는다. 전체 스캔은 성능 문제이자 개인정보 과다열람이다(§10).
//  2) 모든 질의는 테넌트 스코프에 묶인다(§11.1). 스코프 없는 질의 경로 자체를 만들지 않는다.
//  3) 키워드는 마스킹된 전문(transcript_masked)만 대상으로 한다(§10.3).
//     주민번호·카드번호로 사람을 찾는 검색은 규약 단계에서 막는다 — 저장소에 그 값이 없어야 정상이고,
//     그런 검색어가 들어온다는 것 자체가 사고 신호다.
import type { ChannelKind, Outcome, Handoff } from '../domain/types.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import { partitionKey } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';

export const CHANNEL_VALUES: readonly ChannelKind[] = ['voice', 'visual', 'chat'];
export const OUTCOME_VALUES: readonly Outcome[] = ['AUTO_RESOLVED', 'TRANSFERRED', 'ABANDONED', 'FAILED'];

export type SortField = 'started_at' | 'ended_at' | 'duration_ms';
export type SortOrder = 'asc' | 'desc';

/** 조회 기간. 반개구간 [from, to) — 경계 세션이 두 기간에 중복 집계되지 않게 한다. */
export interface Period {
  fromIso: string;
  toIso: string;
}

export interface InteractionQuery {
  scope: TenantScope;
  period: Period;
  channels?: ChannelKind[];
  intents?: string[];
  outcomes?: Outcome[];
  handoffReasons?: Handoff['reason'][];
  /** 마스킹 전문 대상 키워드(부분일치, 대소문자 무시) */
  keyword?: string;
  /** 이관 발생 여부로만 거르고 싶을 때 */
  hasHandoff?: boolean;
  sort?: { field: SortField; order: SortOrder };
  limit: number;
  /** 커서 기반 페이징(오프셋 페이징은 대용량에서 중복·누락이 난다) */
  cursor?: string;
}

/** 조회 결과 행 — 목록 화면이 필요로 하는 최소 필드. 전문·원문은 상세 화면에서 별도 권한으로 연다(§10.3). */
export interface InteractionSummary {
  id: string;
  tenantId: string;
  workspaceId?: string;
  startedAt: string;
  endedAt?: string;
  channels: ChannelKind[];
  outcome?: Outcome;
  intents: string[];
  handoffReason?: Handoff['reason'];
  /** 마스킹된 전문(검색 대상). 원문은 이 경로에 절대 오지 않는다(§10.3). */
  transcriptMasked: string;
  durationMs?: number;
}

export interface QueryIssue {
  field: string;
  messageKo: string;
}

export interface QueryLimits {
  /** 한 질의가 덮을 수 있는 최대 기간(일). 운영·법무가 정한 값만 넣는다(§13-3). */
  maxPeriodDays: number;
  /** 페이지 크기 상한 */
  maxLimit: number;
}

/**
 * 질의 검증. 통과하지 못한 질의는 저장소까지 내려보내지 않는다.
 * 던지지 않고 issue 목록을 돌려주는 이유: 포털이 필드별로 오류를 표시해야 하기 때문이다.
 */
export function validateQuery(q: InteractionQuery, limits: QueryLimits): QueryIssue[] {
  const issues: QueryIssue[] = [];

  try {
    assertTenantScope(q.scope);
  } catch (err) {
    issues.push({ field: 'scope', messageKo: err instanceof Error ? err.message : String(err) });
  }

  const from = Date.parse(q.period?.fromIso ?? '');
  const to = Date.parse(q.period?.toIso ?? '');
  if (Number.isNaN(from) || Number.isNaN(to)) {
    issues.push({ field: 'period', messageKo: '조회 기간(from·to)은 ISO8601 형식이어야 한다 (설계서 §7 2.2)' });
  } else {
    if (to <= from) issues.push({ field: 'period', messageKo: '조회 종료 시각은 시작 시각보다 뒤여야 한다' });
    const days = (to - from) / 86_400_000;
    if (days > limits.maxPeriodDays) {
      issues.push({
        field: 'period',
        messageKo: `조회 기간이 허용 범위(${limits.maxPeriodDays}일)를 넘는다 — 기간을 나눠 조회한다 (설계서 §10)`,
      });
    }
  }

  if (!Number.isInteger(q.limit) || q.limit <= 0) {
    issues.push({ field: 'limit', messageKo: 'limit은 1 이상의 정수여야 한다' });
  } else if (q.limit > limits.maxLimit) {
    issues.push({ field: 'limit', messageKo: `limit은 ${limits.maxLimit} 이하여야 한다` });
  }

  for (const c of q.channels ?? []) {
    if (!CHANNEL_VALUES.includes(c)) issues.push({ field: 'channels', messageKo: `알 수 없는 채널: ${c}` });
  }
  for (const o of q.outcomes ?? []) {
    if (!OUTCOME_VALUES.includes(o)) issues.push({ field: 'outcomes', messageKo: `알 수 없는 결과: ${o}` });
  }

  if (q.keyword !== undefined) {
    const k = q.keyword.trim();
    if (k.length === 0) {
      issues.push({ field: 'keyword', messageKo: '키워드가 비어 있다' });
    } else if (maskPii(k).masked) {
      // 개인정보 값 자체로 검색하는 행위를 규약 단계에서 차단한다.
      issues.push({
        field: 'keyword',
        messageKo: '개인정보(주민등록번호·카드·계좌·연락처) 패턴은 검색어로 사용할 수 없다 (설계서 §10.3)',
      });
    }
  }

  return issues;
}

/** 정규화 — 중복 제거·공백 정리·정렬 기본값 확정. 검증을 통과한 질의에만 적용한다. */
export function normalizeQuery(q: InteractionQuery): Required<Pick<InteractionQuery, 'sort' | 'limit' | 'scope' | 'period'>> & InteractionQuery {
  const uniq = <T,>(a?: T[]) => (a && a.length > 0 ? [...new Set(a)] : undefined);
  return {
    ...q,
    channels: uniq(q.channels),
    outcomes: uniq(q.outcomes),
    intents: uniq(q.intents?.map((s) => s.trim()).filter((s) => s.length > 0)),
    handoffReasons: uniq(q.handoffReasons),
    ...(q.keyword !== undefined ? { keyword: q.keyword.trim() } : {}),
    sort: q.sort ?? { field: 'started_at', order: 'desc' },
  };
}

/**
 * 저장소에 내려보낼 필터 표현. 어떤 DB인지는 이 모듈이 알지 않는다(§6.2) —
 * 파티션 키와 조건 목록만 넘기고, 어댑터가 각자의 방언으로 옮긴다.
 */
export interface StorageFilter {
  partition: string;
  conditions: { field: string; op: 'eq' | 'in' | 'gte' | 'lt' | 'contains' | 'exists'; value: unknown }[];
  sort: { field: SortField; order: SortOrder };
  limit: number;
  cursor?: string;
}

export function toStorageFilter(q: InteractionQuery): StorageFilter {
  assertTenantScope(q.scope);
  const n = normalizeQuery(q);
  const conditions: StorageFilter['conditions'] = [
    { field: 'started_at', op: 'gte', value: n.period.fromIso },
    { field: 'started_at', op: 'lt', value: n.period.toIso },
  ];
  if (n.channels) conditions.push({ field: 'channels', op: 'in', value: n.channels });
  if (n.outcomes) conditions.push({ field: 'outcome', op: 'in', value: n.outcomes });
  if (n.intents) conditions.push({ field: 'intents', op: 'in', value: n.intents });
  if (n.handoffReasons) conditions.push({ field: 'handoff_reason', op: 'in', value: n.handoffReasons });
  if (n.hasHandoff !== undefined) conditions.push({ field: 'handoff_reason', op: 'exists', value: n.hasHandoff });
  if (n.keyword) conditions.push({ field: 'transcript_masked', op: 'contains', value: n.keyword });
  return {
    partition: partitionKey(n.scope),
    conditions,
    sort: n.sort,
    limit: n.limit,
    ...(n.cursor !== undefined ? { cursor: n.cursor } : {}),
  };
}

/** 단건 판정(순수 함수). 인메모리·sim 저장소와 저장소 어댑터의 자체 검증에 함께 쓴다. */
export function matchesQuery(s: InteractionSummary, q: InteractionQuery): boolean {
  if (s.tenantId !== q.scope.tenantId) return false;                       // §11.1
  if (q.scope.workspaceId !== undefined && s.workspaceId !== q.scope.workspaceId) return false;

  const started = Date.parse(s.startedAt);
  const from = Date.parse(q.period.fromIso);
  const to = Date.parse(q.period.toIso);
  if (Number.isNaN(started) || started < from || started >= to) return false;

  if (q.channels?.length && !s.channels.some((c) => q.channels!.includes(c))) return false;
  if (q.outcomes?.length && (s.outcome === undefined || !q.outcomes.includes(s.outcome))) return false;
  if (q.intents?.length && !s.intents.some((i) => q.intents!.includes(i))) return false;
  if (q.handoffReasons?.length && (s.handoffReason === undefined || !q.handoffReasons.includes(s.handoffReason))) return false;
  if (q.hasHandoff !== undefined && (s.handoffReason !== undefined) !== q.hasHandoff) return false;

  if (q.keyword) {
    const k = q.keyword.trim().toLowerCase();
    if (k && !s.transcriptMasked.toLowerCase().includes(k)) return false;
  }
  return true;
}

export interface QueryPage {
  rows: InteractionSummary[];
  nextCursor?: string;
  /** 스코프 위반으로 걸러낸 행 수 — 0이 아니면 저장소 어댑터 버그다(§11.1 방어적 재검증). */
  scopeViolationsDropped: number;
}

function sortValue(s: InteractionSummary, f: SortField): number {
  if (f === 'duration_ms') return s.durationMs ?? -1;
  const v = f === 'started_at' ? s.startedAt : s.endedAt;
  const t = Date.parse(v ?? '');
  return Number.isNaN(t) ? -1 : t;
}

/**
 * 인메모리 실행기. 커서는 정렬 기준으로 마지막에 내보낸 행의 id다 — 오프셋이 아니라 위치 기준이라
 * 그 사이에 새 세션이 들어와도 중복·누락이 생기지 않는다.
 */
export function runQuery(rows: InteractionSummary[], q: InteractionQuery): QueryPage {
  const n = normalizeQuery(q);
  const scoped = rows.filter((r) => r.tenantId === n.scope.tenantId);
  const scopeViolationsDropped = rows.length - scoped.length;

  const matched = scoped.filter((r) => matchesQuery(r, n));
  const dir = n.sort.order === 'asc' ? 1 : -1;
  matched.sort((a, b) => {
    const d = (sortValue(a, n.sort.field) - sortValue(b, n.sort.field)) * dir;
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });

  let start = 0;
  if (n.cursor) {
    const idx = matched.findIndex((r) => r.id === n.cursor);
    start = idx >= 0 ? idx + 1 : matched.length;
  }
  const page = matched.slice(start, start + n.limit);
  const hasMore = start + n.limit < matched.length;
  return {
    rows: page,
    ...(hasMore && page.length > 0 ? { nextCursor: page[page.length - 1]!.id } : {}),
    scopeViolationsDropped,
  };
}

/**
 * 조회 감사 기록(§10). 누가·어떤 조건으로·몇 건을 봤는지 남긴다.
 * 검색어는 그대로 남기지 않고 마스킹을 한 번 더 통과시킨다 — 감사로그가 개인정보 저장소가 되면 안 된다.
 */
export interface QueryAuditEntry {
  tenantId: string;
  workspaceId?: string;
  actorId: string;
  atIso: string;
  periodFrom: string;
  periodTo: string;
  filtersSummary: string;
  keywordMasked?: string;
  resultCount: number;
}

export function buildQueryAudit(
  q: InteractionQuery,
  ctx: { actorId: string; atIso: string; resultCount: number },
): QueryAuditEntry {
  const n = normalizeQuery(q);
  const parts: string[] = [];
  if (n.channels) parts.push(`channels=${n.channels.join('|')}`);
  if (n.outcomes) parts.push(`outcomes=${n.outcomes.join('|')}`);
  if (n.intents) parts.push(`intents=${n.intents.join('|')}`);
  if (n.handoffReasons) parts.push(`handoff=${n.handoffReasons.join('|')}`);
  if (n.hasHandoff !== undefined) parts.push(`hasHandoff=${n.hasHandoff}`);
  if (n.keyword) parts.push('keyword=Y');
  return {
    tenantId: n.scope.tenantId,
    ...(n.scope.workspaceId !== undefined ? { workspaceId: n.scope.workspaceId } : {}),
    actorId: ctx.actorId,
    atIso: ctx.atIso,
    periodFrom: n.period.fromIso,
    periodTo: n.period.toIso,
    filtersSummary: parts.join(' '),
    ...(n.keyword ? { keywordMasked: maskPii(n.keyword).text } : {}),
    resultCount: ctx.resultCount,
  };
}
