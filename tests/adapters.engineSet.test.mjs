// 엔진셋 조립 — §6.2·§10.3·§11.2·§13-3.
// 네트워크는 절대 쓰지 않는다. 실제 벤더 어댑터를 쓰는 검사도 전부 dry_run 이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let res = null;
let audio = null;
let compat = null;
try {
  m = await import('../src/adapters/engineSet.ts');
  res = await import('../src/adapters/resilience.ts');
  audio = await import('../src/adapters/openaiAudio.ts');
  compat = await import('../src/adapters/openaiCompat.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

// ── 가짜 어댑터(형태만 맞춘다 — 어느 것도 호출되지 않는다) ────────────────────
const ad = (name, residency = 'onprem') => ({ name, residency });
const sttAd = (name, r) => ({ ...ad(name, r), stream: async function* () { /* 부르지 않는다 */ } });
const ttsAd = (name, r) => ({ ...ad(name, r), synthesize: async function* () { /* 부르지 않는다 */ } });
const llmAd = (name, r) => ({ ...ad(name, r), complete: async function* () { /* 부르지 않는다 */ } });
const embAd = (name, r) => ({ ...ad(name, r), embed: async () => [[0]] });

/** 음성 규격 조각(stt·tts)과 텍스트 규격 조각(llm·embedding) — 현실의 분할 그대로. */
function voicePart(over = {}) {
  return {
    source: 'openai-audio',
    engines: { activation: 'dry_run', stt: sttAd('whisper-ko'), tts: ttsAd('tts-ko-1'), ...over },
  };
}
function textPart(over = {}) {
  return {
    source: 'openai-compat',
    engines: { activation: 'dry_run', llm: llmAd('sllm-7b'), ...over },
  };
}

function assertConfigError(fn, needle) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, 'E_CONFIG', `E_CONFIG 가 아니라 ${e.code ?? e.message}`);
    assert.ok(String(e.message).includes(needle), `메시지에 "${needle}" 가 없다: ${e.message}`);
    return e;
  }
  assert.fail('거절해야 하는 설정이 통과했다');
}

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('두 벤더 조각이 §6.2 EngineSet 하나로 묶인다 — 슬롯 출처가 그대로 남는다', b, () => {
  const a = m.assembleEngineSet({ parts: [voicePart(), textPart()], allowOverseas: false });
  assert.equal(a.engines.stt.name, 'whisper-ko');
  assert.equal(a.engines.tts.name, 'tts-ko-1');
  assert.equal(a.engines.llm.name, 'sllm-7b');
  assert.equal(a.engines.embedding, undefined, 'RAG 를 선언하지 않았는데 임베딩이 생겼다');
  assert.equal(a.activation, 'dry_run');
  assert.deepEqual(a.sources, ['openai-audio', 'openai-compat']);
  assert.deepEqual(
    a.origins.map((o) => `${o.slot}:${o.source}`),
    ['stt:openai-audio', 'tts:openai-audio', 'llm:openai-compat'],
  );
});

test('embedding 은 있으면 싣고 없으면 요구하지 않는다 — RAG 를 전제하지 않는다(§6.2)', b, () => {
  const a = m.assembleEngineSet({
    parts: [voicePart(), textPart({ embedding: embAd('embed-v1') })], allowOverseas: false,
  });
  assert.equal(a.engines.embedding.name, 'embed-v1');
  assert.ok(a.origins.some((o) => o.slot === 'embedding'));
});

test('RAG 테넌트로 선언하면 embedding 누락을 조립 시점에 거절한다', b, () => {
  assertConfigError(
    () => m.assembleEngineSet({ parts: [voicePart(), textPart()], allowOverseas: false, requireEmbedding: true }),
    'embedding 슬롯이 비어 있다',
  );
  // 선언하고 채우면 통과한다(거절이 영구 차단이 되지 않게 확인).
  const ok = m.assembleEngineSet({
    parts: [voicePart(), textPart({ embedding: embAd('embed-v1') })], allowOverseas: false, requireEmbedding: true,
  });
  assert.ok(ok.engines.embedding);
});

// ── 실패 경로: 설정 실수는 통화 중이 아니라 조립 시점에 터져야 한다 ──────────

test('모델 id 미설정으로 슬롯이 빈 채 오면 거절한다 — `!` 로 통화 중까지 미루지 않는다', b, () => {
  // sttModel 을 안 준 음성 어댑터가 바로 이 모양이다(stt 가 undefined).
  const e = assertConfigError(
    () => m.assembleEngineSet({ parts: [voicePart({ stt: undefined }), textPart()], allowOverseas: false }),
    '필수 엔진 슬롯이 비어 있다: stt',
  );
  assert.ok(e.message.includes('openai-audio'), '어느 조각에서 빠졌는지 적히지 않았다');
  assert.ok(e.message.includes('tts'), '확보한 슬롯을 적지 않으면 무엇이 문제인지 안 보인다');
});

test('빈 조각·이름 없는 조각·중복 이름·활성화 미선언을 모두 거절한다', b, () => {
  assertConfigError(() => m.assembleEngineSet({ parts: [], allowOverseas: false }), '엔진 조각이 비어 있다');
  assertConfigError(
    () => m.assembleEngineSet({ parts: [{ source: '  ', engines: voicePart().engines }], allowOverseas: false }),
    'source 이름이 없다',
  );
  assertConfigError(
    () => m.assembleEngineSet({ parts: [voicePart(), { ...textPart(), source: 'openai-audio' }], allowOverseas: false }),
    '엔진 조각 이름이 중복된다',
  );
  assertConfigError(
    () => m.assembleEngineSet({ parts: [voicePart(), { source: 'x', engines: { llm: llmAd('a') } }], allowOverseas: false }),
    'activation 이 선언되지 않았다',
  );
});

test('한 슬롯을 두 조각이 채우면 자동으로 고르지 않고 거절한다', b, () => {
  const e = assertConfigError(
    () => m.assembleEngineSet({
      parts: [voicePart(), textPart({ llm: llmAd('sllm-7b') }), { source: 'backup', engines: { activation: 'dry_run', llm: llmAd('other-llm') } }],
      allowOverseas: false,
    }),
    'llm 슬롯을 여러 조각이 채우고 있다',
  );
  assert.ok(e.message.includes('openai-compat') && e.message.includes('backup'));
});

test('활성화가 섞이면 거절한다 — 반쪽 통화는 §9.3 에서 장애로도 잡히지 않는다', b, () => {
  const e = assertConfigError(
    () => m.assembleEngineSet({
      parts: [voicePart({ activation: 'live' }), textPart()], allowOverseas: false,
    }),
    '활성화가 섞여 있다',
  );
  assert.ok(e.message.includes('openai-audio=live') && e.message.includes('openai-compat=dry_run'));
  assert.ok(e.message.includes('[승인 필요]'));
});

test('residency·name 을 선언하지 않은 어댑터는 통과시키지 않는다(§10.3)', b, () => {
  assertConfigError(
    () => m.assembleEngineSet({ parts: [voicePart({ stt: { name: 'x', stream: () => {} } }), textPart()], allowOverseas: false }),
    'residency 를 선언하지 않았다',
  );
  assertConfigError(
    () => m.assembleEngineSet({ parts: [voicePart({ tts: { name: '', residency: 'onprem' } }), textPart()], allowOverseas: false }),
    'name 을 선언하지 않았다',
  );
});

// ── §10.3 국외이전 ───────────────────────────────────────────────────────────

test('국외이전 불가 테넌트는 해외 슬롯이 하나만 섞여도 조립을 거절한다', b, () => {
  const e = assertConfigError(
    () => m.assembleEngineSet({
      parts: [voicePart(), textPart({ llm: llmAd('foreign-llm', 'overseas') })], allowOverseas: false,
    }),
    '해외 엔진이 섞여 있다',
  );
  assert.ok(e.message.includes('llm(openai-compat)'), '어느 슬롯이 해외인지 적히지 않았다');
});

test('허용한 경우에도 residency 는 가장 노출도가 높은 슬롯으로 적는다 — 섞어 놓고 온프렘으로 적지 않는다', b, () => {
  const mixed = m.assembleEngineSet({
    parts: [voicePart(), textPart({ llm: llmAd('foreign-llm', 'overseas') })], allowOverseas: true,
  });
  assert.equal(mixed.residency, 'overseas');

  const domestic = m.assembleEngineSet({
    parts: [voicePart(), textPart({ llm: llmAd('kr-llm', 'domestic') })], allowOverseas: false,
  });
  assert.equal(domestic.residency, 'domestic', '온프렘+국내는 국내로 적어야 한다');

  const onprem = m.assembleEngineSet({ parts: [voicePart(), textPart()], allowOverseas: false });
  assert.equal(onprem.residency, 'onprem');
});

test('조립한 셋은 assertResidency 를 그대로 통과·거절한다(가드가 비껴가지 않는다)', b, async () => {
  const idx = await import('../src/adapters/index.ts');
  const mixed = m.assembleEngineSet({
    parts: [voicePart(), textPart({ llm: llmAd('foreign-llm', 'overseas') })], allowOverseas: true,
  });
  assert.throws(() => idx.assertResidency(mixed.engines, false), /국외이전/);
  const clean = m.assembleEngineSet({ parts: [voicePart(), textPart()], allowOverseas: false });
  idx.assertResidency(clean.engines, false);   // 던지지 않아야 한다
});

// ── §11.2 사용량 수집 ────────────────────────────────────────────────────────

test('조각들의 실측 사용량을 합친다 — 아무도 주지 않으면 undefined(빈 객체 아님)', b, () => {
  const none = m.assembleEngineSet({ parts: [voicePart(), textPart()], allowOverseas: false });
  assert.equal(none.collectUsage(), undefined, '빈 객체는 "0 을 실측했다"로 읽힌다');

  const a = m.assembleEngineSet({
    parts: [
      voicePart({ lastUsage: () => ({ stt_audio_ms: 3200 }) }),
      textPart({ lastUsage: () => ({ llm_prompt_tokens: 20, llm_completion_tokens: 7 }) }),
    ],
    allowOverseas: false,
  });
  const u = a.collectUsage();
  assert.deepEqual(u.usage, { stt_audio_ms: 3200, llm_prompt_tokens: 20, llm_completion_tokens: 7 });
  assert.deepEqual(u.conflicts, []);
  assert.deepEqual(u.rejected, []);
});

test('같은 키를 두 조각이 내면 합산하지 않고 드러낸다 — 이중 계상은 과다청구로 나타난다', b, () => {
  const a = m.assembleEngineSet({
    parts: [
      voicePart({ lastUsage: () => ({ tts_audio_ms: 900 }) }),
      textPart({ lastUsage: () => ({ tts_audio_ms: 900 }) }),
    ],
    allowOverseas: false,
  });
  const u = a.collectUsage();
  assert.equal(u.usage.tts_audio_ms, undefined, '충돌한 키를 실어 보내면 대사에서 과다청구가 된다');
  assert.deepEqual(u.conflicts, [{ key: 'tts_audio_ms', sources: ['openai-audio', 'openai-compat'] }]);
});

test('모르는 항목·음수·비유한수는 싣지 않고 버린 사실을 남긴다(§13-3)', b, () => {
  const a = m.assembleEngineSet({
    parts: [
      voicePart({ lastUsage: () => ({ stt_audio_ms: -1, mystery_units: 5 }) }),
      textPart({ lastUsage: () => ({ llm_prompt_tokens: Number.NaN, llm_completion_tokens: 7 }) }),
    ],
    allowOverseas: false,
  });
  const u = a.collectUsage();
  assert.deepEqual(u.usage, { llm_completion_tokens: 7 });
  const keys = u.rejected.map((r) => r.key).sort();
  assert.deepEqual(keys, ['llm_prompt_tokens', 'mystery_units', 'stt_audio_ms']);
  assert.ok(u.rejected.every((r) => r.source && r.reasonKo));
});

test('슬롯을 하나도 주지 않은 조각의 사용량은 집계하지 않는다 — 이 통화와 무관한 값이다', b, () => {
  const bystander = { source: 'unused', engines: { activation: 'dry_run', lastUsage: () => ({ llm_prompt_tokens: 999 }) } };
  const a = m.assembleEngineSet({
    parts: [voicePart(), textPart({ lastUsage: () => ({ llm_prompt_tokens: 20 }) }), bystander],
    allowOverseas: false,
  });
  assert.equal(a.collectUsage().usage.llm_prompt_tokens, 20);
});

test('lastUsage 가 객체가 아닌 것을 돌려줘도 조립·수집이 죽지 않는다', b, () => {
  const a = m.assembleEngineSet({
    parts: [voicePart({ lastUsage: () => 42 }), textPart()], allowOverseas: false,
  });
  const u = a.collectUsage();
  assert.deepEqual(u.usage, {});
  assert.equal(u.rejected.length, 1);
});

// ── 상위 계층과의 실제 상호작용 ──────────────────────────────────────────────

test('조립 결과가 withResilientEngines 후보로 그대로 들어간다(§9.3 배선 확인)', b, async () => {
  const a = m.assembleEngineSet({ parts: [voicePart(), textPart()], allowOverseas: false });
  const caller = res.createResilientCaller({ attemptsPerCandidate: 1, allowOverseas: false });
  const wrapped = res.withResilientEngines(
    [{ name: 'primary', residency: a.residency, target: a.engines }],
    { caller },
  );
  assert.equal(typeof wrapped.llm.complete, 'function');
  // 조립기가 적은 residency 가 복원력 래퍼의 어댑터에도 그대로 실린다(§10.3 가드가 끊기지 않는다).
  assert.equal(wrapped.llm.residency, 'onprem');
  assert.equal(wrapped.stt.residency, 'onprem');
});

test('실제 벤더 어댑터(음성+텍스트, dry_run)가 구조 그대로 조립된다 — 어댑터를 고치지 않아도 된다', b, () => {
  const voice = audio.createOpenAiAudioEngines({
    name: 'onprem-whisper', residency: 'onprem', baseUrl: 'http://voice.internal:8000',
    timeoutMs: 1000, activation: 'dry_run', sttModel: 'whisper-large-v3-ko', ttsModel: 'tts-ko-1', ttsVoice: 'nara',
  });
  const text = compat.createOpenAiCompatEngines({
    name: 'onprem-sllm', residency: 'onprem', baseUrl: 'http://sllm.internal:8000',
    timeoutMs: 1000, activation: 'dry_run', chatModel: 'company-sllm-7b',
  });
  const a = m.assembleEngineSet({
    parts: [{ source: 'audio', engines: voice }, { source: 'text', engines: text }],
    allowOverseas: false,
  });
  assert.equal(a.activation, 'dry_run');
  assert.equal(a.residency, 'onprem');
  assert.equal(a.origins.length, 3);
  assert.equal(a.collectUsage(), undefined, '호출 전에는 사용량이 없다');

  const line = m.describeEngineSet(a);
  assert.ok(line.includes('dry_run(실호출 없음) [승인 필요]'), line);
  assert.ok(line.includes('stt=') && line.includes('llm='), line);
});

test('실제 음성 어댑터에서 모델 id 를 빼면 슬롯이 비고, 조립기가 그 자리에서 잡는다', b, () => {
  // ttsModel 을 주지 않았다 — 어댑터는 tts 를 만들지 않는다(§13-3). 지금까지는 `!` 로 가려졌다.
  const voice = audio.createOpenAiAudioEngines({
    name: 'onprem-whisper', residency: 'onprem', baseUrl: 'http://voice.internal:8000',
    timeoutMs: 1000, activation: 'dry_run', sttModel: 'whisper-large-v3-ko',
  });
  const text = compat.createOpenAiCompatEngines({
    name: 'onprem-sllm', residency: 'onprem', baseUrl: 'http://sllm.internal:8000',
    timeoutMs: 1000, activation: 'dry_run', chatModel: 'company-sllm-7b',
  });
  assertConfigError(
    () => m.assembleEngineSet({ parts: [{ source: 'audio', engines: voice }, { source: 'text', engines: text }], allowOverseas: false }),
    '필수 엔진 슬롯이 비어 있다: tts',
  );
});

test('describeEngineSet 은 사실만 적고 인증값을 싣지 않는다', b, () => {
  const a = m.assembleEngineSet({ parts: [voicePart(), textPart()], allowOverseas: false });
  const line = m.describeEngineSet(a);
  assert.ok(!/key|secret|authorization|Bearer/i.test(line), line);
  assert.ok(!/%|점수|진행률/.test(line), `판단 수치를 만들면 안 된다(§13-3): ${line}`);
});
