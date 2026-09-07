// 브리지 대화 기록(transcript) 검증 — 비-Node 호스트가 만든 **클라이언트 구현**을 CI 에서 판정한다.
// 설계서 §1.2(Core 단일화)·§2(시나리오 단일화)·§8.1(이벤트)·§10.3(마스킹)·§11.1(테넌트 격리)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// bridge.ts 는 **Core 쪽**이 프로토콜을 지키는지를 보장한다. 그런데 실제로 사고를 내는 쪽은 반대편이다 —
// 파이썬·자바로 30줄짜리 클라이언트를 쓰다 보면 다음이 조용히 빠진다.
//   · `end` 를 안 부른다 → 세션이 안 닫히고 회선·집계가 샌다(장애가 아니라 요금으로 먼저 나타난다).
//   · `hello` 를 건너뛴다 → 프로토콜 버전이 어긋나도 아무도 모른다.
//   · 요청에 자기 테넌트를 실어 보낸다 → 지금은 브리지가 막지만, 클라이언트가 그걸 **보내려 했다는 사실**
//     자체가 결함이다(§11.1). 막힌 시도는 다음 버전에서 통과할 수도 있다.
//   · 응답을 그대로 로그·화면에 흘린다 → 상담사용 요약·슬롯 값이 고객 경로로 샌다(§2·§10.3).
// 이 검사는 채널 저장소가 자기 클라이언트를 **Core 타입을 몰라도** 검증할 수 있게 한다:
// 보낸 줄과 받은 줄을 그대로 모아 넘기면 판정이 나온다. 언어를 가리지 않는다.
//
// 순수 함수다. 파일·프로세스·네트워크를 만지지 않는다(부작용은 scripts/bridge-transcript.mjs 가 맡는다).
//
// 무엇을 하지 않는가:
//  - 성능·품질 수치를 만들지 않는다. 건수만 센다(§13-3).
//  - 상한을 주지 않으면 그 검사를 **건너뛰고, 건너뛴 사실을 판정보류로 남긴다** — 통과로 적지 않는다.
import { maskPii } from '../core/policyGuard.ts';
import type { ChannelAdapterId } from './contract.ts';
import type { HarnessVerdict } from './harness.ts';
import { HARNESS_EXIT_CODE } from './harness.ts';
import { BRIDGE_PROTOCOL_VERSION } from './bridge.ts';

export type TranscriptVerdict = HarnessVerdict;

/** 하네스와 같은 종료코드를 쓴다 — CI 가 두 게이트를 같은 규칙으로 읽는다. */
export const TRANSCRIPT_EXIT_CODE: Record<TranscriptVerdict, number> = HARNESS_EXIT_CODE;

export type TranscriptIssueCode =
  | 'E_BAD_REQUEST_LINE'   // 보낸 줄이 JSON 객체가 아니다
  | 'E_BAD_RESPONSE_LINE'  // 받은 줄이 JSON 객체가 아니다
  | 'E_EMBEDDED_NEWLINE'   // 보낸 줄에 개행이 들어 있다(한 줄 = 한 요청이 깨진다)
  | 'E_TOO_LARGE'          // 상한을 넘긴 줄(상한을 준 경우에만)
  | 'E_NO_ID'              // id 가 없다 — 응답을 상관지을 수 없다
  | 'E_DUP_ID'             // id 가 중복이다 — 어느 응답이 어느 요청인지 확정할 수 없다
  | 'E_UNKNOWN_OP'
  | 'E_NO_HELLO'           // 프로토콜 버전을 확인하지 않고 붙었다
  | 'E_PROTOCOL_VERSION'   // hello 응답의 프로토콜 버전이 이 Core 와 다르다
  | 'E_ADAPTER'            // hello 응답의 채널이 기대와 다르다
  | 'E_SCOPE_CLAIM'        // 클라이언트가 테넌트를 주장했다(§11.1)
  | 'E_UNPAIRED'           // 요청/응답 개수·순서·id 가 어긋난다
  | 'E_END_NO_REASON'      // 종료 사유 없는 end — 기록에서 원인을 잃는다
  | 'E_UNKNOWN_INTERACTION'// start 로 받은 적 없는 interactionId 를 썼다
  | 'E_SESSION_LEAK'       // 시작만 하고 끝내지 않은 세션이 있다
  | 'E_SUMMARY_LEAK'       // 허용하지 않은 상담사용 요약이 응답에 실렸다(§2·§10.3)
  | 'E_SLOT_LEAK'          // 허용하지 않은 슬롯 값이 응답에 실렸다(§10.3)
  | 'W_ALL_ERRORS'         // 모든 응답이 오류다 — 클라이언트가 무엇도 성공시키지 못했다
  | 'W_NO_HEALTH';         // 헬스 보고가 한 번도 없다(§9.3 폴백 판단 근거가 안 쌓인다)

export interface TranscriptIssue {
  code: TranscriptIssueCode;
  severity: 'error' | 'warning';
  /** 요청 줄 번호(0-base). 줄과 무관한 결함은 없다. */
  index?: number;
  messageKo: string;
}

export interface TranscriptExpectations {
  /** 이 클라이언트가 대변해야 하는 채널. 주지 않으면 어댑터 확인을 건너뛴다(판정보류). */
  adapter?: ChannelAdapterId;
  /** 상담사용 요약 수신이 허용된 소비자인가. 기본 false — 고객 노출 경로 보호(§2·§10.3). */
  includeHandoffSummary?: boolean;
  /** 슬롯 값 수신이 허용된 소비자인가. 기본 false. */
  includeSlots?: boolean;
  /** 한 줄 바이트 상한. 주지 않으면 상한 검사를 건너뛴다(§13-3, 기본값 금지). */
  maxLineBytes?: number;
  /** 헬스 보고 누락을 경고로 볼지. 주지 않으면 그 검사를 하지 않는다. */
  expectHealthReport?: boolean;
}

export interface TranscriptReport {
  verdict: TranscriptVerdict;
  exitCode: number;
  requestCount: number;
  responseCount: number;
  okCount: number;
  failedResponseCount: number;
  /** op 별 요청 건수. 판단 점수가 아니라 실측 건수다(§13-3). */
  opCounts: Readonly<Record<string, number>>;
  startedInteractions: number;
  endedInteractions: number;
  errorCount: number;
  warningCount: number;
  issues: readonly TranscriptIssue[];
  /** 건너뛴 검사 사유. 하나라도 있으면 통과가 아니라 판정보류다. */
  reasonsKo: readonly string[];
}

const OPS: ReadonlySet<string> = new Set(['hello', 'start', 'send', 'end', 'health']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 호스트가 정한 id·op 를 메시지에 실을 때는 반드시 지운다 — 통화 id 가 발신번호인 현장이 있다(§10.3). */
function safeLabel(v: unknown): string {
  return maskPii(typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).text;
}

function parseLine(line: unknown): Record<string, unknown> | null {
  if (typeof line !== 'string' || line.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 응답 어디에든 상담사용 요약이 실렸는지. handoff 한 곳만 보면 events 배열로 빠져나간다(§8.1). */
function findSummary(result: unknown): boolean {
  if (!isPlainObject(result)) return false;
  const handoff = result.handoff;
  if (isPlainObject(handoff) && handoff.summaryMasked !== undefined) return true;
  const events = result.events;
  if (Array.isArray(events)) {
    return events.some((e) => isPlainObject(e) && e.summary_masked !== undefined);
  }
  return false;
}

function findSlots(result: unknown): boolean {
  if (!isPlainObject(result)) return false;
  const state = result.state;
  return isPlainObject(state) && state.slots !== undefined;
}

/**
 * 기록을 검증한다. 던지지 않는다 — CI 출력에서 "무엇이 왜 틀렸는지"가 항목 단위로 보여야 한다.
 *
 * 요청과 응답은 **보낸 순서 그대로** 짝지어 넘긴다. 브리지가 직렬 처리하므로 순서는 곧 계약이다.
 */
export function verifyBridgeTranscript(
  transcript: { requests?: readonly string[]; responses?: readonly string[] },
  expectations: TranscriptExpectations = {},
): TranscriptReport {
  const issues: TranscriptIssue[] = [];
  const reasonsKo: string[] = [];
  const requests = Array.isArray(transcript?.requests) ? transcript.requests : [];
  const responses = Array.isArray(transcript?.responses) ? transcript.responses : [];
  const opCounts: Record<string, number> = {};
  const seenIds = new Set<string>();
  const openInteractions = new Set<string>();
  const knownInteractions = new Set<string>();
  let endedInteractions = 0;
  let startedInteractions = 0;
  let okCount = 0;
  let failedResponseCount = 0;
  let helloSeen = false;
  let healthSeen = false;

  if (requests.length === 0) {
    // 빈 기록을 통과로 적으면 "클라이언트를 안 돌린 것"이 초록으로 남는다.
    reasonsKo.push('보낸 요청 줄이 없습니다. 기록이 비어 있으면 클라이언트가 무엇을 지켰는지 알 수 없습니다.');
  }
  if (requests.length !== responses.length) {
    issues.push({
      code: 'E_UNPAIRED',
      severity: 'error',
      messageKo: `요청 ${requests.length}줄에 응답 ${responses.length}줄입니다. 브리지는 요청 한 줄에 응답 한 줄을 돌려줍니다 — 짝이 어긋나면 어느 응답을 읽고 있는지 알 수 없습니다.`,
    });
  }

  for (let i = 0; i < requests.length; i += 1) {
    const raw = requests[i];
    if (typeof raw === 'string' && /[\r\n]/.test(raw)) {
      issues.push({
        code: 'E_EMBEDDED_NEWLINE',
        severity: 'error',
        index: i,
        messageKo: '보낸 줄에 개행이 들어 있습니다. 한 줄 = 한 요청 규약이 깨져 브리지가 다른 요청으로 읽습니다.',
      });
    }
    if (expectations.maxLineBytes !== undefined && typeof raw === 'string'
      && Buffer.byteLength(raw, 'utf8') > expectations.maxLineBytes) {
      issues.push({
        code: 'E_TOO_LARGE',
        severity: 'error',
        index: i,
        messageKo: `보낸 줄이 상한(${expectations.maxLineBytes} 바이트)을 넘었습니다.`,
      });
    }

    const req = parseLine(raw);
    if (!req) {
      issues.push({
        code: 'E_BAD_REQUEST_LINE',
        severity: 'error',
        index: i,
        // 원문을 되싣지 않는다 — 깨진 줄에 발신번호가 들어 있을 수 있다(§10.3).
        messageKo: '보낸 줄이 JSON 객체가 아닙니다.',
      });
      continue;
    }

    const id = req.id;
    if (typeof id !== 'string' || id === '') {
      issues.push({ code: 'E_NO_ID', severity: 'error', index: i, messageKo: 'id 가 없습니다. 응답을 요청에 상관지을 수 없습니다.' });
    } else if (seenIds.has(id)) {
      issues.push({ code: 'E_DUP_ID', severity: 'error', index: i, messageKo: `id 가 중복입니다: ${safeLabel(id)}` });
    } else {
      seenIds.add(id);
    }

    const op = req.op;
    if (typeof op !== 'string' || !OPS.has(op)) {
      issues.push({ code: 'E_UNKNOWN_OP', severity: 'error', index: i, messageKo: `알 수 없는 op 입니다: ${safeLabel(op)}` });
      continue;
    }
    opCounts[op] = (opCounts[op] ?? 0) + 1;
    if (op === 'hello') helloSeen = true;
    if (op === 'health') healthSeen = true;

    if (op === 'start') {
      const body = isPlainObject(req.req) ? req.req : undefined;
      if (body && body.scope !== undefined) {
        issues.push({
          code: 'E_SCOPE_CLAIM',
          severity: 'error',
          index: i,
          messageKo: '요청이 테넌트(scope)를 실어 보냈습니다. 테넌트는 브리지 설정이 정합니다 — 클라이언트가 주장해서는 안 됩니다(§11.1).',
        });
      }
    }
    if (op === 'end') {
      const reason = req.reasonKo;
      if (typeof reason !== 'string' || reason.trim() === '') {
        issues.push({
          code: 'E_END_NO_REASON',
          severity: 'error',
          index: i,
          messageKo: '종료 사유(reasonKo) 없는 end 입니다. 사유 없는 종료는 기록에서 원인을 잃습니다.',
        });
      }
    }

    // ── 짝지어진 응답 확인 ──
    if (i >= responses.length) continue; // 짝 없는 요청은 위에서 E_UNPAIRED 로 이미 잡혔다
    const res = parseLine(responses[i]);
    if (!res) {
      issues.push({ code: 'E_BAD_RESPONSE_LINE', severity: 'error', index: i, messageKo: '받은 줄이 JSON 객체가 아닙니다.' });
      continue;
    }
    if (typeof id === 'string' && id !== '' && res.id !== id) {
      issues.push({
        code: 'E_UNPAIRED',
        severity: 'error',
        index: i,
        messageKo: `응답 id 가 요청과 다릅니다(요청 ${safeLabel(id)} · 응답 ${safeLabel(res.id)}). 순서를 잘못 읽고 있습니다.`,
      });
    }
    if (res.ok === true) okCount += 1;
    else failedResponseCount += 1;

    if (op === 'hello' && res.ok === true && isPlainObject(res.result)) {
      const pv = res.result.protocolVersion;
      if (pv !== BRIDGE_PROTOCOL_VERSION) {
        issues.push({
          code: 'E_PROTOCOL_VERSION',
          severity: 'error',
          index: i,
          messageKo: `브리지 프로토콜 버전이 ${safeLabel(pv)} 입니다(이 Core 는 ${BRIDGE_PROTOCOL_VERSION}). 버전이 다르면 필드 해석이 어긋납니다.`,
        });
      }
      if (expectations.adapter !== undefined && res.result.adapter !== expectations.adapter) {
        issues.push({
          code: 'E_ADAPTER',
          severity: 'error',
          index: i,
          messageKo: `브리지 채널이 ${safeLabel(res.result.adapter)} 입니다(기대 ${expectations.adapter}). 브리지 하나가 채널 하나입니다.`,
        });
      }
    }

    if (res.ok === true && (op === 'start' || op === 'send' || op === 'end')) {
      if (!expectations.includeHandoffSummary && findSummary(res.result)) {
        issues.push({
          code: 'E_SUMMARY_LEAK',
          severity: 'error',
          index: i,
          messageKo: '상담사용 요약이 응답에 실렸습니다. 이 소비자는 요약 수신이 허용되지 않았습니다 — 고객 노출 경로로 새면 화면에 뜹니다(§2·§10.3).',
        });
      }
      if (!expectations.includeSlots && findSlots(res.result)) {
        issues.push({
          code: 'E_SLOT_LEAK',
          severity: 'error',
          index: i,
          messageKo: '슬롯 값이 응답에 실렸습니다. 이 소비자는 값 수신이 허용되지 않았습니다 — 키 목록만 받아야 합니다(§10.3).',
        });
      }
      const result = isPlainObject(res.result) ? res.result : undefined;
      const interactionId = result && typeof result.interactionId === 'string' ? result.interactionId : undefined;
      if (op === 'start' && interactionId) {
        startedInteractions += 1;
        knownInteractions.add(interactionId);
        openInteractions.add(interactionId);
      }
    }

    if (op === 'send' || op === 'end') {
      const target = req.interactionId;
      if (typeof target === 'string' && target !== '') {
        if (!knownInteractions.has(target)) {
          issues.push({
            code: 'E_UNKNOWN_INTERACTION',
            severity: 'error',
            index: i,
            messageKo: 'start 로 받은 적 없는 interactionId 를 사용했습니다. 클라이언트가 식별자를 스스로 만들고 있습니다.',
          });
        } else if (op === 'end') {
          if (openInteractions.delete(target)) endedInteractions += 1;
        }
      }
    }
  }

  if (requests.length > 0 && !helloSeen) {
    issues.push({
      code: 'E_NO_HELLO',
      severity: 'error',
      messageKo: 'hello 를 한 번도 부르지 않았습니다. 프로토콜 버전을 확인하지 않고 붙으면 버전 불일치가 조용히 지나갑니다.',
    });
  }
  if (openInteractions.size > 0) {
    issues.push({
      code: 'E_SESSION_LEAK',
      severity: 'error',
      messageKo: `시작만 하고 끝내지 않은 세션이 ${openInteractions.size}건입니다. 닫히지 않은 세션은 장애가 아니라 집계·요금으로 먼저 나타납니다.`,
    });
  }
  if (requests.length > 0 && okCount === 0) {
    issues.push({
      code: 'W_ALL_ERRORS',
      severity: 'warning',
      messageKo: '성공한 응답이 하나도 없습니다. 이 기록은 클라이언트가 Core 를 실제로 소비했음을 보이지 못합니다.',
    });
  }
  if (expectations.expectHealthReport === true && !healthSeen) {
    issues.push({
      code: 'W_NO_HEALTH',
      severity: 'warning',
      messageKo: '헬스 보고(health)가 한 번도 없습니다. 폴백 판단 근거가 쌓이지 않습니다(§9.3).',
    });
  }

  if (expectations.maxLineBytes === undefined) {
    reasonsKo.push('줄 길이 상한(maxLineBytes)을 주지 않아 상한 검사를 건너뛰었습니다. 건너뛴 검사는 통과의 근거가 아닙니다(§13-3).');
  }
  if (expectations.adapter === undefined) {
    reasonsKo.push('기대 채널(adapter)을 주지 않아 채널 확인을 건너뛰었습니다.');
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  let verdict: TranscriptVerdict;
  if (errorCount > 0) verdict = 'failed';
  else if (reasonsKo.length > 0) verdict = 'inconclusive';
  else verdict = 'passed';

  return {
    verdict,
    exitCode: TRANSCRIPT_EXIT_CODE[verdict],
    requestCount: requests.length,
    responseCount: responses.length,
    okCount,
    failedResponseCount,
    opCounts: Object.freeze({ ...opCounts }),
    startedInteractions,
    endedInteractions,
    errorCount,
    warningCount,
    issues,
    reasonsKo,
  };
}

/** 사람이 읽는 한 덩어리. 수치는 전부 실측 건수다(§13-3). */
export function formatTranscriptReport(r: TranscriptReport): string {
  const verdictKo = r.verdict === 'passed' ? '통과' : r.verdict === 'inconclusive' ? '판정보류' : '실패';
  const lines: string[] = [
    `브리지 기록 검증: ${verdictKo} (오류 ${r.errorCount} · 경고 ${r.warningCount})`,
    `요청 ${r.requestCount}줄 · 응답 ${r.responseCount}줄 · 성공 ${r.okCount} · 오류응답 ${r.failedResponseCount}`,
    `세션 시작 ${r.startedInteractions} · 종료 ${r.endedInteractions}`,
  ];
  const ops = Object.entries(r.opCounts);
  if (ops.length > 0) lines.push(`op: ${ops.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  for (const i of r.issues) {
    lines.push(`[${i.severity === 'error' ? '오류' : '경고'}] ${i.code}${i.index === undefined ? '' : ` (줄 ${i.index + 1})`} — ${i.messageKo}`);
  }
  for (const reason of r.reasonsKo) lines.push(`[판정보류] ${reason}`);
  return lines.join('\n');
}
