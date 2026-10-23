import { test } from 'node:test';
import assert from 'node:assert/strict';

let c = null, F = null;
try {
  c = await import('../src/channels/contract.ts');
  F = await import('../src/ops/fallback.ts');
} catch { /* 구형 런타임 */ }
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

// ── 헬스 컴포넌트 선언(§9.3) ─────────────────────────────────────────────────
//
// 헬스 레지스트리는 **테넌트당 한 벌**이고 `decideFallbackMode` 는 거기서 컴포넌트별 최신
// 샘플을 읽는다. 그래서 "선언하지 않은 컴포넌트의 샘플은 무시한다"는 규칙만으로는
// "아무 채널이나 전체 폴백을 유발할 수 없다"가 지켜지지 않는다 — 선언 자체가 자기 채널의
// 의존 목록 안에 있어야 한다. 아래 검사들이 그 경계와 목록의 단일 출처를 고정한다.

test('아는 컴포넌트 목록을 등록 검증이 다시 적지 않는다(§2)', b, () => {
  // `COMPONENT_TIER` 는 `Record<ComponentId, …>` 라 컴포넌트가 늘면 컴파일이 깨진다.
  // 등록 검증이 그 목록을 **그대로 쓰는지**를 본다 — 사본을 두면 컴포넌트가 하나 늘어난 날
  // 이 검사만 모르고, 그 컴포넌트를 올리는 채널은 등록 자체가 거부된다.
  assert.deepEqual([...F.COMPONENT_IDS].sort(), Object.keys(F.COMPONENT_TIER).sort());
  for (const id of F.COMPONENT_IDS) {
    const issues = c.validateRegistration(reg({ reportsComponents: [id] }));
    assert.deepEqual(
      issues.filter((i) => i.code === 'E_UNDECLARED_COMPONENT'),
      [],
      `아는 컴포넌트 ${id} 가 '알 수 없음'으로 거부됐다 — 목록 사본이 낡았다`,
    );
  }
  // voice 의존 컴포넌트는 그대로 등록을 통과한다(막는 것은 의존 밖 선언뿐이다).
  for (const id of F.CHANNEL_DEPENDENCIES.voice) {
    assert.ok(
      c.registrationOk(c.validateRegistration(reg({ reportsComponents: [id] }))),
      `voice 의존 컴포넌트 ${id} 선언이 거부됐다`,
    );
  }
});

test('자기 채널이 의존하지 않는 컴포넌트를 선언하면 등록을 막는다(§9.3)', b, () => {
  // 챗봇이 stt 를 올릴 수 있게 되면 챗봇 쪽 오탐 하나로 **음성 전체**가 상담사 직결로
  // 떨어지고, 반대로 챗봇이 계속 up 을 올리면 진짜 STT 장애가 낡은 샘플 판정에도 걸리지
  // 않는다. 증상은 둘 다 엔진 장애와 구분되지 않으므로 등록에서 막는다.
  const issues = c.validateRegistration(reg({
    port: { id: 'chatbot', capabilities: { adapter: 'chatbot', channel: 'chat', dtmf: false, richUi: true } },
    reportsComponents: ['messaging', 'stt'],
  }));
  const found = issues.filter((i) => i.code === 'E_FOREIGN_COMPONENT');
  assert.equal(found.length, 1, `stt 선언이 통과했다: ${JSON.stringify(issues)}`);
  assert.equal(found[0].severity, 'error');
  assert.ok(found[0].messageKo.includes('stt'));
  assert.ok(!c.registrationOk(issues));
  // 의존 안에 있는 것만 선언하면 통과한다(막는 것은 **넓힌 선언**뿐이다).
  assert.ok(c.registrationOk(c.validateRegistration(reg({
    port: { id: 'chatbot', capabilities: { adapter: 'chatbot', channel: 'chat', dtmf: false, richUi: true } },
    reportsComponents: F.CHANNEL_DEPENDENCIES.chat,
  }))));
});

test('모르는 이름은 한 번만 적는다 — 같은 값에 두 사유를 달지 않는다(경계)', b, () => {
  const issues = c.validateRegistration(reg({ reportsComponents: ['quantum'] }));
  assert.equal(issues.filter((i) => i.code === 'E_UNDECLARED_COMPONENT').length, 1);
  assert.equal(
    issues.filter((i) => i.code === 'E_FOREIGN_COMPONENT').length, 0,
    '모르는 이름은 어느 채널의 의존 목록에도 없다 — 두 번 적으면 고칠 곳이 둘로 보인다',
  );
});

test('빈 선언은 막지 않는다 — 올리지 않는 채널은 샘플이 unknown 으로 드러난다(경계)', b, () => {
  assert.ok(c.registrationOk(c.validateRegistration(reg({ reportsComponents: [] }))));
});
