'use strict';

// A Plan card's ☰ dispatch settings menu (src/dashboard/dispatchMenu.client.js,
// plan 8.6.4): its pure half — the card's one summary line, the menu's rows
// with where each value came from, the POST body a select sends, the
// optimistic copy drawn before the server answers — and then the round trip
// the menu makes, GET and POST /api/commitments/<id>/dispatch-settings through
// the dashboard's handler on a throwaway SQLite store (PA_DB=sqlite; skips
// without the driver). The factory's app list is seeded in the store, so no
// factory command runs. Names are invented.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../src/dashboard/dispatchMenu.client.js');

// A GET answer as the server shapes it (src/dispatch/settings.ts forCard).
const options = {
  runtimes: ['api', 'claude_session'],
  modes: ['plan', 'local', 'branch', 'mr', 'full'],
  deliveries: ['none', 'branch', 'draft_pr', 'pr', 'auto_merge', 'push_to_main'].map((value) => ({ value, plain: `plain ${value}` })),
  jobKinds: ['code', 'research', 'report', 'plan'],
  apps: [{ app: 'widget', repo: 'acme/widget', deliveryDefault: 'pr' }, { app: 'docs', repo: 'acme/docs', deliveryDefault: null }],
};
const fresh = () => ({
  card: 7, factory: true,
  settings: { runtime: 'claude_session', mode: 'full', delivery: 'draft_pr', jobKind: 'code', app: 'widget', repo: 'acme/widget' },
  source: { runtime: 'default', mode: 'default', delivery: 'app_default', jobKind: 'inferred', app: 'repo', repo: 'commitment' },
  why: { jobKind: 'the ask names a change', delivery: "factory app widget's delivery.default" },
  overrides: {},
  options,
});

// ---- the card's line --------------------------------------------------------

assert.strictEqual(M.summary(fresh()), 'Claude · full · draft PR · code (auto)');
assert.strictEqual(M.summary(null), 'dispatch settings…', 'before the background fetch lands');
{
  const r = fresh();
  Object.assign(r.settings, { jobKind: 'research', delivery: 'none', runtime: 'api' });
  r.source.jobKind = 'card';
  assert.strictEqual(M.summary(r), 'API · full · report · research', 'a research job reports; a chosen kind is not "auto"');
}

// ---- the menu's rows ---------------------------------------------------------

{
  const s = fresh();
  const d = M.rememberDefaults(null, s);
  const rows = M.rows(s, d);
  assert.deepStrictEqual(rows.map((r) => r.field), ['runtime', 'mode', 'jobKind', 'delivery', 'app']);
  const by = Object.fromEntries(rows.map((r) => [r.field, r]));
  assert.ok(rows.every((r) => r.value === '' && !r.overridden), 'nothing set on the card: every select is on its default');
  assert.strictEqual(by.jobKind.options[0].label, 'auto: code — the ask names a change', 'the kind\'s default says what was inferred and why');
  assert.strictEqual(by.jobKind.badge, 'inferred');
  assert.strictEqual(by.delivery.badge, "the app's default");
  assert.match(by.delivery.options.find((o) => o.value === 'pr').label, /^PR — plain pr$/, 'end states show their plain words');
  assert.strictEqual(by.app.options[0].label, 'default: widget (acme/widget)');
  assert.strictEqual(by.runtime.options[0].label, 'default: Claude session (subscription)');
}

// ---- a change: its POST body, and what is drawn before the answer ------------

{
  const s = fresh();
  const d = M.rememberDefaults(null, s);
  assert.deepStrictEqual(M.patchFor(s, 'runtime', 'api'), { runtime: 'api' });
  assert.deepStrictEqual(M.patchFor(s, 'delivery', ''), { delivery: null }, 'the default option resets');
  assert.deepStrictEqual(M.patchFor(s, 'app', 'docs'), { app: 'docs', repo: 'acme/docs' }, 'an app carries its repo');
  assert.deepStrictEqual(M.patchFor(s, 'app', ''), { app: null, repo: null });

  const research = M.optimistic(s, { jobKind: 'research' }, d);
  assert.deepStrictEqual([research.settings.jobKind, research.settings.delivery, research.source.delivery], ['research', 'none', 'kind']);
  const rows = Object.fromEntries(M.rows(research, d).map((r) => [r.field, r]));
  assert.ok(rows.jobKind.overridden && rows.jobKind.badge === 'set on this card');
  assert.ok(rows.delivery.disabled, 'a report job has no end state to pick');
  assert.strictEqual(rows.jobKind.options[0].label, 'auto: code — the ask names a change', 'the default is still named once overridden');

  const back = M.optimistic(research, { jobKind: null }, d);
  assert.deepStrictEqual([back.settings.jobKind, back.source.jobKind, back.settings.delivery, back.source.delivery],
    ['code', 'inferred', 'draft_pr', 'app_default'], 'reset goes back to the remembered default');
  assert.strictEqual(s.overrides.jobKind, undefined, 'the cached copy is not mutated: a failed POST puts it back as it was');

  const plan = M.optimistic(s, { mode: 'plan' }, d);
  assert.deepStrictEqual([plan.settings.jobKind, plan.settings.delivery], ['plan', 'none'], 'plan mode is a plan job');
  assert.strictEqual(M.badge(plan, 'jobKind'), 'plan mode');
}

// ---- the round trip the menu makes --------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-dispatch-menu-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_dispatch_menu.sqlite');
process.env.PA_SQLITE_KEY = 'dispatch-menu-test-key';
process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
process.env.PA_WORKTREES_ROOT = dir;
delete process.env.PA_FACTORY_RUNTIME;
delete process.env.PA_DISPATCH_MODE;

const { available } = require('../src/db/sqlite.ts');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP dispatchMenu round trip: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  require('../src/dispatch/factory.ts')._setRunner(async (machine, argv) => {
    throw new Error(`unexpected factory call ${argv.join(' ')}`);
  });
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
    await repo.system.setSetting('factory.apps', { at: new Date().toISOString(), apps: [
      { app: 'widget', repo: 'acme/widget', delivery: { default: 'pr' } },
      { app: 'docs', repo: 'acme/docs', delivery: { default: null } },
    ] });
    const seed = require('./contract/_seed').postgres(require('./contract/_pgish').pgish(db.sqliteBackend()));
    const id = await seed.commitment({ summary: 'Fix the flaky export test' });
    const url = `/api/commitments/${id}/dispatch-settings`;
    const X = { 'x-pa': '1' };

    // What the menu reads when it opens: the defaults and the options.
    const first = json(await call('GET', url));
    assert.deepStrictEqual([first.card, first.settings.runtime, first.settings.mode, first.settings.jobKind, first.source.jobKind],
      [id, 'claude_session', 'full', 'code', 'inferred']);
    assert.deepStrictEqual(first.overrides, {});
    assert.deepStrictEqual(first.options.apps.map((a) => a.app), ['widget', 'docs']);
    let defaults = M.rememberDefaults(null, first);

    // Picking an app (as the select sends it): stored, and its end state follows.
    const picked = await call('POST', url, { headers: X, body: M.patchFor(first, 'app', 'widget') });
    assert.strictEqual(picked.status, 200);
    const withApp = json(picked);
    assert.deepStrictEqual([withApp.settings.app, withApp.settings.repo, withApp.settings.delivery, withApp.source.delivery],
      ['widget', 'acme/widget', 'pr', 'app_default']);
    assert.deepStrictEqual(withApp.overrides, { app: 'widget', repo: 'acme/widget' });
    assert.strictEqual(M.summary(withApp), 'Claude · full · PR · code (auto)');
    defaults = M.rememberDefaults(defaults, withApp);

    // A runtime and a kind on the card; the answer is what a fresh GET says.
    json(await call('POST', url, { headers: X, body: M.patchFor(withApp, 'runtime', 'api') }));
    const research = json(await call('POST', url, { headers: X, body: { jobKind: 'research' } }));
    assert.deepStrictEqual(json(await call('GET', url)), research, 'stored: the next open shows the same');
    assert.deepStrictEqual([research.source.runtime, research.source.jobKind, research.settings.delivery], ['card', 'card', 'none']);
    assert.strictEqual(M.summary(research), 'API · full · report · research');
    // The optimistic copy the menu drew matched what the server stored.
    const drawn = M.optimistic(withApp, { runtime: 'api', jobKind: 'research' }, defaults);
    assert.deepStrictEqual(drawn.settings, research.settings);

    // Reset (the default option, or the row's reset button): cleared, back to the default.
    const reset = json(await call('POST', url, { headers: X, body: M.patchFor(research, 'jobKind', '') }));
    assert.deepStrictEqual([reset.settings.jobKind, reset.source.jobKind, reset.settings.delivery], ['code', 'inferred', 'pr']);
    assert.deepStrictEqual(reset.overrides, { runtime: 'api', app: 'widget', repo: 'acme/widget' });

    // What the menu reverts on: a bad value, an unknown card, a POST without X-PA.
    const bad = await call('POST', url, { headers: X, body: { runtime: 'gpu' } });
    assert.strictEqual(bad.status, 400);
    assert.match(json(bad).error, /unknown runtime/);
    assert.strictEqual((await call('POST', url, { headers: X, body: { colour: 'red' } })).status, 400);
    assert.strictEqual((await call('GET', '/api/commitments/999999/dispatch-settings')).status, 404);
    assert.strictEqual((await call('POST', '/api/commitments/999999/dispatch-settings', { headers: X, body: { runtime: 'api' } })).status, 404);
    assert.strictEqual((await call('POST', url, { body: { runtime: 'claude_session' } })).status, 403, 'X-PA on every POST');
    assert.deepStrictEqual(json(await call('GET', url)).overrides, reset.overrides, 'nothing refused was stored');

    // The page loads the menu's script, and nothing reads /api/machines any more.
    const js = await call('GET', '/dispatchMenu.js');
    assert.strictEqual(js.status, 200);
    assert.doesNotMatch(js.body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no HTML sink');
    const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.html'), 'utf8');
    assert.match(page, /<script src="dispatchMenu\.js"><\/script>/);
    assert.doesNotMatch(page, /api\/machines|routePick|machinePick|kindPick|factoryOnly/, 'the inline pickers are gone');
    assert.strictEqual((await call('GET', '/api/machines')).status, 404);
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
