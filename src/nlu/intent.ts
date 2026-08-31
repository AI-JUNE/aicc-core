// 인텐트 판정·명확화 규약 — 설계서 §5.1(폴백 사다리)·§5.2(근거 기반 응대)·§4(Turn.intent)·§6.2(엔진 비종속).
//
// NLU 엔진은 바뀐다. 바뀌어도 "언제 확정하고, 언제 되묻고, 언제 포기하는가"는 바뀌면 안 된다.
// 그 판정을 엔진 쪽에 두면 엔진 교체 때마다 응대 성격이 달라지고, 테넌트별로 다르게 튜닝할 수도 없다.
// 그래서 Core가 판정을 갖고, 엔진은 후보 목록(IntentCandidate[])만 준다(§6.2).
//
// 임계값에 기본값을 두지 않는다(§13-3). "0.7이면 대충 맞겠지"가 코드에 박히면 그게 곧 성능 주장으로 읽힌다.
// 임계값은 테넌트가 정하고, validateIntentPolicy가 정합성만 본다.
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';

export const INTENT_CONTRACT_VERSION = 1;

/** 엔진이 돌려주는 후보 1건. confidence는 0..1로 정규화해서 어댑터가 채운다(§6.2). */
export interface IntentCandidate {
  intent: string;
  confidence: number;
}

export interface IntentSpec {
  id: string;
  titleKo: string;
  /** 명확화 질문에서 고객에게 보여줄 짧은 문구. 없으면 titleKo를 쓴다. */
  clarifyLabelKo?: string;
  /** 비활성 인텐트 — 카탈로그에는 남기되 판정 대상에서 제외한다(시나리오 이력 보존). */
  disabled?: boolean;
  /** 상담사 이관 전용 인텐트(예: 불만 접수). 확정 즉시 §2 핸드오프로 간다. */
  handoffOnly?: boolean;
}

export interface IntentCatalog {
  tenantId: string;
  workspaceId?: string;
  intents: readonly IntentSpec[];
}

export function validateIntentCatalog(catalog: IntentCatalog): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  if (!catalog.intents.length) errors.push('인텐트 카탈로그가 비어 있다');
  for (const s of catalog.intents) {
    if (!s.id) { errors.push('id 없는 인텐트가 있다'); continue; }
    if (seen.has(s.id)) errors.push(`인텐트 ID 중복: ${s.id}`);
    seen.add(s.id);
    if (!s.titleKo) errors.push(`인텐트 ${s.id}에 titleKo가 없다`);
  }
  if (catalog.intents.every((s) => s.disabled)) {
    errors.push('활성 인텐트가 하나도 없다');
  }
  return errors;
}

/**
 * 테넌트별 판정 정책. 전부 필수다 — "안 정하면 이 값" 이라는 게 없어야 운영자가 값을 마주 본다.
 */
export interface IntentPolicy {
  tenantId: string;
  workspaceId?: string;
  /** 이 값 이상이면 단독 확정 후보가 된다. */
  acceptThreshold: number;
  /** 이 값 미만은 후보로도 취급하지 않는다. */
  rejectThreshold: number;
  /**
   * 1위와 2위의 신뢰도 차이가 이 값 이하이면 확정하지 않고 되묻는다.
   * 0.92와 0.91을 확정해버리면, 반쯤은 틀린 시나리오로 들어간다.
   */
  ambiguityMargin: number;
  /** 명확화 질문에 제시할 최대 선택지 수. 음성 채널은 작게 잡는다. */
  maxClarifyOptions: number;
  /** 명확화 재시도 한도. 넘으면 §5.1 폴백 사다리로 넘긴다. */
  maxClarifyAttempts: number;
}

export function validateIntentPolicy(p: IntentPolicy): string[] {
  const errors: string[] = [];
  const inUnit = (label: string, v: number) => {
    if (!Number.isFinite(v) || v < 0 || v > 1) errors.push(`${label}은 0..1 범위여야 한다: ${String(v)}`);
  };
  if (!p.tenantId) errors.push('tenant_id 없는 인텐트 정책은 허용되지 않는다 (설계서 §11.1)');
  inUnit('acceptThreshold', p.acceptThreshold);
  inUnit('rejectThreshold', p.rejectThreshold);
  inUnit('ambiguityMargin', p.ambiguityMargin);
  if (p.rejectThreshold > p.acceptThreshold) {
    errors.push('rejectThreshold가 acceptThreshold보다 클 수 없다 — 확정 가능한 구간이 사라진다');
  }
  if (!Number.isInteger(p.maxClarifyOptions) || p.maxClarifyOptions < 2) {
    errors.push('maxClarifyOptions는 2 이상의 정수여야 한다 — 선택지 1개는 명확화가 아니다');
  }
  if (!Number.isInteger(p.maxClarifyAttempts) || p.maxClarifyAttempts < 1) {
    errors.push('maxClarifyAttempts는 1 이상의 정수여야 한다');
  }
  return errors;
}

export type IntentDecisionKind = 'accepted' | 'clarify' | 'unmatched';

export interface ClarifyOption {
  intent: string;
  labelKo: string;
  confidence: number;
}

export interface IntentDecision {
  kind: IntentDecisionKind;
  /** accepted일 때만 채워진다. */
  intent?: string;
  confidence?: number;
  /** clarify일 때 제시할 선택지 (신뢰도 내림차순). */
  options: ClarifyOption[];
  /** 확정 즉시 §2 핸드오프로 가야 하는 인텐트인가 */
  handoffOnly: boolean;
  reasonKo: string;
  /** 카탈로그에 없거나 비활성이라 버린 후보. 학습데이터·스튜디오 점검의 근거가 된다(§7 7.3). */
  ignoredCandidates: string[];
  /** 이번 판정이 몇 번째 명확화 시도인지 (입력 그대로 반영) */
  attempt: number;
}

export interface DecideIntentInput {
  scope: TenantScope;
  candidates: readonly IntentCandidate[];
  catalog: IntentCatalog;
  policy: IntentPolicy;
  /** 지금까지의 명확화 시도 횟수(0이면 첫 판정). */
  attempt: number;
}

/**
 * 판정 순서 — 이 순서를 바꾸면 응대 성격이 바뀐다.
 *   1) 카탈로그에 없거나 비활성인 후보를 버린다.
 *   2) rejectThreshold 미만을 버린다.
 *   3) 남은 게 없으면 unmatched.
 *   4) 1위가 acceptThreshold 미만이면 clarify(후보는 있으나 확신이 없다).
 *   5) 1·2위 격차가 ambiguityMargin 이하이면 clarify.
 *   6) 그 외 accepted.
 * 단, 명확화 한도를 이미 소진했다면 clarify를 내지 않고 unmatched로 떨어뜨린다 —
 * 같은 질문을 무한히 되묻는 게 고객 입장에서 제일 나쁘다.
 */
export function decideIntent(input: DecideIntentInput): IntentDecision {
  assertTenantScope(input.scope);
  const { catalog, policy, candidates } = input;
  if (catalog.tenantId !== input.scope.tenantId || policy.tenantId !== input.scope.tenantId) {
    throw new Error('다른 테넌트의 카탈로그·정책으로 인텐트를 판정할 수 없다 (설계서 §11.1)');
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 0) {
    throw new Error(`attempt는 0 이상의 정수여야 한다: ${String(input.attempt)}`);
  }

  const specs = new Map(catalog.intents.filter((s) => !s.disabled).map((s) => [s.id, s] as const));
  const ignoredCandidates: string[] = [];
  const usable: { spec: IntentSpec; confidence: number }[] = [];

  for (const c of candidates) {
    const spec = specs.get(c.intent);
    if (!spec) { ignoredCandidates.push(c.intent); continue; }
    if (!Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) {
      // 엔진이 범위를 벗어난 값을 주면 판정에 쓰지 않는다. 정규화는 어댑터 책임이다(§6.2).
      ignoredCandidates.push(c.intent);
      continue;
    }
    if (c.confidence < policy.rejectThreshold) { ignoredCandidates.push(c.intent); continue; }
    usable.push({ spec, confidence: c.confidence });
  }

  // 동점은 인텐트 ID 사전순으로 깨서 판정을 결정적으로 만든다.
  usable.sort((a, b) => (b.confidence - a.confidence) || a.spec.id.localeCompare(b.spec.id));

  const clarifyExhausted = input.attempt >= policy.maxClarifyAttempts;
  const options = usable.slice(0, policy.maxClarifyOptions).map((u) => ({
    intent: u.spec.id,
    labelKo: u.spec.clarifyLabelKo ?? u.spec.titleKo,
    confidence: u.confidence,
  }));

  const unmatched = (reasonKo: string): IntentDecision => ({
    kind: 'unmatched', options: [], handoffOnly: false, reasonKo, ignoredCandidates, attempt: input.attempt,
  });

  if (!usable.length) {
    return unmatched(candidates.length ? '신뢰도 하한 미달 — 인식된 인텐트 없음' : '인텐트 후보 없음');
  }

  const top = usable[0] as { spec: IntentSpec; confidence: number };
  const second = usable[1];

  const clarifyOrGiveUp = (reasonKo: string): IntentDecision => {
    if (clarifyExhausted) return unmatched(`${reasonKo} — 명확화 한도 소진`);
    if (options.length < 2) return unmatched(`${reasonKo} — 제시할 선택지가 부족`);
    return {
      kind: 'clarify', options, handoffOnly: false, reasonKo, ignoredCandidates, attempt: input.attempt,
    };
  };

  if (top.confidence < policy.acceptThreshold) {
    return clarifyOrGiveUp('확정 임계 미달');
  }
  if (second && (top.confidence - second.confidence) <= policy.ambiguityMargin) {
    return clarifyOrGiveUp('1·2위 신뢰도 격차 부족 — 오분류 위험');
  }

  return {
    kind: 'accepted',
    intent: top.spec.id,
    confidence: top.confidence,
    options: [],
    handoffOnly: Boolean(top.spec.handoffOnly),
    reasonKo: '단독 확정',
    ignoredCandidates,
    attempt: input.attempt,
  };
}

/**
 * §5.1 폴백 사다리와의 접점.
 * decideIntent가 unmatched를 내면 그건 곧 "인식 실패 1회"다 — 실패 카운트를 올리고
 * session.decideFallback에 넘겨 재시도/화면전환/이관을 결정한다.
 * 여기서 폴백 규칙을 다시 쓰지 않는 이유: 규칙이 두 군데 있으면 반드시 갈라진다.
 */
export type IntentNextStep =
  | { step: 'proceed'; intent: string }
  | { step: 'handoff'; intent: string }
  | { step: 'clarify'; options: ClarifyOption[]; nextAttempt: number }
  | { step: 'fallback'; failureIncrement: 1 };

export function nextStep(d: IntentDecision): IntentNextStep {
  if (d.kind === 'accepted') {
    const intent = d.intent as string;
    return d.handoffOnly ? { step: 'handoff', intent } : { step: 'proceed', intent };
  }
  if (d.kind === 'clarify') {
    return { step: 'clarify', options: d.options, nextAttempt: d.attempt + 1 };
  }
  return { step: 'fallback', failureIncrement: 1 };
}

/**
 * 명확화 선택지에 대한 고객 응답 해석. 버튼(visual·chat)은 인텐트 ID가 그대로 오고,
 * 음성은 번호("2번")로 오는 경우가 있어 1-based 인덱스도 받는다.
 * 매칭 실패는 조용히 넘기지 않고 undefined로 돌려 폴백 판정에 태운다.
 */
export function resolveClarifyChoice(options: readonly ClarifyOption[], raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const byId = options.find((o) => o.intent === trimmed);
  if (byId) return byId.intent;
  const n = Number(trimmed.replace(/[^0-9]/g, ''));
  if (Number.isInteger(n) && n >= 1 && n <= options.length) {
    return (options[n - 1] as ClarifyOption).intent;
  }
  return undefined;
}
