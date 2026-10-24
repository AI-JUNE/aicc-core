// 과금 근거 데이터 산출 — 설계서 §11.2.
// 여기서 만드는 것은 "청구서"가 아니라 "청구의 근거가 되는 수량"이다. 단가·할인·최소요금은 계약 문서에 있고
// 이 모듈은 그것을 알지 않는다. 우리가 책임지는 것은 딱 하나: 같은 이벤트를 넣으면 언제나 같은 수량이 나온다.
//
// 정산 분쟁은 대부분 세 곳에서 난다.
//  1) 중복 이벤트가 두 번 세어짐        → §8.1 멱등 키로 먼저 dedupe 한 뒤 집계한다.
//  2) 올림/버림 규칙이 서로 다름        → 반올림 규칙을 코드에 박지 않고 호출자(계약)가 주입한다(§13-3).
//  3) 근거 없는 추정치가 섞임           → 실측이 없는 세션은 세지 않고 '누락'으로 따로 보고한다.
import type { InteractionEvent, SessionEndedEvent, TurnCompletedEvent, UsageMetrics } from '../events/schema.ts';
import { dedupeEvents } from '../events/bus.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import type { ChannelKind } from '../domain/types.ts';

/**
 * 과금 수량 단위. 금액은 이 모듈의 관심사가 아니다.
 *
 * **목록을 따로 적지 않는다**(§2) — `UsageQuantities` 의 키에서 파생시킨다. 종전에는 같은
 * 일곱 개가 두 벌이었고, 어긋나는 날의 결말이 양쪽 다 조용하다:
 *  - **수량만 늘면**(`UsageQuantities` 에 칸이 생기고 이 유니온은 그대로) 외부 명세가 그 단위를
 *    **선언할 수 없다**. `reconcile` 은 명세에 있는 단위만 비교하므로 그 수량은 한 번도 대조되지
 *    않은 채 청구로 나간다 — 불일치가 아니라 **아무 줄도 생기지 않는다**.
 *  - **유니온만 늘면** `b.quantities[unit]` 이 `undefined` 이고 `core - external` 이 NaN 이 된다.
 *    `withinTolerance` 는 언제나 거짓이라 그 버킷이 통째로 `mismatch` 로 떨어진다.
 * 파생시키면 둘 중 어느 쪽도 손으로 맞출 필요가 없다.
 */
export type BillableUnit = keyof UsageQuantities;

/** 계약이 정하는 통화 반올림 규칙. 기본값을 두지 않는다 — 계약마다 다르고, 추정하면 분쟁이 된다. */
export interface RoundingRule {
  /** 과금 단위 길이(초). 분 단위 과금이면 60, 초 단위면 1. */
  unitSeconds: number;
  mode: 'ceil' | 'floor' | 'round';
  /** 통화당 최소 과금 단위 수(예: 최소 1분). 계약에 없으면 0. */
  minimumUnits: number;
}

export function applyRounding(seconds: number, rule: RoundingRule): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`통화 시간이 유효하지 않다: ${seconds} (설계서 §11.2)`);
  if (!Number.isFinite(rule.unitSeconds) || rule.unitSeconds <= 0) {
    throw new Error('unitSeconds는 0보다 커야 한다 (설계서 §11.2)');
  }
  if (seconds === 0) return 0;
  const raw = seconds / rule.unitSeconds;
  const units = rule.mode === 'ceil' ? Math.ceil(raw) : rule.mode === 'floor' ? Math.floor(raw) : Math.round(raw);
  return Math.max(units, rule.minimumUnits);
}

/** 집계 버킷. 시간대에 따라 월 경계가 달라지므로 UTC 고정이며, 다른 기준이 필요하면 호출자가 사전 분할한다. */
export type BucketGranularity = 'day' | 'month' | 'total';

export function bucketKey(occurredAtIso: string, g: BucketGranularity): string {
  if (g === 'total') return 'total';
  const t = Date.parse(occurredAtIso);
  if (Number.isNaN(t)) throw new Error(`occurred_at 형식 오류: ${occurredAtIso} (설계서 §8.1)`);
  const iso = new Date(t).toISOString();
  return g === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

export interface UsageQuantities {
  /** 통화 과금 대상 시간(초) — 반올림 전 원시값 */
  voice_seconds: number;
  /** 계약 반올림 규칙 적용 후의 과금 단위 수(예: 분 단위 올림) */
  voice_units: number;
  /** 세션 수 */
  sessions: number;
  llm_prompt_tokens: number;
  llm_completion_tokens: number;
  stt_seconds: number;
  tts_seconds: number;
  /**
   * 임베딩 토큰(§5.2 RAG). 공급사 리포트가 LLM 과 **따로** 내놓는 수량이므로 칸도 따로다 —
   * 합쳐 적으면 대사는 "둘 다 맞지 않는다"까지만 말할 수 있다(`UsageMetrics.embedding_tokens`).
   */
  embedding_tokens: number;
}

export interface UsageBucket {
  tenantId: string;
  bucket: string;
  channel: ChannelKind;
  quantities: UsageQuantities;
  /** 통화 채널인데 billable_ms가 없어 통화 시간 집계에서 제외한 세션 수 — 추정으로 메우지 않는다. */
  sessionsMissingBillableMs: number;
  /** 사용량(usage)이 붙지 않은 turn 수 — 어댑터가 실측을 채우지 않은 구간. */
  turnsMissingUsage: number;
  /**
   * 음성이 **아닌** 채널로 끝났는데 billable_ms 실측이 실려 있어 통화 시간 집계에서 제외한 세션 수.
   *
   * §5.2 전환으로 통화가 화면 채널에서 끝나면 `session.ended.channel` 이 voice 가 아니게 되고,
   * 그 통화의 과금 구간은 여기로 떨어진다. **자동으로 통화 시간에 넣지 않는다** — 잘못 선언된
   * 채팅 세션까지 통화로 청구하는 과다청구 경로가 열리기 때문이다. 대신 조용히 버리지도 않는다:
   * 건수가 0 이 아니면 매출 누락이거나 채널의 선언 오류이며, 둘 다 사람이 봐야 한다(§13-3).
   */
  sessionsBillableMsOnNonVoice: number;
  /**
   * 실측으로 볼 수 없어 집계에서 뺀 사용량 **항목** 수(음수·NaN·무한·숫자 아님).
   *
   * 이벤트는 §8.1 원장에서 오고 원장에는 과거 호스트가 넣은 값도 남아 있다. 여기가 청구 직전의
   * 마지막 방어선이라 0 으로도 그대로도 집계하지 않는다 — NaN 하나가 합계 전체를 NaN 으로 만들고,
   * 그 상태에서는 `withinTolerance` 가 언제나 거짓이라 **과다청구 차단 판정까지 비껴간다**.
   */
  usageValuesRejected: number;
}

export interface UsageAggregate {
  tenantId: string;
  granularity: BucketGranularity;
  rounding: RoundingRule;
  /** 집계에 사용된 이벤트 수(중복 제거 후) */
  eventsCounted: number;
  /** 멱등 키 기준으로 걸러낸 중복 이벤트 수 */
  duplicatesDropped: number;
  /** 다른 테넌트의 이벤트라 제외한 수(§11.1) */
  foreignTenantDropped: number;
  buckets: UsageBucket[];
}

/**
 * 과금 수량 칸의 **유일한 목록**. 초기화·합계·대사가 전부 이 하나에서 파생된다(§2).
 *
 * 종전에 이 목록은 세 곳에 손으로 적혀 있었고(초기화 객체·합계 루프·대사 단위 유니온), 그중
 * **합계만 조용했다**: 칸을 하나 늘리면 초기화 객체는 타입이 모자라 컴파일 오류가 되지만
 * `totalQuantities` 는 그 칸을 더하는 줄이 없어도 **그냥 통과한다**. 결과는 버킷에는 수량이
 * 있는데 합계는 0 이고, 합계가 곧 청구서 한 줄이라 **그 항목이 통째로 빠진 청구서**가 나간다 —
 * 과소청구 방향이라 과다청구 차단(`blocked`)에도 걸리지 않고, 대사에서는 명세에만 있는
 * 수량이 되어 '미설명'으로만 보인다(§11.2·§13-3).
 */
const QUANTITY_KEY_TUPLE = [
  'voice_seconds', 'voice_units', 'sessions',
  'llm_prompt_tokens', 'llm_completion_tokens', 'stt_seconds', 'tts_seconds', 'embedding_tokens',
] as const;

/** 빠뜨린 칸이 있으면 이 대입이 컴파일 오류가 된다(목록이 하나여도 오타·누락은 막아야 한다). */
const _quantityKeysCover: Exclude<BillableUnit, typeof QUANTITY_KEY_TUPLE[number]> extends never
  ? true : never = true;
void _quantityKeysCover;

/** 과금 수량 칸 전체. 외부 명세를 만드는 쪽도 이 목록을 보고 선언한다. */
export const BILLABLE_UNITS: readonly BillableUnit[] = QUANTITY_KEY_TUPLE;

/**
 * §11.2 실측 항목(`UsageMetrics`) → 과금 수량 칸 + 환산 제수.
 *
 * `Record<keyof UsageMetrics, …>` 인 것이 핵심이다 — 실측 항목이 하나 늘면 **이 표가 컴파일
 * 오류**가 된다. 종전에는 턴 집계가 항목마다 한 줄씩 손으로 적혀 있어서, 늘어난 항목을 그
 * 자리에 적지 않으면 그 수량은 원장에만 있고 집계에는 **한 번도 들어오지 않는다**(어제 늘어난
 * `embedding_tokens` 가 바로 그 모양이었다). 예외도 경고도 없다.
 *
 * `perUnit` 은 실측 단위 → 수량 단위 제수다(ms → 초는 1000). 1 이면 그대로 더한다.
 * **반올림하지 않는다** — 통화 반올림은 계약 규칙이 따로 있고(`applyRounding`), 여기서
 * 임의로 깎으면 그 값이 곧 정책이 된다(§13-3).
 */
const METRIC_UNIT_ROUTE_TABLE: Record<keyof UsageMetrics, { to: BillableUnit; perUnit: number }> = {
  llm_prompt_tokens: { to: 'llm_prompt_tokens', perUnit: 1 },
  llm_completion_tokens: { to: 'llm_completion_tokens', perUnit: 1 },
  stt_audio_ms: { to: 'stt_seconds', perUnit: 1000 },
  tts_audio_ms: { to: 'tts_seconds', perUnit: 1000 },
  embedding_tokens: { to: 'embedding_tokens', perUnit: 1 },
};

/** 환산표(읽기 전용 투영). 검사·문서가 같은 표를 본다 — 사본을 만들지 않는다(§2). */
export const METRIC_UNIT_ROUTES: ReadonlyMap<keyof UsageMetrics, { to: BillableUnit; perUnit: number }> =
  new Map(Object.entries(METRIC_UNIT_ROUTE_TABLE) as [keyof UsageMetrics, { to: BillableUnit; perUnit: number }][]);

function emptyQuantities(): UsageQuantities {
  // 칸을 손으로 다시 적지 않는다 — 목록은 `QUANTITY_KEY_TUPLE` 하나다.
  const q = {} as UsageQuantities;
  for (const k of BILLABLE_UNITS) q[k] = 0;
  return q;
}

function newBucket(tenantId: string, bucket: string, channel: ChannelKind): UsageBucket {
  return {
    tenantId,
    bucket,
    channel,
    quantities: emptyQuantities(),
    sessionsMissingBillableMs: 0,
    turnsMissingUsage: 0,
    sessionsBillableMsOnNonVoice: 0,
    usageValuesRejected: 0,
  };
}

export interface AggregateOptions {
  scope: TenantScope;
  granularity: BucketGranularity;
  rounding: RoundingRule;
}

/**
 * 이벤트 스트림 → 과금 수량. 순수 함수다(시각·난수·I/O 없음).
 * 통화 시간은 session.ended의 billable_ms만 신뢰한다. duration_ms로 대체 추정하지 않는다 —
 * 대기·호 설정 구간 포함 여부는 계약 사항이고, Core가 임의로 정하면 그게 곧 과다청구다.
 */
export function aggregateUsage(events: InteractionEvent[], opts: AggregateOptions): UsageAggregate {
  assertTenantScope(opts.scope);
  const tenantId = opts.scope.tenantId;

  const scoped = events.filter((e) => e.tenant_id === tenantId);
  const foreignTenantDropped = events.length - scoped.length;
  const unique = dedupeEvents(scoped);
  const duplicatesDropped = scoped.length - unique.length;

  const map = new Map<string, UsageBucket>();
  const get = (e: InteractionEvent): UsageBucket => {
    const b = bucketKey(e.occurred_at, opts.granularity);
    const k = `${b}::${e.channel}`;
    let hit = map.get(k);
    if (!hit) {
      hit = newBucket(tenantId, b, e.channel);
      map.set(k, hit);
    }
    return hit;
  };

  for (const e of unique) {
    if (e.type === 'session.ended') {
      const ended = e as SessionEndedEvent;
      const b = get(ended);
      b.quantities.sessions += 1;
      // 실측이 있는지를 먼저 본다. NaN·Infinity 는 "있다"가 아니다 — 하나라도 합계에 들어가면
      // 그 달의 모든 수량이 NaN 이 되고, NaN 비교는 언제나 거짓이라 과다청구 차단까지 비껴간다.
      const measured = typeof ended.billable_ms === 'number'
        && Number.isFinite(ended.billable_ms)
        && ended.billable_ms >= 0;
      if (ended.channel === 'voice') {
        if (measured) {
          const secs = (ended.billable_ms as number) / 1000;
          b.quantities.voice_seconds += secs;
          b.quantities.voice_units += applyRounding(secs, opts.rounding);
        } else {
          b.sessionsMissingBillableMs += 1;
        }
      } else if (measured) {
        // 음성이 아닌 채널로 끝난 통화(§5.2 전환). 집계에 넣지 않되 버리지도 않는다 — 위 필드 주석 참조.
        b.sessionsBillableMsOnNonVoice += 1;
      }
      continue;
    }
    if (e.type === 'turn.completed') {
      const turn = e as TurnCompletedEvent;
      const b = get(turn);
      const u = turn.usage;
      if (!u) {
        b.turnsMissingUsage += 1;
        continue;
      }
      // 없는 값과 못 쓰는 값을 구분한다 — 전자는 0 이고 후자는 거부다(거부 건수는 따로 남긴다).
      const take = (v: number | undefined): number => {
        if (v === undefined) return 0;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          b.usageValuesRejected += 1;
          return 0;
        }
        return v;
      };
      // 항목마다 한 줄씩 적지 않는다 — 환산표(`METRIC_UNIT_ROUTE_TABLE`) 하나에서 돈다.
      // 없는 값은 `take` 가 0 으로 돌려주므로 선언하지 않은 항목이 거부로 세어지지 않는다.
      for (const [metric, route] of METRIC_UNIT_ROUTES) {
        b.quantities[route.to] += take(u[metric]) / route.perUnit;
      }
    }
  }

  const buckets = [...map.values()].sort((a, b) =>
    a.bucket === b.bucket ? a.channel.localeCompare(b.channel) : a.bucket.localeCompare(b.bucket),
  );

  return {
    tenantId,
    granularity: opts.granularity,
    rounding: opts.rounding,
    eventsCounted: unique.length,
    duplicatesDropped,
    foreignTenantDropped,
    buckets,
  };
}

/**
 * 버킷 합계 — 청구서 한 줄에 대응하는 값.
 *
 * 칸 목록을 손으로 적지 않는다(`QUANTITY_KEY_TUPLE` 주석) — 여기서 한 칸을 빠뜨리면
 * 버킷에는 있는 수량이 합계에서 0 이 되고, 그 상태는 어디에서도 예외가 아니다.
 */
export function totalQuantities(agg: UsageAggregate): UsageQuantities {
  const t = emptyQuantities();
  for (const b of agg.buckets) {
    for (const k of BILLABLE_UNITS) t[k] += b.quantities[k];
  }
  return t;
}

// ── 대사(reconciliation) ─────────────────────────────────────────────────────
// 우리 집계 vs 외부 명세(통신사 CDR·모델 제공사 사용량 리포트). 둘이 다르면 어느 쪽이 맞는지는
// 사람이 판단한다. 이 함수는 "어디가 얼마나 다른지"만 정확히 보여준다.

export interface ExternalStatement {
  /** 명세 출처(예: 'carrier_cdr', 'llm_vendor_report') — 감사 추적용 */
  source: string;
  bucket: string;
  channel: ChannelKind;
  quantities: Partial<UsageQuantities>;
}

/** 허용 오차. 계약·공급사마다 다르므로 반드시 호출자가 지정한다(기본값 금지 §13-3). */
export interface Tolerance {
  /** 절대 오차 허용치(단위와 동일한 스케일) */
  absolute: number;
  /** 상대 오차 허용치(0~1). 절대·상대 중 하나라도 만족하면 일치로 본다. */
  relative: number;
}

export interface UnitDiff {
  unit: BillableUnit;
  core: number;
  external: number;
  diff: number;          // core - external
  withinTolerance: boolean;
}

export interface ReconcileLine {
  bucket: string;
  channel: ChannelKind;
  source: string;
  status: 'matched' | 'mismatch' | 'missing_external' | 'missing_core';
  diffs: UnitDiff[];
}

export interface ReconcileResult {
  tenantId: string;
  tolerance: Tolerance;
  lines: ReconcileLine[];
  /** 사람이 확인해야 하는 줄 수 */
  mismatchCount: number;
}

function withinTolerance(core: number, external: number, tol: Tolerance): boolean {
  const diff = Math.abs(core - external);
  if (diff <= tol.absolute) return true;
  const base = Math.max(Math.abs(core), Math.abs(external));
  if (base === 0) return diff === 0;
  return diff / base <= tol.relative;
}

/**
 * Core 집계와 외부 명세를 버킷·채널 단위로 맞춰본다.
 * 외부 명세에 없는 단위는 비교하지 않는다(비교 대상이 없는 것을 0으로 두면 없는 차이가 생긴다).
 */
export function reconcile(
  agg: UsageAggregate,
  statements: ExternalStatement[],
  tolerance: Tolerance,
): ReconcileResult {
  const lines: ReconcileLine[] = [];
  const key = (b: string, c: ChannelKind) => `${b}::${c}`;
  const byKey = new Map<string, ExternalStatement>();
  for (const s of statements) byKey.set(key(s.bucket, s.channel), s);

  for (const b of agg.buckets) {
    const st = byKey.get(key(b.bucket, b.channel));
    if (!st) {
      lines.push({ bucket: b.bucket, channel: b.channel, source: '-', status: 'missing_external', diffs: [] });
      continue;
    }
    const diffs: UnitDiff[] = [];
    for (const [unit, external] of Object.entries(st.quantities) as [BillableUnit, number | undefined][]) {
      if (external === undefined) continue;
      const core = b.quantities[unit as keyof UsageQuantities];
      diffs.push({
        unit,
        core,
        external,
        diff: core - external,
        withinTolerance: withinTolerance(core, external, tolerance),
      });
    }
    lines.push({
      bucket: b.bucket,
      channel: b.channel,
      source: st.source,
      status: diffs.every((d) => d.withinTolerance) ? 'matched' : 'mismatch',
      diffs,
    });
  }

  // 외부에는 있는데 우리 집계에 없는 구간 — 이벤트 유실 신호다. 조용히 넘기면 안 된다.
  const coreKeys = new Set(agg.buckets.map((b) => key(b.bucket, b.channel)));
  for (const s of statements) {
    if (!coreKeys.has(key(s.bucket, s.channel))) {
      lines.push({ bucket: s.bucket, channel: s.channel, source: s.source, status: 'missing_core', diffs: [] });
    }
  }

  lines.sort((a, b) => (a.bucket === b.bucket ? a.channel.localeCompare(b.channel) : a.bucket.localeCompare(b.bucket)));
  return {
    tenantId: agg.tenantId,
    tolerance,
    lines,
    mismatchCount: lines.filter((l) => l.status !== 'matched').length,
  };
}
