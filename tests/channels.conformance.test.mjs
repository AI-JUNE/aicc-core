import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
try { m = await import('../src/channels/conformance.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const flow = (over = {}) => ({
  id: 'f_test', version: 1, startNodeId: 'n1',
  nodes: { n1: { id: 'n1', kind: 'Say', text: '안녕하세요' } },
  ...over,
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('드라이런 참조 포트는 3채널 모두 적합성 검사를 통과한다', b, async () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const port = m.createDryRunPort({ id });
    const report = await m.runChannelConformance({ port, timeoutMs: 500 });
    assert.equal(report.passed, true, `${id}: ${m.formatConformanceReport(report)}`);
    assert.equal(report.errorCount, 0);
    assert.equal(report.adapter, id);
  }
});

test('드라이런 포트는 실전송을 하지 않고 호출만 기록한다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  assert.equal(port.dryRun, true);
  await port.present('i1', [{ channel: 'chat', nodeId: 'n1', kind: 'Say', text: '안녕' }]);
  await port.transfer('i1', 'q_vip', '요약');
  await port.end('i1', '완료');
  assert.deepEqual(port.calls.map((c) => c.method), ['present', 'transfer', 'end']);
  assert.equal(port.calls[0].stepCount, 1);
});

test('present 기록에 발화 원문을 남기지 않는다(§10.3)', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  await port.present('i1', [{ channel: 'voice', nodeId: 'n1', kind: 'Say', text: '카드번호 1234-5678-9012-3456' }]);
  const dump = JSON.stringify(port.calls);
  assert.ok(!dump.includes('1234-5678-9012-3456'));
});

test('능력 선언에 따라 선택 메서드가 붙고 빠진다', b, async () => {
  const noIvr = m.createDryRunPort({ id: 'chatbot' });
  assert.equal(typeof noIvr.routeToLegacyIvr, 'undefined');
  const withIvr = m.createDryRunPort({
    id: 'callbot',
    capabilities: {
      adapter: 'callbot', channel: 'voice', dtmf: true, richUi: false, speech: true,
      transferToAgent: true, routeToLegacyIvr: true, crossChannelInvite: true,
    },
  });
  assert.equal(typeof withIvr.routeToLegacyIvr, 'function');
  assert.equal(typeof withIvr.invite, 'function');
  const report = await m.runChannelConformance({ port: withIvr, timeoutMs: 500 });
  assert.equal(report.passed, true);
});

test('flows 를 주면 §5.3 렌더 가능 여부까지 검사한다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  const ok = await m.runChannelConformance({ port, flows: [flow()], timeoutMs: 500 });
  assert.equal(ok.checks.find((c) => c.id === 'FLOW_SUPPORT').passed, true);
});

test('flows·timeoutMs 미지정 시 해당 검사는 건너뛴다(임의 기본값 금지 §13-3)', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  const r = await m.runChannelConformance({ port });
  assert.equal(r.checks.find((c) => c.id === 'TIMEOUT_BUDGET').skipped, true);
  assert.equal(r.checks.find((c) => c.id === 'FLOW_SUPPORT').skipped, true);
  assert.equal(r.passed, true);
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('버튼도 DTMF도 없는 채널의 Choice 노드를 렌더 불가로 잡는다(§5.3)', b, async () => {
  const port = m.createDryRunPort({
    id: 'chatbot',
    capabilities: {
      adapter: 'chatbot', channel: 'chat', dtmf: false, richUi: false, speech: false,
      transferToAgent: true, routeToLegacyIvr: false, crossChannelInvite: false,
    },
  });
  const f = flow({ nodes: { n1: { id: 'n1', kind: 'Choice', prompt: '무엇을 도와드릴까요', options: [{ label: '조회', value: 'a' }] } } });
  const r = await m.runChannelConformance({ port, flows: [f], timeoutMs: 500 });
  assert.equal(r.passed, false);
  assert.equal(r.checks.find((c) => c.id === 'FLOW_SUPPORT').passed, false);
});

test('큐·요약 없는 이관에서 실패하면 오류로 잡는다(§9.3)', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  port.transfer = async (_id, queue) => {
    if (!queue) throw new Error('큐가 필요합니다');
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.passed, false);
  assert.equal(r.checks.find((c) => c.id === 'TRANSFER_OPTIONALS').passed, false);
});

test('빈 steps 에서 터지는 구현을 잡는다(경계조건: 빈 입력)', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  port.present = async (_id, steps) => {
    if (steps.length === 0) throw new Error('보낼 것이 없습니다');
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'EMPTY_STEPS').passed, false);
  assert.equal(r.passed, false);
});

test('입력 steps 배열을 변형하는 구현을 잡는다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  port.present = async (_id, steps) => { steps.pop(); };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'INPUT_IMMUTABLE').passed, false);
});

test('종료 중복 호출에서 터지는 구현을 잡는다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  let ended = false;
  port.end = async () => {
    if (ended) throw new Error('이미 종료됨');
    ended = true;
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'END_REPEATABLE').passed, false);
});

test('동기 예외를 던지는 구현을 비동기 계약 위반으로 잡는다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  port.present = () => { throw new Error('동기 폭발'); };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'ASYNC_CONTRACT').passed, false);
  assert.equal(r.passed, false);
});

test('예산을 넘겨 매달리는 구현을 타임아웃으로 잡는다(경계조건: 타임아웃)', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  port.present = () => new Promise(() => {});   // 영원히 정착하지 않는다
  const r = await m.runChannelConformance({ port, timeoutMs: 30 });
  assert.equal(r.checks.find((c) => c.id === 'TIMEOUT_BUDGET').passed, false);
  assert.equal(r.passed, false);
});

test('오류 메시지에 개인정보 원문을 담는 구현을 잡는다(§10.3)', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  port.present = async (id) => {
    if (id === 'i_probe_pii') throw new Error('전송 실패: 010-1234-5678');
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'PII_SAFE_ECHO').passed, false);
});

test('능력만 선언하고 구현이 없으면 정적 계약에서 등록 거부로 잡는다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  delete port.invite;   // crossChannelInvite=true 인데 구현 제거
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'REGISTRATION').passed, false);
  assert.equal(r.passed, false);
});

test('계약 버전이 다르면 등록 거부로 잡는다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  const r = await m.runChannelConformance({ port, contractVersion: 99, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'REGISTRATION').passed, false);
});

test('모르는 세션 예외는 경고이며 통과를 막지 않는다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  const orig = port.present.bind(port);
  port.present = async (id, steps) => {
    if (id === 'i_does_not_exist') throw new Error('세션 없음');
    return orig(id, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'UNKNOWN_SESSION').passed, false);
  assert.equal(r.warningCount, 1);
  assert.equal(r.errorCount, 0);
  assert.equal(r.passed, true);
});

test('리포트 포맷은 실패·건너뜀 항목만 이유와 함께 남긴다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  port.present = async () => { throw new Error('always'); };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const text = m.formatConformanceReport(r);
  assert.match(text, /chatbot\/chat/);
  assert.match(text, /실패/);
  assert.match(text, /EMPTY_STEPS/);
});
