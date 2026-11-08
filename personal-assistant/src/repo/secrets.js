'use strict';

// Aggregate: secrets. Table: secret_request (a value or a sign-in the PA asked
// a human for, and when each was set). Never a secret value: those live in the
// OS vault or the gitignored .env (src/secrets). Callers: src/secrets.

function create(db) {
  return {
    /**
     * Fulfils every pending request for `name`, stored in `target`. Resolves
     * the ids fulfilled ([] when none was open).
     */
    async fulfilPendingByName(name, target) {
      return db.rows(
        `update secret_request set status = 'fulfilled', fulfilled_at = now(), stored_in = $2
      where name = $1 and status = 'pending' returning id`,
        [name, target]
      );
    },

    /** Records a value set with no request open (so `pa secret list` can say when). */
    async recordSetDirectly(name, requestedBy, target) {
      await db.query(
        `insert into secret_request (kind, name, purpose, requested_by, target, status, fulfilled_at, stored_in)
       values ('secret', $1, 'set directly', $2, $3, 'fulfilled', now(), $3)`,
        [name, requestedBy, target]
      );
    },

    /** One request, or null. */
    async byId(id) {
      return db.one('select * from secret_request where id = $1', [id]);
    },

    /** One request's kind ({kind}), or null. */
    async kindOf(id) {
      return db.one('select kind from secret_request where id = $1', [id]);
    },

    /**
     * Settles a pending request: `status` declined | fulfilled (fulfilled
     * stamps fulfilled_at). Resolves {id, name, status}, or null when it was
     * not pending.
     */
    async settle(id, status) {
      return db.one(
        `update secret_request set status = $2, fulfilled_at = case when $2 = 'fulfilled' then now() end
      where id = $1 and status = 'pending' returning id, name, status`,
        [id, status]
      );
    },

    /** Fulfils a pending login request by its key (no value is stored). */
    async fulfilPendingLogin(key) {
      await db.query(
        `update secret_request set status = 'fulfilled', fulfilled_at = now() where name = $1 and status = 'pending'`,
        [key]
      );
    },

    /** The pending request for `name`, or null. */
    async pendingByName(name) {
      return db.one(`select * from secret_request where name = $1 and status = 'pending'`, [name]);
    },

    /** The pending request's id for `name` ({id}), or null. */
    async pendingIdByName(name) {
      return db.one(`select id from secret_request where name = $1 and status = 'pending'`, [name]);
    },

    /**
     * Opens a request; null when one for that name is already pending (a
     * race lost to another process). Values are stored as given.
     */
    async open({ kind, name, purpose, hint, url, command, requestedBy, target }) {
      return db.one(
        `insert into secret_request (kind, name, purpose, hint, url, command, requested_by, target)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (name) where status = 'pending' do nothing
     returning *`,
        [kind, name, purpose, hint, url, command, requestedBy, target]
      );
    },

    /** Every pending request, oldest first. */
    async pending() {
      return db.rows(`select * from secret_request where status = 'pending' order by created_at`);
    },

    /** Expires one request (its value turned up without it). */
    async expire(id) {
      await db.query(`update secret_request set status = 'expired', fulfilled_at = now() where id = $1`, [id]);
    },

    /** The newest time each secret was set, and where: [{name, fulfilled_at, stored_in}]. */
    async lastSet() {
      return db.rows(
        `select distinct on (name) name, fulfilled_at, stored_in from secret_request
        where kind = 'secret' and fulfilled_at is not null and stored_in is not null
        order by name, fulfilled_at desc`
      );
    },
  };
}

module.exports = { create };
