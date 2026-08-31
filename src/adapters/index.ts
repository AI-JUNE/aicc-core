// 엔진 어댑터 — 설계서 §6.2.
// "엔진은 교체 가능한 어댑터로 감싼다. 엔진 종속 코드가 Core에 침투하면 온프렘 수주가 불가능해진다."

export interface SttResult { text: string; isFinal: boolean; confidence?: number }
export interface AudioChunk { data: Uint8Array; mime: string }

export interface SttAdapter {
  readonly name: string;
  /** 국외이전 이슈(§10.3) 판단용 — 국내/온프렘 엔진 여부 */
  readonly residency: 'domestic' | 'onprem' | 'overseas';
  stream(audio: AsyncIterable<AudioChunk>): AsyncIterable<SttResult>;
}

export interface TtsAdapter {
  readonly name: string;
  readonly residency: 'domestic' | 'onprem' | 'overseas';
  synthesize(text: string, voice?: string): AsyncIterable<AudioChunk>;
}

export interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface LlmAdapter {
  readonly name: string;
  readonly residency: 'domestic' | 'onprem' | 'overseas';
  complete(messages: LlmMessage[], tools?: unknown[]): AsyncIterable<string>;
}

/** 임베딩 엔진(§5.2 RAG). 지식 원문이 그대로 흘러가므로 residency 판정 대상에 반드시 포함된다(§10.3). */
export interface EmbeddingAdapter {
  readonly name: string;
  readonly residency: 'domestic' | 'onprem' | 'overseas';
  /** 입력은 §10.3 마스킹을 통과한 텍스트만 넣는다. 차원 수는 엔진이 정한다 — Core가 가정하지 않는다. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface EngineSet {
  stt: SttAdapter;
  tts: TtsAdapter;
  llm: LlmAdapter;
  /** RAG를 쓰는 테넌트만 설정한다. */
  embedding?: EmbeddingAdapter;
}

/** §10.3 — 국외이전이 금지된 테넌트에서 해외 엔진 사용을 사전 차단 */
export function assertResidency(engines: EngineSet, allowOverseas: boolean): void {
  if (allowOverseas) return;
  const bad = Object.entries(engines)
    .filter(([, e]) => e && (e as { residency: string }).residency === 'overseas')
    .map(([k]) => k);
  if (bad.length) {
    throw new Error(`국외이전 불가 테넌트에 해외 엔진이 설정됨: ${bad.join(', ')} (설계서 §10.3)`);
  }
}
