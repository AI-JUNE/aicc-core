// 커넥터 실행 오케스트레이터 — 설계서 §6.1(연동)·§5.3(Api 노드)·§9.3(폴백)·§10.1(동의)·
// §10.3(개인정보·국외이전)·§11.1(테넌트 격리)·§13-3(임의 기본값 금지).
//
// `connector.ts` 에 조각은 다 있었다 — 선언 검증·요청 조립·기록용 마스킹·응답 적용·실패 판정.
// 그런데 **그 조각들을 순서대로 꿰는 코드가 없었다**. Runner 주석이 말하는 "호스트가 Api 단계를 보고
// 호출한 뒤 결과만 되돌려준다"의 그 '호출한 뒤' 전부가 빈 자리였고, 그대로 두면 채널 3곳이 각자
// 같은 20줄을 쓰게 된다. 그 20줄에서 빠지는 것은 취향이 아니라 정해져 있다.
//   1) **재시도마다 멱등 키를 새로 만든다.** command 커넥터에서 이건 이중 신청·이중 해지로 나타나고,
//      장애 로그에는 성공 두 건만 남는다. 그래서 키는 **호출자가 주고 시도 간 절대 바뀌지 않는다**.
//   2) **동의 게이트를 건너뛴다.** pii 파라미터가 선언돼 있는데 §10.1 확인 없이 주민번호가 나간다.
//      여기서는 동의 컨텍스트가 **없으면 호출하지 않는다** — 없음을 통과로 읽지 않는다.
//   3) **국외이전 게이트를 건너뛴다.** `assertConnectorResidency` 는 아무도 부르지 않으면 없는 것과 같다.
//   4) **선언 검증을 건너뛴다.** 예약 슬롯 덮어쓰기·중복 출력 슬롯이 통화 중에 드러난다.
//   5) **포트 예외가 통화를 끊는다.** 업무시스템 어댑터의 버그 하나로 콜이 죽으면 안 된다(§9.3).
//   6) **호출 전에 막힌 것을 백엔드 장애로 집계한다.** 동의가 없다는 이유로 `backend` 가 down 이 되면
//      폴백 판정이 전 채널을 상담사 직결로 내린다 — 업무시스템은 멀쩡한데.
//
// 하지 않는 것: 네트워크 접근. 실제 호출은 주입된 `ConnectorPort` 가 하고, 이 파일은 순서만 지킨다.
import type { ConsentPolicy, ConsentRecord } from '../consent/consent.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { decideLegalBasis, type LegalBasisDecision } from '../legal/executeLegal.ts';
import type { AcceptanceRecord, LegalDocument } from '../legal/documents.ts';
import type { FlowInput } from '../flow/runner.ts';
import type { HealthSample } from '../ops/fallback.ts';
import {
  CONNECTOR_HEALTH_COMPONENT, applyResponse, assertConnectorResidency, assertConnectorScope,
  buildRequest, connectorOk, decideOnFailure, piiParams, redactRequest, requiresConsent, validateConnector,
  type ConnectorDef, type ConnectorErrorCode, type ConnectorFailureAction, type ConnectorPort,
  type ConnectorRequest, type ConnectorResponse,
} from './connector.ts';

export const CONNECTOR_EXEC_CONTRACT_VERSION = 1;

/** 호출 전에 막힌 사유. **전부 우리 쪽 문제이며 업무시스템 장애가 아니다** — 헬스에 집계하지 않는다. */
export type BlockedReason =
  | 'invalid_definition'      // 선언 검증 실패
  | 'residency'               // 국외이전 불가 테넌트에 해외 연동
  | 'consent_context_missing' // pii 파라미터가 있는데 동의 컨텍스트가 없다
  | 'consent_denied'          // §10.1 게이트가 막았다
  | 'legal_notice_not_final'  // 동의는 있으나 고지 문안이 확정본이 아니거나 개정돼 재수락이 필요하다(§10.1)
  | 'missing_slots'           // 필수 슬롯이 비었다 — 빈 값으로 조회하면 엉뚱한 결과가 온다
  | 'idempotency_key_missing'
  | 'retry_without_backoff';  // 간격 없는 재시도는 힘들어하는 시스템을 더 밀어붙인다

export interface ExecuteOk {
  kind: 'ok';
  /** allowlist 통과 + maskPii 경유. 그대로 세션에 병합해도 안전하다(§10.3). */
  slots: Record<string, string>;
  maskedSlots: string[];
  /** 선언됐지만 응답에 없던 필드. 실패로 만들지 않고 **드러낸다** — 판정은 시나리오의 몫이다. */
  missingFields: string[];
  unusableFields: string[];
  droppedFields: string[];
  /** 출력이 선언돼 있는데 한 슬롯도 채우지 못했다. 예외가 아니라 조용한 오답의 신호다. */
  noOutputApplied: boolean;
  attempts: number;
  latencyMs?: number;
}

export interface ExecuteFailed {
  kind: 'failed';
  code: ConnectorErrorCode;
  /** 커넥터 선언의 onFailure. 시나리오가 갈 곳을 정하는 근거다(§5.3). */
  action: ConnectorFailureAction;
  reason: 'not_retryable' | 'attempts_exhausted';
  attempts: number;
  /** maskPii 를 지난 사유. 업무시스템 응답 본문은 여기에 실리지 않는다(§10.3). */
  detail?: string;
  latencyMs?: number;
}

export interface ExecuteBlocked {
  kind: 'blocked';
  reason: BlockedReason;
  messageKo: string;
  /** missing_slots 일 때 어느 슬롯이 비었는지 — 슬롯 **이름**이지 값이 아니다. */
  missingSlots?: string[];
}

export type ExecuteOutcome = ExecuteOk | ExecuteFailed | ExecuteBlocked;

/**
 * 고지 문안 등록부 컨텍스트(§10.1).
 *
 * **선언하지 않으면 종전과 완전히 같다**(§13-3) — 문안 검사를 하지 않고 동의 게이트 결과만 쓴다.
 * 선언하면 초안 문안·시행일 전 문안·개정 후 재수락 누락이 **호출 전에** 막힌다. 판정은
 * `legal/executeLegal.ts` 하나가 만들고 이 파일은 순서만 지킨다(§2).
 */
export interface LegalContext {
  /** 등록부 내용(`LegalRegistry.list()` 결과 그대로). */
  docs: readonly LegalDocument[];
  /** 문안 수락 기록. 없으면 재수락 판정을 하지 않고 "대조할 수 없다"로 적는다. */
  acceptances?: readonly AcceptanceRecord[];
  /** 고객에게 보여 준 언어. 기본 언어를 만들지 않는다(§13-3). */
  locale: string;
}

export interface ConsentContext {
  policy: ConsentPolicy;
  records: readonly ConsentRecord[];
  /** 개인정보 원문이 아닌 참조여야 한다 — `assertSubjectRef` 가 확인한다. */
  subjectRef: string;
  now: string;
  /** §10.1 고지 문안 검사. 선언하지 않으면 종전과 완전히 같다. */
  legal?: LegalContext;
}

export interface ExecuteConnectorInput {
  def: ConnectorDef;
  slots: Readonly<Record<string, string>>;
  scope: TenantScope;
  interactionId: string;
  /**
   * 멱등 키. **호출자가 만들고 재시도 사이에 바뀌지 않는다.**
   * Core 가 매 시도 새로 만들면 command 재시도가 중복 처리된다(§8.1 과 같은 원칙).
   */
  idempotencyKey: string;
  port: ConnectorPort;
  /** §10.3 — 기본값 없음. 호출자가 테넌트 설정을 명시적으로 넘긴다. */
  allowOverseas: boolean;
  /** pii 파라미터가 하나라도 선언돼 있으면 **필수**다. 없으면 호출하지 않는다(§10.1). */
  consent?: ConsentContext;
  /** 재시도 간격(ms). `retry.maxAttempts > 1` 인데 주지 않으면 설정 오류로 거절한다. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** §9.3 헬스 집계. **호출까지 간 시도만** 샘플이 된다 — 호출 전에 막힌 것은 업무시스템 탓이 아니다. */
  onHealth?: (sample: HealthSample) => void;
  /** 관측 시각. 주입하지 않으면 헬스 샘플을 만들지 않는다 — 시각 없는 샘플은 신선도 판정을 못 한다(§13-3). */
  now?: () => string;
  /**
   * §10.1 근거 판정을 행위별로 그대로 넘긴다(`onHealth` 와 같은 모양).
   *
   * 왜 콜백인가: 판정에는 **막지 않은 사실**도 들어 있다 — "확정 여부를 확인할 수 없는 참조",
   * "수락 기록이 없어 어느 문안으로 받은 동의인지 대조하지 못함". 결과를 `blocked` 하나로 접으면
   * 그 사실이 사라지고, 사라진 사실은 점검받을 때 다시 만들 수 없다. 던져도 호출을 막지 않는다 —
   * 기록용 훅의 버그로 통화가 끊기면 안 된다(§9.3).
   */
  onLegalBasis?: (decision: LegalBasisDecision) => void;
}

/** 포트가 규약을 어긴 값을 돌려줬을 때. `ok` 로도 `실패`로도 임의 해석하지 않고 형식 오류로 적는다. */
function normalizeResponse(raw: unknown): ConnectorResponse {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, code: 'schema_mismatch', detail: '커넥터 포트가 응답 객체를 돌려주지 않았습니다.' };
  }
  const r = raw as Record<string, unknown>;
  if (r['ok'] === true) {
    const data = r['data'];
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, code: 'schema_mismatch', detail: '성공 응답에 data 객체가 없습니다.' };
    }
    const out: ConnectorResponse = { ok: true, data: data as Record<string, unknown> };
    if (typeof r['latencyMs'] === 'number' && Number.isFinite(r['latencyMs']) && r['latencyMs'] >= 0) {
      out.latencyMs = r['latencyMs'];
    }
    return out;
  }
  if (r['ok'] === false && typeof r['code'] === 'string') {
    const out: ConnectorResponse = { ok: false, code: r['code'] as ConnectorErrorCode };
    if (typeof r['detail'] === 'string') out.detail = r['detail'];
    if (typeof r['latencyMs'] === 'number' && Number.isFinite(r['latencyMs']) && r['latencyMs'] >= 0) {
      out.latencyMs = r['latencyMs'];
    }
    return out;
  }
  return { ok: false, code: 'schema_mismatch', detail: '커넥터 포트 응답이 규약(ok/code)을 따르지 않습니다.' };
}

/**
 * Api 노드 1회 실행. 선언 검증 → 격리 → 국외이전 → 동의 → 요청 조립 → 호출(재시도) → 응답 적용.
 *
 * **순서가 곧 안전장치다.** 슬롯은 마지막에 만들어지므로 어느 단계에서 걸려도 세션에 병합할 물건이
 * 생기지 않고, 게이트 셋(격리·국외이전·동의)은 요청을 조립하기 **전에** 지나간다 — 조립된 요청에는
 * 마스킹되지 않은 개인정보가 들어 있어서다(§6.1 규약 2).
 *
 * 던지지 않는다. 업무시스템 연동 실패로 통화가 끊기면 안 된다(§9.3) — 단, 테넌트 격리 위반만은
 * 예외로 던진다(`assertConnectorScope`). 남의 테넌트 자원을 부르는 것은 폴백할 사안이 아니다(§11.1).
 */
export async function executeConnector(input: ExecuteConnectorInput): Promise<ExecuteOutcome> {
  const { def, port } = input;

  const issues = validateConnector(def);
  if (!connectorOk(issues)) {
    const first = issues.find((i) => i.severity === 'error');
    return {
      kind: 'blocked', reason: 'invalid_definition',
      messageKo: `커넥터 선언이 유효하지 않습니다(${def.id}): ${first ? first.messageKo : '오류'}`,
    };
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
    return {
      kind: 'blocked', reason: 'idempotency_key_missing',
      messageKo: '멱등 키가 없습니다. Core 가 만들면 재시도마다 달라져 중복 처리를 막지 못합니다.',
    };
  }

  // §11.1 — 남의 테넌트 커넥터 호출은 폴백 대상이 아니다. 여기서만 던진다.
  assertConnectorScope(def, input.scope);

  try {
    assertConnectorResidency(def, input.allowOverseas);
  } catch (e) {
    return { kind: 'blocked', reason: 'residency', messageKo: e instanceof Error ? e.message : String(e) };
  }

  const pii = piiParams(def);
  if (requiresConsent(def)) {
    if (!input.consent) {
      return {
        kind: 'blocked', reason: 'consent_context_missing',
        messageKo: `개인정보 파라미터(${pii.length}건) 또는 해외 연동인데 동의 컨텍스트가 없습니다 — 없음을 통과로 읽지 않습니다(§10.1).`,
      };
    }
    const c = input.consent;
    const actions = pii.length > 0 ? (['call_backend_with_pii'] as const) : ([] as const);
    const all = def.residency === 'overseas' ? [...actions, 'transfer_overseas' as const] : [...actions];
    for (const action of all) {
      // 판정은 `decideLegalBasis` 하나다 — 그 안에서 `gateAction` 을 부르고 결과를 그대로 싣는다(§2).
      // `legal` 미선언이면 문안 검사를 건너뛰므로 `allowed` 는 종전의 게이트 결과와 같다(§13-3).
      let basis: LegalBasisDecision;
      try {
        basis = decideLegalBasis({
          scope: input.scope,
          policy: c.policy,
          consents: c.records,
          subjectRef: c.subjectRef,
          action,
          now: c.now,
          ...(c.legal !== undefined
            ? {
              docs: c.legal.docs,
              locale: c.legal.locale,
              ...(c.legal.acceptances !== undefined ? { acceptances: c.legal.acceptances } : {}),
            }
            : {}),
        });
      } catch (e) {
        return { kind: 'blocked', reason: 'consent_denied', messageKo: maskPii(e instanceof Error ? e.message : String(e)).text };
      }

      if (input.onLegalBasis) {
        // 기록용 훅이 던져도 호출을 막지 않는다(§9.3).
        try { input.onLegalBasis(basis); } catch { /* 무시 */ }
      }

      const gate = basis.gate;
      if (!gate.allow) {
        const purposes = gate.blockedBy.map((b) => b.purpose).join(', ');
        return {
          kind: 'blocked', reason: 'consent_denied',
          messageKo: `동의 게이트가 호출을 막았습니다(${action}·${gate.reason}): ${purposes || '사유 없음'}`,
        };
      }
      if (!basis.allowed) {
        // 동의는 있는데 문안이 흔들린 경우다. 같은 `consent_denied` 로 접지 않는다 —
        // 조치가 다르다(동의를 다시 받는 것과 문안을 확정·재수락하는 것은 다른 일이다).
        return {
          kind: 'blocked', reason: 'legal_notice_not_final',
          messageKo: `§10.1 고지 문안 근거가 없어 호출하지 않았습니다(${action}·${basis.status}): ${maskPii(basis.blockersKo.join(' / ')).text}`,
        };
      }
    }
  }

  const built = buildRequest(def, input.slots, {
    scope: input.scope, interactionId: input.interactionId, idempotencyKey: input.idempotencyKey, attempt: 1,
  });
  if (!built.ok) {
    return {
      kind: 'blocked', reason: 'missing_slots', missingSlots: built.missing,
      messageKo: `필수 슬롯이 비어 있어 호출하지 않았습니다: ${built.missing.join(', ')}`,
    };
  }

  const maxAttempts = def.retry?.maxAttempts ?? 1;
  if (maxAttempts > 1 && !input.backoffMs) {
    return {
      kind: 'blocked', reason: 'retry_without_backoff',
      messageKo: '재시도를 선언했으면 backoffMs 도 주어야 합니다. 간격 없는 재시도는 힘들어하는 업무시스템을 더 밀어붙입니다.',
    };
  }

  const nowOf = input.now;
  const sample = (state: HealthSample['state'], detail: string, latencyMs?: number): void => {
    if (!input.onHealth || !nowOf) return;   // 시각을 못 만들면 샘플을 만들지 않는다(§13-3)
    const s: HealthSample = { component: CONNECTOR_HEALTH_COMPONENT, state, observedAt: nowOf(), detail: maskPii(detail).text };
    if (latencyMs !== undefined) s.latencyMs = latencyMs;
    input.onHealth(s);
  };

  let attempt = 1;
  let lastLatency: number | undefined;
  for (;;) {
    // 멱등 키는 그대로 — 시도 번호만 바뀐다. 이 한 줄이 command 중복 처리를 막는 전부다.
    const request: ConnectorRequest = { ...built.request, attempt };
    let res: ConnectorResponse;
    try {
      res = normalizeResponse(await port.call(request));
    } catch (e) {
      // 포트 구현의 예외를 통화 밖으로 내보내지 않는다(§9.3). 원문은 마스킹을 지난다.
      res = { ok: false, code: 'unavailable', detail: maskPii(e instanceof Error ? e.message : String(e)).text };
    }
    if (res.latencyMs !== undefined) lastLatency = res.latencyMs;

    if (res.ok) {
      const applied = applyResponse(def, res.data);
      sample('up', `${def.id} 호출 성공(시도 ${attempt})`, res.latencyMs);
      return {
        kind: 'ok',
        slots: applied.slots,
        maskedSlots: applied.maskedSlots,
        missingFields: applied.missingFields,
        unusableFields: applied.unusableFields,
        droppedFields: applied.droppedFields,
        noOutputApplied: def.outputs.length > 0 && Object.keys(applied.slots).length === 0,
        attempts: attempt,
        ...(res.latencyMs !== undefined ? { latencyMs: res.latencyMs } : {}),
      };
    }

    const decision = decideOnFailure(def, res.code, attempt);
    if (decision.retry) {
      // 한 번 실패로 down 을 적지 않는다 — 재시도가 남아 있으면 아직 장애가 아니다(resilience.ts 와 같은 규칙).
      sample('degraded', `${def.id} 시도 ${attempt} 실패(${res.code}) — 재시도`, res.latencyMs);
      const wait = input.backoffMs ? input.backoffMs(attempt) : 0;
      if (wait > 0 && input.sleep) await input.sleep(wait);
      attempt = decision.nextAttempt;
      continue;
    }
    sample('down', `${def.id} 실패 확정(${res.code}·${decision.reason})`, res.latencyMs);
    return {
      kind: 'failed',
      code: res.code,
      action: decision.action,
      reason: decision.reason,
      attempts: attempt,
      ...(res.detail !== undefined ? { detail: maskPii(res.detail).text } : {}),
      ...(lastLatency !== undefined ? { latencyMs: lastLatency } : {}),
    };
  }
}

/**
 * 실행 결과를 Runner 입력으로 옮긴다. Runner 는 `connectorResult` 하나만 받으므로,
 * 채널이 `kind` 별로 각자 변환하면 또 갈라진다 — 변환도 한 곳에 둔다.
 *
 * `blocked` 는 **성공이 아니다.** 실패로 내려 `onError`·상담사 이관이 돌게 한다(§5.3·§9.3) —
 * 동의가 없어서 못 불렀는데 시나리오가 그냥 다음 노드로 넘어가면 고객은 빈 안내를 듣는다.
 */
export function toFlowInput(outcome: ExecuteOutcome): Extract<FlowInput, { kind: 'connectorResult' }> {
  if (outcome.kind === 'ok') {
    return { kind: 'connectorResult', ok: true, slots: outcome.slots };
  }
  if (outcome.kind === 'failed') {
    return { kind: 'connectorResult', ok: false, errorCode: outcome.code };
  }
  return { kind: 'connectorResult', ok: false, errorCode: outcome.reason };
}

/** 로그·이벤트로 내보낼 요청 사본. 원문 요청을 그대로 기록하는 실수를 한 번 더 막는다(§6.1 규약 2). */
export function redactedRequestOf(
  def: ConnectorDef, slots: Readonly<Record<string, string>>, scope: TenantScope,
  interactionId: string, idempotencyKey: string,
): ConnectorRequest | undefined {
  const built = buildRequest(def, slots, { scope, interactionId, idempotencyKey });
  return built.ok ? redactRequest(def, built.request) : undefined;
}
