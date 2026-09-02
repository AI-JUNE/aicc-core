import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null, schema = null, bus = null;
try {
  m = await import('../src/events/store.ts');
  schema = await import('../src/events/schema.ts');
  bus = await import('../src/events/bus.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't_koweon' };
const meta = (n, over = {}) => ({
  eventId: `e${n}`, occurredAt: `2026-09-0${n}T00:00:00.000Z`,
  tenantId: 't_koweon', interactionId: 'i1', channel: 'voice', ...over,
});
const started = (n, over) => schema.sessionStarted(meta(n, over), { entryPoint: 'inbound_call' });
const ended = (n, over) => schema.sessionEnded(meta(n, over), { outcome: 'SELF_SERVED', turnCount: 2, billableMs: 60000 });

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('추가 전용 원장은 오프셋을 0부터 단조 증가시킨다', b, () => {
  const log = m.createMemoryEventLog(scope);
  assert.equal(log.lastOffset(), -1);
  assert.equal(log.append(started(1)).offset, 0);
  assert.equal(log.append(ended(2)).offset, 1);
  assert.equal(log.lastOffset(), 1);
  assert.equal(log.size(), 2);
});

test('같은 event_id 재전송은 기존 오프셋으로 흡수된다(§8.1 멱등)', b, () => {
  const log = m.createMemoryEventLog(scope);
  const e = started(1);
  const first = log.append(e);
  const again = log.append(e);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.offset, first.offset);
  assert.equal(log.size(), 1);
});

test('read 는 오프셋·타입·interaction 필터와 limit 을 지원한다', b, () => {
  const log = m.createMemoryEventLog(scope);
  log.appendAll([started(1), ended(2), started(3, { eventId: 'e3', interactionId: 'i2' })]);
  assert.equal(log.read({ afterOffset: 0 }).length, 2);
  assert.equal(log.read({ types: ['session.ended'] }).length, 1);
  assert.equal(log.read({ interactionId: 'i2' }).length, 1);
  assert.equal(log.read({ limit: 2 }).length, 2);
});

test('JSONL 직렬화 후 복구하면 같은 이벤트가 같은 순서로 돌아온다', b, () => {
  const log = m.createMemoryEventLog(scope);
  log.appendAll([started(1), ended(2)]);
  const text = m.serializeJsonl(log.read());
  const restored = m.restoreEventLog(scope, text);
  assert.equal(restored.log.size(), 2);
  assert.equal(restored.skipped.length, 0);
  assert.deepEqual(
    restored.log.read().map((r) => r.event.event_id),
    log.read().map((r) => r.event.event_id),
  );
});

test('원장 기반 멱등 저장소는 재시작 후에도 과거를 기억한다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const e = started(1);
  const store1 = m.createLogBackedIdempotencyStore(log);
  store1.attach(e);
  assert.equal(store1.markIfNew(bus.idempotencyKey(e)), true);

  // 프로세스 재시작 상황 — 스냅샷에서 원장을 복구하고 새 저장소를 만든다.
  const restored = m.restoreEventLog(scope, m.serializeJsonl(log.read())).log;
  const store2 = m.createLogBackedIdempotencyStore(restored);
  store2.attach(e);
  assert.equal(store2.markIfNew(bus.idempotencyKey(e)), false, '재시작 후에도 중복으로 판정해야 한다');
});

test('영속 멱등 저장소를 쓰는 버스는 재시작 후 중복 전달을 하지 않는다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const e = started(1);
  const sink = bus.createCollectorSink();
  const store = m.createLogBackedIdempotencyStore(log);
  const makeBus = () => bus.createEventBus({
    scope, sinks: [sink], releaseKeyOnSinkFailure: false,
    store: { markIfNew: (k) => { store.attach(e); return store.markIfNew(k); }, has: store.has, size: store.size },
  });
  assert.equal((await makeBus().publish(e)).status, 'delivered');
  assert.equal((await makeBus().publish(e)).status, 'duplicate');
  assert.equal(sink.events.length, 1);
});

test('커서 이후 이벤트만 재전송한다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  log.appendAll([started(1), ended(2)]);
  const sink = bus.createCollectorSink('replay');
  const r = await m.replayUndelivered(log, sink, { sink: 'replay', offset: 0 });
  assert.equal(r.delivered, 1);
  assert.equal(r.cursor.offset, 1);
  const again = await m.replayUndelivered(log, sink, r.cursor);
  assert.equal(again.delivered, 0, '커서가 최신이면 재전송할 것이 없다');
});

test('무결성 점검은 정상 원장을 통과시킨다', b, () => {
  const log = m.createMemoryEventLog(scope);
  log.appendAll([started(1), ended(2)]);
  const r = m.verifyLogIntegrity(log);
  assert.equal(r.ok, true);
  assert.equal(r.errorsKo.length, 0);
});

// ── 실패·경계 경로 ───────────────────────────────────────────────────────────

test('빈 입력: 빈 원장·빈 문자열도 무해하게 처리한다', b, () => {
  const log = m.createMemoryEventLog(scope);
  assert.deepEqual(log.read(), []);
  assert.equal(m.verifyLogIntegrity(log).ok, true);
  assert.deepEqual(log.appendAll([]), []);
  const restored = m.restoreEventLog(scope, '');
  assert.equal(restored.log.size(), 0);
  assert.equal(restored.skipped.length, 0);
});

test('다른 테넌트 이벤트는 원장에 기록되지 않는다(§11.1)', b, () => {
  const log = m.createMemoryEventLog(scope);
  const foreign = schema.sessionStarted(meta(1, { tenantId: 't_other' }), {});
  assert.throws(() => log.append(foreign), (e) => e.name === 'EventLogRejected' && e.reason === 'foreign_tenant');
  assert.equal(log.size(), 0);
});

test('event_id 없는 이벤트는 거부한다(§8.1)', b, () => {
  const log = m.createMemoryEventLog(scope);
  const e = { ...started(1), event_id: '' };
  assert.throws(() => log.append(e), (err) => err.reason === 'no_event_id');
});

test('부분 손상 JSONL 은 손상된 줄만 버리고 나머지를 살린다', b, () => {
  const good = JSON.stringify(started(1));
  const text = [good, '{ 깨진 줄', JSON.stringify({ type: 'session.ended' }), JSON.stringify(ended(2))].join('\n');
  const r = m.parseJsonl(text);
  assert.equal(r.events.length, 2);
  assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0].reasonKo, /파싱 실패/);
});

test('복구 중 다른 테넌트 줄이 섞여 있어도 멈추지 않고 사유를 남긴다(§11.1)', b, () => {
  const text = [
    JSON.stringify(started(1)),
    JSON.stringify(schema.sessionStarted(meta(2, { tenantId: 't_other', eventId: 'x1' }), {})),
    JSON.stringify(ended(3)),
  ].join('\n');
  const r = m.restoreEventLog(scope, text);
  assert.equal(r.log.size(), 2, '자기 테넌트 이벤트는 살아야 한다');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reasonKo, /§11\.1/);
});

test('부분 실패: 싱크가 중간에 실패하면 그 자리에서 멈추고 커서를 유지한다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  log.appendAll([started(1), ended(2), started(3, { eventId: 'e3' })]);
  let n = 0;
  const flaky = { name: 'flaky', deliver() { n += 1; if (n === 2) throw new Error('브로커 거부'); } };
  const r = await m.replayUndelivered(log, flaky, { sink: 'flaky', offset: -1 });
  assert.equal(r.delivered, 1);
  assert.equal(r.cursor.offset, 0, '실패 지점을 건너뛰지 않는다');
  assert.match(r.errorKo, /오프셋 1 전달 실패/);
});

test('원본 없이 markIfNew 만 부르면 영속화가 새므로 막는다', b, () => {
  const log = m.createMemoryEventLog(scope);
  const store = m.createLogBackedIdempotencyStore(log);
  assert.throws(() => store.markIfNew('t_koweon::e_unknown'), /attach/);
});

test('무결성 점검은 테넌트 위반·시각 역행을 각각 오류·경고로 나눈다', b, () => {
  const log = m.createMemoryEventLog(scope);
  log.appendAll([ended(3), started(1)]);   // 시각 역행 순서로 기록
  const r = m.verifyLogIntegrity(log);
  assert.equal(r.ok, true, '시각 역행만으로 원장을 부정하지 않는다');
  assert.equal(r.warningsKo.length, 1);

  const dirty = { ...log, read: () => [{ offset: 0, key: 'k', event: { ...started(1), tenant_id: 't_other' } }] };
  const r2 = m.verifyLogIntegrity(dirty);
  assert.equal(r2.ok, false);
  assert.match(r2.errorsKo[0], /테넌트 격리 위반/);
});
