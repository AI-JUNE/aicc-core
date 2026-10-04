// 동의 수집·반영 실행 — 설계서 §10.1(고지·동의) · §10.3(개인정보) · §6.1(업무시스템 연동) ·
// §11.1(테넌트 격리) · §13-3(임의값 금지).
//
// `consent/consent.ts` 는 머리말에 "판정만 하고 실행은 호출자가 한다"고 적어 두었고 조각도 다 갖췄다
// (정책 검증·목적별 상태·행위 게이트·추가 전용 기록 생성). 그런데 **저장소 전체에서 `grant`·`deny` 를
// 부르는 곳이 테스트뿐이었다.** 즉 지금까지 어떤 채널에서도 동의가 기록된 적이 없다. 그리고 게이트가
// 실제로 걸려 있는 유일한 자리(`integration/executeConnector.ts` 의 `call_backend_with_pii`)는
// 동의 컨텍스트를 **호스트가 만들어 넘겨야** 하는데, 그 컨텍스트를 만드는 코드도 0건이었다.
//
// 이 공백의 증상은 서로 반대 방향인데 둘 다 조용하다.
//  - 동의를 **묻기만 한** 쪽: 시나리오에 "개인정보 수집·이용에 동의하십니까?"가 있고 고객이 "네"라고
//    답해도, 그 답은 `Confirm` 슬롯 값으로만 남는다. 통화는 정상이고 이벤트도 정상이다. 드러나는
//    시점은 개인정보위 점검이나 분쟁이고, 그때 필요한 것은 슬롯이 아니라 **목적·버전·시각이 적힌
//    동의 기록**이다. "다 동의하셨죠"가 동의가 아닌 것과 같은 이유로, 슬롯 하나는 근거가 아니다.
//  - 동의를 **보기만 한** 쪽: pii 파라미터가 선언된 커넥터는 컨텍스트가 없으면 호출 자체가 막힌다.
//    그 조회는 통화 중에 **언제나** 실패하는데 업무시스템은 멀쩡하므로 장애 그래프는 평온하고,
//    증상은 "그 메뉴만 안 된다"로만 나타난다.
//
// 빠진 것은 정책이 아니라 **확정된 답을 기록으로 바꾸고 그 기록을 게이트에 넘기는 자리**였다.
// 그대로 두면 채널 3곳이 각자 "동의 노드를 찾아 기록을 만든다"를 짜게 되고, 그 20줄에서 빠지는 것은
// 취향이 아니라 정해져 있다 — 침묵을 동의로 적는다 · 같은 슬롯을 턴마다 다시 읽어 같은 동의를
// 수십 건 쌓는다 · 주체 없이 기록해 누구의 동의인지 모른다 · 미승인 정책으로 받은 동의를 근거로 쓴다.
//
// 하지 않는 것:
//  - **문구를 만들지 않는다**(§13-3). 동의 질문 문안·법적 근거·보유기간은 테넌트 법무 사항이다 **[승인 필요]**.
//  - **판정을 복사하지 않는다**(§2). 정책 검증은 `validateConsentPolicy`, 상태·만료는
//    `evaluateConsents`, 행위 차단은 `gateAction` 하나다. 이 파일에는 임계값도 목적 매핑도 없다.
//  - **막지 않는다.** 필수 동의가 없다는 사실은 드러내지만 통화를 끊거나 상담사로 내리지 않는다 —
//    거부 분기는 시나리오(`onNo`)가 정한다. Core 가 동의 없음을 종료로 바꾸면 선택 동의(마케팅)
//    하나를 거절한 고객의 통화가 끊기는 사고가 난다.
//  - **철회를 만들지 않는다.** 통화 중 "아니요"는 거부(denied)다. 철회(withdrawn)는 이전 동의를
//    거두는 별도 행위(포털·철회 메뉴)이고, 둘을 섞으면 동의 이력에서 "받은 적 없음"과 "거뒀음"이
//    구분되지 않는다. 추가 전용 이력에서 최신 기록이 이기므로(§10.1) 차단 효과는 같다.
//  - **저장하지 않는다.** 영속화는 호스트 저장소가 맡는다(§6.2) — 판정과 부작용을 한 함수에 묶으면
//    실패했을 때 무엇이 남았는지 알 수 없다(`knowledge/embedding.ts` 와 같은 자리).
import type { ConfirmNode, Flow, FlowNode } from '../flow/types.ts';
import { confirmSlotKey } from '../flow/types.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { ConsentPolicy, ConsentPurpose, ConsentRecord } from './consent.ts';
import { ACTION_PURPOSES, deny, evaluateConsents, grant, validateConsentPolicy } from './consent.ts';

/**
 * 동의 질문 노드의 예약 id 접두사. 뒤에 `ConsentPurpose` 를 붙인다
 * (예: `__consent:personal_data_collection`).
 *
 * 왜 새 `NodeKind` 를 만들지 않았는가: `INTENT_SLOT`·`KNOWLEDGE_SLOT` 과 **같은 이유**다 —
 * 채널 3곳이 `step.kind` 로 분기하고 있어 새 종류를 내보내는 순간 **설정을 바꾼 날** 전 통화가
 * 그 단계에서 깨진다(코드 배포가 아니라 원인을 찾기도 어렵다). 예약 id 면 채널이 보는 것은
 * 종전과 같은 `Confirm` 단계뿐이고, 동의 질문은 매체에 맞게 이미 렌더된다.
 *
 * 왜 배선(옵션)으로 선언하지 않고 **시나리오 안에** 두는가: 노드 id 목록을 배선에서 받으면
 * 오타 하나가 "동의를 물었는데 기록은 0건"으로 끝나고, 그 상태는 통화·이벤트 어디에서도
 * 터지지 않는다. 시나리오가 스스로 밝히면 어긋날 자리가 없다.
 */
export const CONSENT_NODE_PREFIX = '__consent:';

const ALL_PURPOSES: readonly ConsentPurpose[] = [
  ...new Set(Object.values(ACTION_PURPOSES).flat()),
];

/** 예약 접두사 뒤에 적힌 목적. 알 수 없는 목적이면 `undefined` 다 — 임의로 고르지 않는다(§13-3). */
export function consentPurposeOf(nodeId: string): ConsentPurpose | undefined {
  if (!nodeId.startsWith(CONSENT_NODE_PREFIX)) return undefined;
  const suffix = nodeId.slice(CONSENT_NODE_PREFIX.length);
  return ALL_PURPOSES.find((p) => p === suffix);
}

/** 이 노드가 동의 질문 노드인가. 판정은 한 곳에만 둔다 — 문자열 비교가 흩어지면 오타가 조용히 기능을 끈다. */
export function isConsentNode(node: FlowNode | undefined): node is ConfirmNode {
  return node !== undefined && node.kind === 'Confirm' && node.id.startsWith(CONSENT_NODE_PREFIX);
}

/** 시나리오에 선언된 동의 질문 노드. */
export function consentNodes(flow: Flow): { nodeId: string; purpose: ConsentPurpose }[] {
  const out: { nodeId: string; purpose: ConsentPurpose }[] = [];
  for (const node of Object.values(flow.nodes ?? {})) {
    if (!isConsentNode(node)) continue;
    const purpose = consentPurposeOf(node.id);
    if (purpose !== undefined) out.push({ nodeId: node.id, purpose });
  }
  return out;
}

/** 시나리오가 **시작되기 전에** 걸러야 하는 동의 노드 결함. */
export type ConsentNodeDefect =
  /** 예약 접두사를 썼으나 뒤에 적힌 목적이 `ConsentPurpose` 가 아니다 — 무엇에 대한 동의인지 모른다. */
  | 'unknown_purpose'
  /** 예약 접두사를 `Confirm` 이 아닌 노드에 썼다 — 확정된 yes/no 가 없으므로 기록할 값이 없다. */
  | 'not_confirm'
  /**
   * 분기(`onYes`·`onNo`·`next`)가 자기 자신을 가리킨다. 이 설정에서는 "확정됐다"와
   * "되묻는 중이다"(§5.1 사다리)를 관측만으로 가를 수 없어, 침묵을 동의로 적거나
   * 받은 동의를 놓치는 두 사고 중 하나가 반드시 일어난다.
   */
  | 'self_branch';

export function consentNodeDefects(flow: Flow): { nodeId: string; defect: ConsentNodeDefect }[] {
  const out: { nodeId: string; defect: ConsentNodeDefect }[] = [];
  for (const node of Object.values(flow.nodes ?? {})) {
    if (!node.id.startsWith(CONSENT_NODE_PREFIX)) continue;
    if (node.kind !== 'Confirm') { out.push({ nodeId: node.id, defect: 'not_confirm' }); continue; }
    if (consentPurposeOf(node.id) === undefined) { out.push({ nodeId: node.id, defect: 'unknown_purpose' }); continue; }
    if (node.onYes === node.id || node.onNo === node.id || node.next === node.id) {
      out.push({ nodeId: node.id, defect: 'self_branch' });
    }
  }
  return out;
}

/** 추가 전용 동의 이력 저장소(§6.2). Core 는 영속화하지 않는다 — 인메모리는 단일 프로세스용이다. */
export interface ConsentStore {
  /**
   * 이 주체의 동의 이력. **동기여야 한다** — 커넥터 게이트(§6.1)가 동기 컨텍스트를 요구하고,
   * 같은 통화에서 방금 받은 동의가 그 조회에 **즉시** 보여야 한다. 영속 저장은 호스트가
   * `append` 뒤에 비동기로 해도 되지만 이 조회는 그 캐시를 먼저 봐야 한다.
   */
  list(subjectRef: string): readonly ConsentRecord[];
  /** 기록 추가. 던져도 통화는 끊지 않는다 — 기록 실패는 "동의 없음"으로 남아 게이트가 막는다. */
  append(record: ConsentRecord): void;
}

/** 단일 프로세스용 이력. 순서를 보존한다 — 최신 기록이 이기는 판정(§10.1)의 전제다. */
export function createMemoryConsentStore(seed: readonly ConsentRecord[] = []): ConsentStore {
  const all: ConsentRecord[] = [...seed];
  return {
    list: (subjectRef) => all.filter((r) => r.subjectRef === subjectRef),
    append: (record) => { all.push(record); },
  };
}

/** 기록하지 않은 이유. 앞의 둘은 **정상 경로**이며 나머지는 운영이 보아야 하는 상태다. */
export type ConsentSkipCode =
  /** 이번 턴이 기다리던 노드가 동의 질문 노드가 아니다. */
  | 'not_consent_turn'
  /** 아직 확정되지 않았다 — 무입력·불일치로 되묻는 중이다(§5.1). **침묵은 동의가 아니다.** */
  | 'unanswered'
  /** 동의 주체 참조가 없다(인증 전). 누구의 동의인지 모르는 기록은 만들지 않는다. */
  | 'no_subject'
  /** 정책에 선언되지 않은 목적이다. 기록해도 근거가 되지 않으므로 설정 누락으로 드러낸다. */
  | 'purpose_undeclared'
  /** 미승인 정책으로는 동의를 수집할 수 없다(§10.1). */
  | 'policy_not_approved'
  /** 기록 생성이 거부됐다(주체 참조에 개인정보 원문 등, §10.3). */
  | 'rejected';

export type ConsentTurnPlan =
  | { action: 'record'; record: ConsentRecord; purpose: ConsentPurpose; state: 'granted' | 'denied' }
  | { action: 'none'; code: ConsentSkipCode; reasonKo: string; purpose?: ConsentPurpose };

export interface PlanConsentTurnInput {
  policy: ConsentPolicy;
  scope: TenantScope;
  /**
   * 이번 턴이 시작될 때 **고객 입력을 기다리고 있던** 노드. 동의 노드인지 보는 기준이 이것인
   * 이유: 확정된 `Confirm` 슬롯은 세션에 **영구히 남으므로**, 슬롯만 보고 기록하면 이후 모든
   * 턴에서 같은 동의가 다시 쌓인다(한 통화에 수십 건 — 감사에서 어느 것이 진짜인지 알 수 없다).
   */
  pendingNode: FlowNode | undefined;
  /** 턴 처리 후의 슬롯. 확정값(`yes`·`no`)이 여기 들어온다. */
  slotsAfter: Readonly<Record<string, string>>;
  /** 턴 처리 후 대기 중인 노드. `pendingNode` 와 같으면 되묻는 중이다. */
  nodeAfter: string | null;
  /** 턴 처리 후의 §5.1 실패 카운트. 0 이 아니면 이 턴은 확정이 아니다. */
  failCountAfter: number;
  /** 호스트가 만든 해시·고객키. Core 는 만들지 않는다(§10.3·§13-3). */
  subjectRef: string | undefined;
  /** 동의를 받은 시각. 호스트 시계다 — Core 가 만들어 넣지 않는다(§13-3). */
  at: string;
  /** 동의를 받은 경로(채널). 사실 기록이다. */
  via: string;
  interactionId: string;
  /** 녹취 구간·서명 등 증빙 참조 키. 증빙 원문을 넣지 않는다. */
  evidenceRef?: string;
}

/**
 * 이번 턴에 확정된 동의를 **추가 전용 기록 한 건**으로 바꾼다.
 *
 * 테넌트 격리 위반만 던진다(§11.1) — 남의 테넌트 정책으로 기록하면 그 동의는 다른 고객사의
 * 이력에 쌓이고, 타입도 값도 멀쩡해서 어디서도 터지지 않는다. 그 외에는 **어떤 경우에도
 * 던지지 않는다**: 동의 기록이 예외로 끝나 통화가 끊기면 동의를 못 받은 것보다 큰 사고다.
 * 기록하지 못한 사실은 `none` 으로 드러나고, 그 상태의 개인정보 조회는 게이트가 막는다.
 */
export function planConsentTurn(input: PlanConsentTurnInput): ConsentTurnPlan {
  assertTenantScope(input.scope);
  if (input.policy.tenantId !== input.scope.tenantId) {
    throw new Error(
      `테넌트 격리 위반(동의 기록): 정책=${input.policy.tenantId} 세션=${input.scope.tenantId} (설계서 §11.1)`,
    );
  }
  if ((input.policy.workspaceId ?? undefined) !== undefined
    && input.policy.workspaceId !== input.scope.workspaceId) {
    throw new Error('워크스페이스 격리 위반(동의 기록): 다른 워크스페이스의 동의 정책입니다 (설계서 §11.1)');
  }

  const node = input.pendingNode;
  if (!isConsentNode(node)) {
    return { action: 'none', code: 'not_consent_turn', reasonKo: '이번 턴은 동의 질문에 대한 답이 아닙니다.' };
  }
  const purpose = consentPurposeOf(node.id);
  if (purpose === undefined) {
    // `consentNodeDefects` 가 시작 전에 거르므로 여기까지 오면 배선을 지나지 않은 경로다.
    return {
      action: 'none', code: 'purpose_undeclared',
      reasonKo: `동의 노드 ${node.id} 의 목적을 알 수 없어 기록하지 않았습니다 — 무엇에 대한 동의인지 모르는 기록은 근거가 아닙니다(§10.1).`,
    };
  }

  const answer = input.slotsAfter[confirmSlotKey(node.id)];
  const confirmed = input.nodeAfter !== node.id && input.failCountAfter === 0
    && (answer === 'yes' || answer === 'no');
  if (!confirmed) {
    // 무입력·불일치로 되묻는 중이다. **침묵·오인식을 동의로 적지 않는다** — §10.1 에서 가장
    // 비싼 오답이며, 한 번 적히면 그 기록이 곧 "동의를 받았다"는 근거가 된다.
    return {
      action: 'none', code: 'unanswered', purpose,
      reasonKo: `${purpose} 동의가 아직 확정되지 않았습니다 — 되묻는 중이거나 답을 알아듣지 못했습니다(§5.1).`,
    };
  }

  if (!input.policy.approved) {
    return {
      action: 'none', code: 'policy_not_approved', purpose,
      reasonKo: '법무·컴플라이언스 미승인 동의 정책입니다 — 승인 전 문구로 받은 동의는 기록하지 않습니다(§10.1). [승인 필요]',
    };
  }
  if (!input.policy.requirements.some((r) => r.purpose === purpose)) {
    // 선언 누락을 통과로 처리하지 않는다 — 선언되지 않은 목적의 기록은 `gateAction` 에서도
    // "근거 없음"으로 읽히므로(declared=false), 적어 두면 "동의받았는데 왜 막히지"가 된다.
    return {
      action: 'none', code: 'purpose_undeclared', purpose,
      reasonKo: `동의 정책에 선언되지 않은 목적입니다: ${purpose} — 시나리오는 묻고 있으나 정책에 없습니다(§10.1).`,
    };
  }
  const subjectRef = input.subjectRef;
  if (typeof subjectRef !== 'string' || subjectRef.trim() === '') {
    return {
      action: 'none', code: 'no_subject', purpose,
      reasonKo: `${purpose} 동의를 받았으나 주체 참조가 없어 기록하지 못했습니다 — 누구의 동의인지 모르는 기록은 근거가 아닙니다(§10.1·§10.3).`,
    };
  }

  const state: 'granted' | 'denied' = answer === 'yes' ? 'granted' : 'denied';
  const recordInput = {
    subjectRef, purpose, via: input.via, at: input.at, interactionId: input.interactionId,
    ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
  };
  try {
    const record = state === 'granted' ? grant(input.policy, recordInput) : deny(input.policy, recordInput);
    return { action: 'record', record, purpose, state };
  } catch {
    // 주체 참조에 개인정보 원문이 섞인 경우 등(§10.3). **사유 원문은 올리지 않는다** —
    // `assertSubjectRef` 의 메시지는 검출된 종류만 담지만, 그 문장이 로그·화면으로 나가는
    // 경로를 열어 두지 않는다. 어떤 값이 문제였는지는 호스트가 자기 값으로 다시 확인한다.
    return {
      action: 'none', code: 'rejected', purpose,
      reasonKo: `${purpose} 동의 기록이 거부됐습니다 — 주체 참조가 해시·고객키가 아닐 수 있습니다(§10.3).`,
    };
  }
}

/**
 * 지금 **필수**로 선언됐는데 `granted` 가 아닌 목적(§10.1).
 *
 * 판정은 `evaluateConsents` 하나다 — 만료·철회·미획득을 여기서 다시 계산하면 §2 의 이중 관리가
 * 동의 규칙에서 되풀이되고, 그때는 화면과 게이트가 서로 다른 답을 낸다.
 *
 * **막는 데 쓰는 값이 아니다.** 이 목록이 비어 있지 않다는 사실만 드러내며, 무엇을 할지는
 * 시나리오(`onNo` 분기)와 테넌트가 정한다.
 */
export function pendingRequiredConsents(
  policy: ConsentPolicy,
  records: readonly ConsentRecord[],
  subjectRef: string | undefined,
  now: string,
): ConsentPurpose[] {
  const required = policy.requirements.filter((r) => r.required).map((r) => r.purpose);
  if (required.length === 0) return [];
  // 주체를 모르면 조회할 수 없다. "없음"을 `granted` 로 읽지 않으므로 전부 미획득으로 적는다 —
  // 모른다는 사실을 빈 목록(=다 받았다)으로 적는 것이 §10.1 에서 가장 조용한 오답이다.
  if (typeof subjectRef !== 'string' || subjectRef.trim() === '') return [...required];
  return evaluateConsents(policy, records, required, subjectRef, now)
    .filter((e) => e.state !== 'granted')
    .map((e) => e.purpose);
}

/**
 * 커넥터 게이트(§6.1)에 넘길 동의 컨텍스트. **주체를 모르면 만들지 않는다** —
 * 빈 기록 배열로 컨텍스트를 만들어 주면 `gateAction` 은 "이력을 조회했고 동의가 없었다"로 읽어
 * `consent_missing` 으로 막는데, 실제 상태는 "조회조차 못 했다"다. 두 상태의 대응이 서로
 * 다르므로(앞은 동의 요청, 뒤는 인증 배선) `consent_context_missing` 으로 구분되게 둔다.
 *
 * 조회가 던져도 던지지 않는다 — 저장소 장애로 통화가 끊기면 안 된다(§9.3). 그 경우도
 * 컨텍스트를 만들지 않아 개인정보 조회만 막힌다(안전한 방향).
 */
export interface ConsentLookup {
  policy: ConsentPolicy;
  records: readonly ConsentRecord[];
  subjectRef: string;
  now: string;
}

export function buildConsentLookup(
  policy: ConsentPolicy,
  store: ConsentStore,
  subjectRef: string | undefined,
  now: string,
): ConsentLookup | undefined {
  if (typeof subjectRef !== 'string' || subjectRef.trim() === '') return undefined;
  let records: readonly ConsentRecord[];
  try {
    records = store.list(subjectRef);
  } catch {
    return undefined;
  }
  if (!Array.isArray(records)) return undefined;
  return { policy, records, subjectRef, now };
}

export interface ConsentBindingIssues {
  /** 하나라도 있으면 배선하지 않는다. */
  errorsKo: string[];
  /** 막지는 않되 운영이 반드시 보아야 하는 것. */
  warningsKo: string[];
}

/**
 * 배선 시점 검증. **통화 중이 아니라 여기서 걸러야 한다** — 미승인 정책·중복 선언은 설정
 * 오류이지 런타임 장애가 아니고, 통과시키면 오타 하나로 동의 수집이 조용히 꺼진 채
 * "적용했다"로 남는다(고지·라우팅·전환·요청 제한기와 같은 규칙).
 *
 * 판정 규칙은 `validateConsentPolicy` 하나다 — 여기서 승인·중복·유효기간을 다시 보지 않는다(§2).
 */
export function validateConsentBinding(policy: ConsentPolicy, scope: TenantScope): ConsentBindingIssues {
  const errorsKo: string[] = [];
  const warningsKo: string[] = [];
  if (policy.tenantId !== scope.tenantId) {
    errorsKo.push(`다른 테넌트의 동의 정책입니다: 정책=${policy.tenantId} 코어=${scope.tenantId} (설계서 §11.1)`);
  }
  if ((policy.workspaceId ?? undefined) !== undefined && policy.workspaceId !== scope.workspaceId) {
    errorsKo.push(`다른 워크스페이스의 동의 정책입니다: 정책=${String(policy.workspaceId)} 코어=${String(scope.workspaceId)} (설계서 §11.1)`);
  }
  for (const issue of validateConsentPolicy(policy)) {
    (issue.severity === 'error' ? errorsKo : warningsKo).push(issue.messageKo);
  }
  return { errorsKo, warningsKo };
}
