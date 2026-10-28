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
def hooks(flow_id="f_reference_voice", **kw):
    return CallbotCoreHooks(factory, flow_id=flow_id, entry_point="inbound_call",
                            on_error=lambda c, m: errors.append(c), **kw)
# 참조 흐름은 첫 발화가 곧 이관이라 그 턴에서 Core 세션이 끝난다 — 다중 턴 경로를 검사하려면
# 수집 노드가 이어지는 흐름이 필요하다(fixtures/reference-core.mjs 의 두 번째 흐름 주석).
MULTI = "f_reference_voice_multi"
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
h = hooks(MULTI)
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
h = hooks(MULTI)
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
    h = AsyncCallbotCoreHooks(hooks(MULTI))
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
h = CallbotCoreHooks(rl_factory, flow_id=MULTI, entry_point="inbound_call",
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

test('§11.2 통화 과금 구간은 받은 그대로 보내고, 없으면 추정하지 않고 건수로 센다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks()
h.on_call_start("call-A"); h.on_call_start("call-B")
h.on_call_end("call-A", billable_ms=65000)   # 회선이 준 실측
h.on_call_end("call-B")                       # 주지 않았다 — 만들어 넣지 않는다
dump(h)
h.close()
`));
  const ends = out.transcript.requests.filter((l) => l.includes('"op":"end"'));
  assert.equal(ends.length, 2);
  assert.equal(ends.filter((l) => l.includes('"billableMs":65000')).length, 1);
  assert.equal(ends.filter((l) => l.includes('billableMs')).length, 1, '선언하지 않은 통화에 값이 실렸다');
  assert.equal(out.stats.ends_missing_billable_ms, 1, '청구 근거 없는 통화를 세지 않았다');
  assert.equal(out.stats.calls_ended, 2);
});

test('구버전 시그니처의 end 를 감싼 호스트도 종료에서 죽지 않는다', b, () => {
  // 종료 자리에서 죽으면 세션이 닫히지 않고, 그 누수는 장애가 아니라 요금으로 먼저 나타난다.
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeResponse

class LegacyEnd:
    def __init__(self):
        self.ends = []
        self.transcript = None
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def start(self, **kw): return BridgeResponse(id="2", ok=True, result={"interactionId": "i1"})
    def end(self, i, reason):            # billable_ms 를 모르는 구버전
        self.ends.append((i, reason))
        return BridgeResponse(id="9", ok=True, result={})
    def close(self): pass

c = LegacyEnd()
h = CallbotCoreHooks(lambda: c, flow_id="f", on_error=lambda code, m: errors.append(code))
h.on_call_start("c1")
h.on_call_end("c1")
json.dump({"ends": c.ends, "stats": h.stats.as_dict(), "errors": errors,
           "degraded": h.degraded, "enabled": h.enabled, "reason": h.disabled_reason_ko,
           "transcript": None}, sys.stdout, ensure_ascii=False)
h.close()
`));
  assert.equal(out.ends.length, 1, '종료가 구버전 구현에서 막혔다');
  assert.equal(out.stats.calls_ended, 1);
  assert.deepEqual(out.errors, []);
  assert.equal(out.degraded, false);
});

// ── 턴 단위 실측(§11.2 usage · §13 latency) ────────────────────────────────────
// 음성 엔진을 부르는 주체는 회선이고 Core 는 그 수량을 관측할 길이 없다(§6.2) — 훅이 넘기지
// 않으면 §8.1 원장에 한 줄도 남지 않는다. 그 방향은 과소청구라 청구를 막지도 않고,
// 공급사 청구서와의 차이는 몇 주 뒤 대사에서 '미설명'으로만 나타난다.

test('§11.2 턴 단위 실측은 받은 그대로 나가고, 선언 없이 보낸 턴을 센다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks(MULTI)
h.on_call_start("call-A")
h.on_transcript("call-A", "user", "잔액 조회요", confidence=0.91,
                latency={"stt_ms": 310, "total_ms": 820},
                usage={"stt_audio_ms": 2400, "llm_prompt_tokens": 180, "llm_completion_tokens": 40})
h.on_dtmf("call-A", "1", latency={"total_ms": 120}, usage={"tts_audio_ms": 1500})
h.on_timeout("call-A")                       # 회선이 실측을 주지 않았다 — 만들어 넣지 않는다
h.on_call_end("call-A", billable_ms=48000)
dump(h)
h.close()
`));
  const sends = out.transcript.requests.filter((l) => l.includes('"op":"send"'));
  assert.equal(sends.length, 3);
  const utter = sends.find((l) => l.includes('utterance'));
  assert.ok(utter.includes('"usage":{"stt_audio_ms":2400'), `발화 턴 실측이 빠졌다: ${utter}`);
  assert.ok(utter.includes('"latency":{"stt_ms":310'), `발화 턴 응답시간이 빠졌다: ${utter}`);
  const dtmf = sends.find((l) => l.includes('"dtmf"'));
  assert.ok(dtmf.includes('"usage":{"tts_audio_ms":1500}'), `DTMF 턴 실측이 빠졌다: ${dtmf}`);
  assert.ok(dtmf.includes('"latency":{"total_ms":120}'), `DTMF 턴 응답시간이 빠졌다: ${dtmf}`);
  const timeout = sends.find((l) => l.includes('timeout'));
  assert.equal(timeout.includes('usage'), false, '선언하지 않았는데 사용량이 실렸다(§13-3)');
  // 통화 구간과 같은 규칙으로 센다 — 세지 않으면 "근거 없는 턴"이 몇 건인지 모른다.
  assert.equal(out.stats.turns_missing_usage, 1, '실측 선언 없이 보낸 턴을 세지 않았다');
  assert.equal(out.stats.turns_sent, 3);
  assert.equal(out.stats.ends_missing_billable_ms, 0);
  assert.deepEqual(out.errors, []);
});

test('비동기 래퍼도 같은 실측을 넘긴다 — 동기 쪽만 열면 권장 경로에서만 사라진다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
async def main():
    h = AsyncCallbotCoreHooks(hooks(MULTI))
    await h.on_call_start("call-A")
    await h.on_transcript("call-A", "user", "잔액", usage={"stt_audio_ms": 900})
    await h.on_dtmf("call-A", "2", usage={"tts_audio_ms": 300}, latency={"total_ms": 55})
    await h.on_timeout("call-A", usage={"llm_prompt_tokens": 7})
    await h.on_call_end("call-A", "통화 종료", 31000)
    dump(h.inner)
    await h.close()
asyncio.run(main())
`));
  const sends = out.transcript.requests.filter((l) => l.includes('"op":"send"'));
  assert.equal(sends.length, 3);
  assert.equal(sends.filter((l) => l.includes('usage')).length, 3,
    '비동기 래퍼가 실측을 떨어뜨렸다 — asyncio 에이전트가 권장 경로다');
  assert.ok(sends.find((l) => l.includes('"dtmf"')).includes('"latency":{"total_ms":55}'));
  assert.equal(out.stats.turns_missing_usage, 0);
  assert.equal(out.stats.turns_sent, 3);
  assert.deepEqual(out.errors, []);
});

test('실측을 선언하지 않으면 구버전 클라이언트를 감싼 호스트에서도 호출 모양이 같다', b, () => {
  // 턴 자리에서 TypeError 로 죽으면 그 통화는 Core 를 통째로 잃는다(degraded) — end 와 같은 규칙으로
  // **선언이 없으면 인자를 싣지 않는다**(§13-3).
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeResponse

class LegacyTurn:
    def __init__(self):
        self.calls = []
        self.transcript = None
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def start(self, **kw): return BridgeResponse(id="2", ok=True, result={"interactionId": "i1"})
    def send_utterance(self, i, text, confidence=None):      # latency·usage 를 모르는 구버전
        self.calls.append(("utterance", text))
        return BridgeResponse(id="3", ok=True, result={})
    def send_dtmf(self, i, digits):
        self.calls.append(("dtmf", digits))
        return BridgeResponse(id="4", ok=True, result={})
    def send_timeout(self, i):
        self.calls.append(("timeout", None))
        return BridgeResponse(id="5", ok=True, result={})
    def end(self, i, reason, billable_ms=None): return BridgeResponse(id="9", ok=True, result={})
    def close(self): pass

c = LegacyTurn()
h = CallbotCoreHooks(lambda: c, flow_id="f", on_error=lambda code, m: errors.append(code))
h.on_call_start("c1")
h.on_transcript("c1", "user", "잔액")
h.on_dtmf("c1", "1")
h.on_timeout("c1")
degraded_before = h.degraded
stats_before = h.stats.as_dict()
declared = h.on_transcript("c1", "user", "실측 선언", usage={"stt_audio_ms": 10})
json.dump({"calls": c.calls, "stats": stats_before, "errors": errors,
           "degraded": degraded_before, "degraded_after": h.degraded,
           "enabled": h.enabled, "reason": h.disabled_reason_ko,
           "transcript": None, "declared_ok": declared is not None and declared.ok},
          sys.stdout, ensure_ascii=False)
h.close()
`));
  assert.deepEqual(out.calls, [['utterance', '잔액'], ['dtmf', '1'], ['timeout', null]],
    '선언이 없는데 호출 모양이 바뀌었다 — 구버전 구현이 턴 자리에서 죽는다');
  assert.equal(out.degraded, false, '선언 없는 턴이 통화를 degraded 로 떨어뜨렸다');
  assert.equal(out.stats.turns_sent, 3);
  assert.equal(out.stats.turns_missing_usage, 3);
  // 선언했는데 받을 수 없는 구버전 구현이면 그 턴은 실패한다 — 삼키지 않고 드러낸다(§9.3).
  // (복사본 어긋남의 증상이 바로 이것이라 `scripts/client-drift.mjs` 가 CI 게이트로 있다.)
  assert.equal(out.declared_ok, false);
  assert.equal(out.degraded_after, true);
  assert.deepEqual(out.errors, ['E_BRIDGE_DOWN']);
});

test('§5.1 no-match 턴을 미인식으로 올린다 — 발화 훅으로 돌리면 슬롯 값이 된다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks()
h.on_call_start("call-A")
miss = h.on_unrecognized("call-A", "카드를 잃어버렸어요", usage={"stt_audio_ms": 400})
empty = h.on_unrecognized("call-A")              # 인식기가 아무 말도 돌려주지 못한 턴
bad = h.on_unrecognized("call-A", 3)             # 문자열이 아닌 값만 거른다
h.on_call_end("call-A", billable_ms=1000)
dump(h, miss=miss.result if miss else None, miss_ok=bool(miss and miss.ok),
     empty_ok=bool(empty and empty.ok), bad_is_none=(bad is None))
h.close()
`));
  const report = verifyBridgeTranscript(out.transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.verdict, 'passed', JSON.stringify(report.issues));
  assert.equal(report.opCounts.send, 2, '문자열이 아닌 값은 보내지 않는다');
  assert.equal(out.miss_ok, true);
  assert.equal(out.empty_ok, true, '빈 텍스트를 버리면 사다리가 돌지 않아 통화가 멈춘 것처럼 보인다');
  assert.equal(out.bad_is_none, true);
  assert.equal(out.stats.ignored_empty, 1);
  assert.equal(out.stats.turns_sent, 2);
  // 미인식은 슬롯 값이 되지 않는다 — 이것이 `on_transcript` 로 바꿔 보내면 안 되는 이유다.
  assert.equal(out.miss.state.slotKeys.includes('purpose'), false);
  assert.equal(out.miss.state.failCount, 1);
  assert.ok(out.transcript.requests.some((l) => l.includes('"unrecognized"')));
});

test('비동기 훅에도 미인식 자리가 있다 — 한쪽만 더하면 그 호스트에서만 사라진다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
async def main():
    h = AsyncCallbotCoreHooks(hooks())
    await h.on_call_start("call-A")
    r = await h.on_unrecognized("call-A", "어...", usage={"stt_audio_ms": 100})
    await h.on_call_end("call-A", billable_ms=500)
    await h.drain()
    dump(h.inner, miss_ok=bool(r and r.ok), fail_count=(r.result["state"]["failCount"] if r and r.ok else None))
    await h.close()
asyncio.run(main())
`));
  assert.equal(out.miss_ok, true, 'asyncio 가 권장 경로다 — 여기서 빠지면 음성 채널 전체에서 사라진다');
  assert.equal(out.fail_count, 1);
  assert.equal(out.stats.turns_sent, 1);
  assert.equal(out.stats.turns_missing_usage, 0);
});

// ── 보냈다 ≠ 실렸다(§11.2) ────────────────────────────────────────────────────
// 선언 건수만 세면 카운터가 "근거 있는 턴"을 과대 보고한다 — 실을 자리가 없어 버려진 실측도
// 선언된 턴으로 세기 때문이다. Core 는 그 판정을 응답에 돌려주므로 그대로 읽어 나눠 센다.

test('§11.2 선언했는데 실리지 않은 실측·통화 구간을 선언 누락과 나눠 센다', b, () => {
  // 실을 자리가 없는 턴의 **실제 운영 경로**는 §9.3 장애 폴백이다: 인지 계층이 죽으면 그 턴은
  // 고객 발화 이벤트를 만들기 전에 상담사로 내려가고(`applyOutage`), 그런데 회선은 이미 STT 를
  // 돌렸으므로 그 수량은 공급사 청구서에만 남는다. 그 폴백이 세션을 끝내므로 뒤따르는 종료의
  // 통화 구간도 실리지 않는다 — 추가 전용 이벤트는 뒤늦게 고치지 않는다(§8.1).
  const out = parse(runDriver(`${PRELUDE}
from datetime import datetime, timezone
now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
h = hooks(MULTI)
h.on_call_start("call-A")
first = h.on_transcript("call-A", "user", "요금 문의입니다", usage={"stt_audio_ms": 2400})
# 인지 계층(STT) 장애를 회선이 올린다 — 이 샘플이 없으면 Core 는 엔진 상태를 모른다(§6.2).
h.report_health([{"component": "stt", "state": "down"}], now_iso)
outage = h.on_transcript("call-A", "user", "그럼 상담사", usage={"stt_audio_ms": 300})
ended = h.on_call_end("call-A", billable_ms=48000)
dump(h,
     first_attached=first.usage_attached if first else None,
     outage_attached=outage.usage_attached if outage else None,
     outage_mode=(outage.fallback or {}).get("mode") if outage else None,
     outage_reasons=outage.billing_reasons_ko if outage else None,
     end_recorded=ended.billable_ms_recorded if ended else None)
h.close()
`));
  assert.equal(out.first_attached, true, '실린 턴을 실리지 않았다고 읽으면 누락 건수가 부풀어 멀쩡한 집계를 의심하게 된다');
  assert.equal(out.outage_mode, 'agent_only', '§9.3 판정이 호스트에 닿지 않으면 회선을 내릴 근거가 없다');
  assert.equal(out.outage_attached, false);
  assert.ok(out.outage_reasons.length > 0, 'Core 가 쓴 사유가 호스트에 닿지 않았다');
  assert.equal(out.end_recorded, false, '이미 끝난 세션에 구간이 실렸다고 읽었다');
  // 선언은 전부 했으므로 종전 카운터는 0 이다 — 그것만 보면 "근거 있는 턴 2건"으로 읽힌다.
  assert.equal(out.stats.turns_missing_usage, 0);
  assert.equal(out.stats.ends_missing_billable_ms, 0);
  // 실제로 원장에 없는 것은 이쪽이다.
  assert.equal(out.stats.turns_usage_unattached, 1, '실을 자리가 없어 버려진 실측을 세지 않았다');
  assert.equal(out.stats.ends_billable_ms_unrecorded, 1, '버려진 통화 구간을 세지 않았다');
  assert.equal(out.stats.turns_usage_dropped, 0);
  assert.equal(out.stats.turns_sent, 2);
  // 폴백이 세션을 끝냈다는 사실도 함께 선다 — 그 뒤 턴을 보내면 직전 단계를 되풀이한다.
  assert.equal(out.stats.calls_closed_by_core, 1);
  assert.equal(out.stats.turns_after_core_close, 0);
});

test('§11.2 집계에서 빠진 항목·판정 없음을 누락으로 세지 않는다(실패·경계 경로)', b, () => {
  // 이중 출처·형태 위반은 실제 브리지로 한 번에 만들 수 없다(엔진 기동이 전제다).
  // 판정은 응답을 읽는 일이므로 응답 모양으로 고정한다.
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeResponse

class Canned:
    """턴마다 미리 정한 billing 을 돌려준다. 회선·엔진을 만지지 않는다."""
    def __init__(self, billings):
        self.billings = list(billings)
        self.transcript = None
        self.ends = 0
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def start(self, **kw): return BridgeResponse(id="2", ok=True, result={"interactionId": "i1"})
    def send_utterance(self, i, text, **kw):
        body = {"interactionId": i}
        billing = self.billings.pop(0)
        if billing is not None:
            body["billing"] = billing
        return BridgeResponse(id="3", ok=True, result=body)
    def end(self, i, reason, **kw):
        self.ends += 1
        return BridgeResponse(id="9", ok=True, result={"interactionId": i})
    def close(self): pass

c = Canned([
    {"usageAttached": True, "usageConflicts": ["stt_audio_ms"]},   # 턴은 성공, 수량만 빠졌다
    {"usageAttached": True, "usageRejected": ["channel.gpu_seconds"]},
    None,                                                          # 판정 없음 — 누락이 아니다
    {"usageAttached": "yes"},                                      # 형태 위반 — 모름이다
])
h = CallbotCoreHooks(lambda: c, flow_id="f", on_error=lambda code, m: errors.append(code))
h.on_call_start("c1")
for _ in range(4):
    h.on_transcript("c1", "user", "네", usage={"stt_audio_ms": 100})
h.on_call_end("c1", billable_ms=1000)
json.dump({"stats": h.stats.as_dict(), "errors": errors, "ends": c.ends,
           "degraded": h.degraded, "enabled": h.enabled, "reason": h.disabled_reason_ko,
           "transcript": None}, sys.stdout, ensure_ascii=False)
h.close()
`));
  assert.equal(out.stats.turns_sent, 4);
  assert.equal(out.stats.turns_usage_dropped, 2, '턴은 성공이고 수량만 빠진 건을 세지 않으면 어디에서도 드러나지 않는다');
  // 판정이 없는 응답·형태가 틀린 판정을 "실리지 않았다"로 세면 멀쩡한 턴이 누락으로 집계된다(§13-3).
  assert.equal(out.stats.turns_usage_unattached, 0);
  // 종료 판정이 없는 응답도 같다 — 선언했으니 누락 카운터도 올라가지 않는다.
  assert.equal(out.stats.ends_billable_ms_unrecorded, 0);
  assert.equal(out.stats.ends_missing_billable_ms, 0);
  assert.equal(out.ends, 1);
  assert.deepEqual(out.errors, []);
  assert.equal(out.degraded, false);
});

// ── §6.1 업무시스템 조회 대기 ────────────────────────────────────────────────
// 브리지에는 대기 사실도 결과 경로도 열려 있었지만 **훅 어댑터에는 답할 자리가 없었다**.
// 그 상태에서 Api 노드에 닿은 통화의 증상은 예외가 아니라 무음이다 — 고객이 무슨 말을 해도
// `steps` 0건·`events` 0건이 돌아오고 어떤 알림도 울리지 않는다.

test('§6.1 Api 대기가 선 통화에 조회 결과를 되돌려준다 — 대기 id 는 어댑터가 선언한다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
API_CORE = os.path.join(ROOT, "fixtures", "reference-core-connector.mjs")
def api_factory():
    return BridgeClient(core_module=API_CORE, adapter="callbot", core_root=ROOT, cwd=ROOT,
                        max_line_bytes=65536, keep_transcript=True)
h = CallbotCoreHooks(api_factory, flow_id="f_reference_api", entry_point="inbound_call",
                     on_error=lambda c, m: errors.append(c))
h.on_call_start("c1")
h.on_transcript("c1", "user", "잔액 조회요", usage={"stt_audio_ms": 700})
waiting = h.pending_connector_id("c1")
applied = h.on_connector_result("c1", True, slots={"balance": "10,000원"})
after = h.pending_connector_id("c1")
# 대기가 없는데 또 답한다 — 보내지 않고 알린다(머리말 8번).
again = h.on_connector_result("c1", True)
h.on_call_end("c1", billable_ms=4200)
dump(h, waiting=waiting, after=after,
     applied=applied.connector_result_applied if applied else None,
     applied_status=applied.result["status"] if applied else None,
     again=again is None)
h.close()
`));
  const report = verifyBridgeTranscript(out.transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.verdict, 'passed', JSON.stringify(report.issues));
  assert.equal(out.waiting, 'c_reference_lookup', '호스트가 "부를 차례"를 알 길이 없었다(§6.1)');
  assert.equal(out.after, null, '반영된 뒤에도 대기가 남아 있다고 적혔다');
  assert.equal(out.applied, true);
  assert.equal(out.applied_status, 'completed');
  assert.equal(out.stats.connector_waits, 1);
  assert.equal(out.stats.connector_results_sent, 1);
  assert.equal(out.stats.connector_results_not_applied, 0);
  // 대기를 본 적이 없는데 답한 건은 보내지 않고 센다 — 보내면 성공으로 돌아와 호스트를 속인다.
  assert.equal(out.again, true);
  assert.equal(out.stats.connector_results_unexpected, 1);
  assert.deepEqual(out.errors, ['E_CONNECTOR_NO_WAIT']);
  // **커넥터 결과는 실측 누락으로 세지 않는다**: Core 에 실을 자리가 애초에 없다(§11.2·§13-3).
  assert.equal(out.stats.turns_missing_usage, 0, '실을 자리가 없는 턴이 "근거 없는 턴"으로 집계됐다');
  assert.equal(out.stats.turns_sent, 2);
  const resultLine = out.transcript.requests.find((l) => l.includes('connectorResult'));
  assert.ok(resultLine.includes('"connectorId":"c_reference_lookup"'), `선언이 실리지 않았다: ${resultLine}`);
});

test('§6.1 반영되지 않은 결과를 성공으로 세지 않는다(실패 경로)', b, () => {
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeResponse

class Stale:
    """대기는 서 있다고 말하면서 반영은 거부하는 Core(재전송된 결과의 모양)."""
    def __init__(self):
        self.transcript = None
        self.sent = []
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def start(self, **kw):
        return BridgeResponse(id="2", ok=True, result={
            "interactionId": "i1", "state": {"pendingConnectorId": "c_verify"}})
    def send_connector_result(self, i, ok, **kw):
        self.sent.append(kw.get("connector_id"))
        return BridgeResponse(id="3", ok=True, result={
            "interactionId": i, "state": {"pendingConnectorId": "c_verify"},
            "connector": {"resultApplied": False, "reasonKo": "선언한 커넥터가 서 있는 대기와 다릅니다."}})
    def end(self, i, reason, **kw): return BridgeResponse(id="9", ok=True, result={"interactionId": i})
    def close(self): pass

c = Stale()
h = CallbotCoreHooks(lambda: c, flow_id="f", on_error=lambda code, m: errors.append(code))
h.on_call_start("c1")
res = h.on_connector_result("c1", True, slots={"balance": "0"})
pending = h.pending_connector_id("c1")
h.on_call_end("c1")
json.dump({"transcript": None, "stats": h.stats.as_dict(), "errors": errors,
           "enabled": h.enabled, "degraded": h.degraded, "reason": h.disabled_reason_ko,
           "sent": c.sent, "applied": res.connector_result_applied if res else None,
           "reason_ko": res.connector_reason_ko if res else None, "pending": pending},
          sys.stdout, ensure_ascii=False)
h.close()
`));
  assert.deepEqual(out.sent, ['c_verify'], '어댑터가 본 대기를 선언하지 않았다');
  assert.equal(out.applied, false);
  assert.match(out.reason_ko, /대기/);
  assert.equal(out.stats.connector_results_sent, 1, '보낸 건수는 보낸 건수다');
  assert.equal(out.stats.connector_results_not_applied, 1, '반영되지 않은 건을 세지 않으면 무음이 드러나지 않는다');
  assert.deepEqual(out.errors, ['E_CONNECTOR_NOT_APPLIED']);
  // 대기는 그대로 서 있다 — 호스트는 다시 답할 수 있다(어댑터가 상태를 지어내지 않는다).
  assert.equal(out.pending, 'c_verify');
  // 첫 응답(start)에 이미 대기가 있었으므로 새로 센 대기는 한 건이다.
  assert.equal(out.stats.connector_waits, 1);
});

// ── §9.3 이관·폴백 지시가 도착할 자리 ────────────────────────────────────────
// 판정은 Core 가 끝내고 수행은 호스트가 한다. 응답 원문을 넘겨 두면 저장소마다 각자 파싱하다
// 각자 다르게 틀리는데, 가장 비싼 오답이 **큐에 들어가지 못한 고객에게 "상담사를 연결해
// 드리겠습니다"를 안내하는 것**이다 — 고객은 오지 않는 상담사를 기다리다 끊는다.

test('비동기 훅에도 조회 결과 자리가 있다 — 한쪽만 열면 권장 경로에서만 통화가 멈춘다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
API_CORE = os.path.join(ROOT, "fixtures", "reference-core-connector.mjs")
def api_factory():
    return BridgeClient(core_module=API_CORE, adapter="callbot", core_root=ROOT, cwd=ROOT,
                        max_line_bytes=65536, keep_transcript=True)
async def main():
    h = AsyncCallbotCoreHooks(CallbotCoreHooks(
        api_factory, flow_id="f_reference_api", entry_point="inbound_call",
        on_error=lambda c, m: errors.append(c)))
    await h.on_call_start("call-A")
    await h.on_transcript("call-A", "user", "잔액 조회요")
    waiting = h.pending_connector_id("call-A")
    r = await h.on_connector_result("call-A", True, slots={"balance": "10,000원"})
    await h.on_call_end("call-A", billable_ms=3000)
    await h.drain()
    dump(h.inner, waiting=waiting,
         applied=(r.connector_result_applied if r else None),
         status=(r.result["status"] if r and r.ok else None))
    await h.close()
asyncio.run(main())
`));
  assert.equal(out.waiting, 'c_reference_lookup');
  assert.equal(out.applied, true, 'asyncio 가 권장 경로다 — 여기서 빠지면 음성 통화가 무음으로 멈춘다');
  assert.equal(out.status, 'completed');
  assert.equal(out.stats.connector_results_sent, 1);
  assert.deepEqual(out.errors, []);
});

test('§9.3 이관 지시가 통화당 한 번 도착하고, 큐 배정 "모름"을 못 들어갔다로 적지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
handoffs = []
h = CallbotCoreHooks(factory, flow_id="f_reference_voice", entry_point="inbound_call",
                     on_error=lambda c, m: errors.append(c),
                     on_handoff=lambda cid, p: handoffs.append([cid, p]))
h.on_call_start("c1")
h.on_transcript("c1", "user", "상담사 연결해 주세요")   # n_tr(Transfer) 로 간다
h.on_transcript("c1", "user", "여보세요")               # 끝난 세션의 늦은 전사
h.on_call_end("c1")
dump(h, handoffs=handoffs)
h.close()
`));
  assert.equal(out.handoffs.length, 1, '같은 이관을 턴마다 다시 알렸다(안내·기록이 되풀이된다)');
  assert.equal(out.handoffs[0][0], 'c1');
  assert.equal(out.handoffs[0][1].queue, 'q_default');
  // 라우팅이 배선되지 않은 테넌트에는 판정 자체가 없다 — False 로 적으면 이관 안내가 사라진다(§13-3).
  assert.equal(out.handoffs[0][1].queued, null);
  assert.equal(out.handoffs[0][1].action, null);
  assert.equal(out.stats.handoffs_requested, 1);
  assert.equal(out.stats.handoffs_placement_unknown, 1);
  assert.equal(out.stats.handoffs_not_queued, 0, '모름을 못 들어갔다로 셌다');
  // 상담사용 요약은 어떤 경우에도 넘기지 않는다(§2·§10.3).
  assert.deepEqual(Object.keys(out.handoffs[0][1]).sort(), ['action', 'queue', 'queued']);
});

test('§9.3 큐에 실제로 들어간 건은 들어갔다고 알린다(라우팅 배선 경로)', b, () => {
  const out = parse(runDriver(`${PRELUDE}
MAINT = os.path.join(ROOT, "fixtures", "reference-core-maintained.mjs")
def maint_factory():
    return BridgeClient(core_module=MAINT, adapter="callbot", core_root=ROOT, cwd=ROOT,
                        max_line_bytes=65536, keep_transcript=True)
handoffs = []
h = CallbotCoreHooks(maint_factory, flow_id="f_reference_voice", entry_point="inbound_call",
                     on_error=lambda c, m: errors.append(c),
                     on_handoff=lambda cid, p: handoffs.append(p))
h.on_call_start("c1")
h.on_transcript("c1", "user", "상담사 연결해 주세요")
h.on_call_end("c1")
dump(h, handoffs=handoffs)
h.close()
`));
  assert.equal(out.handoffs.length, 1);
  assert.equal(out.handoffs[0].queued, true, '큐에 들어갔는데 모름으로 읽었다');
  assert.equal(out.stats.handoffs_not_queued, 0);
  assert.equal(out.stats.handoffs_placement_unknown, 0);
});

// ── 유지 루프(§9.3·§2) ──────────────────────────────────────────────────────
// `aicc_bridge.py` 에는 유지 루프 여섯 자리가 다 있었는데 `agent.py` 가 손에 쥐는 것은 이
// 훅 어댑터이고 브리지 클라이언트는 그 안에서 **지연 생성되는 비공개 필드**였다 — 즉 권장
// 경로로 붙인 음성 배치에서는 복구 확인·만료 수렴·readiness·헬스 보고를 부를 방법이 아예
// 없었고 **한 번도 돌지 않았다**. 증상은 하나도 예외가 아니다: 한 번 폴백으로 내려간
// 테넌트는 엔진이 돌아와도 영구히 그대로 남고, `/health` 는 모든 통화가 상담사 직결로
// 떨어진 순간에도 초록이다.

const MAINT_PRELUDE = `${PRELUDE}
MAINT_CORE = os.path.join(ROOT, "fixtures", "reference-core-maintained.mjs")
def maint_hooks(**kw):
    def f():
        return BridgeClient(core_module=MAINT_CORE, adapter="callbot", core_root=ROOT, cwd=ROOT,
                            max_line_bytes=65536, keep_transcript=True)
    return CallbotCoreHooks(f, flow_id="f_reference_voice", entry_point="inbound_call",
                            on_error=lambda c, m: errors.append(c), **kw)
`;

test('§9.3 유지 루프를 훅 어댑터에서 부를 수 있다 — 열린 op 는 돌고 닫힌 op 는 거절된다', b, () => {
  const out = parse(runDriver(`${MAINT_PRELUDE}
h = maint_hooks()
ops = h.maintenance_ops()
w = h.warnings()
r = h.readiness()
p = h.run_recovery_probe()
e = h.run_offer_expiry()
# 브리지가 열지 않은 op — 빈 보고서가 아니라 거절이 와야 한다(§13-3).
o = h.observability()
# 만료는 건별로 받지 않는다(§2) — 허용값 목록을 어댑터가 다시 적지 않으므로 브리지가 거절한다.
t = h.settle_offer("o_reference_1", "tick")
dump(h, ops=ops,
     ok=[bool(x and x.ok) for x in (w, r, p, e)],
     obs_code=(o.error.code if o and o.error else None),
     tick_code=(t.error.code if t and t.error else None),
     has_ready=bool(r and r.ok and isinstance(r.result, dict) and "status" in r.result),
     has_issues=bool(w and w.ok and isinstance(w.result, dict) and isinstance(w.result.get("issues"), list)))
h.close()
`));
  // 무엇이 열렸는지는 찔러 보지 않고 hello 에서 읽는다(§2).
  assert.deepEqual([...out.ops].sort(),
    ['offerExpiry', 'readiness', 'recoveryProbe', 'settleOffer', 'warnings'].sort());
  assert.ok(!out.ops.includes('observability'), '열지 않은 op 가 열린 것으로 보고됐다');
  assert.deepEqual(out.ok, [true, true, true, true], '유지 루프가 어댑터에서 돌지 않는다(§9.3)');
  assert.equal(out.has_ready, true, 'readiness 판정이 호스트에 닿지 않았다');
  assert.equal(out.has_issues, true, '계약 경고 전문이 호스트에 닿지 않았다');
  // 배선 누락은 **실패로 적되 브리지 사망이 아니다** — degraded 로 올리면 유지 루프 설정
  // 하나가 그 프로세스의 모든 통화에서 Core 를 떼어 간다(§9.3).
  assert.equal(out.obs_code, 'E_NOT_WIRED');
  assert.equal(out.tick_code, 'E_BAD_REQUEST');
  assert.equal(out.degraded, false, '유지 루프 거절을 브리지 사망으로 다뤘다');
  assert.equal(out.stats.maintenance_runs, 5, 'hello(목록 조회) + 열린 op 4건');
  assert.equal(out.stats.maintenance_failed, 2);
  assert.equal(out.stats.maintenance_skips, 0);
  assert.deepEqual(out.errors, ['E_NOT_WIRED', 'E_BAD_REQUEST']);
  // 유지 루프는 통화 경로의 카운터를 건드리지 않는다.
  assert.equal(out.stats.turns_sent, 0);
  assert.equal(out.stats.calls_started, 0);
});

test('유지 루프 배선이 전혀 없는 Core 에서는 전부 거절된다 — 조용한 0건으로 적지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks()
ops = h.maintenance_ops()
codes = []
for call in (h.warnings, h.readiness, h.run_recovery_probe, h.run_offer_expiry, h.observability):
    res = call()
    codes.append(res.error.code if res and res.error else None)
codes.append((lambda r: r.error.code if r and r.error else None)(h.settle_offer("o1", "accept")))
dump(h, ops=ops, codes=codes)
h.close()
`));
  assert.deepEqual(out.ops, [], '열지 않은 유지 루프가 열린 것으로 보고됐다');
  assert.deepEqual(out.codes, Array(6).fill('E_NOT_WIRED'),
    '배선 없음을 빈 보고서로 돌려주면 호스트는 "수렴 0건"으로 읽는다(§13-3)');
  assert.equal(out.stats.maintenance_failed, 6);
  assert.equal(out.stats.maintenance_runs, 1, 'hello 한 번만 성공해야 한다');
  assert.equal(out.degraded, false);
});

test('브리지가 죽으면 유지 루프를 보내지 않고 통화 경로와 나눠 센다(§9.3)', b, () => {
  const out = parse(runDriver(`${MAINT_PRELUDE}
h = maint_hooks()
assert h.readiness().ok
h._client._proc.kill(); h._client._proc.wait()
dead = h.readiness()                    # 끊김은 예외가 아니라 None
assert dead is None and h.degraded is True
assert h.run_recovery_probe() is None   # 이후로는 보내지 않는다
assert h.run_offer_expiry() is None
assert h.on_call_start("c1") is None    # 통화 경로는 degraded_skips 로 센다
dump(h)
h.close()
`));
  assert.equal(out.degraded, true);
  // 유지 루프 주기는 초 단위일 수 있다 — 통화 경로와 합쳐 세면 "통화가 Core 를 잃은 횟수"가
  // 그 주기만큼 부풀어 읽을 수 없게 된다.
  assert.equal(out.stats.maintenance_skips, 2);
  assert.equal(out.stats.degraded_skips, 1);
  assert.equal(out.stats.maintenance_runs, 1);
  assert.deepEqual(out.errors, ['E_BRIDGE_DOWN'], '끊김은 정확히 한 번 보고한다');
});

// ── §9.3 헬스 보고 — 보냈다 ≠ 접수됐다 ─────────────────────────────────────
// 음성의 L1 은 `telephony` 이고 그 상태를 아는 것은 회선뿐이다(Core 는 매체를 직접 찌르지
// 않는다, §6.2). 보고할 자리가 없던 동안 음성 배치의 §9.3 레지스트리에는 회선 샘플이 한 건도
// 없었고, 그러면 `treatUnknownAsDown` 에 따라 결말이 둘인데 둘 다 조용하다.

test('§9.3 헬스를 올리고 접수 범위를 나눠 센다 — 보낸 수를 접수된 수로 읽지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks()
res = h.report_health(
    [{"component": "telephony", "state": "up"},
     {"component": "messaging", "state": "up"}],   # 음성이 의존하지 않는 컴포넌트 — 버려진다
    "2026-10-25T00:00:00.000Z")
dump(h, offered=res.health_offered, accepted=res.health_accepted, ignored=res.health_ignored,
     registered=res.health_registered, known=res.health_intake_known,
     declared=res.health_declared, reason_ko=res.health_reason_ko)
h.close()
`));
  assert.equal(out.known, true);
  assert.equal(out.registered, true);
  assert.equal(out.offered, 2);
  // 선언되지 않은 컴포넌트의 샘플은 조용히 버려진다 — 그 응답도 `ok: True` 다(§9.3).
  assert.equal(out.accepted, 1, '올린 수를 접수된 수로 읽으면 유실이 정상으로 집계된다');
  assert.equal(out.ignored, 1);
  assert.equal(out.reason_ko, null);
  // 호스트가 보낸 이름은 되돌려 오지 않는다(§10.3) — Core 가 가진 선언 목록이 온다.
  assert.ok(out.declared.includes('telephony'));
  assert.ok(!out.declared.includes('messaging'));
  assert.equal(out.stats.health_reports_sent, 1);
  assert.equal(out.stats.health_samples_offered, 2);
  assert.equal(out.stats.health_samples_accepted, 1);
  assert.equal(out.stats.health_samples_ignored, 1);
  assert.equal(out.stats.health_intake_unknown, 0);
  assert.deepEqual(out.errors, ['E_HEALTH_UNDECLARED_COMPONENT'],
    '버려진 샘플을 조용히 두면 선언 오타가 영구히 남는다');
});

test('§9.3 접수 범위를 알 수 없는 응답을 접수됨으로 세지 않는다(실패·경계 경로)', b, () => {
  // 접수 범위를 돌려주지 않는 Core 구현(종전 `void` 반환)과, 형태가 틀린 응답.
  // 둘 다 "모름"이며 0 도 offered 도 아니다 — 0 으로 읽으면 멀쩡한 보고가 전부 유실로,
  // offered 로 읽으면 한 건도 닿지 않는 상태가 정상으로 집계된다(§13-3).
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeError, BridgeResponse

class Intake:
    def __init__(self, bodies):
        self.bodies = list(bodies)
        self.transcript = None
        self.sent = 0
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def report_health(self, samples, observed_at):
        self.sent += 1
        body = self.bodies.pop(0)
        if body is None:
            return BridgeResponse(id="2", ok=False, error=BridgeError("E_BAD_REQUEST", "형태 위반"))
        return BridgeResponse(id="2", ok=True, result=body)
    def close(self): pass

c = Intake([
    {"offered": 3, "acceptedKnown": False,
     "reasonKo": "Core 구현이 접수 범위를 돌려주지 않습니다."},        # 모름
    {"registered": False, "offered": 2, "accepted": 0, "ignored": 0,
     "declared": [], "acceptedKnown": True},                           # 미등록 — 한 건도 없다
    {"offered": "3", "accepted": True, "acceptedKnown": True},          # 형태 위반 — 세지 않는다
    None,                                                               # 거절
])
h = CallbotCoreHooks(lambda: c, flow_id="f", on_error=lambda code, m: errors.append(code))
reads = []
for _ in range(4):
    r = h.report_health([{"component": "telephony", "state": "up"}], "2026-10-25T00:00:00.000Z")
    reads.append([r.health_intake_known, r.health_accepted, r.health_offered] if r else None)
json.dump({"transcript": None, "stats": h.stats.as_dict(), "errors": errors,
           "enabled": h.enabled, "degraded": h.degraded, "reason": h.disabled_reason_ko,
           "reads": reads, "sent": c.sent}, sys.stdout, ensure_ascii=False)
h.close()
`));
  assert.equal(out.sent, 4);
  assert.deepEqual(out.reads[0], [false, null, 3], '모름을 0 으로 읽었다(§13-3)');
  assert.deepEqual(out.reads[1], [true, 0, 2]);
  assert.deepEqual(out.reads[2], [true, null, null], '형태 위반을 숫자로 읽었다');
  assert.equal(out.reads[3][0], null, '거절된 보고에 접수 범위가 있다고 읽었다');
  assert.equal(out.stats.health_reports_sent, 3, '거절된 보고를 보냈다고 셌다');
  assert.equal(out.stats.health_intake_unknown, 1);
  // 미등록 보고의 offered 는 실측이다(2) — 모름 응답의 3 과 합쳐 5 가 되고 accepted 는 0 이다.
  assert.equal(out.stats.health_samples_offered, 5);
  assert.equal(out.stats.health_samples_accepted, 0, '접수되지 않은 샘플을 접수됨으로 셌다');
  assert.equal(out.stats.health_samples_ignored, 0);
  assert.equal(out.stats.maintenance_failed, 1);
  assert.equal(out.degraded, false, '헬스 거절을 브리지 사망으로 다뤘다');
  assert.deepEqual(out.errors, ['E_HEALTH_NOT_REGISTERED', 'E_BAD_REQUEST']);
});

test('§9.3 헬스 한도 초과는 장애가 아니며 통화의 대기와 섞이지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeError, BridgeResponse

class HealthLimited:
    def __init__(self):
        self.sent = 0
        self.transcript = None
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def start(self, **kw): return BridgeResponse(id="2", ok=True, result={"interactionId": "i1"})
    def send_utterance(self, i, text, **kw): return BridgeResponse(id="3", ok=True, result={})
    def report_health(self, samples, observed_at):
        self.sent += 1
        return BridgeResponse(id="4", ok=False, error=BridgeError("E_RATE_LIMITED", "한도", 5000))
    def end(self, i, reason, **kw): return BridgeResponse(id="9", ok=True, result={})
    def close(self): pass

now = [0.0]
c = HealthLimited()
h = CallbotCoreHooks(lambda: c, flow_id="f", monotonic=lambda: now[0],
                     on_error=lambda code, m: errors.append(code))
sample = [{"component": "telephony", "state": "up"}]
h.report_health(sample, "t0")      # 거절 → 대기 시작
h.report_health(sample, "t1")      # 대기 중 → 보내지 않는다
# 헬스 대기가 통화를 막지 않는다 — 막으면 샘플 주기 하나가 통화를 멈춘다.
h.on_call_start("c1")
turn = h.on_transcript("c1", "user", "여보세요")
now[0] += 6.0
h.report_health(sample, "t2")      # 대기가 풀렸다
h.on_call_end("c1")
json.dump({"transcript": None, "stats": h.stats.as_dict(), "errors": errors,
           "enabled": h.enabled, "degraded": h.degraded, "reason": h.disabled_reason_ko,
           "sent": c.sent, "turn_ok": bool(turn and turn.ok)}, sys.stdout, ensure_ascii=False)
h.close()
`));
  assert.equal(out.sent, 2, '대기 중에도 헬스를 보냈다(또는 대기가 안 풀렸다)');
  assert.equal(out.stats.health_reports_rate_limited, 2);
  assert.equal(out.stats.health_reports_deferred, 1);
  assert.equal(out.stats.health_reports_sent, 0);
  assert.equal(out.degraded, false, '한도 초과를 브리지 사망으로 다뤘다');
  // 헬스 대기와 통화 대기는 다른 변수다 — 섞으면 폭주가 §9.3 샘플까지 멈춘다.
  assert.equal(out.turn_ok, true);
  assert.equal(out.stats.turns_deferred, 0);
  assert.equal(out.stats.calls_ended, 1);
  assert.deepEqual(out.errors, ['E_RATE_LIMITED', 'E_RATE_LIMITED']);
});

// ── 브리지 사망 래치 해제(§9.3) ─────────────────────────────────────────────
// `degraded` 는 한 번 서면 프로세스가 끝날 때까지 풀리지 않았다 — 음성 에이전트는 며칠을
// 산다. 줄 하나를 깨뜨린 일시적 예외가 그 프로세스의 **남은 모든 통화**에서 Core 를 떼어
// 가고, 그 상태는 조용하다: 통화는 정상으로 끝나고 원장·과금 근거·이벤트만 0건이 된다.

test('recover() 가 래치를 풀고 다음 통화는 새 브리지에서 돈다 — 멀쩡한 브리지는 건드리지 않는다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
h = hooks(MULTI)
# 멀쩡한 상태에서는 풀 것이 없다. 여기서 내리면 진행 중인 세션이 통째로 사라진다.
healthy = h.recover()
h.on_call_start("c1")
h.on_transcript("c1", "user", "첫 턴")
h._client._proc.kill(); h._client._proc.wait()
assert h.on_transcript("c1", "user", "죽은 뒤") is None
assert h.degraded is True
assert h.readiness() is None
first = h.recover()
again = h.recover()                     # 멱등 — 풀 것이 없다
assert h.degraded is False
new_id = h.on_call_start("c2")
turn = h.on_transcript("c2", "user", "새 브리지")
# 장애를 건너 살아 있던 통화는 새 브리지가 모르는 세션이다 — 사실대로 실패해야 한다.
stale = h.on_transcript("c1", "user", "예전 세션")
h.on_call_end("c2")
dump(h, healthy=healthy, first=first, again=again,
     new_ok=bool(new_id), turn_ok=bool(turn and turn.ok),
     stale_ok=(None if stale is None else stale.ok))
h.close()
`));
  assert.equal(out.healthy, false, '멀쩡한 브리지를 내렸다 — 진행 중인 세션이 사라진다');
  assert.equal(out.first, true, '래치를 풀 길이 없다 — 남은 모든 통화가 Core 를 잃는다');
  assert.equal(out.again, false, 'recover() 가 멱등하지 않다');
  assert.equal(out.degraded, false);
  assert.equal(out.new_ok, true, '복구 뒤 새 통화가 Core 에 붙지 못했다');
  assert.equal(out.turn_ok, true);
  assert.equal(out.stats.bridge_recoveries, 1);
  assert.equal(out.stats.calls_open_at_recovery, 1, '장애를 건너 열려 있던 통화를 세지 않았다');
  // **상태를 지어내지 않는다**: 끝나지 않은 통화를 "끝났다"로 적으면 그 턴은 조용히 버려지고
  // 종료는 중복으로 집계된다 — 둘 다 일어나지 않은 일이다(§13-3).
  assert.equal(out.stale_ok, false, '모르는 세션의 턴이 성공으로 돌아왔다');
  assert.equal(out.stats.late_after_end, 0, '끝나지 않은 통화를 끝났다고 적었다');
  assert.equal(out.stats.turns_failed, 1);
  assert.equal(out.stats.calls_started, 2);
  assert.equal(out.stats.maintenance_skips, 1);
});

test('비동기 호스트에도 유지 루프·복구 자리가 있다 — 한쪽만 열면 권장 경로에서만 사라진다', b, () => {
  const out = parse(runDriver(`${MAINT_PRELUDE}
async def main():
    h = AsyncCallbotCoreHooks(maint_hooks())
    ops = await h.maintenance_ops()
    r = await h.readiness()
    p = await h.run_recovery_probe()
    hl = await h.report_health([{"component": "telephony", "state": "up"}],
                               "2026-10-25T00:00:00.000Z")
    healthy = await h.recover()
    # 통화와 유지 루프가 같은 체인에 묶이면 턴이 복구 확인을 기다리게 된다 — 묶지 않는다.
    await h.on_call_start("c1")
    await asyncio.gather(h.on_transcript("c1", "user", "하나"), h.run_offer_expiry())
    await h.on_call_end("c1", "통화 종료", 1000)
    await h.drain()
    dump(h.inner, ops=ops, ready_ok=bool(r and r.ok), probe_ok=bool(p and p.ok),
         accepted=(hl.health_accepted if hl else None), healthy=healthy,
         degraded_prop=h.degraded, stats_prop=h.stats.turns_sent)
    await h.close()
asyncio.run(main())
`));
  assert.ok(out.ops.includes('recoveryProbe'), 'asyncio 가 권장 경로다 — 여기서 빠지면 음성 전체에서 폴백이 풀리지 않는다');
  assert.equal(out.ready_ok, true);
  assert.equal(out.probe_ok, true);
  assert.equal(out.accepted, 1, '비동기 호스트의 헬스 보고가 접수되지 않았다');
  assert.equal(out.healthy, false, '멀쩡한 브리지를 내렸다');
  assert.equal(out.degraded_prop, false);
  assert.equal(out.stats_prop, 1, '비동기 래퍼가 실측 카운터를 노출하지 않는다');
  assert.equal(out.stats.maintenance_runs, 4, 'hello + readiness + recoveryProbe + offerExpiry');
  assert.equal(out.stats.health_reports_sent, 1);
  assert.equal(out.stats.turns_sent, 1);
  assert.equal(out.stats.calls_ended, 1);
  assert.deepEqual(out.errors, []);
});

test('§9.3 폴백 지시는 모드가 바뀐 턴에만 알린다(경계 경로)', b, () => {
  const out = parse(runDriver(`${PRELUDE}
from aicc_bridge import BridgeResponse

class Modes:
    """턴마다 미리 정한 §9.3 판정을 돌려준다. 회선·엔진을 만지지 않는다."""
    def __init__(self, modes):
        self.modes = list(modes)
        self.transcript = None
    def hello(self): return BridgeResponse(id="1", ok=True, result={})
    def start(self, **kw): return BridgeResponse(id="2", ok=True, result={"interactionId": "i1"})
    def send_utterance(self, i, text, **kw):
        body = {"interactionId": i}
        mode = self.modes.pop(0)
        if mode is not None:
            body["fallback"] = {"mode": mode, "disable": ["llm"]}
        return BridgeResponse(id="3", ok=True, result=body)
    def end(self, i, reason, **kw): return BridgeResponse(id="9", ok=True, result={"interactionId": i})
    def close(self): pass

seen = []
c = Modes([None, "degraded_ai", "degraded_ai", None])
h = CallbotCoreHooks(lambda: c, flow_id="f", on_error=lambda code, m: errors.append(code),
                     on_fallback=lambda cid, mode, disable: seen.append([mode, list(disable)]))
h.on_call_start("c1")
for _ in range(4):
    h.on_transcript("c1", "user", "네")
h.on_call_end("c1")
json.dump({"transcript": None, "stats": h.stats.as_dict(), "errors": errors,
           "enabled": h.enabled, "degraded": h.degraded, "reason": h.disabled_reason_ko,
           "seen": seen}, sys.stdout, ensure_ascii=False)
h.close()
`));
  // 정상 턴에는 아무 지시도 없다 — 없는 판정을 알리지 않는다(§13-3).
  assert.deepEqual(out.seen, [['degraded_ai', ['llm']], ['normal', []]],
    '같은 모드를 턴마다 다시 알리면 호스트는 같은 안내를 반복한다');
  assert.equal(out.stats.fallback_changes, 2);
  assert.deepEqual(out.errors, []);
});

// ── §10.1 고지·동의 · §7 5.2 준수 점검 ──────────────────────────────────────
// 세 칸은 판정이 아니라 **남길 근거**라서 Core 는 노출 스위치와 무관하게 내보내는데, 읽을
// 자리가 없던 동안 세 사실은 음성 호스트에 한 번도 도착하지 않았다: 고지 감사 근거는 `steps`
// 안에만 있고, 필수 동의 미획득(= pii 조회가 막힌다)은 "그 메뉴만 안 된다"로만 나타나고,
// `reviewed: False`(점검 못 함)와 요약 없음(점검 미배선)은 "위반 없음"과 구분되지 않았다.

test('§10.1 고지·동의와 §7 5.2 점검이 훅으로 도착한다 — 서 있는 값은 바뀐 턴에만 알린다', b, () => {
  const out = parse(runDriver(`${PRELUDE}
GOV = os.path.join(ROOT, "fixtures", "reference-core-governed.mjs")
def gov_factory():
    return BridgeClient(core_module=GOV, adapter="callbot", core_root=ROOT, cwd=ROOT,
                        max_line_bytes=65536, keep_transcript=True)
disclosures, consents, compliances = [], [], []
h = CallbotCoreHooks(gov_factory, flow_id="f_reference_voice", entry_point="inbound_call",
                     on_error=lambda c, m: errors.append(c),
                     on_disclosure=lambda cid, p: disclosures.append([cid, p]),
                     on_consent=lambda cid, p: consents.append([cid, dict(p, pending_required=list(p["pending_required"]))]),
                     on_compliance=lambda cid, p: compliances.append([cid, {"reviewed": p["reviewed"],
                                                                            "violations": list(p["violations"]),
                                                                            "skipped": list(p["skipped"]),
                                                                            "reason_ko": p["reason_ko"]}]))
h.on_call_start("c1")
h.on_transcript("c1", "user", "네")              # 녹취 동의 확정
h.on_transcript("c1", "user", "요금 문의입니다")  # 서 있는 값은 그대로 — 다시 알리지 않는다
h.on_call_end("c1")
h.on_call_end("c1")                              # 두 번째 종료 — 점검을 다시 알리지 않는다
dump(h, disclosures=disclosures, consents=consents, compliances=compliances)
h.close()
`));
  // 고지는 나간 턴에만 — 감사 근거는 판정된 값만 넘긴다(문구는 이미 고객에게 나갔다).
  assert.equal(out.disclosures.length, 1, '고지 근거를 턴마다 알리면 "몇 번 고지했는가"가 부푼다');
  assert.equal(out.disclosures[0][0], 'c1');
  assert.deepEqual(out.disclosures[0][1], { channel: 'voice', placement: 'session_start', config_version: 3 });
  assert.equal(out.stats.disclosures_seen, 1);

  // 동의: 미획득 목록이 선 턴(start)과 동의가 확정된 턴 두 번만 알린다.
  assert.equal(out.consents.length, 2, '서 있는 미획득 목록을 턴마다 알리면 같은 안내가 되풀이된다');
  assert.deepEqual(out.consents[0][1].pending_required, ['recording']);
  assert.equal(out.consents[0][1].recorded, null);
  assert.deepEqual(out.consents[1][1].recorded, { purpose: 'recording', state: 'granted', policyVersion: 2 });
  assert.deepEqual(out.consents[1][1].pending_required, [], '동의를 받았는데 미획득으로 남겼다');
  assert.equal(out.consents[1][1].not_recorded_ko, null);
  assert.equal(out.stats.consents_recorded, 1);
  assert.equal(out.stats.consents_not_recorded, 0);
  assert.equal(out.stats.calls_pending_consent, 1, '미획득 동의가 있던 통화는 pii 조회가 막힌다 — 세지 않으면 신호가 없다');
  assert.equal(out.stats.consent_pending_changes, 2);

  // 점검은 통화당 한 번. 끝난 세션의 응답에는 요약이 계속 실려 온다.
  assert.equal(out.compliances.length, 1, '같은 점검 결과를 두 번째 종료에서 다시 알렸다');
  assert.equal(out.compliances[0][1].reviewed, true);
  assert.deepEqual(out.compliances[0][1].violations, []);
  assert.deepEqual(out.compliances[0][1].skipped, []);
  assert.equal(out.compliances[0][1].reason_ko, null);
  assert.equal(out.stats.compliance_reviewed_calls, 1);
  assert.equal(out.stats.compliance_unreviewed_calls, 0);
  assert.equal(out.stats.ends_without_compliance, 0);
  // 동의 주체 참조는 어떤 경로로도 호스트에 오지 않는다(§10.3).
  assert.equal(JSON.stringify(out).includes('sha256:reference-subject'), false);
  assert.deepEqual(out.errors, []);
});

test('고지·동의·점검이 배선되지 않은 Core 에서는 조용한 "위반 없음"이 아니라 미배선 건수다(실패 경로)', b, () => {
  // `reference-core.mjs` 는 통화 경로만 꿰므로 세 칸이 응답에 아예 실리지 않는다.
  // 그것을 "고지했다·동의를 다 받았다·위반 없음"으로 적으면 §13-3 위반이다.
  const out = parse(runDriver(`${PRELUDE}
disclosures, consents, compliances = [], [], []
h = hooks(on_disclosure=lambda cid, p: disclosures.append(p),
          on_consent=lambda cid, p: consents.append(p),
          on_compliance=lambda cid, p: compliances.append(p))
h.on_call_start("c1")
h.on_transcript("c1", "user", "요금 문의입니다")
h.on_call_end("c1")
dump(h, disclosures=disclosures, consents=consents, compliances=compliances)
h.close()
`));
  assert.deepEqual(out.disclosures, [], '없는 고지를 알렸다');
  assert.deepEqual(out.consents, [], '빈 목록을 "다 받았다"로 알렸다');
  assert.deepEqual(out.compliances, [], '요약이 없는데 점검 결과를 알렸다');
  assert.equal(out.stats.disclosures_seen, 0, '0 이 곧 "어떤 통화에도 고지가 나가지 않았다"의 신호다');
  assert.equal(out.stats.consents_recorded, 0);
  assert.equal(out.stats.calls_pending_consent, 0, '동의 미배선을 "미획득 통화"로 세면 고칠 곳이 바뀐다');
  assert.equal(out.stats.compliance_reviewed_calls, 0);
  assert.equal(out.stats.compliance_unreviewed_calls, 0, '요약 없음을 "점검 못 했다"로 셌다 — 둘은 다른 상태다');
  assert.equal(out.stats.ends_without_compliance, 1, '§7 미배선의 유일한 와이어 신호를 세지 않았다');
  assert.deepEqual(out.errors, []);
});

// ── §5.2 화면 전환 지시(2026-10-28) ──────────────────────────────────────────
// 전환은 §5.1 사다리가 고르고 **링크 발송은 호스트가** 한다. Node 호스트는 `port.invite` 로
// 그 지시를 받지만 비-Node 호스트에 닿는 자리는 턴 응답 하나뿐이고, 읽을 자리가 없던 동안
// 전환은 **조용히 반쪽만** 일어났다: 이후 단계는 화면용으로 렌더되는데(통화 중인 고객이
// 그것을 듣는다) 링크는 아무도 보내지 않고, 사다리는 이미 전환을 골랐으므로 상담사로도
// 내려가지 않는다. 어디에서도 예외가 나지 않는다.

const SWITCH_PRELUDE = `${PRELUDE}
SW = os.path.join(ROOT, "fixtures", "reference-core-switch.mjs")
def sw_factory(ticket):
    return lambda: BridgeClient(core_module=SW, adapter="callbot", core_root=ROOT, cwd=ROOT,
                                max_line_bytes=65536, keep_transcript=True,
                                include_switch_ticket=ticket)
switches = []
def sw_hooks(ticket, **kw):
    return CallbotCoreHooks(sw_factory(ticket), flow_id="f_reference_voice",
                            entry_point="inbound_call", on_error=lambda c, m: errors.append(c),
                            on_switch=lambda cid, p: switches.append([cid, dict(p)]), **kw)
`;

test('§5.2 전환 초대가 훅으로 도착한다 — 토큰 노출을 켠 호스트는 링크를 만들 수 있다', b, () => {
  const out = parse(runDriver(`${SWITCH_PRELUDE}
h = sw_hooks(True)
h.on_call_start("c1")
h.on_timeout("c1")      # 1회 실패 → 재프롬프트
h.on_timeout("c1")      # 2회 실패 → 화면 전환(§5.1)
h.on_timeout("c1")      # 3회 실패 → 상담사 이관. 전환은 다시 실리지 않는다
dump(h, switches=switches)
h.close()
`));
  assert.equal(out.switches.length, 1, '전환을 턴마다 알리면 호스트가 링크를 여러 번 보낸다');
  const [callId, p] = out.switches[0];
  assert.equal(callId, 'c1');
  assert.equal(p.from_channel, 'voice');
  assert.equal(p.to_channel, 'visual');
  assert.equal(p.ticket_issued, true);
  assert.equal(p.token_included, true);
  assert.equal(p.token, 'tk_reference_1', '토큰이 오지 않으면 호스트는 id 로 링크를 만들 수밖에 없다(§10.3)');
  assert.ok(typeof p.expires_at === 'string' && p.expires_at.length > 0, '만료를 모르면 안내할 수 없다');
  assert.equal(p.tokenless, false);
  assert.equal(p.not_issued_ko, null);
  assert.equal(out.stats.switch_invites_seen, 1);
  assert.equal(out.stats.switch_tokens_received, 1);
  assert.equal(out.stats.switch_tokens_withheld, 0);
  assert.equal(out.stats.switch_tokenless, 0);
  assert.equal(out.stats.switch_tickets_unissued, 0);
  assert.deepEqual(out.errors, []);
});

test('토큰 노출이 꺼져 있으면 사실만 오고 토큰은 어떤 경로로도 오지 않는다(§10.3)', b, () => {
  // 끈 쪽이 기본이다. 그 상태에서도 **전환 사실은 와야 한다** — 감추면 호스트는 "링크를 보낼
  // 차례"도 "보낼 수 없는 상태"도 알 수 없다. 건수를 나눠 두는 이유가 여기다: 이 수는
  // "스위치를 켜라"이고 아래 검사의 수는 "Core 쪽 배선이 없다"다(고칠 곳이 다른 저장소다).
  const out = parse(runDriver(`${SWITCH_PRELUDE}
h = sw_hooks(False)
h.on_call_start("c1")
h.on_timeout("c1")
h.on_timeout("c1")
dump(h, switches=switches)
h.close()
`));
  assert.equal(out.switches.length, 1);
  const p = out.switches[0][1];
  assert.equal(p.ticket_issued, true, '발급은 됐다 — 그 사실을 감추면 전환 품질을 집계할 수 없다');
  assert.equal(p.token_included, false);
  assert.equal(p.token, null);
  assert.equal(p.to_channel, 'visual');
  assert.equal(out.stats.switch_tokens_withheld, 1);
  assert.equal(out.stats.switch_tokens_received, 0);
  assert.equal(out.stats.switch_tokenless, 0, '노출 스위치 문제를 Core 미배선으로 적으면 고칠 곳이 바뀐다');
  assert.equal(JSON.stringify(out).includes('tk_reference'), false, '1회용 열쇠가 응답·전사에 실렸다');
});

test('전환 배선이 없는 Core 에서는 "토큰 없는 초대"로 온다 — 토큰을 지어내지 않는다(실패 경로)', b, () => {
  // `reference-core.mjs` 에는 전환 배선이 없다. 그 상태의 링크는 **id 가 곧 열쇠**이며,
  // 그것을 "토큰을 못 받았다"와 같게 적으면 호스트 스위치를 뒤지다 Core 설정을 놓친다.
  const out = parse(runDriver(`${PRELUDE}
switches = []
h = hooks(on_switch=lambda cid, p: switches.append([cid, dict(p)]))
h.on_call_start("c1")
h.on_timeout("c1")
h.on_timeout("c1")
dump(h, switches=switches)
h.close()
`));
  assert.equal(out.switches.length, 1);
  const p = out.switches[0][1];
  assert.equal(p.tokenless, true);
  assert.equal(p.ticket_issued, false);
  assert.equal(p.token, null, '없는 토큰을 만들어 넣었다(§13-3)');
  assert.equal(p.expires_at, null, '만료 없는 링크를 "만료 있음"으로 적었다');
  assert.equal(out.stats.switch_tokenless, 1);
  assert.equal(out.stats.switch_invites_seen, 1);
  assert.equal(out.stats.switch_tokens_withheld, 0);
  assert.deepEqual(out.errors, [], '종전 상태는 등록 시점 경고(W_CHANNEL_SWITCH_UNBOUND)가 이미 적는다');
});

// ── Core 가 먼저 닫은 세션(2026-10-28) ───────────────────────────────────────
// 세션을 끝내는 주체가 호스트만이 아니다 — End 노드 도달·재시도 소진 이관·Api 순회 상한·
// 장애 폴백은 Core 가 그 턴에서 닫는다. 닫힌 세션에 온 입력은 **오류가 아니라 멱등 처리**라
// `ok: True`·events 0건이고 직전 턴의 단계가 그대로 실려 온다 — 그래서 읽지 않으면 증상이
// 둘로 갈리고 둘 다 조용하다(안내 반복 · 무음).

test('Core 가 닫은 세션에는 더 보내지 않고 통화당 한 번 알린다(§5.3·§8.1)', b, () => {
  const out = parse(runDriver(`${PRELUDE}
closed = []
h = hooks(on_session_closed=lambda cid, st: closed.append([cid, st]))
h.on_call_start("c1")
h.on_transcript("c1", "user", "잔액 조회요")   # 수집 완료 → Transfer → Core 가 세션을 닫는다
assert h.on_dtmf("c1", "1") is None            # 보내지 않는다
assert h.on_transcript("c1", "user", "여보세요") is None
r = h.on_call_end("c1", billable_ms=12000.0)   # 종료는 그대로 보낸다
assert r is not None and r.ok
dump(h, closed=closed)
h.close()
`));
  const report = verifyBridgeTranscript(out.transcript, { adapter: 'callbot', maxLineBytes: 65536 });
  assert.equal(report.verdict, 'passed', JSON.stringify(report.issues));
  assert.equal(report.opCounts.send, 1, '닫힌 세션에 보낸 턴은 직전 단계를 되풀이해 돌려받는다');
  assert.equal(report.opCounts.end, 1, '종료는 미루지 않는다 — 닫혔어도 과금 근거 판정을 받아야 한다');
  assert.deepEqual(out.closed, [['c1', 'transferred']], 'Core 가 적은 상태를 그대로 넘긴다');
  assert.equal(out.stats.calls_closed_by_core, 1);
  assert.equal(out.stats.turns_after_core_close, 2);
  assert.equal(out.stats.turns_sent, 1);
  assert.equal(out.stats.late_after_end, 0, '호스트가 닫은 것이 아니다 — 합쳐 세면 고칠 곳이 바뀐다');
  assert.equal(out.stats.calls_ended, 1);
  assert.deepEqual(out.errors, []);
});

test('열려 있는 세션을 닫혔다고 적지 않는다 — 모름도 닫힘이 아니다(§13-3)', b, () => {
  const out = parse(runDriver(`${PRELUDE}
closed = []
h = hooks(MULTI, on_session_closed=lambda cid, st: closed.append([cid, st]))
h.on_call_start("c1")
h.on_timeout("c1")                              # 무입력 1회 — 재프롬프트이고 세션은 열려 있다
r = h.on_dtmf("c1", "1")                        # 수집 노드가 이어져 있어 아직 끝나지 않는다
assert r is not None and r.ok
# 유지 루프·헬스 응답에는 상태 칸이 없다 — 그것을 닫힘으로 읽으면 통화가 Core 를 잃는다.
hr = h.report_health([{"component": "telephony", "state": "up"}], "2026-10-28T00:00:00.000Z")
assert hr is not None and hr.session_closed is None
dump(h, closed=closed)
h.close()
`));
  assert.deepEqual(out.closed, []);
  assert.equal(out.stats.calls_closed_by_core, 0);
  assert.equal(out.stats.turns_after_core_close, 0, '열린 세션의 턴을 보내지 않으면 통화가 멈춘다');
  assert.equal(out.stats.turns_sent, 2);
  assert.deepEqual(out.errors, []);
});
