// 파트너(채널) 귀속 — 설계서 §11.1(테넌트 격리)·§10.3(마스킹)·§13-3(실측만).
//
// 배경: 계약·서비스 주체는 고원, 파트너(제이투모로우원)는 영업·운영을 맡고 수익을 나눈다.
// 향후 리셀러(파트너 명의 계약)로 바뀔 수 있으므로 지금은 **2계층으로 넓힐 수 있는 형태**로만 연다.
//
// 이 파일이 푸는 문제는 하나다: **정산 분쟁**.
// "이 고객사가 우리를 통해 들어왔다"는 주장이 나중에 나오면, 그때는 증명할 방법이 없다.
// 그래서 귀속은 사후 판단이 아니라 **기록 시점에 확정**되어야 하고, 바뀌었다면 언제·왜 바뀌었는지가
// 남아야 한다. 여기서 이력을 추가 전용(append-only)으로 두는 이유가 그것이다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 수수료율을 코드에 두지 않는다. 계약서에서 오는 설정값이며 하드코딩은 §13-3 위반이다.
//  - 실제 청구·정산·송금을 하지 않는다. 산출 근거만 만든다 — 실행은 **[승인 필요]**.
//  - 담당자 연락처 원문을 저장하지 않는다. 저장 경로는 전부 maskPii 를 거친다(§10.3).
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope, isValidId, scopedFilter } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';

/** 유입 경로. "어떻게 들어왔는가"는 정산 분쟁에서 가장 먼저 다투는 지점이다. */
export type AcquisitionChannel =
  | 'partner_referral'   // 파트너가 소개
  | 'partner_managed'    // 파트너가 영업부터 운영까지 수행
  | 'direct'             // 고원 직접 계약
  | 'inbound'            // 고객이 먼저 문의
  | 'unknown';           // 확정 전. 정산 대상에서 제외된다.

export type PartnerRole = 'referrer' | 'operator' | 'reseller';

export interface PartnerRef {
  /** 파트너 식별자. null 이면 직접 계약이다 — "없음"을 빈 문자열로 표현하지 않는다. */
  partnerId: string | null;
  role?: PartnerRole;
}

/** 귀속 기록 1건. 추가 전용이며 수정하지 않는다 — 바뀌면 새 기록을 쌓는다. */
export interface AttributionRecord {
  tenantId: string;
  workspaceId?: string;
  /** 귀속 대상 고객사(계약 단위). */
  accountId: string;
  partnerId: string | null;
  role?: PartnerRole;
  acquisition: AcquisitionChannel;
  /** 계약일(ISO date, YYYY-MM-DD). 시계를 주입받지 않으면 만들어 넣지 않는다(§13-3). */
  contractDate?: string;
  /** 파트너 담당자 표기. maskPii 를 거친 값만 담긴다(§10.3). */
  ownerMasked?: string;
  /** 근거 문서·메일 식별자 등. 원문이 아니라 참조만 남긴다. */
  evidenceRef?: string;
  /** 기록 시각(ISO). clock 주입이 있을 때만 채운다. */
  recordedAt?: string;
  /** 이전 귀속에서 바뀐 경우의 사유. 마스킹을 거친다. */
  changeReasonMasked?: string;
}

export type AttributionIssueCode =
  | 'E_SCOPE'            // 테넌트 스코프 위반
  | 'E_ACCOUNT'          // 고객사 식별자 형식
  | 'E_PARTNER'          // 파트너 식별자 형식
  | 'E_ACQUISITION'      // 유입 경로와 파트너 유무가 어긋남
  | 'E_DATE'             // 계약일 형식
  | 'E_PII';             // 마스킹 미경유 값

export interface AttributionIssue {
  code: AttributionIssueCode;
  severity: 'error' | 'warning';
  messageKo: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 마스킹을 거치지 않은 값이 들어오는 것을 저장 전에 잡는다(§10.3). */
function unmasked(text: string | undefined): boolean {
  if (text === undefined) return false;
  return maskPii(text).text !== text;
}

export interface AttributionInput {
  accountId: string;
  partner: PartnerRef;
  acquisition: AcquisitionChannel;
  contractDate?: string;
  /** 원문을 그대로 받아 여기서 마스킹한다. 호출자가 잊는 쪽이 사고다. */
  owner?: string;
  evidenceRef?: string;
  changeReason?: string;
}

export interface AttributionOptions {
  /** 시각 주입. 없으면 recordedAt 을 만들어 넣지 않는다(§13-3). */
  clock?: () => number;
}

/**
 * 입력 검증. 던지지 않고 항목 단위로 돌려준다 —
 * 정산 근거 화면은 "무엇이 왜 틀렸는지"를 인라인으로 보여줘야 한다.
 */
export function validateAttribution(scope: TenantScope, input: AttributionInput): AttributionIssue[] {
  const issues: AttributionIssue[] = [];
  try {
    assertTenantScope(scope);
  } catch (e) {
    issues.push({ code: 'E_SCOPE', severity: 'error', messageKo: e instanceof Error ? e.message : String(e) });
  }

  if (typeof input.accountId !== 'string' || !isValidId(input.accountId)) {
    issues.push({ code: 'E_ACCOUNT', severity: 'error', messageKo: '고객사 식별자 형식이 올바르지 않습니다(소문자·숫자·-·_, 2~63자).' });
  }

  const pid = input.partner?.partnerId ?? null;
  if (pid !== null && !isValidId(pid)) {
    issues.push({ code: 'E_PARTNER', severity: 'error', messageKo: '파트너 식별자 형식이 올바르지 않습니다. 직접 계약이면 null 로 두세요.' });
  }

  // 유입 경로와 파트너 유무는 반드시 맞아야 한다. 여기가 어긋난 채 쌓이면 정산 때 전부 다시 봐야 한다.
  if (pid === null && (input.acquisition === 'partner_referral' || input.acquisition === 'partner_managed')) {
    issues.push({ code: 'E_ACQUISITION', severity: 'error', messageKo: '파트너 유입으로 표시했지만 파트너가 지정되지 않았습니다.' });
  }
  if (pid !== null && input.acquisition === 'direct') {
    issues.push({ code: 'E_ACQUISITION', severity: 'error', messageKo: '직접 계약으로 표시했지만 파트너가 지정되어 있습니다.' });
  }
  if (input.acquisition === 'unknown') {
    issues.push({ code: 'E_ACQUISITION', severity: 'warning', messageKo: '유입 경로가 확정되지 않았습니다. 이 기록은 정산 집계에서 제외됩니다.' });
  }

  if (input.contractDate !== undefined && !isRealDate(input.contractDate)) {
    issues.push({ code: 'E_DATE', severity: 'error', messageKo: '계약일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.' });
  }
  if (input.evidenceRef !== undefined && unmasked(input.evidenceRef)) {
    issues.push({ code: 'E_PII', severity: 'error', messageKo: '근거 참조에 개인정보가 섞여 있습니다. 식별자만 남기세요(§10.3).' });
  }
  return issues;
}

export function attributionOk(issues: readonly AttributionIssue[]): boolean {
  return issues.every((i) => i.severity !== 'error');
}

/**
 * 검증을 통과한 입력을 저장 가능한 기록으로 바꾼다.
 * 마스킹은 여기서 **한 번만** 수행한다 — 호출자마다 하면 언젠가 한 곳이 빠진다(§10.3).
 */
export function buildAttribution(
  scope: TenantScope,
  input: AttributionInput,
  opts: AttributionOptions = {},
): { record?: AttributionRecord; issues: AttributionIssue[] } {
  const issues = validateAttribution(scope, input);
  if (!attributionOk(issues)) return { issues };

  const record: AttributionRecord = {
    tenantId: scope.tenantId,
    ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
    accountId: input.accountId,
    partnerId: input.partner.partnerId ?? null,
    ...(input.partner.role !== undefined ? { role: input.partner.role } : {}),
    acquisition: input.acquisition,
    ...(input.contractDate !== undefined ? { contractDate: input.contractDate } : {}),
    ...(input.owner !== undefined ? { ownerMasked: maskPii(input.owner).text } : {}),
    ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
    ...(input.changeReason !== undefined ? { changeReasonMasked: maskPii(input.changeReason).text } : {}),
    ...(opts.clock ? { recordedAt: new Date(opts.clock()).toISOString() } : {}),
  };
  return { record, issues };
}

// ── 조회 ─────────────────────────────────────────────────────────────────────

/**
 * 파트너 필터를 포함한 조회 조건. 테넌트 파티션은 tenancy.scopedFilter 가 강제 주입한다(§11.1).
 *
 * `partnerId: null` 은 "직접 계약만"이라는 **뜻이 있는 값**이고, 필드를 아예 넣지 않는 것은
 * "파트너로 거르지 않음"이다. 이 둘을 undefined 하나로 섞으면 파트너 담당자에게 전체 고객사가
 * 보이는 사고가 난다. 그래서 타입에서 갈라 둔다.
 */
export interface AttributionQuery {
  /** 지정하면 그 파트너 것만. null 이면 직접 계약만. 생략하면 전체(고원 내부 조회). */
  partnerId?: string | null;
  accountId?: string;
  acquisition?: AcquisitionChannel;
}

export type ScopedAttributionFilter = AttributionQuery & { tenantId: string; workspaceId?: string };

/**
 * 조회 조건을 만든다. 호출자가 테넌트 조건을 덮어쓸 수 없다.
 * 지금은 파트너 필터를 선택으로 두지만, 리셀러(2계층)로 가면 이 함수 한 곳만 바꾸면 된다 —
 * 조회 경로가 여기로 모여 있기 때문이다.
 */
export function partnerScopedFilter(scope: TenantScope, query: AttributionQuery = {}): ScopedAttributionFilter {
  const base: AttributionQuery = {};
  if ('partnerId' in query) base.partnerId = query.partnerId ?? null;
  if (query.accountId !== undefined) base.accountId = query.accountId;
  if (query.acquisition !== undefined) base.acquisition = query.acquisition;
  return scopedFilter(scope, base as Record<string, unknown>) as ScopedAttributionFilter;
}

/**
 * 파트너 담당자에게 보여줄 목록으로 거른다.
 * `viewerPartnerId` 가 null 이면 고원 내부 조회이므로 거르지 않는다.
 * 이 함수는 **저장소 조건과 별개로** 한 번 더 거른다 — 조건 누락이 곧 유출이기 때문이다(§11.1 취지).
 */
export function visibleToPartner(
  records: readonly AttributionRecord[],
  scope: TenantScope,
  viewerPartnerId: string | null,
): AttributionRecord[] {
  assertTenantScope(scope);
  return records.filter((r) => {
    if (r.tenantId !== scope.tenantId) return false;
    if (scope.workspaceId !== undefined && r.workspaceId !== undefined && r.workspaceId !== scope.workspaceId) return false;
    if (viewerPartnerId === null) return true;
    return r.partnerId === viewerPartnerId;
  });
}

// ── 이력 ─────────────────────────────────────────────────────────────────────

/**
 * 같은 고객사의 귀속 이력에서 **현재 유효한 귀속**을 고른다.
 * 규칙: 계약일이 늦은 것 → 같으면 나중에 기록된 것. 둘 다 없으면 배열의 마지막.
 * 이 순서를 함수 하나에 가둬 두는 이유는, 화면마다 다르게 고르면 정산 금액이 화면마다 달라지기 때문이다.
 */
export function currentAttribution(history: readonly AttributionRecord[], accountId: string): AttributionRecord | undefined {
  const rows = history.filter((r) => r.accountId === accountId);
  if (rows.length === 0) return undefined;
  let best = rows[0];
  for (const r of rows.slice(1)) {
    const a = `${r.contractDate ?? ''}|${r.recordedAt ?? ''}`;
    const b = `${best.contractDate ?? ''}|${best.recordedAt ?? ''}`;
    if (a >= b) best = r;
  }
  return best;
}

export interface AttributionConflict {
  accountId: string;
  /** 서로 다른 파트너로 기록된 값들. 정산 전에 사람이 확정해야 한다. */
  partnerIds: (string | null)[];
}

/**
 * 같은 고객사에 서로 다른 파트너가 기록된 경우를 찾는다.
 * 자동으로 고르지 않는다 — 정산 분쟁의 본체이므로 사람이 확정해야 한다 **[승인 필요]**.
 */
export function findAttributionConflicts(history: readonly AttributionRecord[]): AttributionConflict[] {
  const byAccount = new Map<string, Set<string | null>>();
  for (const r of history) {
    const set = byAccount.get(r.accountId) ?? new Set<string | null>();
    set.add(r.partnerId);
    byAccount.set(r.accountId, set);
  }
  const out: AttributionConflict[] = [];
  for (const [accountId, set] of byAccount) {
    if (set.size > 1) out.push({ accountId, partnerIds: [...set].sort((a, b) => String(a).localeCompare(String(b))) });
  }
  return out.sort((a, b) => a.accountId.localeCompare(b.accountId));
}

// ── 정산 근거 ────────────────────────────────────────────────────────────────

/** 파트너별 집계. 금액이 아니라 **건수와 근거**만 낸다 — 수수료 계산은 계약값이 확정된 뒤다. */
export interface PartnerRollupRow {
  partnerId: string | null;
  accountIds: string[];
  /** 유입 경로별 건수. 어떤 근거로 묶였는지 그대로 보인다. */
  byAcquisition: Record<AcquisitionChannel, number>;
  /** 유입 경로가 확정되지 않아 집계에서 뺀 건수. 0으로 감추지 않는다. */
  excludedUnknown: number;
}

const ACQUISITIONS: readonly AcquisitionChannel[] = ['partner_referral', 'partner_managed', 'direct', 'inbound', 'unknown'];

function emptyCounts(): Record<AcquisitionChannel, number> {
  const o = {} as Record<AcquisitionChannel, number>;
  for (const a of ACQUISITIONS) o[a] = 0;
  return o;
}

/**
 * 고객사별 **현재 유효 귀속**을 파트너로 묶는다. 이력 전체를 세면 같은 고객사가 여러 번 잡힌다.
 * 충돌이 있는 고객사는 여기서 조용히 한쪽을 고르지 않고, 호출자가 findAttributionConflicts 로
 * 먼저 확인하도록 남겨 둔다.
 */
export function rollupByPartner(history: readonly AttributionRecord[], scope: TenantScope): PartnerRollupRow[] {
  assertTenantScope(scope);
  const scoped = visibleToPartner(history, scope, null);
  const accounts = [...new Set(scoped.map((r) => r.accountId))].sort();

  const byPartner = new Map<string, PartnerRollupRow>();
  for (const accountId of accounts) {
    const cur = currentAttribution(scoped, accountId);
    if (cur === undefined) continue;
    const key = cur.partnerId ?? ' direct';
    const row = byPartner.get(key) ?? { partnerId: cur.partnerId, accountIds: [], byAcquisition: emptyCounts(), excludedUnknown: 0 };
    row.accountIds.push(accountId);
    row.byAcquisition[cur.acquisition] += 1;
    if (cur.acquisition === 'unknown') row.excludedUnknown += 1;
    byPartner.set(key, row);
  }
  return [...byPartner.values()].sort((a, b) => String(a.partnerId).localeCompare(String(b.partnerId)));
}

/** 정산 리포트 1행. 수수료율은 **설정에서 오며**, 없으면 금액을 만들지 않는다(§13-3). */
export interface SettlementLine {
  partnerId: string | null;
  accountCount: number;
  /** 집계 대상 실적. 호출자가 usage/billing 에서 실측으로 가져온다. */
  billedAmount?: number;
  /** 계약 수수료율(0~1). 설정에서 온다. */
  commissionRate?: number;
  /** 산출된 수수료. 실적·요율이 모두 있을 때만 채운다. */
  commissionAmount?: number;
  notesKo: string[];
}

export interface SettlementInput {
  /** 파트너별 실측 청구액. 없는 파트너는 금액을 만들지 않는다. */
  billedByPartner?: Record<string, number>;
  /** 파트너별 계약 수수료율. 하드코딩 기본값을 두지 않는다(§13-3). */
  ratesByPartner?: Record<string, number>;
}

/**
 * 정산 근거를 만든다. **청구·송금을 하지 않는다** — 근거 표만 만든다 [승인 필요].
 * 요율이나 실적이 없으면 0으로 채우지 않고 비워 둔 채 이유를 남긴다.
 * 0원과 "모른다"를 같게 적는 것이 정산 분쟁을 만든다.
 */
export function buildSettlementLines(rows: readonly PartnerRollupRow[], input: SettlementInput = {}): SettlementLine[] {
  return rows.map((row) => {
    const notesKo: string[] = [];
    const key = row.partnerId;
    const billed = key !== null ? input.billedByPartner?.[key] : undefined;
    const rate = key !== null ? input.ratesByPartner?.[key] : undefined;

    if (key === null) notesKo.push('직접 계약분입니다. 파트너 수수료 대상이 아닙니다.');
    else {
      if (billed === undefined) notesKo.push('실측 청구액이 없어 금액을 산출하지 않았습니다(§13-3).');
      if (rate === undefined) notesKo.push('계약 수수료율이 설정되지 않았습니다. 계약서 확정 후 설정하세요 [승인 필요].');
    }
    if (row.excludedUnknown > 0) notesKo.push(`유입 경로 미확정 ${row.excludedUnknown}건이 포함되어 있습니다. 확정 전에는 정산하지 마세요.`);

    const line: SettlementLine = { partnerId: key, accountCount: row.accountIds.length, notesKo };
    if (billed !== undefined) line.billedAmount = billed;
    if (rate !== undefined) line.commissionRate = rate;
    if (key !== null && billed !== undefined && rate !== undefined) {
      line.commissionAmount = Math.round(billed * rate);
    }
    return line;
  });
}

/** 정산을 진행해도 되는가. 미확정·충돌이 있으면 막는다 — 청구 사고는 되돌리기 어렵다. */
export function settlementBlockers(rows: readonly PartnerRollupRow[], conflicts: readonly AttributionConflict[]): string[] {
  const out: string[] = [];
  const unknown = rows.reduce((n, r) => n + r.excludedUnknown, 0);
  if (unknown > 0) out.push(`유입 경로 미확정 ${unknown}건이 있습니다.`);
  if (conflicts.length > 0) out.push(`귀속이 충돌하는 고객사 ${conflicts.length}건이 있습니다: ${conflicts.map((c) => c.accountId).join('·')}`);
  return out;
}
