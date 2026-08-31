import { test } from 'node:test';
import assert from 'node:assert/strict';

// TS 소스를 직접 읽어 규칙 불변식을 검증한다(빌드 의존 없이 CI 가능).
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let g = null;
try {
  g = await import('../src/core/policyGuard.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const behavioral = { skip: g ? false : '타입 스트리핑 미지원 런타임' };

test('§4.1 Outcome 4종이 모두 정의되어 있다', () => {
  const s = read('src/domain/types.ts');
  for (const v of ['AUTO_RESOLVED', 'TRANSFERRED', 'ABANDONED', 'FAILED']) assert.match(s, new RegExp(v));
});

test('§4.1 AUTO_RESOLVED는 24h 재문의를 반영한다', () => {
  const s = read('src/domain/types.ts');
  assert.match(s, /reContactWithin24h/);
  assert.match(s, /if \(i\.reContactWithin24h\) return 'ABANDONED'/);
});

test('§6.2 세 어댑터 인터페이스가 존재하고 residency를 갖는다', () => {
  const s = read('src/adapters/index.ts');
  for (const i of ['SttAdapter', 'TtsAdapter', 'LlmAdapter']) assert.match(s, new RegExp(`interface ${i}`));
  assert.equal((s.match(/residency/g) || []).length >= 4, true);
});

test('§10.3 국외 엔진 차단 가드가 있다', () => {
  assert.match(read('src/adapters/index.ts'), /assertResidency/);
});

test('§5.3 Flow 노드 5종과 채널 렌더러가 있다', () => {
  const s = read('src/flow/types.ts');
  for (const n of ['Say', 'Collect', 'Choice', 'Confirm', 'Transfer']) assert.match(s, new RegExp(`'${n}'`));
  assert.match(s, /export function renderNode/);
});

test('§5.1 Voice 렌더는 DTMF를 수용한다', () => {
  assert.match(read('src/flow/types.ts'), /acceptDtmf: true/);
});

test('§10.3 PII 마스킹 규칙(주민·카드·계좌·전화)이 있다', () => {
  const s = read('src/core/policyGuard.ts');
  for (const r of ['rrn', 'card', 'account', 'phone']) assert.match(s, new RegExp(`'${r}'`));
});

test('§5.1 폴백 정책 — 3회 실패 시 상담사 이관', () => {
  const s = read('src/core/session.ts');
  assert.match(s, /failCount >= 3.*handoff_agent/s);
});

test('§1.2 채널 합류(attachChannel)로 하나의 Interaction 유지', () => {
  assert.match(read('src/core/session.ts'), /export function attachChannel/);
});

test('시뮬 어댑터는 외부 호출이 없다(실엔진 미연동)', () => {
  const s = read('src/adapters/sim.ts');
  assert.equal(/fetch\(|https?:\/\//.test(s), false);
});

test('§10.3 규칙 우선순위 — 휴대폰은 phone, 계좌는 account로 분류된다', behavioral, () => {
  const phone = g.maskPii('연락처 010-1234-5678');
  assert.deepEqual(phone.hits, ['phone']);
  assert.ok(!phone.text.includes('010-1234-5678'));
  const acct = g.maskPii('입금계좌 110-123-456789');
  assert.deepEqual(acct.hits, ['account']);
  assert.ok(!acct.text.includes('110-123-456789'));
  const both = g.maskPii('010-1234-5678 / 110-123-456789');
  assert.deepEqual(both.hits.sort(), ['account', 'phone']);
});
