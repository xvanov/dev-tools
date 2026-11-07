"""Post-merge main-branch CI-health monitor (D004).

The factory already gates PRE-merge required checks (branch protection —
see ``auto_merge._query_ci_state``). This module is the POST-merge safety
net: once a tick, per app, it polls the latest CI state of the app's
``main`` branch and — when a REQUIRED status check is red there — auto-files
a ``ci-health`` direction so the factory fixes it through the normal
dev -> review -> CI -> merge chain.

Design notes:

* The REQUIRED set comes from branch protection
  (``gh api repos/{repo}/branches/{branch}/protection`` ->
  ``.required_status_checks.contexts``). A repo with no protection / no
  required contexts has nothing to gate on — the tick does nothing (mirrors
  ``auto_merge._query_ci_state``'s ``None`` convention).
* Advisory (non-required) reds are logged as a warning event only — no
  direction is filed. This keeps this monitor from becoming a second,
  noisier copy of the pre-merge gate.
* Dedup is signature-based: a direction is only filed when no OPEN
  ci-health direction already carries the same (failing-check-names,
  main-head-sha) signature. Deliberately EXCLUDES the ``gh run view
  --log-failed`` digest — that fetch is itself best-effort and can
  flake/timeout independently of the underlying CI failure, which would
  otherwise flip the signature between fetch-success and fetch-fail ticks
  and file a duplicate direction for the exact same red check (caught in
  review). The signature is embedded verbatim in the direction body as an
  HTML-comment marker so a later cycle can find it with a simple substring
  scan — no separate index needed. Because the log digest is no longer
  part of the signature, it is only fetched once we're actually about to
  file (not on every dedup check) — avoiding a repeated ~60s log fetch on
  every tick while a required check sits red.
* Every ``gh`` call is best-effort: subprocess errors/timeouts/unparseable
  output all fall back to "nothing to report" so a flaky ``gh`` never
  crashes a tick or, worse, files a spurious direction.
* KNOWN LIMITATION (documented, not a bug): a required context whose
  workflow triggers only on ``on: pull_request`` never posts a check-run
  against a direct-push-to-main commit (GitHub only attaches PR-triggered
  runs to the PR's merge commit, not to main's tip after a squash-merge in
  some configurations) — this monitor has no coverage for that branch-
  protection shape; it only sees checks that actually run against main.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from factory.app_config import AppConfig, load_app_config

# Check-run conclusions that count as "red" for gating purposes. Mirrors the
# failure set ``auto_merge._query_ci_state`` treats as failure.
_FAILING_CONCLUSIONS = frozenset(
    {"failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"}
)


@dataclass
class MainCiStatus:
    """Reduced main-branch CI status for one app.

    ``state`` is one of:

    * ``"unknown"`` — no branch protection / no required contexts / a
      ``gh`` error or timeout. Nothing real to gate on.
    * ``"green"`` — every required check that has completed is passing
      (checks still queued/in_progress are not treated as failures).
    * ``"red_advisory"`` — one or more NON-required checks are red;
      required checks are clean. Warn-only.
    * ``"red_required"`` — one or more REQUIRED checks are red.
    """

    state: str
    required_failing: list[dict[str, Any]] = field(default_factory=list)
    advisory_failing: list[str] = field(default_factory=list)
    sha: str | None = None


@dataclass
class CiHealthResult:
    """What ``main_ci_health_tick`` did for one app on one cycle."""

    app: str
    state: str
    filed_direction_id: str | None = None
    filed: bool = False
    reason: str = ""
    required_failing: list[str] = field(default_factory=list)
    advisory_failing: list[str] = field(default_factory=list)


def _gh_json(cmd: list[str], *, timeout: int = 30) -> Any | None:
    """Run ``cmd`` and parse its stdout as JSON. ``None`` on ANY failure.

    Covers ``gh`` missing, a timeout, a non-zero exit, and unparseable
    output — all callers treat ``None`` as "nothing real to gate on",
    never as a failure signal.
    """
    import json as _json
    import subprocess

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    try:
        return _json.loads(proc.stdout or "null")
    except ValueError:
        return None


def _required_contexts(app_config: AppConfig, *, branch: str = "main") -> list[str] | None:
    """Required status-check context names from branch protection.

    Returns ``None`` when the repo has no branch protection, no required
    status checks, or the ``gh api`` call itself fails/times out — all of
    which mean "nothing to gate on" (never treated as a failure).
    """
    data = _gh_json(
        ["gh", "api", f"repos/{app_config.repo}/branches/{branch}/protection"]
    )
    if not isinstance(data, dict):
        return None
    rsc = data.get("required_status_checks")
    if not isinstance(rsc, dict):
        return None
    contexts = rsc.get("contexts")
    if not isinstance(contexts, list):
        return None
    names = [str(c).strip() for c in contexts if str(c).strip()]
    return names or None


# check-runs page size + a hard page-count cap (2000 check runs) so a
# pathological repo can never spin this into an unbounded loop.
_CHECK_RUNS_PER_PAGE = 100
_CHECK_RUNS_MAX_PAGES = 20


def _main_check_runs(app_config: AppConfig, *, branch: str = "main") -> list[dict[str, Any]] | None:
    """Check-runs reported against the tip of ``branch``, across ALL pages.

    The check-runs endpoint defaults to 30 results/page; a required check
    whose run happens to sort onto page 2+ (e.g. a large CI matrix) would
    otherwise be silently invisible to this monitor and read as "green" by
    omission — a false-green (caught in review). Walks pages manually with
    ``per_page=100`` until a short page signals the end, merging every
    page's ``check_runs`` array. (Manual ``page``/``per_page`` params
    rather than ``gh api --paginate``: that flag concatenates raw page
    bodies for non-array-top-level responses like this endpoint's
    ``{"check_runs": [...]}`` shape, which a single ``json.loads`` cannot
    parse back apart — walking pages ourselves keeps the JSON shape
    unambiguous.)

    ``None`` when the FIRST page errors (mirrors ``_gh_json``'s
    all-or-nothing failure convention, so a real ``gh`` outage still reads
    as "nothing to gate on" rather than "green"). A LATER page's failure
    stops pagination but returns whatever was already collected —
    best-effort partial coverage beats discarding real, already-fetched
    required-check data.
    """
    all_runs: list[dict[str, Any]] = []
    page = 1
    while page <= _CHECK_RUNS_MAX_PAGES:
        data = _gh_json(
            [
                "gh", "api",
                f"repos/{app_config.repo}/commits/{branch}/check-runs"
                f"?per_page={_CHECK_RUNS_PER_PAGE}&page={page}",
            ]
        )
        if not isinstance(data, dict):
            return all_runs if all_runs else None
        runs = data.get("check_runs")
        if not isinstance(runs, list):
            return all_runs if all_runs else None
        all_runs.extend(r for r in runs if isinstance(r, dict))
        if len(runs) < _CHECK_RUNS_PER_PAGE:
            break
        page += 1
    return all_runs


def query_main_ci_status(app_config: AppConfig, *, branch: str = "main") -> MainCiStatus:
    """Reduce main-branch check-runs to a required/advisory red classification.

    Read-only; every ``gh`` call is wrapped so this never raises.
    """
    required = _required_contexts(app_config, branch=branch)
    if not required:
        # No protection / no required checks configured -> nothing to gate.
        return MainCiStatus(state="unknown")

    runs = _main_check_runs(app_config, branch=branch)
    if runs is None:
        return MainCiStatus(state="unknown")

    required_set = set(required)
    required_failing: list[dict[str, Any]] = []
    advisory_failing: list[str] = []
    sha: str | None = None
    for run in runs:
        name = str(run.get("name") or "").strip()
        if not name:
            continue
        head_sha = run.get("head_sha")
        if head_sha and sha is None:
            sha = str(head_sha)
        status = str(run.get("status") or "").lower()
        if status != "completed":
            # Still queued/in_progress — not a failure (yet).
            continue
        conclusion = str(run.get("conclusion") or "").lower()
        if conclusion not in _FAILING_CONCLUSIONS:
            continue
        if name in required_set:
            required_failing.append(run)
        else:
            advisory_failing.append(name)

    if required_failing:
        return MainCiStatus(
            state="red_required",
            required_failing=required_failing,
            advisory_failing=advisory_failing,
            sha=sha,
        )
    if advisory_failing:
        return MainCiStatus(state="red_advisory", advisory_failing=advisory_failing, sha=sha)
    return MainCiStatus(state="green", sha=sha)


def _fetch_check_run_log_digest(app_config: AppConfig, check_run: dict[str, Any]) -> str:
    """Best-effort ``gh run view --log-failed`` digest for one failing check run.

    Resolves the Actions run id from the check run's ``details_url`` /
    ``html_url`` (same pattern as ``auto_merge._fetch_ci_failure_logs``).
    Returns ``""`` on any error/timeout/empty result — this feeds a dev
    prompt, never a merge gate, so a fetch failure must never crash the tick.
    """
    import subprocess

    url = str(check_run.get("details_url") or check_run.get("html_url") or "")
    match = re.search(r"/actions/runs/(\d+)", url)
    if not match:
        return ""
    run_id = match.group(1)
    try:
        proc = subprocess.run(
            ["gh", "run", "view", run_id, "--repo", app_config.repo, "--log-failed"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    digest = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    if not digest:
        return ""
    return digest[-4000:]


def _fetch_required_failure_digest(
    app_config: AppConfig, required_failing: list[dict[str, Any]]
) -> str:
    """Combined log digest for every failing required check (best-effort)."""
    parts: list[str] = []
    for run in required_failing:
        name = str(run.get("name") or "unknown-check")
        digest = _fetch_check_run_log_digest(app_config, run)
        if digest:
            parts.append(f"=== {name} ===\n{digest}")
        else:
            parts.append(f"=== {name} ===\n(no log digest could be fetched)")
    return "\n\n".join(parts)


def _ci_health_signature(check_names: list[str], sha: str | None) -> str:
    """Stable signature of "these required checks are failing on THIS commit".

    Deliberately built from ONLY stable inputs — sorted required-check
    names + main's head sha — and NOT the ``gh run view --log-failed``
    digest. The digest fetch is itself best-effort and can time out/error
    independently of the underlying CI failure; hashing it would flip the
    signature between a fetch-success tick and a fetch-fail tick for the
    exact same red check and file a duplicate direction each flip (caught
    in review). A new push to main naturally gets a fresh sha and
    therefore a fresh signature, which is exactly the "did this actually
    change" semantics dedup needs — while the digest text (log timestamps,
    runner ids, etc.) can vary tick-to-tick for the identical failure.
    """
    basis = f"{','.join(sorted(check_names))}::{sha or ''}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def _ci_health_marker(signature: str) -> str:
    return f"<!-- ci-health-signature: {signature} -->"


def _has_open_ci_health_direction(
    app: str, signature: str, software_factory_root: Path
) -> bool:
    """True if a non-terminal ci-health direction already carries ``signature``.

    Scans ``apps/<app>/directions/*/direction.md`` for the exact
    ``<!-- ci-health-signature: ... -->`` marker this module stamps into
    the body it files, skipping directions whose ``state.yaml`` status is
    terminal (mirrors ``scheduled_tasks._has_open_duplicate_direction`` —
    a closed-out direction for the SAME failure is not a duplicate; a new
    one is filed if it recurs). Any per-directory error is swallowed so a
    malformed sibling can never block filing.
    """
    import frontmatter as _frontmatter
    import yaml as _yaml

    from factory.chain.scheduled_tasks import _TERMINAL_DIRECTION_STATUSES

    marker = _ci_health_marker(signature)
    directions_dir = Path(software_factory_root) / "apps" / app / "directions"
    if not directions_dir.is_dir():
        return False
    for d in directions_dir.iterdir():
        md = d / "direction.md"
        if not md.is_file():
            continue
        try:
            post = _frontmatter.load(str(md))
            status = "created"
            state_path = d / "state.yaml"
            if state_path.is_file():
                state = _yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
                status = str(state.get("status", "created"))
            if status in _TERMINAL_DIRECTION_STATUSES:
                continue
            content = str(getattr(post, "content", "") or "")
            if marker in content:
                return True
        except Exception:  # noqa: BLE001 - one bad sibling must not block filing
            continue
    return False


def _file_ci_health_direction(
    *,
    app: str,
    required_failing_names: list[str],
    log_digest: str,
    signature: str,
    software_factory_root: Path,
) -> str:
    """Write the ci-health direction and return its id."""
    from factory.directions.creator import create_direction

    checks_str = ", ".join(required_failing_names)
    why = (
        f"Post-merge CI-health monitor: the required check(s) {checks_str} are "
        f"failing on {app}'s main branch AFTER merge (the pre-merge required-"
        "check gate is unchanged and remains the primary defense; this is the "
        "post-merge safety net). Fix the exact failure below so main goes "
        f"green again.\n\n{log_digest.strip() or '(no log digest could be fetched)'}\n\n"
        f"{_ci_health_marker(signature)}"
    )
    created = create_direction(
        app,
        title=f"Fix failing required check(s) on main: {checks_str}",
        type_tag="bug",
        why=why,
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[
            f"{name} passes on {app}'s main branch" for name in required_failing_names
        ],
        # explore=True: a CI-health repair has no user_flow/api_spec (it's
        # "here's a broken check, fix it"), and the backpressure gate would
        # otherwise flag every ci-health direction as needs-direction and
        # never build it — the same reasoning ``scheduled_tasks`` uses for
        # security/ux_auditor findings.
        explore=True,
        attach_files=None,
        software_factory_root=software_factory_root,
        source="ci-health",
    )
    return created.direction.id


def main_ci_health_tick(
    software_factory_root: Path,
    app: str,
    *,
    dry_run: bool = True,
    status_override: MainCiStatus | None = None,
) -> CiHealthResult:
    """Single pass of the post-merge main-branch CI-health monitor.

    Queries ``main``'s required-check status (or uses ``status_override``
    when a test wants to bypass the ``gh`` calls entirely), and:

    * ``unknown``/``green`` -> nothing filed.
    * ``red_advisory`` -> a warning event only, no direction.
    * ``red_required`` -> files (at most) one ``ci-health`` direction,
      deduped against any already-open one carrying the same
      (failing-check-names, main-head-sha) signature.

    ``dry_run`` gates the actual direction write (real filesystem
    mutation under ``apps/<app>/directions/``) — set ``False`` only in a
    real tick against a real ``software_factory_root``. Best-effort
    throughout: any exception in the ``gh``/filing path is swallowed and
    reported via ``CiHealthResult.reason`` rather than propagated, so this
    monitor can never break a tick.
    """
    root = Path(software_factory_root)
    try:
        cfg = load_app_config(app, root)
    except Exception as exc:  # noqa: BLE001
        return CiHealthResult(app=app, state="unknown", reason=f"app_config_error: {exc!r}")

    try:
        status = (
            status_override
            if status_override is not None
            else query_main_ci_status(cfg, branch=cfg.default_branch or "main")
        )
    except Exception as exc:  # noqa: BLE001
        return CiHealthResult(app=app, state="unknown", reason=f"query_error: {exc!r}")

    if status.state in ("unknown", "green"):
        return CiHealthResult(app=app, state=status.state, reason="nothing to report")

    if status.state == "red_advisory":
        try:
            from factory.manager.signals import write_event as _we

            _we(
                "ci_health",
                {
                    "event": "ci_health_advisory_red",
                    "app": app,
                    "advisory_failing": list(status.advisory_failing),
                },
                software_factory_root=root,
            )
        except Exception:  # noqa: BLE001
            pass
        return CiHealthResult(
            app=app,
            state=status.state,
            reason="advisory-only red; warning emitted, no direction filed",
            advisory_failing=list(status.advisory_failing),
        )

    # red_required
    required_names = sorted({str(r.get("name") or "") for r in status.required_failing})
    # Signature depends ONLY on stable inputs (check names + main's head
    # sha) — see ``_ci_health_signature`` — so it's computed BEFORE any log
    # fetch and the dedup check below never needs the (best-effort, can
    # flake) log digest at all.
    signature = _ci_health_signature(required_names, status.sha)

    try:
        already_open = _has_open_ci_health_direction(app, signature, root)
    except Exception:  # noqa: BLE001
        already_open = False
    if already_open:
        return CiHealthResult(
            app=app,
            state=status.state,
            reason="duplicate of an already-open ci-health direction; not re-filed",
            required_failing=required_names,
            advisory_failing=list(status.advisory_failing),
        )

    if dry_run:
        return CiHealthResult(
            app=app,
            state=status.state,
            reason="dry-run: would file a ci-health direction",
            required_failing=required_names,
            advisory_failing=list(status.advisory_failing),
        )

    # Only fetch the (best-effort, ~60s-per-check) log digest once we're
    # ACTUALLY about to file — not on every dedup check above — since the
    # digest no longer feeds the signature and re-fetching it every tick
    # while a required check sits red is pure wasted load.
    try:
        log_digest = _fetch_required_failure_digest(cfg, status.required_failing)
    except Exception:  # noqa: BLE001
        log_digest = ""

    try:
        direction_id = _file_ci_health_direction(
            app=app,
            required_failing_names=required_names,
            log_digest=log_digest,
            signature=signature,
            software_factory_root=root,
        )
    except Exception as exc:  # noqa: BLE001
        return CiHealthResult(
            app=app,
            state=status.state,
            reason=f"direction_create_failed: {exc!r}",
            required_failing=required_names,
            advisory_failing=list(status.advisory_failing),
        )

    return CiHealthResult(
        app=app,
        state=status.state,
        filed_direction_id=direction_id,
        filed=True,
        reason="required check red on main; ci-health direction filed",
        required_failing=required_names,
        advisory_failing=list(status.advisory_failing),
    )
