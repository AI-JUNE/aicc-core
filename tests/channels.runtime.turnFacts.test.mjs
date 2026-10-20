// 런타임 진입점 세 곳의 비대칭 — 다른 경로에는 다 있는 것이 한 곳에만 없었다.
//
// 1) **첫 턴에 이관되는 통화의 전문이 두 벌 쌓인다.** `send` 는 이관 턴에서 전문을 다시
//    기록하지 않는데(`attachSummary` 가 스스로 기록한다) `start` 만 둘 다 했다. 예외는 없고
//    증상은 상담사 화면에만 나타난다 — 요약의 "직전 대화"에 같은 줄이 두 번, 턴 수가 2배다.
//    §2 가 막으려던 "아까 다 말했는데요"를 막는 그 화면이 거짓을 적는다.
// 2) **합류 턴의 결과가 세션 저장소에 저장되지 않는다.** `start`·`send`·`end` 는 결과를
//    조립한 **뒤에** `put` 하는데 `join` 만 그 앞에서 했다. 인메모리 구현에서는 같은 객체라
//    보이지 않고, 영속(직렬화) 저장소에서는 합류 전 결과가 남아 다음 호출의 답으로 나간다.
// 3) **끝난 상담에 합류하면 §8.1 원장에 종료 이후 발화가 붙는다.** 전환 링크는 고객 손에
//    남으므로 통화가 끊긴 뒤 눌리는 일이 흔하다. `send` 는 그 경로에서 새 이벤트를 만들지
//    않는데 `join` 은 만들었고, 하필 그 발화가 §10.1 AI 고지이며 점검은 이미 잠겨 있다.
// 4) **턴 단위로 선언된 실측이 경계에서 사라진다.** `ChannelTurnInput.latency`·`confidence` 는
//    계약에 있고 브리지가 형태까지 검사해 채우는데(파이썬 참조 클라이언트가 그 모양이다)
//    런타임이 그 둘을 한 번도 읽지 않았다 — §13 지연 지표에 표본이 한 건도 없고,
//    `minConfidence` 를 선언한 테넌트에서도 저신뢰 인식이 확신한 답으로 확정된다.
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

const NOW = '2026-10-20T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };
const GREET = '안녕하세요, 고운 고객센터입니다.';

/** 첫 턴에 바로 상담사로 가는 시나리오 — 대표번호 직결의 모양이다. */
const flowDirect = {
  id: 'direct', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: GREET, next: 'to_agent' },
    to_agent: { id: 'to_agent', kind: 'Transfer', queue: 'q_care', reason: 'policy' },
  },
};

/** 입력을 기다리는 평범한 시나리오. */
const flowAsk = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: GREET, next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.' },
  },
};

function fakePort(id = 'callbot') {
  const log = [];
  return {
    id, log,
    capabilities: P.profileFor(id),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue, summary) { log.push(['transfer', iid, queue, summary]); },
    async invite() {},
    async end(iid, reason) { log.push(['end', iid, reason]); },
  };
}

/**
 * 직렬화하는 세션 저장소. 영속 구현(§6.2)의 성질을 그대로 흉내 낸다 —
 * `put` 뒤의 변형은 저장되지 않는다. 인메모리 구현에서는 그 차이가 보이지 않는다.
 */
function serializingStore() {
  const map = new Map();
  const copy = (v) => JSON.parse(JSON.stringify(v));
  return {
    get: (id) => (map.has(id) ? copy(map.get(id)) : undefined),
    put: (r) => { map.set(r.interactionId, copy(r)); },
    remove: (id) => { map.delete(id); },
    ids: () => [...map.keys()],
    /** 검사용 — 저장소에 실제로 남은 것을 본다. */
    raw: (id) => (map.has(id) ? copy(map.get(id)) : undefined),
  };
}

/** §10.1 AI 고지 설정 — 합류한 매체에서 **새 발화**가 나가는 유일한 경로다. */
const DISC = () => ({
  tenantId: 'goone', enabled: true, approved: true,
  approvedAt: '2026-08-20T00:00:00.000Z', approvedBy: 'legal_kim',
  version: 4, updatedAt: '2026-08-19T00:00:00.000Z', updatedBy: 'admin_lee',
  channels: {
    voice: { text: '본 상담은 AI 상담원이 진행합니다.', placement: 'before_first_response' },
    visual: { text: '이 화면은 AI가 안내합니다.', placement: 'persistent_banner' },
    chat: { text: 'AI 상담원이 답변드립니다.', placement: 'session_start' },
  },
});

function build({ flows = [flowAsk], ports = [fakePort()], minConfidence, sessions, disclosure } = {}) {
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 400 }), releaseKeyOnSinkFailure: false,
  });
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry(flows),
    channels: ports.map((port) => ({ port, reportsComponents: P.CHANNEL_COMPONENTS[port.id], contractVersion: 1 })),
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    bus, now: () => NOW,
    newInteractionId: () => 'i_tf1',
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(disclosure !== undefined ? { disclosure } : {}),
  });
  return { core, bus, collector, ports };
}

const reqOf = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing', ...over });
const occurrences = (text, needle) => text.split(needle).length - 1;
const customerTurn = (events) => events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');

// ── 1) 첫 턴 이관의 전문 이중 기록 ───────────────────────────────────────────

test('첫 턴에 이관되는 통화의 요약은 같은 발화를 한 번만 적는다(§2)', b, async () => {
  const { core } = build({ flows: [flowDirect] });
  const r = await core.start(reqOf({ flowId: 'direct' }));
  assert.equal(r.status, 'transferred');
  const summary = r.handoff.summaryMasked;
  assert.ok(summary, '이관 요약이 없다');
  assert.equal(occurrences(summary, GREET), 1, `같은 발화가 두 번 적혔다:\n${summary}`);
});

test('요약의 턴 수가 실제 발화 수와 같다 — 2배로 적으면 §13-3 실측이 깨진다', b, async () => {
  const { core } = build({ flows: [flowDirect] });
  const r = await core.start(reqOf({ flowId: 'direct' }));
  // 안내 1 + 이관 안내 1 = 2턴. 전문을 두 벌 쌓으면 4턴으로 적힌다.
  assert.match(r.handoff.summaryMasked, /진행: 2턴/);
});

test('원장의 turn.completed 건수는 그대로다 — 기록 중복은 세션 쪽에서만 일어났다(§8.1)', b, async () => {
  const { core, collector } = build({ flows: [flowDirect] });
  await core.start(reqOf({ flowId: 'direct' }));
  const turns = collector.events.filter((e) => e.type === 'turn.completed');
  assert.equal(turns.length, 2);
});

test('이관이 없는 start 는 종전대로 전문을 기록한다 — 턴 수가 원장과 일치한다', b, async () => {
  const { core, collector } = build({ flows: [flowAsk] });
  await core.start(reqOf());
  // 재시도 한도까지 실패시켜 이관으로 보낸다(§5.1 사다리).
  await core.send('i_tf1', { input: { kind: 'timeout' } });
  await core.send('i_tf1', { input: { kind: 'timeout' } });
  const r = await core.send('i_tf1', { input: { kind: 'timeout' } });
  assert.equal(r.status, 'transferred');
  // start 가 기록을 빠뜨리면 요약 턴 수가 원장보다 적고, 두 벌 쌓으면 많아진다.
  const ledgerTurns = collector.events.filter((e) => e.type === 'turn.completed').length;
  assert.ok(ledgerTurns > 2, '턴이 쌓이지 않았다');
  assert.match(r.handoff.summaryMasked, new RegExp(`진행: ${ledgerTurns}턴`));
});

// ── 2) 합류 턴 결과의 저장 ───────────────────────────────────────────────────

test('합류 턴의 결과가 세션 저장소에 저장된다 — 영속 저장소에서만 드러나는 비대칭', b, async () => {
  const sessions = serializingStore();
  const { core } = build({ flows: [flowAsk], ports: [fakePort(), fakePort('dars')], sessions });
  await core.start(reqOf());
  const joined = await core.start(reqOf({ adapter: 'dars', joinInteractionId: 'i_tf1' }));
  assert.equal(joined.state.channel, 'visual');
  const stored = sessions.raw('i_tf1');
  assert.ok(stored, '세션이 저장되지 않았다');
  // 합류 전 결과가 남아 있으면 다음 호출의 답으로 **다른 매체의 결과**가 나간다(§5.2).
  assert.equal(stored.lastResult.state.channel, 'visual');
});

test('합류 뒤에도 세션 상태는 종전대로 저장된다(채널 목록·현재 채널)', b, async () => {
  const sessions = serializingStore();
  const { core } = build({ flows: [flowAsk], ports: [fakePort(), fakePort('dars')], sessions });
  await core.start(reqOf());
  await core.start(reqOf({ adapter: 'dars', joinInteractionId: 'i_tf1' }));
  const stored = sessions.raw('i_tf1');
  assert.deepEqual(stored.channels, ['voice', 'visual']);
  assert.equal(stored.state.channel, 'visual');
});

// ── 3) 끝난 상담에는 합류하지 않는다(§5.2·§8.1) ──────────────────────────────

test('종료된 세션에 합류하면 거절한다 — 종료 이후 발화를 원장에 더하지 않는다', b, async () => {
  const { core } = build({ flows: [flowAsk], ports: [fakePort(), fakePort('dars')] });
  await core.start(reqOf());
  await core.end('i_tf1', '고객 종료');
  await assert.rejects(
    () => core.start(reqOf({ adapter: 'dars', joinInteractionId: 'i_tf1' })),
    /합류 거부[\s\S]*이미 끝난 상담/,
  );
});

test('이관으로 끝난 세션에도 합류하지 않는다 — AI 세션의 끝은 끝이다', b, async () => {
  const { core } = build({ flows: [flowDirect], ports: [fakePort(), fakePort('dars')] });
  const r = await core.start(reqOf({ flowId: 'direct' }));
  assert.equal(r.status, 'transferred');
  await assert.rejects(
    () => core.start(reqOf({ adapter: 'dars', flowId: 'direct', joinInteractionId: 'i_tf1' })),
    /합류 거부/,
  );
});

test('거절된 합류는 원장에 아무 이벤트도 더하지 않는다(§8.1)', b, async () => {
  // 고지를 배선해야 이 공백의 실제 피해가 재현된다 — 합류가 만드는 새 발화는 §10.1 고지이고,
  // 그 발화가 `session.ended` 뒤에 붙으면 추가 전용 원장에서 지울 수 없다.
  const { core, collector } = build({ flows: [flowAsk], ports: [fakePort(), fakePort('dars')], disclosure: DISC() });
  await core.start(reqOf());
  await core.end('i_tf1', '고객 종료');
  const before = collector.events.length;
  await core.start(reqOf({ adapter: 'dars', joinInteractionId: 'i_tf1' })).catch(() => {});
  assert.equal(collector.events.length, before);
  // 마지막 이벤트는 여전히 세션 종료다 — 그 뒤에 발화가 붙지 않았다.
  assert.equal(collector.events[collector.events.length - 1].type, 'session.ended');
});

test('진행 중인 세션 합류는 종전과 완전히 같다(§13-3)', b, async () => {
  const { core } = build({ flows: [flowAsk], ports: [fakePort(), fakePort('dars')] });
  await core.start(reqOf());
  const joined = await core.start(reqOf({ adapter: 'dars', joinInteractionId: 'i_tf1' }));
  assert.equal(joined.interactionId, 'i_tf1');
  assert.equal(joined.state.channel, 'visual');
  assert.equal(joined.status, 'running');
});

// ── 4) 턴 단위로 선언된 실측(§13-3 응답시간·§5.1 신뢰도) ─────────────────────

test('턴 단위 latency 가 §8.1 원장에 실린다 — 지금까지 경계에서 사라졌다', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', {
    input: { kind: 'utterance', text: '홍길동' },
    latency: { total_ms: 1240, stt_ms: 310 },
  });
  const t = customerTurn(r.events);
  assert.ok(t, '고객 발화 이벤트가 없다');
  assert.deepEqual(t.latency_ms, { total_ms: 1240, stt_ms: 310 });
});

test('선언이 없으면 종전과 완전히 같다 — 실측을 만들어 넣지 않는다(§13-3)', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.deepEqual(customerTurn(r.events).latency_ms, {});
  assert.deepEqual(core.warnings().filter((w) => w.code === 'W_TURN_INPUT'), []);
});

test('입력 쪽 선언은 그대로 통한다 — 두 경로가 같은 자리에 도착한다', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', { input: { kind: 'utterance', text: '홍길동', latency: { total_ms: 900 } } });
  assert.deepEqual(customerTurn(r.events).latency_ms, { total_ms: 900 });
});

test('두 선언이 다른 키를 채우면 합쳐진다', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', {
    input: { kind: 'utterance', text: '홍길동', latency: { stt_ms: 300 } },
    latency: { total_ms: 1000 },
  });
  assert.deepEqual(customerTurn(r.events).latency_ms, { stt_ms: 300, total_ms: 1000 });
});

test('같은 키가 어긋나면 고르지 않는다 — 입력 쪽을 두고 사실을 적는다(§2)', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', {
    input: { kind: 'utterance', text: '홍길동', latency: { total_ms: 2000 } },
    latency: { total_ms: 1000 },
  });
  assert.deepEqual(customerTurn(r.events).latency_ms, { total_ms: 2000 });
  const w = core.warnings().find((x) => x.code === 'W_TURN_INPUT');
  assert.ok(w, '어긋남이 조용히 지나갔다');
  assert.match(w.messageKo, /total_ms/);
});

test('같은 값이면 어긋남이 아니다 — 해당 없는 경고는 진짜 신호를 묻는다', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  await core.send('i_tf1', {
    input: { kind: 'utterance', text: '홍길동', latency: { total_ms: 1000 } },
    latency: { total_ms: 1000 },
  });
  assert.equal(core.warnings().some((x) => x.code === 'W_TURN_INPUT'), false);
});

test('턴 단위 confidence 가 §5.1 신뢰도 조건을 지난다 — 저신뢰가 확정되지 않는다', b, async () => {
  const { core } = build({ minConfidence: 0.7 });
  await core.start(reqOf());
  const r = await core.send('i_tf1', { input: { kind: 'utterance', text: '홍길동' }, confidence: 0.2 });
  // 저신뢰는 수락되지 않는다 — 슬롯이 채워지면 고객이 말한 적 없는 값이 확정된 것이다.
  assert.equal(r.state.slots.customer_name, undefined);
  assert.equal(r.state.failCount, 1);
  assert.equal(r.state.lastFailureReason, 'low_confidence');
  // 신뢰도는 원장에도 남는다(§7 품질 지표).
  assert.equal(customerTurn(r.events).confidence, 0.2);
});

test('임계값을 선언하지 않은 테넌트는 종전과 같다 — 게이팅하지 않는다(§13-3)', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', { input: { kind: 'utterance', text: '홍길동' }, confidence: 0.2 });
  assert.equal(r.state.slots.customer_name, '홍길동');
});

test('충분한 신뢰도는 종전대로 수락된다', b, async () => {
  const { core } = build({ minConfidence: 0.7 });
  await core.start(reqOf());
  const r = await core.send('i_tf1', { input: { kind: 'utterance', text: '홍길동' }, confidence: 0.95 });
  assert.equal(r.state.slots.customer_name, '홍길동');
});

test('신뢰도 선언이 어긋나면 입력 쪽을 두고 사실을 적는다', b, async () => {
  const { core } = build({ minConfidence: 0.7 });
  await core.start(reqOf());
  const r = await core.send('i_tf1', {
    input: { kind: 'utterance', text: '홍길동', confidence: 0.95 },
    confidence: 0.2,
  });
  assert.equal(r.state.slots.customer_name, '홍길동');
  assert.ok(core.warnings().some((x) => x.code === 'W_TURN_INPUT' && /신뢰도/.test(x.messageKo)));
});

test('무입력 턴의 선언은 실을 자리가 없다 — 조용히 버리지 않고 적는다', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', { input: { kind: 'timeout' }, latency: { total_ms: 8000 } });
  assert.deepEqual(customerTurn(r.events).latency_ms, {});
  const w = core.warnings().find((x) => x.code === 'W_TURN_INPUT');
  assert.ok(w);
  assert.match(w.messageKo, /실을 자리가 없습니다/);
});

test('DTMF 에는 신뢰도 칸이 없다 — 싣지 않았다는 사실을 적고 latency 는 그대로 싣는다', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', {
    input: { kind: 'dtmf', digits: '1' },
    latency: { total_ms: 500 },
    confidence: 0.9,
  });
  assert.deepEqual(customerTurn(r.events).latency_ms, { total_ms: 500 });
  assert.equal(customerTurn(r.events).confidence, undefined);
  assert.ok(core.warnings().some((x) => x.code === 'W_TURN_INPUT' && /신뢰도 칸이 없어/.test(x.messageKo)));
});

test('모르는 키는 싣지 않는다 — 정체불명 필드가 지연 지표에 쌓이지 않게(§13-3)', b, async () => {
  const { core } = build();
  await core.start(reqOf());
  const r = await core.send('i_tf1', {
    input: { kind: 'utterance', text: '홍길동' },
    latency: { total_ms: 700, made_up_ms: 1 },
  });
  assert.deepEqual(customerTurn(r.events).latency_ms, { total_ms: 700 });
});

test('판정을 복사하지 않는다 — 이 경로에 임계값·사다리 이름이 없다(§2)', b, async () => {
  if (!R) return;
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/channels/runtime.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function applyTurnFacts'), src.indexOf('function endBillingNote'));
  // 신뢰도 판정은 `classifyFailure`·`confidenceOk` 하나이고, 여기서는 값을 옮기기만 한다.
  assert.equal(/classifyFailure|decideFallback|minConfidence/.test(fn), false);
});
