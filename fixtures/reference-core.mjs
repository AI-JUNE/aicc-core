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
}, {
  /**
   * **여러 턴이 이어지는 흐름.** 위 흐름은 첫 발화가 곧 이관이라 그 턴에서 Core 세션이 끝난다 —
   * 즉 두 번째 입력부터는 전부 **Core 가 닫은 세션**으로 가고, 그 응답은 오류가 아니라 멱등
   * 처리다(`ok: true`·events 0건·직전 단계 되풀이). 다중 턴 경로(턴 단위 실측 선언·요청 한도·
   * 훅 순서)를 검사하려면 그 모양을 지나는 수밖에 없었고, **그것이 결함을 가려 준 자리였다**:
   * "턴을 보냈다"가 "시나리오가 진행됐다"와 구분되지 않았다. 그래서 흐름을 하나 더 둔다.
   *
   * 수집 노드 셋인 이유: §5.1 사다리는 같은 대기에서 3회 실패하면 이관하므로, 한 노드로는 턴을
   * 셋 이상 이어 붙일 수 없다. 노드가 셋이면 발화·DTMF·무음을 한 통화에서 모두 지난다.
   */
  id: 'f_reference_voice_multi',
  version: 1,
  startNodeId: 'n_q1',
  nodes: {
    n_q1: { id: 'n_q1', kind: 'Collect', slot: 'purpose', prompt: '용건을 말씀해 주세요.', next: 'n_q2' },
    n_q2: { id: 'n_q2', kind: 'Collect', slot: 'detail', prompt: '자세한 내용을 말씀해 주세요.', next: 'n_q3' },
    n_q3: { id: 'n_q3', kind: 'Collect', slot: 'extra', prompt: '더 필요한 것이 있으십니까?', next: 'n_bye' },
    n_bye: { id: 'n_bye', kind: 'Say', text: '감사합니다.' },
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
