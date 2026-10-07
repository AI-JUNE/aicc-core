// 원장 → 기간 이벤트 투영 — 설계서 §8.1(이벤트가 유일한 원천)·§11.1(테넌트 격리)·§11.2(과금 근거)·
// §7 7.6(리포트)·§13-3(실측만)·§6.2(저장하지 않는다).
//
// 왜 이 파일이 필요한가. §11.2 과금 경로와 §7 7.6 리포트 경로는 **양쪽 끝이 다 있다** —
// `billing/usage.ts` 의 `aggregateUsage`, `billing/reconcile.ts` 의 `runReconciliationScenario`,
// `reports/aggregate.ts` 의 `aggregateReport` 가 모두 `InteractionEvent[]` 를 받아 수량·지표를 내놓고,
// `events/store.ts` 의 `EventLog` 가 그 이벤트를 추가 전용으로 쌓는다. 그런데 **그 사이에서
// "이 달의 이벤트"를 만드는 코드가 저장소 전체에 0줄이었다** — 세 집계 함수의 첫 인자를 채우는
// 곳은 테스트뿐이다. 즉 원장은 쌓이는데 **청구 근거와 리포트는 한 번도 산출된 적이 없다.**
//
// 이 미배선이 조용한 방식은 (30)(31)과 또 다르다. 조회는 0건이 "통화가 없었다"로 보였고 파기는
// 0건이 "지울 것이 없었다"로 보였는데, 과금은 **호스트가 손으로 꿰는 순간 세 가지 중 하나로
// 틀린다** — 그리고 셋 다 숫자가 그럴듯하게 나온다.
//
//  (가) **원장을 통째로 넣는다.** `aggregateUsage` 는 이벤트마다 자기 `occurred_at` 으로 버킷을
//       잡으므로 전 기간 집계가 그대로 나오고, 그 집계를 이번 달 명세와 대사하면 지난달 버킷
//       전부가 `missing_external`(대조할 명세 없음)이 된다. `missing_external` 은 **과다청구
//       방향으로 본다**(reconcile.ts 의 규약)이라 판정은 `blocked` 다 — 즉 **달이 갈수록 청구가
//       영구히 막힌다**. 원인은 설정도 장애도 아니라 "기간을 안 잘랐다"인데, 판정문에는
//       "과다청구 방향 미해소 차이"로만 적힌다.
//
//  (나) **상한으로 잘라 읽는다.** `ReadOptions.limit` 로 읽으면 투영은 **잘렸다는 사실 자체를
//       볼 수 없다**(읽힌 줄만 손에 들어온다). 잘린 집계는 언제나 **작게** 나오고, 작은 쪽은
//       `core - external < 0` 이라 과다청구 방향이 아니다 — 그래서 `blocked` 가 아니라
//       `review_required` 로 떨어지고, 그 문구는 "과소청구 방향 차이(매출 누락)"다. 운영은
//       매출 누락으로 읽고 그대로 청구한다. 동시에 외부 명세에만 있는 구간은 `missing_core` 가
//       되어 **"이벤트 유실"** 가설이 붙는다 — 원장은 멀쩡한데 유실 조사가 시작된다.
//
//  (다) **기간 경계를 양쪽 포함으로 잡는다.** 월초 00:00:00.000 을 두 달이 모두 포함하면 그
//       순간의 `session.ended` 가 **두 달에 각각 한 번씩 청구된다**(이중 계상 = 과다청구).
//       그래서 이 파일의 기간은 **반개구간 [from, to)** 이고, 그 밖의 해석을 호스트가 고를 수
//       없게 한다.
//
// 그 외 이 파일이 고정하는 것:
//  - **오프셋 없는 ISO8601 을 시각으로 받지 않는다.** `Date.parse('2026-10-01T00:00:00')` 은
//    **성공하고** 호스트 로컬로 해석된다 — 월 경계가 서버 시간대만큼 움직여 같은 원장이 서버마다
//    다른 청구서를 낸다(§13-3). 경계 선언이 그 형태면 **던지고**(설정 오류), 이벤트 시각이 그
//    형태면 기간에 놓을 수 없으므로 세어서 드러낸다.
//  - **기간을 선언하지 않으면 청구 근거로 쓸 수 없다**(`usableForBilling: false`) — (가)가 곧
//    그 상태다. 리포트는 전 기간도 뜻이 있으므로 막지 않고 사실만 적는다.
//  - **시각 오프셋이 섞인 사실을 드러낸다.** `reports/aggregate.ts` 의 `reportBucketKey` 는
//    **원문 접두사**로 버킷을 만들고(테넌트 시간대를 Core 가 정하지 않기 위한 의도적 선택)
//    `billing/usage.ts` 의 `bucketKey` 는 UTC 로 정규화한다. 그래서 `+09:00` 과 `Z` 가 섞이면
//    같은 시점이 **리포트에서는 다른 버킷**으로 갈라지는데 과금에서는 갈라지지 않는다 — 화면 두
//    개가 다른 값을 보여주는 바로 그 상태다. 버킷 규칙을 여기서 바꾸지 않고(§2 — 판정은 각
//    집계 모듈 하나다) **섞였다는 관측만** 적는다.
//  - **판정하지 않는다.** 수량·반올림은 `billing/usage.ts`, 청구 가능 여부는 `billing/reconcile.ts`,
//    지표는 `reports/aggregate.ts` 하나씩이다. 이 파일에 단가도 임계값도 허용오차도 없다.
//  - **시계를 만들지 않는다.** 기간 경계는 전부 주입이고 현재 시각을 스스로 읽지 않는다(§13-3) —
//    검사가 이 파일에 현재 시각을 읽는 호출이 없음을 고정한다.
//  - **저장하지 않는다.** 투영 결과를 어디에도 적지 않는다(§6.2).
//  - **마스킹을 다시 걸지 않는다.** 이벤트는 원장에 들어갈 때 이미 §10.3 을 지났고, `maskPii` 는
//    자기 출력에 멱등이지만 이 파일은 발화를 **읽지도 싣지도 않는다**(수량·건수만 센다).
import type { InteractionEvent } from './schema.ts';
import type { EventLog, ReadOptions } from './store.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';

export const PERIOD_LEDGER_CONTRACT_VERSION = 1;

/**
 * 워크스페이스 단위 기간 투영을 지원하지 않는 이유.
 * §8.1 이벤트에는 `workspace_id` 가 없고 원장의 `append` 도 테넌트만 검사한다 — 워크스페이스
 * 스코프로 만든 원장에도 같은 테넌트의 다른 워크스페이스 이벤트가 들어온다. 조회에서는 그 오류가
 * "0건"이었지만(§7 2.2) 과금에서는 **다른 부서의 통화를 그 부서 청구서에 싣는 것**이다.
 * 이벤트 스키마에 워크스페이스를 넣는 것은 §8.1 추가 전용 계약의 변경이라 **[승인 필요]**.
 */
export const WORKSPACE_PERIOD_UNSUPPORTED_KO =
  '§8.1 이벤트에 워크스페이스 식별자가 없어 워크스페이스 단위 기간 투영을 지원하지 않는다 — 테넌트 범위로 투영하라 (설계서 §11.1·§11.2)';

/**
 * 원장 전수 투영이라는 한계. 기간이 원장 중간이어도 **끝까지 읽어야** 잘리지 않았음을 말할 수
 * 있다(추가 전용 원장은 시각 순서를 보장하지 않는다 — 채널 시계가 다르면 역행한다).
 * 대용량에서는 기간 색인을 가진 `EventLog` 구현이 필요하고 그것은 호스트 몫이다(§6.2).
 */
export const PERIOD_FULL_SCAN_LIMIT_KO =
  '원장을 끝까지 읽어 기간을 걸러낸다 — 대용량에서는 기간 색인을 가진 EventLog 구현이 필요하다 (설계서 §6.2)';

/**
 * 과금·리포트 기간. **반개구간 [fromIso, toIso)** 다 — 위 (다) 참조.
 * 두 값 모두 오프셋이 명시된 ISO8601 이어야 한다(§13-3).
 */
export interface LedgerPeriod {
  /** 포함(>=). */
  fromIso: string;
  /** **제외**(<). */
  toIso: string;
}

export interface PeriodProjectionOptions {
  scope: TenantScope;
  /** 미선언이면 전 기간. 청구 근거로는 쓸 수 없다(위 (가)). */
  period?: LedgerPeriod;
  /**
   * 투영 수집 상한. 기본값 없음(§13-3). 상한에 걸리면 `usableForBilling` 이 false 가 된다 —
   * 잘린 집계는 언제나 작게 나오고 작은 쪽은 과다청구 차단을 비껴간다(위 (나)).
   */
  maxEvents?: number;
  /**
   * 원장 읽기가 이미 잘렸다는 사실. `projectLedgerPeriodFromLog` 가 오프셋으로 판정해 넣는다.
   * 손으로 이벤트를 넘기는 호출자도 선언할 수 있다 — 선언하지 않으면 **검사하지 않는다**(§13-3).
   */
  readTruncated?: boolean;
}

export interface PeriodCounters {
  /** 투영 함수가 받은 줄 수(원장에서 읽힌 수가 아니다). */
  eventsSeen: number;
  /** 다른 테넌트 이벤트. 0 이 아니면 원장·전달 경로 버그다(§11.1). */
  foreignTenantDropped: number;
  /** `event_id` 가 없어 멱등 처리가 불가능한 이벤트(§8.1). */
  eventsRejected: number;
  /** 같은 `event_id` 재전송(§8.1 멱등). 집계기가 다시 세지 않도록 여기서 한 번 걷어낸다. */
  duplicatesDropped: number;
  /** 오프셋 명시 ISO8601 이 아니어서 **기간에 놓을 수 없었던** 이벤트. */
  timestampsRejected: number;
  /** 기간 밖이라 제외한 이벤트(기간 선언이 있을 때만). */
  outOfPeriodDropped: number;
  /** 상한을 넘겨 보지 않은 이벤트 수. */
  eventsSkipped: number;
  /** 투영 상한·원장 읽기 상한 어느 쪽이든 잘렸는가. */
  truncated: boolean;
  /** 투영에 들어간 이벤트 수. */
  eventsCounted: number;
  /** 기간 안에서 본 상호작용 수. */
  interactionsSeen: number;
  /** `session.started` 를 기간 안에서 못 본 상호작용(앞 경계에 걸친 통화). */
  interactionsWithoutStartInPeriod: number;
  /**
   * `session.ended` 를 기간 안에서 못 본 상호작용(뒤 경계에 걸친 통화·진행 중 통화).
   * 통화 시간은 `session.ended.billable_ms` 하나뿐이므로, 이 건수만큼의 통화 분은 **이 기간에
   * 잡히지 않는다**(다음 기간에 잡힌다). 0 으로 메우지 않고 건수로 적는다(§13-3).
   */
  interactionsWithoutEndInPeriod: number;
  /** `interaction_id` 가 없어 상호작용으로 묶지 못한 이벤트(집계에는 들어간다). */
  interactionsUnidentified: number;
  /** 관측된 시각 오프셋 형태(`Z`·`+09:00` …). 둘 이상이면 리포트 버킷이 갈라진다. */
  offsetFormsSeen: string[];
}

export interface PeriodProjection {
  /** 스코프. 원장에서 투영했으면 **원장이 가진 것**이다(호스트가 테넌트를 주장하지 못한다). */
  scope: TenantScope;
  period?: LedgerPeriod;
  /** 집계 함수에 그대로 넘긴다. 격리·멱등·기간·시각을 이미 지난 배열이다. */
  events: InteractionEvent[];
  counters: PeriodCounters;
  /**
   * 이 투영을 **청구 근거**로 쓸 수 있는가. false 면 `runUsageAggregation`·`runReconciliation` 이
   * 집계를 만들지 않는다 — 작게 나온 수량은 과다청구 차단을 비껴가고 "매출 누락"으로 읽힌다.
   */
  usableForBilling: boolean;
  /** 청구 근거로 쓸 수 없는 사유. 비어 있으면 `usableForBilling` 은 true 다. */
  billingRefusalsKo: string[];
  /** 검사하지 못하는 범위. 숨기면 "완전한 표"처럼 읽힌다. */
  limitsKo: string[];
  /** 화면·로그에 그대로 쓸 한 줄. 없으면 undefined. */
  noteKo?: string;
}

/**
 * 오프셋이 명시된 ISO8601 만 시각으로 받는다. 오프셋이 없으면 서버 시간대에 따라 기간 경계가
 * 몇 시간 움직인다 — 과금에서는 그만큼이 다른 달로 넘어가고, 보존기간에서는 그만큼 일찍·늦게
 * 지워진다. 그래서 두 경로가 같은 판정을 쓴다(§2).
 */
export function isZonedIso(s: unknown): boolean {
  return typeof s === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(s.trim()) && !Number.isNaN(Date.parse(s));
}

/** 오프셋 형태만 뽑는다(값은 싣지 않는다). */
function offsetFormOf(s: string): string {
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(s.trim());
  return m ? (m[1] as string) : '';
}

function newCounters(): PeriodCounters {
  return {
    eventsSeen: 0,
    foreignTenantDropped: 0,
    eventsRejected: 0,
    duplicatesDropped: 0,
    timestampsRejected: 0,
    outOfPeriodDropped: 0,
    eventsSkipped: 0,
    truncated: false,
    eventsCounted: 0,
    interactionsSeen: 0,
    interactionsWithoutStartInPeriod: 0,
    interactionsWithoutEndInPeriod: 0,
    interactionsUnidentified: 0,
    offsetFormsSeen: [],
  };
}

function assertPeriod(p: LedgerPeriod): { fromMs: number; toMs: number } {
  if (!isZonedIso(p.fromIso) || !isZonedIso(p.toIso)) {
    throw new Error(
      `기간 경계가 오프셋 명시 ISO8601 이 아니다: ${JSON.stringify(p.fromIso)} ~ ${JSON.stringify(p.toIso)} — ` +
      '오프셋이 없으면 같은 원장이 서버 시간대마다 다른 청구서를 낸다 (설계서 §13-3)',
    );
  }
  const fromMs = Date.parse(p.fromIso);
  const toMs = Date.parse(p.toIso);
  if (!(fromMs < toMs)) {
    throw new Error(
      `기간이 성립하지 않는다: ${p.fromIso} ~ ${p.toIso} — [from, to) 반개구간이므로 from < to 여야 한다 (설계서 §11.2)`,
    );
  }
  return { fromMs, toMs };
}

interface Acc {
  sawStart: boolean;
  sawEnd: boolean;
}

/**
 * §8.1 이벤트 → 기간 투영.
 *
 * 순수 함수이며 **순서가 곧 안전장치다**: 격리 → 식별자 → 멱등 → 시각 → 기간 → 상한 → 채택.
 * 기간 필터를 상한보다 **먼저** 두는 것이 핵심이다 — 반대로 두면 기간 밖 이벤트가 상한을 먹고,
 * 기간이 온전히 담겼는데도 "잘렸다"로 적혀 청구가 막힌다(그 반대보다 덜 위험하지만 여전히 거짓이다).
 */
export function projectLedgerPeriod(
  events: readonly InteractionEvent[],
  opts: PeriodProjectionOptions,
): PeriodProjection {
  assertTenantScope(opts.scope);
  if (opts.scope.workspaceId !== undefined) throw new Error(WORKSPACE_PERIOD_UNSUPPORTED_KO);
  if (opts.maxEvents !== undefined && (!Number.isInteger(opts.maxEvents) || opts.maxEvents <= 0)) {
    throw new Error(`수집 상한(maxEvents)은 1 이상의 정수여야 한다: ${String(opts.maxEvents)} (설계서 §13-3)`);
  }
  const bounds = opts.period === undefined ? undefined : assertPeriod(opts.period);

  const counters = newCounters();
  const seen = new Set<string>();
  const offsets = new Set<string>();
  const byId = new Map<string, Acc>();
  const kept: InteractionEvent[] = [];

  for (const e of events) {
    counters.eventsSeen += 1;
    // 격리를 가장 먼저 본다. 남의 테넌트 이벤트는 상한에도 세지 않는다 — 세면 잘린 사유가 흐려진다.
    if (!e.tenant_id || e.tenant_id !== opts.scope.tenantId) {
      counters.foreignTenantDropped += 1;
      continue;
    }
    if (!e.event_id) {
      counters.eventsRejected += 1;
      continue;
    }
    if (seen.has(e.event_id)) {
      counters.duplicatesDropped += 1;
      continue;
    }
    seen.add(e.event_id);

    // 시각을 읽을 수 없는 이벤트는 기간에 놓을 수 없다. 기간 선언이 없을 때도 같은 규칙을
    // 쓴다 — 버킷 키가 곧 그 시각이라, 읽을 수 없는 시각은 읽을 수 없는 버킷이 된다.
    if (!isZonedIso(e.occurred_at)) {
      counters.timestampsRejected += 1;
      continue;
    }
    offsets.add(offsetFormOf(e.occurred_at));

    if (bounds !== undefined) {
      const ms = Date.parse(e.occurred_at);
      if (ms < bounds.fromMs || ms >= bounds.toMs) {
        counters.outOfPeriodDropped += 1;
        continue;
      }
    }

    if (opts.maxEvents !== undefined && counters.eventsCounted >= opts.maxEvents) {
      counters.eventsSkipped += 1;
      counters.truncated = true;
      continue;
    }
    counters.eventsCounted += 1;
    kept.push(e);

    if (!e.interaction_id) {
      counters.interactionsUnidentified += 1;
      continue;
    }
    let acc = byId.get(e.interaction_id);
    if (!acc) {
      acc = { sawStart: false, sawEnd: false };
      byId.set(e.interaction_id, acc);
    }
    if (e.type === 'session.started') acc.sawStart = true;
    else if (e.type === 'session.ended') acc.sawEnd = true;
  }

  counters.interactionsSeen = byId.size;
  for (const acc of byId.values()) {
    if (!acc.sawStart) counters.interactionsWithoutStartInPeriod += 1;
    if (!acc.sawEnd) counters.interactionsWithoutEndInPeriod += 1;
  }
  if (opts.readTruncated === true) counters.truncated = true;
  counters.offsetFormsSeen = [...offsets].sort();

  const billingRefusalsKo: string[] = [];
  if (opts.period === undefined) {
    billingRefusalsKo.push(
      '청구 기간을 선언하지 않았다 — 전 기간 집계를 이번 달 명세와 대사하면 지난 구간이 모두 ' +
      '"대조할 명세 없음"(과다청구 방향)이 되어 청구가 영구히 막힌다 (설계서 §11.2)',
    );
  }
  if (counters.truncated) {
    billingRefusalsKo.push(
      `투영이 잘렸다(보지 않은 이벤트 ${counters.eventsSkipped}건${opts.readTruncated === true ? ' + 원장 읽기 상한' : ''}) — ` +
      '잘린 집계는 언제나 작게 나오고, 작은 쪽은 과다청구 방향이 아니라 차단 판정을 비껴간다 (설계서 §11.2)',
    );
  }

  const limitsKo: string[] = [PERIOD_FULL_SCAN_LIMIT_KO];
  if (counters.timestampsRejected > 0) {
    limitsKo.push(
      `오프셋 명시 ISO8601 이 아닌 시각 ${counters.timestampsRejected}건은 기간에 놓을 수 없어 제외했다 — ` +
      '그만큼의 수량·지표가 이 투영에 없다 (설계서 §13-3)',
    );
  }
  if (counters.offsetFormsSeen.length > 1) {
    limitsKo.push(
      `이벤트 시각 오프셋이 섞여 있다(${counters.offsetFormsSeen.join(', ')}) — 과금 버킷은 UTC 로 ` +
      '정규화되지만 리포트 버킷은 원문 접두사라, 같은 시점이 리포트에서만 다른 버킷으로 갈라진다 (설계서 §7 7.6)',
    );
  }

  const note = periodNoteKo(counters);
  return {
    scope: { tenantId: opts.scope.tenantId },
    ...(opts.period !== undefined ? { period: { ...opts.period } } : {}),
    events: kept,
    counters,
    usableForBilling: billingRefusalsKo.length === 0,
    billingRefusalsKo,
    limitsKo,
    ...(note !== undefined ? { noteKo: note } : {}),
  };
}

/** 투영에서 숨기면 안 되는 사실만 한 줄로. 판정·점수는 만들지 않는다(§13-3). */
export function periodNoteKo(c: PeriodCounters): string | undefined {
  const parts: string[] = [];
  if (c.truncated) parts.push(`투영이 잘렸다 — 보지 않은 이벤트 ${c.eventsSkipped}건`);
  if (c.foreignTenantDropped > 0) parts.push(`다른 테넌트 이벤트 ${c.foreignTenantDropped}건 제외(§11.1 — 전달 경로를 점검하라)`);
  if (c.eventsRejected > 0) parts.push(`event_id 없는 이벤트 ${c.eventsRejected}건 제외(§8.1)`);
  if (c.duplicatesDropped > 0) parts.push(`중복 이벤트 ${c.duplicatesDropped}건 제외`);
  if (c.timestampsRejected > 0) parts.push(`기간에 놓을 수 없는 시각 ${c.timestampsRejected}건 제외(오프셋 명시 ISO8601 이어야 한다)`);
  if (c.outOfPeriodDropped > 0) parts.push(`기간 밖 이벤트 ${c.outOfPeriodDropped}건 제외`);
  if (c.interactionsWithoutEndInPeriod > 0) {
    parts.push(`종료를 기간 안에서 못 본 통화 ${c.interactionsWithoutEndInPeriod}건 — 그 통화 분은 이 기간에 잡히지 않는다`);
  }
  if (c.interactionsWithoutStartInPeriod > 0) parts.push(`시작을 기간 안에서 못 본 통화 ${c.interactionsWithoutStartInPeriod}건(앞 경계)`);
  if (c.interactionsUnidentified > 0) parts.push(`interaction_id 없는 이벤트 ${c.interactionsUnidentified}건(집계에는 들어갔다)`);
  if (c.offsetFormsSeen.length > 1) parts.push(`시각 오프셋 혼재(${c.offsetFormsSeen.join(', ')})`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * 원장에서 바로 투영한다. 스코프는 **원장이 가진 것**을 쓴다 — 호스트가 테넌트를 주장하지
 * 못하게 하는 것은 브리지와 같은 규칙이다(§11.1).
 *
 * **읽기가 잘렸는지를 오프셋으로 판정한다.** 마지막으로 읽은 오프셋이 원장의 마지막 오프셋보다
 * 작으면 못 본 이벤트가 있다는 뜻이고, 투영은 그 사실을 **스스로는 절대 알 수 없다**(읽힌 줄만
 * 손에 들어온다). 이 한 줄이 없으면 `--limit` 하나로 청구서가 조용히 작아진다(위 (나)).
 *
 * `types`·`interactionId` 필터는 받지 않는다 — 필터로 걸러 읽은 원장은 경계 통화 건수를
 * 셀 수 없고(그 세션의 `session.ended` 를 못 본 것과 구분되지 않는다) 그 숫자가 곧 "이 기간에
 * 잡히지 않는 통화 분"이다.
 */
export function projectLedgerPeriodFromLog(
  log: EventLog,
  opts: Omit<PeriodProjectionOptions, 'scope' | 'readTruncated'> = {},
  read?: Pick<ReadOptions, 'afterOffset' | 'limit'>,
): PeriodProjection {
  const unsupported = read as ReadOptions | undefined;
  if (unsupported?.types !== undefined || unsupported?.interactionId !== undefined) {
    throw new Error(
      'types·interactionId 필터로 읽은 원장으로는 기간 투영을 만들지 않는다 — 걸러 읽으면 경계에 걸친 ' +
      '통화를 셀 수 없고, 그 건수가 곧 이 기간에 잡히지 않는 통화 분이다 (설계서 §11.2)',
    );
  }
  const rows = log.read(read);
  const lastSeen = rows.length > 0 ? (rows[rows.length - 1] as { offset: number }).offset : (read?.afterOffset ?? -1);
  const readTruncated = lastSeen < log.lastOffset();
  return projectLedgerPeriod(rows.map((r) => r.event), { ...opts, scope: log.scope, readTruncated });
}
