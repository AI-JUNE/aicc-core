// §8.1 실측 항목 목록의 단일 선언 — 같은 목록이 여섯 벌이었다.
//
// 이 파일이 지키는 것은 문법이 아니라 **어긋남이 생길 자리의 부재**다. 종전 상태는 이랬다:
//  - 지연 키(`latency_ms`): 브리지 검증(`LATENCY_KEYS`)·런타임 병합(`TURN_LATENCY_KEYS`)·
//    리포트 분기(`pushLatency` 의 네 갈래 if)에 각각 복사돼 있었고, 런타임 쪽 주석은
//    "목록을 여기 한 곳에 둔다"고 적어 두었다 — **사실이 아니었다**.
//  - 사용량 키(`usage`): 브리지 검증·엔진셋 수집(`USAGE_KEYS`)·턴 귀속(`USAGE_UNITS`) 세 벌.
//    하필 그 파일 머리말이 "검사가 한 곳이어야 한다(§2)"고 적어 두었다.
//  - 유입 경로(`EntryPoint`): 유니온 + 브리지의 `ENTRY_POINTS` 집합.
//  - 그리고 지연은 **도메인에 다른 키 이름으로 한 번 더** 선언돼 있었다
//    (`LatencyBreakdown.stt` vs `LatencyMs.stt_ms`). 도메인 타입대로 채운 실측은 어느 집계에도
//    도착하지 않고, 타입은 통과하며 예외도 없다.
//
// 어긋남의 증상은 전부 예외가 아니다 — 키가 하나 늘었을 때 브리지만 모르면 그 키가 실린 턴이
// **비-Node 호스트에서만** 거부되고, 런타임만 모르면 병합에서 빠지고, 리포트만 모르면 표본이
// 세어지지 않는다. 그래서 검사를 둘로 둔다: (1) 목록이 타입을 덮는지(컴파일 + 소스 대조),
// (2) 소비처가 자기 사본을 **다시 만들지 않았는지**.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let D = null, S = null, BR = null, R = null, F = null, P = null, BP = null, A = null, TU = null, ES = null, BL = null;
try {
  BL = await import('../src/billing/usage.ts');
  D = await import('../src/domain/types.ts');
  S = await import('../src/events/schema.ts');
  BR = await import('../src/channels/bridge.ts');
  R = await import('../src/channels/runtime.ts');
  F = await import('../src/ops/fallback.ts');
  P = await import('../src/channels/profiles.ts');
  BP = await import('../src/channels/basePort.ts');
  A = await import('../src/reports/aggregate.ts');
  TU = await import('../src/billing/turnUsage.ts');
  ES = await import('../src/adapters/engineSet.ts');
} catch { /* 타입 스트리핑 미지원 런타임 */ }
const b = { skip: D ? false : '타입 스트리핑 미지원 런타임' };

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** 소스에서 인터페이스의 선택 필드 이름을 뽑는다 — 타입은 실행 시점에 물어볼 수 없다. */
function optionalFieldsOf(source, ifaceName) {
  const start = source.indexOf(`export interface ${ifaceName} {`);
  assert.notEqual(start, -1, `${ifaceName} 선언을 찾지 못했다`);
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]);
}

/** 소스에서 인터페이스의 **필수** 필드 이름을 뽑는다(과금 수량 칸은 전부 필수다). */
function requiredFieldsOf(source, ifaceName) {
  const start = source.indexOf(`export interface ${ifaceName} {`);
  assert.notEqual(start, -1, `${ifaceName} 선언을 찾지 못했다`);
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s{2}(\w+): /gm)].map((m) => m[1]);
}

/** 소스에서 문자열 유니온 타입의 값을 뽑는다. */
function unionValuesOf(source, typeName) {
  const re = new RegExp(`export type ${typeName} =([^;]+);`);
  const m = re.exec(source);
  assert.ok(m, `${typeName} 선언을 찾지 못했다`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// ── 1) 목록이 타입을 정확히 덮는다 ───────────────────────────────────────────

test('LATENCY_KEYS 가 LatencyBreakdown 의 키와 정확히 일치한다(§8.1·§13)', b, () => {
  const declared = optionalFieldsOf(read('../src/domain/types.ts'), 'LatencyBreakdown');
  assert.deepEqual([...D.LATENCY_KEYS].sort(), declared.slice().sort());
  assert.equal(declared.length, 4);
});

test('USAGE_METRIC_KEYS 가 UsageMetrics 의 키와 정확히 일치한다(§11.2)', b, () => {
  const declared = optionalFieldsOf(read('../src/events/schema.ts'), 'UsageMetrics');
  assert.deepEqual([...S.USAGE_METRIC_KEYS].sort(), declared.slice().sort());
  assert.equal(declared.length, 5);
  // §5.2 임베딩 토큰 — 칸이 없던 동안 그 비용은 공급사 청구서에만 남았다(§11.2).
  assert.ok(S.USAGE_METRIC_KEYS.includes('embedding_tokens'));
});

test('ENTRY_POINTS 가 EntryPoint 유니온의 값과 정확히 일치한다', b, () => {
  const declared = unionValuesOf(read('../src/events/schema.ts'), 'EntryPoint');
  assert.deepEqual([...S.ENTRY_POINTS].sort(), declared.slice().sort());
  assert.equal(declared.length, 5);
});

test('§8.1 latency_ms 와 §4 Turn.latency 는 같은 선언을 가리킨다 — 키 이름이 갈라지지 않는다', b, () => {
  // 두 모듈 어디서 들여오든 같은 배열이어야 한다(§2). 다른 객체면 사본이 생긴 것이다.
  assert.equal(S.LATENCY_KEYS, D.LATENCY_KEYS);
  // 도메인 선언이 §8.1 이름을 쓰는지 — `stt` 로 되돌아가면 이 검사가 잡는다.
  assert.ok(D.LATENCY_KEYS.includes('stt_ms'));
  assert.ok(!D.LATENCY_KEYS.includes('stt'));
  assert.match(read('../src/events/schema.ts'), /export type LatencyMs = LatencyBreakdown;/);
});

test('turnUsage 의 USAGE_UNITS·엔진셋 수집 목록이 같은 선언이다(세 벌이 아니다)', b, () => {
  assert.equal(TU.USAGE_UNITS, S.USAGE_METRIC_KEYS);
  // 엔진셋은 목록을 내보내지 않으므로 소스로 확인한다.
  assert.match(read('../src/adapters/engineSet.ts'), /USAGE_KEYS: readonly \(keyof UsageMetrics\)\[\] = USAGE_METRIC_KEYS;/);
  assert.ok(ES.assembleEngineSet, '엔진셋 조립기가 없다');
});

test('§11.2 과금 단위 목록이 집계 수량에서 파생된다 — 유니온과 칸이 두 벌이 아니다', b, () => {
  // 두 벌이던 동안 어긋나는 날의 결말이 양쪽 다 조용하다: 수량만 늘면 외부 명세가 그 단위를
  // 선언할 수 없어 **대조 줄이 아예 생기지 않고**(한 번도 검증되지 않은 채 청구로 나간다),
  // 유니온만 늘면 core 가 undefined 라 diff 가 NaN 이 되어 그 버킷이 통째로 mismatch 가 된다.
  assert.match(read('../src/billing/usage.ts'), /export type BillableUnit = keyof UsageQuantities;/);
  // 임베딩 토큰이 양쪽에 실제로 닿는지 — 파생이 말뿐이 아닌지 값으로 확인한다.
  const q = BL.totalQuantities(BL.aggregateUsage([], {
    scope: { tenantId: 't1' }, granularity: 'total',
    rounding: { unitSeconds: 60, mode: 'ceil', minimumUnits: 0 },
  }));
  assert.deepEqual(
    Object.keys(q).sort(),
    ['embedding_tokens', 'llm_completion_tokens', 'llm_prompt_tokens', 'sessions', 'stt_seconds', 'tts_seconds', 'voice_seconds', 'voice_units'],
  );
});

test('BILLABLE_UNITS 가 UsageQuantities 의 칸과 정확히 일치한다(§11.2)', b, () => {
  // 합계·초기화·대사가 이 목록 하나에서 파생된다. 손으로 적은 사본이 하나라도 남아 있으면
  // 칸이 늘어나는 날 **합계만 조용히 0** 이 되고, 합계가 곧 청구서 한 줄이다.
  const declared = requiredFieldsOf(read('../src/billing/usage.ts'), 'UsageQuantities');
  assert.deepEqual([...BL.BILLABLE_UNITS].sort(), declared.slice().sort());
  assert.equal(declared.length, 8);
});

test('실측 항목 → 과금 수량 환산표가 UsageMetrics 를 빠짐없이 덮는다(§11.2·§6.2)', b, () => {
  // 종전에는 턴 집계가 항목마다 한 줄씩 손으로 적혀 있었다 — 늘어난 항목을 그 줄에 적지 않으면
  // 그 수량은 원장에만 있고 집계에는 한 번도 들어오지 않는다(예외도 경고도 없다).
  assert.match(read('../src/billing/usage.ts'), /METRIC_UNIT_ROUTE_TABLE: Record<keyof UsageMetrics,/);
  assert.deepEqual([...BL.METRIC_UNIT_ROUTES.keys()].sort(), [...S.USAGE_METRIC_KEYS].sort());
  for (const [metric, route] of BL.METRIC_UNIT_ROUTES) {
    assert.ok(BL.BILLABLE_UNITS.includes(route.to), `${metric} 가 없는 수량 칸(${route.to})으로 간다`);
    assert.ok(route.perUnit > 0, `${metric} 의 환산 제수가 0 이하다 — 수량이 Infinity 가 된다`);
  }
  // ms → 초 환산이 실제로 그 두 항목에만 걸려 있는지(토큰을 1000 으로 나누면 조용한 과소청구다).
  assert.equal(BL.METRIC_UNIT_ROUTES.get('stt_audio_ms').perUnit, 1000);
  assert.equal(BL.METRIC_UNIT_ROUTES.get('llm_prompt_tokens').perUnit, 1);
});

// ── 2) 실패 경로: 소비처가 사본을 다시 만들면 잡는다 ────────────────────────

test('소비처가 키 목록 전체를 다시 선언하지 않는다 — 사본이 생기면 실패한다', b, () => {
  const consumers = [
    '../src/channels/bridge.ts',
    '../src/channels/runtime.ts',
    '../src/adapters/engineSet.ts',
    '../src/billing/turnUsage.ts',
    '../src/reports/aggregate.ts',
    '../src/billing/usage.ts',
  ];
  // 주석(`//`·` * `)은 사본이 아니다 — 왜 한 곳인지 적어 둔 줄이므로 지운 뒤 본다.
  const stripComments = (s) => s.split('\n').filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join('\n');
  // **부분 목록은 사본이 아니다**(예: `COUNT_UNITS` — 개수로만 성립하는 항목). 잡아야 하는 것은
  // 목록 **전체**를 다시 적은 리터럴이다. 그것이 타입과 갈라질 수 있는 유일한 모양이다.
  const lists = [
    ['지연', [...D.LATENCY_KEYS]],
    ['사용량', [...S.USAGE_METRIC_KEYS]],
    ['유입 경로', [...S.ENTRY_POINTS]],
  ];
  for (const file of consumers) {
    const src = stripComments(read(file));
    for (const literal of src.matchAll(/\[[^[\]]*\]/g)) {
      const members = [...literal[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      for (const [labelKo, list] of lists) {
        assert.ok(
          !list.every((k) => members.includes(k)),
          `${file} 가 ${labelKo} 목록 전체를 다시 적었다 — 두 벌이면 키가 늘어나는 날 한쪽만 늘어난다(§2):\n${literal[0]}`,
        );
      }
    }
  }
});

test('리포트 지연 분기가 목록 전체를 센다 — 버킷 매핑이 keyof 로 묶여 있다', b, () => {
  const src = read('../src/reports/aggregate.ts');
  assert.match(src, /LATENCY_BUCKET: Record<keyof LatencyMs,/);
});

// ── 3) 경계에서 목록 전체가 실제로 통과한다 ─────────────────────────────────

const SCOPE = { tenantId: 'goone' };
const NOW = '2026-10-21T09:00:00.000Z';

const flow = {
  id: 'billing', version: 1, startNodeId: 'greet',
  nodes: {
    greet: { id: 'greet', kind: 'Say', text: '안녕하세요.', next: 'ask' },
    ask: { id: 'ask', kind: 'Collect', slot: 'customer_name', prompt: '성함을 말씀해 주세요.' },
  },
};

function build() {
  const port = BP.createChannelPort({ id: 'callbot' });
  const core = R.createConversationCore({
    scope: SCOPE,
    flows: R.createMemoryFlowRegistry([flow]),
    channels: [{ port, reportsComponents: P.CHANNEL_COMPONENTS.callbot, contractVersion: 1 }],
    policy: {
      tenantId: 'goone', staleAfterMs: 60000, treatUnknownAsDown: false,
      legacyIvrAvailable: false, agentQueueAvailable: true,
    },
    health: F.createHealthRegistry([]),
    now: () => NOW,
    newInteractionId: () => 'i_mk1',
  });
  return { core, bridge: BR.createBridge({ core, adapter: 'callbot', scope: SCOPE }) };
}

const line = (o) => JSON.stringify(o);
const fullLatency = () => Object.fromEntries(D.LATENCY_KEYS.map((k, i) => [k, (i + 1) * 10]));
const fullUsage = () => Object.fromEntries(S.USAGE_METRIC_KEYS.map((k, i) => [k, (i + 1) * 100]));

test('브리지가 목록의 모든 지연·사용량 키를 받아 원장에 싣는다(정상 경로)', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const r = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_mk1',
    turn: { input: { kind: 'utterance', text: '홍길동' }, latency: fullLatency(), usage: fullUsage() },
  }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const turn = r.result.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.ok(turn, '고객 턴 이벤트가 없다');
  assert.deepEqual(turn.latency_ms, fullLatency());
  assert.deepEqual(turn.usage, fullUsage());
});

test('브리지는 목록 밖의 키를 거부한다 — 정체불명 항목이 과금 집계에 쌓이지 않는다(실패 경로)', b, async () => {
  const { bridge } = build();
  await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'inbound_call' } }));
  const bad = await bridge.handleLine(line({
    id: '2', op: 'send', interactionId: 'i_mk1',
    turn: { input: { kind: 'utterance', text: '홍길동' }, latency: { stt: 10 } },
  }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_BAD_REQUEST');
});

test('브리지는 목록의 모든 유입 경로로 세션을 연다 — 하나라도 빠지면 그 경로만 거부된다', b, async () => {
  for (const ep of S.ENTRY_POINTS) {
    const { bridge } = build();
    const r = await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: ep } }));
    assert.equal(r.ok, true, `${ep} 가 거부됐다: ${JSON.stringify(r.error)}`);
  }
});

test('목록 밖 유입 경로는 거부한다(실패 경로)', b, async () => {
  const { bridge } = build();
  const r = await bridge.handleLine(line({ id: '1', op: 'start', req: { flowId: 'billing', entryPoint: 'fax_call' } }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_BAD_REQUEST');
});

// ── 4) 턴 이력에 실측이 도착한다 ────────────────────────────────────────────

test('세션 이력의 턴이 원장과 같은 지연 실측을 갖는다 — 종전에는 채우는 코드가 0줄이었다', b, async () => {
  const { core } = build();
  await core.start({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing' });
  const r = await core.send('i_mk1', { input: { kind: 'utterance', text: '홍길동' }, latency: fullLatency() });
  const ledger = r.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.deepEqual(ledger.latency_ms, fullLatency());
  const rec = core.sessions.get('i_mk1');
  const historyTurn = rec.turns.find((t) => t.id === ledger.turn_id);
  assert.ok(historyTurn, '턴 이력에 그 턴이 없다');
  assert.deepEqual(historyTurn.latency, fullLatency());
});

test('실측 선언이 없으면 턴 이력에 지연 필드를 만들지 않는다 — 0 으로 채우지 않는다(§13-3)', b, async () => {
  const { core } = build();
  const s = await core.start({ scope: SCOPE, adapter: 'callbot', entryPoint: 'inbound_call', flowId: 'billing' });
  assert.ok(s.events.some((e) => e.type === 'turn.completed'));
  const rec = core.sessions.get('i_mk1');
  assert.ok(rec.turns.length > 0, '턴 이력이 비었다');
  for (const t of rec.turns) {
    assert.equal(Object.prototype.hasOwnProperty.call(t, 'latency'), false, '선언이 없는데 지연 필드가 생겼다');
  }
});

// ── 5) 리포트가 목록 전체를 표본으로 센다 ───────────────────────────────────

const ev = (over = {}) => ({
  event_id: 'e1', schema_version: 1, type: 'turn.completed',
  occurred_at: NOW, tenant_id: 'goone', interaction_id: 'i_mk1', channel: 'voice',
  pii_masked: true, pii_kinds: [], latency_ms: {},
  turn_id: 't1', speaker: 'customer', utterance_masked: '홍길동',
  ...over,
});

test('목록의 모든 지연 키가 리포트 표본에 들어간다(정상 경로)', b, () => {
  const r = A.aggregateReport([ev({ latency_ms: fullLatency() })], { scope: SCOPE, granularity: 'total' });
  const l = A.latencyReport(r.buckets[0]);
  assert.equal(l.total.sampleCount, 1);
  assert.equal(l.stt.sampleCount, 1);
  assert.equal(l.llmTtft.sampleCount, 1);
  assert.equal(l.ttsTtfb.sampleCount, 1);
  assert.equal(r.buckets[0].latency.missing, 0);
});

test('지연 실측이 하나도 없는 턴은 missing 으로만 센다 — 0 표본을 만들지 않는다(경계)', b, () => {
  const r = A.aggregateReport([ev()], { scope: SCOPE, granularity: 'total' });
  assert.equal(r.buckets[0].latency.missing, 1);
  assert.equal(A.latencyReport(r.buckets[0]).total.sampleCount, 0);
});
