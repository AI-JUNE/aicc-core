// 지식 응대 실행기 — 설계서 §5.2(근거 없으면 답하지 않는다)·§5.1(폴백 사다리)·§2(이중 관리 금지)·
// §6.2(엔진 비종속)·§9.3(장애 폴백)·§10.3(마스킹)·§11.1(테넌트 격리)·§11.2(과금 근거)·§13-3(기본값 금지).
//
// 조각은 다 있었다. `createRetriever` 는 질의에서 근거를 만들고, `createAnswerer` 는 근거에서
// 인용까지 검증된 문장을 만든다. 그런데 **그 둘을 순서대로 꿰는 코드가 저장소 어디에도 없었다** —
// (13)~(24)가 메운 것과 같은 모양의 공백이고, 이 자리가 비어 있으면 §5.2 지식 응대는 **통화에
// 한 번도 닿지 않는다**. 고객이 "수수료가 얼마예요"라고 물었을 때 Core 가 할 수 있는 일은
// 시나리오 노드를 밟는 것뿐이고, 질문에 답하는 일은 채널 3곳에 남는다 — 그러면 프롬프트·
// 근거 판정·실패 처리가 세 벌로 갈라진다(§2).
//
// 여기서 막는 사고는 취향이 아니라 정해져 있다.
//  (1) **스토어 장애를 "해당 내용이 없습니다"로 답한다.** `retrieval.ts` 가 `store_failed` 와
//      `not_grounded` 를 갈라 둔 공이 **이 자리에서 그대로 무너진다** — 검색 결과를 묻지 않고
//      `answer()` 에 넘기면 `Answerer` 는 `grounded` 가 아닌 모든 것을 `not_grounded` 하나로
//      적는다. 지식베이스가 통째로 내려가 있어도 고객은 "안내드릴 내용이 없습니다"를 듣고,
//      장애는 어디에도 집계되지 않는다. 그래서 **검색이 실패하면 답변 엔진을 부르지 않고**
//      원인을 그대로 들고 나온다(검사가 "실패 시 answerer 호출 0건"을 고정한다).
//  (2) **마스킹 전 질문을 LLM 에 보낸다.** `AnswerRequest.questionMasked` 는 이름으로 호출자
//      책임임을 밝히고 있고, 검색 단계가 이미 마스킹한 `queryMasked` 를 돌려준다. 원문을 그대로
//      넘기면 주민번호·카드번호가 프롬프트로 나가고(§10.3), **한 번 나가면 되돌릴 방법이 없다**.
//      반대로 여기서 다시 마스킹하면 `maskPii` 가 멱등이 아니라 치환된 토큰이 또 뭉개진다
//      (`900101-*******` → `***-****-0101-*******`). 그래서 **검색이 돌려준 값만** 쓴다.
//  (3) **못 답했을 때 Core 가 문안을 지어낸다.** "죄송합니다, 잘 모르겠습니다"는 고객사 화법이고
//      Core 가 정할 근거가 없다(§13-3). 실패 결과에는 **고객에게 나갈 문장이 아예 없다** —
//      다음에 무엇을 말할지는 §5.1 재프롬프트 정책(테넌트 선언)이 정한다.
//  (4) **판정을 복사한다.** 근거가 되는지는 `decideGrounding`, 다음 칸은 §5.1 사다리
//      (`decideFallback`)가 정한다. 여기서 임계값이나 사다리를 다시 쓰면 §2 의 이중 관리가
//      지식 규칙에서 되풀이된다(검사가 이 파일에 그 이름들이 하나도 없음을 고정한다).
//  (5) **설정 오류를 장애로 적는다.** 정책이 성립하지 않는 것은 우리 쪽 오타인데 그것을 지식
//      엔진 장애로 집계하면, 켜 보기도 전에 §9.3 이 `rag` 를 내려 전 채널이 상담사 직결로
//      떨어진다(`adapters/resilience.ts`·`executeConnector.ts` 와 같은 규칙).
//
// 하지 않는 것: **실호출을 하지 않는다**(검색기·답변기는 주입이며 §6.2 인터페이스 뒤에 있다) ·
// **상태를 바꾸지 않는다**(세션 반영은 `flow/runner.ts` 의 `knowledgeTurn` 이 한다 — 판정과
// 부작용을 한 함수에 묶으면 실패했을 때 무엇이 남았는지 알 수 없다) ·
// **맥락 창을 만들지 않는다**(직전 턴을 몇 개나 프롬프트에 실을지는 비용(§11.2)과 화법의 문제라
// Core 가 정할 근거가 없다 — `AnswerRequest.historyMasked` 는 열려 있고 이 실행기는 싣지 않는다) ·
// **토큰을 만들지 않는다**(실측은 문자·건수뿐이다 — chars 를 토큰으로 환산하면 그 환산값이 곧
// 청구 근거가 되고, 대사(§11.2)에서 전부 다시 봐야 한다).
import type { ChannelKind } from '../domain/types.ts';
import type { EngineErrorCode } from '../adapters/http.ts';
import type { RenderedStep, SayNode } from '../flow/types.ts';
import { renderNode } from '../flow/types.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { Citation, RetrievalPolicy } from './rag.ts';
import type { Answerer } from './answer.ts';
import type { RetrieveResult, Retriever } from './retrieval.ts';

export const KNOWLEDGE_CONTRACT_VERSION = 1;

/**
 * 답변 단계의 예약 노드 id. `flow.nodes` 에 없는 단계다(§10.1 고지·§5.1 명확화와 같은 성격) —
 * 단계를 `flow.nodes[step.nodeId]` 로 되짚는 포트는 이 단계에서 죽는다. 그래서 채널 적합성
 * 스위트(`KNOWLEDGE_ANSWER`)가 각 저장소 CI 에서 미리 잡는다.
 */
export const ANSWER_NODE_ID = '__answer';

export interface KnowledgeConfig {
  /** `createRetriever` 산출물. 질의 마스킹·지식베이스 격리는 이미 그쪽 책임이다. */
  retriever: Retriever;
  /** `createAnswerer` 산출물. 인용 검증·응답 마스킹은 이미 그쪽 책임이다. */
  answerer: Answerer;
  /**
   * 근거 판정 정책(§5.2). **기본값 없음**(§13-3) — 임계값·topK 는 지식베이스 품질에 따라
   * 다르고, Core 가 고르면 그 값이 곧 모든 고객사의 "모른다고 답하는 기준"이 된다.
   */
  policy: RetrievalPolicy;
}

export interface KnowledgeInput {
  scope: TenantScope;
  channel: ChannelKind;
  /** 고객 질문 원문. **결과 어디에도 남지 않는다** — 검색기가 마스킹한 값만 밖으로 나온다(§10.3). */
  text: string;
}

/**
 * 답하지 못한 이유. **뭉개지 않는 것이 이 유니언의 전부다** — `store_failed`(장애)와
 * `not_grounded`(근거 기준 미달)를 같은 값으로 적으면 지식베이스가 내려가 있어도
 * 운영 화면은 "고객이 없는 걸 물어봤다"로만 보인다.
 */
export type KnowledgeFailureCause =
  | 'empty_question'       // 빈 질문 — 엔진을 부르지 않았다
  /**
   * §9.3 판정이 지식 응대를 끈 상태라 **호출하지 않았다**. 이 실행기는 이 값을 만들지 않는다 —
   * 장애 판정은 `decideFallbackMode` 하나이고, 끄는 결정은 그 판정을 받는 런타임이 한다(§2).
   * 어휘를 여기 두는 이유는 호스트가 받는 원인 목록이 두 벌로 갈라지지 않게 하기 위해서다.
   */
  | 'disabled_by_fallback'
  | 'config_error'         // 정책이 성립하지 않는다 — **장애가 아니다**(우리 쪽 오타다)
  | 'embed_failed'         // 질의 임베딩 실패
  | 'store_failed'         // 지식베이스 조회 장애 — 근거 없음과 **섞지 않는다**
  | 'not_grounded'         // 검색은 정상이었고 근거 기준에 못 미쳤다(§5.2 — 답하지 않는 것이 맞다)
  | 'answer_engine_error'  // 답변 생성 호출 실패(타임아웃·상한 초과·승인 전 호출 등)
  | 'answer_unparsable'    // 응답이 규약을 벗어났다
  | 'insufficient'         // 모델이 근거만으로는 답할 수 없다고 했다 — 변명은 고객에게 읽어 주지 않는다
  | 'uncited'              // 근거를 줬는데 한 번도 인용하지 않았다(자기 지식으로 답한 것이다)
  | 'bad_citation';        // 근거 밖 인용 번호를 썼다(근거 밖 내용을 덧붙였다는 신호다)

/**
 * 이번 지식 턴의 실측(§11.2). **토큰은 없다** — 어댑터가 주지 않는 값을 만들지 않는다.
 * 실패한 턴도 비용이 든다(임베딩·조회는 이미 나갔다)는 사실이 이 값으로 남는다.
 */
export interface KnowledgeUsage {
  embedChars: number;
  storeQueries: number;
  hits: number;
  promptChars: number;
  responseChars: number;
}

export type KnowledgeOutcome =
  /** 인용까지 검증된 답변. `step` 은 채널이 그대로 렌더할 수 있는 단계다. */
  | {
      kind: 'answer';
      step: RenderedStep;
      /** 마스킹을 지난, 인용이 검증된 문장. `step.text` 와 같은 값이다. */
      answerKo: string;
      /** 세션에 남길 질문(마스킹 후). 원문은 어디에도 남지 않는다(§10.3). */
      questionMasked: string;
      /** 답변이 실제로 인용한 근거만 추린 것. 화면 각주는 이 목록으로 만든다. */
      citations: Citation[];
      usedMarkers: number[];
      unusedMarkers: number[];
      /**
       * 일부 지식베이스가 빠진 채 답했다. 근거 자체는 진짜지만 **범위가 좁다** —
       * "답은 했는데 절반만 보고 했다"를 숨기지 않는다.
       */
      partial: boolean;
      usage: KnowledgeUsage;
      reasonKo: string;
    }
  /** 답하지 않았다. **고객에게 나갈 문장이 없다** — 다음 말은 §5.1 정책이 정한다(§13-3). */
  | {
      kind: 'no_answer';
      cause: KnowledgeFailureCause;
      /**
       * 지식 응대 경로가 **고장난 것인가**(장애) — 고객의 질문이 범위를 벗어난 것과
       * 절대 같은 값으로 적지 않는다. `config_error` 는 **false** 다: 설정 오류를 장애로
       * 집계하면 켜 보기도 전에 §9.3 이 지식 응대를 내린다.
       */
      infraFailed: boolean;
      reasonKo: string;
      errorCode?: EngineErrorCode;
      questionMasked: string;
      partial: boolean;
      usage: KnowledgeUsage;
    };

/**
 * 답변 단계 렌더. `Say` 노드로 만들어 **채널별 표현을 복사하지 않는다** —
 * 검사·실행에서 모양이 갈라지지 않게 실제 렌더 함수를 쓴다.
 *
 * 인용은 `marker`·`title`·`sourceUri` 만 싣는다. 청크 id·문서 id·점수는 **채널이 쓸 일이
 * 없고**, 화면 각주에 내부 식별자가 섞이면 되돌릴 수 없다(§10.3 최소 노출).
 *
 * **제목을 다시 마스킹하지 않는다.** 근거 본문은 `decideGrounding` 이 이미 한 번 마스킹했고,
 * 제목은 테넌트가 승인한 문서의 제목이다. "안전하게 한 번 더"를 붙이면 `maskPii` 가 멱등이
 * 아니라 "010 요금제 안내" 같은 제목이 뭉개져 고객이 각주를 읽을 수 없게 된다
 * (`executeHandoff` 가 이관 요약에서 막은 것과 같은 사고다).
 */
export function renderAnswerStep(
  answerKo: string,
  citations: readonly Citation[],
  channel: ChannelKind,
): RenderedStep {
  const node: SayNode = { id: ANSWER_NODE_ID, kind: 'Say', text: answerKo };
  const step = renderNode(node, channel);
  if (citations.length > 0) {
    step.citations = citations.map((c) => ({
      marker: c.marker,
      title: c.title,
      ...(c.sourceUri !== undefined ? { sourceUri: c.sourceUri } : {}),
    }));
  }
  return step;
}

const ZERO_USAGE: KnowledgeUsage = {
  embedChars: 0, storeQueries: 0, hits: 0, promptChars: 0, responseChars: 0,
};

/** 검색 실패 상태 → 실패 원인. **같은 값으로 뭉개지 않는 것**이 이 함수의 전부다. */
function causeOfRetrieve(status: RetrieveResult['status']): KnowledgeFailureCause {
  switch (status) {
    case 'empty_query': return 'empty_question';
    case 'config_error': return 'config_error';
    case 'embed_failed': return 'embed_failed';
    case 'store_failed': return 'store_failed';
    default: return 'not_grounded';
  }
}

/**
 * 질문 1건 → 다음 행동. **던지는 것은 테넌트 격리 위반 하나뿐이다**(§11.1 — 남의 테넌트
 * 지식으로 답하면 다른 회사의 내부 안내가 고객에게 나간다). 그 외에는 어떤 실패도 던지지
 * 않는다: 답을 못 찾은 것은 §5.1 로 처리할 일이지 통화를 끊을 일이 아니다(§9.3).
 */
export async function resolveKnowledgeTurn(
  cfg: KnowledgeConfig,
  input: KnowledgeInput,
): Promise<KnowledgeOutcome> {
  assertTenantScope(input.scope);

  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text === '') {
    // 빈 질문으로 임베딩·LLM 을 부르지 않는다(§11.2 비용 — 그리고 이건 무입력이지 미인식이 아니다).
    return {
      kind: 'no_answer', cause: 'empty_question', infraFailed: false,
      reasonKo: '질문이 비어 있어 검색하지 않았습니다',
      questionMasked: '', partial: false, usage: ZERO_USAGE,
    };
  }

  let found: RetrieveResult;
  try {
    found = await cfg.retriever.retrieve(text, cfg.policy);
  } catch (e) {
    // `retrieve` 는 격리 위반만 던지기로 되어 있지만 **주입받은 구현이 지킨다는 보장은 없다**.
    // 여기서 새면 스토어 클라이언트 버그 하나로 통화가 끊긴다(§9.3).
    // 격리 위반(§11.1)은 폴백할 사안이 아니므로 **그대로 올린다** — 남의 테넌트 지식으로 답하는
    // 것은 장애가 아니라 사고다. 원문·스택은 싣지 않는다(§10.3 — 질의가 메시지에 섞여 있을 수 있다).
    if (e instanceof Error && e.message.includes('§11.1')) throw e;
    return {
      kind: 'no_answer', cause: 'store_failed', infraFailed: true,
      reasonKo: `검색기가 예외로 끝났습니다: ${e instanceof Error ? e.name : '알 수 없는 예외'}`,
      // 마스킹된 질의는 검색기가 만든다 — 못 받았으면 **지어내지 않는다**(§13-3).
      questionMasked: '', partial: false, usage: ZERO_USAGE,
    };
  }
  const retrieveUsage: KnowledgeUsage = {
    embedChars: found.usage.embedChars,
    storeQueries: found.usage.storeQueries,
    hits: found.usage.hits,
    promptChars: 0,
    responseChars: 0,
  };

  if (found.status !== 'grounded' || found.grounding === undefined) {
    // **답변 엔진을 부르지 않는다.** 부르면 `Answerer` 가 모든 실패를 `not_grounded` 하나로
    // 적어, 위 (1)의 사고가 그대로 되살아난다(장애가 '내용 없음'으로 보인다).
    return {
      kind: 'no_answer',
      cause: causeOfRetrieve(found.status),
      infraFailed: found.status === 'store_failed' || found.status === 'embed_failed',
      reasonKo: found.reasonKo,
      ...(found.errorCode !== undefined ? { errorCode: found.errorCode } : {}),
      questionMasked: found.queryMasked,
      partial: found.partial,
      usage: retrieveUsage,
    };
  }

  // **마스킹을 지난 질문만** 프롬프트로 나간다. 여기서 다시 마스킹하지 않는다(위 (2)).
  let answered: Awaited<ReturnType<Answerer['answer']>>;
  try {
    answered = await cfg.answerer.answer({
      questionMasked: found.queryMasked,
      grounding: found.grounding,
    });
  } catch (e) {
    // `answer` 도 던지지 않기로 되어 있다(§9.3). 주입 구현이 어기면 답변 하나 때문에 통화가 끊긴다.
    if (e instanceof Error && e.message.includes('§11.1')) throw e;
    return {
      kind: 'no_answer', cause: 'answer_engine_error', infraFailed: true,
      reasonKo: `답변기가 예외로 끝났습니다: ${e instanceof Error ? e.name : '알 수 없는 예외'}`,
      questionMasked: found.queryMasked, partial: found.partial, usage: retrieveUsage,
    };
  }
  const usage: KnowledgeUsage = {
    ...retrieveUsage,
    promptChars: answered.promptChars,
    responseChars: answered.responseChars,
  };

  if (answered.status !== 'ok' || answered.answerKo === undefined) {
    const cause: KnowledgeFailureCause =
      answered.status === 'engine_error' ? 'answer_engine_error'
        : answered.status === 'unparsable' ? 'answer_unparsable'
          : answered.status === 'insufficient' ? 'insufficient'
            : answered.status === 'uncited' ? 'uncited'
              : answered.status === 'bad_citation' ? 'bad_citation'
                // `not_grounded`·`empty_question` 은 위에서 이미 걸렀으므로 여기 오면 규약 위반이다.
                : 'answer_unparsable';
    return {
      kind: 'no_answer',
      cause,
      // 규격을 어긴 응답·근거 밖 인용·무인용은 **모델이 잘못한 것**이다 — 고객의 질문 탓으로
      // 적으면 "그 질문은 범위 밖"으로 분류되어 품질 저하가 통계에서 사라진다.
      infraFailed: cause !== 'insufficient',
      reasonKo: answered.reasonKo,
      ...(answered.errorCode !== undefined ? { errorCode: answered.errorCode } : {}),
      questionMasked: found.queryMasked,
      partial: found.partial,
      usage,
    };
  }

  return {
    kind: 'answer',
    step: renderAnswerStep(answered.answerKo, answered.citations, input.channel),
    answerKo: answered.answerKo,
    questionMasked: found.queryMasked,
    citations: answered.citations,
    usedMarkers: answered.usedMarkers,
    unusedMarkers: answered.unusedMarkers,
    partial: found.partial,
    usage,
    reasonKo: found.partial
      ? `${answered.reasonKo} — 지식베이스 ${found.failures.length}곳이 빠진 채 답했습니다`
      : answered.reasonKo,
  };
}
