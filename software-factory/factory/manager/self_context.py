"""factory.manager.self_context — Phase 9: factory self-context refresh.

The factory generates context modules describing its OWN architecture
(orchestrator, personas, state machine, observability, dispatch, manager)
and writes them to ``apps/factory/context/modules/*.md``.

These modules are read by the L3 Diagnostician (``_pre_load_source``) when
assembling context for proposals, so its architectural understanding stays
current without re-reading raw source every time.

Design rules
============

* Best-effort: LLM failures are logged but never propagate.
* Atomic writes: temp file + rename so partial writes cannot corrupt.
* Logs one event per module refreshed to
  ``state/events/context_refresh.ndjson``.
* Capped output: each module is capped at 16 KB (summaries, not source dumps).
* No new external deps — uses the same ``text_run`` / ``_read_persona_prompt``
  wrappers as the rest of the manager stack.

Public API
==========

* ``refresh_factory_context`` — refresh one or all six modules.
  The CLI ``factory manager refresh-context`` calls this.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Lazy-imported helpers — at module level so tests can monkeypatch them.


def _read_persona_prompt(persona: str) -> str:
    from factory.runner import _read_persona_prompt as _impl

    return _impl(persona)


def text_run(
    persona: str,
    prompt: str,
    model_id: str,
    schema: dict | None = None,
    **kwargs: Any,
) -> Any:
    from factory.runner import text_run as _impl

    return _impl(persona, prompt, model_id, schema=schema, **kwargs)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The six modules this module can produce.
ALL_MODULES: list[str] = [
    "orchestrator",
    "personas",
    "state-machine",
    "observability",
    "dispatch",
    "manager",
]

# Each module: (name, topic, list of source-file globs relative to factory_dir)
_MODULE_SPEC: dict[str, dict[str, Any]] = {
    "orchestrator": {
        "topic": (
            "What the tick loop does, what _dispatch_for_story returns, "
            "what _invoke_handler does on success/failure/exception."
        ),
        "globs": [
            "chain/orchestrator.py",
            "chain/state_machine.py",
        ],
    },
    "personas": {
        "topic": (
            "Every persona in factory/personas/*.md: what it consumes, "
            "what it produces, what model tier it runs at, what it can break."
        ),
        "globs": [
            "personas/*.md",
            "routes.yaml",
        ],
    },
    "state-machine": {
        "topic": (
            "Every state in the story state machine, who transitions out of it, "
            "what the rollback paths are."
        ),
        "globs": [
            "chain/state_machine.py",
            "chain/orchestrator.py",
        ],
    },
    "observability": {
        "topic": (
            "Every signal source, schema, where it is written, who consumes it."
        ),
        "globs": [
            "manager/signals.py",
            "chain/event_log.py",
            "manager/detectors/*.py",
        ],
    },
    "dispatch": {
        "topic": (
            "can_dispatch logic, the cap system, mode gating, rejection reasons."
        ),
        "globs": [
            "chain/orchestrator.py",
            "settings/modes.py",
            "settings/loader.py",
        ],
    },
    "manager": {
        "topic": (
            "The Factory Management System (FMS): the deterministic pieces that "
            "survive operator decision 2026-08-07, which deleted the four LLM "
            "tiers (L1 Watcher, L2 Summarizer, L3 Diagnostician, L4 Apply — "
            "$1,028.58 spend, 0 applied fixes). Signals, halt authority, "
            "staging (canary self-edit validation), the circuit breaker, and "
            "the forbidden-path classifier. The factory reads this module "
            "about itself — the loop closure."
        ),
        "globs": [
            "manager/signals.py",
            "manager/halt.py",
            "manager/staging.py",
            "manager/circuit_breaker.py",
            "manager/forbidden_paths.py",
            "manager/recovery.py",
        ],
    },
}

# Cap on individual source-file content loaded for context (chars).
_SOURCE_FILE_CAP = 8 * 1024  # 8 KB

# Cap on the LLM-generated module output (bytes → chars, 16 KB per spec).
_MODULE_OUTPUT_CAP = 16 * 1024  # 16 KB

# ---------------------------------------------------------------------------
# Event logging
# ---------------------------------------------------------------------------


def _context_refresh_event_path(root: Path) -> Path:
    return root / "state" / "events" / "context_refresh.ndjson"


def _log_event(root: Path, event: str, payload: dict[str, Any]) -> None:
    """Append one event line to state/events/context_refresh.ndjson."""
    record = {
        "ts": datetime.now(UTC).isoformat(),
        "event": event,
        **payload,
    }
    path = _context_refresh_event_path(root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception as exc:  # noqa: BLE001
        print(
            f"[self_context] WARNING: failed to log event: {exc}",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# Source file gathering
# ---------------------------------------------------------------------------


def _gather_source_files(module_name: str, factory_dir: Path) -> dict[str, str]:
    """Return {relative_path: content} for files relevant to module_name.

    Caps each file at _SOURCE_FILE_CAP chars.
    """
    spec = _MODULE_SPEC.get(module_name)
    if spec is None:
        return {}

    files: dict[str, str] = {}
    for glob_pattern in spec["globs"]:
        # Split into directory part and filename glob.
        # e.g. "chain/orchestrator.py" → dir=factory_dir/chain, pattern="orchestrator.py"
        # e.g. "personas/*.md" → dir=factory_dir/personas, pattern="*.md"
        pat = Path(glob_pattern)
        base_dir = factory_dir / pat.parent
        filename_glob = pat.name
        if not base_dir.exists():
            continue
        for fpath in sorted(base_dir.glob(filename_glob)):
            if not fpath.is_file():
                continue
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if len(text) > _SOURCE_FILE_CAP:
                text = text[:_SOURCE_FILE_CAP] + "\n...[truncated at 8KB]"
            try:
                rel = str(fpath.relative_to(factory_dir.parent))
            except ValueError:
                rel = str(fpath)
            files[rel] = text

    return files


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------


def _build_refresh_prompt(
    *,
    module_name: str,
    topic: str,
    source_files: dict[str, str],
    persona_prompt: str,
) -> str:
    """Assemble the full prompt for the LLM to produce a context module."""
    parts: list[str] = [
        persona_prompt.rstrip(),
        "",
        "---",
        "",
        f"## Self-context refresh request: `{module_name}`",
        "",
        f"**Topic:** {topic}",
        "",
        "Produce a Markdown context module (≤2000 words) describing the topic.",
        "Use the source files below as your primary input.",
        "",
    ]

    if source_files:
        parts.append("### Source files")
        parts.append("")
        for rel_path, content in source_files.items():
            parts.append(f"#### `{rel_path}`")
            parts.append("")
            parts.append("```")
            parts.append(content)
            parts.append("```")
            parts.append("")
    else:
        parts.append("_(no source files available for this module)_")
        parts.append("")

    parts.append("---")
    parts.append("")
    parts.append(
        "Return ONLY the Markdown document. No JSON, no code fences wrapping "
        "the whole document, no prose outside the document."
    )

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Atomic write
# ---------------------------------------------------------------------------


def _atomic_write(target: Path, content: str) -> None:
    """Write content to target atomically via a temp file + rename.

    The temp file is created in the same directory as the target so the
    rename is always on the same filesystem (avoids cross-device errors).
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path_str = tempfile.mkstemp(
        dir=str(target.parent),
        prefix=f".{target.name}.tmp",
        suffix=".tmp",
    )
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        tmp_path.rename(target)
    except Exception:
        # Clean up the temp file if anything went wrong, then re-raise.
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        raise


# ---------------------------------------------------------------------------
# Single-module refresh
# ---------------------------------------------------------------------------


def _refresh_one_module(
    *,
    module_name: str,
    factory_dir: Path,
    output_dir: Path,
    root: Path,
    model_id: str,
    max_tokens: int,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Refresh a single context module.

    Returns a result dict with keys:
        module, success, path, skipped_reason, error
    """
    spec = _MODULE_SPEC.get(module_name)
    if spec is None:
        return {
            "module": module_name,
            "success": False,
            "error": f"unknown module name: {module_name!r}",
        }

    topic: str = spec["topic"]
    output_path = output_dir / f"{module_name}.md"

    # Gather source files.
    source_files = _gather_source_files(module_name, factory_dir)

    # Load persona prompt.
    try:
        persona_prompt = _read_persona_prompt("factory_self_context")
    except Exception as exc:  # noqa: BLE001
        return {
            "module": module_name,
            "success": False,
            "error": f"persona_load_failed: {exc!r}",
        }

    # Assemble prompt.
    prompt = _build_refresh_prompt(
        module_name=module_name,
        topic=topic,
        source_files=source_files,
        persona_prompt=persona_prompt,
    )

    if dry_run:
        print(f"[self_context] dry-run: would refresh module={module_name!r}")
        print(f"[self_context] prompt length={len(prompt)} chars")
        print(prompt[:500] + ("..." if len(prompt) > 500 else ""))
        return {
            "module": module_name,
            "success": True,
            "skipped_reason": "dry_run",
            "path": str(output_path),
        }

    # Call LLM.
    try:
        raw = text_run(
            "factory_self_context",
            prompt,
            model_id,
            max_tokens=max_tokens,
        )
    except Exception as exc:  # noqa: BLE001
        err = f"llm_failed: {exc!r}"
        _log_event(
            root,
            "context_module_refresh_failed",
            {"module": module_name, "error": err},
        )
        return {
            "module": module_name,
            "success": False,
            "error": err,
        }

    content = str(raw) if not isinstance(raw, str) else raw
    # Cap at 16 KB.
    if len(content) > _MODULE_OUTPUT_CAP:
        content = content[:_MODULE_OUTPUT_CAP] + "\n\n...[truncated at 16KB]\n"

    # Atomic write.
    try:
        _atomic_write(output_path, content)
    except Exception as exc:  # noqa: BLE001
        err = f"write_failed: {exc!r}"
        _log_event(
            root,
            "context_module_refresh_failed",
            {"module": module_name, "error": err},
        )
        return {
            "module": module_name,
            "success": False,
            "error": err,
        }

    _log_event(
        root,
        "context_module_refreshed",
        {"module": module_name, "path": str(output_path), "size_chars": len(content)},
    )

    return {
        "module": module_name,
        "success": True,
        "path": str(output_path),
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def refresh_factory_context(
    *,
    root: Path,
    module: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Refresh one or all factory self-context modules.

    Parameters
    ----------
    root:
        Factory root directory (software_factory_root).
    module:
        If provided, refresh only this module (must be one of ALL_MODULES).
        If None, refresh all six.
    dry_run:
        If True, assemble prompts but do NOT call the LLM and do NOT write files.

    Returns
    -------
    dict with keys:
        results: list[dict]  — one per module attempted
        refreshed: int       — count of successful refreshes
        failed: int          — count of failures
    """
    from factory.model_router import max_output_tokens_for, route

    root = Path(root)
    factory_dir = Path(__file__).resolve().parent.parent
    output_dir = root / "apps" / "factory" / "context" / "modules"

    modules_to_refresh: list[str]
    if module is not None:
        if module not in ALL_MODULES:
            return {
                "results": [
                    {
                        "module": module,
                        "success": False,
                        "error": f"unknown module: {module!r}. Valid: {ALL_MODULES}",
                    }
                ],
                "refreshed": 0,
                "failed": 1,
            }
        modules_to_refresh = [module]
    else:
        modules_to_refresh = list(ALL_MODULES)

    # Was ``route("manager_summarizer")`` (a borrowed tier-selector, not this
    # module's own persona) — that route entry was deleted 2026-08-07 with
    # the L2 Summarizer tier. This module's own persona is
    # ``factory_self_context`` (the prompt read below); give it its own
    # route entry instead of piggy-backing on a deleted one.
    model_id = route("factory_self_context")  # mid-tier: gpt-5.4
    max_tokens = max_output_tokens_for(model_id)

    results: list[dict[str, Any]] = []
    for mod_name in modules_to_refresh:
        result = _refresh_one_module(
            module_name=mod_name,
            factory_dir=factory_dir,
            output_dir=output_dir,
            root=root,
            model_id=model_id,
            max_tokens=max_tokens,
            dry_run=dry_run,
        )
        results.append(result)

    refreshed = sum(1 for r in results if r.get("success") and not r.get("skipped_reason"))
    failed = sum(1 for r in results if not r.get("success"))

    return {
        "results": results,
        "refreshed": refreshed,
        "failed": failed,
    }


__all__ = [
    "ALL_MODULES",
    "refresh_factory_context",
    "_gather_source_files",
    "_atomic_write",
    "_build_refresh_prompt",
    "_log_event",
    "_context_refresh_event_path",
]
