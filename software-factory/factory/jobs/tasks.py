"""Research, report and plan jobs (JOBS-API v1.2, plan v1.8): one agent run → ``report.md``.

A ``kind: research|report|plan`` job is NOT a direction: no PM, no stories, no issue,
branch or PR, no backpressure gate. It lives entirely under the factory's state
dir, so pm-sync and the chain never see it::

    state/jobs/<task_id>-<slug>/
        job.yaml        the job (what was asked, state, timestamps, worker pid)
        ask.md          the ask, verbatim
        brief.md        the prompt the agent got
        report.md       THE DELIVERABLE (copied from the agent's workspace)
        workspace/      scratch dir (no repo) — or checkout/ (read-only clone)
        run/            Claude Code run dir (round scripts, stream-json, exit codes)
        worker.log      the detached worker's stdout/stderr

Ids: ``task_id`` is ``r`` + 4 digits (``r0007``), so it never collides with a
direction id (all digits). The job id is ``<app>:<task_id>``, or
``scratch:<task_id>`` when the job names no app.

Lifecycle: ``queued`` → (``factory job dispatch``, run by every ``factory tick``)
→ ``starting`` → the detached worker (``python -m factory.jobs.worker``) sets
``running`` → ``done`` (report written) | ``failed`` (the agent ended without
one) | ``cancelled``. At most ``FACTORY_TASK_MAX_WORKERS`` (default 2) run at
once. A ``running`` job whose worker died is marked ``failed`` by the next
dispatch.

Agent per runtime:

* ``api`` — one OpenHands agent (``runner.sandbox_run``, persona
  ``researcher``, default tools) on the ``dev`` route, or
  ``--model researcher=<id>``. Its in-conversation gate is "``FACTORY_REPORT.md``
  exists and is not empty" (≤ 2 rounds).
* ``claude_session`` — one Claude Code conversation
  (:func:`factory.claude_session.run.run_claude`) in a termhub session.

Both write ``FACTORY_REPORT.md`` in their working directory; the factory moves
it to ``report.md``. Wall clock: 5400 s (as solo).

``plan`` (v1.8) is read-only. On ``claude_session`` Claude Code starts in its
``plan`` permission mode (no ``--dangerously-skip-permissions``), so it cannot
write even the report: its plan (the last ``ExitPlanMode`` plan, else its final
message) is written to ``FACTORY_REPORT.md`` by the factory. On ``api`` the
agent writes the report like research; its workspace is a throwaway clone with
pushes blocked, so nothing it changes leaves it.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from factory.jobs.common import JobError, format_job_id, parse_job_id
from factory.jobs.kinds import (
    KIND_PLAN,
    KIND_REPORT,
    READ_ONLY_KINDS,
    READ_ONLY_PERMISSION_MODE,
    RUNTIME_CLAUDE,
)
from factory.oscompat import (
    IS_WINDOWS,
    detached_popen_kwargs,
    kill_tree,
    lock_file,
    unlock_file,
)
from factory.oscompat import pid_alive as _os_pid_alive
from factory.state_dir import state_dir

SCRATCH_APP = "scratch"
TASK_ID_RE = re.compile(r"^r\d{4,}$")
REPORT_NAME = "FACTORY_REPORT.md"
TASK_WALL_CLOCK_S = 5400
TASK_MAX_GATE_ROUNDS = 2
DEFAULT_MAX_WORKERS = 2

#: job.yaml ``state`` values.
QUEUED, STARTING, RUNNING, DONE, FAILED, CANCELLED = (
    "queued",
    "starting",
    "running",
    "done",
    "failed",
    "cancelled",
)
TERMINAL = frozenset({DONE, FAILED, CANCELLED})


def tasks_root(root: Path) -> Path:
    return state_dir(Path(root)) / "jobs"


def is_task_job_id(job_id: str) -> bool:
    try:
        _, rest = parse_job_id(job_id)
    except JobError:
        return False
    return bool(TASK_ID_RE.match(rest))


@dataclass
class TaskRef:
    task_id: str
    dir_path: Path
    meta: dict[str, Any]

    @property
    def app(self) -> str | None:
        app = self.meta.get("app")
        return str(app) if app else None

    @property
    def app_label(self) -> str:
        return self.app or SCRATCH_APP

    @property
    def job_id(self) -> str:
        return format_job_id(self.app_label, self.task_id)


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #


def read_meta(dir_path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load((Path(dir_path) / "job.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}
    return data if isinstance(data, dict) else {}


def write_meta(dir_path: Path, meta: dict[str, Any]) -> None:
    path = Path(dir_path) / "job.yaml"
    tmp = path.with_name(f".job.yaml.{uuid.uuid4().hex[:8]}")
    tmp.write_text(yaml.safe_dump(meta, sort_keys=False, allow_unicode=True), encoding="utf-8")
    os.replace(tmp, path)


def update_meta(dir_path: Path, **changes: Any) -> dict[str, Any]:
    meta = read_meta(dir_path)
    meta.update(changes)
    meta["updated_at"] = _now()
    write_meta(dir_path, meta)
    return meta


def _now() -> str:
    return datetime.now(UTC).isoformat()


def iter_tasks(root: Path, *, app: str | None = None) -> list[TaskRef]:
    base = tasks_root(root)
    if not base.is_dir():
        return []
    out: list[TaskRef] = []
    for d in sorted(base.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        task_id = d.name.split("-", 1)[0]
        if not TASK_ID_RE.match(task_id):
            continue
        meta = read_meta(d)
        if not meta:
            continue
        ref = TaskRef(task_id, d, meta)
        if app is not None and ref.app_label != app:
            continue
        out.append(ref)
    return out


def find_task(root: Path, job_id: str) -> TaskRef:
    app, task_id = parse_job_id(job_id)
    for ref in iter_tasks(root):
        if ref.task_id == task_id:
            if ref.app_label != app:
                raise JobError("not_found", f"no job {job_id!r} (it is {ref.job_id})")
            return ref
    raise JobError("not_found", f"no job {job_id!r}")


def find_existing_task(root: Path, source: str, external_id: str) -> TaskRef | None:
    for ref in iter_tasks(root):
        if (
            str(ref.meta.get("source") or "") == source
            and str(ref.meta.get("external_id") or "") == external_id
        ):
            return ref
    return None


def next_task_id(root: Path) -> str:
    highest = 0
    base = tasks_root(root)
    if base.is_dir():
        for d in base.iterdir():
            m = re.match(r"^(?:\.staging-)?r(\d+)", d.name)
            if m:
                highest = max(highest, int(m.group(1)))
    return f"r{highest + 1:04d}"


@contextlib.contextmanager
def _lock(root: Path, name: str) -> Iterator[None]:
    path = tasks_root(root) / f".{name}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        lock_file(handle)
        try:
            yield
        finally:
            unlock_file(handle)


def create_task(
    root: Path,
    *,
    kind: str,
    runtime: str,
    title: str,
    ask: str,
    app: str | None,
    repo: str | None,
    done: list[str],
    models: dict[str, str],
    claude_model: str | None,
    source: str,
    external_id: str | None,
) -> tuple[TaskRef, bool]:
    """Create the job directory atomically. Returns ``(ref, created)``; a
    resubmit with the same ``(source, external_id)`` returns the original."""
    base = tasks_root(root)
    base.mkdir(parents=True, exist_ok=True)
    with _lock(root, "submit"):
        if external_id:
            existing = find_existing_task(root, source, external_id)
            if existing is not None:
                return existing, False
        task_id = next_task_id(root)
        from factory.directions.parser import slugify

        final = base / f"{task_id}-{slugify(title)[:48]}"
        staging = base / f".staging-{task_id}-{uuid.uuid4().hex[:6]}"
        staging.mkdir()
        try:
            now = _now()
            meta: dict[str, Any] = {
                "task_id": task_id,
                "kind": kind,
                "runtime": runtime,
                "title": title,
                "app": app,
                "repo": repo,
                "source": source,
                "external_id": external_id,
                "done": list(done),
                "models": dict(models),
                "claude_model": claude_model,
                "delivery": "none",
                "state": QUEUED,
                "why": None,
                "created_at": now,
                "updated_at": now,
                "started_at": None,
                "ended_at": None,
                "worker_pid": None,
                "report_path": None,
                "workspace": None,
                "cancel": None,
            }
            (staging / "ask.md").write_text(ask, encoding="utf-8")
            write_meta(staging, meta)
            os.rename(staging, final)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    return TaskRef(task_id, final, read_meta(final)), True


# --------------------------------------------------------------------------- #
# The brief (pure)
# --------------------------------------------------------------------------- #


def build_brief(
    *,
    kind: str,
    title: str,
    ask: str,
    questions: list[str],
    workspace_note: str,
    final_answer: bool = False,
) -> str:
    """The job text the agent gets (the persona prompt is added by the runtime).

    ``final_answer``: the agent cannot write files (a read-only ``plan`` run in
    Claude Code's plan permission mode), so the deliverable is its final
    message, which the factory saves as the report.
    """
    plan = kind == KIND_PLAN
    verb = "Write" if kind == KIND_REPORT else "Plan and write up" if plan else "Research and write up"
    heading = "Report" if kind == KIND_REPORT else "Plan" if plan else "Research"
    lines = [
        f"# {heading} job: {title}",
        "",
        "## The ask",
        "",
        ask.strip(),
        "",
    ]
    if questions:
        lines += [f"## Questions the {'plan' if plan else 'report'} MUST answer", ""]
        lines += [f"{i}. {q.strip()}" for i, q in enumerate(questions, 1) if q.strip()]
        lines += [""]
    lines += [
        "## Where you are",
        "",
        workspace_note,
        "",
    ]
    if plan:
        lines += [
            "This is a READ-ONLY planning job: read the code, run read-only commands, and",
            "write an implementation plan with a sketch of the diff. Change no file.",
            "",
        ]
    lines += ["## Deliverable", ""]
    if final_answer:
        lines += [
            "You are in Claude Code's plan mode: you cannot write files. Your plan IS "
            "the deliverable: give it as ONE markdown document in your final message "
            "(or as the plan you propose to exit plan mode with). The factory saves "
            "it and hands it back; nobody will approve it mid-run, so do not wait.",
            "",
        ]
    else:
        lines += [
            f"{verb} the answer as ONE markdown document saved as `{REPORT_NAME}` in "
            "your current working directory. That file is the only thing the factory "
            "keeps and hands back; anything you only say in chat is lost.",
            "",
        ]
    lines += [
        "- Start with `# <title>` and a short summary that answers the ask directly.",
        "- Answer every question above under its own heading, in order.",
        "- Cite where each fact came from (file path + line, command output, or URL).",
        "  Say plainly what you could not verify.",
        "- Do not commit, push, open pull requests or issues, or change anything",
        "  outside your working directory.",
        "",
    ]
    return "\n".join(lines)


def _workspace_note(repo: str | None, sha: str | None, *, writes_report: bool = True) -> str:
    if repo:
        return (
            f"Your working directory is a fresh, READ-ONLY checkout of `{repo}`"
            + (f" at `{sha[:12]}`" if sha else "")
            + ". Read and run anything you need; do not modify tracked files. "
            + (f"The only file you write is `{REPORT_NAME}`." if writes_report else "You write no file.")
        )
    return (
        "Your working directory is an empty scratch directory (no repository). "
        "Use it for notes and downloads as you like."
    )


# --------------------------------------------------------------------------- #
# Workspace
# --------------------------------------------------------------------------- #


def _git(cwd: Path | None, *args: str, timeout: int = 600) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return -1, str(exc)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def prepare_workspace(root: Path, ref: TaskRef) -> tuple[Path, str | None]:
    """A read-only checkout of the app's repo, or a scratch dir. ``(cwd, sha)``."""
    app = ref.app
    if not app:
        ws = ref.dir_path / "workspace"
        ws.mkdir(exist_ok=True)
        # A git repo only so the agent runtime can fingerprint progress.
        if not (ws / ".git").exists():
            _git(ws, "init", "--quiet")
        return ws, None
    from factory.app_config import load_app_config, resolve_app_repo_path

    cfg = load_app_config(app, root)
    src = resolve_app_repo_path(cfg, root)
    dst = ref.dir_path / "checkout"
    if dst.exists():
        shutil.rmtree(dst, ignore_errors=True)
    branch = cfg.default_branch or "main"
    sha: str | None = None
    if (src / ".git").exists():
        _git(src, "fetch", "--quiet", "origin", branch, timeout=300)
        for rev in (f"origin/{branch}", branch, "HEAD"):
            rc, out = _git(src, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
            if rc == 0 and out.strip():
                sha = out.strip().splitlines()[0]
                break
        rc, out = _git(None, "clone", "--quiet", "--local", "--no-checkout", str(src), str(dst))
        if rc != 0:
            raise RuntimeError(f"could not clone {src}: {out[:300]}")
        if sha:
            rc, out = _git(dst, "checkout", "--quiet", "--detach", sha)
            if rc != 0:
                raise RuntimeError(f"could not check out {sha}: {out[:300]}")
    else:
        url = f"https://github.com/{cfg.repo}.git"
        rc, out = _git(None, "clone", "--quiet", "--depth", "1", "--branch", branch, url, str(dst))
        if rc != 0:
            raise RuntimeError(f"could not clone {url}: {out[:300]}")
        rc, out = _git(dst, "rev-parse", "HEAD")
        sha = out.strip() if rc == 0 else None
    # Read-only in the sense that matters: nothing can be pushed from here.
    _git(dst, "remote", "set-url", "--push", "origin", "no-push://read-only-checkout")
    return dst, sha


# --------------------------------------------------------------------------- #
# Running (inside the detached worker)
# --------------------------------------------------------------------------- #


def _persona_text() -> str:
    from factory.runner import _read_persona_prompt

    return _read_persona_prompt("researcher")


def _report_gate(cwd: Path) -> Callable[[], Any]:
    from factory.runner import GateVerdict

    def _check() -> Any:
        path = Path(cwd) / REPORT_NAME
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            text = ""
        if text.strip():
            return GateVerdict(
                passed=True,
                reason="report written",
                checks=[{"name": "report", "passed": True, "reason": "present"}],
            )
        return GateVerdict(
            passed=False,
            reason=(
                f"there is no `{REPORT_NAME}` in your working directory (or it is empty). "
                "Write the report there now; it is the only deliverable."
            ),
            checks=[{"name": "report", "passed": False, "reason": "missing"}],
        )

    return _check


def _cancel_requested(dir_path: Path) -> bool:
    return bool(read_meta(dir_path).get("cancel"))


def _api_model(root: Path, ref: TaskRef) -> str:
    from factory.model_router import route_with_overrides

    models = {str(k): str(v) for k, v in (ref.meta.get("models") or {}).items()}
    if models.get("researcher"):
        return route_with_overrides("researcher", "standard", models)
    app_models: dict[str, str] = {}
    if ref.app:
        try:
            from factory.app_config import load_app_config

            app_models = dict(load_app_config(ref.app, root).models or {})
        except Exception:  # noqa: BLE001
            app_models = {}
    return route_with_overrides("dev", "standard", {**app_models, **models})


def _default_api_runner(
    root: Path, ref: TaskRef, cwd: Path, brief_path: Path, db: Path
) -> dict[str, Any]:
    import asyncio

    from factory.runner import LLMConfig, sandbox_run

    res = asyncio.run(
        sandbox_run(
            persona="researcher",
            story_path=brief_path,
            repo_path=cwd,
            llm_config=LLMConfig(model=_api_model(root, ref)),
            software_factory_root=root,
            db_path=db,
            app=ref.app_label,
            direction_id=ref.task_id,
            wall_clock_timeout_s=TASK_WALL_CLOCK_S,
            gate_check=_report_gate(cwd),
            max_gate_rounds=TASK_MAX_GATE_ROUNDS,
        )
    )
    return {"error": res.error, "summary": (res.summary or "")[-1000:]}


def _default_claude_runner(
    root: Path, ref: TaskRef, cwd: Path, brief_path: Path, db: Path
) -> dict[str, Any]:
    from factory.claude_session.run import run_claude

    read_only = ref.meta.get("kind") in READ_ONLY_KINDS
    prompt = (
        _persona_text().rstrip()
        + "\n\n---\n\n"
        + brief_path.read_text(encoding="utf-8")
        + "\n\nNobody will answer questions mid-run. Decide, and state what you assumed.\n"
    )
    outcome = run_claude(
        db_path=db,
        persona="researcher",
        cwd=cwd,
        run_dir=ref.dir_path / "run",
        prompt=prompt,
        title=f"factory {ref.meta.get('kind')} · {ref.job_id} · {ref.meta.get('title')}"[:120],
        model=ref.meta.get("claude_model") or None,
        wall_clock_s=TASK_WALL_CLOCK_S,
        app=ref.app_label,
        direction_id=ref.task_id,
        story_path=str(brief_path),
        # A read-only run cannot write the report, so there is nothing for the
        # report gate to send it back for: the factory writes the report below.
        gate_check=None if read_only else _report_gate(cwd),
        max_gate_rounds=1 if read_only else TASK_MAX_GATE_ROUNDS,
        cancelled=lambda: _cancel_requested(ref.dir_path),
        links={"external": ref.meta.get("external_id")},
        permission_mode=READ_ONLY_PERMISSION_MODE if read_only else None,
    )
    conv = outcome.conversation
    if read_only:
        save_plan(cwd, conv.plan_text, is_error=bool(conv.error))
    return {"error": conv.error, "warning": outcome.warning, "stop": conv.stop_reason}


def save_plan(cwd: Path, text: str, *, is_error: bool = False) -> bool:
    """A read-only run's plan, written as its report by the factory (the run
    itself may not write). An errored run's text is Claude's error, not a plan:
    nothing is saved and the job fails with it. Returns whether it was saved."""
    plan = (text or "").strip()
    if not plan or is_error:
        return False
    (Path(cwd) / REPORT_NAME).write_text(plan + "\n", encoding="utf-8")
    return True


#: Seams: tests replace these to fake the agent.
api_runner: Callable[[Path, TaskRef, Path, Path, Path], dict[str, Any]] = _default_api_runner
claude_runner: Callable[[Path, TaskRef, Path, Path, Path], dict[str, Any]] = _default_claude_runner


def run_task(root: Path, job_id: str) -> dict[str, Any]:
    """The worker body: prepare, run the agent, keep the report. Never raises."""
    root = Path(root)
    ref = find_task(root, job_id)
    d = ref.dir_path
    meta = ref.meta
    if meta.get("state") in TERMINAL:
        return meta
    if meta.get("cancel"):
        return update_meta(d, state=CANCELLED, ended_at=_now(), why="cancelled before it started")
    update_meta(d, state=RUNNING, worker_pid=os.getpid(), started_at=_now(), why=None)
    db = state_dir(root) / "factory.db"
    try:
        cwd, sha = prepare_workspace(root, ref)
        ref.meta = update_meta(d, workspace=str(cwd), base_sha=sha)
        ask = (d / "ask.md").read_text(encoding="utf-8")
        final_answer = (
            meta.get("kind") in READ_ONLY_KINDS and meta.get("runtime") == RUNTIME_CLAUDE
        )
        brief = build_brief(
            kind=str(meta.get("kind")),
            title=str(meta.get("title")),
            ask=ask,
            questions=[str(q) for q in meta.get("done") or []],
            workspace_note=_workspace_note(
                ref.meta.get("repo") or ref.app, sha, writes_report=not final_answer
            ),
            final_answer=final_answer,
        )
        brief_path = d / "brief.md"
        brief_path.write_text(brief, encoding="utf-8")
        runner = claude_runner if meta.get("runtime") == RUNTIME_CLAUDE else api_runner
        info = runner(root, ref, cwd, brief_path, db)
    except Exception as exc:  # noqa: BLE001 - a crash is a failed job, with the reason
        return update_meta(
            d, state=FAILED, ended_at=_now(), why=f"{type(exc).__name__}: {exc}"[:500]
        )
    report_src = Path(cwd) / REPORT_NAME
    if read_meta(d).get("cancel"):
        return update_meta(d, state=CANCELLED, ended_at=_now(), why="cancelled while running")
    try:
        text = report_src.read_text(encoding="utf-8")
    except OSError:
        text = ""
    if text.strip():
        (d / "report.md").write_text(text, encoding="utf-8")
        final = update_meta(
            d,
            state=DONE,
            ended_at=_now(),
            report_path=str(d / "report.md"),
            why=info.get("warning"),
        )
    else:
        why = "the agent ended without writing a report"
        if info.get("error"):
            why += f": {info['error']}"
        final = update_meta(d, state=FAILED, ended_at=_now(), why=why[:500])
    if ref.app and (d / "checkout").exists():
        shutil.rmtree(d / "checkout", ignore_errors=True)
    return final


# --------------------------------------------------------------------------- #
# Dispatch (called by every factory tick)
# --------------------------------------------------------------------------- #


def _pid_alive(pid: int) -> bool:
    return _os_pid_alive(pid)


def _spawn_worker(root: Path, ref: TaskRef) -> int:
    log = (ref.dir_path / "worker.log").open("ab")
    env = dict(os.environ)
    env["PYTHONPATH"] = str(root) + (
        os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
    )
    proc = subprocess.Popen(  # noqa: S603
        [sys.executable, "-m", "factory.jobs.worker", str(root), ref.job_id],
        cwd=str(root),
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        env=env,
        **detached_popen_kwargs(),
    )
    log.close()
    return proc.pid


#: Seams for tests.
pid_alive: Callable[[int], bool] = _pid_alive
spawn_worker: Callable[[Path, TaskRef], int] = _spawn_worker


def max_workers() -> int:
    try:
        return max(1, int(os.environ.get("FACTORY_TASK_MAX_WORKERS") or DEFAULT_MAX_WORKERS))
    except ValueError:
        return DEFAULT_MAX_WORKERS


def dispatch_tasks(root: Path, *, dry_run: bool = False) -> dict[str, Any]:
    """Reap dead workers, then start queued jobs up to the worker cap."""
    root = Path(root)
    started: list[str] = []
    reaped: list[str] = []
    blocked: str | None = None
    with _lock(root, "dispatch"):
        refs = iter_tasks(root)
        live = 0
        for ref in refs:
            state = ref.meta.get("state")
            if state not in (STARTING, RUNNING):
                continue
            pid = ref.meta.get("worker_pid")
            if pid and pid_alive(int(pid)):
                live += 1
                continue
            if state == STARTING and not pid and not _stale(ref.meta, STARTING_STALE_S):
                live += 1  # claimed, worker not up yet
                continue
            reaped.append(ref.job_id)
            if not dry_run:
                update_meta(
                    ref.dir_path,
                    state=CANCELLED if ref.meta.get("cancel") else FAILED,
                    ended_at=_now(),
                    why="the job's worker process exited without finishing it",
                )
        blocked = _factory_blocked(root)
        for ref in refs:
            if ref.meta.get("state") != QUEUED or blocked:
                continue
            if ref.meta.get("cancel"):
                if not dry_run:
                    update_meta(ref.dir_path, state=CANCELLED, ended_at=_now())
                continue
            if live >= max_workers():
                break
            started.append(ref.job_id)
            live += 1
            if dry_run:
                continue
            update_meta(ref.dir_path, state=STARTING, worker_pid=None)
            try:
                pid = spawn_worker(root, ref)
            except Exception as exc:  # noqa: BLE001
                update_meta(
                    ref.dir_path,
                    state=FAILED,
                    ended_at=_now(),
                    why=f"could not start the worker: {exc}"[:300],
                )
                continue
            update_meta(ref.dir_path, worker_pid=pid)
    return {"started": started, "reaped": reaped, "blocked": blocked}


#: A job claimed (``starting``) but with no worker pid this long after its last
#: update was orphaned by a dispatcher that died mid-claim.
STARTING_STALE_S = 300


def _stale(meta: dict[str, Any], seconds: float) -> bool:
    try:
        last = datetime.fromisoformat(str(meta.get("updated_at")))
    except (TypeError, ValueError):
        return True
    return (datetime.now(UTC) - last).total_seconds() > seconds


def _factory_blocked(root: Path) -> str | None:
    try:
        from factory.manager.halt import is_halted

        if is_halted(root=root):
            return "factory is halted"
    except Exception:  # noqa: BLE001
        pass
    db = state_dir(root) / "factory.db"
    if db.exists():
        import sqlite3

        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
            try:
                row = con.execute("SELECT mode FROM factory_state WHERE id = 1").fetchone()
            finally:
                con.close()
            if row and str(row[0]) == "paused":
                return "factory mode is 'paused'"
        except sqlite3.Error:
            pass
    return None


# --------------------------------------------------------------------------- #
# Status / report / cancel
# --------------------------------------------------------------------------- #


def report_info(ref: TaskRef) -> dict[str, Any] | None:
    path = ref.dir_path / "report.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not text.strip():
        return None
    title = str(ref.meta.get("title") or "")
    for line in text.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            break
    return {
        "title": title,
        "path": str(path),
        "excerpt": text[:600],
        "words": len(text.split()),
    }


_STATE_MAP = {
    QUEUED: "queued",
    STARTING: "in_progress",
    RUNNING: "in_progress",
    DONE: "done",
    FAILED: "failed",
    CANCELLED: "cancelled",
}


def task_job_state(ref: TaskRef, factory_block: str | None) -> tuple[str, str | None]:
    meta = ref.meta
    raw = str(meta.get("state") or QUEUED)
    why = meta.get("why")
    cancel = meta.get("cancel") if isinstance(meta.get("cancel"), dict) else None
    if raw == DONE:
        return "done", why
    if cancel and raw not in (DONE, FAILED):
        if raw == CANCELLED or not meta.get("worker_pid"):
            return "cancelled", f"cancelled at {cancel.get('at', '?')} by {cancel.get('by', '?')}"
        return "in_progress", "cancel requested; the run is being stopped"
    state = _STATE_MAP.get(raw, "in_progress")
    if state == "queued":
        if factory_block:
            return "blocked", factory_block
        return "queued", why or "waiting for the next factory tick (factory job dispatch)"
    if state == "in_progress" and not why:
        why = (
            f"{meta.get('kind')} agent running ({meta.get('runtime')})"
            if raw == RUNNING
            else "starting the agent"
        )
    return state, why


def cancel_task(root: Path, job_id: str, *, by: str = "factory job cancel") -> dict[str, Any]:
    ref = find_task(root, job_id)
    meta = ref.meta
    if meta.get("state") == DONE:
        return {
            "job_id": ref.job_id,
            "state": "done",
            "stories_parked": [],
            "stories_left": [],
            "why": "job already done — nothing to cancel",
        }
    if not meta.get("cancel"):
        meta = update_meta(ref.dir_path, cancel={"at": _now(), "by": by})
    raw = meta.get("state")
    if raw in (QUEUED, STARTING) and not meta.get("worker_pid"):
        update_meta(ref.dir_path, state=CANCELLED, ended_at=_now())
    elif raw in (STARTING, RUNNING):
        # The worker polls the marker and kills its own run (termhub session
        # included). Also stop a Claude run directly in case the worker is wedged.
        if meta.get("runtime") == RUNTIME_CLAUDE:
            _kill_claude_run(ref)
        else:
            # The OpenHands run does not poll the marker: stop the worker's
            # process group; the next dispatch records the job as cancelled.
            _kill_worker(meta.get("worker_pid"))
    return {"job_id": ref.job_id, "state": "cancelled", "stories_parked": [], "stories_left": []}


def _kill_worker(pid: Any) -> None:
    if not pid:
        return
    # The worker leads its own process group (POSIX) / tree (Windows). A
    # console tree ignores taskkill's polite close, so Windows forces it (the
    # same effect SIGTERM has on a worker without a handler).
    kill_tree(pid, force=IS_WINDOWS)


def _kill_claude_run(ref: TaskRef) -> None:
    run_dir = ref.dir_path / "run"
    session_file = run_dir / "session.json"
    try:
        info = json.loads(session_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        info = {}
    sid = info.get("termhub_session_id") if isinstance(info, dict) else None
    if sid:
        try:
            from factory.claude_session.termhub import TermhubClient

            TermhubClient.from_env().kill(str(sid))
        except Exception:  # noqa: BLE001 - best effort; the worker also polls
            pass


def report_markdown(root: Path, job_id: str) -> dict[str, Any]:
    ref = find_task(root, job_id)
    info = report_info(ref)
    if info is None:
        raise JobError("no_report", f"job {ref.job_id} has no report yet")
    return {
        "job_id": ref.job_id,
        "title": info["title"],
        "markdown": Path(info["path"]).read_text(encoding="utf-8"),
        "path": info["path"],
    }


__all__ = [
    "REPORT_NAME",
    "SCRATCH_APP",
    "TaskRef",
    "build_brief",
    "cancel_task",
    "create_task",
    "dispatch_tasks",
    "find_task",
    "is_task_job_id",
    "iter_tasks",
    "report_info",
    "report_markdown",
    "run_task",
    "task_job_state",
]
