// 임베딩 배선 — 설계서 §5.2(RAG)·§6.2(엔진 비종속)·§10.3(마스킹·국외이전)·§11.2(과금 근거)·§13-3(기본값 금지).
//
// `rag.ts` 는 `prepareIngest` 로 청크를 만들고 `toVectorDocs(chunks, embeddings)` 로 저장 입력을
// 만든다. 그런데 **가운데 `embeddings` 를 만드는 자리가 없었다** — §6.2 의 `EmbeddingAdapter` 는
// 선언만 되어 있고 저장소 어디에서도 호출되지 않는다. 그 자리를 각 저장소가 채우면 이렇게 된다:
//
//   const vecs = await embedding.embed(chunks.map(c => c.text));
//   await store.upsert(kbId, toVectorDocs(chunks, vecs));
//
// 두 줄이고, 두 줄 안에 사고가 네 개 있다.
//  (1) **개수가 어긋나면 벡터가 다른 청크에 붙는다.** `toVectorDocs` 는 길이가 다를 때만 끊는데,
//      엔진이 실패한 항목을 빼고 N-1 개를 주면 길이도 어긋나 잡힌다. 문제는 엔진이 **빈 벡터를
//      끼워 개수를 맞춰 주는** 경우다 — 길이는 같고 내용만 밀려서, 이후 그 지식베이스는
//      **다른 문서의 내용을 근거로 답한다**. 검색 결과는 그럴듯해서 아무도 눈치채지 못한다.
//  (2) **차원이 섞이면 검색이 조용히 망가진다.** 모델을 바꾸고 재인덱싱을 안 하면 768 차원 옆에
//      1536 차원이 쌓인다. 스토어는 대개 거부하지 않고 유사도만 무의미해진다.
//  (3) **NaN·Infinity·영벡터.** 코사인 유사도가 NaN 이 되거나 0/0 이 된다. 점수가 0 으로 나와
//      `minScore` 에 걸리면 그나마 다행이고, NaN 비교가 통과하는 스토어에서는 **무작위 문서가
//      1 등으로 올라온다**. 이건 장애가 아니라 오답으로 나타난다.
//  (4) **배치 일부가 실패했는데 나머지를 저장한다.** 절반만 인덱싱된 지식베이스는 "그 항목은
//      검색이 안 된다"로만 보이고, 원인은 몇 주 뒤에나 밝혀진다.
//
// 그래서 이 모듈은 **저장 전에** 위 넷을 전부 거른다. 판정 순서가 곧 안전장치다:
//   입력 검증 → (빈 입력이면 호출 안 함) → 배치 호출 → 개수 대조 → 성분 검증 → 차원 일치 →
//   부분 실패 확정 → 그때서야 VectorDoc 을 만든다. 벡터를 마지막에 만들어 **어느 단계에서 걸려도
//   저장 가능한 물건이 만들어지지 않게** 한다.
//
// 이 모듈은 저장하지 않는다. `TenantVectorStore` 호출은 호출자의 몫이고, 여기서는 "저장해도 되는
// 물건인가" 만 판정한다 — 판정과 부작용을 한 함수에 묶으면 실패했을 때 무엇이 남았는지 알 수 없다.
import type { EmbeddingAdapter } from '../adapters/index.ts';
import type { EngineErrorCode } from '../adapters/http.ts';
import { EngineError } from '../adapters/http.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { TenantScope, VectorDoc } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { PreparedChunk } from './rag.ts';
import { toVectorDocs } from './rag.ts';

export const EMBEDDING_CONTRACT_VERSION = 1;

export interface EmbedderConfig {
  scope: TenantScope;
  embedding: EmbeddingAdapter;
  /**
   * 국외이전 허용 여부(§10.3). 지식 원문과 고객 질의가 그대로 엔진으로 나간다.
   * 해외 엔진인데 허용하지 않으면 **생성 시점에** 거부한다.
   */
  allowOverseas?: boolean;
  /**
   * 이 지식베이스가 쓰는 벡터 차원. **기본값 없음**(§13-3) — 모델이 정하는 값이라
   * Core 가 가정할 근거가 없다.
   *
   * 주지 않아도 **이번 호출 안에서는** 첫 벡터의 차원을 기준으로 전 배치를 대조한다.
   * 잡지 못하는 것은 **이미 저장된 벡터와의 불일치**다: 모델을 바꾸고 재인덱싱을 하지 않으면
   * 이번 인제스트는 1536 차원으로 완벽하게 자기 일관적이고, 기존 768 차원 옆에 조용히 쌓인다.
   * 한 번의 호출 안에서는 알 수 있는 방법이 없으므로, 검사하지 못했다는 사실을 결과에 적는다
   * (`dimUncheckedAgainstIndex`). 그 검사를 켜는 것이 이 값의 유일한 용도다.
   */
  expectDim?: number;
  /** 한 번에 보낼 텍스트 수. 주지 않으면 나누지 않고 한 번에 보낸다(§13-3). */
  batchSize?: number;
  /** 배치 하나의 응답 대기 상한(ms). 주지 않으면 제한하지 않는다(§13-3). */
  timeoutMs?: number;
}

export type EmbedStatus =
  | 'ok'
  | 'empty_input'      // 임베딩할 텍스트가 없다 — 엔진을 부르지 않았다
  | 'engine_error'     // 호출 실패(전부 또는 일부)
  | 'protocol_error';  // 개수·차원·성분이 규약을 어겼다

/** 배치 단위 실패 기록. 어디까지가 피해 범위인지 확정할 수 있어야 한다. */
export interface BatchFailure {
  /** 이 배치가 담당한 입력 인덱스 구간 [from, to) */
  from: number;
  to: number;
  code: EngineErrorCode;
  reasonKo: string;
}

export interface EmbedTextsResult {
  status: EmbedStatus;
  /** status 가 'ok' 일 때만 채워진다. 부분 성공을 돌려주지 않는다 — 아래 주석 참조. */
  vectors: number[][];
  /** 실제로 관측한 차원. 벡터가 없으면 undefined(0 으로 적지 않는다, §13-3). */
  dim?: number;
  failures: BatchFailure[];
  reasonKo: string;
  /** 실측만 싣는다(§11.2). 토큰 수는 어댑터가 주지 않으므로 만들지 않는다. */
  usage: { texts: number; chars: number; batches: number };
  engine: { name: string; residency: EmbeddingAdapter['residency'] };
  /**
   * expectDim 을 주지 않아 **이미 저장된 벡터와의 차원 일치를 검사하지 못했음**을 드러낸다.
   * 이번 호출 안의 일관성은 언제나 검사한다 — 검사하지 못한 범위를 정확히 적기 위한 값이다.
   */
  dimUncheckedAgainstIndex: boolean;
}

export interface IngestResult extends EmbedTextsResult {
  /** status 가 'ok' 일 때만 채워진다. 하나라도 어긋나면 **아무것도 저장하지 않는다**. */
  docs: VectorDoc[];
}

export interface QueryVectorResult extends EmbedTextsResult {
  /** 질의 벡터. status 가 'ok' 일 때만 채워진다. */
  vector?: number[];
  /** 엔진으로 나간 질의(마스킹 후). 원문은 결과에 남지 않는다(§10.3). */
  queryMasked: string;
  piiMasked: boolean;
}

export interface Embedder {
  readonly contractVersion: number;
  readonly engine: { name: string; residency: EmbeddingAdapter['residency'] };
  /** 임의 텍스트 묶음 → 벡터. 저장하지 않는다. */
  embedTexts(texts: readonly string[]): Promise<EmbedTextsResult>;
  /** 준비된 청크 → 저장 입력. 하나라도 어긋나면 docs 는 비어 있다. */
  embedChunks(chunks: readonly PreparedChunk[]): Promise<IngestResult>;
  /** 고객 질의 → 검색 벡터. 여기서 마스킹한다(§10.3). */
  embedQuery(query: string): Promise<QueryVectorResult>;
}

// ── 성분 검증 ────────────────────────────────────────────────────────────────

/**
 * 벡터 한 건의 성분 검사. 여기서 걸러야 하는 것은 "저장은 되는데 검색이 조용히 망가지는" 값들이다.
 * 영벡터를 허용하지 않는 이유: 코사인 유사도의 분모가 0 이 되어 스토어마다 다르게 행동한다
 * (0 점·NaN·예외). 어느 쪽이든 그 청크는 영영 검색되지 않거나 아무 질의에나 걸린다.
 */
export function checkVector(v: unknown, index: number): string | undefined {
  if (!Array.isArray(v)) return `${index}번 임베딩이 배열이 아니다`;
  if (v.length === 0) return `${index}번 임베딩이 비어 있다`;
  let nonZero = false;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      return `${index}번 임베딩 ${i}번째 성분이 유한한 수가 아니다(NaN·Infinity 는 유사도를 무의미하게 만든다)`;
    }
    if (x !== 0) nonZero = true;
  }
  if (!nonZero) return `${index}번 임베딩이 영벡터다(유사도 분모가 0 이 된다)`;
  return undefined;
}

function chunkInto<T>(items: readonly T[], size: number | undefined): T[][] {
  if (size === undefined) return items.length === 0 ? [] : [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return p;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new EngineError('E_TIMEOUT', 'embedding', `임베딩 응답이 ${timeoutMs}ms 안에 오지 않았다`)), timeoutMs);
      if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
    }),
  ]);
}

export function createEmbedder(cfg: EmbedderConfig): Embedder {
  assertTenantScope(cfg.scope);
  if (cfg.expectDim !== undefined && (!Number.isInteger(cfg.expectDim) || cfg.expectDim <= 0)) {
    throw new EngineError('E_CONFIG', 'config', `expectDim 은 1 이상의 정수여야 한다: ${String(cfg.expectDim)}`);
  }
  if (cfg.batchSize !== undefined && (!Number.isInteger(cfg.batchSize) || cfg.batchSize <= 0)) {
    throw new EngineError('E_CONFIG', 'config', `batchSize 는 1 이상의 정수여야 한다: ${String(cfg.batchSize)}`);
  }
  if (cfg.timeoutMs !== undefined && (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs <= 0)) {
    throw new EngineError('E_CONFIG', 'config', `timeoutMs 는 1 이상의 정수여야 한다: ${String(cfg.timeoutMs)}`);
  }
  if (cfg.embedding.residency === 'overseas' && cfg.allowOverseas !== true) {
    throw new EngineError(
      'E_CONFIG', 'config',
      `국외이전 불가 테넌트에 해외 임베딩 엔진이 설정됐다: ${cfg.embedding.name} (설계서 §10.3)`,
    );
  }
  const engine = { name: cfg.embedding.name, residency: cfg.embedding.residency };
  const dimUnverified = cfg.expectDim === undefined;

  async function embedTexts(texts: readonly string[]): Promise<EmbedTextsResult> {
    const base = {
      vectors: [] as number[][],
      failures: [] as BatchFailure[],
      engine,
      usage: { texts: 0, chars: 0, batches: 0 },
      dimUncheckedAgainstIndex: dimUnverified,
    };
    if (texts.length === 0) {
      return { ...base, status: 'empty_input', reasonKo: '임베딩할 텍스트가 없어 엔진을 호출하지 않았다' };
    }
    const blank = texts.findIndex((t) => typeof t !== 'string' || t.trim() === '');
    if (blank >= 0) {
      // 빈 문자열을 보내면 엔진마다 다르게 행동한다(영벡터·오류·조용한 제외).
      // 제외하면 개수가 어긋나 벡터가 밀리므로, 부르기 전에 끊는다.
      return {
        ...base, status: 'protocol_error',
        reasonKo: `${blank}번 텍스트가 비어 있다 — 빈 입력은 엔진마다 다르게 처리되어 벡터가 밀린다`,
      };
    }

    const batches = chunkInto(texts, cfg.batchSize);
    const vectors: number[][] = [];
    const failures: BatchFailure[] = [];
    let dim = cfg.expectDim;
    let offset = 0;

    for (const batch of batches) {
      const from = offset;
      const to = offset + batch.length;
      offset = to;
      let got: number[][];
      try {
        got = await withTimeout(cfg.embedding.embed([...batch]), cfg.timeoutMs);
      } catch (err) {
        const e = err instanceof EngineError ? err : undefined;
        const msg = e ? e.message : (err instanceof Error ? err.message : String(err));
        failures.push({ from, to, code: e ? e.code : 'E_UNKNOWN', reasonKo: maskPii(`임베딩 호출 실패: ${msg}`).text });
        continue;
      }
      if (!Array.isArray(got) || got.length !== batch.length) {
        // 개수가 어긋나면 이후 전부가 밀린다. 어느 청크가 틀렸는지 알 수 없으므로 배치째 실패다.
        failures.push({
          from, to, code: 'E_PROTOCOL',
          reasonKo: `임베딩 개수 불일치: 요청 ${batch.length}건, 응답 ${Array.isArray(got) ? got.length : '배열 아님'}`,
        });
        continue;
      }
      let batchBad: string | undefined;
      for (let i = 0; i < got.length; i++) {
        const problem = checkVector(got[i], from + i);
        if (problem !== undefined) { batchBad = problem; break; }
        const len = (got[i] as number[]).length;
        if (dim === undefined) dim = len;
        else if (len !== dim) {
          batchBad = `임베딩 차원이 섞였다: ${from + i}번이 ${len}차원, 기준은 ${dim}차원`
            + (cfg.expectDim !== undefined ? '(expectDim 선언값)' : '(이번 호출의 첫 벡터 관측값)');
          break;
        }
      }
      if (batchBad !== undefined) {
        failures.push({ from, to, code: 'E_PROTOCOL', reasonKo: batchBad });
        continue;
      }
      vectors.push(...(got as number[][]));
    }

    const usage = {
      texts: texts.length,
      chars: texts.reduce((a, t) => a + t.length, 0),
      batches: batches.length,
    };

    if (failures.length > 0) {
      // **부분 성공을 돌려주지 않는다.** 절반만 인덱싱된 지식베이스는 장애로 보이지 않고
      // "그 항목만 검색이 안 된다"로 나타나 원인을 몇 주 뒤에 찾게 만든다.
      const protocolOnly = failures.every((f) => f.code === 'E_PROTOCOL');
      return {
        ...base,
        status: protocolOnly ? 'protocol_error' : 'engine_error',
        failures,
        usage,
        ...(dim !== undefined ? { dim } : {}),
        reasonKo: `${batches.length}개 배치 중 ${failures.length}개 실패 — 부분 저장을 막기 위해 전체를 돌려주지 않는다: ${failures[0]?.reasonKo ?? ''}`,
      };
    }

    return {
      ...base,
      status: 'ok',
      vectors,
      usage,
      ...(dim !== undefined ? { dim } : {}),
      reasonKo: `${vectors.length}건 임베딩 완료(${dim ?? '?'}차원)`
        + (dimUnverified ? ' · expectDim 미지정이라 기존 저장 벡터와의 차원 일치는 검사하지 못했다' : ''),
    };
  }

  return {
    contractVersion: EMBEDDING_CONTRACT_VERSION,
    engine,
    embedTexts,

    async embedChunks(chunks) {
      const r = await embedTexts(chunks.map((c) => c.text));
      if (r.status !== 'ok') return { ...r, docs: [] };
      // 여기까지 와야 VectorDoc 을 만든다 — 앞 단계에서 걸리면 저장 가능한 물건이 생기지 않는다.
      return { ...r, docs: toVectorDocs(chunks, r.vectors) };
    },

    async embedQuery(query) {
      const m = maskPii(query ?? '');
      const r = await embedTexts(m.text.trim() === '' ? [] : [m.text]);
      const head = { ...r, queryMasked: m.text, piiMasked: m.masked };
      if (r.status !== 'ok') {
        return r.status === 'empty_input'
          ? { ...head, reasonKo: '빈 질의라 엔진을 호출하지 않았다' }
          : head;
      }
      return { ...head, vector: r.vectors[0] as number[] };
    },
  };
}
