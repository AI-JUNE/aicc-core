import { test } from 'node:test';
import assert from 'node:assert/strict';

let h = null;
try {
  h = await import('../src/core/handoffSummary.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: h ? false : '타입 스트리핑 미지원 런타임' };

const NOW = () => '2026-01-02T00:05:00.000Z';

function interaction(over = {}) {
  return {
    id: 'i_1',
    tenantId: 'acme',
    startedAt: '2026-01-02T00:00:00.000Z',
    channels: ['voice'],
    turns: [
      { id: 't_1', at: '2026-01-02T00:00:10.000Z', channel: 'voice', speaker: 'bot', utterance: '무엇을 도와드릴까요?' },
      { id: 't_2', at: '2026-01-02T00:00:20.000Z', channel: 'voice', speaker: 'customer', utterance: '카드 재발급 하려고요', intent: 'card_reissue' },
      { id: 't_3', at: '2026-01-02T00:01:00.000Z', channel: 'voice', speaker: 'customer', utterance: '연락처는 010-1234-5678 입니다' },
    ],
    entities: { name: '홍길동', __goal_completed__: 'true', c1__confirmed: 'yes' },
    handoff: { at: '2026-01-02T00:01:42.000Z', reason: 'max_retry', toQueue: 'card_support' },
    ...over,
  };
}

test('§2 이관 요약은 사유·수집슬롯·미수집·직전대화를 구조화한다', behavioral, () => {
  const s = h.buildHandoffSummary(interaction(), {
    now: NOW,
    requiredSlots: ['name', 'birth'],
    slotLabels: { name: '이름', c1: '재발급 신청' },
  });
  assert.equal(s.interactionId, 'i_1');
  assert.equal(s.tenantId, 'acme');
  assert.equal(s.generator, 'rule');
  assert.equal(s.reason, 'max_retry');
  assert.equal(s.reasonLabelKo, '재시도 한도 초과');
  assert.equal(s.toQueue, 'card_support');
  assert.equal(s.turnCount, 3);
  assert.equal(s.generatedAt, NOW());

  // 내부 슬롯(__goal_completed__)은 상담사 요약에서 제외된다
  assert.deepEqual(s.collectedSlots.map(c => c.key), ['name', 'c1__confirmed']);
  assert.equal(s.collectedSlots[0].label, '이름');
  assert.equal(s.collectedSlots[1].label, '재발급 신청 확인');
  assert.equal(s.collectedSlots[1].value, '예');

  assert.deepEqual(s.pendingSlots, ['birth']);
  assert.equal(s.lastIntent, 'card_reissue');
  assert.equal(s.durationMs, 102000);      // startedAt → handoff.at 실측값
});

test('§10.3 요약 본문은 마스킹을 통과한 값만 담는다', behavioral, () => {
  const s = h.buildHandoffSummary(interaction({
    entities: { name: '홍길동', card: '1234-5678-9012-3456' },
  }), { now: NOW });

  assert.equal(s.piiMasked, true);
  // 규칙 우선순위 정정 후: 휴대폰 번호는 phone으로 분류된다(§8.1 pii_kinds 통계 정확도).
  assert.ok(s.piiKinds.includes('card'));
  assert.ok(s.piiKinds.includes('phone'));
  assert.ok(!s.piiKinds.includes('account'));
  assert.ok(!s.text.includes('010-1234-5678'), '원문 전화번호가 남으면 안 된다');
  assert.ok(!s.text.includes('5678-9012'), '원문 카드번호가 남으면 안 된다');
  assert.ok(s.text.includes('5678'), '상담사 식별용 뒷자리는 유지된다');
  const cardSlot = s.collectedSlots.find(c => c.key === 'card');
  assert.equal(cardSlot.masked, true);
  assert.ok(cardSlot.value.includes('****'));
});

test('hideSlotValues 슬롯은 값 자체가 노출되지 않는다', behavioral, () => {
  const s = h.buildHandoffSummary(interaction({ entities: { memo: '민감메모' } }), {
    now: NOW, hideSlotValues: ['memo'],
  });
  assert.equal(s.collectedSlots[0].value, '***');
  assert.ok(!s.text.includes('민감메모'));
});

test('recentTurns 창 크기·채널 전환 표시', behavioral, () => {
  const s = h.buildHandoffSummary(interaction({ channels: ['voice', 'visual'] }), { now: NOW, recentTurns: 2 });
  assert.equal(s.recentTurns.length, 2);
  assert.equal(s.recentTurns[0].speaker, 'customer');
  assert.equal(s.channelSwitched, true);
  assert.ok(s.text.includes('voice → visual'));
  assert.ok(s.text.includes('(전환 있음)'));

  const zero = h.buildHandoffSummary(interaction(), { now: NOW, recentTurns: 0 });
  assert.equal(zero.recentTurns.length, 0);
  assert.ok(zero.text.includes('직전 대화\n  - 없음'));
});

test('핸드오프 없는 Interaction·tenant 위반은 거부된다 (§2·§11.1)', behavioral, () => {
  assert.throws(() => h.buildHandoffSummary(interaction({ handoff: undefined })), /§2/);
  assert.throws(() => h.buildHandoffSummary(interaction({ tenantId: '' })), /§11.1/);
  assert.throws(() => h.attachHandoffSummary(interaction({ handoff: undefined }), { text: 'x' }), /§2/);
});

test('attachHandoffSummary는 마스킹된 요약을 Interaction에 부착한다', behavioral, () => {
  const i = interaction();
  const s = h.buildHandoffSummary(i, { now: NOW });
  h.attachHandoffSummary(i, s);
  assert.equal(i.handoff.summary, s.text);
  assert.ok(!i.handoff.summary.includes('010-1234-5678'));
});

test('requiredSlotsOf는 Flow의 Collect 슬롯만 뽑는다 (§5.3)', behavioral, () => {
  const flow = {
    id: 'f', version: 1, startNodeId: 'a',
    nodes: {
      a: { id: 'a', kind: 'Collect', slot: 'name', prompt: '성함?', next: 'b' },
      b: { id: 'b', kind: 'Collect', slot: 'birth', prompt: '생년월일?', next: 'c' },
      c: { id: 'c', kind: 'Say', text: '감사합니다' },
    },
  };
  assert.deepEqual(h.requiredSlotsOf(flow), ['name', 'birth']);
});

test('formatDuration은 실측 경과시간만 표기한다', behavioral, () => {
  assert.equal(h.formatDuration(0), '0초');
  assert.equal(h.formatDuration(42000), '42초');
  assert.equal(h.formatDuration(102000), '1분 42초');
  assert.equal(h.formatDuration(3723000), '1시간 2분 3초');
});

test('[승인 필요] LLM 추상 요약은 승인 전까지 실행되지 않는다', behavioral, async () => {
  const s = h.buildHandoffSummary(interaction(), { now: NOW });
  await assert.rejects(
    () => h.buildAbstractiveSummary(s, { name: 'stub', summarize: async () => 'x' }),
    /\[승인 필요\]/,
  );
});
