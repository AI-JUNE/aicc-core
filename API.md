# 공개 API — AICC Conversation Core

Core 는 **순수 라이브러리**다. 서버를 띄우지 않고, 엔진·회선·DB 에 직접 붙지 않는다.
모든 외부 연결은 호출자가 주입하는 포트 뒤에 있다(§6.2). 실호출 활성화는 **[승인 필요]** 다.

- 소비 대상: `2. Callbot`(voice) · `3. Chatbot`(chat) · `4. D-ARS`(visual IVR) · 관리 포털
- 런타임: Node 22+ (테스트가 `.ts` 를 타입 스트리핑으로 직접 import 한다)
- import 경로는 **package.json 의 exports 맵**으로 고정돼 있다(소스 파일을 옮겨도 채널이 깨지지 않는다):
  `import { createConversationCore } from 'aicc-core/channels/runtime'`
  - 채널 계약 경로(안정): `aicc-core/channels/{contract,basePort,conformance,profiles,runtime}` ·
    `aicc-core/flow/types` · `aicc-core/conformance-runner`
  - 호스트(관리 포털·배치)용: `aicc-core/internal/<경로>` — **안정 계약이 아니다.** 이름에 그렇게 적어 뒀다.
  - 저장소를 직접 참조해 쓸 때는(레지스트리 배포는 **[승인 필요]**) `file:` 의존성으로 건다:
    `"aicc-core": "file:../6. AICC-Core"`
  - 이 맵이 실제 파일과 어긋나면 Core CI 가 잡는다(`src/ops/packageSurface.ts`)

---

## 1. 채널 저장소가 알아야 할 최소 API

채널 저장소는 **두 개만** 만진다. 나머지 모듈을 직접 호출하면 Core 리팩터링이 채널 3개를 동시에 깨뜨린다.

| 방향 | 인터페이스 | 위치 |
|---|---|---|
| 채널 → Core | `ConversationCorePort` (`start`/`send`/`end`/`reportHealth`) | `src/channels/contract.ts` |
| Core → 채널 | `ChannelPort` (`present`/`transfer`/`end`/`routeToLegacyIvr?`/`invite?`) | `src/channels/contract.ts` |

`ChannelPort` 를 처음부터 구현하지 말 것. `createChannelPort` 가 입력 동결·종료 멱등·예산 초과·
마스킹·실패 보고를 이미 처리한다. 저장소가 쓸 것은 **`ChannelTransport.deliver` 하나**다.

```ts
import { createChannelPort, type ChannelTransport } from 'aicc-core/channels/basePort';
import { runChannelConformance, formatConformanceReport } from 'aicc-core/channels/conformance';

// 1) 매체로 내보내는 부분만 구현한다. 실패는 던진다 — 베이스가 마스킹·기록·보고로 바꾼다.
const transport: ChannelTransport = {
  name: 'kakao',
  async deliver(env) {
    if (env.kind === 'present') await sendToMessenger(env.interactionId, env.steps ?? []);
    if (env.kind === 'transfer') await handToAgent(env.interactionId, env.queue, env.summaryMasked);
    if (env.kind === 'end') await closeSession(env.interactionId);
  },
};

// 2) 기본은 dry_run — 매체를 호출하지 않는다. live 는 approvalRef + transport 가 모두 있어야 만들어진다.
const port = createChannelPort({
  id: 'chatbot',
  transport,
  activation: process.env.AICC_CHANNEL_ACTIVATION === 'live' ? 'live' : 'dry_run',
  approvalRef: process.env.AICC_CHANNEL_APPROVAL_REF,   // [승인 필요]
  timeoutMs: 3000,                                      // 계약값. 코드 기본값을 두지 않는다(§13-3)
  onFailure: (r) => log.error('채널 전송 실패', r),       // 삼키지 않는다
});

// 3) 저장소 CI에서 적합성 스위트를 돌린다. 통과 못 하면 배포하지 않는다.
const report = await runChannelConformance({ port, timeoutMs: 3000 });
if (!report.passed) throw new Error(formatConformanceReport(report));
```

3번을 코드로 쓰기 싫다면 실행기를 그대로 부른다. 저장소는 포트를 export 하는 모듈 하나만 만들면 된다:

```bash
# 저장소 CI. 종료코드 0=통과, 1=실패, 2=판정보류 — 판정보류를 통과로 넘기지 말 것.
node <core>/scripts/channel-conformance.mjs \
  --port ./ci/aicc-port.mjs \
  --flows ./ci/aicc-flows.mjs \
  --adapter chatbot \
  --timeout-ms 3000
```

`--timeout-ms` 나 `--flows` 를 빼면 해당 검사를 건너뛰고 **판정보류**가 된다. 건너뛴 검사는 통과의
근거가 아니기 때문이다(§13-3). 실행기는 드라이런 포트만 검사한다 — `live` 포트는 멈춘다 **[승인 필요]**.
복사해 갈 최소 예시는 `fixtures/reference-port.mjs` · `fixtures/reference-flows.mjs` 에 있다.

Core 런타임 배선:

```ts
import { createConversationCore, createMemoryFlowRegistry } from 'aicc-core/channels/runtime';

const core = createConversationCore({
  scope: { tenantId },                 // §11.1 — 스코프 없는 진입 경로를 만들지 않는다
  flows: createMemoryFlowRegistry([flow]),
  channels: [{ port, reportsComponents: ['nlu', 'llm'], contractVersion: 1 }],
  policy: fallbackPolicy,              // §9.3
  health: healthRegistry,
});
core.warnings().forEach((w) => log.warn(w));   // 폴백 경로 없음 등 — 반드시 노출한다

const first = await core.start({ scope, adapter: 'chatbot', entryPoint, flowId });
const next  = await core.send(first.interactionId, { input: { kind: 'text', text }, latency, usage });
```

`ChannelTurnResult.steps` 를 채널 표현으로 바꾸는 것 외에 채널이 할 일은 없다.
이벤트(§8.1)·폴백 판정(§9.3)·이관 요약(§2)은 Core 가 만든다.

---

## 2. 모듈 목록

### 도메인·세션

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `domain/types.ts` | Interaction·Turn·Outcome(§4.1) | `Interaction`, `Turn`, `resolveOutcome` |
| `core/session.ts` | 세션 생성·턴 적재·폴백 판정 | `createInteraction`, `attachChannel`, `appendTurn`, `decideFallback` |
| `core/tenancy.ts` | 테넌트 격리(§11.1). 파티션 키·벡터 네임스페이스·소유 검증 | `assertTenantScope`, `partitionKey`, `scopedVectorStore`, `assertOwned`, `scopedFilter` |
| `core/policyGuard.ts` | 저장 전 마스킹(§10.3) | `maskPii` |
| `core/retention.ts` | 보존·파기(§8.2). 분류가 곧 파기 단위 | `DataClass`, `validateRetentionPolicy`, `decide`, `planDisposition` |
| `core/handoffSummary.ts` | 상담사 이관 요약(§2). 마스킹 완료본만 나간다 | `buildHandoffSummary`, `renderSummaryText`, `attachHandoffSummary` |
| `core/channelSwitch.ts` | 채널 전환 초대·상환(§5.2) | `issueInvite`, `checkRedeem`, `applyInvite`, `canSwitchToVisual` |
| `consent/consent.ts` | 동의 상태와 행위 게이팅 | `evaluateConsents`, `gateAction`, `grant`/`deny`/`withdraw` |

### 시나리오(Flow)

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `flow/types.ts` | 노드 정의와 채널별 렌더(§5.3) | `Flow`, `FlowNode`, `RenderedStep`, `renderNode` |
| `flow/runner.ts` | 하나의 Flow 를 채널 무관하게 실행 | `start`, `send`, `FlowState`, `RunStatus` |
| `flow/validate.ts` | 배포 전 정적 검증 | `validateFlow`, `validateFlowConnectors`, `canPublish` |
| `flow/lifecycle.ts` | 초안→검토→승인→배포→롤백 | `createDraft`, `submitForReview`, `approve`, `publish`, `rollback`, `deploymentStatus` |

### 어댑터(엔진 비종속, §6.2)

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `adapters/index.ts` | STT·TTS·LLM·임베딩 인터페이스 + 국외이전 가드 | `EngineSet`, `SttAdapter`, `LlmAdapter`, `assertResidency` |
| `adapters/http.ts` | HTTP 실엔진 어댑터. 기본 `dry_run`, live 는 approvalRef+비밀값 주입 필요 **[승인 필요]** | `createHttpEngineSet`, `HttpEngineConfig`, `activationFromEnv` |
| `adapters/sim.ts` | 개발·테스트용 시뮬레이터 | `simStt`, `simTts`, `simLlm`, `simEmbedding` |
| `integration/connector.ts` | 외부 업무 시스템 커넥터 정의·요청 조립·실패 판정 | `validateConnector`, `buildRequest`, `redactRequest`, `applyResponse`, `decideOnFailure` |

### 채널 계약

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `channels/contract.ts` | 양방향 포트 정의 | `ConversationCorePort`, `ChannelPort`, `ChannelCapabilities`, `validateRegistration` |
| `channels/basePort.ts` | 계약을 지키는 포트 베이스 | `createChannelPort`, `ChannelTransport`, `createChannelPortSet` |
| `channels/conformance.ts` | 저장소 CI용 적합성 스위트 10종 + 참조 드라이런 포트 | `runChannelConformance`, `formatConformanceReport`, `createDryRunPort` |
| `channels/harness.ts` | 적합성 스위트를 CLI 로 돌리는 실행기 로직(설정 해석·포트/시나리오 해석·판정·출력) | `parseHarnessArgs`, `runHarness`, `resolvePortFromModule`, `resolveFlowsFromModule`, `formatHarnessResult`, `harnessResultToJson`, `safeReasonText`, `HARNESS_EXIT_CODE` |
| `channels/profiles.ts` | 채널 3종 능력 기본값 | `CHANNEL_PROFILES`, `profileFor` |
| `channels/runtime.ts` | Core 측 실구현 | `createConversationCore`, `createMemoryFlowRegistry`, `createMemorySessionStore` |

### 이해·지식·라우팅

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `nlu/intent.ts` | 의도 판정·되묻기·에스컬레이션 | `validateIntentCatalog`, `decideIntent`, `nextStep` |
| `knowledge/rag.ts` | 청킹·색인 준비·근거 판정. 근거 없으면 답하지 않는다 | `chunkText`, `prepareIngest`, `decideGrounding`, `formatCitations` |
| `routing/agentQueue.ts` | 큐 선택·업무시간·대기 수용·배정 오퍼 | `validateRoutingConfig`, `isOpen`, `selectQueue`, `admitToQueue`, `offerAssignment` |

### 이벤트·과금·리포트

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `events/schema.ts` | §8.1 이벤트 4종. 테넌트 없는 이벤트를 만들 수 없다 | `sessionStarted`, `turnCompleted`, `handoffRequested`, `sessionEnded` |
| `events/bus.ts` | 멱등 발행·중복 제거·싱크 결과 집계 | `createEventBus`, `idempotencyKey`, `dedupeEvents` |
| `events/store.ts` | 추가 전용 원장·JSONL·부분손상 복구·재전송 | `createMemoryEventLog`, `serializeJsonl`, `parseJsonl`, `replayUndelivered`, `verifyLogIntegrity` |
| `billing/usage.ts` | 사용량 집계·반올림·외부 명세 대조(§11.2) | `aggregateUsage`, `applyRounding`, `reconcile` |
| `billing/reconcile.ts` | 대사 시나리오. 과다청구 방향 미해소 차이는 `blocked` | `runReconciliationScenario`, `formatReconciliationReport` |
| `partner/rbac.ts` | 파트너 담당자 권한. 기본 거부·미결속 거부·역할 혼용 거부, 활성화는 **[승인 필요]** | `PARTNER_ROUTE_ALLOWLIST`, `partnerRbacEnabled`, `decidePartnerAccess`, `partnerActorFilter`, `filterForPartnerActor`, `recordPartnerAccess`, `partnerRbacSelfCheck` |
| `partner/attribution.ts` | 파트너(채널) 귀속·정산 근거. 수수료율은 설정값, 청구는 하지 않는다 **[승인 필요]** | `validateAttribution`, `buildAttribution`, `partnerScopedFilter`, `visibleToPartner`, `currentAttribution`, `findAttributionConflicts`, `rollupByPartner`, `buildSettlementLines`, `settlementBlockers` |
| `partner/settlementExport.ts` | 정산 리포트 반출. 차단·권한 필터·대량 반출 감사·CSV 수식 무력화. 청구는 하지 않는다 **[승인 필요]** | `exportSettlement`, `serializeSettlement`, `settlementFilename`, `csvCell`, `SETTLEMENT_ROUTE_ID`, `SETTLEMENT_CSV_HEADER` |
| `reports/aggregate.ts` | 기간·채널별 집계와 완결성 표시 | `aggregateReport`, `latencyReport`, `topIntents`, `completeness` |

### 운영·관측·감사

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `ops/fallback.ts` | 컴포넌트 건강도 → 폴백 모드(§9.3) | `createHealthRegistry`, `decideFallbackMode`, `resolveRuntimeAction` |
| `ops/health.ts` | liveness/readiness 분리, 프로브 병렬·개별 예산 | `checkHealth`, `livenessReport`, `approvalPendingProbe` |
| `ops/backup.ts` | 백업·복구와 **복구 리허설**(RUNBOOK.md 참조) | `createSnapshot`, `verifySnapshot`, `serializeSnapshot`, `parseSnapshot`, `restoreSnapshot`, `runRecoveryDrill` |
| `ops/packageSurface.ts` | 채널이 부르는 import 경로(package.json exports) 고정·검증. 배포는 **[승인 필요]** | `CHANNEL_SUBPATHS`, `expectedExports`, `validatePackageSurface`, `surfaceOk`, `formatSurfaceReport` |
| `ops/coverage.ts` | 커버리지 실측 요약·임계값 판정. 목표치를 코드에 두지 않는다(§13-3) | `summarizeCoverage`, `evaluateCoverage`, `thresholdsFromEnv`, `percentOf`, `weakestFiles`, `formatCoverageReport`, `coverageToJson`, `COVERAGE_EXIT_CODE` |
| `obs/logger.ts` | 고정 필드 구조화 로깅·차단 키·마스킹 경유 | `createLogger`, `createRequestIdFactory`, `createMemorySink` |
| `obs/errorMonitor.ts` | 던져진 값 정규화·fingerprint·중복 억제 | `createErrorMonitor`, `normalizeError`, `installGlobalCapture`, `resolveDsnConfig` |
| `audit/log.ts` | 해시 체인 감사 원장·무결성 검증 | `appendAudit`, `verifyChain`, `queryAudit`, `maskIp` |
| `audit/access.ts` | 관리 화면 접근 판정+기록을 한 함수로 | `recordAccess`, `accessHistory`, `accessSummary` |
| `qa/compliance.ts` | 금칙어·AI 고지 준수 점검 | `runComplianceCheck`, `requiresHumanReview` |

### API 표면·포털

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `api/errors.ts` | 코드→HTTP상태·재시도 매핑, 항목 단위 검증 | `apiError`, `toErrorResponse`, `validate`, `validationResponse` |
| `api/rateLimit.ts` | 테넌트 경계 포함 토큰버킷 | `createRateLimiter`, `enforceRateLimit`, `rateLimitKey` |
| `portal/ia.ts` | 관리 포털 정보구조·역할별 접근 | `PORTAL_SECTIONS`, `PORTAL_ROUTES`, `canAccess`, `buildNav` |
| `portal/screenMap.ts` | IA 라우트 ↔ 실제 화면 매핑·감사 배선 점검. 문서(`PORTAL_SCREEN_MAP.md`)를 생성한다 | `PORTAL_SCREEN_MAP`, `validateScreenMap`, `screenMapOk`, `screenMapCoverage`, `renderScreenMapMarkdown`, `formatScreenMapReport` |
| `portal/aiDisclosure.ts` | AI 고지 문구·노출 위치 | `resolveDisclosure`, `validateDisclosureConfig` |
| `portal/interactionQuery.ts` | 상호작용 조회 검증·정규화·감사 기록 | `validateQuery`, `normalizeQuery`, `runQuery`, `buildQueryAudit` |

---

## 3. 공통 규약

이 규약은 모든 모듈에 동일하게 적용된다. 예외를 두지 않는다.

1. **활성화는 승인.** 외부로 나가는 모듈(`adapters/http.ts`, `channels/basePort.ts`)의 기본값은 `dry_run` 이다.
   `live` 는 `approvalRef` 와 구현 주입이 **모두** 있어야 만들어진다. 없으면 생성 시점에 거부된다.
2. **시각·소요는 주입된 시계로만.** `clock`/`now` 를 주지 않으면 시각·소요 필드를 **비워 둔다.**
   기본값을 만들어 넣지 않는다(§13-3).
3. **임계값·한도·예산에 코드 기본값을 두지 않는다.** 계약값·설정값으로 받는다.
4. **개인정보는 저장·로그·오류 어느 경로로도 원문이 나가지 않는다**(§10.3). 오류 메시지도 `maskPii` 를 거친다.
5. **테넌트 스코프 없는 진입점을 만들지 않는다**(§11.1). 스코프 밖 자료는 조용히 걸러내지 않고 거부한다.
6. **오류를 삼키지 않는다.** 계약상 예외를 던질 수 없는 자리(채널 포트 등)에서는 `failures`·`onFailure` 로 드러낸다.

## 4. 검증

```
npm run typecheck      # tsc --noEmit
npm test               # node --test "tests/*.test.mjs"
node scripts/recovery-drill.mjs   # 복구 리허설: 0=통과 1=실패 2=판정보류
```

CI(`.github/workflows/ci.yml`)가 위 셋을 모두 실행한다.
채널 저장소는 여기에 더해 **자기 `ChannelPort` 구현에 대고** `runChannelConformance` 를 돌린다.
