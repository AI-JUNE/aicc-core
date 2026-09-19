// 커넥터 실행 오케스트레이터. 여기서 고정하는 것은 **순서**와 **하지 않는 일**이다 —
// 멱등 키가 시도 간 바뀌지 않는 것, 동의 없이 호출하지 않는 것, 호출 전에 막힌 것을
// 백엔드 장애로 집계하지 않는 것. 셋 다 빠져도 예외가 나지 않아서 검사로만 드러난다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let X = null;
try { X = await import('../src/integration/executeConnector.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: X ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't1' };

const def = (over = {}) => ({
  id: 'c_balance', tenantId: 't1', name: '잔액조회', method: 'query',
  endpointRef: 'secret://core/balance', residency: 'domestic', timeoutMs: 3000,
  params: [{ name: 'acct', fromSlot: 'account_no', required: true }],
  outputs: [{ field: 'balance', toSlot: 'balance' }],
  onFailure: 'branch', ...over,
});

const slots = { account_no: '110-1234' };

/** 호출 기록을 남기는 포트. 응답은 큐에서 하나씩 꺼낸다. */
function recordingPort(responses) {
  const calls = [];
  return {
    calls,
    async call(req) {
      calls.push(req);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (typeof r === 'function') return r(req);
      return r;
    },
  };
}

const policy = (over = {}) => ({
  tenantId: 't1', version: 1, updatedAt: '2026-09-19T00:00:00Z', updatedBy: 'admin', approved: true,
  requirements: [{ purpose: 'personal_data_collection', required: true }], ...over,
});
const granted = [{
  tenantId: 't1', subjectRef: 'cust_hash_1', purpose: 'personal_data_collection',
  state: 'granted', at: '2026-09-19T00:00:00Z', via: 'voice', policyVersion: 1,
}];
const consentCtx = (over = {}) => ({
  policy: policy(), records: granted, subjectRef: 'cust_hash_1', now: '2026-09-19T01:00:00Z', ...over,
});

const run = (over = {}) => X.executeConnector({
  def: def(), slots, scope, interactionId: 'i1', idempotencyKey: 'idem-1',
  port: recordingPort([{ ok: true, data: { balance: '10000' } }]), allowOverseas: false, ...over,
});

// ── 정적 계약 ────────────────────────────────────────────────────────────────

test('실행기는 네트워크에 직접 닿지 않는다 — 호출은 주입된 포트가 한다(§6.2)', () => {
  const src = read('src/integration/executeConnector.ts');
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /https?:\/\/[a-z]/i);
});

test('저장 경로는 maskPii 를 지난다(§10.3)', () => {
  assert.match(read('src/integration/executeConnector.ts'), /import \{ maskPii \}/);
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('성공하면 allowlist 슬롯만 나오고 선언되지 않은 필드는 드러난다', b, async () => {
  const port = recordingPort([{ ok: true, data: { balance: '10000', 주민번호: '900101-1234567' }, latencyMs: 42 }]);
  const r = await run({ port });
  assert.equal(r.kind, 'ok');
  assert.deepEqual(Object.keys(r.slots), ['balance']);
  assert.deepEqual(r.droppedFields, ['주민번호']);
  assert.equal(r.attempts, 1);
  assert.equal(r.latencyMs, 42);
  assert.equal(r.noOutputApplied, false);
});

test('담기는 값은 maskPii 를 통과한다 — 슬롯은 이벤트·요약으로 흘러가는 저장 경로다(§10.3)', b, async () => {
  const d = def({ outputs: [{ field: 'memo', toSlot: 'memo' }] });
  const port = recordingPort([{ ok: true, data: { memo: '연락처 010-1234-5678' } }]);
  const r = await X.executeConnector({ def: d, slots, scope, interactionId: 'i1', idempotencyKey: 'k', port, allowOverseas: false });
  assert.equal(r.kind, 'ok');
  assert.doesNotMatch(r.slots.memo, /010-1234-5678/);
  assert.deepEqual(r.maskedSlots, ['memo']);
});

test('출력이 선언됐는데 한 칸도 못 채우면 조용히 넘기지 않고 드러낸다', b, async () => {
  const port = recordingPort([{ ok: true, data: { other: 'x' } }]);
  const r = await run({ port });
  assert.equal(r.kind, 'ok');
  assert.equal(r.noOutputApplied, true);
  assert.deepEqual(r.missingFields, ['balance']);
});

// ── 멱등 키 ──────────────────────────────────────────────────────────────────

test('재시도해도 멱등 키는 바뀌지 않는다 — 바뀌면 command 재시도가 곧 중복 처리다', b, async () => {
  const d = def({ method: 'command', retry: { maxAttempts: 3 }, outputs: [] });
  const port = recordingPort([
    { ok: false, code: 'timeout' }, { ok: false, code: 'timeout' }, { ok: true, data: {} },
  ]);
  const r = await X.executeConnector({
    def: d, slots, scope, interactionId: 'i1', idempotencyKey: 'idem-fixed', port,
    allowOverseas: false, backoffMs: () => 0,
  });
  assert.equal(r.kind, 'ok');
  assert.equal(port.calls.length, 3);
  assert.deepEqual([...new Set(port.calls.map((c) => c.idempotencyKey))], ['idem-fixed']);
  assert.deepEqual(port.calls.map((c) => c.attempt), [1, 2, 3]);
});

test('멱등 키가 없으면 호출 자체를 하지 않는다', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await run({ port, idempotencyKey: '  ' });
  assert.equal(r.kind, 'blocked');
  assert.equal(r.reason, 'idempotency_key_missing');
  assert.equal(port.calls.length, 0);
});

// ── 게이트: 호출 전에 막힌다 ─────────────────────────────────────────────────

test('개인정보 파라미터가 있는데 동의 컨텍스트가 없으면 호출하지 않는다(§10.1)', b, async () => {
  const d = def({ params: [{ name: 'rrn', fromSlot: 'rrn', required: true, pii: true }] });
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await X.executeConnector({
    def: d, slots: { rrn: '900101-1234567' }, scope, interactionId: 'i1', idempotencyKey: 'k', port, allowOverseas: false,
  });
  assert.equal(r.kind, 'blocked');
  assert.equal(r.reason, 'consent_context_missing');
  assert.equal(port.calls.length, 0, '없음을 통과로 읽으면 주민번호가 그대로 나간다');
});

test('동의가 없으면 게이트가 막는다', b, async () => {
  const d = def({ params: [{ name: 'rrn', fromSlot: 'rrn', required: true, pii: true }] });
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await X.executeConnector({
    def: d, slots: { rrn: '900101-1234567' }, scope, interactionId: 'i1', idempotencyKey: 'k', port,
    allowOverseas: false, consent: consentCtx({ records: [] }),
  });
  assert.equal(r.kind, 'blocked');
  assert.equal(r.reason, 'consent_denied');
  assert.equal(port.calls.length, 0);
});

test('동의가 있으면 개인정보 파라미터도 통과한다 — 값은 마스킹하지 않는다(마스킹하면 조회가 안 된다)', b, async () => {
  const d = def({ params: [{ name: 'rrn', fromSlot: 'rrn', required: true, pii: true }], outputs: [] });
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await X.executeConnector({
    def: d, slots: { rrn: '900101-1234567' }, scope, interactionId: 'i1', idempotencyKey: 'k', port,
    allowOverseas: false, consent: consentCtx(),
  });
  assert.equal(r.kind, 'ok');
  assert.equal(port.calls[0].params.rrn, '900101-1234567');
});

test('국외이전 불가 테넌트에 해외 연동은 호출 전에 막힌다(§10.3)', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await run({ def: def({ residency: 'overseas' }), port, allowOverseas: false });
  assert.equal(r.kind, 'blocked');
  assert.equal(r.reason, 'residency');
  assert.equal(port.calls.length, 0);
});

test('선언이 유효하지 않으면 호출하지 않는다 — 예약 슬롯 덮어쓰기를 통화 중에 만나면 안 된다', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await run({ def: def({ outputs: [{ field: 'x', toSlot: '__goal_completed__' }] }), port });
  assert.equal(r.kind, 'blocked');
  assert.equal(r.reason, 'invalid_definition');
  assert.equal(port.calls.length, 0);
});

test('필수 슬롯이 비면 호출하지 않고 슬롯 이름만 돌려준다(값이 아니다)', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await run({ port, slots: {} });
  assert.equal(r.kind, 'blocked');
  assert.deepEqual(r.missingSlots, ['account_no']);
  assert.equal(port.calls.length, 0);
});

test('재시도를 선언했는데 backoff 가 없으면 설정 오류로 막는다', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await run({ def: def({ retry: { maxAttempts: 2 } }), port });
  assert.equal(r.kind, 'blocked');
  assert.equal(r.reason, 'retry_without_backoff');
  assert.equal(port.calls.length, 0);
});

test('남의 테넌트 커넥터 호출만은 던진다 — 폴백할 사안이 아니다(§11.1)', b, async () => {
  await assert.rejects(() => run({ def: def({ tenantId: 't2' }) }), /§11\.1/);
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('재시도 대상이 아니면 즉시 onFailure 로 내린다', b, async () => {
  const port = recordingPort([{ ok: false, code: 'not_found' }]);
  const r = await run({ def: def({ retry: { maxAttempts: 3 } }), port, backoffMs: () => 0 });
  assert.equal(r.kind, 'failed');
  assert.equal(r.reason, 'not_retryable');
  assert.equal(r.action, 'branch');
  assert.equal(port.calls.length, 1);
});

test('시도를 소진하면 실패로 확정한다', b, async () => {
  const port = recordingPort([{ ok: false, code: 'server_error' }]);
  const r = await run({ def: def({ retry: { maxAttempts: 2 } }), port, backoffMs: () => 0 });
  assert.equal(r.kind, 'failed');
  assert.equal(r.reason, 'attempts_exhausted');
  assert.equal(r.attempts, 2);
});

test('포트가 던져도 통화를 끊지 않는다(§9.3)', b, async () => {
  const port = { calls: [], async call() { throw new Error('소켓 끊김 010-1234-5678'); } };
  const r = await run({ port });
  assert.equal(r.kind, 'failed');
  assert.equal(r.code, 'unavailable');
  assert.doesNotMatch(r.detail ?? '', /010-1234-5678/, '예외 원문도 마스킹을 지난다(§10.3)');
});

test('포트가 규약을 어긴 값을 주면 성공으로도 실패로도 임의 해석하지 않는다', b, async () => {
  for (const bad of [undefined, null, 'ok', { ok: true }, { ok: true, data: [1, 2] }, { yes: 1 }]) {
    const port = { calls: [], async call() { return bad; } };
    const r = await run({ port });
    assert.equal(r.kind, 'failed', `${JSON.stringify(bad)} 를 성공으로 읽었다`);
    assert.equal(r.code, 'schema_mismatch');
  }
});

test('실패 detail 에 업무시스템 응답 원문이 그대로 남지 않는다', b, async () => {
  const port = recordingPort([{ ok: false, code: 'server_error', detail: '조회 실패: 홍길동 010-9999-8888' }]);
  const r = await run({ port });
  assert.doesNotMatch(r.detail, /010-9999-8888/);
});

// ── 헬스 집계(§9.3) ──────────────────────────────────────────────────────────

test('호출 전에 막힌 건은 백엔드 장애로 집계하지 않는다 — 집계하면 멀쩡한 시스템이 down 이 된다', b, async () => {
  const samples = [];
  await run({ slots: {}, onHealth: (s) => samples.push(s), now: () => '2026-09-19T00:00:00Z' });
  assert.deepEqual(samples, []);
  await run({ def: def({ residency: 'overseas' }), onHealth: (s) => samples.push(s), now: () => '2026-09-19T00:00:00Z' });
  assert.deepEqual(samples, []);
});

test('한 번 실패로 down 을 적지 않는다 — 재시도가 남아 있으면 degraded 다', b, async () => {
  const samples = [];
  const port = recordingPort([{ ok: false, code: 'timeout' }, { ok: true, data: { balance: '1' } }]);
  const r = await run({
    def: def({ retry: { maxAttempts: 2 } }), port, backoffMs: () => 0,
    onHealth: (s) => samples.push(s), now: () => '2026-09-19T00:00:00Z',
  });
  assert.equal(r.kind, 'ok');
  assert.deepEqual(samples.map((s) => s.state), ['degraded', 'up']);
  assert.deepEqual([...new Set(samples.map((s) => s.component))], ['backend']);
});

test('시계를 주지 않으면 헬스 샘플을 만들지 않는다(§13-3)', b, async () => {
  const samples = [];
  await run({ onHealth: (s) => samples.push(s) });
  assert.deepEqual(samples, []);
});

// ── Runner 접점 ──────────────────────────────────────────────────────────────

test('성공·실패·차단이 모두 Runner 입력으로 옮겨지고, 차단은 성공이 아니다', b, async () => {
  const ok = await run({});
  assert.deepEqual(X.toFlowInput(ok), { kind: 'connectorResult', ok: true, slots: { balance: '10000' } });

  const failed = await run({ port: recordingPort([{ ok: false, code: 'not_found' }]) });
  assert.deepEqual(X.toFlowInput(failed), { kind: 'connectorResult', ok: false, errorCode: 'not_found' });

  const blocked = await run({ slots: {} });
  const fi = X.toFlowInput(blocked);
  assert.equal(fi.ok, false, '동의가 없어 못 불렀는데 다음 노드로 넘어가면 고객은 빈 안내를 듣는다');
  assert.equal(fi.errorCode, 'missing_slots');
});

test('기록용 요청 사본은 pii 값을 지운다(§6.1 규약 2)', b, () => {
  const d = def({ params: [{ name: 'rrn', fromSlot: 'rrn', required: true, pii: true }] });
  const red = X.redactedRequestOf(d, { rrn: '900101-1234567' }, scope, 'i1', 'k');
  assert.equal(red.params.rrn, '[REDACTED]');
  assert.equal(X.redactedRequestOf(d, {}, scope, 'i1', 'k'), undefined);
});
