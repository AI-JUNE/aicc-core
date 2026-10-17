// 고지 문안 등록부가 통화에 닿는다 — 설계서 §10.1(고지·동의)·§6.1(연동)·§11.1·§13-3.
//
// `legal/documents.ts` 는 한 가지를 막으려고 만들어졌다: **초안이 확정본 자리에 나가는 일**.
// 그런데 등록부를 통화에 넣을 자리가 커넥터 배선의 동의 컨텍스트 하나인데, 동의가 배선돼 있으면
// 그 자리는 Core 가 만들고 호스트 선언을 거부한다 — 즉 **넣을 길 자체가 없었다**. 그래서
// `decideLegalBasis` 는 언제나 `docs: undefined` 로 불렸고 "문안을 확인하지 않았다"만 적혔으며,
// 그 기록은 "확인했고 문제없었다"와 바깥에서 구분되지 않는다.
//
// 여기서 고정하는 것:
//  1) 등록부를 배선하면 통화 중 §6.1 조회가 **실제로 확정본을 본다**(초안이면 호출 전에 막힌다).
//  2) 배선하지 않으면 종전과 완전히 같고, 그 사실이 경고로 남는다(§13-3).
//  3) 기동 시점 검사와 통화 중 판정이 **같은 문서**를 본다 — 경고와 실제 동작이 어긋나지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let R = null, F = null, B = null, P = null, CN = null, CO = null, DOC = null;
try {
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  B = await import('../src/events/bus.ts');
  P = await import('../src/channels/profiles.ts');
  CN = await import('../src/consent/consent.ts');
  CO = await import('../src/consent/executeConsent.ts');
  DOC = await import('../src/legal/documents.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: R ? false : '타입 스트리핑 미지원 런타임' };

const NOW = '2026-10-17T09:00:00.000Z';
const SCOPE = { tenantId: 'goone' };
const LOCALE = 'ko-KR';
const SUBJ = 'cust_hash_1';
const hash = (s) => createHash('sha256').update(s).digest('hex');

const APPROVAL = { approvalRef: 'LEGAL-2026-09-01', approvedBy: '김법무', approvedAt: '2026-09-01T00:00:00.000Z' };

const draftDoc = (over = {}) => ({
  kind: 'privacy_policy', locale: LOCALE, version: 1, status: 'draft',
  content: '{{회사명}} 개인정보 처리방침 초안', ...over,
});

/** 실제 `finalizeDocument` 를 지나므로 해시·승인 근거가 진짜로 붙는다. */
const finalDoc = (over = {}) => DOC.finalizeDocument(
  { kind: 'privacy_policy', locale: LOCALE, version: 1, status: 'draft', content: '개인정보 처리방침 본문입니다.', ...over },
  { approval: APPROVAL, effectiveFrom: '2026-09-15T00:00:00.000Z' },
  hash,
);

const policy = (over = {}) => ({
  tenantId: 'goone', version: 1, updatedAt: '2026-09-20T00:00:00.000Z', updatedBy: 'admin', approved: true,
  requirements: [{ purpose: 'personal_data_collection', required: true, noticeRef: 'legal:privacy_policy' }],
  ...over,
});

const grantedStore = (p = policy()) => {
  const rows = [CN.grant(p, { subjectRef: SUBJ, purpose: 'personal_data_collection', via: 'voice', at: '2026-10-01T00:00:00.000Z' })];
  return { list: () => rows, append: (r) => { rows.push(r); return r; } };
};

/** 주민번호를 pii 파라미터로 선언한 커넥터 — §10.1 게이트가 실제로 걸리는 유일한 모양이다. */
const CDEF = (over = {}) => ({
  id: 'c_member', tenantId: 'goone', name: '회원조회', method: 'query',
  endpointRef: 'secret://core/member', residency: 'domestic', timeoutMs: 3000,
  params: [{ name: 'rrn', fromSlot: 'rrn', required: true, pii: true }],
  outputs: [{ field: 'grade', toSlot: 'grade' }],
  onFailure: 'branch', ...over,
});

const flowApi = () => ({
  id: 'api', version: 1, startNodeId: 'ask',
  nodes: {
    ask: { id: 'ask', kind: 'Collect', slot: 'rrn', prompt: '주민등록번호를 말씀해 주세요.', next: 'lookup' },
    lookup: { id: 'lookup', kind: 'Api', connectorId: 'c_member', waitText: '조회 중입니다.', next: 'tell', onError: 'sorry' },
    tell: { id: 'tell', kind: 'Say', text: '조회가 끝났습니다.' },
    sorry: { id: 'sorry', kind: 'Say', text: '지금은 조회가 어렵습니다.' },
  },
});

function fakePort(id = 'callbot') {
  const log = [];
  return {
    id, log,
    capabilities: P.profileFor(id),
    async present(iid, steps) { log.push(['present', iid, steps.map((s) => s.nodeId)]); },
    async transfer(iid, queue) { log.push(['transfer', iid, queue]); },
    async invite(iid, target) { log.push(['invite', iid, target]); },
    async end(iid, reason) { log.push(['end', iid, reason]); },
  };
}

function build({ consent, connectors, flows = [flowApi()] } = {}) {
  const port = fakePort();
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry(flows),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    bus: B.createEventBus({
      scope: SCOPE, sinks: [B.createCollectorSink('t')],
      store: B.createMemoryIdempotencyStore({ maxKeys: 500 }), releaseKeyOnSinkFailure: false,
    }),
    now: () => NOW,
    newInteractionId: () => 'i_test1',
    ...(consent !== undefined ? { consent } : {}),
    ...(connectors !== undefined ? { connectors } : {}),
  });
  return { core, port };
}

/** 커넥터 포트 — 호출이 실제로 나갔는지가 §10.1 게이트의 유일한 관측점이다. */
function wiring(over = {}) {
  const calls = [];
  const bases = [];
  return {
    calls, bases,
    binding: {
      connectors: { get: (id) => (id === 'c_member' ? CDEF() : undefined) },
      port: { async call(req) { calls.push(req); return { ok: true, data: { grade: 'VIP' } }; } },
      allowOverseas: false,
      onLegalBasis: (i) => bases.push(i),
      ...over,
    },
  };
}

const consentBinding = (over = {}) => ({
  policy: policy(),
  records: grantedStore(),
  subjectRef: () => SUBJ,
  ...over,
});

const legalBinding = (over = {}) => ({ docs: [finalDoc()], locale: LOCALE, ...over });

const req = () => ({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'api' });
const say = (core) => core.send('i_test1', { input: { kind: 'utterance', text: '고객입니다' } });

// ── 1) 미배선 — 종전과 완전히 같고, 그 사실이 남는다 ─────────────────────────

test('등록부를 배선하지 않으면 W_LEGAL_UNBOUND 가 남는다 — "확인하지 않음"과 "확인했고 문제없음"은 다르다', b, () => {
  const { core } = build({ consent: consentBinding(), connectors: wiring().binding });
  const w = core.warnings().filter((x) => x.code === 'W_LEGAL_UNBOUND');
  assert.equal(w.length, 1);
  assert.match(w[0].messageKo, /확정본 조회가 한 번도/);
});

test('동의 자체가 없으면 등록부 경고를 적지 않는다 — 같은 사실을 두 번 적지 않는다(§2)', b, async () => {
  const { core } = build({ connectors: wiring().binding });
  await core.start(req());
  assert.equal(core.warnings().some((x) => x.code === 'W_CONSENT_UNBOUND'), true,
    '동의 미배선은 이미 적힌다');
  assert.equal(core.warnings().some((x) => x.code === 'W_LEGAL_UNBOUND'), false,
    '동의가 없으면 등록부를 끼울 자리도 없다 — 두 번 적으면 진짜 신호가 묻힌다');
});

test('미배선이면 통화는 종전과 같다 — 조회는 나가고 판정에는 "확인하지 않았다"가 남는다(§13-3)', b, async () => {
  const w = wiring();
  const { core } = build({ consent: consentBinding(), connectors: w.binding });
  await core.start(req());
  const r = await say(core);
  assert.equal(w.calls.length, 1, '등록부가 없다는 이유로 조회를 막지 않는다');
  assert.equal(r.state.slots.grade, 'VIP');
  assert.equal(w.bases.length, 1);
  assert.equal(w.bases[0].decision.allowed, true);
  assert.equal(w.bases[0].decision.verified, false);
  assert.ok(w.bases[0].decision.unverifiableKo.some((x) => /등록부/.test(x)));
});

// ── 2) 배선 — 확정본이 통화에서 실제로 조회된다 ──────────────────────────────

test('확정본을 배선하면 근거가 확인되고 경고가 남지 않는다', b, async () => {
  const w = wiring();
  const { core } = build({ consent: consentBinding({ legal: legalBinding() }), connectors: w.binding });
  assert.deepEqual(core.warnings().filter((x) => x.code === 'W_LEGAL_UNBOUND'), []);
  assert.deepEqual(core.warnings().filter((x) => x.code === 'W_LEGAL_NOTICE'), []);
  await core.start(req());
  await say(core);
  assert.equal(w.calls.length, 1);
  const d = w.bases[0].decision;
  assert.equal(d.status, 'unverified', '수락 기록을 주지 않았으므로 통과로 적지 않는다');
  assert.equal(d.allowed, true);
  assert.equal(d.notices.checks[0].status, 'final', '등록부가 통화 경로에서 실제로 조회됐다');
  assert.ok(d.unverifiableKo.some((x) => /수락 기록/.test(x)));
});

test('수락 기록까지 주면 근거가 완전해진다(verified)', b, async () => {
  const doc = finalDoc();
  const acceptance = {
    tenantId: 'goone', subjectRef: SUBJ, kind: 'privacy_policy', version: doc.version,
    locale: LOCALE, contentHash: doc.contentHash, at: '2026-10-01T00:00:00.000Z', via: 'voice',
  };
  const w = wiring();
  const { core } = build({
    consent: consentBinding({ legal: legalBinding({ docs: [doc], acceptances: () => [acceptance] }) }),
    connectors: w.binding,
  });
  await core.start(req());
  await say(core);
  const d = w.bases[0].decision;
  assert.equal(d.status, 'ok');
  assert.equal(d.verified, true);
  assert.deepEqual(d.unverifiableKo, []);
  assert.deepEqual(d.acceptance, [{ kind: 'privacy_policy', status: d.acceptance[0].status }]);
  assert.equal(d.acceptance[0].status.state, 'current');
});

// ── 3) 막는 경로 — 초안·개정으로 받은 동의는 근거가 아니다 ───────────────────

test('초안 문안만 있으면 개인정보 조회가 호출 전에 막힌다 — 통화는 끊기지 않는다(§9.3)', b, async () => {
  const w = wiring();
  const { core } = build({
    consent: consentBinding({ legal: legalBinding({ docs: [draftDoc()] }) }),
    connectors: w.binding,
  });
  // 기동 시점에 이미 적힌다 — 첫 고객의 턴보다 먼저다.
  const warn = core.warnings().filter((x) => x.code === 'W_LEGAL_NOTICE');
  assert.equal(warn.length, 1);
  assert.match(warn[0].messageKo, /초안/);
  assert.match(warn[0].messageKo, /legal_notice_not_final/);

  await core.start(req());
  const r = await say(core);
  assert.equal(w.calls.length, 0, '초안 문안으로 받은 동의로 주민번호가 나가면 안 된다');
  // 통화는 onError 분기로 이어진다 — 무음으로 멈추지 않는다.
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['lookup', 'sorry']);
  assert.equal(r.status, 'completed', '끊지 않고 안내까지 하고 끝난다(§9.3)');
});

test('문안이 개정됐는데 옛 버전을 수락한 상태면 재수락 전까지 막는다(§10.1)', b, async () => {
  const v1 = finalDoc();
  const v2 = finalDoc({ version: 2, content: '개인정보 처리방침 본문입니다(2026 개정).' });
  const staleAcceptance = {
    tenantId: 'goone', subjectRef: SUBJ, kind: 'privacy_policy', version: v1.version,
    locale: LOCALE, contentHash: v1.contentHash, at: '2026-10-01T00:00:00.000Z', via: 'voice',
  };
  const w = wiring();
  const { core } = build({
    consent: consentBinding({ legal: legalBinding({ docs: [v1, v2], acceptances: () => [staleAcceptance] }) }),
    connectors: w.binding,
  });
  await core.start(req());
  await say(core);
  assert.equal(w.calls.length, 0);
  const d = w.bases[0].decision;
  assert.equal(d.status, 'reacceptance_required');
  assert.equal(d.allowed, false);
  assert.equal(d.gate.allow, true, '동의 자체는 있다 — 낡은 것은 문안 수락이다');
});

test('수락 기록 조회가 던져도 통화는 끊기지 않고 "기록 없음"으로 본다 — 미선언으로 적지 않는다', b, async () => {
  const w = wiring();
  const { core } = build({
    consent: consentBinding({ legal: legalBinding({ acceptances: () => { throw new Error('저장소 장애'); } }) }),
    connectors: w.binding,
  });
  await core.start(req());
  await say(core);
  assert.equal(w.calls.length, 1, '수락 기록이 없다는 사실만으로 기존 동의를 무효로 보지 않는다');
  const d = w.bases[0].decision;
  assert.equal(d.acceptance[0].status.state, 'none');
  assert.equal(d.unverifiableKo.some((x) => /선언하지 않아/.test(x)), false,
    '선언은 했고 조회가 실패한 것이다 — "선언하지 않았다"로 적으면 거짓이다');
});

// ── 4) 배선 형태 오류는 기동 시점에 거부한다 ─────────────────────────────────

test('등록부가 배열이 아니면 기동을 거부한다 — 오타 하나로 검사가 조용히 꺼지면 안 된다', b, () => {
  assert.throws(
    () => build({ consent: consentBinding({ legal: { docs: null, locale: LOCALE } }) }),
    /고지 문안 등록부/,
  );
});

test('언어를 주지 않으면 기동을 거부한다 — 기본 언어를 만들지 않는다(§13-3)', b, () => {
  assert.throws(
    () => build({ consent: consentBinding({ legal: { docs: [finalDoc()], locale: '  ' } }) }),
    /기본 언어를 만들지 않는다/,
  );
});

test('수락 기록 조회가 함수가 아니면 기동을 거부한다', b, () => {
  assert.throws(
    () => build({ consent: consentBinding({ legal: legalBinding({ acceptances: [] }) }) }),
    /수락 기록 조회/,
  );
});

test('다른 테넌트 정책은 등록부 검사보다 먼저 막힌다(§11.1)', b, () => {
  assert.throws(
    () => build({ consent: consentBinding({ policy: policy({ tenantId: 'other' }), legal: legalBinding() }) }),
    /동의 배선 거부/,
  );
});

// ── 5) 경고와 실제 동작이 어긋나지 않는다 ────────────────────────────────────

test('예약 형식이 아닌 참조는 "확인할 수 없다"로만 적고 막지 않는다(§13-3)', b, async () => {
  const w = wiring();
  const { core } = build({
    consent: consentBinding({
      policy: policy({ requirements: [{ purpose: 'personal_data_collection', required: true, noticeRef: 'tenant-notice-7' }] }),
      legal: legalBinding(),
    }),
    connectors: w.binding,
  });
  const warn = core.warnings().filter((x) => x.code === 'W_LEGAL_NOTICE');
  assert.equal(warn.length, 1);
  assert.match(warn[0].messageKo, /확인할 수 없습니다/);
  assert.doesNotMatch(warn[0].messageKo, /legal_notice_not_final/, '막지 않는 것을 막는다고 적지 않는다');
  await core.start(req());
  await say(core);
  assert.equal(w.calls.length, 1);
});

test('기동 시점 검사와 통화 중 판정이 같은 문서를 본다 — 배선 뒤 배열을 흔들어도 따라가지 않는다', b, async () => {
  const docs = [finalDoc()];
  const w = wiring();
  const { core } = build({ consent: consentBinding({ legal: legalBinding({ docs }) }), connectors: w.binding });
  assert.deepEqual(core.warnings().filter((x) => x.code === 'W_LEGAL_NOTICE'), []);
  // 호스트가 같은 배열을 나중에 비워도(등록부 재적재 등) 기동 시점에 통과한 판정이 뒤집히면
  // 경고와 동작이 어긋난다. 배선은 **그 시점의 내용**으로 고정된다.
  docs.length = 0;
  await core.start(req());
  await say(core);
  assert.equal(w.calls.length, 1);
  assert.equal(w.bases[0].decision.notices.checks[0].status, 'final');
});
