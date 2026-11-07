"""Post-merge context auto-refresh — fires after auto_merge_tick lands a PR.

Spec:
  * After a successful merge, a refresh runs on a side worktree off
    ``origin/main`` (or local ``main`` if no remote).
  * It touches ``context/project.md`` / ``context/navigation.md`` /
    ``context/current-state.md`` (only those that exist) and the
    ``context/modules/<scope>.md`` matching the merged story's scope.
  * Commits on ``factory/context-refresh-<ts>`` and opens a PR labeled
    ``context-refresh``.
  * Failures must NEVER take down the merge worker.
  * No-op when the refresh produces no diff (idempotent).

Tests use real git repos (per project policy — no subprocess mocks for
``git`` operations). The PR-open step is exercised in dry-run with
``open_pr=False`` so we don't try to push to a non-existent remote.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

from factory.chain.auto_merge import FixturePR, auto_merge_tick
from factory.chain.context_refresh import (
    ContextRefreshResult,
    handle_context_refresh,
    schedule_post_merge_refresh,
)
from factory.chain.state_machine import StoryRecord, StoryState


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def app_workspace(tmp_path: Path) -> tuple[Path, Path]:
    """Build a factory root + a sibling app repo with a context/ tree.

    Returns ``(software_factory_root, app_repo)`` so tests can assert
    against both the factory state and the app's working tree.
    """
    root = tmp_path / "factory"
    root.mkdir()
    (root / "apps" / "myapp").mkdir(parents=True)
    (root / "state").mkdir(parents=True)

    app_repo = tmp_path / "myapp"
    app_repo.mkdir()
    _git(app_repo, "init", "-q", "--initial-branch=main")
    _git(app_repo, "config", "user.email", "t@e.x")
    _git(app_repo, "config", "user.name", "T")

    # Seed canonical context paths so the refresh has something to touch.
    (app_repo / "context").mkdir()
    (app_repo / "context" / "modules").mkdir()
    (app_repo / "context" / "project.md").write_text(
        "# Project\n\nBase project doc.\n", encoding="utf-8"
    )
    (app_repo / "context" / "navigation.md").write_text(
        "# Navigation\n\nBase nav.\n", encoding="utf-8"
    )
    (app_repo / "context" / "current-state.md").write_text(
        "# Current state\n\nBaseline.\n", encoding="utf-8"
    )
    (app_repo / "context" / "modules" / "backend.md").write_text(
        "# Backend module\n", encoding="utf-8"
    )
    (app_repo / "README.md").write_text("# init\n", encoding="utf-8")
    _git(app_repo, "add", ".")
    _git(app_repo, "commit", "-q", "-m", "seed")

    cfg = {
        "name": "myapp",
        "repo": "owner/myapp",
        "default_branch": "main",
        "app_repo_path": str(app_repo),
    }
    (root / "apps" / "myapp" / "config.yaml").write_text(
        yaml.safe_dump(cfg), encoding="utf-8"
    )
    return root, app_repo


def test_refresh_touches_canonical_paths_and_module_scope(
    app_workspace: tuple[Path, Path]
) -> None:
    """The refresh stamps project/navigation/current-state and the matching
    ``context/modules/<scope>.md`` when the merged story was backend-scoped."""
    root, app_repo = app_workspace

    result = handle_context_refresh(
        app="myapp",
        merged_pr_number=42,
        merged_scope="backend",
        software_factory_root=root,
        open_pr=False,
    )

    assert result.error is None, f"refresh errored: {result.error}"
    assert result.skipped_reason is None, f"unexpected skip: {result.skipped_reason}"
    assert result.branch is not None
    assert result.branch.startswith("factory/context-refresh-")
    # All four canonical paths exist and were touched.
    assert "context/project.md" in result.files_changed
    assert "context/navigation.md" in result.files_changed
    assert "context/current-state.md" in result.files_changed
    assert "context/modules/backend.md" in result.files_changed
    # The refresh branch holds the commit on the app repo.
    log = subprocess.run(
        ["git", "log", "--oneline", "-1", result.branch],
        cwd=str(app_repo),
        capture_output=True,
        text=True,
        check=True,
    )
    assert "post-merge refresh after PR #42" in log.stdout


def test_refresh_skips_when_no_canonical_paths_exist(tmp_path: Path) -> None:
    """If the app repo has no canonical context paths, the refresh is a
    no-op (skipped_reason set, no error)."""
    root = tmp_path / "factory"
    root.mkdir()
    (root / "apps" / "barren").mkdir(parents=True)
    (root / "state").mkdir(parents=True)

    barren = tmp_path / "barren"
    barren.mkdir()
    _git(barren, "init", "-q", "--initial-branch=main")
    _git(barren, "config", "user.email", "t@e.x")
    _git(barren, "config", "user.name", "T")
    (barren / "README.md").write_text("# x\n", encoding="utf-8")
    _git(barren, "add", ".")
    _git(barren, "commit", "-q", "-m", "init")
    (root / "apps" / "barren" / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "barren",
                "repo": "owner/barren",
                "default_branch": "main",
                "app_repo_path": str(barren),
            }
        ),
        encoding="utf-8",
    )

    result = handle_context_refresh(
        app="barren",
        merged_pr_number=1,
        merged_scope="backend",
        software_factory_root=root,
        open_pr=False,
    )

    assert result.skipped_reason == "no_context_changes"
    assert result.error is None
    assert result.files_changed == []


def test_refresh_idempotent_no_diff_skips(app_workspace: tuple[Path, Path]) -> None:
    """Re-running the refresh against an already-stamped tree on the same
    branch should still produce a commit because the stamp's timestamp
    differs; but on a fresh branch where the source is unchanged the diff
    against base SHOULD include the stamp. The narrower idempotency we
    promise is: when nothing changes in the worktree at all, no commit is
    made. We simulate this by patching the stamper to be a no-op.
    """
    root, app_repo = app_workspace

    # Patch the stamper so write produces no diff — the only stable way
    # to assert idempotency without controlling the wall clock.
    from factory.chain import context_refresh as cr_mod

    def _noop_stamp(original: str, ts: str, pr: int) -> str:
        return original  # identical content -> no diff

    orig = cr_mod._stamp_refresh
    cr_mod._stamp_refresh = _noop_stamp  # type: ignore[assignment]
    try:
        result = handle_context_refresh(
            app="myapp",
            merged_pr_number=99,
            merged_scope="backend",
            software_factory_root=root,
            open_pr=False,
        )
    finally:
        cr_mod._stamp_refresh = orig  # type: ignore[assignment]

    assert result.skipped_reason == "no_context_changes"
    assert result.error is None


def test_refresh_returns_error_when_app_config_missing(tmp_path: Path) -> None:
    """A missing ``apps/<app>/config.yaml`` is captured as an error, not raised."""
    root = tmp_path / "factory"
    (root / "state").mkdir(parents=True)
    result = handle_context_refresh(
        app="ghost",
        merged_pr_number=7,
        merged_scope=None,
        software_factory_root=root,
        open_pr=False,
    )
    assert result.error is not None
    assert "app_config_missing" in result.error


def test_refresh_returns_error_when_app_repo_not_git(tmp_path: Path) -> None:
    """A non-git app repo is captured as an error."""
    root = tmp_path / "factory"
    root.mkdir()
    (root / "apps" / "noapp").mkdir(parents=True)
    (root / "state").mkdir(parents=True)
    (tmp_path / "noapp").mkdir()
    (root / "apps" / "noapp" / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "noapp",
                "repo": "owner/noapp",
                "default_branch": "main",
                "app_repo_path": str(tmp_path / "noapp"),
            }
        ),
        encoding="utf-8",
    )

    result = handle_context_refresh(
        app="noapp",
        merged_pr_number=1,
        merged_scope=None,
        software_factory_root=root,
        open_pr=False,
    )
    assert result.error is not None
    assert "app_repo_missing_or_not_git" in result.error


def test_schedule_sync_returns_result(app_workspace: tuple[Path, Path]) -> None:
    """``schedule_post_merge_refresh(sync=True)`` runs inline and returns the
    result. The async/threaded path returns None."""
    root, _ = app_workspace
    result = schedule_post_merge_refresh(
        app="myapp",
        merged_pr_number=11,
        merged_scope="backend",
        software_factory_root=root,
        sync=True,
        open_pr=False,
    )
    assert isinstance(result, ContextRefreshResult)
    assert result.succeeded


def test_schedule_async_does_not_return_result(app_workspace: tuple[Path, Path]) -> None:
    """Async dispatch returns None — caller does not block on the refresh."""
    root, _ = app_workspace
    out = schedule_post_merge_refresh(
        app="myapp",
        merged_pr_number=12,
        merged_scope=None,
        software_factory_root=root,
        sync=False,
        open_pr=False,
    )
    assert out is None


def test_auto_merge_fires_refresh_on_merged_pr(
    app_workspace: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful auto-merge schedules a context refresh. We patch the
    schedule function so we can assert it was invoked with the right args
    without exercising the full refresh path (covered separately)."""
    root, _ = app_workspace
    db = root / "state" / "factory.db"

    calls: list[dict[str, object]] = []

    def _capture(**kwargs: object) -> None:
        calls.append(kwargs)
        return None

    monkeypatch.setattr(
        "factory.chain.context_refresh.schedule_post_merge_refresh", _capture
    )

    # Context refresh is gated OFF by default (placeholder generates
    # conflicting orphan PRs); this test verifies the fire path, so opt in.
    (root / "factory_settings.yaml").write_text(
        "auto_merge:\n  context_refresh_enabled: true\n", encoding="utf-8"
    )

    # Seed a docs-chain story (fewer gates) already in PR_OPEN so
    # auto_merge_tick lands the merge in dry-run.
    story = StoryRecord(
        direction_id="D001",
        app="myapp",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        github_pr_number=77,
        github_branch="story/77-s",
        story_file_path="stories/77-s.md",
        chain_kind="docs",
    )
    fixture = FixturePR(
        pr_number=77,
        head_sha="abc1234",
        base_branch="main",
        labels=[],
        files_changed=[],
        ci_state="success",
        story=story,
        repo_root=None,
    )

    actions = auto_merge_tick(
        root,
        "myapp",
        dry_run=True,
        fixture_prs=[fixture],
        db_path=db,
    )

    assert actions, "expected one MergeAction"
    assert actions[0].merged, f"fixture story should have merged: {actions[0].reason}"
    assert calls, "expected schedule_post_merge_refresh to fire"
    kw = calls[0]
    assert kw.get("app") == "myapp"
    assert kw.get("merged_pr_number") == 77
    assert kw.get("merged_scope") == "backend"


def test_auto_merge_swallows_refresh_failures(
    app_workspace: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the refresh schedule raises, the merge still returns success."""
    root, _ = app_workspace
    db = root / "state" / "factory.db"

    def _boom(**kwargs: object) -> None:
        raise RuntimeError("simulated refresh schedule failure")

    monkeypatch.setattr(
        "factory.chain.context_refresh.schedule_post_merge_refresh", _boom
    )

    story = StoryRecord(
        direction_id="D001",
        app="myapp",
        title="t",
        slug="s",
        scope="backend",
        state=StoryState.PR_OPEN.value,
        github_pr_number=78,
        github_branch="story/78-s",
        story_file_path="stories/78-s.md",
        chain_kind="docs",
    )
    fixture = FixturePR(
        pr_number=78,
        head_sha="def5678",
        base_branch="main",
        labels=[],
        files_changed=[],
        ci_state="success",
        story=story,
        repo_root=None,
    )

    # Should NOT raise.
    actions = auto_merge_tick(
        root,
        "myapp",
        dry_run=True,
        fixture_prs=[fixture],
        db_path=db,
    )
    assert actions[0].merged


def test_refresh_pr_open_attempted_via_pygithub(
    app_workspace: tuple[Path, Path]
) -> None:
    """When ``gh`` is not available, the refresh falls back to a
    pygithub-style client. We pass a fake client to assert the PR open
    path uses it AND attaches the ``context-refresh`` label.

    Since ``gh`` is installed on the test host (real-run path), this test
    skips the push-failure case explicitly by stubbing the push call. The
    PR open path itself is what we want to assert.
    """
    root, app_repo = app_workspace

    class _FakePR:
        def __init__(self) -> None:
            self.number = 999
            self.labels: list[str] = []

        def add_to_labels(self, *labels: str) -> None:
            self.labels.extend(labels)

    class _FakeRepo:
        def __init__(self) -> None:
            self.pulls_created: list[dict[str, str]] = []
            self.pr = _FakePR()

        def create_pull(
            self, *, title: str, body: str, head: str, base: str
        ) -> _FakePR:
            self.pulls_created.append(
                {"title": title, "body": body, "head": head, "base": base}
            )
            return self.pr

    class _FakeClient:
        def __init__(self) -> None:
            self.repo = _FakeRepo()

        def get_repo(self, full_name: str) -> _FakeRepo:
            assert full_name == "owner/myapp"
            return self.repo

    client = _FakeClient()

    # Stub ``gh`` so we always fall through to pygithub.

    real_run = subprocess.run

    def _fake_run(cmd, **kw):  # type: ignore[no-untyped-def]
        if cmd and cmd[0] == "gh":
            raise FileNotFoundError("gh not found (test stub)")
        if cmd and cmd[:2] == ["git", "push"]:
            # Pretend the push succeeded without actually contacting origin
            # — the app repo has no remote, but the refresh expects push to
            # succeed before opening the PR.
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")
        return real_run(cmd, **kw)

    import factory.chain.context_refresh as crmod2

    crmod2.subprocess.run = _fake_run  # type: ignore[assignment]
    try:
        result = handle_context_refresh(
            app="myapp",
            merged_pr_number=55,
            merged_scope="backend",
            software_factory_root=root,
            open_pr=True,
            github_client=client,
        )
    finally:
        crmod2.subprocess.run = real_run  # type: ignore[assignment]

    assert result.error is None, f"refresh failed: {result.error}"
    assert result.pr_number == 999
    # Label was attached.
    assert "context-refresh" in client.repo.pr.labels
    # PR titled correctly.
    assert client.repo.pulls_created
    assert (
        "post-merge update after PR #55" in client.repo.pulls_created[0]["title"]
    )
