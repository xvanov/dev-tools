'use strict';

// lib/resources.ts: the numbers behind the sidebar's RAM / swap / disk / GPU strip.
// Plain node, no deps:  node test/resources.test.js

const assert = require('assert');
const { snapshot, parseMeminfo, parseNvidiaSmi, LEVELS } = require('../lib/resources.ts');

// RAM "used" is total minus MemAvailable (page cache is not pressure); swap is total minus free.
{
  const { mem, swap } = parseMeminfo('MemTotal:       32000 kB\nMemFree:  1000 kB\nMemAvailable:   8000 kB\nSwapTotal:  4000 kB\nSwapFree:  1000 kB\n');
  assert.deepStrictEqual(mem, { used: 24000 * 1024, total: 32000 * 1024 });
  assert.deepStrictEqual(swap, { used: 3000 * 1024, total: 4000 * 1024 });
}
// No swap configured: null, so the strip leaves the cell out instead of showing 0/0.
assert.strictEqual(parseMeminfo('MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n').swap, null);

// nvidia-smi CSV (MiB, nounits); junk and empty lines are skipped; a missing util reads null.
{
  const g = parseNvidiaSmi('NVIDIA GeForce RTX 5060 Laptop GPU, 127, 8151, 3\n\nbogus line\nTesla, 10, 100, [N/A]\n');
  assert.strictEqual(g.length, 2);
  assert.deepStrictEqual(g[0], { name: 'NVIDIA GeForce RTX 5060 Laptop GPU', used: 127 * 1048576, total: 8151 * 1048576, util: 3 });
  assert.strictEqual(g[1].util, null);
}

// Levels are ordered fractions.
for (const [k, l] of Object.entries(LEVELS)) assert.ok(l.warn > 0 && l.warn < l.danger && l.danger < 1, k);

// A live snapshot on this machine: memory and disk always read on Linux/Windows/macOS.
snapshot().then((s) => {
  assert.ok(s.mem && s.mem.total > 0 && s.mem.used >= 0, 'mem');
  assert.ok(s.disk && s.disk.total > 0, 'disk');
  assert.ok(s.gpus === null || Array.isArray(s.gpus), 'gpus');
  console.log('resources: ok');
});
