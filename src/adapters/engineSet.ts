// 엔진셋 조립 — 설계서 §6.2(엔진 비종속)·§10.3(국외이전)·§11.2(과금 근거)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// 실엔진 어댑터는 **벤더 규격 단위로** 만들어진다. OpenAI 호환 텍스트 규격은 `llm`·`embedding` 만,
// 음성 규격은 `stt`·`tts` 만 내놓는다(둘 다 그 슬롯이 `옵셔널`이다 — 모델 id 를 주지 않으면
// 어댑터를 만들지 않는 것이 §13-3 을 지키는 방식이라서다). 그런데 상위 계층이 보는 §6.2
// `EngineSet` 은 `stt`·`tts`·`llm` 이 **모두 있어야 하는** 타입이다. 그 사이를 지금은 아무도
// 메우지 않았고, 그래서 채널 저장소가 각자 이렇게 쓰게 된다:
//
//     const engines = { stt: audio.stt!, tts: audio.tts!, llm: compat.llm! };   // ← 위험
//
// 이 한 줄에 이 프로젝트가 피하려는 실패가 전부 들어 있다:
//  - **설정 실수가 통화 중에 터진다.** `sttModel` 을 안 넣으면 `audio.stt` 는 `undefined` 이고,
//    `!` 는 그 사실을 기동 시점에 숨긴다. 고객이 말을 건 순간에야 터진다.
//  - **`assertResidency` 가 무력해진다.** 조립한 사람이 residency 를 한 조각에서 베껴 적으면,
//    해외 LLM + 온프렘 STT 를 섞어 놓고 '온프렘'으로 선언할 수 있다(§10.3).
//  - **활성화가 반쪽이 된다.** 한 조각만 live 면 같은 통화에서 STT 는 네트워크로 나가고 LLM 은
//    `[승인 필요]` 로 떨어진다. 이건 장애로도 안 잡힌다 — `classifyEngineFailure` 가
//    `not_activated` 를 **엔진 탓으로 집계하지 않기** 때문이다. 통화만 조용히 실패한다.
//  - **실측 사용량이 버려진다.** 각 조각은 `lastUsage()` 로 §11.2 근거를 알고 있는데, 슬롯만
//    뽑아 합치는 순간 그 경로가 끊긴다. 과금 근거는 나중에 만들 수 없다.
//
// 그래서 조립을 한 곳에서 한다. 이 파일은 **엔진을 부르지 않는다** — 조각을 검사하고 묶을 뿐이다.
// 조립 결과(`AssembledEngineSet.engines`)는 §6.2 `EngineSet` 그대로이므로
// `withResilientEngines` 의 후보로도 바로 들어간다.
//
// 이 모듈이 **하지 않는 것**:
//  - 빠진 슬롯을 시뮬레이터·기본 엔진으로 채우지 않는다. 그 순간 "붙은 줄 알았는데 가짜"가 된다.
//  - 한 슬롯을 두 조각이 채웠을 때 자동으로 고르지 않는다(순서를 바꾸면 엔진이 조용히 바뀐다).
//  - 사용량을 추정하거나 0 으로 채우지 않는다. 모르면 싣지 않는다(§13-3).
import type { EmbeddingAdapter, EngineSet, LlmAdapter, SttAdapter, TtsAdapter } from './index.ts';
import type { Activation } from './http.ts';
import { EngineError } from './http.ts';
import { widestResidency } from './resilience.ts';
import type { UsageMetrics } from '../events/schema.ts';
import { maskPii } from '../core/policyGuard.ts';

export type EngineSlot = 'stt' | 'tts' | 'llm' | 'embedding';
export type Residency = 'domestic' | 'onprem' | 'overseas';

/** §6.2 EngineSet 이 반드시 요구하는 슬롯. embedding 은 RAG 를 쓰는 테넌트만 설정한다. */
export const REQUIRED_SLOTS: readonly EngineSlot[] = Object.freeze(['stt', 'tts', 'llm']);

/**
 * 벤더 어댑터가 내놓는 **부분** 엔진셋. `OpenAiCompatEngines`·`OpenAiAudioEngines`·`HttpEngineSet`
 * 이 그대로 이 모양이다(구조적 호환) — 조립기를 쓰려고 어댑터를 고치지 않아도 된다.
 */
export interface PartialEngineSet {
  readonly activation: Activation;
  stt?: SttAdapter | undefined;
  tts?: TtsAdapter | undefined;
  llm?: LlmAdapter | undefined;
  embedding?: EmbeddingAdapter | undefined;
  /** 마지막 호출의 실측 사용량(§11.2). 없는 조각은 수집 대상에서 빠질 뿐, 0 으로 채우지 않는다. */
  lastUsage?(): UsageMetrics | undefined;
}

export interface EnginePart {
  /**
   * 조각 이름. 오류 문구에 그대로 들어간다 — "stt 가 없다"보다
   * "openai-audio 에 stt 가 없다(sttModel 미설정)"가 훨씬 빨리 고쳐진다.
   */
  source: string;
  engines: PartialEngineSet;
}

export interface AssembleOptions {
  parts: EnginePart[];
  /**
   * §10.3 — 국외이전이 금지된 테넌트에서는 해외 엔진이 **한 슬롯이라도** 섞이면 조립을 거절한다.
   * 조립기가 직접 판정하는 이유: `assertResidency` 를 호출자가 부르도록 두면 언젠가 한 곳이 빠지고,
   * 빠진 그 한 곳이 곧 유출이다.
   */
  allowOverseas: boolean;
  /**
   * embedding 을 반드시 요구할 것인가(RAG 를 쓰는 테넌트). 기본은 요구하지 않음 —
   * 없는 테넌트가 더 많고, Core 가 RAG 를 전제하지 않는다(§6.2).
   */
  requireEmbedding?: boolean;
}

export interface SlotOrigin {
  slot: EngineSlot;
  source: string;
  /** 어댑터가 스스로 밝힌 이름. 설정과 실제가 어긋나면 여기서 보인다. */
  engineName: string;
  residency: Residency;
}

export interface AssembledEngineSet {
  /** §6.2 인터페이스 그대로. 상위 계층은 이것만 본다. */
  engines: EngineSet;
  /** 모든 조각이 같을 때만 조립되므로 단일 값이다(혼재는 거절). */
  activation: Activation;
  /** **가장 노출도가 높은** 슬롯 기준(§10.3). 한 슬롯이라도 해외면 overseas 다. */
  residency: Residency;
  /** 슬롯이 어느 조각에서 왔는지. 운영이 "지금 무엇을 부르고 있나"를 한 줄로 확인하는 경로. */
  origins: SlotOrigin[];
  /** 참여한 조각 이름(선언 순서). */
  sources: string[];
  /**
   * 참여 조각들의 실측 사용량을 합친다(§11.2). 아무 조각도 주지 않으면 `undefined` —
   * 빈 객체를 돌려주지 않는다(빈 객체는 "실측했는데 0"으로 읽힌다).
   */
  collectUsage(): UsageCollection | undefined;
}

export interface UsageCollection {
  usage: UsageMetrics;
  /** 두 조각이 같은 키를 낸 경우. **합산하지 않고** 그 키를 빼며, 여기에 드러낸다. */
  conflicts: { key: keyof UsageMetrics; sources: string[] }[];
  /** 값이 실측으로 볼 수 없는 형태(음수·비유한수·정수 아님)라 버린 것. 조용히 0 으로 적지 않는다. */
  rejected: { key: string; source: string; reasonKo: string }[];
}

const USAGE_KEYS: readonly (keyof UsageMetrics)[] = Object.freeze([
  'llm_prompt_tokens', 'llm_completion_tokens', 'stt_audio_ms', 'tts_audio_ms',
]);

function fail(message: string, detail: Record<string, unknown> = {}): never {
  // 조각 이름·엔진 이름은 설정에서 온 문자열이다. 저장·로그 경로로 그대로 흐르므로 한 번 거른다(§10.3).
  throw new EngineError('E_CONFIG', 'config', maskPii(message).text, detail);
}

function adapterOf(part: PartialEngineSet, slot: EngineSlot): { name: string; residency: Residency } | undefined {
  const a = part[slot] as { name?: unknown; residency?: unknown } | undefined;
  if (a === undefined || a === null) return undefined;
  const name = typeof a.name === 'string' && a.name.length > 0 ? a.name : '';
  const residency = a.residency;
  if (residency !== 'domestic' && residency !== 'onprem' && residency !== 'overseas') {
    // residency 없는 어댑터를 통과시키면 §10.3 가드가 그 슬롯만 비껴간다.
    fail(`${slot} 어댑터가 residency 를 선언하지 않았다 — 국외이전 판정을 할 수 없다(§10.3)`);
  }
  if (name === '') fail(`${slot} 어댑터가 name 을 선언하지 않았다 — 무엇을 부르는지 기록할 수 없다`);
  return { name, residency };
}

/**
 * 부분 엔진셋들을 §6.2 `EngineSet` 하나로 묶는다.
 * **설정이 틀렸으면 여기서 던진다** — 조립은 기동 시점이고, 통화 중이 아니다.
 */
export function assembleEngineSet(opts: AssembleOptions): AssembledEngineSet {
  const { parts, allowOverseas } = opts;
  if (!Array.isArray(parts) || parts.length === 0) {
    fail('엔진 조각이 비어 있다 — 무엇을 부를지 선언해야 한다');
  }

  const seenSource = new Set<string>();
  for (const p of parts) {
    if (!p || typeof p.source !== 'string' || p.source.trim() === '') {
      fail('엔진 조각에 source 이름이 없다 — 설정 실수를 어디서 냈는지 알 수 없게 된다');
    }
    if (seenSource.has(p.source)) {
      // 같은 이름 둘은 origins·충돌 보고를 쓸모없게 만든다.
      fail(`엔진 조각 이름이 중복된다: ${p.source}`);
    }
    seenSource.add(p.source);
    if (!p.engines || (p.engines.activation !== 'dry_run' && p.engines.activation !== 'live')) {
      fail(`${p.source}: activation 이 선언되지 않았다 — 실호출 여부를 추측하지 않는다`);
    }
  }

  // 활성화 혼재는 반쪽 통화를 만든다(파일 머리 주석 참조). 조립 자체를 막는다.
  const activations = [...new Set(parts.map((p) => p.engines.activation))];
  if (activations.length > 1) {
    const detail = parts.map((p) => `${p.source}=${p.engines.activation}`).join(', ');
    fail(`엔진 조각의 활성화가 섞여 있다: ${detail} — 같은 통화에서 일부만 실호출되면 장애로도 잡히지 않는다 [승인 필요]`);
  }
  const activation = activations[0] as Activation;

  const slots: EngineSlot[] = ['stt', 'tts', 'llm', 'embedding'];
  const owner = new Map<EngineSlot, { part: EnginePart; name: string; residency: Residency }>();
  for (const slot of slots) {
    const providers = parts
      .map((p) => ({ part: p, info: adapterOf(p.engines, slot) }))
      .filter((x): x is { part: EnginePart; info: { name: string; residency: Residency } } => x.info !== undefined);
    if (providers.length === 0) continue;
    if (providers.length > 1) {
      // 먼저 온 것을 쓰면 조각 순서를 바꾸는 순간 엔진이 조용히 바뀐다. 사람이 정한다.
      fail(`${slot} 슬롯을 여러 조각이 채우고 있다: ${providers.map((x) => x.part.source).join(', ')} — 어느 것을 쓸지 자동으로 고르지 않는다`);
    }
    const only = providers[0]!;
    owner.set(slot, { part: only.part, name: only.info.name, residency: only.info.residency });
  }

  const missing = REQUIRED_SLOTS.filter((s) => !owner.has(s));
  if (missing.length > 0) {
    const have = [...owner.keys()];
    fail(
      `필수 엔진 슬롯이 비어 있다: ${missing.join(', ')} (조각 ${parts.map((p) => p.source).join(', ')} 에서 확보한 것: ${have.length > 0 ? have.join(', ') : '없음'})`
      + ' — 모델 id 를 주지 않은 어댑터는 그 슬롯을 만들지 않는다(§13-3). 통화 중이 아니라 지금 고쳐야 한다',
    );
  }
  if (opts.requireEmbedding === true && !owner.has('embedding')) {
    fail('embedding 슬롯이 비어 있다 — RAG 를 쓰는 테넌트로 선언했다(§5.2). 근거 없는 자유 생성으로 대체하지 않는다');
  }

  const origins: SlotOrigin[] = [...owner.entries()].map(([slot, v]) => ({
    slot, source: v.part.source, engineName: v.name, residency: v.residency,
  }));

  const overseas = origins.filter((o) => o.residency === 'overseas');
  if (!allowOverseas && overseas.length > 0) {
    fail(
      `국외이전 불가 테넌트에 해외 엔진이 섞여 있다: ${overseas.map((o) => `${o.slot}(${o.source})`).join(', ')} (설계서 §10.3)`,
    );
  }
  // 섞인 엔진셋은 **가장 노출도가 높은 후보**로 적는다 — 아니면 assertResidency 가 무력해진다.
  const residency = widestResidency(origins.map((o) => o.residency));

  const engines: EngineSet = {
    stt: owner.get('stt')!.part.engines.stt as SttAdapter,
    tts: owner.get('tts')!.part.engines.tts as TtsAdapter,
    llm: owner.get('llm')!.part.engines.llm as LlmAdapter,
  };
  const emb = owner.get('embedding');
  if (emb) engines.embedding = emb.part.engines.embedding as EmbeddingAdapter;

  // 사용량 수집 대상은 **실제로 슬롯을 제공한 조각**뿐이다. 슬롯을 하나도 안 준 조각의
  // 사용량을 집계에 넣으면 이 통화와 무관한 값이 과금 근거로 들어간다.
  const contributing: EnginePart[] = [];
  for (const o of origins) {
    const p = parts.find((x) => x.source === o.source)!;
    if (!contributing.includes(p)) contributing.push(p);
  }

  return {
    engines,
    activation,
    residency,
    origins,
    sources: parts.map((p) => p.source),
    collectUsage: () => collectPartUsage(contributing),
  };
}

/**
 * 조각들의 `lastUsage()` 를 §11.2 사용량 하나로 합친다.
 *  - 같은 키를 두 조각이 내면 **합산하지 않고** 그 키를 빼고 `conflicts` 에 드러낸다.
 *    합산하면 이중 계상이고, 이중 계상은 대사(reconcile)에서 과다청구로 나타난다.
 *  - 음수·비유한수·정수 아님은 실측으로 볼 수 없으므로 버리고 `rejected` 에 남긴다.
 *  - 아무 값도 없으면 `undefined` — 빈 객체는 "0 을 실측했다"로 읽힌다.
 */
export function collectPartUsage(parts: EnginePart[]): UsageCollection | undefined {
  const byKey = new Map<keyof UsageMetrics, { source: string; value: number }[]>();
  const rejected: { key: string; source: string; reasonKo: string }[] = [];
  let sawAny = false;

  for (const p of parts) {
    const fn = p.engines.lastUsage;
    if (typeof fn !== 'function') continue;
    const u = fn.call(p.engines);
    if (u === undefined || u === null) continue;
    if (typeof u !== 'object') {
      rejected.push({ key: '(전체)', source: p.source, reasonKo: '사용량이 객체가 아니다' });
      continue;
    }
    for (const [rawKey, rawValue] of Object.entries(u as Record<string, unknown>)) {
      if (!USAGE_KEYS.includes(rawKey as keyof UsageMetrics)) {
        // 모르는 키를 그대로 실으면 정체불명 항목이 과금 집계에 쌓인다(§11.2 — 브리지와 같은 규칙).
        rejected.push({ key: rawKey, source: p.source, reasonKo: '알 수 없는 사용량 항목' });
        continue;
      }
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue < 0) {
        rejected.push({ key: rawKey, source: p.source, reasonKo: '실측으로 볼 수 없는 값(음수·비유한수)' });
        continue;
      }
      sawAny = true;
      const key = rawKey as keyof UsageMetrics;
      const list = byKey.get(key) ?? [];
      list.push({ source: p.source, value: rawValue });
      byKey.set(key, list);
    }
  }

  if (!sawAny && rejected.length === 0) return undefined;

  const usage: UsageMetrics = {};
  const conflicts: { key: keyof UsageMetrics; sources: string[] }[] = [];
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      conflicts.push({ key, sources: list.map((x) => x.source) });
      continue;
    }
    usage[key] = list[0]!.value;
  }
  return { usage, conflicts, rejected };
}

/**
 * 조립 결과를 운영이 읽을 한 줄로 만든다. 판단 점수·진행률을 만들지 않고 사실만 적는다(§13-3).
 * 실호출 전 검토(드라이런)에서 "지금 무엇을 부르게 되어 있나"를 확인하는 경로다.
 */
export function describeEngineSet(a: AssembledEngineSet): string {
  const slots = a.origins
    .map((o) => `${o.slot}=${o.engineName}@${o.source}(${o.residency})`)
    .join(' · ');
  const gate = a.activation === 'live' ? 'live' : 'dry_run(실호출 없음) [승인 필요]';
  return maskPii(`활성화 ${gate} · residency ${a.residency} · ${slots}`).text;
}
