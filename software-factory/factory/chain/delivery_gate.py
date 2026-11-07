"""Chain-side enforcement of a story's delivery level.

``factory/delivery.py`` owns the vocabulary (``none < branch < draft_pr < pr <
auto_merge < push_to_main``) and the resolution rule (the job's requested
level wins; there is no per-app ceiling). This module owns the three
things the CHAIN needs on top of that:

1. **Resolve once, record forever.** :func:`resolve_for_direction` computes a
   story's level at spawn (the direction's ``delivery:`` frontmatter, else the
   app's ``delivery.default``) and the spawn handler writes it to
   ``StoryRecord.delivery_level`` plus a ``delivery_level_resolved`` story
   event. Every later decision reads the RECORDED value through
   :func:`story_level`, so editing the app's default mid-flight never changes a
   story already in flight. The only later adjustments are fail-safe ones
   (an unreadable recorded value → ``none``; ``push_to_main`` on a factory
   self-edit → ``pr``), recorded as ``delivery_level_lowered``. A row with
   NO recorded level predates stamping and is backfilled (first touch) with
   the pre-existing default, ``auto_merge``.

2. **Fail safe.** Anything that cannot be determined resolves to ``none`` — the
   most restrictive level that still preserves the work (it is committed
   locally, never thrown away) — and the reason is logged. The one exception is
   a row that predates per-story recording: it was spawned under the
   pre-existing default and resolves to that (``auto_merge``), so shipping
   this module changes nothing for in-flight legacy work.

3. **The git side of the non-PR levels.** :func:`commit_local_work` (``none``)
   and :func:`fast_forward_default_branch` (``push_to_main``). Branch pushing
   and PR creation reuse ``handlers._push_story_branch`` /
   ``handlers._open_pr_for_story``.

Where each level is enforced (keep in sync with
``apps/factory/context/modules/state-machine.md`` § Delivery levels):

* ``handlers.handle_docs_enforcer`` — the PR-open site. ``none`` commits and
  ends in ``DELIVERED_LOCAL``; ``branch`` pushes and ends in
  ``DELIVERED_BRANCH``; ``draft_pr`` / ``pr`` open a draft / ready PR and end in
  ``DELIVERED_PR``; ``auto_merge`` is unchanged (``PR_OPEN``); ``push_to_main``
  pushes the branch and reaches ``PR_OPEN`` with NO PR.
* ``auto_merge.auto_merge_tick`` — never merges a story whose level does not
  merge (and never a draft PR); runs the full gate set for ``push_to_main`` and
  fast-forwards the default branch, or refuses and falls back to ``pr``.
* ``handlers.handle_dev`` (dev-exhausted WIP preservation) — pushes only when
  the level pushes.
"""

from __future__ import annotations

import contextlib
import logging
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from factory.delivery import (
    LEGACY_DEFAULT,
    DeliveryLevel,
    effective_level,
    parse_level,
)

_logger = logging.getLogger(__name__)

EVENT_RESOLVED = "delivery_level_resolved"
EVENT_LOWERED = "delivery_level_lowered"
EVENT_DELIVERED = "delivered"


def watches_ci_before_delivery(level: DeliveryLevel | None) -> bool:
    """True for the levels whose PR's CI the factory watches (and fixes, at
    most ``auto_merge._MAX_CI_FIX_CYCLES`` times) before ``DELIVERED_PR``:
    ``draft_pr`` and ``pr``. See ``auto_merge._watch_ci_then_deliver``."""
    return level in (DeliveryLevel.DRAFT_PR, DeliveryLevel.PR)


def story_is_ci_watched(story: Any) -> bool:
    """``watches_ci_before_delivery`` for a story's RECORDED level. Pure read
    (no backfill, no event); an unreadable level is not watched."""
    try:
        return watches_ci_before_delivery(parse_level(getattr(story, "delivery_level", None)))
    except ValueError:
        return False


def _app_opted_in(app_config: Any) -> bool:
    """True when ``apps/<app>/config.yaml`` carries an explicit ``delivery`` block."""
    fields_set = getattr(app_config, "model_fields_set", None) or set()
    return "delivery" in fields_set


def resolve_for_direction(app_config: Any, direction: Any) -> tuple[DeliveryLevel, dict[str, Any]]:
    """The level a NEW story of ``direction`` runs at, plus an audit payload.

    Never raises: any failure resolves to ``none`` with the reason recorded.
    """
    try:
        cfg = app_config.delivery
        fm = getattr(direction, "raw_frontmatter", None) or {}
        requested = fm.get("delivery") if isinstance(fm, dict) else None
        level = effective_level(cfg, requested)
        info: dict[str, Any] = {
            "level": level.value,
            "requested": None if requested is None else str(requested),
            "default": cfg.default.value,
            "app_opted_in": _app_opted_in(app_config),
        }
        if requested not in (None, ""):
            try:
                req = parse_level(requested)
            except ValueError:
                info["reason"] = "unparseable_request_fail_safe_none"
            else:
                info["reason"] = "requested" if req is not None else "app_default"
        else:
            info["reason"] = "app_default"
        return level, info
    except Exception as exc:  # noqa: BLE001 - fail safe, never fail a spawn
        _logger.warning("delivery level resolution failed (fail-safe none): %r", exc)
        return DeliveryLevel.NONE, {
            "level": DeliveryLevel.NONE.value,
            "reason": f"resolution_failed_fail_safe_none: {exc!r}"[:300],
        }


def _log(story: Any, event: str, payload: dict[str, Any], root: Path) -> None:
    if getattr(story, "id", None) is None:
        return
    try:
        from factory.chain.event_log import log_story_event

        log_story_event(
            story.id, event, payload, software_factory_root=root, slug_hint=story.slug or ""
        )
    except Exception:  # noqa: BLE001 - telemetry must never break delivery
        _logger.warning("story %s: could not log %s", getattr(story, "id", None), event)


def record_spawn_level(
    story: Any, app_config: Any, direction: Any, root: Path
) -> tuple[DeliveryLevel, dict[str, Any]]:
    """Stamp ``story.delivery_level`` at spawn (caller persists). Returns the audit payload
    so the caller can log it once the row has an id."""
    level, info = resolve_for_direction(app_config, direction)
    story.delivery_level = level.value
    info["source"] = "spawn"
    return level, info


def log_spawn_level(story: Any, info: dict[str, Any], root: Path) -> None:
    _log(story, EVENT_RESOLVED, info, root)


def _resolve_unrecorded(
    story: Any, app_config: Any, root: Path
) -> tuple[DeliveryLevel, dict[str, Any]]:
    """A row with no recorded level — it predates per-story stamping.

    Review 2026-11-02 (nice 11): every such row was spawned BEFORE delivery
    levels were enforced, i.e. under the pre-existing default, ``auto_merge``
    — whatever its direction says today and whatever the app's default is
    now. Re-deriving it from a direction or config edited later would change
    the outcome of work already in flight (the in-flight-drift this module
    exists to prevent), and the old ``none`` fallback silently stopped legacy
    PRs from merging. So the backfill is the pre-existing default, recorded.
    """
    return LEGACY_DEFAULT, {
        "level": LEGACY_DEFAULT.value,
        "reason": "predates_per_story_stamping_pre_existing_default",
    }


def story_level(
    story: Any,
    app_config: Any,
    root: Path,
    db_path: Path | None = None,
    *,
    persist: bool = True,
) -> DeliveryLevel:
    """The level the chain must enforce for ``story`` RIGHT NOW.

    = the recorded level (there is no per-app ceiling, so app-config edits
    never move it), with ``push_to_main`` lowered to ``pr`` for factory
    self-edits (which must pass the PR-patch staging gate; a direct push would
    bypass it). Never raises; an unreadable value resolves to ``none``.

    ``persist=False`` (dry-run) mutates only the in-memory record: no DB write
    and no story event, so a preview stays a pure preview.
    """
    pending: list[tuple[str, dict[str, Any]]] = []
    try:
        changed = False
        raw = getattr(story, "delivery_level", None)
        if raw:
            try:
                level = parse_level(raw) or DeliveryLevel.NONE
            except ValueError:
                level = DeliveryLevel.NONE
                story.delivery_level = level.value
                changed = True
                pending.append(
                    (
                        EVENT_LOWERED,
                        {
                            "from": str(raw),
                            "to": level.value,
                            "reason": "unreadable_recorded_level",
                        },
                    )
                )
        else:
            level, info = _resolve_unrecorded(story, app_config, root)
            info["source"] = "first_touch"
            story.delivery_level = level.value
            changed = True
            pending.append((EVENT_RESOLVED, info))

        lowered = level
        reason = ""
        if lowered is DeliveryLevel.PUSH_TO_MAIN:
            from factory.chain.auto_merge import _story_targets_factory_repo

            if _story_targets_factory_repo(app_config):
                lowered = DeliveryLevel.PR
                reason = "factory_self_edit_requires_staging_gate"
        if lowered is not level:
            story.delivery_level = lowered.value
            changed = True
            pending.append(
                (EVENT_LOWERED, {"from": level.value, "to": lowered.value, "reason": reason})
            )
            level = lowered

        if changed and persist:
            if db_path is not None and getattr(story, "id", None) is not None:
                from factory.chain.handlers import persist_story

                persist_story(story, db_path)
            for event, payload in pending:
                _log(story, event, payload, root)
        return level
    except Exception as exc:  # noqa: BLE001 - fail safe
        _logger.warning(
            "story %s: delivery level undeterminable (%r) — enforcing 'none'",
            getattr(story, "id", None),
            exc,
        )
        return DeliveryLevel.NONE


# --------------------------------------------------------------------------- #
# git helpers
# --------------------------------------------------------------------------- #


def _git(cwd: Path, *args: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, timeout=timeout, check=False
    )


def commit_local_work(worktree: Path, story: Any) -> tuple[str | None, str | None]:
    """Level ``none``: commit any uncommitted work on the story branch. Never pushes.

    Returns ``(head_sha, error)``.
    """
    try:
        _git(worktree, "add", "-A")
        if _git(worktree, "status", "--porcelain").stdout.strip():
            proc = _git(
                worktree,
                "commit",
                "-m",
                f"factory: story {story.id} ({story.slug}) — delivered locally (delivery: none)",
            )
            if proc.returncode != 0:
                return None, f"git commit failed: {(proc.stderr or proc.stdout).strip()[:300]}"
        if _git(worktree, "status", "--porcelain").stdout.strip():
            return None, "worktree still dirty after commit"
        head = _git(worktree, "rev-parse", "HEAD")
        sha = head.stdout.strip()
        if head.returncode != 0 or not sha:
            return None, "could not resolve HEAD"
        return sha, None
    except (subprocess.SubprocessError, OSError) as exc:
        return None, f"git error: {exc!r}"[:300]


def fast_forward_default_branch(
    *, worktree: Path | None, base: str, expected_sha: str
) -> tuple[bool, str]:
    """Level ``push_to_main``: fast-forward ``origin/<base>`` to the gated commit.

    ``expected_sha`` is the commit the merge gates just evaluated. Refuses
    (``(False, reason)``) unless ALL of:

    * the worktree HEAD is still exactly ``expected_sha``;
    * ``origin/<base>`` (freshly fetched) is an ancestor of it, i.e. the update
      is a genuine fast-forward;
    * a plain, non-force ``git push`` succeeds (the remote re-checks FF);
    * a re-fetch shows ``origin/<base>`` now equals ``expected_sha``.

    Returns ``(True, sha)`` on success. Never force-pushes.
    """
    if worktree is None:
        return False, "no worktree for the gated commit"
    try:
        head = _git(worktree, "rev-parse", "HEAD").stdout.strip()
        if not head or head != expected_sha:
            return (
                False,
                f"worktree HEAD {head[:12] or '?'} is not the gated commit {expected_sha[:12]}",
            )
        fetched = _git(worktree, "fetch", "origin", base)
        if fetched.returncode != 0:
            return False, f"git fetch origin {base} failed: {fetched.stderr.strip()[:200]}"
        anc = _git(worktree, "merge-base", "--is-ancestor", f"origin/{base}", head)
        if anc.returncode != 0:
            return False, f"not a fast-forward: origin/{base} is not an ancestor of {head[:12]}"
        pushed = _git(worktree, "push", "origin", f"{head}:refs/heads/{base}")
        if pushed.returncode != 0:
            return False, f"push rejected: {pushed.stderr.strip()[:200]}"
        _git(worktree, "fetch", "origin", base)
        now = _git(worktree, "rev-parse", f"origin/{base}").stdout.strip()
        if now != head:
            return False, f"origin/{base} is {now[:12] or '?'} after push, expected {head[:12]}"
        return True, head
    except (subprocess.SubprocessError, OSError) as exc:
        return False, f"git error: {exc!r}"[:300]


def worktree_head_and_files(
    worktree: Path | None, base: str
) -> tuple[str | None, list[str] | None]:
    """The worktree's HEAD sha and its changed files vs ``origin/<base>`` — the
    PR-less stand-in for ``gh``'s head sha / file list (``push_to_main``)."""
    if worktree is None:
        return None, None
    try:
        head = _git(worktree, "rev-parse", "HEAD").stdout.strip() or None
        diff = _git(worktree, "diff", "--name-only", f"origin/{base}...HEAD")
        files = (
            [ln for ln in diff.stdout.splitlines() if ln.strip()] if diff.returncode == 0 else None
        )
        return head, files
    except (subprocess.SubprocessError, OSError):
        return None, None


# --------------------------------------------------------------------------- #
# GitHub side: auto-merge disarm + push_to_main preflight
# --------------------------------------------------------------------------- #

# gh's wording when there was nothing to disarm. Anything else is a real failure.
_DISABLE_AUTO_NOOP_MARKERS = (
    "auto-merge is not enabled",
    "not enabled",
    "pull request is closed",
    "already merged",
)


def disable_auto_merge(app_config: Any, pr_number: int | None, *, run: Any = None) -> str | None:
    """Disarm GitHub auto-merge on ``pr_number`` (``gh pr merge --disable-auto``).

    ``gh pr merge --auto`` arms a merge that GitHub performs on its own once the
    required checks pass. That arm survives everything the factory does locally:
    settling the story to a non-merging level, or cancelling the job, does NOT
    stop GitHub from merging. So every path that takes a story below
    ``auto_merge`` (or cancels it) must disarm it explicitly.

    Returns ``None`` when the PR is (now) not armed — including "it never was"
    — or an error string. Never raises.
    """
    if pr_number is None or pr_number <= 0:
        return None
    runner = run or subprocess.run
    cmd = ["gh", "pr", "merge", str(pr_number), "--disable-auto"]
    repo = getattr(app_config, "repo", None)
    if repo:
        cmd += ["--repo", str(repo)]
    try:
        proc = runner(cmd, capture_output=True, text=True, timeout=60, check=False)
    except (subprocess.SubprocessError, OSError) as exc:
        return f"gh pr merge --disable-auto failed: {exc!r}"[:300]
    if proc.returncode == 0:
        return None
    err = ((proc.stderr or "") + (proc.stdout or "")).strip()
    if any(m in err.lower() for m in _DISABLE_AUTO_NOOP_MARKERS):
        return None
    return f"gh pr merge --disable-auto exit={proc.returncode}: {err[:240]}"


# A check-run conclusion that means "main is NOT green". ``cancelled`` and
# ``stale`` are included on purpose: they are not a green verdict, and a hold
# is only ever a suppression (it never authorizes anything).
_RED_CONCLUSIONS = frozenset(
    {"failure", "timed_out", "action_required", "startup_failure", "cancelled", "stale"}
)

PREFLIGHT_OK = "ok"
PREFLIGHT_HOLD = "hold"
PREFLIGHT_REFUSE = "refuse"


def _gh_api_json(path: str, runner: Any) -> tuple[Any, str | None]:
    import json as _json

    try:
        proc = runner(["gh", "api", path], capture_output=True, text=True, timeout=60, check=False)
    except (subprocess.SubprocessError, OSError) as exc:
        return None, f"gh api {path} failed: {exc!r}"[:300]
    if proc.returncode != 0:
        return None, f"gh api {path} exit={proc.returncode}: {(proc.stderr or '').strip()[:200]}"
    try:
        return _json.loads(proc.stdout or "null"), None
    except ValueError as exc:
        return None, f"gh api {path}: unparseable JSON ({exc})"


def push_to_main_preflight(app_config: Any, base: str, *, run: Any = None) -> tuple[str, str]:
    """What ``push_to_main`` must check on GitHub BEFORE it may fast-forward.

    Returns ``(verdict, reason)`` with ``verdict`` one of:

    * ``PREFLIGHT_HOLD`` — ``base``'s own CI is red or still running (the same
      main-green hold PR merges get), or GitHub could not be read. Checked
      BEFORE protection: a red base holds even when it is protected. Nothing
      is written to the story beyond a hold reason; re-checked next tick.
    * ``PREFLIGHT_REFUSE`` — ``base`` is green but protected by required status
      checks or a required pull request (classic branch protection or a
      ruleset). A direct push would bypass the checks every PR must pass (or
      be rejected outright), so the factory never pushes or forces; the
      caller falls back to delivering through a PR at ``auto_merge``.
    * ``PREFLIGHT_OK`` — unprotected, and every check on ``base``'s head is
      green (or there are none).

    Any uncertainty resolves to HOLD (fail safe: never push on a guess).
    Never raises.
    """
    runner = run or subprocess.run
    repo = getattr(app_config, "repo", None)
    if not repo:
        return PREFLIGHT_HOLD, "no repo configured — cannot verify branch protection"
    try:
        # 1. Classic branch protection. ``GET branches/<b>`` is readable by
        #    anyone with read access (unlike ``.../protection``, which needs
        #    admin) and carries the required-status-check summary.
        branch, err = _gh_api_json(f"repos/{repo}/branches/{base}", runner)
        if err is not None or not isinstance(branch, dict):
            return PREFLIGHT_HOLD, f"could not read branch {base}: {err or 'bad payload'}"
        prot = branch.get("protection") or {}
        rsc = prot.get("required_status_checks") or {}
        required = list(rsc.get("contexts") or []) + [
            c.get("context") for c in (rsc.get("checks") or []) if isinstance(c, dict)
        ]
        refusal: str | None = None
        if branch.get("protected") and [r for r in required if r]:
            refusal = (
                f"{base} requires status checks {sorted(r for r in required if r)!r}; "
                "a direct push would bypass them"
            )
        # 2. Repository rulesets that apply to the branch.
        rules, err = _gh_api_json(f"repos/{repo}/rules/branches/{base}", runner)
        if err is not None or not isinstance(rules, list):
            return PREFLIGHT_HOLD, f"could not read rulesets for {base}: {err or 'bad payload'}"
        blocking = sorted(
            {
                str(r.get("type"))
                for r in rules
                if isinstance(r, dict)
                and r.get("type") in ("required_status_checks", "pull_request")
            }
        )
        if blocking and refusal is None:
            refusal = (
                f"{base} is governed by ruleset rule(s) {blocking!r}; "
                "a direct push would bypass them"
            )
        # 3. Main-green: every check on the base head must be green.
        runs, err = _gh_api_json(f"repos/{repo}/commits/{base}/check-runs?per_page=100", runner)
        if err is not None or not isinstance(runs, dict):
            return PREFLIGHT_HOLD, f"could not read {base}'s checks: {err or 'bad payload'}"
        red: list[str] = []
        running: list[str] = []
        for cr in runs.get("check_runs") or []:
            if not isinstance(cr, dict):
                continue
            name = str(cr.get("name") or "?")
            if cr.get("status") != "completed":
                running.append(name)
            elif (cr.get("conclusion") or "") in _RED_CONCLUSIONS:
                red.append(name)
        status, err = _gh_api_json(f"repos/{repo}/commits/{base}/status", runner)
        if err is not None or not isinstance(status, dict):
            return PREFLIGHT_HOLD, f"could not read {base}'s status: {err or 'bad payload'}"
        for st in status.get("statuses") or []:
            if not isinstance(st, dict):
                continue
            state = st.get("state")
            if state in ("failure", "error"):
                red.append(str(st.get("context") or "?"))
            elif state == "pending":
                running.append(str(st.get("context") or "?"))
        if red:
            return PREFLIGHT_HOLD, f"{base} is red ({sorted(set(red))!r}) — main-green hold"
        if running:
            return (
                PREFLIGHT_HOLD,
                f"{base}'s checks are still running ({sorted(set(running))!r}) — main-green hold",
            )
        # Main-green FIRST: a red/running base holds even when the branch is
        # protected — the PR fallback is for a green, guarded base.
        if refusal is not None:
            return PREFLIGHT_REFUSE, refusal
        return PREFLIGHT_OK, f"{base} unprotected and green"
    except Exception as exc:  # noqa: BLE001 - fail safe: hold, never push on a guess
        return PREFLIGHT_HOLD, f"preflight error: {exc!r}"[:300]


# --------------------------------------------------------------------------- #
# Per-story lock + compare-and-set state writes (cancel vs. merge race)
# --------------------------------------------------------------------------- #

#: How long a writer waits for another writer's story lock. Both holders keep
#: it only around a short critical section (re-read → merge/push → state
#: write, or re-read → disarm → park), never around gate evaluation.
STORY_LOCK_TIMEOUT_S = 120.0


def _story_lock_path(root: Path, story_id: int) -> Path:
    return Path(root) / "state" / "locks" / f"story-{int(story_id)}.lock"


@contextlib.contextmanager
def story_lock(root: Path, story_id: int, *, timeout: float | None = None) -> Iterator[bool]:
    """Cross-process exclusive lock for ONE story's terminal decisions.

    Adversarial review 2026-11-02 (MUST 1): the auto-merge pass loaded a story,
    ran gates for minutes, and then merged / fast-forwarded and wrote
    ``deploy_pending`` from that stale copy — over a ``closed_by_operator``
    that ``factory job cancel`` wrote in between. Both sides now take this
    lock around their critical section and RE-READ the row inside it, so one
    of them always sees the other's result.

    Yields ``True`` when held, ``False`` on timeout (the caller must then NOT
    act — fail safe). ``flock`` on a per-story file under ``state/locks/``;
    released when the block exits (or the process dies).
    """
    import fcntl
    import time

    path = _story_lock_path(root, story_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+")
    except OSError as exc:
        _logger.warning("story %s: cannot open lock file %s: %r", story_id, path, exc)
        yield False
        return
    held = False
    try:
        wait = STORY_LOCK_TIMEOUT_S if timeout is None else timeout
        deadline = time.monotonic() + max(0.0, wait)
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                held = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.2)
        yield held
    finally:
        if held:
            with contextlib.suppress(OSError):
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def current_story_state(db: Path, story_id: int) -> str | None:
    """The story's state as committed RIGHT NOW (fresh session, no cache)."""
    from sqlmodel import Session, create_engine

    from factory.chain.state_machine import StoryRecord

    with Session(create_engine(f"sqlite:///{db}", echo=False)) as session:
        row = session.get(StoryRecord, story_id)
        return None if row is None else row.state


def cas_story_state(
    db: Path,
    story_id: int,
    expected: frozenset[str] | set[str],
    new_state: str,
    **fields: Any,
) -> bool:
    """Set ``state = new_state`` (plus ``fields``) ONLY if the committed state
    is still one of ``expected``. Returns whether it wrote.

    Goes through the ORM (so ``observability.state_trace`` sees the write) and
    is atomic with respect to every other writer that holds
    :func:`story_lock` for this story — which is what the cancel and merge
    paths do. A writer that sees ``False`` lost the race and must not act as
    if its transition happened.
    """
    from datetime import UTC, datetime

    from sqlmodel import Session, create_engine

    from factory.chain.state_machine import StoryRecord

    with Session(create_engine(f"sqlite:///{db}", echo=False)) as session:
        row = session.get(StoryRecord, story_id)
        if row is None or row.state not in expected:
            return False
        row.state = new_state
        for key, value in fields.items():
            setattr(row, key, value)
        if hasattr(row, "updated_at"):
            row.updated_at = datetime.now(UTC).isoformat()
        session.add(row)
        session.commit()
        return True


# --------------------------------------------------------------------------- #
# Stacking dependents on delivered siblings (review 2026-11-02, SHOULD 5)
# --------------------------------------------------------------------------- #


def stack_parent(story: Any, db: Path) -> Any:
    """The sibling a non-merging story should build ON, or ``None``.

    Below ``auto_merge`` an earlier sibling's work ends DELIVERED (a local
    commit, a pushed branch, or an open PR) and never reaches the default
    branch, so a dependent cut from the default branch would not see it. The
    parent is the highest-id lower sibling of the same direction in a
    ``delivered_*`` state that has a branch. Only for a story whose own
    stamped level does not merge (a merging story keeps the strict
    deploy-ordering). Never raises.
    """
    try:
        from sqlmodel import Session, create_engine, select

        from factory.chain.state_machine import DELIVERED_UNMERGED_STATES, StoryRecord

        lvl = parse_level(getattr(story, "delivery_level", None))
        if lvl is None or lvl.merges or getattr(story, "id", None) is None:
            return None
        with Session(create_engine(f"sqlite:///{db}", echo=False)) as session:
            rows = session.exec(
                select(StoryRecord).where(
                    StoryRecord.app == story.app,
                    StoryRecord.direction_id == story.direction_id,
                )
            ).all()
        parents = [
            r
            for r in rows
            if r.id is not None
            and r.id < story.id
            and r.state in DELIVERED_UNMERGED_STATES
            and r.github_branch
        ]
        return max(parents, key=lambda r: r.id or 0) if parents else None
    except Exception as exc:  # noqa: BLE001 - stacking is an optimisation, never a blocker
        _logger.warning("stack_parent(%s) failed: %r", getattr(story, "id", None), exc)
        return None


# --------------------------------------------------------------------------- #
# Durable job-cancel marker (review 2026-11-02, N2)
# --------------------------------------------------------------------------- #

#: Its own table on purpose: a story row can be written back by any in-flight
#: handler holding a stale copy (``persist_story``), so a cancel recorded ONLY
#: on the story can be silently undone. Nothing in the chain writes this table
#: except ``factory job cancel``.
_CANCEL_TABLE = "job_cancellations"


def mark_job_cancelled(db: Path, app: str, direction_id: str, *, by: str) -> None:
    """Record that every story of ``(app, direction_id)`` is cancelled. Idempotent."""
    import sqlite3
    from datetime import UTC, datetime

    con = sqlite3.connect(db, timeout=30)
    try:
        con.execute(
            f"CREATE TABLE IF NOT EXISTS {_CANCEL_TABLE} ("
            "app TEXT NOT NULL, direction_id TEXT NOT NULL, at TEXT NOT NULL, by TEXT, "
            "PRIMARY KEY (app, direction_id))"
        )
        con.execute(
            f"INSERT OR IGNORE INTO {_CANCEL_TABLE} (app, direction_id, at, by) VALUES (?,?,?,?)",
            (app, str(direction_id), datetime.now(UTC).isoformat(), by),
        )
        con.commit()
    finally:
        con.close()


def is_job_cancelled(db: Path, app: str, direction_id: str | None) -> bool:
    """Was the story's job cancelled? ``False`` only when provably not: a
    missing table or row. Any OTHER read error answers ``True`` — callers use
    this to refuse a merge / a dispatch, and refusing is the safe side."""
    import sqlite3

    if not direction_id:
        return False
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=30)
    except sqlite3.Error:
        return True
    try:
        row = con.execute(
            f"SELECT 1 FROM {_CANCEL_TABLE} WHERE app = ? AND direction_id = ?",
            (app, str(direction_id)),
        ).fetchone()
        return row is not None
    except sqlite3.OperationalError as exc:
        return "no such table" not in str(exc)
    except sqlite3.Error:
        return True
    finally:
        con.close()
