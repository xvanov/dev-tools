'use strict';

// `pa version`: which source answers, and what is printed for each. The
// dashboard and git are injected; nothing here opens a socket or spawns git.

const assert = require('assert');
const V = require('../src/cli/version');
const { HELP, commands } = require('../src/cli');

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE = 'http://127.0.0.1:7801';

function deps({ dashboard, git }) {
  const calls = { dashboard: [], git: 0 };
  return {
    calls,
    paBase: BASE,
    async getJson(url) {
      calls.dashboard.push(url);
      if (dashboard instanceof Error) throw dashboard;
      return dashboard;
    },
    async gitShortHead() {
      calls.git += 1;
      if (git instanceof Error) throw git;
      return git;
    },
  };
}

(async () => {
  // The body of GET /api/version, read.
  assert.strictEqual(V.parseVersionBody({ commit: SHA }), SHA);
  assert.strictEqual(V.parseVersionBody({ commit: `  ${SHA}\n` }), SHA);
  assert.strictEqual(V.parseVersionBody({}), null);
  assert.strictEqual(V.parseVersionBody(null), null);
  assert.strictEqual(V.parseVersionBody({ commit: 42 }), null);
  assert.strictEqual(V.parseVersionBody({ commit: '' }), null);

  // Dashboard answers: its commit, git never asked.
  {
    const d = deps({ dashboard: { commit: SHA }, git: 'deadbee' });
    const r = await V.getVersion(d);
    assert.deepStrictEqual(r, { commit: SHA, source: 'dashboard', url: `${BASE}/api/version` });
    assert.deepStrictEqual(d.calls.dashboard, [`${BASE}/api/version`]);
    assert.strictEqual(d.calls.git, 0);
    const line = V.formatVersion(r);
    assert.ok(line.includes(SHA), line);
    assert.ok(/dashboard/.test(line) && !/local/.test(line), line);
  }

  // Dashboard down: the checkout's short hash, with the reason kept.
  {
    const d = deps({ dashboard: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }), git: 'deadbee' });
    const r = await V.getVersion(d);
    assert.strictEqual(r.commit, 'deadbee');
    assert.strictEqual(r.source, 'local');
    assert.match(r.reason, /fetch failed/);
    assert.strictEqual(d.calls.git, 1);
    const line = V.formatVersion(r);
    assert.ok(line.includes('deadbee'), line);
    assert.ok(/local checkout/.test(line) && !/\(dashboard/.test(line), line);
  }

  // Dashboard answers something that is not a version: treated as not answering.
  {
    const d = deps({ dashboard: { ready: true }, git: 'deadbee' });
    const r = await V.getVersion(d);
    assert.strictEqual(r.source, 'local');
    assert.strictEqual(r.commit, 'deadbee');
    assert.match(r.reason, /no commit/);
  }

  // Both fail: one error naming both causes, not a traceback.
  {
    const d = deps({ dashboard: new Error('fetch failed'), git: new Error('not a git repository') });
    await assert.rejects(V.getVersion(d), (err) => /fetch failed/.test(err.message) && /not a git repository/.test(err.message));
  }
  {
    const d = deps({ dashboard: new Error('fetch failed'), git: '' });
    await assert.rejects(V.getVersion(d), /git rev-parse/);
  }

  // Wired into `pa`: a verb, and listed in the help.
  assert.strictEqual(typeof commands.version, 'function');
  assert.match(HELP, /pa version\s/);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
