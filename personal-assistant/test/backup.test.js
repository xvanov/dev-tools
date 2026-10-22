'use strict';

// Backup naming and rotation: the newest dump must never be the one pruned,
// and names must sort by time so "newest" is just the first in the list.

const assert = require('assert');
const { stamp, toPrune } = require('../src/backup');

{
  assert.strictEqual(stamp(new Date('2026-03-04T05:06:07Z')), '20260304-050607');
  const a = `pa-${stamp(new Date('2026-03-04T05:06:07Z'))}.dump`;
  const b = `pa-${stamp(new Date('2026-12-01T00:00:00Z'))}.dump`;
  assert.ok(b > a, 'later dumps sort after earlier ones');
}

{
  const backups = ['d5', 'd4', 'd3', 'd2', 'd1']; // newest first, as list() returns
  assert.deepStrictEqual(toPrune(backups, 3), ['d2', 'd1']);
  assert.deepStrictEqual(toPrune(backups, 10), []);
  // keep=0 is a misconfiguration, not an instruction to delete everything.
  assert.deepStrictEqual(toPrune(backups, 0), ['d4', 'd3', 'd2', 'd1']);
}

{
  const { wslPath } = require('../src/backup');
  assert.strictEqual(wslPath('C:\\Users\\Quill\\App Data\\pa.dump'), '/mnt/c/Users/Quill/App Data/pa.dump');
  assert.strictEqual(wslPath('D:/backups/pa.dump'), '/mnt/d/backups/pa.dump');
}

{
  // Extensions are commented out of the restore list; tables are not.
  const { restoreList } = require('../src/backup');
  const listing = [
    '2; 3079 16386 EXTENSION - vector ',
    '3830; 0 0 COMMENT - EXTENSION vector',
    '215; 1259 16400 TABLE public source_item pa',
  ].join('\n');
  assert.deepStrictEqual(restoreList(listing).split('\n'), [
    ';2; 3079 16386 EXTENSION - vector ',
    ';3830; 0 0 COMMENT - EXTENSION vector',
    '215; 1259 16400 TABLE public source_item pa',
  ]);
}

console.log('backup.test.js ok');
