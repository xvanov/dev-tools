'use strict';

// Workflow cost ceilings: architecture.json's defaults, the user's overrides,
// the guarded POST, and the override-then-reset round trip (an in-memory repo;
// the real one is covered by test/contract/workflowLimits.contract.js).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const wl = require('../src/dashboard/workflowLimits.ts');
const arch = require('../src/dashboard/architecture.ts').load();

const defaults = wl.defaults(arch);
assert.deepStrictEqual(Object.keys(defaults).sort(), ['deepseek-pr', 'research', 'review-fix', 'teams-ask', 'whats-on'], 'phone is out of scope: no ceiling');
assert.strictEqual(defaults['deepseek-pr'], 2);

// effective = override ?? default (a 0 override is an override)
{
  const e = wl.effective(arch, [{ workflow: 'deepseek-pr', max_usd: '0' }, { workflow: 'gone', max_usd: 9 }]);
  assert.deepStrictEqual(e['deepseek-pr'], { default: 2, override: 0, effective: 0, custom: true });
  assert.deepStrictEqual(e.research, { default: 0, override: null, effective: 0, custom: false });
  assert.ok(!('gone' in e) && !('phone' in e));
}

// validation
{
  assert.ok(wl.parseChange(arch, { workflow: 'phone', max_usd: 1 }).error, 'phone has no ceiling');
  assert.ok(wl.parseChange(arch, { workflow: 'nope', max_usd: 1 }).error);
  assert.ok(wl.parseChange(arch, { workflow: 'research', max_usd: -1 }).error);
  assert.ok(wl.parseChange(arch, { workflow: 'research', max_usd: '1' }).error, 'a string is not a number');
  assert.ok(wl.parseChange(arch, { workflow: 'research', max_usd: NaN }).error);
  assert.ok(wl.parseChange(arch, { workflow: 'research', max_usd: wl.MAX_USD + 1 }).error);
  assert.ok(wl.parseChange(arch, { workflow: 'research' }).error, 'missing max_usd is not a reset');
  assert.deepStrictEqual(wl.parseChange(arch, { workflow: 'research', max_usd: null }), { workflow: 'research', max_usd: null });
  assert.deepStrictEqual(wl.parseChange(arch, { workflow: 'research', max_usd: 1.23456 }), { workflow: 'research', max_usd: 1.2346 });
}

function fakeRepo() {
  const rows = new Map();
  return {
    rows,
    workflowLimits: {
      async all() { return [...rows].map(([workflow, max_usd]) => ({ workflow, max_usd })); },
      async set(w, n) { rows.set(w, n); },
      async reset(w) { rows.delete(w); },
    },
  };
}

(async () => {
  const repo = fakeRepo();
  const call = async (method, headers, body, pathname = '/api/workflow-limits') => {
    const out = {};
    const send = (res, status, b) => { out.status = status; out.body = b; };
    const handled = await wl.route({ method, headers }, {}, new URL(pathname, 'http://localhost'), { send, readJson: async () => body, repo, arch });
    return { handled, ...out };
  };

  assert.strictEqual((await call('GET', {}, null, '/api/other')).handled, false, 'other paths are not ours');
  let r = await call('GET', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.limits['deepseek-pr'].custom, false);

  // guarded: no X-PA, no write
  r = await call('POST', {}, { workflow: 'deepseek-pr', max_usd: 5 });
  assert.strictEqual(r.status, 403);
  r = await call('POST', { 'x-pa': '0' }, { workflow: 'deepseek-pr', max_usd: 5 });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(repo.rows.size, 0, 'a refused POST wrote nothing');

  // bad input
  r = await call('POST', { 'x-pa': '1' }, { workflow: 'deepseek-pr', max_usd: -3 });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(repo.rows.size, 0);
  assert.strictEqual((await call('PUT', {}, {})).status, 405);

  // override, read back, reset
  r = await call('POST', { 'x-pa': '1' }, { workflow: 'deepseek-pr', max_usd: 5 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.limits['deepseek-pr'], { default: 2, override: 5, effective: 5, custom: true });
  r = await call('GET', {});
  assert.strictEqual(r.body.limits['deepseek-pr'].effective, 5);
  assert.strictEqual(r.body.limits.research.effective, 0, 'others keep their default');
  r = await call('POST', { 'x-pa': '1' }, { workflow: 'deepseek-pr', max_usd: null });
  assert.deepStrictEqual(r.body.limits['deepseek-pr'], { default: 2, override: null, effective: 2, custom: false });
  assert.strictEqual(repo.rows.size, 0);

  // the dashboard server routes it, and its guard holds before any store is touched
  const { handle } = require('../src/dashboard/server.ts');
  const res = { writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  await handle({ method: 'POST', url: '/api/workflow-limits', headers: { host: '127.0.0.1:7300' }, on() {} }, res);
  assert.strictEqual(res.status, 403, 'server.js: POST without X-PA is refused');

  // the page script: relative URL, X-PA on the write, no HTML sink, a reset control
  const client = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'architecture.client.js'), 'utf8');
  assert.ok(client.includes("'api/workflow-limits'") && client.includes("'X-PA': '1'"));
  assert.ok(client.includes('Reset to default') && client.includes("'default'") && client.includes('custom'));
  assert.ok(!client.includes('innerHTML'));

  console.log('workflowLimits ok');
})().catch((err) => { console.error(err); process.exit(1); });
