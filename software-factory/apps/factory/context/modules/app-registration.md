# App registration — `factory app add` / `app set` / `app show` / `app list`

## Overview

Registers any GitHub repo as a factory app: writes `apps/<app>/config.yaml`,
creates `apps/<app>/directions/`, and (optionally) enables the tick timer.
The contract the personal assistant builds against is `docs/JOBS-API.md`.
The PA dashboard's Build page has a Repos section on top of these verbs.

| File | Role |
|------|------|
| `factory/app_detect.py` | Pure, read-only toolchain detection → proposed gate commands; docs-only + CI-workflow suggestions |
| `factory/gate_model.py` | Gate states (command / `none` / unset), `requires`, readiness, the submit check |
| `factory/cli_apps.py` | `add_app()` / `set_app()` / `show_app()` / `list_registered_apps()` + the `factory app` Typer sub-app |
| `factory/cli.py` | Registration line only (`app.add_typer(apps_app, name="app")`) |
| `tests/test_cli_app_add.py` | Fixture repos per toolchain, refusal paths, JSON shapes |
| `tests/test_gate_model.py` | Gate states, runners, submit refusal, `app set --gate`, CI + docs-only detection |

## The gate model

A gate field is a shell command, `none` (the repo has no such check: skipped,
reported `not configured: skipped`, never passing), or empty (not configured
yet). `gates.requires: {test: [lychee]}` lists binaries a gate needs on PATH.

- `runner._run_pytest`, the solo gate and `tests-green` treat `none` as skipped.
  The solo gate still requires a non-empty change. `static_gate_commands` drops
  a `none` lint/format/type gate.
- Missing required binaries: submit refuses (`gate_requirements_missing`); the
  dev handler blocks the story before the run (`gate_tools_missing` event, no
  dev retry spent); `tests-green` fails with `gate test needs X, not on PATH`.
- An empty test gate on a repo with no `tests/` is refused at submit
  (`gates_not_configured`) with the `app set` command that fixes it.
- Gate output is decoded as UTF-8 with replacement everywhere a gate runs
  (`_run_pytest`, `evaluator._run_command`, flake reruns, mutation): Windows'
  cp1252 default crashed on lychee's emoji and left `stdout` None.

Detection is deterministic. It makes no model calls. The `onboarder` persona
is not used: it writes `context/` docs, not gate commands.

## `app add` flow

1. Validate `--repo owner/name`, the app name (default: repo name, slugged),
   `--delivery-default` (any level; default `NEW_APP_DEFAULT = draft_pr`) and
   `--pipeline-default` (`chain|solo|auto`; default `chain`). Bad values are
   `invalid_delivery` / `invalid_pipeline`. There is no `--delivery-max`: the
   per-app ceiling was removed (operator decision 2026-11-02), and a config
   with `delivery.max` is refused at load.
2. Refuse, writing nothing, when:
   - `apps/<app>/config.yaml` exists (`app_exists`), unless `--force`.
   - another app already registers the same repo (`repo_already_registered`),
     unless `--force`.
   - the local path exists but is not a git checkout (`not_a_git_repo`).
   - the checkout's `origin` is not that repo (`repo_mismatch`), unless `--force`.
3. Clone when the path is absent (`gh repo clone`, else `git clone https://…`).
   Default path: `<factory root>/../<app>`, the `load_app_config` convention.
4. Detect gates, render a commented YAML, validate it through `AppConfig`, and
   write it. `app_repo_path` is `../<dir>` for a sibling, absolute otherwise.
5. Create `apps/<app>/directions/` and `<repo>/context/` (empty; the context
   loader reads `<repo>/context/`).
6. `--enable-tick` runs `systemctl --user enable --now factory-tick@<app>.timer`
   (the installed template units). Failure here is `enable_tick_failed`, and the
   config is already written.

7. Write `tracker:` (decision D29, `factory/tracker.py`): `--tracker` when
   given, else derived from the owner — `github_issues` for a personal owner
   (`FACTORY_PERSONAL_OWNERS`, default `xvanov`), `local` for every other repo.
   `--tracker github_issues` on a non-personal repo is `invalid_tracker`.

`--json` prints one object. Success:
`{app, repo, path, config_path, gates, delivery: {default}, pipeline_default,
tracker, missing_gates, toolchains, smoke_command, notes, cloned, tick}`. Failure, exit 1:
`{"error": "<code>", "message": "..."}`.


## `app set <app>`

Changes `delivery.default`, `pipeline_default` and/or gates of an existing app,
so the assistant (and the dashboard's Repos section) can change a repo's
settings after registration.

- At least one of `--delivery-default` / `--pipeline-default` / `--gate` /
  `--requires` / `--review-default` / `--review-min-diff-lines` / `--cap` /
  `--tracker` (`nothing_to_set`).
- `--tracker github_issues|local` sets the top-level `tracker:` line;
  `github_issues` on a non-personal repo is `invalid_tracker`.
- `--gate NAME=COMMAND` (repeatable; NAME `lint|format_check|type_check|test`
  or the field name): COMMAND `none` = no such check, empty = unset. One line
  only (`invalid_gate`). `--requires NAME=tool,tool` replaces that gate's list;
  empty removes it (`invalid_requires` for a non-executable name).
- Edits only the affected lines: `delivery:` → its `default:` child (added if
  absent; the block is added if absent), the top-level `pipeline_default:`
  line (appended if absent), and `gates:` → each `<field>:` child and one
  flow-style `requires: {...}` line. A child is matched only at the block's own
  indent, never inside a nested mapping (`acceptance_boot`). Trailing comments
  on those lines survive.
- The edit is parsed back and compared with the intended mapping. If the layout
  defeated the line edit (flow style `delivery: {…}`, an empty value), the file
  is re-dumped from parsed YAML and `comments_preserved` is `false`.
- The result is validated through `AppConfig` first. A config that still has
  `delivery.max`, or any other load error, is `invalid_config`; nothing is written.
- Written atomically (temp file + rename).

`--json` success: `{app, config_path, delivery: {default}, pipeline_default,
tracker, tracker_source, gates, readiness, changed: ["delivery.default",
"gates.test_command", "tracker", …], comments_preserved}`.

## `app show <app>` / `app list`

`show`: one app with `gates`, `readiness`, and detection's `suggested_gates`,
`docs_only`, `ci` for its checkout (file reads only).

`list`: `{"apps": [{app, repo, path, delivery: {default}, pipeline_default,
tracker, tracker_source, ticked, gates, readiness}]}`. `show` carries
`tracker`/`tracker_source` too (`derived` when the config has no `tracker:`). No detection, so it stays fast. A config that
fails to load is a row `{app, error}`; it never hides the others.

## Detection rules

Per gate, first hit wins:

1. **Makefile targets**: `lint`; `format-check`/`fmt-check`/…;
   `typecheck`/`type-check`/`types`/`mypy`; `test`/`tests`.
2. **Toolchains at the root and one directory down.** Per gate and per family
   (python, node, go, rust, .net, jvm, ruby, php), the shallowest provider wins. Different
   families are joined with `&&`, so all must pass. Example (sacrifice's
   shape): `ruff check . && (cd frontend && npm run lint)`.
3. `scripts/ensure-deps.sh` present → every gate gets that prefix
   (template-derived repos; see `apps/template-probe/config.yaml`).

| Toolchain | Signal | Gates |
|-----------|--------|-------|
| Python | `pyproject.toml` / `setup.py` / `requirements*.txt`; `uv.lock`→`uv run [--extra dev]`, `poetry.lock`→`poetry run`, else `python -m` | ruff (or flake8/black), mypy (or pyright), pytest |
| Python (ruff only) | root `ruff.toml` without a manifest | `ruff check .`, `ruff format --check .` |
| Node/TS | `package.json`; PM from `packageManager`, then lockfile | scripts `lint`, `format:check`…, `typecheck`…, `test` (npm's placeholder test ignored); fallbacks `tsc --noEmit`, `prettier --check .` |
| Go | `go.mod` | `golangci-lint run` (if configured) or `go vet ./...`, gofmt, `go build ./...`, `go test ./...` |
| Rust | `Cargo.toml` | clippy `-D warnings`, `cargo fmt --check`, `cargo check`, `cargo test` |
| JVM (Gradle) | `build.gradle[.kts]`; `./gradlew` if present, else `gradle` | `checkstyleMain`/`ktlintCheck` (if configured), `spotlessCheck` (if configured), `classes testClasses`, `test` |
| JVM (Maven) | `pom.xml`; `./mvnw` if present, else `mvn` | `checkstyle:check`, `spotless:check` (if configured), `test-compile`, `test` |
| Ruby | `Gemfile` | `bundle exec rubocop`, `srb tc`/`steep check`, `rspec` (or `rake test`) |
| PHP | `composer.json` | `phpcs`, `php-cs-fixer --dry-run`/`pint --test`, `phpstan`/`psalm`, composer `test` script or `phpunit`/`pest` |
| .NET | `*.sln`/`*.slnx`/`*.csproj`/`*.fsproj` at the root | `dotnet format analyzers/whitespace --verify-no-changes` (csharpier if in `dotnet-tools.json`), `dotnet build`, `dotnet test`; the target is named when unambiguous |

A repo with no recognised toolchain still registers: every gate is empty and a
note says so. Registration never fails on language.

Smoke: `make smoke` or `scripts/smoke.sh` fills `smoke_command`, but
`smoke_harness_ready` stays `false`. Flipping it makes `smoke-green` a
required gate.


### Suggestions: docs-only repos and CI

For a gate detection left empty, `suggested_gates` proposes one. Suggestions
are written to the config only as `# suggested (...)` comments; a human
confirms them (`--gate`, or the dashboard's Repos form, which prefills them).

1. **CI** (`.github/workflows/*.yml`, `.gitlab-ci.yml`): each `run:` / `script:`
   line is classified by the tool or verb it runs (`prettier --check` → format,
   `tsc`/`mypy` → type check, `npm test`/`pytest`/`lychee` → test, `eslint`/
   `gitleaks`/`markdownlint` → lint). A word like `tests` counts only as the
   verb, never as an argument. Setup lines (`npm ci`, `uv sync`, …) of the same
   job are kept as a prefix, since gates run in a fresh worktree. A
   `working-directory` wraps the command in `(cd <dir> && …)`. Known actions
   (`lycheeverse/lychee-action`, `markdownlint-cli2-action`, `gitleaks-action`)
   become their CLI. Lines using `${{ }}` or `$CI_` are skipped. Known tools
   (`docker`, `lychee`, `npm`, `uv`, …) become `requires`. Several hits for one
   gate are joined with `&&`.
2. **Docs-only** (no toolchain, ≥ 3 doc files and ≥ 4× as many docs as code
   files): every remaining gate is suggested as `none`.

## Empty gates — what they mean to the chain

An undetected gate is written as `""` with a `NOT DETECTED` comment. It is
listed in `missing_gates`.

- **`test_command`** is the gate every pipeline runs. If it is empty:
  - Submit refuses a code job (`gates_not_configured`) when the checkout has no
    `tests/` (or root `test_*.py`); with one, it warns.
  - The dev sandbox's `_run_pytest` falls back to `python -m pytest` when a
    `tests/` dir exists. Otherwise it returns failed (`no tests directory`).
  - The `tests-green` merge gate falls back to the live CI state. With no CI
    state, it fails.

  It never passes on an empty command. A repo with no tests sets
  `test_command: none` instead.
- **`lint_command` / `format_check_command` / `type_check_command`** are run
  in-conversation by the solo pipeline (a red that is new vs the base commit
  blocks). The chain's merge gates do not run them; the pre-PR ruff check only
  reads them to decide whether ruff applies. `none` or empty: not run.

## Known gaps

- The detector only looks at the root and one directory down. Deeper
  workspaces (`packages/*/…`) are covered only through a root script.
- Makefile targets are used verbatim. A target that assumes a pre-built
  `.venv` or `node_modules` fails in the chain's fresh worktree. The command
  prints a note when it uses one.
- Once an app has a `config.yaml`, `factory on` enables its tick timer.
  `power.discover_units` derives units from `apps/*/config.yaml`, so
  registering an app opts it into the next `factory on`.
