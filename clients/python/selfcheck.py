# -*- coding: utf-8 -*-
"""파이썬 참조 클라이언트 자체점검 — 복사용 최소 예시이자 CI 단계.

브리지를 dry_run 으로 띄워 한 통화를 끝까지 돌리고, 주고받은 줄을 그대로 표준출력에 내놓는다.
판정은 이 스크립트가 하지 않는다 — `scripts/bridge-transcript.mjs` 가 한다.
검사와 판정을 한 프로세스에 두면 "자기 채점"이 되기 때문이다.

사용: AICC_CORE=<core 경로> python3 clients/python/selfcheck.py > transcript.json
      node scripts/bridge-transcript.mjs --transcript transcript.json --adapter callbot --max-line-bytes 65536

실회선·실 STT/TTS 에 붙지 않는다. 예시 시나리오(fixtures/reference-core.mjs)만 쓰며
개인정보를 담지 않는다(§10.3).
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aicc_bridge import BridgeClient  # noqa: E402

CORE_ROOT = os.environ.get("AICC_CORE") or os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
)


def main() -> int:
    core_module = os.path.join(CORE_ROOT, "fixtures", "reference-core.mjs")
    with BridgeClient(
        core_module=core_module,
        adapter="callbot",
        core_root=CORE_ROOT,
        cwd=CORE_ROOT,
        max_line_bytes=65536,
        keep_transcript=True,
    ) as client:
        client.hello()
        with client.session(
            flow_id="f_reference_voice",
            entry_point="inbound_call",
            reason_ko="자체점검 종료",
        ) as call:
            # 음성 채널의 세 가지 입력을 모두 한 번씩 지난다: 발화 · DTMF · 무음.
            call.send_utterance("잔액 조회 부탁드립니다", confidence=0.92)
            call.send_dtmf("1")
            call.send_timeout()
        # 관측 시각은 호출자가 준다 — 클라이언트가 만들어 넣지 않는다(§13-3).
        client.report_health(
            [{"component": "stt", "state": "up"}],
            observed_at="2026-09-07T00:00:00.000Z",
        )
        transcript = client.transcript
        json.dump(
            {"requests": transcript.requests, "responses": transcript.responses},
            sys.stdout,
            ensure_ascii=False,
        )
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
