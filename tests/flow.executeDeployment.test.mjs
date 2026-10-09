// 스튜디오 수명주기 실행기 검사 — 설계서 §5.3·§6.1·§10·§10.2·§11.1·§13-3.
//
// 고정하는 것은 "배포된다"가 아니라 **게이트를 지나가는 길이 없던 동안 열려 있던 여섯 가지**다.
// 전이 판정은 실제 `lifecycle.ts` 를, 커넥터 대조는 실제 `validateFlowConnectors` 를,
// 권한·기록은 실제 `audit/access.ts` 를 지난다 — 목으로 대신하면 "배선됐다"가 검사되지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let X = null, L = null, A = null, V = null;
try {
  X = await import('../src/flow/executeDeployment.ts');
  L = await import('../src/flow/lifecycle.ts');
  A = await import('../src/audit/log.ts');
  V = await import('../src/flow/validate.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: X ? false : '타입 스트리핑 미지원 런타임' };

const SRC = X
  ? readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'flow', 'executeDeployment.ts'), 'utf8')
  : '';

const SCOPE = { tenantId: 'goone' };
const AT = '2026-09-20T00:00:00.000Z';
// 테스트용 해시 — 체인 연결만 확인한다(실제 SHA-256 은 호스트가 주입한다).
const hash = (s) => `h${[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 0xffffffff, 7).toString(16)}`;

const ADMIN = { userId: 'admin_park', roles: ['admin'], tenantId: 'goone' };
const AUTHOR = { userId: 'author_kim', roles: ['admin'], tenantId: 'goone' };
const AGENT = { userId: 'agent_choi', roles: ['agent'], tenantId: 'goone' };

const flow = (version, over = {}) => ({
  id: 'billing',
  version,
  startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: `v${version}`, next: 'name' },
    name: { id: 'name', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.' },
  },
  ...over,
});

/** Api 노드를 가진 Flow — 커넥터 대조가 걸리는 모양. */
const apiFlow = (version, connectorId = 'crm_lookup') => ({
  id: 'billing',
  version,
  startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'call' },
    call: { id: 'call', kind: 'Api', connectorId, next: 'bye' },
    bye: { id: 'bye', kind: 'Say', text: '확인했습니다.' },
  },
});

/** 레지스트리를 실제로 저장하는 호스트. (마) 가 재현되지 않게 commit 을 반드시 지나게 한다. */
function host(initial = L.emptyRegistry()) {
  const box = { reg: initial, commits: 0 };
  return {
    box,
    ports: {
      registry: () => box.reg,
      commit: (next) => { box.reg = next; box.commits += 1; },
      hash,
    },
  };
}

const run = (chain, ports, over = {}) =>
  X.executeDeployment(chain, {
    scope: SCOPE, actor: ADMIN, op: 'create', at: AT, recordId: `r${Math.random()}`, ...over,
  }, ports);

const chain0 = () => A.emptyChain(SCOPE);

/** 초안 → 승인 요청 → 승인까지 실행기로만 올린다. */
function approvedVia(h, version = 1, f = flow) {
  let chain = chain0();
  let r = run(chain, h.ports, { op: 'create', actor: AUTHOR, flow: f(version), recordId: 'r1' });
  assert.equal(r.status, 'ok', r.messageKo);
  r = run(r.chain, h.ports, { op: 'submit', actor: AUTHOR, flowId: 'billing', version, recordId: 'r2' });
  assert.equal(r.status, 'ok', r.messageKo);
  r = run(r.chain, h.ports, { op: 'approve', actor: ADMIN, flowId: 'billing', version, recordId: 'r3' });
  assert.equal(r.status, 'ok', r.messageKo);
  return r.chain;
}

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('초안→승인요청→승인→배포가 레지스트리에 저장되고 감사에 남는다', b, () => {
  const h = host();
  let chain = approvedVia(h);
  const r = run(chain, h.ports, {
    op: 'publish', flowId: 'billing', version: 1, channels: ['voice'], recordId: 'r4',
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.committed, true);
  assert.equal(h.box.commits, 4);
  // 저장된 레지스트리가 실제로 배포를 들고 있다 — (마) 가 닫혔다는 확인.
  assert.equal(L.activeDeployment(h.box.reg, SCOPE, 'billing', 'voice').version, 1);
  assert.deepEqual(
    r.deployments.map((d) => [d.channel, d.version]),
    [['voice', 1], ['visual', undefined], ['chat', undefined]],
  );
  // (가) 배포가 감사에 남는다.
  const last = r.record;
  assert.equal(last.action, 'publish');
  assert.equal(last.result, 'success');
  assert.equal(last.route_id, 'studio.publish');
  assert.equal(last.actor_user_id, 'admin_park');
  assert.equal(r.chain.records.length, 4);
});

test('채널별 단계적 배포가 성립한다(§5.3)', b, () => {
  const h = host();
  let chain = approvedVia(h);
  chain = run(chain, h.ports, { op: 'publish', flowId: 'billing', version: 1, channels: ['voice'], recordId: 'r4' }).chain;
  const r = run(chain, h.ports, { op: 'publish', flowId: 'billing', version: 1, channels: ['chat'], recordId: 'r5' });
  assert.equal(r.status, 'ok');
  assert.equal(L.activeDeployment(h.box.reg, SCOPE, 'billing', 'voice').version, 1);
  assert.equal(L.activeDeployment(h.box.reg, SCOPE, 'billing', 'chat').version, 1);
});

test('반려는 사유와 함께 감사에 남고 단계가 draft 로 돌아간다', b, () => {
  const h = host();
  let chain = run(chain0(), h.ports, { op: 'create', actor: AUTHOR, flow: flow(1), recordId: 'r1' }).chain;
  chain = run(chain, h.ports, { op: 'submit', actor: AUTHOR, flowId: 'billing', version: 1, recordId: 'r2' }).chain;
  const r = run(chain, h.ports, {
    op: 'reject', flowId: 'billing', version: 1, reason: '고지 문구 누락', recordId: 'r3',
  });
  assert.equal(r.status, 'ok');
  assert.equal(L.findRevision(h.box.reg, SCOPE, 'billing', 1).stage, 'draft');
  assert.equal(r.record.action, 'approve');
  assert.ok(r.record.detail_masked.includes('고지 문구 누락'));
});

test('롤백은 채널 하나만 되돌리고 직전 버전을 감사에 적는다', b, () => {
  const h = host();
  let chain = approvedVia(h, 1);
  chain = approvedVia(h, 2);
  chain = run(chain, h.ports, { op: 'publish', flowId: 'billing', version: 1, channels: ['voice', 'chat'], recordId: 'r7' }).chain;
  chain = run(chain, h.ports, { op: 'publish', flowId: 'billing', version: 2, channels: ['voice', 'chat'], recordId: 'r8' }).chain;
  const r = run(chain, h.ports, { op: 'rollback', flowId: 'billing', channel: 'voice', toVersion: 1, recordId: 'r9' });
  assert.equal(r.status, 'ok');
  assert.equal(L.activeDeployment(h.box.reg, SCOPE, 'billing', 'voice').version, 1);
  assert.equal(L.activeDeployment(h.box.reg, SCOPE, 'billing', 'chat').version, 2);
  assert.ok(r.record.detail_masked.includes('←v2'));
});

// ── (가) 기록 없는 변경이 없다 ───────────────────────────────────────────────

test('모든 전이가 감사 체인에 남고 체인이 검증된다', b, () => {
  const h = host();
  const chain = approvedVia(h);
  assert.equal(chain.records.length, 3);
  assert.deepEqual(chain.records.map((r) => r.action), ['create', 'update', 'approve']);
  assert.equal(A.verifyChain(chain, hash).ok, true);
});

test('감사 레코드 id 가 없으면 변경을 반영하지 않는다(§10.2)', b, () => {
  const h = host();
  const r = run(chain0(), h.ports, { op: 'create', flow: flow(1), recordId: '' });
  assert.equal(r.status, 'invalid');
  assert.equal(h.box.commits, 0);
  assert.equal(r.recorded, false);
});

// ── (나) 권한 ────────────────────────────────────────────────────────────────

test('결함 재현: lifecycle 은 역할을 모른다 — 상담사 id 로도 전이가 성립한다', b, () => {
  const r = L.createDraft(L.emptyRegistry(), { scope: SCOPE, flow: flow(1), by: 'agent_choi', at: AT });
  assert.equal(r.ok, true);
});

test('스튜디오 권한이 없는 역할은 거부되고 거부가 기록된다', b, () => {
  const h = host();
  const r = run(chain0(), h.ports, { op: 'create', actor: AGENT, flow: flow(1), recordId: 'r1' });
  assert.equal(r.status, 'denied');
  assert.equal(h.box.commits, 0);
  assert.equal(r.recorded, true);
  assert.equal(r.record.result, 'denied');
  // 권한 유무 외의 정보를 흘리지 않는다.
  assert.deepEqual(r.issues, []);
});

test('다른 테넌트 행위자는 거부되고 행위자 테넌트 체인에 남는다(§11.1)', b, () => {
  const h = host();
  const foreign = { userId: 'x', roles: ['admin'], tenantId: 'rival' };
  const chain = A.emptyChain({ tenantId: 'rival' });
  const r = run(chain, h.ports, { op: 'create', actor: foreign, flow: flow(1), recordId: 'r1' });
  assert.equal(r.status, 'denied');
  assert.equal(r.record.tenant_id, 'rival');
  assert.equal(h.box.commits, 0);
});

test('테넌트 없는 스코프는 던진다(§11.1)', b, () => {
  const h = host();
  assert.throws(() => X.executeDeployment(chain0(), {
    scope: { tenantId: '' }, actor: ADMIN, op: 'create', at: AT, recordId: 'r1', flow: flow(1),
  }, h.ports));
});

// ── (다) 행위자를 두 번 선언할 자리가 없다 ──────────────────────────────────

test('자기승인은 막힌다 — 승인자 칸에 남의 id 를 적을 자리가 없다(§10)', b, () => {
  const h = host();
  let chain = run(chain0(), h.ports, { op: 'create', actor: AUTHOR, flow: flow(1), recordId: 'r1' }).chain;
  chain = run(chain, h.ports, { op: 'submit', actor: AUTHOR, flowId: 'billing', version: 1, recordId: 'r2' }).chain;
  const r = run(chain, h.ports, { op: 'approve', actor: AUTHOR, flowId: 'billing', version: 1, recordId: 'r3' });
  assert.equal(r.status, 'rejected');
  assert.ok(r.issues.some((i) => i.includes('E_SELF_APPROVAL')));
  assert.equal(r.record.result, 'denied');
  assert.equal(L.findRevision(h.box.reg, SCOPE, 'billing', 1).stage, 'in_review');
});

test('요청에 by 를 실을 자리가 없다 — 행위자는 actor.userId 하나다', b, () => {
  assert.ok(!/\bby\?:/.test(SRC));
  assert.ok(SRC.includes('const by = req.actor.userId'));
});

// ── 게이트 1: 검증 ───────────────────────────────────────────────────────────

test('검증 오류가 있으면 승인 요청이 막히고 사유가 감사에 남는다', b, () => {
  const h = host();
  const broken = { id: 'billing', version: 1, startNodeId: 'nope', nodes: {} };
  let chain = run(chain0(), h.ports, { op: 'create', actor: AUTHOR, flow: broken, recordId: 'r1' }).chain;
  const r = run(chain, h.ports, { op: 'submit', actor: AUTHOR, flowId: 'billing', version: 1, recordId: 'r2' });
  assert.equal(r.status, 'rejected');
  assert.ok(r.issues.some((i) => i.includes('E_VALIDATION_FAILED')));
  assert.equal(r.committed, false);
});

test('승인되지 않은 리비전은 배포되지 않는다', b, () => {
  const h = host();
  const chain = run(chain0(), h.ports, { op: 'create', actor: AUTHOR, flow: flow(1), recordId: 'r1' }).chain;
  const r = run(chain, h.ports, { op: 'publish', flowId: 'billing', version: 1, channels: ['voice'], recordId: 'r2' });
  assert.equal(r.status, 'rejected');
  assert.ok(r.issues.some((i) => i.includes('E_NOT_APPROVED')));
  assert.equal(h.box.commits, 1);   // 초안 등록 한 번뿐
});

// ── (라) 커넥터 대조가 배포 게이트에 걸린다(§6.1) ───────────────────────────

test('결함 재현: validateFlowConnectors 는 미등록 커넥터를 잡지만 부르는 곳이 없었다', b, () => {
  const issues = V.validateFlowConnectors(apiFlow(1), []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'E_CONNECTOR_UNDEFINED');
});

test('미등록 커넥터를 가리키는 시나리오는 배포되지 않는다', b, () => {
  const h = host();
  const chain = approvedVia(h, 1, apiFlow);
  const r = run(chain, h.ports, {
    op: 'publish', flowId: 'billing', version: 1, channels: ['voice'],
    connectorIds: ['other_api'], recordId: 'r4',
  });
  assert.equal(r.status, 'rejected');
  assert.ok(r.issues.some((i) => i.includes('crm_lookup')));
  assert.equal(L.activeDeployment(h.box.reg, SCOPE, 'billing', 'voice'), undefined);
});

test('커넥터 목록을 선언하지 않으면 통과시키지 않는다 — 대조하지 못한 것은 통과가 아니다(§13-3)', b, () => {
  const h = host();
  const chain = approvedVia(h, 1, apiFlow);
  const r = run(chain, h.ports, {
    op: 'publish', flowId: 'billing', version: 1, channels: ['voice'], recordId: 'r4',
  });
  assert.equal(r.status, 'rejected');
  assert.ok(r.issues.some((i) => i.includes('connectorIds')));
});

test('Api 노드가 없으면 커넥터 목록을 요구하지 않는다', b, () => {
  const h = host();
  const chain = approvedVia(h, 1);
  const r = run(chain, h.ports, {
    op: 'publish', flowId: 'billing', version: 1, channels: ['voice'], recordId: 'r4',
  });
  assert.equal(r.status, 'ok');
});

test('등록된 커넥터면 배포된다', b, () => {
  const h = host();
  const chain = approvedVia(h, 1, apiFlow);
  const r = run(chain, h.ports, {
    op: 'publish', flowId: 'billing', version: 1, channels: ['voice'],
    connectorIds: ['crm_lookup'], recordId: 'r4',
  });
  assert.equal(r.status, 'ok');
});

test('롤백도 커넥터를 대조한다 — 과거 버전이 가리킨 커넥터가 지워졌을 수 있다', b, () => {
  const h = host();
  let chain = approvedVia(h, 1, apiFlow);
  chain = approvedVia(h, 2);
  chain = run(chain, h.ports, {
    op: 'publish', flowId: 'billing', version: 1, channels: ['voice'],
    connectorIds: ['crm_lookup'], recordId: 'r7',
  }).chain;
  chain = run(chain, h.ports, { op: 'publish', flowId: 'billing', version: 2, channels: ['voice'], recordId: 'r8' }).chain;
  const r = run(chain, h.ports, {
    op: 'rollback', flowId: 'billing', channel: 'voice', toVersion: 1, connectorIds: [], recordId: 'r9',
  });
  assert.equal(r.status, 'rejected');
  assert.equal(L.activeDeployment(h.box.reg, SCOPE, 'billing', 'voice').version, 2);
});

// ── (마) 저장 ────────────────────────────────────────────────────────────────

test('레지스트리를 함수로 받지 않으면 생성 자체가 거부된다', b, () => {
  assert.throws(() => X.executeDeployment(chain0(), {
    scope: SCOPE, actor: ADMIN, op: 'create', at: AT, recordId: 'r1', flow: flow(1),
  }, { registry: L.emptyRegistry(), commit: () => {}, hash }));
  assert.throws(() => X.executeDeployment(chain0(), {
    scope: SCOPE, actor: ADMIN, op: 'create', at: AT, recordId: 'r1', flow: flow(1),
  }, { registry: () => L.emptyRegistry(), hash }));
});

test('저장이 실패하면 성공으로도 미실행으로도 적지 않는다', b, () => {
  const ports = {
    registry: () => L.emptyRegistry(),
    commit: () => { throw new Error('운영 DB 접속 실패: postgres://u:pw@db/aicc'); },
    hash,
  };
  const r = X.executeDeployment(chain0(), {
    scope: SCOPE, actor: ADMIN, op: 'create', at: AT, recordId: 'r1', flow: flow(1),
  }, ports);
  assert.equal(r.status, 'uncommitted');
  assert.equal(r.committed, false);
  assert.equal(r.recorded, true);
  assert.equal(r.record.result, 'error');
  assert.ok(r.messageKo.includes('확인'));
});

test('직전 전이가 보이는 상태에서 다음 전이가 계산된다(스냅샷을 붙들지 않는다)', b, () => {
  const h = host();
  const chain = run(chain0(), h.ports, { op: 'create', actor: AUTHOR, flow: flow(1), recordId: 'r1' }).chain;
  // 같은 리비전을 또 등록하면 레지스트리를 다시 읽었다는 뜻이다.
  const dup = run(chain, h.ports, { op: 'create', actor: AUTHOR, flow: flow(1), recordId: 'r2' });
  assert.equal(dup.status, 'rejected');
  assert.ok(dup.issues.some((i) => i.includes('E_VERSION_EXISTS')));
});

// ── (바) 채널 선언 ───────────────────────────────────────────────────────────

test('결함 재현: lifecycle.publish 는 중복 채널 선언으로 배포 행을 둘 만든다', b, () => {
  let reg = L.createDraft(L.emptyRegistry(), { scope: SCOPE, flow: flow(1), by: 'a', at: AT }).value;
  reg = L.submitForReview(reg, { scope: SCOPE, flowId: 'billing', version: 1 }, 'a', AT).value;
  reg = L.approve(reg, { scope: SCOPE, flowId: 'billing', version: 1 }, 'b', AT).value;
  const out = L.publish(reg, { scope: SCOPE, flowId: 'billing', version: 1, channels: ['voice', 'voice'], by: 'c', at: AT });
  assert.equal(out.value.deployments.length, 2);
});

test('중복 채널 선언은 고쳐 쓰지 않고 거절한다', b, () => {
  const h = host();
  const chain = approvedVia(h);
  const r = run(chain, h.ports, {
    op: 'publish', flowId: 'billing', version: 1, channels: ['voice', 'voice'], recordId: 'r4',
  });
  assert.equal(r.status, 'invalid');
  assert.ok(r.issues.some((i) => i.includes('중복')));
  assert.equal(r.recorded, false);
});

test('빈 채널 목록·없는 버전·빈 반려사유·롤백 채널 누락을 거절한다', b, () => {
  const h = host();
  const chain = approvedVia(h);
  const cases = [
    { op: 'publish', flowId: 'billing', version: 1, channels: [] },
    { op: 'publish', flowId: 'billing', channels: ['voice'] },
    { op: 'reject', flowId: 'billing', version: 1, reason: '' },
    { op: 'rollback', flowId: 'billing', toVersion: 1 },
    { op: 'submit', version: 1 },
  ];
  for (const c of cases) {
    const r = run(chain, h.ports, { ...c, recordId: 'rx' });
    assert.equal(r.status, 'invalid', JSON.stringify(c));
    assert.equal(r.recorded, false);
  }
});

// ── 사전 점검 ────────────────────────────────────────────────────────────────

test('사전 점검은 전이를 일으키지 않고 검증·커넥터 결과를 함께 돌려준다', b, () => {
  const ok = X.preflightPublish(flow(1));
  assert.equal(ok.ok, true);
  const miss = X.preflightPublish(apiFlow(1));
  assert.equal(miss.ok, false);
  assert.equal(miss.connectorIssues.length, 1);
  const bad = X.preflightPublish({ id: 'x', version: 1, startNodeId: 'nope', nodes: {} });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
});

// ── 경계 ─────────────────────────────────────────────────────────────────────

test('판정을 복사하지 않는다 — 전이표·역할 판정·커넥터 규칙이 이 파일에 없다(§2)', b, () => {
  const code = SRC.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
  assert.ok(!code.includes('STAGE_TRANSITIONS'));
  assert.ok(!code.includes("'in_review'"));
  assert.ok(!code.includes('tenant_owner'));          // 역할 목록은 portal/ia.ts 하나다
  assert.ok(!code.includes('canAccess('));            // 권한 판정은 decideAccess 하나를 지난다
  assert.ok(!code.includes('E_CONNECTOR_UNDEFINED')); // 커넥터 판정은 validateFlowConnectors 하나다
  assert.ok(code.includes('decideAccess(') && code.includes('validateFlowConnectors('));
});

test('저장 실패 사유의 자격증명·개인정보는 마스킹을 지난다(§10.3)', b, () => {
  const ports = {
    registry: () => L.emptyRegistry(),
    commit: () => { throw new Error('010-1234-5678 로 통보 실패'); },
    hash,
  };
  const r = X.executeDeployment(chain0(), {
    scope: SCOPE, actor: ADMIN, op: 'create', at: AT, recordId: 'r1', flow: flow(1),
  }, ports);
  assert.ok(!r.issues.join(' ').includes('010-1234-5678'));
  assert.ok(!String(r.record.detail).includes('010-1234-5678'));
});

test('계약 버전과 라우트 id 가 노출된다', b, () => {
  assert.equal(typeof X.DEPLOYMENT_EXEC_CONTRACT_VERSION, 'number');
  assert.equal(X.STUDIO_PUBLISH_ROUTE_ID, 'studio.publish');
  assert.equal(X.STUDIO_EDITOR_ROUTE_ID, 'studio.editor');
});
