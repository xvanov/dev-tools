"""``factory job …`` — the CLI the personal assistant drives (docs/JOBS-API.md).

Output discipline (the contract): with ``--json`` a command prints exactly ONE
JSON object on stdout and nothing else; exit 0 means a success shape, non-zero
means ``{"error": "<code>", "message": "..."}``. Anything else a command or an
imported module prints is redirected to stderr while the command runs. Every
option is optional at the Typer level and validated here, so a missing flag is
also a JSON error instead of Typer's plain-text usage message.
"""

from __future__ import annotations

import contextlib
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import typer

from factory.jobs.common import JobError

_FACTORY_ROOT = Path(__file__).resolve().parent.parent

job_app = typer.Typer(help="Hand the factory a job and track it (docs/JOBS-API.md).")

_EXIT_ERROR = 1


def _root() -> Path:
    return _FACTORY_ROOT


def _load_env() -> None:
    try:
        from dotenv import load_dotenv

        load_dotenv(_root() / ".env", override=False)
    except Exception:  # noqa: BLE001 - env loading is best-effort
        pass


def _render_human(obj: dict[str, Any]) -> str:
    if "error" in obj:
        return f"error ({obj['error']}): {obj['message']}"
    if "jobs" in obj:
        if not obj["jobs"]:
            return "(no jobs)"
        return "\n".join(
            f"{j['job_id']:<24} {j['state']:<12} {j['delivery']:<12} "
            f"${j['cost_usd']:<8.2f} {j['title']}" + (f"  — {j['why']}" if j.get("why") else "")
            for j in obj["jobs"]
        )
    lines = []
    for key, value in obj.items():
        if key == "stories":
            for s in value:
                lines.append(
                    f"  story {s['id']}: {s['state']}"
                    + (f"  {s['pr_url']} ({s['pr_state'] or '?'})" if s.get("pr_url") else "")
                )
            continue
        if isinstance(value, list | dict):
            value = json.dumps(value)
        lines.append(f"{key}: {value}")
    return "\n".join(lines)


def _need_job_id(job_id: str | None) -> str:
    """Nice 8 (review 2026-11-02): a missing positional is a JSON error under
    ``--json`` like every other validation error, not Typer's usage text."""
    if not job_id:
        raise JobError("missing_argument", "a job id (<app>:<direction_id>) is required")
    return job_id


def _run(as_json: bool, fn: Callable[[], dict[str, Any]]) -> None:
    """Run ``fn`` with stdout diverted to stderr, then print exactly one result."""
    _load_env()
    code = 0
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = fn()
    except JobError as exc:
        result, code = exc.as_json(), _EXIT_ERROR
    except Exception as exc:  # noqa: BLE001 - the contract wants JSON, not a traceback
        result, code = {"error": "internal", "message": f"{type(exc).__name__}: {exc}"}, 2
    if as_json:
        sys.stdout.write(json.dumps(result, default=str) + "\n")
    else:
        sys.stdout.write(_render_human(result) + "\n")
    sys.stdout.flush()
    if code:
        raise typer.Exit(code=code)


@job_app.command("submit")
def submit_cmd(
    app_name: str | None = typer.Option(None, "--app", help="App name (apps/<app>/)"),
    repo: str | None = typer.Option(None, "--repo", help="owner/name of a registered app's repo"),
    title: str | None = typer.Option(None, "--title", help="Job title"),
    ask_file: Path | None = typer.Option(None, "--ask-file", help="Markdown file with the ask"),
    ask: str | None = typer.Option(None, "--ask", help="The ask, inline"),
    done: list[str] | None = typer.Option(None, "--done", help="Acceptance criterion (repeat)"),
    pipeline: str = typer.Option("auto", "--pipeline", help="chain | solo | auto"),
    delivery: str | None = typer.Option(None, "--delivery", help="Requested delivery level"),
    model: list[str] | None = typer.Option(None, "--model", help="<persona>=<model_id> (repeat)"),
    source: str | None = typer.Option(
        None, "--source", help="Who is submitting (required; pa|human are auto-approved)"
    ),
    external_id: str | None = typer.Option(
        None, "--external-id", help="Caller's id; idempotency key per (source, external-id)"
    ),
    flow_file: Path | None = typer.Option(None, "--flow-file", help="Optional flow.md content"),
    api_spec_file: Path | None = typer.Option(
        None, "--api-spec-file", help="Optional api_spec.md content"
    ),
    as_json: bool = typer.Option(False, "--json", help="Print one JSON object"),
) -> None:
    """Create a job (a direction; pre-approved for --source pa/human). Idempotent on
    (source, external-id)."""
    from factory.jobs.submit import SubmitRequest, submit_job

    def read(path: Path | None, flag: str) -> str | None:
        if path is None:
            return None
        try:
            return Path(path).expanduser().read_text(encoding="utf-8")
        except OSError as exc:
            raise JobError("file_unreadable", f"{flag} {path}: {exc}") from exc

    def go() -> dict[str, Any]:
        if ask_file is not None and ask is not None:
            raise JobError("invalid_argument", "pass only one of --ask or --ask-file")
        text = read(ask_file, "--ask-file") if ask_file is not None else ask
        return submit_job(
            _root(),
            SubmitRequest(
                title=title or "",
                ask=text or "",
                app=app_name,
                repo=repo,
                done=list(done or []),
                pipeline=pipeline,
                delivery=delivery,
                models=list(model or []),
                source=source or "",
                external_id=external_id,
                flow_md=read(flow_file, "--flow-file"),
                api_spec_md=read(api_spec_file, "--api-spec-file"),
            ),
        )

    _run(as_json, go)


@job_app.command("status")
def status_cmd(
    job_id: str | None = typer.Argument(None, help="<app>:<direction_id>"),
    as_json: bool = typer.Option(False, "--json", help="Print one JSON object"),
    no_github: bool = typer.Option(
        False, "--no-github", help="Skip GitHub lookups (local view only)"
    ),
) -> None:
    """Report a job's state; PR state and merged come from GitHub."""
    from factory.jobs.status import job_status

    _run(as_json, lambda: job_status(_root(), _need_job_id(job_id), github=not no_github))


@job_app.command("list")
def list_cmd(
    source: str | None = typer.Option(None, "--source", help="Only jobs from this source"),
    active: bool = typer.Option(False, "--active", help="Only non-terminal jobs"),
    app_name: str | None = typer.Option(None, "--app", help="Only this app"),
    as_json: bool = typer.Option(False, "--json", help="Print one JSON object"),
    no_github: bool = typer.Option(
        False, "--no-github", help="Skip GitHub lookups (local view only)"
    ),
) -> None:
    """List jobs (status objects)."""
    from factory.jobs.status import list_jobs

    _run(
        as_json,
        lambda: list_jobs(
            _root(), source=source, active=active, app=app_name, github=not no_github
        ),
    )


@job_app.command("cancel")
def cancel_cmd(
    job_id: str | None = typer.Argument(None, help="<app>:<direction_id>"),
    as_json: bool = typer.Option(False, "--json", help="Print one JSON object"),
) -> None:
    """Stop further dispatch for a job (parks its live stories; deletes nothing)."""
    from factory.jobs.status import cancel_job

    _run(as_json, lambda: cancel_job(_root(), _need_job_id(job_id)))


@job_app.command("follow")
def follow_cmd(
    job_id: str | None = typer.Argument(None, help="<app>:<direction_id>"),
    interval: float = typer.Option(3.0, "--interval", help="Seconds between polls"),
) -> None:
    """Stream a job's events as plain lines; exit 0 when the job is terminal."""
    from factory.jobs.follow import follow_job

    _load_env()
    try:
        follow_job(_root(), _need_job_id(job_id), interval=interval)
    except JobError as exc:
        print(f"error ({exc.code}): {exc.message}", file=sys.stderr)
        raise typer.Exit(code=_EXIT_ERROR) from None
    except KeyboardInterrupt:
        raise typer.Exit(code=130) from None
