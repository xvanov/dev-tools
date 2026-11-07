"""Every shipped systemd unit that reaches `uv` must pin PATH.

A systemd USER unit does not inherit a login shell's PATH. It gets the user
manager's environment, which on this host contains `/home/k/.local/bin` only
because a graphical login imported it via `dbus-update-activation-environment`.
Headless, or with different unit ordering, it is absent — and then every `uv`
invocation inside the unit fails.

This class has bitten twice:

* 2026-07-18 — the tick units had no PATH, `uv` was unresolvable, and the runtime
  smoke gate therefore failed on EVERY story (memory:
  `convergence_blockers_2026_07_18`). Fixed with a drop-in on
  `factory-tick@.service`.
* 2026-08-11 — `factory-self-deploy.service`, the one unit that never got the
  drop-in, was found still carrying `Environment=` (empty). Its failure mode is
  worse than the first: the script's import gate runs bare `uv`, and on failure
  `_revert_one` rolls back every applied file and the unit exits 1. It reverts
  every self-deploy forever while emitting only a syslog line — fail-safe, but
  silent.

So the rule is asserted over the shipped units rather than left to whoever next
writes one.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_UNITS_DIR = Path(__file__).resolve().parents[1] / "scripts" / "systemd"

# A unit reaches `uv` either directly in ExecStart or through a script it runs.
# Resolved by reading the script, not by guessing from the name.
_ROOT = Path(__file__).resolve().parents[1]


def _service_files() -> list[Path]:
    return sorted(_UNITS_DIR.glob("*.service"))


def test_there_is_at_least_one_shipped_service_to_check() -> None:
    """A vacuous pass here would hide the whole class."""
    assert _service_files(), f"no *.service files under {_UNITS_DIR}"


@pytest.mark.parametrize("unit", _service_files(), ids=lambda p: p.name)
def test_a_unit_that_reaches_uv_pins_path(unit: Path) -> None:
    text = unit.read_text(encoding="utf-8")
    exec_lines = [ln for ln in text.splitlines() if ln.startswith("ExecStart=")]
    assert exec_lines, f"{unit.name} has no ExecStart"

    reaches_uv = any("uv " in ln or ln.endswith("uv") for ln in exec_lines)
    if not reaches_uv:
        # Follow the script it runs: the failure is inside the script, not the unit.
        for ln in exec_lines:
            target = ln.split("=", 1)[1].split()[0]
            # Resolve by BASENAME inside this repo's scripts/, not by the unit's
            # absolute path. The units hardcode /home/k/software-factory, so an
            # absolute-path match SKIPS in every git worktree — which is how the
            # first cut of this test silently skipped the one unit it exists to
            # check. A guard that can skip itself is not a guard.
            name = Path(target).name
            matches = [p for p in (_ROOT / "scripts").rglob(name) if p.is_file()]
            for script in matches:
                body = script.read_text(encoding="utf-8", errors="replace")
                if re.search(r"(?<![\w./-])uv\s+run\b", body):
                    reaches_uv = True
                    break
            if reaches_uv:
                break

    assert reaches_uv, (
        f"{unit.name}: could not determine whether it reaches `uv`. Resolve its "
        "ExecStart script and extend this test rather than letting it pass "
        "unchecked — an unresolved unit must not read as a clean one."
    )

    path_lines = [
        ln for ln in text.splitlines() if ln.startswith("Environment=PATH=")
    ]
    assert path_lines, (
        f"{unit.name} invokes `uv` but pins no PATH. A systemd user unit does not "
        "inherit a login shell's PATH; without this the unit works only while the "
        "user manager happens to carry /home/k/.local/bin from a graphical login. "
        "Add: Environment=PATH=/home/k/.local/bin:..."
    )
    assert "/home/k/.local/bin" in path_lines[0], (
        f"{unit.name} pins a PATH that does not contain the directory `uv` lives "
        f"in: {path_lines[0]}"
    )


def test_the_self_deploy_unit_specifically_carries_it() -> None:
    """Named because it is the one that was missing, so a revert is loud."""
    unit = _UNITS_DIR / "factory-self-deploy.service"
    assert unit.is_file()
    text = unit.read_text(encoding="utf-8")
    assert "Environment=PATH=/home/k/.local/bin:" in text
    # And the reason, so the next reader does not delete it as noise.
    assert "import gate" in text and "silent" in text.lower()
