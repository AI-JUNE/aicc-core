// 채널 전환(초대·승계) 규약 — 설계서 §5.2(통화 중 화면 전환)·§1.2(하나의 Interaction)·§10.3(마스킹)·§11.1(테넌트 격리).
//
// 문제: "통화 중에 링크를 보내 화면으로 넘긴다"는 제품의 핵심 동선인데, 여기가 제일 새기 쉽다.
// 링크 하나가 곧 진행 중인 세션의 열쇠이기 때문이다. 토큰이 재사용되거나 만료되지 않으면
// 남의 상담 맥락(이미 수집된 슬롯)이 그대로 열린다. 그래서 전환은 "링크 발급"이 아니라
// 다음 네 가지를 강제하는 규약으로 둔다.
//   (1) 1회용 — 상환되면 끝. 재상환은 거절한다.
//   (2) 만료 — TTL은 테넌트 운영값으로 받는다(코드에 기본 시간을 박지 않는다, §13-3).
//   (3) 테넌트·Interaction 일치 — 스코프가 다르면 무조건 거절(§11.1).
//   (4) 승계 슬롯 최소화 — allowlist에 적은 키만, 그것도 마스킹을 통과한 값만 넘어간다(§10.3).
//
// 실제 링크 발송(SMS·푸시·알림톡)은 이 파일에 없다. 발신은 [승인 필요] — 채널 저장소가 승인 후 붙인다.
import type { ChannelKind, Interaction } from '../domain/types.ts';
import type { TenantScope } from './tenancy.ts';
import { assertTenantScope } from './tenancy.ts';
import { maskPii } from './policyGuard.ts';
import { attachChannel } from './session.ts';

export const CHANNEL_SWITCH_CONTRACT_VERSION = 1;

/** 전환 목적지. 통화(voice)는 초대로 "합류"시키는 대상이 아니다 — 회선 전환은 §9.3 경로다. */
export type SwitchTargetChannel = Extract<ChannelKind, 'visual' | 'chat'>;

/** 왜 전환하는가. 리포트·QA가 전환 품질을 볼 때 쓰는 축이다(§7 7.6). */
export type SwitchReason =
  | 'recognition_failure'   // §5.1 인식 실패 2회 → 화면 전환
  | 'complex_input'         // 계좌·주소 등 음성으로 받기 어려운 입력
  | 'customer_request'      // 고객이 화면을 요청
  | 'flow_directed';        // 시나리오 노드가 지정한 전환(§5.3)

/** 발송 수단. Core는 종류만 기록하고 실제 발송은 하지 않는다 — [승인 필요]. */
export type InviteDeliveryKind = 'sms' | 'push' | 'chat_message' | 'manual';

/**
 * 승계 슬롯 정책 — allowlist가 유일한 통로다.
 * deny를 두지 않고 allow만 두는 이유: "빠뜨려서 새는" 사고를 구조적으로 막기 위해서다.
 * 목록에 없는 키는 조용히 버려지고, 버려진 키는 결과에 남는다(dropped).
 */
export interface SlotCarryPolicy {
  /** 전환 화면으로 넘길 슬롯 키. 빈 배열이면 아무것도 넘기지 않는다. */
  allow: readonly string[];
}

export interface ChannelInvite {
  token: string;
  tenantId: string;
  workspaceId?: string;
  interactionId: string;
  fromChannel: ChannelKind;
  toChannel: SwitchTargetChannel;
  reason: SwitchReason;
  delivery: InviteDeliveryKind;
  issuedAt: string;
  expiresAt: string;
  /** 발급 시점에 고정된 승계 슬롯. 이미 마스킹을 통과했다(§10.3). */
  carriedSlots: Record<string, string>;
  /** allowlist에 없어서 승계하지 않은 키. 운영자가 정책 누락을 알아채는 근거. */
  droppedSlotKeys: string[];
  /** 승계 값 중 마스킹이 적용된 것이 있는가 */
  piiMasked: boolean;
  piiKinds: string[];
}

export interface IssueInviteParams {
  scope: TenantScope;
  interactionId: string;
  fromChannel: ChannelKind;
  toChannel: SwitchTargetChannel;
  reason: SwitchReason;
  delivery: InviteDeliveryKind;
  /** 토큰은 주입한다 — 이 모듈을 순수하게 유지하고, 난수 생성기는 배포 환경이 고른다. */
  token: string;
  /** 발급 시각(ISO8601). 호출자가 넘긴다. */
  issuedAt: string;
  /** 유효기간(ms). 테넌트 운영값 — 코드에 기본값을 두지 않는다(§13-3). */
  ttlMs: number;
  /** 현재 세션이 수집한 슬롯 전체. 이 중 allowlist에 걸린 것만 넘어간다. */
  slots?: Record<string, string>;
  carry: SlotCarryPolicy;
  /** 발신 채널이 교차채널 초대를 실제로 할 수 있는지(§ 채널 계약 crossChannelInvite). */
  crossChannelInviteSupported: boolean;
}

function assertIso(label: string, iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`${label} 시각 형식 오류: ${JSON.stringify(iso)}`);
  return ms;
}

/**
 * 초대 발급. 검증에 실패하면 던진다 — "일단 발급하고 나중에 거른다"는 경로를 만들지 않는다.
 * 승계 슬롯은 여기서 마스킹된다. 원문이 초대에 담기는 경로는 없다(§10.3).
 */
export function issueInvite(p: IssueInviteParams): ChannelInvite {
  assertTenantScope(p.scope);
  if (!p.interactionId) throw new Error('interaction_id 없는 초대는 발급할 수 없다 (설계서 §1.2)');
  if (!p.token) throw new Error('초대 토큰이 비어 있다 (설계서 §5.2)');
  if (p.fromChannel === p.toChannel) {
    throw new Error(`같은 채널로의 전환 초대는 의미가 없다: ${p.fromChannel} (설계서 §5.2)`);
  }
  if (!p.crossChannelInviteSupported) {
    throw new Error(`이 채널은 교차채널 초대를 지원하지 않는다: ${p.fromChannel} (설계서 §5.2·채널 계약)`);
  }
  if (!Number.isFinite(p.ttlMs) || p.ttlMs <= 0) {
    throw new Error(`초대 유효기간(ttlMs)은 양수여야 한다: ${String(p.ttlMs)} (설계서 §10.3)`);
  }

  const issuedMs = assertIso('issuedAt', p.issuedAt);
  const allow = new Set(p.carry.allow);
  const slots = p.slots ?? {};
  const carriedSlots: Record<string, string> = {};
  const droppedSlotKeys: string[] = [];
  const kinds = new Set<string>();
  let anyMasked = false;

  for (const key of Object.keys(slots).sort()) {
    if (!allow.has(key)) {
      droppedSlotKeys.push(key);
      continue;
    }
    const m = maskPii(slots[key] ?? '');
    if (m.masked) {
      anyMasked = true;
      for (const h of m.hits) kinds.add(h);
    }
    carriedSlots[key] = m.text;
  }

  return {
    token: p.token,
    tenantId: p.scope.tenantId,
    ...(p.scope.workspaceId !== undefined ? { workspaceId: p.scope.workspaceId } : {}),
    interactionId: p.interactionId,
    fromChannel: p.fromChannel,
    toChannel: p.toChannel,
    reason: p.reason,
    delivery: p.delivery,
    issuedAt: p.issuedAt,
    expiresAt: new Date(issuedMs + p.ttlMs).toISOString(),
    carriedSlots,
    droppedSlotKeys,
    piiMasked: anyMasked,
    piiKinds: [...kinds].sort(),
  };
}

export type RedeemRejection =
  | 'unknown_token'
  | 'already_redeemed'
  | 'expired'
  | 'tenant_mismatch'
  | 'channel_mismatch'
  | 'revoked';

export interface RedeemAttempt {
  token: string;
  scope: TenantScope;
  /** 상환을 시도하는 채널. 초대 목적지와 다르면 거절한다. */
  channel: ChannelKind;
  at: string;
}

export type RedeemResult =
  | { ok: true; invite: ChannelInvite; interactionId: string; carriedSlots: Record<string, string> }
  | { ok: false; rejection: RedeemRejection; reasonKo: string };

const REJECTION_KO: Record<RedeemRejection, string> = {
  unknown_token: '존재하지 않는 초대 토큰',
  already_redeemed: '이미 사용된 초대 — 1회용이다',
  expired: '초대 유효기간 만료',
  tenant_mismatch: '테넌트·워크스페이스 불일치 (설계서 §11.1)',
  channel_mismatch: '초대 목적지와 다른 채널에서의 상환',
  revoked: '운영자가 회수한 초대',
};

function reject(r: RedeemRejection): RedeemResult {
  return { ok: false, rejection: r, reasonKo: REJECTION_KO[r] };
}

/**
 * 순수 판정 — 저장소 없이 초대 1건과 시도 1건만 보고 결론을 낸다.
 * "이미 사용됨" 판정은 상태가 필요하므로 레지스트리(createInviteRegistry)가 담당한다.
 */
export function checkRedeem(invite: ChannelInvite, attempt: RedeemAttempt): RedeemResult {
  assertTenantScope(attempt.scope);
  if (invite.token !== attempt.token) return reject('unknown_token');
  if (invite.tenantId !== attempt.scope.tenantId) return reject('tenant_mismatch');
  if ((invite.workspaceId ?? undefined) !== (attempt.scope.workspaceId ?? undefined)) return reject('tenant_mismatch');
  if (invite.toChannel !== attempt.channel) return reject('channel_mismatch');
  const atMs = assertIso('redeem.at', attempt.at);
  if (atMs >= Date.parse(invite.expiresAt)) return reject('expired');
  return { ok: true, invite, interactionId: invite.interactionId, carriedSlots: { ...invite.carriedSlots } };
}

export interface InviteRegistry {
  issue(p: IssueInviteParams): ChannelInvite;
  redeem(attempt: RedeemAttempt): RedeemResult;
  /** 운영자 회수 — 잘못 발송된 링크를 즉시 무력화한다(§7 7.4). */
  revoke(token: string, scope: TenantScope): boolean;
  /** 진단용 조회. 테넌트가 다르면 찾지 못한 것으로 취급한다(§11.1). */
  get(token: string, scope: TenantScope): ChannelInvite | undefined;
  /** 만료·상환 완료 건 정리. 반환값은 제거된 건수. */
  purge(nowIso: string): number;
}

/** 인메모리 레지스트리. 실서비스 저장소는 이 인터페이스를 그대로 구현한다(§6.2 — Core는 저장소에 종속되지 않는다). */
export function createInviteRegistry(): InviteRegistry {
  const invites = new Map<string, ChannelInvite>();
  const redeemed = new Set<string>();
  const revoked = new Set<string>();

  return {
    issue(p) {
      const inv = issueInvite(p);
      if (invites.has(inv.token)) {
        throw new Error(`초대 토큰이 중복되었다: 재사용 금지 (설계서 §10.3)`);
      }
      invites.set(inv.token, inv);
      return inv;
    },
    redeem(attempt) {
      assertTenantScope(attempt.scope);
      const inv = invites.get(attempt.token);
      if (!inv) return reject('unknown_token');
      // 테넌트 불일치를 "없는 토큰"과 구분하되, 어느 쪽이든 내용은 절대 돌려주지 않는다.
      if (revoked.has(attempt.token)) return reject('revoked');
      if (redeemed.has(attempt.token)) return reject('already_redeemed');
      const r = checkRedeem(inv, attempt);
      if (r.ok) redeemed.add(attempt.token);
      return r;
    },
    revoke(token, scope) {
      assertTenantScope(scope);
      const inv = invites.get(token);
      if (!inv || inv.tenantId !== scope.tenantId) return false;
      if (redeemed.has(token)) return false;
      revoked.add(token);
      return true;
    },
    get(token, scope) {
      assertTenantScope(scope);
      const inv = invites.get(token);
      if (!inv || inv.tenantId !== scope.tenantId) return undefined;
      if ((inv.workspaceId ?? undefined) !== (scope.workspaceId ?? undefined)) return undefined;
      return inv;
    },
    purge(nowIso) {
      const nowMs = assertIso('purge.now', nowIso);
      let removed = 0;
      for (const [token, inv] of invites) {
        if (Date.parse(inv.expiresAt) <= nowMs || redeemed.has(token) || revoked.has(token)) {
          invites.delete(token);
          redeemed.delete(token);
          revoked.delete(token);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export interface ApplyInviteResult {
  interaction: Interaction;
  /** 실제로 세션에 새로 채워진 슬롯 키 */
  appliedSlotKeys: string[];
  /** 세션이 이미 값을 갖고 있어 덮어쓰지 않은 키 */
  skippedSlotKeys: string[];
}

/**
 * 상환된 초대를 세션에 반영한다 — 새 Interaction을 만들지 않는 것이 핵심이다(§1.2).
 * 이미 수집된 슬롯은 덮어쓰지 않는다. 초대는 발급 시점의 스냅샷이라, 그 사이 통화에서
 * 갱신된 값을 오래된 값으로 되돌리면 고객이 방금 정정한 내용이 사라진다.
 */
export function applyInvite(interaction: Interaction, invite: ChannelInvite): ApplyInviteResult {
  if (interaction.id !== invite.interactionId) {
    throw new Error(`초대가 가리키는 Interaction이 아니다: ${invite.interactionId} ≠ ${interaction.id} (설계서 §1.2)`);
  }
  if (interaction.tenantId !== invite.tenantId) {
    throw new Error('테넌트가 다른 Interaction에 초대를 적용할 수 없다 (설계서 §11.1)');
  }
  attachChannel(interaction, invite.toChannel);

  const appliedSlotKeys: string[] = [];
  const skippedSlotKeys: string[] = [];
  for (const key of Object.keys(invite.carriedSlots).sort()) {
    if (interaction.entities[key] !== undefined) {
      skippedSlotKeys.push(key);
      continue;
    }
    interaction.entities[key] = invite.carriedSlots[key] as string;
    appliedSlotKeys.push(key);
  }
  return { interaction, appliedSlotKeys, skippedSlotKeys };
}

/**
 * §5.1 폴백 사다리와의 접점 — decideFallback이 'switch_to_visual'을 냈다고 해서
 * 항상 전환할 수 있는 건 아니다. 채널 능력·목적지 가용성이 함께 성립해야 한다.
 * 성립하지 않으면 전환을 흉내내지 말고 상담사로 넘긴다(조용히 끊는 경로를 만들지 않는다).
 */
export function canSwitchToVisual(p: {
  crossChannelInviteSupported: boolean;
  visualChannelAvailable: boolean;
  /** 고객이 화면 수신 수단을 갖고 있다고 채널이 확인했는가(예: 스마트폰 호). 추정 금지 — 확인값만. */
  reachable: boolean;
}): { allowed: boolean; reasonKo: string } {
  if (!p.crossChannelInviteSupported) return { allowed: false, reasonKo: '발신 채널이 교차채널 초대를 지원하지 않음' };
  if (!p.visualChannelAvailable) return { allowed: false, reasonKo: '화면 채널(D-ARS) 사용 불가 (설계서 §9.3)' };
  if (!p.reachable) return { allowed: false, reasonKo: '고객 단말이 화면 수신 가능한지 확인되지 않음' };
  return { allowed: true, reasonKo: '전환 가능' };
}
