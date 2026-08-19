import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let ev = null;
try { ev = await import('../src/events/schema.ts'); } catch { /* 구형 런타임 */ }
const behavioral = { skip: ev ? false : '타입 스트리핑 미지원 런타임' };

const meta = {
  eventId: 'i1_e1', occurredAt: '2026-01-01T00:00:00.000Z',
  tenantId: 't1', interactionId: 'i1', channel: 'voice',
};

test('§8.1 이벤트 4종이 정의되어 있다', () => {
  const s = read('src/events/schema.ts');
  for (const t of ['session.started', 'turn.completed', 'handoff.requested', 'session.ended']) {
    assert.match(s, new RegExp(`'${t.replace('.', '\\.')}'`));
  }
});

test('§8.1 모든 이벤트가 latency_ms·pii_masked·tenant_id를 갖는다', behavioral, () => {
  const list = [
    ev.sessionStarted(meta, { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta, { turnId: 't1', speaker: 'bot', utterance: '안녕하세요' }),
    ev.handoffRequested(meta, { reason: 'policy' }),
    ev.sessionEnded(meta, { outcome: 'TRANSFERRED', turnCount: 3 }),
  ];
  for (const e of list) {
    assert.ok(e.latency_ms, `${e.type} latency_ms 누락`);
    assert.equal(typeof e.pii_masked, 'boolean');
    assert.equal(e.tenant_id, 't1');
    assert.equal(e.schema_version, ev.EVENT_SCHEMA_VERSION);
  }
});

test('§10.3 turn.completed는 원문을 담지 않는다', behavioral, () => {
  const e = ev.turnCompleted(meta, { turnId: 't1', speaker: 'customer', utterance: '주민번호 900101-1234567 입니다' });
  assert.equal(e.pii_masked, true);
  assert.deepEqual(e.pii_kinds, ['rrn']);
  assert.equal(/900101-1234567/.test(e.utterance_masked), false);
  assert.equal(JSON.stringify(e).includes('900101-1234567'), false);
});

test('§10.3 handoff 요약도 마스킹된다', behavioral, () => {
  const e = ev.handoffRequested(meta, { reason: 'customer_request', summary: '연락처 010-1234-5678' });
  assert.equal(e.summary_present, true);
  assert.equal(/010-1234-5678/.test(e.summary_masked), false);
});

test('§11.1 tenant_id 없는 이벤트는 저장 경로에서 차단된다', behavioral, () => {
  const bad = ev.sessionStarted({ ...meta, tenantId: '' }, {});
  assert.throws(() => ev.assertTenantScoped(bad), /§11\.1/);
});

test('§13-3 이벤트 스키마에 목표치·기본 지연값을 내장하지 않는다', behavioral, () => {
  const e = ev.sessionStarted(meta, {});
  assert.deepEqual(e.latency_ms, {});
});
