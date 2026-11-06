'use strict';

// The Today board as columns, built once on the server so the rule is tested
// rather than spread over the page (test/board.test.js). Pure: it reads the
// state /api/state already gathered (after cards.enrich) and returns
//
//   { onMe, waiting, notes, counts }
//
// One card per commitment, shown once. The page used to draw "Needs you",
// "Looks done?", "On you" and "From your own work" as separate columns from
// separate queries, so one ask could sit in three of them. Now everything
// about a commitment is attached to its one card:
//
//   settled  a "Looks done?" proposal (src/ledger/reconcile.js): the card goes
//            to On me, under "Looks done — confirm?", whatever its direction —
//            confirming is yours to do.
//   asks     prepared actions and questions (src/proposals) other than a
//            follow-up: the card goes to On me.
//   chase    the "when should I follow up?" question (durable chase task):
//            a control on the card, which stays where it is (Waiting on
//            others). It has a default, so it is not a to-do.
//
// On me is everything you must act on or confirm: your asks, then the ones
// that look done. Waiting on others is the rest of what is owed to you. A
// note from your own work leaves its folded group when something on it needs
// you. A proposal with no commitment (a run to land) is its own card on On me.
// Two cards from the same source item with the same words are one card.

const at = (x) => new Date(x || 0).getTime();

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isChase(p) {
  return p?.payload?.on === 'cadence';
}

// A card for a commitment the board's own query did not return (past its
// limit, or a self-note): built from what the proposal row carries.
function synth(p, from) {
  return {
    id: p.commitment_id,
    summary: from === 'settled' ? p.summary : p.commitment_summary || p.title,
    direction: p.direction || (isChase(p) ? 'owed_to_me' : 'owed_by_me'),
    status: 'open',
    who: p.who,
    source: p.source,
    project: p.project,
    occurred_at: p.occurred_at || p.created_at,
    links: p.links,
    sessions: p.sessions,
    context: p.context,
    context_at: p.context_at,
    item_id: p.item_id,
    synthesized: true,
  };
}

function dueRank(c, now) {
  if (!c.due_at) return 2;
  const d = new Date(c.due_at);
  const today = new Date(now);
  today.setHours(23, 59, 59, 999);
  return d <= today ? 0 : 1;
}

/**
 * @param {object} s the dashboard state: commitments, selfNotes, needsYou, looksDone
 * @param {{now?: number}} [o]
 */
function build(s, { now = Date.now() } = {}) {
  const cards = new Map(); // id → card
  const order = new Map(); // id → position in the board query (its sort)
  for (const c of s.commitments || []) {
    const id = String(c.id);
    if (cards.has(id)) continue;
    order.set(id, order.size);
    cards.set(id, { ...c, asks: [], chase: null, settled: null });
  }
  const groups = (s.selfNotes || []).map((g) => ({ ...g, items: [...(g.items || [])] }));
  for (const g of groups) {
    for (const c of g.items) {
      const id = String(c.id);
      if (cards.has(id)) continue;
      cards.set(id, { ...c, asks: [], chase: null, settled: null, selfNote: true });
    }
  }
  const cardFor = (p, from) => {
    const id = String(p.commitment_id);
    if (!cards.has(id)) cards.set(id, { ...synth(p, from), asks: [], chase: null, settled: null });
    return cards.get(id);
  };

  const standalone = [];
  const seenAsk = new Set();
  for (const p of s.needsYou || []) {
    if (seenAsk.has(String(p.id))) continue;
    seenAsk.add(String(p.id));
    if (p.commitment_id == null) {
      standalone.push({ id: `p${p.id}`, standalone: true, summary: p.title, asks: [p], occurred_at: p.created_at });
      continue;
    }
    const card = cardFor(p, 'ask');
    if (isChase(p)) {
      // Two follow-up questions on one ask (should not happen): the newest.
      if (!card.chase || at(p.created_at) > at(card.chase.created_at)) card.chase = p;
    } else card.asks.push(p);
  }
  for (const p of s.looksDone || []) {
    const card = cardFor(p, 'settled');
    if (!card.settled || at(p.created_at) > at(card.settled.created_at)) card.settled = p;
  }

  // Same source item, same words: one card. The first one seen is kept (the
  // board's own order, so an ask before a note) and takes the other's
  // proposals; `also` lists the ids folded into it.
  const byText = new Map();
  for (const [id, c] of [...cards]) {
    if (c.item_id == null) continue;
    const k = `${c.item_id}|${c.direction}|${norm(c.summary)}`;
    const keep = byText.get(k);
    if (!keep) {
      byText.set(k, c);
      continue;
    }
    keep.asks.push(...c.asks);
    keep.chase = keep.chase || c.chase;
    keep.settled = keep.settled || c.settled;
    keep.also = [...(keep.also || []), c.id];
    cards.delete(id);
  }

  const needsMe = (c) => Boolean(c.settled) || c.asks.length > 0;
  const onMe = [];
  const waiting = [];
  for (const [id, c] of cards) {
    if (c.selfNote && !needsMe(c)) continue; // stays in its folded group
    if (c.direction === 'owed_by_me' || needsMe(c)) onMe.push(c);
    else waiting.push(c);
    c.column = c.direction === 'owed_by_me' || needsMe(c) ? 'onMe' : 'waiting';
    c.group = c.column === 'onMe' && c.settled && !c.asks.length ? 'settled' : 'todo';
    c.pos = order.has(id) ? order.get(id) : order.size + 1;
  }
  onMe.push(...standalone.map((c) => ({ ...c, column: 'onMe', group: 'todo', pos: -1 })));

  // Real to-dos first — due, then ready to start (an offer waiting), then the
  // rest in the board's order — and the ones that look done last.
  const rank = (c) => (c.group === 'settled' ? 10 : 0) + (c.standalone ? 0 : dueRank(c, now) === 0 ? 0 : c.asks.length ? 1 : 2);
  onMe.sort((a, b) => rank(a) - rank(b) || (a.group === 'settled' ? (b.settled.confidence || 0) - (a.settled.confidence || 0) : 0) || a.pos - b.pos);
  waiting.sort((a, b) => a.pos - b.pos);

  // Notes from your own work, less what moved to On me.
  const shown = new Set(onMe.map((c) => String(c.id)));
  const notes = groups
    .map((g) => ({ ...g, items: g.items.filter((c) => !shown.has(String(c.id)) && cards.has(String(c.id))).map((c) => cards.get(String(c.id))) }))
    .filter((g) => g.items.length);

  const todo = onMe.filter((c) => c.group === 'todo').length;
  return {
    onMe,
    waiting,
    notes,
    counts: { onMe: onMe.length, todo, settled: onMe.length - todo, waiting: waiting.length, notes: notes.reduce((n, g) => n + g.items.length, 0) },
  };
}

module.exports = { build, norm };
