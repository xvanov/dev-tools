"""Tests for the ux_auditor scheduled persona (Phase 6 D).

Dry-run with the built-in fixture files a ux-tagged direction citing
the 6-click confirmation flow. Rate-limit trip refuses the run.

NO Playwright invocation, NO sandbox_run in dry-run.
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
        settings["rate_limits"] = {"ux_auditor_runs_per_day": cap}
    (tmp_path / "factory_settings.yaml").write_text(yaml.safe_dump(settings), encoding="utf-8")
    (tmp_path / "state").mkdir()
    from factory.settings.loader import reload_settings

    reload_settings(tmp_path)
    return tmp_path


def test_ux_auditor_dry_run_files_friction_direction(tmp_path: Path) -> None:
    """The built-in fixture surfaces 1 friction finding for the pledge flow."""
    root = _write_root(tmp_path)
    out = run_scheduled_persona("ux_auditor", "sacrifice", root, dry_run=True)
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
    assert "type: ux" in md
    assert "pledge" in md


def test_ux_auditor_rate_limit_zero_refuses(tmp_path: Path) -> None:
    """``ux_auditor_runs_per_day: 0`` blocks the run before any sandbox call."""
    root = _write_root(tmp_path, cap=0)
    out = run_scheduled_persona("ux_auditor", "sacrifice", root, dry_run=True)
    assert out.status == "rejected"
    assert out.error == "ux_auditor_rate_limit_exceeded"
    assert out.findings_count == 0
