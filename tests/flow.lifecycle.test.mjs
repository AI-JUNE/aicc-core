import { test } from 'node:test';
import assert from 'node:assert/strict';

let lc = null;
try {
  lc = await import('../src/flow/lifecycle.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: lc ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 'acme' };
const other = { tenantId: 'globex' };

function flow(version, opts = {}) {
  return {
    id: 'greeting',
    version,
    startNodeId: 'n1',
    nodes: {
      n1: { id: 'n1', kind: 'Say', text: '안녕하세요', next: opts.broken ? 'nope' : 'n2' },
      n2: { id: 'n2', kind: 'Transfer', queue: 'general' },
    },
  };
}

function draft(version, by = 'writer', opts) {
  const r = lc.createDraft(lc.emptyRegistry(), { scope, flow: flow(version, opts), by, at: '2026-09-01T00:00:00Z' });
  assert.equal(r.ok, true);
  return r.value;
}

/** draft → in_review → approved 까지 진행한 레지스트리 */
function approved(version = 1) {
  let reg = draft(version);
  const ref = { scope, flowId: 'greeting', version };
  const s = lc.submitForReview(reg, ref, 'writer', '2026-09-01T01:00:00Z');
  assert.equal(s.ok, true, s.ok ? '' : s.message);
  const a = lc.approve(s.value, ref, 'reviewer', '2026-09-01T02:00:00Z');
  assert.equal(a.ok, true, a.ok ? '' : a.message);
  return a.value;
}

test('§5.3 검증 오류가 있는 시나리오는 승인 요청 단계에서 막힌다', behavioral, () => {
  const reg = draft(1, 'writer', { broken: true });
  const r = lc.submitForReview(reg, { scope, flowId: 'greeting', version: 1 }, 'writer', '2026-09-01T01:00:00Z');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_VALIDATION_FAILED');
});

test('§10 작성자는 자기 리비전을 승인할 수 없다', behavioral, () => {
  const reg = draft(1);
  const ref = { scope, flowId: 'greeting', version: 1 };
  const s = lc.submitForReview(reg, ref, 'writer', '2026-09-01T01:00:00Z');
  const a = lc.approve(s.value, ref, 'writer', '2026-09-01T02:00:00Z');
  assert.equal(a.ok, false);
  assert.equal(a.code, 'E_SELF_APPROVAL');
});

test('반려는 draft 로 되돌리고 사유를 남긴다', behavioral, () => {
  const reg = draft(1);
  const ref = { scope, flowId: 'greeting', version: 1 };
  const s = lc.submitForReview(reg, ref, 'writer', '2026-09-01T01:00:00Z');
  const r = lc.reject(s.value, ref, 'reviewer', '문구 재검토 필요');
  assert.equal(r.ok, true);
  const rev = lc.findRevision(r.value, scope, 'greeting', 1);
  assert.equal(rev.stage, 'draft');
  assert.equal(rev.rejectedReason, '문구 재검토 필요');
});

test('승인되지 않은 리비전은 배포할 수 없다', behavioral, () => {
  const reg = draft(1);
  const r = lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_NOT_APPROVED');
});

test('§5.3 채널별 부분 배포 — 콜봇만 신버전, 나머지는 미배포로 드러난다', behavioral, () => {
  const reg = approved(1);
  const p = lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' });
  assert.equal(p.ok, true);

  const status = lc.deploymentStatus(p.value, scope, 'greeting');
  const byChannel = Object.fromEntries(status.map(s => [s.channel, s]));
  assert.equal(byChannel.voice.version, 1);
  assert.equal(byChannel.visual.version, undefined);
  assert.equal(byChannel.chat.version, undefined);
  assert.equal(lc.findRevision(p.value, scope, 'greeting', 1).stage, 'published');
});

test('배포되지 않은 채널의 activeFlow 는 undefined — 최신 버전으로 추측하지 않는다', behavioral, () => {
  const reg = approved(1);
  const p = lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['chat'], by: 'ops', at: '2026-09-01T03:00:00Z' });
  assert.equal(lc.activeFlow(p.value, scope, 'greeting', 'chat').version, 1);
  assert.equal(lc.activeFlow(p.value, scope, 'greeting', 'voice'), undefined);
});

test('새 버전 배포 시 어느 채널에도 안 남은 이전 버전만 archived 된다', behavioral, () => {
  // v1 을 voice·chat 에 배포한 뒤, v2 를 voice 에만 배포 → v1 은 chat 에 남아 있으므로 published 유지
  let reg = approved(1);
  reg = lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice', 'chat'], by: 'ops', at: '2026-09-01T03:00:00Z' }).value;

  const d2 = lc.createDraft(reg, { scope, flow: flow(2), by: 'writer', at: '2026-09-01T04:00:00Z' });
  assert.equal(d2.ok, true);
  const ref2 = { scope, flowId: 'greeting', version: 2 };
  reg = lc.submitForReview(d2.value, ref2, 'writer', '2026-09-01T04:10:00Z').value;
  reg = lc.approve(reg, ref2, 'reviewer', '2026-09-01T04:20:00Z').value;
  reg = lc.publish(reg, { scope, flowId: 'greeting', version: 2, channels: ['voice'], by: 'ops', at: '2026-09-01T05:00:00Z' }).value;

  assert.equal(lc.activeDeployment(reg, scope, 'greeting', 'voice').version, 2);
  assert.equal(lc.activeDeployment(reg, scope, 'greeting', 'chat').version, 1);
  assert.equal(lc.findRevision(reg, scope, 'greeting', 1).stage, 'published', 'chat 에 살아 있으므로 유지');

  // chat 까지 v2 로 올리면 v1 은 archived
  reg = lc.publish(reg, { scope, flowId: 'greeting', version: 2, channels: ['chat'], by: 'ops', at: '2026-09-01T06:00:00Z' }).value;
  assert.equal(lc.findRevision(reg, scope, 'greeting', 1).stage, 'archived');
});

test('§9.3 롤백은 과거 배포 이력이 있는 버전으로만 가능하다', behavioral, () => {
  let reg = approved(1);
  reg = lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' }).value;
  reg = lc.createDraft(reg, { scope, flow: flow(2), by: 'writer', at: '2026-09-01T04:00:00Z' }).value;

  const never = lc.rollback(reg, { scope, flowId: 'greeting', channel: 'voice', toVersion: 2, by: 'ops', at: '2026-09-01T07:00:00Z' });
  assert.equal(never.ok, false);
  assert.equal(never.code, 'E_NOT_APPROVED');

  const same = lc.rollback(reg, { scope, flowId: 'greeting', channel: 'voice', toVersion: 1, by: 'ops', at: '2026-09-01T07:00:00Z' });
  assert.equal(same.code, 'E_SAME_VERSION');
});

test('롤백은 직전 버전을 rolledBackFrom 으로 남긴다', behavioral, () => {
  let reg = approved(1);
  reg = lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' }).value;
  const ref2 = { scope, flowId: 'greeting', version: 2 };
  reg = lc.createDraft(reg, { scope, flow: flow(2), by: 'writer', at: '2026-09-01T04:00:00Z' }).value;
  reg = lc.submitForReview(reg, ref2, 'writer', '2026-09-01T04:10:00Z').value;
  reg = lc.approve(reg, ref2, 'reviewer', '2026-09-01T04:20:00Z').value;
  reg = lc.publish(reg, { scope, flowId: 'greeting', version: 2, channels: ['voice'], by: 'ops', at: '2026-09-01T05:00:00Z' }).value;

  const back = lc.rollback(reg, { scope, flowId: 'greeting', channel: 'voice', toVersion: 1, by: 'ops', at: '2026-09-01T06:00:00Z' });
  assert.equal(back.ok, true);
  const dep = lc.activeDeployment(back.value, scope, 'greeting', 'voice');
  assert.equal(dep.version, 1);
  assert.equal(dep.rolledBackFrom, 2);
  assert.equal(lc.findRevision(back.value, scope, 'greeting', 1).stage, 'published');
  assert.equal(lc.findRevision(back.value, scope, 'greeting', 2).stage, 'archived');
});

test('§11.1 다른 테넌트의 리비전은 조회·배포 대상이 되지 않는다', behavioral, () => {
  const reg = approved(1);
  assert.equal(lc.findRevision(reg, other, 'greeting', 1), undefined);
  assert.deepEqual(lc.revisionsOf(reg, other, 'greeting'), []);
  const p = lc.publish(reg, { scope: other, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'E_REVISION_NOT_FOUND');
});

test('버전 중복 등록 금지 · nextVersion 은 마지막 +1', behavioral, () => {
  const reg = draft(1);
  const dup = lc.createDraft(reg, { scope, flow: flow(1), by: 'writer', at: '2026-09-01T00:00:00Z' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'E_VERSION_EXISTS');
  assert.equal(lc.nextVersion(reg, scope, 'greeting'), 2);
  assert.equal(lc.nextVersion(reg, scope, 'unknown-flow'), 1);
});

test('전이표에 없는 전이는 canTransition 이 거부한다', behavioral, () => {
  assert.equal(lc.canTransition('draft', 'published'), false);
  assert.equal(lc.canTransition('archived', 'draft'), false);
  assert.equal(lc.canTransition('in_review', 'approved'), true);
});

test('레지스트리는 불변 — 변경 함수는 원본을 건드리지 않는다', behavioral, () => {
  const reg = approved(1);
  const before = JSON.stringify(reg);
  lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' });
  assert.equal(JSON.stringify(reg), before);
});
