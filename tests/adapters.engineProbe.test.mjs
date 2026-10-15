// 엔진 복구 프로브 구현체 — §9.3·§6.2·§10.3·§11.2·§13-3.
// 네트워크를 쓰지 않는다. 찌르는 엔진은 모두 가짜 어댑터다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let http = null;
try {
  m = await import('../src/adapters/engineProbe.ts');
  http = await import('../src/adapters/http.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-15T01:00:00.000Z';
const now = () => NOW;

// ── 가짜 어댑터 ──────────────────────────────────────────────────────────────
// 닫힘(`return`) 관측을 위해 생성기마다 흔적을 남긴다.
function trace() {
  return { opened: 0, yielded: 0, closed: 0, pulls: 0 };
}

const sttAd = (t, chunks = [{ text: '여보세요', isFinal: true }]) => ({
  name: 'stt-1', residency: 'onprem',
  stream(audio) {
    t.opened += 1;
    t.audio = audio;
    return (async function* run() {
      try {
        for (const c of chunks) { t.yielded += 1; yield c; }
      } finally { t.closed += 1; }
    })();
  },
});

const ttsAd = (t, chunks = [{ data: new Uint8Array([1, 2, 3]), mime: 'audio/wav' }]) => ({
  name: 'tts-1', residency: 'onprem',
  synthesize(text, voice) {
    t.opened += 1;
    t.text = text;
    t.voice = voice;
    return (async function* run() {
      try {
        for (const c of chunks) { t.yielded += 1; yield c; }
      } finally { t.closed += 1; }
    })();
  },
});

const llmAd = (t, chunks = ['안', '녕']) => ({
  name: 'llm-1', residency: 'onprem',
  complete(messages) {
    t.opened += 1;
    t.messages = messages;
    return (async function* run() {
      try {
        for (const c of chunks) { t.yielded += 1; yield c; }
      } finally { t.closed += 1; }
    })();
  },
});

const embAd = (t, vectors) => ({
  name: 'emb-1', residency: 'onprem',
  async embed(texts) {
    t.opened += 1;
    t.texts = texts;
    return vectors ?? texts.map(() => [1, 2]);
  },
});

const throwingLlm = (code = 'E_TIMEOUT') => ({
  name: 'llm-x', residency: 'onprem',
  complete() {
    return (async function* run() {
      throw new http.EngineError(code, 'llm', '엔진 실패');
    })();
  },
});

const SAMPLES = {
  stt: { data: new Uint8Array([9, 9]), mime: 'audio/wav' },
  tts: { text: '점검용 문장입니다', voice: 'ko-f-1' },
  llm: [{ role: 'user', content: '점검' }],
  embedding: ['점검'],
};

const live = (engines, over = {}) => m.createEngineProbes({
  engines, activation: 'live', now, samples: SAMPLES, candidate: 'primary', ...over,
});

const byComponent = (set, component) => set.probes.find((p) => p.component === component);

function assertConfigError(fn, needle) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, 'E_CONFIG', `오류 코드가 다르다: ${String(e.code)}`);
    assert.ok(String(e.message).includes(needle), `메시지에 "${needle}" 가 없다: ${e.message}`);
    return e;
  }
  assert.fail('거절해야 하는 선언이 통과했다');
}

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('선언 하나로 슬롯별 프로브가 선다 — 컴포넌트 매핑은 HEALTH_COMPONENT_OF 하나다(임베딩은 rag)', b, () => {
  const t = { stt: trace(), tts: trace(), llm: trace(), emb: trace() };
  const set = live({
    stt: sttAd(t.stt), tts: ttsAd(t.tts), llm: llmAd(t.llm), embedding: embAd(t.emb),
  });
  assert.equal(set.contractVersion, m.ENGINE_PROBE_CONTRACT_VERSION);
  assert.deepEqual(set.probes.map((p) => p.component).sort(), ['llm', 'rag', 'stt', 'tts']);
  assert.deepEqual(set.skipped, []);
  // 만들기만 했을 뿐 엔진을 부르지 않았다.
  assert.equal(t.stt.opened + t.tts.opened + t.llm.opened + t.emb.opened, 0);
});

test('성공은 up 샘플이고 errorRate·latencyMs 를 만들지 않는다(§13-3 — 소요는 러너가 잰다)', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const t = trace();
  const set = live({ llm: llmAd(t) });
  const s = await byComponent(set, 'llm').check();
  assert.equal(s.component, 'llm');
  assert.equal(s.state, 'up');
  assert.equal(s.observedAt, NOW);
  assert.equal(s.errorRate, undefined);
  assert.equal(s.latencyMs, undefined);
  assert.ok(s.detail.includes('후보 primary'));
});

test('스트림은 첫 조각만 읽고 닫는다 — 확인 한 번이 전량 수신이 되지 않는다(§11.2)', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const t = trace();
  const set = live({ tts: ttsAd(t, [
    { data: new Uint8Array([1]), mime: 'audio/wav' },
    { data: new Uint8Array(1024), mime: 'audio/wav' },
    { data: new Uint8Array(1024), mime: 'audio/wav' },
  ]) });
  const s = await byComponent(set, 'tts').check();
  assert.equal(s.state, 'up');
  assert.equal(t.yielded, 1, '첫 조각 뒤로도 읽었다 — 프로브 한 번이 전량 수신이 된다');
  assert.equal(t.closed, 1, '반복자를 닫지 않았다 — 어댑터는 계속 받고 커넥션이 샌다');
});

test('TTS 프로브는 선언된 문장·voice 를 그대로 보낸다 — 고객 발화를 재사용하지 않는다(§10.3)', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const t = trace();
  const set = live({ tts: ttsAd(t) });
  await byComponent(set, 'tts').check();
  assert.equal(t.text, SAMPLES.tts.text);
  assert.equal(t.voice, SAMPLES.tts.voice);
});

test('LLM 프로브는 선언 배열을 복사해 보낸다 — 어댑터가 고쳐도 선언이 바뀌지 않는다', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const t = trace();
  const samples = { llm: [{ role: 'user', content: '점검' }] };
  const set = m.createEngineProbes({ engines: { llm: llmAd(t) }, activation: 'live', now, samples });
  await byComponent(set, 'llm').check();
  t.messages[0].content = '덮어썼다';
  assert.equal(samples.llm[0].content, '점검');
});

test('임베딩 성분 판정은 복사하지 않는다 — checkVector 하나를 쓴다(§2)', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const ok = live({ embedding: embAd(trace(), [[1, 2, 3]]) });
  const s = await byComponent(ok, 'rag').check();
  assert.equal(s.state, 'up');
  assert.ok(s.detail.includes('3차원'));

  // 영벡터는 유사도 분모를 0 으로 만든다 — 응답이 왔다는 사실만으로 up 을 적지 않는다.
  const zero = live({ embedding: embAd(trace(), [[0, 0]]) });
  await assert.rejects(() => byComponent(zero, 'rag').check(), (e) => e.code === 'E_PROTOCOL');
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('(라) 실패를 스스로 샘플로 바꾸지 않고 그대로 던진다 — 분류는 러너 한 곳이다(§2)', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const set = live({ llm: throwingLlm('E_TIMEOUT') });
  await assert.rejects(() => byComponent(set, 'llm').check(), (e) => {
    assert.equal(e.code, 'E_TIMEOUT');
    return true;
  });
});

test('(라) 설정 오류도 그대로 던진다 — down 으로 적으면 설정 오류 하나가 영구 래치가 된다', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const set = live({ llm: throwingLlm('E_CONFIG') });
  await assert.rejects(() => byComponent(set, 'llm').check(), (e) => e.code === 'E_CONFIG');
});

test('(바) 조각이 하나도 없으면 up 이 아니다 — 응답했지만 아무것도 내놓지 못한 것이다', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  for (const [slot, component, engines] of [
    ['stt', 'stt', { stt: sttAd(trace(), []) }],
    ['tts', 'tts', { tts: ttsAd(trace(), []) }],
    ['llm', 'llm', { llm: llmAd(trace(), []) }],
  ]) {
    const set = live(engines);
    await assert.rejects(
      () => byComponent(set, component).check(),
      (e) => {
        assert.equal(e.code, 'E_PROTOCOL', `${slot}: 빈 스트림이 통과했다`);
        assert.equal(e.component, slot);
        // "응답이 비었다"와 "형식이 틀렸다"는 조사할 곳이 다르다 — 사유를 뭉개지 않는다.
        assert.ok(e.message.includes('조각을 하나도'), `${slot}: 사유가 형식 위반으로 뭉개졌다: ${e.message}`);
        return true;
      },
    );
  }
});

test('(바) 0바이트 오디오는 채널에서 무음으로 재생된다 — 성공으로 적지 않는다', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const set = live({ tts: ttsAd(trace(), [{ data: new Uint8Array(0), mime: 'audio/wav' }]) });
  await assert.rejects(() => byComponent(set, 'tts').check(), (e) => {
    assert.equal(e.code, 'E_PROTOCOL');
    assert.ok(e.message.includes('무음'));
    return true;
  });
});

test('STT 전사 결과의 형태만 본다 — 빈 전사는 무음일 수 있어 내용으로 판정하지 않는다', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const empty = live({ stt: sttAd(trace(), [{ text: '', isFinal: false }]) });
  assert.equal((await byComponent(empty, 'stt').check()).state, 'up');

  const broken = live({ stt: sttAd(trace(), [{ isFinal: true }]) });
  await assert.rejects(() => byComponent(broken, 'stt').check(), (e) => e.code === 'E_PROTOCOL');
});

test('임베딩 개수가 어긋나면 규격 위반이다 — 요청 수와 응답 수가 다른 응답을 통과시키지 않는다', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const set = m.createEngineProbes({
    engines: { embedding: embAd(trace(), [[1, 2], [3, 4]]) },
    activation: 'live', now, samples: { embedding: ['점검'] },
  });
  await assert.rejects(() => byComponent(set, 'rag').check(), (e) => e.code === 'E_PROTOCOL');
});

test('던져도 반복자를 닫는다 — 검사 실패가 커넥션 누수로 남지 않는다', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const t = trace();
  const set = live({ tts: ttsAd(t, [{ data: new Uint8Array(0), mime: 'audio/wav' }]) });
  await assert.rejects(() => byComponent(set, 'tts').check());
  assert.equal(t.closed, 1);
});

// ── (나) 승인 게이트 ─────────────────────────────────────────────────────────

test('(나) dry_run 에서는 프로브를 만들지 않는다 — dry_run 은 언제나 성공해 폴백이 즉시 풀린다', b, () => {
  const set = m.createEngineProbes({
    engines: { stt: sttAd(trace()), tts: ttsAd(trace()), llm: llmAd(trace()) },
    activation: 'dry_run', now, samples: SAMPLES,
  });
  assert.deepEqual(set.probes, []);
  const reasons = Object.fromEntries(set.skipped.map((s) => [s.slot, s.reason]));
  // 슬롯이 없는 것(embedding)은 승인과 무관한 사실이므로 그대로 적는다 — 더 구체적인 사유가 이긴다.
  assert.deepEqual(reasons, { stt: 'not_activated', tts: 'not_activated', llm: 'not_activated', embedding: 'no_adapter' });
  assert.ok(set.skipped.filter((s) => s.reason === 'not_activated').every((s) => s.reasonKo.includes('[승인 필요]')));
  assert.ok(set.limitsKo.some((x) => x.includes('[승인 필요]')));
  assert.ok(set.describeKo.includes('dry_run'));
});

// ── (다) 합성 입력 ───────────────────────────────────────────────────────────

test('(다) 샘플을 지어내지 않는다 — 선언 없는 슬롯은 프로브를 만들지 않고 사유를 적는다(§13-3)', b, () => {
  const set = m.createEngineProbes({
    engines: { stt: sttAd(trace()), tts: ttsAd(trace()), llm: llmAd(trace()) },
    activation: 'live', now, samples: { llm: SAMPLES.llm },
  });
  assert.deepEqual(set.probes.map((p) => p.component), ['llm']);
  const reasons = Object.fromEntries(set.skipped.map((s) => [s.slot, s.reason]));
  assert.deepEqual(reasons, { stt: 'no_sample', tts: 'no_sample', embedding: 'no_adapter' });
});

test('슬롯이 없는 후보는 no_adapter 로 적는다 — 찌를 대상이 없는 것과 샘플이 없는 것을 구분한다', b, () => {
  const set = live({ llm: llmAd(trace()) });
  const reasons = Object.fromEntries(set.skipped.map((s) => [s.slot, s.reason]));
  assert.deepEqual(reasons, { stt: 'no_adapter', tts: 'no_adapter', embedding: 'no_adapter' });
});

test('(다) 프로브 입력에 개인정보 흔적이 있으면 거절한다 — 확인 주기마다 반복해서 나간다(§10.3)', b, () => {
  assertConfigError(
    () => m.createEngineProbes({
      engines: { tts: ttsAd(trace()) }, activation: 'live', now,
      samples: { tts: { text: '010-1234-5678 로 연락드립니다' } },
    }),
    '합성 샘플이어야',
  );
  assertConfigError(
    () => m.createEngineProbes({
      engines: { llm: llmAd(trace()) }, activation: 'live', now,
      samples: { llm: [{ role: 'user', content: '주민번호 900101-1234567' }] },
    }),
    '합성 샘플이어야',
  );
  assertConfigError(
    () => m.createEngineProbes({
      engines: { embedding: embAd(trace()) }, activation: 'live', now,
      samples: { embedding: ['카드 4111-1111-1111-1111'] },
    }),
    '합성 샘플이어야',
  );
});

test('거절 문구에는 원문을 싣지 않는다 — 사유가 로그로 흐른다(§10.3)', b, () => {
  const e = assertConfigError(
    () => m.createEngineProbes({
      engines: { tts: ttsAd(trace()) }, activation: 'live', now,
      samples: { tts: { text: '010-1234-5678' } },
    }),
    '합성 샘플이어야',
  );
  assert.ok(!e.message.includes('1234-5678'), `원문이 그대로 남았다: ${e.message}`);
});

test('형태 위반은 기동 시점에 거절한다 — 통화 중이 아니라 여기서 멈춘다', b, () => {
  const engines = { stt: sttAd(trace()), tts: ttsAd(trace()), llm: llmAd(trace()), embedding: embAd(trace()) };
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { stt: { data: new Uint8Array(0), mime: 'audio/wav' } } }), '오디오가 비어 있다');
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { stt: { data: new Uint8Array([1]), mime: '' } } }), 'mime 이 없다');
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { tts: { text: '  ' } } }), 'TTS 프로브 문장이 비어 있다');
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { tts: { text: '점검', voice: '' } } }), 'voice 가 빈 문자열');
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { llm: [] } }), 'LLM 프로브 메시지가 비어 있다');
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { llm: [{ role: 'tool', content: 'x' }] } }), 'role 이 올바르지 않다');
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { llm: [{ role: 'user', content: '' }] } }), '메시지 내용이 비어 있다');
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { embedding: [] } }), '임베딩 프로브 텍스트가 비어 있다');
  assertConfigError(() => m.createEngineProbes({ engines, activation: 'live', now, samples: { embedding: [''] } }), '빈 값이 있다');
});

test('선언 자체가 비면 거절한다', b, () => {
  assertConfigError(() => m.createEngineProbes(null), '프로브 선언이 없다');
  assertConfigError(() => m.createEngineProbes({ activation: 'live', now }), 'engines 가 없다');
  assertConfigError(() => m.createEngineProbes({ engines: {}, activation: 'on', now }), '활성화 값이 올바르지 않다');
  assertConfigError(() => m.createEngineProbes({ engines: {}, activation: 'live', now: 'noon' }), '함수가 아니다');
});

test('시계가 없으면 프로브를 만들지 않는다 — 시각 없는 샘플은 러너를 지나지 못한다(§9.3·§13-3)', b, () => {
  // 선언 검토 경로(enginePlan)는 헬스 배선 없이 기동한다 — 거절하면 그 경로가 막힌다.
  const set = m.createEngineProbes({ engines: { llm: llmAd(trace()) }, activation: 'live', samples: SAMPLES });
  assert.deepEqual(set.probes, []);
  assert.deepEqual(set.skipped.filter((s) => s.slot === 'llm').map((s) => s.reason), ['no_clock']);
  assert.ok(set.limitsKo.some((x) => x.includes('관측 시계가 배선되지 않아')));
});

// ── (사) 사용량 구간 알림 ────────────────────────────────────────────────────

test('(사) 호출 앞뒤로 알린다 — 실패해도 구간이 닫힌다(과금 근거에서 빼기 위한 유일한 근거다)', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const seen = [];
  const ok = m.createEngineProbes({
    engines: { llm: llmAd(trace()) }, activation: 'live', now, samples: SAMPLES,
    onProbeCall: (phase, component) => seen.push(`${phase}:${component}`),
  });
  await byComponent(ok, 'llm').check();
  assert.deepEqual(seen, ['before:llm', 'after:llm']);

  seen.length = 0;
  const bad = m.createEngineProbes({
    engines: { llm: throwingLlm() }, activation: 'live', now, samples: SAMPLES,
    onProbeCall: (phase, component) => seen.push(`${phase}:${component}`),
  });
  await assert.rejects(() => byComponent(bad, 'llm').check());
  assert.deepEqual(seen, ['before:llm', 'after:llm'], '실패 경로에서 구간이 닫히지 않았다');
});

test('알림 콜백이 던져도 프로브는 그 때문에 실패하지 않는다 — 알림 결함이 엔진 장애로 집계된다', async (t2) => {
  if (!m) return t2.skip('타입 스트리핑 미지원 런타임');
  const set = m.createEngineProbes({
    engines: { llm: llmAd(trace()) }, activation: 'live', now, samples: SAMPLES,
    onProbeCall: () => { throw new Error('수집 쪽 결함'); },
  });
  assert.equal((await byComponent(set, 'llm').check()).state, 'up');
});

// ── 한계 ─────────────────────────────────────────────────────────────────────

test('확인하지 못하는 범위를 숨기지 않는다 — 오디오 합성 여부·중단 신호·사용량 오염(§13-3)', b, () => {
  const set = live({ stt: sttAd(trace()), llm: llmAd(trace()) });
  assert.ok(set.limitsKo.some((x) => x.includes('마스킹할 수 없어')));
  assert.ok(set.limitsKo.some((x) => x.includes('중단 신호')));
  assert.ok(set.limitsKo.some((x) => x.includes('lastUsage()')));
});
