'use strict';

// Every relative require in termhub's entries and lib/ resolves to a file under CommonJS
// rules (plan 4.1). Node adds .js, .json and .node to an extensionless path,
// never .ts: once a module moves to x.ts, a caller still saying require('./x')
// breaks at run time, and only on the path that loads it (a lazy require in a
// rarely taken branch passes every test that does not take it). Comments are
// not code: a shim's header may quote the require it serves.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TH = path.join(__dirname, '..');
const resolves = (abs) =>
  ['', '.js', '.json', '.node'].some((x) => fs.existsSync(abs + x) && fs.statSync(abs + x).isFile()) || fs.existsSync(path.join(abs, 'index.js'));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const bad = [];
let seen = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p);
      continue;
    }
    if (!/\.(js|ts)$/.test(e.name) || /\.client\.js$/.test(e.name)) continue;
    walkFile(p);
  }
};
function walkFile(p) {
  {
    const code = stripComments(fs.readFileSync(p, 'utf8'));
    for (const m of code.matchAll(/require(?:\.resolve)?\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) {
      seen++;
      if (!resolves(path.resolve(path.dirname(p), m[2]))) bad.push(`${path.relative(TH, p)}: require('${m[2]}')`);
    }
  }
};
walk(path.join(TH, 'lib'));
walk(path.join(TH, 'watchdog'));
for (const f of fs.readdirSync(TH)) if (/\.(js|ts)$/.test(f)) walkFile(path.join(TH, f));
assert.ok(seen > 50, `found only ${seen} requires`);
assert.deepStrictEqual(bad, [], `requires that resolve to nothing:\n  ${bad.join('\n  ')}`);
console.log(`requiresResolve: ${seen} relative requires, all resolve`);