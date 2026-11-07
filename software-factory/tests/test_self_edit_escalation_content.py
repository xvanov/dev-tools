"""A self-edit escalation must be ACTIONABLE, not just a notification.

Regression for GitHub issue #179 (xvanov/software-factory), auto-created by the
FMS L4 escalation channel for ``chain-selfedit-story-167-pr-178``. Its whole
body was::

    classification: escalate_to_human
    concern_id: `?`
    target: `?`
    Why this escalated: "The proposal explicitly requested human escalation."
    Concern / diagnosis: _(none provided)_
    Proposed action: _(none provided)_

No concern, no target, no diagnosis — nothing an operator can act on. The cause
was a CONTRACT MISMATCH between producer and renderer: the chain-side self-edit
path (``factory.chain.auto_merge._escalate_self_edit``) passed ``concern_title``,
``proposal.suggested_patch`` and a ``detail`` key, while
``factory.manager.escalation._build_issue_body`` renders ``concern_id``,
``proposal.target``, ``diagnosis``, ``proposal.rationale`` and
``escalation_reason``.

These tests drive the REAL renderer (``manager.escalation._build_issue_body``,
which is in the forbidden-to-edit ``factory/manager/**`` tree and is therefore
used here as-is) with the proposal the chain actually produces, and assert the
rendered issue body carries the staging status, the reason, and the PR/story.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from factory.app_config import AppConfig
from factory.chain.auto_merge import _evaluate_self_edit_gate
from factory.chain.state_machine import StoryRecord, StoryState
from factory.manager.escalation import _build_issue_body, _marker_id
from factory.manager.staging import StagingDecision

_SELF_EDIT_PATCH = """\
diff --git a/factory/foo.py b/factory/foo.py
--- a/factory/foo.py
+++ b/factory/foo.py
@@ -1 +1 @@
-x = 1
+x = 2
"""

_FORBIDDEN_MANAGER_PATCH = """\
diff --git a/factory/manager/apply.py b/factory/manager/apply.py
--- a/factory/manager/apply.py
+++ b/factory/manager/apply.py
@@ -1 +1 @@
-y = 1
+y = 2
"""

# The exact placeholders issue #179 rendered. Their presence in a body means the
# renderer was handed nothing to say.
_EMPTY_MARKERS = ("_(none provided)_", "`?`")


class _CapturingEscalator:
    """Stands in for ``manager.escalation.notify_escalation``, capturing calls."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self,
        proposal: dict[str, Any],
        *,
        root: Path,
        repo: str,
        classification: str,
        result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "proposal": proposal,
                "root": root,
                "repo": repo,
                "classification": classification,
                "result": result,
            }
        )
        return {"notified": True}


class _Gate:
    def __init__(
        self, *, decision: StagingDecision | None = None, raises: Exception | None = None
    ) -> None:
        self._decision = decision
        self._raises = raises

    def __call__(self, proposal: Any, proposal_path: Any, *, root: Any) -> StagingDecision:
        if self._raises is not None:
            raise self._raises
        assert self._decision is not None
        return self._decision


def _factory_cfg() -> AppConfig:
    return AppConfig(name="factory", repo="xvanov/software-factory")


def _story() -> StoryRecord:
    return StoryRecord(
        id=167,
        direction_id="011",
        app="factory",
        title="gate ux audits on available flow artifacts",
        slug="d011-gate-ux-audits",
        scope="backend",
        state=StoryState.PR_OPEN.value,
    )


def _render(call: dict[str, Any]) -> str:
    """Render the captured proposal through the REAL escalation renderer."""
    proposal = call["proposal"]
    return _build_issue_body(
        proposal,
        classification=call["classification"],
        result=call["result"],
        marker_id=_marker_id(proposal),
    )


def _run_gate(
    escalator: _CapturingEscalator,
    tmp_path: Path,
    *,
    gate: _Gate | None = None,
    patch: str | None = _SELF_EDIT_PATCH,
    pr_number: int = 178,
) -> Any:
    return _evaluate_self_edit_gate(
        app_config=_factory_cfg(),
        story=_story(),
        pr_number=pr_number,
        root=tmp_path,
        patch_provider=lambda cfg, pr: patch,
        self_edit_gate=gate
        or _Gate(decision=StagingDecision(promote=True, status="staging_validated")),
        escalate=escalator,
    )


def test_staging_failure_escalation_body_is_actionable(tmp_path: Path) -> None:
    """The #179 regression: staging refused → body must name status/reason/PR."""
    esc = _CapturingEscalator()
    decision = StagingDecision(
        promote=False,
        status="staging_rejected",
        stage_failed="pytest",
        logs_tail="3 failed, 1900 passed",
    )
    d = _run_gate(esc, tmp_path, gate=_Gate(decision=decision))

    assert d.allow is False
    assert len(esc.calls) == 1
    body = _render(esc.calls[0])

    # The concrete staging status, the reason, and the PR + story it concerns.
    assert "staging_rejected" in body
    assert "3 failed, 1900 passed" in body
    assert "#178" in body
    assert "167" in body
    assert "xvanov/software-factory" in body

    # And none of the "_(none provided)_" / "`?`" placeholders that made #179
    # useless.
    for marker in _EMPTY_MARKERS:
        assert marker not in body, f"escalation body still renders {marker!r}:\n{body}"


def test_escalation_proposal_populates_every_rendered_field(tmp_path: Path) -> None:
    """Guard the producer/renderer contract itself, field by field."""
    esc = _CapturingEscalator()
    _run_gate(
        esc,
        tmp_path,
        gate=_Gate(decision=StagingDecision(promote=False, status="staging_infra_failed")),
    )
    proposal = esc.calls[0]["proposal"]

    # Keys _build_issue_body reads. A future refactor that drops one of these
    # re-opens #179, so assert them explicitly rather than only via the body.
    assert str(proposal.get("concern_id") or "").strip()
    assert str(proposal.get("proposal_id") or "").strip()
    assert str(proposal.get("concern_title") or "").strip()
    assert str(proposal.get("diagnosis") or "").strip()
    assert str(proposal.get("escalation_reason") or "").strip()
    inner = proposal["proposal"]
    assert str(inner.get("target") or "").strip()
    assert str(inner.get("rationale") or "").strip()
    # The failure evidence is also on ``result.error``, the renderer's fallback.
    assert str((esc.calls[0]["result"] or {}).get("error") or "").strip()


def test_concern_id_is_per_pr_so_refusals_do_not_over_dedup(tmp_path: Path) -> None:
    """One escalation issue per refused PR — never one for all of them.

    ``concern_id`` is the escalation channel's preferred dedup key, so a
    constant value would silently swallow every refusal after the first.
    """
    esc = _CapturingEscalator()
    gate = _Gate(decision=StagingDecision(promote=False, status="staging_rejected"))
    _run_gate(esc, tmp_path, gate=gate, pr_number=178)
    _run_gate(esc, tmp_path, gate=gate, pr_number=179)

    ids = [c["proposal"]["concern_id"] for c in esc.calls]
    assert len(ids) == 2
    assert ids[0] != ids[1]
    assert "pr-178" in ids[0] and "pr-179" in ids[1]


def test_diff_unavailable_escalation_is_actionable(tmp_path: Path) -> None:
    """The fail-safe "cannot read the diff" refusal must also say why."""
    esc = _CapturingEscalator()
    d = _run_gate(esc, tmp_path, patch=None)

    assert d.allow is False and d.status == "diff_unavailable"
    body = _render(esc.calls[0])
    assert "diff_unavailable" in body
    assert "#178" in body
    for marker in _EMPTY_MARKERS:
        assert marker not in body


def test_forbidden_path_escalation_is_actionable(tmp_path: Path) -> None:
    """A forbidden-path refusal names the path rule and what the operator does."""
    esc = _CapturingEscalator()
    d = _run_gate(esc, tmp_path, patch=_FORBIDDEN_MANAGER_PATCH)

    assert d.allow is False and d.forbidden is True
    call = esc.calls[0]
    assert call["classification"] == "forbidden"
    body = _render(call)
    assert "forbidden" in body
    assert "factory/manager/**" in body
    assert "#178" in body
    for marker in _EMPTY_MARKERS:
        assert marker not in body


@pytest.mark.parametrize(
    ("gate", "patch", "expect_status"),
    [
        (_Gate(raises=RuntimeError("clone unreachable")), _SELF_EDIT_PATCH, "staging_infra_failed"),
        (None, "this is not a unified diff at all\n", "unparseable_diff"),
    ],
)
def test_every_refusal_path_carries_its_status(
    tmp_path: Path, gate: _Gate | None, patch: str, expect_status: str
) -> None:
    esc = _CapturingEscalator()
    d = _run_gate(esc, tmp_path, gate=gate, patch=patch)
    assert d.allow is False
    assert len(esc.calls) == 1
    assert esc.calls[0]["proposal"]["staging_status"] == expect_status
    assert expect_status in _render(esc.calls[0])
