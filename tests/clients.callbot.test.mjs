// Callbot 훅 어댑터(clients/python/aicc_callbot.py) 실동작 검증.
//
// 목이 아니다. 실제 python3 프로세스가 agent.py 의 훅 순서(call_start → transcript → call_end)를
// 흉내 내며 브리지(dry_run)를 소비하고, 주고받은 줄을 판정기에 넣는다.
// 실회선·실 STT/TTS 에 붙지 않는다. python3 이 없으면 **건너뛴다 — 통과로 적지 않는다**(§13-3).
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

function runDriver(source, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aicc-cb-'));
  const file = join(dir, 'driver.py');
  writeFileSync(file, source, 'utf8');
  try {
    return spawnSync(PY, [file], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, AICC_CORE: ROOT, PYTHONIOENCODING: 'utf-8', ...extraEnv },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PRELUDE = `# -*- coding: utf-8 -*-
import json, os, sys, asyncio
sys.path.insert(0, ${JSON.stringify(CLIENT_DIR)})
from aicc_bridge import BridgeClient
from aicc_callbot import CallbotCoreHooks, AsyncCallbotCoreHooks
ROOT = ${JSON.stringify(ROOT)}
CORE = os.path.join(ROOT, "fixtures", "reference-core.mjs")
errors = []
def factory():
    return BridgeClient(core_module=CORE, adapter="callbot", core_root=ROOT, cwd=ROOT,
                        max_line_bytes=65536, keep_transcript=True)
def hooks(**kw):
    return CallbotCoreHooks(factory, flow_id="f_reference_voice", entry_point="inbound_call",
                            on_error=lambda c, m: errors.append(c), **kw)
def dump(h, **extra):
    c = h._client
    t = {"requests": c.transcript.requests, "responses": c.transcript.responses} if c else None
    out = {"transcript": t, "stats": h.stats.as_dict(), "errors": errors,
           "enabled": h.enabled, "degraded": h.degraded, "reason": h.disabled_reason_ko}
    out.update(extra)
    json.dump(out, sys.stdout, ensure_ascii=False)
`;

function parse(run) {
  assert.equal(run.status, 0, `드라이버 실패: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test('겹친 통화 두 건이 call_id 로 격리되고 고객 발화만 Core 로 간다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks()
a = h.on_call_start("call-A"); bb = h.on_call_start("call-B")
assert a and bb and a != bb, (a, bb)
h.on_transcript("call-A", "assistant", "이음 고객센터입니다")   # 봇 발화 → 보내지 않는다
h.on_transcript("call-A", "user", "잔액 조회요", confidence=0.9)
h.on_transcript("call-B", "user", "상담사 연결")
h.on_dtmf("call-A", "1")
h.on_timeout("call-B")
h.on_call_end("call-A"); h.on_call_end("call-B")
dump(h)
h.close()
`));
  const report = verifyBridgeTranscript(out.transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.verdict, 'passed', JSON.stringify(report.issues));
  assert.equal(report.startedInteractions, 2);
  assert.equal(report.endedInteractions, 2);
  assert.equal(report.opCounts.send, 4, '고객 턴 4건(발화2·DTMF·무음)만 나가야 한다');
  assert.ok(!out.transcript.requests.some((l) => l.includes('이음 고객센터입니다')), '봇 발화가 Core 로 갔다');
  assert.equal(out.stats.ignored_non_user, 1);
  assert.equal(out.stats.turns_sent, 4);
  assert.deepEqual(out.errors, []);
});

test('꺼진 어댑터(기본 OFF)는 프로세스를 띄우지 않고 어떤 훅에서도 던지지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = CallbotCoreHooks.from_env({})              # AICC_CORE_ENABLED 없음
assert h.enabled is False
assert h.on_call_start("c1") is None
assert h.on_transcript("c1", "user", "안녕") is None
assert h.on_call_end("c1") is None
h.close()
h2 = CallbotCoreHooks.from_env({"AICC_CORE_ENABLED": "1", "AICC_CORE": ROOT, "AICC_CORE_MODULE": CORE})
dump(h, reason2=h2.disabled_reason_ko, enabled2=h2.enabled)
`));
  assert.equal(out.enabled, false);
  assert.equal(out.transcript, null, '꺼진 어댑터가 브리지를 띄웠다');
  assert.match(out.reason, /AICC_CORE_ENABLED/);
  // Flow id 는 기본값을 만들지 않는다(§13-3) — 빠지면 켜지지 않고 이유를 말한다.
  assert.equal(out.enabled2, false);
  assert.match(out.reason2, /AICC_FLOW_ID/);
});

test('from_env 로 켠 어댑터가 실제로 한 통화를 끝까지 돌린다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = CallbotCoreHooks.from_env({"AICC_CORE_ENABLED": "true", "AICC_CORE": ROOT, "AICC_CORE_MODULE": CORE,
                               "AICC_FLOW_ID": "f_reference_voice", "AICC_MAX_LINE_BYTES": "65536"},
                              on_error=lambda c, m: errors.append(c))
assert h.enabled, h.disabled_reason_ko
h.on_call_start("c1"); h.on_transcript("c1", "user", "잔액"); h.on_call_end("c1")
c = h._client; c.transcript = None
stats = h.stats.as_dict(); h.close()
json.dump({"stats": stats, "errors": errors, "sent": [json.loads(l)["op"] for l in []]}, sys.stdout)
`));
  assert.equal(out.stats.calls_started, 1);
  assert.equal(out.stats.turns_sent, 1);
  assert.equal(out.stats.calls_ended, 1);
  assert.deepEqual(out.errors, []);
});

test('모르는 통화·중복 종료·빈 발화는 보내지 않고 건수로만 남는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks()
h.on_call_start("c1")
assert h.on_transcript("ghost", "user", "누구세요") is None
assert h.on_transcript("c1", "user", "   ") is None
assert h.on_dtmf("c1", "") is None
r1 = h.on_call_end("c1"); r2 = h.on_call_end("c1")
assert r1 is not None and r1.ok and r2 is None
assert h.on_transcript("c1", "user", "끝난 뒤") is None
dump(h)
h.close()
`));
  const report = verifyBridgeTranscript(out.transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.verdict, 'passed', JSON.stringify(report.issues));
  assert.equal(report.opCounts.send ?? 0, 0);
  assert.equal(report.opCounts.end, 1);
  assert.equal(out.stats.unknown_call_ids, 1);
  assert.equal(out.stats.duplicate_ends, 1);
  assert.equal(out.stats.late_after_end, 1);
  assert.equal(out.stats.ignored_empty, 2);
});

test('브리지가 통화 중 죽어도 훅은 던지지 않고 degraded 로 드러낸다(§9.3)', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks()
h.on_call_start("c1")
h.on_transcript("c1", "user", "첫 턴")
h._client._proc.kill(); h._client._proc.wait()
r = h.on_transcript("c1", "user", "죽은 뒤 턴")       # 예외가 아니라 None
assert r is None
assert h.degraded is True
assert h.on_call_start("c2") is None                    # 이후 통화도 Core 없이 진행
r_end = h.on_call_end("c1")
assert r_end is None and h.open_call_ids() == []
dump(h)
h.close(); h.close()
`));
  assert.equal(out.degraded, true);
  assert.deepEqual(out.errors, ['E_BRIDGE_DOWN'], '끊김은 정확히 한 번 보고한다');
  assert.ok(out.stats.degraded_skips >= 2);
});

test('close() 는 열린 통화를 먼저 닫는다 — 에이전트가 통화 중 내려가도 세션이 새지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks()
h.on_call_start("c1"); h.on_call_start("c2")
h.on_transcript("c1", "user", "여보세요")
c = h._client
h.close()
json.dump({"transcript": {"requests": c.transcript.requests, "responses": c.transcript.responses},
           "stats": h.stats.as_dict()}, sys.stdout, ensure_ascii=False)
`));
  const report = verifyBridgeTranscript(out.transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.verdict, 'passed', JSON.stringify(report.issues));
  assert.equal(report.endedInteractions, 2);
  assert.ok(!report.issues.some((i) => i.code === 'E_SESSION_LEAK'));
});

test('비동기 래퍼는 같은 통화의 훅을 순서대로 처리하고 이벤트 루프를 막지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
async def main():
    h = AsyncCallbotCoreHooks(hooks())
    assert h.enabled
    # 순서를 기다리지 않고 한꺼번에 던진다 — 같은 통화는 도착 순서대로 처리돼야 한다.
    await asyncio.gather(
        h.on_call_start("c1"),
        h.on_transcript("c1", "user", "하나"),
        h.on_transcript("c1", "user", "둘"),
        h.on_call_end("c1"),
    )
    inner = h.inner
    dump(inner, order=[json.loads(l)["op"] for l in inner._client.transcript.requests])
    await h.close()
asyncio.run(main())
`));
  assert.deepEqual(out.order, ['hello', 'start', 'send', 'send', 'end']);
  assert.equal(out.stats.unknown_call_ids, 0, '순서가 어긋나 세션 없이 턴이 도착했다');
  const report = verifyBridgeTranscript(out.transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.verdict, 'passed', JSON.stringify(report.issues));
});

test('어댑터 파일은 어떤 것도 print 하지 않는다(§10.3)', () => {
  const src = spawnSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(CLIENT_DIR, 'aicc_callbot.py'))}, 'utf8'))`], { encoding: 'utf8' }).stdout;
  const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/\bprint\(/.test(code), 'print 호출이 있다');
  assert.ok(!/logging\./.test(code), 'logging 호출이 있다');
});

test('세션 시작이 거부되면(빈 Flow) 통화는 계속되고 오류 코드만 보고된다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = CallbotCoreHooks(factory, flow_id="f_없는_flow", on_error=lambda c, m: errors.append(c))
assert h.on_call_start("c1") is None
assert h.on_transcript("c1", "user", "여보세요") is None   # 세션 없는 통화의 턴은 보내지 않는다
assert h.on_call_end("c1") is None
assert h.degraded is False, "거부는 끊김이 아니다"
dump(h)
h.close()
`));
  assert.equal(out.degraded, false);
  assert.equal(out.errors.length, 1);
  assert.notEqual(out.errors[0], 'E_BRIDGE_DOWN');
  const ops = out.transcript.requests.map((l) => JSON.parse(l).op);
  assert.deepEqual(ops, ['hello', 'start'], '거부된 세션에 send·end 를 보냈다');
});
