'use strict';

// Every repository call in src names a method that exists (plan 1.2). Chunks
// convert in parallel and rebase over each other: brief/index.js once called
// repo.sources.calendarToday before that method was on main, and the live board
// answered 500 (3b37fe1). This scans src and bin for `repo.<agg>.<method>(`,
// `r.<agg>.<method>(` / `repos.<agg>.<method>(` (a repo.withTx set) and
// `require('../repo').<agg>.<method>(`, and checks each method on the Postgres
// set. Only names that are aggregates count, so `r.rows.map(` is not a call.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRepos, AGGREGATES } = require('../src/repo');

const ROOT = path.join(__dirname, '..');
const fakeDb = { query: async () => ({ rows: [] }), rows: async () => [], one: async () => null, withTx: async (fn) => fn({ query: async () => ({ rows: [] }) }) };
const repos = createRepos(fakeDb);
const aggs = new Set(AGGREGATES);

const CALL = [
  /\b(?:repo|repos|r)\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g,
  /require\(\s*['"](?:\.\.?\/)+repo['"]\s*\)\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g,
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.client.js')) out.push(p); // *.client.js runs in the browser
  }
  return out;
}

const missing = [];
let checked = 0;
for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))]) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  for (const re of CALL) {
    for (const m of text.matchAll(re)) {
      const [, agg, method] = m;
      // A local array or string that shares an aggregate's name (r.sources.join).
      if (!aggs.has(agg) || method in Array.prototype || method in String.prototype) continue;
      checked++;
      if (typeof repos[agg][method] !== 'function') {
        const line = text.slice(0, m.index).split('\n').length;
        missing.push(`${rel}:${line} repo.${agg}.${method} does not exist`);
      }
    }
  }
}

assert.deepStrictEqual(missing, [], `repository calls to methods that do not exist:\n  ${missing.join('\n  ')}`);
assert.ok(checked > 50, `only ${checked} repository calls found: the scan is broken`);
console.log(`repoCalls: ok (${checked} calls checked)`);
