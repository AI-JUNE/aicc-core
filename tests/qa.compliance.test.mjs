import { test } from 'node:test';
import assert from 'node:assert/strict';

let qa = null, ev = null;
try {
  qa = await import('../src/qa/compliance.ts');
  ev = await import('../src/events/schema.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: qa ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't1' };
const meta = (n) => ({
  eventId: `e${n}`, occurredAt: `2026-03-01T00:00:0${n}.000Z`,
  tenantId: 't1', interactionId: 'i1', channel: 'voice',
});
const rules = (over = {}) => ({
  tenantId: 't1',
  disclosureRequired: { voice: true },
  disclosureMarkers: ['AI 상담'],
  forbiddenPhrases: [],
  ...over,
});

test('§10.1 고지 발화가 없으면 critical 로 잡힌다', b, () => {
  const events = [
    ev.sessionStarted(meta(0), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: '무엇을 도와드릴까요' }),
  ];
  const r = qa.runComplianceCheck(events, rules(), scope);
  const f = r.findings.find((x) => x.ruleId === 'disclosure_missing');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
  assert.ok(qa.requiresHumanReview(r));
});

test('§10.1 고지가 첫 응답보다 늦으면 disclosure_late', b, () => {
  const events = [
    ev.sessionStarted(meta(0), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: '무엇을 도와드릴까요' }),
    ev.turnCompleted(meta(2), { turnId: 't2', speaker: 'bot', utterance: '본 상담은 A I 상담입니다.' }),
  ];
  const r = qa.runComplianceCheck(events, rules(), scope);
  assert.ok(r.findings.some((x) => x.ruleId === 'disclosure_late'));
  assert.ok(!r.findings.some((x) => x.ruleId === 'disclosure_missing'));
});

test('첫 봇 발화에 고지가 있으면 고지 위반 없음(띄어쓰기 무시)', b, () => {
  const events = [
    ev.sessionStarted(meta(0), {}),
    ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: '안녕하세요, 본 통화는 AI상담으로 진행됩니다.' }),
  ];
  const r = qa.runComplianceCheck(events, rules(), scope);
  assert.equal(r.findings.filter((x) => x.ruleId.startsWith('disclosure')).length, 0);
});

test('고지 표식 미등록이면 합격이 아니라 skipped 로 남는다', b, () => {
  const events = [ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: '안내드립니다' })];
  const r = qa.runComplianceCheck(events, rules({ disclosureMarkers: [] }), scope);
  assert.ok(r.skipped.some((s) => s.ruleId === 'disclosure_missing'));
  assert.ok(!r.checked.includes('disclosure_missing'));
});

test('금칙어는 봇 발화만 검출하고 고객 발화는 건드리지 않는다', b, () => {
  const fp = [{ id: 'f1', phrase: '무조건 승인', severity: 'major', reasonKo: '확정적 표현 금지' }];
  const events = [
    ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: '고객님은 AI 상담 대상이며 무조건 승인됩니다' }),
    ev.turnCompleted(meta(2), { turnId: 't2', speaker: 'customer', utterance: '무조건 승인 되나요?' }),
  ];
  const r = qa.runComplianceCheck(events, rules({ forbiddenPhrases: fp }), scope);
  const hits = r.findings.filter((x) => x.ruleId === 'forbidden_phrase');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].turnId, 't1');
});

test('채널이 다른 금칙어 규칙은 적용되지 않는다', b, () => {
  const fp = [{ id: 'f1', phrase: '무조건 승인', severity: 'major', reasonKo: 'x', channels: ['chat'] }];
  const events = [ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: 'AI 상담 · 무조건 승인' })];
  const r = qa.runComplianceCheck(events, rules({ forbiddenPhrases: fp }), scope);
  assert.equal(r.findings.filter((x) => x.ruleId === 'forbidden_phrase').length, 0);
});

test('§10.3 마스킹 파이프라인이 샌 경우 critical, 원문은 남기지 않는다', b, () => {
  const leaked = {
    ...ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: 'AI 상담입니다' }),
    utterance_masked: '주민번호 900101-1234567 확인했습니다',
  };
  const r = qa.runComplianceCheck([leaked], rules(), scope);
  const f = r.findings.find((x) => x.ruleId === 'pii_exposed');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
  assert.equal(f.evidence, 'rrn');
  assert.ok(!JSON.stringify(r).includes('1234567'));
});

test('pii_masked 플래그와 pii_kinds 불일치를 잡는다', b, () => {
  const e = { ...ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: 'AI 상담입니다' }), pii_masked: true };
  const r = qa.runComplianceCheck([e], rules(), scope);
  assert.ok(r.findings.some((x) => x.ruleId === 'pii_unmasked_flag'));
});

test('§11.1 다른 테넌트의 규칙·이벤트는 거부된다', b, () => {
  const events = [ev.turnCompleted(meta(1), { turnId: 't1', speaker: 'bot', utterance: 'AI 상담' })];
  assert.throws(() => qa.runComplianceCheck(events, rules({ tenantId: 't2' }), scope), /§11.1/);
  const foreign = [{ ...events[0], tenant_id: 't9' }];
  assert.throws(() => qa.runComplianceCheck(foreign, rules(), scope), /§11.1/);
});

test('고지 불필요 채널은 위반으로 잡지 않는다', b, () => {
  const chatMeta = { ...meta(1), channel: 'chat' };
  const events = [ev.turnCompleted(chatMeta, { turnId: 't1', speaker: 'bot', utterance: '안녕하세요' })];
  const r = qa.runComplianceCheck(events, rules(), scope);
  assert.equal(r.findings.length, 0);
  assert.deepEqual(qa.countBySeverity(r), { critical: 0, major: 0, minor: 0 });
});
