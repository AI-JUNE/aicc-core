import { test } from 'node:test';
import assert from 'node:assert/strict';

let fb = null;
try { fb = await import('../src/ops/fallback.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: fb ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-03-01T00:00:00.000Z';
const s = (component, state, at = NOW) => ({ component, state, observedAt: at });
const policy = (over = {}) => ({
  tenantId: 't1', staleAfterMs: 60_000, treatUnknownAsDown: false,
  legacyIvrAvailable: false, agentQueueAvailable: true, fallbackQueue: 'q_general', ...over,
});
const reg = (samples) => fb.createHealthRegistry(samples);

test('모두 정상이면 normal, 끄는 기능 없음', b, () => {
  const r = fb.decideFallbackMode('voice', reg([
    s('telephony', 'up'), s('stt', 'up'), s('tts', 'up'), s('llm', 'up'), s('rag', 'up'), s('backend', 'up'),
  ]), policy(), NOW);
  assert.equal(r.mode, 'normal');
  assert.deepEqual(r.disable, []);
  assert.ok(fb.aiResponseAllowed(r));
});

test('§9.3 L1 매체 장애는 unavailable — Core가 손 쓸 수 없다', b, () => {
  const r = fb.decideFallbackMode('voice', reg([s('telephony', 'down'), s('llm', 'up')]), policy({ legacyIvrAvailable: true }), NOW);
  assert.equal(r.mode, 'unavailable');
  assert.equal(fb.resolveRuntimeAction(r, 'none'), 'abort');
});

test('§9.3 L2 인지 장애 — 기존 IVR 있으면 legacy_ivr', b, () => {
  const r = fb.decideFallbackMode('voice', reg([
    s('telephony', 'up'), s('stt', 'up'), s('tts', 'up'), s('llm', 'down'),
  ]), policy({ legacyIvrAvailable: true }), NOW);
  assert.equal(r.mode, 'legacy_ivr');
  assert.ok(!fb.aiResponseAllowed(r));
  assert.equal(fb.resolveRuntimeAction(r, 'retry'), 'route_legacy_ivr');
});

test('§9.3 L2 장애 — 기존 IVR 없으면 상담사 직결', b, () => {
  const r = fb.decideFallbackMode('voice', reg([s('telephony', 'up'), s('stt', 'down')]), policy(), NOW);
  assert.equal(r.mode, 'agent_only');
  assert.equal(r.transferTo, 'q_general');
  assert.equal(fb.resolveRuntimeAction(r, 'retry'), 'handoff_agent');
});

test('상담사·IVR 모두 불가해도 조용히 끊지 않고 사유를 남긴다', b, () => {
  const r = fb.decideFallbackMode('voice', reg([s('telephony', 'up'), s('llm', 'down')]), policy({ agentQueueAvailable: false }), NOW);
  assert.equal(r.mode, 'agent_only');
  assert.match(r.reasonKo, /가용하지 않습니다/);
});

test('§5.2 L3 지식 장애는 근거 검색만 끄고 시나리오는 유지한다', b, () => {
  const r = fb.decideFallbackMode('chat', reg([s('messaging', 'up'), s('llm', 'up'), s('rag', 'down'), s('backend', 'up')]), policy(), NOW);
  assert.equal(r.mode, 'degraded_ai');
  assert.deepEqual(r.disable, ['knowledge_grounding']);
  assert.ok(fb.aiResponseAllowed(r));
});

test('TTS 저하는 합성만 끈다', b, () => {
  const r = fb.decideFallbackMode('voice', reg([
    s('telephony', 'up'), s('stt', 'up'), s('tts', 'degraded'), s('llm', 'up'), s('rag', 'up'), s('backend', 'up'),
  ]), policy(), NOW);
  assert.equal(r.mode, 'degraded_ai');
  assert.deepEqual(r.disable, ['voice_synthesis']);
});

test('채팅은 STT 장애에 영향을 받지 않는다(오탐 방지)', b, () => {
  const r = fb.decideFallbackMode('chat', reg([s('messaging', 'up'), s('llm', 'up'), s('rag', 'up'), s('backend', 'up'), s('stt', 'down')]), policy(), NOW);
  assert.equal(r.mode, 'normal');
});

test('오래된 샘플은 up 으로 믿지 않는다 — 보수 정책이면 장애로 본다', b, () => {
  const old = '2026-02-28T23:00:00.000Z';
  const samples = [s('telephony', 'up'), s('stt', 'up', old), s('tts', 'up'), s('llm', 'up'), s('rag', 'up'), s('backend', 'up')];
  const lenient = fb.decideFallbackMode('voice', reg(samples), policy(), NOW);
  assert.equal(lenient.mode, 'normal');
  assert.ok(lenient.causes.some((c) => c.component === 'stt'));
  const strict = fb.decideFallbackMode('voice', reg(samples), policy({ treatUnknownAsDown: true }), NOW);
  assert.equal(strict.mode, 'agent_only');
});

test('늦게 도착한 과거 샘플이 최신 상태를 덮지 않는다', b, () => {
  const r = fb.createHealthRegistry([s('llm', 'down', NOW)]);
  r.record(s('llm', 'up', '2026-02-28T00:00:00.000Z'));
  assert.equal(r.latest('llm').state, 'down');
});

// ── 도착 순서는 순간(ms)으로 비교한다(2026-11-03) ─────────────────────────────
// `observedAt` 은 호스트·프로브가 선언하는 값이므로(§13-3) 같은 순간이 여러 문자열로 적힌다.
// 사전식 비교는 `+09:00` 오프셋을 `Z` 보다 크게 읽어 **그 뒤의 모든 샘플**을 과거로 버렸다.
test('§9.3 오프셋이 다른 시각 표기에도 나중 샘플이 이긴다 — 사전식 비교는 컴포넌트를 동결시킨다', b, () => {
  const r = fb.createHealthRegistry([]);
  r.record(s('llm', 'up', '2026-03-01T09:00:00+09:00'));      // = 00:00Z
  r.record(s('llm', 'down', '2026-03-01T00:10:00.000Z'));     // 10분 뒤 — 사전식으로는 '과거'
  assert.equal(r.latest('llm').state, 'down', '나중 샘플이 과거로 버려졌다(그 컴포넌트는 동결된다)');
  const d = fb.decideFallbackMode('voice', r, policy({ legacyIvrAvailable: true }), '2026-03-01T00:11:00.000Z');
  assert.equal(d.mode, 'legacy_ivr', '죽은 엔진이 정상으로 읽혔다(§9.3)');
});

test('§9.3 과거 샘플은 오프셋 표기가 섞여도 최신을 덮지 않는다(반대 방향)', b, () => {
  const r = fb.createHealthRegistry([s('llm', 'down', '2026-03-01T00:10:00.000Z')]);
  r.record(s('llm', 'up', '2026-03-01T09:00:00+09:00'));      // = 00:00Z — 10분 전
  assert.equal(r.latest('llm').state, 'down');
});

test('§9.3 순서를 판정할 수 없는 시각은 컴포넌트를 동결시키지 않는다', b, () => {
  const r = fb.createHealthRegistry([]);
  r.record(s('llm', 'up', '방금'));                           // 해석 불가 — 그래도 적힌다
  assert.equal(r.latest('llm').observedAt, '방금');
  // 핵심: 다음 샘플이 들어올 길이 막히지 않는다(사전식 비교에서는 '방금' 이 전부를 이겼다).
  r.record(s('llm', 'down', NOW));
  assert.equal(r.latest('llm').state, 'down');
  // 그리고 해석 불가 시각은 up 으로 읽히지 않는다 — 낡음을 판정할 수 없으므로 unknown 이다.
  const only = fb.createHealthRegistry([s('llm', 'up', '방금')]);
  assert.equal(fb.effectiveComponentState(only.latest('llm'), policy(), NOW), 'unknown');
});

// ── 헬스 샘플 모양 판정은 한 곳이다(§2) ──────────────────────────────────────
test('§9.3 healthSampleDefect — 쓸 수 있는 샘플은 통과한다', b, () => {
  assert.equal(fb.healthSampleDefect(s('llm', 'up')), undefined);
  assert.equal(fb.healthSampleDefect({ ...s('llm', 'degraded'), errorRate: 0, latencyMs: 12, detail: '지연' }), undefined);
  // 아는 컴포넌트인지는 묻지 않는다 — 그 거름은 채널 등록 선언이 한다(§9.3).
  assert.equal(fb.healthSampleDefect(s('모르는것', 'up')), undefined);
  for (const state of fb.HEALTH_STATES) assert.equal(fb.healthSampleDefect(s('llm', state)), undefined);
});

test('§9.3 healthSampleDefect — 실측으로 볼 수 없는 값은 사유를 돌려준다', b, () => {
  const bad = [
    [undefined, '객체'], [null, '객체'], ['llm', '객체'], [[], '객체'],
    [{ state: 'up', observedAt: NOW }, 'component'],
    [{ component: '  ', state: 'up', observedAt: NOW }, 'component'],
    [s('llm', 'UP'), 'state'],              // 오타 하나가 죽은 엔진을 정상으로 만든다
    [s('llm', undefined), 'state'],
    [s('llm', 'up', '방금'), 'observedAt'],
    [s('llm', 'up', ''), 'observedAt'],
    [{ ...s('llm', 'up'), errorRate: Number.NaN }, 'errorRate'],
    [{ ...s('llm', 'up'), errorRate: -0.1 }, 'errorRate'],
    [{ ...s('llm', 'up'), latencyMs: Number.POSITIVE_INFINITY }, 'latencyMs'],
    [{ ...s('llm', 'up'), detail: 7 }, 'detail'],
  ];
  for (const [value, needle] of bad) {
    const why = fb.healthSampleDefect(value);
    assert.equal(typeof why, 'string', `통과시켰다: ${JSON.stringify(value)}`);
    assert.ok(why.includes(needle), `${needle} 사유가 아니다: ${why}`);
  }
});

test('§9.3 모르는 상태는 폴백 판정에서 정상으로 읽힌다 — 그래서 경계에서 걸러야 한다', b, () => {
  // 이 검사는 `healthSampleDefect` 가 **왜** 필요한지를 고정한다: 레지스트리에 한 번 들어가면
  // `isBad`·`degraded`·`unknown` 어디에도 걸리지 않아 죽은 엔진이 `normal` 로 보고된다.
  const r = fb.createHealthRegistry([
    s('telephony', 'up'), s('stt', 'up'), s('tts', 'up'), s('llm', 'UP'), s('rag', 'up'), s('backend', 'up'),
  ]);
  assert.equal(fb.decideFallbackMode('voice', r, policy({ legacyIvrAvailable: true }), NOW).mode, 'normal');
  assert.equal(fb.isHealthState('UP'), false);
});

test('§5.1 대화 폴백은 정상 상태에서만 그대로 반영된다', b, () => {
  const ok = fb.decideFallbackMode('voice', reg([
    s('telephony', 'up'), s('stt', 'up'), s('tts', 'up'), s('llm', 'up'), s('rag', 'up'), s('backend', 'up'),
  ]), policy(), NOW);
  assert.equal(fb.resolveRuntimeAction(ok, 'none'), 'continue_ai');
  assert.equal(fb.resolveRuntimeAction(ok, 'switch_to_visual'), 'switch_to_visual');
  assert.equal(fb.resolveRuntimeAction(ok, 'handoff_agent'), 'handoff_agent');
});
