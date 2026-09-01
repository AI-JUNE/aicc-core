// 외부 업무시스템 연동 커넥터 계약 — 설계서 §6.1(연동)·§5.3(시나리오)·§9.3(폴백)·§10.3(개인정보)·§11.1(테넌트).
//
// AICC가 실제로 값을 만드는 지점은 발화가 아니라 조회다. "카드 재발급 신청됐나요"에 답하려면
// 고객사 업무시스템을 호출해야 한다. 이 호출이 Core 안으로 직접 들어오면 두 가지가 동시에 깨진다.
//   1) 고객사마다 다른 엔드포인트·인증이 Core 코드에 박혀 온프렘 납품이 불가능해진다(§6.2와 같은 이유).
//   2) 조회 파라미터로 개인정보가 나가고, 응답에 개인정보가 실려 들어온다(§10.3 국외이전·저장 위반 경로).
// 그래서 연동은 "선언(ConnectorDef) + 포트(ConnectorPort)"로만 존재하고, Core는 판정만 한다.
//
// 규약 4줄 요약
//  1) 엔드포인트 원문·자격증명은 Core에 두지 않는다. 시크릿 저장소 참조 키(endpointRef)만 갖는다.
//  2) 요청 파라미터는 마스킹하지 않는다(마스킹하면 조회가 안 된다). 대신 로그·이벤트로 나갈 때
//     redactRequest()를 반드시 통과시킨다 — 마스킹 지점은 "전송"이 아니라 "기록"이다.
//  3) 응답은 allowlist(outputs)에 선언된 필드만 슬롯이 된다. 선언되지 않은 필드는 버린다.
//     슬롯에 담기는 값은 저장 경로에 올라타므로 예외 없이 maskPii를 통과한다(§10.3).
//  4) 실패는 커넥터가 정하지 않는다. 재시도·분기·이관 판정은 순수 함수로 밖에서 결정한다(§9.3).
//
// 실엔드포인트 연결은 [승인 필요] — 현재는 계약과 판정만 있고 호출 구현은 없다.
import { maskPii } from '../core/policyGuard.ts';
import { assertTenantScope, isValidId, type TenantScope } from '../core/tenancy.ts';
import type { ComponentId } from '../ops/fallback.ts';

/** 커넥터 장애는 §9.3의 L3 지식 계층으로 집계된다 — 흐름은 살리고 근거만 포기할 수 있는 계층. */
export const CONNECTOR_HEALTH_COMPONENT: ComponentId = 'backend';

/** 조회(query)는 재시도해도 안전하고, 명령(command)은 그렇지 않다. 멱등성 판단의 1차 근거다. */
export type ConnectorMethod = 'query' | 'command';

export type ConnectorErrorCode =
  | 'timeout'
  | 'unavailable'
  | 'unauthorized'
  | 'not_found'
  | 'invalid_request'
  | 'server_error'
  | 'schema_mismatch';

/** 외부 장애로 판단되어 재시도 후보가 되는 코드. not_found·invalid_request는 다시 불러도 결과가 같다. */
const TRANSIENT: ReadonlySet<ConnectorErrorCode> = new Set<ConnectorErrorCode>(['timeout', 'unavailable', 'server_error']);

export interface ConnectorParam {
  /** 업무시스템이 받는 파라미터 이름 */
  name: string;
  /** 값을 가져올 세션 슬롯 이름 */
  fromSlot: string;
  required: boolean;
  /**
   * 개인정보 파라미터 여부. true 면 호출 전에 수집·이용 동의(§10.1) 확인이 필요하고,
   * 기록 시 redactRequest 가 값을 마스킹한다.
   */
  pii?: boolean;
}

export interface ConnectorOutput {
  /** 응답 본문에서 읽을 필드 이름(1단계 키만 — 중첩 경로는 어댑터가 평탄화해서 올린다) */
  field: string;
  /** 값을 담을 세션 슬롯 이름 */
  toSlot: string;
}

export interface ConnectorRetryPolicy {
  /** 최초 시도를 포함한 총 시도 횟수. 권장값을 코드에 박지 않는다 — 테넌트가 계약대로 넣는다(§13-3). */
  maxAttempts: number;
  /** 재시도할 오류 코드. 미지정 시 일시적 오류(timeout·unavailable·server_error)만 재시도한다. */
  retryOn?: ConnectorErrorCode[];
}

/** 최종 실패 시 시나리오가 갈 곳. branch 는 Api 노드의 onError 로 빠진다(§5.3). */
export type ConnectorFailureAction = 'branch' | 'handoff_agent' | 'continue';

export interface ConnectorDef {
  id: string;
  tenantId: string;
  workspaceId?: string;
  name: string;
  method: ConnectorMethod;
  /**
   * 시크릿 저장소의 참조 키. URL·토큰·인증서 원문을 여기에 넣지 않는다.
   * 실제 해석과 호출은 어댑터 구현이 담당한다 — [승인 필요].
   */
  endpointRef: string;
  /** 호출 대상 시스템의 소재. 국외 시스템은 §10.3 게이트를 통과해야 한다. */
  residency: 'domestic' | 'onprem' | 'overseas';
  timeoutMs: number;
  params: ConnectorParam[];
  outputs: ConnectorOutput[];
  retry?: ConnectorRetryPolicy;
  onFailure: ConnectorFailureAction;
}

// ── 포트 (§6.2 — 시스템 종속 코드는 이 인터페이스 뒤에만 둔다) ──────────────────────────

export type ParamValue = string | number | boolean;

export interface ConnectorRequest {
  connectorId: string;
  tenantId: string;
  workspaceId?: string;
  interactionId: string;
  endpointRef: string;
  method: ConnectorMethod;
  params: Record<string, ParamValue>;
  timeoutMs: number;
  /** 1부터 시작. 재시도 시 증가한다. */
  attempt: number;
  /** 멱등 키 — command 재시도가 중복 처리되지 않게 한다(§8.1 멱등 처리와 같은 원칙). */
  idempotencyKey: string;
}

export type ConnectorResponse =
  | { ok: true; data: Record<string, unknown>; latencyMs?: number }
  | { ok: false; code: ConnectorErrorCode; detail?: string; latencyMs?: number };

export interface ConnectorPort {
  call(request: ConnectorRequest): Promise<ConnectorResponse>;
}

// ── 선언 검증 ─────────────────────────────────────────────────────────────────

export type ConnectorIssueCode =
  | 'E_ID_INVALID'
  | 'E_TENANT_INVALID'
  | 'E_ENDPOINT_REF_EMPTY'
  | 'E_TIMEOUT_INVALID'
  | 'E_PARAM_INVALID'
  | 'E_PARAM_DUPLICATE'
  | 'E_OUTPUT_INVALID'
  | 'E_OUTPUT_DUPLICATE_SLOT'
  | 'E_OUTPUT_RESERVED_SLOT'
  | 'E_RETRY_INVALID'
  | 'W_COMMAND_RETRY'
  | 'W_NO_OUTPUT';

export interface ConnectorIssue {
  code: ConnectorIssueCode;
  severity: 'error' | 'warning';
  messageKo: string;
  field?: string;
}

/** Core가 관리하는 예약 슬롯. 커넥터 응답이 여기를 덮어쓰면 세션 판정이 조작된다. */
const RESERVED_SLOT_PREFIX = '__';

function blank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim() === '';
}

export function validateConnector(def: ConnectorDef): ConnectorIssue[] {
  const issues: ConnectorIssue[] = [];
  const err = (code: ConnectorIssueCode, messageKo: string, field?: string) =>
    issues.push({ code, severity: 'error', messageKo, ...(field !== undefined ? { field } : {}) });
  const warn = (code: ConnectorIssueCode, messageKo: string, field?: string) =>
    issues.push({ code, severity: 'warning', messageKo, ...(field !== undefined ? { field } : {}) });

  if (!isValidId(def.id)) err('E_ID_INVALID', `커넥터 id 형식 위반: ${JSON.stringify(def.id)}`, 'id');
  if (!isValidId(def.tenantId)) err('E_TENANT_INVALID', `tenant_id 형식 위반: ${JSON.stringify(def.tenantId)} (§11.1)`, 'tenantId');
  if (def.workspaceId !== undefined && !isValidId(def.workspaceId)) {
    err('E_TENANT_INVALID', `workspace_id 형식 위반: ${JSON.stringify(def.workspaceId)} (§11.1)`, 'workspaceId');
  }
  if (blank(def.endpointRef)) {
    err('E_ENDPOINT_REF_EMPTY', '엔드포인트 참조 키가 비어 있습니다. URL·자격증명 원문 대신 시크릿 참조 키를 넣습니다.', 'endpointRef');
  }
  if (!Number.isInteger(def.timeoutMs) || def.timeoutMs <= 0) {
    err('E_TIMEOUT_INVALID', 'timeoutMs 는 1 이상의 정수여야 합니다. 무한 대기는 콜을 붙잡아 둡니다(§9.3).', 'timeoutMs');
  }

  const seenParam = new Set<string>();
  def.params.forEach((p, i) => {
    if (blank(p.name)) err('E_PARAM_INVALID', `params[${i}].name 이 비어 있습니다.`, `params[${i}].name`);
    if (blank(p.fromSlot)) err('E_PARAM_INVALID', `params[${i}].fromSlot 이 비어 있습니다.`, `params[${i}].fromSlot`);
    if (!blank(p.name)) {
      if (seenParam.has(p.name)) err('E_PARAM_DUPLICATE', `중복된 파라미터 이름: ${p.name}`, `params[${i}].name`);
      seenParam.add(p.name);
    }
  });

  const seenSlot = new Set<string>();
  def.outputs.forEach((o, i) => {
    if (blank(o.field)) err('E_OUTPUT_INVALID', `outputs[${i}].field 가 비어 있습니다.`, `outputs[${i}].field`);
    if (blank(o.toSlot)) {
      err('E_OUTPUT_INVALID', `outputs[${i}].toSlot 이 비어 있습니다.`, `outputs[${i}].toSlot`);
      return;
    }
    if (o.toSlot.startsWith(RESERVED_SLOT_PREFIX)) {
      err('E_OUTPUT_RESERVED_SLOT', `예약 슬롯(${RESERVED_SLOT_PREFIX} 접두)에는 커넥터 응답을 담을 수 없습니다: ${o.toSlot}`, `outputs[${i}].toSlot`);
      return;
    }
    if (seenSlot.has(o.toSlot)) {
      err('E_OUTPUT_DUPLICATE_SLOT', `중복된 출력 슬롯: ${o.toSlot}`, `outputs[${i}].toSlot`);
    }
    seenSlot.add(o.toSlot);
  });
  if (def.outputs.length === 0 && def.method === 'query') {
    warn('W_NO_OUTPUT', '조회 커넥터인데 세션 슬롯으로 받는 출력이 없습니다. 호출 결과가 시나리오에 반영되지 않습니다.', 'outputs');
  }

  if (def.retry) {
    if (!Number.isInteger(def.retry.maxAttempts) || def.retry.maxAttempts < 1) {
      err('E_RETRY_INVALID', 'retry.maxAttempts 는 1 이상의 정수여야 합니다(최초 시도 포함).', 'retry.maxAttempts');
    }
    if (def.method === 'command' && def.retry.maxAttempts > 1) {
      warn('W_COMMAND_RETRY', '명령형 커넥터를 재시도합니다. 업무시스템이 idempotencyKey 를 처리하는지 확인하세요(중복 처리 위험).', 'retry');
    }
  }
  return issues;
}

export function connectorOk(issues: ConnectorIssue[]): boolean {
  return issues.every((i) => i.severity !== 'error');
}

/** §10.3 — 국외이전 불가 테넌트에서 해외 업무시스템 호출을 사전 차단한다. */
export function assertConnectorResidency(def: ConnectorDef, allowOverseas: boolean): void {
  if (allowOverseas) return;
  if (def.residency === 'overseas') {
    throw new Error(`국외이전 불가 테넌트에 해외 연동이 설정됨: ${def.id} (설계서 §10.3)`);
  }
}

/** §11.1 — 커넥터 선언이 호출 스코프 소유인지 확인한다. */
export function assertConnectorScope(def: ConnectorDef, scope: TenantScope): void {
  assertTenantScope(scope);
  const sameTenant = def.tenantId === scope.tenantId;
  const sameWorkspace = scope.workspaceId === undefined || def.workspaceId === undefined || def.workspaceId === scope.workspaceId;
  if (!sameTenant || !sameWorkspace) {
    throw new Error(`테넌트 격리 위반(connector ${def.id}): 기대=${scope.tenantId} 실제=${def.tenantId} (설계서 §11.1)`);
  }
}

/** 개인정보가 실려 나가는 파라미터 이름. 동의(§10.1) 게이트가 이 목록을 근거로 판정한다. */
export function piiParams(def: ConnectorDef): string[] {
  return def.params.filter((p) => p.pii === true).map((p) => p.name);
}

// ── 요청 조립 ─────────────────────────────────────────────────────────────────

export interface BuildContext {
  scope: TenantScope;
  interactionId: string;
  /** 재시도 시에도 같은 값을 유지해야 멱등 키의 의미가 산다. */
  idempotencyKey: string;
  attempt?: number;
}

export type BuildResult =
  | { ok: true; request: ConnectorRequest }
  | { ok: false; missing: string[] };

/**
 * 슬롯에서 요청을 조립한다.
 * 필수 슬롯이 비어 있으면 호출하지 않는다 — 빈 값으로 조회하면 업무시스템이 엉뚱한 결과를 준다.
 * 값은 마스킹하지 않는다(마스킹된 주민번호로는 조회가 안 된다). 기록 시 redactRequest 를 쓴다.
 */
export function buildRequest(def: ConnectorDef, slots: Readonly<Record<string, string>>, ctx: BuildContext): BuildResult {
  assertConnectorScope(def, ctx.scope);
  const params: Record<string, ParamValue> = {};
  const missing: string[] = [];
  for (const p of def.params) {
    const v = slots[p.fromSlot];
    if (v === undefined || v.trim() === '') {
      if (p.required) missing.push(p.fromSlot);
      continue;
    }
    params[p.name] = v;
  }
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    request: {
      connectorId: def.id,
      tenantId: def.tenantId,
      ...(def.workspaceId !== undefined ? { workspaceId: def.workspaceId } : {}),
      interactionId: ctx.interactionId,
      endpointRef: def.endpointRef,
      method: def.method,
      params,
      timeoutMs: def.timeoutMs,
      attempt: ctx.attempt ?? 1,
      idempotencyKey: ctx.idempotencyKey,
    },
  };
}

/**
 * 로그·이벤트·감사기록으로 나가는 요청 사본. pii 선언 파라미터는 값 자체를 지우고,
 * 나머지는 마스킹 규칙을 한 번 더 통과시킨다(선언 누락 대비 이중 방어, §10.3).
 */
export function redactRequest(def: ConnectorDef, request: ConnectorRequest): ConnectorRequest {
  const pii = new Set(piiParams(def));
  const params: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(request.params)) {
    if (pii.has(k)) { params[k] = '[REDACTED]'; continue; }
    params[k] = typeof v === 'string' ? maskPii(v).text : v;
  }
  return { ...request, params };
}

// ── 응답 적용 ─────────────────────────────────────────────────────────────────

export interface ApplyResult {
  /** allowlist 를 통과하고 마스킹된 슬롯. 그대로 세션에 병합해도 안전하다. */
  slots: Record<string, string>;
  /** 마스킹이 실제로 일어난 슬롯 이름 — §8.1 pii_masked 집계 근거 */
  maskedSlots: string[];
  /** 선언됐지만 응답에 없던 필드 */
  missingFields: string[];
  /** 스칼라가 아니어서 슬롯으로 담을 수 없던 필드 */
  unusableFields: string[];
  /** 선언되지 않아 버려진 응답 필드 — 스튜디오가 "매핑 빠졌다"를 알려주는 근거 */
  droppedFields: string[];
}

function toSlotValue(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;   // null·객체·배열은 슬롯이 될 수 없다 — 어댑터가 평탄화해서 올려야 한다
}

/**
 * 응답을 세션 슬롯으로 변환한다.
 * allowlist 밖의 필드는 조용히 버린다(버리는 것이 안전 기본값 — 모르는 필드에 개인정보가 실려 온다).
 * 담기는 값은 예외 없이 maskPii 를 통과한다: 슬롯은 이벤트·이력·요약으로 흘러가는 저장 경로다(§10.3).
 */
export function applyResponse(def: ConnectorDef, data: Readonly<Record<string, unknown>>): ApplyResult {
  const slots: Record<string, string> = {};
  const maskedSlots: string[] = [];
  const missingFields: string[] = [];
  const unusableFields: string[] = [];
  const mapped = new Set<string>();

  for (const o of def.outputs) {
    mapped.add(o.field);
    if (!Object.prototype.hasOwnProperty.call(data, o.field)) { missingFields.push(o.field); continue; }
    const raw = toSlotValue(data[o.field]);
    if (raw === null) { unusableFields.push(o.field); continue; }
    const m = maskPii(raw);
    slots[o.toSlot] = m.text;
    if (m.masked) maskedSlots.push(o.toSlot);
  }
  const droppedFields = Object.keys(data).filter((k) => !mapped.has(k));
  return { slots, maskedSlots, missingFields, unusableFields, droppedFields };
}

// ── 실패 판정 (§9.3) ──────────────────────────────────────────────────────────

export type FailureDecision =
  | { retry: true; nextAttempt: number }
  | { retry: false; action: ConnectorFailureAction; reason: 'not_retryable' | 'attempts_exhausted' };

/**
 * 실패 후 무엇을 할지 판정한다. 순수 함수 — 실제 재호출은 호출자가 한다.
 * 재시도 대상이 아니거나 시도 횟수를 소진하면 커넥터 선언의 onFailure 로 내린다.
 */
export function decideOnFailure(def: ConnectorDef, code: ConnectorErrorCode, attempt: number): FailureDecision {
  const maxAttempts = def.retry?.maxAttempts ?? 1;
  const retryable = def.retry?.retryOn ? def.retry.retryOn.includes(code) : TRANSIENT.has(code);
  if (!retryable) return { retry: false, action: def.onFailure, reason: 'not_retryable' };
  if (attempt >= maxAttempts) return { retry: false, action: def.onFailure, reason: 'attempts_exhausted' };
  return { retry: true, nextAttempt: attempt + 1 };
}
