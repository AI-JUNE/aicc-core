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

test('단계적 배포 — 이미 published 인 리비전에 채널을 추가하는 것은 재승인 없이 가능하다', behavioral, () => {
  let reg = approved(1);
  reg = lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' }).value;
  const add = lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['chat'], by: 'ops', at: '2026-09-02T03:00:00Z' });
  assert.equal(add.ok, true);
  assert.equal(lc.activeDeployment(add.value, scope, 'greeting', 'voice').version, 1);
  assert.equal(lc.activeDeployment(add.value, scope, 'greeting', 'chat').version, 1);
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

// ── 전이표가 판정인가(§2) ────────────────────────────────────────────────────
// 종전에는 표와 코드가 양방향으로 어긋나 있었고 대조하는 코드가 한 줄도 없었다:
// `rollback` 은 `archived → published` 를 수행하는데 표에는 archived 가 종착으로 적혀 있었고
// (표를 믿은 스튜디오는 장애 시각에 롤백 버튼을 감춘다), 반대로 표가 광고한
// `draft → archived`·`approved → draft`·`approved → archived` 는 수행하는 함수가 없었다.

function ok(r) {
  assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.message}`);
  return r.value;
}

/** 기존 레지스트리 위에 버전을 하나 더 올려 approved 까지 끌고 간다. */
function approvedOn(reg, version) {
  const ref = { scope, flowId: 'greeting', version };
  let next = ok(lc.createDraft(reg, { scope, flow: flow(version), by: 'writer', at: '2026-09-10T00:00:00Z' }));
  next = ok(lc.submitForReview(next, ref, 'writer', '2026-09-10T01:00:00Z'));
  return ok(lc.approve(next, ref, 'reviewer', '2026-09-10T02:00:00Z'));
}

const stageOf = (reg, version) => lc.findRevision(reg, scope, 'greeting', version).stage;

test('전이표가 광고하는 전이는 모두 이 모듈이 실제로 수행하는 것이다(§2·§13-3)', behavioral, () => {
  const performed = new Set();
  const ref = (version) => ({ scope, flowId: 'greeting', version });

  let reg = ok(lc.submitForReview(draft(1), ref(1), 'writer', '2026-09-01T01:00:00Z'));
  performed.add('draft→in_review');

  // 반려는 같은 in_review 에서 갈라지는 다른 길이므로 결과를 이어받지 않는다.
  const back = ok(lc.reject(reg, ref(1), 'reviewer', '문안 수정 필요'));
  assert.equal(stageOf(back, 1), 'draft');
  performed.add('in_review→draft');

  reg = ok(lc.approve(reg, ref(1), 'reviewer', '2026-09-01T02:00:00Z'));
  performed.add('in_review→approved');

  reg = ok(lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' }));
  performed.add('approved→published');

  // 단계적 배포 — 같은 리비전에 채널만 늘린다(재승인 없음).
  reg = ok(lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['chat'], by: 'ops', at: '2026-09-02T03:00:00Z' }));
  assert.equal(stageOf(reg, 1), 'published');
  performed.add('published→published');

  // 새 버전이 두 채널을 다 가져가면 v1 은 어디에도 남지 않아 내려간다.
  reg = approvedOn(reg, 2);
  reg = ok(lc.publish(reg, { scope, flowId: 'greeting', version: 2, channels: ['voice', 'chat'], by: 'ops', at: '2026-09-11T00:00:00Z' }));
  assert.equal(stageOf(reg, 1), 'archived');
  performed.add('published→archived');

  // 사고 대응 — 내려간 리비전으로 되돌린다.
  reg = ok(lc.rollback(reg, { scope, flowId: 'greeting', channel: 'voice', toVersion: 1, by: 'ops', at: '2026-09-11T01:00:00Z' }));
  assert.equal(stageOf(reg, 1), 'published');
  performed.add('archived→published');

  const declared = new Set();
  for (const [from, tos] of Object.entries(lc.STAGE_TRANSITIONS)) for (const to of tos) declared.add(`${from}→${to}`);
  assert.deepEqual([...declared].sort(), [...performed].sort(),
    '표에만 있는 전이는 눌려도 아무 일이 없는 버튼이고, 코드에만 있는 전이는 감춰진 버튼이다');
});

test('전이표는 장식이 아니다 — archived → published 를 빼면 롤백이 거절되고 레지스트리는 그대로다', behavioral, () => {
  let reg = approved(1);
  reg = ok(lc.publish(reg, { scope, flowId: 'greeting', version: 1, channels: ['voice'], by: 'ops', at: '2026-09-01T03:00:00Z' }));
  reg = approvedOn(reg, 2);
  reg = ok(lc.publish(reg, { scope, flowId: 'greeting', version: 2, channels: ['voice'], by: 'ops', at: '2026-09-11T00:00:00Z' }));
  assert.equal(stageOf(reg, 1), 'archived');

  const before = JSON.stringify(reg);
  const saved = lc.STAGE_TRANSITIONS.archived;
  lc.STAGE_TRANSITIONS.archived = [];
  try {
    const rb = lc.rollback(reg, { scope, flowId: 'greeting', channel: 'voice', toVersion: 1, by: 'ops', at: '2026-09-11T01:00:00Z' });
    assert.equal(rb.ok, false);
    assert.equal(rb.code, 'E_STAGE_INVALID');
    assert.match(rb.message, /archived → published/);
  } finally {
    lc.STAGE_TRANSITIONS.archived = saved;
  }
  // 거절된 호출은 레지스트리를 **만들지 못한다** — 절반만 바뀐 상태가 남으면 안 된다.
  assert.equal(JSON.stringify(reg), before);
});

test('수행되지 않는 전이는 표에 없다 — 폐기 op 가 없으므로 draft·approved 에서 archived 로 가는 길도 없다', behavioral, () => {
  assert.equal(lc.canTransition('draft', 'archived'), false);
  assert.equal(lc.canTransition('approved', 'archived'), false);
  assert.equal(lc.canTransition('approved', 'draft'), false);
  // 반대로 코드가 수행하는 두 전이는 표에 있다.
  assert.equal(lc.canTransition('archived', 'published'), true);
  assert.equal(lc.canTransition('published', 'published'), true);
});
