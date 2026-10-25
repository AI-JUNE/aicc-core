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
  assert.equal(r.result.acceptedKnown, true);
  assert.equal(r.result.registered, true);
  assert.equal(r.result.ignored, 0);
});

// 종전에는 `samples.length` 를 그대로 `accepted` 로 돌려줬다 — 그것은 **브리지가 파싱한 수**이고
// Core 가 접수한 수가 아니다(§13-3). 아래 둘은 그 차이가 가장 비싼 두 상태다: 둘 다 예외가 없고,
// 그 채널은 §9.3 판정에 한 건도 닿지 않은 채로 영구히 운영된다.

test('선언하지 않은 컴포넌트의 샘플은 접수되지 않았다고 적는다 — 파싱한 수를 접수로 적지 않는다(§13-3)', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine(line({
    id: '1', op: 'health',
    report: {
      observedAt: NOW,
      samples: [
        { component: 'stt', state: 'up' },
        { component: 'stt_v2', state: 'down' },   // 등록 시 선언하지 않은 이름(오타)
      ],
    },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.result.offered, 2);
  assert.equal(r.result.accepted, 1);
  assert.equal(r.result.ignored, 1);
  // 호스트가 보낸 이름은 되돌려 적지 않는다(§10.3) — 대신 Core 의 선언 목록으로 맞춰 본다.
  assert.ok(r.result.declared.includes('stt'));
  assert.ok(!JSON.stringify(r.result).includes('stt_v2'));
});

test('등록되지 않은 채널의 보고는 0건 접수로 적힌다 — "올렸다"와 "닿았다"를 구분한다(§9.3)', b, async () => {
  // 브리지는 callbot 인데 Core 에는 chatbot 만 등록된 배치. 종전에는 accepted 가 샘플 수였다.
  const port = BP.createChannelPort({ id: 'chatbot' });
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.chatbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    now: () => NOW,
  });
  const bridge = BR.createBridge({ core, adapter: 'callbot', scope: SCOPE });

  const r = await bridge.handleLine(line({
    id: '1', op: 'health',
    report: { observedAt: NOW, samples: [{ component: 'stt', state: 'down' }] },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.result.registered, false);
  assert.equal(r.result.offered, 1);
  assert.equal(r.result.accepted, 0);
  assert.deepEqual(r.result.declared, []);
});

test('접수 범위를 돌려주지 않는 Core 구현에서는 accepted 를 아예 싣지 않는다(§13-3)', b, async () => {
  // 채널 계약(`ConversationCorePort`)만 구현한 호스트. 모르는 것을 숫자로 적지 않는다.
  let seen = 0;
  const bridge = BR.createBridge({
    adapter: 'callbot', scope: SCOPE,
    core: {
      contractVersion: 1,
      start: async () => { throw new Error('미사용'); },
      send: async () => { throw new Error('미사용'); },
      end: async () => { throw new Error('미사용'); },
      reportHealth: () => { seen += 1; },
    },
  });
  const r = await bridge.handleLine(line({
    id: '1', op: 'health',
    report: { observedAt: NOW, samples: [{ component: 'stt', state: 'up' }] },
  }));
  assert.equal(r.ok, true);
  assert.equal(seen, 1, '보고 자체는 그대로 전달된다');
  assert.equal(r.result.acceptedKnown, false);
  assert.equal(r.result.accepted, undefined);
  assert.equal(r.result.offered, 1);
  assert.match(r.result.reasonKo, /알 수 없습니다/);
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

test('§9.3 판정은 복사해서 내보낸다 — 호스트가 "무엇을 끄라"를 고칠 수 없다', b, async () => {
  const { bridge, core } = build({}, { health: F.createHealthRegistry([{ component: 'tts', state: 'degraded', observedAt: NOW }]) });
  const s = await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  assert.equal(s.result.fallback.mode, 'degraded_ai');
  assert.deepEqual(s.result.fallback.disable, ['voice_synthesis']);
  // 응답 객체를 고쳐도 Core 가 들고 있는 마지막 결과는 그대로다(직렬화 전까지는 고칠 수 있었다).
  s.result.fallback.disable.push('ai_response');
  s.result.fallback.causes.length = 0;
  const kept = core.sessions.get('i_bridge1').lastResult.fallback;
  assert.deepEqual(kept.disable, ['voice_synthesis']);
  assert.equal(kept.causes.length, 1);
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

test('§11.2 end 는 통화 과금 구간을 Core 로 넘기고 실린 사실을 돌려준다', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const r = await bridge.handleLine(line({ id: '1', op: 'end', interactionId: 'i_bridge1', reasonKo: '고객 종료', billableMs: 65000 }));
  assert.equal(r.ok, true);
  assert.equal(r.result.events[0].billable_ms, 65000);
  assert.deepEqual(r.result.billing, { billableMsRecorded: true });
});

test('§11.2 무효한 통화 구간이 와도 end 는 막히지 않는다 — 막히면 세션이 샌다', b, async () => {
  for (const bad of [-1, '65000', null]) {
    const { bridge } = build();
    await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
    const r = await bridge.handleLine(line({ id: '1', op: 'end', interactionId: 'i_bridge1', reasonKo: '고객 종료', billableMs: bad }));
    assert.equal(r.ok, true, JSON.stringify(bad));              // 종료는 어떤 경우에도 성공한다
    assert.equal(r.result.status, 'completed');
    assert.equal('billable_ms' in r.result.events[0], false);
    assert.equal(r.result.billing.billableMsRecorded, false);
  }
});

test('§13-3 billableMs 를 안 보내면 종전과 완전히 같다', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const r = await bridge.handleLine(line({ id: '1', op: 'end', interactionId: 'i_bridge1', reasonKo: '고객 종료' }));
  assert.equal(r.result.billing, undefined);
  assert.equal('billable_ms' in r.result.events[0], false);
});

test('§11.2 과금 기록은 노출 스위치와 무관하게 호스트에 나간다', b, async () => {
  // 감추면 비-Node 호스트는 자기 통화의 실측이 집계에 없다는 사실을 알 길이 없다.
  const { bridge } = build({ includeSlots: false, includeHandoffSummary: false });
  await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const r = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'utterance', text: '홍길동' }, usage: { stt_audio_ms: 800 } },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.result.billing.usageAttached, true);
});

test('§10.1 동의 기록도 노출 스위치와 무관하게 호스트에 나간다 — 주체 참조는 싣지 않는다', b, async () => {
  // 음성 호스트는 "이 통화에서 동의를 받았다"를 증명해야 하고, 필수 동의가 미획득이면
  // 개인정보 조회가 막힌다는 사실을 알아야 한다. 감추면 둘 다 알 길이 없다.
  const CO = await import('../src/consent/executeConsent.ts');
  const store = CO.createMemoryConsentStore();
  const consentFlow = {
    id: 'consent', version: 1, startNodeId: '__consent:recording',
    nodes: {
      '__consent:recording': {
        id: '__consent:recording', kind: 'Confirm', prompt: '통화 녹취에 동의하십니까?', next: 'bye',
      },
      bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
    },
  };
  const { bridge } = build({ includeSlots: false, includeHandoffSummary: false }, {
    flows: R.createMemoryFlowRegistry([consentFlow]),
    consent: {
      policy: {
        tenantId: 'goone', requirements: [{ purpose: 'recording', required: true }],
        version: 2, updatedAt: NOW, updatedBy: 'legal@goone', approved: true,
      },
      records: store,
      subjectRef: () => 'sha256:voice1',
    },
  });
  const s = await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'consent', entryPoint: 'inbound_call' } }));
  assert.deepEqual(s.result.consent.pendingRequired, ['recording']);
  const r = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '네' } },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.consent.recorded, { purpose: 'recording', state: 'granted', policyVersion: 2 });
  assert.equal(r.result.consent.pendingRequired, undefined);
  // 동의 주체 참조(해시여도)는 어떤 경로로도 나가지 않는다(§10.3).
  assert.equal(JSON.stringify(r).includes('sha256:voice1'), false);
  assert.equal(store.list('sha256:voice1').length, 1);
});

test('동의 판정은 호스트가 고칠 수 없다 — 돌려준 배열을 복사해 내보낸다', b, async () => {
  const CO = await import('../src/consent/executeConsent.ts');
  const { bridge, core } = build({}, {
    consent: {
      policy: {
        tenantId: 'goone', requirements: [{ purpose: 'recording', required: true }],
        version: 1, updatedAt: NOW, updatedBy: 'legal@goone', approved: true,
      },
      records: CO.createMemoryConsentStore(),
      subjectRef: () => 'sha256:voice2',
    },
  });
  const s = await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  s.result.consent.pendingRequired.push('marketing');
  const again = core.sessions.get('i_bridge1').lastResult;
  assert.deepEqual(again.consent.pendingRequired, ['recording']);
});

test('§7 5.2 준수 점검 요약도 노출 스위치와 무관하게 호스트에 나간다 — 금칙어 문구는 싣지 않는다', b, async () => {
  // 비-Node 호스트(음성 에이전트)가 자기 통화가 **점검됐는지조차** 알 수 없으면,
  // 고지 누락·녹취 중 마스킹 누락이 가장 먼저 나타나는 채널에서 그 사실이 묻힌다.
  const { bridge } = build({ includeSlots: false, includeHandoffSummary: false }, {
    qa: {
      disclosureMarkers: ['AI 상담'],
      forbiddenPhrases: [{ id: 'f1', phrase: '무조건 승인', severity: 'major', reasonKo: '확정적 표현 금지' }],
    },
  });
  const s = await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  assert.equal(s.result.compliance, undefined);           // 아직 끝나지 않았다
  const e = await bridge.handleLine(line({ id: '1', op: 'end', interactionId: 'i_bridge1', reasonKo: '고객 종료' }));
  assert.equal(e.ok, true);
  assert.equal(e.result.compliance.reviewed, true);
  assert.ok(Array.isArray(e.result.compliance.checked));
  // 고지 설정이 배선되지 않았으므로 고지 항목은 합격이 아니라 skipped 다.
  assert.ok(e.result.compliance.skipped.some((x) => x.ruleId === 'disclosure_missing'));
  // 등록된 금칙어 문구·근거 이벤트 id 는 요약에 담기지 않는다(§10.3).
  assert.equal(JSON.stringify(e.result.compliance).includes('무조건 승인'), false);
  assert.equal(JSON.stringify(e.result.compliance).includes('i_bridge1_e'), false);
});

test('점검 판정은 호스트가 고칠 수 없다 — 돌려준 배열·객체를 복사해 내보낸다', b, async () => {
  const { bridge, core } = build({}, {
    qa: { disclosureMarkers: ['AI 상담'], forbiddenPhrases: [] },
  });
  await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const e = await bridge.handleLine(line({ id: '1', op: 'end', interactionId: 'i_bridge1', reasonKo: '종료' }));
  e.result.compliance.skipped.push({ ruleId: 'pii_exposed', reasonKo: '호스트가 끼워 넣음' });
  e.result.compliance.checked.length = 0;
  e.result.compliance.counts.critical = 99;
  const kept = core.sessions.get('i_bridge1').lastResult.compliance;
  assert.equal(kept.skipped.some((x) => x.reasonKo === '호스트가 끼워 넣음'), false);
  assert.ok(kept.checked.length > 0);
  assert.equal(kept.counts.critical, 0);
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

// ── §5.2 채널 전환 초대 ──────────────────────────────────────────────────────
// 전환 지시는 종전까지 `port.invite` **한 곳에만** 있었다 — 그 경로는 Node 호스트에만 있다.
// 그래서 파이썬 호스트에서는 전환이 조용히 반쪽만 일어났다: `state.channel` 은 화면으로
// 바뀌어 이후 단계가 화면용으로 렌더되는데(통화 중인 고객이 그것을 듣는다) 링크는 아무도
// 보내지 않는다. 고객은 오지 않는 화면을 기다리고, 사다리는 이미 전환을 골랐으므로
// 상담사로 내려가지도 않는다. 어디에서도 예외가 나지 않는다.

const flowRetry = {
  id: 'retry', version: 1, startNodeId: 'ask',
  nodes: { ask: { id: 'ask', kind: 'Collect', slot: 'code', prompt: '고객번호를 말씀해 주세요.' } },
};

/** 전환이 실제로 일어나는 배치: 음성 + 화면 채널 등록 + 전환 배선(토큰 발급). */
async function switchBridge(bridgeOver = {}, { wired = true } = {}) {
  const CS = await import('../src/core/channelSwitch.ts');
  const callbot = BP.createChannelPort({ id: 'callbot' });
  const dars = BP.createChannelPort({ id: 'dars' });
  let n = 0;
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flowRetry]),
    channels: [
      { port: callbot, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 },
      { port: dars, reportsComponents: P.CHANNEL_COMPONENTS.dars, contractVersion: 1 },
    ],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    now: () => NOW,
    newInteractionId: () => 'i_bridge1',
    ...(wired ? {
      channelSwitch: {
        invites: CS.createInviteRegistry(),
        newToken: () => `tk_sw_${++n}`,
        ttlMs: 300000,
        carry: { allow: ['code'] },
        reachable: () => true,
        delivery: 'sms',
      },
    } : {}),
  });
  const bridge = BR.createBridge({ core, adapter: 'callbot', scope: SCOPE, ...bridgeOver });
  await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'retry', entryPoint: 'inbound_call' } }));
  await bridge.handleLine(line({ id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'timeout' } } }));
  const r = await bridge.handleLine(line({ id: '3', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'timeout' } } }));
  return r;
}

test('전환 사실은 노출 스위치와 무관하게 비-Node 호스트까지 간다 — 토큰은 기본적으로 빠진다(§5.2·§10.3)', b, async () => {
  const r = await switchBridge();
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.state.channel, 'visual');

  const s = r.result.switchInvite;
  assert.equal(s.fromChannel, 'voice');
  assert.equal(s.toChannel, 'visual');
  assert.equal(s.ticketIssued, true, '열쇠가 발급됐다는 사실은 감추지 않는다');
  assert.equal(typeof s.expiresAt, 'string');
  // 기본은 끔 — 열쇠는 상담사용 요약과 같은 규칙으로 다룬다.
  assert.equal(s.tokenIncluded, false);
  assert.equal(s.token, undefined);
  assert.equal(JSON.stringify(r.result).includes('tk_sw_1'), false);
});

test('링크를 직접 만드는 소비자가 켜면 토큰이 나간다 — hello 가 그 사실을 알려 준다', b, async () => {
  const r = await switchBridge({ includeSwitchTicket: true });
  assert.equal(r.result.switchInvite.tokenIncluded, true);
  assert.equal(r.result.switchInvite.token, 'tk_sw_1');

  const { bridge } = build({ includeSwitchTicket: true });
  const h = await bridge.handleLine(line({ id: '1', op: 'hello' }));
  assert.equal(h.result.includesSwitchTicket, true);
  assert.equal((await build().bridge.handleLine(line({ id: '1', op: 'hello' }))).result.includesSwitchTicket, false);
});

test('전환 배선이 없으면 "토큰 없는 링크"라는 사실이 호스트에 도착한다(§10.3)', b, async () => {
  const r = await switchBridge({ includeSwitchTicket: true }, { wired: false });
  assert.equal(r.result.switchInvite.ticketIssued, false);
  assert.equal(r.result.switchInvite.tokenless, true);
  assert.equal(r.result.switchInvite.tokenIncluded, false);
  assert.match(r.result.switchInvite.notIssuedKo, /세션의 열쇠/);
});

test('전환이 없는 턴에는 실리지 않는다 — 매 턴 실리면 호스트가 링크를 다시 보낸다', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const r = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '홍길동' } },
  }));
  assert.equal('switchInvite' in r.result, false);
});

test('AI 고지는 문구와 감사 근거가 함께 비-Node 호스트까지 간다(§10.1)', b, async () => {
  // 브리지가 이 둘 중 하나만 흘리면 결함의 모양이 갈린다: 단계가 없으면 **고지가 안 나가고**,
  // 사실만 없으면 호스트가 steps 를 뒤져 감사 기록을 만들게 되어 언어마다 다르게 틀린다(§2).
  const disclosure = {
    tenantId: 'goone', enabled: true, approved: true,
    approvedAt: NOW, approvedBy: 'legal_kim', version: 7, updatedAt: NOW, updatedBy: 'admin_lee',
    channels: { voice: { text: '본 상담은 AI 상담원이 진행합니다.', placement: 'before_first_response' } },
  };
  const { bridge } = build({}, { disclosure });
  const r = await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  assert.equal(r.ok, true);
  assert.equal(r.result.steps[0].nodeId, '__disclosure');
  assert.equal(r.result.steps[0].text, '본 상담은 AI 상담원이 진행합니다.');
  assert.deepEqual(r.result.disclosure, { channel: 'voice', placement: 'before_first_response', configVersion: 7 });
});

test('고지 사실은 노출 스위치와 무관하게 나간다 — 개인정보가 없고 감추면 증명할 길이 없다', b, async () => {
  const { bridge } = build();  // 배선 없음 — 종전과 완전히 같다(§13-3)
  const r = await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  assert.equal(r.result.disclosure, undefined);
  assert.equal(r.result.steps.some((s) => s.nodeId === '__disclosure'), false);
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

test('합류 토큰은 들어오는 방향으로 통과한다 — 전환 배선을 켜도 비-Node 호스트만 막히지 않는다(§5.2)', b, async () => {
  const seen = [];
  const fakeCore = {
    contractVersion: 1,
    async start(req) {
      seen.push(req);
      return { interactionId: 'i_join', state: { flowId: 'billing', flowVersion: 1, channel: 'voice', currentNodeId: null, slots: {}, failCount: 0, turnCount: 0, eventSeq: 0, status: 'running', visited: [] }, steps: [], status: 'running', events: [] };
    },
    async send() { throw new Error('미사용'); },
    async end() { throw new Error('미사용'); },
    reportHealth() {},
  };
  const bridge = BR.createBridge({ core: fakeCore, adapter: 'callbot', scope: SCOPE });
  const r = await bridge.handleLine(line({
    id: '1', op: 'start',
    req: { flowId: 'billing', entryPoint: 'inbound_call', joinInteractionId: 'i_join', joinToken: 'tk_from_link' },
  }));
  assert.equal(r.ok, true);
  assert.equal(seen[0].joinInteractionId, 'i_join');
  assert.equal(seen[0].joinToken, 'tk_from_link');
  // 응답에는 토큰을 되돌려주지 않는다 — 열쇠를 로그로 흘리지 않는다(§10.3).
  assert.equal(JSON.stringify(r).includes('tk_from_link'), false);
});

// ── 이관 목적지 판정(§9.3) ───────────────────────────────────────────────────
// 투영이 `placement` 를 버리던 동안, 비-Node 호스트는 **큐에 들어가지 못한 고객에게도**
// "상담사를 연결해 드리겠습니다"를 안내했다. 대안으로 간 건은 놓을 큐 id 를 들고 있지 않아
// `queue` 가 비고, 그 모양은 "큐를 선언하지 않은 이관"과 구분되지 않는다.

const QUEUES = [
  { id: 'q_care', tenantId: 'goone', titleKo: '케어', skills: [], closedAction: 'callback',
    maxWaiting: 1, overflowQueueId: 'q_backup' },
  { id: 'q_backup', tenantId: 'goone', titleKo: '예비', skills: [], closedAction: 'voicemail' },
];
const routing = (snapshots) => ({
  config: { tenantId: 'goone', queues: QUEUES, rules: [], defaultQueueId: 'q_care' },
  snapshots: () => snapshots,
});
const toAgent = async (bridge) => {
  await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  return bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '홍길동' } },
  }));
};

test('큐에 들어간 건: 놓을 수 있는 큐 id 와 오버플로 사실이 호스트에 나간다', b, async () => {
  const { bridge } = build({}, {
    routing: routing([
      { queueId: 'q_care', waiting: 1, availableAgents: 2, observedAt: NOW },   // maxWaiting 1 → 꽉 참
      { queueId: 'q_backup', waiting: 0, availableAgents: 1, observedAt: NOW },
    ]),
  });
  const r = await toAgent(bridge);
  assert.equal(r.ok, true);
  const p = r.result.handoff.placement;
  assert.equal(p.placement, 'queued');
  assert.equal(p.queueId, 'q_backup', '꽉 찬 큐를 안내하면 "특정 시간대에만 대기가 길다"가 된다');
  assert.equal(p.overflowed, true);
  assert.equal(p.requestedQueueId, 'q_care');
  assert.ok(Array.isArray(p.path));
});

test('대안으로 간 건: action 이 나가고 호스트가 상담사 연결을 안내하지 않을 근거가 생긴다(§9.3)', b, async () => {
  const { bridge } = build({}, { routing: routing([]) });   // 상태 미확인 → 보수적으로 닫힘
  const r = await toAgent(bridge);
  assert.equal(r.ok, true);
  const p = r.result.handoff.placement;
  assert.equal(p.placement, 'alternative');
  assert.equal(p.action, 'callback');
  assert.equal(p.cause, 'closed');
  // **놓을 큐 id 가 아예 없다.** 있으면 호스트가 그 큐로 안내하게 된다.
  assert.equal(p.queueId, undefined);
  // 그런데 `handoff.queue` 는 시나리오가 적어 둔 큐 그대로다 — 그래서 **그 필드만 보면
  // 안 된다**. 이것이 placement 가 나가야 하는 이유 자체다(큐에 못 들어간 고객과 그 큐로
  // 들어간 고객이 같은 모양으로 보인다).
  assert.equal(r.result.handoff.queue, 'q_care');
});

test('목적지를 정하지 못한 건: 설정 결함이 code·issues 로 드러난다 — "대안"으로 뭉개지 않는다', b, async () => {
  // 시간대가 빠진 시각(호스트가 로컬 시계를 주입한 경우)은 영업시간·신선도 판정을 불가능하게
  // 만든다. 열린 것으로 추정하지 않으므로 목적지 자체가 서지 않는다.
  const { bridge } = build({}, {
    now: () => '2026-09-06 09:00:00',
    routing: routing([{ queueId: 'q_care', waiting: 0, availableAgents: 2, observedAt: NOW }]),
  });
  const r = await toAgent(bridge);
  assert.equal(r.ok, true);
  const p = r.result.handoff.placement;
  assert.equal(p.placement, 'unavailable');
  assert.equal(p.code, 'E_CLOCK_INVALID');
  assert.ok(Array.isArray(p.issues));
  assert.equal(p.queueId, undefined);
  assert.equal(p.action, undefined, '설정 결함에 대안을 지어내지 않는다(§13-3)');
});

test('판정 안에는 상담사용 요약이 **어느 경우에도** 없다 — 스위치가 한 곳이어야 한다(§2·§10.3)', b, async () => {
  for (const include of [false, true]) {
    const { bridge } = build({ includeHandoffSummary: include }, { routing: routing([]) });
    const r = await toAgent(bridge);
    const p = r.result.handoff.placement;
    assert.equal('summaryMasked' in p, false, `includeHandoffSummary=${include}`);
    assert.equal(p.summaryPresent, true, '있었다는 사실은 숨기지 않는다');
    // 켠 경우에만 요약이 나가고, 그 자리는 handoff.summaryMasked 하나다.
    assert.equal(typeof r.result.handoff.summaryMasked, include ? 'string' : 'undefined');
  }
});

test('판정은 호스트가 고칠 수 없다 — 돌려준 배열을 복사해 내보낸다', b, async () => {
  const { bridge, core } = build({}, { routing: routing([]) });
  const r = await toAgent(bridge);
  r.result.handoff.placement.warnings.push('호스트가 끼워 넣음');
  r.result.handoff.placement.path.length = 0;
  const kept = core.sessions.get('i_bridge1').lastResult.handoff.placement;
  assert.equal(kept.warnings.includes('호스트가 끼워 넣음'), false);
  assert.ok(kept.path.length > 0);
});

test('라우팅을 주지 않으면 placement 자체가 없다 — 종전과 완전히 같다(§13-3)', b, async () => {
  const { bridge } = build();
  const r = await toAgent(bridge);
  assert.equal(r.result.handoff.placement, undefined);
  assert.equal(r.result.handoff.queue, 'q_care');
});

// ── Api 대기(§6.1) ───────────────────────────────────────────────────────────

test('Api 대기 중이면 그 사실이 나간다 — 다음 입력이 발화가 아니라 connectorResult 다', b, async () => {
  const apiFlow = {
    id: 'lookup', version: 1, startNodeId: 'ask',
    nodes: {
      ask: { id: 'ask', kind: 'Collect', slot: 'cno', prompt: '고객번호를 말씀해 주세요.', next: 'call' },
      call: { id: 'call', kind: 'Api', connectorId: 'c_balance', waitText: '조회 중입니다.', next: 'bye' },
      bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
    },
  };
  const { bridge } = build({}, { flows: R.createMemoryFlowRegistry([apiFlow]) });
  await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'lookup', entryPoint: 'inbound_call' } }));
  const w = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '12345' } },
  }));
  assert.equal(w.result.state.pendingConnectorId, 'c_balance');
  assert.ok(w.result.steps.some((s) => s.awaitConnectorId === 'c_balance'));

  // 대기 중에 발화를 보내면 steps·events 가 0건이다(§6.1 구간) — 그래도 **대기 사실은 남는다**.
  // 이 한 칸이 없던 동안 호스트는 무음과 "아무 일도 없었음"을 구분할 수 없었다.
  const silent = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '여보세요' } },
  }));
  assert.equal(silent.ok, true);
  assert.equal(silent.result.steps.length, 0);
  assert.equal(silent.result.events.length, 0);
  assert.equal(silent.result.state.pendingConnectorId, 'c_balance');

  const done = await bridge.handleLine(line({
    id: '3', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'connectorResult', ok: true, slots: { balance: '12000' } } },
  }));
  assert.equal(done.result.state.pendingConnectorId, undefined, '결과를 받았는데 대기가 남으면 호스트가 또 부른다');
  assert.ok(done.result.steps.some((s) => s.nodeId === 'bye'));
});

test('Api 노드가 없는 시나리오에는 대기 필드가 붙지 않는다(§13-3)', b, async () => {
  const { bridge } = build();
  const s = await bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  assert.equal('pendingConnectorId' in s.result.state, false);
});

// ── 미인식 입력(§5.1·§6.2) ───────────────────────────────────────────────────
//
// `FlowInput` 은 다섯 종류인데 와이어는 네 종류만 받고 있었다 — 즉 **미인식만** Node 호스트에서는
// 보낼 수 있고 비-Node 호스트에서는 보낼 수 없었다. 남은 두 길이 전부 나쁘다는 것이 요점이다.

async function started(bridge) {
  return bridge.handleLine(line({ id: '0', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
}

test('미인식 턴을 와이어로 올릴 수 있고, §5.1 실패 판정이 실제로 돈다', b, async () => {
  const { bridge } = build();
  await started(bridge);
  const r = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'unrecognized', text: '카드를 잃어버렸어요' } },
  }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.state.slotKeys.includes('customer_name'), false,
    '미인식 발화가 슬롯 값으로 저장되면 고객은 엉뚱한 안내를 듣고 그 사실은 어디에도 남지 않는다');
  assert.equal(r.result.state.failCount, 1);
});

test('같은 발화를 utterance 로 올리면 슬롯 값이 된다 — 그래서 바꿔 보내면 안 된다', b, async () => {
  const { bridge } = build();
  await started(bridge);
  const r = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'utterance', text: '카드를 잃어버렸어요' } },
  }));
  assert.equal(r.result.state.slotKeys.includes('customer_name'), true);
  assert.equal(r.result.state.failCount, 0, '예외도 재프롬프트도 없다 — 이것이 조용한 쪽의 결말이다');
});

test('인식기가 아무 말도 돌려주지 못한 턴(빈 text)도 미인식으로 받는다', b, async () => {
  const { bridge } = build();
  await started(bridge);
  const r = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'unrecognized', text: '' } },
  }));
  assert.equal(r.ok, true, '거절하면 호스트가 timeout 으로 바꿔 보내고, 말을 한 고객이 침묵으로 집계된다');
  assert.equal(r.result.state.failCount, 1);
});

test('미인식 턴의 실측도 실린다 — 신뢰도는 실을 자리가 없어 사실로 남는다', b, async () => {
  const { bridge, core } = build();
  await started(bridge);
  const r = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1',
    turn: {
      input: { kind: 'unrecognized', text: '어' },
      latency: { stt_ms: 120 }, usage: { stt_audio_ms: 2000 }, confidence: 0.3,
    },
  }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const turn = r.result.events.find((e) => e.type === 'turn.completed');
  assert.deepEqual(turn.latency_ms, { stt_ms: 120 });
  assert.ok(core.warnings().some((i) => i.code === 'W_TURN_INPUT'),
    '실을 자리가 없는 선언은 조용히 버리지 않고 적는다(§13-3)');
});

test('text 가 문자열이 아니면 그 줄만 거절된다(실패 경로)', b, async () => {
  const { bridge } = build();
  await started(bridge);
  const r = await bridge.handleLine(line({
    id: '1', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'unrecognized', text: 3 } },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_BAD_REQUEST');
  const ok = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'unrecognized', text: '어' } },
  }));
  assert.equal(ok.ok, true, '거절된 줄이 다음 턴을 막지 않는다');
});

// ── 헬스 상태 목록은 한 곳에서 온다(§2·§9.3) ────────────────────────────────

test('아는 헬스 상태를 모두 받는다 — 목록은 ops/fallback.ts 하나다', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine(line({
    id: '1', op: 'health',
    report: { observedAt: NOW, samples: F.HEALTH_STATES.map((state) => ({ component: 'stt', state })) },
  }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.offered, F.HEALTH_STATES.length);
});

test('모르는 상태는 거절한다 — 상태 없는 샘플을 up 으로 읽으면 장애가 정상으로 집계된다(실패 경로)', b, async () => {
  const { bridge } = build();
  for (const state of ['draining', '', 'UP', 1, null]) {
    const r = await bridge.handleLine(line({
      id: '1', op: 'health', report: { observedAt: NOW, samples: [{ component: 'stt', state }] },
    }));
    assert.equal(r.ok, false, `거절되지 않았다: ${String(state)}`);
    assert.equal(r.error.code, 'E_BAD_REQUEST');
  }
});

// ── 계약 버전 불일치(§2) ─────────────────────────────────────────────────────

test('Core 계약 버전이 브리지와 다르면 기동을 거절한다 — Node 경로와 같은 판정이다', b, () => {
  const { core } = build();
  const wrap = (version) => ({
    contractVersion: version,
    start: (r) => core.start(r), send: (i, t) => core.send(i, t),
    end: (i, r, x) => core.end(i, r, x), reportHealth: (r) => core.reportHealth(r),
  });
  assert.throws(
    () => BR.createBridge({ core: wrap(99), adapter: 'callbot', scope: SCOPE }),
    (e) => e.name === 'BridgeConfigError' && /계약 버전 불일치/.test(e.message),
  );
  // 버전이 맞으면 종전과 완전히 같다.
  assert.ok(BR.createBridge({ core: wrap(core.contractVersion), adapter: 'callbot', scope: SCOPE }));
});

// ── §6.1 조회 결과: 어느 대기의 답인가, 반영은 됐는가 ────────────────────────
//
// 와이어에는 "조회 결과를 보냈다"만 있었고 **어느 대기에 대한 답인지도, 반영됐는지도** 실릴
// 자리가 없었다. 둘 다 증상이 조용하다: 앞 조회의 결과가 재전송되면 뒤 조회의 답으로 적용되고
// (고객은 다른 조회의 값으로 채워진 안내를 듣는다), 반영되지 않은 결과는 `ok` 로 돌아가
// 호스트가 다음 발화를 기다리는 동안 통화는 무음으로 멈춘다.

const chainFlow = {
  id: 'chain', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: 'account_no', prompt: '계좌번호를 말씀해 주세요.', next: 'verify' },
    verify: { id: 'verify', kind: 'Api', connectorId: 'c_verify', waitText: '확인 중입니다.', next: 'lookup' },
    lookup: { id: 'lookup', kind: 'Api', connectorId: 'c_balance', waitText: '조회 중입니다.', next: 'tell' },
    tell: { id: 'tell', kind: 'Say', text: '조회가 끝났습니다.' },
  },
};

async function atChainWait() {
  const { bridge } = build({}, { flows: R.createMemoryFlowRegistry([chainFlow]) });
  await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'chain', entryPoint: 'inbound_call' } }));
  const w = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_bridge1', turn: { input: { kind: 'utterance', text: '110-1234' } },
  }));
  assert.equal(w.result.state.pendingConnectorId, 'c_verify');
  return { bridge };
}

test('§6.1 조회 결과의 반영 사실이 와이어로 나간다 — 대기가 또 서면 그 id 도 함께', b, async () => {
  const { bridge } = await atChainWait();
  const r = await bridge.handleLine(line({
    id: '3', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'connectorResult', ok: true, connectorId: 'c_verify', slots: { verified: 'Y' } } },
  }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.connector.resultApplied, true);
  assert.equal(r.result.connector.pendingConnectorId, 'c_balance');
  assert.equal(r.result.connector.reasonKo, undefined);
});

test('어긋난 커넥터 선언은 반영되지 않고 사유가 와이어로 돌아온다(실패 경로)', b, async () => {
  const { bridge } = await atChainWait();
  const r = await bridge.handleLine(line({
    id: '3', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'connectorResult', ok: true, connectorId: 'c_balance', slots: { balance: '0' } } },
  }));
  // 거절이 아니다 — 통화는 계속되고 대기는 그대로 서 있다(§9.3).
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.connector.resultApplied, false);
  assert.match(r.result.connector.reasonKo, /c_verify/);
  assert.equal(r.result.state.pendingConnectorId, 'c_verify');
  assert.deepEqual(r.result.state.slotKeys, ['account_no'], '반영하지 않은 결과의 슬롯이 들어갔다');
});

test('빈 커넥터 선언은 선언이 아니다 — 받지 않는다(§13-3)', b, async () => {
  const { bridge } = await atChainWait();
  const r = await bridge.handleLine(line({
    id: '3', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'connectorResult', ok: true, connectorId: '' } },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_BAD_REQUEST');
  // 선언하지 않으면 종전과 완전히 같다 — 그 턴은 반영된다.
  const plain = await bridge.handleLine(line({
    id: '4', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'connectorResult', ok: true } },
  }));
  assert.equal(plain.result.connector.resultApplied, true);
});

test('호스트가 고친 반영 사실이 Core 의 판정으로 남지 않는다 — 투영은 복사다', b, async () => {
  const { bridge } = await atChainWait();
  const r = await bridge.handleLine(line({
    id: '3', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'connectorResult', ok: true, connectorId: 'c_balance' } },
  }));
  r.result.connector.resultApplied = true;             // 호스트가 고쳐 본다
  const again = await bridge.handleLine(line({
    id: '4', op: 'send', interactionId: 'i_bridge1',
    turn: { input: { kind: 'connectorResult', ok: true, connectorId: 'c_balance' } },
  }));
  assert.equal(again.result.connector.resultApplied, false, 'Core 의 판정이 호스트 쪽 수정에 흔들렸다');
});
