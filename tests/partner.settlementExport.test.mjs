// 정산 리포트 내보내기.
//
// 이 테스트가 지키는 한 문장: **밖으로 나가는 정산 파일은, 근거가 확정됐고 권한이 있는 행만 담고,
// 나간 사실이 반드시 감사에 남는다.**
// 정산 CSV 는 회수되지 않는다 — 그래서 정상 경로보다 막는 경로를 더 촘촘히 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as m from '../src/partner/settlementExport.ts';
import { emptyChain, verifyChain } from '../src/audit/log.ts';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const scope = { tenantId: 't1' };
const ON = { activation: 'enabled', approvalRef: 'APPROVAL-2026-09-05' };

const chain = () => emptyChain(scope);
const partner = (over = {}) => ({ userId: 'u-p1', tenantId: 't1', roles: ['partner_admin'], partnerId: 'j2mr1', ...over });
const internal = (over = {}) => ({ userId: 'u-a1', tenantId: 't1', roles: ['admin'], ...over });

const line = (over = {}) => ({ partnerId: 'j2mr1', accountCount: 2, notesKo: [], ...over });
const req = (over = {}) => ({
  scope,
  actor: internal(),
  format: 'csv',
  lines: [line()],
  at: '2026-09-05T01:00:00.000Z',
  recordId: 'r1',
  ...over,
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────

test('내부 권한자는 CSV 를 받고, 반출 사실이 감사에 남는다', () => {
  const r = m.exportSettlement(chain(), req({ lines: [line({ billedAmount: 1000000, commissionRate: 0.1, commissionAmount: 100000 })] }), hash);
  assert.equal(r.status, 'ok');
  assert.equal(r.rowCount, 1);
  assert.match(r.content, /^partner_id,account_count,billed_amount,commission_rate,commission_amount,notes\n/);
  assert.match(r.content, /j2mr1,2,1000000,0\.1,100000,/);
  assert.equal(r.filename, 'settlement_t1_2026-09-05.csv');
  assert.equal(r.recorded, true, '반출은 감사 대상 화면이 아니어도 반드시 기록된다');
  assert.equal(r.record.action, 'export');
  assert.equal(r.record.result, 'success');
  assert.equal(verifyChain(r.chain, hash).ok, true);
});

test('JSONL 은 값이 없는 키를 아예 넣지 않는다 — null 은 0 으로 읽히기 시작한다', () => {
  const r = m.exportSettlement(chain(), req({ format: 'jsonl', lines: [line({ billedAmount: 500 })] }), hash);
  assert.equal(r.status, 'ok');
  const row = JSON.parse(r.content.trim());
  assert.equal(row.billed_amount, 500);
  assert.equal('commission_rate' in row, false);
  assert.equal('commission_amount' in row, false);
  assert.equal(r.filename.endsWith('.jsonl'), true);
});

test('금액·요율이 없으면 빈 칸이다 — 0 으로 채우지 않는다(§13-3)', () => {
  const r = m.exportSettlement(chain(), req({ lines: [line({ notesKo: ['실측 청구액이 없어 금액을 산출하지 않았습니다.'] })] }), hash);
  const body = r.content.split('\n')[1];
  assert.equal(body.startsWith('j2mr1,2,,,'), true, `빈 칸이어야 한다: ${body}`);
  assert.equal(body.includes(',0,'), false);
});

test('파트너 담당자는 자기 행만 받고, 제외 건수가 드러난다', () => {
  const lines = [line(), line({ partnerId: 'other', accountCount: 9 }), line({ partnerId: null })];
  const r = m.exportSettlement(chain(), req({ actor: partner(), lines }), hash, ON);
  assert.equal(r.status, 'ok');
  assert.equal(r.rowCount, 1);
  assert.equal(r.filteredOut, 2, '조용히 줄이지 않고 제외 건수를 돌려준다');
  assert.equal(r.content.includes('other'), false, '남의 파트너 행이 파일에 섞이면 유출이다');
  assert.match(r.record.detail_masked, /권한 필터 제외 2건/);
});

// ── 실패·차단 경로 ───────────────────────────────────────────────────────────

test('정산 근거가 막혀 있으면 본문을 만들지 않는다', () => {
  const r = m.exportSettlement(chain(), req({ blockers: ['유입 경로 미확정 3건이 있습니다.'] }), hash);
  assert.equal(r.status, 'blocked');
  assert.equal(r.content, undefined, '차단인데 파일이 만들어지면 그 파일이 청구서로 쓰인다');
  assert.equal(r.rowCount, 0);
  assert.match(r.messageKo, /유입 경로 미확정/);
  assert.equal(r.recorded, true, '차단된 시도도 남는다');
  assert.match(r.record.detail_masked, /반출 차단/);
});

test('파트너 담당자도 차단 상태에서는 받지 못한다', () => {
  const r = m.exportSettlement(chain(), req({ actor: partner(), blockers: ['귀속이 충돌하는 고객사 1건'] }), hash, ON);
  assert.equal(r.status, 'blocked');
  assert.equal(r.content, undefined);
  assert.equal(r.recorded, true);
  assert.equal(r.record.result, 'denied');
});

test('권한 없는 내부 역할은 거부되고 거부가 기록된다', () => {
  const r = m.exportSettlement(chain(), req({ actor: internal({ roles: ['agent'] }) }), hash);
  assert.equal(r.status, 'denied');
  assert.equal(r.content, undefined);
  assert.equal(r.record.result, 'denied');
  assert.match(r.record.detail_masked, /거부 사유: role/);
});

test('파트너 활성화 전에는 거부다 — 승인 없이 열리지 않는다', () => {
  const r = m.exportSettlement(chain(), req({ actor: partner() }), hash); // config 미주입 = 비활성
  assert.equal(r.status, 'denied');
  assert.match(r.record.detail_masked, /거부 사유: activation_pending/);
});

test('partnerId 미결속 계정은 전체 조회가 아니라 거부다', () => {
  const r = m.exportSettlement(chain(), req({ actor: partner({ partnerId: undefined }), lines: [line(), line({ partnerId: 'other' })] }), hash, ON);
  assert.equal(r.status, 'denied');
  assert.equal(r.content, undefined);
  assert.equal(r.rowCount, 0);
});

test('다른 테넌트 시도는 행위자 테넌트 체인에 남는다(§11.1)', () => {
  const actorChain = emptyChain({ tenantId: 't2' });
  const r = m.exportSettlement(actorChain, req({ actor: partner({ tenantId: 't2' }), scope: { tenantId: 't1' } }), hash, ON);
  assert.equal(r.status, 'denied');
  assert.equal(r.record.tenant_id, 't2');
  assert.match(r.messageKo, /찾을 수 없다/, '남의 테넌트에는 자원 존재 여부조차 알리지 않는다');
});

test('남의 테넌트 체인에 기록하려 하면 던진다', () => {
  assert.throws(
    () => m.exportSettlement(emptyChain(scope), req({ actor: partner({ tenantId: 't2' }), scope: { tenantId: 't1' } }), hash, ON),
    /§11\.1/,
  );
});

test('스코프 없는 반출 경로를 만들지 않는다', () => {
  assert.throws(() => m.exportSettlement(chain(), req({ scope: { tenantId: '' } }), hash));
});

// ── 경계조건 ─────────────────────────────────────────────────────────────────

test('빈 입력은 0건짜리 파일이 아니라 빈 상태 안내다', () => {
  const r = m.exportSettlement(chain(), req({ lines: [] }), hash);
  assert.equal(r.status, 'empty');
  assert.equal(r.content, undefined, '0건 CSV 는 받는 쪽에서 실적 0 으로 읽힌다');
  assert.match(r.messageKo, /확인/);
  assert.equal(r.recorded, true);
});

test('임계값이 없으면 대량 반출을 판정하지 않는다', () => {
  const many = Array.from({ length: 50 }, (_, i) => line({ partnerId: `p${i}` }));
  const r = m.exportSettlement(chain(), req({ lines: many }), hash);
  assert.equal(r.bulk, false);
  assert.equal(/대량 반출/.test(r.record.detail_masked ?? ''), false);
});

test('임계값 이상이면 대량 반출로 표시된다', () => {
  const many = Array.from({ length: 50 }, (_, i) => line({ partnerId: `p${i}` }));
  const r = m.exportSettlement(chain(), req({ lines: many }), hash, { bulkExportThreshold: 20 });
  assert.equal(r.bulk, true);
  assert.match(r.record.detail_masked, /대량 반출 50건\(기준 20건\)/);
});

test('입력 배열을 바꾸지 않는다', () => {
  const lines = [line(), line({ partnerId: 'other' })];
  const snapshot = JSON.stringify(lines);
  m.exportSettlement(chain(), req({ actor: partner(), lines }), hash, ON);
  assert.equal(JSON.stringify(lines), snapshot);
});

// ── 반출물 안전 ──────────────────────────────────────────────────────────────

test('수식으로 시작하는 값은 스프레드시트에서 실행되지 않게 무력화한다', () => {
  assert.equal(m.csvCell('=1+1'), "'=1+1");
  assert.equal(m.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(m.csvCell('-3'), "'-3");
  assert.equal(m.csvCell('정상'), '정상');
});

test('구분자·따옴표·개행이 든 값은 열을 밀어내지 않는다', () => {
  assert.equal(m.csvCell('a,b'), '"a,b"');
  assert.equal(m.csvCell('그는 "말했다"'), '"그는 ""말했다"""');
  assert.equal(m.csvCell('줄1\n줄2'), '"줄1\n줄2"');
  const r = m.exportSettlement(chain(), req({ lines: [line({ notesKo: ['담당,자', '=cmd'] })] }), hash);
  assert.equal(r.content.split('\n').length, 3, '헤더 + 1행 + 끝 개행');
});

test('사유 문구의 개인정보는 반출 전에 지워진다(§10.3)', () => {
  const r = m.exportSettlement(chain(), req({ lines: [line({ notesKo: ['담당자 연락처 010-1234-5678 확인 필요'] })] }), hash);
  assert.equal(r.content.includes('010-1234-5678'), false);
  const j = m.exportSettlement(chain(), req({ format: 'jsonl', lines: [line({ notesKo: ['010-1234-5678'] })] }), hash);
  assert.equal(j.content.includes('1234-5678'), false);
});

test('파일명에 경로 조작 문자가 남지 않는다', () => {
  const name = m.settlementFilename({ tenantId: '../../etc' }, '2026-09-05T00:00:00.000Z', 'csv');
  assert.equal(name.includes('/'), false);
  assert.equal(m.settlementFilename({ tenantId: 't1' }, '언젠가', 'jsonl'), 'settlement_t1_unknown-date.jsonl');
});
