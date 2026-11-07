"""Subprocess utility for running configured deploy commands.

Every command is an opaque shell string from ``apps/<app>/config.yaml``.
The runner is intentionally minimal: it shells out, captures stdout +
stderr + exit_code, enforces a timeout, and reports duration. It does
NOT know anything about Docker / Compose / Fly / Vercel / Kubernetes.

Two surfaces:

  * ``run_command`` — a single shell string.
  * ``run_command_sequence`` — a list of shell strings; stops on the
    first non-zero exit.

stdout / stderr are truncated to ``EXCERPT_LIMIT`` chars when stored on
``CommandResult`` so a chatty `npm install` log doesn't blow up the
SQLite row.
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

EXCERPT_LIMIT = 4000

# Hard refusal patterns. Same set the Release-Manager persona refuses on.
# We keep one canonical list here so the runner short-circuits at the
# subprocess boundary even if the persona check is bypassed.
_DESTRUCTIVE_PATTERNS = (
    "rm -rf /",
    "rm -rf /*",
    "rm -rf /home",
    "rm -rf ~",
    "mkfs",
    "dd if=/dev/zero of=/dev",
    "> /dev/sda",
    ":(){ :|:& };:",
)


def is_destructive(command: str) -> bool:
    """True iff ``command`` matches a known destructive pattern."""
    return any(pattern in command for pattern in _DESTRUCTIVE_PATTERNS)


@dataclass
class CommandResult:
    """Outcome of a single shell invocation."""

    command: str
    exit_code: int
    stdout: str
    stderr: str
    duration_seconds: float
    timed_out: bool = False
    refused: bool = False
    refused_reason: str | None = None
    # Optional phase label so callers can group multi-phase runs.
    phase: str | None = None

    @property
    def passed(self) -> bool:
        return not self.refused and not self.timed_out and self.exit_code == 0

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        # Truncate large fields for persistence.
        d["stdout_excerpt"] = d.pop("stdout")[-EXCERPT_LIMIT:]
        d["stderr_excerpt"] = d.pop("stderr")[-EXCERPT_LIMIT:]
        return d


def _build_env(env_var_passthrough: list[str] | None) -> dict[str, str]:
    """Build the child process env, copying only whitelisted vars.

    PATH is always forwarded so the user's installed binaries (``docker``,
    ``npx``, ``curl``, etc.) resolve. Everything else is opt-in via
    ``env_var_passthrough``.
    """
    env: dict[str, str] = {}
    if "PATH" in os.environ:
        env["PATH"] = os.environ["PATH"]
    for key in env_var_passthrough or []:
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def run_command(
    command: str,
    *,
    cwd: Path,
    env_var_passthrough: list[str] | None = None,
    timeout: int = 600,
    phase: str | None = None,
) -> CommandResult:
    """Run ``command`` via the shell; return a ``CommandResult``.

    The shell is invoked because deploy commands typically include
    pipes, redirects, and `&&` chains the user authored as a single
    string. ``shlex`` quoting is the caller's responsibility (and the
    Release-Manager persona refuses dangerous strings before we get
    here).
    """
    if is_destructive(command):
        return CommandResult(
            command=command,
            exit_code=-1,
            stdout="",
            stderr="refused: matches destructive pattern",
            duration_seconds=0.0,
            refused=True,
            refused_reason="destructive_pattern",
            phase=phase,
        )
    env = _build_env(env_var_passthrough)
    start = time.monotonic()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return CommandResult(
            command=command,
            exit_code=int(proc.returncode),
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            duration_seconds=time.monotonic() - start,
            phase=phase,
        )
    except subprocess.TimeoutExpired as exc:
        return CommandResult(
            command=command,
            exit_code=-1,
            stdout=(exc.stdout.decode("utf-8", errors="replace") if exc.stdout else ""),
            stderr=(exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""),
            duration_seconds=time.monotonic() - start,
            timed_out=True,
            phase=phase,
        )


def run_command_sequence(
    commands: list[str],
    *,
    cwd: Path,
    env_var_passthrough: list[str] | None = None,
    timeout: int = 600,
    phase: str | None = None,
) -> list[CommandResult]:
    """Run ``commands`` in order; stop on the first non-zero exit.

    Returns the list of results collected so far. The caller decides
    whether to abort the larger deploy plan based on the last entry's
    ``passed``.
    """
    results: list[CommandResult] = []
    for cmd in commands:
        result = run_command(
            cmd,
            cwd=cwd,
            env_var_passthrough=env_var_passthrough,
            timeout=timeout,
            phase=phase,
        )
        results.append(result)
        if not result.passed:
            break
    return results
