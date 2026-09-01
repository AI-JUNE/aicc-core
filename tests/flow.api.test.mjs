import { test } from 'node:test';
import assert from 'node:assert/strict';

let runner = null, types = null, validate = null;
try {
  runner = await import('../src/flow/runner.ts');
  types = await import('../src/flow/types.ts');
  validate = await import('../src/flow/validate.ts');
} catch { /* 구형 런타임 */ }
const behavioral = { skip: runner ? false : '타입 스트리핑 미지원 런타임' };

const flow = {
  id: 'f_card_status', version: 1, startNodeId: 'ask',
  nodes: {
    ask:     { id: 'ask',     kind: 'Collect', slot: 'phone', prompt: '연락처를 말씀해 주세요.', next: 'lookup' },
    lookup:  { id: 'lookup',  kind: 'Api',     connectorId: 'crm_lookup', waitText: '조회 중입니다.', next: 'reply', onError: 'sorry' },
    reply:   { id: 'reply',   kind: 'Say',     text: '조회되었습니다.' },
    sorry:   { id: 'sorry',   kind: 'Say',     text: '지금은 조회가 어렵습니다.' },
  },
};
const ctx = { tenantId: 't_bank', interactionId: 'i_1', channel: 'voice', visualAvailable: true, now: () => '2026-09-01T00:00:00.000Z' };

test('Api 노드는 채널별로 대기 단계로 렌더된다(§5.3)', behavioral, () => {
  const node = flow.nodes.lookup;
  const voice = types.renderNode(node, 'voice');
  assert.equal(voice.text, '조회 중입니다.');
  assert.equal(voice.silent, false);
  assert.equal(voice.awaitConnectorId, 'crm_lookup');
  const silent = types.renderNode({ id: 'x', kind: 'Api', connectorId: 'c' }, 'chat');
  assert.equal(silent.silent, true);
  assert.equal(silent.text, '');
});

test('Api 노드에 도달하면 커넥터 결과를 기다린다 — Core가 직접 부르지 않는다(§6.2)', behavioral, () => {
  const r1 = runner.start(flow, ctx);
  const r2 = runner.send(flow, r1.state, { kind: 'utterance', text: '010-1234-5678' }, ctx);
  assert.equal(r2.state.status, 'running');
  assert.equal(r2.state.currentNodeId, 'lookup');
  assert.equal(r2.state.pendingConnectorId, 'crm_lookup');
  assert.equal(r2.steps.at(-1).awaitConnectorId, 'crm_lookup');
});

test('무음 대기 단계는 턴으로 집계되지 않는다(§8.1)', behavioral, () => {
  const silentFlow = { ...flow, nodes: { ...flow.nodes, lookup: { id: 'lookup', kind: 'Api', connectorId: 'crm_lookup', next: 'reply' } } };
  const r1 = runner.start(silentFlow, ctx);
  const r2 = runner.send(silentFlow, r1.state, { kind: 'utterance', text: '010-1234-5678' }, ctx);
  const botTurns = r2.events.filter(e => e.type === 'turn.completed' && e.payload.speaker === 'bot');
  assert.equal(botTurns.length, 0);
  assert.equal(r2.state.pendingConnectorId, 'crm_lookup');
});

test('조회 성공 시 슬롯이 병합되고 흐름이 이어진다', behavioral, () => {
  const r1 = runner.start(flow, ctx);
  const r2 = runner.send(flow, r1.state, { kind: 'utterance', text: '010-1234-5678' }, ctx);
  const r3 = runner.send(flow, r2.state, { kind: 'connectorResult', ok: true, slots: { card_status: '발급완료' } }, ctx);
  assert.equal(r3.state.slots.card_status, '발급완료');
  assert.equal(r3.state.pendingConnectorId, undefined);
  assert.equal(r3.state.status, 'completed');
  assert.ok(r3.steps.some(s => s.nodeId === 'reply'));
});

test('커넥터 응답은 예약 슬롯을 덮어쓸 수 없다', behavioral, () => {
  const r1 = runner.start(flow, ctx);
  const r2 = runner.send(flow, r1.state, { kind: 'utterance', text: '010-1234-5678' }, ctx);
  const r3 = runner.send(flow, r2.state, { kind: 'connectorResult', ok: true, slots: { __goal_completed__: 'true', ok: '1' } }, ctx);
  assert.equal(r3.state.slots.ok, '1');
  // 자연 종료로 Core가 스스로 설정한 값이지, 커넥터가 주입한 값이 아니다
  assert.equal(r3.state.status, 'completed');
});

test('조회 실패는 onError 분기로 빠지고 고객 실패 횟수를 올리지 않는다(§5.1)', behavioral, () => {
  const r1 = runner.start(flow, ctx);
  const r2 = runner.send(flow, r1.state, { kind: 'utterance', text: '010-1234-5678' }, ctx);
  const r3 = runner.send(flow, r2.state, { kind: 'connectorResult', ok: false, errorCode: 'timeout' }, ctx);
  assert.equal(r3.state.failCount, 0);
  assert.equal(r3.state.slots.__last_connector_error__, 'timeout');
  assert.ok(r3.steps.some(s => s.nodeId === 'sorry'));
});

test('onError가 없으면 상담사로 내려간다 — 조회 실패로 콜을 끊지 않는다(§9.3)', behavioral, () => {
  const f2 = { ...flow, nodes: { ...flow.nodes, lookup: { id: 'lookup', kind: 'Api', connectorId: 'c', next: 'reply' } } };
  const r1 = runner.start(f2, ctx);
  const r2 = runner.send(f2, r1.state, { kind: 'utterance', text: '010-1234-5678' }, ctx);
  const r3 = runner.send(f2, r2.state, { kind: 'connectorResult', ok: false, errorCode: 'unavailable' }, ctx);
  assert.equal(r3.state.status, 'transferred');
  assert.equal(r3.state.handoff.reason, 'error');
  assert.ok(r3.events.some(e => e.type === 'handoff.requested'));
});

test('대기 중 고객 발화는 흐름을 흔들지 않는다', behavioral, () => {
  const r1 = runner.start(flow, ctx);
  const r2 = runner.send(flow, r1.state, { kind: 'utterance', text: '010-1234-5678' }, ctx);
  const r3 = runner.send(flow, r2.state, { kind: 'utterance', text: '아직 멀었나요' }, ctx);
  assert.equal(r3.state.currentNodeId, 'lookup');
  assert.equal(r3.state.pendingConnectorId, 'crm_lookup');
  assert.equal(r3.events.length, 0);
});

test('늦게 도착한 커넥터 결과는 무시된다(멱등, §8.1)', behavioral, () => {
  const r1 = runner.start(flow, ctx);
  const r3 = runner.send(flow, r1.state, { kind: 'connectorResult', ok: true, slots: { x: '1' } }, ctx);
  assert.equal(r3.state.currentNodeId, 'ask');
  assert.equal(r3.state.slots.x, undefined);
  assert.equal(r3.events.length, 0);
});

test('검증기는 connectorId 누락을 오류로 잡고 onError 간선을 따라간다', behavioral, () => {
  const bad = {
    id: 'f', version: 1, startNodeId: 'a',
    nodes: {
      a: { id: 'a', kind: 'Api', connectorId: '', next: 'b', onError: 'nope' },
      b: { id: 'b', kind: 'Say', text: '끝' },
    },
  };
  const codes = validate.validateFlow(bad).issues.map(i => i.code);
  assert.ok(codes.includes('E_REQUIRED_FIELD_EMPTY'));
  assert.ok(codes.includes('E_NEXT_UNDEFINED'));  // onError 가 없는 노드를 가리킴
});

test('정상 Api 시나리오는 검증을 통과한다', behavioral, () => {
  const r = validate.validateFlow(flow);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.unreachable, []);
});

test('Api 순환은 배포를 막지 않고 경고로 남긴다', behavioral, () => {
  const loop = {
    id: 'f', version: 1, startNodeId: 'a',
    nodes: {
      a: { id: 'a', kind: 'Api', connectorId: 'c', next: 'b' },
      b: { id: 'b', kind: 'Say', text: '재조회', next: 'a' },
    },
  };
  const r = validate.validateFlow(loop);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.code === 'W_CYCLE'));
});

test('Say만으로 이루어진 순환은 여전히 오류다', behavioral, () => {
  const loop = {
    id: 'f', version: 1, startNodeId: 'a',
    nodes: {
      a: { id: 'a', kind: 'Say', text: 'x', next: 'b' },
      b: { id: 'b', kind: 'Say', text: 'y', next: 'a' },
    },
  };
  assert.ok(validate.validateFlow(loop).errors.some(e => e.code === 'E_INFINITE_LOOP'));
});

test('등록되지 않은 커넥터를 가리키는 Api 노드는 배포 전에 걸린다(§6.1)', behavioral, () => {
  assert.deepEqual(validate.validateFlowConnectors(flow, ['crm_lookup']), []);
  const issues = validate.validateFlowConnectors(flow, ['other']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'E_CONNECTOR_UNDEFINED');
  assert.equal(issues[0].nodeId, 'lookup');
});
