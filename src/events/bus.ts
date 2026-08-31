// 이벤트 버스 — 설계서 §8.1.
// 이벤트는 "한 번 이상" 도착한다(재시도·네트워크 중복·리플레이). 그러나 대시보드·과금(§11.2)은
// "정확히 한 번" 집계되어야 한다. 그 간극을 메우는 유일한 장치가 여기 있는 멱등 처리다.
//
// 설계 원칙
//  1) 멱등 키는 event_id 하나뿐이다. 생산자가 (interaction_id, type, turn_id) 등으로 결정적으로 만든다.
//     시각·랜덤을 섞은 id를 쓰면 재시도마다 새 이벤트가 되어 중복 집계된다.
//  2) 중복 판정은 테넌트 스코프 안에서만 한다(§11.1). 테넌트가 다르면 같은 문자열 id라도 다른 이벤트다.
//  3) 브로커·큐 종속 코드는 EventSink 뒤에만 둔다(§6.2). Core는 어떤 브로커인지 알지 않는다.
//  4) 싱크 하나가 실패해도 나머지 싱크는 계속 간다. 실패는 삼키지 않고 결과에 담아 돌려준다.
import type { InteractionEvent } from './schema.ts';
import { assertTenantScoped } from './schema.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';

/** 멱등 키 — 테넌트 경계를 넘지 않는다(§11.1). */
export function idempotencyKey(e: InteractionEvent): string {
  assertTenantScoped(e);
  if (!e.event_id) throw new Error(`event_id 없는 이벤트는 발행할 수 없다: ${e.type} (설계서 §8.1)`);
  return `${e.tenant_id}::${e.event_id}`;
}

/**
 * 생산자용 결정적 event_id 생성기.
 * 같은 논리적 사건은 몇 번을 재시도해도 같은 id가 나와야 한다 — 그래서 시각·난수를 받지 않는다.
 */
export function deterministicEventId(parts: {
  interactionId: string;
  type: InteractionEvent['type'];
  /** 같은 interaction 안에서 같은 type이 여러 번 나오는 경우의 구분자(turn_id 등) */
  discriminator?: string;
}): string {
  const d = parts.discriminator === undefined ? '' : `:${parts.discriminator}`;
  return `${parts.interactionId}:${parts.type}${d}`;
}

/** 이미 처리한 이벤트인지 기억하는 저장소. 인메모리는 단일 프로세스용, 운영은 영속 구현으로 교체(§6.2). */
export interface IdempotencyStore {
  /** 처음 보는 키면 true를 반환하며 기록한다. 이미 있으면 false. (원자적이어야 한다) */
  markIfNew(key: string): boolean;
  has(key: string): boolean;
  size(): number;
  /** 키를 되돌린다. 되돌릴 수 없는 구현(추가 전용 로그 등)은 구현하지 않아도 된다. */
  release?(key: string): void;
}

/**
 * 인메모리 멱등 저장소. 삽입 순서 기준으로 상한을 넘으면 가장 오래된 키부터 버린다.
 * maxKeys는 호출자가 운영 환경에 맞게 정한다 — 임의 기본값을 코드에 박지 않는다(§13-3).
 */
export function createMemoryIdempotencyStore(opts: { maxKeys: number }): IdempotencyStore {
  if (!Number.isInteger(opts.maxKeys) || opts.maxKeys <= 0) {
    throw new Error('maxKeys는 1 이상의 정수여야 한다 (설계서 §8.1)');
  }
  const seen = new Set<string>();
  const evict = () => {
    while (seen.size > opts.maxKeys) {
      const oldest = seen.values().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  };
  return {
    markIfNew(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      evict();
      return true;
    },
    has: (key) => seen.has(key),
    size: () => seen.size,
    release(key) {
      seen.delete(key);
    },
  };
}

/** 브로커·저장소 어댑터. 동기/비동기 모두 허용한다(§6.2). */
export interface EventSink {
  name: string;
  deliver(event: InteractionEvent): void | Promise<void>;
}

export type PublishStatus = 'delivered' | 'duplicate' | 'rejected';

export interface SinkOutcome {
  sink: string;
  ok: boolean;
  errorMessage?: string;
}

export interface PublishResult {
  eventId: string;
  key: string;
  status: PublishStatus;
  /** status가 'rejected'일 때의 사유 */
  reasonKo?: string;
  sinks: SinkOutcome[];
}

export interface EventBusOptions {
  scope: TenantScope;
  sinks: EventSink[];
  store: IdempotencyStore;
  /**
   * 싱크 실패 시 멱등 키를 되돌릴지 여부.
   *  - true  : 재발행 시 다시 시도한다(적어도 한 번 전달 보장 쪽).
   *  - false : 중복 전달을 절대 허용하지 않는다(정확히 한 번 쪽, 유실 위험은 싱크가 책임).
   * 어느 쪽이 맞는지는 싱크의 성격에 달렸으므로 호출자가 명시한다.
   */
  releaseKeyOnSinkFailure: boolean;
}

export interface EventBus {
  publish(event: InteractionEvent): Promise<PublishResult>;
  publishAll(events: InteractionEvent[]): Promise<PublishResult[]>;
}

/**
 * §11.1 — 버스는 자기 스코프의 이벤트만 통과시킨다.
 * 테넌트가 다른 이벤트는 던지지 않고 'rejected'로 돌려준다: 배치 하나 때문에 전체 파이프라인이 멈추면
 * 더 큰 사고가 되기 때문이다. 대신 사유를 남겨 운영이 반드시 보게 한다.
 */
function checkScope(e: InteractionEvent, scope: TenantScope): string | null {
  if (!e.tenant_id) return 'tenant_id 없는 이벤트 (§11.1)';
  if (e.tenant_id !== scope.tenantId) {
    return `버스 스코프(${scope.tenantId})와 다른 테넌트의 이벤트 (§11.1)`;
  }
  if (!e.event_id) return 'event_id 없는 이벤트 (§8.1)';
  return null;
}

export function createEventBus(opts: EventBusOptions): EventBus {
  assertTenantScope(opts.scope);
  const { sinks, store, scope } = opts;

  async function publish(event: InteractionEvent): Promise<PublishResult> {
    const reason = checkScope(event, scope);
    if (reason) {
      return { eventId: event.event_id ?? '', key: '', status: 'rejected', reasonKo: reason, sinks: [] };
    }
    const key = idempotencyKey(event);
    if (!store.markIfNew(key)) {
      return { eventId: event.event_id, key, status: 'duplicate', sinks: [] };
    }

    const outcomes: SinkOutcome[] = [];
    for (const sink of sinks) {
      try {
        await sink.deliver(event);
        outcomes.push({ sink: sink.name, ok: true });
      } catch (err) {
        outcomes.push({
          sink: sink.name,
          ok: false,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const anyFailed = outcomes.some((o) => !o.ok);
    if (anyFailed && opts.releaseKeyOnSinkFailure) {
      // 되돌릴 수 없는 저장소(추가 전용 로그 등)도 있으므로 release는 선택 기능이다.
      store.release?.(key);
    }
    return { eventId: event.event_id, key, status: 'delivered', sinks: outcomes };
  }

  return {
    publish,
    async publishAll(events) {
      // 순서 보장: 같은 interaction의 이벤트는 발행 순서가 곧 시간 순서다. 병렬 처리하지 않는다.
      const results: PublishResult[] = [];
      for (const e of events) results.push(await publish(e));
      return results;
    },
  };
}

/** 테스트·개발용 수집 싱크. 운영 싱크는 승인 후 별도 구현 — [승인 필요]. */
export function createCollectorSink(name = 'collector'): EventSink & { events: InteractionEvent[] } {
  const events: InteractionEvent[] = [];
  return {
    name,
    events,
    deliver(event) {
      events.push(event);
    },
  };
}

/**
 * 이미 쌓인 이벤트 배열에서 중복을 제거한다(리플레이·백필용).
 * 순서는 유지하고, 같은 멱등 키의 첫 번째 것만 남긴다.
 */
export function dedupeEvents(events: InteractionEvent[]): InteractionEvent[] {
  const seen = new Set<string>();
  const out: InteractionEvent[] = [];
  for (const e of events) {
    if (!e.tenant_id || !e.event_id) continue;
    const key = `${e.tenant_id}::${e.event_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
