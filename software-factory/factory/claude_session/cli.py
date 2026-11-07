"""Find the ``claude`` CLI and check it is logged in (on a subscription).

``check_available`` is the submit-time gate for ``--runtime claude_session``
(``runtime_unavailable``). It runs ``claude auth status`` with the API-key
variables REMOVED from the environment, the same way every run is launched
(:func:`clean_env`): with ``ANTHROPIC_API_KEY`` set, Claude Code bills that key
instead of the operator's subscription, which is exactly what this runtime is
meant to avoid.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

#: Variables that would switch Claude Code off the logged-in subscription
#: (API key / gateway / cloud-provider billing). Unset for every run.
BILLING_ENV_VARS: tuple[str, ...] = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
)


def clean_env(base: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    for name in BILLING_ENV_VARS:
        env.pop(name, None)
    return env


def claude_binary(env: Mapping[str, str] | None = None) -> str | None:
    """``$FACTORY_CLAUDE_BIN``, else ``claude`` on PATH, else the installer's
    usual locations (a systemd unit's PATH often lacks ``~/.local/bin``)."""
    env = os.environ if env is None else env
    explicit = (env.get("FACTORY_CLAUDE_BIN") or "").strip()
    if explicit:
        return explicit if Path(explicit).exists() else None
    found = shutil.which("claude")
    if found:
        return found
    home = Path(env.get("HOME") or Path.home())
    for candidate in (home / ".local" / "bin" / "claude", home / ".claude" / "local" / "claude"):
        if candidate.exists():
            return str(candidate)
    return None


def _default_probe(argv: list[str], env: dict[str, str]) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=30, env=env, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return -1, f"{type(exc).__name__}: {exc}"
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


#: Seam: tests replace this to fake ``claude auth status``.
probe: Callable[[list[str], dict[str, str]], tuple[int, str]] = _default_probe


def check_available() -> tuple[bool, str]:
    """``(True, "<detail>")`` when a run can start; ``(False, "<why not>")`` otherwise.

    Fail safe: output that cannot be read as "logged in" is "not available".
    """
    binary = claude_binary()
    if binary is None:
        return False, "the `claude` CLI is not on PATH here (set FACTORY_CLAUDE_BIN)"
    code, out = probe([binary, "auth", "status"], clean_env())
    data: Any = None
    start = out.find("{")
    if start >= 0:
        try:
            data = json.loads(out[start : out.rfind("}") + 1])
        except ValueError:
            data = None
    if isinstance(data, dict):
        if not data.get("loggedIn"):
            return False, "`claude auth status` says not logged in (run `claude` and /login)"
        method = str(data.get("authMethod") or "")
        if method and method != "claude.ai":
            return False, (
                f"`claude` is logged in via {method!r}, not a claude.ai subscription; "
                "this runtime must not bill an API key"
            )
        return True, f"{binary} logged in ({data.get('subscriptionType') or method or 'claude.ai'})"
    return False, f"`claude auth status` exited {code} without a readable status: {out[:200]!r}"


__all__ = ["BILLING_ENV_VARS", "check_available", "claude_binary", "clean_env", "probe"]
