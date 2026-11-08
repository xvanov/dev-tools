'use strict';

// SQLite twin of src/repo/leases.js: advisory locks as rows of `lease`
// (sql-sqlite/003). A lock belongs to the session that took it (pool.connect(),
// as a pg advisory lock belongs to its connection); releasing the session
// drops its rows, and a row whose session is gone (released, or its process
// died) is free for the next taker. Re-entrant with a depth, as pg's are.

const { holderGone } = require('../../db/sqlite');

function create(db) {
  const holder = () => {
    if (!db.session) throw new Error('leases need a session (pool.connect()), not the pool');
    return db.session.id;
  };

  /** Takes (space, name) for this session if free, held by it, or held by a holder that is gone. */
  async function take(space, name) {
    const me = holder();
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await db.one(
        `insert into lease (space, name, holder) values ($1, $2, $3)
         on conflict (space, name) do update set depth = depth + 1 where lease.holder = excluded.holder
         returning holder`,
        [space, name, me]
      );
      if (got) return true;
      const cur = await db.one('select holder from lease where space = $1 and name = $2', [space, name]);
      if (!cur) continue; // let go between the two statements
      if (!holderGone(cur.holder)) return false;
      await db.query('delete from lease where holder = $1', [cur.holder]); // all of a dead holder's locks
    }
    return false;
  }

  async function drop(space, name) {
    const me = holder();
    await db.query('update lease set depth = depth - 1 where space = $1 and name = $2 and holder = $3', [space, name, me]);
    await db.query('delete from lease where space = $1 and name = $2 and holder = $3 and depth <= 0', [space, name, me]);
  }

  return {
    /** Takes the one-key lock `key` if free. Resolves whether this session now holds it. */
    tryLock: (key) => take('lock', String(key)),

    /** Lets go of the one-key lock `key` (held by this session). */
    unlock: (key) => drop('lock', String(key)),

    /** Takes the lock for pass `name` in key space `space` if free. Resolves whether it did. */
    tryPassLock: (space, name) => take(`pass:${space}`, String(name)),

    /** Lets go of the lock for pass `name` in `space`. */
    passUnlock: (space, name) => drop(`pass:${space}`, String(name)),
  };
}

module.exports = { create };
