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
