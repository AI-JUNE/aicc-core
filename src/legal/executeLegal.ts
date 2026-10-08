// 고지 문안 ↔ 동의 근거를 꿰는 자리 — 설계서 §10.1(고지·동의)·§10.3·§11.1·§13-3.
//
// `legal/documents.ts` 는 한 가지를 막기 위해 만들어졌다 — **초안이 확정본 자리에 나가는 일**.
// 그 머리말에 적힌 대로 "그 문서로 받은 동의는 동의가 아니다". 그런데 저장소 전체에서 그 모듈을
// import 하는 곳은 **자기 테스트뿐이다**. 등록부도, 확정 검사도, `acceptanceStatus` 의
// `stale` 판정도 아무도 묻지 않는다 — 즉 **막으려고 만든 것이 한 번도 막아 본 적이 없다**.
//
// 동의 쪽에서 보면 공백의 모양이 더 분명하다. `ConsentRequirement.noticeRef` 는 "고지 문구 참조 키"
// 라는 **자유 문자열**이고, 지금까지 그 값이 무엇을 가리키는지 확인하는 코드가 없었다. 그래서:
//
//  (가) **오타·빈 참조가 통과한다.** 동의는 쌓이지만 "어떤 문안으로 받았는지" 추적이 끊긴다 —
//       분쟁에서 필요한 것이 정확히 그 한 줄이다.
//  (나) **초안 문안으로 동의를 받는다.** 등록부는 초안을 내보내지 않도록 만들어졌는데 동의 경로가
//       등록부를 거치지 않으므로 그 보호가 닿지 않는다. 자리표시자(`{{회사명}}`)가 박힌 문서로
//       받은 동의가 근거로 쌓이고, 그 상태는 동의가 없는 것과 같다.
//  (다) **문안 개정이 동의를 무효로 만들지 않는다.** 이게 제일 조용한 실패다. `evaluateConsents`
//       는 `policyVersion` 만 보고 `acceptanceStatus` 는 문서 버전·본문 해시만 본다 — **둘이 서로를
//       모른다**. 처리방침이 v2 로 개정돼도 정책 버전이 그대로면 동의는 여전히 `granted` 이고
//       게이트는 통과한다. "예전에 동의했으니 됐다"를 `acceptanceStatus` 는 `stale` 로 거부하는데
//       **그 판정을 부르는 코드가 없다.**
//  (라) **시행일 전 문안·다른 언어 문안으로 미리 받는다.** `currentDocument` 가 걸러 주는 것들인데
//       동의 경로가 그 함수를 지나지 않는다.
//  (마) **문안이 아예 없는데 동의를 받는다.** 그 동의의 대상 문서가 존재하지 않는다.
//
// 이 파일이 지키는 경계:
//  - **통화를 끊지 않는다.** `allowed: false` 는 "그 **행위**(PII 백엔드 조회·국외이전 등)를 하지
//    말라"이지 "통화를 종료하라"가 아니다. 문안이 미확정이라는 이유로 Core 가 통화를 내리면
//    문안 하나 때문에 전 채널이 멈춘다(`consent/executeConsent.ts` 의 "막지 않는다"와 같은 선).
//  - **판정을 복사하지 않는다(§2).** 동의 상태·행위 차단은 `gateAction` 하나, 확정본 조회는
//    `currentDocument` 하나, 재수락 필요 여부는 `acceptanceStatus` 하나다. 이 파일에는 만료일도
//    목적 매핑도 자리표시자 정규식도 없다.
//  - **종전과 완전히 같다(§13-3).** `docs` 를 선언하지 않으면 문안 검사를 **하지 않고**
//    `allowed` 는 `gateAction` 결과 그대로다. 달라지는 것은 "확인하지 못했다"가 결과에
//    적힌다는 점뿐이다 — 검사를 못 돌린 것을 통과로 적지 않는다.
//  - **문안을 만들지 않는다.** 기본 언어·기본 종류·기본 참조 형식의 값을 Core 가 정하지 않는다.
//    다만 **참조의 형식은 파서와 짝이므로 Core 가 정한다**(`llmClassifier` 의 출력 형식과 같은
//    이유다) — `legal:<종류>` · `legal:<종류>@<버전>`. 그 형식이 아닌 참조는 테넌트 자기 문구
//    저장소를 가리킬 수 있으므로 **틀렸다고 적지 않고 "확인할 수 없다"로 적는다**.
//  - **수락 기록이 없다는 사실만으로 기존 동의를 무효로 보지 않는다.** 수락 기록은 호스트가 남기는
//    별도 증빙이고, 없다는 이유로 막으면 쌓인 동의 전체가 하루아침에 막힌다 — 그 결정은 Core 가
//    할 일이 아니다. 대신 `unverifiableKo` 에 적어 "어느 문안으로 받은 동의인지 대조할 수 없다"는
//    사실이 사라지지 않게 한다. **개정이 확인된 `stale` 은 다르다** — 그건 관측된 결함이므로 막는다.
//  - **저장하지 않는다.** 문서 등록·수락 기록 영속화는 호스트 몫이다(§6.2).
import {
  ACTION_PURPOSES, gateAction,
  type ConsentPolicy, type ConsentPurpose, type ConsentRecord, type GateDecision, type GatedAction,
} from '../consent/consent.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import {
  LEGAL_DOC_KINDS, acceptanceStatus, currentDocument,
  type AcceptanceRecord, type AcceptanceStatus, type LegalDocKind, type LegalDocument,
} from './documents.ts';

export const LEGAL_BASIS_CONTRACT_VERSION = 1;

/**
 * 고지 문안 참조의 예약 접두사. 뒤에 `legal:<종류>` 또는 `legal:<종류>@<버전>` 을 적는다
 * (예: `legal:privacy_policy`, `legal:terms@3`).
 *
 * 왜 Core 가 형식을 정하는가: 참조를 **파싱해서 등록부와 맞춰 보는 쪽**이 Core 이므로, 형식은
 * 파서와 짝이다. 형식을 테넌트가 정하면 파서는 영원히 "확인할 수 없음"만 돌려주고, 그 상태는
 * 위 (가)~(라) 를 하나도 막지 못한다.
 */
export const LEGAL_NOTICE_REF_PREFIX = 'legal:';

export interface ParsedNoticeRef {
  /** 예약 형식인가. 아니면 Core 가 확정 여부를 알 수 없다. */
  reserved: boolean;
  kind?: LegalDocKind;
  /** `@<버전>` 으로 고정했을 때의 버전. 고정하지 않으면 없다. */
  version?: number;
  /** 예약 형식이지만 종류·버전이 계약을 벗어난 경우의 사유. */
  defectKo?: string;
}

/** 참조 하나를 읽는다. **고르지 않는다** — 모르는 종류를 가까운 것으로 바꿔 읽지 않는다(§13-3). */
export function parseNoticeRef(ref: string): ParsedNoticeRef {
  if (typeof ref !== 'string' || !ref.startsWith(LEGAL_NOTICE_REF_PREFIX)) return { reserved: false };
  const body = ref.slice(LEGAL_NOTICE_REF_PREFIX.length);
  const at = body.indexOf('@');
  const kindPart = at === -1 ? body : body.slice(0, at);
  const versionPart = at === -1 ? undefined : body.slice(at + 1);

  const kind = LEGAL_DOC_KINDS.find((k) => k === kindPart);
  if (kind === undefined) {
    return { reserved: true, defectKo: `알 수 없는 문서 종류: ${JSON.stringify(kindPart)} (허용: ${LEGAL_DOC_KINDS.join('·')})` };
  }
  if (versionPart === undefined) return { reserved: true, kind };
  // 버전 고정은 정수만. '3.1'·'v3'·빈 문자열을 3 으로 읽어 주면 고정하지 않은 것과 구분되지 않는다.
  if (!/^[0-9]+$/.test(versionPart)) {
    return { reserved: true, kind, defectKo: `버전 고정이 정수가 아닙니다: ${JSON.stringify(versionPart)}` };
  }
  const version = Number(versionPart);
  if (!Number.isInteger(version) || version < 1) {
    return { reserved: true, kind, defectKo: `버전은 1 이상의 정수여야 합니다: ${versionPart}` };
  }
  return { reserved: true, kind, version };
}

// ── 고지 문안 검사 ───────────────────────────────────────────────────────────

export type NoticeRefStatus =
  | 'final'              // 등록부의 확정본을 가리키고 시행 중이다
  | 'absent'             // noticeRef 가 선언되지 않았다
  | 'unverifiable'       // 예약 형식이 아닌 자유 참조 — Core 가 확정 여부를 알 수 없다
  | 'malformed'          // 예약 형식인데 종류·버전이 계약을 벗어났다
  | 'missing_doc'        // 그 종류·언어의 문서가 등록부에 없다
  | 'draft_only'         // 초안만 있다 — 초안으로 받은 동의는 근거가 아니다
  | 'not_yet_effective'  // 확정본은 있으나 시행일 전이다
  | 'version_mismatch';  // 버전을 고정했는데 지금 시행 중인 확정본이 다른 버전이다

export interface NoticeCheck {
  purpose: ConsentPurpose;
  /** 정책에 선언된 목적인가. 선언되지 않았으면 문안도 없다. */
  declared: boolean;
  required: boolean;
  noticeRef?: string;
  kind?: LegalDocKind;
  pinnedVersion?: number;
  status: NoticeRefStatus;
  /** 지금 시행 중인 확정본 버전(있으면). */
  currentVersion?: number;
  reasonKo: string;
}

export interface LegalNoticeReport {
  /** 전 목적이 확정본을 가리키고, 확인하지 못한 참조도 없다. */
  ready: boolean;
  checks: NoticeCheck[];
  /** 관측된 결함 — 초안·미시행·버전 불일치·문서 없음·형식 오류. */
  blockersKo: string[];
  /** 확인하지 못한 것 — 통과로도 실패로도 적지 않는다(§13-3). */
  unverifiableKo: string[];
}

export interface NoticeCheckQuery {
  scope: TenantScope;
  policy: ConsentPolicy;
  /** 등록부 내용(`LegalRegistry.list()` 결과 그대로). */
  docs: readonly LegalDocument[];
  /** 고객에게 보여 줄 언어. 기본 언어를 만들지 않는다(§13-3). */
  locale: string;
  now: string;
  /** 검사 대상 목적. 생략하면 정책에 선언된 전 목적. */
  purposes?: readonly ConsentPurpose[];
}

function noticeCheckOf(q: NoticeCheckQuery, purpose: ConsentPurpose): NoticeCheck {
  const req = q.policy.requirements.find((r) => r.purpose === purpose);
  const base = { purpose, declared: req !== undefined, required: req?.required ?? false };

  if (req === undefined) {
    return {
      ...base,
      status: 'absent',
      reasonKo: `${purpose}: 정책에 선언되지 않은 목적이라 고지 문안 참조도 없습니다 (설계서 §10.1)`,
    };
  }
  if (req.noticeRef === undefined || req.noticeRef.trim() === '') {
    return {
      ...base,
      status: 'absent',
      reasonKo:
        `${purpose}: 고지 문안 참조(noticeRef)가 없습니다 — 이 목적의 동의가 어떤 문안으로 받은 것인지 ` +
        '문서로 가리킬 수 없습니다 (설계서 §10.1)',
    };
  }

  const ref = req.noticeRef;
  const parsed = parseNoticeRef(ref);
  if (!parsed.reserved) {
    return {
      ...base,
      noticeRef: ref,
      status: 'unverifiable',
      reasonKo:
        `${purpose}: 고지 문안 참조가 예약 형식(${LEGAL_NOTICE_REF_PREFIX}<종류>[@<버전>])이 아니어서 ` +
        '확정본인지 확인할 수 없습니다 — 테넌트 자기 문구 저장소를 가리킬 수 있으므로 틀렸다고 적지 ' +
        '않습니다. 확정 여부를 코드가 보장하려면 등록부 참조로 바꾸세요 (설계서 §13-3)',
    };
  }
  if (parsed.kind === undefined || parsed.defectKo !== undefined) {
    return {
      ...base,
      noticeRef: ref,
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      status: 'malformed',
      reasonKo: `${purpose}: 고지 문안 참조 형식 오류 — ${parsed.defectKo ?? '종류를 읽을 수 없습니다'} (설계서 §10.1)`,
    };
  }

  const kind = parsed.kind;
  const withKind = { ...base, noticeRef: ref, kind, ...(parsed.version !== undefined ? { pinnedVersion: parsed.version } : {}) };
  // 조회는 `currentDocument` 하나다 — 초안·미시행·다른 테넌트·다른 언어 판정을 여기서 다시 쓰지 않는다(§2).
  const current = currentDocument(q.docs, { kind, scope: q.scope, locale: q.locale, now: q.now });
  if (!current.found) {
    const status: NoticeRefStatus =
      current.notYetEffective > 0 ? 'not_yet_effective' : current.pendingDrafts > 0 ? 'draft_only' : 'missing_doc';
    return {
      ...withKind,
      status,
      reasonKo:
        `${purpose}: ${current.reasonKo}` +
        (status === 'draft_only'
          ? ' 초안으로 받은 동의는 근거가 되지 않습니다.'
          : status === 'not_yet_effective'
            ? ' 시행일 전 문안으로 미리 받은 동의는 그 문안의 동의가 아닙니다.'
            : ''),
    };
  }

  const doc = current.doc;
  if (parsed.version !== undefined && parsed.version !== doc.version) {
    return {
      ...withKind,
      status: 'version_mismatch',
      currentVersion: doc.version,
      reasonKo:
        `${purpose}: 고지 문안을 v${parsed.version} 로 고정했지만 지금 시행 중인 확정본은 ` +
        `v${doc.version} 입니다 — 개정된 문안이 있는데 정책은 옛 버전을 가리킵니다 (설계서 §10.1)`,
    };
  }
  return {
    ...withKind,
    status: 'final',
    currentVersion: doc.version,
    reasonKo: `${purpose}: ${kind}/${doc.locale} v${doc.version} 확정본(${current.source})`,
  };
}

/**
 * 동의 정책의 고지 문안 참조가 **등록부의 확정본**을 가리키는지 본다.
 *
 * `validateConsentPolicy` 는 정책 자체의 형태만 보고 문안을 보지 않는다. 그 사이의 공백이
 * 위 (가)~(라) 이고, 여기서 메운다. 선택 목적의 문안 결함은 **막지 않는다** — 마케팅 문안이
 * 초안이라는 이유로 개인정보 처리 행위가 멈추면 원인과 증상이 아주 멀어진다.
 */
export function checkConsentNotices(q: NoticeCheckQuery): LegalNoticeReport {
  assertTenantScope(q.scope);
  if (q.policy === null || typeof q.policy !== 'object') {
    throw new Error('동의 정책이 선언되지 않았습니다 (설계서 §10.1)');
  }
  if (q.policy.tenantId !== q.scope.tenantId) {
    throw new Error(`테넌트 격리 위반(legal): 기대=${q.scope.tenantId} 실제=${q.policy.tenantId} (설계서 §11.1)`);
  }
  if (typeof q.locale !== 'string' || q.locale.trim() === '') {
    throw new Error('locale 이 없습니다 — 기본 언어를 두지 않습니다 (설계서 §13-3)');
  }

  const purposes = q.purposes ?? q.policy.requirements.map((r) => r.purpose);
  const checks = [...new Set(purposes)].map((p) => noticeCheckOf(q, p));

  const blockersKo: string[] = [];
  const unverifiableKo: string[] = [];
  for (const c of checks) {
    if (c.status === 'final') continue;
    if (c.status === 'unverifiable') { unverifiableKo.push(c.reasonKo); continue; }
    blockersKo.push(c.reasonKo);
  }
  return { ready: blockersKo.length === 0 && unverifiableKo.length === 0, checks, blockersKo, unverifiableKo };
}

// ── 행위 근거 판정 ───────────────────────────────────────────────────────────

export type LegalBasisStatus =
  | 'ok'
  | 'consent_missing'         // `gateAction` 이 막았다(정책 미승인·필수 동의 없음)
  | 'notice_not_final'        // 필수 목적의 고지 문안이 확정본이 아니다
  | 'reacceptance_required'   // 문안이 개정돼 이전 수락이 낡았다(§10.1)
  | 'unverified';             // 막지는 않았으나 확인하지 못한 것이 있다

export interface LegalBasisQuery {
  scope: TenantScope;
  policy: ConsentPolicy;
  /** 이 주체의 동의 이력. `ConsentStore.list` 결과 그대로. */
  consents: readonly ConsentRecord[];
  subjectRef: string;
  action: GatedAction;
  now: string;
  /**
   * 등록부 내용. **선언하지 않으면 문안 검사를 하지 않고 `allowed` 는 게이트 결과 그대로다**
   * (§13-3 — 종전과 완전히 같다). 확인하지 못했다는 사실은 결과에 적힌다.
   */
  docs?: readonly LegalDocument[];
  /** 문안 수락 기록. 없으면 재수락 판정을 하지 않고 "대조할 수 없다"로 적는다. */
  acceptances?: readonly AcceptanceRecord[];
  /** `docs` 를 선언했으면 필수다 — 기본 언어를 만들지 않는다(§13-3). */
  locale?: string;
}

export interface LegalBasisDecision {
  status: LegalBasisStatus;
  /** 이 **행위**를 수행해도 되는가. 통화 종료 여부가 아니다. */
  allowed: boolean;
  /** 막지도 않았고 확인하지 못한 것도 없다 — 근거가 완전하다. */
  verified: boolean;
  /** `gateAction` 결과 그대로. 이 파일이 다시 판정하지 않는다(§2). */
  gate: GateDecision;
  /** 이 행위에 걸린 목적들의 문안 검사. `docs` 미선언이면 없다. */
  notices?: LegalNoticeReport;
  /** 문안 종류별 재수락 판정. `acceptances`·`docs` 가 있을 때만 채운다. */
  acceptance: { kind: LegalDocKind; status: AcceptanceStatus }[];
  /** 막은 이유. 비어 있으면 `allowed` 다. */
  blockersKo: string[];
  /** 확인하지 못한 것. 통과로도 실패로도 적지 않는다. */
  unverifiableKo: string[];
  messageKo: string;
}

/**
 * 동의 + 고지 문안 + 재수락 여부를 한 판정으로 접는다.
 *
 * 순수 함수다(시각·난수·I/O 없음). `now` 는 주입이다.
 */
export function decideLegalBasis(q: LegalBasisQuery): LegalBasisDecision {
  assertTenantScope(q.scope);
  const purposes = ACTION_PURPOSES[q.action];
  if (purposes === undefined) {
    throw new Error(`계약에 없는 행위입니다: ${JSON.stringify(q.action)} (설계서 §10.1)`);
  }

  // 동의 판정은 `gateAction` 하나다. 던지는 조건(테넌트 불일치·주체 참조 PII)도 그쪽 규칙을 쓴다.
  const gate = gateAction(q.policy, q.consents, q.action, q.subjectRef, q.now, q.scope);

  const blockersKo: string[] = [];
  const unverifiableKo: string[] = [];
  if (!gate.allow) {
    blockersKo.push(gate.reason === 'policy_not_approved'
      ? '법무·컴플라이언스 미승인 동의 정책입니다 — 승인 전에는 동의를 근거로 쓸 수 없습니다 [승인 필요] (설계서 §10.1)'
      : `필수 동의가 없습니다: ${gate.blockedBy.map((e) => `${e.purpose}(${e.state}${e.declared ? '' : '·정책 미선언'})`).join(', ')} (설계서 §10.1)`);
  }

  if (q.docs === undefined) {
    unverifiableKo.push(
      '문안 등록부를 선언하지 않아 고지 문안이 확정본인지 확인하지 않았습니다 — 초안으로 받은 동의가 ' +
      '근거로 쌓이고 있는지는 이 판정으로 알 수 없습니다 (설계서 §10.1·§13-3)',
    );
    return finish({ gate, blockersKo, unverifiableKo, acceptance: [] });
  }
  if (typeof q.locale !== 'string' || q.locale.trim() === '') {
    throw new Error('등록부를 선언했으면 locale 도 선언해야 합니다 — 기본 언어를 두지 않습니다 (설계서 §13-3)');
  }

  const notices = checkConsentNotices({
    scope: q.scope, policy: q.policy, docs: q.docs, locale: q.locale, now: q.now, purposes,
  });
  // 선택 목적의 문안 결함은 막지 않는다 — 원인과 증상이 멀어진다. 다만 사라지지도 않는다.
  let noticeBlocked = false;
  for (const c of notices.checks) {
    if (c.status === 'final') continue;
    if (c.status === 'unverifiable') { unverifiableKo.push(c.reasonKo); continue; }
    if (c.required || !c.declared) { blockersKo.push(c.reasonKo); noticeBlocked = true; }
    else unverifiableKo.push(`${c.reasonKo} (선택 목적이라 이 행위를 막지 않습니다)`);
  }

  // 재수락 — 문안이 개정되면 이전 수락은 낡는다. 이 판정은 `acceptanceStatus` 하나가 만든다(§2).
  const acceptance: { kind: LegalDocKind; status: AcceptanceStatus }[] = [];
  const kinds = [...new Set(notices.checks.map((c) => c.kind).filter((k): k is LegalDocKind => k !== undefined))];
  if (kinds.length === 0) {
    // 확정본을 가리키는 참조가 하나도 없으면 대조할 대상이 없다. 이미 위에서 적혔다.
  } else if (q.acceptances === undefined) {
    unverifiableKo.push(
      `문안 수락 기록을 선언하지 않아 어느 문안으로 받은 동의인지 대조하지 않았습니다(${kinds.join('·')}) — ` +
      '없다는 사실만으로 기존 동의를 무효로 보지 않습니다 (설계서 §10.1)',
    );
  } else {
    for (const kind of kinds) {
      const current = currentDocument(q.docs, { kind, scope: q.scope, locale: q.locale, now: q.now });
      const status = acceptanceStatus(q.acceptances, q.subjectRef, current, q.scope);
      acceptance.push({ kind, status });
      if (status.state === 'stale') {
        blockersKo.push(`${kind}: ${status.reasonKo} (설계서 §10.1)`);
      } else if (status.state === 'none') {
        unverifiableKo.push(
          `${kind}: ${status.reasonKo} — 수락 기록은 호스트가 남기는 별도 증빙이므로 없다는 사실만으로 ` +
          '동의를 무효로 보지 않습니다. 다만 분쟁에서 "어떤 문안으로 받았는가"에 답할 수 없습니다 (설계서 §10.1)',
        );
      }
      // 'unavailable'(확정본 없음)은 이미 문안 검사에서 막혔다 — 같은 사실을 두 번 적지 않는다(§2).
    }
  }

  return finish({ gate, notices, blockersKo, unverifiableKo, acceptance, noticeBlocked });
}

function finish(p: {
  gate: GateDecision;
  notices?: LegalNoticeReport;
  blockersKo: string[];
  unverifiableKo: string[];
  acceptance: { kind: LegalDocKind; status: AcceptanceStatus }[];
  noticeBlocked?: boolean;
}): LegalBasisDecision {
  const allowed = p.blockersKo.length === 0;
  const verified = allowed && p.unverifiableKo.length === 0;

  // 상태는 **가장 앞선 원인**으로 적는다. 동의가 없는데 "재수락 필요"로 적으면 조치가 엉뚱해진다.
  const status: LegalBasisStatus = !p.gate.allow
    ? 'consent_missing'
    : p.noticeBlocked === true
      ? 'notice_not_final'
      : !allowed
        ? 'reacceptance_required'
        : verified ? 'ok' : 'unverified';

  const messageKo = allowed
    ? (verified
      ? '§10.1 근거가 확인됐습니다 — 동의·확정본·수락이 모두 현재입니다.'
      : `행위를 막지 않았으나 확인하지 못한 것이 ${p.unverifiableKo.length}건 있습니다 — 통과로 적지 않습니다 (설계서 §13-3).`)
    : `§10.1 근거가 없어 이 행위를 수행할 수 없습니다(${p.blockersKo.length}건). 통화를 끊으라는 뜻이 아닙니다 — 거부 분기는 시나리오가 정합니다.`;

  return {
    status,
    allowed,
    verified,
    gate: p.gate,
    ...(p.notices !== undefined ? { notices: p.notices } : {}),
    acceptance: p.acceptance,
    blockersKo: p.blockersKo,
    unverifiableKo: p.unverifiableKo,
    messageKo,
  };
}

/** 운영·감사용 한 장. 판정을 만들지 않고 결과를 그대로 적는다. */
export function formatLegalBasisReport(d: LegalBasisDecision): string {
  const lines = [`§10.1 행위 근거 — ${d.status} (allowed=${d.allowed} · verified=${d.verified})`, d.messageKo];
  for (const c of d.notices?.checks ?? []) lines.push(`  - 문안 ${c.status}: ${c.reasonKo}`);
  for (const a of d.acceptance) lines.push(`  - 수락 ${a.kind}: ${a.status.state} — ${a.status.reasonKo}`);
  for (const x of d.blockersKo) lines.push(`  ! ${x}`);
  for (const x of d.unverifiableKo) lines.push(`  ? ${x}`);
  return lines.join('\n');
}
