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

test('받은 단계를 오류에 그대로 되뱉는 구현을 잡는다 — 탐침이 마스킹돼 있으면 영영 못 잡는다(§10.3)', b, async () => {
  // 가장 흔한 모양은 원문을 손으로 적는 포트가 아니라 **입력을 그대로 되뱉는** 포트다
  // (`throw new Error(JSON.stringify(steps))`). 탐침을 마스킹해서 넣던 동안 이 포트는
  // 전 검사를 통과했다 — 포트에 원문을 준 적이 없으므로 "원문이 섞였나"는 언제나 거짓이었다.
  const port = m.createDryRunPort({ id: 'chatbot' });
  port.present = async (id, steps) => {
    throw new Error(`전송 실패(${id}): ${JSON.stringify(steps)}`);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const check = r.checks.find((c) => c.id === 'PII_SAFE_ECHO');
  assert.equal(check.passed, false);
  assert.equal(r.passed, false);
  // 보고서 자체가 CI 로그다 — 탐침 값을 실패 문구에 싣지 않는다.
  assert.equal(JSON.stringify(r).includes('010-1234-5678'), false);
  assert.equal(m.formatConformanceReport(r).includes('010-1234-5678'), false);
});

test('단계를 삼키지 않고 지나가는 구현은 그대로 통과한다(§10.3 — 단계 본문은 마스킹 대상이 아니다)', b, async () => {
  // 단계 본문에는 마스킹되지 않은 값이 실린다(고객에게 자기 번호를 읽어 주지 못하면 상담이
  // 성립하지 않는다). §10.3 이 요구하는 것은 **그 값을 오류·로그로 옮기지 않는 것**이다.
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const r = await m.runChannelConformance({ port: m.createDryRunPort({ id }), timeoutMs: 500 });
    assert.equal(r.checks.find((c) => c.id === 'PII_SAFE_ECHO').passed, true, id);
  }
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

// ── 재시도·타이밍 힌트 (§5.1) ───────────────────────────────────────────────
// 정책을 켜는 것은 코드 배포가 아니라 설정 변경이다. 그 순간 전 통화가 깨지면 안 된다.

test('힌트가 붙은 단계를 흡수하는 구현은 TURN_HINTS 를 통과한다', b, async () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const port = m.createDryRunPort({ id });
    const r = await m.runChannelConformance({ port, timeoutMs: 500 });
    const c = r.checks.find((x) => x.id === 'TURN_HINTS');
    assert.equal(c.passed, true, `${id}: ${c.messageKo}`);
    assert.notEqual(c.skipped, true);
  }
});

test('모르는 필드가 있다고 예외를 던지는 구현을 잡는다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  port.present = async (_id, steps) => {
    for (const s of steps) {
      if ('reprompt' in s || 'inputTimeoutMs' in s) throw new Error('알 수 없는 필드입니다');
    }
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'TURN_HINTS').passed, false);
  assert.equal(r.passed, false);
});

test('힌트가 붙은 단계를 고쳐 쓰는 구현을 잡는다(이벤트·이력 오염)', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  port.present = async (_id, steps) => { for (const s of steps) delete s.reprompt; };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'TURN_HINTS').passed, false);
});

// ── Api 대기 이행 (§6.1) ─────────────────────────────────────────────────────

test('CONNECTOR_WAIT: 한 턴에 present 가 두 번 오는 것을 흡수하면 통과한다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'CONNECTOR_WAIT');
  assert.equal(c.passed, true, c.messageKo);
  assert.equal(c.severity, 'error');
});

test('CONNECTOR_WAIT: 한 턴 = present 한 번으로 가정한 포트를 잡는다 — 배선을 켜는 순간 깨진다', b, async () => {
  // 화면을 통째로 갈아 끼우는 구현에서 흔한 일회성 가드. 커넥터 배선이 없는 동안에는
  // 아무 문제도 나타나지 않고, 설정 하나를 바꾼 날 전 통화가 깨진다.
  const seen = new Set();
  const port = m.createDryRunPort({ id: 'callbot' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => {
    if (seen.has(iid)) throw new Error('이미 렌더된 턴입니다');
    seen.add(iid);
    return inner(iid, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'CONNECTOR_WAIT');
  assert.equal(c.passed, false);
  assert.match(c.messageKo, /present 는 여러 번 올 수 있습니다/);
  assert.equal(r.passed, false);
});

test('CONNECTOR_WAIT: Api 대기 단계를 변형하는 포트를 잡는다 — 같은 배열이 이력에 쓰인다', b, async () => {
  const port = m.createDryRunPort({ id: 'dars' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => {
    for (const s of steps) delete s.awaitConnectorId;   // "모르는 필드니까 지운다"
    return inner(iid, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'CONNECTOR_WAIT');
  assert.equal(c.passed, false);
  assert.match(c.messageKo, /변형/);
});

test('CONNECTOR_WAIT: 모르는 단계 종류(Api)에 던지는 포트를 잡는다 — 호출은 Core 가 한다(§6.2)', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => {
    for (const s of steps) {
      if (s.kind === 'Api') throw new Error(`처리할 수 없는 단계 종류: ${s.kind}`);
    }
    return inner(iid, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'CONNECTOR_WAIT');
  assert.equal(c.passed, false);
});

// ── AI 고지 (§10.1·§7 7.4) ───────────────────────────────────────────────────
// 고지를 켜는 것도 코드 배포가 아니라 설정 변경이다. 그 순간 첫 단계에서 전 통화가 깨지면 안 된다.

test('AI_DISCLOSURE: 고지 단계를 흡수하는 구현은 3채널 모두 통과한다', b, async () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const port = m.createDryRunPort({ id });
    const r = await m.runChannelConformance({ port, timeoutMs: 500 });
    const c = r.checks.find((x) => x.id === 'AI_DISCLOSURE');
    assert.equal(c.passed, true, `${id}: ${c.messageKo}`);
    assert.equal(c.severity, 'error');
    assert.notEqual(c.skipped, true);
  }
});

test('AI_DISCLOSURE: 단계를 flow.nodes 로 되짚는 포트를 잡는다 — 고지 단계는 시나리오에 없다', b, async () => {
  // 문안 치환·화면 템플릿 선택에 흔한 구현이다. 고지가 꺼진 동안에는 아무 문제도 없고,
  // 설정 하나를 바꾼 날 전 통화가 **첫 단계에서** 죽는다.
  const nodes = { n_probe: { id: 'n_probe', kind: 'Say', text: '안녕' } };
  const port = m.createDryRunPort({ id: 'callbot' });
  port.present = async (_id, steps) => {
    for (const s of steps) {
      if (nodes[s.nodeId].kind === 'Say') continue;
    }
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'AI_DISCLOSURE').passed, false);
  assert.equal(r.passed, false);
});

test('AI_DISCLOSURE: 고지 마커를 지우는 포트를 잡는다 — 문구·버전은 감사 근거다', b, async () => {
  const port = m.createDryRunPort({ id: 'dars' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => {
    for (const s of steps) delete s.disclosure;   // "모르는 필드니까 지운다"
    return inner(iid, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'AI_DISCLOSURE');
  assert.equal(c.passed, false);
  assert.match(c.messageKo, /변형/);
});

test('AI_DISCLOSURE: 한 턴에 단계가 둘 이상 올 수 있다 — 고지 + 첫 안내가 같이 나간다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => {
    if (steps.length > 1) throw new Error('한 번에 한 단계만 처리합니다');
    return inner(iid, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'AI_DISCLOSURE').passed, false);
});

// ── 인텐트 명확화 (§5.1) ─────────────────────────────────────────────────────
// 인텐트를 켜는 것도 설정 변경이다. 그 순간 첫 되물음에서 통화가 깨지면 안 된다.

test('INTENT_CLARIFY: 선택지 단계를 흡수하는 구현은 3채널 모두 통과한다', b, async () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const port = m.createDryRunPort({ id });
    const r = await m.runChannelConformance({ port, timeoutMs: 500 });
    const c = r.checks.find((x) => x.id === 'INTENT_CLARIFY');
    assert.equal(c.passed, true, `${id}: ${c.messageKo}`);
    assert.equal(c.severity, 'error');
    assert.notEqual(c.skipped, true);
  }
});

test('INTENT_CLARIFY: 선택지를 flow.nodes 에서 찾는 포트를 잡는다 — 고지 검사는 통과하는 구현이다', b, async () => {
  // `Say` 는 흘려보내면서 `Choice` 만 시나리오에서 되짚어 버튼을 다시 그리는 흔한 구현이다.
  const nodes = { n_probe: { id: 'n_probe', kind: 'Say', text: '안녕' } };
  const port = m.createDryRunPort({ id: 'dars' });
  port.present = async (_id, steps) => {
    for (const s of steps) {
      if (s.kind !== 'Choice') continue;
      nodes[s.nodeId].options.map((o) => o.label);     // 여기서 터진다
    }
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'AI_DISCLOSURE').passed, true);
  assert.equal(r.checks.find((c) => c.id === 'INTENT_CLARIFY').passed, false);
  assert.equal(r.passed, false);
});

test('INTENT_CLARIFY: 선택지를 다시 정렬하는 포트를 잡는다 — 번호가 어긋나면 다른 인텐트가 확정된다', b, async () => {
  const port = m.createDryRunPort({ id: 'chatbot' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => {
    for (const s of steps) {
      if (s.ui?.items) s.ui.items.reverse();           // "가나다순이 보기 좋다"
    }
    return inner(iid, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'INTENT_CLARIFY');
  assert.equal(c.passed, false);
  assert.match(c.messageKo, /다른 인텐트가 확정됩니다/);
});

test('INTENT_CLARIFY: 음성은 번호 안내와 DTMF 수용이 실린다', b, async () => {
  const seen = [];
  const port = m.createDryRunPort({ id: 'callbot' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => { seen.push(...steps); return inner(iid, steps); };
  await m.runChannelConformance({ port, timeoutMs: 500 });
  const clarify = seen.find((s) => s.nodeId === '__clarify');
  assert.equal(clarify.acceptDtmf, true);
  assert.match(clarify.text, /1번 잔액 조회/);
});

// ── 지식 응대 답변 (§5.2) ────────────────────────────────────────────────────
// 지식 응대를 켜는 것도 설정 변경이다. 그 순간 첫 답변에서 통화가 깨지면 안 되고,
// 각주 번호가 본문과 어긋나면 고객은 **다른 출처**를 보게 된다(예외 없이 일어난다).

test('KNOWLEDGE_ANSWER: 각주가 붙은 답변 단계를 흡수하는 구현은 3채널 모두 통과한다', b, async () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const port = m.createDryRunPort({ id });
    const r = await m.runChannelConformance({ port, timeoutMs: 500 });
    const c = r.checks.find((x) => x.id === 'KNOWLEDGE_ANSWER');
    assert.equal(c.passed, true, `${id}: ${c.messageKo}`);
    assert.equal(c.severity, 'error');
    assert.notEqual(c.skipped, true);
  }
});

test('KNOWLEDGE_ANSWER: 모르는 필드에서 던지는 포트를 잡는다 — 고지·명확화 검사는 통과하는 구현이다', b, async () => {
  // 단계 스키마를 엄격히 잠근 구현이다. 지식 응대를 켜는 날 첫 답변에서만 죽는다.
  const port = m.createDryRunPort({ id: 'chatbot' });
  port.present = async (_id, steps) => {
    for (const s of steps) {
      for (const k of Object.keys(s)) {
        if (!['channel', 'nodeId', 'kind', 'text', 'ui', 'acceptDtmf', 'reprompt', 'inputTimeoutMs', 'bargeIn', 'disclosure', 'silent', 'awaitConnectorId', 'transferTo'].includes(k)) {
          throw new Error(`알 수 없는 필드: ${k}`);
        }
      }
    }
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'AI_DISCLOSURE').passed, true);
  assert.equal(r.checks.find((c) => c.id === 'INTENT_CLARIFY').passed, true);
  const c = r.checks.find((x) => x.id === 'KNOWLEDGE_ANSWER');
  assert.equal(c.passed, false);
  assert.match(c.messageKo, /모르는 필드\(citations\)는 무시하세요/);
  assert.equal(r.passed, false);
});

test('KNOWLEDGE_ANSWER: 각주를 다시 번호 매기는 포트를 잡는다 — 본문의 [n] 과 어긋난다', b, async () => {
  const port = m.createDryRunPort({ id: 'dars' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => {
    for (const s of steps) {
      // "표시 순서대로 1번부터 다시 매기는 게 보기 좋다" — 본문은 그대로다.
      if (s.citations) s.citations.forEach((c, i) => { c.marker = i + 10; });
    }
    return inner(iid, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'KNOWLEDGE_ANSWER');
  assert.equal(c.passed, false);
  assert.match(c.messageKo, /인용 번호는 답변 본문과 짝이므로/);
});

test('KNOWLEDGE_ANSWER: 답변 단계의 nodeId 는 시나리오에 없고 각주는 최소한만 싣는다', b, async () => {
  const seen = [];
  const port = m.createDryRunPort({ id: 'chatbot' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => { seen.push(...steps); return inner(iid, steps); };
  await m.runChannelConformance({ port, timeoutMs: 500, flows: [flow()] });
  const answer = seen.find((s) => s.nodeId === '__answer');
  assert.equal(answer.kind, 'Say');
  assert.equal(flow().nodes[answer.nodeId], undefined);
  assert.deepEqual(Object.keys(answer.citations[0]).sort(), ['marker', 'sourceUri', 'title']);
});

// ── 축소 운영 지시 (§9.3) ────────────────────────────────────────────────────
// 다른 힌트와 다른 점은 모양이 아니라 **시점**이다. 이 필드는 설정을 켤 때가 아니라
// **엔진이 저하된 순간** 처음 붙으므로, 여기서 깨지는 포트는 평소 전 검사를 통과하고
// 하필 장애 중에 전 통화를 깨뜨린다 — 장애 위에 장애를 얹는다.

test('OUTAGE_HINTS: 축소 운영 지시를 흡수하는 구현은 3채널 모두 통과한다', b, async () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const port = m.createDryRunPort({ id });
    const r = await m.runChannelConformance({ port, timeoutMs: 500 });
    const c = r.checks.find((x) => x.id === 'OUTAGE_HINTS');
    assert.equal(c.passed, true, `${id}: ${c.messageKo}`);
    assert.equal(c.severity, 'error');
    assert.notEqual(c.skipped, true);
  }
});

test('OUTAGE_HINTS: 모르는 필드에서 던지는 포트를 잡는다 — 다른 힌트 검사는 통과하는 구현이다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  port.present = async (_id, steps) => {
    for (const s of steps) {
      if ('outage' in s) throw new Error('알 수 없는 필드: outage');
    }
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((c) => c.id === 'TURN_HINTS').passed, true);
  const c = r.checks.find((x) => x.id === 'OUTAGE_HINTS');
  assert.equal(c.passed, false);
  assert.match(c.messageKo, /엔진이 저하된 순간/);
  assert.equal(r.passed, false);
});

test('OUTAGE_HINTS: 지시를 지우는 포트를 잡는다 — 판정과 실제 동작이 갈라진다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => {
    for (const s of steps) delete s.outage;   // "모르는 필드니까 지운다"
    return inner(iid, steps);
  };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'OUTAGE_HINTS');
  assert.equal(c.passed, false);
  assert.match(c.messageKo, /변형/);
});

test('OUTAGE_HINTS: 검사용 단계의 목록은 MEDIA_DISABLE 하나에서 온다(§2)', b, async () => {
  const F = await import('../src/ops/fallback.ts');
  const seen = [];
  const port = m.createDryRunPort({ id: 'callbot' });
  const inner = port.present.bind(port);
  port.present = async (iid, steps) => { seen.push(...steps); return inner(iid, steps); };
  await m.runChannelConformance({ port, timeoutMs: 500 });
  const probe = seen.find((s) => s.outage !== undefined);
  assert.deepEqual(probe.outage.disabled, [...F.MEDIA_DISABLE]);
});

// ── §9.3 기존 IVR 회귀 (LEGACY_IVR_ROUTE) ───────────────────────────────────
// 이 스위트가 **한 번도 불러 본 적이 없던 유일한 포트 메서드**다. 종전에 본 것은 정적 선언
// 뿐이라, 던지거나 매달리는 회귀 구현은 전 검사를 통과하고 **엔진이 죽은 순간에만** 깨졌다.

/** 회귀 능력을 켠 음성 포트. 기본 프로파일은 routeToLegacyIvr=false 다(고객사 사정). */
const ivrPort = () => m.createDryRunPort({
  id: 'callbot',
  capabilities: {
    adapter: 'callbot', channel: 'voice', dtmf: true, richUi: false, speech: true,
    transferToAgent: true, routeToLegacyIvr: true, crossChannelInvite: true,
  },
});

test('LEGACY_IVR_ROUTE: 회귀를 선언·구현한 포트는 실제 호출까지 통과한다', b, async () => {
  const port = ivrPort();
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'LEGACY_IVR_ROUTE');
  assert.equal(c.passed, true, c.messageKo);
  assert.notEqual(c.skipped, true);
  // **선언만 본 것이 아니라 불렀다** — 기록에 그 호출이 남아야 이 검사가 의미가 있다.
  assert.ok(port.calls.some((x) => x.method === 'routeToLegacyIvr'), '회귀를 부르지 않았다');
  assert.equal(r.passed, true);
});

test('LEGACY_IVR_ROUTE: 회귀를 선언하지 않은 채널은 "해당 없음" 이며 건너뜀이 아니다', b, async () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const port = m.createDryRunPort({ id });   // 기본 프로파일: routeToLegacyIvr=false
    const r = await m.runChannelConformance({ port, timeoutMs: 500 });
    const c = r.checks.find((x) => x.id === 'LEGACY_IVR_ROUTE');
    assert.equal(c.passed, true, `${id}: ${c.messageKo}`);
    // 판정보류로 적으면 "검사를 못 돌렸다"와 "해당 사항이 없다"가 섞인다(§13-3).
    assert.notEqual(c.skipped, true);
    assert.match(c.messageKo, /해당 없음/);
    assert.equal(port.calls.some((x) => x.method === 'routeToLegacyIvr'), false);
  }
});

test('LEGACY_IVR_ROUTE: 회귀를 거부하는 구현을 잡는다 — 다른 검사는 전부 통과하는 포트다', b, async () => {
  const port = ivrPort();
  port.routeToLegacyIvr = async () => { throw new Error('IVR 게이트웨이 응답 없음'); };
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((x) => x.id === 'REGISTRATION').passed, true);
  assert.equal(r.checks.find((x) => x.id === 'ASYNC_CONTRACT').passed, true);
  const c = r.checks.find((x) => x.id === 'LEGACY_IVR_ROUTE');
  assert.equal(c.passed, false);
  assert.equal(c.severity, 'error');
  assert.match(c.messageKo, /엔진이 죽은 순간에만 돌고/);
  assert.equal(r.passed, false);
});

test('LEGACY_IVR_ROUTE: 동기 예외·미정착·Promise 아님을 모두 잡는다(경계)', b, async () => {
  const sync = ivrPort();
  sync.routeToLegacyIvr = () => { throw new Error('동기 폭발'); };
  const rSync = await m.runChannelConformance({ port: sync, timeoutMs: 500 });
  assert.equal(rSync.checks.find((x) => x.id === 'LEGACY_IVR_ROUTE').passed, false);

  const hang = ivrPort();
  hang.routeToLegacyIvr = () => new Promise(() => {});   // 영원히 정착하지 않는다
  const rHang = await m.runChannelConformance({ port: hang, timeoutMs: 30 });
  const cHang = rHang.checks.find((x) => x.id === 'LEGACY_IVR_ROUTE');
  assert.equal(cHang.passed, false);
  assert.match(cHang.messageKo, /예산 초과/);

  // Promise 를 돌려주지 않는 구현: Core 의 await 가 지시가 나가기 전에 통과한다.
  const sloppy = ivrPort();
  sloppy.routeToLegacyIvr = () => undefined;
  const rSloppy = await m.runChannelConformance({ port: sloppy, timeoutMs: 500 });
  const cSloppy = rSloppy.checks.find((x) => x.id === 'LEGACY_IVR_ROUTE');
  assert.equal(cSloppy.passed, false);
  assert.match(cSloppy.messageKo, /Promise 를 돌려주지 않습니다/);
});

test('LEGACY_IVR_ROUTE: 구현만 있고 선언이 없으면 경고다 — Core 는 그 경로를 쓰지 않는다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });   // 선언은 false
  port.routeToLegacyIvr = async () => {};
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'LEGACY_IVR_ROUTE');
  assert.equal(c.passed, false);
  assert.equal(c.severity, 'warning');
  assert.equal(r.passed, true, '경고가 통과를 막았다');
});

test('LEGACY_IVR_ROUTE: 선언만 하고 구현이 없는 상태도 오류로 적는다', b, async () => {
  const port = ivrPort();
  delete port.routeToLegacyIvr;
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'LEGACY_IVR_ROUTE');
  assert.equal(c.passed, false);
  // 같은 사실을 REGISTRATION 도 적지만(등록 거부) 여기서는 **그 뒤에 무엇이 일어나는가**를 적는다.
  assert.match(c.messageKo, /상담사 이관으로 대신하고/);
});

// ── §5.2 전환 초대 접수 (CHANNEL_INVITE) ────────────────────────────────────
// 티켓 흡수는 보고 있었지만 **지시를 접수하는가**(Promise 반환)는 보지 않았다. 그 구멍은
// `LEGACY_IVR_ROUTE` 가 막은 것과 같다: Core 의 `await` 가 링크가 나가기 전에 통과하면
// 그 뒤 발송 실패는 아무 데도 남지 않고, 결과에는 "티켓 발급됨" 만 남는다.

test('CHANNEL_INVITE: 정상 구현은 통과하고 티켓 유무 양쪽으로 실제로 불린다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });   // 기본 프로파일: crossChannelInvite=true
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'CHANNEL_INVITE');
  assert.equal(c.passed, true, c.messageKo);
  assert.notEqual(c.skipped, true);
  const invites = port.calls.filter((x) => x.method === 'invite');
  assert.equal(invites.length, 2, '티켓 유무 양쪽으로 부르지 않았다');
  assert.equal(invites.filter((x) => x.detail.includes('ticket=있음')).length, 1);
  assert.equal(r.passed, true);
});

test('CHANNEL_INVITE: Promise 를 돌려주지 않는 초대를 잡는다 — 다른 검사는 전부 통과하는 포트다', b, async () => {
  const port = m.createDryRunPort({ id: 'callbot' });
  const seen = [];
  port.invite = (id, target, ticket) => { seen.push([target, ticket !== undefined]); };   // 동기 구현
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  assert.equal(r.checks.find((x) => x.id === 'REGISTRATION').passed, true);
  assert.equal(r.checks.find((x) => x.id === 'ASYNC_CONTRACT').passed, true);
  const c = r.checks.find((x) => x.id === 'CHANNEL_INVITE');
  assert.equal(c.passed, false);
  assert.equal(c.severity, 'error');
  assert.match(c.messageKo, /Promise 를 돌려주지 않습니다/);
  // 불리기는 했다 — 즉 "모양은 맞고 접수 여부만 알 수 없는" 구현이 바로 이 검사의 대상이다.
  assert.equal(seen.length, 2);
  assert.equal(r.passed, false);
});

test('CHANNEL_INVITE: 거부·미정착도 오류로 잡는다(경계)', b, async () => {
  const deny = m.createDryRunPort({ id: 'callbot' });
  deny.invite = async () => { throw new Error('알림톡 발송 거부'); };
  const rDeny = await m.runChannelConformance({ port: deny, timeoutMs: 500 });
  const cDeny = rDeny.checks.find((x) => x.id === 'CHANNEL_INVITE');
  assert.equal(cDeny.passed, false);
  assert.match(cDeny.messageKo, /전환 초대에서 실패했습니다/);

  const hang = m.createDryRunPort({ id: 'callbot' });
  hang.invite = () => new Promise(() => {});   // 영원히 정착하지 않는다
  const rHang = await m.runChannelConformance({ port: hang, timeoutMs: 30 });
  const cHang = rHang.checks.find((x) => x.id === 'CHANNEL_INVITE');
  assert.equal(cHang.passed, false);
  assert.match(cHang.messageKo, /예산 초과/);
});

// ── 모르는 어댑터 id (§2·§5.3) ──────────────────────────────────────────────
// 브리지는 같은 오타를 기동 시점에 거절한다. 적합성 게이트는 통과시켰다 —
// 모르는 id 의 능력 선언은 `{ adapter: '오타', channel: undefined }` 라서 채널 어긋남 검사가
// `undefined !== undefined` 로 거짓이 되고, 능력 전부가 거짓이라 선택 메서드 검사는
// "해당 없음" 으로 적힌다. 즉 **CI 는 초록인데 확인된 것이 없었다**.

test('오타 난 어댑터 id 는 적합성 게이트가 거절한다 — 통과로 적지 않는다', b, async () => {
  const port = m.createDryRunPort({ id: 'calbot' });
  const r = await m.runChannelConformance({ port, timeoutMs: 500 });
  const c = r.checks.find((x) => x.id === 'REGISTRATION');
  assert.equal(c.passed, false, `오타 난 id 가 통과했다: ${m.formatConformanceReport(r)}`);
  assert.match(c.messageKo, /알 수 없는 채널 어댑터입니다/);
  assert.equal(r.passed, false);
  assert.equal(r.errorCount >= 1, true);
});

test('아는 어댑터 세 개는 그대로 통과한다 — 거절은 계약 밖 id 뿐이다(경계)', b, async () => {
  const C = await import('../src/channels/contract.ts');
  assert.deepEqual([...C.CHANNEL_ADAPTER_IDS], Object.keys(C.ADAPTER_CHANNEL));
  for (const id of C.CHANNEL_ADAPTER_IDS) {
    const r = await m.runChannelConformance({ port: m.createDryRunPort({ id }), timeoutMs: 500 });
    assert.equal(r.checks.find((x) => x.id === 'REGISTRATION').passed, true, `${id} 가 거절됐다`);
    assert.equal(r.channel, C.ADAPTER_CHANNEL[id]);
  }
  assert.equal(C.isChannelAdapterId('callbot'), true);
  assert.equal(C.isChannelAdapterId('calbot'), false);
  // 프로토타입 체인으로 통과하지 않는다(`hasOwnProperty` 로 본다).
  assert.equal(C.isChannelAdapterId('toString'), false);
  assert.equal(C.isChannelAdapterId(undefined), false);
});
