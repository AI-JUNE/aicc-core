// 지식 색인 실행기 — 설계서 §5.2(RAG)·§6.2(엔진 비종속)·§7(운영 승인 게이트)·§10.3(마스킹)·
// §11.1(테넌트 격리)·§11.2(사용량 근거)·§13-3(기본값 금지).
//
// 바로 앞 작업(`executeKnowledge.ts`)이 "질문에 답하는 길"을 열었는데, 그러고 나니
// **그 지식베이스를 채울 길이 없다**는 것이 드러났다. 조각은 다 있다 — `prepareIngest` 가
// 청킹·마스킹·메타를 하고, `embedChunks` 가 벡터를 검증해 `VectorDoc` 까지 만들고,
// `TenantVectorStore.upsert` 가 저장한다. 그런데 **그 셋을 꿰는 코드가 저장소 어디에도 없었다**
// (`embedding.ts` 는 "저장은 하지 않는다"고 분명히 적어 두었고, 그 결정은 옳다 — 판정과 부작용을
// 한 함수에 묶으면 실패했을 때 무엇이 남았는지 알 수 없다). 그 결과 지식 색인은 **아무도 하지
// 않는 일**로 남아 있었고, 그대로 두면 운영 도구 쪽에서 30줄을 각자 쓰게 된다.
//
// 그 30줄에서 빠지는 것은 취향이 아니라 정해져 있고, 전부 **조용한 오답**이다.
//  (1) **개정으로 짧아진 문서의 옛 청크가 남는다.** 청크 id 는 `docId#idx` 라서 재색인은 0..n-1 을
//      덮어쓴다. 10 청크였던 문서가 6 청크로 개정되면 `#6`..`#9` 는 **옛 본문 그대로 남아**
//      계속 검색되고 인용된다 — 각주에는 현재 문서 제목이 붙으므로 고객도 운영자도 알 수 없고,
//      그 결과 **철회된 안내가 근거로 나간다**. 스토어 인터페이스(§6.2)에는 문서 단위 삭제가
//      없고 `purge` 는 지식베이스를 통째로 비우므로, 이 모듈이 혼자 고칠 수는 없다. 그래서
//      **확정해서 드러내고**(`orphanChunkIds`), 호스트가 삭제 수단을 주면 그걸 쓴다.
//  (2) **본문이 비워진 문서를 "0건 저장 성공"으로 적는다.** 그 순간 색인에는 **옛 본문만** 남고
//      문서는 삭제된 줄 아는 사람과 아직 답하는 봇이 공존한다. 그래서 청크 0건은 성공이 아니라
//      그 자체로 정리 대상(고아)으로 적는다.
//  (3) **부분 저장을 0건으로 적는다.** `upsert` 가 중간에 실패하면 무엇이 들어갔는지 Core 는 알
//      방법이 없다. 그때 `chunksStored: 0` 이라고 적으면 **거짓**이고, 운영자는 재시도 대신 원인을
//      찾으러 간다. 모르면 모른다고 적는다(`chunksStored` 를 비운다 — `ops/backup.ts` 가 "대조를
//      못 한 경우를 성공으로 적지 않는다"고 한 것과 같은 자리다).
//  (4) **승인 여부를 여기서 판정한다.** 미승인·만료 판정은 `decideGrounding` 한 곳이다(§7·§2).
//      색인 단계에서 또 거르면 "승인했는데 왜 안 나오지"가 두 곳을 뒤져야 하는 문제가 된다 —
//      미승인 문서도 메타데이터를 달고 저장되고, 답변 근거가 될지는 검색 정책이 정한다.
//  (5) **마스킹 전 본문을 저장한다.** `prepareIngest` 가 이미 마스킹했고 그 결과만 저장된다 —
//      여기서 원문을 다시 섞으면 지식베이스가 영구 개인정보 저장소가 된다(§10.3).
//
// 하지 않는 것: **실호출을 하지 않는다**(임베딩 엔진·벡터 스토어는 주입이며 §6.2 인터페이스 뒤다 —
// 실엔진·실 DB 연결은 [승인 필요]) · **청크 크기·차원·배치 기본값을 만들지 않는다**(§13-3) ·
// **런타임(통화 경로)에 배선하지 않는다** — 색인은 턴이 아니라 운영 작업이고, 통화 중에 지식을
// 다시 색인하는 경로를 열면 고객 응대 지연과 과금이 색인 작업에 섞인다(§11.2).
import type { EngineErrorCode } from '../adapters/http.ts';
import type { TenantScope, TenantVectorStore, VectorDoc } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { ChunkOptions, KnowledgeDoc } from './rag.ts';
import { assertChunkOptions, prepareIngest } from './rag.ts';
import type { BatchFailure, Embedder } from './embedding.ts';

export const INGEST_CONTRACT_VERSION = 1;

export interface IngestConfig {
  scope: TenantScope;
  /** `scopedVectorStore` 산출물만 받는다 — 네임스페이스를 이 모듈이 만들 수 있으면 §11.1 이 한 겹 사라진다. */
  store: TenantVectorStore;
  /** `createEmbedder` 산출물. 차원·성분·개수 검증은 이미 그쪽 책임이다. */
  embedder: Embedder;
  /** 청킹 설정. **기본값 없음**(§13-3) — 엔진·문서 성격에 따라 다르다. */
  chunk: ChunkOptions;
  /**
   * 문서 단위 청크 삭제. `TenantVectorStore` 에는 없는 능력이므로 **호스트가 줄 수 있으면** 받는다.
   * 주지 않으면 고아 청크를 지우지 않고 **드러낸다** — 지우지 못한 것을 성공으로 적지 않는다.
   */
  removeChunks?: (knowledgeBaseId: string, ids: readonly string[]) => Promise<void> | void;
}

export interface IngestDocumentInput {
  knowledgeBaseId: string;
  doc: KnowledgeDoc;
  /**
   * 직전 리비전의 청크 수. 알면 **개정으로 줄어든 문서의 고아 청크**를 확정할 수 있다.
   * 모르면 검사하지 못했다는 사실을 결과에 적는다(`staleUnchecked`) — 추측하지 않는다(§13-3).
   */
  previousChunkCount?: number;
}

export type IngestStatus =
  | 'stored'           // 저장 완료
  | 'empty_document'   // 청크가 0건 — 엔진·스토어를 부르지 않았다
  | 'embed_failed'     // 임베딩 실패 — **아무것도 저장하지 않았다**
  | 'store_failed'     // 저장 실패 — 저장 범위를 확정할 수 없다
  | 'config_error';    // 설정이 성립하지 않는다(엔진을 부르기 전에 끊었다)

export interface IngestReport {
  status: IngestStatus;
  knowledgeBaseId: string;
  docId: string;
  chunksPrepared: number;
  /**
   * 실제로 저장된 청크 수. **모르면 비운다** — `store_failed` 에서 0 으로 적으면
   * "아무것도 안 들어갔다"는 거짓 주장이 되고, 운영자는 재시도 대신 원인을 찾으러 간다.
   */
  chunksStored?: number;
  /** 저장된 청크 id(실측). 재색인이 같은 id 를 덮어쓴다는 사실의 근거다. */
  storedChunkIds: string[];
  /**
   * 직전 리비전에서 남은 청크 id. 비어 있지 않고 지우지도 못했다면 **옛 안내가 계속 인용된다**.
   */
  orphanChunkIds: string[];
  orphansRemoved: boolean;
  /** 직전 청크 수를 모르면 고아를 검사하지 못했다 — 숨기지 않고 적는다. */
  staleUnchecked: boolean;
  /** 이미 저장된 벡터와의 차원 일치를 검사하지 못했다(`expectDim` 미지정). */
  dimUncheckedAgainstIndex: boolean;
  failures: BatchFailure[];
  reasonKo: string;
  errorCode?: EngineErrorCode;
  /** 마스킹이 적용된 청크 수와 종류(§10.3 근거). 원문·치환 전 값은 담지 않는다. */
  piiMaskedChunks: number;
  piiKinds: string[];
  /** 실측만 싣는다(§11.2). 토큰은 어댑터가 주지 않으므로 만들지 않는다. */
  usage: { embedTexts: number; embedChars: number; embedBatches: number };
  engine: Embedder['engine'];
}

/**
 * 개정으로 사라진 청크 id. `docId#idx` 가 결정적이므로 **줄어든 구간만** 고아다.
 * 늘어난 경우에는 고아가 없다(새 id 는 그대로 추가된다).
 */
export function orphanChunkIds(docId: string, previousCount: number, currentCount: number): string[] {
  if (!Number.isInteger(previousCount) || previousCount <= currentCount) return [];
  const out: string[] = [];
  for (let i = currentCount; i < previousCount; i++) out.push(`${docId}#${i}`);
  return out;
}

/**
 * 문서 1건 색인. **던지는 것은 테넌트 격리 위반 하나뿐이다**(§11.1 — 남의 테넌트 지식베이스에
 * 쓰는 것은 폴백할 사안이 아니다). 그 외 모든 실패는 `status` 다: 색인 실패로 운영 도구가
 * 예외로 죽으면 **어디까지 됐는지**를 아무도 모르게 된다.
 */
export async function ingestDocument(
  cfg: IngestConfig,
  input: IngestDocumentInput,
): Promise<IngestReport> {
  assertTenantScope(cfg.scope);
  if (cfg.store.scope.tenantId !== cfg.scope.tenantId
    || (cfg.store.scope.workspaceId ?? undefined) !== (cfg.scope.workspaceId ?? undefined)) {
    // 워크스페이스까지 본다 — 테넌트만 보면 같은 고객사의 다른 사업부 지식베이스에 쓴다(§11.1).
    throw new Error('다른 테넌트·워크스페이스의 벡터 스토어에 색인할 수 없다 (설계서 §11.1)');
  }

  const base = {
    knowledgeBaseId: input.knowledgeBaseId,
    docId: typeof input.doc?.docId === 'string' ? input.doc.docId : '',
    chunksPrepared: 0,
    storedChunkIds: [] as string[],
    orphanChunkIds: [] as string[],
    orphansRemoved: false,
    staleUnchecked: input.previousChunkCount === undefined,
    dimUncheckedAgainstIndex: false,
    failures: [] as BatchFailure[],
    piiMaskedChunks: 0,
    piiKinds: [] as string[],
    usage: { embedTexts: 0, embedChars: 0, embedBatches: 0 },
    engine: cfg.embedder.engine,
  };

  // 설정·문서 형태 오류는 **엔진을 부르기 전에** 끊는다(§11.2 비용).
  let prepared;
  try {
    assertChunkOptions(cfg.chunk);
    prepared = prepareIngest(cfg.scope, input.knowledgeBaseId, input.doc, cfg.chunk);
  } catch (e) {
    return {
      ...base,
      status: 'config_error',
      errorCode: 'E_CONFIG',
      chunksStored: 0,
      reasonKo: maskPii(e instanceof Error ? e.message : String(e)).text,
    };
  }

  const stale = orphanChunkIds(base.docId, input.previousChunkCount ?? 0, prepared.length);
  const withMeta = {
    ...base,
    chunksPrepared: prepared.length,
    piiMaskedChunks: prepared.filter((c) => c.piiMasked).length,
    piiKinds: [...new Set(prepared.flatMap((c) => c.piiKinds))].sort(),
    orphanChunkIds: stale,
  };

  /** 고아 청크 정리. 삭제 수단이 없으면 **지웠다고 적지 않는다**. */
  async function cleanup(ids: readonly string[]): Promise<{ removed: boolean; noteKo: string }> {
    if (ids.length === 0) return { removed: false, noteKo: '' };
    if (typeof cfg.removeChunks !== 'function') {
      return {
        removed: false,
        noteKo: ` · 구 리비전 청크 ${ids.length}건이 남아 있습니다(삭제 수단 미주입) — `
          + '지우지 않으면 개정 전 본문이 계속 근거로 인용됩니다',
      };
    }
    try {
      await cfg.removeChunks(input.knowledgeBaseId, ids);
      return { removed: true, noteKo: ` · 구 리비전 청크 ${ids.length}건을 정리했습니다` };
    } catch (e) {
      // 정리 실패로 색인 결과를 뒤집지 않는다 — 저장은 됐고, 남은 것은 남았다고 적는다.
      return {
        removed: false,
        noteKo: ` · 구 리비전 청크 ${ids.length}건 정리에 실패했습니다(${e instanceof Error ? e.name : '알 수 없는 예외'})`,
      };
    }
  }

  if (prepared.length === 0) {
    // **0건 저장을 성공으로 적지 않는다.** 본문이 비워진 개정은 "삭제"에 가깝고, 그대로 두면
    // 색인에는 옛 본문만 남는다. 직전 청크 수를 알면 그 전부가 고아다.
    const all = orphanChunkIds(base.docId, input.previousChunkCount ?? 0, 0);
    const c = await cleanup(all);
    return {
      ...withMeta,
      orphanChunkIds: all,
      orphansRemoved: c.removed,
      status: 'empty_document',
      chunksStored: 0,
      reasonKo: `본문에서 청크를 만들지 못해 저장하지 않았습니다 — 기존 색인은 그대로입니다${c.noteKo}`,
    };
  }

  const embedded = await cfg.embedder.embedChunks(prepared);
  const withUsage = {
    ...withMeta,
    dimUncheckedAgainstIndex: embedded.dimUncheckedAgainstIndex,
    failures: embedded.failures,
    usage: {
      embedTexts: embedded.usage.texts,
      embedChars: embedded.usage.chars,
      embedBatches: embedded.usage.batches,
    },
  };

  if (embedded.status !== 'ok' || embedded.docs.length === 0) {
    // 임베딩이 어긋나면 **아무것도 저장하지 않는다**(`embedChunks` 가 docs 를 비워 둔다).
    // 고아도 지우지 않는다 — 새 본문이 들어가지 않은 상태에서 옛 청크까지 지우면
    // 그 문서는 **색인에서 통째로 사라진다**(답할 수 있던 질문에 못 답하게 된다).
    return {
      ...withUsage,
      status: 'embed_failed',
      chunksStored: 0,
      ...(embedded.failures[0] !== undefined ? { errorCode: embedded.failures[0].code } : {}),
      reasonKo: `임베딩 실패로 저장하지 않았습니다: ${embedded.reasonKo}`,
    };
  }

  const docs: VectorDoc[] = embedded.docs;
  try {
    await cfg.store.upsert(input.knowledgeBaseId, docs);
  } catch (e) {
    if (e instanceof Error && e.message.includes('§11.1')) throw e;
    return {
      ...withUsage,
      status: 'store_failed',
      // **chunksStored 를 적지 않는다** — 어디까지 들어갔는지 알 방법이 없다(위 (3)).
      reasonKo: `저장에 실패했습니다(${e instanceof Error ? e.name : '알 수 없는 예외'}) — `
        + '저장 범위를 확정할 수 없어 들어간 건수를 적지 않습니다. 같은 입력으로 재색인하면 같은 청크 id 를 덮어씁니다',
      ...(e instanceof Error && 'code' in e ? { errorCode: (e as { code: EngineErrorCode }).code } : {}),
    };
  }

  // 저장이 끝난 **뒤에** 고아를 지운다. 먼저 지우면 저장이 실패했을 때 그 문서의 뒷부분이
  // 색인에서 사라진 채 남는다(옛 본문이 인용되는 것보다 나쁘다 — 답을 아예 못 하게 된다).
  const c = await cleanup(stale);
  return {
    ...withUsage,
    status: 'stored',
    chunksStored: docs.length,
    storedChunkIds: docs.map((d) => d.id),
    orphansRemoved: c.removed,
    reasonKo: `청크 ${docs.length}건을 저장했습니다${c.noteKo}`,
  };
}
