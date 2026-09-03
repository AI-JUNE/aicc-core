// 파트너 귀속·정산 근거 테스트 — 정상 경로 + 실패 경로.
// 실제 청구·송금은 하지 않는다. 근거 계산만 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAttribution, attributionOk, buildAttribution, partnerScopedFilter, visibleToPartner,
  currentAttribution, findAttributionConflicts, rollupByPartner, buildSettlementLines, settlementBlockers,
} from '../src/partner/attribution.ts';

const scope = { tenantId: 'goone' };
const wsScope = { tenantId: 'goone', workspaceId: 'cs' };
const clock = () => Date.UTC(2026, 8, 3, 1, 0, 0);

const partnerInput = {
  accountId: 'acct-hana',
  partner: { partnerId: 'j2tw', role: 'operator' },
  acquisition: 'partner_referral',
  contractDate: '2026-04-01',
};

// ── 검증 ─────────────────────────────────────────────────────────────────────

test('정상: 파트너 유입 기록이 검증을 통과한다', () => {
  const issues = validateAttribution(scope, partnerInput);
  assert.deepEqual(issues, []);
  assert.equal(attributionOk(issues), true);
});

test('정상: 파트너 없는 직접 계약도 통과한다(partner_id 는 nullable)', () => {
  const issues = validateAttribution(scope, { accountId: 'acct-direct', partner: { partnerId: null }, acquisition: 'direct' });
  assert.deepEqual(issues, []);
});

test('실패: 스코프 없는 접근은 막는다(§11.1)', () => {
  const issues = validateAttribution({ tenantId: '' }, partnerInput);
  assert.ok(issues.some((i) => i.code === 'E_SCOPE' && i.severity === 'error'));
});

test('실패: 파트너 유입인데 파트너가 없으면 거부한다', () => {
  const issues = validateAttribution(scope, { accountId: 'acct-x', partner: { partnerId: null }, acquisition: 'partner_managed' });
  assert.ok(issues.some((i) => i.code === 'E_ACQUISITION' && i.severity === 'error'));
  assert.equal(attributionOk(issues), false);
});

test('실패: 직접 계약인데 파트너가 붙어 있으면 거부한다', () => {
  const issues = validateAttribution(scope, { accountId: 'acct-x', partner: { partnerId: 'j2tw' }, acquisition: 'direct' });
  assert.ok(issues.some((i) => i.code === 'E_ACQUISITION' && i.severity === 'error'));
});

test('실패: 식별자·날짜 형식 위반을 항목 단위로 돌려준다', () => {
  const issues = validateAttribution(scope, {
    accountId: 'ACCT Hana', partner: { partnerId: 'J2 TW' }, acquisition: 'partner_referral', contractDate: '2026-02-30',
  });
  assert.deepEqual(issues.map((i) => i.code).sort(), ['E_ACCOUNT', 'E_DATE', 'E_PARTNER']);
});

test('실패: 근거 참조에 개인정보가 섞이면 저장 전에 잡는다(§10.3)', () => {
  const issues = validateAttribution(scope, { ...partnerInput, evidenceRef: '메일 010-1234-5678 참조' });
  assert.ok(issues.some((i) => i.code === 'E_PII'));
});

test('경계: 유입 경로 미확정은 경고이며 통과는 하되 집계에서 빠진다', () => {
  const issues = validateAttribution(scope, { accountId: 'acct-x', partner: { partnerId: null }, acquisition: 'unknown' });
  assert.equal(attributionOk(issues), true);
  assert.ok(issues.some((i) => i.severity === 'warning'));
});

// ── 기록 생성 ────────────────────────────────────────────────────────────────

test('정상: 담당자·사유는 마스킹을 거쳐 저장된다(§10.3)', () => {
  const { record } = buildAttribution(scope, {
    ...partnerInput, owner: '김담당 010-1234-5678', changeReason: '담당 교체 010-9876-5432',
  }, { clock });
  assert.ok(!record.ownerMasked.includes('010-1234-5678'));
  assert.ok(!record.changeReasonMasked.includes('010-9876-5432'));
  assert.equal(record.tenantId, 'goone');
  assert.equal(record.recordedAt, '2026-09-03T01:00:00.000Z');
});

test('정상: 시계를 주입하지 않으면 기록 시각을 만들어 넣지 않는다(§13-3)', () => {
  const { record } = buildAttribution(scope, partnerInput);
  assert.equal('recordedAt' in record, false);
});

test('실패: 검증에 걸리면 기록을 만들지 않는다', () => {
  const { record, issues } = buildAttribution(scope, { accountId: 'BAD ID', partner: { partnerId: null }, acquisition: 'direct' });
  assert.equal(record, undefined);
  assert.ok(issues.length > 0);
});

test('정상: workspace 스코프가 기록에 반영된다(§11.1)', () => {
  const { record } = buildAttribution(wsScope, partnerInput);
  assert.equal(record.workspaceId, 'cs');
});

// ── 조회 ─────────────────────────────────────────────────────────────────────

test('정상: 조회 조건에 테넌트가 강제 주입되고 호출자가 덮어쓸 수 없다(§11.1)', () => {
  const f = partnerScopedFilter(wsScope, { partnerId: 'j2tw', tenantId: 'other' });
  assert.equal(f.tenantId, 'goone');
  assert.equal(f.workspaceId, 'cs');
  assert.equal(f.partnerId, 'j2tw');
});

test('경계: partnerId 생략과 null 은 다른 뜻이다', () => {
  assert.equal('partnerId' in partnerScopedFilter(scope, {}), false);       // 전체
  assert.equal(partnerScopedFilter(scope, { partnerId: null }).partnerId, null); // 직접 계약만
});

test('실패: 스코프 없는 조회 조건 생성은 던진다', () => {
  assert.throws(() => partnerScopedFilter({ tenantId: '' }), /§11.1/);
});

const history = [
  { tenantId: 'goone', accountId: 'acct-a', partnerId: 'j2tw', acquisition: 'partner_referral', contractDate: '2026-01-10' },
  { tenantId: 'goone', accountId: 'acct-b', partnerId: null, acquisition: 'direct', contractDate: '2026-02-01' },
  { tenantId: 'other', accountId: 'acct-z', partnerId: 'j2tw', acquisition: 'partner_managed', contractDate: '2026-03-01' },
];

test('정상: 파트너 담당자는 자기가 유치한 고객사만 본다', () => {
  const seen = visibleToPartner(history, scope, 'j2tw');
  assert.deepEqual(seen.map((r) => r.accountId), ['acct-a']);
});

test('정상: 내부 조회(viewer null)는 테넌트 안 전체를 본다', () => {
  const seen = visibleToPartner(history, scope, null);
  assert.deepEqual(seen.map((r) => r.accountId), ['acct-a', 'acct-b']);
});

test('실패: 다른 테넌트 레코드는 어떤 뷰어에게도 보이지 않는다(§11.1)', () => {
  assert.equal(visibleToPartner(history, scope, 'j2tw').some((r) => r.tenantId === 'other'), false);
  assert.equal(visibleToPartner(history, scope, null).some((r) => r.tenantId === 'other'), false);
});

test('경계: 빈 이력은 빈 목록이며 던지지 않는다', () => {
  assert.deepEqual(visibleToPartner([], scope, 'j2tw'), []);
  assert.deepEqual(rollupByPartner([], scope), []);
  assert.deepEqual(findAttributionConflicts([]), []);
  assert.deepEqual(buildSettlementLines([]), []);
});

// ── 이력·충돌 ────────────────────────────────────────────────────────────────

const reassigned = [
  { tenantId: 'goone', accountId: 'acct-a', partnerId: 'j2tw', acquisition: 'partner_referral', contractDate: '2026-01-10' },
  { tenantId: 'goone', accountId: 'acct-a', partnerId: 'other-partner', acquisition: 'partner_managed', contractDate: '2026-06-01' },
];

test('정상: 현재 유효 귀속은 계약일이 늦은 것이다', () => {
  assert.equal(currentAttribution(reassigned, 'acct-a').partnerId, 'other-partner');
});

test('경계: 계약일이 같으면 나중에 기록된 것을 쓴다', () => {
  const rows = [
    { tenantId: 'goone', accountId: 'a', partnerId: 'p1', acquisition: 'partner_referral', contractDate: '2026-01-01', recordedAt: '2026-01-01T00:00:00.000Z' },
    { tenantId: 'goone', accountId: 'a', partnerId: 'p2', acquisition: 'partner_referral', contractDate: '2026-01-01', recordedAt: '2026-05-01T00:00:00.000Z' },
  ];
  assert.equal(currentAttribution(rows, 'a').partnerId, 'p2');
});

test('경계: 없는 고객사는 undefined 다(빈 값을 지어내지 않는다)', () => {
  assert.equal(currentAttribution(reassigned, 'acct-none'), undefined);
});

test('실패 예방: 귀속 충돌은 자동으로 고르지 않고 드러낸다 [승인 필요]', () => {
  const conflicts = findAttributionConflicts(reassigned);
  assert.deepEqual(conflicts, [{ accountId: 'acct-a', partnerIds: ['j2tw', 'other-partner'] }]);
});

// ── 정산 근거 ────────────────────────────────────────────────────────────────

const forRollup = [
  { tenantId: 'goone', accountId: 'acct-a', partnerId: 'j2tw', acquisition: 'partner_referral', contractDate: '2026-01-10' },
  { tenantId: 'goone', accountId: 'acct-a', partnerId: 'j2tw', acquisition: 'partner_managed', contractDate: '2026-06-01' },
  { tenantId: 'goone', accountId: 'acct-b', partnerId: null, acquisition: 'direct', contractDate: '2026-02-01' },
  { tenantId: 'goone', accountId: 'acct-c', partnerId: 'j2tw', acquisition: 'unknown' },
];

test('정상: 고객사는 현재 유효 귀속으로 한 번만 집계된다(이력 중복 방지)', () => {
  const rows = rollupByPartner(forRollup, scope);
  const j2 = rows.find((r) => r.partnerId === 'j2tw');
  assert.deepEqual(j2.accountIds, ['acct-a', 'acct-c']);
  assert.equal(j2.byAcquisition.partner_managed, 1);
  assert.equal(j2.byAcquisition.partner_referral, 0); // 옛 귀속은 세지 않는다
  assert.equal(j2.excludedUnknown, 1);
});

test('정상: 실적·요율이 모두 있어야 수수료를 산출한다', () => {
  const rows = rollupByPartner(forRollup.slice(0, 3), scope);
  const lines = buildSettlementLines(rows, { billedByPartner: { j2tw: 1_000_000 }, ratesByPartner: { j2tw: 0.15 } });
  const j2 = lines.find((l) => l.partnerId === 'j2tw');
  assert.equal(j2.commissionAmount, 150_000);
  const direct = lines.find((l) => l.partnerId === null);
  assert.equal(direct.commissionAmount, undefined);
  assert.ok(direct.notesKo.some((n) => n.includes('수수료 대상이 아닙니다')));
});

test('실패: 요율이 없으면 0원으로 채우지 않고 이유를 남긴다(§13-3)', () => {
  const rows = rollupByPartner(forRollup.slice(0, 2), scope);
  const [line] = buildSettlementLines(rows, { billedByPartner: { j2tw: 1_000_000 } });
  assert.equal(line.commissionAmount, undefined);
  assert.equal(line.billedAmount, 1_000_000);
  assert.ok(line.notesKo.some((n) => n.includes('수수료율이 설정되지 않았습니다')));
});

test('실패: 실적이 없으면 금액을 만들지 않는다', () => {
  const rows = rollupByPartner(forRollup.slice(0, 2), scope);
  const [line] = buildSettlementLines(rows, { ratesByPartner: { j2tw: 0.15 } });
  assert.equal(line.commissionAmount, undefined);
  assert.ok(line.notesKo.some((n) => n.includes('실측 청구액이 없어')));
});

test('실패 예방: 미확정·충돌이 있으면 정산을 막는다', () => {
  const rows = rollupByPartner(forRollup, scope);
  const blockers = settlementBlockers(rows, findAttributionConflicts(forRollup));
  assert.equal(blockers.length, 1);
  assert.ok(blockers[0].includes('미확정 1건'));

  const clean = rollupByPartner(forRollup.slice(0, 3), scope);
  assert.deepEqual(settlementBlockers(clean, []), []);
});

test('실패: 스코프 없는 집계는 던진다(§11.1)', () => {
  assert.throws(() => rollupByPartner(forRollup, { tenantId: '' }), /§11.1/);
});
