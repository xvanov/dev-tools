"""Tests for the local-git fallback in the self-edit diff gate.

``gh pr diff`` (and the GitHub diff view it wraps) refuses any PR whose diff
exceeds 20,000 lines (``HTTP 406``). Direction 018's ~226-file, ~25,600-line
untracking tripped this, leaving story 167 permanently unmergeable: the gate
correctly refused to merge a diff it could not read, but there was no
recovery path. ``_default_patch_provider`` now falls back to a local
``git fetch`` + ``git diff`` (no line cap) when ``gh`` fails and a repo root
is available. All subprocess calls are mocked; nothing touches the network.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from factory.app_config import AppConfig
from factory.chain.auto_merge import _default_patch_provider, _local_git_patch_fallback


def _factory_cfg() -> AppConfig:
    return AppConfig(name="factory", repo="xvanov/software-factory", default_branch="main")


class _FakeRun:
    """Records every ``subprocess.run`` call and replays canned results keyed
    by the leading command tokens, so tests can assert exactly which git
    commands the fallback issues without a real remote."""

    def __init__(self, results: dict[tuple[str, ...], subprocess.CompletedProcess]) -> None:
        self.results = results
        self.calls: list[list[str]] = []

    def __call__(self, cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
        self.calls.append(cmd)
        key = tuple(cmd)
        for pattern, result in self.results.items():
            if key[: len(pattern)] == pattern:
                return result
        raise AssertionError(f"unexpected subprocess call: {cmd!r}")


def _ok(stdout: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")


def _fail() -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="boom")


def test_default_patch_provider_uses_gh_when_it_succeeds(
    tmp_path: Path, monkeypatch: Any
) -> None:
    fake = _FakeRun({("gh", "pr", "diff"): _ok("diff --git a/x b/x\n")})
    monkeypatch.setattr(subprocess, "run", fake)
    patch = _default_patch_provider(_factory_cfg(), 42, root=tmp_path)
    assert patch == "diff --git a/x b/x\n"
    # gh succeeded — no git fallback commands were ever issued.
    assert all(c[0] == "gh" for c in fake.calls)


def test_default_patch_provider_falls_back_to_git_on_gh_failure(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """Simulates gh's 20,000-line-diff refusal: gh fails, local git recovers."""
    fake = _FakeRun(
        {
            ("gh", "pr", "diff"): _fail(),
            ("git", "fetch", "origin", "main"): _ok(),
            ("git", "fetch", "origin"): _ok(),  # pull/<n>/head fetch
            ("git", "diff"): _ok("diff --git a/big b/big\n+++ b/big\n"),
            ("git", "update-ref", "-d"): _ok(),
        }
    )
    monkeypatch.setattr(subprocess, "run", fake)
    patch = _default_patch_provider(_factory_cfg(), 167, root=tmp_path)
    assert patch == "diff --git a/big b/big\n+++ b/big\n"
    # The scratch ref must be cleaned up regardless of outcome.
    assert any(c[:3] == ["git", "update-ref", "-d"] for c in fake.calls)


def test_default_patch_provider_returns_none_without_root_on_gh_failure(
    tmp_path: Path, monkeypatch: Any
) -> None:
    fake = _FakeRun({("gh", "pr", "diff"): _fail()})
    monkeypatch.setattr(subprocess, "run", fake)
    assert _default_patch_provider(_factory_cfg(), 167, root=None) is None


def test_local_git_patch_fallback_returns_none_when_head_fetch_fails(
    tmp_path: Path, monkeypatch: Any
) -> None:
    fake = _FakeRun(
        {
            ("git", "fetch", "origin", "main"): _ok(),
            ("git", "fetch", "origin"): _fail(),  # pull/<n>/head fetch fails
            ("git", "update-ref", "-d"): _ok(),
        }
    )
    monkeypatch.setattr(subprocess, "run", fake)
    patch = _local_git_patch_fallback(_factory_cfg(), 167, root=tmp_path)
    assert patch is None
    # Still cleans up the scratch ref even though nothing was fetched into it.
    assert any(c[:3] == ["git", "update-ref", "-d"] for c in fake.calls)


def test_local_git_patch_fallback_returns_none_without_root() -> None:
    assert _local_git_patch_fallback(None, 167, root=None) is None  # type: ignore[arg-type]
