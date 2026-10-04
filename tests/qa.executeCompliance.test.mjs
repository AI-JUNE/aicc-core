// §7 5.2 준수 점검 실행기. 여기서 고정하는 결함의 증상은 **리포트가 깨끗한 것**이다 —
// 점검이 돌지 않아도, 규칙이 비교 불가해도, 수집이 잘려도 결과는 "위반 0건"처럼 보인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let X = null, QA = null, ev = null;
try {
  X = await import('../src/qa/executeCompliance.ts');
  QA = await import('../src/qa/compliance.ts');
  ev = await import('../src/events/schema.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: X ? false : '타입 스트리핑 미지원 런타임' };

const SCOPE = { tenantId: 't1' };
const meta = (n, over = {}) => ({
  eventId: `e${n}`, occurredAt: `2026-03-01T00:00:0${n}.000Z`,
  tenantId: 't1', interactionId: 'i1', channel: 'voice', ...over,
});
const botTurn = (n, text) => ev.turnCompleted(meta(n), { turnId: `t${n}`, speaker: 'bot', utterance: text });

const DISC = (over = {}) => ({
  tenantId: 't1', enabled: true, approved: true, version: 2,
  updatedAt: '2026-02-01T00:00:00.000Z', updatedBy: 'admin',
  channels: { voice: { text: '본 상담은 AI 상담원이 진행합니다.', placement: 'before_first_response' } },
  ...over,
});

const RULE_INPUT = (over = {}) => ({
  scope: SCOPE,
  disclosureMarkers: ['AI 상담'],
  forbiddenPhrases: [{ id: 'f1', phrase: '무조건 승인', severity: 'major', reasonKo: '확정적 표현 금지' }],
  channels: ['voice'],
  disclosure: DISC(),
  ...over,
});

function buffer(events, over = {}) {
  return { events: [...events], truncated: false, reviewed: false, ...over };
}

// ── 규칙 조립: 고지 필수 여부의 출처는 하나다(§2) ─────────────────────────────

test('고지 필수 여부를 고지 설정에서 읽는다 — 테넌트가 두 번 선언하지 않는다(§2)', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  assert.deepEqual(rules.disclosureRequired, { voice: true });
  assert.equal(rules.tenantId, 't1');
});

test('고지를 끈 테넌트에서는 필수가 아니다 — 모든 세션이 critical 이 되지 않는다', b, () => {
  const off = X.buildQaRuleSet(RULE_INPUT({ disclosure: DISC({ enabled: false }) }));
  assert.deepEqual(off.disclosureRequired, { voice: false });
  // 문구를 설정하지 않은 채널도 필수가 아니다(붙지 않은 매체의 고지를 요구하지 않는다).
  const other = X.buildQaRuleSet(RULE_INPUT({ channels: ['voice', 'chat'] }));
  assert.deepEqual(other.disclosureRequired, { voice: true, chat: false });
});

test('고지 설정이 없으면 고지 요구를 만들어 내지 않는다(§13-3)', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT({ disclosure: undefined }));
  assert.deepEqual(rules.disclosureRequired, {});
});

test('다른 테넌트의 고지 설정으로 규칙을 만들지 않는다(§11.1)', b, () => {
  assert.throws(() => X.buildQaRuleSet(RULE_INPUT({ disclosure: DISC({ tenantId: 't9' }) })), /§11.1/);
});

test('규칙은 복사된다 — 호스트가 나중에 배열을 고쳐 점검 기준을 바꿀 수 없다', b, () => {
  const input = RULE_INPUT();
  const rules = X.buildQaRuleSet(input);
  input.forbiddenPhrases.push({ id: 'f2', phrase: '원금 보장', severity: 'critical', reasonKo: 'x' });
  input.disclosureMarkers.push('딴것');
  assert.equal(rules.forbiddenPhrases.length, 1);
  assert.equal(rules.disclosureMarkers.length, 1);
});

// ── 수집: 잘라낸 범위를 "위반 0건"으로 적지 않는다 ───────────────────────────

test('상한이 없으면 세션 길이만큼 모은다(§13-3)', b, () => {
  const buf = X.newComplianceBuffer();
  X.appendForReview(buf, [botTurn(1, 'a'), botTurn(2, 'b')]);
  X.appendForReview(buf, [botTurn(3, 'c')]);
  assert.equal(buf.events.length, 3);
  assert.equal(buf.truncated, false);
});

test('상한을 넘으면 담지 않고 절단 사실을 남긴다', b, () => {
  const buf = X.newComplianceBuffer();
  X.appendForReview(buf, [botTurn(1, 'a'), botTurn(2, 'b'), botTurn(3, 'c')], 2);
  assert.equal(buf.events.length, 2);
  assert.equal(buf.truncated, true);
});

test('절단된 수집함은 전수 규칙을 점검 완료로 적지 않는다 — 찾은 위반은 지우지 않는다', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  const buf = buffer([botTurn(1, 'AI 상담입니다. 무조건 승인됩니다')], { truncated: true });
  const r = X.reviewCompliance({ buffer: buf, rules, scope: SCOPE });
  assert.equal(r.note.reviewed, true);
  assert.equal(r.note.checked.includes('forbidden_phrase'), false);
  assert.ok(r.note.skipped.some((s) => s.ruleId === 'forbidden_phrase' && /상한/.test(s.reasonKo)));
  // 보지 못한 범위가 생겼다는 것이 이미 찾은 위반을 없애지는 않는다.
  assert.equal(r.note.violated.includes('forbidden_phrase'), true);
  assert.equal(r.note.counts.major, 1);
  // 고지 규칙은 머리만 보므로 그대로 유효하다.
  assert.equal(r.note.checked.includes('disclosure_missing'), true);
});

// ── 점검: 못 한 점검을 0건으로 적지 않는다 ───────────────────────────────────

test('정상 경로: 고지가 첫 봇 발화에 있으면 위반이 없고 사람 리뷰도 아니다', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  const r = X.reviewCompliance({ buffer: buffer([botTurn(1, '본 상담은 AI 상담원이 진행합니다.')]), rules, scope: SCOPE });
  assert.equal(r.note.reviewed, true);
  assert.equal(r.note.requiresHumanReview, false);
  assert.deepEqual(r.note.counts, { critical: 0, major: 0, minor: 0 });
  assert.deepEqual(r.note.violated, []);
  assert.equal(r.report.interactionId, 'i1');
});

test('고지 누락은 critical 이며 사람 리뷰로 간다(§10.1·§7 5.2)', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  const r = X.reviewCompliance({ buffer: buffer([botTurn(1, '무엇을 도와드릴까요')]), rules, scope: SCOPE });
  assert.equal(r.note.requiresHumanReview, true);
  assert.equal(r.note.counts.critical, 1);
  assert.deepEqual(r.note.violated, ['disclosure_missing']);
});

test('이벤트가 없으면 "위반 0건"이 아니라 점검 미수행이다', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  const r = X.reviewCompliance({ buffer: X.newComplianceBuffer(), rules, scope: SCOPE });
  assert.equal(r.cause, 'no_events');
  assert.equal(r.note.reviewed, false);
  assert.equal(r.report, undefined);
  assert.match(r.note.reasonKo, /점검을 수행하지 못했습니다/);
});

test('스코프 밖 이벤트가 섞이면 리포트를 만들지 않고, 던지지도 않는다(§11.1)', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  const foreign = { ...botTurn(1, 'AI 상담'), tenant_id: 't9' };
  const r = X.reviewCompliance({ buffer: buffer([foreign]), rules, scope: SCOPE });
  assert.equal(r.cause, 'tenant_mismatch');
  assert.equal(r.report, undefined);
  assert.equal(r.note.reviewed, false);
  // 같은 입력을 판정기에 바로 넣으면 던진다 — 종료 경로에서 그 예외는 세션 누수가 된다.
  assert.throws(() => QA.runComplianceCheck([foreign], rules, SCOPE), /§11.1/);
});

test('판정이 예외로 끝나도 던지지 않는다 — 종료 경로의 예외는 세션 누수다', b, () => {
  const broken = { ...X.buildQaRuleSet(RULE_INPUT()), forbiddenPhrases: null };
  const r = X.reviewCompliance({ buffer: buffer([botTurn(1, 'AI 상담')]), rules: broken, scope: SCOPE });
  assert.equal(r.cause, 'check_failed');
  assert.equal(r.report, undefined);
  assert.equal(r.note.reviewed, false);
});

test('요약에는 근거 이벤트 id·검출 표현이 실리지 않는다 — 전문에는 남는다(§10.3)', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  const leaked = { ...botTurn(1, 'AI 상담입니다'), utterance_masked: '주민번호 900101-1234567 확인했습니다' };
  const r = X.reviewCompliance({ buffer: buffer([leaked]), rules, scope: SCOPE });
  const note = JSON.stringify(r.note);
  assert.equal(note.includes('e1'), false);
  assert.equal(note.includes('rrn'), false);
  assert.equal(note.includes('1234567'), false);
  assert.ok(r.report.findings.some((f) => f.ruleId === 'pii_exposed' && f.evidence === 'rrn' && f.eventId === 'e1'));
  assert.equal(JSON.stringify(r.report).includes('1234567'), false);
});

test('요약의 배열·객체는 전문과 공유되지 않는다 — 호스트가 판정을 고칠 수 없다', b, () => {
  const rules = X.buildQaRuleSet(RULE_INPUT());
  const r = X.reviewCompliance({ buffer: buffer([botTurn(1, '안내드립니다')]), rules, scope: SCOPE });
  r.note.skipped.push({ ruleId: 'pii_exposed', reasonKo: '호스트가 끼워 넣음' });
  assert.equal(r.report.skipped.some((s) => s.reasonKo === '호스트가 끼워 넣음'), false);
});

test('판정을 복사하지 않는다 — 위반·리뷰 분기 규칙이 이 파일에 없다(§2)', b, () => {
  const src = readFileSync(new URL('../src/qa/executeCompliance.ts', import.meta.url), 'utf8');
  assert.equal(/findings\.some/.test(src), false);
  assert.equal(/=== 'critical'/.test(src), false);
  assert.equal(/isDisclosureUtterance/.test(src), false);
});

// ── 배선 검증: "등록했는데 한 번도 안 걸린다"를 배포 시점에 막는다 ───────────

test('비교할 수 없는 금칙어는 거부한다 — 등록부에만 남고 어떤 발화에도 걸리지 않는다', b, () => {
  const i = X.validateComplianceBinding(RULE_INPUT({
    forbiddenPhrases: [{ id: 'f1', phrase: ' ... ', severity: 'major', reasonKo: 'x' }],
  }));
  assert.equal(i.errorsKo.length, 1);
  assert.match(i.errorsKo[0], /비교할 수 없는/);
});

test('모르는 심각도는 거부한다 — 건수가 NaN 이 되고 사람 리뷰로도 가지 않는다', b, () => {
  const i = X.validateComplianceBinding(RULE_INPUT({
    forbiddenPhrases: [{ id: 'f1', phrase: '원금 보장', severity: 'blocker', reasonKo: 'x' }],
  }));
  assert.ok(i.errorsKo.some((e) => /심각도/.test(e)));
  // 통과시켰다면 이렇게 된다(이 검사가 막는 실제 결과다): 위반이 1건 잡혔는데 어느 심각도
  // 칸에도 세어지지 않고(건수 합이 0), critical 이 아니므로 사람 리뷰로도 가지 않는다.
  const report = { findings: [{ ruleId: 'forbidden_phrase', severity: 'blocker', messageKo: 'x' }] };
  const counts = QA.countBySeverity(report);
  assert.equal(counts.critical + counts.major + counts.minor, 0);
  assert.ok(Number.isNaN(counts.blocker));
  assert.equal(QA.requiresHumanReview(report), false);
});

test('id 없는 규칙은 거부, 중복 id·사실상 중복 문구는 경고다', b, () => {
  const noId = X.validateComplianceBinding(RULE_INPUT({
    forbiddenPhrases: [{ id: '  ', phrase: '원금 보장', severity: 'major', reasonKo: 'x' }],
  }));
  assert.ok(noId.errorsKo.some((e) => /id 가 없습니다/.test(e)));
  const dup = X.validateComplianceBinding(RULE_INPUT({
    forbiddenPhrases: [
      { id: 'f1', phrase: '원금 보장', severity: 'major', reasonKo: 'x' },
      { id: 'f1', phrase: '원금보장!', severity: 'major', reasonKo: 'x' },
    ],
  }));
  assert.deepEqual(dup.errorsKo, []);
  assert.equal(dup.warningsKo.filter((w) => /중복/.test(w)).length, 2);
});

test('양수가 아닌 수집 상한은 거부한다 — 모든 세션이 즉시 절단된다', b, () => {
  assert.ok(X.validateComplianceBinding(RULE_INPUT({ maxEvents: 0 })).errorsKo.length === 1);
  assert.ok(X.validateComplianceBinding(RULE_INPUT({ maxEvents: 2.5 })).errorsKo.length === 1);
  assert.deepEqual(X.validateComplianceBinding(RULE_INPUT({ maxEvents: 50 })).errorsKo, []);
});

test('고지 설정·표식·금칙어 미등록은 막지 않고 경고로 드러낸다(그 항목은 합격이 아니다)', b, () => {
  const noDisc = X.validateComplianceBinding(RULE_INPUT({ disclosure: undefined }));
  assert.deepEqual(noDisc.errorsKo, []);
  assert.ok(noDisc.warningsKo.some((w) => /출처는 AiDisclosureConfig 하나/.test(w)));

  const noMarker = X.validateComplianceBinding(RULE_INPUT({ disclosureMarkers: [] }));
  assert.ok(noMarker.warningsKo.some((w) => /표식이 없어/.test(w)));

  const noPhrase = X.validateComplianceBinding(RULE_INPUT({ forbiddenPhrases: [] }));
  assert.ok(noPhrase.warningsKo.some((w) => /skipped/.test(w)));
});

test('등록되지 않은 채널만 가리키는 금칙어 규칙은 경고다 — 어떤 통화에도 적용되지 않는다', b, () => {
  const i = X.validateComplianceBinding(RULE_INPUT({
    forbiddenPhrases: [{ id: 'f1', phrase: '원금 보장', severity: 'major', reasonKo: 'x', channels: ['chat'] }],
  }));
  assert.deepEqual(i.errorsKo, []);
  assert.ok(i.warningsKo.some((w) => /등록되지 않은 채널만/.test(w)));
});
