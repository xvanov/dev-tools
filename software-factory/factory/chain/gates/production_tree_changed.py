"""Gate: ``production-tree-changed``.

The story's diff must change at least one PRODUCTION file. FAIL-CLOSED: a diff
this gate cannot see is a diff it refuses to bless.

Why this gate exists (measured, 2026-08-04)
-------------------------------------------
The chain was graded against a hidden oracle for the first time: 7/19 resolved,
and its own green verdict was 40% precise (6 of 15 "green" rows actually
passed). Every check the chain runs measures agreement with artifacts the chain
itself produced — the dev writes the code AND the tests, the reviewer's approve
rule reads a ``test_quality_score``, the merge gate re-runs the dev's own
tests. One row, ``harumiweb__exstruct-113``, spent $2.45, edited ONLY
``tests/cli/test_cli_lazy_imports.py``, was approved by the reviewer at
``test_quality_score=0.90``, reached ``reviewer_done``, and recorded
``files_changed: []`` / ``diff_bytes: 0``. Nothing in the chain noticed that
the production tree was untouched, because nothing was looking.

That is the cheapest possible false-green to close: "did the arm change
anything other than the thing that judges it" needs no model call, no
execution, and no judgement.

What counts as production code
------------------------------
``factory.diff_paths`` — the module ``bench/swebench_adapter.py`` also uses to
strip test edits out of a graded prediction and to refuse a prediction that
edits a pytest collection channel. This gate uses that module's STRICT
matcher (``is_test_code_path``), because a false positive here costs a real
merge while the bench's over-inclusive matcher only ever weakens an arm's own
patch; the two are one subset relation in one module, asserted by
``tests/test_diff_paths.py``. Measured cost of getting that wrong: the broad
matcher classifies ``factory/testing/flake.py`` — code THIS gate's sibling
imports — as a test. Production = not test code, and not a
collection/auto-import channel (``pyproject.toml``, ``pytest.ini``, ``tox.ini``,
``setup.cfg``, ``noxfile.py``, ``sitecustomize.py``, ``*.pth``,
``*pytest*plugin*.py``, ``conftest.py``). A story whose only non-test change is
pytest configuration is not a fix: measured against real pytest, ``addopts =
"-p _fixup"`` plus a collection hook makes the whole suite exit 0 with
"skipped".

Docs, non-collection config and source all count as production. This gate asks
"was anything but the oracle touched", not "is this change interesting" — so a
docs-only TDD story still passes, and only a genuinely vacuous or
test-only/config-only diff blocks.

Resolution order (every branch derives from a REAL artifact)
------------------------------------------------------------
1. ``pr.files_changed`` — GitHub's own file list for the PR. Only the
   ``--real-run`` CLI path populates it; the orchestrator's own ticks
   synthesize fixtures with ``files_changed=[]``, so in production this branch
   is usually empty and (2) carries the decision.
2. ``pr.repo_root`` — ``git diff --name-only <base_ref>...HEAD`` in the story
   worktree, with the same ``origin/<base>`` → local ``<base>`` fallback
   (``handlers._resolve_diff_base``) the reviewer's diff and the docs-enforcer
   use, so all three agree about what the branch changed. COMMITTED work only:
   uncommitted edits are not what merges. Caveat inherited from that topology:
   the worktree can lag the pushed branch, so this reads the local commits, not
   the exact tree GitHub will squash.
3. Real-run with a PR number and no usable worktree → ``gh pr diff
   --name-only``. This branch exists because ``_story_worktree`` swallows every
   failure into ``repo_root=None`` (a GC'd or unbuildable worktree), and without
   it a required fail-closed gate would turn any worktree fault into an
   unmergeable PR. It is LAST because it costs a GH API call per evaluation.
4. Nothing derivable → BLOCK. There is deliberately no "assume it is fine"
   branch and no recorded-flag branch: ``evaluator.py`` (see the ALL_GATE_LABELS
   comment) records the precedent that a gate detached from a real check is
   worse than no gate, because it manufactures a verdict.

Where this gate does NOT run (known, deliberate limits)
------------------------------------------------------
* ``chain_kind == "docs"`` stories skip the whole gate evaluator
  (``auto_merge`` short-circuits to ``_DOCS_CHAIN_GATE_LABELS``). Harmless for
  this check — docs ARE production under this predicate, so a docs story would
  pass anyway.
* ``reconcile_from_github`` advances a PR merged out-of-band straight to
  ``deploy_pending``. An operator merging a PR by hand is an operator decision;
  no local gate is consulted, by design.

This gate is in ``LOOP4_REQUIRED_GATE_LABELS``, i.e. merge-REQUIRED. That is
load-bearing: ``auto_merge`` computes ``missing_labels`` only over
``required_gate_labels(...)``, so a non-required gate's failure is filtered out
of the merge decision and the PR merges anyway.
"""

from __future__ import annotations

from pathlib import Path

from factory.app_config import AppConfig
from factory.chain.gates.evaluator import GateResult, PRContext
from factory.diff_paths import (
    is_collection_channel_path,
    is_test_code_path,
    production_paths,
)

_LABEL = "production-tree-changed"


def _git_changed_paths(repo_root: Path, base_branch: str) -> tuple[list[str] | None, str]:
    """``(paths, note)`` from ``git diff --name-only <base_ref>...HEAD``.

    ``None`` means "could not derive" — a missing base ref, a git failure, a
    timeout. The caller fails closed on it; it never degrades to ``[]``, which
    would read as "the branch genuinely changed nothing".
    """
    import subprocess

    # Reuse the chain's own base-ref resolver rather than re-deriving the
    # fallback chain here: a gate that disagrees with the reviewer about the
    # diff base would block PRs the reviewer approved on a different diff.
    # Imported lazily — handlers is a heavy module and gates are imported by
    # the CLI.
    try:
        from factory.chain.handlers import _resolve_diff_base
    except Exception as exc:  # noqa: BLE001 — fail closed, never wave through
        return None, f"could not import the diff-base resolver: {exc!r}"

    base_ref = _resolve_diff_base(repo_root, base_branch)
    if base_ref is None:
        return None, (
            f"no diff base ref: neither 'origin/{base_branch}' nor "
            f"'{base_branch}' resolves in {repo_root}"
        )
    try:
        proc = subprocess.run(
            ["git", "diff", "--name-only", f"{base_ref}...HEAD"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            errors="replace",  # paths are arbitrary bytes; never strict-decode-crash
            check=False,
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001 — any git/OS failure fails CLOSED
        return None, f"git diff --name-only failed: {exc!r}"
    if proc.returncode != 0:
        return None, (
            f"git diff --name-only {base_ref}...HEAD exited "
            f"rc={proc.returncode}; stderr_tail={proc.stderr.strip()[-200:]!r}"
        )
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()], (
        f"git diff --name-only {base_ref}...HEAD"
    )


def _gh_changed_paths(pr_number: int, repo: str) -> tuple[list[str] | None, str]:
    """``(paths, note)`` from ``gh pr diff --name-only``. ``None`` on any failure."""
    import subprocess

    try:
        proc = subprocess.run(
            ["gh", "pr", "diff", str(pr_number), "--name-only", "--repo", repo],
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=120,
        )
    except Exception as exc:  # noqa: BLE001 — fail closed
        return None, f"gh pr diff --name-only failed: {exc!r}"
    if proc.returncode != 0:
        return None, (
            f"gh pr diff --name-only #{pr_number} exited rc={proc.returncode}; "
            f"stderr_tail={proc.stderr.strip()[-200:]!r}"
        )
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()], (
        f"gh pr diff --name-only #{pr_number}"
    )


def evaluate(pr: PRContext, app_config: AppConfig) -> GateResult:
    label = _LABEL

    paths: list[str] | None = None
    source = "no files_changed, no repo_root, no PR to query"
    if pr.files_changed:
        paths = list(pr.files_changed)
        source = "pr.files_changed (GitHub)"
    elif pr.repo_root is not None:
        paths, source = _git_changed_paths(pr.repo_root, pr.base_branch or "main")
    if paths is None and not pr.dry_run and pr.pr_number > 0 and app_config.repo:
        # Last resort, and the reason a worktree fault cannot wedge a merge.
        gh_paths, gh_source = _gh_changed_paths(pr.pr_number, app_config.repo)
        if gh_paths is not None:
            paths, source = gh_paths, gh_source
        else:
            source = f"{source}; {gh_source}"

    if paths is None:
        return GateResult(
            label=label,
            passed=False,
            reason=f"cannot determine the changed files, so cannot prove production code changed: {source}",
            details={"source": source, "authoritative": False},
        )

    production = production_paths(paths)
    if production:
        return GateResult(
            label=label,
            passed=True,
            reason=f"{len(production)} production file(s) changed",
            details={
                "source": source,
                "production_paths": production[:20],
                "changed_count": len(paths),
                "authoritative": True,
            },
        )

    # Zero production files. Say WHICH kind of vacuous this is — a 0-file diff
    # and a test-only diff need different operator responses.
    test_only = [p for p in paths if is_test_code_path(p)]
    config_only = [
        p for p in paths if not is_test_code_path(p) and is_collection_channel_path(p)
    ]
    if not paths:
        detail = "the diff is EMPTY — nothing was committed on this branch"
    else:
        detail = (
            f"the diff touches only test files ({len(test_only)}) and pytest "
            f"collection config ({len(config_only)})"
        )
    return GateResult(
        label=label,
        passed=False,
        reason=f"no production-code change: {detail}",
        details={
            "source": source,
            "changed_paths": paths[:20],
            "test_paths": test_only[:20],
            "collection_config_paths": config_only[:20],
            "authoritative": True,
        },
    )
