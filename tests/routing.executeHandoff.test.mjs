// 이관 실행 오케스트레이터 검사 — 설계서 §2·§9.3·§10.3·§11.1·§13-3.
//
// 여기서 고정하는 것은 "동작한다"가 아니라 **채널 3곳이 각자 쓰면 각자 다르게 틀릴 자리**다.
// 특히 오버플로 목적지(요청 큐 vs 실제 수용 큐)는 타입도 값도 멀쩡해서 어디서도 안 터진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let rt = null;
let aq = null;
try {
  rt = await import('../src/routing/executeHandoff.ts');
  aq = await import('../src/routing/agentQueue.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: rt ? false : '타입 스트리핑 미지원 런타임' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/routing/executeHandoff.ts');

const scope = { tenantId: 't1' };
// KST(+540) 월요일 09:00~18:00. 2026-03-02T01:00:00Z = 월 10:00 KST → 영업 중.
const HOURS = { utcOffsetMinutes: 540, weekly: { 1: [{ open: '09:00', close: '18:00' }] } };
const NOW = '2026-03-02T01:00:00.000Z';
const NIGHT = '2026-03-02T15:00:00.000Z'; // 월 24:00 KST → 영업 외

const q = (id, over = {}) => ({
  id, tenantId: 't1', titleKo: id, skills: [], closedAction: 'callback', hours: HOURS, ...over,
});

const cfg = (over = {}) => ({
  tenantId: 't1',
  queues: [
    q('q_general'),
    q('q_vip', { maxWaiting: 1, overflowQueueId: 'q_general' }),
    q('q_dead', { maxWaiting: 0, closedAction: 'voicemail' }),
  ],
  rules: [
    { id: 'r_vip', priority: 10, when: { slotEquals: { grade: 'vip' } }, toQueue: 'q_vip' },
    { id: 'r_dead', priority: 9, when: { intents: ['unstaffed'] }, toQueue: 'q_dead' },
  ],
  defaultQueueId: 'q_general',
  ...over,
});

const snap = (queueId, waiting, agents, at = NOW) =>
  ({ queueId, waiting, availableAgents: agents, observedAt: at });

const req = (over = {}) => ({
  scope,
  channel: 'voice',
  reason: 'max_retry',
  summaryMasked: '문의: 요금 · 수집: 고객명 홍**',
  nowIso: NOW,
  snapshots: [snap('q_general', 0, 3), snap('q_vip', 0, 2), snap('q_dead', 0, 0)],
  ...over,
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────
test('수용되면 목적지·규칙·요약이 함께 나온다', b, () => {
  const p = rt.executeHandoff(cfg(), req({ slots: { grade: 'vip' } }));
  assert.equal(p.placement, 'queued');
  assert.equal(p.queueId, 'q_vip');
  assert.equal(p.requestedQueueId, 'q_vip');
  assert.equal(p.overflowed, false);
  assert.equal(p.matchedRuleId, 'r_vip');
  assert.equal(p.summaryPresent, true);
  assert.equal(p.summaryMasked, '문의: 요금 · 수집: 고객명 홍**');
  assert.deepEqual(p.warnings, []);
  assert.ok(rt.isQueued(p));
});

test('규칙이 없으면 기본 큐로 가고 matchedRuleId 를 지어내지 않는다', b, () => {
  const p = rt.executeHandoff(cfg(), req());
  assert.equal(p.placement, 'queued');
  assert.equal(p.queueId, 'q_general');
  assert.equal('matchedRuleId' in p, false);
});

// ── 1번 사고: 오버플로 목적지 ────────────────────────────────────────────────
test('오버플로는 요청 큐가 아니라 실제 수용 큐를 목적지로 낸다', b, () => {
  // q_vip 는 maxWaiting 1 이고 이미 1명 대기 → q_general 로 오버플로.
  const p = rt.executeHandoff(cfg(), req({
    slots: { grade: 'vip' },
    snapshots: [snap('q_vip', 1, 2), snap('q_general', 0, 3)],
  }));
  assert.equal(p.placement, 'queued');
  assert.equal(p.overflowed, true);
  assert.equal(p.queueId, 'q_general', '실제 수용 큐여야 한다');
  assert.equal(p.requestedQueueId, 'q_vip');
  assert.ok(p.path.includes('q_vip') && p.path.includes('q_general'));
});

test('결과에는 놓을 수 있는 큐 id 가 queueId 하나뿐이다 — 요청 큐는 놓는 자리가 아니다', b, () => {
  // 원판정(admitToQueue)은 요청 큐를 `queueId` 라는 이름으로 들고 있다. 그 이름을 그대로
  // 목적지로 읽는 것이 이 모듈이 막는 사고이므로, 원판정과 결과가 실제로 다름을 고정한다.
  const raw = aq.admitToQueue(cfg(), 'q_vip', [snap('q_vip', 1, 2), snap('q_general', 0, 3)], NOW, {});
  assert.equal(raw.queueId, 'q_vip');            // 원판정이 들고 있는 "요청 큐"
  assert.equal(raw.admittedQueueId, 'q_general'); // 실제 목적지
  const p = rt.executeHandoff(cfg(), req({ slots: { grade: 'vip' }, snapshots: [snap('q_vip', 1, 2), snap('q_general', 0, 3)] }));
  assert.notEqual(p.queueId, raw.queueId);
  assert.equal(p.queueId, raw.admittedQueueId);
});

// ── 2번 사고: 수용 거부를 성공으로 읽기 ──────────────────────────────────────
test('영업시간 외는 큐가 아니라 대안이며 큐 id 를 들고 있지 않다', b, () => {
  const p = rt.executeHandoff(cfg(), req({ nowIso: NIGHT, snapshots: [snap('q_general', 0, 3, NIGHT)] }));
  assert.equal(p.placement, 'alternative');
  assert.equal(p.cause, 'closed');
  assert.equal(p.action, 'callback');
  assert.equal('queueId' in p, false, '대안 결과에 놓을 수 있는 큐 id 가 있으면 안 된다');
  assert.equal(rt.isQueued(p), false);
});

test('대안 행동은 큐 선언값이며 기본값을 만들지 않는다', b, () => {
  // q_dead: maxWaiting 0 · closedAction 'voicemail' · 오버플로 없음
  const p = rt.executeHandoff(cfg(), req({ intent: 'unstaffed' }));
  assert.equal(p.placement, 'alternative');
  assert.equal(p.action, 'voicemail', '큐가 선언한 대안을 그대로 써야 한다');
});

test('스냅샷이 없으면 열린 것으로 추정하지 않는다', b, () => {
  const p = rt.executeHandoff(cfg(), req({ snapshots: [] }));
  assert.equal(p.placement, 'alternative');
  assert.equal(p.cause, 'closed');
  assert.match(p.reasonKo, /상태 미확인/);
});

test('오래된 스냅샷은 신뢰하지 않는다 — 단 상한을 준 경우에만 검사한다(§13-3)', b, () => {
  const old = snap('q_general', 0, 3, '2026-03-02T00:00:00.000Z'); // 1시간 전
  const withLimit = rt.executeHandoff(cfg(), req({ snapshots: [old], admission: { staleAfterMs: 60_000 } }));
  assert.equal(withLimit.placement, 'alternative');
  const noLimit = rt.executeHandoff(cfg(), req({ snapshots: [old] }));
  assert.equal(noLimit.placement, 'queued', '상한을 주지 않으면 종전과 같아야 한다');
});

test('상담사 0명은 기본적으로 수용하지 않지만 테넌트가 선언하면 대기시킨다', b, () => {
  const none = [snap('q_general', 0, 0)];
  assert.equal(rt.executeHandoff(cfg(), req({ snapshots: none })).placement, 'alternative');
  const p = rt.executeHandoff(cfg(), req({ snapshots: none, admission: { admitWithNoAgents: true } }));
  assert.equal(p.placement, 'queued');
});

test('오버플로 순환은 통화 중 거절이 아니라 설정 오류로 먼저 걸린다', b, () => {
  const c = cfg({
    queues: [
      q('q_a', { maxWaiting: 0, overflowQueueId: 'q_b' }),
      q('q_b', { maxWaiting: 0, overflowQueueId: 'q_a' }),
    ],
    rules: [],
    defaultQueueId: 'q_a',
  });
  // 수용 판정만 부르면 통화 중에 '거절'로 나타난다 — 고객이 이미 기다린 뒤다.
  const raw = aq.admitToQueue(c, 'q_a', [snap('q_a', 0, 1), snap('q_b', 0, 1)], NOW, {});
  assert.equal(raw.status, 'rejected');
  // 실행기는 설정 검증을 먼저 지나므로 같은 결함이 운영 오류로 드러난다.
  const p = rt.executeHandoff(c, req({ snapshots: [snap('q_a', 0, 1), snap('q_b', 0, 1)] }));
  assert.equal(p.placement, 'unavailable');
  assert.equal(p.code, 'E_CONFIG_INVALID');
  assert.ok(p.issues.some((i) => /순환/.test(i)));
});

test('정의되지 않은 큐로의 수용 시도는 대안으로 끝난다', b, () => {
  // 규칙·기본큐 검증을 통과한 설정에서도 오버플로 대상이 없어질 수 있다 —
  // 이때도 거절 + 대안이지 큐 id 를 내주지 않는다.
  const c = cfg({
    queues: [q('q_only', { maxWaiting: 0, closedAction: 'legacy_ivr' })],
    rules: [],
    defaultQueueId: 'q_only',
  });
  const p = rt.executeHandoff(c, req({ snapshots: [snap('q_only', 0, 1)] }));
  assert.equal(p.placement, 'alternative');
  assert.equal(p.action, 'legacy_ivr');
  assert.equal('queueId' in p, false);
});

// ── 3번 사고: 격리 ───────────────────────────────────────────────────────────
test('다른 테넌트 설정으로는 이관하지 않는다 — 폴백이 아니라 던진다(§11.1)', b, () => {
  assert.throws(
    () => rt.executeHandoff(cfg({ tenantId: 't2' }), req()),
    /테넌트/,
  );
});

test('워크스페이스가 다르면 막는다 — selectQueue 는 이것을 보지 않는다(§11.1)', b, () => {
  const c = cfg({ queues: cfg().queues.map((x) => ({ ...x, workspaceId: 'w2' })), workspaceId: 'w2' });
  // 원함수는 통과시킨다는 사실 자체를 고정한다 — 이 모듈이 메우는 구멍이다.
  assert.doesNotThrow(() => aq.selectQueue(c, { scope, channel: 'voice', reason: 'max_retry' }));
  assert.throws(() => rt.executeHandoff(c, req()), /워크스페이스/);
});

test('스코프 형식 위반은 통과하지 않는다', b, () => {
  assert.throws(() => rt.executeHandoff(cfg(), req({ scope: { tenantId: '' } })));
});

// ── 설정 결함 ────────────────────────────────────────────────────────────────
test('설정이 깨졌으면 큐를 고르지 않고 unavailable 로 드러낸다', b, () => {
  const p = rt.executeHandoff(cfg({ defaultQueueId: 'q_없음' }), req());
  assert.equal(p.placement, 'unavailable');
  assert.equal(p.code, 'E_CONFIG_INVALID');
  assert.ok(p.issues.length > 0, '원인을 비워두면 운영에서 못 찾는다');
  assert.equal('queueId' in p, false);
  assert.equal('action' in p, false, '근거 없는 대안 행동을 만들면 안 된다(§13-3)');
});

test('시각 형식이 틀리면 영업 중으로 추정하지 않는다', b, () => {
  const p = rt.executeHandoff(cfg(), req({ nowIso: '어제' }));
  assert.equal(p.placement, 'unavailable');
  assert.equal(p.code, 'E_CLOCK_INVALID');
});

test('시간대 없는 시각은 거부한다 — 같은 문자열이 서버마다 다른 판정을 낸다', b, () => {
  // Date.parse 는 이것을 **성공**시키고 호스트 로컬 시간대로 해석한다.
  assert.equal(Number.isNaN(Date.parse('2026-03-02T10:00:00')), false);
  const p = rt.executeHandoff(cfg(), req({ nowIso: '2026-03-02T10:00:00' }));
  assert.equal(p.placement, 'unavailable');
  assert.equal(p.code, 'E_CLOCK_INVALID');
});

test('오프셋 표기(+09:00)는 Z 와 똑같이 받는다', b, () => {
  const p = rt.executeHandoff(cfg(), req({
    nowIso: '2026-03-02T10:00:00+09:00',
    snapshots: [snap('q_general', 0, 3, '2026-03-02T10:00:00+09:00')],
  }));
  assert.equal(p.placement, 'queued');
});

// ── 7번 사고: 스냅샷 ─────────────────────────────────────────────────────────
test('같은 큐의 어긋난 스냅샷 중 하나를 골라 쓰지 않는다', b, () => {
  // 배열 순서가 수용 판정을 정하는지 확인: 원함수는 나중 것을 쓴다.
  const raw = aq.admitToQueue(cfg(), 'q_general', [snap('q_general', 0, 3), snap('q_general', 99, 0)], NOW, {});
  assert.equal(raw.status, 'closed', '원함수는 마지막 스냅샷을 그대로 믿는다');

  const p = rt.executeHandoff(cfg(), req({ snapshots: [snap('q_general', 0, 3), snap('q_general', 99, 0)] }));
  assert.equal(p.placement, 'alternative');
  assert.match(p.reasonKo, /상태 미확인/);
  assert.ok(p.warnings.some((w) => /어긋나/.test(w)));
});

test('완전히 같은 스냅샷이 중복되는 것은 충돌이 아니다', b, () => {
  const p = rt.executeHandoff(cfg(), req({ snapshots: [snap('q_general', 0, 3), snap('q_general', 0, 3)] }));
  assert.equal(p.placement, 'queued');
  assert.deepEqual(p.warnings, []);
});

test('성립하지 않는 실측값은 보정하지 않고 버린다', b, () => {
  // waiting 이 NaN 이면 `waiting >= maxWaiting` 이 false 가 되어 꽉 찬 큐가 열린다.
  const bad = { queueId: 'q_general', waiting: Number.NaN, availableAgents: 3, observedAt: NOW };
  const p = rt.executeHandoff(cfg(), req({ snapshots: [bad] }));
  assert.equal(p.placement, 'alternative');
  assert.ok(p.warnings.some((w) => /성립하지 않아/.test(w)));
});

test('시간대 없는 관측 시각의 스냅샷도 버린다', b, () => {
  const p = rt.executeHandoff(cfg(), req({ snapshots: [snap('q_general', 0, 3, '2026-03-02T10:00:00')] }));
  assert.equal(p.placement, 'alternative');
  assert.ok(p.warnings.some((w) => /시간대가 없어/.test(w)));
});

test('미래 관측은 드러내되 임계값을 만들어 버리지는 않는다(§13-3)', b, () => {
  const p = rt.executeHandoff(cfg(), req({ snapshots: [snap('q_general', 0, 3, '2026-03-02T02:00:00.000Z')] }));
  assert.equal(p.placement, 'queued', '보정도 폐기도 하지 않는다');
  assert.ok(p.warnings.some((w) => /미래/.test(w)));
});

// ── 4번 사고: 요약 ───────────────────────────────────────────────────────────
test('받은 요약을 다시 마스킹하지 않는다 — maskPii 는 멱등이 아니다', async (t) => {
  if (!rt) return t.skip('타입 스트리핑 미지원 런타임');
  const { maskPii } = await import('../src/core/policyGuard.ts');
  const once = maskPii('주민번호 900101-1234567').text;
  const twice = maskPii(once).text;
  assert.notEqual(twice, once, '재적용이 값을 바꾼다는 전제 자체를 고정한다');

  const p = rt.executeHandoff(cfg(), req({ summaryMasked: once }));
  assert.equal(p.summaryMasked, once, '요약은 그대로 통과해야 한다');
});

test('요약이 없으면 이관은 하되 없다는 사실을 드러낸다(§2)', b, () => {
  const p = rt.executeHandoff(cfg(), req({ summaryMasked: undefined }));
  assert.equal(p.placement, 'queued', '요약이 없다고 고객을 봇에 붙잡아 두지 않는다');
  assert.equal(p.summaryPresent, false);
  assert.equal('summaryMasked' in p, false);
  assert.equal(p.warnings.length, 1);
});

test('빈 문자열 요약은 있는 것으로 세지 않는다', b, () => {
  const p = rt.executeHandoff(cfg(), req({ summaryMasked: '' }));
  assert.equal(p.summaryPresent, false);
});

// ── 5번 사고: 소진 경로 수렴 ─────────────────────────────────────────────────
test('재배정 소진은 큐 닫힘과 같은 모양으로 끝난다', b, () => {
  const p = rt.placementAfterExhausted(cfg(), { scope, queueId: 'q_dead', summaryMasked: '요약' });
  assert.equal(p.placement, 'alternative');
  assert.equal(p.cause, 'exhausted');
  assert.equal(p.action, 'voicemail');
  assert.equal(p.summaryPresent, true);
  const closed = rt.executeHandoff(cfg(), req({ nowIso: NIGHT, snapshots: [snap('q_general', 0, 3, NIGHT)] }));
  assert.deepEqual(Object.keys(p).sort(), Object.keys(closed).sort(), '두 경로의 결과 모양이 같아야 한다');
});

test('오퍼 상태기계의 exhausted 를 그대로 받아 대안까지 간다', b, () => {
  const offer = aq.offerAssignment({
    scope, offerId: 'o1', queueId: 'q_dead', interactionId: 'i1',
    agentId: 'a1', offeredAt: NOW, timeoutMs: 10_000, attempt: 2,
  });
  const out = aq.applyOfferEvent(offer, 'decline', NOW, 2);
  assert.equal(out.next, 'exhausted');
  const p = rt.placementAfterExhausted(cfg(), { scope, queueId: offer.queueId, reasonKo: out.reasonKo });
  assert.equal(p.cause, 'exhausted');
  assert.equal(p.action, 'voicemail');
});

test('설정에 없는 큐의 소진은 조용히 거절로 끝나지 않는다', b, () => {
  const p = rt.placementAfterExhausted(cfg(), { scope, queueId: 'q_오탈자' });
  assert.equal(p.action, 'reject');
  assert.ok(p.warnings.some((w) => /설정에 없는 큐/.test(w)));
});

test('소진 경로도 격리를 지킨다', b, () => {
  assert.throws(() => rt.placementAfterExhausted(cfg({ tenantId: 't2' }), { scope, queueId: 'q_general' }));
});

// ── 유출·집계 ────────────────────────────────────────────────────────────────
test('슬롯 값은 결과 어디에도 실리지 않는다(§10.3)', b, () => {
  const p = rt.executeHandoff(cfg(), req({ slots: { grade: 'vip', phone: '010-1234-5678' } }));
  assert.equal(JSON.stringify(p).includes('010-1234-5678'), false);
  assert.equal(JSON.stringify(p).includes('"phone"'), false);
});

test('이 모듈이 만든 문구는 마스킹을 거친다(§10.3)', b, () => {
  const c = cfg({ queues: [q('q_general', { titleKo: '고객 010-1234-5678 전용' })] , rules: [] });
  const p = rt.executeHandoff(c, req());
  assert.equal(p.reasonKo.includes('010-1234-5678'), false);
});

test('큐 상태를 엔진·백엔드 장애로 집계하지 않는다 — 폴백 모듈을 참조하지 않는다(§9.3)', b, () => {
  const src = readFileSync(SRC, 'utf8');
  for (const name of ['decideFallbackMode', 'HealthSample', 'ops/fallback', 'recordHealth']) {
    assert.equal(src.includes(name), false, `${name} 이 이 파일에 있으면 영업시간 외가 장애로 집계된다`);
  }
});

test('대안 행동 기본값을 코드에 두지 않는다(§13-3)', b, () => {
  const src = readFileSync(SRC, 'utf8');
  // 'reject' 는 exhaustedAction 의 규약을 통해서만 나와야 한다 — 이 파일에 리터럴로 없어야 한다.
  assert.equal(/['"]callback['"]|['"]voicemail['"]|['"]legacy_ivr['"]/.test(src), false);
});

test('계약 버전이 노출된다', b, () => {
  assert.equal(typeof rt.HANDOFF_EXECUTION_CONTRACT_VERSION, 'number');
});
