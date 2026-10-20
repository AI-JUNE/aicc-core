// Api 대기(§6.1)가 서는 예시 Core — **커넥터 이행을 배선하지 않은** 호스트의 모양이다.
//
// 왜 이 픽스처가 따로 있는가: `reference-core.mjs` 에는 Api 노드가 없어서, 비-Node 호스트가
// "업무시스템 조회 결과를 되돌려주는" 경로를 한 번도 지나지 않는다. 그 경로의 실패는 예외가
// 아니라 **무음**이다(대기 중에 발화를 보내면 steps 0건·events 0건이 돌아오고 오류도 아니다) —
// 그래서 검사가 없으면 영영 드러나지 않는다.
//
// 커넥터 배선(`connectors`)을 일부러 주지 않는다: 그 상태가 종전 동작이고, Core 는
// `state.pendingConnectorId` 를 세운 뒤 호스트의 `connectorResult` 를 기다린다(W_CONNECTOR_UNBOUND
// 경고가 함께 남는다). 실업무시스템·실회선에 붙지 않으며 개인정보를 담지 않는다(§10.3).
import { createConversationCore, createMemoryFlowRegistry } from '../src/channels/runtime.ts';
import { createChannelPort } from '../src/channels/basePort.ts';
import { CHANNEL_COMPONENTS } from '../src/channels/profiles.ts';
import { createHealthRegistry } from '../src/ops/fallback.ts';

export const scope = { tenantId: 'reference' };

export const flows = [{
  id: 'f_reference_api',
  version: 1,
  startNodeId: 'n_ask',
  nodes: {
    n_ask: { id: 'n_ask', kind: 'Collect', slot: 'purpose', prompt: '용건을 말씀해 주세요.', next: 'n_api' },
    // 대기 안내가 있으므로 무음 단계가 아니다 — 호출 전에 먼저 나간다(§6.1).
    n_api: { id: 'n_api', kind: 'Api', connectorId: 'c_reference_lookup', waitText: '조회 중입니다.', next: 'n_done', onError: 'n_tr' },
    n_done: { id: 'n_done', kind: 'Say', text: '조회가 끝났습니다.' },
    // 조회 실패는 고객 잘못이 아니다 — 계약에 있는 사유(`error`)로 적는다(§8.1 집계가 센다).
    n_tr: { id: 'n_tr', kind: 'Transfer', queue: 'q_default', reason: 'error' },
  },
}];

export default function createCore() {
  const port = createChannelPort({ id: 'callbot' });
  const core = createConversationCore({
    scope,
    flows: createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    // 예시 값이며 기본값이 아니다(§13-3).
    policy: {
      tenantId: 'reference', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: createHealthRegistry([]),
  });
  return { core, scope, port };
}
