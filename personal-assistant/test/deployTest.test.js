'use strict';

// The deploy test (src/e2e/deployTest.js, plan Z6) in spare mode: a real
// supervisor rolls twice on a free port while requests, an event stream and a
// terminal run through it; nothing may fail, be lost or drop. Plus its
// verdict on made-up observations. No Postgres; the terminal needs termhub's
// node_modules and is skipped (said so) without them.

const assert = require('assert');
const { run, judge, parseArgs } = require('../src/e2e/deployTest');

// ---- the verdict ----
{
  const fine = { requests: { ok: 500, failures: [] }, events: { received: [1, 2, 3], resyncs: 0, failures: [] }, produced: 3, terminal: { closed: false, missingCount: 0, missing: [] } };
  assert.deepStrictEqual(judge(fine), []);
  const bad = judge({
    requests: { ok: 500, failures: [{ at: '00:00:01.000', error: 'socket hang up' }] },
    events: { received: [1, 3, 3], resyncs: 1, failures: [] },
    produced: 4,
    terminal: { closed: true, missingCount: 2, missing: [7, 8] },
  });
  assert.strictEqual(bad.length, 7, bad.join('\n')); // the duplicate also breaks the order
  assert.match(bad.join('\n'), /1 failed request/);
  assert.match(bad.join('\n'), /2 event\(s\) never arrived: 2, 4/);
  assert.match(bad.join('\n'), /arrived twice: 3/);
  assert.match(bad.join('\n'), /resync/);
  assert.match(bad.join('\n'), /socket dropped/);
  assert.match(bad.join('\n'), /tick\(s\) missing: 7, 8/);
  assert.deepStrictEqual(parseArgs(['--live', '--deploy', '--', '--from', 'HEAD~1']).deployArgs, ['--from', 'HEAD~1']);
}

// ---- the real thing, on a spare supervisor ----
run(['--rolls', '2'], { log: () => {} }).then(
  (r) => {
    assert.deepStrictEqual(r.problems, [], JSON.stringify(r, null, 2));
    assert.strictEqual(r.rolls.length, 2);
    assert.ok(r.events.connects >= 3, `the stream should have moved twice: ${r.events.connects} connections`);
    console.log(`deployTest ok: ${r.requests.ok} requests, ${r.events.received}/${r.events.produced} events over ${r.events.connects} connections, terminal ${r.terminal ? `ticks ${r.terminal.first}..${r.terminal.last}` : 'skipped'}`);
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
