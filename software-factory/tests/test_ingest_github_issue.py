"""ingest_github_direction_issue: splits ## User flow / ## API spec sections."""

from __future__ import annotations

from pathlib import Path

from factory.directions.ingester import ingest_github_direction_issue
from factory.directions.parser import parse_direction_dir


class _FakeLabel:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeIssue:
    def __init__(self, number: int, title: str, body: str, label_names: list[str]) -> None:
        self.number = number
        self.title = title
        self.body = body
        self.labels = [_FakeLabel(n) for n in label_names]


class _FakeRepo:
    def __init__(self, issue: _FakeIssue) -> None:
        self._issue = issue

    def get_issue(self, n: int) -> _FakeIssue:
        assert n == self._issue.number
        return self._issue


class _FakeGithub:
    def __init__(self, repo: _FakeRepo) -> None:
        self._repo = repo

    def get_repo(self, full_name: str) -> _FakeRepo:
        return self._repo


def _seed_app(tmp_path: Path) -> None:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text(
        "name: sacrifice\nrepo: xvanov/sacrifice\ndefault_branch: main\n"
        "context_dir: context\ndeploy:\n  enabled: false\nmodels: {}\n",
        encoding="utf-8",
    )


def test_ingest_splits_flow_and_api_sections(tmp_path: Path) -> None:
    _seed_app(tmp_path)
    body = (
        "## Why\n\n"
        "Need a smoke test target.\n\n"
        "## Acceptance Criteria\n\n"
        "- [ ] /healthz returns 200\n\n"
        "## User flow\n\n"
        "1. Operator runs `curl /healthz`\n"
        "2. Sees JSON body with `status: ok`\n\n"
        "## API spec\n\n"
        '- `GET /healthz` -> 200 {"status":"ok"}\n'
    )
    issue = _FakeIssue(
        number=42,
        title="[DIRECTION] Add healthz endpoint",
        body=body,
        label_names=["direction", "feature", "priority/p1"],
    )
    gh = _FakeGithub(_FakeRepo(issue))

    direction = ingest_github_direction_issue(
        issue_number=42,
        app="sacrifice",
        software_factory_root=tmp_path,
        github_client=gh,
    )

    assert direction.title == "Add healthz endpoint"
    assert direction.has_flow is True
    assert direction.has_api_spec is True
    assert direction.type_tag == "feature"
    # priority surfaced into raw_frontmatter
    assert direction.raw_frontmatter["priority"] == "p1"

    flow_text = (direction.dir_path / "flow.md").read_text(encoding="utf-8")
    assert "Operator runs" in flow_text
    assert "JSON body" in flow_text

    api_text = (direction.dir_path / "api_spec.md").read_text(encoding="utf-8")
    assert "/healthz" in api_text
    assert "GET" in api_text

    # state.yaml records provenance.
    re_parsed = parse_direction_dir("sacrifice", direction.dir_path)
    assert re_parsed.state["source"] == "github_issue"
    assert re_parsed.state["source_issue"] == 42


def test_ingest_without_optional_sections_only_writes_direction_md(tmp_path: Path) -> None:
    _seed_app(tmp_path)
    body = "## Why\n\nIdle thought.\n\n## Acceptance Criteria\n\n- [ ] thing happens\n"
    issue = _FakeIssue(
        number=7,
        title="[DIRECTION] Vague request",
        body=body,
        label_names=["direction"],
    )
    gh = _FakeGithub(_FakeRepo(issue))

    direction = ingest_github_direction_issue(
        issue_number=7,
        app="sacrifice",
        software_factory_root=tmp_path,
        github_client=gh,
    )

    assert direction.has_flow is False
    assert direction.has_api_spec is False
    assert direction.type_tag is None
    assert (direction.dir_path / "direction.md").exists()
    assert not (direction.dir_path / "flow.md").exists()
    assert not (direction.dir_path / "api_spec.md").exists()


def test_ingest_picks_up_explore_tag_in_title(tmp_path: Path) -> None:
    _seed_app(tmp_path)
    issue = _FakeIssue(
        number=99,
        title="[DIRECTION] What if we tried X (explore)",
        body="## Why\n\nHunch.\n",
        label_names=["direction"],
    )
    gh = _FakeGithub(_FakeRepo(issue))
    direction = ingest_github_direction_issue(
        issue_number=99,
        app="sacrifice",
        software_factory_root=tmp_path,
        github_client=gh,
    )
    assert direction.explore_tag is True
