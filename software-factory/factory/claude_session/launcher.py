"""Start, observe and kill one Claude Code run's rounds.

A run is one or more ROUNDS (``claude -p`` invocations; round 2+ ``--resume``
the same Claude session with gate feedback). Each round is a generated bash
script (:func:`build_round_script`) that:

* ``cd``s to the run's working directory and UNSETS the API-key variables
  (:data:`factory.claude_session.cli.BILLING_ENV_VARS`) so the run bills the
  operator's subscription, never a key;
* runs ``claude -p --output-format stream-json --verbose`` with the round's
  prompt on stdin, ``tee``-ing the stream to ``stream-<n>.jsonl`` and piping it
  through :mod:`factory.claude_session.pretty` for the human watching;
* writes the exit code to ``exit-<n>`` (atomically) when it ends.

The factory never reads the terminal: it waits for ``exit-<n>`` and parses
``stream-<n>.jsonl``. The terminal is for humans.

On Windows the round is not a bash script: ``round-<n>.json`` is a spec that
``python -I -m factory.claude_session.round`` executes with the same steps and
the same files (:mod:`factory.claude_session.round` says why a shell pipeline
cannot do it there). The termhub command is then a PowerShell call line
(:func:`round_command`).

Launchers (the seam tests fake):

* :class:`TermhubLauncher` — round 1 creates a termhub session whose command is
  ``bash <round-1.sh>``; later rounds are typed into the same session, so a
  human sees the whole run in one terminal. Kill = ``DELETE`` the session (its
  PTY and process group go with it) plus a SIGTERM to the recorded pids.
* :class:`LocalLauncher` — fallback when termhub cannot be reached: a detached
  ``bash`` subprocess per round, output in ``terminal-<n>.log``. The run row
  then has no ``session``.
"""

from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from factory.claude_session.cli import BILLING_ENV_VARS
from factory.oscompat import IS_WINDOWS, detached_popen_kwargs, kill_tree


@dataclass
class RoundPlan:
    round_no: int
    prompt_path: Path
    script_path: Path
    stream_path: Path
    exit_path: Path
    stderr_path: Path
    pid_path: Path


def round_plan(run_dir: Path, round_no: int, *, windows: bool | None = None) -> RoundPlan:
    """Paths of one round. ``script_path`` is the bash script (POSIX) or the
    JSON spec for ``python -m factory.claude_session.round`` (Windows)."""
    d = Path(run_dir)
    win = IS_WINDOWS if windows is None else windows
    return RoundPlan(
        round_no=round_no,
        prompt_path=d / f"prompt-{round_no}.md",
        script_path=d / (f"round-{round_no}.json" if win else f"round-{round_no}.sh"),
        stream_path=d / f"stream-{round_no}.jsonl",
        exit_path=d / f"exit-{round_no}",
        stderr_path=d / f"stderr-{round_no}.log",
        pid_path=d / f"pid-{round_no}",
    )


def build_claude_argv(
    claude_bin: str,
    *,
    model: str | None,
    session_uuid: str | None,
    resume: str | None,
    add_dirs: list[str] | None = None,
) -> list[str]:
    """The ``claude`` argv for one round. Pure."""
    argv = [
        claude_bin,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        # Unattended: there is no human at a permission prompt. The run is
        # confined by its working directory (a worktree / scratch dir) and by
        # the factory's own gates, exactly like the OpenHands sandbox dev.
        "--dangerously-skip-permissions",
    ]
    if model:
        argv += ["--model", model]
    if resume:
        argv += ["--resume", resume]
    elif session_uuid:
        argv += ["--session-id", session_uuid]
    for d in add_dirs or []:
        argv += ["--add-dir", d]
    return argv


def build_round_script(
    plan: RoundPlan,
    *,
    cwd: Path,
    claude_argv: list[str],
    title: str,
    python_exe: str | None = None,
    factory_root: Path | None = None,
    windows: bool | None = None,
) -> str:
    """The round's script text. Pure.

    POSIX: a bash script. Windows: the JSON spec that
    ``python -m factory.claude_session.round`` executes (no shell pipeline; see
    that module for why).
    """
    if IS_WINDOWS if windows is None else windows:
        return json.dumps(
            {
                "round_no": plan.round_no,
                "title": title,
                "cwd": str(cwd),
                "argv": list(claude_argv),
                "prompt_path": str(plan.prompt_path),
                "stream_path": str(plan.stream_path),
                "stderr_path": str(plan.stderr_path),
                "exit_path": str(plan.exit_path),
                "pid_path": str(plan.pid_path),
            },
            indent=2,
        )
    q = shlex.quote
    py = python_exe or sys.executable
    root = factory_root or Path(__file__).resolve().parents[2]
    claude = " ".join(q(a) for a in claude_argv)
    pretty = f"PYTHONPATH={q(str(root))} {q(py)} -m factory.claude_session.pretty"
    tmp = f"{plan.exit_path}.tmp"
    return "\n".join(
        [
            "#!/usr/bin/env bash",
            f"# factory claude_session run — round {plan.round_no}",
            f"cd {q(str(cwd))} || {{ echo 97 > {q(tmp)}; mv {q(tmp)} {q(str(plan.exit_path))}; exit 97; }}",
            "unset " + " ".join(BILLING_ENV_VARS),
            f"echo $$ > {q(str(plan.pid_path))}",
            f"printf '%s\\n' {q(f'── factory: {title} — round {plan.round_no}')}",
            f"{claude} < {q(str(plan.prompt_path))} 2> {q(str(plan.stderr_path))} "
            f"| tee {q(str(plan.stream_path))} | {pretty}",
            "rc=${PIPESTATUS[0]}",
            f'echo "$rc" > {q(tmp)} && mv {q(tmp)} {q(str(plan.exit_path))}',
            f'printf "── factory: round {plan.round_no} finished (exit %s)\\n" "$rc"',
            "",
        ]
    )


@dataclass
class SessionInfo:
    machine: str
    termhub_session_id: str | None = None
    url: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    #: What the session belongs to (job, step, story, external id), as sent to
    #: termhub (``run.session_links``). Stored with the run's session so
    #: ``job status`` returns it.
    links: dict[str, str] | None = None

    def as_json(self) -> dict[str, Any] | None:
        if not self.termhub_session_id:
            return None
        out: dict[str, Any] = {
            "machine": self.machine,
            "termhub_session_id": self.termhub_session_id,
            "url": self.url,
        }
        if self.links:
            out["links"] = dict(self.links)
        return out


class Launcher(Protocol):
    def start(self, plan: RoundPlan, *, cwd: Path, title: str) -> SessionInfo: ...

    def next_round(self, session: SessionInfo, plan: RoundPlan, *, cwd: Path) -> None: ...

    def alive(self, session: SessionInfo) -> bool | None: ...

    def kill(self, session: SessionInfo, plans: list[RoundPlan]) -> None: ...


def round_argv(plan: RoundPlan, *, python_exe: str | None = None) -> list[str]:
    """Windows: the argv that runs one round (``-I``: never import a ``factory``
    package from the run's working directory instead of the installed one)."""
    return [python_exe or sys.executable, "-I", "-m", "factory.claude_session.round", str(plan.script_path)]


def _ps_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def round_command(
    plan: RoundPlan, *, windows: bool | None = None, shell: str | None = None,
    python_exe: str | None = None,
) -> str:
    """The line typed into a termhub session's shell to run one round.

    POSIX: ``bash <round-n.sh>``. Windows: termhub's shell is PowerShell
    (pwsh or Windows PowerShell; ``FACTORY_TERMHUB_SHELL=cmd`` when termhub runs
    cmd), so the line is ``& '<python>' -I -m factory.claude_session.round '<spec>'``.
    """
    if not (IS_WINDOWS if windows is None else windows):
        return f"bash {shlex.quote(str(plan.script_path))}"
    argv = round_argv(plan, python_exe=python_exe)
    kind = (shell or os.environ.get("FACTORY_TERMHUB_SHELL") or "powershell").strip().lower()
    if kind == "cmd":
        return subprocess.list2cmdline(argv)
    return "& " + " ".join(_ps_quote(a) if (" " in a or "'" in a or "\\" in a) else a for a in argv)


def _kill_pids(plans: list[RoundPlan]) -> None:
    for plan in plans:
        try:
            pid = int(plan.pid_path.read_text().strip())
        except (OSError, ValueError):
            continue
        if IS_WINDOWS:  # pragma: no cover - Windows only
            # The round runner's tree (it and claude). No signals on Windows.
            kill_tree(pid, force=True)
            continue
        try:
            os.killpg(pid, signal.SIGTERM)  # type: ignore[attr-defined]
            continue
        except (OSError, AttributeError):
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


class TermhubLauncher:
    def __init__(self, client: Any, machine: str) -> None:
        self.client = client
        self.machine = machine
        #: Set by ``run.run_claude`` before ``start``: the session's links
        #: (termhub ``POST /api/sessions {links}``; an older termhub ignores them).
        self.links: dict[str, str] | None = None

    def start(self, plan: RoundPlan, *, cwd: Path, title: str) -> SessionInfo:
        extra: dict[str, Any] = {"links": self.links} if self.links else {}
        sid = self.client.create_session(
            cwd=str(cwd), command=round_command(plan), title=title, **extra
        )
        url = None
        try:
            url = self.client.session_url(sid)
        except Exception:  # noqa: BLE001 - a link is nice-to-have
            url = None
        return SessionInfo(
            machine=self.machine, termhub_session_id=sid, url=url, links=self.links or None
        )

    def next_round(self, session: SessionInfo, plan: RoundPlan, *, cwd: Path) -> None:
        assert session.termhub_session_id
        self.client.type_line(session.termhub_session_id, round_command(plan))

    def alive(self, session: SessionInfo) -> bool | None:
        if not session.termhub_session_id:
            return None
        answer = self.client.alive(session.termhub_session_id)
        return None if answer is None else bool(answer)

    def kill(self, session: SessionInfo, plans: list[RoundPlan]) -> None:
        _kill_pids(plans)
        if session.termhub_session_id:
            self.client.kill(session.termhub_session_id)


class LocalLauncher:
    """No termhub: run each round as a detached local process."""

    def __init__(self, machine: str) -> None:
        self.machine = machine
        self._procs: list[subprocess.Popen[bytes]] = []

    def _spawn(self, plan: RoundPlan, cwd: Path) -> None:
        log = plan.script_path.with_name(f"terminal-{plan.round_no}.log")
        argv = round_argv(plan) if IS_WINDOWS else ["bash", str(plan.script_path)]
        with log.open("ab") as out:
            self._procs.append(
                subprocess.Popen(  # noqa: S603
                    argv,
                    cwd=str(cwd),
                    stdout=out,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    **detached_popen_kwargs(),
                )
            )

    def start(self, plan: RoundPlan, *, cwd: Path, title: str) -> SessionInfo:
        self._spawn(plan, cwd)
        return SessionInfo(machine=self.machine, extra={"launcher": "local"})

    def next_round(self, session: SessionInfo, plan: RoundPlan, *, cwd: Path) -> None:
        self._spawn(plan, cwd)

    def alive(self, session: SessionInfo) -> bool | None:
        if not self._procs:
            return None
        return self._procs[-1].poll() is None

    def kill(self, session: SessionInfo, plans: list[RoundPlan]) -> None:
        _kill_pids(plans)
        for proc in self._procs:
            if proc.poll() is None:
                try:
                    proc.terminate()
                except OSError:
                    pass


def select_launcher() -> tuple[Launcher, str | None]:
    """termhub when reachable (or forced), else local. Returns ``(launcher, warning)``.

    ``FACTORY_CLAUDE_LAUNCHER=local`` forces the local launcher;
    ``=termhub`` forces termhub (a run then fails if termhub is down).
    """
    from factory.claude_session.termhub import TermhubClient, machine_name

    mode = (os.environ.get("FACTORY_CLAUDE_LAUNCHER") or "auto").strip().lower()
    machine = machine_name()
    if mode == "local":
        return LocalLauncher(machine), None
    client = TermhubClient.from_env()
    if mode == "termhub" or client.reachable():
        return TermhubLauncher(client, machine), None
    return LocalLauncher(machine), (
        f"termhub not reachable at {client.base}; the run is not watchable live "
        "(started as a local process, output in the run dir)"
    )


__all__ = [
    "Launcher",
    "LocalLauncher",
    "RoundPlan",
    "SessionInfo",
    "TermhubLauncher",
    "build_claude_argv",
    "build_round_script",
    "round_argv",
    "round_command",
    "round_plan",
    "select_launcher",
]
