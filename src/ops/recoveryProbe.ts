// 복구 프로브 — 설계서 §9.3(장애 폴백)·§6.2(엔진 비종속)·§10.3(마스킹)·§13-3(실측만).
//
// 왜 이 파일이 필요한가 — **폴백에서 빠져나오는 길이 없었다.**
// `decideFallbackMode` 는 레지스트리의 최신 샘플만 본다. 그 샘플이 들어오는 경로는 둘뿐이다:
// 채널이 `reportHealth` 로 선언하거나, `adapters/resilience.ts` 가 **실제 엔진 호출 결과**로 남기거나.
// 그런데 L2 가 `down` 으로 판정되는 순간 `channels/runtime.ts` 는 모든 세션을 IVR·상담사로 내린다 —
// 그러면 **엔진을 부르는 일 자체가 멈추고**, 새 샘플이 영영 생기지 않는다. 그 다음은 정책에 따라
// 둘 중 하나인데 **둘 다 틀렸다**:
//   - `treatUnknownAsDown: true`  → 샘플이 낡아 unknown 이 되어도 계속 down. 엔진이 5분 만에
//     살아나도 **사람이 손대기 전까지 영원히** 전 채널이 상담사 직결이다.
//   - `treatUnknownAsDown: false` → 샘플이 낡았다는 이유만으로 AI 응대가 재개된다. 엔진이
//     살아났다는 **증거는 하나도 없다**. 고객이 대신 확인해 주는 셈이다.
// 어느 쪽도 "확인하고 돌아온다"가 아니다. 빠진 것은 정책이 아니라 **재확인하는 주체**다.
// `HealthProbe` 인터페이스는 §9.3 에 선언되어 있었지만 이 저장소 어디에서도 쓰이지 않았다.
//
// 그래서 이 모듈은 **나쁜 상태인 컴포넌트만** 프로브로 다시 확인하고, 그 결과를 같은 레지스트리에
// 샘플로 남긴다. 판정은 여전히 `decideFallbackMode` 가 한다 — 여기서 폴백 모드를 정하지 않는다.
//
// 이 모듈이 **하지 않는 것**:
//  - **타이머를 스스로 돌리지 않는다.** `runDue(nowIso)` 를 호스트가 부른다. Core 가 몰래 켠
//    인터벌은 호스트가 끌 수 없고, 프로세스 종료를 막고, 테스트에서 시간을 못 돌린다.
//  - 확인 간격·제한 시간의 권장값을 만들지 않는다(§13-3). 주지 않으면 그 컴포넌트는
//    확인하지 않고 그 사실을 보고에 적는다 — 조용히 넘어가면 "프로브 붙였다"로 남는다.
//  - **정상인 컴포넌트를 찌르지 않는다.** 멀쩡한 엔진에 합성 요청을 주기적으로 보내는 것은
//    비용이고, 그 비용은 과금 근거에 정체불명 사용량으로 나타난다(§11.2).
//  - **우리 잘못을 엔진 탓으로 적지 않는다.** 승인 전 호출·설정 오류로 프로브가 실패하면
//    샘플을 남기지 않는다. 남기면 승인받기 전부터 그 엔진은 영구 `down` 이고, 위에 적은
//    래치가 형태만 바꿔 되살아난다 **[승인 필요]**.
//  - 프로브 때문에 절대 던지지 않는다. 복구 확인 루프가 예외로 죽으면 복구도 같이 죽는다.
import type { ComponentId, FallbackPolicy, HealthProbe, HealthRegistry, HealthSample, HealthState } from './fallback.ts';
import { effectiveComponentState } from './fallback.ts';
import type { Scheduler } from './health.ts';
import { EngineError } from '../adapters/http.ts';
import { classifyEngineFailure, normalizeEngineError } from '../adapters/resilience.ts';
import { maskPii } from '../core/policyGuard.ts';

const defaultScheduler: Scheduler = (ms, run) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/**
 * §9.3 컴포넌트 → 엔진 오류의 component 필드. 분류(`classifyEngineFailure`)는 코드만 보지만,
 * 오류에 남는 이름이 실제와 다르면 사후분석에서 엉뚱한 엔진을 뒤지게 된다.
 * 매체·백엔드처럼 엔진이 아닌 것은 `config` 로 둔다(엔진 이름을 지어내지 않는다).
 */
const ERROR_COMPONENT_OF: Record<ComponentId, 'stt' | 'tts' | 'llm' | 'embedding' | 'config'> = {
  stt: 'stt', tts: 'tts', llm: 'llm', rag: 'embedding',
  telephony: 'config', messaging: 'config', backend: 'config',
};

export interface ProbeSchedule {
  probe: HealthProbe;
  /** 이 컴포넌트를 얼마 만에 다시 확인할 것인가(ms). 주지 않으면 확인하지 않는다(§13-3). */
  intervalMs?: number;
  /**
   * 프로브 1회 제한 시간(ms). 주지 않으면 돌리지 않는다.
   * 제한 없는 복구 프로브는 멈춘 채로 영원히 "확인 중"이 되고, 그동안 폴백은 풀리지 않는다 —
   * 확인하지 않는 것보다 나쁘다(확인하는 줄 알기 때문이다).
   */
  timeoutMs?: number;
}

export type SkipReason =
  | 'healthy'            // 지금 나쁘지 않다 — 찌를 이유가 없다
  | 'not_due'            // 간격이 아직 안 됐다
  | 'no_interval'        // 간격 미선언(§13-3)
  | 'no_timeout'         // 제한 시간 미선언
  | 'in_flight';         // 직전 실행이 아직 안 끝났다(같은 엔진에 겹쳐 보내지 않는다)

export interface ProbeAttemptReport {
  component: ComponentId;
  /** 프로브를 돌렸는가. 건너뛴 이유는 감추지 않는다. */
  ran: boolean;
  skipped?: SkipReason;
  /** 프로브 직전에 읽은 상태(정책 반영). 왜 돌렸는지의 근거다. */
  stateBefore: HealthState;
  /** 레지스트리에 기록한 샘플. 기록하지 않았으면 없다. */
  recorded?: HealthSample;
  /** 기록하지 않은 이유(우리 잘못·정체불명). 조용히 삼키지 않는다(§9.3). */
  notRecordedKo?: string;
  /** 연속 성공 확인이 걸려 있을 때의 진행(실측 건수 — 비율·점수를 만들지 않는다, §13-3). */
  confirm?: { successes: number; required: number };
}

export interface RecoveryRunReport {
  at: string;
  attempts: ProbeAttemptReport[];
  /** 이번 실행으로 up 을 기록한 컴포넌트. 운영 알림의 근거가 된다. */
  recovered: ComponentId[];
  /** 프로브가 아예 없는, 지금 나쁜 컴포넌트. **복구를 확인할 길이 없다는 사실**을 드러낸다. */
  unprobed: ComponentId[];
}

export interface RecoveryProbeOptions {
  /** 컴포넌트별 프로브. 같은 컴포넌트를 두 번 선언하면 설정 오류다. */
  schedules: ProbeSchedule[];
  registry: HealthRegistry & { record(s: HealthSample): void };
  /** 어떤 상태를 "나쁘다"로 볼지는 폴백 정책과 **같은 규칙**을 쓴다(어긋나면 대상이 갈라진다). */
  policy: FallbackPolicy;
  /** 관측 시각. `decideFallbackMode` 와 같은 시계를 넘긴다. */
  now: () => string;
  /** 소요 실측용 단조 시계(ms). 없으면 latencyMs 를 채우지 않는다(§13-3). */
  monotonic?: () => number;
  /**
   * 몇 번 **연속** 성공해야 `up` 으로 기록할 것인가. 선언하지 않으면 관측한 그대로 기록한다
   * (관측을 그대로 적는 것은 정책이 아니다). 2 이상을 주면 확인될 때까지 직전 나쁜 상태를
   * 유지하며 진행 건수를 남긴다 — 깜빡이는 엔진이 채널을 왕복시키지 않게 하는 선택이고,
   * 그 대가(복구가 늦어짐)를 치를지는 테넌트가 정한다.
   */
  confirmSuccesses?: number;
  /** 제한 시간 구현. 테스트에서 시간을 손으로 돌리기 위한 주입점이다. */
  scheduler?: Scheduler;
  /** §9.3 판정에 쓰이는 전체 컴포넌트 목록. 프로브가 없는 나쁜 컴포넌트를 드러내는 데 쓴다. */
  watch?: ComponentId[];
}

export interface RecoveryProbeRunner {
  /** 지금 돌릴 차례가 된 프로브만 돌린다. **절대 던지지 않는다.** */
  runDue(nowIso?: string): Promise<RecoveryRunReport>;
  /** 마지막 실행 시각(컴포넌트별). 운영이 "언제 마지막으로 확인했나"를 본다. */
  lastRunAt(component: ComponentId): string | undefined;
}

/** 프로브가 규약을 어긴 반환값을 정상으로 읽지 않는다 — 장애가 조용히 묻힌다. */
function validSample(v: unknown, component: ComponentId): HealthSample | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Partial<HealthSample>;
  if (s.state !== 'up' && s.state !== 'degraded' && s.state !== 'down' && s.state !== 'unknown') return undefined;
  if (typeof s.observedAt !== 'string' || Number.isNaN(Date.parse(s.observedAt))) return undefined;
  if (s.component !== component) return undefined;   // 다른 컴포넌트 상태를 대신 적지 못하게 한다
  return s as HealthSample;
}

function runWithLimit(
  probe: HealthProbe,
  timeoutMs: number,
  scheduler: Scheduler,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: true; value: unknown } | { ok: false; error: unknown }): void => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(r);
    };
    const cancel = scheduler(timeoutMs, () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: new EngineError('E_TIMEOUT', 'config', `복구 프로브가 ${timeoutMs}ms 안에 응답하지 않았다`) });
    });
    try {
      const p = probe.check();
      if (!p || typeof (p as Promise<unknown>).then !== 'function') {
        // 프로브 구현 결함이지 엔진 상태가 아니다 — E_CONFIG 는 엔진 탓으로 집계되지 않는다.
        done({ ok: false, error: new EngineError('E_CONFIG', 'config', '프로브가 Promise 를 돌려주지 않았다') });
        return;
      }
      p.then((value) => done({ ok: true, value }), (error: unknown) => done({ ok: false, error }));
    } catch (error) {
      // check() 가 Promise 를 만들기도 전에 동기로 터지는 경우.
      done({ ok: false, error });
    }
  });
}

export function createRecoveryProbeRunner(opts: RecoveryProbeOptions): RecoveryProbeRunner {
  const byComponent = new Map<ComponentId, ProbeSchedule>();
  for (const s of opts.schedules) {
    if (!s || !s.probe || typeof s.probe.check !== 'function') {
      throw new Error('복구 프로브 설정 거부: check() 를 가진 프로브가 필요하다');
    }
    const c = s.probe.component;
    if (byComponent.has(c)) {
      // 둘 중 하나를 골라 주면 어느 쪽이 돌았는지 보고와 어긋난다.
      throw new Error(`복구 프로브 설정 거부: ${c} 컴포넌트 프로브가 중복 선언됐다`);
    }
    if (s.intervalMs !== undefined && (!Number.isFinite(s.intervalMs) || s.intervalMs <= 0)) {
      throw new Error(`복구 프로브 설정 거부: ${c} intervalMs 는 0보다 큰 수여야 한다`);
    }
    if (s.timeoutMs !== undefined && (!Number.isFinite(s.timeoutMs) || s.timeoutMs <= 0)) {
      throw new Error(`복구 프로브 설정 거부: ${c} timeoutMs 는 0보다 큰 수여야 한다`);
    }
    byComponent.set(c, s);
  }
  const required = opts.confirmSuccesses;
  if (required !== undefined && (!Number.isInteger(required) || required < 1)) {
    throw new Error('복구 프로브 설정 거부: confirmSuccesses 는 1 이상 정수여야 한다');
  }
  const scheduler = opts.scheduler ?? defaultScheduler;
  const lastRun = new Map<ComponentId, string>();
  const inFlight = new Set<ComponentId>();
  const streak = new Map<ComponentId, number>();

  async function attempt(sched: ProbeSchedule, nowIso: string, stateBefore: HealthState): Promise<ProbeAttemptReport> {
    const component = sched.probe.component;
    const base: ProbeAttemptReport = { component, ran: true, stateBefore };
    const startedAt = opts.monotonic ? opts.monotonic() : undefined;
    const r = await runWithLimit(sched.probe, sched.timeoutMs as number, scheduler);
    lastRun.set(component, nowIso);
    const latencyMs = startedAt !== undefined && opts.monotonic ? opts.monotonic() - startedAt : undefined;

    if (!r.ok) {
      const err = normalizeEngineError(ERROR_COMPONENT_OF[component], r.error);
      const verdict = classifyEngineFailure(err);
      streak.set(component, 0);
      if (!verdict.attributable) {
        // 승인 전·설정 오류·정체불명 — 엔진 상태로 적지 않는다(적으면 래치가 되돌아온다).
        return { ...base, notRecordedKo: maskPii(`엔진 탓으로 볼 수 없는 프로브 실패: ${err.code} · ${verdict.reasonKo}`).text };
      }
      const sample: HealthSample = {
        component, state: 'down', observedAt: nowIso,
        detail: maskPii(`복구 프로브 실패 · ${err.code} · ${verdict.reasonKo}`).text,
      };
      opts.registry.record(sample);
      return { ...base, recorded: sample };
    }

    const given = validSample(r.value, component);
    if (!given) {
      // 규약 위반 반환값은 **엔진에 대한 증거가 아니다** — 프로브 구현 결함이다.
      // `up` 으로 읽지 않는 것은 물론이고, `down` 으로도 적지 않는다: 적으면 프로브 버그 하나로
      // 채널이 영구 IVR 이 되고, 사후분석은 멀쩡한 엔진을 뒤지게 된다.
      // 기존 나쁜 상태는 그대로 남으므로 폴백은 유지된다(보수적) — 다만 사유를 드러낸다.
      streak.set(component, 0);
      return { ...base, notRecordedKo: '복구 프로브가 규약을 어긴 결과를 돌려줬다 — 엔진 상태로 읽지 않는다' };
    }

    // 프로브가 준 시각·detail 을 그대로 쓰되, 시각은 관측 시계로 통일한다(레지스트리의 늦은 도착 방어가 어긋나지 않게).
    const observed: HealthSample = {
      component,
      state: given.state,
      observedAt: nowIso,
      ...(given.errorRate === undefined ? {} : { errorRate: given.errorRate }),
      ...(given.latencyMs !== undefined ? { latencyMs: given.latencyMs } : latencyMs === undefined ? {} : { latencyMs }),
      ...(given.detail === undefined ? {} : { detail: maskPii(given.detail).text }),
    };

    if (observed.state !== 'up') {
      streak.set(component, 0);
      opts.registry.record(observed);
      return { ...base, recorded: observed };
    }

    const n = (streak.get(component) ?? 0) + 1;
    streak.set(component, n);
    if (required !== undefined && n < required) {
      // 아직 확인되지 않았다. **성공을 적지 않되, 성공했다는 사실은 보고에 남긴다.**
      return {
        ...base,
        confirm: { successes: n, required },
        notRecordedKo: `복구 확인 중 ${n}/${required} — 연속 성공이 필요하다`,
      };
    }
    opts.registry.record(observed);
    return { ...base, recorded: observed, ...(required === undefined ? {} : { confirm: { successes: n, required } }) };
  }

  async function runDue(nowArg?: string): Promise<RecoveryRunReport> {
    const nowIso = nowArg ?? opts.now();
    const nowMs = Date.parse(nowIso);
    const watch = opts.watch ?? [...byComponent.keys()];
    const targets = new Set<ComponentId>([...watch, ...byComponent.keys()]);

    const pending: Promise<ProbeAttemptReport>[] = [];
    const immediate: ProbeAttemptReport[] = [];
    const unprobed: ComponentId[] = [];

    for (const component of targets) {
      const stateBefore = effectiveComponentState(opts.registry.latest(component), opts.policy, nowIso);
      const bad = stateBefore === 'down' || stateBefore === 'degraded' || stateBefore === 'unknown';
      const sched = byComponent.get(component);
      if (!sched) {
        if (bad) unprobed.push(component);
        continue;
      }
      if (!bad) { immediate.push({ component, ran: false, skipped: 'healthy', stateBefore }); continue; }
      if (sched.intervalMs === undefined) { immediate.push({ component, ran: false, skipped: 'no_interval', stateBefore }); continue; }
      if (sched.timeoutMs === undefined) { immediate.push({ component, ran: false, skipped: 'no_timeout', stateBefore }); continue; }
      if (inFlight.has(component)) { immediate.push({ component, ran: false, skipped: 'in_flight', stateBefore }); continue; }
      const last = lastRun.get(component);
      if (last !== undefined && Number.isFinite(nowMs) && nowMs - Date.parse(last) < sched.intervalMs) {
        immediate.push({ component, ran: false, skipped: 'not_due', stateBefore });
        continue;
      }
      inFlight.add(component);
      // 프로브는 **동시에** 돈다. 순차로 돌리면 제한 시간이 프로브 수만큼 곱해지고,
      // 그동안 폴백이 풀리지 않는다.
      pending.push(
        attempt(sched, nowIso, stateBefore)
          .catch((e: unknown) => ({
            component, ran: true, stateBefore,
            notRecordedKo: maskPii(`프로브 실행 중 예외: ${e instanceof Error ? e.message : String(e)}`).text,
          } as ProbeAttemptReport))
          .finally(() => { inFlight.delete(component); }),
      );
    }

    const ran = await Promise.all(pending);
    const attempts = [...immediate, ...ran];
    return {
      at: nowIso,
      attempts,
      recovered: ran.filter((a) => a.recorded?.state === 'up').map((a) => a.component),
      unprobed,
    };
  }

  return { runDue, lastRunAt: (c) => lastRun.get(c) };
}

/**
 * 프로브를 붙이지 않은 채 운영에 올렸을 때 **무엇을 확인할 수 없는지**를 한 줄로 적는다.
 * 판단 점수·진행률을 만들지 않고 건수와 이름만 적는다(§13-3).
 */
export function formatRecoveryReport(r: RecoveryRunReport): string {
  const ran = r.attempts.filter((a) => a.ran);
  const lines = [
    `복구 프로브 ${r.at}: 실행 ${ran.length}건 · 건너뜀 ${r.attempts.length - ran.length}건`,
  ];
  for (const a of ran) {
    const what = a.recorded ? `${a.recorded.state} 기록` : (a.notRecordedKo ?? '기록 없음');
    lines.push(`  - ${a.component}: ${a.stateBefore} → ${what}`);
  }
  if (r.recovered.length > 0) lines.push(`  복구 확인: ${r.recovered.join(', ')}`);
  if (r.unprobed.length > 0) {
    lines.push(`  프로브 없음(복구를 확인할 길이 없다): ${r.unprobed.join(', ')} [승인 필요]`);
  }
  return lines.join('\n');
}
