// 파트너 역할 권한 — 설계서 §10(최소권한)·§10.2(접근 기록)·§11.1(테넌트 격리)·§7(포털 IA).
//
// 무엇을 막으려는 파일인가:
// 파트너 담당자(제이투모로우원)에게 관리 포털을 열어 주는 순간, **자기가 유치하지 않은 고객사**가
// 보이는 사고가 가장 먼저 난다. 그 사고는 대개 코드가 틀려서가 아니라 조건이 **빠져서** 난다 —
// 목록 조회 한 곳에서 파트너 조건을 안 걸면 그걸로 끝이다.
//
// 그래서 여기서는 세 겹으로 잠근다:
//  1) **기본 거부.** partner_admin 은 `ia.ts` 의 어떤 라우트에서도 권한을 얻지 못한다.
//     접근은 아래 허용 목록(PARTNER_ROUTE_ALLOWLIST)이 유일한 근거다. 새 화면을 추가해도 자동으로 열리지 않는다.
//  2) **미결속 거부.** partnerId 가 없는 partner_admin 은 "전체 조회"가 아니라 **거부**다.
//     이 한 줄이 없으면, 파트너 계정 하나에 값이 안 들어간 것만으로 전 고객사가 노출된다.
//  3) **역할 혼용 거부.** 내부 역할과 partner_admin 을 동시에 가진 계정은 설정 오류로 본다.
//     혼용을 허용하면 "어느 쪽 권한으로 판정했는가"가 화면마다 달라진다.
//
// 활성화는 별개다. 기본 OFF 이며, 켜려면 승인 근거가 있어야 한다 — **[승인 필요]**.
// 실제 정산·청구 연결은 여전히 하지 않는다(build now, activate on approval).
import { canAccess, routeById, PORTAL_ROUTES, type PortalRole, type PortalRoute } from '../portal/ia.ts';
import { assertTenantScope, isValidId, type TenantScope } from '../core/tenancy.ts';
import {
  appendAudit, defaultActionFor, shouldAudit,
  type AuditAction, type AuditChain, type AuditRecord, type Hasher,
} from '../audit/log.ts';
import {
  partnerScopedFilter, visibleToPartner,
  type AttributionQuery, type AttributionRecord, type ScopedAttributionFilter,
} from './attribution.ts';

/**
 * 파트너 담당자가 볼 수 있는 화면. **읽기 전용·비 PII 만** 연다.
 * 지금 열린 것은 정산 근거 조회 하나뿐이다. 상호작용 내용·고객 개인정보·설정 화면은 열지 않는다 —
 * 파트너는 운영 대행자이지 개인정보 취급 위탁 계약의 당사자가 아니기 때문이다(확대는 계약 확정 후).
 */
export const PARTNER_ROUTE_ALLOWLIST: readonly string[] = Object.freeze(['reports.settlement']);

export type PartnerActivation = 'disabled' | 'enabled';

export interface PartnerRbacConfig {
  /** 기본 disabled. enabled 로 켜려면 approvalRef 가 있어야 한다 — [승인 필요] */
  activation?: PartnerActivation;
  approvalRef?: string;
}

export interface PartnerActor {
  userId: string;
  tenantId: string;
  roles: PortalRole[];
  /** 이 담당자가 속한 파트너. partner_admin 이면 반드시 있어야 한다. */
  partnerId?: string | null;
  ip?: string;
}

export type PartnerDenyReason =
  | 'activation_pending'  // 역할이 아직 켜지지 않았다 [승인 필요]
  | 'role_mix'            // 내부 역할과 혼용
  | 'partner_unbound'     // partnerId 미지정 — 전체 조회로 흘러가지 않게 막는다
  | 'partner_invalid'     // 식별자 형식
  | 'tenant_mismatch'
  | 'unknown_route'
  | 'not_allowlisted';

export interface PartnerAccessDecision {
  allowed: boolean;
  reason?: PartnerDenyReason;
  messageKo?: string;
  route?: PortalRoute;
  /** 허용된 경우 조회에 반드시 적용해야 하는 파트너 식별자. */
  scopedPartnerId?: string;
}

export function isPartnerActor(actor: PartnerActor): boolean {
  return actor.roles.includes('partner_admin');
}

const INTERNAL_ROLES: readonly PortalRole[] = ['tenant_owner', 'admin', 'supervisor', 'agent', 'analyst', 'auditor'];

/** 활성화 여부. 승인 근거 없는 enabled 는 켜진 것으로 보지 않는다. */
export function partnerRbacEnabled(config: PartnerRbacConfig = {}): boolean {
  return config.activation === 'enabled' && typeof config.approvalRef === 'string' && config.approvalRef.length > 0;
}

export interface PartnerAccessRequest {
  scope: TenantScope;
  actor: PartnerActor;
  routeId: string;
}

/**
 * 파트너 담당자의 화면 접근 판정.
 * 내부 사용자(partner_admin 없음)는 이 함수를 거치지 않는다 — `audit/access.ts` 의 decideAccess 가 그대로 담당한다.
 * 순서가 중요하다: **테넌트 → 활성화 → 역할 혼용 → 결속 → 허용 목록**.
 * 테넌트를 먼저 보는 이유는, 남의 테넌트에는 활성화 상태조차 알려줄 필요가 없기 때문이다(§11.1).
 */
export function decidePartnerAccess(req: PartnerAccessRequest, config: PartnerRbacConfig = {}): PartnerAccessDecision {
  assertTenantScope(req.scope);
  const { actor } = req;

  if (actor.tenantId !== req.scope.tenantId) {
    return { allowed: false, reason: 'tenant_mismatch', messageKo: '요청한 자원을 찾을 수 없다.' };
  }
  if (!partnerRbacEnabled(config)) {
    return { allowed: false, reason: 'activation_pending', messageKo: '파트너 권한이 아직 활성화되지 않았다. 관리자에게 문의한다.' };
  }
  if (actor.roles.some((r) => INTERNAL_ROLES.includes(r))) {
    return { allowed: false, reason: 'role_mix', messageKo: '이 계정의 권한 설정이 올바르지 않다. 관리자에게 문의한다.' };
  }
  const pid = actor.partnerId ?? null;
  if (pid === null) {
    // 여기서 "전체 조회"로 흘러가면 파트너 하나가 전 고객사를 본다. 반드시 거부다.
    return { allowed: false, reason: 'partner_unbound', messageKo: '파트너 정보가 연결되지 않은 계정이다. 관리자에게 문의한다.' };
  }
  if (!isValidId(pid)) {
    return { allowed: false, reason: 'partner_invalid', messageKo: '파트너 식별자 형식이 올바르지 않다.' };
  }

  const route = routeById(req.routeId);
  if (!route) {
    return { allowed: false, reason: 'unknown_route', messageKo: '존재하지 않는 화면이다.' };
  }
  if (!PARTNER_ROUTE_ALLOWLIST.includes(route.id)) {
    return { allowed: false, reason: 'not_allowlisted', messageKo: '이 화면에 접근할 권한이 없다.', route };
  }
  // 허용 목록에 있어도 PII·상태변경 화면은 열지 않는다. 목록을 잘못 늘렸을 때의 마지막 방어선이다.
  if (route.pii || route.mutates) {
    return { allowed: false, reason: 'not_allowlisted', messageKo: '이 화면에 접근할 권한이 없다.', route };
  }
  return { allowed: true, route, scopedPartnerId: pid };
}

/**
 * 조회 조건. 파트너 담당자면 partnerId 를 **강제로** 끼운다 — 호출자가 넣기를 기대하지 않는다.
 * 내부 사용자는 기존 동작 그대로(생략 시 전체).
 * 허용되지 않은 파트너 접근에는 조건을 만들어 주지 않고 던진다 — 조건 없는 질의가 나가는 것보다 낫다.
 */
export function partnerActorFilter(
  scope: TenantScope,
  actor: PartnerActor,
  query: AttributionQuery = {},
  config: PartnerRbacConfig = {},
): ScopedAttributionFilter {
  if (!isPartnerActor(actor)) return partnerScopedFilter(scope, query);

  const decision = decidePartnerAccess({ scope, actor, routeId: PARTNER_ROUTE_ALLOWLIST[0] }, config);
  if (!decision.allowed || decision.scopedPartnerId === undefined) {
    throw new Error(`파트너 조회 조건을 만들 수 없다: ${decision.reason ?? 'unknown'} (설계서 §11.1)`);
  }
  // 호출자가 넘긴 partnerId 는 무시한다. 덮어쓸 수 있으면 잠금이 아니다.
  return partnerScopedFilter(scope, { ...query, partnerId: decision.scopedPartnerId });
}

/**
 * 결과 목록 2차 필터. 저장소 조건과 **별개로** 한 번 더 거른다 — 조건 누락이 곧 유출이다.
 * 파트너가 아니면 그대로, 파트너면 자기 것만.
 */
export function filterForPartnerActor(
  records: readonly AttributionRecord[],
  scope: TenantScope,
  actor: PartnerActor,
  config: PartnerRbacConfig = {},
): AttributionRecord[] {
  if (!isPartnerActor(actor)) return visibleToPartner(records, scope, null);
  const decision = decidePartnerAccess({ scope, actor, routeId: PARTNER_ROUTE_ALLOWLIST[0] }, config);
  if (!decision.allowed || decision.scopedPartnerId === undefined) return [];  // 판정 실패는 빈 목록이다. 전체가 아니다.
  return visibleToPartner(records, scope, decision.scopedPartnerId);
}

// ── 접근 기록 ────────────────────────────────────────────────────────────────

export interface PartnerAccessLogRequest extends PartnerAccessRequest {
  at: string;        // ISO8601 — 주입(순수 함수 유지)
  recordId: string;
  action?: AuditAction;
  targetId?: string;
  detail?: string;
}

export interface PartnerAccessOutcome {
  decision: PartnerAccessDecision;
  chain: AuditChain;
  recorded: boolean;
  record?: AuditRecord;
}

/**
 * 판정 + 기록. 파트너 접근은 **거부를 빠짐없이 남긴다** — 외부 인력의 접근 시도는
 * 조사에서 가장 먼저 보는 자료다. 성공은 감사 대상 화면일 때만 남긴다(내부 사용자와 같은 기준).
 * 다른 테넌트로의 시도는 행위자 테넌트 체인에 남긴다(§11.1) — 남의 체인에 넣으면 그 테넌트가
 * 자기 감사로그에서 남의 사용자 정보를 보게 된다.
 */
export function recordPartnerAccess(
  chain: AuditChain,
  req: PartnerAccessLogRequest,
  hash: Hasher,
  config: PartnerRbacConfig = {},
): PartnerAccessOutcome {
  const decision = decidePartnerAccess(req, config);
  const route = decision.route;

  if (decision.allowed && !(route !== undefined && shouldAudit(route))) {
    return { decision, chain, recorded: false };
  }

  const targetTenantId = decision.reason === 'tenant_mismatch' ? req.actor.tenantId : req.scope.tenantId;
  if (chain.tenantId !== targetTenantId) {
    throw new Error(`접근 이력을 다른 테넌트 체인에 남길 수 없다: ${chain.tenantId} ≠ ${targetTenantId} (설계서 §11.1)`);
  }

  const action: AuditAction = req.action ?? (route ? defaultActionFor(route) : 'view');
  const notes = [
    req.detail,
    decision.allowed ? `파트너 조회: ${decision.scopedPartnerId}` : `거부 사유: ${decision.reason}`,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  const next = appendAudit(chain, {
    scope: { tenantId: targetTenantId },
    recordId: req.recordId,
    at: req.at,
    actor: {
      userId: req.actor.userId,
      roles: req.actor.roles,          // 실제 역할을 그대로 남긴다. 판정 편의로 역할을 바꿔 적지 않는다.
      ...(req.actor.ip !== undefined ? { ip: req.actor.ip } : {}),
    },
    action,
    routeId: req.routeId,
    targetType: route ? route.section : 'unknown_route',
    targetId: req.targetId ?? req.routeId,
    result: decision.allowed ? 'success' : 'denied',
    ...(notes.length > 0 ? { detail: notes.join(' · ') } : {}),
  }, hash);

  return { decision, chain: next, recorded: true, record: next.records[next.records.length - 1] };
}

/**
 * 회귀 방지용 자기 점검. `ia.ts` 에 partner_admin 이 실수로 섞여 들어가면 여기서 드러난다.
 * 허용 목록의 라우트가 사라지거나 PII·변경 화면으로 바뀐 경우도 함께 잡는다.
 */
export function partnerRbacSelfCheck(): string[] {
  const problems: string[] = [];
  for (const id of PARTNER_ROUTE_ALLOWLIST) {
    const route = routeById(id);
    if (!route) { problems.push(`허용 목록의 ${id} 가 IA 에 없다.`); continue; }
    if (route.pii) problems.push(`${id} 가 개인정보 열람 화면이 되었다 — 파트너에게 열 수 없다.`);
    if (route.mutates) problems.push(`${id} 가 상태 변경 화면이 되었다 — 파트너에게 열 수 없다.`);
  }
  // partner_admin 은 IA 라우트에서 권한을 얻으면 안 된다(기본 거부 유지).
  const leaked = routeIdsGrantingPartner();
  if (leaked.length > 0) problems.push(`IA 라우트가 partner_admin 에게 직접 권한을 주고 있다: ${leaked.join(', ')}`);
  return problems;
}

function routeIdsGrantingPartner(): string[] {
  const out: string[] = [];
  for (const id of allRouteIds()) {
    const route = routeById(id);
    if (route && canAccess(route, ['partner_admin'])) out.push(id);
  }
  return out;
}

function allRouteIds(): string[] {
  // ia.ts 의 목록을 그대로 쓴다. 여기서 별도 목록을 만들면 둘이 어긋난다.
  return PORTAL_ROUTES.map((r) => r.id);
}
