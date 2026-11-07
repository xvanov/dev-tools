"""The two sweep-2 machinery losses that had yield, each reproduced.

**1. `tox-dev__tox-3931` — a correct patch scored as nothing.** The dev's
`tox.schema.json` hunk was byte-identical to the winning Claude patch. Its docker
workaround replaced the worktree gitlink with
`mv .git .git.file && ln -s "$GIT_COMMON_DIR" .git`, so the chain's per-iteration
commits landed on **`swebench-base` itself**. `_capture_diff` then diffed the fix
against a ref that now contained the fix, got zero bytes, fell through two
fallbacks that were empty for the same reason, and the row published as
`empty_patch`. Nothing on disk said the ref had moved.

Two halves to the fix, both tested below: diff against the immutable **sha** from
the manifest rather than a mutable branch name, and REFUSE a zero-byte capture
whose integrity check failed instead of grading it as "the arm produced nothing".

**2. `jsonpickle__jsonpickle-588` — a stall detector counting non-evidence.**
Both attempts' test tails were `2 errors in 0.21s` — a *collection* error from a
2-line syntax error, i.e. the suite never ran. Identical text, so
`same_failure_signature` fired at 2 against a cap of 4 and blocked the story
terminally with two retries unused. `solo-noreview` solved the same instance.

Measured over all 61 sweep-2 dev attempts: 8 red attempts carried no test
results, and they are exactly the losses — including `rapid-mlx-289` (x2) and
`vyper-4801` sharing ONE signature for
`sandbox run timed out ... retryable infrastructure failure`. Two consecutive
INFRA TIMEOUTS were being counted as the model failing the same way twice.

The cap is deliberately NOT raised — CLAUDE.md requires the early-escalation
guard to stay strictly below the hard cap. What changes is which attempts are
comparable.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from factory.chain.handlers import (
    _MAX_DEV_SAME_SIGNATURE,
    _consecutive_same_dev_signature,
    _max_dev_retries,
    _tail_shows_test_results,
)

_ADAPTER = Path(__file__).resolve().parents[1] / "bench" / "swebench_adapter.py"


@pytest.fixture
def A() -> Any:  # noqa: N802
    spec = importlib.util.spec_from_file_location("_swe_diff_capture", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _git(wt: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(wt), *args], capture_output=True, text=True, check=False
    ).stdout.strip()


def _repo(tmp_path: Path) -> tuple[Path, str]:
    """A repo with a ``swebench-base`` branch, exactly as the harness prepares it.
    Returns (worktree, base_commit_sha)."""
    wt = tmp_path / "repo"
    wt.mkdir()
    _git(wt, "init", "-q")
    _git(wt, "config", "user.email", "t@example.com")
    _git(wt, "config", "user.name", "t")
    (wt / "tox.schema.json").write_text('{"deps": {"type": "string"}}\n', encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "base")
    _git(wt, "branch", "swebench-base")
    return wt, _git(wt, "rev-parse", "HEAD")


# --------------------------------------------------------------------------- #
# 1 — diff capture integrity
# --------------------------------------------------------------------------- #


def test_a_clean_worktree_capture_is_trustworthy(A: Any, tmp_path: Path) -> None:  # noqa: N803
    wt, base = _repo(tmp_path)
    report = A.diff_capture_integrity(wt, expected_base_commit=base)
    assert report["base_ref_matches"] is True
    assert report["trustworthy"] is True
    assert report["head_is_base"] is True
    assert report["gitlink"] == "dir"


def test_a_moved_base_ref_is_reported_but_does_not_condemn_the_row(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The tox shape: the arm's commits landed ON the base ref. It is REPORTED —
    that is how you spot the corruption — but it is NOT the refusal predicate.

    Measured over 114 real prepared trees: 101 have ``swebench-base ==
    base_commit`` and 12 legitimately sit +1 ahead (``line-bot-981`` and
    ``pandas-63945``, on every arm, from the documented install-artifact commit).
    The 13th was ``tox-3931`` on the factory arm at +2. Refusing on "the ref
    moved" would have false-refused 12 healthy trees on 2 instances — and it
    does not need to, because the diff is recovered from the manifest sha."""
    wt, base = _repo(tmp_path)
    (wt / "tox.schema.json").write_text('{"deps": {"oneOf": []}}\n', encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "the fix, committed onto the base branch")
    _git(wt, "branch", "-f", "swebench-base", "HEAD")

    report = A.diff_capture_integrity(wt, expected_base_commit=base)
    assert report["base_ref_matches"] is False
    assert report["base_ref_ahead_of_expected"] == 1
    assert report["base_ref_sha"] != base
    # The manifest base is still IN the tree, so an honest diff is available and
    # the capture is trustworthy.
    assert report["expected_resolves"] is True
    assert report["trustworthy"] is True


def test_the_install_artifact_commit_is_not_treated_as_corruption(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """The 12 healthy trees. A harness-authored commit on top of the base is the
    documented preparation step, not tampering."""
    wt, base = _repo(tmp_path)
    (wt / "_version.py").write_text('__version__ = "1.2.3"\n', encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "harness: commit generated build artifacts")
    _git(wt, "branch", "-f", "swebench-base", "HEAD")
    report = A.diff_capture_integrity(wt, expected_base_commit=base)
    assert report["base_ref_ahead_of_expected"] == 1
    assert report["trustworthy"] is True


def test_a_symlinked_gitlink_is_reported_untrustworthy(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """`mv .git .git.file && ln -s "$GIT_COMMON_DIR" .git` — verbatim what the
    dev ran on tox-3931."""
    wt, base = _repo(tmp_path)
    real = wt / ".git"
    moved = wt / ".git.file"
    real.rename(moved)
    (wt / ".git").symlink_to(moved, target_is_directory=True)
    report = A.diff_capture_integrity(wt, expected_base_commit=base)
    assert report["gitlink"] == "symlink"
    assert report["trustworthy"] is False


def test_capture_recovers_the_patch_a_moved_ref_would_have_hidden(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """THE tox reproduction. With the base ref moved onto the fix, diffing the
    branch name yields nothing; diffing the manifest's immutable sha yields the
    patch. This is the difference between `empty_patch` and a graded answer."""
    wt, base = _repo(tmp_path)
    (wt / "tox.schema.json").write_text('{"deps": {"oneOf": []}}\n', encoding="utf-8")
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "the fix")
    _git(wt, "branch", "-f", "swebench-base", "HEAD")

    # What today's code does: trust the branch name.
    assert _git(wt, "diff", "swebench-base") == "", "the ref really does hide it"

    integrity: dict[str, Any] = {}
    recovered = A._capture_diff(wt, expected_base_commit=base, integrity=integrity)
    assert "tox.schema.json" in recovered
    assert "oneOf" in recovered
    assert integrity["base_ref_matches"] is False, "and it still SAYS the ref moved"


def test_an_empty_capture_from_a_broken_tree_is_refused(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """Empty-and-untrustworthy must never be published as "the arm produced
    nothing". Refusing costs one re-run; a false zero cost a retraction."""
    wt, base = _repo(tmp_path)
    _git(wt, "branch", "-f", "swebench-base", "HEAD")
    integrity: dict[str, Any] = {}
    # A base commit that is not in this tree at all: there is no honest ref to
    # diff against, so a 0-byte result says nothing about the arm.
    raw = A._capture_diff(wt, expected_base_commit="0" * 40, integrity=integrity)
    assert raw.strip() == ""
    assert integrity["expected_resolves"] is False
    assert integrity["trustworthy"] is False
    with pytest.raises(A.DiffRefused, match="UNTRUSTWORTHY"):
        A._refuse_untrustworthy_empty_diff(raw, integrity)


def test_a_genuinely_empty_capture_is_still_a_real_outcome(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """The other half: an arm that really changed nothing must keep grading as
    `empty_patch`. Refusing that would hide a genuine result."""
    wt, base = _repo(tmp_path)
    integrity: dict[str, Any] = {}
    raw = A._capture_diff(wt, expected_base_commit=base, integrity=integrity)
    assert raw.strip() == ""
    assert integrity["trustworthy"] is True
    A._refuse_untrustworthy_empty_diff(raw, integrity)  # must NOT raise


def test_a_real_patch_from_a_suspect_tree_is_still_graded(A: Any) -> None:  # noqa: N803
    """Only the EMPTY case is refused. Bytes in hand are evidence regardless of
    how the ref looks, and refusing them would throw away the very patch this
    change exists to save."""
    A._refuse_untrustworthy_empty_diff(
        "diff --git a/x b/x\n+1\n", {"trustworthy": False, "gitlink": "symlink"}
    )


def test_an_unchecked_capture_is_not_treated_as_broken(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """A caller that passes no expected base commit gets today's behaviour, not a
    refusal: ``base_ref_matches`` is None ("not available"), which is different
    from False ("checked, and wrong")."""
    wt, _base = _repo(tmp_path)
    report = A.diff_capture_integrity(wt)
    assert report["base_ref_matches"] is None
    assert report["trustworthy"] is True


def test_every_capture_site_passes_the_manifest_base_commit(A: Any) -> None:  # noqa: N803
    """EVERY arm, or the fix reaches only the one that was debugged.

    DERIVED from the runner functions rather than pinned to a count. It was pinned
    at 4, which had two failure modes pointing opposite ways: adding an arm failed
    here even when that arm did it right, and — worse — an arm could have been added
    that captured a diff WITHOUT the expected base commit while the count still read
    4 because another site had two.

    So the property is asserted per runner: every function that captures a diff must
    pin it to the manifest's base commit, refuse an untrustworthy empty capture, and
    record the integrity report in its row.
    """
    import inspect

    src = inspect.getsource(A)
    runners = [
        name
        for name in dir(A)
        if name.startswith("run_")
        and inspect.isfunction(getattr(A, name))
        and "_capture_diff(" in inspect.getsource(getattr(A, name))
    ]
    assert len(runners) >= 5, f"expected every arm's runner, found {runners}"
    for name in runners:
        body = inspect.getsource(getattr(A, name))
        assert 'expected_base_commit=str(inst.get("base_commit") or "")' in body, name
        assert "_refuse_untrustworthy_empty_diff(raw_diff, diff_integrity)" in body, name
        assert '"diff_integrity": diff_integrity,' in body, name
    # And no capture site anywhere is left un-pinned.
    assert src.count("_capture_diff(") == src.count(
        'expected_base_commit=str(inst.get("base_commit") or "")'
    ) + 1, "a _capture_diff call site does not pass the manifest base commit"


# --------------------------------------------------------------------------- #
# 2 — the stall signature keys on evidence, not on text similarity
# --------------------------------------------------------------------------- #

# Verbatim from jsonpickle-588's attempt records in the sweep-2 run DB.
_JSONPICKLE_TAIL = (
    "ERROR tests/benchmark.py\nERROR tests/object_test.py\n"
    "!!!!!!!!!!!!!!!!!!! Interrupted: 2 errors during collection !!!!!!!!!!!!!!!!!!!!\n"
    "============================== 2 errors in 0.21s ===============================\n"
)
_INFRA_TAIL = (
    "sandbox run timed out after 1800s (likely a stalled LLM call); "
    "treating as retryable infrastructure failure"
)
_REAL_RED_TAIL = "FAILED tests/object_test.py::test_defaultdict\n1 failed, 27 passed in 3.21s\n"
_ANSI_GREEN_TAIL = (
    "============ \x1b[32m111 passed\x1b[0m\x1b[32m in 0.24s\x1b[0m ============\n"
)


def test_a_collection_error_is_not_test_evidence() -> None:
    assert _tail_shows_test_results(_JSONPICKLE_TAIL) is False


def test_an_infra_timeout_is_not_test_evidence() -> None:
    """`rapid-mlx-289` twice and `vyper-4801` once shared ONE signature for this
    text — the guard was counting infrastructure against the model."""
    assert _tail_shows_test_results(_INFRA_TAIL) is False


def test_a_real_red_run_is_test_evidence() -> None:
    assert _tail_shows_test_results(_REAL_RED_TAIL) is True


def test_a_bare_assertion_tail_is_test_evidence() -> None:
    """An existing test (`test_r2_identical_signature_escalates_before_full_budget`)
    caught the first cut of this rule: requiring the count line alone made the
    guard unreachable for a tail that is just the assertion. A test that ran and
    asserted IS evidence."""
    assert _tail_shows_test_results("AssertionError: expected 1 got 2 in test_widget") is True


def test_a_per_node_result_line_is_test_evidence() -> None:
    assert _tail_shows_test_results("FAILED tests/x.py::test_y - boom\n") is True


def test_ansi_colour_does_not_hide_the_summary_line() -> None:
    """pytest colourises the summary; a naive word-boundary match misses it, and
    four sweep-2 attempts have exactly this shape."""
    assert _tail_shows_test_results(_ANSI_GREEN_TAIL) is True


def test_empty_and_whitespace_tails_are_not_evidence() -> None:
    assert _tail_shows_test_results("") is False
    assert _tail_shows_test_results("   \n ") is False


def test_a_zero_count_summary_is_not_evidence() -> None:
    """"0 passed" proves nothing ran."""
    assert _tail_shows_test_results("0 passed in 0.01s") is False


def test_two_non_evidence_attempts_do_not_build_a_stall_streak() -> None:
    """The jsonpickle loss, end to end at the counting layer. An empty signature
    is already defined as "no comparable evidence yet" and returns 0 — so making
    the signature empty is the whole fix, and the cap needs no change."""
    attempts = [
        {"attempt": 1, "test_run_passed": False, "failure_signature": ""},
        {"attempt": 2, "test_run_passed": False, "failure_signature": ""},
    ]
    assert _consecutive_same_dev_signature(attempts, "") == 0


def test_a_genuine_repeated_assertion_failure_still_stalls() -> None:
    """The guard must keep firing on what it was built for: identical REAL test
    failures. Otherwise this fix trades one loss for an unbounded loop."""
    sig = "deadbeef" * 8
    attempts = [
        {"attempt": 1, "test_run_passed": False, "failure_signature": sig},
        {"attempt": 2, "test_run_passed": False, "failure_signature": sig},
    ]
    assert _consecutive_same_dev_signature(attempts, sig) >= _MAX_DEV_SAME_SIGNATURE


def test_the_early_escalation_guard_stays_below_the_hard_cap() -> None:
    """CLAUDE.md: "keep any early-escalation guard strictly below the hard cap or
    it becomes unreachable". The fix must not have raised it."""
    assert _MAX_DEV_SAME_SIGNATURE == 2
    assert _MAX_DEV_SAME_SIGNATURE < _max_dev_retries()


def test_the_attempt_record_stamps_whether_evidence_was_seen() -> None:
    """"No comparable evidence" must be distinguishable from "we forgot to stamp
    it" — an unstamped signature and a deliberately-empty one look identical
    otherwise."""
    import inspect

    from factory.chain import handlers

    src = inspect.getsource(handlers)
    assert 'attempt_record["test_results_seen"] = _tail_shows_test_results(_tail)' in src
    assert 'if attempt_record["test_results_seen"]' in src


# --------------------------------------------------------------------------- #
# 4 — the base ref cannot be moved by the agent
# --------------------------------------------------------------------------- #
#
# VERIFIED LIVE before this fix: in `hkuds__openharness-217__chain/repo`, the local
# `swebench-base` was the ADW's own build commit, 2 ahead of the real base
# (`origin/swebench-base`), and `diff_integrity` recorded `base_ref_matches: false`
# with `base_ref_ahead_of_expected: 3`. The clone left the tree CHECKED OUT ON
# `swebench-base` and the ADW committed onto it.
#
# The capture survived only because `_capture_diff` tries the manifest's immutable
# sha BEFORE the branch name — correctness by fallback ORDER, one reordered line
# from turning every sssf row into an empty patch. That is exactly how
# `tox-dev__tox-3931` lost a patch byte-identical to the winning one.


def _adw_commits(wt: Path) -> None:
    """What an ADW does to the tree: three commits and a dirty file, the shape
    ``_sssf_probe_tree`` documents for a real run (plan, build, docs) plus the
    uncommitted work the capture must also see."""
    for name, body in [
        ("specs/plan.md", "# the plan\n"),
        ("src/fix.py", "def fixed():\n    return 1\n"),
        ("app_docs/notes.md", "# notes\n"),
    ]:
        p = wt / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
        _git(wt, "add", "-A")
        _git(wt, "commit", "-q", "-m", f"adw: {name}")
    (wt / "src" / "fix.py").write_text(
        "def fixed():\n    return 1\n\n# and one uncommitted line\n", encoding="utf-8"
    )


def test_the_pin_leaves_the_base_ref_where_the_harness_put_it(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """After simulated ADW commits the base ref must STILL resolve to the base
    commit. This is the assertion that fails on the pre-fix topology."""
    wt, base = _repo(tmp_path)
    _git(wt, "checkout", "-q", "swebench-base")  # the pre-fix checkout
    A._pin_base_ref(wt)
    _adw_commits(wt)

    assert _git(wt, "rev-parse", A._BASE_BRANCH) == base, (
        "the agent's commits moved swebench-base — the shadowing bug is back"
    )
    assert _git(wt, "rev-parse", A._BASE_TAG) == base, "the immutable tag moved"
    assert _git(wt, "rev-parse", f"refs/remotes/origin/{A._BASE_BRANCH}") == base
    # HEAD moved, on its own branch, which is the mechanism: commits land on HEAD's
    # branch, so work belongs anywhere except the base.
    assert _git(wt, "rev-parse", "HEAD") != base
    assert _git(wt, "symbolic-ref", "--short", "HEAD") == A._WORK_BRANCH


def test_the_pin_makes_the_integrity_report_come_back_clean(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """``base_ref_matches: false`` and ``base_ref_ahead_of_expected: 3`` was the
    live symptom. After the pin the report is honest about a healthy tree, and it
    SAYS the pin is in place — so a future row where the pin did not take is
    distinguishable from one where it did."""
    wt, base = _repo(tmp_path)
    A._pin_base_ref(wt)
    _adw_commits(wt)

    report = A.diff_capture_integrity(wt, expected_base_commit=base)
    assert report["base_ref_matches"] is True
    assert report["base_ref_ahead_of_expected"] == 0
    assert report["base_ref_pinned"] is True
    assert report["base_ref_pinned_sha"] == base
    assert report["head_branch"] == A._WORK_BRANCH
    assert report["head_is_base"] is False, "the ADW really did commit"
    assert report["trustworthy"] is True


def test_the_captured_diff_is_unchanged_by_the_pin(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """The pin must not alter what is measured — only what can move. Same tree,
    same edits, pre-fix topology vs pinned: byte-identical diffs."""
    def capture(pinned: bool) -> str:
        root = tmp_path / ("pinned" if pinned else "shadowed")
        root.mkdir()
        wt, base = _repo(root)
        _git(wt, "checkout", "-q", "swebench-base")
        if pinned:
            A._pin_base_ref(wt)
        _adw_commits(wt)
        return A._capture_diff(wt, expected_base_commit=base)

    shadowed = capture(False)
    pinned = capture(True)
    assert "def fixed()" in pinned and "uncommitted line" in pinned
    assert pinned == shadowed, "the pin changed the measurement, not just the refs"


def test_the_pinned_tag_saves_the_capture_when_the_sha_is_not_passed(
    A: Any, tmp_path: Path  # noqa: N803
) -> None:
    """DEFENCE IN DEPTH, and the case that proves the tag earns its place. With no
    ``expected_base_commit`` the old code fell through to the movable branch NAME —
    which under the pre-fix topology contained the fix and returned zero bytes.
    The tag is not movable by ``git commit``, so the patch is still found.
    """
    wt, _base = _repo(tmp_path)
    _git(wt, "checkout", "-q", "swebench-base")
    A._pin_base_ref(wt)
    _adw_commits(wt)
    # Commit the leftover dirty file too, so what follows is about the REFS and
    # not about an unstaged edit that every ref would show.
    _git(wt, "add", "-A")
    _git(wt, "commit", "-q", "-m", "adw: the rest")
    # Simulate the tox-3931 corruption on top: force the base BRANCH forward, as
    # the docker gitlink tampering did. The tag is untouched.
    _git(wt, "branch", "-f", A._BASE_BRANCH, "HEAD")
    assert _git(wt, "diff", A._BASE_BRANCH) == "", "the branch really does hide it"

    raw = A._capture_diff(wt)  # NO expected sha — branch name would be the target
    assert "def fixed()" in raw, "the pinned tag must recover the patch"


def test_the_pin_runs_for_every_prepared_tree_and_is_idempotent(
    A: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """``grade`` re-clones and re-prepares the same instance, so the pin has to
    converge rather than fail on "tag already exists". And it must be the LAST
    thing ``_prepare_cloned_tree`` does — everything above it legitimately commits
    (submodule vendoring, install artifacts), and everything after must not be
    able to."""
    wt, base = _repo(tmp_path)
    A._pin_base_ref(wt)
    A._pin_base_ref(wt)
    assert _git(wt, "rev-parse", A._BASE_TAG) == base

    import ast

    src = _ADAPTER.read_text(encoding="utf-8")
    fn = next(
        n for n in ast.parse(src).body
        if isinstance(n, ast.FunctionDef) and n.name == "_prepare_cloned_tree"
    )
    calls = [
        n.func.id for n in ast.walk(fn)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
    ]
    assert calls == ["_run_install_step", "_pin_base_ref"], (
        "the pin must run after the install commit, for BOTH profiles — the "
        f"shadowing bug is a property of the checkout, not the dataset; got {calls}"
    )


def test_a_broken_tree_is_reported_not_crashed(A: Any, tmp_path: Path) -> None:  # noqa: N803
    """A tree whose git plumbing is too broken to accept the pin is one
    ``diff_capture_integrity`` will refuse anyway. Raising here would turn a
    reportable capture problem into a crashed run."""
    not_a_repo = tmp_path / "nope"
    not_a_repo.mkdir()
    A._pin_base_ref(not_a_repo)  # must not raise
    assert A.diff_capture_integrity(not_a_repo)["trustworthy"] is False
