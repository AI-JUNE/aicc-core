// 표준 에러 응답 + 입력 검증 — 설계서 §10.3(마스킹)·§11.1(테넌트)·§9.3(장애 인지)·품질기준 §1·§3.
//
// 왜 이 파일이 필요한가:
// API 마다 오류 모양이 다르면 세 가지가 무너진다.
//  1) 호출자(채널 3종·포털)가 분기할 수 없다 — 메시지 문자열을 정규식으로 긁게 된다.
//  2) 사용자에게 "무엇이 왜 틀렸는지"를 항목 단위로 못 보여준다(품질기준 §1: 인라인 안내).
//  3) 오류 본문에 스택·원문이 섞여 개인정보가 클라이언트로 나간다(§10.3).
// 그래서 봉투 모양을 하나로 고정하고, 만드는 경로도 하나만 둔다.
//
// 무엇을 하지 않는가:
//  - HTTP 프레임워크에 의존하지 않는다. 상태코드는 숫자로만 돌려주고 전송은 각 저장소가 한다.
//  - 스택 트레이스를 응답에 담지 않는다. 스택은 로그(obs/logger)로만 간다.
import { maskPii } from '../core/policyGuard.ts';

export type ApiErrorCode =
  | 'E_INVALID_INPUT'     // 입력 검증 실패 — 어느 항목이 왜 틀렸는지 details 에 담는다
  | 'E_UNAUTHENTICATED'   // 신원 없음
  | 'E_FORBIDDEN'         // 신원은 있으나 권한 없음(§11.1 테넌트 위반 포함)
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'          // 상태 충돌(중복 생성·이미 종료된 세션 등)
  | 'E_RATE_LIMITED'
  | 'E_APPROVAL_REQUIRED' // 승인 전 기능 호출 — [승인 필요]
  | 'E_UPSTREAM'          // 외부 엔진·업무시스템 실패(§6.1·§6.2)
  | 'E_TIMEOUT'
  | 'E_INTERNAL';

/** 코드→HTTP 상태. 저장소마다 다르게 매기지 않도록 여기 한 곳에 둔다. */
export const HTTP_STATUS: Record<ApiErrorCode, number> = {
  E_INVALID_INPUT: 400,
  E_UNAUTHENTICATED: 401,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_RATE_LIMITED: 429,
  E_APPROVAL_REQUIRED: 403,
  E_UPSTREAM: 502,
  E_TIMEOUT: 504,
  E_INTERNAL: 500,
};

/** 재시도해도 되는가. 호출자가 이 값으로 백오프 여부를 정한다 — 메시지로 추측하지 않게. */
export const RETRYABLE: Record<ApiErrorCode, boolean> = {
  E_INVALID_INPUT: false,
  E_UNAUTHENTICATED: false,
  E_FORBIDDEN: false,
  E_NOT_FOUND: false,
  E_CONFLICT: false,
  E_RATE_LIMITED: true,
  E_APPROVAL_REQUIRED: false,
  E_UPSTREAM: true,
  E_TIMEOUT: true,
  E_INTERNAL: true,
};

/** 항목 단위 문제. 화면이 이 값을 그대로 입력란 옆에 붙일 수 있어야 한다. */
export interface FieldIssue {
  /** 점 표기 경로(예: scope.tenantId). */
  field: string;
  reason: 'required' | 'type' | 'format' | 'range' | 'enum' | 'length';
  messageKo: string;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  /** 사용자에게 보여도 되는 한국어 안내. 원인 원문·스택을 넣지 않는다. */
  messageKo: string;
  /** 로그와 응답을 잇는 값. 사용자가 이 값을 알려주면 로그에서 찾는다. */
  requestId?: string;
  details?: FieldIssue[];
  retryable: boolean;
  /** E_RATE_LIMITED 등에서 언제 다시 시도할지. 추정치를 만들지 않는다 — 아는 경우만 채운다. */
  retryAfterMs?: number;
}

export interface ApiErrorResponse {
  status: number;
  body: { error: ApiErrorBody };
}

/** 던질 수 있는 형태. 상위 계층은 code 로 분기한다. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: FieldIssue[];
  readonly retryAfterMs?: number;
  constructor(code: ApiErrorCode, messageKo: string, opts: { details?: FieldIssue[]; retryAfterMs?: number } = {}) {
    super(messageKo);
    this.name = 'ApiError';
    this.code = code;
    this.details = opts.details;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

const FALLBACK_MESSAGE: Record<ApiErrorCode, string> = {
  E_INVALID_INPUT: '입력값을 확인해 주세요.',
  E_UNAUTHENTICATED: '로그인이 필요합니다.',
  E_FORBIDDEN: '이 작업을 수행할 권한이 없습니다.',
  E_NOT_FOUND: '요청한 대상을 찾을 수 없습니다.',
  E_CONFLICT: '현재 상태에서는 처리할 수 없는 요청입니다.',
  E_RATE_LIMITED: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
  E_APPROVAL_REQUIRED: '[승인 필요] 아직 활성화되지 않은 기능입니다.',
  E_UPSTREAM: '연동 시스템 응답에 문제가 있어 처리하지 못했습니다.',
  E_TIMEOUT: '처리 시간이 초과되었습니다. 다시 시도해 주세요.',
  E_INTERNAL: '처리 중 오류가 발생했습니다.',
};

export function apiError(
  code: ApiErrorCode,
  messageKo?: string,
  opts: { requestId?: string; details?: FieldIssue[]; retryAfterMs?: number } = {},
): ApiErrorResponse {
  const body: ApiErrorBody = {
    code,
    // 메시지에도 마스킹을 건다. 검증 메시지에 사용자가 넣은 값이 섞여 오는 일이 흔하다.
    messageKo: maskPii(messageKo && messageKo.trim() ? messageKo : FALLBACK_MESSAGE[code]).text,
    retryable: RETRYABLE[code],
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.details && opts.details.length > 0
      ? { details: opts.details.map((d) => ({ ...d, messageKo: maskPii(d.messageKo).text })) }
      : {}),
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
  };
  return { status: HTTP_STATUS[code], body: { error: body } };
}

/**
 * 아무 예외나 표준 봉투로 바꾼다. 알 수 없는 예외는 E_INTERNAL 로 덮되,
 * 원문 메시지를 사용자에게 돌려주지 않는다 — 내부 경로·식별자가 그대로 새는 통로가 된다.
 * 원문은 호출자가 로그로 남긴다(obs/logger).
 */
export function toErrorResponse(e: unknown, requestId?: string): ApiErrorResponse {
  if (e instanceof ApiError) {
    return apiError(e.code, e.message, { requestId, details: e.details, retryAfterMs: e.retryAfterMs });
  }
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && code in HTTP_STATUS) {
    // 하위 모듈(EngineError·ChannelPortError)이 같은 이름의 코드를 쓰는 경우만 그대로 받는다.
    return apiError(code as ApiErrorCode, undefined, { requestId });
  }
  const mapped: ApiErrorCode = code === 'E_HTTP' || code === 'E_PROTOCOL' ? 'E_UPSTREAM'
    : code === 'E_INPUT' || code === 'E_LIMIT' ? 'E_INVALID_INPUT'
    : 'E_INTERNAL';
  return apiError(mapped, undefined, { requestId });
}

// ── 입력 검증 ────────────────────────────────────────────────────────────────
// 목적은 "튕겨내기"가 아니라 "어느 항목이 왜 틀렸는지 전부 한 번에 알려주기"다.
// 첫 오류에서 멈추면 사용자가 폼을 여러 번 왕복한다.

export type FieldType = 'string' | 'number' | 'boolean';

export interface FieldRule {
  type: FieldType;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /** 허용값 목록. 벗어나면 enum 사유로 보고한다. */
  oneOf?: readonly (string | number)[];
  pattern?: RegExp;
  /** 형식 위반 시 보여줄 안내(예: "휴대폰 번호 형식이 아닙니다"). */
  formatHintKo?: string;
  /** 화면 라벨. 없으면 필드 경로를 그대로 쓴다. */
  labelKo?: string;
}

export type Schema = Record<string, FieldRule>;

export interface ValidationResult<T> {
  ok: boolean;
  issues: FieldIssue[];
  /** 검증을 통과한 값만 담긴다. ok=false 면 신뢰하지 않는다. */
  value: Partial<T>;
}

function labelOf(field: string, rule: FieldRule): string {
  return rule.labelKo ?? field;
}

/** 점 표기 경로에서 값을 꺼낸다. 중간이 객체가 아니면 undefined. */
function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function validate<T = Record<string, unknown>>(input: unknown, schema: Schema): ValidationResult<T> {
  const issues: FieldIssue[] = [];
  const value: Record<string, unknown> = {};

  for (const [field, rule] of Object.entries(schema)) {
    const raw = pick(input, field);
    const label = labelOf(field, rule);
    const missing = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (missing) {
      if (rule.required) issues.push({ field, reason: 'required', messageKo: `${label} 항목은 필수입니다.` });
      continue;
    }
    if (typeof raw !== rule.type) {
      issues.push({ field, reason: 'type', messageKo: `${label} 항목의 형식이 올바르지 않습니다.` });
      continue;
    }
    if (rule.type === 'string') {
      const s = raw as string;
      if (rule.minLength !== undefined && s.length < rule.minLength) {
        issues.push({ field, reason: 'length', messageKo: `${label} 항목은 ${rule.minLength}자 이상이어야 합니다.` });
        continue;
      }
      if (rule.maxLength !== undefined && s.length > rule.maxLength) {
        issues.push({ field, reason: 'length', messageKo: `${label} 항목은 ${rule.maxLength}자 이하여야 합니다.` });
        continue;
      }
      if (rule.pattern && !rule.pattern.test(s)) {
        issues.push({ field, reason: 'format', messageKo: rule.formatHintKo ?? `${label} 항목의 형식이 올바르지 않습니다.` });
        continue;
      }
    }
    if (rule.type === 'number') {
      const n = raw as number;
      if (!Number.isFinite(n)) {
        issues.push({ field, reason: 'type', messageKo: `${label} 항목은 숫자여야 합니다.` });
        continue;
      }
      if (rule.min !== undefined && n < rule.min) {
        issues.push({ field, reason: 'range', messageKo: `${label} 항목은 ${rule.min} 이상이어야 합니다.` });
        continue;
      }
      if (rule.max !== undefined && n > rule.max) {
        issues.push({ field, reason: 'range', messageKo: `${label} 항목은 ${rule.max} 이하여야 합니다.` });
        continue;
      }
    }
    if (rule.oneOf && !rule.oneOf.includes(raw as string | number)) {
      issues.push({ field, reason: 'enum', messageKo: `${label} 항목에 허용되지 않은 값입니다.` });
      continue;
    }
    value[field] = raw;
  }
  return { ok: issues.length === 0, issues, value: value as Partial<T> };
}

/** 검증 실패를 그대로 표준 응답으로. 통과면 undefined 를 돌려준다. */
export function validationResponse(result: ValidationResult<unknown>, requestId?: string): ApiErrorResponse | undefined {
  if (result.ok) return undefined;
  return apiError('E_INVALID_INPUT', '입력값을 확인해 주세요.', { requestId, details: result.issues });
}
