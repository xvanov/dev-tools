"""The per-app gate model (``factory/gate_model.py``) end to end.

A gate is a command, ``none`` (skipped: the repo has no such check) or unset
(registration incomplete). ``gates.requires`` names binaries a gate needs on
PATH. Covers: the model itself, config load, the runners (``_run_pytest``, the
solo in-conversation gate, the ``tests-green`` merge gate), submit's refusal,
``app set --gate/--requires``, ``app show``, docs-only + CI detection, and the
UTF-8 decode of gate output (lychee prints emoji; cp1252 crashed it on Windows).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml
from typer.testing import CliRunner

from factory import cli_apps
from factory import gate_model as gm
from factory.app_config import AppConfig, AppGatesConfig, load_app_config
from factory.app_detect import ci_suggestions, detect, is_docs_only
from factory.cli_apps import AppAddError, add_app, set_app, show_app

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _write(root: Path, files: dict[str, str]) -> Path:
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
    return root


def _cfg(name: str = "demo", **gates: Any) -> AppConfig:
    return AppConfig.model_validate({"name": name, "repo": f"acme/{name}", "gates": gates})


def _which(present: set[str]) -> Any:
    return lambda tool: f"/bin/{tool}" if tool in present else None


DOCS_REPO = {
    "README.md": "# docs\n",
    "knowledge/a.md": "a\n",
    "knowledge/b.md": "b\n",
    "knowledge/c.md": "c\n",
    ".github/workflows/knowledge-ci.yml": (
        "name: knowledge-ci\n"
        "on: pull_request\n"
        "jobs:\n"
        "  secret-scan:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - uses: actions/checkout@v4\n"
        "      - run: |\n"
        '          docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest \\\n'
        "            detect --no-git --source /repo\n"
        "  link-check:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - uses: lycheeverse/lychee-action@v2\n"
        "        with:\n"
        '          args: --offline --no-progress "knowledge/**/*.md"\n'
    ),
}

# --------------------------------------------------------------------------- #
# the model
# --------------------------------------------------------------------------- #


def test_states() -> None:
    assert gm.state("npm test") == "command"
    assert gm.state("none") == gm.state(" NONE ") == "none"
    assert gm.state("") == gm.state(None) == gm.state("   ") == "unset"
    assert gm.runnable("none") is None and gm.runnable(" x ") == "x"
    assert gm.short_name("test_command") == "test" and gm.field_name("lint") == "lint_command"
    with pytest.raises(ValueError):
        gm.short_name("bogus")


def test_requires_normalised_at_load() -> None:
    g = AppGatesConfig(requires={"test_command": "docker, lychee", "lint": ["docker", "docker"]})
    assert g.requires == {"test": ["docker", "lychee"], "lint": ["docker"]}
    with pytest.raises(ValueError, match="unknown gate"):
        AppGatesConfig(requires={"bogus": ["x"]})
    with pytest.raises(ValueError, match="not an executable name"):
        AppGatesConfig(requires={"test": ["rm -rf /"]})


def test_readiness_unset_test_without_tests_dir_blocks(tmp_path: Path) -> None:
    r = gm.readiness(_cfg(), tmp_path, _which(set()))
    assert r["status"] == "not_configured"
    assert "test gate is not configured" in r["blocking"]
    assert "factory app set demo --gate test=none" in r["blocking"]


def test_readiness_unset_test_with_default_pytest_only_warns(tmp_path: Path) -> None:
    (tmp_path / "tests").mkdir()
    r = gm.readiness(_cfg(), tmp_path, _which(set()))
    assert r["blocking"] is None
    assert any("default `python -m pytest -q`" in w for w in r["warnings"])


def test_readiness_explicit_none_is_configured(tmp_path: Path) -> None:
    cfg = _cfg(
        lint_command="none",
        format_check_command="none",
        type_check_command="none",
        test_command="none",
    )
    r = gm.readiness(cfg, tmp_path, _which(set()))
    assert r["status"] == "configured" and r["blocking"] is None and r["warnings"] == []
    assert r["gates"]["test"] == {
        "field": "test_command",
        "state": "none",
        "command": None,
        "requires": [],
    }


def test_readiness_missing_tool_is_named(tmp_path: Path) -> None:
    cfg = _cfg(test_command="lychee .", lint_command="none", requires={"test": ["lychee"]})
    r = gm.readiness(cfg, tmp_path, _which(set()))
    assert r["status"] == "missing_tool"
    assert r["missing_tools"] == {"test": ["lychee"]}
    assert "gate test needs lychee, not on PATH" in r["blocking"]
    assert gm.readiness(cfg, tmp_path, _which({"lychee"}))["missing_tools"] == {}


def test_requires_of_a_gate_set_to_none_is_not_checked(tmp_path: Path) -> None:
    cfg = _cfg(test_command="none", requires={"test": ["docker"]})
    assert gm.missing_tools(cfg, _which(set())) == {}


def test_submit_check_codes(tmp_path: Path) -> None:
    err, _ = gm.submit_check(_cfg(), tmp_path, _which(set()))
    assert err is not None and err[0] == "gates_not_configured"
    cfg = _cfg(test_command="docker run x", requires={"test": ["docker"]})
    err, _ = gm.submit_check(cfg, tmp_path, _which(set()))
    assert err is not None and err[0] == "gate_requirements_missing"
    assert gm.submit_check(_cfg(test_command="none"), tmp_path, _which(set()))[0] is None
    # No checkout to look at: warn, never refuse on a guess.
    err, warnings = gm.submit_check(_cfg(), tmp_path / "absent", _which(set()))
    assert err is None and warnings


# --------------------------------------------------------------------------- #
# the runners
# --------------------------------------------------------------------------- #


def test_run_pytest_none_is_skipped_not_run(tmp_path: Path) -> None:
    from factory.runner import _run_pytest

    passed, out = _run_pytest(tmp_path, test_command="none")
    assert passed is True
    assert out == "not configured: skipped (gates.test_command: none)"


_EMOJI = "print('\\U0001f50d checking links \\u2705 ok \\u2014 done')"


def test_run_pytest_decodes_utf8_output(tmp_path: Path) -> None:
    """lychee prints emoji; a cp1252 decode crashed the reader thread on
    Windows, leaving stdout None and the gate a TypeError."""
    from factory.runner import _run_pytest

    cmd = (
        f'"{sys.executable}" -c "import sys; sys.stdout.reconfigure(encoding=\'utf-8\'); {_EMOJI}"'
    )
    passed, out = _run_pytest(tmp_path, test_command=cmd)
    assert passed is True, out
    assert "✅" in out and "\U0001f50d" in out


def test_gate_run_command_decodes_utf8_output(tmp_path: Path) -> None:
    from factory.chain.gates.evaluator import _run_command

    cmd = (
        f'"{sys.executable}" -c "import sys; sys.stdout.reconfigure(encoding=\'utf-8\'); {_EMOJI}"'
    )
    code, out = _run_command(cmd, tmp_path)
    assert code == 0 and "✅" in out


def test_solo_gate_skips_none_and_still_needs_a_change(tmp_path: Path) -> None:
    from factory.chain.solo import make_gate_check

    check = make_gate_check(repo_path=tmp_path, test_command="none", branch_is_empty=lambda: True)
    v = check()
    assert v.passed is False and "NO change" in v.reason
    assert v.checks[0] == {
        "name": "test_command",
        "passed": True,
        "skipped": True,
        "reason": "not configured: skipped (gates.test_command: none)",
    }
    check = make_gate_check(repo_path=tmp_path, test_command="none", branch_is_empty=lambda: False)
    assert check().passed is True


def test_static_gate_commands_skip_none() -> None:
    from factory.chain.solo import static_gate_commands

    cfg = _cfg(lint_command="none", format_check_command="prettier --check .")
    assert static_gate_commands(cfg) == [("format_check", "prettier --check .")]


def test_solo_brief_says_no_test_suite() -> None:
    from factory.chain.solo import build_solo_brief

    assert "no test suite" in build_solo_brief(None, test_command="none")


def _pr(tmp_path: Path, **kw: Any) -> Any:
    from factory.chain.gates.evaluator import PRContext

    return PRContext(
        pr_number=1, head_sha="abc", base_branch="main", dry_run=False, repo_root=tmp_path, **kw
    )


def test_tests_green_none_is_skipped_never_passing(tmp_path: Path) -> None:
    from factory.chain.gates import tests_green

    res = tests_green.evaluate(_pr(tmp_path), _cfg(test_command="none"))
    assert res.passed is True
    assert res.reason == "not configured: skipped (gates.test_command: none)"
    assert res.details["skipped"] is True


def test_tests_green_missing_tool_blocks_with_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain.gates import tests_green

    monkeypatch.setattr(gm.shutil, "which", lambda _t: None)
    cfg = _cfg(test_command="lychee .", requires={"test": ["lychee"]})
    res = tests_green.evaluate(_pr(tmp_path), cfg)
    assert res.passed is False
    assert res.reason == "gate test needs lychee, not on PATH (gates.requires)"


# --------------------------------------------------------------------------- #
# submit
# --------------------------------------------------------------------------- #


@pytest.fixture
def jobs_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    import factory.jobs.github as gh_mod
    from factory.jobs import submit as submit_mod

    root = tmp_path / "sf"
    (root / "state").mkdir(parents=True)
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(root))
    monkeypatch.setattr(gh_mod, "_run_gh", lambda _a: (_ for _ in ()).throw(FileNotFoundError()))
    monkeypatch.setattr(submit_mod, "claude_available", lambda: (True, "fake"))
    return root


def _app(root: Path, repo_dir: Path, gates: dict[str, Any]) -> None:
    d = root / "apps" / "docs"
    d.mkdir(parents=True, exist_ok=True)
    cfg = {"name": "docs", "repo": "acme/docs", "app_repo_path": str(repo_dir), "gates": gates}
    (d / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")


def _submit(root: Path) -> dict[str, Any]:
    from factory.jobs.submit import SubmitRequest, submit_job

    return submit_job(
        root, SubmitRequest(title="Fix a link", ask="Fix the broken link.", source="pa", app="docs")
    )


def test_submit_refuses_unconfigured_test_gate_on_a_repo_without_tests(
    jobs_root: Path, tmp_path: Path
) -> None:
    from factory.jobs.common import JobError

    repo = _write(tmp_path / "docs", {"README.md": "x"})
    _app(jobs_root, repo, {})
    with pytest.raises(JobError) as exc:
        _submit(jobs_root)
    assert exc.value.code == "gates_not_configured"
    assert "--gate test=none" in exc.value.message
    assert (
        not list((jobs_root / "apps" / "docs" / "directions").glob("*"))
        if (jobs_root / "apps" / "docs" / "directions").exists()
        else True
    )


def test_submit_accepts_explicit_none(jobs_root: Path, tmp_path: Path) -> None:
    repo = _write(tmp_path / "docs", {"README.md": "x"})
    _app(jobs_root, repo, {"test_command": "none"})
    out = _submit(jobs_root)
    assert out["created"] is True


def test_submit_refuses_missing_required_tool(
    jobs_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.jobs.common import JobError

    monkeypatch.setattr(gm.shutil, "which", lambda _t: None)
    repo = _write(tmp_path / "docs", {"README.md": "x"})
    _app(jobs_root, repo, {"test_command": "lychee .", "requires": {"test": ["lychee"]}})
    with pytest.raises(JobError) as exc:
        _submit(jobs_root)
    assert exc.value.code == "gate_requirements_missing"
    assert "gate test needs lychee, not on PATH" in exc.value.message


# --------------------------------------------------------------------------- #
# app set / add / show
# --------------------------------------------------------------------------- #


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    root = tmp_path / "software-factory"
    (root / "apps").mkdir(parents=True)
    return root


def _git_repo(path: Path, files: dict[str, str], remote: str) -> Path:
    _write(path, files)
    subprocess.run(["git", "init", "-q", "-b", "main", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "remote", "add", "origin", remote], check=True)
    return path


def _add_docs(factory_root: Path, tmp_path: Path) -> dict[str, Any]:
    repo = _git_repo(tmp_path / "docs", DOCS_REPO, "https://github.com/acme/docs")
    return add_app(root=factory_root, repo="acme/docs", path=repo)


def test_add_docs_repo_suggests_ci_gates_but_writes_none(
    factory_root: Path, tmp_path: Path
) -> None:
    res = _add_docs(factory_root, tmp_path)
    assert res["docs_only"] is True
    assert res["gates"]["test_command"] == ""  # suggestions are never written
    sug = res["suggested_gates"]
    assert sug["test_command"]["command"] == 'lychee --offline --no-progress "knowledge/**/*.md"'
    assert sug["test_command"]["requires"] == ["lychee"]
    assert sug["lint_command"]["requires"] == ["docker"]
    assert sug["type_check_command"]["command"] == "none"
    assert res["readiness"]["status"] == "not_configured"
    assert "test gate is not configured" in res["readiness"]["blocking"]
    text = (factory_root / "apps" / "docs" / "config.yaml").read_text(encoding="utf-8")
    assert "# suggested (CI: knowledge-ci.yml job link-check" in text


def test_set_gates_and_requires_in_place(factory_root: Path, tmp_path: Path) -> None:
    _add_docs(factory_root, tmp_path)
    res = set_app(
        root=factory_root,
        app="docs",
        gates={
            "test": "lychee --offline .",
            "lint": "none",
            "format_check": "none",
            "type_check_command": "NONE",
        },
        requires={"test": ["lychee"]},
    )
    assert res["comments_preserved"] is True
    assert set(res["changed"]) == {
        "gates.lint_command",
        "gates.format_check_command",
        "gates.type_check_command",
        "gates.test_command",
        "gates.requires",
    }
    cfg = load_app_config("docs", factory_root)
    assert cfg.gates.test_command == "lychee --offline ."
    assert cfg.gates.type_check_command == "none"
    assert cfg.gates.requires == {"test": ["lychee"]}
    assert res["gates"]["test"]["requires"] == ["lychee"]
    text = (factory_root / "apps" / "docs" / "config.yaml").read_text(encoding="utf-8")
    assert "# Generated by `factory app set`" not in text and "# suggested" in text

    # Clearing: an empty gate is unset again, an empty requires list drops it.
    res = set_app(root=factory_root, app="docs", gates={"test": ""}, requires={"test": []})
    cfg = load_app_config("docs", factory_root)
    assert cfg.gates.test_command == "" and cfg.gates.requires == {}
    assert res["readiness"]["status"] == "not_configured"


def test_set_refuses_bad_gates(factory_root: Path, tmp_path: Path) -> None:
    _add_docs(factory_root, tmp_path)
    with pytest.raises(AppAddError) as exc:
        set_app(root=factory_root, app="docs", gates={"bogus": "x"})
    assert exc.value.code == "invalid_gate"
    with pytest.raises(AppAddError) as exc:
        set_app(root=factory_root, app="docs", gates={"test": "a\nb"})
    assert exc.value.code == "invalid_gate"
    with pytest.raises(AppAddError) as exc:
        set_app(root=factory_root, app="docs", requires={"test": ["a b"]})
    assert exc.value.code == "invalid_requires"


def test_set_block_child_ignores_nested_keys() -> None:
    text = "gates:\n  acceptance_boot:\n    test_command: inner\n  lint_command: x\n"
    out = cli_apps._set_block_child(text, "gates", "test_command", '"t"')
    assert yaml.safe_load(out)["gates"] == {
        "acceptance_boot": {"test_command": "inner"},
        "lint_command": "x",
        "test_command": "t",
    }


def test_add_with_confirmed_gates(factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "docs", DOCS_REPO, "https://github.com/acme/docs")
    res = add_app(
        root=factory_root,
        repo="acme/docs",
        path=repo,
        gates={"test": "none", "lint": "none", "format_check": "none", "type_check": "none"},
    )
    assert res["readiness"]["status"] == "configured"
    assert load_app_config("docs", factory_root).gates.test_command == "none"


def test_show_lists_suggestions(factory_root: Path, tmp_path: Path) -> None:
    _add_docs(factory_root, tmp_path)
    res = show_app(factory_root, "docs")
    assert res["path_exists"] is True and res["docs_only"] is True
    assert "test_command" in res["suggested_gates"]
    with pytest.raises(AppAddError) as exc:
        show_app(factory_root, "nope")
    assert exc.value.code == "unknown_app"


def test_cli_set_and_show_json(
    factory_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.cli import app as cli

    monkeypatch.setattr(cli_apps, "_FACTORY_ROOT", factory_root)
    _add_docs(factory_root, tmp_path)
    r = CliRunner().invoke(
        cli,
        [
            "app",
            "set",
            "docs",
            "--gate",
            "test=lychee --offline .",
            "--gate",
            "lint=none",
            "--requires",
            "test=lychee",
            "--json",
        ],
    )
    assert r.exit_code == 0, r.output
    body = json.loads(r.stdout)
    assert body["gates"]["test"]["command"] == "lychee --offline ."
    assert body["gates"]["lint"]["state"] == "none"
    r = CliRunner().invoke(cli, ["app", "show", "docs", "--json"])
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout)["gates"]["test"]["requires"] == ["lychee"]
    r = CliRunner().invoke(cli, ["app", "set", "docs", "--gate", "test", "--json"])
    assert r.exit_code == 1 and json.loads(r.stdout)["error"] == "invalid_gate"


# --------------------------------------------------------------------------- #
# detection
# --------------------------------------------------------------------------- #


def test_docs_only_detection(tmp_path: Path) -> None:
    assert is_docs_only(_write(tmp_path / "a", {"a.md": "", "b.md": "", "c.rst": ""}))
    code = {"a.md": "", "b.md": "", "c.md": "", "x.py": "", "y.py": ""}
    assert not is_docs_only(_write(tmp_path / "b", code))
    d = detect(_write(tmp_path / "c", {"a.md": "", "b.md": "", "c.md": ""}))
    assert d.docs_only and set(d.suggested) == {
        "lint_command",
        "format_check_command",
        "type_check_command",
        "test_command",
    }
    assert all(s["command"] == "none" for s in d.suggested.values())


def test_code_repo_without_toolchain_gets_no_none_suggestion(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, {"main.c": "", "util.c": ""}))
    assert not d.docs_only and d.suggested == {}


def test_ci_github_workflow_mirrors_steps(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            ".github/workflows/ci.yml": (
                "defaults:\n  run:\n    working-directory: web\n"
                "jobs:\n  build:\n    steps:\n"
                "      - run: npm ci\n"
                "      - run: npm run lint\n"
                "      - run: npx prettier --check .\n"
                "      - run: npx tsc --noEmit\n"
                "      - run: yarn check src tests\n"
                "      - run: npm test\n"
                "      - run: echo ${{ secrets.X }} test\n"
            )
        },
    )
    got = {s["gate"]: s for s in ci_suggestions(tmp_path)}
    assert got["lint_command"]["command"] == "(cd web && npm ci && npm run lint)"
    assert got["format_check_command"]["command"] == "(cd web && npm ci && npx prettier --check .)"
    assert got["type_check_command"]["command"] == "(cd web && npm ci && npx tsc --noEmit)"
    assert got["test_command"]["command"] == "(cd web && npm ci && npm test)"
    assert got["test_command"]["requires"] == ["npm"]
    assert len([s for s in ci_suggestions(tmp_path) if s["gate"] == "test_command"]) == 1


def test_ci_gitlab(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            ".gitlab-ci.yml": (
                "stages: [test]\n"
                ".tmpl:\n  script: [make test]\n"
                "unit:\n  stage: test\n  before_script: [uv sync]\n"
                "  script:\n    - uv run pytest -q\n"
                "docs:\n  script: markdownlint '**/*.md'\n"
            )
        },
    )
    got = {s["gate"]: s for s in ci_suggestions(tmp_path)}
    assert got["test_command"]["command"] == "uv sync && uv run pytest -q"
    assert got["test_command"]["requires"] == ["uv"]
    assert got["lint_command"] == {
        "gate": "lint_command",
        "command": "markdownlint '**/*.md'",
        "requires": ["markdownlint"],
        "source": ".gitlab-ci.yml job docs",
    }


def test_ci_broken_workflow_contributes_nothing(tmp_path: Path) -> None:
    _write(tmp_path, {".github/workflows/x.yml": "jobs: [:\n"})
    assert ci_suggestions(tmp_path) == []
