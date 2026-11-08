"""Watchable API-runtime runs (native plan E2 / D9).

A ``claude_session`` run is watchable because its ``stream-json`` goes through
:mod:`factory.claude_session.pretty` inside a termhub session. An API-runtime
run (``runner.sandbox_run``: OpenHands + LiteLLM, DeepSeek/Azure models) used
to be visible only at stage level (``factory job follow``). This module gives
it the same turn-level view:

* :class:`ApiStream` is registered as an OpenHands ``Conversation`` callback.
  It maps each SDK event to a record shaped like Claude Code's
  ``stream-json`` (``assistant`` text / ``tool_use``, ``user`` ``tool_result``)
  plus factory records (``usage``, ``diff``, ``gate``), and appends it, one
  JSON object per line and flushed, to ``state/api_runs/<run>/stream.jsonl``.
  The run's end is a ``result`` record, exactly like Claude Code's.
* :func:`start_watch` opens a termhub session whose command is
  ``python -m factory.claude_session.pretty --follow <stream.jsonl>`` (the
  line is built for the session's shell by :func:`follow_command`: bash,
  PowerShell or cmd): a read-only follower (it never reads stdin) that replays the file, follows it,
  and exits after the ``result`` record. The shell stays, so the session stays
  reviewable; the file stays too, and ``pretty --follow`` re-renders it later.

Everything here is best-effort and never raises into the run: a watch that
breaks must leave the run exactly as it would have been without one.

``FACTORY_API_WATCH``: ``auto`` (default; termhub when reachable, else the
file only), ``termhub`` (always try termhub), ``file`` (no termhub), ``off``.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from factory.state_dir import state_dir

_log = logging.getLogger(__name__)

#: Caps so one huge observation cannot bloat the stream (the full trajectory
#: is captured separately by the runner).
_TEXT_CAP = 4000
_ARGS_CAP = 2000

#: Tool names whose observation may have changed the worktree: a diff summary
#: follows them.
_EDIT_TOOL_HINTS = ("edit", "file", "write", "patch", "terminal", "bash", "execute")


def watch_mode() -> str:
    mode = (os.environ.get("FACTORY_API_WATCH") or "auto").strip().lower()
    return mode if mode in ("auto", "termhub", "file", "off") else "auto"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _cap(text: str, cap: int) -> str:
    return text if len(text) <= cap else text[: cap - 15] + " …[truncated]"


# --------------------------------------------------------------------------- #
# OpenHands event -> stream-json-shaped records. Pure.
# --------------------------------------------------------------------------- #


def _content_text(content: Any) -> str:
    """Text of a content list (TextContent objects or dicts) or a string."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        parts: list[str] = []
        for c in content:
            if isinstance(c, dict):
                parts.append(str(c.get("text") or ""))
            else:
                parts.append(str(getattr(c, "text", "") or ""))
        return "\n".join(p for p in parts if p)
    return str(getattr(content, "text", "") or "")


def _tool_args(ev: Any) -> dict[str, Any]:
    call = getattr(ev, "tool_call", None)
    raw = getattr(call, "arguments", None)
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {"arguments": _cap(raw, _ARGS_CAP)}
        if isinstance(parsed, dict):
            return parsed
        return {"arguments": parsed}
    action = getattr(ev, "action", None)
    if action is not None:
        try:
            dumped = action.model_dump(exclude_none=True)
            if isinstance(dumped, dict):
                dumped.pop("kind", None)
                return dumped
        except Exception:  # noqa: BLE001
            pass
    return {}


def _observation_text(obs: Any) -> tuple[str, bool]:
    if obs is None:
        return "", False
    is_error = bool(getattr(obs, "is_error", False))
    text = _content_text(getattr(obs, "content", None))
    if not text:
        for attr in ("text", "output", "message"):
            val = getattr(obs, attr, None)
            if isinstance(val, str) and val:
                text = val
                break
    return text, is_error


def map_event(ev: Any) -> list[dict[str, Any]]:
    """Stream records for one OpenHands SDK event (``[]`` for events a human
    does not need: system prompt, condensation, state updates, token deltas)."""
    kind = type(ev).__name__
    source = str(getattr(ev, "source", "") or "")
    if kind == "ActionEvent":
        parts: list[dict[str, Any]] = []
        thought = _content_text(getattr(ev, "thought", None)).strip()
        if thought:
            parts.append({"type": "text", "text": _cap(thought, _TEXT_CAP)})
        parts.append(
            {
                "type": "tool_use",
                "id": str(getattr(ev, "tool_call_id", "") or ""),
                "name": str(getattr(ev, "tool_name", "") or "?"),
                "input": _tool_args(ev),
            }
        )
        return [{"type": "assistant", "message": {"content": parts}}]
    if kind in ("ObservationEvent", "AgentErrorEvent", "UserRejectObservation"):
        if kind == "ObservationEvent":
            text, is_error = _observation_text(getattr(ev, "observation", None))
        elif kind == "AgentErrorEvent":
            text, is_error = str(getattr(ev, "error", "") or ""), True
        else:
            text, is_error = f"rejected: {getattr(ev, 'rejection_reason', '')}", True
        return [
            {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": str(getattr(ev, "tool_call_id", "") or ""),
                            "tool_name": str(getattr(ev, "tool_name", "") or ""),
                            "content": _cap(text, _TEXT_CAP),
                            "is_error": is_error,
                        }
                    ]
                },
            }
        ]
    if kind == "MessageEvent":
        msg = getattr(ev, "llm_message", None)
        text = _content_text(getattr(msg, "content", None)).strip()
        if not text:
            return []
        if source == "agent":
            return [
                {
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": _cap(text, _TEXT_CAP)}]},
                }
            ]
        return [{"type": "factory", "subtype": "prompt", "source": source, "text": text[:600]}]
    if kind == "ConversationErrorEvent":
        return [
            {
                "type": "factory",
                "subtype": "error",
                "code": str(getattr(ev, "code", "") or ""),
                "detail": _cap(str(getattr(ev, "detail", "") or ""), _TEXT_CAP),
            }
        ]
    return []


# --------------------------------------------------------------------------- #
# Diff summary
# --------------------------------------------------------------------------- #


def git_diff_summary(repo: Path) -> dict[str, Any] | None:
    """``{files, insertions, deletions, untracked}`` for the worktree vs HEAD."""
    try:
        numstat = subprocess.run(  # noqa: S603
            ["git", "-C", str(repo), "diff", "--numstat", "HEAD"],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        untracked = subprocess.run(  # noqa: S603
            ["git", "-C", str(repo), "ls-files", "--others", "--exclude-standard"],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if numstat.returncode != 0:
        return None
    files: list[dict[str, Any]] = []
    ins = dels = 0
    for line in numstat.stdout.splitlines():
        cols = line.split("\t")
        if len(cols) != 3:
            continue
        a = int(cols[0]) if cols[0].isdigit() else 0
        d = int(cols[1]) if cols[1].isdigit() else 0
        ins, dels = ins + a, dels + d
        files.append({"path": cols[2], "added": a, "deleted": d})
    new = (
        [p for p in untracked.stdout.splitlines() if p.strip()] if untracked.returncode == 0 else []
    )
    return {"files": files, "insertions": ins, "deletions": dels, "untracked": new}


# --------------------------------------------------------------------------- #
# The stream writer
# --------------------------------------------------------------------------- #

#: ``() -> (tokens_in, tokens_out, cached_input_tokens, cost_usd) | None``
UsageFn = Callable[[], Any]
#: ``() -> git_diff_summary(...)``-shaped dict or None
DiffFn = Callable[[], Any]


class ApiStream:
    """Append-only, thread-safe ``stream.jsonl`` for one API run. Never raises."""

    def __init__(
        self,
        path: Path,
        *,
        usage_fn: UsageFn | None = None,
        diff_fn: DiffFn | None = None,
    ) -> None:
        self.path = Path(path)
        self.usage_fn = usage_fn
        self.diff_fn = diff_fn
        self._lock = threading.Lock()
        self._closed = False
        self._turns: set[str] = set()
        self._last_usage: tuple[int, int, int, float] | None = None
        self._last_diff: str | None = None
        self._t0 = time.monotonic()
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            _log.warning("api watch: cannot create %s", self.path.parent, exc_info=True)

    # -- low level ---------------------------------------------------------
    def write(self, record: dict[str, Any]) -> None:
        with self._lock:
            if self._closed:
                return
            if record.get("type") == "result":
                self._closed = True
            try:
                line = json.dumps({**record, "ts": _now()}, default=str)
                with self.path.open("a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
                    fh.flush()
            except Exception:  # noqa: BLE001 - a watch must never break a run
                _log.debug("api watch: write failed", exc_info=True)

    @property
    def num_turns(self) -> int:
        return len(self._turns)

    # -- records -----------------------------------------------------------
    def init(self, *, run_id: str, model: str, cwd: str, persona: str, title: str) -> None:
        self.write(
            {
                "type": "system",
                "subtype": "init",
                "runtime": "api",
                "session_id": run_id,
                "model": model,
                "cwd": cwd,
                "persona": persona,
                "title": title,
            }
        )

    def usage(self, *, force: bool = False) -> None:
        if self.usage_fn is None:
            return
        try:
            live = self.usage_fn()
        except Exception:  # noqa: BLE001
            return
        if live is None or (live == self._last_usage and not force):
            return
        self._last_usage = live
        t_in, t_out, cached, cost = live
        self.write(
            {
                "type": "factory",
                "subtype": "usage",
                "tokens_in": t_in,
                "tokens_out": t_out,
                "cached_input_tokens": cached,
                "cost_usd": round(cost, 6),
            }
        )

    def diff(self, *, force: bool = False) -> None:
        if self.diff_fn is None:
            return
        try:
            summary = self.diff_fn()
        except Exception:  # noqa: BLE001
            return
        if summary is None:
            return
        key = json.dumps(summary, sort_keys=True)
        if key == self._last_diff and not force:
            return
        self._last_diff = key
        self.write({"type": "factory", "subtype": "diff", **summary})

    def gate(self, *, round_no: int, passed: bool, reason: str, checks: list[Any]) -> None:
        self.diff(force=True)
        self.write(
            {
                "type": "factory",
                "subtype": "gate",
                "round": round_no,
                "passed": bool(passed),
                "reason": _cap(str(reason or ""), 500),
                "checks": [str(c) for c in checks][:20],
            }
        )

    def note(self, text: str) -> None:
        self.write({"type": "factory", "subtype": "note", "text": text})

    def end(
        self,
        *,
        success: bool,
        error: str | None,
        tokens_in: int,
        tokens_out: int,
        cached_input_tokens: int,
        cost_usd: float,
        stop_reason: str = "",
    ) -> None:
        self.diff()
        self.write(
            {
                "type": "result",
                "runtime": "api",
                "subtype": "success" if success else "error",
                "is_error": not success,
                "result": _cap(error or "", 1000),
                "stop_reason": stop_reason,
                "num_turns": self.num_turns,
                "duration_ms": int((time.monotonic() - self._t0) * 1000),
                "total_cost_usd": round(float(cost_usd or 0.0), 6),
                "usage": {
                    "input_tokens": int(tokens_in or 0) - int(cached_input_tokens or 0),
                    "cache_read_input_tokens": int(cached_input_tokens or 0),
                    "output_tokens": int(tokens_out or 0),
                },
            }
        )

    # -- the OpenHands Conversation callback -------------------------------
    def on_event(self, ev: Any) -> None:
        try:
            records = map_event(ev)
            for rec in records:
                self.write(rec)
            if not records:
                return
            kind = type(ev).__name__
            if kind == "ActionEvent" or (
                kind == "MessageEvent" and str(getattr(ev, "source", "")) == "agent"
            ):
                rid = getattr(ev, "llm_response_id", None) or getattr(ev, "id", None)
                if rid:
                    self._turns.add(str(rid))
                self.usage()
            elif kind == "ObservationEvent":
                name = str(getattr(ev, "tool_name", "") or "").lower()
                if any(h in name for h in _EDIT_TOOL_HINTS):
                    self.diff()
        except Exception:  # noqa: BLE001 - a watch must never break a run
            _log.debug("api watch: event mapping failed", exc_info=True)

    __call__ = on_event


# --------------------------------------------------------------------------- #
# The live session
# --------------------------------------------------------------------------- #


@dataclass
class ApiWatch:
    stream: ApiStream
    session: dict[str, Any] | None = None  # session_json for the runs row
    warning: str | None = None
    step_id: int | None = None  # the provisional runs row ``open_step`` opened


def stream_dir(
    software_factory_root: Path, *, app: str | None, story_id: Any, persona: str
) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    return (
        state_dir(Path(software_factory_root))
        / "api_runs"
        / f"{app or 'app'}-{story_id or 0}-{persona}-{stamp}"
    )


#: The directory that holds the ``factory`` package. The follower session is
#: started with this as its cwd, so ``python -m factory…`` resolves on every
#: platform without setting PYTHONPATH (which needs shell-specific syntax).
FACTORY_ROOT = Path(__file__).resolve().parents[1]

_PS_BARE = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\/:._-")


def _ps_quote(text: str) -> str:
    """PowerShell literal: single quotes, ``'`` doubled; no ``$``/backtick expansion."""
    return "'" + text.replace("'", "''") + "'"


def _cmd_quote(text: str) -> str:
    """cmd.exe: double quotes (``"`` cannot occur in a Windows path)."""
    return f'"{text}"'


def follow_command(
    stream_path: Path | str,
    *,
    platform: str | None = None,
    shell: str | None = None,
    python_exe: str | None = None,
) -> str:
    """The termhub session command line for the read-only follower.

    It is typed into the session's shell, so it is built for that shell:

    * POSIX (``platform`` not ``win32``): bash. ``< /dev/null`` keeps typed
      input away from the follower; ``PYTHONPATH`` is set too, so the line also
      works outside :data:`FACTORY_ROOT`.
    * Windows: termhub's shell is PowerShell (``pwsh``, else ``powershell``)
      and cmd only as a last resort, so ``shell`` defaults to ``powershell``.
      There is no ``/dev/null`` redirect: ``--follow`` never reads stdin. Paths
      are single-quoted for PowerShell (literal: ``$`` and backticks are not
      expanded), double-quoted for cmd, and a quoted interpreter path is
      prefixed with PowerShell's call operator ``&``. The session must start
      in :data:`FACTORY_ROOT` (``start_watch`` does) so ``-m factory…`` resolves.

    The follower exits after the ``result`` record; the shell survives it, so
    the session stays reviewable.
    """
    plat = platform or sys.platform
    py = python_exe or sys.executable
    tail = "-m factory.claude_session.pretty --follow"
    if not plat.startswith("win"):
        q = shlex.quote
        return f"PYTHONPATH={q(str(FACTORY_ROOT))} {q(py)} {tail} {q(str(stream_path))} < /dev/null"
    sh = (shell or "powershell").lower()
    if sh in ("cmd", "cmd.exe"):
        exe = py if set(py) <= _PS_BARE else _cmd_quote(py)
        return f"{exe} {tail} {_cmd_quote(str(stream_path))}"
    exe = py if set(py) <= _PS_BARE else f"& {_ps_quote(py)}"
    return f"{exe} {tail} {_ps_quote(str(stream_path))}"


#: Seam: tests replace this to inject a fake termhub client. Returns
#: ``(client, machine)`` or ``None`` when termhub must not be used.
def _default_client() -> tuple[Any, str] | None:
    from factory.claude_session.termhub import TermhubClient, machine_name

    client = TermhubClient.from_env()
    client.timeout_s = 5.0
    if watch_mode() == "termhub" or client.reachable():
        return client, machine_name()
    return None


client_factory: Callable[[], tuple[Any, str] | None] = _default_client


def start_watch(
    *,
    software_factory_root: Path,
    repo_path: Path,
    persona: str,
    model: str,
    app: str | None,
    story_id: Any,
    direction_id: str | None,
    usage_fn: UsageFn | None = None,
    open_step: Callable[[], tuple[int | None, dict[str, str] | None]] | None = None,
    diff: bool = True,
) -> ApiWatch | None:
    """Open the stream file (and, when termhub is reachable, the live session).

    ``open_step`` is called only when a session is about to be created: it
    opens the run's provisional ``runs`` row and returns ``(row_id, links)``,
    so the session's termhub ``links`` carry the step id.

    ``None`` when ``FACTORY_API_WATCH=off`` or the file cannot be created.
    """
    mode = watch_mode()
    if mode == "off":
        return None
    try:
        d = stream_dir(software_factory_root, app=app, story_id=story_id, persona=persona)
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        _log.warning("api watch: cannot create the stream dir", exc_info=True)
        return None
    stream = ApiStream(
        d / "stream.jsonl", usage_fn=usage_fn,
        # A text-only step (PM triage, SM, ...) has no worktree to diff.
        diff_fn=(lambda: git_diff_summary(Path(repo_path))) if diff else None,
    )
    # A job-level step (PM triage) has no story yet: no "story None" in the title.
    story_part = f" story {story_id}" if story_id is not None else ""
    title = f"factory {persona} · {app}:{direction_id}{story_part} · {model}"
    stream.init(run_id=d.name, model=model, cwd=str(repo_path), persona=persona, title=title)
    watch = ApiWatch(stream=stream)
    if mode == "file":
        return watch
    try:
        picked = client_factory()
    except Exception as exc:  # noqa: BLE001
        picked = None
        watch.warning = f"termhub unavailable: {exc}"
    if picked is None:
        watch.warning = watch.warning or "termhub not reachable; the run streams to its file only"
        return watch
    client, machine = picked
    # The step (its ``runs`` row) exists BEFORE the session, so the session's
    # links (JOBS-API v1.4, termhub ``links``) can name it.
    links: dict[str, str] | None = None
    if open_step is not None:
        try:
            watch.step_id, links = open_step()
        except Exception:  # noqa: BLE001
            _log.warning("api watch: opening the step row failed", exc_info=True)
    try:
        # cwd = FACTORY_ROOT: on Windows that is what makes ``-m factory…``
        # resolve (see ``follow_command``). FACTORY_TERMHUB_SHELL=cmd for a
        # Windows termhub whose sessions run cmd.exe instead of PowerShell.
        command = follow_command(stream.path, shell=os.environ.get("FACTORY_TERMHUB_SHELL"))
        extra: dict[str, Any] = {"links": links} if links else {}
        sid = client.create_session(cwd=str(FACTORY_ROOT), command=command, title=title, **extra)
    except Exception as exc:  # noqa: BLE001
        watch.warning = f"termhub session not created: {exc}"
        return watch
    url = None
    try:
        url = client.session_url(sid)
    except Exception:  # noqa: BLE001 - a link is nice-to-have
        url = None
    watch.session = {
        "machine": machine,
        "termhub_session_id": sid,
        "url": url,
        "stream": str(stream.path),
    }
    if links:
        watch.session["links"] = dict(links)
    try:
        (d / "session.json").write_text(json.dumps(watch.session), encoding="utf-8")
    except OSError:
        pass
    return watch


__all__ = [
    "ApiStream",
    "ApiWatch",
    "client_factory",
    "FACTORY_ROOT",
    "follow_command",
    "git_diff_summary",
    "map_event",
    "start_watch",
    "stream_dir",
    "watch_mode",
]
