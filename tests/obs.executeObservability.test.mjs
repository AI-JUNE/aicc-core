// 관측 실행기 검사 — 설계서 §13·§9.3·§10.3·§11.1·§13-3·§2.
//
// 고정하는 것은 "로그가 남는다"가 아니라 **"관측을 붙이면서 새로 만들 수 있는 사고 여섯 가지"**다.
// 로거는 실제 `createLogger`(실제 `DENIED_FIELDS`·실제 `maskPii`), 수집기는 실제
// `createErrorMonitor` 를 지난다 — 가짜를 세워 두면 "마스킹을 거친다"가 검사되지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let O = null, L = null, M = null;
try {
  O = await import('../src/obs/executeObservability.ts');
  L = await import('../src/obs/logger.ts');
  M = await import('../src/obs/errorMonitor.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: O ? false : '타입 스트리핑 미지원 런타임' };

const SRC = O
  ? readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'obs', 'executeObservability.ts'), 'utf8')
  : '';

const SCOPE = { tenantId: 'goone' };

/** 실제 로거 + 수집 sink. 레코드는 그대로(직렬화 전) 본다. */
function wiring(over = {}) {
  const sink = L.createMemorySink();
  const sent = [];
  const logger = L.createLogger({ minLevel: 'debug', sink, ...(over.loggerOpts ?? {}) });
  const monitor = M.createErrorMonitor({ transport: (r) => sent.push(r), ...(over.monitorOpts ?? {}) });
  const observer = O.createObserver({ logger, monitor, ...(over.binding ?? {}) });
  return { sink, sent, logger, monitor, observer, records: sink.records };
}

/** 최소 결과 한 건. 실제 계약(`ChannelTurnResult`) 모양이다. */
function result(over = {}) {
  return {
    interactionId: 'i_chatbot_abc',
    state: {
      flowId: 'f_main', flowVersion: 1, channel: 'chat', currentNodeId: 'n1',
      slots: {}, failCount: 0, turnCount: 1, eventSeq: 1, status: 'running', visited: ['n1'],
    },
    steps: [],
    status: 'running',
    events: [],
    ...over,
  };
}

// ── 1. 식별자 관문 — 고정 필드는 마스킹을 지나지 않는다(§10.3) ──────────────────

test('개인정보가 섞인 상관관계 id 는 로그에 싣지 않고 걸렸다는 사실만 남긴다', b, () => {
  const w = wiring();
  const d = w.observer.record({ op: 'start', scope: SCOPE, correlationId: '010-1234-5678', result: result() });
  assert.equal(d.ids.requestId, undefined);
  assert.deepEqual(d.droppedIds, ['correlationId']);
  assert.equal(d.fields.correlationIdPiiKinds, 'phone');
  const line = L.formatLine(w.records[0]);
  assert.ok(!line.includes('1234'), `로그 줄에 번호 조각이 남았다: ${line}`);
  assert.equal(w.records[0].requestId, undefined);
  assert.equal(w.observer.stats().droppedIds, 1);
});

test('정상 상관관계 id 는 그대로 실린다', b, () => {
  const w = wiring();
  const d = w.observer.record({ op: 'send', scope: SCOPE, correlationId: 'call_7f3a', result: result() });
  assert.equal(d.ids.requestId, 'call_7f3a');
  assert.equal(w.records[0].requestId, 'call_7f3a');
});

test('개인정보 패턴에 걸리는 통화 id 는 로그 고정 필드에 실리지 않는다', b, () => {
  // 호스트가 발신번호를 통화 id 로 쓰면 그 값이 모든 줄에 영구 보존된다.
  const w = wiring();
  const d = w.observer.record({ op: 'send', scope: SCOPE, interactionId: '010-9876-5432', result: result() });
  assert.deepEqual(d.droppedIds, ['interactionId']);
  assert.equal(w.records[0].interactionId, undefined);
  assert.ok(!L.formatLine(w.records[0]).includes('9876'));
});

test('제어문자·줄바꿈·과길이 식별자는 거부된다 — 한 줄이 두 줄로 쪼개지지 않게', b, () => {
  assert.equal(O.loggableId('ok_id').ok, true);
  assert.equal(O.loggableId('a\nb').ok, false);
  assert.equal(O.loggableId('a\u0000b').ok, false);
  assert.equal(O.loggableId('x'.repeat(129)).ok, false);
  assert.equal(O.loggableId('').ok, false);
  assert.equal(O.loggableId('   ').ok, false);
  assert.equal(O.loggableId(undefined).ok, false);
  assert.equal(O.loggableId(12345).ok, false);
});

test('§2 — 개인정보 판정은 maskPii 하나다(이 파일에 정규식 사본이 없다)', b, () => {
  assert.ok(SRC.includes('maskPii'), 'maskPii 를 재사용해야 한다');
  // 주민·카드·전화·계좌 패턴을 여기서 다시 쓰면 로그 쪽만 낡는다.
  assert.ok(!/\\d\{6\}/.test(SRC), '주민번호 패턴 사본이 있다');
  assert.ok(!/01\[0-9\]/.test(SRC), '휴대폰 패턴 사본이 있다');
  // 코드→심각도 매핑은 `errorMonitor.ts` 하나다 — 읽지도, 심각도를 넘기지도 않는다.
  assert.ok(!/SEVERITY_BY_CODE\s*(\[|\))/.test(SRC), 'SEVERITY_BY_CODE 를 직접 쓰고 있다(§2)');
  assert.ok(!/\bseverity:/.test(SRC), '심각도를 직접 정하고 있다(§2)');
  assert.ok(!/E_(INVALID_INPUT|UNAUTHENTICATED|FORBIDDEN|NOT_FOUND|CONFLICT|UPSTREAM|TIMEOUT|INTERNAL)/.test(SRC),
    '오류 코드 목록 사본이 있다(§2 — 코드는 normalizeError 가 정한다)');
});

test('§2 — 관측은 판정을 다시 하지 않는다(사실만 적는다)', b, () => {
  // 주석에서 "그 판정은 저쪽 하나다"라고 가리키는 것은 괜찮다 — **부르는 것**이 §2 위반이다.
  for (const name of ['decideFallbackMode', 'aggregateUsage', 'runComplianceCheck', 'executeHandoff', 'gateAction', 'decideIntent']) {
    assert.ok(!new RegExp(`${name}\\s*\\(`).test(SRC), `관측이 ${name} 을 다시 부르고 있다(§2)`);
    assert.ok(!new RegExp(`import[^;]*\\b${name}\\b`, 's').test(SRC), `관측이 ${name} 을 import 하고 있다(§2)`);
  }
  // 임계값·목표치도 두지 않는다(§13-3).
  assert.ok(!/Threshold|threshold|maxWaiting|minScore/.test(SRC), '관측에 임계값이 있다(§13-3)');
});

// ── 2. 허용 목록 — 발화·슬롯·요약은 어떤 경로로도 나가지 않는다(§10.3) ───────────

test('발화·슬롯 값·상담사 요약은 로그에 실리지 않는다 — maskPii 는 이름·주소를 가리지 않는다', b, () => {
  const w = wiring();
  const r = result({
    steps: [{ nodeId: 'n1', kind: 'Say', channel: 'chat', prompt: '홍길동 고객님 맞으십니까' }],
    state: {
      ...result().state,
      slots: { name: '홍길동', address: '서울시 강남구 테헤란로 1', memo: '카드 분실 신고' },
    },
    handoff: { queue: 'q_card', summaryMasked: '홍길동 / 서울시 강남구 테헤란로 1 / 카드 분실' },
  });
  w.observer.record({ op: 'send', scope: SCOPE, interactionId: 'i_1', result: r });
  const line = L.formatLine(w.records[0]);
  for (const leaked of ['홍길동', '서울시 강남구', '테헤란로', '카드 분실', '맞으십니까']) {
    assert.ok(!line.includes(leaked), `로그에 본문이 남았다(${leaked}): ${line}`);
  }
  // 대신 **사실**은 남는다.
  assert.equal(w.records[0].fields.steps, 1);
  assert.equal(w.records[0].fields.handoffSummaryAttached, true);
});

test('결과를 펼쳐 넣지 않는다 — 결과에 새 필드가 생겨도 로그로 흘러들지 않는다', b, () => {
  const w = wiring();
  const r = result();
  r.futureField = { secretNote: '내부 메모 7788' };
  w.observer.record({ op: 'send', scope: SCOPE, result: r });
  const line = L.formatLine(w.records[0]);
  assert.ok(!line.includes('futureField'));
  assert.ok(!line.includes('내부 메모'));
});

test('수집기 보고에도 본문이 실리지 않는다', b, () => {
  const w = wiring();
  const err = new Error('실패');
  err.code = 'E_UPSTREAM';
  w.observer.record({
    op: 'send', scope: SCOPE, interactionId: 'i_1', error: err,
    result: undefined,
  });
  assert.equal(w.sent.length, 1);
  const json = JSON.stringify(w.sent[0]);
  assert.ok(!json.includes('홍길동'));
  assert.equal(w.sent[0].code, 'E_UPSTREAM');
});

// ── 3. 무엇을 장애로 올리는가 — 정상 업무 결과를 알림으로 만들지 않는다 ──────────

test('폴백·이관·미획득 동의는 수집기로 올리지 않는다 — 장애 1건이 알림 수천 건이 되지 않게', b, () => {
  const w = wiring();
  w.observer.record({
    op: 'send', scope: SCOPE, result: result({
      fallback: { mode: 'degraded_ai', causes: [{ component: 'llm', tier: 'L2', state: 'down' }], reasonKo: 'x', disable: ['ai_response'] },
      handoff: { queue: 'q1', summaryMasked: '요약' },
      consent: { pendingRequired: ['personal_data_collection'] },
    }),
  });
  assert.equal(w.sent.length, 0, '모델링된 결과를 수집기로 올렸다');
  assert.equal(w.observer.stats().captured, 0);
  // 다만 로그 수준은 올라간다 — 조용히 넘기지도 않는다.
  assert.equal(w.records[0].level, 'warn');
  assert.equal(w.records[0].fields.fallbackMode, 'degraded_ai');
  assert.equal(w.records[0].fields.fallbackCauses, 'llm:down');
});

test('던진 호출만 수집기로 올라간다', b, () => {
  const w = wiring();
  w.observer.record({ op: 'start', scope: SCOPE, result: result() });
  assert.equal(w.sent.length, 0);
  w.observer.record({ op: 'start', scope: SCOPE, error: new Error('테넌트 격리 위반') });
  assert.equal(w.sent.length, 1);
  assert.equal(w.records[1].level, 'error');
  assert.equal(w.records[1].fields.outcome, 'threw');
});

test('실패 코드는 normalizeError 가 정한 것을 쓴다 — 여기서 코드를 만들지 않는다', b, () => {
  const w = wiring();
  const typed = Object.assign(new Error('타임아웃'), { code: 'E_TIMEOUT' });
  const d1 = w.observer.record({ op: 'send', scope: SCOPE, error: typed });
  assert.equal(d1.code, 'E_TIMEOUT');
  assert.equal(d1.code, M.normalizeError(typed).code);
  const d2 = w.observer.record({ op: 'send', scope: SCOPE, error: '문자열이 던져졌다' });
  assert.equal(d2.code, M.normalizeError('문자열이 던져졌다').code);
  // 심각도는 수집기가 정한다(§2) — 4xx 계열이 새벽에 사람을 깨우지 않는 그 규칙 하나다.
  assert.equal(w.sent[0].severity, 'error');
});

test('평범한 턴은 info 이고 사유가 비어 있다', b, () => {
  const w = wiring();
  const d = w.observer.record({ op: 'send', scope: SCOPE, result: result() });
  assert.equal(d.level, 'info');
  assert.deepEqual(d.reasonsKo, []);
  assert.equal(d.capture, false);
});

test('과금 근거 누락·점검 미수행·failed 는 warn 으로 드러난다', b, () => {
  const w = wiring();
  const cases = [
    [result({ billing: { usageAttached: false, usageReasonKo: 'x' } }), '미설명'],
    [result({ billing: { billableMsRecorded: false, billableMsReasonKo: 'x' } }), '통화 분'],
    [result({ compliance: { reviewed: false, reasonKo: 'x' } }), '위반 0건이 아닙니다'],
    [result({ status: 'failed', state: { ...result().state, status: 'failed' } }), 'failed'],
    [result({ consent: { notRecordedKo: '저장 실패' } }), '기록하지 못했습니다'],
  ];
  for (const [r, needle] of cases) {
    const d = w.observer.record({ op: 'send', scope: SCOPE, result: r });
    assert.equal(d.level, 'warn', `warn 이어야 한다: ${JSON.stringify(r.billing ?? r.compliance ?? r.status)}`);
    assert.ok(d.reasonsKo.join(' ').includes(needle), `사유에 ${needle} 이 없다: ${d.reasonsKo.join(' / ')}`);
    assert.equal(d.capture, false);
  }
});

test('큐에 놓이지 않은 이관은 warn 이고 대안 행동이 드러난다', b, () => {
  const w = wiring();
  const d = w.observer.record({
    op: 'send', scope: SCOPE, result: result({
      handoff: {
        summaryMasked: '요약',
        placement: {
          placement: 'alternative', cause: 'closed', action: 'callback',
          requestedQueueId: 'q1', summaryPresent: true, path: [], reasonKo: 'x', warnings: [],
        },
      },
    }),
  });
  assert.equal(d.level, 'warn');
  assert.equal(d.fields.handoffPlacement, 'alternative');
  assert.equal(d.fields.handoffAction, 'callback');
});

test('라우팅 배선이 없으면 이관 배치가 unbound 로 적힌다 — queued 로 읽지 않는다', b, () => {
  const w = wiring();
  const d = w.observer.record({ op: 'send', scope: SCOPE, result: result({ handoff: { queue: 'q1', summaryMasked: 's' } }) });
  assert.equal(d.fields.handoffPlacement, 'unbound');
});

test('요약 없는 이관은 사유로 드러난다', b, () => {
  const w = wiring();
  const d = w.observer.record({ op: 'send', scope: SCOPE, result: result({ handoff: { queue: 'q1' } }) });
  assert.equal(d.fields.handoffSummaryAttached, false);
  assert.ok(d.reasonsKo.join(' ').includes('맥락 없이'));
});

// ── 4. 어떤 경우에도 던지지 않는다(§9.3) ──────────────────────────────────────

test('로거가 던져도 관측은 던지지 않고 실패를 센다', b, () => {
  const bad = {
    minLevel: 'info',
    debug() { throw new Error('sink 폭발'); },
    info() { throw new Error('sink 폭발'); },
    warn() { throw new Error('sink 폭발'); },
    error() { throw new Error('sink 폭발'); },
    child() { return bad; },
    async time(_e, run) { return run(); },
  };
  const observer = O.createObserver({ logger: bad });
  assert.doesNotThrow(() => observer.record({ op: 'send', scope: SCOPE, result: result() }));
  assert.equal(observer.stats().failed, 1);
  assert.equal(observer.stats().logged, 0);
});

test('수집기가 던져도 관측은 던지지 않는다', b, () => {
  const observer = O.createObserver({ monitor: { enabled: true, configured: true, capture() { throw new Error('수집기 폭발'); }, flush() { throw new Error('x'); }, stats() { return {}; } } });
  assert.doesNotThrow(() => observer.record({ op: 'send', scope: SCOPE, error: new Error('원래 실패') }));
  assert.equal(observer.stats().failed, 1);
  assert.equal(observer.flush(), 0);
  assert.equal(observer.stats().failed, 2);
});

test('규약을 어긴 호출(모르는 op)에도 던지지 않는다', b, () => {
  const w = wiring();
  assert.doesNotThrow(() => w.observer.record({ op: 'nope', scope: SCOPE, result: result() }));
});

test('아무 것도 주지 않으면 완전한 no-op 이고 판정만 돌려준다', b, () => {
  const observer = O.createObserver();
  assert.equal(observer.active, false);
  const d = observer.record({ op: 'send', scope: SCOPE, result: result() });
  assert.equal(d.level, 'info');
  assert.deepEqual(observer.stats(),
    { recorded: 1, rejected: 0, warned: 0, logged: 0, captured: 0, failed: 0, droppedIds: 0 });
  assert.equal(observer.flush(), 0);
});

// ── 5. 시각·소요를 만들지 않는다(§13-3) ──────────────────────────────────────

test('시계가 없으면 소요를 만들지 않는다', b, () => {
  const observer = O.createObserver({});
  assert.equal(observer.startedAt(), undefined);
  assert.equal(observer.elapsed(undefined), undefined);
  assert.equal(observer.elapsed(100), undefined);
});

test('시계를 주면 실측 소요가 나온다', b, () => {
  let t = 1000;
  const observer = O.createObserver({ clock: () => t });
  const s = observer.startedAt();
  t = 1042;
  assert.equal(observer.elapsed(s), 42);
});

test('시계 역행은 0 으로 적지 않고 비운다', b, () => {
  let t = 1000;
  const observer = O.createObserver({ clock: () => t });
  const s = observer.startedAt();
  t = 900;
  assert.equal(observer.elapsed(s), undefined);
});

test('시계가 던지거나 숫자가 아니면 소요를 만들지 않는다', b, () => {
  const thrown = O.createObserver({ clock: () => { throw new Error('시계 고장'); } });
  assert.equal(thrown.startedAt(), undefined);
  const nan = O.createObserver({ clock: () => Number.NaN });
  assert.equal(nan.startedAt(), undefined);
});

// ── 6. 헬스 보고 — 버려지는 샘플을 드러낸다(§9.3) ────────────────────────────

test('등록되지 않은 채널의 헬스 보고는 통째로 버려진다는 사실이 남는다', b, () => {
  const w = wiring();
  const d = w.observer.record({
    op: 'health', scope: SCOPE, adapter: 'callbot',
    health: { adapter: 'callbot', registered: false, offered: 3, accepted: [], ignored: 0 },
  });
  assert.equal(d.level, 'warn');
  assert.equal(d.fields.registered, false);
  assert.equal(d.fields.offered, 3);
  assert.ok(d.reasonsKo.join(' ').includes('전혀 닿지 않습니다'));
  assert.equal(w.sent.length, 0, '선언 누락은 장애가 아니다');
});

test('선언하지 않은 컴포넌트의 샘플이 버려진 건수가 드러난다', b, () => {
  const w = wiring();
  const d = w.observer.record({
    op: 'health', scope: SCOPE,
    health: {
      adapter: 'chatbot', registered: true, offered: 2, ignored: 1,
      accepted: [{ component: 'llm', state: 'up', observedAt: '2026-10-10T00:00:00.000Z' }],
    },
  });
  assert.equal(d.level, 'warn');
  assert.equal(d.fields.ignored, 1);
  assert.equal(d.fields.components, 'llm');
  assert.equal(d.fields.state_up, 1);
});

test('up 샘플만 들어온 정상 보고는 info 다', b, () => {
  const w = wiring();
  const d = w.observer.record({
    op: 'health', scope: SCOPE,
    health: {
      adapter: 'chatbot', registered: true, offered: 1, ignored: 0,
      accepted: [{ component: 'stt', state: 'up', observedAt: '2026-10-10T00:00:00.000Z' }],
    },
  });
  assert.equal(d.level, 'info');
  assert.equal(d.fields.worstState, 'up');
});

test('계약 밖 어댑터 문자열은 로그에 싣지 않는다', b, () => {
  const w = wiring();
  const d = w.observer.record({
    op: 'health', scope: SCOPE, adapter: '010-1111-2222',
    health: { adapter: '010-1111-2222', registered: false, offered: 0, accepted: [], ignored: 0 },
  });
  assert.equal(d.fields.adapter, undefined);
  assert.ok(!L.formatLine(w.records[0]).includes('1111'));
  assert.equal(O.isKnownAdapter('callbot'), true);
  assert.equal(O.isKnownAdapter('nope'), false);
});

test('허용 목록은 채널 계약 하나에서 온다(§2) — 사본이면 새 채널의 실패만 익명으로 쌓인다', b, async () => {
  const C = await import('../src/channels/contract.ts');
  for (const id of C.CHANNEL_ADAPTER_IDS) {
    assert.equal(O.isKnownAdapter(id), true, `${id} 가 허용 목록에 없다 — 사본이 낡았다`);
    const w = wiring();
    const d = w.observer.record({
      op: 'health', scope: SCOPE, adapter: id,
      health: { adapter: id, registered: true, offered: 0, accepted: [], ignored: 0 },
    });
    // 이 값이 빠지면 그 채널의 실패만 **어느 채널의 것인지 알 수 없는 상태**로 남는다.
    assert.equal(d.fields.adapter, id);
  }
});

test('샘플 0건 보고는 "상태를 올렸다"로 읽지 않는다', b, () => {
  const w = wiring();
  const d = w.observer.record({
    op: 'health', scope: SCOPE,
    health: { adapter: 'dars', registered: true, offered: 0, accepted: [], ignored: 0 },
  });
  assert.equal(d.level, 'warn');
  assert.ok(d.reasonsKo.join(' ').includes('샘플이 한 건도 없습니다'));
});

// ── 7. 테넌트 스코프(§11.1) ───────────────────────────────────────────────────

test('로그·보고의 테넌트는 넘겨받은 스코프 그대로다', b, () => {
  const w = wiring();
  w.observer.record({ op: 'send', scope: { tenantId: 'goone', workspaceId: 'cs1' }, result: result() });
  assert.equal(w.records[0].tenantId, 'goone');
  assert.equal(w.records[0].workspaceId, 'cs1');
  w.observer.record({ op: 'send', scope: { tenantId: 'goone' }, error: new Error('x') });
  assert.equal(w.sent[0].tenantId, 'goone');
});

// ── 8. 사실 요약 ─────────────────────────────────────────────────────────────

test('실측 요약에 비율·점수가 없다(§13-3)', b, () => {
  const w = wiring();
  w.observer.record({ op: 'send', scope: SCOPE, result: result() });
  const line = O.formatObserverStats(w.observer.stats());
  assert.ok(line.includes('관측 1건'));
  assert.ok(!line.includes('%'));
});

test('이벤트 이름은 고정값이다 — 자유 문장이 아니다', b, () => {
  for (const op of ['start', 'send', 'end', 'health']) {
    assert.match(O.OP_EVENT[op], /^core\.[a-z.]+$/);
  }
});

test('수집기 보고 참조는 식별 정보만 돌려준다 — 원문을 다시 꺼내지 않는다', b, () => {
  const w = wiring();
  w.observer.record({ op: 'send', scope: SCOPE, error: Object.assign(new Error('내부 메모 7788'), { code: 'E_INTERNAL' }) });
  const ref = O.reportRef(w.sent[0]);
  assert.equal(ref.code, 'E_INTERNAL');
  assert.equal(typeof ref.fingerprint, 'string');
  assert.deepEqual(Object.keys(ref).sort(), ['code', 'fingerprint']);
  assert.equal(O.reportRef(undefined), undefined);
});

// ── 9. 경계 거부(브리지) — Core 진입점에 닿지 않은 실패 ────────────────────────
//
// 여기서 고정하는 것은 "거부가 로그에 남는다"가 아니라 **같은 예외를 두 번 올리지 않는 것**과
// **깨진 줄이 로그로 새지 않는 것**이다. 둘 다 증상이 조용하다 — 전자는 보고 건수가 부풀어
// 창 상한에 진짜 예외가 밀려 버려지고, 후자는 발신번호가 수집기에 영구 보존된다.

test('경계 거부는 warn 으로 남고 수집기로는 올리지 않는다 — 설계된 거부다', b, () => {
  const w = wiring();
  const d = w.observer.recordRejection({
    scope: SCOPE, adapter: 'callbot', requestId: 'r1', op: 'send',
    code: 'E_BAD_JSON', stage: 'request', lineBytes: 412, error: new Error('깨진 줄'),
  });
  assert.equal(d.level, 'warn');
  assert.equal(d.event, O.REJECTION_EVENT);
  assert.equal(d.capture, false, '호스트의 직렬화 버그 하나가 보고 수천 건이 되면 진짜 예외가 밀려 버려진다');
  assert.equal(d.fields.outcome, 'rejected');
  assert.equal(d.fields.stage, 'request');
  assert.equal(d.fields.lineBytes, 412);
  assert.equal(d.fields.adapter, 'callbot');
  assert.equal(d.fields.op, 'send');
  assert.equal(w.records.length, 1);
  assert.equal(w.records[0].code, 'E_BAD_JSON');
  assert.equal(w.records[0].requestId, 'r1');
  assert.equal(w.sent.length, 0);
  assert.equal(w.observer.stats().rejected, 1);
  assert.equal(w.observer.stats().recorded, 0, '경계 거부를 진입점 관측 건수에 섞지 않는다');
});

test('Core 가 던진 예외는 경계에서 다시 올리지 않는다(§2) — 로그 한 줄만 남는다', b, () => {
  const w = wiring();
  const d = w.observer.recordRejection({
    scope: SCOPE, adapter: 'callbot', requestId: 'r2', op: 'send',
    code: 'E_INTERNAL', stage: 'core', error: new Error('세션 없음'),
  });
  assert.equal(d.level, 'error');
  assert.equal(d.capture, false, '진입점 관측이 이미 올렸다 — 또 올리면 한 번의 예외가 보고 두 건이 된다');
  assert.equal(w.sent.length, 0);
  assert.equal(w.records[0].requestId, 'r2', '요청 id ↔ 오류 코드 상관은 Core 쪽 줄에 없다');
});

test('응답 투영 중 예외만 수집기로 올린다 — 아무도 보고하지 않는 유일한 자리다', b, () => {
  const w = wiring();
  const d = w.observer.recordRejection({
    scope: SCOPE, code: 'E_INTERNAL', stage: 'response', error: new Error('투영 실패'),
  });
  assert.equal(d.level, 'error');
  assert.equal(d.capture, true);
  assert.equal(w.sent.length, 1);
  assert.ok(d.reasonsKo.join(' ').includes('성공으로 기록'));
});

test('요청 id 가 개인정보 패턴이면 싣지 않고 걸렸다는 사실만 남긴다(§10.3)', b, () => {
  const w = wiring();
  const d = w.observer.recordRejection({
    scope: SCOPE, requestId: '010-1234-5678', code: 'E_BAD_REQUEST', stage: 'request',
  });
  assert.deepEqual(d.droppedIds, ['requestId']);
  assert.equal(d.fields.requestIdPiiKinds, 'phone');
  const line = L.formatLine(w.records[0]);
  assert.ok(!line.includes('1234'), `로그 줄에 번호 조각이 남았다: ${line}`);
  assert.equal(w.observer.stats().droppedIds, 1);
});

test('모르는 op·모르는 어댑터는 값을 싣지 않는다 — 임의 문자열이다', b, () => {
  const w = wiring();
  const d = w.observer.recordRejection({
    scope: SCOPE, op: '내 주민번호는 900101-1234567', adapter: '발신 010-0000-0000',
    code: 'E_UNKNOWN_OP', stage: 'request',
  });
  assert.equal(d.fields.op, undefined);
  assert.equal(d.fields.adapter, undefined);
  const line = L.formatLine(w.records[0]);
  assert.ok(!line.includes('900101'), line);
});

test('열거값 형태가 아닌 실패 코드는 고정 필드에 싣지 않는다', b, () => {
  const w = wiring();
  const d = w.observer.recordRejection({
    scope: SCOPE, code: 'Core 처리 중 오류: 홍길동 010-1234-5678', stage: 'request',
  });
  assert.equal(d.code, undefined);
  assert.equal(d.fields.codeDropped, true);
  assert.ok(!L.formatLine(w.records[0]).includes('홍길동'));
});

test('한도 초과·테넌트 주장은 사유로 드러난다', b, () => {
  const w = wiring();
  const rl = w.observer.recordRejection({
    scope: SCOPE, code: 'E_RATE_LIMITED', stage: 'request', retryAfterMs: 250,
  });
  assert.equal(rl.fields.retryAfterMs, 250);
  assert.ok(rl.reasonsKo.join(' ').includes('한도'));
  const ts = w.observer.recordRejection({ scope: SCOPE, code: 'E_TENANT_SCOPE', stage: 'request' });
  assert.ok(ts.reasonsKo.join(' ').includes('§11.1'));
});

test('실측이 아닌 수치는 만들지 않는다(§13-3)', b, () => {
  const w = wiring();
  const d = w.observer.recordRejection({
    scope: SCOPE, code: 'E_BAD_JSON', stage: 'request',
    lineBytes: Number.NaN, retryAfterMs: -1,
  });
  assert.equal(d.fields.lineBytes, undefined);
  assert.equal(d.fields.retryAfterMs, undefined);
  assert.equal(w.records[0].durationMs, undefined);
});

test('경계·경고 관측은 어떤 경우에도 던지지 않는다(§9.3)', b, () => {
  const boom = () => { throw new Error('sink 폭발'); };
  const logger = {
    minLevel: 'info', debug: boom, info: boom, warn: boom, error: boom,
    child() { return logger; }, async time(_e, run) { return run(); },
  };
  const observer = O.createObserver({ logger });
  assert.doesNotThrow(() => observer.recordRejection({ scope: SCOPE, code: 'E_BAD_JSON', stage: 'request' }));
  assert.doesNotThrow(() => observer.recordWarning({ scope: SCOPE, code: 'W_QA_UNBOUND' }));
  assert.equal(observer.stats().failed, 2, '실패는 삼키지 않고 센다');
});

// ── 10. 계약 경고 — 코드만, 한 번만 ───────────────────────────────────────────

test('계약 경고는 warn 으로 남고 코드만 싣는다 — 문구는 받지 않는다', b, () => {
  const w = wiring();
  const d = w.observer.recordWarning({ scope: SCOPE, code: 'W_CONSENT_UNBOUND' });
  assert.equal(d.level, 'warn');
  assert.equal(d.event, O.WARNING_EVENT);
  assert.equal(d.code, 'W_CONSENT_UNBOUND');
  assert.equal(d.capture, false, '미배선은 모델링된 설정 상태다 — 장애로 올리면 알림이 잡음이 된다');
  assert.equal(w.records[0].code, 'W_CONSENT_UNBOUND');
  assert.equal(w.observer.stats().warned, 1);
  assert.equal(w.observer.stats().recorded, 0);
  assert.equal(w.sent.length, 0);
  // 받는 자리가 코드뿐이라 보간된 문구가 들어올 자리 자체가 없다(§10.3).
  assert.ok(!/messageKo/.test(SRC), '경고 문구를 받으면 자유 문장이 고정 필드로 들어간다');
});

test('열거값 형태가 아닌 경고 코드는 고정 필드에 싣지 않는다', b, () => {
  const w = wiring();
  const d = w.observer.recordWarning({ scope: SCOPE, code: '동의 배선이 없습니다: 홍길동' });
  assert.equal(d.code, undefined);
  assert.equal(d.fields.codeDropped, true);
  assert.ok(!L.formatLine(w.records[0]).includes('홍길동'));
});

test('경계·경고 이벤트 이름도 고정값이다', b, () => {
  assert.match(O.REJECTION_EVENT, /^core\.[a-z.]+$/);
  assert.match(O.WARNING_EVENT, /^core\.[a-z.]+$/);
  assert.notEqual(O.REJECTION_EVENT, O.OP_EVENT.send);
});

test('실측 요약이 진입점·경계·경고를 갈라 적는다(§13-3)', b, () => {
  const w = wiring();
  w.observer.record({ op: 'send', scope: SCOPE, result: result() });
  w.observer.recordRejection({ scope: SCOPE, code: 'E_BAD_JSON', stage: 'request' });
  w.observer.recordWarning({ scope: SCOPE, code: 'W_QA_UNBOUND' });
  const line = O.formatObserverStats(w.observer.stats());
  assert.ok(line.includes('관측 1건'));
  assert.ok(line.includes('경계거부 1'));
  assert.ok(line.includes('계약경고 1'));
  assert.ok(!line.includes('%'));
});
