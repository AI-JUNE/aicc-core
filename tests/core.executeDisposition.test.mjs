// 파기 실행 오케스트레이터 검사 — 설계서 §8.2·§10.3·§11.1·§9.3·§13-3.
//
// 여기서 고정하는 것은 "지워진다"가 아니라 **지우면 안 되는 것을 지우지 않는다**와
// **지우지 않았는데 지웠다고 적지 않는다**이다. 둘 다 예외로 나타나지 않는 실패다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let ex = null, ret = null, audit = null;
try {
  ex = await import('../src/core/executeDisposition.ts');
  ret = await import('../src/core/retention.ts');
  audit = await import('../src/audit/log.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: ex ? false : '타입 스트리핑 미지원 런타임' };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/core/executeDisposition.ts');

const scope = { tenantId: 't1' };
const NOW = '2026-03-02T01:00:00.000Z';
const ON = { activation: 'enabled', approvalRef: 'LEGAL-2026-001' };

const policy = (over = {}) => ({
  tenantId: 't1',
  rules: [
    { dataClass: 'recording', retentionDays: 30, disposition: 'delete', basisKo: '계약 제8조', approved: true },
    { dataClass: 'pii_field', retentionDays: 30, disposition: 'delete', basisKo: '계약 제8조', approved: true },
    { dataClass: 'consent_record', retentionDays: 30, disposition: 'archive', basisKo: '법령', approved: true },
  ],
  ...over,
});

// 기한이 한참 지난 건 / 한참 남은 건
const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-03-01T00:00:00.000Z';

const rec = (id, dataClass, createdAt, over = {}) => ({ id, tenantId: 't1', dataClass, createdAt, ...over });

function plan(records, pol = policy()) {
  return ret.planDisposition(records, pol, NOW);
}

// ── 1) plan.decisions 를 순회하는 사고 ─────────────────────────────────────────

test('보존기간 내·법적 보류 건은 실행 대상에 들어가지 않는다(§8.2)', b, async () => {
  const p = plan([
    rec('r_old', 'recording', OLD),
    rec('r_new', 'recording', NEW),                     // 보존기간 내
    rec('r_hold', 'pii_field', OLD, { legalHold: true }), // 법적 보류
  ]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });

  assert.deepEqual(port.calls.delete, ['r_old']);
  assert.equal(r.counts.disposed, 1);
  assert.equal(r.counts.held, 1);
  assert.equal(r.held[0].recordId, 'r_hold');
  assert.ok(r.warnings.some((w) => w.includes('법적 보류')));
});

test('due 에 due 아닌 건이 섞여 들어오면 지우지 않고 실패로 적는다', b, async () => {
  const p = plan([rec('r_old', 'recording', OLD)]);
  const forged = { ...p, due: [...p.due, { recordId: 'r_keep', dataClass: 'recording', status: 'retained', reasonKo: '보존 중' }] };
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: forged, port, at: NOW, activation: ON, timeoutMs: 1000 });

  assert.equal(port.calls.delete.includes('r_keep'), false);
  assert.equal(r.ok, false);
  assert.equal(r.counts.failed, 1);
});

// ── 2) 활성화 기본 OFF ────────────────────────────────────────────────────────

test('활성화 선언이 없으면 포트를 한 번도 부르지 않는다 [승인 필요]', b, async () => {
  const p = plan([rec('r_old', 'recording', OLD), rec('c1', 'consent_record', OLD)]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, timeoutMs: 1000 });

  assert.deepEqual(port.calls.delete, []);
  assert.deepEqual(port.calls.archive, []);
  assert.equal(r.executed, false);
  assert.equal(r.activation, 'disabled');
  assert.equal(r.counts.dryRun, 2);
  assert.equal(r.counts.disposed, 0);
  assert.ok(r.warnings.some((w) => w.includes('[승인 필요]')));
});

test('활성화만 켜고 승인 근거가 없으면 실행하지 않는다', b, async () => {
  const p = plan([rec('r_old', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({
    scope, plan: p, port, at: NOW, timeoutMs: 1000,
    activation: { activation: 'enabled', approvalRef: '   ' },
  });
  assert.deepEqual(port.calls.delete, []);
  assert.equal(r.ok, false);
  assert.equal(r.activation, 'disabled');
  assert.ok(r.warnings.some((w) => w.includes('approvalRef')));
});

// ── 3) 처리 방식 ─────────────────────────────────────────────────────────────

test('archive 대상을 delete 로 대신 처리하지 않는다', b, async () => {
  const p = plan([rec('c1', 'consent_record', OLD)]);
  const port = ex.createMemoryDisposalPort({ support: ['delete'] }); // archive 미구현
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });

  assert.deepEqual(port.calls.delete, []);
  assert.equal(r.counts.unsupported, 1);
  assert.equal(r.outcomes[0].status, 'unsupported');
  assert.equal(r.ok, false);
});

test('처리 방식별로 포트 메서드가 갈려 호출된다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD), rec('c1', 'consent_record', OLD)]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });
  assert.deepEqual(port.calls.delete, ['r1']);
  assert.deepEqual(port.calls.archive, ['c1']);
  assert.equal(r.ok, true);
});

// ── 4) 규약을 어긴 반환값 ─────────────────────────────────────────────────────

test('포트가 아무것도 돌려주지 않으면 파기로 적지 않는다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = { name: 'stub', delete: () => undefined };
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });
  assert.equal(r.counts.disposed, 0);
  assert.equal(r.counts.failed, 1);
  assert.ok(r.outcomes[0].reasonKo.includes('규약'));
});

test('ok 가 true 가 아닌 값이면 파기로 적지 않는다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = { name: 'stub', delete: () => ({ ok: 'yes' }) };
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });
  assert.equal(r.counts.disposed, 0);
  assert.equal(r.counts.failed, 1);
});

// ── 5) 부분 실패 ──────────────────────────────────────────────────────────────

test('한 건이 던져도 스윕은 멈추지 않고, 실패 건은 파기로 적지 않는다(§9.3)', b, async () => {
  const p = plan([rec('r1', 'recording', OLD), rec('r2', 'recording', OLD), rec('r3', 'recording', OLD)]);
  const port = {
    name: 'flaky',
    calls: [],
    delete(req) {
      this.calls.push(req.recordId);
      if (req.recordId === 'r2') throw new Error('연결이 끊겼습니다');
      return { ok: true };
    },
  };
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });
  assert.deepEqual(port.calls, ['r1', 'r2', 'r3']);
  assert.equal(r.counts.disposed, 2);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.ok, false);
});

test('실패 사유의 개인정보는 마스킹을 지난다(§10.3)', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = { name: 'leaky', delete: () => { throw new Error('행 삭제 실패: 010-1234-5678 / 900101-1234567'); } };
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });
  const why = r.outcomes[0].reasonKo;
  assert.equal(why.includes('010-1234-5678'), false);
  assert.equal(why.includes('900101-1234567'), false);
});

test('저장소가 거절하면 실패이고 사유가 남는다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort({ refuse: { r1: '보관 정책 잠금' } });
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });
  assert.equal(r.counts.failed, 1);
  assert.ok(r.outcomes[0].reasonKo.includes('보관 정책 잠금'));
});

// ── 6) 제한 시간 ──────────────────────────────────────────────────────────────

test('제한 시간을 넘긴 건은 성공으로도 파기로도 적지 않는다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD), rec('r2', 'recording', OLD)]);
  const port = {
    name: 'slow',
    delete: (req) => req.recordId === 'r1'
      ? new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 200))
      : { ok: true },
  };
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 20 });
  assert.equal(r.counts.disposed, 1);
  assert.equal(r.counts.failed, 1);
  assert.ok(r.outcomes[0].reasonKo.includes('제한 시간'));
});

test('제한 시간을 선언하지 않으면 경고로 드러난다(§13-3)', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON });
  assert.ok(r.warnings.some((w) => w.includes('timeoutMs')));
  assert.equal(r.counts.disposed, 1);
});

// ── 7) 중복·상한 ──────────────────────────────────────────────────────────────

test('계획에 중복 실린 레코드는 한 번만 부르고 드러낸다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const dup = { ...p, due: [...p.due, ...p.due] };
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: dup, port, at: NOW, activation: ON, timeoutMs: 1000 });
  assert.deepEqual(port.calls.delete, ['r1']);
  assert.equal(r.counts.duplicate, 1);
});

test('상한 밖 건은 조용히 사라지지 않고 not_attempted 로 남는다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD), rec('r2', 'recording', OLD), rec('r3', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000, limit: 2 });
  assert.equal(port.calls.delete.length, 2);
  assert.equal(r.counts.notAttempted, 1);
  assert.equal(r.counts.due, 3);
});

test('상한이 0 이하면 설정 결함으로 한 건도 실행하지 않는다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000, limit: 0 });
  assert.deepEqual(port.calls.delete, []);
  assert.equal(r.ok, false);
  assert.equal(r.counts.notAttempted, 1);
});

// ── 경계: 빈 입력·잘못된 시각·격리 ────────────────────────────────────────────

test('빈 계획은 성공이되 실행한 것은 없다', b, async () => {
  const p = plan([]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.executed, false);
  assert.equal(r.counts.due, 0);
});

test('오프셋 없는 시각이면 실행하지 않는다(§13-3)', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: '2026-03-02 10:00', activation: ON, timeoutMs: 1000 });
  assert.deepEqual(port.calls.delete, []);
  assert.equal(r.ok, false);
});

test('타 테넌트 계획을 실행하면 즉시 던진다(§11.1)', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort();
  await assert.rejects(
    () => ex.executeDisposition({ scope: { tenantId: 'rival' }, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 }),
    /§11\.1/,
  );
  assert.deepEqual(port.calls.delete, []);
});

test('보존 규칙이 없는 분류는 blocked 로 드러나고 실행되지 않는다(§8.2)', b, async () => {
  const p = plan([rec('v1', 'vector_index', OLD)]); // 정책에 규칙 없음
  const port = ex.createMemoryDisposalPort();
  const r = await ex.executeDisposition({ scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000 });
  assert.deepEqual(port.calls.delete, []);
  assert.equal(r.counts.blocked, 1);
  assert.ok(r.warnings.some((w) => w.includes('미정의')));
});

// ── 감사 ─────────────────────────────────────────────────────────────────────

test('시도 1건당 감사 레코드가 결과 그대로 남는다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD), rec('r2', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort({ refuse: { r2: '잠금' } });
  const hash = (s) => String(s.length) + ':' + s.slice(0, 8);
  const r = await ex.executeDisposition({
    scope, plan: p, port, at: NOW, activation: ON, timeoutMs: 1000,
    audit: {
      chain: audit.emptyChain(scope),
      actor: { userId: 'batch', roles: ['tenant_admin'] },
      hash,
      newRecordId: (n) => `ad_${n}`,
    },
  });
  assert.equal(r.chain.records.length, 2);
  assert.equal(r.chain.records[0].result, 'success');
  assert.equal(r.chain.records[1].result, 'error');
  assert.equal(r.chain.records[0].action, 'delete');
  assert.equal(audit.verifyChain(r.chain, hash).ok, true);
});

test('드라이런도 감사에 남되 파기로 읽히지 않는다', b, async () => {
  const p = plan([rec('r1', 'recording', OLD)]);
  const port = ex.createMemoryDisposalPort();
  const hash = (s) => String(s.length) + ':' + s.slice(0, 8);
  const r = await ex.executeDisposition({
    scope, plan: p, port, at: NOW, timeoutMs: 1000,
    audit: {
      chain: audit.emptyChain(scope),
      actor: { userId: 'batch', roles: ['tenant_admin'] },
      hash,
      newRecordId: (n) => `ad_${n}`,
    },
  });
  assert.equal(r.chain.records.length, 1);
  assert.equal(r.chain.records[0].result, 'denied');
});

// ── 소스 불변식 ───────────────────────────────────────────────────────────────

test('포트 호출 지점은 한 곳뿐이다(드라이런이 새지 않는다)', b, () => {
  const src = readFileSync(SRC, 'utf8');
  const calls = src.match(/await callPort\(/g) ?? [];
  assert.equal(calls.length, 1, '포트 호출이 여러 곳이면 활성화 판정을 한 곳만 고쳐도 한 건이 실제로 나간다');
});

test('판정 규칙을 복사하지 않는다 — 만료 계산이 이 파일에 없다(§2)', b, () => {
  const src = readFileSync(SRC, 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(/retentionDays/.test(code), false);
  assert.equal(/DAY_MS/.test(code), false);
});

// ── canStore(§8.2 저장 가능 판정) ─────────────────────────────────────────────

test('보존 규칙 없는 개인정보 분류는 저장을 거절한다(§8.2)', b, () => {
  const pol = { tenantId: 't1', rules: [] };
  const v = ret.canStore(pol, 'recording');
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'E_NO_RULE');
  assert.throws(() => ret.assertStorable(pol, 'recording'), /§8\.2/);
});

test('미승인 규칙은 저장도 막는다 — 파기 판정과 같은 조건이다 [승인 필요]', b, () => {
  const pol = {
    tenantId: 't1',
    rules: [{ dataClass: 'pii_field', retentionDays: 30, disposition: 'delete', basisKo: '계약', approved: false }],
  };
  const v = ret.canStore(pol, 'pii_field');
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'E_NOT_APPROVED');
  // 파기 쪽도 같은 판정이어야 한다(저장은 되는데 파기는 안 되는 조합 방지)
  const d = ret.decide(rec('x', 'pii_field', OLD), pol, NOW);
  assert.equal(d.status, 'blocked');
});

test('개인정보를 담지 않는 분류는 규칙이 없어도 막지 않고 경고만 낸다', b, () => {
  const v = ret.canStore({ tenantId: 't1', rules: [] }, 'interaction_event');
  assert.equal(v.allowed, true);
  assert.ok(v.warningKo.includes('자동 파기'));
});

test('알 수 없는 분류는 거절한다', b, () => {
  const v = ret.canStore({ tenantId: 't1', rules: [] }, 'nope');
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'E_UNKNOWN_CLASS');
});

test('승인된 규칙이 있으면 저장이 허용되고 경고가 없다', b, () => {
  const v = ret.canStore(policy(), 'recording');
  assert.equal(v.allowed, true);
  assert.equal(v.warningKo, undefined);
});
