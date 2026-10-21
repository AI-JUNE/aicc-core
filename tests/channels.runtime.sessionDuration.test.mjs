// §8.1 `session.ended.duration_ms` — 두 소비자가 읽도록 만들어져 있는데 쓰는 코드가 0줄이었다.
//
// `reports/aggregate.ts` 는 `durationMs` 표본과 `sessionsMissingDuration` 을 세고,
// `portal/executeInteractions.ts` 는 행마다 `durationMs` 를 싣고 없으면 거부·누락으로 가른다.
// 그런데 그 필드를 **채우는 코드가 저장소 어디에도 없었다** — 즉 두 화면 모두 통화 시간이
// 언제나 비어 있고, 전건이 "아무도 재지 않았다"로 집계됐다. `interactionQuery` 의
// 정렬 키 `duration_ms` 는 모든 행을 같은 값(-1)으로 보아 **정렬 자체가 무의미**했다.
//
// 증상이 조용한 이유: 예외가 아니고, 통화도 멀쩡하고, 집계 필드는 **존재**한다. 비어 있는
// 지표와 "짧은 통화가 없었다"는 화면에서 구분되지 않는다. Core 는 시작·종료 시각을 둘 다
// 들고 있었으므로(§4.1 `resolveOutcome` 이 같은 값으로 Outcome 을 판정한다) 호스트 선언이
// 필요한 값도 아니었다 — 실측이 있는데 싣지 않았을 뿐이다.
//
// 여기서 고정하는 것:
//  1) 종료되는 네 경로 전부에 길이가 실린다(정상 종료·`end()`·§9.3 폴백 중단·폴백 이관·
//     Api 순회 상한). 한 곳만 빠지면 "그 종류로 끝난 통화만 길이가 없다"가 되고, 평균이
//     조용히 한쪽으로 쏠린다(폴백으로 끝난 통화가 대개 가장 짧다).
//  2) 산출 규칙은 `measuredDurationMs` 하나다(§2) — Runner 와 채널 런타임이 같은 함수를 쓴다.
//  3) 못 재면 **만들지 않는다**(§13-3): 0 도 음수도 적지 않고, 소비자의 `sessionsMissingDuration`
//     이 유일한 정직한 신호다. 두 시각이 같을 때의 `0` 은 누락이 아니라 실측이다.
//  4) 과금 구간(`billable_ms`)을 길이로 대신 채우지 않는다(§11.2) — 그 한 줄이 통화 요금의
//     근거를 추정으로 바꾼다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null, EV = null, RP = null, PI = null, FR = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
  EV = await import('../src/events/schema.ts');
  RP = await import('../src/reports/aggregate.ts');
  PI = await import('../src/portal/executeInteractions.ts');
  FR = await import('../src/flow/runner.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const T0 = Date.parse('2026-10-21T09:00:00.000Z');
const SCOPE = { tenantId: 'goone' };
const GREET = '안녕하세요, 고운 고객센터입니다.';

/** 첫 턴에 End 로 가는 시나리오 — Runner 가 끝내는 가장 흔한 경로다. */
const flowDone = {
  id: 'done', version: 1, startNodeId: 'greet',
  nodes: { greet: { id: 'greet', kind: 'Say', text: GREET } },
};

/** 입력을 기다리는 시나리오 — `end()` 가 끝내는 경로(고객이 끊는다). */
const flowAsk = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: GREET, next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.' },
  },
};

/** onError 가 다시 Api 노드를 가리키는 순환 — 설정 사고이며 통화 중에 드러난다. */
const flowApiCycle = {
  id: 'api', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: 'account_no', prompt: '계좌번호를 말씀해 주세요.', next: 'lookup' },
    lookup: {
      id: 'lookup', kind: 'Api', connectorId: 'c_balance', next: 'tell', onError: 'lookup',
      waitText: '조회 중입니다. 잠시만 기다려 주세요.',
    },
    tell: { id: 'tell', kind: 'Say', text: '조회가 끝났습니다.' },
  },
};

const CDEF = {
  id: 'c_balance', tenantId: 'goone', name: '잔액조회', method: 'query',
  endpointRef: 'secret://core/balance', residency: 'domestic', timeoutMs: 3000,
  params: [{ name: 'acct', fromSlot: 'account_no', required: true }],
  outputs: [{ field: 'balance', toSlot: 'balance' }],
  onFailure: 'branch',
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
 * 시험용 시계. **호출 횟수에 의존하지 않는다** — 한 호출 안에서 `now()` 가 몇 번 불리는지는
 * 구현 사정이므로, 검사가 그 횟수에 기대면 배선이 늘어날 때마다 기대값이 흔들린다.
 * 대신 진입점 사이에서만 손으로 밀어 길이를 **우리가 정한 값**으로 만든다.
 */
function clock() {
  const c = { ms: T0 };
  return {
    c,
    now: () => new Date(c.ms).toISOString(),
    advance: (ms) => { c.ms += ms; },
    rewind: (ms) => { c.ms -= ms; },
  };
}

function build({ flows = [flowAsk], ports = [fakePort()], health = [], connectors, clk } = {}) {
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
      legacyIvrAvailable: false, agentQueueAvailable: true, fallbackQueue: 'q_care',
    },
    health: F.createHealthRegistry(health),
    bus, now: clk.now,
    newInteractionId: () => 'i_dur1',
    ...(connectors !== undefined ? { connectors } : {}),
  });
  return { core, bus, collector, ports, port: ports[0] };
}

const reqOf = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing', ...over });
const endedOf = (events) => events.find((e) => e.type === 'session.ended');

// ── 산출 규칙 하나 (§2) ──────────────────────────────────────────────────────

test('측정 규칙: 시작 시각이 없으면 만들지 않는다 — 종전과 같다(§13-3)', b, () => {
  assert.equal(EV.measuredDurationMs(undefined, '2026-10-21T09:00:10.000Z'), undefined);
});

test('측정 규칙: 두 시각이 같으면 0 이다 — 0 은 누락이 아니라 실측이다', b, () => {
  assert.equal(EV.measuredDurationMs('2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'), 0);
});

test('측정 규칙: 거꾸로 간 시계는 음수로도 0 으로도 적지 않는다', b, () => {
  assert.equal(EV.measuredDurationMs('2026-10-21T09:00:10.000Z', '2026-10-21T09:00:00.000Z'), undefined);
});

test('측정 규칙: 읽을 수 없는 시각은 거부한다 — NaN 하나가 표본 전체를 오염시킨다', b, () => {
  assert.equal(EV.measuredDurationMs('어제', '2026-10-21T09:00:00.000Z'), undefined);
  assert.equal(EV.measuredDurationMs('2026-10-21T09:00:00.000Z', '내일'), undefined);
});

test('측정 규칙: 실측 차이를 ms 그대로 돌려준다 — 반올림·보정을 하지 않는다', b, () => {
  assert.equal(EV.measuredDurationMs('2026-10-21T09:00:00.000Z', '2026-10-21T09:02:03.500Z'), 123_500);
});

// ── 종료되는 네 경로 ─────────────────────────────────────────────────────────

test('정상 종료(Runner 가 끝낸 세션)에 길이가 실린다 — 가장 많은 종료 경로다', b, async () => {
  const clk = clock();
  const { core } = build({ flows: [flowDone], clk });
  const r = await core.start(reqOf({ flowId: 'done' }));
  assert.equal(r.status, 'completed');
  // 시작과 종료가 같은 호출 안에서 일어났다 — 그 통화의 실측 길이는 0 이고, 그것이 사실이다.
  assert.equal(endedOf(r.events).duration_ms, 0);
});

test('턴 중간에 Runner 가 끝낸 세션도 경과한 시간을 적는다 — 런타임이 시작 시각을 넘긴다', b, async () => {
  const clk = clock();
  const { core } = build({ clk });
  await core.start(reqOf());
  clk.advance(23_000);
  const r = await core.send('i_dur1', { input: { kind: 'utterance', text: '김고운' } });
  assert.equal(r.status, 'completed');       // Collect 가 끝이라 흐름이 자연 종료된다
  assert.equal(endedOf(r.events).duration_ms, 23_000);
});

test('고객이 끊어 `end()` 로 끝난 세션에 길이가 실린다', b, async () => {
  const clk = clock();
  const { core } = build({ clk });
  await core.start(reqOf());
  clk.advance(95_000);
  const r = await core.end('i_dur1', '고객 종료');
  assert.equal(endedOf(r.events).duration_ms, 95_000);
});

test('§9.3 폴백으로 중단된 통화에도 길이가 실린다 — 짧은 통화만 집계에서 빠지면 평균이 쏠린다', b, async () => {
  const clk = clock();
  const { core } = build({
    clk,
    health: [{ component: 'telephony', state: 'down', observedAt: new Date(T0).toISOString() }],
  });
  const r = await core.start(reqOf());
  assert.equal(r.status, 'failed');
  assert.equal(r.fallback.mode, 'unavailable');
  assert.equal(endedOf(r.events).duration_ms, 0);
});

test('§9.3 폴백 이관으로 끝난 통화에도 길이가 실린다', b, async () => {
  const clk = clock();
  const { core } = build({ clk });
  await core.start(reqOf());
  // 통화 도중 인지 계층이 죽었다 — 다음 턴에서 상담사로 내려간다.
  clk.advance(40_000);
  core.reportHealth({
    adapter: 'callbot',
    samples: [{ component: 'llm', state: 'down', observedAt: clk.now() }],
    observedAt: clk.now(),
  });
  const r = await core.send('i_dur1', { input: { kind: 'utterance', text: '여보세요' } });
  assert.equal(r.status, 'transferred');
  assert.equal(r.fallback.mode, 'agent_only');
  assert.equal(endedOf(r.events).duration_ms, 40_000);
});

test('Api 순회 상한으로 실패한 통화에도 길이가 실린다', b, async () => {
  const clk = clock();
  const calls = [];
  const connectors = {
    connectors: { get: (id) => (id === 'c_balance' ? CDEF : undefined) },
    port: { async call(req) { calls.push(req); return { ok: false, code: 'unavailable' }; } },
    allowOverseas: false,
  };
  const { core } = build({ flows: [flowApiCycle], connectors, clk });
  await core.start(reqOf({ flowId: 'api' }));
  clk.advance(12_000);
  const r = await core.send('i_dur1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(r.status, 'failed');
  assert.match(r.state.error, /순회 상한/);
  assert.equal(endedOf(r.events).duration_ms, 12_000);
});

// ── 못 재는 경우 (실패 경로) ─────────────────────────────────────────────────

test('거꾸로 간 시계에서는 필드를 만들지 않고 종료도 막지 않는다 — 누락은 소비자가 센다', b, async () => {
  const clk = clock();
  const { core, port } = build({ clk });
  await core.start(reqOf());
  clk.rewind(5_000);                       // 호스트 시계가 뒤로 갔다(NTP 보정·컨테이너 재시작)
  const r = await core.end('i_dur1', '고객 종료');
  assert.equal(r.status, 'completed');      // 통화는 정상적으로 닫힌다
  assert.equal('duration_ms' in endedOf(r.events), false);
  assert.equal(port.log.some((l) => l[0] === 'end'), true);
  // 그리고 그 사실은 소비자에서 "아무도 재지 않았다"로 세어진다 — 0 초 통화로 보이지 않는다.
  const agg = RP.aggregateReport(r.events, { scope: SCOPE, granularity: 'day' });
  assert.deepEqual(agg.total.durationMs, []);
  assert.equal(agg.total.sessionsMissingDuration, 1);
});

test('Runner 를 직접 쓰는 호스트가 시작 시각을 주지 않으면 종전과 완전히 같다(§13-3)', b, () => {
  const ctx = { tenantId: 'goone', interactionId: 'i_x', channel: 'voice', visualAvailable: false, now: () => new Date(T0).toISOString() };
  const r = FR.start(flowDone, ctx);
  assert.equal(r.state.status, 'completed');
  assert.equal('duration_ms' in endedOf(r.events), false);
});

test('Runner 는 넘겨받은 시작 시각으로 잰다 — 규칙을 따로 구현하지 않는다(§2)', b, () => {
  const ctx = {
    tenantId: 'goone', interactionId: 'i_x', channel: 'voice', visualAvailable: false,
    startedAt: new Date(T0 - 7_000).toISOString(), now: () => new Date(T0).toISOString(),
  };
  const r = FR.start(flowDone, ctx);
  assert.equal(endedOf(r.events).duration_ms, 7_000);
});

// ── 소비자까지 도착하는가 ────────────────────────────────────────────────────

test('런타임이 만든 이벤트가 리포트 집계에 표본으로 들어간다 — 누락 0건', b, async () => {
  const clk = clock();
  const { core } = build({ clk });
  const started = await core.start(reqOf());
  clk.advance(61_000);
  const ended = await core.end('i_dur1', '고객 종료');
  const agg = RP.aggregateReport([...started.events, ...ended.events], { scope: SCOPE, granularity: 'day' });
  assert.deepEqual(agg.total.durationMs, [61_000]);
  assert.equal(agg.total.sessionsMissingDuration, 0);
});

test('상호작용 조회 행에 통화 시간이 실린다 — 정렬 키 duration_ms 가 비로소 쓸 수 있는 값이 된다', b, async () => {
  const clk = clock();
  const { core } = build({ clk });
  const started = await core.start(reqOf());
  clk.advance(45_500);
  const ended = await core.end('i_dur1', '고객 종료');
  const idx = PI.projectInteractions([...started.events, ...ended.events], { scope: SCOPE });
  assert.equal(idx.rows.length, 1);
  assert.equal(idx.rows[0].durationMs, 45_500);
  assert.equal(idx.counters.sessionsMissingDuration, 0);
});

test('과금 구간은 길이로 대신 채우지 않는다 — 두 값은 다른 근거다(§11.2)', b, async () => {
  const clk = clock();
  const { core } = build({ clk });
  await core.start(reqOf());
  clk.advance(70_000);
  // 채널은 계약대로 **과금 구간만** 선언한다(대기·호 설정 구간 포함 여부가 계약 사항이다).
  const r = await core.end('i_dur1', '고객 종료', { billableMs: 52_000 });
  const e = endedOf(r.events);
  assert.equal(e.duration_ms, 70_000);
  assert.equal(e.billable_ms, 52_000);
});

test('채널이 과금 구간을 선언하지 않아도 길이는 실린다 — 둘은 서로의 조건이 아니다', b, async () => {
  const clk = clock();
  const { core } = build({ clk });
  await core.start(reqOf());
  clk.advance(30_000);
  const r = await core.end('i_dur1', '고객 종료');
  const e = endedOf(r.events);
  assert.equal(e.duration_ms, 30_000);
  assert.equal('billable_ms' in e, false);
});
