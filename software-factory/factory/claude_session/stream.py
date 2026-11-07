"""Parse Claude Code ``--output-format stream-json`` output. Pure; no I/O beyond reading text.

A ``claude -p --output-format stream-json --verbose`` run prints one JSON object
per line. The one the factory needs is the LAST ``{"type": "result", …}``
event: it carries ``session_id``, ``total_cost_usd`` (what the run would have
cost at API prices — on a subscription it is NOT billed), ``usage`` and
``is_error``. Everything else (``system``/``assistant``/``user`` events) is the
transcript a human watches live.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ClaudeResult:
    """What one ``claude -p`` invocation reported in its final ``result`` event."""

    found: bool = False
    session_id: str | None = None
    is_error: bool = True
    subtype: str = ""
    result_text: str = ""
    total_cost_usd: float = 0.0
    tokens_in: int = 0  # input + cache creation + cache read
    tokens_out: int = 0
    cached_input_tokens: int = 0
    num_turns: int = 0
    duration_ms: int = 0
    model: str | None = None
    last_assistant_text: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def iter_events(text: str) -> list[dict[str, Any]]:
    """Every JSON object line in ``text``; non-JSON lines are skipped."""
    out: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _assistant_text(event: dict[str, Any]) -> str:
    message = event.get("message") or {}
    parts = message.get("content") if isinstance(message, dict) else None
    if not isinstance(parts, list):
        return ""
    return "\n".join(
        str(p.get("text") or "") for p in parts if isinstance(p, dict) and p.get("type") == "text"
    ).strip()


def parse_stream(text: str) -> ClaudeResult:
    """Summarise one invocation's stream. ``found`` is False when no result event
    exists (the process was killed, crashed, or never started)."""
    res = ClaudeResult()
    for ev in iter_events(text):
        etype = ev.get("type")
        if etype == "system" and ev.get("subtype") == "init":
            res.session_id = ev.get("session_id") or res.session_id
            res.model = ev.get("model") or res.model
        elif etype == "assistant":
            said = _assistant_text(ev)
            if said:
                res.last_assistant_text = said
            message = ev.get("message") or {}
            for part in message.get("content") or [] if isinstance(message, dict) else []:
                if isinstance(part, dict) and part.get("type") == "tool_use":
                    res.tool_calls.append(
                        {
                            "tool": str(part.get("name") or "?"),
                            "args": json.dumps(part.get("input") or {}, default=str)[:300],
                        }
                    )
        elif etype == "result":
            res.found = True
            res.session_id = ev.get("session_id") or res.session_id
            res.is_error = bool(ev.get("is_error", False)) or ev.get("subtype") not in (
                None,
                "success",
            )
            res.subtype = str(ev.get("subtype") or "")
            res.result_text = str(ev.get("result") or "")
            res.total_cost_usd = _float(ev.get("total_cost_usd"))
            usage = ev.get("usage") or {}
            if isinstance(usage, dict):
                cache_read = _int(usage.get("cache_read_input_tokens"))
                res.tokens_in = (
                    _int(usage.get("input_tokens"))
                    + _int(usage.get("cache_creation_input_tokens"))
                    + cache_read
                )
                res.cached_input_tokens = cache_read
                res.tokens_out = _int(usage.get("output_tokens"))
            res.num_turns = _int(ev.get("num_turns"))
            res.duration_ms = _int(ev.get("duration_ms"))
    return res


def render_event(event: dict[str, Any]) -> str | None:
    """One human-readable line (or block) for the live terminal, or ``None``."""
    etype = event.get("type")
    if etype == "system" and event.get("subtype") == "init":
        return (
            f"── Claude Code session {event.get('session_id', '?')} "
            f"(model {event.get('model', '?')}, cwd {event.get('cwd', '?')})"
        )
    if etype == "assistant":
        message = event.get("message") or {}
        lines: list[str] = []
        for part in message.get("content") or [] if isinstance(message, dict) else []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and str(part.get("text") or "").strip():
                lines.append(str(part["text"]).rstrip())
            elif part.get("type") == "tool_use":
                args = json.dumps(part.get("input") or {}, default=str)
                lines.append(f"  ▸ {part.get('name', '?')} {args[:200]}")
        return "\n".join(lines) or None
    if etype == "user":
        message = event.get("message") or {}
        for part in message.get("content") or [] if isinstance(message, dict) else []:
            if isinstance(part, dict) and part.get("type") == "tool_result":
                content = part.get("content")
                if isinstance(content, list):
                    content = " ".join(
                        str(c.get("text") or "") for c in content if isinstance(c, dict)
                    )
                text = " ".join(str(content or "").split())
                mark = "✗" if part.get("is_error") else "✓"
                return f"    {mark} {text[:160]}"
        return None
    if etype == "result":
        return (
            f"── result: {event.get('subtype', '?')} "
            f"error={bool(event.get('is_error'))} turns={event.get('num_turns', '?')} "
            f"api-equivalent ${_float(event.get('total_cost_usd')):.4f}"
        )
    return None


__all__ = ["ClaudeResult", "iter_events", "parse_stream", "render_event"]
