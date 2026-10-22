'use strict';

// The Routines tab: its script parses and has no HTML sink, saving needs an
// explicit confirmation, and its POSTs are behind the same X-PA guard as the
// rest of the dashboard (they run actions on this machine).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { route } = require('../src/dashboard/routines');

(async () => {
  const client = fs.readFileSync(path.join(__dirname, '../src/dashboard/routines.client.js'), 'utf8');
  new vm.Script(client, { filename: 'routines.client.js' });
  assert.ok(!/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/.test(client), 'no HTML sinks in the routines tab');
  // It must say, in words, that a routine changes the machine.
  assert.match(client, /Action — will run git in your repos/);

  const html = fs.readFileSync(path.join(__dirname, '../src/dashboard/index.html'), 'utf8');
  assert.match(html, /<script src="\/routines\.js"><\/script>/);
  assert.match(html, /id="tab-routines"/);
  assert.match(html, /Routines are actions/);

  const u = (p) => new URL(p, 'http://127.0.0.1');
  // Preview validates and saves nothing (no database needed).
  const p = await route('POST', u('/api/routines/preview'), { title: 'Pull', schedule: '0 8 * * 1-5', action: 'repo_sync', params: {} });
  assert.match(p.plain, /^Weekdays 08:00 — Pull main/);
  assert.strictEqual(p.nextRuns.length, 3);
  await assert.rejects(route('POST', u('/api/routines/preview'), { title: 'x', schedule: '0 8 * * *', action: 'run_shell' }), /unknown action/);
  // Saving without the confirmation flag is refused before anything is written.
  await assert.rejects(route('POST', u('/api/routines'), { title: 'x', schedule: '0 8 * * *', action: 'repo_sync' }), /not confirmed/);
  assert.strictEqual(await route('POST', u('/api/routines/1/explode'), {}), undefined);
  assert.strictEqual(await route('PUT', u('/api/routines'), {}), undefined);

  // The guard, end to end on a throwaway port.
  const server = await require('../src/dashboard/server').start({ port: 0 });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/routines/1/run`, { method: 'POST', body: '{}' });
    assert.strictEqual(res.status, 403);
    const js = await fetch(`http://127.0.0.1:${port}/routines.js`);
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  } finally {
    server.close();
  }

  console.log('routinesui ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
