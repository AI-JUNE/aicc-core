// 커버리지 계측 — 설계서 §13-3(실측만 적는다).
//
// 왜 이 파일이 필요한가:
// COMMERCIAL_READINESS.md 는 "계측 도구가 없는 동안에는 커버리지 수치·목표치를 문서에 적지 않는다"고
// 못박아 두었다. 옳은 규칙이지만, 그 상태로는 어느 실패 경로가 한 번도 안 돌았는지 아무도 모른다.
// 그래서 **수치를 만들어내지 않으면서** 실측치를 얻는 경로를 연다.
//
// 이 파일이 지키는 세 가지:
//  1) **평균의 평균을 내지 않는다.** 파일별 퍼센트를 평균하면 10줄짜리 파일과 500줄짜리 파일이
//     같은 무게를 갖는다. 전체 비율은 항상 원시 건수(covered/total)로 다시 계산한다.
//  2) **목표치를 코드에 박지 않는다.** 임계값을 주지 않으면 게이트로 쓰지 않고 측정만 한다.
//     "80%" 같은 숫자를 여기서 정하면 그게 곧 근거 없는 KPI 가 된다(§13-3).
//  3) **측정 실패를 0%로도 100%로도 적지 않는다.** 계측이 아무 파일도 못 봤으면 판정보류다 —
//     계측이 꺼진 채로 초록 배지가 뜨는 것이 커버리지 도입에서 가장 흔한 사고다.
//
// 실행은 scripts/coverage.mjs 가 맡는다(프로세스 기동·리포터·파일 입출력). 여기는 순수 계산만 둔다.

/** node --experimental-test-coverage 의 test:coverage 이벤트가 주는 파일 항목(필요한 것만). */
export interface RawCoverageFile {
  path: string;
  totalLineCount: number;
  coveredLineCount: number;
  totalBranchCount: number;
  coveredBranchCount: number;
  totalFunctionCount: number;
  coveredFunctionCount: number;
}

export interface RawCoverageSummary {
  files?: RawCoverageFile[];
}

export interface CoverageCounts {
  lines: { covered: number; total: number };
  branches: { covered: number; total: number };
  functions: { covered: number; total: number };
}

export interface CoverageFileEntry extends CoverageCounts {
  /** 저장소 루트 기준 상대경로. 절대경로를 리포트에 싣지 않는다. */
  path: string;
}

export interface CoverageReport {
  /** 계측이 실제로 무언가를 본 경우에만 true. false 면 수치를 쓰지 않는다. */
  measured: boolean;
  files: CoverageFileEntry[];
  totals: CoverageCounts;
  /** 계측 대상에서 제외된 파일 수(테스트·스크립트·fixture 등). */
  excludedCount: number;
  notesKo: string[];
}

export interface SummarizeOptions {
  /** 저장소 루트 절대경로. 상대경로로 줄이는 데만 쓴다. */
  rootDir?: string;
  /** 이 접두사로 시작하는 상대경로만 계측 대상으로 본다. 기본은 소스 디렉터리 하나. */
  includePrefixes?: readonly string[];
}

const DEFAULT_INCLUDE = ['src/'] as const;

function toRelative(p: string, rootDir?: string): string {
  let rel = p;
  if (rootDir !== undefined && rootDir !== '') {
    const base = rootDir.endsWith('/') ? rootDir : `${rootDir}/`;
    if (rel.startsWith(base)) rel = rel.slice(base.length);
  }
  return rel.replace(/\\/g, '/');
}

function zero(): CoverageCounts {
  return { lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } };
}

function nonNegative(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 원시 요약 → 계측 대상만 남긴 리포트. 던지지 않는다 —
 * 계측 결과가 예상과 다른 모양이어도 CI 가 스택트레이스로 죽는 대신 판정보류로 남아야 한다.
 */
export function summarizeCoverage(summary: RawCoverageSummary | null | undefined, opts: SummarizeOptions = {}): CoverageReport {
  const include = opts.includePrefixes ?? DEFAULT_INCLUDE;
  const notesKo: string[] = [];
  const raw = Array.isArray(summary?.files) ? summary.files : [];
  if (raw.length === 0) {
    notesKo.push('계측이 파일을 하나도 보지 못했습니다. 커버리지가 켜지지 않았을 수 있습니다.');
    return { measured: false, files: [], totals: zero(), excludedCount: 0, notesKo };
  }

  const files: CoverageFileEntry[] = [];
  let excludedCount = 0;
  for (const f of raw) {
    if (typeof f?.path !== 'string' || f.path === '') { excludedCount += 1; continue; }
    const rel = toRelative(f.path, opts.rootDir);
    if (!include.some((p) => rel.startsWith(p))) { excludedCount += 1; continue; }
    files.push({
      path: rel,
      lines: { covered: nonNegative(f.coveredLineCount), total: nonNegative(f.totalLineCount) },
      branches: { covered: nonNegative(f.coveredBranchCount), total: nonNegative(f.totalBranchCount) },
      functions: { covered: nonNegative(f.coveredFunctionCount), total: nonNegative(f.totalFunctionCount) },
    });
  }

  if (files.length === 0) {
    notesKo.push(`계측 대상(${include.join('·')})에 해당하는 파일이 없습니다. 대상 경로를 확인하세요.`);
    return { measured: false, files: [], totals: zero(), excludedCount, notesKo };
  }

  // 전체 비율은 파일 퍼센트의 평균이 아니라 원시 건수 합으로 계산한다.
  const totals = zero();
  for (const f of files) {
    totals.lines.covered += f.lines.covered; totals.lines.total += f.lines.total;
    totals.branches.covered += f.branches.covered; totals.branches.total += f.branches.total;
    totals.functions.covered += f.functions.covered; totals.functions.total += f.functions.total;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { measured: true, files, totals, excludedCount, notesKo };
}

/**
 * 비율(%). 분모가 0이면 숫자를 만들지 않는다 — 분기가 없는 파일을 100%로 적으면
 * 전체 수치가 조용히 부풀려진다(§13-3).
 */
export function percentOf(c: { covered: number; total: number }): number | undefined {
  if (c.total <= 0) return undefined;
  return (c.covered / c.total) * 100;
}

export type CoverageMetric = 'lines' | 'branches' | 'functions';

/** 임계값. 주지 않은 항목은 검사하지 않는다. 코드에 기본 목표치를 두지 않는다(§13-3). */
export type CoverageThresholds = Partial<Record<CoverageMetric, number>>;

export type CoverageVerdict = 'passed' | 'measured' | 'inconclusive' | 'failed';

/** 종료코드. 복구 리허설·채널 하네스와 같은 체계를 쓴다. measured 는 게이트가 아니므로 0. */
export const COVERAGE_EXIT_CODE: Record<CoverageVerdict, number> = {
  passed: 0,
  measured: 0,
  inconclusive: 2,
  failed: 1,
};

export interface CoverageEvaluation {
  verdict: CoverageVerdict;
  exitCode: number;
  report: CoverageReport;
  thresholds: CoverageThresholds;
  /** 임계값을 넘지 못한 항목. 실측치와 임계값을 함께 남긴다. */
  shortfalls: { metric: CoverageMetric; percent: number; threshold: number }[];
  reasonsKo: string[];
}

const METRIC_KO: Record<CoverageMetric, string> = { lines: '라인', branches: '분기', functions: '함수' };

/**
 * 판정. 임계값이 하나도 없으면 `measured` — "쟀다"까지만 말하고 통과를 주장하지 않는다.
 * 계측 실패는 `inconclusive` 이며, 절대 `passed` 로 바뀌지 않는다.
 */
export function evaluateCoverage(report: CoverageReport, thresholds: CoverageThresholds = {}): CoverageEvaluation {
  const reasonsKo = [...report.notesKo];
  const entries = (Object.keys(thresholds) as CoverageMetric[])
    .filter((m) => typeof thresholds[m] === 'number' && Number.isFinite(thresholds[m] as number));

  if (!report.measured) {
    reasonsKo.push('실측치가 없으므로 수치를 적지 않습니다(§13-3).');
    return { verdict: 'inconclusive', exitCode: COVERAGE_EXIT_CODE.inconclusive, report, thresholds, shortfalls: [], reasonsKo };
  }

  if (entries.length === 0) {
    reasonsKo.push('임계값이 지정되지 않아 게이트로 쓰지 않았습니다. 측정만 수행했습니다.');
    return { verdict: 'measured', exitCode: COVERAGE_EXIT_CODE.measured, report, thresholds, shortfalls: [], reasonsKo };
  }

  const shortfalls: CoverageEvaluation['shortfalls'] = [];
  const unmeasurable: CoverageMetric[] = [];
  for (const metric of entries) {
    const pct = percentOf(report.totals[metric]);
    if (pct === undefined) { unmeasurable.push(metric); continue; }
    const threshold = thresholds[metric] as number;
    if (pct + 1e-9 < threshold) shortfalls.push({ metric, percent: pct, threshold });
  }

  for (const m of unmeasurable) {
    reasonsKo.push(`${METRIC_KO[m]} 임계값을 지정했지만 분모가 0이라 잴 수 없었습니다.`);
  }
  for (const s of shortfalls) {
    reasonsKo.push(`${METRIC_KO[s.metric]} 커버리지 ${s.percent.toFixed(2)}% 가 임계값 ${s.threshold}% 에 못 미칩니다.`);
  }

  if (shortfalls.length > 0) {
    return { verdict: 'failed', exitCode: COVERAGE_EXIT_CODE.failed, report, thresholds, shortfalls, reasonsKo };
  }
  if (unmeasurable.length > 0) {
    return { verdict: 'inconclusive', exitCode: COVERAGE_EXIT_CODE.inconclusive, report, thresholds, shortfalls, reasonsKo };
  }
  return { verdict: 'passed', exitCode: COVERAGE_EXIT_CODE.passed, report, thresholds, shortfalls, reasonsKo };
}

/** 임계값을 환경변수에서 읽는다. 없으면 없는 대로 둔다 — 기본 목표치를 만들지 않는다(§13-3). */
export function thresholdsFromEnv(env: Record<string, string | undefined>, prefix = 'AICC_COVERAGE_MIN_'): CoverageThresholds {
  const out: CoverageThresholds = {};
  const map: Record<CoverageMetric, string> = { lines: 'LINE', branches: 'BRANCH', functions: 'FUNC' };
  for (const metric of Object.keys(map) as CoverageMetric[]) {
    const raw = env[`${prefix}${map[metric]}`];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[metric] = n;
  }
  return out;
}

/** 커버리지가 가장 낮은 파일들. 어디를 먼저 덮을지 정하는 데만 쓴다 — 순위에 점수를 매기지 않는다. */
export function weakestFiles(report: CoverageReport, metric: CoverageMetric, limit: number): CoverageFileEntry[] {
  return report.files
    .filter((f) => f[metric].total > 0)
    .map((f) => ({ f, pct: (f[metric].covered / f[metric].total) * 100 }))
    .sort((a, b) => (a.pct - b.pct) || a.f.path.localeCompare(b.f.path))
    .slice(0, Math.max(0, limit))
    .map((x) => x.f);
}

function pctText(c: { covered: number; total: number }): string {
  const p = percentOf(c);
  return p === undefined ? '측정 불가(분모 0)' : `${p.toFixed(2)}% (${c.covered}/${c.total})`;
}

/** 사람이 읽는 요약. 실측치와 판정만 담고 목표치를 추측하지 않는다(§13-3). */
export function formatCoverageReport(ev: CoverageEvaluation, weakestLimit = 5): string {
  const verdictKo = ev.verdict === 'passed' ? '통과'
    : ev.verdict === 'measured' ? '측정 완료(게이트 아님)'
    : ev.verdict === 'inconclusive' ? '판정보류' : '실패';
  const lines: string[] = [`커버리지 계측: ${verdictKo}`];
  if (ev.report.measured) {
    lines.push(`  대상 파일 ${ev.report.files.length}개 (제외 ${ev.report.excludedCount}개)`);
    lines.push(`  라인 ${pctText(ev.report.totals.lines)}`);
    lines.push(`  분기 ${pctText(ev.report.totals.branches)}`);
    lines.push(`  함수 ${pctText(ev.report.totals.functions)}`);
    const weak = weakestFiles(ev.report, 'lines', weakestLimit);
    if (weak.length > 0) {
      lines.push('  라인 커버리지가 낮은 파일:');
      for (const f of weak) lines.push(`    - ${f.path} ${pctText(f.lines)}`);
    }
  }
  for (const why of ev.reasonsKo) lines.push(`  ! ${why}`);
  return lines.join('\n');
}

/** 기계용 출력. 등급·점수를 만들지 않는다(§13-3). */
export function coverageToJson(ev: CoverageEvaluation): string {
  const pct = (c: { covered: number; total: number }) => {
    const p = percentOf(c);
    return p === undefined ? null : Number(p.toFixed(4));
  };
  return JSON.stringify({
    verdict: ev.verdict,
    exitCode: ev.exitCode,
    measured: ev.report.measured,
    fileCount: ev.report.files.length,
    excludedCount: ev.report.excludedCount,
    totals: {
      lines: { ...ev.report.totals.lines, percent: pct(ev.report.totals.lines) },
      branches: { ...ev.report.totals.branches, percent: pct(ev.report.totals.branches) },
      functions: { ...ev.report.totals.functions, percent: pct(ev.report.totals.functions) },
    },
    thresholds: ev.thresholds,
    shortfalls: ev.shortfalls.map((s) => ({ metric: s.metric, percent: Number(s.percent.toFixed(4)), threshold: s.threshold })),
    files: ev.report.files.map((f) => ({
      path: f.path,
      lines: { ...f.lines, percent: pct(f.lines) },
      branches: { ...f.branches, percent: pct(f.branches) },
      functions: { ...f.functions, percent: pct(f.functions) },
    })),
    reasonsKo: ev.reasonsKo,
  }, null, 2);
}
