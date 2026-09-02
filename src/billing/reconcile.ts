// 과금 근거 대사 검증 시나리오 — 설계서 §11.2(과금 근거)·§8.1(이벤트)·§10.2(감사)·§11.1(테넌트 격리)·§13-3.
//
// usage.ts 의 reconcile() 은 "어디가 얼마나 다른지"까지만 말한다. 실제 정산 현장에서 그 다음에
// 반드시 나오는 질문은 하나다: **왜 다른가, 그리고 청구해도 되는가.**
// 그 질문에 답하지 못하면 대사표는 그냥 숫자 두 줄이고, 결국 "우리 시스템이 맞다"는 주장만 남는다.
//
// 이 파일이 하는 일:
//  1) 원시 이벤트 → 집계 → 외부 명세 대조를 하나의 시나리오로 묶는다(입력이 같으면 결과가 같다).
//  2) 차이를 원인 후보로 분류한다(중복·유실·반올림·단위환산·실측누락). 단정하지 않고 근거를 붙인다.
//  3) 청구 가능 여부를 판정한다. **우리 쪽이 더 많은(과다청구 방향) 미해소 차이가 있으면 청구를 막는다.**
//     과소청구는 우리 손해지만 과다청구는 고객 피해이고, 되돌리는 비용이 비교가 안 된다.
//
// 금액·단가는 여전히 다루지 않는다. 단가는 계약 문서에 있고 Core는 수량만 책임진다.
import type { InteractionEvent } from '../events/schema.ts';
import type { ChannelKind } from '../domain/types.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type {
  AggregateOptions, BillableUnit, ExternalStatement, ReconcileLine, ReconcileResult,
  RoundingRule, Tolerance, UnitDiff, UsageAggregate,
} from './usage.ts';
import { aggregateUsage, applyRounding, reconcile } from './usage.ts';

/** 차이의 원인 후보. 단정이 아니라 "이 가설이 숫자와 맞는다"는 뜻이다. */
export type DiscrepancyCause =
  | 'duplicate_events'      // 중복 이벤트가 걸러졌거나 남았다 (§8.1 멱등)
  | 'missing_core'          // 외부에는 있는데 우리 원장에 없다 — 이벤트 유실
  | 'missing_external'      // 우리에겐 있는데 명세에 없다 — 명세 누락 또는 과다 집계
  | 'rounding_rule'         // 반올림 규칙 차이로 설명되는 크기
  | 'unit_scale'            // 초↔분(60배), ms↔초(1000배) 환산 오류로 설명되는 크기
  | 'incomplete_measurement'// 실측이 없어 집계에서 빠진 구간이 있다 (§13-3 추정 금지의 대가)
  | 'unexplained';          // 위 어느 것으로도 설명되지 않는다 — 사람이 반드시 본다

export interface CauseHypothesis {
  cause: DiscrepancyCause;
  /** 숫자로 확인된 근거. 추측 문장을 쓰지 않는다. */
  evidenceKo: string;
  unit?: BillableUnit;
}

export type BillingVerdict = 'billable' | 'review_required' | 'blocked';

export interface ReconcileFinding {
  bucket: string;
  channel: ChannelKind;
  source: string;
  status: ReconcileLine['status'];
  /** core - external 이 양수인 단위가 하나라도 있는가 = 과다청구 방향 */
  overBilledDirection: boolean;
  diffs: UnitDiff[];
  hypotheses: CauseHypothesis[];
}

export interface ReconcileScenarioResult {
  tenantId: string;
  granularity: AggregateOptions['granularity'];
  rounding: RoundingRule;
  tolerance: Tolerance;
  aggregate: UsageAggregate;
  raw: ReconcileResult;
  findings: ReconcileFinding[];
  verdict: BillingVerdict;
  /** 판정 사유. 청구를 막았다면 무엇을 해소해야 풀리는지까지 적는다. */
  verdictReasonKo: string;
  /** 사람이 확인해야 하는 항목 수(허용오차 밖 + 한쪽에만 있는 줄) */
  openIssues: number;
}

export interface ReconcileScenarioOptions {
  scope: TenantScope;
  granularity: AggregateOptions['granularity'];
  rounding: RoundingRule;
  tolerance: Tolerance;
  statements: ExternalStatement[];
  /**
   * 단위 환산 가설을 볼 배수. 계약·공급사마다 다르므로 호출자가 지정한다(기본값 금지 §13-3).
   * 예: 초↔분이면 60, ms↔초면 1000.
   */
  scaleCandidates?: number[];
}

/** 두 값의 비가 배수 후보에 가까운가. 0으로 나누지 않는다. */
function matchesScale(core: number, external: number, scale: number, tol: Tolerance): boolean {
  if (scale <= 0) return false;
  if (external === 0 || core === 0) return false;
  for (const [a, b] of [[core, external], [external, core]] as const) {
    const expected = b * scale;
    const diff = Math.abs(a - expected);
    if (diff <= tol.absolute) return true;
    const base = Math.max(Math.abs(a), Math.abs(expected));
    if (base > 0 && diff / base <= tol.relative) return true;
  }
  return false;
}

/**
 * 반올림 가설: voice_units 차이가, 같은 원시 초(voice_seconds)에 다른 반올림 규칙을 적용했을 때
 * 나올 수 있는 크기인가. 세션 수를 모르면 상한을 세션 1건 기준으로 본다 —
 * 이 함수는 "설명 가능"만 말하고, 규칙을 바꿔도 되는지는 계약이 정한다.
 */
function roundingExplains(diff: UnitDiff, seconds: number, rule: RoundingRule, sessions: number): boolean {
  if (diff.unit !== 'voice_units') return false;
  if (sessions <= 0) return false;
  const alt: RoundingRule[] = [
    { ...rule, mode: 'ceil' }, { ...rule, mode: 'floor' }, { ...rule, mode: 'round' },
  ];
  // 규칙별 최대·최소 가능치. 세션 단위 올림 차이는 세션 수만큼 벌어질 수 있다.
  const candidates = alt.map((r) => applyRounding(seconds, r));
  const lo = Math.min(...candidates);
  const hi = Math.max(...candidates);
  const spread = Math.max(hi - lo, 0) + sessions;   // 세션별 최소과금·올림 누적 여유
  return Math.abs(diff.diff) <= spread;
}

function hypothesize(
  line: ReconcileLine,
  agg: UsageAggregate,
  opts: ReconcileScenarioOptions,
): CauseHypothesis[] {
  const out: CauseHypothesis[] = [];
  const bucket = agg.buckets.find((b) => b.bucket === line.bucket && b.channel === line.channel);

  if (line.status === 'missing_core') {
    out.push({
      cause: 'missing_core',
      evidenceKo: `외부 명세(${line.source})에는 ${line.bucket}/${line.channel} 구간이 있으나 Core 집계에 없습니다. 이벤트 유실 또는 원장 미도달을 먼저 확인하세요(§8.1).`,
    });
    return out;
  }
  if (line.status === 'missing_external') {
    out.push({
      cause: 'missing_external',
      evidenceKo: `Core 집계에는 ${line.bucket}/${line.channel} 구간이 있으나 대조할 외부 명세가 없습니다. 명세 누락인지 우리 과다 집계인지 확인 전에는 청구 근거가 되지 않습니다.`,
    });
    return out;
  }

  const failing = line.diffs.filter((d) => !d.withinTolerance);
  if (failing.length === 0) return out;

  if (agg.duplicatesDropped > 0) {
    out.push({
      cause: 'duplicate_events',
      evidenceKo: `집계 과정에서 중복 이벤트 ${agg.duplicatesDropped}건을 제거했습니다. 외부 명세가 중복을 제거하지 않았다면 그만큼 차이가 납니다(§8.1 멱등).`,
    });
  }
  if (bucket && (bucket.sessionsMissingBillableMs > 0 || bucket.turnsMissingUsage > 0)) {
    out.push({
      cause: 'incomplete_measurement',
      evidenceKo: `실측 누락 — billable_ms 없는 세션 ${bucket.sessionsMissingBillableMs}건, usage 없는 턴 ${bucket.turnsMissingUsage}건이 집계에서 빠졌습니다. 추정으로 메우지 않았으므로 Core 수량이 작게 나옵니다(§13-3).`,
    });
  }

  for (const d of failing) {
    if (bucket && roundingExplains(d, bucket.quantities.voice_seconds, agg.rounding, bucket.quantities.sessions)) {
      out.push({
        cause: 'rounding_rule',
        unit: d.unit,
        evidenceKo: `${d.unit} 차이 ${d.diff}는 같은 원시 ${bucket.quantities.voice_seconds}초에 다른 반올림 규칙(현재 ${agg.rounding.unitSeconds}초/${agg.rounding.mode}/최소 ${agg.rounding.minimumUnits})을 적용했을 때 나올 수 있는 범위입니다. 계약서의 반올림 조항을 대조하세요.`,
      });
      continue;
    }
    const scale = (opts.scaleCandidates ?? []).find((s) => matchesScale(d.core, d.external, s, opts.tolerance));
    if (scale !== undefined) {
      out.push({
        cause: 'unit_scale',
        unit: d.unit,
        evidenceKo: `${d.unit}에서 Core ${d.core} 대 외부 ${d.external} 가 약 ${scale}배 관계입니다. 어댑터의 단위 환산(§6.2)을 먼저 확인하세요.`,
      });
      continue;
    }
    out.push({
      cause: 'unexplained',
      unit: d.unit,
      evidenceKo: `${d.unit} 차이 ${d.diff}(Core ${d.core} / 외부 ${d.external})가 중복·반올림·단위환산·실측누락 어느 가설로도 설명되지 않습니다. 사람이 확인해야 합니다.`,
    });
  }
  return out;
}

/**
 * 대사 시나리오 실행. 순수 함수다(시각·난수·I/O 없음) — 같은 이벤트·명세를 넣으면 언제나 같은 판정이 나온다.
 * 정산 분쟁에서 재현 가능성은 결론 자체보다 중요하다.
 */
export function runReconciliationScenario(
  events: InteractionEvent[],
  opts: ReconcileScenarioOptions,
): ReconcileScenarioResult {
  assertTenantScope(opts.scope);
  const aggregate = aggregateUsage(events, {
    scope: opts.scope,
    granularity: opts.granularity,
    rounding: opts.rounding,
  });
  const raw = reconcile(aggregate, opts.statements, opts.tolerance);

  const findings: ReconcileFinding[] = raw.lines.map((line) => ({
    bucket: line.bucket,
    channel: line.channel,
    source: line.source,
    status: line.status,
    overBilledDirection: line.status === 'missing_external'
      ? true                                     // 대조 못 한 우리 수량은 과다청구 방향으로 본다
      : line.diffs.some((d) => !d.withinTolerance && d.diff > 0),
    diffs: line.diffs,
    hypotheses: hypothesize(line, aggregate, opts),
  }));

  const open = findings.filter((f) => f.status !== 'matched');
  const overBilled = open.filter((f) => f.overBilledDirection);
  const unexplained = open.filter((f) => f.hypotheses.some((h) => h.cause === 'unexplained'));

  let verdict: BillingVerdict;
  let verdictReasonKo: string;
  if (open.length === 0) {
    verdict = 'billable';
    verdictReasonKo = `대사 ${findings.length}건 전부 허용오차(절대 ${opts.tolerance.absolute} / 상대 ${opts.tolerance.relative}) 안에서 일치합니다.`;
  } else if (overBilled.length > 0) {
    verdict = 'blocked';
    verdictReasonKo = `과다청구 방향의 미해소 차이 ${overBilled.length}건이 있어 청구를 막았습니다(구간: ${overBilled.map((f) => `${f.bucket}/${f.channel}`).join(', ')}). 원인 해소 또는 사람의 명시적 승인 전에는 청구서를 만들지 마세요.`;
  } else {
    verdict = 'review_required';
    verdictReasonKo = `과소청구 방향 차이 ${open.length}건이 있습니다(고객 피해는 없으나 매출 누락). ${unexplained.length > 0 ? `이 중 ${unexplained.length}건은 원인 미설명입니다. ` : ''}확인 후 진행하세요.`;
  }

  if (aggregate.foreignTenantDropped > 0) {
    verdictReasonKo += ` 참고: 다른 테넌트 이벤트 ${aggregate.foreignTenantDropped}건을 집계 전에 제외했습니다(§11.1).`;
  }

  return {
    tenantId: aggregate.tenantId,
    granularity: opts.granularity,
    rounding: opts.rounding,
    tolerance: opts.tolerance,
    aggregate,
    raw,
    findings,
    verdict,
    verdictReasonKo,
    openIssues: open.length,
  };
}

/** 운영·감사용 한국어 리포트. 금액이 아니라 수량과 근거만 담는다(§11.2·§10.2). */
export function formatReconciliationReport(r: ReconcileScenarioResult): string {
  const head = [
    `[${r.tenantId}] 과금 근거 대사 — 판정: ${r.verdict}`,
    r.verdictReasonKo,
    `집계 이벤트 ${r.aggregate.eventsCounted}건 · 중복 제외 ${r.aggregate.duplicatesDropped}건 · 미해소 ${r.openIssues}건`,
  ];
  const body = r.findings
    .filter((f) => f.status !== 'matched')
    .map((f) => {
      const diffs = f.diffs.filter((d) => !d.withinTolerance)
        .map((d) => `${d.unit} ${d.core} vs ${d.external} (차이 ${d.diff})`).join(', ');
      const causes = f.hypotheses.map((h) => `      · [${h.cause}] ${h.evidenceKo}`).join('\n');
      return `  - ${f.bucket}/${f.channel} (${f.source}) ${f.status}${diffs ? `: ${diffs}` : ''}\n${causes}`;
    });
  return [...head, ...body].join('\n');
}
