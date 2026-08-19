// 관리 포털 정보구조(IA) — 설계서 §7.
// 화면이 아니라 "권한이 붙은 라우트 목록"이 원본이다. 프런트·게이트웨이·감사로그가 이 표를 공유한다.
// 여기에는 목표치·성능 수치를 두지 않는다(§13-3). 지표는 §8.1 이벤트 실측에서만 나온다.

export type PortalSectionId =
  | 'dashboard'      // 7.1 대시보드
  | 'interactions'   // 7.2 상호작용 조회
  | 'studio'         // 7.3 시나리오 스튜디오
  | 'operations'     // 7.4 운영
  | 'qa'             // 7.5 QA·품질
  | 'reports'        // 7.6 리포트
  | 'settings';      // 7.7 설정

/** 최소권한 원칙(§10). 상위 역할이 하위를 자동 포함하지 않는다 — 포함 관계는 명시적으로 둔다. */
export type PortalRole =
  | 'tenant_owner'
  | 'admin'
  | 'supervisor'
  | 'agent'
  | 'analyst'
  | 'auditor';

/** 역할이 실제로 보유하는 역할 집합(명시적 포함). 게이트웨이 인가 판정의 유일한 근거다. */
export const ROLE_IMPLIES: Record<PortalRole, PortalRole[]> = {
  tenant_owner: ['tenant_owner', 'admin', 'supervisor', 'analyst', 'auditor'],
  admin: ['admin', 'supervisor', 'analyst'],
  supervisor: ['supervisor', 'agent'],
  agent: ['agent'],
  analyst: ['analyst'],
  auditor: ['auditor'],
};

export interface PortalSection {
  id: PortalSectionId;
  titleKo: string;
  /** 좌측 내비게이션 노출 순서 */
  order: number;
  /** 섹션 진입 가능 역할 */
  roles: PortalRole[];
}

export interface PortalRoute {
  /** 라우트 키 — 감사로그·권한표의 식별자 */
  id: string;
  section: PortalSectionId;
  path: string;
  titleKo: string;
  roles: PortalRole[];
  /** 개인정보 원문 열람을 수반하는 화면 — 접근 시 감사로그 필수(§10.3) */
  pii: boolean;
  /** 상태를 바꾸는 화면 — 승인·이력 대상 */
  mutates: boolean;
  /** 내비게이션 비노출(상세·모달 등) */
  hidden?: boolean;
}

export const PORTAL_SECTIONS: PortalSection[] = [
  { id: 'dashboard', titleKo: '대시보드', order: 1, roles: ['tenant_owner', 'admin', 'supervisor', 'analyst'] },
  { id: 'interactions', titleKo: '상호작용', order: 2, roles: ['tenant_owner', 'admin', 'supervisor', 'agent', 'auditor'] },
  { id: 'studio', titleKo: '시나리오 스튜디오', order: 3, roles: ['tenant_owner', 'admin'] },
  { id: 'operations', titleKo: '운영', order: 4, roles: ['tenant_owner', 'admin', 'supervisor'] },
  { id: 'qa', titleKo: 'QA·품질', order: 5, roles: ['tenant_owner', 'admin', 'supervisor'] },
  { id: 'reports', titleKo: '리포트', order: 6, roles: ['tenant_owner', 'admin', 'analyst', 'auditor'] },
  { id: 'settings', titleKo: '설정', order: 7, roles: ['tenant_owner', 'admin'] },
];

export const PORTAL_ROUTES: PortalRoute[] = [
  // 7.1 대시보드 — 채널별이 아니라 Interaction 단위로 본다(§4)
  { id: 'dashboard.overview', section: 'dashboard', path: '/dashboard', titleKo: '실시간 현황', roles: ['tenant_owner', 'admin', 'supervisor', 'analyst'], pii: false, mutates: false },
  { id: 'dashboard.outcomes', section: 'dashboard', path: '/dashboard/outcomes', titleKo: '처리결과 분포', roles: ['tenant_owner', 'admin', 'supervisor', 'analyst'], pii: false, mutates: false },

  // 7.2 상호작용 — 채널 혼합 세션을 하나의 타임라인으로
  { id: 'interactions.list', section: 'interactions', path: '/interactions', titleKo: '상호작용 목록', roles: ['tenant_owner', 'admin', 'supervisor', 'agent', 'auditor'], pii: false, mutates: false },
  { id: 'interactions.detail', section: 'interactions', path: '/interactions/:interactionId', titleKo: '대화 상세', roles: ['tenant_owner', 'admin', 'supervisor', 'agent', 'auditor'], pii: true, mutates: false, hidden: true },
  { id: 'interactions.handoff', section: 'interactions', path: '/interactions/:interactionId/handoff', titleKo: '이관 요약', roles: ['tenant_owner', 'admin', 'supervisor', 'agent'], pii: true, mutates: false, hidden: true },

  // 7.3 스튜디오 — 하나의 Flow를 채널 렌더러로 배포(§5.3)
  { id: 'studio.flows', section: 'studio', path: '/studio/flows', titleKo: '시나리오 목록', roles: ['tenant_owner', 'admin'], pii: false, mutates: false },
  { id: 'studio.editor', section: 'studio', path: '/studio/flows/:flowId', titleKo: '시나리오 편집', roles: ['tenant_owner', 'admin'], pii: false, mutates: true, hidden: true },
  { id: 'studio.validate', section: 'studio', path: '/studio/flows/:flowId/validate', titleKo: '검증 결과', roles: ['tenant_owner', 'admin'], pii: false, mutates: false, hidden: true },
  { id: 'studio.simulate', section: 'studio', path: '/studio/flows/:flowId/simulate', titleKo: '시뮬레이션', roles: ['tenant_owner', 'admin'], pii: false, mutates: false, hidden: true },
  { id: 'studio.publish', section: 'studio', path: '/studio/flows/:flowId/publish', titleKo: '배포', roles: ['tenant_owner', 'admin'], pii: false, mutates: true, hidden: true },
  { id: 'studio.knowledge', section: 'studio', path: '/studio/knowledge', titleKo: '지식(RAG) 소스', roles: ['tenant_owner', 'admin'], pii: false, mutates: true },

  // 7.4 운영
  { id: 'operations.queues', section: 'operations', path: '/operations/queues', titleKo: '큐·이관 정책', roles: ['tenant_owner', 'admin', 'supervisor'], pii: false, mutates: true },
  { id: 'operations.campaigns', section: 'operations', path: '/operations/campaigns', titleKo: '아웃바운드 캠페인', roles: ['tenant_owner', 'admin'], pii: true, mutates: true },
  { id: 'operations.disclosure', section: 'operations', path: '/operations/ai-disclosure', titleKo: 'AI 고지 문구', roles: ['tenant_owner', 'admin'], pii: false, mutates: true },
  { id: 'operations.health', section: 'operations', path: '/operations/health', titleKo: '연동 상태', roles: ['tenant_owner', 'admin', 'supervisor'], pii: false, mutates: false },

  // 7.5 QA
  { id: 'qa.review', section: 'qa', path: '/qa/review', titleKo: '대화 리뷰', roles: ['tenant_owner', 'admin', 'supervisor'], pii: true, mutates: true },
  { id: 'qa.testsets', section: 'qa', path: '/qa/testsets', titleKo: '회귀 테스트셋', roles: ['tenant_owner', 'admin'], pii: false, mutates: true },

  // 7.6 리포트
  { id: 'reports.builder', section: 'reports', path: '/reports', titleKo: '리포트', roles: ['tenant_owner', 'admin', 'analyst', 'auditor'], pii: false, mutates: false },
  { id: 'reports.export', section: 'reports', path: '/reports/export', titleKo: '내보내기', roles: ['tenant_owner', 'admin', 'analyst'], pii: false, mutates: true },
  { id: 'reports.audit', section: 'reports', path: '/reports/audit-log', titleKo: '감사로그', roles: ['tenant_owner', 'auditor'], pii: false, mutates: false },

  // 7.7 설정
  { id: 'settings.tenant', section: 'settings', path: '/settings/tenant', titleKo: '테넌트', roles: ['tenant_owner', 'admin'], pii: false, mutates: true },
  { id: 'settings.members', section: 'settings', path: '/settings/members', titleKo: '사용자·권한', roles: ['tenant_owner', 'admin'], pii: true, mutates: true },
  { id: 'settings.engines', section: 'settings', path: '/settings/engines', titleKo: '엔진 어댑터', roles: ['tenant_owner', 'admin'], pii: false, mutates: true },
  { id: 'settings.retention', section: 'settings', path: '/settings/retention', titleKo: '보존·파기 정책', roles: ['tenant_owner', 'admin'], pii: false, mutates: true },
];

/** 보유 역할 집합 전개 */
export function effectiveRoles(roles: PortalRole[]): Set<PortalRole> {
  const out = new Set<PortalRole>();
  for (const r of roles) for (const g of ROLE_IMPLIES[r] ?? [r]) out.add(g);
  return out;
}

export function canAccess(route: PortalRoute, roles: PortalRole[]): boolean {
  const has = effectiveRoles(roles);
  return route.roles.some(r => has.has(r));
}

/** 좌측 내비게이션 — 접근 가능한 라우트가 하나도 없는 섹션은 감춘다. */
export interface NavSection { section: PortalSection; routes: PortalRoute[] }

export function buildNav(roles: PortalRole[]): NavSection[] {
  const has = effectiveRoles(roles);
  return PORTAL_SECTIONS
    .filter(s => s.roles.some(r => has.has(r)))
    .sort((a, b) => a.order - b.order)
    .map(section => ({
      section,
      routes: PORTAL_ROUTES.filter(r => r.section === section.id && !r.hidden && canAccess(r, roles)),
    }))
    .filter(n => n.routes.length > 0);
}

export function routeById(id: string): PortalRoute | undefined {
  return PORTAL_ROUTES.find(r => r.id === id);
}

/** PII 화면 접근은 예외 없이 감사로그 대상이다(§10.3). */
export function requiresAuditLog(route: PortalRoute): boolean {
  return route.pii || route.mutates;
}
