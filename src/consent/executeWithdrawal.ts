// 동의 철회 실행기 — 설계서 §10.1(고지·동의·정보주체 권리행사)·§10.2(변경 기록)·
// §10.3(마스킹)·§11.1(테넌트 격리)·§13-3(임의 기본값 금지).
//
// `consent/executeConsent.ts` 는 통화 중 동의 수집을 이었고, 머리말에 범위 밖을 분명히 적어 뒀다 —
// **"철회를 만들지 않는다. 철회(withdrawn)는 이전 동의를 거두는 별도 행위(포털·철회 메뉴)이고,
// 둘을 섞으면 동의 이력에서 '받은 적 없음'과 '거뒀음'이 구분되지 않는다."** 옳은 경계인데,
// 그 "별도 행위"를 하는 자리가 저장소 어디에도 없었다: `consent.ts` 의 `withdraw` 를 부르는 곳은
// 테스트뿐이고 `currentState` 를 직접 부르는 곳도 없다. **즉 철회는 한 번도 처리된 적이 없다.**
//
// 이 공백이 조용한 방식은 앞의 것들과 또 다르다. 철회는 **고객이 요청한 것**이므로 누락되면
// 요청한 사람이 안다 — 다만 알게 되는 시점이 개인정보위 민원이거나 분쟁이다. 그리고 호스트가
// 손으로 꿰면 빠지는 것은 정해져 있고, **여섯 개 다 "철회했다"는 화면과 어긋난 상태를 만든다.**
//  (가) **철회 메뉴가 IA 에 없었다.** 라우트가 없으면 `decideAccess` 가 `unknown_route` 로 거부
//      하므로 철회는 **권한 검사·감사를 거쳐 실행될 수 없다**. 그 상태에서 포털이 철회 화면을
//      만들면 IA 밖 화면이 되고, 그쪽이 `screenMap.ts` 가 "훨씬 위험하다"고 적어 둔 경우다
//      (권한 검사와 감사 기록을 안 거치는 화면). 그래서 `settings.consent` 를 IA 에 넣었다.
//  (나) **받은 적 없는 동의를 '철회했다'로 적는다.** `not_asked`·`denied` 상태에 `withdrawn`
//      기록을 덧붙이면 이력에서 "받은 적 없음"과 "거뒀음"이 구분되지 않는다 — `executeConsent`
//      가 지키려던 구분이 **반대 방향에서** 무너진다. 거둘 것이 없으면 기록을 만들지 않고
//      그 사실을 적는다(실패가 아니다 — 고객에게는 "이미 수집하지 않습니다"가 맞는 답이다).
//  (다) **이미 철회된 동의를 또 철회한다.** 중복 클릭·요청 재전송이 기록을 늘리고, 그러면
//      이력의 마지막 철회 시각이 뒤로 밀린다. 분쟁에서 필요한 것은 **최초 철회 시각**이다.
//      그래서 멱등이다 — 이미 `withdrawn` 이면 기록을 만들지 않는다.
//  (라) **일부만 처리하고 전부 철회로 적는다.** 목적을 여러 개 받으면 그중 하나가 정책에
//      선언되지 않았거나 거둘 것이 없을 수 있다. 전체를 성공으로 접으면 **철회되지 않은 목적이
//      철회된 것으로 보인다**. 그래서 결과는 **목적별**이고, 한 건도 철회되지 않았으면 성공으로
//      적지 않는다.
//  (마) **철회 후에도 조회가 계속된다.** 철회의 요점은 기록이 아니라 **그 다음부터 막히는 것**
//      이다. 기록만 쌓고 게이트를 확인하지 않으면 "철회했는데 여전히 조회된다"가 남는다.
//      그래서 철회 후 `gateAction` 을 **실제로 다시 불러** 결과에 적는다. 다만 **통화를 끊지
//      않는다** — `allow: false` 는 "그 행위를 하지 말라"이지 "통화를 종료하라"가 아니다
//      (`executeLegal` 과 같은 경계).
//      **여기서 제일 비싼 것이 드러났다**: `gateAction` 은 선언대로 **필수 목적만** 막는다
//      ("선택 목적은 막지 않는다 — 호출자가 축소 실행을 선택한다"). 그래서 마케팅 동의를
//      철회해도 `marketing_followup` 은 여전히 `allow: true` 다. 게이트 설계는 옳지만, 철회
//      화면이 그 `true` 를 그대로 읽으면 **거둔 동의로 마케팅이 계속 나간다** — 철회 사고 중
//      제일 흔한 모양이다. 판정을 고치지 않고(§2) `withdrawnButAllowed` 로 **드러낸다**:
//      "이번에 거둔 목적인데 게이트는 막지 않는다 — 축소 실행은 호출자가 해야 한다."
//  (바) **기록이 저장되지 않으면 철회는 일어나지 않았다.** `executeConsent` 가 저장을 호스트에
//      맡긴 것은 통화 중 판정이라서다(기록 실패는 "동의 없음"으로 남아 게이트가 막는 쪽으로
//      안전하게 기운다). 철회는 **반대 방향으로 기울어 위험하다** — 저장이 실패하면 동의가
//      `granted` 로 남고 조회는 계속된다. 그래서 저장은 이 실행기가 `ConsentStore.append` 로
//      책임지고, 저장이 던지면 성공으로도 미실행으로도 적지 않는다(`uncommitted`).
//
// 경계:
//  - **판정을 복사하지 않는다(§2).** 상태·만료는 `currentState`/`evaluateConsents`, 행위 차단은
//    `gateAction`, 기록 생성은 `withdraw`, 주체 참조 검증은 `assertSubjectRef`, 권한·기록·
//    테넌트 체인 선택은 `audit/access.ts` 하나다. 이 파일에는 만료일도 목적 매핑도 없다.
//  - **삭제하지 않는다.** 철회는 기존 기록을 남긴 채 `withdrawn` 을 덧붙이는 것이다(§10.1 입증
//    책임). 개인정보 자체의 파기는 §8.2 경로(`core/retentionInventory.ts`)이며 여기서 하지 않는다 —
//    둘을 묶으면 "철회했으니 다 지웠겠지"가 되고, 법정 보존 의무가 있는 자료까지 지워진다.
//  - **미승인 정책에서는 기록을 만들지 않는다.** `consent.ts` 가 그렇게 정해 뒀고(미승인 정책으로
//    동의를 기록할 수 없다), 그 상태에서는 `gateAction` 이 이미 전부를 막고 있으므로 철회가 더할
//    효과가 없다. 조용히 넘기지 않고 설정 결함으로 적는다.
//  - **목적을 골라 주지 않는다**(§13-3). 어떤 목적을 거둘지는 고객의 요청이다 — 빈 목록을
//    "전부 철회"로 읽지 않는다.
//  - **던지는 것은 격리 위반 하나뿐이다**(§11.1). 그 밖의 실패는 전부 결과값이다.
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { AuditChain, AuditRecord, Hasher } from '../audit/log.ts';
import { appendAudit } from '../audit/log.ts';
import { decideAccess, recordAccess, type AccessActor, type AccessRequest } from '../audit/access.ts';
import type {
  ConsentPolicy, ConsentPurpose, ConsentRecord, ConsentState, GateDecision, GatedAction,
} from './consent.ts';
import {
  ACTION_PURPOSES, assertSubjectRef, consentPolicyOk, currentState, gateAction,
  validateConsentPolicy, withdraw,
} from './consent.ts';
import type { ConsentStore } from './executeConsent.ts';

export const WITHDRAWAL_CONTRACT_VERSION = 1;

/** 동의 이력·철회 화면(§7 7.7). IA 에 선언된 id 를 그대로 쓴다 — 여기서 만들지 않는다. */
export const CONSENT_ROUTE_ID = 'settings.consent';

export type WithdrawalStatusCode =
  /** 한 건 이상 철회되고 저장됐다 */
  | 'ok'
  /** 요청한 목적 중 거둘 것이 하나도 없었다. **실패가 아니다** */
  | 'nothing_to_withdraw'
  /** 권한·격리 거부. 기록은 남는다 */
  | 'denied'
  /** 형태·설정 오류 — 기록도 저장도 일어나지 않았다 */
  | 'refused'
  /** 저장이 실패했다. **성공도 미실행도 아니다** */
  | 'uncommitted';

/** 목적별 결과. 전부를 하나로 접지 않는다(위 (라)). */
export type PurposeOutcome =
  /** 철회 기록이 만들어졌다 */
  | 'withdrawn'
  /** 이미 철회돼 있어 기록을 만들지 않았다(멱등) */
  | 'already_withdrawn'
  /** 동의를 받은 적이 없거나 거부 상태다 — 거둘 것이 없다 */
  | 'not_granted'
  /** 유효기간이 지나 이미 효력이 없다 — 거둘 것이 없다 */
  | 'expired'
  /** 정책에 선언되지 않은 목적이다(설정 누락) */
  | 'undeclared';

export interface PurposeResult {
  purpose: ConsentPurpose;
  outcome: PurposeOutcome;
  /** 철회 직전에 관측한 상태. 사후 추적용이다 */
  stateBefore: ConsentState;
  reasonKo: string;
}

export interface WithdrawalRequest {
  scope: TenantScope;
  actor: AccessActor;
  /** 동의 주체 참조. 해시·고객키여야 한다(§10.3 — 원문 개인정보는 거부된다). */
  subjectRef: string;
  /** 거둘 목적. **빈 목록을 "전부"로 읽지 않는다**(§13-3). */
  purposes: readonly ConsentPurpose[];
  /** 접수 경로(예: `portal`·`call_center`). 기록의 `via` 가 된다 — 만들어 넣지 않는다. */
  via: string;
  /** 관측 시각(ISO8601) — 주입. */
  at: string;
  /** 감사 레코드 식별자 — 생성기는 호스트가 가진다. */
  recordId: string;
  /** 접수 증빙 참조(녹취 id·접수번호 등). 저장 경로에서 한 번 마스킹된다. */
  evidenceRef?: string;
  /**
   * 철회 후 다시 판정할 행위. 선언하지 않으면 **재판정을 하지 않는다**(§13-3) —
   * 어떤 행위를 쓰는 테넌트인지 Core 가 고를 근거가 없다. 선언하면 (마)가 닫힌다.
   */
  recheckActions?: readonly GatedAction[];
}

export interface RecheckResult {
  action: GatedAction;
  /** `gateAction` 결과 그대로. 여기서 다시 판정하지 않는다(§2). */
  decision: GateDecision;
  /**
   * **이번에 거둔 목적인데 게이트가 막지 않는 것**(선택 목적이라서다).
   * 비어 있지 않으면 **축소 실행은 호출자가 해야 한다** — 이 값을 보지 않고 `allow: true` 만
   * 읽으면 거둔 동의로 그 행위가 계속 나간다(§10.1).
   */
  withdrawnButAllowed: readonly ConsentPurpose[];
}

export interface WithdrawalResult {
  status: WithdrawalStatusCode;
  messageKo: string;
  /** 목적별 결과. 조용히 줄이지 않는다. */
  results: readonly PurposeResult[];
  /** 실제로 만들어져 저장된 철회 기록. `ok` 이외에는 빈 배열이다. */
  records: readonly ConsentRecord[];
  /** 저장이 실제로 일어났는가. */
  committed: boolean;
  /**
   * 철회 후 행위 게이트 재판정(`recheckActions` 를 선언한 경우에만).
   * `allow: false` 는 "그 행위를 하지 말라"이지 "통화를 종료하라"가 아니다.
   */
  recheck?: readonly RecheckResult[];
  /** 거부·설정 결함 사유(마스킹 경유). */
  issues: readonly string[];
  warnings: readonly string[];
  chain: AuditChain;
  recorded: boolean;
  record?: AuditRecord;
}

function mask(text: string): string {
  return maskPii(text).text;
}

const REASON: Record<PurposeOutcome, string> = {
  withdrawn: '철회 기록을 남겼다',
  already_withdrawn: '이미 철회돼 있어 기록을 만들지 않았다(최초 철회 시각을 보존한다)',
  not_granted: '동의를 받은 적이 없거나 거부 상태여서 거둘 것이 없다',
  expired: '유효기간이 지나 이미 효력이 없다',
  undeclared: '정책에 선언되지 않은 목적이다 — 설정을 확인하라',
};

/** 상태 → 처리 결과. **판정은 `currentState` 하나이고 여기서는 분기만 한다**(§2). */
function outcomeOf(state: ConsentState, declared: boolean): PurposeOutcome {
  if (!declared) return 'undeclared';
  if (state === 'granted') return 'withdrawn';
  if (state === 'withdrawn') return 'already_withdrawn';
  if (state === 'expired') return 'expired';
  return 'not_granted';
}

function shapeIssues(req: WithdrawalRequest): string[] {
  const out: string[] = [];
  if (typeof req.at !== 'string' || req.at.length === 0) out.push('관측 시각(at)이 비어 있다');
  if (typeof req.recordId !== 'string' || req.recordId.length === 0) {
    out.push('감사 레코드 id(recordId)가 비어 있다 — 기록할 수 없는 처리는 반영하지 않는다 (설계서 §10.2)');
  }
  if (typeof req.via !== 'string' || req.via.length === 0) {
    out.push('접수 경로(via)가 비어 있다 — 어디로 받은 철회인지 모르는 기록은 근거가 되지 않는다');
  }
  if (!Array.isArray(req.purposes) || req.purposes.length === 0) {
    // 빈 목록을 "전부 철회"로 읽으면 실수 한 번이 선택 동의까지 모두 거둔다.
    out.push('거둘 목적(purposes)이 비어 있다 — 빈 목록을 전부 철회로 읽지 않는다 (설계서 §13-3)');
  } else if (new Set(req.purposes).size !== req.purposes.length) {
    out.push('거둘 목적에 중복이 있다 — 같은 목적에 철회 기록이 둘 생긴다');
  }
  return out;
}

/**
 * 동의 철회: **형태 → 격리 → 정책 → 권한 → 상태 판정 → 기록 생성 → 저장 → 감사 → 게이트 재판정.**
 *
 * 순서가 곧 안전장치다. 기록은 **상태를 다 본 뒤에** 만들어지고 저장은 그 다음이라,
 * 어느 단계에서 걸려도 "철회했다"는 흔적이 생기지 않는다.
 */
export function executeWithdrawal(
  chain: AuditChain,
  req: WithdrawalRequest,
  store: ConsentStore,
  policy: ConsentPolicy,
  hash: Hasher,
): WithdrawalResult {
  assertTenantScope(req.scope);
  if (policy.tenantId !== req.scope.tenantId) {
    // 남의 테넌트 동의 이력을 거두는 것은 폴백할 사안이 아니다.
    throw new Error(`테넌트 격리 위반(consent 철회): 기대=${req.scope.tenantId} 실제=${policy.tenantId} (설계서 §11.1)`);
  }
  if ((policy.workspaceId ?? undefined) !== (req.scope.workspaceId ?? undefined)) {
    throw new Error('다른 워크스페이스의 동의 정책으로 철회할 수 없다 (설계서 §11.1)');
  }

  const warnings: string[] = [];
  const base = {
    results: [] as readonly PurposeResult[],
    records: [] as readonly ConsentRecord[],
    committed: false as const,
    warnings,
    chain,
    recorded: false,
  };

  const issues = shapeIssues(req);
  try {
    assertSubjectRef(req.subjectRef);
  } catch (e) {
    // 주체 참조에 개인정보 원문이 오면 거부한다 — **원문은 결과에도 담지 않는다**(§10.3).
    issues.push(e instanceof Error ? e.message : '동의 주체 참조가 성립하지 않는다');
  }
  // 미승인 정책은 **여기서 다시 보지 않는다**(§2) — `validateConsentPolicy` 가 `E_NOT_APPROVED`
  // 를 오류로 내므로 아래 한 줄이 이미 거절한다. `policy.approved` 를 또 읽으면 승인 규칙이 두
  // 곳에 생기고, 그 상태에서 `gateAction` 은 이미 모든 행위를 막고 있으므로(= 철회가 더할 효과가
  // 없다) 판정을 늘릴 이유도 없다. 변이 검증으로 중복임을 확인했다(빼도 실패 0건).
  const policyIssues = validateConsentPolicy(policy);
  if (!consentPolicyOk(policyIssues)) {
    issues.push(...policyIssues.filter((i) => i.severity === 'error').map((i) => i.messageKo));
  }
  if (issues.length > 0) {
    // 형태·설정 오류는 기록하지 않는다 — 처리가 일어나지 않았고, 남기면 조사에서 잡음이 된다.
    return {
      ...base,
      status: 'refused',
      messageKo: '철회 요청을 처리할 수 없다. 항목별 사유를 함께 돌려준다.',
      issues: issues.map(mask),
    };
  }

  const access: AccessRequest = {
    scope: req.scope,
    actor: req.actor,
    routeId: CONSENT_ROUTE_ID,
    at: req.at,
    recordId: req.recordId,
    action: 'policy_change',
    targetType: 'consent',
    // 주체 참조는 해시·고객키임이 위에서 확인됐다(원문 개인정보는 여기 오지 못한다).
    targetId: req.subjectRef,
    affectedCount: req.purposes.length,
  };

  const decision = decideAccess(access);
  if (!decision.allowed) {
    const outcome = recordAccess(chain, { ...access, detail: '철회 거부 — 반영 없음' }, hash);
    return {
      ...base,
      status: 'denied',
      messageKo: decision.messageKo ?? '이 화면에 접근할 권한이 없다.',
      // 권한 유무 외의 정보를 흘리지 않는다 — 어떤 동의가 있는지 돌려주지 않는다.
      issues: [],
      chain: outcome.chain,
      recorded: outcome.recorded,
      ...(outcome.record !== undefined ? { record: outcome.record } : {}),
    };
  }

  let history: readonly ConsentRecord[];
  try {
    history = store.list(req.subjectRef);
  } catch (e) {
    return {
      ...base,
      status: 'refused',
      messageKo: '동의 이력을 읽지 못해 철회를 처리하지 않았다.',
      issues: [mask(e instanceof Error ? e.message : '동의 이력 조회 실패')],
    };
  }
  if (!Array.isArray(history)) {
    // 규약 위반 반환값을 "이력 없음"으로 읽으면 **거둘 것이 없다**로 답하게 된다.
    return {
      ...base,
      status: 'refused',
      messageKo: '동의 이력 조회가 규약을 어겼다 — 이력 없음으로 읽지 않는다.',
      issues: ['ConsentStore.list 가 배열을 돌려주지 않았다'],
    };
  }

  // 상태를 **먼저 다 본다**. 기록은 그 다음에 만든다.
  const results: PurposeResult[] = [];
  const pending: ConsentRecord[] = [];
  for (const purpose of req.purposes) {
    const declared = policy.requirements.some((r) => r.purpose === purpose);
    const stateBefore = currentState(policy, history, purpose, req.subjectRef, req.at);
    const outcome = outcomeOf(stateBefore, declared);
    results.push({ purpose, outcome, stateBefore, reasonKo: REASON[outcome] });
    if (outcome !== 'withdrawn') continue;
    pending.push(withdraw(policy, {
      subjectRef: req.subjectRef,
      purpose,
      via: req.via,
      at: req.at,
      ...(req.evidenceRef !== undefined ? { evidenceRef: mask(req.evidenceRef) } : {}),
    }));
  }

  if (results.some((r) => r.outcome === 'undeclared')) {
    warnings.push('정책에 선언되지 않은 목적이 포함됐다 — 그 목적은 철회되지 않았다 (설계서 §10.1)');
  }

  const detailKo = (head: string) => [
    head,
    `주체 ${req.purposes.length}목적`,
    results.map((r) => `${r.purpose}:${r.outcome}`).join(','),
  ].join(' · ');

  if (pending.length === 0) {
    // **실패가 아니다.** 기록을 만들지 않았다는 사실과 목적별 이유를 그대로 적는다.
    const outcome = recordAccess(chain, {
      ...access,
      affectedCount: 0,
      detail: detailKo('철회 대상 없음'),
    }, hash, { recordAllReads: true });
    return {
      ...base,
      status: 'nothing_to_withdraw',
      messageKo: '거둘 동의가 없다. 목적별 사유를 함께 돌려준다.',
      results,
      issues: [],
      chain: outcome.chain,
      recorded: outcome.recorded,
      ...(outcome.record !== undefined ? { record: outcome.record } : {}),
      // 거둔 목적이 없으므로 `withdrawnButAllowed` 는 비어 있다 — 그래도 재판정은 돌려준다
      // (운영자가 "지금 무엇이 허용돼 있는가"를 같은 화면에서 봐야 한다).
      ...(recheck(policy, history, req, [], warnings) ?? {}),
    };
  }

  // 저장. 여기서부터 되돌릴 수 없다. **부분 저장을 전부 저장으로 적지 않는다.**
  const stored: ConsentRecord[] = [];
  try {
    for (const rec of pending) {
      store.append(rec);
      stored.push(rec);
    }
  } catch (e) {
    const detail = `철회 저장 실패 — 반영 여부 확인 필요(${stored.length}/${pending.length}건): ${
      e instanceof Error ? e.message : String(e)}`;
    const errored = appendAudit(chain, {
      scope: req.scope,
      recordId: req.recordId,
      at: req.at,
      actor: {
        userId: req.actor.userId,
        roles: req.actor.roles,
        ...(req.actor.ip !== undefined ? { ip: req.actor.ip } : {}),
      },
      action: 'policy_change',
      routeId: CONSENT_ROUTE_ID,
      targetType: 'consent',
      targetId: req.subjectRef,
      result: 'error',
      detail,
    }, hash);
    return {
      ...base,
      status: 'uncommitted',
      messageKo: '철회 기록을 저장하지 못했다. 반영 여부를 확인하라 — 저장되지 않으면 철회는 일어나지 않았다.',
      results,
      issues: [mask(detail)],
      chain: errored,
      recorded: true,
      record: errored.records[errored.records.length - 1] as AuditRecord,
    };
  }

  const outcome = recordAccess(chain, {
    ...access,
    affectedCount: stored.length,
    detail: detailKo(`철회 ${stored.length}건`),
  }, hash, { recordAllReads: true });

  // 게이트 재판정은 **저장 뒤** 이력을 다시 읽어서 한다 — 저장 전 이력으로 판정하면
  // "철회했는데 여전히 허용"이 결과에 그대로 적힌다.
  let after: readonly ConsentRecord[] = [...history, ...stored];
  try {
    const re = store.list(req.subjectRef);
    if (Array.isArray(re)) after = re;
  } catch {
    warnings.push('철회 후 이력을 다시 읽지 못해 저장한 기록을 더해 판정했다');
  }

  return {
    ...base,
    status: 'ok',
    committed: true,
    messageKo: `동의 ${stored.length}건을 철회했다.`,
    results,
    records: stored,
    issues: [],
    chain: outcome.chain,
    recorded: outcome.recorded,
    ...(outcome.record !== undefined ? { record: outcome.record } : {}),
    ...(recheck(policy, after, req, stored.map((r) => r.purpose), warnings) ?? {}),
  };
}

/**
 * 철회 후 행위 게이트 재판정(위 (마)).
 * **판정은 `gateAction` 하나다** — 여기서 필수 여부를 다시 세지 않는다(§2).
 * 선언하지 않으면 재판정하지 않는다(§13-3) — 빈 배열을 "전부 확인"으로 읽지 않는다.
 */
function recheck(
  policy: ConsentPolicy,
  records: readonly ConsentRecord[],
  req: WithdrawalRequest,
  withdrawnPurposes: readonly ConsentPurpose[],
  warnings: string[],
): { recheck: readonly RecheckResult[] } | undefined {
  const actions = req.recheckActions;
  if (actions === undefined || actions.length === 0) return undefined;
  const out: RecheckResult[] = [];
  for (const action of actions) {
    const decision = gateAction(policy, records, action, req.subjectRef, req.at, req.scope);
    // 목적 매핑은 `ACTION_PURPOSES` 하나를 **읽는다** — 여기서 다시 적지 않는다(§2).
    // 필수 여부를 재판정하지 않고 **게이트의 결론(allow)** 과 대조하는 것이 요점이다.
    const touched = decision.allow
      ? ACTION_PURPOSES[action].filter((p) => withdrawnPurposes.includes(p))
      : [];
    if (touched.length > 0) {
      warnings.push(
        `${action}: 거둔 목적(${touched.join(', ')})이지만 게이트는 막지 않는다 — `
        + '선택 목적이므로 축소 실행은 호출자가 해야 한다 (설계서 §10.1)',
      );
    }
    out.push({ action, decision, withdrawnButAllowed: touched });
  }
  return { recheck: out };
}
