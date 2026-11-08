"""Agent sandbox per run (native plan 5.2) and the credential broker (5.3).

* :mod:`factory.sandbox.broker` — a process OUTSIDE the sandbox that holds the
  GitHub credentials and does the run's pushes and PRs, checked against the
  run's delivery ceiling. The sandboxed agent gets the broker's address and a
  per-run capability, never a token.
* :mod:`factory.sandbox.proxy` — the egress allowlist proxy (HTTP CONNECT).
* :mod:`factory.sandbox.policy` / :mod:`factory.sandbox.exec` — the OS sandbox
  a run's agent process is started in (bubblewrap on Linux, a restricted token
  in a job object on Windows).
* :mod:`factory.sandbox.host` — starts the broker and proxy for one run.

Everything here is stdlib only (plus :mod:`factory.gh_auth`), so the personal
assistant can start it with the factory's interpreter for its own sessions.
Off unless ``FACTORY_SANDBOX=on`` (factory runs) / ``PA_SANDBOX=on`` (PA
dispatch sessions).
"""

from __future__ import annotations

import os

#: The ceilings an agent may act at through the broker (least -> most).
CEILINGS = ("none", "push_branch", "draft_pr")


def enabled(var: str = "FACTORY_SANDBOX") -> bool:
    """True when the flag ``var`` is ``on`` (also ``1``/``true``). Default off."""
    return os.environ.get(var, "off").strip().lower() in ("on", "1", "true", "yes")


def ceiling_for_mode(mode: str | None) -> str:
    """The broker ceiling for a PA session mode (``src/dispatch/modes.js``).

    ``local`` and ``plan`` push nothing; ``branch`` pushes a branch; ``mr`` /
    ``full`` open a draft PR. Anything else is ``none`` (fail safe).
    """
    return {"branch": "push_branch", "mr": "draft_pr", "full": "draft_pr"}.get(
        str(mode or "").strip().lower(), "none"
    )


def ceiling_for_delivery(level: str | None) -> str:
    """The broker ceiling for a delivery level (``factory.delivery``).

    What the AGENT may do itself; the rest of the end state (marking ready,
    merging, the fast-forward of ``push_to_main``) is done by the factory or
    the PA outside the sandbox. Mirrors the PA's ``MODE_BY_DELIVERY``.
    """
    mode = {
        "none": "local",
        "branch": "branch",
        "draft_pr": "mr",
        "pr": "mr",
        "auto_merge": "mr",
        "push_to_main": "local",
    }.get(str(level or "").strip().lower())
    return ceiling_for_mode(mode)
