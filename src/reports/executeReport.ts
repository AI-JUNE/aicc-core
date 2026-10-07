// 리포트 실행기 — 설계서 §7 7.6(리포트)·§8.1(이벤트가 유일한 원천)·§11.1(테넌트 격리)·§13-3(실측만).
//
// `events/periodLedger.ts` 가 기간 이벤트를, `reports/aggregate.ts` 가 지표를 만든다. 이 파일은
// **그 둘을 꿰는 자리**이고, 지금까지 저장소 전체에서 `aggregateReport` 를 부르는 곳은 테스트뿐이었다 —
// 즉 §7 7.6 리포트는 **한 번도 산출된 적이 없다**.
//
// 여기서 막는 실패는 과금 쪽(`billing/executeUsage.ts`)과 **성격이 다르다**. 리포트는 되돌릴 수
// 없는 동작이 아니므로 잘렸다고 멈추지 않는다 — 대신 **잘린 표가 완전한 표처럼 보이는 것**을 막는다.
// 운영이 리포트를 보는 이유는 숫자 자체가 아니라 "그래서 뭘 고칠까"이고, 결측을 감춘 표는 멀쩡한
// 구간을 뒤지게 만든다(§13-3 이 목표치·판정을 금지한 것과 같은 이유다).
//
//  1) **기간을 두 번 거른다.** 투영은 **반개구간 [from, to)** 로 자르고 `aggregateReport` 의
//     `from`·`to` 는 **양쪽 포함**이다. 둘을 같이 쓰면 경계 해석이 두 개가 되고, 같은 월초 자료가
//     과금과 리포트에서 다르게 세어진다 — §2 가 지적한 이중 관리가 날짜 경계의 형태로 되풀이된다.
//     그래서 이 파일은 `from`·`to` 를 **넘기지 않는다**(투영이 이미 걸렀다). 기간은 결과에 적어
//     화면이 그대로 표시한다.
//  2) **결측을 "0"으로 보여준다.** 비율은 `ratio` 가 분모와 함께 내놓고 분모 0 이면 `null` 이다.
//     이 파일은 그 규칙을 고쳐 쓰지 않고, 분모가 왜 작은지(경계에 걸린 통화·제외된 시각)를
//     경고로 올린다.
//  3) **판정을 만든다.** "양호/주의", 목표 대비 달성률, 전월 대비 증감률 — 전부 만들지 않는다.
//     기준선이 없는 증감률은 그 자체로 주장이 되고, 한 번 화면에 나가면 대외 약속이 된다(§13-4).
//
// **판정하지 않는다.** 지표 계산은 `aggregate.ts` 하나이고(§2) 이 파일에 임계값·목표치·가중치가 없다.
// **시계를 만들지 않는다.** 기간은 투영이 가진 것을 그대로 적는다.
// **저장하지 않는다.** 결과를 어디에도 적지 않는다(§6.2).
import type { ChannelKind } from '../domain/types.ts';
import type { PeriodProjection } from '../events/periodLedger.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type {
  Completeness, IntentCount, LatencyReport, OutcomeRates, Ratio, ReportGranularity, ReportSummary,
} from './aggregate.ts';
import {
  aggregateReport, completeness, handoffRate, latencyReport, outcomeRates, topIntents, unrecognizedRate,
} from './aggregate.ts';

export const REPORT_RUN_CONTRACT_VERSION = 1;

export type ReportRunStatus =
  | 'empty'      // 투영 범위에 이벤트가 없었다 — "통화가 0건이었다"와 구분한다
  | 'reported';

export interface ReportRunParams {
  /** `projectLedgerPeriod`·`projectLedgerPeriodFromLog` 결과 **그대로**. */
  projection: PeriodProjection;
  granularity: ReportGranularity;
  /** 채널 필터. 미지정이면 전 채널. */
  channels?: ChannelKind[];
  /** 인텐트 상위 N. 미지정이면 전체(기본값을 만들지 않는다, §13-3). */
  topIntentLimit?: number;
}

export interface ReportRunResult {
  status: ReportRunStatus;
  /** 화면·로그에 그대로 쓸 한 줄. */
  messageKo: string;
  /**
   * 이 표를 **완전한 표로 제시해도 되는가**. false 면 화면이 "일부 구간이 빠졌습니다"를 함께
   * 보여야 한다 — 숨기면 운영이 멀쩡한 구간을 뒤진다.
   */
  complete: boolean;
  /** 완전하지 않은 사유. `complete` 가 true 면 빈 배열이다. */
  incompletenessKo: string[];
  warningsKo: string[];
  /** 검사하지 못하는 범위(투영에서 그대로 옮긴다). */
  limitsKo: string[];
  /** 기간. 투영이 선언한 것 그대로이며, 없으면 전 기간이다. */
  period?: { fromIso: string; toIso: string };
  summary: ReportSummary;
  /** 전 기간 합계 버킷에서 뽑은 보조 지표. 버킷별 값은 `summary.buckets` 로 같은 함수를 쓴다. */
  latency: LatencyReport;
  outcomes: OutcomeRates;
  handoff: Ratio;
  unrecognized: Ratio;
  completeness: Completeness;
  topIntents: IntentCount[];
}

/**
 * 기간 투영 → §7 7.6 리포트.
 *
 * 순수 함수다(시각·난수·I/O 없음). 같은 투영을 넣으면 같은 표가 나온다 — 리포트는 재현되지 않으면
 * 근거가 아니다.
 */
export function runReport(p: ReportRunParams): ReportRunResult {
  assertTenantScope(p.projection.scope);
  if (p.channels !== undefined && p.channels.length === 0) {
    throw new Error(
      '채널 필터를 빈 목록으로 선언할 수 없다 — 전 채널이 통째로 빠져 "통화가 없던 기간"으로 읽힌다 (설계서 §7 7.6)',
    );
  }

  // 기간은 넘기지 않는다(위 1번). 채널 필터만 그대로 쓴다.
  const summary = aggregateReport(p.projection.events, {
    scope: p.projection.scope,
    granularity: p.granularity,
    ...(p.channels !== undefined ? { channels: [...p.channels] } : {}),
  });

  const c = p.projection.counters;
  const incompletenessKo: string[] = [];
  if (c.truncated) {
    incompletenessKo.push(
      `기간 투영이 잘렸습니다 — 보지 않은 이벤트 ${c.eventsSkipped}건이 이 표에 없습니다 (설계서 §13-3)`,
    );
  }
  if (c.timestampsRejected > 0) {
    incompletenessKo.push(
      `오프셋 명시 ISO8601 이 아닌 시각 ${c.timestampsRejected}건은 기간에 놓을 수 없어 제외했습니다 — ` +
      '그만큼의 턴·세션이 이 표에 없습니다 (설계서 §13-3)',
    );
  }
  if (c.eventsRejected > 0) {
    incompletenessKo.push(`event_id 없는 이벤트 ${c.eventsRejected}건을 제외했습니다 (설계서 §8.1)`);
  }
  if (summary.timestampsRejected > 0) {
    incompletenessKo.push(
      `집계에서 시각을 읽을 수 없어 제외한 이벤트 ${summary.timestampsRejected}건이 더 있습니다 (설계서 §13-3)`,
    );
  }

  const warningsKo: string[] = [];
  if (p.projection.noteKo !== undefined) warningsKo.push(`기간 투영: ${p.projection.noteKo}`);
  if (c.foreignTenantDropped > 0) {
    warningsKo.push(
      `다른 테넌트 이벤트 ${c.foreignTenantDropped}건이 투영 전에 걸러졌습니다 — 지표는 안전하지만 ` +
      '전달 경로에 결함이 있다는 신호입니다 (설계서 §11.1)',
    );
  }
  if (c.interactionsWithoutStartInPeriod > 0 || c.interactionsWithoutEndInPeriod > 0) {
    warningsKo.push(
      `경계에 걸친 통화가 있습니다 — 시작을 못 본 통화 ${c.interactionsWithoutStartInPeriod}건 · ` +
      `종료를 못 본 통화 ${c.interactionsWithoutEndInPeriod}건. 종료 세션이 분모인 비율(Outcome·이관율)은 ` +
      '그만큼 작은 분모 위에서 계산됩니다 (설계서 §7 7.6)',
    );
  }
  if (c.offsetFormsSeen.length > 1) {
    warningsKo.push(
      `이벤트 시각 오프셋이 섞여 있습니다(${c.offsetFormsSeen.join(', ')}) — 리포트 버킷은 시각 원문의 ` +
      '접두사이므로 같은 시점이 서로 다른 버킷으로 갈라집니다 (설계서 §7 7.6)',
    );
  }
  const unknowns = summary.total.channelsUnknown + summary.total.outcomesUnknown + summary.total.handoffReasonsUnknown;
  if (unknowns > 0) {
    warningsKo.push(
      `계약에 없는 열거값 ${unknowns}건을 집계하지 않았습니다(채널 ${summary.total.channelsUnknown} · ` +
      `Outcome ${summary.total.outcomesUnknown} · 이관 사유 ${summary.total.handoffReasonsUnknown}) — ` +
      '이벤트를 만든 채널 어댑터를 점검하세요 (설계서 §8.1)',
    );
  }
  if (summary.outOfRangeDropped > 0) {
    warningsKo.push(`채널 필터로 제외한 이벤트 ${summary.outOfRangeDropped}건`);
  }

  const total = summary.total;
  const base: Omit<ReportRunResult, 'status' | 'messageKo'> = {
    complete: incompletenessKo.length === 0,
    incompletenessKo,
    warningsKo,
    limitsKo: [...p.projection.limitsKo],
    ...(p.projection.period !== undefined ? { period: { ...p.projection.period } } : {}),
    summary,
    latency: latencyReport(total),
    outcomes: outcomeRates(total),
    handoff: handoffRate(total),
    unrecognized: unrecognizedRate(total),
    completeness: completeness(total),
    ...(p.topIntentLimit !== undefined
      ? { topIntents: topIntents(total, p.topIntentLimit) }
      : { topIntents: topIntents(total) }),
  };

  if (summary.eventsCounted === 0) {
    return {
      status: 'empty',
      messageKo:
        `투영 범위에 집계할 이벤트가 없었습니다(받은 줄 ${c.eventsSeen}건 · 기간 밖 ${c.outOfPeriodDropped}건 · ` +
        `채널 필터 제외 ${summary.outOfRangeDropped}건). "통화가 0건이었다"와 다릅니다 (설계서 §13-3).`,
      ...base,
    };
  }

  return {
    status: 'reported',
    messageKo:
      `리포트를 산출했습니다 — 이벤트 ${summary.eventsCounted}건 · 버킷 ${summary.buckets.length}개 · ` +
      `시작 ${total.sessionsStarted}건 · 종료 ${total.sessionsEnded}건 · 턴 ${total.turns}건 · 이관 ${total.handoffs}건.`,
    ...base,
  };
}
