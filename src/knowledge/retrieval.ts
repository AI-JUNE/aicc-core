// 질의 → 근거 파이프라인 — 설계서 §5.2(RAG)·§9.3(폴백)·§10.3(마스킹)·§11.1(테넌트 격리)·§13-3(기본값 금지).
//
// `createEmbedder().embedQuery` 는 벡터를 내놓고, `TenantVectorStore.query` 는 히트를 내놓고,
// `decideGrounding` 은 히트를 받아 근거를 판정한다. 셋 다 있는데 **그 셋을 순서대로 꿰는 코드가
// 저장소 어디에도 없었다.** 그대로 두면 채널 3곳이 같은 20줄을 각자 쓰고, 그 20줄에서 빠지는 것은
// 취향이 아니라 정해져 있다 —
//   · **스토어 장애를 '해당 내용이 없습니다'로 답한다.** 이 파이프라인에서 제일 비싼 실패다.
//     조회가 타임아웃 나면 히트가 0건이고, 0건은 `decideGrounding` 에서 `no_hits` 가 된다.
//     그 결과 고객은 "안내드릴 내용이 없습니다"를 듣고 끊고, **장애는 어디에도 집계되지 않는다**.
//     지식베이스가 통째로 내려가 있어도 그래프는 평온하다. 그래서 이 모듈은 `store_failed` 와
//     `not_grounded` 를 **절대 같은 상태로 적지 않는다**.
//   · 스토어에 넘기는 topK 와 정책의 topK 가 어긋난다(5건만 가져와 `minHits`=8 로 판정하면
//     설정 실수가 '검색 품질 문제'로 오진된다).
//   · 지식베이스 여러 개를 순차로 조회해 제한 시간이 개수만큼 곱해진다(그동안 고객은 기다린다).
//   · 같은 청크가 두 지식베이스에 있으면 **인용이 두 번 달린다**(고객 화면에 같은 출처가 [1][3] 으로).
//   · 빈 질의로 임베딩 엔진을 부른다(비용이고, §11.2 에 정체불명 사용량으로 쌓인다).
//   · 임베딩·조회 실패가 예외로 올라와 **통화가 끊긴다**(§9.3 — RAG 실패는 폴백으로 처리할 일이다).
//
// 경계:
//  1) **근거 판정을 다시 하지 않는다.** 임계값·승인 여부·만료는 전부 `decideGrounding` 이 판정한다.
//     여기서 한 번 더 거르면 §2 가 지적한 이중 관리가 RAG 규칙에서 되풀이된다.
//  2) **저장하지 않고 답하지 않는다.** 이 모듈의 출력은 `Grounded` 하나이며, 그것을 문장으로 바꾸는
//     일은 `knowledge/answer.ts` 가 한다. 판정과 생성을 한 함수에 묶으면 실패했을 때 무엇이
//     프롬프트로 나갔는지 알 수 없다.
//  3) **던지는 것은 테넌트 격리 위반 하나뿐이다.** 남의 테넌트 히트가 섞이는 것은 폴백할 사안이
//     아니다(§11.1 — `guardVectorHits` 가 예외로 드러낸다). 그 외 모든 실패는 `status` 다.
import { EngineError } from '../adapters/http.ts';
import type { EngineErrorCode } from '../adapters/http.ts';
import type { TenantScope, TenantVectorStore, VectorHit } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { Embedder } from './embedding.ts';
import type { Grounded, NotGrounded, RetrievalPolicy } from './rag.ts';
import { assertRetrievalPolicy, decideGrounding } from './rag.ts';

export const RETRIEVAL_CONTRACT_VERSION = 1;

export interface RetrieverConfig {
  scope: TenantScope;
  /** `createEmbedder` 산출물. 질의 마스킹·차원 검증은 이미 그쪽 책임이다. */
  embedder: Embedder;
  /**
   * `scopedVectorStore` 로 테넌트에 묶인 스토어만 받는다. 저수준 `VectorStore` 를 직접 받지 않는
   * 이유는 네임스페이스를 이 모듈이 만들 수 있게 되면 §11.1 의 방어선이 한 겹 사라지기 때문이다.
   */
  store: TenantVectorStore;
  /**
   * 검색 대상 지식베이스 id. **기본값 없음**(§13-3) — 빈 목록은 "전체 검색"이 아니라 설정 오류다.
   * 전체를 뜻하는 값을 두면 지식베이스를 하나 더 만든 날 조용히 검색 범위가 바뀐다.
   */
  knowledgeBaseIds: readonly string[];
  /** 지식베이스 한 곳당 조회 대기 상한(ms). 주지 않으면 제한하지 않는다(§13-3). */
  storeTimeoutMs?: number;
}

export type RetrieveStatus =
  | 'grounded'        // 근거를 만들었다
  | 'not_grounded'    // **검색은 정상이었고** 근거 기준에 못 미쳤다 — 답하지 않는 것이 맞다(§5.2)
  | 'empty_query'     // 빈 질의 — 엔진을 부르지 않았다
  | 'embed_failed'    // 질의 임베딩 실패
  | 'store_failed'    // 조회 장애 — 근거 없음과 **섞지 않는다**
  | 'config_error';   // 정책·지식베이스 선언이 성립하지 않는다

/** 지식베이스 단위 실패 기록. 어느 지식베이스가 빠졌는지 확정할 수 있어야 한다. */
export interface KnowledgeBaseFailure {
  knowledgeBaseId: string;
  code: EngineErrorCode;
  reasonKo: string;
}

export interface RetrieveUsage {
  /** 임베딩 엔진으로 나간 실측(§11.2). 토큰은 어댑터가 주지 않으므로 만들지 않는다. */
  embedChars: number;
  /** 실제로 보낸 조회 수(실패 포함). */
  storeQueries: number;
  /** 스토어가 돌려준 총 히트 수. */
  hits: number;
  /** 지식베이스 간 중복으로 걷어낸 히트 수. 0 이면 중복이 없었다는 실측이다. */
  duplicatesDropped: number;
}

export interface RetrieveResult {
  status: RetrieveStatus;
  /** `status === 'grounded'` 일 때만 채워진다. 그대로 답변 생성기로 넘긴다. */
  grounding?: Grounded;
  /** `status === 'not_grounded'` 일 때만 채워진다 — 왜 근거가 안 됐는지 그대로 싣는다. */
  notGrounded?: NotGrounded;
  failures: KnowledgeBaseFailure[];
  /**
   * 일부 지식베이스가 빠진 채 근거를 만들었다. 근거 자체는 진짜지만 **범위가 좁다** —
   * 운영 화면에서 "답은 했는데 절반만 보고 했다"를 구분하기 위한 값이다.
   */
  partial: boolean;
  reasonKo: string;
  errorCode?: EngineErrorCode;
  /** 엔진으로 나간 질의(마스킹 후). 원문은 결과 어디에도 남지 않는다(§10.3). */
  queryMasked: string;
  piiMasked: boolean;
  usage: RetrieveUsage;
  engine: { name: string; residency: Embedder['engine']['residency'] };
}

export interface Retriever {
  readonly contractVersion: number;
  readonly engine: { name: string; residency: Embedder['engine']['residency'] };
  readonly knowledgeBaseIds: readonly string[];
  retrieve(query: string, policy: RetrievalPolicy): Promise<RetrieveResult>;
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  if (timeoutMs === undefined) return p;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      const t = setTimeout(
        () => rej(new EngineError('E_TIMEOUT', 'embedding', `${label} 조회가 ${timeoutMs}ms 안에 끝나지 않았다`)),
        timeoutMs,
      );
      if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
    }),
  ]);
}

/**
 * 지식베이스 간 중복 제거. 같은 청크가 두 곳에 있으면 **점수가 높은 쪽만** 남긴다.
 * 걷어내지 않으면 `decideGrounding` 이 같은 본문에 인용 번호를 두 개 달고,
 * 고객 화면에는 같은 출처가 [1][3] 으로 두 번 뜬다.
 */
export function dedupeHits(hits: readonly VectorHit[]): { hits: VectorHit[]; dropped: number } {
  // 네임스페이스별로 한 겹 더 두는 이유는 **구분자 문자를 고르지 않기 위해서다** — 어떤 문자를 쓰든
  // 그것이 id 나 네임스페이스에 들어 있으면 서로 다른 청크가 같은 키로 뭉개진다(그리고 그 사고는
  // 검색이 조용히 한 건을 잃는 형태로만 나타난다).
  const byNamespace = new Map<string, Map<string, VectorHit>>();
  let dropped = 0;
  for (const h of hits) {
    let byId = byNamespace.get(h.namespace);
    if (byId === undefined) {
      byId = new Map<string, VectorHit>();
      byNamespace.set(h.namespace, byId);
    }
    const prev = byId.get(h.id);
    if (prev === undefined) {
      byId.set(h.id, h);
      continue;
    }
    dropped += 1;
    if (h.score > prev.score) byId.set(h.id, h);
  }
  const out: VectorHit[] = [];
  for (const byId of byNamespace.values()) for (const h of byId.values()) out.push(h);
  return { hits: out, dropped };
}

export function createRetriever(cfg: RetrieverConfig): Retriever {
  assertTenantScope(cfg.scope);
  if (cfg.store.scope.tenantId !== cfg.scope.tenantId) {
    throw new EngineError('E_CONFIG', 'config', '다른 테넌트의 벡터 스토어로 검색기를 만들 수 없다 (설계서 §11.1)');
  }
  if (!Array.isArray(cfg.knowledgeBaseIds) || cfg.knowledgeBaseIds.length === 0) {
    throw new EngineError(
      'E_CONFIG', 'config',
      'knowledgeBaseIds 가 비어 있다 — 빈 목록은 전체 검색이 아니라 설정 오류다 (설계서 §13-3)',
    );
  }
  const seen = new Set<string>();
  for (const id of cfg.knowledgeBaseIds) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new EngineError('E_CONFIG', 'config', `지식베이스 id 가 빈 문자열이다: ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      // 중복 선언은 같은 지식베이스를 두 번 조회해 비용과 중복 히트를 만든다.
      throw new EngineError('E_CONFIG', 'config', `지식베이스 id 가 중복 선언됐다: ${id}`);
    }
    seen.add(id);
  }
  if (cfg.storeTimeoutMs !== undefined && (!Number.isInteger(cfg.storeTimeoutMs) || cfg.storeTimeoutMs <= 0)) {
    throw new EngineError('E_CONFIG', 'config', `storeTimeoutMs 는 1 이상의 정수여야 한다: ${String(cfg.storeTimeoutMs)}`);
  }

  const engine = cfg.embedder.engine;
  const knowledgeBaseIds = [...cfg.knowledgeBaseIds];

  return {
    contractVersion: RETRIEVAL_CONTRACT_VERSION,
    engine,
    knowledgeBaseIds,

    async retrieve(query, policy) {
      const base = {
        failures: [] as KnowledgeBaseFailure[],
        partial: false,
        queryMasked: '',
        piiMasked: false,
        usage: { embedChars: 0, storeQueries: 0, hits: 0, duplicatesDropped: 0 },
        engine,
      };

      if (typeof query !== 'string' || query.trim() === '') {
        return { ...base, status: 'empty_query', reasonKo: '빈 질의라 엔진을 호출하지 않았다' };
      }
      // 정책 검증을 **엔진 호출 전에** 한다 — 설정 오류로 임베딩 비용을 쓰지 않기 위해서다.
      try {
        assertRetrievalPolicy(policy);
      } catch (err) {
        return {
          ...base,
          status: 'config_error',
          errorCode: 'E_CONFIG',
          reasonKo: maskPii(err instanceof Error ? err.message : String(err)).text,
        };
      }

      const q = await cfg.embedder.embedQuery(query);
      const masked = { queryMasked: q.queryMasked, piiMasked: q.piiMasked };
      const usage = { ...base.usage, embedChars: q.usage.chars };
      if (q.status !== 'ok' || q.vector === undefined) {
        return {
          ...base,
          ...masked,
          usage,
          status: q.status === 'empty_input' ? 'empty_query' : 'embed_failed',
          ...(q.failures[0] !== undefined ? { errorCode: q.failures[0].code } : {}),
          reasonKo: `질의 임베딩 실패: ${q.reasonKo}`,
        };
      }
      const vector = q.vector;

      // 지식베이스는 **동시에** 조회한다. 순차면 제한 시간이 개수만큼 곱해지고 그동안 고객이 기다린다.
      const settled = await Promise.all(knowledgeBaseIds.map(async (kbId) => {
        try {
          const hits = await withTimeout(cfg.store.query(kbId, vector, policy.topK), cfg.storeTimeoutMs, kbId);
          if (!Array.isArray(hits)) {
            // 규약을 어긴 반환값을 빈 배열로 읽으면 그 지식베이스는 영영 '내용 없음'이 된다.
            return {
              kbId,
              ok: false as const,
              code: 'E_PROTOCOL' as EngineErrorCode,
              reasonKo: '스토어가 배열이 아닌 값을 돌려줬다',
            };
          }
          return { kbId, ok: true as const, hits };
        } catch (err) {
          // 테넌트 격리 위반은 폴백할 사안이 아니다 — 그대로 던진다(§11.1).
          if (err instanceof Error && err.message.includes('§11.1')) throw err;
          const e = err instanceof EngineError ? err : undefined;
          return {
            kbId,
            ok: false as const,
            code: (e ? e.code : 'E_UNKNOWN') as EngineErrorCode,
            reasonKo: maskPii(e ? e.message : (err instanceof Error ? err.message : String(err))).text,
          };
        }
      }));

      usage.storeQueries = settled.length;
      const failures: KnowledgeBaseFailure[] = [];
      const collected: VectorHit[] = [];
      for (const s of settled) {
        if (s.ok) for (const h of s.hits) collected.push(h);
        else failures.push({ knowledgeBaseId: s.kbId, code: s.code, reasonKo: s.reasonKo });
      }
      usage.hits = collected.length;

      if (failures.length === knowledgeBaseIds.length) {
        return {
          ...base,
          ...masked,
          usage,
          failures,
          status: 'store_failed',
          ...(failures[0] !== undefined ? { errorCode: failures[0].code } : {}),
          reasonKo: `지식베이스 조회가 모두 실패했다(${failures.length}곳) — 근거 없음이 아니다`,
        };
      }

      const { hits, dropped } = dedupeHits(collected);
      usage.duplicatesDropped = dropped;

      // `decideGrounding` 이 topK 로 다시 자른다 — 지식베이스별 topK 를 합친 뒤 전체에서 고르는 것이
      // 의도한 동작이다. 스토어에 넘긴 값과 판정에 쓰는 값이 같은 `policy.topK` 라 어긋날 수 없다.
      const decision = decideGrounding(hits, cfg.scope, policy);

      if (decision.grounded) {
        return {
          ...base,
          ...masked,
          usage,
          failures,
          status: 'grounded',
          grounding: decision,
          partial: failures.length > 0,
          reasonKo: failures.length > 0
            ? `근거 ${decision.citations.length}건 — 지식베이스 ${failures.length}곳이 빠진 채 판정했다`
            : `근거 ${decision.citations.length}건`,
        };
      }

      if (failures.length > 0) {
        // **여기가 이 모듈의 핵심 한 줄이다.** 일부 지식베이스가 죽은 채 근거를 못 찾았다면
        // 그 이유가 장애일 수 있다. 그것을 `not_grounded` 로 적으면 고객은 "해당 내용이 없습니다"를
        // 듣고, 장애는 영원히 드러나지 않는다.
        return {
          ...base,
          ...masked,
          usage,
          failures,
          status: 'store_failed',
          ...(failures[0] !== undefined ? { errorCode: failures[0].code } : {}),
          reasonKo: `근거를 만들지 못했는데 지식베이스 ${failures.length}곳이 실패한 상태다 — 근거 없음으로 단정하지 않는다(${decision.reasonKo})`,
        };
      }

      return {
        ...base,
        ...masked,
        usage,
        failures,
        status: 'not_grounded',
        notGrounded: decision,
        reasonKo: decision.reasonKo,
      };
    },
  };
}
