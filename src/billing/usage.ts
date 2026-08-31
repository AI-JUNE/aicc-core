// 과금 근거 데이터 산출 — 설계서 §11.2.
// 여기서 만드는 것은 "청구서"가 아니라 "청구의 근거가 되는 수량"이다. 단가·할인·최소요금은 계약 문서에 있고
// 이 모듈은 그것을 알지 않는다. 우리가 책임지는 것은 딱 하나: 같은 이벤트를 넣으면 언제나 같은 수량이 나온다.
//
// 정산 분쟁은 대부분 세 곳에서 난다.
//  1) 중복 이벤트가 두 번 세어짐        → §8.1 멱등 키로 먼저 dedupe 한 뒤 집계한다.
//  2) 올림/버림 규칙이 서로 다름        → 반올림 규칙을 코드에 박지 않고 호출자(계약)가 주입한다(§13-3).
//  3) 근거 없는 추정치가 섞임           → 실측이 없는 세션은 세지 않고 '누락'으로 따로 보고한다.
import type { InteractionEvent, SessionEndedEvent, TurnCompletedEvent } from '../events/schema.ts';
import { dedupeEvents } from '../events/bus.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import type { ChannelKind } from '../domain/types.ts';

/** 과금 수량 단위. 금액은 이 모듈의 관심사가 아니다. */
export type BillableUnit =
  | 'voice_seconds'      // 통화 과금 대상 시간(초) — 반올림 전 원시값
  | 'voice_units'        // 계약 반올림 규칙 적용 후의 과금 단위 수(예: 분 단위 올림)
  | 'sessions'           // 세션 수
  | 'llm_prompt_tokens'
  | 'llm_completion_tokens'
  | 'stt_seconds'
  | 'tts_seconds';

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
  voice_seconds: number;
  voice_units: number;
  sessions: number;
  llm_prompt_tokens: number;
  llm_completion_tokens: number;
  stt_seconds: number;
  tts_seconds: number;
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

function emptyQuantities(): UsageQuantities {
  return {
    voice_seconds: 0,
    voice_units: 0,
    sessions: 0,
    llm_prompt_tokens: 0,
    llm_completion_tokens: 0,
    stt_seconds: 0,
    tts_seconds: 0,
  };
}

function newBucket(tenantId: string, bucket: string, channel: ChannelKind): UsageBucket {
  return {
    tenantId,
    bucket,
    channel,
    quantities: emptyQuantities(),
    sessionsMissingBillableMs: 0,
    turnsMissingUsage: 0,
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
      if (ended.channel === 'voice') {
        if (typeof ended.billable_ms === 'number' && ended.billable_ms >= 0) {
          const secs = ended.billable_ms / 1000;
          b.quantities.voice_seconds += secs;
          b.quantities.voice_units += applyRounding(secs, opts.rounding);
        } else {
          b.sessionsMissingBillableMs += 1;
        }
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
      b.quantities.llm_prompt_tokens += u.llm_prompt_tokens ?? 0;
      b.quantities.llm_completion_tokens += u.llm_completion_tokens ?? 0;
      b.quantities.stt_seconds += (u.stt_audio_ms ?? 0) / 1000;
      b.quantities.tts_seconds += (u.tts_audio_ms ?? 0) / 1000;
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

/** 버킷 합계 — 청구서 한 줄에 대응하는 값. */
export function totalQuantities(agg: UsageAggregate): UsageQuantities {
  const t = emptyQuantities();
  for (const b of agg.buckets) {
    t.voice_seconds += b.quantities.voice_seconds;
    t.voice_units += b.quantities.voice_units;
    t.sessions += b.quantities.sessions;
    t.llm_prompt_tokens += b.quantities.llm_prompt_tokens;
    t.llm_completion_tokens += b.quantities.llm_completion_tokens;
    t.stt_seconds += b.quantities.stt_seconds;
    t.tts_seconds += b.quantities.tts_seconds;
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
