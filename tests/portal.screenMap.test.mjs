// IA ↔ 화면 매핑 검사.
//
// 핵심은 두 가지다: (1) IA 밖 화면을 만들지 못하게 막는다(권한·감사 밖의 화면이 된다),
// (2) 감사 대상 화면을 배선 없이 "구현 완료"로 적지 못하게 막는다(§10.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/portal/screenMap.ts';
import { PORTAL_ROUTES, requiresAuditLog } from '../src/portal/ia.ts';

const codes = (issues) => issues.map((i) => i.code).sort();
const full = (over = {}) => PORTAL_ROUTES.map((r) => ({ routeId: r.id, status: 'planned', ...(over[r.id] ?? {}) }));

test('현재 매핑은 모든 IA 라우트를 빠짐없이 다룬다', () => {
  const issues = m.validateScreenMap(m.PORTAL_SCREEN_MAP);
  assert.equal(m.screenMapOk(issues), true, m.formatScreenMapReport(issues));
});

test('현재 매핑은 실제 상태(미착수)를 그대로 적고 있다', () => {
  const cov = m.screenMapCoverage(m.PORTAL_SCREEN_MAP);
  assert.equal(cov.total, PORTAL_ROUTES.length);
  assert.equal(cov.byStatus.planned, PORTAL_ROUTES.length);
  assert.equal(cov.auditWired, 0);
  assert.ok(cov.auditRequired > 0);
});

test('IA 에 없는 라우트를 매핑하면 오류다', () => {
  const issues = m.validateScreenMap([...full(), { routeId: 'reports.secret', status: 'implemented', component: 'x.tsx' }]);
  assert.deepEqual(codes(issues), ['E_UNKNOWN_ROUTE']);
  assert.equal(m.screenMapOk(issues), false);
});

test('매핑이 빠진 라우트를 잡는다', () => {
  const issues = m.validateScreenMap(full().slice(1));
  assert.deepEqual(codes(issues), ['E_UNMAPPED']);
  assert.equal(issues[0].routeId, PORTAL_ROUTES[0].id);
});

test('한 라우트에 매핑이 둘이면 잡는다', () => {
  const first = PORTAL_ROUTES[0].id;
  const issues = m.validateScreenMap([...full(), { routeId: first, status: 'planned' }]);
  assert.deepEqual(codes(issues), ['E_DUPLICATE']);
});

test('구현이라면서 화면 위치가 없으면 근거 없는 완료다', () => {
  const target = PORTAL_ROUTES.find((r) => !requiresAuditLog(r));
  const issues = m.validateScreenMap(full({ [target.id]: { status: 'implemented', emptyState: true, errorState: true } }));
  assert.deepEqual(codes(issues), ['E_NO_COMPONENT']);
});

test('감사 대상 화면을 배선 없이 구현 완료로 적을 수 없다(§10.2)', () => {
  const target = PORTAL_ROUTES.find((r) => r.pii);
  const issues = m.validateScreenMap(full({
    [target.id]: { status: 'implemented', component: 'app/x.tsx', emptyState: true, errorState: true },
  }));
  assert.deepEqual(codes(issues), ['E_AUDIT_UNWIRED']);
});

test('감사 대상이 아니면 배선을 요구하지 않는다', () => {
  const target = PORTAL_ROUTES.find((r) => !requiresAuditLog(r));
  const issues = m.validateScreenMap(full({
    [target.id]: { status: 'implemented', component: 'app/x.tsx', emptyState: true, errorState: true },
  }));
  assert.deepEqual(issues, []);
});

test('빈 상태·오류 상태 누락은 경고이지 오류가 아니다', () => {
  const target = PORTAL_ROUTES.find((r) => !requiresAuditLog(r));
  const issues = m.validateScreenMap(full({ [target.id]: { status: 'implemented', component: 'app/x.tsx' } }));
  assert.deepEqual(codes(issues), ['W_NO_EMPTY_STATE', 'W_NO_ERROR_STATE']);
  assert.equal(m.screenMapOk(issues), true);
});

test('사유 없는 보류는 누락과 구분되지 않으므로 막는다', () => {
  const target = PORTAL_ROUTES[0].id;
  const issues = m.validateScreenMap(full({ [target]: { status: 'deferred' } }));
  assert.deepEqual(codes(issues), ['E_DEFER_REASON']);
  const withReason = m.validateScreenMap(full({ [target]: { status: 'deferred', note: '2차 범위' } }));
  assert.deepEqual(withReason, []);
});

test('미착수·작업중 화면에는 빈 상태·배선을 요구하지 않는다', () => {
  const target = PORTAL_ROUTES.find((r) => r.pii).id;
  assert.deepEqual(m.validateScreenMap(full({ [target]: { status: 'in_progress', repo: '7. Portal' } })), []);
});

test('빈 매핑은 전 라우트 누락으로 잡힌다', () => {
  const issues = m.validateScreenMap([]);
  assert.equal(issues.length, PORTAL_ROUTES.length);
  assert.equal(new Set(codes(issues)).size, 1);
  assert.equal(m.screenMapOk(issues), false);
});

test('IA 밖 라우트는 진행률의 분자도 분모도 아니다', () => {
  const cov = m.screenMapCoverage([...full(), { routeId: 'nope', status: 'implemented' }]);
  assert.equal(cov.byStatus.implemented, 0);
  assert.equal(cov.byStatus.planned, PORTAL_ROUTES.length);
});

test('감사 배선 집계는 구현 상태일 때만 센다', () => {
  const target = PORTAL_ROUTES.find((r) => r.pii).id;
  const wiredButPlanned = m.screenMapCoverage(full({ [target]: { status: 'planned', auditWired: true } }));
  assert.equal(wiredButPlanned.auditWired, 0);
  const wired = m.screenMapCoverage(full({
    [target]: { status: 'implemented', component: 'x.tsx', auditWired: true },
  }));
  assert.equal(wired.auditWired, 1);
});

test('문서는 자료에서 생성되며 비율(%)을 적지 않는다(§13-3)', () => {
  const md = m.renderScreenMapMarkdown(m.PORTAL_SCREEN_MAP);
  assert.match(md, /# 관리 포털 IA ↔ 화면 매핑/);
  assert.match(md, /직접 고치지 말 것/);
  assert.equal(/\d+(\.\d+)?%/.test(md), false, '문서에 비율 수치가 들어갔다');
  for (const r of PORTAL_ROUTES) assert.ok(md.includes(`\`${r.id}\``), `문서에 ${r.id} 가 없다`);
});

test('매핑이 없는 라우트는 문서에서 "매핑 없음" 으로 드러난다', () => {
  const md = m.renderScreenMapMarkdown(full().slice(1));
  assert.match(md, /\*\*매핑 없음\*\*/);
});

test('같은 비고는 묶어서 한 줄로 낸다', () => {
  const md = m.renderScreenMapMarkdown(m.PORTAL_SCREEN_MAP);
  const noteLines = md.split('\n').filter((l) => l.startsWith('- 포털 저장소 미착수'));
  assert.equal(noteLines.length, 1);
  assert.match(noteLines[0], new RegExp(`${PORTAL_ROUTES.length}건`));
});

test('보고서는 사람이 읽을 수 있는 한 줄씩을 낸다', () => {
  assert.equal(m.formatScreenMapReport([]), 'IA↔화면 매핑: 이상 없음');
  assert.match(m.formatScreenMapReport(m.validateScreenMap([])), /\[오류\] E_UNMAPPED/);
});
