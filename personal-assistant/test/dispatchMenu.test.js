'use strict';

// A Plan card's ☰ build settings menu (src/dashboard/dispatchMenu.client.js,
// D30): its pure half — the card's one summary line, the menu's rows, the POST
// body a change sends, the optimistic copy drawn before the server answers —
// and the round trip the menu makes, GET and POST
// /api/commitments/<id>/build-settings through the dashboard's handler on a
// throwaway SQLite store (PA_DB=sqlite; skips without the driver).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../src/dashboard/dispatchMenu.client.js');

// What GET answers (src/build/index.ts forCard).
const fresh = () => ({
  card: 1, settings: { model: 'sonnet', costCapUsd: 5, wallCapMin: 120 }, overrides: {},
  options: { models: ['haiku', 'sonnet', 'opus'], defaults: { model: 'sonnet', costCapUsd: 5, wallCapMin: 120 } },
});

{
  const s = fresh();
  assert.strictEqual(M.summary(s), 'sonnet · $5 · 2 h');
  assert.strictEqual(M.summary(null), 'build settings…');
  assert.strictEqual(M.summary({ settings: { model: 'haiku', costCapUsd: 0.5, wallCapMin: 45 } }), 'haiku · $0.5 · 45 min');
  const rows = Object.fromEntries(M.rows(s).map((r) => [r.field, r]));
  assert.deepStrictEqual(Object.keys(rows), ['model', 'costCapUsd', 'wallCapMin']);
  assert.deepStrictEqual(rows.model.options.map((o) => o.value), ['', 'haiku', 'sonnet', 'opus']);
  assert.strictEqual(rows.model.options[0].label, 'default (sonnet)');
  assert.strictEqual(rows.costCapUsd.badge, 'default');

  assert.deepStrictEqual(M.patchFor(s, 'model', 'opus'), { model: 'opus' });
  assert.deepStrictEqual(M.patchFor(s, 'costCapUsd', '2.5'), { costCapUsd: 2.5 });
  assert.deepStrictEqual(M.patchFor(s, 'wallCapMin', ''), { wallCapMin: null }, 'empty resets');
  const drawn = M.optimistic(s, { model: 'opus', costCapUsd: 2 });
  assert.deepStrictEqual([drawn.settings.model, drawn.settings.costCapUsd, drawn.overrides], ['opus', 2, { model: 'opus', costCapUsd: 2 }]);
  assert.strictEqual(M.rows(drawn)[0].badge, 'set on this card');
  const back = M.optimistic(drawn, { model: null });
  assert.deepStrictEqual([back.settings.model, back.overrides], ['sonnet', { costCapUsd: 2 }]);
  assert.deepStrictEqual(s.overrides, {}, 'the cached copy is not mutated');
}

// ---- the round trip the menu makes --------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-dispatch-menu-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_dispatch_menu.sqlite');
process.env.PA_SQLITE_KEY = 'dispatch-menu-test-key';
process.env.PA_WORKTREES_ROOT = dir;
delete process.env.PA_BUILD_COST_CAP_USD;
delete process.env.PA_BUILD_WALL_CAP_MIN;

const { available } = require('../src/db/sqlite.ts');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP dispatchMenu round trip: no SQLite driver');
  }
  const db = require('../src/db');
  const server = require('../src/dashboard/server.ts');
  const call = (method, url, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const { Readable } = require('stream');
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    Object.assign(req, { method, url, headers: { host: '127.0.0.1:7300', ...headers } });
    const res = {
      status: 0, headers: {}, body: '', headersSent: false,
      writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true; },
      end(b) { this.body = String(b || ''); resolve(this); },
    };
    server.handle(req, res).catch(reject);
  });
  const json = (r) => JSON.parse(r.body);
  try {
    assert.strictEqual(db.dialect, 'sqlite');
    await require('../src/db/migrate.ts').migrate();
    const seed = require('./contract/_seed').postgres(require('./contract/_pgish').pgish(db.sqliteBackend()));
    const id = await seed.commitment({ summary: 'Fix the flaky export test' });
    const url = `/api/commitments/${id}/build-settings`;
    const X = { 'x-pa': '1' };

    const first = json(await call('GET', url));
    assert.deepStrictEqual([first.card, first.settings, first.overrides], [id, { model: 'sonnet', costCapUsd: 5, wallCapMin: 120 }, {}]);
    assert.deepStrictEqual(first.options.models, ['haiku', 'sonnet', 'opus']);

    const set = json(await call('POST', url, { headers: X, body: M.patchFor(first, 'model', 'haiku') }));
    assert.deepStrictEqual([set.settings.model, set.overrides], ['haiku', { model: 'haiku' }]);
    json(await call('POST', url, { headers: X, body: { costCapUsd: 1.5, wallCapMin: 30 } }));
    const all = json(await call('GET', url));
    assert.deepStrictEqual(all.settings, { model: 'haiku', costCapUsd: 1.5, wallCapMin: 30 }, 'stored: the next open shows the same');
    assert.strictEqual(M.summary(all), 'haiku · $1.5 · 30 min');
    const reset = json(await call('POST', url, { headers: X, body: M.patchFor(all, 'model', '') }));
    assert.deepStrictEqual([reset.settings.model, reset.overrides], ['sonnet', { costCapUsd: 1.5, wallCapMin: 30 }]);

    // What the menu reverts on: a bad value, an unknown card, a POST without X-PA.
    const bad = await call('POST', url, { headers: X, body: { model: 'gpt' } });
    assert.strictEqual(bad.status, 400);
    assert.match(json(bad).error, /model must be/);
    assert.strictEqual((await call('POST', url, { headers: X, body: { costCapUsd: -1 } })).status, 400);
    assert.strictEqual((await call('POST', '/api/commitments/999999/build-settings', { headers: X, body: { model: 'opus' } })).status, 404);
    assert.strictEqual((await call('POST', url, { body: { model: 'opus' } })).status, 403, 'X-PA on every POST');
    assert.deepStrictEqual(json(await call('GET', url)).overrides, reset.overrides, 'nothing refused was stored');

    const js = await call('GET', '/dispatchMenu.js');
    assert.strictEqual(js.status, 200);
    assert.doesNotMatch(js.body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no HTML sink');
    const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.html'), 'utf8');
    assert.match(page, /<script src="dispatchMenu\.js"><\/script>/);
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('dispatch menu ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
