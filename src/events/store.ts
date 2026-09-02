// 이벤트 영속화 어댑터 — 설계서 §8.1(이벤트)·§11.1(테넌트 격리)·§11.2(과금 근거)·§10.2(감사)·§6.2(엔진 비종속).
//
// 지금까지 버스(bus.ts)의 멱등 저장소와 싱크는 전부 인메모리였다. 프로세스가 한 번 재시작하면
// 멱등 기억이 사라지고, 재전송된 이벤트가 새 이벤트로 취급된다 — 그 결과가 곧 과다 집계이고
// 정산 분쟁이다(§11.2). 그리고 이벤트 자체가 휘발되면 대사(reconciliation)의 원장이 사라진다.
//
// 그래서 필요한 것은 두 가지다.
//  1) 추가 전용(append-only) 이벤트 원장 — 순서·오프셋이 있고, 재생(replay)이 가능하다.
//  2) 원장에서 복구되는 멱등 저장소 — 재시작 후 markIfNew 가 과거를 기억한다.
//
// DB·브로커 종속 코드는 넣지 않는다(§6.2). 여기 있는 것은 인터페이스와,
// 어디서나 동작하는 참조 구현(인메모리 + JSONL 직렬화)이다. 실제 DB·Kafka 어댑터는
// EventLog 를 구현해 주입한다 — 실인프라 연결은 [승인 필요].
import type { InteractionEvent } from './schema.ts';
import { assertTenantScoped } from './schema.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import { idempotencyKey, type IdempotencyStore } from './bus.ts';

/** 원장에 기록된 한 건. offset 은 테넌트 원장 안에서 0부터 단조 증가한다. */
export interface StoredEvent {
  offset: number;
  key: string;              // 멱등 키 (tenant::event_id)
  event: InteractionEvent;
}

export interface ReadOptions {
  /** 이 오프셋 "다음"부터 읽는다. 미지정이면 처음부터. */
  afterOffset?: number;
  /** 최대 건수. 미지정이면 끝까지 — 운영에서는 반드시 지정할 것. */
  limit?: number;
  /** 특정 Interaction 만. */
  interactionId?: string;
  /** 타입 필터. */
  types?: InteractionEvent['type'][];
}

export interface AppendResult {
  /** 새로 기록된 경우의 오프셋. 중복이면 기존 오프셋. */
  offset: number;
  /** 이미 있던 이벤트인가(§8.1 멱등). */
  duplicate: boolean;
  key: string;
}

/**
 * 추가 전용 이벤트 원장. 수정·삭제 연산이 없다 —
 * 과금·감사의 원천이므로 사후 편집 가능성 자체를 인터페이스에서 없앤다(§10.2·§11.2).
 * 보존기간 만료 파기는 retention 정책이 별도 경로로 수행한다(§10.4).
 */
export interface EventLog {
  readonly scope: TenantScope;
  append(event: InteractionEvent): AppendResult;
  appendAll(events: InteractionEvent[]): AppendResult[];
  read(opts?: ReadOptions): StoredEvent[];
  /** 마지막 오프셋. 비어 있으면 -1. */
  lastOffset(): number;
  size(): number;
  has(key: string): boolean;
}

export type LogRejectReason = 'no_tenant' | 'foreign_tenant' | 'no_event_id';

export class EventLogRejected extends Error {
  readonly reason: LogRejectReason;
  constructor(reason: LogRejectReason, messageKo: string) {
    super(messageKo);
    this.name = 'EventLogRejected';
    this.reason = reason;
  }
}

function checkScoped(e: InteractionEvent, scope: TenantScope): void {
  if (!e.tenant_id) throw new EventLogRejected('no_tenant', 'tenant_id 없는 이벤트는 원장에 기록할 수 없다 (설계서 §11.1)');
  if (e.tenant_id !== scope.tenantId) {
    throw new EventLogRejected('foreign_tenant', `원장 스코프(${scope.tenantId})와 다른 테넌트의 이벤트다: ${e.tenant_id} (설계서 §11.1)`);
  }
  if (!e.event_id) throw new EventLogRejected('no_event_id', 'event_id 없는 이벤트는 멱등 처리가 불가능하다 (설계서 §8.1)');
}

/**
 * 인메모리 원장. 단일 프로세스·테스트용이지만 JSONL 로 내보내고 되읽을 수 있으므로
 * 파일 영속화까지는 이것으로 충분하다. 다중 프로세스·고가용은 DB 구현으로 교체한다(§6.2).
 */
export function createMemoryEventLog(scope: TenantScope, seed: StoredEvent[] = []): EventLog {
  assertTenantScope(scope);
  const rows: StoredEvent[] = [];
  const byKey = new Map<string, number>();   // key -> offset

  const push = (event: InteractionEvent): AppendResult => {
    checkScoped(event, scope);
    const key = idempotencyKey(event);
    const existing = byKey.get(key);
    if (existing !== undefined) return { offset: existing, duplicate: true, key };
    const offset = rows.length;
    rows.push({ offset, key, event });
    byKey.set(key, offset);
    return { offset, duplicate: false, key };
  };

  // 시드는 오프셋을 다시 매긴다. 외부에서 온 오프셋을 그대로 믿으면 구멍·중복이 원장에 남는다.
  for (const r of seed) push(r.event);

  return {
    scope,
    append: push,
    appendAll(events) { return events.map(push); },
    read(opts = {}) {
      const after = opts.afterOffset ?? -1;
      const types = opts.types ? new Set(opts.types) : undefined;
      const out: StoredEvent[] = [];
      for (const r of rows) {
        if (r.offset <= after) continue;
        if (opts.interactionId !== undefined && r.event.interaction_id !== opts.interactionId) continue;
        if (types && !types.has(r.event.type)) continue;
        out.push(r);
        if (opts.limit !== undefined && out.length >= opts.limit) break;
      }
      return out;
    },
    lastOffset: () => rows.length - 1,
    size: () => rows.length,
    has: (key) => byKey.has(key),
  };
}

/**
 * 원장을 근거로 하는 멱등 저장소. 재시작 후에도 과거를 기억한다.
 * markIfNew 가 곧 append 이므로, "기억했지만 저장은 실패" 라는 어긋남이 생기지 않는다.
 *
 * release 를 구현하지 않는다: 추가 전용 원장에서 키를 되돌릴 수 없기 때문이다.
 * 따라서 이 저장소를 쓰는 버스는 releaseKeyOnSinkFailure: false 여야 한다
 * (싱크 실패 시 재전송은 replay 로 한다 — 아래 replayUndelivered).
 */
export function createLogBackedIdempotencyStore(log: EventLog): IdempotencyStore & { attach(event: InteractionEvent): void } {
  let pending: InteractionEvent | null = null;
  return {
    /** 버스는 키만 넘기므로, 직전에 attach 로 원본 이벤트를 알려준다. */
    attach(event) { pending = event; },
    markIfNew(key) {
      if (log.has(key)) return false;
      if (!pending) {
        // 원본 이벤트 없이 키만으로는 원장에 기록할 수 없다. 조용히 통과시키면 영속화가 새는 것이므로 막는다.
        throw new Error('원장 기반 멱등 저장소는 attach(event) 없이 markIfNew 를 처리할 수 없다 (설계서 §8.1)');
      }
      const e = pending;
      pending = null;
      const r = log.append(e);
      return !r.duplicate;
    },
    has: (key) => log.has(key),
    size: () => log.size(),
  };
}

/** 원장에 기록하는 싱크. 버스 뒤가 아니라 앞에 두고 싶을 때(원장 우선 기록) 쓴다. */
export function createLogSink(log: EventLog, name = 'event_log'): { name: string; deliver(e: InteractionEvent): void } {
  return {
    name,
    deliver(event) { log.append(event); },
  };
}

// ── 직렬화 ───────────────────────────────────────────────────────────────────
// JSONL(한 줄 한 이벤트). 파일·객체스토리지·로그수집기 어디에나 그대로 흘릴 수 있고,
// 부분 손상 시 손상된 줄만 버리고 나머지를 복구할 수 있다. 바이너리 포맷은 그게 안 된다.
// 저장되는 텍스트는 이미 마스킹을 통과한 값이다(§10.3) — 여기서 다시 마스킹하지 않는다.

export function serializeJsonl(rows: StoredEvent[]): string {
  return rows.map((r) => JSON.stringify(r.event)).join('\n');
}

export interface ParseJsonlResult {
  events: InteractionEvent[];
  /** 파싱·검증에 실패한 줄. 조용히 버리지 않고 사유와 함께 돌려준다. */
  rejected: { line: number; reasonKo: string }[];
}

/**
 * JSONL → 이벤트. 한 줄이 깨져도 나머지를 살린다.
 * 스키마 버전이 다른 줄은 버리지 않고 통과시킨다 — 상위 버전 이벤트를 여기서 삼키면
 * 롤링 배포 중 이벤트가 사라진다. 해석 책임은 소비자에게 있다.
 */
export function parseJsonl(text: string): ParseJsonlResult {
  const events: InteractionEvent[] = [];
  const rejected: { line: number; reasonKo: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? '').trim();
    if (raw === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      rejected.push({ line: i + 1, reasonKo: 'JSON 파싱 실패 — 손상된 줄' });
      continue;
    }
    const e = parsed as Partial<InteractionEvent>;
    if (!e || typeof e !== 'object' || typeof e.event_id !== 'string' || typeof e.tenant_id !== 'string' || typeof e.type !== 'string') {
      rejected.push({ line: i + 1, reasonKo: 'event_id·tenant_id·type 중 누락 (§8.1·§11.1)' });
      continue;
    }
    try {
      assertTenantScoped(e as InteractionEvent);
    } catch (err) {
      rejected.push({ line: i + 1, reasonKo: err instanceof Error ? err.message : String(err) });
      continue;
    }
    events.push(e as InteractionEvent);
  }
  return { events, rejected };
}

/**
 * 스냅샷에서 원장 복구. 다른 테넌트의 줄은 기록하지 않고 사유를 남긴다(§11.1) —
 * 던지지 않는 이유는, 파일 하나에 여러 테넌트가 섞여 들어온 상황에서 복구 자체가 멈추면
 * 그날의 과금 근거가 통째로 사라지기 때문이다.
 */
export function restoreEventLog(scope: TenantScope, text: string): { log: EventLog; skipped: { line: number; reasonKo: string }[]; duplicates: number } {
  assertTenantScope(scope);
  const { events, rejected } = parseJsonl(text);
  const log = createMemoryEventLog(scope);
  const skipped = [...rejected];
  let duplicates = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    try {
      const r = log.append(e);
      if (r.duplicate) duplicates += 1;
    } catch (err) {
      skipped.push({ line: i + 1, reasonKo: err instanceof Error ? err.message : String(err) });
    }
  }
  return { log, skipped, duplicates };
}

// ── 재전송 ───────────────────────────────────────────────────────────────────

/** 싱크가 어디까지 받았는지 기억하는 커서. 싱크마다 하나씩 둔다. */
export interface DeliveryCursor {
  sink: string;
  offset: number;   // 이 오프셋까지 전달 완료. 아직 없으면 -1.
}

export interface ReplayResult {
  sink: string;
  attempted: number;
  delivered: number;
  /** 실패 지점에서 멈춘 뒤의 커서. 순서 보장을 위해 실패 다음 건으로 넘어가지 않는다. */
  cursor: DeliveryCursor;
  errorKo?: string;
}

/**
 * 커서 이후의 이벤트를 싱크에 재전송한다.
 * 실패하면 그 자리에서 멈춘다 — 건너뛰고 진행하면 같은 Interaction의 이벤트 순서가 뒤집히고,
 * 대시보드에 "종료된 뒤에 시작된" 세션이 생긴다(§8.1).
 */
export async function replayUndelivered(
  log: EventLog,
  sink: { name: string; deliver(e: InteractionEvent): void | Promise<void> },
  cursor: DeliveryCursor,
  opts: { limit?: number } = {},
): Promise<ReplayResult> {
  const readOpts: ReadOptions = { afterOffset: cursor.offset };
  if (opts.limit !== undefined) readOpts.limit = opts.limit;
  const rows = log.read(readOpts);
  let delivered = 0;
  let offset = cursor.offset;
  for (const row of rows) {
    try {
      await sink.deliver(row.event);
    } catch (err) {
      return {
        sink: sink.name,
        attempted: rows.length,
        delivered,
        cursor: { sink: sink.name, offset },
        errorKo: `오프셋 ${row.offset} 전달 실패로 중단: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    delivered += 1;
    offset = row.offset;
  }
  return { sink: sink.name, attempted: rows.length, delivered, cursor: { sink: sink.name, offset } };
}

/**
 * 원장 무결성 점검(§10.2 감사 관점).
 * 오프셋 연속성·키 중복·시각 역행을 본다. 시각 역행은 오류가 아니라 경고다 —
 * 채널 시계가 서로 다를 수 있고, 그것만으로 원장을 부정할 수는 없다.
 */
export interface IntegrityReport {
  ok: boolean;
  size: number;
  errorsKo: string[];
  warningsKo: string[];
}

export function verifyLogIntegrity(log: EventLog): IntegrityReport {
  const rows = log.read();
  const errorsKo: string[] = [];
  const warningsKo: string[] = [];
  const seen = new Set<string>();
  let prevTime = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.offset !== i) errorsKo.push(`오프셋 불연속: 기대 ${i}, 실제 ${r.offset}`);
    if (seen.has(r.key)) errorsKo.push(`멱등 키 중복: ${r.key}`);
    seen.add(r.key);
    if (r.event.tenant_id !== log.scope.tenantId) {
      errorsKo.push(`테넌트 격리 위반(오프셋 ${r.offset}): ${r.event.tenant_id} (설계서 §11.1)`);
    }
    const t = Date.parse(r.event.occurred_at);
    if (Number.isNaN(t)) {
      errorsKo.push(`occurred_at 형식 오류(오프셋 ${r.offset}): ${r.event.occurred_at}`);
    } else {
      if (t < prevTime) warningsKo.push(`시각 역행(오프셋 ${r.offset}) — 채널 간 시계 차이일 수 있습니다.`);
      prevTime = Math.max(prevTime, t);
    }
  }
  return { ok: errorsKo.length === 0, size: rows.length, errorsKo, warningsKo };
}
