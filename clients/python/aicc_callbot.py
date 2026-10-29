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
    @agent.on("transcript")  ... await hooks.on_transcript(call.call_id, role, text, usage=turn_usage)
    @agent.on("call_end")    ... await hooks.on_call_end(call.call_id, billable_ms=call.billable_ms)

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
   종료에는 §11.2 통화 과금 구간(`billable_ms`)을 함께 넘길 수 있다. **만들어 넣지 않는다**(§13-3):
   회선이 주지 않으면 그 통화는 통화 분 집계에서 빠지고, 그 건수를 `ends_missing_billable_ms` 로
   센다 — 세지 않으면 "청구할 근거가 없는 통화"가 몇 건인지 모르는 채 월말이 온다.
6. **발화·응답을 print 하지 않는다(§10.3).** 이 파일은 어떤 것도 출력하지 않는다.
   결과가 필요하면 `on_turn` 콜백으로 받는다(상담사용 요약·슬롯 값은 기본적으로 들어 있지 않다).
6-1. **턴 단위 실측을 받을 자리를 둔다(§11.2·§13).** 회선·엔진이 측정한 `usage`(STT/TTS 구간·LLM
   토큰)와 `latency` 는 **훅으로만** 들어올 수 있다 — Core 는 음성 엔진을 직접 부르지 않으므로
   (§6.2) 여기서 넘기지 않으면 그 수량은 §8.1 원장에 한 줄도 남지 않는다. 그 방향은 과소청구라
   청구를 막지도 않고, 공급사 청구서와의 차이는 몇 주 뒤 대사에서 '미설명'으로만 나타난다(§11.2).
   **추정하지 않는다**(§13-3): 회선이 주지 않으면 싣지 않고, 선언 없이 보낸 턴을
   `stats.turns_missing_usage` 로 센다 — 세지 않으면 "근거 없는 턴"이 몇 건인지 모르는 채 월말이 온다.
6-2. **보낸 것을 들어간 것으로 세지 않는다(§11.2).** 선언 건수만 세면 카운터가 "근거 있는 턴"을
   **과대 보고**한다 — 실을 자리가 없어 버려진 실측(장애 폴백으로 조기 종료된 턴·커넥터 재개 턴·
   이미 실측이 실린 턴·두 번째 end)도 선언된 턴으로 세기 때문이다. Core 가 응답에 그 판정을
   돌려주므로(`billing`) 그대로 읽어 `turns_usage_unattached`·`turns_usage_dropped`·
   `ends_billable_ms_unrecorded` 로 **나눠 센다**. 합쳐 세면 "회선이 값을 주지 않았다"와
   "준 값이 버려졌다"가 같은 숫자가 되는데, 둘의 고칠 곳은 서로 다른 저장소다.
7. **한도 초과는 장애가 아니다(§9.3).** `E_RATE_LIMITED` 를 브리지 사망과 같게 다루면 통화 전체가
   Core 를 잃는다. 대신 브리지가 준 `retryAfterMs` 동안 **그 통화의 턴만** 보내지 않는다.
   대기 시간을 주지 않았으면 대기하지 않는다(없는 근거를 만들지 않는다, §13-3).
   **종료(`on_call_end`)·`close()` 는 어떤 경우에도 미루지 않는다** — 브리지도 end 를 제한하지 않고,
   닫히지 않은 세션은 장애가 아니라 요금으로 먼저 나타난다.
8. **업무시스템 조회 대기(§6.1)를 끝까지 꿴다.** Api 노드에 닿은 턴의 응답에는 발화가 아니라
   **조회 결과를 기다린다는 사실**(`pending_connector_id`)이 실려 온다. 그 자리가 없던 동안
   음성 호스트에는 답을 되돌려줄 방법이 아예 없었고, 증상은 예외가 아니라 **무음**이다:
   고객이 무슨 말을 해도 `steps` 0건·`events` 0건이 돌아오고 오류도 아니라서 통화는 끊기지도
   않은 채 멈추고 어떤 알림도 울리지 않는다("그 메뉴만 안 된다"로만 나타난다).
   `on_connector_result` 는 **어댑터가 본 대기 id 를 함께 선언한다** — 호스트가 그 값을 들고
   다니며 상관짓지 않아도 되고(들고 다니게 하면 통화 두 건이 겹치는 순간 섞인다), 선언이
   어긋나면 Core 가 반영하지 않는다. 대기를 본 적이 없으면 **보내지 않고 알린다**: 서지 않은
   대기에 답하는 것은 호스트 버그이고, 조용히 보내면 그 응답은 성공으로 돌아온다.
   조회 결과는 **한도 대기에 걸려도 미루지 않는다** — 미루면 그 통화는 답을 받지 못해 무음으로
   멈춘다(종료를 미루지 않는 것과 같은 이유다).
9. **§9.3 지시가 도착할 자리를 둔다.** 이관·폴백 판정은 Core 가 끝내고 **수행은 호스트가** 한다.
   그런데 비-Node 호스트에 그 지시가 닿는 경로는 턴 응답 하나뿐이어서, 응답 원문을 그대로
   넘겨 두면 저장소마다 `result["handoff"]["placement"]["placement"]` 를 각자 파싱하다 각자
   다르게 틀린다 — 가장 비싼 오답은 **큐에 들어가지 못한 고객에게 "상담사를 연결해
   드리겠습니다"를 안내하는 것**이다(대안으로 간 건은 놓을 큐 id 가 없어 `queue` 가 비고,
   그 모양은 "큐를 선언하지 않은 이관"과 같다). 그래서 판정된 값만 `on_handoff`·`on_fallback`
   으로 넘긴다: **모름(None)을 False 로 적지 않고**(§13-3), 상담사용 요약은 담지 않으며
   (§2·§10.3), 같은 폴백 모드를 턴마다 다시 알리지 않는다(알리면 같은 안내가 반복된다).
10. **유지 루프를 부를 자리를 둔다(§9.3·§2).** Core 는 **타이머를 돌리지 않는다**(몰래 켠
   인터벌은 끌 수도 없고 프로세스 종료를 막는다) — 그래서 만료 수렴·초대 정리·복구 확인·
   readiness·상담사 응답·헬스 보고는 **호스트가 부른다**. `aicc_bridge.py` 에는 그 자리가 다
   있었는데 `agent.py` 가 손에 쥐는 것은 이 어댑터이고 브리지 클라이언트는 어댑터 안에서
   **지연 생성되는 비공개 필드**였다 — 즉 권장 경로로 붙인 음성 배치에서는 유지 루프를
   부를 방법이 아예 없었고, **한 번도 돌지 않았다**. 증상은 하나도 예외가 아니다:
     - 복구 확인 미호출 → 한 번 `degraded_ai`·`agent_only` 로 내려간 테넌트는 엔진이
       돌아와도 **영구히** 폴백에 남는다(통화가 내려가 엔진 호출이 멈추므로 새 샘플을
       만들 주체가 프로브뿐인데, 그 프로브를 아무도 부르지 않는다).
     - 헬스 보고 미호출 → §9.3 레지스트리에 **회선 샘플이 한 건도 없다**. 음성 L1 은
       `telephony` 이고 그것을 아는 것은 회선뿐이다(Core 는 엔진·매체를 직접 찌르지 않는다).
     - 만료 수렴 미호출 → 만료된 오퍼가 열린 채 쌓여 같은 콜이 두 번 제안되고, 그 통화는
       큐에 묶인 채 §9.3 대안(콜백·음성사서함)으로도 가지 않는다.
     - readiness 미호출 → 모든 통화가 상담사 직결로 떨어진 순간에도 호스트 `/health` 는 초록이다.
     - 상담사 응답 미반영 → 재배정도 소진 수렴도 없다("상담사가 안 받는다"와 구분되지 않는다).
     - 관측 미조회 → 로거·수집기가 전부 던지는 상태(`failed`)가 "로그를 붙였다"와 구분되지 않는다.
     - 초대 정리 미호출 → §5.2 전환 초대가 레지스트리에서 **나가지 않는다**(상환·만료는 상태만
       바꾼다). Node 호스트는 자기가 만든 레지스트리를 직접 정리할 수 있지만 권장 경로에서는
       그것을 만드는 쪽이 브리지가 읽는 Core 모듈이다 — 음성 에이전트는 며칠을 살고, 초대
       안에는 §10.3 승계 슬롯 스냅샷이 들어 있다.
   **주기는 이 어댑터가 정하지 않는다**(§13-3 — 회선 수·상담사 수에 따라 다르다). 자리만 열고,
   유지 루프의 실패는 **통화 경로를 건드리지 않는다**: 배선되지 않은 op(`E_NOT_WIRED`)는
   브리지 사망이 아니므로 `degraded` 로 올리지 않는다(올리면 유지 루프 설정 하나가 그
   프로세스의 모든 통화에서 Core 를 떼어 간다).
11. **브리지 사망 래치를 풀 길을 둔다(§9.3).** 3번의 `degraded` 는 한 번 서면 프로세스가
   끝날 때까지 풀리지 않았다 — 음성 에이전트는 며칠을 산다. 즉 줄 하나를 깨뜨린 일시적
   예외가 **그 프로세스의 남은 모든 통화**에서 Core 를 떼어 가고, 그 상태는 조용하다(통화는
   정상으로 끝나고 §8.1 원장·과금 근거·이벤트만 0건이 된다). `recover()` 가 죽은 클라이언트를
   버리고 래치를 푼다 — **호스트가 부르며 어댑터가 재시도 루프를 만들지 않는다**(턴마다 다시
   붙으려 하면 죽은 브리지를 통화마다 다시 띄운다). 멀쩡한 브리지는 **건드리지 않는다**:
   그때 내리면 진행 중인 세션이 통째로 사라진다. 통화의 interactionId 도 지어내 고치지 않는다 —
   장애를 건너 살아 있던 통화의 턴은 새 브리지가 모르는 세션이라 **사실대로 실패**하고, 그것을
   "끝난 통화의 지연 전사"로 바꿔 적으면 끝나지 않은 통화를 끝났다고 적는 것이 된다(§13-3).

12. **§10.1 고지·동의와 §7 5.2 점검이 도착할 자리를 둔다.** 세 칸은 판정이 아니라 **남길
   근거**이고, 그래서 Core 는 어떤 노출 스위치와도 무관하게 응답에 싣는다(개인정보가 없다 —
   목적 코드·상태·정책 버전·규칙 id·건수·Core 가 쓴 사유뿐). 그런데 읽을 자리가 없던 동안
   **세 사실은 음성 호스트에 한 번도 도착하지 않았다**. 증상은 셋 다 예외가 아니다:
     - 고지(§10.1): 감사 근거가 `steps` 안에만 있어 저장소마다 steps 를 뒤져 각자 다르게
       찾는다(§2). 못 찾으면 "고지했다"를 증명하는 기록이 그 배치에 **0건**이고, 드러나는
       시점이 감독기관 점검이면 대상은 지나간 통화 전부다.
     - 동의(§10.1·§6.1): 필수 동의가 미획득이면 pii 파라미터를 선언한 업무시스템 조회가
       **통화 중 언제나 막힌다**. 업무시스템은 멀쩡하므로 장애로 보이지 않고 "그 메뉴만
       안 된다"로만 나타난다 — 미획득 목적 목록이 그 상태의 유일한 신호다. 그리고 답이
       확정됐는데 **기록되지 않은** 경우(이력 저장 실패)는 동의를 받은 것과 와이어에서
       구분되지 않았다.
     - 점검(§7 5.2): `reviewed: False` 는 위반 0건이 아니라 **점검을 못 했다**는 뜻이고,
       요약이 아예 오지 않는 것은 **점검이 배선되지 않았다**는 뜻이다. 셋을 같게 읽으면
       고지 누락·녹취 중 마스킹 누락이 "합격"으로 집계된다.
   `on_disclosure`·`on_consent`·`on_compliance` 로 판정된 값만 넘긴다. **빈 목록을 "다
   받았다"로, 없는 칸을 "위반 없음"으로 적지 않고**(§13-3), 동의는 **서 있는 값이 바뀐
   턴에만**, 점검은 **통화당 한 번만** 알린다(되풀이하면 같은 안내·기록이 턴 수만큼 쌓인다).

13. **§5.2 화면 전환 지시가 도착할 자리를 둔다.** §5.1 사다리는 2회 실패에서 **화면 전환**을
   고르고, 그 지시를 수행하는 것은 호스트다(링크 발송). Node 호스트는 `port.invite` 로 받지만
   비-Node 호스트에 그 지시가 닿는 자리는 **턴 응답 하나뿐**이고, 읽을 자리가 없던 동안 음성
   배치에서 전환은 **조용히 반쪽만** 일어났다: Core 는 `state.channel` 을 화면으로 바꿔 이후
   단계를 화면용으로 렌더하는데(통화 중인 고객이 그것을 듣는다) **링크는 아무도 보내지
   않는다**. 고객은 오지 않는 화면을 기다리고, 사다리는 이미 전환을 골랐으므로 상담사로
   내려가지도 않으며, 어디에서도 예외가 나지 않는다.
   `on_switch` 로 판정된 값만 넘기고 **네 가지 상태를 섞지 않는다**(§13-3) — 고칠 곳이 다르다:
     - 토큰까지 왔다 → 링크를 **그 토큰으로** 만든다.
     - 발급은 됐는데 토큰이 오지 않았다(`token_included=False`) → 노출 스위치가 꺼져 있다.
       **Interaction id 로 링크를 만들지 않는다**(1회용·만료·회수가 전부 무의미해진다, §10.3) —
       링크를 이 호스트가 직접 만든다면 `include_switch_ticket=True` 로 켠다.
     - 전환 배선이 없어 토큰 없이 초대했다(`tokenless`) → 링크의 열쇠가 곧 id 인 **종전 상태**다.
     - 발급에 실패했다(`not_issued_ko`) → **링크를 보내서는 안 된다**. 사유를 운영에 알린다.
14. **Core 가 끝낸 세션에는 더 보내지 않는다(§5.3·§8.1).** 세션을 끝내는 주체가 호스트만이
   아니다 — End 노드 도달·재시도 소진 이관·Api 순회 상한·장애 폴백은 Core 가 그 턴에서
   세션을 닫는다. 닫힌 세션에 온 입력은 **오류가 아니라 멱등 처리**라 `ok: True`·`events`
   0건이고 **직전 턴의 상태·단계가 그대로** 실려 온다. 그래서 그 사실(`status`)을 읽지 않으면
   증상이 둘로 갈리는데 둘 다 조용하다: 응답 단계를 그대로 렌더하는 호스트는 마지막 안내를
   **턴마다 다시** 재생하고, 새 단계만 렌더하는 호스트는 고객이 무슨 말을 해도 **무음**이다.
   그래서 호스트 종료(`late_after_end`)와 **같은 규칙**으로 다룬다: 보내지 않고 건수로 남기며
   (`turns_after_core_close`), 닫혔다는 사실은 `on_session_closed` 로 **통화당 한 번** 알린다.
   **통화를 끊지 않는다** — 끊을지·안내를 더 할지는 호스트가 정하고(이관이 함께 실린 세션은
   상담사로 넘길 차례다), 어댑터는 사실만 적는다. 종료(`on_call_end`)는 그대로 보낸다:
   Core 는 멱등하게 받고 그 호출의 과금 근거 판정을 돌려준다.

무엇을 하지 않는가 (build now, activate on approval)
---------------------------------------------------
회선·STT/TTS·전환(transfer)을 만지지 않는다. 브리지는 기본 dry_run 이며 live 는 **[승인 필요]** 다.
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Mapping, Optional

from aicc_bridge import BridgeClient, BridgeProtocolError, BridgeResponse

__all__ = ["CallbotCoreHooks", "AsyncCallbotCoreHooks", "HookStats"]

_TRUTHY = ("1", "true", "yes", "on")

ErrorHook = Callable[[str, str], None]          # (code, message_ko)
TurnHook = Callable[[str, Any], None]           # (call_id, result payload)
#: (call_id, {"queued": bool|None, "action": str|None, "queue": str|None}) — §9.3 이관 지시.
#: 상담사용 요약·슬롯 값은 담기지 않는다(§2·§10.3).
HandoffHook = Callable[[str, Dict[str, Any]], None]
#: (call_id, mode, disable) — §9.3 폴백 판정. mode 가 바뀐 턴에만 불린다.
FallbackHook = Callable[[str, str, tuple], None]
#: (call_id, {"channel": str|None, "placement": str|None, "config_version": int|None}) — §10.1 고지
#: 감사 근거. 고지가 나간 턴에만 불린다(문구 자체는 이미 고객에게 나갔다).
DisclosureHook = Callable[[str, Dict[str, Any]], None]
#: (call_id, {"recorded": dict|None, "not_recorded_ko": str|None, "pending_required": tuple}) —
#: §10.1 동의. 이번 턴에 확정된 사실이 있거나 **미획득 필수 목적 목록이 바뀐** 턴에만 불린다.
ConsentHook = Callable[[str, Dict[str, Any]], None]
#: (call_id, {"reviewed": bool|None, "violations": tuple, "skipped": tuple, "reason_ko": str|None}) —
#: §7 5.2 준수 점검 요약. 세션이 끝난 응답에만 실리므로 통화당 한 번 불린다.
ComplianceHook = Callable[[str, Dict[str, Any]], None]
#: (call_id, {"to_channel", "from_channel", "ticket_issued", "token_included", "token",
#: "expires_at", "tokenless", "not_issued_ko"}) — §5.2 전환 초대. 전환이 일어난 턴에만 불린다.
#: 링크를 보내는 것은 **호스트**이며, 토큰이 없으면 **id 로 만들지 않는다**(머리말 13번).
SwitchHook = Callable[[str, Dict[str, Any]], None]
#: (call_id, status) — Core 가 이 세션을 닫았다. 통화당 한 번 불린다(머리말 14번).
#: `status` 는 Core 가 적은 값 그대로다(`completed`·`transferred`·`failed` …) — 어댑터가 고르지 않는다.
SessionClosedHook = Callable[[str, str], None]
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
    #: Core 가 한도 초과로 **거절한** 건수. 브리지 사망(degraded)과 다르다 — 기다리면 풀린다.
    turns_rate_limited: int = 0
    starts_rate_limited: int = 0
    #: 한도 대기 중이라 **보내지 않은** 건수. 거절과 나눠 세지 않으면 "한도를 얼마나 밀어붙였는지"를 못 본다.
    turns_deferred: int = 0
    starts_deferred: int = 0
    #: §11.2 통화 과금 구간을 선언하지 않고 닫은 통화 수. 그 통화는 통화 분 집계에서 빠진다 —
    #: 추정으로 메우지 않으므로(§13-3) 이 건수가 곧 "청구 근거가 없는 통화 수"다.
    ends_missing_billable_ms: int = 0
    #: §11.2 턴 단위 실측(`usage`)을 선언하지 않고 보낸 턴 수. 통화 구간과 같은 이유로 센다 —
    #: 그 턴의 STT·TTS·LLM 수량은 원장에 없고 공급사 청구서에만 남는다.
    turns_missing_usage: int = 0
    #: 실측이 **있었는데 원장에 실리지 않은** 턴 수(Core 판정 `billing.usageAttached == False`).
    #: 위의 `turns_missing_usage` 와 전혀 다른 숫자다 — 그쪽은 "우리가 선언하지 않았다"이고
    #: 이쪽은 "선언했는데 Core 에 실을 자리가 없었다"다. 둘을 합쳐 세면 "선언만 하면 집계된다"는
    #: 거짓 안심이 남는다: 장애 폴백으로 조기 종료된 턴·커넥터 재개 턴에는 고객 발화 이벤트가
    #: 없어 실측을 실을 자리가 애초에 없다(§9.3·§11.2). 사유는 응답의 `billing_reasons_ko` 에 있다.
    turns_usage_unattached: int = 0
    #: 집계에서 빠진 사용량 **항목**이 하나라도 있던 턴 수(이중 출처·실측으로 볼 수 없는 값).
    #: 턴 자체는 성공이고 수량만 빠지므로, 세지 않으면 어디에서도 드러나지 않는다.
    turns_usage_dropped: int = 0
    #: §11.2 통화 구간을 **선언했는데 실리지 않은** 종료 수(`billing.billableMsRecorded == False`).
    #: `ends_missing_billable_ms`(선언 자체가 없음)와 나눠 센다 — 합치면 "회선이 값을 주지 않았다"와
    #: "준 값이 버려졌다"가 같은 숫자가 되고, 둘의 고칠 곳은 서로 다른 저장소다.
    ends_billable_ms_unrecorded: int = 0
    #: §6.1 Api 대기가 **새로 선** 턴 수(= 호스트가 업무시스템을 부를 차례가 된 횟수).
    #: 이 값이 올라가는데 `connector_results_sent` 가 따라오지 않으면, 그 통화들은 조회 결과를
    #: 기다리다 **무음으로** 멈춘 것이다 — 예외도 오류 응답도 없으므로 이 두 수의 차이가 유일한 신호다.
    connector_waits: int = 0
    connector_results_sent: int = 0
    #: 대기를 본 적이 없는데 조회 결과를 되돌려주려 한 횟수. **보내지 않았다**(머리말 8번).
    connector_results_unexpected: int = 0
    #: 보냈는데 Core 가 **반영하지 않은** 건수(`connector.resultApplied == False`).
    #: 늦게·중복 도착했거나 선언한 커넥터가 서 있는 대기와 다른 경우다. 사유는 응답에 있다.
    connector_results_not_applied: int = 0
    #: §9.3 이관이 일어난 통화 수(통화당 한 번만 센다 — 끝난 통화의 응답에는 이관이 계속 실려 온다).
    handoffs_requested: int = 0
    #: 그중 **큐에 들어가지 못한** 건수(대안·거절). 이 수만큼 "상담사 연결" 안내를 하면 안 된다.
    handoffs_not_queued: int = 0
    #: 큐 배정 판정 자체가 없던 건수(라우팅 미배선). **못 들어갔다로 세지 않는다**(§13-3).
    handoffs_placement_unknown: int = 0
    #: §9.3 폴백 모드가 바뀐 횟수(정상 → 폴백 → 정상 전부 포함).
    fallback_changes: int = 0
    #: §5.2 전환 초대가 응답에 실려 온 횟수. 아래 셋과 **반드시 같이 읽는다** — 전환이
    #: 일어났다는 것과 링크를 보낼 수 있었다는 것은 다른 질문이다(머리말 13번).
    switch_invites_seen: int = 0
    #: 그중 **토큰까지 받은** 건수. 링크를 그 토큰으로 만들 수 있는 유일한 경우다.
    switch_tokens_received: int = 0
    #: 발급은 됐는데 **토큰이 오지 않은** 건수(노출 스위치가 꺼져 있다). 이 수만큼 호스트는
    #: 링크를 만들 수 없다 — id 로 만들면 1회용·만료·회수가 전부 무의미해진다(§10.3).
    switch_tokens_withheld: int = 0
    #: 전환 배선이 없어 **토큰 없이** 초대한 건수(종전 상태 — 링크의 열쇠가 곧 id 다).
    #: 위의 `switch_tokens_withheld` 와 합쳐 세지 않는다: 저쪽은 이 호스트의 스위치이고
    #: 이쪽은 Core 쪽 배선이라 고칠 곳이 다른 저장소다.
    switch_tokenless: int = 0
    #: 발급에 **실패한** 건수. 그 전환은 링크를 보내서는 안 된다(사유는 응답에 있다).
    switch_tickets_unissued: int = 0
    #: Core 가 **먼저 닫은** 세션 수(통화당 한 번). End 노드 도달·재시도 소진 이관·Api 순회
    #: 상한·장애 폴백이 전부 여기로 온다 — 호스트 종료(`calls_ended`)와 다른 숫자다.
    calls_closed_by_core: int = 0
    #: Core 가 닫은 세션에 보내려 한 턴 수. **보내지 않았다**(머리말 14번) — 보내면 응답은
    #: `ok: True` 로 직전 턴의 단계를 되풀이하고, 그 턴은 안내 반복이나 무음으로 나타난다.
    #: `late_after_end`(호스트가 닫은 뒤)와 나눠 센다: 둘의 고칠 곳이 다르다(시나리오 vs 호스트).
    turns_after_core_close: int = 0
    #: §10.1 AI 고지 감사 근거가 응답에 실려 온 횟수. 0 인 채 통화가 쌓이면 그 배치에서는
    #: **어떤 통화에도 고지가 나가지 않았다**(고지 미배선) — 통화·이벤트·헬스는 전부 정상이고,
    #: 드러나는 시점이 감독기관 점검이면 대상은 지나간 통화 전부다.
    disclosures_seen: int = 0
    #: §10.1 이번 턴에 확정돼 추가 전용 이력에 쌓인 동의 수(감사 근거가 생긴 횟수).
    consents_recorded: int = 0
    #: 답은 확정됐는데 **기록되지 않은** 수. 그 동의는 근거가 없고 개인정보 조회는 게이트에서
    #: 막힌다 — `consents_recorded` 와 합쳐 세면 "동의를 받았다"가 기록 없는 건까지 포함한다.
    consents_not_recorded: int = 0
    #: 미획득 필수 동의 목록이 **바뀐** 횟수. 목록은 서 있는 값이라 턴마다 같은 것이 실려 오므로
    #: 변화만 센다(턴마다 세면 통화 길이만큼 부푼다 — 폴백 모드와 같은 규칙).
    consent_pending_changes: int = 0
    #: 미획득 필수 동의가 생긴 **통화 수**(통화당 한 번). 그 통화에서 pii 파라미터를 선언한
    #: §6.1 업무시스템 조회는 동의 게이트에서 막히는데, 업무시스템은 멀쩡해서 장애로 보이지
    #: 않고 "그 메뉴만 안 된다"로만 나타난다 — 이 건수가 그 상태의 유일한 신호다.
    calls_pending_consent: int = 0
    #: §7 5.2 점검이 **수행된** 통화 수.
    compliance_reviewed_calls: int = 0
    #: 점검을 **수행하지 못한** 통화 수(`reviewed == False`). **위반 0건이 아니다**(§13-3) —
    #: 합쳐 세면 수집 이벤트 0건·스코프 혼입이 "합격"으로 집계된다. 사유는 응답에 있다.
    compliance_unreviewed_calls: int = 0
    #: 위반이 하나라도 잡힌 통화 수.
    compliance_violation_calls: int = 0
    #: 점검하지 **못한 규칙이 있던** 통화 수. 건너뛴 검사는 합격의 근거가 아니다.
    compliance_skipped_calls: int = 0
    #: 종료 응답에 점검 요약이 **아예 없던** 수. 점검이 배선되지 않으면 요약이 실리지 않으므로
    #: (`reviewed: False` 조차 오지 않는다) 이 건수가 §7 미배선의 유일한 와이어 신호다 —
    #: 배선 여부 확정은 `warnings` op 의 `W_QA_UNBOUND` 로 한다.
    ends_without_compliance: int = 0
    #: 유지 루프 호출이 **성공한** 횟수(복구 확인·만료 수렴·readiness·경고·관측·상담사 응답).
    #: 0 인 채 통화가 쌓이면 그 배치는 수렴이 한 번도 돌지 않은 상태다(머리말 10번).
    maintenance_runs: int = 0
    #: 유지 루프 호출이 거절된 횟수(가장 흔한 것은 `E_NOT_WIRED` — 그 op 를 호스트가 열지 않았다).
    #: **브리지 사망과 나눠 센다**: 배선 누락은 기다려도 풀리지 않고 고칠 곳이 설정이다.
    maintenance_failed: int = 0
    #: 브리지가 죽어 있어 유지 루프를 **보내지 않은** 횟수. 통화 경로의 `degraded_skips` 와
    #: 합쳐 세면 "통화가 Core 를 잃은 횟수"가 유지 루프 주기만큼 부풀어 읽을 수 없게 된다.
    maintenance_skips: int = 0
    #: §9.3 헬스 보고를 보낸 횟수. 아래 셋과 **반드시 같이 읽는다** — 보낸 수는 접수된 수가 아니다.
    health_reports_sent: int = 0
    #: 올린 샘플 수(실측). `health_samples_accepted` 와 벌어지는 차이가 유일한 신호다.
    health_samples_offered: int = 0
    #: §9.3 레지스트리에 **실제로 기록된** 샘플 수. 이 값이 0 인 채 offered 가 쌓이면 그
    #: 테넌트의 폴백 판정은 회선 상태를 한 번도 본 적이 없다(어댑터 미등록·컴포넌트 미선언).
    health_samples_accepted: int = 0
    #: 선언되지 않은 컴포넌트라 **버려진** 샘플 수. 0 이 아니면 선언 목록·오타를 봐야 한다.
    health_samples_ignored: int = 0
    #: 접수 범위를 **알 수 없었던** 보고 수(Core 구현이 돌려주지 않음). 접수됨으로 세지 않는다(§13-3).
    health_intake_unknown: int = 0
    #: 헬스 보고가 한도로 거절된 횟수. 헬스는 통화 경로 op 라 제한 대상이다(유지 루프와 다르다).
    health_reports_rate_limited: int = 0
    #: 한도 대기 중이라 **보내지 않은** 헬스 보고 수. 거절과 나눠 센다(턴과 같은 규칙).
    health_reports_deferred: int = 0
    #: 브리지 사망 래치를 푼 횟수(`recover()`). 0 이 아니면 그 사이 통화는 Core 없이 돌았다.
    bridge_recoveries: int = 0
    #: 래치를 풀 때 **열려 있던** 통화 수(실측). 그 통화의 턴은 새 브리지가 모르는 세션이라
    #: 사실대로 실패한다 — 상태를 지어내 고치지 않는다(머리말 11번).
    calls_open_at_recovery: int = 0

    def as_dict(self) -> Dict[str, int]:
        return dict(self.__dict__)


@dataclass
class _Call:
    interaction_id: str
    ended: bool = False
    turns: int = field(default=0)
    #: 이 시각(단조 시계, 초) 전에는 턴을 보내지 않는다. 0 이면 대기 없음.
    blocked_until: float = 0.0
    #: Core 가 마지막 응답에서 말한 §6.1 대기 커넥터 id. **Core 의 마지막 말이지 추정이 아니다.**
    pending_connector: Optional[str] = None
    #: 이관을 이미 알렸는가. 끝난 통화의 응답에는 이관이 서 있는 상태로 계속 실려 오므로
    #: 이 표시가 없으면 같은 이관을 턴마다 다시 알린다(호스트는 안내·기록을 되풀이한다).
    handoff_notified: bool = False
    #: 마지막으로 알린 §9.3 폴백 모드. 'normal' 은 판정이 실리지 않은 상태다.
    fallback_mode: str = "normal"
    #: 마지막으로 본 미획득 필수 동의 목적(§10.1). 서 있는 값이라 턴마다 같은 것이 실려 오므로
    #: **바뀐 턴에만** 알린다. 빈 튜플은 "이 통화에서 아직 미획득 목적을 본 적이 없다"다.
    consent_pending: tuple = ()
    #: 미획득 필수 동의를 이 통화에서 한 번이라도 봤는가(통화 수 집계용 래치).
    consent_pending_seen: bool = False
    #: §7 5.2 점검 요약을 이미 알렸는가. 끝난 세션의 응답에는 요약이 계속 실려 오므로
    #: (서 있는 값이다) 이 표시가 없으면 같은 점검 결과를 두 번째 end·늦은 입력마다 다시 알린다.
    compliance_notified: bool = False
    #: Core 가 이 세션을 닫았는가(`status != "running"`). **Core 의 마지막 말이지 추정이 아니다.**
    #: 서면 이후 턴은 보내지 않는다 — 호스트가 닫은 `ended` 와 나눠 둔다: 이쪽은 통화가 아직
    #: 살아 있고(호스트는 종료를 따로 불러야 한다) 저쪽은 통화가 끝난 것이다(머리말 14번).
    core_closed: bool = False


class CallbotCoreHooks:
    """동기 훅 어댑터. asyncio 에이전트에서는 `AsyncCallbotCoreHooks` 를 쓴다."""

    ENV_ENABLED = "AICC_CORE_ENABLED"
    ENV_ROOT = "AICC_CORE"
    ENV_MODULE = "AICC_CORE_MODULE"
    ENV_FLOW_ID = "AICC_FLOW_ID"
    ENV_ENTRY = "AICC_ENTRY_POINT"
    ENV_MAX_LINE = "AICC_MAX_LINE_BYTES"
    #: §5.2 전환 링크를 **이 호스트가 직접 만들어 보낼 때만** 켠다(기본 꺼짐, §10.3 — 머리말 13번).
    ENV_SWITCH_TICKET = "AICC_INCLUDE_SWITCH_TICKET"

    def __init__(
        self,
        client_factory: Optional[ClientFactory],
        *,
        flow_id: str = "",
        entry_point: str = "inbound_call",
        on_error: Optional[ErrorHook] = None,
        on_turn: Optional[TurnHook] = None,
        on_handoff: Optional[HandoffHook] = None,
        on_fallback: Optional[FallbackHook] = None,
        on_disclosure: Optional[DisclosureHook] = None,
        on_consent: Optional[ConsentHook] = None,
        on_compliance: Optional[ComplianceHook] = None,
        on_switch: Optional[SwitchHook] = None,
        on_session_closed: Optional[SessionClosedHook] = None,
        disabled_reason_ko: str = "",
        monotonic: Optional[Callable[[], float]] = None,
    ) -> None:
        self._factory = client_factory
        # 한도 대기에만 쓰는 단조 시계. 벽시계를 쓰면 NTP 보정에 대기가 늘어나거나 사라진다.
        self._now = monotonic if monotonic is not None else time.monotonic
        self._start_blocked_until = 0.0
        # 헬스 보고의 한도 대기. start·턴과 **따로** 둔다 — 같은 변수를 쓰면 통화 폭주가
        # §9.3 샘플까지 멈추고, 그 순간 장애가 정상으로 집계된다(샘플이 낡아 `unknown` 이 된다).
        self._health_blocked_until = 0.0
        self._flow_id = flow_id
        self._entry_point = entry_point
        self._on_error = on_error
        self._on_turn = on_turn
        self._on_handoff = on_handoff
        self._on_fallback = on_fallback
        self._on_disclosure = on_disclosure
        self._on_consent = on_consent
        self._on_compliance = on_compliance
        self._on_switch = on_switch
        self._on_session_closed = on_session_closed
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
        on_handoff: Optional[HandoffHook] = None,
        on_fallback: Optional[FallbackHook] = None,
        on_disclosure: Optional[DisclosureHook] = None,
        on_consent: Optional[ConsentHook] = None,
        on_compliance: Optional[ComplianceHook] = None,
        on_switch: Optional[SwitchHook] = None,
        on_session_closed: Optional[SessionClosedHook] = None,
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

        # §5.2 전환 토큰 노출(기본 꺼짐, §10.3). 켤 자리가 없던 동안 이 어댑터로 붙인 호스트는
        # **링크를 만들 수 없었다** — 브리지·참조 클라이언트에는 스위치가 있는데 권장 경로에서만
        # 닿지 않았고, 그 상태에서 링크를 만들려면 Interaction id 를 쓸 수밖에 없다(머리말 13번).
        switch_ticket = (e.get(cls.ENV_SWITCH_TICKET, "") or "").strip().lower() in _TRUTHY

        def factory() -> BridgeClient:
            return BridgeClient(
                core_module=module, adapter=adapter, core_root=root, cwd=root,
                node_bin=node_bin, max_line_bytes=max_line,
                include_switch_ticket=switch_ticket,
            )

        return cls(factory, flow_id=flow_id, entry_point=entry, on_error=on_error, on_turn=on_turn,
                   on_handoff=on_handoff, on_fallback=on_fallback, on_disclosure=on_disclosure,
                   on_consent=on_consent, on_compliance=on_compliance, on_switch=on_switch,
                   on_session_closed=on_session_closed)

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

    def pending_connector_id(self, call_id: str) -> Optional[str]:
        """이 통화가 기다리는 §6.1 커넥터 id. 없으면 None.

        Core 가 마지막 응답에서 말한 값이며 **어댑터가 추정하지 않는다**(§13-3). 값이 있으면
        보내야 하는 다음 입력은 발화가 아니라 `on_connector_result(...)` 다 — 대기 중에 발화를
        보내면 응답은 `steps` 0건·`events` 0건이고 오류도 아니다(통화는 무음으로 멈춘다).
        """
        with self._lock:
            call = self._calls.get(call_id)
            return None if call is None else call.pending_connector

    # ── 훅 ───────────────────────────────────────────────────────────────
    def on_call_start(self, call_id: str, *, correlation_id: Optional[str] = None) -> Optional[str]:
        """세션을 연다. 성공하면 interactionId, 아니면 None(통화는 계속된다)."""
        if not call_id or not self._ready():
            return None
        with self._lock:
            if call_id in self._calls and not self._calls[call_id].ended:
                return self._calls[call_id].interaction_id  # 같은 통화의 중복 시작은 재사용
            now = self._now()
            if self._start_blocked_until > now:
                # 한도에 걸린 직후 밀려드는 통화마다 start 를 다시 던지면 한도를 더 밀어붙인다.
                self.stats.starts_deferred += 1
                return None
            res = self._guard(lambda c: c.start(flow_id=self._flow_id, entry_point=self._entry_point,
                                               correlation_id=correlation_id))
            if res is None:
                return None  # 브리지 끊김은 _guard 가 이미 한 번 보고했다
            if not res.ok or not res.interaction_id:
                if res.rate_limited:
                    self.stats.starts_rate_limited += 1
                    self._start_blocked_until = self._deadline(now, res.retry_after_ms)
                self._report(res.error.code if res.error else "E_START_FAILED",
                             "Core 세션을 열지 못해 이 통화는 Core 없이 진행합니다.")
                return None
            call = _Call(interaction_id=res.interaction_id)
            self._calls[call_id] = call
            self.stats.calls_started += 1
            # 첫 응답도 §6.1 대기·§9.3 이관을 들고 올 수 있다(첫 노드가 Api·Transfer 인 시나리오).
            # 턴에서만 읽으면 그 통화는 **시작부터** 지시를 놓치고, 고객은 무음을 듣는다.
            call.pending_connector = res.pending_connector_id
            if call.pending_connector is not None:
                self.stats.connector_waits += 1
            self._notify_routing(call_id, call, res)
            # §10.1 AI 고지는 **대개 이 응답에 실린다**(`placement: session_start`) — 턴에서만
            # 읽으면 그 통화의 고지 감사 근거가 호스트에 영영 도착하지 않는다. 미획득 필수
            # 동의도 여기서 처음 선다(인증 전·동의 전이 통화의 시작 상태다).
            self._notify_governance(call_id, call, res)
            # 첫 응답에서 이미 끝나는 시나리오가 있다(즉시 안내 후 End·첫 노드가 Transfer·
            # Api 순회 상한). 턴에서만 읽으면 그 통화는 **시작부터** 닫힌 세션에 말을 보낸다.
            self._notify_core_close(call_id, call, res)
            return res.interaction_id

    def on_transcript(
        self,
        call_id: str,
        role: str,
        text: str,
        *,
        confidence: Optional[float] = None,
        latency: Optional[Dict[str, float]] = None,
        usage: Optional[Dict[str, float]] = None,
    ) -> Optional[BridgeResponse]:
        """고객 발화 한 건. `latency`·`usage` 는 **회선·엔진이 측정한 값만** 넘긴다(머리말 6-1).

        선언하지 않으면 **종전과 완전히 같은 호출**이 나간다 — 인자를 싣지 않으므로 구버전
        시그니처의 클라이언트를 감싼 호스트도 턴 자리에서 죽지 않는다(`on_call_end` 와 같은 규칙).
        """
        if role != "user":
            self.stats.ignored_non_user += 1
            return None
        if not isinstance(text, str) or not text.strip():
            self.stats.ignored_empty += 1
            return None
        facts = self._facts(latency=latency, usage=usage)
        return self._turn(
            call_id,
            lambda c, i: c.send_utterance(i, text, confidence=confidence, **facts),
            usage_declared=bool(usage),
        )

    def on_dtmf(
        self,
        call_id: str,
        digits: str,
        *,
        latency: Optional[Dict[str, float]] = None,
        usage: Optional[Dict[str, float]] = None,
    ) -> Optional[BridgeResponse]:
        if not isinstance(digits, str) or not digits:
            self.stats.ignored_empty += 1
            return None
        facts = self._facts(latency=latency, usage=usage)
        return self._turn(
            call_id,
            lambda c, i: c.send_dtmf(i, digits, **facts),
            usage_declared=bool(usage),
        )

    def on_unrecognized(
        self,
        call_id: str,
        text: str = "",
        *,
        latency: Optional[Dict[str, float]] = None,
        usage: Optional[Dict[str, float]] = None,
    ) -> Optional[BridgeResponse]:
        """인식기가 no-match 를 돌려준 턴(§5.1·§6.2). **고객은 말했다.**

        `on_transcript` 로 바꿔 보내지 않는다 — `Collect` 노드는 비어 있지 않은 텍스트를 무조건
        수락하므로 미인식 발화가 **슬롯 값으로 저장된 채** 흐름이 넘어간다(예외도 재프롬프트도 없다).
        `on_timeout` 도 틀리다: 말을 한 고객이 침묵으로 집계되고 §5.1 사다리의 다른 단계를 탄다.

        **빈 `text` 를 버리지 않는다**(`on_transcript` 와 다른 점이다): 아무 말도 돌려받지 못한
        것이 미인식의 가장 흔한 모양이고, 그 턴을 여기서 버리면 사다리가 돌지 않아 통화가 멈춘
        것처럼 보인다. 문자열이 아닌 값만 거른다.
        """
        if not isinstance(text, str):
            self.stats.ignored_empty += 1
            return None
        facts = self._facts(latency=latency, usage=usage)
        return self._turn(
            call_id,
            lambda c, i: c.send_unrecognized(i, text, **facts),
            usage_declared=bool(usage),
        )

    def on_timeout(
        self,
        call_id: str,
        *,
        usage: Optional[Dict[str, float]] = None,
    ) -> Optional[BridgeResponse]:
        """무음. 응답시간은 받지 않는다 — Core 가 무입력 턴에 실을 자리가 없다(`send_timeout` 주석)."""
        facts = self._facts(usage=usage)
        return self._turn(
            call_id,
            lambda c, i: c.send_timeout(i, **facts),
            usage_declared=bool(usage),
        )

    def on_connector_result(
        self,
        call_id: str,
        ok: bool,
        *,
        slots: Optional[Dict[str, str]] = None,
        error_code: Optional[str] = None,
    ) -> Optional[BridgeResponse]:
        """업무시스템 조회 결과를 되돌려준다(§6.1 — `pending_connector_id` 가 섰을 때).

        `ok` 는 **명시해야 한다** — 빠진 값을 성공으로 읽으면 실패한 조회가 성공으로 흘러간다.
        `slots` 는 커넥터 계층에서 허용목록·마스킹을 마친 값만 넣는다(§10.3). 실패면 `error_code`
        를 주면 시나리오의 `onError` 분기가 그 코드를 근거로 갈라지고, 분기가 없으면 Core 가
        상담사로 내린다 — 조회 실패로 콜을 끊지 않는다(§9.3).

        **어느 대기에 답하는지는 어댑터가 선언한다**(머리말 8번): 호스트가 커넥터 id 를 들고
        다니며 상관짓게 두면 통화 두 건이 겹치는 순간 섞이고, 섞인 결과는 **다른 조회의 값으로
        채워진 안내**가 되어 예외 없이 지나간다. 대기를 본 적이 없으면 보내지 않고 알린다.

        **한도 대기(`blocked_until`)에 걸려도 미루지 않는다**: 이 통화는 답을 받지 못하면
        진행할 방법이 없어 무음으로 멈춘다(종료를 미루지 않는 것과 같은 이유다). 한도로
        거절되면 사실대로 돌려주므로 호스트가 다시 부를 수 있다.

        **`usage` 를 받지 않는다**: 커넥터 재개 턴에는 고객 발화 이벤트가 없어 Core 가 실측을
        실을 자리가 없다 — 받아서 보내면 응답에 "실을 자리가 없었다"만 적힌다(§11.2).
        """
        with self._lock:
            call = self._calls.get(call_id)
            pending = None if call is None else call.pending_connector
            if call is not None and not call.ended and pending is None:
                # 서 있지 않은 대기에 답하려 한다. 보내면 Core 는 늦게 온 응답으로 보고 버리는데
                # 그 응답이 `ok: True` 라 호스트는 반영됐다고 읽는다 — 세고, 알리고, 보내지 않는다.
                self.stats.connector_results_unexpected += 1
                self._report("E_CONNECTOR_NO_WAIT",
                             "서 있는 업무시스템 조회 대기가 없어 조회 결과를 보내지 않았습니다.")
                return None
        res = self._turn(
            call_id,
            lambda c, i: c.send_connector_result(i, ok, slots=slots, error_code=error_code,
                                                 connector_id=pending),
            usage_capable=False,
            defer_on_limit=False,
        )
        if res is not None and res.ok:
            self.stats.connector_results_sent += 1
            # **보냈다와 반영됐다는 다른 질문이다**(§6.1). Core 의 판정을 그대로 읽는다.
            if res.connector_result_applied is False:
                self.stats.connector_results_not_applied += 1
                self._report("E_CONNECTOR_NOT_APPLIED",
                             "되돌려준 조회 결과가 대기에 반영되지 않았습니다. 사유는 응답에 있습니다.")
        return res

    def on_call_end(
        self,
        call_id: str,
        reason_ko: str = "통화 종료",
        billable_ms: Optional[float] = None,
    ) -> Optional[BridgeResponse]:
        """멱등. 두 번째 호출은 아무것도 보내지 않는다.

        `billable_ms` 는 §11.2 통화 과금 구간이며 **회선이 알고 이 어댑터는 모른다** — 대기·호 설정
        구간을 포함할지는 계약 사항이라 추정하지 않는다(§13-3). 주지 않으면 그 통화는 통화 분 집계에서
        빠지고, 그 사실을 `stats.ends_missing_billable_ms` 로 센다. 세지 않으면 "청구할 근거가 없는
        통화"가 몇 건인지 아무도 모르는 채 월말이 온다.
        """
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
            if billable_ms is None:
                self.stats.ends_missing_billable_ms += 1
            if not self._ready():
                return None
            # 값이 없으면 인자를 **싣지 않는다** — 종전과 완전히 같은 호출이어야 한다(§13-3).
            # 이 한 줄이 없으면 end 를 감싼 호스트 구현(구버전 시그니처)이 종료 시점에 TypeError 로
            # 죽고, 죽는 자리가 하필 세션을 닫는 곳이라 누수가 요금으로 나타난다.
            res = self._guard(
                (lambda c: c.end(call.interaction_id, reason_ko)) if billable_ms is None
                else (lambda c: c.end(call.interaction_id, reason_ko, billable_ms=billable_ms))
            )
            if res is not None:
                self.stats.calls_ended += 1
                # 선언한 구간이 실제로 `session.ended` 에 실렸는지는 Core 가 판정한다 —
                # 가장 흔한 False 는 이미 닫힌 세션을 다시 닫은 경우이고(멱등하게 받되 구간은
                # 싣지 않는다) 그 통화는 통화 분 집계에서 빠진다. 선언 없음(None)과 구분해 센다.
                if res.billable_ms_recorded is False:
                    self.stats.ends_billable_ms_unrecorded += 1
                # §7 5.2 점검 요약은 **세션이 끝난 응답에만** 실린다 — 즉 이 자리가 그 사실이
                # 호스트에 도착하는 유일한 지점이다(턴 응답에는 아예 없다).
                if res.ok:
                    self._notify_governance(call_id, call, res)
                    if res.compliance is None:
                        # 요약이 아예 오지 않았다 = 점검이 배선되지 않았다("위반 0건"이 아니다).
                        self.stats.ends_without_compliance += 1
            return res

    # ── 유지 루프(§9.3·§2) ───────────────────────────────────────────────
    # Core 는 타이머를 돌리지 않고 이 어댑터도 돌리지 않는다 — **주기는 호스트가 정한다**
    # (§13-3: 회선 수·상담사 수에 따라 다르다). 자리가 없던 동안 무엇이 조용히 멈춰 있었는지는
    # 머리말 10번에 적었다.
    #
    # 공통 규칙 넷이다:
    #  (1) **통화를 끊지 않는다** — `_guard` 를 지나므로 어떤 예외도 호스트로 올라가지 않는다.
    #  (2) **한도 대기에 걸리지 않는다** — 브리지는 유지 루프를 제한 대상에서 빼 두었다
    #      (막으면 만료 수렴·복구 확인이 멈추고, 그 상태는 "상담사가 안 받는다"·"엔진이 안
    #      돌아온다"와 구분되지 않는다). 헬스만 통화 경로 op 라 제한 대상이며 아래에서 따로 다룬다.
    #  (3) **배선 누락(`E_NOT_WIRED`)을 브리지 사망으로 올리지 않는다** — 올리면 유지 루프
    #      설정 하나가 그 프로세스의 모든 통화에서 Core 를 떼어 간다(§9.3).
    #  (4) **판정 기준을 넘기지 않는다** — 제한 시간·프로브·시각은 브리지 쪽 배선이 준다.
    #      호스트가 호출마다 주면 같은 `/health` 가 호출마다 다른 기준으로 판정된다(§2).
    def _maintenance(self, fn: Callable[[BridgeClient], BridgeResponse]) -> Optional[BridgeResponse]:
        # 잠금을 들고 왕복한다. 놓아도 얻는 것이 없다 — 브리지는 **JSONL 파이프 하나**이고
        # `BridgeClient.request` 가 그 왕복을 이미 직렬화하므로, 느린 유지 루프는 어느 쪽이든
        # 그 사이 턴을 기다리게 한다. 대신 잠금 안에서 클라이언트를 만들어 **두 스레드가 브리지
        # 프로세스를 두 개 띄우는 일**을 막는다.
        with self._lock:
            if not self.enabled:
                return None
            if self._degraded:
                self.stats.maintenance_skips += 1
                return None
            res = self._guard(fn)
            if res is None:
                return None          # 끊김은 _guard 가 이미 한 번 보고했다
            if res.ok:
                self.stats.maintenance_runs += 1
            else:
                self.stats.maintenance_failed += 1
                self._report(res.error.code if res.error else "E_MAINTENANCE_FAILED",
                             "Core 유지 루프 호출이 처리되지 않았습니다. 통화 경로는 영향받지 않습니다.")
            return res

    def maintenance_ops(self) -> list:
        """브리지가 **실제로 열어 둔** 유지 op. 열리지 않은 op 를 부르면 `E_NOT_WIRED` 다.

        호스트가 op 를 하나씩 찔러 보고 알아내게 두면 저장소마다 다르게 알아내고(§2), 더
        나쁜 것은 **아무도 찔러 보지 않는 것**이다 — 그러면 그 배치는 수렴이 돌지 않는 채로
        조용히 운영된다. 브리지가 `hello` 에 실어 주므로 그대로 읽는다.
        """
        res = self._maintenance(lambda c: c.hello())
        if res is None or not res.ok or not isinstance(res.result, dict):
            return []
        ops = res.result.get("maintenanceOps")
        return [str(o) for o in ops] if isinstance(ops, list) else []

    def warnings(self) -> Optional[BridgeResponse]:
        """등록 시점 계약 경고 전문(§9.3·§10.1). 코드가 아니라 사유까지 온다."""
        return self._maintenance(lambda c: c.warnings())

    def readiness(self) -> Optional[BridgeResponse]:
        """§9.3 폴백 상태를 포함한 readiness. 호스트 `/health` 가 이 값을 합쳐 쓴다."""
        return self._maintenance(lambda c: c.readiness())

    def run_recovery_probe(self) -> Optional[BridgeResponse]:
        """§9.3 복구 확인 1회. **폴백에서 빠져나오는 유일한 길이다**(머리말 10번).

        보고서의 `unprobed` 가 비어 있지 않으면 그 컴포넌트는 **확인할 길이 없다** —
        "확인했고 정상"이 아니다(§13-3).
        """
        return self._maintenance(lambda c: c.run_recovery_probe())

    def run_offer_expiry(self) -> Optional[BridgeResponse]:
        """배정 오퍼 만료 수렴 1회. `issues` 가 비어 있지 않으면 `expired` 는 판정 결과가 아니다."""
        return self._maintenance(lambda c: c.run_offer_expiry())

    def run_invite_expiry(self) -> Optional[BridgeResponse]:
        """§5.2 전환 초대 정리 1회(머리말 10번). `issues` 가 비어 있지 않으면 `purged` 는 판정이 아니다.

        부르지 않으면 발급된 초대가 레지스트리에서 **나가지 않는다** — 상환·만료는 상태만
        바꾼다. 음성 에이전트는 며칠을 살고 초대 안에는 §10.3 승계 슬롯 스냅샷이 들어 있으므로,
        증상은 장애가 아니라 **지나간 전환 전부가 프로세스 안에 남아 있는 것**이다.
        아직 유효한 초대는 걷히지 않는다(고객의 손에 있는 링크를 태우지 않는다).
        """
        return self._maintenance(lambda c: c.run_invite_expiry())

    def settle_offer(self, offer_id: str, event: str) -> Optional[BridgeResponse]:
        """상담사 수락·거절·취소 반영. `event` 는 accept·decline·cancel 이다.

        `tick`(만료)은 여기서 보내지 않는다 — 건별로 만료시키면 만료 판정이 두 곳이 되므로
        `run_offer_expiry` 가 수행한다(§2). 형태 판정은 브리지 한 곳이 하고 이 어댑터는
        다시 적지 않는다(적으면 허용값 목록이 두 벌이 된다).
        """
        return self._maintenance(lambda c: c.settle_offer(offer_id, event))

    def observability(self) -> Optional[BridgeResponse]:
        """관측 실측. 수치만 온다 — 로그 본문·오류 원문은 어떤 경로로도 오지 않는다(§10.3)."""
        return self._maintenance(lambda c: c.observability())

    def report_health(
        self,
        samples: Any,
        observed_at: str,
    ) -> Optional[BridgeResponse]:
        """§9.3 헬스 보고. **회선이 아는 것을 Core 에 알리는 유일한 경로다.**

        음성의 L1 은 `telephony` 이고 그 상태를 아는 것은 회선뿐이다 — Core 는 엔진·매체를
        직접 찌르지 않는다(§6.2). 이 자리가 없던 동안 음성 배치의 §9.3 레지스트리에는 회선
        샘플이 **한 건도** 없었고, 그러면 `treatUnknownAsDown` 설정에 따라 결말이 둘인데
        둘 다 조용하다: `false` 면 회선이 죽어도 판정은 영구히 `normal` 이고(고객은 통화가
        안 된다고 겪는다), `true` 면 전부 정상인데도 그 채널이 **영구히** 폴백에 남는다.

        **관측 시각은 호출자가 준다**(§13-3) — 어댑터가 시각을 만들어 넣지 않는다.
        **샘플 형태는 판정하지 않는다**: 브리지가 한 곳에서 판정하고 사유를 돌려준다(§2).

        응답은 "보냈다"가 아니라 **접수 범위**다. 보낸 수를 접수된 수로 읽으면 어댑터 미등록·
        컴포넌트 미선언으로 **한 건도 닿지 않는 상태가 정상으로** 집계된다(§11.2 의
        `usage_attached` 와 같은 규칙) — 그래서 나눠 센다.
        """
        with self._lock:
            if not self.enabled:
                return None
            if self._degraded:
                self.stats.maintenance_skips += 1
                return None
            now = self._now()
            if self._health_blocked_until > now:
                # 한도 대기 중에 계속 던지면 한도를 더 밀어붙인다. 샘플은 다음 주기에 다시 온다.
                self.stats.health_reports_deferred += 1
                return None
            res = self._guard(lambda c: c.report_health(samples, observed_at))
            if res is None:
                return None
            if res.ok:
                self.stats.health_reports_sent += 1
                # Core 의 판정을 그대로 읽는다(지어내지 않는다). 모름을 0 으로도 offered 로도
                # 적지 않는다 — 전자는 멀쩡한 보고를 유실로, 후자는 유실을 정상으로 집계한다.
                offered = res.health_offered
                if offered is not None:
                    self.stats.health_samples_offered += offered
                accepted = res.health_accepted
                ignored = res.health_ignored
                if res.health_intake_known is not True:
                    self.stats.health_intake_unknown += 1
                else:
                    if accepted is not None:
                        self.stats.health_samples_accepted += accepted
                    if ignored is not None:
                        self.stats.health_samples_ignored += ignored
                    if res.health_registered is False:
                        self._report("E_HEALTH_NOT_REGISTERED",
                                     "이 어댑터가 Core 에 등록돼 있지 않아 헬스 샘플이 한 건도 "
                                     "기록되지 않았습니다(§9.3).")
                    elif ignored:
                        self._report("E_HEALTH_UNDECLARED_COMPONENT",
                                     "선언되지 않은 컴포넌트의 헬스 샘플이 버려졌습니다 — "
                                     "선언 목록은 응답의 declared 에 있습니다(§9.3).")
            elif res.rate_limited:
                # 한도 초과는 장애가 아니다(턴과 같은 규칙) — degraded 로 올리지 않는다.
                self.stats.health_reports_rate_limited += 1
                self._health_blocked_until = self._deadline(now, res.retry_after_ms)
                self._report("E_RATE_LIMITED",
                             "Core 요청 한도를 넘어 이 헬스 보고는 보내지 않았습니다.")
            else:
                self.stats.maintenance_failed += 1
                self._report(res.error.code if res.error else "E_HEALTH_FAILED",
                             "Core 가 헬스 보고를 처리하지 못했습니다. 통화 경로는 영향받지 않습니다.")
            return res

    # ── 브리지 사망 래치 해제(§9.3) ──────────────────────────────────────
    def recover(self) -> bool:
        """`degraded` 래치를 풀고 다음 호출에서 브리지를 새로 띄운다. 멱등이며 던지지 않는다.

        돌려주는 값은 **래치를 실제로 풀었는가**다. `False` 는 풀 것이 없었다는 뜻이며
        실패가 아니다.

        **호스트가 부른다** — 어댑터가 턴마다 다시 붙으려 하면 죽은 브리지를 통화마다 다시
        띄우고, 그 재시도가 곧 장애를 길게 만든다. 주기는 어댑터가 정하지 않는다(§13-3).

        **멀쩡한 브리지는 건드리지 않는다**: 내리면 진행 중인 세션이 통째로 사라진다 —
        복구를 부른 대가로 멀쩡한 통화를 잃는 일이 생기면 안 된다.

        **통화 상태를 고치지 않는다**: 장애를 건너 살아 있던 통화의 interactionId 는 죽은
        브리지 프로세스의 것이므로 새 브리지가 모를 수 있고, 그때 그 턴은 **사실대로 실패**한다
        (`turns_failed` + 오류 코드). 끝나지 않은 통화를 "끝났다"로 적으면 그 뒤의 턴이 전부
        `late_after_end` 로 조용히 버려지고, 종료는 `duplicate_ends` 로 집계된다 — 둘 다
        일어나지 않은 일이다(§13-3). 열려 있던 건수만 실측으로 남긴다.
        """
        with self._lock:
            if self._closed or not self._degraded:
                return False
            self.stats.bridge_recoveries += 1
            self.stats.calls_open_at_recovery += len(
                [c for c in self._calls.values() if not c.ended]
            )
            client, self._client = self._client, None
            self._degraded = False
        # 죽은 프로세스 정리는 잠금 밖에서 한다 — `close()` 는 최대 5초를 기다릴 수 있고,
        # 그 동안 잠금을 들고 있으면 멀쩡해진 턴들이 같이 멈춘다.
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001 - 죽은 프로세스를 닫다 난 오류가 복구를 막으면 안 된다
                pass
        return True

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

    @staticmethod
    def _facts(
        *,
        latency: Optional[Dict[str, float]] = None,
        usage: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """선언된 실측만 호출 인자로 만든다.

        빈 맵은 **선언이 아니다**(§13-3) — 실어 보내면 "측정했고 0건"으로 읽힌다. 아무것도
        선언되지 않으면 빈 dict 를 돌려주므로 호출 모양이 종전과 완전히 같다(구버전 시그니처의
        클라이언트를 감싼 호스트가 턴 자리에서 TypeError 로 죽지 않는다 — 죽는 자리가 하필
        통화 중이라 그 통화는 Core 를 통째로 잃는다).
        """
        facts: Dict[str, Any] = {}
        if latency:
            facts["latency"] = latency
        if usage:
            facts["usage"] = usage
        return facts

    def _turn(
        self,
        call_id: str,
        fn: Callable[[BridgeClient, str], BridgeResponse],
        *,
        usage_declared: bool = False,
        usage_capable: bool = True,
        defer_on_limit: bool = True,
    ) -> Optional[BridgeResponse]:
        """한 턴을 보낸다.

        `usage_capable=False` 인 입력(커넥터 결과)은 **실측 누락으로 세지 않는다**: Core 에
        실을 자리가 애초에 없으므로 그 턴을 "근거 없는 턴"에 더하면 `turns_missing_usage` 가
        고칠 수 없는 건수로 부풀고, 그 수를 보고 회선 계측을 뒤지게 된다(§11.2·§13-3).

        `defer_on_limit=False` 는 한도 대기를 **건너뛰고** 보낸다 — 미루면 그 통화가 멈추는
        입력(조회 결과)에만 쓴다(`on_connector_result` 주석).
        """
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
            if call.core_closed:
                # Core 가 이미 닫은 세션이다. 보내면 응답은 `ok: True` 로 **직전 턴의 단계를
                # 되풀이**하고(멱등, §8.1) 호스트는 그것을 새 안내로 읽는다 — 안내 반복이나
                # 무음으로 나타난다(머리말 14번). 호스트 종료와 나눠 센다: 고칠 곳이 다르다.
                self.stats.turns_after_core_close += 1
                return None
            now = self._now()
            if defer_on_limit and call.blocked_until > now:
                # 한도가 풀릴 때까지는 보내지 않는다. 통화는 계속되고, 건수로만 남는다.
                self.stats.turns_deferred += 1
                return None
            res = self._guard(lambda c: fn(c, call.interaction_id))
            if res is None:
                return None
            if res.ok:
                self.stats.turns_sent += 1
                call.turns += 1
                # Core 가 말한 §6.1 대기 상태를 그대로 기록한다(추정하지 않는다). 새로 선 대기만
                # 센다 — 같은 대기가 서 있는 턴마다 세면 "부를 차례"가 턴 수만큼 부풀어 보인다.
                pending = res.pending_connector_id
                if pending is not None and pending != call.pending_connector:
                    self.stats.connector_waits += 1
                call.pending_connector = pending
                self._notify_routing(call_id, call, res)
                self._notify_governance(call_id, call, res)
                self._notify_switch(call_id, res)
                # **마지막에 알린다**: 닫혔다는 사실보다 그 턴에 일어난 일(이관·폴백·고지·동의·
                # 전환)이 먼저 손에 쥐어져야 호스트가 무엇 때문에 끝났는지 알고 마무리한다.
                self._notify_core_close(call_id, call, res)
                # 보낸 턴 중 §11.2 실측 선언이 없던 건수. 통화 구간(`ends_missing_billable_ms`)과
                # 같은 이유로 센다 — 그 턴의 엔진 비용은 원장에 없고 청구서에만 남는다.
                if usage_capable and not usage_declared:
                    self.stats.turns_missing_usage += 1
                # **보냈다와 실렸다는 다른 질문이다**(§11.2). 선언 건수만 세던 동안 이 어댑터의
                # 카운터는 "근거 있는 턴"을 과대 보고했다 — 실을 자리가 없어 버려진 실측도
                # 선언된 턴으로 세었기 때문이다. Core 의 판정을 그대로 읽는다(지어내지 않는다).
                if res.usage_attached is False:
                    self.stats.turns_usage_unattached += 1
                if res.billing_dropped_units:
                    self.stats.turns_usage_dropped += 1
                if self._on_turn is not None:
                    try:
                        self._on_turn(call_id, res.result)
                    except Exception:  # noqa: BLE001 - 호출자 콜백 오류가 통화를 끊으면 안 된다
                        pass
            elif res.rate_limited:
                # 한도 초과는 장애가 아니다. degraded 로 올리면 통화 전체가 Core 를 잃는다(§9.3).
                self.stats.turns_rate_limited += 1
                call.blocked_until = self._deadline(now, res.retry_after_ms)
                self._report("E_RATE_LIMITED",
                             "Core 요청 한도를 넘어 이 턴은 보내지 않았습니다. 통화는 계속됩니다.")
            else:
                self.stats.turns_failed += 1
                self._report(res.error.code if res.error else "E_TURN_FAILED",
                             "Core 가 이 턴을 처리하지 못했습니다. 통화는 계속됩니다.")
            return res

    @staticmethod
    def _deadline(now: float, retry_after_ms: Optional[float]) -> float:
        """대기 마감을 구한다. 브리지가 대기 시간을 주지 않았으면 **대기하지 않는다**.

        모르는 값을 임의의 초로 메우면 없는 근거를 만든 것이고(§13-3), 그 숫자만큼
        멀쩡한 턴이 통째로 사라진다. 다음 턴에서 다시 거절당하는 편이 낫다.
        """
        if retry_after_ms is None or retry_after_ms <= 0:
            return 0.0
        return now + retry_after_ms / 1000.0

    def _notify_routing(self, call_id: str, call: _Call, res: BridgeResponse) -> None:
        """§9.3 이관·폴백 지시를 호스트에 넘긴다(머리말 9번). **판정은 Core 가 끝냈다.**

        여기서 지키는 것:
        - **모름을 못 들어갔다로 적지 않는다**(§13-3): 라우팅이 배선되지 않은 테넌트에는 큐
          배정 판정 자체가 없다. False 로 읽으면 종전까지 되던 이관 안내가 그 테넌트 전체에서
          사라지고, True 로 읽으면 오지 않는 상담사를 안내한다 — 둘 다 조용하다.
        - **요약·슬롯은 담지 않는다**(§2·§10.3): 상담사용 요약은 고객 접점 프로세스로 나가면
          안 되는 값이라 응답에도 기본적으로 실리지 않는다. 여기서 되살리지 않는다.
        - **한 통화에 한 번만 알린다**: 끝난 통화의 응답에는 이관이 서 있는 상태로 계속 실려
          오므로, 턴마다 알리면 호스트는 같은 이관을 여러 번 안내·기록한다.
        - **폴백은 모드가 바뀐 턴에만 알린다**: 장애 중에는 턴마다 같은 판정이 실려 온다.
        콜백이 던지는 예외는 통화를 끊지 않는다(어댑터의 다른 콜백과 같은 규칙).
        """
        handoff = res.handoff
        if handoff is not None and not call.handoff_notified:
            call.handoff_notified = True
            self.stats.handoffs_requested += 1
            queued = res.queued
            if queued is False:
                self.stats.handoffs_not_queued += 1
            elif queued is None:
                self.stats.handoffs_placement_unknown += 1
            if self._on_handoff is not None:
                queue = handoff.get("queue")
                payload: Dict[str, Any] = {
                    "queued": queued,
                    "action": res.handoff_action,
                    "queue": queue if isinstance(queue, str) and queue else None,
                }
                try:
                    self._on_handoff(call_id, payload)
                except Exception:  # noqa: BLE001 - 호출자 콜백 오류가 통화를 끊으면 안 된다
                    pass

        fallback = res.fallback
        mode = fallback.get("mode") if isinstance(fallback, dict) else None
        mode = mode if isinstance(mode, str) and mode else "normal"
        if mode != call.fallback_mode:
            call.fallback_mode = mode
            self.stats.fallback_changes += 1
            if self._on_fallback is not None:
                raw = fallback.get("disable") if isinstance(fallback, dict) else None
                disable = tuple(str(c) for c in raw) if isinstance(raw, list) else ()
                try:
                    self._on_fallback(call_id, mode, disable)
                except Exception:  # noqa: BLE001
                    pass

    def _notify_governance(self, call_id: str, call: _Call, res: BridgeResponse) -> None:
        """§10.1 고지·동의와 §7 5.2 준수 점검을 호스트에 넘긴다(머리말 12번).

        세 칸은 **판정이 아니라 사실**이다 — 수행할 일이 아니라 남길 근거이고, 그래서 Core 는
        어떤 노출 스위치와도 무관하게 내보낸다. 그런데 **읽을 자리가 없던 동안 세 사실은
        음성 호스트에 한 번도 도착하지 않았다**: 응답 원문을 그대로 넘겨 두면 저장소마다
        `result["consent"]["pendingRequired"]` 를 각자 파싱하다 각자 다르게 틀리고(§2),
        가장 흔한 오답은 **빈 목록·없는 칸을 "다 받았다"·"위반 없음"으로 읽는 것**이다.

        여기서 지키는 것:
        - **고지는 나간 턴에만** 알린다. 같은 통화의 다음 턴에는 실리지 않으므로(이미 고지했다)
          `None` 을 "고지하지 않았다"로 적지 않는다(§13-3).
        - **동의는 이번 턴의 사실이 있거나 미획득 목록이 바뀐 턴에만** 알린다. 목록은 서 있는
          값이라 턴마다 같은 것이 실려 오고, 턴마다 알리면 호스트는 같은 안내를 되풀이한다
          (폴백 모드와 같은 규칙). **빈 목록을 "다 받았다"로 적지 않는다** — 동의가 배선되지
          않은 테넌트도 똑같이 비어 있고, 그 구분은 와이어에 없다(`W_CONSENT_UNBOUND`).
        - **점검은 통화당 한 번만** 알린다. 세션이 끝난 뒤의 응답에는 요약이 계속 실려 온다.
          `reviewed == False` 를 위반 0건으로 세지 않고 **따로** 센다.
        콜백이 던지는 예외는 통화를 끊지 않는다(어댑터의 다른 콜백과 같은 규칙).
        """
        disclosure = res.disclosure
        if disclosure is not None:
            self.stats.disclosures_seen += 1
            if self._on_disclosure is not None:
                channel = disclosure.get("channel")
                placement = disclosure.get("placement")
                version = disclosure.get("configVersion")
                payload: Dict[str, Any] = {
                    "channel": channel if isinstance(channel, str) and channel else None,
                    "placement": placement if isinstance(placement, str) and placement else None,
                    "config_version": version if isinstance(version, int) and not isinstance(version, bool) else None,
                }
                try:
                    self._on_disclosure(call_id, payload)
                except Exception:  # noqa: BLE001 - 호출자 콜백 오류가 통화를 끊으면 안 된다
                    pass

        recorded = res.consent_recorded
        not_recorded_ko = res.consent_not_recorded_ko
        pending = tuple(res.consent_pending_required)
        if recorded is not None:
            self.stats.consents_recorded += 1
        if not_recorded_ko is not None:
            self.stats.consents_not_recorded += 1
        pending_changed = pending != call.consent_pending
        if pending_changed:
            call.consent_pending = pending
            self.stats.consent_pending_changes += 1
            if pending and not call.consent_pending_seen:
                call.consent_pending_seen = True
                self.stats.calls_pending_consent += 1
        if (recorded is not None or not_recorded_ko is not None or pending_changed) and self._on_consent is not None:
            try:
                self._on_consent(call_id, {
                    "recorded": recorded,
                    "not_recorded_ko": not_recorded_ko,
                    "pending_required": pending,
                })
            except Exception:  # noqa: BLE001
                pass

        if res.compliance is not None and not call.compliance_notified:
            call.compliance_notified = True
            reviewed = res.compliance_reviewed
            violations = tuple(res.compliance_violations)
            skipped = tuple(res.compliance_skipped)
            if reviewed is True:
                self.stats.compliance_reviewed_calls += 1
            elif reviewed is False:
                self.stats.compliance_unreviewed_calls += 1
            if violations:
                self.stats.compliance_violation_calls += 1
            if skipped:
                self.stats.compliance_skipped_calls += 1
            if self._on_compliance is not None:
                try:
                    self._on_compliance(call_id, {
                        "reviewed": reviewed,
                        "violations": violations,
                        "skipped": skipped,
                        "reason_ko": res.compliance_reason_ko,
                    })
                except Exception:  # noqa: BLE001
                    pass

    def _notify_switch(self, call_id: str, res: BridgeResponse) -> None:
        """§5.2 전환 초대를 호스트에 넘긴다(머리말 13번). **링크를 보내는 것은 호스트다.**

        여기서 지키는 것:
        - **네 상태를 섞지 않는다**: 토큰 수신 · 발급됐으나 토큰 미실림(이 호스트의 스위치) ·
          토큰 없는 초대(Core 쪽 배선 없음) · 발급 실패(링크를 보내면 안 된다). 합쳐 세면
          "링크를 못 보낸다"는 한 숫자가 되고, 고칠 곳이 셋으로 갈린다.
        - **id 를 토큰 자리에 넣지 않는다**(§10.3): 어댑터는 `interaction_id` 를 이 payload 에
          담지 않는다 — 담으면 "토큰이 없으면 id 로 만든다"는 경로를 여기서 열어 주는 셈이다.
        - **턴 사실이라 되풀이되지 않는다**: Core 는 끝난 세션의 늦은 입력에 전환 초대를 싣지
          않으므로(그 토큰은 이미 상환됐을 수 있다) 통화당 래치를 두지 않는다.
        콜백이 던지는 예외는 통화를 끊지 않는다(어댑터의 다른 콜백과 같은 규칙).
        """
        invite = res.switch_invite
        if invite is None:
            return
        self.stats.switch_invites_seen += 1
        ticket_issued = invite.get("ticketIssued") is True
        token = invite.get("token")
        token = token if isinstance(token, str) and token else None
        token_included = invite.get("tokenIncluded") is True and token is not None
        tokenless = invite.get("tokenless") is True
        not_issued_ko = invite.get("notIssuedKo")
        not_issued_ko = not_issued_ko if isinstance(not_issued_ko, str) and not_issued_ko else None
        if token_included:
            self.stats.switch_tokens_received += 1
        elif ticket_issued:
            # 토큰 노출이 꺼져 있다. **알림을 내지 않는다**: 링크를 Core 쪽 transport 가 보내는
            # 구성이 정상일 수 있고(그 호스트는 토큰이 필요 없다), 그 구성에 턴마다 오류를
            # 올리면 진짜 신호가 묻힌다. 필요한 호스트에는 이 건수가 곧 "스위치를 켜라"다.
            self.stats.switch_tokens_withheld += 1
        elif tokenless:
            # Core 쪽 배선 없음 — 등록 시점 경고(`W_CHANNEL_SWITCH_UNBOUND`)가 이미 적어 둔
            # 상태라 여기서 되풀이하지 않는다(같은 사실을 두 경로로 알리면 둘 다 안 읽힌다).
            self.stats.switch_tokenless += 1
        else:
            # 발급 실패만 **알린다**: 이 상태에서 링크를 보내면 안 되고, 그 사실을 말해 주는
            # 다른 경로가 없다(등록 시점에는 멀쩡했고 통화는 계속 돌아간다).
            self.stats.switch_tickets_unissued += 1
            self._report("E_SWITCH_NOT_ISSUED",
                         "전환 초대가 발급되지 않아 링크를 보내지 않아야 합니다. 사유는 응답에 있습니다.")
        if self._on_switch is None:
            return
        from_channel = invite.get("fromChannel")
        to_channel = invite.get("toChannel")
        expires_at = invite.get("expiresAt")
        payload: Dict[str, Any] = {
            "from_channel": from_channel if isinstance(from_channel, str) and from_channel else None,
            "to_channel": to_channel if isinstance(to_channel, str) and to_channel else None,
            "ticket_issued": ticket_issued,
            "token_included": token_included,
            "token": token if token_included else None,
            "expires_at": expires_at if isinstance(expires_at, str) and expires_at else None,
            "tokenless": tokenless,
            "not_issued_ko": not_issued_ko,
        }
        try:
            self._on_switch(call_id, payload)
        except Exception:  # noqa: BLE001 - 호출자 콜백 오류가 통화를 끊으면 안 된다
            pass

    def _notify_core_close(self, call_id: str, call: _Call, res: BridgeResponse) -> None:
        """Core 가 이 세션을 닫았다는 사실을 호스트에 넘긴다(머리말 14번).

        **모름을 닫혔다로 적지 않는다**(§13-3): 상태 칸이 없는 응답(`session_closed is None`)은
        판정이 아니다. **통화당 한 번만** 알린다 — 닫힌 세션의 응답에는 그 상태가 계속 실려
        오므로(서 있는 값이다) 턴마다 알리면 같은 마무리가 턴 수만큼 되풀이된다.
        통화를 끊지 않는다: 끊을지·안내를 더 할지는 호스트가 정한다.
        """
        if call.core_closed or res.session_closed is not True:
            return
        call.core_closed = True
        self.stats.calls_closed_by_core += 1
        status = res.run_status or ""
        if self._on_session_closed is None:
            return
        try:
            self._on_session_closed(call_id, status)
        except Exception:  # noqa: BLE001
            pass

    def _report(self, code: str, message_ko: str) -> None:
        if self._on_error is None:
            return
        try:
            self._on_error(code, message_ko)  # 발화·응답 원문은 싣지 않는다(§10.3)
        except Exception:  # noqa: BLE001
            pass


class AsyncCallbotCoreHooks:
    """asyncio 에이전트용. 블로킹 I/O 를 스레드로 보내 이벤트 루프를 막지 않는다.

    같은 통화의 훅은 **도착 순서대로** 처리된다 — 한 통화에서 두 턴이 겹치면 상태가 갈라지기 때문이다.
    순서를 지키는 방법이 핵심이다: 체인의 자리는 **앞 훅을 기다리기 전에, 동기적으로** 잡는다.
    기다린 뒤에 자리를 잡으면 뒤따라온 훅들이 전부 같은 앞 훅 하나만 보고 동시에 풀려나므로
    (스레드풀에서 나란히 실행된다) 순서가 무너지고, 가장 흔한 결과가 **end 가 마지막 턴을 앞지르는
    것**이다 — 턴은 "끝난 통화의 지연 전사"로 조용히 버려진다. 장애로 보이지 않기 때문에 더 나쁘다.
    """

    def __init__(self, inner: CallbotCoreHooks) -> None:
        self.inner = inner
        # call_id → 이 통화에 마지막으로 예약된 훅의 완료 신호. 예약 시점에 즉시 교체된다.
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

    @property
    def degraded(self) -> bool:
        """브리지가 죽어 Core 없이 돌고 있는가. `recover()` 를 부를 판단 근거다(머리말 11번)."""
        return self.inner.degraded

    @property
    def stats(self) -> HookStats:
        """실측 카운터. 비동기 호스트가 `h.inner.stats` 를 파게 두지 않는다(§2)."""
        return self.inner.stats

    async def _run(self, call_id: str, fn: Callable[[], Any]) -> Any:
        loop = asyncio.get_running_loop()
        done: "asyncio.Future[None]" = loop.create_future()
        prev = self._chain.get(call_id)
        # 자리를 먼저 잡는다(여기까지 await 가 없다). 뒤 훅은 앞 훅이 아니라 **바로 앞 훅**을 기다린다.
        self._chain[call_id] = done
        try:
            if prev is not None:
                try:
                    await prev
                except Exception:  # noqa: BLE001 - 앞 훅의 실패가 뒤 훅을 막지 않는다
                    pass
            return await loop.run_in_executor(None, fn)
        finally:
            if not done.done():
                done.set_result(None)   # 예외·취소 경로에서도 뒤 훅을 풀어 준다(막히면 통화가 멈춘다)
            if self._chain.get(call_id) is done:
                self._chain.pop(call_id, None)

    async def drain(self, call_id: Optional[str] = None) -> None:
        """예약된 훅이 끝날 때까지 기다린다. 어떤 실패도 던지지 않는다."""
        pending = [self._chain.get(call_id)] if call_id is not None else list(self._chain.values())
        for fut in [f for f in pending if f is not None]:
            try:
                await fut
            except Exception:  # noqa: BLE001 - 남의 실패를 기다린 쪽의 실패로 바꾸지 않는다
                pass

    async def on_call_start(self, call_id: str, **kw: Any) -> Optional[str]:
        return await self._run(call_id, lambda: self.inner.on_call_start(call_id, **kw))

    async def on_transcript(self, call_id: str, role: str, text: str, **kw: Any) -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_transcript(call_id, role, text, **kw))

    # `**kw` 를 받는 이유: 동기 쪽에만 인자를 더하면 **비동기 호스트에서만** 실측이 사라진다.
    # asyncio 에이전트가 권장 경로이므로 그 비대칭의 증상은 "음성 채널 전체에서 수량이 없다"다.
    async def on_dtmf(self, call_id: str, digits: str, **kw: Any) -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_dtmf(call_id, digits, **kw))

    async def on_unrecognized(self, call_id: str, text: str = "", **kw: Any) -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_unrecognized(call_id, text, **kw))

    async def on_timeout(self, call_id: str, **kw: Any) -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_timeout(call_id, **kw))

    # 같은 체인을 쓴다 — 조회 결과가 다음 발화를 앞지르면 그 발화가 **대기 중의 발화**로
    # 취급돼 조용히 버려지고(§6.1 구간), 반대 순서면 조회 결과가 먼저 반영돼야 할 자리를
    # 발화가 차지한다. 둘 다 예외가 아니다.
    async def on_connector_result(self, call_id: str, ok: bool, **kw: Any) -> Optional[BridgeResponse]:
        return await self._run(call_id, lambda: self.inner.on_connector_result(call_id, ok, **kw))

    def pending_connector_id(self, call_id: str) -> Optional[str]:
        """§6.1 대기 조회는 동기다 — 체인에 넣지 않는다(기다리는 동안 상태가 바뀌지 않는다)."""
        return self.inner.pending_connector_id(call_id)

    async def on_call_end(
        self,
        call_id: str,
        reason_ko: str = "통화 종료",
        billable_ms: Optional[float] = None,
    ) -> Optional[BridgeResponse]:
        # 값이 없으면 인자를 싣지 않는다 — 구버전 시그니처의 inner(테스트 대역·호스트 래퍼)를
        # 종료 자리에서 죽이지 않기 위해서다. 종료가 막히면 세션이 새고 누수는 요금이 된다.
        return await self._run(
            call_id,
            (lambda: self.inner.on_call_end(call_id, reason_ko)) if billable_ms is None
            else (lambda: self.inner.on_call_end(call_id, reason_ko, billable_ms)),
        )

    # ── 유지 루프·복구(§9.3·§2) ───────────────────────────────────────────
    # **통화 체인에 넣지 않는다**: 유지 루프에는 call_id 가 없고 통화 상태를 건드리지도 않는다.
    # 아무 통화의 체인에 끼우면 그 통화의 턴이 복구 확인·만료 수렴을 기다리게 되고, 그 선택은
    # 어댑터가 할 일이 아니다. 직렬화는 이미 두 겹으로 되어 있다 — `CallbotCoreHooks._lock` 과
    # 브리지의 JSONL 파이프다.
    #
    # 동기 쪽에만 열면 **asyncio 호스트에서만** 유지 루프가 사라진다. asyncio 가 권장 경로이므로
    # 그 비대칭의 증상은 "음성 채널 전체에서 폴백이 풀리지 않는다"다(실측·미인식 자리와 같은 교훈).
    async def _detached(self, fn: Callable[[], Any]) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, fn)

    async def maintenance_ops(self) -> list:
        return await self._detached(self.inner.maintenance_ops)

    async def warnings(self) -> Optional[BridgeResponse]:
        return await self._detached(self.inner.warnings)

    async def readiness(self) -> Optional[BridgeResponse]:
        return await self._detached(self.inner.readiness)

    async def run_recovery_probe(self) -> Optional[BridgeResponse]:
        return await self._detached(self.inner.run_recovery_probe)

    async def run_offer_expiry(self) -> Optional[BridgeResponse]:
        return await self._detached(self.inner.run_offer_expiry)

    async def run_invite_expiry(self) -> Optional[BridgeResponse]:
        return await self._detached(self.inner.run_invite_expiry)

    async def settle_offer(self, offer_id: str, event: str) -> Optional[BridgeResponse]:
        return await self._detached(lambda: self.inner.settle_offer(offer_id, event))

    async def observability(self) -> Optional[BridgeResponse]:
        return await self._detached(self.inner.observability)

    async def report_health(self, samples: Any, observed_at: str) -> Optional[BridgeResponse]:
        return await self._detached(lambda: self.inner.report_health(samples, observed_at))

    async def recover(self) -> bool:
        """예약된 훅을 먼저 비운 뒤 래치를 푼다 — 먼저 풀면 죽은 브리지로 향하던 턴들이
        **새 브리지를 띄우며** 깨어나고, 그 통화의 세션은 거기 없다(머리말 11번).
        """
        await self.drain()
        return await self._detached(self.inner.recover)

    async def close(self) -> None:
        """예약된 훅을 먼저 비운 뒤 닫는다 — 먼저 닫으면 남은 턴이 "끝난 통화"로 버려진다."""
        await self.drain()
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self.inner.close)
