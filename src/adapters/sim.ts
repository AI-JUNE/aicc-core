// 시뮬레이션 어댑터 — 실엔진 연동 전 개발·테스트용. 외부 호출 없음. [승인 전까지 실엔진 금지]
import type { SttAdapter, TtsAdapter, LlmAdapter, AudioChunk, SttResult, LlmMessage } from './index.ts';

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
