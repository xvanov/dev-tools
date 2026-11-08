"""factory/ci_scope.py: which PR checks the CI watch counts."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from factory import ci_scope
from factory.app_config import AppConfig
from factory.chain import auto_merge as am
from factory.chain import delivery_gate
from factory.jobs import github as gh_mod

LINUX = "software-factory (ubuntu-latest)"
WINDOWS = "software-factory (windows-latest)"
GATE = "software-factory (windows-latest, 2.x gate)"

_WORKFLOW = """
name: CI
on: [push]
jobs:
  software-factory:
    name: software-factory (${{ matrix.os }})
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    continue-on-error: ${{ matrix.os != 'ubuntu-latest' }}
    steps:
      - run: echo hi
        continue-on-error: true
  software-factory-windows-2x:
    name: software-factory (windows-latest, 2.x gate)
    runs-on: windows-latest
    steps: [{run: echo}]
  nightly:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps: [{run: echo}]
  docs:
    strategy:
      matrix:
        py: ['3.12']
    continue-on-error: "true"
    runs-on: ubuntu-latest
    steps: [{run: echo}]
  weird:
    runs-on: ubuntu-latest
    continue-on-error: ${{ github.event_name == 'push' }}
    steps: [{run: echo}]
"""


def _cfg(**kw: Any) -> AppConfig:
    return AppConfig(name="demo", repo="o/r", **kw)


def _repo(tmp_path: Path, text: str = _WORKFLOW) -> Path:
    wf = tmp_path / ".github" / "workflows"
    wf.mkdir(parents=True)
    (wf / "ci.yml").write_text(text, encoding="utf-8")
    return tmp_path


def _gh(branch: Any = None, rules: Any = None) -> Any:
    def get(path: str) -> Any:
        if "/rules/branches/" in path:
            return rules
        if "/branches/" in path:
            return branch
        raise AssertionError(path)

    return get


def _run(name: str, status: str = "COMPLETED", conclusion: str = "SUCCESS") -> dict[str, Any]:
    return {"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion}


def test_workflow_continue_on_error_jobs_are_informational(tmp_path: Path) -> None:
    names = ci_scope.informational_jobs(_repo(tmp_path))
    # matrix expression evaluated per leg; literal true and "true" count; a step's
    # continue-on-error and an expression it cannot evaluate do not.
    assert names == [WINDOWS, "nightly", "docs (3.12)"]


def test_no_protection_no_config_uses_workflows(tmp_path: Path) -> None:
    scope = ci_scope.resolve_ci_scope(
        _cfg(ci_informational_checks=["codecov/*"]),
        repo_root=_repo(tmp_path),
        gh_json=_gh({"protected": False}, []),
    )
    assert scope.source == ci_scope.SOURCE_INFORMATIONAL
    assert scope.required is None
    assert scope.counts(LINUX) and scope.counts(GATE)
    assert not scope.counts(WINDOWS)
    assert not scope.counts("codecov/patch")


def test_branch_protection_and_rulesets_win(tmp_path: Path) -> None:
    branch = {
        "protected": True,
        "protection": {
            "required_status_checks": {"contexts": [LINUX], "checks": [{"context": GATE}]}
        },
    }
    rules = [
        {"type": "pull_request"},
        {
            "type": "required_status_checks",
            "parameters": {"required_status_checks": [{"context": "lint"}]},
        },
    ]
    scope = ci_scope.resolve_ci_scope(
        _cfg(ci_required_checks=["ignored-because-github-wins"]),
        repo_root=_repo(tmp_path),
        gh_json=_gh(branch, rules),
    )
    assert scope.source == ci_scope.SOURCE_PROTECTION
    assert scope.required == {LINUX, GATE, "lint"}
    assert not scope.counts(WINDOWS)
    assert not scope.counts("nightly-extra")


def test_config_required_list_when_github_has_none(tmp_path: Path) -> None:
    # gh unreadable (None) falls through, never blocks.
    scope = ci_scope.resolve_ci_scope(
        _cfg(ci_required_checks=[LINUX, " "]), repo_root=_repo(tmp_path), gh_json=_gh(None, None)
    )
    assert scope.source == ci_scope.SOURCE_CONFIG
    assert scope.required == {LINUX}


def test_apply_waits_for_unreported_required_only_while_ci_runs() -> None:
    scope = ci_scope.CiScope(frozenset({LINUX, GATE}), (), ci_scope.SOURCE_PROTECTION)
    running = [_run(LINUX), _run(WINDOWS, "IN_PROGRESS", "")]
    kept, ignored = scope.apply(running)
    assert ignored == [WINDOWS]
    assert gh_mod.summarize_checks(kept) == {"state": "pending", "failing": [], "pending": [GATE]}
    # CI finished and the required gate never reported (path filter): ignored.
    kept, _ = scope.apply([_run(LINUX), _run(WINDOWS, conclusion="FAILURE")])
    assert gh_mod.summarize_checks(kept)["state"] == "passing"


def test_informational_red_or_running_does_not_decide() -> None:
    scope = ci_scope.CiScope(None, (WINDOWS,))
    rows = [_run(LINUX), _run(GATE), _run(WINDOWS, conclusion="FAILURE")]
    kept, ignored = scope.apply(rows)
    assert gh_mod.summarize_checks(kept)["state"] == "passing"
    assert ignored == [WINDOWS]
    kept, _ = scope.apply([_run(LINUX), _run(WINDOWS, "IN_PROGRESS", "")])
    assert gh_mod.summarize_checks(kept)["state"] == "passing"
    # A counted red still fails.
    kept, _ = scope.apply([_run(LINUX, conclusion="FAILURE"), _run(WINDOWS)])
    assert gh_mod.summarize_checks(kept)["failing"] == [LINUX]


def test_cache_is_per_repo_and_base_and_expires(tmp_path: Path) -> None:
    ci_scope.clear_cache()
    calls: list[str] = []

    def get(path: str) -> Any:
        calls.append(path)
        return None

    clock = [0.0]
    cfg = _cfg(ci_informational_checks=["x"])
    for _ in range(2):
        ci_scope.resolve_ci_scope(
            cfg, repo_root=tmp_path, gh_json=get, use_cache=True, now=lambda: clock[0]
        )
    assert len(calls) == 2  # branch + rules, once
    clock[0] = ci_scope.CACHE_TTL_S + 1
    ci_scope.resolve_ci_scope(
        cfg, repo_root=tmp_path, gh_json=get, use_cache=True, now=lambda: clock[0]
    )
    assert len(calls) == 4
    ci_scope.clear_cache()


def test_watch_ignores_informational_windows_leg(monkeypatch: pytest.MonkeyPatch) -> None:
    """The chain's CI watch (_query_pr_checks): a red / running informational
    leg is neither a failure nor a reason to keep waiting."""
    rollup = [_run(LINUX), _run(GATE), _run(WINDOWS, conclusion="FAILURE")]
    out = json.dumps({"statusCheckRollup": rollup, "headRefOid": "d" * 40})
    monkeypatch.setattr(
        subprocess, "run", lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, out, "")
    )
    monkeypatch.setattr(
        ci_scope, "resolve_ci_scope", lambda *a, **k: ci_scope.CiScope(None, (WINDOWS,))
    )
    ci = am._query_pr_checks(app_config=_cfg(), pr_number=5)
    assert ci is not None
    assert ci["state"] == "passing"
    assert ci["failing"] == [] and ci["genuine"] == []
    assert ci["ignored"] == [WINDOWS]


def test_job_status_ci_ignores_informational(monkeypatch: pytest.MonkeyPatch) -> None:
    rollup = [_run(LINUX), _run(WINDOWS, "IN_PROGRESS", "")]

    def fake(args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args, 0, json.dumps({"statusCheckRollup": rollup}), "")

    monkeypatch.setattr(gh_mod, "_run_gh", fake)
    view = gh_mod.GitHubView("o/r")
    ci = view.ci(5, ci_scope.CiScope(None, (WINDOWS,)))
    assert ci == {"state": "passing", "failing": [], "pending": [], "ignored": [WINDOWS]}
    # No scope: unchanged behaviour (every check counts).
    assert gh_mod.GitHubView("o/r").ci(5)["state"] == "pending"


def test_push_to_main_preflight_ignores_informational(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    responses: dict[str, Any] = {
        "rules/branches/main": [],
        "branches/main": {"protected": False},
        "check-runs": {
            "check_runs": [
                {"name": LINUX, "status": "completed", "conclusion": "success"},
                {"name": WINDOWS, "status": "in_progress"},
            ]
        },
        "/status": {"statuses": []},
    }

    def run(cmd: list[str], *a: Any, **k: Any) -> subprocess.CompletedProcess[str]:
        for key, val in responses.items():
            if key in cmd[2]:
                return subprocess.CompletedProcess(cmd, 0, json.dumps(val), "")
        raise AssertionError(cmd)

    cfg = _cfg(app_repo_path=str(_repo(tmp_path)))
    got, why = delivery_gate.push_to_main_preflight(cfg, "main", run=run)
    assert got == delivery_gate.PREFLIGHT_OK, why
    # The same leg counts when nothing marks it informational.
    got, _ = delivery_gate.push_to_main_preflight(
        _cfg(app_repo_path=str(tmp_path / "x")), "main", run=run
    )
    assert got == delivery_gate.PREFLIGHT_HOLD
