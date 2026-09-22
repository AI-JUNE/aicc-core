# 공개 API — AICC Conversation Core

Core 는 **순수 라이브러리**다. 서버를 띄우지 않고, 엔진·회선·DB 에 직접 붙지 않는다.
모든 외부 연결은 호출자가 주입하는 포트 뒤에 있다(§6.2). 실호출 활성화는 **[승인 필요]** 다.

- 소비 대상: `2. Callbot`(voice) · `3. Chatbot`(chat) · `4. D-ARS`(visual IVR) · 관리 포털
- 런타임: Node 22+ (테스트가 `.ts` 를 타입 스트리핑으로 직접 import 한다)
- import 경로는 **package.json 의 exports 맵**으로 고정돼 있다(소스 파일을 옮겨도 채널이 깨지지 않는다):
  `import { createConversationCore } from 'aicc-core/channels/runtime'`
  - 채널 계약 경로(안정): `aicc-core/channels/{contract,basePort,conformance,profiles,runtime,bridge}` ·
    `aicc-core/flow/types` · `aicc-core/conformance-runner` · `aicc-core/bridge-runner`
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

### 1-1. Node 가 아닌 호스트 — JSONL 브리지

Callbot 음성 에이전트처럼 **Node 프로젝트가 아닌 호스트**는 위의 import 를 쓸 수 없다.
그런 호스트를 위해 언어에 묶이지 않는 소비 경로를 하나 더 연다: **한 줄 = 한 요청(JSONL)**.
표준입력으로 요청 한 줄을 쓰고 표준출력에서 응답 한 줄을 읽으면 되므로, 파이썬·자바·Go 어디서든
붙고 Core 내부 타입을 알 필요가 없다.

```bash
node <core>/scripts/channel-bridge.mjs --core ./ci/aicc-core.mjs --adapter callbot
```

```jsonl
→ {"id":"1","op":"hello"}
→ {"id":"2","op":"start","req":{"flowId":"f_x","entryPoint":"inbound_call"}}
← {"id":"2","ok":true,"result":{"interactionId":"...","steps":[...],"events":[...]}}
→ {"id":"3","op":"send","interactionId":"...","turn":{"input":{"kind":"dtmf","digits":"1"}}}
→ {"id":"4","op":"end","interactionId":"...","reasonKo":"고객 종료"}
```

지켜지는 경계(전부 테스트로 고정):

- **테넌트는 호스트가 주장하지 않는다.** `scope` 는 브리지 설정에서 강제 주입되고, 요청이 다른
  테넌트를 주장하면 조용히 덮어쓰지 않고 `E_TENANT_SCOPE` 로 거부한다(§11.1).
- **어댑터도 고정이다.** 브리지 하나가 채널 하나다.
- **슬롯 값과 상담사용 요약은 기본적으로 나가지 않는다.** 슬롯은 키 목록만 나가고, 요약은
  `--include-handoff-summary` 를 켠 소비자에게만 준다 — `handoff.summaryMasked` 와
  `handoff.requested` **이벤트의 `summary_masked` 를 같은 스위치로 함께** 막는다(§2·§10.3).
- **어떤 잘못된 줄도 프로세스를 죽이지 않는다.** 빈 줄·깨진 JSON·모르는 op 는 오류 응답이지 예외가
  아니며, 깨진 줄의 원문은 되돌려주지 않는다(발신번호가 섞여 있을 수 있다).
- 줄 길이 상한은 `--max-line-bytes` 를 준 경우에만 검사한다 — 기본값을 만들어 넣지 않는다(§13-3).
- **요청 제한은 `rateLimiter` 를 주입한 경우에만** 건다(한도 기본값 없음, §13-3). 키는 테넌트 스코프 + op 로
  고정되어 호스트가 바꿀 수 없고(§11.1), 초과분은 `E_RATE_LIMITED` + 계산된 `retryAfterMs` 로 거절된다.
  `hello`·`end` 는 **절대 막지 않는다** — end 가 막히면 세션이 새고 요금으로 먼저 나타난다. 제한기 자체가
  던지면 잠그지 않고 통과시킨다(§9.3). 다중 인스턴스 공유 저장소 연결은 **[승인 필요]**.
  제한기를 **실행기에 주는 방법**은 Core 모듈이 `rateLimiter`(선택적으로 `rateLimitCost`)를 함께
  내놓는 것이다 — 한도는 명령줄 옵션이 아니다. CLI 로 숫자를 받으면 그 값이 곧 정책이 된다(§13-3).
  `check(key, cost)` 가 없는 값을 주면 **설정 오류로 거부**한다: 런타임 장애(통과)와 형태 오류를
  같게 다루면 오타 하나로 제한이 조용히 꺼진 채 "적용했다"로 남는다.
- 기본 `dry_run` 이고 `live` 는 승인 근거가 있어야 만들어진다 **[승인 필요]**.

복사해 갈 최소 예시는 `fixtures/reference-core.mjs` 다(한도를 켠 예시는
`fixtures/reference-core-ratelimited.mjs` — 그 숫자는 정책이 아니라 검사용이다).

#### 파이썬 참조 클라이언트·훅 어댑터

`clients/python/aicc_bridge.py`(브리지 클라이언트)와 `clients/python/aicc_callbot.py`(훅 어댑터)는
Callbot 저장소에 **복사**되어 산다 — 어긋남은 `scripts/client-drift.mjs` 가 잡는다.

- `BridgeError.retry_after_ms` — 한도 초과 응답의 `retryAfterMs` 를 그대로 노출한다. 브리지가 주지
  않았거나 형태가 틀리면 `None` 이며 **0 으로 읽지 않는다**(0 으로 읽으면 곧바로 재시도해 한도를 더
  밀어붙인다, §13-3). `BridgeResponse.rate_limited` 로 브리지 사망과 구분한다.
- 훅 어댑터는 `E_RATE_LIMITED` 를 `degraded` 로 올리지 않고(올리면 통화 전체가 Core 를 잃는다, §9.3),
  받은 대기 시간 동안 **그 통화의 턴만** 보내지 않는다(`turns_deferred`). 대기 시간을 주지 않았으면
  대기하지 않는다. 종료(`on_call_end`)·`close()` 는 어떤 경우에도 미루지 않는다.
- `AsyncCallbotCoreHooks` 는 **같은 통화의 훅을 도착 순서대로** 처리한다. 체인 자리를 앞 훅을
  기다리기 전에 잡으므로, `await` 없이 훅을 던져도 `end` 가 마지막 턴을 앞지르지 않는다.
  `close()` 는 예약된 훅을 먼저 비운 뒤 브리지를 내린다(`drain()` 으로 따로 기다릴 수도 있다).

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
| `core/retention.ts` | 보존·파기(§8.2). 분류가 곧 파기 단위. **저장 가능 판정**(`canStore`·`assertStorable`)이 붙었다 — `mayContainPii` 분류는 보존 규칙이 없거나 미승인이면 **저장 자체를 거절**한다(기한 없이 먼저 쌓이면 기산 시점을 되돌릴 수 없고 `decide` 는 영원히 `blocked` 를 내, **지울 근거도 기한도 없는 개인정보**가 남는다). 종전에는 이 규칙이 `validateRetentionPolicy` 의 **오류 문자열 목록**에만 있어 저장하는 코드가 물어볼 데가 없었다(문자열을 부분 일치로 뒤지면 문구를 다듬는 순간 조용히 통과한다). 저장 판정과 파기 판정은 **같은 조건**이다 — 갈리면 저장은 되는데 파기는 안 되는 조합이 생긴다. 개인정보를 담지 않는 분류는 규칙이 없어도 막지 않고 경고만 낸다(막으면 설정을 다 채우기 전에는 이벤트 한 건도 못 쌓는다) | `DataClass`, `validateRetentionPolicy`, `decide`, `planDisposition`, `canStore`, `assertStorable` |
| `core/executeDisposition.ts` | `planDisposition` → 저장소 파기 포트. 판정은 다 있었는데 **계획을 받아 실제로 지우는 자리가 저장소 어디에도 없었다**(`planDisposition` 호출처가 테스트뿐). 막는 것: (1) **`plan.decisions` 순회** — `decisions`(전체)와 `due`(대상)가 둘 다 `RetentionDecision[]` 이라 어느 쪽을 돌려도 타입이 통과하고, 전체를 돌면 보존기간 한복판·법적 보류 건까지 지운다(증상은 몇 달 뒤 '분쟁 건 녹취가 없다'). 그래서 **계획 객체를 받고** `due` 의 `status` 를 한 번 더 확인한다 · (2) **승인 전 실행** — 활성화 **기본 OFF**, `activation:'enabled'` + `approvalRef` 가 둘 다 있어야 포트를 부르며 꺼진 동안은 `dry_run` 이다(포트 호출 지점은 코드에 **한 곳뿐**이고 검사가 그 사실을 고정한다) **[승인 필요]** · (3) **`disposition` 무시** — `anonymize`·`archive` 는 `delete` 가 아니다(동의 이력을 지우면 동의받았다는 증거가, 감사로그를 지우면 조사 근거가 사라진다). 포트는 방식별로 메서드가 갈려 있고 없는 방식은 `unsupported` 로 드러낼 뿐 **다른 방식으로 대신하지 않는다** · (4) **규약 위반 반환값을 성공으로 읽기** — `{ ok: true }` 정확히 그 모양만 파기로 적는다(아니면 `disposedAt` 이 찍혀 다음 스윕에서 영영 제외되고, 개인정보는 남은 채 장부에만 파기로 남는다) · (5) **한 건 실패에 스윕 전체 정지** — 격리 위반 말고는 던지지 않고 건별로 적고 계속 간다(실패 건은 `disposed` 가 아니라 다음 스윕이 다시 본다) · (6) **제한 시간 없음** — `timeoutMs` 는 주입이고 기본값 없음(§13-3), 초과 건은 '결과 미확인'이라 성공으로도 파기로도 적지 않는다 · (7) **같은 레코드 두 번 호출** — id 기준 1회, 중복은 드러낸다 · (8) **오류 원문 유출** — 저장소 오류에는 지우려던 행이 그대로 들어 있어 모든 문구가 `maskPii` 를 지난다(§10.3) · (9) **막힌 건·보류 건이 조용히 사라짐** — `blocked`·`held` 를 건수로 남긴다('0건 실패'와 '전부 막혀 한 건도 시도 못 함'은 다르다). 만료·보류·승인 판정은 `retention.ts` 하나에만 있고 여기서 복사하지 않는다(§2 — 검사가 `retentionDays`·`DAY_MS` 부재를 고정한다). 감사는 **결과를 안 뒤에** 시도 1건당 1레코드(드라이런은 `denied`), 상한 밖·중복은 저장소를 건드리지 않았으므로 적지 않는다. 실 DB·오브젝트 스토리지·벡터 색인 연결은 **[승인 필요]** | `executeDisposition`, `DisposalPort`, `DisposalAck`, `DisposalRequest`, `DisposalActivation`, `ExecuteDispositionResult`, `createMemoryDisposalPort`, `DISPOSITION_EXECUTION_CONTRACT_VERSION` |
| `core/handoffSummary.ts` | 상담사 이관 요약(§2). 마스킹 완료본만 나간다 | `buildHandoffSummary`, `renderSummaryText`, `attachHandoffSummary` |
| `core/channelSwitch.ts` | 채널 전환 초대·상환(§5.2) | `issueInvite`, `checkRedeem`, `applyInvite`, `canSwitchToVisual` |
| `core/executeSwitch.ts` | `canSwitchToVisual` → 1회용 토큰 발급 → 상환. 조각(`channelSwitch.ts`)은 다 있었는데 **꿰는 코드가 없어** 저장소 전체에서 그 함수들을 부르는 곳이 테스트뿐이었다 — 실제 전환 경로는 `port.invite(interactionId, target)` 로 **Interaction id 를 그대로** 넘기고 합류는 그 id 하나로 통과했으니, **링크에 실리는 값이 곧 진행 중인 세션의 열쇠**였다. 막는 것: (1) **id 가 열쇠가 되는 것** — 토큰이 id 를 품거나 id 가 토큰을 품으면 발급을 거절한다(다른 경로로 같은 문이 열리면 1회용·만료가 무의미하다) · (2) **판정 없이 링크부터 만드는 것** — 전환 가능 판정과 발급을 한 함수로 묶는다(화면을 못 받는 고객은 오지 않는 화면을 기다리다 통화가 끝난다) · (3) **거절을 성공으로 읽는 것** — 티켓이 담기는 경우는 발급 성공 하나뿐 · (4) **토큰이 오류 문구로 새는 것** — `maskPii` 는 토큰을 모른다, 레지스트리 오류에 토큰이 섞이면 메시지를 통째로 버린다 · (5) **승계 슬롯 값이 채널로 나가는 것** — 티켓에는 키 목록조차 없다(§10.3) · (6) **거절 사유가 외부로 나가는 것** — 사유 구분은 운영·감사용이며 고객 문안은 만들지 않는다(§13-3). 만료·1회용·테넌트·목적지 판정은 `channelSwitch.ts` 하나에만 있고 여기서 복사하지 않는다(§2). ttl·토큰 발급기·allowlist 는 전부 주입 — 없으면 설정 오류로 거절한다(Core 가 토큰을 만들면 추측 가능한 열쇠가 된다). 실발송(SMS·푸시·알림톡)은 **[승인 필요]** | `issueSwitch`, `redeemSwitch`, `SwitchTicket`, `SwitchDenyCode`, `IssueSwitchResult`, `RedeemSwitchResult`, `CHANNEL_SWITCH_EXECUTION_CONTRACT_VERSION` |
| `consent/consent.ts` | 동의 상태와 행위 게이팅 | `evaluateConsents`, `gateAction`, `grant`/`deny`/`withdraw` |
| `legal/documents.ts` | 약관·개인정보 처리방침 버전 관리(§10.1). 확정본은 승인 근거+시행일+본문 해시가 모두 있어야 하고, 조회는 확정본만 돌려준다(초안·미시행·다른 테넌트 문서는 나가지 않음). 수락 기록은 버전·해시를 남겨 개정 시 `stale`. 문안 확정은 **[승인 필요]** | `validateLegalDocument`, `finalizeDocument`, `createLegalRegistry`, `currentDocument`, `recordAcceptance`, `acceptanceStatus`, `legalReadiness`, `formatLegalReadiness`, `PLACEHOLDER_RE` |

### 시나리오(Flow)

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `flow/types.ts` | 노드 정의와 채널별 렌더(§5.3) | `Flow`, `FlowNode`, `RenderedStep`, `renderNode` |
| `flow/runner.ts` | 하나의 Flow 를 채널 무관하게 실행 | `start`, `send`, `FlowState`, `RunStatus` |
| `flow/reprompt.ts` | 실패 원인 분류(무입력·저신뢰·불일치)와 원인별·시도별 재프롬프트 사다리(§5.1). **기본 문안을 만들지 않는다** — 정책 미주입 시 노드 원문이 그대로 재생된다(§13-3) | `RepromptReason`, `RepromptPolicy`, `RepromptPlan`, `classifyFailure`, `buildReprompt`, `validateRepromptPolicy`, `repromptPolicyOk` |
| `flow/timing.ts` | 입력 대기(ms)·재시도 가산·끼어들기 허용을 한 곳에서 선언(§5.1). **기본 대기 시간을 만들지 않는다** — 미주입 시 채널이 종전 값을 쓴다(§13-3) | `TurnTimingPolicy`, `TurnTiming`, `INPUT_NODE_KINDS`, `resolveTurnTiming`, `validateTurnTimingPolicy`, `turnTimingPolicyOk` |
| `flow/validate.ts` | 배포 전 정적 검증 | `validateFlow`, `validateFlowConnectors`, `canPublish` |
| `flow/lifecycle.ts` | 초안→검토→승인→배포→롤백 | `createDraft`, `submitForReview`, `approve`, `publish`, `rollback`, `deploymentStatus` |

### 어댑터(엔진 비종속, §6.2)

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `adapters/index.ts` | STT·TTS·LLM·임베딩 인터페이스 + 국외이전 가드 | `EngineSet`, `SttAdapter`, `LlmAdapter`, `assertResidency` |
| `adapters/http.ts` | HTTP 실엔진 어댑터. 기본 `dry_run`, live 는 approvalRef+비밀값 주입 필요 **[승인 필요]** | `createHttpEngineSet`, `createEngineTransport`, `collectAudio`, `HttpEngineConfig`, `activationFromEnv`, `EngineError` |
| `adapters/openaiCompat.ts` | OpenAI 호환 규격(`chat/completions`·`embeddings`) 흡수. 게이트·비밀값·타임아웃은 `http.ts` 전송 계층이 책임지고, 여기서는 요청 조립·응답 해석만 한다. 모델 id 기본값 없음(§13-3), tool_calls·스트리밍은 `E_PROTOCOL` 로 드러낸다. 기본 `dry_run` **[실호출은 승인]** | `createOpenAiCompatEngines`, `parseChatCompletion`, `parseEmbeddings`, `OPENAI_COMPAT_PATHS`, `OpenAiCompatConfig` |
| `adapters/openaiAudio.ts` | OpenAI 호환 **음성** 규격(`audio/transcriptions` 멀티파트 업로드 → JSON, `audio/speech` JSON → 오디오 바이트) 흡수. 멀티파트 조립·바이너리 수신·200 으로 싸인 오류 JSON 거부를 한 곳에서 한다. 모델·음성·언어·포맷 기본값 없음(§13-3), TTS 문장은 마스킹 경유, STT 파일명은 확장자만(§10.3). `duration` 이 올 때만 `stt_audio_ms`(§11.2). 기본 `dry_run` **[실호출은 승인]** | `createOpenAiAudioEngines`, `parseTranscription`, `encodeMultipart`, `audioExtensionOf`, `OPENAI_AUDIO_PATHS`, `OpenAiAudioConfig` |
| `adapters/resilience.ts` | 엔진 호출의 **재시도·대체엔진·헬스 집계**를 한 곳에 모음(§9.3). 실패 성격을 6종으로 갈라 재시도·대체·집계 여부를 각각 정한다 — 승인 전 호출·빈 입력·설정 오류는 **엔진 장애로 집계하지 않고**, 콘텐츠 필터는 대체 엔진으로 우회하지 않는다. 재시도·대체로 되살아난 호출은 선언(`recoveryState`)이 없으면 `up` 이다 — `degraded` 샘플 하나가 음성 채널의 `speech_recognition` 을 끄기 때문이다(복구 사실은 `detail`·`attempts` 에 남는다). 재시도·대체까지 **전부** 실패해야 `down`. 재시도 횟수·대기 기본값 없음(§13-3, 주지 않으면 종전과 동일). 해외 후보는 `allowOverseas` 없이는 부르지 않고 제외를 드러낸다(§10.3). 스트리밍은 **첫 청크 전까지만** 복원력을 적용한다(재생된 말을 두 번 내보내지 않는다) | `createResilientCaller`, `withResilientEngines`, `classifyEngineFailure`, `healthFromOutcome`, `normalizeEngineError`, `selectCandidates`, `widestResidency`, `HEALTH_COMPONENT_OF`, `RETRYABLE_HTTP_STATUS` |
| `adapters/engineSet.ts` | 벤더별 **부분** 엔진셋(음성 규격은 `stt`·`tts`, 텍스트 규격은 `llm`·`embedding` 만 내놓는다)을 §6.2 `EngineSet` 하나로 묶는 조립기. 지금까지 이 사이는 `{ stt: audio.stt!, ... }` 로 메워야 했고, 그 `!` 가 **모델 id 누락을 통화 중까지 숨겼다**. 조립 시점에 거절하는 것: 필수 슬롯(`stt`·`tts`·`llm`) 누락(어느 조각에서 빠졌는지 적는다) · 한 슬롯을 두 조각이 채움(순서로 조용히 바뀌지 않게 **자동으로 고르지 않는다**) · **활성화 혼재**(반쪽 통화는 `not_activated` 라 §9.3 에서 장애로도 잡히지 않는다) · `residency`·`name` 미선언 어댑터 · 국외이전 불가 테넌트에 섞인 해외 슬롯(§10.3, `assertResidency` 를 호출자가 부르는 것을 잊지 못하게 조립기가 판정한다). `residency` 는 **가장 노출도가 높은 슬롯**으로 적는다. `collectUsage()` 는 조각들의 `lastUsage()` 실측을 모아 §11.2 근거로 넘기되, **같은 키를 두 조각이 내면 합산하지 않고 `conflicts` 로 드러내고**(이중 계상은 대사에서 과다청구가 된다) 음수·비유한수·모르는 항목은 버린 사실을 남긴다. 아무 값도 없으면 `undefined` — 빈 객체를 만들지 않는다(§13-3) | `assembleEngineSet`, `collectPartUsage`, `describeEngineSet`, `REQUIRED_SLOTS`, `AssembledEngineSet`, `PartialEngineSet`, `EnginePart` |
| `adapters/sim.ts` | 개발·테스트용 시뮬레이터 | `simStt`, `simTts`, `simLlm`, `simEmbedding` |
| `integration/connector.ts` | 외부 업무 시스템 커넥터 정의·요청 조립·실패 판정 | `validateConnector`, `buildRequest`, `redactRequest`, `applyResponse`, `decideOnFailure` |
| `integration/executeConnector.ts` | Api 노드(§6.1) **실행 오케스트레이터**. `connector.ts` 에 조각은 다 있었지만 그것을 순서대로 꿰는 코드가 없어, Runner 주석의 '호스트가 호출한 뒤' 전부가 빈 자리였다 — 그대로 두면 채널 3곳이 같은 20줄을 각자 쓰고 각자 빠뜨린다. **순서가 곧 안전장치다**(선언 검증 → 테넌트 격리 → 국외이전 → 동의 → 요청 조립 → 호출·재시도 → 응답 적용): 슬롯은 마지막에 만들어지므로 어느 단계에서 걸려도 세션에 병합할 물건이 생기지 않고, 게이트 셋은 요청을 조립하기 **전에** 지난다(조립된 요청에는 마스킹되지 않은 개인정보가 들어 있다). 고정하는 것: **멱등 키는 호출자가 주고 시도 간 바뀌지 않는다**(Core 가 매 시도 만들면 command 재시도가 곧 이중 신청이고, 로그에는 성공 두 건만 남는다) · pii 파라미터가 선언됐는데 **동의 컨텍스트가 없으면 호출하지 않는다**(없음을 통과로 읽지 않는다, §10.1) · 포트 예외·규약 위반 반환값은 통화를 끊지 않고 `unavailable`·`schema_mismatch` 로 내린다(§9.3) · **호출 전에 막힌 건(`blocked`)은 백엔드 장애로 집계하지 않는다**(집계하면 멀쩡한 업무시스템 때문에 전 채널이 상담사 직결로 떨어진다) · 한 번 실패로 `down` 을 적지 않는다(재시도가 남았으면 `degraded`) · 시계 미주입 시 헬스 샘플을 만들지 않고, 재시도를 선언했는데 `backoffMs` 가 없으면 설정 오류로 거절한다(§13-3) · `toFlowInput` 은 **`blocked` 를 성공으로 옮기지 않는다**(동의가 없어 못 불렀는데 다음 노드로 넘어가면 고객은 빈 안내를 듣는다). 네트워크에 직접 닿지 않는다 | `executeConnector`, `toFlowInput`, `redactedRequestOf`, `ExecuteOutcome`, `ExecuteConnectorInput`, `ConsentContext`, `BlockedReason`, `CONNECTOR_EXEC_CONTRACT_VERSION` |
| `integration/connectorPump.ts` | Api 대기 **이행 펌프**(§6.1). (위) 실행기를 만들어 두고도 **부르는 곳이 저장소 전체에 0건**이었다 — Runner 는 Api 노드에서 `pendingConnectorId` 를 세우고 멈추는데 그 필드를 읽는 코드가 어디에도 없었다(세우는 한 줄과 지우는 한 줄이 전부). 그 상태의 증상은 예외가 아니라 **무음**이라서 더 나쁘다: Api 대기 중 커넥터 결과가 아닌 입력에 `runner.send` 는 **빈 결과**(steps 0건·events 0건)를 돌려주므로, 고객이 무슨 말을 해도 채널은 렌더할 것이 없고 통화는 끊기지도 않은 채 멈추며 **어떤 알림도 울리지 않는다**. 고정하는 것: **멱등 키는 논리적 호출 단위로 고정된다**(같은 대기 건에 다시 들어오면 같은 키, onError 를 지나 같은 Api 노드를 **다시 밟았을 때만** 회차가 오른다 — 펌프가 부를 때마다 만들면 command 커넥터에서 이중 신청이 되고 로그에는 성공 두 건만 남는다) · **선언을 못 찾으면 실패로 내려** 시나리오의 `onError`·§9.3 이관이 돌게 하되 **백엔드 장애로 집계하지 않는다**(우리 쪽 설정 오류인데 업무시스템이 down 으로 적히면 전 채널이 상담사 직결로 떨어진다) · **순환은 구조적 상한**(`connectorHopLimit` = Api 노드 수 + 1)으로 끊는다 — `advance()` 의 순회 상한과 같은 성격이며 테넌트가 정할 값이 아니다(§13-3) · **동의 컨텍스트 조립이 던져도 통화를 끊지 않고 '없음'으로 취급한다**(pii 선언이면 실행기가 막고, 선언이 없으면 동의가 필요 없었으므로 진행한다 — 판정은 §10.1 한 곳에만 둔다) · `missingConnectors` 로 **통화 시작 전에** 오타·미배포를 잡는다. 게이트·재시도·마스킹을 여기서 복사하지 않는다(판정은 실행기 한 곳, §2). 네트워크에 직접 닿지 않는다 | `pumpConnectorHop`, `missingConnectors`, `connectorHopLimit`, `apiNodeIds`, `hopLimitInput`, `defaultIdempotencyKey`, `ConnectorPumpBinding`, `ConnectorRegistry`, `PumpHopResult`, `PumpBlock`, `CONNECTOR_PUMP_CONTRACT_VERSION` |
| `integration/httpConnector.ts` | `ConnectorPort` **HTTP 실구현**(저장소 전체에 구현이 0건이었다 — 계약은 있는데 아무도 지나가 본 적 없는 길). 막는 사고는 예외가 아니라 조용한 유출·조용한 오답이다: **개인정보를 쿼리스트링으로 보내지 않는다**(GET URL 은 상대 업무시스템 접근 로그·프록시·APM 에 마스킹 없이 영구 보존된다 — 우리 쪽 §10.3 을 다 지켜도 새어 나간다) · pii 선언(`piiParamsOf`)을 **모르면 GET 자체를 거절한다**(안전한 쪽을 가정하지 않는다, §13-3) · 오류 응답 본문을 **읽지도 싣지도 않는다**(업무시스템 오류 응답에는 조회한 고객 정보가 되돌아온다) — `status` 만 적는다 · 200 으로 싸인 오류·배열·비 JSON 을 성공으로 읽지 않는다(`schema_mismatch`) · 멱등 키를 헤더로 전달한다(안 실으면 재시도가 곧 중복 처리) · `timeoutMs` 미유효는 호출 전 거절(무한 대기는 콜을 붙잡아 둔다, §9.3). 엔드포인트 원문·자격증명은 Core 에 두지 않고 `resolveEndpoint`·`resolveSecret` 이 푼다(§6.1 규약 1) — `plan()` 의 인증 자리는 참조 이름으로 대체되고 파라미터는 **값 없이 이름만** 실린다. 시계 미주입 시 지연을 만들지 않고 응답 상한은 준 경우에만 검사한다(§13-3). **던지지 않는다** — 모든 실패는 `{ ok: false, code }` 다. 기본 `dry_run`, live 는 approvalRef + 전송 구현 필요 **[실호출은 승인]** | `createHttpConnectorPort`, `HttpConnectorPort`, `HttpConnectorConfig`, `ResolvedEndpoint`, `ConnectorRequestPlan`, `HTTP_CONNECTOR_CONTRACT_VERSION` |

### 채널 계약

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `channels/contract.ts` | 양방향 포트 정의 | `ConversationCorePort`, `ChannelPort`, `ChannelCapabilities`, `validateRegistration` |
| `channels/basePort.ts` | 계약을 지키는 포트 베이스. 전환 티켓은 `DeliveryEnvelope.ticket` 으로 **transport 까지 그대로** 간다(링크를 만들려면 토큰이 필요하다) — 대신 **기록에는 남기지 않는다**(토큰이 로그에 남으면 그 로그를 읽는 누구나 진행 중인 상담에 합류한다, §10.3). 티켓 유무 양쪽에서 동작한다(한쪽만 되는 구현은 배선을 켜거나 되돌리는 날 죽는다) | `createChannelPort`, `ChannelTransport`, `createChannelPortSet` |
| `channels/conformance.ts` | 저장소 CI용 적합성 스위트 13종 + 참조 드라이런 포트. `TURN_HINTS`·`CONNECTOR_WAIT` 는 **설정 변경만으로 전 통화가 깨지는** 구현을 미리 잡는다 — 특히 `CONNECTOR_WAIT` 는 Api 이행 배선을 켜면 **한 턴에 present 가 두 번 온다**(대기 안내 → 결과)는 사실을 검사한다. 한 턴 = present 한 번으로 가정한 포트(화면을 통째로 갈아 끼우거나 일회성 가드를 둔 구현)는 배선을 켜는 날 깨지고, 그것도 코드 배포가 아니라 설정 변경으로 깨진다. `CHANNEL_INVITE` 는 같은 이유로 전환 배선을 본다 — `invite` 에 **세 번째 인자(티켓)** 가 실려도 흡수하는지, 티켓을 변형하지 않는지, 능력 선언과 구현이 맞는지. **티켓이 실리면 링크는 `token` 으로 만든다**(interactionId 로 만들면 1회용·만료·회수가 전부 무의미하다) — 이건 포트 안에서 일어나는 일이라 검사할 수 없으므로 실패 문구에 못박아 두었다 | `runChannelConformance`, `formatConformanceReport`, `createDryRunPort` |
| `channels/bridge.ts` | 비-Node 호스트용 JSONL 소비 경로(줄 해석·검증·디스패치·노출 경계). 합류 토큰(`joinToken`)은 **들어오는 방향만** 통과시킨다 — 통과시키지 않으면 전환 배선을 켜는 순간 비-Node 호스트만 합류하지 못해 '특정 채널에서만 화면 전환이 안 된다'로 나타나고, 응답에 실으면 세션 열쇠가 로그로 흐른다(§10.3) | `createBridge`, `parseBridgeLine`, `encodeResponse`, `runBridgeLines`, `BRIDGE_PROTOCOL_VERSION`, `RATE_LIMITED_OPS`, `BridgeConfigError` |
| `channels/bridgeTranscript.ts` | 비-Node 클라이언트가 프로토콜을 지켰는지 기록으로 판정(세션 누수·요약/슬롯 유출·테넌트 주장·상관 어긋남) | `verifyBridgeTranscript`, `formatTranscriptReport`, `TRANSCRIPT_EXIT_CODE` |
| `channels/harness.ts` | 적합성 스위트를 CLI 로 돌리는 실행기 로직(설정 해석·포트/시나리오 해석·판정·출력) | `parseHarnessArgs`, `runHarness`, `resolvePortFromModule`, `resolveFlowsFromModule`, `formatHarnessResult`, `harnessResultToJson`, `safeReasonText`, `HARNESS_EXIT_CODE` |
| `channels/profiles.ts` | 채널 3종 능력 기본값 | `CHANNEL_PROFILES`, `profileFor` |
| `channels/runtime.ts` | Core 측 실구현 · **상담사 큐 배정 배선**: `routing` 을 주면 이관 시 `executeHandoff` 로 목적지를 확정하고, **큐에 놓을 수 있을 때만** `port.transfer` 를 부른다 — 대안·목적지 불가일 때 transfer 를 부르면 채널이 '상담사 연결 중'을 안내하고 고객은 아무도 없는 곳에서 기다린다(대신 `result.handoff.placement` 로 무엇을 해야 하는지 넘긴다, §9.3). 스냅샷 조회가 실패해도 **던지지 않는다**(빈 배열로 진행 → 보수적으로 닫힘). 깨진 라우팅 설정·다른 테넌트 설정·스냅샷 조회 부재는 **생성 시점에 거부**한다(통화 중 '갈 곳 없는 이관'으로 터지면 늦고, 통과시키면 오타 하나로 큐 판정이 조용히 꺼진 채 '적용했다'로 남는다). **§9.3 장애 폴백 큐는 라우팅 규칙으로 다시 고르지 않는다** — 폴백 경로가 라우팅 설정에 의존하면 설정이 깨졌을 때 폴백까지 같이 죽는다. `routing` 미지정 시 종전과 완전히 같다(§13-3) · **Api 노드 이행 배선**: `connectors` 를 주면 `integration/connectorPump.ts` 로 대기를 이행한다 — **대기 안내(`waitText`)를 호출 전에 present** 하고 나서 업무시스템을 부른다(조회가 끝난 뒤의 '잠시만 기다려 주세요'는 안내가 아니고, 그 사이는 통째로 무음이다) · 펌프가 이미 내보낸 단계를 다시 내보내지 않는다 · 같은 대기 건에 재진입해도 **두 번 부르지 않는다**(`connectorInFlight`) · 멱등 키 회차는 세션에 남아 이행 사이에 바뀌지 않는다 · 상한을 넘은 순환은 실패 입력 한 번 뒤 **세션을 실패로 끝내고 `port.end` 를 부른다**(고객을 무음에 두지 않는다) · 선언되지 않은 커넥터를 가리키는 시나리오는 **시작하지 않는다**(렌더 불가 노드와 같은 이유 — 통화 중간에 막히는 것이 더 나쁘다, §5.3) · `presetSlots` 는 이행 **전에** 병합된다(채널이 넘긴 슬롯이 커넥터 파라미터인 경우 앞서 부르면 필수 슬롯 누락으로 막힌다) · 과금 근거는 이행이 만든 봇 발화가 아니라 **고객 발화**에 붙는다(§11.2) · `connectors` 미지정 시 종전과 완전히 같다(§13-3) · **채널 전환 배선**: `channelSwitch` 를 주면 `core/executeSwitch.ts` 로 1회용·만료 티켓을 발급해 `port.invite(id, target, ticket)` 로 넘기고, **합류(`joinInteractionId`)에 그 토큰을 요구한다** — 미지정 시 합류는 id 하나로 통과하며(종전 동작, §13-3) 교차채널 초대가 가능한 채널이 등록돼 있으면 `W_CHANNEL_SWITCH_UNBOUND` 경고로 드러낸다. 전환 성립 여부(목적지 채널 등록·`reachable`)는 **§5.1 사다리 판정 전에** 본다 — 전환을 고른 뒤 발급이 막히면 `state.channel` 은 이미 화면인데 고객은 통화 중이라 화면용 단계를 듣게 된다. 발급이 막히면 **`invite` 를 부르지 않는다**(부르면 채널은 id 로 링크를 만들 수밖에 없다) · 합류는 테넌트뿐 아니라 **워크스페이스까지** 본다(§11.1 — 테넌트만 보면 같은 고객사의 다른 사업부가 진행 중인 상담에 합류한다) · 승계 슬롯은 세션에 이미 있는 값을 **덮어쓰지 않는다**(초대는 발급 시점 스냅샷이라 고객이 방금 정정한 값이 되돌아간다) | `createConversationCore`, `createMemoryFlowRegistry`, `createMemorySessionStore`, `RoutingBinding`, `ChannelSwitchBinding` |
### 이해·지식·라우팅

| 모듈 | 계약 | 주요 export |
|---|---|---|
| `nlu/intent.ts` | 의도 판정·되묻기·에스컬레이션 | `validateIntentCatalog`, `decideIntent`, `nextStep` |
| `nlu/intentRouting.ts` | `nextStep` 의 `{ step: 'proceed', intent }` 에서 **끊겨 있던 다음 한 걸음** — 확정된 인텐트를 시나리오 진입으로 옮긴다. 없으면 채널 3곳이 각자 `switch (intent)` 를 쓰고 갈라지는 방식은 정해져 있다: 모르는 인텐트를 대표 시나리오로 보내거나(라우팅 누락이 '봇이 못 알아듣더라'로만 남아 영영 안 보인다), `handoffOnly` 인텐트에 시나리오를 붙이거나(§2), 오탈자 flowId 를 통화 중에 만나거나(Runner 가 '정의되지 않은 노드'로 세션을 실패시킨다), 명확화 번호가 화면과 음성에서 어긋난다(고객이 고른 것과 다른 인텐트가 확정된다). 앞의 셋은 `validateIntentRouting` 이 **등록 시점에** 거절하고, 마지막은 `position` 을 판정 결과와 **같은 배열**에서 만들어 `resolveClarifyChoice` 와 어긋나지 않게 한다. 라우트가 없으면 **대표 시나리오로 보내지 않고** `unrouted` 로 미인식과 구분해 드러내며(§13-3), 라우트 없는 활성 인텐트는 경고+`unroutedIntents` 로 건수만 적는다(비율은 만들지 않는다). **판정하지 않는다** — 임계값·폴백 사다리를 여기서 다시 쓰면 §2 의 이중 관리가 인텐트 규칙에서 되풀이된다 | `validateIntentRouting`, `routeIntent`, `intentRoutingOk`, `unroutedIntents`, `IntentRoutingTable`, `IntentRoute`, `RouteAction`, `FlowLookup`, `INTENT_ROUTING_CONTRACT_VERSION` |
| `nlu/llmClassifier.ts` | `LlmAdapter`(§6.2) → `IntentCandidate[]`. **`decideIntent` 의 입력을 만드는 자리가 저장소 어디에도 없어** 채널 3곳이 각자 프롬프트·파서를 쓰게 되어 있던 공백을 메운다. **형식은 관용하고 값은 엄격하다**: ```json 펜스·앞뒤 산문·청크 분할은 흡수하되(`extractJsonBlock` 은 문자열 안의 괄호에 속지 않는다), 0..1 을 벗어난 `confidence` 는 **클램프하지 않고 후보 전체를 버린다**(95 를 1.0 으로 줄이면 어떤 `acceptThreshold` 든 무조건 통과한다) · 빠진 값을 채우지 않는다(§13-3) · 중복 인텐트는 병합 규칙을 코드에 두지 않고 거부한다 · 일부만 어긋나도 전체를 버린다(일부만 버리면 순위가 바뀐 채 확정된다). **판정하지 않는다** — 카탈로그에 없는 id 도 버리지 않고 `hallucinated` 로 드러내기만 한다(버리는 주체는 `decideIntent` 하나여야 §2 의 이중 관리가 재발하지 않는다). 발화는 `maskPii` 를 거쳐 프롬프트로 나가고 **응답 원문은 결과에 담지 않는다**(모델은 발화를 되풀이한다, §10.3) · 비활성 인텐트는 프롬프트에 싣지 않는다 · 해외 LLM 은 생성 시점에 거부(§10.3) · 지시문 기본값 없음, 타임아웃·응답 상한은 준 경우에만 적용(§13-3) · **`classify` 는 어떤 실패도 던지지 않는다**(분류 실패는 §5.1 재프롬프트로 처리할 일이지 통화를 끊을 일이 아니다) | `createIntentClassifier`, `parseCandidates`, `extractJsonBlock`, `OUTPUT_FORMAT_INSTRUCTION`, `ClassifyResult`, `IntentClassifier` |
| `knowledge/rag.ts` | 청킹·색인 준비·근거 판정. 근거 없으면 답하지 않는다 | `chunkText`, `prepareIngest`, `decideGrounding`, `formatCitations` |
| `knowledge/embedding.ts` | `EmbeddingAdapter`(§6.2) → 인제스트 벡터·질의 벡터. `prepareIngest` 와 `toVectorDocs` 사이의 **비어 있던 두 줄**을 메운다 — 그 두 줄에서 나는 사고는 전부 예외가 아니라 **조용한 오답**이다. 저장 전에 거르는 것: **개수 어긋남**(엔진이 빈 벡터를 끼워 개수를 맞춰 주면 길이는 같고 내용만 밀려서, 그 지식베이스는 이후 **다른 문서를 근거로 답한다**) · **차원 혼재**(모델 교체 후 재인덱싱 누락) · **NaN·Infinity·영벡터**(유사도가 무의미해지거나 분모가 0 이 된다 — 무작위 문서가 1 등으로 올라온다) · **빈 문자열 입력**(엔진마다 다르게 처리해 벡터가 밀리므로 부르기 전에 끊는다). **부분 성공을 돌려주지 않는다** — 절반만 인덱싱된 지식베이스는 장애로 보이지 않고 '그 항목만 검색이 안 된다'로 나타나 원인을 몇 주 뒤에 찾게 만든다. 실패는 `BatchFailure` 로 피해 범위(`from`·`to`)를 확정한다. `expectDim` 이 없어도 **이번 호출 안의 일관성은 언제나 검사**하며, 검사하지 못하는 범위(이미 저장된 벡터와의 일치)는 `dimUncheckedAgainstIndex` 로 드러낸다. 질의는 `maskPii` 경유(§10.3) · 해외 엔진은 생성 시점에 거부 · `batchSize`·`timeoutMs`·`expectDim` 기본값 없음(§13-3) · `usage` 는 실측 문자·건수만(토큰은 어댑터가 주지 않으므로 만들지 않는다, §11.2). **저장하지 않는다** — 판정과 부작용을 한 함수에 묶으면 실패했을 때 무엇이 남았는지 알 수 없다 | `createEmbedder`, `checkVector`, `Embedder`, `EmbedTextsResult`, `IngestResult`, `QueryVectorResult`, `BatchFailure` |
| `knowledge/retrieval.ts` | `embedQuery` → `TenantVectorStore.query` → `decideGrounding` 을 **순서대로 꿰는 자리**. 셋 다 있었는데 잇는 코드가 없어 채널 3곳이 같은 20줄을 각자 쓰게 되어 있던 공백을 메운다. 제일 비싼 실패를 코드로 막는다 — **스토어 장애를 '해당 내용이 없습니다'로 답하는 것**: 조회가 타임아웃 나면 히트가 0건이고 0건은 `no_hits` 라, 고객은 안내가 없다고 듣고 끊는데 **장애는 어디에도 집계되지 않는다**. 그래서 `store_failed` 와 `not_grounded` 를 **절대 섞지 않고**, 일부 지식베이스가 죽은 채 근거를 못 만든 경우도 `store_failed` 다(근거 없음으로 단정하지 않는다). 일부 실패에도 근거가 섰으면 답하되 `partial` 로 드러낸다. 스토어 topK 는 **정책의 topK 그대로**(어긋나면 설정 실수가 품질 문제로 오진된다) · 지식베이스는 **동시에** 조회(순차면 제한 시간이 개수만큼 곱해진다) · 지식베이스 간 중복 히트는 점수가 높은 쪽만 남긴다(안 그러면 같은 출처에 인용이 두 번 달린다) · 규약 위반 반환값을 빈 결과로 읽지 않는다 · 빈 질의·성립하지 않는 정책은 **엔진을 부르기 전에** 끊는다(§11.2) · `knowledgeBaseIds`·`storeTimeoutMs` 기본값 없음(빈 목록은 전체 검색이 아니라 설정 오류, §13-3) · **판정하지 않는다**(임계값·승인·만료는 `decideGrounding` 하나) · **던지는 것은 테넌트 격리 위반 하나뿐**(§11.1) | `createRetriever`, `dedupeHits`, `RetrieveResult`, `RetrieveStatus`, `Retriever`, `KnowledgeBaseFailure`, `RETRIEVAL_CONTRACT_VERSION` |
| `knowledge/answer.ts` | `Grounded` → LLM → **인용까지 검증된 답변**. `decideGrounding` 이 근거를 만들고 끝나던 자리의 다음 한 걸음이며, 여기서 막는 실패는 전부 예외가 아니라 **고객에게 그대로 나가는 그럴듯한 문장**이라 사후에 신고되지 않는다. **근거가 없으면 엔진을 부르지 않는다**(`GroundingDecision` 유니언을 그대로 받는 것이 안전장치다 — `grounded` 확인 없이 `context` 를 읽는 순간 이 시스템은 RAG 가 아니라 환각 생성기다, §5.2) · **근거 밖 인용 번호를 쓴 답변은 폐기한다**(죽은 각주는 근거 밖 내용을 덧붙였다는 신호다) · **인용이 하나도 없는 답변도 폐기한다**(자기 지식으로 답한 것이다) · 모델이 `sufficient:false` 로 답하면 그 **변명을 고객에게 읽어 주지 않는다**(폴백 문안은 테넌트가 정한다, §5.1·§13-3) · `sufficient` 가 불리언이 아니면 참으로 읽지 않는다 · **마스킹을 먼저 하고 그 결과에서 인용을 센다**(검증한 문장과 나가는 문장이 같아야 한다, §10.3) · 응답 원문은 결과에 담지 않고 길이만 남긴다(§11.2) · 해외 LLM 은 생성 시점에 거부(지식 원문이 통째로 나간다) · 지시문 기본값 없음, 타임아웃·응답 상한은 준 경우에만(§13-3) · **판정하지 않는다**(폴백 사다리는 `groundingFallback` 하나) · **어떤 실패도 던지지 않는다**(§9.3) | `createAnswerer`, `parseAnswer`, `extractMarkers`, `ANSWER_OUTPUT_FORMAT_INSTRUCTION`, `AnswerResult`, `AnswerStatus`, `Answerer`, `ANSWER_CONTRACT_VERSION` |
| `routing/agentQueue.ts` | 큐 선택·업무시간·대기 수용·배정 오퍼 | `validateRoutingConfig`, `isOpen`, `selectQueue`, `admitToQueue`, `offerAssignment` |
| `routing/executeHandoff.ts` | `selectQueue` → `admitToQueue` → **놓을 수 있는 큐 하나**. 조각은 다 있었는데 **꿰는 코드가 없어** 저장소 전체에서 `selectQueue`·`admitToQueue` 를 부르는 곳이 테스트뿐이었다 — 실제 이관 경로는 시나리오에 적힌 큐 문자열을 그대로 `transfer` 에 넘겼으니 큐 선택도 수용 판정도 아무도 하지 않았다. 채널 3곳이 각자 쓰면 틀리는 방식은 정해져 있다: (1) **오버플로 목적지를 잘못 읽는다** — `AdmissionDecision` 은 `queueId`(요청 큐)와 `admittedQueueId`(실제 수용 큐)를 둘 다 들고 있고 이름이 짧은 쪽이 요청 큐다. `decision.queueId` 를 쓰면 고객이 **방금 꽉 찼다고 판정된 큐**에 들어가는데 타입도 값도 멀쩡해 어디서도 안 터진다(그래서 결과에는 놓을 수 있는 큐 id 가 `queueId` **하나뿐**이다) · (2) **수용 거부를 성공으로 읽는다** — `closed`·`rejected` 를 거르지 않으면 고객은 '상담사 연결' 안내를 듣고 아무도 없는 큐에서 기다리며 §9.3 대안이 통째로 건너뛰어진다(대안 결과는 놓을 큐 id 를 아예 들고 있지 않다) · (3) **워크스페이스 격리가 비어 있다** — `selectQueue` 는 `tenantId` 만 본다(§11.1) · (4) **요약을 한 번 더 마스킹한다** — `maskPii` 는 **멱등이 아니라** 재적용하면 이미 마스킹된 값이 뭉개진다(`900101-*******` → `***-****-0101-*******`), 그래서 받은 요약은 그대로 통과시키고 이 모듈이 만든 문구만 한 번 마스킹한다 · (5) **소진 이후가 다른 모양으로 끝난다**(`placementAfterExhausted` 로 큐 닫힘과 같은 `AlternativePlacement` 에 수렴) · (6) **시간대 없는 시각** — `Date.parse('2026-03-02T10:00:00')` 는 성공하고 호스트 로컬로 해석되어 영업시간 판정이 서버마다 갈린다(오프셋이 명시된 ISO-8601 만 받는다) · (7) **같은 큐의 스냅샷이 둘 오면 배열 순서가 수용 판정을 정한다**(값이 어긋나면 골라 주지 않고 그 큐를 상태 미확인으로 둔다). 대안 행동은 큐 선언값을 그대로 쓰고 기본값을 만들지 않는다(§13-3) · 큐 상태를 엔진·백엔드 장애로 집계하지 않는다(영업시간 외를 `down` 으로 적으면 매일 밤 전 채널이 폴백으로 떨어진다, §9.3) · **던지는 것은 격리 위반 하나뿐**(§11.1) | `executeHandoff`, `placementAfterExhausted`, `isQueued`, `HandoffPlacement`, `QueuedPlacement`, `AlternativePlacement`, `UnavailablePlacement`, `HandoffRequest`, `HANDOFF_EXECUTION_CONTRACT_VERSION` |

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
| `ops/fallback.ts` | 컴포넌트 건강도 → 폴백 모드(§9.3) | `createHealthRegistry`, `decideFallbackMode`, `resolveRuntimeAction`, `effectiveComponentState` |
| `ops/recoveryProbe.ts` | **폴백에서 빠져나오는 길**(§9.3). 폴백이 걸리면 엔진 호출이 멈추므로 새 샘플이 생기지 않는다 — 보수적 테넌트는 사람이 손대기 전까지 영구히 상담사 직결이고, 아닌 테넌트는 **증거 없이** 샘플이 낡았다는 이유만으로 AI 를 재개한다. 그래서 **지금 나쁜 상태인 컴포넌트만** 주입된 `HealthProbe` 로 다시 확인해 같은 레지스트리에 샘플을 남긴다(폴백 모드 판정은 여전히 `decideFallbackMode` 가 한다). **타이머를 스스로 돌리지 않는다** — 호스트가 `runDue(nowIso)` 를 부른다. 확인 간격·제한 시간 **기본값 없음**(§13-3, 주지 않으면 그 컴포넌트는 돌리지 않고 건너뛴 사유를 적는다). 정상인 컴포넌트는 찌르지 않고(합성 요청은 비용이자 §11.2 의 정체불명 사용량이다), 승인 전 호출·설정 오류·정체불명 예외는 **엔진 상태로 적지 않는다**(적으면 켜 보기도 전에 영구 `down` 이다 **[승인 필요]**). 프로브가 규약을 어긴 값을 돌려주면 `up` 으로도 `down` 으로도 읽지 않는다(프로브 결함이지 엔진 증거가 아니다). 프로브는 동시에 돌고, 어떤 경우에도 던지지 않는다. `confirmSuccesses` 를 주면 연속 성공이 확인될 때까지 복구를 기록하지 않는다 | `createRecoveryProbeRunner`, `formatRecoveryReport`, `RecoveryProbeOptions`, `ProbeSchedule`, `RecoveryRunReport` |
| `ops/health.ts` | liveness/readiness 분리, 프로브 병렬·개별 예산 | `checkHealth`, `livenessReport`, `approvalPendingProbe` |
| `ops/backup.ts` | 백업·복구와 **복구 리허설**(RUNBOOK.md 참조) | `createSnapshot`, `verifySnapshot`, `serializeSnapshot`, `parseSnapshot`, `restoreSnapshot`, `runRecoveryDrill` |
| `ops/packageSurface.ts` | 채널이 부르는 import 경로(package.json exports) 고정·검증. 배포는 **[승인 필요]** | `CHANNEL_SUBPATHS`, `expectedExports`, `validatePackageSurface`, `surfaceOk`, `formatSurfaceReport` |
| `ops/clientDrift.ts` | 파이썬 참조 클라이언트 복사본(Callbot `voice-agent/aicc/`) 드리프트 판정. 줄끝 차이는 경고, 내용 차이·누락은 실패, 대상을 못 읽으면 판정보류(§13-3). 실행기 `scripts/client-drift.mjs` | `compareClientCopies`, `parseDriftArgs`, `formatDriftReport`, `DRIFT_USAGE_KO` |
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
