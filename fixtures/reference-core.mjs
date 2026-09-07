// 브리지 실행기가 기대하는 최소 예시 — 비-Node 채널 호스트(Callbot 파이썬 에이전트 등)가 복사해 간다.
//
// 저장소가 할 일은 두 가지뿐이다: 자기 시나리오를 등록하고, 자기 ChannelPort 를 끼우는 것.
// 세션·이벤트·폴백·마스킹·종료 멱등은 Core 가 그대로 책임진다.
//
// 이 파일은 transport 를 주입하지 않으므로 `dry_run` 이며 매체로 아무것도 내보내지 않는다.
// live 전환은 approvalRef + transport 가 모두 있어야 하고 **[승인 필요]** 다.
// 실고객 자료·개인정보를 담지 않는다(§10.3).
import { createConversationCore, createMemoryFlowRegistry } from '../src/channels/runtime.ts';
import { createChannelPort } from '../src/channels/basePort.ts';
import { CHANNEL_COMPONENTS } from '../src/channels/profiles.ts';
import { createHealthRegistry } from '../src/ops/fallback.ts';

export const scope = { tenantId: 'reference' };

export const flows = [{
  id: 'f_reference_voice',
  version: 1,
  startNodeId: 'n_greet',
  nodes: {
    n_greet: { id: 'n_greet', kind: 'Say', text: '안녕하세요. 무엇을 도와드릴까요?', next: 'n_ask' },
    n_ask: { id: 'n_ask', kind: 'Collect', slot: 'purpose', prompt: '용건을 말씀해 주세요.', next: 'n_tr' },
    n_tr: { id: 'n_tr', kind: 'Transfer', queue: 'q_default', reason: '상담사 연결' },
  },
}];

export default function createCore() {
  const port = createChannelPort({ id: 'callbot' });
  const core = createConversationCore({
    scope,
    flows: createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    // 임계값·가용성은 고객사 설정에서 온다. 여기 값은 예시일 뿐 기본값이 아니다(§13-3).
    policy: {
      tenantId: 'reference', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: createHealthRegistry([]),
  });
  return { core, scope, port };
}
