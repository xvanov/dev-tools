"""A benchmark sweep runs as wide as the host allows. Operator rule, 2026-08-11.

The old default of 4 workers made a 19-instance sweep take **7,297 s (2 h 2 m)**
when the longest single instance was 5,400 s. With 19 rows over 4 slots the pool
ran five batches, so most of that wall clock was rows queueing behind other rows
rather than measuring anything. A sweep's wall clock must be bounded by its
SLOWEST INSTANCE, not by its batch count.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_ADAPTER = _ROOT / "bench" / "swebench_adapter.py"


@pytest.fixture
def A() -> Any:  # noqa: N802
    spec = importlib.util.spec_from_file_location("_swe_parallel", _ADAPTER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_the_default_covers_a_whole_pinned_sweep_on_a_sweep_host(
    A: Any, monkeypatch: pytest.MonkeyPatch  # noqa: N803
) -> None:
    """On the machine sweeps actually run on, the 19 pinned instances fit in ONE
    batch.

    Simulated rather than read off the current host: CI runners have 4 cores, so
    asserting a bare ``>= 19`` would encode the developer's machine into the
    suite and fail in CI — which is exactly what the first cut of this test did.
    """
    monkeypatch.setattr(A.os, "cpu_count", lambda: 16)
    assert A._default_sweep_workers() >= 19
    monkeypatch.setattr(A.os, "cpu_count", lambda: 4)
    assert A._default_sweep_workers() >= 4, "a small host still gets a usable pool"


def test_the_default_is_never_the_old_fixed_four(A: Any, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: N803
    """4 was the old default and cost five batches on a 19-row sweep. Any host
    with more than 2 cores must now exceed it."""
    for cores in (4, 8, 16, 32):
        monkeypatch.setattr(A.os, "cpu_count", lambda c=cores: c)
        assert A._default_sweep_workers() > 4 or cores <= 2


def test_the_default_is_derived_from_the_host_and_capped(A: Any) -> None:  # noqa: N803
    """Derived, not hardcoded — a smaller host must still get a sane value — and
    capped, because each worker holds a prepared clone plus a container."""
    assert A._default_sweep_workers() == max(4, min(A._SWEEP_WORKERS_CEILING, (os.cpu_count() or 4) * 2))
    assert A._default_sweep_workers() <= A._SWEEP_WORKERS_CEILING


def test_run_all_uses_it_rather_than_a_literal(A: Any) -> None:  # noqa: N803
    import inspect

    src = inspect.getsource(A._build_parser) if hasattr(A, "_build_parser") else inspect.getsource(A)
    assert 'default=_default_sweep_workers()' in src
    assert 'p.add_argument("--workers", type=int, default=4)' not in src


def test_a_model_driven_sweep_defaults_to_the_provider_safe_width(A: Any) -> None:  # noqa: N803
    """18-wide lost ALL 18 rows to 429s on one shared deployment. Host width is
    the wrong limit for anything that calls a model."""
    assert A._PROVIDER_SAFE_WORKERS == 4
    for arm in ("factory", "solo-noreview", "openhands", "bare", "claude-5"):
        assert A.default_workers_for_arm(arm) == 4, arm
    # And it is a MINIMUM against host width, so a tiny host still narrows.
    assert A.default_workers_for_arm("factory") <= A._default_sweep_workers()


def test_backoff_is_not_the_answer_and_the_code_says_why(A: Any) -> None:
    """The SDK already retries with exponential backoff; the quota is
    tokens/minute, so more waiting buys no throughput. Recorded at the constant so
    the next session does not "fix" this by raising num_retries."""
    import inspect

    src = inspect.getsource(A)
    i = src.index("_PROVIDER_SAFE_WORKERS = 4")
    window = src[max(0, i - 2500) : i]
    assert "num_retries=5" in window
    assert "tokens/minute" in window or "tokens-per-minute" in window


def test_an_explicit_workers_override_is_still_honoured(A: Any) -> None:
    """A bigger quota or a second deployment must not require a code change."""
    import inspect

    src = inspect.getsource(A)
    assert "args.workers\n                if args.workers is not None" in src


def test_claude_md_carries_the_standing_instruction() -> None:
    """The rule has to survive the next session, which reads CLAUDE.md."""
    text = (_ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    assert "RUN BENCHMARKS AS WIDE AS THE LIMIT ALLOWS" in text
    assert "there are TWO limits" in text
    assert "7,297 s" in text, "name the measured cost, not a vague preference"
    # The correction: host width for free steps, provider width for model steps.
    assert "Free steps: host width" in text
    assert "Model-driven sweeps: PROVIDER width, which is 4" in text
    assert "backoff cannot fix it" in text
    # And the one real exception, so the next session does not re-derive it the
    # hard way: a full pytest run during a sweep produces false reds.
    assert "Do not run the full suite while a sweep is in flight" in text
    # And the width finding, which cost three separate false diagnoses.
    assert "`-n 8` is too wide for them on this host" in text
