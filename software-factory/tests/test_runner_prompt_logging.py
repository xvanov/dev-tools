"""Tests for ``factory.runner.text_run`` prompt-metadata logging.

Every ``text_run`` call must append one structured record to
``state/events/prompts.ndjson`` (created on demand). The record carries
prompt length, per-section lengths, the list of placeholder markers found,
and the sha256 prefix — but NOT the prompt content itself. The
``placeholder_prompts`` detector and the L1 watcher consume this stream
to catch prompt-plumbing regressions within one tick of them happening.
"""

from __future__ import annotations

import json
from pathlib import Path

from factory.runner import (
    _log_prompt_metadata,
    _summarize_prompt_sections,
    text_run,
)


def _read_prompts_stream(root: Path) -> list[dict]:
    stream = root / "state" / "events" / "prompts.ndjson"
    if not stream.exists():
        return []
    return [json.loads(line) for line in stream.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_summarize_prompt_sections_returns_char_counts_per_header() -> None:
    prompt = (
        "intro that is not a section\n"
        "## Story\n"
        "story body line 1\n"
        "story body line 2\n"
        "## PR diff\n"
        "diff content\n"
    )
    sections = _summarize_prompt_sections(prompt)
    assert "Story" in sections
    assert "PR diff" in sections
    # Both sections have non-zero content.
    assert sections["Story"] > 0
    assert sections["PR diff"] > 0


def test_log_prompt_metadata_writes_record(tmp_path: Path) -> None:
    """Direct call writes one ndjson record with the expected fields."""
    prompt = (
        "## Story\nbody\n## PR diff\n(fetched from GitHub by the chain — placeholder for real-run)\n"
    )
    _log_prompt_metadata(
        persona="reviewer",
        prompt=prompt,
        model_id="stub/model",
        story_id=42,
        software_factory_root=tmp_path,
    )
    records = _read_prompts_stream(tmp_path)
    assert len(records) == 1
    rec = records[0]
    assert rec["event"] == "prompt"
    assert rec["persona"] == "reviewer"
    assert rec["story_id"] == 42
    assert rec["model_id"] == "stub/model"
    assert rec["prompt_length_total"] == len(prompt)
    assert "Story" in rec["prompt_section_lengths"]
    assert "PR diff" in rec["prompt_section_lengths"]
    # The broken marker we intentionally embedded should show up.
    assert "(fetched from GitHub by the chain" in rec["placeholder_markers_found"]
    # Hash is a 16-char hex prefix.
    assert len(rec["prompt_hash"]) == 16
    # CRITICAL: content is NOT logged.
    assert "body" not in json.dumps(rec)


def test_manager_persona_prompts_are_not_marker_scanned(tmp_path: Path) -> None:
    """A manager_* prompt that contains marker strings (because it echoes the
    placeholder_prompts detector's own flagged rows as analysis input) must be
    logged with an EMPTY marker list — otherwise the detector re-surfaces the
    watcher's own prompt in a self-sustaining false-positive loop."""
    prompt = (
        "## Detector results\n"
        "placeholder_prompts surfaced a reviewer leak: "
        "(fetched from GitHub by the chain — placeholder for real-run), (see {x})\n"
    )
    _log_prompt_metadata(
        persona="manager_watcher",
        prompt=prompt,
        model_id="stub/model",
        story_id=None,
        software_factory_root=tmp_path,
    )
    rec = _read_prompts_stream(tmp_path)[0]
    assert rec["persona"] == "manager_watcher"
    assert rec["placeholder_markers_found"] == []
    # The chain-persona path is unchanged: same prompt, real markers stamped.
    _log_prompt_metadata(
        persona="reviewer",
        prompt=prompt,
        model_id="stub/model",
        story_id=99,
        software_factory_root=tmp_path,
    )
    chain_rec = _read_prompts_stream(tmp_path)[1]
    assert chain_rec["persona"] == "reviewer"
    assert "(fetched from GitHub by the chain" in chain_rec["placeholder_markers_found"]


def test_log_prompt_metadata_never_raises_on_bad_root(tmp_path: Path) -> None:
    """A missing/unwritable root must not raise — best-effort logging only."""
    # Use a path that doesn't exist and where mkdir would fail (parent is a file).
    bogus_parent = tmp_path / "not-a-dir"
    bogus_parent.write_text("file-not-dir\n", encoding="utf-8")
    # Should not raise even though state/events/ can't be created under a file.
    _log_prompt_metadata(
        persona="reviewer",
        prompt="## Story\nx\n",
        model_id="stub/model",
        story_id=None,
        software_factory_root=bogus_parent,
    )


def test_text_run_dry_run_writes_prompt_event(tmp_path: Path) -> None:
    """End-to-end: text_run(dry_run=True) appends a prompt event."""
    prompt = "## Story\nfoo\n## PR diff\nbar\n"
    text_run(
        persona="reviewer",
        prompt=prompt,
        model_id="stub/model",
        dry_run=True,
        story_id=7,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
    )
    records = _read_prompts_stream(tmp_path)
    assert len(records) == 1
    rec = records[0]
    assert rec["persona"] == "reviewer"
    assert rec["story_id"] == 7
    assert rec["placeholder_markers_found"] == []


def test_text_run_logs_even_when_prompt_has_no_sections(tmp_path: Path) -> None:
    """A bare prompt with no ``## `` headers still produces a record."""
    text_run(
        persona="sm",
        prompt="just a string with no headers",
        model_id="stub/model",
        dry_run=True,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
    )
    records = _read_prompts_stream(tmp_path)
    assert len(records) == 1
    assert records[0]["prompt_section_lengths"] == {}
