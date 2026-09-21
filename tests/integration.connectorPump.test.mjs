// Api 노드 이행 펌프. 여기서 고정하는 것은 **무음으로 멈추지 않는 것**과 **멱등 키가 재진입 사이에
// 바뀌지 않는 것**이다. 둘 다 빠져도 예외가 나지 않는다 — 앞의 것은 통화가 조용히 멈추는 것으로,
// 뒤의 것은 이중 신청으로 나타나고 로그에는 성공 두 건만 남는다. 그래서 검사로만 드러난다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let P = null;
try { P = await import('../src/integration/connectorPump.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: P ? false : '타입 스트리핑 미지원 런타임' };

const scope = { tenantId: 't1' };

const def = (over = {}) => ({
  id: 'c_balance', tenantId: 't1', name: '잔액조회', method: 'query',
  endpointRef: 'secret://core/balance', residency: 'domestic', timeoutMs: 3000,
  params: [{ name: 'acct', fromSlot: 'account_no', required: true }],
  outputs: [{ field: 'balance', toSlot: 'balance' }],
  onFailure: 'branch', ...over,
});

const piiDef = (over = {}) => def({
  id: 'c_member', params: [{ name: 'rrn', fromSlot: 'rrn', required: true, pii: true }], ...over,
});

const slots = { account_no: '110-1234', rrn: '900101-1234567' };

function recordingPort(responses) {
  const calls = [];
  return {
    calls,
    async call(req) {
      calls.push(req);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      return typeof r === 'function' ? r(req) : r;
    },
  };
}

const registry = (defs) => ({ get: (id) => defs.find((d) => d.id === id) });

const policy = () => ({
  tenantId: 't1', version: 1, updatedAt: '2026-09-19T00:00:00Z', updatedBy: 'admin', approved: true,
  requirements: [{ purpose: 'personal_data_collection', required: true }],
});
const granted = [{
  tenantId: 't1', subjectRef: 'cust_hash_1', purpose: 'personal_data_collection',
  state: 'granted', at: '2026-09-19T00:00:00Z', via: 'voice', policyVersion: 1,
}];
const consentCtx = () => ({ policy: policy(), records: granted, subjectRef: 'cust_hash_1', now: '2026-09-19T01:00:00Z' });

const hop = (over = {}) => P.pumpConnectorHop({
  binding: {
    connectors: registry([def()]),
    port: recordingPort([{ ok: true, data: { balance: '10000' } }]),
    allowOverseas: false,
    ...(over.binding ?? {}),
  },
  connectorId: 'c_balance', scope, interactionId: 'i1', slots, call: 1,
  ...over,
});

const apiFlow = (nodes) => ({ id: 'f', version: 1, startNodeId: Object.keys(nodes)[0], nodes });

// ── 정적 계약 ────────────────────────────────────────────────────────────────

test('펌프는 네트워크에 직접 닿지 않는다 — 호출은 실행기가 주입된 포트로 한다(§6.2)', () => {
  const src = read('src/integration/connectorPump.ts');
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /https?:\/\/[a-z]/i);
});

test('판정을 여기서 다시 쓰지 않는다 — 게이트·재시도·마스킹은 실행기 한 곳이다(§2 이중 관리 방지)', () => {
  const src = read('src/integration/connectorPump.ts');
  for (const name of ['gateAction', 'assertConnectorResidency', 'decideOnFailure', 'buildRequest', 'applyResponse']) {
    assert.doesNotMatch(src, new RegExp(`\\b${name}\\s*\\(`), `${name} 를 펌프에서 다시 부르면 판정이 두 곳이 된다`);
  }
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('선언을 찾아 실행기까지 가고 성공을 Runner 입력으로 옮긴다', b, async () => {
  const port = recordingPort([{ ok: true, data: { balance: '10000' } }]);
  const r = await hop({ binding: { connectors: registry([def()]), port, allowOverseas: false } });
  assert.equal(r.outcome.kind, 'ok');
  assert.deepEqual(r.input, { kind: 'connectorResult', ok: true, slots: { balance: '10000' } });
  assert.equal(r.block, undefined);
  assert.equal(port.calls.length, 1);
  assert.equal(port.calls[0].idempotencyKey, r.idempotencyKey);
});

test('멱등 키는 같은 (통화·커넥터·회차)에 같고, 회차가 오를 때만 바뀐다', b, async () => {
  const a = P.defaultIdempotencyKey({ interactionId: 'i1', connectorId: 'c_balance', call: 1 });
  const a2 = P.defaultIdempotencyKey({ interactionId: 'i1', connectorId: 'c_balance', call: 1 });
  const c2 = P.defaultIdempotencyKey({ interactionId: 'i1', connectorId: 'c_balance', call: 2 });
  assert.equal(a, a2);
  assert.notEqual(a, c2);
  // 다른 통화의 같은 커넥터가 같은 키를 쓰면 상대 시스템이 한쪽을 중복으로 버린다.
  assert.notEqual(a, P.defaultIdempotencyKey({ interactionId: 'i2', connectorId: 'c_balance', call: 1 }));
});

test('호스트가 키 규칙을 바꿔도 그 규칙이 그대로 쓰인다', b, async () => {
  const port = recordingPort([{ ok: true, data: { balance: '1' } }]);
  const r = await hop({
    binding: {
      connectors: registry([def()]), port, allowOverseas: false,
      idempotencyKey: (id) => `X-${id.connectorId}-${id.call}`,
    },
  });
  assert.equal(r.idempotencyKey, 'X-c_balance-1');
  assert.equal(port.calls[0].idempotencyKey, 'X-c_balance-1');
});

// ── 선언을 못 찾는 경우 (무음의 원인) ─────────────────────────────────────────

test('선언이 없으면 업무시스템을 부르지 않고 실패로 내린다 — 무음으로 멈추지 않는다', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await hop({ binding: { connectors: registry([]), port, allowOverseas: false } });
  assert.equal(r.block, 'connector_undefined');
  assert.equal(r.outcome, undefined);
  assert.equal(r.input.ok, false);
  assert.equal(r.input.errorCode, 'connector_undefined');
  assert.equal(port.calls.length, 0);
});

test('선언 미존재는 업무시스템 장애로 집계하지 않는다 — 멀쩡한 시스템이 down 으로 적히면 전 채널이 떨어진다', b, async () => {
  const samples = [];
  await hop({
    binding: { connectors: registry([]), port: recordingPort([{ ok: true, data: {} }]), allowOverseas: false },
    onHealth: (s) => samples.push(s), now: () => '2026-09-21T00:00:00Z',
  });
  assert.equal(samples.length, 0);
});

test('선언 조회가 던져도 펌프는 던지지 않는다 — 호스트 버그로 통화가 끊기지 않는다(§9.3)', b, async () => {
  const r = await hop({
    binding: {
      connectors: { get() { throw new Error('레지스트리 장애'); } },
      port: recordingPort([{ ok: true, data: {} }]), allowOverseas: false,
    },
  });
  assert.equal(r.block, 'connector_undefined');
  assert.equal(r.input.ok, false);
});

// ── 동의 (§10.1) ─────────────────────────────────────────────────────────────

test('pii 선언 커넥터에 동의 컨텍스트가 없으면 호출하지 않는다', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await P.pumpConnectorHop({
    binding: { connectors: registry([piiDef()]), port, allowOverseas: false },
    connectorId: 'c_member', scope, interactionId: 'i1', slots, call: 1,
  });
  assert.equal(r.outcome.kind, 'blocked');
  assert.equal(r.outcome.reason, 'consent_context_missing');
  assert.equal(r.input.ok, false);              // blocked 는 성공이 아니다
  assert.equal(port.calls.length, 0);
});

test('동의 조립이 던지면 드러내고, pii 선언이면 호출하지 않는다', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await P.pumpConnectorHop({
    binding: {
      connectors: registry([piiDef()]), port, allowOverseas: false,
      consent: () => { throw new Error('동의 저장소 조회 실패'); },
    },
    connectorId: 'c_member', scope, interactionId: 'i1', slots, call: 1,
  });
  assert.match(r.consentError, /동의 저장소 조회 실패/);
  assert.equal(r.outcome.reason, 'consent_context_missing');
  assert.equal(port.calls.length, 0);
});

test('동의 조립이 던졌어도 pii 선언이 없으면 그대로 진행한다 — 필요 없던 동의로 조회를 막지 않는다', b, async () => {
  const port = recordingPort([{ ok: true, data: { balance: '5' } }]);
  const r = await hop({
    binding: {
      connectors: registry([def()]), port, allowOverseas: false,
      consent: () => { throw new Error('동의 저장소 조회 실패'); },
    },
  });
  assert.match(r.consentError, /동의 저장소 조회 실패/);
  assert.equal(r.outcome.kind, 'ok');
  assert.equal(port.calls.length, 1);
});

test('동의가 있으면 pii 커넥터도 호출된다', b, async () => {
  const port = recordingPort([{ ok: true, data: { balance: '5' } }]);
  const r = await P.pumpConnectorHop({
    binding: { connectors: registry([piiDef({ outputs: [{ field: 'balance', toSlot: 'balance' }] })]), port, allowOverseas: false, consent: () => consentCtx() },
    connectorId: 'c_member', scope, interactionId: 'i1', slots, call: 1,
  });
  assert.equal(r.outcome.kind, 'ok');
  assert.equal(port.calls.length, 1);
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('호출 실패는 errorCode 를 실어 Runner 로 내린다', b, async () => {
  const r = await hop({
    binding: { connectors: registry([def()]), port: recordingPort([{ ok: false, code: 'unavailable' }]), allowOverseas: false },
  });
  assert.equal(r.outcome.kind, 'failed');
  assert.equal(r.input.ok, false);
  assert.equal(r.input.errorCode, 'unavailable');
});

test('필수 슬롯이 비면 호출 전에 막고 슬롯 이름만 남긴다 — 빈 값으로 조회하지 않는다', b, async () => {
  const port = recordingPort([{ ok: true, data: {} }]);
  const r = await hop({ slots: {}, binding: { connectors: registry([def()]), port, allowOverseas: false } });
  assert.equal(r.outcome.kind, 'blocked');
  assert.equal(r.outcome.reason, 'missing_slots');
  assert.deepEqual(r.outcome.missingSlots, ['account_no']);
  assert.equal(port.calls.length, 0);
});

test('테넌트 격리 위반은 삼키지 않고 던진다(§11.1)', b, async () => {
  await assert.rejects(
    () => hop({ binding: { connectors: registry([def({ tenantId: 'other' })]), port: recordingPort([{ ok: true, data: {} }]), allowOverseas: false } }),
    /§11\.1|테넌트/,
  );
});

test('포트가 던져도 펌프는 던지지 않는다(§9.3)', b, async () => {
  const r = await hop({
    binding: {
      connectors: registry([def()]),
      port: { async call() { throw new Error('소켓 종료'); } },
      allowOverseas: false,
    },
  });
  assert.equal(r.outcome.kind, 'failed');
  assert.equal(r.input.ok, false);
});

// ── 구조적 상한·사전 점검 ────────────────────────────────────────────────────

test('홉 상한은 Api 노드 수 + 1 — 테넌트가 정하는 값이 아니다(§13-3)', b, () => {
  assert.equal(P.connectorHopLimit(apiFlow({ a: { id: 'a', kind: 'Say', text: '.' } })), 1);
  assert.equal(P.connectorHopLimit(apiFlow({
    a: { id: 'a', kind: 'Api', connectorId: 'c1' },
    b: { id: 'b', kind: 'Api', connectorId: 'c2' },
    c: { id: 'c', kind: 'Say', text: '.' },
  })), 3);
  assert.deepEqual(P.connectorHopLimit({ id: 'f', version: 1, startNodeId: 'x', nodes: {} }), 1);
});

test('순환 상한 입력은 성공이 아니라 실패다 — 무음으로 멈추지 않는다', b, () => {
  const i = P.hopLimitInput();
  assert.equal(i.kind, 'connectorResult');
  assert.equal(i.ok, false);
  assert.equal(i.errorCode, 'connector_hop_limit');
});

test('선언 없는 커넥터를 가리키는 Api 노드를 통화 시작 전에 찾아낸다', b, () => {
  const flow = apiFlow({
    a: { id: 'a', kind: 'Api', connectorId: 'c_balance' },
    bad: { id: 'bad', kind: 'Api', connectorId: 'c_typo' },
    blank: { id: 'blank', kind: 'Api', connectorId: '  ' },   // validateFlow 가 잡는다 — 여기서 중복 보고하지 않는다
    s: { id: 's', kind: 'Say', text: '.' },
  });
  assert.deepEqual(P.missingConnectors(flow, registry([def()])), [{ nodeId: 'bad', connectorId: 'c_typo' }]);
  assert.deepEqual(P.missingConnectors({ id: 'f', version: 1, startNodeId: 'x', nodes: {} }, registry([])), []);
});

test('조회가 던지는 레지스트리는 "없음"으로 본다 — 통화 중에 알게 되면 늦다', b, () => {
  const flow = apiFlow({ a: { id: 'a', kind: 'Api', connectorId: 'c_balance' } });
  assert.deepEqual(P.missingConnectors(flow, { get() { throw new Error('x'); } }), [{ nodeId: 'a', connectorId: 'c_balance' }]);
});

test('Api 노드 id 목록은 Api 만 센다', b, () => {
  assert.deepEqual(P.apiNodeIds(apiFlow({
    s: { id: 's', kind: 'Say', text: '.' },
    a: { id: 'a', kind: 'Api', connectorId: 'c1' },
  })), ['a']);
});

// ── 헬스 (§9.3) ──────────────────────────────────────────────────────────────

test('호출까지 간 시도만 헬스 샘플이 된다', b, async () => {
  const samples = [];
  await hop({
    binding: { connectors: registry([def()]), port: recordingPort([{ ok: false, code: 'unavailable' }]), allowOverseas: false },
    onHealth: (s) => samples.push(s), now: () => '2026-09-21T00:00:00Z',
  });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].component, 'backend');
  assert.equal(samples[0].state, 'down');
  assert.equal(samples[0].observedAt, '2026-09-21T00:00:00Z');
});

test('시계를 주지 않으면 헬스 샘플을 만들지 않는다(§13-3)', b, async () => {
  const samples = [];
  await hop({
    binding: { connectors: registry([def()]), port: recordingPort([{ ok: true, data: { balance: '1' } }]), allowOverseas: false },
    onHealth: (s) => samples.push(s),
  });
  assert.equal(samples.length, 0);
});
