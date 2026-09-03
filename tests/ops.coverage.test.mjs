// 커버리지 계측 테스트 — 정상 경로 + 실패 경로.
// 실제 계측을 돌리지 않는다(그건 scripts/coverage.mjs 의 몫). 여기서는 요약·판정 계산만 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeCoverage, evaluateCoverage, thresholdsFromEnv, percentOf, weakestFiles,
  formatCoverageReport, coverageToJson, COVERAGE_EXIT_CODE,
} from '../src/ops/coverage.ts';

const ROOT = '/repo';
const file = (path, l, lt, b, bt, f, ft) => ({
  path, coveredLineCount: l, totalLineCount: lt,
  coveredBranchCount: b, totalBranchCount: bt,
  coveredFunctionCount: f, totalFunctionCount: ft,
});

// ── 요약 ─────────────────────────────────────────────────────────────────────

test('정상: 소스만 남기고 테스트·스크립트를 제외한다', () => {
  const r = summarizeCoverage({ files: [
    file('/repo/src/a.ts', 90, 100, 5, 10, 2, 2),
    file('/repo/tests/a.test.mjs', 10, 10, 1, 1, 1, 1),
    file('/repo/scripts/x.mjs', 1, 10, 0, 2, 0, 1),
  ] }, { rootDir: ROOT });
  assert.equal(r.measured, true);
  assert.deepEqual(r.files.map((f) => f.path), ['src/a.ts']);
  assert.equal(r.excludedCount, 2);
});

test('정상: 전체 비율은 파일 퍼센트의 평균이 아니라 건수 합으로 낸다', () => {
  // 평균을 내면 (100 + 50)/2 = 75%. 건수 합이면 (10+50)/(10+100) = 54.5%.
  const r = summarizeCoverage({ files: [
    file('/repo/src/small.ts', 10, 10, 0, 0, 1, 1),
    file('/repo/src/big.ts', 50, 100, 0, 0, 1, 2),
  ] }, { rootDir: ROOT });
  assert.deepEqual(r.totals.lines, { covered: 60, total: 110 });
  assert.ok(Math.abs(percentOf(r.totals.lines) - 54.5454) < 0.01);
});

test('정상: 계측 대상 접두사를 바꿀 수 있다', () => {
  const r = summarizeCoverage({ files: [file('/repo/lib/a.ts', 1, 2, 0, 0, 0, 0)] }, { rootDir: ROOT, includePrefixes: ['lib/'] });
  assert.equal(r.measured, true);
  assert.equal(r.files[0].path, 'lib/a.ts');
});

test('실패: 파일이 하나도 없으면 0%가 아니라 미측정이다', () => {
  const r = summarizeCoverage({ files: [] }, { rootDir: ROOT });
  assert.equal(r.measured, false);
  assert.deepEqual(r.totals.lines, { covered: 0, total: 0 });
  assert.match(r.notesKo[0], /파일을 하나도 보지 못했습니다/);
});

test('실패: 요약이 아예 없거나 모양이 어긋나도 던지지 않는다', () => {
  for (const bad of [null, undefined, {}, { files: 'nope' }]) {
    const r = summarizeCoverage(bad, { rootDir: ROOT });
    assert.equal(r.measured, false);
  }
});

test('실패: 대상 접두사에 걸리는 파일이 없으면 미측정으로 남긴다', () => {
  const r = summarizeCoverage({ files: [file('/repo/tests/a.test.mjs', 1, 1, 0, 0, 0, 0)] }, { rootDir: ROOT });
  assert.equal(r.measured, false);
  assert.match(r.notesKo[0], /해당하는 파일이 없습니다/);
});

test('경계: 경로·건수가 이상해도 음수·NaN 을 그대로 싣지 않는다', () => {
  const r = summarizeCoverage({ files: [
    { path: '', coveredLineCount: 1, totalLineCount: 1 },
    { path: '/repo/src/a.ts', coveredLineCount: -5, totalLineCount: Number.NaN, coveredBranchCount: undefined, totalBranchCount: 4, coveredFunctionCount: 1, totalFunctionCount: 1 },
  ] }, { rootDir: ROOT });
  assert.equal(r.excludedCount, 1);
  assert.deepEqual(r.files[0].lines, { covered: 0, total: 0 });
  assert.deepEqual(r.files[0].branches, { covered: 0, total: 4 });
});

test('경계: 분모가 0이면 비율을 만들지 않는다(100%로 부풀리지 않는다)', () => {
  assert.equal(percentOf({ covered: 0, total: 0 }), undefined);
  assert.equal(percentOf({ covered: 0, total: 4 }), 0);
});

// ── 판정 ─────────────────────────────────────────────────────────────────────

const measured = () => summarizeCoverage({ files: [file('/repo/src/a.ts', 80, 100, 30, 50, 9, 10)] }, { rootDir: ROOT });

test('정상: 임계값을 넘으면 통과하고 종료코드 0', () => {
  const ev = evaluateCoverage(measured(), { lines: 75, branches: 55, functions: 90 });
  assert.equal(ev.verdict, 'passed');
  assert.equal(ev.exitCode, 0);
  assert.deepEqual(ev.shortfalls, []);
});

test('정상: 임계값이 없으면 "측정 완료" 일 뿐 통과를 주장하지 않는다(§13-3)', () => {
  const ev = evaluateCoverage(measured());
  assert.equal(ev.verdict, 'measured');
  assert.equal(ev.exitCode, 0);
  assert.ok(ev.reasonsKo.some((m) => m.includes('게이트로 쓰지 않았습니다')));
});

test('실패: 임계값 미달은 실측치와 임계값을 함께 남기고 종료코드 1', () => {
  const ev = evaluateCoverage(measured(), { lines: 95 });
  assert.equal(ev.verdict, 'failed');
  assert.equal(ev.exitCode, COVERAGE_EXIT_CODE.failed);
  assert.deepEqual(ev.shortfalls, [{ metric: 'lines', percent: 80, threshold: 95 }]);
  assert.ok(ev.reasonsKo.some((m) => m.includes('80.00%') && m.includes('95%')));
});

test('실패: 미측정은 임계값을 줘도 통과로 바뀌지 않는다', () => {
  const ev = evaluateCoverage(summarizeCoverage({ files: [] }), { lines: 0 });
  assert.equal(ev.verdict, 'inconclusive');
  assert.equal(ev.exitCode, 2);
  assert.ok(ev.reasonsKo.some((m) => m.includes('실측치가 없으므로')));
});

test('판정보류: 잴 수 없는 항목에 임계값을 걸면 통과로 적지 않는다', () => {
  const r = summarizeCoverage({ files: [file('/repo/src/a.ts', 10, 10, 0, 0, 1, 1)] }, { rootDir: ROOT });
  const ev = evaluateCoverage(r, { branches: 50 });
  assert.equal(ev.verdict, 'inconclusive');
  assert.ok(ev.reasonsKo.some((m) => m.includes('분모가 0이라 잴 수 없었습니다')));
});

test('경계: 임계값과 실측치가 정확히 같으면 통과다', () => {
  const ev = evaluateCoverage(measured(), { lines: 80 });
  assert.equal(ev.verdict, 'passed');
});

// ── 임계값 읽기 ──────────────────────────────────────────────────────────────

test('환경변수: 지정한 항목만 읽고 기본 목표치를 만들지 않는다(§13-3)', () => {
  assert.deepEqual(thresholdsFromEnv({}), {});
  assert.deepEqual(thresholdsFromEnv({ AICC_COVERAGE_MIN_LINE: '70', AICC_COVERAGE_MIN_FUNC: '65' }), { lines: 70, functions: 65 });
});

test('환경변수 실패: 빈 값·범위 밖·문자열은 무시한다', () => {
  assert.deepEqual(thresholdsFromEnv({
    AICC_COVERAGE_MIN_LINE: '  ', AICC_COVERAGE_MIN_BRANCH: '120', AICC_COVERAGE_MIN_FUNC: 'abc',
  }), {});
  assert.deepEqual(thresholdsFromEnv({ AICC_COVERAGE_MIN_LINE: '0' }), { lines: 0 });
});

// ── 출력 ─────────────────────────────────────────────────────────────────────

test('약한 파일 목록: 낮은 순으로, 분모 0인 파일은 빼고 준다', () => {
  const r = summarizeCoverage({ files: [
    file('/repo/src/high.ts', 100, 100, 0, 0, 0, 0),
    file('/repo/src/low.ts', 10, 100, 0, 0, 0, 0),
    file('/repo/src/none.ts', 0, 0, 0, 0, 0, 0),
  ] }, { rootDir: ROOT });
  assert.deepEqual(weakestFiles(r, 'lines', 5).map((f) => f.path), ['src/low.ts', 'src/high.ts']);
  assert.deepEqual(weakestFiles(r, 'lines', 0), []);
});

test('사람용 출력: 실측치와 판정이 보이고 미측정이면 수치를 적지 않는다', () => {
  const ok = formatCoverageReport(evaluateCoverage(measured(), { lines: 75 }));
  assert.match(ok, /통과/);
  assert.match(ok, /라인 80\.00% \(80\/100\)/);

  const none = formatCoverageReport(evaluateCoverage(summarizeCoverage({ files: [] })));
  assert.match(none, /판정보류/);
  assert.ok(!/%/.test(none));
});

test('JSON 출력: 분모 0은 null 이고 등급·점수를 만들지 않는다(§13-3)', () => {
  const r = summarizeCoverage({ files: [file('/repo/src/a.ts', 10, 10, 0, 0, 1, 1)] }, { rootDir: ROOT });
  const j = JSON.parse(coverageToJson(evaluateCoverage(r, { lines: 50 })));
  assert.equal(j.verdict, 'passed');
  assert.equal(j.totals.lines.percent, 100);
  assert.equal(j.totals.branches.percent, null);
  assert.deepEqual(j.thresholds, { lines: 50 });
  assert.ok(!('score' in j) && !('grade' in j));
});
