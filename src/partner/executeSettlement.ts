// 파트너 정산 실행기 — 설계서 §11.2(과금 근거)·§11.1(테넌트 격리)·§10.3(마스킹)·§13-3(실측만)·§7 7.6.
//
// `attribution.ts` 가 정산의 **분모**(파트너별 고객사)를 만들고 `settlementExport.ts` 가 반출을
// 좁힌다. 그런데 그 사이, **실적(`billedByPartner`)을 만드는 자리가 저장소 어디에도 없었다** —
// `rollupByPartner`·`buildSettlementLines`·`settlementBlockers` 를 부르는 곳은 테스트뿐이고,
// 그 입력에는 "호출자가 usage/billing 에서 실측으로 가져온다"는 주석만 남아 있었다.
// 즉 원장 → 청구 수량까지 길이 열린 뒤에도 **파트너 수수료는 한 번도 산출된 적이 없다**.
//
// 그대로 두면 호스트가 손으로 꿰게 되는데, 그 30줄에서 빠지는 것은 정해져 있고 **여덟 개 다
// 장애로 보이지 않는다**. 전부 금액이 틀린 표가 조용히 나가는 쪽으로 틀린다 —
// 정산 사고는 예외가 아니라 **그럴듯한 숫자**의 모양으로 온다.
//
//  (가) **대사 판정이 정산에 닿지 않는다.** `settlementBlockers` 의 입력은 귀속 이력뿐이라
//       유입 미확정·귀속 충돌만 본다. §11.2 대사가 과다청구 방향으로 `blocked` 를 적어 청구를
//       막은 달에도 정산 표는 막히지 않고, 그 달의 수수료가 지급 근거로 나간다. 청구는 보류됐는데
//       수수료는 지급된 것이고, 되돌리려면 파트너에게서 받아와야 한다.
//  (나) **대사를 돌리지 않은 것을 청구 가능으로 읽는다.** `billing/executeUsage.ts` 머리말 (1)과
//       같은 자리다 — 명세를 아직 못 받은 달은 "차이 없음"이 아니라 **대사 미실시**다.
//       판정이 없으면 금액을 만들지 않는다.
//  (다) **거절(refused)이 "실적 없음"으로 적힌다.** 반올림 규칙 결함으로 집계가 거절되면
//       `totals` 가 없고, 호스트가 옵셔널 체인으로 뽑으면 키가 빠져 정산 줄에는 "실측 청구액이
//       없어 금액을 산출하지 않았습니다"가 적힌다. **설정 오류가 실적 0 으로 둔갑**하고, 같은
//       표의 다른 줄은 그대로 반출된다.
//  (라) **accountId 와 tenantId 를 같은 것으로 본다.** 귀속은 고객사(계약 단위), 과금 원장은
//       테넌트다. 한 고객사가 테넌트 여럿(본사·지사·시험)을 쓰는데 하나만 선언하면 코드가 아무
//       말도 하지 않고 **실적이 작게 나온다** — 작게 나온 정산은 장애가 아니라 몇 달 뒤 분쟁으로
//       나타난다. 반대로 같은 테넌트를 두 고객사가 선언하면 **이중 계상**이고 이쪽은 과다지급이다.
//  (마) **부분 합계를 그 파트너의 실적으로 적는다.** 고객사 셋 중 둘만 근거가 확정됐을 때 둘을
//       더하면 표에는 그럴듯한 숫자가 적히고 받는 쪽은 그것을 실적으로 읽는다. 그래서
//       **한 고객사라도 근거가 확정되지 않으면 그 파트너의 금액을 만들지 않는다** —
//       0 과 "모른다"를 같게 적지 않는 것과 같은 규칙이다(§13-3).
//  (바) **귀속이 없는 고객사의 실적이 사라진다.** `rollupByPartner` 는 이력에 있는 고객사만 센다.
//       실적만 있고 귀속 기록이 없으면 그 금액은 어느 줄에도 들어가지 않고 합계만 작아진다 —
//       0 으로 적히지도 않아 눈에 띄지 않는다.
//  (사) **충돌을 테넌트 밖에서 센다.** `findAttributionConflicts` 는 테넌트로 거르지 않는다.
//       전체 이력을 그대로 넘기면 **남의 테넌트 충돌이 이 테넌트의 정산을 막고**(§11.1), 반대로
//       행(`rows`)은 걸러져 있어 두 입력의 모집단이 달라진다. 여기서는 양쪽을 같은
//       스코프 이력에서 만든다.
//  (아) **요율을 퍼센트로 넣는다.** `commissionRate` 는 0~1 인데 `15` 를 넣으면 수수료가 실적의
//       15배로 산출되고, 그 값은 예외가 아니라 **숫자**로 CSV 에 실린다. 형태를 먼저 거절한다.
//
// 그리고 **(자) `blockers` 를 넘기지 않으면 반출이 막히지 않는다** — `exportSettlement` 의
// `blockers` 는 옵셔널이므로 지금까지 그 안전장치는 호출자의 성실성에 달려 있었다.
// `runSettlementExport` 가 판정 결과를 그대로 꿰어 호출자가 뺄 수 없게 한다.
//
// 이 파일이 **하지 않는** 것:
//  - **금액을 만들지 않는다.** 단가·청구서 생성은 범위 밖이다(§11.2 — Core 는 수량만 책임진다).
//    고객사별 실측 청구액은 호스트가 선언하고, 이 파일은 **그 금액이 청구 가능한 수량 근거 위에
//    있는지만** 본다. 수량을 금액 칸으로 옮겨 적지 않는다 — `voice_units` 를 금액으로 넣으면
//    자릿수가 그럴듯해서 아무도 눈치채지 못한다.
//  - **판정을 복사하지 않는다(§2).** 수량은 `aggregateUsage`, 청구 가능 여부는
//    `runReconciliationScenario`, 파트너 묶기는 `rollupByPartner`, 줄 만들기는
//    `buildSettlementLines`, 반출 판정은 `exportSettlement` 하나다. 허용오차 비교도 수수료
//    계산식도 이 파일에 없다.
//  - **거절했으면 줄을 만들지 않는다.** 순서가 곧 안전장치다(격리 → 선언 검증 → 귀속 묶기 →
//    근거 판정 → 금액 접기 → 줄 생성). 표를 마지막에 만들기 때문에 어느 단계에서 걸려도
//    **청구·지급에 붙일 수 있는 표가 생기지 않는다**(`executeUsage`·`settlementExport` 와 같은 규칙).
//  - **시계를 만들지 않는다.** 기간 표기·반출 시각은 전부 주입이다(§13-3).
//  - **저장·전송·송금을 하지 않는다.** 결과는 표와 감사 체인뿐이며 실제 정산은 **[승인 필요]**.
import type { AuditChain, Hasher } from '../audit/log.ts';
import type { ReconciliationRunResult, UsageRunResult } from '../billing/executeUsage.ts';
import { maskPii } from '../core/policyGuard.ts';
import { assertTenantScope, isValidId, type TenantScope } from '../core/tenancy.ts';
import {
  buildSettlementLines, currentAttribution, findAttributionConflicts, rollupByPartner,
  settlementBlockers, visibleToPartner,
  type AttributionConflict, type AttributionRecord, type PartnerRollupRow, type SettlementLine,
} from './attribution.ts';
import type { PartnerActor } from './rbac.ts';
import {
  exportSettlement,
  type SettlementExportFormat, type SettlementExportOptions, type SettlementExportResult,
} from './settlementExport.ts';

export const SETTLEMENT_RUN_CONTRACT_VERSION = 1;

/** 고객사 한 곳의 **수량 근거 상태**. 금액을 쓸 수 있는지는 이 값 하나로 결정된다. */
export type AccountBasisStatus =
  | 'billable'        // 집계·대사가 끝났고 청구 가능하며 실측 청구액 선언이 있다
  | 'no_amount'       // 근거는 멀쩡하지만 실측 청구액 선언이 없다(금액을 만들지 않는다)
  | 'not_reconciled'  // 대사를 돌리지 않았거나 거절돼 **판정이 없다** — 차단과 다르다
  | 'billing_blocked' // 대사가 과다청구 방향으로 청구를 막았다
  | 'no_quantities'   // 집계가 거절됐거나 투영 범위에 근거가 없었다
  | 'unattributed';   // 귀속 기록이 없다 — 이 실적이 어느 파트너 것인지 알 수 없다

/**
 * 고객사 한 곳의 정산 입력.
 *
 * `usage`·`reconciliation` 은 `billing/executeUsage.ts` 결과를 **그대로** 넣는다. 숫자만 뽑아
 * 넘기면 거절·차단 사유가 같이 떨어져 나가고, 그게 바로 위 (다)·(가) 의 경로다.
 */
export interface AccountBillingInput {
  /** 귀속 이력의 고객사 식별자(계약 단위). */
  accountId: string;
  /** 그 고객사의 과금 테넌트. 귀속과 원장은 서로 다른 축이므로 Core 가 추측하지 않는다(위 (라)). */
  tenantId: string;
  /** `runUsageAggregation` 결과 그대로. */
  usage: UsageRunResult;
  /** `runReconciliation` 결과 그대로. 없으면 **대사 미실시**다(위 (나)). */
  reconciliation?: ReconciliationRunResult;
  /**
   * 실측 청구액. 단가·청구서는 범위 밖이므로 호스트가 선언한다(§11.2).
   * 선언이 없으면 금액을 만들지 않는다 — 수량으로 대신 채우지 않는다.
   */
  billedAmount?: number;
}

/** 고객사별 근거 판정. 화면이 "왜 이 파트너 금액이 비었는지"를 그대로 보여 줄 수 있다. */
export interface AccountBasis {
  accountId: string;
  tenantId: string;
  /** 귀속에서 온 값. `null` 은 직접 계약, 없으면 귀속 기록 자체가 없다. */
  partnerId?: string | null;
  status: AccountBasisStatus;
  /** 정산에 반영한 금액. `status === 'billable'` 일 때만 있다. */
  billedAmount?: number;
  reasonKo?: string;
}

export interface SettlementRunParams {
  /** 정산 집계 주체의 스코프. 귀속 이력·행·충돌을 모두 이 스코프에서 만든다(§11.1). */
  scope: TenantScope;
  /** 추가 전용 귀속 이력. 스코프 밖 기록은 이 파일이 걸러낸다(위 (사)). */
  history: readonly AttributionRecord[];
  /** 고객사별 실적 선언. 비어 있으면 금액 없는 근거 표만 나온다. */
  accounts?: readonly AccountBillingInput[];
  /** 파트너별 계약 수수료율(0~1). 계약 문서에서 오며 기본값을 만들지 않는다(§13-3). */
  ratesByPartner?: Record<string, number>;
}

export type SettlementRunStatus =
  | 'refused'   // 선언이 어긋나 어느 줄도 믿을 수 없다 — 줄을 만들지 않았다
  | 'empty'     // 스코프 안에 귀속된 고객사가 없다
  | 'blocked'   // 줄은 만들었으나 반출을 막는다(근거 미확정·대사 차단)
  | 'ready';    // 반출 가능 — 그래도 실제 지급은 [승인 필요]

export interface SettlementRunResult {
  status: SettlementRunStatus;
  /** 화면·로그에 그대로 쓸 한 줄. */
  messageKo: string;
  /** 줄을 만들지 않은 이유. 비어 있지 않으면 `lines` 가 없다. */
  refusalsKo: string[];
  /** 반출을 막는 사유. `runSettlementExport` 가 그대로 넘긴다(위 (자)). */
  blockersKo: string[];
  /** 막지는 않지만 숨기면 안 되는 사실. */
  warningsKo: string[];
  /** 이 파일이 검사하지 못하는 범위. 감춘 채 "통과"로 적지 않는다(§13-3). */
  limitsKo: string[];
  accounts: AccountBasis[];
  rows?: PartnerRollupRow[];
  lines?: SettlementLine[];
  /** 스코프 안에서 본 귀속 충돌. 하나라도 있으면 `settlementBlockers` 가 막는다. */
  conflicts: AttributionConflict[];
  /** 정산에 반영한 파트너별 실적. 금액을 만들지 않은 파트너는 **키가 없다**(위 (마)). */
  billedByPartner: Record<string, number>;
}

// ── 선언 검증 ────────────────────────────────────────────────────────────────

/** 값을 되싣을 때 한 번 지운다 — 선언이 잘못됐다는 것은 값이 무엇이든 올 수 있다는 뜻이다(§10.3). */
function shown(value: unknown): string {
  // JSON.stringify 는 undefined·함수에서 undefined 를 돌려준다 — 그걸 그대로 maskPii 에 넘기면
  // "값이 이상해서" 나는 거절이 **거절문을 만드는 중에** 예외로 바뀐다.
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  return maskPii(typeof encoded === 'string' ? encoded : String(value)).text;
}

function accountRefusalsKo(accounts: readonly AccountBillingInput[]): string[] {
  const out: string[] = [];
  const byAccount = new Map<string, number>();
  const byTenant = new Map<string, string[]>();

  for (const a of accounts) {
    if (a === null || typeof a !== 'object') {
      out.push('고객사 실적 선언에 객체가 아닌 값이 있습니다 (설계서 §11.2)');
      continue;
    }
    if (typeof a.accountId !== 'string' || !isValidId(a.accountId)) {
      out.push(`고객사 식별자 형식이 올바르지 않습니다: ${shown(a.accountId)} (설계서 §11.1)`);
      continue;
    }
    if (typeof a.tenantId !== 'string' || !isValidId(a.tenantId)) {
      out.push(
        `고객사 ${a.accountId} 의 과금 테넌트 선언이 올바르지 않습니다: ${shown(a.tenantId)} — ` +
        '귀속(고객사)과 원장(테넌트)은 서로 다른 축이므로 Core 가 추측하지 않습니다 (설계서 §11.1)',
      );
      continue;
    }

    byAccount.set(a.accountId, (byAccount.get(a.accountId) ?? 0) + 1);
    const tenants = byTenant.get(a.tenantId) ?? [];
    tenants.push(a.accountId);
    byTenant.set(a.tenantId, tenants);

    if (a.usage === null || typeof a.usage !== 'object' || typeof a.usage.status !== 'string') {
      out.push(
        `고객사 ${a.accountId} 의 과금 집계 결과가 선언되지 않았습니다 — ` +
        'runUsageAggregation 결과를 그대로 넘기세요(숫자만 뽑으면 거절 사유가 같이 떨어져 나갑니다, 설계서 §11.2)',
      );
    }
    if (a.billedAmount !== undefined) {
      if (typeof a.billedAmount !== 'number' || !Number.isFinite(a.billedAmount) || a.billedAmount < 0) {
        out.push(
          `고객사 ${a.accountId} 의 실측 청구액이 0 이상의 유한수여야 합니다: ${shown(a.billedAmount)} — ` +
          'NaN·음수는 합계를 조용히 무너뜨리고 수수료까지 함께 틀립니다 (설계서 §13-3)',
        );
      }
    }

    // §11.1 — 선언한 테넌트와 실제 집계·대사의 테넌트가 다르면 남의 실적을 정산에 올리는 길이 열린다.
    const aggTenant = a.usage?.aggregate?.tenantId;
    if (typeof aggTenant === 'string' && aggTenant !== a.tenantId) {
      out.push(
        `고객사 ${a.accountId} 의 선언 테넌트(${a.tenantId})와 과금 집계 테넌트(${aggTenant})가 다릅니다 (설계서 §11.1)`,
      );
    }
    const recTenant = a.reconciliation?.scenario?.tenantId;
    if (typeof recTenant === 'string' && recTenant !== a.tenantId) {
      out.push(
        `고객사 ${a.accountId} 의 선언 테넌트(${a.tenantId})와 대사 테넌트(${recTenant})가 다릅니다 (설계서 §11.1)`,
      );
    }
  }

  for (const [accountId, n] of byAccount) {
    if (n > 1) {
      out.push(
        `고객사 ${accountId} 의 실적이 ${n}번 선언됐습니다 — 어느 선언이 쓰일지 입력 순서로 결정되므로 ` +
        '고르지 않고 거절합니다 (설계서 §11.2)',
      );
    }
  }
  for (const [tenantId, accountIds] of byTenant) {
    const distinct = [...new Set(accountIds)];
    if (distinct.length > 1) {
      out.push(
        `과금 테넌트 ${tenantId} 를 고객사 ${distinct.join('·')} 가 함께 선언했습니다 — ` +
        '같은 원장을 두 번 세는 이중 계상이고, 이쪽 방향의 오류는 과다지급이 됩니다 (설계서 §11.2)',
      );
    }
  }
  return out.sort();
}

/** 요율 형태. 0~1 밖의 값은 수수료를 몇 배로 부풀리고, 그 결과는 예외가 아니라 숫자로 나간다. */
function rateRefusalsKo(rates: Record<string, number> | undefined): string[] {
  if (rates === undefined) return [];
  if (rates === null || typeof rates !== 'object') {
    return ['파트너 수수료율 선언이 객체가 아닙니다 (설계서 §13-3)'];
  }
  const out: string[] = [];
  for (const [partnerId, rate] of Object.entries(rates)) {
    if (!isValidId(partnerId)) {
      out.push(`수수료율의 파트너 식별자 형식이 올바르지 않습니다: ${shown(partnerId)} (설계서 §11.1)`);
      continue;
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      out.push(
        `파트너 ${partnerId} 의 수수료율이 0~1 이어야 합니다: ${shown(rate)} — ` +
        '퍼센트 값을 그대로 넣으면 수수료가 실적의 몇 배로 산출되고 그 값은 예외 없이 표에 실립니다 (설계서 §13-3)',
      );
    }
  }
  return out.sort();
}

// ── 근거 판정 ────────────────────────────────────────────────────────────────

interface BasisVerdict {
  status: AccountBasisStatus;
  reasonKo?: string;
}

/**
 * 고객사 한 곳의 수량 근거를 판정한다. **판정을 새로 만들지 않는다** —
 * 집계·대사가 이미 적어 둔 상태를 "금액을 써도 되는가" 하나로 접는 것뿐이다(§2).
 */
function decideBasis(a: AccountBillingInput, attributed: boolean): BasisVerdict {
  if (!attributed) {
    return {
      status: 'unattributed',
      reasonKo:
        `고객사 ${a.accountId} 의 귀속 기록이 없습니다 — 이 실적은 어느 파트너 줄에도 들어가지 않고 ` +
        '합계만 작아집니다(0 으로도 적히지 않습니다). 귀속을 먼저 등록하세요 (설계서 §11.2)',
    };
  }
  if (a.usage.status !== 'aggregated') {
    const why = a.usage.status === 'refused'
      ? `집계를 거절했습니다: ${a.usage.refusalsKo.join(' / ')}`
      : '투영 범위에 근거가 없었습니다("사용량 0"이 아닙니다)';
    return {
      status: 'no_quantities',
      reasonKo:
        `고객사 ${a.accountId} 의 과금 수량 근거가 없습니다 — ${maskPii(why).text}. ` +
        '이 상태를 "실적 0"으로 적으면 설정 오류가 실적으로 둔갑합니다 (설계서 §13-3)',
    };
  }
  const scenario = a.reconciliation?.scenario;
  if (a.reconciliation === undefined || a.reconciliation.status === 'refused' || scenario === undefined) {
    const why = a.reconciliation?.refusalsKo?.length
      ? `: ${a.reconciliation.refusalsKo.join(' / ')}`
      : ' — 외부 명세 대조를 돌리지 않았습니다';
    return {
      status: 'not_reconciled',
      reasonKo:
        `고객사 ${a.accountId} 의 과금 대사 판정이 없습니다${maskPii(why).text}. ` +
        '대사 미실시는 "차이 없음"이 아니므로 수수료 근거로 쓰지 않습니다 (설계서 §11.2)',
    };
  }
  if (scenario.verdict === 'blocked') {
    return {
      status: 'billing_blocked',
      reasonKo:
        `고객사 ${a.accountId} 의 청구가 막혀 있습니다 — ${maskPii(scenario.verdictReasonKo).text} ` +
        '청구를 보류한 구간의 수수료를 지급하면 되돌리려면 파트너에게서 받아와야 합니다 (설계서 §11.2)',
    };
  }
  if (a.billedAmount === undefined) {
    return {
      status: 'no_amount',
      reasonKo:
        `고객사 ${a.accountId} 의 실측 청구액이 선언되지 않았습니다 — 단가·청구서는 Core 범위 밖이므로 ` +
        '수량으로 금액을 대신 만들지 않습니다 (설계서 §11.2·§13-3)',
    };
  }
  return { status: 'billable' };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

const LIMITS_KO: readonly string[] = Object.freeze([
  '귀속 스코프와 고객사별 과금 테넌트의 대응은 호스트 선언을 그대로 믿습니다 — 선언이 틀렸는지는 ' +
  '관측만으로 알 방법이 없고(두 축은 서로 다른 원장에 있습니다), 이 파일은 선언들끼리의 모순만 봅니다 (설계서 §11.1)',
  '단가·청구서·송금은 범위 밖입니다 — 실측 청구액의 산출 근거(단가 × 수량)는 이 결과로 검증되지 않습니다 (설계서 §11.2)',
]);

/**
 * 귀속 이력 + 고객사별 과금 실행 결과 → 정산 근거 줄.
 *
 * 순수 함수다(시각·난수·I/O 없음). 같은 입력이면 같은 표가 나온다 — 정산은 재현되지 않으면 근거가 아니다.
 */
export function runSettlement(p: SettlementRunParams): SettlementRunResult {
  assertTenantScope(p.scope);

  const accounts = p.accounts ?? [];
  if (!Array.isArray(accounts)) {
    throw new Error('고객사 실적 선언은 배열이어야 한다 (설계서 §11.2)');
  }

  const refusalsKo = [...accountRefusalsKo(accounts), ...rateRefusalsKo(p.ratesByPartner)];
  const limitsKo = [...LIMITS_KO];

  if (refusalsKo.length > 0) {
    // 순서가 곧 안전장치다 — 거절했으면 줄도 금액도 만들지 않는다.
    return {
      status: 'refused',
      messageKo: '정산 근거를 산출하지 않았습니다 — 지급에 붙일 수 있는 표를 만들지 않았습니다.',
      refusalsKo,
      blockersKo: [],
      warningsKo: [],
      limitsKo,
      accounts: [],
      conflicts: [],
      billedByPartner: {},
    };
  }

  // (사) 행과 충돌을 **같은 스코프 이력**에서 만든다. 전체 이력을 충돌 판정에 그대로 넘기면
  //      남의 테넌트 충돌이 이 테넌트의 정산을 막는다(§11.1).
  const scopedHistory = visibleToPartner(p.history, p.scope, null);
  const rows = rollupByPartner(scopedHistory, p.scope);
  const conflicts = findAttributionConflicts(scopedHistory);

  const blockersKo: string[] = [];
  const warningsKo: string[] = [];

  // 1) 고객사별 근거 판정.
  const basisByAccount = new Map<string, AccountBasis>();
  const bases: AccountBasis[] = [];
  for (const a of accounts) {
    const attribution = currentAttribution(scopedHistory, a.accountId);
    const verdict = decideBasis(a, attribution !== undefined);
    const basis: AccountBasis = {
      accountId: a.accountId,
      tenantId: a.tenantId,
      ...(attribution !== undefined ? { partnerId: attribution.partnerId } : {}),
      status: verdict.status,
      ...(verdict.status === 'billable' && a.billedAmount !== undefined ? { billedAmount: a.billedAmount } : {}),
      ...(verdict.reasonKo !== undefined ? { reasonKo: verdict.reasonKo } : {}),
    };
    bases.push(basis);
    basisByAccount.set(a.accountId, basis);

    // 막는 것과 적어 두는 것을 가른다.
    //  - 귀속 없음·청구 차단은 **분모와 청구 자체가 흔들린 것**이므로 금액 선언과 무관하게 막는다.
    //  - 근거가 없는데 **금액이 선언됐으면** 막는다 — 쓸 수 없는 금액이 표에 실릴 뻔한 것이다.
    //  - 금액이 애초에 없으면 `buildSettlementLines` 가 빈 칸과 사유를 적는다(경고로 남긴다).
    if (verdict.status === 'unattributed' || verdict.status === 'billing_blocked') {
      blockersKo.push(verdict.reasonKo ?? `고객사 ${a.accountId} 의 정산 근거가 확정되지 않았습니다.`);
    } else if (verdict.status !== 'billable' && verdict.status !== 'no_amount' && a.billedAmount !== undefined) {
      blockersKo.push(
        `${verdict.reasonKo ?? `고객사 ${a.accountId} 의 근거가 확정되지 않았습니다.`} ` +
        '실측 청구액이 선언돼 있어 그대로 두면 근거 없는 금액이 표에 실립니다.',
      );
    } else if (verdict.reasonKo !== undefined) {
      warningsKo.push(verdict.reasonKo);
    }

    if (verdict.status === 'billable' && a.reconciliation?.scenario?.verdict === 'review_required') {
      // 과소청구 방향은 **수수료를 작게** 만든다 — 과다지급이 아니다. 여기서 정산을 멈추면
      // 매출 누락 조사와 파트너 지급이 같이 멈추므로, 막지 않고 드러낸다(reconcile.ts 와 같은 비대칭).
      warningsKo.push(
        `고객사 ${a.accountId} 의 대사가 확인 필요 상태입니다(과소청구 방향 ` +
        `${a.reconciliation.scenario.openIssues}건) — 수수료가 작게 산출될 수 있습니다. ` +
        '과다지급 방향은 아니므로 막지 않습니다 (설계서 §11.2)',
      );
    }
  }

  // 2) 선언과 귀속의 어긋남을 양방향으로 드러낸다.
  const declared = new Set(accounts.map((a) => a.accountId));
  const attributedAccounts = rows.flatMap((r) => r.accountIds);
  const undeclared = attributedAccounts.filter((id) => !declared.has(id)).sort();
  if (undeclared.length > 0) {
    warningsKo.push(
      `귀속은 있으나 실적 선언이 없는 고객사 ${undeclared.length}건(${undeclared.slice(0, 5).join('·')}) — ` +
      '그 파트너의 금액은 만들지 않습니다(부분 합계를 실적으로 적지 않습니다, 설계서 §13-3)',
    );
  }

  // 3) 파트너별 금액 접기 — **모든 고객사가 billable 일 때만** 키를 만든다(위 (마)).
  const billedByPartner: Record<string, number> = {};
  for (const row of rows) {
    if (row.partnerId === null) continue;   // 직접 계약분은 수수료 대상이 아니다
    let sum = 0;
    const incomplete: string[] = [];
    for (const accountId of row.accountIds) {
      const basis = basisByAccount.get(accountId);
      if (basis === undefined) {
        incomplete.push(`${accountId}(선언 없음)`);
        continue;
      }
      if (basis.status !== 'billable' || basis.billedAmount === undefined) {
        incomplete.push(`${accountId}(${basis.status})`);
        continue;
      }
      sum += basis.billedAmount;
    }
    if (incomplete.length > 0) {
      warningsKo.push(
        `파트너 ${row.partnerId} 의 실적을 만들지 않았습니다 — 근거가 확정되지 않은 고객사 ` +
        `${incomplete.length}건(${incomplete.slice(0, 5).join('·')}). 확정된 것만 더하면 그 부분 합계가 ` +
        '그 파트너의 실적으로 읽힙니다 (설계서 §13-3)',
      );
      continue;
    }
    billedByPartner[row.partnerId] = sum;
  }

  // 4) 귀속에서 온 차단 사유(유입 미확정·충돌)는 `settlementBlockers` 하나가 만든다(§2).
  blockersKo.push(...settlementBlockers(rows, conflicts));

  const lines = buildSettlementLines(rows, {
    billedByPartner,
    ...(p.ratesByPartner !== undefined ? { ratesByPartner: { ...p.ratesByPartner } } : {}),
  });

  const base = {
    refusalsKo,
    blockersKo,
    warningsKo,
    limitsKo,
    accounts: bases,
    rows,
    lines,
    conflicts,
    billedByPartner,
  };

  if (rows.length === 0) {
    return {
      status: 'empty',
      messageKo:
        `스코프 안에 귀속된 고객사가 없습니다(받은 귀속 기록 ${p.history.length}건 · 스코프 안 ` +
        `${scopedHistory.length}건 · 실적 선언 ${accounts.length}건). "실적 0"이 아니라 "근거가 없다"입니다 (설계서 §13-3).`,
      ...base,
    };
  }

  const priced = Object.keys(billedByPartner).length;
  if (blockersKo.length > 0) {
    return {
      status: 'blocked',
      messageKo:
        `정산 근거 ${lines.length}줄을 만들었으나 반출을 막았습니다 — 먼저 해결하세요: ` +
        `${blockersKo.length}건. (실적을 산출한 파트너 ${priced}곳)`,
      ...base,
    };
  }

  return {
    status: 'ready',
    messageKo:
      `정산 근거 ${lines.length}줄을 산출했습니다 — 고객사 ${attributedAccounts.length}곳 · ` +
      `실적을 산출한 파트너 ${priced}곳. 이 표는 청구서·지급 지시가 아닙니다 — 실제 정산은 [승인 필요].`,
    ...base,
  };
}

// ── 반출 ─────────────────────────────────────────────────────────────────────

export interface SettlementExportRunParams {
  /** `runSettlement` 결과 그대로. 줄만 뽑아 넘기면 차단 사유가 떨어져 나간다(위 (자)). */
  run: SettlementRunResult;
  scope: TenantScope;
  actor: PartnerActor;
  format: SettlementExportFormat;
  at: string;        // ISO8601 — 주입(§13-3)
  recordId: string;
  periodKo?: string;
}

/**
 * 판정 결과를 **빼먹을 수 없는 모양으로** 반출에 꿴다.
 *
 * `exportSettlement` 의 `blockers` 는 옵셔널이라 넘기지 않으면 막힌 정산도 본문이 생긴다.
 * 여기서는 차단 사유와 거절 사유를 **둘 다** 넘긴다 — 거절(줄을 만들지 못한 상태)로 반출을
 * 시도한 사실도 감사에 남아야 하므로, 조용히 빈 결과를 돌려주지 않고 차단으로 기록한다.
 */
export function runSettlementExport(
  chain: AuditChain,
  p: SettlementExportRunParams,
  hash: Hasher,
  opts: SettlementExportOptions = {},
): SettlementExportResult {
  const blockers = [...p.run.refusalsKo, ...p.run.blockersKo];
  return exportSettlement(
    chain,
    {
      scope: p.scope,
      actor: p.actor,
      format: p.format,
      lines: p.run.lines ?? [],
      blockers,
      at: p.at,
      recordId: p.recordId,
      ...(p.periodKo !== undefined ? { periodKo: p.periodKo } : {}),
    },
    hash,
    opts,
  );
}
