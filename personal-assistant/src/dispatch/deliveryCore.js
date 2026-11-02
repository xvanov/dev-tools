'use strict';

// The end state of a piece of work: what is delivered when it is finished.
// Pure — no database, no processes — so every rule is a test away
// (test/delivery.test.js).
//
// One vocabulary for both routes, shared with the factory (software-factory
// docs/JOBS-API.md, "Delivery levels"), ordered least → most autonomous:
//
//   none < branch < draft_pr < pr < auto_merge < push_to_main
//
// The operator chooses it (operator decision 2026-11-02: no ceiling). The PA
// sets it on every factory job (`--delivery`, always sent) and, for a Claude
// Code session, carries it out itself when the session ends
// (src/durable/tasks/runReview.js). Where it comes from, in order:
//
//   1. explicit   `pa do --delivery …`, or the level picked on the card at accept
//   2. mode       an explicit legacy `--mode` (local→none, branch→branch, mr/full→draft_pr)
//   3. inferred   the OPERATOR'S own words ("just open a draft", "merge it") —
//                 never a third party's message: a sentence in someone's email
//                 must not be able to say "push straight to main"
//   4. repo       the per-repo default the operator set (`pa delivery set`)
//   5. fallback   PA_DELIVERY_DEFAULT, else draft_pr

const DELIVERIES = ['none', 'branch', 'draft_pr', 'pr', 'auto_merge', 'push_to_main'];
const FALLBACK = 'draft_pr';

// A legacy PA mode, typed explicitly, read as a delivery level. `plan` is
// read-only and delivers nothing (and is never a factory job).
const DELIVERY_BY_MODE = { plan: null, local: 'none', branch: 'branch', mr: 'draft_pr', full: 'draft_pr' };

// The Claude session's own mode for a delivery level — "mapped to existing
// modes where possible". The mode is enforced in the worktree (src/dispatch/
// modes.js: a `local` worktree's pushurl is a dead address), and anything past
// what the agent may do itself is done by the assistant when the session ends:
// `pr` and `auto_merge` run as `mr` (the agent opens a draft) and the PA marks
// it ready / merges it; `push_to_main` runs as `local` — the agent can never
// write to main itself; only the PA's fast-forward push at the end does.
const MODE_BY_DELIVERY = { none: 'local', branch: 'branch', draft_pr: 'mr', pr: 'mr', auto_merge: 'mr', push_to_main: 'local' };

// Plain words for the card and the CLI. The two that need no human after the
// yes say so in so many words.
const PLAIN = {
  none: 'Stays local: commits in its own worktree, nothing is pushed.',
  branch: 'Pushes a branch. Opens no pull request.',
  draft_pr: 'Opens a draft pull request. Never marks it ready, never merges.',
  pr: 'Opens a pull request ready for review. Never merges.',
  auto_merge: 'Will merge to main automatically once its checks pass — no human review.',
  push_to_main: 'Will push straight to main — no pull request, no review.',
};
const PLAIN_FACTORY = {
  ...PLAIN,
  none: 'Stays in the factory: committed in its worktree, nothing is pushed.',
  auto_merge: 'Will merge to main automatically once the factory\'s gates and CI pass — no human review.',
  push_to_main: 'Will push straight to main once the factory\'s gates pass — no pull request, no review.',
};
const PLAIN_SESSION = {
  ...PLAIN,
  push_to_main: 'Will push straight to main when the session ends — no pull request, no review, no gates.',
};

function isDelivery(v) {
  return DELIVERIES.includes(v);
}

/** A delivery level, normalised (`draft-pr`, `Draft PR` → draft_pr), or an error. */
function delivery(v) {
  const k = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias = { draft: 'draft_pr', local: 'none', ready_pr: 'pr', merge: 'auto_merge', automerge: 'auto_merge', main: 'push_to_main' }[k];
  const d = alias || k;
  if (!isDelivery(d)) throw new Error(`unknown delivery "${v}" — one of: ${DELIVERIES.join(', ')}`);
  return d;
}

function rank(d) {
  return DELIVERIES.indexOf(d);
}

/** Needs no human after the yes. Shown loudly on the card. */
function unattended(d) {
  return d === 'auto_merge' || d === 'push_to_main';
}

function describe(d, { route = 'factory' } = {}) {
  const table = route === 'claude' ? PLAIN_SESSION : PLAIN_FACTORY;
  return table[d] || `Delivers \`${d}\`.`;
}

function deliveryForMode(modeName) {
  const k = String(modeName || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DELIVERY_BY_MODE, k)) throw new Error(`unknown mode "${modeName}"`);
  return DELIVERY_BY_MODE[k];
}

function modeFor(d) {
  return MODE_BY_DELIVERY[delivery(d)];
}

// --- inference from the operator's own words -----------------------------------

const NEG = /\b(?:don'?t|do\s+not|never|not|no|without|skip)\s+(?:\w+\s+){0,2}$/i;

// Most specific first. Each: [level, pattern]. A match preceded (within three
// words) by a negation does not count — "don't merge it" is not auto_merge.
const RULES = [
  ['push_to_main', /\b(?:push|commit|land|ship)(?:ed|ing)?\s+(?:it\s+|this\s+|that\s+)?(?:straight|directly|right)?\s*(?:to|into|on|onto)\s+(?:main|master|the\s+default\s+branch)\b/i],
  ['push_to_main', /\b(?:straight|directly)\s+(?:to|into|on)\s+(?:main|master)\b/i],
  ['none', /\b(?:don'?t|do\s+not|never|no)\s+push(?:ing)?\b/i],
  ['none', /\b(?:keep\s+it\s+local|local\s+only|stay\s+local|nothing\s+pushed|commit\s+locally)\b/i],
  ['auto_merge', /\b(?:auto[-\s]?merge|merge\s+(?:it|this|that)?\s*(?:when|once|if|after)\b|(?:and|then)\s+merge(?:\s+it)?\b|merge\s+it\b)/i],
  ['draft_pr', /\bdraft\b/i],
  ['branch', /\b(?:just\s+)?push\s+(?:the\s+|a\s+)?branch\b|\bbranch\s+only\b|\bno\s+(?:pr|pull\s+request)\b/i],
  ['pr', /\b(?:ready|real|proper|non-?draft)\s+(?:pr|pull\s+request)\b|\bready\s+for\s+review\b|\bopen\s+(?:a|the)\s+(?:pr|pull\s+request)\b/i],
];

/**
 * The delivery level the operator's own words ask for, or null when they say
 * nothing about it. Only ever given the operator's words (a `--task` they
 * typed, a chat ask) — never a third party's message.
 * @returns {{delivery: string, phrase: string}|null}
 */
function infer(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const [level, re] of RULES) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 40), m.index);
      // The `none` rules carry their own negation; for every other level a
      // negation in front cancels the match.
      if (level !== 'none' && NEG.test(before)) continue;
      return { delivery: level, phrase: m[0].trim().replace(/\s+/g, ' ') };
    }
  }
  return null;
}

/**
 * Pure. Which delivery a piece of work gets, and why.
 * @param {object} o
 * @param {string} [o.explicit]      --delivery, or the card's pick at accept
 * @param {string} [o.mode]          an explicitly typed legacy --mode
 * @param {string} [o.operatorText]  the operator's own words for the task
 * @param {string} [o.repoDefault]   the per-repo default (`pa delivery set`)
 * @param {string} [o.fallback]      PA_DELIVERY_DEFAULT
 * @returns {{delivery: string|null, source: string, phrase: string|null}}
 */
function choose({ explicit = null, mode = null, operatorText = null, repoDefault = null, fallback = null } = {}) {
  if (explicit) return { delivery: delivery(explicit), source: 'explicit', phrase: null };
  if (mode) {
    const d = deliveryForMode(mode);
    return { delivery: d, source: 'mode', phrase: null };
  }
  const said = infer(operatorText);
  if (said) return { delivery: said.delivery, source: 'inferred', phrase: said.phrase };
  if (repoDefault && isDelivery(repoDefault)) return { delivery: repoDefault, source: 'repo_default', phrase: null };
  return { delivery: fallback && isDelivery(fallback) ? fallback : FALLBACK, source: 'fallback', phrase: null };
}

/** One line on where the level came from, for the card. */
function sourceLine(source, phrase = null, slug = null) {
  switch (source) {
    case 'explicit': return 'you chose it';
    case 'mode': return 'from the mode you gave';
    case 'inferred': return phrase ? `from your words: "${phrase}"` : 'from your words';
    case 'repo_default': return `the default for ${slug || 'this repo'} (pa delivery set)`;
    default: return 'the assistant\'s default (PA_DELIVERY_DEFAULT)';
  }
}

/**
 * What the assistant does when a Claude session ends, per delivery level
 * (src/durable/tasks/runReview.js). `null` — a run from before delivery levels
 * — keeps the old behaviour (draft PR; merge only on PA_MERGE_REPOS).
 */
function finishPlan(d) {
  switch (d) {
    case 'none': return { push: false, pr: null, ready: false, merge: false, toMain: false };
    case 'branch': return { push: true, pr: null, ready: false, merge: false, toMain: false };
    case 'draft_pr': return { push: true, pr: 'draft', ready: false, merge: false, toMain: false };
    case 'pr': return { push: true, pr: 'draft', ready: true, merge: false, toMain: false };
    case 'auto_merge': return { push: true, pr: 'draft', ready: true, merge: true, toMain: false };
    case 'push_to_main': return { push: false, pr: null, ready: false, merge: false, toMain: true };
    default: return null;
  }
}

module.exports = {
  DELIVERIES,
  FALLBACK,
  DELIVERY_BY_MODE,
  MODE_BY_DELIVERY,
  isDelivery,
  delivery,
  rank,
  unattended,
  describe,
  deliveryForMode,
  modeFor,
  infer,
  choose,
  sourceLine,
  finishPlan,
};
