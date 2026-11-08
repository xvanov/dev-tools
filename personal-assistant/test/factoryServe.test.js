'use strict';

// factory serve's localhost API (plan 2.1): the PA asks it first when the
// factory is on this machine, and spawns the CLI only when nothing ran.

const assert = require('assert');
const http = require('http');

process.env.PA_FACTORY_PATH = process.env.PA_FACTORY_PATH || '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
const factory = require('../src/dispatch/factory');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  // Served: the CLI's own {code, stdout, stderr}, guard header sent, argv as-is.
  let seen = null;
  const ok = await serve((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen = { url: req.url, guard: req.headers['x-factory'], body: JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, stdout: '{"jobs": []}\n', stderr: '', ms: 40 }));
    });
  });
  const url = `http://127.0.0.1:${ok.address().port}`;
  const r = await factory.viaServe(['job', 'list', '--json'], 5000, url);
  assert.deepStrictEqual(r, { code: 0, stdout: '{"jobs": []}\n', stderr: '' });
  assert.deepStrictEqual(seen, { url: '/api/cli', guard: '1', body: { argv: ['job', 'list', '--json'] } });

  // A verb serve does not run (400): the caller spawns the CLI.
  const no = await serve((req, res) => { req.resume(); req.on('end', () => { res.writeHead(400); res.end('{}'); }); });
  assert.strictEqual(await factory.viaServe(['job', 'follow', 'a:1'], 5000, `http://127.0.0.1:${no.address().port}`), null);

  // Nothing listening: nothing ran, spawn.
  const port = no.address().port;
  await new Promise((done) => no.close(done));
  assert.strictEqual(await factory.viaServe(['job', 'submit', '--json'], 5000, `http://127.0.0.1:${port}`), null);

  // Sent, then no answer: never re-run (it may have run); reads like a timeout.
  const hang = await serve(() => {});
  const t = await factory.viaServe(['job', 'submit', '--json'], 300, `http://127.0.0.1:${hang.address().port}`);
  assert.strictEqual(t.code, 124);
  assert.ok(t.timedOut);

  // Disabled: no URL, spawn.
  assert.strictEqual(await factory.viaServe(['job', 'list'], 1000, ''), null);

  ok.close();
  hang.closeAllConnections?.();
  hang.close();
  console.log('factoryServe ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
