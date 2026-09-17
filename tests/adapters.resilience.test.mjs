// 엔진 호출 복원력 — §9.3·§6.2·§10.3·§13-3.
// 네트워크는 쓰지 않는다. 엔진은 전부 기록형 가짜이며 시계·대기도 주입한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let http = null;
let idx = null;
try {
  m = await import('../src/adapters/resilience.ts');
  http = await import('../src/adapters/http.ts');
  idx = await import('../src/adapters/index.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const E = (code, detail = {}) => new http.EngineError(code, 'llm', `가짜 ${code}`, detail);
const cand = (name, target, residency = 'onprem') => ({ name, residency, target });

function harness(over = {}) {
  const slept = [];
  const samples = [];
  let t = 1000;
  return {
    slept, samples,
    cfg: {
      attemptsPerCandidate: 1,
      allowOverseas: false,
      sleep: async (ms) => { slept.push(ms); },
      now: () => '2026-09-17T00:00:00.000Z',
      monotonic: () => (t += 5),
      record: (s) => samples.push(s),
      ...over,
    },
  };
}

// ── 설정 검증: 형태 오류는 통과시키지 않는다 ──────────────────────────────────

test('attemptsPerCandidate 가 1 미만·정수가 아니면 설정 오류로 거부한다', b, () => {
  for (const n of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => m.createResilientCaller({ attemptsPerCandidate: n, allowOverseas: false }), (e) => e.code === 'E_CONFIG');
  }
});

test('재시도를 켜면서 backoffMs 를 주지 않으면 거부한다 — Core 는 대기 시간을 정하지 않는다', b, () => {
  assert.throws(
    () => m.createResilientCaller({ attemptsPerCandidate: 3, allowOverseas: false }),
    (e) => e.code === 'E_CONFIG' && /13-3/.test(e.message),
  );
});

test('backoffMs 가 유효한 대기를 돌려주지 않으면 실행 중 설정 오류로 끝난다', b, async () => {
  const h = harness({ attemptsPerCandidate: 2, backoffMs: () => -1 });
  const caller = m.createResilientCaller(h.cfg);
  await assert.rejects(
    () => caller.run('llm', [cand('a', {})], async () => { throw E('E_TIMEOUT'); }),
    (e) => e.code === 'E_CONFIG',
  );
});

test('후보가 비어 있으면 설정 오류다', b, async () => {
  const caller = m.createResilientCaller(harness().cfg);
  await assert.rejects(() => caller.run('llm', [], async () => 1), (e) => e.code === 'E_CONFIG');
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('한 번에 성공하면 up 샘플을 남기고 값을 그대로 돌려준다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  const out = await caller.run('llm', [cand('primary', { v: 7 })], async (t) => t.v);
  assert.equal(out.ok, true);
  assert.equal(out.value, 7);
  assert.equal(out.usedCandidate, 'primary');
  assert.equal(out.attempts.length, 1);
  assert.equal(out.health.state, 'up');
  assert.equal(out.health.component, 'llm');
  assert.equal(out.health.latencyMs, 5);
  assert.deepEqual(h.samples, [out.health]);
});

test('재시도로 살아나면 up 이 아니라 degraded 로 적는다', b, async () => {
  const h = harness({ attemptsPerCandidate: 3, backoffMs: (seq) => seq * 10 });
  const caller = m.createResilientCaller(h.cfg);
  let n = 0;
  const out = await caller.run('stt', [cand('primary', {})], async () => {
    n += 1;
    if (n < 3) throw E('E_TIMEOUT');
    return 'ok';
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts.length, 3);
  assert.equal(out.health.state, 'degraded');
  assert.equal(out.health.component, 'stt');
  assert.deepEqual(h.slept, [20, 30]); // 첫 시도 앞에서는 기다리지 않는다
});

test('임베딩 실패는 L3(rag)로 집계한다 — L2 로 올리면 통화가 통째로 내려간다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  const out = await caller.run('embedding', [cand('p', {})], async () => [[0.1]]);
  assert.equal(out.health.component, 'rag');
  assert.equal(m.HEALTH_COMPONENT_OF.embedding, 'rag');
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('전 후보·전 시도 실패면 down 을 적고 마지막 오류를 삼키지 않는다', b, async () => {
  const h = harness({ attemptsPerCandidate: 2, backoffMs: () => 0 });
  const caller = m.createResilientCaller(h.cfg);
  const out = await caller.run('llm', [cand('a', {}), cand('b', {})], async () => { throw E('E_TIMEOUT'); });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_TIMEOUT');
  assert.equal(out.attempts.length, 4);
  assert.equal(out.health.state, 'down');
  assert.match(out.health.detail, /시도 4회 전부 실패/);
});

test('우리 잘못(E_INPUT)은 재시도·대체 없이 끝나고 엔진 상태로 집계하지 않는다', b, async () => {
  const h = harness({ attemptsPerCandidate: 3, backoffMs: () => 0 });
  const caller = m.createResilientCaller(h.cfg);
  let calls = 0;
  const out = await caller.run('llm', [cand('a', {}), cand('b', {})], async () => { calls += 1; throw E('E_INPUT'); });
  assert.equal(calls, 1);
  assert.equal(out.ok, false);
  assert.equal(out.attempts[0].failureClass, 'caller_fault');
  assert.equal(out.health, undefined);
  assert.deepEqual(h.samples, []);
});

test('승인 전 호출은 장애가 아니다 — 샘플을 남기지 않는다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  const out = await caller.run('llm', [cand('a', {})], async () => { throw E('E_APPROVAL_REQUIRED'); });
  assert.equal(out.health, undefined);
  assert.equal(m.classifyEngineFailure(E('E_APPROVAL_REQUIRED')).failureClass, 'not_activated');
});

test('콘텐츠 필터는 다른 엔진으로 우회하지 않는다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  let calls = 0;
  const out = await caller.run('llm', [cand('a', {}), cand('b', {})], async () => { calls += 1; throw E('E_FILTERED'); });
  assert.equal(calls, 1);
  assert.equal(out.ok, false);
  assert.equal(out.health, undefined);
});

test('규격 위반은 같은 엔진에 다시 걸지 않고 대체 엔진으로 넘긴다', b, async () => {
  const h = harness({ attemptsPerCandidate: 3, backoffMs: () => 0 });
  const caller = m.createResilientCaller(h.cfg);
  const seen = [];
  const out = await caller.run('llm', [cand('a', 'a'), cand('b', 'b')], async (t) => {
    seen.push(t);
    if (t === 'a') throw E('E_PROTOCOL');
    return 'good';
  });
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(out.ok, true);
  assert.equal(out.usedCandidate, 'b');
  assert.equal(out.health.state, 'degraded');
});

test('HTTP 상태별로 재시도 여부가 갈린다 — 상태 미상은 재시도하지 않는다', b, () => {
  assert.equal(m.classifyEngineFailure(E('E_HTTP', { status: 503 })).retryable, true);
  assert.equal(m.classifyEngineFailure(E('E_HTTP', { status: 429 })).retryable, true);
  assert.equal(m.classifyEngineFailure(E('E_HTTP', { status: 400 })).retryable, false);
  assert.equal(m.classifyEngineFailure(E('E_HTTP', { status: 401 })).attributable, false);
  const unknown = m.classifyEngineFailure(E('E_HTTP', {}));
  assert.equal(unknown.retryable, false);
  assert.match(unknown.reasonKo, /미상/);
});

test('정체불명 예외는 E_UNKNOWN 으로 정규화하고 엔진 탓으로 돌리지 않는다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  const out = await caller.run('llm', [cand('a', {})], async () => { throw new TypeError('x is not a function'); });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_UNKNOWN');
  assert.equal(out.attempts[0].failureClass, 'indeterminate');
  assert.equal(out.health, undefined);
});

test('정체불명 예외 메시지는 마스킹을 거친다', b, () => {
  const err = m.normalizeEngineError('llm', new Error('고객 010-1234-5678 처리 중 실패'));
  assert.equal(err.code, 'E_UNKNOWN');
  assert.ok(!err.message.includes('010-1234-5678'));
  assert.match(err.message, /010-\*\*\*\*-5678/);
});

// ── 국외이전(§10.3) ──────────────────────────────────────────────────────────

test('국외이전 불가면 해외 후보를 부르지 않고 제외를 드러낸다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  const seen = [];
  const out = await caller.run('llm', [cand('overseas-llm', 'o', 'overseas'), cand('onprem-llm', 'n')], async (t) => {
    seen.push(t);
    return 'ok';
  });
  assert.deepEqual(seen, ['n']);
  assert.equal(out.usedCandidate, 'onprem-llm');
  assert.deepEqual(out.skipped, [{ candidate: 'overseas-llm', reasonKo: '국외이전 불가 테넌트 — 해외 엔진은 부르지 않는다(§10.3)' }]);
});

test('후보가 전부 해외인데 국외이전 불가면 호출하지 않고 설정 오류로 끝난다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  let calls = 0;
  await assert.rejects(
    () => caller.run('llm', [cand('o1', 'a', 'overseas')], async () => { calls += 1; return 1; }),
    (e) => e.code === 'E_CONFIG',
  );
  assert.equal(calls, 0);
});

test('가장 노출도가 높은 residency 로 적는다', b, () => {
  assert.equal(m.widestResidency(['onprem', 'domestic']), 'domestic');
  assert.equal(m.widestResidency(['onprem', 'overseas']), 'overseas');
  assert.equal(m.widestResidency(['onprem']), 'onprem');
});

// ── 시계 미주입(§13-3) ───────────────────────────────────────────────────────

test('시계를 주지 않으면 헬스 샘플을 만들지 않는다', b, async () => {
  const caller = m.createResilientCaller({ attemptsPerCandidate: 1, allowOverseas: false });
  const out = await caller.run('llm', [cand('a', {})], async () => 'ok');
  assert.equal(out.ok, true);
  assert.equal(out.health, undefined);
});

test('단조 시계를 주지 않으면 소요를 지어내지 않는다', b, async () => {
  const h = harness({ monotonic: undefined });
  const caller = m.createResilientCaller(h.cfg);
  const out = await caller.run('llm', [cand('a', {})], async () => 'ok');
  assert.equal(out.attempts[0].elapsedMs, undefined);
  assert.equal(out.health.latencyMs, undefined);
});

// ── §6.2 인터페이스 감싸기 ───────────────────────────────────────────────────

const streamEngine = (name, chunks, failAt = -1) => ({
  stt: {
    name, residency: 'onprem',
    stream: async function* () {
      for (let i = 0; i < chunks.length; i += 1) {
        if (i === failAt) throw E('E_TIMEOUT');
        yield { text: chunks[i], isFinal: i === chunks.length - 1 };
      }
    },
  },
  tts: {
    name, residency: 'onprem',
    synthesize: async function* () { yield { data: new Uint8Array([1]), mime: 'audio/wav' }; },
  },
  llm: {
    name, residency: 'onprem',
    complete: async function* () {
      for (let i = 0; i < chunks.length; i += 1) {
        if (i === failAt) throw E('E_TIMEOUT');
        yield chunks[i];
      }
    },
  },
});

async function collect(it) {
  const out = [];
  for await (const v of it) out.push(v);
  return out;
}

test('첫 청크 전에 죽은 엔진은 대체 엔진으로 넘긴다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  const set = m.withResilientEngines(
    [cand('a', streamEngine('a', ['x'], 0)), cand('b', streamEngine('b', ['안녕', '하세요']))],
    { caller: caller },
  );
  assert.deepEqual(await collect(set.llm.complete([{ role: 'user', content: 'hi' }])), ['안녕', '하세요']);
  assert.equal(h.samples.at(-1).state, 'degraded');
});

test('첫 청크가 나간 뒤의 실패는 재시도하지 않고 그대로 드러낸다', b, async () => {
  const h = harness({ attemptsPerCandidate: 2, backoffMs: () => 0 });
  const caller = m.createResilientCaller(h.cfg);
  const set = m.withResilientEngines(
    [cand('a', streamEngine('a', ['앞부분', '뒷부분'], 1)), cand('b', streamEngine('b', ['대체']))],
    { caller: caller },
  );
  const got = [];
  await assert.rejects(async () => {
    for await (const v of set.llm.complete([])) got.push(v);
  }, (e) => e.code === 'E_TIMEOUT');
  assert.deepEqual(got, ['앞부분']); // 같은 말을 두 번 재생하지 않는다
});

test('빈 스트림은 빈 채로 돌려준다 — 없는 응답을 지어내지 않는다', b, async () => {
  const h = harness();
  const caller = m.createResilientCaller(h.cfg);
  const empty = { llm: { name: 'e', residency: 'onprem', complete: async function* () { /* 없음 */ } } };
  const set = m.withResilientEngines([cand('e', empty)], { caller: caller });
  assert.deepEqual(await collect(set.llm.complete([])), []);
});

test('임베딩은 전 구간 재시도가 안전하다', b, async () => {
  const h = harness({ attemptsPerCandidate: 2, backoffMs: () => 0 });
  const caller = m.createResilientCaller(h.cfg);
  let n = 0;
  const eng = { embedding: { name: 'e', residency: 'onprem', embed: async () => { n += 1; if (n === 1) throw E('E_TIMEOUT'); return [[1, 2]]; } } };
  const set = m.withResilientEngines([cand('e', eng)], { caller: caller });
  assert.deepEqual(await set.embedding.embed(['가']), [[1, 2]]);
  assert.equal(n, 2);
});

test('임베딩 후보가 없으면 embedding 을 만들어 두지 않는다', b, async () => {
  const caller = m.createResilientCaller(harness().cfg);
  const set = m.withResilientEngines([cand('a', streamEngine('a', ['x']))], { caller: caller });
  assert.equal(set.embedding, undefined);
  assert.equal(set.llm.name, 'resilient(a)');
});

test('해외 후보를 섞으면 합쳐진 엔진셋의 residency 는 overseas 다 — 가드가 무력해지지 않게', b, () => {
  const caller = m.createResilientCaller(harness({ allowOverseas: true }).cfg);
  const set = m.withResilientEngines(
    [cand('on', streamEngine('on', ['x'])), cand('ov', streamEngine('ov', ['x']), 'overseas')],
    { caller: caller },
  );
  assert.equal(set.llm.residency, 'overseas');
  // 합쳐진 엔진셋도 §10.3 가드에 그대로 걸려야 한다.
  assert.throws(() => idx.assertResidency(set, false), /국외이전/);
});

test('엔진 후보가 비면 감싸기 자체를 거부한다', b, () => {
  const caller = m.createResilientCaller(harness().cfg);
  assert.throws(() => m.withResilientEngines([], { caller: caller }), (e) => e.code === 'E_CONFIG');
});
