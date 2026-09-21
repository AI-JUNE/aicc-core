// Api 노드 이행 펌프 — 설계서 §5.3(Api 노드)·§6.1(연동)·§9.3(폴백)·§11.1(테넌트 격리)·§13-3.
//
// (14)가 `executeConnector` 를 만들어 "호출한 뒤"의 빈 자리를 메웠지만, **그 실행기를 부르는 곳이
// 저장소 전체에 0건**이었다. Runner 는 Api 노드에서 `pendingConnectorId` 를 세우고 멈추는데,
// 그 필드를 **읽는 코드가 어디에도 없다** — runner.ts 가 세우는 한 줄(172)과 지우는 한 줄(247)이 전부다.
//
// 그 상태의 증상은 예외가 아니라 **무음**이라서 더 나쁘다. Api 대기 중에 커넥터 결과가 아닌 입력이
// 오면 `runner.send` 는 **빈 결과**(steps 0건·events 0건)를 돌려준다(runner.ts §6.1 구간, 246행).
// 즉 고객이 무슨 말을 해도 채널은 렌더할 것이 없고, 통화는 끊기지도 않은 채 멈춘 상태로 남는다.
// 장애 알림도 울리지 않는다 — 어떤 오류도 발생하지 않았기 때문이다.
//
// 그대로 두면 채널 3곳이 각자 이 펌프를 쓰게 되고, 그 20줄에서 빠지는 것은 취향이 아니라 정해져 있다.
//   1) **재진입마다 멱등 키를 새로 만든다.** `executeConnector` 는 자기 재시도 루프 안에서만 키를
//      고정한다. 펌프가 부를 때마다 키를 새로 만들면 command 커넥터에서 **이중 신청**이 되고,
//      로그에는 성공 두 건만 남는다. 그래서 키는 **논리적 호출 단위**로 고정되고(같은 대기 건에
//      다시 들어오면 같은 키), 시나리오가 onError 를 지나 같은 Api 노드를 **다시 밟았을 때만** 바뀐다.
//   2) **`blocked` 를 성공으로 읽는다.** `toFlowInput` 이 이미 막지만 각자 변환하면 되풀이된다.
//   3) **선언을 못 찾으면 그냥 멈춘다.** 커넥터 id 오타·미배포는 위의 **무음**으로 나타난다.
//      여기서는 실패로 내려 시나리오의 onError·§9.3 이관이 돌게 한다 — 단 **백엔드 장애로 집계하지
//      않는다**(우리 쪽 설정 오류인데 업무시스템이 down 으로 적히면 전 채널이 상담사 직결로 떨어진다).
//   4) **순환을 못 막는다.** `onError` 가 다시 Api 노드를 가리키면 펌프는 영원히 돈다 —
//      `advance()` 의 구조적 상한과 같은 방식으로 **시나리오의 Api 노드 수**로 막는다(정책 수치가 아니다).
//   5) **동의 컨텍스트 조립이 던지면 통화가 끊긴다.** 호스트 코드의 예외를 통화 밖으로 내보내지 않고
//      **동의 없음으로 취급한다** — pii 파라미터가 선언돼 있으면 `executeConnector` 가 막고,
//      선언돼 있지 않으면 동의가 필요 없었으므로 그대로 진행한다. 판정은 한 곳(§10.1)에만 둔다.
//
// 하지 않는 것: 네트워크 접근·세션 변형·판정. 실제 호출은 주입된 `ConnectorPort` 가 하고,
// 게이트·재시도·마스킹은 전부 `executeConnector` 한 곳이다(여기서 복사하지 않는다).
import type { TenantScope } from '../core/tenancy.ts';
import type { Flow } from '../flow/types.ts';
import type { FlowInput } from '../flow/runner.ts';
import type { HealthSample } from '../ops/fallback.ts';
import type { ConnectorDef, ConnectorPort } from './connector.ts';
import type { ConsentContext, ExecuteOutcome } from './executeConnector.ts';
import { executeConnector, toFlowInput } from './executeConnector.ts';

export const CONNECTOR_PUMP_CONTRACT_VERSION = 1;

/**
 * 커넥터 선언 조회. Core 는 선언을 **만들지 않는다** — 없으면 `undefined` 다(§13-3).
 * 조회 구현이 던져도 펌프는 던지지 않는다(아래 `pumpConnectorHop`).
 */
export interface ConnectorRegistry {
  get(connectorId: string): ConnectorDef | undefined;
}

/** 멱등 키의 재료. `call` 은 **같은 Api 노드를 다시 밟은 회차**(1부터)다 — 시도 번호가 아니다. */
export interface PumpIdentity {
  interactionId: string;
  connectorId: string;
  call: number;
}

export interface ConnectorPumpBinding {
  connectors: ConnectorRegistry;
  port: ConnectorPort;
  /** §10.3 — 기본값 없음. 테넌트 설정을 명시적으로 넘긴다. */
  allowOverseas: boolean;
  /**
   * §10.1 동의 컨텍스트. pii 파라미터가 선언된 커넥터에 **필수**다 —
   * 주지 않으면 `executeConnector` 가 호출 자체를 막는다(없음을 통과로 읽지 않는다).
   * 세션마다 주체가 다르므로 함수로 받는다. 던지면 "없음"으로 취급한다.
   */
  consent?: (args: {
    interactionId: string;
    connectorId: string;
    slots: Readonly<Record<string, string>>;
  }) => ConsentContext | undefined;
  /** 재시도 간격(ms). `retry.maxAttempts > 1` 인 커넥터에 없으면 실행기가 설정 오류로 거절한다. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 멱등 키 생성 규칙. 업무시스템이 형식을 요구하면 호스트가 바꾼다.
   * 바꾸더라도 **같은 `PumpIdentity` 에 같은 값**을 줘야 한다 — 매번 다른 값을 주면 (1)이 무의미해진다.
   */
  idempotencyKey?: (id: PumpIdentity) => string;
  /**
   * 실행기 앞에서 끊긴 건·동의 조립 예외 보고. **삼키지 않기 위해 있다** —
   * 커넥터 id 오타는 예외가 아니라 "그 조회만 안 된다"로 나타나므로 여기로 나오지 않으면
   * 몇 주 뒤에 발견된다. 주지 않으면 조용히 진행한다(§13-3, 기본 동작을 만들지 않는다).
   */
  onBlock?: (info: {
    interactionId: string;
    connectorId: string;
    block?: PumpBlock;
    consentError?: string;
  }) => void;
}

/** 호출까지 가지 못하고 끊긴 사유. **업무시스템 장애가 아니다** — 헬스에 집계하지 않는다. */
export type PumpBlock = 'connector_undefined' | 'hop_limit';

export interface PumpHopResult {
  /** Runner 에 그대로 넣을 입력. 어떤 경로로 끝나도 **반드시 만들어진다**(무음으로 멈추지 않는다). */
  input: Extract<FlowInput, { kind: 'connectorResult' }>;
  connectorId: string;
  idempotencyKey: string;
  /** 실행기까지 간 경우에만 있다. */
  outcome?: ExecuteOutcome;
  /** 실행기 앞에서 끊긴 경우에만 있다. */
  block?: PumpBlock;
  /** 동의 컨텍스트 조립이 던졌다 — 설정 문제이므로 삼키지 않고 드러낸다(§10.1). */
  consentError?: string;
}

/**
 * 기본 멱등 키. **정책 수치가 아니라 식별자**다 — 실행기가 키를 요구하므로 펌프가 만들어야 한다.
 * 같은 (통화·커넥터·회차)에 항상 같은 값이고, 회차가 늘 때만 바뀐다.
 */
export function defaultIdempotencyKey(id: PumpIdentity): string {
  return `${id.interactionId}:${id.connectorId}:${id.call}`;
}

/** 시나리오에 선언된 Api 노드 id. */
export function apiNodeIds(flow: Flow): string[] {
  return Object.values(flow.nodes ?? {})
    .filter((n) => n.kind === 'Api')
    .map((n) => n.id);
}

/**
 * 한 턴에 허용하는 커넥터 이행 횟수의 **구조적 상한**. `advance()` 의 순회 상한과 같은 성격이며
 * 테넌트가 정할 값이 아니다(§13-3) — Api 노드를 전부 한 번씩 지나고 한 번 더 시도할 여유까지다.
 * 이 상한을 넘었다면 `onError` 가 Api 노드를 다시 가리키는 **순환**이다.
 */
export function connectorHopLimit(flow: Flow): number {
  return apiNodeIds(flow).length + 1;
}

/** 시나리오가 가리키는 커넥터 선언이 조회되지 않는 Api 노드. **통화 시작 전에** 본다. */
export function missingConnectors(flow: Flow, connectors: ConnectorRegistry): { nodeId: string; connectorId: string }[] {
  const out: { nodeId: string; connectorId: string }[] = [];
  for (const node of Object.values(flow.nodes ?? {})) {
    if (node.kind !== 'Api') continue;
    if (typeof node.connectorId !== 'string' || node.connectorId.trim() === '') continue;  // validateFlow 가 잡는다
    let found: ConnectorDef | undefined;
    try {
      found = connectors.get(node.connectorId);
    } catch {
      found = undefined;   // 조회가 던지는 것도 "없음"이다 — 통화 중에 알게 되면 늦다
    }
    if (!found) out.push({ nodeId: node.id, connectorId: node.connectorId });
  }
  return out;
}

export interface PumpHopInput {
  binding: ConnectorPumpBinding;
  connectorId: string;
  scope: TenantScope;
  interactionId: string;
  slots: Readonly<Record<string, string>>;
  /** 같은 Api 노드를 밟은 회차(1부터). 멱등 키 고정의 근거다. */
  call: number;
  onHealth?: (sample: HealthSample) => void;
  now?: () => string;
}

/**
 * Api 대기 1건을 이행한다: 선언 조회 → 동의 컨텍스트 → 실행기 → Runner 입력 변환.
 *
 * **던지지 않는다** — 단 하나, `executeConnector` 가 테넌트 격리 위반에 던지는 것은 그대로 올린다.
 * 남의 테넌트 커넥터를 부르는 것은 폴백할 사안이 아니다(§11.1).
 *
 * 어떤 경로로 끝나도 `input` 을 만든다. 만들지 않으면 그 통화는 **무음으로 멈춘다** — 이 파일이
 * 존재하는 이유가 바로 그 증상이므로, 여기서 다시 만들지 않는다.
 */
export async function pumpConnectorHop(args: PumpHopInput): Promise<PumpHopResult> {
  const { binding, connectorId, interactionId, slots } = args;
  const keyOf = binding.idempotencyKey ?? defaultIdempotencyKey;
  const idempotencyKey = keyOf({ interactionId, connectorId, call: args.call });

  let def: ConnectorDef | undefined;
  try {
    def = binding.connectors.get(connectorId);
  } catch {
    def = undefined;
  }
  if (!def) {
    // 설정 오류를 성공으로 읽지 않고, 업무시스템 장애로도 적지 않는다.
    return {
      input: { kind: 'connectorResult', ok: false, errorCode: 'connector_undefined' },
      connectorId, idempotencyKey, block: 'connector_undefined',
    };
  }

  let consent: ConsentContext | undefined;
  let consentError: string | undefined;
  if (binding.consent) {
    try {
      consent = binding.consent({ interactionId, connectorId, slots });
    } catch (e) {
      // 호스트 코드의 예외로 통화를 끊지 않는다(§9.3). 동의는 "없음"이 되고,
      // pii 가 선언돼 있으면 실행기가 막는다 — 판정은 §10.1 한 곳에만 둔다.
      consent = undefined;
      consentError = e instanceof Error ? e.message : String(e);
    }
  }

  const outcome = await executeConnector({
    def,
    slots,
    scope: args.scope,
    interactionId,
    idempotencyKey,
    port: binding.port,
    allowOverseas: binding.allowOverseas,
    ...(consent !== undefined ? { consent } : {}),
    ...(binding.backoffMs !== undefined ? { backoffMs: binding.backoffMs } : {}),
    ...(binding.sleep !== undefined ? { sleep: binding.sleep } : {}),
    ...(args.onHealth !== undefined ? { onHealth: args.onHealth } : {}),
    ...(args.now !== undefined ? { now: args.now } : {}),
  });

  return {
    input: toFlowInput(outcome),
    connectorId, idempotencyKey, outcome,
    ...(consentError !== undefined ? { consentError } : {}),
  };
}

/** 순환 상한에 걸렸을 때 Runner 에 넣는 입력. 무음으로 멈추지 않도록 **실패로 내린다**. */
export function hopLimitInput(): Extract<FlowInput, { kind: 'connectorResult' }> {
  return { kind: 'connectorResult', ok: false, errorCode: 'connector_hop_limit' };
}
