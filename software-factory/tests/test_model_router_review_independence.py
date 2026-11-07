"""The reviewer must never share a model with any dev tier.

Cross-family review is the only structural defence this factory has against a
model approving its own reasoning. A collision does not fail loudly at runtime
— it silently produces agreeable reviews, which is worse than a crash. So the
router refuses to resolve ANY route out of a config that has lost it.

The check covers BOTH dev tiers. Until 2026-08-01 `azure_routes.dev.hard` and
`azure_routes.reviewer` were both `azure/gpt-5.3-codex`: independence held on
the standard tier and collapsed on the hard tier — the tier a story escalates
into when it is difficult, which is exactly when independent review matters
most.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from factory.model_router import (
    ReviewIndependenceError,
    check_review_independence,
    route,
)

_DEFAULT_ROUTES = Path(__file__).parent.parent / "factory" / "routes.yaml"


def _write(tmp_path: Path, data: dict) -> Path:
    p = tmp_path / "routes.yaml"
    p.write_text(yaml.safe_dump(data), encoding="utf-8")
    return p


def _cfg(reviewer: str, standard: str, hard: str, **extra: object) -> dict:
    block = {
        "reviewer": reviewer,
        "dev": {"standard": standard, "hard": hard},
        **extra,
    }
    return {"default_provider": "azure", "azure_routes": block, "defaults": {}}


# --------------------------------------------------------------------------- #
# The shipped config
# --------------------------------------------------------------------------- #


def test_the_real_routes_file_is_independent_under_both_providers() -> None:
    """The regression guard for the config this factory actually runs on."""
    data = yaml.safe_load(_DEFAULT_ROUTES.read_text(encoding="utf-8"))
    for provider in ("azure", "direct"):
        check_review_independence(data, provider=provider, source="routes.yaml")


def test_shipped_reviewer_differs_from_both_dev_tiers() -> None:
    data = yaml.safe_load(_DEFAULT_ROUTES.read_text(encoding="utf-8"))
    for block in ("azure_routes", "routes"):
        section = data[block]
        reviewer = section["reviewer"]
        assert reviewer != section["dev"]["standard"], block
        assert reviewer != section["dev"]["hard"], block


# --------------------------------------------------------------------------- #
# Collisions
# --------------------------------------------------------------------------- #


def test_reviewer_equal_to_dev_standard_is_fatal(tmp_path: Path) -> None:
    cfg = _cfg(reviewer="azure/x", standard="azure/x", hard="azure/y")
    with pytest.raises(ReviewIndependenceError, match="dev.standard"):
        check_review_independence(cfg, provider="azure")


def test_reviewer_equal_to_dev_hard_is_fatal(tmp_path: Path) -> None:
    """The collision that existed in production until 2026-08-01."""
    cfg = _cfg(reviewer="azure/gpt-5.3-codex", standard="azure/deepseek-v4-pro",
               hard="azure/gpt-5.3-codex")
    with pytest.raises(ReviewIndependenceError, match="dev.hard"):
        check_review_independence(cfg, provider="azure")


def test_collision_on_both_tiers_names_both(tmp_path: Path) -> None:
    cfg = _cfg(reviewer="azure/x", standard="azure/x", hard="azure/x")
    with pytest.raises(ReviewIndependenceError) as exc:
        check_review_independence(cfg, provider="azure")
    assert "dev.hard" in str(exc.value)
    assert "dev.standard" in str(exc.value)


def test_dev_as_a_bare_string_is_checked_too(tmp_path: Path) -> None:
    """``dev`` may be a plain string rather than a per-tier mapping."""
    cfg = {
        "default_provider": "azure",
        "azure_routes": {"reviewer": "azure/x", "dev": "azure/x"},
        "defaults": {},
    }
    with pytest.raises(ReviewIndependenceError):
        check_review_independence(cfg, provider="azure")


def test_route_refuses_to_resolve_under_a_collision(tmp_path: Path) -> None:
    """Enforced at LOAD, so no model id can be resolved out of a bad config —
    not even for an unrelated persona."""
    path = _write(tmp_path, _cfg(reviewer="azure/x", standard="azure/x", hard="azure/y"))
    with pytest.raises(ReviewIndependenceError):
        route("sm", routes_path=path)


def test_clean_config_resolves_normally(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        _cfg(reviewer="azure/rev", standard="azure/std", hard="azure/hard"),
    )
    assert route("reviewer", routes_path=path) == "azure/rev"
    assert route("dev", "standard", routes_path=path) == "azure/std"
    assert route("dev", "hard", routes_path=path) == "azure/hard"


# --------------------------------------------------------------------------- #
# Scope and escape hatch
# --------------------------------------------------------------------------- #


def test_only_the_active_provider_block_is_enforced(tmp_path: Path) -> None:
    """An unused block may legitimately be mid-edit."""
    cfg = {
        "default_provider": "azure",
        "azure_routes": {"reviewer": "azure/rev", "dev": {"standard": "azure/std"}},
        "routes": {"reviewer": "d/same", "dev": {"standard": "d/same"}},
        "defaults": {},
    }
    check_review_independence(cfg, provider="azure")  # active: clean
    with pytest.raises(ReviewIndependenceError):
        check_review_independence(cfg, provider="direct")


def test_env_override_downgrades_the_error_to_a_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A hard error at load would otherwise leave an operator unable to run the
    commands that fix a bad routes.yaml."""
    monkeypatch.setenv("FACTORY_ALLOW_REVIEW_COLLISION", "1")
    path = _write(tmp_path, _cfg(reviewer="azure/x", standard="azure/x", hard="azure/y"))
    assert route("reviewer", routes_path=path) == "azure/x"


@pytest.mark.parametrize("value", ["", "0", "false"])
def test_falsy_override_values_do_not_disable_the_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("FACTORY_ALLOW_REVIEW_COLLISION", value)
    cfg = _cfg(reviewer="azure/x", standard="azure/x", hard="azure/y")
    with pytest.raises(ReviewIndependenceError):
        check_review_independence(cfg, provider="azure")


# --------------------------------------------------------------------------- #
# test_implementer — advisory, not fatal
# --------------------------------------------------------------------------- #


def test_test_implementer_sharing_a_dev_model_is_advisory(tmp_path: Path) -> None:
    """This weakens the acceptance oracle but not the merge decision, so it
    must not brick startup. It is true of the shipped azure block today."""
    cfg = _cfg(
        reviewer="azure/rev",
        standard="azure/deepseek-v4-pro",
        hard="azure/hard",
        test_implementer="azure/deepseek-v4-pro",
    )
    advisories = check_review_independence(cfg, provider="azure")
    assert len(advisories) == 1
    assert "test_implementer" in advisories[0]
    assert "dev.standard" in advisories[0]


def test_independent_test_implementer_produces_no_advisory(tmp_path: Path) -> None:
    cfg = _cfg(
        reviewer="azure/rev",
        standard="azure/std",
        hard="azure/hard",
        test_implementer="azure/other",
    )
    assert check_review_independence(cfg, provider="azure") == []
