// 보존·파기 정책 — 설계서 §8.2.
// 개인정보는 "지우는 절차가 있다"가 아니라 "기한이 되면 자동으로 지워진다"여야 한다.
// 여기서는 판정만 한다(순수 함수). 실제 삭제 실행은 승인 후 별도 워커가 맡는다 — [승인 필요].
//
// 보존기간(일수)은 테넌트별 법적 검토 결과로만 채운다. 임의 기본값을 코드에 박지 않는다(§13-3).
import { assertTenantScope, type TenantScope } from './tenancy.ts';

export const DAY_MS = 86_400_000;

/** §8.2 보존 대상 데이터 분류. 분류가 곧 파기 단위다. */
export type DataClass =
  | 'interaction_event'   // §8.1 이벤트(마스킹 완료)
  | 'transcript_masked'   // 마스킹된 대화 전문
  | 'recording'           // 음성 녹취 원본
  | 'pii_field'           // 수집 슬롯 중 개인정보 항목
  | 'consent_record'      // 동의 이력
  | 'audit_log'           // 접근·변경 감사로그
  | 'vector_index'        // RAG 색인(§11.1 네임스페이스 단위)
  | 'aggregate_metric';   // 식별성 제거된 집계 지표

export type Disposition = 'delete' | 'anonymize' | 'archive';

export interface DataClassSpec {
  id: DataClass;
  titleKo: string;
  /** 개인정보를 포함할 수 있는가 — true면 보존기간 미설정 시 저장 자체를 막는다. */
  mayContainPii: boolean;
  /** 파기 시 기본 처리 방식(기간은 여기에 두지 않는다). */
  disposition: Disposition;
}

export const DATA_CLASSES: readonly DataClassSpec[] = [
  { id: 'interaction_event', titleKo: '상호작용 이벤트', mayContainPii: false, disposition: 'delete' },
  { id: 'transcript_masked', titleKo: '대화 전문(마스킹)', mayContainPii: false, disposition: 'delete' },
  { id: 'recording', titleKo: '음성 녹취', mayContainPii: true, disposition: 'delete' },
  { id: 'pii_field', titleKo: '개인정보 수집 항목', mayContainPii: true, disposition: 'delete' },
  { id: 'consent_record', titleKo: '동의 이력', mayContainPii: true, disposition: 'archive' },
  { id: 'audit_log', titleKo: '감사로그', mayContainPii: false, disposition: 'archive' },
  { id: 'vector_index', titleKo: 'RAG 색인', mayContainPii: false, disposition: 'delete' },
  { id: 'aggregate_metric', titleKo: '집계 지표', mayContainPii: false, disposition: 'anonymize' },
];

export function dataClassSpec(id: DataClass): DataClassSpec {
  const s = DATA_CLASSES.find((d) => d.id === id);
  if (!s) throw new Error(`알 수 없는 데이터 분류: ${id} (설계서 §8.2)`);
  return s;
}

export interface RetentionRule {
  dataClass: DataClass;
  /** 보존기간(일). 테넌트 법적 검토로 확정된 값만 넣는다. */
  retentionDays: number;
  disposition: Disposition;
  /** 근거(법령·계약 조항). 빈 값이면 정책 검증에서 막힌다. */
  basisKo: string;
  /** 법무·개인정보 담당 승인 여부. false면 자동 파기를 실행하지 않는다. */
  approved: boolean;
}

export interface RetentionPolicy {
  tenantId: string;
  workspaceId?: string;
  rules: RetentionRule[];
}

export interface RetainedRecord {
  id: string;
  tenantId: string;
  workspaceId?: string;
  dataClass: DataClass;
  /** 보존기간 기산 시점(ISO8601). 통상 수집 시각. */
  createdAt: string;
  /** 분쟁·수사 등으로 파기 보류된 건 — 기한이 지나도 건드리지 않는다. */
  legalHold?: boolean;
  /** 이미 파기·비식별 처리된 건 */
  disposedAt?: string;
}

// ── 검증 ───────────────────────────────────────────────────────────────────────

/** 정책 오류 목록을 돌려준다(빈 배열이면 통과). 예외 대신 목록 — 설정 화면에서 한 번에 보여주기 위함. */
export function validateRetentionPolicy(policy: RetentionPolicy): string[] {
  const errors: string[] = [];
  if (!policy.tenantId) errors.push('tenant_id 누락 (§11.1)');

  const seen = new Set<DataClass>();
  for (const r of policy.rules) {
    let spec: DataClassSpec;
    try {
      spec = dataClassSpec(r.dataClass);
    } catch {
      errors.push(`알 수 없는 데이터 분류: ${r.dataClass}`);
      continue;
    }
    if (seen.has(r.dataClass)) errors.push(`분류 중복: ${r.dataClass}`);
    seen.add(r.dataClass);

    if (!Number.isInteger(r.retentionDays) || r.retentionDays <= 0) {
      errors.push(`${r.dataClass}: 보존기간은 1일 이상의 정수여야 한다`);
    }
    if (!r.basisKo.trim()) errors.push(`${r.dataClass}: 보존 근거가 비어 있다 (§8.2)`);
    if (spec.mayContainPii && !r.approved) {
      errors.push(`${r.dataClass}: 개인정보 포함 분류는 승인 전 자동 파기를 실행할 수 없다 [승인 필요]`);
    }
  }

  for (const spec of DATA_CLASSES) {
    if (spec.mayContainPii && !seen.has(spec.id)) {
      errors.push(`${spec.id}: 개인정보 포함 분류에 보존 규칙이 없다 — 저장 금지 (§8.2)`);
    }
  }
  return errors;
}

export function ruleFor(policy: RetentionPolicy, dataClass: DataClass): RetentionRule | undefined {
  return policy.rules.find((r) => r.dataClass === dataClass);
}

// ── 만료 판정(순수 함수) ────────────────────────────────────────────────────────

/** 기산 시각 + 보존기간. 잘못된 날짜는 조용히 넘기지 않는다. */
export function expiresAt(createdAt: string, retentionDays: number): string {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) throw new Error(`기산 시각을 해석할 수 없다: ${JSON.stringify(createdAt)}`);
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(`보존기간이 유효하지 않다: ${retentionDays}`);
  }
  return new Date(t + retentionDays * DAY_MS).toISOString();
}

export type RetentionStatus =
  | 'retained'      // 보존 기간 내
  | 'due'           // 기한 경과 — 파기 대상
  | 'held'          // 기한 경과했으나 법적 보류
  | 'disposed'      // 이미 처리됨
  | 'blocked';      // 규칙 없음 또는 미승인 — 실행 불가

export interface RetentionDecision {
  recordId: string;
  dataClass: DataClass;
  status: RetentionStatus;
  expiresAt?: string;
  disposition?: Disposition;
  reasonKo: string;
}

/** 레코드 1건의 처리 판정. now를 주입받아 시간 의존성을 제거한다. */
export function decide(record: RetainedRecord, policy: RetentionPolicy, nowIso: string): RetentionDecision {
  const base = { recordId: record.id, dataClass: record.dataClass };
  if (record.disposedAt) {
    return { ...base, status: 'disposed', reasonKo: `이미 처리됨(${record.disposedAt})` };
  }
  const rule = ruleFor(policy, record.dataClass);
  if (!rule) {
    return { ...base, status: 'blocked', reasonKo: `보존 규칙 미정의: ${record.dataClass} (§8.2)` };
  }
  if (!rule.approved) {
    return { ...base, status: 'blocked', reasonKo: `보존 규칙 미승인 — 자동 파기 보류 [승인 필요]` };
  }

  const exp = expiresAt(record.createdAt, rule.retentionDays);
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) throw new Error(`현재 시각을 해석할 수 없다: ${JSON.stringify(nowIso)}`);

  if (Date.parse(exp) > now) {
    return { ...base, status: 'retained', expiresAt: exp, reasonKo: `보존기간 ${rule.retentionDays}일 내` };
  }
  if (record.legalHold) {
    return { ...base, status: 'held', expiresAt: exp, reasonKo: '기한 경과했으나 법적 보류 중' };
  }
  return {
    ...base,
    status: 'due',
    expiresAt: exp,
    disposition: rule.disposition,
    reasonKo: `보존기간 ${rule.retentionDays}일 경과 — ${rule.disposition}`,
  };
}

export interface DispositionPlan {
  tenantId: string;
  generatedAt: string;
  decisions: RetentionDecision[];
  /** 즉시 실행 대상 */
  due: RetentionDecision[];
  /** 규칙 미정의·미승인으로 실행할 수 없는 건 — 운영에서 반드시 해소해야 한다 */
  blocked: RetentionDecision[];
  held: RetentionDecision[];
}

/**
 * 파기 계획 산출. 계획만 만들고 실행하지 않는다("build now, activate on approval").
 * 다른 테넌트의 레코드가 섞여 들어오면 §11.1 위반으로 즉시 실패한다.
 */
export function planDisposition(
  records: readonly RetainedRecord[],
  policy: RetentionPolicy,
  nowIso: string,
): DispositionPlan {
  const scope: TenantScope = policy.workspaceId !== undefined
    ? { tenantId: policy.tenantId, workspaceId: policy.workspaceId }
    : { tenantId: policy.tenantId };
  assertTenantScope(scope);
  for (const r of records) {
    if (r.tenantId !== policy.tenantId) {
      throw new Error(`파기 계획에 타 테넌트 레코드 포함: ${r.id} (설계서 §11.1)`);
    }
  }
  const decisions = records.map((r) => decide(r, policy, nowIso));
  return {
    tenantId: policy.tenantId,
    generatedAt: nowIso,
    decisions,
    due: decisions.filter((d) => d.status === 'due'),
    blocked: decisions.filter((d) => d.status === 'blocked'),
    held: decisions.filter((d) => d.status === 'held'),
  };
}
