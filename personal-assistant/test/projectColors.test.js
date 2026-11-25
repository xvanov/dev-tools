'use strict';

// A project's colour and the Plan board's project groups
// (src/dashboard/projectColors.client.js): the hash into the eight theme.css hues,
// the grouping the board draws, and page.client.js's own copy of both the hash
// and the hues, which the export inlines without theme.css.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const P = require('../src/dashboard/projectColors.client.js');
const DASH = path.join(__dirname, '..', 'src', 'dashboard');

// ---------------------------------------------------------------- slot ----
{
  assert.strictEqual(P.SLOTS, 8);
  assert.strictEqual(P.slot(null), null);
  assert.strictEqual(P.slot(undefined), null);
  assert.strictEqual(P.slot(''), null);
  assert.strictEqual(P.slot('alpha-svc'), P.slot('alpha-svc'), 'stable');
  // FNV-1a pinned, so a change to the hash (and every project's colour) is deliberate.
  assert.deepStrictEqual(['a', 'alpha-svc', 'beta', 'Beta'].map(P.slot), [4, 4, 7, 7]);
  const names = Array.from({ length: 200 }, (_, i) => `project-${i}`);
  const used = new Set();
  for (const n of names) {
    const s = P.slot(n);
    assert.ok(Number.isInteger(s) && s >= 0 && s < 8, `${n} -> ${s}`);
    used.add(s);
  }
  assert.strictEqual(used.size, 8, 'every hue is reachable');
}

// --------------------------------------------------------------- group ----
{
  const cards = [
    { id: 1, project: 'zeta' },
    { id: 2, project: null },
    { id: 3, project: 'Alpha' },
    { id: 4, project: 'beta' },
    { id: 5, project: 'zeta' },
    { id: 6 },
    { id: 7, project: 'alpha' },
    { id: 8, project: 'Alpha' },
    { id: 9, project: '' },
  ];
  const g = P.group(cards);
  assert.deepStrictEqual(g.map((x) => x.project), ['Alpha', 'alpha', 'beta', 'zeta', null], 'name order, case-insensitive; no project last');
  assert.deepStrictEqual(g.map((x) => x.cards.map((c) => c.id)), [[3, 8], [7], [4], [1, 5], [2, 6, 9]], 'cards keep their order inside a group');
  assert.deepStrictEqual(g.map((x) => x.slot), ['Alpha', 'alpha', 'beta', 'zeta', null].map(P.slot));
  assert.deepStrictEqual(P.group([]), []);
  assert.deepStrictEqual(P.group(null), []);
  assert.deepStrictEqual(P.group([{ id: 1 }, { id: 2 }]).map((x) => [x.project, x.cards.length]), [[null, 2]]);
  const asks = [{ id: 'p1', asks: [{ project: 'b' }] }, { id: 'p2', asks: [{ project: 'a' }] }];
  assert.deepStrictEqual(P.group(asks, (c) => c.asks[0].project).map((x) => x.cards[0].id), ['p2', 'p1'], 'a custom accessor');
}

// ------------------------------------------- theme.css holds the hues ----
const theme = fs.readFileSync(path.join(DASH, 'theme.css'), 'utf8');
const hex = (when) => Array.from({ length: 8 }, (_, i) => {
  const m = new RegExp(`--p-proj-${i}-${when}:\\s*(#[0-9a-f]{6});`, 'i').exec(theme);
  assert.ok(m, `theme.css --p-proj-${i}-${when}`);
  return m[1].toLowerCase();
});
const day = hex('day');
const night = hex('night');
for (let i = 0; i < 8; i++) {
  assert.ok(theme.includes(`--proj-${i}: light-dark(var(--p-proj-${i}-day), var(--p-proj-${i}-night));`), `--proj-${i} for light and dark`);
  assert.ok(theme.includes(`.pc-${i} { --pc: var(--proj-${i}); }`), `.pc-${i}`);
}
assert.ok(/\.j-proj \{/.test(theme), 'the chip');

// ------------------------------- page.client.js keeps the same copy ----
{
  const src = fs.readFileSync(path.join(DASH, 'page.client.js'), 'utf8');
  const window = {};
  vm.runInNewContext(src, { window, document: { readyState: 'complete', getElementById: () => null } });
  const page = window.PlanPage;
  assert.deepStrictEqual([...page.PROJ_DAY], day, 'the page has theme.css day hues');
  assert.deepStrictEqual([...page.PROJ_NIGHT], night, 'and night hues');
  for (const n of ['a', 'alpha-svc', 'beta', 'Beta', 'x'.repeat(300), 'ünï', ...Array.from({ length: 50 }, (_, i) => `p${i}`)]) {
    assert.strictEqual(page.projectSlot(n), P.slot(n), `same slot for ${n}`);
  }
  assert.strictEqual(page.projectSlot(null), null);
}

// ------------------------------------------- served and text only ----
{
  const src = fs.readFileSync(path.join(DASH, 'projectColors.client.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no HTML sink');
  const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
  assert.match(html, /<script src="projectColors\.js"><\/script>/);
  const server = fs.readFileSync(path.join(DASH, 'server.ts'), 'utf8');
  assert.match(server, /path: '\/projectColors\.js', handle: file\('projectColors\.client\.js', JS\)/);
}

console.log('projects ok');
