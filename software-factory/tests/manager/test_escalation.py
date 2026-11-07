"""Tests for factory.manager.escalation — the L4 escalation channel (WS3.1).

Closes the silent-sink: an escalate_to_human / forbidden proposal must open an
(idempotent) GitHub issue + emit a loud alert instead of dying in the history
file. gh is mocked; no network is touched.

Coverage:
  * an escalate_to_human proposal opens a gh issue + writes an alert event
  * a re-fired SAME-id escalation does NOT open a duplicate (local dedup)
  * an already-open matching issue (gh-side dedup) is reused, not re-created
  * a gh failure does NOT crash L4 and is still visible on the alert stream

The end-to-end-through-apply_manager_proposals test that used to live here
was removed 2026-08-07 along with ``factory/manager/apply.py`` (the L4 apply
tier) — see STATUS.md and the Exteroception v1 direction, P0. This file now
covers ``notify_escalation`` directly.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from factory.manager.escalation import ESCALATION_LABEL, notify_escalation


@dataclass
class _Completed:
    returncode: int
    stdout: str = ""
    stderr: str = ""


def _make_gh_runner(
    *,
    list_stdout: str = "[]",
    list_rc: int = 0,
    create_rc: int = 0,
    create_url: str = "https://github.com/owner/repo/issues/777\n",
) -> tuple[Callable[..., Any], list[list[str]]]:
    """A runner that mocks the gh commands the escalation channel uses."""
    calls: list[list[str]] = []

    def _runner(args: list[str], **kwargs: Any) -> Any:
        calls.append(list(args))
        if args[:3] == ["gh", "issue", "list"]:
            return _Completed(returncode=list_rc, stdout=list_stdout)
        if args[:3] == ["gh", "label", "create"]:
            return _Completed(returncode=0)
        if args[:3] == ["gh", "issue", "create"]:
            return _Completed(returncode=create_rc, stdout=create_url)
        return _Completed(returncode=0)

    return _runner, calls


def _make_stateful_gh_runner() -> tuple[Callable[..., Any], list[list[str]], dict[str, Any]]:
    """A gh mock that models GitHub state: created issues persist, and
    ``gh issue list --state open`` only returns OPEN issues whose body matches
    the ``--search`` term. Tests can close issues via ``state["issues"]`` to
    simulate a human resolving one. This is what makes the OPEN-state dedup
    (and re-escalation after resolution) testable."""
    state: dict[str, Any] = {"issues": [], "next": 800}
    calls: list[list[str]] = []

    def _runner(args: list[str], **kwargs: Any) -> Any:
        calls.append(list(args))
        if args[:3] == ["gh", "issue", "list"]:
            search = args[args.index("--search") + 1] if "--search" in args else ""
            open_matching = [
                {"number": i["number"], "body": i["body"]}
                for i in state["issues"]
                if i["state"] == "open" and search in i["body"]
            ]
            return _Completed(returncode=0, stdout=json.dumps(open_matching))
        if args[:3] == ["gh", "label", "create"]:
            return _Completed(returncode=0)
        if args[:3] == ["gh", "issue", "create"]:
            body = args[args.index("--body") + 1] if "--body" in args else ""
            num = state["next"]
            state["next"] += 1
            state["issues"].append({"number": num, "body": body, "state": "open"})
            return _Completed(
                returncode=0,
                stdout=f"https://github.com/owner/repo/issues/{num}\n",
            )
        return _Completed(returncode=0)

    return _runner, calls, state


def _proposal(
    *,
    concern_id: str = "concern-abc",
    proposal_id: str = "prop-1",
    classification_hint: str = "escalate_to_human",
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "concern_id": concern_id,
        "proposal_id": proposal_id,
        "concern_title": "sm-token-overflow",
        "diagnosis": "SM persona overflowed its token budget repeatedly.",
        "escalation_reason": "no safe automated fix available",
        "proposal": {
            "kind": "improvement",
            "target": "factory/personas/sm.md",
            "rationale": "Operator should trim the SM persona.",
            "suggested_patch": "",
        },
        "target_class": classification_hint,
        "escalate_to_human": classification_hint == "escalate_to_human",
    }


def _alerts(root: Path) -> list[dict[str, Any]]:
    p = root / "state" / "events" / "alerts.ndjson"
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# A. Escalation opens an issue + alert
# ---------------------------------------------------------------------------


def test_escalation_opens_issue_and_alert(tmp_path: Path) -> None:
    runner, calls = _make_gh_runner()
    outcome = notify_escalation(
        _proposal(),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=runner,
    )
    assert outcome["notified"] is True
    assert outcome["gh_ok"] is True
    assert outcome["issue_number"] == 777

    # A gh issue create call was made with the escalation label.
    create = [c for c in calls if c[:3] == ["gh", "issue", "create"]]
    assert create, "expected a gh issue create call"
    assert ESCALATION_LABEL in create[0]

    # A loud alert was written.
    alerts = _alerts(tmp_path)
    assert any(a.get("kind") == "fms_escalation" for a in alerts)


def test_forbidden_also_escalates(tmp_path: Path) -> None:
    runner, calls = _make_gh_runner()
    outcome = notify_escalation(
        _proposal(classification_hint="forbidden"),
        root=tmp_path,
        repo="owner/repo",
        classification="forbidden",
        runner=runner,
    )
    assert outcome["notified"] is True
    assert [c for c in calls if c[:3] == ["gh", "issue", "create"]]
    assert any(a.get("kind") == "fms_escalation" for a in _alerts(tmp_path))


def test_contentless_proposal_dumps_raw_payload_instead_of_going_silent(
    tmp_path: Path,
) -> None:
    """Regression for issue #179: a producer that populates fields under keys
    this renderer doesn't read must not yield a `?` / `(none provided)`
    issue with no forensic trail. Every recognised field empty -> the raw
    proposal/result dicts are dumped verbatim into the issue body."""
    runner, calls = _make_gh_runner()
    contentless = {
        "schema_version": 1,
        # No concern_id, no proposal_id, no diagnosis, no escalation_reason —
        # but the caller DID pass something, just under keys the renderer
        # never reads (the historical #179 producer/renderer mismatch).
        "concern_title": "chain factory self-edit PR #178",
        "proposal": {},
        "detail": "some detail the renderer does not look at",
    }
    outcome = notify_escalation(
        contentless,
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        result={"pr_number": 178, "staging_status": "diff_unavailable"},
        runner=runner,
    )
    assert outcome["notified"] is True
    create = [c for c in calls if c[:3] == ["gh", "issue", "create"]]
    assert create
    body = create[0][create[0].index("--body") + 1]
    assert "renderer/producer contract mismatch" in body.lower()
    # The unrendered fields are preserved verbatim so nothing is lost.
    assert "some detail the renderer does not look at" in body
    assert "diff_unavailable" in body


# ---------------------------------------------------------------------------
# A. Idempotency — re-firing the same id does not open a duplicate
# ---------------------------------------------------------------------------


def test_same_id_refire_deduped_while_issue_open(tmp_path: Path) -> None:
    """A second escalation for the same concern is deduped while its tracking
    issue is still OPEN on GitHub: no new issue, no repeat alert. The dedup
    AUTHORITY is the open issue, not the local ledger."""
    runner, calls, _state = _make_stateful_gh_runner()
    notify_escalation(
        _proposal(),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=runner,
    )
    creates_after_first = len([c for c in calls if c[:3] == ["gh", "issue", "create"]])
    alerts_after_first = len(_alerts(tmp_path))

    # Re-fire the SAME concern under a FRESH proposal_id (L3 re-emitted it).
    outcome2 = notify_escalation(
        _proposal(proposal_id="prop-2"),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=runner,
    )
    assert outcome2["deduped"] is True
    assert outcome2["reason"] == "existing_open_issue"
    # No second issue created, no second alert emitted while the issue is OPEN.
    assert len([c for c in calls if c[:3] == ["gh", "issue", "create"]]) == creates_after_first
    assert len(_alerts(tmp_path)) == alerts_after_first


def test_resolved_then_recurring_reescalates(tmp_path: Path) -> None:
    """The over-dedup fix: a concern escalated once, whose issue a human CLOSES,
    must re-escalate when it recurs — the never-expiring local ledger must NOT
    permanently suppress it."""
    runner, calls, state = _make_stateful_gh_runner()

    # First escalation → opens an issue + one alert.
    out1 = notify_escalation(
        _proposal(),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=runner,
    )
    assert out1["deduped"] is False
    assert out1["issue_number"] == 800
    assert len([c for c in calls if c[:3] == ["gh", "issue", "create"]]) == 1
    assert len(_alerts(tmp_path)) == 1

    # A human resolves/closes the issue.
    state["issues"][0]["state"] = "closed"

    # The SAME concern recurs later — it must re-escalate (new issue + alert),
    # NOT be silently suppressed by the local ledger.
    out2 = notify_escalation(
        _proposal(proposal_id="prop-3"),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=runner,
    )
    assert out2["deduped"] is False, "resolved-then-recurring must re-escalate"
    assert out2["issue_number"] == 801
    assert len([c for c in calls if c[:3] == ["gh", "issue", "create"]]) == 2
    assert len(_alerts(tmp_path)) == 2


def test_gh_uncertain_falls_back_to_local_ledger(tmp_path: Path) -> None:
    """When gh cannot be consulted (list call fails → uncertain), the local
    ledger is the fallback dedup so we don't spam while GitHub is unreachable."""
    # First: a successful escalation that records a local-ledger entry.
    ok_runner, _, _ = _make_stateful_gh_runner()
    notify_escalation(
        _proposal(),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=ok_runner,
    )
    alerts_after_first = len(_alerts(tmp_path))

    # Now gh is down: list returns rc=1 (uncertain), create would also fail.
    def _down_runner(args: list[str], **kwargs: Any) -> Any:
        if args[:3] == ["gh", "issue", "list"]:
            return _Completed(returncode=1, stderr="gh: auth required")
        return _Completed(returncode=1)

    out = notify_escalation(
        _proposal(proposal_id="prop-9"),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=_down_runner,
    )
    assert out["deduped"] is True
    assert out["reason"] == "already_notified_local"
    # No repeat alert while deduped via the local fallback.
    assert len(_alerts(tmp_path)) == alerts_after_first


def test_existing_open_issue_reused_not_recreated(tmp_path: Path) -> None:
    """gh-side dedup: if an open fms-escalation issue already carries the id
    marker (e.g. local history was wiped), reuse it instead of creating a new
    one."""
    marker = "<!-- fms-escalation:concern-abc -->"
    list_stdout = json.dumps([{"number": 123, "body": f"prior body\n{marker}"}])
    runner, calls = _make_gh_runner(list_stdout=list_stdout)
    outcome = notify_escalation(
        _proposal(),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=runner,
    )
    assert outcome["issue_number"] == 123
    assert outcome["deduped"] is True
    # No new issue created.
    assert not [c for c in calls if c[:3] == ["gh", "issue", "create"]]


# ---------------------------------------------------------------------------
# A. gh failure does not crash, still visible
# ---------------------------------------------------------------------------


def test_gh_create_failure_does_not_crash_but_is_visible(tmp_path: Path) -> None:
    runner, _ = _make_gh_runner(create_rc=1, create_url="")
    outcome = notify_escalation(
        _proposal(),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=runner,
    )
    # Did not crash; recorded the failure.
    assert outcome["notified"] is True
    assert outcome["gh_ok"] is False
    assert outcome["reason"] == "gh_create_failed"
    # Both the escalation alert AND a gh-failure alert are visible.
    kinds = {a.get("kind") for a in _alerts(tmp_path)}
    assert "fms_escalation" in kinds
    assert "fms_escalation_gh_failed" in kinds


def test_gh_runner_raising_does_not_crash(tmp_path: Path) -> None:
    """Even a runner that raises (e.g. gh binary missing) must not crash L4."""

    def _raising_runner(args: list[str], **kwargs: Any) -> Any:
        raise FileNotFoundError("gh not found")

    outcome = notify_escalation(
        _proposal(),
        root=tmp_path,
        repo="owner/repo",
        classification="escalate_to_human",
        runner=_raising_runner,
    )
    assert outcome["notified"] is True
    assert outcome["gh_ok"] is False
    # The escalation is still visible on the alert stream.
    assert any(a.get("kind") == "fms_escalation" for a in _alerts(tmp_path))


def test_no_repo_still_alerts(tmp_path: Path) -> None:
    """With no repo we cannot open an issue, but the alert must still fire."""
    runner, calls = _make_gh_runner()
    outcome = notify_escalation(
        _proposal(),
        root=tmp_path,
        repo=None,
        classification="escalate_to_human",
        runner=runner,
    )
    assert outcome["notified"] is True
    assert outcome["reason"] == "no_repo"
    assert not [c for c in calls if c[:3] == ["gh", "issue", "create"]]
    assert any(a.get("kind") == "fms_escalation" for a in _alerts(tmp_path))

