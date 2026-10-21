// 리포트 집계 — 설계서 §7 7.6(리포트) · §8.1(이벤트가 유일한 원천) · §4.1(Outcome) · §11.1(테넌트 격리).
//
// 대시보드·리포트가 각자 자기 방식으로 숫자를 세면, 같은 화면 두 개가 다른 값을 보여주고 그 순간 신뢰가 끝난다.
// 그래서 집계는 여기 한 곳에서만 한다. 입력은 §8.1 이벤트뿐이고, 순수 함수다.
//
// 이 파일이 하지 않는 일:
//   - 목표치·기준선·"양호/주의" 판정을 두지 않는다(§13-3·13-4). 근거 없는 수치를 코드에 박으면 그게 곧 대외 약속이 된다.
//   - 결측을 추정으로 메우지 않는다. 값이 없으면 없는 채로 세고, 몇 건이 빠졌는지를 함께 돌려준다.
//   - 비율을 맨숫자로 돌려주지 않는다. 분자·분모를 같이 실어 보내 분모가 3건인 90%를 90%처럼 보이지 않게 한다.

import type { ChannelKind, Outcome, Handoff } from '../domain/types.ts';
import type {
  InteractionEvent,
  SessionEndedEvent,
  TurnCompletedEvent,
  HandoffRequestedEvent,
} from '../events/schema.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import { isZonedIso } from '../events/periodLedger.ts';

export type ReportGranularity = 'hour' | 'day' | 'month' | 'total';

/**
 * 버킷 키는 ISO 문자열 접두사로 만든다 — 로컬 타임존 변환을 Core 에 넣지 않는다(테넌트마다 다르다).
 *
 * 그 대가는 숨기지 않는다: 이벤트 시각의 오프셋이 섞이면(`Z` 와 `+09:00`) **같은 시점이 서로 다른
 * 버킷으로 갈라진다**. `billing/usage.ts` 의 `bucketKey` 는 UTC 로 정규화하므로 그때 과금과 리포트가
 * 다른 값을 보여준다. 규칙을 두 모듈에서 통일하지 않는 이유는 테넌트 시간대를 Core 가 정하지 않기
 * 위해서이고(§13-3), 대신 `events/periodLedger.ts` 의 투영이 **오프셋이 섞였다는 관측**을 적는다.
 */
export function reportBucketKey(occurredAtIso: string, g: ReportGranularity): string {
  switch (g) {
    case 'hour': return occurredAtIso.slice(0, 13);
    case 'day': return occurredAtIso.slice(0, 10);
    case 'month': return occurredAtIso.slice(0, 7);
    case 'total': return 'total';
  }
}

/** 분모를 감추지 않는 비율. 분모 0 이면 ratio 는 null 이다(0% 로 표시하지 말 것). */
export interface Ratio {
  numerator: number;
  denominator: number;
  ratio: number | null;
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, ratio: denominator > 0 ? numerator / denominator : null };
}

export type OutcomeCounts = Record<Outcome, number>;
export type HandoffReasonCounts = Record<Handoff['reason'], number>;

function emptyOutcomes(): OutcomeCounts {
  return { AUTO_RESOLVED: 0, TRANSFERRED: 0, ABANDONED: 0, FAILED: 0 };
}

function emptyHandoffReasons(): HandoffReasonCounts {
  return { low_confidence: 0, customer_request: 0, policy: 0, error: 0, max_retry: 0 };
}

/** 지연 표본. 실측값만 담기며, 값이 없는 턴은 missing 으로 센다(0 으로 채우지 않는다). */
export interface LatencySamples {
  totalMs: number[];
  sttMs: number[];
  llmTtftMs: number[];
  ttsTtfbMs: number[];
  missing: number;
}

function emptySamples(): LatencySamples {
  return { totalMs: [], sttMs: [], llmTtftMs: [], ttsTtfbMs: [], missing: 0 };
}

export interface ReportBucket {
  bucket: string;
  sessionsStarted: number;
  sessionsEnded: number;
  turns: number;
  customerTurns: number;
  botTurns: number;
  handoffs: number;
  outcomes: OutcomeCounts;
  handoffReasons: HandoffReasonCounts;
  channels: Record<ChannelKind, number>;
  /** 인텐트별 턴 수(빈도순 정렬은 topIntents 로 뽑는다) */
  intents: Record<string, number>;
  /** 인텐트가 비어 있던 고객 턴 — 미인식 비중을 감추지 않기 위해 별도로 센다(§5.1) */
  customerTurnsWithoutIntent: number;
  /** 마스킹이 실제로 발생한 턴 수(§10.3 운영 점검용) */
  turnsWithPiiMasked: number;
  latency: LatencySamples;
  /** 세션 길이 표본(ms) — session.ended 의 duration_ms 가 있는 건만 */
  durationMs: number[];
  sessionsMissingDuration: number;
  /**
   * 계약에 없는 채널 값으로 온 이벤트 수.
   *
   * 이벤트는 §8.1 원장에서 오고 원장에는 과거 호스트가 넣은 값도 남아 있다. 모르는 키로
   * `channels[e.channel] += 1` 을 하면 `undefined + 1` 이 되어 **그 채널 칸이 NaN 으로 굳고**,
   * NaN 은 어떤 비교에서도 거짓이라 화면에서는 "집계 안 됨"이 아니라 그냥 빈 칸으로 보인다
   * (`billing/usage.ts` 의 `usageValuesRejected` 와 같은 이유다). 0 으로도 그대로도 세지 않고
   * 건수만 적는다 — 대응은 리포트 수정이 아니라 **그 이벤트를 만든 채널 어댑터 수정**이다.
   */
  channelsUnknown: number;
  /** 계약에 없는 Outcome 값(§4.1). 위와 같은 이유로 따로 센다. */
  outcomesUnknown: number;
  /**
   * `AUTO_RESOLVED` 로 기록된 종료 중 §4.1 **재문의 여부가 선언된** 건수
   * (`re_contact_within_24h` 가 `true`/`false` 로 실려 온 건).
   *
   * 왜 세는가: 이 파일은 Outcome 을 재판정하지 않고 기록된 값을 그대로 센다 — 그 전제는
   * "재문의 반영은 `resolveOutcome` 이 끝냈고 결과가 이벤트에 실려 온다"였다. 그런데 그 보정은
   * **통화가 끝난 뒤에야 알 수 있는 사실**이라 종료 시점에는 채울 수 없고, 실제로 저장소 어디에도
   * 이 칸을 채우는 코드가 없다. 그러면 `autoResolved` 는 언제나 **재문의 0건을 가정한 상한**인데,
   * 화면에는 그냥 "자동완결률"로 나간다 — 근거 없는 KPI 가 되는 경로가 정확히 이것이다(§13-3).
   * 세어 두면 리포트가 "보정이 한 번도 적용되지 않았다"를 사실로 적을 수 있다.
   */
  autoResolvedReContactDeclared: number;
  /**
   * 그중 **재문의가 있었다고 선언된** 건수. 같은 이벤트가 §4.1 로는 `ABANDONED` 인데 기록은
   * `AUTO_RESOLVED` 인 상태다 — 여기서 **고쳐 세지 않는다**(판정은 `resolveOutcome` 한 곳, §2.
   * 집계가 Outcome 을 바꾸기 시작하면 같은 원장이 화면마다 다른 값을 낸다). 대신 모순을 드러내
   * 리포트가 "자동완결률이 그만큼 높게 적혀 있다"를 적을 수 있게 한다.
   */
  autoResolvedReContacted: number;
  /** 계약에 없는 이관 사유(§2). 위와 같은 이유로 따로 센다. */
  handoffReasonsUnknown: number;
  /**
   * §5.1 되물음 — **봇이 실제로 다시 물은 턴 수**(`retry_count >= 1` 인 봇 턴).
   *
   * 왜 세는가: 이 파일은 턴 수와 미인식 비중까지 세면서 **재시도는 한 번도 읽지 않았다**.
   * 그래서 "한 번에 끝난 통화"와 "세 번 되물은 통화"가 같은 턴 수로 보였고, 재프롬프트
   * 정책(§5.1)을 켜거나 문안을 고친 뒤 되묻는 횟수가 줄었는지 확인할 실측이 Core 밖에
   * 없었다 — 원장에는 `retry_count` 가 있는데 읽는 코드가 0줄이었다.
   */
  repromptsSent: number;
  /**
   * 되물음 뒤에 **고객이 실제로 다시 답한** 턴 수(`retry_count >= 1` 인 고객 턴).
   * 봇 쪽과 따로 세는 이유: 되묻고 고객이 끊으면 두 수가 벌어진다 — 그 차이가 §5.1
   * 사다리 조정의 유일한 실측 근거이고, 한 수로 합치면 그 사실이 사라진다.
   */
  customerTurnsAfterRetry: number;
  /** 관측된 최대 재시도 회차. 시나리오의 `maxRetry` 설정과 비교할 수 있는 유일한 실측이다. */
  maxRetryObserved: number;
  /**
   * 쓸 수 없는 `retry_count`(정수 아님·음수·NaN)로 세지 못한 턴 수.
   * 0 으로도 그대로도 세지 않는다 — `channelsUnknown` 과 같은 이유다(NaN 하나가 최댓값
   * 비교를 전부 거짓으로 만들고, 그러면 화면에는 "재시도 없음"으로 보인다).
   */
  retryValuesRejected: number;
}

function newBucket(bucket: string): ReportBucket {
  return {
    bucket,
    sessionsStarted: 0,
    sessionsEnded: 0,
    turns: 0,
    customerTurns: 0,
    botTurns: 0,
    handoffs: 0,
    outcomes: emptyOutcomes(),
    handoffReasons: emptyHandoffReasons(),
    channels: { voice: 0, visual: 0, chat: 0 },
    intents: {},
    customerTurnsWithoutIntent: 0,
    turnsWithPiiMasked: 0,
    latency: emptySamples(),
    durationMs: [],
    sessionsMissingDuration: 0,
    channelsUnknown: 0,
    outcomesUnknown: 0,
    autoResolvedReContactDeclared: 0,
    autoResolvedReContacted: 0,
    handoffReasonsUnknown: 0,
    repromptsSent: 0,
    customerTurnsAfterRetry: 0,
    maxRetryObserved: 0,
    retryValuesRejected: 0,
  };
}

/**
 * 계약에 있는 키만 올린다. 열거값 목록을 여기서 다시 적지 않는 것이 핵심이다(§2) —
 * **빈 버킷이 가진 키가 곧 계약**이므로, 열거형이 늘어나도 두 곳을 고칠 일이 없다.
 */
function bump(rec: Record<string, number>, key: unknown): boolean {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(rec, key)) return false;
  if (typeof rec[key] !== 'number') return false;
  rec[key] += 1;
  return true;
}

export interface ReportOptions {
  scope: TenantScope;
  granularity: ReportGranularity;
  /**
   * 기간 필터(ISO8601 **오프셋 명시**, 경계 포함). 생략하면 전체.
   *
   * **시점으로 비교한다.** 문자열로 비교하면 `2026-10-01T00:00:00+09:00` 과
   * `2026-09-30T15:00:00Z` 가 같은 시점인데도 앞뒤가 뒤바뀐다 — 그러면 같은 원장이 호스트가
   * 어떤 오프셋을 쓰느냐에 따라 다른 리포트를 낸다. 오프셋 없는 경계는 **던진다**(설정 오류):
   * `Date.parse('2026-10-01T00:00:00')` 는 성공하고 서버 로컬로 해석되므로, 통과시키면 같은
   * 코드가 서버마다 다른 기간을 집계한다(§13-3).
   *
   * 기간 투영(`events/periodLedger.ts`)을 쓰는 경로는 **여기에 기간을 넘기지 않는다** —
   * 투영은 반개구간 [from, to) 이고 이쪽은 양쪽 포함이라, 둘을 같이 쓰면 경계 해석이 두 개가 된다(§2).
   */
  from?: string;
  to?: string;
  channels?: ChannelKind[];
}

export interface ReportSummary {
  tenantId: string;
  granularity: ReportGranularity;
  from?: string;
  to?: string;
  eventsCounted: number;
  duplicatesDropped: number;
  foreignTenantDropped: number;
  /** 기간·채널 필터로 제외한 이벤트 수. */
  outOfRangeDropped: number;
  /**
   * 기간 필터가 선언됐는데 시각을 시점으로 읽을 수 없어 제외한 이벤트 수(오프셋 미명시 포함).
   * 0 으로도 범위 안으로도 넣지 않는다 — 넣으면 읽을 수 없는 시각이 조용히 이 기간의 지표가 된다.
   */
  timestampsRejected: number;
  buckets: ReportBucket[];
  /** 전 기간 합계 — 버킷과 같은 규칙으로 계산된 단일 버킷이다. */
  total: ReportBucket;
}

/** 같은 event_id 는 한 번만 센다(§8.1 멱등). 이벤트 버스가 재전송해도 지표가 부풀지 않게 한다. */
function dedupe(events: InteractionEvent[]): InteractionEvent[] {
  const seen = new Set<string>();
  const out: InteractionEvent[] = [];
  for (const e of events) {
    if (seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    out.push(e);
  }
  return out;
}

function pushLatency(b: ReportBucket, e: InteractionEvent): void {
  const l = e.latency_ms ?? {};
  let any = false;
  if (typeof l.total_ms === 'number') { b.latency.totalMs.push(l.total_ms); any = true; }
  if (typeof l.stt_ms === 'number') { b.latency.sttMs.push(l.stt_ms); any = true; }
  if (typeof l.llm_ttft_ms === 'number') { b.latency.llmTtftMs.push(l.llm_ttft_ms); any = true; }
  if (typeof l.tts_ttfb_ms === 'number') { b.latency.ttsTtfbMs.push(l.tts_ttfb_ms); any = true; }
  if (!any) b.latency.missing += 1;
}

/**
 * §5.1 재시도 실측. **없는 것과 쓸 수 없는 것을 가른다**(`duration_ms` 와 같은 규칙):
 * 필드가 없으면 그 턴은 재시도가 아니었다는 뜻이고(0 과 같다), 정수 아님·음수는 거부로 센다.
 */
function pushRetry(b: ReportBucket, t: TurnCompletedEvent): void {
  const r = t.retry_count;
  if (r === undefined) return;
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0) {
    b.retryValuesRejected += 1;
    return;
  }
  if (r === 0) return;                       // 명시적 0 은 "재시도 없음" 이다 — 되물음으로 세지 않는다
  if (t.speaker === 'bot') b.repromptsSent += 1;
  if (t.speaker === 'customer') b.customerTurnsAfterRetry += 1;
  if (r > b.maxRetryObserved) b.maxRetryObserved = r;
}

function accumulate(b: ReportBucket, e: InteractionEvent): void {
  if (!bump(b.channels as unknown as Record<string, number>, e.channel)) b.channelsUnknown += 1;

  switch (e.type) {
    case 'session.started':
      b.sessionsStarted += 1;
      break;
    case 'turn.completed': {
      const t = e as TurnCompletedEvent;
      b.turns += 1;
      if (t.speaker === 'customer') {
        b.customerTurns += 1;
        if (!t.intent) b.customerTurnsWithoutIntent += 1;
      }
      if (t.speaker === 'bot') b.botTurns += 1;
      if (t.intent) b.intents[t.intent] = (b.intents[t.intent] ?? 0) + 1;
      if (t.pii_masked) b.turnsWithPiiMasked += 1;
      pushRetry(b, t);
      pushLatency(b, t);
      break;
    }
    case 'handoff.requested': {
      const h = e as HandoffRequestedEvent;
      b.handoffs += 1;
      if (!bump(b.handoffReasons as unknown as Record<string, number>, h.reason)) b.handoffReasonsUnknown += 1;
      break;
    }
    case 'session.ended': {
      const s = e as SessionEndedEvent;
      b.sessionsEnded += 1;
      if (!bump(b.outcomes as unknown as Record<string, number>, s.outcome)) b.outcomesUnknown += 1;
      // §4.1 재문의 보정의 **적용 여부**만 센다(값은 고치지 않는다 — 위 필드 주석).
      // `true`/`false` 둘 다 "선언됐다"로 센다: 선언되지 않은 것과 "없었다고 확인한 것"은 다르다.
      if (s.outcome === 'AUTO_RESOLVED' && typeof s.re_contact_within_24h === 'boolean') {
        b.autoResolvedReContactDeclared += 1;
        if (s.re_contact_within_24h) b.autoResolvedReContacted += 1;
      }
      if (typeof s.duration_ms === 'number') b.durationMs.push(s.duration_ms);
      else b.sessionsMissingDuration += 1;
      break;
    }
  }
}

/** 기간 경계. 오프셋 없는 선언은 설정 오류다 — 위 `ReportOptions.from` 주석 참조. */
function boundMs(bound: string | undefined, label: 'from' | 'to'): number | undefined {
  if (bound === undefined) return undefined;
  if (!isZonedIso(bound)) {
    throw new Error(
      `기간 경계(${label})가 오프셋 명시 ISO8601 이 아니다: ${JSON.stringify(bound)} — ` +
      '오프셋이 없으면 같은 원장이 서버 시간대마다 다른 기간을 집계한다 (설계서 §13-3)',
    );
  }
  return Date.parse(bound);
}

/**
 * 이벤트 스트림 → 리포트 집계.
 * Outcome 은 여기서 재판정하지 않는다 — 재문의(24h) 반영은 §4.1 resolveOutcome 의 몫이고,
 * 그 결과가 session.ended 에 실려 오는 것이 이벤트 계약이다. 두 곳에서 판정하면 값이 갈린다.
 *
 * 다만 **그 계약이 실제로 지켜지는지는 세어 둔다**. `resolveOutcome` 은 종료 시점에 돌고
 * 재문의는 그 뒤 24시간의 사실이라 종료 이벤트에 채울 수 있는 시점이 없다 — 즉 보정은
 * 지금까지 **한 건에도 적용된 적이 없고**, `autoResolved` 는 언제나 재문의 0건을 가정한
 * 상한이다. 값을 고치지는 않되(§2) 그 사실이 리포트에 적히게 한다(§13-3).
 */
export function aggregateReport(events: InteractionEvent[], opts: ReportOptions): ReportSummary {
  assertTenantScope(opts.scope);
  const tenantId = opts.scope.tenantId;

  const sameTenant = events.filter(e => e.tenant_id === tenantId);
  const foreignTenantDropped = events.length - sameTenant.length;

  const unique = dedupe(sameTenant);
  const duplicatesDropped = sameTenant.length - unique.length;

  const channelFilter = opts.channels;
  const fromMs = boundMs(opts.from, 'from');
  const toMs = boundMs(opts.to, 'to');
  let timestampsRejected = 0;
  const inRange = unique.filter(e => {
    if (channelFilter && !channelFilter.includes(e.channel)) return false;
    if (fromMs === undefined && toMs === undefined) return true;
    if (!isZonedIso(e.occurred_at)) {
      timestampsRejected += 1;
      return false;
    }
    const ms = Date.parse(e.occurred_at);
    if (fromMs !== undefined && ms < fromMs) return false;
    if (toMs !== undefined && ms > toMs) return false;
    return true;
  });
  const outOfRangeDropped = unique.length - inRange.length - timestampsRejected;

  const map = new Map<string, ReportBucket>();
  const total = newBucket('total');

  for (const e of inRange) {
    const key = reportBucketKey(e.occurred_at, opts.granularity);
    let b = map.get(key);
    if (!b) {
      b = newBucket(key);
      map.set(key, b);
    }
    accumulate(b, e);
    accumulate(total, e);
  }

  return {
    tenantId,
    granularity: opts.granularity,
    ...(opts.from !== undefined ? { from: opts.from } : {}),
    ...(opts.to !== undefined ? { to: opts.to } : {}),
    eventsCounted: inRange.length,
    duplicatesDropped,
    foreignTenantDropped,
    outOfRangeDropped,
    timestampsRejected,
    buckets: [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    total,
  };
}

/**
 * 백분위(nearest-rank). 표본이 없으면 null 이다 — 0 을 돌려주면 "지연 0ms" 로 읽힌다.
 * 표본이 적을 때 p95 가 최댓값과 같아지는 것은 정상이며, 그래서 sampleCount 를 항상 함께 노출한다.
 */
export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  if (!(p > 0 && p <= 100)) throw new Error(`백분위는 0 초과 100 이하여야 한다: ${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export interface LatencyStat {
  sampleCount: number;
  missing: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
}

function statOf(samples: number[], missing: number): LatencyStat {
  return {
    sampleCount: samples.length,
    missing,
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    p95: percentile(samples, 95),
    max: samples.length ? Math.max(...samples) : null,
  };
}

export interface LatencyReport {
  total: LatencyStat;
  stt: LatencyStat;
  llmTtft: LatencyStat;
  ttsTtfb: LatencyStat;
}

/** 평균은 내보내지 않는다. 응답지연은 꼬리가 문제이고, 평균은 그 꼬리를 가린다. */
export function latencyReport(b: ReportBucket): LatencyReport {
  return {
    total: statOf(b.latency.totalMs, b.latency.missing),
    stt: statOf(b.latency.sttMs, b.latency.missing),
    llmTtft: statOf(b.latency.llmTtftMs, b.latency.missing),
    ttsTtfb: statOf(b.latency.ttsTtfbMs, b.latency.missing),
  };
}

/**
 * §5.1 되물음 실태. **비율을 만들지 않는다**(§13-3) — "되물음률"의 분모를 무엇으로 둘지는
 * 정의 문제이고(턴·세션·실패 턴 중 어느 것?) 근거 없이 고르면 그 숫자가 곧 대외 수치가 된다.
 * 건수와 최댓값만 그대로 올린다.
 */
export interface RepromptReport {
  /** 봇이 실제로 다시 물은 턴 수. */
  sent: number;
  /** 되물음 뒤 고객이 다시 답한 턴 수. `sent` 와 벌어진 만큼이 되묻고 끊긴 통화다. */
  customerTurnsAfterRetry: number;
  /** 관측된 최대 재시도 회차. 시나리오 `maxRetry` 와 비교할 유일한 실측이다. */
  maxObserved: number;
  /** 쓸 수 없는 `retry_count` 로 세지 못한 턴 수. 0 과 구분된다. */
  rejected: number;
}

export function repromptReport(b: ReportBucket): RepromptReport {
  return {
    sent: b.repromptsSent,
    customerTurnsAfterRetry: b.customerTurnsAfterRetry,
    maxObserved: b.maxRetryObserved,
    rejected: b.retryValuesRejected,
  };
}

export interface IntentCount { intent: string; count: number }

/** 빈도 내림차순, 동률은 이름 오름차순(리포트 재생성 시 순서가 흔들리지 않게). */
export function topIntents(b: ReportBucket, limit?: number): IntentCount[] {
  const list = Object.entries(b.intents)
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b2) => (b2.count - a.count) || a.intent.localeCompare(b2.intent));
  return typeof limit === 'number' ? list.slice(0, limit) : list;
}

export interface OutcomeRates {
  /** 분모는 종료된 세션(session.ended)이다. 진행 중 세션을 분모에 넣으면 값이 시각에 따라 출렁인다. */
  denominatorSessionsEnded: number;
  autoResolved: Ratio;
  transferred: Ratio;
  abandoned: Ratio;
  failed: Ratio;
  /**
   * §4.1 재문의 보정의 적용 실태. **비율과 같은 객체에 둔다** — 따로 두면 화면이 비율만 가져가
   * "자동완결률"로 표시하고, 보정이 한 번도 적용되지 않았다는 사실은 그 옆 칸에 남아 아무도
   * 보지 않는다. 판정하지 않고 건수만 적는다(§13-3).
   */
  autoResolvedReContactDeclared: number;
  /** §4.1 로는 `ABANDONED` 인데 `AUTO_RESOLVED` 로 기록된 건수. 집계는 고쳐 세지 않는다(§2). */
  autoResolvedReContacted: number;
  /**
   * `autoResolved` 가 **재문의 보정을 거치지 않은 상한**인가.
   * `AUTO_RESOLVED` 기록이 있는데 그중 재문의 선언이 한 건도 없으면 true 다 —
   * 보정 대상이 아예 없는 기간(자동완결 0건)과 구분하기 위해 분자 0 일 때는 false 다.
   */
  autoResolvedIsUpperBound: boolean;
}

export function outcomeRates(b: ReportBucket): OutcomeRates {
  const d = b.sessionsEnded;
  const auto = b.outcomes.AUTO_RESOLVED;
  return {
    denominatorSessionsEnded: d,
    autoResolved: ratio(auto, d),
    transferred: ratio(b.outcomes.TRANSFERRED, d),
    abandoned: ratio(b.outcomes.ABANDONED, d),
    failed: ratio(b.outcomes.FAILED, d),
    autoResolvedReContactDeclared: b.autoResolvedReContactDeclared,
    autoResolvedReContacted: b.autoResolvedReContacted,
    autoResolvedIsUpperBound: auto > 0 && b.autoResolvedReContactDeclared === 0,
  };
}

/** 미인식률 — 고객 턴 대비 인텐트 미부여 턴(§5.1 폴백 튜닝의 출발점). */
export function unrecognizedRate(b: ReportBucket): Ratio {
  return ratio(b.customerTurnsWithoutIntent, b.customerTurns);
}

/** 이관율 — 분모는 종료 세션. handoff.requested 건수가 아니라 Outcome 기준이다(중복 요청 방지). */
export function handoffRate(b: ReportBucket): Ratio {
  return ratio(b.outcomes.TRANSFERRED, b.sessionsEnded);
}

/**
 * 리포트 신뢰도 표시. 결측이 있는데도 "완전한 표"처럼 보이는 것을 막는다.
 * 판정 기준(몇 % 부터 경고인지)은 두지 않고, 결측 건수만 그대로 올린다(§13-3).
 */
export interface Completeness {
  sessionsStarted: number;
  sessionsEnded: number;
  /** 시작 기록만 있고 종료 이벤트가 없는 건수 — 음수면 기간 경계에서 잘린 세션이다. */
  endedMinusStarted: number;
  sessionsMissingDuration: number;
  turnsMissingLatency: number;
  /** 쓸 수 없는 `retry_count` 로 §5.1 재시도 집계에서 빠진 턴 수. */
  turnsRetryRejected: number;
}

export function completeness(b: ReportBucket): Completeness {
  return {
    sessionsStarted: b.sessionsStarted,
    sessionsEnded: b.sessionsEnded,
    endedMinusStarted: b.sessionsEnded - b.sessionsStarted,
    sessionsMissingDuration: b.sessionsMissingDuration,
    turnsMissingLatency: b.latency.missing,
    turnsRetryRejected: b.retryValuesRejected,
  };
}
