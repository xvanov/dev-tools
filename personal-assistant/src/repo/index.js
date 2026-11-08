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

const AGGREGATES = {
  audio: () => require('./audio'),
  audit: () => require('./audit'),
  commitments: () => require('./commitments'),
  drafts: () => require('./drafts'),
  durable: () => require('./durable'),
  evals: () => require('./evals'),
  events: () => require('./events'),
  factoryBoard: () => require('./factoryBoard'),
  leases: () => require('./leases'),
  ledger: () => require('./ledger'),
  meetings: () => require('./meetings'),
  memory: () => require('./memory'),
  notifications: () => require('./notifications'),
  passkeys: () => require('./passkeys'),
  people: () => require('./people'),
  projects: () => require('./projects'),
  proposals: () => require('./proposals'),
  repos: () => require('./repos'),
  routines: () => require('./routines'),
  runs: () => require('./runs'),
  search: () => require('./search'),
  secrets: () => require('./secrets'),
  sources: () => require('./sources'),
  spend: () => require('./spend'),
  system: () => require('./system'),
  workflowLimits: () => require('./workflowLimits'),
};

/** A backend over a transaction's client: its query, and withTx that joins it. */
function clientBackend(client) {
  const query = (text, params) => client.query(text, params);
  const b = {
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
  return b;
}

/**
 * The SQLite twin of aggregate `name` (src/repo/sqlite/<name>.js, plan 3.1):
 * the same methods over SQLite SQL. One not ported yet has no methods.
 */
function loadSqlite(name) {
  const file = require('path').join(__dirname, 'sqlite', `${name}.js`);
  return require('fs').existsSync(file) ? require(file) : { create: () => ({}) };
}

/** The repository set over `db` (a backend with src/db's interface; `db.dialect` 'sqlite' picks src/repo/sqlite). */
function createRepos(db) {
  const repos = {};
  for (const [name, load] of Object.entries(AGGREGATES)) {
    let made = null;
    Object.defineProperty(repos, name, {
      enumerable: true,
      get: () => (made ||= (db.dialect === 'sqlite' ? loadSqlite(name) : load()).create(db, repos)),
    });
  }
  /** Runs fn(reposInTx) in one transaction (joins an open one). */
  repos.withTx = (fn) => (db.inTx ? fn(repos) : db.withTx((client) => fn(createRepos(clientBackend(client)))));
  repos.backend = db;
  return repos;
}

// The process's pool, resolved per call (see above).
const poolBackend = {
  query: (text, params) => require('../db').query(text, params),
  rows: (text, params) => require('../db').rows(text, params),
  one: (text, params) => require('../db').one(text, params),
  withTx: (fn) => require('../db').withTx(fn),
  get dialect() {
    return require('../db').dialect;
  },
};

/**
 * The repository set for a transaction a caller hands over: a set already
 * (repo.withTx's `r`), or, while modules are being converted, a raw pg client
 * from src/db withTx. Nothing given: the pool's set.
 */
function on(tx) {
  if (!tx) return module.exports;
  if (tx.backend && typeof tx.withTx === 'function') return tx;
  if (typeof tx.query === 'function') return createRepos(clientBackend(tx));
  throw new Error('repo.on: expected a repository set or a pg client');
}

module.exports = createRepos(poolBackend);
module.exports.createRepos = createRepos;
module.exports.clientBackend = clientBackend;
module.exports.on = on;
module.exports.AGGREGATES = Object.keys(AGGREGATES);
