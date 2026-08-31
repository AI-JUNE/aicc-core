// 시뮬레이션 어댑터 — 실엔진 연동 전 개발·테스트용. 외부 호출 없음. [승인 전까지 실엔진 금지]
import type {
  SttAdapter, TtsAdapter, LlmAdapter, EmbeddingAdapter, AudioChunk, SttResult, LlmMessage,
} from './index.ts';

export const simStt: SttAdapter = {
  name: 'sim-stt', residency: 'onprem',
  async *stream(audio: AsyncIterable<AudioChunk>): AsyncIterable<SttResult> {
    for await (const _ of audio) { yield { text: '(시뮬레이션 인식)', isFinal: true, confidence: 0.9 }; }
  },
};

export const simTts: TtsAdapter = {
  name: 'sim-tts', residency: 'onprem',
  async *synthesize(text: string): AsyncIterable<AudioChunk> {
    yield { data: new TextEncoder().encode(text), mime: 'audio/sim' };
  },
};

export const simLlm: LlmAdapter = {
  name: 'sim-llm', residency: 'onprem',
  async *complete(messages: LlmMessage[]): AsyncIterable<string> {
    const last = messages[messages.length - 1]?.content ?? '';
    yield `(시뮬레이션 응답) ${last.slice(0, 40)}`;
  },
};

/**
 * 시뮬 임베딩 — 결정적 해시 기반. 외부 호출 없음, 의미 유사도 없음.
 * 검색 품질 측정용이 아니라 배선(인제스트→스토어→검색) 테스트용이다. 실엔진 연동은 [승인 필요].
 */
export const simEmbedding: EmbeddingAdapter = {
  name: 'sim-embedding', residency: 'onprem',
  async embed(texts: string[]): Promise<number[][]> {
    const DIM = 16;
    return texts.map((t) => {
      const v = new Array<number>(DIM).fill(0);
      for (let i = 0; i < t.length; i++) v[i % DIM] = (v[i % DIM] as number) + t.charCodeAt(i);
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
};
