// 동의 관리 — 설계서 §10.1(고지·동의)·§10.3(개인정보)·§11.1(테넌트).
//
// AI 고지 문구(src/portal/aiDisclosure.ts)가 "무엇을 말하는가"라면, 여기는 "말한 뒤 무엇을 얻었는가"다.
// 고지는 일방 통보이고 동의는 상태다. 이 둘을 한 모듈에 섞으면, 문구는 있는데 동의 근거가 없는
// — 개인정보위 지적에서 가장 자주 나오는 — 상태를 코드가 구분하지 못한다.
//
// 규약 4줄 요약
//  1) 동의는 목적(purpose)별로 따로 관리한다. "다 동의하셨죠"는 동의가 아니다.
//  2) 기록은 append-only 다. 철회는 기존 기록을 지우지 않고 withdrawn 기록을 덧붙인다(§8.2 파기와 별개).
//  3) 동의 주체 식별자는 원문 개인정보를 담지 않는다. 해시·토큰 참조만 받는다(§10.3).
//  4) 필수 목적 미획득이면 해당 행위를 판정 단계에서 막는다. 판정만 하고 실행은 호출자가 한다.
//
// 목적별 법적 근거·문구·보유기간은 테넌트 법무 검토 사항이다. 표준값을 코드에 박지 않는다 — [승인 필요].
import { maskPii } from '../core/policyGuard.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';

export type ConsentPurpose =
  | 'personal_data_collection'   // 개인정보 수집·이용
  | 'recording'                  // 통화·대화 녹취
  | 'ai_processing'              // AI 자동 응대 처리
  | 'third_party_share'          // 제3자 제공
  | 'overseas_transfer'          // 국외 이전 (§10.3)
  | 'marketing';                 // 마케팅 활용

export type ConsentState = 'granted' | 'denied' | 'withdrawn' | 'expired' | 'not_asked';

/** 동의를 요구하는 Core 행위. 목적을 직접 다루지 않고 행위로 묻게 해서 매핑 누락을 줄인다. */
export type GatedAction =
  | 'record_call'              // 녹취 시작
  | 'store_personal_data'      // 슬롯·이력에 개인정보 저장
  | 'call_backend_with_pii'    // 개인정보를 실어 업무시스템 조회(§6.1)
  | 'transfer_overseas'        // 해외 엔진·시스템으로 전송(§10.3)
  | 'ai_respond'               // AI 자동 응대
  | 'share_with_third_party'
  | 'marketing_followup';

export const ACTION_PURPOSES: Record<GatedAction, ConsentPurpose[]> = {
  record_call: ['recording'],
  store_personal_data: ['personal_data_collection'],
  call_backend_with_pii: ['personal_data_collection'],
  transfer_overseas: ['personal_data_collection', 'overseas_transfer'],
  ai_respond: ['ai_processing'],
  share_with_third_party: ['third_party_share'],
  marketing_followup: ['marketing'],
};

export interface ConsentRequirement {
  purpose: ConsentPurpose;
  /** 필수 동의 여부. 필수 목적을 얻지 못하면 해당 행위를 차단한다. */
  required: boolean;
  /** 고지 문구 참조 키. 문구 원문은 테넌트 문구 저장소에 둔다(§7 7.4와 동일 원칙). */
  noticeRef?: string;
  /** 동의 유효기간(일). 미지정이면 만료를 판정하지 않는다 — 임의 기본값을 넣지 않는다(§13-3). */
  validForDays?: number;
}

export interface ConsentPolicy {
  tenantId: string;
  workspaceId?: string;
  requirements: ConsentRequirement[];
  version: number;
  updatedAt: string;
  updatedBy: string;
  /** 법무·컴플라이언스 승인. 미승인 정책으로는 동의를 받을 수 없다. */
  approved: boolean;
}

export interface ConsentRecord {
  tenantId: string;
  workspaceId?: string;
  /** 동의 주체 참조. 전화번호·주민번호 원문 금지 — 해시·고객키만(§10.3). */
  subjectRef: string;
  purpose: ConsentPurpose;
  /** 기록 시점의 상태. 'expired' 는 기록하지 않는다 — 만료는 조회 시점에 계산된다. */
  state: 'granted' | 'denied' | 'withdrawn';
  at: string;                 // ISO8601
  /** 동의를 받은 채널·경로 (voice/visual/chat/web 등 자유 문자열) */
  via: string;
  interactionId?: string;
  /** 정책 버전 — 어떤 문구로 받은 동의인지 추적한다 */
  policyVersion: number;
  /** 녹취 구간·서명 등 증빙 참조 키. 증빙 원문을 여기에 담지 않는다. */
  evidenceRef?: string;
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

export type ConsentIssueCode =
  | 'E_TENANT_INVALID'
  | 'E_NOT_APPROVED'
  | 'E_VERSION_INVALID'
  | 'E_DUPLICATE_PURPOSE'
  | 'E_VALIDITY_INVALID'
  | 'W_NO_REQUIREMENT'
  | 'W_MARKETING_REQUIRED';

export interface ConsentIssue {
  code: ConsentIssueCode;
  severity: 'error' | 'warning';
  messageKo: string;
  purpose?: ConsentPurpose;
}

export function validateConsentPolicy(policy: ConsentPolicy): ConsentIssue[] {
  const issues: ConsentIssue[] = [];
  const err = (code: ConsentIssueCode, messageKo: string, purpose?: ConsentPurpose) =>
    issues.push({ code, severity: 'error', messageKo, ...(purpose !== undefined ? { purpose } : {}) });

  if (typeof policy.tenantId !== 'string' || policy.tenantId.trim() === '') {
    err('E_TENANT_INVALID', 'tenant_id 없는 동의 정책은 허용되지 않습니다(§11.1).');
  }
  if (!policy.approved) {
    err('E_NOT_APPROVED', '법무·컴플라이언스 미승인 동의 정책입니다. 승인 전에는 동의를 수집할 수 없습니다.');
  }
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    err('E_VERSION_INVALID', 'policy version 은 1 이상의 정수여야 합니다.');
  }

  const seen = new Set<ConsentPurpose>();
  for (const r of policy.requirements) {
    if (seen.has(r.purpose)) err('E_DUPLICATE_PURPOSE', `중복 선언된 동의 목적: ${r.purpose}`, r.purpose);
    seen.add(r.purpose);
    if (r.validForDays !== undefined && (!Number.isInteger(r.validForDays) || r.validForDays < 1)) {
      err('E_VALIDITY_INVALID', `validForDays 는 1 이상의 정수여야 합니다: ${r.purpose}`, r.purpose);
    }
    // 마케팅 동의를 필수로 묶는 것은 '동의 강제'로 지적받는 대표 유형이다. 차단은 하지 않고 드러낸다.
    if (r.purpose === 'marketing' && r.required) {
      issues.push({
        code: 'W_MARKETING_REQUIRED', severity: 'warning', purpose: 'marketing',
        messageKo: '마케팅 동의가 필수로 설정돼 있습니다. 서비스 제공의 조건으로 마케팅 동의를 요구하는지 법무 확인이 필요합니다.',
      });
    }
  }
  if (policy.requirements.length === 0) {
    issues.push({ code: 'W_NO_REQUIREMENT', severity: 'warning', messageKo: '동의 목적이 하나도 선언되지 않았습니다.' });
  }
  return issues;
}

export function consentPolicyOk(issues: ConsentIssue[]): boolean {
  return issues.every((i) => i.severity !== 'error');
}

/** §10.3 — 동의 주체 참조에 원문 개인정보가 섞여 들어오는 것을 입구에서 막는다. */
export function assertSubjectRef(subjectRef: string): void {
  if (typeof subjectRef !== 'string' || subjectRef.trim() === '') {
    throw new Error('subjectRef 가 비어 있습니다 (설계서 §10.1)');
  }
  const m = maskPii(subjectRef);
  if (m.masked) {
    throw new Error(`subjectRef 에 개인정보 원문이 포함됐습니다(${m.hits.join(', ')}). 해시·고객키만 사용합니다 (설계서 §10.3)`);
  }
}

// ── 상태 판정 ────────────────────────────────────────────────────────────────

function addDays(iso: string, days: number): number {
  return Date.parse(iso) + days * 86_400_000;
}

/**
 * 목적별 현재 상태. 같은 목적의 기록이 여러 건이면 가장 최근 기록이 이긴다
 * (동의 → 철회 → 재동의 순서가 그대로 반영된다).
 */
export function currentState(
  policy: ConsentPolicy,
  records: readonly ConsentRecord[],
  purpose: ConsentPurpose,
  subjectRef: string,
  now: string,
): ConsentState {
  const mine = records
    .filter((r) => r.subjectRef === subjectRef && r.purpose === purpose && r.tenantId === policy.tenantId)
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = mine[mine.length - 1];
  if (!last) return 'not_asked';
  if (last.state !== 'granted') return last.state;

  const req = policy.requirements.find((r) => r.purpose === purpose);
  if (req?.validForDays !== undefined && Date.parse(now) >= addDays(last.at, req.validForDays)) return 'expired';
  return 'granted';
}

export interface ConsentEvaluation {
  purpose: ConsentPurpose;
  state: ConsentState;
  required: boolean;
  /** 정책에 선언되지 않은 목적을 물었을 때 — 정책 누락 신호 */
  declared: boolean;
}

export function evaluateConsents(
  policy: ConsentPolicy,
  records: readonly ConsentRecord[],
  purposes: readonly ConsentPurpose[],
  subjectRef: string,
  now: string,
): ConsentEvaluation[] {
  return purposes.map((p) => {
    const req = policy.requirements.find((r) => r.purpose === p);
    return {
      purpose: p,
      state: currentState(policy, records, p, subjectRef, now),
      required: req?.required ?? false,
      declared: req !== undefined,
    };
  });
}

export type GateDecision =
  | { allow: true; purposes: ConsentPurpose[] }
  | { allow: false; blockedBy: ConsentEvaluation[]; reason: 'policy_not_approved' | 'consent_missing' };

/**
 * 행위 게이트. 필수 목적이 granted 가 아니면 막는다.
 * 선택 목적은 막지 않는다 — 대신 평가 결과를 그대로 돌려주어 호출자가 축소 실행을 선택할 수 있게 한다.
 * 정책에 선언되지 않은 필수 목적은 "동의 없음"으로 본다(선언 누락을 통과로 처리하지 않는다).
 */
export function gateAction(
  policy: ConsentPolicy,
  records: readonly ConsentRecord[],
  action: GatedAction,
  subjectRef: string,
  now: string,
  scope?: TenantScope,
): GateDecision {
  if (scope) {
    assertTenantScope(scope);
    if (policy.tenantId !== scope.tenantId) {
      throw new Error(`테넌트 격리 위반(consent): 기대=${scope.tenantId} 실제=${policy.tenantId} (설계서 §11.1)`);
    }
  }
  assertSubjectRef(subjectRef);
  const purposes = ACTION_PURPOSES[action];
  const evals = evaluateConsents(policy, records, purposes, subjectRef, now);
  if (!policy.approved) return { allow: false, blockedBy: evals, reason: 'policy_not_approved' };

  const blocked = evals.filter((e) => {
    if (!e.declared) return true;          // 선언 누락 = 근거 없음
    return e.required && e.state !== 'granted';
  });
  if (blocked.length > 0) return { allow: false, blockedBy: blocked, reason: 'consent_missing' };
  return { allow: true, purposes: [...purposes] };
}

// ── 기록 생성 (append-only) ───────────────────────────────────────────────────

export interface RecordInput {
  subjectRef: string;
  purpose: ConsentPurpose;
  via: string;
  at: string;
  interactionId?: string;
  evidenceRef?: string;
}

function newRecord(policy: ConsentPolicy, input: RecordInput, state: ConsentRecord['state']): ConsentRecord {
  assertSubjectRef(input.subjectRef);
  if (!policy.approved) {
    throw new Error('미승인 동의 정책으로는 동의를 기록할 수 없습니다 (설계서 §10.1)');
  }
  return {
    tenantId: policy.tenantId,
    ...(policy.workspaceId !== undefined ? { workspaceId: policy.workspaceId } : {}),
    subjectRef: input.subjectRef,
    purpose: input.purpose,
    state,
    at: input.at,
    via: input.via,
    ...(input.interactionId !== undefined ? { interactionId: input.interactionId } : {}),
    policyVersion: policy.version,
    ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
  };
}

export function grant(policy: ConsentPolicy, input: RecordInput): ConsentRecord {
  return newRecord(policy, input, 'granted');
}

export function deny(policy: ConsentPolicy, input: RecordInput): ConsentRecord {
  return newRecord(policy, input, 'denied');
}

/** 철회는 삭제가 아니다 — 기존 기록을 남긴 채 철회 기록을 덧붙인다(§10.1 입증 책임). */
export function withdraw(policy: ConsentPolicy, input: RecordInput): ConsentRecord {
  return newRecord(policy, input, 'withdrawn');
}

/** 기록 추가. 원본 배열을 변형하지 않는다. */
export function appendRecord(records: readonly ConsentRecord[], record: ConsentRecord): ConsentRecord[] {
  return [...records, record];
}
