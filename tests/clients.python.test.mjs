// 파이썬 참조 클라이언트 ↔ 브리지 실동작 검증.
//
// 이 검사는 목(mock)이 아니다. 실제로 python3 프로세스를 띄워 JSONL 로 Core 를 소비하게 하고,
// 주고받은 줄을 그대로 판정기에 넣는다. Callbot 이 붙을 경로가 **정말로 도는지**를 여기서 본다.
// 실회선·실 STT/TTS 에 붙지 않는다(브리지는 dry_run, 시나리오는 fixtures 예시다).
//
// python3 이 없는 환경에서는 **건너뛴다 — 통과로 적지 않는다**(§13-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBridgeTranscript } from '../src/channels/bridgeTranscript.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = join(ROOT, 'clients', 'python');

function findPython() {
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
}

const PY = findPython();
const b = { skip: PY ? false : 'python3 을 찾지 못해 건너뜀 — 통과가 아니라 미실행이다' };

function runPython(scriptPath) {
  return spawnSync(PY, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, AICC_CORE: ROOT, PYTHONIOENCODING: 'utf-8' },
    timeout: 60000,
  });
}

/** 임시 드라이버를 쓰고 지운다. 저장소에 시험용 파일을 남기지 않는다. */
function withDriver(source, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aicc-py-'));
  const file = join(dir, 'driver.py');
  writeFileSync(file, source, 'utf8');
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PRELUDE = `# -*- coding: utf-8 -*-
import json, os, sys
sys.path.insert(0, ${JSON.stringify(CLIENT_DIR)})
from aicc_bridge import BridgeClient, BridgeProtocolError
ROOT = ${JSON.stringify(ROOT)}
CORE = os.path.join(ROOT, "fixtures", "reference-core.mjs")
def client(**kw):
    return BridgeClient(core_module=CORE, adapter="callbot", core_root=ROOT, cwd=ROOT,
                        max_line_bytes=65536, keep_transcript=True, **kw)
`;

test('참조 자체점검이 한 통화를 끝까지 돌리고 판정기가 통과로 읽는다', b, () => {
  const run = runPython(join(CLIENT_DIR, 'selfcheck.py'));
  assert.equal(run.status, 0, `자체점검 실패: ${run.stderr}`);
  const transcript = JSON.parse(run.stdout);
  const report = verifyBridgeTranscript(transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.verdict, 'passed', `판정 실패: ${JSON.stringify(report.issues)}`);
  assert.equal(report.startedInteractions, 1);
  assert.equal(report.endedInteractions, 1);
  assert.equal(report.failedResponseCount, 0);
  // 음성의 세 입력(발화·DTMF·무음)을 모두 지났는지 — 여기서 갈라지면 시나리오가 이중 관리된다.
  assert.equal(report.opCounts.send, 3);
  assert.equal(report.opCounts.health, 1);
});

test('클라이언트는 테넌트를 주장하지 않는다(§11.1)', b, () => {
  const run = runPython(join(CLIENT_DIR, 'selfcheck.py'));
  assert.equal(run.status, 0);
  const { requests } = JSON.parse(run.stdout);
  for (const line of requests) {
    assert.ok(!line.includes('"scope"'), `요청이 scope 를 실어 보냈다: ${line.slice(0, 40)}`);
    assert.ok(!line.includes('tenantId'), '요청이 테넌트를 주장했다');
  }
});

test('세션 안에서 예외가 나도 end 를 부른다 — 누수는 요금으로 먼저 나타난다', b, () => {
  const source = `${PRELUDE}
c = client()
c.hello()
try:
    with c.session(flow_id="f_reference_voice", entry_point="inbound_call", reason_ko="예외 종료") as call:
        call.send_utterance("안녕하세요")
        raise RuntimeError("호출자 코드가 터졌다")
except RuntimeError:
    pass
json.dump({"requests": c.transcript.requests, "responses": c.transcript.responses}, sys.stdout, ensure_ascii=False)
c.close()
c.close()  # 멱등해야 한다
`;
  const run = withDriver(source, (file) => runPython(file));
  assert.equal(run.status, 0, run.stderr);
  const report = verifyBridgeTranscript(JSON.parse(run.stdout), { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.endedInteractions, 1, '예외 경로에서 end 가 빠졌다');
  assert.ok(!report.issues.some((i) => i.code === 'E_SESSION_LEAK'));
});

test('start 가 실패하면 세션 없이도 던지지 않고 오류 응답을 돌려준다', b, () => {
  const source = `${PRELUDE}
c = client()
c.hello()
with c.session(flow_id="", entry_point="inbound_call") as call:
    assert call.interaction_id is None, "빈 flowId 로 세션이 열렸다"
    assert call.started.ok is False
    assert call.started.error.code == "E_BAD_REQUEST", call.started.error.code
    follow = call.send_utterance("이 호출은 보내지지 않아야 한다")
    assert follow.ok is False and follow.error.code == "E_NO_SESSION", follow.error.code
sent = [json.loads(l)["op"] for l in c.transcript.requests]
assert "end" not in sent, "열리지 않은 세션을 닫으려 했다"
c.close()
print("ok")
`;
  const run = withDriver(source, (file) => runPython(file));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ok/);
});

test('Core 위치를 못 찾으면 조용히 붙은 척하지 않고 분명히 실패한다', b, () => {
  const source = `${PRELUDE}
import tempfile
try:
    BridgeClient(core_module=CORE, adapter="callbot", core_root=tempfile.mkdtemp())
except BridgeProtocolError as e:
    print("raised")
else:
    print("no-raise")
`;
  const run = withDriver(source, (file) => runPython(file));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /raised/);
});

test('요청 하나가 실패해도 프로세스가 살아 있어 다음 턴을 받는다', b, () => {
  // 회선 하나가 이상한 바이트를 보냈다고 통화 전체가 끊기면 안 된다.
  // 등록되지 않은 채널로 start 하면 Core 가 거부하는데, 그것이 오류 **응답**이지 프로세스 종료가 아님을 본다.
  const source = `${PRELUDE}
c = BridgeClient(core_module=CORE, adapter="chatbot", core_root=ROOT, cwd=ROOT, keep_transcript=True)
first = c.hello()
assert first.ok is True
bad = c.start(flow_id="f_reference_voice", entry_point="web_chat")
assert bad.ok is False, "등록되지 않은 채널이 세션을 열었다"
assert bad.error.code == "E_INTERNAL", bad.error.code
assert "reference" not in bad.error.message_ko  # 내부 경로·스택이 새지 않는다
again = c.hello()
assert again.ok is True, "실패한 요청 하나가 브리지를 죽였다"
c.close()
print("survived")
`;
  const run = withDriver(source, (file) => runPython(file));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /survived/);
});

test('판정 실행기 CLI: 통과는 0, 기대를 안 주면 판정보류 2 로 끝난다', b, () => {
  const run = runPython(join(CLIENT_DIR, 'selfcheck.py'));
  assert.equal(run.status, 0);
  const dir = mkdtempSync(join(tmpdir(), 'aicc-tr-'));
  const file = join(dir, 'transcript.json');
  writeFileSync(file, run.stdout, 'utf8');
  try {
    const pass = spawnSync(process.execPath, [
      join(ROOT, 'scripts', 'bridge-transcript.mjs'),
      '--transcript', file, '--adapter', 'callbot', '--max-line-bytes', '65536',
    ], { encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /통과/);

    const skipped = spawnSync(process.execPath, [
      join(ROOT, 'scripts', 'bridge-transcript.mjs'), '--transcript', file,
    ], { encoding: 'utf8' });
    assert.equal(skipped.status, 2, '건너뛴 검사를 통과로 넘겼다');
    assert.match(skipped.stdout, /판정보류/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
