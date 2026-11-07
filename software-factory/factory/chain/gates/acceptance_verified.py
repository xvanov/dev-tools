"""Gate: ``acceptance-verified`` — 019 AC2 (gutted-implementation control) +
AC3 (out-of-process verdict).

The problem this closes
========================

Loop-4 makes the dev author AND run its own tests, so a coder that writes the
tests judging it can reward-hack. This gate is the INDEPENDENT layer: it runs
an acceptance test authored from the direction's acceptance criteria — the SPEC
ONLY, blind to the dev's code and tests (``factory.chain.acceptance``) — and
until 2026-08-07 it did so by having ``pytest`` IMPORT the diff's production
code and run in the SAME interpreter that computed the verdict. That carried a
forgery hole no file-level rollback could close: three lines of production
code reassigning ``pytest``'s own test-runner machinery forged a genuine-
looking red-at-base -> green-at-HEAD
(``tests/test_acceptance_oracle_green_means_something.py``, formerly an
``xfail(strict=True)``; it now hard-passes).

**THE FIX (019 AC3): the verdict is computed by a SEPARATE process driving a
BOOTED instance of the app over HTTP** — the ``smoke_green`` pattern
(``factory.chain.boot`` + ``factory.chain.oracle_run``). The oracle process
never imports a single line the diff wrote; its only channel to the app under
test is the network. Reassigning ``pytest`` internals inside the booted app's
own process cannot forge a verdict computed in a DIFFERENT process.

**THE OTHER HALF (019 AC2): the gutted-implementation control.** Booting a
real instance closes the in-process forgery, but it does not by itself stop a
criterion set that only asserts status codes and absences (the vacuity class,
Beer et al. 2001) — a fixed no-op ``200 {}`` responder would satisfy such a
criterion just as well as a correct implementation. So before crediting
anything, the SAME oracle also runs against a catch-all stub
(``factory.chain.stub_server``) that answers every request with ``200 {}``.
Only a criterion that PASSES at HEAD and FAILS (or errors) against the stub is
credited (the set ``K``); a criterion set where nothing survives that
exclusion is ``vacuous_oracle`` and blocks BEFORE a single real boot is paid
for.

Run order is cheapest evidence first: **stub → prerequisite check → HEAD boot →
BASE boot → ablation**. A bad oracle never pays for a boot; a missing
dependency (a DB container down) never pays for two.

Crediting algebra (``red_green.verdict_over``)
===============================================
Let ``K = {c : HEAD[c] == PASS and STUB[c] in {FAIL, ERROR}}``. ``K`` empty ⇒
``vacuous_oracle``. Otherwise the merge-base run is graded OVER ``K`` ONLY:
at least one ``FAIL`` in ``K`` at the base ⇒ ``red`` **candidate**; every
member of ``K`` already ``PASS`` at the base ⇒ ``green`` ⇒
``oracle_not_discriminating``; anything else (``ERROR``/``SKIP``/``MISSING``
only, or the base never booted) ⇒ ``unknown`` ⇒ fall through to the ablation
fallback (``mutation.check_can_fail``, driven here through ``oracle_probe.py``
so the ablation's OWN check is also computed out of process). An ``ERROR`` at
the base is deliberately NOT counted as red — the same reason
``red_green.base_verdict`` excludes it: a criterion that could not even be
OBSERVED is not evidence that its assertion discriminates anything.

A ``red`` candidate is credited as ``red`` only if CORROBORATED (KNOWN OPEN #1,
closed 2026-08-07/08, ``_base_run``): either some criterion in ``K`` already
PASSED at the base, or a direct, factory-issued probe against the live base
instance (``boot.probe_paths``/``served_a_real_route``) got back something
other than a 5xx. An uncorroborated all-FAIL-over-``K`` base — every credited
criterion failing for a reason that could equally be "the app never really
came up" — downgrades to ``unknown`` and falls through to the same ablation
fallback, instead of being credited on a base that was never shown to be
doing anything but failing.

What "blocking" keys off
=========================
Required-ness is a property of the APP (``gates.acceptance_oracle``), not a
DB flag; per-story applicability is re-derived from the spec
(``acceptance.acceptance_expected_for_story``). Resolution:

* Not opted in: PASS (skip). Opted in, no ACs: PASS (not applicable).
* Expectation unresolvable, or the stored oracle missing/unreadable: BLOCK
  authoritatively (self-heals via ``acceptance.reauthor_missing_oracles``).
* Dry-run / no checkout: BLOCK non-authoritatively (cannot verify).
* Cannot-run states (no boot recipe configured, the oracle statically imports
  app code, the factory's own httpx/pytest are unavailable, a prerequisite
  like a DB container is down, the stub or the runner itself is unreadable):
  BLOCK non-authoritatively and NEVER WAIVABLE — these are the gate's own
  fault or an operator config gap, and a human waving them through would ship
  something nobody verified.
* HEAD run fails an assertion, is vacuous, or every credited criterion already
  passes at the base: BLOCK authoritatively (or ``oracle_not_discriminating``,
  waivable — the oracle itself is the problem, not necessarily the dev).
* HEAD run is errors-only AND the booted app did not stay alive/healthy:
  ``app_crashed_during_run`` — non-authoritative, waivable (we cannot tell a
  wrong implementation from an app that crashed under the oracle's load).
* Credited, red at base (or failability proven by ablation), green at HEAD:
  PASS, ``authoritative=True``, ``verified=True``.
* Any infrastructure error inside this gate: AUTHORITATIVE BLOCK (the
  ``evaluate()`` wrapper below).

Waivable: ``no_merge_base``, ``base_equals_head``, ``diff_unreadable``,
``no_judge_tree``, ``channel_restore_failed``, ``oracle_not_discriminating``,
``failability_unverified``, ``head_boot_failed``, ``app_crashed_during_run``,
``oracle_run_unreadable``, ``vacuous_oracle``, ``oracle_timeout``.
NEVER waivable: the provenance pair, ``conflicting_summaries``,
``oracle_runner_unconfigured``, ``oracle_imports_app_code``,
``environment_unavailable``.

What still applies, and why (belt-and-braces, not load-bearing any more)
=========================================================================
The judge-tree provenance checks, the collection-channel rollback, and the
``pyproject.toml`` pytest/dependency split (``red_green.rollback_pytest_config_
only``) all predate this gate's in-process history, when they closed real
forced-pass attacks against a pytest run inside the dev's own collection
config. Under the out-of-process runner NONE of that machinery grades
anything any more — the oracle never touches the app's test tree at all, it
only drives a booted server over HTTP — so a hostile ``conftest.py`` has
nothing left to attach to. It stays anyway, for two reasons: (1) the ablation
fallback's scratch clone boots a MUTATED copy of the SAME tree, and a manifest
whose dependencies were reverted to the base would silently break that boot
for any story that adds a dependency — the split still matters there; (2) it
is cheap, already tested, and removing it buys nothing but a chance to get it
wrong on a rewrite. Read it as defence in depth for the ablation clone, not as
protection for the primary HTTP path.

KNOWN OPEN (2026-08-07, #1 closed 2026-08-07/08) — ranked, read before the
AC4 supervised flip
======================================================================
An adversarial review reproduced two forgeries against the first cut of this
gate (a HEAD-planted ``conftest.py`` in the oracle's own run dir, and an
in-place overwrite of the oracle file) — both closed below by
``oracle_run``'s post-run tamper check + ``--noconftest``. Of the four risks
that remained open, #1 is now closed; #2-#4 still have a v1.1 candidate:

1. **CLOSED 2026-08-07/08 — a healthy-but-semantically-broken BASE forging
   red.** ``boot._poll_health`` used to return healthy on the FIRST response
   ``< 400`` — a health endpoint that answers before its OWN dependency (a DB
   pool) is ready made the base respond 500 to EVERYTHING while still passing
   the poll; every credited criterion then failed at base (all-FAIL over
   ``K``) ⇒ ``red`` ⇒ CREDIT, cached in ``base_runs.json``. Two independent
   mechanisms now close this: (a) ``boot._poll_health`` requires
   ``_HEALTH_CONSECUTIVE_REQUIRED`` (2) BACK-TO-BACK healthy polls, reset to
   zero by any non-2xx/3xx response, hardening against a flaky boot; (b) the
   real fix, in ``_base_run``: an all-FAIL-over-``K`` base is no longer
   trusted as ``red`` on its own — it must be independently corroborated,
   either by at least one credited criterion having already PASSED at base,
   or by ``boot.probe_paths``/``served_a_real_route`` finding the LIVE base
   instance answered at least one direct, factory-issued request (built from
   the "METHOD /path" samples the required stub run already observed — no
   app-route knowledge is assumed, and the oracle's own internals are never
   parsed) with anything other than a 5xx. Failing that corroboration
   downgrades the candidate ``red`` to ``unknown`` — which falls through to
   the ablation route, is never cached (``cache_put`` already only persists
   ``red``/``green``), and can still credit the story if the ablation
   independently proves failability. See ``tests/oracle_boot_fixture.py``'s
   ``broken_at_base`` mode and the regression tests in
   ``tests/test_acceptance_oracle_green_means_something.py`` (search
   "KNOWN_OPEN_1"). Residual: the probe is a BLIND replay (no body, no auth) —
   a body-validating route may 4xx instead of exercising its real logic, so a
   4xx is accepted as "served for real" even though it proves less than a
   2xx would; this is a deliberate, stated fail-safe trade-off (a non-5xx is
   still evidence the route ran past whatever wraps the broken dependency in
   a blanket 500), not a claim that the corroboration is airtight.
2. **Shared-DB cross-run contamination — the HEAD/BASE half is closed
   (2026-08-09); two residuals remain.** The worst case was not the
   hardcoded identifier the first writeup described: the run id itself was
   ``head-{sid}``/``base-{sid}``, deterministic per story, so a CORRECTLY
   namespaced oracle collided with its own previous evaluation's rows (every
   new dev commit re-evaluates gates at the new head_sha) — observed as
   story 179's ``accept_head-179_*`` users left in the shared dev Postgres.
   ``_evaluate`` now appends a per-evaluation nonce, making
   ``ACCEPTANCE_RUN_ID`` genuinely unique for the HEAD and BASE runs, as the
   authoring prompt has always promised. RESIDUALS, still open:
   (a) the ABLATION route (``_ablation_can_fail``) is untouched — its run id
   is ``ablation-{head_ref[:12]}`` and, worse, ``mutation.check_can_fail``
   runs its green baseline and every mutant with the IDENTICAL command
   string, so an oracle that creates namespaced rows self-collides between
   baseline and mutant. Mostly fail-safe (the mutant reds before reaching
   the mutation → ``skipped`` → not proven → block), with one narrow
   fail-open: a mutation whose raise is swallowed still "kills" via the
   collision 409. Noncifying it needs a per-invocation nonce minted inside
   ``oracle_probe`` AND an ablation cache key that stops hashing the command
   string — deferred, not forgotten; the base-red route (the normal path)
   does not use it. (b) an oracle that ignores the run id and hardcodes an
   identifier still collides; enforcing "must reference ACCEPTANCE_RUN_ID"
   statically would false-block oracles that create nothing (story 172's
   reads it never). Also note: the nonce converts a loud self-collision into
   silent growth of ``accept_*`` rows in the shared dev Postgres — nothing
   reaps them today; ``run_ids.json`` next to the run caches records every
   id that ACTUALLY executed (gate ``details`` survive only on the fail
   path), preserving the mapping from row to evaluation. Do NOT "fix" any
   of this by running the HEAD oracle twice
   and requiring both green — before the nonce, that false-blocked the
   persona-sanctioned namespacing pattern by construction.
3. **Non-2xx-status criteria are credited too EASILY (docstring corrected
   2026-08-09 — the previous text had this backwards).** Both stub variants
   answer 200, so a bare ``assert status == 401`` FAILS the stub and is
   CREDITED into ``K`` (verified on story 179's ``stub_runs.json``: its ac3
   fails both variants), not excluded. The real risk is therefore mirror-
   image: a broken app that 401s/404s EVERYTHING satisfies such a criterion,
   so it discriminates less than its credit implies. Measured 2026-08-09 on
   the authored oracles then under ``state/acceptance/sacrifice/`` (runtime
   state, not reproducible from the repo): of 20 non-skipped criteria,
   exactly 1 was a pure status-only criterion, and it PASSED at base,
   contributing nothing to the verdict — immaterial that day. v1.1 if it
   ever matters: a third stub variant
   answering a plausible non-2xx (costs a STUB_VERSION bump, invalidates
   every cached stub run, and strictly raises the block rate).
4. **Behavioural mimicry.** Nothing here defends against production code that
   inspects its OWN request patterns (rate, path enumeration order, timing)
   to distinguish "being graded" from real traffic and behaves correctly only
   under grading. Not evidenced, not defended against, structurally hard to
   rule out for ANY black-box oracle.
5. **Arrange-blind base runs (A3's other half, open 2026-08-09).** A3
   classifies SETUP failures at HEAD for REPORTING only. ``_base_run`` and
   the ablation probe still read a base-red produced by an ARRANGE failure
   (the prerequisite route the story adds does not exist at base — the
   normal shape for prerequisite-state stories) as genuine discrimination:
   the criterion "fails at base", is credited, and the gate PASSES. That is
   in the false-GREEN direction and it is the exact D-2 shape. Any fix must
   NOT naively exclude setup-failing criteria from base-red (that would
   false-block the legitimate prerequisite-route case); it needs the
   arrange step's own target route distinguished from the criterion's.
   Until then: ``base_runs.json`` + ``setup_failures`` in run artifacts are
   the audit trail.

Compositional note (F4×ablation; distinct from the closed #1 above — this is
the base failing to BOOT AT ALL, not booting healthy-but-broken): a HEAD that
exhausts a shared resource can make ``base`` fail to boot at all, steering
the gate onto the K-BLIND-if-unfixed ablation route instead of the stronger
base-red route — the ablation probe's ``--credit`` awareness
(``oracle_probe.py``) is what defangs that steering, not a coincidence:
whichever route the gate ends up on, only a FAIL on a criterion in ``K`` can
license a credit. The closed #1's downgrade-to-``unknown`` composes the same
way: it lands on the exact same K-aware ablation route, not a weaker one.

⚠ ISOLATION BOUNDARY, STATED PLAINLY: everything in this module assumes the
booted app and the oracle process share a MACHINE and a UNIX USER. That is a
PROCESS boundary, not a PRIVILEGE boundary — a same-user attacker can always
list ``/tmp``. ``oracle_run._tamper_check`` makes a same-user attack
SELF-DEFEATING (detected, blocked, authoritative), not impossible. A
different uid or a container per boot removes the assumption entirely and is
the real v1.1 closure; nothing here should be read as claiming that boundary
already exists.
"""

from __future__ import annotations

import secrets
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from factory.app_config import AcceptanceBootConfig, AppConfig
from factory.chain import boot as boot_mod
from factory.chain import oracle_run, stub_server
from factory.chain.acceptance import (
    ORACLE_COPY_GLOB,
    ORACLE_COPY_PREFIX,
    acceptance_dir,
    acceptance_expected_for_story,
    author_exhausted,
    author_passes,
    clear_gate_block,
    oracle_sha256,
    read_waiver,
    record_gate_block,
    ref_is_readable,
    sweep_leaked_oracles,
    unremovable_oracle_leaks,
)
from factory.chain.gates.evaluator import GateResult, PRContext
from factory.chain.red_green import (
    cache_get,
    cache_put,
    changed_paths_since,
    extra_commits_beyond,
    head_contains_sha,
    head_sha,
    is_dependency_manifest,
    judge_worktree,
    resolve_base_sha,
    restore_paths_from,
    rollback_pytest_config_only,
    run_key,
    verdict_over,
)
from factory.diff_paths import is_collection_channel_path, is_production_path

_LABEL = "acceptance-verified"

# factory/chain/gates/acceptance_verified.py -> factory/chain/oracle_probe.py
_ORACLE_PROBE_PATH = Path(__file__).resolve().parent.parent / "oracle_probe.py"

# Ablation targets: capped by the repo rule that nothing loops more than 3
# times, and because the first target is the symbol the diff changed MOST.
_MAX_ABLATION_TARGETS = 3
# Per-attempt ceiling for the ablation's oracle_probe invocation: one attempt
# is a green baseline boot+run PLUS a mutant boot+run, so it needs roughly
# twice a boot plus one run, with slack.
_ABLATION_BUDGET_S = 1200
# Below this there is no point starting another target.
_ABLATION_MIN_RUN_BASE_S = 120
# HARD wall clock for the WHOLE gate (stub + prerequisite + HEAD boot + BASE
# boot + ablation), checked before each expensive step. Running out of budget
# is "not proven" — the block stands, waivable, never an approve.
_GATE_BUDGET_S = 1800


@dataclass
class _Rollback:
    """What the environment rollback did to one tree.

    ``failed`` non-empty is *cannot verify*: a path we did not neutralise is
    still under the diff's control, and the caller must block on it
    non-authoritatively.
    """

    restored: list[str]
    removed: list[str]
    neutralised: list[str]
    failed: list[str]


def _roll_back_environment(
    tree: Path, base_sha: str, plain: list[str], manifests: list[str]
) -> _Rollback:
    """PRODUCTION CODE FROM HEAD, THE WHOLE TEST SURFACE FROM BASE — belt-and-
    braces for the ablation clone (see the module docstring); the primary HTTP
    path no longer depends on this to close a real attack, but the ablation
    fallback's mutated scratch clone still needs HEAD's dependencies resolvable
    from a manifest whose pytest tables came from the base."""
    restored, removed, failed = restore_paths_from(tree, base_sha, plain)
    neutralised: list[str] = []
    for rel in manifests:
        ok, why = rollback_pytest_config_only(tree, base_sha, rel)
        if ok:
            neutralised.append(rel)
        else:
            failed.append(f"{rel} ({why})")
    return _Rollback(restored=restored, removed=removed, neutralised=neutralised, failed=failed)


def _git_common_dir(repo_root: Path) -> Path | None:
    try:
        proc = subprocess.run(  # noqa: S603,S607 - fixed argv, no shell
            ["git", "rev-parse", "--git-common-dir"],
            cwd=str(repo_root), capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.strip()
    if not out:
        return None
    p = Path(out)
    return p if p.is_absolute() else (Path(repo_root) / p)


def _exclude_oracle_from_git(repo_root: Path) -> None:
    """Defence in depth: a leaked oracle copy (from an older build) must never
    be committable. Best-effort and local-only."""
    common = _git_common_dir(repo_root)
    if common is None:
        return
    try:
        info = common / "info"
        info.mkdir(parents=True, exist_ok=True)
        excl = info / "exclude"
        pattern = ORACLE_COPY_GLOB
        existing = excl.read_text(encoding="utf-8") if excl.exists() else ""
        if pattern in existing:
            return
        sep = "" if existing.endswith("\n") or not existing else "\n"
        excl.write_text(
            f"{existing}{sep}# factory acceptance oracle (never committed)\n{pattern}\n",
            encoding="utf-8",
        )
    except OSError:
        return


def evaluate(pr: PRContext, app_config: AppConfig) -> GateResult:
    """Run the gate, converting ANY unexpected error into an authoritative block."""
    try:
        return _evaluate(pr, app_config)
    except Exception as exc:  # noqa: BLE001 - a broken detector must block, not raise
        return GateResult(
            label=_LABEL,
            passed=False,
            reason=(
                "acceptance oracle gate FAILED to run "
                f"({type(exc).__name__}: {exc}) — blocking (fail-closed)"
            ),
            details={"authoritative": True, "verified": False, "infra_error": repr(exc)[:500]},
        )


def _unverifiable(
    pr: PRContext,
    details: dict[str, object],
    *,
    kind: str,
    why: str,
    waiver_sha: str | None = None,
) -> GateResult:
    """SKIPPED-WITH-REASON: the oracle could not be graded, so we do not approve.

    ``waiver_sha`` opts this state into the operator waiver
    (``acceptance.read_waiver``); pass ``None`` where a human must not be able
    to wave the story through (tampered evidence, a config the gate itself
    cannot run, the wrong commit).
    """
    story = pr.story
    app = story.app if story is not None else ""
    sid = story.id if story is not None else None
    details = {**details, "authoritative": False, "verified": False, "unverifiable_kind": kind}
    reason = f"acceptance oracle NOT VERIFIED ({kind}): {why}"

    waiver = (
        read_waiver(pr.software_factory_root, app, sid, for_oracle_sha=waiver_sha)
        if waiver_sha
        else None
    )
    if waiver is not None:
        details["waived"] = True
        details["waiver"] = {
            "reason": str(waiver.get("reason"))[:300],
            "operator": str(waiver.get("operator")),
            "recorded_at": waiver.get("recorded_at"),
        }
        clear_gate_block(pr.software_factory_root, app, sid)
        return GateResult(
            label=_LABEL,
            passed=True,
            reason=(
                f"{reason} — cleared by an OPERATOR WAIVER "
                f"({str(waiver.get('reason'))[:120]}); the oracle did NOT verify this story"
            ),
            details=details,
        )

    record_gate_block(pr.software_factory_root, app, sid, kind=kind, reason=reason)
    return GateResult(label=_LABEL, passed=False, reason=reason, details=details)


def _cache_path(pr: PRContext, name: str) -> Path | None:
    root = pr.software_factory_root
    story = pr.story
    if root is None or story is None:
        return None
    return acceptance_dir(Path(root), story.app, story.id) / name


def _record_run_id(pr: PRContext, kind: str, run_id: str) -> None:
    """Append a run id that ACTUALLY executed to ``run_ids.json`` next to the
    gate's other on-disk artifacts (best-effort, never raises).

    The nonce makes leftover ``accept_*`` DB rows untraceable from the row
    alone, and gate ``details`` survive only on the FAIL path
    (``gates_passed`` records bare labels) — while a PASSING evaluation is
    exactly the one that leaves a complete set of created rows behind.
    Recorded at the point of use, cache hits excluded, so every entry names a
    run that really hit the shared DB.
    """
    path = _cache_path(pr, "run_ids.json")
    if path is None:
        return
    try:
        import json as _json
        from datetime import UTC, datetime

        entries: list[dict[str, str]] = []
        if path.exists():
            loaded = _json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                entries = loaded
        entries.append(
            {"ts": datetime.now(UTC).isoformat(), "kind": kind, "run_id": run_id}
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_json.dumps(entries[-200:], indent=1), encoding="utf-8")
    except Exception:  # noqa: BLE001 - forensic breadcrumb, never fail the gate
        pass


def _stub_run(
    oracle_src: str, oracle_sha: str, cache_path: Path | None, run_id: str, timeout_s: int,
    dest_name: str, variant: str,
) -> dict[str, object]:
    """Run the oracle against ONE stub variant; cached on
    ``(oracle_sha, variant, STUB_VERSION, RUNNER_VERSION)`` — the stub is the
    factory's own fixed harness, so a re-run of the same oracle against it
    always produces the same criteria.

    ``dest_name`` MUST be the SAME filename the HEAD/BASE runs use: a
    criterion's identity is its junit ``classname::name``, and pytest derives
    ``classname`` from the FILE it collected — a stub run written under a
    different filename produces nodeids that never match the HEAD run's, so
    every criterion would look "missing" from the stub's point of view and the
    crediting set ``K`` would always be empty.

    ⚠ ``ACCEPTANCE_RUN_ID`` also differs across the stub/HEAD/BASE runs (not
    only ``ACCEPTANCE_BASE_URL``, contrary to an earlier version of this
    docstring) — kept that way DELIBERATELY, not fixed, because making it
    identical would let HEAD and BASE collide on the SAME namespaced resource
    in a shared persistent DB (the design's OWN "risk 2", cross-run
    contamination). The residual: an oracle that ``@pytest.mark.parametrize``s
    on the run id would get different junit node NAMES per run and K would
    look empty — no author is instructed to do this (the persona says
    "namespace values you CREATE with the run id", not "parametrize on it"),
    but nothing here statically forbids it. See the module docstring's KNOWN
    OPEN list.
    """
    key = run_key(oracle_sha, variant, str(stub_server.STUB_VERSION), str(oracle_run.RUNNER_VERSION))
    if cache_path is not None:
        hit = cache_get(cache_path, key)
        if hit is not None and hit.get("readable") is True:
            return {**hit, "cached": True}

    with stub_server.stub_app(variant=variant) as stub:
        run = oracle_run.run_oracle(
            oracle_src, base_url=stub.base_url, run_id=run_id,
            dest_name=dest_name, timeout_s=timeout_s,
        )
        request_count = stub.request_count
        requests_sample = stub.requests[:20]

    readable = run.junit_ok or run.status in ("pass", "fail", "vacuous")
    out: dict[str, object] = {
        "variant": variant, "status": run.status, "criteria": run.criteria,
        "request_count": request_count, "junit_ok": run.junit_ok, "readable": readable,
        "requests_sample": requests_sample, "output_tail": run.output[-1000:],
    }
    if cache_path is not None and readable:
        cache_put(cache_path, key, {k: v for k, v in out.items() if k != "output_tail"})
    return out


def _base_failures_matching_stub(
    credited: set[str],
    base_criteria: dict[str, str],
    stub_criteria_by_variant: dict[str, dict[str, str]],
) -> list[str]:
    """ADVISORY DIAGNOSTIC ONLY (BENCHMARK-READINESS-PLAN.md A2) — flags a
    credited criterion whose BASE outcome (``FAIL``/``ERROR``) is the exact
    same junit outcome it also produced against EVERY gutted-implementation
    stub variant (``stub_server.STUB_VARIANTS``, both the ``200 {}`` empty
    body and the ``plausible`` shaped one). This is suspicious WITHOUT
    asserting what any status code means.

    A2's FIRST DRAFT proposed a status-code taxonomy (404/501 = valid red,
    400/422 = malformed oracle -> block) and it was proven to INVERT on this
    app: story 179's own ``base_runs.json`` recorded a 401 for a route that
    did not exist at base, because a parameterised route's
    ``Depends(get_current_user)`` fires before a 404 can be produced — "feature
    absent" presents as 401/403 on most of this app's routes, and a 404 is the
    exception (module docstring, KNOWN OPEN #3). Any blocking taxonomy built
    on status codes is therefore a false-block GENERATOR on this app, which is
    why this function does not look at a status code anywhere and never
    changes ``credited``, ``verdict``, or the gate's PASS/BLOCK decision — it
    only feeds ``details`` for a human (or Workstream B's later analysis) to
    look at.
    """
    matches: list[str] = []
    for c in sorted(credited):
        base_outcome = base_criteria.get(c)
        if base_outcome not in ("FAIL", "ERROR"):
            continue
        if all(
            stub_criteria_by_variant.get(v, {}).get(c) == base_outcome
            for v in stub_server.STUB_VARIANTS
        ):
            matches.append(c)
    return matches


def _evaluate(pr: PRContext, app_config: AppConfig) -> GateResult:  # noqa: PLR0911,PLR0912,PLR0915
    gates = app_config.gates
    deadline = time.monotonic() + _GATE_BUDGET_S

    if not gates.acceptance_oracle:
        return GateResult(
            label=_LABEL, passed=True,
            reason="acceptance oracle not enabled for this app (skipped)",
            details={"acceptance_oracle": False},
        )

    story = pr.story
    ref = getattr(story, "acceptance_test_ref", None) if story is not None else None
    root = pr.software_factory_root

    expected, source = acceptance_expected_for_story(story, app_config, root)
    if not expected:
        return GateResult(
            label=_LABEL, passed=True,
            reason="story has no acceptance criteria (not applicable, skipped)",
            details={"acceptance_oracle": True, "acceptance_expected": False, "expected_source": source},
        )

    if not ref_is_readable(story, root):
        exhausted = author_exhausted(story, root)
        passes = (
            author_passes(Path(root), story.app, story.id)
            if story is not None and root is not None
            else 0
        )
        tail = (
            " — authoring EXHAUSTED its pass ceiling; the operator must fix the "
            "direction's acceptance criteria or the app's acceptance harness config"
            if exhausted
            else " — authoring failed; blocking until it is re-authored (self-heals next tick)"
        )
        return GateResult(
            label=_LABEL, passed=False,
            reason=(
                "acceptance oracle EXPECTED but not available "
                f"(ref={ref!r}, root={'set' if root else 'unset'}, "
                f"expected_source={source}){tail}"
            ),
            details={
                "authoritative": True, "verified": False, "acceptance_expected": True,
                "acceptance_test_ref": ref, "expected_source": source,
                "author_passes": passes, "author_exhausted": exhausted,
            },
        )

    assert story is not None and ref is not None and root is not None

    details: dict[str, object] = {"acceptance_test_ref": ref, "expected_source": source}

    if pr.dry_run or pr.repo_root is None:
        return GateResult(
            label=_LABEL, passed=False,
            reason="[dry-run] acceptance oracle present but not run (no checkout)",
            details={**details, "authoritative": False, "verified": False},
        )

    repo_root = Path(pr.repo_root)
    p = Path(ref)
    stored = p if p.is_absolute() else Path(root) / p
    oracle_src = stored.read_text(encoding="utf-8", errors="replace")
    oracle_sha = oracle_sha256(oracle_src)
    details["oracle_sha256"] = oracle_sha[:16]
    sid = story.id if story.id is not None else pr.head_sha
    dest_name = f"{ORACLE_COPY_PREFIX}{sid}.py"
    # ``ACCEPTANCE_RUN_ID`` must actually BE unique per evaluation, as the
    # authoring prompt has always promised ("a value UNIQUE to this run").
    # ``sid`` alone is deterministic per story, so a re-grade — every new dev
    # commit re-evaluates gates at the new head_sha — collided with its OWN
    # previous run's namespaced rows in a shared persistent DB (story 179 left
    # ``accept_head-179_*`` users behind; the next evaluation's register would
    # 409 and hard-block, unwaivably). Per-EVALUATION, not per-run: HEAD and
    # BASE within one evaluation still differ via their prefix, which is what
    # keeps them from colliding with each other. Deliberately absent from every
    # run cache key (stub: oracle/variant/versions; base: shas/boot/version),
    # so caching is unchanged.
    run_nonce = secrets.token_hex(4)
    # PLANNED ids — an early return or a base cache hit means one or both
    # never execute; the ids that actually ran are appended to run_ids.json
    # by _record_run_id at each point of use (details survive only on the
    # FAIL path, while a PASSING evaluation leaves the most rows behind).
    details["run_ids_planned"] = {
        "head": f"head-{sid}-{run_nonce}",
        "base": f"base-{sid}-{run_nonce}",
    }

    boot_cfg = gates.acceptance_boot
    if boot_cfg is None or not (boot_cfg.command or "").strip():
        return _unverifiable(
            pr, details, kind="oracle_runner_unconfigured",
            why=(
                "gates.acceptance_boot is not configured for this app — the out-of-process "
                "oracle has no boot recipe to run against, so nothing here can be verified. "
                "This is an operator config gap, not a decision to be waived"
            ),
        )

    import_problem = oracle_run.oracle_import_check(oracle_src)
    if import_problem:
        return _unverifiable(pr, details, kind="oracle_imports_app_code", why=import_problem)

    try:
        import httpx  # noqa: F401
        import pytest  # noqa: F401
    except ImportError as exc:  # pragma: no cover - factory's own runtime, not exercised in CI
        return _unverifiable(
            pr, details, kind="environment_unavailable",
            why=f"the factory's own interpreter cannot import httpx/pytest ({exc})",
        )

    # Independence hygiene — defence in depth for a copy left by an older
    # (in-process) build or an interrupted run; the HTTP runner never writes
    # the oracle into the dev's checkout at all.
    details["swept_before_run"] = sweep_leaked_oracles(repo_root)
    _exclude_oracle_from_git(repo_root)
    leaked = unremovable_oracle_leaks(repo_root)
    if leaked:
        return GateResult(
            label=_LABEL, passed=False,
            reason=(
                "acceptance oracle copies are present in the DEV worktree and could not be "
                f"removed ({leaked[:5]}) — blocking to protect dev-blindness"
            ),
            details={**details, "authoritative": True, "verified": False, "leaked_copies": leaked},
        )

    # Provenance — grade the merge candidate or grade nothing.
    contains, why = head_contains_sha(repo_root, pr.head_sha)
    details["head_sha"] = pr.head_sha
    details["provenance"] = why
    if contains is not True:
        return _unverifiable(
            pr, details, kind="provenance_unverified" if contains is None else "wrong_commit",
            why=f"the checkout does not demonstrably contain the PR head commit ({why})",
        )

    extra, how_extra = extra_commits_beyond(repo_root, pr.head_sha, pr.base_branch)
    details["provenance_extra"] = how_extra
    if extra is None or extra:
        return _unverifiable(
            pr, details,
            kind="provenance_unverified" if extra is None else "checkout_ahead_of_pr_head",
            why=(
                f"the checkout carries work that is neither the PR head nor the base branch "
                f"({how_extra}: {(extra or [])[:5]})"
                if extra
                else f"could not establish that the checkout adds nothing to the PR head ({how_extra})"
            ),
        )

    base_sha, how = resolve_base_sha(repo_root, pr.base_branch)
    details["base_ref"] = how
    if base_sha is None:
        return _unverifiable(
            pr, details, kind="no_merge_base",
            why=f"cannot resolve the merge base ({how}), so the oracle's failability is unknown",
            waiver_sha=oracle_sha,
        )
    details["base_sha"] = base_sha[:12]
    local_head = head_sha(repo_root) or ""
    details["checkout_head"] = local_head[:12]
    if base_sha == local_head:
        return _unverifiable(
            pr, details, kind="base_equals_head",
            why=f"the merge base IS the checkout HEAD ({base_sha[:12]})",
            waiver_sha=oracle_sha,
        )

    changed = changed_paths_since(repo_root, base_sha)
    if changed is None:
        return _unverifiable(
            pr, details, kind="diff_unreadable",
            why=f"git could not diff {base_sha[:12]}..HEAD in the checkout",
            waiver_sha=oracle_sha,
        )
    rollbacks = sorted({c for c in changed if not is_production_path(c)})
    details["rolled_back_to_base"] = rollbacks
    details["collection_channels_in_diff"] = [c for c in rollbacks if is_collection_channel_path(c)]
    manifests = [c for c in rollbacks if is_dependency_manifest(c)]
    plain = [c for c in rollbacks if not is_dependency_manifest(c)]
    details["dependency_manifests_in_diff"] = manifests

    # ---- STUB: cheapest evidence, before any boot is paid for. ------------- #
    # TWO variants (AC2, widened 2026-08-07): a criterion must fail BOTH to be
    # credited. See ``stub_server``'s module docstring for why the single
    # ``{}`` variant alone is too permissive for a criterion that reads a
    # response field ("items = r.json()['items']") — it fails the thin stub
    # via KeyError REGARDLESS of whether the assertion it goes on to make is
    # meaningful, so a structurally-vacuous check ("len(items) >= 0") rode the
    # single-variant stub straight into credit.
    stub_cache = _cache_path(pr, "stub_runs.json")
    stub_results = {
        variant: _stub_run(
            oracle_src, oracle_sha, stub_cache, f"stub-{variant}-{sid}",
            boot_cfg.run_timeout_seconds, dest_name, variant,
        )
        for variant in stub_server.STUB_VARIANTS
    }
    details["stub_run"] = {
        v: {k: val for k, val in r.items() if k != "output_tail"} for v, r in stub_results.items()
    }

    unreadable_variants = [v for v, r in stub_results.items() if not r.get("readable")]
    if unreadable_variants:
        return _unverifiable(
            pr, details, kind="environment_unavailable",
            why=(
                "the factory's OWN gutted-implementation stub produced no readable result for "
                f"variant(s) {unreadable_variants} — this is the gate's fault, not the story's"
            ),
        )
    def _as_int(value: object) -> int:
        return value if isinstance(value, int) else 0

    stub_request_counts = {v: _as_int(r.get("request_count")) for v, r in stub_results.items()}
    details["stub_requests"] = stub_request_counts
    if all(n == 0 for n in stub_request_counts.values()):
        return _unverifiable(
            pr, details, kind="vacuous_oracle",
            why="the oracle sent ZERO HTTP requests against EITHER gutted-implementation stub variant",
            waiver_sha=oracle_sha,
        )
    stub_criteria_by_variant: dict[str, dict[str, str]] = {
        v: (r.get("criteria") or {}) for v, r in stub_results.items()  # type: ignore[misc]
    }

    def _fails_all_stub_variants(nodeid: str) -> bool:
        return all(
            stub_criteria_by_variant[v].get(nodeid) in ("FAIL", "ERROR")
            for v in stub_server.STUB_VARIANTS
        )

    # A small, deduplicated sample of the exact "METHOD /path" requests the
    # oracle actually issued against EITHER stub variant (``stub_server``
    # logs these regardless of variant, since both answer every path/method).
    # This is the ONLY app-route knowledge this gate has that did not come
    # from importing or statically parsing the oracle's own source — it was
    # OBSERVED, cheaply, in-process, against the factory's own trusted stub —
    # and it is what ``_base_run`` uses to probe a booted BASE instance
    # directly (KNOWN OPEN #1, closed 2026-08-07/08; see the module docstring).
    _probe_request_set: set[str] = set()
    for _r in stub_results.values():
        _sample = _r.get("requests_sample")
        if isinstance(_sample, list):
            _probe_request_set.update(s for s in _sample if isinstance(s, str))
    probe_requests = sorted(_probe_request_set)[:10]
    details["base_probe_requests"] = probe_requests

    all_stub_keys = set().union(*stub_criteria_by_variant.values()) if stub_criteria_by_variant else set()
    if not all_stub_keys or not any(_fails_all_stub_variants(c) for c in all_stub_keys):
        return _unverifiable(
            pr, details, kind="vacuous_oracle",
            why=(
                "every criterion in the oracle PASSES against at least one gutted-implementation "
                "no-op stub variant — a no-op implementation would satisfy this oracle, so its "
                "green at HEAD would carry no information"
            ),
            waiver_sha=oracle_sha,
        )

    # ---- PREREQUISITE: a CHECK, never a start. ----------------------------- #
    prereq_ok, prereq_why = boot_mod.check_prerequisite(boot_cfg, cwd=repo_root)
    details["prerequisite"] = prereq_why
    if not prereq_ok:
        return _unverifiable(pr, details, kind="environment_unavailable", why=prereq_why)

    if time.monotonic() > deadline:
        return _unverifiable(
            pr, details, kind="oracle_timeout",
            why="the gate's overall time budget was exhausted before a HEAD boot could be attempted",
            waiver_sha=oracle_sha,
        )

    # ---- HEAD: production code from HEAD, in a throwaway judge tree. ------ #
    with judge_worktree(repo_root, "HEAD", label="oracle-head") as (judge, err):
        if judge is None:
            return _unverifiable(
                pr, details, kind="no_judge_tree",
                why=f"could not build the independent judge tree ({err})",
                waiver_sha=oracle_sha,
            )
        rolled = _roll_back_environment(judge, base_sha, plain, manifests)
        details["channels_restored"] = rolled.restored
        details["channels_removed"] = rolled.removed
        details["pytest_config_neutralised"] = rolled.neutralised
        if rolled.failed:
            return _unverifiable(
                pr, details, kind="channel_restore_failed",
                why=f"could not restore collection channel(s) {rolled.failed!r} from the merge base",
                waiver_sha=oracle_sha,
            )
        with boot_mod.boot_app(judge, boot_cfg, run_id=f"head-{sid}-{run_nonce}", label="oracle-head") as (head_app, boot_why):
            if head_app is None:
                return _unverifiable(
                    pr, details, kind="head_boot_failed",
                    why=f"the app never became healthy at HEAD: {boot_why[:4000]}",
                    waiver_sha=oracle_sha,
                )
            details["head_boot"] = {"port": head_app.port}
            _record_run_id(pr, "head", f"head-{sid}-{run_nonce}")
            head_run = oracle_run.run_oracle(
                oracle_src, base_url=head_app.base_url, run_id=f"head-{sid}-{run_nonce}",
                dest_name=dest_name, timeout_s=boot_cfg.run_timeout_seconds,
            )
            head_alive = boot_mod.is_alive(head_app)
            head_healthy = boot_mod.probe_health(head_app, boot_cfg)

    details.update({
        "command": head_run.command,
        "exit_code": head_run.exit_code,
        "output_tail": head_run.output[-4000:],
        "head_status": head_run.status,
        "head_junit_ok": head_run.junit_ok,
        "head_app_alive_after_run": head_alive,
        "head_app_healthy_after_run": head_healthy,
    })
    details["tests_passed"] = (
        head_run.summary.passed if head_run.summary is not None and head_run.status != "conflicting" else None
    )
    if head_run.summary is not None:
        details["head_summary"] = head_run.summary.as_dict()
    # A3 (arrange/assert split): failures whose message carries the author-side
    # "SETUP:" prefix mean the harness could not ARRANGE the scenario —
    # recorded so a red here is never misread as "the feature is wrong".
    details["head_setup_failures"] = list(head_run.setup_failures)

    if head_run.status == "blocked_imports":
        return _unverifiable(pr, details, kind="oracle_imports_app_code", why=head_run.output)

    if head_run.status == "tampered":
        # AUTHORITATIVE and NEVER WAIVABLE — this is not "cannot verify", it is
        # "something running as the diff's production code wrote to the
        # oracle's own run directory during the run" (a planted conftest.py a
        # pytest version let past --noconftest, or the oracle file itself
        # overwritten in place). That is itself evidence the story is not
        # trustworthy; an operator waiver must never be able to clear it.
        reason = (
            "acceptance oracle run TAMPERED WITH during execution "
            f"(oracle_run_tampered): {head_run.output}"
        )
        record_gate_block(pr.software_factory_root, story.app, story.id, kind="oracle_run_tampered", reason=reason)
        return GateResult(
            label=_LABEL, passed=False, reason=reason,
            details={**details, "authoritative": True, "verified": False, "unverifiable_kind": "oracle_run_tampered"},
        )

    if head_run.status == "fail":
        summary = head_run.summary
        # A3: when EVERY failing criterion is a SETUP: failure, the block
        # stands (an unarranged scenario proves nothing either way — the
        # fail-safe direction) but the REASON must name the true cause so
        # dev/operator fix the arrange step instead of reading it as a
        # verdict on the feature. Computed for BOTH junit shapes:
        # ``pytest.fail("SETUP: ...")`` in a test body renders as FAIL, but
        # the SAME call inside a FIXTURE renders as ERROR — story 185's
        # re-authored oracle (2026-08-10, a fixture-borne 422 on a reserved
        # email TLD) took the errors-only branch below, which never recorded
        # ``oracle_setup_failed``, so the bounded auto-re-author could not
        # fire on exactly the class it was built for.
        failing = [c for c, o in head_run.criteria.items() if o in ("FAIL", "ERROR")]
        all_setup = bool(failing) and set(failing) <= set(head_run.setup_failures)
        errors_only = summary is not None and summary.failed == 0 and summary.errors >= 1
        healthy_after = bool(head_alive and head_healthy)
        if all_setup and (
            (summary is not None and summary.failed >= 1)
            or (errors_only and healthy_after)
        ):
            # The unhealthy-app case deliberately does NOT land here: a dead
            # or unhealthy app makes "the harness could not arrange" the
            # wrong diagnosis, and the ``app_crashed_during_run`` fallthrough
            # below stays its (waivable, unverifiable) handler.
            reason = (
                f"ran independent acceptance oracle exit_code={head_run.exit_code} "
                "(SETUP failed at HEAD — the harness could not arrange the "
                "scenario; NOT a verdict on the feature. Fix the arrange "
                "step or the facts it relies on)"
            )
            # Same channel the tampered branch uses: without this the
            # improved reason reaches no surface anyone reads (it is not
            # on the waiver path, and gate reasons are never fed back to
            # dev) — an operator would only ever see it via
            # `factory trace`. Recording puts it in `factory inbox`.
            #
            # ``feedback`` carries the oracle's own "SETUP:" lines (what
            # the app actually answered — status codes, bodies) so the
            # bounded auto-re-author can hand the next author something
            # actionable instead of re-inventing the same un-arrangeable
            # setup. App output = untrusted data; the authoring prompt
            # frames it that way.
            setup_lines: list[str] = []
            for line in head_run.output.splitlines():
                stripped = line.strip()[:250]
                if (
                    oracle_run.SETUP_FAILURE_PREFIX in line
                    and stripped not in setup_lines
                ):
                    setup_lines.append(stripped)
                if len(setup_lines) >= 5:
                    break
            record_gate_block(
                pr.software_factory_root, story.app, story.id,
                kind="oracle_setup_failed", reason=reason,
                feedback="\n".join(setup_lines) or None,
                # Stamp WHICH oracle this block indicts — the bounded
                # auto-re-author refuses to act on a sha mismatch, so a
                # stale sidecar can never license replacing a different
                # frozen oracle (adversarial review 2026-08-10, finding 5).
                oracle_sha=oracle_sha,
            )
            return GateResult(
                label=_LABEL, passed=False,
                reason=reason,
                details={**details, "authoritative": True, "verified": False},
            )
        if summary is not None and summary.failed >= 1:
            return GateResult(
                label=_LABEL, passed=False,
                reason=(
                    f"ran independent acceptance oracle exit_code={head_run.exit_code} "
                    "(assertion failed at HEAD)"
                ),
                details={**details, "authoritative": True, "verified": False},
            )
        if errors_only and healthy_after:
            # LIVENESS, not the rollback set, decides authority now: the app
            # stayed up and healthy through the run, so an errors-only red is
            # the oracle's own problem — the dev is the right party to tell.
            return GateResult(
                label=_LABEL, passed=False,
                reason=f"ran independent acceptance oracle exit_code={head_run.exit_code} (errors-only red, app stayed healthy)",
                details={**details, "authoritative": True, "verified": False},
            )
        if errors_only:
            return _unverifiable(
                pr, details, kind="app_crashed_during_run",
                why=(
                    "the oracle run at HEAD is red entirely from error(s), and the booted app "
                    f"was NOT alive/healthy afterward (alive={head_alive}, healthy={head_healthy}) "
                    "— cannot distinguish a wrong implementation from an app that crashed"
                ),
                waiver_sha=oracle_sha,
            )
        return GateResult(
            label=_LABEL, passed=False,
            reason=f"ran independent acceptance oracle exit_code={head_run.exit_code}",
            details={**details, "authoritative": True, "verified": False},
        )

    if head_run.status == "vacuous":
        return GateResult(
            label=_LABEL, passed=False,
            reason="acceptance oracle exited 0 but reported NO passing test at HEAD (vacuous run)",
            details={**details, "authoritative": True, "verified": False},
        )

    if head_run.status == "conflicting":
        return _unverifiable(
            pr, details, kind="conflicting_summaries",
            why="the HEAD run printed conflicting summaries (junit vs stdout mismatch, or two stdout summaries)",
        )

    if head_run.status == "unreadable":
        return _unverifiable(
            pr, details, kind="oracle_run_unreadable",
            why=f"the factory-owned oracle runner produced no readable result at HEAD (exit_code={head_run.exit_code})",
            waiver_sha=oracle_sha,
        )

    if head_run.status == "pass" and not head_run.junit_ok:
        # Found 2026-08-07: the stdout summary said "N passed" (a readable
        # aggregate), but the per-criterion junit file did not parse — so
        # ``head_run.criteria`` is empty and crediting below would compute an
        # empty ``K`` and mislabel this a ``vacuous_oracle`` (the ORACLE's
        # fault) when it is actually the RUNNER's fault (this module wrote a
        # junit file it cannot itself read back). Same waivable, non-
        # authoritative family as the ``unreadable`` branch above — just
        # caught one summary-source later.
        return _unverifiable(
            pr, details, kind="oracle_run_unreadable",
            why="the HEAD run's stdout summary was readable but its junit file was not — no per-criterion result exists to grade",
            waiver_sha=oracle_sha,
        )

    # head_run.status == "pass" — apply the gutted-implementation exclusion.
    # A criterion is credited only if it FAILS at HEAD's stub check for BOTH
    # variants (``_fails_all_stub_variants``); passing either one excludes it.
    credited = {
        c for c, outcome in head_run.criteria.items()
        if outcome == "PASS" and _fails_all_stub_variants(c)
    }
    excluded = sorted(c for c, outcome in head_run.criteria.items() if outcome == "PASS" and c not in credited)
    details["credited_criteria"] = sorted(credited)
    details["stub_excluded_criteria"] = excluded
    all_keys = set(head_run.criteria) | all_stub_keys
    details["criteria"] = {
        c: {
            "head": head_run.criteria.get(c, "MISSING"),
            **{v: stub_criteria_by_variant[v].get(c, "MISSING") for v in stub_server.STUB_VARIANTS},
        }
        for c in sorted(all_keys)
    }

    if not credited:
        return _unverifiable(
            pr, details, kind="vacuous_oracle",
            why=(
                "every criterion that passed at HEAD also passes the gutted-implementation "
                "stub — nothing in this oracle is known to discriminate a real implementation "
                "from a no-op"
            ),
            waiver_sha=oracle_sha,
        )

    if time.monotonic() > deadline:
        return _unverifiable(
            pr, details, kind="oracle_timeout",
            why="the gate's overall time budget was exhausted before a BASE boot could be attempted",
            waiver_sha=oracle_sha,
        )

    verdict, base_reason, base_details = _base_run(
        pr, boot_cfg, oracle_src, dest_name, credited,
        repo_root=repo_root, base_sha=base_sha, sid=sid, oracle_sha=oracle_sha,
        probe_requests=probe_requests, run_nonce=run_nonce,
    )
    details["base_run"] = base_details
    base_criteria = base_details.get("criteria")
    if isinstance(base_criteria, dict):
        # Advisory only — see ``_base_failures_matching_stub``'s docstring for
        # why this records an outcome-identity signal and classifies nothing.
        details["base_failures_matching_stub"] = _base_failures_matching_stub(
            credited, base_criteria, stub_criteria_by_variant
        )
    if verdict == "green":
        return _unverifiable(
            pr, details, kind="oracle_not_discriminating",
            why=(
                f"{base_reason}. Its green at HEAD therefore says nothing about this story — "
                "re-author the oracle, tighten the direction's acceptance criteria, or record "
                "a decision with `factory acceptance-waive`"
            ),
            waiver_sha=oracle_sha,
        )

    route = f"red at merge base {base_sha[:12]}, green at HEAD"
    if verdict == "unknown":
        if time.monotonic() > deadline:
            return _unverifiable(
                pr, details, kind="oracle_timeout",
                why="the gate's overall time budget was exhausted before the ablation fallback could run",
                waiver_sha=oracle_sha,
            )
        proven, abl_reason, abl_details = _ablation_can_fail(
            boot_cfg, oracle_src, dest_name, credited,
            repo_root=repo_root, head_ref=local_head, base_sha=base_sha,
            plain=plain, manifests=manifests, factory_root=Path(root),
            cache_path=_cache_path(pr, "ablation_proofs.json"), oracle_sha=oracle_sha,
        )
        details["failability_ablation"] = abl_details
        if not proven:
            return _unverifiable(
                pr, details, kind="failability_unverified",
                why=f"{base_reason}, and {abl_reason} — regression-only fallback: NOT approving",
                waiver_sha=oracle_sha,
            )
        route = f"failability proven by ablation ({abl_reason}); the merge-base run was unusable"

    clear_gate_block(pr.software_factory_root, story.app, story.id)
    return GateResult(
        label=_LABEL, passed=True,
        reason=f"ran independent out-of-process acceptance oracle ({route})",
        details={
            **details, "authoritative": True, "verified": True,
            "failability_route": "merge_base_red" if verdict == "red" else "ablation",
        },
    )


def _base_run(
    pr: PRContext,
    boot_cfg: AcceptanceBootConfig,
    oracle_src: str,
    dest_name: str,
    credited: set[str],
    *,
    repo_root: Path,
    base_sha: str,
    sid: object,
    oracle_sha: str,
    probe_requests: list[str] | None = None,
    run_nonce: str,
) -> tuple[str, str, dict[str, object]]:
    """Run the oracle at the merge base; grade OVER ``credited`` (``K``).

    The per-criterion outcome map is what's cached (keyed on the base sha, the
    oracle, and the boot recipe) — independent of ``K``, so a differently-
    authored oracle re-derives its own ``K`` against the same cached base
    result. The FINAL verdict is recomputed fresh every time from that map.

    KNOWN OPEN #1 (closed 2026-08-07/08): a base whose health endpoint answers
    before its own dependency is ready responds 500 to every REAL route while
    still passing ``_poll_health`` — every credited criterion then FAILS at
    base for a reason that has nothing to do with the diff, and the old logic
    read that as a genuine ``red`` (crediting the story on a base that was
    never actually exercised). The invariant this closes: **a ``red`` verdict
    at the base must be evidence the app ran and disagreed, not evidence that
    the app was broken.** ``verdict_over``'s raw verdict is now a CANDIDATE,
    not the answer — an all-FAIL-over-``K`` base is trusted as ``red`` only
    when independently corroborated: either at least one credited criterion
    ALREADY PASSED at base (itself proof the app served that route for real),
    or ``boot_mod.probe_paths``/``served_a_real_route`` finds the booted base
    answered at least one direct, factory-issued request with something other
    than a 5xx. Neither holding downgrades the candidate ``red`` to
    ``unknown`` — which falls through to the ablation fallback, same as any
    other ``unknown`` — rather than crediting a base that was never shown to
    be doing anything but failing to boot correctly.
    """
    cache_path = _cache_path(pr, "base_runs.json")
    key = run_key(base_sha, oracle_sha, boot_cfg.command, boot_cfg.cwd or "", str(oracle_run.RUNNER_VERSION))
    if cache_path is not None:
        hit = cache_get(cache_path, key)
        if hit is not None and isinstance(hit.get("criteria"), dict):
            verdict, reason = verdict_over(credited, hit["criteria"])  # type: ignore[arg-type]
            return verdict, f"{reason} [cached]", {**hit, "cached": True}

    probe_results: list[boot_mod.ProbeResult] = []
    with judge_worktree(repo_root, base_sha, label="oracle-base") as (base_tree, err):
        if base_tree is None:
            return "unknown", f"could not check out the merge base ({err})", {
                "base_sha": base_sha[:12], "reason": err[:300],
            }
        with boot_mod.boot_app(base_tree, boot_cfg, run_id=f"base-{sid}-{run_nonce}", label="oracle-base") as (base_app, boot_why):
            if base_app is None:
                return "unknown", f"the app never became healthy at the merge base: {boot_why[:1000]}", {
                    "base_sha": base_sha[:12], "boot_failed": True,
                }
            _record_run_id(pr, "base", f"base-{sid}-{run_nonce}")
            base_run = oracle_run.run_oracle(
                oracle_src, base_url=base_app.base_url, run_id=f"base-{sid}-{run_nonce}",
                dest_name=dest_name, timeout_s=boot_cfg.run_timeout_seconds,
            )
            if probe_requests:
                # Probed INSIDE the boot's ``with`` block — the app is torn
                # down the instant it exits, and this evidence is exactly
                # about what the LIVE base instance answered during this run.
                probe_results = boot_mod.probe_paths(base_app, probe_requests)

    if not base_run.junit_ok:
        return "unknown", f"the base run produced no readable per-criterion result (status={base_run.status})", {
            "base_sha": base_sha[:12], "status": base_run.status, "output_tail": base_run.output[-1500:],
        }

    verdict, reason = verdict_over(credited, base_run.criteria)
    served_real = boot_mod.served_a_real_route(probe_results)
    base_probe: dict[str, object] = {
        "requests": list(probe_requests or []),
        "results": [
            {"method": r.method, "path": r.path, "status": r.status, "error": r.error} for r in probe_results
        ],
        "served_a_real_route": served_real,
    }
    if verdict == "red":
        any_credited_passed = any(base_run.criteria.get(c) == "PASS" for c in credited)
        if not any_credited_passed and not served_real:
            downgraded_verdict, downgraded_reason = "unknown", (
                f"{reason}, but no credited criterion passed at the base AND the base instance "
                "never answered a single direct probe with anything but a 5xx (or a connection "
                "failure) — this looks like a healthy-but-broken boot (KNOWN OPEN #1: a health "
                "endpoint that answers before its own dependency is ready), not a genuine "
                "disagreement, so it is NOT trusted as red"
            )
            downgraded_out: dict[str, object] = {
                "base_sha": base_sha[:12], "status": base_run.status, "criteria": base_run.criteria,
                "exit_code": base_run.exit_code, "output_tail": base_run.output[-1500:],
                "base_probe": base_probe, "raw_verdict": verdict, "downgraded_from": verdict,
            }
            # NEVER cached: this is exactly the ``unknown`` case cache_put below
            # already excludes (verdict not in {"red", "green"}) — no separate
            # gate needed here, but stated for the reader auditing this branch.
            return downgraded_verdict, downgraded_reason, downgraded_out

    out: dict[str, object] = {
        "base_sha": base_sha[:12], "status": base_run.status, "criteria": base_run.criteria,
        "exit_code": base_run.exit_code, "output_tail": base_run.output[-1500:], "base_probe": base_probe,
    }
    if cache_path is not None and verdict in {"red", "green"}:
        cache_put(cache_path, key, {k: v for k, v in out.items() if k != "output_tail"})
    return verdict, reason, out


def _ablation_probe_command(
    *, factory_root: Path, dest_name: str, boot: AcceptanceBootConfig, run_id: str, credited: set[str]
) -> str:
    """Factory-owned argv for the ablation's out-of-process check.

    Invoked by ``mutation.check_can_fail`` as a plain shell command run with
    ``PATH`` stripped of the caller's own venv (``mutation._mutant_env``), so
    every path here is either an absolute path or resolved by ``sys.executable``
    — nothing relies on ``oracle_probe.py`` being importable or on ``PATH``.

    ``credited`` is threaded through as repeated ``--credit`` flags (AC2, found
    2026-08-07): without it, the probe reads RED off ANY failed criterion, so a
    mutation that only kills a stub-excluded (vacuous) criterion would license
    an approval on the ``unknown`` ⇒ ablation route — the one place AC2's
    exclusion guarantee was not actually enforced.
    """
    parts = [
        shlex.quote(sys.executable), shlex.quote(str(_ORACLE_PROBE_PATH)),
        "--factory-root", shlex.quote(str(factory_root)),
        "--tree", ".",
        "--oracle", shlex.quote(dest_name),
        "--boot-command", shlex.quote(boot.command),
        "--boot-cwd", shlex.quote(boot.cwd or ""),
        "--health-path", shlex.quote(boot.health_path),
        "--boot-timeout", str(boot.boot_timeout_seconds),
        "--run-timeout", str(boot.run_timeout_seconds),
        "--shutdown-grace", str(boot.shutdown_grace_seconds),
        "--env-passthrough", shlex.quote(",".join(boot.env_passthrough)),
        "--run-id", shlex.quote(run_id),
    ]
    for k, v in (boot.env or {}).items():
        parts += ["--env", shlex.quote(f"{k}={v}")]
    for c in sorted(credited):
        parts += ["--credit", shlex.quote(c)]
    return " ".join(parts)


def _ablation_can_fail(
    boot_cfg: AcceptanceBootConfig,
    oracle_src: str,
    dest_name: str,
    credited: set[str],
    *,
    repo_root: Path,
    head_ref: str,
    base_sha: str,
    plain: list[str],
    manifests: list[str],
    factory_root: Path,
    cache_path: Path | None,
    oracle_sha: str,
) -> tuple[bool, str, dict[str, object]]:
    """SECOND route to failability, computed OUT OF PROCESS like the primary path.

    ``check_command`` is ``oracle_probe.py``, invoked by absolute path: it boots
    the app from the SAME scratch clone ``mutation.check_can_fail`` mutates,
    drives the oracle over HTTP, and exits 0/1/other for GREEN/RED/INFRA
    (``mutation._run_suite``'s exact contract). Kill attribution is the
    SENTINEL FILE ``mutate_source`` writes before raising — a filesystem check
    after the run, unaffected by which process actually executed the mutated
    body (the booted app, a grandchild of ``check_command``'s own subprocess).
    """
    from factory.chain import mutation

    attempts: list[dict[str, object]] = []
    out: dict[str, object] = {"route": "ablation", "attempts": attempts}

    command = _ablation_probe_command(
        factory_root=factory_root, dest_name=dest_name, boot=boot_cfg,
        run_id=f"ablation-{head_ref[:12]}", credited=credited,
    )
    out["command"] = command

    per_attempt_timeout = 2 * boot_cfg.boot_timeout_seconds + boot_cfg.run_timeout_seconds + 120
    min_run_s = 2 * boot_cfg.boot_timeout_seconds + _ABLATION_MIN_RUN_BASE_S

    key = run_key(head_ref, oracle_sha, command, base_sha)
    if cache_path is not None:
        hit = cache_get(cache_path, key)
        if hit is not None and hit.get("proven") is True:
            reason = f"{hit.get('reason', '')} [cached]"
            return True, reason, {**hit, "reason": reason, "cached": True}

    selection = mutation.select_symbols(repo_root, base_sha, head_ref, max_symbols=_MAX_ABLATION_TARGETS)
    if selection is None:
        why = f"the diff {base_sha[:12]}..{head_ref} could not be read, so there is nothing to ablate"
        out["reason"] = why
        return False, why, out
    symbols, candidates, notes = selection
    out["candidates"] = candidates
    if notes:
        out["notes"] = notes[:5]
    if not symbols:
        why = (
            "the story's diff touches no production function that could be ablated, so the "
            "oracle's failability cannot be established this way either"
        )
        out["reason"] = why
        return False, why, out

    def _prepare(tree: Path) -> str | None:
        actual = head_sha(tree)
        if actual != head_ref:
            return (
                f"the scratch tree is at {actual!r}, not the graded commit {head_ref[:12]} — "
                "it is a working-tree copy or a wrong checkout"
            )
        rolled = _roll_back_environment(tree, base_sha, plain, manifests)
        if rolled.failed:
            return f"could not restore collection channel(s) {rolled.failed!r} from the merge base"
        try:
            (tree / dest_name).write_text(oracle_src, encoding="utf-8")
        except OSError as exc:
            return f"could not place the oracle in the scratch tree ({exc})"
        return None

    deadline = time.monotonic() + _ABLATION_BUDGET_S
    for sym in symbols:
        remaining = int(deadline - time.monotonic())
        if remaining < min_run_s:
            out["budget_exhausted_after"] = len(attempts)
            break
        proven, detail = mutation.check_can_fail(
            repo_root=repo_root, head_ref=head_ref, target_path=sym.path, qualname=sym.qualname,
            check_command=command, timeout_s=min(per_attempt_timeout, remaining), prepare=_prepare,
        )
        attempts.append({"symbol": sym.key, "proven": proven, "detail": detail[:300]})
        if proven:
            out["proven_by"] = sym.key
            out["reason"] = detail
            if cache_path is not None:
                cache_put(cache_path, key, {
                    "proven": True, "reason": detail[:300], "proven_by": sym.key,
                    "route": "ablation", "head_ref": head_ref[:12], "base_sha": base_sha[:12],
                })
            return True, detail, out

    why = (
        f"ablating {len(attempts)} of this story's own production symbol(s) "
        f"({', '.join(str(a['symbol']) for a in attempts)}) never made the oracle go red"
        if attempts
        else f"the ablation fallback ran out of its {_ABLATION_BUDGET_S}s budget before it could measure anything"
    )
    out["reason"] = why
    return False, why, out
