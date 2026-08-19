// Flow — 설계서 §5.3. 하나의 Flow를 채널 렌더러만 바꿔 실행한다.
// 이것이 "시나리오 이중 관리"(§2 운영비용 최대 항목)를 구조적으로 제거한다.
import type { ChannelKind } from '../domain/types.ts';

export type NodeKind = 'Say' | 'Collect' | 'Choice' | 'Confirm' | 'Transfer';

export interface FlowNodeBase { id: string; kind: NodeKind; next?: string }
export interface SayNode extends FlowNodeBase { kind: 'Say'; text: string }
export interface CollectNode extends FlowNodeBase { kind: 'Collect'; slot: string; prompt: string; maxRetry?: number }
export interface ChoiceNode extends FlowNodeBase { kind: 'Choice'; prompt: string; options: { label: string; value: string; next?: string }[] }
export interface ConfirmNode extends FlowNodeBase { kind: 'Confirm'; prompt: string; onYes?: string; onNo?: string }
export interface TransferNode extends FlowNodeBase { kind: 'Transfer'; queue: string; reason?: string }
export type FlowNode = SayNode | CollectNode | ChoiceNode | ConfirmNode | TransferNode;

export interface Flow { id: string; version: number; startNodeId: string; nodes: Record<string, FlowNode> }

/** 채널별 렌더 결과 — Voice는 발화, Visual은 화면, Chat은 말풍선으로 변환된다 */
export interface RenderedStep {
  channel: ChannelKind;
  nodeId: string;
  kind: NodeKind;
  /** voice: TTS 대본 / visual·chat: 표시 텍스트 */
  text: string;
  /** visual·chat 전용 — 버튼·폼 */
  ui?: { type: 'buttons' | 'form' | 'confirm'; items?: { label: string; value: string }[]; slot?: string };
  /** voice 전용 — DTMF 수용 여부 (§5.1 어르신·소음 환경 폴백) */
  acceptDtmf?: boolean;
  transferTo?: string;
}

export function renderNode(node: FlowNode, channel: ChannelKind): RenderedStep {
  const base = { channel, nodeId: node.id, kind: node.kind };
  switch (node.kind) {
    case 'Say':
      return { ...base, text: node.text };
    case 'Collect':
      return channel === 'voice'
        ? { ...base, text: node.prompt, acceptDtmf: true }
        : { ...base, text: node.prompt, ui: { type: 'form', slot: node.slot } };
    case 'Choice': {
      const items = node.options.map(o => ({ label: o.label, value: o.value }));
      return channel === 'voice'
        ? { ...base, text: `${node.prompt} ${node.options.map((o, i) => `${i + 1}번 ${o.label}`).join(', ')}`, acceptDtmf: true }
        : { ...base, text: node.prompt, ui: { type: 'buttons', items } };
    }
    case 'Confirm':
      return channel === 'voice'
        ? { ...base, text: `${node.prompt} 맞으시면 1번을 눌러주세요.`, acceptDtmf: true }
        : { ...base, text: node.prompt, ui: { type: 'confirm' } };
    case 'Transfer':
      return { ...base, text: '상담사에게 연결해 드리겠습니다.', transferTo: node.queue };
  }
}
