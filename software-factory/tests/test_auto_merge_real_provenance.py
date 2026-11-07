"""Tests for the real-provenance fix (019 blocker S1).

Before this fix, ``auto_merge_tick``'s local-fixture synthesis (the path the
orchestrator's ticks use — no ``github_client``) ALWAYS built
``head_sha=f"local-{story.id}"`` and ``files_changed=[]``, whether or not a
real PR existed. That made the acceptance-oracle provenance check (which is
deliberately NEVER waivable) block every real-run story forever — "local-7"
can never match ``red_green._SHA_RE`` — and made ``tests-meaningful`` /
``canonical-paths-only`` pass VACUOUSLY (nothing in an empty file list to
scan). These tests pin: (1) a real PR number resolves a real head sha and
file list via ``gh``, (2) a resolution failure falls back to the honest
placeholder rather than fabricating a sha, and (3) the shape a real sha
produces no longer trips the provenance gate's "not a commit id" branch.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from sqlmodel import Session, create_engine, select

from factory.chain import auto_merge as am
from factory.chain import red_green
from factory.chain.gates import production_tree_changed
from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState

_REAL_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: o/r\n", encoding="utf-8")
    (tmp_path / "state").mkdir()
    return tmp_path


def _cfg() -> am.AppConfig:
    return am.AppConfig(name="sacrifice", repo="o/r")


# --------------------------------------------------------------------------- #
# The two new gh-backed resolvers, in isolation (mocked subprocess, no network)
# --------------------------------------------------------------------------- #


def test_query_pr_head_sha_returns_real_sha(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_run(cmd: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
        assert cmd[:3] == ["gh", "pr", "view"]
        return subprocess.CompletedProcess(cmd, 0, stdout=f"{_REAL_SHA}\n", stderr="")

    monkeypatch.setattr(subprocess, "run", _fake_run)
    sha = am._query_pr_head_sha(app_config=_cfg(), pr_number=42)
    assert sha == _REAL_SHA


def test_query_pr_head_sha_returns_none_on_gh_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_run(cmd: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="not found")

    monkeypatch.setattr(subprocess, "run", _fake_run)
    assert am._query_pr_head_sha(app_config=_cfg(), pr_number=42) is None


def test_query_pr_head_sha_never_returns_a_malformed_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """gh exits 0 but prints garbage — must not be handed back as if real."""

    def _fake_run(cmd: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, 0, stdout="null\n", stderr="")

    monkeypatch.setattr(subprocess, "run", _fake_run)
    assert am._query_pr_head_sha(app_config=_cfg(), pr_number=42) is None


def test_query_pr_head_sha_placeholder_pr_never_queries_gh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*_a: object, **_k: object) -> None:
        raise AssertionError("must not shell out for a placeholder PR number")

    monkeypatch.setattr(subprocess, "run", _boom)
    assert am._query_pr_head_sha(app_config=_cfg(), pr_number=-7) is None


def test_query_pr_files_changed_returns_real_files(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_run(cmd: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
        assert cmd[:3] == ["gh", "pr", "view"]
        return subprocess.CompletedProcess(cmd, 0, stdout="src/foo.py\ntests/test_foo.py\n", stderr="")

    monkeypatch.setattr(subprocess, "run", _fake_run)
    files = am._query_pr_files_changed(app_config=_cfg(), pr_number=42)
    assert files == ["src/foo.py", "tests/test_foo.py"]


def test_query_pr_files_changed_returns_none_on_gh_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _fake_run(cmd: list[str], **kw: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="not found")

    monkeypatch.setattr(subprocess, "run", _fake_run)
    assert am._query_pr_files_changed(app_config=_cfg(), pr_number=42) is None


# --------------------------------------------------------------------------- #
# Wiring: the tick-path fixture-synthesis loop uses the resolvers
# --------------------------------------------------------------------------- #


def _pr_open_story(db: Path, *, pr_number: int = 42) -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id="019",
            app="sacrifice",
            title="t",
            slug="s",
            scope="backend",
            state=StoryState.PR_OPEN.value,
            github_pr_number=pr_number,
            # No tech_writer record -> docs-current gate fails -> missing
            # gate labels -> the tick never reaches an actual `gh pr merge`,
            # so this test never risks a real merge shell-out.
        ),
        db,
    )


def test_synthesis_branch_populates_real_head_sha_and_files(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = factory_root / "state" / "factory.db"
    story = _pr_open_story(db)

    monkeypatch.setattr(am, "_query_pr_head_sha", lambda **kw: _REAL_SHA)
    monkeypatch.setattr(am, "_query_pr_files_changed", lambda **kw: ["src/foo.py"])
    monkeypatch.setattr(am, "_query_ci_state", lambda **kw: None)

    actions = am.auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        db_path=db,
        pr_merged_query=lambda **kw: False,
    )
    assert len(actions) == 1
    assert not actions[0].merged  # docs-current missing -> blocked, never merges

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(am.MergeActionRecord)).all()
    assert len(rows) == 1
    assert rows[0].head_sha == _REAL_SHA
    assert not rows[0].head_sha.startswith("local-")
    assert story.id is not None


def test_synthesis_branch_falls_back_to_placeholder_when_gh_unresolvable(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """gh fails to resolve the sha — the fixture must carry the HONEST
    ``local-<id>`` placeholder, never a fabricated hex string."""
    db = factory_root / "state" / "factory.db"
    story = _pr_open_story(db)

    monkeypatch.setattr(am, "_query_pr_head_sha", lambda **kw: None)
    monkeypatch.setattr(am, "_query_pr_files_changed", lambda **kw: None)
    monkeypatch.setattr(am, "_query_ci_state", lambda **kw: None)
    # ``production-tree-changed`` falls back to a `gh pr diff` call of its own
    # when files_changed/repo_root are both empty; keep this test off the
    # network too.
    monkeypatch.setattr(
        production_tree_changed, "_gh_changed_paths", lambda *a, **k: (None, "mocked: unresolved")
    )

    am.auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=False,
        db_path=db,
        pr_merged_query=lambda **kw: False,
    )

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(am.MergeActionRecord)).all()
    assert len(rows) == 1
    assert rows[0].head_sha == f"local-{story.id}"


def test_synthesis_branch_placeholder_pr_number_is_unaffected(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No real PR at all (docs-chain-style placeholder) must never call gh and
    must keep the exact historical ``local-<id>`` shape."""

    def _boom(**_kw: object) -> None:
        raise AssertionError("must not query gh for a placeholder (no-PR) story")

    monkeypatch.setattr(am, "_query_pr_head_sha", _boom)
    monkeypatch.setattr(am, "_query_pr_files_changed", _boom)
    monkeypatch.setattr(am, "_query_ci_state", lambda **kw: None)

    db = factory_root / "state" / "factory.db"
    story = persist_story(
        StoryRecord(
            direction_id="019",
            app="sacrifice",
            title="t",
            slug="no-pr",
            scope="backend",
            state=StoryState.PR_OPEN.value,
            github_pr_number=None,
        ),
        db,
    )

    am.auto_merge_tick(factory_root, "sacrifice", dry_run=False, db_path=db)

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(am.MergeActionRecord)).all()
    assert len(rows) == 1
    assert rows[0].head_sha == f"local-{story.id}"


# --------------------------------------------------------------------------- #
# The consumer side: a real-shaped sha no longer fails PROVENANCE ON SHAPE
# --------------------------------------------------------------------------- #


def test_real_shaped_sha_no_longer_fails_on_shape(tmp_path: Path) -> None:
    """``head_contains_sha``'s first branch rejects anything that doesn't even
    LOOK like a commit id (the ``local-<id>`` placeholder's exact failure
    mode). A real 40-hex sha must clear that branch — even one this tiny repo
    has never seen — and fail LATER, honestly, as "unknown to the checkout"
    rather than "not a commit id"."""
    import subprocess as sp

    def git(*args: str) -> None:
        sp.run(["git", *args], cwd=str(tmp_path), check=True, capture_output=True)

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    git("add", "-A")
    git("commit", "-qm", "base")

    # The historical placeholder — fails on SHAPE.
    contains, why = red_green.head_contains_sha(tmp_path, "local-7")
    assert contains is None
    assert "is not a commit id" in why

    # A real-shaped sha this repo has never seen — clears the shape check and
    # fails on a DIFFERENT, honest ground.
    contains2, why2 = red_green.head_contains_sha(tmp_path, _REAL_SHA)
    assert contains2 is None
    assert "is not a commit id" not in why2
    assert "unknown to the checkout" in why2
