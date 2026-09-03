// 채널 적합성 실행 하네스 테스트 — 정상 경로 + 실패 경로.
// 실회선·실메신저·네트워크를 쓰지 않는다. 모듈 로더는 주입한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHarnessArgs, resolvePortFromModule, runHarness, formatHarnessResult,
  harnessResultToJson, HARNESS_EXIT_CODE, HARNESS_USAGE_KO,
} from '../src/channels/harness.ts';
import { createDryRunPort } from '../src/channels/conformance.ts';
import { createChannelPort } from '../src/channels/basePort.ts';

const loaderFor = (mod) => async () => mod;

// ── 인자 해석 ────────────────────────────────────────────────────────────────

test('인자 해석: 전체 옵션을 읽는다', () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs', '--export', 'myPort', '--adapter', 'chatbot', '--timeout-ms', '250', '--json', '--strict-warnings']);
  assert.equal(cfg.portModule, './p.mjs');
  assert.equal(cfg.exportName, 'myPort');
  assert.equal(cfg.adapter, 'chatbot');
  assert.equal(cfg.timeoutMs, 250);
  assert.equal(cfg.json, true);
  assert.equal(cfg.strictWarnings, true);
  assert.deepEqual(cfg.issuesKo, []);
});

test('인자 해석 실패: 빈 입력은 --port 누락으로 잡는다', () => {
  const cfg = parseHarnessArgs([]);
  assert.equal(cfg.portModule, '');
  assert.equal(cfg.issuesKo.length, 1);
  assert.match(cfg.issuesKo[0], /--port/);
});

test('인자 해석 실패: 값 없는 플래그를 조용히 넘기지 않는다', () => {
  const cfg = parseHarnessArgs(['--port', '--json']);
  assert.ok(cfg.issuesKo.some((m) => m.includes('--port 에 값이 없습니다')));
});

test('인자 해석 실패: 알 수 없는 어댑터·음수 예산·미지 옵션', () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs', '--adapter', 'kakao', '--timeout-ms', '-5', '--wat']);
  assert.equal(cfg.adapter, undefined);
  assert.equal(cfg.timeoutMs, undefined);
  assert.equal(cfg.issuesKo.length, 3);
});

test('인자 해석: timeout 미지정이면 예산을 만들어 넣지 않는다(§13-3)', () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs']);
  assert.equal(cfg.timeoutMs, undefined);
});

// ── 모듈에서 포트 꺼내기 ──────────────────────────────────────────────────────

test('포트 해석: default·port·팩토리 세 관습을 모두 받는다', () => {
  const port = createDryRunPort({ id: 'callbot' });
  assert.equal(resolvePortFromModule({ default: port }).port, port);
  assert.equal(resolvePortFromModule({ port }).port, port);
  assert.equal(resolvePortFromModule({ createPort: () => port }).port, port);
  assert.equal(resolvePortFromModule({ anything: port }, 'anything').port, port);
});

test('포트 해석 실패: 없는 export·형태 불일치·객체 아님', () => {
  const port = createDryRunPort({ id: 'chatbot' });
  assert.match(resolvePortFromModule({ port }, 'nope').errorKo, /없습니다/);
  assert.match(resolvePortFromModule({ x: { present: 1 } }, 'x').errorKo, /ChannelPort 형태가 아닙니다/);
  assert.match(resolvePortFromModule(null).errorKo, /객체가 아닙니다/);
  assert.match(resolvePortFromModule({ other: port }).errorKo, /찾지 못했습니다/);
});

test('포트 해석 실패: 팩토리가 던지면 원문을 그대로 흘리지 않는다(§10.3)', () => {
  const r = resolvePortFromModule({
    createPort: () => { throw new Error('설정 누락 — 담당자 010-1234-5678'); },
  });
  assert.ok(r.port === undefined);
  assert.ok(!r.errorKo.includes('010-1234-5678'));
});

// ── 하네스 판정 ──────────────────────────────────────────────────────────────

test('정상: 드라이런 참조 포트는 통과하고 종료코드 0', async () => {
  const cfg = parseHarnessArgs(['--port', './dry.mjs', '--timeout-ms', '500']);
  const port = createDryRunPort({ id: 'callbot' });
  const r = await runHarness({ config: cfg, load: loaderFor({ default: port }) });
  assert.equal(r.verdict, 'passed');
  assert.equal(r.exitCode, 0);
  assert.equal(r.dryRunDeclared, true);
  assert.equal(r.report.errorCount, 0);
});

test('정상: basePort 로 만든 포트도 통과한다(저장소 채택 경로)', async () => {
  const cfg = parseHarnessArgs(['--port', './base.mjs', '--adapter', 'dars', '--timeout-ms', '500']);
  const port = createChannelPort({ id: 'dars' });
  const r = await runHarness({ config: cfg, load: loaderFor({ port }) });
  assert.equal(r.verdict, 'passed', formatHarnessResult(r, cfg));
  assert.equal(r.dryRunDeclared, true);
});

test('실패: 계약을 어기는 포트는 오류로 잡고 종료코드 1', async () => {
  const cfg = parseHarnessArgs(['--port', './bad.mjs']);
  const bad = {
    id: 'chatbot',
    dryRun: true,
    capabilities: { adapter: 'chatbot', channel: 'chat', richMedia: true, voice: false, dtmf: false, routeToLegacyIvr: false, crossChannelInvite: false },
    async present(_id, steps) { steps.reverse(); },      // 입력 변형 — INPUT_IMMUTABLE 위반
    async transfer(_id, queue) { if (!queue) throw new Error('큐 필요'); }, // §9.3 위반
    async end() {},
  };
  const r = await runHarness({ config: cfg, load: loaderFor({ port: bad }) });
  assert.equal(r.verdict, 'failed');
  assert.equal(r.exitCode, HARNESS_EXIT_CODE.failed);
  assert.ok(r.report.errorCount >= 2);
  assert.ok(r.reasonsKo.some((m) => m.includes('오류 심각도')));
});

test('실패: 인자 오류면 검사를 아예 돌리지 않는다', async () => {
  const cfg = parseHarnessArgs([]);
  let loaded = false;
  const r = await runHarness({ config: cfg, load: async () => { loaded = true; return {}; } });
  assert.equal(loaded, false);
  assert.equal(r.verdict, 'failed');
  assert.equal(r.report, undefined);
});

test('실패: 모듈 로드 실패 사유를 마스킹해 알린다', async () => {
  const cfg = parseHarnessArgs(['--port', './missing.mjs']);
  const r = await runHarness({
    config: cfg,
    load: async () => { throw new Error('Cannot find module — 문의 010-9876-5432'); },
  });
  assert.equal(r.verdict, 'failed');
  assert.ok(!r.reasonsKo.join(' ').includes('010-9876-5432'));
  assert.ok(r.reasonsKo[0].includes('불러오지 못했습니다'));
});

test('실패: --adapter 와 포트 id 가 어긋나면 검사 전에 막는다', async () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs', '--adapter', 'callbot']);
  const r = await runHarness({ config: cfg, load: loaderFor({ port: createDryRunPort({ id: 'chatbot' }) }) });
  assert.equal(r.verdict, 'failed');
  assert.ok(r.reasonsKo[0].includes('chatbot'));
});

test('판정보류: 드라이런 선언이 없으면 통과로 적지 않는다', async () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs', '--timeout-ms', '500']);
  const silent = createDryRunPort({ id: 'callbot' });
  const undeclared = {
    id: silent.id, capabilities: silent.capabilities,
    present: silent.present.bind(silent), transfer: silent.transfer.bind(silent), end: silent.end.bind(silent),
    routeToLegacyIvr: silent.routeToLegacyIvr?.bind(silent), invite: silent.invite?.bind(silent),
  };
  const r = await runHarness({ config: cfg, load: loaderFor({ port: undeclared }) });
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.exitCode, 2);
  assert.ok(r.reasonsKo.some((m) => m.includes('드라이런임을 밝히지')));
});

test('판정보류: live 선언 포트는 실전송 위험으로 멈춘다 [승인 필요]', async () => {
  const cfg = parseHarnessArgs(['--port', './live.mjs']);
  const port = createChannelPort({
    id: 'callbot', activation: 'live', approvalRef: 'APPROVAL-TEST',
    transport: { name: 'stub', async deliver() {} },
  });
  const r = await runHarness({ config: cfg, load: loaderFor({ port }) });
  assert.equal(r.verdict, 'inconclusive');
  assert.ok(r.reasonsKo.some((m) => m.includes('live')));
});

test('판정보류: 건너뛴 항목 수를 반드시 남긴다(§13-3)', async () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs']); // timeout·flows 미지정 → 2건 건너뜀
  const r = await runHarness({ config: cfg, load: loaderFor({ port: createDryRunPort({ id: 'chatbot' }) }) });
  assert.equal(r.verdict, 'inconclusive');
  assert.ok(r.reasonsKo.some((m) => m.includes('검사하지 않은 항목 2건')));
});

test('--strict-warnings: 경고만 있어도 실패로 본다', async () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs', '--timeout-ms', '500', '--strict-warnings']);
  const port = createDryRunPort({ id: 'callbot' });
  const warnOnly = {
    ...port,
    dryRun: true,
    present: async (id, steps) => {
      if (id === 'i_does_not_exist') throw new Error('모르는 세션'); // UNKNOWN_SESSION(경고)만 실패
      return port.present(id, steps);
    },
  };
  const r = await runHarness({ config: cfg, load: loaderFor({ port: warnOnly }) });
  assert.equal(r.report.errorCount, 0);
  assert.equal(r.report.warningCount, 1);
  assert.equal(r.verdict, 'failed');
  assert.ok(r.reasonsKo.some((m) => m.includes('strict-warnings')));
});

test('하네스는 검사기 예외를 밖으로 던지지 않는다', async () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs']);
  const exploding = {
    id: 'callbot', dryRun: true,
    get capabilities() { throw new Error('설정 폭발'); },
    async present() {}, async transfer() {}, async end() {},
  };
  const r = await runHarness({ config: cfg, load: loaderFor({ port: exploding }) });
  assert.equal(r.verdict, 'failed');
  assert.ok(r.reasonsKo.some((m) => m.includes('오류')));
});

// ── 출력 ─────────────────────────────────────────────────────────────────────

test('사람용 출력: 실패·건너뜀 항목과 이유가 모두 보인다', async () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs']);
  const r = await runHarness({ config: cfg, load: loaderFor({ port: createDryRunPort({ id: 'dars' }) }) });
  const text = formatHarnessResult(r, cfg);
  assert.match(text, /판정보류/);
  assert.match(text, /TIMEOUT_BUDGET \[건너뜀\]/);
  assert.match(text, /모듈: \.\/p\.mjs/);
  assert.match(text, /드라이런 선언: 있음/);
});

test('사람용 출력: 검사를 못 돌린 경우에도 형태가 깨지지 않는다', () => {
  const cfg = parseHarnessArgs([]);
  const text = formatHarnessResult(
    { verdict: 'failed', exitCode: 1, reasonsKo: cfg.issuesKo, dryRunDeclared: false }, cfg,
  );
  assert.match(text, /채널 계약 하네스: 실패/);
  assert.match(text, /모듈: \(미지정\)/);
});

test('JSON 출력: 판정·검사목록을 담고 임의 점수를 만들지 않는다(§13-3)', async () => {
  const cfg = parseHarnessArgs(['--port', './p.mjs', '--timeout-ms', '500', '--json']);
  const r = await runHarness({ config: cfg, load: loaderFor({ port: createDryRunPort({ id: 'callbot' }) }) });
  const j = JSON.parse(harnessResultToJson(r, cfg));
  assert.equal(j.verdict, 'inconclusive'); // flows 미지정으로 1건 건너뜀
  assert.equal(j.adapter, 'callbot');
  assert.equal(j.channel, 'voice');
  assert.equal(j.timeoutMs, 500);
  assert.equal(j.checks.length, 10);
  assert.ok(!('score' in j) && !('grade' in j));
});

test('사용법 안내에 승인 경계와 종료코드가 명시된다', () => {
  assert.match(HARNESS_USAGE_KO, /승인 필요/);
  assert.match(HARNESS_USAGE_KO, /0=통과, 1=실패, 2=판정보류/);
});
