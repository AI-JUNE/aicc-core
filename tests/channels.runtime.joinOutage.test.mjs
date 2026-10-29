// §9.3 판정이 진입점 한 곳만 비껴갔다 — 합류(`join`)는 축소 지시만 찍고 모드는 보지 않았다.
//
// `start`·`send` 는 매 턴 `decideFallbackMode` 를 보고 `unavailable`·`legacy_ivr`·`agent_only` 면
// 그 자리에서 통화를 끝내거나 상담사로 내린다. 합류는 **축소 지시(`stampOutage`)만** 찍었고,
// 그 자리 주석은 "경로마다 따로 판단하지 않는다 — 빠뜨린 경로는 '그 채널에서만 안 꺼진다'로
// 나타난다"고 적어 두었다. 한 층 위의 모드에서 정확히 그 일이 일어나 있었다.
//
// 빠뜨린 쪽의 증상이 둘 다 조용하다:
//  - **매체 계층이 죽은 상태의 합류**: Core 는 죽은 매체로 `present` 를 부르고 끝난다. 고객이
//    보는 것은 빈 화면이고 세션은 `running` 으로 남는다. 그 화면에는 아무것도 입력할 수 없으므로
//    `send` 가 영영 오지 않고 — `send` 가 §9.3 을 보는 다음 기회다 — 그 통화는 `session.ended`
//    없이 끝난다(§7 5.2 점검도 §4.1 Outcome 도 없다).
//  - **인지 계층이 죽은 상태의 합류**: AI 가 죽은 매체에서 §10.1 AI 고지를 먼저 내보낸 뒤
//    다음 입력에서야 상담사로 간다. 고객은 한 턴을 헛되게 쓰고 그 고지는 추가 전용 원장에 남는다.
//
// 그리고 순서가 안전장치다: 판정은 **토큰 검증 뒤**에 본다 — 바꾸면 남의 손에 남은 낡은 링크
// 하나가 진행 중인 상담을 종료시킬 수 있다(§5.2·§10.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null, CS = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
  CS = await import('../src/core/channelSwitch.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-21T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };
const DISCLOSURE_TEXT = '이 화면은 AI가 안내합니다.';

const flowAsk = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요, 고운 고객센터입니다.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.', next: 'ask2' },
    // 답을 받아도 세션이 끝나지 않게 한 칸 더 둔다 — 합류는 **진행 중인** 상담에만 일어난다.
    ask2: { id: 'ask2', kind: 'Collect', slot: 'inquiry', prompt: '어떤 내용인지 말씀해 주세요.' },
  },
};

const DISC = () => ({
  tenantId: 'goone', enabled: true, approved: true,
  approvedAt: '2026-08-20T00:00:00.000Z', approvedBy: 'legal_kim',
  version: 4, updatedAt: '2026-08-19T00:00:00.000Z', updatedBy: 'admin_lee',
  channels: {
    voice: { text: '본 상담은 AI 상담원이 진행합니다.', placement: 'before_first_response' },
    visual: { text: DISCLOSURE_TEXT, placement: 'persistent_banner' },
  },
});

function fakePort(id = 'callbot') {
  const log = [];
  return {
    id, log,
    capabilities: P.profileFor(id),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue, summary) { log.push(['transfer', iid, queue, summary]); },
    async invite(iid, target, link) { log.push(['invite', iid, target, link]); },
    async end(iid, reason) { log.push(['end', iid, reason]); },
  };
}

function build({ samples = [], channelSwitch } = {}) {
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 300 }), releaseKeyOnSinkFailure: false,
  });
  const voice = fakePort('callbot');
  const visual = fakePort('dars');
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flowAsk]),
    channels: [voice, visual].map((port) => ({
      port, reportsComponents: P.CHANNEL_COMPONENTS[port.id], contractVersion: 1,
    })),
    policy: {
      tenantId: 'goone', staleAfterMs: 600000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true, fallbackQueue: 'q_care',
    },
    health: F.createHealthRegistry(samples),
    bus, now: () => NOW, newInteractionId: () => 'i_jo1',
    disclosure: DISC(),
    ...(channelSwitch !== undefined ? { channelSwitch } : {}),
  });
  return { core, collector, voice, visual };
}

const startReq = { scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing' };
const joinReq = (over = {}) => ({ scope: SCOPE, adapter: 'dars', flowId: 'billing', joinInteractionId: 'i_jo1', ...over });
const sample = (component, state) => ({ component, state, observedAt: NOW });

/**
 * 통화가 시작된 **뒤에** 인지 계층이 죽는다. 이 순서가 현실의 모양이다 — 음성 세션은 llm 을
 * 의존하므로 처음부터 죽어 있으면 `start` 가 이미 상담사로 내린다. 전환 링크를 받은 고객이
 * 휴대폰을 보는 동안(그 사이 음성 턴은 오지 않는다) 엔진이 죽는 경로만 합류까지 살아서 온다.
 */
function breakCognition(core) {
  core.reportHealth({ adapter: 'callbot', samples: [sample('llm', 'down')], observedAt: NOW });
}
const disclosureTurns = (collector) => collector.events
  .filter((e) => e.type === 'turn.completed' && e.utterance_masked === DISCLOSURE_TEXT);

test('정상 상태의 합류는 종전과 완전히 같다 — 판정을 끼운 것이 동작을 바꾸지 않는다', b, async () => {
  const { core, visual } = build();
  await core.start(startReq);
  const r = await core.start(joinReq());
  assert.equal(r.status, 'running');
  assert.equal(r.state.channel, 'visual');
  assert.equal(r.disclosure.channel, 'visual');
  assert.ok(visual.log.some((l) => l[0] === 'present'));
});

test('축소 운영(degraded)에서도 합류는 그대로 진행된다 — 끄는 것은 기능뿐이다(§9.3)', b, async () => {
  const { core } = build({ samples: [sample('rag', 'degraded')] });
  await core.start(startReq);
  const r = await core.start(joinReq());
  assert.equal(r.status, 'running');
  // 진행은 그대로이고 **판정은 실린다** — `start`·`send` 와 같은 조건이다(§9.3·§2).
  // 종전에는 이 칸이 비어 있었고, 합류는 고객이 다른 매체로 건너온 첫 턴이라
  // 그 호스트에게는 첫 응답이다: 비어 있으면 축소 운영을 정상으로 읽는다(§13-3).
  assert.equal(r.fallback.mode, 'degraded_ai');
  assert.deepEqual(r.fallback.disable, ['knowledge_grounding']);
  // 축소 지시는 종전처럼 단계에도 찍힌다 — 둘은 같은 판정 하나를 본다(§2).
  assert.equal(r.steps.every((s) => s.outage === undefined), true, 'rag 저하는 매체 지시가 아니다');
});

test('정상 판정이면 합류 응답에 fallback 칸이 없다 — 없는 칸을 만들지 않는다(§13-3)', b, async () => {
  const { core } = build();
  await core.start(startReq);
  const r = await core.start(joinReq());
  assert.equal('fallback' in r, false);
});

test('합류 뒤 첫 입력도 같은 판정을 돌려준다 — 합류만 비껴가던 자리였다', b, async () => {
  const { core } = build({ samples: [sample('rag', 'degraded')] });
  await core.start(startReq);
  const joined = await core.start(joinReq());
  const next = await core.send('i_jo1', { input: { kind: 'utterance', text: '김고운' } });
  assert.equal(next.fallback.mode, 'degraded_ai');
  // 같은 세션의 연속된 두 응답이 **같은 모양**이어야 한다 — 한쪽만 비면 호스트는 "판정이
  // 풀렸다"로 읽고(§13-3) 축소 운영 중에 저하된 구성요소를 다시 켠다.
  assert.deepEqual(joined.fallback, next.fallback);
});

test('매체 계층이 죽은 상태의 합류는 세션을 끝낸다 — 빈 화면에 running 으로 남기지 않는다', b, async () => {
  const { core, collector, visual } = build({ samples: [sample('messaging', 'down')] });
  await core.start(startReq);
  const r = await core.start(joinReq());
  assert.equal(r.status, 'failed');
  assert.equal(r.fallback.mode, 'unavailable');
  assert.deepEqual(r.steps, []);
  // §8.1 에 종료가 남는다 — 종전에는 이 통화에 session.ended 가 없었다(점검도 Outcome 도 없다).
  const ended = collector.events.filter((e) => e.type === 'session.ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].outcome, 'FAILED');
  // 죽은 매체로 화면을 내보내지 않는다.
  assert.equal(visual.log.some((l) => l[0] === 'present'), false);
  assert.ok(visual.log.some((l) => l[0] === 'end'));
});

test('인지 계층이 죽은 상태의 합류는 상담사로 내린다 — 죽은 AI 로 고지부터 하지 않는다(§10.1)', b, async () => {
  const { core, collector, visual } = build();
  await core.start(startReq);
  breakCognition(core);
  const r = await core.start(joinReq());
  assert.equal(r.status, 'transferred');
  assert.equal(r.fallback.mode, 'agent_only');
  assert.equal(r.handoff.queue, 'q_care');
  // 합류 매체의 AI 고지가 나가지 않았다 — 추가 전용 원장에 남을 발화를 만들지 않는다.
  assert.equal(r.disclosure, undefined);
  assert.deepEqual(disclosureTurns(collector), []);
  assert.ok(visual.log.some((l) => l[0] === 'transfer'));
  assert.equal(visual.log.some((l) => l[0] === 'present'), false);
});

test('합류로 끝난 통화도 §7 5.2 점검 대상이다 — 폴백으로 끝난 통화가 먼저 열린다', b, async () => {
  const { core } = build();
  await core.start(startReq);
  breakCognition(core);
  const r = await core.start(joinReq());
  // QA 배선이 없으면 요약 자체가 실리지 않는다(종전과 같다) — 종료 경로를 탔다는 사실만 고정한다.
  assert.equal(r.status, 'transferred');
  assert.equal(core.sessions.get('i_jo1').ended, true);
});

test('이관 요약은 합류 전 통화의 맥락을 그대로 들고 간다(§2)', b, async () => {
  const { core } = build();
  await core.start(startReq);
  await core.send('i_jo1', { input: { kind: 'utterance', text: '김고운' } });
  breakCognition(core);
  const r = await core.start(joinReq());
  assert.equal(r.status, 'transferred');
  assert.match(r.handoff.summaryMasked, /customer_name|성함|김고운/);
});

test('판정은 토큰 검증 뒤다 — 낡은 링크 하나가 진행 중인 상담을 끝내지 못한다(§5.2·§10.3)', b, async () => {
  const invites = CS.createInviteRegistry();
  const { core } = build({
    samples: [sample('messaging', 'down')],
    channelSwitch: {
      invites, newToken: () => 'tk_1', ttlMs: 300000, carry: { allow: ['customer_name'] },
      reachable: () => true, delivery: 'sms',
    },
  });
  await core.start(startReq);
  await assert.rejects(() => core.start(joinReq({ joinToken: 'tk_없는토큰' })), /합류 거부/);
  // 세션은 살아 있다 — 거절된 합류가 §9.3 종료를 끌어오지 않는다.
  const rec = core.sessions.get('i_jo1');
  assert.equal(rec.ended, false);
  assert.equal(rec.state.status, 'running');
});

test('토큰이 없는 합류 시도도 세션을 끝내지 않는다', b, async () => {
  const invites = CS.createInviteRegistry();
  const { core } = build({
    channelSwitch: {
      invites, newToken: () => 'tk_1', ttlMs: 300000, carry: { allow: ['customer_name'] },
      reachable: () => true, delivery: 'sms',
    },
  });
  await core.start(startReq);
  breakCognition(core);
  await assert.rejects(() => core.start(joinReq()), /합류 거부/);
  assert.equal(core.sessions.get('i_jo1').state.status, 'running');
});
