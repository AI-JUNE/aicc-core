# -*- coding: utf-8 -*-
"""AICC Core 브리지 파이썬 참조 클라이언트 (표준 라이브러리만 사용).

설계서 §1.2(Core 단일화)·§2(시나리오 단일화)·§9.3(폴백)·§10.3(마스킹)·§11.1(테넌트 격리)·§13-3(실측만).

왜 이 파일이 있는가
-------------------
Callbot 의 음성 에이전트는 파이썬 프로세스다. Node 로 된 채널 계약(basePort)을 import 할 방법이
없어서, 지금까지 Core 를 소비하는 채널은 셋 중 둘뿐이었다. 음성은 가장 먼저 갈라지는 채널이라
(DTMF·무음·재발화) 여기서 갈라지면 시나리오 이중 관리가 그대로 재발한다.
그래서 언어 중립 경로(JSONL 브리지)를 열었고, 이 파일이 그 경로의 **참조 구현**이다.
저장소는 이 파일을 그대로 복사해 쓰거나, 이걸 보고 자기 언어로 30줄을 쓰면 된다.

이 클라이언트가 지키는 것 (전부 "빠지면 사고가 나는" 지점이다)
--------------------------------------------------------------
1. **테넌트를 주장하지 않는다.** start 요청에 scope 를 싣지 않는다. 테넌트는 브리지 설정이 정한다(§11.1).
2. **id 로 응답을 상관짓는다.** 순서만 믿지 않는다. 어긋나면 조용히 넘어가지 않고 오류다.
3. **어떤 응답도 예외로 바꾸지 않는다.** 회선 하나의 이상한 줄이 통화 전체를 끊으면 안 된다.
   호출자는 `BridgeResponse.ok` 를 본다.
4. **발화 원문·슬롯 값·상담사용 요약을 로깅하지 않는다.** 이 파일은 어떤 것도 print 하지 않는다(§10.3).
5. **세션을 반드시 닫는다.** `session()` 컨텍스트 매니저는 예외 경로에서도 end 를 부른다 —
   닫히지 않은 세션은 장애가 아니라 집계·요금으로 먼저 나타난다.
6. **기본값을 만들어 넣지 않는다.** 타임아웃·줄 상한을 주지 않으면 그 검사를 하지 않는다(§13-3).

무엇을 하지 않는가 (build now, activate on approval)
---------------------------------------------------
회선·소켓·TTS/STT 를 만지지 않는다. 브리지는 기본 dry_run 이며 live 는 **[승인 필요]** 다.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Sequence

__all__ = [
    "BridgeError",
    "BridgeResponse",
    "BridgeClient",
    "BridgeProtocolError",
]

PROTOCOL_VERSION = 1


class BridgeProtocolError(RuntimeError):
    """프로토콜 자체가 성립하지 않을 때만 던진다(프로세스 사망·응답 상관 실패).

    개별 요청 실패는 예외가 아니라 ok=False 응답이다 — 통화를 끊지 않기 위해서다.
    """


@dataclass(frozen=True)
class BridgeError:
    code: str
    message_ko: str


@dataclass(frozen=True)
class BridgeResponse:
    id: Optional[str]
    ok: bool
    result: Any = None
    error: Optional[BridgeError] = None

    @property
    def interaction_id(self) -> Optional[str]:
        if self.ok and isinstance(self.result, dict):
            value = self.result.get("interactionId")
            if isinstance(value, str) and value:
                return value
        return None


@dataclass
class _Transcript:
    """보낸 줄과 받은 줄. CI 에서 `scripts/bridge-transcript.mjs` 로 검증한다.

    발화 원문이 들어 있을 수 있으므로 **파일로 남기는 것은 호출자의 판단**이며,
    기본적으로 메모리에만 둔다. 운영 통화 기록을 그대로 저장하지 않는다(§10.3).
    """

    requests: List[str] = field(default_factory=list)
    responses: List[str] = field(default_factory=list)


class BridgeClient:
    """브리지 프로세스를 띄우고 한 줄씩 주고받는다.

    사용:
        with BridgeClient(core_module="./ci/aicc-core.mjs", adapter="callbot") as client:
            hello = client.hello()
            with client.session(flow_id="f_x", entry_point="inbound_call") as s:
                s.send_utterance("잔액 조회요")
    """

    def __init__(
        self,
        core_module: str,
        adapter: str,
        *,
        core_root: Optional[str] = None,
        node_bin: str = "node",
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        max_line_bytes: Optional[int] = None,
        include_handoff_summary: bool = False,
        include_slots: bool = False,
        keep_transcript: bool = False,
    ) -> None:
        root = core_root or os.environ.get("AICC_CORE")
        if not root:
            # 못 찾은 것을 "붙었다"로 적지 않는다. 호출자가 판정보류로 끝낼 수 있게 분명히 실패한다.
            raise BridgeProtocolError(
                "Core 위치를 찾지 못했습니다. core_root 인자나 AICC_CORE 환경변수로 알려주세요."
            )
        runner = os.path.join(root, "scripts", "channel-bridge.mjs")
        if not os.path.isfile(runner):
            raise BridgeProtocolError("브리지 실행기를 찾지 못했습니다(scripts/channel-bridge.mjs).")

        argv = [node_bin, runner, "--core", core_module, "--adapter", adapter]
        if max_line_bytes is not None:
            if not isinstance(max_line_bytes, int) or max_line_bytes <= 0:
                raise ValueError("max_line_bytes 는 양의 정수여야 합니다.")
            argv += ["--max-line-bytes", str(max_line_bytes)]
        if include_handoff_summary:
            argv.append("--include-handoff-summary")
        if include_slots:
            argv.append("--include-slots")

        self._adapter = adapter
        self._max_line_bytes = max_line_bytes
        self._seq = 0
        self._lock = threading.Lock()
        self._closed = False
        self.transcript = _Transcript() if keep_transcript else None
        self._proc = subprocess.Popen(  # noqa: S603 - 인자는 호출자가 준 고정 경로다
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    # ── 저수준 ────────────────────────────────────────────────────────────
    def request(self, op: str, **body: Any) -> BridgeResponse:
        """요청 한 줄을 보내고 응답 한 줄을 받는다. 실패해도 던지지 않는다(프로세스 사망 제외)."""
        with self._lock:
            if self._closed or self._proc.stdin is None or self._proc.stdout is None:
                raise BridgeProtocolError("브리지가 이미 닫혔습니다.")
            self._seq += 1
            payload: Dict[str, Any] = {"id": str(self._seq), "op": op}
            payload.update({k: v for k, v in body.items() if v is not None})
            # separators 로 공백을 없애고, 개행이 섞이지 않게 ensure_ascii 없이 한 줄로 만든다.
            line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            if "\n" in line or "\r" in line:
                # 여기까지 오면 직렬화가 규약을 깬 것이다. 보내지 않는다.
                raise BridgeProtocolError("요청 줄에 개행이 섞였습니다. 한 줄 = 한 요청 규약이 깨집니다.")
            if self._max_line_bytes is not None and len(line.encode("utf-8")) > self._max_line_bytes:
                return BridgeResponse(
                    id=payload["id"],
                    ok=False,
                    error=BridgeError("E_TOO_LARGE", "요청이 줄 길이 상한을 넘어 보내지 않았습니다."),
                )
            if self.transcript is not None:
                self.transcript.requests.append(line)
            try:
                self._proc.stdin.write(line + "\n")
                self._proc.stdin.flush()
                raw = self._proc.stdout.readline()
            except (BrokenPipeError, ValueError) as exc:  # 프로세스가 죽었다
                raise BridgeProtocolError("브리지 프로세스와의 통신이 끊겼습니다.") from exc
            if raw == "":
                raise BridgeProtocolError("브리지가 응답 없이 종료했습니다.")
            if self.transcript is not None:
                self.transcript.responses.append(raw.rstrip("\n"))
            return self._decode(raw, payload["id"])

    @staticmethod
    def _decode(raw: str, expected_id: str) -> BridgeResponse:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            # 원문을 메시지에 싣지 않는다 — 깨진 줄에 개인정보가 있을 수 있다(§10.3).
            return BridgeResponse(id=None, ok=False, error=BridgeError("E_BAD_JSON", "브리지 응답을 해석하지 못했습니다."))
        if not isinstance(parsed, dict):
            return BridgeResponse(id=None, ok=False, error=BridgeError("E_BAD_JSON", "브리지 응답이 객체가 아닙니다."))
        got_id = parsed.get("id")
        if got_id != expected_id:
            # 순서만 믿지 않는다. 어긋난 상관은 조용히 넘기면 다른 통화의 상태를 읽게 된다.
            raise BridgeProtocolError("응답 id 가 요청과 다릅니다. 응답 스트림이 어긋났습니다.")
        err = parsed.get("error")
        error = None
        if isinstance(err, dict):
            error = BridgeError(str(err.get("code", "E_INTERNAL")), str(err.get("messageKo", "")))
        return BridgeResponse(id=got_id, ok=parsed.get("ok") is True, result=parsed.get("result"), error=error)

    # ── 고수준 ────────────────────────────────────────────────────────────
    def hello(self) -> BridgeResponse:
        res = self.request("hello")
        if res.ok and isinstance(res.result, dict):
            version = res.result.get("protocolVersion")
            if version != PROTOCOL_VERSION:
                raise BridgeProtocolError(
                    "브리지 프로토콜 버전이 이 클라이언트와 다릅니다"
                    f"(브리지 {version} · 클라이언트 {PROTOCOL_VERSION})."
                )
            if res.result.get("adapter") != self._adapter:
                raise BridgeProtocolError("브리지 채널이 요청한 어댑터와 다릅니다. 브리지 하나가 채널 하나입니다.")
        return res

    def start(
        self,
        *,
        flow_id: str,
        entry_point: str,
        flow_version: Optional[int] = None,
        preset_slots: Optional[Dict[str, str]] = None,
        join_interaction_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> BridgeResponse:
        # scope 와 adapter 는 싣지 않는다 — 테넌트·채널은 브리지 설정이 정한다(§11.1).
        req: Dict[str, Any] = {"flowId": flow_id, "entryPoint": entry_point}
        if flow_version is not None:
            req["flowVersion"] = flow_version
        if preset_slots:
            req["presetSlots"] = preset_slots
        if join_interaction_id:
            req["joinInteractionId"] = join_interaction_id
        if correlation_id:
            req["correlationId"] = correlation_id
        return self.request("start", req=req)

    def send(self, interaction_id: str, turn: Dict[str, Any]) -> BridgeResponse:
        return self.request("send", interactionId=interaction_id, turn=turn)

    def send_utterance(
        self,
        interaction_id: str,
        text: str,
        *,
        confidence: Optional[float] = None,
        latency: Optional[Dict[str, float]] = None,
        usage: Optional[Dict[str, float]] = None,
    ) -> BridgeResponse:
        turn: Dict[str, Any] = {"input": {"kind": "utterance", "text": text}}
        if confidence is not None:
            turn["input"]["confidence"] = confidence
        if latency:
            turn["latency"] = latency
        if usage:
            turn["usage"] = usage
        return self.send(interaction_id, turn)

    def send_dtmf(self, interaction_id: str, digits: str) -> BridgeResponse:
        return self.send(interaction_id, {"input": {"kind": "dtmf", "digits": digits}})

    def send_timeout(self, interaction_id: str) -> BridgeResponse:
        """무음·응답 없음. 음성 채널에서 가장 자주 쓰는 입력이라 이름을 따로 준다."""
        return self.send(interaction_id, {"input": {"kind": "timeout"}})

    def end(self, interaction_id: str, reason_ko: str) -> BridgeResponse:
        return self.request("end", interactionId=interaction_id, reasonKo=reason_ko)

    def report_health(self, samples: Sequence[Dict[str, Any]], observed_at: str) -> BridgeResponse:
        """관측 시각은 호출자가 준다 — 클라이언트가 시각을 만들어 넣지 않는다(§13-3)."""
        return self.request("health", report={"observedAt": observed_at, "samples": list(samples)})

    # ── 세션 ──────────────────────────────────────────────────────────────
    def session(self, *, reason_ko: str = "정상 종료", **start_kwargs: Any) -> "_SessionContext":
        return _SessionContext(self, reason_ko, start_kwargs)

    # ── 수명 ──────────────────────────────────────────────────────────────
    def close(self) -> None:
        """멱등하다. 두 번 불러도 안전하다 — 예외 경로에서 중복 호출이 나기 때문이다."""
        if self._closed:
            return
        self._closed = True
        try:
            if self._proc.stdin is not None:
                self._proc.stdin.close()
        except Exception:  # noqa: BLE001 - 닫는 중 오류가 종료를 막으면 안 된다
            pass
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        finally:
            for stream in (self._proc.stdout, self._proc.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except Exception:  # noqa: BLE001
                    pass

    def __enter__(self) -> "BridgeClient":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()


class _SessionContext:
    """start ~ end 를 묶는다. 예외가 나도 end 를 부른다 — 세션 누수를 막는 유일한 지점이다."""

    def __init__(self, client: BridgeClient, reason_ko: str, start_kwargs: Dict[str, Any]) -> None:
        self._client = client
        self._reason_ko = reason_ko
        self._start_kwargs = start_kwargs
        self.interaction_id: Optional[str] = None
        self.started: Optional[BridgeResponse] = None
        self.ended: Optional[BridgeResponse] = None

    def __enter__(self) -> "_SessionContext":
        self.started = self._client.start(**self._start_kwargs)
        self.interaction_id = self.started.interaction_id
        return self

    def __exit__(self, *_exc: Any) -> None:
        if self.interaction_id and self.ended is None:
            try:
                self.ended = self._client.end(self.interaction_id, self._reason_ko)
            except BridgeProtocolError:
                # 브리지가 이미 죽었다면 더 할 수 있는 일이 없다. 원래 예외를 덮지 않는다.
                pass

    def send_utterance(self, text: str, **kwargs: Any) -> BridgeResponse:
        return self._require_id_then(lambda i: self._client.send_utterance(i, text, **kwargs))

    def send_dtmf(self, digits: str) -> BridgeResponse:
        return self._require_id_then(lambda i: self._client.send_dtmf(i, digits))

    def send_timeout(self) -> BridgeResponse:
        return self._require_id_then(self._client.send_timeout)

    def _require_id_then(self, fn: Any) -> BridgeResponse:
        if not self.interaction_id:
            # 식별자를 스스로 만들지 않는다. 만들면 Core 가 모르는 세션이 생긴다.
            return BridgeResponse(
                id=None, ok=False,
                error=BridgeError("E_NO_SESSION", "세션이 시작되지 않아 보낼 수 없습니다."),
            )
        return fn(self.interaction_id)


def iter_lines(text: str) -> Iterator[str]:
    """JSONL 문자열을 줄 단위로 훑는다. 빈 줄은 건너뛴다(파이프 끝 개행이 오류가 되지 않게)."""
    for line in text.splitlines():
        if line.strip():
            yield line
