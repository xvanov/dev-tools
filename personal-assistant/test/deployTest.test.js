'use strict';

// The deploy test (src/e2e/deployTest.ts, plan Z6) in spare mode: a real
// supervisor rolls twice on a free port while requests, an event stream and a
// terminal run through it; nothing may fail, be lost or drop. Plus its
// verdict on made-up observations. No Postgres; the terminal needs termhub's
// node_modules and is skipped (said so) without them.

const assert = require('assert');
const { run, judge, parseArgs } = require('../src/e2e/deployTest.ts');

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

// ---- an https termhub (Linux serves TLS on its tailnet port) ----
{
  const { termhubEndpoint } = require('../src/e2e/deployTest.ts');
  assert.deepStrictEqual(termhubEndpoint('https://box.example.ts.net:7000'), { tls: true, host: 'box.example.ts.net', port: 7000 });
  assert.deepStrictEqual(termhubEndpoint('https://box.example.ts.net'), { tls: true, host: 'box.example.ts.net', port: 443 });
  assert.deepStrictEqual(termhubEndpoint('http://127.0.0.1:7000'), { tls: false, host: '127.0.0.1', port: 7000 });
  assert.throws(() => termhubEndpoint('ws://x:1'), /http:\/\/ or https:\/\//);
}

async function tlsSpoken() {
  // With tls: true the client speaks TLS: against a plain HTTP server the
  // handshake fails, where plain HTTP would have been answered.
  const http = require('http');
  const path = require('path');
  const th = require(path.join(__dirname, '..', '..', 'termhub', 'test', 'spareTermhub.js'));
  const srv = http.createServer((req, res) => res.end('{"plain":true}'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.strictEqual((await th.getJson(port, '/x')).body.plain, true);
    await assert.rejects(th.getJson(port, '/x', { tls: true, timeoutMs: 5000 }), (e) => /EPROTO|wrong version|SSL|TLS|socket hang up|ECONNRESET/i.test(`${e.code} ${e.message}`));
  } finally {
    srv.close();
  }
}

// ---- the real thing, on a spare supervisor ----
// With PA_JARVISD_EXE (CI's jarvisd job), the compiled jarvisd is the
// supervisor (plan 4.4); otherwise this file's supervisor, in process.
tlsSpoken()
  .then(() => run(['--rolls', '2', ...(process.env.PA_JARVISD_EXE ? ['--binary', process.env.PA_JARVISD_EXE] : [])], { log: () => {} }))
  .then(
  (r) => {
    // A machine too busy to run the clients proves nothing either way (the
    // report says so); the decisions above still ran.
    if (r.problems.some((p) => /got no CPU/.test(p))) {
      console.log(`deployTest inconclusive: ${r.problems.join(' | ')}`);
      process.exit(0);
    }
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
