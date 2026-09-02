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
- [ ] **백업·복구 절차** RUNBOOK.md 문서화 + 복구 리허설 기록
- [ ] **약관·개인정보 처리방침 확정본 반영** (현재 초안, 문안은 사람이 확정)
- [ ] **테스트** 핵심 로직 커버리지 확보, CI에서 실행

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
      · 남은 것: 채널 저장소 3곳이 `ChannelTransport` 를 구현해 basePort 에 끼우고 CI에서 적합성 스위트 실행
        (실회선·실메신저 연결은 **[승인 필요]**)
- [x] **이벤트 버스 영속화 어댑터** — 추가 전용 이벤트 원장(`EventLog`)·원장 기반 멱등 저장소·
      JSONL 직렬화/부분손상 복구·커서 기반 재전송·무결성 점검.
      근거: `src/events/store.ts` · `tests/events.store.test.mjs`(16건).
      인메모리+JSONL 참조 구현까지. 실 DB·브로커 어댑터 연결은 **[승인 필요]**
- [x] **과금 근거 데이터 대사(reconciliation) 검증 시나리오** — 이벤트→집계→외부명세 대조를 순수함수
      시나리오로 묶고, 차이를 원인 가설(중복·유실·반올림·단위환산·실측누락·미설명)로 분류.
      **과다청구 방향 미해소 차이가 있으면 `blocked` 판정으로 청구를 막는다.**
      근거: `src/billing/reconcile.ts` · `tests/billing.reconcile.test.mjs`(17건)
- [ ] 관리 포털 IA 타입과 실제 화면 매핑 문서
- [ ] 공개 API 문서 — 각 모듈 사용법과 계약

## 파트너 채널 (제이투모로우원 — 운영 대행 + 수익 배분)

계약·서비스 주체는 고원, 파트너는 영업·운영을 담당하고 수익을 배분한다.
**향후 리셀러(파트너 명의 계약)로 전환될 수 있으므로, 지금은 2계층으로 확장 가능한 형태로만 열어둔다.**

- [ ] **파트너(채널) 개념 도입** — 조직/계약에 `partner_id`(nullable) 추가. 없으면 직접 계약. 스키마만 준비하고 화면 노출은 최소
- [ ] **매출 귀속 근거** — 어떤 고객사가 어느 파트너를 통해 유입됐는지 기록(유입 경로·계약일·담당자). 정산 분쟁을 예방하는 핵심
- [ ] **파트너 역할 권한** — 파트너 담당자는 자기가 유치한 고객사만 조회. 기존 RBAC에 `partner_admin` 역할 추가(활성화는 승인)
- [ ] **정산 리포트** — 파트너별 계약·이용 실적·수수료 산출 근거를 조회·내보내기. 수수료율은 설정값으로 분리(하드코딩 금지)
- [ ] **2계층 확장 여지 확보** — 테넌트 조회 경로에 파트너 필터가 나중에 끼어들 수 있도록 쿼리 계층 정리. 지금 화이트라벨은 구현하지 않음

> 원칙: 파트너 관련 기능도 **코드는 만들되 활성화는 승인**. 실제 정산·청구는 계약서 확정 후.

