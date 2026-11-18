'use strict';

// Profile eval (src/eval/buildEval.ts, src/cli/evalBuild.ts; BUILD-ENRICHMENT.md F): the pure half, then
// real git repos and a throwaway SQLite store with a STUBBED claude and test runner (no model call here):
// plan selection and the base-commit fallbacks, the dry-run default, the worktree's life and cleanup, the
// push guards the agent runs under, scoring, the budget stop, and the report.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-build-eval-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_build_eval.sqlite');
process.env.PA_SQLITE_KEY = 'build-eval-test-key';
process.env.PA_WORKTREES_ROOT = path.join(dir, 'wt');
process.env.PA_DATA_DIR = dir;
process.env.PA_TOASTS = '0';
process.env.PA_NTFY = 'off';
process.env.PA_CHAT_NUDGE = '0';
delete process.env.PA_BUILD_EVAL_BUDGET_USD;

const E = require('../src/eval/buildEval.ts');
const CLI = require('../src/cli/evalBuild.ts');
const { available } = require('../src/db/sqlite.ts');

// ---- pure ------------------------------------------------------------------------------

{
  assert.deepStrictEqual(E.parseProfiles('chore, Feature,sonnet:high,chore').map((s) => [s.label, s.name, s.model, s.effort]), [['chore', 'chore', null, null], ['feature', 'feature', null, null], ['sonnet:high', null, 'sonnet', 'high']]);
  assert.throws(() => E.parseProfiles('gpt:high'), /model:effort pair/);
  assert.throws(() => E.parseProfiles('sonnet:extreme'), /effort must be/);
  assert.throws(() => E.parseProfiles(' , '), /at least one profile/);

  const done = { state: 'done', result: 'https://github.com/o/r/pull/5', task: 't', repo: '/r' };
  assert.strictEqual(E.ineligible(done), null);
  assert.match(E.ineligible({ ...done, state: 'failed' }), /ended failed/);
  assert.match(E.ineligible({ ...done, result: ' ' }), /no result/);
  assert.match(E.ineligible({ ...done, repo: null }), /no repo/);
  assert.deepStrictEqual([E.kindOf(done), E.kindOf({ result: '/x/reports/run-3/report.md' }), E.kindOf({ result: 'https://gitlab.com/g/p/-/merge_requests/9' })], ['pr', 'report', 'pr']);

  assert.deepStrictEqual(E.median([3, 1, 2]), 2);
  assert.strictEqual(E.median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(E.median([null, undefined]), null);

  // The test command: the setting (path or folder name), the built-in, npm test where package.json is, else none.
  const has = (...files) => (p) => files.includes(p.replace(/\\/g, '/'));
  assert.strictEqual(E.testCommandFor('C:\\repos\\dev-tools', null, has()), 'npm test -- --changed');
  assert.strictEqual(E.testCommandFor('/x/app', null, has('/x/app/package.json')), 'npm test');
  assert.strictEqual(E.testCommandFor('/x/lib', null, has()), null);
  assert.strictEqual(E.testCommandFor('/x/app', { tests: { app: 'pnpm t' } }, has('/x/app/package.json')), 'pnpm t');
  assert.strictEqual(E.testCommandFor('/x/app', { tests: { '/x/app/': null } }, has('/x/app/package.json')), null, 'null turns tests off');
  assert.strictEqual(E.testCommandFor('/r/dev-tools', { tests: { 'dev-tools': 'make test' } }, has()), 'make test', 'the setting beats the built-in');

  const j = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'did it', total_cost_usd: 0.31, num_turns: 7, usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 } });
  assert.deepStrictEqual(E.parseClaude(j), { isError: false, subtype: 'success', result: 'did it', costUsd: 0.31, tokensIn: 60, tokensOut: 5, turns: 7 });
  assert.strictEqual(E.parseClaude('not json'), null);
  assert.strictEqual(E.parseClaude('[]'), null);

  assert.deepStrictEqual(E.parseNumstat('3\t1\ta.js\n-\t-\tlogo.png\n10\t0\tb/c.js\n'), { files: 3, added: 13, removed: 1 });
  assert.deepStrictEqual(E.parseNumstat(''), { files: 0, added: 0, removed: 0 });

  // Scoring: a code task passes with a diff and passing tests; a report on being delivered; unscored without a test command.
  const t = (o) => ({ kind: 'pr', status: 'ok', tests: 'pass', files_changed: 2, ...o });
  assert.deepStrictEqual([t({}), t({ tests: 'fail' }), t({ files_changed: 0 }), t({ tests: 'n/a' }), t({ status: 'timeout' }), t({ status: 'capped' }), t({ kind: 'report', result: 'text', tests: 'n/a', files_changed: 0 }), t({ kind: 'report', result: '', tests: 'n/a' })].map(E.passedOf), [1, 0, 0, null, 0, 1, 1, 0]);

  // The prompt: task, the profile's text with {{pa}} neutralised, the replay rules.
  const prompt = E.trialPrompt({ task: 'fix the bug', repoPath: '/r', baseSha: 'abcdef1234567890', profilePrompt: 'Use {{pa}} run done for {{task}}' });
  assert.match(prompt, /fix the bug/);
  assert.match(prompt, /abcdef1234/);
  assert.match(prompt, /\(no pa command in a replay\) run done for fix the bug/);
  assert.match(prompt, /Never run `git push`/);

  // claude's argv: the model id, effort and MCP file from the profile's own flags, the spend cap, the settings file.
  const args = E.claudeArgs({ model: 'fable', permissionMode: null }, { flags: ' --effort high --mcp-config "C:\\a b\\m.json"', settingsFile: 'S.json', maxBudgetUsd: 1.234 });
  assert.deepStrictEqual(args.slice(0, 6), ['-p', '--output-format', 'json', '--model', 'claude-fable-5-2', '--permission-mode']);
  assert.strictEqual(args[6], 'bypassPermissions');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.strictEqual(args[args.indexOf('--max-budget-usd') + 1], '1.23');
  assert.strictEqual(args[args.indexOf('--effort') + 1], 'high');
  assert.strictEqual(args[args.indexOf('--mcp-config') + 1], 'C:\\a b\\m.json', 'a quoted path stays one argument, unquoted');
  assert.strictEqual(E.claudeArgs({ model: 'sonnet', permissionMode: 'dontAsk' }, { flags: '', settingsFile: 'S', maxBudgetUsd: 0 }).includes('dontAsk'), true);

  // Every replay denies push and PR commands for both shells, on top of the profile's own rules.
  const st = E.settingsFor({ allow: ['Read'], deny: ['Bash(rm *)'] });
  assert.deepStrictEqual(st.permissions.allow, ['Read']);
  for (const rule of ['Bash(rm *)', 'Bash(git push)', 'Bash(git push *)', 'PowerShell(git push *)', 'Bash(gh pr)', 'PowerShell(gh pr *)']) assert.ok(st.permissions.deny.includes(rule), rule);
  // node_modules in a replay is a junction to the real checkout: installs are denied in both shells.
  for (const rule of ['Bash(npm install)', 'Bash(npm install *)', 'PowerShell(npm ci *)', 'Bash(npm i *)', 'PowerShell(pnpm add *)', 'Bash(yarn)', 'PowerShell(yarn install)', 'Bash(bun add *)', 'Edit(**/node_modules/**)', 'Write(**/node_modules/**)']) assert.ok(st.permissions.deny.includes(rule), rule);
  assert.ok(!st.permissions.deny.includes('Bash(npm test)') && !st.permissions.deny.includes('Bash(npm run *)'), 'running tests is not denied');
  assert.match(prompt, /Do not install or change dependencies/);

  // Test outcome against the base's.
  assert.deepStrictEqual([['pass', 'pass'], ['pass', 'fail'], ['pass', null], ['fail', 'pass'], ['fail', 'fail'], ['fail', null], ['timeout', 'fail'], ['timeout', 'pass']].map(([n, b]) => E.testVerdict(n, b)), ['pass', 'fixed', 'pass', 'regression', 'still-failing', 'fail', 'timeout', 'regression']);
  assert.deepStrictEqual(['fixed', 'regression', 'still-failing'].map((tests) => E.passedOf({ kind: 'pr', status: 'ok', tests, files_changed: 1 })), [1, 0, null]);

  // The table.
  const rows = [
    { profile: 'a', status: 'ok', passed: 1, cost_usd: 1, wall_s: 60, lines_added: 4, lines_removed: 1 },
    { profile: 'a', status: 'ok', passed: 0, cost_usd: 3, wall_s: 100, lines_added: 10, lines_removed: 0 },
    { profile: 'a', status: 'timeout', passed: 0, cost_usd: 2, wall_s: 300, lines_added: null, lines_removed: null },
    { profile: 'a', status: 'ok', passed: null, cost_usd: 2, wall_s: 80, lines_added: 1, lines_removed: 0 },
    { profile: 'b', status: 'failed', passed: 0, cost_usd: null, wall_s: null },
    { profile: 'c', status: 'skipped', passed: null },
  ];
  const sum = E.summarize(rows);
  assert.deepStrictEqual(sum.map((p) => p.profile), ['a', 'b'], 'skipped trials are left out');
  const a = sum[0];
  assert.deepStrictEqual([a.n, a.scored, a.passed, a.pass_rate, a.median_cost_usd, a.median_wall_s, a.timeouts, a.failed], [4, 3, 1, 1 / 3, 2, 90, 1, 0]);
  assert.strictEqual(sum[1].pass_rate, 0);
  assert.strictEqual(E.formatTable(sum)[1].includes('1/3 33%'), true);
  assert.match(E.formatTable([])[0], /no eval trials yet/);

  // The CLI's flags.
  assert.match(CLI.parse({}).error, /usage: pa eval build/);
  assert.match(CLI.parse({ profiles: 'a', runs: 'x' }).error, /--runs needs run ids/);
  assert.match(CLI.parse({ profiles: 'a', since: 'soon' }).error, /not a date/);
  assert.match(CLI.parse({ profiles: 'a', 'budget-usd': '0' }).error, /positive/);
  const ok = CLI.parse({ profiles: 'a,b', runs: '3,4', 'budget-usd': '2.5', yes: true, 'link-deps': false });
  assert.deepStrictEqual([ok.runs, ok.budgetUsd, ok.yes, ok.dryRun, ok.noLink, ok.last], [[3, 4], 2.5, true, false, true, null]);
}

// ---- the store, real repos, a stubbed claude ----------------------------------------------

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, msg) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg);

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP build eval lifecycle: no SQLite driver');
  }
  const repo = require('../src/repo');
  const P = require('../src/build/profiles.ts');
  const B = require('../src/build/index.ts');
  const T = require('../src/build/track.ts');
  const termhub = require('../src/dispatch/termhub.ts');
  const wtRoot = process.env.PA_WORKTREES_ROOT;
  try {
    await require('../src/db/migrate.ts').migrate();

    // A repo with history, a bare "origin" to push to, and a branch cut from the second commit.
    const main = path.join(dir, 'proj');
    fs.mkdirSync(main);
    git(main, 'init', '-q');
    fs.writeFileSync(path.join(main, 'package.json'), '{"name":"proj"}');
    git(main, 'add', '-A');
    commit(main, 'one');
    const base = git(main, 'rev-parse', 'HEAD');
    const mainBranch = git(main, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(main, 'checkout', '-q', '-b', 'jarvis/9-cut-from-one');
    commit(main, 'branch work');
    git(main, 'checkout', '-q', mainBranch);
    commit(main, 'two');

    // ---- Build records the base commit, and summary.json keeps it ------------------------
    termhub.createSession = async () => ({ id: 's1' });
    termhub.killSession = async () => true;
    termhub.sessionUrl = async (id) => `http://hub/#session=${id}`;
    termhub.answerTrust = async () => true;
    require('../src/dispatch/trust.ts').ensureTrusted = () => {};
    const started = await B.start({ task: 'record the base', repoPath: main, model: 'sonnet' });
    const row = await repo.buildRuns.byId(started.id);
    assert.strictEqual(row.base_sha, git(row.worktree_path, 'rev-parse', 'HEAD'), 'the run row has the commit its worktree started from');
    await repo.buildRuns.update(row.id, { state: 'done', result: 'https://github.com/o/r/pull/1', ended_at: new Date().toISOString() });
    const kept = await T.archive(await repo.buildRuns.byId(row.id), null);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(kept, 'summary.json'), 'utf8')).base_sha, row.base_sha, 'summary.json carries base_sha');
    await B.removeWorktree(await repo.buildRuns.byId(row.id));
    assert.strictEqual(row.base_sha, git(main, 'rev-parse', mainBranch), 'it started from the default branch tip');

    // An origin to push to (added after the start: Build fetches an origin it has).
    const bare = path.join(dir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(main, 'remote', 'add', 'origin', bare);
    const mainPush = git(main, 'remote', 'get-url', '--push', 'origin');

    // ---- the summaries the eval chooses from ----------------------------------------------
    const S = (run, o = {}) => ({ run, card: null, task: `task ${run}`, model: 'sonnet', profile: 'chore', repo: main, branch: null, base_sha: base, state: 'done', result: `https://github.com/o/r/pull/${run}`, started_at: '2026-11-10T10:00:00Z', ended_at: '2026-11-10T11:00:00Z', cost_usd: 3, ...o });
    const all = [
      S(1),
      S(2, { result: '/data/build-reports/run-2/report.md' }),
      S(3, { state: 'failed', result: null }),
      S(4, { base_sha: null, branch: 'jarvis/9-cut-from-one' }),
      S(5, { base_sha: null, branch: 'jarvis/gone' }),
      S(6, { repo: null }),
      S(7, { repo: path.join(dir, 'nowhere') }),
      S(8, { base_sha: '0'.repeat(40) }),
      S(10, { base_sha: null, branch: mainBranch }),
    ];
    const claudeCalls = [];
    const testCalls = [];
    let cost = 0.5;
    const stub = {
      summaries: (since) => (since ? all.filter((s) => String(s.ended_at) >= since) : all),
      setting: async () => null,
      verdict: async (url) => (url.endsWith('/1') ? 'merged' : null),
      claude: async (o) => {
        claudeCalls.push({ ...o, exists: fs.existsSync(o.cwd), headBase: git(o.cwd, 'rev-parse', 'HEAD'), pushUrl: git(o.cwd, 'remote', 'get-url', '--push', 'origin'), settings: JSON.parse(fs.readFileSync(o.args[o.args.indexOf('--settings') + 1], 'utf8')) });
        if (!stub.noWrite) fs.writeFileSync(path.join(o.cwd, `change-${claudeCalls.length}.txt`), 'a\nb\nc\n');
        if (stub.timeout) return { code: null, out: '', err: '', timedOut: true };
        return { code: 0, out: JSON.stringify({ type: 'result', subtype: stub.subtype || 'success', is_error: false, result: 'summary of work', total_cost_usd: cost, num_turns: 4, usage: { input_tokens: 100, output_tokens: 20 } }), err: '', timedOut: false };
      },
      // testsFail: true fails the baseline and the replay; 'regress' fails only once the agent has written its change.
      tests: async (o) => { testCalls.push(o); const fail = stub.testsFail === 'regress' ? fs.readdirSync(o.cwd).some((f) => f.startsWith('change-')) : Boolean(stub.testsFail); return { code: fail ? 1 : 0, out: fail ? 'FAIL x' : 'ok', err: '', timedOut: false }; },
    };
    const deps = () => ({ ...E.defaults(), ...stub });

    // ---- plan selection and the base-commit fallbacks ---------------------------------------
    const planned = await E.plan({ runs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, deps());
    assert.deepStrictEqual(planned.items.map((i) => [i.run, i.kind, i.baseSource]), [[1, 'pr', 'recorded'], [2, 'report', 'recorded'], [4, 'pr', 'merge-base']]);
    assert.strictEqual(planned.items[2].base, base, 'no base_sha: the merge-base of its branch with the default branch');
    const why = Object.fromEntries(planned.skipped.map((s) => [s.run, s.reason]));
    assert.match(why[3], /ended failed/);
    assert.match(why[5], /branch jarvis\/gone is gone/);
    assert.match(why[6], /no repo/);
    assert.match(why[7], /not a checkout/);
    assert.match(why[8], /not in .* any more/);
    assert.match(why[9], /no summary\.json/);
    assert.match(why[10], /already merged/);

    // No selector: the newest N eligible; ineligible ones are not listed unless named.
    const newest = await E.plan({ last: 1 }, deps());
    assert.deepStrictEqual(newest.items.map((i) => i.run), [4], 'newest eligible first (10 and 8, 7, 6, 5 are skipped on the way)');
    assert.deepStrictEqual((await E.plan({ last: 10, since: '2026-12-01' }, deps())).items, [], 'since filters through the summaries');

    // ---- the dry run is the default and launches nothing -------------------------------------
    const dry = await E.launch({ runs: [1, 2], profiles: 'chore,quick', budgetUsd: 5 }, deps());
    assert.strictEqual(dry.dry, true);
    assert.strictEqual(claudeCalls.length, 0, 'nothing was launched');
    assert.deepStrictEqual([dry.estimate.trials, dry.estimate.typicalUsd, dry.estimate.ceilingUsd], [4, 6, 6], 'typical is the original cost ($3) bounded by each cap (2 and 1); the ceiling is the caps');
    assert.strictEqual(dry.estimate.fits, 3, 'of 2+1+2+1 dollars, three trials fit a $5 budget');
    assert.deepStrictEqual((await repo.buildEvals.list()).length, 0, 'nothing stored');
    const explicit = await E.launch({ runs: [1], profiles: 'chore', yes: true, dryRun: true }, deps());
    assert.strictEqual(explicit.dry, true, '--dry-run wins over --yes');
    assert.strictEqual(claudeCalls.length, 0);
    await assert.rejects(E.launch({ runs: [1], profiles: 'nonesuch' }, deps()), /no profile "nonesuch"/);
    const text = CLI.formatPlan(dry).join('\n');
    assert.match(text, /run #1 \[pr\]/);
    assert.match(text, /4 trial\(s\)/);

    // ---- a real launch: worktree, guards, scoring, cleanup ---------------------------------------
    process.env.GH_TOKEN = 'a-real-token';
    process.env.GITHUB_TOKEN = 'another-real-token';
    cost = 0.5;
    const r = await E.launch({ runs: [1, 2], profiles: 'chore', yes: true, budgetUsd: 20, noLink: true }, deps());
    assert.strictEqual(r.dry, false);
    assert.strictEqual(r.trials.length, 2);
    assert.ok(!r.stopped);
    const [pr, rep] = r.trials;
    // The worktree: a detached checkout at the base, gone afterwards.
    const c0 = claudeCalls[0];
    assert.strictEqual(c0.exists, true);
    assert.strictEqual(c0.headBase, base, 'the replay starts at the recorded base commit, not at HEAD');
    assert.ok(!fs.existsSync(c0.cwd), 'the worktree is removed');
    assert.ok(path.resolve(c0.cwd).startsWith(path.resolve(wtRoot)), 'worktrees live under the worktrees root');
    assert.strictEqual(git(main, 'worktree', 'list').split('\n').length, 1, `git forgot the replay worktree: ${git(main, 'worktree', 'list')}`);
    assert.ok(!git(main, 'branch', '--list').includes('eval'), 'no branch was made for it');
    assert.deepStrictEqual(fs.readdirSync(wtRoot).filter((f) => f.startsWith('eval-')), [], 'settings files are removed too');
    // The guards.
    assert.strictEqual(c0.pushUrl, E.BLOCKED_PUSH_URL, 'every remote pushes to the dead address in the replay');
    assert.strictEqual(git(main, 'remote', 'get-url', '--push', 'origin'), mainPush, 'the main checkout still pushes where it did');
    assert.ok(c0.settings.permissions.deny.includes('Bash(git push *)') && c0.settings.permissions.deny.includes('PowerShell(gh pr *)'));
    assert.notStrictEqual(c0.env.GH_TOKEN, 'a-real-token', 'no real GitHub token reaches the agent');
    assert.strictEqual(c0.env.GITHUB_TOKEN, undefined);
    assert.strictEqual(c0.env.GIT_TERMINAL_PROMPT, '0');
    assert.match(c0.prompt, /Never run `git push`/);
    assert.deepStrictEqual(c0.args.slice(0, 3), ['-p', '--output-format', 'json']);
    assert.ok(Number(c0.args[c0.args.indexOf('--max-budget-usd') + 1]) <= 2, "claude's own spend cap is at most the profile's");
    assert.ok(c0.args.includes('sonnet') && c0.args.includes('--effort') && c0.args.includes('low'), "the profile's model and effort");
    // Scoring of the code task.
    assert.deepStrictEqual([pr.status, pr.kind, pr.tests, pr.files_changed, pr.lines_added, pr.lines_removed, pr.passed], ['ok', 'pr', 'pass', 1, 3, 0, 1]);
    assert.deepStrictEqual([pr.cost_usd, pr.turns, pr.tokens_in, pr.tokens_out, pr.original_verdict, pr.base_sha], [0.5, 4, 100, 20, 'merged', base]);
    assert.strictEqual(testCalls.length, 2, 'the baseline at the base commit, then the replay');
    assert.ok(testCalls[0].cwd === testCalls[1].cwd, 'both ran in the replay tree (baseline before the agent)');
    assert.match(pr.tests_note, /base: pass/);
    assert.strictEqual(testCalls[0].command, 'npm test', 'package.json and no override: npm test');
    // The report task is scored on being delivered; the tests are not run for it.
    assert.deepStrictEqual([rep.kind, rep.tests, rep.passed, rep.files_changed >= 0], ['report', 'n/a', 1, true]);
    assert.strictEqual(testCalls.length, 2);
    // Stored, and in the JSONL with the agent's final message.
    const stored = await repo.buildEvals.list({ evalId: r.evalId });
    assert.deepStrictEqual(stored.map((x) => [Number(x.run_id), x.profile, Number(x.passed), x.tests]).sort(), [[1, 'chore', 1, 'pass'], [2, 'chore', 1, 'n/a']]);
    const lines = fs.readFileSync(r.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual([lines.length, lines[0].result, lines[0].runId], [2, 'summary of work', 1]);
    assert.strictEqual(path.dirname(r.file), path.join(dir, 'build-eval'));

    // node_modules is junctioned so tests can run, and removing the replay never follows it into the real checkout.
    fs.mkdirSync(path.join(main, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(main, 'node_modules', 'pkg', 'keep.txt'), 'real');
    fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), 'node_modules\n');
    let linked = null;
    const linkDeps = { ...deps(), claude: async (o) => { linked = fs.existsSync(path.join(o.cwd, 'node_modules', 'pkg', 'keep.txt')); return stub.claude(o); } };
    const lk = await E.launch({ runs: [1], profiles: 'chore', yes: true }, linkDeps);
    assert.strictEqual(linked, true, 'the replay sees the main checkout\'s node_modules');
    assert.strictEqual(lk.trials[0].status, 'ok');
    assert.strictEqual(fs.readFileSync(path.join(main, 'node_modules', 'pkg', 'keep.txt'), 'utf8'), 'real', 'the real node_modules survived the cleanup');
    assert.deepStrictEqual(fs.readdirSync(wtRoot).filter((f) => f.startsWith('eval-')), []);

    // A failing test run, a replay that changed nothing, a timeout, a spend-capped one.
    stub.testsFail = 'regress';
    const f1 = await E.launch({ runs: [1], profiles: 'chore', yes: true, noLink: true }, deps());
    assert.deepStrictEqual([f1.trials[0].tests, f1.trials[0].passed], ['regression', 0], 'the base passed and the replay fails');
    assert.match(f1.trials[0].tests_note, /npm test \(base: pass\): FAIL x/);
    stub.testsFail = true;
    const f1b = await E.launch({ runs: [1], profiles: 'chore', yes: true, noLink: true }, deps());
    assert.deepStrictEqual([f1b.trials[0].tests, f1b.trials[0].passed], ['still-failing', null], 'the base already failed: not blamed on the profile');
    assert.match(f1b.trials[0].tests_note, /base: fail/);
    assert.strictEqual(f1b.trials[0].files_changed, 1, "the baseline run's leftovers are not counted as the agent's diff");
    stub.testsFail = false;
    stub.noWrite = true;
    const f2 = await E.launch({ runs: [1], profiles: 'chore', yes: true, noLink: true }, deps());
    assert.deepStrictEqual([f2.trials[0].files_changed, f2.trials[0].tests, f2.trials[0].passed], [0, 'n/a', 0]);
    stub.noWrite = false;
    stub.timeout = true;
    const f3 = await E.launch({ runs: [1], profiles: 'chore', yes: true, noLink: true, wallMin: 1 }, deps());
    assert.deepStrictEqual([f3.trials[0].status, f3.trials[0].passed], ['timeout', 0]);
    assert.match(f3.trials[0].reason, /wall timeout after 1 min/);
    assert.ok(!fs.existsSync(claudeCalls[claudeCalls.length - 1].cwd), 'a timed-out replay is cleaned up too');
    stub.timeout = false;
    stub.subtype = 'error_max_budget_usd';
    const f4 = await E.launch({ runs: [1], profiles: 'chore', yes: true, noLink: true }, deps());
    assert.deepStrictEqual([f4.trials[0].status, f4.trials[0].tests], ['capped', 'pass']);
    stub.subtype = null;

    // A setup failure is a failed trial, and the throwaway tree does not stay behind.
    const brokenDeps = { ...deps(), blockPush: async () => { throw new Error('the push block did not take'); } };
    const f5 = await E.launch({ runs: [1], profiles: 'chore', yes: true, noLink: true }, brokenDeps);
    assert.deepStrictEqual([f5.trials[0].status, f5.trials[0].passed], ['failed', 0]);
    assert.match(f5.trials[0].reason, /push block did not take/);
    assert.deepStrictEqual(fs.readdirSync(wtRoot).filter((f) => f.startsWith('eval-')), []);
    assert.strictEqual(git(main, 'worktree', 'list').split('\n').length, 1);

    // ad-hoc model:effort specs resolve against the defaults and carry their own flags.
    const before = claudeCalls.length;
    const adhoc = await E.launch({ runs: [1], profiles: 'haiku:low,research', yes: true, noLink: true }, deps());
    assert.deepStrictEqual(adhoc.trials.map((t) => [t.profile, t.model, t.effort]), [['haiku:low', 'haiku', 'low'], ['research', 'sonnet', 'medium']]);
    assert.ok(claudeCalls[before].args.includes('haiku'));
    assert.ok(claudeCalls[before + 1].args.includes('dontAsk'), "the research profile's read-only mode is kept");
    assert.ok(claudeCalls[before + 1].settings.permissions.deny.includes('Bash(git push)'), 'and the push denials are added to it');

    // ---- the budget stops the eval before it would be exceeded --------------------------------
    cost = 2;
    const callsBefore = claudeCalls.length;
    const b = await E.launch({ runs: [1, 2, 4], profiles: 'chore', yes: true, noLink: true, budgetUsd: 5 }, deps());
    assert.strictEqual(b.trials.length, 2, 'two $2 trials fit a $5 budget, a third would pass it');
    assert.match(b.stopped, /budget \$5\.00: \$4\.00 spent/);
    assert.strictEqual(b.notRun, 1);
    assert.strictEqual(claudeCalls.length, callsBefore + 2);
    assert.ok(Number(claudeCalls[callsBefore].args[claudeCalls[callsBefore].args.indexOf('--max-budget-usd') + 1]) <= 2, 'the spend cap given to claude is the profile cap (2), never more than what is left');
    const tight = await E.launch({ runs: [1], profiles: 'feature', yes: true, noLink: true, budgetUsd: 1 }, deps());
    assert.strictEqual(tight.trials.length, 0, 'a trial whose projected cost passes the whole budget does not start');
    assert.ok(tight.stopped);
    const lastCall = claudeCalls.length;
    const small = await E.launch({ runs: [1], profiles: 'chore', yes: true, noLink: true, budgetUsd: 3.5 }, { ...deps(), summaries: () => [S(1, { cost_usd: 0.2 })] });
    assert.strictEqual(small.trials.length, 1);
    assert.strictEqual(claudeCalls[lastCall].args[claudeCalls[lastCall].args.indexOf('--max-budget-usd') + 1], '2', 'min(profile cap 2, budget left 3.5)');
    const lastCall2 = claudeCalls.length;
    cost = 0.1;
    await E.launch({ runs: [1], profiles: 'chore', yes: true, noLink: true, budgetUsd: 0.5 }, { ...deps(), summaries: () => [S(1, { cost_usd: 0.1 })] });
    assert.strictEqual(claudeCalls[lastCall2].args[claudeCalls[lastCall2].args.indexOf('--max-budget-usd') + 1], '0.5', 'the remaining budget caps claude when it is below the profile cap');

    // ---- the report: store, tool, board data -----------------------------------------------------
    const rep2 = await E.reportData({});
    assert.ok(rep2.trials >= 10 && rep2.evals.length >= 2);
    const chore = rep2.profiles.find((p) => p.profile === 'chore');
    assert.ok(chore.n >= 5 && chore.pass_rate > 0 && chore.pass_rate < 1, 'passes and failures are both counted');
    assert.strictEqual(rep2.profiles.find((p) => p.profile === 'research').n, 1);
    assert.deepStrictEqual((await E.reportData({ evalId: r.evalId })).profiles.map((p) => [p.profile, p.n, p.passed]), [['chore', 2, 2]]);
    assert.deepStrictEqual(Object.keys(rep2.recent[0]).sort(), ['cost_usd', 'eval', 'original_verdict', 'passed', 'profile', 'run', 'status', 'tests', 'wall_s', 'lines'].sort());
    const tools = require('../src/mcp/chatTools.ts');
    assert.ok(tools.CHAT_READ_TOOL_NAMES.includes('eval_build_report') && tools.READ_TOOLS.some((t) => t.name === 'eval_build_report'));
    assert.ok(!tools.CHAT_ACTION_TOOL_NAMES.some((n) => /eval/.test(n)), 'launching an eval is not a chat action');
    const viaTool = await tools.handle('eval_build_report', { eval: r.evalId });
    assert.deepStrictEqual(viaTool.profiles.map((p) => [p.profile, p.n]), [['chore', 2]]);
    const board = require('../src/dashboard/buildBoard.ts');
    let sent = null;
    await board.route({ method: 'GET' }, {}, new URL('http://x/api/build/eval'), { send: (res, code, body) => { sent = [code, body]; }, readJson: async () => ({}) });
    assert.strictEqual(sent[0], 200);
    assert.ok(sent[1].profiles.length >= 3);
    const client = require('../src/dashboard/build.board.client.js');
    assert.deepStrictEqual(client.evalRows([{ profile: 'chore', n: 4, passed: 3, scored: 4, pass_rate: 0.75, median_cost_usd: 1.234, median_wall_s: 125 }, { profile: 'x', n: 1, pass_rate: null, median_cost_usd: null, median_wall_s: 30 }]), [
      { profile: 'chore', n: '4', pass: '3/4 75%', cost: '$1.23', wall: '2m' },
      { profile: 'x', n: '1', pass: '-', cost: '-', wall: '30s' },
    ]);
  } finally {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    await require('../src/db').close?.()?.catch?.(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
  }
}

main().then(() => { console.log('buildEval.test.js ok'); process.exit(0); }, (err) => { console.error(err); process.exit(1); });
