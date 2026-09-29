// Flow — 설계서 §5.3. 하나의 Flow를 채널 렌더러만 바꿔 실행한다.
// 이것이 "시나리오 이중 관리"(§2 운영비용 최대 항목)를 구조적으로 제거한다.
import type { ChannelKind } from '../domain/types.ts';
import type { RepromptReason } from './reprompt.ts';
import type { DisclosurePlacement } from '../portal/aiDisclosure.ts';

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

/**
 * 인텐트 진입 노드 표시(§5.1·§5.3). 이 슬롯을 수집하는 `Collect` 노드는 "무엇을 도와드릴까요?"이며,
 * 고객의 답은 **슬롯 값이 아니라 인텐트**로 해석된다 — 런타임에 인텐트가 배선된 경우에 한한다.
 *
 * 왜 새 노드 종류(`NodeKind`)를 만들지 않았는가: 채널 3곳이 `step.kind` 로 분기하고 있어
 * 새 종류를 내보내는 순간 **설정을 바꾼 날** 전 통화가 첫 단계에서 깨진다(코드 배포가 아니라
 * 원인을 찾기도 어렵다). 예약 슬롯이면 채널이 보는 것은 종전과 같은 `Collect` 단계뿐이다.
 *
 * 배선이 없으면 종전과 완전히 같다(§13-3) — 평범한 Collect 로 동작해 답을 이 슬롯에 담고 다음 노드로 간다.
 * 확정된 인텐트 id 도 같은 슬롯에 담긴다(예약 슬롯이라 채널이 덮어쓸 수 없다).
 */
export const INTENT_SLOT = '__intent__';

/** 이 노드가 인텐트 진입 노드인가. 판정은 한 곳에만 둔다 — 문자열 비교가 흩어지면 오타가 조용히 기능을 끈다. */
export function isIntentEntryNode(node: FlowNode | undefined): node is CollectNode {
  return node !== undefined && node.kind === 'Collect' && node.slot === INTENT_SLOT;
}

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
  /**
   * 재시도로 다시 낸 단계라는 표시(§5.1). 첫 제시에는 없다.
   * 채널은 이 값으로 표현을 달리할 수 있다(음성: 속도·안내 문구, 화면: 오류 강조).
   * `exhausted` 는 선언된 사다리를 다 쓰고 마지막 문장을 반복하는 중이라는 뜻이다.
   */
  reprompt?: { reason: RepromptReason; attempt: number; exhausted: boolean };
  /**
   * 입력 대기(ms). 선언된 테넌트에서만 실린다 — Core 는 기본 대기 시간을 만들지 않는다(§13-3).
   * 값이 없으면 채널이 종전대로 자기 값을 쓴다.
   */
  inputTimeoutMs?: number;
  /** 안내 도중 끼어들기 허용 여부. 음성 채널에만 실린다. */
  bargeIn?: boolean;
  /**
   * AI 고지 단계라는 표시(§10.1 · §7 7.4). 고지가 배선된 테넌트에서만 실린다 —
   * 이 필드가 없으면 종전과 완전히 같다(§13-3).
   *
   * 이 단계는 **시나리오 노드가 아니다**(`nodeId` 가 `flow.nodes` 에 없다). 모르는 포트는
   * 그냥 텍스트로 내보내면 되고 그것이 곧 고지다 — `placement` 를 읽는 포트는 매체에 맞게
   * (화면 상단 고정 배너·첫 발화 전) 표현을 달리할 수 있다.
   */
  disclosure?: { placement: DisclosurePlacement; configVersion: number };
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
