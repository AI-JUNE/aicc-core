// AI 고지 실행 — 설계서 §7 7.4 · §10.1(AI 고지) · §5.2(채널 전환) · §11.1(테넌트 격리) · §13-3(임의값 금지).
//
// `portal/aiDisclosure.ts` 는 머리말에 "런타임이 세션 시작 시 호출한다"고 적어 두었고 판정
// (`resolveDisclosure`)·설정 검증(`validateDisclosureConfig`)까지 갖췄는데, **저장소 전체에서 그
// 함수를 부르는 곳이 테스트뿐이었다.** 즉 지금까지 어떤 채널에서도 AI 고지가 고객에게 나간 적이
// 없다. 이 공백의 증상은 예외가 아니라 **아무 일도 일어나지 않는 것**이라 가장 오래 산다 —
// 통화는 정상으로 끝나고, 이벤트도 정상이고, 적합성 검사도 통과한다. 드러나는 시점은 감독기관
// 점검이거나 민원이고, 그때는 이미 지나간 모든 통화가 대상이다.
//
// 빠진 것은 정책이 아니라 **판정을 채널이 렌더할 수 있는 물건으로 바꾸는 자리**였다. 그대로 두면
// 채널 3곳이 각자 "세션 시작 시 문구를 한 번 내보낸다"를 짜게 되고 — 열어 둔 브리지 앞에 아무도
// 쓰지 않은 30줄을 남겼을 때와 같은 실패다 — **각자 다르게 틀린다**. 실제로 그 30줄에서 조용히
// 빠지는 것은 정해져 있다: 채널이 바뀌면(§5.2 voice→visual) 새 매체에서 고지가 없다 ·
// 매 턴 고지가 반복돼 안내가 잡음이 된다 · 미승인 문구가 그대로 나간다 · 다른 테넌트의 문구가
// 섞여 고객이 남의 회사 이름을 듣는다.
//
// 하지 않는 것: 문구를 만들지 않는다(§13-3 — 업권·약관·감독기관에 따라 다르고, 법무 검토를 거친
// 테넌트 문구만 쓴다 **[승인 필요]**) · 판정을 복사하지 않는다(§2 — 사용 여부·승인·문구 존재
// 판정은 `resolveDisclosure` 하나이며 이 파일은 그 결과를 옮길 뿐이다) · 저장·발송하지 않는다.
import type { ChannelKind } from '../domain/types.ts';
import type { RenderedStep } from '../flow/types.ts';
import type { TenantScope } from '../core/tenancy.ts';
import { assertTenantScope } from '../core/tenancy.ts';
import type { AiDisclosureConfig, DisclosurePlacement } from '../portal/aiDisclosure.ts';
import { resolveDisclosure, validateDisclosureConfig } from '../portal/aiDisclosure.ts';

/**
 * 고지 단계의 노드 id. 시나리오 노드가 아니므로 `flow.nodes` 에 없다 —
 * 예약 접두사(`__`)를 쓰는 이유이며, 채널은 이 단계를 **그냥 Say 로 렌더하면 된다**.
 */
export const DISCLOSURE_NODE_ID = '__disclosure';

/** 고지를 내지 않은 이유. 셋 다 정상 경로다(위반이 아니다). */
export type DisclosureSkipCode =
  /** 이 세션에서 이 채널에는 이미 고지했다. 매 턴 반복하면 안내가 잡음이 된다. */
  | 'already_disclosed'
  /** 테넌트가 고지를 끈 상태. 법적 근거는 테넌트가 갖는다(설정 검증에서 경고로 드러난다). */
  | 'disabled'
  /** 이 채널의 문구가 설정되지 않았다. */
  | 'channel_not_configured'
  /** 문구가 비었으나 테넌트가 생략 가능으로 선언했다. */
  | 'optional';

/** 고지를 낼 수 없는데 생략할 근거도 없는 상태. AI 응대를 시작해서는 안 된다. */
export type DisclosureBlockCode = 'not_approved' | 'text_empty';

export type DisclosurePlan =
  | { action: 'show'; step: RenderedStep; placement: DisclosurePlacement; configVersion: number }
  | { action: 'skip'; code: DisclosureSkipCode; reasonKo: string }
  | { action: 'block'; code: DisclosureBlockCode; reasonKo: string };

export interface PlanDisclosureInput {
  /**
   * 테넌트 고지 설정. **고정 객체로 받는다** — 운영 중 문구를 고치면 `updateDisclosureText` 가
   * 승인을 무효화하는데(의도된 동작이다), 그 객체가 살아 있는 런타임에 그대로 물려 있으면
   * 저장 버튼 하나로 **진행 중이 아닌 모든 신규 통화가 거부된다**. 새 문구는 재배선으로 싣는다.
   */
  config: AiDisclosureConfig;
  scope: TenantScope;
  /** 지금 고객이 실제로 보고·듣고 있는 채널. 전환되면 새 매체의 고지가 필요하다(§5.2). */
  channel: ChannelKind;
  /** 이 세션에서 이미 고지한 채널 목록. */
  disclosedChannels: readonly ChannelKind[];
}

/**
 * 고지 계획. **문구를 만들지 않고, 판정을 복사하지 않는다.**
 *
 * 테넌트 격리 위반만 던진다(§11.1) — 다른 테넌트 문구가 나가면 고객이 남의 회사 이름을 듣고,
 * 그건 타입도 값도 멀쩡해서 어디서도 터지지 않는다. 그 외에는 어떤 경우에도 던지지 않는다:
 * 고지 판정이 예외로 끝나 통화가 끊기면 고지보다 더 큰 사고다.
 */
export function planDisclosure(input: PlanDisclosureInput): DisclosurePlan {
  assertTenantScope(input.scope);
  if (input.config.tenantId !== input.scope.tenantId) {
    throw new Error(
      `테넌트 격리 위반(AI 고지): 설정=${input.config.tenantId} 세션=${input.scope.tenantId} (설계서 §11.1)`,
    );
  }
  if (input.disclosedChannels.includes(input.channel)) {
    return { action: 'skip', code: 'already_disclosed', reasonKo: `${input.channel} 채널에는 이 세션에서 이미 고지했습니다.` };
  }

  const decision = resolveDisclosure(input.config, input.channel);
  if (decision.show) {
    const d = decision.disclosure;
    return {
      action: 'show',
      step: {
        channel: d.channel,
        nodeId: DISCLOSURE_NODE_ID,
        kind: 'Say',
        text: d.text,
        disclosure: { placement: d.placement, configVersion: d.configVersion },
      },
      placement: d.placement,
      configVersion: d.configVersion,
    };
  }
  if ('blocking' in decision) {
    return {
      action: 'block',
      code: decision.reason,
      reasonKo: decision.reason === 'not_approved'
        ? '법무 승인되지 않은 고지 문구입니다 — 승인 전 문구로 AI 응대를 시작할 수 없습니다(§10.1). [승인 필요]'
        : `'${input.channel}' 채널의 고지 문구가 비어 있고 생략 가능으로 선언되지도 않았습니다(§10.1).`,
    };
  }
  return {
    action: 'skip',
    code: decision.reason,
    reasonKo: decision.reason === 'disabled'
      ? 'AI 고지가 꺼져 있습니다 — 법적 근거는 테넌트가 확인합니다(§10.1).'
      : `'${input.channel}' 채널의 고지 문구가 설정되지 않았습니다(§10.1).`,
  };
}

export interface DisclosureBindingIssues {
  /** 하나라도 있으면 배선하지 않는다. */
  errorsKo: string[];
  /** 막지는 않되 운영이 반드시 보아야 하는 것. */
  warningsKo: string[];
}

/**
 * 배선 시점 검증. **통화 중이 아니라 여기서 걸러야 한다** — 미승인 문구·잘못된 노출 시점은
 * 설정 오류이지 런타임 장애가 아니고, 통과시키면 오타 하나로 고지가 조용히 꺼진 채
 * "적용했다"로 남는다(라우팅·전환·요청 제한기와 같은 규칙).
 *
 * `activeChannels` 에는 **실제로 등록된 채널만** 넘긴다. 셋을 다 넣으면 붙지도 않은 채널의
 * 문구가 없다고 경고가 나가고, 그 경고가 쌓이면 진짜 누락이 묻힌다.
 *
 * 판정 규칙은 `validateDisclosureConfig` 하나다 — 여기서 승인·문구·노출 시점을 다시 보지 않는다(§2).
 *
 * 워크스페이스는 보지 않는다 — `AiDisclosureConfig` 에 그 축이 없기 때문이다(고지 문구는 테넌트
 * 단위 법무 문안이다). 사업부별로 다른 문구가 필요해지면 그건 검사 누락이 아니라 **설정 모델의
 * 확장**이며, 그때까지 같은 테넌트의 워크스페이스는 같은 문구를 쓴다.
 */
export function validateDisclosureBinding(
  config: AiDisclosureConfig,
  scope: TenantScope,
  activeChannels: readonly ChannelKind[],
): DisclosureBindingIssues {
  const errorsKo: string[] = [];
  const warningsKo: string[] = [];
  if (config.tenantId !== scope.tenantId) {
    errorsKo.push(`다른 테넌트의 고지 설정입니다: 설정=${config.tenantId} 코어=${scope.tenantId} (설계서 §11.1)`);
  }
  for (const issue of validateDisclosureConfig(config, [...activeChannels]).issues) {
    (issue.severity === 'error' ? errorsKo : warningsKo).push(issue.message);
  }
  return { errorsKo, warningsKo };
}
