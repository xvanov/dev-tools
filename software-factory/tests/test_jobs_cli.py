"""``factory job …`` — submit / status / list / cancel / follow (docs/JOBS-API.md).

Every test runs against a throwaway factory root (``tmp_path``); GitHub is
mocked at the single ``factory.jobs.github._run_gh`` seam.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml
from sqlmodel import Session, SQLModel, create_engine
from typer.testing import CliRunner

import factory.cli_jobs as cli_jobs
import factory.jobs.github as gh_mod
from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.directions.approval import is_auto_buildable, requires_operator_approval
from factory.directions.parser import parse_direction_dir
from factory.directions.watcher import hydrate_direction_source
from factory.jobs import status as status_mod
from factory.jobs.follow import follow_job
from factory.jobs.status import cancel_job, job_status, list_jobs

# --------------------------------------------------------------------------- #
# fixtures / helpers
# --------------------------------------------------------------------------- #


def _write_app(root: Path, name: str, repo: str, extra: str = "") -> None:
    d = root / "apps" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.yaml").write_text(f"name: {name}\nrepo: {repo}\n{extra}", encoding="utf-8")


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    _write_app(tmp_path, "demo", "acme/demo", "delivery:\n  default: draft_pr\n")
    _write_app(tmp_path, "legacy", "acme/legacy")  # no delivery block → auto_merge
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(cli_jobs, "_FACTORY_ROOT", tmp_path)
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(tmp_path))
    # Default: gh unreachable. Tests that need GitHub install their own fake.
    monkeypatch.setattr(gh_mod, "_run_gh", _gh_down)
    return tmp_path


def _gh_down(args: list[str]) -> subprocess.CompletedProcess[str]:
    raise FileNotFoundError("gh")


def _fake_gh(prs: list[dict[str, Any]], branches: set[str] | None = None) -> Any:
    calls: list[list[str]] = []

    def run(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args[:2] == ["pr", "list"]:
            return subprocess.CompletedProcess(args, 0, json.dumps(prs), "")
        if args[:2] == ["pr", "view"]:
            return subprocess.CompletedProcess(args, 1, "", "no pull requests found")
        if args[0] == "api":
            branch = args[1].split("/branches/", 1)[1]
            if branches and branch in branches:
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 1, "", "gh: Not Found (HTTP 404)")
        raise AssertionError(args)

    run.calls = calls  # type: ignore[attr-defined]
    return run


def _cli(*args: str, default_source: bool = True) -> tuple[int, Any]:
    """Invoke ``factory job …``. ``--source`` is required (review nice 9);
    submit calls get ``--source pa`` unless they pass their own or opt out."""
    from factory.cli import app

    argv = list(args)
    if default_source and argv and argv[0] == "submit" and "--source" not in argv:
        argv += ["--source", "pa"]
    result = CliRunner().invoke(app, ["job", *argv])
    out = result.stdout.strip()
    return result.exit_code, (json.loads(out) if out.startswith("{") else out)


def _submit(*extra: str, app: str = "demo") -> dict[str, Any]:
    code, obj = _cli(
        "submit",
        "--json",
        "--app",
        app,
        "--title",
        "Add dark mode",
        "--ask",
        "Users want dark mode.",
        "--done",
        "The settings page shows a dark mode toggle",
        *extra,
    )
    assert code == 0, obj
    return obj


def _story(root: Path, direction_id: str, state: str, **kw: Any) -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id=direction_id,
            app=kw.pop("app", "demo"),
            title="t",
            slug=kw.pop("slug", f"s-{state}"),
            scope="backend",
            state=state,
            **kw,
        ),
        root / "state" / "factory.db",
    )


# --------------------------------------------------------------------------- #
# submit
# --------------------------------------------------------------------------- #


def test_submit_writes_an_operator_approved_job_direction(root: Path) -> None:
    obj = _submit("--delivery", "draft_pr", "--model", "reviewer=azure/some-reviewer")
    assert obj["job_id"] == "demo:001"
    assert obj["created"] is True
    assert obj["delivery"] == "draft_pr"
    assert obj["delivery_requested"] == "draft_pr"
    assert obj["pipeline"] == "chain"  # auto → no app default → chain

    d = Path(obj["direction_path"])
    meta = parse_direction_dir("demo", d).raw_frontmatter
    assert meta["source"] == "pa"
    assert meta["pipeline"] == "auto"
    assert meta["delivery"] == "draft_pr"
    assert meta["models"] == {"reviewer": "azure/some-reviewer"}
    assert (d / "artifacts" / "ask.md").read_text() == "Users want dark mode."

    direction = hydrate_direction_source(
        parse_direction_dir("demo", d), root / "state" / "factory.db"
    )
    assert direction.state["source"] == "pa"
    assert direction.state["operator_approval"]["approved"] is True
    assert is_auto_buildable(direction)
    # No staging directory left behind.
    assert [p.name for p in d.parent.iterdir()] == [d.name]


def test_pa_source_is_operator_intent_even_without_an_approval_record(root: Path) -> None:
    obj = _submit()
    d = Path(obj["direction_path"])
    state = yaml.safe_load((d / "state.yaml").read_text())
    state.pop("operator_approval")
    (d / "state.yaml").write_text(yaml.safe_dump(state))
    direction = parse_direction_dir("demo", d)
    assert not requires_operator_approval(direction)


def test_finding7_other_sources_stay_pending_approval(root: Path) -> None:
    """Only ``pa`` and ``human`` get a signed approval; any other source's job
    waits for ``factory approve-direction`` like any machine-filed direction."""
    obj = _submit("--source", "slack-bot")
    d = Path(obj["direction_path"])
    assert "operator_approval" not in (yaml.safe_load((d / "state.yaml").read_text()) or {})
    direction = parse_direction_dir("demo", d)
    hydrate_direction_source(direction, root / "state" / "factory.db")
    assert requires_operator_approval(direction)
    assert not is_auto_buildable(direction)
    assert any("approve-direction" in w for w in obj["warnings"])
    assert job_status(root, obj["job_id"], github=False)["state"] == "needs_human"


@pytest.mark.parametrize("source", ["pa", "human"])
def test_finding7_pa_and_human_are_signed(root: Path, source: str) -> None:
    obj = _submit("--source", source)
    d = Path(obj["direction_path"])
    approval = (yaml.safe_load((d / "state.yaml").read_text()) or {})["operator_approval"]
    assert approval["approved"] is True and approval["approved_by"].endswith(f":{source}")
    assert is_auto_buildable(parse_direction_dir("demo", d))
    assert not any("approve-direction" in w for w in obj["warnings"])


def test_submit_is_idempotent_on_source_and_external_id(root: Path) -> None:
    a = _submit("--external-id", "run-1")
    b = _submit("--external-id", "run-1")
    assert a["created"] is True and b["created"] is False
    assert a["job_id"] == b["job_id"]
    c = _submit("--external-id", "run-1", "--source", "other")
    assert c["created"] is True and c["job_id"] == "demo:002"
    dirs = sorted(p.name for p in (root / "apps" / "demo" / "directions").iterdir())
    assert len(dirs) == 2


def test_submit_resolves_repo_to_app(root: Path) -> None:
    code, obj = _cli("submit", "--json", "--repo", "Acme/Legacy", "--title", "x", "--ask", "y")
    assert code == 0, obj
    assert obj["app"] == "legacy"
    assert obj["delivery"] == "auto_merge"  # no delivery block: today's behaviour


@pytest.mark.parametrize(
    ("args", "code"),
    [
        (["--repo", "nobody/nothing"], "unknown_repo"),
        (["--app", "ghost"], "unknown_app"),
        (["--app", "demo", "--delivery", "yolo"], "invalid_delivery"),
        (["--app", "demo", "--pipeline", "swarm"], "bad_pipeline"),
        (["--app", "demo", "--model", "nobody=x/y"], "unknown_persona"),
        (["--app", "demo", "--model", "reviewer"], "bad_model_flag"),
        # A bare id without a provider/ prefix is refused at submit (#332).
        (["--app", "demo", "--model", "reviewer=gpt-5.4"], "bad_model_id"),
        (["--app", "demo", "--repo", "acme/legacy"], "app_repo_mismatch"),
        ([], "missing_argument"),
    ],
)
def test_submit_errors_are_one_json_object(root: Path, args: list[str], code: str) -> None:
    exit_code, obj = _cli("submit", "--json", "--title", "t", "--ask", "a", *args)
    assert exit_code != 0
    assert obj["error"] == code and obj["message"]
    assert not (root / "apps" / "demo" / "directions").exists()


def test_submit_refuses_a_reviewer_dev_model_collision(root: Path) -> None:
    exit_code, obj = _cli(
        "submit",
        "--json",
        "--app",
        "demo",
        "--title",
        "t",
        "--ask",
        "a",
        "--model",
        "dev=azure/same",
        "--model",
        "reviewer=azure/same",
    )
    assert exit_code != 0 and obj["error"] == "review_independence"


def test_submit_requires_title_as_json_error(root: Path) -> None:
    exit_code, obj = _cli("submit", "--json", "--app", "demo", "--ask", "a")
    assert exit_code == 1
    assert obj == {"error": "missing_argument", "message": "--title is required"}


@pytest.mark.parametrize(
    "level", ["none", "branch", "draft_pr", "pr", "auto_merge", "push_to_main"]
)
def test_every_delivery_level_is_accepted_no_ceiling(root: Path, level: str) -> None:
    obj = _submit("--delivery", level)
    assert obj["delivery_requested"] == level
    assert obj["delivery"] == level
    fm = Path(obj["direction_path"], "direction.md").read_text()
    assert f"delivery: {level}" in fm


def test_pipeline_auto_uses_app_config_pipeline_default(root: Path) -> None:
    _write_app(root, "auto-app", "acme/auto", "pipeline_default: auto\n")
    assert _submit(app="auto-app")["pipeline"] == "chain"  # app-level auto = chain (v1)
    # The production solo engine exists (#333): an app default of solo is honoured.
    _write_app(root, "solo-app", "acme/solo", "pipeline_default: solo\n")
    assert _submit(app="solo-app")["pipeline"] == "solo"


def test_solo_is_accepted_except_on_the_factory_without_opt_in(root: Path) -> None:
    """#333: solo is accepted on any app; the factory's OWN repo needs an
    explicit ``solo_allowed: true`` (a reviewer-less self-edit is an operator
    decision), else ``pipeline_unavailable``."""
    assert _submit("--pipeline", "solo")["pipeline"] == "solo"
    _write_app(root, "factory", "xvanov/software-factory")
    code, obj = _cli(
        "submit", "--json", "--app", "factory", "--title", "t", "--ask", "a", "--pipeline", "solo"
    )
    assert code != 0 and obj["error"] == "pipeline_unavailable"
    assert "solo_allowed" in obj["message"]
    _write_app(root, "factory", "xvanov/software-factory", "solo_allowed: true\n")
    assert _submit("--pipeline", "solo", app="factory")["pipeline"] == "solo"


def test_finding9_pipeline_and_models_land_in_frontmatter_for_routing(root: Path) -> None:
    """The keys #332's ``job_routing.resolve_for_direction`` reads: ``pipeline``
    (as requested) and ``models`` (persona → model id, the JOB's own)."""
    from factory.app_config import load_app_config
    from factory.job_routing import resolve_for_direction

    obj = _submit("--pipeline", "chain", "--model", "dev.hard=azure/some-dev-model")
    d = Path(obj["direction_path"])
    direction = parse_direction_dir("demo", d)
    assert direction.raw_frontmatter["pipeline"] == "chain"
    assert direction.raw_frontmatter["models"] == {"dev.hard": "azure/some-dev-model"}
    routing = resolve_for_direction(direction, load_app_config("demo", root))
    assert routing.pipeline == "chain"
    assert routing.model_overrides["dev.hard"] == "azure/some-dev-model"


def test_submit_warns_when_backpressure_will_park_it(root: Path, tmp_path: Path) -> None:
    obj = _submit()
    assert any("needs-direction" in w for w in obj["warnings"])
    flow = tmp_path / "flow.md"
    flow.write_text("1. User opens settings\n2. User clicks the dark mode toggle\n")
    ok = _submit("--flow-file", str(flow))
    assert not any("needs-direction" in w for w in ok["warnings"])
    assert (Path(ok["direction_path"]) / "flow.md").exists()


def test_ask_headings_do_not_break_direction_sections(root: Path) -> None:
    code, obj = _cli(
        "submit",
        "--json",
        "--app",
        "demo",
        "--title",
        "t",
        "--ask",
        "# Context\nsome\n\n## Acceptance Criteria\n- fake",
        "--done",
        "real one",
    )
    assert code == 0
    d = parse_direction_dir("demo", Path(obj["direction_path"]))
    assert d.acceptance == ["real one"]
    assert d.why and "**Context**" in d.why


# --------------------------------------------------------------------------- #
# status
# --------------------------------------------------------------------------- #


def test_status_queued_then_needs_direction_then_triaging(root: Path) -> None:
    job = _submit()
    st = job_status(root, job["job_id"])
    assert st["state"] == "queued" and not st["terminal"]
    assert st["stories"] == [] and st["cost_usd"] == 0.0

    d = Path(job["direction_path"])
    state = yaml.safe_load((d / "state.yaml").read_text())
    state.update(status="needs-direction", missing=["user_flow"])
    (d / "state.yaml").write_text(yaml.safe_dump(state))
    # The directions row is authoritative over state.yaml — move it too.
    from factory.directions.watcher import mark_direction_status

    mark_direction_status(parse_direction_dir("demo", d), "needs-direction", by="test")
    st = job_status(root, job["job_id"])
    assert st["state"] == "needs_human" and "needs-direction" in st["why"]

    mark_direction_status(parse_direction_dir("demo", d), "pm-validated", by="test")
    assert job_status(root, job["job_id"])["state"] == "triaging"


@pytest.mark.parametrize(
    ("state", "expected"),
    [
        (StoryState.DEV_IN_PROGRESS.value, "in_progress"),
        (StoryState.BLOCKED_REVIEW_NONCONVERGENT.value, "needs_human"),
        (StoryState.BLOCKED_BUDGET_EXCEEDED.value, "needs_human"),
        (StoryState.BLOCKED_CI_UNRESOLVED.value, "failed"),
        (StoryState.QUARANTINED_INVALID_STATE.value, "failed"),
    ],
)
def test_status_story_state_mapping(root: Path, state: str, expected: str) -> None:
    job = _submit()
    _story(root, "001", state, last_rejection_reason="why it stopped")
    st = job_status(root, job["job_id"])
    assert st["state"] == expected
    assert st["terminal"] is (expected == "failed")
    assert st["stories"][0]["state"] == state


def test_dependency_cap_park_is_needs_human_deadlock_is_failed(root: Path) -> None:
    job = _submit()
    s = _story(
        root,
        "001",
        StoryState.BLOCKED_DEPENDENCY_UNMET.value,
        last_rejection_reason="dependency_deferral_cap_exhausted: waiting",
    )
    assert job_status(root, job["job_id"])["state"] == "needs_human"
    s.last_rejection_reason = "deadlock"
    persist_story(s, root / "state" / "factory.db")
    assert job_status(root, job["job_id"])["state"] == "failed"


def test_auto_merge_done_only_when_github_says_merged(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = _submit(app="legacy")  # auto_merge
    _story(root, "001", StoryState.PR_OPEN.value, app="legacy", github_pr_number=7)
    url = "https://github.com/acme/legacy/pull/7"
    fake = _fake_gh([{"number": 7, "state": "OPEN", "url": url, "headRefName": "b"}])
    monkeypatch.setattr(gh_mod, "_run_gh", fake)
    st = job_status(root, job["job_id"])
    assert st["state"] == "in_progress" and st["merged"] is False
    assert st["stories"][0]["pr_state"] == "open" and st["pr_urls"] == [url]

    merged = _fake_gh([{"number": 7, "state": "MERGED", "url": url, "headRefName": "b"}])
    monkeypatch.setattr(gh_mod, "_run_gh", merged)
    st = job_status(root, job["job_id"])
    assert st["state"] == "done" and st["terminal"] and st["merged"] is True
    # one gh call per repo, not per story
    assert len(merged.calls) == 1


def test_local_merged_flag_is_not_trusted_when_github_disagrees(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = _submit(app="legacy")
    _story(root, "001", StoryState.DEPLOY_PENDING.value, app="legacy", github_pr_number=7)
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh([{"number": 7, "state": "CLOSED", "url": "u", "headRefName": "b"}]),
    )
    st = job_status(root, job["job_id"])
    assert st["state"] != "done" and st["merged"] is False


def test_pr_delivery_is_done_when_pr_is_open(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    job = _submit("--delivery", "pr")
    _story(root, "001", StoryState.DELIVERED_PR.value, github_pr_number=3, delivery_level="pr")
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh([{"number": 3, "state": "OPEN", "url": "u3", "headRefName": "b"}]),
    )
    st = job_status(root, job["job_id"])
    assert st["state"] == "done" and st["merged"] is False


def test_github_failure_degrades_to_local_view_with_why(root: Path) -> None:
    job = _submit(app="legacy")
    _story(root, "001", StoryState.DEPLOYED.value, app="legacy", github_pr_number=9)
    st = job_status(root, job["job_id"])  # gh down (fixture default)
    # Local flags say merged; a terminal "done" needs GitHub's word for it.
    assert st["state"] == "in_progress" and not st["terminal"]
    assert "could not confirm" in st["why"]
    assert st["stories"][0]["pr_state"] is None
    assert st["stories"][0]["pr_url"] == "https://github.com/acme/legacy/pull/9"
    assert "GitHub unavailable" in st["why"]


def test_superseded_sibling_is_ignored(root: Path) -> None:
    job = _submit("--delivery", "none")
    _story(root, "001", StoryState.SUPERSEDED_BY_SIBLING.value)
    _story(root, "001", StoryState.DELIVERED_LOCAL.value, slug="winner", delivery_level="none")
    assert job_status(root, job["job_id"])["state"] == "done"


def test_paused_factory_reports_blocked(root: Path) -> None:
    from factory.settings.modes import FactoryState

    job = _submit()
    _story(root, "001", StoryState.SM_DONE.value)
    eng = create_engine(f"sqlite:///{root / 'state' / 'factory.db'}")
    SQLModel.metadata.create_all(eng, tables=[FactoryState.__table__])  # type: ignore[attr-defined]
    with Session(eng) as s:
        s.add(FactoryState(id=1, mode="paused"))
        s.commit()
    st = job_status(root, job["job_id"])
    assert st["state"] == "blocked" and "paused" in st["why"]


def test_cost_sums_runs_for_the_job(root: Path) -> None:
    from factory.runner import Run
    from factory.runner import _engine as runs_engine

    job = _submit()
    story = _story(root, "001", StoryState.DEV_IN_PROGRESS.value)
    eng = runs_engine(root / "state" / "factory.db")
    with Session(eng) as s:
        s.add(
            Run(
                ts="t",
                persona="pm",
                model="m",
                mode="text",
                cost_usd=0.5,
                app="demo",
                direction_id="001",
            )
        )
        s.add(
            Run(ts="t", persona="dev", model="m", mode="sandbox", cost_usd=1.25, story_id=story.id)
        )
        s.add(
            Run(
                ts="t",
                persona="dev",
                model="m",
                mode="sandbox",
                cost_usd=9.0,
                app="demo",
                direction_id="999",
            )
        )
        s.commit()
    assert job_status(root, job["job_id"])["cost_usd"] == 1.75


def test_status_unknown_job_is_json_error(root: Path) -> None:
    code, obj = _cli("status", "demo:404", "--json")
    assert code == 1 and obj["error"] == "not_found"
    code, obj = _cli("status", "garbage", "--json")
    assert code == 1 and obj["error"] == "invalid_job_id"


def test_finding1_human_states_derive_from_the_orchestrator_minus_delivered() -> None:
    from factory.chain.orchestrator import _PENDING_HUMAN_STATES
    from factory.chain.state_machine import DELIVERED_UNMERGED_STATES

    assert status_mod.HUMAN_STATES == _PENDING_HUMAN_STATES - DELIVERED_UNMERGED_STATES
    assert not (status_mod.HUMAN_STATES & DELIVERED_UNMERGED_STATES)


# --------------------------------------------------------------------------- #
# list
# --------------------------------------------------------------------------- #


def test_list_filters_by_source_active_and_app(root: Path) -> None:
    _submit("--external-id", "a")  # demo:001 — will be terminal
    _submit("--external-id", "b", "--source", "cli")  # demo:002
    _submit("--external-id", "c", app="legacy")  # legacy:001
    # Terminal without needing GitHub: both end in a failure sink.
    _story(root, "001", StoryState.BLOCKED_CI_UNRESOLVED.value)
    _story(root, "001", StoryState.BLOCKED_CI_UNRESOLVED.value, app="legacy")
    # A classic (non-job) direction is not a job.
    from factory.directions.creator import create_direction

    create_direction(
        "demo",
        title="classic",
        type_tag=None,
        why="w",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[],
        explore=False,
        attach_files=None,
        software_factory_root=root,
    )

    code, obj = _cli("list", "--json", "--no-github")
    assert code == 0
    assert [j["job_id"] for j in obj["jobs"]] == ["demo:001", "demo:002", "legacy:001"]
    pa = list_jobs(root, source="pa", github=False)["jobs"]
    assert [j["job_id"] for j in pa] == ["demo:001", "legacy:001"]
    active = list_jobs(root, active=True, github=False)["jobs"]
    assert [j["job_id"] for j in active] == ["demo:002"]
    only_legacy = list_jobs(root, app="legacy", github=False)["jobs"]
    assert [j["job_id"] for j in only_legacy] == ["legacy:001"]


# --------------------------------------------------------------------------- #
# cancel
# --------------------------------------------------------------------------- #


def test_cancel_parks_live_stories_and_keeps_evidence(root: Path) -> None:
    from factory.chain.handlers import get_story

    job = _submit()
    live = _story(root, "001", StoryState.DEV_IN_PROGRESS.value, github_branch="story/1-x")
    done = _story(root, "001", StoryState.BLOCKED_CI_UNRESOLVED.value, slug="other")
    code, obj = _cli("cancel", job["job_id"], "--json")
    assert code == 0
    assert obj["job_id"] == job["job_id"] and obj["state"] == "cancelled"
    # A stuck sink (blocked_ci_unresolved) is parked too (review MUST 2).
    assert sorted(obj["stories_parked"]) == sorted([live.id, done.id])

    db = root / "state" / "factory.db"
    parked = get_story(live.id, db)
    assert parked.state == StoryState.CLOSED_BY_OPERATOR.value
    assert parked.github_branch == "story/1-x"  # evidence kept
    assert get_story(done.id, db).state == StoryState.CLOSED_BY_OPERATOR.value
    assert Path(job["direction_path"]).is_dir()

    st = job_status(root, job["job_id"])
    assert st["state"] == "cancelled" and st["terminal"]
    # Closed direction: pm-sync will not triage it again.
    from factory.directions.watcher import pending_directions

    assert pending_directions("demo", root, db) == []
    # Idempotent.
    code, obj = _cli("cancel", job["job_id"], "--json")
    assert code == 0 and obj["stories_parked"] == []


def test_n2_cancel_survives_a_stale_handler_writeback(root: Path) -> None:
    job = _submit()
    s = _story(root, "001", StoryState.DEV_IN_PROGRESS.value)
    cancel_job(root, job["job_id"])
    # An in-flight handler persists its stale in-memory row afterwards.
    s.state = StoryState.TESTS_GREEN.value
    persist_story(s, root / "state" / "factory.db")
    # N2: the stale write-back is refused; the cancel holds.
    from factory.chain.handlers import get_story

    assert (
        get_story(s.id, root / "state" / "factory.db").state == StoryState.CLOSED_BY_OPERATOR.value
    )
    assert job_status(root, job["job_id"])["state"] == "cancelled"


# --------------------------------------------------------------------------- #
# follow
# --------------------------------------------------------------------------- #


def test_follow_streams_events_and_exits_when_terminal(root: Path) -> None:
    from factory.chain.event_log import log_story_event

    job = _submit("--delivery", "none")
    s = _story(root, "001", StoryState.DEV_IN_PROGRESS.value, slug="slug-x")
    log_story_event(
        s.id, "handler_start", {"handler": "dev"}, software_factory_root=root, slug_hint="slug-x"
    )
    lines: list[str] = []
    ticks = {"n": 0}

    def fake_sleep(_: float) -> None:
        ticks["n"] += 1
        if ticks["n"] == 1:
            log_story_event(
                s.id,
                "handler_end",
                {"handler": "dev", "to_state": "delivered_local"},
                software_factory_root=root,
                slug_hint="slug-x",
            )
            s.state = StoryState.DELIVERED_LOCAL.value
            persist_story(s, root / "state" / "factory.db")

    final = follow_job(
        root, job["job_id"], emit=lines.append, sleep=fake_sleep, max_polls=5, github=False
    )
    text = "\n".join(lines)
    assert final["state"] == "done"
    assert "handler_start handler=dev" in text
    assert "handler_end handler=dev to_state=delivered_local" in text
    assert f"story {s.id} state dev_in_progress -> delivered_local" in text
    assert "job in_progress -> done" in text
    assert lines[-1].split(" ", 1)[1].startswith("job finished: done")
    assert ticks["n"] == 1


def test_dependency_deferred_story_reports_blocked(root: Path) -> None:
    job = _submit()
    _story(root, "001", StoryState.STORY_CREATED.value, dependency_defer_count=2)
    st = job_status(root, job["job_id"])
    assert st["state"] == "blocked" and "dependency" in st["why"]
    # A stale counter on a story that has moved on is not a block.
    _story(root, "001", StoryState.DEV_IN_PROGRESS.value, dependency_defer_count=3, slug="b")
    assert job_status(root, job["job_id"])["state"] == "in_progress"


# --------------------------------------------------------------------------- #
# adversarial review 2026-11-02 — status reads the stamped level; push_to_main
# is confirmed on GitHub; cancel leaves finished work alone and disarms
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("state", "level"),
    [
        (StoryState.DELIVERED_LOCAL.value, "none"),
        (StoryState.DELIVERED_BRANCH.value, "branch"),
        (StoryState.DELIVERED_PR.value, "draft_pr"),
        (StoryState.DELIVERED_PR.value, "pr"),
    ],
)
def test_finding1_delivered_states_are_success_at_the_stamped_level(
    root: Path, monkeypatch: pytest.MonkeyPatch, state: str, level: str
) -> None:
    """The job runs on the LEGACY app (config default auto_merge). The story's
    stamped level is what counts — status never recomputes it from config."""
    job = _submit("--delivery", level, app="legacy")
    _story(
        root,
        "001",
        state,
        app="legacy",
        delivery_level=level,
        github_branch="story/1-x",
        github_pr_number=5 if state == StoryState.DELIVERED_PR.value else None,
    )
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh(
            [{"number": 5, "state": "OPEN", "url": "u5", "headRefName": "story/1-x"}],
            branches={"story/1-x"},
        ),
    )
    st = job_status(root, job["job_id"])
    assert st["state"] == "done", st["why"]
    assert st["stories"][0]["delivery_level"] == level


def test_finding1_delivered_pr_closed_unmerged_is_not_done(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = _submit("--delivery", "pr")
    _story(root, "001", StoryState.DELIVERED_PR.value, github_pr_number=6, delivery_level="pr")
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh([{"number": 6, "state": "CLOSED", "url": "u", "headRefName": "b"}]),
    )
    st = job_status(root, job["job_id"])
    assert st["state"] == "failed" and "closed without merging" in st["why"]


def test_finding1_delivered_without_github_is_unverified_not_done(root: Path) -> None:
    job = _submit("--delivery", "pr")
    _story(root, "001", StoryState.DELIVERED_PR.value, github_pr_number=6, delivery_level="pr")
    st = job_status(root, job["job_id"])  # gh down
    assert st["state"] == "in_progress" and "could not confirm" in st["why"]


def _p2m_story(root: Path, sha: str) -> StoryRecord:
    from factory.chain.auto_merge import MergeActionRecord

    s = _story(
        root, "001", StoryState.DEPLOY_PENDING.value, app="legacy", delivery_level="push_to_main"
    )
    eng = create_engine(f"sqlite:///{root / 'state' / 'factory.db'}")
    SQLModel.metadata.create_all(eng)
    with Session(eng) as ses:
        ses.add(
            MergeActionRecord(
                app="legacy",
                pr_number=-(s.id or 0),
                head_sha=sha,
                merged=True,
                reason="push_to_main: fast-forwarded",
                gates_passed_json="[]",
                blocking_labels_json="[]",
            )
        )
        ses.commit()
    return s


def _compare_gh(status: str | None) -> Any:
    calls: list[list[str]] = []

    def run(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args[:2] == ["pr", "list"]:
            return subprocess.CompletedProcess(args, 0, "[]", "")
        if args[0] == "api" and "/compare/" in args[1]:
            if status is None:
                return subprocess.CompletedProcess(args, 1, "", "HTTP 502")
            return subprocess.CompletedProcess(args, 0, status + "\n", "")
        raise AssertionError(args)

    run.calls = calls  # type: ignore[attr-defined]
    return run


@pytest.mark.parametrize(
    ("compare", "expected"),
    [("behind", "done"), ("identical", "done"), ("ahead", "failed"), (None, "in_progress")],
)
def test_finding5_push_to_main_done_only_when_github_main_contains_the_commit(
    root: Path, monkeypatch: pytest.MonkeyPatch, compare: str | None, expected: str
) -> None:
    job = _submit("--delivery", "push_to_main", app="legacy")
    _p2m_story(root, "ab" * 20)
    fake = _compare_gh(compare)
    monkeypatch.setattr(gh_mod, "_run_gh", fake)
    st = job_status(root, job["job_id"])
    assert st["state"] == expected, st["why"]
    assert any(c[0] == "api" and c[1].endswith(f"/compare/main...{'ab' * 20}") for c in fake.calls)


def test_finding5_push_to_main_local_flag_alone_is_never_done(root: Path) -> None:
    job = _submit("--delivery", "push_to_main", app="legacy")
    _story(root, "001", StoryState.DEPLOYED.value, app="legacy", delivery_level="push_to_main")
    st = job_status(root, job["job_id"], github=False)
    assert st["state"] == "in_progress" and not st["terminal"]


@pytest.fixture
def disarm_calls(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    from factory.chain import delivery_gate

    calls: list[int] = []

    def _disarm(_cfg: Any, pr: int | None, **_k: Any) -> str | None:
        calls.append(int(pr or 0))
        return None

    monkeypatch.setattr(delivery_gate, "disable_auto_merge", _disarm)
    return calls


def test_finding6_cancel_leaves_finished_work_alone(
    root: Path, monkeypatch: pytest.MonkeyPatch, disarm_calls: list[int]
) -> None:
    from factory.chain.handlers import get_story

    job = _submit()
    db = root / "state" / "factory.db"
    deploying = _story(root, "001", StoryState.DEPLOY_PENDING.value, slug="a", github_pr_number=11)
    delivered = _story(root, "001", StoryState.DELIVERED_PR.value, slug="b", github_pr_number=12)
    merged_on_gh = _story(root, "001", StoryState.PR_OPEN.value, slug="c", github_pr_number=13)
    live_open = _story(root, "001", StoryState.PR_OPEN.value, slug="d", github_pr_number=14)
    no_pr = _story(root, "001", StoryState.DEV_IN_PROGRESS.value, slug="e")
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh(
            [
                {"number": 13, "state": "MERGED", "url": "u", "headRefName": "c"},
                {"number": 14, "state": "OPEN", "url": "u", "headRefName": "d"},
            ]
        ),
    )
    out = cancel_job(root, job["job_id"])
    assert sorted(out["stories_parked"]) == sorted([live_open.id, no_pr.id])
    left = {x["id"]: x["reason"] for x in out["stories_left"]}
    assert set(left) == {deploying.id, merged_on_gh.id}
    assert get_story(deploying.id, db).state == StoryState.DEPLOY_PENDING.value
    assert get_story(delivered.id, db).state == StoryState.DELIVERED_PR.value
    assert get_story(merged_on_gh.id, db).state == StoryState.PR_OPEN.value
    assert get_story(live_open.id, db).state == StoryState.CLOSED_BY_OPERATOR.value
    # finding 2 (cancel): the open PR's auto-merge was disarmed before parking.
    assert disarm_calls == [14]


def test_finding6_cancel_does_not_park_a_pr_story_when_github_is_down(
    root: Path, disarm_calls: list[int]
) -> None:
    from factory.chain.handlers import get_story

    job = _submit()
    s = _story(root, "001", StoryState.PR_OPEN.value, github_pr_number=21)
    out = cancel_job(root, job["job_id"])  # gh down (fixture default)
    assert out["stories_parked"] == []
    assert "cannot confirm" in out["stories_left"][0]["reason"]
    assert get_story(s.id, root / "state" / "factory.db").state == StoryState.PR_OPEN.value
    assert disarm_calls == []


def test_finding2_cancel_refuses_to_park_when_disarm_fails(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain import delivery_gate
    from factory.chain.handlers import get_story

    monkeypatch.setattr(delivery_gate, "disable_auto_merge", lambda *a, **k: "gh exit=1: nope")
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh([{"number": 22, "state": "OPEN", "url": "u", "headRefName": "b"}]),
    )
    job = _submit()
    s = _story(root, "001", StoryState.PR_OPEN.value, github_pr_number=22)
    out = cancel_job(root, job["job_id"])
    assert out["stories_parked"] == []
    assert "could not disarm" in out["stories_left"][0]["reason"]
    assert get_story(s.id, root / "state" / "factory.db").state == StoryState.PR_OPEN.value


def test_push_to_main_fallback_pr_merged_is_done_with_a_delivery_note(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Protected base: the chain fell back to an auto_merge PR. The merged PR is
    success for the push_to_main job, and status says why it went via a PR."""
    from factory.chain.event_log import log_story_event

    job = _submit("--delivery", "push_to_main", app="legacy")
    s = _story(
        root,
        "001",
        StoryState.DEPLOYED.value,
        app="legacy",
        slug="p2m",
        delivery_level="auto_merge",
        github_pr_number=31,
    )
    log_story_event(
        s.id,
        "push_to_main_fell_back_to_pr",
        {"reason": "push_to_main_fell_back_to_pr:main requires status checks ['ci']"},
        software_factory_root=root,
        slug_hint="p2m",
    )
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh([{"number": 31, "state": "MERGED", "url": "u", "headRefName": "b"}]),
    )
    st = job_status(root, job["job_id"])
    assert st["state"] == "done" and st["merged"] is True
    assert st["delivery"] == "push_to_main"
    story = st["stories"][0]
    assert story["delivery_level"] == "auto_merge"
    assert story["delivery_note"].startswith("push_to_main_fell_back_to_pr:")
    # The fallback PR still open: not done yet.
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh([{"number": 31, "state": "OPEN", "url": "u", "headRefName": "b"}]),
    )
    assert job_status(root, job["job_id"])["state"] != "done"


# --------------------------------------------------------------------------- #
# review 2 (2026-11-02)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "state",
    [
        StoryState.BLOCKED_CI_UNRESOLVED,
        StoryState.BLOCKED_DEPLOY_FAILED,
        StoryState.BLOCKED_REVIEW_NONCONVERGENT,
        StoryState.CI_PENDING,
    ],
)
def test_must2_cancel_disarms_and_parks_stuck_sinks_with_an_open_pr(
    root: Path, monkeypatch: pytest.MonkeyPatch, disarm_calls: list[int], state: StoryState
) -> None:
    from factory.chain.handlers import get_story

    job = _submit("--delivery", "auto_merge")
    s = _story(root, "001", state.value, github_pr_number=31, delivery_level="auto_merge")
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh([{"number": 31, "state": "OPEN", "url": "u", "headRefName": "b"}]),
    )
    out = cancel_job(root, job["job_id"])
    assert disarm_calls == [31] and out["stories_parked"] == [s.id]
    assert (
        get_story(s.id, root / "state" / "factory.db").state == StoryState.CLOSED_BY_OPERATOR.value
    )
    assert job_status(root, job["job_id"])["state"] == "cancelled"


def test_must2_ci_pending_is_in_flight_not_failed(root: Path) -> None:
    job = _submit("--delivery", "auto_merge")
    _story(root, "001", StoryState.CI_PENDING.value, delivery_level="auto_merge")
    assert job_status(root, job["job_id"], github=False)["state"] == "in_progress"


def test_must3_cancel_on_a_done_job_is_a_noop(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from factory.chain.handlers import get_story

    job = _submit("--delivery", "pr")
    s = _story(root, "001", StoryState.DELIVERED_PR.value, github_pr_number=5, delivery_level="pr")
    monkeypatch.setattr(
        gh_mod,
        "_run_gh",
        _fake_gh([{"number": 5, "state": "OPEN", "url": "u", "headRefName": "b"}]),
    )
    assert job_status(root, job["job_id"])["state"] == "done"
    out = cancel_job(root, job["job_id"])
    assert out["state"] == "done" and out["stories_parked"] == []
    assert job_status(root, job["job_id"])["state"] == "done"
    assert get_story(s.id, root / "state" / "factory.db").state == StoryState.DELIVERED_PR.value
    d = Path(job["direction_path"])
    assert "job_cancelled" not in (yaml.safe_load((d / "state.yaml").read_text()) or {})


def test_must3_late_cancel_marker_does_not_flip_done(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Even if a cancel marker lands (race), a fully delivered job reads done."""
    from factory.directions.watcher import merge_state

    job = _submit("--delivery", "none")
    _story(root, "001", StoryState.DELIVERED_LOCAL.value, delivery_level="none")
    merge_state(
        parse_direction_dir("demo", Path(job["direction_path"])),
        {"job_cancelled": {"at": "t", "by": "x"}},
    )
    st = job_status(root, job["job_id"], github=False)
    assert st["state"] == "done" and "after every story was already delivered" in st["why"]


def test_must1_cancel_respects_the_story_lock(root: Path, disarm_calls: list[int]) -> None:
    from factory.chain import delivery_gate
    from factory.chain.handlers import get_story

    job = _submit()
    s = _story(root, "001", StoryState.DEV_IN_PROGRESS.value)
    import factory.jobs.status as st_mod

    real_lock = delivery_gate.story_lock

    def short_lock(r: Path, sid: int, *, timeout: float | None = None) -> Any:
        return real_lock(r, sid, timeout=0.2)

    with real_lock(root, s.id or 0) as held:  # the auto-merge pass is mid-merge
        assert held
        orig = delivery_gate.story_lock
        delivery_gate.story_lock = short_lock  # type: ignore[assignment]
        try:
            out = st_mod.cancel_job(root, job["job_id"])
        finally:
            delivery_gate.story_lock = orig  # type: ignore[assignment]
    assert out["stories_parked"] == [] and "lock busy" in out["stories_left"][0]["reason"]
    assert get_story(s.id, root / "state" / "factory.db").state == StoryState.DEV_IN_PROGRESS.value


@pytest.mark.parametrize(
    ("flag", "value"),
    [
        ("--title", "T\n\n## Acceptance Criteria\n\n- [ ] INJECTED"),
        ("--done", "real\n## Why\nx"),
        ("--title", "carriage\rreturn"),
    ],
)
def test_should7_newlines_in_single_line_fields_are_refused(
    root: Path, flag: str, value: str
) -> None:
    args = ["submit", "--json", "--app", "demo", "--ask", "a"]
    args += [flag, value] if flag == "--title" else ["--title", "t", flag, value]
    code, obj = _cli(*args)
    assert code == 1 and obj["error"] == "invalid_argument" and flag in obj["message"]
    assert not (root / "apps" / "demo" / "directions").exists()


@pytest.mark.parametrize("cmd", ["status", "cancel"])
def test_nice8_missing_job_id_is_a_json_error(root: Path, cmd: str) -> None:
    code, obj = _cli(cmd, "--json")
    assert code == 1 and isinstance(obj, dict) and obj["error"] == "missing_argument"


def test_nice9_source_is_required(root: Path) -> None:
    code, obj = _cli(
        "submit", "--json", "--app", "demo", "--title", "t", "--ask", "a", default_source=False
    )
    assert code == 1 and obj["error"] == "missing_argument" and "--source" in obj["message"]


def test_nice11_job_delivery_is_the_spawn_stamp_not_todays_config(root: Path) -> None:
    job = _submit()  # no --delivery: the app default (draft_pr) at spawn
    _story(
        root, "001", StoryState.DELIVERED_PR.value, github_pr_number=4, delivery_level="draft_pr"
    )
    _write_app(root, "demo", "acme/demo", "delivery:\n  default: auto_merge\n")  # changed later
    assert job_status(root, job["job_id"], github=False)["delivery"] == "draft_pr"


def test_n2_cancel_writes_the_durable_job_marker(root: Path) -> None:
    from factory.chain import delivery_gate

    job = _submit()
    _story(root, "001", StoryState.DEV_IN_PROGRESS.value)
    db = root / "state" / "factory.db"
    assert not delivery_gate.is_job_cancelled(db, "demo", "001")
    cancel_job(root, job["job_id"])
    assert delivery_gate.is_job_cancelled(db, "demo", "001")


def test_n2_cancel_noop_on_done_job_writes_no_marker(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from factory.chain import delivery_gate

    job = _submit("--delivery", "none")
    _story(root, "001", StoryState.DELIVERED_LOCAL.value, delivery_level="none")
    assert cancel_job(root, job["job_id"], github=False)["state"] == "done"
    assert not delivery_gate.is_job_cancelled(root / "state" / "factory.db", "demo", "001")


# --------------------------------------------------------------------------- #
# CI of delivered PRs (E2E template-probe:005, 2026-11-02)
# --------------------------------------------------------------------------- #


def _gh_with_ci(rollup: list[dict[str, Any]]) -> Any:
    base = _fake_gh([{"number": 5, "state": "OPEN", "url": "u5", "headRefName": "b"}])

    def run(args: list[str]) -> subprocess.CompletedProcess[str]:
        if args[:2] == ["pr", "view"] and "statusCheckRollup" in args:
            return subprocess.CompletedProcess(
                args, 0, json.dumps({"statusCheckRollup": rollup}), ""
            )
        return base(args)

    return run


_RUN = {"__typename": "CheckRun", "name": "lint"}


@pytest.mark.parametrize(
    ("rollup", "age_s", "state", "why_has"),
    [
        ([{**_RUN, "status": "COMPLETED", "conclusion": "SUCCESS"}], 0, "done", None),
        ([{**_RUN, "status": "COMPLETED", "conclusion": "FAILURE"}], 0, "done", "CI failing: lint"),
        (
            [{**_RUN, "status": "IN_PROGRESS", "conclusion": ""}],
            60,
            "in_progress",
            "waiting for its CI",
        ),
        ([{**_RUN, "status": "IN_PROGRESS", "conclusion": ""}], 3 * 3600, "done", None),
    ],
)
def test_delivered_pr_reports_ci(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
    rollup: list[dict[str, Any]],
    age_s: int,
    state: str,
    why_has: str | None,
) -> None:
    from datetime import UTC, datetime, timedelta

    job = _submit("--delivery", "draft_pr")
    s = _story(
        root, "001", StoryState.DELIVERED_PR.value, github_pr_number=5, delivery_level="draft_pr"
    )
    eng = create_engine(f"sqlite:///{root / 'state' / 'factory.db'}")
    with Session(eng) as ses:
        row = ses.get(StoryRecord, s.id)
        assert row is not None
        row.updated_at = datetime.now(UTC) - timedelta(seconds=age_s)
        ses.add(row)
        ses.commit()
    monkeypatch.setattr(gh_mod, "_run_gh", _gh_with_ci(rollup))
    st = job_status(root, job["job_id"])
    assert st["state"] == state, st["why"]
    assert st["stories"][0]["ci"]["state"] in ("passing", "failing", "pending")
    if why_has:
        assert why_has in (st["why"] or "")
    assert "GitHub unavailable" not in (st["why"] or "")
