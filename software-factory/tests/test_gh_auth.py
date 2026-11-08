"""Per-owner GitHub token resolution (factory.gh_auth) and the bin/gh shim.

All subprocess calls are monkeypatched: no real ``gh``/network.
"""

from __future__ import annotations

import subprocess
from typing import Any

import pytest

from factory import gh_auth
from factory.providers.github import resolve_github_token


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for n in ("FACTORY_GITHUB_TOKEN", "FACTORY_GH_OWNER_MAP", "GITHUB_TOKEN", "GH_TOKEN"):
        monkeypatch.delenv(n, raising=False)


def _fake_gh(calls: list[list[str]], tokens: dict[str | None, str]):
    """tokens maps gh --user name (None = active account) -> token."""

    def run(cmd: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        calls.append(list(cmd))
        assert cmd[1:3] == ["auth", "token"]
        user = cmd[4] if cmd[3:4] == ["--user"] else None
        if user in tokens:
            return subprocess.CompletedProcess(cmd, 0, tokens[user] + "\n", "")
        return subprocess.CompletedProcess(cmd, 1, "", "no account")

    return run


def test_default_map_pins_personal_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", _fake_gh(calls, {"xvanov": "tok-x", None: "tok-active"}))
    assert gh_auth.token_for_repo("xvanov/dev-tools") == "tok-x"
    assert calls == [["gh", "auth", "token", "--user", "xvanov"]]


def test_owner_match_is_case_insensitive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_gh([], {"xvanov": "tok-x"}))
    assert gh_auth.token_for_repo("XVanov/Repo") == "tok-x"


def test_unknown_owner_uses_active_account(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", _fake_gh(calls, {"xvanov": "tok-x", None: "tok-active"}))
    assert gh_auth.token_for_repo("someorg/app") == "tok-active"
    assert calls == [["gh", "auth", "token"]]
    assert gh_auth.is_pinned("someorg/app") is False


def test_env_map_adds_and_removes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACTORY_GH_OWNER_MAP", "acme=acme-bot, xvanov=")
    assert gh_auth.owner_map() == {"acme": "acme-bot"}
    monkeypatch.setattr(subprocess, "run", _fake_gh([], {"acme-bot": "tok-a", None: "tok-active"}))
    assert gh_auth.token_for_repo("acme/x") == "tok-a"
    assert gh_auth.token_for_repo("xvanov/x") == "tok-active"


def test_mapped_owner_never_falls_back_to_active(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_gh([], {None: "tok-active"}))
    assert gh_auth.token_for_repo("xvanov/dev-tools") is None


def test_mapped_owner_ignores_ambient_env_when_gh_user_resolves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GH_TOKEN", "ambient-work-token")
    monkeypatch.setattr(subprocess, "run", _fake_gh([], {"xvanov": "tok-x"}))
    assert gh_auth.token_for_repo("xvanov/dev-tools") == "tok-x"


def test_mapped_owner_falls_back_to_ambient_env_without_login(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CI case: no gh logins, only the runner's GITHUB_TOKEN."""
    monkeypatch.setenv("GITHUB_TOKEN", "ci-token")
    monkeypatch.setattr(subprocess, "run", _fake_gh([], {}))
    assert gh_auth.token_for_repo("xvanov/dev-tools") == "ci-token"


def test_unknown_owner_prefers_ambient_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_TOKEN", "env-tok")

    def boom(*a: Any, **k: Any) -> Any:
        raise AssertionError("no subprocess expected")

    monkeypatch.setattr(subprocess, "run", boom)
    assert gh_auth.token_for_repo("someorg/app") == "env-tok"


def test_factory_override_wins_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACTORY_GITHUB_TOKEN", "override")
    monkeypatch.setenv("GH_TOKEN", "ambient")

    def boom(*a: Any, **k: Any) -> Any:
        raise AssertionError("no subprocess expected")

    monkeypatch.setattr(subprocess, "run", boom)
    assert gh_auth.token_for_repo("xvanov/a") == "override"
    assert gh_auth.token_for_repo("other/b") == "override"
    assert gh_auth.token_for_repo(None) == "override"
    assert resolve_github_token() == "override"


def test_gh_env_sets_gh_token_only_when_pinned(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_gh([], {"xvanov": "tok-x", None: "tok-active"}))
    base = {"PATH": "/bin", "GITHUB_TOKEN": "stale"}
    pinned = gh_auth.gh_env("xvanov/a", base)
    assert pinned["GH_TOKEN"] == "tok-x" and "GITHUB_TOKEN" not in pinned
    other = gh_auth.gh_env("org/b", base)
    assert other == base  # untouched: gh uses its active account
    assert base["GITHUB_TOKEN"] == "stale"  # input not mutated


def test_resolve_github_token_with_repo_is_per_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subprocess, "run", _fake_gh([], {"xvanov": "tok-x"}))
    assert resolve_github_token("xvanov/dev-tools") == "tok-x"


@pytest.mark.parametrize(
    "url,repo",
    [
        ("git@github.com:o/r.git", "o/r"),
        ("git@github-xvanov:xvanov/dev-tools.git\n", "xvanov/dev-tools"),
        ("https://github.com/o/r", "o/r"),
        ("https://github.com/o/r.git/", "o/r"),
        ("ssh://git@github.com/o/r.git", "o/r"),
        ("git@gitlab.com:o/r.git", None),
    ],
)
def test_repo_from_remote_url(url: str, repo: str | None) -> None:
    assert gh_auth.repo_from_remote_url(url) == repo


def test_repo_owner_parsing() -> None:
    assert gh_auth.repo_owner("o/r") == "o"
    assert gh_auth.repo_owner("github.com/o/r") == "o"
    assert gh_auth.repo_owner("nonsense") is None
    assert gh_auth.repo_owner(None) is None


def test_repo_from_cwd(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    def run(cmd: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        assert cmd == ["git", "remote", "get-url", "origin"]
        assert kw["cwd"] == str(tmp_path)
        return subprocess.CompletedProcess(cmd, 0, "git@github-xvanov:xvanov/dev-tools.git\n", "")

    monkeypatch.setattr(subprocess, "run", run)
    assert gh_auth.repo_from_cwd(tmp_path) == "xvanov/dev-tools"


@pytest.mark.skipif(__import__("sys").platform == "win32", reason="Windows uses the Popen hook")
def test_install_shim_on_path_idempotent_and_optout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("FACTORY_GH_SHIM", "0")
    gh_auth.install_shim_on_path()
    assert str(gh_auth.shim_dir()) not in __import__("os").environ["PATH"]
    monkeypatch.setenv("FACTORY_GH_SHIM", "1")
    gh_auth.install_shim_on_path()
    gh_auth.install_shim_on_path()
    import os

    parts = os.environ["PATH"].split(os.pathsep)
    assert parts[0] == str(gh_auth.shim_dir()) and parts.count(parts[0]) == 1


def _load_shim() -> Any:
    import importlib.machinery
    import importlib.util

    path = str(gh_auth.shim_dir() / "gh")
    loader = importlib.machinery.SourceFileLoader("_gh_shim", path)
    spec = importlib.util.spec_from_loader("_gh_shim", loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.mark.parametrize(
    "args,repo",
    [
        (["pr", "view", "5", "--repo", "o/r"], "o/r"),
        (["pr", "view", "5", "-R", "o/r"], "o/r"),
        (["pr", "view", "--repo=o/r"], "o/r"),
        (["api", "repos/o/r/branches/main/protection"], "o/r"),
        (["api", "/repos/o/r/pulls"], "o/r"),
        (["repo", "clone", "o/r", "dest"], "o/r"),
        (["api", "user"], None),
        (["pr", "list"], None),
    ],
)
def test_shim_repo_extraction(args: list[str], repo: str | None) -> None:
    assert gh_auth.repo_from_gh_args(args) == repo
    _load_shim()  # the shim script must at least import cleanly


def test_popen_hook_injects_token_only_for_pinned_gh(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, Any]] = []

    def rec(self: Any, args: Any, *a: Any, **kw: Any) -> None:
        seen.append({"args": args, "env": kw.get("env")})

    monkeypatch.setattr(subprocess.Popen, "__init__", rec)
    monkeypatch.setattr(gh_auth, "_hook_installed", False)
    monkeypatch.setattr(gh_auth, "token_for_repo", lambda repo, gh_bin="gh": "tok-" + repo)
    monkeypatch.setattr(gh_auth, "repo_from_cwd", lambda cwd=None: None)
    gh_auth.install_popen_hook()

    subprocess.Popen(["gh", "pr", "view", "--repo", "xvanov/dev-tools"])
    subprocess.Popen(["gh.exe", "api", "repos/xvanov/x/pulls"], env={"A": "1"})
    subprocess.Popen(["gh", "pr", "view", "--repo", "other/app"])
    subprocess.Popen(["gh", "auth", "token", "--user", "xvanov"])
    subprocess.Popen(["git", "push"])
    assert seen[0]["env"]["GH_TOKEN"] == "tok-xvanov/dev-tools"
    assert seen[1]["env"]["GH_TOKEN"] == "tok-xvanov/x" and seen[1]["env"]["A"] == "1"
    assert [s["env"] for s in seen[2:]] == [None, None, None]
