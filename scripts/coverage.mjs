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
} from '../src/ops/coverage.ts';
import { safeReasonText } from '../src/channels/harness.ts';
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

// 리포터는 **파일 URL** 로 넘긴다. `join()` 이 만드는 절대경로는 POSIX 에서만 통하고,
// Windows 에서는 ESM 로더가 `D:\...` 의 `d:` 를 스킴으로 읽어 거부한다
// (ERR_UNSUPPORTED_ESM_URL_SCHEME) — 그러면 계측은 **한 번도 돌지 않고** 판정보류만 남는다.
// 저장소의 다른 실행기들이 전부 `pathToFileURL` 을 쓰는 것과 같은 이유다.
const REPORTER = new URL('./coverage-reporter.mjs', import.meta.url).href;

const run = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  `--test-reporter=${REPORTER}`,
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

// 실행이 성립하지 않았다는 **사실**만 모은다. 판정은 `evaluateCoverage` 한 곳이 한다(§2).
const runIssuesKo = [];
if (failed.length > 0) runIssuesKo.push(`테스트 ${failed.length}건이 실패했습니다 — 커버리지보다 먼저 고치세요.`);
if (run.error) runIssuesKo.push(`테스트 실행기를 띄우지 못했습니다: ${safeReasonText(run.error)}`);
if (run.status !== 0 && failed.length === 0) {
  // 종전에는 종료코드만 적고 자식의 표준오류를 **읽지도 않았다**. 그러면 "계측이 꺼졌을 수
  // 있습니다"라는 추측이 남고, 실제 원인(로더 거부·설정 오류)은 통째로 사라진다(§9.3).
  const stderrTail = String(run.stderr ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const why = stderrTail.length > 0 ? safeReasonText(stderrTail[0]) : '표준오류가 비어 있습니다';
  runIssuesKo.push(`테스트 실행기가 종료코드 ${run.status} 로 끝났습니다: ${why}`);
}

const report = summarizeCoverage(raw, { rootDir: ROOT });
// 실행 사실을 판정에 **넘긴다**. 넘기지 않으면 텍스트·JSON·종료코드가 서로 다른 말을 한다 —
// 깨진 실행이 `--json` 에서는 수치까지 붙은 "측정 완료"로 기록된다.
const ev = evaluateCoverage(report, thresholds, { issuesKo: runIssuesKo });

console.log(argv.includes('--json') ? coverageToJson(ev) : formatCoverageReport(ev));
process.exitCode = ev.exitCode;
