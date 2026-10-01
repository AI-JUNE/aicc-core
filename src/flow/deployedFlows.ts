// 배포 레지스트리 → 런타임 시나리오 조회 — 설계서 §5.3(시나리오 단일 관리·배포 수명주기)·
// §10(승인 게이트·직무분리)·§11.1(테넌트 격리)·§13-3(임의 기본값 금지).
//
// `flow/lifecycle.ts` 는 편집본과 운영본을 타입으로 가르고 그 사이에 게이트 두 개를 세워 뒀다
// (검증 통과 · 작성자 자기승인 금지). 그리고 `activeFlow` 머리말에는 **"런타임(FlowRunner)이
// 실행할 Flow를 고르는 유일한 경로"**라고 적혀 있다. 그런데 **저장소 전체에서 그 함수를 부르는
// 곳이 테스트뿐이었다.** 런타임이 실제로 쓰는 것은 `channels/runtime.ts` 의 동명이인
// `FlowRegistry` 이고, 그 기본 구현(`createMemoryFlowRegistry`)은 같은 flowId 의 리비전 중
// **가장 높은 버전 번호**를 돌려준다 — stage 를 보지 않는다.
//
// 그래서 지금 이 저장소에는 다음이 전부 열려 있다. 공통점은 **어디에서도 터지지 않는다**는 것이다.
//  (1) **스튜디오 편집본이 저장되는 순간 운영에 나간다.** draft v3 을 만들면 그 뒤의 모든 신규
//      통화가 v3 으로 시작한다. 검증도 승인도 지나지 않은 시나리오이므로 게이트 두 개가
//      **통째로 무의미**해지고, 증상은 예외가 아니라 "오늘부터 봇이 이상하다"다.
//  (2) **롤백이 런타임에 닿지 않는다.** 사고 대응으로 `rollback` 을 눌러도 런타임은 여전히
//      가장 높은 번호를 돌려준다. 운영자는 "되돌렸다"를 보고 있고 통화는 깨진 버전으로 계속
//      들어온다 — 사고 중에 가장 비싼 종류의 거짓이다.
//  (3) **채널별 단계적 배포가 성립하지 않는다.** §5.3 이 배포 단위를 "(Flow, 채널)"로 둔 이유가
//      콜봇에 먼저 올리고 보이는ARS는 두는 운영인데, 조회에 채널이 없으므로 한 채널에 올리면
//      세 채널이 같이 올라간다. 한 채널만 롤백하는 것도 불가능하다.
//  (4) **archived 리비전이 계속 나간다.** 폐기한 버전이 번호만 높으면 그대로 실행된다.
//
// 이 모듈이 그 사이를 메운다. 경계:
//  1) **판정을 복사하지 않는다.** 단계 전이·승인·배포 규칙은 `lifecycle.ts` 하나다. 여기서는
//     그것이 남긴 기록을 읽어 "지금 이 채널에서 무엇을 실행하는가"만 답한다(§2).
//  2) **추측하지 않는다.** 배포가 없으면 `undefined` 다 — "그럼 최신으로" 가 (1)(2)(4)의 원인이다.
//  3) **미배포와 없음을 같은 값으로 적지 않는다.** 둘을 "시나리오를 찾을 수 없습니다" 하나로
//     뭉개면 운영자는 오타를 찾으러 가고 원인은 미배포다(`retrieval.ts` 의 `store_failed` vs
//     `not_grounded` 와 같은 자리다). `explain` 이 사유를 갈라 돌려준다.
//  4) **던지지 않는다.** 조회 실패는 전부 결과값이다. 세션 시작을 막는 판단은 런타임이 한다.
import type { ChannelKind } from '../domain/types.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { Flow } from './types.ts';
import type { FlowRegistry as RevisionRegistry, FlowRevision, FlowStage } from './lifecycle.ts';
import { activeDeployment, findRevision, revisionsOf } from './lifecycle.ts';

export const DEPLOYED_FLOWS_CONTRACT_VERSION = 1;

export type FlowResolveCode =
  | 'ok'
  /** 그 flowId 의 리비전이 하나도 없다 — 오타·미등록이다. **미배포와 구분해서 적는다**. */
  | 'no_revision'
  /** 리비전은 있는데 이 채널에 걸린 배포가 없다. 단계적 배포(§5.3) 중이면 정상 상태다. */
  | 'not_deployed'
  /** 배포가 가리키는 리비전이 레지스트리에 없다 — 불일치다. **최신으로 대신하지 않는다**. */
  | 'revision_missing'
  /** 게이트(검증·승인)를 지난 기록이 없다. draft·in_review·승인 없이 폐기된 리비전이 여기다. */
  | 'not_approved'
  /** `Flow.version` 과 리비전 번호가 다르다. §8.1 이벤트의 flow_version 이 거짓이 된다. */
  | 'version_mismatch';

export interface FlowResolved {
  code: 'ok';
  flow: Flow;
  version: number;
  stage: FlowStage;
  /**
   * 호출자가 버전을 지정해 받은 결과인가. **지정본은 배포본이 아니다** — 지정은 게이트는
   * 못 넘지만 채널별 배포는 건너뛴다(세션 재개·카나리). 그 사실을 숨기지 않으려고 적는다.
   */
  pinned: boolean;
  /** 이 채널에 걸려 있는 배포 버전(있을 때만). 지정본이 배포본과 다른 경우를 호출자가 볼 수 있다. */
  deployedVersion?: number;
  /**
   * 배포는 걸려 있는데 리비전 단계가 `published` 가 아니다(레지스트리 불일치).
   * 배포 기록은 "어느 버전인가"의 진실이므로 실행은 하되, 어긋난 사실은 적는다.
   */
  staleStage?: FlowStage;
  reasonKo: string;
}

export interface FlowUnresolved {
  code: Exclude<FlowResolveCode, 'ok'>;
  reasonKo: string;
}

export type FlowResolution = FlowResolved | FlowUnresolved;

/**
 * 게이트를 지났는가. **단계 라벨이 아니라 게이트가 남긴 기록을 본다.**
 *
 * `stage` 만 보면 두 가지가 통과한다: 손으로 만든 `stage: 'approved'` 리비전(스튜디오를
 * 거치지 않은 것)과, `draft → archived` 로 **승인 없이 폐기된** 리비전이다(전이표가 허용한다).
 * 후자는 번호가 높으면 (4)의 경로로 운영에 나갈 수 있었다.
 */
export function gatePassed(rev: FlowRevision): boolean {
  return typeof rev.approvedBy === 'string' && rev.approvedBy !== ''
    && typeof rev.approvedAt === 'string' && rev.approvedAt !== '';
}

function versionOk(rev: FlowRevision): boolean {
  return rev.flow.version === rev.version;
}

function mismatchReason(rev: FlowRevision): string {
  return `리비전 번호(${rev.version})와 Flow.version(${rev.flow.version})이 다릅니다 — `
    + '이벤트의 flow_version 이 거짓이 되어 사후 추적이 불가능해집니다 (설계서 §8.1·§5.3)';
}

function notApprovedReason(rev: FlowRevision): string {
  return `승인 기록이 없는 리비전입니다(stage=${rev.stage}): ${rev.flowId} v${rev.version} — `
    + '검증·승인 게이트를 지나지 않은 시나리오는 운영에 나갈 수 없습니다 (설계서 §5.3·§10)';
}

/**
 * **채널별 배포본 조회.** 이것이 실행 경로의 유일한 답이다.
 *
 * `version` 을 주면 지정본을 돌려주되 게이트 검사는 그대로 적용한다 — 지정으로 배포를
 * 건너뛰는 것은 운영 판단일 수 있지만, 지정으로 **승인을 건너뛰는 것**은 어떤 경우에도
 * 사고다. 지정본이 배포본과 다르면 `deployedVersion` 으로 드러낸다.
 */
export function resolveDeployedFlow(
  reg: RevisionRegistry,
  scope: TenantScope,
  flowId: string,
  channel: ChannelKind,
  version?: number,
): FlowResolution {
  assertTenantScope(scope);
  // 다른 테넌트의 리비전·배포는 아래 조회가 전부 걸러 낸다(lifecycle 의 tenantId 비교) —
  // 여기서 한 번 더 거르면 §2 의 이중 관리다. 없으면 `no_revision` 으로 나온다(§11.1).
  const all = revisionsOf(reg, scope, flowId);
  if (all.length === 0) {
    return { code: 'no_revision', reasonKo: `등록된 리비전이 없는 시나리오입니다: ${flowId}` };
  }
  const dep = activeDeployment(reg, scope, flowId, channel);

  if (version !== undefined) {
    const pinnedRev = all.find((r) => r.version === version);
    if (!pinnedRev) {
      return { code: 'no_revision', reasonKo: `없는 리비전을 지정했습니다: ${flowId} v${version}` };
    }
    if (!gatePassed(pinnedRev)) return { code: 'not_approved', reasonKo: notApprovedReason(pinnedRev) };
    if (!versionOk(pinnedRev)) return { code: 'version_mismatch', reasonKo: mismatchReason(pinnedRev) };
    return {
      code: 'ok',
      flow: pinnedRev.flow,
      version: pinnedRev.version,
      stage: pinnedRev.stage,
      pinned: true,
      ...(dep !== undefined ? { deployedVersion: dep.version } : {}),
      reasonKo: dep !== undefined && dep.version !== pinnedRev.version
        ? `지정본 v${pinnedRev.version} 으로 실행합니다 — ${channel} 채널 배포본은 v${dep.version} 입니다`
        : `지정본 v${pinnedRev.version} 으로 실행합니다`,
    };
  }

  if (!dep) {
    // **최신으로 대신하지 않는다.** 그 한 줄이 이 모듈이 메우려는 결함의 전부다(§13-3).
    return {
      code: 'not_deployed',
      reasonKo: `${channel} 채널에 배포된 버전이 없습니다: ${flowId}(리비전 ${all.length}건) — `
        + '배포되지 않은 것을 최신 버전으로 대신하지 않습니다 (설계서 §5.3·§13-3)',
    };
  }
  const rev = findRevision(reg, scope, flowId, dep.version);
  if (!rev) {
    // 배포가 가리키는 리비전이 사라졌다. 이 상태에서 "그럼 최신으로"는 검증되지 않은 버전을
    // 운영에 올리는 길이므로, 불일치를 그대로 드러내고 멈춘다.
    return {
      code: 'revision_missing',
      reasonKo: `${channel} 채널 배포가 가리키는 리비전이 없습니다: ${flowId} v${dep.version}(레지스트리 불일치)`,
    };
  }
  if (!gatePassed(rev)) {
    // 배포 기록은 "어느 버전인가"의 진실이지만 "게이트를 지났는가"의 근거는 아니다.
    // 손으로 써 넣은 배포 한 줄로 미승인 시나리오가 나가면 게이트가 둘 다 무의미해진다.
    return { code: 'not_approved', reasonKo: notApprovedReason(rev) };
  }
  if (!versionOk(rev)) return { code: 'version_mismatch', reasonKo: mismatchReason(rev) };

  return {
    code: 'ok',
    flow: rev.flow,
    version: rev.version,
    stage: rev.stage,
    pinned: false,
    deployedVersion: dep.version,
    ...(rev.stage !== 'published' ? { staleStage: rev.stage } : {}),
    reasonKo: `${channel} 채널 배포본 v${rev.version}`,
  };
}

/**
 * 채널을 모르는 조회 — **검증·존재 확인용이며 운영 선택이 아니다.**
 *
 * 배포 단위가 "(Flow, 채널)"이므로 채널 없이는 "지금 무엇이 돌고 있는가"에 단일한 답이 없다.
 * 그래서 여기서는 **게이트를 지난 리비전 중 가장 높은 번호**를 돌려준다. draft·in_review·
 * 승인 없이 폐기된 리비전은 어떤 경우에도 돌려주지 않는다 — 이 함수만 쓰는 호출자(라우팅 표
 * 검증 등)에서도 편집본이 운영 경로로 흘러들지 않게 하는 것이 요점이다.
 */
export function resolveApprovedFlow(
  reg: RevisionRegistry,
  scope: TenantScope,
  flowId: string,
  version?: number,
): FlowResolution {
  assertTenantScope(scope);
  const all = revisionsOf(reg, scope, flowId);
  if (all.length === 0) {
    return { code: 'no_revision', reasonKo: `등록된 리비전이 없는 시나리오입니다: ${flowId}` };
  }
  if (version !== undefined) {
    const rev = all.find((r) => r.version === version);
    if (!rev) return { code: 'no_revision', reasonKo: `없는 리비전을 지정했습니다: ${flowId} v${version}` };
    if (!gatePassed(rev)) return { code: 'not_approved', reasonKo: notApprovedReason(rev) };
    if (!versionOk(rev)) return { code: 'version_mismatch', reasonKo: mismatchReason(rev) };
    return { code: 'ok', flow: rev.flow, version: rev.version, stage: rev.stage, pinned: true, reasonKo: `지정본 v${rev.version}` };
  }
  // `revisionsOf` 는 번호 오름차순이므로 뒤에서부터 본다.
  for (let i = all.length - 1; i >= 0; i--) {
    const rev = all[i] as FlowRevision;
    if (!gatePassed(rev) || !versionOk(rev)) continue;
    return { code: 'ok', flow: rev.flow, version: rev.version, stage: rev.stage, pinned: false, reasonKo: `승인된 최고 버전 v${rev.version}` };
  }
  return {
    code: 'not_approved',
    reasonKo: `승인 기록이 있는 리비전이 없습니다: ${flowId}(리비전 ${all.length}건) (설계서 §5.3·§10)`,
  };
}

export interface DeployedFlowRegistryOptions {
  /**
   * 리비전·배포 레지스트리를 **그때그때 읽는 함수**. 스냅샷 객체를 받지 않는 이유가 이 모듈의
   * 핵심 중 하나다 — `publish`·`rollback` 은 **새 레지스트리 객체**를 돌려주므로, 조립 시점의
   * 객체를 붙들고 있으면 배포도 롤백도 런타임에 **영영 닿지 않는다**. 그건 지금 고치고 있는
   * 결함(2)이 모양만 바꿔 되살아난 것이고, 증상도 똑같다: 운영자는 "되돌렸다"를 보고 있다.
   * 함수로만 받아 그 길을 타입에서 막는다.
   */
  registry: () => RevisionRegistry;
  scope: TenantScope;
}

/**
 * `channels/runtime.ts` 의 `FlowRegistry` 구현체. 채널별 배포본을 운영 선택의 유일한 경로로 쓴다.
 *
 * 세션 **진행 중**에 배포가 바뀌어도 그 통화는 영향받지 않는다 — 런타임은 시작 시점에 고른
 * `Flow` 를 세션에 들고 간다(§5.3: 통화 한복판에 시나리오가 바뀌면 상태가 갈라진다).
 * 바뀐 배포는 **다음 통화부터** 적용된다.
 */
export interface DeployedFlowRegistry {
  readonly contractVersion: number;
  /** 검증·존재 확인용(위 `resolveApprovedFlow`). 실행 경로는 `forChannel` 이다. */
  get(flowId: string, version?: number): Flow | undefined;
  forChannel(flowId: string, channel: ChannelKind, version?: number): Flow | undefined;
  /** 조회 사유. 미배포·미승인·오타를 같은 값으로 뭉개지 않기 위해 있다(위 경계 3). */
  explain(flowId: string, channel: ChannelKind, version?: number): FlowResolution;
}

export function createDeployedFlowRegistry(opts: DeployedFlowRegistryOptions): DeployedFlowRegistry {
  assertTenantScope(opts.scope);
  if (typeof opts.registry !== 'function') {
    throw new Error(
      '배포 레지스트리 조회가 함수가 아닙니다 — 스냅샷을 붙들면 publish·rollback 이 런타임에 닿지 않습니다 (설계서 §5.3)',
    );
  }
  const resolution = (flowId: string, channel: ChannelKind, version?: number) =>
    resolveDeployedFlow(opts.registry(), opts.scope, flowId, channel, version);

  return {
    contractVersion: DEPLOYED_FLOWS_CONTRACT_VERSION,
    get(flowId, version) {
      const r = resolveApprovedFlow(opts.registry(), opts.scope, flowId, version);
      return r.code === 'ok' ? r.flow : undefined;
    },
    forChannel(flowId, channel, version) {
      const r = resolution(flowId, channel, version);
      return r.code === 'ok' ? r.flow : undefined;
    },
    explain: resolution,
  };
}
