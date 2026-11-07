"""Gate: ``tests-meaningful`` — static slop detection on the PR's test diff.

The gate runs the slop detector against the changed test files; any finding
fails the merge. That is the whole gate, and it is the only thing this gate has
ever actually done.

Why there is no mutation branch here any more
=============================================
This module used to carry a second, opt-in layer: real ablation/mutation
testing, behind ``gates.mutation_testing``. It **never ran** — the flag is
``false`` in every app config — while ``tests-meaningful`` IS in
``LOOP4_REQUIRED_GATE_LABELS``. That one flag was the only thing between four
independently verified defects and every merge in the factory:

1. **It ablated symbols the diff never touched.** It enumerated every public
   symbol of each changed file, capped the list at 5 and sorted by
   ``(path, lineno)`` — i.e. it took the top five of the alphabetically-first
   changed file. Verified here on ``e13d98e0``: 21 candidates, cap hit, and the
   five it picked had ZERO overlap with the 9 symbols the commit changed (7 of
   which it could never pick at all, being ``_``-prefixed). PLAN.md A.5 reports
   the same shape across the last 40 commits — median 21 candidates, 77% at the
   cap.
2. **It was fail-OPEN.** ``factory.runner._run_pytest`` returns ``False`` for a
   600 s timeout, a missing command and a genuine test failure alike, and
   ``False`` was read as "the suite noticed → the symbol is exercised → good".
   With no green baseline before mutating, an already-red suite or a failed
   ``uv sync`` certified coverage that was never measured. Reproduced: with
   ``test_command`` pointing at a nonexistent binary the gate returned
   "ablation: all 2 sampled symbol(s) exercised by tests".
3. **It mutated the live story worktree** — the ``state/worktrees/`` checkout
   the chain later pushes from — by round-tripping the whole file through
   ``ast.unparse`` (on ``handlers.py``: 4,804 → 2,113 lines, all 756 comments
   gone), restoring in a ``finally`` that a SIGKILL does not run.
4. **It failed in dry-run**, which is the default for ``factory auto-merge``.

The branch was DELETED rather than repaired in place. The repaired measurement
lives in ``factory/chain/mutation.py`` and is reachable only from
``factory mutation-score`` — deliberately not from any gate, so no merge
decision can reach it. An "advisory" branch inside a required gate is still one
edit from blocking every merge, and there is no measured case for gating on a
mutation score yet: the number it was meant to replace, the reviewer's
self-reported ``test_quality_score``, turned out to be inert (across all 31
reviewer calls of the graded n=19 sweep, no ``approve`` ever carried a score
below the 0.7 threshold, so the threshold vetoed nothing).
``evaluator.py:18-29`` set the precedent this follows — a gate detached from a
real check is worse than no gate.

``gates.mutation_testing`` survives as a config field for compatibility and is
deliberately inert here. ``tests/test_gates_evaluation.py`` pins that: with the
flag ON, this gate's verdict and details are identical to the flag OFF.
"""

from __future__ import annotations

from factory.app_config import AppConfig
from factory.chain.gates.evaluator import GateResult, PRContext
from factory.chain.slop_detector import scan_diff


def evaluate(pr: PRContext, app_config: AppConfig) -> GateResult:
    label = "tests-meaningful"
    # Fail-closed, not vacuously-green: an empty ``files_changed`` on a REAL
    # real-run PR means the caller could not resolve the diff (a ``gh``
    # failure), not that the diff is genuinely empty — ``scan_diff`` iterates
    # the file list, so an empty list scans nothing and reports "no findings"
    # regardless of what the PR actually did. Found 2026-08-07 alongside the
    # same hole in ``canonical-paths-only``: the tick path's synthesized
    # fixtures carried ``files_changed=[]`` for every real PR, so this REQUIRED
    # gate always passed without ever running. Dry-run / no-PR fixtures are
    # unaffected — that vacuous shape is genuinely what a preview with no
    # checkout looks like, not a resolution failure.
    if not pr.files_changed and not pr.dry_run and pr.pr_number > 0:
        return GateResult(
            label=label,
            passed=False,
            reason=(
                "cannot determine the changed files for this real PR "
                "(files_changed unavailable) — refusing to scan a diff it cannot see"
            ),
            details={"authoritative": False, "files_changed_unavailable": True},
        )
    findings = scan_diff(pr.files_changed, repo_root=pr.repo_root)
    findings_dicts = [fnd.as_dict() for fnd in findings]
    if findings:
        return GateResult(
            label=label,
            passed=False,
            reason=f"{len(findings)} slop finding(s)",
            details={"findings": findings_dicts},
        )

    # ``mutation_status`` stays in the details for consumers that read the key,
    # and is now a constant. Note what is NOT here: any read of
    # ``app_config.gates.mutation_testing``. There is no expression in this
    # module through which that flag can change a merge verdict.
    return GateResult(
        label=label,
        passed=True,
        reason="no slop findings",
        details={"mutation_status": "not_a_merge_gate", "findings": []},
    )
