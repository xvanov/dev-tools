# Discovery Notes: `pa version` CLI verb

**Story:** D002: Explore repo — locate CLI dispatch, HELP text, HTTP client, test patterns
**Date:** 2026-11-07
**Trace ID:** e2e-882dea09-7617-4ef2-92ef-0115f6ed380f

## 1. CLI entry point and verb dispatch

- **Entry point:** `bin/pa.js` → `require('../src/cli/index.ts').main(process.argv.slice(2))`
- **Verb dispatch:** `src/cli/index.ts`
  - `commands` is a plain object (`Json`) defined at line 244 with inline methods (`help`, `migrate`, `db`, `login`, `whoami`, `sync`, ...)
  - External verb modules are registered via `Object.assign(commands, require('./verb.ts').make(out, fail))` at lines 1797–1805
  - Dispatch at line 1825: `const handler = commands[name]` — a simple dict lookup

### To add a new verb

1. Create `src/cli/version.ts` exporting `{ make, HELP }`
2. In `src/cli/index.ts`:
   - Add `Object.assign(commands, require('./version.ts').make(out, fail));` alongside the other `Object.assign` lines
   - Add `version: './version.ts'` to `HELP_TOPICS` (for `pa help version`)
3. Add the verb's one-liner to the `HELP` constant string (under an appropriate section, e.g. "Knowing")

### Inscribed verbs (in the `commands` object directly, no module)
All verbs except the six external modules (memory, secret, passkeys, meeting, routine, task, e2e, audit) are defined inline in the `commands` literal.

## 2. HELP text convention

- **Main HELP:** `const HELP` at line 28 in `src/cli/index.ts` — a template literal covering all verbs, organized into sections (Knowing, Doing, Replying, Remembering, Secrets, Routines, Plumbing)
- **Per-verb HELP:** Each verb module exports `const HELP = '...'` — a detailed usage string
- **`pa help <topic>`:** `HELP_TOPICS` map at line 1810 resolves topic name → module path; `require(topics[name]).HELP` returns the per-verb HELP string
- **Format:** Plain text with 2-space indent for sub-lines. Verb + brief description, then flags and options indented beneath
- **Example verb module pattern:** `src/cli/e2e.ts` (lines 17–23):
  ```js
  const HELP = `${USAGE}

    pa e2e <workflow> [--dry-run] [--keep] [--json]   one workflow from the Map (plan 8.2):
          whats-on | research | deepseek-pr [--model azure/deepseek-v4-pro] | review-fix | teams-ask
    pa e2e all --dry-run                              every workflow's dry run`;
  ```
- **Required exports:** `{ make, HELP }` — `make(out, fail)` returns an object whose keys are verb names mapping to handler functions

## 3. HTTP client and dashboard configuration

### HTTP client
- **No external HTTP library.** The project uses Node.js built-in `http` module directly.
- **Pattern** (from `src/e2e/deployTest.js:74`):
  ```js
  const http = require('http');
  const req = http.get({ host: u.hostname, port: u.port, path: '/api/version', agent, timeout: timeoutMs }, (res) => {
    // res.statusCode, res.on('data'), res.on('end'), res.on('error')
  });
  req.on('timeout', () => req.destroy(new Error(...)));
  req.on('error', (e) => { ... });
  ```
- **Also used in:** `src/supervisor/deploy.ts` (for health checks during roll), `src/dashboard/server.ts` (the server side)
- **No wrapper/helper.** Each consumer writes its own `http.get` / `http.request` calls.

### Dashboard base URL/port configuration
- **Config source:** `src/config.ts`, `dispatch` block (lines 439–442):
  ```js
  dispatch: {
    port: envInt('PA_DISPATCH_PORT', 7300),
    host: env('PA_DISPATCH_HOST', '127.0.0.1'),
  }
  ```
- **Access pattern:** `const { config } = require('../config.ts');` then `config.dispatch.port` / `config.dispatch.host`
- **Dashboard base URL:** `http://127.0.0.1:7300/` by default
- **Environment variables:** `PA_DISPATCH_PORT`, `PA_DISPATCH_HOST`

### GET /api/version endpoint
- **Exists?** YES — `src/dashboard/server.ts:289`:
  ```js
  { method: 'GET', path: '/api/version', handle: ({ res, send }) => send(res, 200, { commit: servedCommit() }) },
  ```
- **Response shape:** `{ "commit": "<40-char SHA or 'started-<timestamp>'>" }`
- **`servedCommit()`** (line 614): reads `git rev-parse HEAD` at startup from `__dirname` (the `src/dashboard/` dir, which is in the PA checkout), caches the result. Falls back to `'started-' + Date.now()` if git fails.
- **Also on `/healthz`** (line 286): returns `{ ready, draining, commit, pid }`
- **Public route:** `/api/version` is in the `PUBLIC` set in `src/dashboard/auth.ts:46` — no auth required
- **Navigation:** `src/dashboard/nav.js:236` builds a version URL from `versionUrl()` for the dashboard status page

## 4. Test framework and patterns

### Framework
- **Primary:** Node.js built-in `node:test` (`require('node:test')`) — used sparsely (e.g., `test/cliHelp.test.js`)
- **Majority:** `require('assert')` with top-level blocks — most tests are plain `.test.js` files where the test body runs at import time and uses `assert` for assertions
- **Test runner:** `../scripts/run-tests.js` (shared across all tools in the monorepo)
  - Globs `test/*.test.js`, runs each as a child process in parallel (`os.cpus().length - 1` workers)
  - Config: `test/runner.config.js` with `skip`, `serial`, `env`, `touches`, `narrow`, `shards`

### File conventions
- **Location:** `test/` directory alongside `src/`
- **Naming:** `*.test.js` — e.g., `test/llm.test.js`, `test/cliHelp.test.js`
- **Config:** `test/runner.config.js` (per-tool)

### Assertion patterns
```js
const assert = require('assert');
assert.ok(condition, 'message');
assert.strictEqual(actual, expected, 'message');
assert.deepStrictEqual(actual, expected, 'message');
assert.ok(errs.length, 'should have errors');
```

### Mocking/stubbing patterns
1. **`_fakeDb.js`** (`test/_fakeDb.js`): Replaces `src/db` in `require.cache` before any module that imports it loads. Returns a no-op fake with empty queries.
   ```js
   const fake = require('./_fakeDb').install();
   // Now any module that requires('../src/db') gets the fake
   ```
2. **Direct `require.cache` injection** (e.g., `test/budget.test.js:12-26`):
   ```js
   const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'db'));
   require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { /* fake impl */ } };
   ```
3. **Function parameter injection** (e.g., `test/jira.test.js:143-147`):
   ```js
   const fakeFetch = async (url, init) => { /* ... */ };
   const got = await searchRest(site, query, { fetchImpl: fakeFetch });
   ```
4. **Environment variable isolation:** `test/runner.config.js` sets `PA_TESTING=1` and a fake `PA_DATABASE_URL` that points to a closed port, so no test accidentally hits real Postgres.

### Test conventions summary
- Plain `.js` files, not `.ts` (CommonJS `require`)
- Self-contained: no test framework beyond `assert` and `node:test`
- Each test file runs as its own child process
- No mocking library; fake objects and `require.cache` injection instead
- Most tests run at import time (not wrapped in `test()` calls)

## 5. Open questions resolved

1. **Where is the pa CLI entry point, verb dispatch, and HELP text?**
   - Entry: `bin/pa.js` → `src/cli/index.ts`
   - Dispatch: `commands` object + `Object.assign(commands, require('./verb.ts').make(out, fail))`
   - HELP: `const HELP` template literal in `src/cli/index.ts` + per-verb `HELP` export

2. **Does `GET /api/version` already exist on the dashboard? What is its response shape and config?**
   - YES: `src/dashboard/server.ts:289`
   - Shape: `{ "commit": "<40-char SHA>" }`
   - Config: `config.dispatch.port` (7300) / `config.dispatch.host` (127.0.0.1)

3. **Which directory counts as 'the checkout' for the git fallback?**
   - `__dirname` of `src/dashboard/server.ts` (the PA checkout root, effectively)
   - For the CLI fallback: the working directory from which `pa version` is run, OR the repo root. `servedCommit()` uses `cwd: __dirname` (the `src/dashboard/` dir). The `pa version` CLI should likely use the PA checkout root — look up `process.env.PA_FACTORY_PATH` or `path.join(__dirname, '..', '..')` from the CLI module.

4. **What existing HTTP client and test framework does the CLI use?**
   - HTTP: Node.js built-in `http` module (no axios, node-fetch, etc.)
   - Tests: `assert` (primary) + `node:test` (sparingly) + `../scripts/run-tests.js` runner

## 6. Baseline test results

- **Command:** `node ../scripts/run-tests.js --timeout 60`
- **Result:** 88 passed, 34 failed, 0 skipped in 13.2s wall (15 workers)
- **Pre-existing failures:** All 34 failures are missing npm dependencies (`ws`, `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`) — not caused by this spike. These are environment setup issues in the current worktree.