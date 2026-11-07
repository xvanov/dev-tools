"""Regression tests: auto-close-on-deploy was dead in production.

``_close_issues_on_deploy`` (factory/chain/handlers.py) used to no-op
whenever ``github_client`` was ``None``:

    if dry_run or github_client is None:
        return

But ``factory/chain/orchestrator.py::_invoke_handler`` NEVER passes a
``github_client`` into ``handle_deploy`` — so ``github_client`` is ``None``
on every real (non-test) deploy, and the auto-close silently no-opped on
EVERY deploy (confirmed: story 70 deployed, issue #235 stayed open).

The fix: when not ``dry_run`` and no client was supplied, self-construct one
via the shared ``factory.providers.github.build_github_client`` helper — the
same one ``factory.cli._ensure_github_client`` delegates to — instead of
giving up on ``None``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

import factory.providers.github as github_provider
from factory.chain.handlers import _close_issues_on_deploy
from factory.chain.state_machine import StoryRecord, StoryState


class _Issue:
    def __init__(self, number: int, state: str = "open") -> None:
        self.number = number
        self.state = state
        self.comments: list[str] = []
        self.edits: list[str] = []

    def create_comment(self, body: str) -> None:
        self.comments.append(body)

    def edit(self, state: str) -> None:
        self.edits.append(state)
        self.state = state


class _Repo:
    def __init__(self, issues: dict[int, _Issue]) -> None:
        self._issues = issues

    def get_issue(self, n: int) -> _Issue:
        return self._issues[n]


class _FakeClient:
    """Stand-in pygithub ``Github`` client that records whether it was used."""

    def __init__(self, repo: _Repo) -> None:
        self._repo = repo
        self.used = False

    def get_repo(self, full_name: str) -> _Repo:
        self.used = True
        return self._repo


class _AppConfig:
    name = "sacrifice"
    repo = "owner/sacrifice"


def _story(issue_number: int | None = 55) -> StoryRecord:
    # direction_id="" (not None) — the field is a plain ``str``, and an empty
    # string keeps ``maybe_close_tracker_issue`` out of scope for these tests
    # (its ``if story.direction_id:`` guard is falsy), isolating the
    # client-construction behavior under test.
    return StoryRecord(
        direction_id="",
        app="sacrifice",
        title="add /healthz",
        slug="add-healthz",
        scope="backend",
        state=StoryState.DEPLOYED.value,
        github_pr_number=42,
        github_issue_number=issue_number,
    )


def test_self_constructs_client_and_closes_when_none_supplied(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The missing regression: ``github_client=None`` + ``dry_run=False`` with
    a token available must still close the issue, not silently no-op."""
    issue = _Issue(55)
    fake_client = _FakeClient(_Repo({55: issue}))
    monkeypatch.setattr(github_provider, "build_github_client", lambda: fake_client)

    _close_issues_on_deploy(
        _story(),
        _AppConfig(),
        tmp_path,
        tmp_path / "factory.db",
        None,
        False,
    )

    assert fake_client.used is True
    assert issue.state == "closed"
    assert issue.comments and "Deployed" in issue.comments[0]


def test_existing_client_is_reused_without_reconstructing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """When a caller already passed a client, don't self-construct another."""

    def _should_not_be_called() -> Any:
        raise AssertionError("build_github_client must not be called when a client is supplied")

    monkeypatch.setattr(github_provider, "build_github_client", _should_not_be_called)

    issue = _Issue(55)
    supplied_client = _FakeClient(_Repo({55: issue}))

    _close_issues_on_deploy(
        _story(),
        _AppConfig(),
        tmp_path,
        tmp_path / "factory.db",
        supplied_client,
        False,
    )

    assert supplied_client.used is True
    assert issue.state == "closed"


def test_dry_run_makes_zero_github_calls(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """``dry_run=True`` must never construct a client or touch GitHub."""

    def _should_not_be_called() -> Any:
        raise AssertionError("build_github_client must not be called in dry_run")

    monkeypatch.setattr(github_provider, "build_github_client", _should_not_be_called)

    # Must not raise.
    _close_issues_on_deploy(
        _story(),
        _AppConfig(),
        tmp_path,
        tmp_path / "factory.db",
        None,
        True,
    )


def test_missing_token_does_not_crash(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """No token available -> warn and return; must never raise, so a deploy
    still succeeds even though the bookkeeping close is skipped."""
    monkeypatch.setattr(github_provider, "build_github_client", lambda: None)

    # Must not raise.
    _close_issues_on_deploy(
        _story(),
        _AppConfig(),
        tmp_path,
        tmp_path / "factory.db",
        None,
        False,
    )
