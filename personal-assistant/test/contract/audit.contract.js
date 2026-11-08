'use strict';

// Contract: src/repo/audit.js (see test/repoContract.test.js). The chain is
// append-only and tamper-evident. Tamper cases run inside a transaction they
// roll back, so the table stays valid for the cases that follow.

const ROLLBACK = new Error('rollback');

async function tampered(db, assert, change, expectReason) {
  const { createRepos, clientBackend } = require('../../src/repo');
  await db.withTx(async (client) => {
    await change(client);
    const r = await createRepos(clientBackend(client)).audit.verify();
    assert.strictEqual(r.ok, false, 'verify must notice the change');
    assert.match(r.brokenAt.reason, expectReason);
    throw ROLLBACK;
  }).then(() => assert.fail('unreachable'), (err) => { if (err !== ROLLBACK) throw err; });
}

const entry = (tool, decision = 'allow', extra = {}) => ({ channel: 'mcp', tool, decision, rule: 'r', ...extra });

module.exports = {
  'append: each row stores the hash of the one before it': async ({ repos, assert, uniq }) => {
    const a = await repos.audit.append(entry(uniq('t')));
    const b = await repos.audit.append(entry(uniq('t'), 'ask', { channel: 'chat', action: 'call', subject: 'job-1' }));
    assert.strictEqual(b.prev_hash, a.hash);
    assert.notStrictEqual(a.hash, b.hash);
    assert.match(a.hash, /^[0-9a-f]{64}$/);
    assert.ok(b.seq > a.seq);
    assert.strictEqual(b.subject, 'job-1');
  },

  'append: concurrent writers extend one chain': async ({ repos, assert, uniq }) => {
    const tool = uniq('conc');
    await Promise.all(Array.from({ length: 8 }, () => repos.audit.append(entry(tool))));
    const rows = await repos.audit.recent({ tool, limit: 20 });
    assert.strictEqual(rows.length, 8);
    assert.strictEqual(new Set(rows.map((r) => r.prev_hash)).size, 8, 'no two rows share a predecessor');
    assert.strictEqual((await repos.audit.verify()).ok, true);
  },

  'append: refuses a decision that is not allow, deny or ask': async ({ repos, assert }) => {
    await assert.rejects(() => repos.audit.append(entry('x', 'maybe')));
  },

  'recent: newest first, filtered by tool and decision': async ({ repos, assert, uniq }) => {
    const tool = uniq('rec');
    await repos.audit.append(entry(tool, 'allow'));
    await repos.audit.append(entry(tool, 'deny', { reason: 'no' }));
    const all = await repos.audit.recent({ tool });
    assert.deepStrictEqual(all.map((r) => r.decision), ['deny', 'allow']);
    const denied = await repos.audit.recent({ tool, decision: 'deny' });
    assert.strictEqual(denied.length, 1);
    assert.strictEqual(denied[0].reason, 'no');
    assert.strictEqual((await repos.audit.recent({ limit: 1 })).length, 1);
  },

  'verify: an intact chain is ok, with its length and head': async ({ repos, assert, uniq }) => {
    const last = await repos.audit.append(entry(uniq('v')));
    const r = await repos.audit.verify();
    assert.strictEqual(r.ok, true);
    assert.ok(r.count >= 1);
    assert.strictEqual(r.head, last.hash);
  },

  'verify: an edited row is found': async ({ repos, db, assert, uniq }) => {
    const tool = uniq('edit');
    await repos.audit.append(entry(tool, 'deny'));
    const mid = await repos.audit.append(entry(tool, 'deny'));
    await repos.audit.append(entry(tool, 'deny'));
    await tampered(db, assert, (c) => c.query(`update audit_log set decision = 'allow' where seq = $1`, [mid.seq]), /edited/);
  },

  'verify: a removed row is found': async ({ repos, db, assert, uniq }) => {
    const tool = uniq('del');
    await repos.audit.append(entry(tool));
    const mid = await repos.audit.append(entry(tool));
    await repos.audit.append(entry(tool));
    await tampered(db, assert, (c) => c.query('delete from audit_log where seq = $1', [mid.seq]), /removed or reordered/);
  },

  'verify: a re-chained edit (hash recomputed, later rows left) is still found': async ({ repos, db, assert, uniq }) => {
    const { hashEntry } = require('../../src/repo/audit');
    const tool = uniq('rechain');
    const first = await repos.audit.append(entry(tool, 'deny'));
    await repos.audit.append(entry(tool, 'deny'));
    await tampered(db, assert, async (c) => {
      const forged = { ...first, decision: 'allow' };
      await c.query('update audit_log set decision = $2, hash = $3 where seq = $1', [first.seq, 'allow', hashEntry(forged, first.prev_hash)]);
    }, /removed or reordered/);
  },
};
