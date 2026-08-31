// 지식 검색·근거(RAG) 규약 — 설계서 §5.2(지식 기반 응답)·§11.1(테넌트 격리)·§10.3(마스킹)·§7(운영 승인).
//
// 이 모듈이 지키는 것은 딱 세 가지다.
//  1) 근거 없이 답하지 않는다. 검색 결과가 임계에 못 미치면 LLM 자유 생성으로 넘기지 않고 §5.1 폴백으로 내린다.
//  2) 남의 테넌트 문서가 프롬프트에 섞이지 않는다(§11.1 guardVectorHits 재검증).
//  3) 인제스트·프롬프트 양쪽 모두 마스킹을 통과한 텍스트만 다룬다(§10.3).
//
// 임계값·topK 같은 수치는 기본값을 코드에 박지 않는다. 실측 튜닝 전의 숫자는 근거 없는 KPI가 된다(§13-3).
// 호출자가 테넌트 설정으로 명시 주입해야 하며, 누락되면 예외로 끊는다.
//
// 임베딩·벡터 엔진 자체는 어댑터 뒤에만 둔다(§6.2). 여기에는 엔진 종속 코드가 없다.

import { maskPii } from '../core/policyGuard.ts';
import { decideFallback, type FallbackAction } from '../core/session.ts';
import {
  assertTenantScope,
  guardVectorHits,
  vectorNamespace,
  type TenantScope,
  type VectorDoc,
  type VectorHit,
} from '../core/tenancy.ts';

// ── 인제스트 ──────────────────────────────────────────────────────────────────

export interface KnowledgeDoc {
  docId: string;
  title: string;
  text: string;
  /** 원문 위치. 관리자 확인용이며 고객 노출 여부는 채널 렌더러가 정한다(§5.3). */
  sourceUri?: string;
  updatedAt: string; // ISO8601
  /** 운영자 승인 여부. 미승인 문서는 답변 근거로 쓰지 않는다(§7 운영 승인 게이트). */
  approved: boolean;
  /** 문서 유효기한. 지난 문서는 근거에서 제외한다(보존·파기는 §8.2가 따로 판정). */
  expiresAt?: string;
}

export interface ChunkOptions {
  /** 청크 최대 길이(문자). 테넌트·엔진별로 다르므로 기본값을 두지 않는다(§13-3). */
  maxChars: number;
  /** 청크 간 겹침(문자). 0 이상, maxChars 미만. */
  overlapChars: number;
}

export function assertChunkOptions(o: ChunkOptions): void {
  if (!Number.isInteger(o.maxChars) || o.maxChars <= 0) {
    throw new Error(`maxChars는 1 이상의 정수여야 한다: ${String(o.maxChars)} (설계서 §5.2)`);
  }
  if (!Number.isInteger(o.overlapChars) || o.overlapChars < 0 || o.overlapChars >= o.maxChars) {
    throw new Error(`overlapChars는 0 이상 maxChars 미만이어야 한다: ${String(o.overlapChars)} (설계서 §5.2)`);
  }
}

/**
 * 문단 경계를 우선 존중하는 청킹. 문단 하나가 maxChars를 넘으면 그 문단만 강제 분할한다.
 * 문장이 잘리면 검색 품질이 떨어지고, 잘린 조각이 그대로 답변 근거로 인용되면 오해를 만든다.
 */
export function chunkText(text: string, o: ChunkOptions): string[] {
  assertChunkOptions(o);
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const units: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= o.maxChars) {
      units.push(p);
      continue;
    }
    const step = o.maxChars - o.overlapChars;
    for (let i = 0; i < p.length; i += step) {
      const piece = p.slice(i, i + o.maxChars);
      units.push(piece);
      if (i + o.maxChars >= p.length) break;
    }
  }

  const chunks: string[] = [];
  let buf = '';
  for (const u of units) {
    if (!buf) {
      buf = u;
    } else if (buf.length + 2 + u.length <= o.maxChars) {
      buf = `${buf}\n\n${u}`;
    } else {
      chunks.push(buf);
      buf = u;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export interface ChunkMetadata {
  tenantId: string;
  workspaceId?: string;
  knowledgeBaseId: string;
  docId: string;
  title: string;
  sourceUri?: string;
  updatedAt: string;
  approved: boolean;
  expiresAt?: string;
  chunkIndex: number;
}

export interface PreparedChunk {
  id: string;
  /** §10.3 마스킹을 통과한 본문만 담는다. 원문은 여기에 남지 않는다. */
  text: string;
  piiMasked: boolean;
  piiKinds: string[];
  metadata: ChunkMetadata;
}

/**
 * 인제스트 준비 — 청킹 + 마스킹 + 테넌트 메타 부착.
 * 임베딩 계산은 어댑터의 몫이므로 여기서 하지 않는다(§6.2).
 */
export function prepareIngest(
  scope: TenantScope,
  knowledgeBaseId: string,
  doc: KnowledgeDoc,
  o: ChunkOptions,
): PreparedChunk[] {
  assertTenantScope(scope);
  vectorNamespace(scope, knowledgeBaseId); // 네임스페이스 형식 위반을 인제스트 입구에서 끊는다(§11.1)
  if (!doc.docId) throw new Error('docId 없는 문서는 인제스트할 수 없다 (설계서 §5.2)');

  return chunkText(doc.text, o).map((raw, idx) => {
    const m = maskPii(raw);
    return {
      id: `${doc.docId}#${idx}`,
      text: m.text,
      piiMasked: m.masked,
      piiKinds: m.hits,
      metadata: {
        tenantId: scope.tenantId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        knowledgeBaseId,
        docId: doc.docId,
        title: doc.title,
        ...(doc.sourceUri !== undefined ? { sourceUri: doc.sourceUri } : {}),
        updatedAt: doc.updatedAt,
        approved: doc.approved,
        ...(doc.expiresAt !== undefined ? { expiresAt: doc.expiresAt } : {}),
        chunkIndex: idx,
      },
    };
  });
}

/** 준비된 청크 + 어댑터가 만든 임베딩 → 스토어 입력. 개수가 어긋나면 조용히 밀리지 않게 끊는다. */
export function toVectorDocs(chunks: readonly PreparedChunk[], embeddings: readonly number[][]): VectorDoc[] {
  if (chunks.length !== embeddings.length) {
    throw new Error(`청크(${chunks.length})와 임베딩(${embeddings.length}) 개수가 다르다 (설계서 §5.2)`);
  }
  return chunks.map((c, i) => ({
    id: c.id,
    text: c.text,
    embedding: embeddings[i] as number[],
    metadata: { ...c.metadata, pii_masked: c.piiMasked, pii_kinds: c.piiKinds },
  }));
}

// ── 검색·근거 판정 ────────────────────────────────────────────────────────────

export interface RetrievalPolicy {
  /** 상위 몇 건까지 근거 후보로 볼지. 기본값 없음 — 테넌트 설정 주입(§13-3). */
  topK: number;
  /** 근거로 인정할 최소 유사도. 실측 튜닝값만 넣는다. */
  minScore: number;
  /** 근거로 인정할 최소 히트 수. */
  minHits: number;
  /** 프롬프트에 실을 근거 본문 총 길이 상한(문자). */
  maxContextChars: number;
  /** 미승인 문서 허용 여부. 기본 불가 — 운영 승인 전 문서는 고객 답변 근거가 될 수 없다(§7). */
  allowUnapproved?: boolean;
  /** 만료 판정 기준 시각(ISO8601). 미지정 시 만료 검사를 건너뛴다. */
  now?: string;
}

export function assertRetrievalPolicy(p: RetrievalPolicy): void {
  const pos = (v: unknown, k: string) => {
    if (!Number.isInteger(v) || (v as number) <= 0) {
      throw new Error(`${k}는 1 이상의 정수여야 한다(테넌트 설정 주입 필수): ${String(v)} (설계서 §5.2·§13-3)`);
    }
  };
  pos(p.topK, 'topK');
  pos(p.minHits, 'minHits');
  pos(p.maxContextChars, 'maxContextChars');
  if (typeof p.minScore !== 'number' || Number.isNaN(p.minScore)) {
    throw new Error(`minScore는 실측 기반 수치여야 한다: ${String(p.minScore)} (설계서 §5.2·§13-3)`);
  }
  if (p.minHits > p.topK) {
    throw new Error(`minHits(${p.minHits})가 topK(${p.topK})보다 클 수 없다 (설계서 §5.2)`);
  }
}

export interface Citation {
  /** 프롬프트·화면에 쓰는 인용 번호(1부터). */
  marker: number;
  chunkId: string;
  docId: string;
  title: string;
  sourceUri?: string;
  updatedAt?: string;
  score: number;
}

export type NoGroundReason = 'no_hits' | 'no_approved_source' | 'below_threshold' | 'empty_context';

export interface Grounded {
  grounded: true;
  /** 프롬프트에 그대로 넣는 근거 블록. 각 블록 머리에 [n] 인용 번호가 붙는다. */
  context: string;
  citations: Citation[];
  /** 길이 상한 때문에 제외된 히트 수. 운영에서 상한 조정 신호로 쓴다. */
  droppedForLength: number;
}

export interface NotGrounded {
  grounded: false;
  reason: NoGroundReason;
  reasonKo: string;
  /** 걸러진 사유별 건수 — 운영 화면에서 "왜 답을 못 했는가"를 설명하기 위한 값. */
  filtered: { unapproved: number; expired: number; missingMetadata: number; belowScore: number };
}

export type GroundingDecision = Grounded | NotGrounded;

function readStr(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = meta?.[key];
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * 검색 결과 → 근거 판정.
 * 통과하지 못하면 근거 없는 답변을 만들지 않고 폴백으로 넘긴다 — 이것이 §5.2의 핵심이다.
 * 교차 테넌트 히트는 여기서 예외로 터진다(조용히 버리지 않는다, §11.1).
 */
export function decideGrounding(
  hits: readonly VectorHit[],
  scope: TenantScope,
  policy: RetrievalPolicy,
): GroundingDecision {
  assertRetrievalPolicy(policy);
  const safe = guardVectorHits([...hits], scope);
  const filtered = { unapproved: 0, expired: 0, missingMetadata: 0, belowScore: 0 };

  if (safe.length === 0) {
    return { grounded: false, reason: 'no_hits', reasonKo: '검색 결과가 없다', filtered };
  }

  const nowMs = policy.now ? Date.parse(policy.now) : Number.NaN;
  const usable = safe.filter((h) => {
    const meta = h.metadata as Record<string, unknown> | undefined;
    const docId = readStr(meta, 'docId');
    const title = readStr(meta, 'title');
    if (!docId || !title) {
      filtered.missingMetadata += 1;
      return false;
    }
    if (meta?.['approved'] !== true && !policy.allowUnapproved) {
      filtered.unapproved += 1;
      return false;
    }
    const exp = readStr(meta, 'expiresAt');
    if (exp && !Number.isNaN(nowMs)) {
      const expMs = Date.parse(exp);
      if (!Number.isNaN(expMs) && expMs <= nowMs) {
        filtered.expired += 1;
        return false;
      }
    }
    return true;
  });

  if (usable.length === 0) {
    return {
      grounded: false,
      reason: 'no_approved_source',
      reasonKo: '승인·유효 상태의 근거 문서가 없다',
      filtered,
    };
  }

  const ranked = [...usable].sort((a, b) => b.score - a.score).slice(0, policy.topK);
  const passing = ranked.filter((h) => {
    if (h.score < policy.minScore) {
      filtered.belowScore += 1;
      return false;
    }
    return true;
  });

  if (passing.length < policy.minHits) {
    return {
      grounded: false,
      reason: 'below_threshold',
      reasonKo: `근거 신뢰도 미달 — 통과 ${passing.length}건 < 최소 ${policy.minHits}건`,
      filtered,
    };
  }

  const citations: Citation[] = [];
  const blocks: string[] = [];
  let used = 0;
  let droppedForLength = 0;

  for (const h of passing) {
    const meta = h.metadata as Record<string, unknown> | undefined;
    // 스토어에 무엇이 들어 있든 프롬프트 직전에 한 번 더 마스킹한다(§10.3 이중 방어).
    const body = maskPii(h.text ?? '').text.trim();
    if (!body) {
      droppedForLength += 1;
      continue;
    }
    const marker = citations.length + 1;
    const block = `[${marker}] ${body}`;
    if (used + block.length > policy.maxContextChars) {
      droppedForLength += 1;
      continue;
    }
    used += block.length;
    blocks.push(block);
    citations.push({
      marker,
      chunkId: h.id,
      docId: readStr(meta, 'docId') as string,
      title: readStr(meta, 'title') as string,
      ...(readStr(meta, 'sourceUri') !== undefined ? { sourceUri: readStr(meta, 'sourceUri') as string } : {}),
      ...(readStr(meta, 'updatedAt') !== undefined ? { updatedAt: readStr(meta, 'updatedAt') as string } : {}),
      score: h.score,
    });
  }

  if (citations.length < policy.minHits) {
    return {
      grounded: false,
      reason: 'empty_context',
      reasonKo: `근거 본문을 길이 상한(${policy.maxContextChars}자) 안에 담지 못했다`,
      filtered,
    };
  }

  return { grounded: true, context: blocks.join('\n\n'), citations, droppedForLength };
}

/**
 * 근거가 없을 때의 행동 — §5.1 폴백 사다리를 그대로 재사용한다.
 * "모르면 상담사로" 경로를 RAG가 따로 발명하지 않게 한다.
 */
export function groundingFallback(failCount: number, visualAvailable: boolean): FallbackAction {
  return decideFallback(failCount, visualAvailable);
}

/** 답변 말미에 붙일 출처 표기. 문구 자체는 테넌트가 관리한다(§7.4·§10.1) — 여기서는 목록만 만든다. */
export function formatCitations(citations: readonly Citation[]): string[] {
  return citations.map((c) => `[${c.marker}] ${c.title}${c.sourceUri ? ` (${c.sourceUri})` : ''}`);
}
