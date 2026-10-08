// 고지 문안 ↔ 동의 근거 검사 — 설계서 §10.1·§10.3·§11.1·§13-3.
//
// 여기서 고정하는 한 문장: **초안으로 받은 동의, 개정 전 문안으로 받은 동의는 근거가 아니다 —
// 그리고 그 사실 때문에 통화가 끊기지는 않는다.**
// `legal/documents.ts` 는 바로 그것을 막기 위해 만들어졌는데 저장소 어디에서도 불리지 않았다.
// 그래서 정상 경로보다 **막는 경로**와 **막지 않는 경계**를 더 촘촘히 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let m = null, docsMod = null, consentMod = null;
try {
  m = await import('../src/legal/executeLegal.ts');
  docsMod = await import('../src/legal/documents.ts');
  consentMod = await import('../src/consent/consent.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const hash = (s) => createHash('sha256').update(s).digest('hex');

const S = { tenantId: 't1' };
const LOCALE = 'ko-KR';
const NOW = '2026-10-08T03:00:00.000Z';
const SUBJ = 'subj-hash-1';

const APPROVAL = { approvalRef: 'LEGAL-2026-09-01', approvedBy: '김법무', approvedAt: '2026-09-01T00:00:00.000Z' };

/** 확정본 하나. 실제 `finalizeDocument` 를 지나므로 해시·승인 근거가 진짜로 붙는다. */
function finalDoc(over = {}) {
  const draft = {
    kind: 'privacy_policy', locale: LOCALE, version: 1, status: 'draft',
    content: '개인정보 처리방침 본문입니다.', ...over,
  };
  return docsMod.finalizeDocument(draft, { approval: APPROVAL, effectiveFrom: '2026-09-15T00:00:00.000Z' }, hash);
}

const draftDoc = (over = {}) => ({
  kind: 'privacy_policy', locale: LOCALE, version: 1, status: 'draft',
  content: '{{회사명}} 개인정보 처리방침 초안', ...over,
});

const policy = (over = {}) => ({
  tenantId: 't1',
  requirements: [{ purpose: 'personal_data_collection', required: true, noticeRef: 'legal:privacy_policy' }],
  version: 1, updatedAt: '2026-09-20T00:00:00.000Z', updatedBy: 'admin', approved: true,
  ...over,
});

const granted = (p = policy(), purpose = 'personal_data_collection') =>
  [consentMod.grant(p, { subjectRef: SUBJ, purpose, via: 'voice', at: '2026-10-01T00:00:00.000Z' })];

const query = (over = {}) => ({
  scope: S, policy: policy(), consents: granted(), subjectRef: SUBJ,
  action: 'call_backend_with_pii', now: NOW, docs: [finalDoc()], locale: LOCALE, ...over,
});

// ── 1) 참조 형식 — Core 가 정하고 Core 가 읽는다 ─────────────────────────────

test('예약 형식만 읽는다 — 모르는 종류·버전을 가까운 것으로 바꿔 읽지 않는다(§13-3)', b, () => {
  assert.deepEqual(m.parseNoticeRef('legal:privacy_policy'), { reserved: true, kind: 'privacy_policy' });
  assert.deepEqual(m.parseNoticeRef('legal:terms@3'), { reserved: true, kind: 'terms', version: 3 });
  assert.equal(m.parseNoticeRef('tenant-notice-7').reserved, false, '자유 참조는 틀렸다고 적지 않는다');
  assert.equal(m.parseNoticeRef('legal:marketing_blurb').defectKo !== undefined, true);
  // '3e2'·' 3' 은 Number() 가 300·3 으로 읽어 주는 값이다 — 숫자 변환에만 맡기면 **다른 버전의
  // 문안을 가리킨 채 통과**한다(오타 하나가 고정 버전을 바꿔 놓는다).
  for (const bad of ['legal:terms@v3', 'legal:terms@3.1', 'legal:terms@', 'legal:terms@0', 'legal:terms@3e2', 'legal:terms@ 3']) {
    assert.equal(m.parseNoticeRef(bad).defectKo !== undefined, true, `${bad} 은 형식 오류여야 한다`);
    assert.equal(m.parseNoticeRef(bad).version, undefined, `${bad} 에서 버전을 만들어 내지 않는다`);
  }
});

// ── 2) 정상 경로 ─────────────────────────────────────────────────────────────

test('확정본을 가리키는 정책은 준비됨으로 나온다', b, () => {
  const r = m.checkConsentNotices({ scope: S, policy: policy(), docs: [finalDoc()], locale: LOCALE, now: NOW });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockersKo, []);
  assert.deepEqual(r.unverifiableKo, []);
  assert.equal(r.checks[0].status, 'final');
  assert.equal(r.checks[0].currentVersion, 1);
});

test('동의·확정본·수락이 모두 현재면 근거가 확인된다', b, () => {
  const doc = finalDoc();
  const acceptances = docsMod.recordAcceptance([], {
    tenantId: 't1', subjectRef: SUBJ, at: '2026-10-01T00:00:00.000Z', via: 'voice', doc,
  });
  const d = m.decideLegalBasis(query({ docs: [doc], acceptances }));
  assert.equal(d.status, 'ok');
  assert.equal(d.allowed, true);
  assert.equal(d.verified, true);
  assert.deepEqual(d.blockersKo, []);
  assert.deepEqual(d.unverifiableKo, []);
  assert.equal(d.acceptance[0].status.state, 'current');
  assert.match(m.formatLegalBasisReport(d), /allowed=true/);
});

test('같은 입력이면 같은 판정이 나온다 — 근거는 재현되지 않으면 근거가 아니다', b, () => {
  const q = query();
  assert.deepEqual(m.decideLegalBasis(q), m.decideLegalBasis(q));
});

// ── 3) (나) 초안으로 받은 동의는 근거가 아니다 ───────────────────────────────

test('(나) 고지 문안이 초안뿐이면 그 행위를 막는다 — 등록부의 보호가 처음으로 닿는다', b, () => {
  const d = m.decideLegalBasis(query({ docs: [draftDoc()] }));
  assert.equal(d.allowed, false);
  assert.equal(d.status, 'notice_not_final');
  assert.equal(d.gate.allow, true, '동의 자체는 있다 — 막은 이유는 문안이다');
  assert.equal(d.blockersKo.some((s) => s.includes('초안')), true);
  assert.match(d.messageKo, /통화를 끊으라는 뜻이 아닙니다/);
});

test('(라) 시행일 전 확정본으로 미리 받은 동의도 막는다', b, () => {
  const future = docsMod.finalizeDocument(
    draftDoc({ content: '처리방침 본문' }), { approval: APPROVAL, effectiveFrom: '2027-01-01T00:00:00.000Z' }, hash);
  const d = m.decideLegalBasis(query({ docs: [future] }));
  assert.equal(d.allowed, false);
  assert.equal(d.blockersKo.some((s) => s.includes('시행일 전')), true);
});

test('(마) 그 종류·언어의 문서가 아예 없으면 막는다', b, () => {
  const d = m.decideLegalBasis(query({ docs: [] }));
  assert.equal(d.allowed, false);
  assert.equal(d.notices.checks[0].status, 'missing_doc');
});

test('§11.1 다른 테넌트 문안은 어떤 조건에서도 쓰이지 않는다', b, () => {
  const other = finalDoc({ tenantId: 'other' });
  const d = m.decideLegalBasis(query({ docs: [other] }));
  assert.equal(d.allowed, false);
  assert.equal(d.notices.checks[0].status, 'missing_doc');
});

test('(라) 다른 언어 문안으로 대신하지 않는다', b, () => {
  const d = m.decideLegalBasis(query({ docs: [finalDoc({ locale: 'en-US' })] }));
  assert.equal(d.allowed, false);
  assert.equal(d.notices.checks[0].status, 'missing_doc');
});

// ── 4) (다) 문안 개정이 동의를 낡게 만든다 ───────────────────────────────────

test('(다) 문안이 개정되면 이전 수락은 낡는다 — 동의는 granted 인데도 막는다', b, () => {
  const v1 = finalDoc();
  const acceptances = docsMod.recordAcceptance([], {
    tenantId: 't1', subjectRef: SUBJ, at: '2026-10-01T00:00:00.000Z', via: 'voice', doc: v1,
  });
  const v2 = docsMod.finalizeDocument(
    draftDoc({ version: 2, content: '개정된 처리방침 본문' }),
    { approval: APPROVAL, effectiveFrom: '2026-10-05T00:00:00.000Z' }, hash);

  const d = m.decideLegalBasis(query({ docs: [v1, v2], acceptances }));
  assert.equal(d.gate.allow, true, '전제: 동의 자체는 여전히 granted 다');
  assert.equal(d.allowed, false, '"예전에 동의했으니 됐다"를 허용하지 않는다');
  assert.equal(d.status, 'reacceptance_required');
  assert.equal(d.acceptance[0].status.state, 'stale');
  assert.equal(d.blockersKo.some((s) => s.includes('재수락')), true);
});

test('(다) 버전을 고정했는데 개정본이 시행 중이면 드러낸다', b, () => {
  const v1 = finalDoc();
  const v2 = docsMod.finalizeDocument(
    draftDoc({ version: 2, content: '개정된 처리방침 본문' }),
    { approval: APPROVAL, effectiveFrom: '2026-10-05T00:00:00.000Z' }, hash);
  const pinned = policy({
    requirements: [{ purpose: 'personal_data_collection', required: true, noticeRef: 'legal:privacy_policy@1' }],
  });
  const d = m.decideLegalBasis(query({ policy: pinned, consents: granted(pinned), docs: [v1, v2] }));
  assert.equal(d.allowed, false);
  assert.equal(d.notices.checks[0].status, 'version_mismatch');
  assert.equal(d.notices.checks[0].currentVersion, 2);
});

test('수락 기록이 없다는 사실만으로 기존 동의를 무효로 보지 않는다 — 다만 통과로도 적지 않는다', b, () => {
  const d = m.decideLegalBasis(query({ acceptances: [] }));
  assert.equal(d.allowed, true);
  assert.equal(d.verified, false, '대조하지 못한 것을 통과로 적지 않는다(§13-3)');
  assert.equal(d.status, 'unverified');
  assert.equal(d.acceptance[0].status.state, 'none');
  assert.equal(d.unverifiableKo.some((s) => s.includes('별도 증빙')), true);
});

// ── 5) (가) 자유 참조·누락 — 틀렸다고도 통과라고도 적지 않는다 ───────────────

test('(가) 예약 형식이 아닌 참조는 "확인할 수 없다"다 — 틀렸다고 적지 않는다', b, () => {
  const p = policy({ requirements: [{ purpose: 'personal_data_collection', required: true, noticeRef: 'tenant-notice-7' }] });
  const d = m.decideLegalBasis(query({ policy: p, consents: granted(p) }));
  assert.equal(d.allowed, true, '테넌트 자기 문구 저장소를 Core 가 금지할 근거가 없다');
  assert.equal(d.verified, false);
  assert.equal(d.notices.checks[0].status, 'unverifiable');
  assert.equal(d.notices.ready, false, '확인하지 못한 참조가 있으면 준비됨이 아니다');
});

test('(가) 필수 목적에 고지 문안 참조가 없으면 막는다 — 가리킬 문서가 없는 동의다', b, () => {
  const p = policy({ requirements: [{ purpose: 'personal_data_collection', required: true }] });
  const d = m.decideLegalBasis(query({ policy: p, consents: granted(p) }));
  assert.equal(d.allowed, false);
  assert.equal(d.notices.checks[0].status, 'absent');
  assert.equal(d.blockersKo.some((s) => s.includes('noticeRef')), true);
});

test('(가) 참조 형식 오류는 막는다 — 예약 접두사를 썼으면 읽을 수 있어야 한다', b, () => {
  const p = policy({ requirements: [{ purpose: 'personal_data_collection', required: true, noticeRef: 'legal:terms@v3' }] });
  const d = m.decideLegalBasis(query({ policy: p, consents: granted(p) }));
  assert.equal(d.allowed, false);
  assert.equal(d.notices.checks[0].status, 'malformed');
});

// ── 6) 막지 않는 경계 ────────────────────────────────────────────────────────

test('선택 목적의 문안 결함은 이 행위를 막지 않는다 — 원인과 증상이 멀어진다', b, () => {
  const p = policy({
    requirements: [
      { purpose: 'personal_data_collection', required: true, noticeRef: 'legal:privacy_policy' },
      { purpose: 'overseas_transfer', required: false, noticeRef: 'legal:terms' },
    ],
  });
  const d = m.decideLegalBasis(query({
    policy: p, consents: granted(p), action: 'transfer_overseas', docs: [finalDoc()],
  }));
  assert.equal(d.gate.allow, true, '전제: 선택 목적은 게이트를 막지 않는다');
  assert.equal(d.allowed, true);
  assert.equal(d.verified, false);
  assert.equal(d.unverifiableKo.some((s) => s.includes('선택 목적이라 이 행위를 막지 않습니다')), true);
});

test('§13-3 등록부를 선언하지 않으면 종전과 완전히 같다 — 다만 확인 못 했다고 적는다', b, () => {
  const d = m.decideLegalBasis(query({ docs: undefined, locale: undefined }));
  assert.equal(d.allowed, true);
  assert.equal(d.verified, false);
  assert.equal(d.status, 'unverified');
  assert.equal(d.notices, undefined, '검사하지 않았으면 결과를 만들지 않는다');
  assert.equal(d.unverifiableKo.some((s) => s.includes('문안 등록부를 선언하지 않아')), true);
});

test('등록부를 선언했으면 locale 선언을 강제한다 — 기본 언어를 만들지 않는다(§13-3)', b, () => {
  assert.throws(() => m.decideLegalBasis(query({ locale: undefined })), /기본 언어/);
  assert.throws(() => m.decideLegalBasis(query({ locale: '  ' })), /기본 언어/);
});

// ── 7) 동의 쪽 판정은 그대로 쓴다(§2) ───────────────────────────────────────

test('필수 동의가 없으면 가장 앞선 원인으로 적는다 — 문안을 먼저 적으면 조치가 엉뚱해진다', b, () => {
  const d = m.decideLegalBasis(query({ consents: [], docs: [draftDoc()] }));
  assert.equal(d.allowed, false);
  assert.equal(d.status, 'consent_missing');
  assert.equal(d.blockersKo.some((s) => s.includes('필수 동의가 없습니다')), true);
});

test('미승인 정책은 승인 필요로 드러난다 — 판정은 gateAction 하나다', b, () => {
  const p = policy({ approved: false });
  const d = m.decideLegalBasis(query({ policy: p, consents: granted(policy()) }));
  assert.equal(d.allowed, false);
  assert.equal(d.status, 'consent_missing');
  assert.equal(d.blockersKo.some((s) => s.includes('[승인 필요]')), true);
});

test('철회된 동의는 통과하지 않는다 — 추가 전용 이력의 최신 기록이 이긴다', b, () => {
  const p = policy();
  const records = [
    ...granted(p),
    consentMod.withdraw(p, { subjectRef: SUBJ, purpose: 'personal_data_collection', via: 'web', at: '2026-10-02T00:00:00.000Z' }),
  ];
  const d = m.decideLegalBasis(query({ consents: records }));
  assert.equal(d.allowed, false);
  assert.equal(d.status, 'consent_missing');
});

// ── 8) 격리·입력 방어 ───────────────────────────────────────────────────────

test('§11.1 정책 테넌트와 스코프가 다르면 호출 자체가 막힌다', b, () => {
  assert.throws(() => m.decideLegalBasis(query({ policy: policy({ tenantId: 'other' }) })), /§11.1/);
  assert.throws(() => m.checkConsentNotices({ scope: S, policy: policy({ tenantId: 'other' }), docs: [], locale: LOCALE, now: NOW }), /§11.1/);
});

test('§11.1 스코프가 없거나 형식을 어기면 막힌다', b, () => {
  assert.throws(() => m.decideLegalBasis(query({ scope: {} })));
  assert.throws(() => m.decideLegalBasis(query({ scope: { tenantId: 'BAD TENANT' } })));
});

test('§10.3 주체 참조에 개인정보 원문이 오면 막힌다', b, () => {
  assert.throws(() => m.decideLegalBasis(query({ subjectRef: '010-1234-5678' })), /개인정보/);
});

test('계약에 없는 행위는 거절한다 — 가까운 행위로 바꿔 읽지 않는다', b, () => {
  assert.throws(() => m.decideLegalBasis(query({ action: 'do_anything' })), /계약에 없는 행위/);
});

test('계약 버전·접두사가 노출된다', b, () => {
  assert.equal(typeof m.LEGAL_BASIS_CONTRACT_VERSION, 'number');
  assert.equal(m.LEGAL_NOTICE_REF_PREFIX, 'legal:');
});
