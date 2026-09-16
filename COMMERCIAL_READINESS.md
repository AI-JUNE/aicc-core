# 상용 출시 잔여 과제 (COMMERCIAL READINESS)

작성 2026-09-01. **이 문서는 자동 개발의 최우선 백로그다.** 위에서부터 소진한다.

## 원칙
- `[ ]` 미완, `[x]` 완료. 완료 시 근거(파일·테스트)를 한 줄로 남긴다.
- **build now, activate on approval**: 코드는 끝까지 만들되 실인증·실결제·실개인정보·실발신 **활성화는 사람 승인**. 스위치는 환경변수로 분리하고 기본 OFF.
- 임의 성과·KPI 수치를 화면·문서에 넣지 않는다. 실측 전에는 기능 서술로 쓴다.
- 모든 변경은 테스트·빌드 검증 통과 후 커밋한다.

## 공통 상용 필수 (전 제품)
- [x] **에러 모니터링** — 던져진 값 정규화(Error·문자열·객체·빈 값) → 원인 묶기(fingerprint) → 알림 훅.
      메시지·스택은 maskPii + 자격증명 제거(URL 비밀번호·Bearer·key=value)·절대경로 축약을 거치고,
      부가 필드는 로거와 같은 차단 키 목록을 쓴다. 중복 억제(억제분은 다음 보고의 occurrences 에 합산,
      flush 로 잔여분 방출)·창당 상한(버린 건수를 다음 보고에 표시)·capture 는 절대 던지지 않음.
      전역 훅(uncaught·unhandledRejection)은 주입된 소스에 붙인다(process 직접 참조 금지, §6.2 취지).
      근거: `src/obs/errorMonitor.ts` · `tests/obs.errorMonitor.test.mjs`(23건).
      DSN 은 **값을 보관하지 않고** 설정 여부만 본다(`resolveDsnConfig`), transport 미주입 시 완전한 no-op.
      실제 수집기 전송 연결은 **[승인 필요]**
- [x] **구조화 로깅** — 고정 필드(요청ID·테넌트·상호작용·소요시간·에러코드) + 차단 키 목록·마스킹 경유.
      근거: `src/obs/logger.ts` · `tests/obs.logger.test.mjs`(17건). sink 미주입 시 no-op,
      시계 미주입 시 시각·소요를 만들어 넣지 않음(§13-3). 수집기(외부 전송) 연결은 **[승인 필요]**
- [x] **/health 확장** — liveness(의존성 미점검)와 readiness(의존성 실점검) 분리, 프로브 병렬 실행 +
      프로브별 제한 시간(한 곳이 늦어도 전체가 멈추지 않음), 필수/부가 구분 집계(필수 down→503,
      부분 실패→degraded·200), 프로브 예외·동기 예외·규약 위반 반환값을 모두 잡아 항목 단위로 표시.
      응답에는 접속 문자열·키·개인정보·절대경로가 실리지 않고(마스킹 경유), 커밋 해시는 12자로 줄이며
      해시 형태가 아니면 싣지 않는다. 소요·시각은 clock 주입이 있을 때만 채운다(§13-3).
      근거: `src/ops/health.ts` · `tests/ops.health.test.mjs`(18건).
      프로브 구현(DB·엔진 실접속)은 호스트가 주입 — 실연결은 **[승인 필요]**(`approvalPendingProbe` 로 표시)
- [x] **표준 에러 응답 + 입력검증** — 코드→HTTP상태·재시도가능 매핑 고정, 항목 단위 검증 결과(FieldIssue)를
      그대로 봉투에 실어 인라인 안내 가능. 알 수 없는 예외는 원문·스택을 노출하지 않고 E_INTERNAL 로 덮는다.
      근거: `src/api/errors.ts` · `tests/api.errors.test.mjs`(16건)
- [x] **rate limit** — 테넌트 경계를 포함한 키 기반 토큰버킷(버스트 흡수 + 평균 속도 유지),
      시계 역행·유휴 정리·키 상한 처리. 한도 기본값을 코드에 박지 않음(§13-3).
      근거: `src/api/rateLimit.ts` · `tests/api.rateLimit.test.mjs`(18건).
      다중 인스턴스 공유 저장소 연결은 **[승인 필요]** · 각 API 진입점 적용은 저장소별 잔여 과제
- [x] **접근·감사 로그** — 관리 기능 접근 판정과 기록을 한 함수로 묶어(`recordAccess`) 화면마다 빠뜨릴 수 없게 함.
      **거부는 화면 성격과 무관하게 항상 기록**(권한 거부·테넌트 위반·미존재 라우트·차단), 성공은 감사 대상
      화면(PII 열람·상태 변경)만 기록해 잡음을 막는다(`recordAllReads` 로 한시 전환 가능).
      테넌트 불일치는 자원 존재를 알리지 않고 **행위자 테넌트 체인**에 남긴다(§11.1). 대량 반출은 임계값
      초과 시 표시(임계값은 설정값, 하드코딩 금지). 사유는 maskPii 경유, IP 는 마지막 옥텟 제거.
      조회·행위자별 실측 요약(판단 점수 없음, §13-3) 포함.
      근거: `src/audit/access.ts` · `tests/audit.access.test.mjs`(18건)
- [x] **백업·복구 절차** — 절차 문서가 아니라 **실행 가능한 리허설**로 만들었다. 스냅샷 생성(스코프 강제·
      마스킹 미경유 값 거부) → JSONL 직렬화 → 부분손상 복구(한 줄이 깨져도 나머지 생존) → 배치 복구
      (부분 실패 시 피해 범위 확정) → 되읽기 대조까지 한 번에 돈다. 판정은 통과/판정보류/실패 3종이며,
      **원본이 비었거나 대조를 못 한 경우를 성공으로 적지 않는다**(사고가 시작되는 지점이라서다).
      체크섬은 순서 무관이라 복구가 순서를 바꿨다는 이유로 거짓 실패가 나지 않는다.
      다른 테넌트로의 복구는 차단되고(§11.1), 실패 사유는 maskPii 를 거친다(§10.3).
      근거: `src/ops/backup.ts` · `scripts/recovery-drill.mjs` · `RUNBOOK.md`(리허설 기록은 스크립트 실행
      결과를 그대로 붙인 것 — 사람이 적은 수치가 아니다, §13-3) · `tests/ops.backup.test.mjs`(36건).
      운영 DB·오브젝트 스토리지 연결과 운영 데이터 리허설은 **[승인 필요]**
- [ ] **약관·개인정보 처리방침 확정본 반영** (현재 초안, 문안은 사람이 확정 **[승인 필요]**)
      · Core 측 완료(2026-09-16): 문안이 오기 전에 코드가 막아야 할 것은 **초안이 확정본 자리에 나가는 일**이다 —
        사고는 문안이 틀려서가 아니라 "초안인 줄 몰랐다"에서 나고, 그 문서로 받은 동의는 동의가 아니다.
        `src/legal/documents.ts`: 문서는 (종류·테넌트·언어·버전)으로 식별되는 추가 전용 등록부에 쌓이고,
        **확정(final)은 승인 근거+시행일+본문+본문 해시가 모두 있어야** 한다(하나라도 없으면 초안). 확정 뒤
        본문이 바뀌면 해시 불일치로 거부되고, 자리표시자(`{{…}}`·`[TODO]`·`[확인 필요]`·`____`)가 남은 문서는
        확정할 수 없다. 조회는 **확정본만** 돌려준다 — 초안·시행일 전·다른 언어·다른 테넌트 문서는 어떤 조건에서도
        나가지 않고(§11.1), 없으면 이유(초안만 N건 [승인 필요])를 돌려준다. 수락 기록은 버전·해시를 함께 남겨
        **개정되면 이전 수락은 `stale`** 로 판정된다("예전에 동의했으니 됐다"를 코드가 허용하지 않는다).
        주체 참조에 원문 개인정보가 오면 거부, 승인자·증빙 참조는 저장 경로에서 한 번 마스킹(§10.3).
        기본 언어·기본 시행일·기본 문안을 만들지 않는다(§13-3). `legalReadiness` 가 종류×언어별 확정 여부를
        그대로 적어 이 항목의 근거가 된다 — 초안만 있는 종류는 준비됨이 아니다.
        근거: `src/legal/documents.ts` · `tests/legal.documents.test.mjs`(22건)
      · 남은 것: 약관·처리방침 **문안 확정 + 승인 근거(approvalRef)·시행일** — 사람이 정한다 **[승인 필요]**,
        포털 화면(문서 표시·수락 UI)은 포털 저장소 과제
- [x] **테스트 CI 실행** — 타입 검증 + 테스트 전량 + 복구 리허설 + 채널 적합성 스위트를 push·PR마다 실행.
      리허설 종료코드(0/1/2)를 그대로 게이트로 쓰며 판정보류도 통과로 넘기지 않는다.
      근거: `.github/workflows/ci.yml`. 실엔진·실회선·실 DB 에 붙지 않는다(모두 dry_run 기본값)
- [x] **커버리지 계측 도입** — `node --experimental-test-coverage` 실측을 요약·판정하는 순수 모듈 + 실행기.
      세 가지를 지킨다: (1) 전체 비율을 **파일 퍼센트의 평균이 아니라 원시 건수 합**으로 계산한다
      (10줄 파일과 500줄 파일이 같은 무게를 갖지 않게), (2) **목표치를 코드에 두지 않는다** — 임계값을
      주지 않으면 게이트로 쓰지 않고 `측정 완료` 로 끝난다(§13-3), (3) **측정 실패를 0%로도 100%로도
      적지 않는다** — 계측이 아무 파일도 못 봤으면 `판정보류`(종료코드 2)다. 분모가 0인 지표는 비율을
      만들지 않고 `null` 로 둔다. 테스트가 깨진 상태의 수치는 근거가 아니므로 무조건 실패로 끝난다.
      근거: `src/ops/coverage.ts` · `scripts/coverage.mjs` · `scripts/coverage-reporter.mjs` ·
      `tests/ops.coverage.test.mjs`(19건) · CI `coverage (measure)` 단계.
      **2026-09-03 실측(도구 출력 그대로, 사람이 적은 수치가 아니다)**: 대상 45파일 —
      라인 98.09%(11946/12179) · 분기 86.69%(2775/3201) · 함수 94.72%(718/758).
      임계값은 추이를 보고 사람이 정한다 — `AICC_COVERAGE_MIN_LINE`·`_BRANCH`·`_FUNC` 로 켠다

## AICC-Core 전용 (라이브러리, 준비도 ~38%)
- [x] **실엔진 어댑터 1종 이상** — HTTP 엔진 어댑터(STT·TTS·LLM·임베딩 4종 §6.2 인터페이스 준수).
      근거: `src/adapters/http.ts` · `tests/adapters.http.test.mjs`(13건).
      기본 `dry_run`(네트워크 호출 없음), `live` 전환은 승인 근거(approvalRef)+비밀값 주입이 있어야만 가능 **[실호출은 승인]**
- [ ] 채널 어댑터 계약 실적용 — Callbot·챗봇·D-ARS가 Core를 실제로 소비하도록 연결
      · Core 측 완료: `src/channels/runtime.ts`(ConversationCorePort 실구현 — 세션·Flow·이벤트·§9.3 폴백·이관 요약 배선),
        `src/channels/profiles.ts`(채널 3종 능력 기본값) · `tests/channels.runtime.test.mjs`(15건)·`tests/channels.profiles.test.mjs`(5건)
      · Core 측 완료(2): `src/channels/conformance.ts` — 채널 저장소가 자기 `ChannelPort` 구현을 CI에서
        드라이런 검증하는 적합성 스위트 10종(정적계약·비동기·빈입력·입력불변·미지세션·큐없는이관·
        중복종료·응답예산·오류 PII·시나리오 렌더) + 참조 드라이런 포트 `createDryRunPort`.
        근거: `tests/channels.conformance.test.mjs`(18건)
      · Core 측 완료(3): `src/channels/basePort.ts` — 적합성 스위트를 그대로 통과하는 포트 베이스.
        저장소는 `ChannelTransport.deliver` 하나만 구현하면 되고, 입력 동결 복사·종료 멱등·예산 초과·
        전송 실패 보고(failures·onFailure, 삼키지 않음)·오류 마스킹은 베이스가 책임진다.
        기본 `dry_run`(매체 미호출), `live` 는 approvalRef + transport 주입이 있어야만 생성된다.
        근거: `tests/channels.basePort.test.mjs`(19건)
      · Core 측 완료(4): `src/channels/harness.ts` + `scripts/channel-conformance.mjs` — 적합성 스위트를
        **CLI 한 줄**로 줄인 실행기. 채널 저장소는 포트를 export 하는 모듈 하나만 만들면 되고
        (`node <core>/scripts/channel-conformance.mjs --port ./ci/aicc-port.mjs --flows ./ci/aicc-flows.mjs
        --adapter chatbot --timeout-ms 3000`), Core 를 TS 로 import 하거나 리포트를 해석할 필요가 없다.
        종료코드 0/1/2(판정보류를 통과로 넘기지 않음)를 그대로 CI 게이트로 쓴다.
        **건너뛴 검사는 통과의 근거가 아니므로**, `--timeout-ms`·`--flows` 를 빼면 판정보류가 된다(§13-3).
        `live` 로 선언된 포트는 실전송 위험이 있어 검사하지 않고 멈춘다 — 드라이런만 검사한다.
        오류 텍스트는 개인정보·자격증명·배포 경로를 모두 지운 뒤 로그에 남는다(§10.3).
        복사용 최소 예시: `fixtures/reference-port.mjs`·`fixtures/reference-flows.mjs`(CI 자체점검에도 쓰인다).
        근거: `tests/channels.harness.test.mjs`(30건) · CI `channel conformance runner (self-check)` 단계
      · Core 측 완료(5): **소비 경로 고정** — 채널이 부르는 import 경로를 package.json 의 exports 맵에
        명시했다. 지금까지는 `<core>/src/channels/basePort.ts` 같은 소스 상대경로였고, 그 방식은 파일을
        옮기는 순간 저장소 3곳이 동시에 깨지면서 **Core CI 는 초록으로 남는다**. 이제 채널 계약 경로는
        `aicc-core/channels/*`·`aicc-core/flow/types`·`aicc-core/conformance-runner` 로 이름이 고정되고,
        호스트용은 `aicc-core/internal/*` 로만 열린다 — 안정 계약이 아니라는 사실이 import 문에 보이게 했다.
        와일드카드로 채널 경로를 여는 것(내부 모듈까지 계약이 된다), 허용 목록 밖 경로를 여는 것,
        승인 근거 없이 `private` 을 푸는 것(=레지스트리 배포)은 모두 검사에서 막힌다 **[배포는 승인 필요]**.
        근거: `src/ops/packageSurface.ts` · `package.json` exports · `tests/ops.packageSurface.test.mjs`(20건)
      · **채널 저장소 적용(2026-09-05)**: 챗봇·D-ARS 두 저장소가 실제로 Core 를 소비하기 시작했다.
        각 저장소는 `renderEnvelope`(지시→매체 표현)와 `createAiccTransport`(deliver 하나)만 구현하고,
        세션·시나리오·이벤트·폴백·마스킹·종료 멱등은 Core 가 그대로 책임진다.
        - 챗봇: `src/lib/aiccTransport.ts` · `ci/aicc-port.mjs` · `ci/aicc-flows.mjs` ·
          `scripts/aicc-conformance.mjs` · `tests/aicc.test.mjs`(16건) · CI `채널 계약 적합성` 단계
        - D-ARS: `dars/lib/aiccTransport.js` · `dars/ci/*` · `dars/scripts/aicc-conformance.mjs` ·
          `dars/tests/aicc.test.mjs`(14건)
        적합성 실행기 실측(도구 출력 그대로): `[chatbot/chat] 통과 (오류 0 · 경고 0)` ·
        `[dars/visual] 통과 (오류 0 · 경고 0)` — 둘 다 드라이런 선언·시나리오·응답 예산을 갖춘 상태의 판정이다.
        **의존을 `file:` 로 박지 않은 이유**: Core 는 별도 저장소라 단독 체크아웃에서 `npm ci` 가 통째로
        실패한다. 대신 호출부가 Core 위치(`AICC_CORE`)를 찾고, 못 찾으면 **판정보류(종료코드 2)** 로 끝낸다 —
        검사를 못 돌린 것을 통과로 적지 않는다. import 경로는 안정 계약 경로(`aicc-core/channels/*`) 그대로다.
        고객 노출 경로에서 **상담사용 요약(summaryMasked)은 렌더하지 않는다**(§2·§10.3) — 테스트로 고정.
        활성화는 각 저장소에서 기본 dry_run 이며 플래그+승인 근거가 **둘 다** 있어야 live 다 **[승인 필요]**.
      · Core 측 완료(6): **비-Node 호스트용 소비 경로(2026-09-07)** — Callbot 이 붙지 못한 이유는
        의지가 아니라 형태였다. 음성 에이전트는 파이썬 프로세스(`voice-agent/agent.py`)라 `import` 로
        Core 를 소비할 방법이 아예 없었고, 그 상태로 두면 "Core 단일화"는 세 채널 중 둘에서만 참인 말이
        된다. 음성은 가장 먼저 갈라지는 채널(DTMF·무음·재발화)이라 여기서 갈라지면 §2 의 시나리오
        이중 관리가 그대로 재발한다. 그래서 언어에 묶이지 않는 경로를 하나 더 열었다 —
        **한 줄 = 한 요청(JSONL)**, 표준입출력. 파이썬·자바·Go 어디서든 붙고 Core 내부 타입을 모른다.
        경계에서 지키는 것(전부 테스트로 고정): **테넌트를 호스트가 주장하지 못한다**(scope 강제 주입,
        다른 테넌트 주장은 조용히 덮어쓰지 않고 거부, §11.1) · 어댑터 고정(브리지 하나 = 채널 하나) ·
        **슬롯 값과 상담사용 요약은 기본적으로 나가지 않는다** — 슬롯은 키 목록만, 요약은
        `handoff.summaryMasked` 와 `handoff.requested` **이벤트의 `summary_masked` 를 같은 스위치로
        함께** 막는다(한쪽만 막으면 이벤트 배열 하나로 약속이 무효가 된다, §2·§10.3) ·
        **어떤 잘못된 줄도 프로세스를 죽이지 않는다**(빈 줄·깨진 JSON·모르는 op 는 오류 응답이며,
        깨진 줄 원문은 되돌려주지 않는다 — 발신번호가 섞여 있을 수 있다) · 모르는 사용량·지연 키와
        음수는 거부한다(정체불명 필드가 과금 집계에 쌓이면 대사에서 전부 다시 본다, §11.2) ·
        헬스 샘플은 `state` 없이 통과하지 않는다(없는 상태를 up 으로 읽으면 장애가 정상으로 집계된다, §9.3) ·
        줄 길이 상한은 준 경우에만 검사한다(기본값 금지, §13-3). 요청은 도착 순서대로 직렬 처리된다 —
        같은 세션에 두 턴이 겹치면 상태가 갈라지기 때문이다. 기본 `dry_run`, `live` 는 승인 근거 필요 **[승인 필요]**.
        근거: `src/channels/bridge.ts` · `scripts/channel-bridge.mjs` · `fixtures/reference-core.mjs` ·
        `tests/channels.bridge.test.mjs`(25건) · CI `channel bridge runner (self-check)` 단계 ·
        안정 계약 경로 `aicc-core/channels/bridge`·`aicc-core/bridge-runner` 등록(`src/ops/packageSurface.ts`)
      · Core 측 완료(7): **파이썬 참조 클라이언트 + 기록 판정기(2026-09-07)** — 브리지를 열어 둔 것만으로는
        Callbot 이 붙지 않는다. 열린 경로 앞에 아무도 쓰지 않은 30줄이 남아 있으면, 각 저장소가 각자
        해석해서 짜고 **각자 다르게 틀린다**. 실제로 30줄짜리 JSONL 클라이언트에서 조용히 빠지는 것은
        정해져 있다: `end` 누락(세션이 안 닫히고 장애가 아니라 **요금**으로 먼저 나타난다) · `hello` 생략
        (버전 불일치가 조용히 지나간다) · 요청에 자기 테넌트 동봉(§11.1 — 지금은 브리지가 막지만 **보내려
        했다는 사실 자체**가 결함이다) · 응답을 그대로 로그·화면에 흘림(상담사용 요약·슬롯 값 유출, §2·§10.3).
        그래서 두 개를 같이 넣었다 — **참조 구현**과 **그 구현을 채점하는 별도 판정기**다.
        - 클라이언트(`clients/python/aicc_bridge.py`, 표준 라이브러리만): 테넌트·어댑터를 싣지 않고,
          응답을 **순서가 아니라 id 로 상관**지으며(어긋나면 조용히 넘기지 않는다 — 다른 통화 상태를 읽게 된다),
          개별 요청 실패를 예외로 바꾸지 않고(회선 하나가 통화 전체를 끊으면 안 된다), `session()`
          컨텍스트 매니저가 **예외 경로에서도 end 를 부른다**. 어떤 것도 print 하지 않는다(§10.3).
          타임아웃·줄 상한은 주지 않으면 검사하지 않는다(§13-3).
        - 판정기(`src/channels/bridgeTranscript.ts` + `scripts/bridge-transcript.mjs`): 보낸 줄과 받은 줄만
          넘기면 판정이 나온다 — **Core 타입을 몰라도 되므로 언어를 가리지 않는다**. 자기 채점이 되지 않게
          클라이언트와 프로세스를 분리했다. `--adapter`·`--max-line-bytes` 를 빼면 그 검사를 건너뛴 것이므로
          통과가 아니라 **판정보류(종료코드 2)** 다(§13-3).
        검증은 목이 아니라 **실제 python3 프로세스**를 띄워 한 통화(발화·DTMF·무음)를 끝까지 돌린 뒤
        판정기에 넣는다. python3 이 없으면 건너뛰며 통과로 적지 않는다.
        적합성 실행기 실측(도구 출력 그대로): `브리지 기록 검증: 통과 (오류 0 · 경고 0)` ·
        `요청 7줄 · 응답 7줄 · 성공 7 · 오류응답 0` · `세션 시작 1 · 종료 1`.
        근거: `clients/python/aicc_bridge.py` · `clients/python/selfcheck.py` ·
        `src/channels/bridgeTranscript.ts` · `scripts/bridge-transcript.mjs` ·
        `tests/channels.bridgeTranscript.test.mjs`(19건) · `tests/clients.python.test.mjs`(7건) ·
        CI `python bridge client (self-check)` 단계 ·
        안정 계약 경로 `aicc-core/channels/bridgeTranscript`·`aicc-core/transcript-runner` 등록
      · Core 측 완료(8): **음성 턴 규칙의 Core 귀속(2026-09-14)** — 세 저장소가 Core 를 소비하기
        시작했지만, 정작 음성에서 가장 자주 갈라지는 두 가지는 여전히 각 저장소에 있었다:
        **실패했을 때 무엇을 말할지**와 **얼마나 기다렸다가 실패로 볼지**. 둘 다 시나리오의 일부인데
        시나리오 밖에 있었다 — §2 가 지적한 이중 관리가 문안과 숫자의 형태로 남아 있던 셈이다.
        - 재프롬프트(`src/flow/reprompt.ts`): 실패 원인을 **무입력·저신뢰·불일치** 셋으로 가른다.
          셋을 굳이 나눈 이유는 필요한 다음 말이 서로 다르기 때문이다 — 침묵한 사람에게
          "잘 못 알아들었습니다"가 나가면 두 번째 시도도 같은 이유로 실패한다. 원인별·시도별
          사다리를 두되 **사다리를 다 쓰면 `exhausted` 로 드러낸다**(같은 말을 조용히 반복하면
          잘못된 재시도 설정이 영영 안 보인다). DTMF 안내는 음성 채널에서만 켜지고(§5.1),
          화면으로 전환된 뒤에는 켜지지 않는다(§5.2).
        - 턴 타이밍(`src/flow/timing.ts`): 입력 대기(ms)·재시도 가산·끼어들기 허용을 노드 종류별로
          선언한다. **0ms 대기와 적용되지 않는 노드 종류 선언은 등록 자체를 거부한다** —
          전자는 모든 턴을 즉시 무입력으로 떨어뜨리고, 후자는 "설정했는데 왜 안 되지"로 끝난다.
        두 모듈 모두 **기본값을 만들지 않는다**(§13-3): 3초든 8초든, "다시 말씀해 주세요"든
        Core 가 정할 근거가 없다(회선·상품·연령대·고객사 화법에 따라 다르다). 정책을 주지 않으면
        동작은 종전과 완전히 같고, 달라지는 것은 **선언하면 한 곳에서 선언된다**는 점뿐이다.
        채널 경계에는 적합성 검사 `TURN_HINTS` 를 추가했다 — 정책을 켜는 일은 코드 배포가 아니라
        설정 변경이므로, 모르는 필드를 보고 예외를 던지거나 단계를 고쳐 쓰는 포트는 **설정을 바꾸는
        순간 전 통화를 깨뜨린다**. 그 구현을 CI에서 미리 잡는다.
        근거: `src/flow/reprompt.ts` · `src/flow/timing.ts` · `src/flow/runner.ts`(배선) ·
        `src/channels/runtime.ts`(정책 주입·거부·경고) · `src/channels/conformance.ts`(`TURN_HINTS`) ·
        `tests/flow.reprompt.test.mjs`(26건) · `tests/flow.timing.test.mjs`(20건) ·
        `tests/channels.runtime.test.mjs`(24건) · `tests/channels.conformance.test.mjs`(21건)
      · Core 측 완료(9): **Callbot 훅 어댑터(2026-09-14)** — "어느 지점에서 부를지"의 절반은 사람의
        결정이 아니라 형태의 문제였다. `agent.py` 가 가진 것은 세션이 아니라 훅 셋(call_start·transcript·
        call_end)이고, 통화 둘이 겹치면 훅은 섞여서 온다. 참조 클라이언트를 복사해 넣는 것만으로는
        각 훅에서 "어느 통화의 세션인가·이미 끝났나·브리지가 죽었는데 끊어야 하나"를 저장소가 정하게
        되고, 그 판단은 각자 다르게 틀린다. 그래서 훅 모양 그대로 받는 어댑터를 Core 쪽에 두었다
        (`clients/python/aicc_callbot.py`, 표준 라이브러리만). 지키는 것(전부 실제 python3 로 검증):
        **기본 OFF** — `AICC_CORE_ENABLED`+Core 경로+모듈+Flow id 가 모두 있어야 켜지고, 빠지면 이유를
        남기고 꺼진다(Flow id 기본값 없음, §13-3) · **call_id 격리**(전역 "현재 통화" 금지 — 겹친 통화가
        남의 상태를 읽는다) · **고객 발화만 전송**(봇 발화가 고객 입력으로 시나리오를 밀지 않게) ·
        **브리지 사망이 통화를 끊지 않는다**(§9.3 — degraded 표시 + on_error 로 코드만 1회 보고, 이후 훅은
        즉시 None) · **종료 멱등 + close() 가 열린 통화를 먼저 닫는다**(누수는 요금으로 나타난다) ·
        끝난 통화의 지연 전사·모르는 통화·빈 발화는 보내지 않고 건수로만 남긴다 · print·logging 없음(§10.3) ·
        asyncio 래퍼는 같은 통화의 훅을 도착 순서대로 처리한다(겹치면 상태가 갈라진다).
        Callbot 저장소에는 `voice-agent/aicc/` 로 복사하고 배선 예시를 `README_AICC_CORE_연동.md` 에
        적었다 — `agent.py` 는 건드리지 않았다(아래 결정 사항).
        근거: `clients/python/aicc_callbot.py` · `tests/clients.callbot.test.mjs`(9건) ·
        CI `python callbot hooks (self-check)` 단계
      · Core 측 완료(10): **OpenAI 호환 규격 어댑터 + 복사본 드리프트 검사(2026-09-16)** —
        `http.ts` 의 중립 JSON 규약을 말하는 엔진은 세상에 없다. 실제로 붙을 온프렘 sLLM 서빙(vLLM·Ollama·TGI)과
        LLM API 대부분이 말하는 것은 `chat/completions`·`embeddings` 형태이므로, 그 형태를
        `src/adapters/openaiCompat.ts` 한 곳에서 흡수한다 — 채널 저장소가 각자 `choices[0].message.content` 를
        파고 각자 다르게 틀리는 일을 막는다. 게이트·비밀값·타임아웃·오류 분류는 `createEngineTransport` 가
        책임지고 여기서 복사하지 않는다. 모델 id·온도·토큰 상한 기본값 없음(§13-3), tool_calls·스트리밍 응답은
        빈 문자열이 아니라 `E_PROTOCOL` 로 드러낸다(§9.3). STT/TTS(멀티파트·바이너리)는 범위 밖.
        기본 `dry_run`, `plan()` 으로 실호출 없이 요청을 확인한다 **[실호출은 승인]**.
        파이썬 참조 클라이언트는 Callbot 에 **복사**되어 살므로 Core 가 고쳐도 저쪽은 그대로다 — 그 어긋남은
        컴파일 오류가 아니라 통화 중 다른 동작으로 나타난다. `src/ops/clientDrift.ts` + `scripts/client-drift.mjs`
        가 두 쪽을 대조한다(줄끝 차이는 경고, 내용 차이·누락은 실패, 대상을 못 읽으면 판정보류 §13-3).
        **2026-09-16 실측(도구 출력 그대로)**: `참조 클라이언트 복사본 대조: 통과` ·
        `aicc_bridge.py: 동일 [a24c2431b747 → a24c2431b747]` · `aicc_callbot.py: 동일 [18f308445966 → 18f308445966]`.
        CI 에는 게이트 규약 자체점검(같은 디렉터리 0 · 대상 미존재 2)만 있다 — Callbot 저장소가 CI 에 없기 때문이다.
        근거: `src/adapters/openaiCompat.ts` · `tests/adapters.openaiCompat.test.mjs` · `src/ops/clientDrift.ts` ·
        `tests/ops.clientDrift.test.mjs` · CI `client drift runner (self-check)` 단계 · `API.md` 반영
      · Core 측 완료(11): **OpenAI 호환 음성 규격 어댑터(2026-09-16)** — (10)은 텍스트만 흡수했고 음성은
        "범위 밖"으로 남겼다. 그런데 Callbot 이 실제로 붙어야 하는 엔진은 음성이고, 온프렘 Whisper 서빙·TTS 서버
        상당수가 말하는 형태는 `audio/transcriptions`(멀티파트 → JSON)·`audio/speech`(JSON → 오디오 바이트)다.
        JSON 왕복이 아니라 그대로 두면 음성 저장소가 멀티파트 조립과 바이너리 수신을 각자 짜게 되고, 사고는
        정확히 그 자리에서 난다 — 경계 문자열 충돌, 빈 응답을 재생, **200 으로 싸인 오류 JSON 을 오디오로 재생**.
        그래서 전송 계층(`http.ts`)에 `send`(임의 본문·JSON/바이너리 수신)를 열고, 그 위에
        `src/adapters/openaiAudio.ts` 를 얹었다. 게이트·비밀값·타임아웃·오류 분류는 여전히 전송 계층 한 곳이다.
        지키는 것(전부 테스트로 고정): 모델·음성(voice)·언어·응답 포맷 **기본값 없음**(§13-3) · TTS 문장은 마스킹
        경유, STT 파일명은 `audio.<ext>` 고정(통화 id·번호가 파일명으로 새지 않게, §10.3) · 오디오 바이트는 계획
        (plan)·거절 사유에 싣지 않고 크기·mime 만 서술 · 빈 오디오·상한 초과·모르는 mime·**섞인 mime** 은 호출 전
        거절 · TTS 응답은 content-type 이 오디오일 때만 통과(JSON·텍스트·빈 본문·헤더 부재는 `E_PROTOCOL`) ·
        `tts_audio_ms` 는 응답에 없으므로 만들지 않고, STT 는 엔진이 `duration` 을 줄 때만 `stt_audio_ms`(§11.2).
        스트리밍 STT(웹소켓)·실시간 TTS 청크는 범위 밖(한 발화 = 한 요청). 기본 `dry_run` **[실호출은 승인]**.
        근거: `src/adapters/openaiAudio.ts` · `src/adapters/http.ts`(`send`·`collectAudio`) ·
        `tests/adapters.openaiAudio.test.mjs`(15건) · `API.md` 반영
      · D-ARS 루트 CI 워크플로 적합성 단계: **완료** — `4. D-ARS/.github/workflows/ci.yml` 에 Core 체크아웃 +
        `conformance:aicc` 단계가 있다(토큰 없으면 건너뛰며 통과로 적지 않음)
      · 남은 것: **Callbot 저장소 쪽 배선** — 코드는 훅마다 한 줄(README 참조)이며 더 쓸 것이 없다.
        남은 것은 저장소 결정 사항이다: 현행 LLM 툴(welfare_apply 등)과 Core 시나리오의 역할 분담
        (어느 쪽이 화면 노드를 밀 것인가)·실운영 Core 모듈·Flow id 를 **사람이 정해야 한다**,
        챗봇·D-ARS CI 게이트 활성화를 위한 `AICC_CORE_TOKEN` 등록 **[승인 필요]**, 실회선·실메신저 연결 **[승인 필요]**
- [x] **이벤트 버스 영속화 어댑터** — 추가 전용 이벤트 원장(`EventLog`)·원장 기반 멱등 저장소·
      JSONL 직렬화/부분손상 복구·커서 기반 재전송·무결성 점검.
      근거: `src/events/store.ts` · `tests/events.store.test.mjs`(16건).
      인메모리+JSONL 참조 구현까지. 실 DB·브로커 어댑터 연결은 **[승인 필요]**
- [x] **과금 근거 데이터 대사(reconciliation) 검증 시나리오** — 이벤트→집계→외부명세 대조를 순수함수
      시나리오로 묶고, 차이를 원인 가설(중복·유실·반올림·단위환산·실측누락·미설명)로 분류.
      **과다청구 방향 미해소 차이가 있으면 `blocked` 판정으로 청구를 막는다.**
      근거: `src/billing/reconcile.ts` · `tests/billing.reconcile.test.mjs`(17건)
- [x] **관리 포털 IA 타입과 실제 화면 매핑 문서** — 문서가 아니라 **자료구조 + 검사**로 만들었다.
      손으로 적은 매핑표는 반드시 썩고, 썩은 표는 없느니만 못하기 때문이다. 검사는 무게를 나눠 둔다:
      **IA 에 없는 화면**(권한 검사·감사 기록을 안 거치는 화면이 된다)과 **감사 대상 화면의 배선 누락**(§10.2)은
      오류, 빈 상태·오류 상태 누락은 경고다. "구현 완료"로 적으려면 화면 위치가 있어야 하고, 보류에는 사유가
      있어야 한다 — 사유 없는 보류는 누락과 구분되지 않는다. 진행률(%)은 만들지 않고 건수만 적는다(§13-3).
      문서 `PORTAL_SCREEN_MAP.md` 는 생성물이며, 손으로 고치면 CI 가 잡는다.
      **현재 실측**: 라우트 25건 전부 미착수(포털 저장소는 정적 소개 페이지 한 장) · 감사 대상 15건 중 배선 0건.
      근거: `src/portal/screenMap.ts` · `scripts/screen-map.mjs` · `PORTAL_SCREEN_MAP.md` ·
      `tests/portal.screenMap.test.mjs`(18건) · CI `portal screen map (doc freshness)` 단계
- [x] 공개 API 문서 — 채널 저장소가 만질 것을 **두 인터페이스로 좁혀** 앞에 두고(그 외 모듈 직접 호출 금지),
      전 모듈의 계약·주요 export·공통 규약(활성화 승인·시계 미주입 시 공백·기본값 금지·마스킹·스코프·오류
      비은폐)을 한 문서에 모았다. 문서가 썩지 않도록 **테스트가 문서와 소스를 대조**한다 —
      없는 export 를 소개하거나 새 모듈을 문서에 빠뜨리면 CI에서 깨진다.
      근거: `API.md` · `tests/docs.api.test.mjs`(5건)

## 파트너 채널 (제이투모로우원 — 운영 대행 + 수익 배분)

계약·서비스 주체는 고원, 파트너는 영업·운영을 담당하고 수익을 배분한다.
**향후 리셀러(파트너 명의 계약)로 전환될 수 있으므로, 지금은 2계층으로 확장 가능한 형태로만 열어둔다.**

- [x] **파트너(채널) 개념 도입** — `partner_id`(nullable, 없으면 직접 계약) + 역할(`referrer`·`operator`·`reseller`)
      을 타입으로 도입. 유입 경로와 파트너 유무가 어긋난 기록(파트너 유입인데 파트너 없음, 직접 계약인데
      파트너 있음)은 저장 전에 거부한다 — 어긋난 채 쌓이면 정산 때 전부 다시 봐야 한다.
      근거: `src/partner/attribution.ts` · `tests/partner.attribution.test.mjs`(29건). 화면 노출은 아직 없음
- [x] **매출 귀속 근거** — 유입 경로·계약일·담당자·근거참조를 **추가 전용 이력**으로 남기고, 바뀌면 사유와 함께
      새 기록을 쌓는다. 담당자·변경사유는 저장 경로에서 한 번만 마스킹한다(§10.3, 호출자마다 하면 언젠가 빠진다).
      "현재 유효 귀속" 선택 규칙을 함수 하나에 가둬 화면마다 정산 금액이 달라지지 않게 했고,
      같은 고객사에 다른 파트너가 기록된 충돌은 **자동으로 고르지 않고 드러낸다** — 사람이 확정한다 **[승인 필요]**.
      시계 미주입 시 기록 시각을 만들어 넣지 않는다(§13-3).
      근거: `src/partner/attribution.ts`(`buildAttribution`·`currentAttribution`·`findAttributionConflicts`)
- [x] **파트너 역할 권한** — `partner_admin` 역할을 도입하되 **세 겹으로 잠갔다**. 파트너에게 포털을 여는
      순간 나는 사고는 대개 코드가 틀려서가 아니라 조건이 **빠져서** 나기 때문이다.
      (1) **기본 거부** — `partner_admin` 은 IA 라우트에서 어떤 권한도 얻지 못한다. 접근 근거는
      `PARTNER_ROUTE_ALLOWLIST` 하나뿐이라 **새 화면을 추가해도 자동으로 열리지 않는다**.
      (2) **미결속 거부** — `partnerId` 가 없는 계정은 "전체 조회"가 아니라 거부다. 이 한 줄이 없으면
      값이 안 들어간 계정 하나로 전 고객사가 노출된다. 조회 조건도 만들어 주지 않고 던진다.
      (3) **역할 혼용 거부** — 내부 역할과 동시 보유는 설정 오류로 본다(어느 쪽으로 판정했는지가 화면마다 달라진다).
      조회는 `partnerActorFilter` 가 `partnerId` 를 강제 주입하고(호출자가 덮어쓸 수 없다),
      결과는 `filterForPartnerActor` 가 한 번 더 거른다 — 판정 실패는 빈 목록이지 전체가 아니다.
      거부는 빠짐없이 감사 체인에 남고(외부 인력의 접근 시도는 조사에서 가장 먼저 본다),
      다른 테넌트 시도는 행위자 테넌트 체인에 남긴다(§11.1). 행위자 역할은 실제 값 그대로 기록한다.
      지금 열린 화면은 정산 근거 조회(`reports.settlement`) 하나이며 읽기 전용·비 PII 다 —
      허용 목록을 잘못 늘려도 PII·상태변경 화면은 마지막 방어선에서 막힌다.
      **활성화 기본 OFF** — `activation: 'enabled'` + `approvalRef` 가 둘 다 있어야 켜진다 **[승인 필요]**.
      근거: `src/partner/rbac.ts` · `src/portal/ia.ts`(`partner_admin`·`reports.settlement`) ·
      `tests/partner.rbac.test.mjs`(27건)
- [ ] **정산 리포트** — 산출 근거 + **반출**까지 완료(`rollupByPartner`·`buildSettlementLines`·`settlementBlockers`):
      고객사는 **현재 유효 귀속으로 한 번만** 집계되고(이력 전체를 세면 중복된다), 수수료율은 설정에서 오며
      실적·요율이 **둘 다 있을 때만** 금액을 산출한다 — 없으면 0원으로 채우지 않고 이유를 남긴다.
      0원과 "모른다"를 같게 적는 것이 정산 분쟁을 만들기 때문이다(§13-3).
      유입 경로 미확정·귀속 충돌이 있으면 정산을 막는다.
      조회 라우트(`reports.settlement`, 읽기 전용·비 PII)와 파트너 담당자 접근 판정은 확보됐다(위 파트너 역할 권한).
      **내보내기(2026-09-05)**: 사고는 계산이 아니라 반출 시점에 난다 — 그래서 반출 경로를 함수 하나로 좁혔다.
      순서가 곧 안전장치다(격리 → 권한 → 행 필터 → 차단 판정 → 기록 → 본문): 본문을 마지막에 만들어
      어느 단계에서 걸려도 표가 남지 않는다. 막힌 정산(`settlementBlockers`)은 **본문을 만들지 않고**,
      파트너 담당자에게는 판정과 별개로 행을 한 번 더 걸러 제외 건수를 드러낸다(조용히 줄이지 않는다).
      `reports.settlement` 은 감사 대상 화면이 아니지만 **반출은 성공·거부·차단 모두 기록**하고,
      임계값(설정값)을 넘으면 대량 반출로 표시한다. 0건은 "0건짜리 CSV"가 아니라 빈 상태 안내다 —
      받는 쪽에서 실적 0 으로 읽히기 때문이다. CSV 는 엑셀에서 열리므로 `=`·`+`·`-`·`@` 로 시작하는 값을
      무력화하고, 사유 문구는 maskPii 를 지난다(§10.3).
      근거: `src/partner/settlementExport.ts` · `tests/partner.settlementExport.test.mjs`(20건)
      남은 것: **화면 구현**(포털 저장소), 실제 청구 연결 **[승인 필요]**
- [x] **2계층 확장 여지 확보** — 파트너 필터가 들어갈 조회 경로를 `partnerScopedFilter` 한 곳으로 모으고,
      테넌트 조건은 기존 `scopedFilter` 가 강제 주입해 호출자가 덮어쓸 수 없게 했다(§11.1).
      `partnerId` **생략(전체)** 과 `null`(직접 계약만)을 타입에서 갈라 둔 것이 핵심이다 —
      둘을 `undefined` 하나로 섞으면 파트너 담당자에게 전체 고객사가 보이는 사고가 난다.
      저장소 조건과 별개로 `visibleToPartner` 가 한 번 더 거른다(조건 누락이 곧 유출).
      화이트라벨은 구현하지 않음. 근거: `src/partner/attribution.ts` · `tests/partner.attribution.test.mjs`

> 원칙: 파트너 관련 기능도 **코드는 만들되 활성화는 승인**. 실제 정산·청구는 계약서 확정 후.

