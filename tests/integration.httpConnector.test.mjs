// HTTP 커넥터 포트. 여기서 막는 사고는 대부분 "성공한 것처럼 보이는 실패"와
// "우리 코드를 다 지켜도 상대 로그로 새는 개인정보"다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let H = null;
try { H = await import('../src/integration/httpConnector.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: H ? false : '타입 스트리핑 미지원 런타임' };

const req = (over = {}) => ({
  connectorId: 'c_balance', tenantId: 't1', interactionId: 'i1',
  endpointRef: 'secret://core/balance', method: 'query',
  params: { acct: '110-1234' }, timeoutMs: 3000, attempt: 1, idempotencyKey: 'idem-1', ...over,
});

const endpoint = (over = {}) => ({ url: 'https://biz.example.co.kr/v1/balance', ...over });

const res = (over = {}) => ({
  ok: true, status: 200, async text() { return JSON.stringify({ balance: '10000' }); },
  headers: { get: () => 'application/json' }, ...over,
});

/** 요청을 기록하는 fetch 대역. 네트워크에 닿지 않는다. */
function fakeFetch(handler) {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, init }); return handler(url, init); };
  f.seen = seen;
  return f;
}

const livePort = (over = {}) => H.createHttpConnectorPort({
  name: 'biz', activation: 'live', approvalRef: 'TICKET-1',
  resolveEndpoint: () => endpoint(), piiParamsOf: () => [],
  fetchImpl: fakeFetch(async () => res()), ...over,
});

// ── 정적 계약 ────────────────────────────────────────────────────────────────

test('엔드포인트 원문을 Core 에 두지 않는다(§6.1 규약 1)', () => {
  const src = read('src/integration/httpConnector.ts');
  // 주석 예시를 포함해 실주소 문자열이 소스에 없어야 한다.
  assert.doesNotMatch(src, /https?:\/\/[a-z0-9.-]+\.(?:com|kr|net|io)/i);
  assert.match(src, /resolveEndpoint/);
});

test('오류 본문을 읽지도 싣지도 않는다(§10.3)', () => {
  const src = read('src/integration/httpConnector.ts');
  const bad = src.split('\n').filter((l) => /res\.text\(\)/.test(l));
  assert.equal(bad.length, 1, '응답 본문을 읽는 곳은 성공 경로 한 군데뿐이어야 한다');
});

// ── 활성화 게이트 ────────────────────────────────────────────────────────────

test('기본은 dry_run — 실호출 없이 거절하고 네트워크에 닿지 않는다 [승인 필요]', b, async () => {
  const f = fakeFetch(async () => res());
  const port = H.createHttpConnectorPort({
    name: 'biz', activation: 'dry_run', resolveEndpoint: () => endpoint(), piiParamsOf: () => [], fetchImpl: f,
  });
  const r = await port.call(req());
  assert.equal(r.ok, false);
  assert.match(r.detail, /승인 필요/);
  assert.equal(f.seen.length, 0);
});

test('live 는 승인 근거 없이 만들어지지 않는다 [승인 필요]', b, () => {
  assert.throws(() => H.createHttpConnectorPort({
    name: 'biz', activation: 'live', resolveEndpoint: () => endpoint(), fetchImpl: fakeFetch(async () => res()),
  }), /승인 필요/);
});

test('전송 구현이 어디에도 없으면 live 로 만들어지지 않는다', b, () => {
  // globalThis.fetch 를 대신 쓰는 경로(adapters/http.ts 와 같은 규약)까지 막힌 환경을 만들어 확인한다.
  const saved = globalThis.fetch;
  try {
    delete globalThis.fetch;
    assert.throws(() => H.createHttpConnectorPort({
      name: 'biz', activation: 'live', approvalRef: 'T-1', resolveEndpoint: () => endpoint(),
    }), /전송 구현/);
  } finally {
    if (saved !== undefined) globalThis.fetch = saved;
  }
});

// ── 개인정보가 URL 로 새지 않는다 ────────────────────────────────────────────

test('개인정보 파라미터는 쿼리스트링으로 보내지 않는다 — URL 은 상대 접근 로그에 그대로 남는다(§10.3)', b, async () => {
  const f = fakeFetch(async () => res());
  const port = livePort({ piiParamsOf: () => ['rrn'], fetchImpl: f });
  const r = await port.call(req({ params: { rrn: '900101-1234567' } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_request');
  assert.equal(f.seen.length, 0, '한 번이라도 나가면 되돌릴 방법이 없다');
});

test('pii 선언을 모르면 GET 자체를 거절한다 — "아마 개인정보가 아닐 것"을 가정하지 않는다(§13-3)', b, async () => {
  const f = fakeFetch(async () => res());
  const port = H.createHttpConnectorPort({
    name: 'biz', activation: 'live', approvalRef: 'T-1', resolveEndpoint: () => endpoint(), fetchImpl: f,
  });
  const r = await port.call(req());
  assert.equal(r.ok, false);
  assert.match(r.detail, /piiParamsOf/);
  assert.equal(f.seen.length, 0);
});

test('POST 엔드포인트면 개인정보도 본문으로 나간다(쿼리스트링이 아니다)', b, async () => {
  const f = fakeFetch(async () => res());
  const port = livePort({ resolveEndpoint: () => endpoint({ httpMethod: 'POST' }), piiParamsOf: () => ['rrn'], fetchImpl: f });
  const r = await port.call(req({ params: { rrn: '900101-1234567' } }));
  assert.equal(r.ok, true);
  assert.doesNotMatch(f.seen[0].url, /900101/);
  assert.match(f.seen[0].init.body, /900101/);
});

test('계획에는 파라미터 값이 실리지 않고 이름만 남는다', b, () => {
  const port = livePort();
  const plan = port.plan(req({ params: { acct: '110-1234' } }));
  assert.deepEqual(plan.paramNames, ['acct']);
  assert.doesNotMatch(JSON.stringify(plan), /110-1234/);
  assert.equal(plan.httpMethod, 'GET');
});

test('계획의 인증 자리는 참조 이름으로 대체된다 — 비밀값이 계획으로 새지 않는다', b, () => {
  const port = livePort({
    resolveEndpoint: () => endpoint({ apiKeyEnv: 'BIZ_TOKEN' }),
    resolveSecret: () => 'super-secret-value',
  });
  const plan = port.plan(req());
  assert.match(plan.headers.authorization, /승인 필요: env:BIZ_TOKEN/);
  assert.doesNotMatch(JSON.stringify(plan), /super-secret-value/);
});

// ── 전송 ─────────────────────────────────────────────────────────────────────

test('멱등 키를 헤더에 싣는다 — 안 실으면 재시도가 곧 중복 처리다', b, async () => {
  const f = fakeFetch(async () => res());
  const port = livePort({ fetchImpl: f });
  await port.call(req({ idempotencyKey: 'idem-xyz' }));
  assert.equal(f.seen[0].init.headers['idempotency-key'], 'idem-xyz');
});

test('query 는 GET·쿼리스트링, command 는 POST·JSON 본문', b, async () => {
  const f = fakeFetch(async () => res());
  const port = livePort({ fetchImpl: f });
  await port.call(req());
  assert.equal(f.seen[0].init.method, 'GET');
  assert.match(f.seen[0].url, /\?acct=110-1234$/);

  await port.call(req({ method: 'command', params: { amount: 100 } }));
  assert.equal(f.seen[1].init.method, 'POST');
  assert.equal(f.seen[1].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(f.seen[1].init.body), { amount: 100 });
});

test('인증키가 설정되지 않으면 값 대신 이름만 남기고 실패한다', b, async () => {
  const f = fakeFetch(async () => res());
  const port = livePort({ resolveEndpoint: () => endpoint({ apiKeyEnv: 'BIZ_TOKEN' }), resolveSecret: () => undefined, fetchImpl: f });
  const r = await port.call(req());
  assert.equal(r.code, 'unauthorized');
  assert.match(r.detail, /env:BIZ_TOKEN/);
  assert.equal(f.seen.length, 0);
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

test('HTTP 상태를 커넥터 오류 코드로 옮긴다', b, async () => {
  const cases = [[401, 'unauthorized'], [404, 'not_found'], [400, 'invalid_request'], [429, 'unavailable'], [503, 'unavailable'], [500, 'server_error']];
  for (const [status, code] of cases) {
    const port = livePort({ fetchImpl: fakeFetch(async () => res({ ok: false, status })) });
    const r = await port.call(req());
    assert.equal(r.code, code, `status ${status}`);
  }
});

test('오류 응답 본문은 어떤 경로로도 나가지 않는다 — 조회한 고객 정보가 되돌아온다(§10.3)', b, async () => {
  let read = false;
  const port = livePort({
    fetchImpl: fakeFetch(async () => res({
      ok: false, status: 500, async text() { read = true; return '홍길동 010-1234-5678 조회 실패'; },
    })),
  });
  const r = await port.call(req());
  assert.equal(read, false, '본문을 읽지도 않는다');
  assert.doesNotMatch(r.detail, /010-1234-5678/);
  assert.match(r.detail, /status 500/);
});

test('200 으로 싸인 오류·배열·비 JSON 을 성공으로 읽지 않는다', b, async () => {
  for (const body of ['not json', '[1,2,3]', '"문자열"', 'null']) {
    const port = livePort({ fetchImpl: fakeFetch(async () => res({ async text() { return body; } })) });
    const r = await port.call(req());
    assert.equal(r.ok, false, body);
    assert.equal(r.code, 'schema_mismatch');
  }
});

test('타임아웃은 timeout 으로 구분된다 — 재시도 판정의 근거다(§9.3)', b, async () => {
  const port = livePort({
    fetchImpl: fakeFetch(async (_u, init) => new Promise((_r, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    })),
  });
  const r = await port.call(req({ timeoutMs: 10 }));
  assert.equal(r.code, 'timeout');
  assert.match(r.detail, /10ms/);
});

test('전송 예외는 던지지 않고 unavailable 로 내려가며 마스킹을 지난다', b, async () => {
  const port = livePort({ fetchImpl: fakeFetch(async () => { throw new Error('연결 실패 010-9999-8888'); }) });
  const r = await port.call(req());
  assert.equal(r.code, 'unavailable');
  assert.doesNotMatch(r.detail, /010-9999-8888/);
});

test('엔드포인트를 못 풀거나 URL 형식이 틀리면 호출하지 않는다', b, async () => {
  const f = fakeFetch(async () => res());
  const a = await livePort({ resolveEndpoint: () => undefined, fetchImpl: f }).call(req());
  assert.equal(a.code, 'invalid_request');
  const c = await livePort({ resolveEndpoint: () => ({ url: 'ftp://x' }), fetchImpl: f }).call(req());
  assert.equal(c.code, 'invalid_request');
  assert.equal(f.seen.length, 0);
});

test('timeoutMs 가 유효하지 않으면 호출하지 않는다 — 무한 대기는 콜을 붙잡아 둔다(§9.3)', b, async () => {
  const f = fakeFetch(async () => res());
  const r = await livePort({ fetchImpl: f }).call(req({ timeoutMs: 0 }));
  assert.equal(r.code, 'invalid_request');
  assert.equal(f.seen.length, 0);
});

test('응답 상한을 주면 초과분을 성공으로 읽지 않고, 안 주면 검사하지 않는다(§13-3)', b, async () => {
  const big = JSON.stringify({ memo: 'x'.repeat(200) });
  const capped = livePort({ maxResponseBytes: 50, fetchImpl: fakeFetch(async () => res({ async text() { return big; } })) });
  assert.equal((await capped.call(req())).code, 'schema_mismatch');
  const free = livePort({ fetchImpl: fakeFetch(async () => res({ async text() { return big; } })) });
  assert.equal((await free.call(req())).ok, true);
});

test('시계를 주지 않으면 지연을 만들어 넣지 않는다(§13-3)', b, async () => {
  const noClock = await livePort().call(req());
  assert.equal(noClock.latencyMs, undefined);
  let t = 1000;
  const withClock = await livePort({ clock: () => (t += 25) }).call(req());
  assert.equal(typeof withClock.latencyMs, 'number');
});

test('빈 파라미터로도 터지지 않는다', b, async () => {
  const f = fakeFetch(async () => res());
  const r = await livePort({ fetchImpl: f }).call(req({ params: {} }));
  assert.equal(r.ok, true);
  assert.doesNotMatch(f.seen[0].url, /\?/);
});
