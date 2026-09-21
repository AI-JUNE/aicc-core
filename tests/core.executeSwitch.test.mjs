// 채널 전환 실행 오케스트레이터 검사 — 설계서 §5.2·§1.2·§10.3·§11.1·§13-3.
//
// 여기서 고정하는 것은 "동작한다"가 아니라 **링크 하나가 세션 열쇠가 되는 자리**다.
// 토큰이 Interaction id 와 얽히거나, 오류 문구로 새거나, 거절이 성공으로 읽히면
// 1회용·만료·회수가 전부 무의미해진다 — 그리고 그 실패는 예외로 나타나지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let ex = null, cs = null;
try {
  ex = await import('../src/core/executeSwitch.ts');
  cs = await import('../src/core/channelSwitch.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: ex ? false : '타입 스트리핑 미지원 런타임' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/core/executeSwitch.ts');

const scope = { tenantId: 't1' };
const IID = 'i_call_777';
const AT = '2026-03-02T01:00:00.000Z';
const TTL = 5 * 60 * 1000;

const params = (over = {}) => ({
  scope,
  interactionId: IID,
  fromChannel: 'voice',
  toChannel: 'visual',
  reason: 'recognition_failure',
  delivery: 'sms',
  newToken: () => 'tk_abcdef123456',
  issuedAt: AT,
  ttlMs: TTL,
  carry: { allow: ['customer_name'] },
  slots: { customer_name: '홍길동', rrn: '901010-1234567' },
  crossChannelInviteSupported: true,
  targetChannelAvailable: true,
  reachable: true,
  registry: cs.createInviteRegistry(),
  ...over,
});

// ── 발급 정상 경로 ───────────────────────────────────────────────────────────

test('정상: 티켓은 토큰·목적지·만료만 담고 슬롯 값은 담지 않는다(§10.3)', b, () => {
  const r = ex.issueSwitch(params());
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.ticket).sort(), ['expiresAt', 'interactionId', 'toChannel', 'token']);
  assert.equal(r.ticket.token, 'tk_abcdef123456');
  assert.equal(r.ticket.toChannel, 'visual');
  assert.equal(r.ticket.expiresAt, new Date(Date.parse(AT) + TTL).toISOString());
  // 티켓 전체를 직렬화해도 슬롯 값이 나오지 않는다 — 채널은 링크만 만들면 된다.
  const s = JSON.stringify(r.ticket);
  assert.equal(s.includes('홍길동'), false);
  assert.equal(s.includes('901010'), false);
});

test('allowlist 밖의 슬롯은 승계되지 않고 키로만 드러난다(§10.3)', b, () => {
  const r = ex.issueSwitch(params());
  assert.deepEqual(r.carriedSlotKeys, ['customer_name']);
  assert.deepEqual(r.droppedSlotKeys, ['rrn']);
});

test('승계 값은 마스킹을 거친다 — 마스킹 사실이 결과에 남는다(§10.3)', b, () => {
  const r = ex.issueSwitch(params({ carry: { allow: ['phone'] }, slots: { phone: '010-1234-5678' } }));
  assert.equal(r.ok, true);
  assert.equal(r.piiMasked, true);
  assert.ok(r.piiKinds.length > 0);
});

test('예약 슬롯(__)은 allowlist 에 있어도 승계하지 않는다 — Core 내부 판정용이다', b, () => {
  const reg = cs.createInviteRegistry();
  const r = ex.issueSwitch(params({
    registry: reg,
    carry: { allow: ['__last_failure_reason__', 'customer_name'] },
    slots: { __last_failure_reason__: 'no_input', customer_name: '홍길동' },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.carriedSlotKeys, ['customer_name']);
  const stored = reg.get(r.ticket.token, scope);
  assert.equal('__last_failure_reason__' in stored.carriedSlots, false);
});

// ── 발급 거절 경로 ───────────────────────────────────────────────────────────

test('전환 조건이 안 되면 토큰을 만들지 않는다 — 결과에 티켓 자체가 없다(§5.2)', b, () => {
  for (const over of [
    { crossChannelInviteSupported: false },
    { targetChannelAvailable: false },
    { reachable: false },
  ]) {
    let called = 0;
    const r = ex.issueSwitch(params({ ...over, newToken: () => { called += 1; return 'tk_x'; } }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E_NOT_SWITCHABLE');
    assert.equal('ticket' in r, false);
    // 판정 전에 토큰을 뽑지 않는다 — 뽑아 두면 어딘가에 남는다.
    assert.equal(called, 0);
  }
});

test('토큰이 Interaction id 와 얽히면 발급을 거절한다 — 링크가 곧 세션 id 가 된다', b, () => {
  const a = ex.issueSwitch(params({ newToken: () => `tk_${IID}` }));
  assert.equal(a.ok, false);
  assert.equal(a.code, 'E_TOKEN_WEAK');
  const c = ex.issueSwitch(params({ interactionId: 'tk_abcdef123456_x', newToken: () => 'tk_abcdef123456' }));
  assert.equal(c.ok, false);
  assert.equal(c.code, 'E_TOKEN_WEAK');
});

test('빈 토큰·공백 토큰은 열쇠가 아니다', b, () => {
  for (const t of ['', '   ']) {
    const r = ex.issueSwitch(params({ newToken: () => t }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E_TOKEN_WEAK');
  }
});

test('유효기간·토큰 발급기·allowlist 결함은 설정 오류로 거절한다(§13-3)', b, () => {
  const ttl0 = ex.issueSwitch(params({ ttlMs: 0 }));
  assert.equal(ttl0.code, 'E_CONFIG_INVALID');
  const ttlNaN = ex.issueSwitch(params({ ttlMs: Number.NaN }));
  assert.equal(ttlNaN.code, 'E_CONFIG_INVALID');
  const noGen = ex.issueSwitch(params({ newToken: undefined }));
  assert.equal(noGen.code, 'E_CONFIG_INVALID');
  const badCarry = ex.issueSwitch(params({ carry: { allow: 'customer_name' } }));
  assert.equal(badCarry.code, 'E_CONFIG_INVALID');
  const noId = ex.issueSwitch(params({ interactionId: '' }));
  assert.equal(noId.code, 'E_CONFIG_INVALID');
});

test('토큰 발급기가 던져도 통화를 끊지 않고, 원문 메시지를 싣지 않는다(§9.3·§10.3)', b, () => {
  const r = ex.issueSwitch(params({ newToken: () => { throw new Error('/etc/secrets/seed.key 를 읽을 수 없음'); } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_CONFIG_INVALID');
  assert.equal(r.reasonKo.includes('/etc/secrets'), false);
});

test('레지스트리 거절(토큰 중복)은 결과로 내려가고 사유 문구에 토큰이 없다(§10.3)', b, () => {
  const registry = cs.createInviteRegistry();
  const first = ex.issueSwitch(params({ registry }));
  assert.equal(first.ok, true);
  const again = ex.issueSwitch(params({ registry, interactionId: 'i_other_1' }));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'E_ISSUE_FAILED');
  assert.equal(again.reasonKo.includes('tk_abcdef123456'), false);
});

test('스코프 없는 발급·상환은 결과가 아니라 예외다(§11.1)', b, () => {
  assert.throws(() => ex.issueSwitch(params({ scope: { tenantId: '' } })), /tenant_id/);
  const { registry, ticket } = issued();
  assert.throws(
    () => ex.redeemSwitch({ registry, token: ticket.token, scope: { tenantId: '' }, channel: 'visual', at: AT }),
    /tenant_id/,
  );
});

// ── 상환 경로 ────────────────────────────────────────────────────────────────

function issued(over = {}) {
  const registry = cs.createInviteRegistry();
  const r = ex.issueSwitch(params({ registry, ...over }));
  assert.equal(r.ok, true);
  return { registry, ticket: r.ticket };
}

test('정상 상환: 같은 Interaction 으로 합류하고 승계 슬롯을 돌려준다(§1.2)', b, () => {
  const { registry, ticket } = issued();
  const r = ex.redeemSwitch({ registry, token: ticket.token, scope, channel: 'visual', at: AT, expectInteractionId: IID });
  assert.equal(r.ok, true);
  assert.equal(r.interactionId, IID);
  assert.equal(r.toChannel, 'visual');
  assert.deepEqual(Object.keys(r.carriedSlots), ['customer_name']);
});

test('1회용: 두 번째 상환은 거절된다', b, () => {
  const { registry, ticket } = issued();
  assert.equal(ex.redeemSwitch({ registry, token: ticket.token, scope, channel: 'visual', at: AT }).ok, true);
  const second = ex.redeemSwitch({ registry, token: ticket.token, scope, channel: 'visual', at: AT });
  assert.equal(second.ok, false);
  assert.equal(second.rejection, 'already_redeemed');
});

test('만료·다른 채널·다른 테넌트·없는 토큰은 전부 거절이며 세션 정보를 돌려주지 않는다', b, () => {
  const { registry, ticket } = issued();
  const late = ex.redeemSwitch({ registry, token: ticket.token, scope, channel: 'visual', at: new Date(Date.parse(AT) + TTL).toISOString() });
  assert.equal(late.rejection, 'expired');
  const wrongChannel = ex.redeemSwitch({ registry, token: ticket.token, scope, channel: 'chat', at: AT });
  assert.equal(wrongChannel.rejection, 'channel_mismatch');
  const other = ex.redeemSwitch({ registry, token: ticket.token, scope: { tenantId: 't2' }, channel: 'visual', at: AT });
  assert.equal(other.ok, false);
  const none = ex.redeemSwitch({ registry, token: 'tk_nope', scope, channel: 'visual', at: AT });
  assert.equal(none.rejection, 'unknown_token');
  for (const r of [late, wrongChannel, other, none]) {
    assert.equal('interactionId' in r, false);
    assert.equal(r.reasonKo.includes(ticket.token), false);
    assert.equal(r.reasonKo.includes(IID), false);
  }
});

test('토큰이 맞아도 Interaction 주장이 다르면 합류하지 않는다 — 둘 다 맞아야 한다(§1.2)', b, () => {
  const { registry, ticket } = issued();
  const r = ex.redeemSwitch({ registry, token: ticket.token, scope, channel: 'visual', at: AT, expectInteractionId: 'i_someone_else' });
  assert.equal(r.ok, false);
  assert.equal(r.rejection, 'interaction_mismatch');
  // 소진된 토큰은 되살리지 않는다 — 어긋난 링크가 한 번 더 시도되는 것보다 낫다.
  const retry = ex.redeemSwitch({ registry, token: ticket.token, scope, channel: 'visual', at: AT, expectInteractionId: IID });
  assert.equal(retry.ok, false);
  assert.equal(retry.rejection, 'already_redeemed');
});

test('운영자 회수 뒤에는 상환되지 않는다(§7 7.4)', b, () => {
  const { registry, ticket } = issued();
  assert.equal(registry.revoke(ticket.token, scope), true);
  const r = ex.redeemSwitch({ registry, token: ticket.token, scope, channel: 'visual', at: AT });
  assert.equal(r.rejection, 'revoked');
});

// ── 판정 중복 방지 ───────────────────────────────────────────────────────────

test('판정을 복사하지 않는다 — 만료·1회용 규칙을 이 파일에서 다시 쓰지 않는다(§2)', b, () => {
  const src = readFileSync(SRC, 'utf8');
  // 만료·1회용·테넌트·목적지 판정은 channelSwitch 하나에만 있다. 두 곳이 서로 다른 규칙을 갖는
  // 순간 §2 의 이중 관리가 재발하고, 그때 어긋나는 것은 **열쇠의 수명**이다.
  for (const f of ['Date.parse(', 'expiresAt <', 'already_redeemed', 'revoked.has']) {
    assert.equal(src.includes(f), false, `판정 복사 의심: ${f}`);
  }
  assert.equal(src.includes('checkRedeem('), false);
});
