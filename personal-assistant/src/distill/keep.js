'use strict';

// What re-distilling an item may change about the commitments it already has.
//
// An item is distilled again whenever its content changes — a Teams edit, a
// Claude session that grew, a PR whose body was rewritten. That pass used to
// delete every commitment the item had and insert fresh open ones, so a
// commitment closed by hand, by a merged PR or by the reconciler came back
// open, and its drafts (on delete cascade) went with it. Now:
//
//   - a commitment someone or something acted on (closed, dispatched,
//     touched, drafted for, judged, in the ledger) is kept as it is;
//   - an untouched open one the new extraction says again is kept too, so it
//     keeps its id and its history;
//   - only untouched open ones the new extraction no longer contains go;
//   - a new extraction that restates a kept commitment is not inserted.
//
// Pure: the caller supplies the rows and does the writes.

const STOP = new Set(
  'the and for with that this from have will your you are was were not but can all any its into out our their them then than about after before over also just only some what when where which while who how why to of in on at by be is it or as do if so up a an'.split(' ')
);

function words(s) {
  return new Set((String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9._#/-]*/g) || []).filter((w) => w.length > 1 && !STOP.has(w)));
}

/** Whether two summaries state the same commitment: most of their words in common. */
function same(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.6;
}

/**
 * @param {Array} existing   [{id, status, summary, touched: boolean, refs: boolean}] the item's commitments
 * @param {Array} extracted  [{summary, ...}] the new extraction
 * @returns {{remove: Array<id>, insert: Array, keep: Array<id>}}
 */
function plan(existing, extracted) {
  const acted = existing.filter((c) => c.status !== 'open' || c.touched || c.refs);
  const untouched = existing.filter((c) => !acted.includes(c));
  const keep = new Set(acted.map((c) => c.id));
  const insert = [];
  for (const n of extracted) {
    if (acted.some((c) => same(c.summary, n.summary))) continue;
    const again = untouched.find((c) => !keep.has(c.id) && same(c.summary, n.summary));
    if (again) keep.add(again.id);
    else insert.push(n);
  }
  return { keep: [...keep], remove: untouched.filter((c) => !keep.has(c.id)).map((c) => c.id), insert };
}

module.exports = { plan, same };
