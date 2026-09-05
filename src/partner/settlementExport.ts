// 파트너 정산 리포트 내보내기 — 설계서 §7(포털 IA)·§10.2(접근·변경 기록)·§10.3(마스킹)·
// §11.1(테넌트 격리)·§13-3(실측만).
//
// 왜 이 파일이 따로 있는가:
// `attribution.ts` 는 정산 **근거**(누가 얼마의 대상인가)를 만든다. 그런데 사고는 근거 계산이 아니라
// **반출 시점**에 난다 — 파트너 담당자에게 남의 고객사 행이 섞여 나가거나, 근거가 확정되지 않은 표가
// 그럴듯한 CSV 로 나가 청구서로 쓰이거나, 대량 반출이 감사에 남지 않는 식이다.
// 그래서 "행 만들기"와 "행 내보내기"를 갈라 두고, 내보내기 경로를 이 함수 하나로 좁힌다.
//
// 이 파일이 지키는 네 가지:
//  1) **막힌 정산은 내보내지 않는다.** `settlementBlockers` 가 하나라도 있으면 본문을 만들지 않는다.
//     근거가 흔들리는 표는 없느니만 못하다 — 밖으로 나간 CSV 는 회수되지 않는다.
//  2) **파트너 담당자는 자기 행만.** 판정(`decidePartnerAccess`)과 별개로 행을 한 번 더 거른다.
//     조건 누락이 곧 유출이므로, 판정 실패는 빈 결과지 전체가 아니다.
//  3) **반출은 예외 없이 감사에 남는다.** `reports.settlement` 은 감사 대상 화면이 아니지만(읽기·비 PII),
//     내보내기는 성격이 다르다. 성공·거부·차단 모두 기록하고, 임계값을 넘으면 대량 반출로 표시한다.
//  4) **모르는 값을 0으로 적지 않는다.** 금액·요율이 없으면 빈 칸이다(§13-3). 0원과 "모른다"를
//     같게 적는 것이 정산 분쟁의 출발점이다.
//
// 하지 않는 것: 파일 저장·전송·청구. 이 함수는 문자열과 감사 체인만 돌려준다 — 실제 청구는 [승인 필요].
import { appendAudit, type AuditAction, type AuditChain, type AuditRecord, type Hasher } from '../audit/log.ts';
import { recordAccess, type AccessActor } from '../audit/access.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import { routeById } from '../portal/ia.ts';
import {
  decidePartnerAccess, isPartnerActor,
  type PartnerActor, type PartnerRbacConfig,
} from './rbac.ts';
import type { SettlementLine } from './attribution.ts';

/** 정산 화면 라우트(§7 7.6). 다른 라우트로 내보내는 경로를 만들지 않는다. */
export const SETTLEMENT_ROUTE_ID = 'reports.settlement';

export type SettlementExportFormat = 'csv' | 'jsonl';

export type SettlementExportStatus =
  | 'ok'        // 본문 생성
  | 'empty'     // 권한은 있으나 내보낼 행이 없다(빈 상태 안내)
  | 'blocked'   // 정산 근거가 확정되지 않았다 — 본문을 만들지 않는다
  | 'denied';   // 권한·격리 위반

export interface SettlementExportRequest {
  scope: TenantScope;
  actor: PartnerActor;
  format: SettlementExportFormat;
  /** `buildSettlementLines` 결과. 이 함수는 금액을 다시 계산하지 않는다. */
  lines: readonly SettlementLine[];
  /** `settlementBlockers` 결과. 하나라도 있으면 본문을 만들지 않는다. */
  blockers?: readonly string[];
  at: string;        // ISO8601 — 주입(순수 함수 유지, §13-3)
  recordId: string;  // 감사 레코드 식별자 — 생성기는 호스트가 가진다
  /** 대상 기간 표시(예: '2026-08'). 감사 detail 에만 쓰인다. */
  periodKo?: string;
}

export interface SettlementExportOptions extends PartnerRbacConfig {
  /** 대량 반출 판단 기준. 조직마다 다르므로 호출자가 넣는다 — 기본값을 코드에 박지 않는다(§13-3). */
  bulkExportThreshold?: number;
}

export interface SettlementExportResult {
  status: SettlementExportStatus;
  /** 화면에 그대로 띄울 한 줄. 빈 상태·차단 상태에서 다음 행동을 알려 준다(품질기준 §1). */
  messageKo: string;
  /** 실제로 내보낸 행 수. 차단·거부면 0 이다. */
  rowCount: number;
  /** 권한 필터로 제외된 행 수. 0 이 아니면 화면에 표시한다 — 조용히 줄이지 않는다. */
  filteredOut: number;
  /** 본문. status==='ok' 일 때만 채운다. */
  content?: string;
  filename?: string;
  /** 정산을 막은 사유(입력 그대로 전달). */
  blockers: string[];
  /** 임계값이 주어졌고 그 이상을 반출한 경우에만 true. 임계값이 없으면 판정하지 않는다. */
  bulk: boolean;
  chain: AuditChain;
  recorded: boolean;
  record?: AuditRecord;
}

// ── 직렬화 ───────────────────────────────────────────────────────────────────

export const SETTLEMENT_CSV_HEADER = [
  'partner_id', 'account_count', 'billed_amount', 'commission_rate', 'commission_amount', 'notes',
] as const;

/**
 * CSV 한 칸. 두 가지를 동시에 막는다.
 *  - 구분자·따옴표·개행이 든 값이 열을 밀어내는 것(따옴표 감싸기).
 *  - 스프레드시트가 값을 **수식으로 실행**하는 것(=, +, -, @, 탭, CR 로 시작하는 값 앞에 작은따옴표).
 *    정산 CSV 는 반드시 엑셀에서 열리므로, 이 한 줄이 없으면 반출물이 공격 표면이 된다.
 */
export function csvCell(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value);
  const body = risky ? `'${value}` : value;
  return /[",\n\r]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

/** 숫자 칸. undefined 는 **빈 칸**이다 — 0 으로 채우지 않는다(§13-3). */
function numCell(v: number | undefined): string {
  return v === undefined ? '' : String(v);
}

function notesText(line: SettlementLine): string {
  // 사유 문구에 담당자명 같은 개인정보가 섞여 들어올 수 있다. 저장·반출 경로에서 한 번 지운다(§10.3).
  return maskPii(line.notesKo.join(' | ')).text;
}

function toCsv(lines: readonly SettlementLine[]): string {
  const rows = [SETTLEMENT_CSV_HEADER.join(',')];
  for (const l of lines) {
    rows.push([
      csvCell(l.partnerId ?? ''),
      String(l.accountCount),
      numCell(l.billedAmount),
      numCell(l.commissionRate),
      numCell(l.commissionAmount),
      csvCell(notesText(l)),
    ].join(','));
  }
  return `${rows.join('\n')}\n`;
}

function toJsonl(lines: readonly SettlementLine[]): string {
  return lines.map((l) => JSON.stringify({
    partner_id: l.partnerId,
    account_count: l.accountCount,
    // 없는 값은 키 자체를 넣지 않는다. null 을 넣으면 소비 측에서 0 으로 읽는 코드가 반드시 생긴다.
    ...(l.billedAmount !== undefined ? { billed_amount: l.billedAmount } : {}),
    ...(l.commissionRate !== undefined ? { commission_rate: l.commissionRate } : {}),
    ...(l.commissionAmount !== undefined ? { commission_amount: l.commissionAmount } : {}),
    notes: notesText(l),
  })).map((s) => `${s}\n`).join('');
}

export function serializeSettlement(lines: readonly SettlementLine[], format: SettlementExportFormat): string {
  return format === 'csv' ? toCsv(lines) : toJsonl(lines);
}

/** 파일명. 경로 조작·개인정보가 섞이지 않도록 식별자 문자만 남긴다. */
export function settlementFilename(scope: TenantScope, at: string, format: SettlementExportFormat): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_.-]/g, '_');
  const day = /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : 'unknown-date';
  return `settlement_${safe(scope.tenantId)}_${safe(day)}.${format}`;
}

// ── 반출 ─────────────────────────────────────────────────────────────────────

function auditDetail(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return kept.length > 0 ? kept.join(' · ') : undefined;
}

function bulkNoteKo(rowCount: number, threshold: number | undefined): { bulk: boolean; noteKo?: string } {
  if (threshold === undefined) return { bulk: false };   // 임계값이 없으면 판정하지 않는다(§13-3)
  if (rowCount < threshold) return { bulk: false };
  return { bulk: true, noteKo: `대량 반출 ${rowCount}건(기준 ${threshold}건)` };
}

/**
 * 파트너 담당자용 강제 기록.
 * `reports.settlement` 은 감사 대상 화면이 아니어서 일반 조회는 기록되지 않는다. 그러나 **반출은 다르다** —
 * 외부 인력이 정산 표를 가져간 사실은 남아야 한다. 그래서 여기서 명시적으로 한 줄 남긴다.
 */
function appendExportRecord(
  chain: AuditChain,
  req: SettlementExportRequest,
  hash: Hasher,
  fields: { result: 'success' | 'denied'; detail?: string; targetTenantId: string },
): { chain: AuditChain; record: AuditRecord } {
  if (chain.tenantId !== fields.targetTenantId) {
    throw new Error(`접근 이력을 다른 테넌트 체인에 남길 수 없다: ${chain.tenantId} ≠ ${fields.targetTenantId} (설계서 §11.1)`);
  }
  const route = routeById(SETTLEMENT_ROUTE_ID);
  const action: AuditAction = 'export';
  const next = appendAudit(chain, {
    scope: { tenantId: fields.targetTenantId },
    recordId: req.recordId,
    at: req.at,
    actor: {
      userId: req.actor.userId,
      roles: req.actor.roles,     // 실제 역할 그대로. 판정 편의로 바꿔 적지 않는다.
      ...(req.actor.ip !== undefined ? { ip: req.actor.ip } : {}),
    },
    action,
    routeId: SETTLEMENT_ROUTE_ID,
    targetType: route ? route.section : 'unknown_route',
    targetId: SETTLEMENT_ROUTE_ID,
    result: fields.result,
    ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
  }, hash);
  return { chain: next, record: next.records[next.records.length - 1] };
}

/**
 * 정산 리포트를 내보낸다.
 *
 * 순서가 곧 안전장치다: **격리 → 권한 → 행 필터 → 차단 판정 → 기록 → 본문**.
 * 본문을 마지막에 만드는 이유는, 앞의 어느 단계에서 걸려도 만들어진 표가 남지 않게 하기 위해서다.
 */
export function exportSettlement(
  chain: AuditChain,
  req: SettlementExportRequest,
  hash: Hasher,
  opts: SettlementExportOptions = {},
): SettlementExportResult {
  assertTenantScope(req.scope);
  const blockers = [...(req.blockers ?? [])];
  const periodNote = req.periodKo !== undefined ? `대상 기간 ${maskPii(req.periodKo).text}` : undefined;

  const empty = (
    status: SettlementExportStatus,
    messageKo: string,
    out: { chain: AuditChain; recorded: boolean; record?: AuditRecord },
    extra: { filteredOut?: number } = {},
  ): SettlementExportResult => ({
    status, messageKo, rowCount: 0, filteredOut: extra.filteredOut ?? 0, blockers, bulk: false,
    chain: out.chain, recorded: out.recorded, ...(out.record !== undefined ? { record: out.record } : {}),
  });

  // 1) 파트너 담당자 — 내부 역할과 판정 규칙이 다르다(활성화·결속·허용 목록).
  if (isPartnerActor(req.actor)) {
    const decision = decidePartnerAccess({ scope: req.scope, actor: req.actor, routeId: SETTLEMENT_ROUTE_ID }, opts);
    // 남의 테넌트 시도는 **행위자 테넌트 체인**에 남긴다(§11.1).
    const targetTenantId = decision.reason === 'tenant_mismatch' ? req.actor.tenantId : req.scope.tenantId;
    if (!decision.allowed || decision.scopedPartnerId === undefined) {
      const rec = appendExportRecord(chain, req, hash, {
        result: 'denied',
        targetTenantId,
        detail: auditDetail([periodNote, `거부 사유: ${decision.reason ?? 'partner_unbound'}`]),
      });
      return empty('denied', decision.messageKo ?? '정산 자료를 내보낼 권한이 없다.', { chain: rec.chain, recorded: true, record: rec.record });
    }

    const scopedPartnerId = decision.scopedPartnerId;
    const visible = req.lines.filter((l) => l.partnerId === scopedPartnerId);
    const filteredOut = req.lines.length - visible.length;

    if (blockers.length > 0) {
      const rec = appendExportRecord(chain, req, hash, {
        result: 'denied',
        targetTenantId,
        detail: auditDetail([periodNote, `반출 차단: ${maskPii(blockers.join(' / ')).text}`]),
      });
      return empty('blocked', blockedMessage(blockers), { chain: rec.chain, recorded: true, record: rec.record }, { filteredOut });
    }

    const { bulk, noteKo } = bulkNoteKo(visible.length, opts.bulkExportThreshold);
    const rec = appendExportRecord(chain, req, hash, {
      result: 'success',
      targetTenantId,
      detail: auditDetail([
        periodNote,
        `파트너 조회: ${scopedPartnerId}`,
        `반출 ${visible.length}건(${req.format})`,
        filteredOut > 0 ? `권한 필터 제외 ${filteredOut}건` : undefined,
        noteKo,
      ]),
    });
    return finish(visible, req, { chain: rec.chain, recorded: true, record: rec.record }, { blockers, bulk, filteredOut });
  }

  // 2) 내부 사용자 — 라우트 권한 판정과 기록을 `recordAccess` 에 맡긴다.
  //    반출은 감사 대상 화면이 아니어도 반드시 남겨야 하므로 recordAllReads 를 켠다.
  const rowsForCount = blockers.length > 0 ? 0 : req.lines.length;
  const { bulk, noteKo } = bulkNoteKo(rowsForCount, opts.bulkExportThreshold);
  const actor: AccessActor = {
    userId: req.actor.userId,
    roles: req.actor.roles,
    tenantId: req.actor.tenantId,
    ...(req.actor.ip !== undefined ? { ip: req.actor.ip } : {}),
  };
  const outcome = recordAccess(chain, {
    scope: req.scope,
    actor,
    routeId: SETTLEMENT_ROUTE_ID,
    at: req.at,
    recordId: req.recordId,
    action: 'export',
    affectedCount: rowsForCount,
    detail: auditDetail([
      periodNote,
      blockers.length > 0 ? `반출 차단: ${maskPii(blockers.join(' / ')).text}` : `반출 ${rowsForCount}건(${req.format})`,
      noteKo,
    ]),
  }, hash, { recordAllReads: true });

  const out = { chain: outcome.chain, recorded: outcome.recorded, ...(outcome.record !== undefined ? { record: outcome.record } : {}) };
  if (!outcome.decision.allowed) {
    return empty('denied', outcome.decision.messageKo ?? '정산 자료를 내보낼 권한이 없다.', out);
  }
  if (blockers.length > 0) {
    return empty('blocked', blockedMessage(blockers), out);
  }
  return finish(req.lines, req, out, { blockers, bulk, filteredOut: 0 });
}

function blockedMessage(blockers: readonly string[]): string {
  return `정산 근거가 확정되지 않아 내보내기를 중단했다. 먼저 해결하라: ${blockers.join(' / ')}`;
}

function finish(
  lines: readonly SettlementLine[],
  req: SettlementExportRequest,
  out: { chain: AuditChain; recorded: boolean; record?: AuditRecord },
  meta: { blockers: string[]; bulk: boolean; filteredOut: number },
): SettlementExportResult {
  const base = {
    filteredOut: meta.filteredOut,
    blockers: meta.blockers,
    bulk: meta.bulk,
    chain: out.chain,
    recorded: out.recorded,
    ...(out.record !== undefined ? { record: out.record } : {}),
  };
  if (lines.length === 0) {
    // 빈 결과를 파일로 내보내지 않는다. "0건짜리 CSV"는 받는 쪽에서 실적 0 으로 읽힌다.
    return {
      status: 'empty',
      messageKo: '내보낼 정산 행이 없다. 기간·파트너 조건을 확인하거나 귀속 기록을 먼저 등록하라.',
      rowCount: 0,
      ...base,
    };
  }
  return {
    status: 'ok',
    messageKo: `정산 근거 ${lines.length}건을 내보냈다. 이 파일은 청구서가 아니다 — 실제 청구는 [승인 필요].`,
    rowCount: lines.length,
    content: serializeSettlement(lines, req.format),
    filename: settlementFilename(req.scope, req.at, req.format),
    ...base,
  };
}
