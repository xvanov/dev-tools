# Observability — signals, schemas, integrity, and consumers

## Overview

The factory's observability layer has two write paths and one shared read
substrate. The write paths are: global append-only NDJSON streams under
`state/events/` (fleet-level telemetry for the FMS and detectors), and
per-story JSONL audit logs under `state/logs/` (the forensic trail behind
`factory why <id>` / `factory trace <id>`). The shared substrate is
`state/factory.db` (SQLite), whose schema this layer owns and migrates.

On top of those raw logs sit four verification/derived layers that did not
exist in the original design and are easy to miss if you only read
`signals.py`: a tamper-evident hash chain over the NDJSON streams
(`audit_chain.py`, checked by `factory audit-chain`), a conformance checker
that replays every recorded state change against a declared model of legal
transitions (`conformance.py` + `conformance_model.yaml`, checked by
`factory conformance`), a complete state-write emitter that captures every
`StoryRecord.state` mutation regardless of which module performed it
(`state_trace.py`), and a live-handler heartbeat table that lets the TUI show
what is executing right now (`heartbeat.py`).

All writers in this layer are explicitly best-effort and fail open: a
telemetry write failure must never break a real tick or handler. The
verifiers (`audit_chain.verify_stream`, `conformance.check_trace`) are the
opposite — they fail loud (raise on a malformed model, report tampering
rather than silently accepting it) because a verifier that degrades quietly
is worse than no verifier.

## Key concepts

- **Two log surfaces, two audiences.** `state/events/*.ndjson`
  (`factory/manager/signals.py`) is cross-cutting operational telemetry read
  by manager detectors and the FMS watcher. `state/logs/<story_id>-<slug>.log`
  (`factory/chain/event_log.py`) is a per-story JSONL trail read by
  `factory why <id>` / `factory trace <id>` to explain how one story got to
  its current state. Per the repo's "Where truth lives" convention
  (`CLAUDE.md`): story state itself lives in `state/factory.db`; these two
  logs are "what happened", not "what is".
- **Eleven NDJSON streams**, all under `state/events/`: `runs`, `ticks`,
  `queue`, `webhooks`, `git`, `spend` (the original six, wired in
  `factory/runner.py — _record_run()` and `factory/chain/orchestrator.py —
  tick()`), plus `alerts` (control-plane fail-safe alarms, `signals.ALERT_STREAM`),
  `state_writes` (every `StoryRecord.state` change, `state_trace.py`),
  `prompts` (per-call prompt METADATA at high volume — the module
  docstring in `audit_chain.py` notes this stream alone runs to ~45k records
  live, which is why chain-head writes use `flush()` and not `fsync()`),
  `prompt_bodies` (the verbatim prompt text per persona call,
  `factory/runner.py — _log_prompt_body()`, its own 100 MB x 3 rotation
  window), and `response_bodies` (the verbatim model RESPONSE per persona
  call, `_log_response_body()` — joins its prompt row via the full
  `prompt_hash`; sandbox rows carry a `trajectory_path`). Both body streams
  share one capture scope switch (`FACTORY_PROMPT_BODIES`: `chain` default /
  `all` / `off`).
- **OpenHands trajectories** live under `state/events/trajectories/
  <story>-<attempt>.ndjson`: the full per-run agent event stream (messages,
  tool calls, observations) copied out of the SDK's `persistence_dir` by
  `factory/runner.py — _capture_trajectory()` after every sandbox run —
  including timed-out and crashed runs, which leave a partial trail. Capped
  at 100 MB per file with a `trajectory_truncated` marker line. These are
  plain artifacts, not a hash-chained stream.
- **Common event envelope.** Every record written via `write_event()`
  carries at minimum `ts` (ISO-8601 UTC, tz-suffixed), `schema_version`
  (currently `1`), and `event` (a discriminator string). `write_event()`
  fills in `ts`/`schema_version` if the caller omitted them.
- **Best-effort writes, never silent.** `write_event()` and
  `log_story_event()` swallow I/O failures and print to `stderr` so a write
  failure can never crash a handler or tick. `write_event()` additionally
  keeps a process-local `_write_failure_count` (via
  `get_write_failure_count()`) so a rising failure count is observable to
  tests or a future health probe rather than purely living in stderr.
- **`write_alert_event()` is the loud path.** Used by halt/circuit-breaker
  fail-safe code when the factory cannot determine or record its own control
  state. It prints an `[ALERT:<severity>]` line to stderr *before* attempting
  the event write (so the alert is guaranteed even if the disk is gone), then
  writes an `event="alert"` record to `alerts.ndjson`.
- **Stream rotation caps unbounded growth.** `factory/events/rotation.py:
  rotate_if_needed(path, max_bytes=25_000_000, keep=3)` is called from inside
  `write_event()` before every append. It rolls `stream.ndjson` →
  `stream.ndjson.1` → `.2` → `.3`, dropping anything past `keep=3`, and leaves
  the live file absent post-rotation (next append recreates it) to avoid a
  TOCTOU race. Rotation is itself best-effort — a rotation failure is logged
  and the event is still appended.
- **The tamper-evident hash chain (`audit_chain.py`).** Every NDJSON append is
  optionally stamped with `chain_id`, `seq`, `prev_hash`, `entry_hash` before
  being written, all under one `fcntl.flock` held across reserve→hash→append→
  commit. `chain_id` is hashed first, so a row lifted out of one chain (e.g.
  a test run's isolated `FACTORY_STATE_ROOT`) can never verify inside another
  — this is the fix for the recurring test-pollution class where synthetic
  test failures were read back by the L1 watcher as real persona failures.
  Chaining is deliberately fail-open: if `fcntl` is unavailable or the head
  file (`.chainheads.json`) can't be locked, `append_chained()` returns
  `False` and the caller falls through to a plain unchained append — losing
  an event is never acceptable, losing its link is. `factory audit-chain`
  (`audit_chain_cmd` in `factory/cli.py`) iterates `known_streams(events_dir)`
  and calls `verify_stream()` per stream, distinguishing four *benign*
  conditions (`unchained_legacy_rows`, `truncated_by_rotation`, and the
  `seq_gap`/broken-link nuance below) from real tampering
  (`TAMPER_VERDICTS = {broken_link, foreign_chain_id, corrupt_entry, seq_gap}`).
  A `seq_gap` is deliberately classified as tampering, not benign: rotation
  only ever drops the *oldest* segment, so a gap in the middle of a retained
  run means entries were removed, not merely rotated away.
- **Conformance checking (`conformance.py` + `conformance_model.yaml`).**
  `conformance_model.yaml` is hand-maintained DATA — a list of legal
  `(from_state, to_state)` edges plus a declared allowlist of writers
  permitted to set `story.state` directly, bypassing `advance()` — checked
  independently of `factory.chain.state_machine._TRANSITIONS` on purpose
  (`tests/test_conformance.py` asserts they agree; drift is a CI failure, not
  silent mutual agreement). `judge_hop()` classifies each recorded hop as
  `legal_edge` (a single table edge), `legal_path` (net effect of ≤2 chained
  legal edges — the common real-world shape, since one handler dispatch
  persists only once), `allowed_direct_write` (a declared bypass, e.g.
  `orchestrator.reconcile_from_github` correcting the DB to match GitHub
  truth), `illegal_transition` (a declared writer producing an undeclared
  state), or `coverage_breach` (an *undeclared* writer changed `state` at
  all — the load-bearing verdict, since without it the checker only
  validates paths someone remembered to declare). `factory conformance`
  replays `state/events/state_writes.ndjson` through this model.
- **Complete state-write capture (`state_trace.py`).** Rather than
  instrumenting call sites (16 sites across `auto_merge`, `recovery`,
  `dual_draft`, `orchestrator`, `handlers`, and `webhook` write
  `story.state` directly, bypassing the two `chain_steps.ndjson` emission
  points inside the orchestrator), this module registers a single
  SQLAlchemy mapper-level `after_update` listener on `StoryRecord` via
  `install()`, called once at import time from `factory/chain/__init__.py`.
  Coverage is therefore complete by construction — any flush of a changed
  `state` column emits a `state_write` record — rather than depending on
  every writer remembering to instrument itself. It self-attributes the
  writer by walking the call stack past known plumbing frames
  (`_attribute_writer()`), returning `"unknown"` (a coverage breach) if
  attribution fails. `read_state_writes()` replays the stream in append
  order, oldest-segment-first, matching the rotation convention.
- **Live-handler heartbeat (`heartbeat.py`).** A `live_handlers` DB row is
  inserted on entry to a handler (`start_heartbeat`) and deleted on exit
  (`end_heartbeat`), normally via the `live_handler()` context manager. The
  TUI's `live_handlers()` query (`queries.py`) reaps stale rows first
  (`reap_stale_heartbeats`, via `os.kill(pid, 0)` liveness check) so a
  crashed process's row doesn't linger and mislead the dashboard.
- **The `migrate()` convention is load-bearing for tests.** `schema.py:
  migrate(db_path)` runs idempotent `ALTER TABLE ... ADD COLUMN` migrations
  against `runs`, `stories`, `directions`, and `SQLModel.metadata.create_all`
  for the newer `live_handlers` / `handler_baselines` tables. Every
  observability read/write helper calls `migrate()` before touching the DB
  (`queries.py`, `estimator.py`, `heartbeat.py` all call it via their local
  `_engine()`). Tests must bootstrap a test DB through `migrate()` (or a code
  path that calls it), never via a bare `create_engine()` +
  `SQLModel.metadata.create_all()`, because a fresh `create_all()` skips the
  `ALTER TABLE` migrations for columns not present in the current model
  definitions and will not exercise the same schema the live `factory.db`
  actually has.
- **Two independent stories-column migrators, merged.**
  `schema.stories_migration_columns()` merges its own `_STORIES_NEW_COLUMNS`
  with `factory.chain.handlers._MIGRATION_COLUMNS` (imported lazily to avoid
  a heavy import cycle) specifically because these two modules used to carry
  divergent column lists — which engine opened `factory.db` first decided
  which columns actually existed. No column is missing today, but adding a
  column to only one list re-opens the trap.
- **EBS estimator (`estimator.py`).** Adapts Joel Spolsky's Evidence-Based
  Scheduling: a "task unit" is one handler run (one `runs` row); a "velocity
  unit" is `(persona, model_tier)`; baselines are per-`(persona, points)`
  medians (`HandlerBaseline`, recomputed by `recompute_baselines()`).
  `monte_carlo_eta()` samples a velocity per remaining handler from the last
  30 days of history, sums `estimate/velocity` across all remaining handlers
  in a direction, and repeats for 500 iterations to produce P50/P75/P95. It
  gates on `N_VELOCITY_MIN = 5` samples per persona and returns
  `insufficient_data=True` with a `reason` string rather than inventing an
  ETA from thin data.
- **Detector model (cross-reference).** Manager detectors
  (`factory/manager/detectors/*.py`, registered in
  `factory/manager/detectors/__init__.py` as `DETECTORS` /
  `DETECTOR_DOCS`) are pure readers over these streams; they return
  observations only, never decisions. Full detector-by-detector detail lives
  in the `manager.md` context module — this module only documents what they
  read.

## Key files

- `factory/manager/signals.py` — central NDJSON writer (`write_event`,
  `write_alert_event`) and per-stream convenience wrappers
  (`write_run_event`, `write_tick_event`, `write_queue_snapshot`,
  `write_webhook_event`, `write_git_event`, `write_spend_snapshot`); owns
  rotation and hash-chain stamping on every append.
- `factory/chain/event_log.py` — per-story JSONL log (`log_story_event`,
  `read_story_events`) under `state/logs/`.
- `factory/observability/schema.py` — `LiveHandler` / `HandlerBaseline`
  SQLModel tables, idempotent column migrations for `runs`/`stories`/
  `directions`, and `migrate(db_path)` — the mandatory bootstrap entry point.
- `factory/observability/queries.py` — read-side query layer for the TUI
  (`collect_snapshot`, `app_summary`, `live_handlers`, `in_flight_stories`,
  `directions_in_flight`, `recent_runs`, `velocity_table`); one sqlite
  connection per call.
- `factory/observability/estimator.py` — EBS baseline computation and Monte
  Carlo ETA (`recompute_baselines`, `baseline_seconds`,
  `estimate_story_seconds`, `monte_carlo_eta`).
- `factory/observability/audit_chain.py` — hash-chain stamping
  (`append_chained`, `compute_entry_hash`, `chain_id_for`) and verification
  (`verify_stream`, `known_streams`), backing `factory audit-chain`.
- `factory/observability/conformance.py` — replay checker (`judge_hop`,
  `check_trace`, `check_live_trace`, `load_model`) over `conformance_model.yaml`,
  backing `factory conformance`.
- `factory/observability/conformance_model.yaml` — the declared legal-edge
  graph and direct-writer allowlist; hand-maintained, drift from
  `state_machine._TRANSITIONS` caught by `tests/test_conformance.py`.
- `factory/observability/heartbeat.py` — `live_handlers` row lifecycle
  (`start_heartbeat`, `end_heartbeat`, `reap_stale_heartbeats`,
  `live_handler` context manager).
- `factory/observability/state_trace.py` — mapper-level `after_update`
  listener (`install`, called from `factory/chain/__init__.py`) that emits a
  `state_write` record on every `StoryRecord.state` mutation regardless of
  writer; `read_state_writes()` replays the stream. Backs
  `factory trace <story-id>`'s ability to explain state changes and is the
  sole input to `conformance.py`.
- `factory/events/rotation.py` — `rotate_if_needed(path, max_bytes=25_000_000,
  keep=3)`, the size-based rotation shared by every NDJSON stream.
- `factory/manager/detectors/__init__.py` — detector registry (`DETECTORS`,
  `DETECTOR_DOCS`); see `manager.md` for per-detector detail.
- `factory/cli.py` — `trace_cmd` (`factory trace`), `audit_chain_cmd`
  (`factory audit-chain`), `conformance_cmd` (`factory conformance`).

## Failure modes

- **Signal write silently lost:** if `state/events/` can't be created or
  appended to, `write_event()` bumps `_write_failure_count`, prints
  `[signals] ANOMALY write_event ...` to stderr, and drops the record.
  Symptom: missing telemetry with no state-machine failure and no exception
  anywhere in the chain.
- **Non-JSON-serializable payload fields:** `write_event()` falls back to
  `repr()` per offending value (computed *before* chain-hashing, so the
  on-disk line always matches its own `entry_hash`) and logs a stderr
  warning. Symptom: record exists but some fields are stringified.
- **Per-story log unavailable:** `log_story_event()` swallows `OSError` and
  prints `[event_log] failed to write ...`. Symptom: `factory why <id>` /
  `factory trace <id>` show incomplete or empty evidence even though the
  story kept processing.
- **Malformed NDJSON/JSONL lines:** stream and story-log readers both skip
  unparseable lines rather than raising (`read_story_events()` inserts a
  `{"event": "malformed_log_line", ...}` placeholder; `audit_chain._iter_records`
  and `state_trace.read_state_writes()` silently drop a truncated final line).
  Symptom: a crash mid-append degrades the record count, not readability.
- **Chain stamping fails open:** if `fcntl` is unavailable or the
  `.chainheads.json` head file can't be locked, `append_chained()` returns
  `False` and the event is written unchained. Symptom: `factory audit-chain`
  reports growing `unchained_records` for that stream — expected on
  non-POSIX or permission-broken deployments, not itself tampering.
- **Real tamper verdicts (`broken_link`, `foreign_chain_id`,
  `corrupt_entry`, `seq_gap`):** mean an entry was edited, reordered, removed,
  or originated from a different `chain_id` (commonly a test's
  `FACTORY_STATE_ROOT`-redirected chain bleeding into what should be a clean
  comparison). `VerifyReport.tampered` is `True` only for these four —
  `unchained_legacy_rows` and `truncated_by_rotation` are excluded so routine
  rotation and pre-chaining history don't cry wolf.
- **Conformance `coverage_breach`:** a code path changed `story.state`
  without being either an `advance()`-reachable edge or a writer declared in
  `conformance_model.yaml`. This is a genuine finding — either the model is
  stale (a legitimate new writer needs a `why:` entry) or it is a real bug
  (an undocumented control-plane path). The loader (`load_model()`) also
  hard-fails (raises `ValueError`) on a malformed model or a writer entry
  missing its required `why:` field, rather than silently loading an empty
  model that would report perfect conformance for every trace.
- **`state_trace` attribution failure:** `_attribute_writer()` returns
  `"unknown"` if it cannot find a non-plumbing, non-library frame within 60
  stack levels. An `"unknown"` writer is treated as a coverage breach by the
  conformance checker, not silently accepted.
- **Stale `live_handlers` rows:** a crashed handler process leaves its row
  behind since `end_heartbeat()` never runs in the `finally` of a hard crash
  (SIGKILL). `reap_stale_heartbeats()` (called from `queries.live_handlers()`
  on every TUI poll) removes rows whose `pid` is dead via `os.kill(pid, 0)`.
  A `PermissionError` (pid exists, different uid) is treated as alive to
  avoid falsely reaping a live process the caller merely can't signal.
- **Missing or sparse EBS baseline data:** `estimate_story_seconds()` and
  `monte_carlo_eta()` fall back to hand-picked `_COLD_START_HANDLER_SECONDS`
  per `(persona, points)` when no `HandlerBaseline` row exists yet.
  `monte_carlo_eta()` additionally refuses to produce a distribution at all
  (`insufficient_data=True`) when any needed persona has fewer than
  `N_VELOCITY_MIN=5` velocity samples, naming the short persona(s) in
  `reason` rather than emitting a misleadingly precise ETA.
- **Two stories-column migrators drifting:** if a future change adds a
  column to only `schema._STORIES_NEW_COLUMNS` or only
  `handlers._MIGRATION_COLUMNS` instead of through
  `stories_migration_columns()`, whichever engine opens `factory.db` first
  again decides which columns exist — the exact bug this merge was written
  to close.

## Escalation paths

Telemetry writers favor **containment over escalation** — nothing here halts
a tick. The verifiers (`audit_chain`, `conformance`) favor the opposite:
report loudly, never wave through.

- **Global stream write loss:** no automatic state transition follows. The
  rising `_write_failure_count` and stderr `[signals] ANOMALY` lines are the
  only signal; an operator inspects `stderr` and `state/events/` path health.
  Historical gaps are not auto-repaired.
- **Control-plane fail-safe conditions** (halt/circuit-breaker read or write
  failures): escalate via `write_alert_event()` to `alerts.ndjson` plus an
  unmissable `[ALERT:<severity>]` stderr line — this is the one signal
  category deliberately louder than "best-effort and forget", because it
  means the factory could not determine its own control state.
- **Per-story audit-log loss:** story execution continues; the operator
  loses `factory why` / `factory trace` breadcrumbs. Recovery is manual:
  check `state/logs/` path health, fall back to surviving global streams and
  DB state.
- **Tamper verdicts from `factory audit-chain`:** the CLI command exits
  non-zero when any stream reports a `TAMPER_VERDICTS` member; an operator
  investigates `problems[]` in the report (each entry names the record index,
  verdict, and a human-readable detail e.g. "prev_hash ... does not match ...
  an entry was edited, removed, or reordered"). This is the mechanism that
  would catch a self-improving factory quietly weakening its own telemetry —
  which is also why `audit_chain.py` and `state_trace.py` sit alongside
  `factory/manager/**` on the self-edit-forbidden list in spirit (the tracer
  and checker paths must not be something the factory can rewrite to hide
  its own tampering).
- **Findings from `factory conformance`:** `illegal_transition` and
  `coverage_breach` are the two verdicts in `FINDING_VERDICTS`. The CLI
  surfaces them as a non-conformant report; the expected operator workflow is
  to triage each finding as either (a) a legitimate new writer that needs a
  `why:` entry added to `conformance_model.yaml`, or (b) a real control-plane
  bug to fix at the writer. Nothing here auto-remediates a finding — it is a
  detection-only surface, same posture as the manager's detector functions.
- **Detector anomalies:** detectors never escalate on their own; the next
  hop is the manager's L1/L2/L3 tiers, which consume `DETECTORS`/
  `DETECTOR_DOCS` output and decide whether to act. See `manager.md` for that
  escalation chain in full.
- **Stream-specific triage:**
  - `runs.ndjson` — check `factory/runner.py — _record_run()`.
  - `ticks.ndjson` / `queue.ndjson` / `spend.ndjson` — check
    `factory/chain/orchestrator.py — tick()`.
  - `webhooks.ndjson` — check `factory/webhook/github.py`.
  - `git.ndjson` — check `factory/chain/worktree.py` and commit/push sites in
    `handlers.py`.
  - `alerts.ndjson` — check the halt / circuit-breaker fail-safe paths that
    call `write_alert_event()`.
  - `state_writes.ndjson` — check `factory/observability/state_trace.py`'s
    `install()` registration in `factory/chain/__init__.py`; if a known
    writer's hops stop appearing, the listener may not have been installed
    before the write (e.g. a module writing `StoryRecord.state` through an
    ORM path that predates `factory.chain` import).
