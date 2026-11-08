'use strict';

// `pa version`: the pure part (which answer wins, what gets printed). The
// network and git calls are injected, so these tests run with neither a dashboard
// nor a git repository.

const test = require('node:test');
const assert = require('node:assert');

const { dashboardCommit, gitCommit, resolveVersion, formatVersion } = require('../src/cli/version.ts');

test('dashboardCommit takes the commit field of a dashboard answer', () => {
  assert.strictEqual(dashboardCommit({ commit: 'abc1234def' }), 'abc1234def');
  assert.strictEqual(dashboardCommit({ commit: '' }), null);
  assert.strictEqual(dashboardCommit({ commit: 42 }), null);
  assert.strictEqual(dashboardCommit({}), null);
  assert.strictEqual(dashboardCommit(null), null);
  assert.strictEqual(dashboardCommit('abc1234'), null);
});

test('gitCommit accepts only a short hex hash from git rev-parse', () => {
  assert.strictEqual(gitCommit('abc1234\n'), 'abc1234');
  assert.strictEqual(gitCommit('  0e45cc4 \n'), '0e45cc4');
  assert.strictEqual(gitCommit(''), null);
  assert.strictEqual(gitCommit('\n'), null);
  assert.strictEqual(gitCommit('HEAD'), null);
  assert.strictEqual(gitCommit('fatal: not a git repository'), null);
});

test('resolveVersion uses the dashboard and never runs git when the dashboard answers', async () => {
  let gitCalls = 0;
  const r = await resolveVersion({
    fetchDashboard: async () => ({ commit: 'abc1234def' }),
    gitHead: async () => { gitCalls++; return 'fff0000'; },
  });
  assert.deepStrictEqual(r, { commit: 'abc1234def', source: 'dashboard' });
  assert.strictEqual(gitCalls, 0);
});

test('resolveVersion falls back to the checkout when the dashboard gives no commit', async () => {
  for (const down of [null, {}, async () => { throw new Error('ECONNREFUSED'); }]) {
    const fetchDashboard = typeof down === 'function' ? down : async () => down;
    const r = await resolveVersion({ fetchDashboard, gitHead: async () => '0e45cc4\n' });
    assert.deepStrictEqual(r, { commit: '0e45cc4', source: 'checkout' });
  }
});

test('resolveVersion returns null when the dashboard is down and git yields nothing', async () => {
  const r = await resolveVersion({
    fetchDashboard: async () => null,
    gitHead: async () => { throw new Error('not a git repository'); },
  });
  assert.strictEqual(r, null);
});

test('formatVersion names the source for both dashboard and checkout', () => {
  const fromDashboard = formatVersion({ commit: 'abc1234', source: 'dashboard' });
  const fromCheckout = formatVersion({ commit: 'abc1234', source: 'checkout' });
  assert.match(fromDashboard, /abc1234/);
  assert.match(fromDashboard, /source: dashboard/);
  assert.match(fromCheckout, /abc1234/);
  assert.match(fromCheckout, /source: local checkout/);
});
