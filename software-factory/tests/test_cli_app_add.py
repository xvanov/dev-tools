"""``factory app add`` / ``factory app list`` and the toolchain detector.

Every repo here is a fixture in ``tmp_path``; nothing touches the live tree,
the network, or systemd (the runner is stubbed wherever a command would run).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from factory import cli_apps
from factory.app_config import load_app_config
from factory.app_detect import GATE_KEYS, detect
from factory.cli_apps import (
    AppAddError,
    add_app,
    enable_tick_command,
    list_registered_apps,
    set_app,
)

# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #


def _write(root: Path, files: dict[str, str]) -> Path:
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
    return root


def _git_repo(path: Path, files: dict[str, str], remote: str | None) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    _write(path, files)
    subprocess.run(["git", "init", "-q", "-b", "trunk", str(path)], check=True)
    if remote:
        subprocess.run(["git", "-C", str(path), "remote", "add", "origin", remote], check=True)
    return path


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    root = tmp_path / "software-factory"
    (root / "apps").mkdir(parents=True)
    return root


PY_UV = {
    "pyproject.toml": (
        '[project]\nname = "x"\n[project.optional-dependencies]\n'
        'dev = ["pytest", "ruff", "mypy"]\n[tool.ruff]\nline-length = 100\n'
        '[tool.mypy]\nfiles = ["src"]\n'
    ),
    "uv.lock": "",
    "tests/test_x.py": "",
}

# --------------------------------------------------------------------------- #
# detection, per toolchain
# --------------------------------------------------------------------------- #


def test_detect_python_uv(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, PY_UV))
    assert d.gates == {
        "lint_command": "uv run --extra dev ruff check .",
        "format_check_command": "uv run --extra dev ruff format --check .",
        "type_check_command": "uv run --extra dev mypy",  # files= configured
        "test_command": "uv run --extra dev pytest -q",
    }
    assert d.missing == []
    assert d.toolchains == ["python (uv)"]


def test_detect_python_poetry(tmp_path: Path) -> None:
    d = detect(
        _write(
            tmp_path,
            {
                "pyproject.toml": (
                    "[tool.poetry]\nname='x'\n[tool.poetry.group.dev.dependencies]\n"
                    'pytest = "*"\nblack = "*"\nflake8 = "*"\npyright = "*"\n'
                ),
                "poetry.lock": "",
            },
        )
    )
    assert d.gates["lint_command"] == "poetry run flake8 ."
    assert d.gates["format_check_command"] == "poetry run black --check ."
    assert d.gates["type_check_command"] == "poetry run pyright"
    assert d.gates["test_command"] == "poetry run pytest -q"


def test_detect_python_pip_requirements(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, {"requirements-dev.txt": "pytest==8\nruff\nmypy\n"}))
    assert d.gates["lint_command"] == "python -m ruff check ."
    assert d.gates["type_check_command"] == "python -m mypy ."
    assert d.gates["test_command"] == "python -m pytest -q"
    assert any("pip" in n for n in d.notes)


def test_python_without_tools_leaves_gates_missing(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, {"setup.py": "from setuptools import setup\nsetup()\n"}))
    assert d.toolchains == ["python (pip)"]
    assert set(d.missing) == set(GATE_KEYS)


@pytest.mark.parametrize(
    ("lockfile", "run"),
    [
        ("package-lock.json", "npm run"),
        ("pnpm-lock.yaml", "pnpm run"),
        ("yarn.lock", "yarn run"),
    ],
)
def test_detect_node_scripts_per_package_manager(tmp_path: Path, lockfile: str, run: str) -> None:
    pkg = {
        "scripts": {
            "lint": "eslint .",
            "format:check": "prettier --check .",
            "typecheck": "tsc --noEmit",
            "test": "vitest run",
        },
        "devDependencies": {"typescript": "5"},
    }
    d = detect(_write(tmp_path, {"package.json": json.dumps(pkg), lockfile: ""}))
    assert d.gates == {
        "lint_command": f"{run} lint",
        "format_check_command": f"{run} format:check",
        "type_check_command": f"{run} typecheck",
        "test_command": f"{run} test",
    }
    assert d.toolchains[0].startswith("typescript (")


def test_node_placeholder_test_script_is_not_a_gate(tmp_path: Path) -> None:
    pkg = {
        "scripts": {"test": 'echo "Error: no test specified" && exit 1'},
        "devDependencies": {"prettier": "3"},
    }
    d = detect(_write(tmp_path, {"package.json": json.dumps(pkg), "tsconfig.json": "{}"}))
    assert "test_command" in d.missing
    assert d.gates["type_check_command"] == "npx tsc --noEmit"  # tool fallback
    assert d.gates["format_check_command"] == "npx prettier --check ."


def test_node_package_manager_field_wins(tmp_path: Path) -> None:
    pkg = {"packageManager": "pnpm@9.0.0", "scripts": {"lint": "eslint ."}}
    d = detect(_write(tmp_path, {"package.json": json.dumps(pkg), "package-lock.json": ""}))
    assert d.gates["lint_command"] == "pnpm run lint"


def test_detect_go(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, {"go.mod": "module x\n"}))
    assert d.gates["lint_command"] == "go vet ./..."
    assert d.gates["test_command"] == "go test ./..."
    assert d.gates["type_check_command"] == "go build ./..."
    assert "gofmt -l" in d.gates["format_check_command"]
    d2 = detect(_write(tmp_path / "g2", {"go.mod": "module x\n", ".golangci.yml": ""}))
    assert d2.gates["lint_command"] == "golangci-lint run"


def test_detect_rust(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, {"Cargo.toml": "[package]\nname='x'\n"}))
    assert d.gates == {
        "lint_command": "cargo clippy --all-targets -- -D warnings",
        "format_check_command": "cargo fmt --all -- --check",
        "type_check_command": "cargo check --all-targets",
        "test_command": "cargo test",
    }


def test_detect_dotnet_single_solution(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, {"Shop.sln": "", "src/Shop/Shop.csproj": "<Project/>"}))
    assert d.gates["test_command"] == "dotnet test Shop.sln --nologo"
    assert d.gates["type_check_command"] == "dotnet build Shop.sln --nologo"
    assert (
        d.gates["format_check_command"] == "dotnet format Shop.sln whitespace --verify-no-changes"
    )
    assert d.gates["lint_command"].startswith("dotnet format Shop.sln analyzers")
    assert d.toolchains == [".net"]


def test_detect_dotnet_csharpier_and_ambiguous_targets(tmp_path: Path) -> None:
    tools = {"version": 1, "tools": {"csharpier": {"version": "0.30.0"}}}
    d = detect(
        _write(
            tmp_path,
            {"A.sln": "", "B.sln": "", ".config/dotnet-tools.json": json.dumps(tools)},
        )
    )
    assert d.gates["format_check_command"] == "dotnet tool restore && dotnet csharpier --check ."
    assert d.gates["test_command"] == "dotnet test --nologo"
    assert any("several solution" in n for n in d.notes)


def test_makefile_targets_win_over_toolchain(tmp_path: Path) -> None:
    files = dict(PY_UV)
    files["Makefile"] = "lint:\n\truff check .\ntest: lint\n\tpytest\nfmt-check:\n\truff format\n"
    d = detect(_write(tmp_path, files))
    assert d.gates["lint_command"] == "make lint"
    assert d.gates["test_command"] == "make test"
    assert d.gates["format_check_command"] == "make fmt-check"
    # Not in the Makefile -> filled from the toolchain.
    assert d.gates["type_check_command"] == "uv run --extra dev mypy"
    assert d.sources["lint_command"] == "Makefile target `lint`"


def test_monorepo_subdirs_shallowest_per_family(tmp_path: Path) -> None:
    """sacrifice's shape: root ruff.toml, backend/ uv package, frontend/ npm."""
    files = {
        "ruff.toml": "line-length = 100\n",
        "backend/pyproject.toml": "[project]\nname='b'\ndependencies=['pytest','mypy']\n",
        "backend/uv.lock": "",
        "frontend/package.json": json.dumps({"scripts": {"lint": "eslint .", "test": "jest"}}),
        "node_modules/x/package.json": json.dumps({"scripts": {"lint": "nope"}}),
    }
    d = detect(_write(tmp_path, files))
    # root ruff covers python lint; backend's ruff would be redundant, npm is not.
    assert d.gates["lint_command"] == "ruff check . && (cd frontend && npm run lint)"
    assert d.gates["type_check_command"] == "(cd backend && uv run mypy .)"
    assert (
        d.gates["test_command"]
        == "(cd backend && uv run pytest -q) && (cd frontend && npm run test)"
    )
    assert not any("node_modules" in t for t in d.toolchains)


def test_ensure_deps_prefix_and_smoke(tmp_path: Path) -> None:
    pkg = {"scripts": {"test": "turbo run test"}}
    d = detect(
        _write(
            tmp_path,
            {
                "package.json": json.dumps(pkg),
                "scripts/ensure-deps.sh": "",
                "scripts/smoke.sh": "",
            },
        )
    )
    assert d.gates["test_command"] == "bash scripts/ensure-deps.sh && npm run test"
    assert d.smoke_command == "bash scripts/smoke.sh"


def test_empty_repo_detects_nothing(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, {"README.md": "hi"}))
    assert d.gates == {}
    assert d.missing == list(GATE_KEYS)
    assert any("no supported toolchain" in n for n in d.notes)


def test_detect_gradle_wrapper_with_spotless(tmp_path: Path) -> None:
    d = detect(
        _write(
            tmp_path,
            {
                "build.gradle.kts": 'plugins { id("com.diffplug.spotless") }\n',
                "gradlew": "#!/bin/sh\n",
            },
        )
    )
    assert d.toolchains == ["jvm (gradle)"]
    assert d.gates["test_command"] == "./gradlew test"
    assert d.gates["type_check_command"] == "./gradlew classes testClasses"
    assert d.gates["format_check_command"] == "./gradlew spotlessCheck"
    assert d.missing == ["lint_command"]


def test_detect_maven_without_wrapper(tmp_path: Path) -> None:
    d = detect(_write(tmp_path, {"pom.xml": "<project><artifactId>x</artifactId></project>"}))
    assert d.toolchains == ["jvm (maven)"]
    assert d.gates["test_command"] == "mvn -B -q test"
    assert d.gates["type_check_command"] == "mvn -B -q test-compile"


def test_detect_ruby_bundler(tmp_path: Path) -> None:
    d = detect(
        _write(
            tmp_path,
            {"Gemfile": 'gem "rspec"\ngem "rubocop"\n', "spec/x_spec.rb": ""},
        )
    )
    assert d.toolchains == ["ruby (bundler)"]
    assert d.gates["test_command"] == "bundle exec rspec"
    assert d.gates["lint_command"] == "bundle exec rubocop"


def test_detect_php_composer(tmp_path: Path) -> None:
    composer = {
        "require-dev": {
            "phpunit/phpunit": "^10",
            "phpstan/phpstan": "^1",
            "laravel/pint": "^1",
        }
    }
    d = detect(_write(tmp_path, {"composer.json": json.dumps(composer)}))
    assert d.toolchains == ["php (composer)"]
    assert d.gates == {
        "test_command": "vendor/bin/phpunit",
        "type_check_command": "vendor/bin/phpstan analyse",
        "format_check_command": "vendor/bin/pint --test",
    }


# --------------------------------------------------------------------------- #
# add_app
# --------------------------------------------------------------------------- #


def _no_systemd(cmd: list[str], cwd: Path | None) -> tuple[int, str]:
    """Run git for real (local only); refuse anything else loudly."""
    if cmd[0] != "git" or cmd[1] == "clone":
        raise AssertionError(f"unexpected command in test: {cmd}")
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def test_add_existing_clone_writes_valid_config(factory_root: Path) -> None:
    repo = _git_repo(factory_root.parent / "widget", PY_UV, "git@github.com:Acme/Widget.git")
    res = add_app(root=factory_root, repo="Acme/Widget", runner=_no_systemd)

    assert res["app"] == "widget"
    assert res["path"] == str(repo.resolve())
    assert res["delivery"] == {"default": "draft_pr"}
    assert res["pipeline_default"] == "chain"
    assert res["missing_gates"] == []
    assert res["cloned"] is False
    assert (factory_root / "apps/widget/directions").is_dir()
    assert (repo / "context").is_dir()

    cfg = load_app_config("widget", factory_root)
    assert cfg.repo == "Acme/Widget"
    assert cfg.app_repo_path == "../widget"  # sibling convention, written relative
    assert cfg.default_branch == "trunk"
    assert cfg.delivery.default.value == "draft_pr"
    assert cfg.pipeline_default == "chain"
    assert (
        "max"
        not in (yaml.safe_load((factory_root / "apps/widget/config.yaml").read_text()))["delivery"]
    )
    assert cfg.gates.test_command == "uv run --extra dev pytest -q"
    assert cfg.deploy.enabled is False


def test_missing_gates_are_empty_and_commented(factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(
        tmp_path / "elsewhere" / "bare", {"README.md": "x"}, "https://github.com/o/bare"
    )
    res = add_app(root=factory_root, repo="o/bare", path=repo, runner=_no_systemd)
    assert res["missing_gates"] == list(GATE_KEYS)
    assert all(v == "" for v in res["gates"].values())
    text = (factory_root / "apps/bare/config.yaml").read_text()
    assert text.count("NOT DETECTED") == 4
    cfg = load_app_config("bare", factory_root)
    assert not cfg.gates.test_command  # falsy == "not configured"
    assert cfg.app_repo_path == str(repo.resolve())  # not a sibling -> absolute


def test_refuses_existing_config_without_force(factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w.git")
    add_app(root=factory_root, repo="o/w", path=repo, runner=_no_systemd)
    cfg_path = factory_root / "apps/w/config.yaml"
    cfg_path.write_text(cfg_path.read_text() + "# hand edit\n")
    with pytest.raises(AppAddError) as exc:
        add_app(root=factory_root, repo="o/w", path=repo, runner=_no_systemd)
    assert exc.value.code == "app_exists"
    assert cfg_path.read_text().endswith("# hand edit\n")  # untouched

    add_app(root=factory_root, repo="o/w", path=repo, force=True, runner=_no_systemd)
    assert "# hand edit" not in cfg_path.read_text()


def test_refuses_repo_registered_under_another_name(factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w.git")
    add_app(root=factory_root, repo="o/w", path=repo, runner=_no_systemd)
    with pytest.raises(AppAddError) as exc:
        add_app(root=factory_root, repo="O/W", path=repo, name="other", runner=_no_systemd)
    assert exc.value.code == "repo_already_registered"
    assert not (factory_root / "apps/other").exists()


def test_refuses_clone_with_wrong_origin(factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/someone/else.git")
    with pytest.raises(AppAddError) as exc:
        add_app(root=factory_root, repo="o/w", path=repo, runner=_no_systemd)
    assert exc.value.code == "repo_mismatch"
    assert not (factory_root / "apps/w").exists()


def test_same_path_on_another_host_is_a_mismatch(factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://gitlab.com/o/w.git")
    with pytest.raises(AppAddError) as exc:
        add_app(root=factory_root, repo="o/w", path=repo, runner=_no_systemd)
    assert exc.value.code == "repo_mismatch"


def test_refuses_non_git_dir(factory_root: Path, tmp_path: Path) -> None:
    (tmp_path / "plain").mkdir()
    with pytest.raises(AppAddError) as exc:
        add_app(root=factory_root, repo="o/w", path=tmp_path / "plain", runner=_no_systemd)
    assert exc.value.code == "not_a_git_repo"


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"repo": "not-a-repo"}, "invalid_repo"),
        ({"repo": "o/w", "name": "Bad Name"}, "invalid_name"),
        ({"repo": "o/w", "delivery_default": "yolo"}, "invalid_delivery"),
        ({"repo": "o/w", "pipeline_default": "swarm"}, "invalid_pipeline"),
    ],
)
def test_input_refusals_write_nothing(factory_root: Path, kwargs: dict, code: str) -> None:
    with pytest.raises(AppAddError) as exc:
        add_app(root=factory_root, runner=_no_systemd, **kwargs)
    assert exc.value.code == code
    assert list((factory_root / "apps").iterdir()) == []


@pytest.mark.parametrize("level", ["none", "branch", "pr", "auto_merge", "push_to_main"])
def test_delivery_default_is_written(factory_root: Path, tmp_path: Path, level: str) -> None:
    """Any level may be an app default — there is no ceiling to clamp it to."""
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w")
    res = add_app(
        root=factory_root,
        repo="o/w",
        path=repo,
        delivery_default=level,
        pipeline_default="AUTO",
        runner=_no_systemd,
    )
    assert res["delivery"] == {"default": level}
    assert res["pipeline_default"] == "auto"
    cfg = load_app_config("w", factory_root)
    assert (cfg.delivery.default.value, cfg.pipeline_default) == (level, "auto")


def test_clones_to_sibling_when_absent(factory_root: Path) -> None:
    calls: list[list[str]] = []

    def runner(cmd: list[str], cwd: Path | None) -> tuple[int, str]:
        calls.append(cmd)
        if cmd[:2] in (["gh", "repo"], ["git", "clone"]):
            _git_repo(Path(cmd[-1]), {"go.mod": "module x\n"}, "https://github.com/o/svc.git")
            return 0, ""
        return _no_systemd(cmd, cwd)

    res = add_app(root=factory_root, repo="o/svc", runner=runner)
    target = factory_root.parent / "svc"
    assert calls[0][-1] == str(target)
    assert calls[0][:3] == ["gh", "repo", "clone"] or calls[0][:2] == ["git", "clone"]
    assert res["cloned"] is True
    assert res["gates"]["test_command"] == "go test ./..."


def test_clone_failure_writes_nothing(factory_root: Path) -> None:
    def runner(cmd: list[str], cwd: Path | None) -> tuple[int, str]:
        return 1, "repository not found"

    with pytest.raises(AppAddError) as exc:
        add_app(root=factory_root, repo="o/ghost", runner=runner)
    assert exc.value.code == "clone_failed"
    assert "repository not found" in exc.value.message
    assert not (factory_root / "apps/ghost").exists()


def test_enable_tick_command_construction(factory_root: Path, tmp_path: Path) -> None:
    assert enable_tick_command("my-app") == [
        "systemctl",
        "--user",
        "enable",
        "--now",
        "factory-tick@my-app.timer",
    ]
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w")
    seen: list[list[str]] = []

    def runner(cmd: list[str], cwd: Path | None) -> tuple[int, str]:
        if cmd[0] == "systemctl":
            seen.append(cmd)
            return 0, ""
        return _no_systemd(cmd, cwd)

    res = add_app(root=factory_root, repo="o/w", path=repo, enable_tick=True, runner=runner)
    assert seen == [enable_tick_command("w")]
    assert res["tick"] == {"unit": "factory-tick@w.timer", "enabled": True}


def test_enable_tick_failure_is_an_error_after_writing(factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w")

    def runner(cmd: list[str], cwd: Path | None) -> tuple[int, str]:
        if cmd[0] == "systemctl":
            return 1, "Unit factory-tick@.timer not found."
        return _no_systemd(cmd, cwd)

    with pytest.raises(AppAddError) as exc:
        add_app(root=factory_root, repo="o/w", path=repo, enable_tick=True, runner=runner)
    assert exc.value.code == "enable_tick_failed"
    assert (factory_root / "apps/w/config.yaml").exists()


def test_tick_not_enabled_by_default(factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w")
    res = add_app(root=factory_root, repo="o/w", path=repo, runner=_no_systemd)
    assert res["tick"]["enabled"] is False


# --------------------------------------------------------------------------- #
# CLI + JSON shapes
# --------------------------------------------------------------------------- #


@pytest.fixture
def cli(factory_root: Path, monkeypatch: pytest.MonkeyPatch):
    from factory.cli import app

    monkeypatch.setattr(cli_apps, "_FACTORY_ROOT", factory_root)
    monkeypatch.setattr(cli_apps, "_run", _no_systemd)
    runner = CliRunner()
    return lambda *args: runner.invoke(app, ["app", *args])


def test_cli_add_json_shape(cli, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w.git")
    r = cli("add", "--repo", "o/w", "--path", str(repo), "--json")
    assert r.exit_code == 0, r.output
    payload = json.loads(r.stdout)
    for key in ("app", "repo", "path", "config_path", "gates", "delivery"):
        assert key in payload
    assert set(payload["gates"]) == set(GATE_KEYS)
    assert payload["delivery"] == {"default": "draft_pr"}


def test_cli_add_json_error_shape(cli, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w.git")
    assert cli("add", "--repo", "o/w", "--path", str(repo), "--json").exit_code == 0
    r = cli("add", "--repo", "o/w", "--path", str(repo), "--json")
    assert r.exit_code == 1
    payload = json.loads(r.stdout)
    assert payload["error"] == "app_exists"
    assert "--force" in payload["message"]


def test_cli_add_human_output_lists_missing(cli, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "b", {"README.md": ""}, "https://github.com/o/b")
    r = cli("add", "--repo", "o/b", "--path", str(repo))
    assert r.exit_code == 0, r.output
    assert "MISSING gates" in r.stdout
    assert "test_command" in r.stdout


def test_cli_list_json_shape(cli, factory_root: Path, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w.git")
    cli("add", "--repo", "o/w", "--path", str(repo), "--json")
    # A legacy app with no delivery block keeps today's behaviour.
    legacy = factory_root / "apps" / "legacy"
    legacy.mkdir()
    (legacy / "config.yaml").write_text(yaml.safe_dump({"name": "legacy", "repo": "o/legacy"}))

    r = cli("list", "--json")
    assert r.exit_code == 0, r.output
    apps = {a["app"]: a for a in json.loads(r.stdout)["apps"]}
    assert set(apps) == {"w", "legacy"}
    for row in apps.values():
        assert set(row) == {"app", "repo", "path", "delivery", "pipeline_default"}
    assert apps["w"]["delivery"] == {"default": "draft_pr"}
    assert apps["legacy"]["delivery"] == {"default": "auto_merge"}
    assert apps["legacy"]["path"] == str((factory_root.parent / "legacy").resolve())
    assert apps["w"]["pipeline_default"] == "chain"
    assert apps["legacy"]["pipeline_default"] == "chain"


def test_cli_add_has_no_delivery_max_flag(cli, tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "w", PY_UV, "https://github.com/o/w.git")
    r = cli("add", "--repo", "o/w", "--path", str(repo), "--delivery-max", "pr", "--json")
    assert r.exit_code != 0
    assert not (tmp_path / "software-factory/apps/w").exists()


def test_list_reports_legacy_delivery_max_as_broken(factory_root: Path) -> None:
    (factory_root / "apps/old").mkdir()
    (factory_root / "apps/old/config.yaml").write_text(
        yaml.safe_dump({"name": "old", "repo": "o/old", "delivery": {"max": "pr"}})
    )
    (row,) = list_registered_apps(factory_root)
    assert "delivery.max is not supported" in row["error"]


# --------------------------------------------------------------------------- #
# app set
# --------------------------------------------------------------------------- #

HAND_WRITTEN = """\
# Hand-written header — must survive.
name: w
repo: o/w   # the repo
delivery:
  # why draft: new repo
  default: draft_pr  # keep me
gates:
  test_command: "pytest -q"
models: {}
"""


def _app(factory_root: Path, text: str, name: str = "w") -> Path:
    d = factory_root / "apps" / name
    d.mkdir(parents=True)
    (d / "config.yaml").write_text(text)
    return d / "config.yaml"


def test_set_edits_in_place_and_keeps_comments(factory_root: Path) -> None:
    path = _app(factory_root, HAND_WRITTEN)
    res = set_app(
        root=factory_root, app="w", delivery_default="auto_merge", pipeline_default="solo"
    )
    assert res["delivery"] == {"default": "auto_merge"}
    assert res["pipeline_default"] == "solo"
    assert res["changed"] == ["delivery.default", "pipeline_default"]
    assert res["comments_preserved"] is True
    text = path.read_text()
    assert "# Hand-written header — must survive." in text
    assert "# why draft: new repo" in text
    assert "  default: auto_merge  # keep me" in text
    assert "repo: o/w   # the repo" in text
    assert text.endswith("pipeline_default: solo\n")
    cfg = load_app_config("w", factory_root)
    assert (cfg.delivery.default.value, cfg.pipeline_default, cfg.gates.test_command) == (
        "auto_merge",
        "solo",
        "pytest -q",
    )


def test_set_replaces_existing_pipeline_line(factory_root: Path) -> None:
    path = _app(factory_root, HAND_WRITTEN + "pipeline_default: chain  # app default\n")
    set_app(root=factory_root, app="w", pipeline_default="auto")
    assert "pipeline_default: auto  # app default" in path.read_text()
    assert path.read_text().count("pipeline_default") == 1


def test_set_adds_delivery_block_to_a_legacy_app(factory_root: Path) -> None:
    path = _app(factory_root, "name: w\nrepo: o/w\n# trailing comment\n")
    assert load_app_config("w", factory_root).delivery.default.value == "auto_merge"
    res = set_app(root=factory_root, app="w", delivery_default="pr")
    assert res["comments_preserved"] is True
    assert "# trailing comment" in path.read_text()
    assert load_app_config("w", factory_root).delivery.default.value == "pr"


def test_set_inserts_default_into_a_block_without_one(factory_root: Path) -> None:
    # A delivery block that only has a comment child (and another top key after).
    path = _app(factory_root, "name: w\nrepo: o/w\ndelivery:\n    # tbd\nmodels: {}\n")
    res = set_app(root=factory_root, app="w", delivery_default="branch")
    assert res["comments_preserved"] is True
    assert load_app_config("w", factory_root).delivery.default.value == "branch"
    assert "# tbd" in path.read_text()


def test_set_falls_back_to_redump_for_flow_style(factory_root: Path) -> None:
    path = _app(factory_root, "name: w\nrepo: o/w\ndelivery: {default: pr}  # flow\n")
    res = set_app(root=factory_root, app="w", delivery_default="none")
    assert res["comments_preserved"] is False
    assert load_app_config("w", factory_root).delivery.default.value == "none"
    assert yaml.safe_load(path.read_text())["repo"] == "o/w"


def test_set_noop_reports_nothing_changed(factory_root: Path) -> None:
    path = _app(factory_root, HAND_WRITTEN)
    res = set_app(root=factory_root, app="w", delivery_default="draft_pr")
    assert res["changed"] == []
    assert path.read_text() == HAND_WRITTEN


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"app": "ghost", "delivery_default": "pr"}, "unknown_app"),
        ({"app": "w"}, "nothing_to_set"),
        ({"app": "w", "delivery_default": "yolo"}, "invalid_delivery"),
        ({"app": "w", "pipeline_default": "swarm"}, "invalid_pipeline"),
        ({"app": "../etc", "delivery_default": "pr"}, "invalid_name"),
    ],
)
def test_set_refusals_write_nothing(factory_root: Path, kwargs: dict, code: str) -> None:
    path = _app(factory_root, HAND_WRITTEN)
    with pytest.raises(AppAddError) as exc:
        set_app(root=factory_root, **kwargs)
    assert exc.value.code == code
    assert path.read_text() == HAND_WRITTEN


def test_set_refuses_a_config_that_still_has_delivery_max(factory_root: Path) -> None:
    text = "name: w\nrepo: o/w\ndelivery:\n  max: pr\n  default: pr\n"
    path = _app(factory_root, text)
    with pytest.raises(AppAddError) as exc:
        set_app(root=factory_root, app="w", delivery_default="branch")
    assert exc.value.code == "invalid_config"
    assert "delivery.max" in exc.value.message
    assert path.read_text() == text


def test_cli_set_json(cli, factory_root: Path) -> None:
    _app(factory_root, HAND_WRITTEN)
    r = cli("set", "w", "--delivery-default", "pr", "--pipeline-default", "chain", "--json")
    assert r.exit_code == 0, r.output
    payload = json.loads(r.stdout)
    assert payload["delivery"] == {"default": "pr"}
    assert payload["pipeline_default"] == "chain"
    r = cli("set", "w", "--json")
    assert r.exit_code == 1
    assert json.loads(r.stdout)["error"] == "nothing_to_set"


def test_list_reports_broken_config_without_hiding_others(factory_root: Path) -> None:
    for name, body in (("ok", {"name": "ok", "repo": "o/ok"}), ("bad", {"name": "bad"})):
        (factory_root / "apps" / name).mkdir()
        (factory_root / "apps" / name / "config.yaml").write_text(yaml.safe_dump(body))
    rows = {r["app"]: r for r in list_registered_apps(factory_root)}
    assert rows["ok"]["repo"] == "o/ok"
    assert "error" in rows["bad"]


def test_app_config_pipeline_default_is_a_closed_set() -> None:
    from pydantic import ValidationError

    from factory.app_config import AppConfig

    assert AppConfig(name="a", repo="o/a").pipeline_default == "chain"
    for ok in ("chain", "solo", "auto"):
        assert AppConfig(name="a", repo="o/a", pipeline_default=ok).pipeline_default == ok
    with pytest.raises(ValidationError):
        AppConfig(name="a", repo="o/a", pipeline_default="swarm")
