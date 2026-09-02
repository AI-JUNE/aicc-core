import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null, log = null;
try {
  m = await import('../src/audit/access.ts');
  log = await import('../src/audit/log.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

/** 테스트용 결정적 해시. 상용은 SHA-256 을 주입한다(감사 체인은 해시를 주입받는 설계). */
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

const scope = { tenantId: 't1' };
const admin = { userId: 'u_admin', roles: ['admin'], tenantId: 't1', ip: '203.0.113.42' };
const agent = { userId: 'u_agent', roles: ['agent'], tenantId: 't1' };
const chain0 = () => (m ? log.emptyChain(scope) : null);
const req = (over = {}) => ({
  scope, actor: admin, routeId: 'settings.members',
  at: '2026-09-02T01:00:00.000Z', recordId: 'a1', ...over,
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('권한 있는 관리 화면 접근은 허용되고 이력이 남는다', b, () => {
  const out = m.recordAccess(chain0(), req(), hash);
  assert.equal(out.decision.allowed, true);
  assert.equal(out.recorded, true);
  assert.equal(out.record.route_id, 'settings.members');
  assert.equal(out.record.result, 'success');
  assert.equal(out.record.action, 'permission_change');
  assert.equal(out.record.actor_user_id, 'u_admin');
  assert.equal(out.record.actor_ip_masked, '203.0.113.0');   // IP 마지막 옥텟 제거(§10.3)
  assert.equal(log.verifyChain(out.chain, hash).ok, true);
});

test('원본 체인은 변하지 않는다(불변)', b, () => {
  const c = chain0();
  const out = m.recordAccess(c, req(), hash);
  assert.equal(c.records.length, 0);
  assert.equal(out.chain.records.length, 1);
});

test('감사 대상이 아닌 단순 조회 성공은 잡음이 되지 않게 남기지 않는다', b, () => {
  const out = m.recordAccess(chain0(), req({ routeId: 'dashboard.overview' }), hash);
  assert.equal(out.decision.allowed, true);
  assert.equal(out.recorded, false);
  assert.equal(out.chain.records.length, 0);
});

test('감사 대응 기간에는 성공 조회도 전부 남길 수 있다', b, () => {
  const out = m.recordAccess(chain0(), req({ routeId: 'dashboard.overview' }), hash, { recordAllReads: true });
  assert.equal(out.recorded, true);
  assert.equal(out.record.action, 'view');
});

test('PII 열람 화면은 성공이어도 반드시 남는다(§10.3)', b, () => {
  const out = m.recordAccess(chain0(), req({ routeId: 'interactions.detail', targetType: 'interaction', targetId: 'i_1' }), hash);
  assert.equal(out.recorded, true);
  assert.equal(out.record.action, 'view');
  assert.equal(out.record.target_id, 'i_1');
});

// ── 실패·거부 경로 ───────────────────────────────────────────────────────────

test('권한 없는 접근은 거부되고, 감사 대상이 아니어도 반드시 남는다', b, () => {
  const out = m.recordAccess(chain0(), req({ actor: agent, routeId: 'dashboard.overview' }), hash);
  assert.equal(out.decision.allowed, false);
  assert.equal(out.decision.reason, 'role');
  assert.equal(out.recorded, true);
  assert.equal(out.record.result, 'denied');
  assert.match(out.record.detail_masked, /거부 사유: role/);
});

test('다른 테넌트 자원 접근은 존재 여부를 알려주지 않고, 행위자 테넌트 체인에 남는다', b, () => {
  const outsider = { userId: 'u_x', roles: ['admin'], tenantId: 't2' };
  const chain = log.emptyChain({ tenantId: 't2' });
  const out = m.recordAccess(chain, req({ actor: outsider }), hash);
  assert.equal(out.decision.reason, 'tenant_mismatch');
  assert.match(out.decision.messageKo, /찾을 수 없다/);
  assert.equal(out.recorded, true);
  assert.equal(out.record.tenant_id, 't2');
});

test('행위자 테넌트와 다른 체인에 남기려 하면 막는다(§11.1)', b, () => {
  const outsider = { userId: 'u_x', roles: ['admin'], tenantId: 't2' };
  assert.throws(() => m.recordAccess(chain0(), req({ actor: outsider }), hash), /§11\.1/);
});

test('존재하지 않는 라우트 접근도 기록된다', b, () => {
  const out = m.recordAccess(chain0(), req({ routeId: 'no.such.route' }), hash);
  assert.equal(out.decision.reason, 'unknown_route');
  assert.equal(out.recorded, true);
  assert.equal(out.record.target_type, 'unknown_route');
});

test('권한 외 사유로 막힌 접근도 사유와 함께 남는다', b, () => {
  const out = m.recordAccess(chain0(), req({ blocked: true }), hash);
  assert.equal(out.decision.reason, 'blocked');
  assert.equal(out.record.result, 'denied');
});

test('테넌트 식별자가 비면 판정 자체가 거부된다', b, () => {
  assert.throws(() => m.decideAccess(req({ scope: { tenantId: '' } })));
});

test('행위자 없는 이력은 남길 수 없다', b, () => {
  assert.throws(() => m.recordAccess(chain0(), req({ actor: { userId: '', roles: ['admin'], tenantId: 't1' } }), hash));
});

// ── 대량 반출·개인정보 ───────────────────────────────────────────────────────

test('임계값을 넘긴 내보내기는 대량 반출로 표시된다', b, () => {
  const out = m.recordAccess(
    chain0(),
    req({ routeId: 'reports.export', action: 'export', affectedCount: 5000 }),
    hash,
    { bulkExportThreshold: 1000 },
  );
  assert.equal(out.record.action, 'export');
  assert.match(out.record.detail_masked, /대량 반출 5000건\(기준 1000건\)/);
});

test('임계값 미만이거나 기준이 없으면 표시하지 않는다', b, () => {
  const under = m.recordAccess(chain0(), req({ routeId: 'reports.export', action: 'export', affectedCount: 10 }), hash, { bulkExportThreshold: 1000 });
  assert.equal(under.record.detail_masked, undefined);
  const noThreshold = m.recordAccess(chain0(), req({ routeId: 'reports.export', action: 'export', affectedCount: 99999 }), hash);
  assert.equal(noThreshold.record.detail_masked, undefined);
});

test('사유에 섞인 개인정보는 저장 전에 마스킹된다(§10.3)', b, () => {
  const out = m.recordAccess(chain0(), req({ detail: '고객 010-1234-5678 요청으로 권한 변경' }), hash);
  assert.ok(!out.record.detail_masked.includes('1234-5678'));
  assert.equal(out.record.pii_masked, true);
  assert.deepEqual(out.record.pii_kinds, ['phone']);
});

// ── 조회·요약 ────────────────────────────────────────────────────────────────

test('이력 조회는 테넌트를 강제하고 행위자·결과·기간으로 좁힌다', b, () => {
  let c = chain0();
  c = m.recordAccess(c, req({ recordId: 'r1', at: '2026-09-01T00:00:00.000Z' }), hash).chain;
  c = m.recordAccess(c, req({ recordId: 'r2', at: '2026-09-02T00:00:00.000Z', actor: agent, routeId: 'settings.members' }), hash).chain;
  c = m.recordAccess(c, req({ recordId: 'r3', at: '2026-09-03T00:00:00.000Z', routeId: 'reports.export', action: 'export' }), hash).chain;

  assert.equal(m.accessHistory(c, { scope }).length, 3);
  assert.equal(m.accessHistory(c, { scope, result: 'denied' }).length, 1);
  assert.equal(m.accessHistory(c, { scope, actorUserId: 'u_admin' }).length, 2);
  assert.equal(m.accessHistory(c, { scope, routeId: 'reports.export' }).length, 1);
  assert.equal(m.accessHistory(c, { scope, from: '2026-09-02T00:00:00.000Z' }).length, 2);
  assert.equal(m.accessHistory(c, { scope, limit: 1 })[0].record_id, 'r1');
  assert.equal(m.accessHistory(c, { scope, newestFirst: true, limit: 1 })[0].record_id, 'r3');
  assert.equal(m.accessHistory(c, { scope: { tenantId: 't9' } }).length, 0);
});

test('요약은 실측 건수만 낸다', b, () => {
  let c = chain0();
  c = m.recordAccess(c, req({ recordId: 'r1', at: '2026-09-01T00:00:00.000Z', routeId: 'interactions.detail' }), hash).chain;
  c = m.recordAccess(c, req({ recordId: 'r2', at: '2026-09-02T00:00:00.000Z', routeId: 'reports.export', action: 'export' }), hash).chain;
  c = m.recordAccess(c, req({ recordId: 'r3', at: '2026-09-03T00:00:00.000Z', actor: agent }), hash).chain;

  const s = m.accessSummary(c, { scope });
  const adminRow = s.find(r => r.actorUserId === 'u_admin');
  assert.equal(adminRow.total, 2);
  assert.equal(adminRow.views, 1);
  assert.equal(adminRow.exports, 1);
  assert.equal(adminRow.denied, 0);
  assert.equal(adminRow.firstAt, '2026-09-01T00:00:00.000Z');
  assert.equal(adminRow.lastAt, '2026-09-02T00:00:00.000Z');

  const agentRow = s.find(r => r.actorUserId === 'u_agent');
  assert.equal(agentRow.denied, 1);
  assert.equal(m.accessSummary(chain0(), { scope }).length, 0);
});

test('거부 이력을 지우면 체인 검증에서 드러난다', b, () => {
  let c = chain0();
  c = m.recordAccess(c, req({ recordId: 'r1' }), hash).chain;
  c = m.recordAccess(c, req({ recordId: 'r2', actor: agent, routeId: 'dashboard.overview' }), hash).chain;
  c = m.recordAccess(c, req({ recordId: 'r3' }), hash).chain;
  const tampered = { tenantId: c.tenantId, records: [c.records[0], c.records[2]] };
  const v = log.verifyChain(tampered, hash);
  assert.equal(v.ok, false);
  assert.ok(v.breaks.some(x => x.kind === 'seq_gap' || x.kind === 'prev_hash_mismatch'));
});
