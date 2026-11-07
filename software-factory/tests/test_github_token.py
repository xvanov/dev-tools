"""GitHub token resolution precedence.

Verifies ``factory.providers.github.resolve_github_token`` follows the
documented order: ``GITHUB_TOKEN`` env > ``GH_TOKEN`` env > shell out to
``gh auth token``. All subprocess invocations are monkeypatched — no real
``gh`` call is made.
"""

from __future__ import annotations

import subprocess
from typing import Any

import pytest

from factory.providers.github import resolve_github_token


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start each test with a clean slate — no token env vars set."""
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)


def test_prefers_github_token_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """``GITHUB_TOKEN`` wins over both ``GH_TOKEN`` and ``gh auth token``."""
    monkeypatch.setenv("GITHUB_TOKEN", "from-github-token")
    monkeypatch.setenv("GH_TOKEN", "from-gh-token")

    def _should_not_call(*a: Any, **kw: Any) -> Any:
        raise AssertionError("gh subprocess should not be invoked when GITHUB_TOKEN is set")

    monkeypatch.setattr(subprocess, "run", _should_not_call)
    assert resolve_github_token() == "from-github-token"


def test_falls_back_to_gh_token_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """``GH_TOKEN`` is used when ``GITHUB_TOKEN`` is unset."""
    monkeypatch.setenv("GH_TOKEN", "from-gh-token")

    def _should_not_call(*a: Any, **kw: Any) -> Any:
        raise AssertionError("gh subprocess should not be invoked when GH_TOKEN is set")

    monkeypatch.setattr(subprocess, "run", _should_not_call)
    assert resolve_github_token() == "from-gh-token"


def test_falls_back_to_gh_auth_token_subprocess(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When neither env var is set, shell out to ``gh auth token``."""

    def _fake_run(args: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        assert args == ["gh", "auth", "token"]
        return subprocess.CompletedProcess(
            args=args, returncode=0, stdout="ghp_subprocess_token\n", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", _fake_run)
    assert resolve_github_token() == "ghp_subprocess_token"


def test_returns_none_when_gh_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A FileNotFoundError (``gh`` binary not installed) silently returns None."""

    def _fake_run(*a: Any, **kw: Any) -> Any:
        raise FileNotFoundError("gh: command not found")

    monkeypatch.setattr(subprocess, "run", _fake_run)
    assert resolve_github_token() is None


def test_returns_none_when_gh_not_logged_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``gh auth token`` exits non-zero when the operator isn't logged in."""

    def _fake_run(args: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=args, returncode=1, stdout="", stderr="not logged in"
        )

    monkeypatch.setattr(subprocess, "run", _fake_run)
    assert resolve_github_token() is None


def test_returns_none_when_gh_outputs_empty_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Empty stdout from a 0-exit ``gh auth token`` is treated as no token."""

    def _fake_run(args: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="   \n", stderr="")

    monkeypatch.setattr(subprocess, "run", _fake_run)
    assert resolve_github_token() is None


def test_returns_none_when_gh_times_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A wedged ``gh`` binary must not block CLI startup."""

    def _fake_run(*a: Any, **kw: Any) -> Any:
        raise subprocess.TimeoutExpired(cmd="gh", timeout=5)

    monkeypatch.setattr(subprocess, "run", _fake_run)
    assert resolve_github_token() is None


def test_empty_env_var_falls_through_to_next(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty-string ``GITHUB_TOKEN`` doesn't shadow ``GH_TOKEN``.

    Operators sometimes leave a stale empty ``GITHUB_TOKEN=`` in ``.env``;
    treating that as "no token" instead of "use empty token" is the kinder
    failure mode.
    """
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.setenv("GH_TOKEN", "real-token")

    def _should_not_call(*a: Any, **kw: Any) -> Any:
        raise AssertionError("gh subprocess not needed when GH_TOKEN is set")

    monkeypatch.setattr(subprocess, "run", _should_not_call)
    assert resolve_github_token() == "real-token"
