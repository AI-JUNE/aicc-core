// 턴 타이밍 정책 — 설계서 §5.1(대화 폴백)·§5.3(단일 시나리오)·§13-3(임의 수치 금지).
//
// 재프롬프트(flow/reprompt.ts)가 "실패하면 무엇을 말할지"를 Core 로 모았다면,
// 여기는 그 앞 질문이다: **얼마나 기다렸다가 실패로 볼 것인가.**
//
// 지금까지 Core 는 `{ kind: 'timeout' }` 입력을 받기만 했다. 언제 그것을 보낼지는
// 채널이 각자 정했다. 그러면 같은 시나리오인데 Callbot 은 3초, D-ARS 는 10초에 끊는
// 상황이 생기고, 어느 쪽이 맞는지 아무도 모른다 — §2 가 지적한 이중 관리가
// 문안이 아니라 숫자의 형태로 재발한 것이다. 특히 음성에서 이 숫자는 품질 그 자체다.
// 말이 느린 고객에게 대기 시간이 짧으면 시스템은 "무입력"으로 읽고, 고객은
// "말했는데 안 듣는다"로 읽는다. 서로 다른 사건을 보고 있는 셈이다.
//
// 하지 않는 것: **기본 대기 시간을 만들지 않는다.** 3초든 8초든 Core 가 정할 근거가 없다
// (회선·상품·연령대에 따라 다르고, 실측 전 숫자는 §13-3 위반이다). 정책을 주지 않으면
// 이 모듈은 아무 값도 돌려주지 않고, 채널은 종전대로 자기 값을 쓴다 — 달라지는 것은
// "선언하면 한 곳에서 선언된다"는 점이다.
import type { NodeKind } from './types.ts';

/** 고객 입력을 기다리는 노드만 의미가 있다. Say·Transfer·Api 는 대기 노드가 아니다. */
export const INPUT_NODE_KINDS: readonly NodeKind[] = ['Collect', 'Choice', 'Confirm'];

export interface TurnTimingPolicy {
  /**
   * 노드 종류별 입력 대기(ms). 선언하지 않은 종류는 Core 가 값을 만들지 않는다.
   * 대기 노드가 아닌 종류를 선언하면 검증에서 걸린다(무의미한 선언은 오해를 부른다).
   */
  inputTimeoutMsByKind?: Partial<Record<NodeKind, number>>;
  /**
   * 시도 회차별 가산(ms). 색인은 `attempt - 1` 이며, 첫 제시가 attempt 1 이다.
   * 두 번째 시도에 조금 더 기다리는 것이 §5.1 폴백의 실제 내용이다 —
   * 어르신·소음 환경에서 첫 실패의 가장 흔한 원인이 "말을 시작하기 전에 끊겼다" 이기 때문이다.
   * 선언된 길이를 넘는 회차는 마지막 값을 쓴다.
   */
  extraMsByAttempt?: number[];
  /** 가산 상한(ms). 주지 않으면 상한을 두지 않는다 — 상한도 임의로 정할 수 없다(§13-3). */
  maxInputTimeoutMs?: number;
  /**
   * 안내 도중 고객이 말을 끊고 들어오는 것을 허용할지(barge-in). 음성에서만 의미가 있으므로
   * 화면·채팅 채널에서는 결과에 싣지 않는다 — 채널마다 다르게 해석하면 같은 정책이 다른 동작이 된다.
   */
  bargeInByKind?: Partial<Record<NodeKind, boolean>>;
}

export interface TimingIssue {
  severity: 'error' | 'warning';
  path: string;
  messageKo: string;
}

/** 한 단계에 실어 보낼 타이밍 힌트. 선언되지 않은 항목은 아예 없다(0·false 로 채우지 않는다). */
export interface TurnTiming {
  inputTimeoutMs?: number;
  bargeIn?: boolean;
}

export interface TimingQuery {
  kind: NodeKind;
  /** 1부터 센다. 첫 제시가 1, 첫 재시도가 2 다. */
  attempt: number;
  channel: string;
}

function finitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * 정책 검증. 음수·NaN·0 은 오류다 — 0ms 대기는 "기다리지 않는다"가 아니라
 * 대개 설정 실수이고, 그대로 두면 모든 턴이 즉시 무입력으로 떨어진다.
 */
export function validateTurnTimingPolicy(policy: TurnTimingPolicy): TimingIssue[] {
  const issues: TimingIssue[] = [];

  const byKind = policy.inputTimeoutMsByKind;
  if (byKind !== undefined) {
    if (byKind === null || typeof byKind !== 'object') {
      issues.push({ severity: 'error', path: 'inputTimeoutMsByKind', messageKo: 'inputTimeoutMsByKind: 객체가 아닙니다' });
    } else {
      for (const [k, v] of Object.entries(byKind)) {
        const at = `inputTimeoutMsByKind.${k}`;
        if (!INPUT_NODE_KINDS.includes(k as NodeKind)) {
          issues.push({ severity: 'error', path: at, messageKo: `${at}: 입력을 기다리지 않는 노드입니다 — 이 선언은 적용되지 않습니다` });
          continue;
        }
        if (!finitePositive(v)) issues.push({ severity: 'error', path: at, messageKo: `${at}: 0보다 큰 유한한 ms 여야 합니다` });
      }
    }
  }

  const extras = policy.extraMsByAttempt;
  if (extras !== undefined) {
    if (!Array.isArray(extras)) {
      issues.push({ severity: 'error', path: 'extraMsByAttempt', messageKo: 'extraMsByAttempt: 배열이어야 합니다' });
    } else {
      extras.forEach((v, i) => {
        const at = `extraMsByAttempt[${i}]`;
        // 0 은 허용한다 — "첫 제시에는 가산 없음"이 정상적인 선언이다.
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          issues.push({ severity: 'error', path: at, messageKo: `${at}: 0 이상의 유한한 ms 여야 합니다` });
        }
      });
    }
  }

  if (policy.maxInputTimeoutMs !== undefined && !finitePositive(policy.maxInputTimeoutMs)) {
    issues.push({ severity: 'error', path: 'maxInputTimeoutMs', messageKo: 'maxInputTimeoutMs: 0보다 큰 유한한 ms 여야 합니다' });
  }

  const barge = policy.bargeInByKind;
  if (barge !== undefined) {
    if (barge === null || typeof barge !== 'object') {
      issues.push({ severity: 'error', path: 'bargeInByKind', messageKo: 'bargeInByKind: 객체가 아닙니다' });
    } else {
      for (const [k, v] of Object.entries(barge)) {
        const at = `bargeInByKind.${k}`;
        if (!INPUT_NODE_KINDS.includes(k as NodeKind)) {
          issues.push({ severity: 'error', path: at, messageKo: `${at}: 입력을 기다리지 않는 노드입니다 — 이 선언은 적용되지 않습니다` });
          continue;
        }
        if (typeof v !== 'boolean') issues.push({ severity: 'error', path: at, messageKo: `${at}: true·false 여야 합니다` });
      }
    }
  }

  // 상한이 가장 짧은 기본 대기보다도 작으면, 선언한 대기 시간이 통째로 무력화된다.
  const declared = Object.entries(byKind ?? {}).filter(([, v]) => finitePositive(v)).map(([, v]) => v as number);
  if (policy.maxInputTimeoutMs !== undefined && finitePositive(policy.maxInputTimeoutMs) && declared.some((v) => v > policy.maxInputTimeoutMs!)) {
    issues.push({
      severity: 'warning', path: 'maxInputTimeoutMs',
      messageKo: 'maxInputTimeoutMs 가 선언된 대기 시간보다 짧습니다 — 선언한 값이 상한으로 잘립니다',
    });
  }

  if (byKind === undefined && extras === undefined && barge === undefined) {
    issues.push({ severity: 'warning', path: '', messageKo: '선언된 타이밍이 없습니다 — 채널이 각자의 값을 씁니다' });
  }
  return issues;
}

export function turnTimingPolicyOk(issues: TimingIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}

/**
 * 한 단계의 타이밍 힌트를 정한다. 선언이 없으면 빈 객체를 돌려준다 —
 * 채널은 빈 객체를 "Core 가 정하지 않았다"로 읽고 종전 동작을 유지한다.
 *
 * `attempt` 가 1 이상의 정수가 아니면 가산을 적용하지 않는다(호출부 결함으로 대기가 늘어나면
 * 잘못된 값이 조용히 통화에 나간다).
 */
export function resolveTurnTiming(policy: TurnTimingPolicy | undefined, q: TimingQuery): TurnTiming {
  const out: TurnTiming = {};
  if (!policy) return out;
  if (!INPUT_NODE_KINDS.includes(q.kind)) return out;

  const base = policy.inputTimeoutMsByKind?.[q.kind];
  if (finitePositive(base)) {
    let ms = base;
    const extras = policy.extraMsByAttempt;
    if (Array.isArray(extras) && extras.length > 0 && Number.isInteger(q.attempt) && q.attempt >= 1) {
      const extra = extras[Math.min(q.attempt - 1, extras.length - 1)];
      if (typeof extra === 'number' && Number.isFinite(extra) && extra >= 0) ms += extra;
    }
    if (finitePositive(policy.maxInputTimeoutMs)) ms = Math.min(ms, policy.maxInputTimeoutMs);
    out.inputTimeoutMs = ms;
  }

  // barge-in 은 매체 특성이다. 화면 채널에 실어 보내면 채널마다 제각기 해석한다.
  if (q.channel === 'voice') {
    const b = policy.bargeInByKind?.[q.kind];
    if (typeof b === 'boolean') out.bargeIn = b;
  }
  return out;
}
