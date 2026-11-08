"""``python -m factory.claude_session.pretty`` — render stream-json for a human.

Two modes:

* stdin (default): sits at the end of ``claude … | tee stream.jsonl | <this>``
  inside the termhub session. It must NEVER exit before EOF: if it did, ``tee``
  would take SIGPIPE and the Claude run would die with it. Every line is
  handled in a try/except.
* ``--follow FILE``: the read-only follower of an API-runtime run
  (:mod:`factory.api_watch`, plan E2). Renders the file from the start, then
  follows it, and exits after the ``result`` record (the step ended). Re-running
  it on a finished file replays the whole run.
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable, Iterable
from pathlib import Path

#: A follower whose file has not grown for this long gives up (3 h: well past
#: the sandbox's hard wall clock plus grading grace).
IDLE_EXIT_S = 3 * 3600.0


def _render_line(raw: str) -> tuple[str | None, bool]:
    """``(text to print, is_end)`` for one raw line. Never raises."""
    from factory.claude_session.stream import render_event

    try:
        line = raw.strip()
        if not line:
            return None, False
        try:
            event = json.loads(line)
        except ValueError:
            return line, False
        if not isinstance(event, dict):
            return None, False
        return render_event(event), event.get("type") == "result"
    except Exception:  # noqa: BLE001 - keep draining no matter what
        return None, False


def render_line(raw: str) -> str | None:
    """The rendering of one line (``None`` = print nothing). Never raises.

    Used by ``factory.claude_session.round``, the Windows round runner, which
    does the ``tee | pretty`` pipeline itself (no shell pipeline there).
    """
    return _render_line(raw)[0] or None


def render_lines(lines: Iterable[str], emit: Callable[[str], None]) -> bool:
    """Render every line; True once a ``result`` record was seen."""
    ended = False
    for raw in lines:
        text, is_end = _render_line(raw)
        if text:
            emit(text)
        ended = ended or is_end
    return ended


def follow(
    path: Path,
    *,
    emit: Callable[[str], None],
    poll_s: float = 0.5,
    sleep: Callable[[float], None] = time.sleep,
    max_polls: int | None = None,
    idle_exit_s: float | None = IDLE_EXIT_S,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Tail ``path`` until a ``result`` record (True), ``max_polls`` or
    ``idle_exit_s`` without growth (False — a run process killed before it
    could write its end leaves no ``result``; the follower must not live
    forever).

    Waits for the file to appear. Only complete lines are rendered, so a record
    being written is never split.
    """
    pos = 0
    buf = ""
    polls = 0
    last_growth = clock()
    while True:
        try:
            with Path(path).open("r", encoding="utf-8", errors="replace") as fh:
                fh.seek(pos)
                chunk = fh.read()
                pos = fh.tell()
        except OSError:
            chunk = ""
        if chunk:
            last_growth = clock()
            buf += chunk
            *complete, buf = buf.split("\n")
            if render_lines(complete, emit):
                return True
        if max_polls is not None and polls >= max_polls:
            return False
        if idle_exit_s is not None and clock() - last_growth >= idle_exit_s:
            emit(f"── no new output for {int(idle_exit_s)} s; the run likely died — stopping")
            return False
        polls += 1
        sleep(poll_s)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)

    def _emit(text: str) -> None:
        print(text, flush=True)

    if len(args) == 2 and args[0] == "--follow":
        # Never reads stdin, so it needs no ``< /dev/null`` (which a Windows
        # shell lacks). A console that cannot encode a glyph gets a ``?``
        # instead of killing the follower.
        try:
            sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
        follow(Path(args[1]), emit=_emit)
        print("── stream ended; this session is a read-only record of the run", flush=True)
        return 0
    for raw in sys.stdin:
        text, _ = _render_line(raw)
        if text:
            try:
                _emit(text)
            except Exception:  # noqa: BLE001 - keep draining stdin no matter what
                continue
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
