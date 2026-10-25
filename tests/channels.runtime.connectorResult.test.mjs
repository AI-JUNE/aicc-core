// §6.1 — 되돌려받은 조회 결과를 **어느 대기의 답으로** 볼 것인가, 그리고 반영 여부를 호스트가
// 알 수 있는가.
//
// 여기서 고정하는 사고는 전부 예외가 아니다:
//  1. Runner 는 Api 노드에 도착한 `connectorResult` 를 **어느 커넥터의 답인지 묻지 않고** 수락한다.
//     조회가 연달아 있는 흐름(본인확인 → 잔액조회)에서 앞 조회의 결과가 늦게·중복 도착하면
//     **뒤 조회의 답으로 적용된다** — 슬롯은 그럴듯한 문자열이고 고객은 다른 조회의 값으로
//     채워진 안내를 듣는다. 업무시스템 호출이 느려 결과를 재전송하는 호스트가 그 모양을 만든다.
//  2. 반영되지 않은 결과도 `ok` 로 돌아간다(`steps` 0건·`events` 0건). 그 구분이 응답에 없으면
//     호스트는 "답은 들어갔다"로 읽고 다음 발화를 기다리는데, 고객 쪽에서는 아무 안내도 나오지
//     않는다 — 증상은 무음이고 어떤 알림도 울리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-25T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };

/** 조회가 연달아 있는 흐름. 두 대기의 답을 서로 바꿔 넣을 수 있는 유일한 모양이다. */
const flowChain = () => ({
  id: 'chain', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: 'account_no', prompt: '계좌번호를 말씀해 주세요.', next: 'verify' },
    verify: { id: 'verify', kind: 'Api', connectorId: 'c_verify', waitText: '확인 중입니다.', next: 'lookup' },
    lookup: { id: 'lookup', kind: 'Api', connectorId: 'c_balance', waitText: '조회 중입니다.', next: 'tell' },
    tell: { id: 'tell', kind: 'Say', text: '조회가 끝났습니다.' },
  },
});

function fakePort(id = 'callbot') {
  const log = [];
  return {
    id, log, capabilities: P.profileFor(id, {}),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue) { log.push(['transfer', iid, queue]); },
    async invite(iid, target, ticket) { log.push(['invite', iid, target, ticket]); },
    async end(iid, reason) { log.push(['end', iid, reason]); },
  };
}

function build({ flows = [flowChain()] } = {}) {
  const port = fakePort();
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS[port.id], contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    bus: B.createEventBus({
      scope: SCOPE, sinks: [], store: B.createMemoryIdempotencyStore({ maxKeys: 200 }),
      releaseKeyOnSinkFailure: false,
    }),
    now: () => NOW,
    newInteractionId: () => 'i_c1',
  });
  return { core, port };
}

const req = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'chain', ...over });

/** 첫 대기(c_verify)까지 밀어 둔다. */
async function atFirstWait() {
  const { core, port } = build();
  await core.start(req());
  const r = await core.send('i_c1', { input: { kind: 'utterance', text: '110-1234' } });
  assert.equal(r.state.pendingConnectorId, 'c_verify');
  return { core, port };
}

test('선언 없는 커넥터 결과는 종전과 완전히 같다 — 반영되고 사실만 적힌다(§13-3)', b, async () => {
  const { core } = await atFirstWait();
  const r = await core.send('i_c1', { input: { kind: 'connectorResult', ok: true, slots: { verified: 'Y' } } });
  assert.equal(r.state.slots.verified, 'Y');
  assert.equal(r.connector.resultApplied, true);
  // 다음 대기가 섰다 — 호스트는 한 번 더 답해야 한다. 이 값이 없으면 통화는 무음으로 멈춘다.
  assert.equal(r.connector.pendingConnectorId, 'c_balance');
  assert.equal(r.state.pendingConnectorId, 'c_balance');
  assert.equal(r.connector.reasonKo, undefined, '반영된 턴에 사유가 실렸다');
});

test('앞 조회의 결과가 뒤 조회의 답으로 적용되지 않는다 — 선언이 어긋나면 반영하지 않는다(§6.1)', b, async () => {
  const { core } = await atFirstWait();
  // 첫 대기를 정상적으로 답해 두 번째 대기(c_balance)가 서게 한다.
  await core.send('i_c1', { input: { kind: 'connectorResult', ok: true, connectorId: 'c_verify', slots: { verified: 'Y' } } });
  // 업무시스템 호출이 느려 **앞 조회 결과가 다시** 도착했다(전송 계층 재시도).
  const stale = await core.send('i_c1', {
    input: { kind: 'connectorResult', ok: true, connectorId: 'c_verify', slots: { verified: 'N', balance: '0' } },
  });
  assert.equal(stale.connector.resultApplied, false);
  assert.equal(stale.connector.pendingConnectorId, 'c_balance');
  assert.match(stale.connector.reasonKo, /c_balance/);
  assert.equal(stale.state.slots.verified, 'Y', '앞 조회의 늦은 값이 슬롯을 덮었다');
  assert.equal(stale.state.slots.balance, undefined, '다른 조회의 값이 이 대기의 답으로 들어갔다');
  assert.equal(stale.state.pendingConnectorId, 'c_balance', '반영하지 않았는데 대기가 사라졌다');
  assert.deepEqual(stale.events, [], '반영하지 않은 턴이 이벤트를 만들었다');
  // 대기는 그대로 서 있으므로 **옳은 선언으로 다시 답할 수 있다**.
  const ok = await core.send('i_c1', { input: { kind: 'connectorResult', ok: true, connectorId: 'c_balance', slots: { balance: '10000' } } });
  assert.equal(ok.connector.resultApplied, true);
  assert.equal(ok.state.slots.balance, '10000');
  assert.equal(ok.status, 'completed');
});

test('어긋난 선언은 경고로 남는다(W_CONNECTOR_STALE) — 조용히 버리지 않는다', b, async () => {
  const { core } = await atFirstWait();
  await core.send('i_c1', { input: { kind: 'connectorResult', ok: true, connectorId: 'c_nonexistent' } });
  const codes = core.warnings().map((w) => w.code);
  assert.ok(codes.includes('W_CONNECTOR_STALE'), JSON.stringify(codes));
});

test('서 있는 대기가 없으면 늦게 온 결과로 보고 반영하지 않으며, 그 사실을 돌려준다(§8.1)', b, async () => {
  const { core } = build();
  await core.start(req());
  // 아직 Api 노드에 닿지 않았다 — 대기가 없다.
  const r = await core.send('i_c1', { input: { kind: 'connectorResult', ok: true, slots: { verified: 'Y' } } });
  assert.equal(r.connector.resultApplied, false);
  assert.match(r.connector.reasonKo, /대기/);
  assert.equal(r.connector.pendingConnectorId, undefined);
  assert.equal(r.state.slots.verified, undefined);
});

test('반영 사실은 커넥터 결과가 아닌 턴에는 실리지 않는다', b, async () => {
  const { core } = await atFirstWait();
  // 대기 중의 발화는 §6.1 구간이라 흐름을 흔들지 않는다 — 그 턴에 반영 사실을 적을 일도 없다.
  const r = await core.send('i_c1', { input: { kind: 'utterance', text: '여보세요' } });
  assert.equal(r.connector, undefined);
});

test('어긋난 선언으로 보낸 실측은 "실렸다"로 적히지 않는다(§11.2)', b, async () => {
  const { core } = await atFirstWait();
  const r = await core.send('i_c1', {
    input: { kind: 'connectorResult', ok: true, connectorId: 'c_other' },
    usage: { stt_audio_ms: 900 },
  });
  assert.equal(r.connector.resultApplied, false);
  assert.equal(r.billing.usageAttached, false);
  assert.match(r.billing.usageReasonKo, /§11\.2/);
});

test('끝난 세션의 늦은 입력은 직전 턴의 반영 사실을 다시 보고하지 않는다', b, async () => {
  const { core } = await atFirstWait();
  await core.send('i_c1', { input: { kind: 'connectorResult', ok: true, connectorId: 'c_verify' } });
  const done = await core.send('i_c1', { input: { kind: 'connectorResult', ok: true, connectorId: 'c_balance' } });
  assert.equal(done.connector.resultApplied, true);
  assert.equal(done.status, 'completed');
  // 재전송된 같은 결과. 세션은 이미 끝났고 **아무것도 반영되지 않았다**.
  const late = await core.send('i_c1', { input: { kind: 'connectorResult', ok: true, connectorId: 'c_balance' } });
  assert.equal(late.connector, undefined, '아무것도 반영하지 않은 호출이 반영 사실을 들고 돌아왔다');
  assert.deepEqual(late.events, []);
});
