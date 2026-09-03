// 커버리지 계측 실행기 — 실측치를 낸다. 목표치를 만들어내지 않는다(§13-3).
//
// 사용: node scripts/coverage.mjs [--json] [--min-line 70] [--min-branch 60] [--min-func 70]
// 임계값은 인자 또는 환경변수(AICC_COVERAGE_MIN_LINE·_BRANCH·_FUNC)로 준다.
// 하나도 주지 않으면 **게이트로 쓰지 않고 측정만** 한다 — 근거 없는 목표치를 코드에 박지 않기 위해서다.
//
// 종료코드: 0=통과·측정완료, 1=임계값 미달 또는 테스트 실패, 2=판정보류(계측이 아무것도 못 봄).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  summarizeCoverage, evaluateCoverage, thresholdsFromEnv, formatCoverageReport, coverageToJson,
  COVERAGE_EXIT_CODE,
} from '../src/ops/coverage.ts';
import { COVERAGE_MARKER } from './coverage-reporter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function numArg(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

const thresholds = { ...thresholdsFromEnv(process.env) };
for (const [flag, metric] of [['min-line', 'lines'], ['min-branch', 'branches'], ['min-func', 'functions']]) {
  const v = numArg(flag);
  if (v !== undefined) thresholds[metric] = v;
}

const run = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  `--test-reporter=${join(ROOT, 'scripts', 'coverage-reporter.mjs')}`,
  '--test-reporter-destination=stdout',
  'tests/*.test.mjs',
], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const out = run.stdout ?? '';
const failed = out.split('\n').filter((l) => l.startsWith('TEST_FAIL '));
const line = out.split('\n').find((l) => l.startsWith(COVERAGE_MARKER));

let raw = null;
if (line !== undefined) {
  try { raw = JSON.parse(line.slice(COVERAGE_MARKER.length)); } catch { raw = null; }
}

const report = summarizeCoverage(raw, { rootDir: ROOT });
const ev = evaluateCoverage(report, thresholds);

if (argv.includes('--json')) {
  console.log(coverageToJson(ev));
} else {
  console.log(formatCoverageReport(ev));
  if (failed.length > 0) console.log(`  ! 테스트 ${failed.length}건이 실패했습니다 — 커버리지보다 먼저 고치세요.`);
  if (run.status !== 0 && failed.length === 0) console.log(`  ! 테스트 실행기가 종료코드 ${run.status} 로 끝났습니다.`);
}

// 테스트가 깨진 상태의 커버리지 수치는 근거가 되지 않는다. 무조건 실패로 돌린다.
process.exitCode = (failed.length > 0 || run.status !== 0)
  ? COVERAGE_EXIT_CODE.failed
  : ev.exitCode;
