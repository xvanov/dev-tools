"""The per-app gate model: what each command gate is, and whether an app is ready.

A gate (``gates.lint_command``, ``format_check_command``, ``type_check_command``,
``test_command``) is in exactly one of three states:

* **command** — a shell command, run verbatim in the story worktree.
* **none** — the literal ``none``: the operator said this repo has no such
  check (a docs-only repo has no tests). The gate is SKIPPED and reported as
  ``not configured: skipped`` — never as "passing".
* **unset** — empty or absent: registration is incomplete. For the test gate
  this is the one state that can make a code job dead on arrival (the
  ``python -m pytest`` fallback fails on a repo with no ``tests/``), so
  ``factory job submit`` refuses it with ``gates_not_configured`` and names the
  command that fixes it.

A gate may also declare ``gates.requires.<gate>: [binary, …]``: executables
that must be on PATH (``docker``, ``lychee``). They are checked up front — at
submit, and before a dev run — so a missing tool is reported as
``gate test needs lychee, not on PATH`` instead of a red gate mid-job.
"""

from __future__ import annotations

import re
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

#: (short name, config field), in the order gates are shown and run.
GATES: tuple[tuple[str, str], ...] = (
    ("lint", "lint_command"),
    ("format_check", "format_check_command"),
    ("type_check", "type_check_command"),
    ("test", "test_command"),
)
_BY_SHORT = dict(GATES)
_BY_FIELD = {f: s for s, f in GATES}

#: The explicit "this repo has no such check" value.
NONE = "none"

#: An executable name a gate may require (no paths, no shell).
TOOL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")

Which = Callable[[str], str | None]


def short_name(name: str) -> str:
    """``test`` / ``test_command`` -> ``test``; ValueError for anything else."""
    n = str(name or "").strip().lower().replace("-", "_")
    if n in _BY_SHORT:
        return n
    if n in _BY_FIELD:
        return _BY_FIELD[n]
    raise ValueError(f"unknown gate {name!r}; one of: {', '.join(_BY_SHORT)}")


def field_name(name: str) -> str:
    return _BY_SHORT[short_name(name)]


def is_none(cmd: object) -> bool:
    return isinstance(cmd, str) and cmd.strip().lower() == NONE


def state(cmd: object) -> str:
    """``command`` | ``none`` | ``unset``."""
    if is_none(cmd):
        return "none"
    return "command" if isinstance(cmd, str) and cmd.strip() else "unset"


def runnable(cmd: object) -> str | None:
    """The command to run, or None (unset or explicitly none)."""
    return cmd.strip() if isinstance(cmd, str) and state(cmd) == "command" else None


def skipped_reason(field: str) -> str:
    return f"not configured: skipped ({field}: none)"


def normalize_requires(value: Any) -> dict[str, list[str]]:
    """``{gate: [tool, …]}`` keyed by short gate name; ValueError on bad input.

    Accepts short or field names as keys and a list or a comma-separated
    string as values. An empty list drops the key.
    """
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("gates.requires must be a mapping {gate: [tool, ...]}")
    out: dict[str, list[str]] = {}
    for key, tools in value.items():
        gate = short_name(str(key))
        if tools is None:
            items: list[str] = []
        elif isinstance(tools, str):
            items = [t.strip() for t in tools.split(",") if t.strip()]
        elif isinstance(tools, (list, tuple)):
            items = [str(t).strip() for t in tools if str(t).strip()]
        else:
            raise ValueError(f"gates.requires.{gate} must be a list of executable names")
        for t in items:
            if not TOOL_RE.match(t):
                raise ValueError(f"gates.requires.{gate}: {t!r} is not an executable name")
        if items:
            out[gate] = list(dict.fromkeys(items))
    return out


def _gates(cfg: Any) -> Any:
    return getattr(cfg, "gates", cfg)


def requires_of(cfg: Any, gate: str) -> list[str]:
    req = getattr(_gates(cfg), "requires", None)
    if not isinstance(req, dict):
        return []
    tools = req.get(short_name(gate))
    return [str(t) for t in tools] if isinstance(tools, (list, tuple)) else []


def missing_tools(cfg: Any, which: Which | None = None) -> dict[str, list[str]]:
    """Per gate that will RUN (state ``command``), the required tools not on PATH."""
    g = _gates(cfg)
    find = which or shutil.which  # looked up per call (patchable)
    out: dict[str, list[str]] = {}
    for short, fld in GATES:
        if state(getattr(g, fld, None)) != "command":
            continue
        miss = [t for t in requires_of(g, short) if not find(t)]
        if miss:
            out[short] = miss
    return out


def tools_message(missing: dict[str, list[str]]) -> str:
    return "; ".join(
        f"gate {gate} needs {', '.join(tools)}, not on PATH" for gate, tools in missing.items()
    )


def default_pytest_available(repo: Path | None) -> bool | None:
    """Whether ``runner._run_pytest``'s no-command fallback can run at all.

    None when the checkout is not there to look at.
    """
    if repo is None or not Path(repo).is_dir():
        return None
    repo = Path(repo)
    return (repo / "tests").exists() or any(repo.glob("test_*.py"))


def readiness(cfg: Any, repo: Path | None, which: Which | None = None) -> dict[str, Any]:
    """The app's gate readiness — what the dashboard shows and submit enforces.

    ``status``: ``missing_tool`` (a gate that runs needs a binary not on PATH),
    else ``not_configured`` (any gate unset), else ``configured``.
    ``blocking`` is the reason a code job would be refused, or None.
    """
    g = _gates(cfg)
    app = str(getattr(cfg, "name", "") or "<app>")
    gates: dict[str, dict[str, Any]] = {}
    for short, fld in GATES:
        cmd = getattr(g, fld, None)
        gates[short] = {
            "field": fld,
            "state": state(cmd),
            "command": runnable(cmd),
            "requires": requires_of(g, short),
        }
    missing = missing_tools(g, which)
    for short, tools in missing.items():
        gates[short]["missing"] = tools
    unset = [s for s, info in gates.items() if info["state"] == "unset"]
    warnings: list[str] = []
    blocking: str | None = None
    if gates["test"]["state"] == "unset":
        fallback = default_pytest_available(repo)
        fix = (
            f'set it: `factory app set {app} --gate test="<command>"`, or '
            f"`factory app set {app} --gate test=none` if the repo has no tests"
        )
        if fallback is False:
            blocking = (
                f"app {app}: the test gate is not configured (gates.test_command is "
                f"empty) and the repo has no tests/ for the default pytest, so no code "
                f"job could ever pass it — {fix}"
            )
        elif fallback is True:
            warnings.append(
                f"gates: test gate not configured; the default `python -m pytest -q` "
                f"runs instead — {fix}"
            )
        else:
            warnings.append(f"gates: test gate not configured — {fix}")
    if missing:
        msg = (
            f"app {app}: {tools_message(missing)} (gates.requires) — install it or change the gate"
        )
        blocking = f"{blocking}; {msg}" if blocking else msg
    status = "missing_tool" if missing else ("not_configured" if unset else "configured")
    return {
        "status": status,
        "gates": gates,
        "unset": unset,
        "missing_tools": missing,
        "blocking": blocking,
        "warnings": warnings,
    }


def submit_check(
    cfg: Any, repo: Path | None, which: Which | None = None
) -> tuple[tuple[str, str] | None, list[str]]:
    """(error code + message, or None; warnings) for a code job on this app."""
    r = readiness(cfg, repo, which)
    if r["missing_tools"]:
        return ("gate_requirements_missing", str(r["blocking"])), r["warnings"]
    if r["blocking"]:
        return ("gates_not_configured", str(r["blocking"])), r["warnings"]
    return None, r["warnings"]
