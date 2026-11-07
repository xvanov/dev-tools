"""Dev persona is forbidden from modifying test files.

Two layers of enforcement live in the chain:

  1. Persona prompt at ``factory/personas/dev.md`` tells the LLM the rule.
  2. Post-Dev diff check in ``handle_dev`` aborts to
     ``BLOCKED_TESTS_NEED_CLARIFICATION`` if any test path appears in the
     diff between pre-dev HEAD and post-dev HEAD.

The unit tests here cover layer 2 end-to-end with a tmp git repo as the
target tree and a mocked ``sandbox_run`` standing in for the LLM call.
"""

from __future__ import annotations

import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from factory import runner as runner_module
from factory.app_config import AppConfig
from factory.chain import handlers
from factory.chain.handlers import handle_dev, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.runner import RunResult


def _init_repo(path: Path, *, default_branch: str = "main") -> None:
    """Create a fresh git repo with one initial commit on ``default_branch``."""
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "-q", f"--initial-branch={default_branch}"],
        cwd=str(path),
        check=True,
    )
    subprocess.run(["git", "config", "user.email", "t@e.x"], cwd=str(path), check=True)
    subprocess.run(["git", "config", "user.name", "T E"], cwd=str(path), check=True)
    (path / "README.md").write_text("# test\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(path), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(path), check=True)


@pytest.fixture
def factory_tree(tmp_path: Path) -> Iterator[tuple[Path, Path]]:
    """Set up (factory_root, target_app_repo) on disk.

    ``factory_root`` is a fake software-factory layout with ``apps/sacrifice/``
    sufficient for the chain handlers to find a story file. ``target_app_repo``
    is a sibling git repo mirroring ``~/sacrifice/`` — the directory Dev's
    sandbox would actually commit to.
    """
    factory_root = tmp_path / "software-factory"
    (factory_root / "state").mkdir(parents=True)
    (factory_root / "apps" / "sacrifice" / "stories").mkdir(parents=True)
    # A minimal story file Dev can be pointed at — content doesn't matter for
    # the diff-only enforcement we're testing.
    (factory_root / "apps" / "sacrifice" / "stories" / "1-x.md").write_text(
        "# story\n", encoding="utf-8"
    )

    target = tmp_path / "sacrifice"
    _init_repo(target)
    yield factory_root, target


def _story_at_tests_red(factory_root: Path) -> StoryRecord:
    """Create a story positioned right where Dev would normally take over."""
    db = factory_root / "state" / "factory.db"
    return persist_story(
        StoryRecord(
            id=None,
            direction_id="005",
            app="sacrifice",
            title="t",
            slug="x",
            scope="backend",
            state=StoryState.SM_DONE.value,
            github_issue_number=1,
            story_file_path="stories/1-x.md",
        ),
        db,
    )


def _make_app_config(target_repo: Path) -> AppConfig:
    """AppConfig pointing at the temp target repo via an absolute ``app_repo_path``."""
    return AppConfig(
        name="sacrifice",
        repo="x/y",
        default_branch="main",
        app_repo_path=str(target_repo),
    )


def _commit_in_repo(repo: Path, file_path: str, content: str, *, message: str = "dev work") -> None:
    """Write + commit ``file_path`` in ``repo``. Creates parent dirs as needed."""
    full = repo / file_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-q", "-m", message], cwd=str(repo), check=True)


# --------------------------------------------------------------------------- #
# Test 1: Dev modifies a test file → handler aborts
# --------------------------------------------------------------------------- #


def test_dev_modifying_test_file_is_allowed(
    factory_tree: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Loop-4 (dev-owns-tests): Dev now WRITES the tests, so a diff that
    includes test files is expected and must NOT abort. A green run with both
    code and test edits proceeds to ``TESTS_GREEN``.
    """
    factory_root, target = factory_tree
    app_cfg = _make_app_config(target)
    story = _story_at_tests_red(factory_root)

    def _fake_sandbox_run(*args: object, **kwargs: object) -> RunResult:
        # Simulate Dev's actions: commit a code edit AND the test that proves
        # it — both belong to dev now.
        worktree = Path(kwargs["repo_path"])  # type: ignore[index]
        _commit_in_repo(worktree, "src/app.py", "# code\n", message="implement")
        _commit_in_repo(
            worktree,
            "tests/test_app.py",
            "def test_x(): assert app() == 1\n",
            message="dev writes the test that proves the code",
        )
        return RunResult(
            success=True,
            files_changed=["src/app.py", "tests/test_app.py"],
            test_run_passed=True,
            tokens_in=100,
            tokens_out=10,
            cost_usd=0.001,
            summary="dev wrote code + tests, suite green",
        )

    async def _async_wrap(*a: object, **kw: object) -> RunResult:
        return _fake_sandbox_run(*a, **kw)

    monkeypatch.setattr(runner_module, "sandbox_run", _async_wrap, raising=True)
    monkeypatch.setattr(handlers, "route", lambda *a, **kw: "azure/deepseek-v4-pro")

    db = factory_root / "state" / "factory.db"
    result = handle_dev(story, app_cfg, factory_root, dry_run=False, db_path=db)

    assert result.next_state == StoryState.TESTS_GREEN, (
        f"Expected TESTS_GREEN (dev owns tests, no abort); got {result.next_state}. "
        f"Error: {result.error}"
    )
    payload = result.payload
    assert payload is not None
    # The legacy "tests_modified_by_dev" abort signal must be gone.
    assert payload.get("tests_modified_by_dev") is None
    assert payload.get("test_run_passed") is True


# --------------------------------------------------------------------------- #
# Test 2: Dev edits only code → handler proceeds (no test paths in diff)
# --------------------------------------------------------------------------- #


def test_dev_editing_only_code_is_not_aborted(
    factory_tree: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The enforcement must NOT false-positive on a clean Dev run.

    Dev commits a code change; no test paths appear in the diff; the handler
    transitions on the normal tests-green/tests-red path.
    """
    factory_root, target = factory_tree
    app_cfg = _make_app_config(target)
    story = _story_at_tests_red(factory_root)

    def _fake_sandbox_run(*args: object, **kwargs: object) -> RunResult:
        # Only code, no test paths.
        _commit_in_repo(target, "src/app.py", "# code\n", message="implement")
        return RunResult(
            success=True,
            files_changed=["src/app.py"],
            test_run_passed=True,
            tokens_in=100,
            tokens_out=10,
            cost_usd=0.001,
            summary="clean dev run",
        )

    async def _async_wrap(*a: object, **kw: object) -> RunResult:
        return _fake_sandbox_run(*a, **kw)

    monkeypatch.setattr(runner_module, "sandbox_run", _async_wrap, raising=True)
    monkeypatch.setattr(handlers, "route", lambda *a, **kw: "azure/deepseek-v4-pro")

    db = factory_root / "state" / "factory.db"
    result = handle_dev(story, app_cfg, factory_root, dry_run=False, db_path=db)

    # Tests green + no forbidden test edits → TESTS_GREEN.
    assert result.next_state == StoryState.TESTS_GREEN, (
        f"Expected TESTS_GREEN for a clean dev run; got {result.next_state}. Error: {result.error}"
    )
    payload = result.payload
    assert payload is not None
    assert payload.get("tests_modified_by_dev") is None
    assert payload.get("test_run_passed") is True


# --------------------------------------------------------------------------- #
# Test 3: Persona prompt carries the explicit-glob frozen-tests rule
# --------------------------------------------------------------------------- #


def test_dev_persona_prompt_declares_dev_owns_tests_rule() -> None:
    """Loop-4: the persona must tell the dev it owns BOTH code and tests, and
    must warn against the slop anti-patterns the reviewer's slop detector
    rejects. It must NOT carry the obsolete frozen-tests / clarification rule.
    """
    prompt = (Path(__file__).parent.parent / "factory" / "personas" / "dev.md").read_text(
        encoding="utf-8"
    )

    # Must declare that dev owns the tests.
    assert "code AND its tests" in prompt or "code and the tests" in prompt, (
        "Dev prompt must state the dev writes both code and tests."
    )
    # Must warn against the headline slop pattern + the red-first discipline.
    assert "assert True" in prompt, "Dev prompt must warn against tautological tests."
    assert "slop" in prompt.lower(), "Dev prompt must reference the slop gate."
    # The obsolete frozen-tests escalation channel must be gone.
    assert "TESTS_NEED_CLARIFICATION:" not in prompt, (
        "Dev prompt still carries the obsolete frozen-tests escalation channel."
    )
