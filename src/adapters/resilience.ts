// 엔진 호출 복원력 — 설계서 §9.3(장애 폴백)·§6.2(엔진 비종속)·§10.3(마스킹·국외이전)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// §9.3 폴백 판정기(`ops/fallback.ts`)는 이미 있다. 그런데 그 판정의 입력인 `HealthSample` 을
// **아무도 만들지 않았다** — 지금은 호스트가 브리지 `health` op 로 직접 선언할 때만 들어온다.
// 정작 엔진의 상태를 가장 먼저, 가장 정확하게 아는 곳은 **방금 그 엔진을 부른 자리**인데
// 그 관측을 버리고 있었던 셈이다. 그래서 호출부에서 나온 사실(성공·타임아웃·5xx·규격위반)을
// 그대로 샘플로 바꾸고, 재시도·대체엔진 판단까지 한 곳에서 한다.
// 이 판단을 채널 저장소마다 각자 짜면 각자 다르게 틀린다(그리고 대개 "실패하면 무조건 재시도"로 틀린다).
//
// 이 모듈이 **하지 않는 것**:
//  - 재시도 횟수·대기 시간의 권장값을 만들지 않는다(§13-3). 회선·엔진·계약마다 다르다.
//    주지 않으면 재시도하지 않고, 종전과 동작이 완전히 같다.
//  - 한 번 실패했다고 `down` 으로 적지 않는다. 재시도와 대체엔진까지 **전부** 실패해야 down 이다.
//    한 번의 타임아웃으로 down 을 적으면 통화 전체가 IVR 로 내려간다 — 폴백이 장애를 만드는 셈이다.
//  - **우리 잘못을 엔진 탓으로 적지 않는다.** 승인 전 호출(E_APPROVAL_REQUIRED)·빈 입력·설정 오류는
//    샘플을 남기지 않는다. 승인 안 받았다는 이유로 엔진이 죽은 것으로 집계되면, 켜 보기도 전에
//    전 채널이 상담사 직결로 떨어진다.
//  - **콘텐츠 필터를 대체엔진으로 우회하지 않는다.** 필터에 걸린 응답은 장애가 아니다.
import type { AudioChunk, EmbeddingAdapter, EngineSet, LlmAdapter, LlmMessage, SttAdapter, SttResult, TtsAdapter } from './index.ts';
import type { EngineErrorCode } from './http.ts';
import { EngineError } from './http.ts';
import type { ComponentId, HealthSample } from '../ops/fallback.ts';
import { maskPii } from '../core/policyGuard.ts';

export type EngineCallComponent = 'stt' | 'tts' | 'llm' | 'embedding';

/**
 * 엔진 컴포넌트 → §9.3 헬스 컴포넌트.
 * 임베딩을 `rag`(L3)로 둔 것은 해석이며 근거가 있다: 임베딩이 죽으면 잃는 것은 "답변 근거"이지
 * 대화 능력이 아니다. L2 로 올리면 임베딩 하나 때문에 통화가 통째로 IVR 로 내려간다.
 */
export const HEALTH_COMPONENT_OF: Record<EngineCallComponent, ComponentId> = {
  stt: 'stt',
  tts: 'tts',
  llm: 'llm',
  embedding: 'rag',
};

export type FailureClass =
  | 'engine_unavailable'   // 엔진이 응답하지 못함(타임아웃·5xx·429)
  | 'engine_bad_response'  // 응답은 왔지만 규격 위반
  | 'content_filtered'     // 엔진 콘텐츠 필터 — 장애가 아니다
  | 'caller_fault'         // 우리 요청·설정이 틀림(4xx·빈 입력·상한 초과)
  | 'not_activated'        // 승인 전 호출 시도
  | 'indeterminate';       // 정체불명 예외 — 엔진 탓으로 돌리지 않는다

export interface FailureVerdict {
  failureClass: FailureClass;
  /** 같은 엔진에 다시 걸어 볼 가치가 있는가. */
  retryable: boolean;
  /** 대체 엔진으로 넘길 가치가 있는가. */
  failover: boolean;
  /** 엔진 상태로 집계해도 되는가(=헬스 샘플을 남길 것인가). */
  attributable: boolean;
  reasonKo: string;
}

/** 다시 걸어 볼 가치가 있는 HTTP 상태. 4xx 대부분은 다시 걸어도 같은 답이 온다. */
export const RETRYABLE_HTTP_STATUS: readonly number[] = [408, 425, 429, 500, 502, 503, 504];

function statusOf(err: EngineError): number | undefined {
  const s = (err.detail as { status?: unknown }).status;
  return typeof s === 'number' && Number.isFinite(s) ? s : undefined;
}

/** 정체불명 예외를 EngineError 로 정규화한다. 코드는 `E_UNKNOWN` 이며 **엔진 장애로 집계되지 않는다**. */
export function normalizeEngineError(component: EngineError['component'], thrown: unknown): EngineError {
  if (thrown instanceof EngineError) return thrown;
  const raw = thrown instanceof Error ? thrown.message : typeof thrown === 'string' ? thrown : '';
  // 원문에 발화·번호가 섞여 들어올 수 있다. 저장 경로 한 곳에서 마스킹한다(§10.3).
  const msg = raw ? maskPii(raw).text : '메시지 없음';
  return new EngineError('E_UNKNOWN', component, `정체불명 예외: ${msg}`, {});
}

/** 실패 1건의 성격 판정. 순수 함수 — 여기서 재시도·대체·집계 여부가 전부 갈린다. */
export function classifyEngineFailure(err: EngineError): FailureVerdict {
  const code: EngineErrorCode = err.code;
  switch (code) {
    case 'E_TIMEOUT':
      return { failureClass: 'engine_unavailable', retryable: true, failover: true, attributable: true, reasonKo: '응답 시간 초과' };
    case 'E_HTTP': {
      const status = statusOf(err);
      if (status !== undefined && RETRYABLE_HTTP_STATUS.includes(status)) {
        return { failureClass: 'engine_unavailable', retryable: true, failover: true, attributable: true, reasonKo: `엔진 응답 ${status}` };
      }
      // 상태를 모르면 재시도하지 않는다 — 모르는 것을 일시 장애로 가정하면 400 을 무한히 다시 던진다.
      return {
        failureClass: 'caller_fault', retryable: false, failover: false, attributable: false,
        reasonKo: status === undefined ? '엔진 응답 상태 미상 — 재시도하지 않는다' : `엔진 응답 ${status} — 요청 쪽 문제`,
      };
    }
    case 'E_PROTOCOL':
      // 다시 걸어도 같은 규격 위반이 온다. 다만 **다른 엔진은 규격을 지킬 수 있으므로** 대체는 시도한다.
      return { failureClass: 'engine_bad_response', retryable: false, failover: true, attributable: true, reasonKo: '응답 규격 위반' };
    case 'E_FILTERED':
      return { failureClass: 'content_filtered', retryable: false, failover: false, attributable: false, reasonKo: '엔진 콘텐츠 필터 — 다른 엔진으로 우회하지 않는다' };
    case 'E_APPROVAL_REQUIRED':
      return { failureClass: 'not_activated', retryable: false, failover: false, attributable: false, reasonKo: '승인 전 호출 — 장애가 아니다 [승인 필요]' };
    case 'E_CONFIG':
      return { failureClass: 'caller_fault', retryable: false, failover: false, attributable: false, reasonKo: '설정 오류 — 대체 엔진으로 가리지 않는다' };
    case 'E_INPUT':
      return { failureClass: 'caller_fault', retryable: false, failover: false, attributable: false, reasonKo: '호출 전 입력 거절' };
    case 'E_LIMIT':
      return { failureClass: 'caller_fault', retryable: false, failover: false, attributable: false, reasonKo: '입력 상한 초과' };
    default:
      return { failureClass: 'indeterminate', retryable: false, failover: false, attributable: false, reasonKo: '정체불명 실패 — 엔진 상태로 집계하지 않는다' };
  }
}

export interface EngineCandidate<E> {
  name: string;
  residency: 'domestic' | 'onprem' | 'overseas';
  target: E;
}

export interface EngineAttempt {
  candidate: string;
  /** 전체 시도 순번(1부터). 후보가 바뀌어도 이어진다 — 로그에서 순서를 복원할 수 있게. */
  seq: number;
  ok: boolean;
  code?: EngineErrorCode;
  failureClass?: FailureClass;
  reasonKo?: string;
  /** monotonic 시계를 주입했을 때만 채운다. 없으면 만들지 않는다(§13-3). */
  elapsedMs?: number;
}

export interface ResilientOutcome<T> {
  ok: boolean;
  value?: T;
  /** 최종 실패 원인. 삼키지 않는다(§9.3). */
  error?: EngineError;
  usedCandidate?: string;
  attempts: EngineAttempt[];
  /** 국외이전 금지 등으로 **부르지도 않은** 후보. 조용히 빠뜨리지 않는다(§10.3). */
  skipped: { candidate: string; reasonKo: string }[];
  /** 시계(now)를 주입했고 엔진 탓으로 볼 수 있을 때만 만든다. */
  health?: HealthSample;
}

export interface ResilienceConfig {
  /** 후보 1개당 최대 시도 횟수(1 이상 정수). 1 이면 재시도하지 않는다. 기본값 없음(§13-3). */
  attemptsPerCandidate: number;
  /** 재시도 전 대기(ms). seq(1부터)를 받는다. 주지 않으면 attemptsPerCandidate 는 1 이어야 한다. */
  backoffMs?: (seq: number) => number;
  /** §10.3 — 국외이전 금지 테넌트에서 해외 엔진 후보는 부르지 않는다. */
  allowOverseas: boolean;
  /** 대기 구현. 테스트 결정성을 위해 주입 가능(기본은 타이머 — 정책값이 아니라 수단이다). */
  sleep?: (ms: number) => Promise<void>;
  /** 관측 시각(ISO8601). 주입하지 않으면 헬스 샘플을 만들지 않는다 — 없는 시각을 지어내지 않는다(§13-3). */
  now?: () => string;
  /** 소요 실측용 단조 시계(ms). 주입하지 않으면 latencyMs 를 채우지 않는다. */
  monotonic?: () => number;
  /** 헬스 레지스트리 기록 훅. 주입하면 샘플이 만들어질 때마다 넘긴다. */
  record?: (sample: HealthSample) => void;
  /**
   * **재시도·대체로 되살아난 호출**을 어떤 상태로 적을 것인가.
   * 선언하지 않으면 `up` 이다. 이유: `degraded` 샘플 하나는 `decideFallbackMode` 에서
   * 곧바로 `degraded_ai` 가 되고, STT 면 `speech_recognition` 이 꺼진다 — 음성 채널에서
   * **고객이 말을 못 하게 된다**. 한 번의 복구로 그 대가를 치를지는 테넌트가 정할 일이지
   * Core 가 정할 일이 아니다(§9.3·§13-3). 복구 사실 자체는 어느 쪽이든 `detail` 과
   * `attempts` 에 남으므로 신호가 사라지지는 않는다.
   */
  recoveryState?: 'up' | 'degraded';
}

const timerSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

function assertConfig(cfg: ResilienceConfig): void {
  const n = cfg.attemptsPerCandidate;
  if (!Number.isInteger(n) || n < 1) {
    throw new EngineError('E_CONFIG', 'config', `attemptsPerCandidate 는 1 이상 정수여야 한다: ${String(n)}`);
  }
  if (n > 1 && !cfg.backoffMs) {
    // 간격 없는 재시도는 힘들어하는 엔진을 더 밀어붙인다. 그렇다고 Core 가 "권장 300ms"를 정할 근거도 없다(§13-3).
    throw new EngineError('E_CONFIG', 'config', '재시도를 켜려면 backoffMs 를 함께 주어야 한다 — Core 는 대기 시간을 정하지 않는다(§13-3)');
  }
}

/** 후보 목록에서 호출 가능한 것만 남긴다. 제외는 결과에 드러낸다(§10.3). */
export function selectCandidates<E>(
  candidates: EngineCandidate<E>[],
  allowOverseas: boolean,
): { usable: EngineCandidate<E>[]; skipped: { candidate: string; reasonKo: string }[] } {
  const usable: EngineCandidate<E>[] = [];
  const skipped: { candidate: string; reasonKo: string }[] = [];
  for (const c of candidates) {
    if (!allowOverseas && c.residency === 'overseas') {
      skipped.push({ candidate: c.name, reasonKo: '국외이전 불가 테넌트 — 해외 엔진은 부르지 않는다(§10.3)' });
      continue;
    }
    usable.push(c);
  }
  return { usable, skipped };
}

/** 노출도가 가장 높은 residency 를 고른다. 대체 엔진을 섞어 놓고 "국내"라고 적으면 §10.3 가드가 무력해진다. */
export function widestResidency(values: ('domestic' | 'onprem' | 'overseas')[]): 'domestic' | 'onprem' | 'overseas' {
  if (values.includes('overseas')) return 'overseas';
  if (values.includes('domestic')) return 'domestic';
  return 'onprem';
}

export interface ResilientCaller {
  run<E, T>(
    component: EngineCallComponent,
    candidates: EngineCandidate<E>[],
    fn: (target: E, candidate: EngineCandidate<E>) => Promise<T>,
  ): Promise<ResilientOutcome<T>>;
}

/**
 * 재시도·대체엔진·헬스 집계를 한 곳에 모은 호출기.
 * **설정 오류는 던지고, 엔진 실패는 결과로 돌려준다.** 형태가 틀린 설정을 통과로 두면
 * 오타 하나로 재시도가 조용히 꺼진 채 "적용했다"로 남는다(제한기에서 이미 겪은 실패다).
 */
export function createResilientCaller(cfg: ResilienceConfig): ResilientCaller {
  assertConfig(cfg);
  const sleep = cfg.sleep ?? timerSleep;
  const run = async <E, T>(
    component: EngineCallComponent,
    candidates: EngineCandidate<E>[],
    fn: (target: E, candidate: EngineCandidate<E>) => Promise<T>,
  ): Promise<ResilientOutcome<T>> => {
    const { usable, skipped } = selectCandidates(candidates, cfg.allowOverseas);
    if (candidates.length === 0) {
      throw new EngineError('E_CONFIG', 'config', '엔진 후보가 비어 있다 — 무엇을 부를지 선언해야 한다');
    }
    if (usable.length === 0) {
      throw new EngineError('E_CONFIG', 'config', `호출 가능한 엔진 후보가 없다: ${skipped.map((s) => s.candidate).join(', ')}`, { skipped });
    }

    const attempts: EngineAttempt[] = [];
    let seq = 0;
    let lastError: EngineError | undefined;

    for (let ci = 0; ci < usable.length; ci += 1) {
      const cand = usable[ci]!;
      for (let a = 0; a < cfg.attemptsPerCandidate; a += 1) {
        seq += 1;
        if (seq > 1 && cfg.backoffMs) {
          const wait = cfg.backoffMs(seq);
          if (!Number.isFinite(wait) || wait < 0) {
            throw new EngineError('E_CONFIG', 'config', `backoffMs 가 유효한 대기(ms)를 돌려주지 않았다: ${String(wait)}`);
          }
          if (wait > 0) await sleep(wait);
        }
        const startedAt = cfg.monotonic ? cfg.monotonic() : undefined;
        try {
          const value = await fn(cand.target, cand);
          const elapsedMs = startedAt !== undefined && cfg.monotonic ? cfg.monotonic() - startedAt : undefined;
          attempts.push({ candidate: cand.name, seq, ok: true, ...(elapsedMs === undefined ? {} : { elapsedMs }) });
          return finish({ ok: true, value, usedCandidate: cand.name, attempts, skipped }, component, cfg);
        } catch (thrown) {
          const err = normalizeEngineError(component, thrown);
          const verdict = classifyEngineFailure(err);
          const elapsedMs = startedAt !== undefined && cfg.monotonic ? cfg.monotonic() - startedAt : undefined;
          attempts.push({
            candidate: cand.name, seq, ok: false, code: err.code,
            failureClass: verdict.failureClass, reasonKo: verdict.reasonKo,
            ...(elapsedMs === undefined ? {} : { elapsedMs }),
          });
          lastError = err;
          if (!verdict.retryable) {
            // 이 후보에서 더 해 볼 것이 없다. 대체로 넘길지는 성격이 정한다.
            if (!verdict.failover) return finish({ ok: false, error: err, attempts, skipped }, component, cfg);
            break;
          }
        }
      }
    }
    return finish({ ok: false, error: lastError, attempts, skipped }, component, cfg);
  };
  return { run };
}

function finish<T>(
  partial: Omit<ResilientOutcome<T>, 'health'>,
  component: EngineCallComponent,
  cfg: ResilienceConfig,
): ResilientOutcome<T> {
  const health = healthFromOutcome(component, partial, {
    ...(cfg.now ? { now: cfg.now } : {}),
    measured: cfg.monotonic !== undefined,
    ...(cfg.recoveryState ? { recoveryState: cfg.recoveryState } : {}),
  });
  if (health && cfg.record) cfg.record(health);
  return health ? { ...partial, health } : { ...partial };
}

export interface HealthFromOutcomeOptions {
  /** 관측 시각. 없으면 샘플을 만들지 않는다(§13-3). */
  now?: () => string;
  /** 소요를 실제로 쟀는가. 재지 않았으면 latencyMs 를 채우지 않는다. */
  measured?: boolean;
  /** 재시도·대체로 복구된 호출의 상태. 선언하지 않으면 `up`(위 ResilienceConfig 주석 참조). */
  recoveryState?: 'up' | 'degraded';
}

/**
 * 호출 결과 1건을 §9.3 헬스 샘플로 바꾼다.
 *  - 성공 + 실패 시도 없음 → up
 *  - 성공 + 중간 실패 있음 → `recoveryState`(선언 안 하면 up). 복구 사실은 detail 에 남는다.
 *  - 전 시도·전 후보 실패 + 엔진 탓 → down
 *  - 우리 잘못·승인 전·정체불명 → **샘플 없음**
 * `errorRate` 는 만들지 않는다 — 한 번의 호출에서 실패율을 계산할 수 없다(§13-3).
 */
export function healthFromOutcome<T>(
  component: EngineCallComponent,
  outcome: Omit<ResilientOutcome<T>, 'health'>,
  opts: HealthFromOutcomeOptions = {},
): HealthSample | undefined {
  const { now, measured = false, recoveryState = 'up' } = opts;
  if (!now) return undefined;
  const failed = outcome.attempts.filter((a) => !a.ok);
  if (outcome.ok) {
    const attributableFailures = failed.filter((a) => a.failureClass === 'engine_unavailable' || a.failureClass === 'engine_bad_response');
    const last = outcome.attempts[outcome.attempts.length - 1];
    const latencyMs = measured && last && last.ok ? last.elapsedMs : undefined;
    return {
      component: HEALTH_COMPONENT_OF[component],
      state: attributableFailures.length > 0 ? recoveryState : 'up',
      observedAt: now(),
      ...(latencyMs === undefined ? {} : { latencyMs }),
      detail: maskPii(
        attributableFailures.length > 0
          ? `재시도로 복구 · 실패 ${attributableFailures.length}회 · 사용 ${outcome.usedCandidate ?? '미상'}`
          : `정상 · 사용 ${outcome.usedCandidate ?? '미상'}`,
      ).text,
    };
  }
  const verdict = outcome.error ? classifyEngineFailure(outcome.error) : undefined;
  if (!verdict || !verdict.attributable) return undefined;
  return {
    component: HEALTH_COMPONENT_OF[component],
    state: 'down',
    observedAt: now(),
    detail: maskPii(`시도 ${outcome.attempts.length}회 전부 실패 · 마지막 ${outcome.error?.code ?? '미상'} · ${verdict.reasonKo}`).text,
  };
}

// ── §6.2 인터페이스를 그대로 유지한 채 감싸기 ───────────────────────────────────
//
// 스트리밍(STT·TTS·LLM)에서 재시도가 안전한 구간은 **첫 청크를 내보내기 전까지**다.
// 이미 "안녕하세요 고객님, 조회 결과는"까지 재생된 뒤에 재시도하면 고객은 같은 말을 두 번 듣는다.
// 그래서 첫 청크 이후의 실패는 재시도·대체 없이 그대로 드러낸다(§9.3 — 삼키지 않는다).
export interface ResilientEngineOptions {
  caller: ResilientCaller;
}

async function* replay<T>(first: T, rest: AsyncIterator<T>): AsyncIterable<T> {
  yield first;
  for (;;) {
    const n = await rest.next();
    if (n.done) return;
    yield n.value;
  }
}

/** 첫 청크가 나올 때까지만 복원력을 적용한다. 첫 청크 확보에 실패하면 최종 오류를 던진다. */
async function firstChunkGuarded<E, T>(
  caller: ResilientCaller,
  component: EngineCallComponent,
  candidates: EngineCandidate<E>[],
  open: (target: E) => AsyncIterable<T>,
): Promise<AsyncIterable<T>> {
  const outcome = await caller.run(component, candidates, async (target) => {
    const it = open(target)[Symbol.asyncIterator]();
    const first = await it.next();
    return { it, first };
  });
  if (!outcome.ok || !outcome.value) {
    throw outcome.error ?? new EngineError('E_UNKNOWN', component, '엔진 호출이 값을 돌려주지 않았다');
  }
  const { it, first } = outcome.value;
  if (first.done) return (async function* empty() { /* 빈 스트림 — 지어내지 않는다 */ })();
  return replay(first.value, it);
}

/**
 * 후보 엔진셋들을 하나의 EngineSet 으로 합친다. 상위 계층은 §6.2 인터페이스만 보므로
 * 재시도·대체가 붙었다는 사실을 몰라도 된다. `residency` 는 **가장 노출도가 높은 후보**로 적는다 —
 * 해외 후보를 섞어 놓고 '국내'로 적으면 `assertResidency` 가 무력해진다(§10.3).
 */
export function withResilientEngines(
  candidates: EngineCandidate<EngineSet>[],
  opts: ResilientEngineOptions,
): EngineSet {
  if (candidates.length === 0) {
    throw new EngineError('E_CONFIG', 'config', '엔진 후보가 비어 있다 — 무엇을 부를지 선언해야 한다');
  }
  const { caller } = opts;
  const name = `resilient(${candidates.map((c) => c.name).join('>')})`;
  const residency = widestResidency(candidates.map((c) => c.residency));
  const pick = <K extends keyof EngineSet>(key: K): EngineCandidate<NonNullable<EngineSet[K]>>[] =>
    candidates
      .filter((c) => c.target[key] !== undefined)
      .map((c) => ({ name: c.name, residency: c.residency, target: c.target[key] as NonNullable<EngineSet[K]> }));

  const stt: SttAdapter = {
    name, residency,
    stream(audio: AsyncIterable<AudioChunk>): AsyncIterable<SttResult> {
      const cands = pick('stt');
      return (async function* run() {
        yield* await firstChunkGuarded(caller, 'stt', cands, (t) => t.stream(audio));
      })();
    },
  };
  const tts: TtsAdapter = {
    name, residency,
    synthesize(text: string, voice?: string): AsyncIterable<AudioChunk> {
      const cands = pick('tts');
      return (async function* run() {
        yield* await firstChunkGuarded(caller, 'tts', cands, (t) => t.synthesize(text, voice));
      })();
    },
  };
  const llm: LlmAdapter = {
    name, residency,
    complete(messages: LlmMessage[], tools?: unknown[]): AsyncIterable<string> {
      const cands = pick('llm');
      return (async function* run() {
        yield* await firstChunkGuarded(caller, 'llm', cands, (t) => t.complete(messages, tools));
      })();
    },
  };
  const embeddingCands = pick('embedding');
  const embedding: EmbeddingAdapter | undefined = embeddingCands.length === 0 ? undefined : {
    name, residency,
    async embed(texts: string[]): Promise<number[][]> {
      // 임베딩은 한 번의 요청·응답이라 중간 상태가 없다 — 전 구간 재시도가 안전하다.
      const outcome = await caller.run('embedding', embeddingCands, async (t) => t.embed(texts));
      if (!outcome.ok || !outcome.value) {
        throw outcome.error ?? new EngineError('E_UNKNOWN', 'embedding', '엔진 호출이 값을 돌려주지 않았다');
      }
      return outcome.value;
    },
  };
  return embedding ? { stt, tts, llm, embedding } : { stt, tts, llm };
}
