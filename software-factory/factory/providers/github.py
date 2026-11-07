"""GitHub credential resolution.

The factory uses a single token for every GitHub API call (issues, PR review,
direction tracking, etc.). Operators can supply it in three ways, in this
precedence order:

  1. ``GITHUB_TOKEN`` env var (CI-conventional name; what GitHub Actions sets).
  2. ``GH_TOKEN`` env var (alternative name the ``gh`` CLI also reads).
  3. Shell out to ``gh auth token`` — if the operator is logged in via
     ``gh auth login``, this prints the stored OAuth token to stdout.

Returns ``None`` if none of the three yield a value. Callers should surface a
clear "log in with gh auth login" error to the operator.

Why a dedicated module:

* The fallback chain is now non-trivial (env → env → subprocess).
* The chain is tested with monkeypatched env + subprocess.
* The same resolver will be reused by future providers (e.g. a webhook
  process that needs a token to post a review comment).
"""

from __future__ import annotations

import os
import subprocess
from typing import Any


def resolve_github_token() -> str | None:
    """Return a GitHub API token following the documented precedence chain.

    Precedence:
      1. ``GITHUB_TOKEN`` env var.
      2. ``GH_TOKEN`` env var.
      3. ``gh auth token`` (subprocess) — only invoked if the first two miss.

    The subprocess call is bounded by a short timeout so a broken / hung ``gh``
    binary cannot wedge the CLI startup. A non-zero exit or any exception
    from the subprocess silently falls through to ``None`` — the caller is
    responsible for producing a human-readable error message.
    """
    for env_name in ("GITHUB_TOKEN", "GH_TOKEN"):
        val = os.environ.get(env_name)
        if val:
            return val.strip() or None

    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    token = result.stdout.strip()
    return token or None


def build_github_client() -> Any | None:
    """Construct a ``pygithub.Github`` client, best-effort.

    Returns ``None`` when no token is available (see ``resolve_github_token``)
    instead of raising. This is the shared client-construction path for
    non-interactive callers — e.g. the deploy chain's issue-closing
    bookkeeping (``factory/chain/handlers.py::_close_issues_on_deploy``) —
    that must never crash their caller just because no GitHub token is
    configured. Interactive callers (the CLI) should prefer a wrapper that
    surfaces a clear error instead of silently returning ``None``; see
    ``factory.cli._ensure_github_client``.
    """
    token = resolve_github_token()
    if not token:
        return None
    from github import Github

    return Github(token)
