// 과금 근거의 턴 귀속 — §11.2. 여기서 막는 사고는 전부 예외가 아니라 청구 직전에 드러나는 조용한 오답이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let TU = null, EV = null, BL = null;
try {
  TU = await import('../src/billing/turnUsage.ts');
  EV = await import('../src/events/schema.ts');
  BL = await import('../src/billing/usage.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: TU ? false : '타입 스트리핑 미지원 런타임' };

const meta = (id, over = {}) => ({
  eventId: id, occurredAt: '2026-01-05T09:00:00.000Z',
  tenantId: 't1', interactionId: 'i1', channel: 'voice', ...over,
});
const customerTurn = (id, over = {}) =>
  EV.turnCompleted(meta(id), { turnId: id, speaker: 'customer', utterance: '요금 알려주세요', ...over });
const botTurn = (id) =>
  EV.turnCompleted(meta(id), { turnId: id, speaker: 'bot', utterance: '안내드립니다' });

// ── mergeTurnUsage ──────────────────────────────────────────────────────────

test('§11.2 한 출처의 실측은 그대로 통과한다', b, () => {
  const m = TU.mergeTurnUsage([{ origin: 'channel', usage: { llm_prompt_tokens: 120, stt_audio_ms: 2500 } }]);
  assert.deepEqual(m.usage, { llm_prompt_tokens: 120, stt_audio_ms: 2500 });
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual(m.rejected, []);
});

test('§13-3 선언이 없으면 usage 를 만들지 않는다 — 빈 객체는 "0 을 실측했다"로 읽힌다', b, () => {
  assert.equal(TU.mergeTurnUsage([]).usage, undefined);
  assert.equal(TU.mergeTurnUsage([{ origin: 'channel', usage: undefined }]).usage, undefined);
  assert.equal(TU.mergeTurnUsage([{ origin: 'channel', usage: {} }]).usage, undefined);
  // 전부 거부된 경우에도 usage 를 만들지 않는다(0 으로 메우지 않는다).
  const m = TU.mergeTurnUsage([{ origin: 'channel', usage: { llm_prompt_tokens: -1 } }]);
  assert.equal(m.usage, undefined);
  assert.equal(m.rejected.length, 1);
});

test('§11.2 NaN·무한·음수·숫자 아님은 실측이 아니므로 버리고 드러낸다', b, () => {
  const m = TU.mergeTurnUsage([{
    origin: 'channel',
    usage: { llm_prompt_tokens: NaN, llm_completion_tokens: Infinity, stt_audio_ms: -1, tts_audio_ms: '3000' },
  }]);
  assert.equal(m.usage, undefined);
  assert.deepEqual(m.rejected.map((r) => r.key).sort(), ['llm_completion_tokens', 'llm_prompt_tokens', 'stt_audio_ms', 'tts_audio_ms']);
  assert.equal(m.rejected.every((r) => r.origin === 'channel'), true);
});

test('§11.2 NaN 이 그대로 집계에 들어가면 그 달의 모든 수량이 NaN 이 된다 — 거부가 맞다', b, () => {
  // 결함을 그대로 재현한다: 검증을 거치지 않은 값이 이벤트에 실리면 합계가 무너진다.
  const poisoned = customerTurn('e1', { usage: { llm_prompt_tokens: NaN } });
  const raw = BL.aggregateUsage([poisoned], { scope: { tenantId: 't1' }, granularity: 'total', rounding: { unitSeconds: 60, mode: 'ceil', minimumUnits: 0 } });
  // 집계기도 마지막 방어선에서 같은 값을 거부한다(0 으로도 그대로도 적지 않는다).
  assert.equal(raw.buckets[0].usageValuesRejected, 1);
  assert.equal(Number.isNaN(BL.totalQuantities(raw).llm_prompt_tokens), false);
  // 그리고 애초에 이벤트에 실리지 않아야 한다.
  const m = TU.mergeTurnUsage([{ origin: 'channel', usage: { llm_prompt_tokens: NaN } }]);
  assert.equal(m.usage, undefined);
});

test('§11.2 알 수 없는 사용량 항목은 통과시키지 않는다 — 정체불명 필드가 과금 집계에 쌓인다', b, () => {
  const m = TU.mergeTurnUsage([{ origin: 'channel', usage: { gpu_seconds: 10, llm_prompt_tokens: 5 } }]);
  assert.deepEqual(m.usage, { llm_prompt_tokens: 5 });
  assert.deepEqual(m.rejected.map((r) => r.key), ['gpu_seconds']);
});

test('§6.2 토큰 수가 소수면 단위 환산 오류의 신호이므로 거부한다', b, () => {
  const m = TU.mergeTurnUsage([{ origin: 'channel', usage: { llm_prompt_tokens: 12.5, stt_audio_ms: 2500.5 } }]);
  assert.deepEqual(m.usage, { stt_audio_ms: 2500.5 });   // ms 는 소수가 실측일 수 있다
  assert.deepEqual(m.rejected.map((r) => r.key), ['llm_prompt_tokens']);
});

test('§11.2 같은 항목을 두 출처가 내면 합산하지 않고 드러낸다 — 합산은 곧 과다청구다', b, () => {
  const m = TU.mergeTurnUsage([
    { origin: 'channel', usage: { stt_audio_ms: 2000, llm_prompt_tokens: 10 } },
    { origin: 'engine_set', usage: { stt_audio_ms: 2000 } },
  ]);
  assert.deepEqual(m.usage, { llm_prompt_tokens: 10 });          // 충돌 키는 빠진다
  assert.deepEqual(m.conflicts, [{ key: 'stt_audio_ms', origins: ['channel', 'engine_set'] }]);
});

test('사용량이 객체가 아니면 전체를 거부한다', b, () => {
  const m = TU.mergeTurnUsage([{ origin: 'channel', usage: [1, 2, 3] }]);
  assert.equal(m.usage, undefined);
  assert.deepEqual(m.rejected, [{ key: '(전체)', origin: 'channel', reasonKo: '사용량이 객체가 아닙니다.' }]);
});

// ── attachTurnUsage ─────────────────────────────────────────────────────────

test('§11.2 실측은 마지막 고객 발화 이벤트에 붙는다(봇 발화에 붙지 않는다)', b, () => {
  const events = [customerTurn('e1'), botTurn('e2')];
  const r = TU.attachTurnUsage(events, { llm_prompt_tokens: 7 });
  assert.equal(r.attached, true);
  assert.equal(r.turnId, 'e1');
  assert.deepEqual(events[0].usage, { llm_prompt_tokens: 7 });
  assert.equal(events[1].usage, undefined);
});

test('실을 자리가 없으면 조용히 버리지 않고 사유를 돌려준다', b, () => {
  const events = [botTurn('e1'), EV.sessionEnded(meta('e2'), { outcome: 'TRANSFERRED', turnCount: 1 })];
  const r = TU.attachTurnUsage(events, { llm_prompt_tokens: 7 });
  assert.equal(r.attached, false);
  assert.match(r.reasonKo, /과금 집계에 들어가지 않습니다/);
  assert.equal(events.some((e) => e.usage !== undefined), false);
});

test('빈 이벤트 배열도 던지지 않고 사유로 끝난다', b, () => {
  const r = TU.attachTurnUsage([], { llm_prompt_tokens: 1 });
  assert.equal(r.attached, false);
  assert.ok(r.reasonKo);
});

test('이미 사용량이 실린 턴은 덮어쓰지 않는다 — 덮어쓰면 먼저 실린 실측이 사라진다', b, () => {
  const events = [customerTurn('e1', { usage: { llm_prompt_tokens: 100 } })];
  const r = TU.attachTurnUsage(events, { llm_prompt_tokens: 7 });
  assert.equal(r.attached, false);
  assert.equal(r.turnId, 'e1');
  assert.deepEqual(events[0].usage, { llm_prompt_tokens: 100 });
});

// ── checkBillableMs ─────────────────────────────────────────────────────────

test('§11.2 통화 과금 구간은 0 을 포함한 유한·음이 아닌 수만 통과한다', b, () => {
  assert.deepEqual(TU.checkBillableMs(65000), { ok: true, billableMs: 65000 });
  assert.deepEqual(TU.checkBillableMs(0), { ok: true, billableMs: 0 });   // 즉시 끊긴 호는 실제로 0 이다
  assert.equal(TU.checkBillableMs(-1).ok, false);
  assert.equal(TU.checkBillableMs(NaN).ok, false);
  assert.equal(TU.checkBillableMs(Infinity).ok, false);
  assert.equal(TU.checkBillableMs('65000').ok, false);
  assert.equal(TU.checkBillableMs(null).ok, false);
  assert.equal(TU.checkBillableMs(undefined).ok, false);
});

test('검증 실패는 예외가 아니라 사유다 — 종료를 막으면 세션이 샌다', b, () => {
  const r = TU.checkBillableMs(-5);
  assert.equal(r.ok, false);
  assert.match(r.reasonKo, /음수/);
});

// ── usageNote ───────────────────────────────────────────────────────────────

test('기록은 사실만 적고 비어 있으면 만들지 않는다(§13-3)', b, () => {
  assert.equal(TU.billingNoteOrUndefined({}), undefined);
  const merged = TU.mergeTurnUsage([
    { origin: 'channel', usage: { stt_audio_ms: 1, gpu_seconds: 2 } },
    { origin: 'engine_set', usage: { stt_audio_ms: 1 } },
  ]);
  const note = TU.usageNote(merged, { attached: false, reasonKo: '자리가 없습니다.' });
  assert.equal(note.usageAttached, false);
  assert.equal(note.usageReasonKo, '자리가 없습니다.');
  assert.deepEqual(note.usageConflicts, ['stt_audio_ms']);
  assert.deepEqual(note.usageRejected, ['channel.gpu_seconds']);
  assert.ok(TU.billingNoteOrUndefined(note));
});

test('붙이기를 시도하지 않았으면 usageAttached 를 만들지 않는다', b, () => {
  const note = TU.usageNote(TU.mergeTurnUsage([{ origin: 'channel', usage: { stt_audio_ms: 1 } }]));
  assert.equal('usageAttached' in note, false);
});

// ── 경계: 실제 집계까지 통과시킨다 ──────────────────────────────────────────

test('§11.2 경계: 붙인 실측이 aggregateUsage 수량으로 그대로 이어진다', b, () => {
  const events = [customerTurn('e1'), botTurn('e2')];
  const merged = TU.mergeTurnUsage([{ origin: 'channel', usage: { llm_prompt_tokens: 120, llm_completion_tokens: 30, stt_audio_ms: 2000, tts_audio_ms: 3000 } }]);
  assert.equal(TU.attachTurnUsage(events, merged.usage).attached, true);
  const agg = BL.aggregateUsage(events, {
    scope: { tenantId: 't1' }, granularity: 'total',
    rounding: { unitSeconds: 60, mode: 'ceil', minimumUnits: 0 },
  });
  const t = BL.totalQuantities(agg);
  assert.equal(t.llm_prompt_tokens, 120);
  assert.equal(t.llm_completion_tokens, 30);
  assert.equal(t.stt_seconds, 2);
  assert.equal(t.tts_seconds, 3);
  assert.equal(agg.buckets[0].turnsMissingUsage, 1);   // 봇 발화는 실측이 없다 — 0 으로 세지 않는다
  assert.equal(agg.buckets[0].usageValuesRejected, 0);
});
