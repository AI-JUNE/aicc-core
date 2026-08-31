import { test } from 'node:test';
import assert from 'node:assert/strict';

let cs = null, sess = null;
try {
  cs = await import('../src/core/channelSwitch.ts');
  sess = await import('../src/core/session.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: cs ? false : '타입 스트리핑 미지원 런타임' };

const T0 = '2026-03-01T00:00:00.000Z';
const scope = { tenantId: 't1' };
const base = (over = {}) => ({
  scope, interactionId: 'i_1', fromChannel: 'voice', toChannel: 'visual',
  reason: 'complex_input', delivery: 'sms', token: 'inv_abc', issuedAt: T0,
  ttlMs: 300_000, carry: { allow: ['name'] }, crossChannelInviteSupported: true, ...over,
});

test('초대 발급 — 만료시각 계산과 allowlist 밖 슬롯 폐기', b, () => {
  const inv = cs.issueInvite(base({ slots: { name: '홍길동', memo: '내부메모' } }));
  assert.equal(inv.expiresAt, '2026-03-01T00:05:00.000Z');
  assert.deepEqual(Object.keys(inv.carriedSlots), ['name']);
  assert.deepEqual(inv.droppedSlotKeys, ['memo']);
  assert.equal(inv.tenantId, 't1');
});

test('승계 슬롯도 마스킹을 통과한다 (§10.3)', b, () => {
  const inv = cs.issueInvite(base({ carry: { allow: ['rrn'] }, slots: { rrn: '900101-1234567' } }));
  assert.equal(inv.piiMasked, true);
  assert.ok(inv.piiKinds.length > 0);
  assert.ok(!inv.carriedSlots.rrn.includes('1234567'));
});

test('발급 거부 — 능력 미지원·동일채널·비정상 TTL', b, () => {
  assert.throws(() => cs.issueInvite(base({ crossChannelInviteSupported: false })), /교차채널 초대/);
  assert.throws(() => cs.issueInvite(base({ fromChannel: 'visual' })), /같은 채널/);
  assert.throws(() => cs.issueInvite(base({ ttlMs: 0 })), /유효기간/);
  assert.throws(() => cs.issueInvite(base({ scope: { tenantId: '' } })), /tenant_id/);
});

test('상환 — 만료·채널·테넌트 불일치는 모두 거절', b, () => {
  const inv = cs.issueInvite(base());
  const at = '2026-03-01T00:01:00.000Z';
  assert.equal(cs.checkRedeem(inv, { token: 'inv_abc', scope, channel: 'visual', at }).ok, true);
  assert.equal(cs.checkRedeem(inv, { token: 'inv_abc', scope, channel: 'chat', at }).rejection, 'channel_mismatch');
  assert.equal(cs.checkRedeem(inv, { token: 'inv_abc', scope: { tenantId: 't2' }, channel: 'visual', at }).rejection, 'tenant_mismatch');
  assert.equal(cs.checkRedeem(inv, { token: 'nope', scope, channel: 'visual', at }).rejection, 'unknown_token');
  const late = '2026-03-01T00:05:00.000Z';
  assert.equal(cs.checkRedeem(inv, { token: 'inv_abc', scope, channel: 'visual', at: late }).rejection, 'expired');
});

test('레지스트리 — 1회용 강제, 토큰 재발급 금지, 회수', b, () => {
  const reg = cs.createInviteRegistry();
  reg.issue(base());
  const at = '2026-03-01T00:01:00.000Z';
  assert.equal(reg.redeem({ token: 'inv_abc', scope, channel: 'visual', at }).ok, true);
  assert.equal(reg.redeem({ token: 'inv_abc', scope, channel: 'visual', at }).rejection, 'already_redeemed');
  assert.throws(() => reg.issue(base()), /중복/);

  const reg2 = cs.createInviteRegistry();
  reg2.issue(base({ token: 'inv_x' }));
  assert.equal(reg2.revoke('inv_x', scope), true);
  assert.equal(reg2.redeem({ token: 'inv_x', scope, channel: 'visual', at }).rejection, 'revoked');
  assert.equal(reg2.revoke('inv_x', { tenantId: 't2' }), false);
});

test('레지스트리 조회·정리는 테넌트 스코프를 지킨다 (§11.1)', b, () => {
  const reg = cs.createInviteRegistry();
  reg.issue(base({ token: 'inv_1' }));
  assert.ok(reg.get('inv_1', scope));
  assert.equal(reg.get('inv_1', { tenantId: 't2' }), undefined);
  assert.equal(reg.purge('2026-03-01T01:00:00.000Z'), 1);
  assert.equal(reg.get('inv_1', scope), undefined);
});

test('세션 적용 — 새 Interaction을 만들지 않고 합류하며 기존 슬롯을 덮지 않는다', b, () => {
  const i = sess.createInteraction('t1', 'voice', 'i_1');
  i.entities.name = '이미수집';
  const inv = cs.issueInvite(base({ carry: { allow: ['name', 'birth'] }, slots: { name: '홍길동', birth: '1990' } }));
  const r = cs.applyInvite(i, inv);
  assert.deepEqual(r.interaction.channels, ['voice', 'visual']);
  assert.equal(r.interaction.id, 'i_1');
  assert.equal(i.entities.name, '이미수집');
  assert.deepEqual(r.appliedSlotKeys, ['birth']);
  assert.deepEqual(r.skippedSlotKeys, ['name']);
});

test('다른 Interaction·테넌트에는 적용할 수 없다', b, () => {
  const inv = cs.issueInvite(base());
  assert.throws(() => cs.applyInvite(sess.createInteraction('t1', 'voice', 'i_9'), inv), /Interaction/);
  assert.throws(() => cs.applyInvite(sess.createInteraction('t2', 'voice', 'i_1'), inv), /테넌트/);
});

test('전환 가능 판정 — 하나라도 성립 안 하면 전환하지 않는다 (§5.1·§9.3)', b, () => {
  const ok = { crossChannelInviteSupported: true, visualChannelAvailable: true, reachable: true };
  assert.equal(cs.canSwitchToVisual(ok).allowed, true);
  assert.equal(cs.canSwitchToVisual({ ...ok, reachable: false }).allowed, false);
  assert.equal(cs.canSwitchToVisual({ ...ok, visualChannelAvailable: false }).allowed, false);
  assert.equal(cs.canSwitchToVisual({ ...ok, crossChannelInviteSupported: false }).allowed, false);
});
