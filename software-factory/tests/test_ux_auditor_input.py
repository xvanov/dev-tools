"""Tests for scheduled UX audit runtime inputs (story D009 narrow-read + D017 attach gate findings)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from factory.chain.scheduled_tasks import (
    _build_ux_auditor_context,
    _collect_flow_artifacts,
    _collect_tests_meaningful_findings,
    _file_finding_as_direction,
    _live_run,
    run_scheduled_persona,
)


def _write_app(
    tmp_path: Path,
    *,
    app: str = "sacrifice",
    with_flow: bool = True,
    health_check_command: str | None = None,
) -> Path:
    apps = tmp_path / "apps" / app
    apps.mkdir(parents=True)
    config: dict[str, Any] = {"name": app, "repo": "o/r"}
    if health_check_command is not None:
        config["deploy"] = {
            "enabled": True,
            "health_check_command": health_check_command,
        }
    (apps / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")

    directions = apps / "directions"
    directions.mkdir(parents=True, exist_ok=True)
    if with_flow:
        flow_dir = directions / "001-checkout-flow"
        flow_dir.mkdir(parents=True)
        (flow_dir / "direction.md").write_text(
            "---\ntitle: Checkout flow\ntype: ux\nexplore: false\n---\n# Checkout\n",
            encoding="utf-8",
        )
        (flow_dir / "flow.md").write_text(
            "# checkout-flow.md\n\n1. Open app\n2. Choose plan\n3. Confirm purchase\n",
            encoding="utf-8",
        )
        (flow_dir / "state.yaml").write_text(
            yaml.safe_dump({"status": "created", "source": "cli"}),
            encoding="utf-8",
        )

    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    return tmp_path


def test_collect_flow_artifacts_returns_filename_and_steps(tmp_path: Path) -> None:
    root = _write_app(tmp_path)

    artifacts = _collect_flow_artifacts("sacrifice", root)

    assert artifacts == [
        (
            "001-checkout-flow/flow.md",
            "# checkout-flow.md\n\n1. Open app\n2. Choose plan\n3. Confirm purchase",
        )
    ]


def test_build_context_requires_at_least_one_flow_artifact(tmp_path: Path) -> None:
    root = _write_app(tmp_path, with_flow=False)

    with pytest.raises(ValueError, match="flow.md"):
        _build_ux_auditor_context("sacrifice", root)


def test_build_context_includes_app_url_context(tmp_path: Path) -> None:
    root = _write_app(
        tmp_path,
        health_check_command="curl -fsS https://app.example.test/healthz",
    )

    context = _build_ux_auditor_context("sacrifice", root)

    assert "### App URL Context" in context
    assert "https://app.example.test/healthz" in context


def test_build_context_includes_runtime_context_fields(tmp_path: Path) -> None:
    root = _write_app(tmp_path)

    context = _build_ux_auditor_context("sacrifice", root)

    assert "### Runtime Context" in context
    assert f"- Software factory root: `{root}`" in context
    assert "- Target app: `sacrifice`" in context


def test_live_run_ux_prompt_contains_flow_and_runtime_inputs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _write_app(
        tmp_path,
        health_check_command="curl -fsS https://app.example.test/healthz",
    )
    captured: dict[str, Any] = {}

    def _fake_prelude(*_args: Any, **_kwargs: Any) -> str:
        return "PRELUDE"

    def _fake_text_run(
        _persona: str,
        prompt: str,
        _model: str,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        captured["prompt"] = prompt
        return {"findings": [], "duration_s": 0.2}

    monkeypatch.setattr("factory.context.loader.compose_context_prelude", _fake_prelude)
    monkeypatch.setattr("factory.runner.text_run", _fake_text_run)
    monkeypatch.setattr("factory.chain.scheduled_tasks.route", lambda _persona: "fake-model")

    out = _live_run("ux_auditor", "sacrifice", root)

    assert out == {"findings": [], "duration_s": 0.2}
    prompt = str(captured["prompt"])
    assert "## Scheduled UX Audit Runtime Inputs" in prompt
    assert "001-checkout-flow/flow.md" in prompt
    assert "1. Open app" in prompt
    assert "https://app.example.test/healthz" in prompt
    assert "### Runtime Context" in prompt
    assert "# Context prelude\n\nPRELUDE" in prompt


def test_live_run_non_ux_prompt_is_unchanged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _write_app(tmp_path)
    captured: dict[str, Any] = {}

    def _fake_prelude(*_args: Any, **_kwargs: Any) -> str:
        return "PRELUDE"

    def _fake_text_run(
        _persona: str,
        prompt: str,
        _model: str,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        captured["prompt"] = prompt
        return {}

    monkeypatch.setattr("factory.context.loader.compose_context_prelude", _fake_prelude)
    monkeypatch.setattr("factory.runner.text_run", _fake_text_run)
    monkeypatch.setattr("factory.chain.scheduled_tasks.route", lambda _persona: "fake-model")

    _live_run("security", "sacrifice", root)

    assert "Scheduled UX Audit Runtime Inputs" not in str(captured["prompt"])


def test_run_scheduled_persona_skips_when_ux_live_run_has_no_flow_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _write_app(tmp_path, with_flow=False)

    monkeypatch.setattr("factory.chain.scheduled_tasks.route", lambda _persona: "fake-model")
    monkeypatch.setattr(
        "factory.context.loader.compose_context_prelude",
        lambda *_args, **_kwargs: "PRELUDE",
    )
    monkeypatch.setattr(
        "factory.runner.text_run",
        lambda *_args, **_kwargs: pytest.fail("text_run should not execute without flow.md"),
    )

    out = run_scheduled_persona("ux_auditor", "sacrifice", root, dry_run=False)

    assert out.status == "rejected"
    assert out.findings_count == 0
    assert out.error == "ux_auditor_no_flow_artifacts"


def test_file_finding_creates_flow_md_for_ux_finding(tmp_path: Path) -> None:
    root = _write_app(tmp_path, with_flow=False)

    finding = {
        "flow": "checkout-flow.md",
        "step": 2,
        "kind": "friction",
        "evidence": "Too many confirmation clicks",
        "suggestion": "Collapse to one confirmation",
        "suggested_direction": {
            "title": "simplify checkout confirmation",
            "type": "ux",
            "why": "Checkout requires redundant confirmations.",
            "acceptance": ["Checkout completes in <= 2 clicks after selecting plan"],
        },
    }

    direction = _file_finding_as_direction(
        persona="ux_auditor",
        app="sacrifice",
        finding=finding,
        software_factory_root=root,
        dry_run=False,
    )

    assert direction is not None
    flow_md = direction.dir_path / "flow.md"
    assert flow_md.exists()
    flow_text = flow_md.read_text(encoding="utf-8")
    assert "Flow: checkout-flow.md" in flow_text
    assert "Step: 2" in flow_text


def test_live_run_is_not_blocked_when_flow_md_is_available(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """UX auditor live run proceeds normally when flow.md artifacts exist."""
    root = _write_app(tmp_path, with_flow=True)

    monkeypatch.setattr("factory.chain.scheduled_tasks.route", lambda _persona: "fake-model")
    monkeypatch.setattr(
        "factory.context.loader.compose_context_prelude",
        lambda *_args, **_kwargs: "PRELUDE",
    )
    monkeypatch.setattr(
        "factory.runner.text_run",
        lambda *_args, **_kwargs: {"findings": [], "duration_s": 0.1},
    )

    out = run_scheduled_persona("ux_auditor", "sacrifice", root, dry_run=False)

    assert out.status == "ok"
    assert out.findings_count == 0


def test_dry_run_does_not_require_flow_md_artifacts(tmp_path: Path) -> None:
    """Dry-run uses fixtures and should not be gated on flow.md availability."""
    root = _write_app(tmp_path, with_flow=False)

    out = run_scheduled_persona("ux_auditor", "sacrifice", root, dry_run=True)

    assert out.status == "dry_run"
    assert out.findings_count == 1


# --------------------------------------------------------------------------- #
# D017: attach gate findings to UX audit inputs
# --------------------------------------------------------------------------- #


def _write_slop_test_file(path: Path, content: str) -> None:
    """Write a test file containing a known slop anti-pattern."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _write_app_with_slop_tests(
    tmp_path: Path,
    *,
    app: str = "sacrifice",
    with_flow: bool = True,
    health_check_command: str | None = None,
) -> Path:
    """Write app config + flow artifacts + a sloppy test file under the app repo."""
    root = _write_app(
        tmp_path, app=app, with_flow=with_flow, health_check_command=health_check_command
    )
    # Place a sloppy test file under the app's repo checkout area.
    # The repo checkout is at apps/<app>/repo/ by convention.
    repo_dir = root / "apps" / app / "repo"
    repo_dir.mkdir(parents=True, exist_ok=True)
    _write_slop_test_file(
        repo_dir / "tests" / "test_sloppy.py",
        "def test_nothing():\n    assert True\n",
    )
    return root


# -- AC1.1: audit input includes reproducible tests-meaningful finding artifacts --


def test_collect_tests_meaningful_findings_finds_slop(tmp_path: Path) -> None:
    root = _write_app_with_slop_tests(tmp_path)

    findings = _collect_tests_meaningful_findings("sacrifice", root)

    assert len(findings) >= 1
    finding = findings[0]
    assert finding["kind"] == "assert True"
    assert "test_sloppy.py" in finding["path"]


def test_collect_tests_meaningful_findings_uses_repo_relative_paths(tmp_path: Path) -> None:
    root = _write_app_with_slop_tests(tmp_path)

    findings = _collect_tests_meaningful_findings("sacrifice", root)

    assert findings[0]["path"] == "tests/test_sloppy.py"


def test_collect_tests_meaningful_findings_reproducible(tmp_path: Path) -> None:
    """AC1.1: Fixture output is reproducible — same input → same findings."""
    root = _write_app_with_slop_tests(tmp_path)

    first = _collect_tests_meaningful_findings("sacrifice", root)
    second = _collect_tests_meaningful_findings("sacrifice", root)

    assert first == second


def test_collect_tests_meaningful_findings_empty_when_no_slop(tmp_path: Path) -> None:
    root = _write_app(tmp_path)

    findings = _collect_tests_meaningful_findings("sacrifice", root)

    assert findings == []


# -- AC1.1: audit input includes finding artifacts --


def test_build_ux_context_includes_gate_findings_section(tmp_path: Path) -> None:
    root = _write_app_with_slop_tests(tmp_path)

    context = _build_ux_auditor_context("sacrifice", root)

    assert "### Gate Findings" in context
    assert "tests-meaningful" in context


def test_build_ux_context_includes_finding_artifact_payload(tmp_path: Path) -> None:
    root = _write_app_with_slop_tests(tmp_path)

    context = _build_ux_auditor_context("sacrifice", root)

    assert "assert True" in context
    assert "test_sloppy.py" in context


def test_build_ux_context_graceful_when_no_repo_dir(tmp_path: Path) -> None:
    """When no repo dir exists, gate findings are simply absent — not an error."""
    root = _write_app(tmp_path)

    context = _build_ux_auditor_context("sacrifice", root)

    # Flow artifacts must still be present; gate findings optional.
    assert "### Flow Artifacts" in context
    # No gate findings section when there's nothing to report
    # (the section may be absent or present with zero findings)


# -- AC1.2-1.5: artifact fields --


def test_finding_artifact_shows_rule_id(tmp_path: Path) -> None:
    """AC1.2: Artifact shows rule id (kind)."""
    root = _write_app_with_slop_tests(tmp_path)

    findings = _collect_tests_meaningful_findings("sacrifice", root)

    for f in findings:
        assert "kind" in f
        assert isinstance(f["kind"], str)
        assert len(f["kind"]) > 0


def test_finding_artifact_shows_file(tmp_path: Path) -> None:
    """AC1.3: Artifact shows file (path)."""
    root = _write_app_with_slop_tests(tmp_path)

    findings = _collect_tests_meaningful_findings("sacrifice", root)

    for f in findings:
        assert "path" in f
        assert isinstance(f["path"], str)
        assert len(f["path"]) > 0


def test_finding_artifact_shows_line(tmp_path: Path) -> None:
    """AC1.4: Artifact shows line."""
    root = _write_app_with_slop_tests(tmp_path)

    findings = _collect_tests_meaningful_findings("sacrifice", root)

    for f in findings:
        assert "line" in f
        assert isinstance(f["line"], int)
        assert f["line"] >= 1


def test_finding_artifact_shows_remediation_text(tmp_path: Path) -> None:
    """AC1.5: Artifact shows remediation text (why_slop)."""
    root = _write_app_with_slop_tests(tmp_path)

    findings = _collect_tests_meaningful_findings("sacrifice", root)

    for f in findings:
        assert "why_slop" in f
        assert isinstance(f["why_slop"], str)
        assert len(f["why_slop"]) > 0
