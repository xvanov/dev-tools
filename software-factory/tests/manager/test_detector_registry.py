"""Tests for the detector registry exposed by factory.manager.detectors."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from factory.manager.detectors import DETECTOR_DOCS, DETECTORS

EXPECTED_NAMES = {
    "runs_failed_since",
    "retry_storm",
    "review_churn",
    "conformance_breach",
    "cost_spike",
    "fms_yield",
    "tick_duration_outliers",
    "state_distribution_skew",
    "worktree_orphans",
    "placeholder_prompts",
    "stalled_stories",
}

NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)
SINCE = NOW - timedelta(hours=1)


def test_detectors_has_expected_entries() -> None:
    assert len(DETECTORS) == len(EXPECTED_NAMES), (
        f"Expected {len(EXPECTED_NAMES)} detectors, got {len(DETECTORS)}: {list(DETECTORS)}"
    )


def test_detector_names_match_expected() -> None:
    assert set(DETECTORS.keys()) == EXPECTED_NAMES


def test_detector_docs_has_same_keys() -> None:
    assert set(DETECTOR_DOCS.keys()) == set(DETECTORS.keys())


def test_every_entry_has_nonempty_docstring() -> None:
    for name, doc in DETECTOR_DOCS.items():
        assert doc, f"Detector {name!r} has empty docstring"
        assert len(doc) > 20, f"Detector {name!r} docstring suspiciously short: {doc!r}"


def test_detectors_are_callable() -> None:
    for name, fn in DETECTORS.items():
        assert callable(fn), f"DETECTORS[{name!r}] is not callable"


@pytest.mark.parametrize("name", sorted(EXPECTED_NAMES))
def test_detector_runs_on_empty_root(name: str, tmp_path: Path) -> None:
    """Calling each detector on an empty temp root must not raise."""
    fn = DETECTORS[name]
    kwargs: dict = {"root": tmp_path}
    # Detectors requiring 'since' need that arg
    if name in (
        "runs_failed_since",
        "retry_storm",
        "review_churn",
        "tick_duration_outliers",
        "state_distribution_skew",
        "placeholder_prompts",
    ):
        kwargs["since"] = SINCE
    result = fn(**kwargs)
    # Should return an empty-ish sensible value
    assert result is not None
