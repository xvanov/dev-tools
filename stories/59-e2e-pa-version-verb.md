# Story: e2e: pa version verb

## Story
Add a new `pa version` CLI verb in the personal-assistant app that reports the commit the running worker serves. It should first try the dashboard version endpoint and, if that fails, fall back to the local checkout short git hash while clearly indicating which source was used. Also expose the new verb in the help text.

## Acceptance Criteria

- `pa version` is accepted by the CLI and prints a version/commit string to stdout.
- When the dashboard version endpoint responds successfully, the command prints the served commit from that response.
- When the dashboard does not answer or the request fails, the command falls back to `git rev-parse --short HEAD` from the checkout.
- The output indicates whether the value came from the dashboard or from the git fallback.
- The CLI help text lists the new `version` verb.
- A unit test covers the pure logic for choosing/formatting the version source and fallback behavior.
- Existing commands continue to work unchanged.

### Testable Claims (EARS)

AC1.1: WHEN `pa version` is invoked, GIVEN no precondition, THE CLI SHALL print a version/commit string to stdout.
AC2.1: WHEN the dashboard version endpoint responds with HTTP 200, GIVEN a successful response, THE system SHALL print the served commit from that response.
AC3.1: WHEN the dashboard does not answer or the request fails (e.g., timeout, HTTP error), GIVEN a failed dashboard call, THE system SHALL fall back to `git rev-parse --short HEAD`.
AC4.1: WHEN any output is printed, THE system SHALL indicate whether the value came from the dashboard or from the git fallback.
AC5.1: WHEN the CLI help text is displayed (e.g., via `pa --help`), THE help text SHALL list the `version` verb.
AC6.1: WHEN a unit test executes the pure version-source logic, GIVEN a mock dashboard response, THE test SHALL verify correct source choice and output format for both success and fallback cases.
AC7.1: WHEN existing commands are invoked after this change, GIVEN no modification to them, THE CLI SHALL behave identically to before the change.

## Tasks/Subtasks

- [x] Search repo for existing CLI entry points and subcommand routing (e.g., `cli.py`, `main.py`, `__init__.py` in `personal-assistant`).
- [x] Search for existing helpers for dashboard API calls or git shell-out.
- [x] Create pure `resolveVersion` function in `personal_assistant/version_result.py` with logic: try GET /api/version, on failure call `git rev-parse --short HEAD`, return formatted string with source label.
- [x] Create unit test `tests/test_version_result.py` covering success and fallback scenarios using mocks.
- [x] Register `version` subcommand in CLI router; wire `resolveVersion` call.
- [x] Update CLI help text to include `version` verb.
- [x] Run existing tests to confirm no regression.
- [ ] Open draft PR.

## Dev Notes

### flow.md (verbatim embed)

# Flow: e2e: pa version verb (e2e-3fd04a2d-a487-4f1f-aeea-96e9899aef43)

Written by the personal assistant from the ask and its done-criteria; the ask file holds the requester's own words.

1. Start from how `dev-tools` behaves today, as the ask (the job's ask file) describes it.
2. Make the change: Add a new `pa version` CLI verb in the personal-assistant app that reports the commit the running worker serves. It should first try the dashboard version endpoint and, if that fails, fall back to the local checkout short git hash while clearly indicating which source was used. Also expose the new verb in the help text and keep the implementation small..
3. Check: `pa version` is accepted by the CLI and prints a version/commit string to stdout.
4. Check: When the dashboard version endpoint responds successfully, the command prints the served commit from that response.
5. Check: When the dashboard does not answer or the request fails, the command falls back to `git rev-parse --short HEAD` from the checkout.
6. Check: The output indicates whether the value came from the dashboard or from the git fallback.
7. Check: The CLI help text lists the new `version` verb.
8. Check: A unit test covers the pure logic for choosing/formatting the version source and fallback behavior.
9. Check: Existing commands continue to work unchanged.
10. The existing tests still pass, and new behaviour is covered by a test.
11. Deliver `draft_pr`.

## References

- Direction D017: e2e: pa version verb
- PM result child_stories (decomposition context only): Story 0 (VersionResult + unit test) and Story 1 (verb integration) are merged into this single story per chain instructions.

## Dev Agent Record

### Agent Model Used

Claude (via OpenHands agent-sdk)

### Completion Notes

All 7 acceptance criteria are satisfied:

- **AC1 (CLI accepts `pa version`)**: The `version` command is registered in `commands` object via `Object.assign(commands, require('./version.ts').make(out, fail))` at `src/cli/index.ts:231`. The `version()` function calls `resolveVersion()` and outputs the result.
- **AC2 (Dashboard success)**: `resolveVersion()` at `src/cli/version.ts:19-36` tries `fetchDashboard()` first; on success, returns `{ value: commit, source: 'dashboard' }`.
- **AC3 (Git fallback)**: When `fetchDashboard()` throws or returns null/empty, `resolveVersion()` falls back to `gitFallback()` which calls `git rev-parse --short HEAD`.
- **AC4 (Source label)**: The output format is `${result.value} (${result.source})` at `src/cli/version.ts:80`, e.g. `abc1234 (dashboard)` or `def5678 (git)`.
- **AC5 (Help text)**: The `HELP` string includes `pa version` at `src/cli/index.ts:49` and the `HELP_TOPICS` map includes `version: './version.ts'` at `src/cli/index.ts:239`.
- **AC6 (Unit test)**: `test/test_version.test.js` has 9 tests covering success, fallback on throw/null/empty, both-fail, git-returns-null, HELP content, module exports, and CLI registration.
- **AC7 (No regression)**: `node scripts/gate-changed.js` reports 6 passed, 0 failed, 0 skipped. The CLI help test (`cliHelp.test.js`) passes. `ruff check .` passes.

### File List

- `personal-assistant/src/cli/version.ts` — new: `resolveVersion()` pure logic + `make()` CLI handler + `HELP` text
- `personal-assistant/src/cli/index.ts` — modified: added `pa version` to HELP string, registered version command, added version to HELP_TOPICS
- `personal-assistant/test/test_version.test.js` — new: 9 tests for unit logic, help text, and CLI integration
- `stories/59-e2e-pa-version-verb.md` — this file

## Senior Developer Review

(TBD by reviewer)

## Review Follow-ups

(TBD)