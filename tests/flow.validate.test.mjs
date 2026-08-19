import { test } from 'node:test';
import assert from 'node:assert/strict';

let v = null;
try { v = await import('../src/flow/validate.ts'); } catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: v ? false : '타입 스트리핑 미지원 런타임' };

const good = {
  id: 'f_ok', version: 1, startNodeId: 'greet',
  nodes: {
    greet:   { id: 'greet',   kind: 'Say',     text: '안녕하세요.', next: 'menu' },
    menu:    { id: 'menu',    kind: 'Choice',  prompt: '무엇을 도와드릴까요?', options: [
                 { label: '조회', value: 'lookup', next: 'ask' },
                 { label: '상담', value: 'agent',  next: 'toAgent' } ] },
    ask:     { id: 'ask',     kind: 'Collect', slot: 'name', prompt: '성함을 말씀해 주세요.', maxRetry: 2, next: 'confirm' },
    confirm: { id: 'confirm', kind: 'Confirm', prompt: '맞습니까?', onYes: 'bye', onNo: 'menu' },
    bye:     { id: 'bye',     kind: 'Say',     text: '감사합니다.' },
    toAgent: { id: 'toAgent', kind: 'Transfer', queue: 'q_general' },
  },
};

const codes = (r) => r.issues.map(i => i.code);

test('정상 Flow는 오류 0건 — 입력으로 벗어날 수 있는 순환은 경고', behavioral, () => {
  const r = v.validateFlow(good);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.ok, true);
  assert.equal(v.canPublish(good), true);
  assert.ok(codes(r).includes('W_CYCLE'));           // confirm --onNo--> menu
  assert.equal(r.unreachable.length, 0);
});

test('미정의 next 검출', behavioral, () => {
  const f = structuredClone(good);
  f.nodes.greet.next = 'nowhere';
  const r = v.validateFlow(f);
  const issue = r.errors.find(i => i.code === 'E_NEXT_UNDEFINED');
  assert.ok(issue);
  assert.equal(issue.nodeId, 'greet');
  assert.equal(issue.field, 'next');
  assert.equal(v.canPublish(f), false);
});

test('도달 불가 노드 검출', behavioral, () => {
  const f = structuredClone(good);
  f.nodes.orphan = { id: 'orphan', kind: 'Say', text: '아무도 오지 않는 노드' };
  const r = v.validateFlow(f);
  assert.deepEqual(r.unreachable, ['orphan']);
  assert.ok(r.warnings.some(i => i.code === 'W_UNREACHABLE_NODE' && i.nodeId === 'orphan'));
  assert.equal(r.ok, true);                          // 경고는 배포를 막지 않는다
});

test('입력 대기 없는 Say 순환은 오류', behavioral, () => {
  const f = {
    id: 'f_loop', version: 1, startNodeId: 'a',
    nodes: {
      a: { id: 'a', kind: 'Say', text: '가', next: 'b' },
      b: { id: 'b', kind: 'Say', text: '나', next: 'a' },
    },
  };
  const r = v.validateFlow(f);
  const issue = r.errors.find(i => i.code === 'E_INFINITE_LOOP');
  assert.ok(issue);
  assert.deepEqual([...issue.path].sort(), ['a', 'b']);
});

test('필수 필드 누락·중복 선택지·maxRetry 검출', behavioral, () => {
  const f = structuredClone(good);
  f.nodes.bye.text = '   ';
  f.nodes.toAgent.queue = '';
  f.nodes.ask.maxRetry = -1;
  f.nodes.menu.options[1].value = 'lookup';
  const r = v.validateFlow(f);
  const c = codes(r);
  assert.equal(r.errors.filter(i => i.code === 'E_REQUIRED_FIELD_EMPTY').length, 2);
  assert.ok(c.includes('E_MAX_RETRY_INVALID'));
  assert.ok(c.includes('E_CHOICE_DUPLICATE_VALUE'));
});

test('시작 노드·노드 id 불일치·flow 메타 검출', behavioral, () => {
  const r1 = v.validateFlow({ ...good, startNodeId: 'missing' });
  assert.ok(r1.errors.some(i => i.code === 'E_START_UNDEFINED'));
  assert.deepEqual(r1.reachable, []);

  const f2 = structuredClone(good);
  f2.nodes.bye.id = 'farewell';
  assert.ok(v.validateFlow(f2).errors.some(i => i.code === 'E_NODE_ID_MISMATCH'));

  const r3 = v.validateFlow({ id: '', version: 0, startNodeId: 'x', nodes: {} });
  const c3 = codes(r3);
  for (const code of ['E_FLOW_ID_EMPTY', 'E_FLOW_VERSION_INVALID', 'E_NO_NODES', 'E_START_UNDEFINED']) {
    assert.ok(c3.includes(code), code);
  }
});

test('나갈 길 없는 시나리오는 W_NO_EXIT — Transfer는 종단으로 본다', behavioral, () => {
  const f = {
    id: 'f_noexit', version: 1, startNodeId: 'q',
    nodes: { q: { id: 'q', kind: 'Confirm', prompt: '계속할까요?', onYes: 'q', onNo: 'q' } },
  };
  assert.ok(v.validateFlow(f).warnings.some(i => i.code === 'W_NO_EXIT'));
  assert.equal(v.edgesOf(good.nodes.toAgent).length, 0);
});
