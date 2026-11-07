"""``python -m factory.claude_session.pretty`` — render stream-json for a human.

Sits at the end of ``claude … | tee stream.jsonl | <this>`` inside the termhub
session. It must NEVER exit before EOF: if it did, ``tee`` would take SIGPIPE
and the Claude run would die with it. Every line is handled in a try/except.
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    from factory.claude_session.stream import render_event

    for raw in sys.stdin:
        try:
            line = raw.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                print(line, flush=True)
                continue
            if isinstance(event, dict):
                text = render_event(event)
                if text:
                    print(text, flush=True)
        except Exception:  # noqa: BLE001 - keep draining stdin no matter what
            continue
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
