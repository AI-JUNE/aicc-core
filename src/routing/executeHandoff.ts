// 이관 실행 오케스트레이터 — 설계서 §2(핸드오프 단절 해소)·§9.3(장애 폴백)·§10.3(마스킹)·
// §11.1(테넌트·워크스페이스 격리)·§13-3(임의 기본값 금지).
//
// `routing/agentQueue.ts` 에는 조각이 다 있다 — 목적지 선택(`selectQueue`)·수용 판정(`admitToQueue`)·
// 오퍼 상태기계·소진 후 대안(`exhaustedAction`). 그런데 **그 조각들을 순서대로 꿰는 코드가 없었다**:
// 저장소 전체에서 `selectQueue`·`admitToQueue` 를 부르는 곳은 테스트뿐이고, 실제 이관 경로인
// `channels/runtime.ts` 는 `rec.state.handoff.queue`(문자열 하나)를 그대로 `port.transfer` 에 넘긴다.
// 즉 **큐 선택도 수용 판정도 아무도 하지 않는다.** 그대로 두면 채널 3곳이 같은 20줄을 각자 쓰고,
// 그 20줄에서 빠지는 것은 취향이 아니라 정해져 있다.
//
//  1) **오버플로 목적지를 잘못 읽는다.** `AdmissionDecision` 은 `queueId`(요청한 큐)와
//     `admittedQueueId`(실제로 들어간 큐)를 **둘 다** 들고 있고, 이름이 짧은 쪽이 요청한 큐다.
//     `decision.queueId` 를 destination 으로 쓰면 고객은 **방금 꽉 찼다고 판정된 큐**에 들어간다.
//     타입도 통과하고 값도 문자열이라 어디서도 안 터지며, 증상은 "특정 시간대에만 대기가 길다"로 나타난다.
//     그래서 이 모듈의 결과에는 **놓을 수 있는 큐 id 가 하나뿐**이다.
//  2) **수용 판정을 성공으로 읽는다.** `status` 는 네 값인데 `accepted` 만 성공이다.
//     `closed`·`rejected` 를 걸러내지 않으면 고객은 "상담사를 연결해 드리겠습니다"를 듣고
//     아무도 없는 큐에서 기다린다 — §9.3 대안(콜백·음성사서함·기존 IVR)이 통째로 건너뛰어진다.
//     그래서 대안 경로는 **별도 분기**이며, 큐에 놓을 id 를 아예 들고 있지 않다.
//  3) **워크스페이스 격리가 비어 있다.** `selectQueue` 는 `tenantId` 만 본다. 같은 테넌트의 다른
//     워크스페이스 설정으로 부르면 그대로 통과하고, 고객 상담이 옆 사업부 큐로 간다(§11.1).
//  4) **요약을 한 번 더 마스킹한다.** `maskPii` 는 **멱등이 아니다** — 이미 마스킹된 문자열을 다시
//     넣으면 남은 자리가 다른 규칙에 걸려 뭉개진다(`900101-*******` → `***-****-0101-*******`).
//     "안전하게 한 번 더"가 상담사 화면의 요약을 읽을 수 없게 만든다. 그래서 받은 요약은 **그대로 통과**시키고,
//     이 모듈이 만든 문구만 한 번 마스킹한다.
//  5) **소진(exhausted) 이후가 다른 모양으로 끝난다.** 오퍼를 다 돌렸는데 아무도 안 받은 경우와
//     큐가 닫힌 경우는 고객 입장에서 같은 일이다(대안으로 간다). 결과 모양이 갈라지면 채널은
//     한쪽만 처리하고 다른 쪽은 조용히 끊는다.
//  6) **시간대 없는 시각을 넘긴다.** `Date.parse('2026-03-02 10:00')` 는 성공하고, **호스트의
//     로컬 시간대**로 해석된다. 영업시간 판정이 전부 여기에 걸려 있으므로 같은 문자열이 서버마다
//     다른 판정을 내고, 그 차이는 "특정 서버에서만 야간에 상담사로 안 넘어간다"로 나타난다
//     (§6.2 가 tz 데이터 종속을 피한 것과 같은 이유다). 그래서 **오프셋이 명시된 시각만** 받는다.
//  7) **같은 큐의 스냅샷이 둘 오면 조용히 하나가 이긴다.** `admitToQueue` 는 Map 으로 접어서
//     **나중 것**을 쓴다 — 대기 0명과 50명이 같이 오면 배열 순서가 수용 판정을 정한다. 골라 주지
//     않는다: 값이 어긋나는 스냅샷은 그 큐를 **상태 미확인**으로 두고(=보수적으로 닫힘) 드러낸다.
//
// **판정하지 않는다.** 대안 행동(`ClosedAction`)은 큐 설정에 선언된 값을 그대로 쓴다 — 여기서
// 기본값을 만들면 "설정 안 한 큐는 조용히 끊김" 같은 정책이 코드에 박힌다(§13-3).
// **엔진·백엔드 상태로 집계하지 않는다.** 큐가 닫힌 것은 장애가 아니다 — 영업시간 외를 `down` 으로
// 적으면 매일 밤 전 채널이 §9.3 폴백으로 떨어진다. 그래서 이 파일은 헬스·폴백 모듈을 참조하지 않는다.
// **던지는 것은 격리 위반 하나뿐이다**(§11.1) — 남의 테넌트·워크스페이스로 가는 이관은 폴백할 사안이 아니다.
import type { ChannelKind, Handoff } from '../domain/types.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type {
  AdmissionOptions,
  ClosedAction,
  QueueSnapshot,
  RoutingConfig,
} from './agentQueue.ts';
import {
  admitToQueue,
  exhaustedAction,
  selectQueue,
  validateRoutingConfig,
} from './agentQueue.ts';

export const HANDOFF_EXECUTION_CONTRACT_VERSION = 1;

/** 대안으로 넘어간 이유. 고객에게 읽어줄 문구가 아니라 운영·집계용 구분이다. */
export type AlternativeCause = 'closed' | 'rejected' | 'exhausted';

/** 목적지를 아예 정하지 못한 이유. 전부 **설정 결함**이며 운영에 드러나야 한다. */
export type HandoffUnavailableCode = 'E_CONFIG_INVALID' | 'E_CLOCK_INVALID' | 'E_ROUTING_FAILED';

export interface HandoffRequest {
  scope: TenantScope;
  channel: ChannelKind;
  reason: Handoff['reason'];
  intent?: string;
  language?: string;
  /** 규칙 매칭용 슬롯. 값은 규칙 비교에만 쓰이고 결과 어디에도 실리지 않는다(§10.3). */
  slots?: Readonly<Record<string, string>>;
  /**
   * 상담사 화면용 **이미 마스킹된** 요약(§2·§10.3). `buildHandoffSummary` 결과를 그대로 넘긴다.
   * 이 모듈은 요약을 만들지도, 다시 마스킹하지도 않는다(위 4번).
   */
  summaryMasked?: string;
  /** 관측 시각. 형식이 틀리면 수용 판정을 **추정하지 않고** unavailable 로 끝낸다. */
  nowIso: string;
  /** 큐 실측 스냅샷. 없는 큐는 `admitToQueue` 가 "상태 미확인"으로 닫는다 — 추정하지 않는다. */
  snapshots: readonly QueueSnapshot[];
  admission?: AdmissionOptions;
}

interface PlacementCommon {
  /** 규칙이 고른 큐(오버플로 이전). 집계·사후추적용이며 **여기에 사람을 놓지 않는다**. */
  requestedQueueId: string;
  /** 상담사에게 함께 넘길 마스킹 요약. 고객 경로에 렌더하지 않는다(§2·§10.3). */
  summaryMasked?: string;
  /** 요약이 실제로 붙었는지. 없으면 §2 가 말한 "아까 다 말했는데요"가 그대로 재현된다. */
  summaryPresent: boolean;
  /** 판정 경로(오버플로 연쇄 포함). 마스킹 경유. */
  path: readonly string[];
  reasonKo: string;
  warnings: readonly string[];
}

export interface QueuedPlacement extends PlacementCommon {
  placement: 'queued';
  /** **실제 목적지.** 오버플로면 오버플로 큐다. 놓을 수 있는 큐 id 는 이것 하나뿐이다. */
  queueId: string;
  overflowed: boolean;
  matchedRuleId?: string;
}

export interface AlternativePlacement extends PlacementCommon {
  placement: 'alternative';
  cause: AlternativeCause;
  /** 큐 설정에 선언된 대안. 여기서 만들지 않는다(§13-3). */
  action: ClosedAction;
}

export interface UnavailablePlacement {
  placement: 'unavailable';
  code: HandoffUnavailableCode;
  reasonKo: string;
  /** 설정 오류 원문(마스킹 경유). 빈 배열이면 원인을 특정하지 못한 것이다. */
  issues: readonly string[];
  summaryMasked?: string;
  summaryPresent: boolean;
  warnings: readonly string[];
}

export type HandoffPlacement = QueuedPlacement | AlternativePlacement | UnavailablePlacement;

function mask(text: string): string {
  return maskPii(text).text;
}

/**
 * 오프셋이 명시된 ISO-8601 만 시각으로 인정한다(위 6번).
 * `Date.parse` 만으로는 부족하다 — 시간대 없는 문자열도 통과시키고 호스트 로컬로 해석한다.
 */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function sameSnapshot(a: QueueSnapshot, b: QueueSnapshot): boolean {
  return a.waiting === b.waiting
    && a.availableAgents === b.availableAgents
    && a.observedAt === b.observedAt;
}

/**
 * 스냅샷 정리. **고쳐 쓰지 않고 걸러낸다** — 못 믿을 값을 보정하면 보정한 값으로 사람을 큐에 넣게 된다.
 * 걸러진 큐는 `admitToQueue` 에서 "상태 미확인"이 되어 보수적으로 닫히고, 이유는 warnings 에 남는다.
 */
function sanitizeSnapshots(
  snapshots: readonly QueueSnapshot[],
  nowMs: number,
  warnings: string[],
): QueueSnapshot[] {
  const byQueue = new Map<string, QueueSnapshot[]>();
  for (const s of snapshots) {
    if (typeof s?.queueId !== 'string' || s.queueId.length === 0) {
      warnings.push('큐 id 가 없는 스냅샷을 버렸다');
      continue;
    }
    if (!isInstant(s.observedAt)) {
      // 시간대 없는 관측 시각은 신선도 판정을 호스트 로컬 시간대에 맡기는 것과 같다(6번).
      warnings.push(`관측 시각에 시간대가 없어 스냅샷을 버렸다: ${mask(s.queueId)}`);
      continue;
    }
    if (!Number.isInteger(s.waiting) || s.waiting < 0
      || !Number.isInteger(s.availableAgents) || s.availableAgents < 0) {
      // NaN·음수는 `waiting >= maxWaiting` 비교에서 조용히 false 가 되어 **꽉 찬 큐를 열어 준다**.
      warnings.push(`실측값이 성립하지 않아 스냅샷을 버렸다: ${mask(s.queueId)}`);
      continue;
    }
    if (Date.parse(s.observedAt) > nowMs) {
      // 미래 관측은 시계 문제다. 임계값을 만들지 않고(§13-3) 사실만 드러낸다 —
      // 신선도 검사가 음수 나이로 **항상 통과**하므로 낡은 값이 영원히 신선해 보인다.
      warnings.push(`관측 시각이 현재보다 미래다: ${mask(s.queueId)}`);
    }
    const bucket = byQueue.get(s.queueId);
    if (bucket) bucket.push(s);
    else byQueue.set(s.queueId, [s]);
  }

  const out: QueueSnapshot[] = [];
  for (const [queueId, list] of byQueue) {
    const first = list[0] as QueueSnapshot;
    if (list.every((s) => sameSnapshot(s, first))) {
      out.push(first);
      continue;
    }
    // 어긋나는 스냅샷 중 하나를 고르는 순간 "배열 순서가 수용 판정을 정한다"가 된다(7번).
    warnings.push(`같은 큐의 스냅샷이 서로 어긋나 상태 미확인으로 둔다: ${mask(queueId)}`);
  }
  return out;
}

/**
 * 워크스페이스까지 포함한 격리 검사.
 * `selectQueue` 는 `tenantId` 만 보므로 여기서 한 겹 더 잠근다(§11.1).
 * **던진다** — 옆 워크스페이스 큐로 고객을 보내는 것은 폴백할 사안이 아니다.
 */
function assertConfigScope(cfg: RoutingConfig, scope: TenantScope): void {
  assertTenantScope(scope);
  if (cfg.tenantId !== scope.tenantId) {
    throw new Error('다른 테넌트의 라우팅 설정으로 이관할 수 없다 (설계서 §11.1)');
  }
  if ((cfg.workspaceId ?? undefined) !== (scope.workspaceId ?? undefined)) {
    throw new Error('다른 워크스페이스의 라우팅 설정으로 이관할 수 없다 (설계서 §11.1)');
  }
}

/**
 * 이관 실행: 목적지 선택 → 수용 판정 → **놓을 수 있는 큐 하나** 또는 대안.
 *
 * 순서가 곧 안전장치다. 격리 → 설정 검증 → 선택 → 수용 판정 순이고,
 * `queueId`(놓을 수 있는 목적지)는 **수용이 확정된 뒤에만** 만들어진다 —
 * 어느 단계에서 걸려도 "사람을 놓을 수 있는 큐 id"가 생기지 않는다.
 */
export function executeHandoff(cfg: RoutingConfig, req: HandoffRequest): HandoffPlacement {
  assertConfigScope(cfg, req.scope);

  const warnings: string[] = [];
  const summaryPresent = typeof req.summaryMasked === 'string' && req.summaryMasked.length > 0;
  // 요약은 **그대로** 통과시킨다 — 재마스킹은 이미 마스킹된 값을 뭉갠다(위 4번).
  const summaryFields = summaryPresent
    ? { summaryMasked: req.summaryMasked as string, summaryPresent: true as const }
    : { summaryPresent: false as const };
  if (!summaryPresent) {
    warnings.push('이관 요약 없이 이관한다 — 상담사가 맥락 없이 받는다 (설계서 §2)');
  }

  const unavailable = (
    code: HandoffUnavailableCode,
    reasonKo: string,
    issues: readonly string[] = [],
  ): UnavailablePlacement => ({
    placement: 'unavailable',
    code,
    reasonKo: mask(reasonKo),
    issues: issues.map(mask),
    ...summaryFields,
    warnings,
  });

  const configIssues = validateRoutingConfig(cfg);
  if (configIssues.length > 0) {
    // 설정이 깨진 채로 큐를 고르면 "갈 곳 없는 이관"이 통화 중에 터진다.
    // 대안 행동도 만들지 않는다 — 어느 큐의 선언을 쓸지 정할 근거가 없다(§13-3).
    return unavailable('E_CONFIG_INVALID', '라우팅 설정 오류로 이관 목적지를 정할 수 없다', configIssues);
  }

  if (!isInstant(req.nowIso)) {
    // 시각을 모르면 영업시간도 스냅샷 신선도도 판정할 수 없다. 열린 것으로 추정하지 않는다.
    // 시간대가 빠진 문자열도 여기서 걸린다 — 통과시키면 판정이 호스트마다 갈린다(위 6번).
    return unavailable(
      'E_CLOCK_INVALID',
      `시간대가 명시된 ISO-8601 시각이 아니다: ${JSON.stringify(req.nowIso)}`,
    );
  }
  const nowMs = Date.parse(req.nowIso);
  const snapshots = sanitizeSnapshots(req.snapshots ?? [], nowMs, warnings);

  let selection;
  try {
    selection = selectQueue(cfg, {
      scope: req.scope,
      channel: req.channel,
      reason: req.reason,
      ...(req.intent !== undefined ? { intent: req.intent } : {}),
      ...(req.language !== undefined ? { language: req.language } : {}),
      ...(req.slots !== undefined ? { slots: req.slots } : {}),
    });
  } catch (e) {
    // 격리 위반은 위에서 이미 걸렀으므로 여기 오는 것은 설정 결함이다(§13-3).
    return unavailable('E_ROUTING_FAILED', e instanceof Error ? e.message : '큐 선택 실패');
  }

  const requestedQueueId = selection.queue.id;

  let decision;
  try {
    decision = admitToQueue(cfg, requestedQueueId, snapshots, req.nowIso, req.admission ?? {});
  } catch (e) {
    return unavailable('E_ROUTING_FAILED', e instanceof Error ? e.message : '수용 판정 실패');
  }

  const path = decision.path.map(mask);
  const base = {
    requestedQueueId,
    ...summaryFields,
    path,
    warnings,
  };

  if (decision.status === 'accepted' || decision.status === 'overflow') {
    // **여기가 1번 사고 지점이다.** 목적지는 `admittedQueueId` 이며 `queueId`(요청 큐)가 아니다.
    const destination = decision.admittedQueueId;
    if (destination === undefined) {
      // 규약 위반 반환값. 요청 큐로 되돌리지 않는다 — 그게 정확히 1번 사고다.
      return unavailable('E_ROUTING_FAILED', `수용 판정이 목적지를 내지 않았다: ${decision.status}`);
    }
    return {
      placement: 'queued',
      ...base,
      queueId: destination,
      overflowed: decision.status === 'overflow',
      ...(selection.matchedRuleId !== undefined ? { matchedRuleId: selection.matchedRuleId } : {}),
      reasonKo: mask(`${selection.reasonKo} · ${decision.reasonKo}`),
    };
  }

  // closed·rejected — 큐에 놓을 id 를 만들지 않는다(2번).
  const action = decision.action;
  if (action === undefined) {
    return unavailable('E_ROUTING_FAILED', `수용 거부에 대안이 없다: ${decision.status}`);
  }
  return {
    placement: 'alternative',
    ...base,
    cause: decision.status === 'closed' ? 'closed' : 'rejected',
    action,
    reasonKo: mask(decision.reasonKo),
  };
}

export interface ExhaustedParams {
  scope: TenantScope;
  /** 오퍼를 돌리던 큐. `QueuedPlacement.queueId` 를 그대로 넘긴다. */
  queueId: string;
  summaryMasked?: string;
  /** 소진 사유(예: `applyOfferEvent` 의 `reasonKo`). 마스킹을 거친다. */
  reasonKo?: string;
}

/**
 * 재배정 소진 이후의 자리.
 *
 * `applyOfferEvent` 가 `exhausted` 를 내면 "고객을 대안으로 보낸다"는 점에서 큐가 닫힌 경우와 같은 일인데,
 * 결과 모양이 갈라지면 채널은 한쪽만 처리하고 다른 쪽은 조용히 끊는다(5번).
 * 그래서 **같은 `AlternativePlacement`** 로 수렴시킨다. 행동은 `exhaustedAction`(큐 선언값)을 그대로 쓴다.
 */
export function placementAfterExhausted(
  cfg: RoutingConfig,
  p: ExhaustedParams,
): AlternativePlacement {
  assertConfigScope(cfg, p.scope);
  const summaryPresent = typeof p.summaryMasked === 'string' && p.summaryMasked.length > 0;
  const warnings: string[] = [];
  if (!summaryPresent) {
    warnings.push('이관 요약 없이 대안으로 넘어간다 (설계서 §2)');
  }
  if (!cfg.queues.some((q) => q.id === p.queueId)) {
    // `exhaustedAction` 은 못 찾으면 'reject' 를 돌려준다 — 그 자체는 규약이지만,
    // **모르는 큐였다는 사실**이 사라지면 오탈자 하나가 "고객 거절"로만 보인다.
    warnings.push(`설정에 없는 큐의 소진 처리: ${mask(p.queueId)}`);
  }
  return {
    placement: 'alternative',
    cause: 'exhausted',
    action: exhaustedAction(cfg, p.queueId),
    requestedQueueId: p.queueId,
    ...(summaryPresent
      ? { summaryMasked: p.summaryMasked as string, summaryPresent: true as const }
      : { summaryPresent: false as const }),
    path: [mask(p.queueId)],
    reasonKo: mask(p.reasonKo ?? '재배정 한도 소진'),
    warnings,
  };
}

/** 큐에 사람을 놓아도 되는지. 채널이 `placement` 문자열을 직접 비교하다 오타로 틀리는 것을 막는다. */
export function isQueued(p: HandoffPlacement): p is QueuedPlacement {
  return p.placement === 'queued';
}
