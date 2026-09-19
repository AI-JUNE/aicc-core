// 근거 → 답변 — 설계서 §5.2(근거 없으면 답하지 않는다)·§6.2(엔진 비종속)·§9.3(폴백)·§10.3(마스킹)·§13-3(기본값 금지).
//
// `decideGrounding` 은 `Grounded { context, citations }` 까지 만들고 **거기서 끝난다.** 그 근거를
// 엔진에 넣어 문장으로 바꾸고, 돌아온 문장이 정말 그 근거를 쓴 것인지 확인하는 자리가 저장소
// 어디에도 없었다. 그대로 두면 채널 3곳이 각자 프롬프트를 쓰고, 각자 다르게 틀린다. 그 틀림은
// 전부 **예외가 아니라 고객에게 그대로 나가는 문장**이라 사후에 발견되지 않는다 —
//   · **근거 없는 상태로 엔진을 부른다.** `GroundingDecision` 은 유니언인데 `grounded` 를 확인하지
//     않고 `context` 를 읽으면 `undefined` 가 프롬프트에 실린다. 그 순간 이 시스템은 RAG 가 아니라
//     **환각 생성기**가 되고, §5.2 의 방어선 전체가 무의미해진다.
//   · **없는 인용 번호를 그대로 내보낸다.** 근거는 2건인데 답변에 [3] 이 붙으면 고객 화면에는
//     클릭되지 않는 각주가 뜬다. 모델이 근거 밖의 내용을 덧붙였다는 가장 분명한 신호인데,
//     검사하지 않으면 그냥 오타처럼 보인다.
//   · **인용이 하나도 없는 답변을 내보낸다.** 근거를 줬는데 한 번도 참조하지 않았다는 것은
//     모델이 자기 지식으로 답했다는 뜻이다. 그럴듯해서 아무도 신고하지 않는다.
//   · **"근거에 없습니다"를 고객에게 읽어 준다.** 모델이 못 답하겠다고 한 것은 폴백 신호지
//     응대 문안이 아니다(§5.1) — 게다가 그 변명은 질문을 그대로 되풀이한다(§10.3).
//   · 답변 실패가 예외로 올라와 **통화가 끊긴다**(§9.3).
//
// 경계:
//  1) **판정하지 않는다.** 근거가 되는지는 `decideGrounding` 이, 다음에 무엇을 할지는
//     `groundingFallback`(=§5.1 사다리)이 정한다. 여기서 폴백 사다리를 다시 쓰면 §2 의 이중 관리다.
//  2) **응대 문안은 테넌트가, 출력 형식은 Core 가.** 지시문(`systemKo`)·거절 문안에 기본값을 두지
//     않는다(§13-3). 반대로 JSON 출력 형식과 `[n]` 인용 표기는 **이 파일의 파서와 짝을 이루는
//     통신 규약**이라 테넌트가 정하면 검증이 깨진다.
//  3) **검증 대상은 실제로 나갈 문장이다.** 마스킹을 먼저 하고, 그 결과에서 인용 번호를 센다.
//     순서를 바꾸면 마스킹이 문장을 바꾼 뒤라 "검증한 문장"과 "나가는 문장"이 달라진다.
//  4) **어떤 실패도 던지지 않는다.** 설정 오류는 `createAnswerer` 에서(통화 전) 던지고,
//     `answer` 는 전부 `status` 로 드러낸다.
import type { LlmAdapter, LlmMessage } from '../adapters/index.ts';
import type { EngineErrorCode } from '../adapters/http.ts';
import { EngineError } from '../adapters/http.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import { collectLlmStream, extractJsonBlock } from '../nlu/llmClassifier.ts';
import type { Citation, GroundingDecision } from './rag.ts';

export const ANSWER_CONTRACT_VERSION = 1;

/**
 * Core 가 덧붙이는 출력 형식 지시. 파서·인용 검증과 짝이므로 테넌트가 바꾸지 못한다.
 * 문구가 아니라 **규약**이다 — 바꾸려면 아래 `parseAnswer`·`extractMarkers` 도 같이 바꿔야 한다.
 */
export const ANSWER_OUTPUT_FORMAT_INSTRUCTION =
  '반드시 아래 JSON 객체 하나만 출력한다. 설명·머리말·코드펜스를 덧붙이지 않는다.\n' +
  '{"sufficient":true,"answerKo":"<근거만으로 쓴 답변. 근거를 쓴 자리마다 [번호]를 붙인다>"}\n' +
  '- 답변은 위 [근거] 블록의 내용만으로 작성한다. 근거에 없는 사실을 덧붙이지 않는다.\n' +
  '- [번호]는 근거 블록에 실제로 있는 번호만 쓴다. 없는 번호를 만들지 않는다.\n' +
  '- 근거만으로 답할 수 없으면 {"sufficient":false} 만 출력한다(answerKo 를 만들지 않는다).';

export interface AnswererConfig {
  scope: TenantScope;
  llm: LlmAdapter;
  /**
   * 역할·화법 지시문. **기본값 없음**(§13-3) — Core 가 문안을 정하면 그게 곧 모든 고객사의 화법이 된다.
   */
  systemKo: string;
  /**
   * 국외이전 허용 여부(§10.3). 질문과 **지식 원문**이 함께 프롬프트로 나가므로 판정 대상이다.
   * 해외 엔진인데 허용하지 않으면 **생성 시점에** 거부한다 — 통화 중이 아니라 배포 중에 알아야 한다.
   */
  allowOverseas?: boolean;
  /** 응답 대기 상한(ms). 주지 않으면 제한하지 않는다(§13-3). */
  timeoutMs?: number;
  /** 응답 누적 길이 상한(문자). 주지 않으면 제한하지 않는다(§13-3). */
  maxResponseChars?: number;
}

export interface AnswerRequest {
  /**
   * 고객 질문. **이미 마스킹을 통과한 문자열만** 넣는다 — 검색 단계(`retrieve`)가 이미 마스킹했고,
   * 여기서 다시 마스킹하면 치환된 토큰을 또 건드려 질문이 망가진다. 호출자 책임임을 이름으로 드러낸다.
   */
  questionMasked: string;
  /** `decideGrounding`·`retrieve` 산출물을 **그대로** 넘긴다. 유니언 그대로 받는 것이 안전장치다. */
  grounding: GroundingDecision;
  /** 직전 맥락. 이미 마스킹을 통과한 것만 넣는다. */
  historyMasked?: readonly LlmMessage[];
}

export type AnswerStatus =
  | 'ok'              // 인용까지 검증된 답변
  | 'not_grounded'    // 근거가 없다 — **엔진을 부르지 않았다**
  | 'empty_question'  // 빈 질문 — 엔진을 부르지 않았다
  | 'engine_error'    // 호출 실패(타임아웃·상한 초과·승인 전 호출 등)
  | 'unparsable'      // 응답에서 규약대로 된 JSON 을 찾지 못했다
  | 'insufficient'    // 모델이 근거만으로는 답할 수 없다고 했다 — 폴백 신호다
  | 'uncited'         // 근거를 줬는데 한 번도 인용하지 않았다
  | 'bad_citation';   // 근거에 없는 인용 번호를 썼다

export interface AnswerResult {
  status: AnswerStatus;
  /** `status === 'ok'` 일 때만 채워진다. 마스킹을 지난, 그리고 인용이 검증된 문장이다. */
  answerKo?: string;
  /** 답변이 실제로 인용한 근거만 추린 것. 화면 각주는 이 목록으로 만든다. */
  citations: Citation[];
  /** 답변 본문에 나타난 인용 번호(오름차순·중복 제거). 실측이다. */
  usedMarkers: number[];
  /**
   * 프롬프트에 실었지만 답변이 쓰지 않은 근거 번호. 버그는 아니고 **상한·정책 조정 신호**다
   * (계속 절반만 쓰인다면 `topK` 가 과하다). 비율은 만들지 않는다(§13-3).
   */
  unusedMarkers: number[];
  /** 근거 밖 인용 번호. `bad_citation` 의 근거이자 환각 신호다 — 건수만 적지 않고 번호를 드러낸다. */
  invalidMarkers: number[];
  reasonKo: string;
  errorCode?: EngineErrorCode;
  engine: { name: string; residency: LlmAdapter['residency'] };
  /** 답변 본문에서 개인정보가 치환됐는지(근거 청크에 남아 있던 값이 답변으로 되돌아오는 경로). */
  piiMaskedInAnswer: boolean;
  /**
   * 실측 문자 수(§11.2). 토큰 수는 `LlmAdapter` 가 주지 않으므로 **만들지 않는다**.
   * 모델 응답 원문은 결과에 담지 않는다 — 질문·근거를 그대로 되풀이한다(§10.3).
   */
  promptChars: number;
  responseChars: number;
}

export interface Answerer {
  readonly contractVersion: number;
  readonly engine: { name: string; residency: LlmAdapter['residency'] };
  /** 실호출 없이 프롬프트만 확인한다. 검토·리뷰용. 근거가 없으면 메시지를 만들지 않는다. */
  plan(req: AnswerRequest): { messages: LlmMessage[]; promptChars: number };
  answer(req: AnswerRequest): Promise<AnswerResult>;
}

// ── 응답 파싱·인용 검증 ────────────────────────────────────────────────────────

/**
 * 본문에 쓰인 인용 번호를 센다. `[12]` 처럼 두 자리 이상도 읽고, `[ 1 ]`·`[1,2]` 같은 변형은
 * **읽지 않는다** — 관용하기 시작하면 무엇이 인용이고 무엇이 그냥 대괄호인지 경계가 사라지고,
 * 그 경계가 흐려지면 "근거 밖 인용"을 잡아내지 못한다. 형식은 위 출력 규약이 지시한 그대로다.
 */
export function extractMarkers(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

interface ParsedOk { ok: true; sufficient: boolean; answerKo: string }
interface ParsedNg { ok: false; reasonKo: string }

/**
 * 값 검증은 엄격하다. `sufficient` 가 불리언이 아니면 **참으로 읽지 않는다** —
 * "true" 문자열을 참으로 읽으면 모델이 못 답하겠다고 한 응답이 답변으로 나간다.
 * 빠진 값도 채우지 않는다(§13-3).
 */
export function parseAnswer(raw: string): ParsedOk | ParsedNg {
  const block = extractJsonBlock(raw);
  if (block === undefined) {
    return { ok: false, reasonKo: '응답에서 JSON 을 찾지 못했다(잘렸거나 형식을 벗어났다)' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return { ok: false, reasonKo: 'JSON 구문이 깨져 있다' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reasonKo: '응답이 JSON 객체가 아니다' };
  }
  const o = parsed as { sufficient?: unknown; answerKo?: unknown };
  if (typeof o.sufficient !== 'boolean') {
    return { ok: false, reasonKo: 'sufficient 가 불리언이 아니다(빠진 값을 참으로 읽지 않는다)' };
  }
  if (!o.sufficient) return { ok: true, sufficient: false, answerKo: '' };
  if (typeof o.answerKo !== 'string' || o.answerKo.trim() === '') {
    return { ok: false, reasonKo: 'sufficient 가 참인데 answerKo 가 비어 있다' };
  }
  return { ok: true, sufficient: true, answerKo: o.answerKo };
}

// ── 생성 ──────────────────────────────────────────────────────────────────────

export function createAnswerer(cfg: AnswererConfig): Answerer {
  assertTenantScope(cfg.scope);
  if (typeof cfg.systemKo !== 'string' || cfg.systemKo.trim() === '') {
    throw new EngineError('E_CONFIG', 'config', '지시문(systemKo)이 없다 — Core 는 기본 문안을 만들지 않는다 (설계서 §13-3)');
  }
  if (cfg.timeoutMs !== undefined && (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs <= 0)) {
    throw new EngineError('E_CONFIG', 'config', `timeoutMs 는 1 이상의 정수여야 한다: ${String(cfg.timeoutMs)}`);
  }
  if (cfg.maxResponseChars !== undefined && (!Number.isInteger(cfg.maxResponseChars) || cfg.maxResponseChars <= 0)) {
    throw new EngineError('E_CONFIG', 'config', `maxResponseChars 는 1 이상의 정수여야 한다: ${String(cfg.maxResponseChars)}`);
  }
  if (cfg.llm.residency === 'overseas' && cfg.allowOverseas !== true) {
    // 질문만이 아니라 **지식 원문**이 통째로 나간다 — 통화 중이 아니라 배포 중에 막는다.
    throw new EngineError(
      'E_CONFIG', 'config',
      `국외이전 불가 테넌트에 해외 LLM 이 답변 생성기로 설정됐다: ${cfg.llm.name} (설계서 §10.3)`,
    );
  }
  const engine = { name: cfg.llm.name, residency: cfg.llm.residency };

  function build(req: AnswerRequest): LlmMessage[] {
    if (!req.grounding.grounded) return [];
    return [
      {
        role: 'system',
        content: `${cfg.systemKo}\n\n[근거]\n${req.grounding.context}\n\n[출력 형식]\n${ANSWER_OUTPUT_FORMAT_INSTRUCTION}`,
      },
      ...(req.historyMasked ?? []),
      { role: 'user', content: req.questionMasked },
    ];
  }

  return {
    contractVersion: ANSWER_CONTRACT_VERSION,
    engine,

    plan(req) {
      const messages = build(req);
      return { messages, promptChars: messages.reduce((a, x) => a + x.content.length, 0) };
    },

    async answer(req) {
      const base = {
        citations: [] as Citation[],
        usedMarkers: [] as number[],
        unusedMarkers: [] as number[],
        invalidMarkers: [] as number[],
        engine,
        piiMaskedInAnswer: false,
        promptChars: 0,
        responseChars: 0,
      };

      if (!req.grounding.grounded) {
        // 근거가 없으면 **엔진을 부르지 않는다**. 부르는 순간 이 시스템은 RAG 가 아니다(§5.2).
        return {
          ...base,
          status: 'not_grounded',
          reasonKo: `근거가 없어 생성하지 않았다: ${req.grounding.reasonKo}`,
        };
      }
      if (typeof req.questionMasked !== 'string' || req.questionMasked.trim() === '') {
        return { ...base, status: 'empty_question', reasonKo: '빈 질문이라 엔진을 호출하지 않았다' };
      }

      const grounded = req.grounding;
      const messages = build(req);
      const promptChars = messages.reduce((a, x) => a + x.content.length, 0);
      const withPrompt = { ...base, promptChars };

      let raw: string;
      try {
        raw = await collectLlmStream(cfg.llm.complete(messages), cfg.timeoutMs, cfg.maxResponseChars);
      } catch (err) {
        // 답변 생성 실패로 통화를 끊지 않는다(§9.3). 사유는 마스킹을 지난다(§10.3).
        const e = err instanceof EngineError ? err : undefined;
        const msg = e ? e.message : (err instanceof Error ? err.message : String(err));
        return {
          ...withPrompt,
          status: 'engine_error',
          errorCode: e ? e.code : 'E_UNKNOWN',
          reasonKo: maskPii(`답변 생성 호출 실패: ${msg}`).text,
        };
      }

      const responseChars = raw.length;
      const withResponse = { ...withPrompt, responseChars };
      const parsed = parseAnswer(raw);
      if (!parsed.ok) {
        return { ...withResponse, status: 'unparsable', errorCode: 'E_PROTOCOL', reasonKo: parsed.reasonKo };
      }
      if (!parsed.sufficient) {
        // 모델의 거절 문장을 고객에게 읽어 주지 않는다 — 폴백 문안은 테넌트가 정한다(§13-3·§5.1).
        return {
          ...withResponse,
          status: 'insufficient',
          reasonKo: '모델이 근거만으로는 답할 수 없다고 했다 — 폴백으로 넘긴다',
        };
      }

      // 마스킹을 먼저 한다. 검증하는 문장과 나가는 문장이 같아야 한다(위 경계 3).
      const m = maskPii(parsed.answerKo);
      const answerKo = m.text.trim();
      const used = extractMarkers(answerKo);
      const valid = new Set(grounded.citations.map((c) => c.marker));
      const invalid = used.filter((n) => !valid.has(n));
      const withMarkers = {
        ...withResponse,
        usedMarkers: used,
        invalidMarkers: invalid,
        unusedMarkers: [...valid].filter((n) => !used.includes(n)).sort((a, b) => a - b),
        piiMaskedInAnswer: m.masked,
      };

      if (invalid.length > 0) {
        // 근거 밖 번호는 모델이 근거 밖 내용을 덧붙였다는 신호다. 죽은 각주를 내보내느니 폴백이 낫다.
        return {
          ...withMarkers,
          status: 'bad_citation',
          errorCode: 'E_PROTOCOL',
          reasonKo: `근거에 없는 인용 번호를 썼다: [${invalid.join('], [')}] (근거 ${grounded.citations.length}건)`,
        };
      }
      if (used.length === 0) {
        // 근거를 줬는데 한 번도 안 썼다면 자기 지식으로 답한 것이다 — 그대로 내보내면 §5.2 가 무의미하다.
        return {
          ...withMarkers,
          status: 'uncited',
          reasonKo: '답변이 근거를 한 번도 인용하지 않았다 — 근거 없이 생성된 문장으로 본다',
        };
      }
      if (answerKo === '') {
        return {
          ...withMarkers,
          status: 'unparsable',
          errorCode: 'E_PROTOCOL',
          reasonKo: '마스킹 후 답변 본문이 비었다',
        };
      }

      return {
        ...withMarkers,
        status: 'ok',
        answerKo,
        citations: grounded.citations.filter((c) => used.includes(c.marker)),
        reasonKo: `근거 ${grounded.citations.length}건 중 ${used.length}건을 인용한 답변`,
      };
    },
  };
}
