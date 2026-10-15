// 엔진 기동 실행기 — §6.2·§9.3·§10.3·§11.1·§11.2·§13-3.
// 네트워크는 절대 쓰지 않는다. 실엔진 규격 어댑터를 쓰는 검사도 전부 dry_run 이고,
// 실제로 호출되는 엔진은 모두 가짜 어댑터(preassembled)다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let http = null;
let fb = null;
try {
  m = await import('../src/adapters/executeEngines.ts');
  http = await import('../src/adapters/http.ts');
  fb = await import('../src/ops/fallback.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

// ── 가짜 어댑터 ──────────────────────────────────────────────────────────────
const sttAd = (name, r = 'onprem') => ({
  name, residency: r, stream: async function* () { yield { text: '여보세요', isFinal: true }; },
});
const ttsAd = (name, r = 'onprem') => ({
  name, residency: r, synthesize: async function* () { yield { data: new Uint8Array([1]), mime: 'audio/wav' }; },
});
const llmAd = (name, r = 'onprem', text = '{"candidates":[]}') => ({
  name, residency: r, complete: async function* () { yield text; },
});
const failingLlm = (name, code = 'E_TIMEOUT', r = 'onprem') => ({
  name,
  residency: r,
  complete: async function* () {
    throw new http.EngineError(code, 'llm', `${name} 실패`);
    // eslint-disable-next-line no-unreachable
  },
});
const embAd = (name, r = 'onprem', dim = 2) => ({
  name, residency: r, embed: async (texts) => texts.map(() => Array.from({ length: dim }, (_, i) => i + 1)),
});

function fullPart(over = {}, source = 'fake', activation = 'dry_run') {
  return {
    kind: 'preassembled',
    source,
    engines: { activation, stt: sttAd('stt-1'), tts: ttsAd('tts-1'), llm: llmAd('llm-1'), ...over },
  };
}

const SCOPE = { tenantId: 't1' };

function decl(over = {}) {
  return { scope: SCOPE, allowOverseas: false, sets: [{ name: 'primary', parts: [fullPart()] }], ...over };
}

function assertConfigError(fn, needle) {
  try {
    fn();
  } catch (e) {
    assert.ok(
      e.code === 'E_CONFIG' || e instanceof Error,
      `예외 형태가 다르다: ${String(e)}`,
    );
    assert.ok(String(e.message).includes(needle), `메시지에 "${needle}" 가 없다: ${e.message}`);
    return e;
  }
  assert.fail('거절해야 하는 선언이 통과했다');
}

function memRegistry() {
  const samples = [];
  return { samples, record: (s) => samples.push(s), latest: () => undefined, snapshot: () => [...samples] };
}

const CATALOG = { tenantId: 't1', intents: [{ id: 'bill', titleKo: '요금 문의' }] };

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('선언 하나로 §6.2 EngineSet 이 선다 — 컴포넌트·후보·활성화가 그대로 보인다', b, () => {
  const r = m.startEngines(decl());
  assert.equal(r.contractVersion, m.ENGINE_STARTUP_CONTRACT_VERSION);
  assert.equal(r.engines.llm.name, 'llm-1');
  assert.equal(r.activation, 'dry_run');
  assert.deepEqual(r.components, ['stt', 'tts', 'llm']);
  assert.deepEqual(r.candidates, ['primary']);
  assert.equal(r.healthRecorded, false);
  assert.equal(r.classifier, undefined, '선언하지 않은 분류기가 생겼다');
  assert.equal(r.embedder, undefined, '선언하지 않은 임베딩 포트가 생겼다');
});

test('실엔진 규격 조각(OpenAI 호환 텍스트 + 음성)이 한 세트로 조립된다 — dry_run', b, () => {
  const r = m.startEngines(decl({
    sets: [{
      name: 'onprem',
      parts: [
        {
          kind: 'openai-audio',
          source: 'audio',
          config: {
            name: 'whisper', residency: 'onprem', baseUrl: 'https://stt.example.co.kr',
            timeoutMs: 3000, activation: 'dry_run', sttModel: 'whisper-1', ttsModel: 'tts-1', ttsVoice: 'ko-1',
          },
        },
        {
          kind: 'openai-compat',
          source: 'text',
          config: {
            name: 'sllm', residency: 'onprem', baseUrl: 'https://llm.example.co.kr',
            timeoutMs: 3000, activation: 'dry_run', chatModel: 'sllm-7b',
          },
        },
      ],
    }],
  }));
  assert.deepEqual(r.origins.map((o) => `${o.slot}:${o.source}`), ['stt:audio', 'tts:audio', 'llm:text']);
  assert.equal(r.residency, 'onprem');
  assert.ok(r.describeKo.includes('dry_run'), `서술에 활성화가 없다: ${r.describeKo}`);
});

test('활성화 전에는 승인 대기 컴포넌트를 돌려준다 — live 면 빈 배열이다', b, () => {
  const dry = m.startEngines(decl());
  assert.deepEqual(dry.approvalPending, ['stt', 'tts', 'llm']);
  const live = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [fullPart({}, 'fake', 'live')] }],
  }));
  assert.deepEqual(live.approvalPending, []);
});

test('임베딩은 있으면 싣고 없으면 요구하지 않는다 — RAG 를 전제하지 않는다(§6.2)', b, () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [fullPart({ embedding: embAd('emb-1') })] }],
  }));
  assert.equal(r.engines.embedding.name, 'emb-1');
  assert.deepEqual(r.components, ['stt', 'tts', 'llm', 'rag']);
});

test('복원력을 선언하면 §9.3 헬스 샘플이 레지스트리에 남는다 — live 에서만', b, async () => {
  const reg = memRegistry();
  const r = m.startEngines(
    decl({
      sets: [{ name: 'primary', parts: [fullPart({ llm: failingLlm('llm-down') }, 'fake', 'live')] }],
      resilience: { attemptsPerCandidate: 1 },
    }),
    { record: reg.record, now: () => '2026-10-13T00:00:00.000Z' },
  );
  assert.equal(r.healthRecorded, true);
  await assert.rejects(async () => {
    for await (const _ of r.engines.llm.complete([{ role: 'user', content: '안녕' }])) { /* 소비만 */ }
  });
  assert.equal(reg.samples.length, 1, '엔진 실패가 레지스트리에 닿지 않았다');
  assert.equal(reg.samples[0].component, 'llm');
  assert.equal(reg.samples[0].state, 'down');
  assert.equal(reg.samples[0].observedAt, '2026-10-13T00:00:00.000Z');
});

test('dry_run 성공은 기록하지 않는다 — 켜지지도 않은 엔진이 up 으로 보고되면 안 된다(§9.3)', b, async () => {
  const reg = memRegistry();
  const r = m.startEngines(
    decl({ resilience: { attemptsPerCandidate: 1 } }),
    { record: reg.record, now: () => '2026-10-13T00:00:00.000Z' },
  );
  assert.equal(r.healthRecorded, false);
  for await (const _ of r.engines.llm.complete([{ role: 'user', content: '안녕' }])) { /* 가짜는 성공한다 */ }
  assert.equal(reg.samples.length, 0, 'dry_run 샘플이 실관측으로 기록됐다');
  assert.ok(
    r.limitsKo.some((x) => x.includes('활성화 전')),
    `기록하지 않은 사실이 적히지 않았다: ${JSON.stringify(r.limitsKo)}`,
  );
});

test('대체 세트로 넘어간다 — 주 LLM 이 죽어도 통화가 끊기지 않는다(§9.3)', b, async () => {
  const reg = memRegistry();
  const r = m.startEngines(
    decl({
      sets: [
        { name: 'primary', parts: [fullPart({ llm: failingLlm('llm-down') }, 'a', 'live')] },
        { name: 'backup', parts: [fullPart({ llm: llmAd('llm-backup', 'onprem', '대체 응답') }, 'b', 'live')] },
      ],
      resilience: { attemptsPerCandidate: 1 },
    }),
    { record: reg.record, now: () => '2026-10-13T00:00:00.000Z' },
  );
  const out = [];
  for await (const chunk of r.engines.llm.complete([{ role: 'user', content: '안녕' }])) out.push(chunk);
  assert.deepEqual(out, ['대체 응답']);
  assert.equal(reg.samples.length, 1);
  assert.equal(reg.samples[0].state, 'up', '복구된 호출을 장애로 적었다');
  assert.ok(reg.samples[0].detail.includes('backup'), `어느 후보를 썼는지 남지 않았다: ${reg.samples[0].detail}`);
});

test('재시도로 되살아난 호출을 degraded 로 적을지는 테넌트가 정한다(§13-3)', b, async () => {
  const reg = memRegistry();
  let calls = 0;
  const flaky = {
    name: 'flaky',
    residency: 'onprem',
    complete: async function* () {
      calls += 1;
      if (calls === 1) throw new http.EngineError('E_TIMEOUT', 'llm', '첫 시도 실패');
      yield '두 번째에 성공';
    },
  };
  const r = m.startEngines(
    decl({
      sets: [{ name: 'primary', parts: [fullPart({ llm: flaky }, 'a', 'live')] }],
      resilience: { attemptsPerCandidate: 2, backoffMs: () => 0, sleep: async () => {}, recoveryState: 'degraded' },
    }),
    { record: reg.record, now: () => '2026-10-13T00:00:00.000Z' },
  );
  const out = [];
  for await (const chunk of r.engines.llm.complete([{ role: 'user', content: '안녕' }])) out.push(chunk);
  assert.deepEqual(out, ['두 번째에 성공']);
  assert.equal(reg.samples[0].state, 'degraded');
});

test('설정 오류(caller_fault)는 대체로 가리지 않고 샘플도 남기지 않는다', b, async () => {
  const reg = memRegistry();
  let backupCalls = 0;
  const backup = {
    name: 'llm-backup',
    residency: 'onprem',
    complete: async function* () { backupCalls += 1; yield '대체'; },
  };
  const r = m.startEngines(
    decl({
      sets: [
        { name: 'primary', parts: [fullPart({ llm: failingLlm('llm-bad', 'E_INPUT') }, 'a', 'live')] },
        { name: 'backup', parts: [fullPart({ llm: backup }, 'bk', 'live')] },
      ],
      resilience: { attemptsPerCandidate: 1 },
    }),
    { record: reg.record, now: () => '2026-10-13T00:00:00.000Z' },
  );
  await assert.rejects(async () => {
    for await (const _ of r.engines.llm.complete([{ role: 'user', content: '안녕' }])) { /* 소비만 */ }
  });
  assert.equal(backupCalls, 0, '우리 입력이 틀린 것을 대체 엔진으로 가렸다');
  assert.equal(reg.samples.length, 0, '우리 잘못을 엔진 장애로 집계했다');
});

test('분류기는 복원력이 붙은 LLM 으로 만들어진다 — 분류 실패도 §9.3 에 닿는다', b, async () => {
  const reg = memRegistry();
  const r = m.startEngines(
    decl({
      sets: [
        { name: 'primary', parts: [fullPart({ llm: failingLlm('llm-down') }, 'a', 'live')] },
        {
          name: 'backup',
          parts: [fullPart({ llm: llmAd('llm-backup', 'onprem', '{"candidates":[{"intent":"bill","confidence":0.9}]}') }, 'bk', 'live')],
        },
      ],
      resilience: { attemptsPerCandidate: 1 },
      intent: { systemKo: '너는 상담 분류기다.' },
    }),
    { record: reg.record, now: () => '2026-10-13T00:00:00.000Z' },
  );
  const out = await r.classifier.classify({ utterance: '요금이 왜 이렇게 나왔죠', catalog: CATALOG });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.candidates, [{ intent: 'bill', confidence: 0.9 }]);
  assert.equal(reg.samples.length, 1, '분류 경로의 엔진 실패가 레지스트리에 닿지 않았다');
});

test('분류기는 빈 발화로 엔진을 부르지 않는다(§11.2)', b, async () => {
  const r = m.startEngines(decl({ intent: { systemKo: '너는 상담 분류기다.' } }));
  const out = await r.classifier.classify({ utterance: '   ', catalog: CATALOG });
  assert.equal(out.status, 'empty_input');
  assert.equal(out.promptChars, 0);
});

test('임베딩 포트도 복원력 경로를 지난다 — 같은 allowOverseas 가 적용된다(§10.3)', b, async () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [fullPart({ embedding: embAd('emb-1') }, 'a', 'live')] }],
    resilience: { attemptsPerCandidate: 1 },
    knowledge: { expectDim: 2 },
  }));
  const out = await r.embedder.embedTexts(['약관 안내']);
  assert.equal(out.status, 'ok');
  assert.equal(out.dim, 2);
  assert.equal(out.dimUncheckedAgainstIndex, false);
});

test('expectDim 을 주지 않으면 검사하지 못한 범위를 적는다(§13-3)', b, () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [fullPart({ embedding: embAd('emb-1') })] }],
    knowledge: {},
  }));
  assert.ok(
    r.limitsKo.some((x) => x.includes('expectDim')),
    `검사하지 못한 범위가 적히지 않았다: ${JSON.stringify(r.limitsKo)}`,
  );
});

test('조각의 실측 사용량이 §11.2 근거로 모인다 — 복원력을 지나도 끊기지 않는다', b, () => {
  const part = fullPart({}, 'a');
  part.engines.lastUsage = () => ({ llm_prompt_tokens: 12 });
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [part] }],
    resilience: { attemptsPerCandidate: 1 },
  }));
  const u = r.lastUsage();
  assert.deepEqual(u.usage, { llm_prompt_tokens: 12 });
  assert.deepEqual(u.conflicts, []);
});

test('같은 사용량 키를 두 조각이 내면 합산하지 않고 빼고 드러낸다(이중 계상 금지)', b, () => {
  const a = fullPart({}, 'a');
  a.engines.lastUsage = () => ({ llm_prompt_tokens: 10 });
  const bk = fullPart({}, 'bk');
  bk.engines.lastUsage = () => ({ llm_prompt_tokens: 7 });
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [a] }, { name: 'backup', parts: [bk] }],
    resilience: { attemptsPerCandidate: 1 },
  }));
  const u = r.lastUsage();
  assert.equal(u.usage.llm_prompt_tokens, undefined, '두 조각의 값을 합산했다');
  assert.deepEqual(u.conflicts, [{ key: 'llm_prompt_tokens', sources: ['a', 'bk'] }]);
});

test('사용량을 아무 조각도 주지 않으면 undefined — 빈 객체는 "0 을 실측했다"로 읽힌다', b, () => {
  const r = m.startEngines(decl());
  assert.equal(r.lastUsage(), undefined);
});

test('서술은 마스킹을 지난다 — 조각 이름에 번호가 섞여 들어올 수 있다(§10.3)', b, () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [fullPart({ llm: llmAd('llm-010-1234-5678') }, 'a')] }],
  }));
  assert.ok(!r.describeKo.includes('010-1234-5678'), `원문이 그대로 남았다: ${r.describeKo}`);
});

test('헬스 배선이 없으면 그 사실을 적는다 — 엔진 실패가 폴백 판정에 닿지 않는다(§9.3)', b, () => {
  const r = m.startEngines(decl({ resilience: { attemptsPerCandidate: 1 } }));
  assert.equal(r.healthRecorded, false);
  assert.ok(
    r.limitsKo.some((x) => x.includes('헬스 레지스트리가 배선되지 않았다')),
    `미배선 사실이 적히지 않았다: ${JSON.stringify(r.limitsKo)}`,
  );
});

test('복원력을 선언하지 않으면 조립만 한다 — 종전과 완전히 같다(§13-3)', b, () => {
  const r = m.startEngines(decl());
  assert.equal(r.engines.llm.name, 'llm-1', '복원력 래퍼가 몰래 붙었다');
  assert.ok(r.limitsKo.some((x) => x.includes('복원력이 선언되지 않았다')));
});

test('단조 시계가 없으면 latencyMs 를 만들지 않는다는 사실을 적는다(§13-3)', b, () => {
  const r = m.startEngines(decl({ resilience: { attemptsPerCandidate: 1 } }));
  assert.ok(r.limitsKo.some((x) => x.includes('latencyMs')));
});

// ── 거절 경로 ────────────────────────────────────────────────────────────────

test('§11.1 테넌트 없는 기동은 거절한다', b, () => {
  assertConfigError(() => m.startEngines(decl({ scope: {} })), 'tenant_id');
});

test('allowOverseas 미선언은 거절한다 — 추측이 곧 유출이다(§10.3)', b, () => {
  const d = decl();
  delete d.allowOverseas;
  assertConfigError(() => m.startEngines(d), 'allowOverseas');
});

test('빈 세트·빈 조각·이름 없는 세트는 거절한다', b, () => {
  assertConfigError(() => m.startEngines(decl({ sets: [] })), '엔진 세트가 비어 있다');
  assertConfigError(() => m.startEngines(decl({ sets: [{ name: 'p', parts: [] }] })), '조각이 비어 있다');
  assertConfigError(() => m.startEngines(decl({ sets: [{ name: '  ', parts: [fullPart()] }] })), '세트에 이름이 없다');
});

test('세트 이름 중복은 거절한다 — 어느 후보가 응답했는지 알 수 없게 된다', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [{ name: 'same', parts: [fullPart({}, 'a')] }, { name: 'same', parts: [fullPart({}, 'bk')] }],
      resilience: { attemptsPerCandidate: 1 },
    })),
    '세트 이름이 중복된다',
  );
});

test('조각 이름이 세트를 넘어 중복되면 거절한다 — 사용량 항목이 조용히 빠진다(§11.2)', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [{ name: 'primary', parts: [fullPart({}, 'same')] }, { name: 'backup', parts: [fullPart({}, 'same')] }],
      resilience: { attemptsPerCandidate: 1 },
    })),
    '세트를 넘어 중복된다',
  );
});

test('세트 간 활성화 혼재는 거절한다 — 대체가 영원히 호출되지 않는다 [승인 필요]', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [
        { name: 'primary', parts: [fullPart({}, 'a', 'dry_run')] },
        { name: 'backup', parts: [fullPart({}, 'bk', 'live')] },
      ],
      resilience: { attemptsPerCandidate: 1 },
    })),
    '활성화가 섞여 있다',
  );
});

test('대체 세트에만 있는 임베딩은 거절한다 — 그 슬롯은 대체가 아니라 주 경로가 된다', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [
        { name: 'primary', parts: [fullPart({}, 'a')] },
        { name: 'backup', parts: [fullPart({ embedding: embAd('emb-only-backup') }, 'bk')] },
      ],
      resilience: { attemptsPerCandidate: 1 },
    })),
    '주 세트에 없는 슬롯',
  );
});

test('대체를 선언했는데 복원력이 없으면 거절한다 — 첫 세트만 쓰인다', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [{ name: 'primary', parts: [fullPart({}, 'a')] }, { name: 'backup', parts: [fullPart({}, 'bk')] }],
    })),
    '복원력(resilience) 선언이 없다',
  );
});

test('기록을 배선하면서 복원력을 선언하지 않으면 거절한다 — 한 건도 남지 않는다', b, () => {
  assertConfigError(
    () => m.startEngines(decl(), { record: () => {}, now: () => '2026-10-13T00:00:00.000Z' }),
    '기록은 호출기 하나를 지나므로',
  );
});

test('기록 배선에 시계가 없으면 거절한다 — 샘플 자체가 만들어지지 않는다(§13-3)', b, () => {
  assertConfigError(
    () => m.startEngines(decl({ resilience: { attemptsPerCandidate: 1 } }), { record: () => {} }),
    'record 와 now',
  );
});

test('국외이전 불가 테넌트에 해외 엔진이 섞이면 기동을 거절한다(§10.3)', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [{ name: 'primary', parts: [fullPart({ llm: llmAd('gpt-x', 'overseas') }, 'a')] }],
    })),
    '해외 엔진',
  );
});

test('해외 대체 세트도 기동 시점에 거절한다 — 통화 중에 조용히 건너뛰지 않는다(§10.3)', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [
        { name: 'primary', parts: [fullPart({}, 'a')] },
        { name: 'backup', parts: [fullPart({ llm: llmAd('gpt-x', 'overseas') }, 'bk')] },
      ],
      resilience: { attemptsPerCandidate: 1 },
    })),
    '해외 엔진',
  );
});

test('국외이전을 허용한 테넌트는 해외 엔진으로 기동되고 residency 가 가장 노출도 높은 값이다', b, () => {
  const r = m.startEngines(decl({
    allowOverseas: true,
    sets: [{ name: 'primary', parts: [fullPart({ llm: llmAd('gpt-x', 'overseas') }, 'a')] }],
  }));
  assert.equal(r.residency, 'overseas');
});

test('지식 임베딩을 선언했는데 임베딩 슬롯이 없으면 거절한다 — 선언만 남는 상태를 두지 않는다', b, () => {
  assertConfigError(() => m.startEngines(decl({ knowledge: { expectDim: 2 } })), 'embedding 슬롯이 비어 있다');
});

test('RAG 테넌트로 선언했는데 임베딩이 없으면 거절한다(§5.2)', b, () => {
  assertConfigError(() => m.startEngines(decl({ requireEmbedding: true })), 'embedding 슬롯이 비어 있다');
});

test('중립 HTTP 조각은 경로 없는 슬롯을 싣지 않는다 — 첫 통화에서 터지는 설정을 지금 거절한다', b, () => {
  const cfg = {
    name: 'neutral', residency: 'onprem', baseUrl: 'https://engine.example.co.kr',
    timeoutMs: 3000, activation: 'dry_run', paths: { llm: '/v1/llm' },
  };
  assertConfigError(
    () => m.startEngines(decl({ sets: [{ name: 'primary', parts: [{ kind: 'neutral-http', source: 'n', config: cfg }] }] })),
    '필수 엔진 슬롯이 비어 있다',
  );
});

test('경로가 하나도 없는 중립 HTTP 조각은 그 사유로 거절한다', b, () => {
  const cfg = {
    name: 'neutral', residency: 'onprem', baseUrl: 'https://engine.example.co.kr',
    timeoutMs: 3000, activation: 'dry_run', paths: {},
  };
  assertConfigError(
    () => m.startEngines(decl({ sets: [{ name: 'primary', parts: [{ kind: 'neutral-http', source: 'n', config: cfg }] }] })),
    '경로(paths)가 하나도 없다',
  );
});

test('모르는 조각 종류·이름 없는 조각은 거절한다', b, () => {
  assertConfigError(
    () => m.startEngines(decl({ sets: [{ name: 'primary', parts: [{ kind: 'vendor-x', source: 'x' }] }] })),
    '알 수 없는 엔진 조각 종류',
  );
  assertConfigError(
    () => m.startEngines(decl({ sets: [{ name: 'primary', parts: [{ kind: 'preassembled', source: '', engines: {} }] }] })),
    'source 이름이 없다',
  );
});

test('재시도를 켜고 대기를 주지 않으면 거절한다 — Core 는 대기 시간을 정하지 않는다(§13-3)', b, () => {
  assertConfigError(
    () => m.startEngines(decl({ resilience: { attemptsPerCandidate: 2 } })),
    'backoffMs',
  );
  assertConfigError(
    () => m.startEngines(decl({ resilience: { attemptsPerCandidate: 0 } })),
    'attemptsPerCandidate',
  );
});

test('활성화를 선언하지 않은 조각은 거절한다 — 실호출 여부를 추측하지 않는다', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [{ name: 'primary', parts: [{ kind: 'preassembled', source: 'a', engines: { stt: sttAd('s'), tts: ttsAd('t'), llm: llmAd('l') } }] }],
    })),
    'activation',
  );
});

test('§9.3 컴포넌트 이름은 fallback.ts 의 목록 그대로다 — 임베딩은 rag(L3)', b, () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [fullPart({ embedding: embAd('emb-1') })] }],
  }));
  for (const c of r.components) {
    assert.ok(fb.COMPONENT_TIER[c] !== undefined, `알 수 없는 컴포넌트: ${c}`);
  }
  assert.equal(fb.COMPONENT_TIER[r.components[r.components.length - 1]], 'L3_knowledge');
});

// ── 복구 프로브 배선((카)(타)) ────────────────────────────────────────────────
// (38)이 러너를, (40)이 기동을 배선했는데 그 사이의 `HealthProbe` 구현이 0건이었다 —
// 찌를 것이 없으면 폴백에서 빠져나오는 길이 없다(§9.3).

const PROBE_SAMPLES = {
  stt: { data: new Uint8Array([1, 2]), mime: 'audio/wav' },
  tts: { text: '점검용 문장입니다', voice: 'v1' },
  llm: [{ role: 'user', content: '점검' }],
};

const PROBE_NOW = '2026-10-15T00:00:00.000Z';
const wiringOf = (reg) => ({ record: (s) => reg.record(s), now: () => PROBE_NOW });
const probeOf = (r, component) => r.probes.probes.find((p) => p.component === component);

/** 호출마다 실측 사용량을 갱신하는 조각. 프로브도 **같은 인스턴스**를 쓴다((타)). */
function usagePart(source = 'u') {
  let usage;
  let calls = 0;
  const llm = {
    name: 'llm-u',
    residency: 'onprem',
    complete: async function* () { calls += 1; usage = { llm_completion_tokens: calls }; yield 'ok'; },
  };
  return {
    kind: 'preassembled',
    source,
    engines: { activation: 'live', stt: sttAd('s'), tts: ttsAd('t'), llm, lastUsage: () => usage },
  };
}

test('프로브를 선언하지 않으면 필드 자체가 없다 — 빈 객체는 "배선했다"로 읽힌다', b, () => {
  assert.equal(m.startEngines(decl()).probes, undefined);
});

test('(카) 프로브는 조립만 된 주 세트를 찌른다 — 대체의 응답이 주 엔진의 up 이 되지 않는다', b, async () => {
  const r = m.startEngines(decl({
    sets: [
      { name: 'primary', parts: [fullPart({ llm: failingLlm('llm-dead') }, 'p', 'live')] },
      { name: 'backup', parts: [fullPart({}, 'bk', 'live')] },
    ],
    resilience: { attemptsPerCandidate: 1 },
    probes: { samples: PROBE_SAMPLES },
  }), wiringOf(memRegistry()));

  // 복원력 세트는 대체로 성공한다 — 통화는 살아 있다.
  let out = '';
  for await (const c of r.engines.llm.complete([{ role: 'user', content: '안녕' }])) out += c;
  assert.equal(out, '{"candidates":[]}');

  // 그런데 주 엔진은 죽어 있다. 프로브가 복원력 세트를 찌르면 이 사실이 영구히 관측되지 않는다.
  await assert.rejects(() => probeOf(r, 'llm').check(), (e) => e.code === 'E_TIMEOUT');
});

test('(타) 프로브가 남긴 사용량은 과금 근거로 나가지 않는다 — 0 이 아니라 모른다(§11.2)', b, async () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [usagePart()] }],
    resilience: { attemptsPerCandidate: 1 },
    probes: { samples: PROBE_SAMPLES },
  }), wiringOf(memRegistry()));
  assert.equal(r.lastUsage(), undefined, '호출 전에 사용량이 생겼다');

  for await (const _ of r.engines.llm.complete([{ role: 'user', content: 'x' }])) { /* 소비 */ }
  assert.deepEqual(r.lastUsage().usage, { llm_completion_tokens: 1 });

  // 프로브가 어댑터의 lastUsage() 를 덮었다. 엔진을 부르지 않은 턴이 이 값을 읽으면
  // **직전 프로브의 합성 호출이 그 통화의 과금 근거로 실린다**.
  await probeOf(r, 'llm').check();
  assert.equal(r.lastUsage(), undefined, '프로브 사용량이 과금 근거로 실렸다');
  assert.equal(r.lastUsage(), undefined, '두 번째 읽기에서 빗장이 풀렸다');

  // 실제 호출이 덮은 뒤에는 그대로 읽는다 — 영구히 막으면 실측이 사라진다.
  for await (const _ of r.engines.llm.complete([{ role: 'user', content: 'y' }])) { /* 소비 */ }
  assert.deepEqual(r.lastUsage().usage, { llm_completion_tokens: 3 });
});

test('(타) 사용량을 남기지 않는 프로브는 아무것도 막지 않는다 — 막으면 직전 턴의 실측이 사라진다', b, async () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [usagePart()] }],
    resilience: { attemptsPerCandidate: 1 },
    probes: { samples: PROBE_SAMPLES },
  }), wiringOf(memRegistry()));
  for await (const _ of r.engines.llm.complete([{ role: 'user', content: 'x' }])) { /* 소비 */ }
  // STT 프로브는 사용량을 바꾸지 않는다(이 조각의 실측은 llm 호출에서만 생긴다).
  await probeOf(r, 'stt').check();
  assert.deepEqual(r.lastUsage().usage, { llm_completion_tokens: 1 }, '프로브가 실측을 지웠다');
});

test('프로브 성공은 §9.3 샘플이 되고 러너를 지나 레지스트리에 들어갈 형태다', b, async () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [fullPart({}, 'p', 'live')] }],
    resilience: { attemptsPerCandidate: 1 },
    probes: { samples: PROBE_SAMPLES },
  }), wiringOf(memRegistry()));
  const s = await probeOf(r, 'tts').check();
  assert.deepEqual(
    { component: s.component, state: s.state, observedAt: s.observedAt },
    { component: 'tts', state: 'up', observedAt: PROBE_NOW },
  );
  assert.ok(s.detail.includes('후보 primary'));
});

test('dry_run 에서는 프로브가 만들어지지 않고 그 사실이 한계로 남는다 [승인 필요]', b, () => {
  const r = m.startEngines(decl({
    resilience: { attemptsPerCandidate: 1 },
    probes: { samples: PROBE_SAMPLES },
  }), wiringOf(memRegistry()));
  assert.deepEqual(r.probes.probes, []);
  assert.ok(r.probes.skipped.length > 0);
  assert.ok(r.limitsKo.some((x) => x.includes('프로브가 하나도 없다')));
});

test('프로브를 선언하면서 합성 입력을 주지 않으면 거절한다 — Core 는 오디오·문장을 만들지 않는다(§13-3)', b, () => {
  assertConfigError(
    () => m.startEngines(decl({ resilience: { attemptsPerCandidate: 1 }, probes: {} }), wiringOf(memRegistry())),
    '합성 입력(samples)',
  );
});

test('헬스 배선이 없으면 프로브를 만들지 않고 그 사실을 적는다 — 선언 검토 경로(enginePlan)가 이 상태다', b, () => {
  const r = m.startEngines(decl({
    sets: [{ name: 'primary', parts: [fullPart({}, 'p', 'live')] }],
    probes: { samples: PROBE_SAMPLES },
  }));
  assert.deepEqual(r.probes.probes, [], '시각 없는 샘플을 만드는 프로브가 생겼다');
  assert.ok(r.probes.skipped.some((s) => s.reason === 'no_clock'));
  assert.ok(r.limitsKo.some((x) => x.includes('관측 시계가 배선되지 않아')));
});

test('프로브 입력의 개인정보는 기동 시점에 거절한다 — 확인 주기마다 반복해서 나간다(§10.3)', b, () => {
  assertConfigError(
    () => m.startEngines(decl({
      sets: [{ name: 'primary', parts: [fullPart({}, 'p', 'live')] }],
      resilience: { attemptsPerCandidate: 1 },
      probes: { samples: { ...PROBE_SAMPLES, tts: { text: '010-1234-5678 확인' } } },
    }), wiringOf(memRegistry())),
    '합성 샘플이어야',
  );
});
