// Core 가 부른 엔진의 §11.2 실측이 원장까지 닿는가 — 정상 경로 + 실패 경로.
//
// `billing/turnUsage.ts` 머리말은 "`billing/usage.ts` 는 이벤트에서 수량을 뽑고
// `adapters/engineSet.ts` 는 조각의 `lastUsage()` 를 모으는데 **그 둘 사이가 비어 있었다**"로
// 시작한다. 그 공백의 절반만 메워져 있었다: 런타임은 **채널이 선언한** 사용량만 실었고,
// Core 가 직접 부른 엔진(인텐트 분류·지식 검색·답변 생성)의 토큰은 어디에도 실리지 않았다.
// `UsageContribution.origin` 주석이 예로 적어 둔 `'engine_set'` 으로 기여하는 코드가 0줄이다.
//
// 증상은 예외가 아니다 — 그 비용은 공급사 청구서에만 남고 우리 집계에는 없어서 몇 주 뒤
// 대사에서 '미설명' 차이로 돌아온다. 반대 방향의 사고가 더 비싸다: `lastUsage()` 는
// **마지막 호출**의 값이므로 호출 여부를 보지 않고 매 턴 읽으면 직전 턴의 실측을 한 번 더
// 싣는다(이중 계상 = 과다청구 방향). 그래서 호출 횟수를 세어 가른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null, FT = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
  FT = await import('../src/flow/types.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-19T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };

const flowTriage = () => ({
  id: 'triage', version: 1, startNodeId: 'ask',
  nodes: { ask: { id: 'ask', kind: 'Collect', slot: FT.INTENT_SLOT, prompt: '무엇을 도와드릴까요?' } },
});
const flowBalance = {
  id: 'f_balance', version: 1, startNodeId: 'say',
  nodes: { say: { id: 'say', kind: 'Say', text: '잔액을 안내합니다.' } },
};
/** 엔진을 쓰지 않는 평범한 시나리오. 턴이 끝나도 세션이 살아 있어야 다음 턴을 비교할 수 있다. */
const flowPlain = {
  id: 'plain', version: 1, startNodeId: 'a',
  nodes: {
    a: { id: 'a', kind: 'Collect', slot: 'first', prompt: '성함을 말씀해 주세요.', next: 'bb' },
    bb: { id: 'bb', kind: 'Collect', slot: 'second', prompt: '생년월일을 말씀해 주세요.' },
  },
};

const CATALOG = { tenantId: 'goone', intents: [{ id: 'balance', titleKo: '잔액조회' }] };
const POLICY = {
  tenantId: 'goone', acceptThreshold: 0.7, rejectThreshold: 0.3,
  ambiguityMargin: 0.1, maxClarifyOptions: 3, maxClarifyAttempts: 1,
};
const TABLE = { tenantId: 'goone', routes: [{ intent: 'balance', flowId: 'f_balance' }] };

const sttAd = { name: 'stt-x', residency: 'onprem', stream: async function* () { yield { text: '여보세요', isFinal: true }; } };
const ttsAd = { name: 'tts-x', residency: 'onprem', synthesize: async function* () { yield { data: new Uint8Array([1]), mime: 'audio/wav' }; } };
const llmOk = (text) => ({ name: 'llm-x', residency: 'onprem', complete: async function* () { yield text; } });

/**
 * 조각이 **마지막 호출**의 실측을 알려주는 형태. 실제 HTTP 어댑터와 같은 규약이다
 * (`http.ts` 의 `lastUsage()` — 호출마다 덮어쓴다).
 */
function usageBox(initial) {
  const box = { value: initial };
  return { box, lastUsage: () => box.value };
}

function engineDecl({ llm, usage, source = 'fake', over = {} } = {}) {
  const u = usage ?? usageBox({ llm_prompt_tokens: 42, llm_completion_tokens: 7 });
  return {
    decl: {
      scope: SCOPE,
      allowOverseas: false,
      sets: [{
        name: 'primary',
        parts: [{
          kind: 'preassembled', source,
          engines: {
            activation: 'live', stt: sttAd, tts: ttsAd,
            llm: llm ?? llmOk('{"candidates":[{"intent":"balance","confidence":0.95}]}'),
            lastUsage: u.lastUsage,
          },
        }],
      }],
      resilience: { attemptsPerCandidate: 1 },
      intent: { systemKo: '너는 상담 분류기다.' },
      ...over,
    },
    box: u.box,
  };
}

function build({ flows, engines, intent, knowledge, port } = {}) {
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 200 }), releaseKeyOnSinkFailure: false,
  });
  const p = port ?? {
    id: 'callbot', capabilities: P.profileFor('callbot'),
    async present() {}, async transfer() {}, async routeToLegacyIvr() {},
    async invite() {}, async end() {},
  };
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry(flows ?? [flowTriage(), flowBalance]),
    channels: [{ port: p, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    bus, now: () => NOW,
    newInteractionId: () => 'i_eu1',
    ...(engines !== undefined ? { engines } : {}),
    ...(intent !== undefined ? { intent } : {}),
    ...(knowledge !== undefined ? { knowledge } : {}),
  });
  return { core, collector };
}

const intentBinding = { catalog: CATALOG, policy: POLICY, table: TABLE, clarifyPrompt: '어떤 업무를 도와드릴까요?' };
const reqOf = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'triage', ...over });

/** 이번 턴의 고객 발화 이벤트에 실린 실측. 없으면 undefined. */
const turnUsageOf = (r) => r.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer')?.usage;

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('Core 가 부른 엔진의 실측이 턴 이벤트에 실린다(§11.2)', b, async () => {
  const e = engineDecl();
  const { core } = build({ engines: e.decl, intent: intentBinding });
  await core.start(reqOf());
  const r = await core.send('i_eu1', { input: { kind: 'utterance', text: '잔액 알려줘' } });
  assert.equal(r.state.flowId, 'f_balance', '분류기가 실제로 돌았다');
  assert.equal(r.billing.usageAttached, true);
  assert.deepEqual(turnUsageOf(r), { llm_prompt_tokens: 42, llm_completion_tokens: 7 });
});

test('채널 선언과 엔진 실측은 **한 번에** 합쳐 싣는다 — 따로 붙이면 뒤쪽이 사라진다', b, async () => {
  const e = engineDecl();
  const { core } = build({ engines: e.decl, intent: intentBinding });
  await core.start(reqOf());
  const r = await core.send('i_eu1', {
    input: { kind: 'utterance', text: '잔액 알려줘' },
    usage: { stt_audio_ms: 2000 },
  });
  assert.equal(r.billing.usageAttached, true);
  assert.deepEqual(turnUsageOf(r), { llm_prompt_tokens: 42, llm_completion_tokens: 7, stt_audio_ms: 2000 });
});

test('같은 항목을 두 출처가 내면 합산하지 않고 드러낸다 — 합산은 곧 과다청구다', b, async () => {
  const e = engineDecl();
  const { core } = build({ engines: e.decl, intent: intentBinding });
  await core.start(reqOf());
  const r = await core.send('i_eu1', {
    input: { kind: 'utterance', text: '잔액 알려줘' },
    usage: { llm_prompt_tokens: 100 },
  });
  assert.deepEqual(r.billing.usageConflicts, ['llm_prompt_tokens']);
  // 빠진 키는 이벤트에도 없다 — 어느 쪽을 믿을지 Core 가 고르지 않는다(§2·§13-3).
  assert.equal(turnUsageOf(r).llm_prompt_tokens, undefined);
  assert.equal(turnUsageOf(r).llm_completion_tokens, 7);
});

// ── 실패·경계 경로 ───────────────────────────────────────────────────────────

test('엔진을 부르지 않은 턴은 직전 턴의 실측을 다시 싣지 않는다(이중 계상 방지)', b, async () => {
  const e = engineDecl({ llm: llmOk('{"candidates":[]}') });
  const { core } = build({ engines: e.decl, intent: intentBinding });
  await core.start(reqOf());
  const first = await core.send('i_eu1', { input: { kind: 'utterance', text: '어...' } });
  assert.equal(first.billing.usageAttached, true);
  // 무입력은 인텐트 경로를 타지 않으므로 이 턴에는 엔진 호출이 없다. 어댑터의 `lastUsage()` 는
  // 여전히 같은 값을 돌려주지만 그것은 **이 턴에 쓴 것이 아니다**.
  const second = await core.send('i_eu1', { input: { kind: 'timeout' } });
  assert.equal(second.status, 'running');
  assert.equal(second.billing, undefined, '엔진을 부르지 않은 턴에 과금 기록을 만들면 안 된다');
  assert.equal(turnUsageOf(second), undefined);
});

test('값이 그대로여도 다시 불렀으면 싣는다 — 같은 발화는 같은 토큰 수를 낸다', b, async () => {
  // 값 비교로 가르면 이 턴의 실측이 조용히 사라진다(누락 방향). 그래서 횟수로 가른다.
  const e = engineDecl({ llm: llmOk('{"candidates":[]}') });
  const { core } = build({
    flows: [flowTriage(), flowBalance], engines: e.decl, intent: intentBinding,
  });
  await core.start(reqOf());
  const a = await core.send('i_eu1', { input: { kind: 'utterance', text: '어...' } });
  const c = await core.send('i_eu1', { input: { kind: 'utterance', text: '어...' } });
  assert.deepEqual(turnUsageOf(a), { llm_prompt_tokens: 42, llm_completion_tokens: 7 });
  assert.deepEqual(turnUsageOf(c), { llm_prompt_tokens: 42, llm_completion_tokens: 7 });
});

test('어댑터가 실측을 주지 않으면 0 으로 적지 않는다(§13-3)', b, async () => {
  const e = engineDecl({ usage: usageBox(undefined) });
  const { core } = build({ engines: e.decl, intent: intentBinding });
  await core.start(reqOf());
  const r = await core.send('i_eu1', { input: { kind: 'utterance', text: '잔액 알려줘' } });
  assert.equal(r.state.flowId, 'f_balance');
  assert.equal(r.billing, undefined);
  assert.equal(turnUsageOf(r), undefined);
});

test('실측으로 볼 수 없는 값은 버리고 버린 사실을 남긴다 — NaN 하나가 월 집계를 무너뜨린다', b, async () => {
  const e = engineDecl({ usage: usageBox({ llm_prompt_tokens: -3, gpu_seconds: 9 }) });
  const { core } = build({ engines: e.decl, intent: intentBinding });
  await core.start(reqOf());
  const r = await core.send('i_eu1', { input: { kind: 'utterance', text: '잔액 알려줘' } });
  assert.equal(r.billing.usageAttached, false);
  assert.deepEqual(r.billing.usageRejected, ['engine_set.llm_prompt_tokens', 'engine_set.gpu_seconds']);
  assert.equal(turnUsageOf(r), undefined);
});

test('되묻는 중이 아닌 DTMF 는 엔진을 부르지 않으므로 기록도 없다', b, async () => {
  const e = engineDecl();
  const { core } = build({ engines: e.decl, intent: intentBinding });
  await core.start(reqOf());
  const r = await core.send('i_eu1', { input: { kind: 'dtmf', digits: '1' } });
  assert.equal(r.billing, undefined);
});

test('엔진 미배선이면 종전과 완전히 같다 — 채널 선언만 실린다(§13-3)', b, async () => {
  const { core } = build({ flows: [flowPlain], intent: undefined });
  await core.start(reqOf({ flowId: 'plain' }));
  const r = await core.send('i_eu1', {
    input: { kind: 'utterance', text: '홍길동' },
    usage: { stt_audio_ms: 1200 },
  });
  assert.equal(r.billing.usageAttached, true);
  assert.deepEqual(turnUsageOf(r), { stt_audio_ms: 1200 });
});

test('턴 밖의 호출은 이 턴으로 세지 않는다 — 기준점은 턴 시작이다', b, async () => {
  const e = engineDecl();
  const { core } = build({ engines: e.decl, intent: intentBinding });
  const eng = core.engines();
  await core.start(reqOf());
  // 호스트가 턴 밖에서 분류기를 불러도(검토·배치) 이 턴의 기준점 뒤에 생긴 호출만 센다.
  await eng.classifier.classify({ scope: SCOPE, catalog: CATALOG, utterance: '미리 분류' });
  const r = await core.send('i_eu1', { input: { kind: 'utterance', text: '잔액 알려줘' } });
  assert.equal(r.billing.usageAttached, true);
  // 이 턴 안의 호출은 한 번이므로 "덮였을 수 있다"는 한계 문구가 붙지 않는다.
  assert.equal(r.billing.usageReasonKo, undefined);
});

// ── 한 턴에 두 번 이상 부르는 경로(§5.2 지식 응대) ───────────────────────────
// 검색(임베딩)과 답변(LLM)이 같은 턴에 돌고, 두 호출이 **같은 조각**에서 왔으면 어댑터의
// `lastUsage()` 는 마지막 값만 들고 있다. 앞 호출의 실측을 추정해 더하지 않고 그 사실만 적는다.

const embAd = { name: 'emb-x', residency: 'onprem', embed: async (texts) => texts.map(() => [0.1, 0.2]) };
const KB_NS = 't/goone/kb/kb_faq';
const KB_HIT = {
  id: 'd1#0', score: 0.9, namespace: KB_NS, text: '수수료는 면제입니다.',
  metadata: { docId: 'd1', title: '수수료 안내', sourceUri: 'kb://fee', approved: true },
};
const kbStore = () => ({
  scope: SCOPE, upsert: async () => {}, purge: async () => {}, query: async () => [KB_HIT],
});
const flowFaq = {
  id: 'faq', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: FT.KNOWLEDGE_SLOT, prompt: '무엇이 궁금하신가요?', next: 'bye' },
    bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
  },
};

test('검색+답변이 한 턴에 돌면 "덮였을 수 있다"는 한계를 적는다(§11.2·§13-3)', b, async () => {
  const u = usageBox({ llm_prompt_tokens: 120 });
  const { core } = build({
    flows: [flowFaq],
    engines: {
      scope: SCOPE, allowOverseas: false,
      sets: [{
        name: 'primary',
        parts: [{
          kind: 'preassembled', source: 'fake',
          engines: {
            activation: 'live', stt: sttAd, tts: ttsAd, embedding: embAd,
            llm: llmOk('{"sufficient":true,"answerKo":"수수료는 면제입니다 [1]."}'),
            lastUsage: u.lastUsage,
          },
        }],
      }],
      resilience: { attemptsPerCandidate: 1 },
      knowledge: { expectDim: 2 },
      answer: { systemKo: '근거만으로 존댓말로 답한다.' },
    },
    knowledge: {
      search: { store: kbStore(), knowledgeBaseIds: ['kb_faq'] },
      policy: { topK: 3, minScore: 0.5, minHits: 1, maxContextChars: 2000 },
    },
  });
  await core.start(reqOf({ flowId: 'faq' }));
  const r = await core.send('i_eu1', { input: { kind: 'utterance', text: '수수료가 얼마예요?' } });
  assert.deepEqual(turnUsageOf(r), { llm_prompt_tokens: 120 });
  assert.equal(r.billing.usageAttached, true);
  assert.match(r.billing.usageReasonKo, /엔진을 2번 불렀습니다/);
  assert.match(r.billing.usageReasonKo, /덮였을 수 있습니다/);
});
