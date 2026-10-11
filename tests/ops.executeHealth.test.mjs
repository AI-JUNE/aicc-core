// readiness 실행기 — `src/ops/executeHealth.ts`.
//
// 이 모듈이 막는 것은 전부 **조용한 오답**이다(응답은 200 으로 잘 나간다):
//  (가) §9.3 폴백 상태가 응답에 닿지 않는다 → AI 가 한 통도 응대하지 않는데 대시보드는 초록
//  (나) 그 사실로 503 을 낸다 → 폴백 경로까지 같이 죽는다
//  (다) 미관측을 정상·장애로 적는다 → 신호 안 올리는 채널이 가장 건강하거나, 배포가 안 뜬다
//  (라) 승인 전 엔진을 장애로 적는다 → 켜 보기도 전에 영구 장애
//  (마) detail 에 접속 문자열·개인정보가 실린다 → /health 는 사실상 공개 엔드포인트
// 그래서 검사도 "예외가 나는가"가 아니라 **무엇이라고 적히는가**를 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null, F = null;
try {
  m = await import('../src/ops/executeHealth.ts');
  F = await import('../src/ops/fallback.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-11T09:00:00.000Z';
const VOICE = ['telephony', 'stt', 'tts', 'llm', 'rag', 'backend'];

const policy = (over = {}) => ({
  tenantId: 'goone', staleAfterMs: 60_000, treatUnknownAsDown: false,
  legacyIvrAvailable: false, agentQueueAvailable: true, ...over,
});

const sample = (component, state, over = {}) => ({
  component, state, observedAt: NOW, ...over,
});

const facts = (over = {}) => ({
  nowIso: NOW,
  registry: F.createHealthRegistry(over.samples ?? []),
  policy: policy(over.policy),
  components: over.components ?? VOICE,
  ...(over.approvalPending !== undefined ? { approvalPending: over.approvalPending } : {}),
  ...(over.channels !== undefined ? { channels: over.channels } : {}),
});

const okProbe = (name, over = {}) => ({
  name, kind: 'db', critical: true, check: async () => ({ status: 'up' }), ...over,
});

const dep = (report, name) => report.dependencies.find((d) => d.name === name);

// ── 선언하지 않으면 종전과 완전히 같다(§13-3) ──────────────────────────────────

test('core 를 주지 않으면 checkHealth 결과 그대로이고 core 필드가 없다', b, async () => {
  const r = await m.runReadiness({ probes: [okProbe('primary-db')], timeoutMs: 500 });
  assert.equal(r.status, 'up');
  assert.equal(r.httpStatus, 200);
  assert.equal(r.kind, 'readiness');
  assert.equal('core' in r, false, 'core 필드를 만들면 "관측했고 비었다"로 읽힌다');
  assert.equal(r.dependencies.length, 1);
});

test('프로브도 core 도 없으면 의존성 0건으로 끝난다 — 빈 입력에서 던지지 않는다', b, async () => {
  const r = await m.runReadiness({ timeoutMs: 500 });
  assert.equal(r.status, 'up');
  assert.deepEqual(r.dependencies, []);
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('컴포넌트가 전부 정상이면 up·200 이고 폴백은 normal 이다', b, async () => {
  const r = await m.runReadiness({
    probes: [okProbe('primary-db')],
    timeoutMs: 500,
    core: facts({ samples: VOICE.map((c) => sample(c, 'up')), channels: ['voice'] }),
  });
  assert.equal(r.status, 'up');
  assert.equal(r.httpStatus, 200);
  assert.equal(r.dependencies.length, 1 + VOICE.length);
  assert.equal(r.core.fallback.length, 1);
  assert.equal(r.core.fallback[0].mode, 'normal');
  assert.equal(r.core.fallback[0].aiAllowed, true);
  assert.match(r.core.summaryKo, /AI 응대 유지/);
  assert.match(r.core.summaryKo, /모두 정상/);
  assert.deepEqual(r.core.warningsKo, []);
});

test('Core 항목 이름은 접두가 고정이라 호스트 프로브와 섞이지 않는다', b, async () => {
  const r = await m.runReadiness({
    probes: [okProbe('stt')],
    timeoutMs: 500,
    core: facts({ samples: [sample('stt', 'up')], components: ['stt'], channels: ['voice'] }),
  });
  assert.equal(m.CORE_DEPENDENCY_PREFIX, 'core:');
  assert.ok(dep(r, 'core:stt'), 'Core 관측은 core: 접두로 실린다');
  assert.ok(dep(r, 'stt'), '호스트 프로브 이름은 바꾸지 않는다');
  assert.equal(dep(r, 'core:stt').kind, 'engine');
});

test('관측된 실측(지연·실패율·관측시각)만 싣는다 — 없는 값은 만들지 않는다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({
      samples: [sample('llm', 'up', { latencyMs: 820, errorRate: 0.02 }), sample('rag', 'up')],
      components: ['llm', 'rag'],
    }),
  });
  const llm = r.core.components.find((c) => c.component === 'llm');
  assert.equal(llm.latencyMs, 820);
  assert.equal(llm.errorRate, 0.02);
  assert.equal(llm.observedAt, NOW);
  assert.equal(llm.tier, 'L2_cognition');
  const rag = r.core.components.find((c) => c.component === 'rag');
  assert.equal('latencyMs' in rag, false);
  assert.equal('errorRate' in rag, false);
});

test('찌르지 않았으므로 소요·실패코드를 만들지 않는다(§13-3)', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500, clock: () => 1_700_000_000_000,
    core: facts({ samples: [sample('stt', 'up')], components: ['stt'] }),
  });
  assert.equal('durationMs' in dep(r, 'core:stt'), false);
  assert.equal('code' in dep(r, 'core:stt'), false);
});

// ── (가) 폴백 상태가 응답에 닿는다 ────────────────────────────────────────────

test('엔진 프로브가 초록이어도 AI 응대가 멈춘 사실이 보고서에 적힌다', b, async () => {
  // 호스트 프로브는 전부 정상 — 종전 구현이라면 여기서 "모두 정상"으로 끝났다.
  const r = await m.runReadiness({
    probes: [okProbe('primary-db'), okProbe('engine-http', { kind: 'engine' })],
    timeoutMs: 500,
    core: facts({
      samples: [...VOICE.map((c) => sample(c, 'up')), sample('stt', 'down')],
      channels: ['voice'],
    }),
  });
  assert.equal(r.core.fallback[0].aiAllowed, false);
  assert.match(r.core.summaryKo, /AI 응대 중단 채널 1곳: voice\(/);
  assert.match(r.core.fallback[0].reasonKo, /./);
  assert.ok(r.core.fallback[0].disable.includes('ai_response'));
});

test('채널마다 의존 컴포넌트가 달라 한쪽만 멈춘 사실이 보인다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({
      samples: [sample('stt', 'down'), sample('messaging', 'up'), sample('llm', 'up')],
      components: ['stt', 'messaging', 'llm'],
      channels: ['voice', 'chat'],
    }),
  });
  const byCh = Object.fromEntries(r.core.fallback.map((f) => [f.channel, f.aiAllowed]));
  assert.equal(byCh.voice, false, 'STT 장애는 음성만 멈춘다');
  assert.equal(byCh.chat, true, '채팅에서 STT 장애로 내리면 오탐이다');
});

// ── (나) 컴포넌트 저하는 503 을 만들지 않는다 ─────────────────────────────────

test('모든 컴포넌트가 down 이어도 503 이 아니다 — 폴백 경로가 이 프로세스를 지난다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ samples: VOICE.map((c) => sample(c, 'down')), channels: ['voice'] }),
  });
  assert.equal(r.status, 'degraded');
  assert.equal(r.httpStatus, 200, '503 을 내면 로드밸런서가 인스턴스를 빼 상담사 이관까지 죽는다');
  assert.ok(r.dependencies.every((d) => d.critical === false));
});

test('호스트가 선언한 필수 의존성 장애는 그대로 503 이다', b, async () => {
  const r = await m.runReadiness({
    probes: [okProbe('primary-db', { check: async () => ({ status: 'down', detail: '접속 거부' }) })],
    timeoutMs: 500,
    core: facts({ samples: VOICE.map((c) => sample(c, 'up')), channels: ['voice'] }),
  });
  assert.equal(r.status, 'down');
  assert.equal(r.httpStatus, 503, '무엇이 필수인지는 호스트만 안다(§6.2)');
});

test('요약 문장은 ops/health.ts 것을 그대로 쓴다 — 합성 뒤에도 전체 건수로 적힌다', b, async () => {
  const r = await m.runReadiness({
    probes: [okProbe('primary-db')],
    timeoutMs: 500,
    core: facts({ samples: VOICE.map((c) => sample(c, 'up')), channels: ['voice'] }),
  });
  assert.match(r.summaryKo, new RegExp(`의존성 ${1 + VOICE.length}건 모두 정상`));
});

// ── (다) 미관측 ──────────────────────────────────────────────────────────────

test('샘플이 없는 컴포넌트를 up 으로 적지 않는다 — 신호를 안 올리는 채널이 가장 건강해 보인다', b, async () => {
  const r = await m.runReadiness({ timeoutMs: 500, core: facts({ components: ['stt'] }) });
  assert.equal(dep(r, 'core:stt').status, 'degraded');
  assert.equal(r.core.components[0].state, 'unknown');
  assert.equal('observedAt' in r.core.components[0], false, '없는 관측 시각을 만들지 않는다');
  assert.match(dep(r, 'core:stt').detail, /모른다/);
  assert.equal(r.httpStatus, 200, 'down 으로 적으면 방금 띄운 인스턴스가 영구 장애다');
});

test('낡은 샘플도 up 으로 믿지 않는다 — 판정은 effectiveComponentState 하나다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ samples: [sample('stt', 'up', { observedAt: '2026-10-11T08:00:00.000Z' })], components: ['stt'] }),
  });
  assert.equal(r.core.components[0].state, 'unknown');
  assert.equal(
    r.core.components[0].state,
    F.effectiveComponentState(F.createHealthRegistry([sample('stt', 'up', { observedAt: '2026-10-11T08:00:00.000Z' })]).latest('stt'), policy(), NOW),
  );
});

test('정책이 미관측을 장애로 보면 그대로 적되 "관측이 아니라 정책"임을 남긴다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ components: ['stt'], policy: { treatUnknownAsDown: true } }),
  });
  assert.equal(dep(r, 'core:stt').status, 'down');
  assert.match(dep(r, 'core:stt').detail, /정책 판정/);
  assert.equal(r.httpStatus, 200, '정책으로 만든 down 이 인스턴스를 빼지 않는다');
});

test('관측된 down 은 정책 문구를 붙이지 않는다 — 운영이 멀쩡한 설정을 뒤지게 된다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ samples: [sample('stt', 'down', { detail: 'STT 5xx 연속' })], components: ['stt'] }),
  });
  assert.equal(dep(r, 'core:stt').status, 'down');
  assert.equal(/정책 판정/.test(dep(r, 'core:stt').detail), false);
  assert.match(dep(r, 'core:stt').detail, /STT 5xx 연속/);
});

test('관측 시각이 ISO8601 이 아니면 낡음을 판정하지 못한 사실을 적는다', b, async () => {
  const f = facts({ samples: [sample('stt', 'up')], components: ['stt'] });
  const r = await m.runReadiness({ timeoutMs: 500, core: { ...f, nowIso: '어제' } });
  assert.ok(r.core.warningsKo.some((w) => /ISO8601/.test(w)));
  assert.equal(r.core.components[0].state, 'unknown');
});

test('샘플의 관측 시각이 시각 형태가 아니면 싣지 않는다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ samples: [sample('stt', 'up', { observedAt: 'n/a' })], components: ['stt'] }),
  });
  assert.equal('observedAt' in r.core.components[0], false);
});

// ── (라) 승인 전 ─────────────────────────────────────────────────────────────

test('활성화 전 컴포넌트는 degraded 이고 [승인 필요] 가 적힌다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ components: ['stt', 'llm'], approvalPending: ['llm'], channels: ['voice'] }),
  });
  assert.equal(dep(r, 'core:llm').status, 'degraded');
  assert.match(dep(r, 'core:llm').detail, /\[승인 필요\]/);
  assert.equal(r.httpStatus, 200, 'down 이면 켜 보기도 전에 영구 장애다');
  const llm = r.core.components.find((c) => c.component === 'llm');
  assert.equal(llm.approvalPending, true);
  assert.equal(llm.state, 'unknown', '실엔진을 관측한 적이 없다');
});

test('활성화 전인데 샘플이 올라오면 그 모순을 드러낸다 — dry_run 샘플을 up 으로 싣지 않는다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ samples: [sample('llm', 'up', { latencyMs: 10 })], components: ['llm'], approvalPending: ['llm'] }),
  });
  assert.equal(dep(r, 'core:llm').status, 'degraded');
  assert.match(dep(r, 'core:llm').detail, /실엔진 관측이 아니다/);
  const llm = r.core.components[0];
  assert.equal('latencyMs' in llm, false, 'dry_run 샘플의 실측을 실엔진 실측으로 적지 않는다');
  assert.equal('observedAt' in llm, false);
});

test('선언하지 않은 컴포넌트를 활성화 전으로 적으면 싣지 않고 경고로 남긴다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ components: ['stt'], approvalPending: ['tts'] }),
  });
  assert.equal(dep(r, 'core:tts'), undefined);
  assert.ok(r.core.warningsKo.some((w) => /활성화 전으로 적었다/.test(w)));
});

// ── (마) 마스킹·공개 엔드포인트 ───────────────────────────────────────────────

test('샘플 detail 의 개인정보·자격증명·절대경로를 지운다(§10.3)', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({
      samples: [sample('backend', 'down', {
        detail: '010-1234-5678 조회 실패 postgres://svc:p4ssw0rd@db.internal:5432/aicc — /srv/app/dist/bundle/engine.js',
      })],
      components: ['backend'],
    }),
  });
  const detail = dep(r, 'core:backend').detail;
  assert.equal(/010-1234-5678/.test(detail), false);
  assert.equal(/p4ssw0rd/.test(detail), false);
  assert.equal(/\/srv\/app\/dist\/bundle/.test(detail), false);
});

test('모르는 컴포넌트 이름을 그대로 되돌려주지 않는다 — 호 ID·발신번호가 들어온다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ components: ['stt', '010-9876-5432'] }),
  });
  const warn = r.core.warningsKo.join(' | ');
  assert.match(warn, /모르는 컴포넌트/);
  assert.equal(/010-9876-5432/.test(warn), false);
  assert.equal(dep(r, 'core:010-9876-5432'), undefined);
});

// ── 경계·실패 경로 ───────────────────────────────────────────────────────────

test('컴포넌트 선언이 비면 "점검되지 않았다"를 적는다 — 0건을 정상으로 읽지 않는다', b, async () => {
  const r = await m.runReadiness({ timeoutMs: 500, core: facts({ components: [], channels: ['voice'] }) });
  assert.ok(r.core.warningsKo.includes(m.NO_COMPONENTS_DECLARED_KO));
  assert.match(r.core.summaryKo, /컴포넌트 관측 없음/);
});

test('채널 선언이 없으면 폴백 판정을 하지 않고 그 사실을 적는다(§13-3)', b, async () => {
  const r = await m.runReadiness({ timeoutMs: 500, core: facts({ components: ['stt'] }) });
  assert.deepEqual(r.core.fallback, []);
  assert.ok(r.core.warningsKo.includes(m.NO_CHANNELS_DECLARED_KO));
  assert.match(r.core.summaryKo, /폴백 모드 판정 없음/);
});

test('컴포넌트 중복 선언은 조용히 지우지 않고 드러낸다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ samples: [sample('stt', 'up')], components: ['stt', 'stt'] }),
  });
  assert.equal(r.dependencies.filter((d) => d.name === 'core:stt').length, 1);
  assert.ok(r.core.warningsKo.some((w) => /중복/.test(w)));
});

test('모르는 채널은 건너뛰고 경고로 남긴다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ components: ['stt'], channels: ['voice', 'fax'] }),
  });
  assert.deepEqual(r.core.fallback.map((f) => f.channel), ['voice']);
  assert.ok(r.core.warningsKo.some((w) => /모르는 채널/.test(w)));
});

test('레지스트리가 던져도 보고서가 나오고 그 사실이 경고로 남는다', b, async () => {
  const broken = { latest: () => { throw new Error('store down'); }, snapshot: () => [] };
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: { nowIso: NOW, registry: broken, policy: policy(), components: ['stt'] },
  });
  assert.equal(dep(r, 'core:stt').status, 'degraded');
  assert.ok(r.core.warningsKo.some((w) => /레지스트리 조회가 실패/.test(w)));
});

test('레지스트리가 규약을 어긴 값을 돌려주면 up 으로도 읽지 않는다', b, async () => {
  const broken = { latest: () => 'up', snapshot: () => [] };
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: { nowIso: NOW, registry: broken, policy: policy(), components: ['stt'] },
  });
  assert.equal(dep(r, 'core:stt').status, 'degraded');
  assert.ok(r.core.warningsKo.some((w) => /규약을 어긴 샘플/.test(w)));
});

test('폴백 판정이 던져도 컴포넌트 항목은 살아남는다', b, async () => {
  const broken = {
    latest: (c) => (c === 'telephony' ? (() => { throw new Error('boom'); })() : undefined),
    snapshot: () => [],
  };
  // latest 는 컴포넌트 수집에서 잡히고, decideFallbackMode 안에서도 같은 예외가 난다.
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: { nowIso: NOW, registry: broken, policy: policy(), components: ['stt'], channels: ['voice'] },
  });
  assert.ok(dep(r, 'core:stt'));
  assert.ok(r.core.warningsKo.some((w) => /폴백 판정이 실패/.test(w)));
  assert.deepEqual(r.core.fallback, []);
});

test('프로브 목록이 규약을 어겨도 "점검했고 정상"으로 적지 않는다', b, async () => {
  const r = await m.runReadiness({ probes: 'not-an-array', timeoutMs: 500, core: facts({ components: ['stt'] }) });
  // 배열이 아니면 프로브를 돌리지 않는다 — 그 사실은 의존성 0건으로 보이고 거짓 up 이 아니다.
  assert.equal(r.dependencies.some((d) => d.critical === true), false);
  assert.equal(r.status, 'degraded');
});

test('호스트 프로브가 던져도 Core 관측은 그대로 실린다', b, async () => {
  const r = await m.runReadiness({
    probes: [okProbe('primary-db', { check: async () => { throw new Error('boom'); } })],
    timeoutMs: 500,
    core: facts({ samples: [sample('stt', 'up')], components: ['stt'] }),
  });
  assert.equal(dep(r, 'primary-db').status, 'down');
  assert.equal(dep(r, 'core:stt').status, 'up');
  assert.equal(r.httpStatus, 503, '필수 프로브가 죽었다 — 이건 호스트의 판정이다');
});

test('호스트가 Core 접두를 쓰면 구분되지 않는 사실을 드러낸다', b, async () => {
  const r = await m.runReadiness({
    probes: [okProbe('core:stt')],
    timeoutMs: 500,
    core: facts({ samples: [sample('stt', 'up')], components: ['stt'] }),
  });
  assert.ok(r.core.warningsKo.some((w) => /Core 접두/.test(w)));
  assert.equal(r.dependencies.filter((d) => d.name === 'core:stt').length, 2, '이름을 조용히 바꾸면 그 프로브의 알림이 끊긴다');
});

test('제한 시간이 없으면 호스트 프로브는 down 이지만 Core 관측은 영향받지 않는다', b, async () => {
  const r = await m.runReadiness({
    probes: [okProbe('primary-db')],
    timeoutMs: 0,
    core: facts({ samples: [sample('stt', 'up')], components: ['stt'] }),
  });
  assert.equal(dep(r, 'primary-db').status, 'down');
  assert.equal(dep(r, 'core:stt').status, 'up', '설정 오류가 엔진 상태로 둔갑하지 않는다');
});

test('빌드 정보·점검 시각은 주입이 있을 때만 실린다(§13-3)', b, async () => {
  const bare = await m.runReadiness({ timeoutMs: 500, core: facts({ components: ['stt'] }) });
  assert.equal('checkedAt' in bare, false);
  assert.equal('build' in bare, false);

  const r = await m.runReadiness({
    timeoutMs: 500, clock: () => Date.parse(NOW),
    build: { version: '0.1.0', commit: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4' },
    core: facts({ components: ['stt'] }),
  });
  assert.equal(r.checkedAt, NOW);
  assert.equal(r.build.commit, 'a1b2c3d4e5f6');
});

test('한 줄 요약은 보고서에 있는 사실만 옮긴다', b, async () => {
  const r = await m.runReadiness({
    timeoutMs: 500,
    core: facts({ samples: [sample('stt', 'down')], components: ['stt'], channels: ['voice'] }),
  });
  const text = m.formatReadinessReport(r);
  assert.match(text, /readiness: degraded \(HTTP 200\)/);
  assert.match(text, /§9\.3: AI 응대 중단 채널 1곳/);
});

test('계약 버전이 노출된다', b, () => {
  assert.equal(typeof m.HEALTH_EXECUTION_CONTRACT_VERSION, 'number');
});

// ── 판정을 복사하지 않는다(§2) ───────────────────────────────────────────────

test('컴포넌트 등급·의존 관계·AI 가능 판정을 자기 사본으로 두지 않는다', b, async () => {
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/ops/executeHealth.ts', import.meta.url), 'utf8',
  );
  // 정책 **필드를 직접 읽는** 코드가 있으면 낡음·미관측 해석이 두 곳에 생긴다.
  // (문구로 언급하는 것은 사본이 아니다 — 읽는 사람에게 정책의 결과임을 알려야 한다.)
  for (const banned of ['policy.staleAfterMs', 'policy.treatUnknownAsDown', "=== 'agent_only'", 'L2_cognition:']) {
    assert.equal(src.includes(banned), false, `판정 사본을 두면 안 된다: ${banned}`);
  }
  assert.ok(src.includes('effectiveComponentState'));
  assert.ok(src.includes('aiResponseAllowed'));
  assert.ok(src.includes('summarizeDependencies'));
});
