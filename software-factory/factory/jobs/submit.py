"""``factory job submit`` — turn a job into a direction (pre-approved for pa/human).

What a submit writes, all inside ONE directory that appears atomically
(staged under a dot-name, then ``rename``-d into place so a concurrent tick's
pm-sync can never triage a half-written job):

* ``direction.md`` — built by the same ``creator._build_direction_md`` every
  direction uses, plus the job keys in frontmatter: ``source``,
  ``external_id``, ``pipeline`` (as requested: chain|solo|auto),
  ``delivery`` (as requested, raw, or null) and ``models``.
* ``state.yaml`` — ``status: created``, ``source: <source>`` and, for
  ``--source pa`` / ``human`` only, a signed ``operator_approval`` record
  (see :func:`_approval_record`, ``AUTO_APPROVED_SOURCES``).
* ``artifacts/ask.md`` — the ask, verbatim, as evidence.
* optional ``flow.md`` / ``api_spec.md`` from ``--flow-file`` /
  ``--api-spec-file`` (the backpressure gate's inputs; see JOBS-API.md).

Then a ``directions`` row carrying ``source`` (the row is what the approval
gate trusts first; ``state.yaml`` is gitignored and can be lost).
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import sys
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from factory.app_config import AppConfig, load_app_config
from factory.delivery import effective_level, parse_level
from factory.directions.approval import APPROVAL_KEY
from factory.directions.creator import _build_direction_md, _write_initial_state_yaml
from factory.directions.parser import next_direction_id, parse_direction_dir, slugify
from factory.job_routing import (
    PIPELINES,
    JobRouting,
    JobRoutingError,
    parse_model_flags,
    resolve_job_routing,
    resolve_pipeline,
)
from factory.jobs.common import (
    JobError,
    format_job_id,
    iter_jobs,
    read_state_yaml,
    registered_apps,
    state_db_path,
)
from factory.jobs.kinds import (
    CLAUDE_MODEL_KEY,
    KINDS,
    RUNTIME_API,
    RUNTIME_CLAUDE,
    RUNTIMES,
    TASK_KINDS,
    normalize_kind,
    normalize_runtime,
    split_claude_model,
)
from factory.jobs.tasks import TaskRef, create_task, find_existing_task

SUBMITTED_BY = "factory job submit"

#: Sources whose submit is SIGNED as operator approval (finding 7, 2026-11-02).
#: ``pa`` relays a plan its human approved; ``human`` is the human at the CLI.
#: Any other ``--source`` (a bot, a webhook, a scanner) is NOT operator intent
#: just because it reached this CLI: its direction is written without an
#: approval record and waits for ``factory approve-direction`` under the
#: normal approval policy (``factory.directions.approval``).
AUTO_APPROVED_SOURCES: frozenset[str] = frozenset({"pa", "human"})


@dataclass
class SubmitRequest:
    title: str
    ask: str
    app: str | None = None
    repo: str | None = None
    done: list[str] = field(default_factory=list)
    pipeline: str = "auto"
    delivery: str | None = None
    models: list[str] = field(default_factory=list)
    source: str = ""
    external_id: str | None = None
    flow_md: str | None = None
    api_spec_md: str | None = None
    kind: str = "code"  # v1.2: code | research | report
    runtime: str = "api"  # v1.2: api | claude_session
    branch: str | None = None  # v1.3: continue on this existing branch
    pr: int | None = None  # v1.3: continue on this existing PR


# --------------------------------------------------------------------------- #
# Resolution / validation
# --------------------------------------------------------------------------- #


def resolve_repo(root: Path, repo: str) -> str:
    """``owner/name`` → the registered app whose ``config.yaml`` names it."""
    want = repo.strip().lower().removesuffix(".git")
    if want.startswith("https://github.com/"):
        want = want[len("https://github.com/") :]
    matches: list[str] = []
    for app in registered_apps(root):
        try:
            cfg = load_app_config(app, root)
        except Exception:  # noqa: BLE001 - one broken config must not hide the rest
            continue
        if cfg.repo.strip().lower() == want:
            matches.append(app)
    if not matches:
        raise JobError("unknown_repo", f"no registered app for repo {repo!r}")
    if len(matches) > 1:
        raise JobError(
            "ambiguous_repo",
            f"repo {repo!r} is registered by several apps ({', '.join(matches)}); pass --app",
        )
    return matches[0]


def resolve_app(root: Path, app: str | None, repo: str | None) -> tuple[str, AppConfig]:
    if not app and not repo:
        raise JobError("missing_argument", "one of --app or --repo is required")
    if repo:
        from_repo = resolve_repo(root, repo)
        if app and app != from_repo:
            raise JobError(
                "app_repo_mismatch",
                f"--app {app!r} does not match --repo {repo!r} (registered as {from_repo!r})",
            )
        app = from_repo
    assert app is not None
    if app not in registered_apps(root):
        raise JobError("unknown_app", f"no registered app {app!r} (apps/{app}/config.yaml)")
    try:
        cfg = load_app_config(app, root)
    except Exception as exc:  # noqa: BLE001
        raise JobError("invalid_app_config", f"apps/{app}/config.yaml: {exc}") from exc
    return app, cfg


def resolve_routing(
    cfg: AppConfig,
    models: list[str],
    pipeline: str | None,
    *,
    runtime: str | None = None,
    claude_model: str | None = None,
) -> JobRouting:
    """Validate the job's ``--model`` / ``--pipeline`` request with the SAME
    resolver spawn uses (``factory.job_routing.resolve_job_routing``), so a
    request submit accepts is one spawn will honour — and a bad one (bare model
    id without ``<provider>/``, unknown persona, reviewer/dev collision, solo
    that cannot run) is refused here, before any direction is written.
    ``JobRoutingError`` codes pass through unchanged (docs/JOBS-API.md).
    """
    try:
        return resolve_job_routing(
            cfg,
            job_models=parse_model_flags(models) if models else None,
            pipeline=pipeline,
            source="factory job submit --model",
            runtime=runtime,
            claude_model=claude_model,
        )
    except JobRoutingError as exc:
        raise JobError(exc.code, exc.message) from exc


def effective_pipeline(cfg: AppConfig, requested: Any, runtime: Any = None) -> str:
    """The pipeline a job resolves to (``auto`` → ``AppConfig.pipeline_default``,
    whose ``auto`` means ``chain``; with ``runtime: claude_session``, ``auto`` →
    ``solo``). Read path (status/resubmit): never raises — a request that can no
    longer be honoured reports the raw request."""
    req = str(requested) if requested else None
    if runtime == RUNTIME_CLAUDE and (req or "auto") == "auto":
        req = "solo"
    try:
        return resolve_pipeline(req, cfg)[0]
    except JobRoutingError:
        return str(requested or "auto")


def _demote_headings(text: str) -> str:
    """Turn markdown headings in the ask into bold lines.

    The ask is embedded under ``## Why``; a heading inside it would end that
    section early (``parser._parse_why``) or open a fake ``Acceptance
    Criteria`` section. The verbatim ask is kept in ``artifacts/ask.md``.
    """
    return re.sub(r"(?m)^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$", r"**\1**", text)


def _approval_record(source: str, external_id: str | None) -> dict[str, Any]:
    """The signed approval a ``pa`` / ``human`` job carries.

    The approval gate (``factory.directions.approval``) exists to stop the
    factory filing work for ITSELF. A job filed by the human, or by the PA
    acting on a plan its human approved, is operator intent, so it is
    recorded as an explicit, signed approval rather than left to wait in
    ``factory inbox`` for a redundant second yes. Only
    ``AUTO_APPROVED_SOURCES`` get one.
    """
    note = f"submitted via '{SUBMITTED_BY}' (source={source}"
    note += f", external_id={external_id})" if external_id else ")"
    return {
        "approved": True,
        "approved_by": f"{SUBMITTED_BY}:{source}",
        "approved_at": datetime.now(UTC).isoformat(),
        "note": note,
    }


@contextlib.contextmanager
def _submit_lock(root: Path) -> Iterator[None]:
    """Serialise submits: id allocation and the idempotency scan must be atomic
    with the write, or two concurrent resubmits create two jobs."""
    lock_path = state_db_path(root).parent / "jobs-submit.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    from factory.oscompat import lock_file, unlock_file

    with lock_path.open("a+") as handle:
        lock_file(handle)
        try:
            yield
        finally:
            unlock_file(handle)


def claude_available() -> tuple[bool, str]:
    """Seam: the ``claude_session`` availability check (tests replace it)."""
    from factory.claude_session.cli import check_available

    return check_available()


def _require_claude() -> None:
    ok, detail = claude_available()
    if not ok:
        raise JobError("runtime_unavailable", f"claude_session is not available here: {detail}")


def _with_claude_check[T](needed: bool, work: Callable[[], T]) -> T:
    """``work()`` with the claude_session check running alongside it.

    Both take about a second (``claude auth status``; a GitHub read), so a
    ``--pr`` submit on claude_session waits for the slower, not the sum. The
    check's refusal wins over whatever ``work`` raised, as when it ran first.
    """
    if not needed:
        return work()
    with ThreadPoolExecutor(max_workers=1) as pool:
        check = pool.submit(_require_claude)
        try:
            out = work()
        except JobError:
            check.result()
            raise
        check.result()
        return out


def find_existing(root: Path, source: str, external_id: str) -> Any:
    for ref in iter_jobs(root):
        if (
            str(ref.meta.get("source") or "") == source
            and str(ref.meta.get("external_id") or "") == external_id
        ):
            return ref
    return None


# --------------------------------------------------------------------------- #
# Submit
# --------------------------------------------------------------------------- #


def submit_job(root: Path, req: SubmitRequest) -> dict[str, Any]:
    """Create (or return the existing) job. Returns the contract's success shape."""
    root = Path(root)
    title = (req.title or "").strip()
    if not title:
        raise JobError("missing_argument", "--title is required")
    ask = (req.ask or "").strip()
    if not ask:
        raise JobError("missing_argument", "one of --ask or --ask-file is required (non-empty)")
    source = (req.source or "").strip()
    if not source:
        raise JobError(
            "missing_argument", "--source is required (pa | human | <other>; see JOBS-API.md)"
        )
    # SHOULD 7 (review 2026-11-02): single-line fields are written into
    # direction.md headings/list items; a CR/LF would inject a section
    # (e.g. a fake "## Acceptance Criteria"). Refuse rather than sanitise.
    for flag, value in (
        ("--title", title),
        ("--source", source),
        ("--external-id", req.external_id or ""),
        *(("--done", d) for d in req.done),
    ):
        if "\n" in value or "\r" in value:
            raise JobError("invalid_argument", f"{flag} must be a single line (no CR/LF)")
    external_id = (req.external_id or "").strip() or None

    # v1.2: kind + runtime. The defaults (code, api) are exactly v1/v1.1.
    kind = normalize_kind(req.kind)
    if kind is None:
        raise JobError(
            "invalid_kind", f"--kind must be one of {', '.join(KINDS)}, got {req.kind!r}"
        )
    runtime = normalize_runtime(req.runtime)
    if runtime is None:
        raise JobError(
            "invalid_runtime",
            f"--runtime must be one of {', '.join(RUNTIMES)}, got {req.runtime!r}",
        )
    model_flags, claude_model = split_claude_model(list(req.models))
    if claude_model and runtime != RUNTIME_CLAUDE:
        raise JobError(
            "bad_model_flag",
            f"--model {CLAUDE_MODEL_KEY}=... names a Claude Code model; it needs "
            f"--runtime {RUNTIME_CLAUDE}",
        )
    wants_pickup = bool((req.branch or "").strip()) or req.pr is not None
    if runtime == RUNTIME_CLAUDE and not wants_pickup:
        # A pickup checks it alongside its GitHub read (_with_claude_check).
        _require_claude()
    if wants_pickup and kind in TASK_KINDS:
        raise JobError(
            "invalid_argument", f"--branch/--pr only apply to code jobs (got --kind {kind})"
        )
    if (req.branch or "").strip() and req.pr is not None:
        raise JobError("invalid_argument", "pass only one of --branch or --pr")
    if kind in TASK_KINDS:
        return _submit_task(
            root, req, kind, runtime, title, source, external_id, model_flags, claude_model
        )

    pipeline = (req.pipeline or "auto").strip().lower()
    if pipeline not in PIPELINES:
        raise JobError("bad_pipeline", f"--pipeline must be one of {', '.join(PIPELINES)}")
    try:
        # Every level is accepted, push_to_main included: there is no per-app
        # ceiling (operator decision 2026-11-02); the request is the level.
        requested = parse_level(req.delivery)
    except ValueError as exc:
        raise JobError("invalid_delivery", str(exc)) from exc
    app, cfg = resolve_app(root, req.app, req.repo)
    routing = resolve_routing(
        cfg, model_flags, pipeline, runtime=runtime, claude_model=claude_model
    )
    pickup = None
    if wants_pickup:
        if external_id:
            # A resubmit returns the original job without asking GitHub again
            # (the PR may have merged since; that must not turn into an error).
            existing = find_existing(root, source, external_id)
            if existing is not None:
                if runtime == RUNTIME_CLAUDE:
                    _require_claude()
                return _result(root, existing.app, existing.dir_path, existing.meta, created=False)
        if requested is not None and requested.value == "push_to_main":
            raise JobError(
                "invalid_delivery",
                "--delivery push_to_main cannot be combined with --branch/--pr "
                "(the work stays on the picked-up branch)",
            )
        from factory.jobs.pickup import resolve_pickup

        pickup = _with_claude_check(
            runtime == RUNTIME_CLAUDE,
            lambda: resolve_pickup(
                cfg.repo, cfg.default_branch or "main", branch=req.branch, pr=req.pr
            ),
        )
    # Frontmatter keeps the JOB's own request (``models:`` persona → model id,
    # ``pipeline:`` as requested) — exactly the keys
    # ``job_routing.resolve_for_direction`` reads at spawn.
    models = {
        k: v for k, v in routing.model_overrides.items() if routing.model_sources.get(k) == "job"
    }
    auto_approved = source in AUTO_APPROVED_SOURCES

    with _submit_lock(root):
        if external_id:
            existing = find_existing(root, source, external_id)
            if existing is not None:
                return _result(root, existing.app, existing.dir_path, existing.meta, created=False)
            existing_task = find_existing_task(root, source, external_id)
            if existing_task is not None:
                return _task_result(existing_task, created=False)

        if pickup is not None:
            busy = _branch_busy(root, app, pickup.branch)
            if busy:
                raise JobError(
                    "branch_busy",
                    f"job {busy} is still working on branch {pickup.branch!r}; wait for it, "
                    "cancel it, or resume it instead",
                )

        direction_id = next_direction_id(app, root)
        slug = slugify(title)
        directions_dir = root / "apps" / app / "directions"
        directions_dir.mkdir(parents=True, exist_ok=True)
        final = directions_dir / f"{direction_id}-{slug}"
        if final.exists():
            raise JobError("conflict", f"direction directory already exists: {final}")
        staging = directions_dir / f".job-staging-{uuid.uuid4().hex[:12]}"
        staging.mkdir()
        try:
            meta = {
                "source": source,
                "external_id": external_id,
                "pipeline": pipeline,
                "delivery": requested.value if requested else None,
                "models": models,
            }
            if pickup is not None:
                # v1.3, written only for a pickup so a v1 job's frontmatter is
                # unchanged (factory/chain/pickup.py reads it at spawn).
                meta["base"] = pickup.frontmatter()
            if runtime != RUNTIME_API:
                # Written only when not the default, so a v1 job's frontmatter
                # is exactly what it was.
                meta["runtime"] = runtime
                if claude_model:
                    meta["claude_model"] = claude_model
            why = (
                _demote_headings(ask)
                + (
                    f"\n\n_Submitted by `{source}`"
                    + (f" (external id `{external_id}`)" if external_id else "")
                    + " via `factory job submit`. The requester's verbatim ask is "
                    "`artifacts/ask.md`._"
                )
                + (_pickup_note(pickup) if pickup is not None else "")
            )
            (staging / "direction.md").write_text(
                _build_direction_md(
                    title=title,
                    type_tag=None,
                    why=why,
                    acceptance=[d for d in req.done if d.strip()],
                    explore=False,
                    extra_frontmatter=meta,
                ),
                encoding="utf-8",
            )
            (staging / "artifacts").mkdir()
            (staging / "artifacts" / "ask.md").write_text(req.ask, encoding="utf-8")
            if pickup is not None and pickup.review_md:
                (staging / "artifacts" / "pr_review_threads.md").write_text(
                    pickup.review_md.rstrip() + "\n", encoding="utf-8"
                )
            if req.flow_md and req.flow_md.strip():
                (staging / "flow.md").write_text(req.flow_md, encoding="utf-8")
            if req.api_spec_md and req.api_spec_md.strip():
                (staging / "api_spec.md").write_text(req.api_spec_md, encoding="utf-8")
            _write_initial_state_yaml(staging, source=source)
            if auto_approved:
                state_path = staging / "state.yaml"
                state = yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
                state[APPROVAL_KEY] = _approval_record(source, external_id)
                state.setdefault("audit", []).append(
                    {
                        "ts": state[APPROVAL_KEY]["approved_at"],
                        "by": SUBMITTED_BY,
                        "event": "operator_approved",
                        "details": {"source": source, "external_id": external_id},
                    }
                )
                state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
            os.rename(staging, final)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    _record_direction_row(root, app, direction_id, slug, source)
    result = _result(root, app, final, meta, created=True, cfg=cfg)
    result["warnings"] = (
        list(routing.warnings)
        + (list(pickup.warnings) if pickup is not None else [])
        + result["warnings"]
    )
    # Tell a running `factory serve` to tick this app now, not in <= 5 min.
    from factory.scheduler.serve import request_wake

    request_wake(root, app, reason=f"submit {result.get('job_id')}")
    return result


def _pickup_note(pickup: Any) -> str:
    """What the dev must know about the branch it continues on (v1.3)."""
    where = f"`{pickup.branch}`"
    if pickup.pr:
        where += f" (open PR #{pickup.pr} into `{pickup.into}`)"
    note = (
        f"\n\n**Existing work.** This job continues on the existing branch {where}. "
        "Build on what is already there; do not start over or revert it. The factory "
        "commits onto that branch"
        + (" and updates that PR (it opens no new one)." if pickup.pr else ".")
    )
    if pickup.review_md:
        note += (
            "\n\n**Unresolved review comments on the PR** (snapshot at submit; also "
            "`artifacts/pr_review_threads.md`). Address each one that is still valid:\n\n"
            + _demote_headings(pickup.review_md)
        )
    return note


def base_view(meta: dict[str, Any]) -> dict[str, Any] | None:
    """The ``base`` field of submit/status (v1.3): ``{"branch", "pr", "into"}``."""
    from factory.chain.pickup import pickup_of_meta

    return pickup_of_meta(meta)


def _branch_busy(root: Path, app: str, branch: str) -> str | None:
    """The id of an unfinished job of ``app`` already on ``branch``, else None."""
    from factory.jobs.status import TERMINAL_JOB_STATES, job_status

    for ref in iter_jobs(root, app=app):
        base = base_view(ref.meta)
        if base is None or base["branch"] != branch:
            continue
        try:
            state = job_status(root, ref.job_id, github=False)["state"]
        except Exception:  # noqa: BLE001 - unknown = busy (fail safe)
            return ref.job_id
        if state not in TERMINAL_JOB_STATES:
            return ref.job_id
    return None


def _record_direction_row(root: Path, app: str, direction_id: str, slug: str, source: str) -> None:
    """Write the authoritative ``directions`` row (status ``created`` + source).

    Best-effort: ``state.yaml`` already carries the same facts, so a DB hiccup
    leaves a buildable job, and the gate's fail-safe covers the rest.
    """
    try:
        from sqlmodel import Session

        from factory.directions.schema import upsert_direction
        from factory.directions.watcher import _engine

        with Session(_engine(state_db_path(root))) as session:
            upsert_direction(
                session,
                app,
                direction_id,
                slug,
                "created",
                updated_by=SUBMITTED_BY,
                source=source,
            )
    except Exception as exc:  # noqa: BLE001
        print(f"warning: could not write directions row: {exc!r}", file=sys.stderr)


def _result(
    root: Path,
    app: str,
    dir_path: Path,
    meta: dict[str, Any],
    *,
    created: bool,
    cfg: AppConfig | None = None,
) -> dict[str, Any]:
    from factory.backpressure.validator import validate_direction

    cfg = cfg or load_app_config(app, root)
    direction = parse_direction_dir(app, dir_path)
    requested = meta.get("delivery")
    out: dict[str, Any] = {
        "job_id": format_job_id(app, direction.id),
        "app": app,
        "direction_id": direction.id,
        "direction_path": str(dir_path),
        "pipeline": effective_pipeline(cfg, meta.get("pipeline"), meta.get("runtime")),
        "delivery": effective_level(cfg.delivery, requested).value,
        "delivery_requested": requested if requested else None,
        "created": created,
        "kind": "code",
        "runtime": str(meta.get("runtime") or "api"),
        "base": base_view(meta),
    }
    # Additive (not in the v1 success shape): a job with no flow.md, no
    # api_spec.md and no explore tag fails the backpressure gate
    # deterministically at pm-sync and lands in needs_human. Say so now.
    warnings: list[str] = []
    try:
        validation = validate_direction(direction)
    except Exception:  # noqa: BLE001 - a classifier crash must not fail a submit
        validation = None
    if validation is not None and not validation.is_valid:
        warnings.append(
            "backpressure: pm-sync will mark this job needs-direction (missing: "
            + ", ".join(validation.missing)
            + "); add --flow-file or --api-spec-file, or criteria that name an observable"
        )
    if validation is not None:
        warnings += [f"backpressure: {issue}" for issue in validation.issues]
    # v1.6: a job for an app nothing ticks is accepted and then never starts.
    from factory.scheduler.coverage import read_coverage

    coverage = read_coverage(root)
    out["ticked"] = coverage.ticked(app)
    not_ticked = coverage.why_not(app)
    if not_ticked:
        warnings.append(f"ticker: {not_ticked}; until then this job stays queued")
    approval = read_state_yaml(dir_path).get(APPROVAL_KEY)
    if not (isinstance(approval, dict) and approval.get("approved")):
        try:
            from factory.directions.approval import awaiting_operator_approval

            direction.status = "created"
            pending = awaiting_operator_approval(direction)
        except Exception:  # noqa: BLE001
            pending = True
        if pending:
            warnings.append(
                f"approval: source {meta.get('source')!r} is not auto-approved "
                f"({', '.join(sorted(AUTO_APPROVED_SOURCES))} are); the job waits for "
                f"'factory approve-direction {direction.id} --app {app}'"
            )
    out["warnings"] = warnings
    return out


# --------------------------------------------------------------------------- #
# research / report (v1.2)
# --------------------------------------------------------------------------- #


def _submit_task(
    root: Path,
    req: SubmitRequest,
    kind: str,
    runtime: str,
    title: str,
    source: str,
    external_id: str | None,
    model_flags: list[str],
    claude_model: str | None,
) -> dict[str, Any]:
    """A research/report job: no direction, no PR. See ``factory.jobs.tasks``."""
    from factory.job_routing import validate_model_map

    try:
        requested = parse_level(req.delivery)
    except ValueError as exc:
        raise JobError("invalid_delivery", str(exc)) from exc
    if requested is not None and requested.value != "none":
        raise JobError(
            "invalid_delivery",
            f"a {kind} job delivers a report kept by the factory; --delivery can only be "
            f"none (got {requested.value})",
        )
    app: str | None = None
    repo: str | None = None
    if req.app or req.repo:
        app, cfg = resolve_app(root, req.app, req.repo)
        repo = cfg.repo
    try:
        models = validate_model_map(
            parse_model_flags(model_flags) if model_flags else None,
            source="factory job submit --model",
        )
    except JobRoutingError as exc:
        raise JobError(exc.code, exc.message) from exc
    warnings: list[str] = []
    if (req.pipeline or "auto").strip().lower() != "auto":
        warnings.append(f"--pipeline is ignored for a {kind} job (one agent writes the report)")
    if req.flow_md or req.api_spec_md:
        warnings.append(f"--flow-file/--api-spec-file are ignored for a {kind} job")
    with _submit_lock(root):
        if external_id:
            existing = find_existing(root, source, external_id)
            if existing is not None:
                return _result(root, existing.app, existing.dir_path, existing.meta, created=False)
        ref, created = create_task(
            root,
            kind=kind,
            runtime=runtime,
            title=title,
            ask=req.ask,
            app=app,
            repo=repo,
            done=[d.strip() for d in req.done if d.strip()],
            models=models,
            claude_model=claude_model,
            source=source,
            external_id=external_id,
        )
    out = _task_result(ref, created=created)
    if created:
        out["warnings"] = warnings
        # A running `factory serve` dispatches it within a second.
        from factory.scheduler.serve import request_wake

        request_wake(root, ref.app, reason=f"submit {ref.job_id}")
    return out


def _task_result(ref: TaskRef, *, created: bool) -> dict[str, Any]:
    meta = ref.meta
    return {
        "job_id": ref.job_id,
        "app": ref.app,
        "direction_id": ref.task_id,
        "direction_path": str(ref.dir_path),
        "pipeline": None,
        "delivery": "none",
        "delivery_requested": None,
        "created": created,
        "kind": str(meta.get("kind")),
        "runtime": str(meta.get("runtime") or "api"),
        "base": None,
        "ticked": None,
        "warnings": [],
    }
