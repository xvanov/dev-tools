"""Tests for prompt-BODY capture and the sandbox_run prompt-telemetry wiring.

Two gaps are covered here.

1. ``sandbox_run`` never called ``_log_prompt_metadata``. The three sandbox
   personas — dev, test_implementer, onboarder — are the ones that write all
   the code, and they had no prompt telemetry at all: ``prompts.ndjson`` held
   45,868 rows across 14 personas and zero rows for those three.

2. Only a 16-char hash of a prompt was ever recorded, which cannot be
   replayed, diffed, or optimized against. ``prompt_bodies.ndjson`` records
   the verbatim text plus the FULL sha256, in a separate stream with its own
   retention because bodies are ~3 orders of magnitude larger per row.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import pytest

from factory.runner import (
    LLMConfig,
    _log_prompt_body,
    _log_prompt_metadata,
    _prompt_bodies_scope,
    sandbox_run,
    text_run,
)


def _read_stream(root: Path, name: str) -> list[dict]:
    stream = root / "state" / "events" / f"{name}.ndjson"
    if not stream.exists():
        return []
    return [json.loads(line) for line in stream.read_text(encoding="utf-8").splitlines() if line.strip()]


# --------------------------------------------------------------------------- #
# _log_prompt_body
# --------------------------------------------------------------------------- #


def test_body_stream_records_full_text_and_full_hash(tmp_path: Path) -> None:
    prompt = "## Story\nimplement the thing\n## Context\nrepo details here\n"
    _log_prompt_body(
        persona="dev",
        prompt=prompt,
        model_id="stub/model",
        story_id=42,
        software_factory_root=tmp_path,
    )
    records = _read_stream(tmp_path, "prompt_bodies")
    assert len(records) == 1
    rec = records[0]
    assert rec["event"] == "prompt_body"
    assert rec["persona"] == "dev"
    assert rec["story_id"] == 42
    # The whole point: verbatim content, not a digest.
    assert rec["prompt"] == prompt
    assert rec["prompt_length_total"] == len(prompt)
    # FULL sha256, not the 16-char prefix the metadata stream carries.
    assert rec["prompt_hash"] == hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    assert len(rec["prompt_hash"]) == 64


def test_body_hash_prefix_joins_to_the_metadata_stream(tmp_path: Path) -> None:
    """The two streams must be joinable, or the split is useless."""
    prompt = "## Story\njoinable\n"
    _log_prompt_metadata(
        persona="dev",
        prompt=prompt,
        model_id="stub/model",
        story_id=5,
        software_factory_root=tmp_path,
    )
    _log_prompt_body(
        persona="dev",
        prompt=prompt,
        model_id="stub/model",
        story_id=5,
        software_factory_root=tmp_path,
    )
    meta = _read_stream(tmp_path, "prompts")[0]
    body = _read_stream(tmp_path, "prompt_bodies")[0]
    assert len(meta["prompt_hash"]) == 16
    assert body["prompt_hash"].startswith(meta["prompt_hash"])


def test_bodies_are_hash_chained(tmp_path: Path) -> None:
    """The body stream must be tamper-evident like every other event stream."""
    for i in range(3):
        _log_prompt_body(
            persona="dev",
            prompt=f"## Story\nprompt number {i}\n",
            model_id="stub/model",
            story_id=i,
            software_factory_root=tmp_path,
        )
    records = _read_stream(tmp_path, "prompt_bodies")
    assert len(records) == 3
    assert all("entry_hash" in r and "prev_hash" in r for r in records), records
    # Links are contiguous: each row's prev_hash is its predecessor's entry_hash.
    for earlier, later in zip(records[:-1], records[1:], strict=True):
        assert later["prev_hash"] == earlier["entry_hash"]


def test_log_prompt_body_never_raises_on_bad_root(tmp_path: Path) -> None:
    bogus_parent = tmp_path / "not-a-dir"
    bogus_parent.write_text("file-not-dir\n", encoding="utf-8")
    _log_prompt_body(
        persona="dev",
        prompt="## Story\nx\n",
        model_id="stub/model",
        story_id=None,
        software_factory_root=bogus_parent,
    )


# --------------------------------------------------------------------------- #
# Capture scope
# --------------------------------------------------------------------------- #


def test_manager_bodies_are_excluded_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """manager_watcher alone is 1.58 GB of prompt text — 93% of all prompts
    ever composed — on a 60 s cadence. Capturing its bodies would roll the
    stream every few hours and evict exactly the dev/reviewer bodies the
    stream exists to retain."""
    monkeypatch.delenv("FACTORY_PROMPT_BODIES", raising=False)
    assert _prompt_bodies_scope() == "chain"
    for persona in ("manager_watcher", "manager_summarizer", "manager_diagnostician"):
        _log_prompt_body(
            persona=persona,
            prompt="## Detector results\nlots of text\n",
            model_id="stub/model",
            story_id=None,
            software_factory_root=tmp_path,
        )
    assert _read_stream(tmp_path, "prompt_bodies") == []
    # …but a chain persona on the very same root IS captured.
    _log_prompt_body(
        persona="reviewer",
        prompt="## Story\nkept\n",
        model_id="stub/model",
        story_id=1,
        software_factory_root=tmp_path,
    )
    assert [r["persona"] for r in _read_stream(tmp_path, "prompt_bodies")] == ["reviewer"]


def test_scope_off_disables_capture_entirely(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACTORY_PROMPT_BODIES", "off")
    _log_prompt_body(
        persona="dev",
        prompt="## Story\nx\n",
        model_id="stub/model",
        story_id=1,
        software_factory_root=tmp_path,
    )
    assert _read_stream(tmp_path, "prompt_bodies") == []


def test_scope_all_includes_manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACTORY_PROMPT_BODIES", "all")
    _log_prompt_body(
        persona="manager_watcher",
        prompt="## Detector results\nx\n",
        model_id="stub/model",
        story_id=None,
        software_factory_root=tmp_path,
    )
    assert [r["persona"] for r in _read_stream(tmp_path, "prompt_bodies")] == ["manager_watcher"]


def test_unrecognized_scope_falls_back_to_chain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A typo in the env var must not silently disable telemetry, nor
    silently unleash the manager firehose."""
    monkeypatch.setenv("FACTORY_PROMPT_BODIES", "yes-please")
    assert _prompt_bodies_scope() == "chain"


# --------------------------------------------------------------------------- #
# sandbox_run wiring — the actual gap
# --------------------------------------------------------------------------- #


def _sandbox_dry_run(tmp_path: Path, persona: str) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    story = tmp_path / "story.md"
    story.write_text("## Story\nbuild the feature\n", encoding="utf-8")
    asyncio.run(
        sandbox_run(
            persona=persona,
            story_path=story,
            repo_path=repo,
            llm_config=LLMConfig(model="stub/model"),
            dry_run=True,
            story_id=11,
            software_factory_root=tmp_path,
            db_path=tmp_path / "state" / "factory.db",
        )
    )


@pytest.mark.parametrize("persona", ["dev", "test_implementer", "onboarder"])
def test_sandbox_personas_now_emit_prompt_metadata(tmp_path: Path, persona: str) -> None:
    """The regression this whole module exists for: before the fix these three
    personas produced zero rows in prompts.ndjson."""
    _sandbox_dry_run(tmp_path, persona)
    metas = _read_stream(tmp_path, "prompts")
    assert [r["persona"] for r in metas] == [persona]
    assert metas[0]["story_id"] == 11
    assert metas[0]["model_id"] == "stub/model"
    assert metas[0]["prompt_length_total"] > 0


def test_sandbox_run_records_the_composed_message_not_the_story_file(tmp_path: Path) -> None:
    """The logged prompt must be the assembled initial message (persona prompt
    + context prelude + story), not just the story text — otherwise the
    telemetry describes a prompt the model never saw."""
    _sandbox_dry_run(tmp_path, "dev")
    body = _read_stream(tmp_path, "prompt_bodies")[0]
    meta = _read_stream(tmp_path, "prompts")[0]
    assert "build the feature" in body["prompt"]
    # The composed message is substantially larger than the bare story file.
    assert body["prompt_length_total"] > len("## Story\nbuild the feature\n")
    assert meta["prompt_length_total"] == body["prompt_length_total"]


def test_text_run_still_emits_both_streams(tmp_path: Path) -> None:
    """The pre-existing text_run path keeps its metadata row and gains a body."""
    text_run(
        persona="reviewer",
        prompt="## Story\nfoo\n## PR diff\nbar\n",
        model_id="stub/model",
        dry_run=True,
        story_id=7,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
    )
    assert len(_read_stream(tmp_path, "prompts")) == 1
    bodies = _read_stream(tmp_path, "prompt_bodies")
    assert len(bodies) == 1
    assert bodies[0]["prompt"] == "## Story\nfoo\n## PR diff\nbar\n"
