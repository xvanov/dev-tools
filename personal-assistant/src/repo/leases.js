'use strict';

// Aggregate: leases. No table: session advisory locks (plan Z2,
// src/util/lease.js). They belong to the connection that takes them, so this
// aggregate is used on a backend over one dedicated connection
// (createRepos(clientBackend(client))), never on the pool. Phase 3 (SQLite,
// one process per stack) replaces them with a lease row; the contract cases
// say what must still hold.

function create(db) {
  const ok = async (sql, params) => {
    const { rows } = await db.query(sql, params);
    return Boolean(rows[0] && rows[0].ok);
  };
  return {
    /** Takes the one-key lock `key` if free. Resolves whether this connection now holds it. */
    tryLock: (key) => ok('select pg_try_advisory_lock($1) as ok', [key]),

    /** Lets go of the one-key lock `key` (held by this connection). */
    async unlock(key) {
      await db.query('select pg_advisory_unlock($1)', [key]);
    },

    /** Takes the lock for pass `name` in key space `space` if free. Resolves whether it did. */
    tryPassLock: (space, name) => ok('select pg_try_advisory_lock($1, hashtext($2)) as ok', [space, name]),

    /** Lets go of the lock for pass `name` in `space`. */
    async passUnlock(space, name) {
      await db.query('select pg_advisory_unlock($1, hashtext($2))', [space, name]);
    },
  };
}

module.exports = { create };
