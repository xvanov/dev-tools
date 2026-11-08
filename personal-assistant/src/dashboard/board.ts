'use strict';

// The Today board as columns, built once on the server so the rule is tested
// rather than spread over the page (test/board.test.js). Pure: it reads the
// state /api/state already gathered (after cards.enrich) and returns
//
//   { onMe, waiting, counts }
//
// The board is your to-do list. What someone owes you is on it only when it
// blocks you (s.blocks, commitments/blocks.js): attached to the task it holds
// up as `blockers` (the task is `blocked`), or its own card (`waitingOn`) when
// no task of yours is it. A blocker that closed in the last days is listed on
// its task as `unblocked`. The rest of what people owe you is `waiting`: not
// drawn on the page.
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
// note from your own work (s.selfNotes) is on the board only when something on
// it needs you; the rest is not drawn (Plan no longer lists them). A proposal with no commitment (a run to land) is its own card on On me.
// Two cards from the same source item with the same words are one card.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;

/** The dashboard state build() reads (server.js's /api/state). */
type State = { commitments?: Row[]; selfNotes?: { items?: Row[] }[]; needsYou?: Row[]; looksDone?: Row[]; blocks?: Row[] };
/** A board card: a commitment row plus what the board hangs on it. */
type Card = Row & {
  asks: Row[];
  chase: Row | null;
  settled: Row | null;
  blockers: Card[];
  unblocked: Row[];
  pos: number;
  selfNote?: boolean;
  standalone?: boolean;
  also?: unknown[];
  alsoIn?: unknown[];
  block?: Row;
  column?: string;
  group?: string;
  blocked?: boolean;
  waitingOn?: boolean;
};
/** A card before build() has placed it (blockers, unblocked, pos come later). */
const asCard = (o: Row) => o as Card;

const at = (x: unknown) => new Date((x || 0) as string | number).getTime();

function norm(s: unknown) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isChase(p: Row) {
  return (p?.payload as Row | undefined)?.on === 'cadence';
}

// A card for a commitment the board's own query did not return (past its
// limit, or a self-note): built from what the proposal row carries.
function synth(p: Row, from: string) {
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

function dueRank(c: Row, now: Date | string | number) {
  if (!c.due_at) return 2;
  const d = new Date(c.due_at as string);
  const today = new Date(now);
  today.setHours(23, 59, 59, 999);
  return d <= today ? 0 : 1;
}

/**
 * @param {object} s the dashboard state: commitments, selfNotes, needsYou, looksDone
 * @param {{now?: number}} [o]
 */
function build(s: State, { now = Date.now() }: { now?: Date | string | number } = {}) {
  const cards = new Map<string, Card>(); // id → card
  const order = new Map<string, number>(); // id → position in the board query (its sort)
  for (const c of s.commitments || []) {
    const id = String(c.id);
    if (cards.has(id)) continue;
    order.set(id, order.size);
    cards.set(id, asCard({ ...c, asks: [], chase: null, settled: null }));
  }
  const groups = (s.selfNotes || []).map((g: { items?: Row[] }) => ({ ...g, items: [...(g.items || [])] }));
  for (const g of groups) {
    for (const c of g.items) {
      const id = String(c.id);
      if (cards.has(id)) continue;
      cards.set(id, asCard({ ...c, asks: [], chase: null, settled: null, selfNote: true }));
    }
  }
  const cardFor = (p: Row, from: string): Card => {
    const id = String(p.commitment_id);
    if (!cards.has(id)) cards.set(id, asCard({ ...synth(p, from), asks: [], chase: null, settled: null }));
    return cards.get(id) as Card;
  };

  const standalone: Row[] = [];
  const seenAsk = new Set<string>();
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
  const byText = new Map<string, Card>();
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
    if (c.alsoIn?.length) keep.alsoIn = [...(keep.alsoIn || []), ...c.alsoIn];
    cards.delete(id);
  }

  const needsMe = (c: Card) => Boolean(c.settled) || c.asks.length > 0;
  // What people owe you, read as "does it block me?" (commitments/blocks.js).
  // Not judged yet counts as blocking with no task: shown, not lost.
  const blockOf = new Map((s.blocks || []).map((b) => [String(b.blocker_id), b]));
  const onMe: Card[] = [];
  const waiting: Card[] = [];
  for (const c of cards.values()) Object.assign(c, { blockers: [], unblocked: [] });
  for (const [id, c] of cards) {
    if (c.selfNote && !needsMe(c)) continue; // not on the board unless it needs you
    c.pos = order.get(id) ?? order.size + 1;
    if (c.direction !== 'owed_to_me') {
      onMe.push(c);
      continue;
    }
    const b: Row = blockOf.get(id) || { verdict: 'blocks', task_id: null, why: null, pending: true };
    c.block = b;
    // No counterparty on the commitment: the name the blocks pass read from the message.
    if (!c.who && b.who) c.who = b.who;
    const task = b.verdict === 'blocks' && b.task_id != null ? cards.get(String(b.task_id)) : null;
    if (task && task.direction !== 'owed_to_me' && !task.selfNote) {
      // Shown on the task it holds up, not as a card of its own.
      task.blockers.push(c);
      c.column = 'blocker';
    } else if (b.verdict === 'blocks' || c.asks.length) {
      c.waitingOn = b.verdict === 'blocks';
      onMe.push(c);
    } else {
      // Their work, not needed for yours: off the board.
      c.column = 'waiting';
      waiting.push(c);
    }
  }
  // A blocker that closed (they delivered) shows on its task as unblocked.
  for (const b of s.blocks || []) {
    if (b.status !== 'done' || b.task_id == null) continue;
    const task = cards.get(String(b.task_id));
    if (task && task.direction !== 'owed_to_me') task.unblocked.push(b);
  }
  for (const c of onMe) {
    c.column = 'onMe';
    c.blocked = c.blockers.length > 0;
    c.group = c.settled && !c.asks.length ? 'settled' : c.blocked || c.waitingOn ? 'blocked' : 'todo';
  }
  onMe.push(...standalone.map((c) => asCard({ ...c, blockers: [], unblocked: [], column: 'onMe', group: 'todo', pos: -1 })));

  // Real to-dos first — due, then ready to start (an offer waiting), then the
  // rest in the board's order — and the ones that look done last.
  // Blocked ones after the rest of the to-dos; one just unblocked goes up.
  const rank = (c: Card) => (c.group === 'settled' ? 10 : c.group === 'blocked' ? 5 : 0) +
    (c.standalone ? 0 : dueRank(c, now) === 0 || c.unblocked?.length ? 0 : c.asks.length ? 1 : 2);
  onMe.sort((a, b) => rank(a) - rank(b) || (a.group === 'settled' ? (Number(b.settled?.confidence) || 0) - (Number(a.settled?.confidence) || 0) : 0) || a.pos - b.pos);
  waiting.sort((a, b) => a.pos - b.pos);

  const todo = onMe.filter((c) => c.group === 'todo').length;
  const blocked = onMe.filter((c) => c.group === 'blocked').length;
  return {
    onMe,
    waiting,
    counts: { onMe: onMe.length, todo, blocked, settled: onMe.length - todo - blocked, waiting: waiting.length },
  };
}

module.exports = { build, norm };
