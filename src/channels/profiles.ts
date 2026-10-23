// 채널 능력 프로파일 — Callbot(voice)·Chatbot(chat)·D-ARS(visual)의 기본 선언.
// 설계서 §5.1(폴백 사다리)·§5.2(voice→visual 전환)·§5.3(단일 시나리오)·§9.3(장애 폴백).
//
// 세 저장소가 각자 capabilities 를 손으로 적으면, 같은 채널인데 값이 서로 다른 상황이 생긴다.
// 그러면 Flow 사전검증(checkFlowSupported)이 저장소마다 다른 답을 내고, "하나의 Flow"라는 전제가 깨진다.
// 그래서 기본값은 여기 한 곳에 둔다. 고객사 사정으로 달라지는 항목(기존 IVR 유무 등)만 덮어쓴다.
import type { ChannelAdapterId, ChannelCapabilities } from './contract.ts';
import { ADAPTER_CHANNEL } from './contract.ts';
import type { ComponentId } from '../ops/fallback.ts';
import { CHANNEL_DEPENDENCIES } from '../ops/fallback.ts';

/**
 * 기본 프로파일. 여기 값은 "매체가 원리적으로 할 수 있는가"이지 고객사 계약 상태가 아니다.
 * 예: routeToLegacyIvr 는 기존 IVR이 있는 고객사에서만 true 가 되므로 기본은 false 다.
 */
export const CHANNEL_PROFILES: Record<ChannelAdapterId, ChannelCapabilities> = {
  // 음성: 화면이 없으므로 버튼 렌더 불가. DTMF가 §5.1 폴백의 핵심 수단이다.
  callbot: {
    adapter: 'callbot', channel: 'voice',
    dtmf: true, richUi: false, speech: true,
    transferToAgent: true, routeToLegacyIvr: false, crossChannelInvite: true,
  },
  // 채팅: 버튼·폼은 되지만 음성 합성·DTMF는 없다. 통화가 아니므로 IVR 회귀도 없다.
  chatbot: {
    adapter: 'chatbot', channel: 'chat',
    dtmf: false, richUi: true, speech: false,
    transferToAgent: true, routeToLegacyIvr: false, crossChannelInvite: false,
  },
  // D-ARS(Visual IVR): 통화에 붙는 화면. 화면에서 상담사 연결은 가능하지만 회선 회귀는 통화측(Callbot)이 한다.
  dars: {
    adapter: 'dars', channel: 'visual',
    dtmf: false, richUi: true, speech: false,
    transferToAgent: true, routeToLegacyIvr: false, crossChannelInvite: false,
  },
};

/**
 * 채널이 헬스를 올릴 수 있는 컴포넌트(§9.3). 선언하지 않은 컴포넌트의 샘플은 Core가 무시한다.
 *
 * **§9.3 의존 목록을 다시 적지 않는다**(§2). 종전에는 이 표와 `CHANNEL_DEPENDENCIES`
 * (`ops/fallback.ts`)가 같은 목록을 두 벌 들고 있었다 — 값은 같았지만, 한쪽만 늘어나는 날의
 * 결말이 둘 다 조용하다.
 *  - **판정 쪽만 늘면**(`CHANNEL_DEPENDENCIES` 에 컴포넌트가 추가되고 이 표는 그대로) 그
 *    컴포넌트의 샘플은 선언 밖이라 `reportHealth` 가 무시한다. `treatUnknownAsDown: false` 면
 *    그 엔진이 죽어도 판정은 영구히 `normal` 이고(고객은 "말을 못 알아듣는다"로 겪는다),
 *    `true` 면 전부 정상인데도 그 채널이 **영구히** 폴백에 남는다.
 *  - **선언 쪽만 늘면** 채널은 성실히 올리는데 판정이 그 값을 한 번도 읽지 않는다.
 * 어느 쪽도 예외가 나지 않으므로, 목록은 `CHANNEL_DEPENDENCIES` 하나에서 파생시킨다.
 * 더 좁게 올리는 채널은 등록에서 `reportsComponents` 로 선언한다(좁히는 것은 안전하다 —
 * 모자란 샘플은 `unknown` 으로 드러나고, 넓히는 것만 남의 채널 판정을 움직인다).
 */
export const CHANNEL_COMPONENTS: Record<ChannelAdapterId, ComponentId[]> = Object.fromEntries(
  (Object.keys(ADAPTER_CHANNEL) as ChannelAdapterId[])
    .map((id) => [id, [...CHANNEL_DEPENDENCIES[ADAPTER_CHANNEL[id]]]]),
) as Record<ChannelAdapterId, ComponentId[]>;

/**
 * 고객사별 차이만 덮어쓴다. adapter·channel 은 덮어쓸 수 없다 —
 * 이 둘이 어긋나면 계약 검증(validateRegistration)에서 등록이 거부된다.
 */
export function profileFor(id: ChannelAdapterId, override: Partial<Omit<ChannelCapabilities, 'adapter' | 'channel'>> = {}): ChannelCapabilities {
  return { ...CHANNEL_PROFILES[id], ...override, adapter: id, channel: ADAPTER_CHANNEL[id] };
}
