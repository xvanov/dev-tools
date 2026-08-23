'use strict';

// The updater's self-heal — `linux/update.sh --heal`.
//
// This is the one place in termhub that runs `git reset --hard` on its own
// judgement, so it is the one place where being wrong destroys work instead of
// merely failing. That is why it gets real git fixtures rather than string
// assertions: the whole question is what git actually reports for a rewritten
// upstream, and no amount of reading the script answers it.
//
// The heal exists because a --ff-only pull refuses two situations that look
// identical from the outside. Upstream rewritten and force-pushed from another
// machine leaves this checkout holding patch-identical twins under stale shas —
// nothing of its own, nothing at risk, and yet permanently unable to update again.
// Real unpushed commits, or a dirty tree, look the same to `git pull` and must
// never be reset away. Each of those is a case below, and the refusals matter more
// than the heal.
//
// No framework, no deps, same shape as the other tests here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

let pass = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  OK    ${name}`); }
  else { failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  FAIL  ${name}`); }
}

const PROJECT_DIR = path.join(__dirname, '..');
const HEAL = path.join(PROJECT_DIR, 'linux', 'update.sh');

console.log('\nupdate self-heal');

// bash and git are the whole test. Windows runs the PowerShell twin, which this
// cannot exercise — say so out loud rather than reporting a pass that never ran.
if (process.platform === 'win32') {
  console.log('  SKIP  not applicable on win32 (windows/update.ps1 carries the twin)');
  process.exit(0);
}
if (spawnSync('git', ['--version']).status !== 0) {
  console.log('  SKIP  git not available');
  process.exit(0);
}

// A hermetic git: the user's global config must not decide whether these pass
// (a global merge.ff, commit.gpgsign or user.email would each change the outcome).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}
function commit(repo, file, message, env) {
  fs.writeFileSync(path.join(repo, file), message + '\n');
  execFileSync('git', ['-C', repo, 'add', '-A'], { env: GIT_ENV });
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', message], { env: { ...GIT_ENV, ...env } });
}
function heal(repo) {
  const r = spawnSync('bash', [path.join(repo, 'linux', 'update.sh'), '--heal'],
    { encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-heal-'));

// A checkout of a fake termhub, carrying the REAL update.sh, plus the bare remote
// it tracks. PROJECT_DIR inside the script resolves from the script's own location,
// so a copy at <repo>/linux/update.sh makes <repo> the project it operates on.
function fixture(name) {
  const dir = path.join(ROOT, name);
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', origin, work], { env: GIT_ENV, stdio: 'ignore' });
  fs.mkdirSync(path.join(work, 'linux'), { recursive: true });
  fs.copyFileSync(HEAL, path.join(work, 'linux', 'update.sh'));
  commit(work, 'a.txt', 'base');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { dir, origin, work };
}

// Rewrite what upstream says, the way a rebase or an amend on another machine does:
// same patch, different sha. Done in a second clone and force-pushed, because that
// is the only way the first clone ends up holding twins it did not create.
function rewriteUpstream(fx, extraFile) {
  const other = path.join(fx.dir, 'other');
  execFileSync('git', ['clone', '-q', fx.origin, other], { env: GIT_ENV, stdio: 'ignore' });
  // A fixed, distant committer date guarantees a different sha for the same patch.
  // Without it the amend can land in the same second as the original and produce the
  // identical commit — a fixture that quietly tests nothing.
  execFileSync('git', ['-C', other, 'commit', '-q', '--amend', '--no-edit'],
    { env: { ...GIT_ENV, GIT_COMMITTER_DATE: '2001-01-01T00:00:00 +0000' } });
  if (extraFile) commit(other, extraFile, 'upstream-only work');
  execFileSync('git', ['-C', other, 'push', '-qf', 'origin', 'main'], { env: GIT_ENV });
  return other;
}

// ---- 1) rewritten upstream: heal ---------------------------------------------
// The wedge this whole feature exists for. Nothing local is unique, so the reset is
// information-preserving and the machine can update again.
{
  const fx = fixture('rewritten');
  commit(fx.work, 'b.txt', 'shared work');
  git(fx.work, 'push', '-q', 'origin', 'main');
  rewriteUpstream(fx, 'c.txt');
  git(fx.work, 'fetch', '-q');

  const before = git(fx.work, 'rev-parse', 'HEAD');
  const counts = git(fx.work, 'rev-list', '--left-right', '--count', 'origin/main...HEAD').split(/\s+/);
  // Guard the fixture itself: if it did not actually diverge, everything below is vacuous.
  check('fixture really is diverged (both ahead and behind)',
    Number(counts[0]) > 0 && Number(counts[1]) > 0, counts.join('/'));
  check('git pull --ff-only really refuses it',
    spawnSync('git', ['-C', fx.work, 'pull', '--ff-only'], { env: GIT_ENV }).status !== 0);

  const r = heal(fx.work);
  check('heal succeeds on a rewritten upstream', r.code === 0, r.out);
  check('HEAD is now exactly origin/main',
    git(fx.work, 'rev-parse', 'HEAD') === git(fx.work, 'rev-parse', 'origin/main'));
  check('the upstream-only commit is now in the tree',
    fs.existsSync(path.join(fx.work, 'c.txt')));
  // The pre-reset lineage has to stay reachable: it is both the human's record and
  // what keeps $ROLLBACK a real object for the restart phase that may still need it.
  check('the pre-reset lineage is kept on termhub-pre-reset',
    git(fx.work, 'rev-parse', 'termhub-pre-reset') === before);
  check('a following pull --ff-only is clean',
    spawnSync('git', ['-C', fx.work, 'pull', '--ff-only'], { env: GIT_ENV }).status === 0);
}

// ---- 2) genuine local work: refuse -------------------------------------------
// The case that must never be "healed". One unpushed commit is enough to stop it,
// even though everything else about the situation looks identical to case 1.
{
  const fx = fixture('local-work');
  commit(fx.work, 'b.txt', 'shared work');
  git(fx.work, 'push', '-q', 'origin', 'main');
  rewriteUpstream(fx, 'c.txt');
  git(fx.work, 'fetch', '-q');
  commit(fx.work, 'mine.txt', 'my unpushed work');

  const before = git(fx.work, 'rev-parse', 'HEAD');
  const r = heal(fx.work);
  check('heal refuses when a local commit exists nowhere upstream', r.code !== 0, r.out);
  check('it names the commit it refused to destroy', /my unpushed work/.test(r.out), r.out);
  check('HEAD is untouched', git(fx.work, 'rev-parse', 'HEAD') === before);
  check('the unpushed file is still there', fs.existsSync(path.join(fx.work, 'mine.txt')));
}

// ---- 3) dirty tree: refuse ----------------------------------------------------
{
  const fx = fixture('dirty');
  commit(fx.work, 'b.txt', 'shared work');
  git(fx.work, 'push', '-q', 'origin', 'main');
  rewriteUpstream(fx, 'c.txt');
  git(fx.work, 'fetch', '-q');
  fs.appendFileSync(path.join(fx.work, 'a.txt'), 'uncommitted edit\n');

  const before = git(fx.work, 'rev-parse', 'HEAD');
  const r = heal(fx.work);
  check('heal refuses on a dirty tree', r.code !== 0, r.out);
  check('HEAD is untouched by the dirty-tree refusal',
    git(fx.work, 'rev-parse', 'HEAD') === before);
  check('the uncommitted edit survives',
    /uncommitted edit/.test(fs.readFileSync(path.join(fx.work, 'a.txt'), 'utf8')));
}

// ---- 4) not diverged at all: refuse -------------------------------------------
// A pull can fail for reasons that have nothing to do with history — no network, no
// credentials, a hook. The heal must recognise it has no business acting, or it
// becomes a `git reset --hard` triggered by a flaky connection.
{
  const fx = fixture('behind-only');
  const other = path.join(fx.dir, 'other');
  execFileSync('git', ['clone', '-q', fx.origin, other], { env: GIT_ENV, stdio: 'ignore' });
  commit(other, 'c.txt', 'upstream moved on');
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main'], { env: GIT_ENV });
  git(fx.work, 'fetch', '-q');

  const before = git(fx.work, 'rev-parse', 'HEAD');
  const r = heal(fx.work);
  check('heal refuses when HEAD is merely behind', r.code !== 0, r.out);
  check('it says the history is not diverged', /not diverged/.test(r.out), r.out);
  check('HEAD is untouched when there was no divergence',
    git(fx.work, 'rev-parse', 'HEAD') === before);
}

// ---- 5) the two updaters must ask the same question ---------------------------
// Windows runs its own copy of this logic (Repair-DivergedHistory in
// windows/common.ps1, exercised by test/repairHistory.test.ps1) and no node test can
// execute PowerShell. What this can still catch is DRIFT: the patch-id question is
// the load-bearing line in both, and if one side loses it, that platform either
// wedges forever or resets away real work.
{
  const sh = fs.readFileSync(HEAL, 'utf8');
  const ps = fs.readFileSync(path.join(PROJECT_DIR, 'windows', 'common.ps1'), 'utf8');
  const caller = fs.readFileSync(path.join(PROJECT_DIR, 'windows', 'update.ps1'), 'utf8');
  const question = /log --cherry-pick --right-only/;
  check('linux/update.sh heals on a refused pull', /heal_diverged_history/.test(sh));
  check('linux/update.sh asks the patch-id question', question.test(sh));
  check('windows/common.ps1 has the twin', /function Repair-DivergedHistory/.test(ps));
  check('windows/common.ps1 asks the same patch-id question', question.test(ps));
  check('windows/update.ps1 calls it on a refused pull', /Repair-DivergedHistory -RepoDir/.test(caller));
  check('both refuse to reset a dirty tree', /status --porcelain/.test(sh) && /status --porcelain/.test(ps));
  // The Windows caller must not trust the function's return value: a PowerShell
  // function returns everything that reached the pipeline, so it re-asks git where
  // HEAD is before continuing the update.
  check('windows/update.ps1 verifies HEAD against upstream rather than the return value',
    /rev-parse '@\{u\}'/.test(caller));
  check('there is a PowerShell test for the twin',
    fs.existsSync(path.join(PROJECT_DIR, 'test', 'repairHistory.test.ps1')));
}

// ---- 6) the detached finish phase must keep its environment -------------------
// systemd-run --user starts the transient unit from the USER MANAGER's environment,
// not this shell's — measured: a variable exported immediately before the call
// arrives unset on the other side. The finish phase is what restarts the service and
// decides whether to roll back, so losing TERMHUB_SERVICE means restarting the wrong
// service, and losing TERMHUB_PORT/BIND means health-checking the wrong address and
// rolling back a perfectly good update.
{
  const sh = fs.readFileSync(HEAL, 'utf8');
  for (const v of ['TERMHUB_SERVICE', 'TERMHUB_DATA_DIR', 'TERMHUB_PORT', 'TERMHUB_BIND']) {
    check(`${v} is forwarded into the finish phase`,
      new RegExp(`FINISH_ENV|setenv`).test(sh) && sh.includes(v));
  }
  const setenvAt = sh.indexOf('FINISH_ENV+=');
  // Anchor on the invocation, not the word: the writeup above it names systemd-run too.
  const runAt = sh.indexOf('systemd-run --user --unit=');
  check('the forwarding is built before the hand-off', setenvAt !== -1 && setenvAt < runAt);
  // Under `set -u`, bash before 4.4 aborts on "${arr[@]}" when arr is EMPTY — which
  // is the common case (no overrides set). Expanding it guarded is what keeps the
  // updater working on older machines.
  check('the empty-array expansion is guarded for bash < 4.4',
    /\$\{FINISH_ENV\[@\]\+"\$\{FINISH_ENV\[@\]\}"\}/.test(sh));
}

fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\nupdate self-heal: ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
