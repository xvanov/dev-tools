'use strict';

// Reciprocal rank fusion for hybrid search.
//
// Lexical and vector scores are not comparable — one is a tf-idf-ish number in
// an unbounded range, the other a cosine distance in [0,2]. Normalising them
// onto a common scale means inventing a conversion that is wrong in a
// different way for every query. RRF sidesteps that entirely by throwing away
// the magnitudes and keeping only the *ranks*, which are comparable by
// construction.
//
// The constant K damps the top of each list: without it, rank 1 in a list of
// three noise results outweighs rank 3 in a list of fifty good ones.

const K = 60;

/**
 * @param {Array<Array<{id:number}>>} lists  ranked lists, best first
 * @param {Array<number>} weights            per-list multiplier, defaults to 1
 * @returns {Array<{id:number, score:number, sources:number[]}>}
 */
function fuse(lists, weights = []) {
  const scores = new Map();

  lists.forEach((list, listIndex) => {
    const weight = weights[listIndex] ?? 1;
    list.forEach((row, rank) => {
      const key = row.id;
      const contribution = weight / (K + rank + 1);
      const existing = scores.get(key) || { id: key, score: 0, sources: [], row };
      existing.score += contribution;
      existing.sources.push(listIndex);
      // Keep the richest row we have seen for this id — the lexical query
      // returns a highlight the vector query does not.
      if (!existing.row || Object.keys(row).length > Object.keys(existing.row).length) {
        existing.row = row;
      }
      scores.set(key, existing);
    });
  });

  return [...scores.values()].sort((a, b) => b.score - a.score);
}

module.exports = { fuse, K };
