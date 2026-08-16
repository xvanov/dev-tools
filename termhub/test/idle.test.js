'use strict';

// Covers the idle layer's two pure halves: the state machine (lib/idleState.js)
// and the episode log (lib/idleStore.js). Both are deliberately free of PTYs,
// clocks and HTTP so the rules can be pinned here rather than discovered on a
// live machine at 2am.
//
// The cases that earned their place:
//   - a spend-limit notice passes every "the assistant finished its turn" test
//     there is, and must NOT start the idle clock;
//   - a session parked on a question writes nothing to its transcript, so the
//     only evidence is PTY silence;
//   - a long idle stretch is checkpointed every 5 minutes, and counting those
//     continuations as separate handoffs would turn one forgotten terminal into
//     a dozen imaginary ones.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// idleStore writes under the data dir; point it at a throwaway one before it is
// required, exactly as the claudeModel suite redirects HOME.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-idle-'));
process.env.TERMHUB_DATA_DIR = DATA;

const {
  classifyClaude, classifyOpencode, isTracked, shouldAnnounceExit, QUIET_MS, BLOCKED_MS,
} = require('../lib/idleState');
const store = require('../lib/idleStore');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

const turn = (over = {}) => ({
  uuid: 'u1', role: 'assistant', text: 'done', model: 'claude-opus-5',
  stopReason: 'end_turn', toolNames: [], prompt: null, ts: 1, ...over,
});

console.log('idleState — classifying one session');

ok('a finished assistant turn with a quiet PTY is waiting', () => {
  const v = classifyClaude({ turn: turn(), ptyIdleMs: 5000 });
  assert.strictEqual(v.state, 'waiting');
  assert.strictEqual(v.reason, 'turn-end');
});

ok('output in the last QUIET_MS reads as working, whatever the transcript says', () => {
  // The transcript's tail during streaming can be a partial entry that already
  // looks finished; the PTY is the faster and more honest signal here.
  const v = classifyClaude({ turn: turn(), ptyIdleMs: QUIET_MS - 1 });
  assert.strictEqual(v.state, 'working');
});

ok('a tool_use stop is mid-work, not idle', () => {
  const v = classifyClaude({ turn: turn({ stopReason: 'tool_use', toolNames: ['Bash'] }), ptyIdleMs: 3000 });
  assert.strictEqual(v.state, 'working');
});

ok('an asking tool IS idle even though it stops on tool_use', () => {
  const v = classifyClaude({
    turn: turn({ stopReason: 'tool_use', toolNames: ['AskUserQuestion'] }), ptyIdleMs: 3000,
  });
  assert.strictEqual(v.state, 'waiting');
});

ok('silence past BLOCKED_MS with no finished turn is idle — the parked-on-a-question case', () => {
  // This is the whole reason the PTY is consulted at all: a session sitting on
  // a permission prompt appends NOTHING to its transcript until you answer.
  const v = classifyClaude({ turn: turn({ role: 'user', stopReason: null }), ptyIdleMs: BLOCKED_MS + 1 });
  assert.strictEqual(v.state, 'waiting');
  assert.strictEqual(v.reason, 'blocked');
});

ok('the same silence before BLOCKED_MS is still working', () => {
  const v = classifyClaude({ turn: turn({ role: 'user', stopReason: null }), ptyIdleMs: BLOCKED_MS - 1 });
  assert.strictEqual(v.state, 'working');
});

ok('a session with no transcript yet, sitting silent, is idle', () => {
  const v = classifyClaude({ turn: null, ptyIdleMs: BLOCKED_MS + 1 });
  assert.strictEqual(v.state, 'waiting');
  assert.strictEqual(v.reason, 'prompt');
});

ok('a spend-limit notice is `limited`, never `waiting`', () => {
  // Verbatim shape from a real transcript on this machine: an ordinary
  // assistant entry, model `<synthetic>`, stop_reason stop_sequence. Every
  // structural test reads it as a finished turn — which is why the limit check
  // runs first, and why counting it would punish the user for the one pause
  // they cannot fix.
  const v = classifyClaude({
    turn: turn({
      model: '<synthetic>', stopReason: 'stop_sequence',
      text: "You've hit your org's monthly spend limit · run /usage-credits to see more",
    }),
    ptyIdleMs: 60000,
  });
  assert.strictEqual(v.state, 'limited');
});

ok('an interrupt notice is not a limit', () => {
  const v = classifyClaude({
    turn: turn({ model: '<synthetic>', stopReason: 'stop_sequence', text: '[Request interrupted by user]' }),
    ptyIdleMs: 60000,
  });
  assert.strictEqual(v.state, 'waiting');
});

ok('opencode reads its state off the event stream, with no heuristic at all', () => {
  assert.strictEqual(classifyOpencode({ idleAt: 0, ask: null }).state, 'working');
  assert.strictEqual(classifyOpencode({ idleAt: 123, ask: null }).state, 'waiting');
  assert.strictEqual(classifyOpencode({ idleAt: 0, ask: { text: 'which?' } }).reason, 'question');
});

console.log('idleState — is this death worth a push?');

ok('a crash while working is announced', () => {
  assert.strictEqual(shouldAnnounceExit({ exitCode: 1, lastState: 'working', sinceInputMs: 600000 }), true);
});

ok('a clean exit from a session that was mid-work is still announced', () => {
  // A TUI that finishes its cleanup and gives up returns 0. From the phone that
  // is indistinguishable from a crash, and equally worth knowing.
  assert.strictEqual(shouldAnnounceExit({ exitCode: 0, lastState: 'working', sinceInputMs: 600000 }), true);
});

ok('a clean exit from a session that was merely waiting is not', () => {
  assert.strictEqual(shouldAnnounceExit({ exitCode: 0, lastState: 'waiting', sinceInputMs: 600000 }), false);
});

ok('typing right before the end means you closed it — silence', () => {
  // The case that makes PTY output useless here: `/exit` chatters exactly like
  // a crash, and returns 0 exactly like a clean finish. Only the keystroke
  // separates them.
  assert.strictEqual(shouldAnnounceExit({ exitCode: 0, lastState: 'working', sinceInputMs: 1200 }), false);
  assert.strictEqual(shouldAnnounceExit({ exitCode: 1, lastState: 'working', sinceInputMs: 1200 }), false);
});

ok('a session never typed into can still announce its death', () => {
  // sinceInputMs is Infinity for a session launched and left alone — the guard
  // must not swallow those, which are exactly the forgotten ones.
  assert.strictEqual(shouldAnnounceExit({ exitCode: 1, lastState: 'working', sinceInputMs: Infinity }), true);
});

ok('pressing ✕ is never news', () => {
  assert.strictEqual(shouldAnnounceExit({ exitCode: 1, lastState: 'working', killed: true, sinceInputMs: Infinity }), false);
});

console.log('idleState — scope');

ok('shells are not tracked', () => {
  assert.strictEqual(isTracked({ kind: 'shell' }), false);
  assert.strictEqual(isTracked({ kind: 'claude' }), true);
  assert.strictEqual(isTracked({ kind: 'opencode' }), true);
});

console.log('idleStore — the episode log');

const DAY = '2026-08-16';
const at = (h, m = 0) => new Date(2026, 7, 16, h, m).getTime();

ok('a day rolls up to totals, handoffs and peak parallelism', () => {
  store.append({ id: 'a', start: at(9), end: at(9, 30), state: 'working', title: 'a', kind: 'claude' });
  store.append({ id: 'b', start: at(9, 15), end: at(9, 45), state: 'working', title: 'b', kind: 'claude' });
  store.append({ id: 'a', start: at(9, 30), end: at(9, 40), state: 'waiting', title: 'a', kind: 'claude' });
  const r = store.rollup(DAY);
  assert.strictEqual(r.working, 60 * 60 * 1000);
  assert.strictEqual(r.waiting, 10 * 60 * 1000);
  assert.strictEqual(r.handoffs, 1);
  assert.strictEqual(r.peakParallel, 2);
  assert.strictEqual(r.sessions.length, 2);
});

ok('checkpoint continuations add their time but not a second handoff', () => {
  // The tracker slices an open episode every 5 minutes so a crash can't lose
  // it. Without the `cont` flag, one terminal forgotten for half an hour would
  // report six handoffs and flatter the score it is meant to expose.
  store.append({ id: 'c', start: at(11), end: at(11, 5), state: 'waiting', title: 'c', kind: 'claude' });
  store.append({ id: 'c', start: at(11, 5), end: at(11, 10), state: 'waiting', title: 'c', kind: 'claude', cont: true });
  const r = store.rollup(DAY);
  const c = r.sessions.find((s) => s.id === 'c');
  assert.strictEqual(c.waiting, 10 * 60 * 1000);
  assert.strictEqual(c.handoffs, 1);
});

ok('an episode running across midnight is clipped into both days', () => {
  // Filed by its START day, so yesterday's file is where it lives — and today's
  // rollup has to find it there or the first hours of every morning vanish.
  const prev = new Date(2026, 7, 15, 23, 30).getTime();
  const next = new Date(2026, 7, 16, 0, 30).getTime();
  store.append({ id: 'n', start: prev, end: next, state: 'waiting', title: 'night', kind: 'claude' });
  assert.strictEqual(store.rollup('2026-08-15').waiting, 30 * 60 * 1000);
  const today = store.rollup(DAY);
  const n = today.sessions.find((s) => s.id === 'n');
  assert.strictEqual(n.waiting, 30 * 60 * 1000);
});

ok('open (in-memory) episodes can be folded into a rollup', () => {
  // What keeps "idle today" from freezing whenever nothing changes state —
  // which, on a genuinely idle day, is the whole day.
  const before = store.rollup(DAY).waiting;
  const r = store.rollup(DAY, [{ id: 'live', start: at(14), end: at(14, 5), state: 'waiting', ms: 5 * 60 * 1000 }]);
  assert.strictEqual(r.waiting, before + 5 * 60 * 1000);
});

ok('a torn line costs that line, not the day', () => {
  fs.appendFileSync(path.join(store.idleDir(), `${DAY}.jsonl`), '{"start":123,"end":\n');
  assert.ok(store.rollup(DAY).working > 0);
});

ok('days() lists what was actually recorded', () => {
  assert.deepStrictEqual(store.days(), ['2026-08-15', '2026-08-16']);
});

ok('idle is attributed per working directory', () => {
  // "Which repo am I slowest to answer?" outlives the sessions themselves,
  // which is why this groups by cwd rather than leaving it to the session list.
  const r = store.rollup(DAY);
  const p = r.projects.find((x) => x.cwd === '(unknown)');
  assert.ok(p, 'episodes with no cwd are attributed, not dropped');
  assert.ok(r.projects.every((x, i, a) => i === 0 || a[i - 1].waiting >= x.waiting), 'worst first');
});

ok('findSession digs a killed session out of the log, newest metadata winning', () => {
  // The reopen path depends on this: sessions.json forgets an entry the moment
  // the session is killed, so weeks later the episode log is the only thing
  // that still knows the cwd, the command and the conversation id.
  store.append({ id: 'z', start: at(8), end: at(8, 5), state: 'working', title: 'z',
    cwd: 'C:\\repos\\x', kind: 'claude', command: 'claude', agentSessionId: null });
  store.append({ id: 'z', start: at(8, 5), end: at(8, 9), state: 'waiting', title: 'renamed',
    cwd: 'C:\\repos\\x', kind: 'claude', command: 'claude --session-id abc', agentSessionId: 'abc' });
  const found = store.findSession('z');
  assert.strictEqual(found.title, 'renamed');
  assert.strictEqual(found.agentSessionId, 'abc');
  assert.strictEqual(found.cwd, 'C:\\repos\\x');
  assert.strictEqual(store.findSession('nope'), null);
});

console.log(`\n${passed} assertions passed`);
