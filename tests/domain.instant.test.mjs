// 시각 표기가 섞여도 순서는 순간(ms)으로 판정한다 — 감사 조회·접근 요약·상호작용 투영.
// 사전식 비교에서는 `…T09:00:00+09:00`(= 00:00Z)이 `…T00:10:00Z` 보다 크다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let inst = null, acc = null, log = null, inter = null, ev = null;
try {
  inst = await import('../src/domain/instant.ts');
  acc = await import('../src/audit/access.ts');
  log = await import('../src/audit/log.ts');
  inter = await import('../src/portal/executeInteractions.ts');
  ev = await import('../src/events/schema.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: inst ? false : '타입 스트리핑 미지원 런타임' };

const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

const scope = { tenantId: 't1' };
const admin = { userId: 'u_admin', roles: ['admin'], tenantId: 't1' };
// 같은 하루의 세 순간: 00:00Z(= 09:00+09:00) < 00:10Z < 00:20Z
const KST_0000Z = '2026-11-02T09:00:00+09:00';
const Z_0010 = '2026-11-02T00:10:00Z';
const Z_0020 = '2026-11-02T00:20:00Z';

test('compareInstants — 오프셋이 달라도 순간으로 비교한다', b, () => {
  assert.ok(inst.compareInstants(KST_0000Z, Z_0010) < 0);
  assert.ok(inst.compareInstants(Z_0010, KST_0000Z) > 0);
  assert.equal(inst.compareInstants('2026-11-02T09:00:00+09:00', '2026-11-02T00:00:00Z'), 0);
});

test('compareInstants — 해석 안 되는 값은 던지지 않고 사전식으로 물러난다', b, () => {
  assert.equal(inst.compareInstants('', ''), 0);
  assert.ok(inst.compareInstants('garbage-a', 'garbage-b') < 0);
  assert.ok(inst.compareInstants('garbage', Z_0010) !== undefined);
  assert.ok(Number.isNaN(inst.instantMs('not-a-time')));
  assert.ok(Number.isNaN(inst.instantMs(undefined)));
});

const chainOf = () => {
  let chain = log.emptyChain(scope);
  const times = [KST_0000Z, Z_0010, Z_0020];
  times.forEach((at, i) => {
    chain = acc.recordAccess(chain, {
      scope, actor: admin, routeId: 'settings.members', at, recordId: `a${i}`,
    }, hash).chain;
  });
  return chain;
};

test('감사 조회 — +09:00 기록이 기간 필터에서 사라지지 않는다', b, () => {
  const chain = chainOf();
  // 00:05Z 이후: 00:10Z·00:20Z 두 건만. 사전식이면 "09:00+09:00" 이 "00:05Z" 보다 커서 세 건이 된다.
  const q = { scope, from: '2026-11-02T00:05:00Z' };
  assert.equal(log.queryAudit(chain, q).length, 2);
  assert.equal(acc.accessHistory(chain, q).length, 2);
  // 00:05Z 이전: +09:00 한 건만(사전식이면 0건 — 기록이 조회에서 빠진다).
  const q2 = { scope, to: '2026-11-02T00:05:00Z' };
  assert.deepEqual(log.queryAudit(chain, q2).map((r) => r.occurred_at), [KST_0000Z]);
  assert.equal(acc.accessHistory(chain, q2).length, 1);
});

test('접근 요약 — 첫·마지막 시각이 거꾸로 적히지 않는다', b, () => {
  const [s] = acc.accessSummary(chainOf(), { scope });
  assert.equal(s.firstAt, KST_0000Z);
  assert.equal(s.lastAt, Z_0020);
});

test('감사 조회 실패 경로 — 해석 안 되는 경계값이어도 던지지 않는다', b, () => {
  const chain = chainOf();
  assert.doesNotThrow(() => log.queryAudit(chain, { scope, from: 'bogus' }));
  assert.doesNotThrow(() => acc.accessHistory(chain, { scope, to: '' }));
});

test('상호작용 투영 — 시작·종료 시각이 표기가 섞여도 순간 순서를 따른다', b, () => {
  const p = (id, at) => ({ eventId: id, occurredAt: at, tenantId: 't1', interactionId: 'i1', channel: 'voice' });
  const events = [
    ev.sessionStarted(p('e1', Z_0010), { entryPoint: 'inbound_call' }),
    ev.sessionStarted(p('e2', KST_0000Z), { entryPoint: 'inbound_call' }), // 더 이른 순간
    ev.sessionEnded(p('e3', Z_0010), { outcome: 'AUTO_RESOLVED', turnCount: 0, durationMs: 1000 }),
    ev.sessionEnded(p('e4', '2026-11-02T09:20:00+09:00'), { outcome: 'AUTO_RESOLVED', turnCount: 0, durationMs: 1000 }), // 00:20Z
  ];
  const r = inter.projectInteractions(events, { scope });
  assert.equal(r.rows[0].startedAt, KST_0000Z);
  assert.equal(r.rows[0].endedAt, '2026-11-02T09:20:00+09:00');
});
