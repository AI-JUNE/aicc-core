// 브리지 기록 검증 — 비-Node 클라이언트가 프로토콜을 지켰는지 판정하는 검사.
// 정상 경로 + 실패 경로(세션 누수·요약 유출·테넌트 주장·상관 어긋남)를 모두 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyBridgeTranscript, formatTranscriptReport, TRANSCRIPT_EXIT_CODE,
} from '../src/channels/bridgeTranscript.ts';
import { BRIDGE_PROTOCOL_VERSION } from '../src/channels/bridge.ts';

const EXPECT = { adapter: 'callbot', maxLineBytes: 65536 };

const j = (o) => JSON.stringify(o);

function helloPair(overrides = {}) {
  return {
    req: j({ id: '1', op: 'hello' }),
    res: j({
      id: '1',
      ok: true,
      result: { protocolVersion: BRIDGE_PROTOCOL_VERSION, adapter: 'callbot', ...overrides },
    }),
  };
}

function startPair(id = '2', interactionId = 'ix_1', result = {}) {
  return {
    req: j({ id, op: 'start', req: { flowId: 'f_x', entryPoint: 'inbound_call' } }),
    res: j({ id, ok: true, result: { interactionId, status: 'awaiting_input', steps: [], events: [], state: { slotKeys: [] }, ...result } }),
  };
}

function endPair(id = '3', interactionId = 'ix_1') {
  return {
    req: j({ id, op: 'end', interactionId, reasonKo: '정상 종료' }),
    res: j({ id, ok: true, result: { interactionId, status: 'ended', steps: [], events: [], state: { slotKeys: [] } } }),
  };
}

function build(pairs) {
  return { requests: pairs.map((p) => p.req), responses: pairs.map((p) => p.res) };
}

test('정상 기록은 통과하고 실측 건수를 그대로 센다', () => {
  const r = verifyBridgeTranscript(build([helloPair(), startPair(), endPair()]), EXPECT);
  assert.equal(r.verdict, 'passed');
  assert.equal(r.exitCode, TRANSCRIPT_EXIT_CODE.passed);
  assert.equal(r.errorCount, 0);
  assert.equal(r.requestCount, 3);
  assert.equal(r.okCount, 3);
  assert.equal(r.startedInteractions, 1);
  assert.equal(r.endedInteractions, 1);
  assert.deepEqual({ ...r.opCounts }, { hello: 1, start: 1, end: 1 });
});

test('상한·채널 기대를 주지 않으면 통과가 아니라 판정보류다(§13-3)', () => {
  const t = build([helloPair(), startPair(), endPair()]);
  const r = verifyBridgeTranscript(t, {});
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.exitCode, 2);
  assert.equal(r.errorCount, 0);
  assert.equal(r.reasonsKo.length, 2);
  // 한쪽만 채워도 여전히 판정보류다 — 건너뛴 검사는 통과의 근거가 아니다.
  assert.equal(verifyBridgeTranscript(t, { adapter: 'callbot' }).verdict, 'inconclusive');
});

test('빈 기록을 통과로 적지 않는다', () => {
  const r = verifyBridgeTranscript({ requests: [], responses: [] }, EXPECT);
  assert.equal(r.verdict, 'inconclusive');
  assert.match(r.reasonsKo.join(' '), /비어/);
});

test('입력이 없거나 형태가 어긋나도 던지지 않는다', () => {
  for (const bad of [undefined, null, {}, { requests: 'x', responses: 3 }]) {
    const r = verifyBridgeTranscript(bad, EXPECT);
    assert.equal(r.requestCount, 0);
    assert.equal(r.verdict, 'inconclusive');
  }
});

test('시작만 하고 끝내지 않으면 세션 누수로 실패한다', () => {
  const r = verifyBridgeTranscript(build([helloPair(), startPair()]), EXPECT);
  assert.equal(r.verdict, 'failed');
  assert.equal(r.exitCode, 1);
  assert.ok(r.issues.some((i) => i.code === 'E_SESSION_LEAK'));
  assert.equal(r.endedInteractions, 0);
});

test('hello 없이 붙으면 실패한다 — 버전 불일치가 조용히 지나간다', () => {
  const r = verifyBridgeTranscript(build([startPair('1'), endPair('2')]), EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'E_NO_HELLO'));
  assert.equal(r.verdict, 'failed');
});

test('프로토콜 버전·채널이 어긋나면 실패한다', () => {
  const v = verifyBridgeTranscript(build([helloPair({ protocolVersion: 99 }), startPair(), endPair()]), EXPECT);
  assert.ok(v.issues.some((i) => i.code === 'E_PROTOCOL_VERSION'));
  const a = verifyBridgeTranscript(build([helloPair({ adapter: 'chatbot' }), startPair(), endPair()]), EXPECT);
  assert.ok(a.issues.some((i) => i.code === 'E_ADAPTER'));
});

test('클라이언트가 테넌트를 주장하면 실패한다(§11.1)', () => {
  const bad = {
    req: j({ id: '2', op: 'start', req: { flowId: 'f_x', entryPoint: 'inbound_call', scope: { tenantId: 'other' } } }),
    res: j({ id: '2', ok: true, result: { interactionId: 'ix_1', events: [], state: { slotKeys: [] } } }),
  };
  const r = verifyBridgeTranscript(build([helloPair(), bad, endPair()]), EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'E_SCOPE_CLAIM'));
  assert.equal(r.verdict, 'failed');
});

test('허용되지 않은 상담사용 요약이 실리면 실패한다 — handoff 와 events 둘 다(§2·§10.3)', () => {
  const viaHandoff = startPair('2', 'ix_1', { handoff: { summaryAvailable: true, summaryMasked: '요약 전문' } });
  const viaEvents = startPair('2', 'ix_1', { events: [{ type: 'handoff.requested', summary_masked: '요약 전문' }] });
  for (const pair of [viaHandoff, viaEvents]) {
    const r = verifyBridgeTranscript(build([helloPair(), pair, endPair()]), EXPECT);
    assert.ok(r.issues.some((i) => i.code === 'E_SUMMARY_LEAK'), '요약 유출을 잡지 못했다');
  }
  // 허용된 소비자에게는 결함이 아니다.
  const allowed = verifyBridgeTranscript(build([helloPair(), viaHandoff, endPair()]), { ...EXPECT, includeHandoffSummary: true });
  assert.equal(allowed.verdict, 'passed');
});

test('허용되지 않은 §5.2 전환 토큰이 실리면 실패한다 — 그 토큰이 상담 화면의 열쇠다(§10.3)', () => {
  // 브리지는 **세 값**을 노출 스위치 뒤에 둔다(슬롯 값·상담사용 요약·전환 토큰). 이 게이트는
  // 그중 둘만 보고 있었고, 보지 않던 하나가 하필 진행 중인 상담의 열쇠였다 — 기록 파일은
  // CI 산출물로 남으므로 토큰이 섞인 기록은 그 자체가 유출 경로다.
  const pair = startPair('2', 'ix_1', {
    switchInvite: {
      fromChannel: 'voice', toChannel: 'visual', ticketIssued: true,
      tokenIncluded: true, expiresAt: '2026-10-29T09:10:00.000Z', token: 'tk_secret',
    },
  });
  const r = verifyBridgeTranscript(build([helloPair(), pair, endPair()]), EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'E_TICKET_LEAK'), '토큰 유출을 잡지 못했다');
  assert.equal(r.verdict, 'failed');
  // 유출을 지적하는 줄이 유출을 한 번 더 하지 않는다.
  assert.equal(JSON.stringify(r.issues).includes('tk_secret'), false);
  // 링크를 직접 보내는 호스트에게는 결함이 아니다 — 선언하면 통과한다.
  const allowed = verifyBridgeTranscript(build([helloPair(), pair, endPair()]), { ...EXPECT, includeSwitchTicket: true });
  assert.equal(allowed.verdict, 'passed');
});

test('전환 사실만 실린 기록은 통과한다 — 사실은 스위치와 무관하게 나간다(§5.2)', () => {
  // `ticketIssued`·`tokenIncluded`·만료·사유에는 열쇠가 없다. 이것까지 유출로 적으면 끈
  // 소비자는 **정상 응답만으로** 영구히 실패하고, 그러면 이 게이트를 아무도 켜지 않는다.
  const pair = startPair('2', 'ix_1', {
    switchInvite: {
      fromChannel: 'voice', toChannel: 'visual', ticketIssued: true,
      tokenIncluded: false, expiresAt: '2026-10-29T09:10:00.000Z',
    },
  });
  assert.equal(verifyBridgeTranscript(build([helloPair(), pair, endPair()]), EXPECT).verdict, 'passed');
});

test('토큰 유출 판정은 플래그가 아니라 실린 값을 본다(경계)', () => {
  // `tokenIncluded: false` 인데 토큰이 실려 있는 응답: 판정만 보면 열쇠가 그냥 지나간다.
  const pair = startPair('2', 'ix_1', {
    switchInvite: { fromChannel: 'voice', toChannel: 'visual', ticketIssued: true, tokenIncluded: false, token: 'tk_x' },
  });
  const r = verifyBridgeTranscript(build([helloPair(), pair, endPair()]), EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'E_TICKET_LEAK'));
  // 빈 문자열도 실린 값이다 — 없는 칸(undefined)과 구분한다.
  const empty = startPair('2', 'ix_1', {
    switchInvite: { fromChannel: 'voice', toChannel: 'visual', ticketIssued: false, token: '' },
  });
  assert.ok(verifyBridgeTranscript(build([helloPair(), empty, endPair()]), EXPECT)
    .issues.some((i) => i.code === 'E_TICKET_LEAK'));
});

test('허용되지 않은 슬롯 값이 실리면 실패한다', () => {
  const pair = startPair('2', 'ix_1', { state: { slotKeys: ['name'], slots: { name: '홍길동' } } });
  const r = verifyBridgeTranscript(build([helloPair(), pair, endPair()]), EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'E_SLOT_LEAK'));
  const allowed = verifyBridgeTranscript(build([helloPair(), pair, endPair()]), { ...EXPECT, includeSlots: true });
  assert.equal(allowed.verdict, 'passed');
});

test('응답 id 가 어긋나면 상관 실패로 잡는다', () => {
  const t = build([helloPair(), startPair(), endPair()]);
  t.responses[2] = j({ id: '99', ok: true, result: {} });
  const r = verifyBridgeTranscript(t, EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'E_UNPAIRED'));
});

test('요청/응답 개수가 다르면 실패한다', () => {
  const t = build([helloPair(), startPair(), endPair()]);
  t.responses.pop();
  const r = verifyBridgeTranscript(t, EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'E_UNPAIRED'));
  assert.equal(r.verdict, 'failed');
});

test('id 누락·중복·모르는 op·깨진 줄을 각각 잡는다', () => {
  const t = {
    requests: [
      j({ op: 'hello' }),
      j({ id: '1', op: 'hello' }),
      j({ id: '1', op: 'hello' }),
      j({ id: '4', op: 'reboot' }),
      '{깨진 줄',
    ],
    responses: [j({ id: null, ok: false }), helloPair().res, helloPair().res, j({ id: '4', ok: false }), j({ id: null, ok: false })],
  };
  const codes = verifyBridgeTranscript(t, EXPECT).issues.map((i) => i.code);
  for (const c of ['E_NO_ID', 'E_DUP_ID', 'E_UNKNOWN_OP', 'E_BAD_REQUEST_LINE']) {
    assert.ok(codes.includes(c), `${c} 를 잡지 못했다`);
  }
});

test('보낸 줄에 개행이 섞이거나 상한을 넘으면 잡는다', () => {
  const nl = { req: `${j({ id: '1', op: 'hello' })}\n`, res: helloPair().res };
  assert.ok(verifyBridgeTranscript(build([nl]), EXPECT).issues.some((i) => i.code === 'E_EMBEDDED_NEWLINE'));
  const big = verifyBridgeTranscript(build([helloPair()]), { ...EXPECT, maxLineBytes: 4 });
  assert.ok(big.issues.some((i) => i.code === 'E_TOO_LARGE'));
});

test('사유 없는 end 와 모르는 interactionId 를 잡는다', () => {
  const noReason = {
    req: j({ id: '3', op: 'end', interactionId: 'ix_1' }),
    res: j({ id: '3', ok: true, result: { interactionId: 'ix_1' } }),
  };
  const r = verifyBridgeTranscript(build([helloPair(), startPair(), noReason]), EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'E_END_NO_REASON'));

  const ghost = {
    req: j({ id: '2', op: 'send', interactionId: 'ix_made_up', turn: { input: { kind: 'timeout' } } }),
    res: j({ id: '2', ok: true, result: { interactionId: 'ix_made_up' } }),
  };
  const g = verifyBridgeTranscript(build([helloPair(), ghost]), EXPECT);
  assert.ok(g.issues.some((i) => i.code === 'E_UNKNOWN_INTERACTION'));
});

test('모든 응답이 오류면 경고로 남기되 오류로 세지 않는다', () => {
  const t = {
    requests: [j({ id: '1', op: 'hello' })],
    responses: [j({ id: '1', ok: false, error: { code: 'E_INTERNAL', messageKo: 'x' } })],
  };
  const r = verifyBridgeTranscript(t, EXPECT);
  assert.ok(r.issues.some((i) => i.code === 'W_ALL_ERRORS' && i.severity === 'warning'));
  assert.equal(r.errorCount, 0);
  assert.equal(r.failedResponseCount, 1);
  assert.equal(r.verdict, 'passed'); // 경고는 게이트가 아니다 — 사람이 본다
});

test('헬스 보고 기대는 준 경우에만 본다(§9.3)', () => {
  const t = build([helloPair(), startPair(), endPair()]);
  assert.equal(verifyBridgeTranscript(t, EXPECT).warningCount, 0);
  const w = verifyBridgeTranscript(t, { ...EXPECT, expectHealthReport: true });
  assert.ok(w.issues.some((i) => i.code === 'W_NO_HEALTH'));
});

test('메시지에 요청 원문·개인정보가 실리지 않는다(§10.3)', () => {
  const t = {
    requests: [j({ id: '010-1234-5678', op: 'hello' }), j({ id: '010-1234-5678', op: 'hello' })],
    responses: [helloPair().res, helloPair().res],
  };
  const text = formatTranscriptReport(verifyBridgeTranscript(t, EXPECT));
  assert.ok(!text.includes('010-1234-5678'), '전화번호가 그대로 노출됐다');
});

test('보고 문자열은 판정과 건수를 사람이 읽게 담는다', () => {
  const text = formatTranscriptReport(verifyBridgeTranscript(build([helloPair(), startPair(), endPair()]), EXPECT));
  assert.match(text, /통과/);
  assert.match(text, /세션 시작 1 · 종료 1/);
});
