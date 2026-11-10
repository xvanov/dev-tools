'use strict';

// The Build page's Repos section (dashboard/factoryApps.ts, factory.apps.client.js):
// the edit form checked into `factory app set` argv, the add form, the list rows,
// and the routes against a stubbed factory. Names are invented.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const calls = [];
let appsList = [];
let forgot = 0;
let answer = () => ({});
stub('dispatch/factory.ts', {
  enabled: () => true,
  async apps(opts) { calls.push({ apps: opts }); return appsList; },
  async call(argv) { calls.push({ argv }); return answer(argv); },
  async addApp(input) { calls.push({ add: input }); return { app: 'docs', repo: input.repo, suggested_gates: { test_command: { command: 'none', requires: [], source: 'docs-only repo' } } }; },
  async forgetApps() { forgot++; },
});

const A = require('../src/dashboard/factoryApps.ts');

// --- the edit form as argv: one argv element per value, no shell ------------------------

{
  const argv = A.setArgv('docs', {
    delivery: 'pr',
    pipeline: 'solo',
    gates: { test: 'lychee --offline "knowledge/**/*.md"', lint: 'NONE', format_check: '', type_check: 'none' },
    requires: { test: ['lychee'], lint: 'docker, docker' },
  });
  assert.deepStrictEqual(argv, [
    'app', 'set', 'docs', '--json',
    '--delivery-default=pr', '--pipeline-default=solo',
    '--gate=test=lychee --offline "knowledge/**/*.md"', '--gate=lint=none', '--gate=format_check=', '--gate=type_check=none',
    '--requires=test=lychee', '--requires=lint=docker',
  ]);
  assert.deepStrictEqual(A.setArgv('docs', { gates: { test: '-rf /' } }).slice(-1), ['--gate=test=-rf /'], 'a leading dash stays inside the one --gate= element');
  const is400 = (re) => (e) => e.status === 400 && re.test(e.message);
  assert.throws(() => A.setArgv('docs', {}), is400(/nothing to change/));
  assert.throws(() => A.setArgv('../x', { pipeline: 'solo' }), is400(/not an app name/));
  assert.throws(() => A.setArgv('docs', { gates: { deploy: 'x' } }), is400(/unknown gate/));
  assert.throws(() => A.setArgv('docs', { gates: { test: 'a\nb' } }), is400(/one line/));
  assert.throws(() => A.setArgv('docs', { gates: { test: 'x'.repeat(2001) } }), is400(/2000/));
  assert.throws(() => A.setArgv('docs', { requires: { test: ['rm -rf'] } }), is400(/not a program name/));
  assert.throws(() => A.setArgv('docs', { delivery: 'yolo' }), is400(/unknown delivery/));
  assert.throws(() => A.setArgv('docs', { pipeline: 'swarm' }), is400(/pipeline/));
  // "worked on automatically" (raven, 2026-11-09)
  assert.deepStrictEqual(A.setArgv('docs', { serveTick: true }), ['app', 'set', 'docs', '--json', '--serve-tick=on']);
  assert.deepStrictEqual(A.setArgv('docs', { serveTick: false }).slice(-1), ['--serve-tick=off']);
  assert.throws(() => A.setArgv('docs', { serveTick: 'yes' }), is400(/serveTick/));
}

// --- the add form --------------------------------------------------------------------------

{
  // A repo added here is worked on automatically unless the box is unticked.
  assert.deepStrictEqual(A.addInput({ repo: ' https://github.com/innergy-dev/raven.git ', path: 'C:\\repos\\raven' }),
    { repo: 'innergy-dev/raven', path: 'C:\\repos\\raven', deliveryDefault: null, serveTick: true });
  assert.strictEqual(A.addInput({ repo: 'a/b', serveTick: false }).serveTick, false);
  assert.throws(() => A.addInput({ repo: 'raven' }), /owner\/name/);
  assert.throws(() => A.addInput({ repo: 'a/b', path: 'x\ny' }), /one local path/);
  assert.throws(() => A.addInput({ repo: 'a/b', delivery: 'yolo' }), /unknown delivery/);
}

// --- list rows: the factory's readiness, an old factory's row, a broken config ----------------

{
  const r = A.row({ app: 'docs', repo: 'acme/docs', path: '/r', delivery: { default: 'draft_pr' }, pipeline_default: 'chain', ticked: false,
    gates: { test: { state: 'none' } }, readiness: { status: 'missing_tool', blocking: 'gate test needs lychee, not on PATH', warnings: [], missing_tools: { test: ['lychee'] } } });
  assert.deepStrictEqual([r.delivery, r.pipeline, r.readiness.status, r.readiness.missingTools], ['draft_pr', 'chain', 'missing_tool', { test: ['lychee'] }]);
  assert.strictEqual(A.row({ app: 'old', repo: 'a/old', delivery: { default: 'pr' } }).readiness, null, 'an older factory: readiness unknown, not "configured"');
  assert.strictEqual(A.row({ app: 'old', repo: 'a/old' }).serveTick, null, 'an older factory: unknown, not "no"');
  assert.strictEqual(A.row({ app: 'r', repo: 'a/r', serve_tick: true }).serveTick, true);
  assert.deepStrictEqual(A.row({ app: 'bad', error: 'ValueError: x' }), { app: 'bad', error: 'ValueError: x' });
}

// --- the page: section, script, no HTML sink -----------------------------------------------

{
  // The Build page (D30) no longer loads the repos section; the client stays, frozen with the factory.
  const client = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'factory.apps.client.js'), 'utf8');
  assert.doesNotMatch(client, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no HTML sink: repo and CI text');
  assert.doesNotMatch(client, /fetch\('\//, 'relative URLs only');
}

// --- the routes, through factory.ts ---------------------------------------------------------

(async () => {
  const P = require('../src/dashboard/factory.ts');
  const call = async (method, pathname, { body = null, headers = {} } = {}) => {
    const out = { status: 0, body: null };
    const req = { method, headers };
    const ctx = {
      send(_res, status, b) { out.status = status; out.body = b; },
      async readJson() { return body || {}; },
      issuePageToken: () => 't',
      pageTokenOk: () => false,
    };
    try {
      const handled = await P.route(req, {}, new URL(`http://127.0.0.1${pathname}`), ctx);
      if (!handled) out.status = 'unhandled';
    } catch (err) {
      out.status = err.status || 500;
      out.body = { error: err.message };
    }
    return out;
  };

  appsList = [{ app: 'docs', repo: 'acme/docs', delivery: { default: 'draft_pr' }, pipeline_default: 'chain', readiness: { status: 'not_configured', blocking: 'x', warnings: [] } }];
  let r = await call('GET', '/api/factory/apps');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.apps.map((a) => [a.app, a.readiness.status]), [['docs', 'not_configured']]);
  assert.deepStrictEqual(calls.pop(), { apps: { stale: true } }, 'the list answers from the cache: no factory call per page load');
  assert.ok(r.body.deliveries.some((d) => d.value === 'draft_pr'));
  await call('GET', '/api/factory/apps?fresh=1');
  assert.deepStrictEqual(calls.pop(), { apps: { fresh: true } });

  answer = () => ({ app: 'docs', suggested_gates: {} });
  r = await call('GET', '/api/factory/apps/docs');
  assert.deepStrictEqual(calls.pop(), { argv: ['app', 'show', 'docs', '--json'] });
  assert.strictEqual((await call('GET', '/api/factory/apps/..%2Fetc')).status, 400);

  // POSTs: X-PA first, then the form.
  assert.strictEqual((await call('POST', '/api/factory/apps/docs', { body: { pipeline: 'solo' } })).status, 403);
  answer = (argv) => ({ app: 'docs', changed: ['gates.test_command'], readiness: { status: 'configured' }, argv });
  r = await call('POST', '/api/factory/apps/docs', { headers: { 'x-pa': '1' }, body: { gates: { test: 'none' } } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(calls.pop(), { argv: ['app', 'set', 'docs', '--json', '--gate=test=none'] });
  assert.strictEqual(forgot, 1, 'the cached list is dropped after an edit');
  assert.strictEqual((await call('POST', '/api/factory/apps/docs', { headers: { 'x-pa': '1' }, body: { gates: { test: 'a\nb' } } })).status, 400);

  const F = require('../src/dispatch/factoryCore.ts');
  answer = () => { throw new F.FactoryError('invalid_gate', 'unknown gate'); };
  r = await call('POST', '/api/factory/apps/docs', { headers: { 'x-pa': '1' }, body: { gates: { test: 'x' } } });
  assert.strictEqual(r.status, 400, 'the factory\'s refusal is the user\'s 400, not a 500');
  assert.match(r.body.error, /invalid_gate/);

  r = await call('POST', '/api/factory/apps', { headers: { 'x-pa': '1' }, body: { repo: 'acme/docs' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(calls.pop(), { add: { repo: 'acme/docs', path: null, deliveryDefault: null, serveTick: true } });
  assert.strictEqual(r.body.suggested_gates.test_command.command, 'none');
  assert.strictEqual((await call('POST', '/api/factory/apps', { headers: { 'x-pa': '1' }, body: { repo: 'nope' } })).status, 400);

  console.log('factoryApps: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
