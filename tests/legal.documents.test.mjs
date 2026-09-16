// 약관·개인정보 처리방침 버전 관리 — §10.1·§10.3·§11.1·§13-3.
// 핵심은 "초안이 확정본 자리에 나가지 않는다"와 "확정본이 바뀌면 이전 수락은 근거가 아니다"이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let L = null;
try { L = await import('../src/legal/documents.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: L ? false : '타입 스트리핑 미지원 런타임' };

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const NOW = '2026-09-16T00:00:00.000Z';
const SCOPE = { tenantId: 't_bank' };
const APPROVAL = { approvalRef: 'LEGAL-2026-014', approvedBy: '법무팀 김OO 010-1234-5678', approvedAt: '2026-09-01T00:00:00.000Z' };

const draft = (over = {}) => ({
  kind: 'terms', locale: 'ko-KR', version: 1, status: 'draft',
  content: '제1조(목적) 이 약관은 고원 AICC 서비스 이용 조건을 정한다.', ...over,
});
const finalDoc = (over = {}) => L.finalizeDocument(draft(over), { approval: APPROVAL, effectiveFrom: '2026-09-10T00:00:00.000Z' }, sha);

// ── 검증 ───────────────────────────────────────────────────────────────────

test('정상 초안은 검증을 통과하고, 자리표시자가 남은 초안은 경고만 받는다', b, () => {
  assert.deepEqual(L.validateLegalDocument(draft()), []);
  const w = L.validateLegalDocument(draft({ content: '{{회사명}} 약관' }));
  assert.deepEqual(w.map((i) => [i.code, i.severity]), [['W_DRAFT_PLACEHOLDER', 'warning']]);
  assert.equal(L.legalDocumentOk(w), true);
});

test('확정본은 승인 근거·시행일·본문·해시가 모두 있어야 한다 — 하나라도 빠지면 오류', b, () => {
  const bare = { ...draft(), status: 'final' };
  const codes = L.validateLegalDocument(bare).map((i) => i.code);
  assert.ok(codes.includes('E_FINAL_NO_APPROVAL'));
  assert.ok(codes.includes('E_FINAL_NO_EFFECTIVE'));
  assert.ok(codes.includes('E_FINAL_NO_HASH'));
  assert.equal(L.legalDocumentOk(L.validateLegalDocument(bare)), false);

  const empty = L.validateLegalDocument({ ...finalDoc(), content: '   ' });
  assert.ok(empty.some((i) => i.code === 'E_FINAL_EMPTY'));
});

test('확정 뒤 본문을 고치면 해시 불일치로 거부된다', b, () => {
  const f = finalDoc();
  assert.deepEqual(L.validateLegalDocument(f, { hash: sha }), []);
  const tampered = { ...f, content: f.content + ' (몰래 추가)' };
  const codes = L.validateLegalDocument(tampered, { hash: sha }).map((i) => i.code);
  assert.deepEqual(codes, ['E_FINAL_HASH_MISMATCH']);
});

test('자리표시자가 남은 문서는 확정할 수 없다 — 초안이 확정본으로 둔갑하는 가장 흔한 경로', b, () => {
  for (const content of ['{{회사명}} 약관', '연락처: [TODO 담당자]', '시행일: [확인 필요]', '주소: ________']) {
    assert.throws(() => L.finalizeDocument(draft({ content }), { approval: APPROVAL, effectiveFrom: '2026-09-10T00:00:00.000Z' }, sha),
      /자리표시자/, content);
  }
});

test('잘못된 종류·언어·버전·테넌트 형식은 오류다. 기본 언어를 만들지 않는다(§13-3)', b, () => {
  const codes = L.validateLegalDocument({ ...draft(), kind: 'cookie', locale: '', version: 0, tenantId: 'Bad Tenant' }).map((i) => i.code);
  assert.deepEqual(codes.sort(), ['E_KIND', 'E_LOCALE', 'E_TENANT_INVALID', 'E_VERSION']);
});

// ── 확정 ───────────────────────────────────────────────────────────────────

test('finalizeDocument 는 원본을 고치지 않고 해시·승인을 붙이며, 승인자 개인정보는 한 번 마스킹된다(§10.3)', b, () => {
  const d = draft();
  const f = L.finalizeDocument(d, { approval: APPROVAL, effectiveFrom: '2026-09-10T00:00:00.000Z', changeNoteKo: '문의 010-9999-8888 로' }, sha);
  assert.equal(d.status, 'draft');
  assert.equal(f.status, 'final');
  assert.equal(f.contentHash, sha(d.content));
  assert.equal(f.approval.approvalRef, 'LEGAL-2026-014');
  assert.doesNotMatch(f.approval.approvedBy, /1234-5678/);
  assert.doesNotMatch(f.changeNoteKo, /9999-8888/);
});

test('승인 근거 없이·이미 확정된 문서를·시행일 없이 확정할 수 없다', b, () => {
  assert.throws(() => L.finalizeDocument(draft(), { approval: { ...APPROVAL, approvalRef: '' }, effectiveFrom: '2026-09-10T00:00:00.000Z' }, sha), /승인 근거/);
  assert.throws(() => L.finalizeDocument(finalDoc(), { approval: APPROVAL, effectiveFrom: '2026-09-10T00:00:00.000Z' }, sha), /이미 확정/);
  assert.throws(() => L.finalizeDocument(draft(), { approval: APPROVAL, effectiveFrom: 'not-a-date' }, sha), /시행일/);
});

// ── 등록부 ─────────────────────────────────────────────────────────────────

test('등록부는 추가 전용이며 등록된 문서는 동결된다', b, () => {
  const reg = L.createLegalRegistry([], { hash: sha });
  const f = reg.add(finalDoc());
  assert.ok(Object.isFrozen(f));
  assert.throws(() => { f.content = 'x'; });
  assert.equal(reg.list().length, 1);
});

test('같은 계열의 중복 버전과 확정본 버전 역행은 등록이 거부된다', b, () => {
  const reg = L.createLegalRegistry([finalDoc({ version: 3 })], { hash: sha });
  assert.throws(() => reg.add(finalDoc({ version: 3 })), /같은 버전/);
  assert.throws(() => reg.add(finalDoc({ version: 2 })), /역행/);
  // 다른 언어 계열은 별개다
  reg.add(finalDoc({ version: 1, locale: 'en-US', content: 'Article 1 (Purpose)' }));
  assert.equal(reg.list().length, 2);
});

test('해시가 어긋난 확정본은 등록부가 받지 않는다', b, () => {
  const reg = L.createLegalRegistry([], { hash: sha });
  const f = finalDoc();
  assert.throws(() => reg.add({ ...f, content: f.content + '!' }), /해시/);
});

// ── 조회 ───────────────────────────────────────────────────────────────────

test('조회는 확정본만 돌려준다 — 초안만 있으면 없음과 이유(승인 필요)를 돌려준다', b, () => {
  const r = L.currentDocument([draft()], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(r.found, false);
  assert.equal(r.pendingDrafts, 1);
  assert.match(r.reasonKo, /초안만.*승인 필요/);
});

test('빈 등록부는 없음이며 문서 없음 사유를 돌려준다', b, () => {
  const r = L.currentDocument([], { kind: 'privacy_policy', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(r.found, false);
  assert.equal(r.pendingDrafts, 0);
  assert.match(r.reasonKo, /문서가 없습니다/);
});

test('시행일 전 확정본은 나가지 않고, 시행일이 되면 나간다', b, () => {
  const f = L.finalizeDocument(draft(), { approval: APPROVAL, effectiveFrom: '2026-10-01T00:00:00.000Z' }, sha);
  const before = L.currentDocument([f], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(before.found, false);
  assert.equal(before.notYetEffective, 1);
  const after = L.currentDocument([f], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: '2026-10-01T00:00:00.000Z' });
  assert.equal(after.found, true);
});

test('여러 확정본이 있으면 가장 최근 시행본이 현재이고, 테넌트 전용 문안이 공통 문안보다 우선한다', b, () => {
  const v1 = L.finalizeDocument(draft({ version: 1 }), { approval: APPROVAL, effectiveFrom: '2026-01-01T00:00:00.000Z' }, sha);
  const v2 = L.finalizeDocument(draft({ version: 2, content: '개정 약관' }), { approval: APPROVAL, effectiveFrom: '2026-06-01T00:00:00.000Z' }, sha);
  const r = L.currentDocument([v1, v2], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(r.found, true);
  assert.equal(r.doc.version, 2);
  assert.equal(r.source, 'service');

  const tenantV1 = L.finalizeDocument(draft({ version: 1, tenantId: 't_bank', content: '은행 전용 약관' }), { approval: APPROVAL, effectiveFrom: '2026-03-01T00:00:00.000Z' }, sha);
  const r2 = L.currentDocument([v1, v2, tenantV1], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(r2.source, 'tenant');
  assert.equal(r2.doc.content, '은행 전용 약관');
});

test('다른 테넌트 전용 문안은 어떤 조건에서도 나가지 않는다(§11.1)', b, () => {
  const other = L.finalizeDocument(draft({ tenantId: 't_insurer', content: '보험사 전용' }), { approval: APPROVAL, effectiveFrom: '2026-01-01T00:00:00.000Z' }, sha);
  const r = L.currentDocument([other], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(r.found, false);
  assert.throws(() => L.currentDocument([other], { kind: 'terms', scope: { tenantId: '' }, locale: 'ko-KR', now: NOW }), /tenant_id/);
});

test('다른 언어로 조용히 대체하지 않으며, now·locale 이 없으면 던진다(§13-3)', b, () => {
  const f = finalDoc();
  assert.equal(L.currentDocument([f], { kind: 'terms', scope: SCOPE, locale: 'en-US', now: NOW }).found, false);
  assert.throws(() => L.currentDocument([f], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: 'yesterday' }), /ISO8601/);
  assert.throws(() => L.currentDocument([f], { kind: 'terms', scope: SCOPE, locale: '', now: NOW }), /locale/);
});

// ── 수락 기록 ──────────────────────────────────────────────────────────────

test('수락 기록은 추가 전용이며 어떤 버전·해시를 수락했는지 남긴다', b, () => {
  const f = finalDoc();
  const before = [];
  const after = L.recordAcceptance(before, { tenantId: 't_bank', subjectRef: 'sha256:9f2c', doc: f, at: NOW, via: 'chat', evidenceRef: 'rec/010-1111-2222' });
  assert.equal(before.length, 0);
  assert.equal(after.length, 1);
  assert.equal(after[0].version, 1);
  assert.equal(after[0].contentHash, f.contentHash);
  assert.doesNotMatch(after[0].evidenceRef, /1111-2222/);
});

test('초안·다른 테넌트 문서·원문 개인정보 주체·빈 경로에 대한 수락은 기록하지 않는다', b, () => {
  const f = finalDoc();
  assert.throws(() => L.recordAcceptance([], { tenantId: 't_bank', subjectRef: 'k1', doc: draft(), at: NOW, via: 'chat' }), /확정본이 아닌/);
  const other = L.finalizeDocument(draft({ tenantId: 't_insurer' }), { approval: APPROVAL, effectiveFrom: '2026-01-01T00:00:00.000Z' }, sha);
  assert.throws(() => L.recordAcceptance([], { tenantId: 't_bank', subjectRef: 'k1', doc: other, at: NOW, via: 'chat' }), /다른 테넌트/);
  assert.throws(() => L.recordAcceptance([], { tenantId: 't_bank', subjectRef: '010-1234-5678', doc: f, at: NOW, via: 'chat' }), /개인정보 원문/);
  assert.throws(() => L.recordAcceptance([], { tenantId: 't_bank', subjectRef: 'k1', doc: f, at: NOW, via: '' }), /via/);
  assert.throws(() => L.recordAcceptance([], { tenantId: 't_bank', subjectRef: 'k1', doc: f, at: 'x', via: 'chat' }), /ISO8601/);
});

test('확정본이 바뀌면 이전 수락은 stale 이고, 기록이 없으면 none, 확정본이 없으면 unavailable 이다', b, () => {
  const v1 = L.finalizeDocument(draft({ version: 1 }), { approval: APPROVAL, effectiveFrom: '2026-01-01T00:00:00.000Z' }, sha);
  const v2 = L.finalizeDocument(draft({ version: 2, content: '개정 약관' }), { approval: APPROVAL, effectiveFrom: '2026-06-01T00:00:00.000Z' }, sha);
  const recs = L.recordAcceptance([], { tenantId: 't_bank', subjectRef: 'k1', doc: v1, at: '2026-02-01T00:00:00.000Z', via: 'voice' });

  const curV1 = L.currentDocument([v1], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(L.acceptanceStatus(recs, 'k1', curV1, SCOPE).state, 'current');

  const curV2 = L.currentDocument([v1, v2], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  const st = L.acceptanceStatus(recs, 'k1', curV2, SCOPE);
  assert.equal(st.state, 'stale');
  assert.equal(st.acceptedVersion, 1);
  assert.equal(st.currentVersion, 2);

  assert.equal(L.acceptanceStatus(recs, 'k2', curV2, SCOPE).state, 'none');
  const none = L.currentDocument([], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(L.acceptanceStatus(recs, 'k1', none, SCOPE).state, 'unavailable');
});

test('수락 판정은 테넌트 경계를 넘지 않는다 — 다른 테넌트의 기록은 보이지 않는다(§11.1)', b, () => {
  const v1 = finalDoc();
  const recs = L.recordAcceptance([], { tenantId: 't_insurer', subjectRef: 'k1', doc: v1, at: NOW, via: 'web' });
  const cur = L.currentDocument([v1], { kind: 'terms', scope: SCOPE, locale: 'ko-KR', now: NOW });
  assert.equal(L.acceptanceStatus(recs, 'k1', cur, SCOPE).state, 'none');
});

// ── 준비도 ─────────────────────────────────────────────────────────────────

test('준비도는 초안만 있는 종류를 준비됨으로 적지 않고 [승인 필요] 로 드러낸다', b, () => {
  const terms = finalDoc();
  const privacyDraft = draft({ kind: 'privacy_policy', content: '개인정보 처리방침 {{시행일}}' });
  const r = L.legalReadiness([terms, privacyDraft], { scope: SCOPE, locales: ['ko-KR'], now: NOW });
  assert.equal(r.ready, false);
  assert.deepEqual(r.items.map((i) => [i.kind, i.status]), [['terms', 'final'], ['privacy_policy', 'draft_only']]);
  assert.equal(r.blockersKo.length, 1);
  assert.match(r.blockersKo[0], /승인 필요/);
  const text = L.formatLegalReadiness(r);
  assert.match(text, /미완/);
  assert.match(text, /privacy_policy\/ko-KR: 초안만 1건/);
});

test('둘 다 확정본이면 준비됨이고, locales 가 비면 던진다(§13-3)', b, () => {
  const terms = finalDoc();
  const privacy = L.finalizeDocument(draft({ kind: 'privacy_policy', content: '개인정보 처리방침 본문' }), { approval: APPROVAL, effectiveFrom: '2026-09-01T00:00:00.000Z' }, sha);
  const r = L.legalReadiness([terms, privacy], { scope: SCOPE, locales: ['ko-KR'], now: NOW });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockersKo, []);
  assert.match(L.formatLegalReadiness(r), /준비됨/);
  assert.throws(() => L.legalReadiness([terms], { scope: SCOPE, locales: [], now: NOW }), /locales/);
});
