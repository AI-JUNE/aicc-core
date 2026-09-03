// 파트너 역할 권한.
//
// 이 테스트가 지키는 한 문장: **파트너 담당자는 자기가 유치한 고객사 외에는 어떤 경로로도 보지 못한다.**
// 특히 "값이 안 들어간 계정이 전체를 본다"는 사고 경로를 명시적으로 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/partner/rbac.ts';
import { buildAttribution } from '../src/partner/attribution.ts';
import { emptyChain, verifyChain } from '../src/audit/log.ts';
import { createHash } from 'node:crypto';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const scope = { tenantId: 't1' };
const ON = { activation: 'enabled', approvalRef: 'APPROVAL-2026-09-03' };
const ROUTE = m.PARTNER_ROUTE_ALLOWLIST[0];

const partner = (over = {}) => ({ userId: 'u-p1', tenantId: 't1', roles: ['partner_admin'], partnerId: 'j2mr1', ...over });
const internal = (over = {}) => ({ userId: 'u-a1', tenantId: 't1', roles: ['admin'], ...over });

// ── 활성화 ───────────────────────────────────────────────────────────────────

test('기본은 비활성이다 — 켜려면 승인 근거가 필요하다', () => {
  assert.equal(m.partnerRbacEnabled(), false);
  assert.equal(m.partnerRbacEnabled({ activation: 'enabled' }), false, '승인 근거 없는 enabled 는 켜진 것이 아니다');
  assert.equal(m.partnerRbacEnabled({ activation: 'disabled', approvalRef: 'X' }), false);
  assert.equal(m.partnerRbacEnabled(ON), true);
});

test('비활성 상태의 접근은 거부되고 사유가 남는다', () => {
  const d = m.decidePartnerAccess({ scope, actor: partner(), routeId: ROUTE });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'activation_pending');
});

// ── 판정 ─────────────────────────────────────────────────────────────────────

test('활성 + 결속된 파트너는 허용 목록 화면에 들어간다', () => {
  const d = m.decidePartnerAccess({ scope, actor: partner(), routeId: ROUTE }, ON);
  assert.equal(d.allowed, true);
  assert.equal(d.scopedPartnerId, 'j2mr1');
  assert.equal(d.route.id, ROUTE);
});

test('partnerId 없는 계정은 전체 조회가 아니라 거부다', () => {
  for (const actor of [partner({ partnerId: null }), partner({ partnerId: undefined })]) {
    const d = m.decidePartnerAccess({ scope, actor, routeId: ROUTE }, ON);
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'partner_unbound');
    assert.equal(d.scopedPartnerId, undefined);
  }
});

test('파트너 식별자 형식이 틀리면 거부한다', () => {
  const d = m.decidePartnerAccess({ scope, actor: partner({ partnerId: 'A B!' }), routeId: ROUTE }, ON);
  assert.equal(d.reason, 'partner_invalid');
});

test('내부 역할과 혼용된 계정은 설정 오류로 거부한다', () => {
  const d = m.decidePartnerAccess({ scope, actor: partner({ roles: ['partner_admin', 'admin'] }), routeId: ROUTE }, ON);
  assert.equal(d.reason, 'role_mix');
});

test('허용 목록에 없는 화면은 모두 거부한다 — 새 화면은 자동으로 열리지 않는다', () => {
  for (const routeId of ['interactions.list', 'interactions.detail', 'settings.members', 'reports.export', 'dashboard.overview']) {
    const d = m.decidePartnerAccess({ scope, actor: partner(), routeId }, ON);
    assert.equal(d.allowed, false, routeId);
    assert.equal(d.reason, 'not_allowlisted', routeId);
  }
});

test('없는 화면과 남의 테넌트는 자원의 존재를 알리지 않는다', () => {
  assert.equal(m.decidePartnerAccess({ scope, actor: partner(), routeId: 'nope.nope' }, ON).reason, 'unknown_route');
  const cross = m.decidePartnerAccess({ scope, actor: partner({ tenantId: 't2' }), routeId: ROUTE }, ON);
  assert.equal(cross.reason, 'tenant_mismatch');
  assert.match(cross.messageKo, /찾을 수 없다/);
  assert.equal(cross.route, undefined, '남의 테넌트에 라우트 정보를 돌려주지 않는다');
});

test('테넌트 판정이 활성화 판정보다 먼저다 — 남의 테넌트에는 활성 여부조차 알리지 않는다', () => {
  const d = m.decidePartnerAccess({ scope, actor: partner({ tenantId: 't2' }), routeId: ROUTE });
  assert.equal(d.reason, 'tenant_mismatch');
});

test('스코프가 비면 던진다(§11.1)', () => {
  assert.throws(() => m.decidePartnerAccess({ scope: { tenantId: '' }, actor: partner(), routeId: ROUTE }, ON));
});

// ── 조회 조건 ────────────────────────────────────────────────────────────────

test('파트너 조회 조건에 partnerId 가 강제로 끼워진다', () => {
  const f = m.partnerActorFilter(scope, partner(), {}, ON);
  assert.equal(f.tenantId, 't1');
  assert.equal(f.partnerId, 'j2mr1');
});

test('호출자가 다른 파트너를 넣어도 덮어쓸 수 없다', () => {
  const f = m.partnerActorFilter(scope, partner(), { partnerId: 'other' }, ON);
  assert.equal(f.partnerId, 'j2mr1');
});

test('내부 사용자는 기존 동작 그대로다(생략 시 전체)', () => {
  const f = m.partnerActorFilter(scope, internal(), {}, ON);
  assert.equal('partnerId' in f, false);
  assert.equal(m.partnerActorFilter(scope, internal(), { partnerId: null }, ON).partnerId, null);
});

test('판정 실패 시 조회 조건을 만들어 주지 않고 던진다', () => {
  assert.throws(() => m.partnerActorFilter(scope, partner({ partnerId: null }), {}, ON), /partner_unbound/);
  assert.throws(() => m.partnerActorFilter(scope, partner(), {}), /activation_pending/);
});

// ── 2차 필터 ─────────────────────────────────────────────────────────────────

const rec = (accountId, partnerId) => buildAttribution(scope, {
  accountId, partner: { partnerId, role: 'operator' },
  acquisition: partnerId === null ? 'inbound' : 'partner_managed',
}).record;

const rows = [rec('acc-a', 'j2mr1'), rec('acc-b', 'other'), rec('acc-c', null)];

test('파트너는 자기 것만 본다', () => {
  const out = m.filterForPartnerActor(rows, scope, partner(), ON);
  assert.deepEqual(out.map((r) => r.accountId), ['acc-a']);
});

test('판정 실패는 빈 목록이다 — 전체가 아니다', () => {
  assert.deepEqual(m.filterForPartnerActor(rows, scope, partner({ partnerId: null }), ON), []);
  assert.deepEqual(m.filterForPartnerActor(rows, scope, partner(), {}), []);
});

test('내부 사용자는 전부 본다', () => {
  assert.equal(m.filterForPartnerActor(rows, scope, internal(), ON).length, 3);
});

test('다른 테넌트 레코드는 어느 경우에도 새지 않는다', () => {
  const foreign = [{ ...rows[0], tenantId: 't2' }];
  assert.deepEqual(m.filterForPartnerActor(foreign, scope, partner(), ON), []);
  assert.deepEqual(m.filterForPartnerActor(foreign, scope, internal(), ON), []);
});

// ── 접근 기록 ────────────────────────────────────────────────────────────────

const logReq = (over = {}) => ({
  scope, actor: partner(), routeId: ROUTE,
  at: '2026-09-03T00:00:00.000Z', recordId: 'r1', ...over,
});

test('거부는 빠짐없이 기록된다', () => {
  const out = m.recordPartnerAccess(emptyChain(scope), logReq({ actor: partner({ partnerId: null }) }), hash, ON);
  assert.equal(out.recorded, true);
  assert.equal(out.record.result, 'denied');
  assert.match(out.record.detail_masked, /partner_unbound/);
});

test('비활성 상태의 시도도 기록된다', () => {
  const out = m.recordPartnerAccess(emptyChain(scope), logReq(), hash);
  assert.equal(out.record.result, 'denied');
  assert.match(out.record.detail_masked, /activation_pending/);
});

test('감사 대상이 아닌 화면의 성공 접근은 잡음이므로 남기지 않는다', () => {
  const out = m.recordPartnerAccess(emptyChain(scope), logReq(), hash, ON);
  assert.equal(out.decision.allowed, true);
  assert.equal(out.recorded, false);
  assert.equal(out.chain.records.length, 0);
});

test('행위자의 실제 역할이 그대로 남는다 — 판정 편의로 바꿔 적지 않는다', () => {
  const out = m.recordPartnerAccess(emptyChain(scope), logReq({ actor: partner({ roles: ['partner_admin'] }) }), hash);
  assert.deepEqual(out.record.actor_roles, ['partner_admin']);
});

test('다른 테넌트 시도는 행위자 테넌트 체인에 남는다(§11.1)', () => {
  const actor = partner({ tenantId: 't2' });
  const out = m.recordPartnerAccess(emptyChain({ tenantId: 't2' }), logReq({ actor }), hash, ON);
  assert.equal(out.record.tenant_id, 't2');
  assert.match(out.record.detail_masked, /tenant_mismatch/);
  assert.throws(() => m.recordPartnerAccess(emptyChain(scope), logReq({ actor }), hash, ON), /§11.1/);
});

test('기록은 체인 검증을 깨지 않는다', () => {
  let c = emptyChain(scope);
  c = m.recordPartnerAccess(c, logReq({ recordId: 'r1' }), hash).chain;
  c = m.recordPartnerAccess(c, logReq({ recordId: 'r2', routeId: 'settings.members' }), hash, ON).chain;
  assert.equal(c.records.length, 2);
  assert.equal(verifyChain(c, hash).ok, true);
});

// ── 회귀 방지 ────────────────────────────────────────────────────────────────

test('IA 는 partner_admin 에게 어떤 라우트도 직접 주지 않는다(기본 거부)', () => {
  assert.deepEqual(m.partnerRbacSelfCheck(), []);
});

test('허용 목록 화면은 읽기 전용·비 PII 여야 한다', () => {
  for (const id of m.PARTNER_ROUTE_ALLOWLIST) {
    const d = m.decidePartnerAccess({ scope, actor: partner(), routeId: id }, ON);
    assert.equal(d.allowed, true, `${id} 가 열려 있어야 한다`);
    assert.equal(d.route.pii, false);
    assert.equal(d.route.mutates, false);
  }
});

test('isPartnerActor 는 역할로만 판단한다', () => {
  assert.equal(m.isPartnerActor(partner()), true);
  assert.equal(m.isPartnerActor(internal()), false);
  assert.equal(m.isPartnerActor(internal({ partnerId: 'j2mr1' })), false);
});
