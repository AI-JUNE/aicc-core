import { test } from 'node:test';
import assert from 'node:assert/strict';

let ia = null, ad = null;
try {
  ia = await import('../src/portal/ia.ts');
  ad = await import('../src/portal/aiDisclosure.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: ia ? false : '타입 스트리핑 미지원 런타임' };

test('§7 7개 섹션이 모두 정의되고 라우트가 붙어 있다', behavioral, () => {
  const ids = ia.PORTAL_SECTIONS.map(s => s.id);
  assert.deepEqual(ids.slice().sort(), ['dashboard', 'interactions', 'operations', 'qa', 'reports', 'settings', 'studio']);
  for (const s of ia.PORTAL_SECTIONS) {
    assert.ok(ia.PORTAL_ROUTES.some(r => r.section === s.id), s.id);
  }
  const keys = ia.PORTAL_ROUTES.map(r => r.id);
  assert.equal(new Set(keys).size, keys.length, '라우트 id 중복');
  assert.equal(new Set(ia.PORTAL_ROUTES.map(r => r.path)).size, keys.length, '경로 중복');
});

test('권한: 상담사는 스튜디오·설정에 접근할 수 없다', behavioral, () => {
  const studio = ia.routeById('studio.publish');
  assert.equal(ia.canAccess(studio, ['agent']), false);
  assert.equal(ia.canAccess(studio, ['admin']), true);
  assert.equal(ia.canAccess(ia.routeById('settings.members'), ['supervisor']), false);
  // 슈퍼바이저는 상담사 권한을 포함한다
  assert.equal(ia.canAccess(ia.routeById('interactions.detail'), ['supervisor']), true);
});

test('내비게이션은 접근 가능한 섹션만 노출하고 hidden 라우트를 뺀다', behavioral, () => {
  const nav = ia.buildNav(['analyst']);
  const sections = nav.map(n => n.section.id);
  assert.deepEqual(sections, ['dashboard', 'reports']);
  assert.ok(nav.every(n => n.routes.every(r => !r.hidden)));
  const owner = ia.buildNav(['tenant_owner']).map(n => n.section.id);
  assert.deepEqual(owner, ['dashboard', 'interactions', 'studio', 'operations', 'qa', 'reports', 'settings']);
});

test('PII·변경 화면은 감사로그 대상(§10.3)', behavioral, () => {
  assert.equal(ia.requiresAuditLog(ia.routeById('interactions.detail')), true);
  assert.equal(ia.requiresAuditLog(ia.routeById('studio.publish')), true);
  assert.equal(ia.requiresAuditLog(ia.routeById('dashboard.overview')), false);
});

const cfg = () => ({
  tenantId: 't_demo', enabled: true, version: 3,
  updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'admin@example.com',
  approved: true, approvedAt: '2026-01-02T00:00:00.000Z', approvedBy: 'legal@example.com',
  channels: {
    voice: { text: '이 통화는 AI 상담원이 응대합니다.', placement: 'session_start' },
    chat: { text: 'AI 상담원이 응대합니다.', placement: 'persistent_banner' },
  },
});

test('AI 고지: 테넌트 문구를 채널별로 해석한다(§7 7.4·§10.1)', behavioral, () => {
  const d = ad.resolveDisclosure(cfg(), 'voice');
  assert.equal(d.show, true);
  assert.equal(d.disclosure.placement, 'session_start');
  assert.equal(d.disclosure.configVersion, 3);
  assert.equal(ad.resolveDisclosure(cfg(), 'visual').show, false);
  assert.equal(ad.resolveDisclosure(cfg(), 'visual').reason, 'channel_not_configured');
});

test('AI 고지: 미승인·빈 문구는 차단 사유로 표시된다', behavioral, () => {
  const notApproved = { ...cfg(), approved: false };
  const r = ad.resolveDisclosure(notApproved, 'voice');
  assert.equal(r.show, false);
  assert.equal(r.reason, 'not_approved');
  assert.equal(r.blocking, true);

  const empty = cfg();
  empty.channels.voice = { text: '  ', placement: 'session_start' };
  assert.equal(ad.resolveDisclosure(empty, 'voice').reason, 'text_empty');
});

test('AI 고지 설정 검증: 음성 상시 배너 금지·미설정 채널 경고', behavioral, () => {
  const bad = cfg();
  bad.channels.voice = { text: '고지', placement: 'persistent_banner' };
  const r = ad.validateDisclosureConfig(bad);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some(i => i.code === 'E_INVALID_PLACEMENT' && i.channel === 'voice'));
  assert.ok(r.issues.some(i => i.code === 'W_CHANNEL_MISSING' && i.channel === 'visual'));

  const off = { ...cfg(), enabled: false };
  const r2 = ad.validateDisclosureConfig(off, ['voice', 'chat']);
  assert.equal(r2.ok, true);
  assert.ok(r2.issues.some(i => i.code === 'W_DISABLED'));
});

test('문구를 바꾸면 승인이 무효화되고 버전이 오른다', behavioral, () => {
  const next = ad.updateDisclosureText(
    cfg(), 'visual', { text: '이 화면은 AI가 안내합니다.', placement: 'persistent_banner' },
    'admin@example.com', '2026-02-01T00:00:00.000Z',
  );
  assert.equal(next.version, 4);
  assert.equal(next.approved, false);
  assert.equal(next.approvedBy, undefined);
  assert.equal(ad.resolveDisclosure(next, 'visual').reason, 'not_approved');
  assert.equal(cfg().version, 3);   // 원본 불변
});
