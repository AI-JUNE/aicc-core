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

export interface EngineSet { stt: SttAdapter; tts: TtsAdapter; llm: LlmAdapter }

/** §10.3 — 국외이전이 금지된 테넌트에서 해외 엔진 사용을 사전 차단 */
export function assertResidency(engines: EngineSet, allowOverseas: boolean): void {
  if (allowOverseas) return;
  const bad = Object.entries(engines)
    .filter(([, e]) => (e as { residency: string }).residency === 'overseas')
    .map(([k]) => k);
  if (bad.length) {
    throw new Error(`국외이전 불가 테넌트에 해외 엔진이 설정됨: ${bad.join(', ')} (설계서 §10.3)`);
  }
}
