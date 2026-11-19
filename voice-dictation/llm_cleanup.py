#!/usr/bin/env python3
"""
Cleanup pass for voice transcription.

Backends (checked in order):
  1. Claude API  — fastest + smartest; set ANTHROPIC_API_KEY env var
  2. Ollama      — local LLM; set OLLAMA_CLEANUP=1 (default off) + OLLAMA_MODEL
  3. Python      — instant regex; always available as fallback

Force a specific backend: CLEANUP_BACKEND=claude|ollama|python
"""

import os
import re
import tempfile

_BACKEND = os.environ.get("CLEANUP_BACKEND", "").lower()
_ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
_OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
_OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:1b")
_OLLAMA_ENABLED = os.environ.get("OLLAMA_CLEANUP", "0").strip() == "1"

_CONFIG_FILE = os.path.join(tempfile.gettempdir(), "vd-cleanup-backend.txt")


def _read_config_backend() -> str:
    try:
        with open(_CONFIG_FILE) as f:
            return f.read().strip().lower()
    except Exception:
        return ""


def get_active_backend() -> str:
    """Return which backend will actually be used — for display purposes."""
    b = _read_config_backend() or _BACKEND
    if b in ("claude", "ollama", "python"):
        return b
    if _ANTHROPIC_KEY:
        return "claude"
    if _OLLAMA_ENABLED:
        return "ollama"
    return "python"

_INSTRUCTION = (
    "Clean this voice dictation: remove filler words (um, uh, like, you know, "
    "kind of, basically, literally, right when used as filler, so when used as filler). "
    "Fix capitalization and punctuation. Preserve the speaker's meaning and word choice exactly. "
    "Output ONLY the cleaned text — no explanation, no quotes, no preamble."
)

# Reuse HTTP connection across calls
_session = None


def _get_session():
    global _session
    if _session is None:
        import requests
        _session = requests.Session()
    return _session


# ---------------------------------------------------------------------------
# Backend: Claude API
# ---------------------------------------------------------------------------

def _claude_cleanup(text: str) -> tuple:
    try:
        import anthropic
        # The SDK's default timeout is 10 minutes; a stalled request would
        # keep the recorder (and its running flag) alive that long.
        client = anthropic.Anthropic(api_key=_ANTHROPIC_KEY, timeout=15.0, max_retries=1)
        msg = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=300,
            system=_INSTRUCTION,
            messages=[{"role": "user", "content": text}],
        )
        result = msg.content[0].text.strip()
        return (result if result else text), "claude"
    except Exception:
        if _OLLAMA_ENABLED:
            return _ollama_cleanup(text)
        return _python_cleanup(text), "python(claude failed)"


# ---------------------------------------------------------------------------
# Backend: Ollama
# ---------------------------------------------------------------------------

def _ollama_cleanup(text: str) -> tuple:
    try:
        resp = _get_session().post(
            f"{_OLLAMA_HOST}/api/generate",
            json={
                "model": _OLLAMA_MODEL,
                "prompt": f"{_INSTRUCTION}\n\n{text}",
                "stream": False,
                "keep_alive": -1,
                "options": {"num_predict": 150, "temperature": 0},
            },
            timeout=20,
        )
        resp.raise_for_status()
        result = resp.json().get("response", "").strip()
        for marker in ("Here is", "Cleaned:", "Output:", "Result:"):
            if result.lower().startswith(marker.lower()):
                result = result.split("\n", 1)[-1].strip().strip('"')
        return (result if result else text), "ollama"
    except Exception:
        return _python_cleanup(text), "python(ollama failed)"


# ---------------------------------------------------------------------------
# Backend: Python regex (instant fallback)
# ---------------------------------------------------------------------------

_FILLER_RE = re.compile(
    r"\b(um+|uh+|umm+|uhh+|hmm+)\b[,]?"
    r"|\byou know[,]?"
    r"|\bI mean[,]?"
    r"|\bkind of\b"
    r"|\bsort of\b",
    flags=re.IGNORECASE,
)


def _python_cleanup(text: str) -> tuple:
    text = _FILLER_RE.sub(" ", text)
    text = re.sub(r" {2,}", " ", text)
    text = re.sub(r"\b(\w+) \1\b", r"\1", text, flags=re.IGNORECASE)
    text = re.sub(r",\s*,", ",", text)
    text = re.sub(r",\s*\.", ".", text)
    text = text.strip().strip(",").strip()
    text = re.sub(
        r"(^|(?<=[.!?])\s+)([a-z])",
        lambda m: m.group(1) + m.group(2).upper(),
        text,
    )
    if text and text[-1] not in ".!?":
        text += "."
    return text, "python"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def cleanup(text: str) -> tuple:
    """Return (cleaned_text, backend_name_used)."""
    if not text.strip():
        return text, "none"
    backend = get_active_backend()
    if backend == "claude":
        return _claude_cleanup(text)
    if backend == "ollama":
        return _ollama_cleanup(text)
    return _python_cleanup(text)
