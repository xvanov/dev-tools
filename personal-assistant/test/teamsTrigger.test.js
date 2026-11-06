'use strict';

// Teams in seconds, the trigger side: when a change notification turns into
// a read (debounce, max wait, no overlap, nothing dropped during a pass), the
// watcher's re-arming, the resident reader's request protocol, and the
// worker's `soon` for the fresh-DM fast path. No Teams, no Python, no store:
// timers, fs.watch and spawn are fakes.

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const t = require('../src/ingest/teamsTrigger');
const { passes } = require('../src/util/exclusive');
const readers = require('../src/ingest/teamsReader');
const { config } = require('../src/config');
const local = require('../src/ingest/teamsLocal');

// A virtual clock: setTimeout/clearTimeout that only advance on `advance`.
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = ++seq;
        timers.set(id, { at: now + Math.max(0, ms), fn });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
const flush = () => new Promise((r) => setImmediate(r));

const OPTS = { quietMs: 300, maxWaitMs: 1500 };

// ---------------------------------------------------- pure state machine --
{
  let s = t.initial();
  assert.strictEqual(t.dueAt(s, OPTS), null, 'nothing pending, nothing due');
  s = t.onEvent(s, 1000);
  assert.strictEqual(t.dueAt(s, OPTS), 1300, 'quiet period after one event');
  s = t.onEvent(s, 1200);
  assert.strictEqual(t.dueAt(s, OPTS), 1500, 'a later event pushes it back');
  assert.strictEqual(t.onTimer(s, 1400, OPTS).run, false, 'not before it is due');
  // A burst that never goes quiet is still read by first + maxWait.
  for (let at = 1300; at <= 3000; at += 100) s = t.onEvent(s, at);
  assert.strictEqual(t.dueAt(s, OPTS), 2500, 'capped at first + maxWait');
  const fired = t.onTimer(s, 2500, OPTS);
  assert.strictEqual(fired.run, true);
  s = fired.state;
  assert.strictEqual(s.running, true);
  assert.strictEqual(t.dueAt(s, OPTS), null, 'nothing pending once the pass took the burst');
  // Events during the pass are kept, and are due only after it ends.
  s = t.onEvent(s, 2600);
  assert.strictEqual(t.dueAt(s, OPTS), null, 'no second pass while one runs');
  assert.strictEqual(t.onTimer(s, 9999, OPTS).run, false);
  s = t.onDone(s);
  assert.strictEqual(t.dueAt(s, OPTS), 2900, 'the event during the pass gets its own read');
  assert.strictEqual(t.onTimer(s, 2900, OPTS).run, true);
}

// ------------------------------------------------------------ scheduler --
(async () => {
  {
    const c = clock();
    let runs = 0;
    let release = null;
    const sched = t.scheduler({
      ...OPTS,
      now: c.now,
      timers: c.timers,
      run: () => {
        runs++;
        return new Promise((r) => (release = r));
      },
    });
    // A burst of five writes 50 ms apart is one read, 300 ms after the last.
    for (let i = 0; i < 5; i++) {
      sched.poke();
      await c.advance(50);
    }
    assert.strictEqual(runs, 0);
    await c.advance(249);
    assert.strictEqual(runs, 0, 'still inside the quiet period');
    await c.advance(1);
    assert.strictEqual(runs, 1, 'one read per burst');
    // A write during the (slow) pass: no overlap, but read right after.
    sched.poke();
    await c.advance(5000);
    assert.strictEqual(runs, 1, 'never two passes at once');
    release();
    await flush();
    await c.advance(0);
    assert.strictEqual(runs, 2, 'the write during the pass was not dropped');
    release();
    await flush();
    await c.advance(5000);
    assert.strictEqual(runs, 2, 'quiet directory, no reads');
    // A failing pass does not wedge the scheduler.
    sched.poke();
    await c.advance(300);
    assert.strictEqual(runs, 3);
    sched.stop();
    sched.poke();
    await c.advance(5000);
    assert.strictEqual(runs, 3, 'stopped means stopped');
    assert.strictEqual(c.pending(), 0, 'no timer left behind');
  }
  {
    const c = clock();
    let runs = 0;
    const sched = t.scheduler({ ...OPTS, now: c.now, timers: c.timers, run: () => { runs++; throw new Error('boom'); } });
    sched.poke();
    await c.advance(300);
    sched.poke();
    await c.advance(300);
    assert.strictEqual(runs, 2, 'a pass that throws does not stop the next');
    sched.stop();
  }

  // -------------------------------------------------- relevant changes --
  assert.strictEqual(local.relevantChange('007343.log'), true);
  assert.strictEqual(local.relevantChange('007350.ldb'), true);
  assert.strictEqual(local.relevantChange(null), true, 'no filename: assume it matters');
  for (const f of ['LOG', 'LOG.old', 'LOCK', 'CURRENT', 'MANIFEST-000001']) assert.strictEqual(local.relevantChange(f), false, f);

  // ------------------------------------------- watch: arm, lose, re-arm --
  {
    // `enabled: false` makes each pass a no-op ('off'), so this exercises the
    // watcher and timers without touching Teams, Python or the store.
    const saved = { ...config.teamsCache };
    Object.assign(config.teamsCache, { enabled: false, watch: true, resident: false, debounceMs: 300, maxWaitMs: 1500, fallbackSeconds: 60, pollSeconds: 5 });
    const c = clock();
    const watchers = [];
    let failArm = false;
    const fsWatch = (dir, opts, cb) => {
      if (failArm) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      const w = new EventEmitter();
      w.cb = cb;
      w.closed = false;
      w.close = () => {
        w.closed = true;
        w.emit('close');
      };
      watchers.push(w);
      return w;
    };
    const results = [];
    const h = local.watch({ onResult: (r) => results.push(r), fsWatch, timers: c.timers, now: c.now });
    assert.strictEqual(watchers.length, 1, 'armed at start');
    await c.advance(300);
    assert.strictEqual(h.stats().passes, 1, 'one read at start for what arrived while down');
    assert.strictEqual(results[0].skipped, 'off');

    watchers[0].cb('change', 'LOG');
    await c.advance(1000);
    assert.strictEqual(h.stats().passes, 1, 'LevelDB info log ignored');
    watchers[0].cb('change', '007343.log');
    watchers[0].cb('change', '007343.log');
    await c.advance(300);
    assert.strictEqual(h.stats().passes, 2, 'a notification burst is one pass');

    // The watcher errors (directory replaced): a catch-up pass, the fast
    // poll while unarmed, and a new watcher at the next poll.
    failArm = true;
    watchers[0].emit('error', Object.assign(new Error('x'), { code: 'EPERM' }));
    assert.strictEqual(h.stats().watching, false);
    await c.advance(300);
    assert.strictEqual(h.stats().passes, 3, 'whatever the lost watcher missed is read');
    await c.advance(5000);
    assert.strictEqual(watchers.length, 1, 'arming failed, still polling');
    assert.strictEqual(h.stats().passes, 4, 'the 5 s poll runs while unarmed');
    failArm = false;
    await c.advance(5000);
    assert.strictEqual(watchers.length, 2, 're-armed at the next poll');
    assert.strictEqual(h.stats().watching, true);
    const passesNow = h.stats().passes;
    await c.advance(30_000);
    assert.strictEqual(h.stats().passes, passesNow, 'back to the slow fallback once armed');
    await c.advance(30_000);
    assert.strictEqual(h.stats().passes, passesNow + 1, 'the fallback still checks every minute');

    h.stop();
    assert.strictEqual(watchers[1].closed, true, 'stop closes the watcher');
    await c.advance(120_000);
    assert.strictEqual(c.pending(), 0, 'stop leaves no timer behind');
    Object.assign(config.teamsCache, saved);
  }

  // ------------------------------------------------- resident reader --
  {
    const children = [];
    const spawnFn = (cmd, args) => {
      assert.deepStrictEqual(args.slice(-1), ['--serve']);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.exitCode = null;
      child.kill = () => {
        child.exitCode = 1;
        child.emit('exit', 1);
      };
      child.requests = [];
      child.stdin.on('data', (d) => child.requests.push(JSON.parse(String(d))));
      children.push(child);
      return child;
    };
    const r = readers.resident({ python: 'py', script: 's.py', timeoutMs: 1000, spawnFn });
    const answer = (child, lines) => child.stdout.write(lines.map((l) => JSON.stringify(l)).join('\r\n') + '\r\n');

    let p = r.request(['--src', 'a']);
    await flush();
    assert.deepStrictEqual(children[0].requests[0], ['--src', 'a']);
    // A response may arrive in pieces; the status line ends it.
    const msgLine = JSON.stringify({ t: 'msg', id: '1' });
    children[0].stdout.write(msgLine.slice(0, 5));
    children[0].stdout.write(msgLine.slice(5) + '\r\n{"t": "status", "ms": 3}\r\n');
    const out = await p;
    assert.strictEqual(local.parseOutput(out).messages.length, 1);
    assert.strictEqual(local.parseOutput(out).status.ms, 3);

    p = r.request(['--src', 'b']);
    await flush();
    assert.strictEqual(children.length, 1, 'the second request reuses the process');
    await assert.rejects(r.request(['x']), /busy/, 'one request at a time');
    answer(children[0], [{ t: 'status', error: 'OSError' }]);
    await assert.rejects(p, /reader failed: OSError/);

    // A crash fails the open request; the next request starts a new process.
    p = r.request(['--src', 'c']);
    await flush();
    children[0].emit('exit', 3);
    await assert.rejects(p, /exited 3/);
    p = r.request(['--src', 'd']);
    await flush();
    assert.strictEqual(children.length, 2, 'restarted after a crash');
    answer(children[1], [{ t: 'status', ms: 1 }]);
    await p;
    assert.deepStrictEqual(r.stats(), { spawns: 2, alive: true });
    r.close();
    assert.strictEqual(r.stats().alive, false);
  }
  {
    // A hung reader is killed at the timeout and replaced on the next request.
    const children = [];
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 1;
        child.emit('exit', 1);
      };
      children.push(child);
      return child;
    };
    const r = readers.resident({ python: 'py', script: 's.py', timeoutMs: 20, spawnFn });
    await assert.rejects(r.request([]), /timed out/);
    assert.strictEqual(children[0].killed, true);
    const p = r.request([]);
    await flush();
    assert.strictEqual(children.length, 2);
    children[1].stdout.write('{"t": "status"}\n');
    await p;
    r.close();
  }

  // ------------------------------------------------ exclusive and soon --
  {
    const errors = [];
    const ps = passes({ onError: (name, err) => errors.push(`${name}:${err.message}`) });
    const log = [];
    let release;
    const slow = () => new Promise((r) => (release = r)).then(() => log.push('scheduled'));
    const first = ps.run('distill', slow);
    assert.strictEqual(await ps.run('distill', () => log.push('skipped')), false, 'run skips a busy pass');
    // Two fresh DMs during the scheduled pass: one follow-up, both told.
    const a = ps.soon('distill', () => log.push('fresh-1'));
    const b = ps.soon('distill', () => log.push('fresh-2'));
    await flush();
    assert.deepStrictEqual(log, [], 'nothing overlaps the running pass');
    release();
    assert.strictEqual(await first, true);
    assert.deepStrictEqual(await Promise.all([a, b]), [true, true]);
    assert.deepStrictEqual(log, ['scheduled', 'fresh-2'], 'one follow-up, the newest');
    assert.strictEqual(await ps.soon('distill', () => log.push('idle')), true, 'idle: runs now');
    assert.strictEqual(log.at(-1), 'idle');
    assert.strictEqual(await ps.run('x', () => { throw new Error('bad'); }), true);
    assert.deepStrictEqual(errors, ['x:bad']);
    assert.strictEqual(ps.isRunning('distill'), false);
  }

  console.log('teamsTrigger ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
