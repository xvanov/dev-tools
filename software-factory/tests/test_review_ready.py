# ruff: noqa: F811
"""``delivery.review_ready``: a green ``draft_pr`` / ``pr`` PR is marked ready,
CodeRabbit's review is awaited, its open comments go to the dev (3 rounds), and
only then is the story delivered. Off by default: a draft stays a draft.

No network: the ``review_ready`` gh seams are faked.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from factory.chain import auto_merge as am
from factory.chain import delivery_gate, review_ready
from factory.chain.event_log import log_story_event
from factory.chain.state_machine import StoryRecord, StoryState
from factory.delivery import DeliveryLevel as L
from tests.test_delivery_ci_watch import (  # noqa: F401 - fixtures
    GREEN,
    _back_from_dev,
    _events,
    _names,
    _tick,
    disarms,
    no_gh,
)
from tests.test_delivery_enforcement import _reload, _root, _story

HEAD = "ab" * 20


@pytest.fixture
def rr_root(tmp_path: Path) -> Path:
    root = _root(tmp_path)
    d = root / "apps" / "sacrifice"
    d.mkdir(parents=True)
    (d / "config.yaml").write_text(
        "name: sacrifice\nrepo: o/r\ndelivery:\n  default: draft_pr\n  review_ready: true\n",
        encoding="utf-8",
    )
    return root


class Gh:
    def __init__(self) -> None:
        self.draft = True
        self.reviewed = False
        self.threads: list[dict[str, Any]] = []
        self.ready_calls = 0
        self.replied: list[str] = []

    def state(self, repo: str, pr: int) -> dict[str, Any]:
        return {
            "head": HEAD,
            "is_draft": self.draft,
            "reviewed_heads": [HEAD] if self.reviewed else [],
            "open_threads": list(self.threads),
        }

    def ready(self, repo: str, pr: int) -> None:
        self.ready_calls += 1
        self.draft = False

    def reply(self, tid: str, body: str) -> None:
        self.replied.append(tid)
        self.threads = [t for t in self.threads if t["id"] != tid]


@pytest.fixture
def gh(monkeypatch: pytest.MonkeyPatch) -> Gh:
    g = Gh()
    monkeypatch.setattr(review_ready, "read_state", g.state)
    monkeypatch.setattr(review_ready, "mark_ready", g.ready)
    monkeypatch.setattr(review_ready, "reply_and_resolve", g.reply)
    return g


def _fix_pushed(root: Path, s: StoryRecord) -> None:
    log_story_event(
        s.id, "fix_push", {"head_sha": "cd" * 20}, software_factory_root=root, slug_hint=s.slug
    )
    _back_from_dev(root, s)


def _open(root: Path, level: L = L.DRAFT_PR) -> tuple[StoryRecord, Path]:
    db = root / "state" / "factory.db"
    return _story(db, StoryState.PR_OPEN, level, github_pr_number=18), db


def test_off_by_default_a_draft_stays_a_draft(tmp_path: Path, disarms: list[int], gh: Gh) -> None:
    root = _root(tmp_path)
    (root / "apps" / "sacrifice").mkdir(parents=True)
    (root / "apps" / "sacrifice" / "config.yaml").write_text(
        "name: sacrifice\nrepo: o/r\ndelivery:\n  default: draft_pr\n", encoding="utf-8"
    )
    s, db = _open(root)
    _tick(root, s, GREEN, draft=True)
    assert _reload(db, s.id).state == StoryState.DELIVERED_PR.value
    assert gh.ready_calls == 0


def test_marks_ready_waits_for_review_then_delivers_clean(
    rr_root: Path, disarms: list[int], gh: Gh
) -> None:
    s, db = _open(rr_root)

    acts = _tick(rr_root, s, GREEN, draft=True)
    assert gh.ready_calls == 1 and "marked ready" in acts[0].reason
    assert review_ready.EVENT_MARKED in _names(rr_root, s)
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value

    acts = _tick(rr_root, s, GREEN)  # no CodeRabbit review yet
    assert "waiting for CodeRabbit" in acts[0].reason
    assert _reload(db, s.id).state == StoryState.PR_OPEN.value

    gh.reviewed = True
    _tick(rr_root, s, GREEN)
    assert _reload(db, s.id).state == StoryState.DELIVERED_PR.value
    assert gh.ready_calls == 1


def test_open_comments_go_to_dev_then_are_resolved_and_delivered(
    rr_root: Path, disarms: list[int], gh: Gh
) -> None:
    s, db = _open(rr_root, L.PR)
    gh.draft = False
    gh.reviewed = True
    gh.threads = [{"id": "T1", "path": "a.md", "line": 3, "body": "fix the dead link"}]

    acts = _tick(rr_root, s, GREEN)
    row = _reload(db, s.id)
    assert row.state == StoryState.REVIEWER_REQUESTED_CHANGES.value
    assert "review round 1/3" in acts[0].reason
    payload = json.loads(row.reviewer_result_json or "{}")
    assert payload["source"] == "review_bot"
    assert "fix the dead link" in payload["findings"][0]["what"]
    ev = [e for e in _events(rr_root, s) if e.get("event") == "ci_fix_redispatch"]
    assert ev[0]["kind"] == "review" and ev[0]["thread_ids"] == ["T1"]

    _fix_pushed(rr_root, s)
    gh.reviewed = True  # the bot reviewed the new head
    _tick(rr_root, s, GREEN)
    assert gh.replied == ["T1"]
    assert _reload(db, s.id).state == StoryState.DELIVERED_PR.value
    assert review_ready.EVENT_RESOLVED in _names(rr_root, s)


def test_round_cap_delivers_with_a_note(rr_root: Path, disarms: list[int], gh: Gh) -> None:
    s, db = _open(rr_root, L.PR)
    gh.draft = False
    gh.reviewed = True
    for n in range(3):
        gh.threads = [{"id": f"T{n}", "path": "a.md", "line": 1, "body": "x"}]
        _tick(rr_root, s, GREEN)
        assert _reload(db, s.id).state == StoryState.REVIEWER_REQUESTED_CHANGES.value
        _fix_pushed(rr_root, s)
        gh.threads = [{"id": f"N{n}", "path": "a.md", "line": 1, "body": "new"}]
        gh.reviewed = True
        if n < 2:
            continue
    # Round 4 would be needed: capped, delivered ready with a note.
    _tick(rr_root, s, GREEN)
    row = _reload(db, s.id)
    assert row.state == StoryState.DELIVERED_PR.value
    note = [e for e in _events(rr_root, s) if e.get("event") == "delivered"][-1]["ci_note"]
    assert "cap 3" in note


def test_review_wait_is_bounded(
    rr_root: Path, disarms: list[int], gh: Gh, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(review_ready, "REVIEW_WAIT_S", 0)
    s, db = _open(rr_root, L.PR)
    gh.draft = False
    _tick(rr_root, s, GREEN)
    assert _reload(db, s.id).state == StoryState.DELIVERED_PR.value
    note = [e for e in _events(rr_root, s) if e.get("event") == "delivered"][-1]["ci_note"]
    assert "did not review" in note


def test_mark_ready_failure_delivers_as_draft_with_a_note(
    rr_root: Path, disarms: list[int], gh: Gh, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(review_ready, "mark_ready", lambda repo, pr: "boom")
    s, db = _open(rr_root)
    _tick(rr_root, s, GREEN, draft=True)
    assert _reload(db, s.id).state == StoryState.DELIVERED_PR.value
    note = [e for e in _events(rr_root, s) if e.get("event") == "delivered"][-1]["ci_note"]
    assert "gh pr ready" in note and delivery_gate and am
