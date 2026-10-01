// 배포 레지스트리 → 런타임 조회(§5.3·§10·§11.1·§13-3).
//
// 이 모듈이 없던 동안 저장소는 "배포 수명주기가 있다"와 "배포된 것이 실행된다"를 구분하지 못했다.
// 그래서 여기서 고정하는 것은 **편집본이 운영에 나가지 않는다**와 **롤백이 런타임에 닿는다** 둘이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let D = null, L = null;
try {
  D = await import('../src/flow/deployedFlows.ts');
  L = await import('../src/flow/lifecycle.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: D ? false : '타입 스트리핑 미지원 런타임' };

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'flow', 'deployedFlows.ts'), 'utf8');
const SCOPE = { tenantId: 'goone' };
const AT = '2026-09-20T00:00:00.000Z';

const flow = (version, text = `v${version}`) => ({
  id: 'billing',
  version,
  startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text, next: 'name' },
    name: { id: 'name', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.' },
  },
});

/** 게이트를 실제로 지난 리비전을 lifecycle 함수로만 만든다 — 손으로 쓰면 검사가 느슨해진다. */
function approved(reg, version) {
  let r = L.createDraft(reg, { scope: SCOPE, flow: flow(version), by: 'author_kim', at: AT });
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  r = L.submitForReview(r.value, { scope: SCOPE, flowId: 'billing', version }, 'author_kim', AT);
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  r = L.approve(r.value, { scope: SCOPE, flowId: 'billing', version }, 'reviewer_lee', AT);
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  return r.value;
}

function draft(reg, version) {
  const r = L.createDraft(reg, { scope: SCOPE, flow: flow(version), by: 'author_kim', at: AT });
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  return r.value;
}

function published(reg, version, channels) {
  const r = L.publish(reg, { scope: SCOPE, flowId: 'billing', version, channels, by: 'ops_park', at: AT });
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  return r.value;
}

const resolve = (reg, channel, version) => D.resolveDeployedFlow(reg, SCOPE, 'billing', channel, version);

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('채널에 걸린 배포본을 돌려준다(§5.3)', b, () => {
  const reg = published(approved(L.emptyRegistry(), 1), 1, ['voice', 'chat']);
  const r = resolve(reg, 'voice');
  assert.equal(r.code, 'ok');
  assert.equal(r.version, 1);
  assert.equal(r.stage, 'published');
  assert.equal(r.pinned, false);
  assert.equal(r.deployedVersion, 1);
  assert.equal(r.staleStage, undefined);
  assert.equal(r.flow.nodes.greet.text, 'v1');
});

test('채널별 단계적 배포 — 콜봇만 v2, 챗봇은 v1 그대로다(§5.3)', b, () => {
  let reg = published(approved(L.emptyRegistry(), 1), 1, ['voice', 'chat']);
  reg = published(approved(reg, 2), 2, ['voice']);
  assert.equal(resolve(reg, 'voice').version, 2);
  assert.equal(resolve(reg, 'chat').version, 1);
  // 번호가 높은 쪽으로 쏠리지 않는다 — 이것이 종전 조회가 못 하던 일이다.
  assert.equal(resolve(reg, 'voice').flow.nodes.greet.text, 'v2');
  assert.equal(resolve(reg, 'chat').flow.nodes.greet.text, 'v1');
});

test('롤백이 그 채널에만, 그리고 즉시 닿는다', b, () => {
  let reg = published(approved(L.emptyRegistry(), 1), 1, ['voice', 'chat']);
  reg = published(approved(reg, 2), 2, ['voice', 'chat']);
  const rolled = L.rollback(reg, { scope: SCOPE, flowId: 'billing', channel: 'voice', toVersion: 1, by: 'ops_park', at: AT });
  assert.equal(rolled.ok, true);
  assert.equal(resolve(rolled.value, 'voice').version, 1);
  assert.equal(resolve(rolled.value, 'chat').version, 2);
});

// ── 실패·거절 경로 ───────────────────────────────────────────────────────────

test('편집본은 번호가 높아도 운영에 나가지 않는다 — 이 모듈의 존재 이유다', b, () => {
  let reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  reg = draft(reg, 9);                            // 스튜디오에서 방금 저장한 편집본
  assert.equal(resolve(reg, 'voice').version, 1);
  const pinned = resolve(reg, 'voice', 9);
  assert.equal(pinned.code, 'not_approved');
  assert.match(pinned.reasonKo, /승인 기록이 없는/);
  // 채널 없는 조회(검증용)도 편집본을 돌려주지 않는다.
  const anyCh = D.resolveApprovedFlow(reg, SCOPE, 'billing');
  assert.equal(anyCh.code, 'ok');
  assert.equal(anyCh.version, 1);
});

test('미배포와 없음을 같은 값으로 적지 않는다', b, () => {
  const reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  const notDeployed = resolve(reg, 'chat');
  assert.equal(notDeployed.code, 'not_deployed');
  assert.match(notDeployed.reasonKo, /배포된 버전이 없습니다/);
  const none = D.resolveDeployedFlow(reg, SCOPE, 'nope', 'voice');
  assert.equal(none.code, 'no_revision');
});

test('배포가 없을 때 최신 버전으로 대신하지 않는다(§13-3)', b, () => {
  const reg = approved(L.emptyRegistry(), 1);     // 승인은 됐지만 배포 전
  const r = resolve(reg, 'voice');
  assert.equal(r.code, 'not_deployed');
  assert.equal(r.flow, undefined);
});

test('승인된 리비전이 하나도 없으면 원인을 배포 누락으로 적지 않는다', b, () => {
  // 편집본만 있으면 배포는 애초에 불가능했다 — not_deployed 로 적으면 운영자가 배포 화면에서
  // "왜 배포가 안 걸리지"를 묻게 된다.
  const r = resolve(draft(L.emptyRegistry(), 1), 'voice');
  assert.equal(r.code, 'not_approved');
  assert.match(r.reasonKo, /모두 편집·검토 단계/);
});

test('승인 없이 폐기된 리비전(draft → archived)은 게이트를 지난 것이 아니다', b, () => {
  // 전이표가 허용하는 경로이므로 stage 라벨만 보면 'archived' 는 승인 뒤로 읽힌다.
  const reg = draft(L.emptyRegistry(), 3);
  const rev = reg.revisions.find((r) => r.version === 3);
  const archived = { revisions: [{ ...rev, stage: 'archived', archivedAt: AT }], deployments: [] };
  assert.equal(D.gatePassed(archived.revisions[0]), false);
  assert.equal(D.resolveApprovedFlow(archived, SCOPE, 'billing').code, 'not_approved');
});

test('손으로 써 넣은 배포 한 줄로 미승인 시나리오가 나가지 않는다', b, () => {
  const reg = draft(L.emptyRegistry(), 1);
  const forged = {
    revisions: reg.revisions,
    deployments: [{ tenantId: 'goone', flowId: 'billing', channel: 'voice', version: 1, at: AT, by: 'ops_park' }],
  };
  const r = resolve(forged, 'voice');
  assert.equal(r.code, 'not_approved');
});

test('배포가 가리키는 리비전이 사라지면 최신으로 대신하지 않고 드러낸다', b, () => {
  const reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  const broken = { revisions: reg.revisions.filter((r) => r.version !== 1), deployments: reg.deployments };
  // 리비전이 하나도 없으면 no_revision, 다른 버전만 남으면 revision_missing 이다.
  assert.equal(resolve(broken, 'voice').code, 'no_revision');
  const withOther = { revisions: approved(L.emptyRegistry(), 2).revisions, deployments: reg.deployments };
  const r = resolve(withOther, 'voice');
  assert.equal(r.code, 'revision_missing');
  assert.match(r.reasonKo, /레지스트리 불일치/);
});

test('Flow.version 과 리비전 번호가 어긋나면 실행하지 않는다(§8.1)', b, () => {
  const reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  const skewed = {
    revisions: reg.revisions.map((r) => ({ ...r, flow: { ...r.flow, version: 7 } })),
    deployments: reg.deployments,
  };
  const r = resolve(skewed, 'voice');
  assert.equal(r.code, 'version_mismatch');
  assert.match(r.reasonKo, /flow_version/);
});

test('배포는 걸렸는데 단계가 published 가 아니면 실행하되 숨기지 않는다', b, () => {
  const reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  const stale = {
    revisions: reg.revisions.map((r) => ({ ...r, stage: 'archived', archivedAt: AT })),
    deployments: reg.deployments,
  };
  const r = resolve(stale, 'voice');
  assert.equal(r.code, 'ok');
  assert.equal(r.staleStage, 'archived');
});

test('지정본은 게이트는 지나야 하고, 배포본과 다르면 드러난다', b, () => {
  let reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  reg = approved(reg, 2);                         // 승인했지만 아직 배포하지 않았다
  const r = resolve(reg, 'voice', 2);
  assert.equal(r.code, 'ok');
  assert.equal(r.pinned, true);
  assert.equal(r.version, 2);
  assert.equal(r.deployedVersion, 1);
  assert.match(r.reasonKo, /배포본은 v1/);
  assert.equal(resolve(reg, 'voice', 99).code, 'no_revision');
});

// ── 경계·격리 ────────────────────────────────────────────────────────────────

test('다른 테넌트의 리비전·배포는 보이지 않는다(§11.1)', b, () => {
  const reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  const other = D.resolveDeployedFlow(reg, { tenantId: 'rival' }, 'billing', 'voice');
  assert.equal(other.code, 'no_revision');
  assert.throws(() => D.resolveDeployedFlow(reg, { tenantId: '' }, 'billing', 'voice'));
});

test('빈 레지스트리는 예외가 아니라 결과값이다', b, () => {
  const r = resolve(L.emptyRegistry(), 'voice');
  assert.equal(r.code, 'no_revision');
});

test('판정을 복사하지 않는다 — 단계 전이·승인 규칙 이름이 이 파일에 없다(§2)', b, () => {
  for (const name of ['STAGE_TRANSITIONS', 'canTransition', 'submitForReview', 'validateFlow', 'E_SELF_APPROVAL']) {
    assert.equal(SRC.includes(name), false, `판정을 복사했다: ${name}`);
  }
});

// ── 레지스트리 어댑터 ────────────────────────────────────────────────────────

test('조회는 함수로만 받는다 — 스냅샷을 붙들면 publish·rollback 이 닿지 않는다', b, () => {
  assert.throws(() => D.createDeployedFlowRegistry({ registry: L.emptyRegistry(), scope: SCOPE }), /함수가 아닙니다/);
  assert.throws(() => D.createDeployedFlowRegistry({ registry: () => L.emptyRegistry(), scope: { tenantId: '' } }));
});

test('배포가 바뀌면 다음 조회에 그대로 반영된다(그때그때 읽는다)', b, () => {
  let reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  const registry = D.createDeployedFlowRegistry({ registry: () => reg, scope: SCOPE });
  assert.equal(registry.forChannel('billing', 'voice').version, 1);
  reg = published(approved(reg, 2), 2, ['voice']);
  assert.equal(registry.forChannel('billing', 'voice').version, 2);
  const rolled = L.rollback(reg, { scope: SCOPE, flowId: 'billing', channel: 'voice', toVersion: 1, by: 'ops_park', at: AT });
  reg = rolled.value;
  assert.equal(registry.forChannel('billing', 'voice').version, 1);
});

test('실패 조회는 undefined 이고 사유는 explain 에 남는다', b, () => {
  const reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  const registry = D.createDeployedFlowRegistry({ registry: () => reg, scope: SCOPE });
  assert.equal(registry.forChannel('billing', 'chat'), undefined);
  assert.equal(registry.explain('billing', 'chat').code, 'not_deployed');
  assert.equal(registry.forChannel('nope', 'voice'), undefined);
  assert.equal(registry.explain('nope', 'voice').code, 'no_revision');
  assert.equal(registry.contractVersion, D.DEPLOYED_FLOWS_CONTRACT_VERSION);
});

test('채널 없는 get 은 승인된 버전만 돌려준다(편집본은 어떤 경우에도 아니다)', b, () => {
  let reg = published(approved(L.emptyRegistry(), 1), 1, ['voice']);
  reg = draft(reg, 5);
  const registry = D.createDeployedFlowRegistry({ registry: () => reg, scope: SCOPE });
  assert.equal(registry.get('billing').version, 1);
  assert.equal(registry.get('billing', 5), undefined);
  assert.equal(registry.get('billing', 1).version, 1);
});
