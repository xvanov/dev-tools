'use strict';

// The repository contract (plan 1.3): every method of every aggregate in
// src/repo, run against each backend in test/contract/_backends.js. This is the
// oracle for the phase 3 move to SQLite: the same contract files must pass on
// every backend. A contract file is test/contract/<aggregate>.contract.js and
// exports cases: { '<method>: <what>': async (t) => {...} }, where t is
// {repos, db, seed, assert, uniq}. Every method an aggregate exports must be
// named by at least one case (`<method>:` prefix), so a new method without a
// contract fails here.
//
// Backends that cannot run here are skipped with a reason (no Postgres
// reachable; no SQLite driver); CI's contract job provides Postgres
// (PA_TEST_PG_URL), and SQLite (plan 3.2) needs no server.
//
//   node test/repoContract.test.js [aggregate ...]

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BACKENDS = require('./contract/_backends');
const { AGGREGATES, createRepos } = require('../src/repo');

const DIR = path.join(__dirname, 'contract');
const only = process.argv.slice(2);

function contracts() {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.contract.js')).sort()) {
    const name = f.replace(/\.contract\.js$/, '');
    if (only.length && !only.includes(name)) continue;
    out.push({ name, cases: require(path.join(DIR, f)) });
  }
  return out;
}

/** Every method of every aggregate is covered by some case. */
function coverage(list) {
  const missing = [];
  const fakeDb = { query: async () => ({ rows: [] }), rows: async () => [], one: async () => null, withTx: async (fn) => fn({ query: async () => ({ rows: [] }) }) };
  const repos = createRepos(fakeDb);
  for (const agg of AGGREGATES) {
    if (only.length && !only.includes(agg)) continue;
    const c = list.find((x) => x.name === agg);
    const methods = Object.keys(repos[agg]).filter((k) => typeof repos[agg][k] === 'function');
    if (!c) {
      if (methods.length) missing.push(`${agg}: no test/contract/${agg}.contract.js`);
      continue;
    }
    for (const m of methods) if (!Object.keys(c.cases).some((k) => k.startsWith(`${m}:`))) missing.push(`${agg}.${m}`);
  }
  return missing;
}

// While phase 1 converts aggregates, the SQLite twins (src/repo/sqlite, plan
// 3.1) trail the Postgres ones: on a backend other than postgres, a case that
// reaches a method the Postgres set has and this backend's set lacks is a
// `todo`, not a failure, so landing a Postgres method never turns CI red.
// PA_CONTRACT_STRICT=1 makes todo a failure (plan 3.2 is done when it passes).
// PA_CONTRACT_BACKENDS=sqlite (comma list) runs only those backends.
const STRICT = process.env.PA_CONTRACT_STRICT === '1';

class Todo extends Error {}

/** The Postgres set's method names per aggregate (what every backend must have). */
function pgMethods() {
  const fakeDb = { query: async () => ({ rows: [] }), rows: async () => [], one: async () => null, withTx: async (fn) => fn({ query: async () => ({ rows: [] }) }) };
  const repos = createRepos(fakeDb);
  const out = {};
  for (const agg of AGGREGATES) out[agg] = new Set(Object.keys(repos[agg]).filter((k) => typeof repos[agg][k] === 'function'));
  return out;
}

/** `repos` whose missing methods (present on Postgres) record themselves in `seen` and throw Todo. */
function tracking(repos, want, seen) {
  const wrapAgg = (agg, impl) =>
    new Proxy(impl, {
      get(target, m) {
        const v = target[m];
        if (v === undefined && typeof m === 'string' && want[agg] && want[agg].has(m)) {
          return () => {
            seen.add(`${agg}.${m}`);
            throw new Todo(`${agg}.${m} is not on this backend yet`);
          };
        }
        return v;
      },
    });
  return new Proxy(repos, {
    get(target, k) {
      if (k === 'withTx') return (fn) => target.withTx((r) => fn(tracking(r, want, seen)));
      const v = target[k];
      return typeof k === 'string' && want[k] ? wrapAgg(k, v) : v;
    },
  });
}

async function main() {
  const list = contracts();
  const missing = coverage(list);
  assert.deepStrictEqual(missing, [], `repository methods without a contract case:\n  ${missing.join('\n  ')}`);

  const want = pgMethods();
  const pick = (process.env.PA_CONTRACT_BACKENDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let failed = 0;
  let ran = 0;
  let todo = 0;
  for (const [bname, make] of Object.entries(BACKENDS)) {
    if (pick.length && !pick.includes(bname)) continue;
    const b = await make();
    if (b.skip) {
      console.log(`SKIP ${bname}: ${b.skip}`);
      continue;
    }
    const lenient = bname !== 'postgres' && !STRICT;
    const gaps = new Set();
    try {
      for (const c of list) {
        for (const [title, fn] of Object.entries(c.cases)) {
          const seen = new Set();
          const repos = bname === 'postgres' ? b.repos : tracking(b.repos, want, seen);
          const t = { repos, db: b.db, seed: b.seed, assert, uniq: (p = 'x') => `${p}-${crypto.randomBytes(4).toString('hex')}` };
          const t0 = Date.now();
          try {
            await fn(t);
            ran++;
            console.log(`ok   ${bname} ${c.name}.${title} (${Date.now() - t0} ms)`);
          } catch (err) {
            if (seen.size && lenient) {
              todo++;
              for (const s of seen) gaps.add(s);
              console.log(`todo ${bname} ${c.name}.${title} (needs ${[...seen].join(', ')})`);
              continue;
            }
            failed++;
            console.log(`FAIL ${bname} ${c.name}.${title}\n     ${String(err.stack || err).split('\n').slice(0, 6).join('\n     ')}`);
          }
        }
      }
    } finally {
      await b.teardown();
    }
    if (gaps.size) console.log(`${bname}: ${gaps.size} method(s) not ported yet: ${[...gaps].sort().join(', ')}`);
  }
  console.log(`repoContract: ${ran} passed, ${failed} failed${todo ? `, ${todo} todo (not on every backend yet; PA_CONTRACT_STRICT=1 fails them)` : ''}`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
