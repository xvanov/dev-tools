# scripts

Repo-wide developer tooling. Nothing here ships to a machine; it is how the tools get tested.

## Test runner (`run-tests.js`)

`npm test` in `termhub` and `personal-assistant` runs `node ../scripts/run-tests.js`: every
`test/*.test.js` in its own process, a pool of (cores - 1), a pass/fail/time table, failing output
at the end, exit 1 on any failure.

```
npm test                         # everything
npm test -- --changed            # only tests that can reach what you changed (see below)
npm test -- --changed --since origin/main
npm test -- talk dispatch        # name substrings
npm test -- --jobs 4 --timeout 60 --list
```

Per-tool settings live in `<tool>/test/runner.config.js` (every `skip` and `serial` needs a reason):

| key | meaning |
|---|---|
| `skip: [{file, reason}]` | not run |
| `skip: [{file, reason, platform: 'linux'}]` | runs **only** on that `process.platform`; skipped everywhere else |
| `serial: [{file, reason}]` | run alone after the pool (for a test that cannot share the machine) |
| `env: {NAME: 'v'}` | added to every test's environment (PA points `PA_DATABASE_URL` at a closed port, so no test can touch a real database) |
| `shards: {'x.test.js': 4}` | run one slow file as 4 parallel processes; its independent top-level blocks are wrapped in `if (owns()) { ... }` from `shard.js` (round-robin; unsharded runs own every block) |
| `touches: {'x.test.js': ['src/']}` | `--changed`: directories a test walks instead of naming files |
| `narrow: {'x.test.js': ['src/y/']}` | `--changed`: a slow test that imports the whole app is selected only by its own file and these paths (CI still runs it) |

### Writing tests that can run in parallel

- Port 0, never a fixed port. Every server a test starts listens on `127.0.0.1:0`.
- Its own temp dir (`fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))`) for data, SQLite files, worktrees.
  Point the tool's data-dir env var or config at it before requiring product code.
- No real Postgres, ever. `src/db` throws if a test process (`PA_TESTING` set by the runner, or `node x.test.js`)
  connects to a database not named `pa_test_*`, and the runner points `PA_DATABASE_URL` at a blocked name. A test
  that only reaches the db incidentally uses `require('./_fakeDb').install()` first; one that needs real rows
  creates a throwaway `pa_test_*` database. Pinned by `personal-assistant/test/dbGuard.test.js`.
  The one that does is the repository contract (`personal-assistant/test/repoContract.test.js`, plan 1.3): it
  creates `pa_test_contract_<pid>_<rand>` on the server `PA_TEST_PG_URL` names (any database there, e.g.
  `postgres://pa:pa@127.0.0.1:5433/postgres`; CI's contract job sets it), migrates it and drops it. Unset, it tries
  that local default and skips when it is unreachable. The role needs `CREATEDB`, and since `vector` and `pg_trgm`
  need a superuser to create, a template holding them lets a plain role migrate. One-time setup on a stack's server
  (done on the work laptop's WSL Postgres, port 5433):
  `alter role pa createdb; create database pa_test_template owner pa;` then, in `pa_test_template`,
  `create extension vector; create extension pg_trgm; alter database pa_test_template is_template true;`.
- A test that starts a PTY (termhub) must kill it and wait for it before removing its temp dir.
  `Session.kill()` does that on Windows (`taskkill /T /F`, then waits); remove dirs with
  `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })`.
- Portability: `personal-assistant/test/_portable.js` has `ensurePosixTools()` (puts Git for Windows'
  `sh`, `cat`, `wc`... on PATH) and `pythonCommand()` (`python3` vs `python`). Assert paths with
  `path.join`/`path.posix` as the code under test does, not with literals. Where a test is truly
  POSIX-only, keep it skipped on Windows only (`platform: 'linux'` in the config), so Linux CI runs it.

### Changed-files mode (`changed-tests.js`)

`--changed` compares the working tree to `HEAD` (staged and unstaged, plus untracked files) and runs a
test file when it is itself changed or reaches a changed file through a static graph: `require`,
`import`, `import()` and `export ... from` with relative specifiers, plus any quoted file name in a
reached file (tests read lots of files with `fs`; a name match over-selects rather than miss).
Changes to `scripts/run-tests.js`, the tool's `package.json`/lockfile or `runner.config.js` select
everything. Nothing changed, nothing runs. A change to a module most of the app imports selects
most tests, so a leaf edit takes seconds and a core edit takes a normal suite run.

Software-factory has the same thing for pytest: `python scripts/changed-pytest.py [--list] [--since REF] [--all] [-- pytest args]`
When a change selects more than 40 test files (or a shared file such as `conftest.py` changed), it
runs only the 20 smallest selected files as a smoke subset and leaves the full suite to CI; `--all`
runs the whole selection.
(import graph by regex, `conftest.py` and fixture-file-name edges, no plugins).

## Pre-commit hook

`scripts/hooks/pre-commit` runs the public-repo guard (`guard: N files clean`, ios-messages), then
`scripts/pre-commit-tests.js`: changed-files mode for every tool that uses this runner plus
software-factory, in parallel. Install (or update) it into the shared `.git/hooks` with:

```
node scripts/install-hooks.js
```

CI always runs the full suites; the hook only catches the obvious early.

**Emergency skip (humans only):** `DEVTOOLS_SKIP_TESTS=1 git commit ...` skips the test half of the hook
(the guard still runs). It prints that it skipped. Agents never skip and never use `--no-verify`.
