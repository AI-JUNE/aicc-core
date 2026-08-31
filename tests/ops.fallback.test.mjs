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

test('§5.1 대화 폴백은 정상 상태에서만 그대로 반영된다', b, () => {
  const ok = fb.decideFallbackMode('voice', reg([
    s('telephony', 'up'), s('stt', 'up'), s('tts', 'up'), s('llm', 'up'), s('rag', 'up'), s('backend', 'up'),
  ]), policy(), NOW);
  assert.equal(fb.resolveRuntimeAction(ok, 'none'), 'continue_ai');
  assert.equal(fb.resolveRuntimeAction(ok, 'switch_to_visual'), 'switch_to_visual');
  assert.equal(fb.resolveRuntimeAction(ok, 'handoff_agent'), 'handoff_agent');
});
