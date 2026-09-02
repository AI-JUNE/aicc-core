// 관리 기능 접근 이력 — 설계서 §10.2(접근·변경 기록)·§10.3(PII 열람)·§11.1(테넌트 격리)·§7(포털 IA).
//
// 왜 이 파일이 필요한가:
// audit/log.ts 는 "레코드를 어떻게 위·변조 없이 쌓는가"를 푼다. 하지만 상용에서 실제로 필요한 것은
// "관리 화면에 누가 들어갔고, 무엇이 거부됐는가"를 **빠짐없이** 남기는 규칙이다.
// 그 규칙을 화면마다 손으로 짜면 반드시 빠지는 곳이 생기고, 사고 조사 때 하필 그 화면이 비어 있다.
// 그래서 접근 판정과 기록을 한 함수로 묶는다: 권한 검사 → 결과 확정 → 기록 여부 판정 → 체인 추가.
//
// 원칙:
//  1) **거부는 항상 남긴다.** 권한 없는 접근 시도야말로 조사에서 가장 먼저 보는 자료다.
//     라우트가 감사 대상이 아니어도(단순 조회 화면이어도) 거부·테넌트 위반은 예외 없이 기록한다.
//  2) 성공은 감사 대상 화면(PII 열람·상태 변경)만 남긴다. 모든 조회를 남기면 잡음에 묻혀 아무도 안 본다.
//  3) 다른 테넌트 자원 접근 시도는 '없는 것처럼' 처리하되(§11.1), **기록은 남긴다**.
//  4) 대량 반출은 별도 표시한다. 유출 사고의 대부분은 정상 권한자의 대량 내보내기다.
//  5) detail 은 audit/log.ts 를 통해 maskPii 를 지나간다. 여기서 원문을 넣는 경로를 만들지 않는다(§10.3).
import {
  appendAudit, defaultActionFor, shouldAudit,
  type AuditAction, type AuditChain, type AuditRecord, type AuditResult, type Hasher,
} from './log.ts';
import { canAccess, routeById, type PortalRole, type PortalRoute } from '../portal/ia.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';

export interface AccessActor {
  userId: string;
  roles: PortalRole[];
  /** 이 사용자가 속한 테넌트. 요청 scope 와 다르면 격리 위반이다(§11.1). */
  tenantId: string;
  ip?: string;
}

/** 왜 거부됐는가. 화면 안내와 조사 양쪽에 쓰인다. */
export type DenyReason = 'unknown_route' | 'tenant_mismatch' | 'role' | 'blocked';

export interface AccessRequest {
  scope: TenantScope;
  actor: AccessActor;
  /** PORTAL_ROUTES 의 라우트 id(§7). */
  routeId: string;
  at: string;                 // ISO8601 — 주입(순수 함수 유지)
  recordId: string;           // 레코드 식별자 — 생성기는 호스트가 가진다
  /** 라우트 기본 액션을 덮어쓸 때만 지정한다(예: 목록 화면에서의 export). */
  action?: AuditAction;
  targetType?: string;
  targetId?: string;
  /** 내보내기·대량 조회 건수. 임계값을 넘으면 detail 에 표시된다. */
  affectedCount?: number;
  /** 사유·변경 요약. 저장 시 마스킹된다. */
  detail?: string;
  /** 권한 외의 사유로 이미 막힌 접근(계정 정지 등)을 그대로 기록할 때. */
  blocked?: boolean;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: DenyReason;
  /** 사용자에게 보일 한 줄. 권한 유무를 넘어선 정보를 흘리지 않는다. */
  messageKo?: string;
  route?: PortalRoute;
}

export interface AccessOutcome {
  decision: AccessDecision;
  /** 새 체인(원본 불변). 기록하지 않은 경우 입력 체인이 그대로 돌아온다. */
  chain: AuditChain;
  recorded: boolean;
  record?: AuditRecord;
}

/** 대량 반출 판단 기준. 조직마다 다르므로 호출자가 넣는다 — 기본값을 코드에 박지 않는다(§13-3). */
export interface AccessLogOptions {
  bulkExportThreshold?: number;
  /** 성공 접근도 전부 남길 것인가. 감사 대응 기간 등 한시적으로 켠다. */
  recordAllReads?: boolean;
}

/**
 * 접근 판정. 기록과 분리해 둔다 — 화면은 판정만 필요하고, 기록은 실제 접근이 일어날 때만 해야 한다.
 * 테넌트 불일치를 역할 검사보다 **먼저** 본다. 권한이 있어도 남의 테넌트는 볼 수 없다(§11.1).
 */
export function decideAccess(req: AccessRequest): AccessDecision {
  assertTenantScope(req.scope);
  const route = routeById(req.routeId);
  if (!route) {
    return { allowed: false, reason: 'unknown_route', messageKo: '존재하지 않는 화면이다.' };
  }
  if (req.actor.tenantId !== req.scope.tenantId) {
    // 남의 테넌트 자원의 존재 여부조차 알려주지 않는다.
    return { allowed: false, reason: 'tenant_mismatch', messageKo: '요청한 자원을 찾을 수 없다.', route };
  }
  if (req.blocked) {
    return { allowed: false, reason: 'blocked', messageKo: '현재 이 기능을 사용할 수 없다. 관리자에게 문의한다.', route };
  }
  if (!canAccess(route, req.actor.roles)) {
    return { allowed: false, reason: 'role', messageKo: '이 화면에 접근할 권한이 없다.', route };
  }
  return { allowed: true, route };
}

/** 거부는 화면 성격과 무관하게 남긴다. 성공은 감사 대상 화면일 때만 남긴다. */
export function shouldRecord(decision: AccessDecision, route: PortalRoute | undefined, opts: AccessLogOptions = {}): boolean {
  if (!decision.allowed) return true;
  if (opts.recordAllReads) return true;
  return route !== undefined && shouldAudit(route);
}

function bulkNote(req: AccessRequest, action: AuditAction, opts: AccessLogOptions): string | undefined {
  const threshold = opts.bulkExportThreshold;
  if (threshold === undefined || req.affectedCount === undefined) return undefined;
  if (action !== 'export' && action !== 'view') return undefined;
  return req.affectedCount >= threshold ? `대량 반출 ${req.affectedCount}건(기준 ${threshold}건)` : undefined;
}

/**
 * 판정 + 기록을 한 번에. 호출자가 기록을 빼먹을 수 없도록 이 함수 하나만 쓰게 한다.
 * 거부된 접근도 같은 체인에 쌓이므로, 체인 검증(verifyChain)만으로 "거부 이력이 지워졌는지"까지 드러난다.
 */
export function recordAccess(
  chain: AuditChain,
  req: AccessRequest,
  hash: Hasher,
  opts: AccessLogOptions = {},
): AccessOutcome {
  const decision = decideAccess(req);
  const route = decision.route;

  if (!shouldRecord(decision, route, opts)) {
    return { decision, chain, recorded: false };
  }

  const action: AuditAction = req.action ?? (route ? defaultActionFor(route) : 'view');
  const result: AuditResult = decision.allowed ? 'success' : 'denied';
  const notes = [
    req.detail,
    decision.allowed ? undefined : `거부 사유: ${decision.reason}`,
    bulkNote(req, action, opts),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  // 다른 테넌트 접근 시도는 요청 scope 가 아니라 **행위자의 테넌트 체인**에 남긴다.
  // 남의 체인에 넣으면 그 테넌트가 자기 감사로그에서 남의 사용자 정보를 보게 된다(§11.1).
  const targetScope: TenantScope =
    decision.reason === 'tenant_mismatch'
      ? { tenantId: req.actor.tenantId }
      : req.scope;

  if (chain.tenantId !== targetScope.tenantId) {
    throw new Error(
      `접근 이력을 다른 테넌트 체인에 남길 수 없다: ${chain.tenantId} ≠ ${targetScope.tenantId} (설계서 §11.1)`,
    );
  }

  const next = appendAudit(chain, {
    scope: targetScope,
    recordId: req.recordId,
    at: req.at,
    actor: {
      userId: req.actor.userId,
      roles: req.actor.roles,
      ...(req.actor.ip !== undefined ? { ip: req.actor.ip } : {}),
    },
    action,
    routeId: req.routeId,
    targetType: req.targetType ?? (route ? route.section : 'unknown_route'),
    targetId: req.targetId ?? req.routeId,
    result,
    ...(notes.length > 0 ? { detail: notes.join(' · ') } : {}),
  }, hash);

  return { decision, chain: next, recorded: true, record: next.records[next.records.length - 1] };
}

// ── 조회·요약 ────────────────────────────────────────────────────────────────

export interface AccessHistoryQuery {
  scope: TenantScope;
  from?: string;
  to?: string;
  actorUserId?: string;
  routeId?: string;
  result?: AuditResult;
  action?: AuditAction;
  /** 최신부터 볼 것인가. 기본은 발생 순(체인 순서). */
  newestFirst?: boolean;
  limit?: number;
}

/** 접근 이력 조회(§7 7.6). 테넌트 조건은 호출자가 빼먹을 수 없게 항상 강제된다(§11.1). */
export function accessHistory(chain: AuditChain, q: AccessHistoryQuery): AuditRecord[] {
  assertTenantScope(q.scope);
  const rows = chain.records.filter(r => {
    if (r.tenant_id !== q.scope.tenantId) return false;
    if (q.scope.workspaceId !== undefined && r.workspace_id !== q.scope.workspaceId) return false;
    if (q.from !== undefined && r.occurred_at < q.from) return false;
    if (q.to !== undefined && r.occurred_at > q.to) return false;
    if (q.actorUserId !== undefined && r.actor_user_id !== q.actorUserId) return false;
    if (q.routeId !== undefined && r.route_id !== q.routeId) return false;
    if (q.result !== undefined && r.result !== q.result) return false;
    if (q.action !== undefined && r.action !== q.action) return false;
    return true;
  });
  const ordered = q.newestFirst ? [...rows].reverse() : rows;
  return q.limit !== undefined && q.limit >= 0 ? ordered.slice(0, q.limit) : ordered;
}

export interface ActorAccessSummary {
  actorUserId: string;
  total: number;
  denied: number;
  /** PII 열람·내보내기 건수. 사후 점검에서 가장 먼저 보는 두 항목이다. */
  views: number;
  exports: number;
  firstAt: string;
  lastAt: string;
}

/**
 * 행위자별 실측 집계. 계산할 수 있는 사실만 낸다 —
 * "이상 징후 점수" 같은 판단값은 만들지 않는다(§13-3, 근거 없는 수치 금지).
 */
export function accessSummary(chain: AuditChain, q: AccessHistoryQuery): ActorAccessSummary[] {
  const rows = accessHistory(chain, { ...q, limit: undefined, newestFirst: false });
  const byActor = new Map<string, ActorAccessSummary>();
  for (const r of rows) {
    const cur = byActor.get(r.actor_user_id) ?? {
      actorUserId: r.actor_user_id, total: 0, denied: 0, views: 0, exports: 0,
      firstAt: r.occurred_at, lastAt: r.occurred_at,
    };
    cur.total += 1;
    if (r.result === 'denied') cur.denied += 1;
    if (r.action === 'view') cur.views += 1;
    if (r.action === 'export') cur.exports += 1;
    if (r.occurred_at < cur.firstAt) cur.firstAt = r.occurred_at;
    if (r.occurred_at > cur.lastAt) cur.lastAt = r.occurred_at;
    byActor.set(r.actor_user_id, cur);
  }
  return [...byActor.values()].sort((a, b) => b.total - a.total || a.actorUserId.localeCompare(b.actorUserId));
}
