'use strict';

// A new ask of you reaches you: the Map's step from a card on the board to
// a toast (teams-ask, plan 8.4.31). Called by the distill pass right after it
// writes an item's commitments, through notify() and so through the
// interrupt budget, quiet hours and its own attention kind (`new_ask`, which
// a thumb can demote).
//
// Who interrupts:
//   - an owed_by_me commitment the model was sure of (confidence ≥ 0.5),
//     from someone else's message, at most a few hours old: a backfill or a
//     re-distillation after a prompt bump re-reads history, and old asks are
//     not news;
//   - a Teams DM or a message naming you pushes (priority normal); any other
//     ask (a group chat, mail, GitHub, Jira) goes to the digest, so a busy
//     day of review requests does not spend the budget a meeting brief needs;
//   - what you write to yourself in the self chat counts as from someone
//     else: it is how you hand yourself a task.
// One notification per item (dedupe key `new-ask:<item id>`), so an edit
// that re-distills the message does not toast it again.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;

const { logger } = require('../log.ts');

const log = logger('new-ask');

const KIND = 'new_ask';
const FRESH_MS = 3 * 3600_000;
const MIN_CONFIDENCE = 0.5;

function lower(v: unknown) {
  return String(v || '').trim().toLowerCase();
}

/** Pure. The item is the owner's own message (and not a note in the self chat). */
function fromMe(item: Row, me: Row | null) {
  const author = lower(item.author_identity);
  if (!author || !me) return false;
  return author === lower(me.primary_email) || author === lower(me.email) || author === 'me';
}

function selfChat(item: Row) {
  return item.raw?.chatType === 'self' || require('../ingest/teamsThreads.ts').isSelfChat(item.thread_external_id);
}

/** Pure. A Teams DM, the self chat, or a message that names you. */
function direct(item: Row) {
  if (item.source !== 'graph_chat') return false;
  const raw = item.raw || {};
  return raw.chatType === 'oneOnOne' || selfChat(item) || Boolean(raw.mentionsMe);
}

function shortDate(iso: unknown, tz: string | undefined) {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(tz ? { timeZone: tz } : {}) });
}

/**
 * Pure. What to notify about an item's new commitments, or null.
 * @param item      the source_item row (source, author_identity, raw, occurred_at, thread_external_id)
 * @param inserted  [{id, direction, summary, dueAt, confidence}] the commitments just written
 * @param me        identity.me(): {display_name, primary_email}
 */
function plan(item: Row, inserted: Row[], me: Row | null, { now = new Date(), tz }: { now?: Date; tz?: string } = {}) {
  if (!item || !Array.isArray(inserted)) return null;
  const at = Date.parse(item.occurred_at);
  if (!Number.isFinite(at) || now.getTime() - at > FRESH_MS) return null;
  if (fromMe(item, me) && !selfChat(item)) return null;
  const asks = inserted.filter((c) => c && c.direction === 'owed_by_me' && Number(c.confidence ?? 1) >= MIN_CONFIDENCE && c.id != null);
  if (!asks.length) return null;
  const raw = item.raw || {};
  const who = selfChat(item) ? 'You (self chat)' : raw.fromName || String(item.author_identity || '').replace(/^(aad|github):/, '') || 'Someone';
  const line = (c: Row) => {
    const due = c.dueAt ? shortDate(c.dueAt, tz) : null;
    return `${c.summary}${due ? ` — due ${due}` : ''}`;
  };
  const first = asks[0]!;
  const webUrl = typeof raw.webUrl === 'string' && /^https?:\/\/\S+$/i.test(raw.webUrl) ? raw.webUrl : null;
  return {
    kind: KIND,
    title: `${who} asks: ${line(first)}`.slice(0, 200),
    body: [...asks.slice(1, 4).map((c) => `Also: ${line(c)}`), asks.length > 4 ? `and ${asks.length - 4} more` : null, `On your board: #${asks.map((c) => c.id).join(', #')}`]
      .filter(Boolean)
      .join('\n'),
    dedupeKey: `new-ask:${item.id}`,
    priority: direct(item) ? 'normal' : 'digest',
    actions: webUrl ? [{ label: 'Open message', url: webUrl }] : [],
    commitments: asks.map((c) => Number(c.id)),
  };
}

/** Notifies about an item's new commitments when plan() says so. Never throws. */
async function tell(item: Row, inserted: Row[], me: Row | null) {
  try {
    const p = plan(item, inserted, me);
    if (!p) return null;
    const { commitments, ...n } = p;
    const row = await require('./notify.ts').notify(n);
    if (row) log.info('new ask', { item: item.id, commitments, notification: row.id, delivery: row.delivery });
    return row;
  } catch (err: any) {
    log.warn('new ask not notified', { item: item?.id, message: String(err?.message || err).slice(0, 200) });
    return null;
  }
}

module.exports = { plan, tell, fromMe, direct, KIND, FRESH_MS, MIN_CONFIDENCE };
