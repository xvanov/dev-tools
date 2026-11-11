'use strict';

// The repository layer (native plan 1.2): every SQL statement the PA runs
// lives in one of the aggregate modules in this directory, behind a named,
// documented method. Code outside src/repo (and src/db, which owns the pool and
// migrations) never writes SQL. That is what lets phase 3 swap Postgres for
// SQLite: a second backend implements the same methods, and the contract tests
// (test/repoContract.test.js, test/contract/*.contract.js) are the oracle both
// must pass.
//
// Shape:
//   const repo = require('../repo');
//   await repo.notifications.feed({ limit: 30 });
//   await repo.withTx(async (r) => { await r.notifications.lockById(id); ... });
//
// Each aggregate module exports `create(db, repos)`, where `db` is a backend
// with src/db's interface ({query, rows, one, withTx}) and `repos` is the set it
// belongs to (for an aggregate that needs another). The default set runs on the
// process's pool and resolves src/db at CALL time, so a test that stubs src/db
// in require.cache (test/_fakeDb.js, or a SQL-matching fake) still answers every
// query, before or after this module loads. `withTx(fn)` hands `fn` a set bound
// to one transaction's client; inside it, a nested withTx joins the same
// transaction.
//
// Adding an aggregate: a file here exporting create(), a line in AGGREGATES,
// and a contract file in test/contract/ covering every method (1.3).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md);
// index.js is the one-line shim `require('../repo')` resolves to.

type Db = import('./types.ts').Db;
type Client = import('./types.ts').Client;
type Repos = import('./types.ts').Repos;
type Aggregate = { create(db: Db, repos: Repos): Record<string, unknown> };
/** The process's pool backend: a Db, plus closing it and one dedicated connection. */
type PoolBackend = Db & { close(): Promise<unknown>; connect(): Promise<unknown> };

const AGGREGATES: Record<string, () => Aggregate> = {
  audio: () => require('./audio.ts'),
  audit: () => require('./audit.ts'),
  buildRuns: () => require('./buildRuns.ts'),
  cardPlans: () => require('./cardPlans.ts'),
  backupDrill: () => require('./backupDrill.ts'),
  commitments: () => require('./commitments.ts'),
  drafts: () => require('./drafts.ts'),
  durable: () => require('./durable.ts'),
  evals: () => require('./evals.ts'),
  events: () => require('./events.ts'),
  factoryBoard: () => require('./factoryBoard.ts'),
  leases: () => require('./leases.ts'),
  ledger: () => require('./ledger.ts'),
  meetings: () => require('./meetings.ts'),
  memory: () => require('./memory.ts'),
  notifications: () => require('./notifications.ts'),
  passkeys: () => require('./passkeys.ts'),
  people: () => require('./people.ts'),
  projects: () => require('./projects.ts'),
  proposals: () => require('./proposals.ts'),
  repos: () => require('./repos.ts'),
  routines: () => require('./routines.ts'),
  runs: () => require('./runs.ts'),
  search: () => require('./search.ts'),
  secrets: () => require('./secrets.ts'),
  sources: () => require('./sources.ts'),
  spend: () => require('./spend.ts'),
  system: () => require('./system.ts'),
  telemetry: () => require('./telemetry.ts'),
  workflowLimits: () => require('./workflowLimits.ts'),
};

/** A backend over a transaction's client: its query, and withTx that joins it. */
function clientBackend(client: Client & Partial<Pick<Db, 'dialect' | 'session' | 'notify'>>): Db {
  const query = (text: string, params?: unknown[]) => client.query(text, params);
  const b: Db = {
    query,
    rows: async (text, params) => (await query(text, params)).rows,
    one: async (text, params) => (await query(text, params)).rows[0] ?? null,
    withTx: (fn) => fn(client),
    inTx: true,
  };
  // The SQLite backend's clients say so (and a session carries its identity,
  // for leases and LISTEN); a pg client says nothing: Postgres.
  if (client.dialect) b.dialect = client.dialect;
  if (client.session) b.session = client.session;
  if (typeof client.notify === 'function') b.notify = client.notify.bind(client);
  return b;
}

// The SQLite twins (src/repo/sqlite/<name>.ts, plan 3.1): the same methods over
// SQLite SQL. Literal requires, so the compiled jarvisd bundles them: a twin
// loaded from disk by a computed path brings its own copy of db/sqlite.ts,
// whose session set then calls this process's live lease holders gone.
const SQLITE_TWINS: Record<string, () => Aggregate> = {
  audio: () => require('./sqlite/audio.ts'),
  audit: () => require('./sqlite/audit.ts'),
  buildRuns: () => require('./sqlite/buildRuns.ts'),
  cardPlans: () => require('./sqlite/cardPlans.ts'),
  backupDrill: () => require('./sqlite/backupDrill.ts'),
  commitments: () => require('./sqlite/commitments.ts'),
  drafts: () => require('./sqlite/drafts.ts'),
  durable: () => require('./sqlite/durable.ts'),
  evals: () => require('./sqlite/evals.ts'),
  events: () => require('./sqlite/events.ts'),
  factoryBoard: () => require('./sqlite/factoryBoard.ts'),
  leases: () => require('./sqlite/leases.ts'),
  ledger: () => require('./sqlite/ledger.ts'),
  meetings: () => require('./sqlite/meetings.ts'),
  memory: () => require('./sqlite/memory.ts'),
  notifications: () => require('./sqlite/notifications.ts'),
  passkeys: () => require('./sqlite/passkeys.ts'),
  people: () => require('./sqlite/people.ts'),
  projects: () => require('./sqlite/projects.ts'),
  proposals: () => require('./sqlite/proposals.ts'),
  repos: () => require('./sqlite/repos.ts'),
  routines: () => require('./sqlite/routines.ts'),
  runs: () => require('./sqlite/runs.ts'),
  search: () => require('./sqlite/search.ts'),
  secrets: () => require('./sqlite/secrets.ts'),
  sources: () => require('./sqlite/sources.ts'),
  spend: () => require('./sqlite/spend.ts'),
  system: () => require('./sqlite/system.ts'),
  telemetry: () => require('./sqlite/telemetry.ts'),
  workflowLimits: () => require('./sqlite/workflowLimits.ts'),
};

/** The SQLite twin of aggregate `name`. One not ported yet has no methods. */
function loadSqlite(name: string): Aggregate {
  const load = SQLITE_TWINS[name];
  return load ? load() : { create: () => ({}) };
}

/** The repository set over `db` (a backend with src/db's interface; `db.dialect` 'sqlite' picks src/repo/sqlite). */
function createRepos(db: Db): Repos {
  const repos = {} as Repos;
  for (const [name, load] of Object.entries(AGGREGATES)) {
    let made: Record<string, unknown> | null = null;
    Object.defineProperty(repos, name, {
      enumerable: true,
      get: () => (made ||= (db.dialect === 'sqlite' ? loadSqlite(name) : load()).create(db, repos)),
    });
  }
  /** Runs fn(reposInTx) in one transaction (joins an open one). */
  repos.withTx = <T>(fn: (r: Repos) => Promise<T>): Promise<T> => (db.inTx ? fn(repos) : db.withTx((client) => fn(createRepos(clientBackend(client)))));
  repos.backend = db;
  return repos;
}

// The process's pool, resolved per call (see above).
const poolBackend: PoolBackend = {
  query: (text: string, params?: unknown[]) => require('../db').query(text, params),
  rows: (text: string, params?: unknown[]) => require('../db').rows(text, params),
  one: (text: string, params?: unknown[]) => require('../db').one(text, params),
  withTx: (fn: (client: Client) => Promise<unknown>) => require('../db').withTx(fn),
  notify: (channel: string, payload: string) => require('../db').notify(channel, payload),
  /** Closes the pool (a SQLite restore swaps the file under it). */
  close: () => require('../db').close(),
  /** One dedicated connection (a pg pool client, or a SQLite session) for LISTEN and locks. */
  connect: () => require('../db').getPool().connect(),
  get dialect() {
    return require('../db').dialect;
  },
};

/**
 * The repository set for a transaction a caller hands over: a set already
 * (repo.withTx's `r`), or, while modules are being converted, a raw pg client
 * from src/db withTx. Nothing given: the pool's set.
 */
function on(tx: Repos | Client | null | undefined): Repos {
  if (!tx) return module.exports;
  if ('backend' in tx && tx.backend && typeof tx.withTx === 'function') return tx as Repos;
  if ('query' in tx && typeof tx.query === 'function') return createRepos(clientBackend(tx as Client));
  throw new Error('repo.on: expected a repository set or a pg client');
}

module.exports = createRepos(poolBackend);
module.exports.createRepos = createRepos;
/** The repository set over its own connection pool for url (the backup drill's scratch and maintenance databases); .close() ends the pool. */
module.exports.openAt = (url: string, opts?: unknown) => {
  const backend = require('../db').createBackend(url, opts);
  const set = createRepos(backend);
  set.close = () => backend.close();
  return set;
};
module.exports.clientBackend = clientBackend;
module.exports.on = on;
module.exports.AGGREGATES = Object.keys(AGGREGATES);
