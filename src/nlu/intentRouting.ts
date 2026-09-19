// 인텐트 판정 → 시나리오 진입 라우팅 — 설계서 §5.3(단일 시나리오)·§5.1(폴백)·§2(이중 관리 금지)·
// §11.1(테넌트 격리)·§13-3(임의 기본값 금지).
//
// `nlu/intent.ts` 의 `nextStep` 은 `{ step: 'proceed', intent }` 까지 내놓고 **거기서 끝난다**.
// 그 다음 한 걸음 — "그래서 어느 시나리오를 시작하는가" — 를 하는 코드가 저장소 어디에도 없었다.
// 그대로 두면 Callbot·챗봇·D-ARS 가 각자 `switch (intent)` 를 쓰게 되고, 갈라지는 방식은 이미 정해져 있다.
//   1) **모르는 인텐트를 대표 시나리오로 보낸다.** "카드 분실"이 메인 메뉴로 떨어지면 장애로 보이지 않고
//      "봇이 못 알아듣더라"로만 남는다 — 라우팅이 빠졌다는 사실은 영영 드러나지 않는다.
//   2) **`handoffOnly` 인텐트에 시나리오를 붙인다.** 사람에게 가야 할 민원이 봇 흐름을 타고,
//      그 사실은 이관 통계에도 안 잡힌다(§2).
//   3) **오탈자 flowId 를 통화 중에 만난다.** Runner 는 "정의되지 않은 노드"로 세션을 실패시킨다.
//   4) **명확화 선택지 번호가 화면과 음성에서 어긋난다.** 표시 순서와 `resolveClarifyChoice` 의
//      1-based 인덱스가 다른 배열을 보면 고객이 "2번"이라고 말한 것과 다른 인텐트가 확정된다.
// 그래서 (1)(2)(3)은 **등록 시점에** 거절하고, (4)는 표시 순서를 판정 결과와 같은 배열에서만 만든다.
//
// 이 모듈은 **판정하지 않는다.** 수락·명확화·미인식 판정은 `decideIntent` 가 이미 했고,
// 여기서 규칙을 다시 쓰면 §2 가 지적한 이중 관리가 인텐트 규칙에서 되풀이된다. 하는 일은 매핑뿐이다.
import type { Flow } from '../flow/types.ts';
import { assertTenantScope, isValidId, type TenantScope } from '../core/tenancy.ts';
import type { ClarifyOption, IntentCatalog, IntentDecision } from './intent.ts';
import { nextStep } from './intent.ts';

export const INTENT_ROUTING_CONTRACT_VERSION = 1;

/** 시나리오 조회. `channels/runtime.ts` 의 `FlowRegistry` 와 구조가 같다 — 채널 계층에 의존하지 않으려고 따로 둔다. */
export interface FlowLookup {
  get(flowId: string, version?: number): Flow | undefined;
}

export interface IntentRoute {
  intent: string;
  flowId: string;
  /** 지정하면 그 버전으로 고정한다. 생략하면 조회 시점의 최신 버전(§5.3 배포 수명주기). */
  flowVersion?: number;
  /** 시나리오 중간부터 시작해야 할 때. 생략하면 `startNodeId`. */
  entryNodeId?: string;
}

export interface IntentRoutingTable {
  tenantId: string;
  workspaceId?: string;
  routes: IntentRoute[];
}

export type RoutingIssueCode =
  | 'E_TENANT_INVALID'
  | 'E_INTENT_UNKNOWN'
  | 'E_INTENT_DISABLED'
  | 'E_ROUTE_DUPLICATE'
  | 'E_HANDOFF_ONLY_ROUTED'
  | 'E_FLOW_UNKNOWN'
  | 'E_ENTRY_NODE_UNKNOWN'
  | 'W_INTENT_UNROUTED';

export interface RoutingIssue {
  code: RoutingIssueCode;
  severity: 'error' | 'warning';
  messageKo: string;
  intent?: string;
}

/**
 * 라우팅 표 검증. **통화 중에 드러날 결함을 등록 시점으로 끌어온다**는 것이 이 함수의 전부다.
 * 카탈로그에 있는데 라우트가 없는 인텐트는 경고로 **드러낸다** — 조용히 unrouted 로 나타나면
 * "봇이 못 알아듣는다"로만 보이고 원인이 라우팅 누락이라는 사실은 보이지 않는다.
 */
export function validateIntentRouting(
  table: IntentRoutingTable,
  catalog: IntentCatalog,
  flows: FlowLookup,
): RoutingIssue[] {
  const issues: RoutingIssue[] = [];
  const err = (code: RoutingIssueCode, messageKo: string, intent?: string) =>
    issues.push({ code, severity: 'error', messageKo, ...(intent !== undefined ? { intent } : {}) });
  const warn = (code: RoutingIssueCode, messageKo: string, intent?: string) =>
    issues.push({ code, severity: 'warning', messageKo, ...(intent !== undefined ? { intent } : {}) });

  if (!isValidId(table.tenantId)) {
    err('E_TENANT_INVALID', `tenant_id 형식 위반: ${JSON.stringify(table.tenantId)} (§11.1)`);
  }
  if (table.workspaceId !== undefined && !isValidId(table.workspaceId)) {
    err('E_TENANT_INVALID', `workspace_id 형식 위반: ${JSON.stringify(table.workspaceId)} (§11.1)`);
  }
  if (catalog.tenantId !== table.tenantId) {
    err('E_TENANT_INVALID', `다른 테넌트의 카탈로그로 라우팅을 검증할 수 없다: 표=${table.tenantId} 카탈로그=${catalog.tenantId} (§11.1)`);
    return issues;
  }

  const specs = new Map(catalog.intents.map((s) => [s.id, s] as const));
  const seen = new Set<string>();

  for (const r of table.routes) {
    const spec = specs.get(r.intent);
    if (!spec) {
      err('E_INTENT_UNKNOWN', `카탈로그에 없는 인텐트로 라우트가 걸려 있습니다: ${r.intent}`, r.intent);
      continue;
    }
    if (spec.disabled) {
      // 비활성 인텐트는 decideIntent 가 후보에서 버리므로 이 라우트는 영영 닿지 않는다.
      // 닿지 않는 설정을 남겨 두면 "설정했는데 왜 안 되지"로 끝난다.
      err('E_INTENT_DISABLED', `비활성 인텐트에 라우트가 걸려 있습니다(영영 닿지 않습니다): ${r.intent}`, r.intent);
    }
    if (spec.handoffOnly === true) {
      err('E_HANDOFF_ONLY_ROUTED',
        `상담사 전용 인텐트에 시나리오를 붙일 수 없습니다: ${r.intent} — 붙이면 사람에게 가야 할 건이 봇 흐름을 탑니다(§2)`,
        r.intent);
    }
    if (seen.has(r.intent)) {
      // 자동으로 고르지 않는다. 순서로 시나리오가 조용히 바뀌면 배포 때마다 응대가 달라진다.
      err('E_ROUTE_DUPLICATE', `같은 인텐트에 라우트가 둘 이상입니다: ${r.intent}`, r.intent);
    }
    seen.add(r.intent);

    const flow = flows.get(r.flowId, r.flowVersion);
    if (!flow) {
      err('E_FLOW_UNKNOWN',
        `없는 시나리오로 라우트가 걸려 있습니다: ${r.flowId}${r.flowVersion !== undefined ? ` v${r.flowVersion}` : ''}`,
        r.intent);
      continue;
    }
    if (r.entryNodeId !== undefined && flow.nodes[r.entryNodeId] === undefined) {
      err('E_ENTRY_NODE_UNKNOWN', `시나리오 ${flow.id} v${flow.version} 에 없는 진입 노드입니다: ${r.entryNodeId}`, r.intent);
    }
  }

  for (const s of catalog.intents) {
    if (s.disabled || s.handoffOnly === true) continue;
    if (!seen.has(s.id)) {
      warn('W_INTENT_UNROUTED', `라우트가 없는 인텐트입니다(확정되어도 갈 곳이 없습니다): ${s.id}`, s.id);
    }
  }
  return issues;
}

export function intentRoutingOk(issues: readonly RoutingIssue[]): boolean {
  return issues.every((i) => i.severity !== 'error');
}

/** 라우트가 없는 활성 인텐트 — 준비도 보고의 근거. 건수만 적고 비율은 만들지 않는다(§13-3). */
export function unroutedIntents(
  table: IntentRoutingTable,
  catalog: IntentCatalog,
): string[] {
  const routed = new Set(table.routes.map((r) => r.intent));
  return catalog.intents
    .filter((s) => !s.disabled && s.handoffOnly !== true && !routed.has(s.id))
    .map((s) => s.id);
}

// ── 라우팅 ────────────────────────────────────────────────────────────────────

/** 명확화 선택지 + 표시 번호. `position` 은 `resolveClarifyChoice` 의 1-based 인덱스와 **같은 배열**에서 나온다. */
export interface NumberedClarifyOption extends ClarifyOption {
  position: number;
}

export type RouteAction =
  /** 시나리오를 시작한다. `flow` 는 조회까지 끝난 실물이라 호출자가 다시 찾지 않는다. */
  | { kind: 'start_flow'; intent: string; flow: Flow; entryNodeId: string; confidence?: number }
  /** 확정됐지만 상담사 전용 인텐트다(§2). 시나리오를 타지 않는다. */
  | { kind: 'handoff'; intent: string; reasonKo: string }
  /** 되묻는다. 문구는 테넌트가 선언한 것만 쓴다 — 없으면 만들지 않고 드러낸다(§13-3). */
  | { kind: 'clarify'; options: NumberedClarifyOption[]; nextAttempt: number; prompt?: string; promptMissing: boolean }
  /** 확정됐는데 갈 곳이 없다. 미인식과 **구분해서** 드러낸다 — 원인이 설정 누락이기 때문이다. */
  | { kind: 'unrouted'; intent: string; reasonKo: string }
  /** 미인식. §5.1 실패 카운트를 1 올리고 폴백 사다리에 태운다 — 사다리 규칙은 여기서 다시 쓰지 않는다. */
  | { kind: 'fallback'; failureIncrement: 1; reasonKo: string };

export interface RouteIntentInput {
  scope: TenantScope;
  decision: IntentDecision;
  table: IntentRoutingTable;
  flows: FlowLookup;
  /** 명확화 질문 문구. 주지 않으면 Core 가 지어내지 않는다(§13-3) — `promptMissing` 으로 드러난다. */
  clarifyPrompt?: string;
}

/**
 * 판정 결과를 다음 행동으로 옮긴다. 판정은 이미 끝났다 — 여기서 임계값·사다리를 다시 보지 않는다.
 *
 * 라우트를 못 찾았을 때 **대표 시나리오로 보내지 않는다**(§13-3). 그 한 줄이 없으면
 * 라우팅 누락은 영영 "봇이 못 알아듣는다"로만 보이고, 어느 인텐트가 빠졌는지는 아무도 모른다.
 */
export function routeIntent(input: RouteIntentInput): RouteAction {
  assertTenantScope(input.scope);
  const { table, decision, flows } = input;
  if (table.tenantId !== input.scope.tenantId) {
    throw new Error(`다른 테넌트의 라우팅 표로 시나리오를 시작할 수 없다: 기대=${input.scope.tenantId} 실제=${table.tenantId} (설계서 §11.1)`);
  }
  if (table.workspaceId !== undefined && input.scope.workspaceId !== undefined
      && table.workspaceId !== input.scope.workspaceId) {
    throw new Error(`테넌트 격리 위반(intent routing): 기대 workspace=${input.scope.workspaceId} 실제=${table.workspaceId} (설계서 §11.1)`);
  }

  const step = nextStep(decision);
  if (step.step === 'fallback') {
    return { kind: 'fallback', failureIncrement: 1, reasonKo: decision.reasonKo };
  }
  if (step.step === 'clarify') {
    const options = step.options.map((o, i) => ({ ...o, position: i + 1 }));
    const prompt = input.clarifyPrompt;
    return {
      kind: 'clarify',
      options,
      nextAttempt: step.nextAttempt,
      ...(prompt !== undefined && prompt.trim() !== '' ? { prompt } : {}),
      promptMissing: prompt === undefined || prompt.trim() === '',
    };
  }
  if (step.step === 'handoff') {
    return { kind: 'handoff', intent: step.intent, reasonKo: decision.reasonKo };
  }

  const route = table.routes.find((r) => r.intent === step.intent);
  if (!route) {
    return { kind: 'unrouted', intent: step.intent, reasonKo: '확정된 인텐트에 연결된 시나리오가 없습니다' };
  }
  const flow = flows.get(route.flowId, route.flowVersion);
  if (!flow) {
    // 등록 시점 검증을 지나왔다면 여기 오지 않는다. 그래도 통화를 죽이지 않고 드러낸다(§9.3).
    return {
      kind: 'unrouted',
      intent: step.intent,
      reasonKo: `연결된 시나리오를 찾을 수 없습니다: ${route.flowId}${route.flowVersion !== undefined ? ` v${route.flowVersion}` : ''}`,
    };
  }
  const entryNodeId = route.entryNodeId ?? flow.startNodeId;
  if (flow.nodes[entryNodeId] === undefined) {
    return { kind: 'unrouted', intent: step.intent, reasonKo: `시나리오 ${flow.id} v${flow.version} 에 진입 노드가 없습니다: ${entryNodeId}` };
  }
  return {
    kind: 'start_flow',
    intent: step.intent,
    flow,
    entryNodeId,
    ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
  };
}
