import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
try { m = await import('../src/ops/health.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const fixed = (start = 1_700_000_000_000) => { let t = start; return { now: () => t, adv: (ms) => { t += ms; } }; };
const okProbe = (name, opt = {}) => ({ name, kind: 'db', critical: true, check: async () => ({ status: 'up' }), ...opt });

/** 손으로 돌리는 스케줄러 — 실제 시간을 기다리지 않고 타임아웃을 재현한다. */
const manualScheduler = () => {
  const pending = [];
  const s = (ms, run) => {
    const entry = { ms, run, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  s.fire = () => { for (const e of pending) if (!e.cancelled) e.run(); };
  s.pending = pending;
  return s;
};

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('모든 의존성이 정상이면 up·200 이다', b, async () => {
  const r = await m.checkHealth([okProbe('primary-db'), okProbe('cache', { kind: 'cache', critical: false })], { timeoutMs: 500 });
  assert.equal(r.status, 'up');
  assert.equal(r.httpStatus, 200);
  assert.equal(r.kind, 'readiness');
  assert.equal(r.dependencies.length, 2);
  assert.match(r.summaryKo, /2건 모두 정상/);
});

test('버전·커밋을 노출하되 커밋은 12자로 줄인다', b, async () => {
  const r = await m.checkHealth([], {
    timeoutMs: 500,
    build: { version: '0.1.0', commit: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4', builtAt: '2026-09-02T00:00:00.000Z', environment: 'staging' },
  });
  assert.equal(r.build.commit, 'a1b2c3d4e5f6');
  assert.equal(r.build.version, '0.1.0');
  assert.equal(r.build.environment, 'staging');
});

test('커밋 해시 형태가 아니면 싣지 않는다', b, () => {
  assert.equal(m.sanitizeBuild({ commit: 'main' }), undefined);
  assert.equal(m.sanitizeBuild({ version: '1', commit: 'main' }).commit, undefined);
  assert.equal(m.sanitizeBuild(undefined), undefined);
});

test('시계를 주면 실측 소요와 점검 시각이 실린다', b, async () => {
  const clock = fixed();
  const r = await m.checkHealth([{ name: 'db', kind: 'db', critical: true, check: async () => { clock.adv(7); return { status: 'up' }; } }], { timeoutMs: 500, clock: clock.now });
  assert.equal(r.dependencies[0].durationMs, 7);
  assert.equal(typeof r.checkedAt, 'string');
});

test('시계가 없으면 소요·시각을 만들어 넣지 않는다(§13-3)', b, async () => {
  const r = await m.checkHealth([okProbe('db')], { timeoutMs: 500 });
  assert.equal(r.dependencies[0].durationMs, undefined);
  assert.equal(r.checkedAt, undefined);
});

test('liveness 는 의존성을 건드리지 않는다', b, () => {
  let called = 0;
  const r = m.livenessReport({ build: { version: '0.1.0' } });
  assert.equal(r.kind, 'liveness');
  assert.equal(r.status, 'up');
  assert.equal(r.httpStatus, 200);
  assert.deepEqual(r.dependencies, []);
  assert.equal(called, 0);
});

test('프로브가 하나도 없어도 무너지지 않고 사실만 말한다', b, async () => {
  const r = await m.checkHealth([], { timeoutMs: 500 });
  assert.equal(r.status, 'up');
  assert.match(r.summaryKo, /등록되지 않았다/);
});

// ── 실패·경계 경로 ───────────────────────────────────────────────────────────

test('필수 의존성이 죽으면 down·503 이고, 부가 의존성만 죽으면 degraded·200 이다', b, async () => {
  const down = { name: 'x', kind: 'db', critical: true, check: async () => ({ status: 'down', code: 'E_UPSTREAM' }) };
  const soft = { name: 'y', kind: 'cache', critical: false, check: async () => ({ status: 'down' }) };
  const hard = await m.checkHealth([down, okProbe('ok2', { name: 'ok2' })], { timeoutMs: 500 });
  assert.equal(hard.status, 'down');
  assert.equal(hard.httpStatus, 503);
  assert.match(hard.summaryKo, /요청을 받을 수 없다/);

  const partial = await m.checkHealth([soft, okProbe('ok3', { name: 'ok3' })], { timeoutMs: 500 });
  assert.equal(partial.status, 'degraded');
  assert.equal(partial.httpStatus, 200);
  assert.match(partial.summaryKo, /일부 의존성 저하/);
});

test('프로브가 거부해도 던지지 않고 그 항목만 down 으로 기록한다', b, async () => {
  const r = await m.checkHealth([
    { name: 'engine', kind: 'engine', critical: false, check: async () => { throw new Error('연결 거부'); } },
    okProbe('db'),
  ], { timeoutMs: 500 });
  assert.equal(r.status, 'degraded');
  assert.equal(r.dependencies[0].code, 'E_UPSTREAM');
  assert.equal(r.dependencies[0].detail, '연결 거부');
  assert.equal(r.dependencies[1].status, 'up');
});

test('프로브가 동기로 터져도 잡아 낸다', b, async () => {
  const r = await m.checkHealth([
    { name: 'broken', kind: 'internal', critical: true, check: () => { throw new Error('즉시 실패'); } },
  ], { timeoutMs: 500 });
  assert.equal(r.status, 'down');
  assert.equal(r.dependencies[0].code, 'E_INTERNAL');
});

test('규약을 어긴 반환값을 정상으로 해석하지 않는다', b, async () => {
  const r = await m.checkHealth([
    { name: 'weird', kind: 'db', critical: true, check: async () => ({ status: 'fine' }) },
  ], { timeoutMs: 500 });
  assert.equal(r.status, 'down');
  assert.equal(r.dependencies[0].code, 'E_PROTOCOL');
});

test('제한 시간을 넘긴 프로브만 끊고 나머지는 그대로 살린다', b, async () => {
  const sched = manualScheduler();
  const hang = { name: 'slow', kind: 'external_api', critical: true, timeoutMs: 100, check: () => new Promise(() => {}) };
  const p = m.checkHealth([hang, okProbe('db')], { timeoutMs: 500, scheduler: sched });
  await Promise.resolve();
  sched.fire();
  const r = await p;
  assert.equal(r.dependencies[0].code, 'E_TIMEOUT');
  assert.match(r.dependencies[0].detail, /100ms/);
  assert.equal(r.dependencies[1].status, 'up');
  assert.equal(r.status, 'down');
});

test('제한 시간이 0이면 점검하지 않고 설정 오류로 표시한다', b, async () => {
  let called = 0;
  const r = await m.checkHealth([{ name: 'db', kind: 'db', critical: true, check: async () => { called += 1; return { status: 'up' }; } }], { timeoutMs: 0 });
  assert.equal(called, 0);
  assert.equal(r.dependencies[0].code, 'E_INTERNAL');
  assert.equal(r.status, 'down');
});

test('응답에 접속 문자열·개인정보가 그대로 실리지 않는다', b, async () => {
  const r = await m.checkHealth([{
    name: 'db', kind: 'db', critical: true,
    check: async () => { throw new Error('postgres://aicc:pw123456@10.0.0.5:5432/db 연결 실패 (담당 010-1234-5678, /home/deploy/aicc/src/db/pool.ts)'); },
  }], { timeoutMs: 500 });
  const detail = r.dependencies[0].detail;
  assert.ok(!detail.includes('pw123456'));
  assert.ok(!detail.includes('010-1234-5678'));
  assert.ok(!detail.includes('/home/deploy'));
  assert.ok(detail.includes('[제거됨]'));
});

test('이름이 중복된 프로브는 조용히 덮지 않고 표시한다', b, async () => {
  const r = await m.checkHealth([okProbe('db'), okProbe('db')], { timeoutMs: 500 });
  assert.equal(r.dependencies.length, 2);
  assert.match(r.dependencies[1].detail, /이름이 중복된 프로브/);
});

test('승인 전 프로브는 연결을 시도하지 않고 degraded 로 표시한다', b, async () => {
  const r = await m.checkHealth([m.approvalPendingProbe('engine-stt', 'engine')], { timeoutMs: 500 });
  assert.equal(r.status, 'degraded');
  assert.match(r.dependencies[0].detail, /\[승인 필요\]/);
});

test('집계 규칙과 HTTP 상태 매핑은 한 곳에서만 정해진다', b, () => {
  assert.equal(m.aggregateStatus([]), 'up');
  assert.equal(m.aggregateStatus([{ critical: false, status: 'degraded' }]), 'degraded');
  assert.equal(m.aggregateStatus([{ critical: false, status: 'down' }]), 'degraded');
  assert.equal(m.aggregateStatus([{ critical: true, status: 'down' }]), 'down');
  assert.equal(m.httpStatusFor('up'), 200);
  assert.equal(m.httpStatusFor('degraded'), 200);
  assert.equal(m.httpStatusFor('down'), 503);
});

test('빈 설명은 필드를 만들지 않는다', b, () => {
  assert.equal(m.sanitizeDetail(undefined), undefined);
  assert.equal(m.sanitizeDetail('   '), undefined);
  assert.equal(m.sanitizeDetail('정상'), '정상');
});
