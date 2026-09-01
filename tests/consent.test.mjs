import { test } from 'node:test';
import assert from 'node:assert/strict';

let K = null;
try { K = await import('../src/consent/consent.ts'); } catch { /* 구형 런타임 */ }
const behavioral = { skip: K ? false : '타입 스트리핑 미지원 런타임' };

const policy = {
  tenantId: 't_bank', version: 2, updatedAt: '2026-08-01T00:00:00.000Z', updatedBy: 'legal', approved: true,
  requirements: [
    { purpose: 'personal_data_collection', required: true, noticeRef: 'notice/pd/v2', validForDays: 365 },
    { purpose: 'recording', required: true, noticeRef: 'notice/rec/v2' },
    { purpose: 'ai_processing', required: true },
    { purpose: 'marketing', required: false },
  ],
};
const SUBJ = 'sha256:9f2c';
const NOW = '2026-09-01T00:00:00.000Z';

const granted = (purpose, at = '2026-08-20T00:00:00.000Z') => ({
  tenantId: 't_bank', subjectRef: SUBJ, purpose, state: 'granted', at, via: 'voice', policyVersion: 2,
});

test('정상 정책은 검증을 통과한다', behavioral, () => {
  assert.deepEqual(K.validateConsentPolicy(policy), []);
  assert.equal(K.consentPolicyOk([]), true);
});

test('미승인 정책·중복 목적·잘못된 유효기간은 오류다', behavioral, () => {
  const bad = { ...policy, approved: false, requirements: [
    { purpose: 'recording', required: true },
    { purpose: 'recording', required: true },
    { purpose: 'marketing', required: false, validForDays: 0 },
  ] };
  const codes = K.validateConsentPolicy(bad).map(i => i.code);
  assert.ok(codes.includes('E_NOT_APPROVED'));
  assert.ok(codes.includes('E_DUPLICATE_PURPOSE'));
  assert.ok(codes.includes('E_VALIDITY_INVALID'));
  assert.equal(K.consentPolicyOk(K.validateConsentPolicy(bad)), false);
});

test('마케팅 필수 동의는 경고로 드러난다(동의 강제 지적 유형)', behavioral, () => {
  const p = { ...policy, requirements: [{ purpose: 'marketing', required: true }] };
  assert.ok(K.validateConsentPolicy(p).some(i => i.code === 'W_MARKETING_REQUIRED'));
});

test('동의 주체 참조에 개인정보 원문은 들어갈 수 없다(§10.3)', behavioral, () => {
  assert.throws(() => K.assertSubjectRef('010-1234-5678'), /§10\.3/);
  assert.throws(() => K.assertSubjectRef('900101-1234567'), /§10\.3/);
  assert.doesNotThrow(() => K.assertSubjectRef(SUBJ));
});

test('물어본 적 없으면 not_asked — 통과가 아니다', behavioral, () => {
  assert.equal(K.currentState(policy, [], 'recording', SUBJ, NOW), 'not_asked');
});

test('가장 최근 기록이 이긴다 — 동의 → 철회 → 재동의', behavioral, () => {
  let rs = [];
  rs = K.appendRecord(rs, granted('recording', '2026-08-01T00:00:00.000Z'));
  assert.equal(K.currentState(policy, rs, 'recording', SUBJ, NOW), 'granted');
  rs = K.appendRecord(rs, { ...granted('recording', '2026-08-10T00:00:00.000Z'), state: 'withdrawn' });
  assert.equal(K.currentState(policy, rs, 'recording', SUBJ, NOW), 'withdrawn');
  rs = K.appendRecord(rs, granted('recording', '2026-08-20T00:00:00.000Z'));
  assert.equal(K.currentState(policy, rs, 'recording', SUBJ, NOW), 'granted');
  assert.equal(rs.length, 3);  // append-only
});

test('유효기간이 지난 동의는 expired 로 계산된다', behavioral, () => {
  const old = [granted('personal_data_collection', '2025-01-01T00:00:00.000Z')];
  assert.equal(K.currentState(policy, old, 'personal_data_collection', SUBJ, NOW), 'expired');
  // 유효기간 미설정 목적은 만료를 판정하지 않는다(§13-3 임의 기본값 금지)
  const oldRec = [granted('recording', '2020-01-01T00:00:00.000Z')];
  assert.equal(K.currentState(policy, oldRec, 'recording', SUBJ, NOW), 'granted');
});

test('필수 동의를 얻으면 행위가 허용된다', behavioral, () => {
  const rs = [granted('recording')];
  const d = K.gateAction(policy, rs, 'record_call', SUBJ, NOW);
  assert.equal(d.allow, true);
  assert.deepEqual(d.purposes, ['recording']);
});

test('필수 동의가 없으면 행위가 차단된다(§10.1)', behavioral, () => {
  const d = K.gateAction(policy, [], 'record_call', SUBJ, NOW);
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'consent_missing');
  assert.equal(d.blockedBy[0].purpose, 'recording');
  assert.equal(d.blockedBy[0].state, 'not_asked');
});

test('국외 이전은 수집·이용 동의까지 함께 요구한다(§10.3)', behavioral, () => {
  const rs = [granted('personal_data_collection')];
  const d = K.gateAction(policy, rs, 'transfer_overseas', SUBJ, NOW);
  assert.equal(d.allow, false);
  assert.deepEqual(d.blockedBy.map(b => b.purpose), ['overseas_transfer']);
  assert.equal(d.blockedBy[0].declared, false);  // 정책 선언 누락은 통과가 아니다
});

test('선택 동의는 행위를 막지 않는다', behavioral, () => {
  const d = K.gateAction(policy, [], 'marketing_followup', SUBJ, NOW);
  assert.equal(d.allow, true);
});

test('미승인 정책으로는 아무 행위도 허용되지 않고 기록도 못 남긴다', behavioral, () => {
  const p = { ...policy, approved: false };
  assert.equal(K.gateAction(p, [granted('recording')], 'record_call', SUBJ, NOW).reason, 'policy_not_approved');
  assert.throws(() => K.grant(p, { subjectRef: SUBJ, purpose: 'recording', via: 'voice', at: NOW }), /§10\.1/);
});

test('다른 테넌트 스코프로는 동의를 판정할 수 없다(§11.1)', behavioral, () => {
  assert.throws(() => K.gateAction(policy, [], 'record_call', SUBJ, NOW, { tenantId: 't_other' }), /§11\.1/);
  assert.doesNotThrow(() => K.gateAction(policy, [], 'record_call', SUBJ, NOW, { tenantId: 't_bank' }));
});

test('기록 생성기는 정책 버전을 함께 남긴다 — 어떤 문구로 받은 동의인지', behavioral, () => {
  const r = K.grant(policy, { subjectRef: SUBJ, purpose: 'recording', via: 'voice', at: NOW, interactionId: 'i_1' });
  assert.equal(r.policyVersion, 2);
  assert.equal(r.tenantId, 't_bank');
  assert.equal(r.state, 'granted');
  assert.equal(K.deny(policy, { subjectRef: SUBJ, purpose: 'marketing', via: 'chat', at: NOW }).state, 'denied');
  assert.equal(K.withdraw(policy, { subjectRef: SUBJ, purpose: 'recording', via: 'chat', at: NOW }).state, 'withdrawn');
});

test('행위-목적 매핑은 모든 게이트 행위를 덮는다', behavioral, () => {
  for (const [action, purposes] of Object.entries(K.ACTION_PURPOSES)) {
    assert.ok(purposes.length > 0, `${action} 매핑 누락`);
  }
});
