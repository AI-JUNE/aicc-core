import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null;
try { m = await import('../src/api/errors.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('표준 봉투는 코드·상태·재시도 가능 여부를 함께 준다', b, () => {
  const r = m.apiError('E_RATE_LIMITED', undefined, { requestId: 'req_1', retryAfterMs: 1500 });
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'E_RATE_LIMITED');
  assert.equal(r.body.error.retryable, true);
  assert.equal(r.body.error.retryAfterMs, 1500);
  assert.equal(r.body.error.requestId, 'req_1');
  assert.ok(r.body.error.messageKo.length > 0);
});

test('코드마다 상태·재시도 매핑이 한 곳에 고정돼 있다', b, () => {
  assert.equal(m.HTTP_STATUS.E_INVALID_INPUT, 400);
  assert.equal(m.HTTP_STATUS.E_FORBIDDEN, 403);
  assert.equal(m.HTTP_STATUS.E_TIMEOUT, 504);
  assert.equal(m.RETRYABLE.E_INVALID_INPUT, false);
  assert.equal(m.RETRYABLE.E_UPSTREAM, true);
  assert.deepEqual(Object.keys(m.HTTP_STATUS).sort(), Object.keys(m.RETRYABLE).sort());
});

test('ApiError 는 details 를 유지한 채 봉투로 바뀐다', b, () => {
  const e = new m.ApiError('E_INVALID_INPUT', '입력 확인', {
    details: [{ field: 'flowId', reason: 'required', messageKo: '시나리오 항목은 필수입니다.' }],
  });
  const r = m.toErrorResponse(e, 'req_2');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.length, 1);
  assert.equal(r.body.error.details[0].field, 'flowId');
});

test('검증기는 여러 항목의 문제를 한 번에 모아 준다', b, () => {
  const res = m.validate({ name: '', age: 200 }, {
    name: { type: 'string', required: true, labelKo: '이름' },
    age: { type: 'number', max: 150, labelKo: '나이' },
    email: { type: 'string', required: true, labelKo: '이메일' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.issues.length, 3);
  assert.deepEqual(res.issues.map((i) => i.field).sort(), ['age', 'email', 'name']);
  assert.ok(res.issues.every((i) => i.messageKo.includes('항목')));
});

test('통과한 값만 value 로 넘어온다', b, () => {
  const res = m.validate({ tenantId: 't1', extra: '무시' }, { tenantId: { type: 'string', required: true } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { tenantId: 't1' });
});

test('점 표기 경로로 중첩 필드를 검증한다 (§11.1 스코프)', b, () => {
  const schema = { 'scope.tenantId': { type: 'string', required: true, labelKo: '테넌트' } };
  assert.equal(m.validate({ scope: { tenantId: 't1' } }, schema).ok, true);
  const bad = m.validate({ scope: {} }, schema);
  assert.equal(bad.ok, false);
  assert.equal(bad.issues[0].reason, 'required');
});

test('validationResponse 는 통과 시 undefined 다', b, () => {
  const ok = m.validate({ a: 'x' }, { a: { type: 'string', required: true } });
  assert.equal(m.validationResponse(ok), undefined);
  const ng = m.validate({}, { a: { type: 'string', required: true } });
  assert.equal(m.validationResponse(ng, 'req_3').status, 400);
});

// ── 실패 경로·경계 ───────────────────────────────────────────────────────────

test('알 수 없는 예외는 내부 오류로 덮고 원문을 노출하지 않는다', b, () => {
  const r = m.toErrorResponse(new Error('db://prod-1 접속 실패 (user=admin)'), 'req_4');
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'E_INTERNAL');
  assert.equal(JSON.stringify(r).includes('prod-1'), false);
  assert.equal(JSON.stringify(r).includes('stack'), false);
});

test('엔진 어댑터 오류코드를 표준 코드로 옮긴다', b, () => {
  assert.equal(m.toErrorResponse({ code: 'E_HTTP' }).body.error.code, 'E_UPSTREAM');
  assert.equal(m.toErrorResponse({ code: 'E_PROTOCOL' }).body.error.code, 'E_UPSTREAM');
  assert.equal(m.toErrorResponse({ code: 'E_INPUT' }).body.error.code, 'E_INVALID_INPUT');
  assert.equal(m.toErrorResponse({ code: 'E_LIMIT' }).body.error.code, 'E_INVALID_INPUT');
  assert.equal(m.toErrorResponse({ code: 'E_TIMEOUT' }).body.error.code, 'E_TIMEOUT');
  assert.equal(m.toErrorResponse({ code: 'E_APPROVAL_REQUIRED' }).body.error.code, 'E_APPROVAL_REQUIRED');
});

test('메시지와 검증 안내에 개인정보가 섞여도 마스킹된다 (§10.3)', b, () => {
  const r = m.apiError('E_INVALID_INPUT', '010-1234-5678 은(는) 등록할 수 없습니다', {
    details: [{ field: 'phone', reason: 'format', messageKo: '010-1234-5678 형식 오류' }],
  });
  const dump = JSON.stringify(r);
  assert.equal(dump.includes('010-1234-5678'), false);
});

test('빈 메시지는 코드별 기본 안내로 채운다', b, () => {
  assert.ok(m.apiError('E_NOT_FOUND', '   ').body.error.messageKo.includes('찾을 수 없습니다'));
  assert.ok(m.apiError('E_APPROVAL_REQUIRED').body.error.messageKo.includes('[승인 필요]'));
});

test('타입 불일치는 type 사유로 보고하고 값을 통과시키지 않는다', b, () => {
  const res = m.validate({ count: '3' }, { count: { type: 'number', labelKo: '건수' } });
  assert.equal(res.ok, false);
  assert.equal(res.issues[0].reason, 'type');
  assert.equal(res.value.count, undefined);
});

test('길이·범위·허용값·형식 위반이 각각 다른 사유로 분류된다', b, () => {
  const res = m.validate(
    { code: 'ab', n: -1, kind: 'sms', phone: '전화' },
    {
      code: { type: 'string', minLength: 3 },
      n: { type: 'number', min: 0 },
      kind: { type: 'string', oneOf: ['voice', 'chat'] },
      phone: { type: 'string', pattern: /^\d{2,3}-\d{3,4}-\d{4}$/, formatHintKo: '연락처 형식이 올바르지 않습니다.' },
    },
  );
  const byField = Object.fromEntries(res.issues.map((i) => [i.field, i.reason]));
  assert.deepEqual(byField, { code: 'length', n: 'range', kind: 'enum', phone: 'format' });
  assert.ok(res.issues.find((i) => i.field === 'phone').messageKo.includes('연락처'));
});

test('빈 입력·null 입력에서도 검증기가 깨지지 않는다', b, () => {
  for (const input of [undefined, null, {}, 'not-an-object', 42]) {
    const res = m.validate(input, { a: { type: 'string', required: true } });
    assert.equal(res.ok, false);
    assert.equal(res.issues[0].reason, 'required');
  }
});

test('선택 항목이 비어 있으면 문제로 보지 않는다', b, () => {
  const res = m.validate({ note: '' }, { note: { type: 'string', minLength: 5 } });
  assert.equal(res.ok, true);
  assert.equal(res.value.note, undefined);
});

test('NaN·Infinity 는 숫자로 통과시키지 않는다', b, () => {
  assert.equal(m.validate({ n: NaN }, { n: { type: 'number' } }).ok, false);
  assert.equal(m.validate({ n: Infinity }, { n: { type: 'number' } }).ok, false);
});
