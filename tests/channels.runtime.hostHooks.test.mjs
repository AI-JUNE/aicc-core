// 호스트 보고 훅이 던져도 통화가 끝까지 간다 + 장애 폴백이 발행보다 먼저 저장한다.
// 설계서 §6.2(호스트 경계)·§9.3(장애 폴백)·§10.1(동의)·§11.2(요금)·§13-3(실측만).
//
// 왜 이 두 가지인가:
//
// (1) Core 가 호스트에게 **알리는 자리**는 일곱이다(`onPublish`·`onRecord`·`onResult`·
//     `onIssue`·`onBlock`·`onStep`·`onReport`). 그중 둘(`onStep`·`onReport`)만 try 로
//     감싸고 "던져도 통화·종료는 계속된다"를 적어 두었고, 나머지는 **던지면 그 턴을
//     통째로 죽였다**. 보고는 매체 지시보다 **앞**이므로(`present`·`transfer`·`end`·
//     `invite` 가 전부 그 뒤다) 터지는 자리가 하필 **원장은 이미 썼고 매체에는 아무
//     지시도 가지 않은 지점**이다 — 기록은 "이관했다"·"종료했다"로 남고 회선은 올라간
//     채 남는다(그 시간은 장애가 아니라 §11.2 요금이다).
//     더 나쁜 것은 **어느 턴에서 터지는가**다: `onIssue`·`onBlock` 은 못 알아들은 턴과
//     §6.1 조회가 막힌 턴에만 불리므로, 그 훅이 깨진 호스트는 정상 턴은 전부 멀쩡하고
//     이미 나빠진 턴만 통째로 잃는다.
//
// (2) 세션 저장 순서. `start`·`send`·`join`·`end` 는 전부 "전달 실패로 상태를 잃지 않도록"
//     **발행보다 먼저** 저장한다(`join` 은 같은 이유로 이미 한 번 고쳐졌다). 그런데
//     §9.3 장애 폴백만 거꾸로였다 — 발행이 먼저, 저장이 뒤였다. 인메모리 저장소에서는
//     같은 객체라 보이지 않지만 **직렬화하는 저장소**(§6.2 의 교체 지점)에서는 발행이
//     던지는 순간 그 턴의 결론이 통째로 사라진다: 저장된 레코드는 여전히 `running`·
//     `ended: false` 이므로 세션이 닫히지 않고, 다음 입력은 조기 반환 경로에 닿지 못해
//     폴백 전체를 한 번 더 돌린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null, CO = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
  CO = await import('../src/consent/executeConsent.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-11-01T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };
const PDC = '__consent:personal_data_collection';

const flowSay = () => ({
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요, AI 상담입니다.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.', next: 'bye' },
    bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
  },
});

const flowConsent = () => ({
  id: 'consent', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요, AI 상담입니다.', next: PDC },
    [PDC]: { id: PDC, kind: 'Confirm', prompt: '개인정보 수집·이용에 동의하십니까?', onYes: 'ask', onNo: 'bye' },
    ask: { id: 'ask', kind: 'Collect', slot: 'account_no', prompt: '계좌번호를 말씀해 주세요.', next: 'bye' },
    bye: { id: 'bye', kind: 'Say', text: '감사합니다.' },
  },
});

const flowApi = () => ({
  id: 'api', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: 'account_no', prompt: '계좌번호를 말씀해 주세요.', next: 'lookup' },
    lookup: { id: 'lookup', kind: 'Api', connectorId: 'c_balance', waitText: '조회 중입니다.', next: 'tell', onError: 'sorry' },
    tell: { id: 'tell', kind: 'Say', text: '조회가 끝났습니다.' },
    sorry: { id: 'sorry', kind: 'Say', text: '지금은 조회가 어렵습니다.' },
  },
});

const CDEF = {
  id: 'c_balance', tenantId: 'goone', name: '잔액조회', method: 'query',
  endpointRef: 'secret://core/balance', residency: 'domestic', timeoutMs: 3000,
  params: [{ name: 'acct', fromSlot: 'account_no', required: true }],
  outputs: [{ field: 'balance', toSlot: 'balance' }],
  onFailure: 'branch',
};

const CPOLICY = {
  tenantId: 'goone', version: 3, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'legal@goone', approved: true,
  requirements: [{ purpose: 'personal_data_collection', required: true, noticeRef: 'n1' }],
};

function fakePort(id = 'callbot') {
  const log = [];
  return {
    id, log,
    capabilities: P.profileFor(id),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue) { log.push(['transfer', iid, queue]); },
    async routeToLegacyIvr(iid) { log.push(['routeToLegacyIvr', iid]); },
    async invite(iid, target) { log.push(['invite', iid, target]); },
    async end(iid, reason) { log.push(['end', iid, reason]); },
  };
}

/**
 * **직렬화하는 세션 저장소.** §6.2 의 교체 지점이 이 모양이다(Redis·DB).
 * 인메모리 구현은 같은 객체를 돌려주므로 `put` 을 빠뜨려도 보이지 않는다 — 그 가림막을 없앤다.
 */
function serializingSessionStore() {
  const rows = new Map();
  return {
    get: (id) => { const v = rows.get(id); return v === undefined ? undefined : structuredClone(v); },
    put: (rec) => { rows.set(rec.interactionId, structuredClone(rec)); },
    remove: (id) => { rows.delete(id); },
    ids: () => [...rows.keys()],
  };
}

function build({
  flows = [flowSay()], samples = [], port = fakePort(), bus, sessions,
  onPublish, consent, connectors,
} = {}) {
  const collector = B.createCollectorSink('t');
  const health = F.createHealthRegistry(samples);
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS[port.id], contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true, fallbackQueue: 'q_fallback',
    },
    health,
    bus: bus ?? B.createEventBus({
      scope: SCOPE, sinks: [collector],
      store: B.createMemoryIdempotencyStore({ maxKeys: 500 }), releaseKeyOnSinkFailure: false,
    }),
    now: () => NOW,
    newInteractionId: () => 'i_hook1',
    ...(sessions !== undefined ? { sessions } : {}),
    ...(onPublish !== undefined ? { onPublish } : {}),
    ...(consent !== undefined ? { consent } : {}),
    ...(connectors !== undefined ? { connectors } : {}),
  });
  return { core, port, collector, health };
}

const sample = (component, state) => ({ component, state, observedAt: NOW });
const reqOf = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing', ...over });
const hookWarns = (core) => core.warnings().filter((w) => w.code === 'W_HOST_REPORT');

// ── 1) 정상 경로 — 훅이 멀쩡하면 종전과 완전히 같다 ──────────────────────────

test('onPublish 는 발행 결과를 그대로 받고 경고는 남지 않는다', b, async () => {
  const seen = [];
  const { core } = build({ onPublish: (rs) => seen.push(rs) });
  const r = await core.start(reqOf());
  assert.equal(r.status, 'running');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].every((x) => x.status === 'delivered'), true);
  assert.deepEqual(hookWarns(core), []);
});

// ── 2) 보고 훅이 던진다 — 통화는 끝까지 간다 ─────────────────────────────────

test('onPublish 가 던져도 그 턴의 단계가 매체로 나간다 — 보고는 present 보다 앞이다', b, async () => {
  const { core, port } = build({ onPublish: () => { throw new Error('수집기 장애'); } });
  const r = await core.start(reqOf());
  assert.equal(r.status, 'running');
  assert.deepEqual(port.log[0], ['present', 'i_hook1', ['greet', 'ask']]);
  const w = hookWarns(core);
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /onPublish/);
  // 던져진 값은 문구에 싣지 않는다(§10.3) — 경고가 호출 횟수만큼 쌓이지도 않는다.
  assert.equal(/수집기 장애/.test(w[0].messageKo), false);
});

test('§9.3 이관 턴: onPublish 가 던져도 transfer 가 불린다 — 원장만 "이관했다"로 남지 않는다', b, async () => {
  const { core, port } = build({
    samples: [sample('llm', 'down')],
    onPublish: () => { throw new Error('수집기 장애'); },
  });
  const r = await core.start(reqOf());
  assert.equal(r.status, 'transferred');
  assert.equal(r.fallback.mode, 'agent_only');
  // 종전에는 여기서 턴이 죽었고, 매체에는 **어떤 지시도** 도착하지 않았다.
  assert.deepEqual(port.log, [['transfer', 'i_hook1', 'q_fallback']]);
  assert.equal(hookWarns(core).length, 1);
});

test('§9.3 중단 턴: onPublish 가 던져도 end 가 불린다 — 회선이 올라간 채 남지 않는다(§11.2)', b, async () => {
  const { core, port } = build({
    samples: [sample('telephony', 'down')],
    onPublish: () => { throw new Error('수집기 장애'); },
  });
  const r = await core.start(reqOf());
  assert.equal(r.status, 'failed');
  assert.equal(r.fallback.mode, 'unavailable');
  assert.equal(port.log[0][0], 'end');
});

test('consent.onRecord 가 던져도 동의는 기록되고 턴 결과가 나간다(§10.1)', b, async () => {
  const store = CO.createMemoryConsentStore();
  const { core, port } = build({
    flows: [flowConsent()],
    consent: {
      policy: CPOLICY, records: store, subjectRef: () => 'sha256:abc',
      onRecord: () => { throw new Error('동의 알림 장애'); },
    },
  });
  await core.start(reqOf({ flowId: 'consent' }));
  const r = await core.send('i_hook1', { input: { kind: 'utterance', text: '네' } });
  // 기록 실패가 통화를 끊지 않는다면 **보고 실패도 끊을 수 없다** — 같은 저울이다.
  assert.deepEqual(r.consent.recorded, {
    purpose: 'personal_data_collection', state: 'granted', policyVersion: 3,
  });
  assert.equal(store.list('sha256:abc').length, 1);
  assert.equal(port.log.filter((l) => l[0] === 'present').length, 2);
  const w = hookWarns(core);
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /consent\.onRecord/);
});

test('connectors.onBlock 이 던져도 §6.1 이행이 계속된다 — 이미 막힌 턴만 잃지 않는다', b, async () => {
  const calls = [];
  const { core, port } = build({
    flows: [flowApi()],
    connectors: {
      connectors: { get: (id) => (id === 'c_balance' ? CDEF : undefined) },
      port: { async call(req) { calls.push(req); return { ok: true, data: { balance: '10000' } }; } },
      allowOverseas: false,
      // 동의 컨텍스트 조립이 던지는 설정이다 — 펌프가 `consentError` 로 올리는 유일한 경로.
      consent: () => { throw new Error('동의 컨텍스트 조립 실패'); },
      onBlock: () => { throw new Error('차단 알림 장애'); },
    },
  });
  await core.start(reqOf({ flowId: 'api' }));
  const r = await core.send('i_hook1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(calls.length, 1, '조회는 그대로 나갔다');
  assert.equal(r.state.slots.balance, '10000');
  assert.ok(port.log.length >= 2, '대기 안내와 조회 결과가 둘 다 나갔다');
  const w = hookWarns(core);
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /connectors\.onBlock/);
});

test('경계: 같은 훅이 여러 번 던져도 경고는 훅 이름당 한 건이다', b, async () => {
  const { core } = build({ onPublish: () => { throw new Error('수집기 장애'); } });
  await core.start(reqOf());
  await core.send('i_hook1', { input: { kind: 'utterance', text: '홍길동' } });
  await core.send('i_hook1', { input: { kind: 'utterance', text: '다시' } });
  assert.equal(hookWarns(core).length, 1);
});

test('경계: 발행 자체의 실패는 종전처럼 올라간다 — 보고와 기록은 다른 것이다(§8.1)', b, async () => {
  const { core } = build({ bus: { async publishAll() { throw new Error('버스 장애'); } } });
  await assert.rejects(() => core.start(reqOf()), /버스 장애/);
  assert.deepEqual(hookWarns(core), []);
});

// ── 3) 장애 폴백은 발행보다 먼저 저장한다 ────────────────────────────────────

/**
 * 무장하면 `allow` 건만 더 보내고 그 다음에 던지는 버스. 발행 중단의 실제 모양이다 —
 * 앞 이벤트는 이미 싱크(원장)까지 갔고 뒤 이벤트는 가지 못한다.
 */
function flakyBus() {
  const delivered = [];
  let armed = false;
  let allow = 0;
  return {
    delivered,
    arm(n = 0) { armed = true; allow = n; },
    async publishAll(events) {
      const out = [];
      for (const e of events) {
        if (armed) {
          if (allow <= 0) throw new Error('이벤트 저장소 장애');
          allow -= 1;
        }
        delivered.push(e.type);
        out.push({ eventId: e.event_id, key: e.event_id, status: 'delivered', sinks: [] });
      }
      return out;
    },
  };
}

test('§9.3 이관 중 발행이 끊겨도 저장된 세션은 닫힌 상태다 — 다시 폴백을 돌리지 않는다', b, async () => {
  const sessions = serializingSessionStore();
  const bus = flakyBus();
  const { core, port, health } = build({ sessions, bus });
  await core.start(reqOf());
  assert.equal(sessions.get('i_hook1').state.status, 'running');

  // 이 턴에서 인지 계층이 죽는다 — §9.3 은 상담사 이관을 낸다.
  // 원장에는 `handoff.requested` 까지 들어가고 `session.ended` 는 들어가지 못한다.
  bus.arm(1);
  health.record(sample('llm', 'down'));
  await assert.rejects(
    () => core.send('i_hook1', { input: { kind: 'utterance', text: '홍길동' } }),
    /이벤트 저장소 장애/,
  );

  const saved = sessions.get('i_hook1');
  assert.equal(saved.state.status, 'transferred', '발행이 끊겨도 폴백 판정은 저장됐다');
  assert.equal(saved.ended, true);
  assert.equal(saved.lastResult.fallback.mode, 'agent_only');
  // 발행이 던졌으므로 이 턴의 매체 지시는 나가지 않는다 — 그건 발행 실패이고 호출자에게 올라간다.
  assert.deepEqual(port.log.filter((l) => l[0] === 'transfer'), []);
  // 그래도 **다음 입력은 폴백을 다시 돌리지 않는다**: 닫힌 세션의 늦은 입력으로 들어온다.
  const late = await core.send('i_hook1', { input: { kind: 'utterance', text: '여보세요' } });
  assert.deepEqual(late.events, []);
  assert.equal(late.status, 'transferred');
  assert.deepEqual(bus.delivered.slice(-1), ['handoff.requested'],
    '원장에는 "이관했다"가 들어갔다 — 저장이 뒤였을 때는 그 사실만 남고 세션은 열려 있었다');
});

test('§9.3 중단 중 발행이 끊겨도 저장된 세션은 failed 다', b, async () => {
  const sessions = serializingSessionStore();
  const bus = flakyBus();
  bus.arm(0);
  const { core } = build({ sessions, bus, samples: [sample('telephony', 'down')] });
  await assert.rejects(() => core.start(reqOf()), /이벤트 저장소 장애/);
  const saved = sessions.get('i_hook1');
  assert.equal(saved.state.status, 'failed');
  assert.equal(saved.ended, true);
});

test('정상 경로: 발행이 멀쩡하면 저장과 매체 지시가 종전과 같다', b, async () => {
  const sessions = serializingSessionStore();
  const { core, port, health } = build({ sessions });
  await core.start(reqOf());
  health.record(sample('llm', 'down'));
  const r = await core.send('i_hook1', { input: { kind: 'utterance', text: '홍길동' } });
  assert.equal(r.status, 'transferred');
  assert.equal(sessions.get('i_hook1').state.status, 'transferred');
  assert.deepEqual(port.log.filter((l) => l[0] === 'transfer'), [['transfer', 'i_hook1', 'q_fallback']]);
});
