import { test } from 'node:test';
import assert from 'node:assert/strict';

let P = null, C = null;
try {
  P = await import('../src/channels/profiles.ts');
  C = await import('../src/channels/contract.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: P ? false : '타입 스트리핑 미지원 런타임' };

const portOf = (id, over = {}) => ({
  id, capabilities: P.profileFor(id, over),
  present: async () => {}, transfer: async () => {}, end: async () => {},
  routeToLegacyIvr: async () => {}, invite: async () => {},
});

test('세 채널 기본 프로파일은 계약 검증을 통과한다', b, () => {
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const issues = C.validateRegistration({
      port: portOf(id), reportsComponents: P.CHANNEL_COMPONENTS[id], contractVersion: C.CHANNEL_CONTRACT_VERSION,
    });
    assert.deepEqual(issues.filter((i) => i.severity === 'error'), [], `${id} 등록 오류`);
  }
});

test('채널 종류는 덮어쓸 수 없다', b, () => {
  const caps = P.profileFor('chatbot', { adapter: 'callbot', channel: 'voice', richUi: false });
  assert.equal(caps.adapter, 'chatbot');
  assert.equal(caps.channel, 'chat');
  assert.equal(caps.richUi, false);
});

test('음성은 DTMF로, 화면 채널은 버튼으로 선택지를 렌더한다(§5.3)', b, () => {
  const flow = {
    id: 'f', version: 1, startNodeId: 'pick',
    nodes: { pick: { id: 'pick', kind: 'Choice', prompt: '무엇을 도와드릴까요?', options: [{ label: '요금', value: 'fee' }] } },
  };
  assert.deepEqual(C.checkFlowSupported(flow, P.profileFor('callbot')), []);
  assert.deepEqual(C.checkFlowSupported(flow, P.profileFor('dars')), []);
  // 입력 수단이 하나도 없으면 렌더 불가로 걸러진다
  const issues = C.checkFlowSupported(flow, P.profileFor('chatbot', { richUi: false }));
  assert.equal(issues[0].code, 'E_MISSING_CAPABILITY_IMPL');
});

test('폴백 경로가 하나도 없는 설정은 경고로 드러낸다(§9.3)', b, () => {
  const issues = C.validateRegistration({
    port: portOf('chatbot', { transferToAgent: false }),
    reportsComponents: P.CHANNEL_COMPONENTS.chatbot,
    contractVersion: C.CHANNEL_CONTRACT_VERSION,
  });
  assert.ok(C.registrationOk(issues));
  assert.ok(issues.some((i) => i.code === 'W_NO_FALLBACK_PATH'));
});

test('선언한 헬스 컴포넌트는 채널 의존성 안에 있다(§9.3)', b, async () => {
  const F = await import('../src/ops/fallback.ts');
  for (const id of ['callbot', 'chatbot', 'dars']) {
    const deps = F.CHANNEL_DEPENDENCIES[C.ADAPTER_CHANNEL[id]];
    for (const comp of P.CHANNEL_COMPONENTS[id]) {
      assert.ok(deps.includes(comp), `${id}가 무관한 컴포넌트를 선언함: ${comp}`);
    }
  }
});

// ── §9.3 의존 목록은 한 벌이다(§2) ───────────────────────────────────────────
//
// 위 검사는 **부분집합**만 본다 — 모자란 쪽을 잡지 못한다. 그런데 모자란 쪽이 더 조용하다:
// `CHANNEL_DEPENDENCIES` 에만 컴포넌트가 늘면 그 샘플은 선언 밖이라 `reportHealth` 가
// 무시하고, `treatUnknownAsDown: false` 면 그 엔진이 죽어도 판정은 영구히 `normal` 이며
// (고객은 "말을 못 알아듣는다"로 겪는다) `true` 면 전부 정상인데도 그 채널이 영구히 폴백에
// 남는다. 그래서 파생 관계 자체를 고정한다.

test('채널별 헬스 선언은 CHANNEL_DEPENDENCIES 에서 파생된다 — 두 벌이 되면 실패한다', b, async () => {
  const F = await import('../src/ops/fallback.ts');
  for (const id of Object.keys(C.ADAPTER_CHANNEL)) {
    assert.deepEqual(
      P.CHANNEL_COMPONENTS[id],
      [...F.CHANNEL_DEPENDENCIES[C.ADAPTER_CHANNEL[id]]],
      `${id} 의 선언이 §9.3 의존 목록과 다르다 — 한쪽만 늘면 둘 다 조용히 틀린다`,
    );
  }
  // 파생이므로 고쳐도 원본이 바뀌지 않는다(사본을 돌려준다).
  P.CHANNEL_COMPONENTS.callbot.push('messaging');
  try {
    assert.ok(
      !F.CHANNEL_DEPENDENCIES.voice.includes('messaging'),
      '선언 표를 고치면 폴백 판정의 의존 목록까지 바뀐다',
    );
  } finally {
    P.CHANNEL_COMPONENTS.callbot.pop();
  }
});

test('profiles.ts 가 컴포넌트 목록을 다시 적지 않는다(§2)', b, async () => {
  const { readFileSync } = await import('node:fs');
  const F = await import('../src/ops/fallback.ts');
  const src = readFileSync(new URL('../src/channels/profiles.ts', import.meta.url), 'utf8')
    .split('\n').filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join('\n');
  for (const literal of src.matchAll(/\[[^[\]]*\]/g)) {
    const members = [...literal[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(
      !members.some((m) => F.COMPONENT_IDS.includes(m)),
      `컴포넌트 목록 사본이 생겼다 — 늘어난 것을 모르는 쪽만 조용히 틀린다:\n${literal[0]}`,
    );
  }
});

test('기본 선언으로 등록하면 §9.3 판정이 보는 컴포넌트를 전부 올릴 수 있다', b, async () => {
  const R = await import('../src/channels/runtime.ts');
  const F = await import('../src/ops/fallback.ts');
  const BP = await import('../src/channels/basePort.ts');
  const scope = { tenantId: 'goone' };
  const flow = { id: 'f', version: 1, startNodeId: 'n', nodes: { n: { id: 'n', kind: 'Say', text: '안녕하세요.' } } };
  const NOW = '2026-10-23T09:00:00.000Z';
  for (const id of Object.keys(C.ADAPTER_CHANNEL)) {
    const port = BP.createChannelPort({ id });
    const core = R.createConversationCore({
      scope,
      flows: R.createMemoryFlowRegistry([flow]),
      channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS[id], contractVersion: 1 }],
      policy: {
        tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
        legacyIvrAvailable: false, agentQueueAvailable: true,
      },
      health: F.createHealthRegistry([]),
      now: () => NOW,
    });
    const deps = F.CHANNEL_DEPENDENCIES[C.ADAPTER_CHANNEL[id]];
    const receipt = core.reportHealth({
      adapter: id,
      observedAt: NOW,
      samples: deps.map((component) => ({ component, state: 'up', observedAt: NOW })),
    });
    assert.equal(
      receipt.ignored, 0,
      `${id}: §9.3 판정이 읽는 컴포넌트의 샘플이 선언 밖이라 버려졌다 — 그 엔진 상태는 영구히 unknown 이다`,
    );
    assert.equal(receipt.accepted, deps.length);
  }
});
