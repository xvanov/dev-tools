"""Tests for factory.manager.self_context — Phase 9.

All LLM calls are mocked; tests are deterministic.

Test inventory
--------------
test_refresh_writes_all_six_modules_when_no_module_specified
    Mock LLM; run refresh; assert all 6 files exist with non-empty content.

test_refresh_single_module_only_writes_that_one
    --module orchestrator writes only orchestrator.md.

test_refresh_logs_to_context_refresh_ndjson
    Confirm one event per module refreshed.

test_refresh_atomic_writes
    Mock LLM to fail mid-module; verify partial file is not left at target path.

test_dry_run_does_not_call_llm
    Confirm dry_run=True never calls text_run.

The ``_pre_load_source`` selective-context-loading tests that used to live
here tested ``factory.manager.diagnostician._pre_load_source`` itself, not
this module — they were deleted 2026-08-07 along with
``factory/manager/diagnostician.py`` — see STATUS.md and the Exteroception
v1 direction, P0. This file now covers only ``factory.manager.self_context``.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from factory.manager.self_context import (
    ALL_MODULES,
    _context_refresh_event_path,
    refresh_factory_context,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=UTC)

_CANNED_MD = "# {module}\n\nThis is a canned context module for {module}.\n"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_canned_response(module: str) -> str:
    return _CANNED_MD.format(module=module)


# ---------------------------------------------------------------------------
# refresh_factory_context tests
# ---------------------------------------------------------------------------


def test_refresh_writes_all_six_modules_when_no_module_specified(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mock LLM → run refresh → all 6 files exist with non-empty content."""
    llm_call_count = [0]

    def _mock_text_run(persona: str, prompt: str, model_id: str, schema=None, **kwargs: Any) -> str:
        llm_call_count[0] += 1
        # Extract the module name from the prompt to return appropriate content.
        for mod in ALL_MODULES:
            if f"`{mod}`" in prompt:
                return _make_canned_response(mod)
        return "# Generic\n\nGeneric content.\n"

    monkeypatch.setattr("factory.manager.self_context.text_run", _mock_text_run)
    monkeypatch.setattr("factory.manager.self_context._read_persona_prompt", lambda p: "# mock persona")
    monkeypatch.setattr(
        "factory.manager.self_context.route",  # type: ignore[attr-defined]
        lambda *a, **kw: "anthropic/claude-sonnet-4-6",
        raising=False,
    )
    monkeypatch.setattr(
        "factory.manager.self_context.max_output_tokens_for",  # type: ignore[attr-defined]
        lambda *a, **kw: 8192,
        raising=False,
    )

    # Patch model_router at the module level (imported inside refresh_factory_context)
    import factory.model_router as mr
    monkeypatch.setattr(mr, "route", lambda *a, **kw: "anthropic/claude-sonnet-4-6")
    monkeypatch.setattr(mr, "max_output_tokens_for", lambda *a, **kw: 8192)

    result = refresh_factory_context(root=tmp_path)

    assert result["refreshed"] == 6, f"Expected 6 refreshed, got {result}"
    assert result["failed"] == 0, f"Expected 0 failed, got {result}"
    assert llm_call_count[0] == 6, f"Expected 6 LLM calls, got {llm_call_count[0]}"

    modules_dir = tmp_path / "apps" / "factory" / "context" / "modules"
    for mod_name in ALL_MODULES:
        mod_file = modules_dir / f"{mod_name}.md"
        assert mod_file.exists(), f"Module file missing: {mod_file}"
        content = mod_file.read_text(encoding="utf-8")
        assert content.strip(), f"Module file empty: {mod_file}"


def test_refresh_single_module_only_writes_that_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """--module orchestrator writes only orchestrator.md."""

    def _mock_text_run(persona: str, prompt: str, model_id: str, schema=None, **kwargs: Any) -> str:
        return "# orchestrator\n\nOrchestrator content.\n"

    monkeypatch.setattr("factory.manager.self_context.text_run", _mock_text_run)
    monkeypatch.setattr("factory.manager.self_context._read_persona_prompt", lambda p: "# mock persona")
    import factory.model_router as mr
    monkeypatch.setattr(mr, "route", lambda *a, **kw: "anthropic/claude-sonnet-4-6")
    monkeypatch.setattr(mr, "max_output_tokens_for", lambda *a, **kw: 8192)

    result = refresh_factory_context(root=tmp_path, module="orchestrator")

    assert result["refreshed"] == 1
    assert result["failed"] == 0

    modules_dir = tmp_path / "apps" / "factory" / "context" / "modules"
    assert (modules_dir / "orchestrator.md").exists()
    # All other module files must NOT exist.
    for mod_name in ALL_MODULES:
        if mod_name != "orchestrator":
            assert not (modules_dir / f"{mod_name}.md").exists(), (
                f"Module {mod_name}.md should not exist but does"
            )


def test_refresh_logs_to_context_refresh_ndjson(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Confirm one event per module refreshed in context_refresh.ndjson."""
    monkeypatch.setattr(
        "factory.manager.self_context.text_run",
        lambda persona, prompt, model_id, schema=None, **kw: "# content\n",
    )
    monkeypatch.setattr("factory.manager.self_context._read_persona_prompt", lambda p: "# mock")
    import factory.model_router as mr
    monkeypatch.setattr(mr, "route", lambda *a, **kw: "anthropic/claude-sonnet-4-6")
    monkeypatch.setattr(mr, "max_output_tokens_for", lambda *a, **kw: 8192)

    result = refresh_factory_context(root=tmp_path)
    assert result["refreshed"] == 6

    event_path = _context_refresh_event_path(tmp_path)
    assert event_path.exists(), "context_refresh.ndjson must be created"

    lines = [ln for ln in event_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 6, f"Expected 6 event lines, got {len(lines)}"

    events = [json.loads(ln) for ln in lines]
    for ev in events:
        assert ev["event"] == "context_module_refreshed"
        assert "module" in ev
        assert "path" in ev


def test_refresh_atomic_writes_no_partial_file_on_llm_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mock LLM to fail mid-module; verify no partial file left at target path."""
    modules_dir = tmp_path / "apps" / "factory" / "context" / "modules"

    call_count = [0]

    def _mock_text_run(persona: str, prompt: str, model_id: str, schema=None, **kwargs: Any) -> str:
        call_count[0] += 1
        if call_count[0] == 1:
            raise RuntimeError("simulated LLM failure")
        return "# content\n"

    monkeypatch.setattr("factory.manager.self_context.text_run", _mock_text_run)
    monkeypatch.setattr("factory.manager.self_context._read_persona_prompt", lambda p: "# mock")
    import factory.model_router as mr
    monkeypatch.setattr(mr, "route", lambda *a, **kw: "anthropic/claude-sonnet-4-6")
    monkeypatch.setattr(mr, "max_output_tokens_for", lambda *a, **kw: 8192)

    # Refresh only the first module (orchestrator) to test the failure case.
    result = refresh_factory_context(root=tmp_path, module="orchestrator")

    assert result["failed"] == 1, f"Expected 1 failure, got {result}"
    # The target path must NOT exist (no partial file).
    target = modules_dir / "orchestrator.md"
    assert not target.exists(), f"Partial file must not exist at {target}"
    # Temp files must also be cleaned up.
    tmp_files = list(modules_dir.glob(".orchestrator.md.tmp*")) if modules_dir.exists() else []
    assert not tmp_files, f"Temp files found: {tmp_files}"


def test_dry_run_does_not_call_llm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """dry_run=True must never call text_run."""
    llm_called = [False]

    def _mock_text_run(*args: Any, **kwargs: Any) -> str:
        llm_called[0] = True
        return "# content\n"

    monkeypatch.setattr("factory.manager.self_context.text_run", _mock_text_run)
    monkeypatch.setattr("factory.manager.self_context._read_persona_prompt", lambda p: "# mock")
    import factory.model_router as mr
    monkeypatch.setattr(mr, "route", lambda *a, **kw: "anthropic/claude-sonnet-4-6")
    monkeypatch.setattr(mr, "max_output_tokens_for", lambda *a, **kw: 8192)

    refresh_factory_context(root=tmp_path, dry_run=True)

    assert not llm_called[0], "LLM must NOT be called in dry-run mode"
    # In dry-run, success=True but skipped_reason="dry_run" — no files written.
    modules_dir = tmp_path / "apps" / "factory" / "context" / "modules"
    for mod_name in ALL_MODULES:
        assert not (modules_dir / f"{mod_name}.md").exists(), (
            f"Module file must not be written in dry-run: {mod_name}.md"
        )


def test_unknown_module_name_returns_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Invalid module name returns error result without calling LLM."""
    llm_called = [False]
    monkeypatch.setattr(
        "factory.manager.self_context.text_run",
        lambda *a, **kw: (llm_called.__setitem__(0, True) or "# content"),
    )
    import factory.model_router as mr
    monkeypatch.setattr(mr, "route", lambda *a, **kw: "anthropic/claude-sonnet-4-6")
    monkeypatch.setattr(mr, "max_output_tokens_for", lambda *a, **kw: 8192)

    result = refresh_factory_context(root=tmp_path, module="not-a-real-module")
    assert result["failed"] == 1
    assert not llm_called[0]
