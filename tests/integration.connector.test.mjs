import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let C = null;
try { C = await import('../src/integration/connector.ts'); } catch { /* 구형 런타임 */ }
const behavioral = { skip: C ? false : '타입 스트리핑 미지원 런타임' };

const src = read('src/integration/connector.ts');

test('커넥터 계약은 엔드포인트 원문·자격증명을 Core에 두지 않는다(§6.1)', () => {
  assert.match(src, /endpointRef/);
  assert.doesNotMatch(src, /https?:\/\/[a-z]/i);
});

test('응답 적용 경로는 maskPii를 통과한다(§10.3)', () => {
  assert.match(src, /import \{ maskPii \}/);
});

const def = {
  id: 'crm_lookup', tenantId: 't_bank', name: '고객조회', method: 'query',
  endpointRef: 'secret://crm/lookup', residency: 'domestic', timeoutMs: 3000,
  params: [
    { name: 'phone', fromSlot: 'phone', required: true, pii: true },
    { name: 'branch', fromSlot: 'branch', required: false },
  ],
  outputs: [
    { field: 'customerName', toSlot: 'customer_name' },
    { field: 'cardStatus', toSlot: 'card_status' },
  ],
  retry: { maxAttempts: 3 },
  onFailure: 'branch',
};

const ctx = { scope: { tenantId: 't_bank' }, interactionId: 'i_1', idempotencyKey: 'k_1' };

test('정상 선언은 검증을 통과한다', behavioral, () => {
  assert.deepEqual(C.validateConnector(def), []);
  assert.equal(C.connectorOk([]), true);
});

test('예약 슬롯·중복 슬롯·잘못된 timeout은 오류다', behavioral, () => {
  const bad = { ...def, timeoutMs: 0, outputs: [
    { field: 'a', toSlot: '__goal_completed__' },
    { field: 'b', toSlot: 'x' },
    { field: 'c', toSlot: 'x' },
  ] };
  const codes = C.validateConnector(bad).map(i => i.code);
  assert.ok(codes.includes('E_TIMEOUT_INVALID'));
  assert.ok(codes.includes('E_OUTPUT_RESERVED_SLOT'));
  assert.ok(codes.includes('E_OUTPUT_DUPLICATE_SLOT'));
  assert.equal(C.connectorOk(C.validateConnector(bad)), false);
});

test('명령형 커넥터 재시도는 경고로 드러난다(중복 처리 위험)', behavioral, () => {
  const cmd = { ...def, method: 'command', retry: { maxAttempts: 2 } };
  const codes = C.validateConnector(cmd).map(i => i.code);
  assert.ok(codes.includes('W_COMMAND_RETRY'));
});

test('국외이전 불가 테넌트는 해외 연동을 차단한다(§10.3)', behavioral, () => {
  const overseas = { ...def, residency: 'overseas' };
  assert.throws(() => C.assertConnectorResidency(overseas, false), /§10\.3/);
  assert.doesNotThrow(() => C.assertConnectorResidency(overseas, true));
  assert.doesNotThrow(() => C.assertConnectorResidency(def, false));
});

test('다른 테넌트 스코프로는 커넥터를 쓸 수 없다(§11.1)', behavioral, () => {
  assert.throws(() => C.assertConnectorScope(def, { tenantId: 't_other' }), /§11\.1/);
});

test('필수 슬롯이 비면 호출하지 않고 결측을 알려준다', behavioral, () => {
  const r = C.buildRequest(def, { branch: '강남' }, ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['phone']);
});

test('요청 파라미터는 마스킹하지 않는다 — 마스킹하면 조회가 안 된다', behavioral, () => {
  const r = C.buildRequest(def, { phone: '010-1234-5678', branch: '강남' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.request.params.phone, '010-1234-5678');
  assert.equal(r.request.attempt, 1);
  assert.equal(r.request.idempotencyKey, 'k_1');
  assert.equal(r.request.endpointRef, 'secret://crm/lookup');
});

test('기록용 사본은 pii 파라미터를 지운다(§10.3)', behavioral, () => {
  const r = C.buildRequest(def, { phone: '010-1234-5678', branch: '강남' }, ctx);
  const red = C.redactRequest(def, r.request);
  assert.equal(red.params.phone, '[REDACTED]');
  assert.equal(red.params.branch, '강남');
  assert.equal(r.request.params.phone, '010-1234-5678');  // 원본 불변
});

test('선언되지 않은 pii 값도 기록 사본에서 마스킹된다(이중 방어)', behavioral, () => {
  const d2 = { ...def, params: [{ name: 'memo', fromSlot: 'memo', required: true }] };
  const r = C.buildRequest(d2, { memo: '연락처 010-1234-5678' }, ctx);
  const red = C.redactRequest(d2, r.request);
  assert.match(red.params.memo, /\*/);
  assert.doesNotMatch(red.params.memo, /1234-5678/);
});

test('응답은 allowlist 필드만 슬롯이 되고 나머지는 버려진다', behavioral, () => {
  const out = C.applyResponse(def, {
    customerName: '홍길동', cardStatus: '발급완료',
    rrn: '900101-1234567', internalMemo: 'x',
  });
  assert.deepEqual(Object.keys(out.slots).sort(), ['card_status', 'customer_name']);
  assert.ok(out.droppedFields.includes('rrn'));
  assert.ok(out.droppedFields.includes('internalMemo'));
});

test('슬롯에 담기는 값은 마스킹을 통과한다(§10.3)', behavioral, () => {
  const d2 = { ...def, outputs: [{ field: 'note', toSlot: 'note' }] };
  const out = C.applyResponse(d2, { note: '주민번호 900101-1234567 확인' });
  assert.doesNotMatch(out.slots.note, /1234567/);
  assert.deepEqual(out.maskedSlots, ['note']);
});

test('스칼라가 아닌 값·누락 필드는 슬롯이 되지 않고 드러난다', behavioral, () => {
  const out = C.applyResponse(def, { customerName: { first: '길동' } });
  assert.deepEqual(out.unusableFields, ['customerName']);
  assert.deepEqual(out.missingFields, ['cardStatus']);
  assert.deepEqual(out.slots, {});
});

test('숫자·불리언은 문자열 슬롯으로 변환된다', behavioral, () => {
  const d2 = { ...def, outputs: [{ field: 'cnt', toSlot: 'cnt' }, { field: 'ok', toSlot: 'ok' }] };
  const out = C.applyResponse(d2, { cnt: 3, ok: false });
  assert.equal(out.slots.cnt, '3');
  assert.equal(out.slots.ok, 'false');
});

test('일시적 오류만 재시도하고, 소진되면 onFailure로 내린다(§9.3)', behavioral, () => {
  assert.deepEqual(C.decideOnFailure(def, 'timeout', 1), { retry: true, nextAttempt: 2 });
  assert.deepEqual(C.decideOnFailure(def, 'timeout', 3), { retry: false, action: 'branch', reason: 'attempts_exhausted' });
  assert.deepEqual(C.decideOnFailure(def, 'not_found', 1), { retry: false, action: 'branch', reason: 'not_retryable' });
});

test('retry 미설정이면 재시도하지 않는다 — 권장값을 코드가 정하지 않는다(§13-3)', behavioral, () => {
  const noRetry = { ...def, retry: undefined, onFailure: 'handoff_agent' };
  assert.deepEqual(C.decideOnFailure(noRetry, 'timeout', 1), { retry: false, action: 'handoff_agent', reason: 'attempts_exhausted' });
});

test('retryOn을 명시하면 그 목록만 재시도한다', behavioral, () => {
  const d2 = { ...def, retry: { maxAttempts: 2, retryOn: ['unauthorized'] } };
  assert.equal(C.decideOnFailure(d2, 'unauthorized', 1).retry, true);
  assert.equal(C.decideOnFailure(d2, 'timeout', 1).retry, false);
});

test('커넥터 장애는 §9.3 L3 지식 계층으로 집계된다', behavioral, () => {
  assert.equal(C.CONNECTOR_HEALTH_COMPONENT, 'backend');
});

test('pii 파라미터 목록은 동의 게이트가 쓸 수 있게 노출된다(§10.1)', behavioral, () => {
  assert.deepEqual(C.piiParams(def), ['phone']);
});
