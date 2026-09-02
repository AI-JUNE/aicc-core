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
