// 언어 중립 채널 브리지 — 설계서 §1.2(Core 단일화)·§5.3(하나의 Flow)·§6.2(엔진 비종속)·
// §8.1(이벤트)·§9.3(장애 폴백)·§10.3(마스킹)·§11.1(테넌트 격리)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// 채널 계약(contract.ts)·베이스 포트(basePort.ts)·적합성 실행기(harness.ts)는 모두 **Node 호스트**를
// 전제한다. 챗봇·D-ARS 는 그래서 그대로 붙었다. 그런데 Callbot 저장소는 Node 프로젝트가 아니다 —
// 음성 에이전트는 파이썬 프로세스(agent.py)로 돌아간다. 지금 상태로는 Callbot 이 Core 를 소비할
// 방법이 아예 없고, 그러면 "Core 단일화"는 세 채널 중 두 채널에서만 참인 말이 된다.
// 음성은 가장 먼저 갈라지는 채널이라(DTMF·무음·재발화) 여기서 갈라지면 §2 의 시나리오 이중 관리가
// 그대로 재발한다.
//
// 그래서 Core 소비 경로를 언어에 묶이지 않는 것 하나 더 연다: **한 줄 = 한 요청(JSONL)**.
// 호스트는 표준입력으로 요청 한 줄을 쓰고 표준출력으로 응답 한 줄을 읽는다. 파이썬·자바·Go 어디서든
// 30줄이면 붙고, Core 내부 타입을 알 필요가 없다.
//
// 이 파일은 **프로토콜의 순수 로직**만 담는다(줄 해석·검증·디스패치·응답 생성).
// 표준입출력·프로세스 종료 같은 부작용은 scripts/channel-bridge.mjs 가 맡는다.
//
// 설계 결정 네 가지 (전부 "빠지면 사고가 나는" 지점이다):
//  1) **테넌트는 호스트가 주장하지 않는다.** scope 는 브리지 설정에서 강제 주입한다. 외부 프로세스가
//     스스로 테넌트를 밝히게 두면 §11.1 격리가 프로토콜 한 줄로 무너진다. 요청이 다른 scope 를
//     주장하면 조용히 덮어쓰지 않고 거부한다 — 덮어쓰면 호스트는 자기가 무엇을 열었는지 모른다.
//  2) **어댑터도 고정이다.** 브리지 하나가 채널 하나다. 한 프로세스가 세 채널을 흉내 내면
//     능력 선언(§5.3 사전검증)이 무의미해진다.
//  3) **슬롯 원문·이관 요약·전환 토큰은 기본적으로 나가지 않는다.** 슬롯은 키 목록만, 상담사용
//     요약은 `includeHandoffSummary`, §5.2 전환 토큰은 `includeSwitchTicket` 를 켠 소비자에게만
//     준다(§2·§10.3). 고객 노출 경로가 이 값을 받으면 언젠가 화면에 뜨고, 전환 토큰은 그 자체로
//     진행 중인 상담의 열쇠다. **사실은 언제나 나간다** — 감추면 호스트는 전환이 일어난 것도,
//     링크를 보낼 수 없는 상태인 것도 알 수 없다.
//  4) **어떤 잘못된 줄도 프로세스를 죽이지 않는다.** 빈 줄·깨진 JSON·모르는 op 는 오류 응답이지
//     예외가 아니다. 회선 하나가 이상한 바이트를 보냈다고 통화 전체가 끊기면 안 된다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 여기에는 회선·소켓·프로토콜 코드가 없다. 매체 동작은 ChannelPort 구현이 맡는다.
//  - 기본 `dry_run` 이다. `live` 는 승인 근거(approvalRef)가 있어야만 만들어진다 — [승인 필요].
//  - 상한·예산 기본값을 만들어 넣지 않는다(§13-3). 주지 않으면 그 검사를 건너뛴다.
import { maskPii } from '../core/policyGuard.ts';
import { stripSecrets } from '../obs/errorMonitor.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { FlowInput } from '../flow/runner.ts';
import type { EntryPoint, LatencyMs, UsageMetrics } from '../events/schema.ts';
import { ENTRY_POINTS, LATENCY_KEYS, USAGE_METRIC_KEYS } from '../events/schema.ts';
import type { HealthSample, ComponentId } from '../ops/fallback.ts';
import { isHealthState } from '../ops/fallback.ts';
import type { ClosedAction } from '../routing/agentQueue.ts';
import type {
  AlternativeCause, HandoffPlacement, HandoffUnavailableCode,
} from '../routing/executeHandoff.ts';
import type {
  BridgeOp, ChannelAdapterId, ChannelCapabilities, ChannelSessionRequest, ChannelTurnInput,
  ChannelTurnResult, ContractIssue, ConversationCorePort,
} from './contract.ts';
import { BRIDGE_MAINTENANCE_OPS, BRIDGE_OPS, CHANNEL_CONTRACT_VERSION } from './contract.ts';
import type { AgentOfferStep, OfferExpiryReport, ReadinessRequest } from './runtime.ts';
import type { OfferEvent } from '../routing/agentQueue.ts';
import { OFFER_EVENTS } from '../routing/agentQueue.ts';
import type { RecoveryRunReport } from '../ops/recoveryProbe.ts';
import type { CoreReadinessReport } from '../ops/executeHealth.ts';
import { profileFor } from './profiles.ts';
import type { ChannelActivation } from './basePort.ts';
import type { RateLimiter } from '../api/rateLimit.ts';
import { rateLimitKey } from '../api/rateLimit.ts';
import type { BridgeStage, ObservabilityBinding, ObserverStats } from '../obs/executeObservability.ts';
import { createObserver } from '../obs/executeObservability.ts';

/** 프로토콜 버전. 호스트는 hello 응답에서 이 값을 보고 자기 구현과 맞는지 판단한다. */
export const BRIDGE_PROTOCOL_VERSION = 1;

// op 목록은 채널 계약(`contract.ts`) 하나다 — 전사 판정기·관측 분류기도 같은 목록을 본다.
export type { BridgeOp } from './contract.ts';
const BRIDGE_OP_SET: ReadonlySet<string> = new Set<string>(BRIDGE_OPS);

export type BridgeErrorCode =
  | 'E_BAD_JSON'       // 줄이 JSON 이 아니다
  | 'E_TOO_LARGE'      // 줄이 상한을 넘었다(상한을 준 경우에만)
  | 'E_BAD_REQUEST'    // 형태·필수값 위반
  | 'E_UNKNOWN_OP'     // 모르는 op
  | 'E_TENANT_SCOPE'   // 호스트가 다른 테넌트를 주장했다(§11.1)
  | 'E_RATE_LIMITED'   // 한도 초과 — 재시도 가능 시각을 함께 준다(§9.3·§11.2)
  /**
   * 그 유지 루프가 **배선되지 않았다**(§13-3). 빈 보고서를 돌려주지 않는 이유와 같다 —
   * `{"expired":0}` 은 "만료 0건"으로 읽히고, 그 호스트는 수렴이 **한 번도 돈 적 없다는 사실**을
   * 모른 채 운영한다. 배선 없음은 실패로 적는다.
   */
  | 'E_NOT_WIRED'
  | 'E_INTERNAL';      // Core 실행 중 예외 — 원문·스택을 노출하지 않는다

export interface BridgeError {
  code: BridgeErrorCode;
  messageKo: string;
  /** E_RATE_LIMITED 에서만. 계산된 실제 값이며 추정치가 아니다(§13-3). 호스트는 이 시간 전에 재시도하지 않는다. */
  retryAfterMs?: number;
}

/**
 * 한도 적용 대상 op. `hello`(버전 협상)와 `end`(세션 정리)는 **절대 막지 않는다** —
 * end 가 막히면 세션이 새고 요금으로 나타난다. 유지 루프(`BRIDGE_MAINTENANCE_OPS`)도
 * 막지 않는다(그 목록 주석 참조).
 */
export const RATE_LIMITED_OPS: ReadonlySet<BridgeOp> = new Set<BridgeOp>(['start', 'send', 'health']);

export interface BridgeResponse {
  /** 요청 id 그대로. id 를 읽지 못한 줄은 null 이다(호스트가 상관을 못 짓는 대신 무응답은 아니다). */
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
}

/**
 * 이관 목적지 판정(§9.3)의 전송용 투영.
 *
 * `placement !== 'queued'` 면 **큐에 사람이 들어가지 않았다**. 그때 호스트가 해야 하는 일은
 * `action`(콜백·음성사서함·기존 IVR)이며, 상담사 연결 안내를 해서는 안 된다 — 채널 계약
 * (`ChannelTurnResult.handoff.placement`)이 그렇게 적어 둔 값이다.
 *
 * 필드가 판정 종류마다 갈리므로 전부 옵셔널이다. **`summaryMasked` 는 어느 경우에도 여기에
 * 없다** — 상담사용 요약은 `handoff.summaryMasked` 한 곳에서 노출 스위치를 지난다(두 자리에
 * 두면 한쪽만 막은 날 약속이 무효가 된다, §2·§10.3). 있었는지는 `summaryPresent` 로 적는다.
 */
export interface BridgePlacementPayload {
  placement: HandoffPlacement['placement'];
  reasonKo: string;
  summaryPresent: boolean;
  warnings: string[];
  /** 규칙이 고른 큐(오버플로 이전). **여기에 사람을 놓지 않는다** — 집계·사후추적용이다. */
  requestedQueueId?: string;
  path?: string[];
  /** `placement === 'queued'` 에서만. **놓을 수 있는 큐 id 는 이것 하나뿐이다.** */
  queueId?: string;
  overflowed?: boolean;
  matchedRuleId?: string;
  cause?: AlternativeCause;
  /** `placement === 'alternative'` 에서만. 큐 설정에 선언된 대안이며 Core 가 만들지 않는다(§13-3). */
  action?: ClosedAction;
  /** `placement === 'unavailable'` 에서만. 전부 설정 결함이다. */
  code?: HandoffUnavailableCode;
  issues?: string[];
}

/**
 * §5.2 전환 초대의 전송용 투영.
 *
 * **이것이 비-Node 호스트에 전환이 도착하는 유일한 경로다.** Node 호스트는 `port.invite` 로
 * 같은 지시를 받지만 파이썬·자바 호스트에는 그 자리가 없어, 이 값이 없던 동안 전환은
 * **조용히 반쪽만** 일어났다: `state.channel` 은 화면으로 바뀌어 이후 단계가 화면용으로
 * 렌더되는데(통화 중인 고객이 그것을 듣는다) 링크는 아무도 보내지 않는다. 고객은 오지 않는
 * 화면을 기다리고 — §5.1 사다리는 이미 전환을 골랐으므로 상담사로 내려가지도 않는다.
 *
 * `token` 은 `includeSwitchTicket` 를 켠 소비자에게만 실린다(§10.3). 나머지 필드에는
 * 개인정보도 열쇠도 없다 — 감추면 호스트는 "링크를 보낼 차례"와 "보낼 수 없는 상태"를
 * 구분할 수 없다.
 */
export interface BridgeSwitchInvitePayload {
  fromChannel: string;
  toChannel: string;
  ticketIssued: boolean;
  /** 토큰을 실제로 실었는가. `ticketIssued` 와 **다른 질문**이다(노출 스위치가 끄면 false). */
  tokenIncluded: boolean;
  expiresAt?: string;
  tokenless?: boolean;
  notIssuedKo?: string;
  token?: string;
}

/** 호스트에게 돌려주는 턴 결과의 **전송용 투영**. Core 내부 타입을 그대로 흘리지 않는다. */
export interface BridgeTurnPayload {
  interactionId: string;
  status: string;
  steps: unknown[];
  state: {
    flowId: string;
    flowVersion: number;
    channel: string;
    currentNodeId: string | null;
    status: string;
    turnCount: number;
    failCount: number;
    /** 값이 아니라 **키만** 나간다. 값이 필요하면 includeSlots 를 켠다(§10.3). */
    slotKeys: string[];
    slots?: Record<string, string>;
    /**
     * Api 대기 중인 커넥터 id(§6.1). 값이 있으면 Core 는 **호스트의 조회 결과를 기다리는
     * 상태**이고, 보내야 하는 다음 입력은 발화가 아니라 `{"kind":"connectorResult",...}` 다.
     *
     * 이 값이 없던 동안 비-Node 호스트에는 그 사실을 알 길이 없었다: 대기 중에 발화를 보내면
     * `steps` 0건·`events` 0건이 돌아오고(§6.1 구간) 오류도 아니라서, 통화는 끊기지도 않은 채
     * 멈추고 **어떤 알림도 울리지 않는다**. 커넥터 이행이 배선된 테넌트에서는 Core 가 스스로
     * 불러 이 값이 서지 않으므로, 서 있다는 것 자체가 "호스트가 부를 차례"라는 뜻이다.
     */
    pendingConnectorId?: string;
  };
  events: unknown[];
  fallback?: unknown;
  handoff?: {
    queue?: string;
    summaryAvailable: boolean;
    summaryMasked?: string;
    /**
     * 큐 배정 판정(§9.3). Core 에 라우팅이 배선된 경우에만 실린다.
     *
     * 이 값이 없던 동안 비-Node 호스트는 **큐에 들어가지 못한 고객에게도 "상담사를 연결해
     * 드리겠습니다"를 안내**했다. `queue` 만 보면 구분이 안 되기 때문이다 — 대안으로 간 건은
     * 놓을 큐 id 를 아예 들고 있지 않아 `queue` 가 비고, 그 상태는 "큐를 선언하지 않은 이관"과
     * 같은 모양이다. 음성이 바로 그 대안(콜백·음성사서함)이 선언되는 채널이다.
     */
    placement?: BridgePlacementPayload;
  };
  /** §5.2 전환 초대(`BridgeSwitchInvitePayload` 주석). 전환이 없던 턴에는 실리지 않는다. */
  switchInvite?: BridgeSwitchInvitePayload;
  /**
   * 이번 턴에 AI 고지를 냈다는 사실(§10.1). 문구는 `steps` 맨 앞 단계에 실려 있으므로 여기서
   * 되풀이하지 않고 **감사 근거**(어느 매체에 어떤 버전으로)만 내보낸다 — 호스트가 steps 를
   * 뒤져 찾아내게 두면 언어마다 각자 다르게 찾는다(§2).
   */
  disclosure?: { channel: string; placement: string; configVersion: number };
  /**
   * §11.2 과금 근거가 어디까지 실렸는가. 어떤 노출 스위치와도 무관하게 나간다 — 여기에는
   * 개인정보가 없고(수치와 Core 가 쓴 사유 문구뿐), 감추면 호스트는 자기 통화의 엔진 비용·통화
   * 시간이 집계에 **없다는 사실**을 알 길이 없다. 파이썬·자바 호스트도 이 값을 보고 자기 쪽
   * 과금 기록을 남길 수 있어야 한다.
   */
  billing?: unknown;
  /**
   * §10.1 동의. 과금 근거와 **같은 이유로** 어떤 노출 스위치와도 무관하게 나간다 — 여기에는
   * 개인정보가 없고(목적 코드·상태·정책 버전·Core 가 쓴 사유뿐 — 동의 주체 참조는 **싣지 않는다**),
   * 감추면 비-Node 호스트는 "이 통화에서 동의를 받았다"를 증명할 길도, **필수 동의가 아직
   * 미획득이어서 개인정보 조회가 막힌다**는 사실을 알 길도 없다. 음성 채널(녹취·개인정보 수집)이
   * 바로 그 사실을 가장 먼저 알아야 하는 곳이다.
   */
  consent?: unknown;
  /**
   * §7 5.2 준수 점검 요약. 세션이 끝난 응답에만 실린다.
   *
   * 고지·동의와 **같은 이유로** 어떤 노출 스위치와도 무관하게 나간다 — 여기에는 개인정보가 없고
   * (규칙 id·심각도별 건수·Core 가 쓴 사유뿐. 근거 이벤트 id·검출 표현·금칙어 문구는 애초에
   * 요약에 담기지 않는다), 감추면 비-Node 호스트는 자기 통화가 **점검됐는지조차** 알 길이 없다.
   * 음성 채널이 바로 고지 누락·녹취 중 마스킹 누락이 가장 먼저 나타나는 곳이다.
   *
   * `reviewed: false` 를 "위반 없음"으로 읽지 않도록 사유(`reasonKo`)를 함께 내보낸다.
   */
  compliance?: unknown;
}

/** 처리 기록. 발화 원문·개인정보를 담지 않는다 — op·판정·마스킹된 사유만 남는다(§10.3). */
export interface BridgeRecord {
  id: string | null;
  op: BridgeOp | null;
  ok: boolean;
  errorCode?: BridgeErrorCode;
  /** 실측 소요(ms). clock 을 주입한 경우에만 채운다 — 만들어 넣지 않는다(§13-3). */
  durationMs?: number;
}

export interface BridgeOptions {
  /** Core 측 실구현(runtime.ts 의 createConversationCore 결과 등). */
  core: ConversationCorePort;
  /** 이 브리지가 대변하는 채널. 요청이 다른 어댑터를 주장하면 거부한다. */
  adapter: ChannelAdapterId;
  /** 강제 주입할 테넌트 스코프(§11.1). 호스트가 바꿀 수 없다. */
  scope: TenantScope;
  capabilities?: ChannelCapabilities;
  /** 기본 dry_run. live 는 approvalRef 가 있어야만 만들어진다 — [승인 필요]. */
  activation?: ChannelActivation;
  approvalRef?: string;
  /** 상담사용 요약을 응답에 실을지. 기본 false(고객 노출 경로 보호, §2·§10.3). */
  includeHandoffSummary?: boolean;
  /** 슬롯 값을 응답에 실을지. 기본 false — 키 목록만 나간다. */
  includeSlots?: boolean;
  /**
   * §5.2 전환 초대의 **1회용 토큰**을 응답에 실을지. 기본 false(상담사용 요약과 같은 규칙,
   * §2·§10.3) — 전환 **사실**(목적지·발급 여부·만료·사유)은 스위치와 무관하게 언제나 나간다.
   *
   * 켜야 하는 경우: 링크(SMS·알림톡·푸시)를 **이 호스트가 직접 만들어 보낸다**. 그때 토큰이
   * 없으면 호스트는 Interaction id 로 링크를 만들 수밖에 없고, 그 순간 1회용·만료·회수가
   * 전부 무의미해진다(`core/executeSwitch.ts` 가 막겠다고 적어 둔 바로 그 사고다).
   * 끄는 쪽이 기본인 이유: 이 토큰은 진행 중인 상담의 열쇠이고, 응답 줄은 호스트 로그에
   * 그대로 남는 경우가 많다.
   */
  includeSwitchTicket?: boolean;
  /** 한 줄 바이트 상한. 미지정 시 상한 검사를 하지 않는다(§13-3). */
  maxLineBytes?: number;
  /** 실측 소요 계산용 시계(ms). 미주입 시 durationMs 를 기록하지 않는다. */
  clock?: () => number;
  onRecord?: (r: BridgeRecord) => void;
  /** 보관 기록 상한. 장시간 통화에서 메모리가 무한히 늘지 않게 한다. */
  maxRecords?: number;
  /**
   * 요청 제한(§9.3·§11.2). 주지 않으면 제한하지 않는다 — 한도 기본값을 코드에 두지 않는다(§13-3).
   * 키는 테넌트 스코프 + op 로 고정되어 호스트가 바꿀 수 없다(§11.1). 폭주는 악의보다 사고로 온다 —
   * 호스트의 재시도 루프·잘못 설정된 헬스 샘플 주기가 Core 와 엔진 과금을 함께 끌어내리는 것을 여기서 막는다.
   */
  rateLimiter?: RateLimiter;
  /** op 별 비용. 주지 않으면 전부 1. `send` 는 엔진 호출을 동반하므로 무겁게 셀 수 있다. */
  rateLimitCost?: Partial<Record<BridgeOp, number>>;
  /**
   * 관측(§13·§10.3). **주지 않으면 종전과 완전히 같다**(§13-3) — 경계 실패는 `records`·
   * `onRecord` 에만 남고, 그것은 **이 프로세스 안에서만** 보인다.
   *
   * 이 배선이 없는 동안 브리지 경계의 실패는 수집기·로그에 **한 건도 닿지 않았다**:
   * 깨진 JSONL 줄·모르는 op·다른 테넌트 주장·요청 한도 초과는 Core 를 부르기 **전에**
   * 응답 줄로 끝나기 때문이다. 호스트의 직렬화 버그로 모든 줄이 깨져도 Core 로그는 조용하고,
   * 증상은 "그 채널만 통화가 안 된다"인데 로그에는 그 통화가 아예 없다.
   *
   * 무엇을 싣고 무엇을 싣지 않을지는 `obs/executeObservability.ts` 가 정한다 —
   * **줄 원문은 어떤 경로로도 나가지 않는다**(깨진 줄에 발신번호가 들어 있을 수 있다).
   * 런타임(`channels/runtime.ts`)의 `observability` 와 **같은 배선 객체를 주면 된다**:
   * 관측기는 둘이지만 로거·수집기가 하나라 중복 억제·창 상한이 같은 기준으로 돈다.
   */
  observability?: ObservabilityBinding;
  /**
   * 유지 루프 배선(§9.3·§2). **주지 않으면 그 op 는 `E_NOT_WIRED` 로 거절된다** —
   * 빈 보고서를 돌려주면 호스트는 "0건"으로 읽고, 수렴이 한 번도 돈 적 없다는 사실을 모른다.
   *
   * 왜 자리가 필요한가: `ConversationCore` 의 유지 메서드(`runOfferExpiry`·`runRecoveryProbes`·
   * `readiness`·`settleAgentOffer`·`warnings`·`observability`)는 **Core 가 타이머를 돌리지
   * 않으므로** 호스트가 부른다. 그런데 비-Node 호스트가 Core 에 닿는 길은 이 브리지뿐이고
   * 브리지에는 그 자리가 없었다 — 즉 파이썬으로 Callbot 을 운영하는 배치에서는 **그 여섯 개를
   * 부를 방법이 아예 없었다**. 증상은 전부 조용하다: 만료된 오퍼가 열린 채 쌓여 같은 콜이 두 번 제안되고,
   * 한 번 `degraded_ai` 로 내려간 테넌트는 엔진이 돌아와도 **영구히** 폴백에 남고(아무도 찌르지
   * 않으므로 헬스 샘플이 갱신되지 않는다), `/health` 는 §9.3 상태 없이 초록이고, 상담사의
   * 수락·거절은 원장에 도착하지 않아 재배정도 소진 수렴도 일어나지 않는다.
   */
  maintenance?: BridgeMaintenanceBinding;
}

/**
 * 유지 루프의 **함수 인자**는 JSONL 을 건널 수 없다(프로브·시계·스케줄러). 그래서 Node 쪽
 * 배선이 준다 — 호스트가 줄마다 다시 선언하게 두면 같은 `/health` 가 호출마다 다른 기준으로
 * 판정되고(§2), 시각을 호스트가 주면 **틀린 시계 하나가 열린 오퍼를 전부 만료시킨다**.
 * 그래서 이 브리지의 유지 op 는 본문에서 판정 기준을 받지 않는다(`settleOffer` 의 상담사
 * 응답만 예외다 — 그것은 기준이 아니라 사실이다).
 */
export interface BridgeMaintenanceBinding {
  /**
   * `core.readiness(req)` 에 넘길 요청. 호스트 프로브·제한 시간·빌드 정보는 운영 합의값이라
   * Core 가 기본값을 만들지 않는다(§13-3) — 주지 않으면 `readiness` op 가 거절된다.
   */
  readiness?: ReadinessRequest;
  /**
   * `recoveryProbe`·`offerExpiry`·`settleOffer`·`warnings` 를 열지 여부. Core 쪽 배선이 없으면
   * 메서드가 `undefined` 를 돌려주므로 그때도 거절한다 — **켰다고 적힌 op 가 0건을 돌려주는
   * 상태를 만들지 않는다**. 기본값은 모두 닫힘이다(종전과 완전히 같다).
   */
  recoveryProbe?: boolean;
  offerExpiry?: boolean;
  settleOffer?: boolean;
  warnings?: boolean;
  /**
   * 관측 실측을 읽게 할지. **배선 객체를 Core 에 주지 않았으면 켜도 거절된다** —
   * `observability()` 가 `undefined` 를 돌려주고, 그것을 0 으로 적으면 "실패 0건·식별자
   * 제외 0건"이 되어 로거가 전부 던지고 있는 상태가 정상으로 읽힌다(§13-3).
   */
  observability?: boolean;
}

/**
 * 브리지가 부르는 유지 메서드. `ConversationCorePort` 에는 없고 `ConversationCore` 에만 있으므로
 * **선택**으로 받는다 — 포트만 주는 호스트(적합성 더미 등)는 종전과 완전히 같다.
 */
type MaintenanceCapableCore = ConversationCorePort & {
  warnings?(): ContractIssue[];
  readiness?(req: ReadinessRequest): Promise<CoreReadinessReport>;
  runRecoveryProbes?(nowIso?: string): Promise<RecoveryRunReport | undefined>;
  runOfferExpiry?(nowIso?: string): Promise<OfferExpiryReport | undefined>;
  settleAgentOffer?(p: { offerId: string; event: OfferEvent; nowIso?: string }): Promise<AgentOfferStep | undefined>;
  observability?(): ObserverStats | undefined;
};

/**
 * `settleOffer` 가 받는 사건. **목록을 다시 적지 않는다**(§2) — 상담사 응답의 전체 목록은
 * `routing/agentQueue.ts` 의 `OFFER_EVENTS` 하나이고, 여기서 하는 일은 그중 **이 op 가
 * 수행하지 않는 것**(`tick`)을 빼는 것뿐이다. 손으로 다시 적으면 사건이 하나 늘어난 날
 * Node 호스트는 올릴 수 있고 비-Node 호스트만 `E_BAD_REQUEST` 를 받는다.
 *
 * 왜 `tick` 을 빼는가: 만료는 **수렴의 수단**이라 건별로 받으면 만료 판정이 `offerExpiry`
 * 와 두 곳이 된다(§2). 그래서 거절 문구에도 `tick` 을 **허용값으로 적지 않는다** —
 * 종전에는 모르는 값에 대한 안내가 "허용값: … tick" 이었고, 그 안내를 그대로 따른 호스트는
 * 바로 다음 검사에서 또 거절당했다.
 */
const SETTLE_OFFER_EVENTS: readonly OfferEvent[] = OFFER_EVENTS.filter((e) => e !== 'tick');
const SETTLE_OFFER_EVENT_SET: ReadonlySet<string> = new Set<string>(SETTLE_OFFER_EVENTS);

/**
 * 와이어로 나갈 값의 복사. **JSON 왕복이 곧 경계다** — 호스트가 결과 객체를 손에 쥐고
 * `recovered.push(...)`·`issues.sort(...)` 로 Core 의 판정을 고치는 길을 막고(직렬화 전까지
 * 가능하다, 동의·점검·이관 투영과 같은 규칙), 직렬화할 수 없는 값이 섞였는지도 여기서 드러난다.
 */
function wireCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class BridgeConfigError extends Error {
  constructor(messageKo: string) {
    super(messageKo);
    this.name = 'BridgeConfigError';
  }
}

export interface Bridge {
  readonly protocolVersion: number;
  readonly activation: ChannelActivation;
  readonly records: readonly BridgeRecord[];
  /** 한 줄을 받아 한 응답을 돌려준다. 절대 던지지 않는다. 호출은 도착 순서대로 직렬 처리된다. */
  handleLine(line: string): Promise<BridgeResponse>;
  /**
   * 관측 실측. 배선이 없으면 `undefined` — **0 건으로 적지 않는다**(§13-3:
   * "거부 0건"과 "관측하지 않았다"는 다르다). `reset()` 은 이 수치를 되돌리지 않는다.
   */
  observability(): ObserverStats | undefined;
  /** 수집기에 남은 억제분 방출(프로세스 종료 직전). 배선이 없으면 0. */
  flushObservability(): number;
  reset(): void;
}

const DEFAULT_MAX_RECORDS = 500;

/** 응답 한 줄. 개행이 들어가면 프로토콜이 깨지므로 직렬화 결과에서 제거한다. */
export function encodeResponse(res: BridgeResponse): string {
  return JSON.stringify(res).replace(/[\r\n]+/g, ' ');
}

function safeText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return maskPii(stripSecrets(raw)).text;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** 스코프는 부분 일치로 넘기지 않는다 — 키 하나가 빠진 채 통과하면 격리가 반만 걸린다(§11.1). */
function sameScope(a: TenantScope, b: unknown): boolean {
  if (!isPlainObject(b)) return false;
  const mine = a as unknown as Record<string, unknown>;
  return Object.keys(mine).every((k) => b[k] === mine[k])
    && Object.keys(b).every((k) => mine[k] === b[k]);
}

/**
 * 숫자 맵(지연·사용량)은 **아는 키만** 유한·음이 아닌 값으로 통과시킨다.
 * 모르는 키를 그대로 흘리면 과금 집계(§11.2)에 정체불명 필드가 쌓인다 — 거부가 맞다.
 * 없는 값을 0으로 채우지 않는다(§13-3).
 */
function numberMap(v: unknown, allowed: ReadonlySet<string>): Record<string, number> | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) return 'invalid';
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!allowed.has(k)) return 'invalid';
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'invalid';
    out[k] = n;
  }
  return out;
}

// 허용 키·허용값은 **여기서 선언하지 않는다** — §8.1 타입 옆의 목록에서 파생시킨다.
// 손으로 적어 두었던 동안 이 세 줄은 타입과 어긋날 수 있는 세 곳이었고, 어긋남의 증상은
// 전부 "비-Node 호스트에서만 거부된다"였다(`LATENCY_KEYS`·`USAGE_METRIC_KEYS`·`ENTRY_POINTS` 주석).
const LATENCY_KEY_SET: ReadonlySet<string> = new Set<string>(LATENCY_KEYS);
const USAGE_KEY_SET: ReadonlySet<string> = new Set<string>(USAGE_METRIC_KEYS);
// 헬스 상태도 같은 규칙이다 — 목록은 `ops/fallback.ts` 하나이고 판정만 빌려 온다(§2).
// 손으로 적어 두었던 동안, 상태가 하나 늘면 Node 호스트는 그 샘플을 올릴 수 있고
// **비-Node 호스트만** `E_BAD_REQUEST` 를 받았다("그 채널만 헬스가 안 올라간다").

const ENTRY_POINT_SET: ReadonlySet<string> = new Set<string>(ENTRY_POINTS);

class RequestError extends Error {
  readonly code: BridgeErrorCode;
  readonly retryAfterMs?: number;
  constructor(code: BridgeErrorCode, messageKo: string, retryAfterMs?: number) {
    super(messageKo);
    this.name = 'RequestError';
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

function bad(messageKo: string): never {
  throw new RequestError('E_BAD_REQUEST', messageKo);
}

/** 줄 → 요청 객체. 실패는 예외가 아니라 오류 응답이 된다(호출부에서 잡는다). */
export function parseBridgeLine(line: string, maxLineBytes?: number): { id: string | null; op: BridgeOp; body: Record<string, unknown> } {
  if (typeof line !== 'string' || line.trim() === '') {
    throw new RequestError('E_BAD_REQUEST', '빈 줄입니다. 한 줄에 요청 하나를 보냅니다.');
  }
  if (maxLineBytes !== undefined && Buffer.byteLength(line, 'utf8') > maxLineBytes) {
    // 상한을 넘긴 줄은 파싱조차 하지 않는다 — 파싱 비용 자체가 공격 표면이다.
    throw new RequestError('E_TOO_LARGE', `요청 줄이 상한(${maxLineBytes} 바이트)을 넘었습니다.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // 원문을 되돌려주지 않는다. 깨진 줄에 발신번호가 들어 있을 수 있다(§10.3).
    throw new RequestError('E_BAD_JSON', 'JSON 으로 해석할 수 없는 줄입니다.');
  }
  if (!isPlainObject(parsed)) throw new RequestError('E_BAD_REQUEST', '요청은 JSON 객체여야 합니다.');
  const id = typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : null;
  const op = parsed.op;
  if (typeof op !== 'string' || !BRIDGE_OP_SET.has(op)) {
    const e = new RequestError('E_UNKNOWN_OP', `알 수 없는 op 입니다: ${typeof op === 'string' ? maskPii(op).text : typeof op}`);
    (e as RequestError & { id?: string | null }).id = id;
    throw e;
  }
  if (id === null) throw new RequestError('E_BAD_REQUEST', 'id 가 없습니다. 응답을 상관지을 수 없습니다.');
  return { id, op: op as BridgeOp, body: parsed };
}

function toSessionRequest(body: Record<string, unknown>, opts: BridgeOptions): ChannelSessionRequest {
  const req = isPlainObject(body.req) ? body.req : bad('start 에는 req 객체가 필요합니다.');
  if (req.adapter !== undefined && req.adapter !== opts.adapter) {
    bad(`이 브리지는 ${opts.adapter} 채널입니다. 다른 어댑터(${String(req.adapter)})를 대신 열 수 없습니다.`);
  }
  if (req.scope !== undefined && !sameScope(opts.scope, req.scope)) {
    // 조용히 덮어쓰지 않는다. 호스트는 자기가 어느 테넌트를 열었는지 알아야 한다(§11.1).
    throw new RequestError('E_TENANT_SCOPE', '요청이 브리지 설정과 다른 테넌트를 주장했습니다. 스코프는 호스트가 정하지 않습니다.');
  }
  if (!nonEmptyString(req.flowId)) bad('flowId 가 없습니다.');
  if (!nonEmptyString(req.entryPoint) || !ENTRY_POINT_SET.has(req.entryPoint)) {
    bad(`entryPoint 가 유효하지 않습니다: ${String(req.entryPoint)}`);
  }
  if (req.flowVersion !== undefined && (typeof req.flowVersion !== 'number' || !Number.isInteger(req.flowVersion) || req.flowVersion < 1)) {
    bad('flowVersion 은 1 이상의 정수여야 합니다.');
  }
  let presetSlots: Record<string, string> | undefined;
  if (req.presetSlots !== undefined) {
    if (!isPlainObject(req.presetSlots)) bad('presetSlots 는 문자열 맵이어야 합니다.');
    presetSlots = {};
    for (const [k, v] of Object.entries(req.presetSlots)) {
      if (typeof v !== 'string') bad(`presetSlots.${k} 가 문자열이 아닙니다.`);
      presetSlots[k] = v;
    }
  }
  const out: ChannelSessionRequest = {
    scope: opts.scope,
    adapter: opts.adapter,
    entryPoint: req.entryPoint as EntryPoint,
    flowId: req.flowId,
  };
  if (typeof req.flowVersion === 'number') out.flowVersion = req.flowVersion;
  if (presetSlots) out.presetSlots = presetSlots;
  if (nonEmptyString(req.joinInteractionId)) out.joinInteractionId = req.joinInteractionId;
  // 합류 자격 토큰(§5.2). 통과시키지 않으면 전환 배선을 켜는 순간 비-Node 호스트만 합류하지 못한다 —
  // 그 비대칭은 "특정 채널에서만 화면 전환이 안 된다"로 나타나 원인을 한참 뒤에 찾게 된다.
  // 토큰은 Core 가 발급해 채널에 준 값이다. **되돌려 적지 않는다** — 발급 시점의 응답
  // (`switchInvite.token`, 노출 스위치를 켠 경우)이 호스트가 토큰을 받는 유일한 자리이고,
  // 합류 요청에 실린 값을 응답에 되싣는 것은 로그에 열쇠를 한 번 더 남기는 일이다(§10.3).
  if (nonEmptyString(req.joinToken)) out.joinToken = req.joinToken;
  if (nonEmptyString(req.correlationId)) out.correlationId = req.correlationId;
  return out;
}

/**
 * 와이어로 받을 수 있는 입력 종류 — **`FlowInput` 을 전부 덮어야 한다**.
 *
 * 왜 목록을 두는가: 종전에는 아래 `switch` 가 네 종류만 알았고 `unrecognized` 는 "알 수 없는
 * 입력 종류"로 거절됐다(§5.1·§6.2). 분류는 Core 밖(엔진·호스트 NLU)에서 일어나므로 **미인식은
 * 호스트가 선언하는 사실**인데, 그 사실을 올릴 자리가 비-Node 호스트에는 없던 셈이다. 음성이
 * 바로 미인식이 가장 많은 채널이고(소음·고령 고객·재발화) 그 호스트가 파이썬이다.
 *
 * 남은 두 길이 전부 나쁘다. 거절을 받으면 그 턴은 Core 에 **아예 도착하지 않아** §5.1 사다리가
 * 돌지 않고, `utterance` 로 바꿔 보내면 더 조용하다 — `Collect` 노드는 비어 있지 않은 텍스트를
 * 무조건 수락하므로 "카드를 잃어버렸어요"가 **슬롯 값으로 저장된 채** 다음 노드로 넘어간다.
 * 예외도 재프롬프트도 없고 고객은 엉뚱한 안내를 듣는다(`FlowInput.unrecognized` 주석의 사고다).
 *
 * 목록을 컴파일 검사와 묶어 둔 이유: 입력 종류가 하나 늘어나는 날 이 자리만 모르면 같은 비대칭이
 * 되풀이된다(Node 호스트는 보낼 수 있고 와이어만 거절한다).
 */
const WIRE_INPUT_KINDS = ['utterance', 'dtmf', 'timeout', 'connectorResult', 'unrecognized'] as const;

/** 빠뜨린 종류가 있으면 이 대입이 컴파일 오류가 된다. */
const _wireInputKindsCover: Exclude<FlowInput['kind'], typeof WIRE_INPUT_KINDS[number]> extends never
  ? true : never = true;
void _wireInputKindsCover;

function toFlowInput(v: unknown): FlowInput {
  if (!isPlainObject(v)) bad('turn.input 이 없습니다.');
  const kind = v.kind;
  switch (kind) {
    case 'utterance': {
      if (typeof v.text !== 'string') bad('utterance 입력에는 text(문자열)가 필요합니다.');
      const input: FlowInput = { kind: 'utterance', text: v.text };
      if (v.confidence !== undefined) {
        if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
          bad('confidence 는 0~1 사이 숫자여야 합니다.');
        }
        input.confidence = v.confidence;
      }
      return input;
    }
    case 'unrecognized': {
      // **빈 문자열을 거절하지 않는다**: 인식기가 아무 말도 못 돌려준 것(no-match)이 바로 이
      // 입력의 가장 흔한 경우다. 거절하면 호스트는 그 턴을 `timeout` 으로 바꿔 보내게 되고
      // (무입력과 미인식은 §5.1 사다리에서 다른 단계다) 그러면 고객은 말을 했는데 침묵으로
      // 집계된다. `confidence` 는 받지 않는다 — 이 종류에는 실을 자리가 없고(§13-3),
      // 턴 단위로 선언하면 런타임이 `W_TURN_INPUT` 으로 사실을 적는다.
      if (typeof v.text !== 'string') bad('unrecognized 입력에는 text(문자열)가 필요합니다.');
      return { kind: 'unrecognized', text: v.text };
    }
    case 'dtmf': {
      if (typeof v.digits !== 'string') bad('dtmf 입력에는 digits(문자열)가 필요합니다.');
      // 회선에서 오는 값이므로 형태를 여기서 막는다. 숫자·*·# 외에는 받지 않는다.
      if (v.digits !== '' && !/^[0-9*#]+$/.test(v.digits)) bad('digits 에 허용되지 않는 문자가 있습니다.');
      return { kind: 'dtmf', digits: v.digits };
    }
    case 'timeout':
      return { kind: 'timeout' };
    case 'connectorResult': {
      // ok 는 명시해야 한다. 빠진 값을 성공으로 읽으면 실패한 조회가 성공으로 흘러간다.
      if (typeof v.ok !== 'boolean') bad('connectorResult 에는 ok(boolean)가 필요합니다.');
      const input: FlowInput = { kind: 'connectorResult', ok: v.ok };
      if (v.slots !== undefined) {
        if (!isPlainObject(v.slots)) bad('connectorResult.slots 는 문자열 맵이어야 합니다.');
        const slots: Record<string, string> = {};
        for (const [k, sv] of Object.entries(v.slots)) {
          if (typeof sv !== 'string') bad(`connectorResult.slots.${k} 가 문자열이 아닙니다.`);
          slots[k] = sv;
        }
        input.slots = slots;
      }
      if (v.errorCode !== undefined) {
        if (typeof v.errorCode !== 'string') bad('connectorResult.errorCode 는 문자열이어야 합니다.');
        input.errorCode = v.errorCode;
      }
      return input;
    }
    default:
      return bad(`알 수 없는 입력 종류입니다: ${typeof kind === 'string' ? maskPii(kind).text : typeof kind}`);
  }
}

function toTurnInput(body: Record<string, unknown>): ChannelTurnInput {
  const turn = isPlainObject(body.turn) ? body.turn : bad('send 에는 turn 객체가 필요합니다.');
  const out: ChannelTurnInput = { input: toFlowInput(turn.input) };
  const latency = numberMap(turn.latency, LATENCY_KEY_SET);
  if (latency === 'invalid') bad('latency 는 알려진 키의 음이 아닌 유한 숫자여야 합니다.');
  if (latency) out.latency = latency as LatencyMs;
  const usage = numberMap(turn.usage, USAGE_KEY_SET);
  if (usage === 'invalid') bad('usage 는 알려진 키의 음이 아닌 유한 숫자여야 합니다(§11.2).');
  if (usage) out.usage = usage as UsageMetrics;
  if (turn.confidence !== undefined) {
    if (typeof turn.confidence !== 'number' || !Number.isFinite(turn.confidence) || turn.confidence < 0 || turn.confidence > 1) {
      bad('confidence 는 0~1 사이 숫자여야 합니다.');
    }
    out.confidence = turn.confidence;
  }
  return out;
}

function toHealthSamples(body: Record<string, unknown>): { samples: HealthSample[]; observedAt: string } {
  const report = isPlainObject(body.report) ? body.report : bad('health 에는 report 객체가 필요합니다.');
  if (!nonEmptyString(report.observedAt)) bad('report.observedAt 이 없습니다. 시각은 브리지가 만들어 넣지 않습니다(§13-3).');
  if (!Array.isArray(report.samples)) bad('report.samples 는 배열이어야 합니다.');
  const samples: HealthSample[] = [];
  for (const s of report.samples) {
    if (!isPlainObject(s)) bad('samples 항목은 객체여야 합니다.');
    if (!nonEmptyString(s.component)) bad('samples 항목에 component 가 없습니다.');
    // 알 수 없는 컴포넌트는 여기서 막지 않는다 — Core 가 선언 목록으로 거른다(§9.3).
    if (!isHealthState(s.state)) {
      // 상태 없는 샘플을 up 으로 읽으면, 장애 중인 엔진이 정상으로 집계된다(§9.3).
      bad(`samples 항목의 state 가 유효하지 않습니다: ${String(s.state)}`);
    }
    const sample: Record<string, unknown> = {
      component: s.component as ComponentId,
      state: s.state,
      observedAt: nonEmptyString(s.observedAt) ? s.observedAt : report.observedAt,
    };
    for (const key of ['errorRate', 'latencyMs'] as const) {
      if (s[key] === undefined) continue;
      if (typeof s[key] !== 'number' || !Number.isFinite(s[key] as number) || (s[key] as number) < 0) {
        bad(`samples.${key} 는 음이 아닌 유한 숫자여야 합니다(§13-3).`);
      }
      sample[key] = s[key];
    }
    if (s.detail !== undefined) {
      if (typeof s.detail !== 'string') bad('samples.detail 은 문자열이어야 합니다.');
      // 호스트가 보낸 자유 문구다. 저장 경로로 들어가기 전에 여기서 한 번 마스킹한다(§10.3).
      sample.detail = maskPii(s.detail).text;
    }
    samples.push(sample as unknown as HealthSample);
  }
  return { samples, observedAt: report.observedAt };
}

/**
 * 이벤트도 같은 노출 규칙을 받는다.
 *
 * 여기서 한 번 데인 지점이다: handoff.requested 이벤트(§8.1)에는 상담사용 요약 전문이 들어 있고,
 * 그 안에는 수집 슬롯 값과 직전 대화가 통째로 있다. handoff.summaryMasked 만 막고 events 를 그대로
 * 흘리면, "요약은 안 나간다"는 약속이 이벤트 배열 하나로 무효가 된다. 그래서 같은 스위치로 함께 막고,
 * 요약이 있었다는 사실(summary_present)은 남긴다 — 있었는지조차 감추면 이관 누락을 조사할 수 없다.
 */
function projectEvents(events: readonly unknown[], opts: BridgeOptions): unknown[] {
  if (opts.includeHandoffSummary) return events as unknown[];
  return events.map((e) => {
    if (!isPlainObject(e) || e.summary_masked === undefined) return e;
    const { summary_masked: _dropped, ...rest } = e;
    return rest;
  });
}

/**
 * 판정을 **필드별로 다시 적는다**. 객체를 그대로 흘리지 않는 이유가 둘이다 —
 * (1) `summaryMasked` 가 노출 스위치를 건너뛰어 나가는 경로를 만들지 않는다(§2·§10.3),
 * (2) 배열(`warnings`·`path`·`issues`)을 복사해 호스트가 Core 의 판정을 고칠 수 없게 한다
 *     (JSON 직렬화 전까지는 고칠 수 있고, 고쳐진 판정은 "Core 가 그렇게 적었다"로 남는다 —
 *     동의·점검 투영과 같은 규칙이다).
 */
function projectPlacement(p: HandoffPlacement): BridgePlacementPayload {
  const common: BridgePlacementPayload = {
    placement: p.placement,
    reasonKo: p.reasonKo,
    summaryPresent: p.summaryPresent,
    warnings: [...p.warnings],
  };
  if (p.placement === 'unavailable') {
    return { ...common, code: p.code, issues: [...p.issues] };
  }
  const base: BridgePlacementPayload = { ...common, requestedQueueId: p.requestedQueueId, path: [...p.path] };
  if (p.placement === 'alternative') return { ...base, cause: p.cause, action: p.action };
  return {
    ...base,
    queueId: p.queueId,
    overflowed: p.overflowed,
    ...(p.matchedRuleId !== undefined ? { matchedRuleId: p.matchedRuleId } : {}),
  };
}

/**
 * 오퍼 전이의 전송용 투영.
 *
 * **원장(`step.ledger`)을 싣지 않는다.** 두 가지 이유다 — (1) 그 안에는 같은 테넌트의 **다른
 * 상호작용** 오퍼가 전부 들어 있고, 채널 호스트가 알아야 하는 것은 이번 건의 결과뿐이다
 * (§11.1 의 격리는 테넌트 경계지만, 필요 없는 것을 내보내지 않는 것은 그와 별개의 규칙이다),
 * (2) 통화가 많은 시각에는 그 배열이 매 응답마다 커진다 — 한 줄 상한(`maxLineBytes`)에
 * 걸리는 순간 **수락 응답이 거부로 바뀐다**.
 *
 * 배열은 복사한다(`skipped`·`issues`·`warnings`) — 호스트가 "제외된 상담사 없음"으로 고칠 수
 * 있게 두면 그 거짓이 "Core 가 그렇게 적었다"로 남는다(이관·동의 투영과 같은 규칙).
 */
function projectOfferStep(step: AgentOfferStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: step.code,
    via: step.via,
    interactionId: step.interactionId,
    reasonKo: step.reasonKo,
    skipped: [...step.skipped],
    issues: [...step.issues],
    warnings: [...step.warnings],
  };
  if (step.attempt !== undefined) out.attempt = step.attempt;
  // 상담사 id·오퍼 id 는 호스트가 선언한 값이므로 되돌려준다(Core 가 만든 값이 아니다).
  if (step.offer !== undefined) {
    out.offer = {
      offerId: step.offer.offerId,
      queueId: step.offer.queueId,
      agentId: step.offer.agentId,
      state: step.offer.state,
      offeredAt: step.offer.offeredAt,
      attempt: step.offer.attempt,
    };
  }
  if (step.placement !== undefined) out.placement = projectPlacement(step.placement);
  return out;
}

function projectTurn(r: ChannelTurnResult, opts: BridgeOptions): BridgeTurnPayload {
  const slots = r.state.slots ?? {};
  const payload: BridgeTurnPayload = {
    interactionId: r.interactionId,
    status: r.status,
    steps: r.steps as unknown[],
    state: {
      flowId: r.state.flowId,
      flowVersion: r.state.flowVersion,
      channel: r.state.channel,
      currentNodeId: r.state.currentNodeId,
      status: r.state.status,
      turnCount: r.state.turnCount,
      failCount: r.state.failCount,
      slotKeys: Object.keys(slots),
      // 값이 아니라 **대기 사실**이다 — 커넥터 id 는 테넌트 설정 문자열이고 개인정보가 아니므로
      // 노출 스위치와 무관하게 나간다(없으면 호스트는 위 주석의 무음을 구분할 수 없다).
      ...(r.state.pendingConnectorId !== undefined ? { pendingConnectorId: r.state.pendingConnectorId } : {}),
    },
    events: projectEvents(r.events as unknown[], opts),
  };
  if (opts.includeSlots) payload.state.slots = { ...slots };
  // §9.3 판정도 **복사해서** 내보낸다. 그대로 넘기면 호스트가 `disable`·`causes` 에 push·splice 로
  // Core 의 판정을 고칠 수 있고(JSON 직렬화 전까지), 고쳐진 판정은 "Core 가 그렇게 적었다"로 남는다 —
  // 하필 그 배열이 **무엇을 끄라는 지시**다(동의·점검·이관 투영과 같은 규칙).
  if (r.fallback !== undefined) {
    payload.fallback = {
      ...r.fallback,
      causes: r.fallback.causes.map((c) => ({ ...c })),
      disable: [...r.fallback.disable],
    };
  }
  if (r.handoff !== undefined) {
    const handoff: BridgeTurnPayload['handoff'] = {
      summaryAvailable: r.handoff.summaryMasked !== undefined,
    };
    if (r.handoff.queue !== undefined) handoff.queue = r.handoff.queue;
    // 상담사용 요약은 요청한 소비자에게만 준다. 고객 노출 경로가 이 값을 받으면 언젠가 화면에 뜬다.
    if (opts.includeHandoffSummary && r.handoff.summaryMasked !== undefined) {
      handoff.summaryMasked = r.handoff.summaryMasked;
    }
    // 큐에 들어갔는지 / 대안으로 갔는지. **노출 스위치와 무관하게 나간다** — 여기에는 개인정보가
    // 없고(큐 id·판정 코드·Core 가 마스킹한 사유뿐), 감추면 호스트는 큐에 넣지 못한 고객에게도
    // 상담사 연결을 안내한다(§9.3).
    if (r.handoff.placement !== undefined) handoff.placement = projectPlacement(r.handoff.placement);
    payload.handoff = handoff;
  }
  // §5.2 전환 초대도 **필드별로 다시 적는다**(이관 판정과 같은 규칙) — 토큰이 노출 스위치를
  // 건너뛰어 나가는 경로를 만들지 않는다. 사실·만료·사유는 스위치와 무관하게 나간다.
  if (r.switchInvite !== undefined) {
    const s = r.switchInvite;
    const tokenIncluded = opts.includeSwitchTicket === true && s.token !== undefined;
    payload.switchInvite = {
      fromChannel: s.fromChannel,
      toChannel: s.toChannel,
      ticketIssued: s.ticketIssued,
      tokenIncluded,
      ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
      ...(s.tokenless === true ? { tokenless: true } : {}),
      ...(s.notIssuedKo !== undefined ? { notIssuedKo: s.notIssuedKo } : {}),
      ...(tokenIncluded ? { token: s.token } : {}),
    };
  }
  // 고지 사실은 어떤 노출 스위치와도 무관하게 나간다 — 슬롯 값·상담사용 요약과 달리
  // 여기에는 개인정보가 없고, 감추면 "고지했다"를 증명할 길이 호스트에 남지 않는다(§10.1).
  if (r.disclosure !== undefined) payload.disclosure = { ...r.disclosure };
  if (r.billing !== undefined) payload.billing = { ...r.billing };
  // 동의 사실도 그대로 내보낸다. `pendingRequired` 는 **복사한 배열**이다 — 결과 객체를 그대로
  // 넘기면 호스트가 정렬·push 로 Core 가 돌려준 판정을 고칠 수 있다(JSON 직렬화 전까지).
  if (r.consent !== undefined) {
    payload.consent = {
      ...r.consent,
      ...(r.consent.pendingRequired !== undefined ? { pendingRequired: [...r.consent.pendingRequired] } : {}),
      ...(r.consent.recorded !== undefined ? { recorded: { ...r.consent.recorded } } : {}),
    };
  }
  // 점검 요약도 같은 규칙이다 — 배열·객체는 **복사해서** 내보낸다. 결과를 그대로 넘기면 호스트가
  // push·정렬·대입으로 Core 가 돌려준 판정을 고칠 수 있고(JSON 직렬화 전까지), 고쳐진 판정은
  // "점검을 통과했다"로 남는다.
  if (r.compliance !== undefined) {
    const c = r.compliance;
    payload.compliance = {
      ...c,
      ...(c.counts !== undefined ? { counts: { ...c.counts } } : {}),
      ...(c.violated !== undefined ? { violated: [...c.violated] } : {}),
      ...(c.checked !== undefined ? { checked: [...c.checked] } : {}),
      ...(c.skipped !== undefined ? { skipped: c.skipped.map((s) => ({ ...s })) } : {}),
    };
  }
  return payload;
}

/**
 * 브리지를 만든다. 설정 오류는 여기서 던진다 — 잘못 켜진 브리지가 조용히 도는 것보다 낫다.
 */
export function createBridge(opts: BridgeOptions): Bridge {
  assertTenantScope(opts.scope);
  const activation: ChannelActivation = opts.activation ?? 'dry_run';
  if (activation === 'live' && !opts.approvalRef) {
    throw new BridgeConfigError('[승인 필요] live 브리지에는 승인 근거(approvalRef)가 필요합니다.');
  }
  if (opts.maxLineBytes !== undefined && (!Number.isInteger(opts.maxLineBytes) || opts.maxLineBytes <= 0)) {
    throw new BridgeConfigError('maxLineBytes 는 양의 정수여야 합니다.');
  }
  /**
   * **계약 버전 불일치는 여기서 막는다**(§2).
   *
   * Node 경로에서는 같은 판정이 이미 있다 — `validateRegistration` 이 `E_VERSION_MISMATCH` 를
   * error 로 내고 그 채널은 붙지 못한다. 그런데 브리지 경로에는 그 판정이 없었다: `hello` 가
   * 두 숫자(`contractVersion`·`coreContractVersion`)를 **나란히 광고하면서 비교는 호스트에게
   * 맡겼고**, 참조 파이썬 클라이언트도 프로토콜 버전과 어댑터만 본다. 즉 아무도 비교하지 않았다.
   *
   * 어긋나는 배치가 실재한다: 호스트 모듈이 `node_modules` 에 설치된 다른 판의 Core 로
   * `{ core, scope }` 를 만들고, 실행기는 저장소 체크아웃의 브리지를 돌리는 구성이다(실행기는
   * `--core` 로 **모듈 경로**를 받으므로 두 판이 섞이는 것이 설정 한 줄 차이다). 그 상태의 증상은
   * 예외가 아니다 — 투영이 모르는 필드를 **조용히 빼고** 나가므로 호스트는 `placement`·
   * `switchInvite`·`consent` 가 없는 응답을 "그 턴에는 없었다"로 읽는다. 전환 링크를 보내지 않고,
   * 큐에 못 들어간 고객에게 상담사 연결을 안내하고, 동의 기록을 증명할 길이 없어진다.
   *
   * 기동을 거절하는 쪽을 골랐다: 되돌릴 수 있는 쪽은 기동 거절이고(설정 한 줄), 되돌릴 수 없는
   * 쪽은 어긋난 판정으로 이미 지나간 통화다 — `E_FOREIGN_COMPONENT` 와 같은 저울이다.
   */
  if (opts.core.contractVersion !== CHANNEL_CONTRACT_VERSION) {
    throw new BridgeConfigError(
      `채널 계약 버전 불일치: Core ${String(opts.core.contractVersion)} ≠ 브리지 ${CHANNEL_CONTRACT_VERSION}. `
      + 'Node 경로(validateRegistration)는 같은 불일치로 등록을 거부합니다 — 버전이 섞인 채 열린 '
      + '브리지는 모르는 필드를 조용히 빼고 응답하므로 호스트가 그것을 "그 턴에는 없었다"로 읽습니다(§2).',
    );
  }
  const capabilities = opts.capabilities ?? profileFor(opts.adapter);
  if (capabilities.adapter !== opts.adapter) {
    throw new BridgeConfigError(`능력 선언이 어댑터(${opts.adapter})와 어긋납니다.`);
  }
  // 제한기 **장애**는 통과로 두지만(§9.3), 제한기 **형태**가 틀린 것은 설정 오류다.
  // 둘을 같게 다루면 오타 하나로 제한이 조용히 꺼진 채 "적용했다"로 남는다.
  if (opts.rateLimiter !== undefined && typeof opts.rateLimiter?.check !== 'function') {
    throw new BridgeConfigError('rateLimiter 는 check(key, cost) 를 가진 제한기여야 합니다.');
  }
  if (opts.rateLimitCost) {
    for (const [op, cost] of Object.entries(opts.rateLimitCost)) {
      if (!BRIDGE_OP_SET.has(op)) throw new BridgeConfigError(`rateLimitCost 에 모르는 op 가 있습니다: ${op}`);
      // **제한 대상이 아닌 op 에 비용을 주면 거절한다.** 종전에는 조용히 무시했다 —
      // 같은 실수를 런타임(`RATE_LIMITED_ENTRIES`)은 거절하고 브리지는 통과시켰으므로,
      // `{ end: 10 }` 같은 설정은 경로에 따라 "거절"과 "적용했다고 믿는 무제한"으로 갈렸다(§2).
      // 조용히 무시하는 쪽이 더 나쁘다: 한도를 걸었다고 적힌 운영 문서만 남는다.
      if (!RATE_LIMITED_OPS.has(op as BridgeOp)) {
        throw new BridgeConfigError(
          `rateLimitCost.${op} 는 한도 적용 대상이 아닙니다 — 적용 대상은 `
          + `${[...RATE_LIMITED_OPS].join('·')} 입니다(hello·end·유지 루프는 막지 않습니다).`,
        );
      }
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
        throw new BridgeConfigError(`rateLimitCost.${op} 는 양수여야 합니다.`);
      }
    }
    if (!opts.rateLimiter) throw new BridgeConfigError('rateLimitCost 를 주려면 rateLimiter 도 주어야 합니다.');
  }

  /** 한도 판정. 제한기가 없으면 통과. 제한기 자체의 예외는 잠그는 쪽이 아니라 통과로 둔다 — 제한기 장애로 통화가 끊기면 안 된다(§9.3). */
  function enforceLimit(op: BridgeOp): void {
    if (!opts.rateLimiter || !RATE_LIMITED_OPS.has(op)) return;
    let decision;
    try {
      decision = opts.rateLimiter.check(rateLimitKey(opts.scope, `bridge.${op}`), opts.rateLimitCost?.[op] ?? 1);
    } catch {
      return;
    }
    if (!decision.allowed) {
      throw new RequestError('E_RATE_LIMITED',
        `요청 한도 초과(${op}). ${decision.retryAfterMs}ms 후 재시도하세요.`, decision.retryAfterMs);
    }
  }

  // 배선을 선언하지 않으면 관측기를 만들지 않는다 — `recordRejection` 호출 자체가 없어
  // 종전과 완전히 같다(§13-3).
  const observer = opts.observability === undefined ? undefined : createObserver(opts.observability);

  const records: BridgeRecord[] = [];
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
  // 도착 순서대로 직렬 처리한다. 같은 세션에 두 턴이 겹치면 상태가 갈라지기 때문이다.
  let queue: Promise<unknown> = Promise.resolve();

  function push(r: BridgeRecord): void {
    records.push(r);
    if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
    if (opts.onRecord) {
      try { opts.onRecord(r); } catch { /* 통지 실패가 턴을 죽이지 않는다 */ }
    }
  }

  /**
   * Core 진입점을 **부르기 시작했는지 / 돌아왔는지**. 이 두 비트가 수집기 보고 여부를 가른다
   * (`BridgeStage` 주석) — Core 가 던진 예외를 브리지가 또 올리면 한 번의 예외가 보고 두 건이 된다.
   */
  interface CoreSpan { entered: boolean; returned: boolean }

  function stageOf(span: CoreSpan): BridgeStage {
    if (!span.entered) return 'request';
    return span.returned ? 'response' : 'core';
  }

  const maintCore = opts.core as MaintenanceCapableCore;

  /** op 별 배선 스위치. 선언이 없으면 닫힘이다 — 기본으로 열면 종전 동작이 조용히 바뀐다(§13-3). */
  function maintenanceSwitch(op: BridgeOp): boolean {
    const m = opts.maintenance;
    if (m === undefined) return false;
    switch (op) {
      case 'warnings': return m.warnings === true;
      case 'readiness': return m.readiness !== undefined;
      case 'recoveryProbe': return m.recoveryProbe === true;
      case 'offerExpiry': return m.offerExpiry === true;
      case 'settleOffer': return m.settleOffer === true;
      case 'observability': return m.observability === true;
      default: return false;
    }
  }

  /** Core 쪽 메서드까지 있는지 — `hello` 가 알려주는 것은 **실제로 부를 수 있는 것**이다. */
  function maintenanceOpen(op: BridgeOp): boolean {
    if (!maintenanceSwitch(op)) return false;
    switch (op) {
      case 'warnings': return typeof maintCore.warnings === 'function';
      case 'readiness': return typeof maintCore.readiness === 'function';
      case 'recoveryProbe': return typeof maintCore.runRecoveryProbes === 'function';
      case 'offerExpiry': return typeof maintCore.runOfferExpiry === 'function';
      case 'settleOffer': return typeof maintCore.settleAgentOffer === 'function';
      case 'observability': return typeof maintCore.observability === 'function';
      default: return false;
    }
  }

  function notWired(op: BridgeOp, reasonKo: string): never {
    throw new RequestError('E_NOT_WIRED', `${op} 가 열려 있지 않습니다: ${reasonKo}`);
  }

  /**
   * 배선 스위치와 Core 메서드를 **부르기 전에** 함께 확인한다(stage=request). 둘을 따로 보면
   * 스위치만 켠 배치에서 `TypeError` 가 `E_INTERNAL` 로 올라가고, 그 줄은 수집기에 "Core 예외"로
   * 남아 설정 누락이 장애로 보인다.
   */
  function requireMaintenance(
    op: BridgeOp,
    pick: (c: MaintenanceCapableCore) => unknown,
  ): MaintenanceCapableCore {
    if (!maintenanceSwitch(op)) {
      notWired(op, '브리지 설정(maintenance)에 선언되지 않았습니다.');
    }
    if (typeof pick(maintCore) !== 'function') {
      notWired(op, 'Core 가 이 유지 메서드를 제공하지 않습니다(ConversationCorePort 만 주어졌습니다).');
    }
    return maintCore;
  }

  async function dispatch(op: BridgeOp, body: Record<string, unknown>, span: CoreSpan): Promise<unknown> {
    switch (op) {
      case 'hello':
        return {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          contractVersion: CHANNEL_CONTRACT_VERSION,
          coreContractVersion: opts.core.contractVersion,
          adapter: opts.adapter,
          capabilities,
          activation,
          includesHandoffSummary: opts.includeHandoffSummary === true,
          includesSlots: opts.includeSlots === true,
          // 전환 링크를 **이 호스트가 만들 수 있는지**를 알려 준다. 끈 상태에서 링크를 만들려
          // 하면 호스트는 id 로 링크를 만들 수밖에 없고, 그 순간 1회용·만료가 무의미해진다(§5.2).
          includesSwitchTicket: opts.includeSwitchTicket === true,
          /**
           * **열려 있는 유지 루프를 알려준다.** 호스트가 op 를 하나씩 찔러 보고 알아내게 두면
           * 세 저장소가 각자 다르게 알아내고(§2), 더 나쁜 것은 **아무도 찔러 보지 않는 것**이다 —
           * 그러면 그 배치는 만료 수렴·복구 확인이 돌지 않는 채로 조용히 운영된다.
           */
          maintenanceOps: BRIDGE_MAINTENANCE_OPS.filter((o) => maintenanceOpen(o)),
        };
      case 'start': {
        // 요청 해석은 **부르기 전에** 끝낸다 — 해석 실패는 Core 가 본 적 없는 줄이다(stage=request).
        const req = toSessionRequest(body, opts);
        span.entered = true;
        const r = await opts.core.start(req);
        span.returned = true;
        return projectTurn(r, opts);
      }
      case 'send': {
        if (!nonEmptyString(body.interactionId)) bad('interactionId 가 없습니다.');
        const turn = toTurnInput(body);
        span.entered = true;
        const r = await opts.core.send(body.interactionId, turn);
        span.returned = true;
        return projectTurn(r, opts);
      }
      case 'end': {
        if (!nonEmptyString(body.interactionId)) bad('interactionId 가 없습니다.');
        if (!nonEmptyString(body.reasonKo)) bad('reasonKo 가 없습니다. 종료 사유 없는 종료는 기록에서 원인을 잃습니다.');
        // §11.2 통화 과금 구간은 **형태 검증을 여기서 하지 않고** Core 로 넘긴다. 두 가지 이유다 —
        // (1) `end` 는 어떤 경우에도 막지 않는다(막히면 세션이 새고 누수는 요금으로 나타난다),
        // (2) 검사가 두 곳이면 같은 값이 경로에 따라 다르게 판정된다(§2). 무효값은 Core 가
        // 싣지 않고 응답 `billing` 에 사유를 적는다. 선언이 없으면 종전과 완전히 같다(§13-3).
        const endInput = body.billableMs === undefined
          ? undefined
          : { billableMs: body.billableMs as number };
        span.entered = true;
        const r = await opts.core.end(body.interactionId, body.reasonKo, endInput);
        span.returned = true;
        return projectTurn(r, opts);
      }
      case 'health': {
        const { samples, observedAt } = toHealthSamples(body);
        span.entered = true;
        const receipt = opts.core.reportHealth({ adapter: opts.adapter, samples, observedAt });
        span.returned = true;
        /**
         * **해석한 줄 수를 `accepted` 로 적지 않는다**(§13-3). 종전에는 `samples.length` 를
         * 그대로 `accepted` 로 돌려줬는데 그것은 Core 가 접수한 수가 아니라 브리지가 **파싱한**
         * 수다. Core 는 등록되지 않은 어댑터의 보고와 선언하지 않은 컴포넌트의 샘플을 무시하므로
         * (§9.3), 그 상태의 비-Node 호스트는 `{"accepted":3}` 을 받으며 **한 건도 전달되지 않는
         * 채로** 영구히 운영된다. 증상은 조용하다: 엔진이 전부 죽어도 판정은 `normal` 이고,
         * 한 번 내려간 테넌트는 샘플이 갱신되지 않아 폴백에서 돌아오지 못한다.
         *
         * 접수 범위를 돌려주지 않는 구현(`ConversationCorePort` 만 주어진 경우)에서는
         * **`accepted` 를 아예 싣지 않는다** — 모르는 것을 숫자로 적는 쪽이 더 나쁘다.
         */
        if (receipt === undefined) {
          return {
            offered: samples.length,
            acceptedKnown: false,
            reasonKo: 'Core 구현이 접수 범위를 돌려주지 않습니다 — 이 샘플이 §9.3 판정에 닿았는지 알 수 없습니다.',
          };
        }
        return { ...receipt, declared: [...receipt.declared], acceptedKnown: true };
      }

      // ── 유지 루프(§9.3·§2) ─────────────────────────────────────────────────
      // 공통 규칙 셋이다:
      //  (1) **배선이 없으면 거절한다**(`E_NOT_WIRED`) — 빈 보고서는 "0건"으로 읽힌다.
      //  (2) **판정 기준을 본문에서 받지 않는다** — 시각·제한 시간·프로브는 Node 쪽 배선이 준다.
      //  (3) **Core 가 `undefined` 를 돌려주면 그것도 거절이다** — Core 쪽 배선이 없다는 뜻이고,
      //      브리지만 열려 있는 상태를 "확인했고 0건"으로 적으면 안 된다.
      case 'warnings': {
        const core = requireMaintenance('warnings', (c) => c.warnings);
        span.entered = true;
        const issues = core.warnings!();
        span.returned = true;
        // 전문은 호스트가 읽는다(로그에는 코드만 간다 — `obs/executeObservability.ts`).
        return { issues: wireCopy(issues) };
      }
      case 'readiness': {
        const core = requireMaintenance('readiness', (c) => c.readiness);
        const req = opts.maintenance?.readiness;
        if (req === undefined) {
          notWired('readiness', 'maintenance.readiness 요청(프로브·제한 시간)이 배선되지 않았습니다.');
        }
        span.entered = true;
        const report = await core.readiness!(req);
        span.returned = true;
        return wireCopy(report);
      }
      case 'recoveryProbe': {
        const core = requireMaintenance('recoveryProbe', (c) => c.runRecoveryProbes);
        span.entered = true;
        const report = await core.runRecoveryProbes!();
        span.returned = true;
        if (report === undefined) notWired('recoveryProbe', 'Core 에 복구 프로브 배선이 없습니다(§9.3).');
        return wireCopy(report);
      }
      case 'offerExpiry': {
        const core = requireMaintenance('offerExpiry', (c) => c.runOfferExpiry);
        span.entered = true;
        const report = await core.runOfferExpiry!();
        span.returned = true;
        if (report === undefined) notWired('offerExpiry', 'Core 에 배정 오퍼 배선이 없습니다(§2).');
        return wireCopy(report);
      }
      case 'settleOffer': {
        const core = requireMaintenance('settleOffer', (c) => c.settleAgentOffer);
        // 상담사 응답은 **사실**이므로 본문에서 받는다. 형태는 부르기 전에 끝낸다.
        if (!nonEmptyString(body.offerId)) bad('offerId 가 없습니다.');
        // `tick` 은 **만료 수렴의 수단**이라 여기서 받지 않는다 — 받으면 호스트가 임의 시점에
        // 한 건씩 만료시킬 수 있고, 그 판정은 `offerExpiry` 가 보는 것과 갈라진다(§2).
        // **아는 값부터 거절한다**: 모르는 값 안내에 `tick` 을 섞어 적으면 그 안내를 따른
        // 호스트가 다음 검사에서 또 거절당한다.
        if (body.event === 'tick') {
          bad('tick 은 offerExpiry 가 수행합니다 — 건별로 만료시키면 만료 판정이 두 곳이 됩니다(§2).');
        }
        if (typeof body.event !== 'string' || !SETTLE_OFFER_EVENT_SET.has(body.event)) {
          // 값은 되돌려 적지 않는다 — 호스트가 그 자리에 임의 문자열을 넣을 수 있다(§10.3).
          bad(`event 가 유효하지 않습니다. 허용값: ${SETTLE_OFFER_EVENTS.join('·')}`);
        }
        span.entered = true;
        const step = await core.settleAgentOffer!({ offerId: body.offerId, event: body.event as OfferEvent });
        span.returned = true;
        if (step === undefined) notWired('settleOffer', 'Core 에 배정 오퍼 배선이 없습니다(§2).');
        return projectOfferStep(step);
      }
      /**
       * 관측 실측. **읽기만 한다** — 억제분 방출(`flushObservability`)은 부작용이라 여기에
       * 섞지 않는다. 섞으면 대시보드를 새로 고칠 때마다 수집기로 보고가 나가고, 더 나쁘게는
       * 종료 직전 방출이 "방금 읽었으니 비었다"로 바뀐다. 방출은 실행기가 종료 시점에 한다
       * (`scripts/channel-bridge.mjs`).
       *
       * 관측기는 **둘**이다(런타임 진입점·브리지 경계). 둘을 합쳐 한 숫자로 적지 않는다 —
       * 브리지의 `rejected` 는 Core 에 닿지도 못한 줄이고 런타임의 `recorded` 는 닿은 줄이라,
       * 합치면 "호스트 직렬화 버그로 전 줄이 깨지는" 상태와 "통화가 잘 도는" 상태가 같은
       * 수치로 보인다. 브리지 쪽 배선이 없으면 그 자리는 **싣지 않는다**(0 이 아니다).
       */
      case 'observability': {
        const core = requireMaintenance('observability', (c) => c.observability);
        span.entered = true;
        const stats = core.observability!();
        span.returned = true;
        if (stats === undefined) {
          notWired('observability', 'Core 에 관측 배선(로거·수집기)이 없습니다 — 0 건으로 적으면 '
            + '로거가 전부 던지는 상태가 "실패 0건"으로 읽힙니다(§13-3).');
        }
        const own = observer?.stats();
        return own === undefined
          ? {
            core: wireCopy(stats),
            bridgeKnown: false,
            reasonKo: '브리지에 관측 배선이 없어 경계 거부 수치가 없습니다 — '
              + '깨진 줄·모르는 op·한도 초과는 Core 를 부르기 전에 끝나므로 Core 수치에도 없습니다.',
          }
          : { core: wireCopy(stats), bridge: wireCopy(own), bridgeKnown: true };
      }
    }
  }

  async function handleOne(line: string): Promise<BridgeResponse> {
    const started = opts.clock?.();
    const finish = (): number | undefined => (started === undefined || !opts.clock ? undefined : opts.clock() - started);
    let id: string | null = null;
    let op: BridgeOp | null = null;
    const span: CoreSpan = { entered: false, returned: false };
    try {
      const parsed = parseBridgeLine(line, opts.maxLineBytes);
      id = parsed.id;
      op = parsed.op;
      enforceLimit(parsed.op);
      const result = await dispatch(parsed.op, parsed.body, span);
      // **성공한 줄은 관측에 올리지 않는다.** Core 호출의 성공은 런타임 관측이 이미 적고
      // (`observe`), 브리지가 한 번 더 적으면 같은 턴이 로그에 두 줄로 남아 집계가 두 배가 된다.
      // 경계에서만 일어나는 성공(`hello`)은 실패가 아니므로 적을 근거가 없다(§13-3).
      push({ id, op, ok: true, durationMs: finish() });
      return { id, ok: true, result };
    } catch (e) {
      const code: BridgeErrorCode = e instanceof RequestError ? e.code : 'E_INTERNAL';
      const withId = e as RequestError & { id?: string | null };
      if (id === null && typeof withId.id === 'string') id = withId.id;
      // Core 내부 예외의 원문·스택은 호스트에 내보내지 않는다. 마스킹된 한 줄만 남긴다.
      const messageKo = e instanceof RequestError
        ? e.message
        : `Core 처리 중 오류가 발생했습니다: ${safeText(e)}`;
      const durationMs = finish();
      push({ id, op, ok: false, errorCode: code, durationMs });
      // 경계 실패를 관측에 남긴다. 지금까지 이 실패들은 **이 프로세스 바깥에서 보이지 않았다** —
      // 깨진 줄·모르는 op·한도 초과는 Core 를 부르기 전에 끝나므로 Core 로그는 완전히 조용하다.
      // 줄 원문·오류 문구는 넘기지 않는다(바이트 수만, §10.3).
      observer?.recordRejection({
        scope: opts.scope,
        adapter: opts.adapter,
        stage: stageOf(span),
        code,
        ...(id !== null ? { requestId: id } : {}),
        ...(op !== null ? { op } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(typeof line === 'string' ? { lineBytes: Buffer.byteLength(line, 'utf8') } : {}),
        ...(e instanceof RequestError && e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
        error: e,
      });
      const error: BridgeError = { code, messageKo };
      if (e instanceof RequestError && e.retryAfterMs !== undefined) error.retryAfterMs = e.retryAfterMs;
      return { id, ok: false, error };
    }
  }

  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    activation,
    records,
    handleLine(line: string): Promise<BridgeResponse> {
      // 큐가 끊기지 않게 항상 성공으로 이어붙인다. handleOne 은 던지지 않는다.
      const next = queue.then(() => handleOne(line));
      queue = next.catch(() => undefined);
      return next;
    },
    observability: () => observer?.stats(),
    flushObservability: () => observer?.flush() ?? 0,
    reset() {
      records.length = 0;
      queue = Promise.resolve();
    },
  };
}

/**
 * 여러 줄을 순서대로 처리해 응답 줄들을 돌려준다. 파일·파이프 배치 처리와 테스트에 쓴다.
 * 빈 줄은 조용히 건너뛴다 — 파이프 끝의 개행 하나가 오류 응답을 만들면 로그가 쓰레기가 된다.
 */
export async function runBridgeLines(bridge: Bridge, lines: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    out.push(encodeResponse(await bridge.handleLine(line)));
  }
  return out;
}
