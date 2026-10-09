// 스튜디오 수명주기 실행기 — 설계서 §5.3(시나리오 단일 관리·배포)·§6.1(커넥터)·
// §10(최소권한·직무분리)·§10.2(접근·변경 기록)·§11.1(테넌트 격리)·§13-3(임의 기본값 금지).
//
// `flow/lifecycle.ts` 는 편집본과 운영본 사이에 게이트 두 개를 세웠고(검증 통과·작성자 자기승인
// 금지), `flow/deployedFlows.ts` 는 배포 기록을 런타임까지 이었다. 그런데 **그 전이를 실제로
// 일으키는 자리가 저장소 어디에도 없다** — `createDraft`·`submitForReview`·`approve`·`reject`·
// `publish`·`rollback` 을 부르는 곳은 테스트뿐이다. 그래서 지금 저장소에는 **게이트는 있고
// 게이트를 지나가는 길이 없다.** 호스트가 그 길을 손으로 깔면 빠지는 것은 정해져 있고,
// 여섯 개 전부 **어디에서도 터지지 않는다**.
//
//  (가) **배포·롤백이 감사에 남지 않는다.** `studio.publish` 는 `mutates: true` 로 선언돼 있고
//      `defaultActionFor` 는 그 라우트를 `publish` 액션으로 매핑해 둔다 — 그런데 `recordAccess`
//      를 지나는 경로가 없다. 사고 조사에서 가장 먼저 묻는 "누가 언제 무엇을 올렸나"가 비어 있고,
//      비어 있다는 사실은 사고가 나야 알게 된다.
//  (나) **권한 검사가 없다.** IA 는 스튜디오를 `tenant_owner`·`admin` 에만 열어 뒀는데
//      `lifecycle.ts` 는 역할을 **모른다** — 인자가 `by: string` 하나다. 상담사·분석가 계정으로
//      부른 배포도 타입이 통과하고 레지스트리에 그대로 쌓인다.
//  (다) **행위자가 두 번 선언된다.** 감사에 적히는 사람(`actor.userId`)과 전이에 적히는 사람
//      (`by`)이 다른 값일 수 있으면 **직무분리 검사가 무력해진다** — `approve` 는 `createdBy`
//      와 `by` 를 비교하므로, 승인자 칸에 남의 id 를 적으면 자기승인이 통과한다.
//      그래서 이 실행기는 `by` 를 받지 않는다. 행위자는 `actor.userId` 하나다.
//  (라) **커넥터 대조가 배포 게이트에 걸려 있지 않다.** `validateFlowConnectors` 머리말에
//      "배포 게이트가 테넌트 커넥터 목록을 넣어 호출한다"고 적혀 있는데 **부르는 곳이 테스트뿐**
//      이다(§6.1). 등록되지 않은 커넥터를 가리키는 Api 노드가 그대로 운영에 올라가고, 증상은
//      배포 시점이 아니라 **그 노드에 도달한 통화**에서 나타난다.
//      **승인 시점이 아니라 배포·롤백 시점에 본다** — 커넥터는 테넌트 설정이라 승인과 배포
//      사이에 지워질 수 있고, 롤백 대상(과거 버전)이 가리키던 커넥터는 특히 그렇다.
//  (마) **레지스트리 반환값을 버리면 아무 일도 일어나지 않는다.** 전이 함수는 전부 **새**
//      레지스트리를 돌려준다. 그 값을 저장하지 않으면 운영자는 "배포했다"를 보고 런타임은 예전
//      버전을 계속 쓴다 — `deployedFlows.ts` 가 스냅샷 대신 함수로만 레지스트리를 받는 이유와
//      같은 실패이고, 증상도 같다(사고 중에 가장 비싼 거짓). 그래서 **저장은 실행기가 한다**.
//  (바) **같은 채널을 두 번 선언한다.** `publish` 는 `channels.map` 으로 배포 행을 만들므로
//      `['voice','voice']` 는 **같은 채널에 두 행**을 남긴다. 조회는 `find` 라 당장 멀쩡해 보이고,
//      나중에 롤백이 두 행을 함께 고쳐 `deploymentStatus` 와 어긋난다. 고쳐 쓰지 않고 거절한다.
//
// 경계:
//  - **판정을 복사하지 않는다(§2).** 단계 전이는 `lifecycle.ts`, 시나리오 검증은 `validateFlow`,
//    커넥터 대조는 `validateFlowConnectors`, 권한·격리·기록은 `audit/access.ts` 하나다.
//    이 파일에는 전이표도 역할 목록도 자기승인 규칙도 없다.
//  - **권한 유무 외의 정보를 흘리지 않는다.** 권한이 없으면 검증 결과·리비전 존재 여부를
//    돌려주지 않는다(`executeInteractions` 와 같은 규칙).
//  - **저장 실패를 성공으로도 미실행으로도 적지 않는다.** `commit` 이 던지면 결과는
//    `uncommitted` 이고 감사에는 `error` 로 남는다 — "배포됐다"도 "아무 일 없었다"도 아니다.
//  - **되돌릴 수 없는 것을 먼저 하지 않는다.** 순서가 곧 안전장치다:
//    형태 → 권한 → 전이 계산 → 게이트 → **저장** → 감사. 어느 단계에서 걸려도 레지스트리가
//    바뀌지 않는다.
//  - **id·시각을 만들지 않는다**(§13-3). `at`·`recordId` 는 호스트가 주입한다.
import type { ChannelKind } from '../domain/types.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { AuditAction, AuditChain, AuditRecord, Hasher } from '../audit/log.ts';
import { appendAudit } from '../audit/log.ts';
import { decideAccess, recordAccess, type AccessActor, type AccessRequest } from '../audit/access.ts';
import type { Flow } from './types.ts';
import { validateFlow, validateFlowConnectors } from './validate.ts';
import type { ChannelStatus, FlowRegistry, LifecycleResult } from './lifecycle.ts';
import {
  approve, createDraft, deploymentStatus, findRevision, publish, reject, rollback, submitForReview,
} from './lifecycle.ts';

export const DEPLOYMENT_EXEC_CONTRACT_VERSION = 1;

/** 스튜디오 편집 라우트(초안 등록·승인 요청). IA 에 선언된 id 를 그대로 쓴다. */
export const STUDIO_EDITOR_ROUTE_ID = 'studio.editor';
/** 스튜디오 배포 라우트(승인·반려·배포·롤백). `defaultActionFor` 가 `publish` 액션으로 매핑한다. */
export const STUDIO_PUBLISH_ROUTE_ID = 'studio.publish';

export type DeploymentOp = 'create' | 'submit' | 'approve' | 'reject' | 'publish' | 'rollback';

export type DeploymentStatusCode =
  /** 전이가 반영되고 저장됐다 */
  | 'ok'
  /** 권한·격리 거부. 기록은 남는다. */
  | 'denied'
  /** 게이트 거부(검증 오류·자기승인·단계 위반·커넥터 미등록). 기록은 남는다. */
  | 'rejected'
  /** 형태 오류 — 전이도 기록도 일어나지 않았다 */
  | 'invalid'
  /** 저장이 실패했다. **성공도 미실행도 아니다.** */
  | 'uncommitted';

export interface DeploymentRequest {
  scope: TenantScope;
  actor: AccessActor;
  op: DeploymentOp;
  /** 관측 시각(ISO8601) — 주입. */
  at: string;
  /** 감사 레코드 식별자 — 생성기는 호스트가 가진다. */
  recordId: string;
  /** `create` 에서만 쓴다. */
  flow?: Flow;
  /** `create` 를 제외한 모든 op. */
  flowId?: string;
  /** `create`·`rollback` 을 제외한 모든 op. */
  version?: number;
  /** `publish` 대상 채널. 부분 배포가 정상 시나리오다(§5.3). */
  channels?: readonly ChannelKind[];
  /**
   * `rollback` 대상 채널. **단수다** — 배포 단위가 "(Flow, 채널)"이므로 한 채널만 되돌리는 것이
   * 정상 운영이고(§5.3), 여기에 `channels[0]` 을 끌어다 쓰면 **어느 채널을 되돌렸는지가
   * 선언 순서에 달린다**(콜봇을 되돌리려다 챗봇을 되돌린다).
   */
  channel?: ChannelKind;
  /** `rollback` 대상 버전. */
  toVersion?: number;
  /** `reject` 사유. 비어 있으면 반려 이력이 쓸모없어진다. */
  reason?: string;
  /**
   * 테넌트에 등록된 커넥터 id 목록(§6.1·§11.1 — **반드시 이 테넌트 스코프로 조회한 것**).
   * `publish`·`rollback` 에서 Api 노드를 가진 Flow 를 올릴 때 필요하다. 없으면 **통과시키지
   * 않고 거절한다** — 건너뛴 검사는 통과의 근거가 아니다(§13-3).
   */
  connectorIds?: readonly string[];
  note?: string;
}

export interface DeploymentResult {
  status: DeploymentStatusCode;
  op: DeploymentOp;
  messageKo: string;
  flowId?: string;
  version?: number;
  /** 저장이 실제로 일어났는가. `ok` 이외에는 항상 false. */
  committed: boolean;
  /** 반영된 레지스트리(확인용). 저장은 이미 `commit` 으로 끝났다. */
  registry?: FlowRegistry;
  /** 반영 후 채널별 현황. 미배포 채널은 version 없이 드러난다. */
  deployments?: readonly ChannelStatus[];
  /** 거부 사유(마스킹 경유). 권한 거부에서는 비어 있다 — 정보를 흘리지 않는다. */
  issues: readonly string[];
  warnings: readonly string[];
  chain: AuditChain;
  recorded: boolean;
  record?: AuditRecord;
}

export interface DeploymentPorts {
  /**
   * 레지스트리를 **그때그때 읽는 함수**. 스냅샷을 받지 않는 이유는 `deployedFlows.ts` 와 같다 —
   * 조립 시점의 객체를 붙들면 직전 배포가 보이지 않는 채로 전이가 계산된다.
   */
  registry: () => FlowRegistry;
  /** 반영된 레지스트리 저장. **원자적이어야 한다** — 부분 저장은 아래 `uncommitted` 가 가리는 범위다. */
  commit: (next: FlowRegistry) => void;
  hash: Hasher;
}

function mask(text: string): string {
  return maskPii(text).text;
}

const OP_ROUTE: Record<DeploymentOp, string> = {
  create: STUDIO_EDITOR_ROUTE_ID,
  submit: STUDIO_EDITOR_ROUTE_ID,
  approve: STUDIO_PUBLISH_ROUTE_ID,
  reject: STUDIO_PUBLISH_ROUTE_ID,
  publish: STUDIO_PUBLISH_ROUTE_ID,
  rollback: STUDIO_PUBLISH_ROUTE_ID,
};

/**
 * op → 감사 액션. 라우트 기본값(`defaultActionFor`)에 맡기면 초안 등록과 배포가 같은
 * `update`·`publish` 로 뭉개져 감사로그에서 구분되지 않는다.
 */
const OP_ACTION: Record<DeploymentOp, AuditAction> = {
  create: 'create',
  submit: 'update',
  approve: 'approve',
  reject: 'approve',
  publish: 'publish',
  rollback: 'publish',
};

const OP_LABEL: Record<DeploymentOp, string> = {
  create: '초안 등록',
  submit: '승인 요청',
  approve: '승인',
  reject: '반려',
  publish: '배포',
  rollback: '롤백',
};

/** 형태 검증. 전이 함수에 넘기기 전에 **op 별로 필요한 선언이 있는지만** 본다. */
function shapeIssues(req: DeploymentRequest): string[] {
  const out: string[] = [];
  if (typeof req.at !== 'string' || req.at.length === 0) out.push('관측 시각(at)이 비어 있다');
  if (typeof req.recordId !== 'string' || req.recordId.length === 0) {
    out.push('감사 레코드 id(recordId)가 비어 있다 — 기록할 수 없는 변경은 반영하지 않는다 (설계서 §10.2)');
  }
  if (typeof req.actor?.userId !== 'string' || req.actor.userId.length === 0) {
    out.push('행위자(actor.userId)가 비어 있다 — 행위자 없는 변경은 남길 수 없다 (설계서 §10.2)');
  }
  if (req.op === 'create') {
    if (!req.flow || typeof req.flow.id !== 'string' || req.flow.id.length === 0) {
      out.push('초안 등록에는 Flow 가 필요하다');
    }
  } else if (typeof req.flowId !== 'string' || req.flowId.length === 0) {
    out.push('대상 시나리오 id(flowId)가 비어 있다');
  }
  if (req.op === 'submit' || req.op === 'approve' || req.op === 'reject' || req.op === 'publish') {
    if (!Number.isInteger(req.version) || (req.version as number) < 1) {
      out.push(`리비전 번호(version)는 1 이상의 정수여야 한다: ${String(req.version)}`);
    }
  }
  if (req.op === 'reject' && (typeof req.reason !== 'string' || req.reason.length === 0)) {
    // 사유 없는 반려는 스튜디오에서 원인을 찾을 수 없다(lifecycle 머리말과 같은 이유).
    out.push('반려 사유(reason)가 비어 있다');
  }
  if (req.op === 'publish') {
    const ch = req.channels;
    if (!Array.isArray(ch) || ch.length === 0) {
      out.push('배포 대상 채널(channels)이 비어 있다');
    } else if (new Set(ch).size !== ch.length) {
      // (바) 고쳐 쓰지 않고 거절한다 — 중복 선언은 호스트의 화면·조회가 틀린 것이다.
      out.push('배포 대상 채널에 중복이 있다 — 같은 채널에 배포 행이 둘 생긴다 (설계서 §5.3)');
    }
  }
  if (req.op === 'rollback') {
    if (!Number.isInteger(req.toVersion) || (req.toVersion as number) < 1) {
      out.push(`롤백 대상 버전(toVersion)은 1 이상의 정수여야 한다: ${String(req.toVersion)}`);
    }
    if (typeof req.channel !== 'string' || req.channel.length === 0) {
      out.push('롤백 대상 채널(channel)이 비어 있다 — 어느 채널을 되돌릴지 추측하지 않는다 (설계서 §5.3)');
    }
  }
  return out;
}

/**
 * (라) 커넥터 대조. **Api 노드가 가리키는 커넥터가 하나라도 있으면 목록 선언을 요구한다.**
 * Api 노드가 없으면 대조할 것이 없으므로 목록도 요구하지 않는다 — 없는 선언을 요구하면
 * 커넥터를 쓰지 않는 테넌트가 배포할 수 없게 된다.
 */
function connectorIssues(flow: Flow, ids: readonly string[] | undefined): string[] {
  const needs = Object.values(flow.nodes ?? {}).some(
    (n) => n.kind === 'Api' && typeof n.connectorId === 'string' && n.connectorId.length > 0,
  );
  if (!needs) return [];
  if (ids === undefined) {
    return [
      'Api 노드가 있는 시나리오는 등록 커넥터 목록(connectorIds) 없이 올릴 수 없다 — '
      + '대조하지 못한 것을 통과로 적지 않는다 (설계서 §6.1·§13-3)',
    ];
  }
  return validateFlowConnectors(flow, ids).map((i) => i.message);
}

/** 검증 오류 앞 3건까지. 전부 실으면 감사 detail 이 시나리오 전체가 된다. */
function headIssues(messages: readonly string[]): string[] {
  return messages.slice(0, 3);
}

interface Transition {
  result: LifecycleResult<FlowRegistry>;
  flowId: string;
  version?: number;
  /** 저장 전에 통과해야 하는 추가 게이트(커넥터 대조). */
  gate: string[];
}

/** 전이 계산. **저장하지 않는다** — 게이트를 다 지난 뒤에만 저장한다. */
function computeTransition(reg: FlowRegistry, req: DeploymentRequest): Transition {
  const scope = req.scope;
  const by = req.actor.userId;

  if (req.op === 'create') {
    const flow = req.flow as Flow;
    return {
      result: createDraft(reg, {
        scope, flow, by, at: req.at,
        ...(req.note !== undefined ? { note: req.note } : {}),
      }),
      flowId: flow.id,
      version: flow.version,
      gate: [],
    };
  }

  const flowId = req.flowId as string;
  const ref = { scope, flowId, version: req.version as number };

  if (req.op === 'submit') {
    return { result: submitForReview(reg, ref, by, req.at), flowId, version: ref.version, gate: [] };
  }
  if (req.op === 'approve') {
    return { result: approve(reg, ref, by, req.at), flowId, version: ref.version, gate: [] };
  }
  if (req.op === 'reject') {
    return { result: reject(reg, ref, by, req.reason as string), flowId, version: ref.version, gate: [] };
  }
  if (req.op === 'publish') {
    const rev = findRevision(reg, scope, flowId, ref.version);
    // 리비전이 없으면 `publish` 가 사유를 돌려준다 — 여기서 같은 판정을 또 하지 않는다(§2).
    const gate = rev ? connectorIssues(rev.flow, req.connectorIds) : [];
    return {
      result: publish(reg, {
        scope, flowId, version: ref.version, channels: [...(req.channels as readonly ChannelKind[])],
        by, at: req.at,
      }),
      flowId,
      version: ref.version,
      gate,
    };
  }

  const toVersion = req.toVersion as number;
  const target = findRevision(reg, scope, flowId, toVersion);
  // 롤백도 커넥터를 대조한다 — 과거 버전이 가리키던 커넥터는 그 사이 지워졌을 수 있다.
  const gate = target ? connectorIssues(target.flow, req.connectorIds) : [];
  return {
    result: rollback(reg, {
      scope, flowId, channel: req.channel as ChannelKind, toVersion, by, at: req.at,
    }),
    flowId,
    version: toVersion,
    gate,
  };
}

/**
 * 시나리오 수명주기 실행: **형태 → 권한 → 전이 계산 → 게이트 → 저장 → 감사**.
 *
 * 돌려주는 값만으로 "무엇이 반영됐는가"가 분명해야 한다. 그래서 `committed` 는 저장이 실제로
 * 일어났을 때만 참이고, 저장이 던진 경우는 성공도 실패도 아닌 `uncommitted` 다.
 */
export function executeDeployment(
  chain: AuditChain,
  req: DeploymentRequest,
  ports: DeploymentPorts,
): DeploymentResult {
  assertTenantScope(req.scope);
  if (typeof ports?.registry !== 'function') {
    throw new Error(
      '레지스트리 조회가 함수가 아니다 — 스냅샷을 붙들면 직전 배포가 보이지 않는 채로 전이가 계산된다 (설계서 §5.3)',
    );
  }
  if (typeof ports.commit !== 'function') {
    throw new Error('레지스트리 저장(commit)이 없다 — 반영되지 않는 전이는 "배포했다"는 거짓이 된다 (설계서 §5.3)');
  }

  const warnings: string[] = [];
  const base = {
    op: req.op,
    committed: false as const,
    warnings,
    chain,
    recorded: false,
  };

  // 1) 형태 오류는 기록하지 않는다 — 변경이 일어나지 않았고, 남기면 조사에서 잡음이 된다.
  const shape = shapeIssues(req);
  if (shape.length > 0) {
    return {
      ...base,
      status: 'invalid',
      messageKo: `${OP_LABEL[req.op]} 요청의 선언을 확인하라.`,
      issues: shape.map(mask),
      ...(req.flowId !== undefined ? { flowId: req.flowId } : {}),
    };
  }

  const routeId = OP_ROUTE[req.op];
  const access: AccessRequest = {
    scope: req.scope,
    actor: req.actor,
    routeId,
    at: req.at,
    recordId: req.recordId,
    action: OP_ACTION[req.op],
    targetType: 'flow',
    targetId: req.op === 'create' ? (req.flow as Flow).id : (req.flowId as string),
  };

  // 2) 권한·격리를 **판정만** 한다. 기록을 두 번 하면 같은 변경이 감사에 두 줄로 남는다.
  const decision = decideAccess(access);
  if (!decision.allowed) {
    // 거부는 화면 성격과 무관하게 `recordAccess` 가 남긴다(테넌트 불일치는 행위자 체인으로).
    const outcome = recordAccess(chain, {
      ...access,
      detail: `${OP_LABEL[req.op]} 거부 — 반영 없음`,
    }, ports.hash);
    return {
      ...base,
      status: 'denied',
      messageKo: decision.messageKo ?? '이 화면에 접근할 권한이 없다.',
      // 권한 유무 외의 정보를 흘리지 않는다 — 검증 결과·리비전 존재 여부를 돌려주지 않는다.
      issues: [],
      chain: outcome.chain,
      recorded: outcome.recorded,
      ...(outcome.record !== undefined ? { record: outcome.record } : {}),
    };
  }

  // 3) 전이 계산. 레지스트리는 **지금** 읽는다.
  const reg = ports.registry();
  const t = computeTransition(reg, req);

  const rejectWith = (issues: readonly string[], messageKo: string): DeploymentResult => {
    // 게이트 거부도 기록한다 — "배포하려 했는데 막혔다"는 조사에서 필요한 사실이다.
    // `blocked` 로 넘겨 `recordAccess` 가 거부로 남기게 하고, 사유는 detail 에 싣는다.
    const outcome = recordAccess(chain, {
      ...access,
      blocked: true,
      detail: `${OP_LABEL[req.op]} 거부: ${issues.join(' / ')}`,
    }, ports.hash);
    return {
      ...base,
      status: 'rejected',
      messageKo,
      flowId: t.flowId,
      ...(t.version !== undefined ? { version: t.version } : {}),
      issues: issues.map(mask),
      chain: outcome.chain,
      recorded: outcome.recorded,
      ...(outcome.record !== undefined ? { record: outcome.record } : {}),
    };
  };

  if (!t.result.ok) {
    return rejectWith([`${t.result.code}: ${t.result.message}`], t.result.message);
  }
  if (t.gate.length > 0) {
    // (라) 전이는 성립하지만 커넥터가 없다 — **저장하지 않는다**.
    return rejectWith(
      headIssues(t.gate),
      `등록되지 않은 커넥터를 가리키는 노드가 있어 ${OP_LABEL[req.op]}할 수 없다 (설계서 §6.1).`,
    );
  }

  // 4) 저장. 여기서부터 되돌릴 수 없다.
  const next = t.result.value;
  try {
    ports.commit(next);
  } catch (e) {
    // **성공으로도 미실행으로도 적지 않는다.** 부분 저장 가능성이 이 상태가 가리키는 범위다.
    const detail = `${OP_LABEL[req.op]} 저장 실패 — 반영 여부 확인 필요: ${
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
      action: OP_ACTION[req.op],
      routeId,
      targetType: 'flow',
      targetId: t.flowId,
      result: 'error',
      detail,
    }, ports.hash);
    return {
      ...base,
      status: 'uncommitted',
      messageKo: `${OP_LABEL[req.op]} 결과를 저장하지 못했다. 반영 여부를 확인하라.`,
      flowId: t.flowId,
      ...(t.version !== undefined ? { version: t.version } : {}),
      issues: [mask(detail)],
      chain: errored,
      recorded: true,
      record: errored.records[errored.records.length - 1] as AuditRecord,
    };
  }

  // 5) 감사. 성공 기록은 `recordAccess` 한 곳에서 만든다 —
  //    `studio.*` 는 `mutates: true` 라 `shouldAudit` 가 참이고, 배포는 예외 없이 남아야 한다.
  const deployments = deploymentStatus(next, req.scope, t.flowId);
  const changed = deployments
    .filter((d) => d.version !== undefined)
    .map((d) => `${d.channel}=v${d.version}${d.rolledBackFrom !== undefined ? `(←v${d.rolledBackFrom})` : ''}`);
  const outcome = recordAccess(chain, {
    ...access,
    detail: [
      `${OP_LABEL[req.op]}: ${t.flowId}${t.version !== undefined ? ` v${t.version}` : ''}`,
      req.op === 'publish' || req.op === 'rollback'
        ? `채널 현황 ${changed.length > 0 ? changed.join(', ') : '배포 없음'}`
        : undefined,
      req.op === 'reject' ? `사유: ${req.reason}` : undefined,
    ].filter((v): v is string => typeof v === 'string').join(' · '),
  }, ports.hash, { recordAllReads: true });

  return {
    ...base,
    status: 'ok',
    committed: true,
    messageKo: `${OP_LABEL[req.op]}가 반영됐다: ${t.flowId}${t.version !== undefined ? ` v${t.version}` : ''}`,
    flowId: t.flowId,
    ...(t.version !== undefined ? { version: t.version } : {}),
    registry: next,
    deployments,
    issues: [],
    chain: outcome.chain,
    recorded: outcome.recorded,
    ...(outcome.record !== undefined ? { record: outcome.record } : {}),
  };
}

/**
 * 배포 전 사전 점검(스튜디오 '검증 결과' 화면용). **전이를 일으키지 않는다.**
 *
 * 왜 따로 있는가: 배포 버튼을 눌러 봐야 커넥터 결함을 알게 되면, 운영자는 사고 시각에
 * 그것을 알게 된다. 판정은 같은 함수들을 지난다(§2) — 여기서 새 규칙을 만들지 않는다.
 */
export interface PublishPreflight {
  ok: boolean;
  /** 시나리오 검증 오류(`validateFlow`). */
  errors: readonly string[];
  /** 커넥터 대조 결과(§6.1). 목록을 선언하지 않으면 "대조하지 못했다"가 여기 적힌다. */
  connectorIssues: readonly string[];
  warnings: readonly string[];
  reasonKo: string;
}

export function preflightPublish(flow: Flow, connectorIds?: readonly string[]): PublishPreflight {
  const v = validateFlow(flow);
  const conn = connectorIssues(flow, connectorIds);
  const errors = v.errors.map((e) => e.message);
  const ok = errors.length === 0 && conn.length === 0;
  return {
    ok,
    errors: errors.map(mask),
    connectorIssues: conn.map(mask),
    warnings: v.warnings.map((w) => mask(w.message)),
    reasonKo: ok
      ? '검증·커넥터 대조를 통과했다.'
      : `검증 오류 ${errors.length}건 · 커넥터 문제 ${conn.length}건`,
  };
}
