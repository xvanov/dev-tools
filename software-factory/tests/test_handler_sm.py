"""Tests for ``factory.chain.handlers.handle_sm`` (dry-run + fixture path)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from factory.app_config import AppConfig
from factory.chain.handlers import handle_sm, persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.context.loader import compose_context_prelude as _real_compose_context_prelude


@pytest.fixture
def temp_root(tmp_path: Path) -> Path:
    """A throwaway software-factory root with state and apps dirs."""
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "apps" / "sacrifice").mkdir(parents=True, exist_ok=True)
    return tmp_path


@pytest.fixture
def app_config() -> AppConfig:
    return AppConfig(name="sacrifice", repo="x/y", default_branch="main", context_dir="context")


def _write_direction(
    root: Path,
    *,
    dir_id: str = "002",
    slug: str = "add-healthz-endpoint",
    flow: str | None = None,
    api: str | None = None,
    acceptance: list[str] | None = None,
) -> None:
    """Write a minimal direction dir on disk so ``find_direction_for_story``
    resolves it."""
    direction_dir = root / "apps" / "sacrifice" / "directions" / f"{dir_id}-{slug}"
    direction_dir.mkdir(parents=True, exist_ok=True)
    ac_block = ""
    if acceptance:
        ac_block = "\n## Acceptance Criteria\n\n" + "\n".join(f"- {a}" for a in acceptance) + "\n"
    (direction_dir / "direction.md").write_text(
        f"---\ntitle: {slug}\n---\n\n# {slug}\n\n## Why\n\nbecause.\n{ac_block}",
        encoding="utf-8",
    )
    if flow is not None:
        (direction_dir / "flow.md").write_text(flow, encoding="utf-8")
    if api is not None:
        (direction_dir / "api_spec.md").write_text(api, encoding="utf-8")


def _story(root: Path, *, scope: str = "backend") -> StoryRecord:
    db = root / "state" / "factory.db"
    s = StoryRecord(
        direction_id="002",
        app="sacrifice",
        title="Add /healthz endpoint",
        slug="add-healthz-endpoint",
        scope=scope,
        state=StoryState.STORY_CREATED.value,
        story_file_path="stories/0-add-healthz-endpoint.md",
    )
    return persist_story(s, db)


def test_dry_run_advances_through_sm_and_writes_story_file(
    temp_root: Path, app_config: AppConfig
) -> None:
    """Dry-run: SM transitions STORY_CREATED -> SM_IN_PROGRESS -> SM_DONE and
    writes a BMAD-format story file at the slug-based path."""
    _write_direction(temp_root, acceptance=["/healthz returns {version, status}"])
    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"

    result = handle_sm(s, app_config, temp_root, dry_run=True, db_path=db)

    assert result.next_state == StoryState.SM_DONE
    assert s.sm_result_json is not None
    target = temp_root / "apps" / "sacrifice" / "stories" / "0-add-healthz-endpoint.md"
    assert target.exists(), f"expected story at {target}"
    text = target.read_text(encoding="utf-8")
    assert "Acceptance Criteria" in text
    assert "/healthz returns {version, status}" in text


def test_dry_run_embeds_flow_verbatim_when_present(temp_root: Path, app_config: AppConfig) -> None:
    """If the direction provides flow.md, the SM story file MUST embed it verbatim."""
    user_flow = (
        "# Flow\n\n"
        "1. User taps `Pledge`.\n"
        "2. User enters $5 and submits.\n"
        "3. User sees `Pledged $5` toast.\n"
    )
    _write_direction(temp_root, flow=user_flow)
    s = _story(temp_root, scope="frontend")
    db = temp_root / "state" / "factory.db"
    handle_sm(s, app_config, temp_root, dry_run=True, db_path=db)

    target = temp_root / "apps" / "sacrifice" / "stories" / "0-add-healthz-endpoint.md"
    text = target.read_text(encoding="utf-8")
    # Verbatim embed — must contain every meaningful line of flow.md.
    for line in ("User taps `Pledge`.", "enters $5 and submits.", "Pledged $5"):
        assert line in text, f"expected {line!r} verbatim in story file"


def test_dry_run_embeds_api_spec_verbatim_when_present(
    temp_root: Path, app_config: AppConfig
) -> None:
    api_spec = "## /healthz\n\n`GET /healthz` -> 200 `{version, status}`\n"
    _write_direction(temp_root, api=api_spec)
    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    handle_sm(s, app_config, temp_root, dry_run=True, db_path=db)
    target = temp_root / "apps" / "sacrifice" / "stories" / "0-add-healthz-endpoint.md"
    assert "GET /healthz" in target.read_text(encoding="utf-8")


def test_story_file_path_is_persisted(temp_root: Path, app_config: AppConfig) -> None:
    """After SM, story.story_file_path is the slug-based relative path."""
    _write_direction(temp_root)
    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    handle_sm(s, app_config, temp_root, dry_run=True, db_path=db)
    assert s.story_file_path == "stories/0-add-healthz-endpoint.md"


def test_real_run_substitutes_real_issue_number_in_path(
    temp_root: Path, app_config: AppConfig
) -> None:
    """When github_issue_number is set, the SM target_path's leading 0- prefix
    is substituted with the real issue number — robust to directory prefix."""
    _write_direction(temp_root)
    s = _story(temp_root)
    s.github_issue_number = 42
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)
    # Fixture emits a path with the placeholder "0-" prefix; the handler MUST
    # substitute the real issue number even though the fixture carries the
    # canonical "stories/" parent.
    fixture = {
        "stories": [
            {
                "title": s.title,
                "slug": s.slug,
                "scope": "backend",
                "file_content": "# real-run story\n",
                "target_path": "stories/0-add-healthz-endpoint.md",
            }
        ],
        "summary": "fixture story",
    }
    handle_sm(s, app_config, temp_root, dry_run=True, db_path=db, fixture=fixture)
    assert s.story_file_path == "stories/42-add-healthz-endpoint.md", (
        f"expected substituted path, got {s.story_file_path!r}"
    )
    target = temp_root / "apps" / "sacrifice" / "stories" / "42-add-healthz-endpoint.md"
    assert target.exists()


def test_no_issue_dry_run_keeps_zero_prefix(temp_root: Path, app_config: AppConfig) -> None:
    """When github_issue_number is None (no GH issue), the 0- prefix is kept."""
    _write_direction(temp_root)
    s = _story(temp_root)
    assert s.github_issue_number is None
    db = temp_root / "state" / "factory.db"
    handle_sm(s, app_config, temp_root, dry_run=True, db_path=db)
    # Dry-run keeps the 0- prefix since there is no real issue.
    assert s.story_file_path == "stories/0-add-healthz-endpoint.md"


def test_substitution_robust_to_alt_filename_prefix(temp_root: Path, app_config: AppConfig) -> None:
    """The old startswith('stories/0-') heuristic missed paths with different
    directory prefixes or non-zero placeholder digits. The new regex-based
    substitution leaves real (non-0) prefixes alone and handles arbitrary
    parent directories."""
    from factory.chain.handlers import _substitute_issue_number_in_path

    # Real issue: substitute the 0- placeholder regardless of parent dir.
    assert (
        _substitute_issue_number_in_path("stories/0-my-slug.md", issue_number=17, slug="my-slug")
        == "stories/17-my-slug.md"
    )
    assert (
        _substitute_issue_number_in_path(
            "apps/sacrifice/stories/0-my-slug.md", issue_number=17, slug="my-slug"
        )
        == "apps/sacrifice/stories/17-my-slug.md"
    )
    # Already-set non-zero prefix: leave alone (likely a split / re-spawn).
    assert (
        _substitute_issue_number_in_path("stories/5-my-slug.md", issue_number=17, slug="my-slug")
        == "stories/5-my-slug.md"
    )
    # No issue: pass through.
    assert (
        _substitute_issue_number_in_path("stories/0-my-slug.md", issue_number=None, slug="my-slug")
        == "stories/0-my-slug.md"
    )
    # No numeric prefix at all: fall back to convention.
    assert (
        _substitute_issue_number_in_path("stories/my-slug.md", issue_number=17, slug="my-slug")
        == "stories/17-my-slug.md"
    )


def test_fixture_overrides_dry_run(temp_root: Path, app_config: AppConfig) -> None:
    """A test-supplied fixture is used as-is and persisted to sm_result_json."""
    _write_direction(temp_root)
    s = _story(temp_root)
    db = temp_root / "state" / "factory.db"
    fixture = {
        "stories": [
            {
                "title": "Add /healthz endpoint",
                "slug": "add-healthz-endpoint",
                "scope": "backend",
                "file_content": "# Custom story content from fixture\n",
                "target_path": "stories/0-add-healthz-endpoint.md",
            }
        ],
        "summary": "fixture story",
    }
    handle_sm(s, app_config, temp_root, dry_run=True, db_path=db, fixture=fixture)
    parsed = json.loads(s.sm_result_json or "{}")
    assert parsed["summary"] == "fixture story"
    target = temp_root / "apps" / "sacrifice" / "stories" / "0-add-healthz-endpoint.md"
    assert target.read_text(encoding="utf-8") == "# Custom story content from fixture\n"


def test_sm_prelude_receives_parent_direction_chain(
    temp_root: Path, app_config: AppConfig
) -> None:
    """When a story's direction has ``parent_direction`` set, the SM handler
    must pass the resolved chain to ``compose_context_prelude``."""
    # Parent direction on disk
    parent_dir = temp_root / "apps" / "sacrifice" / "directions" / "050-parent"
    parent_dir.mkdir(parents=True)
    (parent_dir / "direction.md").write_text(
        "---\ntitle: Parent\n---\n\n# Parent\n\n## Why\n\nPARENT_BODY_SENTINEL_TOKEN\n\n## Acceptance Criteria\n\n- AC1\n",
        encoding="utf-8",
    )
    # Child direction with parent_direction pointing at the parent
    child_dir = temp_root / "apps" / "sacrifice" / "directions" / "051-child-iter"
    child_dir.mkdir(parents=True)
    (child_dir / "direction.md").write_text(
        "---\ntitle: Child\nparent_direction: 050-parent\n---\n\n# Child\n\n## Why\n\niteration.\n\n## Acceptance Criteria\n\n- AC2\n",
        encoding="utf-8",
    )
    # App repo context so the loader doesn't fall into NO_CONTEXT_AVAILABLE
    context_dir = temp_root / "context"
    context_dir.mkdir(parents=True)
    (context_dir / "project.md").write_text("# proj\n", encoding="utf-8")
    (context_dir / "navigation.md").write_text("# nav\n", encoding="utf-8")
    # Point app_repo_path at temp_root so the context loader finds our files.
    test_app_config = AppConfig(
        name=app_config.name,
        repo=app_config.repo,
        default_branch=app_config.default_branch,
        context_dir=app_config.context_dir,
        app_repo_path=".",
    )

    db = temp_root / "state" / "factory.db"
    s = StoryRecord(
        direction_id="051",
        app="sacrifice",
        title="Iteration",
        slug="child-iter",
        scope="backend",
        state=StoryState.STORY_CREATED.value,
        story_file_path="stories/0-child-iter.md",
    )
    persist_story(s, db)

    dummy_text_run = {"stories": [], "summary": "ok"}
    captured_prelude: list[str] = []

    def _capturing_compose_prelude(*args: object, **kwargs: object) -> str:
        result = _real_compose_context_prelude(*args, **kwargs)  # type: ignore[arg-type]
        captured_prelude.append(result)
        return result

    with (
        patch("factory.runner.text_run", return_value=dummy_text_run),
        patch(
            "factory.context.loader.compose_context_prelude",
            side_effect=_capturing_compose_prelude,
        ) as mock_prelude,
    ):
        handle_sm(s, test_app_config, temp_root, dry_run=False, db_path=db)

    assert mock_prelude.called, "compose_context_prelude was not called"
    _, kwargs = mock_prelude.call_args
    chain = kwargs.get("direction_chain")
    assert chain is not None, "direction_chain was not passed to compose_context_prelude"
    assert len(chain) == 2
    assert chain[0].id_slug == "050-parent"
    assert chain[1].id_slug == "051-child-iter"

    # The prelude output must contain the parent's direction.md body text.
    assert len(captured_prelude) == 1
    assert "PARENT_BODY_SENTINEL_TOKEN" in captured_prelude[0]


def test_truncated_db_slug_matches_full_sm_slug(temp_root: Path, app_config: AppConfig) -> None:
    """The DB slug is truncated (column cap) while the SM emits full slugs;
    matching must be by prefix, not equality."""
    _write_direction(temp_root)
    s = _story(temp_root)
    s.slug = "add-chat-match-service-with-configurable-llm-match-cont"  # truncated
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)
    fixture = {
        "stories": [
            {
                "title": "foundation", "slug": "add-chat-sessions-model",
                "scope": "backend", "file_content": "# WRONG sibling contract\n",
                "target_path": "stories/0-add-chat-sessions-model.md",
            },
            {
                "title": s.title,
                "slug": "add-chat-match-service-with-configurable-llm-match-contract",
                "scope": "backend", "file_content": "# correct match-service story\n",
                "target_path": "stories/0-add-chat-match-service-with-configurable-llm-match-contract.md",
            },
        ],
        "summary": "fixture",
    }
    handle_sm(s, app_config, temp_root, dry_run=True, db_path=db, fixture=fixture)
    written = (temp_root / "apps" / "sacrifice" / s.story_file_path).read_text()
    assert "correct match-service story" in written
    assert "WRONG sibling" not in written


def test_no_matching_sm_entry_errors_instead_of_first_fallback(
    temp_root: Path, app_config: AppConfig
) -> None:
    """No silent fallback-to-first: writing a sibling's contract into this
    story's file sent dev off to re-build the sibling (9 corrupted stories,
    2026-06-11). An unmatched story must error loudly and write nothing."""
    _write_direction(temp_root)
    s = _story(temp_root)
    s.slug = "totally-unrelated-story-slug"
    db = temp_root / "state" / "factory.db"
    persist_story(s, db)
    original_path = s.story_file_path
    fixture = {
        "stories": [
            {
                "title": "foundation", "slug": "add-chat-sessions-model",
                "scope": "backend", "file_content": "# WRONG sibling contract\n",
                "target_path": "stories/0-add-chat-sessions-model.md",
            },
        ],
        "summary": "fixture",
    }
    result = handle_sm(s, app_config, temp_root, dry_run=True, db_path=db, fixture=fixture)
    assert result.error and "no story matching slug" in result.error
    # The sibling's file content must NOT have been written anywhere for us.
    if original_path:
        p = temp_root / "apps" / "sacrifice" / original_path
        assert not p.exists() or "WRONG sibling" not in p.read_text()
    # And the story must NOT advance: SM_DONE without a written file poisons
    # dispatch forever (dev dies on FileNotFoundError every tick — 2026-07-17,
    # dual-draft records vs per-child SM output). It resets to STORY_CREATED
    # so SM re-runs next tick.
    assert StoryState(s.state) is StoryState.STORY_CREATED
