import { test } from 'node:test';
import assert from 'node:assert/strict';

let rt = null;
try { rt = await import('../src/routing/agentQueue.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: rt ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't1' };
const HOURS = { utcOffsetMinutes: 540, weekly: { 1: [{ open: '09:00', close: '18:00' }] } }; // KST 월요일

const q = (id, over = {}) => ({ id, tenantId: 't1', titleKo: id, skills: [], closedAction: 'callback', ...over });

const cfg = (over = {}) => ({
  tenantId: 't1',
  queues: [q('q_general'), q('q_vip'), q('q_chat', { channels: ['chat'] })],
  rules: [
    { id: 'r_vip', priority: 10, when: { slotEquals: { grade: 'vip' } }, toQueue: 'q_vip' },
    { id: 'r_chat', priority: 5, when: { channels: ['chat'] }, toQueue: 'q_chat' },
    { id: 'r_complaint', priority: 5, when: { intents: ['complaint'] }, toQueue: 'q_vip' },
  ],
  defaultQueueId: 'q_general',
  ...over,
});

const ctx = (over = {}) => ({ scope, channel: 'voice', reason: 'max_retry', ...over });
const snap = (queueId, waiting, agents, at = '2026-03-02T01:00:00.000Z') =>
  ({ queueId, waiting, availableAgents: agents, observedAt: at });

test('설정 검증 — 미정의 큐·기본큐 누락·조건 없는 규칙·오버플로 순환', b, () => {
  assert.deepEqual(rt.validateRoutingConfig(cfg()), []);
  const bad = rt.validateRoutingConfig(cfg({
    defaultQueueId: 'q_none',
    rules: [{ id: 'r1', priority: 1, when: {}, toQueue: 'q_ghost' }],
  }));
  assert.ok(bad.some((e) => /기본 큐가 정의되지 않았다/.test(e)));
  assert.ok(bad.some((e) => /정의되지 않은 큐/.test(e)));
  assert.ok(bad.some((e) => /조건이 없다/.test(e)));

  const cyc = rt.validateRoutingConfig(cfg({
    queues: [q('a', { overflowQueueId: 'b' }), q('b', { overflowQueueId: 'a' })],
    rules: [], defaultQueueId: 'a',
  }));
  assert.ok(cyc.some((e) => /오버플로 순환/.test(e)));
});

test('설정 검증 — 테넌트 불일치 큐를 거른다 (§11.1)', b, () => {
  const errs = rt.validateRoutingConfig(cfg({ queues: [q('q_general', { tenantId: 't2' })], rules: [] }));
  assert.ok(errs.some((e) => /tenant_id가 설정과 다르다/.test(e)));
});

test('운영시간 판정 — 오프셋·휴무일·구간 경계', b, () => {
  // 2026-03-02는 월요일. KST 09:00 = UTC 00:00
  assert.equal(rt.isOpen(HOURS, '2026-03-02T00:00:00.000Z'), true);
  assert.equal(rt.isOpen(HOURS, '2026-03-01T23:59:00.000Z'), false);
  assert.equal(rt.isOpen(HOURS, '2026-03-02T09:00:00.000Z'), false); // KST 18:00 종료
  assert.equal(rt.isOpen({ ...HOURS, holidays: ['2026-03-02'] }, '2026-03-02T00:00:00.000Z'), false);
  assert.equal(rt.isOpen(undefined, '2026-03-02T00:00:00.000Z'), true);
});

test('운영시간 설정 오류 검출', b, () => {
  const errs = rt.validateBusinessHours('q', { utcOffsetMinutes: 540, weekly: { 1: [{ open: '18:00', close: '09:00' }] } });
  assert.ok(errs.some((e) => /뒤집혔다/.test(e)));
  assert.ok(rt.validateBusinessHours('q', { utcOffsetMinutes: 540, weekly: { 1: [{ open: '25:00', close: '26:00' }] } }).length > 0);
});

test('큐 선택 — 우선순위 내림차순, 동점은 정의 순서', b, () => {
  assert.equal(rt.selectQueue(cfg(), ctx({ slots: { grade: 'vip' }, intent: 'complaint' })).queue.id, 'q_vip');
  assert.equal(rt.selectQueue(cfg(), ctx({ channel: 'chat' })).matchedRuleId, 'r_chat');
  assert.equal(rt.selectQueue(cfg(), ctx({ intent: 'complaint' })).matchedRuleId, 'r_complaint');
});

test('큐 선택 — 매칭 없으면 기본 큐, 채널 안 받는 큐는 건너뛴다', b, () => {
  const s = rt.selectQueue(cfg(), ctx());
  assert.equal(s.queue.id, 'q_general');
  assert.equal(s.matchedRuleId, undefined);
  // r_chat이 voice를 채널조건으로 잘못 걸어도 q_chat이 voice를 안 받으므로 건너뛴다
  const bad = cfg({ rules: [{ id: 'r_bad', priority: 9, when: { reasons: ['max_retry'] }, toQueue: 'q_chat' }] });
  assert.equal(rt.selectQueue(bad, ctx()).queue.id, 'q_general');
});

test('큐 선택 — 다른 테넌트 설정은 거부 (§11.1)', b, () => {
  assert.throws(() => rt.selectQueue(cfg(), ctx({ scope: { tenantId: 't2' } })), /다른 테넌트/);
});

test('수용 판정 — 정상 수용', b, () => {
  const d = rt.admitToQueue(cfg({ queues: [q('q_general', { hours: HOURS, maxWaiting: 5 })] }),
    'q_general', [snap('q_general', 1, 2)], '2026-03-02T01:00:00.000Z');
  assert.equal(d.status, 'accepted');
  assert.equal(d.admittedQueueId, 'q_general');
});

test('수용 판정 — 한도 초과 시 오버플로 큐로', b, () => {
  const c = cfg({
    queues: [q('q_a', { maxWaiting: 1, overflowQueueId: 'q_b' }), q('q_b', { maxWaiting: 5 })],
    rules: [], defaultQueueId: 'q_a',
  });
  const d = rt.admitToQueue(c, 'q_a', [snap('q_a', 1, 3), snap('q_b', 0, 3)], '2026-03-02T01:00:00.000Z');
  assert.equal(d.status, 'overflow');
  assert.equal(d.admittedQueueId, 'q_b');
  assert.deepEqual(d.path, ['q_a', 'q_b']);
});

test('수용 판정 — 운영시간 외·상태 미확인·오래된 스냅샷은 대안을 낸다 (§9.3)', b, () => {
  const c = cfg({ queues: [q('q_general', { hours: HOURS, closedAction: 'legacy_ivr' })], rules: [] });
  const closed = rt.admitToQueue(c, 'q_general', [snap('q_general', 0, 3)], '2026-03-02T15:00:00.000Z');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.action, 'legacy_ivr');

  const unknown = rt.admitToQueue(c, 'q_general', [], '2026-03-02T01:00:00.000Z');
  assert.equal(unknown.status, 'closed');
  assert.match(unknown.reasonKo, /추정하지 않는다/);

  const stale = rt.admitToQueue(c, 'q_general', [snap('q_general', 0, 3, '2026-03-02T00:00:00.000Z')],
    '2026-03-02T01:00:00.000Z', { staleAfterMs: 60_000 });
  assert.equal(stale.status, 'closed');
  assert.match(stale.reasonKo, /오래되었다/);
});

test('수용 판정 — 상담사 0명은 기본적으로 거절하되 정책으로 허용 가능', b, () => {
  const c = cfg({ queues: [q('q_general')], rules: [] });
  assert.equal(rt.admitToQueue(c, 'q_general', [snap('q_general', 0, 0)], '2026-03-02T01:00:00.000Z').status, 'closed');
  assert.equal(rt.admitToQueue(c, 'q_general', [snap('q_general', 0, 0)], '2026-03-02T01:00:00.000Z',
    { admitWithNoAgents: true }).status, 'accepted');
});

const offer = (over = {}) => rt.offerAssignment({
  scope, offerId: 'o1', queueId: 'q_general', interactionId: 'i_1', agentId: 'a1',
  offeredAt: '2026-03-02T01:00:00.000Z', timeoutMs: 20_000, attempt: 1, ...over,
});

test('오퍼 — 수락은 배정, 거절·무응답은 재배정', b, () => {
  const o = offer();
  assert.equal(o.state, 'offered');
  const acc = rt.applyOfferEvent(o, 'accept', '2026-03-02T01:00:05.000Z', 3);
  assert.equal(acc.next, 'assigned');
  assert.equal(acc.offer.state, 'accepted');

  assert.equal(rt.applyOfferEvent(o, 'decline', '2026-03-02T01:00:05.000Z', 3).next, 'requeue');
  assert.equal(rt.applyOfferEvent(o, 'tick', '2026-03-02T01:00:05.000Z', 3).next, 'waiting');
  const to = rt.applyOfferEvent(o, 'tick', '2026-03-02T01:00:25.000Z', 3);
  assert.equal(to.next, 'requeue');
  assert.equal(to.offer.state, 'timed_out');
});

test('오퍼 — 만료 후 뒤늦은 수락은 무효(경합 방지)', b, () => {
  const r = rt.applyOfferEvent(offer(), 'accept', '2026-03-02T01:00:30.000Z', 3);
  assert.equal(r.offer.state, 'timed_out');
  assert.notEqual(r.next, 'assigned');
});

test('오퍼 — 재배정 한도 소진 시 exhausted, 대안은 큐 설정을 따른다', b, () => {
  const r = rt.applyOfferEvent(offer({ attempt: 3 }), 'decline', '2026-03-02T01:00:05.000Z', 3);
  assert.equal(r.next, 'exhausted');
  const c = cfg({ queues: [q('q_general', { closedAction: 'voicemail' })], rules: [] });
  assert.equal(rt.exhaustedAction(c, 'q_general'), 'voicemail');
  assert.equal(rt.exhaustedAction(c, 'q_none'), 'reject');
});

test('오퍼 — 종결된 오퍼는 다시 전이하지 않는다', b, () => {
  const done = { ...offer(), state: 'accepted' };
  assert.equal(rt.applyOfferEvent(done, 'decline', '2026-03-02T01:00:05.000Z', 3).next, 'waiting');
  assert.throws(() => rt.offerAssignment({ scope, offerId: 'o', queueId: 'q', interactionId: 'i', agentId: 'a', offeredAt: '2026-03-02T01:00:00.000Z', timeoutMs: 0, attempt: 1 }), /timeoutMs/);
});
