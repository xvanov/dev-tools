"""Automatic intake of user-filed GitHub issues → directions.

The factory already turns a labelled issue into a direction on demand
(``factory ingest-issue`` → ``ingester.ingest_github_direction_issue``). This
module makes that AUTOMATIC and always-on: every tick, open issues carrying
the intake label (default ``user-report``) that haven't been ingested yet are
converted into directions, then the tick's existing ``auto_pm_sync`` pass
triages them into stories. A user files an issue; the running factory picks it
up, decomposes it, implements it, and opens a PR — no operator step.

Dedup is idempotent via a per-issue label: on successful ingest we add
``accepted_label`` (default ``intake-accepted``) and post a back-link comment,
and issues already carrying it are skipped. The intake ``label`` convention
also keeps the factory's OWN ``direction-tracker`` / ``story`` issues out of
intake — only issues a human explicitly tags flow in.

Mirrors ``pm_sync.maybe_auto_pm_sync`` in shape so the tick hook is uniform.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class IntakeSummary:
    accepted: list[int] = field(default_factory=list)  # issue numbers ingested
    skipped: int = 0  # already-accepted issues seen
    errors: list[tuple[int, str]] = field(default_factory=list)


def maybe_auto_intake(
    app: str,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    github_client_factory: Any = None,
) -> tuple[IntakeSummary | None, str]:
    """Ingest new user-reported issues into directions.

    Returns ``(summary, reason)``. ``summary`` is None (with a reason string)
    when intake did no work: ``disabled``, ``dry_run`` (no GH in dry-run),
    ``no_client``, or ``no_new_issues``.
    """
    from factory.settings.loader import load_settings

    cfg = load_settings(software_factory_root).auto_intake
    if not cfg.enabled:
        return None, "disabled"
    if dry_run:
        return None, "dry_run"
    if github_client_factory is None:
        return None, "no_client"

    from factory.app_config import load_app_config
    from factory.directions.ingester import ingest_github_direction_issue

    repo_full = load_app_config(app, software_factory_root).repo
    client = github_client_factory()
    repo = client.get_repo(repo_full)

    summary = IntakeSummary()
    # Newest first so a burst is drained oldest-later; bounded per tick.
    candidates = list(repo.get_issues(state="open", labels=[cfg.label]))
    for issue in candidates:
        label_names = {getattr(lbl, "name", "") for lbl in (issue.labels or [])}
        if cfg.accepted_label in label_names:
            summary.skipped += 1
            continue
        if len(summary.accepted) >= cfg.max_per_tick:
            break
        num = int(issue.number)
        try:
            direction = ingest_github_direction_issue(
                num, app, software_factory_root, client, repo_full_name=repo_full
            )
            # Mark accepted so the next tick skips it, and back-link the
            # direction so the reporter can follow the work.
            try:
                issue.add_to_labels(cfg.accepted_label)
                issue.create_comment(
                    f"🏭 Accepted into the factory as direction "
                    f"`{direction.id_slug}`. It will be triaged into "
                    f"stories and implemented automatically; watch this issue "
                    f"for the resulting PR."
                )
            except Exception:  # labelling/comment failure must not undo intake
                pass
            summary.accepted.append(num)
        except Exception as exc:  # one bad issue must not block the rest
            summary.errors.append((num, repr(exc)[:200]))

    if not summary.accepted and not summary.errors and summary.skipped == 0:
        return None, "no_new_issues"
    return summary, "ok"
