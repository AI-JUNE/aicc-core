// 상담사 배정 오퍼 실행기 — 설계서 §2(핸드오프 단절 해소)·§9.3(대안 경로)·§10.3(마스킹)·
// §11.1(테넌트·워크스페이스 격리)·§13-3(임의 기본값 금지).
//
// `executeHandoff` 는 **큐에 놓는 데까지**다. 그 뒤가 비어 있었다 —
// `offerAssignment`·`applyOfferEvent`·`placementAfterExhausted` 를 부르는 곳은 저장소 전체에서
// 테스트뿐이다. 즉 **"큐에 들어간 고객을 상담사에게 제안하고, 안 받으면 다음 상담사에게 넘기고,
// 끝까지 아무도 안 받으면 §9.3 대안으로 보내는" 경로가 한 줄도 없었다.** `placementAfterExhausted`
// 머리말이 그 자리를 전제로 쓰여 있는데(“`applyOfferEvent` 가 `exhausted` 를 내면 …”) 그 함수를
// 부르는 코드가 없으므로, 지금은 소진 이후가 **아무 데로도 가지 않는다**.
//
// 호스트가 손으로 꿰면 빠지는 것은 취향이 아니라 정해져 있고, **아홉 개 전부 예외가 아니다** —
// 고객은 조용히 기다리고, 운영 화면에는 "대기 중"으로만 보인다.
//  (가) **attempt 를 호스트가 센다.** `offerAssignment` 는 `attempt` 를 **인자로 받는다**. 매번 1 을
//      넣으면 `applyOfferEvent` 의 `attempt >= maxAttempts` 가 영영 참이 되지 않아 **재배정이
//      무한**이 된다. 한도를 넣었는데도 소진되지 않으므로 설정 화면은 멀쩡해 보인다. 그래서
//      attempt 는 **원장에서 센다** — 호스트가 선언할 자리를 두지 않는다.
//  (나) **소진 이후가 건너뛰어진다.** `exhausted` 를 받고 `placementAfterExhausted` 를 부르지
//      않으면 고객은 큐에 남은 채 아무 일도 일어나지 않는다. 콜백·음성사서함·기존 IVR 로 가는
//      §9.3 경로가 통째로 사라지는데, 끊기지도 않으므로 장애로 잡히지 않는다.
//      그래서 소진은 **같은 호출 안에서** 대안으로 수렴한다.
//  (다) **같은 상호작용에 오퍼가 둘 열린다.** 두 상담사가 같은 콜을 받고, 한 명은 고객이 없는
//      통화에 들어간다. 열린 오퍼가 있으면 새 오퍼를 거절한다.
//  (라) **한 상담사에게 두 콜이 동시에 열린다.** 같은 사람이 양쪽을 수락하면 뒤쪽 고객은 응답
//      없는 상담사를 기다린다. 다른 상호작용의 열린 오퍼를 가진 상담사는 후보에서 **제외하고
//      제외 사실을 드러낸다**(조용히 줄이지 않는다).
//  (마) **거절한 상담사에게 다시 제안한다.** 즉시 또 거절되고 **한도만 깎인다** — 세 번 돌릴 수
//      있었던 재배정이 한 사람에게 세 번 가서 끝난다. 그래서 선언(`allowReoffer`)이 없으면
//      이미 제안받은 상담사는 다시 고르지 않는다.
//  (바) **만료된 오퍼가 영영 `offered` 로 남는다.** `applyOfferEvent` 의 `tick` 을 아무도 돌리지
//      않으면 그 통화는 큐에 묶인 채 대안으로도 가지 않는다. `expiredOffers` 가 만료분을
//      **목록으로** 드러내 호스트가 빠뜨릴 수 없게 한다(타이머는 Core 가 돌리지 않는다 —
//      `ops/recoveryProbe.ts` 와 같은 이유로, 몰래 켠 인터벌은 끌 수도 없다).
//  (사) **종결된 오퍼에 이벤트가 또 온다.** 웹훅 재전송·중복 클릭이 흔한 경로다. `applyOfferEvent`
//      는 이때 `next: 'waiting'` 을 돌려주는데(규약이다), 호스트가 그것을 "응답 대기 중"으로 읽으면
//      **이미 배정된 통화가 영원히 대기로 보인다**. 그래서 종결 상태는 `waiting` 이 아니라
//      **거절(`refused`)로 갈라 적는다**.
//  (아) **offerId 를 재사용한다.** 재전송된 요청이 살아 있는 오퍼를 덮어쓰면 attempt 가 되감기고
//      (가)가 형태만 바꿔 되살아난다. 원장에 같은 id 가 있으면 거절한다.
//  (자) **시간대 없는 시각을 넘긴다.** `applyOfferEvent` 는 `Date.parse` 만 보므로
//      `'2026-03-02 10:00'` 이 **호스트 로컬**로 해석되고, 만료 판정이 서버마다 갈린다.
//      라우팅 경로의 시각 판정은 `executeHandoff.isRoutingInstant` 하나다(§2).
//
// 경계:
//  - **판정을 복사하지 않는다(§2).** 오퍼 전이는 `applyOfferEvent`, 대안 행동은
//    `placementAfterExhausted`(→`exhaustedAction`), 큐 수용은 `admitToQueue`(이 파일에 없다),
//    격리는 `assertRoutingScope`. 이 파일에는 상태표도 대안 기본값도 없다.
//  - **상담사를 고르는 정책을 만들지 않는다.** 후보 목록과 순서는 호스트가 선언한 그대로 쓴다
//    (스킬·숙련도·최근 통화 수 같은 배분 정책은 운영 사항이다, §13-3). 이 파일이 하는 일은
//    **고르면 안 되는 후보를 제외**하는 것뿐이고, 제외는 전부 결과에 적힌다.
//  - **대기 예상 시간·한도 기본값을 만들지 않는다**(§13-3). `timeoutMs`·`maxAttempts` 가 없으면
//    판정하지 않고 거절한다 — 0 으로 읽으면 모든 오퍼가 즉시 만료되고, 무한으로 읽으면 (가)다.
//  - **엔진·백엔드 상태로 집계하지 않는다.** 상담사가 안 받는 것은 장애가 아니다 — §9.3 폴백에
//    넣으면 점심시간마다 전 채널이 AI 중단으로 떨어진다. 그래서 헬스·폴백 모듈을 참조하지 않는다.
//  - **던지는 것은 격리 위반 하나뿐이다**(§11.1) — 남의 테넌트 설정으로 상담사를 고르는 것은
//    폴백할 사안이 아니다. 그 밖의 실패는 전부 결과값이다(`refused`); 통화를 끊는 판단은 채널이 한다.
//  - **고객을 큐에서 빼지 않는다.** 제안할 상담사가 없는 것은 **한도 소진이 아니다** —
//    둘을 같게 적으면 운영은 "재배정 한도를 늘리면 되겠네"로 읽고 원인은 상담사 부재다.
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { AssignmentOffer, OfferEvent, RoutingConfig } from './agentQueue.ts';
import { applyOfferEvent, offerAssignment } from './agentQueue.ts';
import type { AlternativePlacement } from './executeHandoff.ts';
import { assertRoutingScope, isRoutingInstant, placementAfterExhausted } from './executeHandoff.ts';

export const OFFER_EXECUTION_CONTRACT_VERSION = 1;

/**
 * 오퍼 운영값. **전부 선언이며 기본값이 없다**(§13-3) — 응답 한도 몇 초가 적당한지,
 * 몇 명까지 돌릴지는 회선·상품·상담사 수에 따라 다르고 Core 가 정할 근거가 없다.
 */
export interface OfferPolicy {
  /** 응답 대기 한도(ms). 양수 정수만. */
  timeoutMs: number;
  /** 한 상호작용에 허용되는 오퍼 횟수. 1 이상 정수만. */
  maxAttempts: number;
  /**
   * 거절·무응답한 상담사에게 **다시** 제안할 수 있는가.
   * 선언이 없으면 다시 제안하지 않는다 — 기본을 '허용'으로 두면 (마)가 조용히 열린다.
   */
  allowReoffer?: boolean;
}

/** 오퍼 원장. 전이는 레코드를 **교체**하므로(상태가 바뀐다) 새 원장을 돌려준다. */
export interface OfferLedger {
  readonly offers: readonly AssignmentOffer[];
}

export function emptyOfferLedger(): OfferLedger {
  return { offers: [] };
}

export type OfferStepCode =
  /** 새 오퍼가 열렸다 */
  | 'offered'
  /** 아직 응답 대기 — 또는 제안할 후보가 없어 **큐에 그대로** 둔다(소진이 아니다) */
  | 'waiting'
  /** 상담사가 수락했다 */
  | 'assigned'
  /** 전이는 반영됐고 **다음 제안이 필요하다**(후보·다음 offerId 를 주면 같은 호출에서 이어진다) */
  | 'requeue'
  /** 오퍼 취소(고객 이탈 등) */
  | 'cancelled'
  /** 재배정 한도 소진 → §9.3 대안 */
  | 'alternative'
  /** 설정·형태 오류·중복 요청 — **요청이 반영되지 않았고 원장은 입력 그대로다** */
  | 'refused';

export interface OfferStep {
  code: OfferStepCode;
  /** 반영된 원장. `refused` 면 입력 원장이 그대로 돌아온다. */
  ledger: OfferLedger;
  /** 지금 열려 있는(또는 방금 종결된) 오퍼 */
  offer?: AssignmentOffer;
  /** 소진 수렴 결과. `placementAfterExhausted` 가 만든 것 그대로다. */
  placement?: AlternativePlacement;
  /** 이 상호작용의 누적 오퍼 횟수(원장에서 센 값) */
  attempt?: number;
  /** 후보에서 제외된 상담사와 사유. 조용히 줄이지 않는다. */
  skipped: readonly string[];
  /** 거절 사유(설정·형태 오류). 마스킹 경유. */
  issues: readonly string[];
  warnings: readonly string[];
  reasonKo: string;
}

function mask(text: string): string {
  return maskPii(text).text;
}

const OPEN: AssignmentOffer['state'] = 'offered';

function isOpen(o: AssignmentOffer): boolean {
  return o.state === OPEN;
}

/** 정책 검증. 없는 값을 추정하지 않는다 — 0ms 는 모든 오퍼를 즉시 만료시킨다(§13-3). */
function policyIssues(policy: OfferPolicy): string[] {
  const out: string[] = [];
  const timeoutMs = policy?.timeoutMs;
  const maxAttempts = policy?.maxAttempts;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0) {
    out.push(`오퍼 응답 한도(timeoutMs)는 양수 정수여야 한다: ${String(timeoutMs)}`);
  }
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1) {
    out.push(`재배정 한도(maxAttempts)는 1 이상의 정수여야 한다: ${String(maxAttempts)}`);
  }
  return out;
}

/**
 * 원장 격리 검사. **조용히 걸러 내지 않고 거절한다** — 남의 테넌트 오퍼가 섞인 원장을 그냥
 * 필터링하면 "상담사가 바쁜가"(라)를 세는 모집단이 호출자마다 달라지고, 더 나쁘게는 남의
 * 테넌트 오퍼를 이 테넌트의 요청으로 전이시킬 수 있다(§11.1).
 */
function ledgerIssues(ledger: OfferLedger, scope: TenantScope): string[] {
  if (!Array.isArray(ledger?.offers)) return ['오퍼 원장이 배열이 아니다'];
  const foreign = ledger.offers.filter((o) => o?.tenantId !== scope.tenantId);
  return foreign.length > 0
    ? [`다른 테넌트의 오퍼가 섞인 원장이다: ${foreign.length}건 (설계서 §11.1)`]
    : [];
}

function refused(ledger: OfferLedger, issues: readonly string[], reasonKo: string): OfferStep {
  return {
    code: 'refused',
    ledger,
    skipped: [],
    issues: issues.map(mask),
    warnings: [],
    reasonKo: mask(reasonKo),
  };
}

function offersOf(ledger: OfferLedger, interactionId: string): AssignmentOffer[] {
  return ledger.offers.filter((o) => o.interactionId === interactionId);
}

function replaceOffer(ledger: OfferLedger, next: AssignmentOffer): OfferLedger {
  return { offers: ledger.offers.map((o) => (o.offerId === next.offerId ? next : o)) };
}

/**
 * 후보 선별. **고르는 정책이 아니라 고르면 안 되는 후보를 제외하는 규칙**이다.
 * 선언된 순서를 바꾸지 않는다 — 정렬을 넣는 순간 그것이 배분 정책이 된다(§13-3).
 */
function pickAgent(
  ledger: OfferLedger,
  interactionId: string,
  candidates: readonly string[],
  allowReoffer: boolean,
  skipped: string[],
): string | undefined {
  const busy = new Set(
    ledger.offers.filter((o) => isOpen(o) && o.interactionId !== interactionId).map((o) => o.agentId),
  );
  const already = new Set(offersOf(ledger, interactionId).map((o) => o.agentId));

  for (const agentId of candidates) {
    if (busy.has(agentId)) {
      skipped.push(`${mask(agentId)}: 다른 상호작용의 오퍼가 열려 있다`);
      continue;
    }
    if (!allowReoffer && already.has(agentId)) {
      skipped.push(`${mask(agentId)}: 이 상호작용에서 이미 제안받았다(allowReoffer 미선언)`);
      continue;
    }
    return agentId;
  }
  return undefined;
}

/**
 * 후보 목록 형태 검증.
 * **중복 선언을 거절하는 이유**: 같은 사람이 두 번 적힌 명부는 호스트의 조회가 틀린 것이고,
 * 그대로 두면 `allowReoffer` 를 켠 테넌트에서 한 사람에게 한도 전부가 돌아간다(마).
 * **개인정보 형태의 상담사 id 를 거절하는 이유**: 원장·결과에 그대로 남는 값이므로
 * 이메일·전화번호를 id 로 쓰면 그 자체가 저장이다(§10.3 — `retentionInventory` 와 같은 규칙).
 */
function candidateIssues(candidates: readonly string[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(candidates)) return ['후보 상담사 목록이 배열이 아니다'];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (typeof id !== 'string' || id.length === 0) {
      out.push('후보 상담사 id 가 빈 값이다');
      continue;
    }
    if (seen.has(id)) out.push(`후보 상담사 목록에 중복이 있다: ${mask(id)}`);
    seen.add(id);
    if (maskPii(id).masked) {
      // 원문은 적지 않는다 — 차단한 값을 결과에 담으면 차단이 무의미해진다.
      out.push('상담사 id 에 개인정보 패턴이 있다 — 식별자로 쓸 수 없다 (설계서 §10.3)');
    }
  }
  return out;
}

export interface OpenOfferParams {
  scope: TenantScope;
  /** `executeHandoff` 가 확정한 목적지(`QueuedPlacement.queueId`)를 그대로 넘긴다. */
  queueId: string;
  interactionId: string;
  /** 제안 후보. 순서는 호스트 선언 그대로 쓴다. */
  candidates: readonly string[];
  /** 이 오퍼의 id. 생성기는 호스트가 가진다(Core 는 id 를 만들지 않는다). */
  offerId: string;
  nowIso: string;
  /** 소진 수렴에 함께 넘길 **이미 마스킹된** 요약(§2·§10.3). 다시 마스킹하지 않는다. */
  summaryMasked?: string;
}

/**
 * 오퍼를 연다. 순서가 곧 안전장치다:
 * **격리 → 정책·후보 검증 → 중복 오퍼 차단 → 한도 판정 → 후보 선별 → 오퍼 생성**.
 * 오퍼 레코드는 **마지막에** 만들어지므로 어느 단계에서 걸려도 "열린 오퍼"가 생기지 않는다.
 */
export function openOffer(
  cfg: RoutingConfig,
  ledger: OfferLedger,
  policy: OfferPolicy,
  p: OpenOfferParams,
): OfferStep {
  assertTenantScope(p.scope);
  assertRoutingScope(cfg, p.scope);

  const issues = [
    ...policyIssues(policy),
    ...ledgerIssues(ledger, p.scope),
    ...candidateIssues(p.candidates ?? []),
  ];
  if (!isRoutingInstant(p.nowIso)) {
    issues.push(`시간대가 명시된 ISO-8601 시각이 아니다: ${JSON.stringify(p.nowIso)}`);
  }
  if (typeof p.offerId !== 'string' || p.offerId.length === 0) {
    issues.push('오퍼 id 가 비어 있다 — 응답을 상관지을 수 없다');
  }
  if (typeof p.interactionId !== 'string' || p.interactionId.length === 0) {
    issues.push('상호작용 id 가 비어 있다');
  }
  if (issues.length > 0) {
    return refused(ledger, issues, '오퍼를 열 수 없다 — 선언을 확인하라');
  }
  if (ledger.offers.some((o) => o.offerId === p.offerId)) {
    // (아) 같은 id 로 다시 열면 살아 있는 오퍼를 덮어쓰고 attempt 가 되감긴다.
    return refused(ledger, [`이미 쓰인 오퍼 id 다: ${mask(p.offerId)}`], '중복 오퍼 id');
  }

  const mine = offersOf(ledger, p.interactionId);
  const open = mine.find(isOpen);
  if (open) {
    // (다) 두 상담사가 같은 콜을 받는 길을 입구에서 막는다.
    return refused(
      ledger,
      [`이 상호작용에 이미 열린 오퍼가 있다: ${mask(open.offerId)}(${mask(open.agentId)})`],
      '열린 오퍼가 있다 — 먼저 종결하라',
    );
  }
  if (mine.some((o) => o.state === 'accepted')) {
    return refused(ledger, ['이미 배정된 상호작용이다'], '배정 완료 — 새 오퍼를 열지 않는다');
  }

  const warnings: string[] = [];
  if (!cfg.queues.some((q) => q.id === p.queueId)) {
    // 오탈자 하나가 "거절"로만 보이지 않게, 모르는 큐였다는 사실을 남긴다.
    warnings.push(`설정에 없는 큐의 오퍼다: ${mask(p.queueId)}`);
  }

  // (가) attempt 는 **원장에서 센다**. 호스트가 선언할 자리를 두지 않는다.
  const attempt = mine.length + 1;
  if (attempt > policy.maxAttempts) {
    // (나) 소진은 같은 호출에서 §9.3 대안으로 수렴한다 — 호출자가 빠뜨릴 수 없다.
    return {
      code: 'alternative',
      ledger,
      attempt: mine.length,
      placement: placementAfterExhausted(cfg, {
        scope: p.scope,
        queueId: p.queueId,
        ...(p.summaryMasked !== undefined ? { summaryMasked: p.summaryMasked } : {}),
        reasonKo: `재배정 한도 소진(${mine.length}/${policy.maxAttempts})`,
      }),
      skipped: [],
      issues: [],
      warnings,
      reasonKo: `재배정 한도 ${policy.maxAttempts}회를 모두 썼다 — 대안으로 넘긴다`,
    };
  }

  const skipped: string[] = [];
  const agentId = pickAgent(ledger, p.interactionId, p.candidates, policy.allowReoffer === true, skipped);
  if (agentId === undefined) {
    // **대안으로 보내지 않는다.** 상담사 부재는 한도 소진이 아니고, 고객은 큐에서 기다리면 된다.
    return {
      code: 'waiting',
      ledger,
      attempt: mine.length,
      skipped,
      issues: [],
      warnings: [
        ...warnings,
        '제안할 상담사가 없어 큐에 그대로 둔다 — 재배정 한도 소진이 아니다 (설계서 §9.3)',
      ],
      reasonKo: '제안 가능한 상담사가 없다',
    };
  }

  const offer = offerAssignment({
    scope: p.scope,
    offerId: p.offerId,
    queueId: p.queueId,
    interactionId: p.interactionId,
    agentId,
    offeredAt: p.nowIso,
    timeoutMs: policy.timeoutMs,
    attempt,
  });

  return {
    code: 'offered',
    ledger: { offers: [...ledger.offers, offer] },
    offer,
    attempt,
    skipped,
    issues: [],
    warnings,
    reasonKo: `배정 제안 ${attempt}/${policy.maxAttempts}`,
  };
}

export interface SettleOfferParams {
  scope: TenantScope;
  offerId: string;
  event: OfferEvent;
  nowIso: string;
  /**
   * 다음 제안 후보. 주면 재배정이 **같은 호출에서** 이어진다.
   * 주지 않으면 `requeue` 로 돌려주고, 다음 오퍼를 열어야 한다는 사실을 경고로 남긴다.
   */
  candidates?: readonly string[];
  /** 재배정 시 새 오퍼의 id. Core 는 id 를 만들지 않는다. */
  nextOfferId?: string;
  /** 소진 수렴에 함께 넘길 **이미 마스킹된** 요약(§2·§10.3). */
  summaryMasked?: string;
}

/**
 * 오퍼 이벤트 반영 → (필요하면) 다음 제안 또는 §9.3 대안까지.
 *
 * 전이 판정은 `applyOfferEvent` 하나다(§2) — 여기서 상태표를 다시 쓰지 않는다.
 * 이 함수가 더 하는 일은 셋이다: **종결된 오퍼의 중복 이벤트를 `waiting` 과 갈라 적고**(사),
 * **재배정을 다음 후보로 이어 주고**(가·마), **소진을 대안으로 수렴시킨다**(나).
 */
export function settleOffer(
  cfg: RoutingConfig,
  ledger: OfferLedger,
  policy: OfferPolicy,
  p: SettleOfferParams,
): OfferStep {
  assertTenantScope(p.scope);
  assertRoutingScope(cfg, p.scope);

  const issues = [...policyIssues(policy), ...ledgerIssues(ledger, p.scope)];
  if (!isRoutingInstant(p.nowIso)) {
    issues.push(`시간대가 명시된 ISO-8601 시각이 아니다: ${JSON.stringify(p.nowIso)}`);
  }
  if (p.candidates !== undefined) issues.push(...candidateIssues(p.candidates));
  if (issues.length > 0) return refused(ledger, issues, '오퍼 이벤트를 반영할 수 없다');

  const offer = ledger.offers.find((o) => o.offerId === p.offerId);
  if (!offer) {
    return refused(ledger, [`원장에 없는 오퍼 id 다: ${mask(String(p.offerId))}`], '모르는 오퍼');
  }
  if (!isOpen(offer)) {
    // (사) `applyOfferEvent` 는 규약대로 `waiting` 을 돌려주지만, 그것을 "응답 대기 중"으로 읽으면
    //      이미 배정된 통화가 영원히 대기로 보인다. 중복 요청임을 분명히 적는다.
    return refused(
      ledger,
      [`이미 종결된 오퍼다(${offer.state}) — 중복 이벤트인지 확인하라`],
      `종결된 오퍼: ${offer.state}`,
    );
  }

  const outcome = applyOfferEvent(offer, p.event, p.nowIso, policy.maxAttempts);
  const nextLedger = replaceOffer(ledger, outcome.offer);
  const warnings: string[] = [];
  const attempt = offersOf(nextLedger, offer.interactionId).length;

  if (outcome.next === 'assigned') {
    return {
      code: 'assigned',
      ledger: nextLedger,
      offer: outcome.offer,
      attempt,
      skipped: [],
      issues: [],
      warnings,
      reasonKo: mask(outcome.reasonKo),
    };
  }
  if (outcome.next === 'cancelled') {
    return {
      code: 'cancelled',
      ledger: nextLedger,
      offer: outcome.offer,
      attempt,
      skipped: [],
      issues: [],
      warnings,
      reasonKo: mask(outcome.reasonKo),
    };
  }
  if (outcome.next === 'waiting') {
    // 만료 전 tick — 상태가 바뀌지 않았다. 원장도 그대로다.
    return {
      code: 'waiting',
      ledger: nextLedger,
      offer: outcome.offer,
      attempt,
      skipped: [],
      issues: [],
      warnings,
      reasonKo: mask(outcome.reasonKo),
    };
  }
  if (outcome.next === 'exhausted') {
    return {
      code: 'alternative',
      ledger: nextLedger,
      offer: outcome.offer,
      attempt,
      placement: placementAfterExhausted(cfg, {
        scope: p.scope,
        queueId: offer.queueId,
        ...(p.summaryMasked !== undefined ? { summaryMasked: p.summaryMasked } : {}),
        reasonKo: outcome.reasonKo,
      }),
      skipped: [],
      issues: [],
      warnings,
      reasonKo: mask(outcome.reasonKo),
    };
  }

  // requeue — 다음 후보로 이어 준다. 후보·id 가 없으면 **이어 주지 못했다는 사실**을 남긴다.
  if (p.candidates === undefined || p.nextOfferId === undefined) {
    warnings.push(
      '재배정이 필요하지만 다음 후보·오퍼 id 가 없다 — 다음 오퍼를 열지 않으면 고객은 큐에 묶인다',
    );
    return {
      code: 'requeue',
      ledger: nextLedger,
      offer: outcome.offer,
      attempt,
      skipped: [],
      issues: [],
      warnings,
      reasonKo: mask(outcome.reasonKo),
    };
  }

  const next = openOffer(cfg, nextLedger, policy, {
    scope: p.scope,
    queueId: offer.queueId,
    interactionId: offer.interactionId,
    candidates: p.candidates,
    offerId: p.nextOfferId,
    nowIso: p.nowIso,
    ...(p.summaryMasked !== undefined ? { summaryMasked: p.summaryMasked } : {}),
  });
  if (next.code === 'refused') {
    // **이어 주기가 실패했다고 이미 반영한 전이를 되돌리지 않는다.** `refused` 로 돌려주면
    // 호출자는 "아무 일도 없었다"로 읽고 거절·무응답 사실이 사라진다 — 그러면 (가)가
    // 되살아난다(한도가 깎이지 않은 채 같은 attempt 로 다시 돌아간다).
    // 전이는 반영된 그대로 두고, 이어 주지 못한 **이유**를 `requeue` 에 실어 보낸다.
    return {
      code: 'requeue',
      ledger: nextLedger,
      offer: outcome.offer,
      attempt,
      skipped: next.skipped,
      issues: next.issues,
      warnings: [
        ...warnings,
        ...next.warnings,
        '다음 오퍼를 열지 못했다 — 사유를 해소한 뒤 openOffer 를 다시 불러야 고객이 큐에서 풀린다',
      ],
      reasonKo: mask(`${outcome.reasonKo} · 다음 제안 실패`),
    };
  }
  return {
    ...next,
    warnings: [...warnings, ...next.warnings],
    reasonKo: mask(`${outcome.reasonKo} · ${next.reasonKo}`),
  };
}

/**
 * 만료된(응답 한도를 넘긴) 열린 오퍼 목록.
 *
 * **타이머를 Core 가 돌리지 않는다** — 호스트가 이 목록을 받아 건마다 `settleOffer(…, 'tick')`
 * 을 부른다(`ops/recoveryProbe.ts` 의 `runDue` 와 같은 이유: 몰래 켠 인터벌은 끌 수도 없고
 * 프로세스 종료를 막는다). 목록으로 드러내는 것이 (바)를 막는 유일한 방법이다 —
 * 호스트가 tick 을 아예 안 돌리면 만료분이 **쌓여서 보인다**.
 *
 * 시각 형태가 틀리면 **빈 목록이 아니라 던진다** — 빈 목록은 "만료된 오퍼가 없다"로 읽힌다.
 */
export function expiredOffers(
  ledger: OfferLedger,
  scope: TenantScope,
  nowIso: string,
): readonly AssignmentOffer[] {
  assertTenantScope(scope);
  if (!isRoutingInstant(nowIso)) {
    throw new Error(`시간대가 명시된 ISO-8601 시각이 아니다: ${JSON.stringify(nowIso)} (설계서 §13-3)`);
  }
  const nowMs = Date.parse(nowIso);
  return ledger.offers.filter((o) => {
    if (o.tenantId !== scope.tenantId) return false;   // 조회는 자기 테넌트만(§11.1)
    if (!isOpen(o)) return false;
    const offeredMs = Date.parse(o.offeredAt);
    if (Number.isNaN(offeredMs)) return false;         // 형태 오류는 만료로 적지 않는다
    return nowMs - offeredMs >= o.timeoutMs;
  });
}

/** 지금 이 상호작용에 열려 있는 오퍼. 없으면 undefined — "아마 없을 것"을 만들지 않는다. */
export function openOfferOf(
  ledger: OfferLedger,
  scope: TenantScope,
  interactionId: string,
): AssignmentOffer | undefined {
  assertTenantScope(scope);
  return ledger.offers.find(
    (o) => o.tenantId === scope.tenantId && o.interactionId === interactionId && isOpen(o),
  );
}
