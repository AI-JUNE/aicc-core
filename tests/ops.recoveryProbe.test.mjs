// 복구 프로브 — §9.3·§10.3·§13-3.
// 실제 엔진·네트워크·타이머를 쓰지 않는다. 시계와 제한 시간 구현은 전부 주입한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
let fb = null;
let http = null;
try {
  m = await import('../src/ops/recoveryProbe.ts');
  fb = await import('../src/ops/fallback.ts');
  http = await import('../src/adapters/http.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const POLICY = {
  tenantId: 't1', staleAfterMs: 60_000, treatUnknownAsDown: true,
  legacyIvrAvailable: true, agentQueueAvailable: true,
};
const T0 = '2026-09-18T00:00:00.000Z';
const at = (sec) => new Date(Date.parse(T0) + sec * 1000).toISOString();

/** 제한 시간을 손으로 돌린다 — 실제 타이머를 쓰면 검사가 시계에 의존한다. */
function manualScheduler() {
  const pending = [];
  const sched = (ms, run) => {
    const entry = { ms, run, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  sched.fire = () => { for (const e of pending) if (!e.cancelled) e.run(); };
  sched.pending = pending;
  return sched;
}

const sample = (component, state, observedAt) => ({ component, state, observedAt });
const probeOf = (component, impl) => ({ component, check: impl });

function setup(over = {}) {
  const registry = fb.createHealthRegistry(over.initial ?? []);
  const scheduler = over.scheduler ?? manualScheduler();
  const runner = m.createRecoveryProbeRunner({
    schedules: over.schedules ?? [],
    registry,
    policy: { ...POLICY, ...(over.policy ?? {}) },
    now: () => over.nowIso ?? T0,
    scheduler,
    ...(over.confirmSuccesses === undefined ? {} : { confirmSuccesses: over.confirmSuccesses }),
    ...(over.watch === undefined ? {} : { watch: over.watch }),
    ...(over.monotonic === undefined ? {} : { monotonic: over.monotonic }),
  });
  return { registry, runner, scheduler };
}

// ── 이 모듈이 없을 때의 결함을 먼저 고정한다 ─────────────────────────────────

test('프로브가 없으면 down 에서 영영 빠져나오지 못한다 — 이 결함을 먼저 고정한다', b, () => {
  const registry = fb.createHealthRegistry([sample('llm', 'down', T0)]);
  // 폴백이 걸리면 엔진을 부르는 일이 멈추므로 새 샘플이 생기지 않는다.
  const d1 = fb.decideFallbackMode('voice', registry, POLICY, at(1));
  assert.notEqual(d1.mode, 'normal');
  // 샘플이 낡아도(보수적 테넌트) 여전히 down 이다. 사람이 손대기 전까지 풀리지 않는다.
  const d2 = fb.decideFallbackMode('voice', registry, POLICY, at(3600));
  assert.notEqual(d2.mode, 'normal');
});

test('프로브가 붙으면 같은 상황에서 복구가 확인되고 폴백이 풀린다', b, async () => {
  // llm 만 죽은 상황을 만든다 — 나머지 voice 의존성은 정상이어야 판정이 llm 때문임이 분명해진다.
  const others = fb.CHANNEL_DEPENDENCIES.voice.filter((c) => c !== 'llm').map((c) => sample(c, 'up', at(9)));
  const { registry, runner, scheduler } = setup({
    initial: [...others, sample('llm', 'down', T0)],
    schedules: [{ probe: probeOf('llm', async () => sample('llm', 'up', T0)), intervalMs: 5000, timeoutMs: 1000 }],
    nowIso: at(10),
  });
  assert.notEqual(fb.decideFallbackMode('voice', registry, POLICY, at(10)).mode, 'normal');
  const rep = await runner.runDue();
  assert.deepEqual(rep.recovered, ['llm']);
  assert.equal(registry.latest('llm').state, 'up');
  assert.equal(fb.decideFallbackMode('voice', registry, POLICY, at(10)).mode, 'normal');
  assert.equal(scheduler.pending.every((p) => p.cancelled), true, '성공한 프로브의 제한 시간 타이머를 치우지 않았다');
});

// ── 무엇을 찌르고 무엇을 찌르지 않는가 ───────────────────────────────────────

test('정상인 컴포넌트는 찌르지 않는다 — 멀쩡한 엔진에 보내는 합성 요청은 비용이다(§11.2)', b, async () => {
  let calls = 0;
  const { runner } = setup({
    initial: [sample('llm', 'up', T0)],
    schedules: [{ probe: probeOf('llm', async () => { calls += 1; return sample('llm', 'up', T0); }), intervalMs: 5000, timeoutMs: 1000 }],
  });
  const rep = await runner.runDue();
  assert.equal(calls, 0);
  assert.equal(rep.attempts[0].skipped, 'healthy');
});

test('degraded·unknown 도 확인 대상이다 — 나쁜 상태를 방치하지 않는다', b, async () => {
  for (const state of ['degraded', 'down']) {
    const { runner } = setup({
      initial: [sample('rag', state, T0)],
      schedules: [{ probe: probeOf('rag', async () => sample('rag', 'up', T0)), intervalMs: 1, timeoutMs: 1000 }],
      nowIso: at(1),
    });
    const rep = await runner.runDue();
    assert.deepEqual(rep.recovered, ['rag'], `${state} 에서 확인하지 않았다`);
  }
  // 샘플이 아예 없는 컴포넌트도(보수적 테넌트에서는 down 으로 읽힌다) 확인 대상이다.
  const { runner } = setup({
    schedules: [{ probe: probeOf('tts', async () => sample('tts', 'up', T0)), intervalMs: 1, timeoutMs: 1000 }],
  });
  const rep = await runner.runDue();
  assert.deepEqual(rep.recovered, ['tts']);
});

test('간격·제한 시간을 주지 않으면 돌리지 않고, 건너뛴 사실을 적는다(§13-3)', b, async () => {
  let calls = 0;
  const probe = probeOf('llm', async () => { calls += 1; return sample('llm', 'up', T0); });
  const noInterval = setup({ initial: [sample('llm', 'down', T0)], schedules: [{ probe, timeoutMs: 1000 }] });
  assert.equal((await noInterval.runner.runDue()).attempts[0].skipped, 'no_interval');

  const noTimeout = setup({ initial: [sample('llm', 'down', T0)], schedules: [{ probe, intervalMs: 1000 }] });
  assert.equal((await noTimeout.runner.runDue()).attempts[0].skipped, 'no_timeout');
  assert.equal(calls, 0, '선언이 빠졌는데 프로브가 돌았다');
});

test('간격 전에는 다시 돌리지 않는다 — 힘들어하는 엔진을 더 밀어붙이지 않는다', b, async () => {
  let calls = 0;
  const { runner } = setup({
    initial: [sample('llm', 'down', T0)],
    schedules: [{ probe: probeOf('llm', async () => { calls += 1; return sample('llm', 'down', T0); }), intervalMs: 5000, timeoutMs: 100 }],
  });
  await runner.runDue(at(0));
  assert.equal(calls, 1);
  const again = await runner.runDue(at(1));
  assert.equal(calls, 1);
  assert.equal(again.attempts[0].skipped, 'not_due');
  await runner.runDue(at(6));
  assert.equal(calls, 2);
  assert.equal(runner.lastRunAt('llm'), at(6));
});

test('프로브가 없는 나쁜 컴포넌트는 "확인할 길이 없다"로 드러난다', b, async () => {
  const { runner } = setup({
    initial: [sample('llm', 'down', T0), sample('stt', 'up', T0)],
    watch: ['llm', 'stt', 'telephony'],
  });
  const rep = await runner.runDue();
  assert.deepEqual(rep.unprobed.sort(), ['llm', 'telephony']);
  const line = m.formatRecoveryReport(rep);
  assert.ok(line.includes('프로브 없음'), line);
  assert.ok(line.includes('[승인 필요]'), line);
});

// ── 실패 경로: 우리 잘못을 엔진 탓으로 적지 않는다 ───────────────────────────

test('승인 전 호출·설정 오류는 샘플을 남기지 않는다 — 켜 보기도 전에 영구 down 이 되면 안 된다', b, async () => {
  for (const code of ['E_APPROVAL_REQUIRED', 'E_CONFIG', 'E_INPUT']) {
    const { registry, runner } = setup({
      initial: [sample('llm', 'degraded', T0)],
      schedules: [{
        probe: probeOf('llm', async () => { throw new http.EngineError(code, 'llm', `가짜 ${code}`); }),
        intervalMs: 1, timeoutMs: 100,
      }],
      nowIso: at(1),
    });
    const rep = await runner.runDue();
    assert.equal(rep.attempts[0].recorded, undefined, `${code} 를 엔진 상태로 적었다`);
    assert.ok(rep.attempts[0].notRecordedKo.includes(code));
    assert.equal(registry.latest('llm').state, 'degraded', '기존 상태를 건드리면 안 된다');
  }
});

test('타임아웃·5xx 는 엔진 탓이 맞다 — down 으로 기록한다', b, async () => {
  const scheduler = manualScheduler();
  const { registry, runner } = setup({
    initial: [sample('llm', 'degraded', T0)],
    schedules: [{ probe: probeOf('llm', () => new Promise(() => { /* 영원히 안 옴 */ })), intervalMs: 1, timeoutMs: 300 }],
    scheduler, nowIso: at(1),
  });
  const p = runner.runDue();
  scheduler.fire();                      // 제한 시간 도달
  const rep = await p;
  assert.equal(rep.attempts[0].recorded.state, 'down');
  assert.ok(rep.attempts[0].recorded.detail.includes('E_TIMEOUT'));
  assert.equal(registry.latest('llm').state, 'down');
});

test('규약을 어긴 반환값은 up 으로도 down 으로도 읽지 않는다 — 프로브 결함이지 엔진 증거가 아니다', b, async () => {
  for (const bad of [undefined, null, 42, { state: 'ok', observedAt: T0, component: 'llm' }, { state: 'up', component: 'tts', observedAt: T0 }]) {
    const { registry, runner } = setup({
      initial: [sample('llm', 'down', T0)],
      schedules: [{ probe: probeOf('llm', async () => bad), intervalMs: 1, timeoutMs: 100 }],
      nowIso: at(1),
    });
    const rep = await runner.runDue();
    assert.equal(rep.attempts[0].recorded, undefined, `${JSON.stringify(bad)} 를 기록했다`);
    assert.ok(rep.attempts[0].notRecordedKo.includes('규약'));
    assert.equal(registry.latest('llm').state, 'down', '폴백은 보수적으로 유지되어야 한다');
  }
});

test('프로브가 동기로 터지거나 Promise 가 아닌 것을 돌려줘도 러너는 던지지 않는다', b, async () => {
  const { runner } = setup({
    initial: [sample('llm', 'down', T0), sample('tts', 'down', T0)],
    schedules: [
      { probe: probeOf('llm', () => { throw new Error('동기 폭발'); }), intervalMs: 1, timeoutMs: 100 },
      { probe: probeOf('tts', () => 'promise 아님'), intervalMs: 1, timeoutMs: 100 },
    ],
    nowIso: at(1),
  });
  const rep = await runner.runDue();                     // 던지면 이 줄에서 실패한다
  assert.equal(rep.attempts.length, 2);
  for (const a of rep.attempts) {
    assert.equal(a.recorded, undefined, '우리 잘못·정체불명을 엔진 상태로 적었다');
    assert.ok(a.notRecordedKo);
  }
});

test('한 프로브가 멈춰도 다른 프로브가 같이 멈추지 않는다(동시 실행)', b, async () => {
  const scheduler = manualScheduler();
  let sttEntered = false;
  const { registry, runner } = setup({
    initial: [sample('llm', 'down', T0), sample('stt', 'down', T0)],
    schedules: [
      // llm 이 먼저 선언됐고 영원히 응답하지 않는다. 순차 실행이라면 stt 는 여기서 시작조차 못 한다.
      { probe: probeOf('llm', () => new Promise(() => {})), intervalMs: 1, timeoutMs: 300 },
      { probe: probeOf('stt', async () => { sttEntered = true; return sample('stt', 'up', T0); }), intervalMs: 1, timeoutMs: 300 },
    ],
    scheduler, nowIso: at(1),
  });
  const p = runner.runDue();
  await new Promise((r) => { setImmediate(r); });
  // 아직 아무 제한 시간도 돌리지 않았다 — 그런데도 stt 가 들어갔다면 둘이 겹쳐 돈 것이다.
  assert.equal(sttEntered, true, '멈춘 프로브가 뒤 프로브의 시작을 막았다(순차 실행)');
  scheduler.fire();
  const rep = await p;
  assert.deepEqual(rep.recovered, ['stt']);
  assert.equal(registry.latest('llm').state, 'down');
});

test('직전 실행이 끝나지 않았으면 겹쳐 보내지 않는다', b, async () => {
  const scheduler = manualScheduler();
  const { runner } = setup({
    initial: [sample('llm', 'down', T0)],
    schedules: [{ probe: probeOf('llm', () => new Promise(() => {})), intervalMs: 1, timeoutMs: 300 }],
    scheduler,
  });
  const first = runner.runDue(at(1));
  const second = await runner.runDue(at(2));
  assert.equal(second.attempts[0].skipped, 'in_flight');
  scheduler.fire();
  await first;
});

// ── 연속 성공 확인(테넌트 선택) ──────────────────────────────────────────────

test('confirmSuccesses 를 주지 않으면 관측한 그대로 적는다(정책을 지어내지 않는다, §13-3)', b, async () => {
  const { registry, runner } = setup({
    initial: [sample('llm', 'down', T0)],
    schedules: [{ probe: probeOf('llm', async () => sample('llm', 'up', T0)), intervalMs: 1, timeoutMs: 100 }],
    nowIso: at(1),
  });
  await runner.runDue();
  assert.equal(registry.latest('llm').state, 'up');
});

test('confirmSuccesses=2 면 한 번 성공으로 up 을 적지 않고 진행 건수를 남긴다', b, async () => {
  const { registry, runner } = setup({
    initial: [sample('llm', 'down', T0)],
    schedules: [{ probe: probeOf('llm', async () => sample('llm', 'up', T0)), intervalMs: 1000, timeoutMs: 100 }],
    confirmSuccesses: 2,
  });
  const r1 = await runner.runDue(at(1));
  assert.equal(registry.latest('llm').state, 'down', '확인 전에 폴백을 풀면 깜빡이는 엔진이 채널을 왕복시킨다');
  assert.deepEqual(r1.attempts[0].confirm, { successes: 1, required: 2 });

  const r2 = await runner.runDue(at(3));
  assert.equal(registry.latest('llm').state, 'up');
  assert.deepEqual(r2.recovered, ['llm']);
});

test('연속이 끊기면 다시 처음부터 센다', b, async () => {
  let turn = 0;
  const seq = ['up', 'down', 'up', 'up'];
  const { registry, runner } = setup({
    initial: [sample('llm', 'down', T0)],
    schedules: [{
      probe: probeOf('llm', async () => sample('llm', seq[turn++], T0)),
      intervalMs: 1000, timeoutMs: 100,
    }],
    confirmSuccesses: 2,
  });
  await runner.runDue(at(1));    // up (1/2)
  await runner.runDue(at(3));    // down → 0 으로 되돌림 + 기록
  assert.equal(registry.latest('llm').state, 'down');
  await runner.runDue(at(5));    // up (1/2) — 여기서 올라가면 연속 계산이 틀린 것이다
  assert.equal(registry.latest('llm').state, 'down');
  await runner.runDue(at(7));    // up (2/2)
  assert.equal(registry.latest('llm').state, 'up');
});

// ── 설정 거부 ────────────────────────────────────────────────────────────────

test('설정 오류는 기동 시점에 거절한다(중복 컴포넌트·잘못된 수·프로브 없음)', b, () => {
  const p = probeOf('llm', async () => sample('llm', 'up', T0));
  const base = { registry: fb.createHealthRegistry(), policy: POLICY, now: () => T0 };
  assert.throws(() => m.createRecoveryProbeRunner({ ...base, schedules: [{ probe: p }, { probe: p }] }), /중복/);
  assert.throws(() => m.createRecoveryProbeRunner({ ...base, schedules: [{ probe: { component: 'llm' } }] }), /check\(\)/);
  assert.throws(() => m.createRecoveryProbeRunner({ ...base, schedules: [{ probe: p, intervalMs: 0 }] }), /intervalMs/);
  assert.throws(() => m.createRecoveryProbeRunner({ ...base, schedules: [{ probe: p, timeoutMs: -1 }] }), /timeoutMs/);
  assert.throws(() => m.createRecoveryProbeRunner({ ...base, schedules: [], confirmSuccesses: 0 }), /confirmSuccesses/);
});

test('프로브가 준 detail 은 마스킹을 거치고, 시각은 관측 시계로 통일된다(§10.3)', b, async () => {
  const { registry, runner } = setup({
    initial: [sample('stt', 'down', T0)],
    schedules: [{
      probe: probeOf('stt', async () => ({
        component: 'stt', state: 'up', observedAt: '2020-01-01T00:00:00.000Z',
        detail: '합성콜 010-1234-5678 정상',
      })),
      intervalMs: 1, timeoutMs: 100,
    }],
    nowIso: at(9),
  });
  await runner.runDue();
  const s = registry.latest('stt');
  assert.equal(s.observedAt, at(9), '프로브가 준 과거 시각을 그대로 쓰면 레지스트리의 늦은 도착 방어가 어긋난다');
  assert.ok(!s.detail.includes('010-1234-5678'), s.detail);
});

test('monotonic 을 주지 않으면 latencyMs 를 만들지 않는다(§13-3)', b, async () => {
  const { registry, runner } = setup({
    initial: [sample('llm', 'down', T0)],
    schedules: [{ probe: probeOf('llm', async () => sample('llm', 'up', T0)), intervalMs: 1, timeoutMs: 100 }],
    nowIso: at(1),
  });
  await runner.runDue();
  assert.equal(registry.latest('llm').latencyMs, undefined);

  let t = 0;
  const measured = setup({
    initial: [sample('llm', 'down', T0)],
    schedules: [{ probe: probeOf('llm', async () => sample('llm', 'up', T0)), intervalMs: 1, timeoutMs: 100 }],
    monotonic: () => (t += 7),
    nowIso: at(1),
  });
  await measured.runner.runDue();
  assert.equal(measured.registry.latest('llm').latencyMs, 7);
});
