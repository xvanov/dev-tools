"""Where an app's work is tracked: GitHub Issues or the factory's own DB.

Operator decision 2026-11-09 (binding, docs/native/PLAN.md decision log): the
factory must work WITHOUT GitHub Issues, and a repo whose owner is not one of
the operator's PERSONAL owners must never have an issue created, commented,
labelled or closed on it. Personal repos may keep issue-based tracking.

Two trackers, set per app (``apps/<app>/config.yaml::tracker``):

* ``github_issues`` — the historical behaviour: one tracker issue per
  direction, one issue per story, the pinned ``[FACTORY] <app> live status``
  issue, the p0 deploy-regression issue, ``user-report`` intake.
* ``local`` — the same facts kept in ``state/factory.db`` (tables
  ``tracker_items`` + ``tracker_notes``, created on first use) and surfaced by
  ``factory job status`` (``tracker``), ``factory why``, ``factory inbox`` and
  the PA's Build page. Nothing is sent to GitHub Issues. A story's identity
  (branch, worktree, story file) is its own story id, never an issue number.

Resolution, :func:`configured_tracker`: an explicit ``tracker:`` in the app's
config wins; absent, a repo owned by a personal owner gets ``github_issues``
and EVERY other repo gets ``local`` (fail safe: an owner we cannot classify is
not personal). The one thing config cannot do is give a non-personal repo
``github_issues``: ``factory app add/set`` refuse it, and a hand edit is
downgraded to ``local`` with a warning.

Personal owners: ``FACTORY_PERSONAL_OWNERS`` (comma list) when set, else the
built-in owners of ``gh_auth.DEFAULT_OWNER_MAP`` (today ``xvanov``). Not the
whole ``FACTORY_GH_OWNER_MAP``: that map also carries WORK owners (it picks a
token per owner), so "has a token mapping" does not mean "personal".

Defence in depth, :func:`effective_tracker`: even an app configured for
``github_issues`` falls back to ``local`` (with a warning) when its repo
reports ``has_issues: false``, or when a create fails with GitHub's
"Issues has been disabled" 410. A misconfigured app must never wedge the
pipeline on a disabled feature (live 2026-11-09: job raven:001 looped in
pm-sync on exactly that 410, paying for a PM run every tick).
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

TrackerName = Literal["github_issues", "local"]
GITHUB_ISSUES: TrackerName = "github_issues"
LOCAL: TrackerName = "local"
TRACKER_NAMES: tuple[str, ...] = (GITHUB_ISSUES, LOCAL)

#: Item kinds kept in ``tracker_items``. ``ref`` is the direction id, the
#: story id, ``live`` for the status item, or a signature for an escalation.
KIND_DIRECTION = "direction"
KIND_STORY = "story"
KIND_STATUS = "status"
KIND_ESCALATION = "escalation"

_logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Policy
# --------------------------------------------------------------------------- #


def personal_owners() -> frozenset[str]:
    """Lower-cased GitHub owners whose repos may use GitHub Issues by default."""
    raw = os.environ.get("FACTORY_PERSONAL_OWNERS")
    if raw is not None and raw.strip():
        return frozenset(p.strip().lower() for p in raw.split(",") if p.strip())
    from factory.gh_auth import DEFAULT_OWNER_MAP

    return frozenset(k.lower() for k in DEFAULT_OWNER_MAP)


def is_personal_repo(repo: str | None) -> bool:
    """True when ``repo``'s owner is one of the operator's personal owners."""
    from factory.gh_auth import repo_owner

    owner = repo_owner(repo)
    return bool(owner and owner.lower() in personal_owners())


def default_tracker(repo: str | None) -> TrackerName:
    """``github_issues`` for a personal owner's repo, ``local`` for anything else."""
    return GITHUB_ISSUES if is_personal_repo(repo) else LOCAL


def parse_tracker(value: str | None) -> TrackerName | None:
    """Validate a ``--tracker`` value; ``None``/empty -> ``None``."""
    if value is None or not str(value).strip():
        return None
    v = str(value).strip().lower().replace("-", "_")
    if v in ("github", "issues"):
        v = GITHUB_ISSUES
    if v not in TRACKER_NAMES:
        raise ValueError(f"tracker must be one of {', '.join(TRACKER_NAMES)} (got {value!r})")
    return v  # type: ignore[return-value]


def configured_tracker(app_config: Any) -> TrackerName:
    """The app's tracker from config alone (explicit value, else derived).

    An explicit value wins with ONE exception, the binding rule itself: a
    non-personal repo never gets ``github_issues``, even when its config says
    so (``factory app add/set`` refuse to write that; a hand edit is
    downgraded here, with a warning, rather than obeyed).
    """
    explicit = getattr(app_config, "tracker", None)
    repo = getattr(app_config, "repo", None)
    if explicit == LOCAL:
        return LOCAL
    if explicit == GITHUB_ISSUES:
        if is_personal_repo(repo):
            return GITHUB_ISSUES
        _warn_once(str(repo or "?"), "not a personal repo; `tracker: github_issues` ignored")
        return LOCAL
    return default_tracker(repo)


def check_tracker_allowed(repo: str | None, tracker: str | None) -> None:
    """Raise ``ValueError`` when ``tracker`` may not be set for ``repo``."""
    if tracker == GITHUB_ISSUES and not is_personal_repo(repo):
        raise ValueError(
            f"{repo} is not a personal repo (personal owners: "
            f"{', '.join(sorted(personal_owners())) or 'none'}); only `tracker: local` is "
            "allowed — non-personal projects never use GitHub Issues"
        )


def tracker_source(app_config: Any) -> str:
    """``config`` when the app sets ``tracker:``, else ``derived``."""
    return "config" if getattr(app_config, "tracker", None) in TRACKER_NAMES else "derived"


# Process-wide memo of "does this repo have Issues enabled": {repo: (bool, ts)}.
# Long-running ``factory serve`` re-checks after the TTL; a disabled verdict
# learned from a 410 is recorded here too.
_ISSUES_ENABLED: dict[str, tuple[bool, float]] = {}
_ISSUES_TTL_S = 3600.0
_WARNED: set[str] = set()


def _warn_once(repo: str, why: str) -> None:
    key = repo.lower()
    if key in _WARNED:
        return
    _WARNED.add(key)
    _logger.warning(
        "GitHub Issues unavailable on %s (%s): tracking this app locally in "
        "state/factory.db instead. Set `tracker: local` in its config to silence this.",
        repo,
        why,
    )


def mark_issues_disabled(repo: str, why: str = "issues disabled") -> None:
    """Record that ``repo`` has Issues disabled (e.g. after a 410)."""
    _ISSUES_ENABLED[repo.lower()] = (False, time.monotonic())
    _warn_once(repo, why)


def reset_cache() -> None:
    """Forget every memoised verdict (tests)."""
    _ISSUES_ENABLED.clear()
    _WARNED.clear()


def issues_enabled(github_client: Any, repo: str) -> bool | None:
    """``False`` when GitHub says ``repo`` has Issues disabled; ``None`` when
    unknown (no client, lookup failed); ``True`` otherwise. Never raises."""
    key = (repo or "").lower()
    hit = _ISSUES_ENABLED.get(key)
    if hit is not None and time.monotonic() - hit[1] < _ISSUES_TTL_S:
        return hit[0]
    if github_client is None or not repo:
        return None
    try:
        gh_repo = github_client.get_repo(repo)
        flag = getattr(gh_repo, "has_issues", None)
    except Exception:  # noqa: BLE001 - unknown, decided by the caller
        return None
    if flag is False:
        mark_issues_disabled(repo, "repo has_issues=false")
        return False
    if flag is True:
        _ISSUES_ENABLED[key] = (True, time.monotonic())
        return True
    return None  # a duck-typed client without the attribute: unknown


def effective_tracker(app_config: Any, github_client: Any = None) -> TrackerName:
    """The tracker to USE now: the configured one, downgraded to ``local`` when
    the repo has Issues disabled. Never upgrades ``local``."""
    configured = configured_tracker(app_config)
    if configured == LOCAL:
        return LOCAL
    repo = getattr(app_config, "repo", None) or ""
    if issues_enabled(github_client, repo) is False:
        return LOCAL
    return GITHUB_ISSUES


def uses_github_issues(app_config: Any, github_client: Any = None) -> bool:
    """True only when this app may touch GitHub Issues right now."""
    if app_config is None:
        return False
    return effective_tracker(app_config, github_client) == GITHUB_ISSUES


def is_issues_disabled_error(exc: BaseException) -> bool:
    """Is ``exc`` GitHub saying the repo's Issues feature is off?

    PyGithub raises ``GithubException(410, {"message": "Issues has been
    disabled in this repository."})``; ``gh`` prints "has disabled issues".
    """
    status = getattr(exc, "status", None)
    text = f"{getattr(exc, 'data', '')} {exc}".lower()
    if "issues has been disabled" in text or "has disabled issues" in text:
        return True
    return status == 410 and "issue" in text


def guard_issue_write(app_config: Any, exc: BaseException) -> bool:
    """Call from an ``except`` around an issue write. True (and the repo marked
    disabled) when the failure was Issues-disabled, so the caller can retry the
    write locally instead of failing the pipeline."""
    if not is_issues_disabled_error(exc):
        return False
    mark_issues_disabled(getattr(app_config, "repo", "") or "?", "GitHub answered 410")
    return True


# --------------------------------------------------------------------------- #
# Local store (state/factory.db)
# --------------------------------------------------------------------------- #

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS tracker_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'open',
        state_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE (app, kind, ref)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS tracker_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES tracker_items(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_tracker_notes_item ON tracker_notes(item_id)",
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _connect(db_path: Path, *, create: bool = True) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    if create:  # read paths never write (factory serve's read API uses them)
        for stmt in _SCHEMA:
            conn.execute(stmt)
    return conn


def _row(item: sqlite3.Row | None) -> dict[str, Any] | None:
    if item is None:
        return None
    d = dict(item)
    try:
        d["labels"] = json.loads(d.get("labels") or "[]")
    except ValueError:
        d["labels"] = []
    return d


def upsert_item(
    db_path: Path,
    *,
    app: str,
    kind: str,
    ref: str | int,
    title: str,
    body: str,
    labels: list[str] | None = None,
    reopen: bool = False,
) -> int:
    """Create or update one item; returns its local id. A closed item keeps its
    state unless ``reopen``."""
    now = _now()
    conn = _connect(db_path)
    try:
        cur = conn.execute(
            "SELECT id FROM tracker_items WHERE app=? AND kind=? AND ref=?", (app, kind, str(ref))
        ).fetchone()
        labels_json = json.dumps(sorted(set(labels or [])))
        if cur is None:
            new = conn.execute(
                "INSERT INTO tracker_items (app, kind, ref, title, body, labels, state,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
                (app, kind, str(ref), title, body, labels_json, now, now),
            )
            item_id = int(new.lastrowid or 0)
        else:
            item_id = int(cur["id"])
            sets = "title=?, body=?, labels=?, updated_at=?"
            args: list[Any] = [title, body, labels_json, now]
            if reopen:
                sets += ", state='open', state_reason=NULL, closed_at=NULL"
            conn.execute(f"UPDATE tracker_items SET {sets} WHERE id=?", (*args, item_id))
        conn.commit()
        return item_id
    finally:
        conn.close()


def get_item(db_path: Path, *, app: str, kind: str, ref: str | int) -> dict[str, Any] | None:
    """One item (``labels`` decoded) or ``None``. Never raises on a missing DB."""
    if not Path(db_path).exists():
        return None
    try:
        conn = _connect(db_path, create=False)
    except sqlite3.Error:
        return None
    try:
        return _row(
            conn.execute(
                "SELECT * FROM tracker_items WHERE app=? AND kind=? AND ref=?",
                (app, kind, str(ref)),
            ).fetchone()
        )
    except sqlite3.Error:  # no tracker table yet
        return None
    finally:
        conn.close()


def add_note(
    db_path: Path, *, app: str, kind: str, ref: str | int, body: str, dedupe: bool = True
) -> bool:
    """Append a note to an EXISTING item. ``dedupe`` skips a note identical to
    the item's latest (the needs-direction re-validation spam guard). Returns
    True when a note was written."""
    conn = _connect(db_path)
    try:
        item = conn.execute(
            "SELECT id FROM tracker_items WHERE app=? AND kind=? AND ref=?", (app, kind, str(ref))
        ).fetchone()
        if item is None:
            return False
        if dedupe:
            last = conn.execute(
                "SELECT body FROM tracker_notes WHERE item_id=? ORDER BY id DESC LIMIT 1",
                (item["id"],),
            ).fetchone()
            if last is not None and last["body"] == body:
                return False
        conn.execute(
            "INSERT INTO tracker_notes (item_id, body, created_at) VALUES (?, ?, ?)",
            (item["id"], body, _now()),
        )
        conn.execute("UPDATE tracker_items SET updated_at=? WHERE id=?", (_now(), item["id"]))
        conn.commit()
        return True
    finally:
        conn.close()


def close_item(
    db_path: Path,
    *,
    app: str,
    kind: str,
    ref: str | int,
    note: str | None = None,
    reason: str | None = None,
) -> bool:
    """Close an open item (with an optional note). True when it was open."""
    if not Path(db_path).exists():
        return False
    conn = _connect(db_path)
    try:
        item = conn.execute(
            "SELECT id, state FROM tracker_items WHERE app=? AND kind=? AND ref=?",
            (app, kind, str(ref)),
        ).fetchone()
        if item is None or item["state"] == "closed":
            return False
        now = _now()
        if note:
            conn.execute(
                "INSERT INTO tracker_notes (item_id, body, created_at) VALUES (?, ?, ?)",
                (item["id"], note, now),
            )
        conn.execute(
            "UPDATE tracker_items SET state='closed', state_reason=?, closed_at=?, updated_at=?"
            " WHERE id=?",
            (reason, now, now, item["id"]),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def list_items(
    db_path: Path,
    *,
    app: str | None = None,
    kind: str | None = None,
    state: str | None = None,
    label: str | None = None,
) -> list[dict[str, Any]]:
    """Items filtered by app/kind/state/label, newest-updated first. Never raises."""
    if not Path(db_path).exists():
        return []
    where, args = [], []
    for col, val in (("app", app), ("kind", kind), ("state", state)):
        if val is not None:
            where.append(f"{col}=?")
            args.append(val)
    sql = "SELECT * FROM tracker_items" + (" WHERE " + " AND ".join(where) if where else "")
    sql += " ORDER BY updated_at DESC, id DESC"
    try:
        conn = _connect(db_path, create=False)
    except sqlite3.Error:
        return []
    try:
        rows = [_row(r) for r in conn.execute(sql, args).fetchall()]
    except sqlite3.Error:
        return []
    finally:
        conn.close()
    out = [r for r in rows if r is not None]
    if label is not None:
        out = [r for r in out if label in (r.get("labels") or [])]
    return out


def notes(db_path: Path, item_id: int, *, limit: int | None = None) -> list[dict[str, Any]]:
    """An item's notes, oldest first (the last ``limit`` when given)."""
    if not Path(db_path).exists():
        return []
    conn = _connect(db_path, create=False)
    try:
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT body, created_at FROM tracker_notes WHERE item_id=? ORDER BY id",
                (item_id,),
            ).fetchall()
        ]
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()
    return rows[-limit:] if limit else rows


def item_view(
    db_path: Path, *, app: str, kind: str, ref: str | int, note_limit: int = 5
) -> dict[str, Any] | None:
    """A compact JSON-able view of one item and its latest notes (for job status)."""
    item = get_item(db_path, app=app, kind=kind, ref=ref)
    if item is None:
        return None
    return {
        "title": item["title"],
        "state": item["state"],
        "labels": item["labels"],
        "summary": item["body"],
        "updated_at": item["updated_at"],
        "notes": notes(db_path, int(item["id"]), limit=note_limit),
    }
