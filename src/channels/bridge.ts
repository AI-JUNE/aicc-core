// 언어 중립 채널 브리지 — 설계서 §1.2(Core 단일화)·§5.3(하나의 Flow)·§6.2(엔진 비종속)·
// §8.1(이벤트)·§9.3(장애 폴백)·§10.3(마스킹)·§11.1(테넌트 격리)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// 채널 계약(contract.ts)·베이스 포트(basePort.ts)·적합성 실행기(harness.ts)는 모두 **Node 호스트**를
// 전제한다. 챗봇·D-ARS 는 그래서 그대로 붙었다. 그런데 Callbot 저장소는 Node 프로젝트가 아니다 —
// 음성 에이전트는 파이썬 프로세스(agent.py)로 돌아간다. 지금 상태로는 Callbot 이 Core 를 소비할
// 방법이 아예 없고, 그러면 "Core 단일화"는 세 채널 중 두 채널에서만 참인 말이 된다.
// 음성은 가장 먼저 갈라지는 채널이라(DTMF·무음·재발화) 여기서 갈라지면 §2 의 시나리오 이중 관리가
// 그대로 재발한다.
//
// 그래서 Core 소비 경로를 언어에 묶이지 않는 것 하나 더 연다: **한 줄 = 한 요청(JSONL)**.
// 호스트는 표준입력으로 요청 한 줄을 쓰고 표준출력으로 응답 한 줄을 읽는다. 파이썬·자바·Go 어디서든
// 30줄이면 붙고, Core 내부 타입을 알 필요가 없다.
//
// 이 파일은 **프로토콜의 순수 로직**만 담는다(줄 해석·검증·디스패치·응답 생성).
// 표준입출력·프로세스 종료 같은 부작용은 scripts/channel-bridge.mjs 가 맡는다.
//
// 설계 결정 네 가지 (전부 "빠지면 사고가 나는" 지점이다):
//  1) **테넌트는 호스트가 주장하지 않는다.** scope 는 브리지 설정에서 강제 주입한다. 외부 프로세스가
//     스스로 테넌트를 밝히게 두면 §11.1 격리가 프로토콜 한 줄로 무너진다. 요청이 다른 scope 를
//     주장하면 조용히 덮어쓰지 않고 거부한다 — 덮어쓰면 호스트는 자기가 무엇을 열었는지 모른다.
//  2) **어댑터도 고정이다.** 브리지 하나가 채널 하나다. 한 프로세스가 세 채널을 흉내 내면
//     능력 선언(§5.3 사전검증)이 무의미해진다.
//  3) **슬롯 원문과 이관 요약은 기본적으로 나가지 않는다.** 슬롯은 키 목록만, 상담사용 요약은
//     `includeHandoffSummary` 를 켠 소비자에게만 준다(§2·§10.3). 고객 노출 경로가 이 값을 받으면
//     언젠가 화면에 뜬다.
//  4) **어떤 잘못된 줄도 프로세스를 죽이지 않는다.** 빈 줄·깨진 JSON·모르는 op 는 오류 응답이지
//     예외가 아니다. 회선 하나가 이상한 바이트를 보냈다고 통화 전체가 끊기면 안 된다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 여기에는 회선·소켓·프로토콜 코드가 없다. 매체 동작은 ChannelPort 구현이 맡는다.
//  - 기본 `dry_run` 이다. `live` 는 승인 근거(approvalRef)가 있어야만 만들어진다 — [승인 필요].
//  - 상한·예산 기본값을 만들어 넣지 않는다(§13-3). 주지 않으면 그 검사를 건너뛴다.
import { maskPii } from '../core/policyGuard.ts';
import { stripSecrets } from '../obs/errorMonitor.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { FlowInput } from '../flow/runner.ts';
import type { EntryPoint, LatencyMs, UsageMetrics } from '../events/schema.ts';
import type { HealthSample, ComponentId } from '../ops/fallback.ts';
import type {
  ChannelAdapterId, ChannelCapabilities, ChannelSessionRequest, ChannelTurnInput,
  ChannelTurnResult, ConversationCorePort,
} from './contract.ts';
import { CHANNEL_CONTRACT_VERSION } from './contract.ts';
import { profileFor } from './profiles.ts';
import type { ChannelActivation } from './basePort.ts';

/** 프로토콜 버전. 호스트는 hello 응답에서 이 값을 보고 자기 구현과 맞는지 판단한다. */
export const BRIDGE_PROTOCOL_VERSION = 1;

export type BridgeOp = 'hello' | 'start' | 'send' | 'end' | 'health';

const BRIDGE_OPS: ReadonlySet<string> = new Set<BridgeOp>(['hello', 'start', 'send', 'end', 'health']);

export type BridgeErrorCode =
  | 'E_BAD_JSON'       // 줄이 JSON 이 아니다
  | 'E_TOO_LARGE'      // 줄이 상한을 넘었다(상한을 준 경우에만)
  | 'E_BAD_REQUEST'    // 형태·필수값 위반
  | 'E_UNKNOWN_OP'     // 모르는 op
  | 'E_TENANT_SCOPE'   // 호스트가 다른 테넌트를 주장했다(§11.1)
  | 'E_INTERNAL';      // Core 실행 중 예외 — 원문·스택을 노출하지 않는다

export interface BridgeError {
  code: BridgeErrorCode;
  messageKo: string;
}

export interface BridgeResponse {
  /** 요청 id 그대로. id 를 읽지 못한 줄은 null 이다(호스트가 상관을 못 짓는 대신 무응답은 아니다). */
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
}

/** 호스트에게 돌려주는 턴 결과의 **전송용 투영**. Core 내부 타입을 그대로 흘리지 않는다. */
export interface BridgeTurnPayload {
  interactionId: string;
  status: string;
  steps: unknown[];
  state: {
    flowId: string;
    flowVersion: number;
    channel: string;
    currentNodeId: string | null;
    status: string;
    turnCount: number;
    failCount: number;
    /** 값이 아니라 **키만** 나간다. 값이 필요하면 includeSlots 를 켠다(§10.3). */
    slotKeys: string[];
    slots?: Record<string, string>;
  };
  events: unknown[];
  fallback?: unknown;
  handoff?: { queue?: string; summaryAvailable: boolean; summaryMasked?: string };
}

/** 처리 기록. 발화 원문·개인정보를 담지 않는다 — op·판정·마스킹된 사유만 남는다(§10.3). */
export interface BridgeRecord {
  id: string | null;
  op: BridgeOp | null;
  ok: boolean;
  errorCode?: BridgeErrorCode;
  /** 실측 소요(ms). clock 을 주입한 경우에만 채운다 — 만들어 넣지 않는다(§13-3). */
  durationMs?: number;
}

export interface BridgeOptions {
  /** Core 측 실구현(runtime.ts 의 createConversationCore 결과 등). */
  core: ConversationCorePort;
  /** 이 브리지가 대변하는 채널. 요청이 다른 어댑터를 주장하면 거부한다. */
  adapter: ChannelAdapterId;
  /** 강제 주입할 테넌트 스코프(§11.1). 호스트가 바꿀 수 없다. */
  scope: TenantScope;
  capabilities?: ChannelCapabilities;
  /** 기본 dry_run. live 는 approvalRef 가 있어야만 만들어진다 — [승인 필요]. */
  activation?: ChannelActivation;
  approvalRef?: string;
  /** 상담사용 요약을 응답에 실을지. 기본 false(고객 노출 경로 보호, §2·§10.3). */
  includeHandoffSummary?: boolean;
  /** 슬롯 값을 응답에 실을지. 기본 false — 키 목록만 나간다. */
  includeSlots?: boolean;
  /** 한 줄 바이트 상한. 미지정 시 상한 검사를 하지 않는다(§13-3). */
  maxLineBytes?: number;
  /** 실측 소요 계산용 시계(ms). 미주입 시 durationMs 를 기록하지 않는다. */
  clock?: () => number;
  onRecord?: (r: BridgeRecord) => void;
  /** 보관 기록 상한. 장시간 통화에서 메모리가 무한히 늘지 않게 한다. */
  maxRecords?: number;
}

export class BridgeConfigError extends Error {
  constructor(messageKo: string) {
    super(messageKo);
    this.name = 'BridgeConfigError';
  }
}

export interface Bridge {
  readonly protocolVersion: number;
  readonly activation: ChannelActivation;
  readonly records: readonly BridgeRecord[];
  /** 한 줄을 받아 한 응답을 돌려준다. 절대 던지지 않는다. 호출은 도착 순서대로 직렬 처리된다. */
  handleLine(line: string): Promise<BridgeResponse>;
  reset(): void;
}

const DEFAULT_MAX_RECORDS = 500;

/** 응답 한 줄. 개행이 들어가면 프로토콜이 깨지므로 직렬화 결과에서 제거한다. */
export function encodeResponse(res: BridgeResponse): string {
  return JSON.stringify(res).replace(/[\r\n]+/g, ' ');
}

function safeText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return maskPii(stripSecrets(raw)).text;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** 스코프는 부분 일치로 넘기지 않는다 — 키 하나가 빠진 채 통과하면 격리가 반만 걸린다(§11.1). */
function sameScope(a: TenantScope, b: unknown): boolean {
  if (!isPlainObject(b)) return false;
  const mine = a as unknown as Record<string, unknown>;
  return Object.keys(mine).every((k) => b[k] === mine[k])
    && Object.keys(b).every((k) => mine[k] === b[k]);
}

/**
 * 숫자 맵(지연·사용량)은 **아는 키만** 유한·음이 아닌 값으로 통과시킨다.
 * 모르는 키를 그대로 흘리면 과금 집계(§11.2)에 정체불명 필드가 쌓인다 — 거부가 맞다.
 * 없는 값을 0으로 채우지 않는다(§13-3).
 */
function numberMap(v: unknown, allowed: ReadonlySet<string>): Record<string, number> | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) return 'invalid';
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!allowed.has(k)) return 'invalid';
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'invalid';
    out[k] = n;
  }
  return out;
}

const LATENCY_KEYS: ReadonlySet<string> = new Set(['stt_ms', 'llm_ttft_ms', 'tts_ttfb_ms', 'total_ms']);
const USAGE_KEYS: ReadonlySet<string> = new Set([
  'llm_prompt_tokens', 'llm_completion_tokens', 'stt_audio_ms', 'tts_audio_ms',
]);
const HEALTH_STATES: ReadonlySet<string> = new Set(['up', 'degraded', 'down', 'unknown']);

const ENTRY_POINTS: ReadonlySet<string> = new Set<EntryPoint>([
  'inbound_call', 'outbound_call', 'visual_link', 'web_chat', 'app_chat',
]);

class RequestError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, messageKo: string) {
    super(messageKo);
    this.name = 'RequestError';
    this.code = code;
  }
}

function bad(messageKo: string): never {
  throw new RequestError('E_BAD_REQUEST', messageKo);
}

/** 줄 → 요청 객체. 실패는 예외가 아니라 오류 응답이 된다(호출부에서 잡는다). */
export function parseBridgeLine(line: string, maxLineBytes?: number): { id: string | null; op: BridgeOp; body: Record<string, unknown> } {
  if (typeof line !== 'string' || line.trim() === '') {
    throw new RequestError('E_BAD_REQUEST', '빈 줄입니다. 한 줄에 요청 하나를 보냅니다.');
  }
  if (maxLineBytes !== undefined && Buffer.byteLength(line, 'utf8') > maxLineBytes) {
    // 상한을 넘긴 줄은 파싱조차 하지 않는다 — 파싱 비용 자체가 공격 표면이다.
    throw new RequestError('E_TOO_LARGE', `요청 줄이 상한(${maxLineBytes} 바이트)을 넘었습니다.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // 원문을 되돌려주지 않는다. 깨진 줄에 발신번호가 들어 있을 수 있다(§10.3).
    throw new RequestError('E_BAD_JSON', 'JSON 으로 해석할 수 없는 줄입니다.');
  }
  if (!isPlainObject(parsed)) throw new RequestError('E_BAD_REQUEST', '요청은 JSON 객체여야 합니다.');
  const id = typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : null;
  const op = parsed.op;
  if (typeof op !== 'string' || !BRIDGE_OPS.has(op)) {
    const e = new RequestError('E_UNKNOWN_OP', `알 수 없는 op 입니다: ${typeof op === 'string' ? maskPii(op).text : typeof op}`);
    (e as RequestError & { id?: string | null }).id = id;
    throw e;
  }
  if (id === null) throw new RequestError('E_BAD_REQUEST', 'id 가 없습니다. 응답을 상관지을 수 없습니다.');
  return { id, op: op as BridgeOp, body: parsed };
}

function toSessionRequest(body: Record<string, unknown>, opts: BridgeOptions): ChannelSessionRequest {
  const req = isPlainObject(body.req) ? body.req : bad('start 에는 req 객체가 필요합니다.');
  if (req.adapter !== undefined && req.adapter !== opts.adapter) {
    bad(`이 브리지는 ${opts.adapter} 채널입니다. 다른 어댑터(${String(req.adapter)})를 대신 열 수 없습니다.`);
  }
  if (req.scope !== undefined && !sameScope(opts.scope, req.scope)) {
    // 조용히 덮어쓰지 않는다. 호스트는 자기가 어느 테넌트를 열었는지 알아야 한다(§11.1).
    throw new RequestError('E_TENANT_SCOPE', '요청이 브리지 설정과 다른 테넌트를 주장했습니다. 스코프는 호스트가 정하지 않습니다.');
  }
  if (!nonEmptyString(req.flowId)) bad('flowId 가 없습니다.');
  if (!nonEmptyString(req.entryPoint) || !ENTRY_POINTS.has(req.entryPoint)) {
    bad(`entryPoint 가 유효하지 않습니다: ${String(req.entryPoint)}`);
  }
  if (req.flowVersion !== undefined && (typeof req.flowVersion !== 'number' || !Number.isInteger(req.flowVersion) || req.flowVersion < 1)) {
    bad('flowVersion 은 1 이상의 정수여야 합니다.');
  }
  let presetSlots: Record<string, string> | undefined;
  if (req.presetSlots !== undefined) {
    if (!isPlainObject(req.presetSlots)) bad('presetSlots 는 문자열 맵이어야 합니다.');
    presetSlots = {};
    for (const [k, v] of Object.entries(req.presetSlots)) {
      if (typeof v !== 'string') bad(`presetSlots.${k} 가 문자열이 아닙니다.`);
      presetSlots[k] = v;
    }
  }
  const out: ChannelSessionRequest = {
    scope: opts.scope,
    adapter: opts.adapter,
    entryPoint: req.entryPoint as EntryPoint,
    flowId: req.flowId,
  };
  if (typeof req.flowVersion === 'number') out.flowVersion = req.flowVersion;
  if (presetSlots) out.presetSlots = presetSlots;
  if (nonEmptyString(req.joinInteractionId)) out.joinInteractionId = req.joinInteractionId;
  if (nonEmptyString(req.correlationId)) out.correlationId = req.correlationId;
  return out;
}

function toFlowInput(v: unknown): FlowInput {
  if (!isPlainObject(v)) bad('turn.input 이 없습니다.');
  const kind = v.kind;
  switch (kind) {
    case 'utterance': {
      if (typeof v.text !== 'string') bad('utterance 입력에는 text(문자열)가 필요합니다.');
      const input: FlowInput = { kind: 'utterance', text: v.text };
      if (v.confidence !== undefined) {
        if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
          bad('confidence 는 0~1 사이 숫자여야 합니다.');
        }
        input.confidence = v.confidence;
      }
      return input;
    }
    case 'dtmf': {
      if (typeof v.digits !== 'string') bad('dtmf 입력에는 digits(문자열)가 필요합니다.');
      // 회선에서 오는 값이므로 형태를 여기서 막는다. 숫자·*·# 외에는 받지 않는다.
      if (v.digits !== '' && !/^[0-9*#]+$/.test(v.digits)) bad('digits 에 허용되지 않는 문자가 있습니다.');
      return { kind: 'dtmf', digits: v.digits };
    }
    case 'timeout':
      return { kind: 'timeout' };
    case 'connectorResult': {
      // ok 는 명시해야 한다. 빠진 값을 성공으로 읽으면 실패한 조회가 성공으로 흘러간다.
      if (typeof v.ok !== 'boolean') bad('connectorResult 에는 ok(boolean)가 필요합니다.');
      const input: FlowInput = { kind: 'connectorResult', ok: v.ok };
      if (v.slots !== undefined) {
        if (!isPlainObject(v.slots)) bad('connectorResult.slots 는 문자열 맵이어야 합니다.');
        const slots: Record<string, string> = {};
        for (const [k, sv] of Object.entries(v.slots)) {
          if (typeof sv !== 'string') bad(`connectorResult.slots.${k} 가 문자열이 아닙니다.`);
          slots[k] = sv;
        }
        input.slots = slots;
      }
      if (v.errorCode !== undefined) {
        if (typeof v.errorCode !== 'string') bad('connectorResult.errorCode 는 문자열이어야 합니다.');
        input.errorCode = v.errorCode;
      }
      return input;
    }
    default:
      return bad(`알 수 없는 입력 종류입니다: ${typeof kind === 'string' ? maskPii(kind).text : typeof kind}`);
  }
}

function toTurnInput(body: Record<string, unknown>): ChannelTurnInput {
  const turn = isPlainObject(body.turn) ? body.turn : bad('send 에는 turn 객체가 필요합니다.');
  const out: ChannelTurnInput = { input: toFlowInput(turn.input) };
  const latency = numberMap(turn.latency, LATENCY_KEYS);
  if (latency === 'invalid') bad('latency 는 알려진 키의 음이 아닌 유한 숫자여야 합니다.');
  if (latency) out.latency = latency as LatencyMs;
  const usage = numberMap(turn.usage, USAGE_KEYS);
  if (usage === 'invalid') bad('usage 는 알려진 키의 음이 아닌 유한 숫자여야 합니다(§11.2).');
  if (usage) out.usage = usage as UsageMetrics;
  if (turn.confidence !== undefined) {
    if (typeof turn.confidence !== 'number' || !Number.isFinite(turn.confidence) || turn.confidence < 0 || turn.confidence > 1) {
      bad('confidence 는 0~1 사이 숫자여야 합니다.');
    }
    out.confidence = turn.confidence;
  }
  return out;
}

function toHealthSamples(body: Record<string, unknown>): { samples: HealthSample[]; observedAt: string } {
  const report = isPlainObject(body.report) ? body.report : bad('health 에는 report 객체가 필요합니다.');
  if (!nonEmptyString(report.observedAt)) bad('report.observedAt 이 없습니다. 시각은 브리지가 만들어 넣지 않습니다(§13-3).');
  if (!Array.isArray(report.samples)) bad('report.samples 는 배열이어야 합니다.');
  const samples: HealthSample[] = [];
  for (const s of report.samples) {
    if (!isPlainObject(s)) bad('samples 항목은 객체여야 합니다.');
    if (!nonEmptyString(s.component)) bad('samples 항목에 component 가 없습니다.');
    // 알 수 없는 컴포넌트는 여기서 막지 않는다 — Core 가 선언 목록으로 거른다(§9.3).
    if (!nonEmptyString(s.state) || !HEALTH_STATES.has(s.state)) {
      // 상태 없는 샘플을 up 으로 읽으면, 장애 중인 엔진이 정상으로 집계된다(§9.3).
      bad(`samples 항목의 state 가 유효하지 않습니다: ${String(s.state)}`);
    }
    const sample: Record<string, unknown> = {
      component: s.component as ComponentId,
      state: s.state,
      observedAt: nonEmptyString(s.observedAt) ? s.observedAt : report.observedAt,
    };
    for (const key of ['errorRate', 'latencyMs'] as const) {
      if (s[key] === undefined) continue;
      if (typeof s[key] !== 'number' || !Number.isFinite(s[key] as number) || (s[key] as number) < 0) {
        bad(`samples.${key} 는 음이 아닌 유한 숫자여야 합니다(§13-3).`);
      }
      sample[key] = s[key];
    }
    if (s.detail !== undefined) {
      if (typeof s.detail !== 'string') bad('samples.detail 은 문자열이어야 합니다.');
      // 호스트가 보낸 자유 문구다. 저장 경로로 들어가기 전에 여기서 한 번 마스킹한다(§10.3).
      sample.detail = maskPii(s.detail).text;
    }
    samples.push(sample as unknown as HealthSample);
  }
  return { samples, observedAt: report.observedAt };
}

/**
 * 이벤트도 같은 노출 규칙을 받는다.
 *
 * 여기서 한 번 데인 지점이다: handoff.requested 이벤트(§8.1)에는 상담사용 요약 전문이 들어 있고,
 * 그 안에는 수집 슬롯 값과 직전 대화가 통째로 있다. handoff.summaryMasked 만 막고 events 를 그대로
 * 흘리면, "요약은 안 나간다"는 약속이 이벤트 배열 하나로 무효가 된다. 그래서 같은 스위치로 함께 막고,
 * 요약이 있었다는 사실(summary_present)은 남긴다 — 있었는지조차 감추면 이관 누락을 조사할 수 없다.
 */
function projectEvents(events: readonly unknown[], opts: BridgeOptions): unknown[] {
  if (opts.includeHandoffSummary) return events as unknown[];
  return events.map((e) => {
    if (!isPlainObject(e) || e.summary_masked === undefined) return e;
    const { summary_masked: _dropped, ...rest } = e;
    return rest;
  });
}

function projectTurn(r: ChannelTurnResult, opts: BridgeOptions): BridgeTurnPayload {
  const slots = r.state.slots ?? {};
  const payload: BridgeTurnPayload = {
    interactionId: r.interactionId,
    status: r.status,
    steps: r.steps as unknown[],
    state: {
      flowId: r.state.flowId,
      flowVersion: r.state.flowVersion,
      channel: r.state.channel,
      currentNodeId: r.state.currentNodeId,
      status: r.state.status,
      turnCount: r.state.turnCount,
      failCount: r.state.failCount,
      slotKeys: Object.keys(slots),
    },
    events: projectEvents(r.events as unknown[], opts),
  };
  if (opts.includeSlots) payload.state.slots = { ...slots };
  if (r.fallback !== undefined) payload.fallback = r.fallback;
  if (r.handoff !== undefined) {
    const handoff: BridgeTurnPayload['handoff'] = {
      summaryAvailable: r.handoff.summaryMasked !== undefined,
    };
    if (r.handoff.queue !== undefined) handoff.queue = r.handoff.queue;
    // 상담사용 요약은 요청한 소비자에게만 준다. 고객 노출 경로가 이 값을 받으면 언젠가 화면에 뜬다.
    if (opts.includeHandoffSummary && r.handoff.summaryMasked !== undefined) {
      handoff.summaryMasked = r.handoff.summaryMasked;
    }
    payload.handoff = handoff;
  }
  return payload;
}

/**
 * 브리지를 만든다. 설정 오류는 여기서 던진다 — 잘못 켜진 브리지가 조용히 도는 것보다 낫다.
 */
export function createBridge(opts: BridgeOptions): Bridge {
  assertTenantScope(opts.scope);
  const activation: ChannelActivation = opts.activation ?? 'dry_run';
  if (activation === 'live' && !opts.approvalRef) {
    throw new BridgeConfigError('[승인 필요] live 브리지에는 승인 근거(approvalRef)가 필요합니다.');
  }
  if (opts.maxLineBytes !== undefined && (!Number.isInteger(opts.maxLineBytes) || opts.maxLineBytes <= 0)) {
    throw new BridgeConfigError('maxLineBytes 는 양의 정수여야 합니다.');
  }
  const capabilities = opts.capabilities ?? profileFor(opts.adapter);
  if (capabilities.adapter !== opts.adapter) {
    throw new BridgeConfigError(`능력 선언이 어댑터(${opts.adapter})와 어긋납니다.`);
  }

  const records: BridgeRecord[] = [];
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
  // 도착 순서대로 직렬 처리한다. 같은 세션에 두 턴이 겹치면 상태가 갈라지기 때문이다.
  let queue: Promise<unknown> = Promise.resolve();

  function push(r: BridgeRecord): void {
    records.push(r);
    if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
    if (opts.onRecord) {
      try { opts.onRecord(r); } catch { /* 통지 실패가 턴을 죽이지 않는다 */ }
    }
  }

  async function dispatch(op: BridgeOp, body: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'hello':
        return {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          contractVersion: CHANNEL_CONTRACT_VERSION,
          coreContractVersion: opts.core.contractVersion,
          adapter: opts.adapter,
          capabilities,
          activation,
          includesHandoffSummary: opts.includeHandoffSummary === true,
          includesSlots: opts.includeSlots === true,
        };
      case 'start':
        return projectTurn(await opts.core.start(toSessionRequest(body, opts)), opts);
      case 'send': {
        if (!nonEmptyString(body.interactionId)) bad('interactionId 가 없습니다.');
        return projectTurn(await opts.core.send(body.interactionId, toTurnInput(body)), opts);
      }
      case 'end': {
        if (!nonEmptyString(body.interactionId)) bad('interactionId 가 없습니다.');
        if (!nonEmptyString(body.reasonKo)) bad('reasonKo 가 없습니다. 종료 사유 없는 종료는 기록에서 원인을 잃습니다.');
        return projectTurn(await opts.core.end(body.interactionId, body.reasonKo), opts);
      }
      case 'health': {
        const { samples, observedAt } = toHealthSamples(body);
        opts.core.reportHealth({ adapter: opts.adapter, samples, observedAt });
        return { accepted: samples.length };
      }
    }
  }

  async function handleOne(line: string): Promise<BridgeResponse> {
    const started = opts.clock?.();
    const finish = (): number | undefined => (started === undefined || !opts.clock ? undefined : opts.clock() - started);
    let id: string | null = null;
    let op: BridgeOp | null = null;
    try {
      const parsed = parseBridgeLine(line, opts.maxLineBytes);
      id = parsed.id;
      op = parsed.op;
      const result = await dispatch(parsed.op, parsed.body);
      push({ id, op, ok: true, durationMs: finish() });
      return { id, ok: true, result };
    } catch (e) {
      const code: BridgeErrorCode = e instanceof RequestError ? e.code : 'E_INTERNAL';
      const withId = e as RequestError & { id?: string | null };
      if (id === null && typeof withId.id === 'string') id = withId.id;
      // Core 내부 예외의 원문·스택은 호스트에 내보내지 않는다. 마스킹된 한 줄만 남긴다.
      const messageKo = e instanceof RequestError
        ? e.message
        : `Core 처리 중 오류가 발생했습니다: ${safeText(e)}`;
      push({ id, op, ok: false, errorCode: code, durationMs: finish() });
      return { id, ok: false, error: { code, messageKo } };
    }
  }

  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    activation,
    records,
    handleLine(line: string): Promise<BridgeResponse> {
      // 큐가 끊기지 않게 항상 성공으로 이어붙인다. handleOne 은 던지지 않는다.
      const next = queue.then(() => handleOne(line));
      queue = next.catch(() => undefined);
      return next;
    },
    reset() {
      records.length = 0;
      queue = Promise.resolve();
    },
  };
}

/**
 * 여러 줄을 순서대로 처리해 응답 줄들을 돌려준다. 파일·파이프 배치 처리와 테스트에 쓴다.
 * 빈 줄은 조용히 건너뛴다 — 파이프 끝의 개행 하나가 오류 응답을 만들면 로그가 쓰레기가 된다.
 */
export async function runBridgeLines(bridge: Bridge, lines: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    out.push(encodeResponse(await bridge.handleLine(line)));
  }
  return out;
}
