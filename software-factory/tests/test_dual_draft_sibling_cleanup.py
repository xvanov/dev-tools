"""Tests for ``close_abandoned_draft_sibling`` (audit 2026-07-18, leak 4 of 4).

The dual-draft flow spawns two ``draft-alternative`` StoryRecords per
ambiguous direction (``...-alt-a`` / ``...-alt-b``); whichever's PR merges
first should leave the other's issue (and branch) closed, but no code ever
did that — the tracker comment's promise ("the factory auto-cleans the
other draft once one alternative merges") was aspirational only. e.g. #210
stayed open forever after #209 (its sibling) merged.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from factory.chain.dual_draft import close_abandoned_draft_sibling
from factory.chain.handlers import get_story, persist_story
from factory.chain.state_machine import StoryRecord, StoryState


class _RunResult:
    returncode = 0
    stdout = ""
    stderr = ""


class _Runner:
    """Recording stand-in for ``subprocess.run`` — captures the argv of every
    ``gh pr close`` shell-out so tests can assert the loser's PR was closed
    without touching a real ``gh``."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> _RunResult:
        self.calls.append(list(argv))
        return _RunResult()


class _Issue:
    def __init__(self, number: int, state: str = "open") -> None:
        self.number = number
        self.state = state
        self.comments: list[str] = []
        self.close_reason: str | None = None

    def create_comment(self, body: str) -> None:
        self.comments.append(body)

    def edit(self, *, state: str, state_reason: str | None = None) -> None:
        self.state = state
        self.close_reason = state_reason


class _Repo:
    def __init__(self, issues: dict[int, _Issue]) -> None:
        self._issues = issues

    def get_issue(self, n: int) -> _Issue:
        return self._issues[n]


class _Client:
    def __init__(self, repo: _Repo) -> None:
        self._repo = repo

    def get_repo(self, full_name: str) -> _Repo:
        return self._repo


class _AppConfig:
    name = "sacrifice"
    repo = "owner/sacrifice"


def _mk_pair(
    db: Path, *, winner_suffix: str = "alt-a", loser_suffix: str = "alt-b"
) -> tuple[StoryRecord, StoryRecord]:
    winner = persist_story(
        StoryRecord(
            direction_id="007",
            app="sacrifice",
            title="Make the thing better — narrow read",
            slug=f"make-it-better-{winner_suffix}",
            scope="backend",
            state=StoryState.DEPLOY_PENDING.value,
            github_issue_number=209,
            github_pr_number=555,
        ),
        db,
    )
    loser = persist_story(
        StoryRecord(
            direction_id="007",
            app="sacrifice",
            title="Make the thing better — broad read",
            slug=f"make-it-better-{loser_suffix}",
            scope="backend",
            state=StoryState.PR_OPEN.value,
            github_issue_number=210,
            github_pr_number=556,
        ),
        db,
    )
    return winner, loser


def test_close_abandoned_draft_sibling_closes_the_losing_issue(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    winner, loser = _mk_pair(db)

    sibling_issue = _Issue(210)
    client = _Client(_Repo({209: _Issue(209), 210: sibling_issue}))
    runner = _Runner()

    result = close_abandoned_draft_sibling(
        winner, _AppConfig(), tmp_path, db, client, False, runner=runner
    )

    assert result is True
    # Issue closed with the right reason + winner reference.
    assert sibling_issue.state == "closed"
    assert sibling_issue.close_reason == "not_planned"
    assert sibling_issue.comments and "#209" in sibling_issue.comments[0]
    # Loser's open PR (556) was closed via ``gh pr close --delete-branch`` —
    # a closed PR cannot auto-merge (this is what stops the double-merge).
    assert runner.calls, "expected a gh pr close shell-out for the loser's PR"
    argv = runner.calls[0]
    assert argv[:3] == ["gh", "pr", "close"]
    assert "556" in argv
    assert "--delete-branch" in argv
    # Loser's StoryRecord terminally superseded; winner untouched.
    assert get_story(loser.id, db).state == StoryState.SUPERSEDED_BY_SIBLING.value
    assert get_story(winner.id, db).state == StoryState.DEPLOY_PENDING.value


def test_close_abandoned_draft_sibling_supersedes_loser_without_pr(tmp_path: Path) -> None:
    """A loser still in dev/review (NO PR yet) must be terminally superseded so
    the chain stops dispatching it — otherwise it opens a PR and merges later.
    No PR means no ``gh pr close`` is attempted."""
    db = tmp_path / "state" / "factory.db"
    winner = persist_story(
        StoryRecord(
            direction_id="007",
            app="sacrifice",
            title="winner — narrow read",
            slug="make-it-better-alt-a",
            scope="backend",
            state=StoryState.DEPLOY_PENDING.value,
            github_issue_number=209,
            github_pr_number=555,
        ),
        db,
    )
    loser = persist_story(
        StoryRecord(
            direction_id="007",
            app="sacrifice",
            title="loser — broad read (still in dev)",
            slug="make-it-better-alt-b",
            scope="backend",
            state=StoryState.DEV_IN_PROGRESS.value,
            github_issue_number=210,
            github_pr_number=None,  # no PR yet
        ),
        db,
    )
    sibling_issue = _Issue(210)
    client = _Client(_Repo({209: _Issue(209), 210: sibling_issue}))
    runner = _Runner()

    result = close_abandoned_draft_sibling(
        winner, _AppConfig(), tmp_path, db, client, False, runner=runner
    )

    assert result is True
    assert get_story(loser.id, db).state == StoryState.SUPERSEDED_BY_SIBLING.value
    # No PR → no gh pr close attempted.
    assert runner.calls == []
    # Winner untouched.
    assert get_story(winner.id, db).state == StoryState.DEPLOY_PENDING.value


def test_close_abandoned_draft_sibling_idempotent_second_call(tmp_path: Path) -> None:
    """A sibling already parked in SUPERSEDED_BY_SIBLING is a full no-op on a
    re-run: no gh calls, no raise, state unchanged."""
    db = tmp_path / "state" / "factory.db"
    winner, loser = _mk_pair(db)

    sibling_issue = _Issue(210)
    client = _Client(_Repo({209: _Issue(209), 210: sibling_issue}))

    # First call retires the loser.
    first_runner = _Runner()
    assert (
        close_abandoned_draft_sibling(
            winner, _AppConfig(), tmp_path, db, client, False, runner=first_runner
        )
        is True
    )
    assert get_story(loser.id, db).state == StoryState.SUPERSEDED_BY_SIBLING.value

    # Second call: loser already superseded → no-op, no new gh calls, no raise.
    second_runner = _Runner()
    reloaded_winner = get_story(winner.id, db)
    result = close_abandoned_draft_sibling(
        reloaded_winner, _AppConfig(), tmp_path, db, client, False, runner=second_runner
    )
    assert result is False
    assert second_runner.calls == []
    assert get_story(loser.id, db).state == StoryState.SUPERSEDED_BY_SIBLING.value


def test_close_abandoned_draft_sibling_noop_when_dry_run(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    winner, _loser = _mk_pair(db)

    sibling_issue = _Issue(210)
    client = _Client(_Repo({209: _Issue(209), 210: sibling_issue}))

    result = close_abandoned_draft_sibling(winner, _AppConfig(), tmp_path, db, client, True)

    assert result is False
    assert sibling_issue.state == "open"


def test_close_abandoned_draft_sibling_supersedes_without_github_client(tmp_path: Path) -> None:
    """No pygithub client → the DB supersede + PR-close STILL run (G2 decoupling);
    only the GitHub issue-close is skipped. (Previously this was a full no-op,
    which stranded the loser mid-dev whenever the reconcile path got a None
    client — the bug this change fixes.)"""
    db = tmp_path / "state" / "factory.db"
    winner, loser = _mk_pair(db)
    runner = _Runner()

    result = close_abandoned_draft_sibling(
        winner, _AppConfig(), tmp_path, db, None, False, runner=runner
    )

    assert result is True
    assert get_story(loser.id, db).state == StoryState.SUPERSEDED_BY_SIBLING.value
    assert runner.calls and "556" in runner.calls[0]  # PR still closed via gh


def test_close_abandoned_draft_sibling_ignores_non_dual_draft_story(tmp_path: Path) -> None:
    """A normal (non-dual-draft) story's slug carries no ``-alt-*`` suffix —
    nothing to clean up, even if other stories share its direction_id."""
    db = tmp_path / "state" / "factory.db"
    winner = persist_story(
        StoryRecord(
            direction_id="008",
            app="sacrifice",
            title="Ordinary story",
            slug="ordinary-story",
            scope="backend",
            state=StoryState.DEPLOY_PENDING.value,
            github_issue_number=300,
            github_pr_number=301,
        ),
        db,
    )
    persist_story(
        StoryRecord(
            direction_id="008",
            app="sacrifice",
            title="Another ordinary story",
            slug="another-ordinary-story",
            scope="frontend",
            state=StoryState.PR_OPEN.value,
            github_issue_number=302,
            github_pr_number=303,
        ),
        db,
    )
    other_issue = _Issue(302)
    client = _Client(_Repo({300: _Issue(300), 302: other_issue}))

    result = close_abandoned_draft_sibling(winner, _AppConfig(), tmp_path, db, client, False)

    assert result is False
    assert other_issue.state == "open"


def test_close_abandoned_draft_sibling_ignores_same_interpretation(tmp_path: Path) -> None:
    """Two rows sharing the SAME alt suffix (shouldn't normally happen) must
    never be treated as "the other" sibling — never self-close."""
    db = tmp_path / "state" / "factory.db"
    winner = persist_story(
        StoryRecord(
            direction_id="009",
            app="sacrifice",
            title="dup a",
            slug="dup-thing-alt-a",
            scope="backend",
            state=StoryState.DEPLOY_PENDING.value,
            github_issue_number=400,
            github_pr_number=401,
        ),
        db,
    )
    persist_story(
        StoryRecord(
            direction_id="009",
            app="sacrifice",
            title="dup a again",
            slug="dup-thing-again-alt-a",
            scope="backend",
            state=StoryState.PR_OPEN.value,
            github_issue_number=402,
            github_pr_number=403,
        ),
        db,
    )
    issue = _Issue(402)
    client = _Client(_Repo({400: _Issue(400), 402: issue}))

    result = close_abandoned_draft_sibling(winner, _AppConfig(), tmp_path, db, client, False)

    assert result is False
    assert issue.state == "open"


def test_close_abandoned_draft_sibling_swallows_github_error(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    winner, loser = _mk_pair(db)

    class _BoomClient:
        def get_repo(self, full_name: str) -> Any:
            raise RuntimeError("gh down")

    runner = _Runner()
    # A GitHub issue-API failure must not raise (bookkeeping is best-effort);
    # the loser is still terminally superseded and its PR still gets a close
    # attempt — the double-merge guard does not depend on the issue API.
    result = close_abandoned_draft_sibling(
        winner, _AppConfig(), tmp_path, db, _BoomClient(), False, runner=runner
    )
    assert result is True
    assert get_story(loser.id, db).state == StoryState.SUPERSEDED_BY_SIBLING.value


def test_close_abandoned_draft_sibling_swallows_pr_close_error(tmp_path: Path) -> None:
    """A ``gh pr close`` failure must not raise or abort the supersede — the
    story is still parked terminally so the chain stops driving it."""
    db = tmp_path / "state" / "factory.db"
    winner, loser = _mk_pair(db)

    def _boom_runner(argv: list[str], **kwargs: Any) -> Any:
        raise RuntimeError("gh not installed")

    sibling_issue = _Issue(210)
    client = _Client(_Repo({209: _Issue(209), 210: sibling_issue}))

    result = close_abandoned_draft_sibling(
        winner, _AppConfig(), tmp_path, db, client, False, runner=_boom_runner
    )
    assert result is True
    assert get_story(loser.id, db).state == StoryState.SUPERSEDED_BY_SIBLING.value
    # The issue was still closed (PR-close failure is isolated).
    assert sibling_issue.state == "closed"


def test_superseded_by_sibling_is_terminal_everywhere() -> None:
    """SUPERSEDED_BY_SIBLING is a terminal sink: no outgoing transition, not
    dispatchable, not mergeable, and it does not count as in-flight."""
    from factory.chain.auto_merge import _MERGEABLE_STATES
    from factory.chain.factory_status import _TERMINAL_STATES
    from factory.chain.orchestrator import (
        _DISPATCH,
        _NON_CAP_COUNTING_STATES,
        _dispatch_for_story,
    )
    from factory.chain.state_machine import is_terminal

    state = StoryState.SUPERSEDED_BY_SIBLING

    # No outgoing transition → terminal per the state machine.
    assert is_terminal(state)
    # Not a dispatch state → the orchestrator never picks a handler for it.
    assert state not in _DISPATCH
    assert _dispatch_for_story(_story(state)) is None
    # Not mergeable → the auto-merge worker never acts on it.
    assert state.value not in _MERGEABLE_STATES
    # Terminal for status/in-flight accounting.
    assert state.value in _TERMINAL_STATES
    assert state.value in _NON_CAP_COUNTING_STATES


def _story(state: StoryState) -> StoryRecord:
    return StoryRecord(
        direction_id="007",
        app="sacrifice",
        title="t",
        slug="s-alt-b",
        scope="backend",
        state=state.value,
    )


# --------------------------------------------------------------------------- #
# G2 hardening: supersede is a PURE DB write — never coupled to a GitHub token
# --------------------------------------------------------------------------- #


def test_never_downgrades_a_shipped_sibling(tmp_path: Path) -> None:
    """A sibling that legitimately SHIPPED (DEPLOYED) must never be downgraded to
    superseded (both-shipped residue is harmless and left alone). Any terminal
    sibling is skipped idempotently."""
    db = tmp_path / "state" / "factory.db"
    winner, loser = _mk_pair(db)
    # Both siblings deployed (pre-#87 over-fire residue shape).
    loser.state = StoryState.DEPLOYED.value
    persist_story(loser, db)

    result = close_abandoned_draft_sibling(
        winner, _AppConfig(), tmp_path, db, None, False, runner=_Runner()
    )

    assert result is False  # nothing retired
    assert get_story(loser.id, db).state == StoryState.DEPLOYED.value  # NOT downgraded


def test_never_downgrades_a_deploy_pending_sibling(tmp_path: Path) -> None:
    """A sibling at DEPLOY_PENDING (its own PR merged, deploy enqueued) must NOT
    be superseded — it is shipping, not a loser. Guards the transient
    both-merged race even though DEPLOY_PENDING is non-terminal."""
    db = tmp_path / "state" / "factory.db"
    winner, loser = _mk_pair(db)
    loser.state = StoryState.DEPLOY_PENDING.value  # loser's PR also merged
    persist_story(loser, db)

    result = close_abandoned_draft_sibling(
        winner, _AppConfig(), tmp_path, db, None, False, runner=_Runner()
    )

    assert result is False
    assert get_story(loser.id, db).state == StoryState.DEPLOY_PENDING.value  # not downgraded


def test_dry_run_suppresses_all_effects(tmp_path: Path) -> None:
    """``dry_run=True`` still short-circuits everything (no DB write, no gh)."""
    db = tmp_path / "state" / "factory.db"
    winner, loser = _mk_pair(db)
    runner = _Runner()

    result = close_abandoned_draft_sibling(
        winner, _AppConfig(), tmp_path, db, None, True, runner=runner
    )

    assert result is False
    assert get_story(loser.id, db).state == StoryState.PR_OPEN.value  # untouched
    assert not runner.calls
