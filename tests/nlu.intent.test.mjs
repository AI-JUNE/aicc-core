import { test } from 'node:test';
import assert from 'node:assert/strict';

let nlu = null;
try { nlu = await import('../src/nlu/intent.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: nlu ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't1' };
const catalog = (over = {}) => ({
  tenantId: 't1',
  intents: [
    { id: 'balance', titleKo: '잔액조회' },
    { id: 'transfer', titleKo: '이체' },
    { id: 'complaint', titleKo: '불만접수', handoffOnly: true },
    { id: 'legacy', titleKo: '구버전', disabled: true },
  ],
  ...over,
});
const policy = (over = {}) => ({
  tenantId: 't1', acceptThreshold: 0.8, rejectThreshold: 0.3,
  ambiguityMargin: 0.1, maxClarifyOptions: 3, maxClarifyAttempts: 2, ...over,
});
const decide = (candidates, over = {}, attempt = 0) =>
  nlu.decideIntent({ scope, candidates, catalog: catalog(), policy: policy(over), attempt });

test('카탈로그 검증 — 중복·빈 목록·전부 비활성', b, () => {
  assert.deepEqual(nlu.validateIntentCatalog(catalog()), []);
  assert.ok(nlu.validateIntentCatalog({ tenantId: 't1', intents: [] }).length > 0);
  const dup = nlu.validateIntentCatalog({ tenantId: 't1', intents: [
    { id: 'a', titleKo: 'A' }, { id: 'a', titleKo: 'A2' }] });
  assert.ok(dup.some((e) => /중복/.test(e)));
  const off = nlu.validateIntentCatalog({ tenantId: 't1', intents: [{ id: 'a', titleKo: 'A', disabled: true }] });
  assert.ok(off.some((e) => /활성 인텐트가 하나도 없다/.test(e)));
});

test('정책 검증 — 임계 역전·범위·선택지 하한', b, () => {
  assert.deepEqual(nlu.validateIntentPolicy(policy()), []);
  assert.ok(nlu.validateIntentPolicy(policy({ rejectThreshold: 0.9 })).some((e) => /역전|클 수 없다/.test(e)));
  assert.ok(nlu.validateIntentPolicy(policy({ acceptThreshold: 1.5 })).some((e) => /0\.\.1/.test(e)));
  assert.ok(nlu.validateIntentPolicy(policy({ maxClarifyOptions: 1 })).some((e) => /maxClarifyOptions/.test(e)));
  assert.ok(nlu.validateIntentPolicy(policy({ maxClarifyAttempts: 0 })).some((e) => /maxClarifyAttempts/.test(e)));
});

test('단독 확정 — 임계 이상이고 격차가 충분할 때만', b, () => {
  const d = decide([{ intent: 'balance', confidence: 0.95 }, { intent: 'transfer', confidence: 0.4 }]);
  assert.equal(d.kind, 'accepted');
  assert.equal(d.intent, 'balance');
  assert.equal(d.handoffOnly, false);
});

test('근소한 격차는 확정하지 않고 되묻는다', b, () => {
  const d = decide([{ intent: 'balance', confidence: 0.92 }, { intent: 'transfer', confidence: 0.9 }]);
  assert.equal(d.kind, 'clarify');
  assert.deepEqual(d.options.map((o) => o.intent), ['balance', 'transfer']);
  assert.match(d.reasonKo, /격차/);
});

test('확정 임계 미달이면 clarify, 후보 자체가 없으면 unmatched', b, () => {
  assert.equal(decide([{ intent: 'balance', confidence: 0.5 }, { intent: 'transfer', confidence: 0.35 }]).kind, 'clarify');
  assert.equal(decide([]).kind, 'unmatched');
  assert.equal(decide([{ intent: 'balance', confidence: 0.1 }]).kind, 'unmatched');
});

test('명확화 한도를 소진하면 되묻지 않고 unmatched로 내린다', b, () => {
  const d = nlu.decideIntent({
    scope, candidates: [{ intent: 'balance', confidence: 0.5 }, { intent: 'transfer', confidence: 0.45 }],
    catalog: catalog(), policy: policy(), attempt: 2,
  });
  assert.equal(d.kind, 'unmatched');
  assert.match(d.reasonKo, /한도 소진/);
});

test('선택지가 1개뿐이면 명확화하지 않는다', b, () => {
  const d = decide([{ intent: 'balance', confidence: 0.5 }]);
  assert.equal(d.kind, 'unmatched');
  assert.match(d.reasonKo, /선택지가 부족/);
});

test('카탈로그 밖·비활성·범위이탈 후보는 버리고 근거를 남긴다', b, () => {
  const d = decide([
    { intent: 'balance', confidence: 0.95 },
    { intent: 'unknown_intent', confidence: 0.9 },
    { intent: 'legacy', confidence: 0.9 },
    { intent: 'transfer', confidence: 1.4 },
  ]);
  assert.equal(d.kind, 'accepted');
  assert.equal(d.intent, 'balance');
  assert.deepEqual(d.ignoredCandidates.sort(), ['legacy', 'transfer', 'unknown_intent']);
});

test('동점은 인텐트 ID 사전순으로 결정적으로 깬다', b, () => {
  const d1 = decide([{ intent: 'transfer', confidence: 0.9 }, { intent: 'balance', confidence: 0.9 }]);
  const d2 = decide([{ intent: 'balance', confidence: 0.9 }, { intent: 'transfer', confidence: 0.9 }]);
  assert.deepEqual(d1.options.map((o) => o.intent), d2.options.map((o) => o.intent));
  assert.equal(d1.options[0].intent, 'balance');
});

test('선택지 수는 정책 상한을 넘지 않는다', b, () => {
  const d = nlu.decideIntent({
    scope,
    candidates: [
      { intent: 'balance', confidence: 0.6 }, { intent: 'transfer', confidence: 0.58 },
      { intent: 'complaint', confidence: 0.55 },
    ],
    catalog: catalog(), policy: policy({ maxClarifyOptions: 2 }), attempt: 0,
  });
  assert.equal(d.kind, 'clarify');
  assert.equal(d.options.length, 2);
});

test('handoffOnly 인텐트는 확정 즉시 이관 단계로 (§2)', b, () => {
  const d = decide([{ intent: 'complaint', confidence: 0.99 }]);
  assert.equal(d.handoffOnly, true);
  assert.deepEqual(nlu.nextStep(d), { step: 'handoff', intent: 'complaint' });
});

test('nextStep — unmatched는 §5.1 폴백 실패 카운트를 올린다', b, () => {
  assert.deepEqual(nlu.nextStep(decide([])), { step: 'fallback', failureIncrement: 1 });
  const c = decide([{ intent: 'balance', confidence: 0.92 }, { intent: 'transfer', confidence: 0.9 }]);
  const n = nlu.nextStep(c);
  assert.equal(n.step, 'clarify');
  assert.equal(n.nextAttempt, 1);
  assert.deepEqual(nlu.nextStep(decide([{ intent: 'balance', confidence: 0.99 }])), { step: 'proceed', intent: 'balance' });
});

test('명확화 응답 해석 — 인텐트 ID·번호·실패', b, () => {
  const opts = [{ intent: 'balance', labelKo: '잔액조회', confidence: 0.6 },
                { intent: 'transfer', labelKo: '이체', confidence: 0.55 }];
  assert.equal(nlu.resolveClarifyChoice(opts, 'transfer'), 'transfer');
  assert.equal(nlu.resolveClarifyChoice(opts, '2번'), 'transfer');
  assert.equal(nlu.resolveClarifyChoice(opts, ' 1 '), 'balance');
  assert.equal(nlu.resolveClarifyChoice(opts, '5'), undefined);
  assert.equal(nlu.resolveClarifyChoice(opts, '모르겠어요'), undefined);
  assert.equal(nlu.resolveClarifyChoice(opts, ''), undefined);
});

test('다른 테넌트의 카탈로그·정책은 거부 (§11.1)', b, () => {
  assert.throws(() => nlu.decideIntent({
    scope: { tenantId: 't2' }, candidates: [], catalog: catalog(), policy: policy(), attempt: 0,
  }), /다른 테넌트/);
  assert.throws(() => nlu.decideIntent({
    scope, candidates: [], catalog: catalog(), policy: policy(), attempt: -1,
  }), /attempt/);
});
