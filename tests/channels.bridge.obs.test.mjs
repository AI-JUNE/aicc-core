// 브리지 경계 관측 — §13(운영·모니터링)·§9.3(장애 인지)·§10.3(마스킹)·§11.1(테넌트)·§13-3(실측만)·§2.
//
// 고정하는 것은 "로그가 남는다"가 아니라 **경계에서만 일어나는 실패가 이 프로세스 바깥에서
// 보이게 되었다**는 사실이다. 배선 전에는 깨진 JSONL 줄·모르는 op·다른 테넌트 주장·한도 초과가
// Core 를 부르기 **전에** 응답 줄로 끝났고, 그래서 Core 로그는 완전히 조용했다 — 증상은
// "그 채널만 통화가 안 된다"인데 로그에는 그 통화가 아예 없는 상태다.
//
// 그러면서 새로 만들 수 있는 사고 세 가지를 같이 고정한다:
//  (가) 깨진 줄 원문·오류 문구가 로그로 샌다(발신번호가 섞여 있을 수 있다)
//  (나) Core 가 던진 예외를 브리지가 **또** 올려 한 번의 예외가 보고 두 건이 된다
//  (다) 거부가 error 로 올라가 호스트의 오타 하나가 진짜 예외를 묻는다
import { test } from 'node:test';
import assert from 'node:assert/strict';

let BR = null, R = null, F = null, P = null, BP = null, OBS = null, LG = null, EM = null;
try {
  BR = await import('../src/channels/bridge.ts');
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  P = await import('../src/channels/profiles.ts');
  BP = await import('../src/channels/basePort.ts');
  OBS = await import('../src/obs/executeObservability.ts');
  LG = await import('../src/obs/logger.ts');
  EM = await import('../src/obs/errorMonitor.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: BR ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const NOW = '2026-10-12T09:00:00.000Z';

const flow = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'q', prompt: '문의 내용을 말씀해 주세요.', next: 'ask' },
  },
};

/**
 * 경계 줄만 받는 배선. 런타임의 진입점 관측 줄과 섞이지 않게 **이벤트로 갈라** 담는다 —
 * 섞어 담으면 "경계 실패가 로그에 남는다"가 진입점 줄로도 통과해 버린다.
 */
function wiring() {
  const boundary = [], calls = [], sent = [];
  const sink = (rec) => {
    (rec.event === OBS.REJECTION_EVENT ? boundary : calls).push(rec);
  };
  return {
    boundary, calls, sent,
    binding: {
      logger: LG.createLogger({ minLevel: 'debug', sink }),
      monitor: EM.createErrorMonitor({ transport: (r) => sent.push(r) }),
    },
  };
}

function build(bridgeOver = {}, coreOver = {}) {
  const port = BP.createChannelPort({ id: 'callbot' });
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    now: () => NOW,
    newInteractionId: () => 'i_obs1',
    ...coreOver,
  });
  return BR.createBridge({ core, adapter: 'callbot', scope: SCOPE, ...bridgeOver });
}

const line = (o) => JSON.stringify(o);
const startLine = (id = 's1') => line({ id, op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } });

// ── 1. 미배선 — 종전과 완전히 같다(§13-3) ────────────────────────────────────

test('배선이 없으면 실측을 지어내지 않는다 — 0 건으로 적지 않는다', b, async () => {
  const bridge = build();
  await bridge.handleLine('{깨진 줄');
  assert.equal(bridge.observability(), undefined, '"거부 0건"과 "관측하지 않았다"는 다르다');
  assert.equal(bridge.flushObservability(), 0);
  assert.equal(bridge.records.length, 1, '종전의 기록 경로는 그대로다');
});

test('응답 줄은 배선 유무와 바이트까지 같다 — 관측이 호스트 경로로 새지 않는다', b, async () => {
  const w = wiring();
  const withObs = build({ observability: w.binding });
  const without = build();
  for (const l of ['{깨진 줄', line({ id: '1', op: 'nope' }), startLine()]) {
    const a = BR.encodeResponse(await withObs.handleLine(l));
    const c = BR.encodeResponse(await without.handleLine(l));
    assert.equal(a, c, `관측 배선이 응답을 바꿨다: ${l}`);
  }
});

// ── 2. 경계 실패가 관측에 닿는다 ─────────────────────────────────────────────

test('깨진 JSONL 줄이 경계 거부로 남고, 줄 원문은 어디에도 실리지 않는다(§10.3)', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding });
  // 깨진 줄에 발신번호가 섞여 있는 경우가 실제로 가장 흔하다.
  const broken = '{"id":"1","op":"send","from":"010-1234-5678"';
  const res = await bridge.handleLine(broken);
  assert.equal(res.error.code, 'E_BAD_JSON');
  assert.equal(w.boundary.length, 1);
  const rec = w.boundary[0];
  assert.equal(rec.level, 'warn', '설계된 거부를 error 로 적으면 진짜 예외가 묻힌다');
  assert.equal(rec.code, 'E_BAD_JSON');
  assert.equal(rec.tenantId, 'goone', '스코프는 Core 가 강제하는 값이다(§11.1)');
  assert.equal(rec.fields.stage, 'request');
  assert.equal(rec.fields.lineBytes, Buffer.byteLength(broken, 'utf8'), '실측 바이트 수만 적는다');
  const dump = LG.formatLine(rec);
  assert.ok(!dump.includes('1234'), `로그 줄에 발신번호 조각이 남았다: ${dump}`);
  assert.ok(!dump.includes('op":"send'), `줄 원문이 로그로 샜다: ${dump}`);
  assert.equal(w.sent.length, 0, '깨진 줄은 수집기로 올리지 않는다 — 창 상한에 진짜 예외가 밀린다');
  assert.equal(bridge.observability().rejected, 1);
});

test('모르는 op 는 값을 싣지 않고 요청 id 만 남는다', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding });
  await bridge.handleLine(line({ id: 'r9', op: '홍길동 010-1234-5678' }));
  const rec = w.boundary[0];
  assert.equal(rec.code, 'E_UNKNOWN_OP');
  assert.equal(rec.requestId, 'r9');
  assert.equal(rec.fields.op, undefined, 'op 는 호스트가 보낸 임의 문자열이다');
  assert.ok(!LG.formatLine(rec).includes('홍길동'));
});

test('다른 테넌트 주장이 §11.1 사유와 함께 남는다', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding });
  const res = await bridge.handleLine(line({
    id: 't1', op: 'start',
    req: { flowId: 'billing', entryPoint: 'inbound_call', scope: { tenantId: 'other' } },
  }));
  assert.equal(res.error.code, 'E_TENANT_SCOPE');
  assert.equal(w.boundary[0].code, 'E_TENANT_SCOPE');
  assert.equal(w.boundary[0].fields.stage, 'request');
  assert.ok(!LG.formatLine(w.boundary[0]).includes('other'), '주장된 테넌트를 로그에 적지 않는다');
});

test('요청 한도 초과는 계산된 대기와 함께 남는다(§11.2)', b, async () => {
  const w = wiring();
  const limiter = { check: () => ({ allowed: false, retryAfterMs: 250, remaining: 0 }) };
  const bridge = build({ observability: w.binding, rateLimiter: limiter });
  const res = await bridge.handleLine(startLine());
  assert.equal(res.error.code, 'E_RATE_LIMITED');
  assert.equal(w.boundary[0].fields.retryAfterMs, 250);
  assert.equal(w.boundary[0].fields.op, 'start');
  assert.equal(w.sent.length, 0);
});

test('줄 상한 초과도 관측된다 — 상한을 준 경우에만 생기는 실패다', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding, maxLineBytes: 20 });
  await bridge.handleLine(startLine());
  assert.equal(w.boundary[0].code, 'E_TOO_LARGE');
  assert.ok(w.boundary[0].fields.lineBytes > 20);
});

test('요청 id 자리에 발신번호를 넣은 호스트의 값은 싣지 않는다(§10.3)', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding });
  await bridge.handleLine(line({ id: '01012345678', op: 'nope' }));
  const rec = w.boundary[0];
  assert.equal(rec.requestId, undefined);
  assert.ok(!LG.formatLine(rec).includes('01012345678'));
  assert.equal(bridge.observability().droppedIds, 1, '호스트의 id 생성 규칙 결함이 집계된다');
});

// ── 3. 중복 보고를 만들지 않는다(§2) ─────────────────────────────────────────

test('성공한 줄은 관측에 올리지 않는다 — 같은 턴이 로그에 두 줄로 남으면 집계가 두 배가 된다', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding });
  await bridge.handleLine(line({ id: 'h', op: 'hello' }));
  const s = await bridge.handleLine(startLine());
  assert.equal(s.ok, true);
  assert.equal(w.boundary.length, 0);
  assert.equal(bridge.observability().rejected, 0);
});

test('Core 가 던진 예외는 브리지가 다시 올리지 않는다 — 로그 상관 한 줄만 남긴다', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding });
  const res = await bridge.handleLine(line({
    id: 'x1', op: 'send', interactionId: '없는_세션', turn: { input: { kind: 'utterance', text: '여보세요' } },
  }));
  assert.equal(res.error.code, 'E_INTERNAL');
  assert.equal(w.boundary.length, 1);
  assert.equal(w.boundary[0].fields.stage, 'core');
  assert.equal(w.boundary[0].level, 'error');
  assert.equal(w.boundary[0].requestId, 'x1', '요청 id ↔ 오류 코드 상관은 Core 쪽 줄에 없다');
  assert.equal(w.sent.length, 0, '같은 예외가 보고 두 건이 되면 안 된다(§2)');
  assert.ok(!LG.formatLine(w.boundary[0]).includes('없는_세션'));
});

test('응답 투영 중 예외는 브리지만 아는 실패라 수집기로 올라간다', b, async () => {
  const w = wiring();
  // Core 는 성공을 돌려주는데 응답으로 바꿀 수 없는 결과다 — Core 로그에는 성공으로 남고
  // 호스트는 실패를 받는 상태이고, 아무도 보고하지 않던 유일한 자리다.
  const brokenCore = {
    contractVersion: 1,
    start: async () => ({
      interactionId: 'i_x', status: 'running', steps: [],
      state: {
        flowId: 'billing', flowVersion: 1, channel: 'voice', currentNodeId: 'greet',
        slots: {}, failCount: 0, turnCount: 1, eventSeq: 1, status: 'running', visited: [],
      },
      events: null,
    }),
    send: async () => { throw new Error('미사용'); },
    end: async () => { throw new Error('미사용'); },
    reportHealth: () => {},
  };
  const bridge = BR.createBridge({
    core: brokenCore, adapter: 'callbot', scope: SCOPE, observability: w.binding,
  });
  const res = await bridge.handleLine(startLine());
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_INTERNAL');
  assert.equal(w.boundary[0].fields.stage, 'response');
  assert.equal(w.sent.length, 1, '여기만 올린다');
  assert.equal(bridge.observability().captured, 1);
});

// ── 4. 관측이 줄 처리를 죽이지 않는다(§9.3) ──────────────────────────────────

test('로거가 던져도 응답은 그대로 나가고 실패가 집계된다', b, async () => {
  const boom = () => { throw new Error('sink 폭발'); };
  const logger = {
    minLevel: 'info', debug: boom, info: boom, warn: boom, error: boom,
    child() { return logger; }, async time(_e, run) { return run(); },
  };
  const bridge = build({ observability: { logger } });
  const res = await bridge.handleLine('{깨진 줄');
  assert.equal(res.error.code, 'E_BAD_JSON');
  assert.equal(bridge.observability().failed, 1, '실패는 삼키지 않고 센다');
  // 다음 줄도 정상 처리된다 — 관측 실패가 큐를 끊지 않는다.
  const s = await bridge.handleLine(startLine());
  assert.equal(s.ok, true);
});

test('수집기 억제분 방출은 배선이 있을 때만 수를 돌려준다', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding });
  assert.equal(typeof bridge.flushObservability(), 'number');
  assert.equal(build().flushObservability(), 0);
});

// ── 5. 실행기 경유(비-Node 호스트 경로) ──────────────────────────────────────
//
// 브리지가 배선을 받는 것만으로는 Callbot 에 닿지 않는다. 파이썬 에이전트가 쓰는 것은 CLI
// 실행기이고, 실행기가 넘기지 않으면 관측은 **아무도 지나가 보지 않은 길**로 남는다
// (제한기에서 한 번 데인 지점이다).

test('실행기는 Core 모듈이 내놓은 관측 배선을 브리지에 넘긴다', b, async () => {
  const { spawnSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const input = [
    '{"id":"1","op":"hello"}',
    '{"id":"2","op":"send","interactionId":"없는_세션","from":"010-1234-5678"',  // 깨진 줄
    '',
  ].join('\n');
  const run = spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'channel-bridge.mjs'), '--core', './fixtures/reference-core-observed.mjs',
     '--adapter', 'callbot'],
    { cwd: ROOT, input, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);

  // 응답 스트림(표준출력)은 **JSONL 그대로**다 — 로그가 섞이면 호스트의 파서가 죽는다.
  const out = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out.length, 2);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].error.code, 'E_BAD_JSON');

  const logs = run.stderr.trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  const rejected = logs.filter((r) => r.event === OBS.REJECTION_EVENT);
  assert.equal(rejected.length, 1, '실행기가 배선을 넘기지 않았다 — 비-Node 호스트에서는 경계 실패가 보이지 않는다');
  assert.equal(rejected[0].code, 'E_BAD_JSON');
  assert.equal(rejected[0].tenantId, 'reference');
  assert.ok(!run.stderr.includes('1234'), `로그에 발신번호 조각이 남았다: ${run.stderr}`);
  // 등록 시점 계약 경고도 같은 스트림으로 나간다 — 호스트가 warnings() 를 읽지 않아도 보인다.
  assert.ok(logs.some((r) => r.event === OBS.WARNING_EVENT), '미배선 경고가 로그로 나가지 않았다');
});

// ── 6. 관측 실측이 비-Node 호스트에 닿는다(§13-3·§10.3) ──────────────────────
//
// 배선을 켠 것만으로는 부족하다. `failed`·`droppedIds` 는 **그 두 결함의 유일한 신호**다 —
// 로거·수집기가 던지면 Core 는 통화를 끊지 않고 `failed` 로만 세고(그래서 "로그를 붙였다"와
// "로그가 나가고 있다"가 바깥에서 구분되지 않는다), 호스트의 통화 id·상관관계 id 가 개인정보
// 패턴에 걸리면 그 줄은 식별자 없이 남고 `droppedIds` 로만 집계된다. 둘 다 예외가 아니고,
// 비-Node 호스트에는 그 수치를 읽을 자리가 아예 없었다.

const STAT_KEYS = ['recorded', 'rejected', 'warned', 'logged', 'captured', 'failed', 'droppedIds'];

test('observability op 이 Core 수치를 내보낸다 — 호스트가 자기 결함을 읽을 유일한 자리다', b, async () => {
  const w = wiring();
  const bridge = build(
    { observability: w.binding, maintenance: { observability: true } },
    { observability: w.binding },
  );
  // 호스트의 통화 id 가 개인정보 형태인 배치를 재현한다(§10.3) — 그 줄은 식별자 없이 남는다.
  await bridge.handleLine(line({
    id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call', correlationId: '010-1234-5678' },
  }));
  await bridge.handleLine('{깨진 줄');
  const r = await bridge.handleLine(line({ id: '2', op: 'observability' }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  for (const k of STAT_KEYS) assert.equal(typeof r.result.core[k], 'number', `${k} 수치가 없다`);
  assert.ok(r.result.core.droppedIds > 0, '개인정보 형태의 id 가 제외된 사실이 호스트에 닿지 않는다(§10.3)');
  // 경계 수치는 **합치지 않는다** — Core 에 닿지도 못한 줄과 닿은 줄이 한 숫자가 되면
  // "호스트 직렬화 버그로 전 줄이 깨지는" 상태가 "통화가 잘 도는" 상태와 같아 보인다.
  assert.equal(r.result.bridgeKnown, true);
  assert.equal(r.result.bridge.rejected, 1);
  assert.equal(r.result.core.rejected, 0, '브리지 경계 거부가 Core 수치로 섞였다');
});

test('로거가 던지는 상태가 수치로 호스트에 닿는다(실패 경로)', b, async () => {
  const boom = () => { throw new Error('sink 폭발'); };
  const logger = {
    minLevel: 'info', debug: boom, info: boom, warn: boom, error: boom,
    child() { return logger; }, async time(_e, run) { return run(); },
  };
  const bridge = build(
    { maintenance: { observability: true } },
    { observability: { logger } },
  );
  await bridge.handleLine(startLine());
  const r = await bridge.handleLine(line({ id: '2', op: 'observability' }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.result.core.failed > 0, '로그가 한 줄도 나가지 않는데 호스트는 "붙였다"로 믿는다');
  // 브리지 쪽 배선이 없으면 그 자리는 **싣지 않는다** — 0 은 "거부 0건"으로 읽힌다.
  assert.equal(r.result.bridgeKnown, false);
  assert.equal(r.result.bridge, undefined);
  assert.ok(r.result.reasonKo.length > 0);
});

test('Core 에 관측 배선이 없으면 0 이 아니라 E_NOT_WIRED 다(실패 경로)', b, async () => {
  const bridge = build({ maintenance: { observability: true } });
  const r = await bridge.handleLine(line({ id: '1', op: 'observability' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_NOT_WIRED');
  assert.equal(r.result, undefined, '"실패 0건"으로 읽힐 본문을 돌려주면 안 된다(§13-3)');
});

test('스위치를 켜지 않으면 거절된다 — 기본은 닫힘이다(경계)', b, async () => {
  const w = wiring();
  const bridge = build({ observability: w.binding }, { observability: w.binding });
  const r = await bridge.handleLine(line({ id: '1', op: 'observability' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_NOT_WIRED');
  const hello = await bridge.handleLine(line({ id: '2', op: 'hello' }));
  assert.ok(!hello.result.maintenanceOps.includes('observability'));
});

test('읽기가 억제분을 방출하지 않는다 — 종료 직전 방출이 빈 손이 되면 안 된다', b, async () => {
  const sent = [];
  // 중복 억제 창을 켠 수집기. 같은 지문의 두 번째 보고는 **보류**되고 방출로만 나간다.
  const binding = {
    monitor: EM.createErrorMonitor({ transport: (r) => sent.push(r), clock: () => 1, dedupeWindowMs: 60000 }),
  };
  const port = BP.createChannelPort({ id: 'callbot' });
  const real = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    now: () => NOW,
    observability: binding,
  });
  // 응답으로 바꿀 수 없는 결과 — **브리지만 아는 실패**라 수집기로 올라간다(위 3절).
  const core = {
    contractVersion: real.contractVersion,
    start: async () => ({
      interactionId: 'i_x', status: 'running', steps: [],
      state: {
        flowId: 'billing', flowVersion: 1, channel: 'voice', currentNodeId: 'greet',
        slots: {}, failCount: 0, turnCount: 1, eventSeq: 1, status: 'running', visited: [],
      },
      events: null,
    }),
    send: (i, t) => real.send(i, t),
    end: (i, r, x) => real.end(i, r, x),
    reportHealth: (r) => real.reportHealth(r),
    observability: () => real.observability(),
  };
  const bridge = BR.createBridge({
    core, adapter: 'callbot', scope: SCOPE,
    observability: binding, maintenance: { observability: true },
  });
  await bridge.handleLine(startLine('s1'));
  await bridge.handleLine(startLine('s2'));
  assert.equal(sent.length, 1, '같은 지문의 두 번째 보고가 억제되지 않았다 — 이 검사의 전제가 깨졌다');
  const r = await bridge.handleLine(line({ id: '1', op: 'observability' }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sent.length, 1, '읽기에 부작용을 섞으면 대시보드 새로고침마다 보고가 나간다');
  // 방출은 종료 시점에 실행기가 한 번 한다.
  assert.ok(bridge.flushObservability() > 0, '억제분이 남아 있지 않다 — 방출이 빈 손이 된다');
  assert.equal(sent.length, 2);
});

test('실행기 경유로도 관측 실측을 읽을 수 있다 — 지원만 하고 아무도 못 지나가면 없는 기능이다', b, async () => {
  const { spawnSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const input = ['{"id":"1","op":"hello"}', '{"id":"2","op":"observability"}', ''].join('\n');
  const run = spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'channel-bridge.mjs'), '--core', './fixtures/reference-core-observed.mjs',
     '--adapter', 'callbot'],
    { cwd: ROOT, input, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(out[0].result.maintenanceOps, ['observability'],
    '예시가 열어 두지 않으면 호스트는 열린 op 를 알 길이 없다');
  assert.equal(out[1].ok, true, JSON.stringify(out[1].error));
  for (const k of STAT_KEYS) assert.equal(typeof out[1].result.core[k], 'number', `${k} 수치가 없다`);
});

test('실행기가 종료 직전 Core 관측기까지 방출한다 — 런타임에만 배선한 배치가 조용히 잃던 것이다', b, async () => {
  const { spawnSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  // **관측 배선을 브리지에 내놓지 않는** 모듈. 종전에는 `bridge.flushObservability()` 하나만
  // 불렀으므로 이 배치에서는 Core 쪽 억제분이 프로세스와 함께 사라졌다 — 하필 종료 직전의
  // 보고가 조사에서 가장 먼저 필요한 것이다. 호스트가 "같은 객체를 양쪽에 준다"를 지켰는지에
  // 기대지 않는다.
  const mod = [
    'export default function () {',
    '  return {',
    "    scope: { tenantId: 'reference' },",
    '    core: {',
    '      contractVersion: 1,',
    "      start: async () => { throw new Error('미사용'); },",
    "      send: async () => { throw new Error('미사용'); },",
    "      end: async () => { throw new Error('미사용'); },",
    '      reportHealth: () => {},',
    "      flushObservability: () => { process.stderr.write('CORE_FLUSHED\\n'); return 0; },",
    '    },',
    '  };',
    '}',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'aicc-flush-'));
  const file = join(dir, 'core.mjs');
  writeFileSync(file, mod, 'utf8');
  try {
    const run = spawnSync(process.execPath,
      [join(ROOT, 'scripts', 'channel-bridge.mjs'), '--core', file, '--adapter', 'callbot'],
      { cwd: ROOT, input: '{"id":"1","op":"hello"}\n', encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).ok, true);
    assert.ok(run.stderr.includes('CORE_FLUSHED'), `Core 관측기의 억제분이 방출되지 않았다: ${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('실행기: 관측을 내놓지 않는 모듈은 종전과 완전히 같다(§13-3)', b, async () => {
  const { spawnSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const run = spawnSync(process.execPath,
    [join(ROOT, 'scripts', 'channel-bridge.mjs'), '--core', './fixtures/reference-core.mjs',
     '--adapter', 'callbot'],
    { cwd: ROOT, input: '{깨진 줄\n', encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout.trim()).error.code, 'E_BAD_JSON');
  assert.equal(run.stderr.trim(), '', '배선이 없으면 한 줄도 남지 않는다');
});
