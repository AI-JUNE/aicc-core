// QA·준수 점검 실행 — 설계서 §7 5.2 · §10.1(AI 고지) · §10.3(마스킹) · §11.1(테넌트 격리) · §13-3(임의값 금지).
//
// `qa/compliance.ts` 는 머리말에 "셋 다 사후에 사람이 듣고 찾을 수 없다 — 그래서 이벤트(§8.1) 위에서
// 기계적으로 판정한다"고 적어 두었고 판정(`runComplianceCheck`)·리뷰 분기(`requiresHumanReview`)까지
// 갖췄는데, **저장소 전체에서 그 함수를 부르는 곳이 테스트뿐이었다.** 즉 지금까지 어떤 세션도
// 준수 점검을 받은 적이 없다 — 고지 누락·금칙 표현·마스킹 누락이 **한 건도 집계된 적이 없다.**
//
// 이 공백의 증상은 다른 빈 자리들보다 한 단계 더 조용하다. 미배선이면 리포트가 비는 것이 아니라
// **리포트 자체가 없다**: 통화는 정상이고 이벤트도 정상이고 적합성 검사도 통과하므로 "점검이 돌고
// 있다"와 "점검이 한 번도 돈 적이 없다"가 운영 화면에서 똑같이 보인다. 드러나는 시점은 감독기관
// 점검이거나 민원이고, 그때 필요한 것은 지금의 판정이 아니라 **지나간 통화들의 판정**이다.
//
// 빠진 것은 정책이 아니라 두 자리였다.
//  1) **한 Interaction 의 이벤트를 모으는 자리.** 런타임은 이벤트를 만들어 버스로 흘려보내고
//     잊는다(`publish`). 점검은 세션 전체를 한꺼번에 봐야 한다 — 고지 **순서**(첫 봇 발화보다
//     앞이었나)는 턴 하나만 보고는 판정할 수 없다.
//  2) **판정을 돌릴 시점을 고르는 자리.** 세션이 끝나는 길은 네 갈래다(정상 종료·§9.3 폴백 중단·
//     폴백 이관·커넥터 순회 상한). `end()` 에만 걸면 **폴백으로 끝난 통화는 영영 점검되지 않는데**,
//     하필 그 통화들이 감독기관·민원에서 가장 먼저 열리는 통화다.
//
// 하지 않는 것:
//  - **판정하지 않는다**(§2). 위반 판정은 `runComplianceCheck` 하나, 사람 리뷰 분기는
//    `requiresHumanReview` 하나, 건수는 `countBySeverity` 하나다. 이 파일에는 금칙어 비교도,
//    고지 표식 비교도, 심각도 등급도 없다(검사로 고정한다).
//  - **고지 필수 여부를 따로 선언받지 않는다**(§2). 출처는 `AiDisclosureConfig` 하나이며
//    `resolveDisclosure` 로 읽는다. 테넌트가 QA 규칙에 그 값을 또 적으면 두 값이 어긋나는데,
//    어긋남의 두 방향이 모두 조용하다: QA 만 필수라고 적으면 **모든 세션이 critical** 이 되어
//    리뷰 큐가 통째로 잠기고(진짜 위반이 그 안에 묻힌다), 고지 설정만 필수면 Core 가 실제로
//    내보내는 고지를 **아무도 점검하지 않는다**(누락이 나도 리포트는 깨끗하다).
//  - **막지 않는다.** critical 위반이 나와도 통화·종료에 손대지 않는다. 점검은 끝난 통화에
//    대한 관측이고, 조치·재학습·경고 발송은 승인 후 별도 워커가 맡는다 **[승인 필요]**.
//  - **던지지 않는다.** 점검은 종료 경로에서 돌기 때문이다 — 그 경로에서 예외는 세션이 열린 채
//    남는 것으로 나타나고(채널의 `end` 지시가 호출되지 않는다), 그 누수는 장애가 아니라
//    **요금**으로 먼저 보인다. 격리 위반도 던지지 않고 **리포트를 만들지 않는 것**으로 끝낸다 —
//    남의 테넌트 이벤트가 섞인 점검 결과는 근거가 아니다(§11.1).
//  - **저장하지 않는다**(§6.2). 리뷰 큐·보존은 호스트 저장소 몫이다.
//  - **점수·합격률을 만들지 않는다**(§13-3). 건수와 위반 목록뿐이다.
import type { ChannelKind } from '../domain/types.ts';
import type { InteractionEvent } from '../events/schema.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { AiDisclosureConfig } from '../portal/aiDisclosure.ts';
import { resolveDisclosure } from '../portal/aiDisclosure.ts';
import type { ForbiddenPhraseRule, QaReport, QaRuleId, QaRuleSet, QaSeverity } from './compliance.ts';
import { countBySeverity, normalizeForMatch, requiresHumanReview, runComplianceCheck } from './compliance.ts';

/** 심각도 허용값. 리뷰 큐 우선순위가 이 값으로 정해지므로 모르는 값을 통과시키지 않는다. */
const SEVERITIES: readonly QaSeverity[] = ['critical', 'major', 'minor'];

/**
 * 이벤트 전수를 봐야 성립하는 규칙. 수집이 상한에 걸려 **뒤쪽을 보지 못했으면** 이 셋은
 * 점검한 것이 아니다 — 고지 규칙은 머리(첫 봇 발화)만 보므로 그대로 유효하다.
 */
const FULL_SCAN_RULES: readonly QaRuleId[] = ['forbidden_phrase', 'pii_exposed', 'pii_unmasked_flag'];

/**
 * 한 세션의 점검용 이벤트 수집함. 세션 레코드에 실려 다니며, **마스킹을 통과한 이벤트만** 담긴다
 * (§10.3 — 런타임이 만든 §8.1 이벤트가 그대로 들어온다. 원문을 담는 경로를 만들지 않는다).
 */
export interface ComplianceBuffer {
  events: InteractionEvent[];
  /** 수집 상한에 걸려 이후 이벤트를 담지 못했다. 점검 범위가 줄었다는 사실의 기록이다. */
  truncated: boolean;
  /** 이 세션의 점검을 이미 돌렸다. 두 번 올리면 리뷰 큐에 같은 통화가 두 건 쌓인다. */
  reviewed: boolean;
}

export function newComplianceBuffer(): ComplianceBuffer {
  return { events: [], truncated: false, reviewed: false };
}

/**
 * 이번 턴 이벤트를 수집함에 담는다.
 *
 * 상한을 넘으면 **일부만 담고 담은 척하지 않는다** — `truncated` 를 세우고 거기서 멈춘다.
 * 뒤쪽 턴을 잘라낸 채 "금칙어 위반 0건"으로 적으면 그 0 은 점검 결과가 아니라 절단의 결과다.
 * 상한 기본값은 없다(§13-3) — 주지 않으면 세션 길이만큼 담는다(종전에는 아무것도 담지 않았다).
 */
export function appendForReview(
  buf: ComplianceBuffer,
  events: readonly InteractionEvent[],
  maxEvents?: number,
): void {
  for (const e of events) {
    if (maxEvents !== undefined && buf.events.length >= maxEvents) {
      buf.truncated = true;
      return;
    }
    buf.events.push(e);
  }
}

export interface ComplianceRuleInput {
  scope: TenantScope;
  /**
   * 고지 발화 판별용 **추가** 표식(§10.1). 테넌트가 등록한 핵심 어구이며 Core 가 만들지
   * 않는다(§13-3) — 문구는 업권·약관·감독기관에 따라 다르다 **[승인 필요]**.
   *
   * 배선된 고지 설정의 문구는 `derivedDisclosureMarkers` 가 **자동으로** 표식이 되므로,
   * 여기에 적어야 하는 것은 그 설정 밖의 문구뿐이다(지난 문구로 기록된 통화를 함께 점검하거나,
   * 포털·IVR 메뉴 등 다른 경로로 나간 고지를 함께 보려는 경우). 비워 두어도 고지 점검은 돈다.
   */
  disclosureMarkers: readonly string[];
  /** 금칙어 규칙. 문구와 사유는 테넌트 법무·컴플라이언스가 등록한다(§13-3). */
  forbiddenPhrases: readonly ForbiddenPhraseRule[];
  /**
   * §10.1 고지 설정. **고지 필수 여부의 유일한 출처**다(§2) — 없으면 고지 점검을 수행하지 않고
   * 그 사실이 리포트의 `skipped` 에 남는다(합격으로 적지 않는다).
   */
  disclosure?: AiDisclosureConfig;
  /** 실제로 등록된 채널만. 붙지도 않은 채널의 고지 요구를 만들어 내지 않는다. */
  channels: readonly ChannelKind[];
}

/**
 * 배선된 고지 설정에서 **Core 가 실제로 내보내는 문구**를 표식으로 뽑는다(§2·§10.1).
 *
 * 왜 뽑는가: 고지 필수 여부는 `AiDisclosureConfig` 하나를 출처로 삼았는데(위 머리말) **문구는
 * 그러지 않았다** — 같은 문장을 고지 설정과 QA 표식에 **두 번** 선언하게 두었고, 어긋남의
 * 방향이 둘 다 조용하다.
 *  - **문구를 고치고 표식을 그대로 두면** 그날부터 모든 세션이 `disclosure_missing`(critical) 로
 *    잡혀 리뷰 큐가 통째로 잠긴다 — 진짜 위반이 그 안에 묻힌다.
 *  - **표식을 등록하지 않으면** 고지 점검이 통째로 건너뛰어지고(`skipped`), 그 상태는 운영
 *    화면에서 "위반 0건"과 거의 같게 보인다. 고지는 나가는데 아무도 점검하지 않는 셈이다.
 * 설정을 읽으면 두 방향이 같이 사라진다. **문구를 만들어 내지는 않는다**(§13-3) — 설정에
 * 문구가 없으면 뽑히는 표식도 없다.
 *
 * **전문을 그대로 쓴다.** `QaRuleSet.disclosureMarkers` 주석은 "전문 비교는 TTS 치환·띄어쓰기로
 * 쉽게 깨진다"고 적어 두었지만, 그 위험은 **고객이 들은 소리**와 비교할 때의 이야기다. 점검은
 * §8.1 원장의 `utterance_masked` 를 보고, 그 값은 **Core 가 이 설정에서 그대로 만든 문자열**이다
 * (`planDisclosure` → `turnCompleted`). 그래서 전문이 가장 정확한 표식이다.
 *
 * 다만 `maskPii` 를 **같이 통과시킨다** — 고지 문구에 대표번호가 들어 있으면 원장에는 마스킹된
 * 형태로 남으므로, 설정 원문을 그대로 표식으로 쓰면 그 테넌트만 전 세션이 고지 누락으로 잡힌다.
 * (마스킹이 멱등이 아니므로 **한 번만** 통과시킨다.)
 */
export function derivedDisclosureMarkers(
  cfg: AiDisclosureConfig,
  channels: readonly ChannelKind[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ch of channels) {
    const d = resolveDisclosure(cfg, ch);
    if (!d.show) continue;
    const text = maskPii(d.disclosure.text).text;
    const n = normalizeForMatch(text);
    if (n === '' || seen.has(n)) continue;   // 비교할 수 없는 문구·채널 간 같은 문구
    seen.add(n);
    out.push(text);
  }
  return out;
}

/** 정규화 기준으로 같은 표식을 한 번만 남긴다 — 같은 발화가 두 표식에 걸려도 판정은 하나다. */
function dedupeMarkers(markers: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of markers) {
    const n = normalizeForMatch(typeof m === 'string' ? m : '');
    if (n === '' || seen.has(n)) continue;
    seen.add(n);
    out.push(m);
  }
  return out;
}

/**
 * 점검 규칙 조립. **판정을 복사하지 않는다** — 고지 필수 여부는 `resolveDisclosure` 가 정하고
 * 여기서는 그 결과를 옮긴다(끈 테넌트·미설정 채널은 필수가 아니다).
 *
 * `show: false` 중 설정 오류(미승인·문구 공백)는 런타임 배선 검증(`validateDisclosureBinding`)이
 * 이미 **생성 시점에** 막으므로 여기까지 오지 않는다. 그래서 이 함수는 "끈 상태"와 "설정 오류"를
 * 가르지 않는다 — 가르면 같은 판정의 출처가 둘이 된다.
 *
 * 격리 위반만 던진다(§11.1) — 다른 테넌트의 고지 설정으로 만든 규칙은 그 테넌트의 통화를
 * 엉뚱한 기준으로 점검하고, 타입도 값도 멀쩡해서 어디서도 터지지 않는다. 배선 시점에 돌므로
 * 통화 중 예외가 되지 않는다.
 */
export function buildQaRuleSet(input: ComplianceRuleInput): QaRuleSet {
  const cfg = input.disclosure;
  if (cfg !== undefined && cfg.tenantId !== input.scope.tenantId) {
    throw new Error(
      `테넌트 격리 위반(QA 점검 규칙): 고지 설정=${cfg.tenantId} 코어=${input.scope.tenantId} (설계서 §11.1)`,
    );
  }
  const disclosureRequired: QaRuleSet['disclosureRequired'] = {};
  if (cfg !== undefined) {
    for (const ch of input.channels) {
      disclosureRequired[ch] = resolveDisclosure(cfg, ch).show === true;
    }
  }
  return {
    tenantId: input.scope.tenantId,
    disclosureRequired,
    // 테넌트가 적은 표식을 **먼저** 둔다(명시적 선언이 먼저 걸리는 쪽이 사후 추적에 낫다).
    // 설정에서 뽑은 전문은 뒤에 붙는다 — 둘 중 하나라도 걸리면 고지로 본다.
    disclosureMarkers: dedupeMarkers([
      ...input.disclosureMarkers,
      ...(cfg !== undefined ? derivedDisclosureMarkers(cfg, input.channels) : []),
    ]),
    forbiddenPhrases: input.forbiddenPhrases.map((r) => ({ ...r, ...(r.channels ? { channels: [...r.channels] } : {}) })),
  };
}

/** 점검을 수행하지 못한 이유. 전부 "위반 0건"과 구분되어야 하는 상태다. */
export type ComplianceSkipCause =
  /** 이 세션에 §8.1 이벤트가 없다. */
  | 'no_events'
  /** 스코프 밖 이벤트·규칙이 섞였다(§11.1). 리포트를 만들지 않는다. */
  | 'tenant_mismatch'
  /** 판정이 예외로 끝났다. 던지지 않고 사실만 적는다. */
  | 'check_failed';

/**
 * 결과에 실리는 점검 요약. **근거 이벤트 id·검출 표현·금칙어 문구를 싣지 않는다** —
 * 이 값은 채널(비-Node 호스트 포함)까지 나가고, 금칙어 목록과 근거 id 는 고객 접점이 아니라
 * 운영·리뷰 화면의 자료다(§2·§10.3). 전문이 필요한 쪽은 `onReport` 로 받는다.
 */
export interface ComplianceTurnNote {
  /** 점검이 실제로 수행됐는가. false 면 건수는 실리지 않는다 — 못 한 점검은 0건이 아니다. */
  reviewed: boolean;
  /** critical 이 하나라도 있으면 사람 리뷰다(§7 5.2). 판정은 `requiresHumanReview` 하나다. */
  requiresHumanReview?: boolean;
  /** 심각도별 위반 건수. 점수·합격률을 만들지 않는다(§13-3). */
  counts?: Record<QaSeverity, number>;
  /** 위반이 잡힌 규칙(중복 제거). */
  violated?: QaRuleId[];
  /** 실제로 점검한 규칙. */
  checked?: QaRuleId[];
  /** 점검하지 못한 규칙과 사유. 건너뛴 검사는 통과의 근거가 아니다. */
  skipped?: { ruleId: QaRuleId; reasonKo: string }[];
  /** 점검 자체를 수행하지 못한 사유(`reviewed: false` 일 때만). */
  reasonKo?: string;
}

export interface ComplianceReview {
  /** 점검 전문. 수행하지 못했으면 **만들지 않는다**(빈 리포트를 "위반 없음"으로 읽지 않게). */
  report?: QaReport;
  note: ComplianceTurnNote;
  cause?: ComplianceSkipCause;
}

export interface ReviewComplianceInput {
  buffer: ComplianceBuffer;
  /** `buildQaRuleSet` 이 만든 고정 규칙. */
  rules: QaRuleSet;
  scope: TenantScope;
}

/**
 * 한 세션의 준수 점검(§7 5.2). **어떤 경우에도 던지지 않는다**(머리말 참조).
 *
 * 절단된 수집함은 "점검 완료"로 적지 않는다 — 전수를 봐야 하는 규칙(금칙어·마스킹)은
 * `skipped` 로 내려가고, 그때까지 **찾은 위반은 지우지 않는다**(찾은 것은 사실이다).
 */
export function reviewCompliance(input: ReviewComplianceInput): ComplianceReview {
  const { buffer, rules, scope } = input;
  if (buffer.events.length === 0) {
    return {
      cause: 'no_events',
      note: { reviewed: false, reasonKo: '이 세션에 수집된 §8.1 이벤트가 없어 준수 점검을 수행하지 못했습니다(§7 5.2).' },
    };
  }
  // 격리 위반을 **판정 전에** 가른다. `runComplianceCheck` 는 이 경우 던지는데, 종료 경로에서
  // 던지면 세션이 열린 채 남는다. 판정을 돌리지 않는 쪽이 안전하고, 그 사실은 그대로 적는다.
  const foreign = rules.tenantId !== scope.tenantId
    || buffer.events.some((e) => e.tenant_id !== scope.tenantId);
  if (foreign) {
    return {
      cause: 'tenant_mismatch',
      note: {
        reviewed: false,
        reasonKo: '스코프 밖 테넌트의 이벤트·규칙이 섞여 준수 점검 결과를 만들지 않았습니다 — '
          + '남의 테넌트 기록이 섞인 점검은 근거가 아닙니다(§11.1).',
      },
    };
  }

  let report: QaReport;
  try {
    report = runComplianceCheck([...buffer.events], rules, scope);
  } catch {
    // 판정이 예외로 끝난 것 때문에 종료가 막히면 안 된다. 원문·스택은 싣지 않는다(§10.3).
    return {
      cause: 'check_failed',
      note: { reviewed: false, reasonKo: '준수 점검 판정이 예외로 끝나 결과를 만들지 못했습니다(§7 5.2).' },
    };
  }

  const truncatedKo = `점검용 이벤트 수집이 상한에 걸려 이후 이벤트를 보지 못했습니다(수집 ${buffer.events.length}건) — `
    + '이 규칙은 전수 점검이 성립하지 않습니다.';
  const skipped = buffer.truncated
    ? [...report.skipped, ...FULL_SCAN_RULES
      .filter((r) => report.checked.includes(r))
      .map((ruleId) => ({ ruleId, reasonKo: truncatedKo }))]
    : report.skipped;
  const checked = buffer.truncated
    ? report.checked.filter((r) => !FULL_SCAN_RULES.includes(r))
    : report.checked;
  const final: QaReport = { ...report, checked, skipped };

  const violated = [...new Set(final.findings.map((f) => f.ruleId))];
  return {
    report: final,
    note: {
      reviewed: true,
      requiresHumanReview: requiresHumanReview(final),
      counts: countBySeverity(final),
      violated,
      checked: [...checked],
      skipped: skipped.map((s) => ({ ...s })),
    },
  };
}

export interface ComplianceBindingIssues {
  /** 하나라도 있으면 배선하지 않는다. */
  errorsKo: string[];
  /** 막지는 않되 운영이 반드시 보아야 하는 것. */
  warningsKo: string[];
}

/**
 * 배선 시점 검증. **통화 중이 아니라 여기서 걸러야 한다** — 점검 설정 오류의 증상은 예외가
 * 아니라 "리포트가 깨끗한 것"이고, 깨끗한 리포트는 아무도 다시 보지 않는다.
 *
 * 막는 것(전부 "등록했는데 한 번도 안 걸린다"로 끝나는 형태다):
 *  - **비교할 수 없는 금칙어**: 정규화(공백·문장부호 제거) 후 빈 문자열이 되는 문구는
 *    `runComplianceCheck` 가 건너뛴다. 등록부에는 남아 있으므로 운영자는 적용됐다고 본다.
 *  - **모르는 심각도**: 리뷰 큐 우선순위가 그 값으로 정해진다. 통과시키면 건수 집계가
 *    `NaN` 이 되고 critical 이 아니므로 **사람 리뷰로도 가지 않는다**.
 *  - **빈 규칙 id**: 리뷰 화면에서 어느 등록 항목이 걸렸는지 되짚을 수 없다.
 *  - **양수가 아닌 수집 상한**: 모든 세션이 즉시 절단된 채 점검된다.
 *
 * 경고로 두는 것(설정이 아직 덜 찬 상태이며 점검은 그대로 돈다):
 *  - 고지 설정 미배선·표식 미등록 → 고지 점검이 수행되지 않는다(리포트에 `skipped` 로 남는다).
 *  - 등록되지 않은 채널만 가리키는 금칙어 규칙 → 어떤 통화에도 적용되지 않는다.
 *  - 정규화 후 같아지는 중복 문구 → 같은 발화가 두 건으로 세어져 리뷰 큐 우선순위가 부풀려진다.
 */
export function validateComplianceBinding(input: ComplianceRuleInput & { maxEvents?: number }): ComplianceBindingIssues {
  const errorsKo: string[] = [];
  const warningsKo: string[] = [];

  if (input.disclosure !== undefined && input.disclosure.tenantId !== input.scope.tenantId) {
    errorsKo.push(`다른 테넌트의 고지 설정으로 점검 규칙을 만들 수 없습니다: 설정=${input.disclosure.tenantId} 코어=${input.scope.tenantId} (설계서 §11.1)`);
  }
  if (input.maxEvents !== undefined
    && (!Number.isInteger(input.maxEvents) || input.maxEvents <= 0)) {
    errorsKo.push(`점검용 이벤트 수집 상한이 양수 정수가 아닙니다: ${String(input.maxEvents)} — 모든 세션이 즉시 절단된 채 점검됩니다.`);
  }

  const seenId = new Set<string>();
  const seenPhrase = new Map<string, string>();
  for (const r of input.forbiddenPhrases) {
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (id === '') {
      errorsKo.push(`금칙어 규칙에 id 가 없습니다(문구: ${r.phrase}) — 리뷰 화면에서 등록 항목을 되짚을 수 없습니다.`);
    } else if (seenId.has(id)) {
      warningsKo.push(`금칙어 규칙 id 가 중복됩니다: ${id}`);
    } else {
      seenId.add(id);
    }
    const n = normalizeForMatch(typeof r.phrase === 'string' ? r.phrase : '');
    if (n === '') {
      errorsKo.push(`금칙어 문구가 비교할 수 없는 값입니다(공백·문장부호만): id=${id || '(없음)'} — 등록부에는 남지만 어떤 발화에도 걸리지 않습니다.`);
    } else {
      const prev = seenPhrase.get(n);
      if (prev !== undefined) warningsKo.push(`금칙어 문구가 사실상 중복입니다: ${id || '(id 없음)'} ↔ ${prev} — 같은 발화가 두 건으로 세어집니다.`);
      else seenPhrase.set(n, id || '(id 없음)');
    }
    if (!SEVERITIES.includes(r.severity)) {
      errorsKo.push(`금칙어 규칙의 심각도가 허용값이 아닙니다: id=${id || '(없음)'} severity=${String(r.severity)} — 건수 집계가 깨지고 사람 리뷰로도 가지 않습니다.`);
    }
    const unknown = (r.channels ?? []).filter((c) => !input.channels.includes(c));
    if (r.channels !== undefined && r.channels.length > 0 && unknown.length === r.channels.length) {
      warningsKo.push(`금칙어 규칙 ${id || '(id 없음)'} 이 등록되지 않은 채널만 가리킵니다: ${r.channels.join(', ')} — 어떤 통화에도 적용되지 않습니다.`);
    }
  }

  const markers = input.disclosureMarkers.filter((m) => normalizeForMatch(m) !== '');
  const derived = input.disclosure === undefined
    ? []
    : derivedDisclosureMarkers(input.disclosure, input.channels);
  if (input.disclosure === undefined) {
    warningsKo.push('고지 설정(disclosure)이 배선되지 않아 §10.1 고지 점검을 수행하지 않습니다 — '
      + '고지 필수 여부의 출처는 AiDisclosureConfig 하나입니다(§2).');
  } else if (markers.length === 0 && derived.length === 0) {
    // 설정은 있는데 뽑을 문구가 없다(전 채널이 미설정·끔·공백). 그 채널들은 고지 필수도 아니므로
    // 점검은 `skipped` 로 남는다 — 막지 않되 "위반 0건"으로 읽히지 않게 적는다.
    warningsKo.push('고지 발화를 판별할 표식이 없어 §10.1 고지 점검을 수행하지 않습니다 — '
      + '배선된 고지 설정에서 뽑을 문구가 없고(미설정·끔·공백) 테넌트가 등록한 표식도 없습니다.');
  }
  if (markers.length < input.disclosureMarkers.length) {
    warningsKo.push('비교할 수 없는 고지 표식(공백·문장부호만)이 섞여 있습니다 — 그 표식은 어떤 발화와도 일치하지 않습니다.');
  }
  // **낡은 표식**: 지금 설정된 어떤 고지 문구에도 들어 있지 않은 표식. 문구를 고치고 표식을
  // 그대로 둔 상태가 바로 이 모양이고, 그 상태의 증상은 "그날부터 전 세션이 고지 누락"이었다.
  // 지금은 설정 문구가 자동으로 표식이 되므로 그 사고는 일어나지 않지만, **표식이 가리키는
  // 문구가 더는 나가지 않는다는 사실**은 운영이 알아야 한다(지난 원장을 함께 점검하려는
  // 의도일 수도 있어 막지 않는다).
  if (derived.length > 0) {
    const stale = markers.filter((m) => {
      const n = normalizeForMatch(m);
      return !derived.some((d) => normalizeForMatch(d).includes(n));
    });
    if (stale.length > 0) {
      warningsKo.push(
        `지금 설정된 고지 문구에 없는 표식이 ${stale.length}건 있습니다: ${stale.join(', ')} — `
        + '문구를 고치고 표식을 그대로 둔 상태일 수 있습니다(지난 문구로 기록된 통화를 함께 '
        + '점검하려는 것이면 의도된 상태입니다). 지금 나가는 고지는 설정 문구로 판별합니다(§2).',
      );
    }
  }
  if (input.forbiddenPhrases.length === 0) {
    warningsKo.push('등록된 금칙어 규칙이 없어 금칙 표현 점검을 수행하지 않습니다 — '
      + '리포트의 금칙어 항목은 합격이 아니라 skipped 로 남습니다(§13-3).');
  }
  return { errorsKo, warningsKo };
}
