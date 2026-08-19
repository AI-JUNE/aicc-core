// AI 고지 문구 — 설계서 §7 7.4 · §10.1.
// 고지 문구는 테넌트마다 다르고(업권·약관·감독기관), 문구가 바뀌면 언제 무엇으로 바뀌었는지 남아야 한다.
// 코드에 표준 문구를 박아 넣지 않는다 — 법무 검토를 거친 테넌트 문구만 사용한다. [승인 필요]
import type { ChannelKind } from '../domain/types.ts';

/** 고지 시점. 채널 특성에 따라 다르다 — 음성은 첫 발화 전, 화면·채팅은 상단 배너가 가능하다. */
export type DisclosurePlacement =
  | 'session_start'          // 세션 시작 직후 1회
  | 'before_first_response'  // AI 첫 응답 직전
  | 'persistent_banner';     // 화면 상단 상시 노출(visual·chat 전용)

export interface DisclosureChannelSetting {
  /** 노출 문구. 법무 검토를 거친 테넌트 문구를 그대로 사용한다. */
  text: string;
  placement: DisclosurePlacement;
  /** 해당 채널에서 고지를 생략할 수 있는지. 생략 허용은 테넌트가 법적 근거를 갖고 설정한다. */
  optional?: boolean;
}

export interface AiDisclosureConfig {
  tenantId: string;                 // §11.1 — 테넌트 밖 조회 금지
  /** 고지 사용 여부. 기본은 사용(on)이며, 끄는 것은 테넌트의 명시적 결정이어야 한다. */
  enabled: boolean;
  channels: Partial<Record<ChannelKind, DisclosureChannelSetting>>;
  /** 문구 변경 이력 추적용 — 변경 시마다 증가 */
  version: number;
  updatedAt: string;                // ISO8601
  updatedBy: string;
  /** 법무·컴플라이언스 승인 여부. 미승인 문구는 배포할 수 없다. */
  approved: boolean;
  approvedAt?: string;
  approvedBy?: string;
}

export interface ResolvedDisclosure {
  channel: ChannelKind;
  text: string;
  placement: DisclosurePlacement;
  configVersion: number;
}

/**
 * 런타임이 세션 시작 시 호출한다.
 * 문구가 없거나 미승인이면 null 이 아니라 예외적 상황으로 취급해야 하므로,
 * 판정 근거를 함께 돌려준다(호출자가 차단할지 진행할지 결정).
 */
export type DisclosureDecision =
  | { show: true; disclosure: ResolvedDisclosure }
  | { show: false; reason: 'disabled' | 'channel_not_configured' | 'optional' }
  | { show: false; reason: 'not_approved' | 'text_empty'; blocking: true };

export function resolveDisclosure(cfg: AiDisclosureConfig, channel: ChannelKind): DisclosureDecision {
  if (!cfg.enabled) return { show: false, reason: 'disabled' };
  if (!cfg.approved) return { show: false, reason: 'not_approved', blocking: true };
  const setting = cfg.channels[channel];
  if (!setting) return { show: false, reason: 'channel_not_configured' };
  if (setting.text.trim() === '') {
    return setting.optional === true
      ? { show: false, reason: 'optional' }
      : { show: false, reason: 'text_empty', blocking: true };
  }
  return {
    show: true,
    disclosure: { channel, text: setting.text.trim(), placement: setting.placement, configVersion: cfg.version },
  };
}

export type DisclosureIssueCode =
  | 'E_TENANT_MISSING'
  | 'E_NOT_APPROVED'
  | 'E_TEXT_EMPTY'
  | 'E_INVALID_PLACEMENT'
  | 'W_DISABLED'
  | 'W_CHANNEL_MISSING';

export interface DisclosureIssue {
  code: DisclosureIssueCode;
  severity: 'error' | 'warning';
  message: string;
  channel?: ChannelKind;
}

const ALL_CHANNELS: ChannelKind[] = ['voice', 'visual', 'chat'];

/** persistent_banner 는 음성에 존재할 수 없다 — 설정 단계에서 막는다. */
function placementValid(channel: ChannelKind, placement: DisclosurePlacement): boolean {
  if (channel === 'voice') return placement === 'session_start' || placement === 'before_first_response';
  return true;
}

/** 설정 화면(/operations/ai-disclosure) 저장 전 검증. error 0건일 때만 저장한다. */
export function validateDisclosureConfig(
  cfg: AiDisclosureConfig,
  activeChannels: ChannelKind[] = ALL_CHANNELS,
): { ok: boolean; issues: DisclosureIssue[] } {
  const issues: DisclosureIssue[] = [];
  if (cfg.tenantId.trim() === '') {
    issues.push({ code: 'E_TENANT_MISSING', severity: 'error', message: 'tenantId 없이 고지 설정을 저장할 수 없습니다(§11.1).' });
  }
  if (!cfg.enabled) {
    issues.push({ code: 'W_DISABLED', severity: 'warning', message: 'AI 고지가 꺼져 있습니다. 법적 근거를 확인하세요(§10.1).' });
  } else if (!cfg.approved) {
    issues.push({ code: 'E_NOT_APPROVED', severity: 'error', message: '법무 승인되지 않은 고지 문구는 배포할 수 없습니다.' });
  }
  for (const ch of activeChannels) {
    const s = cfg.channels[ch];
    if (!s) {
      issues.push({ code: 'W_CHANNEL_MISSING', severity: 'warning', channel: ch, message: `'${ch}' 채널의 고지 문구가 설정되지 않았습니다.` });
      continue;
    }
    if (s.text.trim() === '' && s.optional !== true) {
      issues.push({ code: 'E_TEXT_EMPTY', severity: 'error', channel: ch, message: `'${ch}' 채널의 고지 문구가 비어 있습니다.` });
    }
    if (!placementValid(ch, s.placement)) {
      issues.push({ code: 'E_INVALID_PLACEMENT', severity: 'error', channel: ch, message: `'${ch}' 채널에서 사용할 수 없는 노출 시점입니다: ${s.placement}` });
    }
  }
  return { ok: issues.every(i => i.severity !== 'error'), issues };
}

/** 문구 변경 — 변경 시 재승인이 필요하다. 이력은 저장 계층이 append-only 로 남긴다. */
export function updateDisclosureText(
  cfg: AiDisclosureConfig,
  channel: ChannelKind,
  setting: DisclosureChannelSetting,
  by: string,
  at: string,
): AiDisclosureConfig {
  return {
    ...cfg,
    channels: { ...cfg.channels, [channel]: setting },
    version: cfg.version + 1,
    updatedAt: at,
    updatedBy: by,
    approved: false,      // 문구가 바뀌면 승인은 무효화된다
    ...(cfg.approvedAt !== undefined ? { approvedAt: undefined } : {}),
    ...(cfg.approvedBy !== undefined ? { approvedBy: undefined } : {}),
  };
}
