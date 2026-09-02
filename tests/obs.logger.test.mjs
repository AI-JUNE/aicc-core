import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
try { m = await import('../src/obs/logger.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const fixed = (start = 1_700_000_000_000) => { let t = start; return { now: () => t, adv: (ms) => { t += ms; } }; };

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('고정 필드로 한 줄에 요청ID·테넌트·소요·코드가 담긴다', b, () => {
  const sink = m.createMemorySink();
  const clock = fixed();
  const log = m.createLogger({ sink, clock: clock.now });
  log.info('channel.present', {
    requestId: 'req_1', scope: { tenantId: 't1', workspaceId: 'w1' },
    interactionId: 'i1', durationMs: 12, code: 'OK', fields: { stepCount: 2 },
  });
  const r = sink.records[0];
  assert.equal(r.level, 'info');
  assert.equal(r.event, 'channel.present');
  assert.equal(r.requestId, 'req_1');
  assert.equal(r.tenantId, 't1');
  assert.equal(r.workspaceId, 'w1');
  assert.equal(r.interactionId, 'i1');
  assert.equal(r.durationMs, 12);
  assert.equal(r.fields.stepCount, 2);
  assert.equal(r.at, new Date(clock.now()).toISOString());
});

test('child 는 컨텍스트를 물려주고 호출 시 값으로 덮어쓴다', b, () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink }).child({ tenantId: 't1', requestId: 'req_base' });
  log.info('a');
  log.info('b', { requestId: 'req_call' });
  assert.equal(sink.records[0].tenantId, 't1');
  assert.equal(sink.records[0].requestId, 'req_base');
  assert.equal(sink.records[1].requestId, 'req_call');
});

test('time 은 실측 소요를 기록하고 값을 그대로 돌려준다', b, async () => {
  const sink = m.createMemorySink();
  const clock = fixed();
  const log = m.createLogger({ sink, clock: clock.now });
  const out = await log.time('engine.stt', async () => { clock.adv(35); return '결과'; }, { requestId: 'r' });
  assert.equal(out, '결과');
  assert.equal(sink.records[0].durationMs, 35);
  assert.equal(sink.records[0].level, 'info');
});

test('시계를 주입하지 않으면 시각·소요를 만들어 넣지 않는다 (§13-3)', b, async () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink });
  await log.time('x', async () => 1);
  assert.equal(sink.records[0].at, undefined);
  assert.equal(sink.records[0].durationMs, undefined);
});

test('수준 미만 로그는 버린다', b, () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink, minLevel: 'warn' });
  log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
  assert.deepEqual(sink.records.map((r) => r.level), ['warn', 'error']);
});

test('sink 미설정이면 아무 일도 하지 않는다', b, () => {
  const log = m.createLogger();
  assert.doesNotThrow(() => log.error('boom', { fields: { a: 1 } }));
});

test('요청ID 생성기는 매번 다른 값을 준다', b, () => {
  const gen = m.createRequestIdFactory(() => 0.5);
  const ids = new Set([gen(), gen(), gen()]);
  assert.equal(ids.size, 3);
  assert.ok([...ids].every((id) => id.startsWith('req_')));
});

test('formatLine 은 JSON 한 줄이다', b, () => {
  const line = m.formatLine({ level: 'info', event: 'e' });
  assert.equal(line.includes('\n'), false);
  assert.deepEqual(JSON.parse(line), { level: 'info', event: 'e' });
});

// ── 실패 경로·경계 ───────────────────────────────────────────────────────────

test('차단 키는 값이 제거되고 무엇을 숨겼는지만 남는다 (§10.3)', b, () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink });
  log.info('turn', { fields: { text: '계좌번호는 110-234-567890', Authorization: 'Bearer abc', api_key: 'k', stepCount: 1 } });
  const r = sink.records[0];
  assert.equal(r.fields.text, undefined);
  assert.equal(r.fields.Authorization, undefined);
  assert.equal(r.fields.api_key, undefined);
  assert.equal(r.fields.stepCount, 1);
  assert.deepEqual(r.redactedKeys.sort(), ['Authorization', 'api_key', 'text']);
  assert.equal(JSON.stringify(r).includes('Bearer abc'), false);
});

test('허용 키에 개인정보가 섞여 들어와도 마스킹된다', b, () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink });
  log.warn('fallback', { fields: { reason: '고객 010-1234-5678 재시도 실패' } });
  const dump = JSON.stringify(sink.records[0]);
  assert.equal(dump.includes('010-1234-5678'), false);
  assert.ok(dump.includes('fallback'));
});

test('time 은 실패를 삼키지 않고 error 로 남긴 뒤 다시 던진다', b, async () => {
  const sink = m.createMemorySink();
  const clock = fixed();
  const log = m.createLogger({ sink, clock: clock.now });
  const err = Object.assign(new Error('회선 거부 010-1234-5678'), { code: 'E_TRANSPORT' });
  await assert.rejects(
    () => log.time('channel.present', async () => { clock.adv(7); throw err; }),
    /회선 거부/,
  );
  const r = sink.records[0];
  assert.equal(r.level, 'error');
  assert.equal(r.code, 'E_TRANSPORT');
  assert.equal(r.durationMs, 7);
  assert.equal(JSON.stringify(r).includes('010-1234-5678'), false, '오류 사유도 마스킹 대상이다');
});

test('code 없는 예외는 E_UNHANDLED 로 분류한다', b, async () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink });
  await assert.rejects(() => log.time('x', async () => { throw new Error('그냥 실패'); }));
  assert.equal(sink.records[0].code, 'E_UNHANDLED');
});

test('sink 가 던져도 호출자에게 전파하지 않는다', b, () => {
  const log = m.createLogger({ sink: () => { throw new Error('수집기 장애'); } });
  assert.doesNotThrow(() => log.info('e'));
});

test('긴 값은 잘라서 로그 한 줄이 터지지 않게 한다', b, () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink });
  log.info('e', { fields: { note: 'ㄱ'.repeat(5000) } });
  assert.ok(sink.records[0].fields.note.length <= 201);
});

test('빈 입력·null 필드에서도 깨지지 않는다', b, () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink });
  log.info('e', { fields: { a: null, b: undefined, c: NaN, d: false } });
  const f = sink.records[0].fields;
  assert.deepEqual(f, { d: false });
});

test('제품별 차단 키를 추가할 수 있다', b, () => {
  const sink = m.createMemorySink();
  const log = m.createLogger({ sink, extraDeniedFields: ['memberGrade'] });
  log.info('e', { fields: { memberGrade: 'VIP', ok: true } });
  assert.equal(sink.records[0].fields.memberGrade, undefined);
  assert.deepEqual(sink.records[0].redactedKeys, ['memberGrade']);
});

test('메모리 sink 는 상한을 넘지 않는다', b, () => {
  const sink = m.createMemorySink(3);
  const log = m.createLogger({ sink });
  for (let i = 0; i < 10; i++) log.info(`e${i}`);
  assert.equal(sink.records.length, 3);
  assert.equal(sink.records[2].event, 'e9');
});
