'use strict';

// A local run's start and land against real git, with the store, termhub and
// the brief's memory stubbed. What earns a test here is each promise a past
// bug broke:
//
//  - `pa land` must not touch the repo's SHARED push config (it once ran
//    `git config --unset-all remote.origin.pushurl` in the worktree, which
//    wiped the user's own pushurl);
//  - a repo still carrying the OLD shared push block (older code put the dead
//    pushurl on the shared config) is cleaned once, and only that value goes;
//  - a start that fails half-way leaves no `starting` row, no worktree and no
//    branch behind;
//  - a run that may not push starts without push credentials in its
//    environment, and is refused when termhub cannot do that.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// Sharded by scripts/run-tests.js (test/runner.config.js): each top-level block below runs in one shard.
const { owns } = require('../../scripts/shard');
// git runs `!helper` credential helpers and this test runs `sh -c`: on Windows, borrow Git's sh.
if (!require('./_portable').ensurePosixTools()) throw new Error('sh is not available (install Git for Windows)');
// ~200 git processes: skip Git for Windows' launcher process on each (test/_portable.js).
require('./_portable').preferDirectGit();

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-start-')));
process.env.PA_WORKTREES_ROOT = path.join(tmp, 'worktrees');
process.env.PA_DATA_DIR = path.join(tmp, 'data');
process.env.PA_DISPATCH_VIA = 'claude';

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const store = { queries: [], nextId: 40, runs: new Map() };

// The guarded run insert (src/repo/runs.js) runs in a transaction: the
// same stub answers its queries, and the live-run re-check sees store.liveRun.
function stubTx(db) {
  db.withTx = async (fn) => fn({
    async query(sql, params) {
      if (/pg_advisory_xact_lock/.test(sql)) { (global.__txLocks = global.__txLocks || []).push(params); return { rows: [] }; }
      if (/^\s*select id from run where commitment_id/.test(sql)) return { rows: global.__liveRun ? [global.__liveRun] : [] };
      return { rows: [await db.one(sql, params)] };
    },
  });
  return db;
}

stub('db', stubTx({
  async one(sql, params) {
    store.queries.push({ sql, params });
    if (/insert into run/.test(sql)) {
      const row = { id: store.nextId++, mode: params[1], task: params[2], repo_path: params[3], status: 'starting' };
      store.runs.set(row.id, row);
      return row;
    }
    if (/select \* from run where id/.test(sql)) return store.runs.get(Number(params[0])) || null;
    if (/from project\s+where active and \(repo_path/.test(sql)) return global.__unknownRepos?.includes(params[0]) ? null : { id: 1, repo_path: params[0] };
    return null;
  },
  async rows(sql, params) { store.queries.push({ sql, params }); return []; },
  async query(sql, params) { store.queries.push({ sql, params }); return { rowCount: 1, rows: [] }; },
}));
stub('ledger', { async transition() { return { changed: true }; } });
stub('durable', { async spawn() { return null; }, async emit() { return null; } });
stub('dispatch/trust', { ensureTrusted() {} });
stub('recall', { async recall() { return null; }, async recallClaims() { return null; } });
stub('memory', { async getPage() { return null; } });

const hub = { created: [], killed: [], envApplied: true };
stub('dispatch/termhub', {
  isLocal: () => true,
  forMachine: () => { throw new Error('no remote here'); },
  async createSession(spec) {
    hub.created.push(spec);
    return { id: `s${hub.created.length}`, envApplied: Boolean(spec.env && hub.envApplied), rcSkipped: spec.noRc === true };
  },
  async killSession(id) { hub.killed.push(id); return true; },
  async briefClaude() { return true; },
  async sessionUrl(id) { return `http://hub/#session=${id}`; },
});

const dispatch = require('../src/dispatch');
// A no-push session's env: noPushEnv's, with this run's own gh dir and the dispatched-run marker.
function expectNoPush(spec, runId, msg) {
  const ne = noPushEnv({ ghConfigDir: spec.env.GH_CONFIG_DIR });
  assert.deepStrictEqual({ env: spec.env, unsetEnv: spec.unsetEnv }, { env: { PA_DISPATCHED_RUN: String(runId), ...ne.env }, unsetEnv: ne.unsetEnv }, msg);
  assert.match(path.basename(spec.env.GH_CONFIG_DIR), new RegExp(`^run-${runId}-`), 'a private dir for this run');
}

const { noPushEnv } = require('../src/dispatch/remote');
const BLOCKED = dispatch.BLOCKED_PUSH_URL;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
// A clone and its bare origin, with one commit pushed. Built with git once per
// process, then copied: five git processes per repo (each 0.1-0.7 s on
// Windows) made this file the slowest in the suite. The copy's only
// difference is origin's path, rewritten in the clone's config.
let template = null;
function makeRepo(name) {
  if (!template) {
    const origin = path.join(tmp, '_template-origin.git');
    const repo = path.join(tmp, '_template');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'init', '-q', '-b', 'main', repo);
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin'); // origin/main, as a push leaves it
    template = { origin, repo, url: git(repo, 'remote', 'get-url', 'origin').trim() };
  }
  const origin = path.join(tmp, `${name}-origin.git`);
  const repo = path.join(tmp, 'repos', name);
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  fs.cpSync(template.origin, origin, { recursive: true });
  fs.cpSync(template.repo, repo, { recursive: true });
  const cfg = path.join(repo, '.git', 'config');
  // Git writes backslashes in config values escaped (`C:\\Temp\\...`).
  const esc = (s) => s.replace(/\\/g, '\\\\');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').split(esc(template.url)).join(esc(origin)));
  return { origin, repo };
}
const sharedPushurls = (repo) => {
  try { return git(repo, 'config', '--local', '--get-all', 'remote.origin.pushurl').trim().split('\n').filter(Boolean); } catch { return []; }
};

(async () => {
  // ---- MH4: the old shared push block is cleared, and only it -----------------
  if (owns()) {
    const { repo, origin } = makeRepo('legacy');
    git(repo, 'config', '--local', 'remote.origin.pushurl', BLOCKED); // what the old code left
    // Before the fix this start threw ("leaked into the main checkout") and
    // every later local/plan run on this repo did too.
    const r = await dispatch.start({ task: 'fix the thing', mode: 'local', repoPath: repo });
    assert.deepStrictEqual(sharedPushurls(repo), [], 'the old block is gone');
    assert.strictEqual(git(repo, 'remote', 'get-url', '--push', 'origin').trim(), origin, 'the main checkout pushes again');
    assert.strictEqual(git(r.worktreePath, 'remote', 'get-url', '--push', 'origin').trim(), BLOCKED, 'the run itself is blocked');
    // Idempotent: nothing left to clear.
    const remote = require('../src/dispatch/remote');
    const run = (argv) => require('../src/dispatch/exec').runCommand(null, argv, { timeoutMs: 30_000 });
    assert.deepStrictEqual(await remote.clearLegacyBlock({ machine: { name: 'here' }, repo, blockedPushUrl: BLOCKED, run }), []);
    // Only the dead value goes: a user's own pushurl beside it, on the same
    // remote or another, is kept.
    const other = makeRepo('legacy2');
    git(other.repo, 'remote', 'add', 'upstream', other.origin);
    git(other.repo, 'config', '--local', '--add', 'remote.origin.pushurl', `${other.origin}-mine`);
    git(other.repo, 'config', '--local', '--add', 'remote.origin.pushurl', BLOCKED);
    git(other.repo, 'config', '--local', 'remote.upstream.pushurl', BLOCKED);
    assert.deepStrictEqual(await remote.clearLegacyBlock({ machine: { name: 'here' }, repo: other.repo, blockedPushUrl: BLOCKED, run }), ['origin', 'upstream']);
    assert.deepStrictEqual(sharedPushurls(other.repo), [`${other.origin}-mine`]);

    // ---- M5: the no-push session has no push credentials ------------------------
    const spec = hub.created[hub.created.length - 1];
    expectNoPush(spec, r.id);
    for (const v of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS']) assert.ok(spec.unsetEnv.includes(v), v);
    assert.strictEqual(spec.env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.strictEqual(spec.env.GIT_CONFIG_VALUE_0, '');
    // ...and that env really stops git from asking a credential helper.
    const marker = path.join(tmp, 'helper-called');
    const fwd = (p) => p.replace(/\\/g, '/'); // git runs the helper through its own sh, which wants forward slashes
    const helper = path.join(tmp, 'helper.sh');
    fs.writeFileSync(helper, `#!/bin/sh\ntouch '${fwd(marker)}'\necho username=u\necho password=p\n`, { mode: 0o755 });
    git(repo, 'config', '--local', 'credential.helper', `!${fwd(helper)}`);
    const fill = (env) => {
      try {
        execFileSync('git', ['credential', 'fill'], { cwd: repo, input: 'protocol=https\nhost=example.com\n\n', env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { /* no credential: expected without the helper */ }
    };
    fill({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
    assert.ok(fs.existsSync(marker), 'control: the helper is called without the env');
    fs.rmSync(marker);
    fill({ ...process.env, ...noPushEnv().env, GIT_TERMINAL_PROMPT: '0' }); // no prompt: the question is only what helpers answer
    assert.ok(!fs.existsSync(marker), 'credential.helper reset: the helper is not called');
    git(repo, 'config', '--local', '--unset', 'credential.helper');
    // ...and neither does Git Credential Manager / gh's helper hand out a token for github.com (the empty
    // credential.helper resets every helper configured before it, URL-scoped ones included).
    const ghCred = (() => { try { return execFileSync('git', ['credential', 'fill'], { cwd: repo, input: 'protocol=https\nhost=github.com\n\n', env: { ...process.env, ...noPushEnv().env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch { return ''; } })();
    assert.ok(!/^password=/m.test(ghCred), 'git credential fill for github.com returns no password in a no-push session');
  }

  // A run that may push keeps termhub's environment.
  if (owns()) {
    const { repo } = makeRepo('pushy');
    await dispatch.start({ task: 'push it', mode: 'branch', repoPath: repo });
    const spec = hub.created[hub.created.length - 1];
    assert.deepStrictEqual(spec.env, { PA_DISPATCHED_RUN: String(store.nextId - 1) }, 'only the dispatched-run marker');
    assert.ok(!spec.unsetEnv);
  }

  // ---- M5 + MH4: a termhub that cannot strip the env refuses, and rolls back ---
  if (owns()) {
    const { repo } = makeRepo('oldhub');
    hub.envApplied = false;
    store.queries.length = 0;
    hub.killed.length = 0;
    await assert.rejects(dispatch.start({ task: 'no creds please', mode: 'local', repoPath: repo }), /without push credentials/);
    hub.envApplied = true;
    const id = store.nextId - 1;
    const wt = path.join(tmp, 'worktrees', `run-${id}`);
    assert.ok(!fs.existsSync(wt), 'worktree removed');
    assert.strictEqual(git(repo, 'branch', '--list', `pa/${id}-*`).trim(), '', 'branch removed');
    assert.ok(hub.killed.length >= 1, 'the session it opened was killed');
    const failed = store.queries.find((q) => /status = 'failed'/.test(q.sql));
    assert.ok(failed, 'the run row is marked failed');
    assert.match(failed.params[1], /^start failed: .*without push credentials/);
    assert.ok(!store.queries.some((q) => /status = 'running'/.test(q.sql)), 'never marked running');
  }

  // ...and so does a failure in the push block itself (any error after the row).
  if (owns()) {
    const { repo } = makeRepo('badblock');
    const remote = require('../src/dispatch/remote');
    const real = remote.blockPush;
    remote.blockPush = async () => { throw new Error('the push block did not take'); };
    store.queries.length = 0;
    await assert.rejects(dispatch.start({ task: 'x', mode: 'local', repoPath: repo }), /did not take/);
    remote.blockPush = real;
    const id = store.nextId - 1;
    assert.ok(!fs.existsSync(path.join(tmp, 'worktrees', `run-${id}`)));
    assert.ok(store.queries.some((q) => /status = 'failed'/.test(q.sql) && q.params[0] === id));
  }

  // ---- MH3: land never touches the shared pushurl --------------------------------
  if (owns()) {
    const { repo, origin } = makeRepo('land');
    git(repo, 'config', '--local', 'remote.origin.pushurl', origin); // the user's own, shared
    const r = await dispatch.start({ task: 'land me', mode: 'branch', repoPath: repo });
    fs.rmSync(path.join(r.worktreePath, 'BRIEF.md'));
    git(r.worktreePath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'work');
    const row = store.runs.get(r.id);
    Object.assign(row, { worktree_path: r.worktreePath, branch: r.branch, route: 'claude', machine: os.hostname() });
    const landed = await dispatch.land(r.id);
    assert.strictEqual(landed.pushed, true);
    assert.deepStrictEqual(sharedPushurls(repo), [origin], 'the user\'s pushurl survives a land');
    assert.ok(git(origin, 'branch', '--list', r.branch).includes(r.branch.split('/').pop()), 'the branch reached origin');
  }

  // ---- MUST-FIX 2: `gh` is logged out in a no-push session ---------------------------
  if (owns()) {
    let ghOk = true;
    try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); } catch { ghOk = false; }
    const fakeCfg = path.join(tmp, 'gh-logged-in');
    fs.mkdirSync(fakeCfg, { recursive: true });
    fs.writeFileSync(path.join(fakeCfg, 'hosts.yml'), 'github.com:\n    oauth_token: gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE12\n    user: someone\n    git_protocol: https\n');
    // What a termhub session gets: its own env, the removals, then the sets (termhub lib/sessionEnv.js).
    const sessionEnv = (base) => {
      const { env, unsetEnv } = noPushEnv();
      const out = { ...base };
      for (const k of [...unsetEnv, ...Object.keys(env)]) delete out[k];
      return { ...out, ...env };
    };
    const base = { ...process.env, GH_CONFIG_DIR: fakeCfg, GH_TOKEN: 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE', GH_HOST: 'github.com' };
    const token = (env) => { try { return execFileSync('gh', ['auth', 'token'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };
    if (ghOk) {
      assert.ok(token(base), 'control: gh is logged in with the operator\'s env');
      // assert.ok, not strictEqual: a failure message must never print a real token.
      // gh falls back to the OS credential store (Windows Credential Manager, keychain) when its config dir
      // is empty, and `gh auth token --hostname H` prints what it finds: the operator's real login. The
      // session's GH_TOKEN is therefore a worthless sentinel, which wins over the store for every host.
      const NOPUSH = sessionEnv(base);
      const SENTINEL = NOPUSH.GH_TOKEN;
      assert.strictEqual(SENTINEL, 'pa-no-push-sentinel');
      for (const args of [['auth', 'token'], ['auth', 'token', '--hostname', 'github.com'], ['auth', 'token', '--hostname', 'ghe.example.com']]) {
        const got = (() => { try { return execFileSync('gh', args, { env: NOPUSH, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } })();
        assert.ok(got === null || got === SENTINEL, `gh ${args.join(' ')} prints no real token in a no-push session`);
      }
      const api = (() => { try { execFileSync('gh', ['api', 'user'], { env: NOPUSH, stdio: 'ignore', timeout: 30000 }); return 0; } catch (e) { return e.status || 1; } })();
      assert.notStrictEqual(api, 0, 'gh api fails inside a no-push session');
      const status = (() => { try { execFileSync('gh', ['auth', 'status'], { env: sessionEnv(base), stdio: 'ignore' }); return 0; } catch (e) { return e.status; } })();
      assert.notStrictEqual(status, 0, 'gh auth status fails inside a no-push session');
    } else {
      console.log('dispatchStart: gh not installed — skipped the live gh check');
    }
    const ne = noPushEnv();
    assert.deepStrictEqual(fs.readdirSync(ne.env.GH_CONFIG_DIR), [], 'an empty config dir');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(ne.env.GH_CONFIG_DIR).mode & 0o777, 0o700, 'private'); // no POSIX mode bits on Windows
    for (const v of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) assert.ok(ne.unsetEnv.includes(v), v);
    // The command re-applies the env after the shell's rc files (an rc that exports GH_TOKEN).
    const rc = path.join(tmp, 'evil-rc');
    fs.writeFileSync(rc, 'export GH_TOKEN=ghp_FROMRCFROMRCFROMRCFROMRCFROMRCFROMRC12\n');
    const cmd = require('../src/dispatch/remote').noPushCommand('sh -c \'echo "token=${GH_TOKEN:-none} cfg=$GH_CONFIG_DIR"\'', ne);
    const outp = execFileSync('sh', ['-c', `. '${rc}'; ${cmd}`], { encoding: 'utf8' }).trim();
    assert.strictEqual(outp, `token=pa-no-push-sentinel cfg=${ne.env.GH_CONFIG_DIR}`, "the rc GH_TOKEN is overridden");
    // A local no-push start asks termhub to skip rc files and wraps the command.
    hub.created.length = 0;
    const { repo } = makeRepo('norc');
    await dispatch.start({ task: 'no rc', mode: 'local', repoPath: repo });
    assert.strictEqual(hub.created[0].noRc, true);
    // POSIX re-applies the env after the rc files; Windows has no rc to outrun and relies on noRc alone.
    if (process.platform === 'win32') assert.match(hub.created[0].command, /^claude/);
    else assert.match(hub.created[0].command, /^env -u GH_TOKEN .* GH_CONFIG_DIR='[^']+' .*claude/);
  }

  // ---- --repo must be a known project -------------------------------------------------
  if (owns()) {
    const { repo } = makeRepo('unknown');
    global.__unknownRepos = [repo];
    await assert.rejects(dispatch.start({ task: 'x', mode: 'branch', repoPath: repo }), /not a known project's repo/);
    global.__unknownRepos = [];
    // Remembered facts: the task's own person/project and topics only.
    const facts = [
      { subjectKind: 'person', subjectId: 4, text: 'requester fact' }, { subjectKind: 'person', subjectId: 5, text: 'someone else' },
      { subjectKind: 'project', subjectId: 9, text: 'this project' }, { subjectKind: 'project', subjectId: 8, text: 'another project' },
      { subjectKind: 'topic', subjectId: null, text: 'a topic' }, { subjectKind: 'me', subjectId: null, text: 'about the operator' }, { text: 'unknown' },
    ];
    assert.deepStrictEqual(dispatch.scopeFacts(facts, { personId: 4, projectId: 9 }).map((f) => f.text), ['requester fact', 'this project', 'a topic']);
    assert.deepStrictEqual(dispatch.scopeFacts(facts, {}).map((f) => f.text), ['a topic']);
  }

  // ---- MUST-FIX 3: a run starts from origin's default branch, fetched now -----------------
  if (owns()) {
    const { repo, origin } = makeRepo('stale');
    const other = path.join(tmp, 'stale-other');
    git(tmp, 'clone', '-q', origin, other);
    git(other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'landed elsewhere');
    git(other, 'push', '-q', 'origin', 'main');
    const upstream = git(origin, 'rev-parse', 'main').trim();
    assert.notStrictEqual(git(repo, 'rev-parse', 'main').trim(), upstream, 'the local main is behind');
    const r = await dispatch.start({ task: 'on top of origin', mode: 'branch', repoPath: repo });
    assert.strictEqual(git(r.worktreePath, 'rev-parse', 'HEAD').trim(), upstream, 'based on the fetched origin/main');
    // A fetch that fails: the origin ref already here, never the local branch; none → refused.
    const { worktreeBase } = require('../src/dispatch');
    const cut = makeRepo('cut');
    git(cut.repo, 'fetch', '-q', 'origin');
    const known = git(cut.repo, 'rev-parse', 'origin/main').trim();
    git(cut.repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'local only');
    git(cut.repo, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
    assert.strictEqual(await worktreeBase(cut.repo), 'origin/main');
    assert.strictEqual(git(cut.repo, 'rev-parse', 'origin/main').trim(), known);
    git(cut.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    await assert.rejects(worktreeBase(cut.repo), /could not fetch origin\/main.*no copy of it here/);
    // No origin/HEAD and a stale local `master`: the remote's `main` wins.
    const odd = path.join(tmp, 'odd');
    git(tmp, 'init', '-q', '-b', 'master', odd);
    git(odd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    git(odd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.strictEqual(await require('../src/dispatch').defaultBranch(odd), 'main');
  }

  // ---- end states: a session whose delivery maps to `local` starts without credentials ----
  if (owns()) {
    const { repo } = makeRepo('deliveries');
    for (const delivery of ['none', 'push_to_main']) {
      hub.created.length = 0;
      if (delivery === 'push_to_main') {
        await assert.rejects(dispatch.start({ task: 'unconfirmed', delivery, repoPath: repo }), (e) => e.code === 'needs_confirmation', 'never without the operator\'s yes');
      }
      const r = await dispatch.start({ task: `deliver ${delivery}`, delivery, repoPath: repo, confirmedUnattended: true });
      assert.deepStrictEqual([r.mode, r.delivery], ['local', delivery]);
      const spec = hub.created[0];
      expectNoPush(spec, r.id, `${delivery}: no push credentials in the session`);
      assert.ok(fs.existsSync(spec.env.GH_CONFIG_DIR));
      await dispatch.markDone(r.id, 'session ended');
      assert.ok(!fs.existsSync(spec.env.GH_CONFIG_DIR), 'removed when the run ends');
      assert.strictEqual(git(r.worktreePath, 'remote', 'get-url', '--push', 'origin').trim(), BLOCKED, `${delivery}: push blocked in the worktree`);
    }
    hub.created.length = 0;
    const pr = await dispatch.start({ task: 'deliver pr', delivery: 'pr', repoPath: repo });
    assert.strictEqual(pr.mode, 'mr');
    assert.deepStrictEqual(hub.created[0].env, { PA_DISPATCHED_RUN: String(pr.id) }, 'a mode that may push keeps termhub\'s environment, plus the marker');
  }

  // ---- delivery after the session: the block is lifted from the worktree only ----------
  if (owns()) {
    const { repo, origin } = makeRepo('lift');
    // (A shared pushurl of the user's own makes a no-push start refuse: git
    // would push to it as well as to the block — remote.blockPush's read-back.)
    const r = await dispatch.start({ task: 'ship it', delivery: 'push_to_main', repoPath: repo, confirmedUnattended: true });
    fs.rmSync(path.join(r.worktreePath, 'BRIEF.md'));
    git(r.worktreePath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'work');
    const row = store.runs.get(r.id);
    Object.assign(row, { worktree_path: r.worktreePath, branch: r.branch, route: 'claude', machine: os.hostname(), delivery: 'push_to_main' });
    // Step one: the branch, never main.
    const mainBefore = git(origin, 'rev-parse', 'main').trim();
    const pushed = await dispatch.pushBranch(r.id);
    assert.deepStrictEqual(sharedPushurls(repo), [], 'the lift wrote nothing to the shared config');
    assert.strictEqual(git(r.worktreePath, 'remote', 'get-url', '--push', 'origin').trim(), origin, 'the worktree\'s block is lifted');
    assert.strictEqual(git(origin, 'rev-parse', r.branch).trim(), pushed.sha, 'the branch reached origin');
    assert.strictEqual(git(origin, 'rev-parse', 'main').trim(), mainBefore, 'main untouched before CI');
    // Step two, after CI: main fast-forwarded to exactly the checked commit.
    git(r.worktreePath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'after CI ran');
    await dispatch.pushToMain(r.id, { sha: pushed.sha });
    assert.strictEqual(git(origin, 'rev-parse', 'main').trim(), pushed.sha, 'the checked commit, not a later one');
    // A main that moved on refuses: no force.
    const other = path.join(tmp, 'other-clone');
    git(tmp, 'clone', '-q', origin, other);
    git(other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'someone else');
    git(other, 'push', '-q', 'origin', 'main');
    const later = git(r.worktreePath, 'rev-parse', 'HEAD').trim();
    await assert.rejects(dispatch.pushToMain(r.id, { sha: later }), /rejected|non-fast-forward|fetch first/);
    await assert.rejects(dispatch.pushToMain(r.id, {}), /needs the commit CI passed/);
    row.delivery = 'pr';
    await assert.rejects(dispatch.pushBranch(r.id), /not push_to_main/, 'only the recorded delivery authorises it');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('dispatchStart ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
