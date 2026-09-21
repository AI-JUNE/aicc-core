// 채널 전환 실행 오케스트레이터 — 설계서 §5.2(통화 중 화면 전환)·§1.2(하나의 Interaction)·
// §9.3(장애 폴백)·§10.3(마스킹)·§11.1(테넌트·워크스페이스 격리)·§13-3(임의 기본값 금지).
//
// `core/channelSwitch.ts` 에는 조각이 다 있다 — 1회용 토큰 발급(`issueInvite`)·상환 판정(`checkRedeem`)·
// 레지스트리(`createInviteRegistry`)·세션 반영(`applyInvite`)·전환 가능 판정(`canSwitchToVisual`).
// 그런데 **저장소 전체에서 그 함수들을 부르는 곳이 테스트뿐이었다.** 실제 전환 경로인
// `channels/runtime.ts` 는 `port.invite(interactionId, target)` 로 **Interaction id 를 그대로** 채널에
// 넘기고, 합류(`joinInteractionId`)는 그 id 하나만 맞으면 통과시킨다.
// 즉 링크에 실리는 값이 곧 **진행 중인 세션의 열쇠**다. channelSwitch.ts 의 머리말이 막겠다고 적어 둔
// 사고가 정확히 그 상태로 열려 있었던 셈이다. 그래서 두 자리(발급·상환)를 여기 한 곳으로 모은다.
//
// 막는 사고는 취향이 아니라 정해져 있다.
//
//  1) **id 가 곧 열쇠가 된다.** interaction id 는 비밀이 아니다 — 링크 URL·브라우저 이력·프록시 로그·
//     상담 메모에 남고, 형태가 규칙적이라 추측도 된다. 그 값 하나로 합류가 되면 **이미 수집된 슬롯이
//     그려진 화면**이 남에게 열린다. 그래서 이 모듈이 내놓는 합류 자격은 **토큰**이며, 토큰이 id 를
//     포함하거나 id 가 토큰을 포함하면 **발급 자체를 거절한다**(그건 열쇠를 다시 id 로 되돌리는 것이다).
//  2) **전환 가능 여부를 묻지 않고 링크부터 만든다.** 화면을 받을 수 없는 고객에게 링크를 보내면
//     고객은 오지 않는 화면을 기다리고 통화는 그대로 끝난다 — §5.1 사다리가 통째로 건너뛰어진다.
//     그래서 판정(`canSwitchToVisual`)과 발급을 **한 함수로 묶는다**(감사 기록을 판정과 묶은 것과 같은 이유).
//  3) **거절을 성공으로 읽는다.** 결과에 토큰이 담기는 경우는 발급 성공 하나뿐이고, 거절 결과는
//     티켓 필드를 **아예 갖지 않는다**(executeHandoff 가 놓을 큐 id 를 하나만 둔 것과 같은 모양).
//  4) **토큰이 로그·오류 문구로 샌다.** `maskPii` 는 토큰을 모른다 — 한 번 오류 메시지에 실리면
//     그 로그를 읽을 수 있는 사람은 누구나 남의 상담에 합류할 수 있다. 그래서 이 모듈이 만드는 어떤
//     문구에도 토큰을 싣지 않고, 검사가 그 사실을 고정한다.
//  5) **승계 슬롯 값이 채널로 나간다.** 채널이 할 일은 링크를 만들어 보내는 것뿐이고 슬롯 값은
//     필요 없다(같은 Interaction 을 이어가므로 값은 이미 세션에 있다). 그래서 채널에 주는 티켓에는
//     **키 목록조차 없고** 토큰·목적지·만료만 있다(§10.3 최소 노출).
//  6) **거절 사유가 고객·외부로 그대로 나간다.** "존재하지 않는 토큰"과 "테넌트 불일치"를 구분해
//     알려주면 그 자체가 열거 공격의 힌트다. 사유 구분은 **운영·감사용**이며, 고객 문안은 만들지 않는다
//     (문안은 테넌트가 정한다, §13-3).
//
// **판정을 복사하지 않는다.** 만료·1회용·테넌트·목적지 채널 일치는 `checkRedeem`·레지스트리 하나에만
// 있고 여기서 다시 쓰지 않는다 — 두 곳이 서로 다른 규칙을 갖는 순간 §2 의 이중 관리가 재발한다.
// **기본값을 만들지 않는다.** 유효기간(ttlMs)·토큰 생성기·승계 allowlist 는 전부 주입이며, 없으면
// 설정 오류로 거절한다(§13-3). 특히 토큰 생성기를 Core 가 대신 만들면 추측 가능한 열쇠가 된다.
// **실발송을 하지 않는다.** SMS·푸시·알림톡 발신은 채널 저장소가 승인 후 붙인다 — [승인 필요].
import type { ChannelKind } from '../domain/types.ts';
import type { TenantScope } from './tenancy.ts';
import { assertTenantScope } from './tenancy.ts';
import type {
  ChannelInvite,
  InviteDeliveryKind,
  InviteRegistry,
  RedeemRejection,
  SlotCarryPolicy,
  SwitchReason,
  SwitchTargetChannel,
} from './channelSwitch.ts';
import { canSwitchToVisual } from './channelSwitch.ts';

export const CHANNEL_SWITCH_EXECUTION_CONTRACT_VERSION = 1;

/** 발급하지 못한 이유. 전부 **설정·상황 결함**이며 운영에 드러나야 한다. */
export type SwitchDenyCode =
  | 'E_NOT_SWITCHABLE'   // 전환 조건 불성립(채널 능력·목적지 가용성·고객 단말)
  | 'E_CONFIG_INVALID'   // 유효기간·토큰 생성기·승계 정책 결함
  | 'E_TOKEN_WEAK'       // 토큰이 비었거나 Interaction id 와 얽혀 있다
  | 'E_ISSUE_FAILED';    // 레지스트리 거절(토큰 중복 등)

/**
 * 채널에 넘기는 최소 정보. **승계 슬롯은 값도 키도 담지 않는다**(§10.3) —
 * 채널이 할 일은 이 토큰으로 링크를 만들어 보내는 것뿐이다.
 */
export interface SwitchTicket {
  token: string;
  interactionId: string;
  toChannel: SwitchTargetChannel;
  /** ISO8601. 채널이 "이 링크는 N분 뒤 만료"를 안내할 수 있게 함께 준다. */
  expiresAt: string;
}

export interface IssueSwitchParams {
  scope: TenantScope;
  interactionId: string;
  fromChannel: ChannelKind;
  toChannel: SwitchTargetChannel;
  reason: SwitchReason;
  delivery: InviteDeliveryKind;
  /** 1회용 토큰 발급기. 주입이다 — Core 가 만들면 추측 가능한 열쇠가 된다(§13-3·§10.3). */
  newToken: () => string;
  /** 발급 시각(ISO8601). 시계를 만들어 넣지 않는다(§13-3). */
  issuedAt: string;
  /** 유효기간(ms). 테넌트 운영값 — 기본값 없음(§13-3). */
  ttlMs: number;
  /** 승계 슬롯 allowlist. 목록에 없는 키는 초대에 실리지 않는다(§10.3). */
  carry: SlotCarryPolicy;
  /** 현재 세션 슬롯. 예약 슬롯(`__`)은 이 모듈이 먼저 걷어낸다. */
  slots?: Record<string, string>;
  /** 발신 채널이 교차채널 초대를 할 수 있는가(채널 계약 crossChannelInvite). */
  crossChannelInviteSupported: boolean;
  /** 목적지 채널을 지금 쓸 수 있는가(§9.3). 추정하지 않는다 — 호출자가 관측한 값. */
  targetChannelAvailable: boolean;
  /** 고객 단말이 링크를 받을 수 있다고 **확인**되었는가. 추정 금지 — 확인값만. */
  reachable: boolean;
  registry: InviteRegistry;
}

export type IssueSwitchResult =
  | {
      ok: true;
      ticket: SwitchTicket;
      /** allowlist 에 걸려 승계된 키(값 아님). 운영이 정책을 확인하는 근거다. */
      carriedSlotKeys: string[];
      /** allowlist 에 없어서 승계하지 않은 키. 정책 누락을 알아채는 근거다. */
      droppedSlotKeys: string[];
      piiMasked: boolean;
      piiKinds: string[];
    }
  | { ok: false; code: SwitchDenyCode; reasonKo: string };

function deny(code: SwitchDenyCode, reasonKo: string): IssueSwitchResult {
  return { ok: false, code, reasonKo };
}

/**
 * 전환 초대 발급. 판정 → 토큰 검증 → 발급 순서가 곧 안전장치다:
 * **티켓을 마지막에 만들어** 어느 단계에서 걸려도 보낼 수 있는 링크 재료가 생기지 않는다.
 * 던지는 것은 테넌트 스코프 위반 하나뿐이다(§11.1) — 나머지는 전부 결과로 내려간다(§9.3:
 * 전환에 실패했다고 통화를 끊지 않는다. 호출자는 사다리의 다음 칸으로 간다).
 */
export function issueSwitch(p: IssueSwitchParams): IssueSwitchResult {
  assertTenantScope(p.scope);

  // (2) 판정과 발급을 묶는다 — 전환 조건을 안 보고 링크부터 만들면 고객은 오지 않는 화면을 기다린다.
  const gate = canSwitchToVisual({
    crossChannelInviteSupported: p.crossChannelInviteSupported,
    visualChannelAvailable: p.targetChannelAvailable,
    reachable: p.reachable,
  });
  if (!gate.allowed) return deny('E_NOT_SWITCHABLE', gate.reasonKo);

  if (typeof p.newToken !== 'function') {
    return deny('E_CONFIG_INVALID', '토큰 발급기가 없습니다 — Core 는 세션 열쇠를 만들지 않습니다 (설계서 §13-3)');
  }
  if (!Number.isFinite(p.ttlMs) || p.ttlMs <= 0) {
    return deny('E_CONFIG_INVALID', '초대 유효기간(ttlMs)이 양수가 아닙니다 — 만료 없는 링크는 영구 열쇠입니다 (설계서 §5.2)');
  }
  if (!Array.isArray(p.carry.allow)) {
    return deny('E_CONFIG_INVALID', '승계 슬롯 allowlist 가 배열이 아닙니다 (설계서 §10.3)');
  }
  if (p.interactionId === '') {
    return deny('E_CONFIG_INVALID', 'Interaction id 없는 전환은 성립하지 않습니다 (설계서 §1.2)');
  }

  let token: string;
  try {
    token = p.newToken();
  } catch (e) {
    // 토큰 생성기가 던져도 통화를 끊지 않는다. 다만 원문 메시지는 싣지 않는다 — 난수원 오류에
    // 내부 경로·자격증명이 섞여 들어오는 경우가 있다(§10.3).
    return deny('E_CONFIG_INVALID', `토큰 발급기가 실패했습니다: ${e instanceof Error ? e.name : '알 수 없는 오류'}`);
  }
  if (typeof token !== 'string' || token.trim() === '') {
    return deny('E_TOKEN_WEAK', '빈 토큰은 열쇠가 아닙니다 (설계서 §5.2)');
  }
  // (1) 토큰이 id 를 품거나 id 가 토큰을 품으면, 링크를 본 사람이 세션 id 를 얻거나 그 반대가 된다.
  //     그 순간 1회용·만료가 전부 무의미해진다 — 다른 경로로 같은 문이 열리기 때문이다.
  if (token.includes(p.interactionId) || p.interactionId.includes(token)) {
    return deny('E_TOKEN_WEAK', '토큰이 Interaction id 와 얽혀 있습니다 — 링크가 곧 세션 id 가 됩니다 (설계서 §10.3)');
  }

  // 예약 슬롯은 승계 대상이 아니다. allowlist 에 실수로 들어와도 여기서 걷어낸다 —
  // `__` 슬롯은 Core 내부 판정용(실패 원인·커넥터 오류)이라 채널 전환과 무관하다.
  const slots: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.slots ?? {})) {
    if (!k.startsWith('__')) slots[k] = v;
  }

  let invite: ChannelInvite;
  try {
    invite = p.registry.issue({
      scope: p.scope,
      interactionId: p.interactionId,
      fromChannel: p.fromChannel,
      toChannel: p.toChannel,
      reason: p.reason,
      delivery: p.delivery,
      token,
      issuedAt: p.issuedAt,
      ttlMs: p.ttlMs,
      slots,
      carry: p.carry,
      crossChannelInviteSupported: p.crossChannelInviteSupported,
    });
  } catch (e) {
    // (4) 레지스트리 오류 원문에는 토큰이 들어 있을 수 있다(중복 토큰 메시지 등). 그대로 싣지 않는다.
    return deny('E_ISSUE_FAILED', `초대 발급이 거부되었습니다: ${redactToken(e, token)}`);
  }

  return {
    ok: true,
    ticket: {
      token: invite.token,
      interactionId: invite.interactionId,
      toChannel: invite.toChannel,
      expiresAt: invite.expiresAt,
    },
    carriedSlotKeys: Object.keys(invite.carriedSlots).sort(),
    droppedSlotKeys: [...invite.droppedSlotKeys],
    piiMasked: invite.piiMasked,
    piiKinds: [...invite.piiKinds],
  };
}

/** 오류 문구에서 토큰을 지운다. 토큰이 섞인 메시지는 통째로 버린다 — 부분 치환은 조각을 남긴다. */
function redactToken(e: unknown, token: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.includes(token) ? '레지스트리 거절(상세는 토큰이 포함되어 생략)' : raw;
}

/** 합류 거절 사유. `checkRedeem` 의 판정에 **Interaction 불일치** 하나를 더한 것이다. */
export type SwitchRedeemRejection = RedeemRejection | 'interaction_mismatch';

export interface RedeemSwitchParams {
  registry: InviteRegistry;
  token: string;
  scope: TenantScope;
  /** 상환을 시도하는 채널. 초대 목적지와 다르면 레지스트리가 거절한다. */
  channel: ChannelKind;
  at: string;
  /**
   * 채널이 함께 주장한 Interaction id. 토큰이 가리키는 것과 다르면 거절한다 —
   * **둘 다 맞아야** 합류한다(토큰만 믿으면 오배송된 링크가 그대로 통하고,
   * id 만 믿으면 애초의 결함으로 되돌아간다).
   */
  expectInteractionId?: string;
}

export type RedeemSwitchResult =
  | { ok: true; interactionId: string; toChannel: SwitchTargetChannel; carriedSlots: Record<string, string> }
  | { ok: false; rejection: SwitchRedeemRejection; reasonKo: string };

/**
 * 합류 자격 상환. 성공하면 토큰은 소진된다(1회용).
 *
 * `reasonKo` 는 **운영·감사용**이다 — 고객 화면에 그대로 띄우지 말 것. 사유를 구분해 보여주면
 * "이 토큰은 존재한다"는 사실 자체가 새고(열거 공격), 고객에게는 어차피 아무 행동도 지시하지 못한다.
 * 고객 문안은 테넌트가 정한다(§13-3). 토큰·슬롯 값은 어떤 사유 문구에도 실리지 않는다(§10.3).
 */
export function redeemSwitch(p: RedeemSwitchParams): RedeemSwitchResult {
  assertTenantScope(p.scope);
  const r = p.registry.redeem({ token: p.token, scope: p.scope, channel: p.channel, at: p.at });
  if (!r.ok) return { ok: false, rejection: r.rejection, reasonKo: r.reasonKo };
  if (p.expectInteractionId !== undefined && p.expectInteractionId !== r.interactionId) {
    // 토큰은 이미 소진됐다. 되돌리지 않는다 — 어긋난 링크가 한 번 더 시도되는 것보다 낫다.
    return {
      ok: false,
      rejection: 'interaction_mismatch',
      reasonKo: '초대가 가리키는 Interaction 과 채널이 주장한 Interaction 이 다릅니다 (설계서 §1.2)',
    };
  }
  return {
    ok: true,
    interactionId: r.interactionId,
    toChannel: r.invite.toChannel,
    carriedSlots: { ...r.carriedSlots },
  };
}
