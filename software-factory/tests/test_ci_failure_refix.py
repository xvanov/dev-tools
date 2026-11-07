"""CI-failure -> dev re-fix loop (``auto_merge._handle_ci_failure``).

Closes the gap the operator called out: real CI (``_query_ci_state``)
already gates merges on ``"failure"``, but a failing PR just sat there —
nothing fed the failure back to dev. ``_handle_ci_failure`` re-dispatches the
story to dev with the CI failure surfaced through the EXISTING
reviewer-findings plumbing, bounded by a hard cap plus a failure-signature
guard (mirroring ``orchestrator._recover_blocked_stories``) so a CI failure
the dev cannot fix escalates instead of looping forever.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from factory.app_config import AppConfig
from factory.chain import auto_merge as am
from factory.chain.event_log import log_story_event, read_story_events
from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState


def _seed(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return db


def _pr_open_story(db: Path, *, slug: str = "s") -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id="042",
            app="sacrifice",
            title="t",
            slug=slug,
            scope="backend",
            state=StoryState.PR_OPEN.value,
            github_pr_number=77,
        ),
        db,
    )


def _cfg() -> AppConfig:
    return AppConfig(name="sacrifice", repo="o/sacrifice", default_branch="main")


# --------------------------------------------------------------------------- #
# _fetch_ci_failure_logs — best-effort gh parsing, mocked subprocess
# --------------------------------------------------------------------------- #


def test_fetch_ci_failure_logs_returns_digest_via_details_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    calls: list[list[str]] = []

    def _fake_run(cmd, **kw):
        calls.append(cmd)
        if cmd[:3] == ["gh", "pr", "view"]:
            payload = {
                "headRefName": "story-77-fix",
                "statusCheckRollup": [
                    {
                        "conclusion": "SUCCESS",
                        "detailsUrl": "https://github.com/o/sacrifice/actions/runs/111/job/1",
                    },
                    {
                        "conclusion": "FAILURE",
                        "detailsUrl": "https://github.com/o/sacrifice/actions/runs/222/job/2",
                    },
                ],
            }
            return subprocess.CompletedProcess(cmd, 0, json.dumps(payload), "")
        if cmd[:3] == ["gh", "run", "view"]:
            assert cmd[3] == "222"
            return subprocess.CompletedProcess(
                cmd, 0, "FAIL tests/test_x.py::test_y\nAssertionError: boom", ""
            )
        raise AssertionError(f"unexpected gh invocation: {cmd}")

    monkeypatch.setattr(subprocess, "run", _fake_run, raising=True)
    digest = am._fetch_ci_failure_logs(app_config=_cfg(), pr_number=77)
    assert "AssertionError: boom" in digest
    # Picked the FAILURE run's id (222), not the SUCCESS one (111) or a
    # ``gh run list`` fallback.
    assert not any(c[:3] == ["gh", "run", "list"] for c in calls)


def test_fetch_ci_failure_logs_falls_back_to_run_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    def _fake_run(cmd, **kw):
        if cmd[:3] == ["gh", "pr", "view"]:
            payload = {"headRefName": "story-77-fix", "statusCheckRollup": []}
            return subprocess.CompletedProcess(cmd, 0, json.dumps(payload), "")
        if cmd[:3] == ["gh", "run", "list"]:
            runs = [{"databaseId": 333, "conclusion": "failure", "status": "completed"}]
            return subprocess.CompletedProcess(cmd, 0, json.dumps(runs), "")
        if cmd[:3] == ["gh", "run", "view"]:
            assert cmd[3] == "333"
            return subprocess.CompletedProcess(cmd, 0, "job failed: exit 1", "")
        raise AssertionError(f"unexpected gh invocation: {cmd}")

    monkeypatch.setattr(subprocess, "run", _fake_run, raising=True)
    digest = am._fetch_ci_failure_logs(app_config=_cfg(), pr_number=77)
    assert "job failed" in digest


def test_fetch_ci_failure_logs_trims_to_4000_chars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    long_log = "x" * 10_000

    def _fake_run(cmd, **kw):
        if cmd[:3] == ["gh", "pr", "view"]:
            payload = {
                "headRefName": "b",
                "statusCheckRollup": [
                    {"conclusion": "FAILURE", "detailsUrl": "https://x/actions/runs/9/job/1"}
                ],
            }
            return subprocess.CompletedProcess(cmd, 0, json.dumps(payload), "")
        if cmd[:3] == ["gh", "run", "view"]:
            return subprocess.CompletedProcess(cmd, 0, long_log, "")
        raise AssertionError(cmd)

    monkeypatch.setattr(subprocess, "run", _fake_run, raising=True)
    digest = am._fetch_ci_failure_logs(app_config=_cfg(), pr_number=1)
    assert len(digest) == 4000
    assert digest == long_log[-4000:]


def test_fetch_ci_failure_logs_returns_empty_on_placeholder_pr() -> None:
    assert am._fetch_ci_failure_logs(app_config=_cfg(), pr_number=0) == ""
    assert am._fetch_ci_failure_logs(app_config=_cfg(), pr_number=-5) == ""


def test_fetch_ci_failure_logs_returns_empty_on_gh_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    def _raise(cmd, **kw):
        raise FileNotFoundError("gh not found")

    monkeypatch.setattr(subprocess, "run", _raise, raising=True)
    assert am._fetch_ci_failure_logs(app_config=_cfg(), pr_number=7) == ""


def test_fetch_ci_failure_logs_returns_empty_on_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    def _raise(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 30)

    monkeypatch.setattr(subprocess, "run", _raise, raising=True)
    assert am._fetch_ci_failure_logs(app_config=_cfg(), pr_number=7) == ""


def test_fetch_ci_failure_logs_returns_empty_on_no_failed_run_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    def _fake_run(cmd, **kw):
        if cmd[:3] == ["gh", "pr", "view"]:
            payload = {"headRefName": "", "statusCheckRollup": []}
            return subprocess.CompletedProcess(cmd, 0, json.dumps(payload), "")
        raise AssertionError(cmd)

    monkeypatch.setattr(subprocess, "run", _fake_run, raising=True)
    assert am._fetch_ci_failure_logs(app_config=_cfg(), pr_number=7) == ""


# --------------------------------------------------------------------------- #
# _handle_ci_failure — bounded re-dispatch
# --------------------------------------------------------------------------- #


def test_first_ci_failure_redispatches_to_dev(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(
        am, "_fetch_ci_failure_logs", lambda **kw: "FAIL test_x.py: AssertionError boom"
    )

    redispatched = am._handle_ci_failure(
        story=story, app_config=_cfg(), pr_number=77, db=db, root=tmp_path
    )
    assert redispatched == "redispatched"

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert r.dev_retries == 0
    assert r.reviewer_result_json is not None
    payload = json.loads(r.reviewer_result_json)
    assert payload["source"] == "ci_failure"
    assert payload["findings"]
    # The CI-failure finding is a well-formed dict (not a bare string): a string
    # element crashed every consumer's f.get(...) and silently broke this loop.
    finding = payload["findings"][0]
    assert isinstance(finding, dict)
    assert "AssertionError boom" in finding["what"]

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    redispatch_events = [e for e in events if e.get("event") == "ci_fix_redispatch"]
    assert len(redispatch_events) == 1
    assert redispatch_events[0]["pr_number"] == 77
    assert redispatch_events[0]["failure_signature"]


def test_identical_failure_signature_does_not_redispatch_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(
        am, "_fetch_ci_failure_logs", lambda **kw: "FAIL test_x.py: AssertionError boom"
    )

    first = am._handle_ci_failure(
        story=story, app_config=_cfg(), pr_number=77, db=db, root=tmp_path
    )
    assert first == "redispatched"

    # Story comes back around to PR_OPEN (real CI re-ran) with the SAME
    # failure — the dev's fix attempt didn't actually fix it.
    story.state = StoryState.PR_OPEN.value
    persist_story(story, db)

    monkeypatch.setattr(am, "_ci_failure_is_genuine", lambda **kw: True)
    closed: list[tuple[int, str]] = []

    def _confirm_close(pr, repo, **kw):  # returns truthy == confirmed closed
        closed.append((pr, repo))
        return True

    second = am._handle_ci_failure(
        story=story,
        app_config=_cfg(),
        pr_number=77,
        db=db,
        root=tmp_path,
        close_pr_fn=_confirm_close,
    )
    # Exhausted (identical signature) -> PR closed + story parked terminally.
    assert second == "parked"
    assert closed == [(77, _cfg().repo)]

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.BLOCKED_CI_UNRESOLVED.value  # parked, PR closed

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert len([e for e in events if e.get("event") == "ci_fix_redispatch"]) == 1
    exhausted = [e for e in events if e.get("event") == "ci_fix_exhausted"]
    assert len(exhausted) == 1
    assert exhausted[0]["reason"] == "identical_failure_signature"
    assert [e for e in events if e.get("event") == "ci_unresolved_parked"]


def test_different_failure_signature_redispatches_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    logs = {"text": "FAIL test_x.py: AssertionError boom"}
    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: logs["text"])

    first = am._handle_ci_failure(
        story=story, app_config=_cfg(), pr_number=77, db=db, root=tmp_path
    )
    assert first == "redispatched"

    story.state = StoryState.PR_OPEN.value
    persist_story(story, db)
    logs["text"] = "FAIL test_y.py: TypeError unexpected kwarg"

    second = am._handle_ci_failure(
        story=story, app_config=_cfg(), pr_number=77, db=db, root=tmp_path
    )
    assert second == "redispatched"

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    redispatch_events = [e for e in events if e.get("event") == "ci_fix_redispatch"]
    assert len(redispatch_events) == 2
    assert redispatch_events[0]["failure_signature"] != redispatch_events[1]["failure_signature"]
    assert not [e for e in events if e.get("event") == "ci_fix_exhausted"]

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.REVIEWER_REQUESTED_CHANGES.value


def test_cap_reached_does_not_redispatch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: "irrelevant")

    # Simulate _MAX_CI_FIX_CYCLES prior redispatches already logged, each with
    # a DIFFERENT signature so the signature guard itself never trips first —
    # this isolates the cap check.
    for i in range(am._MAX_CI_FIX_CYCLES):
        log_story_event(
            story.id,
            "ci_fix_redispatch",
            {"pr_number": 77, "attempt": i + 1, "failure_signature": f"sig-{i}"},
            software_factory_root=tmp_path,
            slug_hint=story.slug,
        )

    monkeypatch.setattr(am, "_ci_failure_is_genuine", lambda **kw: True)
    closed: list[tuple[int, str]] = []

    def _confirm_close(pr, repo, **kw):
        closed.append((pr, repo))
        return True

    redispatched = am._handle_ci_failure(
        story=story,
        app_config=_cfg(),
        pr_number=77,
        db=db,
        root=tmp_path,
        close_pr_fn=_confirm_close,
    )
    # Cap reached -> PR closed + story parked terminally.
    assert redispatched == "parked"
    assert closed == [(77, _cfg().repo)]

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.BLOCKED_CI_UNRESOLVED.value  # parked, PR closed

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    exhausted = [e for e in events if e.get("event") == "ci_fix_exhausted"]
    assert len(exhausted) == 1
    assert exhausted[0]["reason"] == "cap_reached"
    # No NEW redispatch was recorded beyond the simulated prior ones.
    assert (
        len([e for e in events if e.get("event") == "ci_fix_redispatch"]) == am._MAX_CI_FIX_CYCLES
    )


def test_ci_fix_exhausted_is_deduped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Calling _handle_ci_failure repeatedly past the cap emits exactly one
    ci_fix_exhausted event, not one per call (mirrors auto_recovery_exhausted
    dedup in orchestrator._recover_blocked_stories)."""
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: "irrelevant")
    for i in range(am._MAX_CI_FIX_CYCLES):
        log_story_event(
            story.id,
            "ci_fix_redispatch",
            {"pr_number": 77, "attempt": i + 1, "failure_signature": f"sig-{i}"},
            software_factory_root=tmp_path,
            slug_hint=story.slug,
        )

    # First call parks (cap reached -> PR closed + BLOCKED_CI_UNRESOLVED); the
    # second call sees a non-mergeable state and short-circuits. Either way only
    # ONE ci_fix_exhausted event is emitted.
    monkeypatch.setattr(am, "_ci_failure_is_genuine", lambda **kw: True)
    confirm = lambda pr, repo, **kw: True  # noqa: E731 - confirmed close
    am._handle_ci_failure(
        story=story, app_config=_cfg(), pr_number=77, db=db, root=tmp_path, close_pr_fn=confirm
    )
    am._handle_ci_failure(
        story=story, app_config=_cfg(), pr_number=77, db=db, root=tmp_path, close_pr_fn=confirm
    )

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert len([e for e in events if e.get("event") == "ci_fix_exhausted"]) == 1


def test_does_not_redispatch_story_not_in_mergeable_state(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    story = persist_story(
        StoryRecord(
            direction_id="042",
            app="sacrifice",
            title="t",
            slug="dev",
            scope="backend",
            state=StoryState.DEV_IN_PROGRESS.value,
            github_pr_number=77,
        ),
        db,
    )
    redispatched = am._handle_ci_failure(
        story=story, app_config=_cfg(), pr_number=77, db=db, root=tmp_path
    )
    assert redispatched == "left"
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.DEV_IN_PROGRESS.value  # untouched


def test_parked_state_is_terminal_and_non_mergeable() -> None:
    """The parked sink must stop the hamster-wheel: terminal (no dispatch) and
    absent from _MERGEABLE_STATES (auto-merge never re-evaluates it), so a closed
    PR is not re-processed every tick. It is NOT auto-recoverable."""
    from factory.chain.orchestrator import _AUTO_RECOVERABLE_STATES
    from factory.chain.state_machine import is_terminal

    assert is_terminal(StoryState.BLOCKED_CI_UNRESOLVED)
    assert StoryState.BLOCKED_CI_UNRESOLVED.value not in am._MERGEABLE_STATES
    assert StoryState.BLOCKED_CI_UNRESOLVED.value not in _AUTO_RECOVERABLE_STATES


def test_park_skipped_for_placeholder_pr(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A non-positive (placeholder) PR number must NOT trigger a real PR close,
    but the story is still parked so it stops being driven."""
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: "irrelevant")
    for i in range(am._MAX_CI_FIX_CYCLES):
        log_story_event(
            story.id,
            "ci_fix_redispatch",
            {"pr_number": -1, "attempt": i + 1, "failure_signature": f"s{i}"},
            software_factory_root=tmp_path,
            slug_hint=story.slug,
        )
    closed: list[object] = []
    outcome = am._handle_ci_failure(
        story=story,
        app_config=_cfg(),
        pr_number=-1,
        db=db,
        root=tmp_path,
        close_pr_fn=lambda *a, **k: closed.append(a),
    )
    assert outcome == "parked"
    assert closed == []  # never shell a placeholder PR into `gh pr close`
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.BLOCKED_CI_UNRESOLVED.value


def _seed_cap_reached(db, tmp_path, story, monkeypatch):
    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: "irrelevant")
    for i in range(am._MAX_CI_FIX_CYCLES):
        log_story_event(
            story.id,
            "ci_fix_redispatch",
            {"pr_number": 77, "attempt": i + 1, "failure_signature": f"s{i}"},
            software_factory_root=tmp_path,
            slug_hint=story.slug,
        )


def test_infra_failure_is_not_parked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A red made only of INFRA-transient conclusions (timeout/cancel/error) must
    NOT close the PR — it clears on its own. Story stays mergeable to retry."""
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    _seed_cap_reached(db, tmp_path, story, monkeypatch)
    monkeypatch.setattr(am, "_ci_failure_is_genuine", lambda **kw: False)  # infra-only
    closed: list[object] = []
    outcome = am._handle_ci_failure(
        story=story,
        app_config=_cfg(),
        pr_number=77,
        db=db,
        root=tmp_path,
        close_pr_fn=lambda *a, **k: closed.append(a) or True,
    )
    assert outcome == "left"  # NOT parked
    assert closed == []  # PR never closed
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value  # still mergeable, will retry


def test_unconfirmed_close_is_not_parked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """If the PR close cannot be CONFIRMED (gh blip), the story must NOT be parked
    to a non-reconcilable terminal while its PR is still open (the #95 strand).
    Stays mergeable to retry next tick."""
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    _seed_cap_reached(db, tmp_path, story, monkeypatch)
    monkeypatch.setattr(am, "_ci_failure_is_genuine", lambda **kw: True)
    outcome = am._handle_ci_failure(
        story=story,
        app_config=_cfg(),
        pr_number=77,
        db=db,
        root=tmp_path,
        close_pr_fn=lambda pr, repo, **kw: False,  # close NOT confirmed
    )
    assert outcome == "left"  # NOT parked
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value  # not stranded to terminal


# --------------------------------------------------------------------------- #
# Wiring — auto_merge_tick calls _handle_ci_failure before the merge decision
# --------------------------------------------------------------------------- #


def test_auto_merge_tick_redispatches_on_real_ci_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text("name: sacrifice\nrepo: o/sacrifice\n", encoding="utf-8")
    db = _seed(tmp_path)
    story = _pr_open_story(db)

    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: "FAIL: boom")

    fixture = am.FixturePR(
        pr_number=77,
        head_sha="deadbeef",
        base_branch="main",
        labels=[],
        files_changed=["src/x.py"],
        ci_state="failure",
        story=story,
    )
    actions = am.auto_merge_tick(
        tmp_path,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
    )
    assert len(actions) == 1
    assert actions[0].merged is False
    assert "re-dispatched" in actions[0].reason

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.REVIEWER_REQUESTED_CHANGES.value


def test_auto_merge_tick_dry_run_unaffected_by_ci_failure(tmp_path: Path) -> None:
    """dry-run fixtures with ci_state='failure' must not be re-dispatched —
    the CI-failure loop only fires in real-run."""
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text("name: sacrifice\nrepo: o/sacrifice\n", encoding="utf-8")
    db = _seed(tmp_path)
    story = _pr_open_story(db)

    fixture = am.FixturePR(
        pr_number=77,
        head_sha="deadbeef",
        base_branch="main",
        labels=[],
        files_changed=["src/x.py"],
        ci_state="failure",
        story=story,
    )
    actions = am.auto_merge_tick(
        tmp_path,
        "sacrifice",
        dry_run=True,
        fixture_prs=[fixture],
        db_path=db,
    )
    assert len(actions) == 1
    assert actions[0].merged is False
    assert "re-dispatched" not in actions[0].reason

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value  # untouched in dry-run


def test_auto_merge_tick_placeholder_pr_unaffected_by_ci_failure(tmp_path: Path) -> None:
    """A negative (placeholder) pr_number must never be re-dispatched even if
    ci_state somehow reads 'failure' — no real PR exists to investigate."""
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text("name: sacrifice\nrepo: o/sacrifice\n", encoding="utf-8")
    db = _seed(tmp_path)
    story = persist_story(
        StoryRecord(
            direction_id="042",
            app="sacrifice",
            title="t",
            slug="ph",
            scope="backend",
            state=StoryState.PR_OPEN.value,
        ),
        db,
    )
    fixture = am.FixturePR(
        pr_number=-(story.id or 0),
        head_sha="deadbeef",
        base_branch="main",
        labels=[],
        files_changed=["src/x.py"],
        ci_state="failure",
        story=story,
    )
    actions = am.auto_merge_tick(
        tmp_path,
        "sacrifice",
        dry_run=False,
        fixture_prs=[fixture],
        db_path=db,
    )
    assert len(actions) == 1
    assert "re-dispatched" not in actions[0].reason
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value


# --------------------------------------------------------------------------- #
# E6 STAGE 2 — a red `main-green` HOLDS the queue instead of destroying it.
#
# The naive version of "red main blocks merges" would have made a red main look
# like a per-PR CI failure: tick 1 burns a dev-sandbox run on a finding dev
# cannot act on, tick 2 the signature is identical so the PR is CLOSED and the
# story terminally parked. These pin that a hold writes NOTHING except one
# deduped event and one merge_actions row per hold EPISODE.
# --------------------------------------------------------------------------- #


# Real bodies, captured at import time — the autouse fixture below replaces
# the module attributes, and the two helper-body tests need the originals.
_REAL_MAIN_HEAD_SHA = am._main_head_sha
_REAL_RERUN_FAILED_MAIN_GREEN = am._rerun_failed_main_green


@pytest.fixture(autouse=True)
def _no_real_gh_for_hold_helpers(monkeypatch: pytest.MonkeyPatch):
    """The hold's episode helpers (`_main_head_sha`, `_rerun_failed_main_green`)
    shell out to `gh` against the app's real repo — a unit tick must never hit
    the network. Tests that exercise checklist items (a)/(b) re-patch these
    explicitly with the shapes they need."""
    monkeypatch.setattr(am, "_main_head_sha", lambda **kw: None)
    monkeypatch.setattr(am, "_rerun_failed_main_green", lambda **kw: (False, "patched out"))


def _merge_action_rows(db: Path) -> list[am.MergeActionRecord]:
    from sqlmodel import select as _select

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        return list(ses.exec(_select(am.MergeActionRecord)).all())


def _hold_app(tmp_path: Path) -> None:
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text("name: sacrifice\nrepo: o/sacrifice\n", encoding="utf-8")


def _hold_fixture(story: StoryRecord) -> am.FixturePR:
    return am.FixturePR(
        pr_number=77,
        head_sha="deadbeef",
        base_branch="main",
        labels=[],
        files_changed=["src/x.py"],
        ci_state=am._CI_STATE_HOLD,
        story=story,
    )


def test_hold_check_name_matches_the_workflow_job() -> None:
    """The hold is keyed on a check NAME. That name is produced by the
    `main-green` job in .github/workflows/test.yml (a job with no `name:` reports
    under its job id). If the two ever drift, a red main stops classifying as a
    hold and starts closing PRs — so pin them together.
    """
    import yaml

    wf = yaml.safe_load(
        (Path(__file__).resolve().parents[1] / ".github/workflows/test.yml").read_text(
            encoding="utf-8"
        )
    )
    job = wf["jobs"][am._MAIN_GREEN_CHECK_NAME]
    # A `name:` would override the reported context and break the match.
    assert "name" not in job
    # PR-only: on push it would ask about the very commit under test, and the
    # merge queue needs its own leg before this can be a required check there.
    assert job["if"] == "github.event_name == 'pull_request'"


def _drive_tick_with_gh_checks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    db: Path,
    rows: str,
) -> list[am.MergeAction]:
    """Run a REAL-RUN tick that synthesizes its own fixture from the DB, so the
    tick calls ``_query_ci_state`` itself and the gh check ROWS decide the
    verdict.

    This is what makes the "never reaches ``_handle_ci_failure``" assertion
    non-vacuous. Passing ``fixture_prs=[FixturePR(ci_state="hold")]`` cannot
    test the short-circuit at all: the CI-failure branch is guarded on
    ``ci_state == "failure"``, so a hand-set ``"hold"`` skips it whether or not
    the hold branch exists. Feeding the raw gh rows instead means a narrowed
    short-circuit — or a classification that stopped returning ``"hold"`` —
    lands in ``_handle_ci_failure`` and fails the test.
    """
    import subprocess

    monkeypatch.setattr(am, "_query_pr_head_sha", lambda **kw: "a" * 40)
    monkeypatch.setattr(am, "_query_pr_files_changed", lambda **kw: ["src/x.py"])
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, rows, ""),
    )
    return am.auto_merge_tick(tmp_path, "sacrifice", dry_run=False, db_path=db)


_ONLY_MAIN_GREEN_RED = "main-green\tfail\t1s\thttps://x\npytest (1)\tpass\t1s\thttps://y"
_MAIN_GREEN_AND_PYTEST_RED = "main-green\tfail\t1s\thttps://x\npytest (1)\tfail\t1s\thttps://y"


def test_main_green_hold_touches_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(i) only main-green red -> HOLD: no dev dispatch, no redispatch event,
    no park, no PR close, story state unchanged.

    Driven from the raw gh check rows through the real ``_query_ci_state``, so
    both destroyers are genuinely unreachable rather than merely unreached:
    the CI-failure loop (dispatch/park/close) AND the gate evaluation, whose
    missing-labels path has its own park sink (``_park_gate_block_exhausted``)
    three ticks later.
    """
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)

    def _boom_ci(**kw):  # noqa: ANN003
        raise AssertionError("a hold must never reach _handle_ci_failure")

    def _boom_eval(**kw):  # noqa: ANN003
        raise AssertionError("a hold must never reach _evaluate_one_pr")

    monkeypatch.setattr(am, "_handle_ci_failure", _boom_ci)
    monkeypatch.setattr(am, "_evaluate_one_pr", _boom_eval)

    actions = _drive_tick_with_gh_checks(tmp_path, monkeypatch, db, _ONLY_MAIN_GREEN_RED)
    assert len(actions) == 1
    assert actions[0].merged is False
    assert "held" in actions[0].reason
    assert "main-green" in actions[0].reason

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value  # exactly where it was
    assert r.reviewer_result_json is None  # no CI finding was fabricated

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert not [e for e in events if e.get("event") == "ci_fix_redispatch"]
    assert not [e for e in events if e.get("event") == "ci_fix_exhausted"]
    assert not [e for e in events if e.get("event") == "ci_unresolved_parked"]
    assert not [e for e in events if e.get("event") == "merge_gates_failed"]
    holds = [e for e in events if e.get("event") == "ci_hold_main_red"]
    assert len(holds) == 1
    assert holds[0]["pr_number"] == 77
    assert holds[0]["required_check"] == "main-green"


def test_narrowing_the_short_circuit_would_be_caught(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard on the guard: the SAME harness, with a genuinely red
    ``pytest (1)`` alongside ``main-green``, MUST reach ``_handle_ci_failure``.

    If it did not, ``test_main_green_hold_touches_nothing``'s "never reaches
    _handle_ci_failure" would be satisfiable by a broken harness (a tick that
    dispatches nothing ever) rather than by the short-circuit. Together the two
    pin the boundary from both sides.
    """
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    _pr_open_story(db)

    reached: list[int] = []
    monkeypatch.setattr(
        am,
        "_handle_ci_failure",
        lambda **kw: (reached.append(kw["pr_number"]), "redispatched")[1],
    )
    monkeypatch.setattr(
        am, "_evaluate_one_pr", lambda **kw: pytest.fail("failure path must not evaluate")
    )

    actions = _drive_tick_with_gh_checks(tmp_path, monkeypatch, db, _MAIN_GREEN_AND_PYTEST_RED)
    assert reached == [77]
    assert "re-dispatched" in actions[0].reason


def test_hold_clears_when_main_goes_green_and_the_merge_proceeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """RECOVERY. Tick 1: main-green red -> held, nothing evaluated. Tick 2: the
    same PR's checks now report main-green PASSING -> the tick proceeds to the
    normal gate evaluation and the merge can land.

    Nothing in auto_merge makes a hold sticky. (The STARVATION risk is on
    GitHub's side — it does not re-run pull_request checks when the base moves,
    so something must re-run the held PR's checks for tick 2's rows to change.
    That is ACTIVATION CHECKLIST item (b) in ``_CI_STATE_HOLD``, deferred by
    design; this test pins that the chain side is ready for it.)
    """
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)

    evaluated: list[int] = []

    def _fake_eval(**kw):  # noqa: ANN003
        evaluated.append(kw["fixture"].pr_number)
        return am.MergeAction(app="sacrifice", pr_number=77, merged=True, reason="merged")

    monkeypatch.setattr(am, "_evaluate_one_pr", _fake_eval)
    monkeypatch.setattr(
        am, "_handle_ci_failure", lambda **kw: pytest.fail("neither tick is a CI failure")
    )

    held = _drive_tick_with_gh_checks(tmp_path, monkeypatch, db, _ONLY_MAIN_GREEN_RED)
    assert "held" in held[0].reason
    assert evaluated == []

    green_rows = "main-green\tpass\t1s\thttps://x\npytest (1)\tpass\t1s\thttps://y"
    merged = _drive_tick_with_gh_checks(tmp_path, monkeypatch, db, green_rows)
    assert evaluated == [77]
    assert merged[0].merged is True

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert len([e for e in events if e.get("event") == "ci_hold_main_red"]) == 1


def test_hold_merge_action_row_is_written_once_per_episode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A held PR is re-evaluated every tick; a per-tick ``merge_actions`` row is
    1,440 rows/PR/day on a 60 s timer — the PR-88 unbounded-row pathology. The
    row is persisted on hold TRANSITION only, on the same test as the event."""
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(
        am, "_evaluate_one_pr", lambda **kw: pytest.fail("no eval under hold")
    )

    for _ in range(5):
        actions = _drive_tick_with_gh_checks(tmp_path, monkeypatch, db, _ONLY_MAIN_GREEN_RED)
        # The in-memory action is returned EVERY tick — the tick's own report
        # must not go silent about a PR it decided to hold.
        assert len(actions) == 1
        assert "held" in actions[0].reason

    rows = [r for r in _merge_action_rows(db) if "held" in (r.reason or "")]
    assert len(rows) == 1, "one merge_actions row per hold EPISODE, not per tick"

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert len([e for e in events if e.get("event") == "ci_hold_main_red"]) == 1


def test_main_green_hold_event_is_deduped_across_ticks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ticks run every minute and a red main can last hours — the hold event is
    emitted once per EPISODE (on transition), not once per tick."""
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(am, "_evaluate_one_pr", lambda **kw: pytest.fail("no eval under hold"))

    for _ in range(4):
        am.auto_merge_tick(
            tmp_path,
            "sacrifice",
            dry_run=False,
            fixture_prs=[_hold_fixture(story)],
            db_path=db,
        )

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert len([e for e in events if e.get("event") == "ci_hold_main_red"]) == 1

    # A NEW episode (something else happened in between) is legible as a second
    # event — the dedupe suppresses spam, not history.
    log_story_event(
        story.id,
        "ci_fix_redispatch",
        {"pr_number": 77, "attempt": 1, "failure_signature": "sig"},
        software_factory_root=tmp_path,
        slug_hint=story.slug,
    )
    story.state = StoryState.PR_OPEN.value
    persist_story(story, db)
    am.auto_merge_tick(
        tmp_path, "sacrifice", dry_run=False, fixture_prs=[_hold_fixture(story)], db_path=db
    )
    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert len([e for e in events if e.get("event") == "ci_hold_main_red"]) == 2


def test_long_hold_surfaces_in_inbox_without_parking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACTIVATION CHECKLIST (a): a hold episode older than the threshold sets
    ``last_rejection_reason`` (once — the prefix is the dedupe) so the story
    reaches ``factory inbox``'s needs-human predicate, while the state stays
    ``pr_open``: no park, no PR close. An unbounded silent hold is the
    ``detect-without-remediate`` failure class."""
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)

    assert am._handle_main_green_hold(
        story=story, pr_number=77, root=tmp_path, db_path=db
    ) is True  # transition

    # Ongoing episode, still YOUNG: nothing surfaces.
    assert am._handle_main_green_hold(
        story=story, pr_number=77, root=tmp_path, db_path=db
    ) is False
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.last_rejection_reason is None

    # Ongoing episode, OLD (threshold forced below any real age).
    monkeypatch.setattr(am, "_HOLD_SURFACE_AFTER_SECONDS", -1)
    assert am._handle_main_green_hold(
        story=story, pr_number=77, root=tmp_path, db_path=db
    ) is False
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value, "surfacing must never park"
    assert (r.last_rejection_reason or "").startswith("ci_hold_main_red:")
    first_reason = r.last_rejection_reason

    # Write-once per episode: another aged tick leaves the reason unchanged.
    am._handle_main_green_hold(story=r, pr_number=77, root=tmp_path, db_path=db)
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r2 = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r2.last_rejection_reason == first_reason


def test_hold_reruns_failed_main_green_once_per_new_main_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ACTIVATION CHECKLIST (b): GitHub freezes pull_request verdicts at the
    head sha, so a hold never self-clears when main goes green. When main's
    HEAD moves during an episode, the failed ``main-green`` run is re-run —
    exactly once per new main commit, whether or not the rerun succeeds (the
    ``ci_hold_rerun`` event's sha is the dedupe). And the rerun event must not
    make the next tick think a NEW episode started."""
    from factory.app_config import AppConfig

    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    cfg = AppConfig(name="sacrifice", repo="o/sacrifice")

    monkeypatch.setattr(am, "_main_head_sha", lambda **kw: "a" * 40)
    assert am._handle_main_green_hold(
        story=story, pr_number=77, root=tmp_path, app_config=cfg, db_path=db
    ) is True  # transition records main_sha a*40

    reruns: list[int] = []

    def _fake_rerun(**kw):  # noqa: ANN003
        reruns.append(kw["pr_number"])
        return True, "re-ran run 123"

    monkeypatch.setattr(am, "_rerun_failed_main_green", _fake_rerun)

    # Main has NOT moved: no rerun.
    am._handle_main_green_hold(
        story=story, pr_number=77, root=tmp_path, app_config=cfg, db_path=db
    )
    assert reruns == []

    # Main MOVED: exactly one rerun, recorded with the new sha.
    monkeypatch.setattr(am, "_main_head_sha", lambda **kw: "b" * 40)
    am._handle_main_green_hold(
        story=story, pr_number=77, root=tmp_path, app_config=cfg, db_path=db
    )
    assert reruns == [77]

    # Same new sha again: the recorded ci_hold_rerun event is the dedupe.
    am._handle_main_green_hold(
        story=story, pr_number=77, root=tmp_path, app_config=cfg, db_path=db
    )
    assert reruns == [77]

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    rerun_events = [e for e in events if e.get("event") == "ci_hold_rerun"]
    assert len(rerun_events) == 1
    assert rerun_events[0]["main_sha"] == "b" * 40
    assert rerun_events[0]["rerun_ok"] is True
    # Episode detection accepts ci_hold_rerun as "still holding": exactly ONE
    # transition event exists despite four held ticks.
    assert len([e for e in events if e.get("event") == "ci_hold_main_red"]) == 1


def test_pending_inside_a_hold_episode_is_not_evaluated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Blockers 1+2 (adversarial review 2026-08-10): the (b) rerun makes a
    held PR's checks read ``pending``. Evaluating that window runs the gates
    against a possibly-still-red main and writes ``merge_gates_failed`` —
    which both counts toward the park the hold exists to prevent AND breaks
    the episode boundary the (a) clock walks. Pending-inside-episode must
    write NOTHING and evaluate nothing."""
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    # Enter a hold episode.
    assert am._handle_main_green_hold(story=story, pr_number=77, root=tmp_path, db_path=db)

    monkeypatch.setattr(
        am, "_evaluate_one_pr", lambda **kw: pytest.fail("pending-in-hold must not evaluate")
    )
    monkeypatch.setattr(
        am, "_handle_ci_failure", lambda **kw: pytest.fail("pending-in-hold must not dispatch")
    )
    fixture = am.FixturePR(
        pr_number=77, head_sha="deadbeef", base_branch="main", labels=[],
        files_changed=["src/x.py"], ci_state="pending", story=story,
    )
    actions = am.auto_merge_tick(
        tmp_path, "sacrifice", dry_run=False, fixture_prs=[fixture], db_path=db
    )
    assert len(actions) == 1
    assert "re-running" in actions[0].reason

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    # The episode boundary is intact: the last event is still the transition
    # (one-shot delivery bookkeeping — a legacy row's first-touch
    # ``delivery_level_resolved`` — is transparent to the boundary by design).
    assert am._hold_stream(events)[-1].get("event") == "ci_hold_main_red"
    assert am._in_hold_episode(story, tmp_path)
    assert not [e for e in events if e.get("event") == "merge_gates_failed"]


def test_pending_outside_a_hold_episode_still_evaluates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pending short-circuit is scoped to hold episodes only — an
    ordinary PR whose checks are still running keeps today's behaviour."""
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)

    reached: list[int] = []

    def _eval(**kw):  # noqa: ANN003
        reached.append(kw["fixture"].pr_number)
        return am.MergeAction(
            app="sacrifice", pr_number=77, merged=False, reason="declined",
            gates_passed=[], blocking_labels=["tests-green"],
        )

    monkeypatch.setattr(am, "_evaluate_one_pr", _eval)
    fixture = am.FixturePR(
        pr_number=77, head_sha="deadbeef", base_branch="main", labels=[],
        files_changed=["src/x.py"], ci_state="pending", story=story,
    )
    am.auto_merge_tick(tmp_path, "sacrifice", dry_run=False, fixture_prs=[fixture], db_path=db)
    assert reached == [77]


def test_stale_hold_reason_is_cleared_when_checks_resolve(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Finding 5 (adversarial review 2026-08-10): a story that leaves a hold
    must not carry `ci_hold_main_red:` into merge/deploy states — on a later
    `blocked_deploy_failed` the inbox would show the stale hold text instead
    of the real failure. Clearing is prefix-guarded: an unrelated reason is
    never wiped."""
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    am._set_hold_reason(story, db, f"{am._HOLD_REASON_PREFIX} PR #77 held since forever")
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert (r.last_rejection_reason or "").startswith(am._HOLD_REASON_PREFIX)

    monkeypatch.setattr(
        am,
        "_evaluate_one_pr",
        lambda **kw: am.MergeAction(
            app="sacrifice", pr_number=77, merged=False, reason="declined",
            gates_passed=[], blocking_labels=["tests-green"],
        ),
    )
    fixture = am.FixturePR(
        pr_number=77, head_sha="deadbeef", base_branch="main", labels=[],
        files_changed=["src/x.py"], ci_state="success", story=story,
    )
    am.auto_merge_tick(tmp_path, "sacrifice", dry_run=False, fixture_prs=[fixture], db_path=db)
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.last_rejection_reason is None
    assert r.error is None

    # Prefix guard: someone else's reason survives a clear attempt.
    am._set_hold_reason(story, db, None)  # story fields already None
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        row = ses.get(StoryRecord, story.id)
        row.last_rejection_reason = "gate_block_exhausted: something real"
        ses.add(row)
        ses.commit()
    story.last_rejection_reason = "gate_block_exhausted: something real"
    am._set_hold_reason(story, db, None)
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.last_rejection_reason == "gate_block_exhausted: something real"


def test_hold_rerun_is_capped_per_episode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Finding 6: one rerun per new main sha is the dedupe; _MAX_HOLD_RERUNS
    is the absolute per-episode backstop against a long red-main incident
    with frequent commits."""
    from factory.app_config import AppConfig

    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    cfg = AppConfig(name="sacrifice", repo="o/sacrifice")

    monkeypatch.setattr(am, "_main_head_sha", lambda **kw: "a" * 40)
    assert am._handle_main_green_hold(
        story=story, pr_number=77, root=tmp_path, app_config=cfg, db_path=db
    )
    reruns: list[str] = []

    def _fake_rerun(**kw):  # noqa: ANN003
        reruns.append("x")
        return True, "re-ran"

    monkeypatch.setattr(am, "_rerun_failed_main_green", _fake_rerun)
    for sha_char in "bcdef":
        monkeypatch.setattr(am, "_main_head_sha", lambda _s=sha_char * 40, **kw: _s)
        am._handle_main_green_hold(
            story=story, pr_number=77, root=tmp_path, app_config=cfg, db_path=db
        )
    assert len(reruns) == am._MAX_HOLD_RERUNS

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert len([e for e in events if e.get("event") == "ci_hold_rerun"]) == am._MAX_HOLD_RERUNS


def test_parse_event_ts_handles_aware_naive_and_garbage() -> None:
    """The (a) clock's substrate. An aware ISO string must round-trip; a
    naive one is UTC by contract (local-time interpretation would starve the
    escalation west of UTC); garbage is None, never an exception."""
    from datetime import UTC as _UTC
    from datetime import datetime as _dt

    aware = _dt(2026, 8, 10, 12, 0, 0, tzinfo=_UTC)
    assert am._parse_event_ts(aware.isoformat()) == aware.timestamp()
    naive_as_utc = am._parse_event_ts("2026-08-10T12:00:00")
    assert naive_as_utc == aware.timestamp()
    assert am._parse_event_ts("not a time") is None
    assert am._parse_event_ts(None) is None
    assert am._parse_event_ts(1754827200.0) == 1754827200.0


_GH_CHECKS_ROWS_FAILING = (
    "main-green\tfail\t1m2s\thttps://github.com/o/r/actions/runs/31334856219/job/93298923618\tdesc\n"
    "pytest (1)\tpass\t1m\thttps://github.com/o/r/actions/runs/31334856219/job/93298923619\tdesc\n"
)
_GH_CHECKS_ROWS_RECOVERED = (
    "main-green\tpass\t1m2s\thttps://github.com/o/r/actions/runs/31334856219/job/93298923618\tdesc\n"
)


def test_rerun_helper_parses_real_gh_rows_and_checks_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Finding 7: the helpers' real bodies were untested. Pin the tab-parse,
    the run-id extraction from a JOB url, the still-failing requirement, and
    the returncode handling — against the real gh 2.45 row shape."""
    import subprocess as _sp

    from factory.app_config import AppConfig

    cfg = AppConfig(name="sacrifice", repo="o/r")
    calls: list[list[str]] = []

    def _fake_run(cmd, **kw):  # noqa: ANN001, ANN003
        calls.append(list(cmd))
        if cmd[:3] == ["gh", "pr", "checks"]:
            return _sp.CompletedProcess(cmd, 1, _GH_CHECKS_ROWS_FAILING, "")
        return _sp.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(_sp, "run", _fake_run)
    ok, detail = _REAL_RERUN_FAILED_MAIN_GREEN(app_config=cfg, pr_number=77)
    assert ok, detail
    assert "31334856219" in detail
    rerun_calls = [c for c in calls if c[:3] == ["gh", "run", "rerun"]]
    assert rerun_calls == [["gh", "run", "rerun", "31334856219", "--failed", "--repo", "o/r"]]

    # A recovered row must NOT be re-run.
    calls.clear()

    def _fake_run_recovered(cmd, **kw):  # noqa: ANN001, ANN003
        calls.append(list(cmd))
        return _sp.CompletedProcess(cmd, 0, _GH_CHECKS_ROWS_RECOVERED, "")

    monkeypatch.setattr(_sp, "run", _fake_run_recovered)
    ok, detail = _REAL_RERUN_FAILED_MAIN_GREEN(app_config=cfg, pr_number=77)
    assert not ok
    assert "no longer failing" in detail
    assert not [c for c in calls if c[:3] == ["gh", "run", "rerun"]]


def test_main_head_sha_helper_validates_output(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess as _sp

    from factory.app_config import AppConfig

    cfg = AppConfig(name="sacrifice", repo="o/r")
    monkeypatch.setattr(
        _sp, "run",
        lambda cmd, **kw: _sp.CompletedProcess(cmd, 0, ("a" * 40) + "\n", ""),
    )
    assert _REAL_MAIN_HEAD_SHA(app_config=cfg, base_branch="main") == "a" * 40
    monkeypatch.setattr(
        _sp, "run",
        lambda cmd, **kw: _sp.CompletedProcess(cmd, 0, "gh: Not Found (HTTP 404)\n", ""),
    )
    assert _REAL_MAIN_HEAD_SHA(app_config=cfg, base_branch="main") is None
    monkeypatch.setattr(
        _sp, "run",
        lambda cmd, **kw: (_ for _ in ()).throw(FileNotFoundError("gh")),
    )
    assert _REAL_MAIN_HEAD_SHA(app_config=cfg, base_branch="main") is None


def test_real_ci_failure_alongside_main_green_still_takes_the_failure_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(ii) main-green red + pytest (1) red -> the PR genuinely failed CI, so
    the historical path runs unchanged. Classification is `_query_ci_state`'s
    job (pinned in tests/test_ci_state_query.py); this pins that the "failure"
    it produces still reaches the dev re-dispatch."""
    import subprocess

    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: "FAIL: boom")

    rows = "main-green\tfail\t1s\thttps://x\npytest (1)\tfail\t1s\thttps://y"
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, rows, ""),
    )
    assert am._query_ci_state(app_config=_cfg(), pr_number=77) == "failure"

    fixture = _hold_fixture(story)
    fixture.ci_state = "failure"
    actions = am.auto_merge_tick(
        tmp_path, "sacrifice", dry_run=False, fixture_prs=[fixture], db_path=db
    )
    assert len(actions) == 1
    assert "re-dispatched" in actions[0].reason
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert len([e for e in events if e.get("event") == "ci_fix_redispatch"]) == 1
    assert not [e for e in events if e.get("event") == "ci_hold_main_red"]


def test_dry_run_and_placeholder_prs_are_not_held(tmp_path: Path) -> None:
    """The hold is a real-run, real-PR concern — dry-run previews and
    placeholder (negative) PR numbers behave exactly as before."""
    _hold_app(tmp_path)
    db = _seed(tmp_path)
    story = _pr_open_story(db)

    actions = am.auto_merge_tick(
        tmp_path, "sacrifice", dry_run=True, fixture_prs=[_hold_fixture(story)], db_path=db
    )
    assert "held" not in actions[0].reason

    ph = _hold_fixture(story)
    ph.pr_number = -(story.id or 0)
    actions = am.auto_merge_tick(
        tmp_path, "sacrifice", dry_run=False, fixture_prs=[ph], db_path=db
    )
    assert "held" not in actions[0].reason

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    assert not [e for e in events if e.get("event") == "ci_hold_main_red"]


# --------------------------------------------------------------------------- #
# OPERATOR RESUME scopes the CI-fix window (the _gate_block_history precedent).
# --------------------------------------------------------------------------- #


def test_story_resumed_resets_the_ci_fix_redispatch_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(iii) ci_fix_redispatch events logged BEFORE a story_resumed are not
    counted after it. Without this, `factory resume-story` was a no-op wearing
    a success message: the resumed story hit the cap on its FIRST evaluation
    and re-parked before the fixed environment ever got a turn."""
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: "FAIL: boom")

    for i in range(am._MAX_CI_FIX_CYCLES):
        log_story_event(
            story.id,
            "ci_fix_redispatch",
            {"pr_number": 77, "attempt": i + 1, "failure_signature": f"sig-{i}"},
            software_factory_root=tmp_path,
            slug_hint=story.slug,
        )
    # Pre-resume, the cap is reached: this would park (and close the PR).
    log_story_event(
        story.id,
        "story_resumed",
        {"to_state": "pr_open"},
        software_factory_root=tmp_path,
        slug_hint=story.slug,
    )

    def _boom_close(pr, repo, **kw):  # noqa: ANN001, ANN003
        raise AssertionError("a resumed story must not be parked on pre-resume history")

    outcome = am._handle_ci_failure(
        story=story,
        app_config=_cfg(),
        pr_number=77,
        db=db,
        root=tmp_path,
        close_pr_fn=_boom_close,
    )
    assert outcome == "redispatched"
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.REVIEWER_REQUESTED_CHANGES.value

    events = read_story_events(story.id, software_factory_root=tmp_path, slug_hint=story.slug)
    post = events[[e.get("event") for e in events].index("story_resumed") + 1 :]
    new = [e for e in post if e.get("event") == "ci_fix_redispatch"]
    assert len(new) == 1
    # Attempt numbering restarts from the resume, not from all-time history.
    assert new[0]["attempt"] == 1
    assert not [e for e in events if e.get("event") == "ci_fix_exhausted"]


def test_signature_guard_is_also_resume_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The identical-signature guard reads the LAST prior redispatch; scoped to
    the resume, a pre-resume redispatch with the same signature no longer parks
    the story. This is the shape a red main produced: the redispatches were
    never the story's fault and the resume is the operator saying so."""
    db = _seed(tmp_path)
    story = _pr_open_story(db)
    monkeypatch.setattr(am, "_fetch_ci_failure_logs", lambda **kw: "FAIL test_x.py: boom")

    first = am._handle_ci_failure(
        story=story, app_config=_cfg(), pr_number=77, db=db, root=tmp_path
    )
    assert first == "redispatched"
    story.state = StoryState.PR_OPEN.value
    persist_story(story, db)

    log_story_event(
        story.id,
        "story_resumed",
        {"to_state": "pr_open"},
        software_factory_root=tmp_path,
        slug_hint=story.slug,
    )

    def _boom_close(pr, repo, **kw):  # noqa: ANN001, ANN003
        raise AssertionError("resume must clear the identical-signature guard too")

    second = am._handle_ci_failure(
        story=story,
        app_config=_cfg(),
        pr_number=77,
        db=db,
        root=tmp_path,
        close_pr_fn=_boom_close,
    )
    assert second == "redispatched"


# --------------------------------------------------------------------------- #
# _ci_failure_is_genuine — real conclusion vocabulary (gh statusCheckRollup),
# NOT the gh-pr-checks buckets that collapse TIMED_OUT/ERROR into "fail".
# --------------------------------------------------------------------------- #


def _fake_genuine_run(rollup, required_names=("lint", "pytest", "smoke")):
    """Mock BOTH gh calls `_ci_failure_is_genuine` makes: `pr checks --required`
    (TSV: name<TAB>bucket...) for the REQUIRED set, and `pr view
    --json statusCheckRollup` for the real conclusions."""
    import subprocess

    def _run(cmd, **kw):
        if cmd[:3] == ["gh", "pr", "checks"]:
            tsv = "\n".join(f"{n}\tfail\t1s\thttps://x" for n in required_names)
            return subprocess.CompletedProcess(cmd, 1, tsv, "")
        if cmd[:3] == ["gh", "pr", "view"]:
            return subprocess.CompletedProcess(
                cmd, 0, json.dumps({"statusCheckRollup": rollup}), ""
            )
        raise AssertionError(f"unexpected gh invocation: {cmd}")

    return _run


def test_genuine_true_on_required_failure_conclusion(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_genuine_run(
            [
                {"conclusion": "SUCCESS", "name": "lint"},
                {"conclusion": "FAILURE", "name": "pytest"},  # required + genuine defect
            ]
        ),
        raising=True,
    )
    assert am._ci_failure_is_genuine(app_config=_cfg(), pr_number=77) is True


def test_genuine_false_on_infra_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """A red made ONLY of infra-transient required conclusions must NOT count as
    genuine — the case gh's 'fail' bucket hides. TIMED_OUT is the reviewer's
    canonical false-close scenario."""
    import subprocess

    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_genuine_run(
            [
                {"conclusion": "SUCCESS", "name": "lint"},
                {"conclusion": "TIMED_OUT", "name": "pytest"},  # runner wall-clock
                {"conclusion": "CANCELLED", "name": "smoke"},
            ]
        ),
        raising=True,
    )
    assert am._ci_failure_is_genuine(app_config=_cfg(), pr_number=77) is False


def test_genuine_false_when_only_nonrequired_check_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The required check is a transient TIMED_OUT; a NON-required optional check
    concluded FAILURE. A non-required failure never blocks merge, so this must NOT
    be treated as genuine (else we'd auto-close a mergeable PR). This is the exact
    over-close the required-scoping fix closes."""
    import subprocess

    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_genuine_run(
            [
                {"conclusion": "TIMED_OUT", "name": "pytest"},  # REQUIRED, transient
                {"conclusion": "FAILURE", "name": "coverage-bot"},  # NON-required
            ],
            required_names=("lint", "pytest", "smoke"),  # coverage-bot is NOT required
        ),
        raising=True,
    )
    assert am._ci_failure_is_genuine(app_config=_cfg(), pr_number=77) is False


def test_genuine_false_on_duplicate_name_mixed_conclusions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A REQUIRED name maps to TWO rollup entries with MIXED conclusions: the
    required check itself TIMED_OUT (transient) while a NON-required check sharing
    the same name concluded FAILURE. ``statusCheckRollup`` does not mark which
    entry is required, so an exact-name match could pick up the non-required
    FAILURE and auto-close a PR whose only required red was a timeout. Mixed
    conclusions for one name are AMBIGUOUS → NOT genuine (safe under-close)."""
    import subprocess

    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_genuine_run(
            [
                {"conclusion": "SUCCESS", "name": "lint"},
                {"conclusion": "TIMED_OUT", "name": "pytest"},  # the REQUIRED pytest, transient
                {"conclusion": "FAILURE", "name": "pytest"},  # a NON-required same-named check
            ]
        ),
        raising=True,
    )
    assert am._ci_failure_is_genuine(app_config=_cfg(), pr_number=77) is False


def test_genuine_true_on_duplicate_name_all_agree_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A REQUIRED name maps to MULTIPLE rollup entries that ALL agree on FAILURE
    (e.g. a matrix/re-run reporting the same name twice). Unanimous FAILURE is
    unambiguous → genuine (the duplicate-name guard must not suppress a real
    all-red)."""
    import subprocess

    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_genuine_run(
            [
                {"conclusion": "SUCCESS", "name": "lint"},
                {"conclusion": "FAILURE", "name": "pytest"},
                {"conclusion": "FAILURE", "name": "pytest"},  # same name, agrees
            ]
        ),
        raising=True,
    )
    assert am._ci_failure_is_genuine(app_config=_cfg(), pr_number=77) is True


def test_genuine_true_on_single_failure_with_infra_dup_on_other_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A required name with a SINGLE unambiguous FAILURE stays genuine even when a
    DIFFERENT required name is a mixed/infra red — the guard is per-name, so one
    clean required FAILURE is enough to close."""
    import subprocess

    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_genuine_run(
            [
                {"conclusion": "TIMED_OUT", "name": "smoke"},  # a different required, transient
                {"conclusion": "FAILURE", "name": "pytest"},  # single, unambiguous, required
            ]
        ),
        raising=True,
    )
    assert am._ci_failure_is_genuine(app_config=_cfg(), pr_number=77) is True


def test_genuine_false_on_query_problem(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    def _nonzero(cmd, **kw):
        # pr checks reports "no required checks" -> fail-safe False
        if cmd[:3] == ["gh", "pr", "checks"]:
            return subprocess.CompletedProcess(cmd, 0, "no required checks reported", "")
        return subprocess.CompletedProcess(cmd, 1, "", "boom")

    monkeypatch.setattr(subprocess, "run", _nonzero, raising=True)
    assert am._ci_failure_is_genuine(app_config=_cfg(), pr_number=77) is False
    assert am._ci_failure_is_genuine(app_config=_cfg(), pr_number=-5) is False  # placeholder


def test_close_and_confirm_bails_on_merged(monkeypatch: pytest.MonkeyPatch) -> None:
    """An out-of-band MERGED PR must NOT be parked (that would strand a merge with
    no deploy). _close_pr_and_confirm returns False so the next reconcile records
    the merge -> deploy. And it must NOT attempt a close/comment."""
    import subprocess

    calls: list[list[str]] = []

    def _run(cmd, **kw):
        calls.append(cmd)
        if cmd[:3] == ["gh", "pr", "view"]:
            return subprocess.CompletedProcess(cmd, 0, "MERGED", "")
        raise AssertionError(f"must not close/comment a merged PR: {cmd}")

    monkeypatch.setattr(subprocess, "run", _run, raising=True)
    assert am._close_pr_and_confirm(77, "o/sacrifice", comment="x") is False
    assert not any(c[:3] == ["gh", "pr", "close"] for c in calls)


def test_close_and_confirm_closes_open_pr_then_confirms(monkeypatch: pytest.MonkeyPatch) -> None:
    """OPEN -> close -> re-verify CLOSED -> comment once -> True."""
    import subprocess

    states = iter(["OPEN", "CLOSED"])  # before close, after close
    seq: list[str] = []

    def _run(cmd, **kw):
        if cmd[:3] == ["gh", "pr", "view"]:
            return subprocess.CompletedProcess(cmd, 0, next(states), "")
        if cmd[:3] == ["gh", "pr", "close"]:
            seq.append("close")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if cmd[:3] == ["gh", "pr", "comment"]:
            seq.append("comment")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        raise AssertionError(cmd)

    monkeypatch.setattr(subprocess, "run", _run, raising=True)
    assert am._close_pr_and_confirm(77, "o/sacrifice", comment="x") is True
    assert seq == ["close", "comment"]  # comment posted AFTER confirmed close, once


def test_close_and_confirm_no_comment_when_close_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """If the close does not take (PR still OPEN after), return False and post NO
    comment — so a persistent can't-close PR never accrues per-tick comment spam."""
    import subprocess

    def _run(cmd, **kw):
        if cmd[:3] == ["gh", "pr", "view"]:
            return subprocess.CompletedProcess(cmd, 0, "OPEN", "")  # stays open
        if cmd[:3] == ["gh", "pr", "close"]:
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if cmd[:3] == ["gh", "pr", "comment"]:
            raise AssertionError("must NOT comment when close is unconfirmed")
        raise AssertionError(cmd)

    monkeypatch.setattr(subprocess, "run", _run, raising=True)
    assert am._close_pr_and_confirm(77, "o/sacrifice", comment="x") is False
