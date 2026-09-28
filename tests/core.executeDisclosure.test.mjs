// AI 고지 실행(§10.1·§7 7.4·§11.1·§13-3) — 판정과 실제 고지 사이의 빈 자리를 고정한다.
//
// 이 모듈이 없던 동안 저장소는 "고지 판정기가 있다"와 "고지가 나간다"를 구분하지 못했다.
// 그래서 여기서는 **문구가 실제로 채널이 렌더할 수 있는 단계로 나오는가**를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let D = null;
try { D = await import('../src/core/executeDisclosure.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: D ? false : '타입 스트리핑 미지원 런타임' };

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'executeDisclosure.ts'), 'utf8');
const SCOPE = { tenantId: 'goone' };

const cfg = (over = {}) => ({
  tenantId: 'goone',
  enabled: true,
  approved: true,
  approvedAt: '2026-08-20T00:00:00.000Z',
  approvedBy: 'legal_kim',
  version: 3,
  updatedAt: '2026-08-19T00:00:00.000Z',
  updatedBy: 'admin_lee',
  channels: {
    voice: { text: '본 상담은 AI 상담원이 진행합니다.', placement: 'before_first_response' },
    visual: { text: '이 화면은 AI가 안내합니다.', placement: 'persistent_banner' },
    chat: { text: 'AI 상담원이 답변드립니다.', placement: 'session_start' },
  },
  ...over,
});

const plan = (over = {}, channel = 'voice', disclosedChannels = []) =>
  D.planDisclosure({ config: cfg(over), scope: SCOPE, channel, disclosedChannels });

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('고지 단계는 테넌트 문구 그대로 · 예약 nodeId · Say 로 나온다', b, () => {
  const r = plan();
  assert.equal(r.action, 'show');
  assert.equal(r.step.nodeId, D.DISCLOSURE_NODE_ID);
  assert.equal(r.step.nodeId, '__disclosure');
  assert.equal(r.step.kind, 'Say');
  assert.equal(r.step.channel, 'voice');
  assert.equal(r.step.text, '본 상담은 AI 상담원이 진행합니다.');
  assert.deepEqual(r.step.disclosure, { placement: 'before_first_response', configVersion: 3 });
  assert.equal(r.placement, 'before_first_response');
  assert.equal(r.configVersion, 3);
  // 무음이 아니다 — 무음으로 표시하면 채널이 렌더하지 않고 고지는 없던 일이 된다.
  assert.equal(r.step.silent, undefined);
});

test('채널마다 그 매체의 문구·노출 시점이 나간다(§5.3)', b, () => {
  const v = plan({}, 'visual');
  assert.equal(v.step.text, '이 화면은 AI가 안내합니다.');
  assert.equal(v.step.disclosure.placement, 'persistent_banner');
  const c = plan({}, 'chat');
  assert.equal(c.step.disclosure.placement, 'session_start');
});

test('문구 앞뒤 공백은 정리되어 나간다', b, () => {
  const r = plan({ channels: { voice: { text: '  AI 안내입니다.\n', placement: 'session_start' } } });
  assert.equal(r.step.text, 'AI 안내입니다.');
});

test('고지 계획은 설정 객체를 고치지 않는다', b, () => {
  const c = cfg();
  const snapshot = JSON.stringify(c);
  const r = D.planDisclosure({ config: c, scope: SCOPE, channel: 'voice', disclosedChannels: [] });
  r.step.text = '바뀐 문구';
  r.step.disclosure.configVersion = 999;
  assert.equal(JSON.stringify(c), snapshot);
});

// ── 내지 않는 경우(정상) ──────────────────────────────────────────────────────

test('이미 고지한 채널에는 다시 내지 않는다 — 매 턴 반복하면 안내가 잡음이 된다', b, () => {
  const r = plan({}, 'voice', ['voice']);
  assert.equal(r.action, 'skip');
  assert.equal(r.code, 'already_disclosed');
});

test('다른 채널로 바뀌면 그 매체에는 아직 고지하지 않은 것이다(§5.2)', b, () => {
  const r = plan({}, 'visual', ['voice']);
  assert.equal(r.action, 'show');
  assert.equal(r.step.channel, 'visual');
});

test('테넌트가 고지를 끈 상태는 정상 경로다 — 법적 근거는 테넌트가 갖는다', b, () => {
  const r = plan({ enabled: false });
  assert.equal(r.action, 'skip');
  assert.equal(r.code, 'disabled');
});

test('그 채널 문구가 설정되지 않았으면 드러내되 막지 않는다', b, () => {
  const r = plan({ channels: { chat: { text: 'AI 입니다.', placement: 'session_start' } } }, 'voice');
  assert.equal(r.action, 'skip');
  assert.equal(r.code, 'channel_not_configured');
  assert.match(r.reasonKo, /voice/);
});

test('빈 문구를 테넌트가 생략 가능으로 선언했으면 생략한다', b, () => {
  const r = plan({ channels: { voice: { text: '   ', placement: 'session_start', optional: true } } });
  assert.equal(r.action, 'skip');
  assert.equal(r.code, 'optional');
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('미승인 문구로는 AI 응대를 시작할 수 없다(§10.1)', b, () => {
  const r = plan({ approved: false });
  assert.equal(r.action, 'block');
  assert.equal(r.code, 'not_approved');
  assert.match(r.reasonKo, /승인 필요/);
});

test('빈 문구이고 생략 근거도 없으면 막는다 — 고지 없이 응대하는 상태다', b, () => {
  const r = plan({ channels: { voice: { text: '  ', placement: 'session_start' } } });
  assert.equal(r.action, 'block');
  assert.equal(r.code, 'text_empty');
});

test('막힌 경우에도 단계를 만들지 않는다 — 보낼 수 있는 물건이 생기지 않는다', b, () => {
  for (const over of [{ approved: false }, { channels: { voice: { text: '', placement: 'session_start' } } }]) {
    const r = plan(over);
    assert.equal(r.action, 'block');
    assert.equal('step' in r, false);
  }
});

test('다른 테넌트의 고지 설정은 던진다 — 고객이 남의 회사 이름을 듣는다(§11.1)', b, () => {
  assert.throws(
    () => D.planDisclosure({ config: cfg({ tenantId: 'other' }), scope: SCOPE, channel: 'voice', disclosedChannels: [] }),
    /§11.1/,
  );
});

test('스코프 형식 위반은 통과하지 않는다(§11.1)', b, () => {
  assert.throws(() => D.planDisclosure({ config: cfg(), scope: { tenantId: '' }, channel: 'voice', disclosedChannels: [] }), /§11.1/);
});

test('격리 위반 말고는 던지지 않는다 — 고지 판정이 통화를 끊으면 안 된다', b, () => {
  for (const over of [{ enabled: false }, { approved: false }, { channels: {} }]) {
    assert.doesNotThrow(() => plan(over));
  }
});

// ── 기본값·판정 복사 금지 ────────────────────────────────────────────────────

test('문구를 만들어 내지 않는다(§13-3) — 설정에 없으면 어떤 텍스트도 나가지 않는다', b, () => {
  const r = plan({ channels: {} }, 'voice');
  assert.equal(r.action, 'skip');
  // 문구가 나가는 유일한 경로는 config 뿐이다.
  const custom = plan({ channels: { voice: { text: '고객사가 정한 문구', placement: 'session_start' } } });
  assert.equal(custom.step.text, '고객사가 정한 문구');
});

test('사용 여부·승인 판정을 복사하지 않는다(§2)', b, () => {
  // 판정은 portal/aiDisclosure.ts 의 resolveDisclosure 하나다. 여기서 다시 보면 언젠가 어긋나고,
  // 그때는 설정 화면이 '고지 중'이라고 적는데 통화에서는 안 나가는 상태가 된다.
  assert.ok(SRC.includes('resolveDisclosure('));
  assert.equal(/\.approved\b/.test(SRC), false, 'approved 를 여기서 다시 보고 있다');
  assert.equal(/\.enabled\b/.test(SRC), false, 'enabled 를 여기서 다시 보고 있다');
});

// ── 배선 시점 검증 ───────────────────────────────────────────────────────────

test('정상 설정은 배선을 통과한다', b, () => {
  const r = D.validateDisclosureBinding(cfg(), SCOPE, ['voice', 'visual', 'chat']);
  assert.deepEqual(r.errorsKo, []);
  assert.deepEqual(r.warningsKo, []);
});

test('다른 테넌트 설정은 배선 자체를 막는다(§11.1)', b, () => {
  const r = D.validateDisclosureBinding(cfg({ tenantId: 'other' }), SCOPE, ['voice']);
  assert.equal(r.errorsKo.length >= 1, true);
  assert.match(r.errorsKo.join(' '), /§11.1/);
});

test('미승인 문구는 배포 시점에 막는다 — 통화 중에 알면 늦다', b, () => {
  const r = D.validateDisclosureBinding(cfg({ approved: false }), SCOPE, ['voice']);
  assert.equal(r.errorsKo.length >= 1, true);
});

test('음성 채널에 상시 배너는 렌더할 방법이 없으므로 막는다', b, () => {
  const r = D.validateDisclosureBinding(
    cfg({ channels: { voice: { text: 'AI 안내입니다.', placement: 'persistent_banner' } } }), SCOPE, ['voice'],
  );
  assert.equal(r.errorsKo.length >= 1, true);
});

test('등록되지 않은 채널의 문구 누락은 경고를 만들지 않는다 — 잡음에 진짜 누락이 묻힌다', b, () => {
  const voiceOnly = cfg({ channels: { voice: { text: 'AI 안내입니다.', placement: 'session_start' } } });
  assert.deepEqual(D.validateDisclosureBinding(voiceOnly, SCOPE, ['voice']).warningsKo, []);
  assert.equal(D.validateDisclosureBinding(voiceOnly, SCOPE, ['voice', 'chat']).warningsKo.length, 1);
});

test('고지를 끈 설정은 막지 않고 경고로 남긴다', b, () => {
  const r = D.validateDisclosureBinding(cfg({ enabled: false }), SCOPE, ['voice']);
  assert.deepEqual(r.errorsKo, []);
  assert.equal(r.warningsKo.length >= 1, true);
});

test('빈 입력: 등록 채널이 없어도 던지지 않는다', b, () => {
  assert.doesNotThrow(() => D.validateDisclosureBinding(cfg(), SCOPE, []));
});
