'use strict';

// One message that commits to a list of things is one commitment.
//
// A chat message with five numbered asks became five commitments, and the
// reply "I'll see what I can do on those" an umbrella over them — six cards
// for one conversation. The prompt now says to return one commitment whose
// summary names the set and whose detail lists the items; this is the net
// under it, for when the model still splits:
//
//   umbrella  one commitment names two or more of the others (its summary +
//             detail covers their summaries' words): the others go, and are
//             listed in its detail;
//   list      the body has a numbered or bulleted list and two or more
//             commitments in the same direction, to the same party, each
//             restate a different list line: they become one commitment
//             naming the set.
//
// Pure: distill/index.js calls it on the model's answer before persisting.

const { covers } = require('../commitments/semantic');

const NAMES = 0.34; // share of a commitment's words the umbrella or list line must contain
const SPELLED = 0.6; // ... for an umbrella over a single other commitment

function sameParty(a, b) {
  return String(a.counterparty || '').toLowerCase() === String(b.counterparty || '').toLowerCase();
}

function earliest(list) {
  const due = list.map((c) => c.dueAt).filter(Boolean).sort();
  return due[0] || null;
}

function itemLines(list) {
  return list.map((c) => `- ${c.summary}`).join('\n');
}

function merged(head, parts, { summary = head.summary } = {}) {
  const all = [head, ...parts];
  const items = itemLines(parts);
  const detail = [head.detail, `Items:\n${items}`].filter(Boolean).join('\n').slice(0, 2000);
  return {
    ...head,
    summary: summary.slice(0, 300),
    detail,
    dueAt: earliest(all),
    project: head.project || parts.find((p) => p.project)?.project || null,
    projectReason: head.project ? head.projectReason : parts.find((p) => p.project)?.projectReason || null,
    confidence: Math.max(...all.map((c) => c.confidence ?? 0)),
  };
}

/** The lines of a numbered or bulleted list in a body, list markers removed. */
function listLines(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*(?:\d{1,2}[.)]|[-*•])\s+(.+)$/))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter((l) => l.length > 3);
}

/**
 * @param {Array<{direction, summary, detail, counterparty, dueAt, project, confidence}>} commitments  parsed
 * @param {string} [body]  the item's text
 * @returns {{commitments: Array, collapsed: number}}
 */
function collapse(commitments, body = '') {
  let list = [...commitments];
  let collapsed = 0;

  // Umbrella: the one that names the most others, first.
  for (;;) {
    let best = null;
    for (const u of list) {
      const text = `${u.summary} ${u.detail || ''}`;
      const parts = list.filter((c) => c !== u && c.direction === u.direction && covers(text, c.summary) >= NAMES
        // a part names less of the umbrella than the umbrella names of it
        && covers(`${c.summary} ${c.detail || ''}`, u.summary) < covers(text, c.summary));
      // Two parts make an umbrella; one part only when the umbrella all but
      // quotes it (the same message saying "those four items, and the VNET").
      const enough = parts.length >= 2 || (parts.length === 1 && covers(text, parts[0].summary) >= SPELLED);
      if (enough && (!best || parts.length > best.parts.length)) best = { u, parts };
    }
    if (!best) break;
    const one = merged(best.u, best.parts);
    list = list.filter((c) => c !== best.u && !best.parts.includes(c));
    list.unshift(one);
    collapsed += best.parts.length;
  }

  // A list in the body, restated item by item.
  const lines = listLines(body);
  if (lines.length >= 2) {
    const groups = new Map(); // direction|party → [{c, line}]
    for (const c of list) {
      let bestLine = -1;
      let bestScore = 0;
      lines.forEach((l, i) => {
        const s = covers(l, c.summary);
        if (s > bestScore) [bestLine, bestScore] = [i, s];
      });
      if (bestLine < 0 || bestScore < NAMES) continue;
      const key = `${c.direction}|${String(c.counterparty || '').toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ c, line: bestLine });
    }
    for (const g of groups.values()) {
      const distinct = new Set(g.map((x) => x.line));
      if (g.length < 2 || distinct.size < 2) continue;
      const parts = g.map((x) => x.c).filter((c, i, a) => a.indexOf(c) === i && a.every((o) => sameParty(o, c)));
      if (parts.length < 2) continue;
      const short = parts.map((p) => p.summary.replace(/[.;]+$/, ''));
      const summary = `Handle the ${parts.length} listed items: ${short.join('; ')}`;
      const head = { ...parts[0], detail: null };
      const one = merged(head, parts, { summary: summary.length > 100 ? `${summary.slice(0, 97).replace(/\s+\S*$/, '')}…` : summary });
      const at = list.indexOf(parts[0]);
      list = list.filter((c) => !parts.includes(c));
      list.splice(Math.max(0, at), 0, one);
      collapsed += parts.length - 1;
    }
  }
  return { commitments: list, collapsed };
}

module.exports = { collapse, listLines, NAMES };
