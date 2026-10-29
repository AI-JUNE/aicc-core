// 합류(§5.2)가 세션을 옮기는 일을 **반만** 했다 — 렌더러는 바꾸고, 그 단계를 받을 매체는 그대로 뒀다.
//
// `join` 은 `state.channel` 을 합류 매체로 바꾼다(같은 Interaction 을 유지한 채 렌더러만 교체하는
// 것이 §5.2 다). 그런데 세션 레코드의 `adapter` 는 그대로였고, `send`·`end` 는 **그 값으로 포트를
// 고른다**(`registration(rec.adapter)`). 그래서 한 세션의 연속된 두 턴이 서로 다른 매체로 나갔다:
//  - 합류 턴은 화면 포트로 `present` 되고(그 자리는 합류 어댑터의 등록을 쓴다),
//  - **그 다음 턴부터는 화면용으로 렌더된 단계가 음성 포트로** 나간다. 화면을 보는 고객에게는
//    아무것도 도착하지 않고(전환을 고른 이유가 인식 실패인데 그 고객은 이제 어떤 말도 들려줄 수
//    없는 화면을 본다), 통화 쪽에서는 버튼 목록이 합성되어 나간다.
//  - §9.3 이관 지시(`port.transfer`)와 종료(`port.end`)도 고객이 떠난 매체로 간다 — 화면은 닫히지
//    않고, 상담사 연결은 통화 쪽에 접수된다.
// 어느 쪽도 예외가 아니고 오류 응답도 아니다.
//
// 그리고 **이 시나리오를 합류 매체가 렌더할 수 있는지 아무도 묻지 않았다**(§5.3). `start` 는 같은
// 검사를 하고 거절한다("통화 중간에 막히는 것이 더 나쁘다") — 그런데 같은 시나리오가 다른 채널로
// 옮겨 가는 자리는 합류 하나뿐이고, 시작에서 통과한 것은 **음성 능력** 기준이었다. 막히는 것은
// 합류 턴이 아니라 **그 뒤 어느 턴**이라 더 조용하다. 검사는 **토큰을 상환하기 전에** 한다 —
// 상환 뒤에 거절하면 1회용 초대가 타 버려 고객은 같은 링크를 다시 눌러도 들어올 수 없다.
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

const NOW = '2026-10-28T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };

/** 두 칸을 묻는 시나리오 — 합류 뒤에도 턴이 더 남아 있어야 포트가 어디로 가는지 볼 수 있다. */
const flowAsk = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요, 고운 고객센터입니다.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.', next: 'ask2' },
    ask2: { id: 'ask2', kind: 'Collect', slot: 'inquiry', prompt: '어떤 내용인지 말씀해 주세요.', next: 'to_agent' },
    to_agent: { id: 'to_agent', kind: 'Transfer', queue: 'q_care', reason: 'policy' },
  },
};

/** 버튼·DTMF 중 하나는 있어야 렌더되는 노드(§5.3 `checkFlowSupported`). */
const flowChoice = {
  id: 'choice', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'pick' },
    pick: {
      id: 'pick', kind: 'Choice', prompt: '무엇을 도와드릴까요?',
      options: [{ label: '요금', next: 'bill' }, { label: '해지', next: 'bill' }],
    },
    bill: { id: 'bill', kind: 'Say', text: '요금 안내입니다.' },
  },
};

function fakePort(id = 'callbot', capsOver = {}) {
  const log = [];
  return {
    id, log,
    capabilities: P.profileFor(id, capsOver),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue, summary) { log.push(['transfer', iid, queue, summary]); },
    async invite(iid, target, ticket) { log.push(['invite', iid, target, ticket]); },
    async end(iid, reason) { log.push(['end', iid, reason]); },
  };
}

function build({ flows = [flowAsk], ports, channelSwitch } = {}) {
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 300 }), releaseKeyOnSinkFailure: false,
  });
  const list = ports ?? [fakePort('callbot'), fakePort('dars')];
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry(flows),
    channels: list.map((port) => ({
      port, reportsComponents: P.CHANNEL_COMPONENTS[port.id], contractVersion: 1,
    })),
    policy: {
      tenantId: 'goone', staleAfterMs: 600000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true, fallbackQueue: 'q_care',
    },
    health: F.createHealthRegistry([]),
    bus, now: () => NOW, newInteractionId: () => 'i_jc1',
    ...(channelSwitch !== undefined ? { channelSwitch } : {}),
  });
  return { core, collector, voice: list[0], visual: list[1] };
}

const startReq = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing', ...over });
const joinReq = (over = {}) => ({ scope: SCOPE, adapter: 'dars', flowId: 'billing', joinInteractionId: 'i_jc1', ...over });
const presents = (port) => port.log.filter((l) => l[0] === 'present');

function switchWiring(over = {}) {
  const invites = CS.createInviteRegistry();
  return {
    invites,
    binding: {
      invites, newToken: () => 'tk_jc_1', ttlMs: 300000, carry: { allow: [] },
      reachable: () => true, delivery: 'sms', ...over,
    },
  };
}

test('합류 뒤의 턴은 합류한 매체로 나간다 — 화면용 단계를 통화로 내보내지 않는다(§5.2)', b, async () => {
  const { core, voice, visual } = build();
  await core.start(startReq());
  await core.start(joinReq());
  const beforeVoice = presents(voice).length;
  const r = await core.send('i_jc1', { input: { kind: 'utterance', text: '김고운' } });
  assert.equal(r.state.channel, 'visual');
  assert.equal(presents(voice).length, beforeVoice, '화면용으로 렌더된 단계가 음성 포트로 나갔다');
  assert.ok(presents(visual).length >= 2, '화면을 보는 고객에게 아무것도 도착하지 않았다');
});

test('합류 뒤의 §9.3 이관 지시도 합류한 매체가 받는다 — 떠난 매체에 접수되지 않는다', b, async () => {
  const { core, voice, visual } = build();
  await core.start(startReq());
  await core.start(joinReq());
  await core.send('i_jc1', { input: { kind: 'utterance', text: '김고운' } });
  const r = await core.send('i_jc1', { input: { kind: 'utterance', text: '요금 문의' } });
  assert.equal(r.status, 'transferred');
  assert.ok(visual.log.some((l) => l[0] === 'transfer'), '이관이 화면 포트에 접수되지 않았다');
  assert.equal(voice.log.some((l) => l[0] === 'transfer'), false);
});

test('종료도 합류한 매체를 닫는다 — 화면이 열린 채 남지 않는다', b, async () => {
  const { core, voice, visual } = build();
  await core.start(startReq());
  await core.start(joinReq());
  await core.end('i_jc1', '고객 종료');
  assert.ok(visual.log.some((l) => l[0] === 'end'));
  assert.equal(voice.log.some((l) => l[0] === 'end'), false);
});

test('세션 레코드에도 합류 매체가 남는다 — 영속 저장소에서 다음 호출이 같은 답을 본다(§6.2)', b, async () => {
  const { core } = build();
  await core.start(startReq());
  await core.start(joinReq());
  const rec = core.sessions.get('i_jc1');
  assert.equal(rec.adapter, 'dars');
  assert.equal(rec.state.channel, 'visual');
  assert.deepEqual(rec.channels, ['voice', 'visual']);
});

test('거절된 합류는 세션을 옮기지 않는다 — 통화는 종전 매체에서 그대로 이어진다', b, async () => {
  const sw = switchWiring();
  const { core, voice, visual } = build({ channelSwitch: sw.binding });
  await core.start(startReq());
  await assert.rejects(() => core.start(joinReq()), /초대 토큰이 없습니다/);
  const rec = core.sessions.get('i_jc1');
  assert.equal(rec.adapter, 'callbot');
  assert.equal(rec.state.channel, 'voice');
  const before = presents(visual).length;
  await core.send('i_jc1', { input: { kind: 'utterance', text: '김고운' } });
  assert.ok(presents(voice).length >= 2, '거절된 합류가 통화의 단계를 다른 매체로 보냈다');
  assert.equal(presents(visual).length, before);
});

test('합류 매체가 렌더할 수 없는 시나리오는 합류를 거절한다 — 통화 중간에 막히는 쪽이 더 나쁘다(§5.3)', b, async () => {
  // 화면에서 버튼·DTMF 가 모두 없는 배치(고객사 사정으로 능력을 좁힌 경우). 시작은 음성 능력
  // (DTMF)으로 통과했으므로, 이 시나리오가 화면 능력으로 검사되는 자리는 합류 하나뿐이다.
  const { core, visual } = build({
    flows: [flowChoice],
    ports: [fakePort('callbot'), fakePort('dars', { richUi: false })],
  });
  await core.start(startReq({ flowId: 'choice' }));
  await assert.rejects(
    () => core.start(joinReq({ flowId: 'choice' })),
    /합류 거부: dars 채널에서 렌더할 수 없는 시나리오입니다/,
  );
  // 죽은 합류가 화면에 아무것도 내보내지 않는다 — 고를 것이 없는 화면을 띄우지 않는다.
  assert.equal(presents(visual).length, 0);
  const rec = core.sessions.get('i_jc1');
  assert.equal(rec.adapter, 'callbot');
  assert.equal(rec.state.channel, 'voice');
});

test('렌더 불가로 거절할 때 1회용 초대를 태우지 않는다 — 같은 링크를 다시 쓸 수 있다(§5.2·§10.3)', b, async () => {
  const sw = switchWiring();
  const { core } = build({
    flows: [flowChoice],
    ports: [fakePort('callbot'), fakePort('dars', { richUi: false })],
    channelSwitch: sw.binding,
  });
  await core.start(startReq({ flowId: 'choice' }));
  const issued = sw.invites.issue({
    scope: SCOPE, interactionId: 'i_jc1', fromChannel: 'voice', toChannel: 'visual',
    reason: 'customer_request', delivery: 'sms', token: 'tk_jc_keep', issuedAt: NOW,
    ttlMs: 300000, carry: { allow: [] }, crossChannelInviteSupported: true,
  });
  await assert.rejects(
    () => core.start(joinReq({ flowId: 'choice', joinToken: issued.token })),
    /렌더할 수 없는 시나리오/,
  );
  // 토큰이 상환되지 않았다 — 상환됐으면 여기서 `already_redeemed` 로 거절된다.
  const redeemed = sw.invites.redeem({ token: issued.token, scope: SCOPE, channel: 'visual', at: NOW });
  assert.equal(redeemed.ok, true, '거절된 합류가 1회용 초대를 태웠다 — 고객은 같은 링크로 다시 들어올 수 없다');
});

test('렌더할 수 있는 시나리오의 합류는 종전과 완전히 같다(§13-3)', b, async () => {
  const { core, visual } = build({ flows: [flowChoice], ports: [fakePort('callbot'), fakePort('dars')] });
  await core.start(startReq({ flowId: 'choice' }));
  const r = await core.start(joinReq({ flowId: 'choice' }));
  assert.equal(r.state.channel, 'visual');
  assert.equal(r.status, 'running');
  assert.ok(presents(visual).length >= 1);
});

// ── 거절은 **고르기 전에** 해야 한다(§5.2·§5.3) ──────────────────────────────
//
// 위 거절은 고객이 **이미 링크를 누른 뒤**다. 그 시점에는 되돌릴 것이 남아 있지 않다:
// §5.1 사다리는 전환 칸을 이미 써 버렸고(`state.channel` 이 화면으로 바뀌어 통화 중인 고객이
// 화면용 단계를 듣는다) 호스트는 링크까지 발송했다. 고객이 받는 것은 "이 화면에서 열 수 없다"
// 이고 상담사로 내려갈 경로는 그 통화에 남아 있지 않다 — 어디에서도 예외가 나지 않는다.
// 그래서 사다리가 **고르기 전에** 목적지 포트의 능력으로 같은 검사를 한다.

/** 두 번 실패하면 §5.1 사다리가 전환을 고르는 시나리오 + 화면 능력이 필요한 노드. */
const flowRetryChoice = {
  id: 'retrychoice', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.', next: 'pick' },
    pick: {
      id: 'pick', kind: 'Choice', prompt: '무엇을 도와드릴까요?',
      options: [{ label: '요금', next: 'bill' }, { label: '해지', next: 'bill' }],
    },
    bill: { id: 'bill', kind: 'Say', text: '요금 안내입니다.' },
  },
};
const ladderReq = (over = {}) => startReq({ flowId: 'retrychoice', ...over });
const twice = async (core) => {
  await core.send('i_jc1', { input: { kind: 'timeout' } });
  return core.send('i_jc1', { input: { kind: 'timeout' } });
};

test('목적지가 이 시나리오를 렌더할 수 없으면 사다리는 전환을 고르지 않는다(§5.1·§5.3)', b, async () => {
  const sw = switchWiring();
  const voice = fakePort('callbot');
  const { core } = build({
    flows: [flowRetryChoice],
    ports: [voice, fakePort('dars', { richUi: false })],
    channelSwitch: sw.binding,
  });
  await core.start(ladderReq());
  const r = await twice(core);
  // 통화 중인 고객에게 화면용 단계를 들려주지 않고, 링크도 만들지 않는다.
  assert.equal(r.state.channel, 'voice');
  assert.equal(r.switchInvite, undefined);
  assert.equal(voice.log.some((l) => l[0] === 'invite'), false);
  // 사다리는 다음 칸으로 간다 — 고객은 상담사에게 닿는다.
  assert.equal(r.status, 'transferred');
  assert.ok(voice.log.some((l) => l[0] === 'transfer'));
  // 1회용 초대가 발급되지도 않았다(태울 링크 자체가 없다).
  assert.equal(sw.invites.get('tk_jc_1', SCOPE), undefined);
});

test('배선이 없어도 같은 검사를 한다 — 토큰 없는 초대였을 뿐 막히는 자리는 같다', b, async () => {
  const voice = fakePort('callbot');
  const { core } = build({
    flows: [flowRetryChoice],
    ports: [voice, fakePort('dars', { richUi: false })],
  });
  await core.start(ladderReq());
  const r = await twice(core);
  assert.equal(r.state.channel, 'voice');
  assert.equal(r.status, 'transferred');
  assert.equal(voice.log.some((l) => l[0] === 'invite'), false);
});

test('렌더할 수 있는 목적지면 전환은 종전과 완전히 같다(§13-3)', b, async () => {
  const sw = switchWiring();
  const voice = fakePort('callbot');
  const { core } = build({
    flows: [flowRetryChoice],
    ports: [voice, fakePort('dars')],
    channelSwitch: sw.binding,
  });
  await core.start(ladderReq());
  const r = await twice(core);
  assert.equal(r.state.channel, 'visual');
  assert.equal(r.switchInvite.ticketIssued, true);
  assert.ok(voice.log.some((l) => l[0] === 'invite'));
  // 그리고 그 초대로 실제로 합류할 수 있다 — 고르기 전 검사와 상환 전 검사가 같은 답을 낸다(§2).
  const joined = await core.start(joinReq({ flowId: 'retrychoice', joinToken: 'tk_jc_1' }));
  assert.equal(joined.state.channel, 'visual');
  assert.equal(joined.status, 'running');
});

test('목적지가 이 프로세스에 없으면 묻지 않는다 — 능력을 추정해 전환을 막지 않는다(§13-3)', b, async () => {
  // 합류가 다른 프로세스에서 일어나는 배치. 그 포트의 능력은 여기서 알 수 없으므로 종전대로
  // 채널 능력(crossChannelInvite)만 보고 전환을 고른다 — 검사는 합류 쪽에서 돈다.
  const voice = fakePort('callbot');
  const { core } = build({ flows: [flowRetryChoice], ports: [voice] });
  await core.start(ladderReq());
  const r = await twice(core);
  assert.equal(r.state.channel, 'visual');
  assert.equal(r.switchInvite.tokenless, true);
  assert.ok(voice.log.some((l) => l[0] === 'invite'));
});
