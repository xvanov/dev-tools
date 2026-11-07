"""Tests for the WS1.2 independent acceptance oracle (019 AC3: out-of-process).

Covers the four properties the design promises:

  (a) the acceptance gate PASSES when delivered code satisfies the ACs and
      FAILS when it violates one — EVEN when the dev's own suite is green (the
      core anti-reward-hack case) — now exercised through a BOOTED app over
      HTTP rather than an in-process import;
  (b) the authored acceptance test lands OUTSIDE the dev worktree (independence);
  (c) the gate + required-wiring are per-app opt-in (off by default) — untouched
      by 019 AC3, since none of these paths reach a boot;
  (d) dry-run / no-ref / missing-file are non-authoritative, never a false pass.
"""

from __future__ import annotations

from pathlib import Path

from factory.app_config import AppConfig, AppGatesConfig
from factory.chain.acceptance import (
    _AUTHOR_ATTEMPTS,
    acceptance_dir,
    author_acceptance_test,
    build_spec_prompt,
)
from factory.chain.gates import acceptance_verified
from factory.chain.gates.evaluator import (
    ALL_GATE_LABELS,
    LOOP4_REQUIRED_GATE_LABELS,
    PRContext,
    required_gate_labels,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.chain.worktree import ensure_worktree_for_story, worktree_path
from factory.directions.parser import Direction
from tests.oracle_boot_fixture import BAD_IMPL, GOOD_IMPL, HTTP_ORACLE, boot_cfg, write_bootable_app
from tests.oracle_repo import commit_all, init_repo

# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #


def _story(
    *, story_id: int | None = 7, ref: str | None = None, expected: bool = True
) -> StoryRecord:
    s = StoryRecord(
        id=story_id,
        direction_id="002",
        app="sacrifice",
        title="lowercase the email",
        slug="lowercase-email",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        acceptance_test_ref=ref,
        acceptance_expected=expected,
    )
    return s


def _direction(tmp_path: Path, acceptance: list[str]) -> Direction:
    d = tmp_path / "dir"
    d.mkdir(parents=True, exist_ok=True)
    return Direction(
        id="002",
        slug="emails",
        title="Email handling",
        type_tag=None,
        why=None,
        has_flow=False,
        has_api_spec=False,
        acceptance=acceptance,
        explore_tag=False,
        artifacts_paths=[],
        app="sacrifice",
        status="pm-validated",
        raw_frontmatter={},
        raw_body="",
        dir_path=d,
    )


def _oracle_cfg(*, on: bool = True, boot=None) -> AppConfig:
    return AppConfig(
        name="sacrifice",
        repo="o/r",
        gates=AppGatesConfig(acceptance_oracle=on, acceptance_boot=boot),
    )


# The acceptance test the oracle would author from a spec like
# "the app lowercases the email before storing it". Behavioral, blind to impl,
# driven over HTTP (019 AC3) against a real booted instance.
_ACCEPTANCE_TEST_SRC = HTTP_ORACLE


def _make_app_checkout(repo_root: Path, *, correct: bool) -> tuple[str, str]:
    """A real, bootable app checkout, as a git branch off a base commit.

    ``correct`` decides whether HEAD satisfies the acceptance criterion. The
    BASE commit is always the buggy implementation (PLAN A.6: "the oracle
    passes now" is only evidence if "the oracle failed before" is also true).
    Returns ``(base_sha, head_sha)``.
    """
    init_repo(repo_root)
    write_bootable_app(repo_root, impl=BAD_IMPL)
    base_sha = commit_all(repo_root, "base")
    import subprocess

    subprocess.run(["git", "checkout", "-q", "-b", "feat/story"], cwd=repo_root, check=True)
    write_bootable_app(repo_root, impl=GOOD_IMPL if correct else BAD_IMPL)
    (repo_root / "backend" / "app" / "story_marker.py").write_text("MARKER = 1\n", encoding="utf-8")
    head_sha = commit_all(repo_root, "story work")
    return base_sha, head_sha


# --------------------------------------------------------------------------- #
# (a) core anti-reward-hack: oracle catches a spec violation over HTTP
# --------------------------------------------------------------------------- #


def test_gate_passes_when_code_satisfies_acs(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    base_sha, head_sha = _make_app_checkout(repo, correct=True)
    root = tmp_path / "factory"
    ref = _write_stored_oracle(root, story_id=7)

    pr = PRContext(
        pr_number=1,
        head_sha=head_sha,
        base_branch="main",
        story=_story(story_id=7, ref=ref),
        repo_root=repo,
        software_factory_root=root,
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True, boot=boot_cfg()))
    assert r.passed, r.reason
    assert r.details["authoritative"] is True
    # ...and the pass is EVIDENCED: red at the merge base, green at HEAD.
    assert r.details["verified"] is True
    assert r.details["base_run"]["status"] == "fail"
    assert r.details["base_sha"] == base_sha[:12]


def test_gate_fails_on_ac_violation_even_when_dev_tests_green(tmp_path: Path) -> None:
    """The whole point: a violating implementation is caught by the
    independent oracle driving the REAL booted app, regardless of what the
    dev's own (unrelated) test suite says."""
    repo = tmp_path / "repo"
    _base_sha, head_sha = _make_app_checkout(repo, correct=False)

    root = tmp_path / "factory"
    ref = _write_stored_oracle(root, story_id=7)
    pr = PRContext(
        pr_number=1,
        head_sha=head_sha,
        base_branch="main",
        story=_story(story_id=7, ref=ref),
        repo_root=repo,
        software_factory_root=root,
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True, boot=boot_cfg()))
    assert not r.passed, "oracle must fail when an AC is violated"
    assert r.details["authoritative"] is True
    # And nothing was ever copied into the dev's checkout at all.
    assert not any(p.name.startswith("test_acceptance_oracle_") for p in repo.rglob("*"))


def _write_stored_oracle(root: Path, *, story_id: int) -> str:
    out_dir = acceptance_dir(root, "sacrifice", story_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "test_acceptance.py").write_text(_ACCEPTANCE_TEST_SRC, encoding="utf-8")
    return str((out_dir / "test_acceptance.py").relative_to(root))


# --------------------------------------------------------------------------- #
# (b) independence: authored oracle is NOT in the dev worktree
# --------------------------------------------------------------------------- #


def _git(cwd: Path, *args: str) -> None:
    import subprocess

    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_authored_oracle_not_in_dev_worktree(tmp_path: Path) -> None:
    """The dev sandbox runs against a per-story worktree of the APP repo under
    state/worktrees/. The authored oracle lands under state/acceptance/ — a
    sibling tree the worktree never contains."""
    src = tmp_path / "app"
    src.mkdir()
    _git(src, "init", "-b", "main")
    _git(src, "config", "user.email", "t@t")
    _git(src, "config", "user.name", "t")
    (src / "README.md").write_text("app\n", encoding="utf-8")
    _git(src, "add", "-A")
    _git(src, "commit", "-m", "init")

    root = tmp_path / "factory"
    root.mkdir()
    story = _story(story_id=7)

    direction = _direction(tmp_path, ["the email is lowercased before storing"])
    ref = author_acceptance_test(
        story,
        direction,
        _oracle_cfg(on=True),
        root,
        dry_run=False,
        db_path=root / "state" / "factory.db",
        author_fn=lambda _spec, _s: _ACCEPTANCE_TEST_SRC,
    )
    assert ref is not None
    stored = root / ref
    assert stored.exists()

    wt = ensure_worktree_for_story(
        src, software_factory_root=root, app="sacrifice", story_id=7,
        slug="lowercase-email", base_branch="main",
    )

    assert wt == worktree_path(root, "sacrifice", 7, "lowercase-email")
    worktree_files = {p.name for p in wt.rglob("*") if p.is_file()}
    assert "test_acceptance.py" not in worktree_files
    assert not any("acceptance" in name for name in worktree_files)
    assert "state/acceptance/" in stored.as_posix()
    assert "worktrees" not in stored.relative_to(root).as_posix()


def test_spec_prompt_is_spec_only(tmp_path: Path) -> None:
    story = _story()
    direction = _direction(tmp_path, ["returns 404 when the goal is missing"])
    prompt = build_spec_prompt(story, direction)
    assert "returns 404 when the goal is missing" in prompt
    assert "Acceptance criteria" in prompt
    assert "def " not in prompt


def test_spec_prompt_is_always_example_mode(tmp_path: Path) -> None:
    """``build_spec_prompt`` is example-mode only (019 AC5 deleted EARS/ears.py).

    Even an EARS-shaped acceptance criterion (``WHEN ... THE ... SHALL ...``)
    gets no property-mode / Hypothesis section — the criteria appear verbatim
    and that's the whole prompt body.
    """
    story = _story()
    direction = _direction(
        tmp_path,
        ["WHEN the goal is missing, THE api SHALL return 404"],
    )
    prompt = build_spec_prompt(story, direction)
    assert "WHEN the goal is missing, THE api SHALL return 404" in prompt
    assert "Property-based testing mode" not in prompt
    assert "Hypothesis" not in prompt
    assert "EARS" not in prompt


def test_spec_prompt_gains_the_http_mode_block_when_boot_is_configured(tmp_path: Path) -> None:
    story = _story()
    direction = _direction(tmp_path, ["returns 404 when the goal is missing"])
    without_boot = build_spec_prompt(story, direction, boot=None)
    assert "ACCEPTANCE_BASE_URL" not in without_boot

    with_boot = build_spec_prompt(story, direction, boot=boot_cfg())
    assert "ACCEPTANCE_BASE_URL" in with_boot
    assert "httpx" in with_boot
    # still spec-only: the AC is verbatim, no implementation channel exists.
    assert "returns 404 when the goal is missing" in with_boot
    assert "def " not in with_boot


# --------------------------------------------------------------------------- #
# (c) per-app opt-in (off by default)
# --------------------------------------------------------------------------- #


def test_gate_skips_when_not_opted_in(tmp_path: Path) -> None:
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(ref="state/acceptance/sacrifice/7/test_acceptance.py"),
        software_factory_root=tmp_path,
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=False))
    assert r.passed and "not enabled" in r.reason
    assert r.details["acceptance_oracle"] is False


def test_acceptance_verified_label_present_in_all_gates() -> None:
    assert "acceptance-verified" in ALL_GATE_LABELS


def test_not_required_without_opt_in() -> None:
    story = _story(ref="state/acceptance/sacrifice/7/test_acceptance.py")
    assert required_gate_labels(_oracle_cfg(on=False), story) == LOOP4_REQUIRED_GATE_LABELS
    assert "acceptance-verified" not in required_gate_labels(_oracle_cfg(on=False), story)


def test_required_for_every_story_once_opted_in() -> None:
    story = _story(ref=None, expected=False)
    labels = required_gate_labels(_oracle_cfg(on=True), story)
    assert "acceptance-verified" in labels


def test_required_when_expected_even_if_authoring_failed() -> None:
    story = _story(ref=None, expected=True)
    labels = required_gate_labels(_oracle_cfg(on=True), story)
    assert "acceptance-verified" in labels


def test_required_when_opted_in_and_ref_present() -> None:
    story = _story(ref="state/acceptance/sacrifice/7/test_acceptance.py")
    labels = required_gate_labels(_oracle_cfg(on=True), story)
    assert "acceptance-verified" in labels
    for base in LOOP4_REQUIRED_GATE_LABELS:
        assert base in labels


def test_required_without_story_too() -> None:
    assert "acceptance-verified" in required_gate_labels(_oracle_cfg(on=True))


# --------------------------------------------------------------------------- #
# (d) non-authoritative, never a false pass
# --------------------------------------------------------------------------- #


def test_dry_run_is_non_authoritative(tmp_path: Path) -> None:
    ref = _write_stored_oracle(tmp_path, story_id=7)
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(story_id=7, ref=ref),
        software_factory_root=tmp_path,
        repo_root=None,
        dry_run=True,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True))
    assert not r.passed
    assert r.details["authoritative"] is False


def test_opted_in_expected_no_ref_blocks_authoritatively(tmp_path: Path) -> None:
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(ref=None, expected=True),
        software_factory_root=tmp_path,
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True))
    assert not r.passed
    assert r.details["authoritative"] is True
    assert "EXPECTED but not available" in r.reason


def test_opted_in_not_expected_no_ref_is_skip(tmp_path: Path) -> None:
    write_direction_on_disk(tmp_path, app="sacrifice", direction_id="002", acceptance=[])
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(ref=None, expected=False),
        software_factory_root=tmp_path,
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True))
    assert r.passed
    assert r.details["acceptance_expected"] is False
    assert r.details["expected_source"] == "no_acceptance_criteria"


def write_direction_on_disk(
    root: Path, *, app: str, direction_id: str, acceptance: list[str]
) -> Path:
    ddir = root / "apps" / app / "directions" / f"{direction_id}-emails"
    ddir.mkdir(parents=True, exist_ok=True)
    ac_block = (
        "\n## Acceptance Criteria\n\n" + "\n".join(f"- {a}" for a in acceptance) + "\n"
        if acceptance
        else ""
    )
    (ddir / "direction.md").write_text(
        f"---\ntitle: emails\n---\n\n# emails\n\n## Why\n\nx.\n{ac_block}",
        encoding="utf-8",
    )
    return ddir


def test_opted_in_flagless_story_with_acs_on_disk_still_blocks(tmp_path: Path) -> None:
    write_direction_on_disk(
        tmp_path, app="sacrifice", direction_id="002", acceptance=["the email is lowercased"]
    )
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(ref=None, expected=False),
        software_factory_root=tmp_path,
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True))
    assert not r.passed
    assert r.details["authoritative"] is True
    assert r.details["expected_source"] == "spec"


def test_opted_in_unresolvable_direction_blocks(tmp_path: Path) -> None:
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(ref=None, expected=False),
        software_factory_root=tmp_path,
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True))
    assert not r.passed
    assert r.details["expected_source"] == "direction_unresolvable"


def test_opted_in_without_story_record_blocks(tmp_path: Path) -> None:
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=None,
        software_factory_root=tmp_path,
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True))
    assert not r.passed
    assert r.details["expected_source"] == "no_story_record"


def test_missing_stored_file_expected_blocks_authoritatively(tmp_path: Path) -> None:
    pr = PRContext(
        pr_number=1,
        head_sha="a",
        base_branch="main",
        story=_story(
            ref="state/acceptance/sacrifice/7/test_acceptance.py", expected=True
        ),
        software_factory_root=tmp_path,
        repo_root=tmp_path / "repo",
        dry_run=False,
    )
    r = acceptance_verified.evaluate(pr, _oracle_cfg(on=True))
    assert not r.passed
    assert r.details["authoritative"] is True


# --------------------------------------------------------------------------- #
# authoring guards
# --------------------------------------------------------------------------- #


def test_author_returns_none_when_not_opted_in(tmp_path: Path) -> None:
    story = _story()
    direction = _direction(tmp_path, ["some AC"])
    ref = author_acceptance_test(
        story, direction, _oracle_cfg(on=False), tmp_path,
        author_fn=lambda _s, _st: _ACCEPTANCE_TEST_SRC,
    )
    assert ref is None
    assert story.acceptance_test_ref is None
    assert story.acceptance_expected is False


def test_author_returns_none_without_acceptance_criteria(tmp_path: Path) -> None:
    story = _story()
    direction = _direction(tmp_path, [])
    ref = author_acceptance_test(
        story, direction, _oracle_cfg(on=True), tmp_path,
        author_fn=lambda _s, _st: _ACCEPTANCE_TEST_SRC,
    )
    assert ref is None
    assert story.acceptance_expected is False


def test_author_skips_llm_in_dry_run_but_sets_expected(tmp_path: Path) -> None:
    story = _story()
    direction = _direction(tmp_path, ["some AC"])
    calls: list[str] = []

    def _fake(_spec: str, _st: StoryRecord) -> str:
        calls.append("called")
        return _ACCEPTANCE_TEST_SRC

    ref = author_acceptance_test(
        story, direction, _oracle_cfg(on=True), tmp_path,
        dry_run=True, author_fn=_fake,
    )
    assert ref is None
    assert calls == []
    assert story.acceptance_expected is True


def test_author_writes_outside_repo_and_sets_ref(tmp_path: Path) -> None:
    story = _story(story_id=42)
    direction = _direction(tmp_path, ["the email is lowercased"])
    root = tmp_path / "factory"
    ref = author_acceptance_test(
        story, direction, _oracle_cfg(on=True), root,
        dry_run=False, db_path=root / "state" / "factory.db",
        author_fn=lambda _s, _st: _ACCEPTANCE_TEST_SRC,
    )
    assert ref == story.acceptance_test_ref
    assert story.acceptance_expected is True
    assert (root / ref).read_text() == _ACCEPTANCE_TEST_SRC
    assert ref.startswith("state/acceptance/sacrifice/42/")


# --------------------------------------------------------------------------- #
# self-heal: authoring failure blocks (not silent-pass) AND eventually recovers
# --------------------------------------------------------------------------- #


def test_author_sets_expected_true_even_when_authoring_raises(tmp_path: Path) -> None:
    story = _story(story_id=9)
    direction = _direction(tmp_path, ["the email is lowercased"])
    root = tmp_path / "factory"

    def _boom(_spec: str, _st: StoryRecord) -> str:
        raise RuntimeError("transient LLM error")

    ref = author_acceptance_test(
        story, direction, _oracle_cfg(on=True), root,
        dry_run=False, db_path=root / "state" / "factory.db", author_fn=_boom,
    )
    assert ref is None
    assert story.acceptance_test_ref is None
    assert story.acceptance_expected is True


def test_author_retries_transient_failure(tmp_path: Path) -> None:
    story = _story(story_id=11)
    direction = _direction(tmp_path, ["the email is lowercased"])
    root = tmp_path / "factory"
    attempts = {"n": 0}

    def _flaky(_spec: str, _st: StoryRecord) -> str:
        attempts["n"] += 1
        if attempts["n"] < _AUTHOR_ATTEMPTS:
            raise RuntimeError("flaky")
        return _ACCEPTANCE_TEST_SRC

    ref = author_acceptance_test(
        story, direction, _oracle_cfg(on=True), root,
        dry_run=False, db_path=root / "state" / "factory.db", author_fn=_flaky,
    )
    assert ref is not None
    assert attempts["n"] == _AUTHOR_ATTEMPTS


def test_gate_blocks_then_passes_after_reauthor(tmp_path: Path) -> None:
    """Requirement 7: expected+missing → gate BLOCKS authoritatively; after a
    (spec-only) re-author writes the oracle, the same gate PASSES."""
    repo = tmp_path / "repo"
    _base_sha, head_sha = _make_app_checkout(repo, correct=True)
    root = tmp_path / "factory"

    story = _story(story_id=7, ref=None, expected=True)
    pr = PRContext(
        pr_number=1, head_sha=head_sha, base_branch="main",
        story=story, repo_root=repo, software_factory_root=root, dry_run=False,
    )
    r_blocked = acceptance_verified.evaluate(pr, _oracle_cfg(on=True, boot=boot_cfg()))
    assert not r_blocked.passed and r_blocked.details["authoritative"] is True

    direction = _direction(tmp_path, ["the email is lowercased"])
    ref = author_acceptance_test(
        story, direction, _oracle_cfg(on=True, boot=boot_cfg()), root,
        dry_run=False, db_path=root / "state" / "factory.db",
        author_fn=lambda _s, _st: _ACCEPTANCE_TEST_SRC,
    )
    assert ref is not None

    r_ok = acceptance_verified.evaluate(pr, _oracle_cfg(on=True, boot=boot_cfg()))
    assert r_ok.passed and r_ok.details["authoritative"] is True


def test_reauthor_sweep_heals_missing_oracle(tmp_path: Path) -> None:
    from factory.chain.acceptance import reauthor_missing_oracles
    from factory.chain.handlers import get_story, persist_story

    root = tmp_path
    (root / "state").mkdir(parents=True, exist_ok=True)
    (root / "apps" / "sacrifice").mkdir(parents=True, exist_ok=True)
    (root / "apps" / "sacrifice" / "config.yaml").write_text(
        "name: sacrifice\nrepo: o/r\ngates:\n  acceptance_oracle: true\n",
        encoding="utf-8",
    )
    ddir = root / "apps" / "sacrifice" / "directions" / "002-emails"
    ddir.mkdir(parents=True, exist_ok=True)
    (ddir / "direction.md").write_text(
        "---\ntitle: emails\n---\n\n# emails\n\n## Why\n\nx.\n\n"
        "## Acceptance Criteria\n\n- the email is lowercased\n",
        encoding="utf-8",
    )
    db = root / "state" / "factory.db"
    story = persist_story(
        _story(story_id=None, ref=None, expected=True), db
    )

    healed = reauthor_missing_oracles(
        "sacrifice", root, dry_run=False, db_path=db,
        author_fn=lambda _s, _st: _ACCEPTANCE_TEST_SRC,
    )
    assert healed == 1
    refreshed = get_story(story.id, db)
    assert refreshed is not None
    assert refreshed.acceptance_test_ref is not None
    assert (root / refreshed.acceptance_test_ref).read_text() == _ACCEPTANCE_TEST_SRC

    assert reauthor_missing_oracles(
        "sacrifice", root, dry_run=False, db_path=db,
        author_fn=lambda _s, _st: _ACCEPTANCE_TEST_SRC,
    ) == 0
