// 감사로그 — 설계서 §10.2(접근·변경 기록) · §10.3(개인정보) · §7 7.6(리포트>감사로그) · §11.1(테넌트 격리).
//
// 감사로그의 목적은 "무슨 일이 있었는지"를 사후에 다툴 수 없게 만드는 것이다. 그래서 두 가지를 강제한다.
//   1) append-only — 수정·삭제 API를 만들지 않는다. 정정은 새 레코드로 남긴다.
//   2) 해시 체인 — 각 레코드가 직전 레코드의 해시를 포함한다. 중간 레코드를 지우거나 고치면 검증에서 드러난다.
//
// 그리고 감사로그 자체가 개인정보 저장소가 되면 안 된다(§10.3).
//   - detail 은 저장 전 maskPii 를 통과한다. 원문을 넣는 경로를 만들지 않는다.
//   - 대상 식별자는 id 로만 남긴다(이름·전화번호를 target_id 에 넣지 말 것).
//   - IP 는 마지막 옥텟을 지운 형태로만 남긴다(접속 추적에는 충분하고, 개인 식별성은 낮춘다).
//
// 해시 함수는 주입받는다. Core 에 node:crypto 를 직접 끌어들이면 런타임 종속이 생기고(§6.2 취지),
// 비암호학적 해시를 내장하면 "변조 탐지"라는 말이 거짓이 된다. 그래서 SHA-256 구현은 호스트가 넣는다.

import { maskPii } from '../core/policyGuard.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import type { PortalRole, PortalRoute } from '../portal/ia.ts';
import { requiresAuditLog } from '../portal/ia.ts';

export const AUDIT_SCHEMA_VERSION = 1;

/** 체인의 시작점. 첫 레코드의 prev_hash 값이다. */
export const GENESIS_HASH = 'genesis';

export type AuditAction =
  | 'view'              // PII 화면 열람(§10.3)
  | 'create'
  | 'update'
  | 'delete'
  | 'export'            // 내보내기 — 대량 반출이므로 별도 액션으로 분리한다
  | 'publish'           // 시나리오 배포(§5.3)
  | 'approve'           // 승인·반려
  | 'login'
  | 'permission_change' // 권한 변경 — 사고 조사에서 가장 먼저 보는 항목
  | 'policy_change';    // 보존정책·AI 고지 문구 등 정책 변경(§8.2·§10.1)

export type AuditResult = 'success' | 'denied' | 'error';

export interface AuditActor {
  userId: string;
  roles: PortalRole[];
  /** 원문 IP. 저장 시 마스킹된다. */
  ip?: string;
}

export interface AuditInput {
  scope: TenantScope;
  recordId: string;
  at: string;               // ISO8601 — 주입(순수 함수 유지)
  actor: AuditActor;
  action: AuditAction;
  /** PORTAL_ROUTES 의 라우트 id(§7). API 직접 호출이면 생략 가능. */
  routeId?: string;
  targetType: string;       // 'interaction' | 'flow' | 'member' | 'retention_policy' ...
  targetId: string;
  result: AuditResult;
  /** 사람이 읽을 사유·변경 요약. 저장 전 마스킹된다. */
  detail?: string;
}

export interface AuditRecord {
  record_id: string;
  schema_version: number;
  seq: number;
  occurred_at: string;
  tenant_id: string;
  workspace_id?: string;
  actor_user_id: string;
  actor_roles: PortalRole[];
  actor_ip_masked?: string;
  action: AuditAction;
  route_id?: string;
  target_type: string;
  target_id: string;
  result: AuditResult;
  detail_masked?: string;
  /** detail 에 마스킹이 적용되었는지(§10.3 점검용) */
  pii_masked: boolean;
  pii_kinds: string[];
  prev_hash: string;
  hash: string;
}

export interface AuditChain {
  tenantId: string;
  records: AuditRecord[];
}

/** 문자열 → 16진 해시. 호스트가 SHA-256 등 암호학적 해시를 주입한다. */
export type Hasher = (input: string) => string;

export function emptyChain(scope: TenantScope): AuditChain {
  assertTenantScope(scope);
  return { tenantId: scope.tenantId, records: [] };
}

/**
 * IPv4 는 마지막 옥텟, IPv6 는 뒤 4그룹을 지운다.
 * 형식을 알아볼 수 없으면 통째로 버린다 — "모르는 값은 남기지 않는다"가 개인정보 처리의 기본이다.
 */
export function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  if (ip.includes(':')) {
    const parts = ip.trim().split(':');
    if (parts.length >= 4) return `${parts.slice(0, 4).join(':')}::`;
  }
  return undefined;
}

/**
 * 해시 입력의 정규 문자열. 필드 순서를 여기서 고정한다 —
 * JSON.stringify(객체) 의 키 순서에 기대면 나중에 필드를 추가했을 때 과거 체인이 통째로 깨진다.
 */
export function canonicalize(r: Omit<AuditRecord, 'hash'>): string {
  return [
    r.schema_version,
    r.seq,
    r.record_id,
    r.occurred_at,
    r.tenant_id,
    r.workspace_id ?? '',
    r.actor_user_id,
    r.actor_roles.join(','),
    r.actor_ip_masked ?? '',
    r.action,
    r.route_id ?? '',
    r.target_type,
    r.target_id,
    r.result,
    r.detail_masked ?? '',
    r.pii_masked ? '1' : '0',
    r.pii_kinds.join(','),
    r.prev_hash,
  ].join('');
}

/** 체인의 마지막 해시. 다음 레코드의 prev_hash 가 된다. */
export function headHash(chain: AuditChain): string {
  const last = chain.records[chain.records.length - 1];
  return last ? last.hash : GENESIS_HASH;
}

/**
 * 레코드 추가. 새 체인을 반환한다(원본 불변).
 * 다른 테넌트의 레코드를 같은 체인에 넣는 것은 격리 위반이므로 예외로 막는다(§11.1).
 */
export function appendAudit(chain: AuditChain, input: AuditInput, hash: Hasher): AuditChain {
  assertTenantScope(input.scope);
  if (chain.tenantId !== input.scope.tenantId) {
    throw new Error(
      `다른 테넌트의 감사 레코드를 같은 체인에 넣을 수 없다: ${chain.tenantId} ≠ ${input.scope.tenantId} (설계서 §11.1)`,
    );
  }
  if (!input.actor.userId) {
    throw new Error('행위자 없는 감사 레코드는 남길 수 없다 (설계서 §10.2)');
  }

  const masked = input.detail === undefined ? undefined : maskPii(input.detail);
  const ip = maskIp(input.actor.ip);

  const body: Omit<AuditRecord, 'hash'> = {
    record_id: input.recordId,
    schema_version: AUDIT_SCHEMA_VERSION,
    seq: chain.records.length + 1,
    occurred_at: input.at,
    tenant_id: input.scope.tenantId,
    ...(input.scope.workspaceId !== undefined ? { workspace_id: input.scope.workspaceId } : {}),
    actor_user_id: input.actor.userId,
    actor_roles: [...input.actor.roles],
    ...(ip !== undefined ? { actor_ip_masked: ip } : {}),
    action: input.action,
    ...(input.routeId !== undefined ? { route_id: input.routeId } : {}),
    target_type: input.targetType,
    target_id: input.targetId,
    result: input.result,
    ...(masked !== undefined ? { detail_masked: masked.text } : {}),
    pii_masked: masked?.masked ?? false,
    pii_kinds: masked?.hits ?? [],
    prev_hash: headHash(chain),
  };

  const record: AuditRecord = { ...body, hash: hash(canonicalize(body)) };
  return { tenantId: chain.tenantId, records: [...chain.records, record] };
}

export type ChainBreak =
  | { kind: 'hash_mismatch'; seq: number; recordId: string }
  | { kind: 'prev_hash_mismatch'; seq: number; recordId: string }
  | { kind: 'seq_gap'; seq: number; recordId: string }
  | { kind: 'foreign_tenant'; seq: number; recordId: string };

export interface ChainVerification {
  ok: boolean;
  checked: number;
  breaks: ChainBreak[];
}

/**
 * 체인 검증. 첫 번째 문제에서 멈추지 않고 전부 모은다 —
 * 감사 대응에서는 "어디부터 어디까지 신뢰할 수 있는가"가 필요하지, "깨졌다"는 사실만으로는 부족하다.
 */
export function verifyChain(chain: AuditChain, hash: Hasher): ChainVerification {
  const breaks: ChainBreak[] = [];
  let prev = GENESIS_HASH;

  chain.records.forEach((r, i) => {
    if (r.tenant_id !== chain.tenantId) {
      breaks.push({ kind: 'foreign_tenant', seq: r.seq, recordId: r.record_id });
    }
    if (r.seq !== i + 1) {
      breaks.push({ kind: 'seq_gap', seq: r.seq, recordId: r.record_id });
    }
    if (r.prev_hash !== prev) {
      breaks.push({ kind: 'prev_hash_mismatch', seq: r.seq, recordId: r.record_id });
    }
    const { hash: stored, ...body } = r;
    if (hash(canonicalize(body)) !== stored) {
      breaks.push({ kind: 'hash_mismatch', seq: r.seq, recordId: r.record_id });
    }
    prev = r.hash;
  });

  return { ok: breaks.length === 0, checked: chain.records.length, breaks };
}

/** 라우트 접근이 감사 대상인지(§7·§10.3). IA 의 판정을 그대로 쓴다 — 기준이 두 곳에 있으면 반드시 어긋난다. */
export function shouldAudit(route: PortalRoute): boolean {
  return requiresAuditLog(route);
}

/** 라우트 → 기본 액션. 화면 성격만으로 정해지는 부분을 한 곳에 모아 둔다. */
export function defaultActionFor(route: PortalRoute): AuditAction {
  if (route.id.endsWith('.export')) return 'export';
  if (route.id.startsWith('studio.publish')) return 'publish';
  if (route.id === 'settings.members') return 'permission_change';
  if (route.id === 'settings.retention' || route.id === 'operations.disclosure') return 'policy_change';
  return route.mutates ? 'update' : 'view';
}

export interface AuditQuery {
  scope: TenantScope;
  from?: string;
  to?: string;
  actorUserId?: string;
  action?: AuditAction;
  targetType?: string;
  targetId?: string;
  result?: AuditResult;
}

/** 감사로그 조회(§7 7.6). 테넌트 조건은 호출자가 빼먹을 수 없도록 항상 강제 주입된다(§11.1). */
export function queryAudit(chain: AuditChain, q: AuditQuery): AuditRecord[] {
  assertTenantScope(q.scope);
  return chain.records.filter(r => {
    if (r.tenant_id !== q.scope.tenantId) return false;
    if (q.scope.workspaceId !== undefined && r.workspace_id !== q.scope.workspaceId) return false;
    if (q.from !== undefined && r.occurred_at < q.from) return false;
    if (q.to !== undefined && r.occurred_at > q.to) return false;
    if (q.actorUserId !== undefined && r.actor_user_id !== q.actorUserId) return false;
    if (q.action !== undefined && r.action !== q.action) return false;
    if (q.targetType !== undefined && r.target_type !== q.targetType) return false;
    if (q.targetId !== undefined && r.target_id !== q.targetId) return false;
    if (q.result !== undefined && r.result !== q.result) return false;
    return true;
  });
}
