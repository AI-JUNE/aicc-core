# 오류 모니터링 도입 가이드 (상용 필수)

참조 구현: `Dev\3. Chatbot\src\lib\monitoring.ts` (의존성 0, 검증 완료)

## 원칙
- **npm 설치 금지** — OneDrive에서 설치가 실패하고 빌드 리스크가 있다. 공식 SDK 대신 위 참조 구현을 복사·이식한다.
- **DSN 미설정 시 no-op** — `process.env.SENTRY_DSN` 이 없으면 아무 동작도 하지 않아야 한다.
- **DSN 하드코딩 절대 금지** — 환경변수로만 주입(Vercel Environment Variables).
- **전송 전 PII 마스킹** — 주민등록번호·카드·휴대전화·이메일·계좌. 참조 구현의 `scrub()` 그대로 사용.
- **전송 실패가 서비스에 영향 없어야 함** — 모든 예외 흡수, 재던지기 금지.

## 이식 절차
1. 참조 구현을 프로젝트 언어에 맞게 복사
   - TypeScript(PMS·D-ARS·AICC-Core): 거의 그대로. import 경로만 조정
   - 이음(Vite/JS): `src/eum/monitoring.js` 로 이식. `import.meta.env.VITE_SENTRY_DSN` 사용
   - Callbot(Python): `api/monitoring.py` 로 이식. `os.environ.get("SENTRY_DSN")`, urllib 사용
2. 전역 오류 지점에 연결
   - Next.js: API 라우트 try/catch + `app/global-error.tsx`
   - 이음: ErrorBoundary + window.onerror
   - Callbot: 각 API 핸들러 except 블록
   - AICC-Core: **전역 훅만으로는 통화가 안 보인다.** 배선할 자리가 셋이고 전부
     `obs/executeObservability.ts` 의 판정을 지난다 —
     (1) `createConversationCore({ observability })` → 진입점 네 곳(`start`·`send`·`end`·
     `reportHealth`)의 턴 줄 + 등록 시점 계약 경고(`warnings()`)가 **경고당 한 번** 나간다,
     (2) `createBridge({ observability })` → 비-Node 호스트가 보낸 **경계 실패**(깨진 JSONL 줄·
     모르는 op·다른 테넌트 주장·요청 한도 초과)가 남는다. 이 줄들은 Core 를 부르기 **전에**
     끝나므로 (1) 만 하면 로그가 조용하다 — 증상은 "그 채널만 통화가 안 된다"인데 로그에는
     그 통화가 아예 없다. **같은 배선 객체를 둘에 주고**(중복 억제·창 상한이 같은 기준으로
     돈다) 로그 sink 는 **표준출력에 쓰지 않는다**(브리지 응답 줄과 섞여 호스트 파서가 죽는다 —
     `fixtures/reference-core-observed.mjs` 참조),
     (3) `installGlobalCapture` → uncaught·unhandledRejection. Core 는 `process` 를 직접
     참조하지 않으므로 호스트가 소스를 주입한다(§6.2).
     최소 수준·중복 억제 창·창당 상한은 **운영이 정한다**(Core 는 기본값을 만들지 않는다, §13-3).
     배선한 다음 **반드시 읽어야 하는 수치가 둘**이다. 둘 다 예외가 아니라 수치로만 나타나므로,
     읽지 않으면 "붙였다"와 "나가고 있다"가 구분되지 않는다 —
     `failed`(로거·수집기가 던진 수. 관측 실패로 통화를 끊지 않으므로 0 이 아니면 **로그가 한 줄도
     나가지 않는데 대시보드는 조용하다**) · `droppedIds`(호스트의 통화 id·상관관계 id 가 개인정보
     패턴에 걸려 로그 식별자로 싣지 못한 수. 0 이 아니면 id 생성 규칙을 고쳐야 한다, §10.3).
     Node 호스트는 `core.observability()`·`bridge.observability()` 로 읽고, 비-Node 호스트는
     브리지 op `observability` 를 쓴다(`maintenance: { observability: true }` 로 열어야 하며
     기본은 닫힘이다). **임계는 Core 가 정하지 않는다** — 배포 직후의 일시적 전송 실패와 상시
     실패를 가르는 기준은 조직 값이다(§13-3).
     억제분 방출(`flushObservability`)은 **종료 직전에** 부른다 — 창에 묶여 있던 마지막 보고가
     조사에서 가장 먼저 필요한 것이다. 브리지 실행기(`scripts/channel-bridge.mjs`)는 EOF 에서
     브리지·Core 관측기를 **둘 다** 방출한다.
3. 테스트 동반 — no-op 동작, 마스킹, DSN 미하드코딩을 불변식으로 검증
4. `COMMERCIAL_READINESS.md` 의 "에러 모니터링" 항목을 `[x]` 로 변경

## 환경변수 (사람이 Vercel에 등록)
- Next.js/Python: `SENTRY_DSN`
- 이음(Vite): `VITE_SENTRY_DSN`
