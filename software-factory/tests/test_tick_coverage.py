"""JOBS-API v1.6 — ``ticked``: a job for an app nothing ticks says so (8.4.24).

On the personal stack a review-fix job for an app serve did not tick sat
``queued`` for 340 s saying "waiting for pm-sync on the next factory tick",
while submit, the PA's dry run and Build said nothing. Submit now warns, status
says why, and ``app list`` reports it.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

import factory.cli_apps as cli_apps
import factory.cli_jobs as cli_jobs
import factory.scheduler.serve as serve_mod
from factory.scheduler.coverage import TickCoverage, read_coverage


def _write_app(root: Path, name: str) -> None:
    d = root / "apps" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.yaml").write_text(f"name: {name}\nrepo: acme/{name}\n", encoding="utf-8")


def _serve_json(root: Path, apps: list[str], *, age_s: float = 0.0) -> None:
    d = root / "state" / "scheduler"
    d.mkdir(parents=True, exist_ok=True)
    at = (datetime.now(UTC) - timedelta(seconds=age_s)).isoformat(timespec="seconds")
    (d / "serve.json").write_text(
        json.dumps({"pid": 1, "updated_at": at, "apps": apps}), encoding="utf-8"
    )


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    _write_app(tmp_path, "ticked")
    _write_app(tmp_path, "idle")
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(cli_jobs, "_FACTORY_ROOT", tmp_path)
    monkeypatch.setattr(cli_apps, "_FACTORY_ROOT", tmp_path)
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(tmp_path))
    monkeypatch.setattr(serve_mod, "systemd_timers_active", lambda: [])
    return tmp_path


def _cli(*args: str) -> tuple[int, Any]:
    from factory.cli import app

    result = CliRunner().invoke(app, list(args))
    out = result.stdout.strip()
    return result.exit_code, (json.loads(out) if out.startswith("{") else out)


def _submit(app: str) -> dict[str, Any]:
    code, obj = _cli(
        "job", "submit", "--json", "--app", app, "--title", "Add a footer",
        "--ask", "Add a footer.", "--done", "GET / shows the footer", "--source", "pa",
    )
    assert code == 0, obj
    return obj


# --------------------------------------------------------------------------- #
# the coverage itself
# --------------------------------------------------------------------------- #


def test_serve_ticks_only_its_apps(root: Path) -> None:
    _serve_json(root, ["ticked"])
    cov = read_coverage(root)
    assert cov.ticked("ticked") is True
    assert cov.ticked("idle") is False
    why = cov.why_not("idle") or ""
    assert "factory serve ticks ticked" in why and "serve_tick: true" in why
    assert cov.why_not("ticked") is None


def test_unknown_when_nothing_was_ever_seen(root: Path) -> None:
    cov = read_coverage(root)
    assert cov.ticked("idle") is None and cov.why_not("idle") is None


def test_a_stale_serve_is_not_running(root: Path) -> None:
    _serve_json(root, ["ticked"], age_s=3600)
    cov = read_coverage(root)
    assert cov.ticked("ticked") is False
    assert "factory serve is not running" in (cov.why_not("ticked") or "")


def test_a_systemd_timer_ticks_its_app_and_is_asked_lazily(root: Path) -> None:
    asked: list[int] = []

    def timers() -> list[str]:
        asked.append(1)
        return ["factory-tick@idle.timer"]

    _serve_json(root, ["ticked"])
    cov = read_coverage(root, timers=timers)
    assert cov.ticked("ticked") is True and asked == []
    assert cov.ticked("idle") is True and asked == [1]
    assert TickCoverage(None, False, timers).ticked("other") is False


# --------------------------------------------------------------------------- #
# submit, status, app list
# --------------------------------------------------------------------------- #


def test_submit_warns_for_an_app_serve_does_not_tick(root: Path) -> None:
    _serve_json(root, ["ticked"])
    idle = _submit("idle")
    assert idle["ticked"] is False
    assert any(w.startswith("ticker: app idle is not ticked") for w in idle["warnings"]), idle
    ok = _submit("ticked")
    assert ok["ticked"] is True
    assert not any(w.startswith("ticker:") for w in ok["warnings"])


def test_status_says_why_a_queued_job_never_starts(root: Path) -> None:
    _serve_json(root, ["ticked"])
    job = _submit("idle")["job_id"]
    code, st = _cli("job", "status", job, "--json", "--no-github")
    assert code == 0, st
    assert st["state"] == "queued" and st["ticked"] is False
    assert st["why"].startswith("waiting: app idle is not ticked")
    code, listed = _cli("job", "list", "--json", "--no-github")
    assert {j["job_id"]: j["ticked"] for j in listed["jobs"]} == {job: False}


def test_status_keeps_the_tick_wait_when_unknown(root: Path) -> None:
    job = _submit("idle")["job_id"]
    _, st = _cli("job", "status", job, "--json", "--no-github")
    assert st["ticked"] is None and st["why"] == "waiting for pm-sync on the next factory tick"


def test_app_list_reports_ticked(root: Path) -> None:
    _serve_json(root, ["ticked"])
    code, out = _cli("app", "list", "--json")
    assert code == 0, out
    assert {a["app"]: a["ticked"] for a in out["apps"]} == {"idle": False, "ticked": True}
