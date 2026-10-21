// §10.1 고지 문구가 두 번 선언돼 있었다 — 그리고 어긋나는 두 방향이 모두 조용하다.
//
// `qa/executeCompliance.ts` 머리말은 "고지 **필수 여부**를 따로 선언받지 않는다(§2) — 출처는
// `AiDisclosureConfig` 하나다"라고 적어 두었다. 그런데 **문구**는 그러지 않았다: 고지 발화를
// 판별하는 표식(`disclosureMarkers`)을 테넌트가 따로 등록하게 했고, Core 는 바로 그 설정의
// 문구를 스스로 내보내면서도(`planDisclosure` → `turnCompleted`) 점검할 때는 다른 선언을 봤다.
//
//  - **문구를 고치고 표식을 그대로 두면** 그날부터 모든 세션이 `disclosure_missing`(critical) 로
//    잡혀 리뷰 큐가 통째로 잠긴다 — 진짜 위반이 그 안에 묻힌다. 준비도 문서가 이 실패를
//    이름까지 적어 두고도 코드는 그대로였다.
//  - **표식을 등록하지 않으면** 고지 점검이 통째로 건너뛰어진다(`skipped`). 고지는 나가는데
//    아무도 점검하지 않는 상태이고, 운영 화면에서 "위반 0건"과 거의 같게 보인다.
//
// 그래서 배선된 고지 설정에서 **Core 가 실제로 내보내는 문구**를 표식으로 뽑는다. 전문을 쓰는
// 것이 안전한 이유는 점검이 §8.1 원장(`utterance_masked`)을 보기 때문이다 — 고객이 들은 소리가
// 아니라 Core 가 쓴 문자열이다. 다만 원장에 남는 형태와 맞추려면 `maskPii` 를 같이 지나야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let X = null, QA = null, EV = null, AD = null, R = null, F = null, B = null, P = null;
try {
  X = await import('../src/qa/executeCompliance.ts');
  QA = await import('../src/qa/compliance.ts');
  EV = await import('../src/events/schema.ts');
  AD = await import('../src/portal/aiDisclosure.ts');
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: X ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 'goone' };
const NOW = '2026-10-21T09:00:00.000Z';
const VOICE_TEXT = '본 상담은 AI 상담원이 진행합니다.';
const CHAT_TEXT = 'AI 상담원이 답변드립니다.';

const DISC = (over = {}) => ({
  tenantId: 'goone', enabled: true, approved: true,
  approvedAt: '2026-08-20T00:00:00.000Z', approvedBy: 'legal_kim',
  version: 4, updatedAt: '2026-08-19T00:00:00.000Z', updatedBy: 'admin_lee',
  channels: {
    voice: { text: VOICE_TEXT, placement: 'before_first_response' },
    chat: { text: CHAT_TEXT, placement: 'session_start' },
  },
  ...over,
});

const RULE_INPUT = (over = {}) => ({
  scope: SCOPE,
  disclosureMarkers: [],
  forbiddenPhrases: [{ id: 'f1', phrase: '무조건 승인', severity: 'major', reasonKo: '확정적 표현 금지' }],
  channels: ['voice'],
  disclosure: DISC(),
  ...over,
});

let n = 0;
const meta = (over = {}) => {
  n += 1;
  return {
    eventId: `e${n}`, occurredAt: `2026-10-21T09:00:0${n % 10}.000Z`,
    tenantId: 'goone', interactionId: 'i1', channel: 'voice', ...over,
  };
};
const botTurn = (text) => EV.turnCompleted(meta(), { turnId: `t${n}`, speaker: 'bot', utterance: text });

/** 한 세션을 점검한다. `channel` 은 원장 채널과 같다. */
function review(events, ruleOver = {}) {
  const rules = X.buildQaRuleSet(RULE_INPUT(ruleOver));
  return QA.runComplianceCheck(events, rules, SCOPE, 'voice');
}
const found = (report, ruleId) => report.findings.some((f) => f.ruleId === ruleId);
const skipped = (report, ruleId) => report.skipped.some((s) => s.ruleId === ruleId);

// ── 설정 문구가 곧 표식이다 (§2) ─────────────────────────────────────────────

test('표식을 등록하지 않아도 설정 문구로 고지를 판별한다 — 점검이 건너뛰어지지 않는다', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  assert.deepEqual(rules.disclosureMarkers, [VOICE_TEXT]);
  const report = review([botTurn(VOICE_TEXT), botTurn('무엇을 도와드릴까요?')]);
  assert.equal(found(report, 'disclosure_missing'), false);
  assert.equal(skipped(report, 'disclosure_missing'), false);
  assert.ok(report.checked.includes('disclosure_missing'));
});

test('문구를 고치면 표식도 함께 바뀐다 — 그날부터 전 세션이 고지 누락으로 잡히지 않는다', b, () => {
  // 운영이 문구를 고치고 법무가 다시 승인했다. 표식은 **아무도 고치지 않았다**.
  const changed = { ...AD.updateDisclosureText(DISC(), 'voice', { text: '이 통화는 인공지능 상담원이 응대합니다.', placement: 'before_first_response' }, 'admin_lee', NOW), approved: true };
  const rules = X.buildQaRuleSet(RULE_INPUT({ disclosure: changed, disclosureMarkers: ['AI 상담원이 진행'] }));
  // 새 문구로 기록된 세션이 통과한다(종전에는 전 세션이 critical 이었다).
  const report = QA.runComplianceCheck(
    [botTurn('이 통화는 인공지능 상담원이 응대합니다.')], rules, SCOPE, 'voice',
  );
  assert.equal(found(report, 'disclosure_missing'), false);
  // 그리고 낡은 표식은 **지워지지 않고 드러난다** — 지난 문구로 기록된 통화도 함께 점검된다.
  assert.ok(rules.disclosureMarkers.includes('AI 상담원이 진행'));
  const old = QA.runComplianceCheck([botTurn(VOICE_TEXT)], rules, SCOPE, 'voice');
  assert.equal(found(old, 'disclosure_missing'), false);
});

test('고지 문구가 나가지 않은 세션은 그대로 critical 이다 — 판별을 느슨하게 만든 것이 아니다', b, () => {
  const report = review([botTurn('무엇을 도와드릴까요?'), botTurn('안내드렸습니다.')]);
  assert.ok(found(report, 'disclosure_missing'));
});

test('고지가 첫 응답보다 늦으면 지각으로 잡힌다 — 설정 문구 표식으로도 순서를 본다', b, () => {
  const report = review([botTurn('무엇을 도와드릴까요?'), botTurn(VOICE_TEXT)]);
  assert.ok(found(report, 'disclosure_late'));
  assert.equal(found(report, 'disclosure_missing'), false);
});

test('개인정보가 섞인 고지 문구도 원장과 같은 형태로 맞춘다 — 그 테넌트만 전건 누락이 되지 않는다', b, () => {
  const withPhone = DISC({
    channels: { voice: { text: 'AI 상담원입니다. 문의는 010-1234-5678 로 연락 주세요.', placement: 'session_start' } },
  });
  const rules = X.buildQaRuleSet(RULE_INPUT({ disclosure: withPhone }));
  // 원장에 남는 것은 마스킹된 문장이다 — 표식도 같은 마스킹을 지나야 걸린다.
  const stored = botTurn('AI 상담원입니다. 문의는 010-1234-5678 로 연락 주세요.');
  assert.notEqual(stored.utterance_masked, 'AI 상담원입니다. 문의는 010-1234-5678 로 연락 주세요.');
  const report = QA.runComplianceCheck([stored], rules, SCOPE, 'voice');
  assert.equal(found(report, 'disclosure_missing'), false);
});

test('채널 문구를 모두 표식으로 뽑고, 같은 문구는 한 번만 둔다', b, () => {
  const both = X.derivedDisclosureMarkers(DISC(), ['voice', 'chat']);
  assert.deepEqual(both, [VOICE_TEXT, CHAT_TEXT]);
  const same = X.derivedDisclosureMarkers(
    DISC({ channels: { voice: { text: VOICE_TEXT, placement: 'session_start' }, chat: { text: VOICE_TEXT, placement: 'session_start' } } }),
    ['voice', 'chat'],
  );
  assert.deepEqual(same, [VOICE_TEXT]);
});

test('문구를 만들어 내지 않는다(§13-3) — 끈 설정·미설정 채널·공백에서는 표식이 없다', b, () => {
  assert.deepEqual(X.derivedDisclosureMarkers(DISC({ enabled: false }), ['voice']), []);
  assert.deepEqual(X.derivedDisclosureMarkers(DISC({ approved: false }), ['voice']), []);
  assert.deepEqual(X.derivedDisclosureMarkers(DISC({ channels: {} }), ['voice']), []);
  assert.deepEqual(X.derivedDisclosureMarkers(DISC(), []), []);
  const blank = DISC({ channels: { voice: { text: '   ', placement: 'session_start', optional: true } } });
  assert.deepEqual(X.derivedDisclosureMarkers(blank, ['voice']), []);
});

// ── 배선 시점 경고 ───────────────────────────────────────────────────────────

test('설정 문구에 없는 표식은 경고로 드러낸다 — 문구를 고치고 표식을 둔 상태일 수 있다', b, () => {
  const i = X.validateComplianceBinding(RULE_INPUT({ disclosureMarkers: ['지난 고지 문구'] }));
  assert.deepEqual(i.errorsKo, []);
  assert.ok(i.warningsKo.some((w) => /설정된 고지 문구에 없는 표식/.test(w)), i.warningsKo.join(' / '));
});

test('설정 문구에 들어 있는 핵심 어구는 낡은 표식이 아니다 — 과다 경고를 만들지 않는다', b, () => {
  const i = X.validateComplianceBinding(RULE_INPUT({ disclosureMarkers: ['AI 상담'] }));
  assert.equal(i.warningsKo.some((w) => /설정된 고지 문구에 없는 표식/.test(w)), false);
});

test('뽑을 문구도 등록 표식도 없을 때만 "표식 없음"을 경고한다', b, () => {
  const none = X.validateComplianceBinding(RULE_INPUT({ disclosure: DISC({ channels: {} }) }));
  assert.ok(none.warningsKo.some((w) => /표식이 없어/.test(w)));
  const derived = X.validateComplianceBinding(RULE_INPUT());
  assert.equal(derived.warningsKo.some((w) => /표식이 없어/.test(w)), false);
});

// ── Core 가 실제로 내보낸 고지가 점검을 통과하는가 ───────────────────────────

const flowAsk = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요, 고운 고객센터입니다.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.' },
  },
};

function fakePort(id = 'callbot') {
  return {
    id,
    capabilities: P.profileFor(id),
    async present() {}, async transfer() {}, async invite() {}, async end() {},
  };
}

function buildCore(qaOver = {}) {
  const bus = B.createEventBus({
    scope: SCOPE, sinks: [B.createCollectorSink('t')],
    store: B.createMemoryIdempotencyStore({ maxKeys: 200 }), releaseKeyOnSinkFailure: false,
  });
  const reports = [];
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flowAsk]),
    channels: [{ port: fakePort(), reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    bus, now: () => NOW, newInteractionId: () => 'i_qa1',
    disclosure: DISC(),
    // **표식을 등록하지 않는다** — 테넌트가 가장 흔하게 두는 상태다.
    qa: { disclosureMarkers: [], forbiddenPhrases: [], onReport: (i) => reports.push(i), ...qaOver },
  });
  return { core, reports };
}

test('표식 미등록 테넌트에서도 Core 가 내보낸 고지가 점검을 통과한다 — 건너뛰지 않는다(§7 5.2)', b, async () => {
  const { core, reports } = buildCore();
  await core.start({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing' });
  const r = await core.send('i_qa1', { input: { kind: 'utterance', text: '김고운' } });
  assert.equal(r.status, 'completed');
  assert.equal(r.compliance.reviewed, true);
  assert.ok(r.compliance.checked.includes('disclosure_missing'));
  assert.equal(r.compliance.skipped.some((s) => s.ruleId === 'disclosure_missing'), false);
  assert.deepEqual(r.compliance.counts, { critical: 0, major: 0, minor: 0 });
  assert.equal(reports[0].report.findings.length, 0);
});

test('고지 배선이 없으면 종전과 같다 — 표식을 만들어 낼 근거가 없다(§13-3)', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT({ disclosure: undefined, disclosureMarkers: ['AI 상담'] }));
  assert.deepEqual(rules.disclosureMarkers, ['AI 상담']);
  assert.deepEqual(rules.disclosureRequired, {});
});
