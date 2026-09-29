// 인텐트 진입 실행기 — 분류기 → decideIntent → routeIntent 를 꿰는 자리.
// 여기서 막는 사고는 대부분 예외가 아니라 **조용한 오답**이다(장애를 미인식으로 적기, 고객이 고른 것에
// 신뢰도를 지어 넣기, 설정 누락을 정상 이관으로 적기). 검사로 고정하지 않으면 드러나지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let X = null, N = null;
try {
  X = await import('../src/nlu/executeIntentEntry.ts');
  N = await import('../src/nlu/intent.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: X ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't1' };

const flowOf = (id) => ({
  id, version: 1, startNodeId: 'n1',
  nodes: {
    n1: { id: 'n1', kind: 'Say', text: `${id} 안내`, next: 'n2' },
    n2: { id: 'n2', kind: 'Say', text: '끝' },
  },
});
const FLOWS = [flowOf('f_balance'), flowOf('f_reissue')];
const flows = {
  get(id, version) {
    const list = FLOWS.filter((f) => f.id === id);
    if (!list.length) return undefined;
    if (version !== undefined) return list.find((f) => f.version === version);
    return list.reduce((a, c) => (c.version > a.version ? c : a));
  },
};

const catalog = (over = {}) => ({
  tenantId: 't1',
  intents: [
    { id: 'balance', titleKo: '잔액조회', clarifyLabelKo: '잔액 조회' },
    { id: 'reissue', titleKo: '카드재발급' },
    { id: 'complaint', titleKo: '불만접수', handoffOnly: true },
  ],
  ...over,
});

const policy = (over = {}) => ({
  tenantId: 't1', acceptThreshold: 0.7, rejectThreshold: 0.3,
  ambiguityMargin: 0.1, maxClarifyOptions: 3, maxClarifyAttempts: 1, ...over,
});

const table = (over = {}) => ({
  tenantId: 't1',
  routes: [
    { intent: 'balance', flowId: 'f_balance' },
    { intent: 'reissue', flowId: 'f_reissue' },
  ],
  ...over,
});

/** 가짜 분류기 — 실호출이 없다는 사실을 호출 기록으로 고정한다. */
function fakeClassifier(result, opts = {}) {
  const calls = [];
  return {
    calls,
    contractVersion: 1,
    engine: { name: 'fake', residency: 'onprem' },
    plan: () => ({ messages: [], utteranceMasked: '', promptChars: 0 }),
    async classify(req) {
      calls.push(req);
      if (opts.throws) throw new Error('발신번호 010-1234-5678 로 붙다가 터짐');
      return {
        status: 'ok', candidates: [], hallucinated: [], reasonKo: '판정',
        engine: { name: 'fake', residency: 'onprem' },
        utteranceMasked: '', piiMasked: false,
        ...result,
      };
    },
  };
}

const cfg = (classifier, over = {}) => ({
  catalog: catalog(), policy: policy(), table: table(), flows,
  classifier, clarifyPrompt: '어떤 업무를 도와드릴까요?', ...over,
});

const input = (over = {}) => ({ scope, channel: 'voice', text: '잔액 알려주세요', ...over });

// ── 정적 계약 ────────────────────────────────────────────────────────────────

test('판정을 복사하지 않는다 — 임계값·한도·라우팅 규칙이 이 파일에 없다(§2)', b, () => {
  const src = read('src/nlu/executeIntentEntry.ts');
  assert.doesNotMatch(src, /acceptThreshold|rejectThreshold|ambiguityMargin|maxClarifyAttempts|maxClarifyOptions/);
  // 라우트 탐색을 여기서 다시 하면 routeIntent 와 갈라진다.
  assert.doesNotMatch(src, /table\.routes\.find|routes\.filter/);
});

test('문구를 만들지 않는다(§13-3) — 고객에게 나갈 한국어 문장이 코드에 없다', b, () => {
  const src = read('src/nlu/executeIntentEntry.ts');
  assert.doesNotMatch(src, /다시 말씀해|무엇을 도와|죄송합니다/);
});

// ── 확정 ─────────────────────────────────────────────────────────────────────

test('확정되면 조회까지 끝난 시나리오 실물을 돌려준다', b, async () => {
  const c = fakeClassifier({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const out = await X.resolveIntentEntry(cfg(c), input());
  assert.equal(out.kind, 'start_flow');
  assert.equal(out.intent, 'balance');
  assert.equal(out.flow.id, 'f_balance');
  assert.equal(out.entryNodeId, 'n1');
  assert.equal(out.confidence, 0.95);      // 엔진 실측은 그대로 싣는다
  assert.equal(out.chosen, false);
  assert.equal(c.calls.length, 1);
});

test('상담사 전용 인텐트는 시나리오를 타지 않고 정상 이관(policy)으로 적힌다(§2)', b, async () => {
  const c = fakeClassifier({ candidates: [{ intent: 'complaint', confidence: 0.99 }] });
  const out = await X.resolveIntentEntry(cfg(c), input({ text: '불만 접수할게요' }));
  assert.equal(out.kind, 'handoff');
  assert.equal(out.cause, 'handoff_only');
  assert.equal(out.reason, 'policy');
});

test('설정 누락(unrouted)은 정상 이관으로 적지 않는다 — error 로 갈라 적는다', b, async () => {
  // balance 라우트를 빼면 확정돼도 갈 곳이 없다. policy 로 적으면 정상 이관에 섞여 영영 안 보인다.
  const c = fakeClassifier({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const out = await X.resolveIntentEntry(
    cfg(c, { table: table({ routes: [{ intent: 'reissue', flowId: 'f_reissue' }] }) }),
    input(),
  );
  assert.equal(out.kind, 'handoff');
  assert.equal(out.cause, 'unrouted');
  assert.equal(out.reason, 'error');
  assert.equal(out.intent, 'balance');
});

// ── 명확화 ───────────────────────────────────────────────────────────────────

const ambiguous = () => fakeClassifier({
  candidates: [{ intent: 'balance', confidence: 0.8 }, { intent: 'reissue', confidence: 0.78 }],
});

test('모호하면 되묻고, 그 단계는 채널이 그대로 렌더할 수 있다', b, async () => {
  const out = await X.resolveIntentEntry(cfg(ambiguous()), input());
  assert.equal(out.kind, 'clarify');
  assert.equal(out.step.kind, 'Choice');
  assert.equal(out.step.text.includes('어떤 업무를 도와드릴까요?'), true);
  assert.equal(out.step.acceptDtmf, true);              // 음성은 번호로 답한다
  assert.match(out.step.text, /1번 잔액 조회/);          // clarifyLabelKo 를 쓴다
  assert.equal(out.pending.options.length, 2);
  assert.equal(out.pending.attempt, 1);
});

test('명확화 단계는 시나리오 노드가 아니다 — 포트가 flow.nodes 로 되짚으면 죽는다', b, async () => {
  const out = await X.resolveIntentEntry(cfg(ambiguous()), input());
  assert.equal(out.step.nodeId, X.CLARIFY_NODE_ID);
  assert.equal(Object.prototype.hasOwnProperty.call(FLOWS[0].nodes, X.CLARIFY_NODE_ID), false);
});

test('화면 채널은 같은 선택지를 버튼으로 낸다(표현만 다르고 판정은 하나다)', b, async () => {
  const out = await X.resolveIntentEntry(cfg(ambiguous()), input({ channel: 'visual' }));
  assert.equal(out.step.ui.type, 'buttons');
  assert.deepEqual(out.step.ui.items.map((i) => i.value), ['balance', 'reissue']);
  assert.equal(out.step.acceptDtmf, undefined);
});

test('표시 번호와 선택 해석이 어긋나지 않는다 — 표시한 번호를 그대로 다시 넣어 확인한다', b, async () => {
  const out = await X.resolveIntentEntry(cfg(ambiguous()), input());
  for (const o of out.pending.options) {
    assert.equal(N.resolveClarifyChoice(out.pending.options, `${o.position}번`), o.intent);
  }
});

test('턴 타이밍 정책은 명확화 단계에도 실린다 — 그 턴만 채널 기본값으로 놀면 안 된다', b, async () => {
  const out = await X.resolveIntentEntry(cfg(ambiguous()), input({
    timing: { inputTimeoutMsByKind: { Choice: 5000 }, bargeInByKind: { Choice: false } },
  }));
  assert.equal(out.step.inputTimeoutMs, 5000);
  assert.equal(out.step.bargeIn, false);
});

test('명확화 문구가 없으면 되묻지 않는다 — Core 가 질문을 지어내지 않는다(§13-3)', b, async () => {
  const out = await X.resolveIntentEntry(cfg(ambiguous(), { clarifyPrompt: '   ' }), input());
  assert.equal(out.kind, 'fallback');
  assert.equal(out.classifierFailed, false);
});

// ── 명확화 답변 ──────────────────────────────────────────────────────────────

const pendingOf = async () => (await X.resolveIntentEntry(cfg(ambiguous()), input())).pending;

test('선택지 답변으로는 엔진을 다시 부르지 않는다 — 고객은 이미 골랐다', b, async () => {
  const pending = await pendingOf();
  const c = fakeClassifier({ candidates: [{ intent: 'reissue', confidence: 0.99 }] });
  const out = await X.resolveIntentEntry(cfg(c), input({ text: '2번', pending }));
  assert.equal(c.calls.length, 0);
  assert.equal(out.kind, 'start_flow');
  assert.equal(out.intent, 'reissue');     // 모델이 아니라 고객이 고른 것
});

test('고객이 고른 결과에는 신뢰도를 지어 넣지 않는다(§13-3·§7)', b, async () => {
  const pending = await pendingOf();
  const out = await X.resolveIntentEntry(cfg(fakeClassifier({})), input({ text: 'balance', pending }));
  assert.equal(out.kind, 'start_flow');
  assert.equal(out.chosen, true);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'confidence'), false);
});

test('고른 인텐트가 그 사이 비활성화됐으면 시작하지 않는다', b, async () => {
  const pending = await pendingOf();
  const shrunk = catalog({
    intents: [{ id: 'balance', titleKo: '잔액조회', disabled: true }, { id: 'reissue', titleKo: '카드재발급' }],
  });
  const out = await X.resolveIntentEntry(
    cfg(fakeClassifier({}), { catalog: shrunk }), input({ text: '1번', pending }),
  );
  assert.equal(out.kind, 'fallback');
  assert.equal(out.classifierFailed, false);
});

test('고른 인텐트가 상담사 전용이면 이관한다', b, async () => {
  const pending = { options: [{ intent: 'complaint', labelKo: '불만접수', confidence: 0.5, position: 1 }], attempt: 1 };
  const out = await X.resolveIntentEntry(cfg(fakeClassifier({})), input({ text: '1번', pending }));
  assert.equal(out.kind, 'handoff');
  assert.equal(out.cause, 'handoff_only');
});

test('선택지로 안 읽히면 조용히 넘기지 않고 새 발화로 다시 분류한다', b, async () => {
  const pending = await pendingOf();
  const c = fakeClassifier({ candidates: [{ intent: 'reissue', confidence: 0.95 }] });
  const out = await X.resolveIntentEntry(cfg(c), input({ text: '아니 카드 재발급이요', pending }));
  assert.equal(c.calls.length, 1);
  assert.equal(out.kind, 'start_flow');
  assert.equal(out.intent, 'reissue');
});

test('되묻기 한도는 여기서 세지 않고 decideIntent 가 본다 — 한도 소진 뒤에는 또 되묻지 않는다', b, async () => {
  const pending = await pendingOf();        // attempt 1, 정책상 maxClarifyAttempts 1
  const out = await X.resolveIntentEntry(cfg(ambiguous()), input({ text: '음 그게', pending }));
  assert.equal(out.kind, 'fallback');
  assert.match(out.reasonKo, /한도 소진/);
});

test('선택지가 빈 상태는 되묻는 중이 아니다 — 시도 횟수만 이어받아 새로 분류한다', b, async () => {
  const c = fakeClassifier({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  const out = await X.resolveIntentEntry(cfg(c), input({ pending: { options: [], attempt: 1 } }));
  assert.equal(c.calls.length, 1);
  assert.equal(out.kind, 'start_flow');
});

// ── 실패 경로: 장애와 미인식을 갈라 적는다 ───────────────────────────────────

test('분류기 장애를 "못 알아들었다"로 적지 않는다', b, async () => {
  const c = fakeClassifier({ status: 'engine_error', candidates: [], reasonKo: '엔진 타임아웃' });
  const out = await X.resolveIntentEntry(cfg(c), input());
  assert.equal(out.kind, 'fallback');
  assert.equal(out.classifierFailed, true);
  assert.equal(out.classifierStatus, 'engine_error');
});

test('규약 위반 응답도 엔진 실패다 — 빈 후보로 읽지 않는다', b, async () => {
  for (const status of ['unparsable', 'invalid_candidates']) {
    const out = await X.resolveIntentEntry(cfg(fakeClassifier({ status })), input());
    assert.equal(out.kind, 'fallback');
    assert.equal(out.classifierFailed, true, status);
  }
});

test('후보가 없어 미인식인 것은 엔진 실패가 아니다', b, async () => {
  const out = await X.resolveIntentEntry(cfg(fakeClassifier({ candidates: [] })), input());
  assert.equal(out.kind, 'fallback');
  assert.equal(out.classifierFailed, false);
});

test('분류기가 던져도 통화를 끊지 않고, 예외 원문·스택을 싣지 않는다(§9.3·§10.3)', b, async () => {
  const out = await X.resolveIntentEntry(cfg(fakeClassifier({}, { throws: true })), input());
  assert.equal(out.kind, 'fallback');
  assert.equal(out.classifierFailed, true);
  assert.doesNotMatch(out.reasonKo, /010|터짐|at /);
});

test('빈 발화로는 엔진을 부르지 않는다(§11.2) — 미인식이 아니라 무입력이다', b, async () => {
  const c = fakeClassifier({});
  const out = await X.resolveIntentEntry(cfg(c), input({ text: '   ' }));
  assert.equal(c.calls.length, 0);
  assert.equal(out.kind, 'fallback');
  assert.equal(out.classifierFailed, false);
});

test('모델이 헛본 id 와 판정에서 버린 후보를 구분해 드러낸다(§7 7.3)', b, async () => {
  const c = fakeClassifier({
    candidates: [{ intent: 'balance', confidence: 0.95 }, { intent: 'reissue', confidence: 0.1 }],
    hallucinated: ['카드분실'],
  });
  const out = await X.resolveIntentEntry(cfg(c), input());
  assert.deepEqual(out.hallucinated, ['카드분실']);
  assert.deepEqual(out.ignoredCandidates, ['reissue']);   // 하한 미달로 버려진 실제 후보
});

test('발화 원문은 결과 어디에도 남지 않는다(§10.3)', b, async () => {
  const c = fakeClassifier({ candidates: [] });
  const out = await X.resolveIntentEntry(cfg(c), input({ text: '제 번호는 010-1234-5678 입니다' }));
  assert.doesNotMatch(JSON.stringify(out), /010-1234-5678/);
});

test('다른 테넌트의 카탈로그로는 판정하지 않는다 — 던진다(§11.1)', b, async () => {
  const c = fakeClassifier({ candidates: [{ intent: 'balance', confidence: 0.95 }] });
  await assert.rejects(
    () => X.resolveIntentEntry(cfg(c, { catalog: catalog({ tenantId: 'other' }) }), input()),
    /§11.1/,
  );
});

test('계약 버전이 노출된다', b, () => {
  assert.equal(typeof X.INTENT_ENTRY_CONTRACT_VERSION, 'number');
});
