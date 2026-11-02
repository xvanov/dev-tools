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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-start-')));
process.env.PA_WORKTREES_ROOT = path.join(tmp, 'worktrees');
process.env.PA_DISPATCH_VIA = 'claude';

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const store = { queries: [], nextId: 40, runs: new Map() };
stub('db', {
  async one(sql, params) {
    store.queries.push({ sql, params });
    if (/insert into run/.test(sql)) {
      const row = { id: store.nextId++, mode: params[1], task: params[2], repo_path: params[3], status: 'starting' };
      store.runs.set(row.id, row);
      return row;
    }
    if (/select \* from run where id/.test(sql)) return store.runs.get(Number(params[0])) || null;
    return null;
  },
  async rows(sql, params) { store.queries.push({ sql, params }); return []; },
  async query(sql, params) { store.queries.push({ sql, params }); return { rowCount: 1, rows: [] }; },
});
stub('ledger', { async transition() { return { changed: true }; } });
stub('durable', { async spawn() { return null; }, async emit() { return null; } });
stub('dispatch/trust', { ensureTrusted() {} });
stub('recall', { async recall() { return null; } });
stub('memory', { async getPage() { return null; } });

const hub = { created: [], killed: [], envApplied: true };
stub('dispatch/termhub', {
  isLocal: () => true,
  forMachine: () => { throw new Error('no remote here'); },
  async createSession(spec) {
    hub.created.push(spec);
    return { id: `s${hub.created.length}`, envApplied: Boolean(spec.env && hub.envApplied) };
  },
  async killSession(id) { hub.killed.push(id); return true; },
  async briefClaude() { return true; },
  async sessionUrl(id) { return `http://hub/#session=${id}`; },
});

const dispatch = require('../src/dispatch');
const { noPushEnv } = require('../src/dispatch/remote');
const BLOCKED = dispatch.BLOCKED_PUSH_URL;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
function makeRepo(name) {
  const origin = path.join(tmp, `${name}-origin.git`);
  const repo = path.join(tmp, 'repos', name);
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return { origin, repo };
}
const sharedPushurls = (repo) => {
  try { return git(repo, 'config', '--local', '--get-all', 'remote.origin.pushurl').trim().split('\n').filter(Boolean); } catch { return []; }
};

(async () => {
  // ---- MH4: the old shared push block is cleared, and only it -----------------
  {
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
    assert.deepStrictEqual({ env: spec.env, unsetEnv: spec.unsetEnv }, noPushEnv());
    for (const v of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS']) assert.ok(spec.unsetEnv.includes(v), v);
    assert.strictEqual(spec.env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.strictEqual(spec.env.GIT_CONFIG_VALUE_0, '');
    // ...and that env really stops git from asking a credential helper.
    const marker = path.join(tmp, 'helper-called');
    const helper = path.join(tmp, 'helper.sh');
    fs.writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\necho username=u\necho password=p\n`, { mode: 0o755 });
    git(repo, 'config', '--local', 'credential.helper', `!${helper}`);
    const fill = (env) => {
      try {
        execFileSync('git', ['credential', 'fill'], { cwd: repo, input: 'protocol=https\nhost=example.com\n\n', env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { /* no credential: expected without the helper */ }
    };
    fill({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
    assert.ok(fs.existsSync(marker), 'control: the helper is called without the env');
    fs.rmSync(marker);
    fill({ ...process.env, ...noPushEnv().env });
    assert.ok(!fs.existsSync(marker), 'credential.helper reset: the helper is not called');
    git(repo, 'config', '--local', '--unset', 'credential.helper');
  }

  // A run that may push keeps termhub's environment.
  {
    const { repo } = makeRepo('pushy');
    await dispatch.start({ task: 'push it', mode: 'branch', repoPath: repo });
    const spec = hub.created[hub.created.length - 1];
    assert.ok(!spec.env && !spec.unsetEnv);
  }

  // ---- M5 + MH4: a termhub that cannot strip the env refuses, and rolls back ---
  {
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
  {
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
  {
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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('dispatchStart ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
