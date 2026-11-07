"""The production ``solo`` pipeline: one agent, one continuous conversation.

Operator decision 2026-11-02, built on the B.1 design (``b1_solo_mode_design``).
A story stamped ``pipeline: solo`` at spawn (``factory/job_routing.py``) runs:

    SM → dev (ONE long conversation, in-conversation gate feedback)
       → TESTS_GREEN → tech_writer → docs_enforcer → PR / delivery level
       → the SAME merge gates (``gates/evaluator.required_gate_labels``) → deploy

What it removes, and nothing else: the reviewer round-trip
(``TESTS_GREEN → review``) and the N fresh dev conversations that each read a
summary of the last one. What it keeps: SM, the worktree, the commit, the
tech-writer, the delivery-level enforcement at the PR-open site
(``handlers.handle_docs_enforcer`` / ``chain/delivery_gate.py``), every merge
gate, CI, deploy, the per-story budget breaker and the dev-retry exhaustion
path.

Why: the 2026-08-11 matched replay put one OpenHands agent at 12/18 (67%,
$1.19/resolved) against the chain's 10/18 (56%, $8.10/resolved), and the
Phase-1a ablation found the reviewer was not expensive in tokens — it caused
REWORK (9 fewer dev calls without it). See ``machinery_fixes_bought_zero_net_rate``
and ``b1_phase1a_reviewer_ablation_result``.

The mode is read from the STORY ROW (``StoryRecord.pipeline``), never from live
config: a story spawned under one mode finishes under it.

**Independence.** With no reviewer, the checks the dev cannot influence are the
app's merge gates and CI. The acceptance oracle is used when the app enables it
(``gates.acceptance_oracle``) — it is then a REQUIRED merge gate, and its leak
check runs as a blocking precondition on every solo dev dispatch — but it is NOT
required for solo: it is vacuous on non-web repos
(``oracle_vacuity_is_webapp_shaped``) and solo must work on any repo. Which
checks gate a given story is logged on its event stream as ``solo_checks``.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from factory.runner import GateVerdict

_logger = logging.getLogger(__name__)

SOLO = "solo"

#: One conversation's wall clock (vs the chain's 1800 s per attempt). A TIMEOUT,
#: not a loop cap — it buys continuity, not iterations
#: (``chain_slices_the_dev_horizon``). Matches the single-agent bench arm.
SOLO_DEV_WALL_CLOCK_S = 5400

#: Gate checks inside one conversation (initial grade + up to 2 feedback
#: rounds). Bounded by the repo's "nothing loops more than 3" rule.
SOLO_MAX_GATE_ROUNDS = 3

#: Total solo dev conversations per story (each red one consumes a dev retry).
#: ``≤ 3`` per the operator's spec and CLAUDE.md. Must stay strictly above
#: ``handlers._MAX_DEV_SAME_SIGNATURE`` (2) so the early stall guard stays
#: reachable — asserted in ``tests/chain/test_solo_pipeline.py``.
SOLO_MAX_DEV_ATTEMPTS = 3

#: No-progress abort: a conversation whose working tree is byte-identical to its
#: start this long into the run is paused and graded as-is. Measured: the
#: replay's dead attempts made ZERO writes (``vyper-4801``: 3 x 1800 s, every
#: call a ``view``), while the slowest successful attempt's first write lands
#: far earlier than this.
SOLO_NO_PROGRESS_ABORT_S = 1800

_JOB_TEXT_CAP = 16_000


def is_solo(story: Any) -> bool:
    """True when ``story`` runs the solo pipeline.

    Reads ONLY the spawn stamp. A docs-chain story has no dev/review loop, so
    ``pipeline`` is meaningless for it and it always runs the docs chain.
    """
    if (getattr(story, "chain_kind", "tdd") or "tdd") == "docs":
        return False
    return (getattr(story, "pipeline", "chain") or "chain") == SOLO


def requires_production_delta(app_config: Any) -> bool:
    """Whether the app asks for a non-test change (``gates.require_production_delta``)."""
    return bool(getattr(getattr(app_config, "gates", None), "require_production_delta", False))


def max_dev_attempts(story: Any, configured_cap: int) -> int:
    """The dev-retry cap that applies to ``story``.

    Chain stories keep the configured cap untouched. Solo stories are capped at
    ``SOLO_MAX_DEV_ATTEMPTS`` — each solo attempt is already up to
    ``SOLO_MAX_GATE_ROUNDS`` rounds inside a 5400 s conversation.
    """
    if not is_solo(story):
        return configured_cap
    # Floor: the early stall guard (``handlers._MAX_DEV_SAME_SIGNATURE``) must
    # stay STRICTLY below the cap or it becomes unreachable (CLAUDE.md).
    from factory.chain.handlers import _MAX_DEV_SAME_SIGNATURE

    return max(_MAX_DEV_SAME_SIGNATURE + 1, min(int(configured_cap), SOLO_MAX_DEV_ATTEMPTS))


def spend_cap_for(
    story: Any, software_factory_root: Path, db_path: Path
) -> tuple[float | None, dict[str, Any]]:
    """The live spend cap for ONE solo conversation, plus how it was derived.

    ``min(per_story_spend_usd - this story's ledger spend,
    daily_spend_usd - today's ledger spend,
    hourly_spend_usd - the last hour's ledger spend)`` over whichever caps are
    set (> 0). The orchestrator's breakers only run BETWEEN dispatches; a 5400 s
    conversation could otherwise blow through both inside one dispatch. The
    watchdog pauses the run and the tree is graded when its live cost reaches
    this. ``None`` = no cap configured. Fail SAFE: if the caps or the ledger
    cannot be read, the cap is 0.0 (the run is paused at its first spend and
    graded) rather than unbounded.
    """
    try:
        from factory.settings.loader import load_settings
        from factory.settings.spend import hour_spend_usd, today_spend_usd

        caps = load_settings(software_factory_root).caps
        per_story = float(getattr(caps, "per_story_spend_usd", 0.0) or 0.0)
        daily = float(getattr(caps, "daily_spend_usd", 0.0) or 0.0)
        hourly = float(getattr(caps, "hourly_spend_usd", 0.0) or 0.0)
        basis: dict[str, Any] = {
            "per_story_spend_usd": per_story,
            "daily_spend_usd": daily,
            "hourly_spend_usd": hourly,
        }
        limits: dict[str, float] = {}
        if per_story > 0:
            story_spent = _story_ledger_spend(getattr(story, "id", None), db_path)
            basis["story_spent_usd"] = round(story_spent, 4)
            limits["per_story"] = per_story - story_spent
        if daily > 0:
            today = today_spend_usd(software_factory_root, db_path=db_path)
            basis["today_spent_usd"] = round(today, 4)
            limits["daily"] = daily - today
        if hourly > 0:
            hour = hour_spend_usd(software_factory_root, db_path=db_path)
            basis["hour_spent_usd"] = round(hour, 4)
            limits["hourly"] = hourly - hour
        if not limits:
            return None, basis
        binding = min(limits, key=lambda k: limits[k])
        cap = max(0.0, limits[binding])
        basis["cap_usd"] = round(cap, 4)
        basis["binding_limit"] = binding
        return cap, basis
    except Exception as exc:  # noqa: BLE001 - fail safe: a cap we cannot compute is 0
        return 0.0, {
            "cap_usd": 0.0,
            "binding_limit": "unreadable",
            "reason": f"cap unreadable, fail-safe 0: {exc!r}"[:300],
        }


def _story_ledger_spend(story_id: int | None, db_path: Path) -> float:
    if story_id is None:
        return 0.0
    from sqlmodel import Session, select

    from factory.runner import Run, _engine

    with Session(_engine(db_path)) as session:
        return float(
            sum(
                float(r.cost_usd or 0.0)
                for r in session.exec(select(Run).where(Run.story_id == story_id)).all()
            )
        )


# --------------------------------------------------------------------------- #
# Brief
# --------------------------------------------------------------------------- #


def build_solo_brief(direction: Any | None) -> str:
    """The solo addendum appended to the dev's initial message.

    The dev already receives the persona prompt, the repo context prelude
    (``compose_context_prelude``) and the SM story file. Solo adds the job's own
    text (the direction body — today only ANCESTOR directions reach the dev) and
    the working rules that replace the reviewer: reuse before writing, follow
    the repo's conventions, own the tests.
    """
    parts = [
        "# Solo pipeline — you own this job end to end",
        "",
        "There is NO separate reviewer on this job. You are the only agent that "
        "will read this code before the merge gates (the repo's test suite, its "
        "configured gates and CI) run on it. Work accordingly:",
        "",
        "1. **Find and reuse existing code first.** Before writing anything new, "
        "search the repo (grep/find) for functions, helpers, models, fixtures and "
        "patterns that already do part of the job. Extend or call them. Do NOT "
        "create a parallel reimplementation of something the repo already has.",
        "2. **Follow the repo's conventions** — layout, naming, error handling, "
        "logging, typing and test style — as shown by the neighbouring code and "
        "any contributor docs (README, CONTRIBUTING, CLAUDE.md, AGENTS.md, "
        "lint/format config).",
        "3. **Write or extend tests** for the behaviour you add or change, in the "
        "repo's existing test layout, and run the test command until it is green. "
        "Never weaken, skip or delete an existing test to get green.",
        "4. **Keep the change scoped to the job.** No drive-by refactors.",
        "5. When you stop, the factory runs its gate on your working tree and, if "
        "it is not green, sends you the reason in THIS conversation. Fix the cause "
        "and continue; a round that changes nothing ends the run.",
        "6. If the job cannot be done as written, end with `UNDERSPECIFIED: <why>` "
        "instead of guessing.",
    ]
    body = ""
    if direction is not None:
        body = (getattr(direction, "raw_body", "") or "").strip()
    if body:
        if len(body) > _JOB_TEXT_CAP:
            body = body[:_JOB_TEXT_CAP] + "\n\n[... job text truncated ...]"
        title = getattr(direction, "title", "") or ""
        parts += [
            "",
            "## The job, as submitted" + (f": {title}" if title else ""),
            "",
            "This is the original job text the story above was cut from. The story "
            "file is your scope; this is the intent behind it.",
            "",
            body,
        ]
    return "\n".join(parts)


# --------------------------------------------------------------------------- #
# In-conversation gate
# --------------------------------------------------------------------------- #


def make_gate_check(
    *,
    repo_path: Path,
    test_command: str | None,
    branch_is_empty: Any,
    production_delta: Any | None = None,
    static_gates: list[tuple[str, str]] | None = None,
    static_baseline: dict[str, Any] | None = None,
) -> Any:
    """Build the ``gate_check`` callable ``sandbox_run`` runs between rounds.

    Checks, in order (each later one only when the earlier ones pass):

    1. ``test_command`` — the app's configured test command, the same one the
       chain grades dev with (``runner._run_pytest``).
    2. ``non_empty_change`` — the branch carries a change vs its base (a green
       suite on an untouched tree proves nothing, and the tech-writer refuses an
       empty diff). ``branch_is_empty()`` returns True/False/None; None
       (unknown) PASSES — fail open, as the chain's own empty-diff check does.
    3. ``production_delta`` (only when the app sets
       ``gates.require_production_delta``) — the branch has a non-test change.
       Same True/False/None contract.
    4. ``static_gates`` — the app's own lint / format-check / type-check
       commands (``gates.lint_command`` etc.), the same ones its CI runs.
       ``static_baseline[name]`` is the base commit's result (see
       :func:`static_gate_baseline`): ``True`` green, ``None`` unknown, or the
       frozenset of file paths the check flagged on the base. Red now BLOCKS
       when the base was green or unknown (fail safe), and when the base was
       red but the tree's output names a file the base's did not (a NEW
       finding) or names no file at all (something else broke). Only a red
       whose findings are all pre-existing passes — the dev must not be sent
       to fix unrelated files, but must not add to them either. Observed live
       2026-11-02: job template-probe:005 shipped 4 PRs whose CI failed
       ``format:check`` because only the test command ran in-conversation.
    """
    from factory.runner import _run_pytest

    _static = list(static_gates or [])
    _baseline = dict(static_baseline or {})

    def _check() -> GateVerdict:
        checks: list[dict[str, Any]] = []
        passed, out = _run_pytest(Path(repo_path), test_command=test_command)
        checks.append(
            {
                "name": "test_command",
                "passed": bool(passed),
                "reason": "green" if passed else "test command exited non-zero",
            }
        )
        if not passed:
            return GateVerdict(
                passed=False,
                reason=(
                    f"the test command ({test_command or 'default pytest'}) is not "
                    "green on your working tree"
                ),
                output=out,
                checks=checks,
            )
        empty = branch_is_empty()
        if empty is True:
            checks.append(
                {
                    "name": "non_empty_change",
                    "passed": False,
                    "reason": "no change vs the base branch",
                }
            )
            return GateVerdict(
                passed=False,
                reason=(
                    "tests are green but the branch has NO change vs its base — "
                    "nothing would ship. Implement the job (uncommitted edits "
                    "count; the factory commits the tree for you)."
                ),
                output=out,
                checks=checks,
            )
        checks.append(
            {
                "name": "non_empty_change",
                "passed": True,
                "reason": "change present" if empty is False else "unknown (fail open)",
            }
        )
        if production_delta is not None:
            delta = production_delta()
            if delta is False:
                checks.append(
                    {
                        "name": "production_delta",
                        "passed": False,
                        "reason": "only test files changed",
                    }
                )
                return GateVerdict(
                    passed=False,
                    reason=(
                        "tests are green but the branch changes ONLY test files — "
                        "the job needs a production-code change"
                    ),
                    output=out,
                    checks=checks,
                )
            checks.append(
                {
                    "name": "production_delta",
                    "passed": True,
                    "reason": "present" if delta is True else "unknown (fail open)",
                }
            )
        for name, cmd in _static:
            ok, sout = _run_pytest(Path(repo_path), test_command=cmd)
            base = _baseline.get(name)
            if ok:
                checks.append({"name": name, "passed": True, "reason": "green"})
                continue
            new_findings: list[str] = []
            if isinstance(base, (set, frozenset)):
                now = finding_paths(sout, Path(repo_path))
                new_findings = sorted(now - set(base))
                if now and not new_findings:
                    checks.append(
                        {
                            "name": name,
                            "passed": True,
                            "reason": (
                                f"red, but only on {len(now)} file(s) already flagged "
                                "on the base commit (not blocking)"
                            ),
                        }
                    )
                    continue
                why = (
                    f"it flags file(s) the base commit did not: {', '.join(new_findings[:10])}"
                    if new_findings
                    else "it fails in a way the base commit did not (no file named)"
                )
            elif base is True:
                why = "it passed on the base commit"
            else:
                why = "the base commit's result is unknown, so any failure blocks"
            checks.append({"name": name, "passed": False, "reason": f"red on your tree; {why}"})
            return GateVerdict(
                passed=False,
                reason=(
                    f"tests are green but the repo's {name} check (`{cmd}`) fails on "
                    f"your working tree — {why}. The repo's CI runs it. Fix what your "
                    "change broke (e.g. run the formatter on the files you changed, fix "
                    "the lint/type errors); do not touch unrelated files."
                ),
                output=sout,
                checks=checks,
            )
        return GateVerdict(
            passed=True, reason="all in-conversation checks green", output=out, checks=checks
        )

    # The runner's hard backstop adds this on top of its own grading grace, so
    # the extra commands cannot push a final grading round past it (a timed-out
    # run loses its spend record and file list).
    setattr(_check, "extra_grace_s", static_gate_grace_s(_static))  # noqa: B010
    return _check


STATIC_GATE_FIELDS: tuple[tuple[str, str], ...] = (
    ("lint", "lint_command"),
    ("format_check", "format_check_command"),
    ("type_check", "type_check_command"),
)


def static_gate_commands(app_config: Any) -> list[tuple[str, str]]:
    """The app's configured lint / format / type commands, in a fixed order."""
    gates = getattr(app_config, "gates", None)
    out: list[tuple[str, str]] = []
    for name, field_name in STATIC_GATE_FIELDS:
        cmd = str(getattr(gates, field_name, "") or "").strip()
        if cmd:
            out.append((name, cmd))
    return out


_FINDING_RE = re.compile(
    r"(?<![\w@.+/-])((?:[\w@.+-]+/)*[\w@.+-]+\.(?:[cm]?[jt]sx?|py|pyi|md|mdx|json|ya?ml|css|scss|html|vue|svelte|go|rs|rb|java|kt|swift|toml|sql|prisma))(?=[\s:(\[,]|$)"
)


def finding_paths(output: str, root: Path) -> frozenset[str]:
    """Repo-relative-looking file paths a lint/format/type tool named.

    Absolute paths under ``root`` are made relative (eslint prints absolute
    paths); other absolute paths and anything under ``node_modules`` are
    dropped (toolchain noise, not findings). Comparison is between two runs of
    the SAME command, so a tool's own path style (tsc prints paths relative to
    its package) only has to be consistent with itself.
    """
    import os

    root_s = os.path.realpath(str(root)).rstrip("/") + "/"
    raw_root = str(root).rstrip("/") + "/"
    out: set[str] = set()
    for line in output.splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", line)
        for tok in re.findall(r"\S+", line):
            for prefix in (root_s, raw_root):
                if prefix in tok:
                    tok = tok.split(prefix, 1)[1]
            for m in _FINDING_RE.finditer(tok):
                p = m.group(1)
                if p.startswith("/") or "node_modules" in p or p.startswith(".."):
                    continue
                out.add(p.lstrip("./") if p.startswith("./") else p)
    return frozenset(out)


def static_gate_baseline(
    repo: Path, base_branch: str, gates: list[tuple[str, str]]
) -> dict[str, Any]:
    """Run each static gate on a throwaway checkout of the merge-base.

    Per gate: ``True`` = green on the base; ``None`` = could not tell (no
    merge-base, checkout failed, the command could not run, or it went red
    without naming any file — e.g. the dependency install failed); otherwise
    the frozenset of file paths it flagged on the base. Never touches
    ``repo``'s working tree.
    """
    import shutil
    import tempfile

    from factory.runner import _run_pytest

    if not gates:
        return {}
    mb = _merge_base(repo, base_branch)
    if mb is None:
        return {name: None for name, _ in gates}
    tmp = Path(tempfile.mkdtemp(prefix="solo-baseline-"))
    wt = tmp / "base"
    try:
        rc, _ = _git_ro(repo, "worktree", "add", "--detach", str(wt), mb)
        if rc != 0:
            return {name: None for name, _ in gates}
        result: dict[str, Any] = {}
        for name, cmd in gates:
            ok, out = _run_pytest(wt, test_command=cmd)
            if ok:
                result[name] = True
                continue
            # Red is only usable as a baseline when it names what it flagged.
            # A red that could not run, or names no file (a failed npm ci /
            # prisma generate, a crash), says nothing about the base: unknown,
            # which BLOCKS later — never "already red", which would wave the
            # dev's breakage through.
            found = (
                frozenset()
                if out.startswith("test_command invocation failed")
                else finding_paths(out, wt)
            )
            result[name] = found or None
        return result
    finally:
        _git_ro(repo, "worktree", "remove", "--force", str(wt))
        shutil.rmtree(tmp, ignore_errors=True)
        _git_ro(repo, "worktree", "prune")


def static_gate_grace_s(gates: list[tuple[str, str]]) -> int:
    """Extra hard-backstop headroom the static checks need per grading round."""
    return STATIC_GATE_TIMEOUT_S * len(gates)


#: ``runner._run_pytest``'s per-command timeout, which each static check uses.
STATIC_GATE_TIMEOUT_S = 600


# --------------------------------------------------------------------------- #
# Read-only branch probes (used INSIDE the conversation)
# --------------------------------------------------------------------------- #
#
# The gate must grade the tree the dev left and must not change it. The chain's
# own helpers (``handlers._dev_produced_empty_diff`` /
# ``_branch_has_production_delta``) go through ``handlers._writing_worktree``,
# which FETCHES and MERGES ``origin/<base>`` into the worktree: called between
# the test verdict and the ship, that grades one tree and ships another, and it
# moves HEAD between rounds (defeating the no-progress check). These probes only
# READ: ``git status`` and ``git diff`` against the merge-base of the base ref
# the worktree already has. The base refresh happens once, BEFORE the
# conversation starts (``_handle_dev_once`` → ``_writing_worktree``).


def _git_ro(repo: Path, *args: str) -> tuple[int, str]:
    import subprocess

    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(repo),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return -1, ""
    return proc.returncode, proc.stdout


def _merge_base(repo: Path, base_branch: str) -> str | None:
    for ref in (f"origin/{base_branch}", base_branch):
        rc, out = _git_ro(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
        if rc == 0 and out.strip():
            rc2, mb = _git_ro(repo, "merge-base", ref, "HEAD")
            if rc2 == 0 and mb.strip():
                return mb.strip()
    return None


def _changed_paths_ro(repo: Path, base_branch: str) -> set[str] | None:
    """Paths this branch changes vs its merge-base: committed + uncommitted +
    untracked. ``None`` = cannot tell."""
    mb = _merge_base(repo, base_branch)
    if mb is None:
        return None
    rc, tracked = _git_ro(repo, "diff", "--name-only", mb)
    if rc != 0:
        return None
    rc, untracked = _git_ro(repo, "ls-files", "--others", "--exclude-standard")
    if rc != 0:
        return None
    return {p for p in (tracked.splitlines() + untracked.splitlines()) if p.strip()}


def branch_is_empty_ro(repo: Path, base_branch: str) -> bool | None:
    """True = no change vs the merge-base (committed or not); None = unknown."""
    paths = _changed_paths_ro(repo, base_branch)
    if paths is None:
        return None
    return not paths


def production_delta_ro(repo: Path, base_branch: str) -> bool | None:
    """True = at least one non-test path changed; False = none; None = unknown."""
    from factory import diff_paths

    paths = _changed_paths_ro(repo, base_branch)
    if paths is None:
        return None
    if not paths:
        return False
    return any(not diff_paths.is_test_path(p) for p in paths)


# --------------------------------------------------------------------------- #
# Oracle leak precondition + the logged check plan
# --------------------------------------------------------------------------- #


def oracle_leak_precheck(app_config: Any, worktree: Path) -> list[str] | None:
    """Blocking precondition for a solo dev dispatch.

    ``None`` = not applicable (the app has no acceptance oracle). Otherwise the
    list of oracle-shaped files in ``worktree`` that are REAL leaks (untracked,
    not removable by the sweep). Non-empty ⇒ the caller must NOT dispatch.
    Fail SAFE: if the check itself cannot run, report a synthetic leak so the
    dispatch blocks rather than proceeding blind.
    """
    gates = getattr(app_config, "gates", None)
    if not bool(getattr(gates, "acceptance_oracle", False)):
        return None
    try:
        from factory.chain.acceptance import sweep_leaked_oracles, unremovable_oracle_leaks

        sweep_leaked_oracles(worktree)
        return list(unremovable_oracle_leaks(worktree))
    except Exception as exc:  # noqa: BLE001 - fail safe: block
        _logger.warning("solo oracle leak check failed (blocking): %r", exc)
        return [f"<leak check failed: {exc!r}>"[:300]]


def checks_plan(app_config: Any, story: Any) -> dict[str, Any]:
    """What independently gates this solo story — logged as ``solo_checks``."""
    gates = getattr(app_config, "gates", None)
    oracle_on = bool(getattr(gates, "acceptance_oracle", False))
    try:
        from factory.chain.gates.evaluator import required_gate_labels

        required = required_gate_labels(app_config, story)
    except Exception as exc:  # noqa: BLE001 - telemetry only
        required = [f"<unavailable: {exc!r}>"[:200]]
    in_conv = ["test_command", "non_empty_change"]
    if requires_production_delta(app_config):
        in_conv.append("production_delta")
    in_conv.extend(name for name, _ in static_gate_commands(app_config))
    return {
        "pipeline": SOLO,
        "reviewer": "skipped (solo pipeline)",
        "in_conversation_checks": in_conv,
        "test_command": getattr(gates, "test_command", None),
        "max_gate_rounds": SOLO_MAX_GATE_ROUNDS,
        "wall_clock_s": SOLO_DEV_WALL_CLOCK_S,
        "no_progress_abort_s": SOLO_NO_PROGRESS_ABORT_S,
        "max_dev_attempts": SOLO_MAX_DEV_ATTEMPTS,
        "acceptance_oracle": (
            "enabled: required merge gate acceptance-verified + blocking leak precheck"
            if oracle_on
            else "disabled for this app: gates are the test suite + configured merge gates + CI"
        ),
        "merge_gates_required": required,
        "ci": "required checks via the auto-merge worker (tests-green reads CI)",
    }


__all__ = [
    "SOLO",
    "SOLO_DEV_WALL_CLOCK_S",
    "SOLO_MAX_DEV_ATTEMPTS",
    "SOLO_MAX_GATE_ROUNDS",
    "SOLO_NO_PROGRESS_ABORT_S",
    "build_solo_brief",
    "checks_plan",
    "finding_paths",
    "static_gate_baseline",
    "static_gate_grace_s",
    "static_gate_commands",
    "is_solo",
    "make_gate_check",
    "max_dev_attempts",
    "oracle_leak_precheck",
    "requires_production_delta",
    "spend_cap_for",
    "branch_is_empty_ro",
    "production_delta_ro",
]
