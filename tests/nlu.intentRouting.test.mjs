// 인텐트 → 시나리오 라우팅. 이 모듈이 막는 사고는 전부 "조용히 다른 데로 간다" 류다 —
// 예외가 아니라서 검사로 고정하지 않으면 드러나지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let R = null, N = null;
try {
  R = await import('../src/nlu/intentRouting.ts');
  N = await import('../src/nlu/intent.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't1' };

const flow = (id, version = 1) => ({
  id, version, startNodeId: 'n1',
  nodes: { n1: { id: 'n1', kind: 'Say', text: '안내', next: 'n2' }, n2: { id: 'n2', kind: 'Say', text: '끝' } },
});

const lookup = (flows) => ({
  get(id, version) {
    const list = flows.filter((f) => f.id === id);
    if (!list.length) return undefined;
    if (version !== undefined) return list.find((f) => f.version === version);
    return list.reduce((a, c) => (c.version > a.version ? c : a));
  },
});

const catalog = (intents) => ({ tenantId: 't1', intents });
const base = [
  { id: 'balance', titleKo: '잔액조회' },
  { id: 'reissue', titleKo: '카드재발급' },
];

const table = (routes, over = {}) => ({ tenantId: 't1', routes, ...over });

const decision = (over = {}) => ({
  kind: 'accepted', intent: 'balance', confidence: 0.9, options: [],
  handoffOnly: false, reasonKo: '단독 확정', ignoredCandidates: [], attempt: 0, ...over,
});

// ── 정적 계약 ────────────────────────────────────────────────────────────────

test('라우팅은 판정 규칙을 다시 쓰지 않고 nextStep 을 그대로 쓴다(§2 이중 관리 금지)', () => {
  const src = read('src/nlu/intentRouting.ts');
  assert.match(src, /import \{ nextStep \}/);
  // 임계값·사다리 판정이 이 파일에 복사되면 인텐트 규칙이 두 군데가 된다.
  assert.doesNotMatch(src, /acceptThreshold|rejectThreshold|ambiguityMargin/);
});

test('기본 시나리오를 만들지 않는다(§13-3)', () => {
  const src = read('src/nlu/intentRouting.ts');
  assert.doesNotMatch(src, /defaultFlow|fallbackFlowId|'main'/);
});

// ── 검증: 통화 중에 드러날 결함을 등록 시점으로 끌어온다 ──────────────────────

test('정상 라우팅 표는 오류 없이 통과한다', b, () => {
  const issues = R.validateIntentRouting(
    table([{ intent: 'balance', flowId: 'f_bal' }, { intent: 'reissue', flowId: 'f_re' }]),
    catalog(base), lookup([flow('f_bal'), flow('f_re')]),
  );
  assert.equal(R.intentRoutingOk(issues), true);
  assert.deepEqual(issues.filter((i) => i.severity === 'error'), []);
});

test('상담사 전용 인텐트에 시나리오를 붙이면 오류다 — 사람에게 갈 건이 봇 흐름을 탄다(§2)', b, () => {
  const issues = R.validateIntentRouting(
    table([{ intent: 'complaint', flowId: 'f_bal' }]),
    catalog([...base, { id: 'complaint', titleKo: '불만접수', handoffOnly: true }]),
    lookup([flow('f_bal')]),
  );
  assert.equal(R.intentRoutingOk(issues), false);
  assert.ok(issues.some((i) => i.code === 'E_HANDOFF_ONLY_ROUTED' && i.intent === 'complaint'));
});

test('없는 시나리오·없는 진입 노드는 등록 시점에 걸린다 — 통화 중 세션 실패로 나타나면 안 된다', b, () => {
  const a = R.validateIntentRouting(
    table([{ intent: 'balance', flowId: 'f_오타' }]), catalog(base), lookup([flow('f_bal')]),
  );
  assert.ok(a.some((i) => i.code === 'E_FLOW_UNKNOWN'));

  const c = R.validateIntentRouting(
    table([{ intent: 'balance', flowId: 'f_bal', entryNodeId: 'nX' }]), catalog(base), lookup([flow('f_bal')]),
  );
  assert.ok(c.some((i) => i.code === 'E_ENTRY_NODE_UNKNOWN'));
});

test('같은 인텐트에 라우트가 둘이면 자동으로 고르지 않고 오류로 드러낸다', b, () => {
  const issues = R.validateIntentRouting(
    table([{ intent: 'balance', flowId: 'f_bal' }, { intent: 'balance', flowId: 'f_re' }]),
    catalog(base), lookup([flow('f_bal'), flow('f_re')]),
  );
  assert.ok(issues.some((i) => i.code === 'E_ROUTE_DUPLICATE'));
});

test('카탈로그에 없는 인텐트·비활성 인텐트 라우트를 잡는다', b, () => {
  const a = R.validateIntentRouting(table([{ intent: 'nope', flowId: 'f_bal' }]), catalog(base), lookup([flow('f_bal')]));
  assert.ok(a.some((i) => i.code === 'E_INTENT_UNKNOWN'));

  const c = R.validateIntentRouting(
    table([{ intent: 'old', flowId: 'f_bal' }]),
    catalog([...base, { id: 'old', titleKo: '구버전', disabled: true }]), lookup([flow('f_bal')]),
  );
  assert.ok(c.some((i) => i.code === 'E_INTENT_DISABLED'));
});

test('라우트 없는 활성 인텐트는 경고로 드러난다 — 누락이 "못 알아듣는다"로만 보이면 안 된다', b, () => {
  const issues = R.validateIntentRouting(
    table([{ intent: 'balance', flowId: 'f_bal' }]), catalog(base), lookup([flow('f_bal')]),
  );
  assert.equal(R.intentRoutingOk(issues), true, '경고는 등록을 막지 않는다');
  assert.ok(issues.some((i) => i.code === 'W_INTENT_UNROUTED' && i.intent === 'reissue'));
  assert.deepEqual(R.unroutedIntents(table([{ intent: 'balance', flowId: 'f_bal' }]), catalog(base)), ['reissue']);
});

test('handoffOnly·비활성 인텐트는 미라우팅 경고 대상이 아니다', b, () => {
  const cat = catalog([
    { id: 'balance', titleKo: '잔액조회' },
    { id: 'complaint', titleKo: '불만', handoffOnly: true },
    { id: 'old', titleKo: '구버전', disabled: true },
  ]);
  const issues = R.validateIntentRouting(table([{ intent: 'balance', flowId: 'f_bal' }]), cat, lookup([flow('f_bal')]));
  assert.deepEqual(issues.filter((i) => i.code === 'W_INTENT_UNROUTED'), []);
  assert.deepEqual(R.unroutedIntents(table([{ intent: 'balance', flowId: 'f_bal' }]), cat), []);
});

test('다른 테넌트 카탈로그로는 검증하지 않는다(§11.1)', b, () => {
  const issues = R.validateIntentRouting(table([]), { tenantId: 't2', intents: base }, lookup([]));
  assert.ok(issues.some((i) => i.code === 'E_TENANT_INVALID'));
});

// ── 라우팅 동작 ──────────────────────────────────────────────────────────────

test('확정된 인텐트는 시나리오 실물과 진입 노드까지 풀려서 나온다', b, () => {
  const f = flow('f_bal', 3);
  const a = R.routeIntent({
    scope, decision: decision(), table: table([{ intent: 'balance', flowId: 'f_bal' }]), flows: lookup([flow('f_bal', 1), f]),
  });
  assert.equal(a.kind, 'start_flow');
  assert.equal(a.flow.version, 3, '버전 미지정은 최신을 준다(§5.3)');
  assert.equal(a.entryNodeId, 'n1');
  assert.equal(a.confidence, 0.9);
});

test('flowVersion 을 지정하면 그 버전으로 고정된다', b, () => {
  const a = R.routeIntent({
    scope, decision: decision(),
    table: table([{ intent: 'balance', flowId: 'f_bal', flowVersion: 1 }]),
    flows: lookup([flow('f_bal', 1), flow('f_bal', 7)]),
  });
  assert.equal(a.kind, 'start_flow');
  assert.equal(a.flow.version, 1);
});

test('진입 노드를 지정하면 거기서 시작한다', b, () => {
  const a = R.routeIntent({
    scope, decision: decision(),
    table: table([{ intent: 'balance', flowId: 'f_bal', entryNodeId: 'n2' }]), flows: lookup([flow('f_bal')]),
  });
  assert.equal(a.entryNodeId, 'n2');
});

test('라우트가 없으면 대표 시나리오로 보내지 않고 unrouted 로 드러낸다 — 미인식과 구분된다', b, () => {
  const a = R.routeIntent({ scope, decision: decision(), table: table([]), flows: lookup([flow('f_bal')]) });
  assert.equal(a.kind, 'unrouted');
  assert.equal(a.intent, 'balance');
  assert.notEqual(a.kind, 'fallback');
});

test('등록 검증을 지나온 뒤 시나리오가 사라져도 통화를 죽이지 않는다(§9.3)', b, () => {
  const a = R.routeIntent({
    scope, decision: decision(), table: table([{ intent: 'balance', flowId: 'f_bal' }]), flows: lookup([]),
  });
  assert.equal(a.kind, 'unrouted');
  assert.match(a.reasonKo, /f_bal/);
});

test('진입 노드가 실제로 없으면 시작하지 않는다 — Runner 의 "정의되지 않은 노드"를 앞에서 막는다', b, () => {
  const a = R.routeIntent({
    scope, decision: decision(),
    table: table([{ intent: 'balance', flowId: 'f_bal', entryNodeId: 'nX' }]), flows: lookup([flow('f_bal')]),
  });
  assert.equal(a.kind, 'unrouted');
});

test('handoffOnly 확정은 시나리오를 타지 않는다', b, () => {
  const a = R.routeIntent({
    scope, decision: decision({ intent: 'complaint', handoffOnly: true }),
    table: table([{ intent: 'complaint', flowId: 'f_bal' }]), flows: lookup([flow('f_bal')]),
  });
  assert.equal(a.kind, 'handoff');
  assert.equal(a.intent, 'complaint');
});

test('미인식은 폴백 1회로 내려간다 — 사다리 규칙은 여기서 다시 쓰지 않는다(§5.1)', b, () => {
  const a = R.routeIntent({
    scope, decision: decision({ kind: 'unmatched', intent: undefined, options: [], reasonKo: '인텐트 후보 없음' }),
    table: table([]), flows: lookup([]),
  });
  assert.deepEqual(a, { kind: 'fallback', failureIncrement: 1, reasonKo: '인텐트 후보 없음' });
});

test('명확화 번호는 resolveClarifyChoice 와 같은 배열에서 나온다 — "2번"이 다른 인텐트로 가지 않는다', b, () => {
  const options = [
    { intent: 'reissue', labelKo: '카드재발급', confidence: 0.55 },
    { intent: 'balance', labelKo: '잔액조회', confidence: 0.52 },
  ];
  const a = R.routeIntent({
    scope, decision: decision({ kind: 'clarify', intent: undefined, options, reasonKo: '격차 부족', attempt: 0 }),
    table: table([]), flows: lookup([]), clarifyPrompt: '다음 중 무엇을 도와드릴까요?',
  });
  assert.equal(a.kind, 'clarify');
  assert.deepEqual(a.options.map((o) => o.position), [1, 2]);
  assert.equal(a.nextAttempt, 1);
  for (const o of a.options) {
    assert.equal(N.resolveClarifyChoice(a.options, String(o.position)), o.intent,
      '표시 번호와 해석 결과가 어긋나면 고객이 고른 것과 다른 인텐트가 확정된다');
  }
});

test('명확화 문구를 주지 않으면 지어내지 않고 promptMissing 으로 드러낸다(§13-3)', b, () => {
  const options = [
    { intent: 'reissue', labelKo: '카드재발급', confidence: 0.55 },
    { intent: 'balance', labelKo: '잔액조회', confidence: 0.52 },
  ];
  const d = decision({ kind: 'clarify', intent: undefined, options, reasonKo: '격차 부족', attempt: 0 });
  const a = R.routeIntent({ scope, decision: d, table: table([]), flows: lookup([]) });
  assert.equal(a.promptMissing, true);
  assert.equal(a.prompt, undefined);

  const blank = R.routeIntent({ scope, decision: d, table: table([]), flows: lookup([]), clarifyPrompt: '   ' });
  assert.equal(blank.promptMissing, true, '공백 문구는 문구가 아니다');
});

test('다른 테넌트의 라우팅 표로는 시나리오를 시작할 수 없다(§11.1)', b, () => {
  assert.throws(
    () => R.routeIntent({ scope: { tenantId: 't2' }, decision: decision(), table: table([{ intent: 'balance', flowId: 'f_bal' }]), flows: lookup([flow('f_bal')]) }),
    /§11\.1/,
  );
  assert.throws(
    () => R.routeIntent({
      scope: { tenantId: 't1', workspaceId: 'w1' }, decision: decision(),
      table: table([{ intent: 'balance', flowId: 'f_bal' }], { workspaceId: 'w2' }), flows: lookup([flow('f_bal')]),
    }),
    /§11\.1/,
  );
});

test('빈 입력·빈 표에서도 판정이 돌고 터지지 않는다', b, () => {
  const a = R.routeIntent({
    scope, decision: decision({ kind: 'unmatched', intent: undefined, options: [], reasonKo: '' }),
    table: table([]), flows: lookup([]),
  });
  assert.equal(a.kind, 'fallback');
  assert.deepEqual(R.validateIntentRouting(table([]), catalog([]), lookup([])), []);
  assert.deepEqual(R.unroutedIntents(table([]), catalog([])), []);
});

test('실제 decideIntent 출력을 그대로 받아 시나리오까지 간다(모듈 경계 실검증)', b, () => {
  const d = N.decideIntent({
    scope,
    candidates: [{ intent: 'reissue', confidence: 0.93 }, { intent: 'balance', confidence: 0.12 }],
    catalog: catalog(base),
    policy: { tenantId: 't1', acceptThreshold: 0.7, rejectThreshold: 0.3, ambiguityMargin: 0.1, maxClarifyAttempts: 1, maxClarifyOptions: 3 },
    attempt: 0,
  });
  assert.equal(d.kind, 'accepted');
  const a = R.routeIntent({
    scope, decision: d, table: table([{ intent: 'reissue', flowId: 'f_re' }]), flows: lookup([flow('f_re')]),
  });
  assert.equal(a.kind, 'start_flow');
  assert.equal(a.flow.id, 'f_re');
});
