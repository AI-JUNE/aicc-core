// 요청 제한(rate limit) — 설계서 §11.1(테넌트 격리)·§9.3(과부하 시 보호)·§11.2(과금 남용 방지)·§13-3.
//
// 왜 이 파일이 필요한가:
// 공개 API에 제한이 없으면 한 테넌트의 폭주가 전체 서비스를 끌어내린다. 그리고 그 폭주는
// 악의보다 사고로 온다 — 채널 저장소의 재시도 루프, 잘못 설정된 배치, 이벤트 재전송.
// 제한을 각 저장소가 따로 만들면 테넌트 경계 없이 IP 단위로만 걸리기 쉽고,
// 그러면 한 고객사 때문에 다른 고객사가 막힌다(§11.1 위반).
//
// 토큰 버킷을 쓰는 이유: 평시 여유분을 모아 뒀다가 짧은 몰아치기(통화 시작 직후 연속 턴)를
// 흡수하면서도 평균 속도는 지킨다. 고정 창(fixed window)은 창 경계에서 2배가 통과한다.
//
// 무엇을 하지 않는가:
//  - 기본 한도를 코드에 박지 않는다. 계약·운영 합의값을 호출자가 준다(§13-3).
//  - 저장소를 강제하지 않는다. 기본은 인메모리이며, 다중 인스턴스에서는 공유 저장소가 필요하다 —
//    분산 백엔드 연결은 [승인 필요].
import type { TenantScope } from '../core/tenancy.ts';
import { ApiError } from './errors.ts';

export interface RateLimitRule {
  /** 버킷 최대 용량(= 순간 허용 최대 몰아치기). */
  burst: number;
  /** 초당 채워지는 토큰 수. */
  refillPerSec: number;
}

export interface RateLimitOptions {
  /** 키별로 다른 한도를 줄 수 있게 규칙을 함수로도 받는다. */
  rule: RateLimitRule | ((key: string) => RateLimitRule);
  /** 시각(ms). 테스트·결정성을 위해 주입 가능. 기본은 Date.now. */
  clock?: () => number;
  /** 유휴 버킷 정리 기준(ms). 지나면 버려서 메모리가 무한히 늘지 않게 한다. */
  idleTtlMs?: number;
  /** 동시에 유지할 버킷 수 상한. 초과 시 가장 오래된 것부터 버린다. */
  maxKeys?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 남은 토큰(내림). */
  remaining: number;
  limit: number;
  /** 거절된 경우 다시 시도 가능한 시각까지의 ms. 허용 시 0. */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** 토큰을 소비하고 판정한다. cost 로 비용이 큰 요청을 무겁게 셀 수 있다. */
  check(key: string, cost?: number): RateLimitDecision;
  /** 소비하지 않고 현재 상태만 본다(관리 화면용). */
  peek(key: string): RateLimitDecision;
  reset(key?: string): void;
  readonly size: number;
}

interface Bucket { tokens: number; updatedAt: number }

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_KEYS = 10_000;

/**
 * 테넌트 경계를 포함한 제한 키. 테넌트를 빼면 한 고객사의 폭주가 다른 고객사를 막는다(§11.1).
 * 개인정보(발신번호 등)를 키에 넣지 않는다 — 제한 상태는 오래 남는 저장 대상이다(§10.3).
 */
export function rateLimitKey(scope: TenantScope, bucket: string, principal?: string): string {
  const parts = [scope.tenantId, scope.workspaceId ?? '-', bucket];
  if (principal) parts.push(principal);
  return parts.join(':');
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const clock = opts.clock ?? (() => Date.now());
  const idleTtl = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const buckets = new Map<string, Bucket>();
  const ruleFor = (key: string): RateLimitRule => (typeof opts.rule === 'function' ? opts.rule(key) : opts.rule);

  function sweep(now: number): void {
    for (const [k, b] of buckets) {
      if (now - b.updatedAt > idleTtl) buckets.delete(k);
    }
    // Map 은 삽입 순서를 지키므로, 넘치면 앞쪽(가장 오래 갱신되지 않은 쪽)부터 버린다.
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  function refill(key: string, rule: RateLimitRule, now: number): Bucket {
    const existing = buckets.get(key);
    if (!existing) {
      const fresh = { tokens: rule.burst, updatedAt: now };
      buckets.set(key, fresh);
      sweep(now);
      return fresh;
    }
    const elapsedSec = Math.max(0, now - existing.updatedAt) / 1000;   // 시계 역행에도 음수를 만들지 않는다
    existing.tokens = Math.min(rule.burst, existing.tokens + elapsedSec * rule.refillPerSec);
    existing.updatedAt = now;
    // 최근 갱신 순서를 유지해야 정리 대상 선택이 맞는다.
    buckets.delete(key);
    buckets.set(key, existing);
    return existing;
  }

  function decide(key: string, cost: number, consume: boolean): RateLimitDecision {
    const rule = ruleFor(key);
    if (!(rule.burst > 0) || !(rule.refillPerSec > 0)) {
      throw new ApiError('E_INTERNAL', '요청 제한 설정이 올바르지 않습니다(burst·refillPerSec 는 0보다 커야 합니다).');
    }
    const now = clock();
    const b = refill(key, rule, now);
    const need = cost;
    if (b.tokens >= need) {
      if (consume) b.tokens -= need;
      return { allowed: true, remaining: Math.floor(b.tokens), limit: rule.burst, retryAfterMs: 0 };
    }
    const deficit = need - b.tokens;
    return {
      allowed: false,
      remaining: Math.floor(b.tokens),
      limit: rule.burst,
      retryAfterMs: Math.ceil((deficit / rule.refillPerSec) * 1000),
    };
  }

  return {
    check(key, cost = 1) {
      if (!key) throw new ApiError('E_INTERNAL', '제한 키가 비어 있습니다. 테넌트 경계 없는 제한은 허용하지 않습니다(§11.1).');
      if (!Number.isFinite(cost) || cost <= 0) {
        throw new ApiError('E_INTERNAL', '요청 비용(cost)은 0보다 큰 유한한 수여야 합니다.');
      }
      const rule = ruleFor(key);
      // 설정 오류를 먼저 판정한다 — burst 가 0이면 "비싼 요청"이 아니라 설정이 잘못된 것이다.
      if (!(rule.burst > 0) || !(rule.refillPerSec > 0)) {
        throw new ApiError('E_INTERNAL', '요청 제한 설정이 올바르지 않습니다(burst·refillPerSec 는 0보다 커야 합니다).');
      }
      if (cost > rule.burst) {
        // 버킷 용량보다 비싼 요청은 아무리 기다려도 통과하지 못한다. 영원히 재시도하게 두지 않는다.
        throw new ApiError('E_INVALID_INPUT', '요청 비용이 허용 한도를 초과합니다. 요청을 나누어 보내주세요.');
      }
      return decide(key, cost, true);
    },
    peek(key) { return decide(key, 0, false); },
    reset(key) { if (key === undefined) buckets.clear(); else buckets.delete(key); },
    get size() { return buckets.size; },
  };
}

/**
 * 거절을 표준 오류로 바꾼다. retryAfterMs 는 계산된 실제 값이며 추정치가 아니다.
 * 통과면 undefined 를 돌려주므로 호출부는 `const err = enforce(...); if (err) return err;` 형태가 된다.
 */
export function enforceRateLimit(limiter: RateLimiter, key: string, cost = 1): ApiError | undefined {
  const d = limiter.check(key, cost);
  if (d.allowed) return undefined;
  return new ApiError(
    'E_RATE_LIMITED',
    '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
    { retryAfterMs: d.retryAfterMs },
  );
}
