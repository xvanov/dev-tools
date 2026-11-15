'use strict';

// Aggregate: turns. Table: turn_log (one row per thing said to Jarvis: the
// words, the fast lane's route and probabilities, what it said, and the PA
// chat's answer). Callers: src/chat/turnLog.ts. Times are ISO text the app
// writes and flags are 0/1, so the SQL is the same on Postgres and SQLite and
// src/repo/sqlite/turns.ts re-exports this file.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

const CHANNELS = ['voice', 'typed', 'doorbell'];
const COLUMNS = [
  'context', 'history', 'router', 'route', 'p', 'signals', 'reason', 'overridden', 'fell_back', 'decision_ms',
  'fast_say', 'fast_model', 'first_token_ms', 'fast_ms', 'handed_off', 'handoff_error',
  'reply', 'tools', 'reply_ms', 'chat_turns', 'chat_cost_usd', 'status', 'error', 'ended_at',
];

type Filter = { limit?: number; before?: number | string | null; channel?: string | null; route?: string | null; q?: string | null; since?: string | null };

function create(db: Db) {
  return {
    /** A new open turn: the row. `set` may carry any settable column. */
    async insert(v: { channel: string; text: string; at?: string; set?: Record<string, unknown> }): Promise<Row> {
      if (!CHANNELS.includes(v.channel)) throw new Error(`channel must be one of ${CHANNELS.join(', ')}`);
      const set = v.set || {};
      const keys = Object.keys(set);
      const bad = keys.filter((k) => !COLUMNS.includes(k));
      if (bad.length) throw new Error(`no settable column: ${bad.join(', ')}`);
      const cols = ['at', 'channel', 'text', ...keys];
      const vals = [v.at || new Date().toISOString(), v.channel, v.text, ...keys.map((k) => set[k])];
      const r = await db.query(`insert into turn_log (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, vals);
      return r.rows[0] as Row;
    },

    /** Sets the named columns of a turn (unknown names are refused). Rows changed. */
    async update(id: number | string, set: Record<string, unknown>): Promise<number> {
      const keys = Object.keys(set);
      const bad = keys.filter((k) => !COLUMNS.includes(k));
      if (bad.length || !keys.length) throw new Error(`no settable column: ${bad.join(', ') || '(none given)'}`);
      const r = await db.query(`update turn_log set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => set[k])]);
      return r.rowCount || 0;
    },

    /** One turn, or null. */
    async byId(id: number | string): Promise<Row | null> {
      return db.one('select * from turn_log where id = $1', [id]);
    },

    /** Newest first. `before` pages by id; `q` matches the words or either answer, any case. */
    async list({ limit = 50, before = null, channel = null, route = null, q = null, since = null }: Filter = {}): Promise<Row[]> {
      const where: string[] = [];
      const args: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        args.push(v);
        where.push(sql.replace('?', `$${args.length}`));
      };
      if (before != null) add('id < ?', before);
      if (channel) add('channel = ?', channel);
      if (route) add('route = ?', route);
      if (since) add('at >= ?', since);
      if (q) {
        args.push(`%${String(q).toLowerCase()}%`);
        const n = `$${args.length}`;
        where.push(`(lower(text) like ${n} or lower(coalesce(fast_say, '')) like ${n} or lower(coalesce(reply, '')) like ${n})`);
      }
      args.push(Math.min(Math.max(1, Number(limit) || 50), 1000));
      return db.rows(`select * from turn_log${where.length ? ` where ${where.join(' and ')}` : ''} order by id desc limit $${args.length}`, args);
    },

    /** Turns still open that started before `at` (a chat that never answered). */
    async openBefore(at: string): Promise<Row[]> {
      return db.rows(`select * from turn_log where status = 'open' and at < $1 order by id`, [at]);
    },

    /** Deletes turns older than `at`. Rows deleted. */
    async prune(at: string): Promise<number> {
      const r = await db.query('delete from turn_log where at < $1', [at]);
      return r.rowCount || 0;
    },
  };
}

module.exports = { create, CHANNELS, COLUMNS };
