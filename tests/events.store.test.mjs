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

// ── createLogBackedEventBus: 원장 위에서 완결되는 버스 ──────────────────────

test('원장 위 버스는 정상 발행을 원장에 기록하고 delivered 를 돌려준다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const eventBus = m.createLogBackedEventBus({ scope, log });
  const r = await eventBus.publish(started(1));
  assert.equal(r.status, 'delivered');
  assert.equal(log.size(), 1);
  assert.equal(log.read()[0].event.event_id, 'e1');
});

test('같은 이벤트 재발행은 duplicate 이며 원장 크기가 늘지 않는다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const eventBus = m.createLogBackedEventBus({ scope, log });
  const e = started(1);
  assert.equal((await eventBus.publish(e)).status, 'delivered');
  const again = await eventBus.publish(e);
  assert.equal(again.status, 'duplicate');
  assert.equal(log.size(), 1, '중복 발행이 원장에 두 번 쌓이면 안 된다');
});

test('publishAll 은 여러 이벤트를 순서대로 원장에 쌓는다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const eventBus = m.createLogBackedEventBus({ scope, log });
  const results = await eventBus.publishAll([started(1), ended(2)]);
  assert.deepEqual(results.map((r) => r.status), ['delivered', 'delivered']);
  assert.equal(log.size(), 2);
  assert.deepEqual(log.read().map((r) => r.event.event_id), ['e1', 'e2']);
});

test('원장 외 추가 싱크도 정상 발행 시 함께 불린다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const collector = bus.createCollectorSink('extra');
  const eventBus = m.createLogBackedEventBus({ scope, log, sinks: [collector] });
  await eventBus.publish(started(1));
  assert.equal(collector.events.length, 1);
  assert.equal(collector.events[0].event_id, 'e1');
});

test('중복 발행은 추가 싱크를 다시 부르지 않는다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const collector = bus.createCollectorSink('extra');
  const eventBus = m.createLogBackedEventBus({ scope, log, sinks: [collector] });
  const e = started(1);
  await eventBus.publish(e);
  await eventBus.publish(e);
  assert.equal(collector.events.length, 1, '원장이 원천이므로 중복 재태우면 이중 집계가 난다');
});

test('재시작 시나리오: JSONL 로 복구한 원장 위 새 버스도 과거 이벤트를 중복으로 본다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const eventBus1 = m.createLogBackedEventBus({ scope, log });
  const e = started(1);
  assert.equal((await eventBus1.publish(e)).status, 'delivered');

  const restored = m.restoreEventLog(scope, m.serializeJsonl(log.read())).log;
  const eventBus2 = m.createLogBackedEventBus({ scope, log: restored });
  const again = await eventBus2.publish(e);
  assert.equal(again.status, 'duplicate', '재시작 후에도 재전송을 새 이벤트로 집계하면 안 된다(§11.2)');
});

test('회귀: createEventBus 에 attach 없이 원장 기반 저장소를 그대로 넘기면 던진다', b, async () => {
  // 이 결함이 createLogBackedEventBus 가 필요한 이유다 — 실제 조립에서 재발하지 않는지 고정한다.
  const log = m.createMemoryEventLog(scope);
  const store = m.createLogBackedIdempotencyStore(log);
  const broken = bus.createEventBus({
    scope, sinks: [], releaseKeyOnSinkFailure: false,
    store, // attach 를 부르지 않고 그대로 연결 — 실제로 흔히 저지르는 실수
  });
  await assert.rejects(() => broken.publish(started(1)), /attach/);
});

// ── 실패·경계 경로 ───────────────────────────────────────────────────────────

test('다른 테넌트 이벤트는 rejected 로 돌아오고 원장에 남지 않는다(§11.1)', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const eventBus = m.createLogBackedEventBus({ scope, log });
  const foreign = schema.sessionStarted(meta(1, { tenantId: 't_other' }), {});
  const r = await eventBus.publish(foreign);
  assert.equal(r.status, 'rejected');
  assert.match(r.reasonKo, /§11\.1/);
  assert.deepEqual(r.sinks, []);
  assert.equal(log.size(), 0);
});

test('event_id 없는 이벤트도 rejected 로 흡수한다(§8.1) — 통화를 끊지 않는다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const eventBus = m.createLogBackedEventBus({ scope, log });
  const e = { ...started(1), event_id: '' };
  const r = await eventBus.publish(e);
  assert.equal(r.status, 'rejected');
  assert.match(r.reasonKo, /event_id/);
});

test('원장이 EventLogRejected 가 아닌 오류를 던지면 삼키지 않고 올린다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const broken = { ...log, append() { throw new Error('디스크 가득 참'); } };
  const eventBus = m.createLogBackedEventBus({ scope, log: broken });
  await assert.rejects(() => eventBus.publish(started(1)), /디스크 가득 참/);
});

test('싱크 하나가 실패해도 나머지 싱크는 계속 가고 원장 기록은 delivered 로 남는다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const good = bus.createCollectorSink('good');
  const flaky = { name: 'flaky', deliver() { throw new Error('브로커 거부'); } };
  const eventBus = m.createLogBackedEventBus({ scope, log, sinks: [flaky, good] });
  const r = await eventBus.publish(started(1));
  assert.equal(r.status, 'delivered', '원장에는 이미 기록됐으므로 싱크 실패로 상태가 바뀌면 안 된다');
  assert.equal(r.sinks.find((s) => s.sink === 'flaky').ok, false);
  assert.equal(r.sinks.find((s) => s.sink === 'good').ok, true);
  assert.equal(good.events.length, 1, '앞 싱크가 던져도 뒤 싱크는 불려야 한다');
  assert.equal(log.size(), 1);
});

test('원장 스코프와 버스 스코프가 다르면 조립 시점에 거절한다(§11.1)', b, () => {
  const log = m.createMemoryEventLog({ tenantId: 't_other' });
  assert.throws(() => m.createLogBackedEventBus({ scope, log }), /§11\.1/);
});

test('빈 입력: sinks 를 생략해도 정상 동작하고, 빈 배열 발행은 무해하다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const eventBus = m.createLogBackedEventBus({ scope, log });
  assert.deepEqual(await eventBus.publishAll([]), []);
  assert.equal(log.size(), 0);
});

test('publishAll 은 이벤트 하나가 rejected 여도 나머지 이벤트는 계속 처리한다', b, async () => {
  const log = m.createMemoryEventLog(scope);
  const eventBus = m.createLogBackedEventBus({ scope, log });
  const foreign = schema.sessionStarted(meta(9, { tenantId: 't_other', eventId: 'ex' }), {});
  const results = await eventBus.publishAll([started(1), foreign, ended(2)]);
  assert.deepEqual(results.map((r) => r.status), ['delivered', 'rejected', 'delivered']);
  assert.equal(log.size(), 2, '거절된 한 건 때문에 나머지 배치가 막히면 안 된다');
});
