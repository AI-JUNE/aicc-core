import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let al = null, ia = null;
try {
  al = await import('../src/audit/log.ts');
  ia = await import('../src/portal/ia.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: al ? false : '타입 스트리핑 미지원 런타임' };

// 해시는 호스트가 주입한다(Core 는 런타임에 종속되지 않는다).
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const scope = { tenantId: 'acme' };
const actor = { userId: 'u-1', roles: ['admin'], ip: '203.0.113.42' };

function append(chain, over = {}) {
  return al.appendAudit(chain, {
    scope,
    recordId: over.recordId ?? `r-${chain.records.length + 1}`,
    at: over.at ?? '2026-09-01T00:00:00Z',
    actor: over.actor ?? actor,
    action: over.action ?? 'view',
    targetType: over.targetType ?? 'interaction',
    targetId: over.targetId ?? 'i-1',
    result: over.result ?? 'success',
    ...(over.routeId !== undefined ? { routeId: over.routeId } : {}),
    ...(over.detail !== undefined ? { detail: over.detail } : {}),
  }, sha256);
}

test('§10.3 detail 은 저장 전 마스킹된다 — 원문 저장 경로가 없다', behavioral, () => {
  const c = append(al.emptyChain(scope), { detail: '고객 확인: 900101-1234567 / 010-1234-5678' });
  const r = c.records[0];
  assert.ok(!r.detail_masked.includes('1234567'));
  assert.ok(!r.detail_masked.includes('010-1234-5678'));
  assert.equal(r.pii_masked, true);
  assert.deepEqual(r.pii_kinds.slice().sort(), ['phone', 'rrn']);
});

test('IP 는 마지막 옥텟을 지우고, 형식 불명이면 저장하지 않는다', behavioral, () => {
  assert.equal(al.maskIp('203.0.113.42'), '203.0.113.0');
  assert.equal(al.maskIp('2001:db8:85a3:1:2:3:4:5'), '2001:db8:85a3:1::');
  assert.equal(al.maskIp('unknown-source'), undefined);
  assert.equal(al.maskIp(undefined), undefined);

  const c = append(al.emptyChain(scope), { actor: { userId: 'u-1', roles: ['admin'], ip: 'not-an-ip' } });
  assert.equal(c.records[0].actor_ip_masked, undefined);
});

test('해시 체인 — 정상 체인은 검증을 통과한다', behavioral, () => {
  let c = al.emptyChain(scope);
  c = append(c, { detail: '열람' });
  c = append(c, { action: 'update', detail: '큐 정책 변경' });
  c = append(c, { action: 'export', targetType: 'report', targetId: 'rep-1' });

  assert.equal(c.records[0].prev_hash, al.GENESIS_HASH);
  assert.equal(c.records[1].prev_hash, c.records[0].hash);
  assert.deepEqual(c.records.map(r => r.seq), [1, 2, 3]);

  const v = al.verifyChain(c, sha256);
  assert.equal(v.ok, true);
  assert.equal(v.checked, 3);
});

test('레코드를 고치면 hash_mismatch 로 드러난다', behavioral, () => {
  let c = al.emptyChain(scope);
  c = append(c, { detail: '열람' });
  c = append(c, { action: 'delete', targetId: 'i-9' });

  const tampered = {
    tenantId: c.tenantId,
    records: c.records.map((r, i) => (i === 1 ? { ...r, action: 'view' } : r)),
  };
  const v = al.verifyChain(tampered, sha256);
  assert.equal(v.ok, false);
  assert.ok(v.breaks.some(b => b.kind === 'hash_mismatch' && b.seq === 2));
});

test('중간 레코드를 지우면 체인이 끊긴 것이 드러난다', behavioral, () => {
  let c = al.emptyChain(scope);
  c = append(c);
  c = append(c, { action: 'permission_change', targetType: 'member', targetId: 'u-2' });
  c = append(c, { action: 'export' });

  const cut = { tenantId: c.tenantId, records: [c.records[0], c.records[2]] };
  const v = al.verifyChain(cut, sha256);
  assert.equal(v.ok, false);
  assert.ok(v.breaks.some(b => b.kind === 'prev_hash_mismatch'));
  assert.ok(v.breaks.some(b => b.kind === 'seq_gap'));
});

test('§11.1 다른 테넌트 레코드는 같은 체인에 넣을 수 없다', behavioral, () => {
  const c = al.emptyChain(scope);
  assert.throws(() => al.appendAudit(c, {
    scope: { tenantId: 'globex' },
    recordId: 'r-x', at: '2026-09-01T00:00:00Z', actor,
    action: 'view', targetType: 'interaction', targetId: 'i-1', result: 'success',
  }, sha256), /§11.1/);
});

test('§10.2 행위자 없는 레코드는 남길 수 없다', behavioral, () => {
  const c = al.emptyChain(scope);
  assert.throws(() => append(c, { actor: { userId: '', roles: [] } }), /§10.2/);
});

test('거부(denied)된 접근도 기록된다 — 실패가 로그에서 사라지면 안 된다', behavioral, () => {
  const c = append(al.emptyChain(scope), { result: 'denied', routeId: 'settings.members' });
  assert.equal(c.records[0].result, 'denied');
  assert.equal(al.verifyChain(c, sha256).ok, true);
});

test('§7 PII·변경 화면은 감사 대상이고 액션이 자동 결정된다', behavioral, () => {
  const detail = ia.routeById('interactions.detail');
  const members = ia.routeById('settings.members');
  const overview = ia.routeById('dashboard.overview');
  const exportRoute = ia.routeById('reports.export');
  const publishRoute = ia.routeById('studio.publish');
  const retention = ia.routeById('settings.retention');

  assert.equal(al.shouldAudit(detail), true);
  assert.equal(al.shouldAudit(overview), false);
  assert.equal(al.defaultActionFor(detail), 'view');
  assert.equal(al.defaultActionFor(members), 'permission_change');
  assert.equal(al.defaultActionFor(exportRoute), 'export');
  assert.equal(al.defaultActionFor(publishRoute), 'publish');
  assert.equal(al.defaultActionFor(retention), 'policy_change');
});

test('조회는 테넌트·기간·행위자·액션으로 걸러진다', behavioral, () => {
  let c = al.emptyChain(scope);
  c = append(c, { at: '2026-08-30T10:00:00Z', action: 'view' });
  c = append(c, { at: '2026-09-01T10:00:00Z', action: 'export', actor: { userId: 'u-2', roles: ['analyst'] } });
  c = append(c, { at: '2026-09-02T10:00:00Z', action: 'view' });

  assert.equal(al.queryAudit(c, { scope, from: '2026-09-01T00:00:00Z' }).length, 2);
  assert.equal(al.queryAudit(c, { scope, action: 'export' }).length, 1);
  assert.equal(al.queryAudit(c, { scope, actorUserId: 'u-2' }).length, 1);
  assert.equal(al.queryAudit(c, { scope: { tenantId: 'globex' } }).length, 0);
});

test('체인은 불변 — append 는 새 체인을 돌려준다', behavioral, () => {
  const c0 = al.emptyChain(scope);
  const c1 = append(c0);
  assert.equal(c0.records.length, 0);
  assert.equal(c1.records.length, 1);
  assert.equal(al.headHash(c0), al.GENESIS_HASH);
  assert.equal(al.headHash(c1), c1.records[0].hash);
});
