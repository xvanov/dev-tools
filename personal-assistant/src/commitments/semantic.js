'use strict';

// Which open commitments are the same piece of work, wherever they were said.
// Pure: commitments/dedupe.js does the reads, the embedding and model calls,
// and the writes.
//
// The review pass (memory/consolidate.js, commitments/dupes.js) only compares
// a new commitment with older ones from the same item, thread or person. The
// board still showed one ask three to five times, because people say the same
// thing in different places:
//
//   - a Teams draft lives in the "48:drafts" thread, the sent message in the
//     chat's own thread, and nobody was resolved as the counterparty of either
//     ("Get feedback on the review page" twice);
//   - "merge argocdstate#153" came from the PR thread, a 1:1 chat with one
//     person, a draft to that chat and a meeting chat — four threads, three
//     different counterparties (one of them none);
//   - a message with a numbered list became one commitment per item, and the
//     reply "I'll see what I can do on those four" became an umbrella over
//     them: a judge asked "is this a restatement?" rightly says no.
//
// So candidates here are every open commitment of the last ~60 days by
// meaning (cosine of summary + detail embeddings) or by a shared anchor (a
// PR/issue ref, a URL, a ticket key), and the judge has three answers: the
// same work, a subset of a bigger commitment (folds into the bigger one), or
// different.

const { words } = require('../distill/keep.ts');

/** Cosine similarity of two equal-length vectors, -1..1 (0 for a missing one). */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}

/** pgvector's text form "[0.1,0.2]" (or an array) to numbers. */
function parseVector(v) {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^\[|\]$/g, '');
  return s ? s.split(',').map(Number) : null;
}

/** What gets embedded for a commitment. */
function embeddingInput(c) {
  return [c.summary, c.detail].filter(Boolean).join('\n').slice(0, 4000);
}

// Hosts whose URLs name a conversation, not a piece of work: a Teams or
// Outlook link is where it was said, and two asks in one chat are not one ask.
const PLACE_HOSTS = /(^|\.)(teams\.microsoft\.com|outlook\.office\.com|outlook\.office365\.com|outlook\.live\.com|statics\.teams\.cdn\.office\.net)$/;
// Upper-case tokens that look like ticket keys and are not.
const NOT_KEYS = new Set(['UTF', 'ISO', 'SHA', 'HTTP', 'TLS', 'SSL', 'GPT', 'COVID', 'RFC', 'X', 'Q', 'H', 'P', 'AES', 'RSA', 'IPV', 'WIN', 'MP']);

/**
 * The anchors in a text: refs that name one piece of work exactly. Lower-case.
 *   "innergy-dev/argocdstate#153", "argocdstate#153",
 *   "https://github.com/innergy-dev/argocdstate/pull/153"   → "argocdstate#153"
 *   "https://engineering-review.example.com/x?y=1"         → "url:engineering-review.example.com/x"
 *   "ENG-1153"                                              → "jira:eng-1153"
 * A bare "#153" or "PR 153" says nothing about which repo: no anchor.
 * @param {string} text
 * @param {string} [threadUrl] the source item's thread, when it is a PR or issue
 */
function anchors(text, threadUrl = null) {
  const out = new Set();
  const s = String(text || '');
  const ghRe = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/([\w.-]+)\/(?:pull|issues)\/(\d+)/gi;
  for (const src of [s, String(threadUrl || '')]) {
    for (const m of src.matchAll(ghRe)) out.add(`${m[1].toLowerCase()}#${Number(m[2])}`);
  }
  // owner/repo#N or repo#N — a repo name has a letter and is not a lone word
  // like "PR" or "issue".
  for (const m of s.matchAll(/(?:^|[\s(\[`'"])(?:[\w.-]+\/)?([A-Za-z][\w.-]*[A-Za-z0-9_])#(\d+)\b/g)) {
    const repo = m[1].toLowerCase();
    if (['pr', 'mr', 'issue', 'issues', 'pull', 'ticket', 'bug', 'item', 'no', 'number'].includes(repo)) continue;
    out.add(`${repo}#${Number(m[2])}`);
  }
  for (const m of s.matchAll(/https?:\/\/[^\s)\]>"'`]+/gi)) {
    let u;
    try {
      u = new URL(m[0].replace(/[.,;:!?]+$/, ''));
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'github.com' || PLACE_HOSTS.test(host)) continue;
    out.add(`url:${host}${u.pathname.replace(/\/+$/, '').toLowerCase()}`);
  }
  for (const m of s.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)) {
    if (NOT_KEYS.has(m[1])) continue;
    out.add(`jira:${m[1].toLowerCase()}-${Number(m[2])}`);
  }
  return [...out].sort();
}

// The cosine at or above which two commitments are worth showing the judge,
// the lower one for two from the same conversation, and the floor for a pair
// that shares an anchor. Calibrated on the live board (244 open commitments,
// 29,646 pairs): unrelated pairs have a median of 0.27 and a 99th percentile
// of 0.55; restatements of one ask in different places scored 0.58-0.92, and
// most of those share an anchor; an umbrella ("I'll see what I can do on
// those four") against its own list items only 0.40-0.57 — so those are found
// through the shared thread, not the global threshold. 0.60 keeps ~0.5% of
// pairs (145): every one can go to the judge for cents.
const THRESHOLD = 0.6;
const THREAD_FLOOR = 0.38;
const ANCHOR_FLOOR = 0.3;
const MAX_CANDIDATES = 8;

/**
 * The conversation a commitment was said in, lower-case. A Teams draft is
 * filed under the pseudo-thread "48:drafts"; its link names the chat it is a
 * draft for (".../48%3Adrafts/-4.19:abc@thread.v2?..."), and that chat is the
 * thread that matters — the sent message lands there.
 */
function threadKey(thread, webUrl = null) {
  const t = String(thread || '');
  if (/^48:drafts$/i.test(t) && webUrl) {
    let u = String(webUrl);
    try {
      u = decodeURIComponent(u);
    } catch {
      /* keep it encoded */
    }
    const m = u.match(/48:drafts\/-?\d+\.(19:[^?/]+)/i);
    if (m) return m[1].toLowerCase();
  }
  return t ? t.toLowerCase() : null;
}

/**
 * Whether two commitments may be the same work at all: the same direction,
 * or either direction when one side names no counterparty (a draft or a
 * meeting note often resolves nobody, and then its direction is the
 * distiller's guess).
 */
function comparable(a, b) {
  return a.direction === b.direction || !a.has_party || !b.has_party;
}

/**
 * The open commitments worth showing the judge beside `c`, best first.
 * @param {{id, direction, has_party, thread, vector:number[], anchors:string[]}} c
 * @param {Array} pool  open, unfolded, recent — not including c
 * @returns {Array<{...o, cosine, shared:string[], sameThread:boolean}>}
 */
function candidates(c, pool, { threshold = THRESHOLD, floor = ANCHOR_FLOOR, threadFloor = THREAD_FLOOR, max = MAX_CANDIDATES } = {}) {
  const mine = new Set(c.anchors || []);
  const out = [];
  for (const o of pool) {
    if (String(o.id) === String(c.id) || !comparable(c, o)) continue;
    const cos = cosine(c.vector, o.vector);
    const shared = (o.anchors || []).filter((a) => mine.has(a));
    const sameThread = Boolean((c.thread && c.thread === o.thread) || (c.source_item_id != null && String(c.source_item_id) === String(o.source_item_id)));
    if (cos >= threshold || (shared.length && cos >= floor) || (sameThread && cos >= threadFloor)) {
      out.push({ ...o, cosine: cos, shared, sameThread });
    }
  }
  return out
    .sort((a, b) => b.cosine + 0.1 * b.shared.length - (a.cosine + 0.1 * a.shared.length) || Number(b.id) - Number(a.id))
    .slice(0, max);
}

/**
 * Every candidate pair in `items`, once each, most alike first — what the
 * judge is shown. Pairs, not clusters: a cheap model shown a cluster of eight
 * related asks grouped them by topic ("the engineering-review setup") and
 * folded separate steps into each other; asked about two at a time it keeps
 * to "would doing one discharge the other?".
 * @param {Array} items  [{id, ...}] with .vector, .anchors, .direction, .has_party, .thread
 * @returns {Array<{key, a, b, cosine, shared, sameThread}>} a < b by id
 */
function pairs(items, opts = {}) {
  const out = new Map();
  for (const i of items) {
    for (const o of candidates(i, items, opts)) {
      const [a, b] = Number(i.id) < Number(o.id) ? [String(i.id), String(o.id)] : [String(o.id), String(i.id)];
      const key = `${a}-${b}`;
      if (!out.has(key)) out.set(key, { key, a, b, cosine: o.cosine, shared: o.shared, sameThread: o.sameThread });
    }
  }
  return [...out.values()].sort((x, y) => y.cosine - x.cosine || x.key.localeCompare(y.key));
}

const VERDICTS = new Set(['same', 'subset', 'different']);

/**
 * The judge's answer, checked. One typed verdict per pair it was asked about,
 * with the two questions it rests on:
 *
 *   {"pairs": [{"pair": "12-19",
 *               "a_includes_b": true, "b_includes_a": false,
 *               "verdict": "same" | "subset" | "different",
 *               "keep": "A" | "B" | null, "why": "..."}]}
 *
 * The verdict must agree with the two answers — both yes is "same", exactly
 * one is "subset" with the one that covers the other kept, neither is
 * "different". A verdict that contradicts its own answers is read as
 * "different": a judge that disagrees with itself is unsure. "same" needs a
 * keep of A or B. A pair it was not asked about is ignored, and pairs it did
 * not answer are absent (not judged).
 * @param {string|object} answer
 * @param {Map<string, {a, b}>} asked  pair key → its ids (a = A, b = B)
 * @returns {Map<string, {verdict, keep:string|null, drop:string|null, why:string}>}
 */
function parseVerdicts(answer, asked) {
  const parsed = typeof answer === 'string' ? extractJson(answer) : answer;
  const out = new Map();
  const yes = (x) => x === true || String(x).toLowerCase() === 'true';
  for (const v of Array.isArray(parsed?.pairs) ? parsed.pairs : []) {
    const key = String(v?.pair ?? '');
    const p = asked.get(key);
    const said = String(v?.verdict || '').toLowerCase();
    if (!p || out.has(key) || !VERDICTS.has(said)) continue;
    const why = String(v?.why || '').slice(0, 200);
    const ab = yes(v?.a_includes_b);
    const ba = yes(v?.b_includes_a);
    const implied = ab && ba ? 'same' : ab || ba ? 'subset' : 'different';
    const a = String(p.a);
    const b = String(p.b);
    if (implied !== said || implied === 'different') {
      out.set(key, { verdict: 'different', keep: null, drop: null, why: implied === said ? why : `inconsistent: ${said} vs ${implied}` });
      continue;
    }
    let keep;
    if (implied === 'subset') keep = ab ? a : b;
    else {
      const k = String(v?.keep ?? '').trim().toUpperCase();
      keep = k === 'A' || k === a ? a : k === 'B' || k === b ? b : null;
    }
    if (!keep) continue;
    out.set(key, { verdict: implied, keep, drop: keep === a ? b : a, why });
  }
  return out;
}

function extractJson(text) {
  if (!text) throw new Error('empty response');
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : String(text);
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in response');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * The fold a confirmed verdict makes, or null. The judge's keep stays — the
 * bigger commitment, or the better-worded of equals — with the rule from
 * dupes.js on top: something already acted on (a run, a draft, a ledger
 * entry, your hand) is never hidden behind something that was not.
 *
 *   same,   only the dropped one acted   → swap: the acted one stays
 *   subset, only the smaller one acted   → no fold: hiding the part that was
 *                                          worked on behind an untouched
 *                                          umbrella would lose that work
 *
 * A "subset" has checks of its own, because on the live board the cheap
 * judge got "same" right and "subset" wrong about half the time — it read a
 * prerequisite or a sibling list item as a part, and often the wrong way
 * round. Here a subset only becomes a candidate (with its `cover`), and
 * `umbrellaFolds` decides which candidates fold:
 *
 *   - both were said in one conversation (pair.sameThread) and neither is a
 *     Claude session (whose one transcript holds a day of unrelated work):
 *     an umbrella and its list items come from one message and its reply.
 *     Across threads only "same" folds — or a subset of the same PR, ticket
 *     or URL (a shared anchor), which folds directly, umbrella or not;
 *   - the words set the direction: the one whose summary + detail covers
 *     more of the other's summary (`covers`) is the whole and is kept, so
 *     "do items 1-4" keeps over "do item 2", never under it; a tie folds
 *     nothing.
 *
 * @param {{verdict, keep, drop}} v  from parseVerdicts
 * @param {Map<string, {acted:boolean, summary, detail, source}>} byId
 * @param {{sameThread?:boolean}} [pair]
 * @returns {{drop:string, keep:string, relation:'same'|'subset', cover?:number}|null}
 */
function resolveVerdict(v, byId, pair = {}) {
  if (!v || v.verdict === 'different' || !v.keep || !v.drop) return null;
  const acted = (id) => Boolean(byId.get(String(id))?.acted);
  let cover;
  // A shared anchor (the same PR, ticket or URL) pins both to one object:
  // "merge X" and "merge and sync X" are one card wherever they were said.
  const anchored = Boolean(pair.shared?.length);
  if (v.verdict === 'subset') {
    const k = byId.get(String(v.keep)) || {};
    const d = byId.get(String(v.drop)) || {};
    if (!anchored && (!pair.sameThread || k.source === 'claude_session' || d.source === 'claude_session')) return null;
    const keepCovers = covers(`${k.summary || ''} ${k.detail || ''}`, d.summary);
    const dropCovers = covers(`${d.summary || ''} ${d.detail || ''}`, k.summary);
    // The judge saw a whole and a part but named the wrong one the whole:
    // the words decide which is which (for an anchored pair a tie keeps the
    // judge's pick).
    if (dropCovers > keepCovers) v = { ...v, keep: v.drop, drop: v.keep };
    else if (dropCovers === keepCovers && !anchored) return null;
    cover = Math.max(keepCovers, dropCovers);
  }
  if (acted(v.drop) && !acted(v.keep)) {
    if (v.verdict === 'subset') return null;
    return { drop: v.keep, keep: v.drop, relation: 'same' };
  }
  return v.verdict === 'subset'
    ? { drop: v.drop, keep: v.keep, relation: 'subset', cover, anchored }
    : { drop: v.drop, keep: v.keep, relation: 'same' };
}

// An umbrella is a commitment that names several others of its conversation.
const UMBRELLA_STRONG = 0.34;
const UMBRELLA_WEAK = 0.25;

/**
 * Which subset candidates fold: only into an umbrella — a keeper that at
 * least two candidates name clearly (cover ≥ 0.34). Once it is one, its other
 * candidates fold too if their words are named at all (cover ≥ 0.25). A
 * single "part of" verdict folds nothing: on the live board those were
 * prerequisites ("grant the role" → "run the setup") and siblings ("create
 * the Postgres role" → "decide the hosting target"), not parts.
 * @param {Array<{drop, keep, cover}>} subsets  from resolveVerdict
 * @returns {Array<{drop, keep, relation:'subset', cover}>}
 */
function umbrellaFolds(subsets, { strong = UMBRELLA_STRONG, weak = UMBRELLA_WEAK } = {}) {
  const byKeep = new Map();
  for (const s of subsets) {
    if (!byKeep.has(s.keep)) byKeep.set(s.keep, new Map());
    const m = byKeep.get(s.keep);
    if (!m.has(s.drop) || m.get(s.drop).cover < s.cover) m.set(s.drop, s);
  }
  const out = [];
  for (const m of byKeep.values()) {
    const parts = [...m.values()];
    if (parts.filter((p) => p.cover >= strong).length < 2) continue;
    for (const p of parts) if (p.cover >= weak) out.push({ ...p, relation: 'subset' });
  }
  // An umbrella that is itself a part of another umbrella stays a keeper:
  // its parts would otherwise end two hops from the board.
  const dropped = new Set(out.map((p) => p.drop));
  return out.filter((p) => !dropped.has(p.keep));
}

// Share of `part`'s content words that appear in `whole`, 0..1. Word stems
// (first five letters) so "creating"/"create" and "named"/"name" meet.
function covers(whole, part) {
  const stem = (w) => w.slice(0, 5);
  const x = new Set([...words(whole)].map(stem));
  const y = [...new Set([...words(part)].map(stem))];
  if (!y.length) return 0;
  return y.filter((w) => x.has(w)).length / y.length;
}

module.exports = {
  cosine, parseVector, embeddingInput, anchors, threadKey, comparable, candidates, pairs, parseVerdicts, resolveVerdict, umbrellaFolds, covers, extractJson,
  THRESHOLD, THREAD_FLOOR, ANCHOR_FLOOR, MAX_CANDIDATES, UMBRELLA_STRONG, UMBRELLA_WEAK,
};
