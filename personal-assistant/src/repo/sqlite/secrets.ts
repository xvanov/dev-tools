'use strict';

// SQLite twin of src/repo/secrets.js (secret_request; never a secret value).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { NOW } = require('./_sql');

function create(db: Db) {
  return {
    /** Fulfils every pending request for `name`, stored in `target`. Resolves [{id}]. */
    async fulfilPendingByName(name: string, target: unknown) {
      return db.rows(
        `update secret_request set status = 'fulfilled', fulfilled_at = ${NOW}, stored_in = $2
      where name = $1 and status = 'pending' returning id`,
        [name, target]
      );
    },

    /** Records a value set with no request open. */
    async recordSetDirectly(name: string, requestedBy: unknown, target: unknown) {
      await db.query(
        `insert into secret_request (kind, name, purpose, requested_by, target, status, fulfilled_at, stored_in)
       values ('secret', $1, 'set directly', $2, $3, 'fulfilled', ${NOW}, $3)`,
        [name, requestedBy, target]
      );
    },

    /** One request, or null. */
    async byId(id: number | string) {
      return db.one('select * from secret_request where id = $1', [id]);
    },

    /** One request's kind ({kind}), or null. */
    async kindOf(id: number | string) {
      return db.one('select kind from secret_request where id = $1', [id]);
    },

    /** Settles a pending request (declined | fulfilled). Resolves {id, name, status}, or null. */
    async settle(id: number | string, status: string) {
      return db.one(
        `update secret_request set status = $2, fulfilled_at = case when $2 = 'fulfilled' then ${NOW} end
      where id = $1 and status = 'pending' returning id, name, status`,
        [id, status]
      );
    },

    /** Fulfils a pending login request by its key. */
    async fulfilPendingLogin(key: number | string) {
      await db.query(`update secret_request set status = 'fulfilled', fulfilled_at = ${NOW} where name = $1 and status = 'pending'`, [key]);
    },

    /** The pending request for `name`, or null. */
    async pendingByName(name: string) {
      return db.one(`select * from secret_request where name = $1 and status = 'pending'`, [name]);
    },

    /** The pending request's id for `name` ({id}), or null. */
    async pendingIdByName(name: string) {
      return db.one(`select id from secret_request where name = $1 and status = 'pending'`, [name]);
    },

    /** Opens a request; null when one for that name is already pending. */
    async open({ kind, name, purpose, hint, url, command, requestedBy, target }: { kind?: string | null; name?: string | null; purpose?: string | null; hint?: unknown; url?: string | null; command?: unknown; requestedBy?: unknown; target?: unknown }) {
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
      return db.rows(`select * from secret_request where status = 'pending' order by created_at, id`);
    },

    /** Expires one request. */
    async expire(id: number | string) {
      await db.query(`update secret_request set status = 'expired', fulfilled_at = ${NOW} where id = $1`, [id]);
    },

    /** The newest time each secret was set, and where (pg's distinct on: newest per name). */
    async lastSet() {
      const rows = await db.rows(
        `select name, fulfilled_at, stored_in from (
           select name, fulfilled_at, stored_in,
                  row_number() over (partition by name order by fulfilled_at desc, id desc) as rn
             from secret_request
            where kind = 'secret' and fulfilled_at is not null and stored_in is not null)
          where rn = 1 order by name`
      );
      return rows.map((r) => ({ ...r, fulfilled_at: r.fulfilled_at == null ? null : new Date(r.fulfilled_at as string) }));
    },
  };
}

module.exports = { create };
