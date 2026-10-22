'use strict';

// The retrievers the harness can score, by name.
//
// A retriever is `async (question, { limit, asOf }) => [{ id, score, snippet? }]`
// (or `{ results, degraded }`, see below),
// best first, where `id` is a source_item id. That is the whole contract, so a
// later memory retriever plugs in with one `register(...)` line and is judged
// on exactly the same cases as plain search.
//
// `threshold` is the retriever's own notion of "confident": abstention cases
// pass when the top score stays below it. Scores are not comparable across
// retrievers (search's are RRF sums), so each one carries its own default and
// `pa eval run --threshold` overrides it while calibrating.

const registry = new Map();

function register(name, fn, { threshold = 0, describe = '' } = {}) {
  registry.set(name, { name, fn, threshold, describe });
}

function get(name) {
  const r = registry.get(name);
  if (!r) throw new Error(`no retriever "${name}" — known: ${[...registry.keys()].join(', ')}`);
  return r;
}

function names() {
  return [...registry.keys()];
}

// A retriever may also return `{ results, degraded }`: degraded means it ran
// without a component its threshold assumes, and the run records how often.

// Search as it ships: fused legs, then a cross-encoder rerank whose score is
// an absolute relevance in [0,1]. Without the reranker the score falls back to
// RRF (~0.03) and the threshold means nothing, so that case is flagged.
// 0.55 is from the first reranked baseline: abstention top scores peaked at
// 0.52, answerable ones bottomed out there, medians 0.38 vs 0.87. Ten
// abstention cases is a small sample; recalibrate as cases grow and whenever
// search's scoring changes.
register(
  'search',
  async (q, { limit }) => {
    const r = await require('../search').search(q, { limit });
    return { results: r.results, degraded: !r.reranked };
  },
  { threshold: 0.55, describe: 'hybrid search + rerank (src/search)' }
);

// The same search with the reranker off, to measure what it adds. Its scores
// are RRF sums, so its abstention numbers are not meaningful.
register(
  'search-fused',
  async (q, { limit }) => (await require('../search').search(q, { limit, rerank: false })).results,
  { threshold: 0.03, describe: 'hybrid search, no rerank (RRF scores)' }
);

module.exports = { register, get, names };
