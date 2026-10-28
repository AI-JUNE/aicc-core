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
9. **Core 의 판정은 파내지 않고 읽는다.** 큐 배정(§9.3 `queued`·`handoff_action`)·장애 폴백
   (`fallback`)·전환 초대(`switch_invite`)·커넥터 대기(`pending_connector_id`)는 전부 **Core 가
   이미 끝낸 판정**이다. 호스트가 응답 본문을 손으로 파게 두면 저장소마다 다르게 파고, 가장 흔한
   오답이 `handoff["queue"]` 만 보는 것이다 — 대안(콜백·음성사서함)으로 간 건은 놓을 큐 id 가
   없어 `queue` 가 비고, 그 모양은 "큐를 선언하지 않은 이관"과 똑같다. 그래서 큐에 못 들어간
   고객에게 "상담사를 연결해 드리겠습니다"가 나가고, 예외도 오류 응답도 없다.
   **모르는 것은 None 이다**(§13-3) — 배선이 없어 판정 자체가 없는 상태를 False 로 적으면
   종전까지 되던 안내가 그 테넌트 전체에서 사라진다.
10. **보냈다와 실렸다를 구분한다(§11.2).** 8번이 "보낼 수 있어야 한다"였다면 이것은 "들어갔는지
   확인할 수 있어야 한다"다. 실측·통화 구간을 선언해도 실릴 자리가 없으면(장애 폴백으로 조기
   종료된 턴·커넥터 재개 턴·이미 실측이 실린 턴·두 번째 end) Core 는 **싣지 않고 사유를 돌려준다** —
   `billing`·`usage_attached`·`billable_ms_recorded`·`billing_reasons_ko`·`billing_dropped_units`
   가 그 자리다. 읽지 않으면 호스트는 보낸 것을 들어간 것으로 세고, 그 턴의 엔진 비용은 공급사
   청구서에만 남는다. 과소청구 방향이라 과다청구 차단에도 걸리지 않고 대사에서 '미설명'으로만
   돌아온다. **선언이 없었던 것(None)과 싣지 못한 것(False)을 같게 적지 않는다**(§13-3).
11. **헬스도 보냈다와 접수됐다를 구분한다(§9.3).** 10번과 같은 질문이 폴백 쪽에도 있다.
   Core 는 등록되지 않은 어댑터의 보고와 **선언하지 않은 컴포넌트**의 샘플을 조용히 버리는데
   (아무 채널이나 전체 폴백을 유발할 수 없게 하는 규칙이다) 그 응답도 `ok: True` 다. 그래서
   `health_accepted`·`health_ignored`·`health_registered`·`health_intake_known` 이 있고,
   **모름을 0 으로도 `offered` 로도 읽지 않는다** — 0 으로 읽으면 멀쩡한 보고가 전부 유실로
   집계되고, `offered` 로 읽으면 **한 건도 닿지 않는 상태가 정상으로** 집계된다(§13-3).
12. **세션을 끝내는 주체가 호스트만이 아니다(§5.3·§9.3).** End 노드 도달·재시도 소진 이관·
   Api 순회 상한·장애 폴백은 Core 가 그 턴에서 세션을 닫는다. 닫힌 세션에 온 입력은 **오류가
   아니라 멱등 처리**다 — `ok: True` · `events` 0건이고 **직전 턴의 상태·단계가 그대로** 실려
   온다. 그래서 `status`(`run_status`·`session_closed`)를 읽지 않으면 증상이 둘로 갈리는데
   둘 다 조용하다: `steps` 를 그대로 렌더하는 호스트는 마지막 안내를 **턴마다 다시** 재생하고,
   새 단계만 렌더하는 호스트는 고객이 무슨 말을 해도 **무음**이다.

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

    @property
    def connector_result_applied(self) -> Optional[bool]:
        """되돌려준 조회 결과가 **대기에 반영됐는가**. 셋 중 하나다 — True·False·None(해당 없음).

        `None` 은 "이 호출은 커넥터 결과가 아니었다"이고 실패가 아니다. `False` 는 **오류가
        아닌 실패**다: 서 있는 대기가 없거나(늦게·중복 도착) 선언한 커넥터가 서 있는 대기와
        달라 Core 가 반영하지 않은 것이다. 응답은 `ok: True` · `steps` 0건 · `events` 0건이라
        읽지 않으면 반영된 턴과 구분되지 않는다 — 호스트는 다음 발화를 기다리고 고객은 아무
        안내도 듣지 못한다(§6.1 무음). 사유는 `connector_reason_ko`, 다시 답할 대기는
        `pending_connector_id` 에 있다.
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        note = self.result.get("connector")
        if not isinstance(note, dict):
            return None
        value = note.get("resultApplied")
        return value if isinstance(value, bool) else None

    @property
    def connector_reason_ko(self) -> Optional[str]:
        """조회 결과를 반영하지 않은 사유(한국어). **Core 가 쓴 문구 그대로** 돌려준다.

        호스트가 사유를 지어내면 운영은 "왜 조회가 반영되지 않았는지"를 저장소마다 다르게
        읽는다(§2). 반영된 경우·커넥터 결과가 아닌 호출에는 None 이다.
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        note = self.result.get("connector")
        if not isinstance(note, dict):
            return None
        value = note.get("reasonKo")
        return value if isinstance(value, str) and value else None

    @property
    def switch_invite(self) -> Optional[Dict[str, Any]]:
        """§5.2 채널 전환 초대가 **이번 턴에 일어났다는 사실**. 없으면 None.

        읽지 않으면 전환이 **조용히 반쪽만** 일어난다: Core 는 `state.channel` 을 화면으로
        바꿔 이후 단계를 화면용으로 렌더하는데(통화 중인 고객이 그것을 듣는다) 링크를 보내는
        것은 호스트이고, 비-Node 호스트에 그 지시가 도착하는 자리는 여기 하나뿐이다
        (Node 호스트는 `port.invite` 로 받는다). 고객은 오지 않는 화면을 기다리고 §5.1
        사다리는 이미 전환을 골랐으므로 상담사로도 내려가지 않는다 — 예외가 나지 않는다.

        링크에 쓸 1회용 토큰(`token`)은 `include_switch_ticket=True` 로 띄운 클라이언트에만
        실린다. 실리지 않았는데(`tokenIncluded` 가 False) 링크를 만들어야 한다면 **만들지 말고
        그 사실을 운영에 알린다** — Interaction id 로 만든 링크는 1회용도 만료도 회수도 없다(§10.3).
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        invite = self.result.get("switchInvite")
        return invite if isinstance(invite, dict) else None

    @property
    def handoff(self) -> Optional[Dict[str, Any]]:
        """상담사 이관 정보(§9.3). 이관이 일어나지 않은 턴에는 None."""
        if not self.ok or not isinstance(self.result, dict):
            return None
        handoff = self.result.get("handoff")
        return handoff if isinstance(handoff, dict) else None

    @property
    def handoff_placement(self) -> Optional[Dict[str, Any]]:
        """큐 배정 판정(§9.3). Core 에 라우팅이 배선된 경우에만 실린다 — 아니면 None."""
        handoff = self.handoff
        if handoff is None:
            return None
        placement = handoff.get("placement")
        return placement if isinstance(placement, dict) else None

    @property
    def queued(self) -> Optional[bool]:
        """고객이 **정말로 상담 큐에 들어갔는가**. 셋 중 하나다 — True·False·None(모름).

        읽지 않으면 큐에 못 들어간 고객에게 "상담사를 연결해 드리겠습니다"를 안내하게 된다.
        `handoff["queue"]` 만 보면 구분이 되지 않기 때문이다: 대안(콜백·음성사서함·기존 IVR)으로
        간 건은 놓을 큐 id 를 아예 들고 있지 않아 `queue` 가 비고, 그 모양은 "큐를 선언하지 않은
        이관"과 똑같다. 음성이 바로 그 대안이 선언되는 채널이고, 그 호스트가 파이썬이다.
        예외도 오류 응답도 없다 — 고객은 오지 않는 상담사를 기다리다 끊는다.

        **모름(None)을 False 로 적지 않는다**(§13-3). 라우팅이 배선되지 않은 테넌트에는 판정
        자체가 없는데, 그것을 "큐에 못 들어갔다"로 읽으면 종전까지 되던 이관 안내가 그 테넌트
        전체에서 사라진다. 반대로 True 로 읽으면 오지 않는 상담사를 안내한다. 둘 다 조용하다.

        True 가 아닐 때 호스트가 해야 하는 일은 `handoff_action` 이며, 그 값도 없으면
        (`unavailable` — 전부 설정 결함이다) 안내를 지어내지 말고 운영에 알린다.
        """
        placement = self.handoff_placement
        if placement is None:
            return None
        value = placement.get("placement")
        if not isinstance(value, str):
            return None
        return value == "queued"

    @property
    def handoff_action(self) -> Optional[str]:
        """큐 대신 수행해야 하는 대안(`callback`·`voicemail`·`legacy_ivr`·`reject`).

        `placement == "alternative"` 에서만 실린다. Core 가 만들지 않고 **큐 설정에 선언된 값**을
        그대로 돌려준다(§13-3) — 없는 대안을 호스트가 골라 주면 그 선택이 곧 정책이 된다.
        """
        placement = self.handoff_placement
        if placement is None:
            return None
        action = placement.get("action")
        return action if isinstance(action, str) and action else None

    @property
    def billing(self) -> Optional[Dict[str, Any]]:
        """§11.2 과금 근거가 **이번 호출에서 어디까지 실렸는가**. 선언이 하나도 없었으면 None.

        어떤 노출 스위치와도 무관하게 오는 값이다(수치와 Core 가 쓴 사유뿐 — 개인정보가 없다).
        읽지 않으면 호스트는 자기가 선언한 실측이 §8.1 원장에 **들어가지 않았다는 사실**을
        알 길이 없다: 이 클라이언트의 `usage`·`billable_ms` 인자는 "보냈다"까지만 보장하고
        실릴 자리가 있었는지는 Core 가 판정한다. 그 차이는 예외로도 오류 응답으로도 나타나지
        않고, 몇 주 뒤 §11.2 대사에서 '미설명'으로만 돌아온다 — 과소청구 방향이라 과다청구
        차단에도 걸리지 않는다.
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        billing = self.result.get("billing")
        return billing if isinstance(billing, dict) else None

    @property
    def usage_attached(self) -> Optional[bool]:
        """이번 턴의 실측이 원장 이벤트에 **실제로 실렸는가**. 셋 중 하나다 — True·False·None.

        None 은 "이번 호출에 실측 선언이 없었다"이고 **실패가 아니다**(§13-3). False 로 적으면
        실측을 보내지 않은 턴까지 누락으로 세어 "근거 없는 턴" 건수가 통화 수만큼 부풀고,
        반대로 False 를 True 로 읽으면 진짜 누락이 0건으로 보인다. 둘 다 조용하다.

        False 가 되는 경로는 전부 호스트 잘못이 아니다: 장애 폴백으로 조기 종료된 턴·커넥터
        재개 턴에는 고객 발화 이벤트가 없어 실을 자리가 없고(§9.3), 이미 실측이 실린 턴은
        덮어쓰지 않는다. 사유는 `billing_reasons_ko` 에 Core 가 쓴 문구로 온다.
        """
        billing = self.billing
        if billing is None:
            return None
        value = billing.get("usageAttached")
        return value if isinstance(value, bool) else None

    @property
    def billable_ms_recorded(self) -> Optional[bool]:
        """§11.2 통화 과금 구간이 `session.ended` 에 실렸는가. 선언하지 않았으면 None.

        `end(billable_ms=...)` 를 **두 번째로** 부른 경우가 가장 흔한 False 다 — Core 는 멱등하게
        받지만 그 호출의 구간은 실리지 않으며, 호스트는 자기가 선언한 값이 들어갔다고 읽는다.
        """
        billing = self.billing
        if billing is None:
            return None
        value = billing.get("billableMsRecorded")
        return value if isinstance(value, bool) else None

    @property
    def billing_reasons_ko(self) -> List[str]:
        """과금 근거가 실리지 않은 사유(한국어). **Core 가 쓴 문구 그대로** 돌려준다.

        호스트가 사유를 지어내면 운영은 "왜 수량이 없는지"를 저장소마다 다르게 읽는다(§2).
        실린 경우·선언이 없는 경우에는 빈 목록이다 — 빈 목록을 "문제 없음"으로 읽어도 되는
        유일한 자리가 여기다(판정 자체는 `usage_attached`·`billable_ms_recorded` 가 말한다).
        """
        billing = self.billing
        if billing is None:
            return []
        out: List[str] = []
        for key in ("usageReasonKo", "billableMsReasonKo"):
            value = billing.get(key)
            if isinstance(value, str) and value:
                out.append(value)
        return out

    @property
    def billing_dropped_units(self) -> List[str]:
        """집계에서 **빠진 사용량 항목** 이름. 빠졌다는 사실을 숨기지 않는다(§11.2).

        두 가지가 섞여 온다: 같은 항목을 둘 이상이 내놓아 합산하지 않고 빼낸 것(`usageConflicts`
        — 합치면 그 자리가 곧 이중 계상이다)과, 실측으로 볼 수 없어 버린 것(`usageRejected`).
        어느 쪽이든 그 항목은 원장에 없다. 0 으로 메우지 않는다 — 0 은 "실측했고 안 썼다"다.
        """
        billing = self.billing
        if billing is None:
            return []
        out: List[str] = []
        for key in ("usageConflicts", "usageRejected"):
            value = billing.get(key)
            if isinstance(value, list):
                out.extend(str(v) for v in value)
        return out

    @property
    def fallback(self) -> Optional[Dict[str, Any]]:
        """§9.3 장애 폴백 판정. 없으면 None(= 이번 턴에 폴백 판정이 내려지지 않았다).

        Node 호스트는 `port.routeToLegacyIvr`·`port.transfer`·`port.end` 로 같은 지시를 받지만
        비-Node 호스트에는 그 자리가 없다 — 이 값이 회선을 내릴지 상담사로 넘길지를 아는
        유일한 경로다. 판정은 Core 가 끝냈으므로 호스트는 **고쳐 읽지 않는다**: `disable` 에
        담긴 구성요소를 계속 부르면 폴백은 걸린 채로 엔진 호출만 이어진다.
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        fallback = self.result.get("fallback")
        return fallback if isinstance(fallback, dict) else None

    # ── Core 가 끝낸 세션(§5.3·§8.1) ──────────────────────────────────────
    # 세션을 끝내는 주체는 **호스트만이 아니다**: End 노드 도달·재시도 소진 이관·Api 노드 순회
    # 상한·장애 폴백(§9.3)은 전부 Core 가 그 턴에서 세션을 닫는다. 그런데 그 사실이 실려 오는
    # 칸(`status`)을 읽지 않으면 호스트는 닫힌 세션에 계속 말을 보내고, 그 응답은 **오류가
    # 아니다**: Core 는 늦게 도착한 입력을 멱등으로 다루어 새 이벤트를 만들지 않고
    # (`events` 0건) **직전 턴의 상태와 단계를 그대로** 돌려준다(`ok: True`).
    # 그래서 증상은 둘인데 둘 다 조용하다 — 응답의 `steps` 를 그대로 렌더하는 호스트는
    # 마지막 안내를 **턴마다 다시** 재생하고(통화가 끝나지 않는다), 새 단계만 렌더하는 호스트는
    # 고객이 무슨 말을 해도 **무음**이다. 어느 쪽도 예외가 나지 않고 통화는 끊기지도 않는다.

    @property
    def run_status(self) -> Optional[str]:
        """Core 가 적은 이 세션의 실행 상태. 턴 응답이 아니면 None.
        `running`·`completed`·`transferred`·`failed` 이며 **값을 지어내지 않는다**(§13-3) —
        목록은 Core(`flow/runner.ts` 의 `RunStatus`)에 있고 여기서 다시 적지 않는다(§2).
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        value = self.result.get("status")
        return value if isinstance(value, str) and value else None

    @property
    def session_closed(self) -> Optional[bool]:
        """Core 세션이 **이미 닫혔는가**. 셋 중 하나다 — True·False·None(모름).

        `None` 은 상태 칸이 없는 응답(유지 루프·헬스·hello·오류)이고 **닫혔다로도 열렸다로도
        읽지 않는다**(§13-3). `True` 면 그 세션에 보낼 턴은 더 없다 — 이관(§9.3)이 함께
        실렸으면 상담사로 넘길 차례이고, 아니면 Core 의 시나리오가 끝난 것이다. 어느 쪽이든
        **호스트가 정할 일**이며(통화를 끊을지·안내를 더 할지) 이 클라이언트는 사실만 적는다.
        """
        status = self.run_status
        return None if status is None else status != "running"

    # ── §10.1 고지·동의 · §7 5.2 준수 점검 ────────────────────────────────
    # 세 칸은 **어떤 노출 스위치와도 무관하게** 와이어로 나온다(브리지가 그렇게 적어 두었다):
    # 개인정보가 없고(목적 코드·상태·정책 버전·규칙 id·건수·Core 가 쓴 사유뿐), 감추면 호스트가
    # "고지했다"·"동의를 받았다"·"점검됐다"를 증명할 길이 없기 때문이다. 그런데 **읽을 자리가
    # 이 클라이언트에 없었다** — 즉 Core 는 보냈고 권장 경로로 붙인 호스트는 세 사실을 한 번도
    # 손에 쥐지 못했다. 증상은 셋 다 예외가 아니다:
    #   - 고지(§10.1): 감사 근거가 `steps` 안에만 있어, 저장소마다 steps 를 뒤져 각자 다르게
    #     찾는다(§2). 못 찾으면 "고지했다"를 증명하는 기록이 그 배치에 0건이다.
    #   - 동의(§10.1·§6.1): 필수 동의가 미획득이면 pii 파라미터를 선언한 업무시스템 조회가
    #     **통화 중 언제나 막힌다**. 업무시스템은 멀쩡하므로 장애로 보이지 않고 "그 메뉴만
    #     안 된다"로만 나타난다 — 미획득 목적 목록이 그 상태의 유일한 신호다.
    #   - 점검(§7 5.2): `reviewed: False` 는 **위반 0건이 아니라 점검을 못 했다**는 뜻이고,
    #     그 둘을 같게 읽으면 고지 누락·마스킹 누락이 "합격"으로 집계된다.

    @property
    def disclosure(self) -> Optional[Dict[str, Any]]:
        """이번 턴에 AI 고지를 냈다는 **감사 근거**(§10.1). 고지가 없던 턴에는 None.

        문구 자체는 `steps` 맨 앞 단계로 고객에게 나갔고, 여기 있는 것은 "어느 매체에 어떤
        설정 버전으로 고지했는가"다(`channel`·`placement`·`configVersion`). 고지가 배선되지
        않았거나 이미 고지한 채널에는 실리지 않는다 — **None 을 "고지하지 않았다"로 적지
        않는다**(§13-3): 같은 통화에서 이미 고지한 뒤의 턴도 None 이다.
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        disclosure = self.result.get("disclosure")
        return disclosure if isinstance(disclosure, dict) else None

    @property
    def consent(self) -> Optional[Dict[str, Any]]:
        """§10.1 동의 사실. 적을 것이 하나도 없으면 None(동의 미배선도 같은 모양이다)."""
        if not self.ok or not isinstance(self.result, dict):
            return None
        consent = self.result.get("consent")
        return consent if isinstance(consent, dict) else None

    @property
    def consent_recorded(self) -> Optional[Dict[str, Any]]:
        """**이번 턴에 확정돼 추가 전용 이력에 쌓인** 동의(`purpose`·`state`·`policyVersion`).

        동의 질문 자체는 시나리오의 `Confirm` 단계로 이미 나갔으므로 여기 있는 것은 감사
        근거다. 동의 턴이 아니면 None이고 그것은 실패가 아니다 — 확정됐는데 **기록하지 못한**
        경우는 None 이 아니라 `consent_not_recorded_ko` 에 사유가 온다(그 동의는 근거가 없고
        개인정보 조회는 게이트에서 막힌다).
        """
        consent = self.consent
        if consent is None:
            return None
        recorded = consent.get("recorded")
        return recorded if isinstance(recorded, dict) else None

    @property
    def consent_not_recorded_ko(self) -> Optional[str]:
        """확정된 답이 있었는데 기록하지 못한 사유(한국어). **Core 가 쓴 문구 그대로** 돌려준다.

        정상 생략(동의 턴이 아님·되묻는 중)에는 실리지 않는다 — 즉 값이 있으면 그 자체가
        설정·저장 결함이고, 호스트가 사유를 지어내면 운영은 저장소마다 다르게 읽는다(§2).
        """
        consent = self.consent
        if consent is None:
            return None
        value = consent.get("notRecordedKo")
        return value if isinstance(value, str) and value else None

    @property
    def consent_pending_required(self) -> List[str]:
        """필수로 선언됐는데 **지금 획득 상태가 아닌** 목적 코드. 비어 있으면 빈 목록이다.

        Core 는 이 값으로 통화를 막지 않는다(거부 분기는 시나리오와 테넌트가 정한다). 다만
        **비어 있지 않은 동안 pii 파라미터를 선언한 §6.1 업무시스템 조회는 동의 게이트에서
        막힌다** — 그때 증상은 예외가 아니라 "그 메뉴만 안 된다"이고, 이 목록이 그 상태를
        가리키는 유일한 신호다.

        빈 목록을 "동의를 다 받았다"로 읽지 않는다: 동의가 **배선되지 않은** 테넌트도 똑같이
        비어 있다(그 테넌트에서는 동의 기록이 애초에 0건이다). 배선 여부는 와이어에서
        구분되지 않으므로 `warnings` op 의 `W_CONSENT_UNBOUND` 로 확인한다 — 그 구분을
        여기서 추측해 돌려주면 없는 근거를 만든 것이다(§13-3).
        """
        consent = self.consent
        if consent is None:
            return []
        pending = consent.get("pendingRequired")
        if not isinstance(pending, list):
            return []
        return [str(p) for p in pending]

    @property
    def compliance(self) -> Optional[Dict[str, Any]]:
        """§7 5.2 준수 점검 요약. **세션이 끝난 응답에만** 실린다 — 아니면 None.

        점검은 세션 전체를 한꺼번에 보므로 턴 응답에는 없다. 위반 요약만 오고 근거 이벤트
        id·검출 표현·금칙어 문구는 애초에 담기지 않는다(§2·§10.3).
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        compliance = self.result.get("compliance")
        return compliance if isinstance(compliance, dict) else None

    @property
    def compliance_reviewed(self) -> Optional[bool]:
        """점검이 **실제로 수행됐는가**. 셋 중 하나다 — True·False·None(이 응답에는 요약이 없다).

        **False 를 "위반 없음"으로 읽지 않는다**(§13-3). False 는 점검을 수행하지 못했다는
        뜻이고(수집 이벤트 0건·스코프 밖 기록 혼입 등) 사유는 `compliance_reason_ko` 에 온다.
        그 둘을 같게 읽으면 고지 누락·녹취 중 마스킹 누락이 "합격"으로 집계되는데, 드러나는
        시점이 감독기관 점검이면 대상은 지나간 통화 전부다.
        """
        compliance = self.compliance
        if compliance is None:
            return None
        value = compliance.get("reviewed")
        return value if isinstance(value, bool) else None

    @property
    def compliance_violations(self) -> List[str]:
        """위반이 잡힌 규칙 id. 빈 목록이 "위반 없음"인지는 `compliance_reviewed` 가 말한다.

        `skipped`(점검하지 못한 규칙)는 여기 섞지 않는다 — 건너뛴 검사는 통과의 근거가 아니고,
        합쳐 세면 "위반 n건"이 "점검 못 한 n건"과 같은 숫자가 된다(고칠 곳은 서로 다르다).
        """
        compliance = self.compliance
        if compliance is None:
            return []
        violated = compliance.get("violated")
        if not isinstance(violated, list):
            return []
        return [str(v) for v in violated]

    @property
    def compliance_skipped(self) -> List[str]:
        """점검하지 **못한** 규칙 id. 이 목록에 있는 규칙은 합격이 아니라 미점검이다."""
        compliance = self.compliance
        if compliance is None:
            return []
        skipped = compliance.get("skipped")
        if not isinstance(skipped, list):
            return []
        out: List[str] = []
        for item in skipped:
            if isinstance(item, dict) and isinstance(item.get("ruleId"), str):
                out.append(item["ruleId"])
        return out

    @property
    def compliance_reason_ko(self) -> Optional[str]:
        """점검을 수행하지 못한 사유(한국어). **Core 가 쓴 문구 그대로** 돌려준다."""
        compliance = self.compliance
        if compliance is None:
            return None
        value = compliance.get("reasonKo")
        return value if isinstance(value, str) and value else None

    # ── §9.3 헬스 접수 범위 ────────────────────────────────────────────────
    # `report_health` 의 응답은 "몇 건을 보냈다"가 아니라 **몇 건이 §9.3 판정에 닿았는가**다.
    # 그 차이를 읽지 않으면 샘플을 성실히 올리는 호스트와 **한 건도 전달되지 않는** 호스트가
    # 바깥에서 구분되지 않는다: Core 는 등록되지 않은 어댑터의 보고와 **선언하지 않은
    # 컴포넌트**의 샘플을 조용히 버리는데(아무 채널이나 전체 폴백을 유발할 수 없게 하는 §9.3
    # 의 규칙이다), 그 상태에서도 응답은 `ok: True` 다. 증상은 양쪽 다 조용하다 — 엔진이 전부
    # 죽어도 판정은 `normal` 이고(고객은 "말을 못 알아듣는다"로 겪는다), 한 번 내려간 테넌트는
    # 샘플이 갱신되지 않아 **영구히** 폴백에 남는다.
    #
    # **보낸 수를 접수된 수로 읽지 않는다**(§13-3·§11.2 의 `usage_attached` 와 같은 규칙).
    def _health_intake(self) -> Optional[Dict[str, Any]]:
        """헬스 접수 범위 응답인가. 판정은 `acceptedKnown` 하나로 한다 — 브리지가 그 키를
        **항상** 싣기 때문이고(아는 경우·모르는 경우 둘 다), 다른 키로 추측하면 종전 응답과
        구분되지 않는다.
        """
        if not self.ok or not isinstance(self.result, dict):
            return None
        return self.result if isinstance(self.result.get("acceptedKnown"), bool) else None

    @property
    def health_intake_known(self) -> Optional[bool]:
        """접수 범위를 **알 수 있는가**. 셋 중 하나다 — True·False·None(헬스 응답이 아님).

        `False` 는 Core 구현이 접수 범위를 돌려주지 않는다는 뜻이고(종전 `void` 반환),
        그 상태를 "접수됨"으로 적어서는 안 된다. 사유는 `health_reason_ko` 에 있다.
        """
        intake = self._health_intake()
        return None if intake is None else bool(intake.get("acceptedKnown"))

    @property
    def health_offered(self) -> Optional[int]:
        """올린 샘플 수(브리지가 해석한 수). **접수된 수가 아니다.**"""
        intake = self._health_intake()
        if intake is None:
            return None
        value = intake.get("offered")
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    @property
    def health_accepted(self) -> Optional[int]:
        """§9.3 헬스 레지스트리에 **실제로 기록된** 샘플 수. 모르면 None — **0 이 아니다.**

        모르는 것을 0 으로 읽으면 "접수 0건"이 되어 멀쩡한 보고가 전부 유실로 집계되고,
        `offered` 로 읽으면 반대로 **한 건도 닿지 않는 상태가 정상으로** 집계된다(§13-3).
        """
        intake = self._health_intake()
        if intake is None or intake.get("acceptedKnown") is not True:
            return None
        value = intake.get("accepted")
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    @property
    def health_ignored(self) -> Optional[int]:
        """선언되지 않은 컴포넌트라 **버려진** 샘플 수. 0 이 아니면 선언 목록·오타를 봐야 한다."""
        intake = self._health_intake()
        if intake is None or intake.get("acceptedKnown") is not True:
            return None
        value = intake.get("ignored")
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    @property
    def health_registered(self) -> Optional[bool]:
        """이 어댑터가 Core 에 등록돼 있는가. `False` 면 **한 건도** 기록되지 않았다."""
        intake = self._health_intake()
        if intake is None or intake.get("acceptedKnown") is not True:
            return None
        value = intake.get("registered")
        return value if isinstance(value, bool) else None

    @property
    def health_declared(self) -> List[str]:
        """이 채널이 올릴 수 있다고 **등록 시 선언한** 컴포넌트(Core 가 가진 값).

        호스트가 보낸 이름은 되돌려 오지 않는다(§10.3 — 그 자리에는 임의 문자열이 들어올 수
        있다). 대신 이 목록으로 오타를 호스트가 스스로 맞춰 본다.
        """
        intake = self._health_intake()
        if intake is None:
            return []
        value = intake.get("declared")
        return [str(c) for c in value] if isinstance(value, list) else []

    @property
    def health_reason_ko(self) -> Optional[str]:
        """접수 범위를 알 수 없는 사유(한국어). **Core·브리지가 쓴 문구 그대로** 돌려준다."""
        intake = self._health_intake()
        if intake is None:
            return None
        value = intake.get("reasonKo")
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
        include_switch_ticket: bool = False,
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
        # §5.2 전환 링크를 **이 호스트가 직접 만들어 보낼 때만** 켠다(기본 꺼짐, §10.3).
        #
        # 이 스위치가 없던 동안 브리지·실행기에는 자리가 있는데 참조 클라이언트에서 켤 길이
        # 없었다 — 그리고 음성(Callbot)이 바로 §5.2 전환이 일어나는 쪽이고 그 호스트가 파이썬이다.
        # 그 배치에서 호스트가 받는 것은 `ticketIssued: true` · `tokenIncluded: false` 이므로,
        # 링크를 만들려면 Interaction id 를 쓸 수밖에 없다 — 그 순간 1회용·만료·회수가 전부
        # 무의미해지고(`core/executeSwitch.ts` 가 막겠다고 적어 둔 사고다) 링크 URL·프록시 로그·
        # 상담 메모에 남은 id 가 곧 진행 중인 상담 화면의 열쇠가 된다. 어디에서도 예외가 나지 않는다.
        if include_switch_ticket:
            argv.append("--include-switch-ticket")

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

    def send_unrecognized(
        self,
        interaction_id: str,
        text: str = "",
        *,
        latency: Optional[Dict[str, float]] = None,
        usage: Optional[Dict[str, float]] = None,
    ) -> BridgeResponse:
        """고객은 말했지만 **무엇을 원하는지 확정하지 못했다**(§5.1·§6.2).

        인식기·호스트 NLU 가 no-match 를 돌려준 턴은 이것으로 보낸다. `text` 는 인식된 원문이며
        아무 말도 돌려받지 못했으면 빈 문자열이다(그 상태도 유효한 미인식이다).

        **`send_utterance` 로 바꿔 보내지 않는다.** `Collect` 노드는 비어 있지 않은 텍스트를
        무조건 수락하므로, 미인식 발화를 발화로 올리면 "카드를 잃어버렸어요"가 **슬롯 값으로
        저장된 채** 흐름이 다음 노드로 넘어간다 — 예외도 재프롬프트도 없고 고객은 엉뚱한 안내를
        듣는다. `send_timeout` 으로 바꿔 보내는 것도 틀리다: 무입력과 미인식은 §5.1 사다리에서
        다른 단계이고, 말을 한 고객이 침묵으로 집계된다.

        **`confidence` 는 받지 않는다**: 이 입력에는 실을 자리가 없다(§13-3). 저신뢰 인식을
        그대로 올려 Core 가 §5.1 신뢰도 조건으로 판정하게 하려면 `send_utterance(confidence=...)`
        를 쓴다 — 어느 쪽을 보낼지는 인식기가 "값이 낮다"와 "매칭이 없다" 중 무엇을 말했는지로 갈린다.
        """
        turn: Dict[str, Any] = {"input": {"kind": "unrecognized", "text": text}}
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
        connector_id: Optional[str] = None,
    ) -> BridgeResponse:
        """업무시스템 조회 결과를 되돌려준다(§6.1 — `pending_connector_id` 가 섰을 때).

        `ok` 는 **명시해야 한다** — 빠진 값을 성공으로 읽으면 실패한 조회가 성공으로 흘러간다.
        `slots` 는 커넥터 계층에서 허용목록·마스킹을 마친 값만 넣는다(§10.3). 실패면 `error_code`
        를 주면 시나리오의 `onError` 분기가 그 코드를 근거로 갈라진다. 분기가 없으면 Core 가
        상담사로 내린다 — 조회 실패로 콜을 끊지 않는다(§9.3).

        **`usage` 는 받지 않는다**: 커넥터 재개 턴에는 고객 발화 이벤트가 없어 Core 가 실측을
        실을 자리가 없다(그 턴의 §6.1 커넥터 실측을 어디에 집계할지는 지표 정의 문제이며 Core 가
        정하지 않는다). 받아서 보내면 응답 `billing` 에 "실을 자리가 없었다"만 적힌다.

        `connector_id` 는 **어느 대기에 답하는가**를 선언하는 칸이고, 넘기려면 그 턴의
        `pending_connector_id` 를 그대로 넘긴다(직접 적지 않는다 — 적으면 그 문자열이 곧
        두 번째 설정이 된다). 선언하면 Core 가 서 있는 대기와 대조해 **다르면 반영하지 않고**
        사유를 돌려준다. 선언하지 않으면 종전과 완전히 같다(§13-3): Core 는 Api 노드에 도착한
        결과를 어느 커넥터의 답인지 묻지 않고 수락하므로, 조회 A 의 결과가 늦게·중복으로
        도착하면 그때 서 있는 조회 B 의 답으로 적용된다 — 고객은 **다른 조회의 값으로 채워진
        안내**를 듣고 예외도 오류 응답도 없다. 업무시스템 호출이 느려 재전송하는 호스트가
        정확히 그 모양을 만든다.
        """
        payload: Dict[str, Any] = {"kind": "connectorResult", "ok": bool(ok)}
        if slots:
            payload["slots"] = slots
        if error_code:
            payload["errorCode"] = error_code
        if connector_id:
            payload["connectorId"] = connector_id
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

    def send_unrecognized(self, text: str = "", **kwargs: Any) -> BridgeResponse:
        return self._require_id_then(lambda i: self._client.send_unrecognized(i, text, **kwargs))

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
