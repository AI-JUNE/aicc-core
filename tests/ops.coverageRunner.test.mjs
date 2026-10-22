// 커버리지 **실행기** 검사 — 계측이 실제로 성립하는지만 본다(판정 계산은 ops.coverage.test.mjs).
//
// 왜 따로 두는가: 판정 함수가 전부 초록인데도 이 저장소의 커버리지는 **한 번도 측정된 적이 없었다**.
// 깨진 자리는 둘 다 실행기 쪽이었고 둘 다 순수 함수 검사로는 잡히지 않는다 —
//  (1) 리포터를 절대경로로 넘기면 Windows 에서 ESM 로더가 `d:` 를 스킴으로 읽고 거부한다.
//  (2) 루트를 떼어 내기 전에 구분자를 통일하지 않으면 계측 대상 파일이 0개가 된다.
// 그래서 **실제 프로세스**를 띄워 마커까지 받아 본다. 수치를 단언하지 않는다(§13-3) —
// 여기서 고정하는 것은 "측정이 성립한다"이고, 수치는 측정할 때마다 달라진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarizeCoverage } from '../src/ops/coverage.ts';
import { COVERAGE_MARKER } from '../scripts/coverage-reporter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 자기 자신을 돌리면 재귀가 된다. 빠르고 src/ 를 실제로 건드리는 파일 하나만 고른다.
const TARGET = 'tests/channels.profiles.test.mjs';

/**
 * 테스트 안에서 테스트 실행기를 띄우므로 `NODE_TEST_CONTEXT` 를 **반드시 지운다**.
 * 남겨 두면 자식은 자기를 부모의 테스트 하위 프로세스로 알고 IPC 리포터를 쓰며,
 * `--test-reporter` 를 통째로 무시한다 — 마커가 안 나오고 종료코드는 0 이라
 * "리포터가 붙지 않았다"가 "통과"로 보인다.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

test('정상: 리포터를 파일 URL 로 넘기면 계측이 성립하고 src/ 파일이 잡힌다', () => {
  const reporter = new URL('../scripts/coverage-reporter.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, [
    '--test', '--experimental-test-coverage',
    `--test-reporter=${reporter}`, '--test-reporter-destination=stdout',
    TARGET,
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(), maxBuffer: 64 * 1024 * 1024 });

  assert.equal(run.status, 0, `실행기가 실패했다: ${String(run.stderr ?? '').split('\n')[0]}`);
  const line = String(run.stdout ?? '').split('\n').find((l) => l.startsWith(COVERAGE_MARKER));
  assert.ok(line, '계측 마커가 없다 — 리포터가 붙지 않았다');

  const report = summarizeCoverage(JSON.parse(line.slice(COVERAGE_MARKER.length)), { rootDir: ROOT });
  assert.equal(report.measured, true, '계측 대상이 0개면 수치가 아니라 판정보류가 남는다');
  assert.ok(report.files.every((f) => f.path.startsWith('src/')), '상대경로로 줄지 않았다');
  assert.ok(report.files.some((f) => f.path === 'src/channels/profiles.ts'));
  assert.ok(report.totals.lines.total > 0);
});

test('실패: 리포터 지정자가 틀리면 조용한 0%가 아니라 실행 실패로 끝난다', () => {
  const run = spawnSync(process.execPath, [
    '--test', '--experimental-test-coverage',
    '--test-reporter=./없는-리포터.mjs', '--test-reporter-destination=stdout',
    TARGET,
  ], { cwd: ROOT, encoding: 'utf8', env: childEnv(), maxBuffer: 8 * 1024 * 1024 });

  assert.notEqual(run.status, 0);
  assert.equal(String(run.stdout ?? '').includes(COVERAGE_MARKER), false);
  // 실행기는 이 사실을 **읽어서** 판정에 넘긴다 — 종전에는 표준오류를 읽지도 않았다.
  assert.ok(String(run.stderr ?? '').trim().length > 0, '원인이 표준오류에 남아 있어야 한다');
});

test('회귀 방지: 실행기는 리포터를 경로가 아니라 URL 로 넘긴다', () => {
  // 경로로 되돌리면 이 저장소의 주 개발 플랫폼(Windows)에서 계측이 통째로 꺼진다.
  const src = readFileSync(join(ROOT, 'scripts/coverage.mjs'), 'utf8');
  assert.match(src, /--test-reporter=\$\{REPORTER\}/);
  assert.match(src, /new URL\('\.\/coverage-reporter\.mjs', import\.meta\.url\)\.href/);
});
