'use strict';

// Aggregate: audit (plan 4.3). The hash-chained log of the policy engine's
// decisions (sql/037_audit_log.sql). Append-only: there is no update or delete
// method, and `verify` is how a hand edit of the table shows.
//
// Each row's hash is sha256 over a canonical JSON of its fields and the
// previous row's hash (GENESIS for the first). `append` takes the chain's tail
// and writes the next row in one transaction under an advisory lock, so
// concurrent writers (two worker generations, the MCP server, the CLI) extend
// one chain. Phase 3 (SQLite, one writer) replaces the lock with BEGIN IMMEDIATE.

const crypto = require('crypto');

const GENESIS = '0'.repeat(64);
const LOCK_KEY = 917400; // advisory lock key, apart from the leases' 7300 and the contract's 9173xx
const FIELDS = ['at', 'channel', 'actor', 'action', 'tool', 'decision', 'rule', 'reason', 'subject', 'args_hash'];
const COLS = ['seq', ...FIELDS, 'prev_hash', 'hash'];

const iso = (v) => new Date(v).toISOString();
const clip = (v, n) => String(v ?? '').slice(0, n);

/** Pure. The hash of an entry's fields chained to `prev`. */
function hashEntry(e, prev) {
  const canon = JSON.stringify([...FIELDS.map((f) => (f === 'at' ? iso(e.at) : String(e[f] ?? ''))), prev]);
  return crypto.createHash('sha256').update(canon).digest('hex');
}

function create(db) {
  const row = (r) => ({ ...r, seq: Number(r.seq), at: iso(r.at) });
  return {
    /**
     * Writes the next entry of the chain and resolves it (with seq, prev_hash,
     * hash). entry: {channel, tool, decision, action?, actor?, rule?, reason?,
     * subject?, argsHash?, at?}.
     */
    async append(entry) {
      const e = {
        at: entry.at ? new Date(entry.at) : new Date(),
        channel: clip(entry.channel, 40),
        actor: clip(entry.actor, 80),
        action: clip(entry.action || 'call', 40),
        tool: clip(entry.tool, 120),
        decision: entry.decision,
        rule: clip(entry.rule, 80),
        reason: clip(entry.reason, 300),
        subject: clip(entry.subject, 200),
        args_hash: clip(entry.argsHash, 64),
      };
      const write = async (q) => {
        await q.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
        const { rows } = await q.query('select hash from audit_log order by seq desc limit 1');
        const prev = rows[0] ? rows[0].hash : GENESIS;
        const hash = hashEntry(e, prev);
        const ins = await q.query(
          `insert into audit_log (${FIELDS.join(', ')}, prev_hash, hash)
           values (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')}, $${FIELDS.length + 1}, $${FIELDS.length + 2})
           returning ${COLS.join(', ')}`,
          [...FIELDS.map((f) => e[f]), prev, hash]
        );
        return row(ins.rows[0]);
      };
      return db.inTx ? write(db) : db.withTx(write);
    },

    /** The newest `limit` entries, newest first (optionally only for `tool` or `decision`). */
    async recent({ limit = 20, tool = null, decision = null } = {}) {
      const rows = await db.rows(
        `select ${COLS.join(', ')} from audit_log
          where ($1::text is null or tool = $1) and ($2::text is null or decision = $2)
          order by seq desc limit $3`,
        [tool, decision, Math.min(Math.max(limit | 0, 1), 500)]
      );
      return rows.map(row);
    },

    /**
     * Walks the whole chain in order and recomputes every hash. Resolves
     * {ok, count, head} or, at the first bad row, {ok: false, count, head,
     * brokenAt: {seq, reason}}. `head` is the last good hash.
     */
    async verify() {
      const rows = await db.rows(`select ${COLS.join(', ')} from audit_log order by seq asc`);
      let prev = GENESIS;
      let n = 0;
      for (const r of rows) {
        if (r.prev_hash !== prev) return { ok: false, count: n, head: prev, brokenAt: { seq: Number(r.seq), reason: 'prev_hash does not match the row before it (a row was removed or reordered)' } };
        if (hashEntry(r, prev) !== r.hash) return { ok: false, count: n, head: prev, brokenAt: { seq: Number(r.seq), reason: "hash does not match the row's contents (the row was edited)" } };
        prev = r.hash;
        n++;
      }
      return { ok: true, count: n, head: prev };
    },
  };
}

module.exports = { create, hashEntry, GENESIS };
