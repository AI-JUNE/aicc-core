// 비-Node 호스트는 Core 의 유지 루프를 부를 길이 없었다(§9.3·§2).
//
// `ConversationCore` 에는 통화 경로 밖의 진입점이 다섯 개 있다 — `warnings`·`readiness`·
// `runRecoveryProbes`·`runOfferExpiry`·`settleAgentOffer`. 전부 **호스트가 부르는 것**이다:
// Core 는 타이머를 돌리지 않는다(몰래 켠 인터벌은 끌 수도 없고 프로세스 종료를 막는다).
// 그런데 비-Node 호스트가 Core 에 닿는 길은 브리지(JSONL)뿐이고, 브리지의 op 는
// hello·start·send·end·health 다섯이었다 — 즉 **파이썬으로 Callbot 을 운영하는 배치에서는
// 그 다섯을 부를 방법이 아예 없었다.** 증상은 하나도 예외가 아니다:
//  - 만료 수렴이 안 돌아 만료된 오퍼가 열린 채 쌓인다 → 같은 콜이 두 번 제안되고, 그 통화는
//    큐에 묶인 채 §9.3 대안(콜백·음성사서함)으로도 가지 않는다(`executeOffer` (바)).
//  - 복구 확인이 안 돌아 한 번 `degraded_ai`·`agent_only` 로 내려간 테넌트는 엔진이 돌아와도
//    **영구히** 폴백에 남는다 — 아무도 찌르지 않으므로 헬스 샘플이 갱신되지 않는다.
//  - readiness 가 안 닿아 `/health` 는 모든 통화가 상담사 직결로 떨어진 순간에도 초록이다((37)).
//  - 상담사 수락·거절이 원장에 없어 재배정도 소진 수렴도 일어나지 않는다 — 그 상태는
//    "상담사가 안 받는다"와 구분되지 않는다.
//  - 계약 경고 전문을 읽을 길이 없어, 통화는 정상으로 끝나는데 §10.1 고지가 한 번도 나가지
//    않는 상태(`W_AI_DISCLOSURE_UNBOUND`)를 호스트가 알 방법이 없다.
//
// 여기서 지키는 것은 "op 가 응답한다"가 아니라 **배선이 없을 때 0건으로 적지 않는다**는 규칙과
// 유지 루프를 통화 경로와 다르게 다루는 경계들이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let BR = null, R = null, F = null, P = null, BP = null, C = null, OBS = null;
try {
  BR = await import('../src/channels/bridge.ts');
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  P = await import('../src/channels/profiles.ts');
  BP = await import('../src/channels/basePort.ts');
  C = await import('../src/channels/contract.ts');
  OBS = await import('../src/obs/executeObservability.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: BR ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const NOW = '2026-10-21T09:00:00.000Z';

const flow = {
  id: 'care', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'name', prompt: '성함을 말씀해 주세요.', next: 'toAgent' },
    toAgent: { id: 'toAgent', kind: 'Transfer', queue: 'q_care', reason: 'policy' },
  },
};

const QUEUES = [
  { id: 'q_care', tenantId: 'goone', titleKo: '케어', skills: [], closedAction: 'callback' },
];

const ROUTING = (over = {}) => ({
  config: { tenantId: 'goone', queues: QUEUES, rules: [], defaultQueueId: 'q_care' },
  snapshots: () => [{ queueId: 'q_care', waiting: 0, availableAgents: 2, observedAt: NOW }],
  ...over,
});

const OFFERS = (over = {}) => {
  let n = 0;
  return {
    policy: { timeoutMs: 20000, maxAttempts: 2 },
    candidates: () => ['a_kim', 'a_lee'],
    newOfferId: () => { n += 1; return `o_${n}`; },
    ...over,
  };
};

const RECOVERY = () => ({
  schedules: [{
    intervalMs: 1000,
    timeoutMs: 500,
    probe: {
      component: 'telephony',
      check: async () => ({ component: 'telephony', state: 'up', observedAt: NOW }),
    },
  }],
});

function build({ bridge: bridgeOver = {}, core: coreOver = {}, portOnly = false } = {}) {
  const port = BP.createChannelPort({ id: 'callbot' });
  const full = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    now: () => NOW,
    newInteractionId: () => 'i_m1',
    ...coreOver,
  });
  // **포트만 주는 호스트**(적합성 더미 등)도 있다 — 그 경우 유지 메서드가 아예 없다.
  const core = portOnly
    ? {
      contractVersion: full.contractVersion,
      start: (r) => full.start(r),
      send: (i, t) => full.send(i, t),
      end: (i, r, x) => full.end(i, r, x),
      reportHealth: (r) => full.reportHealth(r),
    }
    : full;
  return { core: full, bridge: BR.createBridge({ core, adapter: 'callbot', scope: SCOPE, ...bridgeOver }) };
}

const line = (o) => JSON.stringify(o);
const call = (bridge, op, body = {}) => bridge.handleLine(line({ id: '1', op, ...body }));

// ── 1) op 목록이 한 곳이다 ──────────────────────────────────────────────────

test('유지 op 가 브리지 op 목록에 들어 있고 유지 목록이 그 부분집합이다', b, () => {
  for (const op of C.BRIDGE_MAINTENANCE_OPS) {
    assert.ok(C.BRIDGE_OPS.includes(op), `${op} 가 op 목록에 없다 — 모르는 op 로 거부된다`);
  }
  // 통화 경로는 유지 목록에 들어 있지 않다(한도·전사 판정에서 다르게 다룬다).
  for (const op of ['hello', 'start', 'send', 'end', 'health']) {
    assert.ok(!C.BRIDGE_MAINTENANCE_OPS.includes(op), `${op} 를 유지 루프로 분류하면 한도가 풀린다`);
  }
});

test('전사 판정기·관측 분류기가 op 목록을 다시 적지 않는다 — 사본이 생기면 실패한다', b, () => {
  const consumers = [
    '../src/channels/bridge.ts',
    '../src/channels/bridgeTranscript.ts',
    '../src/obs/executeObservability.ts',
  ];
  const stripComments = (s) => s.split('\n').filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join('\n');
  // 통화 경로 다섯만 적은 사본이 가장 흔한 모양이다 — 유지 op 가 늘어도 그쪽만 모르게 된다.
  const core = ['hello', 'start', 'send', 'end', 'health'];
  for (const file of consumers) {
    const src = stripComments(readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const literal of src.matchAll(/\[[^[\]]*\]/g)) {
      const members = [...literal[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      assert.ok(
        !core.every((op) => members.includes(op)),
        `${file} 가 op 목록을 다시 적었다 — 늘어난 op 를 모르는 쪽만 조용히 틀린다(§2):\n${literal[0]}`,
      );
    }
  }
});

test('관측 분류기가 유지 op 를 로그 필드에 싣는다 — 모르면 실패가 어느 줄의 것인지 알 수 없다', b, () => {
  // `classifyRejection` 은 아는 op 만 고정 필드에 싣는다(모르는 op 는 임의 문자열이다).
  for (const op of C.BRIDGE_MAINTENANCE_OPS) {
    const d = OBS.classifyRejection({
      scope: SCOPE, adapter: 'callbot', op, code: 'E_NOT_WIRED', stage: 'request',
    });
    assert.equal(d.fields.op, op, `${op} 의 경계 실패가 로그에서 op 없이 남는다`);
  }
});

test('모르는 op 는 종전대로 거부된다(실패 경로)', b, async () => {
  const { bridge } = build();
  const r = await call(bridge, 'expireOffers');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_UNKNOWN_OP');
});

// ── 2) 배선이 없으면 0건으로 적지 않는다 ────────────────────────────────────

test('유지 배선이 없으면 다섯 op 모두 E_NOT_WIRED 다 — 빈 보고서를 돌려주지 않는다(§13-3)', b, async () => {
  const { bridge } = build({ core: { routing: ROUTING({ offers: OFFERS() }), recovery: RECOVERY() } });
  for (const op of C.BRIDGE_MAINTENANCE_OPS) {
    const r = await call(bridge, op, op === 'settleOffer' ? { offerId: 'o_1', event: 'accept' } : {});
    assert.equal(r.ok, false, `${op} 가 배선 없이 통과했다`);
    assert.equal(r.error.code, 'E_NOT_WIRED', `${op}: ${JSON.stringify(r.error)}`);
    // "0건"으로 읽힐 수 있는 본문이 함께 나가지 않는다.
    assert.equal(r.result, undefined);
  }
});

test('Core 쪽 배선이 없으면 스위치를 켜도 E_NOT_WIRED 다 — 켠 op 가 0건을 돌려주지 않는다', b, async () => {
  // 복구·오퍼 배선이 **없는** Core. 메서드는 있으나 undefined 를 돌려준다.
  const { bridge } = build({ bridge: { maintenance: { recoveryProbe: true, offerExpiry: true } } });
  const rec = await call(bridge, 'recoveryProbe');
  assert.equal(rec.ok, false);
  assert.equal(rec.error.code, 'E_NOT_WIRED');
  assert.match(rec.error.messageKo, /복구 프로브 배선/);
  const exp = await call(bridge, 'offerExpiry');
  assert.equal(exp.ok, false);
  assert.equal(exp.error.code, 'E_NOT_WIRED');
});

test('포트만 주는 호스트는 종전과 완전히 같다 — 유지 메서드 없음을 설정 누락으로 적는다', b, async () => {
  const { bridge } = build({ portOnly: true, bridge: { maintenance: { warnings: true } } });
  const r = await call(bridge, 'warnings');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_NOT_WIRED');
  // `TypeError` 가 E_INTERNAL 로 올라가면 설정 누락이 Core 장애로 보인다.
  assert.match(r.error.messageKo, /ConversationCorePort/);
});

test('readiness 는 요청(프로브·제한 시간)이 배선되지 않으면 거절된다 — 기준을 줄마다 받지 않는다', b, async () => {
  const { bridge } = build({ bridge: { maintenance: { warnings: true } } });
  const r = await call(bridge, 'readiness');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_NOT_WIRED');
});

// ── 3) 열면 실제로 돈다 ─────────────────────────────────────────────────────

const OPEN = {
  warnings: true, recoveryProbe: true, offerExpiry: true, settleOffer: true,
  observability: true, readiness: { timeoutMs: 500 },
};

test('hello 가 열린 유지 op 를 알려준다 — 호스트가 하나씩 찔러 보지 않는다(§2)', b, async () => {
  const { bridge } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }), recovery: RECOVERY() },
  });
  const r = await call(bridge, 'hello');
  assert.equal(r.ok, true);
  assert.deepEqual([...r.result.maintenanceOps].sort(), [...C.BRIDGE_MAINTENANCE_OPS].sort());
});

test('hello 는 닫힌 op 를 열린 것으로 적지 않는다(경계)', b, async () => {
  const { bridge } = build();
  const r = await call(bridge, 'hello');
  assert.deepEqual(r.result.maintenanceOps, []);
});

test('warnings 가 계약 경고 전문을 내보낸다 — 코드만으로는 무엇이 꺼졌는지 알 수 없다(§10.1)', b, async () => {
  const { bridge, core } = build({ bridge: { maintenance: OPEN } });
  const r = await call(bridge, 'warnings');
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.result.issues));
  assert.deepEqual(r.result.issues.map((i) => i.code).sort(), core.warnings().map((i) => i.code).sort());
  const disclosure = r.result.issues.find((i) => i.code === 'W_AI_DISCLOSURE_UNBOUND');
  assert.ok(disclosure, '고지 미배선은 통화가 정상으로 끝나므로 전문이 나가야 한다');
  assert.ok(disclosure.messageKo.length > 0);
});

test('warnings 응답을 호스트가 고쳐도 Core 의 판정은 그대로다(투영 복사)', b, async () => {
  const { bridge, core } = build({ bridge: { maintenance: OPEN } });
  const r = await call(bridge, 'warnings');
  const before = core.warnings().length;
  r.result.issues.length = 0;
  assert.equal(core.warnings().length, before);
});

test('readiness 가 §9.3 폴백 상태를 담아 돌아온다 — 호스트 /health 가 쓸 근거다', b, async () => {
  const { bridge } = build({ bridge: { maintenance: OPEN } });
  const r = await call(bridge, 'readiness');
  assert.equal(r.ok, true);
  assert.ok(r.result.status, 'readiness 판정이 없다');
  assert.ok(r.result.core, '§9.3 사실(core)이 없으면 호스트 프로브와 다를 바 없다');
});

test('recoveryProbe 1회가 돌고 보고서가 사실을 담는다(§9.3)', b, async () => {
  const { bridge, core } = build({
    bridge: { maintenance: OPEN },
    core: { recovery: RECOVERY() },
  });
  // 회선을 죽여 둔다 — 나쁘지 않은 컴포넌트는 찌를 이유가 없으므로 `skipped` 로 남는다.
  core.reportHealth({
    adapter: 'callbot', observedAt: NOW,
    samples: [{ component: 'telephony', state: 'down', observedAt: NOW }],
  });
  const r = await call(bridge, 'recoveryProbe');
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(Array.isArray(r.result.attempts));
  assert.deepEqual(r.result.recovered, ['telephony'], '복구를 기록하지 못하면 폴백이 영구히 풀리지 않는다');
  assert.ok(Array.isArray(r.result.unprobed));
});

test('offerExpiry 1회가 돌고 보고서가 판정 여부를 밝힌다', b, async () => {
  const { bridge } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }), recovery: RECOVERY() },
  });
  const r = await call(bridge, 'offerExpiry');
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.expired, 0);
  assert.deepEqual(r.result.issues, [], 'issues 가 있으면 expired 는 판정 결과가 아니다');
  assert.ok(Array.isArray(r.result.steps));
});

test('settleOffer 가 상담사 수락을 원장에 반영한다 — 올리지 않으면 재배정도 없다', b, async () => {
  const { bridge, core } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }) },
  });
  await call(bridge, 'start', { req: { flowId: 'care', entryPoint: 'inbound_call' } });
  await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_m1', turn: { input: { kind: 'utterance', text: '홍길동' } },
  }));
  const opened = core.agentOffers().offers.filter((o) => o.state === 'offered');
  assert.equal(opened.length, 1, '이관이 오퍼를 열지 않았다 — 이 검사의 전제가 깨졌다');
  const r = await call(bridge, 'settleOffer', { offerId: opened[0].offerId, event: 'accept' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.code, 'assigned');
  assert.equal(r.result.via, 'settle');
  assert.equal(r.result.offer.agentId, opened[0].agentId);
  // **원장 전체는 싣지 않는다** — 남의 상호작용 오퍼가 매 응답에 실리고 한 줄 상한에 걸린다.
  assert.equal(r.result.ledger, undefined);
  assert.equal(core.agentOffers().offers.find((o) => o.offerId === opened[0].offerId).state, 'accepted');
});

test('settleOffer 의 거절은 같은 호출에서 다음 후보로 이어진다(§9.3)', b, async () => {
  const { bridge, core } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }) },
  });
  await call(bridge, 'start', { req: { flowId: 'care', entryPoint: 'inbound_call' } });
  await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_m1', turn: { input: { kind: 'utterance', text: '홍길동' } },
  }));
  const first = core.agentOffers().offers.find((o) => o.state === 'offered');
  const r = await call(bridge, 'settleOffer', { offerId: first.offerId, event: 'decline' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.code, 'offered', '거절이 다음 후보로 이어지지 않으면 통화가 큐에 묶인다');
  assert.notEqual(r.result.offer.agentId, first.agentId);
});

// ── 4) 실패 경로·경계 ───────────────────────────────────────────────────────

test('settleOffer 는 형태 위반을 부르기 전에 거부한다(실패 경로)', b, async () => {
  const { bridge } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }) },
  });
  for (const body of [{}, { offerId: '' }, { offerId: 'o_1' }, { offerId: 'o_1', event: 'yes' }]) {
    const r = await call(bridge, 'settleOffer', body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error.code, 'E_BAD_REQUEST');
  }
});

test('settleOffer 는 tick 을 받지 않는다 — 만료 판정이 두 곳이 되면 안 된다(§2)', b, async () => {
  const { bridge } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }) },
  });
  const r = await call(bridge, 'settleOffer', { offerId: 'o_1', event: 'tick' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_BAD_REQUEST');
  assert.match(r.error.messageKo, /offerExpiry/);
});

test('상담사 응답 목록을 브리지가 다시 적지 않는다 — tick 만 빼고 전부 받는다(§2)', b, async () => {
  // 종전에는 브리지가 `new Set<OfferEvent>(['accept','decline','cancel','tick'])` 로 같은 목록을
  // 손으로 들고 있었다. 그 대입은 **빠뜨린 값을 컴파일 오류로 만들지 않으므로**, 사건이 하나
  // 늘면 Node 호스트는 올릴 수 있고 비-Node 호스트만 E_BAD_REQUEST 를 받는다 — 같은 상담사
  // 응답이 경로에 따라 갈리는 모양이고, 그 상태는 "상담사가 안 받는다"와 구분되지 않는다.
  const Q = await import('../src/routing/agentQueue.ts');
  const { bridge } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }) },
  });
  for (const event of Q.OFFER_EVENTS) {
    const r = await call(bridge, 'settleOffer', { offerId: 'o_없음', event });
    if (event === 'tick') {
      assert.equal(r.ok, false, 'tick 은 offerExpiry 가 수행한다(§2)');
      continue;
    }
    assert.notEqual(
      r.error?.code, 'E_BAD_REQUEST',
      `${event} 가 와이어에서 거부됐다 — 목록 사본이 낡았다(Node 호스트는 올릴 수 있다)`,
    );
  }
});

test('허용값 안내가 바로 다음 검사에서 거절될 값을 광고하지 않는다', b, async () => {
  const { bridge } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }) },
  });
  const r = await call(bridge, 'settleOffer', { offerId: 'o_1', event: 'yes' });
  assert.equal(r.error.code, 'E_BAD_REQUEST');
  assert.ok(
    !r.error.messageKo.includes('tick'),
    `안내를 그대로 따른 호스트가 다음 검사에서 또 거절당한다: ${r.error.messageKo}`,
  );
  for (const event of ['accept', 'decline', 'cancel']) {
    assert.ok(r.error.messageKo.includes(event), `${event} 가 안내에서 빠졌다`);
  }
});

test('op 분류의 합이 전체 목록이다 — 늘릴 때 분류를 빼먹을 수 없다(§2)', b, () => {
  assert.deepEqual(
    [...C.BRIDGE_CALL_PATH_OPS, ...C.BRIDGE_MAINTENANCE_OPS].sort(),
    [...C.BRIDGE_OPS].sort(),
    '분류되지 않은 op 는 통화 경로로 취급돼 요청 한도에 걸린다 — 수렴이 조용히 멈춘다',
  );
  // 한도 대상은 통화 경로의 부분집합이다(hello·end 는 어떤 경우에도 막지 않는다).
  for (const op of BR.RATE_LIMITED_OPS) {
    assert.ok(C.BRIDGE_CALL_PATH_OPS.includes(op), `${op} 가 통화 경로가 아닌데 한도에 걸려 있다`);
  }
});

test('모르는 offerId 는 거절로 돌아오며 통화를 깨지 않는다(경계)', b, async () => {
  const { bridge } = build({
    bridge: { maintenance: OPEN },
    core: { routing: ROUTING({ offers: OFFERS() }) },
  });
  const r = await call(bridge, 'settleOffer', { offerId: 'o_없음', event: 'accept' });
  assert.equal(r.ok, true, '없는 오퍼는 예외가 아니라 판정이다');
  assert.equal(r.result.code, 'refused');
  assert.ok(r.result.issues.length > 0, '거절 사유 없이 refused 를 적으면 원인을 못 가른다');
});

test('유지 루프는 요청 한도에 걸리지 않는다 — 막으면 수렴이 멈춘다(§9.3)', b, async () => {
  // 즉시 바닥나는 제한기.
  const limiter = { check: () => ({ allowed: false, retryAfterMs: 1000 }) };
  const { bridge } = build({
    bridge: { maintenance: OPEN, rateLimiter: limiter },
    core: { routing: ROUTING({ offers: OFFERS() }), recovery: RECOVERY() },
  });
  for (const op of ['warnings', 'readiness', 'recoveryProbe', 'offerExpiry']) {
    const r = await call(bridge, op);
    assert.notEqual(r.error?.code, 'E_RATE_LIMITED', `${op} 가 한도에 막혔다`);
  }
  // 통화 경로는 종전대로 막힌다.
  const s = await call(bridge, 'start', { req: { flowId: 'care', entryPoint: 'inbound_call' } });
  assert.equal(s.error.code, 'E_RATE_LIMITED');
});

test('한도 대상이 아닌 op 에 비용을 주면 생성 시점에 거절한다 — 조용히 무시하지 않는다(§2)', b, () => {
  const limiter = { check: () => ({ allowed: true, retryAfterMs: 0 }) };
  for (const op of ['hello', 'end', 'offerExpiry', 'readiness']) {
    assert.throws(
      () => build({ bridge: { rateLimiter: limiter, rateLimitCost: { [op]: 2 } } }),
      /한도 적용 대상이 아닙니다/,
      `${op} 비용이 조용히 무시됐다 — 한도를 걸었다고 적힌 운영 문서만 남는다`,
    );
  }
  // 대상인 op 는 종전대로 받는다.
  build({ bridge: { rateLimiter: limiter, rateLimitCost: { send: 2, start: 1, health: 1 } } });
});

test('유지 op 도 기록(records)에 남는다 — 돌았는지 아닌지가 프로세스 안에서 보인다', b, async () => {
  const { bridge } = build({ bridge: { maintenance: OPEN } });
  await call(bridge, 'warnings');
  const rec = bridge.records.at(-1);
  assert.equal(rec.op, 'warnings');
  assert.equal(rec.ok, true);
});
