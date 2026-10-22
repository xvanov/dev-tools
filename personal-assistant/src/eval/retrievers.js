'use strict';

// The retrievers the harness can score, by name.
//
// A retriever is `async (question, { limit, asOf }) => [{ id, score, snippet? }]`,
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

// Hybrid search as it ships. RRF over two lists puts a single-list rank-1 hit
// near 0.02 and an item both lists rank highly near 0.036, so 0.03 reads as
// "text and meaning agree" — a starting point for calibration, not a finding.
register(
  'search',
  async (q, { limit }) => (await require('../search').search(q, { limit })).results,
  { threshold: 0.03, describe: 'hybrid lexical + vector search (src/search)' }
);

module.exports = { register, get, names };
