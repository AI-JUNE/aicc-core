// 배정 오퍼 실행기 검사 — 설계서 §2·§9.3·§10.3·§11.1·§13-3.
//
// 고정하는 것은 "오퍼가 열린다"가 아니라 **호스트가 손으로 꿰면 반드시 나는 실패**다.
// 전부 예외가 아니라 "고객이 조용히 기다린다"로 나타나므로, 결함 자체를 먼저 재현한 뒤
// 실행기가 그것을 막는다는 것을 확인한다(실제 `applyOfferEvent`·`placementAfterExhausted` 를 지난다).
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let aq = null;
let hd = null;
try {
  m = await import('../src/routing/executeOffer.ts');
  aq = await import('../src/routing/agentQueue.ts');
  hd = await import('../src/routing/executeHandoff.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't1' };
const NOW = '2026-03-02T01:00:00.000Z';
const plus = (ms) => new Date(Date.parse(NOW) + ms).toISOString();

const q = (id, over = {}) => ({
  id, tenantId: 't1', titleKo: id, skills: [], closedAction: 'callback', ...over,
});
const cfg = (over = {}) => ({
  tenantId: 't1',
  queues: [q('q_general'), q('q_vm', { closedAction: 'voicemail' })],
  rules: [],
  defaultQueueId: 'q_general',
  ...over,
});

const POLICY = { timeoutMs: 20_000, maxAttempts: 3 };
const SUMMARY = '문의: 요금 · 수집: 고객명 홍**';

const open = (ledger, over = {}) =>
  m.openOffer(cfg(), ledger, POLICY, {
    scope,
    queueId: 'q_general',
    interactionId: 'i1',
    candidates: ['agent_kim', 'agent_lee'],
    offerId: 'o1',
    nowIso: NOW,
    summaryMasked: SUMMARY,
    ...over,
  });

const settle = (ledger, over = {}) =>
  m.settleOffer(cfg(), ledger, POLICY, {
    scope,
    offerId: 'o1',
    event: 'decline',
    nowIso: NOW,
    summaryMasked: SUMMARY,
    ...over,
  });

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('오퍼를 열면 선언 순서의 첫 후보에게 가고 attempt 는 1 이다', b, () => {
  const r = open(m.emptyOfferLedger());
  assert.equal(r.code, 'offered');
  assert.equal(r.offer.agentId, 'agent_kim');
  assert.equal(r.offer.attempt, 1);
  assert.equal(r.offer.state, 'offered');
  assert.equal(r.offer.timeoutMs, 20_000);
  assert.equal(r.attempt, 1);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.ledger.offers.length, 1);
});

test('수락은 assigned 로 끝나고 원장에 반영된다', b, () => {
  const o = open(m.emptyOfferLedger());
  const r = settle(o.ledger, { event: 'accept' });
  assert.equal(r.code, 'assigned');
  assert.equal(r.offer.state, 'accepted');
  assert.equal(r.ledger.offers[0].state, 'accepted');
  assert.equal(r.placement, undefined);
});

test('만료 전 tick 은 waiting 이며 상태를 바꾸지 않는다', b, () => {
  const o = open(m.emptyOfferLedger());
  const r = settle(o.ledger, { event: 'tick', nowIso: plus(1_000) });
  assert.equal(r.code, 'waiting');
  assert.equal(r.ledger.offers[0].state, 'offered');
});

test('취소는 cancelled 이며 대안으로 넘기지 않는다', b, () => {
  const o = open(m.emptyOfferLedger());
  const r = settle(o.ledger, { event: 'cancel' });
  assert.equal(r.code, 'cancelled');
  assert.equal(r.placement, undefined);
});

// ── (가) attempt 를 호스트가 세면 재배정이 무한이 된다 ───────────────────────

test('결함 재현: offerAssignment 는 attempt 를 인자로 받으므로 1 을 계속 넘기면 소진되지 않는다', b, () => {
  // 원함수가 그렇게 동작한다는 사실을 먼저 고정한다 — 실행기가 막는 대상이 이것이다.
  const stuck = aq.offerAssignment({
    scope, offerId: 'x', queueId: 'q_general', interactionId: 'i1',
    agentId: 'agent_kim', offeredAt: NOW, timeoutMs: 1_000, attempt: 1,
  });
  const out = aq.applyOfferEvent(stuck, 'decline', NOW, 3);
  assert.equal(out.next, 'requeue');   // 몇 번을 돌려도 attempt 가 1 이면 영원히 requeue
});

test('attempt 는 원장에서 센다 — 호스트가 선언할 자리가 없다', b, () => {
  let led = open(m.emptyOfferLedger()).ledger;
  led = settle(led, { candidates: ['agent_kim', 'agent_lee'], nextOfferId: 'o2' }).ledger;
  const second = led.offers.find((o) => o.offerId === 'o2');
  assert.equal(second.attempt, 2);
  assert.equal(second.agentId, 'agent_lee');
});

// ── (나) 소진 이후가 §9.3 대안으로 수렴한다 ──────────────────────────────────

test('한도를 다 쓰면 같은 호출에서 대안으로 수렴한다(placementAfterExhausted 를 실제로 지난다)', b, () => {
  const pol = { timeoutMs: 20_000, maxAttempts: 2 };
  let led = m.openOffer(cfg(), m.emptyOfferLedger(), pol, {
    scope, queueId: 'q_vm', interactionId: 'i1',
    candidates: ['a1', 'a2'], offerId: 'o1', nowIso: NOW, summaryMasked: SUMMARY,
  }).ledger;
  const r1 = m.settleOffer(cfg(), led, pol, {
    scope, offerId: 'o1', event: 'decline', nowIso: NOW,
    candidates: ['a1', 'a2'], nextOfferId: 'o2', summaryMasked: SUMMARY,
  });
  assert.equal(r1.code, 'offered');
  const r2 = m.settleOffer(cfg(), r1.ledger, pol, {
    scope, offerId: 'o2', event: 'decline', nowIso: NOW,
    candidates: ['a1', 'a2'], nextOfferId: 'o3', summaryMasked: SUMMARY,
  });
  assert.equal(r2.code, 'alternative');
  assert.equal(r2.placement.placement, 'alternative');
  assert.equal(r2.placement.cause, 'exhausted');
  // 대안 행동은 큐 선언값 그대로 — 여기서 만들지 않는다(§13-3).
  assert.equal(r2.placement.action, 'voicemail');
  assert.equal(r2.placement.summaryPresent, true);
  assert.equal(r2.placement.summaryMasked, SUMMARY);
});

test('이미 소진된 상호작용에 오퍼를 열면 대안을 돌려준다 — 새 오퍼를 만들지 않는다', b, () => {
  const pol = { timeoutMs: 20_000, maxAttempts: 1 };
  const first = m.openOffer(cfg(), m.emptyOfferLedger(), pol, {
    scope, queueId: 'q_general', interactionId: 'i1',
    candidates: ['a1'], offerId: 'o1', nowIso: NOW,
  });
  const done = m.settleOffer(cfg(), first.ledger, pol, {
    scope, offerId: 'o1', event: 'decline', nowIso: NOW,
  });
  assert.equal(done.code, 'alternative');
  const again = m.openOffer(cfg(), done.ledger, pol, {
    scope, queueId: 'q_general', interactionId: 'i1',
    candidates: ['a2'], offerId: 'o2', nowIso: NOW,
  });
  assert.equal(again.code, 'alternative');
  assert.equal(again.ledger.offers.length, 1);
});

test('요약 없이 소진되면 대안에 그 사실이 경고로 남는다(§2)', b, () => {
  const pol = { timeoutMs: 20_000, maxAttempts: 1 };
  const first = m.openOffer(cfg(), m.emptyOfferLedger(), pol, {
    scope, queueId: 'q_general', interactionId: 'i1',
    candidates: ['a1'], offerId: 'o1', nowIso: NOW,
  });
  const r = m.settleOffer(cfg(), first.ledger, pol, {
    scope, offerId: 'o1', event: 'decline', nowIso: NOW,
  });
  assert.equal(r.placement.summaryPresent, false);
  assert.ok(r.placement.warnings.some((w) => w.includes('요약')));
});

// ── (다)(라)(마) 고르면 안 되는 후보 ────────────────────────────────────────

test('같은 상호작용에 오퍼가 둘 열리지 않는다', b, () => {
  const o = open(m.emptyOfferLedger());
  const dup = open(o.ledger, { offerId: 'o2' });
  assert.equal(dup.code, 'refused');
  assert.equal(dup.ledger.offers.length, 1);
  assert.ok(dup.issues.some((i) => i.includes('열린 오퍼')));
});

test('다른 상호작용의 오퍼가 열린 상담사는 제외되고 제외 사실이 드러난다', b, () => {
  const o = open(m.emptyOfferLedger());               // agent_kim 에게 i1 오퍼
  const other = open(o.ledger, { interactionId: 'i2', offerId: 'o2' });
  assert.equal(other.code, 'offered');
  assert.equal(other.offer.agentId, 'agent_lee');
  assert.equal(other.skipped.length, 1);
  assert.ok(other.skipped[0].includes('agent_kim'));
});

test('후보가 전부 바쁘면 waiting 이며 큐에서 빼지 않는다 — 소진과 구분한다', b, () => {
  const o = open(m.emptyOfferLedger());
  const other = m.openOffer(cfg(), o.ledger, POLICY, {
    scope, queueId: 'q_general', interactionId: 'i2',
    candidates: ['agent_kim'], offerId: 'o2', nowIso: NOW,
  });
  assert.equal(other.code, 'waiting');
  assert.equal(other.placement, undefined);
  assert.equal(other.ledger.offers.length, 1);
  assert.ok(other.warnings.some((w) => w.includes('한도 소진이 아니다')));
});

test('거절한 상담사에게 다시 제안하지 않는다(allowReoffer 미선언)', b, () => {
  let led = m.openOffer(cfg(), m.emptyOfferLedger(), POLICY, {
    scope, queueId: 'q_general', interactionId: 'i1',
    candidates: ['agent_kim'], offerId: 'o1', nowIso: NOW,
  }).ledger;
  const r = m.settleOffer(cfg(), led, POLICY, {
    scope, offerId: 'o1', event: 'decline', nowIso: NOW,
    candidates: ['agent_kim'], nextOfferId: 'o2',
  });
  // 한도(3)가 남아 있어도 제안할 사람이 없다 → waiting 이고 한도는 깎이지 않는다.
  assert.equal(r.code, 'waiting');
  assert.equal(r.ledger.offers.length, 1);
  assert.ok(r.skipped.some((s) => s.includes('이미 제안받았다')));
});

test('allowReoffer 를 선언하면 같은 상담사에게 다시 간다', b, () => {
  const pol = { ...POLICY, allowReoffer: true };
  const led = m.openOffer(cfg(), m.emptyOfferLedger(), pol, {
    scope, queueId: 'q_general', interactionId: 'i1',
    candidates: ['agent_kim'], offerId: 'o1', nowIso: NOW,
  }).ledger;
  const r = m.settleOffer(cfg(), led, pol, {
    scope, offerId: 'o1', event: 'decline', nowIso: NOW,
    candidates: ['agent_kim'], nextOfferId: 'o2',
  });
  assert.equal(r.code, 'offered');
  assert.equal(r.offer.agentId, 'agent_kim');
  assert.equal(r.offer.attempt, 2);
});

// ── (바) 만료된 오퍼가 영영 열린 채 남지 않는다 ─────────────────────────────

test('만료된 오퍼는 목록으로 드러난다 — Core 가 타이머를 돌리지 않는다', b, () => {
  const o = open(m.emptyOfferLedger());
  assert.deepEqual([...m.expiredOffers(o.ledger, scope, plus(1_000))], []);
  const due = m.expiredOffers(o.ledger, scope, plus(20_000));
  assert.equal(due.length, 1);
  assert.equal(due[0].offerId, 'o1');
});

test('만료 후 tick 은 timed_out 으로 반영되고 재배정으로 이어진다', b, () => {
  const o = open(m.emptyOfferLedger());
  const r = settle(o.ledger, {
    event: 'tick', nowIso: plus(20_000),
    candidates: ['agent_kim', 'agent_lee'], nextOfferId: 'o2',
  });
  assert.equal(r.code, 'offered');
  assert.equal(r.ledger.offers.find((x) => x.offerId === 'o1').state, 'timed_out');
  assert.equal(r.offer.agentId, 'agent_lee');
});

test('만료 조회에 형태가 틀린 시각을 주면 빈 목록이 아니라 던진다', b, () => {
  const o = open(m.emptyOfferLedger());
  assert.throws(() => m.expiredOffers(o.ledger, scope, '2026-03-02 10:00'));
});

test('만료 후 뒤늦은 수락은 무효이며 재배정된다(경합 차단)', b, () => {
  const o = open(m.emptyOfferLedger());
  const r = settle(o.ledger, {
    event: 'accept', nowIso: plus(30_000),
    candidates: ['agent_kim', 'agent_lee'], nextOfferId: 'o2',
  });
  assert.equal(r.code, 'offered');
  assert.equal(r.ledger.offers.find((x) => x.offerId === 'o1').state, 'timed_out');
});

// ── (사)(아) 중복 요청 ───────────────────────────────────────────────────────

test('종결된 오퍼의 중복 이벤트는 waiting 이 아니라 refused 다', b, () => {
  const o = open(m.emptyOfferLedger());
  const first = settle(o.ledger, { event: 'accept' });
  // 원함수는 규약대로 waiting 을 돌려준다 — 그것을 "응답 대기 중"으로 읽으면 사고다.
  const raw = aq.applyOfferEvent(first.offer, 'decline', NOW, 3);
  assert.equal(raw.next, 'waiting');
  const r = settle(first.ledger, { event: 'decline' });
  assert.equal(r.code, 'refused');
  assert.equal(r.ledger.offers[0].state, 'accepted');
});

test('같은 오퍼 id 를 다시 쓰면 거절한다 — attempt 되감기를 막는다', b, () => {
  const o = open(m.emptyOfferLedger());
  const settled = settle(o.ledger, { event: 'decline' });
  const again = m.openOffer(cfg(), settled.ledger, POLICY, {
    scope, queueId: 'q_general', interactionId: 'i1',
    candidates: ['agent_lee'], offerId: 'o1', nowIso: NOW,
  });
  assert.equal(again.code, 'refused');
  assert.ok(again.issues.some((i) => i.includes('오퍼 id')));
});

test('모르는 오퍼 id 의 이벤트는 조용히 넘기지 않는다', b, () => {
  const r = settle(m.emptyOfferLedger(), { offerId: 'nope' });
  assert.equal(r.code, 'refused');
  assert.equal(r.ledger.offers.length, 0);
});

// ── 전이 반영과 이어 주기를 갈라 둔다 ───────────────────────────────────────

test('후보·다음 id 가 없으면 requeue 로 드러내고 전이는 반영한다', b, () => {
  const o = open(m.emptyOfferLedger());
  const r = settle(o.ledger, { event: 'decline' });
  assert.equal(r.code, 'requeue');
  assert.equal(r.ledger.offers[0].state, 'declined');
  assert.ok(r.warnings.some((w) => w.includes('큐에 묶인다')));
});

test('이어 주기가 실패해도 거절·무응답 사실은 되돌리지 않는다', b, () => {
  const o = open(m.emptyOfferLedger());
  // 다음 오퍼 id 를 이미 쓴 값으로 주어 이어 주기를 실패시킨다.
  const r = settle(o.ledger, { candidates: ['agent_lee'], nextOfferId: 'o1' });
  assert.equal(r.code, 'requeue');
  assert.equal(r.ledger.offers[0].state, 'declined');
  assert.ok(r.issues.length > 0);
});

// ── (자) 시각·정책·후보 형태 ─────────────────────────────────────────────────

test('시간대 없는 시각은 통과하지 않는다 — 서버마다 만료 판정이 갈린다', b, () => {
  const r = open(m.emptyOfferLedger(), { nowIso: '2026-03-02 10:00' });
  assert.equal(r.code, 'refused');
  assert.ok(r.issues.some((i) => i.includes('ISO-8601')));
});

test('한도 기본값을 만들지 않는다 — 없거나 0 이면 거절한다(§13-3)', b, () => {
  for (const pol of [{ timeoutMs: 0, maxAttempts: 3 }, { timeoutMs: 1000, maxAttempts: 0 }, {}]) {
    const r = m.openOffer(cfg(), m.emptyOfferLedger(), pol, {
      scope, queueId: 'q_general', interactionId: 'i1',
      candidates: ['a1'], offerId: 'o1', nowIso: NOW,
    });
    assert.equal(r.code, 'refused');
    assert.equal(r.ledger.offers.length, 0);
  }
});

test('빈 후보 목록·빈 id·중복 후보를 거절한다', b, () => {
  assert.equal(open(m.emptyOfferLedger(), { candidates: [] }).code, 'waiting');
  assert.equal(open(m.emptyOfferLedger(), { candidates: [''] }).code, 'refused');
  const dup = open(m.emptyOfferLedger(), { candidates: ['a1', 'a1'] });
  assert.equal(dup.code, 'refused');
  assert.ok(dup.issues.some((i) => i.includes('중복')));
});

test('개인정보 형태의 상담사 id 는 거절하고 원문을 결과에 담지 않는다(§10.3)', b, () => {
  const r = open(m.emptyOfferLedger(), { candidates: ['010-1234-5678'] });
  assert.equal(r.code, 'refused');
  assert.ok(r.issues.some((i) => i.includes('개인정보 패턴')));
  assert.ok(!JSON.stringify(r).includes('010-1234-5678'));
});

test('설정에 없는 큐의 오퍼는 열리되 사실이 경고로 남는다', b, () => {
  const r = open(m.emptyOfferLedger(), { queueId: 'q_typo' });
  assert.equal(r.code, 'offered');
  assert.ok(r.warnings.some((w) => w.includes('설정에 없는 큐')));
});

// ── §11.1 격리 ───────────────────────────────────────────────────────────────

test('다른 테넌트 설정으로는 오퍼를 열 수 없다 — 던진다', b, () => {
  assert.throws(() => m.openOffer(cfg({ tenantId: 'rival' }), m.emptyOfferLedger(), POLICY, {
    scope, queueId: 'q_general', interactionId: 'i1',
    candidates: ['a1'], offerId: 'o1', nowIso: NOW,
  }));
  assert.throws(() => m.openOffer(cfg(), m.emptyOfferLedger(), POLICY, {
    scope: { tenantId: '' }, queueId: 'q_general', interactionId: 'i1',
    candidates: ['a1'], offerId: 'o1', nowIso: NOW,
  }));
});

test('다른 워크스페이스 설정도 막는다', b, () => {
  assert.throws(() => m.openOffer(cfg({ workspaceId: 'w2' }), m.emptyOfferLedger(), POLICY, {
    scope: { tenantId: 't1', workspaceId: 'w1' }, queueId: 'q_general', interactionId: 'i1',
    candidates: ['a1'], offerId: 'o1', nowIso: NOW,
  }));
});

test('남의 테넌트 오퍼가 섞인 원장은 조용히 걸러 내지 않고 거절한다', b, () => {
  const foreign = {
    offers: [{
      offerId: 'x', queueId: 'q_general', interactionId: 'i9', tenantId: 'rival',
      agentId: 'a9', offeredAt: NOW, timeoutMs: 1000, state: 'offered', attempt: 1,
    }],
  };
  const r = open(foreign);
  assert.equal(r.code, 'refused');
  assert.ok(r.issues.some((i) => i.includes('§11.1')));
});

test('만료 조회·열린 오퍼 조회는 자기 테넌트만 본다', b, () => {
  const mixed = {
    offers: [{
      offerId: 'x', queueId: 'q_general', interactionId: 'i9', tenantId: 'rival',
      agentId: 'a9', offeredAt: NOW, timeoutMs: 1, state: 'offered', attempt: 1,
    }],
  };
  assert.deepEqual([...m.expiredOffers(mixed, scope, plus(60_000))], []);
  assert.equal(m.openOfferOf(mixed, scope, 'i9'), undefined);
});

// ── 경계: 판정을 복사하지 않는다 ────────────────────────────────────────────

test('엔진·백엔드 폴백 모듈을 참조하지 않는다(§9.3) — 상담사 부재는 장애가 아니다', b, async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src/routing/executeOffer.ts'),
    'utf8',
  );
  assert.ok(!src.includes("ops/fallback"));
  assert.ok(!src.includes("ops/health"));
  // 대안 행동 기본값을 코드에 두지 않는다(§13-3) — 큐 선언값을 그대로 쓴다.
  assert.ok(!/closedAction\s*[:=]\s*'/.test(src));
});

test('계약 버전이 노출된다', b, () => {
  assert.equal(typeof m.OFFER_EXECUTION_CONTRACT_VERSION, 'number');
  assert.equal(typeof hd.isRoutingInstant, 'function');
});

test('열린 오퍼 조회는 종결된 오퍼를 돌려주지 않는다', b, () => {
  const o = open(m.emptyOfferLedger());
  assert.equal(m.openOfferOf(o.ledger, scope, 'i1').offerId, 'o1');
  const done = settle(o.ledger, { event: 'accept' });
  assert.equal(m.openOfferOf(done.ledger, scope, 'i1'), undefined);
});

test('배정이 끝난 상호작용에는 새 오퍼를 열지 않는다', b, () => {
  const o = open(m.emptyOfferLedger());
  const done = settle(o.ledger, { event: 'accept' });
  const again = open(done.ledger, { offerId: 'o2' });
  assert.equal(again.code, 'refused');
  assert.ok(again.issues.some((i) => i.includes('배정')));
});
