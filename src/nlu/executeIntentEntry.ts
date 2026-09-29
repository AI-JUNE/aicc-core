// 인텐트 진입 실행기 — 설계서 §5.1(폴백 사다리)·§5.3(단일 시나리오)·§2(이중 관리 금지)·
// §6.2(엔진 비종속)·§9.3(장애 폴백)·§10.3(마스킹)·§11.1(테넌트 격리)·§13-3(임의 기본값 금지).
//
// 조각은 다 있었다. `createIntentClassifier` 는 발화에서 후보를 뽑고, `decideIntent` 는 확정·
// 명확화·미인식을 판정하고, `routeIntent` 는 그 판정을 시나리오로 옮긴다. 그런데 **그 셋을
// 순서대로 꿰는 코드가 저장소 어디에도 없었다** — (13)(14)(15)(16)이 메운 것과 같은 모양의
// 공백이고, 남은 것 중 가장 앞이다. 이 자리가 비어 있으면 Core 를 소비하는 채널 3곳은
// "시나리오 id 를 이미 아는 경우"에만 Core 를 쓸 수 있다. 즉 **고객이 무엇을 원하는지 듣고
// 시나리오를 고르는 일**은 여전히 각 저장소에 남고, 그 판단이 세 벌로 갈라진다(§2).
//
// 여기서 막는 사고는 취향이 아니라 정해져 있다.
//  (1) **분류기 장애를 "못 알아들었다"로 적는다.** 엔진이 타임아웃 나면 후보가 0건이고, 0건은
//      `decideIntent` 에서 `unmatched` 가 된다 — 고객은 "다시 말씀해 주세요"를 세 번 듣고 끊는데
//      장애는 어디에도 집계되지 않아 그래프는 평온하다((16)의 `store_failed` vs `not_grounded` 와
//      같은 자리다). 그래서 분류기 실패는 `classifierFailed` 로 **반드시 갈라서** 드러낸다.
//  (2) **고객이 직접 고른 선택지에 신뢰도를 지어 넣는다.** 명확화 답변은 엔진 실측이 아니다.
//      1.0 을 적으면 §7 품질 지표에 만점 구간이 생겨 실제 인식률이 가려진다(§13-3).
//  (3) **명확화 답변으로 엔진을 다시 부른다.** 고객은 이미 골랐다 — 다시 부르면 비용(§11.2)과
//      지연이 붙고, 모델이 다른 답을 내면 고객이 고른 것과 다른 시나리오로 간다.
//  (4) **판정을 복사한다.** 임계값·모호성·명확화 한도·라우팅 규칙은 `decideIntent`·`routeIntent`
//      한 곳이다. 여기서 다시 쓰면 §2 의 이중 관리가 인텐트 규칙에서 되풀이된다
//      (검사가 이 파일에 `acceptThreshold`·`maxClarifyAttempts` 같은 이름이 없음을 고정한다).
//  (5) **설정 누락(unrouted)을 정상 이관으로 적는다.** 라우트가 빠진 인텐트를 `policy` 이관으로
//      남기면 운영 통계에 정상 이관으로 섞여, 어느 인텐트의 설정이 빠졌는지 영영 드러나지 않는다.
//
// 하지 않는 것: **문구를 만들지 않는다**(§13-3 — 명확화 질문은 테넌트가 선언한 것만 쓴다) ·
// **실호출을 하지 않는다**(분류기는 주입이며 §6.2 인터페이스 뒤에 있다) ·
// **상태를 바꾸지 않는다**(세션 반영은 `flow/runner.ts` 의 진입 턴 함수들이 한다 — 판정과
// 부작용을 한 함수에 묶으면 실패했을 때 무엇이 남았는지 알 수 없다).
import type { ChannelKind, Handoff } from '../domain/types.ts';
import type { ChoiceNode, Flow, RenderedStep } from '../flow/types.ts';
import { renderNode } from '../flow/types.ts';
import type { TurnTimingPolicy } from '../flow/timing.ts';
import { resolveTurnTiming } from '../flow/timing.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { IntentCatalog, IntentDecision, IntentPolicy } from './intent.ts';
import { resolveClarifyChoice } from './intent.ts';
import type { ClassifyStatus, IntentClassifier } from './llmClassifier.ts';
import { decideIntent } from './intent.ts';
import type { FlowLookup, IntentRoutingTable, NumberedClarifyOption } from './intentRouting.ts';
import { routeIntent } from './intentRouting.ts';

export const INTENT_ENTRY_CONTRACT_VERSION = 1;

/**
 * 명확화 단계의 예약 노드 id. `flow.nodes` 에 없는 단계다(§10.1 고지 단계와 같은 성격) —
 * 단계를 `flow.nodes[step.nodeId]` 로 되짚는 포트는 이 단계에서 죽는다.
 */
export const CLARIFY_NODE_ID = '__clarify';

/** 진행 중인 명확화. 다음 턴의 답을 **이 선택지로** 해석한다 — 없으면 새 분류다. */
export interface PendingClarify {
  options: readonly NumberedClarifyOption[];
  /** 지금까지의 명확화 시도 횟수. `decideIntent` 가 한도와 비교한다 — 여기서 세지 않는다. */
  attempt: number;
}

export interface IntentEntryConfig {
  catalog: IntentCatalog;
  policy: IntentPolicy;
  table: IntentRoutingTable;
  flows: FlowLookup;
  /**
   * 발화 → 후보(§6.2). 주입이다 — Core 는 어느 엔진인지 모른다.
   * `createIntentClassifier` 가 그대로 들어맞지만, 규칙 기반 분류기도 이 모양이면 된다.
   */
  classifier: IntentClassifier;
  /** 명확화 질문 문구. **Core 가 만들지 않는다**(§13-3) — 없으면 되물을 수 없다. */
  clarifyPrompt: string;
}

export interface IntentEntryInput {
  scope: TenantScope;
  channel: ChannelKind;
  /** 고객 발화 원문. 결과 어디에도 남지 않는다 — 분류기가 마스킹해 프롬프트로만 보낸다(§10.3). */
  text: string;
  /** 직전 턴에 되물었다면 그 선택지. 있으면 엔진을 부르지 않고 선택지 해석을 먼저 한다. */
  pending?: PendingClarify;
  /** 턴 타이밍(§5.1). 명확화 단계에도 같은 정책을 실어 준다 — 빠지면 그 턴만 채널 기본값으로 논다. */
  timing?: TurnTimingPolicy;
}

export type IntentEntryOutcome =
  /** 시나리오를 시작한다. `flow` 는 조회까지 끝난 실물이다. */
  | {
      kind: 'start_flow';
      intent: string;
      flow: Flow;
      entryNodeId: string;
      /** 엔진 실측 신뢰도. 고객이 선택지에서 직접 고른 경우에는 **없다**(§13-3). */
      confidence?: number;
      /** 고객이 명확화 선택지에서 직접 고른 결과인가. §7 품질 분석에서 갈라 봐야 하는 구간이다. */
      chosen: boolean;
      ignoredCandidates: string[];
      hallucinated: string[];
    }
  /** 시나리오를 타지 않고 사람에게 간다. `cause` 로 정상 이관과 설정 누락을 갈라 적는다. */
  | {
      kind: 'handoff';
      intent: string;
      cause: 'handoff_only' | 'unrouted';
      reason: Handoff['reason'];
      reasonKo: string;
    }
  /** 되묻는다. `step` 은 채널이 그대로 렌더할 수 있는 단계다. */
  | {
      kind: 'clarify';
      step: RenderedStep;
      pending: PendingClarify;
      ignoredCandidates: string[];
      hallucinated: string[];
    }
  /** 확정하지 못했다. §5.1 사다리로 내려간다 — 사다리 규칙은 여기서 쓰지 않는다. */
  | {
      kind: 'fallback';
      reasonKo: string;
      /** 분류기 자체가 실패했는가. 고객의 말이 이상했던 것과 **절대 같은 상태로 적지 않는다**. */
      classifierFailed: boolean;
      classifierStatus?: ClassifyStatus;
      ignoredCandidates: string[];
      hallucinated: string[];
    };

/** 명확화 단계 렌더. `Choice` 노드로 만들어 **채널별 표현을 복사하지 않는다**(음성 번호 안내·DTMF·버튼). */
export function renderClarifyStep(
  prompt: string,
  options: readonly NumberedClarifyOption[],
  channel: ChannelKind,
  timing?: TurnTimingPolicy,
): RenderedStep {
  const node: ChoiceNode = {
    id: CLARIFY_NODE_ID,
    kind: 'Choice',
    prompt,
    // 표시 순서는 판정이 준 배열 그대로다. 여기서 다시 정렬하면 고객이 말한 번호와
    // `resolveClarifyChoice` 의 1-based 인덱스가 어긋나 **다른 인텐트가 확정된다**.
    options: options.map((o) => ({ label: o.labelKo, value: o.intent })),
  };
  const step = renderNode(node, channel);
  // 첫 명확화도 고객에게는 첫 질문이다 — attempt 1 로 본다(재시도 가산은 사다리의 몫이다).
  const t = resolveTurnTiming(timing, { kind: 'Choice', attempt: 1, channel });
  if (t.inputTimeoutMs !== undefined) step.inputTimeoutMs = t.inputTimeoutMs;
  if (t.bargeIn !== undefined) step.bargeIn = t.bargeIn;
  return step;
}

/** 분류기 상태 → "엔진이 실패했는가". `ok`·`empty_input` 만 엔진 탓이 아니다. */
function classifierFailedBy(status: ClassifyStatus): boolean {
  return status === 'engine_error' || status === 'unparsable' || status === 'invalid_candidates';
}

/**
 * 고객이 명확화 선택지에서 직접 고른 인텐트 → 판정 결과.
 *
 * 임계값을 적용하지 않는 것이 핵심이다. 고객이 "2번"이라고 말한 것에 `acceptThreshold` 를 다시
 * 들이대면 **방금 고른 것을 또 되묻게** 된다. 대신 카탈로그는 다시 본다 — 그 사이 인텐트가
 * 비활성화됐을 수 있고, 없어진 인텐트로 시나리오를 시작하면 갈 곳이 없다.
 * `confidence` 는 **넣지 않는다**(위 경계 2).
 */
function decisionFromChoice(catalog: IntentCatalog, intent: string, attempt: number): IntentDecision | undefined {
  const spec = catalog.intents.find((s) => s.id === intent && !s.disabled);
  if (!spec) return undefined;
  return {
    kind: 'accepted',
    intent: spec.id,
    options: [],
    handoffOnly: Boolean(spec.handoffOnly),
    reasonKo: '고객이 명확화 선택지에서 직접 선택',
    ignoredCandidates: [],
    attempt,
  };
}

/**
 * 발화 1건 → 다음 행동. **던지는 것은 테넌트 격리 위반 하나뿐이다**(§11.1 — 남의 카탈로그로
 * 판정하면 고객이 남의 회사 시나리오를 듣는다). 그 외에는 어떤 실패도 던지지 않는다:
 * 인텐트를 못 고른 것은 §5.1 로 처리할 일이지 통화를 끊을 일이 아니다(§9.3).
 */
export async function resolveIntentEntry(
  cfg: IntentEntryConfig,
  input: IntentEntryInput,
): Promise<IntentEntryOutcome> {
  assertTenantScope(input.scope);

  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const attempt = input.pending?.attempt ?? 0;

  let decision: IntentDecision | undefined;
  let hallucinated: string[] = [];
  let chosen = false;

  if (input.pending !== undefined && input.pending.options.length > 0) {
    // 되물은 직후다. **엔진을 부르지 않는다** — 고객은 이미 골랐다(위 경계 3).
    const picked = text === '' ? undefined : resolveClarifyChoice(input.pending.options, text);
    if (picked !== undefined) {
      decision = decisionFromChoice(cfg.catalog, picked, attempt);
      if (decision === undefined) {
        return {
          kind: 'fallback',
          reasonKo: `고른 인텐트가 카탈로그에 없거나 비활성입니다: ${picked}`,
          classifierFailed: false, ignoredCandidates: [], hallucinated: [],
        };
      }
      chosen = true;
    }
    // 선택지로 읽히지 않았으면 **조용히 넘기지 않고** 새 발화로 다시 분류한다.
    // 되묻기 한도는 `decideIntent` 가 `attempt` 로 본다 — 여기서 세지 않는다.
  }

  if (decision === undefined) {
    if (text === '') {
      // 빈 발화로 엔진을 부르지 않는다(§11.2 비용·§5.1 — 이건 무입력이지 미인식이 아니다).
      return {
        kind: 'fallback', reasonKo: '발화가 비어 있어 분류하지 않았습니다',
        classifierFailed: false, ignoredCandidates: [], hallucinated: [],
      };
    }

    let status: ClassifyStatus;
    let candidates: { intent: string; confidence: number }[];
    let reasonKo: string;
    try {
      const res = await cfg.classifier.classify({ utterance: text, catalog: cfg.catalog });
      status = res.status;
      candidates = res.candidates;
      hallucinated = res.hallucinated;
      reasonKo = res.reasonKo;
    } catch (e) {
      // `classify` 는 던지지 않기로 되어 있지만 **주입받은 구현이 지킨다는 보장은 없다**.
      // 여기서 새면 분류기 버그 하나로 통화가 끊긴다 — 원문·스택은 싣지 않는다(§10.3).
      return {
        kind: 'fallback',
        reasonKo: `분류기가 예외로 끝났습니다: ${e instanceof Error ? e.name : '알 수 없는 예외'}`,
        classifierFailed: true, ignoredCandidates: [], hallucinated: [],
      };
    }

    if (status !== 'ok') {
      // 엔진 장애와 "해당 없음"을 **같은 상태로 적지 않는다**(위 경계 1).
      return {
        kind: 'fallback', reasonKo, classifierFailed: classifierFailedBy(status),
        classifierStatus: status, ignoredCandidates: [], hallucinated,
      };
    }

    decision = decideIntent({
      scope: input.scope, candidates, catalog: cfg.catalog, policy: cfg.policy, attempt,
    });
  }

  const action = routeIntent({
    scope: input.scope, decision, table: cfg.table, flows: cfg.flows, clarifyPrompt: cfg.clarifyPrompt,
  });
  const ignoredCandidates = decision.ignoredCandidates;

  switch (action.kind) {
    case 'start_flow':
      return {
        kind: 'start_flow',
        intent: action.intent,
        flow: action.flow,
        entryNodeId: action.entryNodeId,
        ...(action.confidence !== undefined ? { confidence: action.confidence } : {}),
        chosen,
        ignoredCandidates, hallucinated,
      };
    case 'handoff':
      // 상담사 전용 인텐트는 **정상 이관**이다(§2) — 설계된 경로이므로 policy 로 적는다.
      return {
        kind: 'handoff', intent: action.intent, cause: 'handoff_only',
        reason: 'policy', reasonKo: action.reasonKo,
      };
    case 'unrouted':
      // 설정 누락이다. `policy` 로 적으면 정상 이관에 섞여 영영 드러나지 않는다(위 경계 5).
      // 되묻지 않는 이유: 같은 말을 다시 들어도 같은 인텐트가 나와 그대로 되풀이된다.
      return {
        kind: 'handoff', intent: action.intent, cause: 'unrouted',
        reason: 'error', reasonKo: action.reasonKo,
      };
    case 'clarify': {
      if (action.promptMissing || action.prompt === undefined) {
        // 문구가 없으면 **되묻지 않는다** — Core 가 질문을 지어내면 고객사 화법과 어긋난 말이
        // 그대로 고객에게 나간다(§13-3). 배선 시점 검증이 이미 막지만, 여기서도 통과시키지 않는다.
        return {
          kind: 'fallback', reasonKo: '명확화 문구가 없어 되묻지 못했습니다 (설계서 §13-3)',
          classifierFailed: false, ignoredCandidates, hallucinated,
        };
      }
      return {
        kind: 'clarify',
        step: renderClarifyStep(action.prompt, action.options, input.channel, input.timing),
        pending: { options: action.options, attempt: action.nextAttempt },
        ignoredCandidates, hallucinated,
      };
    }
    case 'fallback':
      return {
        kind: 'fallback', reasonKo: action.reasonKo, classifierFailed: false,
        ignoredCandidates, hallucinated,
      };
  }
}
