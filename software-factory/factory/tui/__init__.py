"""Live terminal UI for the software factory (``factory tui``).

Think ``nvidia-smi`` but for the factory: per-app stats, in-flight
directions with EBS Monte Carlo ETAs, mid-flight personas with elapsed
times, spend windows (24h + 7d), velocity per (persona, model_tier),
and a tail of recent runs.

The TUI is a thin Textual app — all data shaping happens in
``factory.observability.queries``. To change what's shown, edit the
``Widgets`` here; to change what's available, edit ``queries.py``.
"""

from factory.tui.app import FactoryTUI, run_tui

__all__ = ["FactoryTUI", "run_tui"]
