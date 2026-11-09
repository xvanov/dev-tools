"""Job kinds and runtimes (docs/JOBS-API.md v1.2).

* ``kind`` — what the job delivers. ``code`` is a direction → stories → PRs
  (v1). ``research`` and ``report`` deliver a markdown REPORT the factory keeps
  (:mod:`factory.jobs.tasks`); no issue, branch or PR. ``plan`` (v1.8) is the
  same, READ-ONLY: the agent writes an implementation plan and changes nothing
  (on ``claude_session`` Claude Code runs in its ``plan`` permission mode).
* ``runtime`` — who does the agent work. ``api`` is the factory's own model
  routing (LiteLLM keys, ``routes.yaml``). ``claude_session`` is the Claude Code
  CLI on the factory machine, on the operator's subscription
  (:mod:`factory.claude_session`).

Pure vocabulary + validation; no I/O.
"""

from __future__ import annotations

KIND_CODE = "code"
KIND_RESEARCH = "research"
KIND_REPORT = "report"
KIND_PLAN = "plan"
KINDS: tuple[str, ...] = (KIND_CODE, KIND_RESEARCH, KIND_REPORT, KIND_PLAN)
#: Kinds whose deliverable is a report kept by the factory (no PR).
TASK_KINDS: frozenset[str] = frozenset({KIND_RESEARCH, KIND_REPORT, KIND_PLAN})
#: Kinds whose agent may not change anything: on ``claude_session`` the run
#: starts in Claude Code's ``plan`` permission mode instead of skipping
#: permissions, so a write is refused by Claude Code, not by a prompt.
READ_ONLY_KINDS: frozenset[str] = frozenset({KIND_PLAN})
#: The Claude Code permission mode a read-only run starts in.
READ_ONLY_PERMISSION_MODE = "plan"

RUNTIME_API = "api"
RUNTIME_CLAUDE = "claude_session"
RUNTIMES: tuple[str, ...] = (RUNTIME_API, RUNTIME_CLAUDE)

#: ``--model claude_session=<name>`` names the Claude model for a
#: claude_session run. It is not a persona and not a ``<provider>/<model>``
#: LiteLLM id, so submit takes it out of the ``models:`` map.
CLAUDE_MODEL_KEY = "claude_session"

#: Billing of a run row: API keys (counted by the spend caps) or the operator's
#: Claude subscription (never counted; reported as ``subscription_equiv_usd``).
BILLING_METERED = "metered"
BILLING_SUBSCRIPTION = "subscription"


def normalize_kind(raw: str | None) -> str | None:
    """``None``/empty → ``code``; a known kind → itself; anything else → ``None``."""
    value = (raw or KIND_CODE).strip().lower()
    return value if value in KINDS else None


def normalize_runtime(raw: str | None) -> str | None:
    """``None``/empty → ``api``; a known runtime → itself; anything else → ``None``."""
    value = (raw or RUNTIME_API).strip().lower()
    return value if value in RUNTIMES else None


def billing_for(runtime: str | None) -> str:
    return BILLING_SUBSCRIPTION if runtime == RUNTIME_CLAUDE else BILLING_METERED


def split_claude_model(flags: list[str]) -> tuple[list[str], str | None]:
    """Pull ``claude_session=<name>`` out of the ``--model`` flags.

    Returns ``(remaining_flags, claude_model)``. A repeated ``claude_session``
    key is left in the remaining flags so the normal parser refuses it as a
    duplicate (``bad_model_flag``) rather than this function picking one.
    """
    rest: list[str] = []
    found: list[str] = []
    for raw in flags:
        key, sep, value = (raw or "").partition("=")
        if sep and key.strip() == CLAUDE_MODEL_KEY:
            found.append(value.strip())
        else:
            rest.append(raw)
    if len(found) > 1:
        return rest + [f"{CLAUDE_MODEL_KEY}={v}" for v in found], None
    return rest, (found[0] or None) if found else None


__all__ = [
    "BILLING_METERED",
    "BILLING_SUBSCRIPTION",
    "CLAUDE_MODEL_KEY",
    "KINDS",
    "KIND_CODE",
    "KIND_PLAN",
    "KIND_REPORT",
    "KIND_RESEARCH",
    "READ_ONLY_KINDS",
    "READ_ONLY_PERMISSION_MODE",
    "RUNTIMES",
    "RUNTIME_API",
    "RUNTIME_CLAUDE",
    "TASK_KINDS",
    "billing_for",
    "normalize_kind",
    "normalize_runtime",
    "split_claude_model",
]
