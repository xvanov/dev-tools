"""Deployed stories close their GitHub issues + direction tracker.

Regression test for the 2026-07-18 audit finding: the chain set stories to
DEPLOYED but never closed their issues, so 64 issues for shipped work sat open.
"""

from __future__ import annotations

from typing import Any

from factory.directions.tracker_issue import close_story_issue


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


class _Client:
    def __init__(self, repo: _Repo) -> None:
        self._repo = repo

    def get_repo(self, full_name: str) -> _Repo:
        return self._repo


class _AppConfig:
    name = "sacrifice"
    repo = "owner/sacrifice"


class _Story:
    def __init__(self, issue_number: int | None) -> None:
        self.github_issue_number = issue_number


def test_deployed_story_issue_is_closed() -> None:
    issue = _Issue(42)
    client = _Client(_Repo({42: issue}))
    assert close_story_issue(_Story(42), _AppConfig(), client) is True
    assert issue.state == "closed"
    assert issue.comments and "Deployed" in issue.comments[0]


def test_already_closed_issue_is_noop() -> None:
    issue = _Issue(42, state="closed")
    client = _Client(_Repo({42: issue}))
    assert close_story_issue(_Story(42), _AppConfig(), client) is False
    assert issue.edits == []


def test_story_without_issue_number_is_noop() -> None:
    client = _Client(_Repo({}))
    assert close_story_issue(_Story(None), _AppConfig(), client) is False


def test_github_error_is_swallowed() -> None:
    class _BoomClient:
        def get_repo(self, full_name: str) -> Any:
            raise RuntimeError("gh down")

    # Must not raise — bookkeeping close is best-effort.
    assert close_story_issue(_Story(42), _AppConfig(), _BoomClient()) is False


def test_deploy_disabled_path_closes_story_and_tracker_issue(tmp_path: Any) -> None:
    """Regression: ``handle_deploy``'s ``if not app_config.deploy.enabled``
    early return (used by apps like sacrifice) advanced the story straight to
    DEPLOYED and returned WITHOUT closing its issues — only the
    reachable-but-only-via-``deploy_post_merge`` path a few lines below called
    ``_close_issues_on_deploy``. Since the early return short-circuits first,
    a deploy-disabled app NEVER closed issues on deploy (audit 2026-07-18).
    """
    import yaml

    from factory.app_config import load_app_config
    from factory.chain.handlers import handle_deploy, persist_story
    from factory.chain.state_machine import StoryRecord, StoryState
    from factory.settings.loader import reload_settings

    root = tmp_path
    apps = root / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "sacrifice",
                "repo": "o/r",
                "default_branch": "main",
                "deploy": {"enabled": False},
            }
        ),
        encoding="utf-8",
    )
    (root / "factory_settings.yaml").write_text(
        "modes:\n  default: normal\n  available: [normal, fix-only, paused, deploy-frozen]\n",
        encoding="utf-8",
    )
    (root / "state").mkdir()
    reload_settings(root)

    # Direction dir with a tracker issue so maybe_close_tracker_issue can act.
    direction_dir = apps / "directions" / "001-add-healthz"
    direction_dir.mkdir(parents=True)
    (direction_dir / "direction.md").write_text(
        "---\ntitle: add healthz\ntype: bug\n---\n\n# add healthz\n",
        encoding="utf-8",
    )
    (direction_dir / "state.yaml").write_text(
        yaml.safe_dump({"status": "pm-validated", "tracker_issue": 100}),
        encoding="utf-8",
    )

    cfg = load_app_config("sacrifice", root)
    story = StoryRecord(
        direction_id="001",
        app="sacrifice",
        title="add /healthz",
        slug="add-healthz",
        scope="backend",
        state=StoryState.DEPLOY_PENDING.value,
        github_pr_number=42,
        github_issue_number=55,
    )
    persist_story(story, root / "state" / "factory.db")

    story_issue = _Issue(55)
    tracker_issue = _Issue(100)
    client = _Client(_Repo({55: story_issue, 100: tracker_issue}))

    result = handle_deploy(story, cfg, root, dry_run=False, github_client=client)

    assert result.next_state == StoryState.DEPLOYED
    assert story.state == StoryState.DEPLOYED.value
    assert result.payload.get("reason") == "deploy_disabled_in_config"
    # The leak: both the story's own issue and the direction tracker (once
    # all its child stories are deployed — here the only one) must close.
    assert story_issue.state == "closed"
    assert tracker_issue.state == "closed"
