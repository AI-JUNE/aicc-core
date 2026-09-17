// 진입점 제한이 켜진 참조 Core 모듈 — 브리지 실행기의 제한기 전달 경로를 실제로 돌려 보는 예시.
//
// 왜 별도 파일인가: `reference-core.mjs` 는 "복사해서 시작하는 최소 예시"라 한도가 없어야 한다.
// 한도가 든 예시를 복사하면 그 숫자가 곧 고객사 정책이 된다(§13-3). 반대로 제한을 어디에도
// 켜 보지 않으면, 브리지가 제한을 지원한다는 말은 **아무도 지나가 보지 않은 길**로 남는다.
//
// 여기 숫자(burst 2)는 정책이 아니라 **검사용**이다 — 세 번째 send 가 거절되는 것을 보기 위한 값이다.
// 운영 한도는 계약·운영 합의에서 오며 Core 가 정하지 않는다.
//
// 실회선·실엔진에 붙지 않는다. 기본 dry_run 이며 live 는 [승인 필요].
import { createConversationCore, createMemoryFlowRegistry } from '../src/channels/runtime.ts';
import { createChannelPort } from '../src/channels/basePort.ts';
import { CHANNEL_COMPONENTS } from '../src/channels/profiles.ts';
import { createHealthRegistry } from '../src/ops/fallback.ts';
import { createRateLimiter } from '../src/api/rateLimit.ts';
import { flows, scope } from './reference-core.mjs';

export { scope, flows };

export default function createCore() {
  const port = createChannelPort({ id: 'callbot' });
  const core = createConversationCore({
    scope,
    flows: createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: scope.tenantId, staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: createHealthRegistry([]),
  });
  // refillPerSec 를 0 에 가깝게 두어 검사 도중 한도가 저절로 회복되지 않게 한다 —
  // 회복되면 "거절되는 것을 봤다"가 시간에 따라 참이 되기도, 거짓이 되기도 한다.
  const rateLimiter = createRateLimiter({ rule: { burst: 2, refillPerSec: 0.001 } });
  return { core, scope, port, rateLimiter };
}
