// 유지 루프까지 배선한 브리지 예시 — 비-Node 호스트가 복사해 간다.
//
// `reference-core.mjs` 는 통화 경로만 꿴다. 그 상태로 운영하면 **비-Node 호스트에서는
// 유지 루프가 한 번도 돌지 않는다**: Core 는 타이머를 돌리지 않으므로(몰래 켠 인터벌은 끌 수도
// 없다) 만료 수렴·복구 확인·readiness·상담사 응답은 호스트가 불러야 하고, 브리지에 그 자리가
// 없던 동안 부를 길이 아예 없었다. 증상은 전부 예외가 아니다 —
//  - 만료된 오퍼가 열린 채 쌓여 같은 콜이 두 번 제안되고, 그 통화는 §9.3 대안으로도 가지 않는다,
//  - 한 번 폴백으로 내려간 테넌트는 엔진이 돌아와도 영구히 그대로 남는다,
//  - `/health` 는 모든 통화가 상담사 직결로 떨어진 순간에도 초록이다.
//
// 이 파일이 내놓는 값은 **예시이며 기본값이 아니다**(§13-3). 응답 한도·재배정 한도·프로브 간격·
// 제한 시간·후보 상담사 목록과 순서는 회선·상품·상담사 수에 따라 다르고 사람이 정한다.
// 실프로브(합성콜·핑)·실회선 연결은 **[승인 필요]** 다 — 여기 프로브는 아무것도 부르지 않는다.
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

const QUEUES = [
  { id: 'q_default', tenantId: 'reference', titleKo: '기본 큐', skills: [], closedAction: 'callback' },
];

export default function createCore() {
  const port = createChannelPort({ id: 'callbot' });
  const health = createHealthRegistry([]);
  let offerSeq = 0;

  const core = createConversationCore({
    scope,
    flows: createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'reference', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health,
    routing: {
      config: { tenantId: 'reference', queues: QUEUES, rules: [], defaultQueueId: 'q_default' },
      // 큐 실측은 호스트가 조회해 준다 — Core 는 대기 인원·상담사 수를 추정하지 않는다(§13-3).
      snapshots: () => [{ queueId: 'q_default', waiting: 0, availableAgents: 1, observedAt: new Date().toISOString() }],
      offers: {
        // 한도에 기본값이 없다(§13-3). 여기 숫자는 예시다.
        policy: { timeoutMs: 20000, maxAttempts: 2 },
        // 후보 **순서 그대로** 쓴다 — 정렬을 넣는 순간 그것이 배분 정책이 된다.
        candidates: () => ['a_reference_1', 'a_reference_2'],
        // 추측 가능한 id 는 그 자체가 열쇠다(§10.3). 실운영에서는 난수를 쓴다.
        newOfferId: () => { offerSeq += 1; return `o_reference_${offerSeq}`; },
      },
    },
    recovery: {
      // 간격·제한 시간에 기본값이 없다(§13-3). 프로브 구현은 **[승인 필요]** 이며 여기 것은
      // 아무것도 부르지 않는다 — 돌아가지 않는 프로브를 배선해 두면 보고서에 "확인 중"으로 남으므로,
      // 예시에서도 **판정 가능한 값**(여기서는 항상 정상)을 돌려준다.
      schedules: [{
        intervalMs: 30000,
        timeoutMs: 2000,
        probe: {
          component: 'telephony',
          // 관측 시각은 프로브가 적는다 — 실프로브는 여기서 회선을 찌른다(**[승인 필요]**).
          check: async () => ({ component: 'telephony', state: 'up', observedAt: new Date().toISOString() }),
        },
      }],
    },
  });

  return {
    core,
    scope,
    port,
    /**
     * 브리지에 열어 줄 유지 루프. **기본은 전부 닫힘**이므로 여기서 켠다 —
     * 켜지 않으면 그 op 는 `E_NOT_WIRED` 로 거절되고 종전과 완전히 같다.
     *
     * `readiness` 의 제한 시간·프로브는 운영 합의값이라 Core 가 만들지 않는다. 호스트가 줄마다
     * 다시 선언하게 두면 같은 `/health` 가 호출마다 다른 기준으로 판정되므로(§2) 여기서 한 번 정한다.
     * 의존성 프로브는 호스트 몫이며 실연결은 **[승인 필요]** 다 — 여기서는 선언하지 않는다
     * (그래서 응답에는 Core 가 아는 §9.3 사실만 실린다).
     */
    maintenance: {
      warnings: true,
      recoveryProbe: true,
      offerExpiry: true,
      settleOffer: true,
      readiness: { timeoutMs: 2000 },
    },
  };
}
