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

// ── 한도 초과(E_RATE_LIMITED) ──────────────────────────────────────────────
// 브리지는 재시도 가능 시각을 계산해서 준다. 클라이언트가 그 값을 버리면 호스트는 대기 시간을
// **지어내거나** 곧바로 재시도한다 — 둘 다 한도를 더 밀어붙인다.
const RL_CORE = `os.path.join(ROOT, "fixtures", "reference-core-ratelimited.mjs")`;

test('한도 초과 응답의 retryAfterMs 가 클라이언트까지 온전히 온다', b, () => {
  const source = `${PRELUDE}
c = BridgeClient(core_module=${RL_CORE}, adapter="callbot", core_root=ROOT, cwd=ROOT,
                 max_line_bytes=65536, keep_transcript=True)
c.hello()                                   # hello 는 제한 대상이 아니다
s = c.start(flow_id="f_reference_voice", entry_point="inbound_call")
i = s.interaction_id
# 한도 키는 (테넌트 + op) 라 send 는 자기 버킷을 따로 쓴다 — burst 2 를 send 로 다 쓴다.
first = c.send_utterance(i, "하나")
c.send_utterance(i, "둘")
second = c.send_utterance(i, "셋")           # 거절
ended = c.end(i, "정상 종료")                 # end 는 어떤 경우에도 막히지 않는다
json.dump({"start_ok": s.ok, "first_ok": first.ok,
           "second_ok": second.ok, "code": second.error.code if second.error else None,
           "retry": second.retry_after_ms, "rate_limited": second.rate_limited,
           "end_ok": ended.ok, "requests": c.transcript.requests,
           "responses": c.transcript.responses}, sys.stdout, ensure_ascii=False)
c.close()
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.start_ok, true);
  assert.equal(out.first_ok, true);
  assert.equal(out.second_ok, false);
  assert.equal(out.code, 'E_RATE_LIMITED');
  assert.equal(out.rate_limited, true);
  assert.ok(typeof out.retry === 'number' && out.retry > 0,
    `retryAfterMs 가 클라이언트까지 오지 않았다: ${out.retry}`);
  assert.equal(out.end_ok, true, 'end 가 한도에 막혔다 — 세션이 새고 요금으로 나타난다');
  // 거절당한 줄도 한 줄 = 한 요청 규약을 지켰는지 판정기로 다시 본다.
  const report = verifyBridgeTranscript({ requests: out.requests, responses: out.responses },
    { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.endedInteractions, 1, JSON.stringify(report.issues));
});

test('대기 시간이 없거나 형태가 틀리면 0 이 아니라 None 이다(§13-3)', b, () => {
  const source = `${PRELUDE}
def decode(err):
    raw = json.dumps({"id": "1", "ok": False, "error": err}, ensure_ascii=False)
    return BridgeClient._decode(raw, "1").error.retry_after_ms
cases = {
    "없음":      decode({"code": "E_RATE_LIMITED", "messageKo": "x"}),
    "널":        decode({"code": "E_RATE_LIMITED", "retryAfterMs": None}),
    "문자열":    decode({"code": "E_RATE_LIMITED", "retryAfterMs": "1500"}),
    "불리언":    decode({"code": "E_RATE_LIMITED", "retryAfterMs": True}),
    "음수":      decode({"code": "E_RATE_LIMITED", "retryAfterMs": -1}),
    "정상":      decode({"code": "E_RATE_LIMITED", "retryAfterMs": 1500}),
    "0":         decode({"code": "E_RATE_LIMITED", "retryAfterMs": 0}),
}
json.dump(cases, sys.stdout, ensure_ascii=False)
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  for (const key of ['없음', '널', '문자열', '불리언', '음수']) {
    assert.equal(out[key], null, `${key}: 모르는 값을 숫자로 읽었다`);
  }
  assert.equal(out['정상'], 1500);
  assert.equal(out['0'], 0, '브리지가 0 을 줬다면 0 이다 — 지어낸 값이 아니다');
});

// ── 턴 단위 실측(§11.2 usage · §13 latency) ────────────────────────────────────
// 계약(`ChannelTurnInput`)은 모든 입력 종류에 실측을 허용하고 브리지는 형태까지 검사해 채우는데,
// 참조 클라이언트는 **발화 턴에서만** 그것을 보낼 수 있었다. DTMF 선택·무음 턴에서도 그 턴의
// TTS·LLM 은 이미 호출됐고 비용은 공급사 청구서에 남으므로, 보낼 방법이 없으면 그 수량은 원장에
// 없는 채 대사에서 '미설명' 차이로만 나타난다(과소청구 방향이라 청구도 막지 않는다).

test('§11.2 DTMF 턴의 실측이 원장 이벤트까지 실린다 — 선언하지 않으면 키 자체가 없다', b, () => {
  const source = `${PRELUDE}
c = client()
c.hello()
s = c.start(flow_id="f_reference_voice", entry_point="inbound_call")
declared = c.send_dtmf(s.interaction_id, "1",
                       latency={"total_ms": 450, "stt_ms": 120},
                       usage={"stt_audio_ms": 1200, "tts_audio_ms": 800})
c2 = client()
c2.hello()
s2 = c2.start(flow_id="f_reference_voice", entry_point="inbound_call")
plain = c2.send_dtmf(s2.interaction_id, "1")
json.dump({"declared": declared.result, "declared_ok": declared.ok,
           "plain": plain.result, "lines": c.transcript.requests,
           "plain_lines": c2.transcript.requests}, sys.stdout, ensure_ascii=False)
c.close(); c2.close()
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.declared_ok, true);
  assert.equal(out.declared.billing.usageAttached, true, '실측이 이벤트에 실리지 않았다(§11.2)');
  const turn = out.declared.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.deepEqual(turn.usage, { stt_audio_ms: 1200, tts_audio_ms: 800 }, '원장 이벤트에 수량이 없다');
  assert.equal(turn.latency_ms.total_ms, 450, '§13 지연 표본이 경계에서 사라졌다');
  assert.equal(turn.latency_ms.stt_ms, 120);
  // 선언하지 않았으면 키를 만들지 않는다(§13-3) — 0 을 보내면 "0 을 실측했다"가 된다.
  const dtmfLine = out.plain_lines.find((l) => l.includes('"dtmf"'));
  assert.equal(dtmfLine.includes('usage'), false, `주지 않았는데 사용량이 실렸다: ${dtmfLine}`);
  assert.equal(dtmfLine.includes('latency'), false);
  assert.equal(out.plain.billing, undefined, '선언이 없는데 과금 기록이 생겼다');
});

test('§11.2 무음 턴도 실측을 선언할 수 있고, 응답시간은 받지 않는다', b, () => {
  // 기다리는 동안 나간 재프롬프트는 TTS 로 합성된 발화다 — 그 턴에도 비용이 있다.
  // 반대로 응답시간은 Core 가 무입력 턴에 실을 자리가 없으므로 애초에 받지 않는다(§13-3).
  const source = `${PRELUDE}
c = client()
c.hello()
s = c.start(flow_id="f_reference_voice", entry_point="inbound_call")
r = c.send_timeout(s.interaction_id, usage={"llm_prompt_tokens": 12, "llm_completion_tokens": 4})
try:
    c.send_timeout(s.interaction_id, latency={"total_ms": 10})
    accepted = True
except TypeError:
    accepted = False
json.dump({"ok": r.ok, "result": r.result, "latency_accepted": accepted,
           "lines": c.transcript.requests}, sys.stdout, ensure_ascii=False)
c.close()
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.result.billing.usageAttached, true);
  const turn = out.result.events.find((e) => e.type === 'turn.completed' && e.speaker === 'customer');
  assert.deepEqual(turn.usage, { llm_prompt_tokens: 12, llm_completion_tokens: 4 });
  assert.equal(out.latency_accepted, false,
    '무음 턴에 응답시간을 받으면 그 값은 경고와 함께 버려진다 — 받을 수 있게 열어 두지 않는다');
});

test('실측 형태가 틀리면 그 줄만 거절되고 통화는 계속된다(§11.2·§9.3)', b, () => {
  // 검사는 Core 경로 한 곳이다(§2). 클라이언트가 미리 거르면 같은 값이 경로마다 다르게 판정된다.
  const source = `${PRELUDE}
c = client()
c.hello()
s = c.start(flow_id="f_reference_voice", entry_point="inbound_call")
i = s.interaction_id
negative = c.send_dtmf(i, "1", usage={"stt_audio_ms": -1})
unknown = c.send_dtmf(i, "1", usage={"gpu_seconds": 3})
nan_latency = c.send_dtmf(i, "1", latency={"queue_ms": 5})
survived = c.send_dtmf(i, "1")
json.dump({"codes": [r.error.code if r.error else None for r in (negative, unknown, nan_latency)],
           "survived": survived.ok, "status": survived.result["status"] if survived.ok else None},
          sys.stdout, ensure_ascii=False)
c.close()
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.codes, ['E_BAD_REQUEST', 'E_BAD_REQUEST', 'E_BAD_REQUEST'],
    '실측으로 볼 수 없는 값이 통과했다 — 숫자 하나가 그 달의 집계를 망친다');
  assert.equal(out.survived, true, '거절된 줄 하나가 통화를 끊었다');
  assert.equal(out.status, 'transferred', '거절 뒤의 턴이 시나리오를 진행시키지 못했다');
});

// ── Api 대기(§6.1) ────────────────────────────────────────────────────────────
// 브리지는 대기 사실(`state.pendingConnectorId`)을 내보내도록 열려 있었지만, 참조 클라이언트에는
// 그것을 읽는 자리도 결과를 되돌려주는 자리도 없었다. 그 상태의 증상은 예외가 아니라 **무음**이다.

test('§6.1 Api 대기를 호스트가 읽고 조회 결과를 되돌려준다', b, () => {
  const source = `${PRELUDE}
API_CORE = os.path.join(ROOT, "fixtures", "reference-core-connector.mjs")
def api_client():
    return BridgeClient(core_module=API_CORE, adapter="callbot", core_root=ROOT, cwd=ROOT,
                        max_line_bytes=65536, keep_transcript=True)
c = api_client()
c.hello()
s = c.start(flow_id="f_reference_api", entry_point="inbound_call")
i = s.interaction_id
waiting = c.send_utterance(i, "잔액 조회요")
ok = c.send_connector_result(i, True, slots={"balance": "1,000원"})
ended = c.end(i, "정상 종료")

c2 = api_client()
c2.hello()
s2 = c2.start(flow_id="f_reference_api", entry_point="inbound_call")
i2 = s2.interaction_id
c2.send_utterance(i2, "잔액 조회요")
failed = c2.send_connector_result(i2, False, error_code="upstream_timeout")
json.dump({"start_pending": s.pending_connector_id,
           "waiting_pending": waiting.pending_connector_id,
           "after_pending": ok.pending_connector_id,
           "ok_status": ok.result["status"], "ok_ok": ok.ok,
           "failed_status": failed.result["status"],
           "failed_handoff": failed.result.get("handoff"),
           "end_ok": ended.ok, "lines": c.transcript.requests}, sys.stdout, ensure_ascii=False)
c.close(); c2.close()
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.start_pending, null, '대기가 서지 않은 턴에 커넥터 id 가 보였다');
  assert.equal(out.waiting_pending, 'c_reference_lookup',
    '호스트가 "부를 차례"를 알 길이 없으면 그 통화는 무음으로 멈춘다(§6.1)');
  assert.equal(out.after_pending, null, '결과를 되돌려줬는데 대기가 그대로다');
  assert.equal(out.ok_ok, true);
  assert.equal(out.ok_status, 'completed');
  // 실패는 콜을 끊지 않는다 — 시나리오의 onError 분기(여기서는 상담사 이관)로 간다(§9.3).
  assert.equal(out.failed_status, 'transferred');
  assert.ok(out.failed_handoff, '조회 실패가 이관으로 이어지지 않았다');
  assert.equal(out.end_ok, true);
  const resultLine = out.lines.find((l) => l.includes('connectorResult'));
  assert.ok(resultLine.includes('"ok":true'), `ok 를 명시하지 않았다: ${resultLine}`);
});

test('§5.2 합류 토큰을 보낼 수 있고, 주지 않으면 만들어 넣지 않는다', b, () => {
  // 전환 배선을 켜는 순간 **비-Node 호스트만** 합류하지 못하는 비대칭을 막는다. 토큰은 고객이
  // 누른 링크에 실려 오는 값이며 클라이언트가 만들지 않는다(§10.3).
  const source = `${PRELUDE}
c = client()
c.hello()
s = c.start(flow_id="f_reference_voice", entry_point="inbound_call")
joined = c.start(flow_id="f_reference_voice", entry_point="visual_link",
                 join_interaction_id=s.interaction_id, join_token="tk_from_link")
plain = c.start(flow_id="f_reference_voice", entry_point="inbound_call")
json.dump({"joined_ok": joined.ok, "joined_id": joined.interaction_id,
           "same": joined.interaction_id == s.interaction_id,
           "lines": c.transcript.requests}, sys.stdout, ensure_ascii=False)
c.close()
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  const joinLine = out.lines.find((l) => l.includes('joinInteractionId'));
  assert.ok(joinLine.includes('"joinToken":"tk_from_link"'), `합류 토큰이 실리지 않았다: ${joinLine}`);
  assert.equal(out.joined_ok, true);
  assert.equal(out.same, true, '합류가 새 Interaction 을 만들었다(§5.2)');
  // 전환이 배선되지 않은 Core 는 토큰을 보지 않는다 — 종전과 완전히 같다(§13-3).
  const startLines = out.lines.filter((l) => l.includes('"op":"start"') && !l.includes('joinInteractionId'));
  assert.equal(startLines.length, 2);
  assert.ok(startLines.every((l) => !l.includes('joinToken')), '합류가 아닌 start 에 토큰이 실렸다');
});

test('§11.2 세션 컨텍스트로 닫아도 통화 구간을 선언할 수 있고, 두 번 닫지 않는다', b, () => {
  // 권장 사용법(`with client.session(...)`)이 과금 구간을 받지 못하던 동안 그 경로로 돈 통화는
  // 전부 통화 분 집계에서 빠졌다 — end 자체는 불리므로 누수도 장애도 아니고, 월말에만 드러난다.
  const source = `${PRELUDE}
c = client()
c.hello()
with c.session(flow_id="f_reference_voice", entry_point="inbound_call", reason_ko="고객 종료") as call:
    call.send_utterance("잔액 조회요")
    call.billable_ms = 65000            # 회선이 준 실측
declared_ended = call.ended.ok

c2 = client()
c2.hello()
with c2.session(flow_id="f_reference_voice", entry_point="inbound_call") as call2:
    call2.send_utterance("잔액 조회요")
    early = call2.end("조기 종료", billable_ms=12000)
    twice = call2.end("한 번 더")       # 멱등 — 아무것도 보내지 않는다

c3 = client()
c3.hello()
with c3.session(flow_id="f_reference_voice", entry_point="inbound_call") as call3:
    pass                                 # 선언하지 않았다

json.dump({"declared": [l for l in c.transcript.requests if '"op":"end"' in l],
           "early_ok": early.ok, "twice_same": twice is early,
           "explicit": [l for l in c2.transcript.requests if '"op":"end"' in l],
           "none": [l for l in c3.transcript.requests if '"op":"end"' in l],
           "declared_ended": declared_ended}, sys.stdout, ensure_ascii=False)
c.close(); c2.close(); c3.close()
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.declared.length, 1);
  assert.ok(out.declared[0].includes('"billableMs":65000'),
    `컨텍스트 매니저가 과금 구간을 싣지 못했다: ${out.declared[0]}`);
  assert.equal(out.declared_ended, true);
  assert.equal(out.early_ok, true);
  assert.equal(out.explicit.length, 1, '두 번 닫았다 — 두 번째 호출의 billing 은 사실이 아니다(§8.1)');
  assert.ok(out.explicit[0].includes('"billableMs":12000'));
  assert.equal(out.twice_same, true, '이미 닫힌 세션이 같은 결과를 돌려주지 않았다');
  assert.equal(out.none.length, 1);
  assert.equal(out.none[0].includes('billableMs'), false, '선언하지 않았는데 값이 실렸다(§13-3)');
});

test('§11.2 end 는 통화 과금 구간을 실어 보내고, 주지 않으면 키 자체가 없다(§13-3)', b, () => {
  const source = `${PRELUDE}
c = client()
c.hello()
r = c.start(flow_id="f_reference_voice", entry_point="inbound_call")
iid = r.interaction_id
ended = c.end(iid, "고객 종료", billable_ms=65000)
c2 = client()
c2.hello()
r2 = c2.start(flow_id="f_reference_voice", entry_point="inbound_call")
plain = c2.end(r2.interaction_id, "고객 종료")
json.dump({
    "with_lines": c.transcript.requests, "without_lines": c2.transcript.requests,
    "with_ok": ended.ok, "without_ok": plain.ok,
    "with_result": ended.result, "without_result": plain.result,
}, sys.stdout, ensure_ascii=False)
c.close(); c2.close()
`;
  const run = withDriver(source, (f) => runPython(f));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.with_ok, true);
  assert.equal(out.without_ok, true);
  const endLine = out.with_lines.find((l) => l.includes('"op":"end"'));
  assert.ok(endLine.includes('"billableMs":65000'), `end 줄에 과금 구간이 없다: ${endLine}`);
  // 선언이 없으면 키를 만들지 않는다 — 0 을 보내면 "0초 통화를 실측했다"가 된다.
  const plainEnd = out.without_lines.find((l) => l.includes('"op":"end"'));
  assert.equal(plainEnd.includes('billableMs'), false, `주지 않았는데 키가 실렸다: ${plainEnd}`);
  // Core 가 사실을 되돌려 준다(참조 Core 픽스처는 billing 을 만들지 않으므로 ok 만 확인한다).
  assert.ok(out.with_result);
});
