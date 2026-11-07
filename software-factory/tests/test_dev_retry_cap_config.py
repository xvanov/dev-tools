"""The dev-retry cap is operator-configurable, and the layered guards stay layered.

Until 2026-08-09 `direction_defaults.max_dev_retries` existed in
`factory_settings.yaml` AND in `DirectionDefaults` and **nothing read it** — the
authoritative value was a hardcoded constant. An operator could set it to 6,
restart, and observe no change. Same defect class as the acceptance harness hint:
a configuration fact whose consumer cannot verify it, so it drifts silently.
"""

from __future__ import annotations

from pathlib import Path

from factory.chain.handlers import (
    _DEFAULT_MAX_DEV_RETRIES,
    _MAX_DEV_SAME_SIGNATURE,
    _max_dev_retries,
)


def _root(tmp_path: Path, value: str | None) -> Path:
    if value is not None:
        (tmp_path / "factory_settings.yaml").write_text(
            f"direction_defaults:\n  max_dev_retries: {value}\n", encoding="utf-8"
        )
    return tmp_path


def test_the_configured_value_is_actually_read(tmp_path: Path) -> None:
    """The regression this file exists for: the YAML key was dead config."""
    assert _max_dev_retries(_root(tmp_path, "6")) == 6


def test_default_is_four(tmp_path: Path) -> None:
    """Raised from 3 by operator decision once the acceptance oracle went live —
    an extra dev attempt is no longer an extra chance to game the grader, because
    the grader is authored from the spec, frozen before dev starts, and stored
    outside the dev worktree."""
    assert _DEFAULT_MAX_DEV_RETRIES == 4
    assert _max_dev_retries(_root(tmp_path, None)) == 4


def test_a_cap_that_would_hide_the_early_guard_is_refused(tmp_path: Path) -> None:
    """THE INVARIANT. `_MAX_DEV_SAME_SIGNATURE` escalates EARLY — before the full
    retry budget is spent — so it must stay STRICTLY BELOW the hard cap. Configure
    the cap at or under it and the early guard becomes unreachable, silently
    collapsing two deliberately layered guards into one. Fail SAFE: refuse the
    value and keep both guards live."""
    for bad in (str(_MAX_DEV_SAME_SIGNATURE), str(_MAX_DEV_SAME_SIGNATURE - 1), "0", "1"):
        got = _max_dev_retries(_root(tmp_path, bad))
        assert got > _MAX_DEV_SAME_SIGNATURE, f"cap {bad} left the early guard unreachable"


def test_an_unreadable_settings_file_does_not_unbound_the_cap(tmp_path: Path) -> None:
    """A broken config must never mean "retry forever" — fail safe to the default."""
    (tmp_path / "factory_settings.yaml").write_text("{{{ not yaml", encoding="utf-8")
    assert _max_dev_retries(tmp_path) == _DEFAULT_MAX_DEV_RETRIES


def test_orchestrator_and_handler_agree(tmp_path: Path) -> None:
    """`_prune_stale_in_progress` rolls a stranded `dev_in_progress` row back to
    just below the cap. If it read a stale constant while the handler enforced a
    configured value, a story could be rolled back to a state the handler
    immediately re-blocks. Both now call the same resolver."""
    import factory.chain.orchestrator as orch

    src = Path(orch.__file__).read_text(encoding="utf-8")
    assert "_max_dev_retries" in src
    assert "story.dev_retries >= _MAX_DEV_RETRIES" not in src
