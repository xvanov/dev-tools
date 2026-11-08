'use strict';

// `pa db export --to sqlite <file>` (plan 3.3): copies the whole Postgres
// store into a new SQLite file, for the move to SQLite (D2). Postgres is only
// read: one REPEATABLE READ, READ ONLY transaction, so every table comes from
// the same snapshot while the stack keeps running.
//
// What it copies, and how:
//   - every table both schemas have (sql/ and sql-sqlite/), column for column
//     where both have the column; ids are kept, so references hold and
//     AUTOINCREMENT continues after the highest one.
//   - values as src/db/sqlite.js stores them: timestamps as UTC ISO text,
//     jsonb and arrays as JSON, booleans 0/1, bigint and numeric as numbers.
//   - vectors as they are (D5: never re-embedded): pgvector's text form is
//     parsed back to the float32 values it holds and stored as a BLOB; a sample
//     per table is compared value for value afterwards. (Int8 quantization,
//     if ever wanted, is local arithmetic on these BLOBs, not part of this.)
//   - keyword search: the FTS5 tables fill themselves from the insert triggers.
//   - the live feed's outbox, and pa_event_seq at Postgres's value. The event
//     triggers are dropped while copying (a copied row is not a new event)
//     and recreated after.
//   - durable tasks: Absurd's queue (absurd.t_/r_/w_/c_/e_pa) into the SQLite
//     queue's tables (D19): every task with its idempotency key, state and
//     result, its committed checkpoints (same names and values), the event a
//     sleeping task waits for with its deadline, and every emitted event. A
//     task running at export time is copied as pending: it resumes from its
//     checkpoints.
// Foreign keys are off while copying (tables go in any order) and checked
// after. Then every table's row count is compared with Postgres's.
//
// Not copied: schema_migration (each store records its own files), and the
// tsvector columns (FTS5 replaces them).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** A row from either driver, read column by column (information_schema, absurd's tables, the copy). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Conn = { query(text: string, params?: unknown[]): Promise<{ rows: Json[] }> };
type PgClient = Conn & { connect(): Promise<void>; end(): Promise<void> };
/** The SQLite backend (src/db/sqlite.ts createSqliteBackend), as the export uses it. */
type Lite = Conn & {
  rows(text: string, params?: unknown[]): Promise<Json[]>;
  one(text: string, params?: unknown[]): Promise<Json | null>;
  exec(sql: string): Promise<void>;
  withTx<T>(fn: (c: Conn) => Promise<T>): Promise<T>;
  migrate(): Promise<unknown>;
  close(): Promise<void>;
};
type Log = (line: string) => void;
type Durable = { tasks: number; checkpoints: number; events: number; sqlite: { tasks: number; events: number }; ok: boolean };
type Report = {
  file: string; ok: boolean; durable: Durable | null; fk: Json[];
  tables: { table: string; pg: number | null; sqlite: number; ok: boolean; note?: string }[];
  vectors: { table: string; column: string; checked: number; ok: boolean; bad: number }[];
  missing?: string[]; fts?: { chunk_fts: number; chunk: number; ok: boolean };
};

const fs = require('fs');
const path = require('path');

const SKIP = new Set(['schema_migration', 'lease', 'pa_event_seq', 'durable_task', 'durable_checkpoint', 'durable_event']);
const BATCH = 1000;
const VECTOR_SAMPLE = 50;

/** pgvector text ('[0.1,0.2]') -> the float32 BLOB a SQLite vector column holds. */
function vectorFromText(text: string | null | undefined) {
  if (text == null) return null;
  const f = Float32Array.from(JSON.parse(text));
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/** A value read from pg (type `udt`) as SQLite stores it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convert(v: any, udt: string) {
  if (v == null) return null;
  if (udt === 'vector') return vectorFromText(v);
  if (udt === 'jsonb' || udt === 'json') return JSON.stringify(v);
  if (udt.startsWith('_')) return JSON.stringify(udt === '_int8' || udt === '_int4' ? v.map(Number) : v);
  if (udt === 'int8' || udt === 'numeric') return Number(v);
  if (udt === 'bool') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/**
 * Copies Postgres at `pgUrl` into a new SQLite file `file` (encrypted with
 * `key` when given). Resolves the report: {file, tables: [{table, pg, sqlite,
 * ok}], vectors: [{table, checked, ok}], durable, fk, ok}.
 */
async function exportToSqlite({ pgUrl, file, key = null, log = () => {} }: { pgUrl: string; file: string; key?: string | null; log?: Log }) {
  const target = path.resolve(file);
  if (fs.existsSync(target)) throw new Error(`${target} exists: export writes a new file only`);
  const { Client } = require('pg');
  const { createSqliteBackend } = require('./sqlite');

  const pg: PgClient = new Client({ connectionString: pgUrl, options: '-c default_transaction_read_only=on' });
  await pg.connect();
  const lite: Lite = createSqliteBackend(target, { key });
  const report: Report = { file: target, tables: [], vectors: [], durable: null, fk: [], ok: false };
  try {
    await pg.query('begin isolation level repeatable read read only');
    await lite.migrate();

    // The live-feed triggers are dropped while copying and recreated after.
    const triggers = await lite.rows(`select name, sql from sqlite_master where type = 'trigger' and name like 'pa_events_%'`);
    await lite.exec(`PRAGMA foreign_keys = OFF;\n${triggers.map((t) => `drop trigger ${t.name};`).join('\n')}`);

    const liteTables = (await lite.rows(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%'`))
      .map((r) => r.name)
      .filter((t) => !SKIP.has(t));
    const pgCols = await pg.query(
      `select table_name, column_name, udt_name from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`
    );
    const pkOf = await pg.query(
      `select tc.table_name, string_agg(k.column_name, ',' order by k.ordinal_position) as cols
         from information_schema.table_constraints tc
         join information_schema.key_column_usage k on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
        where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY' group by 1`
    );
    const pk: Record<string, string[]> = Object.fromEntries(pkOf.rows.map((r) => [r.table_name, r.cols.split(',')]));

    for (const table of liteTables) {
      const pcols = pgCols.rows.filter((c) => c.table_name === table);
      if (!pcols.length) {
        report.tables.push({ table, pg: null, sqlite: 0, ok: true, note: 'not in Postgres' });
        continue;
      }
      const lcols = new Set((await lite.rows(`select name from pragma_table_info('${table}')`)).map((r) => r.name));
      const cols = pcols.filter((c) => lcols.has(c.column_name) && c.udt_name !== 'tsvector');
      const sel = cols.map((c) => (c.udt_name === 'vector' ? `"${c.column_name}"::text as "${c.column_name}"` : `"${c.column_name}"`)).join(', ');
      const order = (pk[table] || [cols[0]?.column_name]).map((c) => `"${c}"`).join(', ');
      const ins = `insert into ${table} (${cols.map((c) => `"${c.column_name}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`;
      let copied = 0;
      for (let offset = 0; ; offset += BATCH) {
        const { rows } = await pg.query(`select ${sel} from public."${table}" order by ${order} limit ${BATCH} offset ${offset}`);
        if (!rows.length) break;
        await lite.withTx(async (c) => {
          for (const row of rows) await c.query(ins, cols.map((col) => convert(row[col.column_name], col.udt_name)));
        });
        copied += rows.length;
        if (rows.length < BATCH) break;
      }
      log(`${table}: ${copied}`);
    }

    // The outbox's counter continues where Postgres's sequence is.
    const seq = await pg.query(`select last_value, is_called from pa_event_seq`).catch(() => ({ rows: [] as Json[] }));
    if (seq.rows[0]) {
      const last = Number(seq.rows[0].last_value) - (seq.rows[0].is_called ? 0 : 1);
      await lite.query('update pa_event_seq set last_value = $1 where id = 1', [last]);
    }

    report.durable = await copyDurable(pg, lite, log);

    await lite.exec(triggers.map((t) => `${t.sql};`).join('\n'));
    report.fk = await lite.rows('select "table", rowid, parent from pragma_foreign_key_check');
    await lite.exec('PRAGMA foreign_keys = ON');

    // Verification: row counts per table, and vectors value for value.
    for (const table of liteTables) {
      const has = pgCols.rows.some((c) => c.table_name === table);
      if (!has) continue;
      const p = Number((await pg.query(`select count(*) as n from public."${table}"`)).rows[0]?.n);
      const s = Number((await lite.one(`select count(*) as n from ${table}`))?.n);
      report.tables.push({ table, pg: p, sqlite: s, ok: p === s });
      const vcols = pgCols.rows.filter((c) => c.table_name === table && c.udt_name === 'vector').map((c) => c.column_name);
      for (const col of vcols) {
        const keyCols = pk[table] ?? [];
        const sample = await pg.query(
          `select ${keyCols.map((k) => `"${k}"`).join(', ')}, "${col}"::text as v from public."${table}" where "${col}" is not null order by random() limit ${VECTOR_SAMPLE}`
        );
        let bad = 0;
        for (const r of sample.rows) {
          const udtOf = (k: string) => pgCols.rows.find((c) => c.table_name === table && c.column_name === k)?.udt_name;
          const got = await lite.one(`select ${col} as v from ${table} where ${keyCols.map((k, i) => `${k} = $${i + 1}`).join(' and ')}`, keyCols.map((k) => convert(r[k], udtOf(k))));
          const want = Float32Array.from(JSON.parse(r.v));
          if (!got || !got.v || got.v.length !== want.length || got.v.some((x: number, i: number) => x !== want[i])) bad++;
        }
        report.vectors.push({ table, column: col, checked: sample.rows.length, ok: bad === 0, bad });
      }
    }
    // A Postgres table with no SQLite twin would be left behind: say so (and fail).
    const pgTables = [...new Set<string>(pgCols.rows.map((c) => c.table_name))].filter((t) => t !== 'schema_migration');
    report.missing = pgTables.filter((t) => !liteTables.includes(t));
    const fts = await lite.one('select (select count(*) from chunk_fts) as fts, (select count(*) from chunk) as chunks');
    report.fts = { chunk_fts: Number(fts?.fts), chunk: Number(fts?.chunks), ok: Number(fts?.fts) === Number(fts?.chunks) };
    report.ok = !report.missing.length && report.tables.every((t) => t.ok) && report.vectors.every((v) => v.ok) && !report.fk.length && report.fts.ok && (!report.durable || report.durable.ok);
    await pg.query('rollback');
    return report;
  } finally {
    await pg.end().catch(() => {});
    await lite.close().catch(() => {});
  }
}

/** Absurd's queue `pa` -> durable_task / durable_checkpoint / durable_event (D19). */
async function copyDurable(pg: PgClient, lite: Lite, log: Log): Promise<Durable | null> {
  const has = await pg.query(`select 1 from information_schema.tables where table_schema = 'absurd' and table_name = 't_pa'`);
  if (!has.rows.length) return null;
  const tasks = (
    await pg.query(
      `select t.task_id, t.task_name, t.params, t.idempotency_key, t.max_attempts, t.attempts, t.state, t.completed_payload,
              t.enqueue_at, r.available_at, r.wake_event, r.run_id
         from absurd.t_pa t left join absurd.r_pa r on r.run_id = t.last_attempt_run
        order by t.enqueue_at, t.task_id`
    )
  ).rows;
  const ids = new Map<unknown, unknown>();
  await lite.withTx(async (c) => {
    for (const t of tasks) {
      const state = t.state === 'running' ? 'pending' : t.state;
      const waiting = state === 'sleeping' && t.wake_event ? t.wake_event : null;
      const runAt = (t.available_at || t.enqueue_at || new Date()).toISOString();
      const ins = await c.query(
        `insert into durable_task (queue, task_name, params, idempotency_key, state, run_at, wait_event, attempts, max_attempts, result, created_at)
         values ('pa', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [t.task_name, JSON.stringify(t.params ?? {}), t.idempotency_key || `absurd:${t.task_id}`, state, runAt, waiting, t.attempts || 0, t.max_attempts || 5,
          t.completed_payload == null ? null : JSON.stringify(t.completed_payload), (t.enqueue_at || new Date()).toISOString()]
      );
      ids.set(t.task_id, ins.rows[0]?.id);
    }
  });
  const cps = (await pg.query(`select task_id, checkpoint_name, state from absurd.c_pa where status = 'committed'`)).rows;
  const waits = (await pg.query(`select w.task_id, w.run_id, w.step_name, w.event_name from absurd.w_pa w`)).rows;
  await lite.withTx(async (c) => {
    for (const cp of cps) {
      const id = ids.get(cp.task_id);
      if (id) await c.query('insert into durable_checkpoint (task_id, name, value) values ($1, $2, $3)', [id, cp.checkpoint_name, JSON.stringify(cp.state ?? null)]);
    }
    // A sleeping task's event wait: its deadline is the run's available_at.
    for (const t of tasks) {
      if (t.state !== 'sleeping' || !t.wake_event) continue;
      const w = waits.find((x) => x.task_id === t.task_id && x.run_id === t.run_id && x.event_name === t.wake_event) || waits.find((x) => x.task_id === t.task_id && x.event_name === t.wake_event);
      if (w && t.available_at) {
        await c.query('insert into durable_checkpoint (task_id, name, value) values ($1, $2, $3) on conflict do nothing', [ids.get(t.task_id), `${w.step_name}@deadline`, JSON.stringify(t.available_at.toISOString())]);
      }
    }
  });
  const events = (await pg.query(`select event_name, payload, emitted_at from absurd.e_pa`)).rows;
  await lite.withTx(async (c) => {
    for (const e of events) {
      await c.query('insert into durable_event (queue, name, payload, emitted_at) values ($1, $2, $3, $4)', ['pa', e.event_name, JSON.stringify(e.payload ?? null), (e.emitted_at || new Date()).toISOString()]);
    }
  });
  const n = await lite.one('select (select count(*) from durable_task) as t, (select count(*) from durable_checkpoint) as c, (select count(*) from durable_event) as e');
  const r: Durable = { tasks: tasks.length, checkpoints: cps.length, events: events.length, sqlite: { tasks: Number(n?.t), events: Number(n?.e) }, ok: false };
  r.ok = r.sqlite.tasks === r.tasks && r.sqlite.events === r.events;
  log(`durable: ${r.tasks} tasks, ${r.checkpoints} checkpoints, ${r.events} events`);
  return r;
}

module.exports = { exportToSqlite, convert, vectorFromText };
