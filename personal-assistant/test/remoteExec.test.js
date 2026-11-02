'use strict';

// Commands on any machine (src/dispatch/exec.js) and remote dispatch to a
// Linux/macOS machine (src/dispatch/remote.js).
//
// What earns a test: runCommand's contract (argv verbatim, no shell; exit code,
// timeout and missing-program outcomes; strict machine names; termhub's
// guard headers; an old termhub is EXEC_UNSUPPORTED, not "the command
// failed"); the OS a machine is taken to run; POSIX paths; and — against real
// git — that a no-push run's worktree cannot push while the main checkout
// still can, which is the mode boundary the dispatcher enforces. When the
// sibling termhub checkout is installed, the same setup runs through a real
// termhub front's /api/exec.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

process.env.PA_MACHINES = 'lab=http://127.0.0.1:1|/srv/repos|linux, winbox=http://127.0.0.1:1|C:\\source';

const { parseMachines } = require('../src/config');
const { runCommand, normalise } = require('../src/dispatch/exec');
const remote = require('../src/dispatch/remote');
const { config } = require('../src/config');

const node = process.execPath;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-remote-exec-')));
const BLOCKED = 'https://pa-push-blocked.invalid/this-run-may-not-push.git';

// ---- PA_MACHINES with an OS -------------------------------------------------

{
  const m = parseMachines('lab=http://lab.example.ts.net:7000|/home/k/repos|Linux, mac=http://m:7000|/Users/k/src|darwin, w=http://w|C:\\src');
  assert.deepStrictEqual(m.lab, { name: 'lab', url: 'http://lab.example.ts.net:7000', reposRoot: '/home/k/repos', os: 'linux' });
  assert.strictEqual(m.mac.os, 'macos');
  assert.ok(!('os' in m.w), 'no OS given: none recorded (detected later)');
  assert.throws(() => parseMachines('x=http://x|/r|beos'), /not an OS/);
}

// ---- which OS, and its paths --------------------------------------------------

assert.strictEqual(remote.declaredOs({ reposRoot: '/srv/repos' }), 'linux');
assert.strictEqual(remote.declaredOs({ reposRoot: 'D:\\code' }), 'windows');
assert.strictEqual(remote.declaredOs({ reposRoot: '/x', os: 'macos' }), 'macos');
assert.strictEqual(remote.platformOs('win32'), 'windows');
assert.strictEqual(remote.platformOs('darwin'), 'macos');
assert.strictEqual(remote.platformOs('linux'), 'linux');
const lab = config.termhub.machines.lab;
assert.strictEqual(remote.remoteRepoPath(lab, 'C:\\repos\\widget-toolkit'), '/srv/repos/widget-toolkit');
assert.strictEqual(remote.remoteRepoPath(lab, '/home/me/widget-toolkit/'), '/srv/repos/widget-toolkit');
assert.strictEqual(remote.remoteWorktreePath(lab, 42), '/srv/repos/.pa-worktrees/run-42');
assert.strictEqual(remote.remoteWorktreePath(config.termhub.machines.winbox, 42), 'C:\\source\\.pa-worktrees\\run-42');
assert.strictEqual(remote.joinFor('posix', '/srv/repos/', ''), '/srv/repos/');
assert.strictEqual(remote.machineNamed('lab'), lab, 'a Linux machine is no longer refused');
assert.strictEqual(remote.shq("it's"), `'it'\\''s'`);

(async () => {
  // resolveOs: config, then what termhub reports, then the root's shape — and a
  // configuration that contradicts itself is refused, not guessed around.
  const hubSaying = (platform) => ({ api: async () => (platform ? { platform } : Promise.reject(new Error('down'))) });
  assert.strictEqual(await remote.resolveOs({ name: 'a', reposRoot: '/r' }, hubSaying('darwin')), 'macos');
  assert.strictEqual(await remote.resolveOs({ name: 'a', reposRoot: '/r' }, hubSaying(null)), 'linux');
  assert.strictEqual(await remote.resolveOs({ name: 'a', reposRoot: 'C:\\r' }, hubSaying('win32')), 'windows');
  await assert.rejects(remote.resolveOs({ name: 'a', reposRoot: '/r', os: 'linux' }, hubSaying('win32')), /reports windows/);
  await assert.rejects(remote.resolveOs({ name: 'a', reposRoot: '/home/k/repos' }, hubSaying('win32')), /not a windows path/);
  await assert.rejects(remote.resolveOs({ name: 'a', reposRoot: 'repos' }, hubSaying(null)), /cannot tell/);

  // ---- runCommand, this machine ----------------------------------------------

  const tricky = ['$HOME', '*', '; echo pwned', '`id`', 'a b', '"q"'];
  const echo = await runCommand(null, [node, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky], { cwd: tmp });
  assert.deepStrictEqual(JSON.parse(echo.stdout), tricky, 'argv reaches the program verbatim — no shell');
  assert.strictEqual(echo.code, 0);

  const r = await runCommand(null, [node, '-e', 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(process.cwd()+"|"+s);process.stderr.write("e");process.exit(5)})'], { cwd: tmp, stdin: 'hi' });
  assert.deepStrictEqual([r.code, r.stdout, r.stderr], [5, `${tmp}|hi`, 'e']);

  const slow = await runCommand(null, [node, '-e', 'setInterval(()=>{},1000)'], { cwd: tmp, timeoutMs: 300 });
  assert.strictEqual(slow.code, 124);
  assert.strictEqual(slow.timedOut, true);

  const missing = await runCommand(null, ['definitely-not-a-program-xyz'], { cwd: tmp });
  assert.strictEqual(missing.code, 127);
  assert.match(missing.stderr, /ENOENT/);

  assert.strictEqual((await runCommand(os.hostname(), [node, '-e', ''], { cwd: tmp })).code, 0, 'this host by name is local');
  await assert.rejects(runCommand('no-such-box', ['true']), /unknown machine "no-such-box"/, 'a typo never runs here instead');
  await assert.rejects(runCommand(null, 'ls -la'), /argv/);

  assert.deepStrictEqual(normalise({ code: null, timedOut: true, stdout: '', stderr: '', error: 'timed out' }).code, 124);

  // ---- runCommand, another machine (a stand-in termhub) ------------------------

  let seen = null;
  let answer = (res) => res.end(JSON.stringify({ code: 0, signal: null, stdout: 'out', stderr: '', timedOut: false, truncated: { stdout: false, stderr: false } }));
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { url: req.url, method: req.method, headers: req.headers, body: JSON.parse(body) };
      answer(res);
    });
  });
  await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
  config.termhub.machines.lab.url = `http://127.0.0.1:${fake.address().port}`;
  try {
    const out = await runCommand('lab', ['git', 'status'], { cwd: '/srv/repos/x', timeoutMs: 5000 });
    assert.deepStrictEqual(out, { code: 0, stdout: 'out', stderr: '' });
    assert.strictEqual(seen.url, '/api/exec');
    assert.strictEqual(seen.headers['x-termhub'], '1', "termhub's browser guard header");
    assert.match(seen.headers['content-type'], /^application\/json/);
    assert.deepStrictEqual(seen.body, { argv: ['git', 'status'], timeoutMs: 5000, cwd: '/srv/repos/x' });

    answer = (res) => res.end(JSON.stringify({ code: null, timedOut: true, stdout: 'part', stderr: '', error: 'timed out after 5 ms' }));
    assert.strictEqual((await runCommand('lab', ['x'])).code, 124);

    answer = (res) => { res.statusCode = 404; res.end('{"error":"not found"}'); };
    await assert.rejects(runCommand('lab', ['x']), (e) => e.code === 'EXEC_UNSUPPORTED' && /too old/.test(e.message));
    answer = (res) => { res.statusCode = 403; res.end('{"error":"Host"}'); };
    await assert.rejects(runCommand('lab', ['x']), (e) => e.code === 'EXEC_REFUSED');

    // A no-push run on a termhub without /api/exec is refused: the typed push
    // block cannot be read back, and an unverified block is not enforcement.
    answer = (res) => { res.statusCode = 404; res.end('{"error":"not found"}'); };
    const typed = [];
    const hub = {
      api: async () => ({ platform: 'linux' }),
      dirs: async (p) => (p === '/srv/repos/' ? ['/srv/repos/widget'] : []),
      createSession: async () => ({ id: 's1' }),
      say: async (id, line) => { typed.push(line); },
      sessionUrl: async () => 'http://x',
    };
    await assert.rejects(
      remote.startOnMachine({ machine: lab, hub, run: { id: 7 }, repo: '/srv/repos/widget', branch: 'pa/7-x',
        mode: { name: 'local', mayPush: false }, brief: 'b', title: 't', blockedPushUrl: BLOCKED }),
      /could not be verified/
    );
    assert.deepStrictEqual(typed, [], 'nothing was typed');
    await assert.rejects(
      remote.startOnMachine({ machine: lab, hub, run: { id: 8 }, repo: '/srv/repos/nope', branch: 'b',
        mode: { name: 'branch', mayPush: true }, brief: 'b', title: 't', blockedPushUrl: BLOCKED }),
      /not cloned on lab/
    );
  } finally {
    fake.close();
  }

  // ---- doctor's probe -------------------------------------------------------------

  {
    const hub = { reachable: async () => ({ ok: true }), api: async () => ({ platform: 'linux' }) };
    const ok = await remote.probeMachine(lab, { hub, exec: async () => ({ code: 0, stdout: 'git version 2.43.0\n' }) });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.os, 'linux');
    assert.match(ok.detail, /linux · repos \/srv\/repos · git 2\.43\.0/);
    const old = await remote.probeMachine(lab, { hub, exec: async () => { throw Object.assign(new Error('x'), { code: 'EXEC_UNSUPPORTED' }); } });
    assert.strictEqual(old.ok, false);
    assert.match(old.detail, /too old/);
    const down = await remote.probeMachine(lab, { hub: { reachable: async () => ({ ok: false, error: 'ECONNREFUSED' }) } });
    assert.match(down.detail, /ECONNREFUSED/);
  }

  // ---- the mode boundary, against real git --------------------------------------

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  function makeRepo(name) {
    const origin = path.join(tmp, `${name}-origin.git`);
    const repo = path.join(tmp, 'repos', name);
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'init', '-q', '-b', 'main', repo);
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'remote', 'add', 'upstream', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    return { origin, repo };
  }
  const brief = `# Brief\n\nSam said: "can you check it's fixed?" — ünïcödé $(echo no) \`id\`\n${'x'.repeat(5000)}`;
  const machine = { name: 'here', reposRoot: path.join(tmp, 'repos') };

  async function provesBoundary(run, label) {
    const { repo, origin } = makeRepo(`widget-${label}`);
    const worktree = path.join(tmp, 'repos', '.pa-worktrees', `run-${label}`);
    await remote.setupViaExec({ machine, os: 'linux', repo, worktree, branch: `pa/${label}`, mayPush: false, brief, blockedPushUrl: BLOCKED, run });
    assert.strictEqual(fs.readFileSync(path.join(worktree, 'BRIEF.md'), 'utf8'), brief, `${label}: brief intact`);
    for (const name of ['origin', 'upstream']) {
      assert.strictEqual(git(worktree, 'remote', 'get-url', '--push', name).trim(), BLOCKED, `${label}: ${name} blocked in the run`);
      assert.strictEqual(git(repo, 'remote', 'get-url', '--push', name).trim(), origin, `${label}: main checkout untouched`);
    }
    git(worktree, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'agent');
    assert.throws(() => git(worktree, 'push', '-q', 'origin', `pa/${label}`), /pa-push-blocked/, `${label}: the run cannot push`);
    git(repo, 'push', '-q', 'origin', 'main'); // the main checkout still can
    // A run that may push is left alone.
    const wt2 = `${worktree}-push`;
    await remote.setupViaExec({ machine, os: 'linux', repo, worktree: wt2, branch: `pa/${label}-push`, mayPush: true, brief, blockedPushUrl: BLOCKED, run });
    assert.strictEqual(git(wt2, 'remote', 'get-url', '--push', 'origin').trim(), origin);
    // A worktree add that fails is an error, not a silently missing worktree.
    await assert.rejects(
      remote.setupViaExec({ machine, os: 'linux', repo, worktree, branch: `pa/${label}`, mayPush: false, brief, blockedPushUrl: BLOCKED, run }),
      /git worktree add failed/
    );
  }

  await provesBoundary((argv, opts = {}) => runCommand(null, argv, { timeoutMs: 60_000, ...opts }), 'local');

  // The typed POSIX fallback, run by a real sh, makes the same worktree and brief.
  {
    const { repo } = makeRepo('widget-typed');
    const worktree = path.join(tmp, 'repos', '.pa-worktrees', 'run-typed');
    const lines = remote.setupLines({ os: 'linux', repo, worktree, branch: 'pa/typed', mayPush: false, brief, blockedPushUrl: BLOCKED });
    assert.ok(!lines.some((l) => l.includes('Sam said')), 'nothing from the brief appears raw on a command line');
    assert.ok(lines.every((l) => l.length < 2200), 'no line is too long to type');
    execFileSync('sh', [], { input: lines.join('\n') + '\n', cwd: tmp, stdio: ['pipe', 'ignore', 'ignore'] });
    assert.strictEqual(fs.readFileSync(path.join(worktree, 'BRIEF.md'), 'utf8'), brief);
    assert.strictEqual(git(worktree, 'remote', 'get-url', '--push', 'origin').trim(), BLOCKED);
    assert.notStrictEqual(git(repo, 'remote', 'get-url', '--push', 'origin').trim(), BLOCKED);
  }

  // Through a real termhub front, when the sibling checkout is installed.
  const termhubDir = path.join(__dirname, '..', '..', 'termhub');
  if (fs.existsSync(path.join(termhubDir, 'lib', 'exec.js')) && fs.existsSync(path.join(termhubDir, 'node_modules'))) {
    const { createFront } = require(path.join(termhubDir, 'front.js'));
    const front = createFront({ sessiondPort: 1, port: 0, paUrl: '' });
    await new Promise((ok) => front.listen(0, '127.0.0.1', ok));
    const realLog = console.log;
    console.log = () => {}; // the front logs one line per run
    try {
      config.termhub.machines.lab.url = `http://127.0.0.1:${front.address().port}`;
      await provesBoundary((argv, opts = {}) => runCommand('lab', argv, { timeoutMs: 60_000, ...opts }), 'termhub');
    } finally {
      console.log = realLog;
      front.close();
    }
  } else {
    console.log('remoteExec.test.js: termhub not installed alongside — skipped the through-termhub leg');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('remoteExec.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
