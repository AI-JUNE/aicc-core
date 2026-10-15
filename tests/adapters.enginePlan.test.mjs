// 엔진 기동 계획 판정기·실행기 — §6.2·§9.3·§10.3·§13-3.
// 실행기 검사는 실제 프로세스를 띄우지만 **엔진을 부르지 않는다**(dry_run 선언만 확인한다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let m = null;
try {
  m = await import('../src/adapters/enginePlan.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'engine-plan.mjs');

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });

const fakeRuntime = (over = {}) => ({
  contractVersion: 1,
  activation: 'dry_run',
  residency: 'onprem',
  candidates: ['primary'],
  origins: [{ slot: 'llm', source: 'text', engineName: 'sllm-7b', residency: 'onprem' }],
  components: ['llm'],
  approvalPending: ['llm'],
  limitsKo: ['헬스 레지스트리가 배선되지 않았다'],
  ...over,
});

// ── 인자 해석 ────────────────────────────────────────────────────────────────

test('인자를 조용히 기본값으로 바꾸지 않는다 — 바꾸면 아무것도 검사하지 않은 CI 가 초록이 된다', b, () => {
  assert.ok(m.parseEnginePlanArgs([]).issuesKo.some((x) => x.includes('--declaration')));
  assert.ok(m.parseEnginePlanArgs(['--declaration']).issuesKo.some((x) => x.includes('값이 없습니다')));
  assert.ok(m.parseEnginePlanArgs(['--declaration', './d.mjs', '--expect-activation', 'yes']).issuesKo.length > 0);
  assert.ok(m.parseEnginePlanArgs(['--declaration', './d.mjs', '--bogus']).issuesKo.some((x) => x.includes('알 수 없는 인자')));
  const ok = m.parseEnginePlanArgs(['--declaration', './d.mjs', '--expect-activation', 'live', '--json']);
  assert.deepEqual(ok.issuesKo, []);
  assert.equal(ok.expectActivation, 'live');
  assert.equal(ok.json, true);
});

// ── 판정 ────────────────────────────────────────────────────────────────────

test('인자 문제·모듈 로드 실패는 판정보류(2) — 검사를 못 돌린 것은 통과가 아니다(§13-3)', b, () => {
  const bad = m.judgeEnginePlan({ args: m.parseEnginePlanArgs([]) });
  assert.equal(bad.verdict, 'indeterminate');
  assert.equal(bad.exitCode, 2);
  const load = m.judgeEnginePlan({
    args: m.parseEnginePlanArgs(['--declaration', './x.mjs', '--expect-activation', 'dry_run']),
    loadErrorKo: '모듈 없음',
  });
  assert.equal(load.exitCode, 2);
  assert.equal(load.activation, undefined, '기동하지 못했는데 사실이 실렸다');
});

test('선언이 성립하지 않으면 실패(1) — 판정보류와 구분한다', b, () => {
  const r = m.judgeEnginePlan({
    args: m.parseEnginePlanArgs(['--declaration', './x.mjs', '--expect-activation', 'dry_run']),
    startErrorKo: '필수 엔진 슬롯이 비어 있다',
  });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.exitCode, 1);
  assert.ok(r.reasonsKo[0].includes('성립하지 않습니다'));
});

test('활성화 기대값을 주지 않으면 판정보류 — live 가 된 선언이 통과로 적히지 않는다 [승인 필요]', b, () => {
  const r = m.judgeEnginePlan({
    args: m.parseEnginePlanArgs(['--declaration', './x.mjs']),
    runtime: fakeRuntime({ activation: 'live', approvalPending: [] }),
  });
  assert.equal(r.verdict, 'indeterminate');
  assert.equal(r.exitCode, 2);
  // 사실은 그대로 보여 준다 — 판정을 못 했다는 것이 "아무것도 모른다"는 뜻은 아니다.
  assert.equal(r.activation, 'live');
  assert.ok(r.reasonsKo.some((x) => x.includes('[승인 필요]')));
});

test('활성화가 기대와 다르면 실패 — 한 글자 변경으로 실호출이 켜지는 것을 막는다', b, () => {
  const r = m.judgeEnginePlan({
    args: m.parseEnginePlanArgs(['--declaration', './x.mjs', '--expect-activation', 'dry_run']),
    runtime: fakeRuntime({ activation: 'live' }),
  });
  assert.equal(r.exitCode, 1);
  assert.ok(r.reasonsKo[0].includes('live'));
});

test('통과해도 한계는 지우지 않는다 — 실패가 아니라 확인되지 않은 범위다(§13-3)', b, () => {
  const r = m.judgeEnginePlan({
    args: m.parseEnginePlanArgs(['--declaration', './x.mjs', '--expect-activation', 'dry_run']),
    runtime: fakeRuntime(),
  });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.limitsKo, ['헬스 레지스트리가 배선되지 않았다']);
  assert.deepEqual(r.slots, ['llm=sllm-7b@text(onprem)']);
});

test('기동 결과가 없으면 통과로 적지 않는다', b, () => {
  const r = m.judgeEnginePlan({ args: m.parseEnginePlanArgs(['--declaration', './x.mjs', '--expect-activation', 'dry_run']) });
  assert.equal(r.exitCode, 2);
});

test('사유는 개인정보·자격증명·배포 경로를 지운 뒤 남는다(§10.3)', b, () => {
  const out = m.safePlanReason(new Error(
    'Cannot find module /home/deploy/aicc/secret/dir/engines.mjs (api_key=sk-ABCD1234) 010-1234-5678',
  ));
  assert.ok(!out.includes('/home/deploy/aicc'), `배포 경로가 남았다: ${out}`);
  assert.ok(!out.includes('sk-ABCD1234'), `자격증명이 남았다: ${out}`);
  assert.ok(!out.includes('010-1234-5678'), `발신번호가 남았다: ${out}`);
});

test('출력에는 슬롯 출처·컴포넌트·승인 대기가 보이고 설정 원문은 없다', b, () => {
  const text = m.formatEnginePlan(m.judgeEnginePlan({
    args: m.parseEnginePlanArgs(['--declaration', './x.mjs', '--expect-activation', 'dry_run']),
    runtime: fakeRuntime(),
  }));
  assert.ok(text.includes('통과'));
  assert.ok(text.includes('llm=sllm-7b@text(onprem)'));
  assert.ok(text.includes('승인 전'));
  assert.ok(text.includes('(한계)'));
  // 프로브를 선언하지 않은 런타임에는 그 줄이 아예 없다 — 0건으로 적으면 "확인 안 되고 있다"가
  // "확인하기로 했는데 안 된다"로 읽힌다.
  assert.ok(!text.includes('복구 프로브'), text);
});

test('복구 프로브는 선언했을 때만 적고, 0건이면 사유까지 적는다(§9.3·§13-3)', b, () => {
  const text = m.formatEnginePlan(m.judgeEnginePlan({
    args: m.parseEnginePlanArgs(['--declaration', './x.mjs', '--expect-activation', 'dry_run']),
    runtime: fakeRuntime({
      probes: { probes: [], skipped: [{ component: 'llm', slot: 'llm', reason: 'not_activated', reasonKo: '승인 전' }], limitsKo: [], describeKo: '' },
    }),
  }));
  assert.ok(text.includes('복구 프로브: 0건'), text);
  assert.ok(text.includes('미생성 llm: not_activated'), text);

  const made = m.judgeEnginePlan({
    args: m.parseEnginePlanArgs(['--declaration', './x.mjs', '--expect-activation', 'dry_run']),
    runtime: fakeRuntime({
      probes: { probes: [{ component: 'llm', check: async () => ({}) }], skipped: [], limitsKo: [], describeKo: '' },
    }),
  });
  assert.deepEqual(made.probes, ['llm']);
  assert.deepEqual(made.probeSkipped, []);
});

// ── 실행기(실제 프로세스) ────────────────────────────────────────────────────

test('실행기: 참조 선언은 dry_run 기대로 통과한다(종료코드 0)', b, () => {
  const r = run('--declaration', './fixtures/reference-engines.mjs', '--expect-activation', 'dry_run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('엔진 기동 계획: 통과'), r.stdout);
  assert.ok(r.stdout.includes('§9.3 컴포넌트'), r.stdout);
  // 참조 선언은 프로브 합성 입력을 선언하지만 dry_run 이라 하나도 만들어지지 않는다 [승인 필요].
  assert.ok(r.stdout.includes('복구 프로브: 0건'), r.stdout);
  assert.ok(r.stdout.includes('미생성 stt: not_activated'), r.stdout);
  // 비밀값 참조 이름·설정 원문은 출력하지 않는다(§10.3).
  assert.ok(!r.stdout.includes('AICC_LLM_API_KEY'), r.stdout);
  assert.ok(!r.stdout.includes('baseUrl'), r.stdout);
});

test('실행기: live 를 기대하면 dry_run 선언은 실패다(종료코드 1)', b, () => {
  const r = run('--declaration', './fixtures/reference-engines.mjs', '--expect-activation', 'live');
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stdout.includes('실패'), r.stdout);
});

test('실행기: 활성화 기대값을 빼면 판정보류다(종료코드 2)', b, () => {
  const r = run('--declaration', './fixtures/reference-engines.mjs');
  assert.equal(r.status, 2, r.stdout);
  assert.ok(r.stdout.includes('판정보류'), r.stdout);
});

test('실행기: 없는 모듈은 판정보류이고 실행 경로를 되돌려주지 않는다', b, () => {
  const r = run('--declaration', './fixtures/없는선언.mjs', '--expect-activation', 'dry_run');
  assert.equal(r.status, 2, r.stdout);
  assert.ok(r.stdout.includes('판정보류'), r.stdout);
  assert.ok(!/[A-Za-z]:[\\/]/.test(r.stdout), `절대경로가 남았다: ${r.stdout}`);
});

test('실행기: 엔진 선언이 없는 모듈은 판정보류다 — 빈 모듈을 "선언이 비었다"로 읽지 않는다', b, () => {
  // 시나리오 모듈을 잘못 지정한 경우. 통과도 실패도 아니라 **검사를 돌리지 못한 것**이다.
  const r = run('--declaration', './fixtures/reference-flows.mjs', '--expect-activation', 'dry_run');
  assert.equal(r.status, 2, `${r.status}: ${r.stdout}`);
  assert.ok(!r.stdout.includes('계획: 통과'), r.stdout);
  assert.ok(r.stdout.includes('export 가 없습니다'), r.stdout);
});

test('실행기: 인자가 없으면 사용법을 내고 1, --help 는 0', b, () => {
  assert.equal(run().status, 1);
  assert.equal(run('--help').status, 0);
  assert.ok(run('--help').stdout.includes('--expect-activation'));
});

test('실행기: --json 은 판정을 기계가 읽을 형태로 낸다', b, () => {
  const r = run('--declaration', './fixtures/reference-engines.mjs', '--expect-activation', 'dry_run', '--json');
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'pass');
  assert.equal(parsed.activation, 'dry_run');
  assert.deepEqual(parsed.components, ['stt', 'tts', 'llm', 'rag']);
  assert.deepEqual(parsed.approvalPending, ['stt', 'tts', 'llm', 'rag']);
});
