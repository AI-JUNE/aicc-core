// Session Manager — 설계서 §1.2/§5.1.
// 고객이 전화→화면→채팅으로 옮겨가도 하나의 Interaction으로 유지한다.
import type { ChannelKind, Interaction, Turn } from '../domain/types.ts';
import { maskPii } from './policyGuard.ts';

export function createInteraction(tenantId: string, channel: ChannelKind, id = `i_${Date.now().toString(36)}`): Interaction {
  return { id, tenantId, startedAt: new Date().toISOString(), channels: [channel], turns: [], entities: {} };
}

/** 채널 합류 — 통화 중 Visual IVR 링크를 열면 같은 Interaction에 바인딩 (§5.2) */
export function attachChannel(i: Interaction, channel: ChannelKind): Interaction {
  if (!i.channels.includes(channel)) i.channels.push(channel);
  return i;
}

/** 턴 기록 — 저장 전 반드시 마스킹 (§10.3) */
export function appendTurn(i: Interaction, turn: Omit<Turn, 'id' | 'at'>): Turn {
  const masked = maskPii(turn.utterance);
  const t: Turn = { ...turn, utterance: masked.text, id: `t_${i.turns.length + 1}`, at: new Date().toISOString() };
  i.turns.push(t);
  return t;
}

/** §5.1 폴백 정책 — 인식 실패 2회 → 화면 전환, 3회 → 상담사 이관. AI가 죽어도 전화는 받아져야 한다(§9.3). */
export type FallbackAction = 'retry' | 'switch_to_visual' | 'handoff_agent';

export function decideFallback(failCount: number, visualAvailable: boolean): FallbackAction {
  if (failCount >= 3) return 'handoff_agent';
  if (failCount === 2) return visualAvailable ? 'switch_to_visual' : 'handoff_agent';
  return 'retry';
}
