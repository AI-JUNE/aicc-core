// 과금 근거의 턴 귀속 — 설계서 §11.2(과금 근거)·§8.1(이벤트)·§13-3(근거 없는 수치 금지).
//
// `billing/usage.ts` 는 이벤트에서 수량을 뽑는다. `adapters/engineSet.ts` 는 엔진 조각의
// `lastUsage()` 를 모은다. 그런데 **그 둘 사이가 비어 있었다** — 실측을 이벤트에 싣는 자리다.
// 그 공백의 증상은 예외가 아니라 전부 조용한 오답이라 청구 직전에야 드러난다.
//
//  (1) **실측이 실릴 자리를 못 찾으면 사라진다.** 런타임은 채널이 선언한 사용량을 "이번 턴의 고객
//      발화 이벤트"에 붙이는데, 그런 이벤트가 없는 턴(장애 폴백으로 조기 종료된 턴·커넥터 재개 턴)
//      에서는 조용히 버려진다. 그 턴의 STT·LLM 은 이미 호출돼 **공급사 청구서에는 남아 있고**
//      우리 집계에만 없다 — 대사에서 `missing_core`(이벤트 유실)로 뜨지만, 유실이 아니라
//      애초에 만들지 않은 것이라 원장을 뒤져도 찾을 수 없다. 그래서 못 붙였으면 드러낸다.
//  (2) **검증되지 않은 숫자 하나가 테넌트의 집계를 통째로 망친다.** 브리지 경로(JSONL)는 사용량을
//      검증하지만 TypeScript 호스트가 `ChannelTurnInput.usage` 로 바로 넘기는 경로는 **아무 검사도
//      없었다**. `llm_prompt_tokens: NaN` 하나가 이벤트에 실리면 `aggregateUsage` 의 합계가 NaN 이
//      되고, 그 달의 모든 수량이 NaN 으로 바뀐다. 더 나쁜 것은 판정이다 — NaN 비교는 언제나 거짓이라
//      `withinTolerance` 는 불일치로, `diff > 0` 은 거짓으로 읽혀 **과다청구 차단(`blocked`)이 아니라
//      검토 필요로 떨어진다**. 경로가 둘이면 검사도 둘이어야 하는 것이 아니라, 검사가 한 곳이어야 한다(§2).
//  (3) **같은 항목을 두 출처가 내면 합산이 곧 과다청구다.** 채널이 자기 STT 를 실측해 선언하고
//      Core 가 부른 엔진도 같은 키를 내놓으면, 더하는 순간 이중 계상이고 대사에서 과다청구로 나타난다.
//      `adapters/engineSet.ts` 의 `collectPartUsage` 와 **같은 규칙**을 쓴다: 합산하지 않고 드러낸다.
//
// 이 모듈은 순수하다 — 시각·난수·I/O 가 없고, 엔진·채널을 부르지 않는다. 금액을 모르고 단가도 모른다.
import type { InteractionEvent, TurnCompletedEvent, UsageMetrics } from '../events/schema.ts';

/** §11.2 사용량 항목. 이 목록 밖의 키는 정체불명 항목이므로 집계에 쌓지 않는다. */
export const USAGE_UNITS: readonly (keyof UsageMetrics)[] = [
  'llm_prompt_tokens', 'llm_completion_tokens', 'stt_audio_ms', 'tts_audio_ms',
];

/** 개수로만 성립하는 항목 — 소수 토큰은 실측이 아니라 환산 실수의 신호다. */
const COUNT_UNITS: readonly (keyof UsageMetrics)[] = ['llm_prompt_tokens', 'llm_completion_tokens'];

/** 한 턴에 실측을 내놓은 출처. `origin` 은 분쟁 추적용 이름이며 개인정보를 담지 않는다. */
export interface UsageContribution {
  /** 예: 'channel'(채널 선언)·'engine_set'(Core 가 부른 엔진). */
  origin: string;
  /** 형태를 신뢰하지 않는다 — 호스트가 넘긴 값일 수 있으므로 unknown 으로 받는다. */
  usage: unknown;
}

export interface UsageRejection {
  /** 거부한 항목 이름. 전체가 형태 위반이면 `(전체)`. */
  key: string;
  origin: string;
  reasonKo: string;
}

export interface UsageConflict {
  key: keyof UsageMetrics;
  origins: string[];
}

export interface MergedTurnUsage {
  /** 이벤트에 실을 수 있는 실측. 아무 값도 없으면 **생략한다** — 빈 객체는 "0 을 실측했다"로 읽힌다. */
  usage?: UsageMetrics;
  /** 합산하지 않고 빼낸 항목(이중 계상 방지). 빠졌다는 사실은 숨기지 않는다. */
  conflicts: UsageConflict[];
  /** 실측으로 볼 수 없어 버린 항목. */
  rejected: UsageRejection[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 여러 출처의 사용량을 한 턴의 과금 근거 하나로 합친다.
 *
 * 규칙은 `collectPartUsage`(§6.2 엔진 조각)와 같다 — 알 수 없는 키·실측으로 볼 수 없는 값은 버리고,
 * 같은 키를 둘 이상이 내면 **합산하지 않고** 빼낸 뒤 드러낸다. 규칙이 두 벌로 갈라지면 같은 값이
 * 경로에 따라 다르게 집계되고, 그 차이는 대사에서 '미설명'으로만 남는다.
 */
export function mergeTurnUsage(contributions: UsageContribution[]): MergedTurnUsage {
  const byKey = new Map<keyof UsageMetrics, { origin: string; value: number }[]>();
  const rejected: UsageRejection[] = [];

  for (const c of contributions) {
    if (c.usage === undefined || c.usage === null) continue;    // 안 낸 것은 0 이 아니다
    if (!isPlainObject(c.usage)) {
      rejected.push({ key: '(전체)', origin: c.origin, reasonKo: '사용량이 객체가 아닙니다.' });
      continue;
    }
    for (const [rawKey, rawValue] of Object.entries(c.usage)) {
      if (rawValue === undefined) continue;
      if (!USAGE_UNITS.includes(rawKey as keyof UsageMetrics)) {
        rejected.push({ key: rawKey, origin: c.origin, reasonKo: '알 수 없는 사용량 항목입니다(§11.2).' });
        continue;
      }
      const key = rawKey as keyof UsageMetrics;
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue < 0) {
        // NaN·Infinity 하나가 집계 합계를 통째로 NaN 으로 만들고, 그 상태의 판정은 과다청구 차단을
        // 비껴간다. 0 으로 보정하지 않는다 — 보정은 "0 을 실측했다"는 거짓 근거를 만든다(§13-3).
        rejected.push({ key: rawKey, origin: c.origin, reasonKo: '실측으로 볼 수 없는 값입니다(음수·NaN·무한·숫자 아님).' });
        continue;
      }
      if (COUNT_UNITS.includes(key) && !Number.isInteger(rawValue)) {
        rejected.push({ key: rawKey, origin: c.origin, reasonKo: '토큰 수는 정수여야 합니다 — 소수는 단위 환산 오류의 신호입니다(§6.2).' });
        continue;
      }
      const list = byKey.get(key) ?? [];
      list.push({ origin: c.origin, value: rawValue });
      byKey.set(key, list);
    }
  }

  const usage: UsageMetrics = {};
  const conflicts: UsageConflict[] = [];
  let sawAny = false;
  for (const key of USAGE_UNITS) {
    const list = byKey.get(key);
    if (!list || list.length === 0) continue;
    if (list.length > 1) {
      conflicts.push({ key, origins: list.map((x) => x.origin) });
      continue;
    }
    usage[key] = list[0]!.value;
    sawAny = true;
  }

  const out: MergedTurnUsage = { conflicts, rejected };
  if (sawAny) out.usage = usage;
  return out;
}

export interface UsageAttachment {
  attached: boolean;
  /** 실측을 실은 턴. 분쟁에서 "어느 턴의 근거인가"를 되짚는 유일한 열쇠다. */
  turnId?: string;
  /** 붙이지 못한 이유. 붙이지 못했다는 사실 자체가 근거 누락이므로 조용히 넘기지 않는다. */
  reasonKo?: string;
}

/**
 * 이번 턴의 실측을 **고객 발화 이벤트**에 붙인다(제자리 치환 — 호출자가 발행 전에 부른다).
 *
 * 고객 발화를 고르는 이유: 사용량은 그 발화를 처리하느라 쓴 것이고, 봇 발화 이벤트는 이행 과정에서
 * 여러 개가 쌓이므로 대상이 호출 시점에 따라 흔들린다. 마지막 고객 발화를 쓴다 — 한 턴에 둘이
 * 들어오는 경로는 없고, 있다면 가장 나중 것이 이번 입력이다.
 *
 * **이미 사용량이 실린 이벤트는 덮어쓰지 않는다.** 덮어쓰면 먼저 실린 실측이 소리 없이 사라지고,
 * 합치면 이중 계상이 된다 — 둘 다 잘못이므로 붙이지 않고 드러낸다(호출자가 `mergeTurnUsage` 로
 * 먼저 합쳐 한 번에 넘기는 것이 올바른 사용법이다).
 */
export function attachTurnUsage(events: InteractionEvent[], usage: UsageMetrics): UsageAttachment {
  for (let idx = events.length - 1; idx >= 0; idx--) {
    const e = events[idx];
    if (!e || e.type !== 'turn.completed') continue;
    const turn = e as TurnCompletedEvent;
    if (turn.speaker !== 'customer') continue;
    if (turn.usage !== undefined) {
      return {
        attached: false,
        turnId: turn.turn_id,
        reasonKo: `턴 ${turn.turn_id} 에 이미 사용량이 실려 있어 덮어쓰지 않았습니다 — 이번 실측은 집계에 들어가지 않습니다(§11.2).`,
      };
    }
    events[idx] = { ...turn, usage };
    return { attached: true, turnId: turn.turn_id };
  }
  return {
    attached: false,
    reasonKo: '이번 턴에 고객 발화 이벤트가 없어 실측을 실을 자리가 없습니다 — 그 사용량은 과금 집계에 들어가지 않습니다(§11.2).',
  };
}

export type BillableMsCheck =
  | { ok: true; billableMs: number }
  | { ok: false; reasonKo: string };

/**
 * 통화 과금 구간(ms) 검증. **던지지 않는다** — 과금 근거가 틀렸다는 이유로 세션 종료를 막으면
 * 세션이 열린 채 남고, 그 누수는 장애가 아니라 **요금**으로 나타난다(브리지가 `end` 를 절대
 * 막지 않는 것과 같은 이유다).
 *
 * 상한을 두지 않는다 — "통화가 이렇게 길 수는 없다"는 숫자는 계약·회선마다 다르고, Core 가 정하면
 * 그 값이 곧 정책이 된다(§13-3). 0 은 허용한다: 즉시 끊긴 호는 실제로 0 이며, 거부하면 그 세션이
 * '실측 누락'으로 집계돼 **측정하지 않은 것과 구분되지 않는다**.
 */
export function checkBillableMs(raw: unknown): BillableMsCheck {
  if (typeof raw !== 'number') return { ok: false, reasonKo: `통화 과금 구간(billableMs)이 숫자가 아닙니다: ${typeof raw}` };
  if (!Number.isFinite(raw)) return { ok: false, reasonKo: '통화 과금 구간(billableMs)이 유한한 값이 아닙니다 — 실측으로 볼 수 없습니다.' };
  if (raw < 0) return { ok: false, reasonKo: `통화 과금 구간(billableMs)이 음수입니다: ${raw}` };
  return { ok: true, billableMs: raw };
}

/**
 * 이번 호출에서 과금 근거가 **어디까지 실렸는가**. 전부 사실 기술이며 판단 점수·추정치가 없다(§13-3).
 *
 * 호스트가 이 값을 읽어야 하는 이유: `attached: false` 인 실측은 §8.1 원장에 없고 따라서
 * `aggregateUsage` 에도 없다. 그 사실을 호출 시점에 알려 주지 않으면, 공급사 청구서와 우리 집계의
 * 차이를 몇 주 뒤 대사에서 '미설명'으로 만나게 된다.
 */
export interface TurnBillingNote {
  /** 사용량을 이벤트에 실었는가. 선언이 없었으면 생략된다. */
  usageAttached?: boolean;
  usageReasonKo?: string;
  /** 합산하지 않고 빼낸 항목 이름. */
  usageConflicts?: string[];
  /** 실측으로 볼 수 없어 버린 항목 이름. */
  usageRejected?: string[];
  /** 통화 과금 구간을 `session.ended` 에 실었는가. 선언이 없었으면 생략된다. */
  billableMsRecorded?: boolean;
  billableMsReasonKo?: string;
}

/** 합치기 결과 + 붙이기 결과 → 호스트가 읽을 한 덩어리. 값이 없는 항목은 만들지 않는다. */
export function usageNote(merged: MergedTurnUsage, attachment?: UsageAttachment): TurnBillingNote {
  const note: TurnBillingNote = {};
  if (attachment !== undefined) {
    note.usageAttached = attachment.attached;
    if (attachment.reasonKo !== undefined) note.usageReasonKo = attachment.reasonKo;
  }
  if (merged.conflicts.length > 0) note.usageConflicts = merged.conflicts.map((c) => c.key);
  if (merged.rejected.length > 0) note.usageRejected = merged.rejected.map((r) => `${r.origin}.${r.key}`);
  return note;
}

/** 비어 있는 기록은 결과에 싣지 않는다 — 빈 객체가 실리면 "확인했는데 아무 문제 없음"으로 읽힌다. */
export function billingNoteOrUndefined(note: TurnBillingNote): TurnBillingNote | undefined {
  return Object.keys(note).length === 0 ? undefined : note;
}
