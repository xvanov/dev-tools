"""factory.manager.escalation — make L4 escalations VISIBLE (Tier 3 WS3.1).

The silent-sink problem
-----------------------
Before this module, a manager proposal classified ``escalate_to_human`` or
``forbidden`` died silently in ``state/.manager_apply_history.json``. The FMS
*detected* a real problem, *decided* it needed a human, and then told no human:
no issue, no alert, nothing an operator would ever see. The escalation path was
a ``/dev/null``. Given the FMS escalates ~66% of proposals, that is the single
biggest hole in Ceiling B.

What this closes
----------------
Every escalation now, best-effort:

  1. **Opens a GitHub issue** on the factory repo (``gh issue create`` via the
     injected runner), labelled ``fms-escalation``, whose body carries the
     concern, the proposed action, why it escalated, and the failure evidence.
  2. Is **idempotent** on the proposal's stable ids (``concern_id`` /
     ``proposal_id`` from WS2.2): a re-fired escalation for the same concern
     does NOT open a duplicate issue while one is still OPEN. The dedup
     AUTHORITY is the OPEN-state of the tracking issue on GitHub (a best-effort
     search of open ``fms-escalation`` issues for the id marker); the local
     notification ledger is only a FALLBACK for when gh cannot be consulted.
     This ordering is deliberate: a concern whose issue a human closed/resolved
     and which then recurs MUST be able to re-escalate — so the never-expiring
     local ledger must not permanently suppress it. Anti-spam holds because no
     second issue is opened while one is OPEN for that id.
  3. Emits a loud ``write_alert_event`` so the escalation is visible on the
     alert stream even if ``gh`` is unavailable.

Best-effort contract
--------------------
A ``gh`` failure (missing binary, auth, rate limit, network) MUST NOT crash the
L4 apply cycle — every shell-out is wrapped and swallowed to a logged outcome.
But it must never be *invisible*: the alert event is emitted regardless of
whether the issue could be opened, and a gh failure is itself recorded on the
outcome (and the alert) so an operator/FMS can see the notifier degraded.
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from factory.manager.signals import write_alert_event, write_event

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: GitHub label applied to every escalation issue (used for dedup search too).
ESCALATION_LABEL = "fms-escalation"

#: Structured event stream for escalation-notification outcomes.
ESCALATION_STREAM = "manager_escalation"

#: Local dedup ledger — records the stable ids we have already notified for so
#: a re-emitted escalation (same concern, fresh proposal file) does not spam a
#: new issue every cycle. Lives alongside ``.manager_apply_history.json``.
_ESCALATION_HISTORY = ".manager_escalation_history.json"

Runner = Callable[..., "subprocess.CompletedProcess[str]"]

_GH_TIMEOUT_S = 60


# ---------------------------------------------------------------------------
# Stable-id helpers (dedup keys)
# ---------------------------------------------------------------------------


def _stable_ids(proposal: dict[str, Any]) -> tuple[str, str]:
    """Return ``(concern_id, proposal_id)`` as strings ("" when absent).

    ``concern_id`` is preferred as the dedup key because multiple proposals
    (fresh ``proposal_id`` each) can be generated for the SAME concern — we want
    one escalation issue per concern, not one per re-emitted proposal.
    """
    concern_id = str(proposal.get("concern_id", "") or "")
    proposal_id = str(proposal.get("proposal_id", "") or "")
    return concern_id, proposal_id


def _marker_id(proposal: dict[str, Any]) -> str:
    """The single stable id used for the issue-body marker + gh search.

    Prefers ``concern_id`` (broadest — one issue per concern), then
    ``proposal_id``, then a slug of the concern title as a last resort.
    """
    concern_id, proposal_id = _stable_ids(proposal)
    if concern_id:
        return concern_id
    if proposal_id:
        return proposal_id
    return str(proposal.get("concern_title", "unknown") or "unknown")[:80]


def _issue_marker(marker_id: str) -> str:
    """HTML-comment marker embedded in the issue body for gh-side dedup."""
    return f"<!-- fms-escalation:{marker_id} -->"


# ---------------------------------------------------------------------------
# Local dedup ledger
# ---------------------------------------------------------------------------


def _history_path(root: Path) -> Path:
    return Path(root) / "state" / _ESCALATION_HISTORY


def _load_history(root: Path) -> list[dict[str, Any]]:
    p = _history_path(root)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return []


def _append_history(root: Path, entry: dict[str, Any]) -> None:
    history = _load_history(root)
    history.append(entry)
    p = _history_path(root)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(history, indent=2, default=str), encoding="utf-8")
    except OSError as exc:
        print(f"[manager.escalation] WARNING: failed to write history: {exc}", file=sys.stderr)


def _already_notified(root: Path, concern_id: str, proposal_id: str) -> dict[str, Any] | None:
    """Return the prior notification entry if this escalation was already sent.

    Mirrors ``apply._is_already_processed``: match on the stable ``concern_id``
    first (recognises a re-emitted proposal for the same concern), then on
    ``proposal_id`` (exact) as a fallback.
    """
    for entry in _load_history(root):
        if concern_id and entry.get("concern_id") == concern_id:
            return entry
        if proposal_id and entry.get("proposal_id") == proposal_id:
            return entry
    return None


# ---------------------------------------------------------------------------
# Issue body / gh plumbing
# ---------------------------------------------------------------------------


def _build_issue_title(proposal: dict[str, Any], classification: str) -> str:
    concern_title = str(proposal.get("concern_title", "unknown") or "unknown")
    prefix = "[fms-escalation]" if classification == "escalate_to_human" else "[fms-forbidden]"
    title = f"{prefix} {concern_title}"
    if len(title) > 256:
        title = title[:253] + "..."
    return title


def _build_issue_body(
    proposal: dict[str, Any],
    *,
    classification: str,
    result: dict[str, Any] | None,
    marker_id: str,
) -> str:
    concern_id, proposal_id = _stable_ids(proposal)
    inner = proposal.get("proposal", {})
    inner = inner if isinstance(inner, dict) else {}
    diagnosis = str(proposal.get("diagnosis", "") or "").strip()
    rationale = str(inner.get("rationale", "") or "").strip()
    target = str(inner.get("target", "") or "").strip()
    patch = str(inner.get("suggested_patch", "") or "").strip()
    reason = str(
        proposal.get("escalation_reason")
        or (result or {}).get("error")
        or ""
    ).strip()

    # Contract-mismatch guard (issue #179): a producer that populates fields
    # under keys this renderer doesn't read (rather than the ones above)
    # otherwise yields an issue that says only "?" / "(none provided)"
    # everywhere — visible, but worthless. When every field we know how to
    # render came back empty, the escalation is not actually contentless (the
    # caller passed SOMETHING, or it would never have gotten this far) — the
    # renderer just doesn't recognise the keys. Dump the raw payload verbatim
    # so a human can still see what was passed, instead of losing it.
    is_contract_mismatch = not (concern_id or diagnosis or rationale or target or reason)

    why = (
        "The proposal explicitly requested human escalation."
        if classification == "escalate_to_human"
        else (
            "The proposal was classified FORBIDDEN by the deterministic L4 gate "
            "(it touches a protected path, is not a valid unified diff, or has no "
            "applicable safe target) and can never be auto-applied."
        )
    )

    lines = [
        "Auto-generated by the Factory Management System (L4 escalation channel).",
        "",
        f"- classification: **{classification}**",
        f"- concern_id: `{concern_id or '?'}`",
        f"- proposal_id: `{proposal_id or '?'}`",
        f"- target: `{target or '?'}`",
        "",
        "### Why this escalated",
        "",
        why,
    ]
    if reason:
        lines += ["", f"**Escalation reason / failure evidence:** {reason}"]
    lines += ["", "### Concern / diagnosis", "", diagnosis or "_(none provided)_"]
    lines += ["", "### Proposed action", "", rationale or "_(none provided)_"]
    if patch:
        lines += ["", "### Suggested patch", "", "```diff", patch, "```"]
    if is_contract_mismatch:
        lines += [
            "",
            "### ⚠️ Renderer/producer contract mismatch",
            "",
            "Every field above is empty, but the escalation still fired — the "
            "producer likely populated this proposal under keys this renderer "
            "does not read. Raw payload, so nothing is silently lost:",
            "",
            "```json",
            json.dumps({"proposal": proposal, "result": result or {}}, indent=2, default=str),
            "```",
        ]
    lines += [
        "",
        "---",
        "_Maintained by the FMS escalation channel. One issue per concern; "
        "re-emitted escalations update rather than duplicate._",
        "",
        _issue_marker(marker_id),
    ]
    return "\n".join(lines)


def _gh(
    args: list[str],
    *,
    runner: Runner,
    timeout: int = _GH_TIMEOUT_S,
) -> subprocess.CompletedProcess[str] | None:
    """Run a ``gh`` command via the runner, swallowing every failure to ``None``.

    A ``None`` return means "could not determine / call failed" — the caller
    treats it as uncertain and never crashes on it.
    """
    try:
        return runner(args, capture_output=True, text=True, check=False, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - best-effort; never crash L4
        print(f"[manager.escalation] gh call failed {args[:3]}: {exc!r}", file=sys.stderr)
        return None


def _open_issue_lookup(
    repo: str,
    marker_id: str,
    *,
    runner: Runner,
) -> tuple[str, int | None]:
    """Best-effort lookup of an OPEN fms-escalation issue carrying this id.

    Returns one of:
      ``("found", <number>)``  — an OPEN issue for this id exists → dedup.
      ``("none", None)``       — gh answered AND no OPEN issue exists. This is
                                 AUTHORITATIVE: a previously-escalated concern
                                 whose issue was closed/resolved is allowed to
                                 re-escalate (the ``--state open`` filter makes a
                                 closed issue invisible here on purpose).
      ``("uncertain", None)``  — gh could not be consulted (missing binary,
                                 auth, rate limit, unparseable output). The
                                 caller falls back to the local ledger; it must
                                 NOT treat this as "no open issue".

    The three-way return is the fix for over-dedup: the never-expiring local
    ledger must not permanently suppress a genuinely-recurring concern, so the
    OPEN-state of the issue on GitHub — not the local ledger — is the authority
    whenever gh is reachable.
    """
    proc = _gh(
        [
            "gh", "issue", "list",
            "--repo", repo,
            "--state", "open",
            "--label", ESCALATION_LABEL,
            "--search", marker_id,
            "--json", "number,body",
            "--limit", "50",
        ],
        runner=runner,
    )
    if proc is None or proc.returncode != 0:
        return ("uncertain", None)
    try:
        rows = json.loads(proc.stdout or "[]")
    except (json.JSONDecodeError, TypeError):
        return ("uncertain", None)
    if not isinstance(rows, list):
        return ("uncertain", None)
    marker = _issue_marker(marker_id)
    for row in rows:
        if not isinstance(row, dict):
            continue
        if marker in str(row.get("body", "")):
            num = row.get("number")
            if isinstance(num, int):
                return ("found", num)
    return ("none", None)


def _ensure_label(repo: str, *, runner: Runner) -> None:
    """Best-effort: make sure the fms-escalation label exists (idempotent)."""
    _gh(
        [
            "gh", "label", "create", ESCALATION_LABEL,
            "--repo", repo,
            "--color", "B60205",
            "--description", "FMS escalation requiring human review",
            "--force",
        ],
        runner=runner,
        timeout=30,
    )


def _create_issue(
    repo: str,
    *,
    title: str,
    body: str,
    runner: Runner,
) -> int | None:
    """Best-effort ``gh issue create``. Returns the new issue number or None."""
    _ensure_label(repo, runner=runner)
    proc = _gh(
        [
            "gh", "issue", "create",
            "--repo", repo,
            "--title", title,
            "--body", body,
            "--label", ESCALATION_LABEL,
        ],
        runner=runner,
    )
    if proc is None or proc.returncode != 0:
        return None
    # gh prints the new issue URL on stdout, e.g. https://github.com/o/r/issues/12
    import re

    m = re.search(r"/issues/(\d+)", proc.stdout or "")
    if m:
        return int(m.group(1))
    return None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def notify_escalation(
    proposal: dict[str, Any],
    *,
    root: Path,
    repo: str | None,
    classification: str,
    result: dict[str, Any] | None = None,
    runner: Runner | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Surface an escalated/forbidden proposal to a human. Best-effort.

    Always emits a ``write_alert_event`` (visible regardless of gh) on the FIRST
    notification for a given concern/proposal id. Opens (idempotently) a GitHub
    issue on ``repo`` when a repo is known and gh is reachable. Never raises —
    any failure is logged, recorded on the returned outcome, and the alert still
    makes the escalation visible.

    Returns an outcome dict:
      ``{notified, deduped, issue_number, gh_ok, reason}``.
    """
    runner = runner or subprocess.run
    assert runner is not None
    now = now or datetime.now(UTC)
    root = Path(root)

    concern_id, proposal_id = _stable_ids(proposal)
    marker_id = _marker_id(proposal)
    concern_title = str(proposal.get("concern_title", "unknown") or "unknown")

    outcome: dict[str, Any] = {
        "notified": False,
        "deduped": False,
        "issue_number": None,
        "gh_ok": None,
        "reason": None,
    }

    def _emit_deduped(issue_number: int | None, reason: str) -> dict[str, Any]:
        outcome["deduped"] = True
        outcome["issue_number"] = issue_number
        outcome["reason"] = reason
        try:
            write_event(
                ESCALATION_STREAM,
                {
                    "event": "escalation_deduped",
                    "concern_id": concern_id,
                    "proposal_id": proposal_id,
                    "classification": classification,
                    "issue_number": issue_number,
                    "reason": reason,
                },
                software_factory_root=root,
            )
        except Exception:  # noqa: BLE001
            pass
        return outcome

    # 1. Dedup decision. GitHub OPEN-state is the AUTHORITY when reachable; the
    #    local ledger is only a fallback for when gh cannot be consulted. This
    #    is the anti-over-dedup fix: the never-expiring local ledger must NOT
    #    permanently suppress a concern whose issue was closed/resolved and then
    #    recurred. Anti-spam property preserved: while an OPEN issue exists for
    #    this id we never open a second one (and don't re-alert).
    gh_status = "uncertain"
    gh_open_number: int | None = None
    if repo:
        gh_status, gh_open_number = _open_issue_lookup(repo, marker_id, runner=runner)

    if gh_status == "found":
        # An OPEN issue already tracks this concern → dedup (no new issue, no
        # repeat alert), regardless of what the local ledger says.
        return _emit_deduped(gh_open_number, "existing_open_issue")

    if gh_status == "uncertain" or not repo:
        # gh could not answer (down / no repo). Fall back to the local ledger to
        # keep the anti-spam property when we cannot see GitHub — but note this
        # is a FALLBACK, not the primary gate: when gh IS reachable and reports
        # no open issue ("none"), we deliberately IGNORE the ledger and allow a
        # resolved-then-recurring concern to re-escalate below.
        prior = _already_notified(root, concern_id, proposal_id)
        if prior is not None:
            return _emit_deduped(prior.get("issue_number"), "already_notified_local")

    # gh_status == "none" (authoritative: no OPEN issue — first time OR the prior
    # issue was resolved and the concern recurred), or gh was uncertain / had no
    # repo and the local ledger is also clear → genuinely (re-)escalate.

    # 2. Loud alert — guaranteed visible even if gh is down or repo is unknown.
    try:
        write_alert_event(
            "fms_escalation",
            f"L4 {classification} for {concern_title!r} needs a human "
            f"(concern_id={concern_id or '?'}, proposal_id={proposal_id or '?'}).",
            severity="warning" if classification == "escalate_to_human" else "error",
            software_factory_root=root,
            concern_id=concern_id,
            proposal_id=proposal_id,
            classification=classification,
        )
    except Exception as exc:  # noqa: BLE001 - alerting is best-effort
        print(f"[manager.escalation] alert emit failed: {exc!r}", file=sys.stderr)

    # 3. Open (idempotently) a GitHub issue — only when we know the repo.
    issue_number: int | None = None
    gh_ok: bool | None = None
    reason: str | None = None

    if not repo:
        reason = "no_repo"
    else:
        # The "found" (open issue exists) case already returned above via the
        # dedup gate, so here we know there is no OPEN issue to reuse — create a
        # fresh one. (A resolved-then-recurring concern lands here with
        # gh_status == "none" and gets a NEW issue, which is the intended
        # re-escalation.)
        title = _build_issue_title(proposal, classification)
        body = _build_issue_body(
            proposal,
            classification=classification,
            result=result,
            marker_id=marker_id,
        )
        issue_number = _create_issue(repo, title=title, body=body, runner=runner)
        gh_ok = issue_number is not None
        if not gh_ok:
            reason = "gh_create_failed"
            # A gh failure must be VISIBLE, not silent.
            try:
                write_alert_event(
                    "fms_escalation_gh_failed",
                    f"could not open escalation issue for {concern_title!r} "
                    f"on {repo}; escalation recorded on the alert stream only.",
                    severity="error",
                    software_factory_root=root,
                    concern_id=concern_id,
                    proposal_id=proposal_id,
                )
            except Exception:  # noqa: BLE001
                pass

    outcome["notified"] = True
    outcome["issue_number"] = issue_number
    outcome["gh_ok"] = gh_ok
    outcome["reason"] = reason

    # 4. Record locally so the NEXT cycle dedups (even on a gh failure — we
    #    still alerted, and we don't want to re-alert every cycle).
    _append_history(
        root,
        {
            "concern_id": concern_id,
            "proposal_id": proposal_id,
            "classification": classification,
            "issue_number": issue_number,
            "gh_ok": gh_ok,
            "reason": reason,
            "ts": now.isoformat(),
        },
    )

    # 5. Structured outcome event.
    try:
        write_event(
            ESCALATION_STREAM,
            {
                "event": "escalation_notified",
                "concern_id": concern_id,
                "proposal_id": proposal_id,
                "classification": classification,
                "issue_number": issue_number,
                "gh_ok": gh_ok,
                "reason": reason,
            },
            software_factory_root=root,
        )
    except Exception:  # noqa: BLE001
        pass

    return outcome


__all__ = [
    "ESCALATION_LABEL",
    "ESCALATION_STREAM",
    "notify_escalation",
]
