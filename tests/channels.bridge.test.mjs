// 언어 중립 브리지(JSONL) 검증 — 정상 경로 + 실패 경로.
//
// 여기서 지키려는 것은 프로토콜 문법이 아니라 **경계에서의 사고 방지**다:
// 테넌트 위장, 상담사용 요약 유출, 슬롯 원문 유출, 깨진 줄에 의한 프로세스 사망,
// 그리고 "검증 없이 통과한 잘못된 사용량"(과금 분쟁의 출발점).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let BR = null, R = null, F = null, P = null, BP = null;
try {
  BR = await import('../src/channels/bridge.ts');
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  P = await import('../src/channels/profiles.ts');
  BP = await import('../src/channels/basePort.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: BR ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const NOW = '2026-09-06T09:00:00.000Z';

const flow = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.', next: 'toAgent' },
    toAgent: { id: 'toAgent', kind: 'Transfer', queue: 'q_care', reason: 'policy' },
  },
};

function build(bridgeOver = {}, coreOver = {}) {
  const port = BP.createChannelPort({ id: 'callbot' });
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    now: () => NOW,
    newInteractionId: () => 'i_bridge1',
    ...coreOver,
  });
  const bridge = BR.createBridge({ core, adapter: 'callbot', scope: SCOPE, ...bridgeOver });
  return { bridge, core, port };
}

const line = (o) => JSON.stringify(o);

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('hello 는 프로토콜·계약 버전과 능력을 알려준다', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine(line({ id: '1', op: 'hello' }));
  assert.equal(r.ok, true);
  assert.equal(r.id, '1');
  assert.equal(r.result.protocolVersion, BR.BRIDGE_PROTOCOL_VERSION);
  assert.equal(r.result.adapter, 'callbot');
  assert.equal(r.result.capabilities.dtmf, true);
  assert.equal(r.result.activation, 'dry_run');
});

test('start→send→end 한 통화가 줄 단위로 완주한다', b, async () => {
  const { bridge } = build();
  const s = await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  assert.equal(s.ok, true);
  assert.equal(s.result.interactionId, 'i_bridge1');
  assert.deepEqual(s.result.steps.map((x) => x.nodeId), ['greet', 'ask']);

  const t = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'utterance', text: '홍길동', confidence: 0.9 }, latency: { total_ms: 120 }, usage: { stt_audio_ms: 800 } },
  }));
  assert.equal(t.ok, true);
  assert.equal(t.result.handoff.queue, 'q_care');

  const e = await bridge.handleLine(line({ id: '3', op: 'end', interactionId: 'i_bridge1', reasonKo: '고객 종료' }));
  assert.equal(e.ok, true);
  assert.equal(e.result.state.status !== 'running', true);
});

test('dtmf·timeout·connectorResult 입력을 받아들인다', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  for (const [i, input] of [
    { kind: 'dtmf', digits: '1#' },
    { kind: 'timeout' },
    { kind: 'connectorResult', ok: false, errorCode: 'E_UPSTREAM' },
  ].entries()) {
    const r = await bridge.handleLine(line({ id: `t${i}`, op: 'send', interactionId: 'i_bridge1', turn: { input } }));
    assert.equal(r.ok, true, JSON.stringify(r.error));
  }
});

test('health 보고는 Core 로 전달되고 접수 건수를 돌려준다', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine(line({
    id: '1', op: 'health',
    report: { observedAt: NOW, samples: [{ component: 'stt', state: 'degraded', errorRate: 0.2 }] },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.result.accepted, 1);
});

test('요청은 도착 순서대로 직렬 처리된다', b, async () => {
  const { bridge } = build();
  const lines = [
    line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }),
    line({ id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '홍길동' } } }),
  ];
  const out = await Promise.all(lines.map((l) => bridge.handleLine(l)));
  assert.deepEqual(out.map((r) => r.id), ['1', '2']);
  assert.equal(out[1].ok, true, JSON.stringify(out[1].error));
});

test('runBridgeLines 는 빈 줄을 건너뛰고 응답 줄만 낸다', b, async () => {
  const { bridge } = build();
  const out = await BR.runBridgeLines(bridge, ['', '  ', line({ id: '1', op: 'hello' })]);
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).ok, true);
});

test('응답 인코딩에 개행이 섞이지 않는다', b, () => {
  const enc = BR.encodeResponse({ id: '1', ok: false, error: { code: 'E_BAD_REQUEST', messageKo: '줄\n바꿈\r포함' } });
  assert.equal(enc.includes('\n'), false);
  assert.equal(enc.includes('\r'), false);
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('깨진 JSON·빈 줄·모르는 op 는 오류 응답이지 예외가 아니다', b, async () => {
  const { bridge } = build();
  const cases = [
    ['{ 이건 JSON 이 아니다', 'E_BAD_JSON'],
    ['', 'E_BAD_REQUEST'],
    [line({ id: '1', op: 'drop_database' }), 'E_UNKNOWN_OP'],
    [line({ op: 'hello' }), 'E_BAD_REQUEST'],
    [line(['배열']), 'E_BAD_REQUEST'],
  ];
  for (const [input, code] of cases) {
    const r = await bridge.handleLine(input);
    assert.equal(r.ok, false, input);
    assert.equal(r.error.code, code, input);
  }
  // 프로세스가 죽지 않았으므로 다음 요청은 정상 처리된다.
  assert.equal((await bridge.handleLine(line({ id: 'x', op: 'hello' }))).ok, true);
});

test('깨진 JSON 원문을 응답에 되돌려주지 않는다(§10.3)', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine('{"id":"1","phone":"010-1234-5678"');
  assert.equal(r.error.code, 'E_BAD_JSON');
  assert.equal(r.error.messageKo.includes('1234'), false);
});

test('호스트가 다른 테넌트를 주장하면 거부한다(§11.1)', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine(line({
    id: '1', op: 'start',
    req: { flowId: 'billing', entryPoint: 'inbound_call', scope: { tenantId: 'other' } },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_TENANT_SCOPE');
});

test('다른 어댑터를 대신 열 수 없다', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine(line({
    id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call', adapter: 'chatbot' },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_BAD_REQUEST');
});

test('필수값 누락·형태 위반을 항목 단위로 거부한다', b, async () => {
  const { bridge } = build();
  const cases = [
    { id: '1', op: 'start', req: { entryPoint: 'inbound_call' } },                       // flowId 없음
    { id: '2', op: 'start', req: { flowId: 'billing', entryPoint: 'carrier_pigeon' } },   // 알 수 없는 진입점
    { id: '3', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call', flowVersion: 0 } },
    { id: '4', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call', presetSlots: { a: 1 } } },
    { id: '5', op: 'send', turn: { input: { kind: 'utterance', text: 'x' } } },           // interactionId 없음
    { id: '6', op: 'send', interactionId: 'i', turn: { input: { kind: 'shout' } } },
    { id: '7', op: 'send', interactionId: 'i', turn: { input: { kind: 'dtmf', digits: 'DROP' } } },
    { id: '8', op: 'send', interactionId: 'i', turn: { input: { kind: 'connectorResult' } } },
    { id: '9', op: 'end', interactionId: 'i' },                                           // 사유 없음
    { id: '10', op: 'health', report: { samples: [] } },                                  // 시각 없음
    { id: '11', op: 'health', report: { observedAt: NOW, samples: [{ component: 'stt' }] } }, // state 없음
  ];
  for (const c of cases) {
    const r = await bridge.handleLine(line(c));
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.equal(r.error.code, 'E_BAD_REQUEST', JSON.stringify(c));
    assert.equal(r.id, String(c.id));
  }
});

test('모르는 사용량·지연 키와 음수는 거부한다(§11.2·§13-3)', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const bads = [
    { latency: { made_up_ms: 10 } },
    { latency: { total_ms: -1 } },
    { usage: { free_tokens: 5 } },
    { usage: { llm_prompt_tokens: Number.NaN } },
  ];
  for (const extra of bads) {
    const r = await bridge.handleLine(line({
      id: '1', op: 'send', interactionId: 'i_bridge1',
      turn: { input: { kind: 'utterance', text: '홍길동' }, ...extra },
    }));
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.equal(r.error.code, 'E_BAD_REQUEST');
  }
});

test('미지 세션 send 는 오류 응답이지 예외가 아니다', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_없는세션', turn: { input: { kind: 'utterance', text: '여보세요' } },
  }));
  assert.equal(r.ok, false);
  assert.equal(typeof r.error.messageKo, 'string');
});

test('Core 예외의 원문·스택을 호스트에 노출하지 않는다', b, async () => {
  const { bridge } = build({}, {});
  const boom = BR.createBridge({
    adapter: 'callbot', scope: SCOPE,
    core: {
      contractVersion: 1,
      async start() { throw new Error('DB 접속 실패 user=admin password=hunter2 010-1234-5678'); },
      async send() { throw new Error('x'); },
      async end() { throw new Error('x'); },
      reportHealth() {},
    },
  });
  const r = await boom.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_INTERNAL');
  assert.equal(r.error.messageKo.includes('hunter2'), false);
  assert.equal(r.error.messageKo.includes('1234-5678'), false);
  assert.equal('stack' in r.error, false);
  assert.equal(bridge.records.length, 0);
});

test('줄 길이 상한을 준 경우에만 검사한다', b, async () => {
  const big = line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call', presetSlots: { pad: 'ㄱ'.repeat(200) } } });
  const capped = build({ maxLineBytes: 64 }).bridge;
  const uncapped = build().bridge;
  assert.equal((await capped.handleLine(big)).error.code, 'E_TOO_LARGE');
  assert.equal((await uncapped.handleLine(big)).ok, true);
});

// ── 노출 경계 ────────────────────────────────────────────────────────────────

test('기본값에서는 슬롯 값도 상담사용 요약도 나가지 않는다(§2·§10.3)', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const r = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '홍길동' } },
  }));
  assert.deepEqual(r.result.state.slotKeys, ['customer_name']);
  assert.equal(r.result.state.slots, undefined);
  assert.equal(r.result.handoff.summaryMasked, undefined);
  assert.equal(r.result.handoff.summaryAvailable, true); // 있다는 사실은 숨기지 않는다
});

test('이벤트에 실려 나가는 이관 요약도 같은 스위치로 막힌다(§8.1·§10.3)', b, async () => {
  // handoff.requested 이벤트에는 요약 전문(수집 슬롯·직전 대화)이 들어 있다.
  // handoff 만 막고 events 를 흘리면 약속이 배열 하나로 무효가 된다.
  const off = build().bridge;
  const on = build({ includeHandoffSummary: true }).bridge;
  const play = async (bridge) => {
    await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
    return bridge.handleLine(line({
      id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '홍길동' } },
    }));
  };
  const hidden = (await play(off)).result.events.find((e) => e.type === 'handoff.requested');
  assert.equal(hidden.summary_masked, undefined);
  assert.equal(hidden.summary_present, true); // 있었다는 사실까지 감추면 이관 누락을 조사할 수 없다
  const shown = (await play(on)).result.events.find((e) => e.type === 'handoff.requested');
  assert.equal(typeof shown.summary_masked, 'string');
});

test('상담사측 소비자가 명시적으로 켠 경우에만 요약이 나간다', b, async () => {
  const { bridge } = build({ includeHandoffSummary: true, includeSlots: true });
  await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const r = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '홍길동' } },
  }));
  assert.equal(typeof r.result.handoff.summaryMasked, 'string');
  assert.equal(typeof r.result.state.slots.customer_name, 'string');
});

// ── 설정 ────────────────────────────────────────────────────────────────────

test('승인 근거 없는 live 브리지는 만들어지지 않는다 [승인 필요]', b, () => {
  const { core } = build();
  assert.throws(
    () => BR.createBridge({ core, adapter: 'callbot', scope: SCOPE, activation: 'live' }),
    /승인 필요/,
  );
  const ok = BR.createBridge({ core, adapter: 'callbot', scope: SCOPE, activation: 'live', approvalRef: 'TCK-1' });
  assert.equal(ok.activation, 'live');
});

test('잘못된 스코프·상한·능력 선언은 생성 시점에 막는다', b, () => {
  const { core } = build();
  assert.throws(() => BR.createBridge({ core, adapter: 'callbot', scope: { tenantId: '' } }));
  assert.throws(() => BR.createBridge({ core, adapter: 'callbot', scope: SCOPE, maxLineBytes: 0 }), /양의 정수/);
  assert.throws(
    () => BR.createBridge({ core, adapter: 'callbot', scope: SCOPE, capabilities: P.profileFor('chatbot') }),
    /어긋납니다/,
  );
});

test('기록은 op·판정만 남기고 시계 미주입 시 소요를 만들지 않는다(§13-3)', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '1', op: 'hello' }));
  await bridge.handleLine('깨진 줄');
  assert.equal(bridge.records.length, 2);
  assert.equal(bridge.records[0].durationMs, undefined);
  assert.equal(bridge.records[1].ok, false);
  assert.equal(bridge.records[1].errorCode, 'E_BAD_JSON');
  assert.equal(JSON.stringify(bridge.records).includes('안녕'), false);

  let t = 0;
  const timed = build({ clock: () => (t += 5) }).bridge;
  await timed.handleLine(line({ id: '1', op: 'hello' }));
  assert.equal(timed.records[0].durationMs, 5);

  timed.reset();
  assert.equal(timed.records.length, 0);
});

test('기록 상한을 넘으면 오래된 것부터 버린다', b, async () => {
  const { bridge } = build({ maxRecords: 3 });
  for (let i = 0; i < 6; i += 1) await bridge.handleLine(line({ id: `${i}`, op: 'hello' }));
  assert.equal(bridge.records.length, 3);
  assert.deepEqual(bridge.records.map((r) => r.id), ['3', '4', '5']);
});

test('onRecord 훅이 던져도 턴이 죽지 않는다', b, async () => {
  const { bridge } = build({ onRecord() { throw new Error('훅 실패'); } });
  const r = await bridge.handleLine(line({ id: '1', op: 'hello' }));
  assert.equal(r.ok, true);
});

test('참조 Core 픽스처로 브리지가 실제로 돈다', b, async () => {
  const mod = await import('../fixtures/reference-core.mjs');
  const built = mod.default();
  const bridge = BR.createBridge({ core: built.core, scope: built.scope, adapter: 'callbot' });
  const r = await bridge.handleLine(line({
    id: '1', op: 'start', req: { flowId: 'f_reference_voice', entryPoint: 'inbound_call' },
  }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(built.port.activation, 'dry_run');
});
