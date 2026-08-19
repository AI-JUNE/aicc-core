import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Node 22+ 는 .ts 를 타입 스트리핑으로 직접 import 한다. 미지원 런타임에서는 구조 검증만 수행한다.
let runner = null, events = null;
try {
  runner = await import('../src/flow/runner.ts');
  events = await import('../src/events/schema.ts');
} catch { /* 구형 런타임 — 아래 behavioral 테스트는 skip */ }
const behavioral = { skip: runner ? false : '타입 스트리핑 미지원 런타임' };

const flow = {
  id: 'f_card_reissue', version: 1, startNodeId: 'greet',
  nodes: {
    greet:   { id: 'greet',   kind: 'Say',      text: '안녕하세요.', next: 'ask' },
    ask:     { id: 'ask',     kind: 'Collect',  slot: 'phone', prompt: '연락처를 말씀해 주세요.', next: 'menu' },
    menu:    { id: 'menu',    kind: 'Choice',   prompt: '무엇을 도와드릴까요?', options: [
                 { label: '재발급', value: 'reissue', next: 'confirm' },
                 { label: '분실신고', value: 'lost', next: 'toAgent' } ] },
    confirm: { id: 'confirm', kind: 'Confirm',  prompt: '재발급 신청할까요?', onYes: 'bye', onNo: 'toAgent' },
    bye:     { id: 'bye',     kind: 'Say',      text: '처리했습니다.' },
    toAgent: { id: 'toAgent', kind: 'Transfer', queue: 'card_team', reason: 'policy' },
  },
};
const ctx = (over = {}) => ({
  tenantId: 't1', interactionId: 'i1', channel: 'voice', visualAvailable: true,
  now: () => '2026-01-01T00:00:00.000Z', ...over,
});

test('§5.3 FlowRunner 모듈이 존재하고 순수 진입점을 노출한다', () => {
  const s = read('src/flow/runner.ts');
  assert.match(s, /export function start/);
  assert.match(s, /export function send/);
});

test('§5.3 Say 노드는 입력 없이 다음 노드까지 자동 진행한다', behavioral, () => {
  const r = runner.start(flow, ctx());
  assert.equal(r.state.status, 'running');
  assert.equal(r.state.currentNodeId, 'ask');
  assert.deepEqual(r.steps.map(s => s.nodeId), ['greet', 'ask']);
});

test('§5.3 Collect→Choice→Confirm 정상 경로가 완결된다', behavioral, () => {
  const c = ctx();
  let r = runner.start(flow, c);
  r = runner.send(flow, r.state, { kind: 'utterance', text: '010-1234-5678' }, c);
  assert.equal(r.state.currentNodeId, 'menu');
  r = runner.send(flow, r.state, { kind: 'dtmf', digits: '1' }, c);
  assert.equal(r.state.currentNodeId, 'confirm');
  r = runner.send(flow, r.state, { kind: 'utterance', text: '네' }, c);
  assert.equal(r.state.status, 'completed');
  assert.equal(r.state.slots['__goal_completed__'], 'true');
});

test('§10.3 수집 슬롯·이벤트 발화는 마스킹을 통과한다', behavioral, () => {
  const c = ctx();
  let r = runner.start(flow, c);
  r = runner.send(flow, r.state, { kind: 'utterance', text: '010-1234-5678' }, c);
  const turn = r.events.find(e => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.equal(turn.pii_masked, true);
  assert.equal(/010-1234-5678/.test(turn.utterance_masked), false);
});

test('§5.1 2회 실패 시 화면 전환, 3회 실패 시 상담사 이관', behavioral, () => {
  const c = ctx();
  let r = runner.start(flow, c);
  r = runner.send(flow, r.state, { kind: 'timeout' }, c);
  assert.equal(r.state.lastFallback, 'retry');
  assert.equal(r.state.channel, 'voice');
  r = runner.send(flow, r.state, { kind: 'timeout' }, c);
  assert.equal(r.state.lastFallback, 'switch_to_visual');
  assert.equal(r.state.channel, 'visual');
  r = runner.send(flow, r.state, { kind: 'timeout' }, c);
  assert.equal(r.state.status, 'transferred');
  assert.equal(r.state.handoff.reason, 'max_retry');
  assert.equal(r.events.some(e => e.type === 'handoff.requested'), true);
});

test('§5.1 화면 전환 불가 세션은 2회 실패에서 바로 이관된다', behavioral, () => {
  const c = ctx({ visualAvailable: false });
  let r = runner.start(flow, c);
  r = runner.send(flow, r.state, { kind: 'timeout' }, c);
  r = runner.send(flow, r.state, { kind: 'timeout' }, c);
  assert.equal(r.state.status, 'transferred');
});

test('§5.3 Transfer 노드는 세션을 이관 상태로 종료한다', behavioral, () => {
  const c = ctx();
  let r = runner.start(flow, c);
  r = runner.send(flow, r.state, { kind: 'utterance', text: '홍길동' }, c);
  r = runner.send(flow, r.state, { kind: 'dtmf', digits: '2' }, c);
  assert.equal(r.state.status, 'transferred');
  assert.equal(r.state.handoff.queue, 'card_team');
});

test('신뢰도 임계값은 설정된 경우에만 게이팅한다(임의 수치 미내장 §13-3)', behavioral, () => {
  const s = read('src/flow/runner.ts');
  assert.match(s, /minConfidence\?: number/);
  const c = ctx({ minConfidence: 0.7 });
  let r = runner.start(flow, c);
  r = runner.send(flow, r.state, { kind: 'utterance', text: '홍길동', confidence: 0.1 }, c);
  assert.equal(r.state.failCount, 1);
});

test('send는 입력 state를 변형하지 않는다(순수)', behavioral, () => {
  const c = ctx();
  const r0 = runner.start(flow, c);
  const before = JSON.stringify(r0.state);
  runner.send(flow, r0.state, { kind: 'utterance', text: '홍길동' }, c);
  assert.equal(JSON.stringify(r0.state), before);
});

test('미정의 next는 실패로 종료된다(무한루프 방지)', behavioral, () => {
  const broken = { ...flow, nodes: { ...flow.nodes, greet: { id: 'greet', kind: 'Say', text: 'hi', next: 'nope' } } };
  const r = runner.start(broken, ctx());
  assert.equal(r.state.status, 'failed');
  assert.match(r.state.error, /정의되지 않은 노드/);
});
