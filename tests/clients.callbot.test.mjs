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

// ── 비동기 래퍼의 순서 보장 ────────────────────────────────────────────────
// 위 시나리오 테스트는 브리지까지 돌리느라 스레드 경합에 따라 통과해 버릴 수 있었다(실제로 그랬다).
// 여기서는 브리지 없이 래퍼만 떼어 내 **fn 진입 순서와 겹침**을 직접 본다 — 순서가 무너지면
// 반드시 실패한다.
const FAKE_INNER = `
import time, threading
class FakeInner:
    """훅 본체가 언제 들어오고 겹치는지만 기록하는 가짜 inner."""
    def __init__(self):
        self.enabled = True
        self.disabled_reason_ko = ""
        self.order = []
        self.closed_at = None
        self._active = {}
        self.max_overlap = {}
        self._m = threading.Lock()
    def _work(self, call_id, label):
        with self._m:
            self.order.append(call_id + ":" + label)
            n = self._active.get(call_id, 0) + 1
            self._active[call_id] = n
            self.max_overlap[call_id] = max(self.max_overlap.get(call_id, 0), n)
        time.sleep(0.03)                      # 겹치면 반드시 겹친 채로 관측된다
        with self._m:
            self._active[call_id] -= 1
        return label
    def on_call_start(self, call_id, **kw): return self._work(call_id, "start")
    def on_transcript(self, call_id, role, text, **kw): return self._work(call_id, "t" + text)
    def on_dtmf(self, call_id, digits): return self._work(call_id, "d" + digits)
    def on_timeout(self, call_id): return self._work(call_id, "timeout")
    def on_call_end(self, call_id, reason_ko="통화 종료"): return self._work(call_id, "end")
    def close(self):
        with self._m:
            self.closed_at = len(self.order)
`;

test('같은 통화의 훅은 겹치지 않고 도착 순서대로 실행된다(end 가 턴을 앞지르지 않는다)', b, () => {
  const out = parse(runDriver(`${PRELUDE}${FAKE_INNER}
async def main():
    inner = FakeInner()
    h = AsyncCallbotCoreHooks(inner)
    # 기다리지 않고 한꺼번에 던진다. 스레드풀이 놀고 있어도 같은 통화는 한 번에 하나여야 한다.
    await asyncio.gather(
        h.on_call_start("c1"),
        *[h.on_transcript("c1", "user", str(i)) for i in range(8)],
        h.on_dtmf("c1", "1"),
        h.on_call_end("c1"),
        h.on_call_start("c2"),
        h.on_transcript("c2", "user", "x"),
        h.on_call_end("c2"),
    )
    await h.close()
    json.dump({"order": inner.order, "overlap": inner.max_overlap}, sys.stdout, ensure_ascii=False)
asyncio.run(main())
`));
  const c1 = out.order.filter((o) => o.startsWith('c1:')).map((o) => o.slice(3));
  assert.deepEqual(c1, ['start', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 'd1', 'end'],
    '같은 통화의 훅 순서가 어긋났다 — end 가 턴을 앞지르면 턴은 "끝난 통화의 지연 전사"로 조용히 버려진다');
  assert.deepEqual(out.order.filter((o) => o.startsWith('c2:')).map((o) => o.slice(3)), ['start', 'tx', 'end']);
  assert.equal(out.overlap.c1, 1, '같은 통화의 훅이 겹쳐 실행됐다 — 세션 상태가 갈라진다');
  assert.equal(out.overlap.c2, 1);
});

test('close 는 예약된 훅을 먼저 비운 뒤 브리지를 내린다', b, () => {
  const out = parse(runDriver(`${PRELUDE}${FAKE_INNER}
async def main():
    inner = FakeInner()
    h = AsyncCallbotCoreHooks(inner)
    tasks = [asyncio.ensure_future(h.on_call_start("c1"))]
    tasks += [asyncio.ensure_future(h.on_transcript("c1", "user", str(i))) for i in range(4)]
    tasks.append(asyncio.ensure_future(h.on_call_end("c1")))
    await asyncio.sleep(0)          # 예약만 시키고(각 태스크의 첫 걸음) 결과는 기다리지 않는다
    await h.close()                 # 여기서 먼저 닫아 버리면 남은 턴이 통째로 사라진다
    await asyncio.gather(*tasks)
    json.dump({"order": inner.order, "closed_at": inner.closed_at,
               "overlap": inner.max_overlap}, sys.stdout, ensure_ascii=False)
asyncio.run(main())
`));
  assert.deepEqual(out.order, ['c1:start', 'c1:t0', 'c1:t1', 'c1:t2', 'c1:t3', 'c1:end']);
  assert.equal(out.closed_at, 6, '예약된 훅이 남아 있는데 브리지를 내렸다');
  assert.equal(out.overlap.c1, 1);
});

test('앞 훅이 예외로 끝나도 뒤 훅이 막히지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}${FAKE_INNER}
class Boom(FakeInner):
    def on_call_start(self, call_id, **kw):
        raise RuntimeError("inner 폭발")      # 래퍼가 여기서 체인을 놓치면 통화가 영영 멈춘다

async def main():
    inner = Boom()
    h = AsyncCallbotCoreHooks(inner)
    results = await asyncio.gather(
        h.on_call_start("c1"),
        h.on_transcript("c1", "user", "하나"),
        h.on_call_end("c1"),
        return_exceptions=True,
    )
    await asyncio.wait_for(h.drain("c1"), timeout=5)
    json.dump({"order": inner.order, "first_failed": isinstance(results[0], RuntimeError),
               "rest_ok": [r for r in results[1:]]}, sys.stdout, ensure_ascii=False)
asyncio.run(main())
`));
  assert.equal(out.first_failed, true, '예외는 삼키지 않고 호출자에게 올라간다');
  assert.deepEqual(out.order, ['c1:t하나', 'c1:end'], '앞 훅의 예외가 뒤 훅을 막았다');
});

// ── 한도 초과 처리 ─────────────────────────────────────────────────────────
// 한도 초과를 브리지 사망과 같게 다루면 통화 전체가 Core 를 잃는다(§9.3). 반대로 무시하고
// 계속 던지면 한도를 더 밀어붙인다. 그 사이를 지키는지 본다 — 그리고 end 는 절대 미루지 않는지.
const RL_PRELUDE = `${PRELUDE}
RL_CORE = os.path.join(ROOT, "fixtures", "reference-core-ratelimited.mjs")
def rl_factory():
    return BridgeClient(core_module=RL_CORE, adapter="callbot", core_root=ROOT, cwd=ROOT,
                        max_line_bytes=65536, keep_transcript=True)
`;

test('한도 초과는 degraded 가 아니며 그 통화의 턴만 대기시킨다 — end 는 미루지 않는다', b, () => {
  const out = parse(runDriver(`${RL_PRELUDE}
h = CallbotCoreHooks(rl_factory, flow_id="f_reference_voice", entry_point="inbound_call",
                     on_error=lambda c, m: errors.append(c))
h.on_call_start("c1")
h.on_transcript("c1", "user", "하나")        # send 버킷 burst 2
h.on_transcript("c1", "user", "둘")
h.on_transcript("c1", "user", "셋")          # 거절 → 대기 시작
h.on_transcript("c1", "user", "넷")          # 대기 중 → 보내지 않는다
h.on_transcript("c1", "user", "다섯")
h.on_call_end("c1")                          # 대기와 무관하게 반드시 나간다
dump(h)
h.close()
`));
  assert.equal(out.degraded, false, '한도 초과를 브리지 사망으로 다뤘다 — 통화 전체가 Core 를 잃는다');
  assert.equal(out.stats.turns_sent, 2);
  assert.equal(out.stats.turns_rate_limited, 1, '거절은 한 번만 당해야 한다(그 뒤로는 대기)');
  assert.equal(out.stats.turns_deferred, 2, '대기 중에도 계속 보냈다');
  assert.equal(out.stats.turns_failed, 0, '한도 초과를 일반 실패와 섞어 셌다');
  assert.equal(out.stats.calls_ended, 1);
  assert.deepEqual(out.errors, ['E_RATE_LIMITED']);
  const ops = out.transcript.requests.map((l) => JSON.parse(l).op);
  assert.deepEqual(ops, ['hello', 'start', 'send', 'send', 'send', 'end'],
    '대기 중인 턴을 보냈거나 end 를 빠뜨렸다');
  const report = verifyBridgeTranscript(out.transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.endedInteractions, 1, JSON.stringify(report.issues));
});

test('대기 시간이 지나면 다시 보낸다 — 대기 시간을 주지 않으면 대기하지 않는다(§13-3)', b, () => {
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeError, BridgeResponse

class FakeClient:
    """정해진 순서대로 응답하는 가짜 브리지. 시계를 직접 밀어 대기 해제를 결정적으로 본다."""
    def __init__(self, retry_after_ms):
        self.retry = retry_after_ms
        self.sent = []
        self.transcript = None
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def start(self, **kw):
        return BridgeResponse(id="2", ok=True, result={"interactionId": "i1"})
    def send_utterance(self, i, text, **kw):
        self.sent.append(text)
        if len(self.sent) == 1:
            return BridgeResponse(id="3", ok=False,
                                  error=BridgeError("E_RATE_LIMITED", "한도", self.retry))
        return BridgeResponse(id="4", ok=True, result={})
    def end(self, i, reason): return BridgeResponse(id="9", ok=True, result={})
    def close(self): pass

def run(retry_after_ms):
    now = [1000.0]
    c = FakeClient(retry_after_ms)
    h = CallbotCoreHooks(lambda: c, flow_id="f", monotonic=lambda: now[0])
    h.on_call_start("c1")
    h.on_transcript("c1", "user", "가")      # 거절
    h.on_transcript("c1", "user", "나")      # 대기 중이면 안 나간다
    now[0] += 2.0                             # 2초 경과
    h.on_transcript("c1", "user", "다")
    h.on_call_end("c1")
    h.close()
    return {"sent": c.sent, "stats": h.stats.as_dict(), "degraded": h.degraded}

json.dump({"waited": run(1500), "no_wait": run(None)}, sys.stdout, ensure_ascii=False)
`));
  // 대기 시간을 준 경우: 대기 중 한 건은 보내지 않고, 지난 뒤 다시 보낸다.
  assert.equal(out.waited.degraded, false, '가짜 브리지에서 예외가 나 degraded 로 빠졌다');
  assert.deepEqual(out.waited.sent, ['가', '다']);
  assert.equal(out.waited.stats.turns_deferred, 1);
  assert.equal(out.waited.stats.turns_rate_limited, 1);
  // 대기 시간을 주지 않은 경우: 없는 근거로 턴을 버리지 않는다 — 다음 턴을 그대로 보낸다.
  assert.deepEqual(out.no_wait.sent, ['가', '나', '다']);
  assert.equal(out.no_wait.stats.turns_deferred, 0);
});

test('start 가 한도에 걸리면 뒤따르는 통화는 start 를 다시 던지지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeError, BridgeResponse

class StartLimited:
    def __init__(self):
        self.starts = 0
        self.transcript = None
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def start(self, **kw):
        self.starts += 1
        return BridgeResponse(id="2", ok=False, error=BridgeError("E_RATE_LIMITED", "한도", 5000))
    def end(self, i, reason): return BridgeResponse(id="9", ok=True, result={})
    def close(self): pass

now = [0.0]
c = StartLimited()
h = CallbotCoreHooks(lambda: c, flow_id="f", monotonic=lambda: now[0],
                     on_error=lambda code, m: errors.append(code))
h.on_call_start("c1"); h.on_call_start("c2"); h.on_call_start("c3")
now[0] += 6.0
h.on_call_start("c4")
json.dump({"starts": c.starts, "stats": h.stats.as_dict(), "errors": errors,
           "degraded": h.degraded}, sys.stdout, ensure_ascii=False)
h.close()
`));
  assert.equal(out.starts, 2, '한도 대기 중에도 start 를 계속 던졌다(또는 대기가 안 풀렸다)');
  assert.equal(out.stats.starts_rate_limited, 2);
  assert.equal(out.stats.starts_deferred, 2);
  assert.equal(out.stats.calls_started, 0);
  assert.equal(out.degraded, false);
});
