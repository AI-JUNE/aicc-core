// §5.2 화면 전환(voice→visual)이 **실제로 일어나는** 예시 Core — 비-Node 호스트가 복사해 간다.
//
// 왜 이 픽스처가 따로 있는가: `reference-core.mjs` 로는 전환이 토큰 없는 종전 경로로만 일어난다
// (전환 배선이 없다). 그래서 1회용 토큰이 실린 전환을 음성 호스트가 **손에 쥐는** 경로를 한 번도
// 지나지 않는다. 그 경로의 실패는 예외가 아니라 **반쪽짜리 전환**이다: Core 는 `state.channel` 을
// 화면으로 바꿔 이후 단계를 화면용으로 렌더하는데(통화 중인 고객이 그것을 듣는다) **링크는
// 아무도 보내지 않는다** — 고객은 오지 않는 화면을 기다리고, §5.1 사다리는 이미 전환을 골랐으므로
// 상담사로 내려가지도 않는다. 어디에서도 예외가 나지 않으므로 검사가 없으면 영영 드러나지 않는다.
//
// 전환이 **성립하려면** 세 가지가 필요하다(§5.2): 전환 가능한 음성 채널 · 목적지 채널(D-ARS)의
// 등록 · 고객 단말 수신 확인(`reachable`). 셋 중 하나라도 없으면 사다리는 전환을 고르지 않고
// 다음 칸(상담사)으로 간다 — 그래서 여기서 셋을 다 준다.
//
// 이 파일의 값은 **예시이며 기본값이 아니다**(§13-3): 링크 유효기간·승계 슬롯 allowlist·발송
// 수단은 테넌트 운영값이고, 토큰 발급기는 호스트가 주입한다(Core 가 만들면 추측 가능한 열쇠가
// 된다). 실발신(SMS·알림톡)은 하지 않는다 — **[승인 필요]**. 개인정보를 담지 않는다(§10.3).
import { createConversationCore, createMemoryFlowRegistry } from '../src/channels/runtime.ts';
import { createChannelPort } from '../src/channels/basePort.ts';
import { CHANNEL_COMPONENTS } from '../src/channels/profiles.ts';
import { createHealthRegistry } from '../src/ops/fallback.ts';
import { createInviteRegistry } from '../src/core/channelSwitch.ts';

export const scope = { tenantId: 'reference' };

export const flows = [{
  id: 'f_reference_voice',
  version: 1,
  startNodeId: 'n_ask',
  nodes: {
    // §5.1 사다리는 **같은 입력 대기에서 2회 실패**할 때 화면 전환을 고른다(1회는 재프롬프트).
    // 그래서 전환을 지나려면 수집 노드가 하나 있으면 된다 — 무음·미인식 두 번이면 닿는다.
    n_ask: { id: 'n_ask', kind: 'Collect', slot: 'purpose', prompt: '용건을 말씀해 주세요.', next: 'n_bye' },
    n_bye: { id: 'n_bye', kind: 'Say', text: '감사합니다.' },
  },
}];

/**
 * 발송 경로 장애 드릴(§5.2). **환경변수로만 켜지고, 실발신은 하지 않는다**.
 *
 * 왜 여기 있는가: 초대 지시가 매체에서 거부되는 경우에 Core 가 하는 일은 "사실을 남기고 턴의
 * 나머지를 그대로 내보내는 것"이고(`switchInvite.notDeliveredKo`), 비-Node 호스트가 그 사실을
 * 받는 자리는 턴 응답 하나뿐이다. 그런데 드라이런 포트의 초대는 **언제나 접수되므로** 그
 * 호스트는 자기 처리 경로를 한 번도 지나 볼 수 없다 — 그 상태에서 호스트가 보는 것은
 * `ticketIssued: true` 뿐이고, 그러면 "링크를 보냈다"로 읽는다(고객은 오지 않는 화면을
 * 기다리고 세션은 이미 화면 채널로 옮겨 가 있다). 그래서 거부를 **한 줄로 재현**할 수 있게 둔다.
 *
 * 베이스 포트를 감싸기만 한다 — 다른 지시는 전부 종전대로 베이스가 처리한다(§2).
 */
function withInviteRejectionDrill(base) {
  if (process.env.AICC_REF_SWITCH_INVITE !== 'reject') return base;
  return {
    id: base.id,
    capabilities: base.capabilities,
    present: (id, steps) => base.present(id, steps),
    transfer: (id, queue, summaryMasked) => base.transfer(id, queue, summaryMasked),
    end: (id, reasonKo) => base.end(id, reasonKo),
    // 거부는 Core 에 닿아야 한다(베이스의 `surfaced` 와 같은 규칙) — 삼키면 Core 는
    // "링크를 보냈다"로 적는다. 사유 문구에 수신번호·링크를 싣지 않는다(§10.3).
    invite: async () => { throw new Error('발송 게이트웨이가 초대를 거부했습니다(드릴)'); },
  };
}

export default function createCore() {
  const port = withInviteRejectionDrill(createChannelPort({ id: 'callbot' }));
  // 목적지 채널. 등록되지 않았으면 전환은 **성립하지 않는다**(링크를 열 화면이 없다).
  const visualPort = createChannelPort({ id: 'dars' });
  let issued = 0;
  const core = createConversationCore({
    scope,
    flows: createMemoryFlowRegistry(flows),
    channels: [
      { port, reportsComponents: CHANNEL_COMPONENTS.callbot, contractVersion: 1 },
      { port: visualPort, reportsComponents: CHANNEL_COMPONENTS.dars, contractVersion: 1 },
    ],
    policy: {
      tenantId: 'reference', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: createHealthRegistry([]),
    channelSwitch: {
      // 인메모리는 단일 프로세스용 예시다. 영속 구현으로 교체한다(§6.2) — 재기동으로 발급된
      // 초대가 사라지면 고객이 받은 링크가 "모르는 초대"가 된다.
      invites: createInviteRegistry(),
      // 토큰은 **호스트가 만든다**(§13-3). 예시는 순번이지만 운영에서는 추측 불가능한 값이어야
      // 하고, interactionId 를 섞으면 Core 가 발급을 거절한다(id 가 곧 열쇠가 되는 것을 막는다).
      newToken: () => `tk_reference_${++issued}`,
      ttlMs: 300000,
      // 승계 슬롯은 **허용한 것만** 화면으로 넘어간다(§10.3). 빈 목록이면 아무것도 넘기지 않는다.
      carry: { allow: [] },
      // **추정하지 않는다**(§13-3): 호스트가 관측한 값만. 예시는 항상 수신 가능으로 둔다.
      reachable: () => true,
      // 발송 수단은 **기록값**이다 — Core 는 발송하지 않는다(실발신 **[승인 필요]**).
      delivery: 'sms',
    },
  });
  return {
    core,
    scope,
    port,
    /**
     * 초대 정리를 열어 둔다(§5.2·§10.3). **기본은 닫힘**이므로 켜지 않으면 비-Node 호스트에는
     * 부를 자리가 없고, 그러면 발급된 초대는 레지스트리에서 **나가지 않는다** — 상환·만료는
     * 상태만 바꾼다. 음성 에이전트는 며칠을 살고 초대 안에는 승계 슬롯 스냅샷이 들어 있으므로,
     * 그 상태의 증상은 장애가 아니라 **지나간 전환 전부가 프로세스 안에 남아 있는 것**이다.
     *
     * **주기는 여기서 정하지 않는다**(§13-3): 발급 빈도·유효기간에 따라 다르고 호스트가 정한다.
     * 아직 유효한 초대는 걷히지 않으므로 자주 불러도 고객의 링크를 태우지 않는다.
     */
    maintenance: { inviteExpiry: true },
  };
}
