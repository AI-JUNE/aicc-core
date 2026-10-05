// §7 2.2 상호작용 조회의 실행 경로 — 투영(§8.1 이벤트 → 조회 행)과 감사에 묶인 조회.
//
// 이 파일이 고정하는 것은 "동작한다"가 아니라 **조용히 틀리지 않는다**다:
// 폴백으로 끝난 통화가 조회에서 빠지는 것 · 중복 이벤트가 전문을 부풀리는 것 ·
// 상담사용 요약이 목록 검색 대상이 되는 것 · 열람이 감사에 남지 않는 것 ·
// 한 조회가 감사에 두 줄로 남는 것 · 워크스페이스 조회가 0건으로 보이는 것.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let m = null, ev = null, log = null, store = null;
try {
  m = await import('../src/portal/executeInteractions.ts');
  ev = await import('../src/events/schema.ts');
  log = await import('../src/audit/log.ts');
  store = await import('../src/events/store.ts');
} catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

/** 테스트용 결정적 해시. 상용은 SHA-256 을 주입한다. */
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

const scope = { tenantId: 't1' };
const T = (sec) => `2026-01-10T00:00:${String(sec).padStart(2, '0')}.000Z`;
const meta = (over = {}) => ({
  eventId: 'e', occurredAt: T(0), tenantId: 't1', interactionId: 'i1', channel: 'voice', ...over,
});

/** 정상 통화 하나: 시작 → 고객 턴 → 봇 턴 → 종료. */
const session = (over = {}) => {
  const id = over.interactionId ?? 'i1';
  const tenantId = over.tenantId ?? 't1';
  const ch = over.channel ?? 'voice';
  const p = (n, o = {}) => meta({ eventId: `${id}_${n}`, interactionId: id, tenantId, channel: ch, ...o });
  return [
    ev.sessionStarted(p('e1', { occurredAt: T(0) }), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(p('e2', { occurredAt: T(1) }), { turnId: 'tr1', speaker: 'customer', utterance: '잔액 알려주세요', intent: 'balance_inquiry' }),
    ev.turnCompleted(p('e3', { occurredAt: T(2) }), { turnId: 'tr2', speaker: 'bot', utterance: '잔액을 안내드리겠습니다', intent: 'balance_inquiry' }),
    ev.sessionEnded(p('e4', { occurredAt: T(30) }), { outcome: 'AUTO_RESOLVED', turnCount: 2, durationMs: 30_000 }),
  ];
};

// ── 투영: 정상 경로 ──────────────────────────────────────────────────────────

test('§8.1 이벤트 하나의 통화가 조회 행 한 건이 된다', b, () => {
  const r = m.projectInteractions(session(), { scope });
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.id, 'i1');
  assert.equal(row.tenantId, 't1');
  assert.equal(row.startedAt, T(0));
  assert.equal(row.endedAt, T(30));
  assert.equal(row.outcome, 'AUTO_RESOLVED');
  assert.equal(row.durationMs, 30_000);
  assert.deepEqual(row.channels, ['voice']);
  assert.deepEqual(row.intents, ['balance_inquiry'], '중복 인텐트는 한 번만');
  assert.equal(row.transcriptMasked, '[고객] 잔액 알려주세요\n[봇] 잔액을 안내드리겠습니다');
  assert.equal(r.counters.eventsCounted, 4);
  assert.equal(r.noteKo, undefined, '숨길 사실이 없으면 한 줄도 만들지 않는다');
});

test('빈 입력은 행 0건이며 사실을 만들어 내지 않는다', b, () => {
  const r = m.projectInteractions([], { scope });
  assert.deepEqual(r.rows, []);
  assert.equal(r.counters.eventsCounted, 0);
  assert.equal(r.noteKo, undefined);
});

test('투영 결과는 질의 모듈이 그대로 거를 수 있는 모양이다 — 조회가 실제로 돈다', b, async () => {
  const q = await import('../src/portal/interactionQuery.ts');
  const r = m.projectInteractions(session(), { scope });
  const query = {
    scope, period: { fromIso: '2026-01-01T00:00:00.000Z', toIso: '2026-02-01T00:00:00.000Z' },
    channels: ['voice'], keyword: '잔액', limit: 10,
  };
  assert.deepEqual(q.validateQuery(query, { maxPeriodDays: 92, maxLimit: 100 }), []);
  const page = q.runQuery(r.rows, query);
  assert.equal(page.rows.length, 1, '투영 행이 조회 규약을 통과하지 못하면 화면은 영원히 빈다');
});

// ── 투영: 조용한 사고들 ──────────────────────────────────────────────────────

test('종료 이벤트가 없는 세션도 행을 만든다 — 폴백으로 끝난 통화가 조회에서 빠지면 안 된다', b, () => {
  const r = m.projectInteractions(session().slice(0, 3), { scope });
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal('endedAt' in row, false, '없는 종료 시각을 만들지 않는다(§13-3)');
  assert.equal('outcome' in row, false);
  assert.equal('durationMs' in row, false);
  assert.equal(r.counters.sessionsWithoutEnd, 1);
  assert.match(r.noteKo, /종료 기록이 없는 세션 1건/);
});

test('§11.1 다른 테넌트 이벤트는 섞이지 않고 건수로 드러난다', b, () => {
  const r = m.projectInteractions([...session(), ...session({ interactionId: 'i9', tenantId: 't2' })], { scope });
  assert.deepEqual(r.rows.map((x) => x.id), ['i1']);
  assert.equal(r.counters.foreignTenantDropped, 4);
  assert.match(r.noteKo, /다른 테넌트 이벤트 4건 제외/);
});

test('§8.1 같은 event_id 재전송은 전문에 두 번 들어가지 않는다', b, () => {
  const s = session();
  const r = m.projectInteractions([...s, s[1]], { scope });
  assert.equal(r.counters.duplicatesDropped, 1);
  assert.equal(r.rows[0].transcriptMasked.split('\n').length, 2, '같은 발화가 두 줄이 됐다');
});

test('§2·§10.3 상담사용 이관 요약은 전문에 담지 않는다 — 사유만 적는다', b, () => {
  const h = ev.handoffRequested(meta({ eventId: 'e5', occurredAt: T(20) }), {
    reason: 'low_confidence', toQueue: 'q_general', summary: '고객이 대출 상환일 변경을 요청. 상담사 확인 필요',
  });
  assert.ok(h.summary_masked.length > 0, '이벤트에는 요약이 있다');
  const r = m.projectInteractions([...session(), h], { scope });
  assert.equal(r.rows[0].handoffReason, 'low_confidence');
  assert.equal(r.rows[0].transcriptMasked.includes('상담사 확인 필요'), false, '요약이 목록 키워드 검색 대상이 됐다');
});

test('이관 요청이 둘이면 마지막 사유를 적고 그 사실을 드러낸다', b, () => {
  const h = (n, reason, sec) => ev.handoffRequested(meta({ eventId: n, occurredAt: T(sec) }), { reason });
  const r = m.projectInteractions([...session(), h('e5', 'low_confidence', 10), h('e6', 'customer_request', 20)], { scope });
  assert.equal(r.rows[0].handoffReason, 'customer_request');
  assert.equal(r.counters.sessionsWithMultipleHandoffs, 1);
  assert.match(r.noteKo, /이관 요청이 둘 이상인 세션 1건/);
});

test('§5.2 채널 전환은 합집합으로 적힌다 — 전환된 세션이 필터에서 빠지지 않게', b, () => {
  const visualTurn = ev.turnCompleted(meta({ eventId: 'e7', occurredAt: T(5), channel: 'visual' }), {
    turnId: 'tr3', speaker: 'customer', utterance: '화면에서 선택했습니다',
  });
  const r = m.projectInteractions([...session(), visualTurn], { scope });
  assert.deepEqual(r.rows[0].channels, ['voice', 'visual']);
});

test('통화 길이를 이벤트 시각 차로 만들지 않는다 — 리포트와 숫자가 갈리면 안 된다', b, () => {
  const s = session();
  const noDur = [...s.slice(0, 3), ev.sessionEnded(meta({ eventId: 'i1_e4', occurredAt: T(30) }), { outcome: 'AUTO_RESOLVED', turnCount: 2 })];
  const r = m.projectInteractions(noDur, { scope });
  assert.equal('durationMs' in r.rows[0], false);
  assert.equal(r.counters.sessionsMissingDuration, 1);
  assert.equal(r.counters.durationValuesRejected, 0);
});

test('쓸 수 없는 통화 길이는 0 으로도 그대로도 적지 않는다 — "안 쟀다"와 구분된다', b, () => {
  const bad = ev.sessionEnded(meta({ eventId: 'i1_e4', occurredAt: T(30) }), { outcome: 'FAILED', turnCount: 1, durationMs: -5 });
  const r = m.projectInteractions([...session().slice(0, 3), bad], { scope });
  assert.equal('durationMs' in r.rows[0], false);
  assert.equal(r.counters.durationValuesRejected, 1);
  assert.equal(r.counters.sessionsMissingDuration, 1);
  assert.match(r.noteKo, /쓸 수 없는 통화 길이 1건 거부/);
});

test('§10.3 마스킹을 지나지 않은 발화는 다시 가리고 사고 신호로 드러낸다', b, () => {
  const s = session();
  // 과거 호스트가 원장에 넣은 값을 모사한다(이벤트 생성기를 우회한 형태).
  const leaked = { ...s[1], event_id: 'i1_e9', utterance_masked: '제 번호는 010-1234-5678 입니다' };
  const r = m.projectInteractions([...s, leaked], { scope });
  assert.equal(r.counters.turnsRemasked, 1);
  assert.equal(r.rows[0].transcriptMasked.includes('010-1234-5678'), false);
  assert.match(r.noteKo, /마스킹을 지나지 않은 발화 1턴 발견/);
});

test('정상 마스킹된 발화는 재마스킹으로 집계되지 않는다 — maskPii 멱등에 기댄다', b, () => {
  const t = ev.turnCompleted(meta({ eventId: 'i1_e9', occurredAt: T(3) }), {
    turnId: 'tr9', speaker: 'customer', utterance: '주민번호 900101-1234567 입니다',
  });
  const r = m.projectInteractions([...session(), t], { scope });
  assert.equal(r.counters.turnsRemasked, 0, '제대로 가린 통화가 전부 사고 신호로 잡히면 신호가 잡음이 된다');
  assert.ok(r.rows[0].transcriptMasked.includes('900101-*******'));
});

test('시작 이벤트가 없는 세션도 조회된다 — 관측된 첫 시각을 쓴다', b, () => {
  const r = m.projectInteractions(session().slice(1), { scope });
  assert.equal(r.rows[0].startedAt, T(1));
  assert.equal(r.counters.sessionsWithoutStart, 1);
  assert.match(r.noteKo, /시작 기록이 없는 세션 1건/);
});

test('§8.1 식별자 없는 이벤트는 담지 않고 센다', b, () => {
  const s = session();
  const r = m.projectInteractions([
    ...s,
    { ...s[1], event_id: '' },
    { ...s[1], event_id: 'x1', interaction_id: '' },
  ], { scope });
  assert.equal(r.counters.eventsRejected, 2);
  assert.equal(r.rows.length, 1);
  assert.match(r.noteKo, /식별자 없는 이벤트 2건 제외/);
});

// ── 투영: 선언과 상한 ───────────────────────────────────────────────────────

test('§13-3 수집 상한 기본값이 없다 — 주지 않으면 전수 투영한다', b, () => {
  const many = [...session(), ...session({ interactionId: 'i2' }), ...session({ interactionId: 'i3' })];
  const all = m.projectInteractions(many, { scope });
  assert.equal(all.counters.truncated, false);
  assert.equal(all.counters.eventsSkipped, 0);
  assert.equal(all.rows.length, 3);
});

test('수집 상한을 넘으면 잘렸다는 사실을 적는다 — 잘린 범위를 "없음"으로 적지 않는다', b, () => {
  const many = [...session(), ...session({ interactionId: 'i2' })];
  const r = m.projectInteractions(many, { scope, maxEvents: 5 });
  assert.equal(r.counters.truncated, true);
  assert.equal(r.counters.eventsCounted, 5);
  assert.equal(r.counters.eventsSkipped, 3);
  assert.match(r.noteKo, /수집 상한에 걸려 3건을 보지 않았다/);
});

test('화자를 선언하면 전문만 좁아지고 인텐트 집계는 그대로다', b, () => {
  const r = m.projectInteractions(session(), { scope, transcriptSpeakers: ['customer'] });
  assert.equal(r.rows[0].transcriptMasked, '[고객] 잔액 알려주세요');
  assert.deepEqual(r.rows[0].intents, ['balance_inquiry'], '봇 턴을 제외해도 인텐트는 빠지지 않는다');
});

test('빈 발화는 전문에 줄을 만들지 않는다', b, () => {
  const t = ev.turnCompleted(meta({ eventId: 'i1_e9', occurredAt: T(4) }), { turnId: 'tr9', speaker: 'customer', utterance: '' });
  const r = m.projectInteractions([...session(), t], { scope });
  assert.equal(r.rows[0].transcriptMasked.split('\n').length, 2);
});

test('설정 오류는 투영 시점에 거부한다 — 상한·화자 선언', b, () => {
  assert.throws(() => m.projectInteractions([], { scope, maxEvents: 0 }), /§13-3/);
  assert.throws(() => m.projectInteractions([], { scope, maxEvents: 1.5 }), /§13-3/);
  assert.throws(() => m.projectInteractions([], { scope, transcriptSpeakers: [] }), /빈 목록/);
  assert.throws(() => m.projectInteractions([], { scope, transcriptSpeakers: ['operator'] }), /알 수 없는 화자/);
});

test('§11.1 워크스페이스 스코프 투영은 거부한다 — 이벤트에 근거가 없다', b, () => {
  assert.throws(
    () => m.projectInteractions(session(), { scope: { tenantId: 't1', workspaceId: 'w1' } }),
    /워크스페이스/,
  );
});

test('§11.1 원장에서 투영할 때 테넌트는 원장이 정한다 — 호스트가 주장하지 못한다', b, () => {
  const l = store.createMemoryEventLog(scope);
  l.appendAll(session());
  const r = m.projectFromLog(l);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].tenantId, 't1');
  // 원장은 다른 테넌트 이벤트를 애초에 받지 않는다 — 투영 전에 막힌다.
  assert.throws(() => l.append(session({ interactionId: 'i9', tenantId: 't2' })[0]), /§11\.1/);
});

test('원장 읽기 조건은 그대로 전달된다(세션 단위 상세 조회)', b, () => {
  const l = store.createMemoryEventLog(scope);
  l.appendAll([...session(), ...session({ interactionId: 'i2' })]);
  const r = m.projectFromLog(l, {}, { interactionId: 'i2' });
  assert.deepEqual(r.rows.map((x) => x.id), ['i2']);
});

// ── 조회: 권한·기록 ─────────────────────────────────────────────────────────

const admin = { userId: 'u_admin', roles: ['admin'], tenantId: 't1', ip: '203.0.113.42' };
const analyst = { userId: 'u_analyst', roles: ['analyst'], tenantId: 't1' };
const limits = { maxPeriodDays: 92, maxLimit: 100 };
const period = { fromIso: '2026-01-01T00:00:00.000Z', toIso: '2026-02-01T00:00:00.000Z' };
const query = (over = {}) => ({ scope, period, limit: 10, ...over });
const chain0 = () => (m ? log.emptyChain(scope) : null);
const rowsOf = (events) => m.projectInteractions(events ?? session(), { scope }).rows;
const qreq = (over = {}) => ({
  actor: admin, query: query(), rows: rowsOf(), at: '2026-02-02T01:00:00.000Z', recordId: 'a1', ...over,
});

test('§10.2 권한 있는 조회는 행을 돌려주고 — 목록이 감사 대상 화면이 아니어도 — 기록된다', b, () => {
  const out = m.queryInteractions(chain0(), qreq(), hash, { limits });
  assert.equal(out.status, 'ok');
  assert.equal(out.resultCount, 1);
  assert.equal(out.recorded, true, '열람이 감사에 남지 않으면 조사 때 하필 이 화면이 비어 있다');
  assert.equal(out.record.action, 'view');
  assert.equal(out.record.result, 'success');
  assert.equal(out.chain.records.length, 1, '한 조회가 감사에 두 줄로 남으면 열람 건수가 실제보다 많아진다');
  assert.equal(log.verifyChain(out.chain, hash).ok, true);
});

test('감사 detail 에 기간·필터 요약·건수가 남고 검색어 원문은 남지 않는다(§10.3)', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ query: query({ keyword: '잔액', channels: ['voice'] }) }), hash, { limits });
  assert.equal(out.status, 'ok');
  assert.match(out.record.detail_masked, /기간 2026-01-01/);
  assert.match(out.record.detail_masked, /keyword=Y/);
  assert.match(out.record.detail_masked, /조회 1건/);
  assert.equal(out.record.detail_masked.includes('잔액'), false, '검색어가 감사로그에 보관됐다');
});

test('권한 없는 역할은 거부되고 행이 나가지 않으며 거부가 기록된다', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ actor: analyst }), hash, { limits });
  assert.equal(out.status, 'denied');
  assert.deepEqual(out.rows, []);
  assert.equal(out.recorded, true);
  assert.equal(out.record.result, 'denied');
  assert.equal(out.chain.records.length, 1);
});

test('§11.1 다른 테넌트 시도는 자원 존재를 알리지 않고 행위자 체인에 남는다', b, () => {
  const outsider = { userId: 'u_x', roles: ['admin'], tenantId: 't2' };
  const out = m.queryInteractions(log.emptyChain({ tenantId: 't2' }), qreq({ actor: outsider }), hash, { limits });
  assert.equal(out.status, 'denied');
  assert.match(out.messageKo, /찾을 수 없다/);
  assert.equal(out.record.tenant_id, 't2');
});

test('질의 형태 오류는 항목별 사유로 돌려주고 기록하지 않는다 — 열람이 없었다', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ query: query({ limit: 0 }) }), hash, { limits });
  assert.equal(out.status, 'invalid');
  assert.equal(out.recorded, false);
  assert.ok(out.issues.some((i) => i.code === 'limit'));
  assert.deepEqual(out.rows, []);
});

test('§11.1 스코프 없는 질의는 남길 체인이 없다는 사실까지 드러낸다', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ query: query({ scope: { tenantId: '' } }) }), hash, { limits });
  assert.equal(out.status, 'invalid');
  assert.equal(out.recorded, false);
  assert.ok(out.issues.some((i) => i.code === 'scope'));
});

test('§10.3 개인정보 패턴 검색어는 차단되지만 **시도는 기록된다**', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ query: query({ keyword: '900101-1234567' }) }), hash, { limits });
  assert.equal(out.status, 'invalid');
  assert.deepEqual(out.rows, []);
  assert.equal(out.recorded, true, '저장소에 없어야 하는 값으로 사람을 찾는 시도는 사고 신호다');
  assert.match(out.record.detail_masked, /개인정보 패턴 검색어 차단/);
  assert.equal(out.record.detail_masked.includes('900101'), false, '차단한 값을 감사로그가 보관했다');
  assert.ok(out.issues.some((i) => i.code === 'keyword_pii'));
});

test('권한 없는 행위자에게는 차단 사유를 알려 주지 않는다 — 기록만 남는다', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ actor: analyst, query: query({ keyword: '010-1234-5678' }) }), hash, { limits });
  assert.equal(out.status, 'denied');
  assert.equal(out.messageKo.includes('개인정보'), false);
  assert.equal(out.recorded, true);
  assert.equal(out.record.result, 'denied');
  assert.match(out.record.detail_masked, /개인정보 패턴 검색어 차단/);
});

test('§11.1 워크스페이스 단위 조회는 0건이 아니라 "지원하지 않는다"로 끝난다', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ query: query({ scope: { tenantId: 't1', workspaceId: 'w1' } }) }), hash, { limits });
  assert.equal(out.status, 'unsupported_scope');
  assert.match(out.messageKo, /워크스페이스/);
  assert.equal(out.recorded, false);
  assert.deepEqual(out.rows, []);
});

test('빈 결과는 빈 상태 안내이며 조회 사실은 기록된다', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ query: query({ outcomes: ['ABANDONED'] }) }), hash, { limits });
  assert.equal(out.status, 'empty');
  assert.match(out.messageKo, /없다/);
  assert.equal(out.recorded, true, '0건을 봤다는 사실도 열람이다');
  assert.equal(out.audit.resultCount, 0);
});

// ── 조회: 전문 노출과 대량 조회 ─────────────────────────────────────────────

test('§13-3 대량 조회 임계값이 없으면 판정하지 않는다', b, () => {
  const none = m.queryInteractions(chain0(), qreq(), hash, { limits });
  assert.equal(none.bulk, false);
  assert.equal(none.record.detail_masked.includes('대량'), false);
  const over = m.queryInteractions(chain0(), qreq(), hash, { limits, bulkViewThreshold: 1 });
  assert.equal(over.bulk, true);
  assert.match(over.record.detail_masked, /대량 반출 1건\(기준 1건\)/);
});

test('§10.3 전문을 그대로 실었다는 사실을 감추지 않는다 — 선언하면 자른다', b, () => {
  const full = m.queryInteractions(chain0(), qreq(), hash, { limits });
  assert.equal(full.transcriptFull, true);
  assert.equal(full.snippetApplied, false);

  const cut = m.queryInteractions(chain0(), qreq({ query: query({ keyword: '안내' }) }), hash, { limits, snippetChars: 8 });
  assert.equal(cut.snippetApplied, true);
  assert.equal(cut.transcriptFull, false);
  assert.ok(cut.rows[0].transcriptMasked.length <= 10, cut.rows[0].transcriptMasked);
  assert.ok(cut.rows[0].transcriptMasked.includes('안내'), '키워드가 보이지 않는 스니펫은 쓸모가 없다');
  assert.throws(() => m.queryInteractions(chain0(), qreq(), hash, { limits, snippetChars: 0 }), /§13-3/);
});

test('돌려받은 행을 고쳐도 원본 행이 바뀌지 않는다', b, () => {
  const rows = rowsOf();
  const out = m.queryInteractions(chain0(), qreq({ rows }), hash, { limits });
  out.rows[0].channels.push('chat');
  out.rows[0].transcriptMasked = '덮어씀';
  assert.deepEqual(rows[0].channels, ['voice']);
  assert.ok(rows[0].transcriptMasked.startsWith('[고객]'));
});

test('§11.1 섞여 들어온 남의 테넌트 행은 걸러지고 건수가 감사에 남는다', b, () => {
  const rows = [...rowsOf(), { ...rowsOf()[0], id: 'i9', tenantId: 't2' }];
  const out = m.queryInteractions(chain0(), qreq({ rows }), hash, { limits });
  assert.equal(out.scopeViolationsDropped, 1);
  assert.deepEqual(out.rows.map((r) => r.id), ['i1']);
  assert.match(out.record.detail_masked, /격리 위반 행 1건 제외/);
});

test('커서 페이징이 그대로 노출된다 — 목록이 중간에서 끊기지 않게', b, () => {
  const rows = [...rowsOf(), ...rowsOf(session({ interactionId: 'i2' }))];
  const out = m.queryInteractions(chain0(), qreq({ rows, query: query({ limit: 1 }) }), hash, { limits });
  assert.equal(out.resultCount, 1);
  assert.ok(typeof out.nextCursor === 'string');
});

test('상세 라우트로 조회하면 그 라우트로 기록된다', b, () => {
  const out = m.queryInteractions(chain0(), qreq({ routeId: 'interactions.detail' }), hash, { limits });
  assert.equal(out.status, 'ok');
  assert.equal(out.record.route_id, 'interactions.detail');
  assert.equal(out.chain.records.length, 1, '감사 대상 화면에서도 한 줄만 남는다');
});

// ── 판정을 복사하지 않는다(§2) ──────────────────────────────────────────────

test('§2 전문 판정·등급 분기를 이 파일이 다시 쓰지 않는다', b, async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/portal/executeInteractions.ts', import.meta.url), 'utf8');
  assert.equal(/resolveOutcome\s*\(/.test(src), false, 'Outcome 을 재판정하면 리포트와 값이 갈린다');
  assert.equal(/Date\.parse/.test(src), false, '시각 차로 통화 길이를 만들면 리포트와 숫자가 갈린다');
  assert.ok(/runQuery/.test(src) && /validateQuery/.test(src) && /recordAccess/.test(src), '판정은 기존 모듈에 맡긴다');
});
