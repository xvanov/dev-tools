"""Per-app configuration loader.

Each app lives at ``apps/<name>/`` in the factory repo and carries a
``config.yaml`` with its repo url, default branch, deploy commands, model
overrides, and context directory. The factory itself is app-agnostic — every
stack-specific value lives here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field

from factory.delivery import DeliveryConfig

#: The pipelines a job can run. ``chain`` = PM->SM->dev->reviewer->gates;
#: ``solo`` = one dev agent + gates (B.1); ``auto`` = the factory decides
#: (v1: the app's ``pipeline_default``, and ``auto`` there means ``chain``).
#: Shared with ``docs/JOBS-API.md`` and ``factory/job_routing.py``.
PipelineName = Literal["chain", "solo", "auto"]
PIPELINE_NAMES: tuple[str, ...] = ("chain", "solo", "auto")

#: The factory's OWN GitHub repo. An app whose ``config.yaml::repo`` matches
#: this is building the factory itself (``apps/factory``); its merges are
#: self-edits gated by the chain-side staging gate, and its pm-sync is gated by
#: the ``self_tick_enabled`` flag. Every other app targets a different repo.
FACTORY_REPO = "xvanov/software-factory"


def targets_factory_repo(repo: str | None) -> bool:
    """True when ``repo`` (an app's ``config.yaml::repo``) is the factory itself.

    Case-insensitive so a casing typo in the owner/name can't silently disable
    the self-edit safety gate or the self-tick guard.
    """
    return (repo or "").strip().lower() == FACTORY_REPO.lower()


class DeployConfig(BaseModel):
    """Per-app deploy block consumed by ``factory/deploy/orchestrator.py``.

    Every command is an opaque shell string the factory passes verbatim to
    a subprocess. The factory itself is stack-agnostic — it knows nothing
    about Docker, Compose, Fly, Vercel, etc. Apps declare commands here;
    Phase 5's orchestrator executes them in a fixed sequence.
    """

    enabled: bool = False
    pre_deploy_commands: list[str] = Field(default_factory=list)
    deploy_command: str | None = None
    health_check_command: str | None = None
    health_check_max_attempts: int = 5
    health_check_interval_seconds: int = 5
    smoke_test_command: str | None = None
    rollback_command: str | None = None
    # Optional metadata commands (label -> shell). Run after a successful
    # deploy; their stdout is captured into DeployActionRecord for audit
    # (e.g. ``docker compose ps --format json`` to record container state).
    post_deploy_record: dict[str, str] = Field(default_factory=dict)
    # Per-command working directory (relative to the cloned app repo
    # root). Phase 5 dry-run ignores this entirely; real-run resolves it
    # against the app workspace. None means the factory root.
    working_directory: str | None = None
    # Env vars from the factory process forwarded to the deploy
    # subprocess. PATH is always forwarded; everything else is opt-in.
    env_var_passthrough: list[str] = Field(default_factory=list)
    # Subprocess timeout per command (seconds).
    timeout_seconds: int = 600


class AcceptanceBootConfig(BaseModel):
    """019 AC3 — how ``acceptance-verified`` boots a real instance of the app.

    Consumed by ``factory/chain/boot.py``. Every field is a plain string/int —
    the factory stays stack-agnostic; the app declares the recipe.
    """

    #: The shell command that starts the app, MUST contain ``{port}`` (the
    #: gate refuses to boot without it — see ``boot.boot_app``). May also use
    #: ``{base_url}`` / ``{run_id}`` / ``{run_dir}`` — all four are substituted
    #: by LITERAL replace, never ``str.format``, so a command containing other
    #: braces (a compose var, a jq filter) cannot raise ``KeyError`` and abort
    #: the whole merge evaluation. Example:
    #: ``"uv run uvicorn app.main:app --host 127.0.0.1 --port {port}"``.
    command: str = ""
    #: Repo-relative directory the boot command runs in. ``None``/empty = the
    #: tree root.
    cwd: str | None = None
    #: HTTP path polled (and re-probed after the run) to decide "healthy".
    health_path: str = "/health"
    boot_timeout_seconds: int = 180
    run_timeout_seconds: int = 300
    shutdown_grace_seconds: float = 5.0
    #: Extra env vars for the booted app. Values may use the same four
    #: substitution tokens as ``command`` (e.g. a media dir under
    #: ``{run_dir}``), substituted the same literal way.
    env: dict[str, str] = Field(default_factory=dict)
    #: Names of CURRENT-PROCESS env vars forwarded to the booted app verbatim.
    #: Deliberately NOT the whole environment — the boot command runs in a
    #: constructed env, not an inherited one, so a stray var from the gate's
    #: own process can't leak into the app under test by accident.
    #:
    #: ``TMPDIR`` is deliberately ABSENT (found 2026-08-07): the booted app is
    #: the diff's own production code, and forwarding the gate's temp root
    #: hands it the exact directory the oracle's throwaway run-dir lives
    #: under, which a background thread can poll and tamper with. Removing it
    #: narrows discoverability; it does NOT close the hole by itself — a
    #: same-user process can still guess the OS default ``/tmp`` without any
    #: env var at all. The mechanism that actually closes it is
    #: ``oracle_run._tamper_check`` (see that module's docstring): this field
    #: is defence in depth, not the boundary.
    env_passthrough: list[str] = Field(
        default_factory=lambda: ["PATH", "HOME", "LANG", "LC_ALL", "UV_CACHE_DIR", "XDG_CACHE_HOME"]
    )
    #: A CHECK the app's dependency (a DB container, …) is already up — never
    #: a start command. ``None`` = nothing to check. See ``boot.check_prerequisite``.
    prerequisite_command: str | None = None
    #: Operator-facing action named in the block reason when the prerequisite
    #: fails (e.g. ``"make up-db"``).
    prerequisite_hint: str | None = None
    #: Optional shell hooks run before/after the boot, for app-specific setup
    #: (seeding, migrations) the boot command itself does not do. Neither is
    #: required; both are best-effort and their failure does not by itself
    #: block (the health poll is the real gate).
    setup_command: str | None = None
    teardown_command: str | None = None


class AppGatesConfig(BaseModel):
    """Per-app gate commands consumed by the auto-merge worker (Phase 4).

    Every field is optional: a missing command means "skip this gate". The
    factory itself is stack-agnostic — these strings are executed verbatim
    by the gate handler when the worker is in real-run mode, and only flag
    lookups are done in dry-run.
    """

    lint_command: str | None = None
    format_check_command: str | None = None
    type_check_command: str | None = None
    test_command: str | None = None
    coverage_command: str | None = None
    e2e_command: str | None = None
    # A4 (operator decision 2026-08-09): when the acceptance oracle is on and
    # the direction carries acceptance criteria, collapse a multi-story PM
    # split into ONE story at spawn — the oracle grades every story against
    # the DIRECTION's criteria, so the first sibling to merge satisfies the
    # direction and every later sibling grades green-at-base →
    # ``oracle_not_discriminating`` → operator waiver (observed live
    # 2026-08-09, direction 120: story 179 shipped everything, siblings
    # 180/181 were superseded by hand). Per-app and default OFF, per the
    # ``detector_watch`` precedent: flip it per app after observing it on a
    # real spawn, never globally on merge. The collapse refuses to fire (and
    # keeps the split, loudly) when the summed size estimates exceed the
    # per-story ceilings — see ``handle_stories_spawned``.
    single_story_per_ac_direction: bool = False
    # INERT since the ablation branch was removed from the ``tests-meaningful``
    # merge gate. Retained so existing app configs keep parsing; nothing reads
    # it. Mutation scoring is now a measurement you invoke deliberately
    # (``factory mutation-score``), not a flag that can arm a required gate —
    # see the ``factory/chain/gates/tests_meaningful.py`` docstring for the four
    # defects that made this flag a merge-wide hazard.
    mutation_testing: bool = False
    # Whether a WORKING end-to-end/browser harness actually exists in the app
    # (Playwright installed + config + the stack runnable in the sandbox). A
    # configured ``e2e_command`` does NOT imply this — sacrifice declares
    # ``npx playwright test`` but has no runnable harness, so test_designer
    # mandating Playwright produced harness-breakage "reds" that deadlocked
    # every frontend/E2E story. When False, the test_designer must NOT require
    # E2E/Playwright and should scope to the backend test_command instead.
    e2e_harness_ready: bool = False

    # Runtime smoke gate (Karpathy Layer-2 "external signal", D002). A command
    # that BOOTS the running product and exercises one real user journey
    # (e.g. docker compose up + a scripted sign-up → login → core-action pass).
    # Distinct from ``test_command`` (unit/integration, app never starts) and
    # from ``e2e_command`` (declared but historically unrunnable). The factory
    # shipped a full backlog green while the app could not log in precisely
    # because nothing booted it; this gate is the oracle that closes that class.
    smoke_command: str | None = None
    # Whether a WORKING smoke harness actually exists (stack runnable in the
    # sandbox + the scripted journey passes). Only when True does ``smoke-green``
    # become a merge-REQUIRED gate for this app — keeping the rollout per-app
    # opt-in so apps without a harness are unaffected (no new merge blocks,
    # avoiding the PRs 110/111 "every merge blocked" regression).
    smoke_harness_ready: bool = False

    # WS1.2 / 019 AC2+AC3 — independent acceptance oracle. When True, the chain
    # authors an acceptance test from each story's direction acceptance
    # criteria (the SPEC ONLY, blind to the dev's code/tests) at spawn time,
    # stores it in factory state OUTSIDE the dev worktree, and
    # ``acceptance-verified`` runs it as a REQUIRED gate for every non-docs
    # story. Off by default so the rollout is per-app opt-in — an app that
    # hasn't enabled it sees no new merge blocks (mirrors the
    # ``smoke_harness_ready`` rollout). Required-ness deliberately does NOT
    # depend on a DB flag — see ``evaluator.required_gate_labels``.
    #
    # THE VERDICT IS NOW COMPUTED OUT OF PROCESS (2026-08-07, 019 AC3). The
    # in-process runner — the oracle imported the diff's production code and
    # ran under ``pytest`` in the SAME interpreter that graded it — carried a
    # forgery hole no file-level rollback could close: three lines of
    # production code reassigning pytest's own test-runner function forged a
    # genuine-looking red-at-base -> green-at-HEAD (pinned by
    # ``test_KNOWN_OPEN_production_code_can_patch_pytest_in_process``, an
    # ``xfail(strict=True)`` that is WHY this flag stayed off). That test now
    # HARD PASSES: the oracle's verdict is computed by a SEPARATE process
    # driving a BOOTED instance of the app over HTTP
    # (``factory/chain/boot.py`` + ``factory/chain/oracle_run.py``, the
    # ``smoke_green`` pattern), so the interpreter that grades the diff never
    # imports a single line the diff wrote. See ``gates/acceptance_verified``.
    #
    # Enabling this ALSO requires ``acceptance_boot`` below — the gate refuses
    # to run without it (``oracle_runner_unconfigured``, never waivable). That
    # refusal lives at the GATE, not at config LOAD time: ``bench/**`` writes
    # ``acceptance_oracle: True`` with no boot block at all (the swebench arm
    # has no real app to boot) and is out of scope for this config — a
    # load-time ``raise`` here would abort ``run_factory`` for that arm. A
    # load-time validator for every OTHER app is a follow-up in the operator
    # queue, not built here.
    acceptance_oracle: bool = False
    # "Green with zero files changed is not green." OFF by default and ON only
    # for the SWE-bench driver, which writes it in ``_build_bench_root``.
    #
    # ``tests_green`` reads the test command's return code and nothing else, so a
    # dev that changed nothing reaches green whenever the suite already passed.
    # Measured on bench sweep 2: `conan-io__conan-19750` declared green on an
    # empty tree and graded `empty_patch`.
    #
    # It CANNOT default to True. On the live chain a docs-only story, a
    # config-only story, and a story whose remaining delta already landed on the
    # base branch all legitimately produce no production change — the reviewer
    # rubric even has a section saying so ("The diff is a delta"). A global rule
    # would fail every one of them. The benchmark is the one context where the
    # story is always "fix this bug in this repo", so "no change" is always wrong.
    require_production_delta: bool = False
    # WS1.2-era in-process settings. INERT since 019 AC3 — the out-of-process
    # runner never copies the oracle into any checkout at all, so there is no
    # "where does it land" or "what command runs it" left to configure here.
    # Kept ONLY so an old ``apps/<app>/config.yaml`` keeps PARSING (a removed
    # field would be a config-load break for every app that still carries
    # one); nothing reads these three any more. Use ``acceptance_boot`` below.
    acceptance_test_command: str | None = None
    # INERT — see ``acceptance_test_command`` above.
    acceptance_test_dir: str | None = None
    # INERT — see ``acceptance_test_command`` above.
    acceptance_test_cwd: str | None = None
    # Operator-written HARNESS FACTS handed to the acceptance author: how to
    # import/boot the app and drive its public surface. STILL LIVE under
    # AC3 — the author now writes an HTTP journey (``httpx`` against
    # ``ACCEPTANCE_BASE_URL``) rather than an in-process import, and this hint
    # is where the operator says which paths/prefixes/auth flow it should use
    # (see ``acceptance_author.md``). This is repo LAYOUT, not the dev's
    # implementation — the author still never sees the dev's code or tests —
    # and without it the author must GUESS routes, which is exactly how the
    # first real (in-process) run failed. Keep it to stable, spec-adjacent
    # facts that are true for every story in the app.
    acceptance_harness_hint: str | None = None
    # 019 AC3 — how to BOOT a real instance of the app for the oracle to drive.
    # ``None`` (the default) means the out-of-process runner is unconfigured:
    # the gate blocks with ``oracle_runner_unconfigured`` rather than silently
    # skipping, because an app that opted into ``acceptance_oracle`` but never
    # configured a boot recipe would otherwise ship every story un-gated.
    acceptance_boot: AcceptanceBootConfig | None = None

    # Flaky-test quarantine (WS4.4). When True, the ``tests-green`` real-run gate
    # routes a RED ``test_command`` through flake detection: any failing test is
    # re-run in isolation; a test that flaps (fails then passes) is QUARANTINED
    # (recorded to ``state/flake_quarantine.json`` + surfaced as an event/direction)
    # and no longer blocks the merge, while a test that fails CONSISTENTLY is a
    # real regression and still blocks. Off by default so the rollout is per-app
    # opt-in and never widens what passes the gate without an explicit choice — a
    # bug in flake classification could otherwise let a real red through, the
    # exact false-green this whole tier fights.
    flake_quarantine: bool = False
    # How many times a failing test is re-run in isolation before it is declared a
    # consistent (real) failure. A test that passes on ANY of these reruns flapped
    # and is quarantined. This is NOT retry-until-green (which manufactures
    # false-greens): a pass only ever DOWNGRADES a red to quarantined-non-blocking,
    # never upgrades it to a clean pass, and the flake stays surfaced as debt.
    flake_rerun_count: int = 3


class AppConfig(BaseModel):
    name: str
    repo: str  # "owner/name"
    default_branch: str = "main"
    context_dir: str = "context"
    # Path to the actual app source tree, relative to the factory root.
    # Default ``../<name>`` matches the convention "factory at
    # ``~/software-factory/``, apps at ``~/<name>/`` (siblings)". Personas
    # read context from this path, NOT from ``apps/<name>/`` inside the
    # factory (which only holds the per-app config + directions + state).
    app_repo_path: str = ""
    deploy: DeployConfig = Field(default_factory=DeployConfig)
    gates: AppGatesConfig = Field(default_factory=AppGatesConfig)
    # Persona -> model overrides for every story of this app (keys ``persona`` or
    # ``persona.<difficulty>``). Precedence: job (direction frontmatter
    # ``models``) > this > routes.yaml. Resolved and validated (incl. reviewer
    # independence) at story spawn and stamped on the story — see
    # ``factory/job_routing.py``. Was parsed-but-ignored until 2026-11-02.
    models: dict[str, str] = Field(default_factory=dict)
    # The pipeline a job runs when it does not name one (or names ``auto``).
    # ``auto`` here resolves to ``chain``. Stamped on the story at spawn.
    # ``solo`` = one long-horizon dev agent, no reviewer (``factory/chain/solo.py``);
    # ``job_routing.SOLO_PIPELINE_IMPLEMENTED`` is its kill switch. Set by
    # ``factory app set --pipeline-default``; see docs/JOBS-API.md.
    pipeline_default: PipelineName = "chain"
    # Explicit opt-in for ``pipeline: solo`` on the factory's OWN repo
    # (``apps/factory``). Solo removes the reviewer; a self-edit with no
    # reviewer needs an operator decision, so solo is refused
    # (``pipeline_unavailable``) for the factory app unless this is true.
    # Ignored for every other app.
    solo_allowed: bool = False
    # The delivery level a job gets when it does not request one. There is no
    # per-app ceiling: a job's requested level wins. Absent = today's
    # behaviour (auto_merge). See factory/delivery.py.
    delivery: DeliveryConfig = Field(default_factory=DeliveryConfig)

    # Self-tick guard (Tier 3 — FACTORY-SELF-TICK). When this app builds the
    # factory's OWN repo (``apps/factory``), pm-sync will NOT turn its pending
    # directions into chain stories unless this flag is True. OFF by default so
    # merely bootstrapping ``apps/factory`` (config + directions on disk) never
    # silently starts the factory ticking on itself — the orchestrator enables
    # self-tick deliberately by flipping this to True. It is inert for every
    # non-factory app (their merges are not self-edits; see
    # ``auto_merge._story_targets_factory_repo``). The chain-side staging gate
    # is independent of this flag: even when self-tick is enabled, a self-edit
    # still must pass staging before it can touch the live factory.
    self_tick_enabled: bool = False

    @property
    def repo_owner(self) -> str:
        return self.repo.split("/", 1)[0]

    @property
    def repo_name(self) -> str:
        return self.repo.split("/", 1)[1]


def load_app_config(app: str, software_factory_root: Path) -> AppConfig:
    """Load and validate ``apps/<app>/config.yaml`` from the factory root.

    If ``app_repo_path`` is unset in the YAML, it defaults to ``../<name>``
    relative to the factory root (e.g. factory at ``~/software-factory/``
    and apps as sibling directories at ``~/<name>/``).
    """
    cfg_path = Path(software_factory_root) / "apps" / app / "config.yaml"
    if not cfg_path.exists():
        raise FileNotFoundError(f"App config missing: {cfg_path}. Expected apps/<app>/config.yaml.")
    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"{cfg_path}: top-level must be a YAML mapping")
    if not raw.get("app_repo_path"):
        # Mirror the documented convention: app source lives at a sibling
        # of the factory root, named by the app.
        raw["app_repo_path"] = f"../{raw.get('name') or app}"
    return AppConfig.model_validate(raw)


def resolve_app_repo_path(cfg: AppConfig, software_factory_root: Path) -> Path:
    """Resolve ``cfg.app_repo_path`` against the factory root.

    Absolute paths are returned unchanged; relative paths are anchored at
    ``software_factory_root``. The result is NOT required to exist —
    callers handle the "no app tree yet" case (e.g. context loader emits
    the NO CONTEXT AVAILABLE notice).
    """
    raw = (cfg.app_repo_path or "").strip()
    if not raw:
        raw = f"../{cfg.name}"
    p = Path(raw)
    if p.is_absolute():
        return p
    return (Path(software_factory_root) / p).resolve()


def list_apps(software_factory_root: Path) -> list[dict[str, object]]:
    """Discover every ``apps/*/config.yaml`` and return one summary dict per app.

    Each dict contains at least: ``name``, ``repo``, ``self_tick_enabled``,
    ``deploy_enabled`` — reading effective values from the app's config.yaml.
    The function is pure: it never mutates config, filesystem, or runtime state.
    """
    apps_dir = Path(software_factory_root) / "apps"
    if not apps_dir.is_dir():
        return []

    result: list[dict[str, object]] = []
    for cfg_path in sorted(apps_dir.glob("*/config.yaml")):
        app_name = cfg_path.parent.name
        cfg = load_app_config(app_name, software_factory_root)
        result.append(
            {
                "name": cfg.name,
                "repo": cfg.repo,
                "self_tick_enabled": cfg.self_tick_enabled,
                "deploy_enabled": cfg.deploy.enabled,
            }
        )
    return result
