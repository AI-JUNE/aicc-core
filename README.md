# AICC Core — Conversation Core 스켈레톤

설계서 `AICC_통합포털_서비스설계서.md` §13-7·13-8 이행. 콜봇(voice)·보이는ARS(visual)·챗봇(chat) 세 채널이
**하나의 세션(Interaction)** 위에서 동작하도록 하는 공통 엔진의 골격이다.

## 구성
| 경로 | 설계서 | 역할 |
|---|---|---|
| `src/domain/types.ts` | §4·§4.1 | Interaction·Turn·Outcome 판정(24h 재문의 반영) |
| `src/adapters/index.ts` | §6.2·§13-8 | STT/TTS/LLM 어댑터 인터페이스 + 국외이전 차단 가드(§10.3) |
| `src/adapters/sim.ts` | — | 시뮬 어댑터(외부 호출 없음). **실엔진 연동은 [승인 필요]** |
| `src/flow/types.ts` | §5.3 | Flow 노드 5종 + 채널별 렌더러(시나리오 이중 관리 제거) |
| `src/core/policyGuard.ts` | §10.3 | 주민·카드·계좌·전화 자동 마스킹 |
| `src/core/session.ts` | §1.2·§5.1 | 세션 생성·채널 합류·턴 기록·폴백 정책 |
| `src/knowledge/rag.ts` | §5.2·§11.1·§10.3·§7 | 지식 인제스트(청킹·마스킹)·테넌트 스코프 검색·근거 판정·인용. 근거 미달 시 자유 생성 대신 §5.1 폴백 |

## 검증
```
npm test        # 불변식 테스트 (의존성 0)
npm run typecheck
```

## 원칙
- 엔진 종속 코드는 Core에 넣지 않는다(온프렘 수주 가능성 확보, §6.2)
- 저장 전 마스킹은 우회 불가(§10.3)
- 실발신·실엔진·실개인정보는 **[승인 필요]** — 현재 sim 전용
