'use strict';

// The SQLite backend (docs/native/PLAN.md 3.1, D2): one file per stack, WAL,
// FTS5 for keyword search, vectors as float32 BLOBs, encrypted at rest with
// SQLCipher when a key is set. It has src/db's interface ({query, rows, one,
// withTx}, plus a pg-Pool-like `pool` whose connect() hands out a session), so
// src/repo runs on it: createRepos() sees `dialect: 'sqlite'` and loads the
// aggregates from src/repo/sqlite instead of the Postgres ones. Selected by
// PA_DB=sqlite (src/db/index.js); Postgres stays the default until 3.5.
//
// Driver: better-sqlite3-multiple-ciphers (an optional dependency): the
// better-sqlite3 API with SQLite3MultipleCiphers built in, so `PRAGMA key`
// gives a SQLCipher v4 file; N-API prebuilds for Windows and Linux, FTS5 and
// JSON compiled in. sqlite-vec (optional too) adds vec_distance_cosine in C;
// without it the same function is registered in JS (exact scan, slower).
//
// What the backend does so the SQLite repositories read like the Postgres ones:
//   - $1..$n placeholders, as pg: rewritten to `?` (a $n may repeat).
//   - Parameters: a Date, or a string holding an ISO-8601 instant, is stored
//     as UTC ISO text with milliseconds (timestamps sort as text); booleans as
//     0/1; objects and arrays as JSON; typed arrays (vectors) as BLOBs.
//   - Results: columns are decoded by their declared type (sql-sqlite/001):
//     timestamptz -> Date, jsonb and x[] -> parsed JSON, boolean -> true/false,
//     vector -> Float32Array. Integers stay JS numbers (pg gives bigint as a
//     string; every caller already Number()s an id).
//   - Concurrency: better-sqlite3 is synchronous and one connection is one
//     transaction, so writes and transactions take an in-process lock and
//     BEGIN IMMEDIATE (busy_timeout covers other processes on the same file).
//     Plain reads outside a transaction go to a second, read-only connection,
//     which sees the last commit (as a pg read beside an open transaction).
//     A write through the pool from inside a transaction would wait on that
//     transaction forever, so it throws instead (use the transaction's repos).
//   - FOR UPDATE does not exist: a transaction holds the write lock for the
//     whole database, which is at least as strong. Advisory locks are rows in
//     `lease` (sql-sqlite/003), owned by a session (pool.connect()).
//   - NOTIFY: the event triggers (sql-sqlite/003) write event_outbox in the
//     writer's transaction, as sql/036 does; after a commit this process reads
//     the new rows and hands them to sessions that LISTENed, as
//     {channel, payload}. Delivery is in-process only: another process sees the
//     events in event_outbox (src/repo events.after), not as a wake-up.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'sql-sqlite');
const DRIVER = 'better-sqlite3-multiple-ciphers';

function driver() {
  try {
    return require(DRIVER);
  } catch (err) {
    throw new Error(`the SQLite backend needs ${DRIVER} (an optional dependency of personal-assistant; npm install there): ${err.message}`);
  }
}

/** Whether the SQLite driver is installed here. */
function available() {
  try {
    require.resolve(DRIVER);
    return true;
  } catch {
    return false;
  }
}

// ---- SQL text: $n -> ? ----------------------------------------------------

const translated = new Map();

/** Rewrites pg's $n placeholders to `?`, outside quotes and comments. Returns {sql, order}. */
function translate(text) {
  let hit = translated.get(text);
  if (hit) return hit;
  let sql = '';
  const order = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      const stop = end < 0 ? text.length : end + 1;
      sql += text.slice(i, stop);
      i = stop - 1;
    } else if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      sql += text.slice(i, stop);
      i = stop - 1;
    } else if (ch === '$' && /\d/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (/\d/.test(text[j] || '')) j++;
      order.push(Number(text.slice(i + 1, j)) - 1);
      sql += '?';
      i = j - 1;
    } else {
      sql += ch;
    }
  }
  hit = { sql, order };
  if (translated.size > 2000) translated.clear();
  translated.set(text, hit);
  return hit;
}

// ---- values in and out ------------------------------------------------------

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** A JS value as SQLite stores it (see the header). */
function encode(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    if (ISO_INSTANT.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return v;
  }
  if (Buffer.isBuffer(v)) return v;
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** A vector (array or Float32Array) as the BLOB a vector column holds. */
function vectorBlob(v) {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

const toDate = (v) => (typeof v === 'string' || typeof v === 'number' ? new Date(v) : v);
const toJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const toBool = (v) => (typeof v === 'number' || typeof v === 'bigint' ? Boolean(Number(v)) : v);
const toVector = (v) => (Buffer.isBuffer(v) ? new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : v);

function decoderFor(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'timestamptz') return toDate;
  if (t === 'jsonb' || t.endsWith('[]')) return toJson;
  if (t === 'boolean') return toBool;
  if (t === 'vector') return toVector;
  return null;
}

const decoders = new WeakMap();

/** A function decoding one result row of `stmt` in place, or null when no column needs it. */
function rowDecoder(stmt) {
  if (decoders.has(stmt)) return decoders.get(stmt);
  const cols = stmt.columns().map((c) => [c.name, decoderFor(c.type)]).filter(([, fn]) => fn);
  const fn = cols.length
    ? (row) => {
        for (const [name, dec] of cols) if (row[name] != null) row[name] = dec(row[name]);
        return row;
      }
    : null;
  decoders.set(stmt, fn);
  return fn;
}

// ---- connections ------------------------------------------------------------

function jsCosineDistance(a, b) {
  if (a == null || b == null) return null;
  const x = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const y = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i++) {
    dot += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
  }
  return 1 - dot / Math.sqrt(nx * ny);
}

const dayFormats = new Map();

/** The calendar day ('YYYY-MM-DD') of an instant in an IANA zone: pg's (at at time zone tz)::date. */
function localDay(ts, tz) {
  if (ts == null) return null;
  let f = dayFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(tz, f);
  }
  return f.format(new Date(ts));
}

function open(file, { key = null, readonly = false } = {}) {
  const Database = driver();
  const conn = new Database(file, readonly ? { readonly: true, fileMustExist: true } : {});
  if (key) {
    // SQLCipher v4 format, so the file opens with stock sqlcipher tools too.
    conn.pragma("cipher = 'sqlcipher'");
    conn.pragma('legacy = 4');
    conn.pragma(`key = '${String(key).replace(/'/g, "''")}'`);
  }
  conn.pragma('busy_timeout = 10000');
  if (!readonly) {
    conn.pragma('journal_mode = WAL');
    conn.pragma('synchronous = NORMAL');
  }
  conn.pragma('foreign_keys = ON');
  let vec = false;
  try {
    require('sqlite-vec').load(conn);
    vec = true;
  } catch {
    conn.function('vec_distance_cosine', { deterministic: true }, jsCosineDistance);
  }
  conn.function('pa_local_day', { deterministic: true }, localDay);
  // pg's md5(text), and pgvector's '[0.1, ...]' text literal as a vector BLOB.
  conn.function('md5', { deterministic: true }, (s) => (s == null ? null : crypto.createHash('md5').update(String(s)).digest('hex')));
  conn.function('pa_vector', { deterministic: true }, (s) => (s == null ? null : vectorBlob(typeof s === 'string' ? JSON.parse(s) : s)));
  conn.vec = vec;
  return conn;
}

function cachedStatement(conn, sql) {
  conn.stmts ||= new Map();
  let s = conn.stmts.get(sql);
  if (!s) {
    s = conn.prepare(sql);
    if (conn.stmts.size > 1000) conn.stmts.clear();
    conn.stmts.set(sql, s);
  }
  return s;
}

/** Runs one statement on `conn`: pg's {rows, rowCount}. */
function runOn(conn, text, params) {
  const { sql, order } = translate(text);
  const stmt = cachedStatement(conn, sql);
  const args = order.map((i) => encode(params ? params[i] : undefined));
  if (stmt.reader) {
    const rows = stmt.all(...args);
    const dec = rowDecoder(stmt);
    if (dec) rows.forEach(dec);
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...args);
  return { rows: [], rowCount: info.changes };
}

function mutex() {
  let tail = Promise.resolve();
  let held = false;
  return {
    get held() {
      return held;
    },
    acquire() {
      let release;
      const next = new Promise((r) => (release = r));
      const ready = tail.then(() => {
        held = true;
        return () => {
          held = false;
          release();
        };
      });
      tail = tail.then(() => next);
      return ready;
    },
  };
}

// Sessions open in this process (any backend): a lease row whose holder is
// from this process but not in here was left by a session that is gone.
const LIVE_SESSIONS = new Set();

function pidAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Whether lease holder `holder` (pid:nonce) is gone: its session closed, or its process died. */
function holderGone(holder) {
  const pid = Number(String(holder).split(':')[0]);
  if (pid === process.pid) return !LIVE_SESSIONS.has(holder);
  return !pidAlive(pid);
}

// ---- the backend ------------------------------------------------------------

/**
 * A backend over the SQLite file `file` (':memory:' for a scratch one with
 * no read connection). `key` encrypts it (SQLCipher). Interface: src/db's
 * {query, rows, one, withTx, close}, plus dialect, pool (connect() -> a
 * session), exec (several statements, migrations) and migrate().
 */
function createSqliteBackend(file, { key = null } = {}) {
  // As src/db's guard for Postgres: a test process only opens a throwaway file.
  const testing = Boolean(process.env.PA_TESTING) || /\.test\.js$/i.test(process.argv[1] || '');
  if (testing && file !== ':memory:' && !/^pa_test_/i.test(path.basename(file))) {
    throw new Error(`refusing to open SQLite file "${file}" from a test process: tests may only use a file named pa_test_* (or :memory:)`);
  }
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const writer = open(file, { key });
  const memory = file === ':memory:';
  let reader = null; // opened on the first read: the file must exist and be in WAL mode
  const lock = mutex();
  const txContext = new AsyncLocalStorage();
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  let lastSeq = null; // the newest event_outbox seq handed to listeners
  let closed = false;

  function readConn() {
    if (memory) return writer;
    if (!reader) reader = open(file, { key, readonly: true });
    return reader;
  }

  function seqNow() {
    try {
      const r = writer.prepare('select last_value from pa_event_seq where id = 1').get();
      return r ? Number(r.last_value) : null;
    } catch {
      return null; // before sql-sqlite/003
    }
  }

  // After a commit: events the outbox gained go to the sessions listening.
  function flushEvents() {
    if (!bus.listenerCount('notify')) return;
    const head = seqNow();
    if (head == null || lastSeq == null || head <= lastSeq) {
      lastSeq = head;
      return;
    }
    const list = writer.prepare('select seq, topic, payload from event_outbox where seq > ? order by seq').all(lastSeq);
    lastSeq = head;
    for (const r of list) {
      const payload = JSON.stringify({ topic: r.topic, ...JSON.parse(r.payload) });
      setImmediate(() => bus.emit('notify', { channel: 'pa_events', payload, processId: process.pid }));
    }
  }

  function isRead(sql) {
    return cachedStatement(writer, translate(sql).sql).readonly;
  }

  async function query(text, params) {
    if (closed) throw new Error('the SQLite backend is closed');
    if (isRead(text)) return runOn(readConn(), text, params);
    if (txContext.getStore() === backend) {
      throw new Error('a write through the pool from inside an open SQLite transaction would wait on that transaction forever: use the repository set withTx handed you');
    }
    const release = await lock.acquire();
    try {
      const r = runOn(writer, text, params);
      flushEvents();
      return r;
    } finally {
      release();
    }
  }

  async function withTx(fn) {
    if (txContext.getStore() === backend) {
      throw new Error('a second transaction through the pool from inside an open SQLite transaction would wait on the first forever: use the repository set withTx handed you');
    }
    const release = await lock.acquire();
    try {
      writer.exec('BEGIN IMMEDIATE');
      const client = { dialect: 'sqlite', query: async (text, params) => runOn(writer, text, params) };
      let result;
      try {
        result = await txContext.run(backend, () => fn(client));
        writer.exec('COMMIT');
      } catch (err) {
        if (writer.inTransaction) writer.exec('ROLLBACK');
        throw err;
      }
      flushEvents();
      return result;
    } finally {
      release();
    }
  }

  /** Several statements at once, outside the repositories (migrations, seeds). */
  async function exec(sql) {
    const release = await lock.acquire();
    try {
      writer.exec(sql);
    } finally {
      release();
    }
  }

  /**
   * A session: what pg's pool.connect() gives, for the code that needs one
   * connection's identity (leases, LISTEN). {dialect, session, query, on,
   * release}; release() drops its leases, and LISTEN/UNLISTEN work as in pg.
   */
  async function connect() {
    const id = `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
    LIVE_SESSIONS.add(id);
    const events = new EventEmitter();
    const channels = new Set();
    const relay = (n) => {
      if (channels.has(n.channel)) events.emit('notification', n);
    };
    const session = {
      id,
      listen(channel) {
        if (!channels.size) {
          if (!bus.listenerCount('notify')) lastSeq = seqNow();
          bus.on('notify', relay);
        }
        channels.add(channel);
      },
      unlisten(channel) {
        if (channel === '*') channels.clear();
        else channels.delete(channel);
        if (!channels.size) bus.off('notify', relay);
      },
    };
    let released = false;
    const client = {
      dialect: 'sqlite',
      session,
      query(text, params) {
        const m = /^\s*(listen|unlisten)\s+(\*|[a-z_][a-z0-9_]*)\s*;?\s*$/i.exec(text);
        if (m) {
          session[m[1].toLowerCase()](m[2]);
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return query(text, params);
      },
      on(event, fn) {
        events.on(event, fn);
        return client;
      },
      off(event, fn) {
        events.off(event, fn);
        return client;
      },
      removeListener(event, fn) {
        events.off(event, fn);
        return client;
      },
      release() {
        if (released) return;
        released = true;
        session.unlisten('*');
        LIVE_SESSIONS.delete(id);
        if (closed) return;
        try {
          writer.prepare('delete from lease where holder = ?').run(id);
        } catch {
          /* before sql-sqlite/003 */
        }
      },
    };
    return client;
  }

  async function close() {
    if (closed) return;
    closed = true;
    bus.removeAllListeners();
    if (reader) reader.close();
    writer.close();
  }

  const backend = {
    dialect: 'sqlite',
    file,
    query,
    rows: async (text, params) => (await query(text, params)).rows,
    one: async (text, params) => (await query(text, params)).rows[0] ?? null,
    withTx,
    exec,
    close,
    migrate: () => migrate(backend),
    pool: { connect, query, end: close },
    connect,
    get vec() {
      return writer.vec;
    },
  };
  return backend;
}

// ---- migrations (sql-sqlite/*.sql) ------------------------------------------

function migrationFiles() {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Applies the sql-sqlite files `backend` has not applied, each in one transaction. */
async function migrate(backend) {
  await backend.exec(`create table if not exists schema_migration (
    version    text primary key,
    applied_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const done = new Set((await backend.rows('select version from schema_migration')).map((r) => r.version));
  const pending = migrationFiles().filter((f) => !done.has(f));
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8').replace(/^﻿/, '');
    await backend.exec(`BEGIN IMMEDIATE;\n${sql}\n;insert into schema_migration (version) values ('${file}');\nCOMMIT;`).catch(async (err) => {
      await backend.exec('ROLLBACK').catch(() => {});
      throw new Error(`sql-sqlite/${file}: ${err.message}`);
    });
  }
  return { applied: pending };
}

module.exports = {
  available,
  createSqliteBackend,
  migrate,
  migrationFiles,
  translate,
  encode,
  vectorBlob,
  holderGone,
  localDay,
  SCHEMA_DIR,
};
