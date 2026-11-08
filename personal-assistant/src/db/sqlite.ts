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
//     {channel, payload}. Events another process commits are picked up by a
//     500 ms poll of the outbox counter while anyone listens.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
/** A prepared statement of the driver (better-sqlite3), as used here. */
type Stmt = {
  reader: boolean;
  readonly: boolean;
  all(...args: unknown[]): Row[];
  get(...args: unknown[]): Row | undefined;
  run(...args: unknown[]): { changes: number };
  columns(): { name: string; type: string | null }[];
};
/** One driver connection, plus the statement cache and sqlite-vec flag kept on it. */
type Conn = {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  pragma(text: string): unknown;
  loadExtension(file: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function(name: string, opts: { deterministic: boolean }, fn: (...args: any[]) => unknown): void;
  close(): void;
  inTransaction: boolean;
  vec?: boolean;
  stmts?: Map<string, Stmt>;
};
type Result = { rows: Row[]; rowCount: number };
type TxClient = { dialect: string; query(text: string, params?: unknown[]): Promise<Result>; notify(channel: string, payload: unknown): Promise<void> };
type Notification = { channel: string; payload: string; processId: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;
/** What migrate() needs of a backend. */
type MigrateTarget = { exec(sql: string): Promise<void>; rows(text: string, params?: unknown[]): Promise<Row[]> };

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'sql-sqlite');
const DRIVER = 'better-sqlite3-multiple-ciphers';

// The compiled jarvisd bundles the driver's JS (its native addon stays on disk,
// found by path), but a copy of this file it loads from disk, as the backup's
// snapshot thread does, resolves no package names: that copy takes the
// checkout's node_modules by path, to the entry file (a directory does not resolve there).
const DRIVER_ON_DISK = path.join(__dirname, '..', '..', 'node_modules', DRIVER, 'lib', 'index.js');
// sqlite-vec finds its platform package by name, which the compiled jarvisd
// resolves from the working directory (a generation's is jarvisd/dist): the
// extension in the checkout, by path, when that fails.
const VEC_ON_DISK = path.join(
  __dirname, '..', '..', 'node_modules',
  `sqlite-vec-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
  `vec0.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`,
);

function driver() {
  try {
    return require(DRIVER);
  } catch (err) {
    if (fs.existsSync(DRIVER_ON_DISK)) return require(DRIVER_ON_DISK);
    throw new Error(`the SQLite backend needs ${DRIVER} (an optional dependency of personal-assistant; npm install there): ${(err as Error).message}`);
  }
}

/** Whether the SQLite driver is installed here. */
function available() {
  try {
    require.resolve(DRIVER);
    return true;
  } catch {
    return fs.existsSync(DRIVER_ON_DISK);
  }
}

// ---- SQL text: $n -> ? ----------------------------------------------------

const translated = new Map<string, { sql: string; order: number[] }>();

/** Rewrites pg's $n placeholders to `?`, outside quotes and comments. Returns {sql, order}. */
function translate(text: string) {
  let hit = translated.get(text);
  if (hit) return hit;
  let sql = '';
  const order: number[] = [];
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
function encode(v: unknown) {
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
function vectorBlob(v: Float32Array | ArrayLike<number>) {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

const toDate = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? new Date(v) : v);
const toJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const toBool = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' ? Boolean(Number(v)) : v);
const toVector = (v: unknown) => (Buffer.isBuffer(v) ? new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : v);

function decoderFor(type: unknown) {
  const t = String(type || '').toLowerCase();
  if (t === 'timestamptz') return toDate;
  if (t === 'jsonb' || t.endsWith('[]')) return toJson;
  if (t === 'boolean') return toBool;
  if (t === 'vector') return toVector;
  return null;
}

type Decode = (v: unknown) => unknown;
const decoders = new WeakMap<Stmt, ((row: Row) => Row) | null>();

/** A function decoding one result row of `stmt` in place, or null when no column needs it. */
function rowDecoder(stmt: Stmt) {
  if (decoders.has(stmt)) return decoders.get(stmt) ?? null;
  const cols = stmt
    .columns()
    .map((c) => [c.name, decoderFor(c.type)] as [string, Decode | null])
    .filter((x): x is [string, Decode] => Boolean(x[1]));
  const fn = cols.length
    ? (row: Row) => {
        for (const [name, dec] of cols) if (row[name] != null) row[name] = dec(row[name]);
        return row;
      }
    : null;
  decoders.set(stmt, fn);
  return fn;
}

// ---- connections ------------------------------------------------------------

function jsCosineDistance(a: Buffer | null, b: Buffer | null) {
  if (a == null || b == null) return null;
  const x = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const y = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] as number;
    const yi = y[i] as number;
    dot += xi * yi;
    nx += xi * xi;
    ny += yi * yi;
  }
  return 1 - dot / Math.sqrt(nx * ny);
}

let vecLoaded = false;

/** A float32 vector BLOB -> its sign bits (bit i set when element i > 0), as sqlite-vec's vec_quantize_binary. */
function signBits(b: Buffer | null) {
  if (b == null) return null;
  const f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const out = Buffer.alloc(Math.ceil(f.length / 8));
  for (let i = 0; i < f.length; i++) if ((f[i] as number) > 0) out[i >> 3] = (out[i >> 3] as number) | (1 << (i & 7));
  return out;
}

const POPCOUNT = new Uint8Array(256).map((_, i) => {
  let c = 0;
  for (let x = i; x; x >>= 1) c += x & 1;
  return c;
});

function jsHamming(a: Uint8Array | null, b: Uint8Array | null) {
  if (a == null || b == null) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[(a[i] as number) ^ (b[i] as number)] as number;
  return d;
}

/** SQL for the Hamming distance of two bit BLOBs: sqlite-vec's when loaded (~3x faster), else pa_hamming. */
function hammingSql(a: string, b: string) {
  return vecLoaded ? `vec_distance_hamming(vec_bit(${a}), vec_bit(${b}))` : `pa_hamming(${a}, ${b})`;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
// The day of a stored instant, by zone and UTC minute: a zone's offset has been
// whole minutes since 1972, so every instant in a minute falls on one local
// day. A week of llm_spend is ~56k rows, and formatting each one was most of
// the Meter's query.
const UTC_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;
const daysByMinute = new Map<string, string>();

/** The calendar day ('YYYY-MM-DD') of an instant in an IANA zone: pg's (at at time zone tz)::date. */
function localDay(ts: string | number | Date | null, tz: string) {
  if (ts == null) return null;
  const key = typeof ts === 'string' && ts >= '1972' && UTC_TEXT.test(ts) ? `${tz}|${ts.slice(0, 16)}` : null;
  if (key) {
    const hit = daysByMinute.get(key);
    if (hit) return hit;
  }
  const day = formatDay(ts, tz);
  if (key) {
    if (daysByMinute.size > 100_000) daysByMinute.clear();
    daysByMinute.set(key, day);
  }
  return day;
}

function formatDay(ts: string | number | Date, tz: string) {
  let f = dayFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(tz, f);
  }
  return f.format(new Date(ts));
}

function open(file: string, { key = null, readonly = false }: { key?: number | string | null; readonly?: boolean } = {}) {
  const Database = driver();
  const conn: Conn = new Database(file, readonly ? { readonly: true, fileMustExist: true } : {});
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
  for (const load of [() => require('sqlite-vec').load(conn), () => conn.loadExtension(VEC_ON_DISK)]) {
    try {
      load();
      vec = true;
      vecLoaded = true;
      break;
    } catch {
      /* the next way, then the JS fallback */
    }
  }
  if (!vec) conn.function('vec_distance_cosine', { deterministic: true }, jsCosineDistance);
  // A vector's sign bits (sql-sqlite/007), and their Hamming distance when
  // sqlite-vec is not there to do it (hammingSql picks).
  conn.function('pa_bits', { deterministic: true }, signBits);
  conn.function('pa_hamming', { deterministic: true }, jsHamming);
  conn.function('pa_local_day', { deterministic: true }, localDay);
  // pg's md5(text), and pgvector's '[0.1, ...]' text literal as a vector BLOB.
  conn.function('md5', { deterministic: true }, (s: unknown) => (s == null ? null : crypto.createHash('md5').update(String(s)).digest('hex')));
  conn.function('pa_vector', { deterministic: true }, (s: unknown) => (s == null ? null : vectorBlob(typeof s === 'string' ? JSON.parse(s) : (s as ArrayLike<number>))));
  conn.vec = vec;
  return conn;
}

function cachedStatement(conn: Conn, sql: string) {
  const stmts = (conn.stmts ||= new Map());
  let s = stmts.get(sql);
  if (!s) {
    s = conn.prepare(sql);
    if (stmts.size > 1000) stmts.clear();
    stmts.set(sql, s);
  }
  return s;
}

// A statement runs on the event loop (better-sqlite3 is synchronous), so a
// slow one stalls the whole process, the dashboard included: say which one.
const SLOW_MS = Number(process.env.PA_SQLITE_SLOW_MS) || 250;
let slowLog: { warn(message: string, fields: object): void } | null = null;
function noteSlow(ms: number, sql: string) {
  const log = (slowLog ||= require('../log.ts').logger('sqlite') as NonNullable<typeof slowLog>);
  log.warn('slow statement', { ms: Math.round(ms), sql: sql.replace(/\s+/g, ' ').trim().slice(0, 300) });
}

/** Runs one statement on `conn`: pg's {rows, rowCount}. */
function runOn(conn: Conn, text: string, params?: unknown[] | null): Result {
  const { sql, order } = translate(text);
  const stmt = cachedStatement(conn, sql);
  const args = order.map((i) => encode(params ? params[i] : undefined));
  const t0 = performance.now();
  try {
    if (stmt.reader) {
      const rows = stmt.all(...args);
      const dec = rowDecoder(stmt);
      if (dec) rows.forEach(dec);
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...args);
    return { rows: [], rowCount: info.changes };
  } finally {
    const ms = performance.now() - t0;
    if (ms > SLOW_MS) noteSlow(ms, sql);
  }
}

function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  let held = false;
  return {
    get held() {
      return held;
    },
    acquire(): Promise<() => void> {
      let release: () => void = () => {};
      const next = new Promise<void>((r) => (release = r));
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
const LIVE_SESSIONS = new Set<string>();

function pidAlive(pid: number) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

/** Whether lease holder `holder` (pid:nonce) is gone: its session closed, or its process died. */
function holderGone(holder: string) {
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
function createSqliteBackend(file: string, { key = null }: { key?: number | string | null } = {}) {
  // As src/db's guard for Postgres: a test process only opens a throwaway file.
  const testing = Boolean(process.env.PA_TESTING) || /\.test\.js$/i.test(process.argv[1] || '');
  if (testing && file !== ':memory:' && !/^pa_test_/i.test(path.basename(file))) {
    throw new Error(`refusing to open SQLite file "${file}" from a test process: tests may only use a file named pa_test_* (or :memory:)`);
  }
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const writer = open(file, { key });
  const memory = file === ':memory:';
  let reader: Conn | null = null; // opened on the first read: the file must exist and be in WAL mode
  const lock = mutex();
  const txContext = new AsyncLocalStorage();
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  let lastSeq: number | null = null; // the newest event_outbox seq handed to listeners
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
      const payload = JSON.stringify({ topic: r.topic, ...JSON.parse(String(r.payload)) });
      setImmediate(() => bus.emit('notify', { channel: 'pa_events', payload, processId: process.pid }));
    }
  }

  /** pg_notify without an outbox row: to this process's listeners on `channel`. */
  function notify(channel: string, payload: unknown) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    setImmediate(() => bus.emit('notify', { channel, payload: body, processId: process.pid }));
  }

  // Events another process wrote (the `pa` CLI, the MCP server, the other
  // worker generation) reach this process's listeners within POLL_MS: while
  // anyone listens, the outbox counter is read every POLL_MS (one indexed
  // read of a one-row table), as LISTEN would have woken them on Postgres.
  const POLL_MS = 500;
  let poller: ReturnType<typeof setInterval> | null = null;
  let polling = 0;
  function startPolling() {
    polling++;
    if (poller || memory) return;
    poller = setInterval(() => {
      if (closed || lock.held) return; // a local commit flushes on its own
      try {
        flushEvents();
      } catch {
        /* the next tick tries again */
      }
    }, POLL_MS);
    poller.unref();
  }
  function stopPolling() {
    polling = Math.max(0, polling - 1);
    if (!polling && poller) {
      clearInterval(poller);
      poller = null;
    }
  }

  function isRead(sql: string) {
    return cachedStatement(writer, translate(sql).sql).readonly;
  }

  // A pass that awaits one statement after another resumes each time as a
  // microtask, so however fast each one is, the loop never lets a timer or a
  // request in until the pass is done (the pages pass's ~30 person reads held
  // it for 9.7 s). Once statements have held the loop for YIELD_MS since it
  // last had a turn, the next one waits for a turn first. Not inside a
  // transaction: that would hold the store's write lock longer.
  const YIELD_MS = 50;
  let heldMs = 0;
  let turnQueued = false;
  function held(ms: number) {
    heldMs += ms;
    if (!turnQueued) {
      turnQueued = true;
      setImmediate(() => {
        heldMs = 0;
        turnQueued = false;
      });
    }
  }
  function timed(conn: Conn, text: string, params?: unknown[]) {
    const t0 = performance.now();
    try {
      return runOn(conn, text, params);
    } finally {
      held(performance.now() - t0);
    }
  }

  async function query(text: string, params?: unknown[]): Promise<Result> {
    if (closed) throw new Error('the SQLite backend is closed');
    if (heldMs >= YIELD_MS && txContext.getStore() !== backend) await new Promise((resolve) => setImmediate(resolve));
    if (closed) throw new Error('the SQLite backend is closed');
    if (isRead(text)) return timed(readConn(), text, params);
    if (txContext.getStore() === backend) {
      throw new Error('a write through the pool from inside an open SQLite transaction would wait on that transaction forever: use the repository set withTx handed you');
    }
    const release = await lock.acquire();
    try {
      const r = timed(writer, text, params);
      flushEvents();
      return r;
    } finally {
      release();
    }
  }

  async function withTx<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
    if (txContext.getStore() === backend) {
      throw new Error('a second transaction through the pool from inside an open SQLite transaction would wait on the first forever: use the repository set withTx handed you');
    }
    const release = await lock.acquire();
    try {
      writer.exec('BEGIN IMMEDIATE');
      // A NOTIFY inside a transaction goes out at commit, and not at all on rollback (as pg).
      const held: [string, unknown][] = [];
      const client: TxClient = { dialect: 'sqlite', query: async (text, params) => runOn(writer, text, params), notify: async (channel, payload) => void held.push([channel, payload]) };
      let result: T;
      try {
        result = await txContext.run(backend, () => fn(client));
        writer.exec('COMMIT');
      } catch (err) {
        if (writer.inTransaction) writer.exec('ROLLBACK');
        throw err;
      }
      flushEvents();
      for (const [channel, payload] of held) notify(channel, payload);
      return result;
    } finally {
      release();
    }
  }

  /** Several statements at once, outside the repositories (migrations, seeds). */
  async function exec(sql: string) {
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
    const channels = new Set<string>();
    const relay = (n: Notification) => {
      if (channels.has(n.channel)) events.emit('notification', n);
    };
    const session = {
      id,
      listen(channel: string) {
        if (!channels.size) {
          if (!bus.listenerCount('notify')) lastSeq = seqNow();
          bus.on('notify', relay);
          startPolling();
        }
        channels.add(channel);
      },
      unlisten(channel: string) {
        const had = channels.size > 0;
        if (channel === '*') channels.clear();
        else channels.delete(channel);
        if (had && !channels.size) {
          bus.off('notify', relay);
          stopPolling();
        }
      },
    };
    let released = false;
    const client = {
      dialect: 'sqlite',
      session,
      query(text: string, params?: unknown[]): Promise<Result> {
        const m = /^\s*(listen|unlisten)\s+(\*|[a-z_][a-z0-9_]*)\s*;?\s*$/i.exec(text);
        if (m) {
          session[m[1]!.toLowerCase() as 'listen' | 'unlisten'](m[2]!);
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return query(text, params);
      },
      notify: async (channel: string, payload: unknown) => notify(channel, payload),
      on(event: string, fn: Listener): unknown {
        events.on(event, fn);
        return client;
      },
      off(event: string, fn: Listener): unknown {
        events.off(event, fn);
        return client;
      },
      removeListener(event: string, fn: Listener): unknown {
        events.off(event, fn);
        return client;
      },
      /** pg's Client.end(), for code that owns its connection (the live-feed listener). */
      end(): Promise<void> {
        client.release();
        return Promise.resolve();
      },
      release(): void {
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
    if (poller) clearInterval(poller);
    bus.removeAllListeners();
    if (reader) reader.close();
    writer.close();
  }

  const backend = {
    dialect: 'sqlite',
    file,
    query,
    rows: async (text: string, params?: unknown[]) => (await query(text, params)).rows,
    one: async (text: string, params?: unknown[]) => (await query(text, params)).rows[0] ?? null,
    withTx,
    exec,
    notify: async (channel: string, payload: unknown) => notify(channel, payload),
    close,
    migrate: (): Promise<{ applied: string[] }> => migrate(backend),
    pool: { connect, query, end: close },
    connect,
    get vec() {
      return writer.vec;
    },
  };
  return backend;
}

/**
 * A consistent copy of the store file `src` at `dest` (a new file):
 * VACUUM INTO on its own read-only connection, so the writer keeps writing.
 * The copy is compacted and keeps the store's encryption (same key).
 */
function snapshotFile(src: string, dest: string, { key = null }: { key?: number | string | null } = {}) {
  if (fs.existsSync(dest)) throw new Error(`${dest} exists`);
  const conn = open(src, { key, readonly: true });
  try {
    conn.prepare('vacuum into ?').run(dest);
  } finally {
    conn.close();
  }
}

// ---- migrations (sql-sqlite/*.sql) ------------------------------------------

function migrationFiles() {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();
}

/** Applies the sql-sqlite files `backend` has not applied, each in one transaction. */
async function migrate(backend: MigrateTarget) {
  await backend.exec(`create table if not exists schema_migration (
    version    text primary key,
    applied_at timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const done = new Set((await backend.rows('select version from schema_migration')).map((r) => r.version));
  const pending: string[] = migrationFiles().filter((f: string) => !done.has(f));
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8').replace(/^﻿/, '');
    await backend.exec(`BEGIN IMMEDIATE;\n${sql}\n;insert into schema_migration (version) values ('${file}');\nCOMMIT;`).catch(async (err: Error) => {
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
  snapshotFile,
  signBits,
  hammingSql,
  holderGone,
  localDay,
  SCHEMA_DIR,
};
