import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
try { m = await import('../src/api/rateLimit.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const clockOf = (start = 0) => { let t = start; return { now: () => t, adv: (ms) => { t += ms; } }; };

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('버스트 용량만큼 통과하고 그다음은 거절한다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 3, refillPerSec: 1 }, clock: c.now });
  const results = [lim.check('k'), lim.check('k'), lim.check('k'), lim.check('k')];
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.equal(results[2].remaining, 0);
  assert.equal(results[3].limit, 3);
});

test('시간이 지나면 채워진다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 2, refillPerSec: 2 }, clock: c.now });
  lim.check('k'); lim.check('k');
  assert.equal(lim.check('k').allowed, false);
  c.adv(500);                       // 초당 2개 → 0.5초에 1개
  assert.equal(lim.check('k').allowed, true);
});

test('용량 이상으로 쌓이지 않는다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 2, refillPerSec: 10 }, clock: c.now });
  c.adv(60_000);
  assert.equal(lim.peek('k').remaining, 2);
  assert.equal(lim.check('k').allowed, true);
  assert.equal(lim.check('k').allowed, true);
  assert.equal(lim.check('k').allowed, false);
});

test('거절 시 재시도 시각이 계산값으로 나온다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 1, refillPerSec: 2 }, clock: c.now });
  lim.check('k');
  const d = lim.check('k');
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterMs, 500);   // 토큰 1개 = 0.5초
});

test('테넌트가 다르면 서로 영향을 주지 않는다 (§11.1)', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 1, refillPerSec: 1 }, clock: c.now });
  const a = m.rateLimitKey({ tenantId: 't1' }, 'turn');
  const bkey = m.rateLimitKey({ tenantId: 't2' }, 'turn');
  assert.equal(lim.check(a).allowed, true);
  assert.equal(lim.check(a).allowed, false);
  assert.equal(lim.check(bkey).allowed, true, '다른 고객사가 막히면 안 된다');
});

test('제한 키는 테넌트·워크스페이스·버킷·주체를 담고 개인정보는 담지 않는다', b, () => {
  assert.equal(m.rateLimitKey({ tenantId: 't1', workspaceId: 'w1' }, 'turn', 'svc_callbot'), 't1:w1:turn:svc_callbot');
  assert.equal(m.rateLimitKey({ tenantId: 't1' }, 'turn'), 't1:-:turn');
});

test('키별로 다른 한도를 줄 수 있다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({
    rule: (key) => (key.includes('vip') ? { burst: 5, refillPerSec: 1 } : { burst: 1, refillPerSec: 1 }),
    clock: c.now,
  });
  assert.equal(lim.check('t1:-:vip').allowed, true);
  assert.equal(lim.check('t1:-:vip').allowed, true);
  assert.equal(lim.check('t1:-:basic').allowed, true);
  assert.equal(lim.check('t1:-:basic').allowed, false);
});

test('peek 은 토큰을 소비하지 않는다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 2, refillPerSec: 1 }, clock: c.now });
  lim.peek('k'); lim.peek('k');
  assert.equal(lim.peek('k').remaining, 2);
  assert.equal(lim.check('k').allowed, true);
});

test('cost 로 비싼 요청을 무겁게 센다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 10, refillPerSec: 1 }, clock: c.now });
  assert.equal(lim.check('k', 7).allowed, true);
  assert.equal(lim.check('k', 7).allowed, false);
  assert.equal(lim.check('k', 3).allowed, true);
});

test('reset 은 개별·전체 모두 지운다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 1, refillPerSec: 1 }, clock: c.now });
  lim.check('a'); lim.check('b');
  assert.equal(lim.size, 2);
  lim.reset('a');
  assert.equal(lim.size, 1);
  lim.reset();
  assert.equal(lim.size, 0);
});

// ── 실패 경로·경계 ───────────────────────────────────────────────────────────

test('빈 키는 거부한다 — 테넌트 경계 없는 제한을 허용하지 않는다', b, () => {
  const lim = m.createRateLimiter({ rule: { burst: 1, refillPerSec: 1 }, clock: () => 0 });
  assert.throws(() => lim.check(''), (e) => e.code === 'E_INTERNAL');
});

test('잘못된 설정은 호출 시점에 드러난다', b, () => {
  const zero = m.createRateLimiter({ rule: { burst: 0, refillPerSec: 1 }, clock: () => 0 });
  assert.throws(() => zero.check('k'), (e) => e.code === 'E_INTERNAL');
  const neg = m.createRateLimiter({ rule: { burst: 1, refillPerSec: 0 }, clock: () => 0 });
  assert.throws(() => neg.check('k'), (e) => e.code === 'E_INTERNAL');
});

test('용량보다 비싼 요청은 영원히 재시도시키지 않고 입력 오류로 막는다', b, () => {
  const lim = m.createRateLimiter({ rule: { burst: 5, refillPerSec: 1 }, clock: () => 0 });
  assert.throws(() => lim.check('k', 6), (e) => e.code === 'E_INVALID_INPUT');
});

test('cost 가 0·음수·NaN 이면 거부한다', b, () => {
  const lim = m.createRateLimiter({ rule: { burst: 5, refillPerSec: 1 }, clock: () => 0 });
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(() => lim.check('k', bad), (e) => e.code === 'E_INTERNAL');
  }
});

test('시계가 뒤로 가도 토큰이 줄거나 늘지 않는다', b, () => {
  let t = 10_000;
  const lim = m.createRateLimiter({ rule: { burst: 2, refillPerSec: 1 }, clock: () => t });
  lim.check('k');
  t = 5_000;                       // NTP 보정 등으로 시계 역행
  const d = lim.check('k');
  assert.equal(d.allowed, true);
  assert.equal(d.remaining, 0);
  assert.equal(lim.check('k').allowed, false);
});

test('유휴 버킷은 정리되어 메모리가 무한히 늘지 않는다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 1, refillPerSec: 1 }, clock: c.now, idleTtlMs: 1000 });
  lim.check('a');
  c.adv(2000);
  lim.check('b');
  assert.equal(lim.size, 1, '오래된 버킷은 버린다');
});

test('키 상한을 넘으면 오래된 것부터 버린다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 1, refillPerSec: 1 }, clock: c.now, maxKeys: 3 });
  for (let i = 0; i < 10; i++) lim.check(`k${i}`);
  assert.ok(lim.size <= 3);
});

test('enforceRateLimit 은 거절만 표준 오류로 바꾼다', b, () => {
  const c = clockOf();
  const lim = m.createRateLimiter({ rule: { burst: 1, refillPerSec: 4 }, clock: c.now });
  assert.equal(m.enforceRateLimit(lim, 'k'), undefined);
  const err = m.enforceRateLimit(lim, 'k');
  assert.equal(err.code, 'E_RATE_LIMITED');
  assert.equal(err.retryAfterMs, 250);
});
