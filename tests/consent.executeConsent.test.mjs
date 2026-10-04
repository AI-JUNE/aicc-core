// 동의 수집·반영 실행기(§10.1) — `src/consent/executeConsent.ts`.
//
// 이 모듈이 막는 사고는 대부분 예외가 아니라 **동의 이력의 거짓**이다. 침묵을 동의로 적는 것,
// 같은 동의를 턴마다 다시 쌓는 것, 주체 없는 기록을 남기는 것은 전부 통화·이벤트에서 정상으로
// 보이고 점검·분쟁에서 처음 드러난다. 그래서 검사도 "던지는가"가 아니라 "무엇이 기록되는가"를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let C = null, X = null, RU = null, T = null;
try {
  C = await import('../src/consent/consent.ts');
  X = await import('../src/consent/executeConsent.ts');
  RU = await import('../src/flow/runner.ts');
  T = await import('../src/flow/types.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: X ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const NOW = '2026-10-04T09:00:00.000Z';
const SUBJECT = 'sha256:7f3a9c';

function policyOf(over = {}) {
  return {
    tenantId: 'goone',
    requirements: [
      { purpose: 'personal_data_collection', required: true, noticeRef: 'n1' },
      { purpose: 'recording', required: true, noticeRef: 'n2' },
      { purpose: 'marketing', required: false, noticeRef: 'n3' },
    ],
    version: 3,
    updatedAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'legal@goone',
    approved: true,
    ...over,
  };
}

const confirmNode = (id, over = {}) => ({ id, kind: 'Confirm', prompt: '동의하십니까?', ...over });

function planInput(over = {}) {
  const node = over.pendingNode ?? confirmNode('__consent:recording', { next: 'bye' });
  const key = T.confirmSlotKey(node.id);
  return {
    policy: policyOf(),
    scope: SCOPE,
    pendingNode: node,
    slotsAfter: { [key]: 'yes' },
    nodeAfter: 'bye',
    failCountAfter: 0,
    subjectRef: SUBJECT,
    at: NOW,
    via: 'voice',
    interactionId: 'i_1',
    ...over,
  };
}

// ── 노드 판정 ────────────────────────────────────────────────────────────────

test('예약 id 로만 동의 노드를 가린다 — 판정은 한 곳이다', b, () => {
  assert.equal(X.CONSENT_NODE_PREFIX, '__consent:');
  assert.equal(X.consentPurposeOf('__consent:recording'), 'recording');
  assert.equal(X.consentPurposeOf('__consent:overseas_transfer'), 'overseas_transfer');
  // 알 수 없는 목적은 **고르지 않는다**(§13-3) — 임의로 가장 비슷한 목적을 대입하면
  // 전혀 다른 목적의 동의가 이력에 쌓인다.
  assert.equal(X.consentPurposeOf('__consent:녹취'), undefined);
  assert.equal(X.consentPurposeOf('ask_recording'), undefined);
  assert.equal(X.isConsentNode(confirmNode('__consent:recording')), true);
  assert.equal(X.isConsentNode({ id: '__consent:recording', kind: 'Collect', slot: 'x', prompt: 'p' }), false);
  assert.equal(X.isConsentNode(undefined), false);
});

test('시나리오의 동의 노드를 목적과 함께 걷는다', b, () => {
  const flow = {
    id: 'f', version: 1, startNodeId: 'a',
    nodes: {
      a: confirmNode('__consent:recording', { next: 'b' }),
      b: confirmNode('__consent:marketing', { next: 'c' }),
      c: { id: 'c', kind: 'Say', text: '감사합니다.' },
    },
  };
  assert.deepEqual(X.consentNodes(flow).map((n) => n.purpose), ['recording', 'marketing']);
  assert.deepEqual(X.consentNodeDefects(flow), []);
});

test('동의 노드 결함은 세 종류로 갈라서 드러낸다 — 시작 전에 걸러야 하는 것들', b, () => {
  const flow = {
    id: 'f', version: 1, startNodeId: 'a',
    nodes: {
      // Confirm 이 아니면 확정된 yes/no 가 없다 — 기록할 값 자체가 없다.
      a: { id: '__consent:recording', kind: 'Collect', slot: 's', prompt: 'p', next: 'b' },
      // 뒤에 적힌 목적이 ConsentPurpose 가 아니다 — 무엇에 대한 동의인지 모른다.
      b: confirmNode('__consent:아무거나', { next: 'c' }),
      // 분기가 자기 자신이면 "확정"과 "되묻는 중"을 관측만으로 가를 수 없다.
      c: confirmNode('__consent:marketing', { onYes: '__consent:marketing', next: 'd' }),
      d: { id: 'd', kind: 'Say', text: '끝' },
    },
  };
  assert.deepEqual(X.consentNodeDefects(flow), [
    { nodeId: '__consent:recording', defect: 'not_confirm' },
    { nodeId: '__consent:아무거나', defect: 'unknown_purpose' },
    { nodeId: '__consent:marketing', defect: 'self_branch' },
  ]);
});

// ── 기록 생성 ────────────────────────────────────────────────────────────────

test('정상: 확정된 "네"가 추가 전용 기록 한 건이 된다', b, () => {
  const plan = X.planConsentTurn(planInput({ evidenceRef: 'rec:seg-12' }));
  assert.equal(plan.action, 'record');
  assert.equal(plan.purpose, 'recording');
  assert.equal(plan.state, 'granted');
  assert.deepEqual(plan.record, {
    tenantId: 'goone', subjectRef: SUBJECT, purpose: 'recording', state: 'granted',
    at: NOW, via: 'voice', interactionId: 'i_1', policyVersion: 3, evidenceRef: 'rec:seg-12',
  });
});

test('"아니요"는 거부로 적고 철회(withdrawn)를 만들어 내지 않는다', b, () => {
  const node = confirmNode('__consent:marketing', { next: 'bye' });
  const plan = X.planConsentTurn(planInput({
    pendingNode: node, slotsAfter: { [T.confirmSlotKey(node.id)]: 'no' },
  }));
  assert.equal(plan.action, 'record');
  assert.equal(plan.state, 'denied');
  assert.equal(plan.record.state, 'denied');
});

test('실패 경로: 되묻는 중이면 기록하지 않는다 — 침묵은 동의가 아니다', b, () => {
  const node = confirmNode('__consent:recording', { next: 'bye' });
  const key = T.confirmSlotKey(node.id);
  // 무입력·불일치로 §5.1 사다리를 한 칸 내려갔다. 같은 노드에서 다시 기다린다.
  // 슬롯에는 **이전 방문에서 받은 값이 남아 있다**(만료 후 다시 묻는 경로) — 그 값을 이번 턴의
  // 확정으로 읽으면 침묵이 동의가 된다.
  const re = X.planConsentTurn(planInput({
    pendingNode: node, slotsAfter: { [key]: 'yes' }, nodeAfter: node.id, failCountAfter: 1,
  }));
  assert.equal(re.action, 'none');
  assert.equal(re.code, 'unanswered');
  assert.equal(re.purpose, 'recording');
  const silent = X.planConsentTurn(planInput({
    pendingNode: node, slotsAfter: { [key]: 'yes' }, nodeAfter: node.id, failCountAfter: 0,
  }));
  assert.equal(silent.code, 'unanswered');
  // 노드를 벗어났어도 실패 카운트가 남아 있으면 확정이 아니다.
  const half = X.planConsentTurn(planInput({ pendingNode: node, failCountAfter: 2 }));
  assert.equal(half.code, 'unanswered');
  // 슬롯에 yes/no 가 아닌 값이 들어와도 **어느 쪽으로도 읽지 않는다**.
  for (const v of ['y', '네', 'YES', '', 'true']) {
    const odd = X.planConsentTurn(planInput({ pendingNode: node, slotsAfter: { [key]: v } }));
    assert.equal(odd.code, 'unanswered', `'${v}' 를 확정으로 읽었다`);
  }
});

test('동의 턴이 아니면 조용히 넘어간다(정상 경로)', b, () => {
  const plain = { id: 'ask', kind: 'Confirm', prompt: '맞습니까?', next: 'bye' };
  assert.equal(X.planConsentTurn(planInput({ pendingNode: plain })).code, 'not_consent_turn');
  assert.equal(X.planConsentTurn(planInput({ pendingNode: undefined })).code, 'not_consent_turn');
});

test('실패 경로: 주체 참조가 없으면 기록하지 않고 사실을 드러낸다', b, () => {
  for (const ref of [undefined, '', '   ']) {
    const plan = X.planConsentTurn(planInput({ subjectRef: ref }));
    assert.equal(plan.action, 'none');
    assert.equal(plan.code, 'no_subject');
    assert.match(plan.reasonKo, /주체 참조가 없어/);
  }
});

test('실패 경로: 미승인 정책·정책에 없는 목적으로 받은 동의는 근거가 아니다', b, () => {
  const notApproved = X.planConsentTurn(planInput({ policy: policyOf({ approved: false }) }));
  assert.equal(notApproved.code, 'policy_not_approved');
  assert.match(notApproved.reasonKo, /\[승인 필요\]/);

  const undeclared = X.planConsentTurn(planInput({
    policy: policyOf({ requirements: [{ purpose: 'marketing', required: false }] }),
  }));
  assert.equal(undeclared.code, 'purpose_undeclared');
  assert.equal(undeclared.purpose, 'recording');
});

test('실패 경로: 주체 참조에 개인정보 원문이 오면 거부하되 던지지 않는다(§10.3)', b, () => {
  const plan = X.planConsentTurn(planInput({ subjectRef: '010-1234-5678' }));
  assert.equal(plan.action, 'none');
  assert.equal(plan.code, 'rejected');
  // 사유 문구에 그 값이 되돌아오지 않는다 — 사유가 곧 유출 경로가 되지 않게.
  assert.equal(plan.reasonKo.includes('010-1234-5678'), false);
  assert.equal(plan.reasonKo.includes('1234'), false);
});

test('격리 위반만 던진다(§11.1) — 남의 테넌트 이력에 쌓이는 동의는 동의가 아니다', b, () => {
  assert.throws(
    () => X.planConsentTurn(planInput({ policy: policyOf({ tenantId: 'other' }) })),
    /테넌트 격리 위반\(동의 기록\)/,
  );
  assert.throws(
    () => X.planConsentTurn(planInput({
      policy: policyOf({ workspaceId: 'ws_b' }), scope: { tenantId: 'goone', workspaceId: 'ws_a' },
    })),
    /워크스페이스 격리 위반/,
  );
});

// ── 경계: Runner 가 실제로 푼 값으로 기록된다 ────────────────────────────────

test('경계: Runner 가 확정한 Confirm 값이 그대로 기록된다 — 슬롯 키 규칙이 한 곳이다', b, () => {
  const flow = {
    id: 'consent', version: 1, startNodeId: '__consent:recording',
    nodes: {
      '__consent:recording': confirmNode('__consent:recording', { next: 'bye' }),
      bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
    },
  };
  const ctx = { tenantId: 'goone', interactionId: 'i_1', channel: 'voice', now: () => NOW };
  const started = RU.start(flow, ctx);
  assert.equal(started.state.currentNodeId, '__consent:recording');

  const answered = RU.send(flow, started.state, { kind: 'utterance', text: '네' }, ctx);
  const plan = X.planConsentTurn({
    policy: policyOf(), scope: SCOPE,
    pendingNode: flow.nodes['__consent:recording'],
    slotsAfter: answered.state.slots,
    nodeAfter: answered.state.currentNodeId,
    failCountAfter: answered.state.failCount,
    subjectRef: SUBJECT, at: NOW, via: 'voice', interactionId: 'i_1',
  });
  assert.equal(plan.action, 'record');
  assert.equal(plan.state, 'granted');

  // 알아듣지 못한 입력은 같은 노드에서 되묻고, 그 턴은 기록을 만들지 않는다.
  const unclear = RU.send(flow, started.state, { kind: 'utterance', text: '음...' }, ctx);
  assert.equal(unclear.state.currentNodeId, '__consent:recording');
  const none = X.planConsentTurn({
    policy: policyOf(), scope: SCOPE,
    pendingNode: flow.nodes['__consent:recording'],
    slotsAfter: unclear.state.slots,
    nodeAfter: unclear.state.currentNodeId,
    failCountAfter: unclear.state.failCount,
    subjectRef: SUBJECT, at: NOW, via: 'voice', interactionId: 'i_1',
  });
  assert.equal(none.code, 'unanswered');
});

test('경계: 기록된 동의가 §6.1 게이트를 **실제로** 통과시킨다', b, () => {
  const policy = policyOf();
  const store = X.createMemoryConsentStore();
  const node = confirmNode('__consent:personal_data_collection', { next: 'bye' });
  const key = T.confirmSlotKey(node.id);

  // 기록 전: 개인정보를 싣는 조회는 막힌다.
  const before = C.gateAction(policy, store.list(SUBJECT), 'call_backend_with_pii', SUBJECT, NOW, SCOPE);
  assert.equal(before.allow, false);
  assert.equal(before.reason, 'consent_missing');

  const granted = X.planConsentTurn(planInput({
    policy, pendingNode: node, slotsAfter: { [key]: 'yes' },
  }));
  store.append(granted.record);
  const after = C.gateAction(policy, store.list(SUBJECT), 'call_backend_with_pii', SUBJECT, NOW, SCOPE);
  assert.equal(after.allow, true);

  // 같은 목적을 다시 물어 거부하면 최신 기록이 이겨 다시 막힌다(추가 전용, §10.1).
  const denied = X.planConsentTurn(planInput({
    policy, pendingNode: node, slotsAfter: { [key]: 'no' }, at: '2026-10-04T09:05:00.000Z',
  }));
  store.append(denied.record);
  const again = C.gateAction(policy, store.list(SUBJECT), 'call_backend_with_pii', SUBJECT, NOW, SCOPE);
  assert.equal(again.allow, false);
});

// ── 필수 미획득 목록 ─────────────────────────────────────────────────────────

test('필수 미획득 목적: 판정은 evaluateConsents 하나를 쓴다', b, () => {
  const policy = policyOf();
  const rec = (purpose, state, at = NOW) => ({
    tenantId: 'goone', subjectRef: SUBJECT, purpose, state, at, via: 'voice', policyVersion: 3,
  });
  assert.deepEqual(
    X.pendingRequiredConsents(policy, [], SUBJECT, NOW),
    ['personal_data_collection', 'recording'],
  );
  assert.deepEqual(
    X.pendingRequiredConsents(policy, [rec('personal_data_collection', 'granted'), rec('recording', 'granted')], SUBJECT, NOW),
    [],
  );
  // 선택 목적(마케팅) 거부는 미획득으로 세지 않는다 — 세면 선택 동의 거절이 곧 차단이 된다.
  assert.deepEqual(
    X.pendingRequiredConsents(
      policy,
      [rec('personal_data_collection', 'granted'), rec('recording', 'granted'), rec('marketing', 'denied')],
      SUBJECT, NOW,
    ),
    [],
  );
});

test('실패 경로: 주체를 모르면 "다 받았다"로 적지 않는다', b, () => {
  // 조회조차 못 한 상태를 빈 목록으로 적는 것이 §10.1 에서 가장 조용한 오답이다.
  assert.deepEqual(
    X.pendingRequiredConsents(policyOf(), [], undefined, NOW),
    ['personal_data_collection', 'recording'],
  );
  assert.deepEqual(X.pendingRequiredConsents(policyOf({ requirements: [] }), [], undefined, NOW), []);
});

test('만료된 동의는 미획득으로 적힌다(§10.1)', b, () => {
  const policy = policyOf({
    requirements: [{ purpose: 'recording', required: true, validForDays: 1 }],
  });
  const old = {
    tenantId: 'goone', subjectRef: SUBJECT, purpose: 'recording', state: 'granted',
    at: '2026-10-01T09:00:00.000Z', via: 'voice', policyVersion: 3,
  };
  assert.deepEqual(X.pendingRequiredConsents(policy, [old], SUBJECT, NOW), ['recording']);
});

// ── 게이트 컨텍스트 ──────────────────────────────────────────────────────────

test('게이트 컨텍스트: 주체를 모르면 **만들지 않는다**', b, () => {
  const store = X.createMemoryConsentStore();
  assert.equal(X.buildConsentLookup(policyOf(), store, undefined, NOW), undefined);
  assert.equal(X.buildConsentLookup(policyOf(), store, '  ', NOW), undefined);
  const ok = X.buildConsentLookup(policyOf(), store, SUBJECT, NOW);
  assert.deepEqual(ok, { policy: policyOf(), records: [], subjectRef: SUBJECT, now: NOW });
});

test('실패 경로: 이력 조회가 던지거나 규약을 어기면 컨텍스트를 만들지 않는다(던지지 않는다)', b, () => {
  const boom = { list() { throw new Error('DB down'); }, append() {} };
  assert.equal(X.buildConsentLookup(policyOf(), boom, SUBJECT, NOW), undefined);
  const weird = { list: () => 'nope', append() {} };
  assert.equal(X.buildConsentLookup(policyOf(), weird, SUBJECT, NOW), undefined);
});

test('인메모리 이력은 주체별로 가르고 순서를 보존한다', b, () => {
  const store = X.createMemoryConsentStore();
  const mk = (subjectRef, at) => ({
    tenantId: 'goone', subjectRef, purpose: 'recording', state: 'granted', at, via: 'voice', policyVersion: 3,
  });
  store.append(mk(SUBJECT, '2026-10-04T09:00:00.000Z'));
  store.append(mk('sha256:other', '2026-10-04T09:01:00.000Z'));
  store.append(mk(SUBJECT, '2026-10-04T09:02:00.000Z'));
  assert.deepEqual(store.list(SUBJECT).map((r) => r.at), [
    '2026-10-04T09:00:00.000Z', '2026-10-04T09:02:00.000Z',
  ]);
  assert.equal(store.list('sha256:none').length, 0);
});

// ── 배선 검증 ────────────────────────────────────────────────────────────────

test('배선 검증: 미승인·다른 테넌트 정책은 오류, 마케팅 필수는 경고', b, () => {
  const ok = X.validateConsentBinding(policyOf(), SCOPE);
  assert.deepEqual(ok.errorsKo, []);
  assert.deepEqual(ok.warningsKo, []);

  const other = X.validateConsentBinding(policyOf({ tenantId: 'rival' }), SCOPE);
  assert.equal(other.errorsKo.length >= 1, true);
  assert.match(other.errorsKo[0], /다른 테넌트의 동의 정책/);

  const draft = X.validateConsentBinding(policyOf({ approved: false }), SCOPE);
  assert.equal(draft.errorsKo.some((e) => /미승인/.test(e)), true);

  const forced = X.validateConsentBinding(
    policyOf({ requirements: [{ purpose: 'marketing', required: true }] }), SCOPE,
  );
  assert.deepEqual(forced.errorsKo, []);
  assert.equal(forced.warningsKo.some((w) => /마케팅 동의가 필수/.test(w)), true);

  const ws = X.validateConsentBinding(policyOf({ workspaceId: 'ws_b' }), { tenantId: 'goone', workspaceId: 'ws_a' });
  assert.equal(ws.errorsKo.some((e) => /다른 워크스페이스/.test(e)), true);
});

test('이 파일에는 임계값도 목적 매핑도 없다(§2·§13-3)', b, async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/consent/executeConsent.ts', import.meta.url), 'utf8');
  // 판정을 복사하면 화면과 게이트가 서로 다른 답을 낸다 — 상태·만료·차단은 consent.ts 하나다.
  for (const forbidden of ['validForDays', 'ACTION_PURPOSES[', 'currentState(']) {
    assert.equal(src.includes(forbidden), false, `판정이 복사됐다: ${forbidden}`);
  }
});
