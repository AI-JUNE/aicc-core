// QA·준수 점검 — 설계서 §7 5.2 (·§10.1 고지 ·§10.3 개인정보).
//
// QA는 "상담사가 잘했나"가 아니라 "이 세션이 규정을 지켰나"를 먼저 본다.
// 감독기관 점검에서 문제가 되는 건 응대 품질이 아니라 (1) AI 고지 누락, (2) 금칙 표현,
// (3) 개인정보가 마스킹 없이 남은 흔적이다. 셋 다 사후에 사람이 듣고 찾을 수 없다 —
// 그래서 이벤트(§8.1) 위에서 기계적으로 판정한다.
//
// 이 모듈은 판정만 한다(순수 함수). 조치·재학습·경고 발송은 승인 후 별도 워커가 맡는다 — [승인 필요].
// 합격률·목표 점수 같은 수치는 두지 않는다(§13-3). 점검 결과는 위반 목록이지 점수가 아니다.
import type { ChannelKind } from '../domain/types.ts';
import type { InteractionEvent, TurnCompletedEvent, SessionStartedEvent } from '../events/schema.ts';
import { maskPii } from '../core/policyGuard.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';

export type QaRuleId =
  | 'disclosure_missing'    // §10.1 필수 고지 발화 누락
  | 'disclosure_late'       // 고지가 AI 응답보다 늦게 나옴
  | 'forbidden_phrase'      // 금칙어·과장 표현
  | 'pii_exposed'           // §10.3 마스킹되지 않은 개인정보가 이벤트 본문에 남음
  | 'pii_unmasked_flag';    // 마스킹 판정 플래그와 본문이 불일치

export type QaSeverity = 'critical' | 'major' | 'minor';

export interface QaFinding {
  ruleId: QaRuleId;
  severity: QaSeverity;
  messageKo: string;
  /** 근거가 된 이벤트. 사람이 원본을 찾아갈 수 있어야 판정이 반박 가능해진다. */
  eventId?: string;
  turnId?: string;
  occurredAt?: string;
  /** 검출된 표현. 개인정보 검출 시에는 원문이 아니라 종류만 담는다(§10.3). */
  evidence?: string;
}

/** 금칙어 규칙. 문구는 테넌트 법무·컴플라이언스가 등록한다 — 코드에 표준 목록을 박지 않는다. */
export interface ForbiddenPhraseRule {
  id: string;
  /** 검출 대상 표현(부분일치, 대소문자·공백 무시) */
  phrase: string;
  severity: QaSeverity;
  /** 등록 사유 — 리뷰 화면에 그대로 노출된다 */
  reasonKo: string;
  /** 특정 채널에만 적용할 경우 */
  channels?: ChannelKind[];
}

export interface QaRuleSet {
  tenantId: string;                       // §11.1 — 테넌트 밖 규칙을 적용하지 않는다
  /** §10.1 고지 필수 여부. 채널별로 다르다(aiDisclosure 설정과 같은 근거를 쓴다). */
  disclosureRequired: Partial<Record<ChannelKind, boolean>>;
  /**
   * 고지 발화 판별용 표식. 문구 전문 비교는 TTS 치환·띄어쓰기로 쉽게 깨지므로,
   * 테넌트가 등록한 핵심 어구(예: 'AI 상담') 포함 여부로 본다.
   */
  disclosureMarkers: string[];
  forbiddenPhrases: ForbiddenPhraseRule[];
}

export interface QaReport {
  tenantId: string;
  interactionId: string;
  findings: QaFinding[];
  /** 점검이 실제로 수행된 규칙. 데이터가 없어 건너뛴 항목을 합격으로 오인하지 않게 한다. */
  checked: QaRuleId[];
  /** 판정 불가 사유 — 예: 봇 발화 이벤트가 하나도 없음 */
  skipped: { ruleId: QaRuleId; reasonKo: string }[];
}

/** 비교용 정규화 — 공백·문장부호 제거, 소문자화. TTS/STT 표기 흔들림을 흡수한다. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s ]+/g, '').replace(/[.,!?~"'`()\[\]{}<>·:;\-]/g, '');
}

function isTurn(e: InteractionEvent): e is TurnCompletedEvent {
  return e.type === 'turn.completed';
}

function isStart(e: InteractionEvent): e is SessionStartedEvent {
  return e.type === 'session.started';
}

/** 고지 발화로 볼 수 있는 봇 턴인지. 표식 중 하나라도 포함하면 고지로 본다. */
export function isDisclosureUtterance(text: string, markers: string[]): boolean {
  if (markers.length === 0) return false;
  const n = normalizeForMatch(text);
  return markers.some((m) => {
    const nm = normalizeForMatch(m);
    return nm !== '' && n.includes(nm);
  });
}

/**
 * §10.1 — 필수 고지가 "AI가 처음 말을 걸기 전"에 나왔는지 본다.
 * 고지가 세션 후반에 붙는 건 고지가 아니라 변명이다. 그래서 누락과 지각을 나눠 판정한다.
 */
function checkDisclosure(events: InteractionEvent[], rules: QaRuleSet, channel: ChannelKind): {
  findings: QaFinding[];
  skipped: QaReport['skipped'];
} {
  const findings: QaFinding[] = [];
  const skipped: QaReport['skipped'] = [];
  if (rules.disclosureRequired[channel] !== true) return { findings, skipped };
  if (rules.disclosureMarkers.length === 0) {
    skipped.push({ ruleId: 'disclosure_missing', reasonKo: '테넌트에 고지 표식이 등록되지 않아 판정할 수 없습니다.' });
    return { findings, skipped };
  }

  const botTurns = events.filter(isTurn).filter((e) => e.speaker === 'bot');
  if (botTurns.length === 0) {
    skipped.push({ ruleId: 'disclosure_missing', reasonKo: '봇 발화 이벤트가 없어 고지 여부를 판정할 수 없습니다.' });
    return { findings, skipped };
  }

  const idx = botTurns.findIndex((e) => isDisclosureUtterance(e.utterance_masked, rules.disclosureMarkers));
  if (idx < 0) {
    const first = botTurns[0];
    findings.push({
      ruleId: 'disclosure_missing',
      severity: 'critical',
      messageKo: 'AI 응대 고지 발화가 확인되지 않았습니다(§10.1).',
      ...(first ? { eventId: first.event_id, turnId: first.turn_id, occurredAt: first.occurred_at } : {}),
    });
  } else if (idx > 0) {
    const at = botTurns[idx];
    findings.push({
      ruleId: 'disclosure_late',
      severity: 'major',
      messageKo: `AI 응대 고지가 첫 응답보다 늦게 노출되었습니다(봇 발화 ${idx + 1}번째).`,
      ...(at ? { eventId: at.event_id, turnId: at.turn_id, occurredAt: at.occurred_at } : {}),
    });
  }
  return { findings, skipped };
}

/** 금칙어는 봇 발화만 본다. 고객 발화를 금칙어로 잡는 건 QA가 아니라 검열이다. */
function checkForbidden(events: InteractionEvent[], rules: QaRuleSet, channel: ChannelKind): QaFinding[] {
  const out: QaFinding[] = [];
  const applicable = rules.forbiddenPhrases.filter((r) => !r.channels || r.channels.includes(channel));
  if (applicable.length === 0) return out;
  for (const e of events.filter(isTurn)) {
    if (e.speaker === 'customer') continue;
    const n = normalizeForMatch(e.utterance_masked);
    for (const r of applicable) {
      const np = normalizeForMatch(r.phrase);
      if (np !== '' && n.includes(np)) {
        out.push({
          ruleId: 'forbidden_phrase',
          severity: r.severity,
          messageKo: `금칙 표현이 사용되었습니다: ${r.phrase} — ${r.reasonKo}`,
          eventId: e.event_id,
          turnId: e.turn_id,
          occurredAt: e.occurred_at,
          evidence: r.phrase,
        });
      }
    }
  }
  return out;
}

/**
 * §10.3 — 저장된 이벤트 본문을 다시 마스킹기에 통과시켜 본다.
 * 여기서 뭔가 잡히면 마스킹 파이프라인이 새고 있다는 뜻이므로 critical 이다.
 * 검출된 원문은 절대 findings 에 담지 않는다 — 종류(rrn·card 등)만 남긴다.
 */
function checkPiiLeak(events: InteractionEvent[]): QaFinding[] {
  const out: QaFinding[] = [];
  for (const e of events) {
    const texts: string[] = [];
    if (isTurn(e)) texts.push(e.utterance_masked);
    if (e.type === 'handoff.requested' && e.summary_masked !== undefined) texts.push(e.summary_masked);
    for (const t of texts) {
      const r = maskPii(t);
      if (r.masked) {
        out.push({
          ruleId: 'pii_exposed',
          severity: 'critical',
          messageKo: `저장된 본문에 마스킹되지 않은 개인정보가 남아 있습니다(${r.hits.join(', ')}) — §10.3 파이프라인 점검이 필요합니다.`,
          eventId: e.event_id,
          occurredAt: e.occurred_at,
          ...(isTurn(e) ? { turnId: e.turn_id } : {}),
          evidence: r.hits.join(','),
        });
      }
    }
    // 플래그 불일치: 마스킹했다고 표시했는데 종류가 비었거나, 반대인 경우.
    if (e.pii_masked !== (e.pii_kinds.length > 0)) {
      out.push({
        ruleId: 'pii_unmasked_flag',
        severity: 'major',
        messageKo: `pii_masked 플래그와 pii_kinds 가 일치하지 않습니다(masked=${String(e.pii_masked)}, kinds=${e.pii_kinds.length}).`,
        eventId: e.event_id,
        occurredAt: e.occurred_at,
      });
    }
  }
  return out;
}

const ALL_RULES: QaRuleId[] = ['disclosure_missing', 'disclosure_late', 'forbidden_phrase', 'pii_exposed', 'pii_unmasked_flag'];

/**
 * 한 Interaction 의 준수 점검. 이벤트는 §8.1 스키마 그대로 받는다.
 * 채널은 이벤트에서 읽되, 여러 채널이 섞인 세션은 첫 이벤트 채널을 기준으로 고지를 판정한다
 * (고지는 세션 진입 채널에서 1회 이루어지기 때문 — §7 7.4).
 */
export function runComplianceCheck(
  events: InteractionEvent[],
  rules: QaRuleSet,
  scope: TenantScope,
): QaReport {
  assertTenantScope(scope);
  if (rules.tenantId !== scope.tenantId) {
    throw new Error(`다른 테넌트의 QA 규칙을 적용할 수 없다: ${rules.tenantId} ≠ ${scope.tenantId} (설계서 §11.1)`);
  }
  const foreign = events.find((e) => e.tenant_id !== scope.tenantId);
  if (foreign) {
    throw new Error(`테넌트 스코프 밖 이벤트가 섞였다: ${foreign.event_id} (설계서 §11.1)`);
  }

  const sorted = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const first = sorted[0];
  if (!first) {
    return {
      tenantId: scope.tenantId,
      interactionId: '',
      findings: [],
      checked: [],
      skipped: ALL_RULES.map((ruleId) => ({ ruleId, reasonKo: '이벤트가 없어 점검할 수 없습니다.' })),
    };
  }
  const start = sorted.find(isStart);
  const channel: ChannelKind = (start ?? first).channel;

  const disclosure = checkDisclosure(sorted, rules, channel);
  const findings = [
    ...disclosure.findings,
    ...checkForbidden(sorted, rules, channel),
    ...checkPiiLeak(sorted),
  ];
  const skippedIds = new Set(disclosure.skipped.map((s) => s.ruleId));
  return {
    tenantId: scope.tenantId,
    interactionId: first.interaction_id,
    findings,
    checked: ALL_RULES.filter((r) => !skippedIds.has(r)),
    skipped: disclosure.skipped,
  };
}

/** 리뷰 큐 정렬용 — 심각도가 높은 순. 점수를 만들지 않고 건수만 센다(§13-3). */
export function countBySeverity(report: QaReport): Record<QaSeverity, number> {
  const c: Record<QaSeverity, number> = { critical: 0, major: 0, minor: 0 };
  for (const f of report.findings) c[f.severity] += 1;
  return c;
}

/** critical 이 하나라도 있으면 자동 종결하지 않고 사람 리뷰로 보낸다(§7 5.2). */
export function requiresHumanReview(report: QaReport): boolean {
  return report.findings.some((f) => f.severity === 'critical');
}
