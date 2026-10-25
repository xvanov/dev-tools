'use strict';

// The digest: what the assistant has to say that was not worth an
// interruption, said twice a day (PA_DIGEST_TIMES, 09:00 and 14:00 local).
//
// Four lists, all queries, no model call — the text is deterministic, so it
// costs nothing and says exactly what the store says:
//
//   closed for you   ledger transitions to done/dropped by anyone but you
//                    since the last digest (src/ledger: each is undoable)
//   looks done?      the reconciler's proposals still waiting for a yes/no
//   waiting on       owed-to-me items overdue, or open for over three days
//   held back        notifications the interrupt budget sent here instead of
//                    pushing (budget.js); each gets this digest's id
//
// The digest is one notification of kind 'digest' (one toast, one feed row,
// one INBOX.md entry for the PA chat), and a `digest` row holding the text
// and the ids. An empty digest is recorded (the slot is spent) and says
// nothing.
//
// Scheduling follows the routines' rule: only the latest slot at or before
// now is ever considered, and `digest.slot` is unique — so a worker that was
// down over two slots writes one digest when it comes back, never a
// backlog, and two processes cannot both write the same one.

const { config } = require('../config');
const { one, rows, query } = require('../db');
const { logger } = require('../log');

const log = logger('digest');

const WAITING_DAYS = 3;
const LIST_MAX = 8;

/** "09:00,14:00" → [{h:9,m:0},{h:14,m:0}], sorted, deduplicated. */
function parseDigestTimes(spec) {
  const out = [];
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(part);
    if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) throw new Error(`PA_DIGEST_TIMES "${spec}": "${part}" is not HH:MM`);
    out.push({ h: Number(m[1]), m: Number(m[2] || 0) });
  }
  out.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
  return out.filter((t, i) => i === 0 || t.h * 60 + t.m !== out[i - 1].h * 60 + out[i - 1].m);
}

const pad = (n) => String(n).padStart(2, '0');

/** Local 'YYYY-MM-DD HH:MM' — sorts as text in time order. */
function slotLabel(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Pure. The slot to run now, or null. Only the latest slot at or before
 * `now` (today's, or yesterday's last) is a candidate, and only if it is
 * newer than the last digest written: a missed slot runs once, never a backlog.
 */
function dueSlot({ times, now, lastSlot = null }) {
  if (!times || !times.length) return null;
  let latest = null;
  for (const dayOffset of [0, -1]) {
    for (const t of times) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, t.h, t.m, 0, 0);
      if (d <= now && (!latest || d > latest)) latest = d;
    }
    if (latest) break;
  }
  if (!latest) return null;
  const label = slotLabel(latest);
  return lastSlot && String(lastSlot) >= label ? null : label;
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function daysAgo(at, now) {
  return Math.max(0, Math.floor((now - new Date(at)) / 86_400_000));
}

/**
 * Pure. The digest's title and body from the four lists.
 * @returns {{title: string, body: string, count: number}}
 */
function renderDigest({ slot, closed = [], proposals = [], waiting = [], held = [], now = new Date() }) {
  const count = closed.length + proposals.length + waiting.length + held.length;
  const time = String(slot || '').slice(11) || slotLabel(now).slice(11);
  const parts = [
    closed.length && `${closed.length} closed`,
    proposals.length && `${proposals.length} to confirm`,
    waiting.length && `${waiting.length} waiting`,
    held.length && `${held.length} held back`,
  ].filter(Boolean);
  const title = count ? `Digest ${time} · ${parts.join(' · ')}` : `Digest ${time} · nothing new`;

  const lines = [];
  const section = (head, list, line, more) => {
    if (!list.length) return;
    if (lines.length) lines.push('');
    lines.push(`${head} (${list.length})${more ? ` — ${more}` : ''}`);
    for (const x of list.slice(0, LIST_MAX)) lines.push(`- ${line(x)}`);
    if (list.length > LIST_MAX) lines.push(`- …and ${list.length - LIST_MAX} more on the dashboard`);
  };
  section('Closed for you', closed,
    (c) => `#${c.commitment_id} ${clip(c.summary, 90)} — ${c.actor}${c.reason ? `: ${clip(c.reason, 70)}` : ''}`,
    'undo: pa ledger undo <id>');
  section('Looks done?', proposals,
    (p) => `[${p.id}] #${p.commitment_id} ${clip(p.summary, 90)} — ${Math.round(Number(p.confidence) * 100)}% sure`,
    'pa ledger looks-done <id> --yes|--no');
  section(`Waiting on others, overdue or over ${WAITING_DAYS} days`, waiting,
    (w) => `#${w.id} ${clip(w.summary, 90)} — ${[w.who, w.due_at && new Date(w.due_at) < now ? 'overdue' : null, `${daysAgo(w.extracted_at, now)}d`].filter(Boolean).join(', ')}`);
  section('Held back for this digest', held, (n) => `[${n.id}] ${clip(n.title, 110)}`);
  return { title, body: lines.join('\n'), count };
}

// ------------------------------------------------------------------ store ----

async function gather({ since, now = new Date() }) {
  const closed = await rows(
    `select t.id, t.commitment_id, t.actor, t.reason, t.to_status, t.at, c.summary
       from ledger_transition t join commitment c on c.id = t.commitment_id
      where t.actor <> 'you' and t.undone_at is null and t.to_status in ('done','dropped') and t.at > $1
      order by t.at desc`,
    [since]
  );
  const proposals = await require('../ledger/reconcile').proposals().catch(() => []);
  const waiting = await rows(
    `select c.id, c.summary, c.due_at, c.extracted_at, per.display_name as who
       from commitment c left join person per on per.id = c.counterparty_person_id
      where c.direction = 'owed_to_me' and c.status = 'open'
        and (c.due_at < $1 or c.extracted_at < $1::timestamptz - ($2 || ' days')::interval)
      order by coalesce(c.due_at, c.extracted_at)`,
    [now, String(WAITING_DAYS)]
  );
  const held = await rows(
    `select id, kind, title, url, created_at from notification
      where delivery = 'digest' and digest_id is null order by created_at`
  );
  return { closed, proposals, waiting, held };
}

/** What the digest would say right now, without writing anything. */
async function preview({ now = new Date() } = {}) {
  const last = await one('select slot, created_at from digest order by slot desc limit 1');
  const since = last ? last.created_at : new Date(now - 86_400_000);
  const lists = await gather({ since, now });
  return { ...renderDigest({ slot: slotLabel(now), ...lists, now }), since, lists };
}

/** The worker's minute tick: writes the due digest, if any. */
async function runDue({ now = new Date() } = {}) {
  const times = parseDigestTimes(config.notify.digestTimes);
  const last = await one('select slot, created_at from digest order by slot desc limit 1');
  const slot = dueSlot({ times, now, lastSlot: last?.slot });
  if (!slot) return null;
  const since = last ? last.created_at : new Date(now - 86_400_000);
  const lists = await gather({ since, now });
  const text = renderDigest({ slot, ...lists, now });
  const items = {
    closed: lists.closed.map((c) => Number(c.id)),
    proposals: lists.proposals.map((p) => Number(p.id)),
    waiting: lists.waiting.map((w) => Number(w.id)),
    held: lists.held.map((n) => Number(n.id)),
  };
  const row = await one(
    `insert into digest (slot, body, items) values ($1, $2, $3)
     on conflict (slot) do nothing returning *`,
    [slot, text.count ? `${text.title}\n\n${text.body}` : '', JSON.stringify(items)]
  );
  if (!row) return null; // another process wrote this slot
  if (items.held.length) {
    await query('update notification set digest_id = $1 where id = any($2::bigint[]) and digest_id is null', [row.id, items.held]);
  }
  if (text.count) {
    const { notify, dashboardUrl } = require('./index');
    await notify({
      kind: 'digest',
      title: text.title,
      body: text.body,
      url: dashboardUrl('feed'),
      dedupeKey: `digest:${slot}`,
    });
  }
  log.info('digest', { slot, id: row.id, closed: items.closed.length, proposals: items.proposals.length, waiting: items.waiting.length, held: items.held.length });
  return { ...row, ...text };
}

module.exports = { runDue, preview, gather, parseDigestTimes, dueSlot, slotLabel, renderDigest, WAITING_DAYS };
