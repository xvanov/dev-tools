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
// reachable); CI's Linux leg provides one (PA_TEST_PG_URL).
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

async function main() {
  const list = contracts();
  const missing = coverage(list);
  assert.deepStrictEqual(missing, [], `repository methods without a contract case:\n  ${missing.join('\n  ')}`);

  let failed = 0;
  let ran = 0;
  for (const [bname, make] of Object.entries(BACKENDS)) {
    const b = await make();
    if (b.skip) {
      console.log(`SKIP ${bname}: ${b.skip}`);
      continue;
    }
    try {
      for (const c of list) {
        for (const [title, fn] of Object.entries(c.cases)) {
          const t = { repos: b.repos, db: b.db, seed: b.seed, assert, uniq: (p = 'x') => `${p}-${crypto.randomBytes(4).toString('hex')}` };
          const t0 = Date.now();
          try {
            await fn(t);
            ran++;
            console.log(`ok   ${bname} ${c.name}.${title} (${Date.now() - t0} ms)`);
          } catch (err) {
            failed++;
            console.log(`FAIL ${bname} ${c.name}.${title}\n     ${String(err.stack || err).split('\n').slice(0, 6).join('\n     ')}`);
          }
        }
      }
    } finally {
      await b.teardown();
    }
  }
  console.log(`repoContract: ${ran} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
