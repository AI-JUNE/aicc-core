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
    // §5.1 인텐트 분류기·§5.2 임베딩·답변기를 **여기서** 선언한다. 호스트가 조각으로 직접
    // 만들면 그 호출은 위 `resilience`(재시도·대체)와 §9.3 헬스 기록을 비껴간다 — 증상은
    // 예외가 아니라 "말을 못 알아듣는다"·"모든 질문에 안내할 내용이 없다"로 나타난다.
    // 지시문은 **예시**다: 응대 화법은 고객사 문안이므로 저장소가 바꾼다(§13-3).
    intent: { systemKo: '고객 발화를 카탈로그의 인텐트로 분류한다.', timeoutMs: 3000 },
    knowledge: {
      // 벡터 차원은 **임베딩 모델이 정한다** — 위 `embeddingModel` 을 바꾸면 이 값도 바꾼다.
      // 틀리면 색인이 조용히 섞이는 것을 막기 위한 검사가 여기서 돌지 않는다(§5.2).
      expectDim: 1024,
      batchSize: 16,
      timeoutMs: 5000,
    },
    answer: { systemKo: '제공된 근거만으로 존댓말로 답한다.', timeoutMs: 5000, maxResponseChars: 4000 },
    // 복구 프로브 확인용 **합성 입력**(§9.3·§10.3). Core 는 오디오·문장을 만들지 않으므로
    // 저장소가 선언한다 — 고객 녹취·실제 발화를 넣지 않는다(확인 주기마다 엔진으로 나간다).
    // 개인정보 흔적이 있으면 기동 시점에 거절된다.
    // `dry_run` 인 동안은 **프로브가 만들어지지 않는다**(dry_run 은 언제나 성공하므로 up 을
    // 적으면 폴백이 즉시 풀린다) — 계획 출력의 `미생성 ...: not_activated` 가 그 상태다 [승인 필요].
    probes: {
      samples: {
        // 2바이트는 실제 오디오가 아니다 — 저장소는 고정된 짧은 합성 샘플을 넣는다.
        stt: { data: new Uint8Array([0, 0]), mime: 'audio/wav' },
        tts: { text: '점검용 문장입니다.', voice: 'ko-female-1' },
        llm: [{ role: 'user', content: '점검' }],
        embedding: ['점검'],
      },
    },
  };
}

export default declaration;
