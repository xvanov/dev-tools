'use strict';

// Rank fusion. The property worth pinning is the one that motivated using RRF
// at all: an item both retrievers agree on must beat an item that only one of
// them ranked first, because agreement is the signal.

const assert = require('assert');
const { fuse } = require('../src/search/fuse');

{
  const lexical = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const vectorHits = [{ id: 4 }, { id: 2 }, { id: 5 }];
  const fused = fuse([lexical, vectorHits]);

  assert.strictEqual(fused[0].id, 2, 'the item both lists found should win');
  assert.deepStrictEqual(fused[0].sources, [0, 1]);
}

{
  // A single empty list must not break fusion — that is the no-embeddings case,
  // which is a supported configuration, not an error.
  const fused = fuse([[{ id: 7 }, { id: 8 }], []]);
  assert.strictEqual(fused.length, 2);
  assert.strictEqual(fused[0].id, 7);
}

{
  // Weights shift the balance without letting one list dictate outright.
  const a = [{ id: 1 }];
  const b = [{ id: 2 }];
  const lexHeavy = fuse([a, b], [2, 1]);
  assert.strictEqual(lexHeavy[0].id, 1);
  const vecHeavy = fuse([a, b], [1, 2]);
  assert.strictEqual(vecHeavy[0].id, 2);
}

{
  // The richer row survives deduplication, so a snippet from the lexical side
  // is not lost to a bare id from the vector side.
  const fused = fuse([[{ id: 1, snippet: 'hello', subject: 's' }], [{ id: 1 }]]);
  assert.strictEqual(fused[0].row.snippet, 'hello');
}

{
  assert.deepStrictEqual(fuse([]), []);
  assert.deepStrictEqual(fuse([[], []]), []);
}

console.log('hybrid.test.js ok');
