// 약관·개인정보 처리방침 버전 관리 — 설계서 §10.1(고지·동의)·§10.3(개인정보)·§11.1(테넌트)·§13-3(기본값 금지).
//
// 왜 이 모듈이 필요한가:
// 상용 백로그의 "약관·개인정보 처리방침 확정본 반영"은 문안을 사람이 확정해야 끝나는 항목이다. 그런데
// 문안이 오기 전에 코드가 준비해 둬야 할 것이 따로 있다 — **초안이 확정본 자리에 나가지 않게 막는 것**이다.
// 사고는 대개 문안이 틀려서가 아니라 "초안인 줄 몰랐다"에서 난다: 자리표시자(`{{회사명}}`)가 박힌 문서가
// 고객 화면에 나가고, 그 문서로 받은 동의가 근거로 쌓인다. 그 상태는 동의가 없는 것과 같다.
//
// 규약 5줄 요약
//  1) 문서는 (종류·테넌트·언어·버전) 으로 식별되고, 등록은 추가 전용이다. 확정본은 고치지 않고 새 버전을 낸다.
//  2) 확정(final)은 승인 근거(approvalRef)·시행일·본문·본문 해시가 **모두** 있어야 한다. 하나라도 없으면 초안이다.
//     본문 해시가 어긋난 확정본은 누군가 확정 후에 본문을 고친 것이므로 거부한다.
//  3) 조회는 확정본만 돌려준다. 확정본이 없으면 초안을 대신 내지 않고 "없음"과 이유를 돌려준다.
//     시행일이 아직 안 된 확정본도 내지 않는다. 다른 테넌트 문서는 어떤 조건에서도 나가지 않는다(§11.1).
//  4) 동의(수락) 기록은 어떤 버전을 수락했는지 함께 남기고, 확정본이 바뀌면 이전 수락은 `stale` 로 판정된다.
//     주체 참조는 원문 개인정보를 담지 못한다(§10.3). 승인자 이름은 저장 경로에서 한 번 마스킹된다.
//  5) 기본 언어·기본 시행일·기본 문안을 Core 가 만들지 않는다(§13-3). 문안 확정은 **[승인 필요]** 이며,
//     `legalReadiness` 가 그 상태를 그대로 드러낸다 — 초안만 있는 종류를 "준비됨"으로 적지 않는다.
import { maskPii } from '../core/policyGuard.ts';
import { assertTenantScope, isValidId, type TenantScope } from '../core/tenancy.ts';

export type LegalDocKind = 'terms' | 'privacy_policy';
export const LEGAL_DOC_KINDS: readonly LegalDocKind[] = Object.freeze(['terms', 'privacy_policy']);

export type LegalDocStatus = 'draft' | 'final';

export interface LegalApproval {
  /** 법무·컴플라이언스 승인 근거(결재번호·회의록 참조 등). 없으면 확정본이 될 수 없다. */
  approvalRef: string;
  /** 승인자. 저장 경로에서 마스킹을 한 번 지난다(§10.3). */
  approvedBy: string;
  /** ISO8601. */
  approvedAt: string;
}

export interface LegalDocument {
  kind: LegalDocKind;
  /** 없으면 서비스 공통 문안. 있으면 그 테넌트 전용 문안이며 공통 문안보다 우선한다. */
  tenantId?: string;
  /** BCP-47 (예: 'ko-KR'). 기본 언어를 두지 않는다(§13-3). */
  locale: string;
  /** 1 이상의 정수. 같은 (종류·테넌트·언어) 안에서 확정본 버전은 단조 증가해야 한다. */
  version: number;
  status: LegalDocStatus;
  /** 본문 원문. 공개 문서라 마스킹하지 않는다 — 대신 자리표시자 잔존을 검사한다. */
  content: string;
  /** 확정본에만 있다. 본문의 해시 — 확정 뒤 본문이 바뀌었는지 대조한다. */
  contentHash?: string;
  /** 확정본에만 있다. 이 시각(포함) 이후에만 조회에 나간다. */
  effectiveFrom?: string;
  approval?: LegalApproval;
  /** 변경 요지(사람이 쓴 한 줄). 초안에서 확정으로 갈 때 남긴다. */
  changeNoteKo?: string;
}

/** 해시는 주입받는다 — 이 모듈은 순수하다. (예: sha256 hex) */
export type HashFn = (text: string) => string;

// ── 검증 ─────────────────────────────────────────────────────────────────────

export type LegalIssueCode =
  | 'E_KIND'
  | 'E_TENANT_INVALID'
  | 'E_LOCALE'
  | 'E_VERSION'
  | 'E_STATUS'
  | 'E_FINAL_NO_APPROVAL'
  | 'E_FINAL_NO_EFFECTIVE'
  | 'E_FINAL_EMPTY'
  | 'E_FINAL_NO_HASH'
  | 'E_FINAL_HASH_MISMATCH'
  | 'E_FINAL_PLACEHOLDER'
  | 'E_DUPLICATE'
  | 'E_VERSION_REGRESSION'
  | 'W_DRAFT_PLACEHOLDER';

export interface LegalIssue {
  code: LegalIssueCode;
  severity: 'error' | 'warning';
  messageKo: string;
}

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/**
 * 확정본에 남아 있으면 안 되는 자리표시자. `{{회사명}}`·`[TODO ...]`·`[TBD]`·`[확인 필요]`·`[미정]`·`____`.
 * 초안 표기를 전부 잡으려는 것이 아니다 — 템플릿에서 값이 안 채워진 채 나가는 가장 흔한 형태만 잡는다.
 */
export const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\[(?:TODO|TBD|확인\s*필요|미정)[^\]]*\]|_{4,}/;

function push(issues: LegalIssue[], code: LegalIssueCode, severity: 'error' | 'warning', messageKo: string): void {
  issues.push({ code, severity, messageKo });
}

export function validateLegalDocument(doc: LegalDocument, opts: { hash?: HashFn } = {}): LegalIssue[] {
  const issues: LegalIssue[] = [];
  const err = (code: LegalIssueCode, m: string) => push(issues, code, 'error', m);

  if (!LEGAL_DOC_KINDS.includes(doc.kind)) err('E_KIND', `알 수 없는 문서 종류: ${String(doc.kind)}`);
  if (doc.tenantId !== undefined && !isValidId(doc.tenantId)) {
    err('E_TENANT_INVALID', 'tenant_id 형식 위반 — 테넌트 전용 문안은 유효한 tenant_id 가 있어야 합니다(§11.1).');
  }
  if (typeof doc.locale !== 'string' || !LOCALE_RE.test(doc.locale)) {
    err('E_LOCALE', 'locale 은 BCP-47 형식이어야 하며 기본 언어를 두지 않습니다(§13-3).');
  }
  if (!Number.isInteger(doc.version) || doc.version < 1) err('E_VERSION', 'version 은 1 이상의 정수여야 합니다.');
  if (doc.status !== 'draft' && doc.status !== 'final') err('E_STATUS', `status 는 draft|final 입니다: ${String(doc.status)}`);

  const hasPlaceholder = typeof doc.content === 'string' && PLACEHOLDER_RE.test(doc.content);

  if (doc.status === 'final') {
    if (!doc.approval || typeof doc.approval.approvalRef !== 'string' || doc.approval.approvalRef.trim() === '') {
      err('E_FINAL_NO_APPROVAL', '확정본은 승인 근거(approvalRef)가 있어야 합니다. 없으면 초안입니다 [승인 필요].');
    }
    if (typeof doc.effectiveFrom !== 'string' || Number.isNaN(Date.parse(doc.effectiveFrom))) {
      err('E_FINAL_NO_EFFECTIVE', '확정본은 시행일(effectiveFrom, ISO8601)이 있어야 합니다. 기본값을 만들지 않습니다(§13-3).');
    }
    if (typeof doc.content !== 'string' || doc.content.trim() === '') {
      err('E_FINAL_EMPTY', '확정본 본문이 비어 있습니다.');
    }
    if (typeof doc.contentHash !== 'string' || doc.contentHash.trim() === '') {
      err('E_FINAL_NO_HASH', '확정본은 본문 해시(contentHash)가 있어야 합니다 — 확정 뒤 본문 변조를 대조하기 위해서입니다.');
    } else if (opts.hash && typeof doc.content === 'string' && opts.hash(doc.content) !== doc.contentHash) {
      err('E_FINAL_HASH_MISMATCH', '본문 해시가 어긋납니다 — 확정 후 본문이 바뀌었습니다. 새 버전으로 다시 확정해야 합니다.');
    }
    if (hasPlaceholder) {
      err('E_FINAL_PLACEHOLDER', '확정본에 자리표시자({{…}}·[TODO]·[TBD]·[확인 필요]·____)가 남아 있습니다. 초안입니다.');
    }
  } else if (hasPlaceholder) {
    push(issues, 'W_DRAFT_PLACEHOLDER', 'warning', '초안에 자리표시자가 남아 있습니다. 확정 전에 채워야 합니다.');
  }
  return issues;
}

export function legalDocumentOk(issues: readonly LegalIssue[]): boolean {
  return issues.every((i) => i.severity !== 'error');
}

/** (종류·테넌트·언어) — 버전 계열의 식별자. */
export function documentSeriesKey(doc: Pick<LegalDocument, 'kind' | 'tenantId' | 'locale'>): string {
  return `${doc.kind}|${doc.tenantId ?? '*'}|${doc.locale}`;
}

// ── 확정 ─────────────────────────────────────────────────────────────────────

export interface FinalizeInput {
  approval: LegalApproval;
  effectiveFrom: string;
  changeNoteKo?: string;
}

/**
 * 초안 → 확정본. 원본을 고치지 않고 새 객체를 돌려준다.
 * 본문 해시를 여기서 계산하고, 승인자는 한 번 마스킹된다(§10.3). 초안이 검증을 통과하지 못하면 확정할 수 없다.
 */
export function finalizeDocument(draft: LegalDocument, input: FinalizeInput, hash: HashFn): LegalDocument {
  if (draft.status !== 'draft') throw new Error('이미 확정된 문서는 다시 확정할 수 없습니다 — 새 버전을 등록하세요.');
  if (typeof hash !== 'function') throw new Error('hash 함수가 없습니다.');
  const final: LegalDocument = {
    ...draft,
    status: 'final',
    contentHash: hash(draft.content),
    effectiveFrom: input.effectiveFrom,
    approval: {
      approvalRef: input.approval?.approvalRef,
      approvedBy: maskPii(String(input.approval?.approvedBy ?? '')).text,
      approvedAt: input.approval?.approvedAt,
    },
    ...(input.changeNoteKo !== undefined ? { changeNoteKo: maskPii(input.changeNoteKo).text } : {}),
  };
  const issues = validateLegalDocument(final, { hash });
  if (!legalDocumentOk(issues)) {
    throw new Error(`확정할 수 없습니다: ${issues.filter((i) => i.severity === 'error').map((i) => i.messageKo).join(' / ')}`);
  }
  return final;
}

// ── 등록부(추가 전용) ─────────────────────────────────────────────────────────

export interface LegalRegistry {
  /** 검증 실패·중복·버전 역행이면 던진다. 등록된 문서는 동결된 복사본이다. */
  add(doc: LegalDocument, opts?: { hash?: HashFn }): LegalDocument;
  list(): readonly LegalDocument[];
  current(q: CurrentQuery): CurrentResult;
}

function registryIssues(existing: readonly LegalDocument[], doc: LegalDocument): LegalIssue[] {
  const issues: LegalIssue[] = [];
  const key = documentSeriesKey(doc);
  const same = existing.filter((d) => documentSeriesKey(d) === key);
  if (same.some((d) => d.version === doc.version)) {
    push(issues, 'E_DUPLICATE', 'error', `같은 계열에 같은 버전이 이미 있습니다: ${key} v${doc.version}. 확정본은 고치지 않고 새 버전을 냅니다.`);
  }
  if (doc.status === 'final') {
    const maxFinal = Math.max(0, ...same.filter((d) => d.status === 'final').map((d) => d.version));
    if (doc.version < maxFinal) {
      push(issues, 'E_VERSION_REGRESSION', 'error', `확정본 버전이 역행합니다: v${doc.version} < 기존 확정 v${maxFinal}. "현재 문안"이 두 개가 됩니다.`);
    }
  }
  return issues;
}

export function createLegalRegistry(seed: readonly LegalDocument[] = [], opts: { hash?: HashFn } = {}): LegalRegistry {
  const docs: LegalDocument[] = [];
  const add = (doc: LegalDocument, o: { hash?: HashFn } = {}): LegalDocument => {
    const issues = [...validateLegalDocument(doc, { hash: o.hash ?? opts.hash }), ...registryIssues(docs, doc)];
    if (!legalDocumentOk(issues)) {
      throw new Error(`문서를 등록할 수 없습니다: ${issues.filter((i) => i.severity === 'error').map((i) => i.messageKo).join(' / ')}`);
    }
    const frozen = Object.freeze({ ...doc, ...(doc.approval ? { approval: Object.freeze({ ...doc.approval }) } : {}) });
    docs.push(frozen);
    return frozen;
  };
  for (const d of seed) add(d);
  return {
    add,
    list: () => docs.slice(),
    current: (q) => currentDocument(docs, q),
  };
}

// ── 조회 ─────────────────────────────────────────────────────────────────────

export interface CurrentQuery {
  kind: LegalDocKind;
  scope: TenantScope;
  locale: string;
  /** ISO8601 — 시행일 판정 기준. 주입받는다(§13-3). */
  now: string;
}

export type CurrentResult =
  | { found: true; doc: LegalDocument; source: 'tenant' | 'service' }
  | { found: false; reasonKo: string; pendingDrafts: number; notYetEffective: number };

/**
 * 지금 고객에게 보여도 되는 확정본 하나. 테넌트 전용 문안이 공통 문안보다 우선한다.
 * 초안·미시행·다른 테넌트·다른 언어 문서는 어떤 경우에도 나가지 않는다.
 */
export function currentDocument(docs: readonly LegalDocument[], q: CurrentQuery): CurrentResult {
  assertTenantScope(q.scope);
  const nowMs = Date.parse(q.now);
  if (Number.isNaN(nowMs)) throw new Error('now 는 ISO8601 이어야 합니다.');
  if (typeof q.locale !== 'string' || q.locale.trim() === '') throw new Error('locale 이 없습니다 — 기본 언어를 두지 않습니다(§13-3).');

  const eligible = docs.filter((d) =>
    d.kind === q.kind && d.locale === q.locale && (d.tenantId === undefined || d.tenantId === q.scope.tenantId));
  const finals = eligible.filter((d) => d.status === 'final' && typeof d.effectiveFrom === 'string');
  const effective = finals.filter((d) => Date.parse(d.effectiveFrom as string) <= nowMs);

  const pick = (list: LegalDocument[]): LegalDocument | undefined =>
    list.slice().sort((a, b) =>
      (Date.parse(b.effectiveFrom as string) - Date.parse(a.effectiveFrom as string)) || (b.version - a.version))[0];

  const tenantDoc = pick(effective.filter((d) => d.tenantId === q.scope.tenantId));
  if (tenantDoc) return { found: true, doc: tenantDoc, source: 'tenant' };
  const serviceDoc = pick(effective.filter((d) => d.tenantId === undefined));
  if (serviceDoc) return { found: true, doc: serviceDoc, source: 'service' };

  const pendingDrafts = eligible.filter((d) => d.status === 'draft').length;
  const notYetEffective = finals.length - effective.length;
  const why = notYetEffective > 0
    ? `확정본은 있으나 시행일 전입니다(${notYetEffective}건).`
    : pendingDrafts > 0
      ? `초안만 있습니다(${pendingDrafts}건). 초안은 고객에게 나가지 않습니다 [승인 필요].`
      : '해당 종류·언어의 문서가 없습니다.';
  return { found: false, reasonKo: `${q.kind}/${q.locale}: ${why}`, pendingDrafts, notYetEffective };
}

// ── 수락(동의) 기록 ───────────────────────────────────────────────────────────

export interface AcceptanceRecord {
  tenantId: string;
  workspaceId?: string;
  /** 주체 참조. 전화번호·주민번호 원문 금지 — 해시·고객키만(§10.3). */
  subjectRef: string;
  kind: LegalDocKind;
  version: number;
  locale: string;
  contentHash: string;
  at: string;
  /** 수락 경로(voice/visual/chat/web 등). */
  via: string;
  interactionId?: string;
  evidenceRef?: string;
}

export function assertSubjectRef(subjectRef: string): void {
  if (typeof subjectRef !== 'string' || subjectRef.trim() === '') throw new Error('subjectRef 가 비어 있습니다(§10.1).');
  const m = maskPii(subjectRef);
  if (m.masked) {
    throw new Error(`subjectRef 에 개인정보 원문이 포함됐습니다(${m.hits.join(', ')}). 해시·고객키만 사용합니다(§10.3).`);
  }
}

/**
 * 수락 기록 추가(추가 전용 — 새 배열을 돌려준다). 수락 대상은 **지금 조회되는 확정본**이어야 한다:
 * 초안이나 다른 테넌트 문서에 대한 수락은 근거가 되지 않으므로 거부한다.
 */
export function recordAcceptance(
  records: readonly AcceptanceRecord[],
  input: Omit<AcceptanceRecord, 'version' | 'locale' | 'contentHash' | 'kind'> & { doc: LegalDocument },
): AcceptanceRecord[] {
  assertTenantScope({ tenantId: input.tenantId, ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) });
  assertSubjectRef(input.subjectRef);
  const { doc } = input;
  if (!doc || doc.status !== 'final' || typeof doc.contentHash !== 'string') {
    throw new Error('확정본이 아닌 문서에 대한 수락은 기록하지 않습니다 — 근거가 되지 않습니다.');
  }
  if (doc.tenantId !== undefined && doc.tenantId !== input.tenantId) {
    throw new Error('다른 테넌트의 문서에 대한 수락은 기록하지 않습니다(§11.1).');
  }
  if (typeof input.at !== 'string' || Number.isNaN(Date.parse(input.at))) throw new Error('at 은 ISO8601 이어야 합니다(§13-3).');
  if (typeof input.via !== 'string' || input.via.trim() === '') throw new Error('via(수락 경로)가 없습니다.');

  const rec: AcceptanceRecord = {
    tenantId: input.tenantId,
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    subjectRef: input.subjectRef,
    kind: doc.kind,
    version: doc.version,
    locale: doc.locale,
    contentHash: doc.contentHash,
    at: input.at,
    via: input.via,
    ...(input.interactionId !== undefined ? { interactionId: input.interactionId } : {}),
    ...(input.evidenceRef !== undefined ? { evidenceRef: maskPii(input.evidenceRef).text } : {}),
  };
  return [...records, rec];
}

export type AcceptanceState = 'current' | 'stale' | 'none' | 'unavailable';

export interface AcceptanceStatus {
  state: AcceptanceState;
  /** 주체가 마지막으로 수락한 버전(있으면). */
  acceptedVersion?: number;
  /** 지금 조회되는 확정본 버전(있으면). */
  currentVersion?: number;
  reasonKo: string;
}

/**
 * 주체가 **지금 유효한 확정본**을 수락했는가. 확정본이 바뀌면 이전 수락은 stale 이다 —
 * "예전에 동의했으니 됐다"를 코드가 허용하지 않는다. 확정본이 없으면 판정하지 않는다(unavailable).
 */
export function acceptanceStatus(
  records: readonly AcceptanceRecord[],
  subjectRef: string,
  current: CurrentResult,
  scope: TenantScope,
): AcceptanceStatus {
  assertTenantScope(scope);
  assertSubjectRef(subjectRef);
  if (!current.found) return { state: 'unavailable', reasonKo: `판정 불가 — ${current.reasonKo}` };
  const doc = current.doc;
  const mine = records
    .filter((r) => r.tenantId === scope.tenantId && r.subjectRef === subjectRef && r.kind === doc.kind && r.locale === doc.locale)
    .slice()
    .sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || (a.version - b.version));
  const last = mine[mine.length - 1];
  if (!last) return { state: 'none', currentVersion: doc.version, reasonKo: `${doc.kind} v${doc.version} 수락 기록 없음` };
  if (last.version === doc.version && last.contentHash === doc.contentHash) {
    return { state: 'current', acceptedVersion: last.version, currentVersion: doc.version, reasonKo: `${doc.kind} v${doc.version} 수락됨` };
  }
  return {
    state: 'stale', acceptedVersion: last.version, currentVersion: doc.version,
    reasonKo: `${doc.kind} v${last.version} 수락 후 확정본이 v${doc.version} 으로 바뀌었습니다 — 재수락이 필요합니다.`,
  };
}

// ── 준비도(백로그 항목의 실제 상태) ──────────────────────────────────────────

export interface LegalReadinessItem {
  kind: LegalDocKind;
  locale: string;
  status: 'final' | 'draft_only' | 'missing' | 'not_yet_effective';
  currentVersion?: number;
  pendingDrafts: number;
}

export interface LegalReadiness {
  ready: boolean;
  items: LegalReadinessItem[];
  /** 준비되지 않은 항목의 사유. 준비됐으면 비어 있다. */
  blockersKo: string[];
}

/**
 * 종류×언어별로 확정본이 있는지 그대로 적는다. 초안만 있는 항목은 준비된 것이 아니다 —
 * 이 결과가 COMMERCIAL_READINESS 의 "약관·개인정보 처리방침 확정본 반영" 항목의 근거가 된다.
 */
export function legalReadiness(
  docs: readonly LegalDocument[],
  q: { scope: TenantScope; locales: readonly string[]; now: string; kinds?: readonly LegalDocKind[] },
): LegalReadiness {
  if (!Array.isArray(q.locales) || q.locales.length === 0) throw new Error('locales 가 비어 있습니다 — 기본 언어를 두지 않습니다(§13-3).');
  const kinds = q.kinds ?? LEGAL_DOC_KINDS;
  const items: LegalReadinessItem[] = [];
  const blockersKo: string[] = [];
  for (const kind of kinds) {
    for (const locale of q.locales) {
      const r = currentDocument(docs, { kind, scope: q.scope, locale, now: q.now });
      if (r.found) {
        items.push({ kind, locale, status: 'final', currentVersion: r.doc.version, pendingDrafts: 0 });
        continue;
      }
      const status: LegalReadinessItem['status'] =
        r.notYetEffective > 0 ? 'not_yet_effective' : r.pendingDrafts > 0 ? 'draft_only' : 'missing';
      items.push({ kind, locale, status, pendingDrafts: r.pendingDrafts });
      blockersKo.push(`${r.reasonKo}${status === 'not_yet_effective' ? '' : ' [승인 필요]'}`);
    }
  }
  return { ready: blockersKo.length === 0, items, blockersKo };
}

export function formatLegalReadiness(r: LegalReadiness): string {
  const lines = [`약관·처리방침 준비도: ${r.ready ? '준비됨' : '미완'}`];
  for (const it of r.items) {
    const tag = it.status === 'final' ? `확정 v${it.currentVersion}` : it.status === 'draft_only' ? `초안만 ${it.pendingDrafts}건` : it.status === 'not_yet_effective' ? '시행일 전' : '없음';
    lines.push(`  - ${it.kind}/${it.locale}: ${tag}`);
  }
  for (const b of r.blockersKo) lines.push(`  ! ${b}`);
  return lines.join('\n');
}
