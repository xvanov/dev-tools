"""Tests for the security scheduled persona (Phase 6 C).

Dry-run with the built-in fixture files a security-tagged direction
citing the rate-limit-on-/api/pledge finding. Rate-limit trip via
``security_runs_per_day:0`` refuses the run.

NO subprocess.run, NO LLM calls in dry-run.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from factory.chain.scheduled_tasks import run_scheduled_persona


def _write_root(tmp_path: Path, cap: int | None = None) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        yaml.safe_dump({"name": "sacrifice", "repo": "o/r"}), encoding="utf-8"
    )
    settings: dict[str, Any] = {
        "modes": {"default": "normal", "available": ["normal", "paused"]},
    }
    if cap is not None:
        settings["rate_limits"] = {"security_runs_per_day": cap}
    (tmp_path / "factory_settings.yaml").write_text(yaml.safe_dump(settings), encoding="utf-8")
    (tmp_path / "state").mkdir()
    from factory.settings.loader import reload_settings

    reload_settings(tmp_path)
    return tmp_path


def test_security_dry_run_files_pledge_rate_limit_direction(tmp_path: Path) -> None:
    """The built-in fixture surfaces 1 medium severity rate-limit gap."""
    root = _write_root(tmp_path)
    out = run_scheduled_persona("security", "sacrifice", root, dry_run=True)
    assert out.status == "dry_run"
    assert out.findings_count == 1
    assert len(out.directions_filed) == 1
    # Phase 7: dry-run direction writes land under state/dry_run_scratch/.
    matches = list(
        (root / "state" / "dry_run_scratch" / "apps" / "sacrifice" / "directions").glob(
            f"{out.directions_filed[0]}-*"
        )
    )
    assert len(matches) == 1
    md = (matches[0] / "direction.md").read_text(encoding="utf-8")
    assert "type: security" in md
    assert "/api/pledge" in md


def test_security_rate_limit_zero_refuses(tmp_path: Path) -> None:
    """``security_runs_per_day: 0`` blocks the run before any LLM call."""
    root = _write_root(tmp_path, cap=0)
    out = run_scheduled_persona("security", "sacrifice", root, dry_run=True)
    assert out.status == "rejected"
    assert out.error == "security_rate_limit_exceeded"
    assert out.findings_count == 0
