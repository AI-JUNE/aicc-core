// 관측 실행기 — 설계서 §13(운영·모니터링)·§9.3(장애 인지)·§10.3(개인정보 미기록)·
// §11.1(테넌트 격리)·§13-3(실측만)·§2(판정 단일화).
//
// 왜 이 파일이 필요한가:
// `obs/logger.ts`(구조화 로깅)와 `obs/errorMonitor.ts`(오류 수집)는 다 만들어 놓았고
// `COMMERCIAL_READINESS.md` 에 둘 다 `[x]` 로 적혀 있다. 그런데 **저장소 전체에서
// `createLogger` 를 부르는 곳은 자기 테스트뿐이고, `createErrorMonitor`·`installGlobalCapture`
// 도 마찬가지다**(쓰이는 것은 `stripSecrets` 한 함수뿐이다). 즉 통화가 한 턴 돌아도,
// 턴이 예외로 죽어도 **로그 한 줄·보고 한 건이 남지 않는다**. `MONITORING_GUIDE.md` 의
// 2번 단계("전역 오류 지점에 연결")가 Core 에서는 비어 있던 셈이다.
//
// 이 공백의 증상은 장애가 아니라 **장애를 모른다는 것**이다. 지금 상태에서 통화가 실패하면
// 남는 것은 채널 저장소가 각자 찍은 콘솔 줄이고, 그 줄에는 테넌트·상호작용·실패 코드가 없다.
// 사후분석에서 필요한 것이 정확히 그 셋이다.
//
// 그런데 "그냥 결과를 로그에 찍는다"로 메우면 더 비싼 사고가 난다. 호스트가 손으로 꿰면
// 빠지는 것은 취향이 아니라 정해져 있다.
//
//  (가) **발화·슬롯 값·상담사 요약이 로그에 남는다.** 가장 자연스러운 한 줄이
//      `logger.info('turn', { fields: { ...result } })` 인데, 그러면 `steps` 의 문안·
//      `state.slots` 의 값·`handoff.summaryMasked` 가 전부 로그로 간다. "로거가 마스킹을
//      거치니 괜찮다"가 함정이다 — `maskPii` 의 규칙은 **주민·카드·휴대폰·계좌 넷뿐**이고
//      **이름과 주소는 가리지 않는다**(`core/policyGuard.ts` 의 `RULES`). 즉 마스킹을
//      믿고 발화를 실으면 고객의 이름·주소·대화 내용이 그대로 수집기에 쌓인다. 로거의
//      차단 키 목록(`DENIED_FIELDS`)도 `text`·`utterance` 같은 **키 이름**을 보는 것이라
//      `slots`·`summaryMasked`·`steps` 로 감싸 넣으면 걸리지 않는다. 그래서 이 파일은
//      **고정 허용 목록**만 싣는다 — 건수·열거값·불리언·코드뿐이고, 어떤 경로로도 본문을
//      싣지 않는다(허용 목록이 유일한 방어선이다).
//
//  (나) **정상 업무 결과를 장애로 올린다.** 폴백(§9.3)·이관·미획득 동의·미인식은 전부
//      **모델링된 결과**이고 각자의 원장·레지스트리에 이미 남는다. 그것을 `capture` 로
//      올리면 장애 1건이 알림 수천 건이 되고, 수집기는 `maxPerWindow` 상한에 걸려
//      **정작 진짜 예외를 버린다**(`dropped`). 그래서 이 파일의 `capture` 판정은 하나다 —
//      **던져진 호출만 올린다.** 결과를 돌려준 호출은 어떤 모양이든 올리지 않고 로그 수준으로만 가른다.
//
//  (다) **식별자가 고정 필드라 마스킹을 지나지 않는다.** `LogRecord.requestId`·
//      `interactionId` 는 `fields` 가 아니라 **고정 필드**이고, `createLogger` 는 고정 필드를
//      `sanitizeValue` 에 넣지 않는다(코드에서 그대로 실린다). 채널은 상관관계 id 로
//      호 ID 를 넘기는데(`ChannelSessionRequest.correlationId`) 그 자리에 발신번호를 넣는
//      호스트가 있으면 **전화번호가 모든 로그 줄에 영구 보존된다**. 그래서 식별자는
//      `loggableId` 를 지나야만 실린다 — 판정은 `maskPii` 하나를 재사용한다(§2: 여기에
//      개인정보 정규식 사본을 두지 않는다. 검사가 그 사실을 고정한다).
//
//  (라) **로깅이 통화를 끊는다.** `createLogger` 는 sink 예외를 삼키지만, 호스트가 `Logger`
//      인터페이스를 **직접 구현해** 넘기면 그 보장이 없다. 오류 보고 경로의 예외가 원래
//      실패를 덮으면 사후분석은 멀쩡한 코드를 뒤진다. 그래서 `record` 는 **어떤 경우에도
//      던지지 않고**, 실패는 삼키지 않고 `stats().failed` 로 센다(§9.3).
//
//  (마) **시각·소요를 만들어 넣는다.** `clock` 을 주지 않으면 `durationMs` 를 만들지 않는다
//      (§13-3). 시계가 거꾸로 가 음수가 나오면 그것은 실측이 아니므로 **0 으로 적지 않고 비운다**.
//
//  (바) **Core 가 상관관계 id 를 만든다.** 호출마다 새 id 를 만들면 호스트의 추적과 **이어지지
//      않는 id** 가 늘어나고, 그건 없는 것보다 나쁘다(조인할 수 있다고 믿게 된다). 이 파일은
//      id 를 만들지 않는다 — 호스트가 `correlationId` 로 준 것만 쓴다(`createRequestIdFactory`
//      가 필요한 쪽은 호스트다, §13-3).
//
// 무엇을 하지 않는가:
//  - **심각도를 정하지 않는다.** 코드→심각도는 `errorMonitor.ts` 의 `SEVERITY_BY_CODE` 하나다
//    (§2). 여기서 다시 매핑하면 로그와 알림이 서로 다른 기준으로 갈린다.
//  - **오류 원문을 로그 필드로 복사하지 않는다.** 가리기를 마친 원문이 있을 자리는
//    `ErrorReport.messageMasked` 하나다. 그래서 `Logger.time` 을 쓰지 않는다 —
//    `time` 은 실패 시 `fields.reason` 에 `e.message` 를 복사하고, 성공은 **언제나 info** 로
//    적어 폴백·점검 누락을 warn 으로 올릴 수가 없다.
//  - **전송하지 않는다.** sink·transport 미주입이면 완전한 no-op 이고, 배선 자체를 선언하지
//    않으면 **종전과 완전히 같다**(§13-3). 실제 수집기 연결은 **[승인 필요]**.
import { maskPii } from '../core/policyGuard.ts';
import type { TenantScope } from '../core/tenancy.ts';
import type { LogContext, LogLevel, Logger } from './logger.ts';
import type { CaptureContext, ErrorMonitor, ErrorReport } from './errorMonitor.ts';
import { normalizeError } from './errorMonitor.ts';
import type { ChannelAdapterId, ChannelTurnResult } from '../channels/contract.ts';
import type { HealthSample, HealthState } from '../ops/fallback.ts';

export const OBSERVABILITY_CONTRACT_VERSION = 1;

/** 관측 대상 호출. 채널 계약(`ConversationCorePort`)의 네 진입점과 짝이다. */
export type CoreOp = 'start' | 'send' | 'end' | 'health';

/** 로그 이벤트 이름. 자유 문장이 아니라 점 표기 고정값이다(집계·검색이 가능하려면). */
export const OP_EVENT: Record<CoreOp, string> = {
  start: 'core.session.start',
  send: 'core.turn.send',
  end: 'core.session.end',
  health: 'core.health.report',
};

/** 식별자 길이 상한. 긴 값이 모든 로그 줄을 밀어내지 않게 한다. */
const MAX_ID_LEN = 128;

/** 알려진 어댑터 — 계약 밖 문자열을 로그에 그대로 싣지 않기 위한 허용 목록. */
const KNOWN_ADAPTERS: readonly string[] = ['callbot', 'chatbot', 'dars'];

export type LoggableId =
  | { ok: true; value: string }
  | { ok: false; reasonKo: string; piiKinds?: readonly string[] };

/**
 * 식별자를 로그 고정 필드에 실어도 되는지 판정한다.
 *
 * 고정 필드는 로거의 마스킹을 지나지 않으므로(위 (다)) 여기가 유일한 관문이다.
 * **개인정보 판정은 `maskPii` 를 재사용한다** — 정규식을 복사하면 로그 쪽만 낡아서,
 * 저장은 가려지는데 로그에는 남는 상태가 된다(§2·§10.3).
 */
export function loggableId(value: unknown): LoggableId {
  if (typeof value !== 'string') return { ok: false, reasonKo: '식별자가 문자열이 아닙니다.' };
  if (value.trim() === '') return { ok: false, reasonKo: '식별자가 비어 있습니다.' };
  if (value.length > MAX_ID_LEN) {
    return { ok: false, reasonKo: `식별자가 ${MAX_ID_LEN}자를 넘습니다(${value.length}자).` };
  }
  // 제어문자·줄바꿈. `formatLine` 은 JSON 이라 이스케이프하지만, 텍스트 sink·수집기가 그대로
  // 쓰면 한 줄이 두 줄로 쪼개져 그 뒤의 집계·검색이 어긋난다. 애초에 id 에 있을 값이 아니다.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, reasonKo: '식별자에 제어문자·줄바꿈이 있습니다.' };
  }
  const masked = maskPii(value);
  if (masked.masked) {
    // 숫자만으로 만든 통화 id 는 계좌 규칙과 구분할 방법이 없다 — 그래서 가려진 값이 아니라
    // **싣지 않는 쪽**을 고른다. id 생성 규칙을 고치는 것은 채널 저장소 과제다(§10.3 선례와 같다).
    return { ok: false, reasonKo: '식별자가 개인정보 패턴에 걸립니다 — 로그에 싣지 않습니다(§10.3).', piiKinds: masked.hits };
  }
  return { ok: true, value };
}

/** Core 가 수집한 "이 호출에서 무슨 일이 있었는가"의 사실 묶음. 판정은 들어 있지 않다. */
export interface ObservedCall {
  op: CoreOp;
  /**
   * **Core 가 강제하는 스코프**(§11.1). 호스트가 요청에 적어 보낸 값을 그대로 쓰면
   * 같은 로그 안에서 테넌트가 둘이 되고, 그 로그로는 격리 사고를 조사할 수 없다.
   */
  scope: TenantScope;
  /** 채널이 준 상관관계 id(호 ID·대화 ID). `loggableId` 를 지나야 실린다. */
  correlationId?: string;
  interactionId?: string;
  adapter?: string;
  /** 실측 소요. 시계가 없으면 넣지 않는다(§13-3). */
  durationMs?: number;
  /** 성공 시 결과. 본문은 싣지 않고 건수·열거값만 읽는다. */
  result?: ChannelTurnResult;
  /** 실패 시 던져진 값. */
  error?: unknown;
  /** `reportHealth` 관측(§9.3). */
  health?: ObservedHealth;
}

export interface ObservedHealth {
  /** 채널이 밝힌 어댑터. 계약 밖 값이면 로그에 싣지 않는다. */
  adapter?: string;
  /** 등록된 채널의 보고인가. false 면 그 보고는 **통째로 버려진다**. */
  registered: boolean;
  /** 채널이 올린 샘플 수(기록 여부와 무관). 들어온 것과 들어간 것이 다르면 그 차이가 신호다. */
  offered: number;
  /** 레지스트리에 기록된 샘플. */
  accepted: readonly HealthSample[];
  /** 선언하지 않은 컴포넌트라 버려진 샘플 수. */
  ignored: number;
}

export interface ObservationDecision {
  level: LogLevel;
  event: string;
  /** 실패 분류 코드. `normalizeError` 가 정한다 — 여기서 코드를 만들지 않는다. */
  code?: string;
  /** 고정 허용 목록을 지난 부가 필드. 본문·발화·슬롯 값은 어떤 경로로도 들어오지 않는다. */
  fields: Record<string, string | number | boolean>;
  /** 오류 수집기로 올릴 것인가. **던져진 호출만** true 다(위 (나)). */
  capture: boolean;
  /** 로그 고정 필드에 실을 식별자(관문을 지난 것만). */
  ids: { requestId?: string; interactionId?: string };
  /** 관문에 걸려 싣지 못한 식별자 키. 무엇을 숨겼는지는 남긴다. */
  droppedIds?: string[];
  /** 수준을 올린 이유. 비어 있으면 평범한 호출이다. */
  reasonsKo: string[];
}

/** 헬스 상태 중 가장 나쁜 것. 판정이 아니라 집계다(§9.3 모드 판정은 `decideFallbackMode` 하나다). */
function worstState(samples: readonly HealthSample[]): HealthState | undefined {
  let worst: HealthState | undefined;
  for (const s of samples) {
    if (s.state === 'down') return 'down';
    if (s.state === 'degraded') worst = 'degraded';
    else if (worst === undefined) worst = s.state;
  }
  return worst;
}

function countStates(samples: readonly HealthSample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

/**
 * 결과에서 **싣기로 정한 것만** 뽑는다. 허용 목록이 유일한 방어선이므로(위 (가))
 * 이 함수는 `result` 를 펼치지 않고 한 칸씩 적어 넣는다 — 새 필드가 결과에 생겨도
 * 자동으로 로그에 흘러들지 않는다.
 */
function resultFields(result: ChannelTurnResult, out: Record<string, string | number | boolean>, reasons: string[]): void {
  out.status = result.status;
  out.steps = result.steps.length;
  out.events = result.events.length;
  out.channel = result.state.channel;
  out.turnCount = result.state.turnCount;
  out.failCount = result.state.failCount;
  if (result.status === 'failed') reasons.push('시나리오 실행이 failed 로 끝났습니다(§5.1).');

  if (result.fallback !== undefined) {
    out.fallbackMode = result.fallback.mode;
    if (result.fallback.disable.length > 0) out.fallbackDisable = result.fallback.disable.join(',');
    if (result.fallback.causes.length > 0) {
      out.fallbackCauses = result.fallback.causes.map((c) => `${c.component}:${c.state}`).join(',');
    }
    reasons.push(`§9.3 폴백 판정(${result.fallback.mode})으로 응대가 축소됐습니다.`);
  }

  if (result.handoff !== undefined) {
    const p = result.handoff.placement;
    out.handoffPlacement = p === undefined ? 'unbound' : p.placement;
    out.handoffSummaryAttached = result.handoff.summaryMasked !== undefined;
    if (p !== undefined && p.placement === 'alternative') out.handoffAction = p.action;
    if (p !== undefined && p.placement === 'unavailable') out.handoffCode = p.code;
    if (p !== undefined && p.placement === 'queued') out.handoffOverflowed = p.overflowed;
    if (p !== undefined && p.placement !== 'queued') {
      // 큐에 사람이 들어가지 않았다 — 채널이 대안을 수행해야 하는 상태다(§9.3).
      reasonsOnce(reasons, `이관이 큐에 놓이지 않았습니다(${p.placement}) — 채널이 대안을 수행해야 합니다(§9.3).`);
    }
    if (result.handoff.summaryMasked === undefined) {
      reasonsOnce(reasons, '이관 요약이 붙지 않았습니다 — 상담사가 맥락 없이 받습니다(§2).');
    }
  }

  if (result.disclosure !== undefined) {
    out.disclosed = true;
    out.disclosurePlacement = result.disclosure.placement;
    out.disclosureVersion = result.disclosure.configVersion;
  }

  if (result.consent !== undefined) {
    if (result.consent.recorded !== undefined) {
      out.consentPurpose = result.consent.recorded.purpose;
      out.consentState = result.consent.recorded.state;
      out.consentPolicyVersion = result.consent.recorded.policyVersion;
    }
    // 미획득 필수 동의는 **정상 업무 상태**다(아직 묻지 않은 통화가 전부 여기 걸린다) —
    // 건수만 적고 수준을 올리지 않는다(위 (나)).
    if (result.consent.pendingRequired !== undefined) out.consentPending = result.consent.pendingRequired.length;
    if (result.consent.notRecordedKo !== undefined) {
      out.consentNotRecorded = true;
      reasons.push('확정된 동의를 이력에 기록하지 못했습니다(§10.1).');
    }
  }

  if (result.billing !== undefined) {
    if (result.billing.usageAttached !== undefined) out.usageAttached = result.billing.usageAttached;
    if (result.billing.billableMsRecorded !== undefined) out.billableMsRecorded = result.billing.billableMsRecorded;
    if (result.billing.usageAttached === false) {
      reasons.push('실측 사용량을 원장에 실지 못했습니다 — 그 비용은 대사에서 미설명으로 돌아옵니다(§11.2).');
    }
    if (result.billing.billableMsRecorded === false) {
      reasons.push('통화 과금 구간을 원장에 실지 못했습니다 — 이 통화는 통화 분 집계에서 빠집니다(§11.2).');
    }
  }

  if (result.compliance !== undefined) {
    out.qaReviewed = result.compliance.reviewed;
    if (result.compliance.requiresHumanReview !== undefined) out.qaHumanReview = result.compliance.requiresHumanReview;
    if (result.compliance.violated !== undefined) out.qaViolated = result.compliance.violated.length;
    if (result.compliance.skipped !== undefined && result.compliance.skipped.length > 0) {
      out.qaSkipped = result.compliance.skipped.length;
      reasons.push('점검하지 못한 규칙이 있습니다 — 건너뛴 검사는 합격이 아닙니다(§7 5.2).');
    }
    if (result.compliance.reviewed === false) {
      reasons.push('준수 점검을 수행하지 못했습니다 — 위반 0건이 아닙니다(§7 5.2).');
    }
  }
}

/** 같은 사유를 두 번 적지 않는다(한 줄에 같은 문장이 겹치면 읽히지 않는다). */
function reasonsOnce(reasons: string[], text: string): void {
  if (!reasons.includes(text)) reasons.push(text);
}

function healthFields(h: ObservedHealth, out: Record<string, string | number | boolean>, reasons: string[]): void {
  if (h.adapter !== undefined && KNOWN_ADAPTERS.includes(h.adapter)) out.adapter = h.adapter;
  out.registered = h.registered;
  out.offered = h.offered;
  out.samples = h.accepted.length;
  out.ignored = h.ignored;
  if (h.registered && h.offered === 0) {
    reasons.push('헬스 보고에 샘플이 한 건도 없습니다 — 상태를 올렸다는 사실만으로는 §9.3 판정이 움직이지 않습니다.');
  }
  if (h.accepted.length > 0) {
    out.components = [...new Set(h.accepted.map((s) => s.component))].join(',');
    for (const [state, n] of Object.entries(countStates(h.accepted))) out[`state_${state}`] = n;
  }
  const worst = worstState(h.accepted);
  if (worst !== undefined) out.worstState = worst;

  if (!h.registered) {
    // 등록되지 않은 채널의 보고는 **통째로 버려진다**. 지금까지 그 사실이 어디에도 남지 않아,
    // 헬스를 성실히 올리는 채널이 실은 아무 신호도 전달하지 못하는 상태와 구분되지 않았다.
    reasons.push('등록되지 않은 채널의 헬스 보고입니다 — 이 보고는 §9.3 판정에 전혀 닿지 않습니다.');
  }
  if (h.ignored > 0) {
    reasons.push(`선언하지 않은 컴포넌트의 샘플 ${h.ignored}건이 버려졌습니다 — 그 장애는 §9.3 판정에 닿지 않습니다.`);
  }
  if (worst === 'down' || worst === 'degraded') {
    reasons.push(`엔진·회선 상태가 ${worst} 로 보고됐습니다(§9.3).`);
  }
}

/**
 * 사실 → 판정. 순수 함수다(시계·전송·상태 없음).
 *
 * 수준은 네 갈래로만 갈린다: 던졌으면 error · 운영이 보아야 할 것이 있으면 warn ·
 * 그 외는 info. debug 는 만들지 않는다(Core 가 정할 근거가 없다, §13-3).
 */
export function classifyCall(call: ObservedCall): ObservationDecision {
  const fields: Record<string, string | number | boolean> = { op: call.op };
  const reasonsKo: string[] = [];
  const droppedIds: string[] = [];
  const ids: { requestId?: string; interactionId?: string } = {};

  if (call.adapter !== undefined && KNOWN_ADAPTERS.includes(call.adapter)) fields.adapter = call.adapter;

  // 식별자 관문(위 (다)). 걸린 값은 **싣지 않고 걸렸다는 사실만** 남긴다.
  if (call.correlationId !== undefined) {
    const chk = loggableId(call.correlationId);
    if (chk.ok) ids.requestId = chk.value;
    else {
      droppedIds.push('correlationId');
      if (chk.piiKinds !== undefined && chk.piiKinds.length > 0) fields.correlationIdPiiKinds = chk.piiKinds.join(',');
    }
  }
  if (call.interactionId !== undefined) {
    const chk = loggableId(call.interactionId);
    if (chk.ok) ids.interactionId = chk.value;
    else {
      droppedIds.push('interactionId');
      if (chk.piiKinds !== undefined && chk.piiKinds.length > 0) fields.interactionIdPiiKinds = chk.piiKinds.join(',');
    }
  }
  if (droppedIds.length > 0) {
    reasonsKo.push(`식별자 ${droppedIds.join('·')} 를 로그에 싣지 않았습니다 — 개인정보·형식 위반입니다(§10.3).`);
  }

  if (call.error !== undefined) {
    // 코드는 `normalizeError` 가 정한다(§2) — 여기서 분류 규칙을 다시 쓰지 않는다.
    const code = normalizeError(call.error).code;
    fields.outcome = 'threw';
    return {
      level: 'error',
      event: OP_EVENT[call.op],
      code,
      fields,
      capture: true,
      ids,
      ...(droppedIds.length > 0 ? { droppedIds } : {}),
      reasonsKo: [...reasonsKo, 'Core 진입점이 예외로 끝났습니다.'],
    };
  }

  fields.outcome = 'ok';
  if (call.health !== undefined) healthFields(call.health, fields, reasonsKo);
  if (call.result !== undefined) resultFields(call.result, fields, reasonsKo);

  return {
    // 던지지 않은 호출은 **올리지 않는다**(위 (나)) — 모델링된 결과는 각자의 원장에 이미 있다.
    level: reasonsKo.length > 0 ? 'warn' : 'info',
    event: OP_EVENT[call.op],
    fields,
    capture: false,
    ids,
    ...(droppedIds.length > 0 ? { droppedIds } : {}),
    reasonsKo,
  };
}

export interface ObservabilityBinding {
  /** 구조화 로거. 주지 않으면 로그를 남기지 않는다(완전한 no-op). */
  logger?: Logger;
  /** 오류 수집기. 주지 않으면 보고하지 않는다. 실제 전송 연결은 **[승인 필요]**. */
  monitor?: ErrorMonitor;
  /** 소요 측정용 ms 시계. 주지 않으면 `durationMs` 를 만들지 않는다(§13-3). */
  clock?: () => number;
}

export interface ObserverStats {
  /** `record` 호출 수. */
  recorded: number;
  /** 로거에 넘긴 수. */
  logged: number;
  /** 수집기에 올린 수. */
  captured: number;
  /** 로거·수집기·판정이 던져서 처리하지 못한 수. 삼키지 않고 센다. */
  failed: number;
  /** 식별자 관문에 걸려 싣지 못한 수. 호스트의 id 생성 규칙 결함 신호다. */
  droppedIds: number;
}

export interface Observer {
  readonly contractVersion: number;
  /** 로그·수집기가 하나라도 붙어 있는가. false 면 `record` 는 판정만 하고 아무 데도 쓰지 않는다. */
  readonly active: boolean;
  /** 측정 시작. 시계가 없으면 `undefined` — 소요를 만들지 않는다(§13-3). */
  startedAt(): number | undefined;
  /** 실측 소요. 시계가 없거나 시계가 역행했으면 `undefined`(0 으로 적지 않는다). */
  elapsed(started: number | undefined): number | undefined;
  /**
   * 한 호출 관측. **어떤 경우에도 던지지 않는다**(위 (라)).
   * 판정을 돌려주는 것은 호스트가 그 줄을 자기 화면·테스트에서 확인할 수 있게 하기 위한 것이고,
   * Core 의 턴 결과(`ChannelTurnResult`)에는 아무것도 싣지 않는다 — 관측이 고객 경로로
   * 나가면 오류 원문이 화면에 뜬다(§10.3).
   */
  record(call: ObservedCall): ObservationDecision | undefined;
  /** 수집기에 남은 억제분을 내보낸다(프로세스 종료 직전). 수집기가 없으면 0. */
  flush(): number;
  stats(): ObserverStats;
}

export function createObserver(binding: ObservabilityBinding = {}): Observer {
  const stats: ObserverStats = { recorded: 0, logged: 0, captured: 0, failed: 0, droppedIds: 0 };

  function emit(decision: ObservationDecision, call: ObservedCall): void {
    const ctx: LogContext = {
      scope: call.scope,
      ...(decision.ids.requestId !== undefined ? { requestId: decision.ids.requestId } : {}),
      ...(decision.ids.interactionId !== undefined ? { interactionId: decision.ids.interactionId } : {}),
      ...(decision.code !== undefined ? { code: decision.code } : {}),
      ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
      fields: decision.fields,
    };
    const logger = binding.logger;
    if (logger !== undefined) {
      try {
        // 수준별로 직접 부른다 — `time` 은 성공을 언제나 info 로 적고 오류 원문을 필드로
        // 복사하므로 쓰지 않는다(머리말 참조).
        if (decision.level === 'error') logger.error(decision.event, ctx);
        else if (decision.level === 'warn') logger.warn(decision.event, ctx);
        else if (decision.level === 'debug') logger.debug(decision.event, ctx);
        else logger.info(decision.event, ctx);
        stats.logged += 1;
      } catch {
        stats.failed += 1;      // 로깅 실패가 통화를 끊지 않는다. 다만 삼키지 않고 센다.
      }
    }
    const monitor = binding.monitor;
    if (decision.capture && monitor !== undefined) {
      const capture: CaptureContext = {
        scope: call.scope,
        ...(decision.ids.requestId !== undefined ? { requestId: decision.ids.requestId } : {}),
        ...(decision.ids.interactionId !== undefined ? { interactionId: decision.ids.interactionId } : {}),
        fields: decision.fields,
      };
      try {
        // 심각도·코드를 넘기지 않는다 — 코드→심각도 매핑은 `errorMonitor.ts` 하나다(§2).
        monitor.capture(call.error, capture);
        stats.captured += 1;
      } catch {
        stats.failed += 1;
      }
    }
  }

  return {
    contractVersion: OBSERVABILITY_CONTRACT_VERSION,
    active: binding.logger !== undefined || binding.monitor !== undefined,
    startedAt: () => {
      try {
        const v = binding.clock?.();
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      } catch {
        return undefined;     // 시계가 던지면 소요를 만들지 않는다(§13-3)
      }
    },
    elapsed: (started) => {
      if (started === undefined || binding.clock === undefined) return undefined;
      let now: number | undefined;
      try {
        now = binding.clock();
      } catch {
        return undefined;
      }
      if (typeof now !== 'number' || !Number.isFinite(now)) return undefined;
      const d = now - started;
      // 시계 역행은 실측이 아니다. 0 으로 적으면 "0ms 에 끝났다"가 되어 지연 조사가 엉뚱해진다.
      return d < 0 ? undefined : d;
    },
    record: (call) => {
      stats.recorded += 1;
      let decision: ObservationDecision;
      try {
        decision = classifyCall(call);
      } catch {
        stats.failed += 1;
        return undefined;     // 판정이 던져도 호출자에게 전파하지 않는다
      }
      if (decision.droppedIds !== undefined) stats.droppedIds += decision.droppedIds.length;
      emit(decision, call);
      return decision;
    },
    flush: () => {
      const monitor = binding.monitor;
      if (monitor === undefined) return 0;
      try {
        return monitor.flush();
      } catch {
        stats.failed += 1;
        return 0;
      }
    },
    stats: () => ({ ...stats }),
  };
}

/** 보고용 한 줄 요약. 수치는 전부 실측이다 — 비율·점수를 만들지 않는다(§13-3). */
export function formatObserverStats(s: ObserverStats): string {
  return `관측 ${s.recorded}건 · 로그 ${s.logged} · 보고 ${s.captured} · 실패 ${s.failed} · 식별자 제외 ${s.droppedIds}`;
}

/** 수집기 보고의 식별 정보만 뽑는다(호스트가 사용자에게 오류 id 를 보여줄 때 쓴다). */
export function reportRef(report: ErrorReport | undefined): { fingerprint: string; code: string } | undefined {
  return report === undefined ? undefined : { fingerprint: report.fingerprint, code: report.code };
}

/** 어댑터 문자열이 계약 안에 있는가. 로그에 싣기 전 확인용. */
export function isKnownAdapter(value: unknown): value is ChannelAdapterId {
  return typeof value === 'string' && KNOWN_ADAPTERS.includes(value);
}
