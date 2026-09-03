// 관리 포털 IA ↔ 실제 화면 매핑 — 설계서 §7(포털)·§10.2(접근 기록)·§13-3(실측만).
//
// 문제: `ia.ts` 는 "있어야 할 화면"의 목록이고, 포털 저장소에는 "실제로 만든 화면"이 있다.
// 이 둘이 어긋나는 것 자체는 정상이다(아직 만드는 중이니까). 위험한 것은 **어긋난 사실을 모르는 것**이다.
//  - IA 에는 있는데 화면이 없으면: 내비게이션에 죽은 링크가 뜬다.
//  - 화면은 있는데 IA 에 없으면: 권한 검사와 감사 기록을 안 거치는 화면이 생긴다. 이쪽이 훨씬 위험하다.
//  - PII·상태변경 화면인데 감사 배선이 없으면: 사고 조사 때 하필 그 화면이 비어 있다(§10.2).
//
// 그래서 매핑을 **문서가 아니라 자료구조**로 두고 검사한다. 문서는 이 자료에서 생성한다 —
// 손으로 적은 표는 반드시 썩고, 썩은 표는 없느니만 못하다.
//
// 진행률은 **건수로만** 적는다. "몇 % 완료"를 만들어 붙이지 않는다(§13-3).
import { PORTAL_ROUTES, PORTAL_SECTIONS, routeById, requiresAuditLog, type PortalRoute, type PortalSectionId } from './ia.ts';

export type ScreenStatus =
  | 'implemented'   // 화면이 있고 라우트에 연결되어 있다
  | 'in_progress'   // 작업 중 — 배포에 포함되지 않는다
  | 'planned'       // 아직 착수 전
  | 'deferred';     // 이번 상용 범위에서 뺀다(사유 필수)

export interface ScreenBinding {
  /** PORTAL_ROUTES 의 라우트 id */
  routeId: string;
  status: ScreenStatus;
  /** 구현 저장소(예: '7. Portal'). 구현·작업중이면 필수. */
  repo?: string;
  /** 화면 구현 위치(저장소 상대경로). 구현 상태면 필수 — 없으면 "됐다"의 근거가 없다. */
  component?: string;
  /** 데이터 0건 화면이 있는가(품질기준 4-3) */
  emptyState?: boolean;
  /** 오류·실패 안내가 있는가(품질기준 4-3) */
  errorState?: boolean;
  /** 접근 시 recordAccess 를 실제로 부르는가(§10.2) */
  auditWired?: boolean;
  /** deferred 사유, 또는 남은 작업 메모 */
  note?: string;
}

export type ScreenIssueCode =
  | 'E_UNKNOWN_ROUTE'   // IA 에 없는 라우트를 매핑했다 — 권한·감사 밖의 화면
  | 'E_DUPLICATE'       // 한 라우트에 매핑이 둘
  | 'E_UNMAPPED'        // IA 에 있는데 매핑이 없다
  | 'E_NO_COMPONENT'    // 구현이라면서 위치가 없다
  | 'E_AUDIT_UNWIRED'   // 감사 대상 화면인데 배선이 없다
  | 'E_DEFER_REASON'    // 사유 없는 보류
  | 'W_NO_EMPTY_STATE'
  | 'W_NO_ERROR_STATE';

export interface ScreenIssue {
  code: ScreenIssueCode;
  severity: 'error' | 'warning';
  routeId: string;
  messageKo: string;
}

/**
 * 현재 매핑. **실제 저장소 상태를 그대로 적는다** — 만들지 않은 화면을 만들었다고 적으면
 * 이 표는 그 순간부터 쓸모가 없어진다.
 * 2026-09-03 기준 포털 저장소(`7. Portal`)에는 정적 소개 페이지 한 장뿐이며 라우팅된 화면은 없다.
 */
export const PORTAL_SCREEN_MAP: readonly ScreenBinding[] = Object.freeze(
  PORTAL_ROUTES.map((r): ScreenBinding => ({
    routeId: r.id,
    status: 'planned',
    note: '포털 저장소 미착수(2026-09-03 기준). Core 측 계약은 준비됨.',
  })),
);

function bySectionOrder(a: PortalSectionId, b: PortalSectionId): number {
  const idx = (s: PortalSectionId) => PORTAL_SECTIONS.findIndex((x) => x.id === s);
  return idx(a) - idx(b);
}

/**
 * 검사. 던지지 않고 항목 단위로 돌려준다.
 * 규칙의 무게가 다르다: **IA 밖 화면과 감사 미배선은 오류**, 빈 상태·오류 상태 누락은 경고다.
 * 전자는 보안·규제 문제이고 후자는 완성도 문제라서다.
 */
export function validateScreenMap(bindings: readonly ScreenBinding[]): ScreenIssue[] {
  const issues: ScreenIssue[] = [];
  const seen = new Set<string>();

  for (const b of bindings) {
    const route = routeById(b.routeId);
    if (!route) {
      issues.push({
        code: 'E_UNKNOWN_ROUTE', severity: 'error', routeId: b.routeId,
        messageKo: `IA(§7)에 없는 라우트를 매핑했다. 권한 검사·감사 기록을 거치지 않는 화면이 된다.`,
      });
      continue;
    }
    if (seen.has(b.routeId)) {
      issues.push({ code: 'E_DUPLICATE', severity: 'error', routeId: b.routeId, messageKo: '한 라우트에 매핑이 둘 이상이다.' });
      continue;
    }
    seen.add(b.routeId);

    const live = b.status === 'implemented';
    if (live && (b.component === undefined || b.component.length === 0)) {
      issues.push({ code: 'E_NO_COMPONENT', severity: 'error', routeId: b.routeId, messageKo: '구현으로 표시했지만 화면 위치가 없다. 근거 없는 완료 표시다.' });
    }
    if (live && requiresAuditLog(route) && b.auditWired !== true) {
      issues.push({
        code: 'E_AUDIT_UNWIRED', severity: 'error', routeId: b.routeId,
        messageKo: `${route.pii ? '개인정보 열람' : '상태 변경'} 화면인데 접근 기록 배선이 없다(§10.2).`,
      });
    }
    if (b.status === 'deferred' && (b.note === undefined || b.note.length === 0)) {
      issues.push({ code: 'E_DEFER_REASON', severity: 'error', routeId: b.routeId, messageKo: '보류에는 사유가 필요하다. 사유 없는 보류는 누락과 구분되지 않는다.' });
    }
    if (live && b.emptyState !== true) {
      issues.push({ code: 'W_NO_EMPTY_STATE', severity: 'warning', routeId: b.routeId, messageKo: '데이터 0건 화면이 확인되지 않았다(품질기준 4-3).' });
    }
    if (live && b.errorState !== true) {
      issues.push({ code: 'W_NO_ERROR_STATE', severity: 'warning', routeId: b.routeId, messageKo: '오류 안내 화면이 확인되지 않았다(품질기준 4-3).' });
    }
  }

  for (const r of PORTAL_ROUTES) {
    if (!seen.has(r.id)) {
      issues.push({ code: 'E_UNMAPPED', severity: 'error', routeId: r.id, messageKo: 'IA 에 있는 라우트의 매핑이 없다. 상태가 무엇인지 적어야 한다(미착수도 상태다).' });
    }
  }
  return issues;
}

export function screenMapOk(issues: readonly ScreenIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}

/** 상태별 **건수**. 비율을 만들지 않는다(§13-3) — 분모가 무엇인지 사람마다 다르게 읽기 때문이다. */
export interface ScreenCoverage {
  total: number;
  byStatus: Record<ScreenStatus, number>;
  /** 감사 대상(PII·상태변경) 라우트 중 구현+배선까지 끝난 건수 */
  auditRequired: number;
  auditWired: number;
}

export function screenMapCoverage(bindings: readonly ScreenBinding[]): ScreenCoverage {
  const byStatus: Record<ScreenStatus, number> = { implemented: 0, in_progress: 0, planned: 0, deferred: 0 };
  let auditRequired = 0;
  let auditWired = 0;
  for (const b of bindings) {
    const route = routeById(b.routeId);
    if (!route) continue;                 // IA 밖 화면은 진행률의 분자도 분모도 아니다.
    byStatus[b.status] += 1;
    if (requiresAuditLog(route)) {
      auditRequired += 1;
      if (b.status === 'implemented' && b.auditWired === true) auditWired += 1;
    }
  }
  return { total: PORTAL_ROUTES.length, byStatus, auditRequired, auditWired };
}

const STATUS_KO: Record<ScreenStatus, string> = {
  implemented: '구현', in_progress: '작업중', planned: '미착수', deferred: '보류',
};

/** 매핑 문서를 자료에서 생성한다. 손으로 적은 표를 두지 않는 이유는 반드시 썩기 때문이다. */
export function renderScreenMapMarkdown(bindings: readonly ScreenBinding[]): string {
  const map = new Map(bindings.map((b) => [b.routeId, b]));
  const cov = screenMapCoverage(bindings);
  const lines: string[] = [];

  lines.push('# 관리 포털 IA ↔ 화면 매핑');
  lines.push('');
  lines.push('`src/portal/ia.ts` 의 라우트 표와 실제 화면 구현을 대조한 결과다.');
  lines.push('**이 문서는 `src/portal/screenMap.ts` 에서 생성된다 — 직접 고치지 말 것.**');
  lines.push('');
  lines.push(`- 라우트 ${cov.total}건 — 구현 ${cov.byStatus.implemented} · 작업중 ${cov.byStatus.in_progress} · 미착수 ${cov.byStatus.planned} · 보류 ${cov.byStatus.deferred}`);
  lines.push(`- 감사 대상(개인정보 열람·상태 변경) ${cov.auditRequired}건 중 접근 기록 배선 완료 ${cov.auditWired}건 (§10.2)`);
  lines.push('');
  lines.push('진행률(%)은 적지 않는다. 실측 건수만 둔다(§13-3).');
  lines.push('');

  const sections = [...PORTAL_SECTIONS].sort((a, b) => bySectionOrder(a.id, b.id));
  for (const s of sections) {
    const routes = PORTAL_ROUTES.filter((r) => r.section === s.id);
    if (routes.length === 0) continue;
    lines.push(`## ${s.titleKo} (\`${s.id}\`)`);
    lines.push('');
    lines.push('| 라우트 | 경로 | 권한 | PII | 변경 | 상태 | 화면 위치 | 감사 배선 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of routes) {
      const b = map.get(r.id);
      lines.push([
        '', `\`${r.id}\``, `\`${r.path}\``, r.roles.join(', '),
        r.pii ? 'O' : '-', r.mutates ? 'O' : '-',
        b ? STATUS_KO[b.status] : '**매핑 없음**',
        b?.component ? `\`${b.component}\`` : '-',
        requiresAuditLog(r) ? (b?.auditWired ? 'O' : '필요') : '-',
        '',
      ].join(' | ').trim());
    }
    lines.push('');
  }

  const notes = bindings.filter((b) => b.note !== undefined && b.note.length > 0);
  if (notes.length > 0) {
    lines.push('## 비고');
    lines.push('');
    // 같은 메모가 라우트마다 반복되면 읽히지 않는다 — 메모 기준으로 묶는다.
    const grouped = new Map<string, string[]>();
    for (const b of notes) {
      const list = grouped.get(b.note as string) ?? [];
      list.push(b.routeId);
      grouped.set(b.note as string, list);
    }
    for (const [note, ids] of grouped) lines.push(`- ${note} — ${ids.length}건 (${ids.join(', ')})`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 검사 결과를 CI 출력용 한 줄씩으로. */
export function formatScreenMapReport(issues: readonly ScreenIssue[]): string {
  if (issues.length === 0) return 'IA↔화면 매핑: 이상 없음';
  return issues
    .map((i) => `[${i.severity === 'error' ? '오류' : '경고'}] ${i.code} (${i.routeId}) — ${i.messageKo}`)
    .join('\n');
}

export type { PortalRoute };
