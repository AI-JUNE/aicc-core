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
7. **재시도 대기를 지어내지 않는다.** 한도 초과(`E_RATE_LIMITED`) 응답의 `retryAfterMs` 는 브리지가
   **계산해서 준** 경우에만 `BridgeError.retry_after_ms` 로 노출한다. 없거나 형태가 틀리면 None 이며,
   0 으로 읽지 않는다 — 0 으로 읽으면 곧바로 재시도해 한도를 더 밀어붙인다(§13-3).
8. **계약에 있는 값은 보낼 수 있어야 한다.** 턴 단위 실측(§11.2 `usage`·§13 `latency`)은 발화 턴만
   쓰는 값이 아니다 — DTMF 선택·무음 턴에서도 그 턴의 TTS·LLM 은 이미 호출됐고 비용은 공급사
   청구서에 남는다. 보낼 방법이 없으면 그 수량은 Core 원장에 들어가지 않고, 과소청구 방향이라
   청구를 막지도 않은 채 몇 주 뒤 대사에서 '미설명' 차이로만 나타난다(§11.2).
   **없는 값을 만들지는 않는다**(§13-3): 주지 않으면 키 자체를 싣지 않는다.

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
    #: E_RATE_LIMITED 에서만 채워진다. 브리지가 **계산해서 준** 값이며 추정치가 아니다(§13-3).
    #: 없으면 None 이다 — 호스트가 임의의 대기 시간을 만들어 쓰지 않게 하려는 것이다.
    retry_after_ms: Optional[float] = None


def _retry_after_ms(raw: Any) -> Optional[float]:
    """재시도 대기(ms)를 **브리지가 준 경우에만** 받는다.

    모르는 값을 0 으로 읽으면 호스트가 곧바로 재시도해 한도를 더 밀어붙이고,
    임의의 값으로 메우면 없는 근거를 만든 것이다(§13-3). 둘 다 하지 않고 None 을 돌려준다.
    """
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = float(raw)
    if value != value or value in (float("inf"), float("-inf")) or value < 0:
        return None
    return value


@dataclass(frozen=True)
class BridgeResponse:
    id: Optional[str]
    ok: bool
    result: Any = None
    error: Optional[BridgeError] = None

    @property
    def rate_limited(self) -> bool:
        """한도 초과인가. 브리지 사망(끊김)과 구분해야 한다 — 이쪽은 기다리면 풀린다."""
        return self.error is not None and self.error.code == "E_RATE_LIMITED"

    @property
    def retry_after_ms(self) -> Optional[float]:
        return self.error.retry_after_ms if self.error is not None else None

    @property
    def interaction_id(self) -> Optional[str]:
        if self.ok and isinstance(self.result, dict):
            value = self.result.get("interactionId")
            if isinstance(value, str) and value:
                return value
        return None

    @property
    def pending_connector_id(self) -> Optional[str]:
        """Api 대기 중인 커넥터 id(§6.1). 없으면 None.

        값이 있으면 Core 는 **업무시스템 조회 결과를 기다리는 상태**이고, 보내야 하는 다음 입력은
        발화가 아니라 `send_connector_result(...)` 다. 이 값을 보지 않으면 대기 중에 발화를 보내게
        되는데 그 응답은 `steps` 0건·`events` 0건이고 **오류도 아니다** — 통화는 끊기지 않은 채
        멈추고 어떤 알림도 울리지 않는다("그 메뉴만 안 된다"로만 나타난다).
        커넥터 이행이 배선된 테넌트에서는 Core 가 스스로 부르므로 이 값이 서지 않는다.
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        state = self.result.get("state")
        if not isinstance(state, dict):
            return None
        value = state.get("pendingConnectorId")
        return value if isinstance(value, str) and value else None


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
            error = BridgeError(
                str(err.get("code", "E_INTERNAL")),
                str(err.get("messageKo", "")),
                _retry_after_ms(err.get("retryAfterMs")),
            )
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
        join_token: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> BridgeResponse:
        """세션을 열거나(flow_id) 진행 중인 상담에 합류한다(join_interaction_id).

        `join_token` 은 §5.2 합류 자격 토큰이다. **Core 에 채널 전환이 배선되면 필수**이며,
        고객이 누른 링크에 실려 온 값을 그대로 넘긴다 — 이 클라이언트가 만들지 않는다(§10.3).
        넘길 방법이 없으면 전환 배선을 켜는 순간 **비-Node 호스트만 합류하지 못한다**: 평시에는
        드러나지 않고 테넌트가 그 보안 설정을 켠 날부터 "이 채널에서만 화면 전환이 안 된다"로
        나타난다. 배선이 없는 Core 는 이 값을 보지 않으므로 종전과 완전히 같다(§13-3).
        """
        # scope 와 adapter 는 싣지 않는다 — 테넌트·채널은 브리지 설정이 정한다(§11.1).
        req: Dict[str, Any] = {"flowId": flow_id, "entryPoint": entry_point}
        if flow_version is not None:
            req["flowVersion"] = flow_version
        if preset_slots:
            req["presetSlots"] = preset_slots
        if join_interaction_id:
            req["joinInteractionId"] = join_interaction_id
        if join_token:
            req["joinToken"] = join_token
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

    def send_dtmf(
        self,
        interaction_id: str,
        digits: str,
        *,
        latency: Optional[Dict[str, float]] = None,
        usage: Optional[Dict[str, float]] = None,
    ) -> BridgeResponse:
        """번호 입력. **실측은 발화 턴만의 것이 아니다**(머리말 8번).

        DTMF 턴에도 그 턴의 안내를 합성한 TTS·판정에 쓴 LLM 이 있다 — `usage` 를 주지 않으면
        그 수량은 §8.1 원장에 없고 공급사 청구서에만 남는다. `latency` 는 Core 가 DTMF 입력에
        실어 주므로(§13 지연 지표) 측정했으면 그대로 넘긴다.
        """
        turn: Dict[str, Any] = {"input": {"kind": "dtmf", "digits": digits}}
        if latency:
            turn["latency"] = latency
        if usage:
            turn["usage"] = usage
        return self.send(interaction_id, turn)

    def send_timeout(
        self,
        interaction_id: str,
        *,
        usage: Optional[Dict[str, float]] = None,
    ) -> BridgeResponse:
        """무음·응답 없음. 음성 채널에서 가장 자주 쓰는 입력이라 이름을 따로 준다.

        무음 턴도 비용이 있다 — 기다리는 동안 나간 재프롬프트는 TTS 로 합성된 발화다.
        **`latency` 는 받지 않는다**: Core 는 무입력 턴에 응답시간을 싣지 않고(고객 발화가 없어
        실을 자리가 없다) 그 사실을 계약 경고로 적는다. 받을 수 있게 열어 두면 호스트가 넘긴
        실측이 경고와 함께 버려지는 경로가 하나 더 생긴다(§13-3).
        """
        turn: Dict[str, Any] = {"input": {"kind": "timeout"}}
        if usage:
            turn["usage"] = usage
        return self.send(interaction_id, turn)

    def send_connector_result(
        self,
        interaction_id: str,
        ok: bool,
        *,
        slots: Optional[Dict[str, str]] = None,
        error_code: Optional[str] = None,
    ) -> BridgeResponse:
        """업무시스템 조회 결과를 되돌려준다(§6.1 — `pending_connector_id` 가 섰을 때).

        `ok` 는 **명시해야 한다** — 빠진 값을 성공으로 읽으면 실패한 조회가 성공으로 흘러간다.
        `slots` 는 커넥터 계층에서 허용목록·마스킹을 마친 값만 넣는다(§10.3). 실패면 `error_code`
        를 주면 시나리오의 `onError` 분기가 그 코드를 근거로 갈라진다. 분기가 없으면 Core 가
        상담사로 내린다 — 조회 실패로 콜을 끊지 않는다(§9.3).

        **`usage` 는 받지 않는다**: 커넥터 재개 턴에는 고객 발화 이벤트가 없어 Core 가 실측을
        실을 자리가 없다(그 턴의 §6.1 커넥터 실측을 어디에 집계할지는 지표 정의 문제이며 Core 가
        정하지 않는다). 받아서 보내면 응답 `billing` 에 "실을 자리가 없었다"만 적힌다.
        """
        payload: Dict[str, Any] = {"kind": "connectorResult", "ok": bool(ok)}
        if slots:
            payload["slots"] = slots
        if error_code:
            payload["errorCode"] = error_code
        return self.send(interaction_id, {"input": payload})

    def end(
        self,
        interaction_id: str,
        reason_ko: str,
        *,
        billable_ms: Optional[float] = None,
    ) -> BridgeResponse:
        """세션 종료. `billable_ms` 는 §11.2 통화 과금 구간이다.

        **만들어 넣지 않는다**(§13-3). `None` 이면 키를 싣지 않고 종전과 완전히 같다 — 0 을 보내면
        "0초 통화를 실측했다"는 뜻이 되고, 누락과 0 을 같게 적는 것이 정산 분쟁의 출발점이다.
        값이 실렸는지는 응답 `result.billing` 에 사실대로 적혀 돌아온다.

        형태가 틀려도 **여기서 막지 않는다** — end 가 막히면 세션이 닫히지 않고, 그 누수는 장애가
        아니라 요금으로 먼저 나타난다. 판정은 Core 한 곳이 하고 사유를 돌려준다.
        """
        payload: Dict[str, Any] = {"interactionId": interaction_id, "reasonKo": reason_ko}
        if billable_ms is not None:
            payload["billableMs"] = billable_ms
        return self.request("end", **payload)

    def report_health(self, samples: Sequence[Dict[str, Any]], observed_at: str) -> BridgeResponse:
        """관측 시각은 호출자가 준다 — 클라이언트가 시각을 만들어 넣지 않는다(§13-3)."""
        return self.request("health", report={"observedAt": observed_at, "samples": list(samples)})

    # ── 유지 루프(§9.3·§2) ────────────────────────────────────────────────
    # Core 는 **타이머를 돌리지 않는다**(몰래 켠 인터벌은 끌 수도 없고 프로세스 종료를 막는다).
    # 그래서 아래 여섯은 호스트가 주기적으로 불러야 한다. 부를 자리가 없던 동안 비-Node 호스트의
    # 배치에서는 전부 **한 번도 돌지 않았고**, 증상은 하나도 예외가 아니었다:
    #   - `run_offer_expiry` 미호출 → 만료된 오퍼가 열린 채 쌓여 같은 콜이 두 번 제안되고,
    #     그 통화는 큐에 묶인 채 §9.3 대안(콜백·음성사서함)으로도 가지 않는다.
    #   - `run_recovery_probe` 미호출 → 한 번 `degraded_ai`·`agent_only` 로 내려간 테넌트는
    #     엔진이 돌아와도 **영구히** 폴백에 남는다(아무도 찌르지 않으니 샘플이 갱신되지 않는다).
    #   - `readiness` 미호출 → 호스트 `/health` 에 §9.3 상태가 닿지 않아, 모든 통화가 상담사
    #     직결로 떨어진 순간에도 200·up 이다.
    #   - `settle_offer` 미호출 → 상담사의 수락·거절이 원장에 없어 재배정도 소진 수렴도 없다
    #     (그 상태는 "상담사가 안 받는다"와 구분되지 않는다).
    #   - `warnings` 미호출 → `W_AI_DISCLOSURE_UNBOUND` 처럼 **통화는 정상으로 끝나는데
    #     고지가 한 번도 나가지 않는** 상태를 호스트가 읽을 길이 없다.
    #   - `observability` 미호출 → 로거·수집기가 던지고 있는 상태(`failed`)와 이 호스트의
    #     통화 id 가 개인정보 패턴에 걸려 로그에서 빠지는 상태(`droppedIds`)를 알 길이 없다.
    #     둘 다 예외가 아니라 **수치로만** 나타나므로, 읽지 않으면 "로그를 붙였다"와
    #     "로그가 나가고 있다"가 구분되지 않는다(§10.3·§13-3).
    #
    # **주기는 이 클라이언트가 정하지 않는다**(§13-3) — 회선 수·상담사 수에 따라 다르다.
    # 브리지가 그 op 를 열지 않았으면 `E_NOT_WIRED` 로 돌아온다(조용한 0건이 아니다).
    def maintenance_ops(self) -> Sequence[str]:
        """브리지가 실제로 열어 둔 유지 op. `hello` 응답에서 읽는다(찔러 보지 않는다)."""
        res = self.hello()
        if not res.ok or not isinstance(res.result, dict):
            return []
        ops = res.result.get("maintenanceOps")
        return [str(o) for o in ops] if isinstance(ops, list) else []

    def warnings(self) -> BridgeResponse:
        """등록 시점 계약 경고 전문(§9.3·§10.1). 코드가 아니라 사유까지 온다."""
        return self.request("warnings")

    def readiness(self) -> BridgeResponse:
        """§9.3 폴백 상태를 포함한 readiness.

        제한 시간·프로브는 **브리지 쪽 배선**이 준다 — 호출마다 호스트가 바꾸면 같은 `/health`
        가 호출마다 다른 기준으로 판정된다(§2). 그래서 이 호출에는 인자가 없다.
        """
        return self.request("readiness")

    def run_recovery_probe(self) -> BridgeResponse:
        """§9.3 복구 확인 1회. 보고서의 `unprobed` 가 비어 있지 않으면 **확인할 길이 없는** 컴포넌트다."""
        return self.request("recoveryProbe")

    def run_offer_expiry(self) -> BridgeResponse:
        """배정 오퍼 만료 수렴 1회. `issues` 가 비어 있지 않으면 `expired` 는 판정 결과가 아니다."""
        return self.request("offerExpiry")

    def settle_offer(self, offer_id: str, event: str) -> BridgeResponse:
        """상담사 응답 반영. `event` 는 accept·decline·cancel 이다.

        `tick`(만료)은 받지 않는다 — 건별로 만료시키면 만료 판정이 두 곳이 되므로
        `run_offer_expiry` 가 수행한다(§2). 거절·무응답이면 **같은 호출에서** 다음 후보로
        이어지고, 재배정 한도를 다 쓰면 응답의 `placement` 에 §9.3 대안이 실려 온다.
        """
        return self.request("settleOffer", offerId=offer_id, event=event)

    def observability(self) -> BridgeResponse:
        """관측 실측. 수치만 온다 — 로그 본문·오류 원문은 어떤 경로로도 오지 않는다(§10.3).

        읽어야 하는 것은 `core.failed`(로거·수집기가 던진 수 — 0 이 아니면 로그가 나가지
        않고 있다)와 `core.droppedIds`(이 호스트의 id 가 개인정보 패턴에 걸려 로그 식별자로
        싣지 못한 수 — 0 이 아니면 통화 id 생성 규칙을 고쳐야 한다, §10.3)다.
        `bridge` 는 **Core 에 닿지도 못한 줄**의 수치라 합치지 않는다(`bridgeKnown` 이
        False 면 브리지 쪽 배선이 없어 그 수치가 아예 없다는 뜻이고 0 건이 아니다).

        억제분 방출은 이 호출이 하지 않는다 — 읽기에 부작용을 섞으면 종료 직전 방출이
        "방금 읽었으니 비었다"로 바뀐다. 방출은 브리지 실행기가 종료 시점에 한다.
        """
        return self.request("observability")

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
    """start ~ end 를 묶는다. 예외가 나도 end 를 부른다 — 세션 누수를 막는 유일한 지점이다.

    §11.2 통화 과금 구간은 `billable_ms` 로 선언한다. 회선이 알려 준 값을 `call.billable_ms = ...`
    로 적어 두거나 `call.end(billable_ms=...)` 로 직접 닫으면 되고, **둘 다 하지 않으면 키가
    실리지 않는다**(§13-3 — 0 을 보내면 "0초 통화를 실측했다"가 된다). 이 자리가 없던 동안
    권장 사용법(`with client.session(...)`)으로 돈 통화는 **전부** 통화 분 집계에서 빠졌다 —
    `client.end(..., billable_ms=...)` 는 있었지만 컨텍스트 매니저가 그 인자를 받지 않았다.
    """

    def __init__(self, client: BridgeClient, reason_ko: str, start_kwargs: Dict[str, Any]) -> None:
        self._client = client
        self._reason_ko = reason_ko
        self._start_kwargs = start_kwargs
        self.interaction_id: Optional[str] = None
        self.started: Optional[BridgeResponse] = None
        self.ended: Optional[BridgeResponse] = None
        #: 회선이 준 §11.2 과금 구간(ms). 만들어 넣지 않는다 — None 이면 선언하지 않은 것이다.
        self.billable_ms: Optional[float] = None

    def __enter__(self) -> "_SessionContext":
        self.started = self._client.start(**self._start_kwargs)
        self.interaction_id = self.started.interaction_id
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.end()

    def end(self, reason_ko: Optional[str] = None, *, billable_ms: Optional[float] = None) -> Optional[BridgeResponse]:
        """세션을 닫는다. **멱등하다** — 이미 닫혔으면 아무것도 보내지 않고 그 결과를 돌려준다.

        예외 경로에서도 불리므로(`__exit__`) 두 번 닫으려는 호출이 실제로 일어난다. 두 번 보내면
        Core 는 멱등하게 받지만 그 호출의 `billing` 은 "이미 종료돼 실을 수 없었다"가 되고,
        호스트는 자기가 선언한 과금 구간이 실렸다고 읽는다(§11.2).
        """
        if self.ended is not None or not self.interaction_id:
            return self.ended
        declared = billable_ms if billable_ms is not None else self.billable_ms
        try:
            self.ended = self._client.end(
                self.interaction_id,
                reason_ko if reason_ko is not None else self._reason_ko,
                billable_ms=declared,
            )
        except BridgeProtocolError:
            # 브리지가 이미 죽었다면 더 할 수 있는 일이 없다. 원래 예외를 덮지 않는다.
            return None
        return self.ended

    def send_utterance(self, text: str, **kwargs: Any) -> BridgeResponse:
        return self._require_id_then(lambda i: self._client.send_utterance(i, text, **kwargs))

    def send_dtmf(self, digits: str, **kwargs: Any) -> BridgeResponse:
        return self._require_id_then(lambda i: self._client.send_dtmf(i, digits, **kwargs))

    def send_timeout(self, **kwargs: Any) -> BridgeResponse:
        return self._require_id_then(lambda i: self._client.send_timeout(i, **kwargs))

    def send_connector_result(self, ok: bool, **kwargs: Any) -> BridgeResponse:
        return self._require_id_then(lambda i: self._client.send_connector_result(i, ok, **kwargs))

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
