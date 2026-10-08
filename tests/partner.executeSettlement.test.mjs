// 파트너 정산 실행기 검사 — 설계서 §11.2·§11.1·§10.3·§13-3·§7 7.6.
//
// 여기서 고정하는 한 문장: **파트너에게 나가는 금액은, 청구할 수 있다고 판정된 수량 위에서만
// 만들어진다.** 정산 사고는 예외가 아니라 **그럴듯한 숫자**의 모양으로 오고, 지급된 수수료는
// 청구처럼 보류할 수 없다 — 되돌리려면 파트너에게서 받아와야 한다.
// 그래서 정상 경로보다 **금액을 만들지 않는 경로**를 더 촘촘히 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let m = null, bill = null, pl = null, ev = null, attr = null, audit = null;
try {
  m = await import('../src/partner/executeSettlement.ts');
  bill = await import('../src/billing/executeUsage.ts');
  pl = await import('../src/events/periodLedger.ts');
  ev = await import('../src/events/schema.ts');
  attr = await import('../src/partner/attribution.ts');
  audit = await import('../src/audit/log.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const hash = (s) => createHash('sha256').update(s).digest('hex');

const S = { tenantId: 'gowon' };                      // 정산 집계 주체(귀속 이력이 있는 스코프)
const OCT = { fromIso: '2026-10-01T00:00:00.000Z', toIso: '2026-11-01T00:00:00.000Z' };
const ROUNDING = { unitSeconds: 60, mode: 'ceil', minimumUnits: 1 };
const TOL = { absolute: 0, relative: 0 };
const ON = { activation: 'enabled', approvalRef: 'APPROVAL-2026-10-08' };

const meta = (eventId, interactionId, tenantId) =>
  ({ eventId, occurredAt: '2026-10-05T10:00:00.000Z', tenantId, interactionId, channel: 'voice' });

/** 한 통화(발화 1턴·종료) — 월 집계에서 voice 60초·1단위·세션 1건이 된다. */
function call(tenantId, id = 'i1') {
  return [
    ev.sessionStarted(meta(`${id}_s`, id, tenantId), { entryPoint: 'inbound_call' }),
    ev.turnCompleted(meta(`${id}_t`, id, tenantId), {
      turnId: 'turn1', speaker: 'customer', utterance: '제 번호는 010-1234-5678 입니다',
      usage: { llm_prompt_tokens: 10, llm_completion_tokens: 5 },
    }),
    ev.sessionEnded(meta(`${id}_e`, id, tenantId), {
      outcome: 'AUTO_RESOLVED', turnCount: 1, durationMs: 60000, billableMs: 60000,
    }),
  ];
}

const project = (tenantId, events) =>
  pl.projectLedgerPeriod(events ?? call(tenantId), { scope: { tenantId }, period: OCT });

/** 실제 실행기를 통과시킨 과금 집계 결과. 숫자만 뽑아 넘기지 않는다는 계약을 테스트도 지킨다. */
const usageOf = (tenantId, over = {}) =>
  bill.runUsageAggregation({ projection: project(tenantId), granularity: 'month', rounding: ROUNDING, ...over });

const stmt = (over = {}) =>
  ({ source: 'carrier_cdr', bucket: '2026-10', channel: 'voice', quantities: { voice_seconds: 60, voice_units: 1 }, ...over });

const reconOf = (tenantId, statements = [stmt()]) =>
  bill.runReconciliation({
    projection: project(tenantId), granularity: 'month', rounding: ROUNDING, tolerance: TOL, statements,
  });

const rec = (over = {}) => ({
  tenantId: 'gowon', accountId: 'acct-a', partnerId: 'j2mr1',
  acquisition: 'partner_referral', contractDate: '2026-01-02', ...over,
});

/** 근거가 전부 확정된 고객사 1곳. */
const okAccount = (over = {}) => ({
  accountId: 'acct-a', tenantId: 't-a',
  usage: usageOf('t-a'), reconciliation: reconOf('t-a'), billedAmount: 1_000_000, ...over,
});

const params = (over = {}) => ({ scope: S, history: [rec()], accounts: [okAccount()], ...over });

// ── 1) 정상 경로 — 종전에는 이 셋을 꿰는 코드가 0줄이었다 ────────────────────

test('귀속 + 과금 실행 결과 → 파트너별 실적·수수료가 산출된다 (§11.2)', b, () => {
  const r = m.runSettlement(params({ ratesByPartner: { j2mr1: 0.1 } }));
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.refusalsKo, []);
  assert.deepEqual(r.blockersKo, []);
  assert.deepEqual(r.billedByPartner, { j2mr1: 1_000_000 });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].partnerId, 'j2mr1');
  assert.equal(r.lines[0].accountCount, 1);
  assert.equal(r.lines[0].billedAmount, 1_000_000);
  assert.equal(r.lines[0].commissionRate, 0.1);
  assert.equal(r.lines[0].commissionAmount, 100_000);
  assert.equal(r.accounts[0].status, 'billable');
  assert.match(r.messageKo, /\[승인 필요\]/, '지급 지시로 읽히지 않게 못 박는다');
});

test('같은 입력이면 같은 표가 나온다 — 재현되지 않는 정산은 근거가 아니다', b, () => {
  const p = params({ ratesByPartner: { j2mr1: 0.1 } });
  assert.deepEqual(m.runSettlement(p), m.runSettlement(p));
});

test('입력 배열을 변형하지 않는다 — 호출자의 귀속 이력이 조용히 바뀌면 다음 집계가 달라진다', b, () => {
  const history = [rec(), rec({ accountId: 'acct-b', partnerId: null, acquisition: 'direct' })];
  const accounts = [okAccount()];
  const before = JSON.stringify({ history, accounts });
  m.runSettlement({ scope: S, history, accounts });
  assert.equal(JSON.stringify({ history, accounts }), before);
});

test('§13-3 귀속된 고객사가 없으면 "실적 0"이 아니라 "근거가 없다"다', b, () => {
  const r = m.runSettlement({ scope: S, history: [], accounts: [] });
  assert.equal(r.status, 'empty');
  assert.match(r.messageKo, /근거가 없다/);
  assert.deepEqual(r.billedByPartner, {});
  assert.deepEqual(r.lines, []);
});

test('검사하지 못하는 범위를 적는다 — 선언의 진위는 관측으로 알 수 없다(§13-3)', b, () => {
  const r = m.runSettlement(params());
  assert.equal(r.limitsKo.length > 0, true);
  assert.equal(r.limitsKo.some((s) => s.includes('단가')), true, '단가·청구서가 범위 밖임을 숨기지 않는다');
});

test('직접 계약분은 수수료 대상이 아니다 — 금액을 만들지 않고 이유를 적는다', b, () => {
  const history = [rec({ accountId: 'acct-d', partnerId: null, acquisition: 'direct' })];
  const accounts = [okAccount({ accountId: 'acct-d', tenantId: 't-d', usage: usageOf('t-d'), reconciliation: reconOf('t-d') })];
  const r = m.runSettlement({ scope: S, history, accounts });
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.billedByPartner, {}, '직접 계약 실적이 파트너 실적으로 접히면 안 된다');
  assert.equal(r.lines[0].partnerId, null);
  assert.equal(r.lines[0].billedAmount, undefined);
  assert.equal(r.lines[0].notesKo.some((s) => s.includes('직접 계약')), true);
});

// ── 2) (가) 대사가 막은 청구의 수수료를 지급하지 않는다 ──────────────────────

test('(가) 대사가 과다청구 방향으로 막은 달은 정산도 막힌다 — 종전에는 수수료만 그대로 나갔다', b, () => {
  // 외부 명세가 우리 집계보다 작다 = 과다청구 방향 → reconcile 이 blocked 를 적는다.
  const blockedRecon = reconOf('t-a', [stmt({ quantities: { voice_seconds: 30, voice_units: 1 } })]);
  assert.equal(blockedRecon.scenario.verdict, 'blocked', '전제: 대사가 청구를 막는다');

  const r = m.runSettlement(params({
    accounts: [okAccount({ reconciliation: blockedRecon })],
    ratesByPartner: { j2mr1: 0.1 },
  }));
  assert.equal(r.status, 'blocked');
  assert.equal(r.accounts[0].status, 'billing_blocked');
  assert.deepEqual(r.billedByPartner, {}, '막힌 청구의 금액은 접지 않는다');
  assert.equal(r.lines[0].commissionAmount, undefined, '수수료가 산출되면 그대로 지급 근거가 된다');
  assert.equal(r.blockersKo.some((s) => s.includes('청구가 막혀')), true);
});

test('(가) 금액을 선언하지 않았어도 청구가 막힌 고객사는 정산을 막는다', b, () => {
  const blockedRecon = reconOf('t-a', [stmt({ quantities: { voice_seconds: 30, voice_units: 1 } })]);
  const r = m.runSettlement(params({ accounts: [okAccount({ reconciliation: blockedRecon, billedAmount: undefined })] }));
  assert.equal(r.status, 'blocked', '그 달의 근거 자체가 확정되지 않았다');
});

test('과소청구 방향(확인 필요)은 막지 않고 드러낸다 — 과다지급이 아니다', b, () => {
  const under = reconOf('t-a', [stmt({ quantities: { voice_seconds: 120, voice_units: 1 } })]);
  assert.equal(under.scenario.verdict, 'review_required', '전제: 과소청구 방향');
  const r = m.runSettlement(params({ accounts: [okAccount({ reconciliation: under })], ratesByPartner: { j2mr1: 0.1 } }));
  assert.equal(r.status, 'ready');
  assert.equal(r.billedByPartner.j2mr1, 1_000_000);
  assert.equal(r.warningsKo.some((s) => s.includes('확인 필요')), true, '막지 않더라도 숨기지 않는다');
});

// ── 3) (나)(다) 판정 없음·거절을 "실적 없음"으로 적지 않는다 ────────────────

test('(나) 대사를 돌리지 않았는데 금액이 선언됐으면 막는다 — 미실시는 "차이 없음"이 아니다', b, () => {
  const r = m.runSettlement(params({ accounts: [okAccount({ reconciliation: undefined })] }));
  assert.equal(r.status, 'blocked');
  assert.equal(r.accounts[0].status, 'not_reconciled');
  assert.deepEqual(r.billedByPartner, {});
  assert.equal(r.blockersKo.some((s) => s.includes('대사 판정이 없습니다')), true);
});

test('(나) 대사 미실시 + 금액 선언 없음은 경고다 — 쓸 수 없는 금액이 애초에 없다', b, () => {
  const r = m.runSettlement(params({ accounts: [okAccount({ reconciliation: undefined, billedAmount: undefined })] }));
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.blockersKo, []);
  assert.deepEqual(r.billedByPartner, {});
  assert.equal(r.warningsKo.some((s) => s.includes('대사 판정이 없습니다')), true);
  assert.equal(r.lines[0].notesKo.some((s) => s.includes('실측 청구액이 없어')), true);
});

test('(나) 대사가 거절된 것도 판정 없음이다 — 거절 사유가 그대로 드러난다', b, () => {
  const refusedRecon = reconOf('t-a', []);   // 명세 없이 돌리면 거절된다
  assert.equal(refusedRecon.status, 'refused', '전제: 대사가 거절됐다');
  const r = m.runSettlement(params({ accounts: [okAccount({ reconciliation: refusedRecon })] }));
  assert.equal(r.accounts[0].status, 'not_reconciled');
  assert.equal(r.status, 'blocked');
  assert.equal(r.blockersKo.some((s) => s.includes('대조할 외부 명세가 없습니다')), true);
});

test('(다) 집계가 거절된 고객사의 금액은 쓰지 않는다 — 설정 오류가 실적으로 둔갑하지 않는다', b, () => {
  const refusedUsage = usageOf('t-a', { rounding: { unitSeconds: 0, mode: 'ceil', minimumUnits: 1 } });
  assert.equal(refusedUsage.status, 'refused', '전제: 반올림 규칙 결함으로 집계가 거절됐다');
  const r = m.runSettlement(params({ accounts: [okAccount({ usage: refusedUsage })] }));
  assert.equal(r.status, 'blocked');
  assert.equal(r.accounts[0].status, 'no_quantities');
  assert.deepEqual(r.billedByPartner, {});
  assert.equal(r.blockersKo.some((s) => s.includes('둔갑')), true);
});

test('(다) 투영에 근거가 없는 기간의 금액도 쓰지 않는다 — "사용량 0"과 구분한다', b, () => {
  const emptyUsage = bill.runUsageAggregation({
    projection: pl.projectLedgerPeriod([], { scope: { tenantId: 't-a' }, period: OCT }),
    granularity: 'month', rounding: ROUNDING,
  });
  assert.equal(emptyUsage.status, 'empty');
  const r = m.runSettlement(params({ accounts: [okAccount({ usage: emptyUsage })] }));
  assert.equal(r.accounts[0].status, 'no_quantities');
  assert.equal(r.status, 'blocked');
});

// ── 4) (라) 귀속(고객사)과 원장(테넌트)은 다른 축이다 ───────────────────────

test('(라) 같은 과금 테넌트를 두 고객사가 선언하면 거절한다 — 이중 계상은 과다지급이다', b, () => {
  const r = m.runSettlement({
    scope: S,
    history: [rec(), rec({ accountId: 'acct-b' })],
    accounts: [okAccount(), okAccount({ accountId: 'acct-b' })],
  });
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((s) => s.includes('이중 계상')), true);
  assert.equal(r.lines, undefined, '거절했으면 지급에 붙일 수 있는 표가 생기지 않는다');
  assert.equal(r.rows, undefined);
  assert.deepEqual(r.billedByPartner, {});
});

test('(라) 선언 테넌트와 집계 테넌트가 다르면 거절한다 (§11.1)', b, () => {
  const r = m.runSettlement(params({ accounts: [okAccount({ tenantId: 't-zzz' })] }));
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((s) => s.includes('과금 집계 테넌트')), true);
});

test('(라) 선언 테넌트와 대사 테넌트가 다르면 거절한다 (§11.1)', b, () => {
  const r = m.runSettlement(params({
    accounts: [okAccount({ usage: usageOf('t-zzz'), tenantId: 't-zzz', reconciliation: reconOf('t-a') })],
  }));
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((s) => s.includes('대사 테넌트')), true);
});

test('(라) 과금 테넌트를 선언하지 않으면 거절한다 — Core 가 추측하지 않는다', b, () => {
  const r = m.runSettlement(params({ accounts: [okAccount({ tenantId: undefined })] }));
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((s) => s.includes('과금 테넌트 선언')), true);
});

test('같은 고객사를 두 번 선언하면 고르지 않고 거절한다 — 입력 순서가 금액을 정하면 안 된다', b, () => {
  const r = m.runSettlement(params({ accounts: [okAccount(), okAccount({ billedAmount: 9 })] }));
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((s) => s.includes('2번 선언')), true);
});

// ── 5) (마) 부분 합계를 실적으로 적지 않는다 ────────────────────────────────

test('(마) 파트너 고객사 중 하나라도 근거가 미확정이면 그 파트너의 금액을 만들지 않는다', b, () => {
  const history = [rec(), rec({ accountId: 'acct-b' })];
  const accounts = [
    okAccount(),
    okAccount({ accountId: 'acct-b', tenantId: 't-b', usage: usageOf('t-b'), reconciliation: undefined, billedAmount: undefined }),
  ];
  const r = m.runSettlement({ scope: S, history, accounts, ratesByPartner: { j2mr1: 0.1 } });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].accountCount, 2);
  assert.equal(r.billedByPartner.j2mr1, undefined, '확정된 1곳만 더하면 그 부분 합계가 실적으로 읽힌다');
  assert.equal(r.lines[0].billedAmount, undefined);
  assert.equal(r.lines[0].commissionAmount, undefined);
  assert.equal(r.warningsKo.some((s) => s.includes('실적을 만들지 않았습니다')), true);
});

test('(마) 귀속은 있는데 실적 선언이 없는 고객사가 있으면 그 파트너 금액을 만들지 않고 드러낸다', b, () => {
  const r = m.runSettlement({
    scope: S,
    history: [rec(), rec({ accountId: 'acct-b' })],
    accounts: [okAccount()],
    ratesByPartner: { j2mr1: 0.1 },
  });
  assert.equal(r.billedByPartner.j2mr1, undefined);
  assert.equal(r.warningsKo.some((s) => s.includes('실적 선언이 없는 고객사 1건')), true);
  assert.equal(r.warningsKo.some((s) => s.includes('acct-b(선언 없음)')), true);
});

test('(마) 파트너의 고객사 전부가 확정되면 합계가 접힌다', b, () => {
  const history = [rec(), rec({ accountId: 'acct-b' })];
  const accounts = [
    okAccount(),
    okAccount({ accountId: 'acct-b', tenantId: 't-b', usage: usageOf('t-b'), reconciliation: reconOf('t-b'), billedAmount: 500 }),
  ];
  const r = m.runSettlement({ scope: S, history, accounts, ratesByPartner: { j2mr1: 0.2 } });
  assert.equal(r.status, 'ready');
  assert.equal(r.billedByPartner.j2mr1, 1_000_500);
  assert.equal(r.lines[0].commissionAmount, 200_100);
});

// ── 6) (바) 귀속 없는 실적이 조용히 사라지지 않는다 ─────────────────────────

test('(바) 귀속 기록이 없는 고객사의 실적은 합계만 줄이지 않고 정산을 막는다', b, () => {
  const r = m.runSettlement(params({ accounts: [okAccount({ accountId: 'acct-x', tenantId: 't-x', usage: usageOf('t-x'), reconciliation: reconOf('t-x') })] }));
  assert.equal(r.status, 'blocked');
  assert.equal(r.accounts[0].status, 'unattributed');
  assert.equal(r.accounts[0].partnerId, undefined, '귀속이 없으면 파트너를 만들어 넣지 않는다');
  assert.deepEqual(r.billedByPartner, {});
  assert.equal(r.blockersKo.some((s) => s.includes('귀속 기록이 없습니다')), true);
});

// ── 7) (사) 충돌을 테넌트 밖에서 세지 않는다 ────────────────────────────────

test('(사) 남의 테넌트 귀속 충돌이 이 테넌트 정산을 막지 않는다 (§11.1)', b, () => {
  const foreign = [
    rec({ tenantId: 'other', accountId: 'acct-z', partnerId: 'p1' }),
    rec({ tenantId: 'other', accountId: 'acct-z', partnerId: 'p2' }),
  ];
  const history = [rec(), ...foreign];
  assert.equal(attr.findAttributionConflicts(history).length, 1, '전제: 스코프를 거르지 않으면 충돌로 잡힌다');

  const r = m.runSettlement({ scope: S, history, accounts: [okAccount()], ratesByPartner: { j2mr1: 0.1 } });
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.status, 'ready');
  assert.equal(r.rows.length, 1, '남의 테넌트 고객사가 행으로 올라오면 유출이다');
});

test('같은 테넌트의 귀속 충돌은 막는다 — 자동으로 한쪽을 고르지 않는다', b, () => {
  const history = [rec(), rec({ partnerId: 'rival', contractDate: '2026-02-02' })];
  const r = m.runSettlement({ scope: S, history, accounts: [okAccount()] });
  assert.equal(r.status, 'blocked');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.blockersKo.some((s) => s.includes('귀속이 충돌')), true);
});

test('유입 경로 미확정은 막는다 — 판정은 settlementBlockers 하나가 만든다(§2)', b, () => {
  const history = [rec({ partnerId: null, acquisition: 'unknown' })];
  const r = m.runSettlement({ scope: S, history, accounts: [] });
  assert.equal(r.status, 'blocked');
  assert.equal(r.blockersKo.some((s) => s.includes('유입 경로 미확정')), true);
});

// ── 8) (아) 요율·금액 형태 — 숫자로 나가는 오류를 먼저 막는다 ───────────────

test('(아) 퍼센트 값을 요율로 넣으면 거절한다 — 예외가 아니라 숫자로 CSV 에 실린다', b, () => {
  const r = m.runSettlement(params({ ratesByPartner: { j2mr1: 15 } }));
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((s) => s.includes('0~1')), true);
  assert.equal(r.lines, undefined);
});

test('(아) 음수·NaN 요율도 거절한다', b, () => {
  for (const rate of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.1']) {
    const r = m.runSettlement(params({ ratesByPartner: { j2mr1: rate } }));
    assert.equal(r.status, 'refused', `요율 ${String(rate)} 은 거절돼야 한다`);
  }
});

test('금액이 음수·NaN·숫자 아님이면 거절한다 — 합계를 조용히 무너뜨린다', b, () => {
  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
    const r = m.runSettlement(params({ accounts: [okAccount({ billedAmount: amount })] }));
    assert.equal(r.status, 'refused', `금액 ${String(amount)} 은 거절돼야 한다`);
    assert.deepEqual(r.billedByPartner, {});
  }
});

test('금액 0 은 유효한 실측이다 — "모른다"와 가르는 것이 이 모듈의 요점이다', b, () => {
  const r = m.runSettlement(params({ accounts: [okAccount({ billedAmount: 0 })], ratesByPartner: { j2mr1: 0.1 } }));
  assert.equal(r.status, 'ready');
  assert.equal(r.billedByPartner.j2mr1, 0);
  assert.equal(r.lines[0].billedAmount, 0);
  assert.equal(r.lines[0].commissionAmount, 0);
});

test('§10.3 거절문에 실린 값은 마스킹을 거친다', b, () => {
  const r = m.runSettlement(params({ accounts: [okAccount({ billedAmount: '010-1234-5678 원' })] }));
  assert.equal(r.status, 'refused');
  const joined = r.refusalsKo.join('\n');
  assert.equal(joined.includes('010-1234-5678'), false, `원문이 그대로 남았다: ${joined}`);
});

test('집계 결과를 선언하지 않으면 거절한다 — 숫자만 뽑아 넘기는 경로를 막는다', b, () => {
  const r = m.runSettlement(params({ accounts: [{ accountId: 'acct-a', tenantId: 't-a', billedAmount: 10 }] }));
  assert.equal(r.status, 'refused');
  assert.equal(r.refusalsKo.some((s) => s.includes('그대로 넘기세요')), true);
});

test('§11.1 스코프가 없거나 형식을 어기면 호출 자체가 막힌다', b, () => {
  assert.throws(() => m.runSettlement({ scope: {}, history: [], accounts: [] }));
  assert.throws(() => m.runSettlement({ scope: { tenantId: 'BAD TENANT' }, history: [], accounts: [] }));
});

// ── 9) (자) 반출에 판정이 반드시 꿰인다 ─────────────────────────────────────

const chain = () => audit.emptyChain(S);
const internal = (over = {}) => ({ userId: 'u-a1', tenantId: 'gowon', roles: ['admin'], ...over });
const partnerActor = (over = {}) => ({ userId: 'u-p1', tenantId: 'gowon', roles: ['partner_admin'], partnerId: 'j2mr1', ...over });

const exportReq = (run, over = {}) => ({
  run, scope: S, actor: internal(), format: 'csv',
  at: '2026-10-08T02:00:00.000Z', recordId: 'r1', periodKo: '2026-10', ...over,
});

test('(자) 반출 가능한 정산은 CSV 본문과 감사 기록을 함께 남긴다', b, () => {
  const run = m.runSettlement(params({ ratesByPartner: { j2mr1: 0.1 } }));
  const r = m.runSettlementExport(chain(), exportReq(run), hash);
  assert.equal(r.status, 'ok');
  assert.equal(r.rowCount, 1);
  assert.match(r.content, /j2mr1,1,1000000,0\.1,100000/);
  assert.equal(r.recorded, true);
  assert.equal(audit.verifyChain(r.chain, hash).ok, true);
});

test('(자) 차단된 정산은 본문을 만들지 않는다 — blockers 를 호출자가 뺄 수 없다', b, () => {
  const blockedRecon = reconOf('t-a', [stmt({ quantities: { voice_seconds: 30, voice_units: 1 } })]);
  const run = m.runSettlement(params({ accounts: [okAccount({ reconciliation: blockedRecon })] }));
  assert.equal(run.status, 'blocked');

  const r = m.runSettlementExport(chain(), exportReq(run), hash);
  assert.equal(r.status, 'blocked');
  assert.equal(r.content, undefined, '막힌 정산의 CSV 는 회수되지 않는다');
  assert.equal(r.rowCount, 0);
  assert.equal(r.recorded, true, '차단도 반드시 기록된다');
  assert.equal(r.blockers.length > 0, true);
});

test('(자) 거절된 실행 결과로 반출을 시도한 사실도 기록된다 — 조용히 빈 결과를 돌려주지 않는다', b, () => {
  const run = m.runSettlement(params({ ratesByPartner: { j2mr1: 15 } }));
  assert.equal(run.status, 'refused');
  const r = m.runSettlementExport(chain(), exportReq(run), hash);
  assert.equal(r.status, 'blocked');
  assert.equal(r.content, undefined);
  assert.equal(r.recorded, true);
  assert.equal(r.blockers.some((s) => s.includes('0~1')), true, '거절 사유가 반출 판정까지 전달된다');
});

test('(자) 파트너 담당자는 자기 행만 받는다 — 판정과 별개로 한 번 더 걸린다(§11.1)', b, () => {
  const history = [rec(), rec({ accountId: 'acct-b', partnerId: 'rival2', acquisition: 'partner_managed' })];
  const accounts = [
    okAccount(),
    okAccount({ accountId: 'acct-b', tenantId: 't-b', usage: usageOf('t-b'), reconciliation: reconOf('t-b'), billedAmount: 777 }),
  ];
  const run = m.runSettlement({ scope: S, history, accounts, ratesByPartner: { j2mr1: 0.1, rival2: 0.3 } });
  assert.equal(run.status, 'ready');
  assert.equal(run.lines.length, 2);

  const r = m.runSettlementExport(chain(), exportReq(run, { actor: partnerActor() }), hash, ON);
  assert.equal(r.status, 'ok');
  assert.equal(r.rowCount, 1);
  assert.equal(r.filteredOut, 1);
  assert.equal(r.content.includes('rival2'), false, '남의 파트너 행이 섞이면 유출이다');
  assert.equal(r.content.includes('777'), false);
});

test('(자) 활성화 승인 근거가 없으면 파트너 담당자의 반출은 거부된다 — 기본 OFF [승인 필요]', b, () => {
  const run = m.runSettlement(params({ ratesByPartner: { j2mr1: 0.1 } }));
  const r = m.runSettlementExport(chain(), exportReq(run, { actor: partnerActor() }), hash);
  assert.equal(r.status, 'denied');
  assert.equal(r.content, undefined);
  assert.equal(r.recorded, true);
});

test('계약 버전이 노출된다', b, () => {
  assert.equal(typeof m.SETTLEMENT_RUN_CONTRACT_VERSION, 'number');
});
