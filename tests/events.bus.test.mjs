import { test } from 'node:test';
import assert from 'node:assert/strict';

let bus = null, ev = null;
try {
  bus = await import('../src/events/bus.ts');
  ev = await import('../src/events/schema.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: bus ? false : '타입 스트리핑 미지원 런타임' };

const meta = (id, tenant = 't1') => ({
  eventId: id, occurredAt: '2026-01-01T00:00:00.000Z',
  tenantId: tenant, interactionId: 'i1', channel: 'voice',
});

test('§8.1 같은 event_id는 두 번 전달되지 않는다(멱등)', b, async () => {
  const sink = bus.createCollectorSink();
  const eb = bus.createEventBus({
    scope: { tenantId: 't1' }, sinks: [sink],
    store: bus.createMemoryIdempotencyStore({ maxKeys: 100 }),
    releaseKeyOnSinkFailure: false,
  });
  const e = ev.sessionStarted(meta('e1'), { entryPoint: 'inbound_call' });
  const r1 = await eb.publish(e);
  const r2 = await eb.publish(e);
  assert.equal(r1.status, 'delivered');
  assert.equal(r2.status, 'duplicate');
  assert.equal(sink.events.length, 1);
});

test('§11.1 다른 테넌트 이벤트는 버스를 통과하지 못한다', b, async () => {
  const sink = bus.createCollectorSink();
  const eb = bus.createEventBus({
    scope: { tenantId: 't1' }, sinks: [sink],
    store: bus.createMemoryIdempotencyStore({ maxKeys: 10 }),
    releaseKeyOnSinkFailure: false,
  });
  const r = await eb.publish(ev.sessionStarted(meta('e1', 't2')));
  assert.equal(r.status, 'rejected');
  assert.equal(sink.events.length, 0);
});

test('§8.1 멱등 키는 테넌트별로 분리된다', b, () => {
  const a = bus.idempotencyKey(ev.sessionStarted(meta('e1', 't1')));
  const c = bus.idempotencyKey(ev.sessionStarted(meta('e1', 't2')));
  assert.notEqual(a, c);
});

test('§8.1 결정적 event_id는 재시도해도 동일하다', b, () => {
  const a = bus.deterministicEventId({ interactionId: 'i1', type: 'turn.completed', discriminator: 'turn-3' });
  const c = bus.deterministicEventId({ interactionId: 'i1', type: 'turn.completed', discriminator: 'turn-3' });
  assert.equal(a, c);
  assert.notEqual(a, bus.deterministicEventId({ interactionId: 'i1', type: 'turn.completed', discriminator: 'turn-4' }));
});

test('싱크 하나가 실패해도 나머지는 전달되고 실패가 보고된다', b, async () => {
  const good = bus.createCollectorSink('good');
  const bad = { name: 'bad', deliver() { throw new Error('브로커 장애'); } };
  const eb = bus.createEventBus({
    scope: { tenantId: 't1' }, sinks: [bad, good],
    store: bus.createMemoryIdempotencyStore({ maxKeys: 10 }),
    releaseKeyOnSinkFailure: true,
  });
  const r = await eb.publish(ev.sessionStarted(meta('e1')));
  assert.equal(good.events.length, 1);
  assert.equal(r.sinks.find((s) => s.sink === 'bad').ok, false);
  // release 되었으므로 재발행 시 다시 시도한다
  const r2 = await eb.publish(ev.sessionStarted(meta('e1')));
  assert.equal(r2.status, 'delivered');
});

test('dedupeEvents는 순서를 유지하며 중복만 제거한다', b, () => {
  const list = [
    ev.sessionStarted(meta('e1')),
    ev.turnCompleted(meta('e2'), { turnId: 't1', speaker: 'bot', utterance: '안녕하세요' }),
    ev.sessionStarted(meta('e1')),
  ];
  const out = bus.dedupeEvents(list);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.event_id), ['e1', 'e2']);
});

test('publishAll은 발행 순서를 보존한다', b, async () => {
  const sink = bus.createCollectorSink();
  const eb = bus.createEventBus({
    scope: { tenantId: 't1' }, sinks: [sink],
    store: bus.createMemoryIdempotencyStore({ maxKeys: 10 }),
    releaseKeyOnSinkFailure: false,
  });
  await eb.publishAll(['e1', 'e2', 'e3'].map((id) => ev.sessionStarted(meta(id))));
  assert.deepEqual(sink.events.map((e) => e.event_id), ['e1', 'e2', 'e3']);
});
