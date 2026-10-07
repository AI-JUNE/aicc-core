// 과금 집계·대사 실행기 — 설계서 §11.2(과금 근거)·§8.1(이벤트)·§11.1(테넌트 격리)·§13-3(실측만)·§9.3.
//
// `events/periodLedger.ts` 가 "이 달의 이벤트"를 만들고, `usage.ts` 가 수량을, `reconcile.ts` 가
// 청구 가능 여부를 판정한다. 이 파일은 **그 셋을 꿰는 자리**다. 호스트가 손으로 꿰면 잘못 꿰는
// 방식이 정해져 있고(periodLedger 머리말의 (가)(나)(다)), 그 위에 **대사 입력 쪽에서만 나는
// 실패가 넷 더** 있다 — 넷 다 판정문이 엉뚱한 말을 하게 만든다.
//
//  1) **대조할 명세가 없는데 돌린다.** `reconcile` 은 Core 집계에만 있는 구간을
//     `missing_external` 로 적고, 그 상태를 **과다청구 방향으로 본다**(대조 못 한 우리 수량이라서다).
//     그래서 명세를 빈 배열로 넘기면 판정이 `blocked` 로 나오고 사유는 "과다청구 방향 미해소 차이"다 —
//     실제로는 **대사를 하지 않은 것**이다. 둘을 같은 말로 적으면, 명세를 아직 못 받은 달의
//     청구 보류가 "우리 집계에 과다청구 의심"으로 기록된다. 그래서 거절(refused)이고, 거절은
//     `blocked` 도 `billable` 도 아닌 **세 번째 상태**다.
//  2) **버킷 단위가 다른 명세를 넘긴다.** 집계 단위가 `month` 인데 명세 버킷이 `2026-10-03`(일)
//     이면 두 쪽은 **영영 만나지 않는다** — 전 구간이 `missing_external`+`missing_core` 로 갈리고
//     판정은 `blocked`, 사유는 다시 "과다청구 방향"이다. 원인은 단위 선언 불일치인데 그 말은
//     어디에도 안 적힌다.
//  3) **다른 기간의 명세를 넘긴다.** 지난달 명세를 이번 달 투영에 대면 모든 줄이 한쪽에만 있게
//     되어 `missing_core` 가설("이벤트 유실 — 원장 미도달을 먼저 확인하세요")이 붙는다.
//     원장은 멀쩡한데 유실 조사가 시작된다.
//  4) **같은 구간에 명세가 둘 온다.** `reconcile` 은 `bucket::channel` 로 Map 에 접으므로
//     **배열에서 나중 것이 조용히 이긴다**(통신사 CDR 과 공급사 리포트를 같이 넘기면 하나가
//     사라진다). 골라 주지 않는다 — 어느 쪽이 맞는지는 계약이 정할 일이고, 값이 어긋나면
//     그 구간의 판정이 입력 순서로 결정된다((17) 의 큐 스냅샷과 같은 모양의 결론이다).
//
// 그 외 이 파일이 고정하는 것:
//  - **판정을 복사하지 않는다(§2).** 수량·반올림은 `aggregateUsage`, 가설·청구 가능 여부는
//    `runReconciliationScenario` 하나다. 이 파일에 허용오차 비교도, 과다청구 방향 판정도,
//    단가도 없다. 거절은 **입력이 판정에 닿을 자격이 있는지**만 본다.
//  - **거절했으면 집계를 만들지 않는다.** 순서가 곧 안전장치다(기간 투영 → 설정 검증 → 명세
//    검증 → 집계 → 대사). 수량표를 마지막에 만들기 때문에 어느 단계에서 걸려도 **청구서에
//    붙일 수 있는 표가 생기지 않는다**(`settlementExport` 와 같은 규칙).
//  - **반올림 규칙은 집계 전에 검증한다.** `applyRounding` 은 `unitSeconds <= 0` 에서 던지는데
//    그 호출은 **통화 초가 있을 때만** 일어난다 — 즉 조용한 달은 통과하고 바쁜 달에 터진다.
//    같은 설정 오류가 달에 따라 다르게 나타나면 원인을 그 달의 데이터에서 찾게 된다.
//  - **0 과 "모른다"를 같게 적지 않는다.** 투영에 이벤트가 없으면 `empty` 이고, 그 문구는
//    "사용량 0"이 아니라 "근거가 없었다"다(§13-3).
//  - **시계를 만들지 않는다.** 기간·경계는 전부 주입이다.
import type { PeriodProjection } from '../events/periodLedger.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type {
  AggregateOptions, ExternalStatement, RoundingRule, Tolerance, UsageAggregate, UsageQuantities,
} from './usage.ts';
import { aggregateUsage, bucketKey, totalQuantities } from './usage.ts';
import type { ReconcileScenarioResult } from './reconcile.ts';
import { formatReconciliationReport, runReconciliationScenario } from './reconcile.ts';

export const USAGE_RUN_CONTRACT_VERSION = 1;

export type UsageRunStatus =
  | 'refused'      // 입력을 청구 근거로 쓸 수 없어 집계를 만들지 않았다
  | 'empty'        // 투영 범위에 이벤트가 없었다 — "사용량 0" 과 구분한다
  | 'aggregated';  // 수량이 산출됐다

export interface UsageRunParams {
  /** `projectLedgerPeriod`·`projectLedgerPeriodFromLog` 결과 **그대로**. 배열만 뽑아 넘기지 않는다. */
  projection: PeriodProjection;
  granularity: AggregateOptions['granularity'];
  /** 계약이 정하는 반올림. 기본값 없음(§13-3). */
  rounding: RoundingRule;
}

export interface UsageRunResult {
  status: UsageRunStatus;
  /** 화면·로그에 그대로 쓸 한 줄. */
  messageKo: string;
  /** 집계를 만들지 않은 이유. 비어 있지 않으면 `aggregate` 가 없다. */
  refusalsKo: string[];
  /** 집계는 했지만 숨기면 안 되는 사실. */
  warningsKo: string[];
  /** 검사하지 못하는 범위(투영에서 그대로 옮긴다). */
  limitsKo: string[];
  aggregate?: UsageAggregate;
  /** 청구서 한 줄에 대응하는 합계. `aggregate` 가 없으면 없다. */
  totals?: UsageQuantities;
}

export type ReconciliationRunStatus = 'refused' | 'reconciled';

export interface ReconciliationRunParams extends UsageRunParams {
  tolerance: Tolerance;
  statements: ExternalStatement[];
  scaleCandidates?: number[];
}

export interface ReconciliationRunResult {
  status: ReconciliationRunStatus;
  messageKo: string;
  /** 대사를 돌리지 않은 이유. 비어 있지 않으면 `scenario` 가 없다 — **판정이 없다**. */
  refusalsKo: string[];
  warningsKo: string[];
  limitsKo: string[];
  /** `runReconciliationScenario` 결과 그대로. 판정(`verdict`)은 이 파일이 만들지 않는다. */
  scenario?: ReconcileScenarioResult;
  /** 운영·감사용 한국어 리포트. 거절이면 없다. */
  reportKo?: string;
}

/** 반올림 규칙의 형태 결함. 값을 되싣되 개인정보가 아니므로 그대로 적는다. */
function roundingDefectsKo(r: RoundingRule): string[] {
  const out: string[] = [];
  const raw = r as unknown;
  if (raw === null || typeof raw !== 'object') {
    return ['반올림 규칙이 선언되지 않았습니다 — 계약마다 다르므로 Core 가 기본값을 만들지 않습니다 (설계서 §13-3)'];
  }
  if (!Number.isFinite(r.unitSeconds) || r.unitSeconds <= 0) {
    out.push(
      `과금 단위 길이(unitSeconds)가 0보다 커야 합니다: ${String(r.unitSeconds)} — ` +
      '이 오류는 통화 초가 있을 때만 터지므로, 막지 않으면 조용한 달은 통과하고 바쁜 달에만 실패합니다 (설계서 §11.2)',
    );
  }
  if (!Number.isFinite(r.minimumUnits) || r.minimumUnits < 0) {
    out.push(`통화당 최소 과금 단위(minimumUnits)가 0 이상의 유한수여야 합니다: ${String(r.minimumUnits)} (설계서 §11.2)`);
  }
  if (r.mode !== 'ceil' && r.mode !== 'floor' && r.mode !== 'round') {
    out.push(`반올림 방식(mode)이 ceil·floor·round 중 하나여야 합니다: ${JSON.stringify(r.mode)} (설계서 §11.2)`);
  }
  return out;
}

/** 집계 단위가 만들 수 있는 버킷 키의 모양. `bucketKey` 와 같은 규칙이어야 한다(§2). */
function bucketShapeOk(bucket: string, g: AggregateOptions['granularity']): boolean {
  if (g === 'total') return bucket === 'total';
  if (g === 'month') return /^\d{4}-\d{2}$/.test(bucket);
  return /^\d{4}-\d{2}-\d{2}$/.test(bucket);
}

/** 투영 기간이 만들 수 있는 버킷 키 범위. UTC 접두사라 문자열 비교가 곧 시간 순서다. */
function periodBucketRange(
  p: PeriodProjection,
  g: AggregateOptions['granularity'],
): { lo: string; hi: string } | undefined {
  if (g === 'total' || p.period === undefined) return undefined;
  const fromMs = Date.parse(p.period.fromIso);
  const toMs = Date.parse(p.period.toIso);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return undefined;
  // 반개구간이므로 마지막으로 포함되는 시점은 to - 1ms 다.
  return {
    lo: bucketKey(new Date(fromMs).toISOString(), g),
    hi: bucketKey(new Date(toMs - 1).toISOString(), g),
  };
}

/** 투영·설정에서 공통으로 모으는 거절 사유. 집계와 대사가 같은 규칙을 쓴다(§2). */
function commonRefusals(p: UsageRunParams): string[] {
  const out = [...p.projection.billingRefusalsKo];
  out.push(...roundingDefectsKo(p.rounding));
  return out;
}

function commonWarnings(projection: PeriodProjection): string[] {
  const out: string[] = [];
  const c = projection.counters;
  if (projection.noteKo !== undefined) out.push(`기간 투영: ${projection.noteKo}`);
  if (c.foreignTenantDropped > 0) {
    out.push(
      `다른 테넌트 이벤트 ${c.foreignTenantDropped}건이 투영 전에 걸러졌습니다 — 집계는 안전하지만 ` +
      '전달 경로에 결함이 있다는 신호입니다 (설계서 §11.1)',
    );
  }
  if (c.interactionsWithoutEndInPeriod > 0) {
    out.push(
      `종료를 기간 안에서 보지 못한 통화 ${c.interactionsWithoutEndInPeriod}건의 통화 분은 이 기간에 ` +
      '잡히지 않습니다(통화 시간의 근거는 session.ended.billable_ms 하나뿐입니다). 집계의 ' +
      'sessionsMissingBillableMs 에도 포함되지 않습니다 — 그 세션의 종료 이벤트 자체가 이 기간 밖입니다 (설계서 §11.2)',
    );
  }
  if (c.timestampsRejected > 0) {
    out.push(`기간에 놓을 수 없는 시각 ${c.timestampsRejected}건이 제외됐습니다 — 그만큼 수량이 작게 나옵니다 (설계서 §13-3)`);
  }
  return out;
}

/**
 * 기간 투영 → 과금 수량. 거절했으면 **수량표를 만들지 않는다**.
 *
 * `aggregateUsage` 는 자기 입력을 다시 격리·중복 제거하므로(§8.1 멱등) 결과의
 * `duplicatesDropped`·`foreignTenantDropped` 는 0 으로 나온다 — 실제로 걸러진 건수는 투영이
 * 세어 둔 것이고, 그 값을 경고로 올린다. 같은 숫자를 두 곳에서 세지 않는다(§2).
 */
export function runUsageAggregation(p: UsageRunParams): UsageRunResult {
  assertTenantScope(p.projection.scope);
  const refusalsKo = commonRefusals(p);
  const limitsKo = [...p.projection.limitsKo];
  const warningsKo = commonWarnings(p.projection);

  if (refusalsKo.length > 0) {
    return {
      status: 'refused',
      messageKo: '과금 수량을 산출하지 않았습니다 — 청구서에 붙일 수 있는 표를 만들지 않았습니다.',
      refusalsKo,
      warningsKo,
      limitsKo,
    };
  }

  const aggregate = aggregateUsage(p.projection.events, {
    scope: p.projection.scope,
    granularity: p.granularity,
    rounding: p.rounding,
  });
  const totals = totalQuantities(aggregate);

  if (p.projection.events.length === 0) {
    return {
      status: 'empty',
      messageKo:
        `투영 범위에 이벤트가 없었습니다(받은 줄 ${p.projection.counters.eventsSeen}건 · 기간 밖 ` +
        `${p.projection.counters.outOfPeriodDropped}건). "사용량 0"이 아니라 "근거가 없었다"입니다 (설계서 §13-3).`,
      refusalsKo,
      warningsKo,
      limitsKo,
      aggregate,
      totals,
    };
  }

  return {
    status: 'aggregated',
    messageKo:
      `과금 수량을 산출했습니다 — 이벤트 ${aggregate.eventsCounted}건 · 버킷 ${aggregate.buckets.length}개 · ` +
      `세션 ${totals.sessions}건 · 통화 ${totals.voice_units}단위(원시 ${totals.voice_seconds}초).`,
    refusalsKo,
    warningsKo,
    limitsKo,
    aggregate,
    totals,
  };
}

/** 외부 명세의 형태·구간 결함. 값은 버킷·채널·출처뿐이라 그대로 적는다(개인정보가 아니다). */
function statementRefusalsKo(p: ReconciliationRunParams): string[] {
  const out: string[] = [];
  if (!Array.isArray(p.statements) || p.statements.length === 0) {
    out.push(
      '대조할 외부 명세가 없습니다 — 명세 없이 돌리면 우리 집계 전 구간이 "대조할 명세 없음"(과다청구 ' +
      '방향)이 되어 판정이 blocked 로 나옵니다. 그 상태는 과다청구 의심이 아니라 **대사 미실시**입니다 (설계서 §11.2).',
    );
    return out;
  }

  const shapeBad = p.statements.filter((s) => !bucketShapeOk(s.bucket, p.granularity));
  if (shapeBad.length > 0) {
    out.push(
      `집계 단위(${p.granularity})와 버킷 모양이 다른 명세 ${shapeBad.length}건: ` +
      `${shapeBad.slice(0, 5).map((s) => `${s.source}/${s.bucket}`).join(', ')} — ` +
      '단위가 다르면 두 쪽이 영영 만나지 않아 전 구간이 미해소로 갈립니다 (설계서 §11.2).',
    );
  }

  const range = periodBucketRange(p.projection, p.granularity);
  if (range !== undefined) {
    const outside = p.statements.filter(
      (s) => bucketShapeOk(s.bucket, p.granularity) && (s.bucket < range.lo || s.bucket > range.hi),
    );
    if (outside.length > 0) {
      out.push(
        `투영 기간(${range.lo} ~ ${range.hi}) 밖의 명세 ${outside.length}건: ` +
        `${outside.slice(0, 5).map((s) => `${s.source}/${s.bucket}`).join(', ')} — ` +
        '다른 기간의 명세를 대면 모든 줄이 한쪽에만 있게 되어 "이벤트 유실" 가설이 붙고, 멀쩡한 원장을 뒤지게 됩니다 (설계서 §8.1).',
      );
    }
  }

  const seen = new Map<string, string[]>();
  for (const s of p.statements) {
    const k = `${s.bucket}::${s.channel}`;
    const hit = seen.get(k);
    if (hit) hit.push(s.source);
    else seen.set(k, [s.source]);
  }
  const dup = [...seen.entries()].filter(([, sources]) => sources.length > 1);
  if (dup.length > 0) {
    out.push(
      `같은 구간에 명세가 둘 이상입니다: ${dup.slice(0, 5).map(([k, v]) => `${k}(${v.join(' vs ')})`).join(', ')} — ` +
      '대조는 구간당 하나만 쓰므로 배열에서 나중 것이 조용히 이깁니다. 어느 명세로 대사할지는 계약이 정합니다 (설계서 §11.2).',
    );
  }
  return out;
}

/**
 * 기간 투영 → 대사 시나리오. 거절했으면 **판정이 없다** — `blocked` 도 `billable` 도 아니다.
 *
 * 입력 검증만 한다. 가설·판정은 `runReconciliationScenario` 하나이고(§2) 이 파일은 그 결과를
 * 고쳐 쓰지 않는다 — 고쳐 쓰면 "코드가 청구를 풀어 준" 경로가 생긴다.
 */
export function runReconciliation(p: ReconciliationRunParams): ReconciliationRunResult {
  assertTenantScope(p.projection.scope);
  const refusalsKo = [...commonRefusals(p), ...statementRefusalsKo(p)];
  const limitsKo = [...p.projection.limitsKo];
  const warningsKo = commonWarnings(p.projection);

  if (refusalsKo.length > 0) {
    return {
      status: 'refused',
      messageKo: '대사를 돌리지 않았습니다 — 청구 가능 여부를 판정하지 않았습니다(차단과 다릅니다).',
      refusalsKo,
      warningsKo,
      limitsKo,
    };
  }

  const scenario = runReconciliationScenario(p.projection.events, {
    scope: p.projection.scope,
    granularity: p.granularity,
    rounding: p.rounding,
    tolerance: p.tolerance,
    statements: p.statements,
    ...(p.scaleCandidates !== undefined ? { scaleCandidates: p.scaleCandidates } : {}),
  });

  if (p.projection.events.length === 0) {
    warningsKo.push(
      '투영 범위에 이벤트가 없는 상태로 대사했습니다 — 명세에만 있는 구간은 "이벤트 유실"로 집계됩니다. ' +
      '기간 선언과 원장 도달을 먼저 확인하세요 (설계서 §8.1).',
    );
  }

  return {
    status: 'reconciled',
    messageKo: `대사 판정: ${scenario.verdict} — ${scenario.verdictReasonKo}`,
    refusalsKo,
    warningsKo,
    limitsKo,
    scenario,
    reportKo: formatReconciliationReport(scenario),
  };
}
