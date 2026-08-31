// Flow 버전·배포 수명주기 — 설계서 §5.3(시나리오 단일 관리) · §7 7.3(스튜디오) · §10(권한 분리) · §11.1(테넌트 격리).
//
// 스튜디오에서 만든 시나리오가 "저장하면 곧바로 운영 반영"되면, 잘못된 한 줄이 즉시 전 채널의 사고가 된다.
// 그래서 편집본(draft)과 운영본(published)을 타입으로 분리하고, 그 사이에 두 개의 게이트를 둔다.
//   게이트 1: 검증 통과 — validateFlow 의 error 가 0 이어야 승인 요청이 가능하다(§5.3).
//   게이트 2: 승인자 분리 — 작성자가 자기 리비전을 승인할 수 없다(§10 최소권한·직무분리).
//
// 배포 단위는 "Flow"가 아니라 "(Flow, 채널)"이다. 하나의 Flow를 채널 렌더러로 나눠 쓰므로(§5.3),
// 콜봇에는 새 버전을 올리고 보이는ARS는 이전 버전을 유지하는 단계적 배포가 실제 운영에서 필요하다.
//
// 이 모듈은 전부 순수 함수다. 시각(at)·행위자(actor)·버전은 호출자가 주입한다.
// 실패는 예외가 아니라 결과값으로 돌려준다 — 스튜디오 UI가 사유를 그대로 표시해야 하기 때문이다.

import type { ChannelKind } from '../domain/types.ts';
import type { Flow } from './types.ts';
import { validateFlow } from './validate.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';

export type FlowStage =
  | 'draft'        // 편집 중 — 운영에 영향 없음
  | 'in_review'    // 승인 요청됨 — 편집 잠금
  | 'approved'     // 승인됨 — 배포 가능
  | 'published'    // 특정 채널에 배포된 이력이 있는 리비전
  | 'archived';    // 대체되었거나 폐기됨

export interface FlowRevision {
  tenantId: string;
  flowId: string;
  /** 리비전 번호. Flow.version 과 일치해야 한다(불일치 시 배포 거부). */
  version: number;
  stage: FlowStage;
  flow: Flow;
  createdBy: string;
  createdAt: string;
  submittedBy?: string;
  submittedAt?: string;
  /** 승인자. createdBy 와 같을 수 없다(§10 직무분리). */
  approvedBy?: string;
  approvedAt?: string;
  /** 반려 사유 — in_review → draft 로 되돌린 경우 */
  rejectedReason?: string;
  firstPublishedAt?: string;
  archivedAt?: string;
  note?: string;
}

/** (Flow, 채널) 하나에 대해 현재 어떤 버전이 실행 중인지. 운영의 유일한 진실이다. */
export interface Deployment {
  tenantId: string;
  flowId: string;
  channel: ChannelKind;
  version: number;
  at: string;
  by: string;
  /** 롤백으로 만들어진 배포라면 직전에 걸려 있던 버전 */
  rolledBackFrom?: number;
}

export interface FlowRegistry {
  revisions: FlowRevision[];
  deployments: Deployment[];
}

export function emptyRegistry(): FlowRegistry {
  return { revisions: [], deployments: [] };
}

export type LifecycleErrorCode =
  | 'E_TENANT_MISMATCH'
  | 'E_REVISION_NOT_FOUND'
  | 'E_STAGE_INVALID'
  | 'E_VALIDATION_FAILED'
  | 'E_SELF_APPROVAL'
  | 'E_ACTOR_EMPTY'
  | 'E_VERSION_MISMATCH'
  | 'E_VERSION_EXISTS'
  | 'E_NOT_APPROVED'
  | 'E_NO_DEPLOYMENT'
  | 'E_SAME_VERSION';

export type LifecycleResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: LifecycleErrorCode; message: string };

const fail = <T>(code: LifecycleErrorCode, message: string): LifecycleResult<T> => ({ ok: false, code, message });
const done = <T>(value: T): LifecycleResult<T> => ({ ok: true, value });

/** 허용 전이표. 여기에 없는 전이는 존재하지 않는다. */
export const STAGE_TRANSITIONS: Record<FlowStage, FlowStage[]> = {
  draft: ['in_review', 'archived'],
  in_review: ['approved', 'draft'],        // draft 로 되돌아가는 것이 '반려'
  approved: ['published', 'draft', 'archived'],
  published: ['archived'],
  archived: [],
};

export function canTransition(from: FlowStage, to: FlowStage): boolean {
  return (STAGE_TRANSITIONS[from] ?? []).includes(to);
}

// ── 조회 ────────────────────────────────────────────────────────────────────

function sameTenant(r: { tenantId: string }, scope: TenantScope): boolean {
  return r.tenantId === scope.tenantId;
}

export function findRevision(
  reg: FlowRegistry,
  scope: TenantScope,
  flowId: string,
  version: number,
): FlowRevision | undefined {
  assertTenantScope(scope);
  return reg.revisions.find(r => sameTenant(r, scope) && r.flowId === flowId && r.version === version);
}

export function revisionsOf(reg: FlowRegistry, scope: TenantScope, flowId: string): FlowRevision[] {
  assertTenantScope(scope);
  return reg.revisions
    .filter(r => sameTenant(r, scope) && r.flowId === flowId)
    .slice()
    .sort((a, b) => a.version - b.version);
}

export function nextVersion(reg: FlowRegistry, scope: TenantScope, flowId: string): number {
  const list = revisionsOf(reg, scope, flowId);
  return list.length === 0 ? 1 : (list[list.length - 1] as FlowRevision).version + 1;
}

/** 채널에 현재 걸려 있는 배포. 없으면 undefined — "기본값으로 최신 버전" 같은 추측을 하지 않는다. */
export function activeDeployment(
  reg: FlowRegistry,
  scope: TenantScope,
  flowId: string,
  channel: ChannelKind,
): Deployment | undefined {
  assertTenantScope(scope);
  return reg.deployments.find(d => sameTenant(d, scope) && d.flowId === flowId && d.channel === channel);
}

/** 런타임(FlowRunner)이 실행할 Flow를 고르는 유일한 경로. 배포되지 않았으면 undefined. */
export function activeFlow(
  reg: FlowRegistry,
  scope: TenantScope,
  flowId: string,
  channel: ChannelKind,
): Flow | undefined {
  const dep = activeDeployment(reg, scope, flowId, channel);
  if (!dep) return undefined;
  return findRevision(reg, scope, flowId, dep.version)?.flow;
}

// ── 변경(모두 새 레지스트리를 반환한다) ────────────────────────────────────

function replaceRevision(reg: FlowRegistry, next: FlowRevision): FlowRegistry {
  return {
    revisions: reg.revisions.map(r =>
      r.tenantId === next.tenantId && r.flowId === next.flowId && r.version === next.version ? next : r,
    ),
    deployments: reg.deployments,
  };
}

export interface CreateDraftInput {
  scope: TenantScope;
  flow: Flow;
  by: string;
  at: string;
  note?: string;
}

/**
 * 새 편집본 등록. Flow.version 과 리비전 번호를 일치시켜 저장한다 —
 * 실행 중 "이벤트의 flow_version"(§8.1)과 레지스트리가 어긋나면 사후 추적이 불가능해진다.
 */
export function createDraft(reg: FlowRegistry, input: CreateDraftInput): LifecycleResult<FlowRegistry> {
  assertTenantScope(input.scope);
  if (!input.by) return fail('E_ACTOR_EMPTY', '작성자가 비어 있습니다.');
  const { flow } = input;
  if (!Number.isInteger(flow.version) || flow.version < 1) {
    return fail('E_VERSION_MISMATCH', 'Flow.version 은 1 이상의 정수여야 합니다.');
  }
  if (findRevision(reg, input.scope, flow.id, flow.version)) {
    return fail('E_VERSION_EXISTS', `이미 존재하는 리비전입니다: ${flow.id} v${flow.version}`);
  }
  const rev: FlowRevision = {
    tenantId: input.scope.tenantId,
    flowId: flow.id,
    version: flow.version,
    stage: 'draft',
    flow,
    createdBy: input.by,
    createdAt: input.at,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  return done({ revisions: [...reg.revisions, rev], deployments: reg.deployments });
}

export interface RevisionRef {
  scope: TenantScope;
  flowId: string;
  version: number;
}

function loadDraftable(
  reg: FlowRegistry,
  ref: RevisionRef,
  expected: FlowStage[],
): LifecycleResult<FlowRevision> {
  assertTenantScope(ref.scope);
  const rev = findRevision(reg, ref.scope, ref.flowId, ref.version);
  if (!rev) {
    return fail('E_REVISION_NOT_FOUND', `리비전을 찾을 수 없습니다: ${ref.flowId} v${ref.version}`);
  }
  if (!expected.includes(rev.stage)) {
    return fail(
      'E_STAGE_INVALID',
      `현재 단계 '${rev.stage}' 에서는 허용되지 않는 동작입니다(필요: ${expected.join('|')}).`,
    );
  }
  return done(rev);
}

/** 게이트 1 — 검증 error 0 이 아니면 승인 요청 자체를 막는다. 경고(warning)는 통과시킨다. */
export function submitForReview(
  reg: FlowRegistry,
  ref: RevisionRef,
  by: string,
  at: string,
): LifecycleResult<FlowRegistry> {
  if (!by) return fail('E_ACTOR_EMPTY', '요청자가 비어 있습니다.');
  const found = loadDraftable(reg, ref, ['draft']);
  if (!found.ok) return found;
  const rev = found.value;

  const v = validateFlow(rev.flow);
  if (!v.ok) {
    const head = v.errors.slice(0, 3).map(e => e.message).join(' / ');
    return fail('E_VALIDATION_FAILED', `검증 오류 ${v.errors.length}건으로 승인 요청할 수 없습니다: ${head}`);
  }
  if (rev.flow.version !== rev.version) {
    return fail('E_VERSION_MISMATCH', `Flow.version(${rev.flow.version}) 과 리비전 번호(${rev.version}) 가 다릅니다.`);
  }

  return done(replaceRevision(reg, { ...rev, stage: 'in_review', submittedBy: by, submittedAt: at }));
}

/** 게이트 2 — 작성자 자기승인 금지(§10). 조직이 1인이어도 예외를 열지 않는다. 필요하면 계정을 분리한다. */
export function approve(
  reg: FlowRegistry,
  ref: RevisionRef,
  by: string,
  at: string,
): LifecycleResult<FlowRegistry> {
  if (!by) return fail('E_ACTOR_EMPTY', '승인자가 비어 있습니다.');
  const found = loadDraftable(reg, ref, ['in_review']);
  if (!found.ok) return found;
  const rev = found.value;
  if (rev.createdBy === by) {
    return fail('E_SELF_APPROVAL', '작성자는 자신의 리비전을 승인할 수 없습니다(설계서 §10 직무분리).');
  }
  const next: FlowRevision = { ...rev, stage: 'approved', approvedBy: by, approvedAt: at };
  delete next.rejectedReason;
  return done(replaceRevision(reg, next));
}

/** 반려 — in_review → draft. 사유는 필수다(반려 이력이 남지 않으면 스튜디오에서 원인을 찾을 수 없다). */
export function reject(
  reg: FlowRegistry,
  ref: RevisionRef,
  by: string,
  reason: string,
): LifecycleResult<FlowRegistry> {
  if (!by) return fail('E_ACTOR_EMPTY', '반려자가 비어 있습니다.');
  const found = loadDraftable(reg, ref, ['in_review']);
  if (!found.ok) return found;
  const rev = found.value;
  return done(replaceRevision(reg, { ...rev, stage: 'draft', rejectedReason: reason }));
}

export interface PublishInput {
  scope: TenantScope;
  flowId: string;
  version: number;
  /** 배포 대상 채널. 부분 배포가 정상 시나리오다(§5.3). */
  channels: ChannelKind[];
  by: string;
  at: string;
}

/**
 * 배포. approved 리비전만 채널에 걸 수 있고, 걸리는 순간 stage 는 published 가 된다.
 * 이전에 걸려 있던 버전은 자동으로 archived 하지 않는다 — 다른 채널에서 여전히 실행 중일 수 있기 때문이다.
 * 어떤 채널에도 걸려 있지 않게 된 published 리비전만 archived 로 내린다.
 */
export function publish(reg: FlowRegistry, input: PublishInput): LifecycleResult<FlowRegistry> {
  assertTenantScope(input.scope);
  if (!input.by) return fail('E_ACTOR_EMPTY', '배포자가 비어 있습니다.');
  if (input.channels.length === 0) return fail('E_STAGE_INVALID', '배포 대상 채널이 비어 있습니다.');

  const found = loadDraftable(reg, { scope: input.scope, flowId: input.flowId, version: input.version }, ['approved']);
  if (!found.ok) {
    return found.code === 'E_STAGE_INVALID'
      ? fail('E_NOT_APPROVED', `승인된 리비전만 배포할 수 있습니다: ${found.message}`)
      : found;
  }
  const rev = found.value;

  const others = reg.deployments.filter(
    d => !(d.tenantId === input.scope.tenantId && d.flowId === input.flowId && input.channels.includes(d.channel)),
  );
  const added: Deployment[] = input.channels.map(channel => ({
    tenantId: input.scope.tenantId,
    flowId: input.flowId,
    channel,
    version: input.version,
    at: input.at,
    by: input.by,
  }));
  const deployments = [...others, ...added];

  const published: FlowRevision = {
    ...rev,
    stage: 'published',
    firstPublishedAt: rev.firstPublishedAt ?? input.at,
  };

  const revisions = reg.revisions.map(r => {
    if (r.tenantId === published.tenantId && r.flowId === published.flowId && r.version === published.version) {
      return published;
    }
    // 어느 채널에도 남지 않은 published 리비전만 내린다.
    const stillLive = deployments.some(
      d => d.tenantId === r.tenantId && d.flowId === r.flowId && d.version === r.version,
    );
    if (r.stage === 'published' && !stillLive) {
      return { ...r, stage: 'archived' as FlowStage, archivedAt: input.at };
    }
    return r;
  });

  return done({ revisions, deployments });
}

export interface RollbackInput {
  scope: TenantScope;
  flowId: string;
  channel: ChannelKind;
  /** 되돌릴 대상 버전. 과거에 배포된 적 있는(published/archived) 리비전이어야 한다. */
  toVersion: number;
  by: string;
  at: string;
}

/**
 * 롤백. 사고 대응 경로이므로 재승인을 요구하지 않는다 —
 * 대신 "과거에 실제로 배포되었던 리비전"으로만 되돌릴 수 있게 해서 검증되지 않은 코드가 올라가는 길을 막는다.
 */
export function rollback(reg: FlowRegistry, input: RollbackInput): LifecycleResult<FlowRegistry> {
  assertTenantScope(input.scope);
  if (!input.by) return fail('E_ACTOR_EMPTY', '수행자가 비어 있습니다.');

  const current = activeDeployment(reg, input.scope, input.flowId, input.channel);
  if (!current) {
    return fail('E_NO_DEPLOYMENT', `${input.channel} 채널에 배포된 버전이 없어 롤백할 수 없습니다.`);
  }
  if (current.version === input.toVersion) {
    return fail('E_SAME_VERSION', `이미 v${input.toVersion} 가 배포되어 있습니다.`);
  }
  const target = findRevision(reg, input.scope, input.flowId, input.toVersion);
  if (!target) {
    return fail('E_REVISION_NOT_FOUND', `리비전을 찾을 수 없습니다: ${input.flowId} v${input.toVersion}`);
  }
  if (!target.firstPublishedAt) {
    return fail('E_NOT_APPROVED', '한 번도 배포된 적 없는 리비전으로는 롤백할 수 없습니다.');
  }

  const deployments = reg.deployments.map(d =>
    d.tenantId === current.tenantId && d.flowId === current.flowId && d.channel === current.channel
      ? {
          ...d,
          version: input.toVersion,
          at: input.at,
          by: input.by,
          rolledBackFrom: current.version,
        }
      : d,
  );

  const revisions = reg.revisions.map(r => {
    const live = deployments.some(d => d.tenantId === r.tenantId && d.flowId === r.flowId && d.version === r.version);
    if (r.tenantId === target.tenantId && r.flowId === target.flowId && r.version === target.version) {
      return { ...r, stage: 'published' as FlowStage };
    }
    if (r.stage === 'published' && !live) {
      return { ...r, stage: 'archived' as FlowStage, archivedAt: input.at };
    }
    return r;
  });

  return done({ revisions, deployments });
}

/** 스튜디오 배포 화면이 표시하는 채널별 현황. 미배포 채널은 version 없이 그대로 드러낸다. */
export interface ChannelStatus {
  channel: ChannelKind;
  version?: number;
  at?: string;
  by?: string;
  rolledBackFrom?: number;
}

export function deploymentStatus(
  reg: FlowRegistry,
  scope: TenantScope,
  flowId: string,
  channels: ChannelKind[] = ['voice', 'visual', 'chat'],
): ChannelStatus[] {
  assertTenantScope(scope);
  return channels.map(channel => {
    const d = activeDeployment(reg, scope, flowId, channel);
    if (!d) return { channel };
    return {
      channel,
      version: d.version,
      at: d.at,
      by: d.by,
      ...(d.rolledBackFrom !== undefined ? { rolledBackFrom: d.rolledBackFrom } : {}),
    };
  });
}
