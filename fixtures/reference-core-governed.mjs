// §10.1 고지·동의와 §7 5.2 준수 점검까지 배선한 브리지 예시 — 비-Node 호스트가 복사해 간다.
//
// `reference-core.mjs` 는 통화 경로만 꿴다. 그 상태로 운영하면 세 가지가 **조용히** 빠진다 —
// 전부 통화·이벤트·헬스가 정상인 채로 빠지므로 어디에서도 터지지 않는다:
//  - 고지 미배선 → **어떤 채널에서도 AI 고지가 나가지 않는다**(§10.1·§7 7.4). 드러나는 시점이
//    감독기관 점검이면 대상은 지나간 통화 전부다.
//  - 동의 미배선 → 고객의 "네"는 `Confirm` 슬롯 값으로만 남고 **동의 기록은 0건**이며, pii
//    파라미터를 선언한 §6.1 업무시스템 조회는 동의 컨텍스트가 없어 **언제나 막힌다**(업무시스템은
//    멀쩡하므로 "그 메뉴만 안 된다"로만 나타난다).
//  - 점검 미배선 → **어떤 세션도 점검되지 않는다**. 리포트가 비는 것이 아니라 리포트 자체가
//    없어서 "점검이 돌고 있다"와 바깥에서 구분되지 않는다.
//
// 이 파일이 내놓는 값은 **예시이며 기본값이 아니다**(§13-3). 고지 문안·동의 목적·필수 여부·
// 보유기간·금칙어 목록은 테넌트 법무·컴플라이언스가 정하고 승인한다 — **[승인 필요]**.
// 실고객 자료·개인정보를 담지 않는다(§10.3).
import { createConversationCore, createMemoryFlowRegistry } from '../src/channels/runtime.ts';
import { createChannelPort } from '../src/channels/basePort.ts';
import { CHANNEL_COMPONENTS } from '../src/channels/profiles.ts';
import { createHealthRegistry } from '../src/ops/fallback.ts';
import { createMemoryConsentStore } from '../src/consent/executeConsent.ts';

export const scope = { tenantId: 'reference' };

/** 고지 문구에 쓴 핵심 어구. 점검 규칙과 **같은 값을 가리켜야** 한다(§2 — 두 벌로 적지 않는다). */
const DISCLOSURE_MARKER = 'AI 상담';

export const flows = [{
  id: 'f_reference_voice',
  version: 1,
  // 동의 질문은 **시나리오 노드**다(`__consent:<목적>` id 를 가진 Confirm) — Core 는 그 노드에서
  // 확정된 답만 기록으로 바꾼다. 노드가 없으면 필수 동의는 영원히 미획득으로 남는다.
  startNodeId: '__consent:recording',
  nodes: {
    '__consent:recording': {
      id: '__consent:recording', kind: 'Confirm',
      prompt: '상담 품질을 위해 통화를 녹취합니다. 동의하십니까?', next: 'n_ask',
    },
    n_ask: { id: 'n_ask', kind: 'Collect', slot: 'purpose', prompt: '용건을 말씀해 주세요.', next: 'n_bye' },
    n_bye: { id: 'n_bye', kind: 'Say', text: '감사합니다.' },
  },
}];

export default function createCore() {
  const port = createChannelPort({ id: 'callbot' });
  const core = createConversationCore({
    scope,
    flows: createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'reference', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: createHealthRegistry([]),
    // §10.1 AI 고지. `approved: false` 인 문안은 배선 자체가 거부된다 — 미승인 문구가 고객에게
    // 나가는 쪽보다 기동이 막히는 쪽이 되돌릴 수 있다.
    disclosure: {
      tenantId: 'reference',
      enabled: true,
      channels: {
        voice: { text: `${DISCLOSURE_MARKER} 안내입니다. 상담원 연결을 원하시면 말씀해 주세요.`, placement: 'session_start' },
      },
      version: 3,
      updatedAt: '2026-01-02T00:00:00Z',
      updatedBy: 'legal@example',
      approved: true,
      approvedAt: '2026-01-02T00:00:00Z',
      approvedBy: 'legal@example',
    },
    // §10.1 동의. 정책·저장소는 **고정으로 받는다** — 운영 중 바꾸면 진행 중인 통화의 동의가
    // 다른 버전으로 기록되고, 어떤 문구로 받은 동의인지 추적할 수 없게 된다.
    consent: {
      policy: {
        tenantId: 'reference',
        requirements: [{ purpose: 'recording', required: true }],
        version: 2,
        updatedAt: '2026-01-02T00:00:00Z',
        updatedBy: 'legal@example',
        approved: true,
      },
      // 인메모리는 단일 프로세스용 예시다. 영속 구현으로 교체한다(§6.2).
      records: createMemoryConsentStore(),
      // 주체 참조는 **호스트가 만든다**(§10.3) — 해시·고객키만이며 Core 는 만들지 않는다.
      // `interactionId` 를 주체로 쓰지 않는다: 통화마다 주체가 달라져 재동의가 쌓이지 않는다.
      subjectRef: () => 'sha256:reference-subject',
    },
    // §7 5.2 준수 점검. 표식·금칙어는 Core 가 만들지 않는다 — 여기 값은 예시다(**[승인 필요]**).
    qa: {
      disclosureMarkers: [DISCLOSURE_MARKER],
      forbiddenPhrases: [
        { id: 'f_guarantee', phrase: '무조건 승인', severity: 'major', reasonKo: '확정적 표현 금지' },
      ],
    },
  });
  return { core, scope, port };
}
