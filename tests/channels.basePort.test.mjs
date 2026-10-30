import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null, c = null;
try {
  m = await import('../src/channels/basePort.ts');
  c = await import('../src/channels/conformance.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const step = (channel, text = '안녕하세요') => ({ channel, nodeId: 'n1', kind: 'Say', text });
const recording = () => {
  const seen = [];
  return { seen, name: 'rec', async deliver(env) { seen.push(env); } };
};

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('베이스 포트는 3채널 모두 적합성 스위트를 통과한다', b, async () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const port = m.createChannelPort({ id });
    const report = await c.runChannelConformance({ port, timeoutMs: 500 });
    assert.equal(report.passed, true, `${id}: ${c.formatConformanceReport(report)}`);
    assert.equal(report.errorCount, 0);
  }
});

test('기본 활성화는 dry_run 이고 transport 를 호출하지 않는다', b, async () => {
  const t = recording();
  const port = m.createChannelPort({ id: 'chatbot', transport: t });
  assert.equal(port.activation, 'dry_run');
  await port.present('i1', [step('chat')]);
  await port.end('i1', '고객 종료');
  assert.equal(t.seen.length, 0, 'dry_run 에서 매체로 나가면 안 된다');
  assert.equal(port.records.length, 2);
  assert.ok(port.records.every((r) => r.ok && r.simulated));
});

test('live 는 승인 근거가 있을 때만 만들어지고 transport 로 전달한다', b, async () => {
  const t = recording();
  const port = m.createChannelPort({ id: 'chatbot', activation: 'live', approvalRef: 'TICKET-1', transport: t });
  await port.present('i1', [step('chat', '주문 확인'), step('chat', '감사합니다')]);
  assert.equal(t.seen.length, 1);
  assert.equal(t.seen[0].kind, 'present');
  assert.equal(t.seen[0].steps.length, 2);
  assert.equal(port.records[0].simulated, false);
  assert.equal(port.failures.length, 0);
});

test('종료 중복 호출은 매체를 두 번 내리지 않고 흡수한다', b, async () => {
  const t = recording();
  const port = m.createChannelPort({ id: 'callbot', activation: 'live', approvalRef: 'T', transport: t });
  await port.end('i1', '고객 종료');
  await port.end('i1', '고객 종료');
  assert.equal(t.seen.filter((e) => e.kind === 'end').length, 1);
  assert.equal(port.records[1].suppressed, true);
  assert.equal(port.records[1].ok, true);
  assert.equal(port.failures.length, 0, '접수된 종료의 중복은 실패가 아니다');
});

test('접수되지 않은 종료는 "중복 흡수"로 삼키지 않는다 — 다음 종료가 매체에 닿는다', b, async () => {
  // 이 파일의 전제가 곧 이 경로다: "고객 끊음과 Core 종료가 겹치면 반드시 생긴다"는 것은
  // **같은 통화에 종료가 두 번 온다**는 뜻이고, 첫 번째가 회선 장애로 거부된 상태에서 두 번째가
  // 오는 것이 바로 그 시각의 모양이다. 멱등 표식이 시도 앞에 있던 동안 두 번째는 성공
  // (`suppressed`)으로 기록되고 회선·세션은 **내려가지 않은 채** 남았다 — 그 시간은 장애가
  // 아니라 §11.2 요금으로 나타나고, 기록은 "한 번 실패했고 그 다음은 중복"으로 읽힌다.
  let attempts = 0;
  const seen = [];
  const t = {
    name: 'flaky',
    async deliver(env) {
      attempts += 1;
      if (attempts === 1) throw new Error('회선 거부');
      seen.push(env.kind);
    },
  };
  const port = m.createChannelPort({ id: 'callbot', activation: 'live', approvalRef: 'T', transport: t });
  await port.end('i1', '고객 종료');
  assert.equal(port.failures.length, 1, '첫 시도는 실패로 남는다');
  await port.end('i1', '고객 종료');
  assert.deepEqual(seen, ['end'], '두 번째 종료가 매체에 닿아야 한다');
  assert.equal(port.records.length, 2);
  assert.equal(port.records[1].ok, true);
  assert.equal(port.records[1].suppressed, undefined, '접수되지 않은 종료를 중복으로 적으면 안 된다');
  // 접수된 뒤에는 종전대로 흡수한다 — 매체를 세 번 내리지 않는다.
  await port.end('i1', '고객 종료');
  assert.deepEqual(seen, ['end']);
  assert.equal(port.records[2].suppressed, true);
});

test('예산 초과 종료도 접수되지 않은 것으로 보고 재시도를 허용한다(경계: 타임아웃)', b, async () => {
  // `surfaced` 가 타임아웃을 "접수되지 않았다"로 읽는 것과 같은 저울이다. 여기서 흡수하면
  // 정착하지 않은 회선 하나가 **영구히 열린 세션**이 된다(사람이 손대기 전까지).
  let attempts = 0;
  const t = {
    name: 'hang-once',
    deliver: () => {
      attempts += 1;
      return attempts === 1 ? new Promise(() => {}) : Promise.resolve();
    },
  };
  const port = m.createChannelPort({
    id: 'chatbot', activation: 'live', approvalRef: 'T', transport: t, timeoutMs: 20,
  });
  await port.end('i1', '종료');
  assert.equal(port.failures[0].errorCode, 'E_TIMEOUT');
  await port.end('i1', '종료');
  assert.equal(attempts, 2, '예산 초과를 중복으로 흡수하면 다시 내릴 기회가 사라진다');
  assert.equal(port.records[1].ok, true);
});

test('dry_run 의 종료는 접수로 적히므로 중복은 종전대로 흡수된다', b, async () => {
  const t = recording();
  const port = m.createChannelPort({ id: 'dars', transport: t });
  await port.end('i1', '종료');
  await port.end('i1', '종료');
  assert.equal(t.seen.length, 0);
  assert.equal(port.records[1].suppressed, true);
});

test('전송된 steps 는 동결 복사본이라 원본 이력이 오염되지 않는다', b, async () => {
  let mutated = false;
  const t = {
    name: 'mut',
    async deliver(env) {
      try { env.steps[0].text = '변조'; } catch { mutated = true; }
      try { env.steps.push(step('chat')); } catch { mutated = true; }
    },
  };
  const port = m.createChannelPort({ id: 'chatbot', activation: 'live', approvalRef: 'T', transport: t });
  const original = [step('chat', '원본')];
  const snapshot = JSON.stringify(original);
  await port.present('i1', original);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(mutated, true, '동결된 복사본이어야 한다');
});

test('중첩 필드까지 동결돼 §8.1 이력이 오염되지 않는다(각주·선택지·축소 지시)', b, async () => {
  // 얕은 동결은 `ui.items`·`citations`·`outage.disabled` 를 **원본과 같은 참조로** 넘긴다.
  // 하필 그 셋이 "채널이 고쳐 쓰면 안 된다"고 적어 둔 값들이다: 각주를 다시 번호 매기면 본문의
  // [n] 과 어긋나 고객이 다른 출처를 보고, 선택지를 다시 정렬하면 고객이 말한 번호와 다른
  // 인텐트가 확정되고, 축소 지시를 고치면 §9.3 판정과 실제 동작이 갈라진다 — 원본까지 고쳐지면
  // 그 거짓이 추가 전용 원장에 남는다.
  const blocked = [];
  const t = {
    name: 'nested-mut',
    async deliver(env) {
      const s = env.steps[0];
      for (const [what, mutate] of [
        ['citation', () => { s.citations[0].marker = 9; }],
        ['citations-push', () => { s.citations.push({ marker: 2, title: '가짜' }); }],
        ['ui-items', () => { s.ui.items.reverse(); }],
        ['ui-label', () => { s.ui.items[0].label = '변조'; }],
        ['outage', () => { s.outage.disabled.push('speech_recognition'); }],
        ['reprompt', () => { s.reprompt.attempt = 99; }],
      ]) {
        try { mutate(); } catch { blocked.push(what); }
      }
    },
  };
  const port = m.createChannelPort({ id: 'chatbot', activation: 'live', approvalRef: 'T', transport: t });
  const original = [{
    channel: 'chat', nodeId: 'n_ans', kind: 'Choice', text: '어느 쪽일까요 [1]',
    ui: { type: 'buttons', items: [{ label: '잔액', value: 'balance' }, { label: '재발급', value: 'reissue' }] },
    citations: [{ marker: 1, title: '수수료 안내' }],
    outage: { disabled: ['voice_synthesis'], reasonKo: '축소 운영' },
    reprompt: { reason: 'no_input', attempt: 2, exhausted: false },
  }];
  const snapshot = JSON.stringify(original);
  await port.present('i1', original);
  assert.equal(JSON.stringify(original), snapshot, '중첩 값이 원본 참조로 나갔다');
  assert.deepEqual(
    blocked.sort(),
    ['citation', 'citations-push', 'outage', 'reprompt', 'ui-items', 'ui-label'],
    '변조가 조용히 통과하면 그 포트는 "고쳐 썼는데 아무 일도 없었다"로 운영된다',
  );
  // 이 transport 는 변조 예외를 스스로 삼켰으므로 전달 자체는 접수된다.
  assert.equal(port.failures.length, 0);
});

test('변조를 삼키지 않는 transport 에서는 그 시도가 전송 실패로 남는다(§13-3)', b, async () => {
  // 조용히 넘기면 그 포트는 "고쳐 썼는데 아무 일도 없었다"로 운영된다 — 기록에 남아야 고친다.
  const t = { name: 'mut', async deliver(env) { env.steps[0].citations[0].marker = 9; } };
  const port = m.createChannelPort({ id: 'chatbot', activation: 'live', approvalRef: 'T', transport: t });
  const original = [{ channel: 'chat', nodeId: 'n1', kind: 'Say', text: '답변 [1]', citations: [{ marker: 1, title: 'x' }] }];
  await port.present('i1', original);        // 예외가 위로 새면 Core 턴이 통째로 죽는다
  assert.equal(original[0].citations[0].marker, 1);
  assert.equal(port.failures.length, 1);
  assert.equal(port.failures[0].errorCode, 'E_TRANSPORT');
});

test('중첩 값을 읽기만 하는 transport 는 종전대로 통과한다(경계)', b, async () => {
  const read = [];
  const t = {
    name: 'reader',
    async deliver(env) {
      for (const s of env.steps) read.push(`${s.ui?.items?.length ?? 0}/${s.citations?.length ?? 0}`);
    },
  };
  const port = m.createChannelPort({ id: 'dars', activation: 'live', approvalRef: 'T', transport: t });
  await port.present('i1', [{
    channel: 'visual', nodeId: 'n1', kind: 'Choice', text: '고르세요',
    ui: { type: 'buttons', items: [{ label: 'A', value: 'a' }] },
    citations: [{ marker: 1, title: 'x' }],
  }]);
  assert.deepEqual(read, ['1/1']);
  assert.equal(port.failures.length, 0);
});

test('실측 시계를 주입하면 소요시간이 기록되고, 없으면 만들어 넣지 않는다', b, async () => {
  let now = 1000;
  const t = { name: 'slow', async deliver() { now += 42; } };
  const withClock = m.createChannelPort({ id: 'chatbot', activation: 'live', approvalRef: 'T', transport: t, clock: () => now });
  await withClock.present('i1', []);
  assert.equal(withClock.records[0].durationMs, 42);

  const noClock = m.createChannelPort({ id: 'chatbot' });
  await noClock.present('i1', []);
  assert.equal(noClock.records[0].durationMs, undefined);
});

test('능력 선언에 따라 선택 메서드가 붙고 빠진다', b, async () => {
  const callbot = m.createChannelPort({ id: 'callbot' });          // crossChannelInvite = true
  assert.equal(typeof callbot.invite, 'function');
  assert.equal(callbot.routeToLegacyIvr, undefined);

  const legacy = m.createChannelPort({
    id: 'callbot',
    capabilities: { ...callbot.capabilities, routeToLegacyIvr: true },
  });
  assert.equal(typeof legacy.routeToLegacyIvr, 'function');
  await legacy.routeToLegacyIvr('i1', 'AI 응답 지연');
  assert.equal(legacy.records[0].kind, 'routeToLegacyIvr');
});

test('포트 묶음은 3채널을 한 번에 만든다', b, () => {
  const set = m.createChannelPortSet();
  assert.deepEqual(Object.keys(set).sort(), ['callbot', 'chatbot', 'dars']);
  assert.equal(set.callbot.capabilities.channel, 'voice');
  assert.equal(set.dars.capabilities.channel, 'visual');
  assert.equal(set.chatbot.activation, 'dry_run');
});

test('환경변수 해석은 live 문자열일 때만 live 다', b, () => {
  assert.equal(m.activationFromEnv({ X: 'live' }, 'X'), 'live');
  assert.equal(m.activationFromEnv({ X: 'true' }, 'X'), 'dry_run');
  assert.equal(m.activationFromEnv({}, 'X'), 'dry_run');
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('승인 근거 없는 live 는 생성 단계에서 거부된다', b, () => {
  assert.throws(
    () => m.createChannelPort({ id: 'chatbot', activation: 'live', transport: recording() }),
    (e) => e.code === 'E_APPROVAL_REQUIRED',
  );
});

test('transport 없는 live 는 거부된다', b, () => {
  assert.throws(
    () => m.createChannelPort({ id: 'chatbot', activation: 'live', approvalRef: 'T' }),
    (e) => e.code === 'E_CONFIG',
  );
});

test('능력 선언이 어댑터와 어긋나면 생성이 거부된다', b, () => {
  assert.throws(
    () => m.createChannelPort({
      id: 'chatbot',
      capabilities: { adapter: 'callbot', channel: 'voice', dtmf: true, richUi: false, speech: true, transferToAgent: true, routeToLegacyIvr: false, crossChannelInvite: false },
    }),
    (e) => e.code === 'E_CONFIG',
  );
});

test('전송 실패는 예외로 새지 않고 failures 와 onFailure 로 드러난다', b, async () => {
  const notified = [];
  const t = { name: 'broken', async deliver() { throw new Error('회선 거부'); } };
  const port = m.createChannelPort({
    id: 'callbot', activation: 'live', approvalRef: 'T', transport: t,
    onFailure: (r) => notified.push(r),
  });
  await port.present('i1', [step('voice')]);          // 예외가 위로 새면 Core 턴이 통째로 죽는다
  assert.equal(port.failures.length, 1);
  assert.equal(port.failures[0].errorCode, 'E_TRANSPORT');
  assert.equal(notified.length, 1);
  assert.match(notified[0].detail, /회선 거부/);
});

test('예산 초과는 E_TIMEOUT 실패로 정착한다', b, async () => {
  const t = { name: 'hang', deliver: () => new Promise(() => {}) };
  const port = m.createChannelPort({ id: 'chatbot', activation: 'live', approvalRef: 'T', transport: t, timeoutMs: 20 });
  await port.present('i1', [step('chat')]);
  assert.equal(port.failures.length, 1);
  assert.equal(port.failures[0].errorCode, 'E_TIMEOUT');
});

test('실패 기록과 통지에 개인정보 원문이 남지 않는다', b, async () => {
  const notified = [];
  const t = { name: 'leaky', async deliver() { throw new Error('전송 실패: 010-1234-5678 대상'); } };
  const port = m.createChannelPort({
    id: 'callbot', activation: 'live', approvalRef: 'T', transport: t,
    onFailure: (r) => notified.push(r),
  });
  await port.present('i1', [step('voice')]);
  const dump = JSON.stringify(port.records) + JSON.stringify(notified);
  assert.equal(dump.includes('010-1234-5678'), false, '§10.3 마스킹을 거쳐야 한다');
});

test('종료 사유의 개인정보도 마스킹 후 기록한다', b, async () => {
  const port = m.createChannelPort({ id: 'callbot' });
  await port.end('i1', '고객 010-1234-5678 요청으로 종료');
  assert.equal(JSON.stringify(port.records).includes('010-1234-5678'), false);
});

test('onFailure 훅이 던져도 채널 턴은 죽지 않는다', b, async () => {
  const t = { name: 'broken', async deliver() { throw new Error('거부'); } };
  const port = m.createChannelPort({
    id: 'chatbot', activation: 'live', approvalRef: 'T', transport: t,
    onFailure: () => { throw new Error('알림 시스템 장애'); },
  });
  await port.present('i1', [step('chat')]);
  assert.equal(port.failures.length, 1);
});

test('기록은 상한을 넘지 않는다', b, async () => {
  const port = m.createChannelPort({ id: 'chatbot', maxRecords: 3 });
  for (let i = 0; i < 10; i++) await port.present(`i${i}`, []);
  assert.equal(port.records.length, 3);
  assert.equal(port.records[2].interactionId, 'i9');
});

test('알 수 없는 세션·빈 steps 에서도 무해하게 접수한다', b, async () => {
  const port = m.createChannelPort({ id: 'dars' });
  await port.present('i_없는세션', []);
  await port.transfer('i_없는세션', undefined, undefined);
  assert.equal(port.failures.length, 0);
  assert.equal(port.records.length, 2);
});

test('전환 티켓은 transport 로 그대로 가고 기록에는 토큰이 남지 않는다(§5.2·§10.3)', b, async () => {
  const seen = [];
  const port = m.createChannelPort({
    id: 'callbot',
    activation: 'live',
    approvalRef: 'APPROVAL-TEST-1',
    transport: { async deliver(env) { seen.push(env); } },
  });
  const ticket = {
    token: 'tk_secret_key_1', interactionId: 'i_1', toChannel: 'visual',
    expiresAt: '2026-09-01T09:05:00.000Z',
  };
  await port.invite('i_1', 'visual', ticket);
  // 링크를 만들려면 토큰이 필요하다 — transport 까지는 그대로 간다.
  assert.equal(seen[0].ticket.token, 'tk_secret_key_1');
  // 기록에는 남지 않는다. 남으면 그 로그를 읽는 누구나 남의 상담에 합류할 수 있다.
  const rec = port.records.find((r) => r.kind === 'invite');
  assert.equal(JSON.stringify(rec).includes('tk_secret_key_1'), false);
  assert.match(rec.detail, /ticket=있음/);

  // 배선 전(티켓 없음)에도 종전대로 동작한다 — 한쪽만 되는 구현은 배선을 되돌리는 날 죽는다.
  await port.invite('i_1', 'visual');
  assert.equal(seen[1].ticket, undefined);
  assert.match(port.records.filter((r) => r.kind === 'invite')[1].detail, /ticket=없음/);
});

// ── 접수되지 않은 지시는 Core 에 알린다 (§9.3·§5.2) ─────────────────────────
// 베이스는 "메서드는 던지지 않는다"가 원칙이지만, 기존 IVR 회귀와 전환 초대는 **Core 가
// 접수되지 않은 경우에 할 일을 정해 둔 두 지시**다(회귀 거부 → 상담사 이관, 초대 거부 →
// 사유를 턴 결과에 싣고 턴의 나머지를 내보낸다). 그 대체는 거부가 Core 에 닿아야만 돈다 —
// 삼키던 동안 이 베이스를 쓰는 저장소에서는 두 대체가 **한 번도 돌 수 없었다**.

test('§9.3 회귀가 매체에서 거부되면 베이스가 Core 에 올린다 — 삼키면 이관이 돌지 않는다', b, async () => {
  const notified = [];
  const port = m.createChannelPort({
    id: 'callbot',
    capabilities: { adapter: 'callbot', channel: 'voice', dtmf: true, richUi: false, speech: true, transferToAgent: true, routeToLegacyIvr: true, crossChannelInvite: true },
    activation: 'live',
    approvalRef: 'T',
    transport: { name: 'broken', async deliver() { throw new Error('IVR 게이트웨이 장애'); } },
    onFailure: (r) => notified.push(r),
  });
  await assert.rejects(
    () => port.routeToLegacyIvr('i1', '엔진 장애로 기존 IVR 로 돌립니다'),
    (e) => e.code === 'E_TRANSPORT' && /접수되지 않았습니다/.test(e.message),
  );
  // 실패 기록·통지는 **그대로 남는다** — 올리는 것이 적는 것을 대신하지 않는다.
  assert.equal(port.failures.length, 1);
  assert.equal(notified.length, 1);
});

test('§5.2 초대가 매체에서 거부되면 베이스가 Core 에 올린다', b, async () => {
  const port = m.createChannelPort({
    id: 'callbot',
    activation: 'live',
    approvalRef: 'T',
    transport: { name: 'broken', async deliver() { throw new Error('알림톡 발송 거부'); } },
  });
  await assert.rejects(() => port.invite('i1', 'visual'), (e) => e.code === 'E_TRANSPORT');
  assert.equal(port.failures.length, 1);
});

test('올리는 사유에 개인정보 원문이 섞이지 않는다(§10.3)', b, async () => {
  const port = m.createChannelPort({
    id: 'callbot',
    activation: 'live',
    approvalRef: 'T',
    transport: { name: 'leaky', async deliver() { throw new Error('수신번호 010-1234-5678 발송 거부'); } },
  });
  // Core 는 이 문구를 경고·턴 결과에 싣는다 — 여기서 새면 그 두 곳에 그대로 남는다.
  await assert.rejects(() => port.invite('i1', 'visual'), (e) => !e.message.includes('010-1234-5678'));
});

test('예산 초과도 접수되지 않은 것으로 올린다(경계: 타임아웃)', b, async () => {
  const port = m.createChannelPort({
    id: 'callbot',
    capabilities: { adapter: 'callbot', channel: 'voice', dtmf: true, richUi: false, speech: true, transferToAgent: true, routeToLegacyIvr: true, crossChannelInvite: true },
    activation: 'live', approvalRef: 'T', timeoutMs: 20,
    transport: { name: 'hang', deliver: () => new Promise(() => {}) },
  });
  await assert.rejects(() => port.routeToLegacyIvr('i1', '엔진 장애'), (e) => e.code === 'E_TIMEOUT');
});

test('나머지 세 지시는 종전대로 던지지 않는다 — Core 에 대체 경로가 없다', b, async () => {
  const port = m.createChannelPort({
    id: 'callbot', activation: 'live', approvalRef: 'T',
    transport: { name: 'broken', async deliver() { throw new Error('회선 거부'); } },
  });
  await port.present('i1', [step('voice')]);
  await port.transfer('i1', 'q_vip', '요약');
  await port.end('i1', '종료');
  assert.equal(port.failures.length, 3);
});

test('dry_run 에서는 두 지시도 접수로 끝난다 — 적합성 검사가 실회선 없이 돌아야 한다', b, async () => {
  const port = m.createChannelPort({
    id: 'callbot',
    capabilities: { adapter: 'callbot', channel: 'voice', dtmf: true, richUi: false, speech: true, transferToAgent: true, routeToLegacyIvr: true, crossChannelInvite: true },
    transport: { name: 'broken', async deliver() { throw new Error('부르지 않아야 한다'); } },
  });
  await port.routeToLegacyIvr('i1', '엔진 장애');
  await port.invite('i1', 'visual');
  assert.equal(port.failures.length, 0);
  assert.ok(port.records.every((r) => r.simulated));
});

test('모르는 어댑터 id 는 포트 생성 단계에서 거부된다(§2·§5.3)', b, () => {
  assert.throws(
    () => m.createChannelPort({ id: 'calbot' }),
    (e) => e.code === 'E_CONFIG' && /알 수 없는 채널 어댑터/.test(e.message),
  );
  // 아는 id 세 개는 그대로 만들어진다 — 목록은 계약 하나에서 온다.
  const set = m.createChannelPortSet();
  assert.deepEqual(Object.keys(set).sort(), ['callbot', 'chatbot', 'dars']);
});
