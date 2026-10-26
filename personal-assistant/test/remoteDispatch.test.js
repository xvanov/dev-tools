'use strict';

// Remote dispatch: reading PA_MACHINES, where a repo and a worktree live on
// that machine, and the shell lines that set a run up there — the push block
// for modes that may not push, and a brief that survives quotes and length.

const assert = require('assert');
const { parseMachines } = require('../src/config');
const { setupLines, remoteRepoPath, remoteWorktreePath, psq } = require('../src/dispatch/remote');

// --- PA_MACHINES ------------------------------------------------------------

assert.deepStrictEqual(parseMachines(''), {});
const machines = parseMachines('build-vm=http://build-vm.example.ts.net:7000/|C:\\source, lab=https://lab.example:7443|D:\\code');
assert.deepStrictEqual(machines['build-vm'], { name: 'build-vm', url: 'http://build-vm.example.ts.net:7000', reposRoot: 'C:\\source' });
assert.strictEqual(machines.lab.reposRoot, 'D:\\code');
assert.throws(() => parseMachines('no-url-here'), /PA_MACHINES/);

// --- paths ------------------------------------------------------------------

const vm = machines['build-vm'];
assert.strictEqual(remoteRepoPath(vm, 'C:\\repos\\widget-toolkit'), 'C:\\source\\widget-toolkit');
assert.strictEqual(remoteRepoPath(vm, 'C:/repos/widget-toolkit/'), 'C:\\source\\widget-toolkit');
assert.strictEqual(remoteWorktreePath(vm, 42), 'C:\\source\\.pa-worktrees\\run-42');

// --- shell lines ------------------------------------------------------------

assert.strictEqual(psq("it's"), "'it''s'");

const brief = `# Brief\n\nSam said: "can you check it's fixed?" — ünïcödé\n${'x'.repeat(5000)}`;
const base = {
  repo: 'C:\\source\\widget-toolkit',
  worktree: 'C:\\source\\.pa-worktrees\\run-42',
  branch: 'pa/42-fix-it',
  brief,
  blockedPushUrl: 'https://blocked.invalid/x.git',
};

const local = setupLines({ ...base, mayPush: false });
assert.ok(local.some((l) => l.includes('worktree add -b') && l.includes("'pa/42-fix-it'")));
assert.ok(local.some((l) => l.includes('remote.origin.pushurl') && l.includes('blocked.invalid')), 'a mode that may not push is blocked');
assert.ok(!setupLines({ ...base, mayPush: true }).some((l) => l.includes('pushurl')), 'a mode that may push is not');

// The brief travels as base64 chunks and decodes back to exactly what was sent.
const chunks = local.filter((l) => l.startsWith("$paBrief += '")).map((l) => l.slice(13, -1));
assert.ok(chunks.length > 1, 'a long brief is chunked');
assert.ok(local.every((l) => l.length < 2200), 'no line is too long to type');
assert.strictEqual(Buffer.from(chunks.join(''), 'base64').toString('utf8'), brief);
// Nothing from the brief appears raw on a command line.
assert.ok(!local.some((l) => l.includes('Sam said')));
assert.ok(local[local.length - 1].startsWith('Set-Location'), 'ends in the worktree, ready for claude');

// --- what Claude's screen is asking for ------------------------------------

const { claudeScreenState, trustKeys } = require('../src/dispatch/termhub');
assert.strictEqual(claudeScreenState(''), null);
// The newer prompt has the cursor on "No, exit": Enter alone quits Claude.
const newTrust = ' Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm';
assert.strictEqual(claudeScreenState(newTrust), 'trust');
assert.deepStrictEqual(trustKeys(newTrust), ['\x1b[B', '']);
assert.deepStrictEqual(trustKeys('Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit'), ['']);
{
  const { withTrust, key } = require('../src/dispatch/trust');
  const dir = process.platform === 'win32' ? 'C:\\data\\worktrees' : '/data/worktrees';
  const next = withTrust({ projects: { other: { x: 1 } }, keep: true }, dir);
  assert.strictEqual(next.projects[key(dir)].hasTrustDialogAccepted, true);
  assert.deepStrictEqual(next.projects.other, { x: 1 });
  assert.strictEqual(next.keep, true);
  assert.strictEqual(withTrust(next, dir), null); // already trusted: no write
}
assert.strictEqual(claudeScreenState('Claude Code v2\nDo you trust the files in this folder?\n> 1. Yes, proceed'), 'trust');
assert.strictEqual(claudeScreenState('… bypass permissions on (shift+tab to cycle)'), 'ready');
// An answered trust question is still in the replay above the input box.
assert.strictEqual(
  claudeScreenState('Do you trust the files in this folder?\n1. Yes, proceed\n…\n❯ Try "fix lint"\n bypass permissions on'),
  'ready'
);

console.log('remoteDispatch.test.js ok');
