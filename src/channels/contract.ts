// 채널 어댑터 계약 — Callbot(voice)·Chatbot(chat)·D-ARS(visual)가 Core를 소비하는 공용 인터페이스.
// 설계서 §1.2(Core 단일화)·§5.3(하나의 Flow, 채널 렌더러)·§6.2(엔진 비종속)·§11.1(테넌트 격리)·§10.3(마스킹).
//
// 왜 계약을 따로 두는가:
// 채널 저장소 3개가 각자 Core를 "적당히" 호출하기 시작하면, 6개월 뒤 시나리오가 다시 세 벌이 된다(§2).
// 그래서 채널이 Core에게 줄 것(입력·사용량·헬스)과 Core가 채널에게 시킬 것(렌더·이관·종료)을
// 여기서 한 번만 정의한다. 채널 저장소는 이 인터페이스만 구현하고, Core 내부 타입을 직접 만지지 않는다.
//
// 이 파일에는 전송·프로토콜 코드가 없다. 실제 회선·웹소켓 연결은 승인 후 각 저장소에서 붙인다 — [승인 필요].
import type { HandoffPlacement } from '../routing/executeHandoff.ts';
import type { ChannelKind } from '../domain/types.ts';
import type { RenderedStep, Flow } from '../flow/types.ts';
import type { FlowInput, FlowState, RunStatus } from '../flow/runner.ts';
import type { EntryPoint, LatencyMs, UsageMetrics, InteractionEvent } from '../events/schema.ts';
import type { TenantScope } from '../core/tenancy.ts';
import type { SwitchTicket } from '../core/executeSwitch.ts';
import type { DisclosurePlacement } from '../portal/aiDisclosure.ts';
import type { ComponentId, HealthSample, FallbackDecision } from '../ops/fallback.ts';
import { CHANNEL_DEPENDENCIES, COMPONENT_IDS } from '../ops/fallback.ts';
import type { TurnBillingNote } from '../billing/turnUsage.ts';
import type { ConsentPurpose } from '../consent/consent.ts';
import type { ComplianceTurnNote } from '../qa/executeCompliance.ts';

export const CHANNEL_CONTRACT_VERSION = 1;

/** 채널 구현체 식별. 저장소 3개가 이 값으로 자기를 밝힌다. */
export type ChannelAdapterId = 'callbot' | 'chatbot' | 'dars';

export const ADAPTER_CHANNEL: Record<ChannelAdapterId, ChannelKind> = {
  callbot: 'voice',
  chatbot: 'chat',
  dars: 'visual',
};

/**
 * 어댑터 id 목록 — **이 표 하나에서 파생시킨다**(§2).
 *
 * 손으로 적어 둔 사본이 세 벌이었다(적합성 실행기의 `--adapter` 허용값 · 베이스 포트 묶음 ·
 * 관측 허용 목록). 값이 같았으므로 증상은 없었지만, **채널이 하나 늘어나는 날 늘지
 * 않은 쪽만 틀린다** — 그리고 세 사본의 어긋남이 전부 조용하다: 실행기는 그 채널의 CI 를
 * `--adapter 값이 올바르지 않습니다` 로 거절하고(그 저장소는 게이트를 아예 못 돌린다),
 * 관측 허용 목록은 그 채널의 `adapter` 필드를 **로그·수집기 보고에서 빼므로** 그 채널의
 * 실패만 어느 채널의 것인지 알 수 없는 상태로 남는다(`BRIDGE_OPS` 와 같은 자리다).
 */
export const CHANNEL_ADAPTER_IDS: readonly ChannelAdapterId[] = Object.keys(ADAPTER_CHANNEL) as ChannelAdapterId[];

/**
 * 계약 안에 있는 어댑터 id 인가. **`ADAPTER_CHANNEL` 의 키만** 참으로 본다.
 *
 * 왜 판정을 함수로 두는가: 모르는 id 는 **반쪽 능력 선언**을 만든다(`profileFor` 는
 * `CHANNEL_PROFILES` 에 없는 id 에 `{ adapter: '오타', channel: undefined }` 를 돌려준다).
 * 그 상태에서 `capabilities.channel !== ADAPTER_CHANNEL[port.id]` 는 `undefined !== undefined`
 * 이므로 **참이 되지 않는다** — 즉 어긋남 검사가 통째로 통과한다(§5.3).
 */
export function isChannelAdapterId(v: unknown): v is ChannelAdapterId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ADAPTER_CHANNEL, v);
}

/**
 * 언어 중립 브리지(JSONL)의 op 목록 — **이 계약의 와이어 형태**다.
 *
 * 선언이 여기 있는 이유: 종전에는 세 모듈이 각자 목록을 들고 있었다(브리지 디스패치·
 * 전사 판정기·관측 분류기). 그 상태에서 op 가 하나 늘면 **늘어난 것을 모르는 쪽만 틀린다** —
 * 전사 판정기는 그 줄을 `opCounts` 에 세지 않고(적합성 전사가 "그 op 는 오지 않았다"로 읽힌다),
 * 관측 분류기는 `op` 를 임의 문자열로 보아 로그 필드에서 빼므로 **그 op 의 경계 실패만
 * 어느 줄에 붙은 실패인지 알 수 없는 상태로 남는다**. 둘 다 예외가 아니다.
 *
 * - `hello`·`start`·`send`·`end`·`health` — 통화 경로.
 * - 나머지는 **유지 루프**다(§9.3·§2). Core 는 타이머를 돌리지 않으므로 호스트가 부르는데,
 *   브리지에 자리가 없던 동안 비-Node 호스트에는 **부를 길이 아예 없었다**.
 */
export type BridgeOp =
  | 'hello'
  | 'start'
  | 'send'
  | 'end'
  | 'health'
  /** 등록 시점 계약 경고 전문(§9.3·§10.1). `hello` 는 싣지 않는다 — 경고는 등록 뒤에 확정된다. */
  | 'warnings'
  /** §9.3 폴백 상태를 포함한 readiness. 호스트 `/health` 가 이 값을 합쳐 쓴다. */
  | 'readiness'
  /** §9.3 복구 확인 1회. 부르지 않으면 한 번 내려간 채널이 영구히 폴백에 남는다. */
  | 'recoveryProbe'
  /** 배정 오퍼 만료 수렴 1회. 부르지 않으면 만료분이 열린 채 쌓인다. */
  | 'offerExpiry'
  /**
   * §5.2 전환 초대 정리 1회(§10.3). 부르지 않으면 발급된 초대가 레지스트리에서 **나가지
   * 않는다** — 상환·만료는 상태만 바꾸고, 그 안에는 승계 슬롯 스냅샷이 들어 있다.
   */
  | 'inviteExpiry'
  /** 상담사 수락·거절·취소 반영. 올리지 않으면 재배정도 소진 수렴도 일어나지 않는다. */
  | 'settleOffer'
  /**
   * 관측 실측(`ConversationCore.observability()`). 수치만 나간다.
   *
   * 왜 필요한가: `failed`·`droppedIds` 는 **그 두 결함의 유일한 신호**다(§13-3). 로거·수집기가
   * 던지면 Core 는 통화를 끊지 않고 삼키지 않은 채 `failed` 로만 세고(그래서 "로그를 붙였다"와
   * "로그가 나가고 있다"가 바깥에서 구분되지 않는다), 호스트의 통화 id·상관관계 id 가 개인정보
   * 패턴에 걸리면 그 줄은 식별자 없이 남고 `droppedIds` 로만 집계된다(§10.3). 둘 다 예외가
   * 아니고, 비-Node 호스트에는 그 수치를 읽을 자리가 아예 없었다.
   */
  | 'observability';

/** 통화 경로. 요청 한도·전사 판정이 유지 루프와 다르게 다루는 쪽이다. */
const CALL_PATH_OP_TUPLE = ['hello', 'start', 'send', 'end', 'health'] as const;

/** 유지 루프. 호스트가 주기적으로 부르는 쪽이다(Core 는 타이머를 돌리지 않는다). */
const MAINTENANCE_OP_TUPLE = [
  'warnings', 'readiness', 'recoveryProbe', 'offerExpiry', 'inviteExpiry', 'settleOffer', 'observability',
] as const;

// 전체 목록은 **두 분류의 합**이다 — 따로 적으면 op 를 늘릴 때 분류를 빼먹을 수 있고, 그러면
// 그 op 만 요청 한도에 걸려(통화 경로로 분류된 셈) 수렴·복구 확인이 조용히 멈춘다.
const BRIDGE_OP_TUPLE = [...CALL_PATH_OP_TUPLE, ...MAINTENANCE_OP_TUPLE] as const;

/** 없는 op·오타를 막는다. */
export const BRIDGE_OPS: readonly BridgeOp[] = BRIDGE_OP_TUPLE;

/** 목록이 `BridgeOp` 를 **전부** 덮는지 — 빠뜨리면 이 대입이 컴파일 오류가 된다. */
const _bridgeOpsCover: Exclude<BridgeOp, typeof BRIDGE_OP_TUPLE[number]> extends never
  ? true : never = true;
void _bridgeOpsCover;

/**
 * 통화 경로가 아닌 op — **유지 루프**다. 요청 한도·전사 판정에서 통화 경로와 다르게 다룬다.
 * (한도: 유지 루프를 제한기로 막으면 만료 수렴·복구 확인이 멈추고, 그 상태는 "상담사가 안 받는다"·
 * "엔진이 안 돌아온다"와 구분되지 않는다. 제한은 고객 트래픽 경로에만 건다.)
 */
export const BRIDGE_MAINTENANCE_OPS: readonly BridgeOp[] = MAINTENANCE_OP_TUPLE;

/** 통화 경로 op. 유지 루프의 여집합이며 둘을 합친 것이 `BRIDGE_OPS` 다(§2). */
export const BRIDGE_CALL_PATH_OPS: readonly BridgeOp[] = CALL_PATH_OP_TUPLE;

/** 세션 시작 시 채널이 Core에 넘기는 최소 정보. 개인정보(발신번호 등)는 여기서 다루지 않는다(§10.3). */
export interface ChannelSessionRequest {
  scope: TenantScope;                 // §11.1 — 스코프 없는 진입 경로를 만들지 않는다
  adapter: ChannelAdapterId;
  entryPoint: EntryPoint;
  flowId: string;
  flowVersion?: number;
  /** 채널이 이미 알고 있는 슬롯(예: 인증 완료된 회원 등급). 값은 마스킹 대상이면 마스킹 후 넣는다. */
  presetSlots?: Record<string, string>;
  /**
   * 기존 Interaction 합류 — 통화 중 Visual IVR 링크를 열 때 D-ARS가 이 값을 넘긴다(§5.2).
   * 지정되면 새 세션을 만들지 않고 같은 Interaction에 채널을 붙인다.
   */
  joinInteractionId?: string;
  /**
   * 합류 자격 토큰(§5.2·§10.3). Core 에 채널 전환이 배선된 경우 **필수**다 —
   * id 만으로 합류를 허용하면 링크 URL·프록시 로그·상담 메모에 남는 Interaction id 가 곧
   * 진행 중인 세션의 열쇠가 되고, 이미 수집된 슬롯이 그려진 화면이 남에게 열린다.
   * 값은 `port.invite` 로 받은 티켓의 `token` 을 그대로 넘긴다(채널이 만들지 않는다).
   */
  joinToken?: string;
  /** 상관관계 추적용 채널측 식별자(호 ID·대화 ID). 개인정보를 넣지 않는다. */
  correlationId?: string;
}

/** 채널이 Core에 올리는 사용자 입력. 원문은 Core 진입 시점에 마스킹된다(§10.3). */
export interface ChannelTurnInput {
  input: FlowInput;
  /** 실측 지연. 채널·엔진이 측정한 값만 넣는다 — 기본값 금지(§13-3). */
  latency?: LatencyMs;
  /** §11.2 과금 근거. 엔진 단위 차이는 어댑터가 환산해 채운다(§6.2). */
  usage?: UsageMetrics;
  /** 인식 신뢰도(음성·채팅 NLU). 없으면 폴백 판정에서 신뢰도 조건을 건너뛴다. */
  confidence?: number;
}

/** Core가 채널에게 돌려주는 실행 결과. 채널은 steps를 자기 표현으로 바꿔 내보내기만 한다(§5.3). */
export interface ChannelTurnResult {
  interactionId: string;
  state: FlowState;
  steps: RenderedStep[];
  status: RunStatus;
  /** 이번 턴에 발생한 §8.1 이벤트. 채널이 만들지 않는다 — Core가 만들고 채널은 전송만 돕는다. */
  events: InteractionEvent[];
  /** §9.3 판정. 채널은 이 값에 따라 회선을 내리거나 상담사로 넘긴다. */
  fallback?: FallbackDecision;
  /**
   * 이관 정보. `placement` 는 Core 에 라우팅이 배선된 경우에만 실린다(§2).
   * `placement.placement !== 'queued'` 면 **큐에 사람이 들어가지 않았다** — 채널은
   * `action`(콜백·음성사서함·기존 IVR)을 수행해야 하며, 상담사 연결 안내를 해서는 안 된다(§9.3).
   */
  handoff?: { queue?: string; summaryMasked?: string; placement?: HandoffPlacement };
  /**
   * §5.2 채널 전환 초대가 이번 턴에 일어났다는 사실(`SwitchInviteNote` 주석).
   * Node 호스트는 `port.invite` 로 이미 같은 지시를 받으므로 **되풀이가 아니라 근거**이고,
   * 브리지(비-Node 호스트)에는 **이것이 유일한 경로**다.
   */
  switchInvite?: SwitchInviteNote;
  /**
   * 이번 턴에 AI 고지를 냈다는 사실(§10.1). 고지 문구 자체는 `steps` 맨 앞 단계에 실려 나간다 —
   * 여기 있는 것은 **감사 근거**(어느 매체에 어떤 버전으로 고지했는가)다. 호스트가 steps 를
   * 뒤져 찾아내게 두면 세 저장소가 각자 다르게 찾는다(§2).
   * 고지가 배선되지 않았거나 이미 고지한 채널이면 실리지 않는다.
   */
  disclosure?: { channel: ChannelKind; placement: DisclosurePlacement; configVersion: number };
  /**
   * §11.2 과금 근거가 이번 호출에서 **어디까지 실렸는가**. 아무 선언도 없었으면 실리지 않는다.
   *
   * 채널이 반드시 읽어야 하는 값이다 — `usageAttached: false` 인 실측과 `billableMsRecorded: false`
   * 인 통화 구간은 §8.1 원장에 **없다**. 즉 그 호의 엔진 비용·통화 시간은 공급사 청구서에만 남고
   * 우리 집계에는 없으며, 그 차이는 몇 주 뒤 대사(reconcile)에서 '미설명'으로 돌아온다.
   */
  billing?: TurnBillingNote;
  /**
   * §10.1 동의. 동의가 배선되지 않았으면 실리지 않는다(종전과 완전히 같다).
   *
   * `recorded` 는 **이번 턴에 확정돼 추가 전용 이력에 쌓인 동의**다. 동의 질문 자체는 시나리오의
   * `Confirm` 단계로 이미 나갔으므로 여기 있는 것은 감사 근거(어느 목적을 어떤 정책 버전으로
   * 받았는가)다. 호스트가 슬롯을 뒤져 찾아내게 두면 세 저장소가 각자 다르게 찾는다(§2).
   *
   * `pendingRequired` 는 필수로 선언됐는데 지금 `granted` 가 아닌 목적이다. **Core 는 이 값으로
   * 막지 않는다** — 거부 분기는 시나리오(`onNo`)와 테넌트가 정한다. 다만 이 목록이 비어 있지
   * 않은 동안 pii 파라미터를 선언한 업무시스템 조회(§6.1)는 동의 게이트에서 막힌다.
   */
  consent?: {
    recorded?: { purpose: ConsentPurpose; state: 'granted' | 'denied'; policyVersion: number };
    /** 확정된 답이 있었는데 기록하지 못한 사유. 정상 생략(동의 턴이 아님·확정 전)에는 실리지 않는다. */
    notRecordedKo?: string;
    pendingRequired?: ConsentPurpose[];
  };
  /**
   * §7 5.2 준수 점검 결과. **세션이 끝난 호출에만** 실린다(점검은 세션 전체를 한꺼번에 본다) —
   * 점검이 배선되지 않았으면 실리지 않는다(종전과 완전히 같다).
   *
   * 여기 있는 것은 **위반 요약**이다: 근거 이벤트 id·검출 표현·금칙어 문구는 싣지 않는다 —
   * 이 값은 고객 접점 프로세스까지 나가고, 금칙어 목록은 운영·리뷰 화면의 자료다(§2·§10.3).
   * 전문(`QaReport`)이 필요한 쪽은 Core 배선의 `onReport` 로 받는다.
   *
   * `reviewed: false` 는 **위반 0건이 아니다** — 점검을 수행하지 못했다는 뜻이고 사유가 함께 실린다.
   * 같은 이유로 `skipped` 가 비어 있지 않은 규칙은 합격이 아니다.
   */
  compliance?: ComplianceTurnNote;
  /**
   * §6.1 Api 대기에 되돌려준 조회 결과가 **반영됐는가**. `connectorResult` 입력이 아닌 턴에는
   * 실리지 않는다(`ConnectorResultNote` 주석).
   */
  connector?: ConnectorResultNote;
}

/**
 * 호스트가 되돌려준 §6.1 조회 결과의 처리 사실. 사실만 적는다 — 보정·추정이 없다(§13-3).
 *
 * 왜 이 칸이 필요한가: 커넥터 결과는 **반영되지 않아도 오류가 아니다**. Runner 는 Api 대기가
 * 서 있지 않은 상태에서 온 결과를 늦게 도착한 응답으로 보고 조용히 버리고(멱등, §8.1), 그
 * 턴의 응답은 `steps` 0건·`events` 0건이며 `ok: true` 다. 비-Node 호스트에는 그 구분이 도착할
 * 자리가 없었다 — 호스트는 조회 결과가 들어갔다고 읽고 다음 발화를 기다리는데, 고객 쪽에서는
 * 아무 안내도 나오지 않는다. 증상은 예외가 아니라 **무음**이고 "그 메뉴만 안 된다"로만 나타난다.
 *
 * `resultApplied: true` 인데 `pendingConnectorId` 가 함께 있으면 **다음 대기가 섰다는 뜻**이다
 * (Api 노드가 연달아 있는 시나리오) — 호스트는 그 id 로 한 번 더 답해야 한다.
 */
export interface ConnectorResultNote {
  /** 이 결과가 서 있던 대기에 반영됐는가. */
  resultApplied: boolean;
  /** 반영하지 않은 사유(한국어). 반영했으면 실리지 않는다. */
  reasonKo?: string;
  /** 이 호출이 끝난 뒤 **지금 서 있는** 대기 id. 없으면 실리지 않는다. */
  pendingConnectorId?: string;
}

/**
 * §5.2 채널 전환 초대가 **이번 턴에 일어났다는 사실**. 전환이 없던 턴에는 실리지 않는다.
 *
 * 왜 결과에도 실어야 하는가: Core 는 전환을 감지하면 `port.invite` 로 채널에게 링크 발송을
 * 시킨다 — 그 경로는 **Node 호스트에만 있다**. 비-Node 호스트(Callbot 파이썬 에이전트)가
 * Core 에 닿는 길은 JSONL 브리지뿐이고, 브리지에는 이 사실을 실어 보낼 자리가 없었다.
 * 그래서 그 배치에서는 전환이 **조용히 반쪽만** 일어났다: `state.channel` 은 화면으로 바뀌어
 * 이후 단계가 화면용으로 렌더되는데(고객은 통화 중이라 그것을 듣는다), **링크는 아무도 보내지
 * 않는다**. 고객은 오지 않는 화면을 기다리고 통화는 그대로 끝나며 — §5.1 사다리는 이미 전환을
 * 골랐으므로 상담사로 내려가지도 않는다. 어디에서도 예외가 나지 않는다.
 *
 * **토큰은 기본적으로 나가지 않는다**(§10.3): 1회용 합류 토큰은 진행 중인 세션의 열쇠이므로
 * 상담사용 요약과 같은 규칙으로 다룬다 — 링크를 직접 만들어야 하는 소비자만 받는다
 * (브리지의 `includeSwitchTicket`). 사실·만료·사유는 개인정보가 아니므로 그대로 나간다:
 * 감추면 호스트는 "링크를 보낼 차례인지"도, "보낼 수 없는 상태인지"도 알 수 없다.
 */
export interface SwitchInviteNote {
  fromChannel: ChannelKind;
  toChannel: ChannelKind;
  /** 1회용·만료 토큰이 발급됐는가. false 면 **링크의 열쇠가 없다**(사유는 `notIssuedKo`). */
  ticketIssued: boolean;
  /** 발급된 티켓의 만료(ISO8601). 채널이 "이 링크는 N분 뒤 만료"를 안내할 수 있게 함께 준다. */
  expiresAt?: string;
  /**
   * 토큰 없이 초대한 **종전 경로**(Core 에 채널 전환 배선이 없다). 링크에 실릴 값이
   * Interaction id 뿐이라 1회용·만료·회수가 없다 — 등록 시 경고로도 남아 있다.
   */
  tokenless?: boolean;
  /** 티켓이 없는 사유(운영·감사용). 고객 문안이 아니며 토큰은 실리지 않는다(§10.3). */
  notIssuedKo?: string;
  /**
   * 초대 **지시가 매체에 접수되지 않은** 사유(§5.2·§9.3). 접수됐으면 실리지 않는다.
   *
   * 왜 발급 사유와 따로 적는가: `notIssuedKo` 는 "열쇠를 만들지 못했다"이고 이 칸은
   * **"열쇠는 만들었는데 링크가 나가지 않았다"**다 — 고칠 곳이 다르다(앞은 전환 배선·
   * 수신 확인, 뒤는 그 시각의 발송 경로다). 둘을 같게 적으면 운영은 발급 설정을 뒤지는데
   * 실제로 죽은 것은 SMS·알림톡 게이트웨이다.
   *
   * 이 칸이 없던 동안 포트의 거부는 **턴을 통째로 예외로 끝냈다**: 세션은 이미 화면 채널로
   * 바뀌고 이벤트도 발행됐는데 그 턴의 단계·이관·종료 지시는 **아무것도 나가지 않았다**
   * (`channels/runtime.ts` 의 `deliverSwitchInvite` 주석). 포트 메서드의 반환은 "지시를
   * 접수했다"까지만 뜻하므로 거부는 접수되지 않았다는 뜻이고, 그 사실은 사유로 남는다.
   */
  notDeliveredKo?: string;
  /**
   * 1회용 합류 토큰. **Core 내부·Node 포트 경로에서만 채워진다** — 와이어로 내보내는 쪽은
   * 노출 스위치를 지나야 한다(§10.3). 세션에 보관되는 복사본에서는 제거된다(재발급 없이
   * 같은 토큰이 다음 응답에 다시 실리면 1회용이 무의미해진다).
   */
  token?: string;
}

/**
 * 세션 종료 시 채널이 넘기는 과금 근거(§11.2). 전부 생략 가능하며, 생략하면 종전과 완전히 같다.
 *
 * 왜 종료 시점에만 받는가: 통화 과금 구간은 끊긴 뒤에야 확정된다. 그런데 `session.ended` 는
 * 추가 전용 이벤트라 **나중에 고쳐 넣을 수 없다** — 그래서 종료를 지시하는 그 호출에서 함께 받는다.
 * 받을 자리가 없던 동안 `billable_ms` 를 채우는 코드는 저장소에 0건이었고, 그 결과 모든 음성 세션이
 * `sessionsMissingBillableMs`(실측 누락)로 집계돼 **통화 요금의 근거가 아예 없었다**.
 */
export interface ChannelEndInput {
  /**
   * 과금 대상 구간(ms). 대기·호 설정 구간을 포함할지는 **계약 사항**이므로 채널이 계약대로 채운다 —
   * Core 는 세션 전체 길이(`duration_ms`)로 대체 추정하지 않는다(§13-3). 측정하지 못했으면 **넣지 않는다**:
   * 0 은 "0초 통화를 실측했다"는 뜻이고, 누락과 0 을 같게 적는 것이 정산 분쟁의 출발점이다.
   */
  billableMs?: number;
}

/**
 * Core가 채널에게 요구하는 능력. 채널마다 되는 게 다르므로 선언하게 한다.
 * Flow 검증기(§5.3)가 이 값으로 "이 시나리오를 이 채널에서 돌릴 수 있는가"를 사전 판정한다.
 */
export interface ChannelCapabilities {
  adapter: ChannelAdapterId;
  channel: ChannelKind;
  /** DTMF 입력 수용(음성 전용, §5.1 소음·고령 고객 폴백) */
  dtmf: boolean;
  /** 버튼·폼 등 화면 UI 렌더 */
  richUi: boolean;
  /** 음성 합성 출력 */
  speech: boolean;
  /** 상담사 이관 실행 가능 여부 */
  transferToAgent: boolean;
  /** 기존 IVR로 되돌릴 수 있는가(§9.3) */
  routeToLegacyIvr: boolean;
  /** 통화 중 다른 채널로 링크를 보낼 수 있는가(§5.2 voice→visual 전환) */
  crossChannelInvite: boolean;
}

/** 채널이 Core에 제공해야 하는 헬스 신호(§9.3). Core는 엔진을 직접 찌르지 않는다(§6.2). */
export interface ChannelHealthReport {
  adapter: ChannelAdapterId;
  samples: HealthSample[];
  observedAt: string;
}

/**
 * 헬스 보고가 **실제로 접수된 범위**(§9.3·§13-3).
 *
 * 왜 돌려주는가: Core 는 등록되지 않은 채널의 보고와 **선언하지 않은 컴포넌트**의 샘플을
 * 무시한다(아무 채널이나 전체 폴백을 유발할 수 없게 하는 §9.3 의 규칙이다). 그런데 그
 * 사실이 호출자에게 돌아가지 않던 동안, 샘플을 성실히 올리는 채널과 **한 건도 전달되지
 * 않는 채널이 바깥에서 구분되지 않았다**. 증상은 전부 조용하다 — 엔진이 전부 죽어도
 * §9.3 판정은 `normal` 이고(고객은 "말을 못 알아듣는다"로 겪는다), 한 번 내려간 테넌트는
 * 샘플이 갱신되지 않아 **영구히** 폴백에 남는다. 어느 쪽도 예외를 던지지 않는다.
 *
 * 되돌려 적지 않는 것: **호스트가 보낸 컴포넌트 이름**이다(§10.3 — 그 자리에는 임의
 * 문자열이 들어올 수 있다). 대신 Core 가 가진 선언 목록(`declared`)을 주어 오타를 호스트가
 * 스스로 맞춰 볼 수 있게 한다.
 */
export interface HealthIntakeReceipt {
  /** 이 어댑터가 Core 에 등록돼 있는가. false 면 **한 건도** 기록되지 않았다. */
  registered: boolean;
  /** 올린 샘플 수(실측). */
  offered: number;
  /** §9.3 헬스 레지스트리에 실제로 기록된 샘플 수. */
  accepted: number;
  /** 선언되지 않은 컴포넌트라 무시한 샘플 수. */
  ignored: number;
  /** 이 채널이 올릴 수 있다고 **등록 시 선언한** 컴포넌트(Core 가 가진 값). */
  declared: ComponentId[];
}

/**
 * 채널 저장소가 구현하는 아웃바운드 포트 — Core가 채널에게 시키는 일.
 * 반환값은 "지시를 접수했다"까지만 뜻한다. 실제 매체 동작 결과는 헬스·이벤트로 돌아온다.
 */
export interface ChannelPort {
  readonly id: ChannelAdapterId;
  readonly capabilities: ChannelCapabilities;
  /** 렌더된 단계를 고객에게 내보낸다. */
  present(interactionId: string, steps: RenderedStep[]): Promise<void>;
  /** 상담사 이관. 요약은 이미 마스킹된 상태로 전달된다(§2·§10.3). */
  transfer(interactionId: string, queue: string | undefined, summaryMasked: string | undefined): Promise<void>;
  /** 기존 IVR 회귀(§9.3). routeToLegacyIvr=false 인 채널은 구현하지 않아도 된다. */
  routeToLegacyIvr?(interactionId: string, reasonKo: string): Promise<void>;
  /**
   * 다른 채널 초대(§5.2). crossChannelInvite=false 면 미구현.
   *
   * `ticket` 은 Core 에 채널 전환이 배선된 경우에만 실린다. **실리면 링크에는 그 토큰을 쓴다** —
   * `interactionId` 로 링크를 만들면 1회용·만료·회수가 전부 무의미해진다(다른 경로로 같은 문이 열린다).
   * 배선이 없으면 `ticket` 은 `undefined` 이며, 그 상태의 전환 링크는 **id 가 곧 열쇠**다(§10.3).
   * 모르는 인자를 받아도 던지지 않아야 한다 — 배선을 켜는 일은 코드 배포가 아니라 설정 변경이다.
   */
  invite?(interactionId: string, target: ChannelKind, ticket?: SwitchTicket): Promise<void>;
  end(interactionId: string, reasonKo: string): Promise<void>;
}

/**
 * Core가 채널에게 제공하는 인바운드 포트 — 채널이 Core에게 시키는 일.
 * 채널 저장소는 이 인터페이스 외의 Core 함수를 직접 호출하지 않는다. 그래야 Core 리팩터링이
 * 채널 3개를 동시에 깨뜨리지 않는다.
 */
export interface ConversationCorePort {
  readonly contractVersion: number;
  start(req: ChannelSessionRequest): Promise<ChannelTurnResult>;
  send(interactionId: string, turn: ChannelTurnInput): Promise<ChannelTurnResult>;
  /**
   * 고객이 끊음·이탈. Outcome 확정은 Core가 §4.1 규칙으로 판정한다.
   *
   * `input` 은 선택이며 §11.2 과금 근거를 함께 넘기는 자리다. 넘기지 않으면 종전과 완전히 같다 —
   * 다만 그 세션은 통화 분 집계에서 빠지고 `sessionsMissingBillableMs` 로만 남는다. 값이 실렸는지는
   * 결과의 `billing` 에 사실대로 적힌다(무효값은 종료를 막지 않는다 — 막으면 세션이 샌다).
   */
  end(interactionId: string, reasonKo: string, input?: ChannelEndInput): Promise<ChannelTurnResult>;
  /**
   * 헬스 보고 — 채널이 주기적으로 올린다(§9.3).
   *
   * 반환값은 **접수 범위**(`HealthIntakeReceipt`)다. 종전 구현처럼 `void` 를 돌려줘도
   * 계약 위반이 아니다 — 다만 그 구현을 쓰는 호스트는 자기 샘플이 §9.3 판정에 닿았는지
   * 알 길이 없고, 그 상태를 "접수됨"으로 **적어서는 안 된다**(§13-3, `HealthIntakeReceipt` 주석).
   */
  reportHealth(report: ChannelHealthReport): HealthIntakeReceipt | void;
}

/** 채널이 Core에 등록될 때 넘기는 묶음. Core는 이 값만 보고 채널을 다룬다. */
export interface ChannelRegistration {
  port: ChannelPort;
  /** 이 채널이 신호를 올리는 컴포넌트 목록(§9.3). 선언하지 않은 컴포넌트의 샘플은 무시한다. */
  reportsComponents: ComponentId[];
  contractVersion: number;
}

export type ContractIssueCode =
  | 'E_VERSION_MISMATCH'
  /**
   * 포트가 밝힌 어댑터 id 가 **계약 밖**이다(오타·삭제된 id, §2·§5.3).
   *
   * 이 판정이 없던 동안 그 포트는 등록도 되고 **적합성 게이트도 통과했다**. 모르는 id 는
   * `profileFor` 에서 `{ adapter: '오타', channel: undefined }` 라는 반쪽 능력 선언을 받고,
   * 그러면 아래 채널 어긋남 검사가 `undefined !== undefined` 로 거짓이 되어 지나간다 —
   * 그 상태의 적합성 보고는 `[오타/undefined] 통과(오류 0)` 다. 능력 전부가 거짓이므로
   * 전환 초대·기존 IVR 회귀 검사는 **"해당 없음"** 으로 적히고(선언하지 않은 채널과 같은
   * 모양이다), 검사 단계는 `channel: undefined` 로 렌더돼 매체 모양을 한 번도 보지 않는다.
   * 즉 **CI 는 초록인데 확인된 것이 없다** — 브리지는 같은 오타를 기동 시점에 거절한다(§2).
   *
   * 되돌릴 수 있는 쪽은 등록 거절이므로 error 다(`E_FOREIGN_COMPONENT` 와 같은 저울).
   */
  | 'E_UNKNOWN_ADAPTER'
  | 'E_CHANNEL_MISMATCH'
  | 'E_MISSING_CAPABILITY_IMPL'
  | 'E_UNDECLARED_COMPONENT'
  /**
   * 아는 컴포넌트이긴 하나 **이 채널의 §9.3 의존 목록 밖**이다. 헬스 레지스트리는 테넌트당
   * 한 벌이므로, 그 선언을 통과시키면 이 채널의 샘플이 다른 채널의 폴백 판정을 내린다.
   */
  | 'E_FOREIGN_COMPONENT'
  | 'W_NO_FALLBACK_PATH'
  /** 재프롬프트 정책이 비어 있어 실패 시 원문이 그대로 재생된다(§5.1). 금지는 아니지만 운영이 알아야 한다. */
  | 'W_REPROMPT_POLICY'
  /** 턴 타이밍이 선언되지 않아 채널이 각자의 대기 시간을 쓴다(§5.1). */
  | 'W_TURN_TIMING'
  /**
   * 교차채널 초대를 할 수 있는 채널이 등록됐는데 전환 배선이 없다(§5.2·§10.3).
   * 이 상태의 합류는 **Interaction id 하나로 통과**하므로, 링크를 본 사람은 누구나
   * 진행 중인 상담 화면을 열 수 있다. 금지는 아니지만(종전 동작) 운영이 반드시 알아야 한다.
   *
   * **같은 코드가 통화 중에도 난다**(`W_FALLBACK_LEGACY_IVR` 과 같은 규칙): 전환 초대를
   * 발급하지 못한 경우 · 수신 가능 확인(`reachable`)이 예외로 끝난 경우 · 발급은 됐는데
   * **초대 지시가 매체에서 거부된 경우**(발송 경로 장애)다. 마지막 것은 고객이 링크를
   * 받지 못한 유일한 신호이며, 세션은 이미 화면 채널로 옮겨 가 있다 — 사유는 턴 결과의
   * `switchInvite.notDeliveredKo` 에도 함께 남는다(비-Node 호스트가 읽는 자리다, §5.2).
   */
  | 'W_CHANNEL_SWITCH_UNBOUND'
  /** 고지 설정은 실렸으나 일부 채널 문구가 비어 있는 등, 막지는 않되 운영이 알아야 하는 상태(§10.1). */
  | 'W_AI_DISCLOSURE'
  /**
   * AI 고지가 배선되지 않았다(§10.1·§7 7.4). 이 상태에서는 **어떤 채널에서도 고지가 나가지 않는다** —
   * 통화는 정상으로 끝나고 이벤트도 정상이라 어디서도 터지지 않는다. 종전 동작이므로 막지는 않되
   * 조용히 두지도 않는다: 드러나는 시점이 감독기관 점검이면 이미 지나간 통화 전부가 대상이다.
   */
  | 'W_AI_DISCLOSURE_UNBOUND'
  /**
   * 인텐트 진입 노드가 있는 시나리오를 인텐트 배선 없이 시작했다(§5.1·§5.3).
   * 이 상태에서 고객의 답은 인텐트가 아니라 **슬롯 값**으로 저장된 채 흐름이 진행된다 —
   * 예외도 재프롬프트도 없어 "봇이 엉뚱한 안내를 한다"로만 나타난다.
   */
  | 'W_INTENT_UNBOUND'
  /**
   * 지식 응대 진입 노드가 있는 시나리오를 지식 배선 없이 시작했다(§5.2).
   * 이 상태에서 고객의 질문은 답변 대신 **슬롯 값**으로 저장되고 흐름은 그대로 넘어간다 —
   * 즉 **아무도 답하지 않는다**. 예외도 재프롬프트도 없어 "FAQ 가 안 되는 것 같다"로만 나타난다.
   */
  | 'W_KNOWLEDGE_UNBOUND'
  /**
   * 엔진은 기동 선언으로 배선됐는데 지식 응대 구성요소(검색기·답변기)를 **호스트가 조립했다**
   * (§5.2·§6.2·§9.3). 그 조각에는 재시도·대체·헬스 기록이 붙지 않으므로, 임베딩·LLM 이 전부
   * 타임아웃인 상태에서도 §9.3 판정은 `normal` 이고 폴백은 걸리지 않는다. 증상은 장애가 아니라
   * **모든 질문이 "안내드릴 내용이 없습니다"로 끝나는 것**이다 — 지식베이스·업무시스템은 멀쩡하고
   * 대시보드도 초록이라, 드러나는 경로가 고객 민원뿐이다.
   * 종전 동작이므로 막지는 않되(호스트 조립이 유일한 경로인 테넌트가 있다) 조용히 두지 않는다.
   */
  | 'W_KNOWLEDGE_PARTS'
  /**
   * 라우트가 없는 활성 인텐트가 있거나, 통화 중 확정된 인텐트에 연결된 시나리오가 없었다(§5.3).
   * 막지는 않되(이관으로 살린다) 드러낸다 — 설정 누락은 "봇이 못 알아듣더라"와 구분되어야 한다.
   */
  | 'W_INTENT_ROUTING'
  /**
   * 시나리오 조회에 채널별 배포본 경로가 없다(§5.3). 이 상태에서는 버전 선택이 **stage 와
   * 무관하게 가장 높은 번호**로 이루어지므로, 스튜디오 편집본(draft)이 저장되는 순간 신규
   * 통화에 나갈 수 있고 승인·검증 게이트와 채널별 롤백이 런타임에 닿지 않는다.
   * 종전 동작이므로 막지는 않되, 배포를 Core 밖에서 관리한다는 사실의 기록으로 남긴다.
   */
  | 'W_FLOW_DEPLOYMENT_UNBOUND'
  /**
   * 라우트가 가리키는 시나리오가 특정 채널에 배포되지 않았거나(단계적 배포 중일 수 있다),
   * 채널이 배포본이 아닌 지정 버전으로 실행했거나, 배포 기록과 리비전 단계가 어긋났다(§5.3).
   * 전부 막지 않는 상태이지만 **아무도 모르는 채로 돌아가서는 안 되는** 상태다.
   */
  | 'W_FLOW_NOT_DEPLOYED'
  /**
   * §10.1 동의가 배선되지 않았다. 이 상태에서 일어나는 일은 두 방향 모두 조용하다:
   * 시나리오가 동의를 **묻고 있어도** 고객의 "네"는 `Confirm` 슬롯 값으로만 남아 **동의 기록은
   * 0건**이고(점검·분쟁에서 필요한 것은 목적·버전·시각이 적힌 기록이다), 개인정보 파라미터를
   * 선언한 업무시스템 조회(§6.1)는 동의 컨텍스트가 없어 **통화 중 언제나 막힌다**(업무시스템은
   * 멀쩡하므로 장애로 보이지 않고 "그 메뉴만 안 된다"로 나타난다).
   * 종전 동작이므로 막지는 않되 조용히 두지도 않는다.
   */
  | 'W_CONSENT_UNBOUND'
  /**
   * 동의는 배선됐으나 어긋난 것이 있다(필수 목적을 묻는 노드가 시나리오에 없는 등, §10.1).
   * 막지는 않되 운영이 반드시 보아야 한다 — 그 상태에서는 필수 동의가 영원히 미획득이다.
   */
  | 'W_CONSENT'
  /**
   * 동의는 배선됐는데 **고지 문안 등록부**(`consent.legal`)가 없다(§10.1). 이 상태에서는
   * `legal/documents.ts`(확정본 조회·자리표시자 검사·재수락 판정)가 저장소에 있으나 **통화
   * 경로에서 한 번도 조회되지 않는다** — `decideLegalBasis` 는 언제나 "문안을 확인하지 않았다"로
   * 적고, 그 기록은 "확인했고 문제없었다"와 바깥에서 구분되지 않는다.
   *
   * 그래서 통과하는 것들: 초안 문안(`{{회사명}}` 이 박힌 채)으로 받은 동의 · 시행일 전 문안으로
   * 미리 받은 동의 · 처리방침이 개정됐는데 정책 버전이 그대로라 여전히 `granted` 인 동의.
   * 셋 다 예외도 장애도 아니고 동의 이력에는 정상으로 쌓인다 — 드러나는 시점이 분쟁·점검이면
   * 그 기간에 받은 동의 **전부**가 대상이다. 종전 동작이므로 막지는 않되 조용히 두지 않는다.
   */
  | 'W_LEGAL_UNBOUND'
  /**
   * 등록부는 배선됐는데 동의 정책이 가리키는 고지 문안에 어긋난 것이 있다(§10.1):
   * 참조 누락·형식 오류·문서 없음·초안만 있음·시행일 전·버전 불일치, 또는 예약 형식이 아니라
   * **확정 여부를 확인할 수 없는** 참조.
   *
   * 막지 않는다: 문안 하나가 미확정이라는 이유로 Core 가 기동을 거부하면 전 채널이 멈추고,
   * 그 결정은 Core 가 할 일이 아니다(§13-3). 대신 **첫 통화보다 먼저** 적는다 — 그 목적이
   * 필수라면 통화 중 개인정보 조회(§6.1)는 `legal_notice_not_final` 로 막히는데, 업무시스템은
   * 멀쩡하므로 장애로 보이지 않고 "그 메뉴만 안 된다"로 나타난다.
   */
  | 'W_LEGAL_NOTICE'
  /**
   * §7 5.2 준수 점검이 배선되지 않았다. 이 상태에서는 **어떤 세션도 점검되지 않는다** —
   * 고지 누락(§10.1)·금칙 표현·마스킹 누락(§10.3)이 한 건도 집계되지 않는데, 리포트가
   * 비는 것이 아니라 **리포트 자체가 없어서** "점검이 돌고 있다"와 구분되지 않는다.
   * 종전 동작이므로 막지는 않되 조용히 두지도 않는다: 드러나는 시점이 감독기관 점검이면
   * 이미 지나간 통화 전부가 대상이다.
   */
  | 'W_QA_UNBOUND'
  /**
   * 점검은 배선됐으나 어긋난 것이 있다(고지 표식·금칙어 미등록, 적용되지 않는 규칙 등).
   * 막지는 않되 운영이 반드시 보아야 한다 — 그 항목은 합격이 아니라 **점검되지 않는다**.
   */
  | 'W_QA'
  /**
   * 복구 프로브가 배선되지 않았다(§9.3). **폴백에서 빠져나오는 길이 없다** —
   * L2 가 `down` 으로 판정되면 런타임이 모든 세션을 IVR·상담사로 내리고, 그러면 엔진을 부르는
   * 일 자체가 멈춰 새 샘플이 영영 생기지 않는다. 그 다음은 정책에 따라 둘인데 둘 다 틀렸다:
   * 보수적 테넌트(`treatUnknownAsDown`)는 엔진이 5분 만에 살아나도 **사람이 손대기 전까지
   * 영구 상담사 직결**이고, 아닌 테넌트는 샘플이 낡았다는 이유만으로 **증거 없이** AI 를
   * 재개한다(고객이 대신 확인해 주는 셈이다). 실프로브 연결은 **[승인 필요]**.
   */
  | 'W_RECOVERY_UNBOUND'
  /**
   * Api 노드 대기가 섰는데 커넥터 이행 배선(`connectors`)이 없다(§6.1). 호스트가 직접
   * 업무시스템을 불러 `connectorResult` 로 되돌려주는 경로가 종전 동작이므로 막지는 않되,
   * 그 경로를 짜지 않은 호스트에서 증상은 예외가 아니라 **무음**이다 — 고객이 무슨 말을
   * 해도 `steps` 0건·`events` 0건이 나가고 어떤 알림도 울리지 않는다. 적합성 검사·이벤트·
   * 헬스가 전부 정상이라 "그 메뉴만 안 된다"로만 나타나고, 그래서 오래 산다.
   */
  | 'W_CONNECTOR_UNBOUND'
  /**
   * 호스트가 선언한 커넥터 id 가 **서 있는 Api 대기와 달라** 그 결과를 반영하지 않았다(§6.1).
   *
   * 선언이 없으면 이 경고가 날 자리도 없다(종전 동작). 선언을 받기 시작한 이유는 반영하는
   * 쪽의 실패가 조용하기 때문이다: Runner 는 Api 노드에 도착한 `connectorResult` 를 **어느
   * 커넥터의 답인지 묻지 않고** 수락하므로, 조회 A 의 결과가 늦게·중복으로 도착하면 그때 서
   * 있는 조회 B 의 답으로 적용된다. 전송 계층의 재시도 루프가 바로 그 모양을 만들고(같은 결과를
   * 두 번 보낸다) 시나리오는 Api 노드가 연달아 있는 조회형 흐름에서 흔하다. 그 뒤 고객은
   * **다른 조회의 값으로 채워진 안내**를 듣는다 — 슬롯은 그럴듯한 문자열이고 예외도 오류 응답도
   * 없어 누구도 눈치채지 못한다. 반영하지 않으면 대기는 그대로 서 있고 호스트는 다시 답할 수 있다.
   */
  | 'W_CONNECTOR_STALE'
  /**
   * 상담사 이관이 가능한 채널이 등록됐는데 큐 배정 배선(`routing`)이 없다(§2·§9.3).
   * 이 상태에서는 `selectQueue`·`admitToQueue` 가 **한 번도 돌지 않고**, 시나리오가 적어 둔
   * 큐 id 가 그대로 `transfer` 로 나간다. 그래서 업무시간이 끝난 큐·대기가 넘친 큐·오탈자
   * 큐에도 "상담사 연결 중"이 안내되고, 그 큐에 선언된 §9.3 대안(콜백·음성사서함·기존 IVR)은
   * 통째로 건너뛰어진다 — 고객은 아무도 없는 곳에서 기다리고, 끊기지도 않으므로 장애로
   * 잡히지 않는다. 종전 동작이므로 막지는 않되 조용히 두지 않는다.
   */
  | 'W_ROUTING_UNBOUND'
  /**
   * 큐 배정은 배선됐는데 **배정 오퍼**(`routing.offers`)가 없다(§2·§9.3). 큐에 놓는 데까지만
   * 되어 있으므로 `openOffer`·`settleOffer` 는 아무도 부르지 않고, 고객은 큐에 들어간 채
   * **어느 상담사에게도 제안되지 않는다**. 운영 화면에는 "대기 중"으로만 보이고 재배정 한도·
   * 응답 한도는 설정만 남는다. 호스트가 오퍼를 바깥에서 돌리는 것도 종전 동작이므로 막지는
   * 않되(상담사 데스크톱이 직접 큐를 읽는 테넌트가 있다) 그 경로에서는 회차 계수·중복 오퍼
   * 차단·소진 수렴이 전부 없다는 사실을 남긴다.
   */
  | 'W_AGENT_OFFER_UNBOUND'
  /**
   * 오퍼는 배선됐으나 실제 제안이 서지 않았다(후보 조회 실패·후보 없음·중복 id·재배정을 이어
   * 주지 못함). 막지는 않되(이관 자체는 이미 끝났다) 드러낸다 — 이 상태의 증상은 예외가 아니라
   * **큐에 묶인 고객**이고, 원인이 상담사 부재인지 설정·호스트 조회 결함인지는 구분되어야 한다.
   */
  | 'W_AGENT_OFFER'
  /**
   * 큐에 선언된 §9.3 대안을 **그 채널이 수행할 수 없다**. 큐가 닫히거나 수용을 거부하면
   * 고객이 가는 곳은 `closedAction` 이고, 그중 채널 계약에 대응하는 능력이 있는 것은
   * `legacy_ivr`(`capabilities.routeToLegacyIvr`) 하나다. 그 능력을 `false` 로 선언한 채널로
   * 들어온 이관이 그 큐에서 닫히면 Core 는 "기존 IVR 로 보내라"를 돌려주는데 채널은 그것을
   * **할 수 없다고 스스로 선언한 상태**다 — 결과는 예외가 아니라 **아무 일도 일어나지 않는
   * 것**이고, 고객은 안내도 대안도 없이 남는다(큐에 못 넣었으므로 `transfer` 도 부르지 않는다).
   *
   * 막지는 않는다: 그 큐가 음성만 받도록 `channels` 로 좁혀질 수 있고, 지금 그렇게 좁혀져
   * 있지 않은 것이 곧 오류라고 단정할 근거가 Core 에는 없다(§13-3). 대신 조합을 그대로 적는다 —
   * 이 결함은 평시에 전혀 드러나지 않고 **큐가 닫힌 시각에만**, 그것도 조용히 나타난다.
   * (`callback`·`voicemail` 은 채널 계약에 대응하는 능력이 없어 Core 가 검사할 수 없다 —
   * 그 둘은 호스트가 `placement.action` 을 보고 수행한다.)
   */
  | 'W_ROUTING_ALTERNATIVE'
  /**
   * §9.3 **장애 폴백 정책**이 기존 IVR 회귀를 쓸 수 있다고 선언했는데(`FallbackPolicy.legacyIvrAvailable`)
   * 그 채널은 `capabilities.routeToLegacyIvr` 를 `false` 로 선언했다. `W_ROUTING_ALTERNATIVE` 와
   * 모양은 같고 **출처가 다르다** — 저쪽은 큐 설정(`closedAction`)이고 이쪽은 폴백 정책이다.
   * 인지 계층(STT·TTS·LLM)이 `down` 이 되면 `decideFallbackMode` 는 `legacy_ivr` 을 내는데
   * 그 채널은 회선을 되돌릴 수 없으므로 Core 는 **상담사 이관으로 대신한다** — 판정과 실제 행동이
   * 갈라지는 유일한 자리다. 통화가 끊기지는 않으므로 장애로 잡히지 않고, 사후 분석에서는
   * `fallback.mode` 가 `legacy_ivr` 이라 "IVR 로 내렸다"로 읽힌다(아무도 내리지 않았다).
   *
   * 막지는 않는다(§13-3): 음성은 Callbot 이 회귀시키고 화면·채팅 채널은 애초에 회선이 없는
   * 구성이 정상일 수 있다. 다만 **그 조합에서는 `agentQueueAvailable`·`fallbackQueue` 가
   * 실질 폴백 경로**라는 사실을 등록 시점에 적는다 — 평시에는 전혀 드러나지 않는다.
   *
   * **같은 코드가 통화 중에도 한 번 더 난다**: 회귀 구현이 있는데 그 호출이 **거절**된 경우다
   * (회선·IVR 게이트웨이 장애). 포트 메서드의 반환은 "접수했다"까지만 뜻하므로 거부는
   * 접수되지 않았다는 뜻이고, Core 는 구현이 없을 때와 **같은 대체**(상담사 이관)를 한다 —
   * 대신하지 않으면 그 통화는 회귀도 이관도 없이 끝난다. 두 경우는 사유 문구로 갈린다
   * (고칠 곳이 다르다: 한쪽은 포트 구현, 한쪽은 그 시각의 회선이다).
   */
  | 'W_FALLBACK_LEGACY_IVR'
  /**
   * 엔진이 기동 선언으로 배선되지 않았다(§6.2·§9.3). 이 상태에서 엔진 실패는 §9.3 헬스
   * 레지스트리에 **한 건도** 들어오지 않는다 — 들어오는 샘플은 채널이 `reportHealth` 로
   * 올리는 것뿐이고, 채널이 올리는 것은 대개 자기 매체(telephony·messaging)다. 그래서
   * STT·LLM 이 전부 타임아웃인 상태에서도 폴백 판정은 `normal` 이고, 증상은 장애가 아니라
   * **턴마다 개별적으로 실패하는 통화**로 나타난다(고객은 "말을 못 알아듣는다"로 겪는다).
   * 호스트가 엔진을 바깥에서 조립해 포트만 주입하는 것도 종전 동작이므로 막지는 않되,
   * 그 경로에서는 재시도·대체·헬스 기록이 전부 없다는 사실을 남긴다.
   */
  | 'W_ENGINES_UNBOUND'
  /**
   * 엔진은 기동됐고 복구 프로브 러너도 배선됐는데 **엔진 컴포넌트에 프로브가 하나도 없다**(§9.3).
   * 이 상태는 (38)이 고친 래치와 같은 결말로 간다: 그 컴포넌트가 `down` 이 되면 통화가 IVR·
   * 상담사로 내려가 **엔진을 부르는 일 자체가 멈추고**, 새 샘플을 만들 주체가 프로브뿐인데 그
   * 프로브가 없다. 러너 보고서의 `unprobed` 로도 보이지만 그건 **이미 나빠진 뒤**다.
   * 막지는 않되(종전 동작) 첫 고객의 턴보다 먼저 드러낸다.
   */
  | 'W_ENGINE_PROBES_UNBOUND'
  /**
   * 엔진 복구 프로브를 선언했는데 일부 컴포넌트의 프로브가 **만들어지지 않았다**(§9.3·§13-3):
   * 승인 전(`dry_run` 은 언제나 성공하므로 `up` 을 적으면 폴백이 즉시 풀린다)·확인용 합성 입력
   * 미선언(Core 는 오디오·문장을 만들지 않는다)·그 슬롯이 후보에 없음. 돌아가지 않는 프로브를
   * 끼우지 않았으므로 **그 컴포넌트는 확인되지 않는다** — 사유와 함께 드러낸다.
   */
  | 'W_ENGINE_PROBES'
  /**
   * §8.2 보존 정책이 배선되지 않았다. 이 상태에서는 **저장해도 되는지 한 번도 묻지 않는다** —
   * `core/retention.ts` 의 저장 가능 판정(`canStore`)은 저장소에 있으나 아무도 부르지 않는다.
   * 증상은 예외가 아니라 **되돌릴 수 없음**이다: 기한이 정해지지 않은 분류의 데이터가 먼저 쌓이면
   * 기산 시점을 나중에 되돌릴 수 없고, 그동안 파기 판정은 그 건을 영구히 `blocked` 로 적는다 —
   * 파기 스윕은 매번 "지울 수 없는 건"만 세고 개인정보는 계속 남는다. 통화·이벤트·헬스가 전부
   * 정상이라 드러나는 시점이 감독기관 점검이면 대상은 **지나간 통화 전부**다.
   * 종전 동작이므로 막지는 않되 조용히 두지도 않는다.
   */
  | 'W_RETENTION_UNBOUND'
  /**
   * 채널이 **턴 단위로** 선언한 실측(`ChannelTurnInput.latency`·`confidence`)을 그대로 싣지
   * 못했다(§13-3·§5.1). 실을 자리가 없는 입력 종류(무입력·커넥터 결과)이거나, 같은 값이
   * 입력 쪽(`FlowInput`)에도 선언돼 **어긋난** 경우다 — 어느 쪽이 실측인지 Core 는 고르지
   * 않는다(§2). 막지 않는다: 실측 한 칸 때문에 통화를 끊을 일이 아니다. 다만 조용히 버리지도
   * 않는다 — 버리면 리포트에서 "측정하지 못했다"와 "선언했는데 유실됐다"가 구분되지 않는다.
   */
  | 'W_TURN_INPUT'
  /**
   * 보존 정책은 배선됐으나 Core 가 쓰는 분류 중 **보존 규칙이 없는 것**이 있다(§8.2).
   * 개인정보를 담지 않는 분류(이벤트·마스킹된 전문)는 막지 않는다 — 막으면 설정을 다 채우기
   * 전에는 통화 한 건도 받을 수 없다. 다만 그 분류는 **자동 파기 대상이 되지 않는다**:
   * 쌓이기는 하는데 기한이 없어 스윕이 집어 가지 않고, 용량으로만 나타난다.
   */
  | 'W_RETENTION_NO_RULE'
  /**
   * 호스트가 준 **보고 훅이 예외로 끝났다**(§6.2·§9.3). 사실은 그 호스트에 전달되지 않았지만
   * 통화는 계속된다.
   *
   * 왜 삼키는 쪽인가: 이 훅들은 전부 **알리는 자리**다(이벤트 발행 결과·동의 처리 사실·지식
   * 응대 결과·인텐트 이슈·§6.1 차단). 알림이 실패한 것을 통화 실패로 바꾸면, 터지는 자리가
   * 하필 **원장은 이미 썼고 매체에는 아무 지시도 가지 않은 지점**이다 — 그 턴의 `present`·
   * `transfer`·`end`·`invite` 는 전부 보고 뒤에 있다. 즉 §8.1 기록은 "이관했다"·"종료했다"로
   * 남고 회선은 올라간 채로 남는다(그 시간은 장애가 아니라 §11.2 요금이다).
   *
   * 더 나쁜 것은 **어느 턴에서 터지는가**다. `onIssue`·`onBlock` 은 고객의 말을 알아듣지
   * 못했을 때와 §6.1 조회가 막혔을 때만 불리므로, 그 훅이 깨진 호스트는 **정상 턴은 전부
   * 멀쩡하고 이미 나빠진 턴만** 통째로 잃는다 — 재현이 가장 어려운 모양이다.
   *
   * 이미 두 훅(`routing.offers.onStep`·`qa.onReport`)은 같은 이유로 삼키고 있었다. 나머지가
   * 예외였고, 이 코드는 그 규칙을 한 줄로 모은다 — 문구에 던져진 값을 싣지 않는다(§10.3,
   * 그리고 경고 목록이 호출 횟수만큼 늘지 않게 한다).
   */
  | 'W_HOST_REPORT';

export interface ContractIssue {
  code: ContractIssueCode;
  severity: 'error' | 'warning';
  messageKo: string;
}

/**
 * 등록 시점 계약 검증. 런타임에 "그 함수 없는데요"로 죽는 대신 여기서 막는다.
 * 폴백 경로가 하나도 없는 채널은 경고로 남긴다 — 금지는 아니지만 §9.3 관점에서 위험 신호다.
 */
export function validateRegistration(reg: ChannelRegistration): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const { port } = reg;

  if (reg.contractVersion !== CHANNEL_CONTRACT_VERSION) {
    issues.push({
      code: 'E_VERSION_MISMATCH',
      severity: 'error',
      messageKo: `채널 계약 버전 불일치: 채널 ${reg.contractVersion} ≠ Core ${CHANNEL_CONTRACT_VERSION}.`,
    });
  }
  if (port.capabilities.adapter !== port.id) {
    issues.push({ code: 'E_CHANNEL_MISMATCH', severity: 'error', messageKo: `capabilities.adapter(${port.capabilities.adapter})가 포트 id(${port.id})와 다릅니다.` });
  }
  // **모르는 id 를 먼저 거른다**(`E_UNKNOWN_ADAPTER` 주석). 아래 채널 어긋남 검사는 기대값이
  // 있을 때만 의미가 있다 — 모르는 id 의 기대값은 `undefined` 이고, 그러면 "undefined 여야
  // 합니다" 라는 문구와 함께 **능력 선언이 비어 있을 때만** 통과하는 검사가 된다.
  if (!isChannelAdapterId(port.id)) {
    issues.push({
      code: 'E_UNKNOWN_ADAPTER',
      severity: 'error',
      messageKo: `알 수 없는 채널 어댑터입니다: ${String(port.id)} — 가능한 값은 `
        + `${CHANNEL_ADAPTER_IDS.join('·')} 입니다. 모르는 id 의 능력 선언은 반쪽이고`
        + '(채널이 비어 모든 능력이 거짓이다) 그 상태의 적합성 검사는 아무것도 확인하지 못한 채 통과합니다(§5.3).',
    });
  } else if (port.capabilities.channel !== ADAPTER_CHANNEL[port.id]) {
    issues.push({ code: 'E_CHANNEL_MISMATCH', severity: 'error', messageKo: `${port.id} 어댑터의 채널은 ${ADAPTER_CHANNEL[port.id]} 여야 합니다.` });
  }
  if (port.capabilities.routeToLegacyIvr && typeof port.routeToLegacyIvr !== 'function') {
    issues.push({ code: 'E_MISSING_CAPABILITY_IMPL', severity: 'error', messageKo: 'routeToLegacyIvr 능력을 선언했으나 구현이 없습니다(§9.3).' });
  }
  if (port.capabilities.crossChannelInvite && typeof port.invite !== 'function') {
    issues.push({ code: 'E_MISSING_CAPABILITY_IMPL', severity: 'error', messageKo: 'crossChannelInvite 능력을 선언했으나 invite 구현이 없습니다(§5.2).' });
  }
  // 아는 컴포넌트 목록은 `COMPONENT_TIER` 하나에서 온다(§2) — 여기서 다시 적으면 컴포넌트가
  // 하나 늘어난 날 **이 검사만** 모르고, 그 컴포넌트를 올리는 채널은 등록 자체가 거부된다.
  const known = new Set<string>(COMPONENT_IDS);
  // 이 채널의 §9.3 의존 목록. `capabilities.channel` 로 본다 — 폴백 판정도 같은 값으로 돈다
  // (`channels/runtime.ts`). 어댑터와 어긋난 선언은 위에서 이미 E_CHANNEL_MISMATCH 다.
  const deps = CHANNEL_DEPENDENCIES[port.capabilities.channel] as readonly ComponentId[] | undefined;
  for (const c of reg.reportsComponents) {
    if (!known.has(c)) {
      issues.push({ code: 'E_UNDECLARED_COMPONENT', severity: 'error', messageKo: `알 수 없는 헬스 컴포넌트: ${String(c)}` });
      continue;   // 모르는 이름은 어느 채널의 의존 목록에도 없다 — 같은 값을 두 번 적지 않는다.
    }
    /**
     * **자기 채널이 의존하지 않는 컴포넌트는 올릴 수 없다**(§9.3).
     *
     * 헬스 레지스트리는 테넌트 하나당 **한 벌**이고 `decideFallbackMode` 는 거기서
     * 컴포넌트별 최신 샘플을 읽는다. 그래서 선언을 넓히면 그 채널이 **남의 채널 판정을
     * 내린다**: 챗봇이 `stt` 를 올릴 수 있게 되면 챗봇 쪽 오탐 하나로 **음성 전체가**
     * `agent_only`·`legacy_ivr` 로 떨어지고, 반대로 챗봇이 `stt: up` 을 계속 올리면
     * 진짜 STT 장애가 낡은 샘플 판정(`staleAfterMs`)에도 걸리지 않는다. 증상은 둘 다
     * 엔진 장애와 구분되지 않는다 — "아무 채널이나 전체 폴백을 유발할 수 없다"는 규칙은
     * 선언 **목록**을 보는 것만으로는 지켜지지 않고, 그 목록이 자기 의존 안에 있어야 한다.
     *
     * 막는 쪽을 등록 거부로 둔 이유: 되돌릴 수 있는 쪽은 기동 거절이고, 되돌릴 수 없는
     * 쪽은 이미 다른 채널의 통화를 폴백으로 떨어뜨린 시간이다.
     */
    if (deps !== undefined && !deps.includes(c)) {
      issues.push({
        code: 'E_FOREIGN_COMPONENT',
        severity: 'error',
        messageKo: `${port.id}(${port.capabilities.channel}) 채널이 의존하지 않는 컴포넌트를 헬스 보고 대상으로 선언했습니다: `
          + `${String(c)} — 이 채널이 올린 샘플이 그 컴포넌트에 의존하는 다른 채널의 §9.3 판정을 내립니다`
          + `(의존: ${deps.join('·')}).`,
      });
    }
  }
  if (!port.capabilities.transferToAgent && !port.capabilities.routeToLegacyIvr) {
    issues.push({ code: 'W_NO_FALLBACK_PATH', severity: 'warning', messageKo: '상담사 이관·기존 IVR 회귀가 모두 불가한 채널입니다. AI 장애 시 고객이 갈 곳이 없습니다(§9.3).' });
  }
  return issues;
}

/**
 * Flow가 이 채널에서 실행 가능한지 사전 판정(§5.3).
 * "하나의 Flow를 렌더러만 바꿔 실행한다"는 약속은, 렌더 불가 노드를 배포 전에 걸러야만 지켜진다.
 */
export function checkFlowSupported(flow: Flow, caps: ChannelCapabilities): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const node of Object.values(flow.nodes)) {
    if (node.kind === 'Transfer' && !caps.transferToAgent) {
      issues.push({ code: 'E_MISSING_CAPABILITY_IMPL', severity: 'error', messageKo: `Transfer 노드(${node.id})가 있으나 ${caps.adapter} 채널은 상담사 이관을 지원하지 않습니다.` });
    }
    if (node.kind === 'Choice' && !caps.richUi && !caps.dtmf) {
      issues.push({ code: 'E_MISSING_CAPABILITY_IMPL', severity: 'error', messageKo: `Choice 노드(${node.id})를 렌더할 입력 수단이 없습니다(버튼·DTMF 모두 불가).` });
    }
  }
  return issues;
}

/** 등록 가능 여부 — error 0건일 때만 채널을 붙인다. */
export function registrationOk(issues: ContractIssue[]): boolean {
  return issues.every((i) => i.severity !== 'error');
}
