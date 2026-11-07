"""Gate: ``canonical-paths-only``.

Runs ``factory.context.enforcer.scan_pr_diff`` on the PR's file list.
Zero violations → pass.
"""

from __future__ import annotations

from factory.app_config import AppConfig
from factory.chain.gates.evaluator import GateResult, PRContext
from factory.context.enforcer import scan_pr_diff


def evaluate(pr: PRContext, app_config: AppConfig) -> GateResult:
    label = "canonical-paths-only"
    # Fail-closed, not vacuously-green — same hole as ``tests_meaningful.py``
    # (see its comment): an empty ``files_changed`` on a real real-run PR means
    # the caller could not resolve the diff, not that nothing changed.
    # Dry-run / no-PR fixtures keep the old vacuous-pass shape unchanged.
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
    violations = scan_pr_diff(pr.files_changed)
    if violations:
        return GateResult(
            label=label,
            passed=False,
            reason=f"{len(violations)} canonical-paths violation(s)",
            details={"violations": [v._asdict() for v in violations]},
        )
    return GateResult(label=label, passed=True, reason="no violations")
