// 엔진 기동 선언 예시(§6.2). 저장소는 자기 엔진 설정을 이 모양으로 넣는다.
// **기본 dry_run 이며 실호출하지 않는다** — live 전환은 approvalRef + 비밀값 주입이 있어야만
// 가능하고, 그건 사람이 승인한다 [승인 필요].
// 실주소·실키를 담지 않는다(§10.3): 여기 있는 것은 예시 호스트명과 **환경변수 이름**뿐이다.
export function declaration() {
  return {
    scope: { tenantId: 'reference' },
    // 국외이전 허용 여부는 테넌트 계약 사항이다. 예시는 불가로 둔다(§10.3).
    allowOverseas: false,
    sets: [{
      name: 'onprem',
      parts: [
        {
          kind: 'openai-audio',
          source: 'audio',
          config: {
            name: 'whisper-onprem',
            residency: 'onprem',
            baseUrl: 'https://stt.example.co.kr',
            timeoutMs: 5000,
            activation: 'dry_run',
            apiKeyEnv: 'AICC_STT_API_KEY',
            sttModel: 'whisper-large-v3',
            ttsModel: 'tts-ko-1',
            ttsVoice: 'ko-female-1',
            sttResponseFormat: 'verbose_json',
            language: 'ko',
          },
        },
        {
          kind: 'openai-compat',
          source: 'text',
          config: {
            name: 'sllm-onprem',
            residency: 'onprem',
            baseUrl: 'https://llm.example.co.kr',
            timeoutMs: 5000,
            activation: 'dry_run',
            apiKeyEnv: 'AICC_LLM_API_KEY',
            chatModel: 'sllm-7b-instruct',
            embeddingModel: 'bge-m3',
            maxTokens: 512,
            temperature: 0,
          },
        },
      ],
    }],
    // 재시도 횟수·대기는 운영 합의값이다 — Core 가 기본값을 만들지 않는다(§13-3).
    resilience: { attemptsPerCandidate: 2, backoffMs: (seq) => seq * 200 },
  };
}

export default declaration;
