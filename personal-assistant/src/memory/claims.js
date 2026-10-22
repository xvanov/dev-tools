'use strict';

// The pure half of the memory layer: no database, no model. Everything that
// decides whether a claim is believed, whether its evidence is real, and what a
// model's answer means lives here, where a test can reach it.

const crypto = require('crypto');

const SUBJECT_KINDS = ['person', 'project', 'me', 'topic'];
const CLAIM_KINDS = [
  'role', 'expertise', 'ownership', 'preference', 'decision',
  'status', 'relationship', 'blocker', 'reference', 'workflow',
];
const DECISIONS = ['ADD', 'SUPERSEDE', 'DUPLICATE', 'NOOP'];

// ------------------------------------------------------------- evidence ----

// Folds the differences a model introduces when it copies text — curly quotes,
// dashes, markdown quote marks, runs of whitespace, case — so that "verbatim"
// means the words, not the bytes.
function normalise(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/^\s*>+\s?/gm, ' ')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function words(text) {
  return normalise(text).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [];
}

// Is `quote` really in `body`? Returns how it was found:
//
//   'exact'     — the whole quote, after normalising.
//   'fragments' — the model elided with "..."; every piece of 12+ characters
//                 is present, in order.
//   'fuzzy'     — not verbatim, but 85% of its words appear in one window of
//                 the body. Close enough to keep for review, not to believe.
//   null        — not there. The claim's evidence is invented; drop it.
function verifyQuote(quote, body) {
  // Models like to wrap a quote in quote marks; those are not part of it.
  const q = normalise(quote).replace(/^["'\s]+|["'\s]+$/g, '');
  const b = normalise(body);
  if (!q || q.length < 8 || !b) return null;
  if (b.includes(q)) return 'exact';

  const pieces = q.split(/\s*\.\.\.+\s*|\s*\[\.\.\.\]\s*/).map((p) => p.trim()).filter(Boolean);
  if (pieces.length > 1 && pieces.every((p) => p.length >= 12)) {
    let from = 0;
    let ok = true;
    for (const p of pieces) {
      const at = b.indexOf(p, from);
      if (at < 0) {
        ok = false;
        break;
      }
      from = at + p.length;
    }
    if (ok) return 'fragments';
  }

  const qw = words(q);
  const bw = words(b);
  if (qw.length < 4 || !bw.length) return null;
  const width = Math.ceil(qw.length * 1.5);
  const need = new Map();
  for (const w of qw) need.set(w, (need.get(w) || 0) + 1);
  for (let start = 0; start < bw.length; start += Math.max(1, Math.floor(qw.length / 3))) {
    const window = new Map();
    for (const w of bw.slice(start, start + width)) window.set(w, (window.get(w) || 0) + 1);
    let hit = 0;
    for (const [w, n] of need) hit += Math.min(n, window.get(w) || 0);
    if (hit / qw.length >= 0.85) return 'fuzzy';
  }
  return null;
}

// ------------------------------------------------------ model responses ----

// Every balanced top-level JSON value in `text`, in order. String-aware, so a
// brace inside a quote does not end an object early.
function jsonValues(text) {
  const s = String(text);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const open = s.slice(i).search(/[[{]/);
    if (open < 0) break;
    const start = i + open;
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = start; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      out.push(JSON.parse(s.slice(start, end + 1)));
      i = end + 1;
    } catch {
      i = start + 1;
    }
  }
  return out;
}

// Models wrap JSON in fences, add a sentence before or after it, and now and
// then answer in two objects. The whole reply is tried first; failing that,
// every balanced value is collected and their arrays concatenated by key.
function extractJson(text) {
  if (!text) throw new Error('empty response');
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : String(text);
  try {
    return JSON.parse(body.trim());
  } catch {
    // fall through to scanning
  }
  const values = jsonValues(fenced ? body : text);
  if (!values.length) throw new Error('no JSON in response');
  if (values.length === 1) return values[0];
  const merged = {};
  for (const v of values) {
    if (Array.isArray(v)) {
      merged.items = (merged.items || []).concat(v);
      continue;
    }
    for (const [k, val] of Object.entries(v || {})) {
      merged[k] = Array.isArray(val) && Array.isArray(merged[k]) ? merged[k].concat(val) : merged[k] ?? val;
    }
  }
  return merged;
}

function clamp01(v, fallback = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function isoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// The claims pass answers for several items at once. Each claim names the item
// it came from; a claim naming an item that was not in the batch is dropped,
// because its quote cannot be checked against anything.
function parseClaimsResponse(text, itemIds) {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.claims) ? parsed.claims : [];
  const allowed = new Set((itemIds || []).map(String));
  const out = [];
  for (const c of list) {
    if (!c || typeof c.text !== 'string' || !c.text.trim()) continue;
    if (!allowed.has(String(c.item))) continue;
    const kind = String(c.kind || '').toLowerCase();
    if (!CLAIM_KINDS.includes(kind)) continue;
    const subj = c.subject || {};
    const subjectKind = String(subj.kind || '').toLowerCase();
    if (!SUBJECT_KINDS.includes(subjectKind)) continue;
    const ref = subj.ref ? String(subj.ref).trim() : '';
    if (subjectKind !== 'me' && !ref) continue;
    out.push({
      itemId: String(c.item),
      subjectKind,
      subjectRef: ref || 'me',
      subjectName: subj.name ? String(subj.name).trim().slice(0, 200) : null,
      kind,
      text: c.text.trim().slice(0, 400),
      quote: c.quote ? String(c.quote).trim().slice(0, 600) : '',
      confidence: clamp01(c.confidence),
      validFrom: isoOrNull(c.valid_from),
      validUntil: isoOrNull(c.valid_until),
    });
  }
  return out;
}

// One consolidation decision per new claim. A target that was not among that
// claim's candidates is a hallucinated id; the claim is kept (ADD) rather than
// letting the model supersede something it was never shown.
function parseDecisions(text, candidatesByClaim) {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const out = new Map();
  for (const d of list) {
    if (!d) continue;
    const claimId = String(d.claim ?? d.id ?? '');
    if (!candidatesByClaim.has(claimId) || out.has(claimId)) continue;
    let action = String(d.action || d.decision || '').toUpperCase();
    if (!DECISIONS.includes(action)) action = 'ADD';
    let target = d.target == null ? null : String(d.target);
    if (action === 'SUPERSEDE' || action === 'DUPLICATE') {
      const allowed = candidatesByClaim.get(claimId).map(String);
      if (!target || !allowed.includes(target)) {
        action = 'ADD';
        target = null;
      }
    } else {
      target = null;
    }
    out.set(claimId, { action, target, reason: d.reason ? String(d.reason).slice(0, 300) : null });
  }
  // Anything the model skipped is kept: silence is not a reason to forget.
  for (const id of candidatesByClaim.keys()) {
    if (!out.has(id)) out.set(id, { action: 'ADD', target: null, reason: 'no decision returned' });
  }
  return out;
}

// The dream pass's dedupe answer: groups of claims about one subject that say
// the same thing. Ids outside the subject's list, a claim kept and dropped at
// once, or a claim dropped twice are ignored rather than trusted.
function parseMerges(text, allowedIds) {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.duplicates) ? parsed.duplicates : [];
  const allowed = new Set((allowedIds || []).map(String));
  const dropped = new Set();
  const kept = new Set();
  const out = [];
  for (const g of list) {
    if (!g) continue;
    const keep = String(g.keep ?? '');
    if (!allowed.has(keep) || dropped.has(keep)) continue;
    const drop = (Array.isArray(g.drop) ? g.drop : [])
      .map(String)
      .filter((id) => allowed.has(id) && id !== keep && !dropped.has(id) && !kept.has(id));
    if (!drop.length) continue;
    kept.add(keep);
    for (const id of drop) dropped.add(id);
    out.push({ keep, drop });
  }
  return out;
}

// --------------------------------------------------------------- time -----

// Bitemporal belief. A claim is *believed as of T* when the store had recorded
// it by T and had not yet stopped believing it; it is *valid as of T* when the
// world it describes held at T. "What did we think on the 3rd about the 1st"
// is believedAsOf(c, 3rd) && validAsOf(c, 1st).
function t(v) {
  return v == null ? null : new Date(v).getTime();
}

function believedAsOf(claim, asOf = new Date()) {
  const at = t(asOf);
  if (t(claim.recorded_at) != null && t(claim.recorded_at) > at) return false;
  if (claim.expired_at != null && t(claim.expired_at) <= at) return false;
  if (claim.status === 'retracted') return false;
  // pending_review is believed by nobody until a human says so.
  if (claim.status === 'pending_review') return false;
  return true;
}

function validAsOf(claim, asOf = new Date()) {
  const at = t(asOf);
  if (claim.valid_at != null && t(claim.valid_at) > at) return false;
  if (claim.invalid_at != null && t(claim.invalid_at) <= at) return false;
  return true;
}

function currentAsOf(claim, asOf = new Date()) {
  return believedAsOf(claim, asOf) && validAsOf(claim, asOf);
}

// Status claims describe a moment ("is on leave this week", "is mid-migration")
// and rot quietly. A status with no stated end is assumed stale after
// `statusDays`; a blocker after `blockerDays`. Everything else is durable
// until something supersedes it.
function isStale(claim, now = new Date(), { statusDays = 21, blockerDays = 45 } = {}) {
  if (claim.status !== 'active') return false;
  const at = t(now);
  if (claim.invalid_at != null && t(claim.invalid_at) <= at) return true;
  const age = (at - t(claim.valid_at || claim.recorded_at)) / 86400_000;
  if (claim.kind === 'status') return age > statusDays;
  if (claim.kind === 'blocker') return age > blockerDays;
  return false;
}

// The nightly pass runs once a day after `hour` local time, and regardless
// once a day and a half has gone by (a laptop asleep at night still dreams).
function dreamDue(now, lastRun, hour) {
  if (!lastRun) return true;
  const since = (t(now) - t(lastRun)) / 3600_000;
  if (since >= 36) return true;
  return since >= 20 && new Date(now).getHours() >= hour;
}

// --------------------------------------------------------------- pages ----

// A page is regenerated only when what it is made of changed. The hash covers
// the ids and texts of the active claims and the state of the commitments that
// feed it, plus the page prompt version — so a new prompt rebuilds every page
// once, and an unchanged person costs nothing.
function factsHash({ claims = [], commitments = [], extra = [], version = '' }) {
  const h = crypto.createHash('sha256');
  h.update(`v:${version}\n`);
  for (const c of [...claims].sort((a, b) => Number(a.id) - Number(b.id))) {
    h.update(`c:${c.id}:${c.status || 'active'}:${c.text}\n`);
  }
  for (const c of [...commitments].sort((a, b) => Number(a.id) - Number(b.id))) {
    h.update(`k:${c.id}:${c.status}:${c.due_at ? new Date(c.due_at).toISOString() : ''}\n`);
  }
  for (const e of extra) h.update(`x:${e}\n`);
  return h.digest('hex').slice(0, 32);
}

// Rough token count for budget checks: four characters a token is close enough
// to keep the profile under its ceiling without a tokenizer dependency.
function approxTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function truncateToTokens(text, maxTokens) {
  const s = String(text || '');
  const max = maxTokens * 4;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.7 ? cut.slice(0, nl) : cut).trimEnd() + '\n\n_(truncated)_';
}

// Bodies can be very long (a coding session transcript); the start says what
// the work was and the end says where it landed.
function headTail(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  return `${s.slice(0, head)}\n[... ${s.length - max} characters omitted ...]\n${s.slice(s.length - (max - head))}`;
}

module.exports = {
  SUBJECT_KINDS,
  CLAIM_KINDS,
  DECISIONS,
  normalise,
  verifyQuote,
  extractJson,
  parseClaimsResponse,
  parseDecisions,
  parseMerges,
  dreamDue,
  believedAsOf,
  validAsOf,
  currentAsOf,
  isStale,
  factsHash,
  approxTokens,
  truncateToTokens,
  headTail,
};
