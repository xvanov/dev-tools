"""Flaky-test detection + quarantine (WS4.4).

The factory's CI-fix loop and the D004 main-CI monitor churn when a test is
*flaky* — it fails on one run and passes on the next without any code change.
A flaky red is a false-red: re-dispatching the story to dev burns cycles on a
"bug" that isn't there, and the D004 monitor can file a direction for a failure
that self-heals on the next tick.

The naive fix — "re-run until it goes green" — is worse: it manufactures
FALSE-GREENS (a genuinely broken test passes once in ten and ships). This module
does the opposite. It NEVER upgrades a red to a clean pass. A failing test is
re-run in isolation; the ONLY thing a rerun can do is DOWNGRADE a red to
``quarantined`` — non-blocking, but recorded as tech debt and surfaced for a
fix. A test that fails on EVERY rerun is a real regression and still blocks.

Classification (the one distinction that matters):

* fails first, then PASSES on any isolated rerun  -> **flaky** -> quarantine
  (does not block the merge, but is recorded + surfaced so it gets fixed).
* fails first, and fails on EVERY isolated rerun   -> **real failure** -> blocks.

Only a test that DEMONSTRABLY flaps in the SAME run-set is ever quarantined; a
consistently-failing test is never hidden (that would be the exact false-green
this tier fights).

The suite runner is injected (``TestRunner``) so tests drive the logic with a
fake and never nest a real pytest. ``make_subprocess_runner`` builds the
production runner around a shell ``test_command``.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# A runner is called with an optional list of test node-ids to scope the run to
# (``None`` = the whole suite) and returns a TestRunResult.
TestRunner = Callable[[list[str] | None], "TestRunResult"]

# Default number of isolated reruns before a failing test is declared a real
# (consistent) failure. Kept small — a flake almost always reveals itself within
# a couple of reruns, and each rerun costs a full test invocation.
DEFAULT_RERUN_COUNT = 3

_QUARANTINE_REGISTRY_REL = Path("state") / "flake_quarantine.json"

# Matches pytest's short-summary "FAILED <nodeid>[ - <msg>]" / "ERROR <nodeid>"
# lines (emitted with -q too). The node-id is everything up to the first " - "
# or end-of-line.
_PYTEST_FAILED_RE = re.compile(r"^(?:FAILED|ERROR)\s+(\S+?)(?:\s+-\s|\s*$)", re.MULTILINE)


@dataclass
class TestRunResult:
    """Outcome of one invocation of the suite (or a scoped subset)."""

    __test__ = False  # not a pytest test class despite the ``Test`` prefix

    exit_code: int
    # Node-ids that failed/errored in THIS run. Empty on a green run; may be
    # empty on a red run whose output we could not parse (handled conservatively
    # by the caller — an un-isolatable red blocks).
    failed_tests: list[str] = field(default_factory=list)
    output: str = ""

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


@dataclass
class FlakeResult:
    """Verdict for a whole suite run after flake analysis."""

    # True when the merge/gate MUST block (a real, consistent failure exists, or
    # a red we could not isolate into individual tests).
    blocking: bool
    # True when the suite may proceed: either green outright, or
    # green-with-quarantine (every failure flapped).
    passed: bool
    quarantined: list[str] = field(default_factory=list)
    real_failures: list[str] = field(default_factory=list)
    reason: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "blocking": self.blocking,
            "passed": self.passed,
            "quarantined": list(self.quarantined),
            "real_failures": list(self.real_failures),
            "reason": self.reason,
        }


def parse_failed_tests(output: str) -> list[str]:
    """Extract failing pytest node-ids from suite output (dedup, order-stable)."""
    seen: dict[str, None] = {}
    for m in _PYTEST_FAILED_RE.finditer(output or ""):
        seen.setdefault(m.group(1), None)
    return list(seen.keys())


def make_subprocess_runner(
    test_command: str,
    *,
    cwd: Path | None = None,
    timeout: int = 600,
) -> TestRunner:
    """Build a production runner that shells out to ``test_command``.

    A scoped run appends the node-ids to the command (pytest-style), so the
    reruns target only the tests that failed. Failures are parsed from the
    captured output via :func:`parse_failed_tests`.
    """

    def _run(node_ids: list[str] | None) -> TestRunResult:
        cmd = test_command
        if node_ids:
            cmd = f"{test_command} " + " ".join(node_ids)
        try:
            proc = subprocess.run(
                cmd,
                shell=True,  # noqa: S602 — test_command comes from trusted app config
                cwd=str(cwd) if cwd is not None else None,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            def _to_text(v: object) -> str:
                if isinstance(v, bytes):  # pragma: no cover - defensive
                    return v.decode(errors="replace")
                return v if isinstance(v, str) else ""

            out = _to_text(e.stdout) + _to_text(e.stderr)
            return TestRunResult(exit_code=124, failed_tests=[], output=out[-8000:])
        output = (proc.stdout + proc.stderr)[-8000:]
        return TestRunResult(
            exit_code=proc.returncode,
            failed_tests=parse_failed_tests(proc.stdout + proc.stderr),
            output=output,
        )

    return _run


def detect_flakes(
    runner: TestRunner,
    *,
    rerun_count: int = DEFAULT_RERUN_COUNT,
) -> FlakeResult:
    """Run the suite; classify any failures as flaky (quarantine) or real (block).

    Pure decision logic — no I/O beyond the injected ``runner``. Registry writes
    and event/direction surfacing are the caller's job
    (:func:`run_with_quarantine`).
    """
    first = runner(None)
    if first.passed:
        return FlakeResult(
            blocking=False,
            passed=True,
            reason="suite passed on first run",
        )

    failed = list(first.failed_tests)
    if not failed:
        # Red, but we couldn't isolate individual tests to re-run — never
        # quarantine a red we can't reason about. Block conservatively.
        return FlakeResult(
            blocking=True,
            passed=False,
            reason=(
                f"suite failed (exit={first.exit_code}) with no parseable failing "
                "tests — cannot isolate for flake analysis; treating as real failure"
            ),
        )

    quarantined: list[str] = []
    real_failures: list[str] = []
    for node_id in failed:
        flapped = False
        for _ in range(max(1, rerun_count)):
            rerun = runner([node_id])
            # The test PASSED on a rerun (and wasn't reported failing) — it
            # flapped: fail-then-pass in the same run-set. Quarantine it.
            if rerun.passed and node_id not in rerun.failed_tests:
                flapped = True
                break
        if flapped:
            quarantined.append(node_id)
        else:
            real_failures.append(node_id)

    blocking = bool(real_failures)
    if blocking:
        reason = (
            f"{len(real_failures)} consistently-failing test(s) block "
            f"({len(quarantined)} flaky quarantined)"
        )
    else:
        reason = (
            f"all {len(quarantined)} failing test(s) flapped on rerun — "
            "quarantined; suite green-with-quarantine"
        )
    return FlakeResult(
        blocking=blocking,
        passed=not blocking,
        quarantined=quarantined,
        real_failures=real_failures,
        reason=reason,
    )


# --------------------------------------------------------------------------- #
# Quarantine registry
# --------------------------------------------------------------------------- #


def _registry_path(software_factory_root: Path) -> Path:
    return Path(software_factory_root) / _QUARANTINE_REGISTRY_REL


def load_quarantine_registry(software_factory_root: Path) -> dict[str, object]:
    """Load the quarantine registry, or an empty shape if none exists."""
    path = _registry_path(software_factory_root)
    if not path.is_file():
        return {"quarantined": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {"quarantined": {}}
    if not isinstance(data, dict) or not isinstance(data.get("quarantined"), dict):
        return {"quarantined": {}}
    return data


def record_quarantine(
    app: str,
    node_ids: list[str],
    *,
    software_factory_root: Path,
) -> list[str]:
    """Merge ``node_ids`` into the registry for ``app``.

    Returns the subset that is NEWLY quarantined (not previously recorded) so the
    caller only surfaces/files each flake once. Idempotent; never raises.
    """
    if not node_ids:
        return []
    path = _registry_path(software_factory_root)
    registry = load_quarantine_registry(software_factory_root)
    per_app = registry.setdefault("quarantined", {})
    assert isinstance(per_app, dict)
    app_map = per_app.setdefault(app, {})
    if not isinstance(app_map, dict):  # pragma: no cover - defensive
        app_map = {}
        per_app[app] = app_map
    now = datetime.now(UTC).isoformat()
    newly: list[str] = []
    for node_id in node_ids:
        existing = app_map.get(node_id)
        if isinstance(existing, dict):
            existing["last_seen"] = now
            existing["occurrences"] = int(existing.get("occurrences", 1)) + 1
        else:
            app_map[node_id] = {
                "first_seen": now,
                "last_seen": now,
                "occurrences": 1,
                "status": "open",
            }
            newly.append(node_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")
    except OSError:
        return newly
    return newly


def run_with_quarantine(
    *,
    app: str,
    runner: TestRunner,
    software_factory_root: Path,
    rerun_count: int = DEFAULT_RERUN_COUNT,
    emit_event: bool = True,
    file_direction: bool = False,
) -> FlakeResult:
    """Detect flakes, persist newly-quarantined tests, and surface them.

    This is the high-level entry the gate/CI-fix loop calls. It:

    * runs :func:`detect_flakes`;
    * records any quarantined tests to ``state/flake_quarantine.json``;
    * emits a ``flake_quarantined`` event (never silently swallows — surfacing
      is what turns a quarantined flake into visible tech debt);
    * optionally files ONE low-priority direction per newly-quarantined flake
      so the chain actually fixes it (deduped via the registry — a test already
      recorded is never re-filed).

    Surfacing failures never change the merge verdict — the ``FlakeResult`` is
    returned regardless.
    """
    result = detect_flakes(runner, rerun_count=rerun_count)
    if not result.quarantined:
        return result

    newly = record_quarantine(
        app, result.quarantined, software_factory_root=software_factory_root
    )

    if emit_event:
        try:
            from factory.manager.signals import write_event

            write_event(
                "flakes",
                {
                    "event": "flake_quarantined",
                    "app": app,
                    "quarantined": result.quarantined,
                    "newly_quarantined": newly,
                    "real_failures": result.real_failures,
                    "blocking": result.blocking,
                },
                software_factory_root=software_factory_root,
            )
        except Exception:  # noqa: BLE001 — telemetry must never crash a gate
            pass

    if file_direction and newly:
        _file_flake_directions(
            app, newly, software_factory_root=software_factory_root
        )

    return result


def _file_flake_directions(
    app: str,
    node_ids: list[str],
    *,
    software_factory_root: Path,
) -> None:  # pragma: no cover - exercised via monkeypatched creator in tests
    """File one low-priority direction per newly-quarantined flake.

    Best-effort: a filing failure must never crash the caller. Dedup is already
    handled upstream (only NEWLY-quarantined ids reach here), and each direction
    carries a marker so a downstream dedup scan can find it.
    """
    try:
        from factory.directions.creator import create_direction
    except Exception:  # noqa: BLE001
        return
    for node_id in node_ids:
        try:
            create_direction(
                app,
                title=f"Fix flaky test: {node_id}",
                type_tag="bug",
                why=(
                    f"`{node_id}` flapped (failed then passed on isolated rerun) "
                    "and was auto-quarantined so it stops churning the CI-fix "
                    "loop. A quarantined flake is non-blocking but is tech debt: "
                    "make it deterministic (fix the ordering/timing/shared-state "
                    "dependency) or delete it if it tests nothing real.\n\n"
                    f"<!-- factory:flake-quarantine node_id={node_id} -->"
                ),
                has_ui=False,
                flow_steps=None,
                has_api=False,
                api_spec_lines=None,
                acceptance=[
                    f"`{node_id}` passes 20 consecutive runs (no flap).",
                    "The test is removed from state/flake_quarantine.json.",
                ],
                explore=False,
                attach_files=None,
                software_factory_root=software_factory_root,
                priority="p3",
                source="flake-quarantine",
            )
        except Exception:  # noqa: BLE001
            continue
