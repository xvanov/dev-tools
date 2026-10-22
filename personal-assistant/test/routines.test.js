'use strict';

// Routines: the cron parser, the action registry, the repo_sync safety rules,
// and the suggestion evidence helpers. All pure — no database, no git, no
// model. The rules in `decide` are the point of repo_sync, so they get the
// most cases.

const assert = require('assert');
const path = require('path');
const cron = require('../src/routines/cron');
const actions = require('../src/routines/actions');
const { decide, sessionsTouching, untrackedInTheWay, parseStatus } = require('../src/routines/actions/repoSync');
const { promptsOf, repeatedAsks, resembles, jaccard } = require('../src/routines/suggest');
const { preview, plainWords, numbered, stableJson } = require('../src/routines');

const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi); // local time
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// ------------------------------------------------------------- cron parse ----

{
  const c = cron.parse('*/15 8-17 * * 1-5');
  assert.deepStrictEqual([...c.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.strictEqual(c.hour.size, 10);
  assert.deepStrictEqual([...c.dow].sort(), [1, 2, 3, 4, 5]);

  assert.deepStrictEqual([...cron.parse('0 9 * * mon,wed,FRI').dow].sort(), [1, 3, 5]);
  assert.deepStrictEqual([...cron.parse('0 9 * jan-mar *').month].sort(), [1, 2, 3]);
  assert.deepStrictEqual([...cron.parse('0 0 * * 7').dow], [0], '7 is Sunday');
  assert.deepStrictEqual([...cron.parse('5/20 * * * *').minute].sort((a, b) => a - b), [5, 25, 45]);
  assert.deepStrictEqual([...cron.parse('0-30/10 * * * *').minute].sort((a, b) => a - b), [0, 10, 20, 30]);
  assert.deepStrictEqual([...cron.parse('1,2,10-12 * * * *').minute].sort((a, b) => a - b), [1, 2, 10, 11, 12]);
  assert.strictEqual(cron.parse('@daily').source, '0 0 * * *');
  assert.strictEqual(cron.parse('  0   8  *  *  1-5 ').source, '0 8 * * 1-5');

  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *',
    '* * * * 8', '5-1 * * * *', '*/0 * * * *', 'x * * * *', '1,,2 * * * *', '1-2-3 * * * *', '*/2/3 * * * *']) {
    assert.throws(() => cron.parse(bad), Error, `should reject "${bad}"`);
    assert.strictEqual(cron.valid(bad), false);
  }
  assert.throws(() => cron.parse('61 * * * *'), /minute: 61 is outside 0-59/);
}

// -------------------------------------------------------------- cron next ----

{
  // Weekdays 08:00 from a Wednesday 07:59 → same day 08:00.
  assert.strictEqual(fmt(cron.next('0 8 * * 1-5', L(2026, 10, 21, 7, 59))), '2026-10-21 08:00');
  // Strictly after: at exactly 08:00 the next one is tomorrow.
  assert.strictEqual(fmt(cron.next('0 8 * * 1-5', L(2026, 10, 21, 8, 0))), '2026-10-22 08:00');
  // Friday after 08:00 → Monday.
  assert.strictEqual(fmt(cron.next('0 8 * * 1-5', L(2026, 10, 23, 9, 30))), '2026-10-26 08:00');
  // Seconds are ignored, not rounded up into a skipped minute.
  const withSeconds = L(2026, 10, 21, 7, 59);
  withSeconds.setSeconds(59, 999);
  assert.strictEqual(fmt(cron.next('0 8 * * *', withSeconds)), '2026-10-21 08:00');
  // Every 15 minutes.
  assert.strictEqual(fmt(cron.next('*/15 * * * *', L(2026, 10, 21, 10, 7))), '2026-10-21 10:15');
  assert.strictEqual(fmt(cron.next('*/15 * * * *', L(2026, 10, 21, 23, 50))), '2026-10-22 00:00');
  // Month and year rollover.
  assert.strictEqual(fmt(cron.next('0 0 1 * *', L(2026, 12, 15))), '2027-01-01 00:00');
  // Day 31 skips 30-day months.
  assert.strictEqual(fmt(cron.next('0 12 31 * *', L(2026, 4, 1))), '2026-05-31 12:00');
  // Leap day.
  assert.strictEqual(fmt(cron.next('0 0 29 2 *', L(2026, 3, 1))), '2028-02-29 00:00');
  // Never: 30 February.
  assert.strictEqual(cron.next('0 0 30 2 *', L(2026, 1, 1)), null);
  // Classic OR rule: the 1st OR a Monday. 2026-11-01 is a Sunday, 11-02 a Monday.
  assert.strictEqual(fmt(cron.next('0 9 1 * 1', L(2026, 10, 31, 12))), '2026-11-01 09:00');
  assert.strictEqual(fmt(cron.next('0 9 1 * 1', L(2026, 11, 1, 10))), '2026-11-02 09:00');
  // A step in day-of-month is "unrestricted" for the OR rule: AND applies.
  // */2 days → odd dates; also Monday. 2026-11-02 is Monday but even → skip to Mon 11-09? no, 9 is odd and Monday.
  assert.strictEqual(fmt(cron.next('0 9 */2 * 1', L(2026, 11, 1, 10))), '2026-11-09 09:00');
  // upcoming
  const three = cron.upcoming('30 8 * * 1-5', 3, L(2026, 10, 23, 9));
  assert.deepStrictEqual(three.map(fmt), ['2026-10-26 08:30', '2026-10-27 08:30', '2026-10-28 08:30']);
}

// ------------------------------------------------------------ in words ----

assert.strictEqual(cron.describe('0 8 * * 1-5'), 'Weekdays 08:00');
assert.strictEqual(cron.describe('30 9 * * 0,6'), 'Weekends 09:30');
assert.strictEqual(cron.describe('0 8 * * *'), 'Every day 08:00');
assert.strictEqual(cron.describe('0 9,14 * * mon'), 'Mondays 09:00 and 14:00');
assert.strictEqual(cron.describe('*/15 * * * *'), 'Every day, every 15 minutes');
assert.strictEqual(cron.describe('*/30 9-17 * * 1-5'), 'Weekdays, every 30 minutes between 09:00 and 17:59');
assert.strictEqual(cron.describe('5 * * * *'), 'Every day, hourly at :05');
assert.strictEqual(cron.describe('0 7 1 * *'), 'On day 1 of the month 07:00');
assert.match(cron.describe('nonsense'), /cron "nonsense"/);

// ---------------------------------------------------------- the registry ----

{
  assert.deepStrictEqual(actions.names().sort(), ['prompt_report', 'repo_sync']);
  assert.throws(() => actions.get('shell'), /unknown action "shell"/);
  // Defaults fill in, unknown keys are dropped, strings coerce where it is safe.
  assert.deepStrictEqual(actions.validateParams('repo_sync', { quietMinutes: '90', rm: '-rf /' }), { nested: true, quietMinutes: 90 });
  assert.deepStrictEqual(actions.validateParams('repo_sync', null), { nested: true, quietMinutes: 60 });
  assert.throws(() => actions.validateParams('repo_sync', { quietMinutes: 1 }), /≥ 5/);
  assert.throws(() => actions.validateParams('repo_sync', { nested: 'maybe' }), /must be a boolean/);
  assert.throws(() => actions.validateParams('prompt_report', {}), /"prompt" is required/);
  assert.deepStrictEqual(actions.validateParams('prompt_report', { prompt: 'Summarise review requests' }), { prompt: 'Summarise review requests' });
  assert.throws(() => actions.validateParams('prompt_report', { prompt: 'x'.repeat(1001) }), /longer than 1000/);

  // A new action is one entry.
  actions.register({ name: 'test_noop', summary: 'does nothing', params: { n: { type: 'number', default: 1 } },
    describe: (p) => `do nothing ${p.n} times`, run: async () => ({ ok: true, summary: 'nothing' }) });
  assert.strictEqual(actions.describe('test_noop', {}), 'do nothing 1 times');
  assert.ok(actions.catalog().some((a) => a.action === 'test_noop' && a.changesTheMachine === 'no — read-only'));
  assert.throws(() => actions.register({ name: 'test_noop', summary: 'x', describe: () => '', run: () => {} }), /registered twice/);
  assert.throws(() => actions.register({ name: 'Bad Name', summary: 'x', describe: () => '', run: () => {} }), /bad action name/);
  assert.throws(() => actions.register({ name: 'no_run', summary: 'x', describe: () => '' }), /missing "run"/);
  assert.throws(() => actions.register({ name: 'bad_type', summary: 'x', describe: () => '', run: () => {}, params: { a: { type: 'object' } } }), /type must be/);
  actions.registry.delete('test_noop');

  // The repo_sync catalog entry says it changes the machine; the report does not.
  const cat = Object.fromEntries(actions.catalog().map((a) => [a.action, a]));
  assert.match(cat.repo_sync.changesTheMachine, /git merge --ff-only/);
  assert.strictEqual(cat.prompt_report.changesTheMachine, 'no — read-only');
}

// ------------------------------------------------------------- preview ----

{
  const p = preview({ title: 'Morning pull', schedule: '0 8 * * 1-5', action: 'repo_sync', params: {} }, { now: L(2026, 10, 23, 9) });
  assert.strictEqual(p.schedule, '0 8 * * 1-5');
  assert.match(p.plain, /^Weekdays 08:00 — Pull main on every repo under .+ that is clean, on its default branch/);
  assert.match(p.plain, /others are fetched and reported$/);
  assert.strictEqual(p.nextRuns.length, 3);
  assert.strictEqual(fmt(new Date(p.nextRuns[0])), '2026-10-26 08:00');
  assert.ok(p.changes);
  assert.throws(() => preview({ title: 't', schedule: '0 8 * *', action: 'repo_sync' }), /5 fields/);
  assert.throws(() => preview({ title: 't', schedule: '0 8 * * *', action: 'run_shell', params: { cmd: 'x' } }), /unknown action/);
  assert.throws(() => preview({ title: 't', schedule: '0 0 30 2 *', action: 'repo_sync' }), /never runs/);
  assert.strictEqual(plainWords({ schedule: '0 17 * * 5', action: 'prompt_report', params: { prompt: 'What shipped this week?' } }),
    'Fridays 17:00 — Ask "What shipped this week?" and send me the answer (read-only)');
  assert.strictEqual(numbered(['a', 'b']), '1. a\n2. b');
  assert.match(numbered(Array.from({ length: 30 }, (_, i) => String(i)), 25), /and 5 more/);
  assert.strictEqual(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
}

// ---------------------------------------------------- repo_sync: decide ----

{
  const now = Date.parse('2026-10-22T10:00:00Z');
  // A repo where every rule passes: on main, clean, 3 behind, idle for 2 hours.
  const ok = {
    name: 'quill', hasOrigin: true, defaultBranch: 'main', branch: 'main', ahead: 0, behind: 3, dirty: 0,
    untracked: [], incoming: [], operation: null, indexLocked: false, lastActivityMs: now - 2 * 3600_000, nowMs: now,
    quietMinutes: 60, sessionsKnown: true, sessions: [],
  };
  const d = (patch) => decide({ ...ok, ...patch });

  assert.deepStrictEqual(d({}), { action: 'ff', reason: 'fast-forward 3 commits' });
  assert.strictEqual(d({ behind: 1 }).reason, 'fast-forward 1 commit');
  assert.strictEqual(d({ defaultBranch: 'master', branch: 'master' }).action, 'ff');

  // Nothing to do.
  assert.deepStrictEqual(d({ behind: 0 }), { action: 'none', reason: 'already current' });
  assert.deepStrictEqual(d({ behind: 0, ahead: 2 }), { action: 'none', reason: 'already current (2 local commits not pushed)' });
  // Already current wins over the other rules — no reason to complain about a dirty tree we would not touch.
  assert.strictEqual(d({ behind: 0, dirty: 4 }).action, 'none');

  // Not on the default branch: fetched and reported, never switched.
  assert.deepStrictEqual(d({ branch: 'feature/x', behind: 3 }), { action: 'skip', reason: 'on feature/x, 3 behind main — left alone' });
  assert.deepStrictEqual(d({ branch: 'feature/x', behind: 0 }), { action: 'skip', reason: 'on feature/x — left alone' });
  assert.strictEqual(d({ branch: null }).reason, 'detached HEAD — left alone');
  // Case matters: "Main" is not "main".
  assert.strictEqual(d({ branch: 'Main' }).action, 'skip');

  // Work in progress.
  assert.deepStrictEqual(d({ dirty: 1 }), { action: 'skip', reason: '1 uncommitted change' });
  assert.deepStrictEqual(d({ dirty: 5 }), { action: 'skip', reason: '5 uncommitted changes' });
  for (const op of ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect']) {
    assert.deepStrictEqual(d({ operation: op }), { action: 'skip', reason: `${op} in progress` });
  }
  // A rebase detaches HEAD, but the operation is the better reason.
  assert.strictEqual(d({ operation: 'rebase', branch: null }).reason, 'rebase in progress');
  assert.match(d({ indexLocked: true }).reason, /index\.lock/);

  // Diverged: not a fast-forward.
  assert.deepStrictEqual(d({ ahead: 1, behind: 3 }), { action: 'skip', reason: 'diverged: 1 local, 3 incoming — not a fast-forward' });

  // Recent activity.
  assert.deepStrictEqual(d({ lastActivityMs: now - 12 * 60000 }), { action: 'skip', reason: 'touched 12 min ago — waiting for 60 quiet minutes' });
  assert.match(d({ lastActivityMs: now - 10_000 }).reason, /touched just now/);
  assert.strictEqual(d({ lastActivityMs: now - 61 * 60000 }).action, 'ff');
  assert.strictEqual(d({ lastActivityMs: now - 59 * 60000 }).action, 'skip');
  assert.strictEqual(d({ lastActivityMs: now - 20 * 60000, quietMinutes: 15 }).action, 'ff');
  assert.strictEqual(d({ lastActivityMs: 0 }).action, 'ff', 'no activity recorded is not recent activity');

  // Sessions.
  assert.deepStrictEqual(d({ sessions: ['termhub session "Brannoc"'] }), { action: 'skip', reason: 'in use by termhub session "Brannoc"' });
  assert.strictEqual(d({ sessions: ['pa run #7', 'termhub session "x"'] }).reason, 'in use by pa run #7, termhub session "x"');
  assert.match(d({ sessionsKnown: false }).reason, /termhub unreachable/);

  // Untracked files: allowed unless they sit where the update writes.
  assert.strictEqual(d({ untracked: ['notes.txt'], incoming: ['src/a.js'] }).action, 'ff');
  assert.match(d({ untracked: ['src/new.js'], incoming: ['src/a.js'] }).reason, /untracked src\/new\.js sits where the update writes/);
  assert.strictEqual(d({ untracked: ['src/a.js'], incoming: ['src/a.js'] }).action, 'skip');
  assert.strictEqual(d({ untracked: ['scratch/'], incoming: ['scratch/x.md'] }).action, 'skip');
  assert.strictEqual(d({ untracked: ['scratch/'], incoming: ['src/x.md'] }).action, 'ff');
  assert.strictEqual(d({ untracked: ['README.draft'], incoming: ['README.md'] }).action, 'skip', 'same directory (the root)');

  // Infrastructure failures.
  assert.deepStrictEqual(d({ hasOrigin: false }), { action: 'skip', reason: 'no origin remote' });
  assert.deepStrictEqual(d({ fetchError: 'timed out' }), { action: 'skip', reason: 'fetch failed: timed out' });
  assert.match(d({ defaultBranch: null }).reason, /no default branch/);
  assert.deepStrictEqual(d({ error: 'not readable: x' }), { action: 'skip', reason: 'not readable: x' });

  // A fetch failure is reported even on a feature branch (it was the one thing we tried to do).
  assert.match(d({ branch: 'feature/y', fetchError: 'auth' }).reason, /^fetch failed/);

  // Every rule fails at once: still a skip, never an ff.
  assert.strictEqual(d({ dirty: 3, ahead: 1, operation: 'merge', sessions: ['x'], lastActivityMs: now }).action, 'skip');

  // Exhaustive-ish: 'ff' only when every safety fact holds.
  const facts = {
    dirty: [0, 1], operation: [null, 'merge'], indexLocked: [false, true], ahead: [0, 1],
    sessions: [[], ['s']], sessionsKnown: [true, false], lastActivityMs: [now - 7200_000, now - 60_000],
    branch: ['main', 'feature/z'], untracked: [[], ['src/n.js']],
  };
  const keys = Object.keys(facts);
  let ffs = 0;
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const patch = {};
    keys.forEach((k, i) => { patch[k] = facts[k][(mask >> i) & 1]; });
    const r = d({ ...patch, incoming: ['src/a.js'] });
    if (r.action === 'ff') {
      ffs++;
      assert.strictEqual(mask, 0, `ff only for the all-safe state, got it for ${JSON.stringify(patch)}`);
    }
    assert.notStrictEqual(r.action, 'none');
  }
  assert.strictEqual(ffs, 1);
}

// ------------------------------------------------ repo_sync: sessions ----

{
  const root = path.resolve('/repos');
  const repo = path.join(root, 'quill');
  const nested = path.join(root, 'group', 'inner');
  const busy = [
    { path: path.join(root, 'quill', 'src'), label: 'termhub "a"' },
    { path: path.join(root, 'quillmore'), label: 'termhub "b"' },
    { path: root, label: 'termhub "root"' },
    { path: path.join(root, 'group'), label: 'termhub "group"' },
    { path: path.resolve('/'), label: 'termhub "drive"' },
    { path: null, label: 'nothing' },
  ];
  assert.deepStrictEqual(sessionsTouching(repo, busy, root), ['termhub "a"'], 'a sibling with a common prefix is not inside');
  assert.deepStrictEqual(sessionsTouching(nested, busy, root), ['termhub "group"'], 'a session in the parent folder of a nested repo counts');
  assert.deepStrictEqual(sessionsTouching(repo, [{ path: repo, label: 'x' }, { path: repo, label: 'x' }], root), ['x']);
  if (process.platform === 'win32') {
    assert.deepStrictEqual(sessionsTouching('C:\\repos\\Quill', [{ path: 'c:\\REPOS\\quill\\', label: 'y' }], 'C:\\repos'), ['y']);
  }
}

// -------------------------------------------------- repo_sync: helpers ----

{
  const st = parseStatus(' M src/a.js\0?? notes.txt\0R  new.js\0old.js\0?? scratch/\0UU c.js\0');
  assert.deepStrictEqual(st, { dirty: 3, untracked: ['notes.txt', 'scratch/'], changed: ['src/a.js', 'new.js', 'c.js'] });
  assert.deepStrictEqual(parseStatus(''), { dirty: 0, untracked: [], changed: [] });
  assert.strictEqual(untrackedInTheWay([], ['a']), null);
  assert.strictEqual(untrackedInTheWay(['a\\b.js'], ['a/c.js']), 'a\\b.js');
}

// ------------------------------------------------------- suggestions ----

{
  const body = '>> pull main on every repo\n\n<< Done — 4 repos updated.\n\n>> now run the tests\nand report';
  assert.deepStrictEqual(promptsOf(body), ['pull main on every repo', 'now run the tests\nand report']);
  assert.deepStrictEqual(promptsOf(''), []);

  const items = [
    { id: 1, occurred_at: '2026-10-19T08:05:00Z', body_text: '>> Pull main on every repo please\n\n<< ok' },
    { id: 2, occurred_at: '2026-10-20T08:02:00Z', body_text: '>> pull main on every repo\n\n<< ok' },
    { id: 3, occurred_at: '2026-10-21T08:10:00Z', body_text: '>> pull main, on every repo!\n\n<< ok\n\n>> fix the Quill build' },
    { id: 4, occurred_at: '2026-10-21T15:00:00Z', body_text: '>> fix the Quill build\n\n<< ok' },
    { id: 5, occurred_at: '2026-10-21T16:00:00Z', body_text: `>> ${'a long task description '.repeat(20)}\n\n<< ok` },
  ];
  const asks = repeatedAsks(items);
  assert.strictEqual(asks.length, 1, 'same-day repeats are not a rhythm; long prompts are tasks');
  assert.strictEqual(asks[0].key, 'pull main every repo');
  assert.strictEqual(asks[0].days, 3);
  assert.deepStrictEqual(asks[0].items, ['item:1', 'item:2', 'item:3']);

  assert.ok(jaccard('summarise review requests from yesterday', 'summarise yesterday review requests') >= 0.8);
  assert.strictEqual(jaccard('', 'x'), 0);

  const existing = [
    { id: 9, title: 'Morning pull', action: 'repo_sync', params: { nested: true, quietMinutes: 60 }, status: 'rejected' },
    { id: 10, title: 'Review digest', action: 'prompt_report', params: { prompt: 'Summarise review requests from yesterday' }, status: 'active' },
  ];
  assert.strictEqual(resembles({ title: 'Pull repos at 7', action: 'repo_sync', params: { nested: true, quietMinutes: 30 } }, existing)?.id, 9,
    'a rejected repo_sync is never proposed again, whatever its knobs');
  assert.strictEqual(resembles({ title: 'Digest', action: 'prompt_report', params: { prompt: 'summarise yesterday review requests' } }, existing)?.id, 10);
  assert.strictEqual(resembles({ title: 'Jira digest', action: 'prompt_report', params: { prompt: 'Which Jira issues moved to Done this week?' } }, existing), null);
  assert.strictEqual(resembles({ title: 'morning  PULL', action: 'prompt_report', params: { prompt: 'anything' } }, existing)?.id, 9, 'same title');
}

console.log('routines ok');
