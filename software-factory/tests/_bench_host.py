"""Skip marker for tests that need the benchmark HOST, not just the repo.

Some bench tests read a second checkout (``/home/k/sssf``, overridable with
``SSSF_ROOT``) and pi's model registry (``~/.pi/agent/models.json``). Those exist
on the bench host and nowhere else — CI has neither, so the tests failed there
by construction and held every PR behind a red ``main-green``. On the bench host
they still run in full; the skip fires only when the files are absent.

Reproduce CI locally: ``SSSF_ROOT=/nonexistent HOME=$(mktemp -d) uv run pytest …``.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

SSSF_ROOT = Path(os.environ.get("SSSF_ROOT", "/home/k/sssf"))
PI_MODELS = Path.home() / ".pi" / "agent" / "models.json"
HAVE_BENCH_HOST = (SSSF_ROOT / "adws" / "adw_simple_sdlc.py").is_file() and PI_MODELS.is_file()

requires_bench_host = pytest.mark.skipif(
    not HAVE_BENCH_HOST,
    reason=f"needs the bench host: {SSSF_ROOT}/adws and {PI_MODELS} (absent in CI)",
)
