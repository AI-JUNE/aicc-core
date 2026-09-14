# -*- coding: utf-8 -*-
"""Callbot 음성 에이전트용 Core 훅 어댑터 (표준 라이브러리만 사용).

설계서 §1.2(Core 단일화)·§2(시나리오 단일화)·§9.3(폴백)·§10.3(마스킹)·§11.1(테넌트 격리)·§13-3(실측만).

왜 이 파일이 있는가
-------------------
`aicc_bridge.py` 는 "브리지에 한 줄을 보내는 법"이다. 그런데 Callbot 의 `agent.py` 가 실제로 갖고
있는 것은 세션이 아니라 **훅**이다 — `call_start` · `transcript` · `call_end`. 통화 하나가 훅 세 개에
흩어져 들어오고, 통화 두 개가 겹치면 훅은 섞여서 온다. 그 사이에서 "어느 통화의 세션인가",
"이미 끝난 통화인가", "브리지가 죽었는데 통화를 끊어야 하나"를 각 저장소가 알아서 정하게 두면
각자 다르게 틀린다. 이 파일은 그 판단을 한 곳에 모은 것이다.

agent.py 에 넣을 것은 훅마다 한 줄이다(이 파일은 agent.py 를 import 하지 않는다):

    hooks = AsyncCallbotCoreHooks.from_env()          # 기본 OFF. 켜는 조건은 아래
    @agent.on("call_start")  ... await hooks.on_call_start(call.call_id)
    @agent.on("transcript")  ... await hooks.on_transcript(call.call_id, role, text)
    @agent.on("call_end")    ... await hooks.on_call_end(call.call_id)

이 어댑터가 지키는 것 (전부 "빠지면 사고가 나는" 지점이다)
--------------------------------------------------------
1. **기본 OFF.** `AICC_CORE_ENABLED` 가 켜져 있고 Core 위치·Core 모듈·Flow id 가 **모두** 있어야
   켜진다. 하나라도 없으면 어댑터는 아무것도 하지 않는 껍데기가 되고, 이유를 `disabled_reason_ko`
   에 남긴다 — 조용히 꺼지면 "붙였는데 왜 아무 이벤트도 없지"로 끝난다. Flow id 기본값은 만들지
   않는다(§13-3): 어느 시나리오를 태울지는 Core 가 정할 근거가 없다.
2. **통화는 call_id 로 격리한다.** 전역 "현재 통화" 하나로 세션을 찾으면 통화 두 개가 겹치는 순간
   다른 사람의 상태를 읽는다.
3. **Core 실패가 통화를 끊지 않는다(§9.3).** 브리지 프로세스가 죽으면 `degraded` 로 표시하고
   이후 훅은 즉시 None 을 돌려준다. 예외는 agent.py 로 올라가지 않는다. 대신 `on_error` 로 코드만
   알린다 — 삼키는 것이 아니라 **끊지 않으면서 드러내는** 것이다.
4. **고객 발화만 Core 로 간다.** `role="user"` 가 아닌 전사(봇 자신의 발화)는 보내지 않는다.
   보내면 봇의 말이 고객 입력으로 시나리오를 진행시킨다.
5. **종료는 멱등이고 빠지지 않는다.** `on_call_end` 는 두 번 불러도 한 번만 닫고, `close()` 는
   열린 통화를 모두 닫은 뒤 브리지를 내린다 — 닫히지 않은 세션은 장애가 아니라 요금으로 나타난다.
6. **발화·응답을 print 하지 않는다(§10.3).** 이 파일은 어떤 것도 출력하지 않는다.
   결과가 필요하면 `on_turn` 콜백으로 받는다(상담사용 요약·슬롯 값은 기본적으로 들어 있지 않다).

무엇을 하지 않는가 (build now, activate on approval)
---------------------------------------------------
회선·STT/TTS·전환(transfer)을 만지지 않는다. 브리지는 기본 dry_run 이며 live 는 **[승인 필요]** 다.
"""

from __future__ import annotations

import asyncio
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Mapping, Optional

from aicc_bridge import BridgeClient, BridgeProtocolError, BridgeResponse

__all__ = ["CallbotCoreHooks", "AsyncCallbotCoreHooks", "HookStats"]

_TRUTHY = ("1", "true", "yes", "on")

ErrorHook = Callable[[str, str], None]          # (code, message_ko)
TurnHook = Callable[[str, Any], None]           # (call_id, result payload)
ClientFactory = Callable[[], BridgeClient]


@dataclass
class HookStats:
    """실측 카운터. 판단 점수가 아니라 건수다(§13-3)."""

    calls_started: int = 0
    calls_ended: int = 0
    turns_sent: int = 0
    turns_failed: int = 0
    ignored_non_user: int = 0
    ignored_empty: int = 0
    unknown_call_ids: int = 0
    duplicate_ends: int = 0
    late_after_end: int = 0
    degraded_skips: int = 0

    def as_dict(self) -> Dict[str, int]:
        return dict(self.__dict__)


@dataclass
class _Call:
    interaction_id: str
    ended: bool = False
    turns: int = field(default=0)


class CallbotCoreHooks:
    """동기 훅 어댑터. asyncio 에이전트에서는 `AsyncCallbotCoreHooks` 를 쓴다."""

    ENV_ENABLED = "AICC_CORE_ENABLED"
    ENV_ROOT = "AICC_CORE"
    ENV_MODULE = "AICC_CORE_MODULE"
    ENV_FLOW_ID = "AICC_FLOW_ID"
    ENV_ENTRY = "AICC_ENTRY_POINT"
    ENV_MAX_LINE = "AICC_MAX_LINE_BYTES"

    def __init__(
        self,
        client_factory: Optional[ClientFactory],
        *,
        flow_id: str = "",
        entry_point: str = "inbound_call",
        on_error: Optional[ErrorHook] = None,
        on_turn: Optional[TurnHook] = None,
        disabled_reason_ko: str = "",
    ) -> None:
        self._factory = client_factory
        self._flow_id = flow_id
        self._entry_point = entry_point
        self._on_error = on_error
        self._on_turn = on_turn
        self._client: Optional[BridgeClient] = None
        self._calls: Dict[str, _Call] = {}
        self._lock = threading.RLock()
        self._degraded = False
        self._closed = False
        self.stats = HookStats()
        self.disabled_reason_ko = disabled_reason_ko
        if client_factory is None and not disabled_reason_ko:
            self.disabled_reason_ko = "클라이언트 팩토리가 없어 어댑터가 꺼져 있습니다."
        if client_factory is not None and not flow_id:
            # 켜진 어댑터에 Flow id 가 없으면 start 마다 E_BAD_REQUEST 가 난다. 미리 끈다.
            self._factory = None
            self.disabled_reason_ko = "Flow id 가 없어 어댑터를 켜지 않았습니다(기본값을 만들지 않는다, §13-3)."

    # ── 생성 ─────────────────────────────────────────────────────────────
    @classmethod
    def from_env(
        cls,
        env: Optional[Mapping[str, str]] = None,
        *,
        adapter: str = "callbot",
        on_error: Optional[ErrorHook] = None,
        on_turn: Optional[TurnHook] = None,
        node_bin: str = "node",
    ) -> "CallbotCoreHooks":
        """환경변수로 만든다. 조건이 하나라도 빠지면 **꺼진 어댑터**를 돌려주며 예외를 던지지 않는다."""
        e = os.environ if env is None else env
        if (e.get(cls.ENV_ENABLED, "") or "").strip().lower() not in _TRUTHY:
            return cls(None, disabled_reason_ko=f"{cls.ENV_ENABLED} 가 켜져 있지 않습니다(기본 OFF).")
        root = (e.get(cls.ENV_ROOT, "") or "").strip()
        module = (e.get(cls.ENV_MODULE, "") or "").strip()
        flow_id = (e.get(cls.ENV_FLOW_ID, "") or "").strip()
        entry = (e.get(cls.ENV_ENTRY, "") or "").strip() or "inbound_call"
        missing = [name for name, val in ((cls.ENV_ROOT, root), (cls.ENV_MODULE, module), (cls.ENV_FLOW_ID, flow_id)) if not val]
        if missing:
            return cls(None, disabled_reason_ko="설정이 빠져 어댑터를 켜지 않았습니다: " + ", ".join(missing))
        max_line: Optional[int] = None
        raw_max = (e.get(cls.ENV_MAX_LINE, "") or "").strip()
        if raw_max:
            if not raw_max.isdigit() or int(raw_max) <= 0:
                return cls(None, disabled_reason_ko=f"{cls.ENV_MAX_LINE} 는 양의 정수여야 합니다.")
            max_line = int(raw_max)

        def factory() -> BridgeClient:
            return BridgeClient(
                core_module=module, adapter=adapter, core_root=root, cwd=root,
                node_bin=node_bin, max_line_bytes=max_line,
            )

        return cls(factory, flow_id=flow_id, entry_point=entry, on_error=on_error, on_turn=on_turn)

    # ── 상태 ─────────────────────────────────────────────────────────────
    @property
    def enabled(self) -> bool:
        return self._factory is not None and not self._closed

    @property
    def degraded(self) -> bool:
        return self._degraded

    def open_call_ids(self) -> list:
        with self._lock:
            return [cid for cid, c in self._calls.items() if not c.ended]

    # ── 훅 ───────────────────────────────────────────────────────────────
    def on_call_start(self, call_id: str, *, correlation_id: Optional[str] = None) -> Optional[str]:
        """세션을 연다. 성공하면 interactionId, 아니면 None(통화는 계속된다)."""
        if not call_id or not self._ready():
            return None
        with self._lock:
            if call_id in self._calls and not self._calls[call_id].ended:
                return self._calls[call_id].interaction_id  # 같은 통화의 중복 시작은 재사용
            res = self._guard(lambda c: c.start(flow_id=self._flow_id, entry_point=self._entry_point,
                                               correlation_id=correlation_id))
            if res is None:
                return None  # 브리지 끊김은 _guard 가 이미 한 번 보고했다
            if not res.ok or not res.interaction_id:
                self._report(res.error.code if res.error else "E_START_FAILED",
                             "Core 세션을 열지 못해 이 통화는 Core 없이 진행합니다.")
                return None
            self._calls[call_id] = _Call(interaction_id=res.interaction_id)
            self.stats.calls_started += 1
            return res.interaction_id

    def on_transcript(self, call_id: str, role: str, text: str, *,
                      confidence: Optional[float] = None) -> Optional[BridgeResponse]:
        if role != "user":
            self.stats.ignored_non_user += 1
            return None
        if not isinstance(text, str) or not text.strip():
            self.stats.ignored_empty += 1
            return None
        return self._turn(call_id, lambda c, i: c.send_utterance(i, text, confidence=confidence))

    def on_dtmf(self, call_id: str, digits: str) -> Optional[BridgeResponse]:
        if not isinstance(digits, str) or not digits:
            self.stats.ignored_empty += 1
            return None
        return self._turn(call_id, lambda c, i: c.send_dtmf(i, digits))

    def on_timeout(self, call_id: str) -> Optional[BridgeResponse]:
        return self._turn(call_id, lambda c, i: c.send_timeout(i))

    def on_call_end(self, call_id: str, reason_ko: str = "통화 종료") -> Optional[BridgeResponse]:
        """멱등. 두 번째 호출은 아무것도 보내지 않는다."""
        with self._lock:
            call = self._calls.get(call_id)
            if call is None:
                self.stats.unknown_call_ids += 1
                return None
            if call.ended:
                self.stats.duplicate_ends += 1
                return None
            call.ended = True  # 브리지가 죽어 있어도 "닫으려 했다"는 상태는 남긴다
            self._prune_ended()
            if not self._ready():
                return None
            res = self._guard(lambda c: c.end(call.interaction_id, reason_ko))
            if res is not None:
                self.stats.calls_ended += 1
            return res

    def close(self) -> None:
        """열린 통화를 전부 닫고 브리지를 내린다. 멱등."""
        with self._lock:
            if self._closed:
                return
            for cid, c in list(self._calls.items()):
                if not c.ended:
                    self.on_call_end(cid, "에이전트 종료")
            self._closed = True
            client, self._client = self._client, None
        if client is not None:
            client.close()

    def __enter__(self) -> "CallbotCoreHooks":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    # ── 내부 ─────────────────────────────────────────────────────────────
    _ENDED_KEEP = 1000  # 끝난 통화 id 를 이만큼 기억해 중복 종료·지연 전사를 "모르는 통화"와 구분한다

    def _prune_ended(self) -> None:
        ended = [cid for cid, c in self._calls.items() if c.ended]
        for cid in ended[: max(0, len(ended) - self._ENDED_KEEP)]:
            self._calls.pop(cid, None)

    def _ready(self) -> bool:
        if not self.enabled:
            return False
        if self._degraded:
            self.stats.degraded_skips += 1
            return False
        return True

    def _ensure_client(self) -> BridgeClient:
        if self._client is None:
            assert self._factory is not None
            self._client = self._factory()
            self._client.hello()  # 버전·어댑터 불일치는 여기서 드러난다
        return self._client

    def _guard(self, fn: Callable[[BridgeClient], BridgeResponse]) -> Optional[BridgeResponse]:
        """브리지 프로토콜 예외를 통화 밖으로 내보내지 않는다(§9.3)."""
        try:
            return fn(self._ensure_client())
        except BridgeProtocolError:
            self._degraded = True
            self._report("E_BRIDGE_DOWN", "Core 브리지와의 통신이 끊겨 이후 통화는 Core 없이 진행합니다.")
            return None
        except Exception:  # noqa: BLE001 - 어떤 예외도 통화를 끊지 않는다
            self._degraded = True
            self._report("E_BRIDGE_DOWN", "Core 브리지 호출 중 예외가 나 이후 통화는 Core 없이 진행합니다.")
            return None

    def _turn(self, call_id: str, fn: Callable[[BridgeClient, str], BridgeResponse]) -> Optional[BridgeResponse]:
        if not self._ready():
            return None
        with self._lock:
            call = self._calls.get(call_id)
            if call is None:
                self.stats.unknown_call_ids += 1
                return None
            if call.ended:
                self.stats.late_after_end += 1  # 끝난 통화의 지연 전사. 보내지 않는다
                return None
            res = self._guard(lambda c: fn(c, call.interaction_id))
            if res is None:
                return None
            if res.ok:
                self.stats.turns_sent += 1
                call.turns += 1
                if self._on_turn is not None:
                    try:
                        self._on_turn(call_id, res.result)
                    except Exception:  # noqa: BLE001 - 호출자 콜백 오류가 통화를 끊으면 안 된다
                        pass
            else:
                self.stats.turns_failed += 1
                self._report(res.error.code if res.error else "E_TURN_FAILED",
                             "Core 가 이 턴을 처리하지 못했습니다. 통화는 계속됩니다.")
            return res

    def _report(self, code: str, message_ko: str) -> None:
        if self._on_error is None:
            return
        try:
            self._on_error(code, message_ko)  # 발화·응답 원문은 싣지 않는다(§10.3)
        except Exception:  # noqa: BLE001
            pass


class AsyncCallbotCoreHooks:
    """asyncio 에이전트용. 블로킹 I/O 를 스레드로 보내 이벤트 루프를 막지 않는다.

    같은 통화의 훅은 도착 순서대로 처리된다 — 한 통화에서 두 턴이 겹치면 상태가 갈라지기 때문이다.
    """

    def __init__(self, inner: CallbotCoreHooks) -> None:
        self.inner = inner
        self._chain: Dict[str, "asyncio.Future[Any]"] = {}

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None, **kwargs: Any) -> "AsyncCallbotCoreHooks":
        return cls(CallbotCoreHooks.from_env(env, **kwargs))

    @property
    def enabled(self) -> bool:
        return self.inner.enabled

    @property
    def disabled_reason_ko(self) -> str:
        return self.inner.disabled_reason_ko

    async def _run(self, call_id: str, fn: Callable[[], Any]) -> Any:
        loop = asyncio.get_running_loop()
        prev = self._chain.get(call_id)
        if prev is not None:
            try:
                await prev
            except Exception:  # noqa: BLE001 - 앞 훅의 실패가 뒤 훅을 막지 않는다
                pass
        fut = loop.run_in_executor(None, fn)
        self._chain[call_id] = fut
        try:
            return await fut
        finally:
            if self._chain.get(call_id) is fut:
                self._chain.pop(call_id, None)

    async def on_call_start(self, call_id: str, **kw: Any) -> Optional[str]:
        return await self._run(call_id, lambda: self.inner.on_call_start(call_id, **kw))

    async def on_transcript(self, call_id: str, role: str, text: str, **kw: Any) -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_transcript(call_id, role, text, **kw))

    async def on_dtmf(self, call_id: str, digits: str) -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_dtmf(call_id, digits))

    async def on_timeout(self, call_id: str) -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_timeout(call_id))

    async def on_call_end(self, call_id: str, reason_ko: str = "통화 종료") -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_call_end(call_id, reason_ko))

    async def close(self) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self.inner.close)
