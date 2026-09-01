// Flow — 설계서 §5.3. 하나의 Flow를 채널 렌더러만 바꿔 실행한다.
// 이것이 "시나리오 이중 관리"(§2 운영비용 최대 항목)를 구조적으로 제거한다.
import type { ChannelKind } from '../domain/types.ts';

export type NodeKind = 'Say' | 'Collect' | 'Choice' | 'Confirm' | 'Transfer' | 'Api';

export interface FlowNodeBase { id: string; kind: NodeKind; next?: string }
export interface SayNode extends FlowNodeBase { kind: 'Say'; text: string }
export interface CollectNode extends FlowNodeBase { kind: 'Collect'; slot: string; prompt: string; maxRetry?: number }
export interface ChoiceNode extends FlowNodeBase { kind: 'Choice'; prompt: string; options: { label: string; value: string; next?: string }[] }
export interface ConfirmNode extends FlowNodeBase { kind: 'Confirm'; prompt: string; onYes?: string; onNo?: string }
export interface TransferNode extends FlowNodeBase { kind: 'Transfer'; queue: string; reason?: string }
/**
 * 외부 업무시스템 조회·처리 노드 (§6.1). 실제 호출은 Core가 하지 않는다 —
 * 커넥터 선언(src/integration/connector.ts)과 포트 구현이 담당하고, Flow는 "여기서 부른다"만 표시한다.
 * waitText 는 음성 채널에서 침묵 구간을 메우는 대기 안내다. 없으면 무음으로 대기한다.
 * onError 는 호출 최종 실패 시의 분기다. 지정하지 않으면 §9.3에 따라 상담사로 내려간다.
 */
export interface ApiNode extends FlowNodeBase { kind: 'Api'; connectorId: string; waitText?: string; onError?: string }
export type FlowNode = SayNode | CollectNode | ChoiceNode | ConfirmNode | TransferNode | ApiNode;

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
  /** 표시·발화할 것이 없는 단계(Api 대기). 채널 어댑터는 이 단계를 렌더하지 않는다. */
  silent?: boolean;
  /** Api 노드 — 호출해야 할 커넥터 id. 채널이 아니라 호스트가 처리한다(§6.1·§6.2). */
  awaitConnectorId?: string;
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
    case 'Api': {
      const text = node.waitText ?? '';
      return { ...base, text, silent: text.trim() === '', awaitConnectorId: node.connectorId };
    }
  }
}
