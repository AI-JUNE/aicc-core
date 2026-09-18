// LLM → 인텐트 후보 배선 — 설계서 §6.2(엔진 비종속)·§5.1(폴백 사다리)·§10.3(마스킹·국외이전)·§13-3(기본값 금지).
//
// `decideIntent` 는 `IntentCandidate[]` 를 받아 "확정·되묻기·포기"를 판정한다. 그런데 **그 입력을
// 만드는 자리가 저장소 어디에도 없었다**. §6.2 는 `LlmAdapter` 를 선언해 두었고 `nlu/intent.ts` 는
// 후보 배열을 기다리는데, 그 사이 30줄을 채널 저장소 세 곳이 각자 쓰게 되어 있었던 셈이다.
// 그 30줄에서 조용히 빠지는 것은 정해져 있다 —
//   · 모델이 ```json 펜스나 "다음은 결과입니다:" 를 붙여 보내 파싱이 깨진다(각자 다르게 깨진다)
//   · confidence 를 0..100 으로 주는데 그대로 넣어 **모든 후보가 acceptThreshold 를 통과**한다
//   · confidence 가 빠진 후보를 0.5·1.0 으로 채워 **정책을 무력화**한다(§13-3)
//   · 고객 발화를 마스킹 없이 프롬프트에 실어 **원문이 엔진으로 나간다**(§10.3)
//   · 비활성 인텐트까지 프롬프트에 실어 모델이 그걸 고르고, 판정 단계에서 버려져 unmatched 가 된다
//   · 분류 실패가 예외로 올라와 **통화가 끊긴다**
// 이 모듈이 그 자리를 한 번만 만든다.
//
// 경계를 어디에 그었는지가 이 파일의 전부다.
//  1) **판정하지 않는다.** 임계값·명확화·핸드오프 판정은 전부 `decideIntent` 가 한다. 여기서 한 번 더
//     거르면 §2 가 지적한 이중 관리가 인텐트 규칙에서 되풀이된다. 카탈로그에 없는 후보(환각)도
//     **버리지 않고 그대로 넘긴다** — 버리는 것은 카탈로그 판정이고 그 주체는 한 곳이어야 한다.
//     다만 환각이 있었다는 **사실은 드러낸다**(`hallucinated`). 운영자는 "고객이 이상한 말을 해서
//     unmatched" 와 "모델이 헛것을 봐서 unmatched" 를 구분할 수 있어야 한다.
//  2) **응대 문안은 테넌트가, 출력 형식은 Core 가.** 지시문(`systemKo`)에 기본값을 두지 않는다(§13-3) —
//     화법은 고객사마다 다르다. 반대로 JSON 출력 형식은 **이 파일의 파서와 짝을 이루는 통신 규약**이라
//     테넌트가 정하면 파서가 깨진다. 그래서 형식 지시만 Core 가 덧붙인다.
//  3) **절대 던지지 않는다.** 설정 오류는 `createIntentClassifier` 에서(통화 전) 던지고,
//     `classify` 는 어떤 실패도 `status` 로 드러낸다. 분류 실패는 §5.1 재프롬프트로 처리할 일이지
//     통화를 끊을 일이 아니다.
import type { LlmAdapter, LlmMessage } from '../adapters/index.ts';
import type { EngineErrorCode } from '../adapters/http.ts';
import { EngineError } from '../adapters/http.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { IntentCandidate, IntentCatalog } from './intent.ts';
import { validateIntentCatalog } from './intent.ts';

export const LLM_CLASSIFIER_CONTRACT_VERSION = 1;

/**
 * Core 가 덧붙이는 출력 형식 지시. 파서와 짝이므로 테넌트가 바꾸지 못한다.
 * 문구가 아니라 **규약**이다 — 바꾸려면 파서도 같이 바꿔야 한다.
 */
export const OUTPUT_FORMAT_INSTRUCTION =
  '반드시 아래 JSON 객체 하나만 출력한다. 설명·머리말·코드펜스를 덧붙이지 않는다.\n' +
  '{"candidates":[{"intent":"<목록의 id>","confidence":<0 이상 1 이하의 소수>}]}\n' +
  '- intent 는 반드시 위 목록에 있는 id 를 그대로 쓴다.\n' +
  '- confidence 는 0..1 범위의 소수다. 백분율·등급·문자열을 쓰지 않는다.\n' +
  '- 해당하는 것이 없으면 {"candidates":[]} 를 출력한다.';

export interface ClassifierConfig {
  scope: TenantScope;
  llm: LlmAdapter;
  /**
   * 역할·화법 지시문. **기본값 없음**(§13-3) — Core 가 "당신은 상담원입니다" 를 정하면
   * 그게 곧 모든 고객사의 화법이 된다.
   */
  systemKo: string;
  /**
   * 국외이전 허용 여부(§10.3). 고객 발화가 프롬프트로 나가므로 residency 판정 대상이다.
   * 해외 엔진인데 허용하지 않으면 **생성 시점에** 거부한다 — 통화 중이 아니라 배포 중에 알아야 한다.
   */
  allowOverseas?: boolean;
  /** 응답 대기 상한(ms). 주지 않으면 제한하지 않는다(§13-3). */
  timeoutMs?: number;
  /** 응답 누적 길이 상한(문자). 주지 않으면 제한하지 않는다(§13-3). */
  maxResponseChars?: number;
}

export interface ClassifyRequest {
  /** 고객 발화 원문. 여기서 한 번 마스킹되어 프롬프트로 나간다(§10.3). */
  utterance: string;
  catalog: IntentCatalog;
  /**
   * 직전 맥락. **이미 마스킹을 통과한 텍스트만** 넣는다 — 여기서 다시 마스킹하면
   * 이미 치환된 토큰을 또 건드려 맥락이 망가진다. 호출자 책임임을 이름으로 드러낸다.
   */
  historyMasked?: readonly LlmMessage[];
}

export type ClassifyStatus =
  | 'ok'                  // 후보를 얻었다(빈 배열일 수 있다 — 모델이 해당 없음이라 답한 경우)
  | 'empty_input'         // 빈 발화 — 엔진을 부르지 않았다
  | 'engine_error'        // 엔진 호출 실패(타임아웃·HTTP·승인 전 호출 등)
  | 'unparsable'          // 응답에서 JSON 을 찾지 못했다
  | 'invalid_candidates'; // JSON 은 읽었으나 후보 형식이 규약을 어겼다

export interface ClassifyResult {
  status: ClassifyStatus;
  /** `decideIntent` 에 그대로 넘긴다. status 가 'ok' 가 아니면 항상 빈 배열이다. */
  candidates: IntentCandidate[];
  /** 카탈로그에 없거나 비활성인 id — 버리지 않고 드러내기만 한다(위 경계 1). */
  hallucinated: string[];
  reasonKo: string;
  errorCode?: EngineErrorCode;
  /** 감사·국외이전 판단 근거(§10.3). */
  engine: { name: string; residency: LlmAdapter['residency'] };
  /** 프롬프트에 실제로 실린 발화. 원문은 결과 어디에도 남지 않는다(§10.3). */
  utteranceMasked: string;
  piiMasked: boolean;
  /**
   * 실측 문자 수(§11.2). 토큰 수는 `LlmAdapter` 가 주지 않으므로 **만들지 않는다**.
   * 응답 원문은 담지 않는다 — 모델이 발화를 그대로 되풀이하는 일이 흔하다(§10.3).
   */
  promptChars: number;
  responseChars: number;
}

export interface IntentClassifier {
  readonly contractVersion: number;
  readonly engine: { name: string; residency: LlmAdapter['residency'] };
  /** 실호출 없이 프롬프트만 확인한다. 검토·리뷰용. */
  plan(req: ClassifyRequest): { messages: LlmMessage[]; utteranceMasked: string; promptChars: number };
  classify(req: ClassifyRequest): Promise<ClassifyResult>;
}

// ── 프롬프트 조립 ──────────────────────────────────────────────────────────────

/**
 * 프롬프트에 싣는 인텐트 목록. **활성 인텐트만** 싣는다.
 * 비활성을 실으면 모델이 그것을 고르고, 판정 단계에서 버려져 unmatched 가 된다 —
 * 장애로 보이지 않는 채 응대 품질만 떨어지는, 제일 늦게 발견되는 종류의 결함이다.
 */
function catalogLines(catalog: IntentCatalog): string[] {
  return catalog.intents
    .filter((s) => !s.disabled)
    .map((s) => `- ${s.id}: ${s.clarifyLabelKo ?? s.titleKo}`);
}

// ── 응답 파싱 ─────────────────────────────────────────────────────────────────

/**
 * 모델 응답에서 JSON 본문만 떼어낸다.
 * 코드펜스와 앞뒤 산문은 **현실이므로 관용한다** — 여기서 엄격하게 굴면 멀쩡한 응답이 버려진다.
 * 반대로 아래 수치 검증은 엄격하다: 형식의 관용과 값의 관용은 전혀 다른 문제다.
 */
export function extractJsonBlock(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced?.[1] ?? raw;
  const start = body.search(/[[{]/);
  if (start < 0) return undefined;
  const open = body[start] as '[' | '{';
  const close = open === '[' ? ']' : '}';
  // 문자열 안의 괄호에 속지 않게 따옴표·이스케이프를 따라간다.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i] as string;
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return undefined;   // 닫히지 않았다 — 잘린 응답이다
}

interface ParseOk { ok: true; candidates: IntentCandidate[] }
interface ParseNg { ok: false; status: 'unparsable' | 'invalid_candidates'; reasonKo: string }

/**
 * 수치 검증이 이 모듈의 핵심이다. **범위를 벗어난 값을 클램프하지 않는다.**
 * 1.5 를 1.0 으로 줄이면 그 후보는 어떤 acceptThreshold 든 무조건 통과한다 —
 * 잘못된 확신이 정책을 뚫고 들어가는, 가장 비싼 실패다. 빠진 값도 채우지 않는다(§13-3).
 * 하나라도 어긋나면 **후보 전체를 버린다**: 일부만 버리면 순위가 바뀐 채 확정되기 때문이다.
 */
export function parseCandidates(raw: string): ParseOk | ParseNg {
  const block = extractJsonBlock(raw);
  if (block === undefined) {
    return { ok: false, status: 'unparsable', reasonKo: '응답에서 JSON 을 찾지 못했다(잘렸거나 형식을 벗어났다)' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return { ok: false, status: 'unparsable', reasonKo: 'JSON 구문이 깨져 있다' };
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(arr)) {
    return { ok: false, status: 'invalid_candidates', reasonKo: 'candidates 배열이 없다' };
  }

  const out: IntentCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i] as { intent?: unknown; confidence?: unknown } | null;
    if (c === null || typeof c !== 'object') {
      return { ok: false, status: 'invalid_candidates', reasonKo: `${i}번 후보가 객체가 아니다` };
    }
    const intent = c.intent;
    if (typeof intent !== 'string' || intent.trim() === '') {
      return { ok: false, status: 'invalid_candidates', reasonKo: `${i}번 후보에 intent 문자열이 없다` };
    }
    if (seen.has(intent)) {
      // 병합 규칙(최대·평균·첫 값)을 코드에 두지 않는다 — 어느 쪽을 골라도 신뢰도를 왜곡한다.
      return { ok: false, status: 'invalid_candidates', reasonKo: `같은 인텐트가 두 번 나왔다: ${intent}` };
    }
    seen.add(intent);
    const conf = c.confidence;
    if (typeof conf !== 'number' || !Number.isFinite(conf)) {
      return { ok: false, status: 'invalid_candidates', reasonKo: `${intent} 후보의 confidence 가 유한한 수가 아니다(빠진 값을 채우지 않는다)` };
    }
    if (conf < 0 || conf > 1) {
      return { ok: false, status: 'invalid_candidates', reasonKo: `${intent} 후보의 confidence 가 0..1 범위를 벗어났다: ${conf}(잘라 맞추지 않는다)` };
    }
    out.push({ intent, confidence: conf });
  }
  return { ok: true, candidates: out };
}

// ── 엔진 호출 ─────────────────────────────────────────────────────────────────

async function collect(
  stream: AsyncIterable<string>,
  timeoutMs: number | undefined,
  maxChars: number | undefined,
): Promise<string> {
  const it = stream[Symbol.asyncIterator]();
  let out = '';
  for (;;) {
    const step = it.next();
    const next = timeoutMs === undefined
      ? await step
      : await Promise.race([
        step,
        new Promise<never>((_, rej) => {
          const t = setTimeout(() => rej(new EngineError('E_TIMEOUT', 'llm', `LLM 응답이 ${timeoutMs}ms 안에 오지 않았다`)), timeoutMs);
          if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
        }),
      ]);
    if (next.done === true) return out;
    const chunk = next.value;
    if (typeof chunk !== 'string') {
      throw new EngineError('E_PROTOCOL', 'llm', 'LLM 스트림이 문자열이 아닌 값을 내보냈다');
    }
    out += chunk;
    if (maxChars !== undefined && out.length > maxChars) {
      // 상한을 넘은 응답을 잘라서 파싱하면 잘린 JSON 을 "형식 위반" 으로 오진하게 된다.
      throw new EngineError('E_LIMIT', 'llm', `LLM 응답이 상한(${maxChars}자)을 넘었다`);
    }
  }
}

export function createIntentClassifier(cfg: ClassifierConfig): IntentClassifier {
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
    // 통화 중이 아니라 배포 중에 막는다 — 고객 발화가 나간 뒤에 아는 것은 너무 늦다.
    throw new EngineError(
      'E_CONFIG', 'config',
      `국외이전 불가 테넌트에 해외 LLM 이 설정됐다: ${cfg.llm.name} (설계서 §10.3)`,
    );
  }
  const engine = { name: cfg.llm.name, residency: cfg.llm.residency };

  function build(req: ClassifyRequest): { messages: LlmMessage[]; utteranceMasked: string; piiMasked: boolean; promptChars: number } {
    const m = maskPii(req.utterance ?? '');
    const lines = catalogLines(req.catalog);
    const messages: LlmMessage[] = [
      { role: 'system', content: `${cfg.systemKo}\n\n[인텐트 목록]\n${lines.join('\n')}\n\n[출력 형식]\n${OUTPUT_FORMAT_INSTRUCTION}` },
      ...(req.historyMasked ?? []),
      { role: 'user', content: m.text },
    ];
    return {
      messages,
      utteranceMasked: m.text,
      piiMasked: m.masked,
      promptChars: messages.reduce((a, x) => a + x.content.length, 0),
    };
  }

  return {
    contractVersion: LLM_CLASSIFIER_CONTRACT_VERSION,
    engine,

    plan(req) {
      const b = build(req);
      return { messages: b.messages, utteranceMasked: b.utteranceMasked, promptChars: b.promptChars };
    },

    async classify(req) {
      const b = build(req);
      const base = {
        candidates: [] as IntentCandidate[],
        hallucinated: [] as string[],
        engine,
        utteranceMasked: b.utteranceMasked,
        piiMasked: b.piiMasked,
        promptChars: b.promptChars,
        responseChars: 0,
      };

      if ((req.utterance ?? '').trim() === '') {
        // 빈 발화로 엔진을 부르지 않는다 — 비용이고, §11.2 에 정체불명 사용량으로 쌓인다.
        return { ...base, status: 'empty_input', promptChars: 0, reasonKo: '빈 발화라 엔진을 호출하지 않았다' };
      }
      const catalogErrors = validateIntentCatalog(req.catalog);
      if (catalogErrors.length > 0) {
        return { ...base, status: 'invalid_candidates', promptChars: 0, errorCode: 'E_CONFIG', reasonKo: `인텐트 카탈로그가 성립하지 않는다: ${catalogErrors.join(' / ')}` };
      }
      if (req.catalog.tenantId !== cfg.scope.tenantId) {
        return { ...base, status: 'invalid_candidates', promptChars: 0, errorCode: 'E_CONFIG', reasonKo: '다른 테넌트의 카탈로그로 분류할 수 없다 (설계서 §11.1)' };
      }

      let raw: string;
      try {
        raw = await collect(cfg.llm.complete(b.messages), cfg.timeoutMs, cfg.maxResponseChars);
      } catch (err) {
        // 분류 실패로 통화를 끊지 않는다(§9.3). 사유는 마스킹을 지난다(§10.3).
        const e = err instanceof EngineError ? err : undefined;
        const msg = e ? e.message : (err instanceof Error ? err.message : String(err));
        return {
          ...base,
          status: 'engine_error',
          errorCode: e ? e.code : 'E_UNKNOWN',
          reasonKo: maskPii(`LLM 호출 실패: ${msg}`).text,
        };
      }

      const responseChars = raw.length;
      const parsed = parseCandidates(raw);
      if (!parsed.ok) {
        return { ...base, status: parsed.status, responseChars, errorCode: 'E_PROTOCOL', reasonKo: parsed.reasonKo };
      }

      const known = new Set(req.catalog.intents.filter((s) => !s.disabled).map((s) => s.id));
      const hallucinated = parsed.candidates.map((c) => c.intent).filter((id) => !known.has(id));
      return {
        ...base,
        status: 'ok',
        candidates: parsed.candidates,
        hallucinated,
        responseChars,
        reasonKo: hallucinated.length > 0
          ? `후보 ${parsed.candidates.length}건(카탈로그에 없는 id ${hallucinated.length}건 포함 — 버리지 않고 판정에 넘긴다)`
          : `후보 ${parsed.candidates.length}건`,
      };
    },
  };
}
