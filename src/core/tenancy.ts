// 멀티테넌시 격리 규약 — 설계서 §11.1.
// "테넌트 간 데이터가 섞이면 사업이 끝난다." 특히 RAG는 네임스페이스를 분리하지 않으면
// A사 지식이 B사 답변에 섞여 나가는 사고가 조용히 발생한다. 그래서 격리는 관례가 아니라 타입으로 강제한다.
//
// 규약 3줄 요약
//  1) 모든 저장·조회 경로는 TenantScope를 받는다. tenant_id 없는 접근 경로를 만들지 않는다.
//  2) 벡터 인덱스는 테넌트별 네임스페이스로만 접근한다(공용 인덱스 + 메타필터 방식 금지 — 필터 누락이 곧 유출).
//  3) 조회 결과는 반환 직후 네임스페이스를 재검증한다(방어적 이중 확인).

/** 파티션 키로 그대로 쓰이므로 구분자(`/`)·대문자·공백을 허용하지 않는다. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export interface TenantScope {
  tenantId: string;
  /** 테넌트 하위 격리 단위(부서·브랜드 등). 없으면 테넌트 전역. */
  workspaceId?: string;
}

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function assertTenantScope(scope: TenantScope): void {
  if (!scope || !scope.tenantId) {
    throw new Error('tenant_id 없는 접근은 허용되지 않는다 (설계서 §11.1)');
  }
  if (!isValidId(scope.tenantId)) {
    throw new Error(`tenant_id 형식 위반: ${JSON.stringify(scope.tenantId)} (설계서 §11.1)`);
  }
  if (scope.workspaceId !== undefined && !isValidId(scope.workspaceId)) {
    throw new Error(`workspace_id 형식 위반: ${JSON.stringify(scope.workspaceId)} (설계서 §11.1)`);
  }
}

/** 스토리지 파티션 키. 모든 테이블·버킷·큐의 1차 키 접두사로 쓴다. */
export function partitionKey(scope: TenantScope): string {
  assertTenantScope(scope);
  return scope.workspaceId ? `t/${scope.tenantId}/w/${scope.workspaceId}` : `t/${scope.tenantId}`;
}

/** 벡터 네임스페이스. 지식베이스는 반드시 테넌트 파티션 아래에 매달린다. */
export function vectorNamespace(scope: TenantScope, knowledgeBaseId: string): string {
  if (!isValidId(knowledgeBaseId)) {
    throw new Error(`knowledge_base_id 형식 위반: ${JSON.stringify(knowledgeBaseId)} (설계서 §11.1)`);
  }
  return `${partitionKey(scope)}/kb/${knowledgeBaseId}`;
}

export interface ParsedNamespace {
  tenantId: string;
  workspaceId?: string;
  knowledgeBaseId: string;
}

export function parseVectorNamespace(ns: string): ParsedNamespace {
  const withWs = /^t\/([^/]+)\/w\/([^/]+)\/kb\/([^/]+)$/.exec(ns);
  if (withWs) return { tenantId: withWs[1]!, workspaceId: withWs[2]!, knowledgeBaseId: withWs[3]! };
  const bare = /^t\/([^/]+)\/kb\/([^/]+)$/.exec(ns);
  if (bare) return { tenantId: bare[1]!, knowledgeBaseId: bare[2]! };
  throw new Error(`네임스페이스 형식을 해석할 수 없다: ${JSON.stringify(ns)} (설계서 §11.1)`);
}

/** 네임스페이스가 해당 스코프 소유인지 판정. workspace 스코프는 상위 테넌트 스코프에 포함된다. */
export function namespaceBelongsTo(ns: string, scope: TenantScope): boolean {
  let p: ParsedNamespace;
  try {
    p = parseVectorNamespace(ns);
  } catch {
    return false;
  }
  if (p.tenantId !== scope.tenantId) return false;
  if (scope.workspaceId !== undefined && p.workspaceId !== scope.workspaceId) return false;
  return true;
}

// ── 벡터 스토어 어댑터 (§6.2 — 엔진/DB 종속 코드는 이 인터페이스 뒤에만 둔다) ──────────────

export interface VectorDoc {
  id: string;
  /** 저장 전 §10.3 마스킹을 통과한 텍스트만 넣는다. */
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorHit {
  id: string;
  score: number;
  namespace: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

/** 저수준 스토어: 네임스페이스를 인자로 받는다. Core 코드가 직접 호출하지 않는다. */
export interface VectorStore {
  upsert(namespace: string, docs: VectorDoc[]): Promise<void>;
  query(namespace: string, embedding: number[], topK: number): Promise<VectorHit[]>;
  deleteNamespace(namespace: string): Promise<void>;
}

/** 고수준 스토어: 네임스페이스를 만들 수 없다. 호출자는 지식베이스 id만 지정한다. */
export interface TenantVectorStore {
  readonly scope: TenantScope;
  upsert(knowledgeBaseId: string, docs: VectorDoc[]): Promise<void>;
  query(knowledgeBaseId: string, embedding: number[], topK: number): Promise<VectorHit[]>;
  purge(knowledgeBaseId: string): Promise<void>;
}

/**
 * 조회 결과 재검증. 스토어 구현이 필터를 빠뜨리거나 네임스페이스를 잘못 다뤄도
 * 교차 테넌트 결과가 프롬프트까지 흘러가지 않도록 여기서 끊는다.
 * 유출 후보는 조용히 버리지 않고 예외로 드러낸다 — 침묵은 사고를 늦게 발견하게 만든다.
 */
export function guardVectorHits(hits: VectorHit[], scope: TenantScope): VectorHit[] {
  assertTenantScope(scope);
  const foreign = hits.filter((h) => !namespaceBelongsTo(h.namespace, scope));
  if (foreign.length) {
    const ns = [...new Set(foreign.map((h) => h.namespace))].join(', ');
    throw new Error(
      `교차 테넌트 검색 결과 차단: scope=${partitionKey(scope)} 외부 네임스페이스=${ns} (설계서 §11.1)`,
    );
  }
  return hits;
}

/** 저수준 스토어를 테넌트에 묶는다. 이 래퍼 밖에서 VectorStore를 직접 쓰지 말 것. */
export function scopedVectorStore(store: VectorStore, scope: TenantScope): TenantVectorStore {
  assertTenantScope(scope);
  return {
    scope,
    async upsert(knowledgeBaseId, docs) {
      await store.upsert(vectorNamespace(scope, knowledgeBaseId), docs);
    },
    async query(knowledgeBaseId, embedding, topK) {
      const ns = vectorNamespace(scope, knowledgeBaseId);
      return guardVectorHits(await store.query(ns, embedding, topK), scope);
    },
    async purge(knowledgeBaseId) {
      await store.deleteNamespace(vectorNamespace(scope, knowledgeBaseId));
    },
  };
}

// ── 레코드 격리 ────────────────────────────────────────────────────────────────

export interface TenantOwned {
  tenantId: string;
  workspaceId?: string;
}

/** 읽어온 레코드가 스코프 소유인지 확인. 한 건이라도 남의 것이면 전량 실패시킨다. */
export function assertOwned(records: readonly TenantOwned[], scope: TenantScope, context: string): void {
  assertTenantScope(scope);
  const bad = records.find(
    (r) =>
      r.tenantId !== scope.tenantId ||
      (scope.workspaceId !== undefined && r.workspaceId !== undefined && r.workspaceId !== scope.workspaceId),
  );
  if (bad) {
    throw new Error(`테넌트 격리 위반(${context}): 기대=${scope.tenantId} 실제=${bad.tenantId} (설계서 §11.1)`);
  }
}

/** 조회 조건에 테넌트 파티션을 강제로 주입한다. 호출자가 조건을 덮어쓸 수 없다. */
export function scopedFilter<T extends Record<string, unknown>>(
  scope: TenantScope,
  filter: T,
): T & { tenantId: string; workspaceId?: string } {
  assertTenantScope(scope);
  return {
    ...filter,
    tenantId: scope.tenantId,
    ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
  };
}
