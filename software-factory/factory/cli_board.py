"""``factory job board`` and ``factory job step`` (JOBS-API v1.11, native plan 8.8).

The reads behind the personal assistant's Build board: the factory at a glance
and one step's turns. Registered on ``job_app`` (``factory/cli_jobs.py``) by
importing this module; ``factory serve`` answers both without Typer
(``factory/scheduler/api.py`` fast path). The logic is ``factory.jobs.board``.
"""

from __future__ import annotations

import typer

from factory.cli_jobs import _root, _run, job_app


def parse_fast(argv: list[str]) -> dict[str, object] | None:
    """``job board|step`` argv as options for ``factory serve``'s fast path, or
    None (anything unusual goes through Typer and gets Typer's reply)."""
    if argv[:2] == ["job", "board"]:
        return {"verb": "board", "json": True} if argv[2:] == ["--json"] else None
    if argv[:2] != ["job", "step"]:
        return None
    opts: dict[str, object] = {"verb": "step", "json": False, "step": None, "cursor": None,
                               "limit": 200, "wait": 0.0, "at": None}
    rest = argv[2:]
    i = 0
    try:
        while i < len(rest):
            tok = rest[i]
            if tok == "--json":
                opts["json"] = True
            elif tok in ("--cursor", "--limit", "--wait", "--at"):
                i += 1
                if i >= len(rest):
                    return None
                val = rest[i]
                key = tok[2:]
                opts[key] = int(val) if key == "limit" else float(val) if key == "wait" else val
            elif tok.startswith("-") or opts["step"] is not None:
                return None
            else:
                opts["step"] = tok
            i += 1
    except ValueError:
        return None
    return opts if opts["json"] else None


def run_fast(opts: dict[str, object]) -> None:
    """Run a :func:`parse_fast` result (prints one JSON object, like the CLI)."""
    from factory.jobs.board import board_snapshot, step_events

    if opts["verb"] == "board":
        _run(True, lambda: board_snapshot(_root()))
        return
    _run(
        True,
        lambda: step_events(
            _root(),
            parse_step_id(opts["step"]),  # type: ignore[arg-type]
            cursor=opts["cursor"],  # type: ignore[arg-type]
            limit=int(opts["limit"]),  # type: ignore[call-overload]
            wait_s=float(opts["wait"]),  # type: ignore[arg-type]
            at=opts["at"],  # type: ignore[arg-type]
        ),
    )


def parse_step_id(raw: str | None) -> int:
    from factory.jobs.common import JobError

    if not raw or not str(raw).isdigit():
        raise JobError("invalid_step_id", "a step id is the integer `runs[].id` of a job status")
    return int(raw)


@job_app.command("board")
def board_cmd(
    as_json: bool = typer.Option(False, "--json", help="Print one JSON object"),
) -> None:
    """The factory at a glance: spend, paused runtimes, progress + ETA, recent steps."""
    from factory.jobs.board import board_snapshot

    _run(as_json, lambda: board_snapshot(_root()))


@job_app.command("step")
def step_cmd(
    step_id: str | None = typer.Argument(None, help="A step id (runs[].id)"),
    as_json: bool = typer.Option(False, "--json", help="Print one JSON object"),
    cursor: str | None = typer.Option(None, "--cursor", help="Read from <file>:<offset>"),
    limit: int = typer.Option(200, "--limit", help="At most this many stream lines"),
    wait: float = typer.Option(0.0, "--wait", help="Wait up to N s (max 25) for a new line"),
    at: str | None = typer.Option(None, "--at", help="Only the record at <file>:<offset>, uncapped"),
) -> None:
    """One step's turns (text, tool calls and results, diffs, gates, usage), paginated."""
    from factory.jobs.board import step_events

    _run(
        as_json,
        lambda: step_events(
            _root(), parse_step_id(step_id), cursor=cursor, limit=limit, wait_s=wait, at=at
        ),
    )
