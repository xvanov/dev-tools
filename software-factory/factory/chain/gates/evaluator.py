"""Gate evaluator + shared types.

This module centralizes the gate-running pipeline so handlers, the
auto-merge worker, and the CLI all reuse the same evaluation logic.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from factory.app_config import AppConfig
from factory.chain.state_machine import StoryRecord

# The complete set of gate labels, in the order the chain expects them.
#
# The historical 11-label set carried six VESTIGIAL gates that read
# StoryRecord fields no Loop-4 handler ever writes, or payloads from personas
# deleted in the Loop-4 collapse (WS1.6, 2026-07-19):
#   * tests-red-first-confirmed / flow-verified — read the deleted
#     test_implementer / test_designer payloads.
#   * lint-clean / format-clean / types-clean / coverage-verified — read
#     StoryRecord.{lint,format,types,coverage}_passed flags that are always
#     None (nothing assigns them). None of the six were in the required set,
#     so they only ever produced non-blocking noise. Removed outright: a gate
#     that evaluates an unwritten flag is worse than no gate — it manufactures
#     a green/red signal detached from any real check.
ALL_GATE_LABELS: list[str] = [
    "tests-green",
    "tests-meaningful",
    # The diff changed at least one PRODUCTION file (2026-08-04). Added after
    # the first hidden-oracle grading found a story that spent $2.45, edited
    # only a test file, was approved at test_quality_score=0.90 and reached
    # ``reviewer_done`` with ``diff_bytes: 0``. See production_tree_changed.py.
    "production-tree-changed",
    "docs-current",
    "canonical-paths-only",
    "smoke-green",
    # WS1.2 independent acceptance oracle. Per-app opt-in like smoke-green;
    # required only for stories that actually got an oracle authored.
    "acceptance-verified",
]

# The labels REQUIRED to merge a Loop-4 (dev-owns-tests) story. These are the
# signals that still exist independently at merge time: the dev's recorded
# green run (re-derived by re-running the suite in real-run, WS1.4), the
# programmatic slop-gate veto on every real review, the reviewer's approval,
# and the docs-enforcer — all encoded in the story reaching a mergeable state.
LOOP4_REQUIRED_GATE_LABELS: list[str] = [
    "tests-green",
    "tests-meaningful",
    # REQUIRED, not merely evaluated. ``auto_merge`` builds ``present_labels``
    # from the passing gates but computes ``missing_labels`` ONLY over
    # ``required_gate_labels(...)`` (auto_merge.py:~955), so a non-required
    # gate's failure is filtered straight out of the merge decision and the PR
    # merges anyway. A blocking result that does not block is worse than no
    # gate. Universally required is safe here where ``smoke-green`` was not:
    # the check needs no per-app harness, and docs/config/source all count as
    # production, so the only diffs it blocks are vacuous ones.
    "production-tree-changed",
    "docs-current",
    "canonical-paths-only",
]


def required_gate_labels(
    app_config: AppConfig, story: StoryRecord | None = None
) -> list[str]:
    """The merge-required gate labels for THIS app (D002), and — when a
    ``story`` is supplied — for this specific story.

    The Loop-4 base set is universal. Runtime gates are appended per-app, only
    when the app declares the capability — keeping the rollout opt-in so an app
    without a smoke harness sees no new merge blocks (the PRs 110/111 regression
    was caused by making a gate universally required before every app could
    satisfy it). ``smoke-green`` becomes required exactly when the app has a
    working, declared smoke harness.

    ``acceptance-verified`` (WS1.2) becomes required as soon as the app opts in
    (``gates.acceptance_oracle``) — for EVERY story, and with no ``story`` at all.
    Applicability is the GATE's decision, not the required set's: the gate passes
    a story whose direction genuinely carries no acceptance criteria, and blocks
    when it cannot establish that (see ``gates.acceptance_verified``).

    This deliberately does NOT read ``story.acceptance_expected``. That flag is
    written by a best-effort DB write which swallows its own errors, so a lost
    write dropped the story out of the required set entirely — and a failing gate
    that is not required is filtered straight out of the merge decision
    (``auto_merge`` computes ``missing_labels`` only over this function), so the PR
    merged un-gated. A required-ness decision that depends on a write succeeding
    is a fail-open; app opt-in is a config fact that cannot be lost at runtime.
    """
    labels = list(LOOP4_REQUIRED_GATE_LABELS)
    gates = app_config.gates
    if gates.smoke_harness_ready and gates.smoke_command:
        labels.append("smoke-green")
    if gates.acceptance_oracle:
        labels.append("acceptance-verified")
    return labels


@dataclass
class PRContext:
    """Everything a gate needs about the PR under evaluation.

    Built by the auto-merge worker from GitHub + the local StoryRecord;
    handed to every gate evaluator. Gates do not call GH themselves
    (centralizes the API surface for testability + rate-limit budget).
    """

    pr_number: int
    head_sha: str
    base_branch: str
    files_changed: list[str] = field(default_factory=list)
    labels: list[str] = field(default_factory=list)
    # "success" | "failure" | "hold" | "pending" | None. Only "success" ever
    # passes ``tests-green`` — "hold" (E6 stage 2: main's own lane is red, see
    # ``auto_merge._CI_STATE_HOLD``) is a non-merge exactly like "failure", it
    # merely suppresses the CI-failure ACTIONS upstream in ``auto_merge_tick``.
    ci_state: str | None = None
    repo_root: Path | None = None  # local checkout for real-run gate execution
    # Factory root — needed by the acceptance-verified gate to resolve a story's
    # ``acceptance_test_ref`` (stored relative to this root, outside repo_root).
    software_factory_root: Path | None = None
    story: StoryRecord | None = None
    commit_history: list[dict[str, Any]] = field(default_factory=list)
    # ^ each entry: {"sha": str, "files": [str], "tests_run_red": bool|None}

    # The worker tells gates whether to actually shell out. dry_run=True
    # forces gates to read StoryRecord-recorded flags only.
    dry_run: bool = True


@dataclass
class GateResult:
    """The output of a single gate evaluation."""

    label: str
    passed: bool
    reason: str
    details: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "passed": self.passed,
            "reason": self.reason,
            "details": self.details,
        }


def gate_label_for(module_name: str) -> str:
    """Map ``canonical_paths_only`` → ``canonical-paths-only``."""
    return module_name.replace("_", "-")


def _run_command(cmd: str, cwd: Path | None) -> tuple[int, str]:
    """Run a shell command, return (exit_code, captured stderr/stdout).

    Centralized so gates have one place to swap for fakes in tests. A hung
    command must fail ITS gate, not abort the whole merge evaluation — the
    smoke gate boots a real stack and is the one command genuinely likely to
    hit the timeout, and evaluate_all_gates deliberately never short-circuits.
    """
    try:
        proc = subprocess.run(
            cmd,
            shell=True,  # noqa: S602 — gate commands come from trusted app config
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True,
            text=True,
            timeout=600,
        )
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"", e.stderr or b"")
        tail = "".join(
            o.decode(errors="replace") if isinstance(o, bytes) else o for o in out
        )[-4000:]
        return 124, f"command timed out after 600s: {cmd}\n{tail}"
    return proc.returncode, (proc.stdout + proc.stderr)[-4000:]


# --------------------------------------------------------------------------- #
# Aggregator
# --------------------------------------------------------------------------- #


def evaluate_all_gates(pr: PRContext, app_config: AppConfig) -> dict[str, GateResult]:
    """Run every gate; return ``{label: GateResult}`` mapping.

    Failure of one gate does not short-circuit the others — operators want
    to see every blocking issue at once, not play whack-a-mole.
    """
    from factory.chain.gates import (
        acceptance_verified,
        canonical_paths_only,
        docs_current,
        production_tree_changed,
        smoke_green,
        tests_green,
        tests_meaningful,
    )

    out: dict[str, GateResult] = {}
    # ORDER MATTERS for the last entry: ``acceptance_verified`` touches the
    # checkout — it sweeps stale oracle copies left by older builds and writes a
    # local ``.git/info/exclude`` entry. Keeping it last means no other gate can
    # observe a copy of the hidden oracle: ``tests_meaningful`` would score it as
    # one of the dev's tests, and ``production_tree_changed`` reads the tree too.
    # (Since 2026-08-05 the oracle only ever runs in a throwaway judge worktree, so
    # this is defence in depth rather than the sole guard — keep it anyway, and
    # ``tests/test_gates_evaluation.py`` asserts the observed order.) Do not move it
    # earlier in this tuple.
    for mod in (
        tests_green,
        tests_meaningful,
        production_tree_changed,
        docs_current,
        canonical_paths_only,
        smoke_green,
        acceptance_verified,
    ):
        result = mod.evaluate(pr, app_config)
        out[result.label] = result
    return out
