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

// ── maskPii 멱등성 ─────────────────────────────────────────────────────────────
// 저장 경로는 한 번만 마스킹하도록 설계돼 있지만, 실제로는 두 번 지나가는 자리가 있다
// (감사 detail·정산 사유는 호출부와 audit/log.ts 에서 각각, 이벤트 원장의 발화는 조회 투영에서
// 마지막 방어선으로 한 번 더). 멱등이 아니면 두 번 가린 값이 **다른 값으로 바뀌어**
// 원장과 화면의 문자열이 갈리고, `masked: true` 가 "원문이 들어왔다"는 사고 신호와 구분되지 않는다.
const MASK_SAMPLES = {
  rrn: '주민번호 900101-1234567',
  card: '카드 1234-5678-9012-3456',
  phone: '연락처 010-1234-5678',
  account: '입금계좌 110-123-456789',
};

test('§10.3 모든 마스킹 규칙에 멱등 표본이 있다 — 규칙을 늘리면 여기서 걸린다', () => {
  const names = [...read('src/core/policyGuard.ts').matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 4, `규칙 이름을 읽지 못했다: ${names.join(',')}`);
  assert.deepEqual(names.filter((n) => !(n in MASK_SAMPLES)), [], '표본 없는 규칙이 있다 — MASKED_SHAPES 도 같이 늘렸는지 확인하라');
});

test('§10.3 maskPii 는 자기 출력에 멱등이다 — 재적용이 값을 바꾸지 않는다', behavioral, () => {
  for (const [name, input] of Object.entries(MASK_SAMPLES)) {
    const once = g.maskPii(input);
    assert.deepEqual(once.hits, [name], `${name} 규칙이 잡아야 한다`);
    const twice = g.maskPii(once.text);
    assert.equal(twice.text, once.text, `${name}: 재적용이 값을 바꿨다`);
    assert.equal(twice.masked, false, `${name}: 이미 가려진 값을 "이번에 가렸다"로 적는다`);
    assert.deepEqual(twice.hits, []);
  }
});

test('§10.3 이미 가려진 값 옆의 진짜 번호는 그대로 가린다 — 보호가 과하게 먹지 않는다', behavioral, () => {
  const r = g.maskPii('900101-******* 010-1234-5678');
  assert.deepEqual(r.hits, ['phone']);
  assert.ok(!r.text.includes('010-1234-5678'), '뒤의 진짜 번호가 보호 구간에 묻혔다');
  assert.ok(r.text.includes('900101-*******'), '앞의 가려진 값은 건드리지 않는다');
});

// ── 날짜를 계좌로 오인하지 않는다 ─────────────────────────────────────────────
// 감사 detail·정산 사유는 maskPii 를 지나간다. 날짜가 계좌 패턴으로 삼켜지면 개인정보가
// 새는 것이 아니라 **조사에서 가장 먼저 보는 값**(어느 기간을 조회·반출했는가)이 사라진다.
test('§10.3 ISO8601 날짜·기간은 마스킹하지 않는다', behavioral, () => {
  for (const s of [
    '기간 2026-01-01T00:00:00.000Z~2026-02-01T00:00:00.000Z',
    '대상 기간 2026-08',
    '시행일 2026-12-31',
    '2026-03-01 09:30 접수',
  ]) {
    const r = g.maskPii(s);
    assert.equal(r.text, s, `날짜가 바뀌었다: ${r.text}`);
    assert.deepEqual(r.hits, []);
  }
});

test('§10.3 날짜 보호가 개인정보를 통과시키지 않는다 — 네 규칙 모두', behavioral, () => {
  const cases = [
    ['rrn', '2026-01-01 접수 900101-1234567', '900101-1234567'],
    ['card', '2026-01-01 결제 1234-5678-9012-3456', '1234-5678-9012-3456'],
    ['phone', '2026-01-01 연락처 010-1234-5678', '010-1234-5678'],
    ['account', '2026-01-01 계좌 110-123-456789', '110-123-456789'],
  ];
  for (const [name, input, secret] of cases) {
    const r = g.maskPii(input);
    assert.ok(r.hits.includes(name), `${name} 이 날짜 옆에서 안 잡혔다: ${r.text}`);
    assert.equal(r.text.includes(secret), false, `${name} 원문이 그대로 남았다: ${r.text}`);
    assert.ok(r.text.includes('2026-01-01'), '날짜는 보존돼야 한다');
  }
});

test('§10.3 날짜처럼 생긴 앞자리로 카드·계좌가 보호 구간에 숨지 않는다', behavioral, () => {
  // `1234-56` 은 날짜(YYYY-MM)처럼 보이지만 월 범위를 벗어나고 뒤에 숫자가 이어진다.
  const card = g.maskPii('1234-5678-9012-3456');
  assert.deepEqual(card.hits, ['card']);
  const acct = g.maskPii('1002-123-456789');
  assert.deepEqual(acct.hits, ['account']);
  assert.equal(acct.text.includes('456789'), false);
});
