// 관측 배선을 켠 참조 Core — 비-Node 호스트(Callbot 파이썬 에이전트 등)가 복사해 간다.
//
// `reference-core.mjs` 와 다른 점은 하나뿐이다: **로거·수집기 배선(`observability`)을 함께
// 내놓는다.** 내놓지 않으면 브리지 경계의 실패(깨진 JSONL 줄·모르는 op·다른 테넌트 주장·
// 요청 한도 초과)가 **이 프로세스 바깥에서 보이지 않는다** — 그 실패들은 Core 를 부르기
// 전에 응답 줄로 끝나므로 Core 로그는 완전히 조용하다.
//
// **같은 배선 객체를 런타임과 브리지에 함께 준다.** 관측기는 둘이 되지만 로거·수집기가
// 하나라서 중복 억제·창 상한이 같은 기준으로 돌고, 진입점 줄과 경계 줄이 한 스트림에 섞인다.
//
// ★ 로그를 **표준출력에 쓰면 프로토콜이 깨진다** — 브리지 응답과 로그 줄이 같은 스트림에
//   섞여 호스트의 JSON 파서가 죽는다. 그래서 여기서는 표준오류로 쓴다. 상용에서는 파일·
//   수집기로 보낸다(수집기 전송 연결은 **[승인 필요]**).
//
// 임계값(최소 수준·중복 억제 창·창당 상한)은 운영이 정하는 값이라 여기서 정하지 않는다(§13-3).
// 실고객 자료·개인정보를 담지 않는다(§10.3).
import { createConversationCore, createMemoryFlowRegistry } from '../src/channels/runtime.ts';
import { createChannelPort } from '../src/channels/basePort.ts';
import { CHANNEL_COMPONENTS } from '../src/channels/profiles.ts';
import { createHealthRegistry } from '../src/ops/fallback.ts';
import { createLogger, formatLine } from '../src/obs/logger.ts';
import { createErrorMonitor } from '../src/obs/errorMonitor.ts';

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
  const observability = {
    logger: createLogger({
      minLevel: 'debug',
      // 표준출력이 아니다(위 ★). 호스트는 여기를 자기 수집기·파일로 바꾼다.
      sink: (rec) => process.stderr.write(`${formatLine(rec)}\n`),
    }),
    // transport 를 주지 않으면 완전한 no-op 이다 — 실제 수집기 전송은 **[승인 필요]**.
    monitor: createErrorMonitor({ transport: (r) => process.stderr.write(`${JSON.stringify(r)}\n`) }),
  };
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
    observability,
  });
  return {
    core,
    scope,
    port,
    observability,
    /**
     * 관측 실측을 호스트가 읽게 열어 둔다. **배선을 켠 것만으로는 부족하다** —
     * `failed`·`droppedIds` 는 그 두 결함의 유일한 신호이고(로거·수집기가 던지는 상태,
     * 호스트의 id 가 §10.3 패턴에 걸려 로그에서 빠지는 상태) 둘 다 예외가 아니라 **수치로만**
     * 나타난다. 비-Node 호스트에는 그 수치를 읽을 자리가 없었고, 그래서 "로그를 붙였다"와
     * "로그가 나가고 있다"가 바깥에서 구분되지 않았다.
     *
     * 나머지 유지 루프는 여기서 열지 않는다 — 이 예시의 Core 에는 오퍼·복구 배선이 없고,
     * 열면 `hello` 가 "열렸다"고 알린 op 가 `E_NOT_WIRED` 를 돌려준다
     * (유지 루프까지 꿴 예시는 `reference-core-maintained.mjs` 다).
     */
    maintenance: { observability: true },
  };
}
