import { test } from 'node:test';
import assert from 'node:assert/strict';

let c = null;
try { c = await import('../src/channels/contract.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: c ? false : '타입 스트리핑 미지원 런타임' };

const caps = (over = {}) => ({
  adapter: 'callbot', channel: 'voice', dtmf: true, richUi: false, speech: true,
  transferToAgent: true, routeToLegacyIvr: false, crossChannelInvite: false, ...over,
});
const port = (over = {}) => ({
  id: 'callbot',
  capabilities: caps(over.capabilities),
  present: async () => {}, transfer: async () => {}, end: async () => {},
  ...over,
});
const reg = (over = {}) => ({
  port: port(over.port ?? {}),
  reportsComponents: ['telephony', 'stt', 'tts'],
  contractVersion: c ? c.CHANNEL_CONTRACT_VERSION : 1,
  ...over,
});

test('정상 등록은 오류 없음', b, () => {
  const issues = c.validateRegistration(reg());
  assert.deepEqual(issues.filter((i) => i.severity === 'error'), []);
  assert.ok(c.registrationOk(issues));
});

test('계약 버전이 다르면 등록을 막는다', b, () => {
  const issues = c.validateRegistration(reg({ contractVersion: 99 }));
  assert.ok(issues.some((i) => i.code === 'E_VERSION_MISMATCH'));
  assert.ok(!c.registrationOk(issues));
});

test('어댑터와 채널이 어긋나면 막는다', b, () => {
  const issues = c.validateRegistration(reg({ port: { capabilities: { channel: 'chat' } } }));
  assert.ok(issues.some((i) => i.code === 'E_CHANNEL_MISMATCH'));
});

test('§9.3 능력만 선언하고 구현이 없으면 등록 단계에서 걸린다', b, () => {
  const issues = c.validateRegistration(reg({ port: { capabilities: { routeToLegacyIvr: true } } }));
  assert.ok(issues.some((i) => i.code === 'E_MISSING_CAPABILITY_IMPL'));
});

test('§5.2 crossChannelInvite 선언 시 invite 구현이 필요하다', b, () => {
  const bad = c.validateRegistration(reg({ port: { capabilities: { crossChannelInvite: true } } }));
  assert.ok(bad.some((i) => i.code === 'E_MISSING_CAPABILITY_IMPL'));
  const good = c.validateRegistration(reg({ port: { capabilities: { crossChannelInvite: true }, invite: async () => {} } }));
  assert.ok(c.registrationOk(good));
});

test('알 수 없는 헬스 컴포넌트는 거부한다', b, () => {
  const issues = c.validateRegistration(reg({ reportsComponents: ['telephony', 'quantum'] }));
  assert.ok(issues.some((i) => i.code === 'E_UNDECLARED_COMPONENT'));
});

test('폴백 경로가 전무한 채널은 경고로 남긴다(§9.3)', b, () => {
  const issues = c.validateRegistration(reg({ port: { capabilities: { transferToAgent: false, routeToLegacyIvr: false } } }));
  const w = issues.find((i) => i.code === 'W_NO_FALLBACK_PATH');
  assert.ok(w);
  assert.equal(w.severity, 'warning');
  assert.ok(c.registrationOk(issues));   // 경고는 등록을 막지 않는다
});

test('§5.3 Transfer 노드는 이관 불가 채널에서 배포 전에 걸린다', b, () => {
  const flow = { id: 'f1', version: 1, startNodeId: 'n1', nodes: { n1: { id: 'n1', kind: 'Transfer', queue: 'q' } } };
  assert.equal(c.checkFlowSupported(flow, caps()).length, 0);
  assert.equal(c.checkFlowSupported(flow, caps({ transferToAgent: false })).length, 1);
});

test('§5.3 Choice 노드는 버튼·DTMF 둘 다 없으면 렌더 불가', b, () => {
  const flow = { id: 'f1', version: 1, startNodeId: 'n1', nodes: { n1: { id: 'n1', kind: 'Choice', prompt: 'p', options: [{ label: 'a', value: 'a' }] } } };
  assert.equal(c.checkFlowSupported(flow, caps()).length, 0);                                   // DTMF 로 가능
  assert.equal(c.checkFlowSupported(flow, caps({ richUi: true, dtmf: false })).length, 0);      // 버튼으로 가능
  assert.equal(c.checkFlowSupported(flow, caps({ richUi: false, dtmf: false })).length, 1);
});

test('어댑터-채널 매핑은 세 저장소와 1:1이다', b, () => {
  assert.deepEqual(c.ADAPTER_CHANNEL, { callbot: 'voice', chatbot: 'chat', dars: 'visual' });
});
