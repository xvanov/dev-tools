<!-- STALE as of 2026-08-07: the four manager LLM tiers and factory_improver described below were deleted (op/019-p0). A second batch — bug_hunter, ralph, architect, release_manager, ux_designer, and their schedules/rate-limits/routes — was deleted the same day (019 AC5); every reference to those five personas below (Key concepts, Key files, Failure modes, Escalation paths, and their Persona-inventory entries) is dead. The persona corpus is now 13 files, not 20. Regeneration pending. -->

# Personas — contracts, model tiers, and breakpoints

## Overview

`factory/personas/*.md` are load-bearing protocol specs: each defines what a
persona receives, what output schema it must emit (or what files it must
land via tool calls), and what downstream stage consumes that artifact.
`factory/personas/loader.py` parses every file as optional-YAML-frontmatter
+ markdown body (every current file has no frontmatter and parses as
all-defaults); `load_persona()`/`read_persona_prompt()` strip frontmatter
before it reaches a model. Model routing is external: `factory/routes.yaml`
maps persona name → LiteLLM model id, so retiering a persona is a YAML edit,
not a prompt change. 20 persona `.md` files exist; `available_personas()`
treats the directory's `*.md` glob as the registry.

## Key concepts

- **Two execution modes.** JSON-only personas (`pm`, `analyst`, `architect`,
  `sm`, `ux_designer`, `test_designer`, `acceptance_author`, `reviewer`,
  `tech_writer`, `release_manager`, `bug_hunter`, `ralph`, `security`,
  `ux_auditor`, `factory_improver`, the manager stack,
  `factory_self_context`) return one JSON object via `text_run` — the chain
  reads the return value, never a file. Tool-using personas (`dev`,
  `test_implementer`, `onboarder`) run in an OpenHands sandbox and must land
  changes via file-edit/Bash calls; the chain checks `git diff`/`git
  status`/exit code after the sandbox exits, so chat-only "I changed X" is a
  failed run.
- **Interface contract (`contract`, 2026-08-09).** The ONLY role that reads
  both the real app and the spec. Runs per DIRECTION, before any story exists,
  and writes `apps/<app>/directions/<id>/api_spec.md` — the document `sm`/`dev`
  AND the dev-blind `acceptance_author` both consume (`acceptance._compose_spec`
  reads it verbatim). Its route table is PARSED from the app's source
  (`factory/chain/route_table.py`), never recalled by the model: a model asked
  to remember routes confabulates them, and a fabricated route becomes an oracle
  that 404s at HEAD however correct the implementation is. Invoked by
  `factory write-contract --app X --direction N`; output needs operator
  ratification (it can pick a weak observable — see Failure modes). Also emits a
  GRADEABILITY verdict classifying each criterion `oracle` / `test-suite` /
  `none`; only `none` (or nothing oracle-graded at all) blocks.
- **Canonical handoff chain (`chain_kind="tdd"`, default):** `pm` triages +
  decomposes a `Direction` → `architect` (only above the architectural
  threshold) rewrites current-state/diagrams → `sm` writes one BMAD story
  file per child story (calling `ux_designer` first when a frontend story's
  `flow.md` has gaps) → `acceptance_author` authors a spec-blind oracle test
  at spawn time → `test_designer` plans tests → `test_implementer` writes
  the red tests → `dev` implements against them (owns code AND tests) →
  `reviewer` verdicts the PR → `tech_writer` rewrites context after approval
  → merge gates (incl. the acceptance oracle) → auto-merge →
  `release_manager` validates/structures the deploy plan.
- **Docs chain (`chain_kind="docs"`):** `sm` (docs mode) → `onboarder` →
  `factory/context/enforcer.py` → PR. Skips test_design/test_impl/dev/
  reviewer — for stories whose entire deliverable is canonical docs.
- **`analyst`** is a side-branch off `pm` for epic-shaped directions
  (phases/metrics/risks); it does not replace PM's `child_stories` — both
  lists go to the user.
- **Independent acceptance oracle (`acceptance_author`, WS1.2).** Authored
  at story-spawn time (pm-sync), from the spec alone — never the dev's code
  or tests. Stored under `state/acceptance/<app>/<story_id>/`, outside the
  app repo and the dev's worktree, so the dev sandbox has no path to it.
  `StoryRecord.acceptance_test_ref` holds the stored ref. Required-ness is a
  property of the APP, not of that row: once `gates.acceptance_oracle` is on,
  `acceptance-verified` is required for every non-docs story and the gate
  decides applicability, re-deriving "does this story have acceptance
  criteria" from the direction on disk (a DB flag can be lost by a failed
  write; app config cannot). Authoring is bounded (3 passes, then it stays
  blocked and names the exhaustion), idempotent (a stored oracle is never
  re-authored — the pre-dev freeze is the anti-reward-hack property), and its
  output is validated before it is stored: parses as python, declares a
  `test_*`, passes the runner's static import allowlist, and — since
  2026-08-10 (PR #297, the story-186 class) — survives a real
  `pytest --collect-only` smoke in the runner's own isolation, because a
  `@pytestFixture`-style NameError is valid syntax that only import catches.
  The freeze has exactly TWO exceptions, both in `reauthor_missing_oracles`:
  a stored legacy import-form oracle once the app gains a boot recipe, and —
  since 2026-08-10 (the story-185 class) — ONE bounded auto-re-author when
  the gate recorded an ALL-SETUP block (`oracle_setup_failed`) whose
  `oracle_sha` matches the stored oracle: the recorded SETUP failure lines
  are fed back sanitized and fenced as untrusted data, an
  `auto_reauthor.json` marker (written before the LLM call, reset only by
  `resume-story --reauthor-oracle`) caps it at one attempt per story per
  operator-resume episode, and the swap is logged on the story's event
  stream (`oracle_auto_reauthored`).
- **The oracle needs the app's harness, and the app must declare it.** The
  author is blind to the implementation but must still be able to IMPORT the
  app: `gates.acceptance_harness_hint` gives it the repo-layout facts, and
  `gates.acceptance_test_dir` / `acceptance_test_cwd` /
  `acceptance_test_command` tell the gate where to place and how to run the
  test. With the defaults (repo root, factory interpreter) a real app's oracle
  cannot import anything — measured 2026-08-05 against sacrifice. The gate
  requires exit 0 AND at least one passing test (an all-skipped run verifies
  nothing), and blocks on any infrastructure error rather than raising.
- **The oracle's green has to mean something, and three things make it so**
  (2026-08-05; the flag stayed off until they existed).
  1. **It runs in a THROWAWAY judge worktree, never the dev's checkout.**
     Production code comes from HEAD, the whole test surface (every diff path
     that is not `diff_paths.is_production_path`) is rolled back to the merge
     base. Otherwise the diff configures its own verdict: a
     `pytest_runtest_call` hookwrapper, `addopts = "-p _fixup"`, or
     `backend/tests/__init__.py` rebinding the function under test each forced a
     pass against a violating implementation. The oracle never lands in the dev's
     tree at all, which also removes the leak window and the `.pytest_cache`
     disclosure of its test names.
     **One documented exception to that rollback set: `pyproject.toml`.** It is a
     pytest collection channel *and* the dependency manifest the app's acceptance
     command resolves against (`uv run --extra dev pytest`, cwd `backend`), so
     reverting it wholesale made every story that ADDS a dependency fail
     collection and get blamed for it authoritatively. Its two roles are split —
     `[tool.pytest.*]` from the merge base, every other table from HEAD
     (`red_green.rollback_pytest_config_only`, verified against `tomllib`, fails
     safe). Backing that up: an **errors-only** red at HEAD is non-authoritative
     whenever anything was rolled back, because a collection error after we
     rewrote the tree may be ours rather than the dev's. Taking dependencies from
     HEAD necessarily admits a dependency that registers a `pytest11` entry point
     — the same in-process class as the known-open hole below.
  2. **A green at HEAD is credited only when failability is established.**
     Primary: the same oracle is RED at the merge base (`chain/red_green.py`) —
     "at least one test failed there", never "the whole file was red", because a
     story implementing one of several criteria legitimately leaves the others
     green. Fallback, only when the base run is `unknown`: ablate a production
     symbol the diff touched and require the oracle to notice
     (`chain/mutation.py::check_can_fail`). The base run is the stronger
     instrument and its definitive answers are never overturned.
  3. **The checkout must be the merge candidate** — `pr.head_sha` an ancestor of
     HEAD *and* HEAD adding nothing over it but the base branch.
  Anything unverifiable BLOCKS non-authoritatively, is listed in
  `factory inbox`, and is the only family `factory acceptance-waive` can clear.
  Independence is still **conventional, not structural**, in one respect: the
  restored test surface is the app's own previously merged code (sacrifice's
  conftest overrides `get_db`). What is structural is that THIS story's diff
  cannot change it.
- **EARS mode.** `sm` decomposes every verbatim AC into
  `### Testable Claims (EARS)` (`AC<n>.<m>: WHEN … SHALL …`). When EARS
  claims are present, `acceptance_author` encodes them as Hypothesis
  `@given(...)` property tests instead of single examples.
- **Scheduled / finding-only personas** never touch code: `bug_hunter`
  (daily, static-analysis tools), `ralph` (hourly, spec/context drift),
  `security` (weekly + on `(security)`-tagged directions), `ux_auditor`
  (daily/per-deploy; v1 wiring is `text_run` against the static prelude —
  the live-browser/Playwright sandbox path is reserved, not yet live),
  `factory_improver` (daily), and the manager ladder `manager_watcher` →
  `manager_summarizer` → `manager_diagnostician`. All return JSON; handlers
  turn that into filed directions or pinned-issue/proposal updates — never
  a persona-opened GitHub issue or direct patch.
- **Shared canonical-paths contract.** `architect`, `sm`, `tech_writer`,
  `dev`, `onboarder` share one allowlist (`prd.md`, `context/project.md`,
  `context/current-state.md`, `context/architecture-diagrams.md`,
  `context/navigation.md`, `context/glossary.md`,
  `context/sprint-status.yaml`, `context/modules/*.md`, `stories/*.md`) and
  one forbidden list (`context/decisions/*`, `context/changelog.md`,
  `context/history.md`, `context/old-*`, `context/archive/*`,
  `docs/decisions/*`, `docs/adr/*`). Rewrites are full-file replacements —
  no append, no "we used to do X" framing; `factory/context/enforcer.py`
  rejects the ENTIRE output if any emitted path is non-canonical/forbidden.
- **Architectural-threshold routing.** `architect` runs when PM's result has
  `len(child_stories) >= 3`, OR any child scope is `infra`, OR a title
  mentions `schema`/`migration`/`dependency`/`rewrite`/`architecture`.
- **Dev/test enforcement is diff-based, not self-reported** — see Failure
  modes/Escalation paths below. Note: dev.md's *only* current escape hatch
  for a bad AC is `SELF_SUMMARY:`; there is no literal
  `TESTS_NEED_CLARIFICATION:` output-prefix requirement in the current
  prompt, though `factory_improver.md` still lists strengthening that
  language as an open heuristic.
- **Review convergence is chain-capped**, not persona-enforced — the
  dev↔reviewer loop is hard-capped at 3 cycles regardless of what `reviewer`
  finds; see Escalation paths.
- **Every persona has an explicit null/refusal path.** `pm` → `child_stories:
  []` on insufficient backpressure; `release_manager` → `deploy_plan: []`
  on a missing mandatory command, destructive shell pattern, or >32 steps;
  `bug_hunter`/`ralph`/`security`/`ux_auditor` → empty findings rather than
  invented work; `manager_diagnostician` → `escalate_to_human: true` with an
  emptied `suggested_patch` rather than a low-confidence patch.

## Key files

- `factory/routes.yaml` — model routing, per-model output-token caps,
  sandbox LLM-constructor overrides. `factory/model_router.py` reads it.
- `factory/job_routing.py` — per-app (`config.yaml::models`) and per-job
  (direction frontmatter `models:` / `pipeline:`) overrides, 2026-11-02.
  Precedence per persona key: job > app > routes.yaml. Resolved once in
  `handle_stories_spawned` (pre-checked in `pm_sync` before the PM call) and
  stamped on `StoryRecord.model_overrides_json` / `.pipeline`; handlers read
  only the stamp (`handlers._route_for`). Reviewer independence is re-checked
  on the merged map and a collision is refused (`review_independence`), never
  repaired. `pipeline: auto` (or absent) takes `AppConfig.pipeline_default`
  (`Literal["chain","solo","auto"]`, default `chain`; `auto` there = `chain`).
  `pipeline: solo` runs the production solo engine (`factory/chain/solo.py`):
  one long dev conversation with in-conversation gate feedback, no reviewer,
  then the shared tech_writer → docs_enforcer → delivery → merge-gate path.
  `SOLO_PIPELINE_IMPLEMENTED` is its kill switch.
- Providers: any persona may use `anthropic/…`, `openrouter/…`, `openai/…`, or
  `openai_compat/…` (generic OpenAI-compatible endpoint; base URL mandatory)
  in addition to Azure/DeepSeek — the 2026-07-15 "no Anthropic" rule was
  reversed 2026-11-02. Default routes are unchanged. Key/base-URL table: the
  `routes.yaml` header.
- `factory/personas/loader.py` — frontmatter/body parsing + persona
  registry; `factory/personas/validator.py` — output-schema validation.
- `factory/personas/{pm,analyst,architect,sm,ux_designer}.md` — direction
  triage through story prep (see chain diagram above for each one's role).
- `factory/personas/contract.md` + `factory/chain/contract.py` — the interface
  contract author and its gradeability verdict; `factory/chain/route_table.py`
  parses the app's real routes (prefix-joined) so the contract can only reuse or
  knowingly extend paths that exist. CLI: `factory write-contract`.
- `factory/personas/acceptance_author.md` — spec-blind oracle author;
  `factory/chain/acceptance.py` is the calling code.
- `factory/personas/{test_designer,test_implementer,dev,reviewer}.md` — the
  TDD implementation loop.
- `factory/personas/tech_writer.md`, `onboarder.md` — post-approval and
  one-time (phase-budgeted: ≤30 reads, ≤50 tool calls) context rewrites.
- `factory/personas/release_manager.md` — validates/structures the deploy
  plan; refuses on missing safety commands or destructive patterns.
- `factory/personas/{bug_hunter,ralph,security,ux_auditor}.md` — scheduled,
  code-untouching finding generators.
- `factory/personas/{factory_improver,manager_watcher,manager_summarizer,
  manager_diagnostician}.md` — factory self-observation + FMS escalation
  stack (L1→L2→L3; only L3 has halt authority).
- `factory/personas/factory_self_context.md` — generates this class of
  context-module doc for the factory's own subsystems.

## Failure modes

- **The spec gap (root cause of the 2026-08-08/09 direction-117 stall).** When a
  direction names no routes, `dev` and the dev-blind `acceptance_author` must
  independently invent the same interface. They converge only by luck. The
  author has exactly two moves, both blocking: GUESS a route (oracle 404s at
  HEAD regardless of the code — cost ~$4.56 on 117 before it was known), or
  DECLINE (all-`pytest.skip` vacuous oracle — cost ~$0.13). Cure: run
  `contract` first so both sides read one frozen `api_spec.md`. A direction
  whose criteria cannot be made observable is returned to the operator instead
  of spawning stories that cannot pass.
- **A ratified contract can still pick a weak observable.** On direction 117 the
  contract author concluded "no sensitive-operation endpoint exists in the route
  table" and settled for observing `email_verified` state, when `POST /api/goals`
  exists and is exactly the route dev gated — grading AC1 as state-observability
  rather than gate-enforcement. Green would then mean less than it appears. The
  author cannot catch this about itself; this is what operator ratification is
  for.

- **JSON/protocol mismatch.** A JSON-only persona emits prose, wrong schema,
  or a field outside contract. Symptom: chain parser rejects it, downstream
  stage never starts. Highest-risk: `sm` (20k-token hard cap — must
  self-truncate with `TRUNCATED_INDICATOR`), `manager_diagnostician` (must
  emit a valid unified diff or L4's `git apply` drops the proposal as
  `invalid`).
- **No-op tool-persona runs.** `dev`/`test_implementer`/`onboarder` describe
  changes in chat but call no file-edit tool. Symptom: empty `git diff`/
  `git status` after sandbox exit; run marked failed (onboarder specifically
  checks `git status --porcelain`).
- **Forbidden/non-canonical path writes.** `architect`/`sm`/`tech_writer`/
  `dev`/`onboarder` emit a path outside the canonical set. Symptom:
  `factory/context/enforcer.py` rejects the ENTIRE output.
- **Oversized/mis-sized PM decomposition.** A child story exceeds the hard
  caps (>5 new files / >2 modified / >200 iterations) — horizontal
  scope-grouping instead of vertical slicing (PM's own D007 anti-example).
  Symptom: chain rejection, or a dev sandbox that exhausts 600 iterations.
- **False-red / unsatisfiable tests.** `test_implementer` accepts a
  collection-time `ImportError`/broken-`conftest` failure as "red"; or
  `test_designer`/`test_implementer` assert against an aspirational
  `api_spec.md` example instead of the real delegated-to contract. Symptom:
  dev gets an unusable or unsatisfiable baseline; the story stalls
  regardless of dev quality.
- **Dev/test contract violation.** Dev edits a frozen test (diff-detected)
  or exhausts retries. Symptom: chain routes to terminal
  `BLOCKED_TESTS_NEED_CLARIFICATION` (recovery transition:
  `BLOCKED_TESTS_NEED_CLARIFICATION → SM_DONE` once a human clarifies).
- **Acceptance-oracle independence break.** If `acceptance_author` were ever
  wired to see the dev's code/tests, the oracle stops being an honest spec
  judge. The control is architectural (state storage outside the worktree),
  not a prompt instruction the model could be argued out of.
- **Truncated output from token caps.** Configured caps: `deepseek/
  deepseek-chat` and `deepseek-coder` = 8192; `azure/gpt-5.4` = 16384;
  `azure/deepseek-v4-pro` = 8192; `azure/gpt-5.3-codex` = 16384; unlisted
  models fall back to 8192. Large-payload personas (`sm`, `architect`,
  manager stack) can still overflow on a verbose response. Symptom: partial
  JSON, `JSONDecodeError`, or a `finish_reason=length` string —
  `manager_watcher.md` treats that exact string as escalation-worthy on
  first occurrence because the diagnosis is self-evident.
- **Missing-route silent fallback.** `test_designer` and
  `factory_self_context` have NO entry in `routes.yaml`'s `routes:` or
  `azure_routes:` blocks — they resolve via `defaults.azure_fallback`
  (`azure/gpt-5.4`) / `defaults.fallback` (`deepseek/deepseek-chat`).
  Deliberate router feature, but these two move silently if the defaults
  change, with no explicit line in the routing file.
- **Provider-key degradation.** `model_router.route()` silently degrades any
  route whose provider API key is missing to the active block's fallback
  (warned once per persona+model) — a misconfigured `.env` changes which
  model runs a persona without failing loudly. Per-app/per-job overrides
  degrade the same way (`route_with_overrides`); `job_routing` returns a
  warning at submit/spawn, and the story runs on the fallback. Independence
  is checked on both the configured map and the models that will actually run
  (`check_runtime_independence`: every reviewer/dev tier resolved through
  `route_with_overrides`, so a routes.yaml dev tier degrading onto a job-named
  reviewer is caught too) at submit/spawn
  (today's `azure_fallback` IS the dev model, so an unprovisioned reviewer
  override would otherwise review with the dev's model). A key removed from
  `.env` AFTER spawn is not re-checked at dispatch.
- **Unsafe deploy-plan acceptance.** The refusal in `release_manager` (missing
  safety command / destructive shell substring) is prompt-enforced
  (`deploy_plan: []` + `rationale`); no second code-side check is described
  in the persona file itself.

## Escalation paths

- **`dev` test conflict:** touching a frozen test, or exhausting retries,
  routes to the terminal `BLOCKED_TESTS_NEED_CLARIFICATION` state (state
  machine transitions on `EVENT_DEV_EXHAUSTED`, or a branch-diff check); the
  orchestrator's recovery mapping allows `→ SM_DONE` to restart from
  story-prep.
- **`test_implementer` slop or unsatisfiable red:** sets
  `slop_detected: true`; the chain routes the plan back to `test_designer`.
- **`reviewer` rejection:** `verdict: request_changes` blocks approval;
  `medium`/`high` findings (only `correctness|contract|security|tests` may
  block) route back to `dev`, which applies `suggested_edit` blocks
  verbatim where offered. Capped at 3 cycles; non-convergent stories
  terminate at `blocked_review_nonconvergent`. `test_quality_score < 0.7`
  forces `request_changes` regardless of code findings.
- **`architect`/`sm`/`tech_writer`/`dev`/`onboarder` forbidden paths:**
  `factory/context/enforcer.py` rejects the entire output, not a partial
  acceptance.
- **`release_manager` invalid plan:** `deploy_plan: []` + refusal
  `rationale`; the deploy orchestrator does not proceed.
- **Scheduled personas** (`bug_hunter`, `ralph`, `security`, `ux_auditor`,
  `factory_improver`) never modify code or open issues directly.
  `run_scheduled_persona` (the first four) or the dedicated
  `factory_improver.py` handler converts findings into filed directions (the
  normal `pm`→... chain) or a pinned, idempotently-updated `factory-
  improvements` GitHub issue.
- **FMS stack:** `manager_watcher` (L1, every 60s) summarizes and may set
  `escalate_to_l2` — one override: `stalled_stories.alarms` non-empty
  ALWAYS forces escalation. `manager_summarizer` (L2, every 3 min or on L1
  escalation) emits a concern with `urgency: continue|warn|halt` and may set
  `escalate_to_l3`. `manager_diagnostician` (L3, escalation-only) emits a
  root-cause proposal with a unified-diff patch and a `target_class` safety
  gate (`prompt_edit` may auto-merge; `persona_settings`/`dispatch_code`/
  `detector_tool` are always a human-review PR), or sets
  `escalate_to_human: true` on low confidence. **Only L3 may request a
  factory-wide halt** (`request_halt: true` + non-empty `halt_reason`) — L1
  and L2 have no halt authority.
- **Operator intervention:** `factory resume` is the only way to clear a
  halt — an operator action automation must never trigger. Otherwise, human
  intervention arrives via a blocked/terminal story state, a
  `request_changes` PR, a pinned `factory-improvements` issue, or a
  `manager_diagnostician` proposal that classified as risky and became a PR.

### Persona inventory: consumes → produces, model, breakpoint

Azure model shown first (active: `default_provider: azure`), direct-provider
fallback in parentheses. No entry in either `routes.yaml` block → resolves
via `defaults.azure_fallback` / `defaults.fallback`.

- **`pm`** — Direction+context → type/priority/backpressure/`child_stories[]`;
  `azure/gpt-5.4` (`deepseek/deepseek-chat`); breaks on oversized/horizontal
  child stories or fabricated ACs.
- **`analyst`** — Direction+PM JSON → phases/metrics/risks; `azure/gpt-5.4`
  (`deepseek/deepseek-chat`); breaks by inventing requirements or replacing
  PM's stories silently.
- **`architect`** — PM result+context → full-file `context_updates[]`;
  `azure/gpt-5.4` both blocks; breaks on forbidden paths or speculative
  future-state diagrams.
- **`sm`** — direction+PM JSON+context → one story's JSON (`target_path`
  issue placeholder `0`); `azure/gpt-5.4` both blocks; 20k-token ceiling
  (self-truncates past 16k); breaks on invented ACs or budget overflow.
- **`ux_designer`** — story+flow.md+context → `flow_additions`/`ui_notes`;
  `azure/gpt-5.4` both blocks; breaks by inventing gaps or proposing backend
  work.
- **`acceptance_author`** — spec ONLY (no dev code/tests) →
  `{"test_file_content": "..."}` (Hypothesis property tests under EARS);
  `azure/gpt-5.4` both blocks — deliberately a different model family than
  `dev`/`test_implementer` (DeepSeek) to reinforce independence; breaks by
  weakening an assertion to match an anticipated implementation.
- **`test_designer`** — story+flow/api spec+gates → `test_plan[]`+
  `e2e_required`; **not routed** → `azure/gpt-5.4`/`deepseek/deepseek-chat`
  fallback; breaks by planning an E2E test when `e2e_harness_ready` is false
  or grounding on an aspirational spec example.
- **`test_implementer`** — test plan+story+gates → test files on disk +
  `slop_detected`/`exit_code` report; `azure/deepseek-v4-pro`
  (`deepseek/deepseek-coder`); `reasoning_effort: "none"`; breaks on green
  pre-impl tests or harness-failure mistaken for red.
- **`dev`** — story+repo+context → code+tests on disk + `SELF_SUMMARY:`;
  standard `azure/deepseek-v4-pro` (`deepseek/deepseek-coder`) /
  hard `azure/gpt-5.3-codex` both blocks (deliberately a different model
  family — escapes Azure content-filter blocks, adds a capability jump);
  `reasoning_effort: "none"` standard / `high` hard; breaks on touching
  frozen tests or exhausting retries without landing code.
- **`reviewer`** — PR diff+story+tests+dev self-summary+context →
  `verdict`/`findings[]`+`test_quality_score`; `azure/gpt-5.3-codex` both
  blocks; `reasoning_effort: high` (sandbox reviews only); carries a
  provenance mandate — story-silent literals/formats/data sources must cite a
  repo precedent (`file:line`) in the dev's self-summary, and same-diff test
  fixtures are never evidence; breaks by moving the goalposts on re-review
  (chain clamps this past cycle 3) or approving below the 0.7 test-quality
  threshold.
- **`tech_writer`** — final PR diff+context+story → full-file
  `context_updates[]`; `azure/gpt-5.4` (`deepseek/deepseek-chat`); breaks on
  non-canonical paths or preserving reversed decisions.
- **`onboarder`** — existing repo only, once per app → full canonical
  `context/` set on disk (≤30 reads, ≤50 tool calls); `azure/gpt-5.4` both
  blocks; breaks on exhausting budget with nothing written.
- **`release_manager`** — merged-PR metadata+`DeployConfig` → ordered
  `deploy_plan[]`+`rollback_command`; `azure/gpt-5.4`
  (`deepseek/deepseek-chat`); breaks by accepting a plan missing a mandatory
  command or missing a destructive-pattern match.
- **`bug_hunter`** — app config+root → runs scanner subprocesses →
  `findings[]`+`runs_completed[]`; `azure/gpt-5.4` (`deepseek/deepseek-chat`);
  breaks by silently skipping a missing tool instead of recording
  `<tool>:errored`, or spamming duplicate directions.
- **`ralph`** — app config+prd+context+source → `drifts[]` (spec|context);
  `azure/gpt-5.4` (`deepseek/deepseek-chat`); output <1024 tokens; breaks by
  inventing drift without a cited file/test.
- **`security`** — app config+docs+source(+direction on tagged runs) →
  `threat_model_summary`+`findings[]`; `azure/gpt-5.3-codex` both blocks;
  ~3000 output tokens; breaks on uncited findings.
- **`ux_auditor`** — app config+extracted flow.md files (v1: `text_run`,
  static prelude — live-browser path reserved, not shipped) → `findings[]`
  (friction|accessibility|broken-affordance|slow); `azure/gpt-5.4`
  (`deepseek/deepseek-chat`); breaks by inventing a finding or side-effecting
  the working tree.
- **`factory_improver`** — redesign events+blocked stories+persona index+
  state-machine summary → `improvements[]` with a REQUIRED unified-diff
  `suggested_patch`; `azure/gpt-5.4` (`deepseek/deepseek-chat`); breaks on a
  free-text recipe (auto-dropped as invalid).
- **`manager_watcher`** (L1) — signals+detector results+prior notes →
  `summary`+`escalate_to_l2`+`observations[]`; `azure/deepseek-v4-pro` both
  blocks (cheapest deployed model; L1 fires every 60s and historically drove
  ~88% of persona-call spend); breaks by escalating on one ambiguous event or
  missing a `stalled_stories` alarm.
- **`manager_summarizer`** (L2) — flagged notes+signals+detector docstrings+
  up to 5 prior concerns → concern doc+`urgency`+`escalate_to_l3`;
  `azure/gpt-5.4` both blocks; breaks by fabricating evidence or escalating
  `review_churn` alone.
- **`manager_diagnostician`** (L3) — one concern+pre-loaded source+detector
  hints → `diagnosis`+`proposal` (unified diff+`target_class`)+optional
  `request_halt`; `azure/gpt-5.3-codex` both blocks — the only persona with
  halt authority; breaks by shipping a low-confidence speculative patch
  instead of escalating, or repeating a listed failed attempt.
- **`factory_self_context`** — module name/topic+source bundle → ≤2000-word
  Markdown context module; **not routed** → `azure/gpt-5.4`/`deepseek/
  deepseek-chat` fallback; breaks by inventing unconfirmed behavior instead
  of writing "not confirmed in provided source."
