'use strict';

// Which earlier open commitments a new one might restate, and which of those
// are the same ask beyond doubt. Pure: memory/consolidate.js does the reads,
// the model call for the doubtful ones, and the writes.
//
// The review pass used to compare a new commitment only with the six most
// recent open ones to the same person — or, when no person was resolved, the
// same thread. Restatements slipped past it three ways, all seen on the board:
//
//   - the same ask re-extracted from the same item or thread with a different
//     counterparty resolved (a name one time, nobody the next) was never
//     compared at all;
//   - for someone with sixty open asks, the twin was further back than six;
//   - word-for-word repeats were left to a cheap model told "when unsure,
//     null", which sometimes was.
//
// So the neighbourhood is now same item ∪ same thread ∪ same person (same
// direction), ranked by how alike the summaries are rather than how recent,
// and a near-verbatim repeat in that neighbourhood is settled here without a
// model call.

const { words } = require('../distill/keep.ts');

/** Jaccard overlap of the two summaries' content words, 0..1. */
function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// Numbers, PR/issue refs and versions: "Review ERP PRs 2021-2023" and
// "Review ERP PRs 2024-2026" share every other word and are different asks.
function refs(s) {
  return new Set([...words(s)].filter((w) => /\d/.test(w)));
}

/** Near-verbatim: the same ask with no room for a model to disagree. */
function sameAsk(a, b) {
  if (similarity(a, b) < SAME_AT) return false;
  const x = refs(a);
  const y = refs(b);
  if (x.size !== y.size) return false;
  for (const r of x) if (!y.has(r)) return false;
  return true;
}
const SAME_AT = 0.8;

/**
 * The older commitments worth showing the judge for `c`, most alike first.
 * @param {{summary}} c
 * @param {Array<{id, summary}>} pool  open, same direction, older, not c — from the same item, thread or person
 * @param {number} [n]
 */
function neighbours(c, pool, n = 6) {
  const seen = new Set();
  return pool
    .filter((o) => (seen.has(String(o.id)) ? false : seen.add(String(o.id))))
    .map((o) => ({ ...o, similarity: similarity(c.summary, o.summary) }))
    .sort((a, b) => b.similarity - a.similarity || Number(b.id) - Number(a.id))
    .slice(0, n);
}

/**
 * Which of a duplicate pair stays. The newer one normally does — it carries
 * the latest wording and deadline — but not over an older one something has
 * already acted on (a run, a draft, a ledger entry, your hand): superseding
 * that would hide the work from the board.
 * @returns {{keep, drop}} ids
 */
function survivor(newer, older) {
  if (older.acted && !newer.acted) return { keep: older.id, drop: newer.id };
  return { keep: newer.id, drop: older.id };
}

module.exports = { similarity, sameAsk, neighbours, survivor, SAME_AT };
