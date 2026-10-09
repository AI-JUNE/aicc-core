// 동의 철회 실행기 검사 — 설계서 §10.1·§10.2·§10.3·§11.1·§13-3.
//
// 고정하는 것은 "철회된다"가 아니라 **"철회했다"는 화면과 어긋난 상태를 만드는 여섯 가지**다.
// 상태 판정은 실제 `currentState`, 기록은 실제 `withdraw`, 게이트는 실제 `gateAction`,
// 권한·기록은 실제 `audit/access.ts` 를 지난다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let W = null, C = null, EC = null, A = null, IA = null;
try {
  W = await import('../src/consent/executeWithdrawal.ts');
  C = await import('../src/consent/consent.ts');
  EC = await import('../src/consent/executeConsent.ts');
  A = await import('../src/audit/log.ts');
  IA = await import('../src/portal/ia.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: W ? false : '타입 스트리핑 미지원 런타임' };

const SRC = W
  ? readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'consent', 'executeWithdrawal.ts'), 'utf8')
  : '';

const SCOPE = { tenantId: 'goone' };
const AT = '2026-09-20T00:00:00.000Z';
const SUBJ = 'cust_8f3a91';
const hash = (s) => `h${[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 0xffffffff, 7).toString(16)}`;

const ADMIN = { userId: 'admin_park', roles: ['admin'], tenantId: 'goone' };
const AGENT = { userId: 'agent_choi', roles: ['agent'], tenantId: 'goone' };

const policy = (over = {}) => ({
  tenantId: 'goone',
  requirements: [
    { purpose: 'personal_data_collection', required: true },
    { purpose: 'marketing', required: false },
    { purpose: 'recording', required: true, validForDays: 30 },
  ],
  version: 3,
  updatedAt: AT,
  updatedBy: 'legal_kim',
  approved: true,
  ...over,
});

const granted = (purpose, at = '2026-09-01T00:00:00.000Z') =>
  C.grant(policy(), { subjectRef: SUBJ, purpose, via: 'voice', at });

const chain0 = () => A.emptyChain(SCOPE);

const req = (over = {}) => ({
  scope: SCOPE, actor: ADMIN, subjectRef: SUBJ,
  purposes: ['personal_data_collection'], via: 'portal', at: AT, recordId: 'r1', ...over,
});

const run = (store, over = {}, pol = policy()) =>
  W.executeWithdrawal(chain0(), req(over), store, pol, hash);

// ── (가) IA 라우트가 있어야 철회가 실행될 수 있다 ───────────────────────────

test('철회 라우트가 IA 에 선언돼 있다 — 없으면 unknown_route 로 거부된다', b, () => {
  const route = IA.routeById(W.CONSENT_ROUTE_ID);
  assert.ok(route, '라우트가 없으면 decideAccess 가 항상 거부한다');
  assert.equal(route.pii, true);
  assert.equal(route.mutates, true);
  assert.deepEqual(route.roles, ['tenant_owner', 'admin']);
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('동의한 목적을 철회하면 기록이 저장되고 감사에 남는다', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store);
  assert.equal(r.status, 'ok');
  assert.equal(r.committed, true);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].state, 'withdrawn');
  assert.equal(r.records[0].policyVersion, 3);
  assert.equal(r.records[0].via, 'portal');
  // 저장소에 실제로 들어갔다 — (바) 가 닫혔다는 확인.
  assert.equal(store.list(SUBJ).length, 2);
  assert.equal(C.currentState(policy(), store.list(SUBJ), 'personal_data_collection', SUBJ, AT), 'withdrawn');
  assert.equal(r.record.action, 'policy_change');
  assert.equal(r.record.route_id, 'settings.consent');
  assert.equal(r.record.result, 'success');
});

test('삭제하지 않는다 — 기존 동의 기록은 남는다(§10.1 입증 책임)', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  run(store);
  const kept = store.list(SUBJ).filter((x) => x.state === 'granted');
  assert.equal(kept.length, 1);
  assert.ok(!SRC.includes('splice') && !SRC.includes('filter((r) => r.state !=='));
});

// ── (나) 받은 적 없는 동의를 철회했다고 적지 않는다 ─────────────────────────

test('동의를 받은 적 없으면 기록을 만들지 않고 사유를 적는다 — 실패가 아니다', b, () => {
  const store = EC.createMemoryConsentStore([]);
  const r = run(store);
  assert.equal(r.status, 'nothing_to_withdraw');
  assert.equal(r.records.length, 0);
  assert.equal(store.list(SUBJ).length, 0);
  assert.equal(r.results[0].outcome, 'not_granted');
  assert.equal(r.results[0].stateBefore, 'not_asked');
  // 처리 사실은 감사에 남는다(열람·처리 모두 §10.2).
  assert.equal(r.recorded, true);
});

test('거부 상태도 거둘 것이 없다 — "받은 적 없음"과 "거뒀음"을 섞지 않는다', b, () => {
  const denied = C.deny(policy(), { subjectRef: SUBJ, purpose: 'marketing', via: 'voice', at: AT });
  const store = EC.createMemoryConsentStore([denied]);
  const r = run(store, { purposes: ['marketing'] });
  assert.equal(r.status, 'nothing_to_withdraw');
  assert.equal(r.results[0].outcome, 'not_granted');
  assert.equal(r.results[0].stateBefore, 'denied');
});

test('만료된 동의는 expired 로 갈라 적는다 — 이미 효력이 없다', b, () => {
  const store = EC.createMemoryConsentStore([granted('recording', '2026-01-01T00:00:00.000Z')]);
  const r = run(store, { purposes: ['recording'] });
  assert.equal(r.status, 'nothing_to_withdraw');
  assert.equal(r.results[0].outcome, 'expired');
});

// ── (다) 멱등 ────────────────────────────────────────────────────────────────

test('이미 철회된 동의를 또 철회하지 않는다 — 최초 철회 시각을 보존한다', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const first = run(store);
  assert.equal(first.status, 'ok');
  const firstAt = store.list(SUBJ).find((x) => x.state === 'withdrawn').at;
  const again = W.executeWithdrawal(chain0(), req({ at: '2026-09-21T00:00:00.000Z', recordId: 'r2' }), store, policy(), hash);
  assert.equal(again.status, 'nothing_to_withdraw');
  assert.equal(again.results[0].outcome, 'already_withdrawn');
  assert.equal(store.list(SUBJ).filter((x) => x.state === 'withdrawn').length, 1);
  assert.equal(store.list(SUBJ).find((x) => x.state === 'withdrawn').at, firstAt);
});

// ── (라) 목적별 결과를 하나로 접지 않는다 ───────────────────────────────────

test('일부만 거둘 수 있으면 목적별로 적고 전부 철회로 접지 않는다', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store, { purposes: ['personal_data_collection', 'marketing', 'overseas_transfer'] });
  assert.equal(r.status, 'ok');
  assert.equal(r.records.length, 1);
  assert.deepEqual(
    r.results.map((x) => [x.purpose, x.outcome]),
    [
      ['personal_data_collection', 'withdrawn'],
      ['marketing', 'not_granted'],
      ['overseas_transfer', 'undeclared'],
    ],
  );
  assert.ok(r.warnings.some((w) => w.includes('선언되지 않은 목적')));
});

test('빈 목적 목록을 전부 철회로 읽지 않는다(§13-3)', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection'), granted('marketing')]);
  const r = run(store, { purposes: [] });
  assert.equal(r.status, 'refused');
  assert.equal(store.list(SUBJ).length, 2);
  assert.ok(r.issues.some((i) => i.includes('전부 철회로 읽지 않는다')));
});

test('중복 목적 선언은 거절한다 — 같은 목적에 철회 기록이 둘 생긴다', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store, { purposes: ['personal_data_collection', 'personal_data_collection'] });
  assert.equal(r.status, 'refused');
  assert.equal(store.list(SUBJ).length, 1);
});

// ── (마) 철회 후 게이트가 실제로 막힌다 ─────────────────────────────────────

test('필수 목적 철회 후 gateAction 이 그 행위를 막는다(실제로 다시 부른다)', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const before = C.gateAction(policy(), store.list(SUBJ), 'call_backend_with_pii', SUBJ, AT, SCOPE);
  assert.equal(before.allow, true);
  const r = run(store, { recheckActions: ['call_backend_with_pii'] });
  assert.equal(r.status, 'ok');
  assert.equal(r.recheck.length, 1);
  assert.equal(r.recheck[0].action, 'call_backend_with_pii');
  assert.equal(r.recheck[0].decision.allow, false);
  assert.equal(r.recheck[0].decision.reason, 'consent_missing');
});

test('선택 목적 철회는 필수 게이트를 막지 않는다', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection'), granted('marketing')]);
  const r = run(store, { purposes: ['marketing'], recheckActions: ['call_backend_with_pii', 'marketing_followup'] });
  assert.equal(r.status, 'ok');
  assert.equal(r.recheck[0].decision.allow, true);
  assert.equal(r.recheck[1].decision.allow, false);
});

test('재판정을 선언하지 않으면 하지 않는다(§13-3)', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store);
  assert.equal(r.recheck, undefined);
  const empty = run(EC.createMemoryConsentStore([granted('personal_data_collection')]), { recheckActions: [] });
  assert.equal(empty.recheck, undefined);
});

test('통화를 끊으라고 적지 않는다 — 결과에 종료 지시가 없다', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store, { recheckActions: ['call_backend_with_pii'] });
  const text = JSON.stringify(r);
  assert.ok(!text.includes('terminate') && !text.includes('통화를 종료'));
});

// ── (바) 저장 ────────────────────────────────────────────────────────────────

test('저장이 실패하면 성공으로도 미실행으로도 적지 않는다', b, () => {
  const store = {
    list: () => [granted('personal_data_collection')],
    append: () => { throw new Error('운영 DB 접속 실패: postgres://u:pw@db/aicc'); },
  };
  const r = run(store);
  assert.equal(r.status, 'uncommitted');
  assert.equal(r.committed, false);
  assert.equal(r.records.length, 0);
  assert.equal(r.record.result, 'error');
  assert.ok(r.messageKo.includes('철회는 일어나지 않았다'));
});

test('부분 저장이면 저장된 건수를 감사에 적는다', b, () => {
  let n = 0;
  const store = {
    list: () => [granted('personal_data_collection'), granted('marketing')],
    append: () => { n += 1; if (n === 2) throw new Error('중간 실패'); },
  };
  const r = run(store, { purposes: ['personal_data_collection', 'marketing'] });
  assert.equal(r.status, 'uncommitted');
  assert.ok(String(r.record.detail_masked).includes('1/2'));
});

test('이력 조회가 실패하거나 규약을 어기면 "거둘 것 없음"으로 읽지 않는다', b, () => {
  const broken = { list: () => { throw new Error('타임아웃'); }, append: () => {} };
  assert.equal(run(broken).status, 'refused');
  const weird = { list: () => null, append: () => {} };
  const r = run(weird);
  assert.equal(r.status, 'refused');
  assert.ok(r.issues.some((i) => i.includes('배열')));
});

// ── 권한·격리 ────────────────────────────────────────────────────────────────

test('권한 없는 역할은 거부되고 어떤 동의가 있는지 돌려주지 않는다', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store, { actor: AGENT });
  assert.equal(r.status, 'denied');
  assert.deepEqual(r.results, []);
  assert.deepEqual(r.issues, []);
  assert.equal(store.list(SUBJ).length, 1);
  assert.equal(r.record.result, 'denied');
});

test('다른 테넌트·워크스페이스 정책으로는 철회할 수 없다 — 던진다(§11.1)', b, () => {
  const store = EC.createMemoryConsentStore([]);
  assert.throws(() => W.executeWithdrawal(chain0(), req(), store, policy({ tenantId: 'rival' }), hash));
  assert.throws(() => W.executeWithdrawal(chain0(), req(), store, policy({ workspaceId: 'w2' }), hash));
  assert.throws(() => W.executeWithdrawal(chain0(), req({ scope: { tenantId: '' } }), store, policy(), hash));
});

// ── §10.3 / §13-3 ───────────────────────────────────────────────────────────

test('주체 참조에 개인정보 원문이 오면 거부하고 원문을 결과에 담지 않는다(§10.3)', b, () => {
  const store = EC.createMemoryConsentStore([]);
  const r = run(store, { subjectRef: '010-1234-5678' });
  assert.equal(r.status, 'refused');
  assert.ok(!JSON.stringify(r).includes('010-1234-5678'));
  assert.equal(r.recorded, false);
});

test('증빙 참조는 저장 경로에서 한 번 마스킹된다(§10.3)', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store, { evidenceRef: '접수 010-1234-5678' });
  assert.equal(r.status, 'ok');
  assert.ok(!r.records[0].evidenceRef.includes('010-1234-5678'));
});

test('접수 경로·시각·레코드 id 를 만들어 넣지 않는다(§13-3)', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  for (const over of [{ via: '' }, { at: '' }, { recordId: '' }]) {
    const r = run(store, over);
    assert.equal(r.status, 'refused', JSON.stringify(over));
    assert.equal(r.recorded, false);
  }
  assert.equal(store.list(SUBJ).length, 1);
});

test('미승인 정책에서는 기록을 만들지 않고 설정 결함으로 적는다(§10.1)', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store, {}, policy({ approved: false }));
  assert.equal(r.status, 'refused');
  assert.ok(r.issues.some((i) => i.includes('미승인')));
  assert.equal(store.list(SUBJ).length, 1);
});

test('정책 자체가 깨져 있으면 철회를 처리하지 않는다', b, () => {
  const store = EC.createMemoryConsentStore([granted('personal_data_collection')]);
  const r = run(store, {}, policy({ requirements: [] }));
  assert.equal(r.status, 'refused');
});

// ── 경계 ─────────────────────────────────────────────────────────────────────

test('판정을 복사하지 않는다 — 만료일·목적 매핑·필수 판정이 이 파일에 없다(§2)', b, () => {
  const code = SRC.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
  assert.ok(!code.includes('validForDays'));
  assert.ok(!code.includes('ACTION_PURPOSES'));
  assert.ok(!code.includes('86_400_000'));
  assert.ok(!code.includes('.required'));
  assert.ok(code.includes('currentState(') && code.includes('gateAction(') && code.includes('withdraw('));
});

test('개인정보 파기 경로를 겸하지 않는다(§8.2 와 분리)', b, () => {
  assert.ok(!SRC.includes('retentionInventory'));
  assert.ok(!SRC.includes('DisposalPort'));
});

test('계약 버전과 라우트 id 가 노출된다', b, () => {
  assert.equal(typeof W.WITHDRAWAL_CONTRACT_VERSION, 'number');
  assert.equal(W.CONSENT_ROUTE_ID, 'settings.consent');
});
