"""Verify that runs.ndjson is populated when a run is recorded in the DB."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from factory.runner import _record_run


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    """Minimal factory root with a state/ subdirectory."""
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    return tmp_path


def test_record_run_writes_ndjson(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    _record_run(
        persona="sm",
        model="deepseek/deepseek-coder",
        mode="text-dry-run",
        tokens_in=10,
        tokens_out=20,
        cost_usd=0.001,
        success=True,
        story_path=None,
        repo_path=None,
        error=None,
        db_path=db,
        duration_s=1.5,
        story_id=42,
        model_tier="standard",
        software_factory_root=factory_root,
    )

    ndjson = factory_root / "state" / "events" / "runs.ndjson"
    assert ndjson.exists(), "runs.ndjson should have been created"
    rec = json.loads(ndjson.read_text(encoding="utf-8").strip())
    assert rec["event"] == "run"
    assert rec["persona"] == "sm"
    assert rec["success"] is True
    assert rec["tokens_in"] == 10
    assert rec["tokens_out"] == 20
    assert rec["story_id"] == 42
    assert rec["model_tier"] == "standard"
    assert "ts" in rec
    assert rec["schema_version"] == 1
