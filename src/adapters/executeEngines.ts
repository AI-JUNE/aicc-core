// 엔진 기동 실행기 — 설계서 §6.2(엔진 비종속)·§9.3(장애 폴백)·§10.3(국외이전·마스킹)·
// §11.1(테넌트 격리)·§11.2(과금 근거)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// 조각은 다 있었다. 벤더 규격 어댑터(`openaiCompat`·`openaiAudio`·`http`)가 요청을 만들고,
// `assembleEngineSet` 이 §6.2 `EngineSet` 하나로 묶고, `withResilientEngines` 가 재시도·대체를
// 붙이고, `healthFromOutcome` 이 호출 결과를 §9.3 헬스 샘플로 바꾼다. 그런데 **설정에서 엔진까지
// 가는 길이 저장소 어디에도 없었다** — `createOpenAiCompatEngines`·`assembleEngineSet`·
// `createResilientCaller`·`withResilientEngines` 를 부르는 곳은 저장소 전체에서 **자기 테스트뿐**이다.
//
// 그 상태에서 제일 비싼 결과는 한 줄로 적을 수 있다. `channels/runtime.ts` 의 인텐트·지식 배선
// 주석은 "엔진 헬스 샘플은 여기서 만들지 않는다 — 엔진 상태는 `adapters/resilience.ts` 가 이미
// 적는다"고 약속하는데, **그 적는 자리를 만드는 코드가 0줄**이다. 그래서 지금 헬스 레지스트리에
// 들어오는 샘플은 채널이 `reportHealth` 로 올리는 것뿐이고, LLM 이 전부 타임아웃인 상태에서도
// §9.3 판정은 `normal` 이다. 증상은 장애로 보이지 않는다: 통화는 턴마다 **개별적으로** 실패하고
// (고객은 "말을 못 알아듣는다"로 겪는다) 폴백은 걸리지 않으며 대시보드는 초록이다. 그리고
// 그 길을 채널 저장소 3곳이 각자 꿰면 **각자 다르게 틀린다** — 손으로 꿸 때 빠지는 것은
// 정해져 있고, 아래 열 가지 중 하나도 예외를 던지지 않는다.
//
//  (가) **헬스 기록 미배선.** 위 문단 그대로다. 복원력은 붙었는데 `record` 가 없으면 엔진 장애가
//       §9.3 판정에 닿지 않는다 — 폴백이 걸리지 않고, 걸리지 않았으므로 복구 프로브도 돌지 않는다.
//  (나) **시계 없이 기록만 배선.** `healthFromOutcome` 은 `now` 가 없으면 **샘플을 만들지 않는다**
//       (없는 시각을 지어내지 않는다, §13-3). 그래서 `record` 만 꿰면 호출기는 한 건도 기록하지
//       않는데 배선도에는 "엔진 상태를 보고 있다"로 남는다. 둘을 따로 받지 않고 **한 벌로** 받는다.
//  (다) **세트 간 활성화 혼재.** 주 세트 `dry_run` + 대체 `live` 를 선언하면, 주 세트의 실패는
//       `E_APPROVAL_REQUIRED` 이고 그 판정은 `failover: false`·`attributable: false` 다 —
//       대체는 **영원히 호출되지 않고** 샘플도 남지 않는다. "대체 엔진이 있다"고 적힌 채
//       아무 일도 일어나지 않는 상태이고, 이쪽은 장애 그래프에 점 하나도 찍히지 않는다.
//  (라) **dry_run 샘플을 실관측으로 적는다.** 조립 조각이 미리 만들어진 어댑터(sim 등)면 `dry_run`
//       에서도 호출이 **성공**한다. 그 성공을 기록하면 켜지지도 않은 엔진이 `up` 으로 보고되고
//       (`ops/executeHealth.ts` 의 (라)와 같은 실패), 운영은 활성화 전 테넌트를 "정상"으로 본다.
//       그래서 `dry_run` 에서는 기록을 배선하지 않고, 대신 `approvalPending` 목록을 돌려준다 —
//       호스트가 readiness 에 그대로 넘기면 "활성화 전"으로 적히고, 넘기지 않으면 영구 `unknown` 이다.
//  (마) **`allowOverseas` 를 네 곳에서 선언한다.** 조립기·호출기·인텐트 분류기·임베딩이 각자 받는다.
//       한 곳만 `true` 면 §10.3 가드가 **그 경로만** 비껴가고, 비껴간 경로로 나가는 것이 하필
//       고객 발화(분류기)와 지식 원문(임베딩)이다. 한 값을 넷에 같이 주입한다(§2).
//  (바) **대체 세트에만 있는 임베딩.** `withResilientEngines` 는 **슬롯별로** 후보를 고르므로,
//       주 세트에 `embedding` 이 없고 대체에만 있으면 그 임베딩이 **주 경로**가 된다. 모델이 다르면
//       차원이 다르고, 차원이 섞인 색인은 거부되지 않고 **유사도만 무의미해진다** — 사고가 예외가
//       아니라 그럴듯한 검색 결과로 온다. 주 세트가 갖지 않은 슬롯은 거절한다.
//  (사) **사용량 경로가 끊긴다.** `withResilientEngines` 가 돌려주는 `EngineSet` 에는 `lastUsage` 가
//       없다(§6.2 인터페이스에 없는 것이 맞다). 조각을 들고 있는 것은 이 실행기뿐이므로 §11.2
//       근거를 여기서 유지한다. **합산하지 않는다** — 같은 키를 두 조각이 내면 빼고 `conflicts` 에
//       적는다(이중 계상은 대사에서 과다청구로 나타나고, 과다청구는 되돌리기 비싸다).
//  (아) **복원력 없이 기록만.** 기록 경로는 호출기 하나다(`record` 는 `ResilienceConfig` 에만 있다).
//       배선을 주면서 복원력을 선언하지 않는 것은 **아무 일도 하지 않는 배선**이므로 거절한다.
//  (자) **대체를 선언했는데 호출기가 없다.** 세트가 둘 이상인데 복원력 선언이 없으면 첫 세트만
//       쓰이고 대체는 영원히 쓰이지 않는다 — (다)와 같은 모양의 침묵이다.
//  (차) **경로 없는 슬롯.** 중립 HTTP 조각은 `paths` 를 주지 않은 슬롯의 어댑터도 **만든다**
//       (경로 확인이 호출 시점이다). 그러면 그 슬롯은 기동 시점에 멀쩡하고 **첫 통화에서**
//       `E_CONFIG` 로 터지는데, `E_CONFIG` 는 "우리 설정이 틀렸다"이므로 대체로 가려지지도 않는다.
//
// 이 파일이 **하지 않는 것**:
//  - 엔진을 부르지 않는다. 기동(조립·검증·배선)뿐이고, 실호출은 상위 계층이 한다.
//  - 타이머를 돌리지 않는다. 주기 점검은 `runRecoveryProbes` 를 호스트가 부르는 경로다(§9.3).
//  - 빠진 슬롯을 sim·기본 엔진으로 채우지 않는다(붙은 줄 알았는데 가짜가 된다).
//  - 모델 id·타임아웃·재시도 횟수·대기 시간의 기본값을 만들지 않는다(§13-3).
//  - 레지스트리·시계를 **호스트에게서 받지 않는다**. `channels/runtime.ts` 가 자기 것을 넘긴다 —
//    받으면 엔진 샘플이 통화가 올린 샘플과 **다른 레지스트리**에 쌓이고, 그러면 폴백 판정은
//    끝까지 그 샘플을 보지 못한다(복구 프로브에서 이미 겪은 실패다).
import type { EngineSet } from './index.ts';
import type { Activation, HttpEngineConfig } from './http.ts';
import { EngineError, createHttpEngineSet } from './http.ts';
import type {
  AssembledEngineSet, EnginePart, EngineSlot, PartialEngineSet, Residency, SlotOrigin, UsageCollection,
} from './engineSet.ts';
import { assembleEngineSet, collectPartUsage, describeEngineSet } from './engineSet.ts';
import type { EngineCallComponent, EngineCandidate, ResilienceConfig } from './resilience.ts';
import { HEALTH_COMPONENT_OF, createResilientCaller, widestResidency, withResilientEngines } from './resilience.ts';
import type { OpenAiAudioConfig } from './openaiAudio.ts';
import { createOpenAiAudioEngines } from './openaiAudio.ts';
import type { OpenAiCompatConfig } from './openaiCompat.ts';
import { createOpenAiCompatEngines } from './openaiCompat.ts';
import type { ComponentId, HealthSample } from '../ops/fallback.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { IntentClassifier } from '../nlu/llmClassifier.ts';
import { createIntentClassifier } from '../nlu/llmClassifier.ts';
import type { Embedder } from '../knowledge/embedding.ts';
import { createEmbedder } from '../knowledge/embedding.ts';

export const ENGINE_STARTUP_CONTRACT_VERSION = 1;

/**
 * 벤더 규격별 조각 선언. **설정이고 비밀값이 아니다** — 실키는 `apiKeyEnv`(환경변수 이름)와
 * `resolveSecret`(값을 가져오는 함수)로만 들어온다(§10.3).
 *
 * `preassembled` 는 이미 만들어진 어댑터를 그대로 받는 경로다(sim·사내 전용 SDK·테스트 더블).
 * `activation` 을 그 조각이 **스스로 선언해야** 한다 — 추측하지 않는다.
 */
export type EngineSpec =
  | { kind: 'openai-compat'; source: string; config: OpenAiCompatConfig }
  | { kind: 'openai-audio'; source: string; config: OpenAiAudioConfig }
  | { kind: 'neutral-http'; source: string; config: HttpEngineConfig }
  | { kind: 'preassembled'; source: string; engines: PartialEngineSet };

/**
 * 후보 세트 하나. **첫 세트가 주 엔진이고 나머지가 §9.3 대체 순서**다 —
 * 순서를 암시하지 않고 배열 순서로 적는 이유는, "우선순위" 필드를 두면 두 세트가 같은 숫자를
 * 가질 수 있고 그때 무엇이 먼저인지는 구현 세부가 정하게 되기 때문이다.
 */
export interface EngineSetSpec {
  /** 로그·`origins`·헬스 detail 에 그대로 들어가는 이름. 세트 간 유일해야 한다. */
  name: string;
  parts: EngineSpec[];
}

/** 재시도·대체 설정(§9.3). 값은 전부 운영 합의값이며 Core 가 만들지 않는다(§13-3). */
export interface EngineResilienceSpec {
  /** 후보 1개당 최대 시도(1 이상 정수). 1 이면 재시도하지 않는다. */
  attemptsPerCandidate: number;
  /** 재시도 전 대기(ms). 재시도를 켜려면 함께 주어야 한다 — Core 는 "권장 300ms"를 정하지 않는다. */
  backoffMs?: (seq: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** 소요 실측용 단조 시계(ms). 없으면 `latencyMs` 를 만들지 않는다(§13-3). */
  monotonic?: () => number;
  /** 재시도·대체로 되살아난 호출을 어떤 상태로 적을지. 선언하지 않으면 `up`(ResilienceConfig 주석). */
  recoveryState?: 'up' | 'degraded';
}

/**
 * 엔진 기동 선언. **테넌트와 국외이전 허용은 여기 한 곳에만 있다** — 분류기·임베딩이 각자
 * 받던 값을 여기서 주입하므로 (마)가 구조적으로 불가능해진다.
 */
export interface EngineStartupDeclaration {
  scope: TenantScope;
  /** §10.3 국외이전 허용. **기본값 없음** — 선언하지 않으면 거절한다(추측이 곧 유출이다). */
  allowOverseas: boolean;
  /** 첫 세트가 주, 나머지가 대체 순서. 비어 있으면 거절한다. */
  sets: EngineSetSpec[];
  /** RAG 를 쓰는 테넌트. 주 세트에 `embedding` 이 없으면 거절한다(§5.2). */
  requireEmbedding?: boolean;
  /** 선언하지 않으면 조립만 한다 — 재시도·대체·헬스 기록이 전부 없다(종전과 같다, §13-3). */
  resilience?: EngineResilienceSpec;
  /**
   * 인텐트 분류기(§5.1·§6.2). 선언하면 **복원력이 붙은 LLM** 으로 만든다 —
   * 호스트가 조각에서 직접 만들면 분류 실패가 재시도·대체·헬스 어디에도 닿지 않는다.
   * 지시문(`systemKo`)은 Core 가 만들지 않는다(§13-3).
   */
  intent?: {
    systemKo: string;
    timeoutMs?: number;
    maxResponseChars?: number;
  };
  /**
   * 지식 임베딩(§5.2). 선언하면 **복원력이 붙은 embedding** 으로 만든다.
   * `expectDim` 을 주지 않으면 이미 저장된 벡터와의 차원 일치는 검사되지 않는다(그 사실은
   * 임베딩 결과의 `dimUncheckedAgainstIndex` 와 아래 `limitsKo` 에 적힌다).
   */
  knowledge?: {
    expectDim?: number;
    batchSize?: number;
    timeoutMs?: number;
  };
}

/**
 * Core 내부 배선. **호스트가 주지 않는다** — `channels/runtime.ts` 가 자기 레지스트리와
 * 자기 시계를 그대로 넘긴다(파일 머리 "하지 않는 것" 참조). 둘을 **한 벌로** 받는 것이
 * (나)를 막는 방식이다.
 */
export interface EngineHealthWiring {
  record(sample: HealthSample): void;
  /** 관측 시각(ISO8601). 런타임의 시계 하나다 — 샘플의 낡음 판정이 폴백과 같은 기준이어야 한다. */
  now(): string;
}

export interface EngineRuntime {
  readonly contractVersion: number;
  /** §6.2 인터페이스 그대로. 상위 계층은 이것만 본다(복원력이 붙었는지 몰라도 된다). */
  engines: EngineSet;
  /** 모든 세트가 같을 때만 기동되므로 단일 값이다(혼재는 거절, (다)). */
  activation: Activation;
  /** 모든 후보 중 **가장 노출도가 높은** 값(§10.3). */
  residency: Residency;
  /** 실제로 확보한 슬롯의 §9.3 컴포넌트. readiness 에 그대로 싣는다 — 목록을 만들지 않는다. */
  components: ComponentId[];
  /**
   * 활성화 전이라 샘플을 읽지 말아야 하는 컴포넌트((라)). `dry_run` 이면 확보한 컴포넌트
   * 전부이고 `live` 면 빈 배열이다 **[승인 필요]**.
   */
  approvalPending: ComponentId[];
  /** 후보 순서(주 → 대체). 운영이 "지금 무엇을 부르게 되어 있나"를 확인하는 경로. */
  candidates: string[];
  /** 주 세트의 슬롯 출처. 설정과 실제가 어긋나면 여기서 보인다. */
  origins: SlotOrigin[];
  /** 엔진 실패를 §9.3 레지스트리에 적고 있는가. `false` 면 그 사유가 `limitsKo` 에 있다. */
  healthRecorded: boolean;
  /** 선언했을 때만 만든다. 없으면 **필드 자체가 없다**(빈 객체는 "배선했다"로 읽힌다). */
  classifier?: IntentClassifier;
  embedder?: Embedder;
  /** 조각들의 실측 사용량(§11.2). 아무 조각도 주지 않으면 `undefined`. */
  lastUsage(): UsageCollection | undefined;
  /** 사람이 먼저 읽을 한 줄. 지어낸 수치 없이 사실만 적는다(§13-3). */
  describeKo: string;
  /** 꿰지 못한 경로·검사하지 못한 범위. 숨기지 않는다(§13-3). */
  limitsKo: string[];
}

function fail(message: string, detail: Record<string, unknown> = {}): never {
  // 조각 이름·모델 id 는 설정에서 온 문자열이고 로그·저장 경로로 흐른다. 한 번 거른다(§10.3).
  throw new EngineError('E_CONFIG', 'config', maskPii(message).text, detail);
}

const SLOTS: readonly EngineSlot[] = Object.freeze(['stt', 'tts', 'llm', 'embedding']);

/** 중립 HTTP 조각이 실제로 부를 수 있는 슬롯. 경로 없는 슬롯은 (차)의 자리다. */
function neutralHttpSlots(cfg: HttpEngineConfig): EngineSlot[] {
  const paths = cfg.paths ?? {};
  return SLOTS.filter((s) => typeof paths[s] === 'string' && (paths[s] as string).trim() !== '');
}

/**
 * 선언 하나를 조립 가능한 조각으로 바꾼다. **여기서 어댑터가 생긴다** — 벤더 규격 공장은
 * 설정 오류를 스스로 던지므로(모델 id 없음·baseUrl 형식 등) 그 판정을 복사하지 않는다(§2).
 */
function buildPart(spec: EngineSpec): EnginePart {
  if (!spec || typeof spec !== 'object') fail('엔진 조각 선언이 객체가 아니다');
  const source = spec.source;
  if (typeof source !== 'string' || source.trim() === '') {
    fail('엔진 조각에 source 이름이 없다 — 설정 실수를 어디서 냈는지 알 수 없게 된다');
  }
  switch (spec.kind) {
    case 'openai-compat':
      return { source, engines: createOpenAiCompatEngines(spec.config) };
    case 'openai-audio':
      return { source, engines: createOpenAiAudioEngines(spec.config) };
    case 'neutral-http': {
      const usable = neutralHttpSlots(spec.config);
      if (usable.length === 0) {
        fail(`${source}: 중립 HTTP 조각에 경로(paths)가 하나도 없다 — 어떤 슬롯도 부를 수 없다`);
      }
      const set = createHttpEngineSet(spec.config);
      // 어댑터는 경로가 없어도 stt·tts·llm 을 만든다(경로 확인이 호출 시점이다). 그 슬롯을
      // 조립에 넣으면 기동은 통과하고 **첫 통화에서** E_CONFIG 로 터진다 — 부를 수 없는 슬롯은
      // 조각에서 뺀다((차)). 그러면 조립기가 "필수 슬롯이 비었다"로 기동 시점에 거절한다.
      const engines: PartialEngineSet = { activation: set.activation, lastUsage: () => set.lastUsage() };
      if (usable.includes('stt')) engines.stt = set.stt;
      if (usable.includes('tts')) engines.tts = set.tts;
      if (usable.includes('llm')) engines.llm = set.llm;
      if (usable.includes('embedding') && set.embedding !== undefined) engines.embedding = set.embedding;
      return { source, engines };
    }
    case 'preassembled': {
      const engines = spec.engines;
      if (!engines || typeof engines !== 'object') {
        fail(`${source}: preassembled 조각에 engines 가 없다`);
      }
      return { source, engines };
    }
    default:
      // 모르는 종류를 통과시키면 그 조각은 슬롯을 하나도 주지 않고, 증상은 "필수 슬롯이 비었다"로
      // 엉뚱하게 나타난다(설정에 이름이 틀렸다고 적히지 않는다).
      fail(`알 수 없는 엔진 조각 종류: ${JSON.stringify((spec as { kind?: unknown }).kind)}`);
  }
}

function slotsOf(a: AssembledEngineSet): EngineSlot[] {
  return a.origins.map((o) => o.slot);
}

/**
 * 선언 → 돌아갈 준비가 된 엔진. **설정이 틀렸으면 여기서 던진다** — 기동 시점이고 통화 중이 아니다.
 * `wiring` 은 Core 내부 배선이며 호스트는 주지 않는다.
 */
export function startEngines(decl: EngineStartupDeclaration, wiring?: EngineHealthWiring): EngineRuntime {
  if (!decl || typeof decl !== 'object') fail('엔진 기동 선언이 없다');
  assertTenantScope(decl.scope);
  if (typeof decl.allowOverseas !== 'boolean') {
    fail('allowOverseas 를 선언해야 한다 — 국외이전 허용 여부를 추측하지 않는다(§10.3)');
  }
  if (!Array.isArray(decl.sets) || decl.sets.length === 0) {
    fail('엔진 세트가 비어 있다 — 무엇을 부를지 선언해야 한다');
  }

  // ── 1. 선언 형태 ───────────────────────────────────────────────────────────
  const seenSet = new Set<string>();
  const seenSource = new Set<string>();
  for (const set of decl.sets) {
    if (!set || typeof set.name !== 'string' || set.name.trim() === '') {
      fail('엔진 세트에 이름이 없다 — 어느 후보가 응답했는지 로그에서 복원할 수 없게 된다');
    }
    if (seenSet.has(set.name)) fail(`엔진 세트 이름이 중복된다: ${set.name}`);
    seenSet.add(set.name);
    if (!Array.isArray(set.parts) || set.parts.length === 0) {
      fail(`${set.name}: 조각이 비어 있다`);
    }
    for (const part of set.parts) {
      const source = part && typeof part.source === 'string' ? part.source : '';
      if (source === '') continue;   // buildPart 가 정확한 사유로 거절한다
      if (seenSource.has(source)) {
        // 세트가 달라도 이름이 같으면 사용량 수집에서 **같은 키를 둘이 낸 것**으로 읽혀
        // 그 항목이 조용히 빠진다((사)). 다른 인스턴스이므로 다른 이름을 붙여야 한다.
        fail(`엔진 조각 이름이 세트를 넘어 중복된다: ${source} — 세트별로 다른 인스턴스이므로 이름도 달라야 한다(§11.2)`);
      }
      seenSource.add(source);
    }
  }

  // ── 2. 세트별 조립 (allowOverseas 는 한 값) ─────────────────────────────────
  const assembled: { name: string; set: AssembledEngineSet; parts: EnginePart[] }[] = [];
  for (let i = 0; i < decl.sets.length; i += 1) {
    const spec = decl.sets[i] as EngineSetSpec;
    const parts = spec.parts.map(buildPart);
    const set = assembleEngineSet({
      parts,
      allowOverseas: decl.allowOverseas,
      // RAG 요구는 주 세트에만 적용한다 — 대체 세트에 임베딩이 없는 것은 "그 슬롯에 대체가
      // 없다"는 뜻이고, 그건 선택이다. 반대 방향((바))은 아래에서 거절한다.
      ...(i === 0 && decl.requireEmbedding === true ? { requireEmbedding: true } : {}),
    });
    assembled.push({ name: spec.name, set, parts });
  }

  const primary = assembled[0] as { name: string; set: AssembledEngineSet; parts: EnginePart[] };
  const primarySlots = new Set<EngineSlot>(slotsOf(primary.set));

  // ── 3. 세트 간 검사 ────────────────────────────────────────────────────────
  const activations = [...new Set(assembled.map((a) => a.set.activation))];
  if (activations.length > 1) {
    const detail = assembled.map((a) => `${a.name}=${a.set.activation}`).join(', ');
    fail(
      `엔진 세트의 활성화가 섞여 있다: ${detail} — 승인 전 호출은 대체로 넘기지 않으므로(not_activated)`
      + ' 대체 엔진은 영원히 호출되지 않고 장애로도 집계되지 않는다 [승인 필요]',
    );
  }
  const activation = activations[0] as Activation;

  for (const cand of assembled.slice(1)) {
    const extra = slotsOf(cand.set).filter((s) => !primarySlots.has(s));
    if (extra.length > 0) {
      fail(
        `대체 세트 ${cand.name} 이 주 세트에 없는 슬롯을 채운다: ${extra.join(', ')}`
        + ' — 슬롯별로 후보를 고르므로 그 슬롯은 대체가 아니라 **주 경로**가 된다.'
        + ' 임베딩이면 차원이 다른 모델이 색인에 섞여 유사도만 무의미해진다(§5.2)',
      );
    }
  }

  if (decl.knowledge !== undefined && !primarySlots.has('embedding')) {
    // 선언만 하고 아무 일도 일어나지 않는 상태로 두지 않는다 — 그 상태는 "RAG 를 켰는데
    // 검색이 안 된다"로 나타나고, 원인은 엔진이 아니라 모델 id 누락이다(§13-3).
    fail(
      '지식 임베딩을 선언했는데 주 세트의 embedding 슬롯이 비어 있다'
      + ' — 임베딩 모델 id 를 주거나 requireEmbedding 으로 기동을 막아야 한다(§5.2)',
    );
  }

  // ── 4. 복원력·기록 배선 ────────────────────────────────────────────────────
  const limitsKo: string[] = [];
  if (assembled.length > 1 && decl.resilience === undefined) {
    fail(
      `대체 세트 ${assembled.length - 1}개를 선언했는데 복원력(resilience) 선언이 없다`
      + ' — 첫 세트만 쓰이고 대체는 영원히 쓰이지 않는다(§9.3)',
    );
  }
  if (wiring !== undefined && decl.resilience === undefined) {
    fail('헬스 기록을 배선하면서 복원력(resilience)을 선언하지 않았다 — 기록은 호출기 하나를 지나므로 한 건도 남지 않는다(§9.3)');
  }
  if (wiring !== undefined && (typeof wiring.record !== 'function' || typeof wiring.now !== 'function')) {
    fail('헬스 배선에는 record 와 now 가 **둘 다** 있어야 한다 — 시계가 없으면 샘플 자체가 만들어지지 않는다(§13-3)');
  }

  // 활성화 전에는 기록하지 않는다((라)). sim 같은 미리 만들어진 조각은 dry_run 에서도 성공하므로,
  // 그 성공을 적으면 켜지지도 않은 엔진이 up 으로 보고된다.
  const recording = wiring !== undefined && activation === 'live';
  if (wiring === undefined) {
    limitsKo.push('헬스 레지스트리가 배선되지 않았다 — 엔진 실패가 §9.3 폴백 판정에 닿지 않는다(채널이 올리는 샘플만 본다)');
  } else if (!recording) {
    limitsKo.push('활성화 전(dry_run)이라 헬스 샘플을 남기지 않는다 — dry_run 성공은 실엔진 관측이 아니다 [승인 필요]');
  }
  if (decl.resilience === undefined) {
    limitsKo.push('복원력이 선언되지 않았다 — 재시도·대체·헬스 기록이 모두 없다(조립만 한 상태)');
  } else if (decl.resilience.monotonic === undefined) {
    limitsKo.push('단조 시계(monotonic)가 없어 헬스 샘플에 latencyMs 를 싣지 않는다(§13-3)');
  }

  let engines: EngineSet = primary.set.engines;
  if (decl.resilience !== undefined) {
    const r = decl.resilience;
    const cfg: ResilienceConfig = {
      attemptsPerCandidate: r.attemptsPerCandidate,
      allowOverseas: decl.allowOverseas,
      ...(r.backoffMs !== undefined ? { backoffMs: r.backoffMs } : {}),
      ...(r.sleep !== undefined ? { sleep: r.sleep } : {}),
      ...(r.monotonic !== undefined ? { monotonic: r.monotonic } : {}),
      ...(r.recoveryState !== undefined ? { recoveryState: r.recoveryState } : {}),
      // 시계와 기록은 **한 벌**이다((나)). 기록하지 않을 때는 시각도 받지 않는다 —
      // 샘플을 만들어 버리고 아무도 적지 않으면 그 관측은 그냥 사라진다.
      ...(recording && wiring !== undefined ? { now: () => wiring.now(), record: (s: HealthSample) => { wiring.record(s); } } : {}),
    };
    const caller = createResilientCaller(cfg);
    const candidates: EngineCandidate<EngineSet>[] = assembled.map((a) => ({
      name: a.name, residency: a.set.residency, target: a.set.engines,
    }));
    engines = withResilientEngines(candidates, { caller });
  }

  // ── 5. 결과 (판정이 끝난 뒤에 만든다) ───────────────────────────────────────
  const slotComponents: ComponentId[] = [];
  for (const slot of slotsOf(primary.set)) {
    const component = HEALTH_COMPONENT_OF[slot as EngineCallComponent];
    if (!slotComponents.includes(component)) slotComponents.push(component);
  }
  // 판정을 복사하지 않는다(§2) — 대체 후보를 섞어 놓고 '국내'로 적으면 §10.3 가드가 무력해진다.
  const residency: Residency = widestResidency(assembled.map((a) => a.set.residency));

  const allParts = assembled.flatMap((a) => a.parts);

  const runtime: EngineRuntime = {
    contractVersion: ENGINE_STARTUP_CONTRACT_VERSION,
    engines,
    activation,
    residency,
    components: slotComponents,
    // live 가 아니면 샘플을 읽지 말아야 한다 — 호스트가 readiness 에 그대로 넘긴다.
    approvalPending: activation === 'live' ? [] : [...slotComponents],
    candidates: assembled.map((a) => a.name),
    origins: primary.set.origins,
    healthRecorded: recording,
    lastUsage: () => collectPartUsage(allParts),
    describeKo: maskPii(
      `${describeEngineSet(primary.set)} · 후보 ${assembled.map((a) => a.name).join('>')}`
      + ` · 헬스기록 ${recording ? '배선' : '없음'}`,
    ).text,
    limitsKo,
  };

  // 분류기·임베딩은 **마지막에** 만든다. 어느 단계에서 걸려도 "돌아가는 포트"가 생기지 않는다.
  if (decl.intent !== undefined) {
    runtime.classifier = createIntentClassifier({
      scope: decl.scope,
      llm: engines.llm,
      systemKo: decl.intent.systemKo,
      allowOverseas: decl.allowOverseas,
      ...(decl.intent.timeoutMs !== undefined ? { timeoutMs: decl.intent.timeoutMs } : {}),
      ...(decl.intent.maxResponseChars !== undefined ? { maxResponseChars: decl.intent.maxResponseChars } : {}),
    });
  }
  if (decl.knowledge !== undefined) {
    // 위에서 주 세트의 슬롯을 이미 확인했다 — 여기서 다시 판정하지 않는다(§2).
    const embedding = engines.embedding as NonNullable<EngineSet['embedding']>;
    if (decl.knowledge.expectDim === undefined) {
      limitsKo.push('expectDim 이 없어 이미 저장된 벡터와의 차원 일치는 검사되지 않는다 — 모델 교체 후 재인덱싱 누락은 이 호출만으로는 알 수 없다(§5.2)');
    }
    runtime.embedder = createEmbedder({
      scope: decl.scope,
      embedding,
      allowOverseas: decl.allowOverseas,
      ...(decl.knowledge.expectDim !== undefined ? { expectDim: decl.knowledge.expectDim } : {}),
      ...(decl.knowledge.batchSize !== undefined ? { batchSize: decl.knowledge.batchSize } : {}),
      ...(decl.knowledge.timeoutMs !== undefined ? { timeoutMs: decl.knowledge.timeoutMs } : {}),
    });
  }

  return runtime;
}
