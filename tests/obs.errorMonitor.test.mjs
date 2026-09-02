import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
try { m = await import('../src/obs/errorMonitor.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const fixed = (start = 1_700_000_000_000) => { let t = start; return { now: () => t, adv: (ms) => { t += ms; } }; };
const collector = () => { const sent = []; const fn = (r) => { sent.push(r); }; fn.sent = sent; return fn; };

// ── 정규화 ───────────────────────────────────────────────────────────────────

test('Error·문자열·객체·빈 값이 모두 같은 모양으로 정규화된다', b, () => {
  const e = m.normalizeError(new TypeError('무너짐'));
  assert.equal(e.name, 'TypeError');
  assert.equal(e.messageMasked, '무너짐');
  assert.equal(e.code, 'E_UNHANDLED');

  assert.equal(m.normalizeError('문자열 오류').messageMasked, '문자열 오류');
  assert.equal(m.normalizeError({ message: '객체 오류', code: 'E_UPSTREAM' }).code, 'E_UPSTREAM');

  const empty = m.normalizeError(undefined);
  assert.equal(empty.messageMasked, '(빈 오류)');
  assert.deepEqual(empty.frames, []);
  assert.deepEqual(m.normalizeError(null).frames, []);
});

test('메시지에 섞인 개인정보와 자격증명은 값째로 지워진다', b, () => {
  const e = m.normalizeError(new Error('발신 010-1234-5678 실패, api_key=sk-abcdef123456 로 재시도'));
  assert.ok(!e.messageMasked.includes('1234-5678'));
  assert.ok(e.messageMasked.includes('010-****-5678'));
  assert.ok(!e.messageMasked.includes('sk-abcdef123456'));
  assert.ok(e.messageMasked.includes('[제거됨]'));
});

test('URL 자격증명과 Bearer 토큰을 제거한다', b, () => {
  const s = m.stripSecrets('https://user:p%40ss@engine.example.co.kr 호출 실패 (authorization: Bearer abcdefgh12345678)');
  assert.ok(!s.includes('p%40ss'));
  assert.ok(!s.includes('abcdefgh12345678'));
});

test('스택 절대경로는 마지막 조각만 남는다', b, () => {
  const err = new Error('경로 노출');
  err.stack = 'Error: 경로 노출\n    at run (/home/deploy/aicc/secret/dir/src/flow/runner.ts:12:3)\n    at go (/a/b/c/d.ts:1:1)\n    at x (/e/f/g/h.ts:1:1)';
  const e = m.normalizeError(err, 2);
  assert.equal(e.frames.length, 2);
  assert.ok(!e.frames[0].includes('/home/deploy'));
  assert.ok(e.frames[0].includes('runner.ts'));
});

test('같은 원인은 숫자가 달라도 같은 fingerprint 로 묶인다', b, () => {
  const a = m.normalizeError(new Error('세션 4821 조회 실패'));
  const c = m.normalizeError(new Error('세션 9930 조회 실패'));
  const d = m.normalizeError(new Error('전혀 다른 실패'));
  assert.equal(m.fingerprintOf(a), m.fingerprintOf(c));
  assert.notEqual(m.fingerprintOf(a), m.fingerprintOf(d));
  assert.match(m.fingerprintOf(a), /^grp_[0-9a-f]{8}$/);
});

// ── 전송·비활성 ──────────────────────────────────────────────────────────────

test('전송기 미주입이면 아무 데도 보내지 않는다(무해한 no-op)', b, () => {
  const mon = m.createErrorMonitor({});
  assert.equal(mon.enabled, false);
  assert.equal(mon.configured, false);
  const r = mon.capture(new Error('그래도 보고서는 만든다'), { code: 'E_INTERNAL' });
  assert.equal(r.code, 'E_INTERNAL');
  assert.equal(mon.stats().sent, 0);
  assert.equal(mon.stats().captured, 1);
});

test('DSN 이 빈 문자열이면 비활성이다', b, () => {
  const t = collector();
  const mon = m.createErrorMonitor({ dsn: '   ', transport: t });
  assert.equal(mon.enabled, false);
  mon.capture(new Error('x'), { code: 'E_INTERNAL' });
  assert.equal(t.sent.length, 0);
});

test('DSN 값은 보고서·모니터 어디에도 남지 않는다', b, () => {
  const t = collector();
  const mon = m.createErrorMonitor({ dsn: 'https://key123456@collector.example.com/7', dsnEnvVar: 'AICC_ERROR_DSN', transport: t });
  assert.equal(mon.enabled, true);
  assert.equal(mon.dsnEnvVar, 'AICC_ERROR_DSN');
  mon.capture(new Error('보고'), { code: 'E_INTERNAL' });
  assert.ok(!JSON.stringify(t.sent[0]).includes('key123456'));
  assert.ok(!JSON.stringify(mon).includes('key123456'));
});

test('환경변수에서는 설정 여부만 읽고 값을 돌려주지 않는다', b, () => {
  const on = m.resolveDsnConfig({ AICC_ERROR_DSN: 'https://x@y/1' });
  assert.deepEqual(on, { configured: true, envVar: 'AICC_ERROR_DSN' });
  assert.deepEqual(m.resolveDsnConfig({}), { configured: false, envVar: 'AICC_ERROR_DSN' });
  assert.equal(m.resolveDsnConfig({ CUSTOM: ' ' }, 'CUSTOM').configured, false);
});

test('고정 필드에 요청ID·테넌트·버전이 실리고 커밋은 12자로 줄어든다', b, () => {
  const t = collector();
  const clock = fixed();
  const mon = m.createErrorMonitor({
    dsn: 'x', transport: t, clock: clock.now, environment: 'staging',
    release: { version: '0.1.0', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4' },
  });
  mon.capture(new Error('업스트림 실패'), {
    code: 'E_UPSTREAM', requestId: 'req_1', scope: { tenantId: 't1', workspaceId: 'w1' },
    interactionId: 'i1', fields: { attempt: 2 },
  });
  const r = t.sent[0];
  assert.equal(r.requestId, 'req_1');
  assert.equal(r.tenantId, 't1');
  assert.equal(r.workspaceId, 'w1');
  assert.equal(r.interactionId, 'i1');
  assert.equal(r.environment, 'staging');
  assert.equal(r.release.commit, 'a1b2c3d4e5f6');
  assert.equal(r.severity, 'error');
  assert.equal(r.occurrences, 1);
  assert.equal(r.at, new Date(clock.now()).toISOString());
  assert.equal(r.fields.attempt, 2);
});

test('커밋 해시 형태가 아니면 남기지 않는다', b, () => {
  const t = collector();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t, release: { version: '1', commit: 'branch/feature' } });
  mon.capture(new Error('x'), { code: 'E_INTERNAL' });
  assert.equal(t.sent[0].release.commit, undefined);
  assert.equal(t.sent[0].release.version, '1');
});

test('차단 키의 값은 제거되고 무엇을 지웠는지만 남는다', b, () => {
  const t = collector();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t });
  mon.capture(new Error('x'), { code: 'E_INTERNAL', fields: { utterance: '내 번호는 010-1111-2222', authorization: 'Bearer zzz', stepCount: 3 } });
  const r = t.sent[0];
  assert.deepEqual(r.redactedKeys.sort(), ['authorization', 'utterance']);
  assert.equal(r.fields.utterance, undefined);
  assert.equal(r.fields.stepCount, 3);
});

test('시계가 없으면 시각을 만들어 넣지 않는다(§13-3)', b, () => {
  const t = collector();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t });
  mon.capture(new Error('x'), { code: 'E_INTERNAL' });
  assert.equal(t.sent[0].at, undefined);
});

// ── 심각도·잡음 억제 ─────────────────────────────────────────────────────────

test('입력·권한 오류는 warning 이며 기본적으로 전송하지 않는다', b, () => {
  const t = collector();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t });
  const r = mon.capture(new Error('필드 오류'), { code: 'E_INVALID_INPUT' });
  assert.equal(r.severity, 'warning');
  assert.equal(t.sent.length, 0);

  const t2 = collector();
  const mon2 = m.createErrorMonitor({ dsn: 'x', transport: t2, reportWarnings: true });
  mon2.capture(new Error('필드 오류'), { code: 'E_INVALID_INPUT' });
  assert.equal(t2.sent.length, 1);
});

test('전역 훅에서 온 오류는 fatal 이다', b, () => {
  const t = collector();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t });
  mon.capture(new Error('죽었다'), { origin: 'uncaught' });
  assert.equal(t.sent[0].severity, 'fatal');
});

test('중복은 창 안에서 한 번만 보내고, 억제분은 다음 보고의 발생횟수에 합산된다', b, () => {
  const t = collector();
  const clock = fixed();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t, clock: clock.now, dedupeWindowMs: 60_000 });
  const boom = () => mon.capture(new Error('같은 실패'), { code: 'E_UPSTREAM' });
  boom(); boom(); boom();
  assert.equal(t.sent.length, 1);
  assert.equal(mon.stats().suppressed, 2);
  clock.adv(60_001);
  boom();
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].occurrences, 3);
});

test('flush 는 아직 알리지 못한 억제분을 내보낸다', b, () => {
  const t = collector();
  const clock = fixed();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t, clock: clock.now, dedupeWindowMs: 60_000 });
  mon.capture(new Error('같은 실패'), { code: 'E_UPSTREAM' });
  mon.capture(new Error('같은 실패'), { code: 'E_UPSTREAM' });
  assert.equal(mon.flush(), 1);
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].occurrences, 1);
  assert.equal(mon.flush(), 0);
});

test('창 상한을 넘으면 버리되, 버렸다는 사실을 다음 보고에 싣는다', b, () => {
  const t = collector();
  const clock = fixed();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t, clock: clock.now, dedupeWindowMs: 1000, maxPerWindow: 1 });
  mon.capture(new Error('A 실패'), { code: 'E_UPSTREAM' });
  mon.capture(new Error('B 실패'), { code: 'E_UPSTREAM' });
  assert.equal(t.sent.length, 1);
  assert.equal(mon.stats().dropped, 1);
  clock.adv(1001);
  mon.capture(new Error('C 실패'), { code: 'E_UPSTREAM' });
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].fields.droppedSinceLastReport, 1);
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('전송기가 던져도 호출자에게 전파하지 않고 통계·훅으로 드러낸다', b, () => {
  const seenErr = [];
  const mon = m.createErrorMonitor({
    dsn: 'x',
    transport: () => { throw new Error('수집기 다운'); },
    onTransportError: (e, r) => seenErr.push([e, r]),
  });
  assert.doesNotThrow(() => mon.capture(new Error('원래 실패'), { code: 'E_INTERNAL' }));
  assert.equal(mon.stats().failed, 1);
  assert.equal(mon.stats().sent, 0);
  assert.equal(seenErr.length, 1);
  assert.equal(seenErr[0][1].code, 'E_INTERNAL');
});

test('비동기 전송이 거부되면 성공 집계를 되돌린다', b, async () => {
  const mon = m.createErrorMonitor({ dsn: 'x', transport: () => Promise.reject(new Error('타임아웃')) });
  mon.capture(new Error('원래 실패'), { code: 'E_INTERNAL' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(mon.stats().sent, 0);
  assert.equal(mon.stats().failed, 1);
});

test('알림 훅 자체가 던져도 capture 는 던지지 않는다', b, () => {
  const mon = m.createErrorMonitor({
    dsn: 'x',
    transport: () => { throw new Error('수집기 다운'); },
    onTransportError: () => { throw new Error('훅도 고장'); },
  });
  assert.doesNotThrow(() => mon.capture(new Error('원래 실패'), { code: 'E_INTERNAL' }));
});

// ── 전역 캡처 ────────────────────────────────────────────────────────────────

test('전역 훅을 붙였다 뗄 수 있고 거부 사유를 풀어서 잡는다', b, () => {
  const handlers = new Map();
  const source = {
    on: (e, h) => { handlers.set(e, [...(handlers.get(e) ?? []), h]); },
    off: (e, h) => { handlers.set(e, (handlers.get(e) ?? []).filter(x => x !== h)); },
  };
  const t = collector();
  const mon = m.createErrorMonitor({ dsn: 'x', transport: t });
  const uninstall = m.installGlobalCapture(mon, source, { fields: { component: 'core' } });

  handlers.get('uncaughtException')[0](new Error('프로세스 예외'));
  handlers.get('unhandledRejection')[0]({ reason: new Error('거부 사유') });
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[0].origin, 'uncaught');
  assert.equal(t.sent[1].origin, 'unhandled_rejection');
  assert.equal(t.sent[1].messageMasked, '거부 사유');
  assert.equal(t.sent[0].fields.component, 'core');

  uninstall();
  assert.equal(handlers.get('uncaughtException').length, 0);
  assert.equal(handlers.get('unhandledRejection').length, 0);
});

test('해제 수단이 없는 소스에도 붙일 수 있고 해제는 조용히 넘어간다', b, () => {
  const source = { on: () => {} };
  const mon = m.createErrorMonitor({});
  const uninstall = m.installGlobalCapture(mon, source);
  assert.doesNotThrow(uninstall);
});
