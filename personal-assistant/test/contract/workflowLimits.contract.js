'use strict';

// Contract: src/repo/workflowLimits.js (see test/repoContract.test.js).

module.exports = {
  'all: every override, ceilings as numbers, ordered by workflow': async ({ repos, assert, uniq }) => {
    const a = uniq('wf-a');
    const b = uniq('wf-b');
    await repos.workflowLimits.set(b, 1.5);
    await repos.workflowLimits.set(a, 0);
    const got = (await repos.workflowLimits.all()).filter((r) => r.workflow === a || r.workflow === b);
    assert.deepStrictEqual(got.map((r) => [r.workflow, r.max_usd]), [[a, 0], [b, 1.5]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
    assert.strictEqual(typeof got[0].max_usd, 'number');
  },

  'set: inserts, then replaces; a negative ceiling is refused': async ({ repos, assert, uniq }) => {
    const w = uniq('wf');
    await repos.workflowLimits.set(w, 2);
    await repos.workflowLimits.set(w, 3.25);
    const rows = (await repos.workflowLimits.all()).filter((r) => r.workflow === w);
    assert.deepStrictEqual(rows.map((r) => r.max_usd), [3.25]);
    await assert.rejects(() => repos.workflowLimits.set(w, -1));
  },

  'reset: removes the override and only that one': async ({ repos, assert, uniq }) => {
    const w = uniq('wf');
    const keep = uniq('wf-keep');
    await repos.workflowLimits.set(w, 2);
    await repos.workflowLimits.set(keep, 4);
    await repos.workflowLimits.reset(w);
    await repos.workflowLimits.reset(uniq('wf-none'));
    const names = (await repos.workflowLimits.all()).map((r) => r.workflow);
    assert.ok(!names.includes(w) && names.includes(keep));
  },
};
