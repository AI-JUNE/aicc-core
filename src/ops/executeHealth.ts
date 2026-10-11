// readiness 실행기 — 설계서 §9.3(장애 인지·폴백)·§13(운영·모니터링)·§10.3(민감정보 미노출)·
// §13-3(실측만)·§2(판정 단일화)·§6.2(엔진 종속 코드 금지).
//
// 왜 이 파일이 필요한가:
// `ops/health.ts` 는 `COMMERCIAL_READINESS.md` 에 `[x]` 로 적혀 있는데, 저장소 전체에서
// `checkHealth`·`approvalPendingProbe` 를 부르는 곳은 **자기 테스트뿐이다**. 즉 liveness/readiness
// 분리·프로브 병렬·개별 예산을 다 만들어 놓고 **그것으로 응답을 만드는 자리가 Core 에 없다**.
// 그 자리는 호스트가 각자 채우게 되고, 거기서 빠지는 것은 취향이 아니라 정해져 있다.
//
//  (가) **§9.3 폴백 상태가 응답에 닿지 않는다.** 호스트가 /health 를 직접 짜면 거기 들어가는
//      것은 DB·캐시·엔진 접속 프로브다. 그런데 그 프로브가 전부 초록인데 §9.3 판정이
//      `agent_only` 인 상태는 드문 경우가 아니다 — STT 가 규격 위반을 돌려주기 시작하면
//      엔진 HTTP 는 200 을 주면서도 음성 인식은 안 된다. 그 순간 **모든 통화가 상담사 직결로
//      떨어지는데 /health 는 `up`·200 이고 대시보드는 초록이다.** AI 가 한 통도 응대하지
//      않는다는 사실을 운영은 고객 전화가 밀린 뒤에 알게 된다. 폴백 상태를 아는 곳은
//      `HealthRegistry` + `FallbackPolicy` 를 가진 Core 뿐이므로, 그 사실을 응답에 싣는 자리가
//      여기다. 판정을 다시 하지는 않는다 — 모드는 `decideFallbackMode` 하나다(§2).
//
//  (나) **그 사실로 503 을 낸다.** 가장 자연스러운 반응이고 **가장 비싼 실패**다. STT 가 죽어도
//      이 프로세스는 여전히 일해야 한다 — 상담사 이관·IVR 내림·화면 전환이 전부 이 프로세스를
//      지난다(§9.3 의 폴백 경로가 바로 그것이다). 503 을 내면 로드밸런서가 인스턴스를 빼고,
//      그러면 **폴백 자체가 죽는다**. 엔진 하나의 장애가 전면 장애로 승격되고 고객은 상담사로도
//      못 간다. 그래서 Core 가 싣는 항목은 **어떤 경우에도 `critical: false`** 이고(호스트가
//      올릴 수 없다) 폴백 모드는 `httpStatus` 를 바꾸지 않는다. 필수/부가 구분은 호스트
//      프로브에만 있다 — 무엇이 없으면 서비스가 성립하지 않는지는 Core 가 알 수 없다(§6.2).
//
//  (다) **미관측을 정상으로 적는다.** 샘플이 없는 컴포넌트를 `up` 으로 적으면 **한 번도 신호를
//      올리지 않는 채널**이 가장 건강해 보인다(`runtime.reportHealth` 가 버린 보고와 같은 모양의
//      실패다). 반대로 일률적으로 `down` 으로 적으면 방금 띄운 인스턴스가 샘플이 쌓이기 전까지
//      장애로 보여 **배포가 롤아웃되지 않는다**. 그래서 `unknown` 은 `degraded` + "모른다"다.
//      다만 **낡음 판정과 미관측 해석을 여기서 하지 않는다** — `effectiveComponentState` 하나이며
//      (§2, `recoveryProbe.ts` 가 같은 이유로 그 함수를 쓴다), 테넌트가 `treatUnknownAsDown` 을
//      켜 뒀으면 그 결과를 그대로 적고 **그것이 관측이 아니라 정책의 결과라는 사실**을 남긴다.
//
//  (라) **승인 전 엔진을 장애로 적는다.** `adapters/resilience.ts`·`ops/recoveryProbe.ts` 가 이미
//      같은 결론에 이른 자리다 — 승인을 안 받았다는 이유로 엔진이 죽은 것으로 집계되면 **켜 보기도
//      전에 영구 장애**다. 활성화 전으로 선언된 컴포넌트는 **샘플을 읽지 않는다**(dry_run 어댑터가
//      올린 샘플은 실엔진 관측이 아니다 — 그것을 `up` 으로 실으면 켜지지도 않은 엔진이 정상으로
//      보고된다). 판정은 `approvalPendingProbe` 가 고른 `degraded` 를 그대로 쓴다. 선언해 놓고
//      샘플이 올라오는 모순은 숨기지 않고 드러낸다 **[승인 필요]**.
//
//  (마) **detail 에 접속 문자열·개인정보가 실린다.** `HealthSample.detail` 은 호스트가 채우는
//      자유 문자열이고 /health 는 사실상 공개 엔드포인트다. 그래서 `sanitizeDetail` 을 지난다 —
//      마스킹 규칙 사본을 여기 두지 않는다(§2·§10.3). 모르는 컴포넌트·채널 이름을 되돌려줄 때도
//      같은 관문을 지난다(호스트가 거기에 호 ID 를 넣는 경우가 있다).
//
//  (바) **찌르지 않은 것에 소요를 적는다.** 컴포넌트 항목은 레지스트리를 **읽은** 것이지 점검한
//      것이 아니므로 `durationMs`·`code` 를 만들지 않는다(§13-3). 가용률·평균도 만들지 않는다 —
//      이 파일이 아는 것은 컴포넌트별 마지막 샘플 1건뿐이다.
//
// 무엇을 하지 않는가:
//  - **점검을 구현하지 않는다**(§6.2). 프로브는 호스트가 주입한다 — 실연결은 **[승인 필요]**.
//  - **판정을 복사하지 않는다**(§2): 상태 해석은 `effectiveComponentState`, 폴백 모드는
//    `decideFallbackMode`, AI 응대 가능 여부는 `aiResponseAllowed`, 전체 집계는 `aggregateStatus`,
//    HTTP 상태는 `httpStatusFor`, 요약 문장은 `summarizeDependencies` 하나다.
//  - **던지지 않는다.** 헬스체크가 예외로 죽으면 그 자체가 장애이고, 하필 장애 조사 중에 죽는다.
//  - **저장하지 않는다.** 샘플을 기록하는 것은 `runtime.reportHealth`·`recoveryProbe` 다.
//  - **선언하지 않으면 종전과 완전히 같다**(§13-3) — `core` 를 주지 않으면 `checkHealth` 결과
//    그대로이고 `core` 필드 자체가 없다(빈 객체는 "관측했고 비었다"로 읽힌다).
import type { ChannelKind } from '../domain/types.ts';
import type {
  ComponentId, EngineTier, FallbackDecision, FallbackMode, FallbackPolicy,
  HealthRegistry, HealthSample, HealthState,
} from './fallback.ts';
import {
  CHANNEL_DEPENDENCIES, COMPONENT_TIER, aiResponseAllowed, decideFallbackMode, effectiveComponentState,
} from './fallback.ts';
import type {
  BuildInfo, DependencyKind, DependencyProbe, DependencyResult, HealthReport, HealthStatus, Scheduler,
} from './health.ts';
import {
  aggregateStatus, approvalPendingProbe, checkHealth, httpStatusFor,
  sanitizeBuild, sanitizeDetail, summarizeDependencies,
} from './health.ts';

export const HEALTH_EXECUTION_CONTRACT_VERSION = 1;

/**
 * Core 관측 항목에 붙는 이름 접두. **호스트가 고를 수 없다** — 호스트 프로브와 이름이 겹치면
 * 대시보드에서 서로를 덮어써 장애를 놓치고(그 사실은 `checkHealth` 가 중복으로 표시한다),
 * 무엇보다 "Core 가 관측한 상태"와 "호스트가 찔러 본 결과"가 구분되지 않는다.
 */
export const CORE_DEPENDENCY_PREFIX = 'core:';

/** 컴포넌트 → 의존성 종류. 대시보드가 종류로 묶으므로 한 곳에서 정한다. */
export const COMPONENT_DEPENDENCY_KIND: Record<ComponentId, DependencyKind> = {
  telephony: 'external_api',
  messaging: 'external_api',
  stt: 'engine',
  tts: 'engine',
  llm: 'engine',
  rag: 'engine',
  backend: 'external_api',
};

export const UNKNOWN_DETAIL_KO =
  '관측 샘플이 없거나 낡아 상태를 모른다 — 정상으로도 장애로도 적지 않는다';
export const POLICY_DOWN_DETAIL_KO =
  '관측이 아니라 정책 판정이다 — 미관측·낡은 샘플을 장애로 보는 테넌트 설정(treatUnknownAsDown)';
export const APPROVAL_PENDING_SAMPLE_DETAIL_KO =
  '활성화 전으로 선언됐는데 샘플이 올라오고 있다 — 실엔진 관측이 아니다';
export const CORE_NEVER_CRITICAL_KO =
  'Core 관측 항목은 필수(critical)로 올리지 않는다 — 폴백 경로가 이 프로세스를 지나므로 503 으로 인스턴스를 빼면 상담사 이관·IVR 내림까지 같이 죽는다 (설계서 §9.3)';
export const NO_COMPONENTS_DECLARED_KO =
  'readiness 에 실을 컴포넌트가 선언되지 않았다 — 엔진·매체 상태는 점검되지 않았다';
export const NO_CHANNELS_DECLARED_KO =
  '채널이 선언되지 않아 §9.3 폴백 모드를 판정하지 않았다';
export const CORE_STATE_UNREADABLE_KO =
  'Core 상태를 읽지 못했다 — 우리 쪽 결함은 엔진에 대한 증거가 아니므로 장애로도 정상으로도 적지 않는다';
export const PROBE_RUN_FAILED_KO =
  '호스트 프로브 실행 자체가 실패했다 — 의존성 점검 결과가 없다';

const KNOWN_COMPONENTS = new Set<string>(Object.keys(COMPONENT_TIER));
const KNOWN_CHANNELS = new Set<string>(Object.keys(CHANNEL_DEPENDENCIES));
const MAX_LABEL_LEN = 40;

/** Core 가 아는 사실. 레지스트리·정책·선언 목록 전부 호스트(런타임)가 가진 것을 그대로 받는다. */
export interface CoreHealthFacts {
  /** 관측 시각(ISO8601, 오프셋 명시). Core 가 만들지 않는다(§13-3). */
  nowIso: string;
  registry: HealthRegistry;
  policy: FallbackPolicy;
  /**
   * readiness 에 실을 컴포넌트. **Core 가 목록을 만들지 않는다** — 채널 등록에서 선언된
   * 것만 싣는다. 선언하지 않은 컴포넌트를 전부 실으면 쓰지도 않는 엔진이 영구 `unknown` 으로
   * 남아 대시보드가 상시 노랑이 되고, 그러면 진짜 저하를 아무도 보지 않는다.
   */
  components: readonly ComponentId[];
  /** 아직 활성화하지 않은 컴포넌트(위 (라)). 샘플을 읽지 않는다 **[승인 필요]**. */
  approvalPending?: readonly ComponentId[];
  /** §9.3 폴백 모드를 판정할 채널. 선언하지 않으면 판정하지 않고 그 사실을 적는다(§13-3). */
  channels?: readonly ChannelKind[];
}

export interface CoreComponentFact {
  component: ComponentId;
  tier: EngineTier;
  /** 정책을 반영한 현재 상태. 판정은 `effectiveComponentState` 하나다(§2). */
  state: HealthState;
  /** 마지막 관측 시각. 샘플이 없거나 시각 형태가 아니면 비운다 — 만들지 않는다(§13-3). */
  observedAt?: string;
  /** 관측된 실패율·지연. 실측만 싣는다(§13-3). */
  errorRate?: number;
  latencyMs?: number;
  /** 활성화 전으로 선언돼 샘플을 읽지 않았다는 표시. */
  approvalPending?: boolean;
}

export interface CoreFallbackFact {
  channel: ChannelKind;
  mode: FallbackMode;
  reasonKo: string;
  /** AI 응대가 가능한가. 판정은 `aiResponseAllowed` 하나다(§2). */
  aiAllowed: boolean;
  disable: FallbackDecision['disable'];
}

export interface CoreReadinessFacts {
  components: CoreComponentFact[];
  fallback: CoreFallbackFact[];
  /** 사람이 먼저 읽을 한 줄. 지어낸 수치 없이 건수와 열거값만 적는다(§13-3). */
  summaryKo: string;
  /** 검사하지 못한 범위·형태 오류. 숨기지 않는다. */
  warningsKo: string[];
}

export interface CoreReadinessReport extends HealthReport {
  /** 선언하지 않으면 **필드 자체가 없다**(빈 객체는 "관측했고 비었다"로 읽힌다, §13-3). */
  core?: CoreReadinessFacts;
}

export interface ReadinessOptions {
  /** 호스트가 주입하는 실점검 프로브(§6.2). Core 는 점검을 구현하지 않는다. */
  probes?: readonly DependencyProbe[];
  /** Core 가 아는 사실. 주지 않으면 종전과 완전히 같다(§13-3). */
  core?: CoreHealthFacts;
  /** 프로브별 지정이 없을 때 쓰는 제한 시간. 운영 합의값이며 Core 가 기본값을 만들지 않는다(§13-3). */
  timeoutMs: number;
  clock?: () => number;
  build?: BuildInfo;
  scheduler?: Scheduler;
}

/**
 * 모르는 이름을 응답에 되돌려줄 때 쓰는 관문. 호스트가 컴포넌트 자리에 호 ID·발신번호를
 * 넣는 경우가 있고 /health 는 공개 엔드포인트다(§10.3).
 */
function safeLabel(value: unknown): string {
  const raw = typeof value === 'string' ? value : `(${typeof value})`;
  const text = sanitizeDetail(raw) ?? '(빈 값)';
  return text.length > MAX_LABEL_LEN ? `${text.slice(0, MAX_LABEL_LEN)}…` : text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 시각 형태가 아닌 값은 싣지 않는다 — 대시보드가 "1970년에 관측"으로 그린다. */
function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/**
 * Core 관측을 의존성 항목 + 사실로 바꾼다. **던지지 않는다** — 레지스트리를 호스트가 직접
 * 구현해 넘길 수 있고(`HealthRegistry` 는 인터페이스다) 그 구현의 예외가 헬스체크를 죽이면
 * 하필 장애 조사 중에 /health 가 사라진다.
 */
export async function collectCoreFacts(
  facts: CoreHealthFacts,
): Promise<{ results: DependencyResult[]; core: CoreReadinessFacts }> {
  const warningsKo: string[] = [];
  const results: DependencyResult[] = [];
  const components: CoreComponentFact[] = [];
  const fallback: CoreFallbackFact[] = [];

  const nowIso = facts.nowIso;
  if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
    // 낡음을 판정할 기준이 없다. `effectiveComponentState` 는 이 경우 `unknown` 으로 떨어지며
    // 그 결과를 그대로 적는다 — 기준 시각을 여기서 만들면 §13-3 위반이고, 무엇보다 **낡은
    // 샘플이 방금 관측한 것으로 읽힌다**.
    warningsKo.push('관측 시각이 ISO8601 이 아니어서 샘플의 낡음을 판정하지 못했다 — 상태를 모른다로 적는다');
  }

  const pending = new Set<string>();
  for (const c of facts.approvalPending ?? []) {
    if (!KNOWN_COMPONENTS.has(c)) {
      warningsKo.push(`활성화 전 선언에 모르는 컴포넌트가 있다: ${safeLabel(c)}`);
      continue;
    }
    pending.add(c);
  }

  const declared = new Set<string>();
  for (const raw of facts.components ?? []) {
    if (!KNOWN_COMPONENTS.has(raw)) {
      warningsKo.push(`모르는 컴포넌트를 건너뛰었다: ${safeLabel(raw)}`);
      continue;
    }
    if (declared.has(raw)) {
      // 조용히 지우면 같은 컴포넌트가 두 줄로 나와 대시보드에서 서로를 덮는다.
      warningsKo.push(`컴포넌트 선언이 중복됐다: ${raw}`);
      continue;
    }
    declared.add(raw);

    const component = raw as ComponentId;
    const kind = COMPONENT_DEPENDENCY_KIND[component];
    const name = `${CORE_DEPENDENCY_PREFIX}${component}`;
    const tier = COMPONENT_TIER[component];

    let sample: HealthSample | undefined;
    try {
      const got = facts.registry.latest(component);
      sample = got !== null && typeof got === 'object' ? got : undefined;
      if (got !== undefined && sample === undefined) {
        warningsKo.push(`레지스트리가 규약을 어긴 샘플을 돌려줬다: ${component}`);
      }
    } catch (err) {
      warningsKo.push(`레지스트리 조회가 실패했다(${component}): ${safeLabel(message(err))}`);
    }

    if (pending.has(component)) {
      // 판정은 `approvalPendingProbe` 가 고른 degraded 를 그대로 쓴다 — down 이면 켜 보기도
      // 전에 영구 장애이고, up 이면 켜진 줄 착각한다(위 (라)).
      let status: HealthStatus = 'degraded';
      let note: string | undefined;
      try {
        const outcome = await approvalPendingProbe(name, kind).check();
        status = outcome.status;
        note = outcome.detail;
      } catch (err) {
        warningsKo.push(`활성화 전 판정이 실패했다(${component}): ${safeLabel(message(err))}`);
      }
      const detail = sanitizeDetail([note, sample !== undefined ? APPROVAL_PENDING_SAMPLE_DETAIL_KO : undefined]
        .filter((s): s is string => typeof s === 'string' && s.length > 0).join(' · '));
      results.push({
        name, kind, critical: false, status,
        ...(detail !== undefined ? { detail } : {}),
      });
      // 실엔진을 관측한 적이 없으므로 `unknown` 이다. dry_run 샘플의 시각·지연은 싣지 않는다.
      components.push({ component, tier, state: 'unknown', approvalPending: true });
      continue;
    }

    let state: HealthState = 'unknown';
    try {
      state = effectiveComponentState(sample, facts.policy, nowIso);
    } catch (err) {
      warningsKo.push(`상태 판정이 실패했다(${component}): ${safeLabel(message(err))}`);
    }

    const notes: string[] = [];
    if (state === 'unknown') notes.push(UNKNOWN_DETAIL_KO);
    // 관측된 상태가 down 이 아닌데 판정이 down 이면 그것은 정책의 결과다. 그 구분이 없으면
    // 운영은 멀쩡한 엔진을 뒤지고, 정책을 켠 사실은 어디에도 보이지 않는다.
    if (state === 'down' && sample?.state !== 'down') notes.push(POLICY_DOWN_DETAIL_KO);
    if (typeof sample?.detail === 'string') notes.push(sample.detail);
    const detail = sanitizeDetail(notes.join(' · '));

    results.push({
      name, kind,
      // 위 (나) — 호스트가 올릴 수 없다.
      critical: false,
      status: state === 'up' ? 'up' : state === 'down' ? 'down' : 'degraded',
      ...(detail !== undefined ? { detail } : {}),
    });

    const observedAt = isoOrUndefined(sample?.observedAt);
    const errorRate = finite(sample?.errorRate);
    const latencyMs = finite(sample?.latencyMs);
    components.push({
      component, tier, state,
      ...(observedAt !== undefined ? { observedAt } : {}),
      ...(errorRate !== undefined ? { errorRate } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    });
  }

  for (const c of pending) {
    if (!declared.has(c)) {
      warningsKo.push(`선언하지 않은 컴포넌트를 활성화 전으로 적었다 — readiness 에 싣지 않았다: ${c}`);
    }
  }
  if (declared.size === 0) warningsKo.push(NO_COMPONENTS_DECLARED_KO);

  const channels = facts.channels;
  if (channels === undefined || channels.length === 0) {
    warningsKo.push(NO_CHANNELS_DECLARED_KO);
  } else {
    const seen = new Set<string>();
    for (const raw of channels) {
      if (!KNOWN_CHANNELS.has(raw)) {
        warningsKo.push(`모르는 채널을 건너뛰었다: ${safeLabel(raw)}`);
        continue;
      }
      if (seen.has(raw)) continue;
      seen.add(raw);
      const channel = raw as ChannelKind;
      try {
        const decision = decideFallbackMode(channel, facts.registry, facts.policy, nowIso);
        fallback.push({
          channel,
          mode: decision.mode,
          reasonKo: decision.reasonKo,
          aiAllowed: aiResponseAllowed(decision),
          disable: decision.disable,
        });
      } catch (err) {
        warningsKo.push(`§9.3 폴백 판정이 실패했다(${channel}): ${safeLabel(message(err))}`);
      }
    }
  }

  return { results, core: { components, fallback, summaryKo: summarizeCore(components, fallback), warningsKo } };
}

/**
 * Core 사실 한 줄. **AI 응대가 멈춘 채널을 맨 앞에 적는다** — 이 보고서를 읽는 사람이 가장
 * 먼저 알아야 하는 사실이고, 그 사실이 `httpStatus` 에는 절대 나타나지 않기 때문이다(위 (나)).
 */
export function summarizeCore(
  components: readonly CoreComponentFact[],
  fallback: readonly CoreFallbackFact[],
): string {
  const blocked = fallback.filter((f) => !f.aiAllowed);
  const head = blocked.length > 0
    ? `AI 응대 중단 채널 ${blocked.length}곳: ${blocked.map((f) => `${f.channel}(${f.mode})`).join(', ')}`
    : fallback.length > 0
      ? `채널 ${fallback.length}곳 모두 AI 응대 유지`
      : '폴백 모드 판정 없음';

  const bad = components.filter((f) => f.state !== 'up');
  const tail = components.length === 0
    ? '컴포넌트 관측 없음'
    : bad.length === 0
      ? `컴포넌트 ${components.length}건 모두 정상`
      : `컴포넌트 ${components.length}건 중 ${bad.length}건 비정상: ${bad.map((f) => `${f.component}=${f.state}`).join(', ')}`;

  return `${head} · ${tail}`;
}

async function runHostProbes(opts: ReadinessOptions): Promise<CoreReadinessReport> {
  try {
    return await checkHealth(Array.isArray(opts.probes) ? opts.probes : [], {
      timeoutMs: opts.timeoutMs,
      ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
      ...(opts.build !== undefined ? { build: opts.build } : {}),
      ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    });
  } catch (err) {
    // `checkHealth` 는 프로브 예외를 삼키지만 프로브 목록 자체가 규약을 어기면 여기로 온다.
    // 그 경우에도 응답은 나가야 한다 — 다만 "점검했고 정상"으로 적지 않는다.
    const detail = sanitizeDetail(message(err));
    const results: DependencyResult[] = [{
      name: `${CORE_DEPENDENCY_PREFIX}probes`,
      kind: 'internal',
      critical: false,
      status: 'degraded',
      code: 'E_INTERNAL',
      ...(detail !== undefined ? { detail: `${PROBE_RUN_FAILED_KO} · ${detail}` } : { detail: PROBE_RUN_FAILED_KO }),
    }];
    const status = aggregateStatus(results);
    const build = sanitizeBuild(opts.build);
    return {
      status,
      kind: 'readiness',
      ...(opts.clock !== undefined ? { checkedAt: new Date(opts.clock()).toISOString() } : {}),
      ...(build !== undefined ? { build } : {}),
      dependencies: results,
      httpStatus: httpStatusFor(status),
      summaryKo: summarizeDependencies(status, results),
    };
  }
}

/**
 * readiness 합성. 호스트 프로브(실점검)와 Core 관측(§9.3)을 **한 보고서**로 묶는다.
 *
 * 둘을 따로 내면 반드시 한쪽만 보는 대시보드가 생기고, 그쪽이 초록이면 운영은 다른 쪽을
 * 보지 않는다. 집계·HTTP 상태·요약 문장은 전부 `ops/health.ts` 것을 그대로 쓴다(§2).
 */
export async function runReadiness(opts: ReadinessOptions): Promise<CoreReadinessReport> {
  const base = await runHostProbes(opts);
  // 배선을 선언하지 않으면 `core` 필드도 없다 — 종전과 완전히 같다(§13-3).
  if (opts.core === undefined) return base;

  let collected: { results: DependencyResult[]; core: CoreReadinessFacts };
  try {
    collected = await collectCoreFacts(opts.core);
  } catch (err) {
    // 우리 쪽 결함은 엔진에 대한 증거가 아니다(`recoveryProbe.ts` 와 같은 결론) —
    // `down` 으로 적어 폴백을 붙잡지도, `up` 으로 적어 숨기지도 않는다.
    const detail = sanitizeDetail(message(err));
    collected = {
      results: [{
        name: `${CORE_DEPENDENCY_PREFIX}state`,
        kind: 'internal',
        critical: false,
        status: 'degraded',
        code: 'E_INTERNAL',
        ...(detail !== undefined ? { detail: `${CORE_STATE_UNREADABLE_KO} · ${detail}` } : { detail: CORE_STATE_UNREADABLE_KO }),
      }],
      core: { components: [], fallback: [], summaryKo: CORE_STATE_UNREADABLE_KO, warningsKo: [CORE_STATE_UNREADABLE_KO] },
    };
  }

  // 호스트가 Core 접두를 쓰면 "Core 가 관측한 상태"로 읽힌다. 이름을 고쳐 주지 않고(조용히
  // 바꾸면 그 프로브의 알림이 끊긴다) 사실을 드러낸다. 중복 자체는 `checkHealth` 가 표시한다.
  const borrowed = base.dependencies.filter(
    (d) => typeof d.name === 'string' && d.name.startsWith(CORE_DEPENDENCY_PREFIX),
  );
  if (borrowed.length > 0) {
    collected.core.warningsKo.push(
      `호스트 프로브 ${borrowed.length}건이 Core 접두(${CORE_DEPENDENCY_PREFIX})를 쓴다 — Core 관측과 구분되지 않는다`,
    );
  }

  const dependencies = [...base.dependencies, ...collected.results];
  const status = aggregateStatus(dependencies);
  return {
    ...base,
    dependencies,
    status,
    httpStatus: httpStatusFor(status),
    summaryKo: summarizeDependencies(status, dependencies),
    core: collected.core,
  };
}

/** 로그·CLI 용 한 줄 요약. 수치를 만들지 않고 보고서에 있는 사실만 옮긴다(§13-3). */
export function formatReadinessReport(report: CoreReadinessReport): string {
  const lines = [`readiness: ${report.status} (HTTP ${report.httpStatus}) — ${report.summaryKo}`];
  if (report.core !== undefined) {
    lines.push(`§9.3: ${report.core.summaryKo}`);
    for (const w of report.core.warningsKo) lines.push(`  경고: ${w}`);
  }
  return lines.join('\n');
}
