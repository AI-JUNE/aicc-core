// §9.3 축소 운영 지시가 단계에 도착하는가 — 정상 경로 + 실패 경로.
//
// `decideFallbackMode` 는 TTS·STT 저하를 `degraded_ai` 로 판정하고 "합성 대신 사전녹음·텍스트로
// 내린다"를 `disable` 에 적는다. 그런데 **합성하는 주체는 Core 가 아니라 채널**이고(§6.2),
// 그 목록을 읽는 코드는 저장소 전체에서 지식 응대 한 곳뿐이었다 — 즉 판정은 "TTS 를 끈다"인데
// 채널은 아무것도 모른 채 저하된 TTS 를 계속 불렀다. 예외도 알림도 없고 증상은 끊기는 음성이다.
//
// 여기서 고정하는 것:
//  1) 끌 것이 있으면 **이번 턴의 모든 단계**에 실린다(고지·대기 안내·조회 결과 포함).
//  2) 끌 것이 없으면 **필드 자체가 없다** — 빈 배열은 "축소 운영인데 끌 것은 없다"로 읽힌다(§13-3).
//  3) 채널이 의존하지 않는 컴포넌트는 지시가 되지 않는다(채팅에서 TTS 저하는 오탐이다).
//  4) 판정을 복사하지 않는다 — 목록·순서는 `MEDIA_DISABLE` 하나다(§2).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-19T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };

const flowSay = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요, AI 상담입니다.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.', next: 'bye' },
    bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
  },
};

const flowApi = () => ({
  id: 'api', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: 'account_no', prompt: '계좌번호를 말씀해 주세요.', next: 'lookup' },
    lookup: { id: 'lookup', kind: 'Api', connectorId: 'c_balance', waitText: '조회 중입니다.', next: 'tell' },
    tell: { id: 'tell', kind: 'Say', text: '조회가 끝났습니다.' },
  },
});

const CDEF = {
  id: 'c_balance', tenantId: 'goone', name: '잔액조회', method: 'query',
  endpointRef: 'secret://core/balance', residency: 'domestic', timeoutMs: 3000,
  params: [{ name: 'acct', fromSlot: 'account_no', required: true }],
  outputs: [{ field: 'balance', toSlot: 'balance' }],
  onFailure: 'branch',
};

const connectorBinding = () => ({
  connectors: { get: (id) => (id === 'c_balance' ? CDEF : undefined) },
  port: { async call() { return { ok: true, data: { balance: '10000' } }; } },
  allowOverseas: false,
});

/** present 로 **실제로 나간 배열 그대로** 모은다 — nodeId 만 모으면 지시 도착을 볼 수 없다. */
function capturingPort(id = 'callbot') {
  const presented = [];
  return {
    id,
    presented,
    capabilities: P.profileFor(id),
    async present(_iid, steps) { presented.push(steps); },
    async transfer() {},
    async routeToLegacyIvr() {},
    async invite() {},
    async end() {},
  };
}

function build({ flows = [flowSay], samples = [], port = capturingPort(), connectors, disclosure } = {}) {
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 200 }), releaseKeyOnSinkFailure: false,
  });
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS[port.id], contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry(samples),
    bus, now: () => NOW,
    newInteractionId: () => 'i_out1',
    ...(connectors !== undefined ? { connectors } : {}),
    ...(disclosure !== undefined ? { disclosure } : {}),
  });
  return { core, port, collector };
}

const sample = (component, state) => ({ component, state, observedAt: NOW });
const reqOf = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing', ...over });

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('TTS 저하: 이번 턴의 모든 단계가 합성 금지 지시를 받는다(§9.3)', b, async () => {
  const { core, port } = build({ samples: [sample('tts', 'degraded')] });
  const r = await core.start(reqOf());
  assert.equal(r.fallback.mode, 'degraded_ai');
  assert.equal(r.steps.length, 2);
  for (const s of r.steps) {
    assert.deepEqual(s.outage.disabled, ['voice_synthesis']);
    // 사유는 판정이 만든 문장 그대로다 — 여기서 새 문안을 만들지 않는다(§2).
    assert.equal(s.outage.reasonKo, r.fallback.reasonKo);
  }
  // 채널에 **실제로 나간 배열**에도 실려 있다. 결과에만 있으면 합성하는 쪽은 여전히 모른다.
  assert.deepEqual(port.presented[0].map((s) => s.outage.disabled), [['voice_synthesis'], ['voice_synthesis']]);
});

test('STT 저하: 음성 인식 금지 지시가 실린다', b, async () => {
  const { core } = build({ samples: [sample('stt', 'degraded')] });
  const r = await core.start(reqOf());
  assert.deepEqual(r.steps[0].outage.disabled, ['speech_recognition']);
});

test('둘 다 저하: 목록과 순서는 MEDIA_DISABLE 하나다(§2)', b, async () => {
  const { core } = build({ samples: [sample('stt', 'degraded'), sample('tts', 'degraded')] });
  const r = await core.start(reqOf());
  assert.deepEqual(r.steps[0].outage.disabled, [...F.MEDIA_DISABLE]);
  // 판정 쪽 목록과 단계 쪽 목록이 갈라지지 않는다 — 한쪽만 늘면 그 경로에서만 지시가 사라진다.
  assert.deepEqual(F.mediaDisabledBy(r.fallback), r.steps[0].outage.disabled);
});

test('이어지는 턴에도 매번 다시 실린다 — 한 번 보냈다고 끝이 아니다', b, async () => {
  const { core } = build({ samples: [sample('tts', 'degraded')] });
  await core.start(reqOf());
  const r = await core.send('i_out1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.ok(r.steps.length > 0);
  assert.deepEqual(r.steps[0].outage.disabled, ['voice_synthesis']);
});

test('Api 이행이 만든 단계(대기 안내·조회 결과)도 지시를 받는다(§6.1)', b, async () => {
  const { core, port } = build({
    flows: [flowApi()], samples: [sample('tts', 'degraded')], connectors: connectorBinding(),
  });
  await core.start(reqOf({ flowId: 'api' }));
  const r = await core.send('i_out1', { input: { kind: 'utterance', text: '110-1234' } });
  // 대기 안내는 호출 **전에** 따로 present 되므로, 거기서 빠지면 하필 그 안내만 지시 없이 나간다.
  const everyPresented = port.presented.flat();
  assert.ok(everyPresented.length >= 3);
  assert.equal(everyPresented.every((s) => s.outage?.disabled?.length === 1), true);
  assert.equal(r.steps.every((s) => s.outage !== undefined), true);
});

test('AI 고지 단계에도 실린다 — 첫 발화가 지시 없이 합성되지 않는다(§10.1)', b, async () => {
  const { core } = build({
    samples: [sample('tts', 'degraded')],
    disclosure: {
      tenantId: 'goone', enabled: true, approved: true,
      approvedAt: '2026-10-01T00:00:00.000Z', approvedBy: 'legal_kim',
      version: 2, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'admin',
      channels: { voice: { text: '본 상담은 AI 상담원이 진행합니다.', placement: 'before_first_response' } },
    },
  });
  const r = await core.start(reqOf());
  assert.equal(r.disclosure.channel, 'voice');
  assert.deepEqual(r.steps[0].outage.disabled, ['voice_synthesis']);
});

// ── 실패·경계 경로 ───────────────────────────────────────────────────────────

test('정상 판정이면 필드 자체가 없다 — 종전과 완전히 같다(§13-3)', b, async () => {
  const { core } = build();
  const r = await core.start(reqOf());
  assert.equal(r.steps.every((s) => s.outage === undefined), true);
  assert.equal(r.fallback, undefined);
});

test('지식검색만 끄는 판정에는 매체 지시가 없다 — 빈 배열을 찍지 않는다', b, async () => {
  const { core } = build({ samples: [sample('rag', 'down')] });
  const r = await core.start(reqOf());
  assert.equal(r.fallback.mode, 'degraded_ai');
  assert.deepEqual(r.fallback.disable, ['knowledge_grounding']);
  assert.equal(r.steps.every((s) => s.outage === undefined), true);
});

test('채널이 의존하지 않는 컴포넌트는 지시가 되지 않는다 — 채팅의 TTS 저하는 오탐이다', b, async () => {
  const port = capturingPort('chatbot');
  const { core } = build({ port, samples: [sample('tts', 'degraded'), sample('stt', 'degraded')] });
  const r = await core.start(reqOf({ adapter: 'chatbot' }));
  assert.equal(r.fallback, undefined);
  assert.equal(r.steps.every((s) => s.outage === undefined), true);
});

test('장애로 끝난 턴에는 단계가 없다 — 지시를 만들어 붙이지 않는다(§9.3)', b, async () => {
  const { core } = build({ samples: [sample('llm', 'down')] });
  const r = await core.start(reqOf());
  assert.equal(r.status, 'transferred');
  assert.deepEqual(r.steps, []);
  // AI 응대를 하지 않았으므로 매체에 시킬 것도 없다 — 판정 자체는 결과에 그대로 실린다.
  assert.equal(r.fallback.mode, 'agent_only');
});

test('mediaDisabledBy 는 매체 밖 항목을 섞지 않는다', b, () => {
  if (!F) return;
  const d = { mode: 'degraded_ai', causes: [], reasonKo: '', disable: ['ai_response', 'knowledge_grounding', 'voice_synthesis'] };
  assert.deepEqual(F.mediaDisabledBy(d), ['voice_synthesis']);
  assert.deepEqual(F.mediaDisabledBy({ ...d, disable: [] }), []);
});
