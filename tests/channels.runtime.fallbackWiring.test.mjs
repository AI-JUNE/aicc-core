// §9.3 폴백 배선의 세 공백 — 정상 경로 + 실패·경계 경로.
//
// 1) **폴백 정책의 테넌트를 아무도 보지 않았다(§11.1).** 보존 정책·라우팅 설정·엔진 기동
//    선언은 전부 배선 시점에 스코프를 검사하는데 `FallbackPolicy` 만 그냥 들어왔다.
//    이 정책은 장애 시각에 통화 전체의 행동을 정하고, 그중 `fallbackQueue` 는 고객이
//    **실제로 가는 곳**이다 — 남의 테넌트 큐 id 가 들어 있으면 그 사실은 장애 시각에만 난다.
// 2) **정책은 "IVR 로 내린다"인데 그 채널에 회귀 구현이 없다.** Core 는 상담사 이관으로
//    대신하는데 결과·원장에는 `fallback.mode: 'legacy_ivr'` 만 남는다 — 사후 분석은
//    "IVR 로 내렸다"로 읽고(아무도 내리지 않았다) 통화가 끊기지 않아 장애로도 안 잡힌다.
// 3) **종료된 세션에 늦게 도착한 입력의 §11.2 실측.** 그 턴의 STT 는 이미 돌았고 비용은
//    공급사 청구서에 남는데, Core 는 직전 턴의 `billing` 을 그대로 되돌려줬다 —
//    직전 턴이 `usageAttached: true` 였으면 호스트는 방금 보낸 실측이 원장에 들어갔다고 읽는다.
//    `end()` 가 늦은 `billableMs` 를 다루는 방식(사실을 돌려준다)과 같은 규칙으로 맞춘다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let R = null, F = null, B = null, P = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-19T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };

const flowAsk = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.' },
  },
};

/** 기본 포트는 회귀 구현을 **가지고 있다** — 없는 쪽은 테스트마다 따로 뺀다. */
function fakePort(id = 'callbot', over = {}) {
  const log = [];
  return {
    id, log,
    capabilities: P.profileFor(id),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue, summary) { log.push(['transfer', iid, queue, summary]); },
    async routeToLegacyIvr(iid, reason) { log.push(['ivr', iid, reason]); },
    async invite() {},
    async end(iid, reason) { log.push(['end', iid, reason]); },
    ...over,
  };
}

/** 회귀 구현이 없는 포트. 능력 선언은 기본 프로파일 그대로(셋 다 false)다. */
function portWithoutIvr(id = 'callbot') {
  const p = fakePort(id);
  delete p.routeToLegacyIvr;
  return p;
}

function build({ scope = SCOPE, port = fakePort(), samples = [], policy = {} } = {}) {
  const collector = B.createCollectorSink('t');
  const bus = B.createEventBus({
    scope, sinks: [collector],
    store: B.createMemoryIdempotencyStore({ maxKeys: 200 }), releaseKeyOnSinkFailure: false,
  });
  const core = R.createConversationCore({
    scope,
    flows: R.createMemoryFlowRegistry([flowAsk]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS[port.id], contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true, ...policy,
    },
    health: F.createHealthRegistry(samples),
    bus, now: () => NOW,
    newInteractionId: () => 'i_fb1',
  });
  return { core, port, collector };
}

const reqOf = (over = {}) => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing', ...over });
const sample = (component, state) => ({ component, state, observedAt: NOW });

// ── 1) 폴백 정책의 테넌트·워크스페이스(§11.1) ────────────────────────────────

test('정책 테넌트가 스코프와 같으면 종전과 같이 기동한다', b, async () => {
  const { core } = build();
  const r = await core.start(reqOf());
  assert.equal(r.status, 'running');
});

test('다른 테넌트의 §9.3 정책은 기동을 거절한다 — 남의 큐로 전화가 넘어간다(§11.1)', b, () => {
  if (!R) return;
  assert.throws(
    () => build({ policy: { tenantId: 'other', fallbackQueue: 'q_other_care' } }),
    /폴백 정책 거부[\s\S]*다른 테넌트/,
  );
});

test('워크스페이스는 선언했을 때만 본다 — 미선언이면 종전과 완전히 같다(§13-3)', b, async () => {
  const scope = { tenantId: 'goone', workspaceId: 'ws_a' };
  // 정책에 workspaceId 가 없다: 종전 호스트의 모양이며 거절하지 않는다.
  const { core } = build({ scope });
  const r = await core.start({ ...reqOf(), scope });
  assert.equal(r.status, 'running');
});

test('워크스페이스를 선언했는데 어긋나면 거절한다 — 옆 사업부 큐로 간다(§11.1)', b, () => {
  if (!R) return;
  assert.throws(
    () => build({ scope: { tenantId: 'goone', workspaceId: 'ws_a' }, policy: { workspaceId: 'ws_b' } }),
    /폴백 정책 거부[\s\S]*다른 워크스페이스/,
  );
});

test('워크스페이스 선언이 스코프와 같으면 통과한다', b, async () => {
  const scope = { tenantId: 'goone', workspaceId: 'ws_a' };
  const { core } = build({ scope, policy: { workspaceId: 'ws_a' } });
  const r = await core.start({ ...reqOf(), scope });
  assert.equal(r.status, 'running');
});

// ── 2) IVR 회귀를 할 수 없는 채널(W_FALLBACK_LEGACY_IVR) ─────────────────────

test('정책은 IVR 가능인데 채널에 회귀 구현이 없으면 등록 시점에 드러낸다', b, () => {
  if (!R) return;
  const { core } = build({ port: portWithoutIvr(), policy: { legacyIvrAvailable: true } });
  const w = core.warnings().find((x) => x.code === 'W_FALLBACK_LEGACY_IVR');
  assert.ok(w, '경고가 없다');
  assert.match(w.messageKo, /routeToLegacyIvr 구현이 없습니다/);
  // 막지는 않는다 — 상담사 이관이 서 있으면 고객이 갈 곳은 있다(§13-3).
  assert.equal(w.severity, 'warning');
});

test('회귀 구현이 있으면 경고하지 않는다 — 해당 없는 경고는 진짜 신호를 묻는다', b, () => {
  if (!R) return;
  const { core } = build({ policy: { legacyIvrAvailable: true } });
  assert.equal(core.warnings().some((x) => x.code === 'W_FALLBACK_LEGACY_IVR'), false);
});

test('정책이 IVR 불가면 구현이 없어도 경고하지 않는다 — 애초에 그 경로를 쓰지 않는다', b, () => {
  if (!R) return;
  const { core } = build({ port: portWithoutIvr(), policy: { legacyIvrAvailable: false } });
  assert.equal(core.warnings().some((x) => x.code === 'W_FALLBACK_LEGACY_IVR'), false);
});

test('실제로 대신한 턴: transfer 로 가고 판정은 legacy_ivr 그대로이며 대신한 사실이 남는다', b, async () => {
  const port = portWithoutIvr();
  const { core } = build({ port, samples: [sample('llm', 'down')], policy: { legacyIvrAvailable: true, fallbackQueue: 'q_care' } });
  const r = await core.start(reqOf());
  assert.equal(r.status, 'transferred');
  // 판정을 고쳐 적지 않는다 — 무엇을 할지는 `decideFallbackMode` 하나다(§2).
  assert.equal(r.fallback.mode, 'legacy_ivr');
  assert.equal(port.log.some((l) => l[0] === 'ivr'), false);
  const transfer = port.log.find((l) => l[0] === 'transfer');
  assert.ok(transfer, 'transfer 로도 가지 않았다');
  assert.equal(transfer[2], 'q_care');
  // 대신했다는 사실이 남지 않으면 사후 분석은 fallback.mode 만 보고 "IVR 로 내렸다"로 읽는다.
  const w = core.warnings().filter((x) => x.code === 'W_FALLBACK_LEGACY_IVR');
  assert.ok(w.some((x) => /상담사 이관으로 대신했습니다/.test(x.messageKo)));
});

test('회귀 구현이 있는 채널은 종전대로 IVR 로 내린다 — 대신했다는 기록을 만들지 않는다', b, async () => {
  const { core, port } = build({ samples: [sample('llm', 'down')], policy: { legacyIvrAvailable: true } });
  const r = await core.start(reqOf());
  assert.equal(r.fallback.mode, 'legacy_ivr');
  assert.ok(port.log.some((l) => l[0] === 'ivr'));
  assert.equal(
    core.warnings().some((x) => x.code === 'W_FALLBACK_LEGACY_IVR' && /대신했습니다/.test(x.messageKo)),
    false,
  );
});

// ── 3) 종료된 세션에 늦게 도착한 입력의 §11.2 실측 ──────────────────────────

/** 세션을 끝까지 돌려 **종료 상태**로 만든다. 마지막 턴은 실측을 싣고 끝난다. */
async function endedSession() {
  const built = build();
  await built.core.start(reqOf());
  const last = await built.core.send('i_fb1', {
    input: { kind: 'utterance', text: '홍길동' },
    usage: { llm_prompt_tokens: 30, llm_completion_tokens: 7 },
  });
  assert.equal(last.status, 'completed');
  assert.equal(last.billing.usageAttached, true);
  return { ...built, last };
}

test('늦은 입력에 실측을 선언하면 싣지 못했다는 사실을 돌려준다(§8.1·§11.2)', b, async () => {
  const { core } = await endedSession();
  const r = await core.send('i_fb1', {
    input: { kind: 'utterance', text: '여보세요' },
    usage: { stt_seconds: 4 },
  });
  assert.equal(r.billing.usageAttached, false);
  assert.match(r.billing.usageReasonKo, /이미 종료된 세션/);
  // 새 이벤트를 만들지 않는다(멱등, §8.1) — 직전 결과를 다시 발행해 중복 집계하지 않는다.
  assert.deepEqual(r.events, []);
});

test('직전 턴의 usageAttached: true 가 늦은 입력의 답으로 새어 나오지 않는다', b, async () => {
  const { core, last } = await endedSession();
  const r = await core.send('i_fb1', { input: { kind: 'utterance', text: '여보세요' }, usage: { stt_seconds: 4 } });
  assert.equal(last.billing.usageAttached, true);
  assert.notEqual(r.billing.usageAttached, last.billing.usageAttached);
});

test('실측을 선언하지 않은 늦은 입력도 직전 턴의 과금 근거를 되풀이하지 않는다 — 상태만 그대로다', b, async () => {
  // 선언이 **있는** 갈래는 이미 막혀 있었는데(바로 위 검사) 없는 갈래는 `lastResult` 를 통째로
  // 돌려주어 직전 턴의 `usageAttached: true` 가 그대로 새어 나왔다 — 아무 실측도 싣지 않은
  // 호출이 "실었다"고 답한 셈이다. 전송 계층의 재시도 루프가 이 경로로 몰리므로 그 거짓
  // 진술은 임의의 횟수만큼 되풀이된다(§11.2). 상태(단계·세션)는 되풀이하는 것이 의도다.
  const { core, last } = await endedSession();
  const r = await core.send('i_fb1', { input: { kind: 'utterance', text: '여보세요' } });
  assert.equal(last.billing.usageAttached, true);
  assert.equal(r.billing, undefined, '선언이 없는 호출이 직전 턴의 과금 근거를 들고 돌아왔다');
  assert.deepEqual(r.events, []);
  assert.equal(r.status, last.status);
  assert.deepEqual(r.state, last.state, '상태를 되풀이하지 않으면 채널이 마지막 안내를 못 렌더한다');
  assert.deepEqual(r.steps, last.steps);
});

test('늦은 입력은 직전 턴의 전환 초대·고지·확정 동의를 다시 싣지 않는다(§5.2·§10.1·§8.1)', b, async () => {
  // 이 경로들은 `lastResult` 를 그대로 돌려준다. 거기에는 상태가 아니라 **그 턴에 일어난 사실**을
  // 적는 칸이 섞여 있어서, 되풀이하면 호스트가 한 번 일어난 일을 여러 번 수행·기록한다:
  // 전환 링크 재발송(1회용 열쇠가 무의미해진다) · 고지 감사 근거 중복 · 같은 동의가 추가 전용
  // 이력에 여러 번. 셋 다 예외가 아니고, 재시도 루프가 이 경로로 몰리므로 건수도 적지 않다.
  const { core, last } = await endedSession();
  const rec = core.sessions.get('i_fb1');
  rec.lastResult = {
    ...last,
    disclosure: { channel: 'voice', placement: 'first_turn', configVersion: 3 },
    consent: {
      recorded: { purpose: 'recording', state: 'granted', policyVersion: 2 },
      notRecordedKo: '적지 못한 사유',
      pendingRequired: ['marketing'],
    },
    switchInvite: { fromChannel: 'voice', toChannel: 'visual', ticketIssued: true, expiresAt: NOW },
  };
  core.sessions.put(rec);

  const late = await core.send('i_fb1', { input: { kind: 'utterance', text: '여보세요' } });
  assert.equal(late.switchInvite, undefined, '끝난 통화의 늦은 입력마다 전환 링크를 다시 보내게 된다');
  assert.equal(late.disclosure, undefined, '아무 고지도 나가지 않은 호출이 고지 근거를 들고 돌아왔다');
  assert.equal(late.consent.recorded, undefined, '같은 동의가 이력에 여러 번 적힌다');
  assert.equal(late.consent.notRecordedKo, undefined);
  // **서 있는 값은 남는다** — 지금 미획득인 필수 목적은 그 동안 개인정보 조회가 막힌다는 뜻이고,
  // 지우면 호스트는 막힌 이유를 알 길이 없다(§10.1).
  assert.deepEqual(late.consent.pendingRequired, ['marketing']);

  // 선언이 **있는** 갈래도 같은 규칙이다(그 갈래는 billing 만 바꿔 끼우고 나머지는 새고 있었다).
  const declared = await core.send('i_fb1', { input: { kind: 'utterance', text: '여보세요' }, usage: { stt_audio_ms: 400 } });
  assert.equal(declared.switchInvite, undefined);
  assert.equal(declared.disclosure, undefined);
  assert.equal(declared.consent.recorded, undefined);
  assert.equal(declared.billing.usageAttached, false, '늦은 입력의 실측은 실리지 않는다(§8.1)');

  // 이미 닫힌 세션에 end 를 다시 불러도 같다 — `close()`·예외 경로에서 실제로 일어난다.
  const twice = await core.end('i_fb1', '한 번 더', { billableMs: 1000 });
  assert.equal(twice.switchInvite, undefined);
  assert.equal(twice.disclosure, undefined);
  assert.equal(twice.consent.recorded, undefined);
  assert.equal(twice.billing.billableMsRecorded, false);
});

test('동의에 서 있는 값이 없으면 칸 자체를 만들지 않는다 — 빈 객체는 "확인했는데 없음"으로 읽힌다(경계)', b, async () => {
  const { core, last } = await endedSession();
  const rec = core.sessions.get('i_fb1');
  rec.lastResult = { ...last, consent: { recorded: { purpose: 'recording', state: 'denied', policyVersion: 1 } } };
  core.sessions.put(rec);
  const late = await core.send('i_fb1', { input: { kind: 'utterance', text: '여보세요' } });
  assert.equal(late.consent, undefined, '빈 동의 객체가 실렸다 — 호스트는 그것을 "동의 판정 있음"으로 읽는다');
});

test('빈 사용량 객체도 선언이다 — 실을 수 없다는 사실을 돌려준다(조용히 버리지 않는다)', b, async () => {
  const { core } = await endedSession();
  const r = await core.send('i_fb1', { input: { kind: 'utterance', text: '여보세요' }, usage: {} });
  assert.equal(r.billing.usageAttached, false);
});
