// 재프롬프트 정책 — 설계서 §5.1(대화 폴백 사다리)·§5.3(단일 시나리오)·§13-3(임의 기본값 금지).
//
// 지금까지 FlowRunner 는 입력이 실패하면 **같은 노드를 같은 문장으로 다시 렌더**했다.
// 텍스트 채널에서는 그럭저럭 넘어가지만 음성에서는 이것이 곧 이탈이다 —
// 아무 말도 못 한 사람과, 말했지만 못 알아들은 사람과, 없는 번호를 누른 사람에게
// 똑같은 문장을 다시 들려주면 두 번째 시도도 같은 이유로 실패한다.
//
// 그래서 각 채널 저장소는 결국 자기 쪽에서 "무입력이면 이렇게 말해라"를 손으로 짜 넣게 된다.
// 그 순간 §2 가 지적한 시나리오 이중 관리가 재발한다 — 문안이 세 벌로 갈라지고,
// 어느 저장소가 어떤 문장을 쓰는지 아무도 모르게 된다. 그래서 여기 한 곳에 둔다.
//
// 하지 않는 것: **기본 문안을 만들지 않는다.** 정책을 주지 않으면 이 모듈은 아무것도 돌려주지
// 않고 Runner 는 종전대로 원문을 재생한다. "죄송합니다, 다시 말씀해 주세요" 같은 문장을
// Core 가 지어내면 고객사 화법·상품명과 어긋난 말이 고객에게 그대로 나간다(§13-3).

/**
 * 입력 실패의 원인. 세 가지를 굳이 나눈 이유는 **필요한 다음 말이 서로 다르기 때문**이다.
 * - `no_input`: 고객이 아무것도 주지 않았다(타임아웃·빈 입력). 다시 물어야 한다.
 * - `low_confidence`: 발화는 있으나 인식 신뢰도가 테넌트 임계값 미달이다. 되묻거나 수단을 바꿔야 한다.
 * - `no_match`: 인식은 됐지만 선택지·형식과 맞지 않는다. 선택지를 다시 제시해야 한다.
 */
export type RepromptReason = 'no_input' | 'low_confidence' | 'no_match';

export const REPROMPT_REASONS: readonly RepromptReason[] = ['no_input', 'low_confidence', 'no_match'];

/** Runner 가 만들어 넘기는 최소 신호. Runner 타입에 의존하지 않게 일부러 좁혀 두었다. */
export interface FailureSignal {
  kind: 'utterance' | 'dtmf' | 'timeout';
  /** 인식된 텍스트·DTMF 자릿수. 공백만 있으면 무입력으로 본다. */
  text?: string;
  /** STT 신뢰도. 어댑터가 실측으로 채운 경우에만 존재한다(§13-3). */
  confidence?: number;
}

/** 시도 1회분 대본. */
export interface RepromptLine {
  /** 재프롬프트 대본. 고객사가 쓴 문장이며 Core 는 문안을 만들지 않는다. */
  text: string;
  /**
   * 이 시도에서 DTMF 안내를 함께 낸다는 선언(§5.1 어르신·소음 환경 폴백).
   * 음성 채널에서만 의미가 있고, 화면 채널에서는 무시된다 — 채널마다 다르게 해석하면
   * 같은 정책이 저장소마다 다른 결과를 낸다.
   */
  offerDtmf?: boolean;
}

/**
 * 재프롬프트 정책. 원인별 사다리를 우선하고, 없으면 공통 사다리를 쓴다.
 * 둘 다 없으면 그 원인에 대해서는 **아무것도 만들지 않는다**(Runner 가 원문을 재생한다).
 */
export interface RepromptPolicy {
  byReason?: Partial<Record<RepromptReason, RepromptLine[]>>;
  /** 원인별 선언이 없을 때 쓰는 공통 사다리. */
  sharedLines?: RepromptLine[];
}

export interface RepromptIssue {
  severity: 'error' | 'warning';
  path: string;
  messageKo: string;
}

/** 시도 n 회차에 실제로 낼 것. */
export interface RepromptPlan {
  reason: RepromptReason;
  /** 1부터 센다. Runner 의 failCount 와 같은 값이다. */
  attempt: number;
  text: string;
  /** 음성 채널이면서 해당 시도가 DTMF 안내를 선언한 경우에만 true. */
  acceptDtmf: boolean;
  /**
   * 선언된 사다리를 다 쓰고 마지막 문장을 반복하는 중이라는 표시.
   * 무한히 같은 말을 하고 있다는 사실을 호스트가 볼 수 있어야 한다 —
   * 보이지 않으면 최대 재시도 설정이 잘못된 시나리오가 조용히 굴러간다.
   */
  exhausted: boolean;
  source: 'reason' | 'shared';
}

/**
 * 실패 원인을 정한다.
 * `minConfidence` 는 테넌트 설정이며 주지 않으면 신뢰도로 판정하지 않는다(§13-3).
 * 판정 순서가 중요하다 — 무입력을 저신뢰로 적으면 "잘 못 알아들었습니다"가
 * 침묵한 사람에게 나간다.
 */
export function classifyFailure(signal: FailureSignal, minConfidence?: number): RepromptReason {
  if (signal.kind === 'timeout') return 'no_input';
  if ((signal.text ?? '').trim() === '') return 'no_input';
  if (
    minConfidence !== undefined &&
    signal.kind === 'utterance' &&
    signal.confidence !== undefined &&
    signal.confidence < minConfidence
  ) {
    return 'low_confidence';
  }
  return 'no_match';
}

function linesOf(policy: RepromptPolicy, reason: RepromptReason): { lines: RepromptLine[]; source: 'reason' | 'shared' } | undefined {
  const byReason = policy.byReason?.[reason];
  if (Array.isArray(byReason) && byReason.length > 0) return { lines: byReason, source: 'reason' };
  const shared = policy.sharedLines;
  if (Array.isArray(shared) && shared.length > 0) return { lines: shared, source: 'shared' };
  return undefined;
}

/**
 * 정책 검증. 등록 시점에 한 번 돌려 잘못된 정책이 통화 중에 발견되지 않게 한다.
 * 빈 문장은 경고가 아니라 **오류**다 — 재프롬프트 자리에 무음이 나가면
 * 고객은 시스템이 끊긴 줄 알고 끊는다.
 */
export function validateRepromptPolicy(policy: RepromptPolicy): RepromptIssue[] {
  const issues: RepromptIssue[] = [];
  const check = (lines: unknown, path: string): void => {
    if (!Array.isArray(lines)) {
      issues.push({ severity: 'error', path, messageKo: `${path}: 배열이어야 합니다` });
      return;
    }
    if (lines.length === 0) {
      issues.push({ severity: 'warning', path, messageKo: `${path}: 비어 있어 재프롬프트가 만들어지지 않습니다` });
      return;
    }
    lines.forEach((line, i) => {
      const at = `${path}[${i}]`;
      if (line === null || typeof line !== 'object') {
        issues.push({ severity: 'error', path: at, messageKo: `${at}: 객체가 아닙니다` });
        return;
      }
      const text = (line as RepromptLine).text;
      if (typeof text !== 'string' || text.trim() === '') {
        issues.push({ severity: 'error', path: at, messageKo: `${at}: 대본(text)이 비어 있습니다` });
      }
    });
  };

  const byReason = policy.byReason;
  if (byReason !== undefined) {
    if (byReason === null || typeof byReason !== 'object') {
      issues.push({ severity: 'error', path: 'byReason', messageKo: 'byReason: 객체가 아닙니다' });
    } else {
      for (const key of Object.keys(byReason)) {
        if (!REPROMPT_REASONS.includes(key as RepromptReason)) {
          // 오타 난 원인 키는 조용히 무시되면 영영 안 쓰인다.
          issues.push({ severity: 'error', path: `byReason.${key}`, messageKo: `byReason.${key}: 알 수 없는 실패 원인입니다` });
          continue;
        }
        check(byReason[key as RepromptReason], `byReason.${key}`);
      }
    }
  }
  if (policy.sharedLines !== undefined) check(policy.sharedLines, 'sharedLines');

  if (byReason === undefined && policy.sharedLines === undefined) {
    issues.push({ severity: 'warning', path: '', messageKo: '선언된 재프롬프트가 없습니다 — 원문이 그대로 재생됩니다' });
  }
  return issues;
}

export function repromptPolicyOk(issues: RepromptIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}

/**
 * 시도 회차에 맞는 재프롬프트를 고른다. 정책이 없거나 그 원인에 대한 선언이 없으면 `undefined` —
 * 이때 Runner 는 종전대로 노드 원문을 재생한다(동작이 사라지지 않게).
 *
 * `attempt` 는 1 이상의 정수여야 한다. 0·음수·소수는 호출부 결함이므로 문장을 지어내지 않고
 * `undefined` 를 돌려준다 — 잘못된 회차로 마지막 문장을 내보내면 사다리가 건너뛰어진다.
 */
export function buildReprompt(
  policy: RepromptPolicy | undefined,
  reason: RepromptReason,
  attempt: number,
  channel: string,
): RepromptPlan | undefined {
  if (!policy) return undefined;
  if (!Number.isInteger(attempt) || attempt < 1) return undefined;
  const picked = linesOf(policy, reason);
  if (!picked) return undefined;

  const { lines, source } = picked;
  const idx = Math.min(attempt - 1, lines.length - 1);
  const line = lines[idx];
  if (!line || typeof line.text !== 'string' || line.text.trim() === '') return undefined;

  return {
    reason,
    attempt,
    text: line.text,
    acceptDtmf: line.offerDtmf === true && channel === 'voice',
    exhausted: attempt > lines.length,
    source,
  };
}
