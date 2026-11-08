'use strict';

// How the assistant speaks first.
//
// Everything proactive — a brief an hour before a meeting, a routine's
// result, a suggested routine, a request for a secret — goes through
// `notify()`: a row in `notification` (the dashboard's feed, so nothing is
// lost if the toast is missed) and a desktop notification that opens the
// dashboard when clicked — a Windows toast, or notify-send on Linux — or an
// ntfy push where there is no desktop.
//
// `dedupeKey` makes notify idempotent: passes run every few minutes, and the
// same meeting must not be announced twelve times. A second notify with the
// same key is a no-op and returns null.
//
// Toasts are best effort. A machine with notifications off, a locked
// session, PowerShell or notify-send missing still gets the feed row.
//
// Not every row interrupts you. `priority` (urgent | normal | digest) goes
// through the interrupt budget (budget.js): a push is a toast plus the PA
// chat (chat.js — INBOX.md, and a nudge only when the session is provably
// idle); a 'digest' row waits for the next digest (digest.js); a 'feed' row
// is the dashboard's alone. Callers that say nothing are 'normal'. A digest
// row is the digest itself and always pushes: you chose its times.

const { config } = require('../config');
const repo = require('../repo');
const { logger } = require('../log');
const budget = require('./budget');
const ntfy = require('./ntfy');
const platform = require('../platform');

const log = logger('notify');

const KINDS = ['meeting_brief', 'meeting_debrief', 'routine', 'suggestion', 'secret_request', 'info', 'digest'];

function dashboardUrl(anchor = '') {
  return `http://${config.dispatch.host}:${config.dispatch.port}/${anchor ? `#${anchor}` : ''}`;
}

// The desktop notification is the platform's (src/platform): a WinRT toast on
// Windows, notify-send on Linux. Where none can show — a headless box, toasts
// off — ntfy (ntfy.js) takes it, if you configured a topic.
function toastXml(spec) {
  return platform.select('win32').toastXml({ ...spec, url: spec.url || dashboardUrl() });
}

async function toast({ title, body, url, actions = [] }) {
  const spec = { title, body, url: url || dashboardUrl(), actions };
  const shown = config.notify.toasts ? await platform.toast(spec).catch(() => false) : false;
  const mode = config.notify.ntfyMode;
  if (mode === 'always' || (mode === 'fallback' && !shown)) {
    const pushed = await ntfy.send(spec).catch(() => false);
    return shown || pushed;
  }
  return shown;
}

/**
 * @param {object} n
 * @param {string} n.kind       one of KINDS
 * @param {string} n.title      one line
 * @param {string} [n.body]     a few short lines; the feed shows all of it, the toast the first four
 * @param {string} [n.url]      where a click goes; defaults to the dashboard feed
 * @param {string} [n.dedupeKey] same key twice → second call is a no-op
 * @param {boolean} [n.toast=true]  false: the feed only, whatever the priority
 * @param {string} [n.priority='normal'] urgent | normal | digest (see budget.js)
 * @param {Array<{label, url}>} [n.actions] toast buttons (not stored; put the link in the body too)
 * @returns {Promise<object|null>} the row, or null when deduplicated
 */
async function notify({ kind, title, body = '', url = null, dedupeKey = null, toast: show = true, actions = [], priority = 'normal' }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown notification kind "${kind}"`);
  if (!budget.PRIORITIES.includes(priority)) throw new Error(`unknown priority "${priority}"`);
  // Dedupe before anything is decided: a repeat must not spend budget.
  if (dedupeKey && (await repo.notifications.exists(dedupeKey))) return null;

  const now = new Date();
  const verdict = !show
    ? { delivery: 'feed', reason: 'caller asked for no toast' }
    : kind === 'digest'
      ? { delivery: 'push', reason: 'the digest itself' }
      : budget.explain({
          priority,
          weight: await weightOf(budget.attentionKind({ kind, dedupeKey })),
          pushedToday: await pushedSince(budget.startOfLocalDay(now)),
          budget: config.notify.pushBudget,
          quietHours: quietHours(),
          now,
        });

  const row = await repo.notifications.insert({
    kind, title: String(title).slice(0, 300), body: String(body).slice(0, 8000), url, dedupeKey, priority, delivery: verdict.delivery,
  });
  if (!row) return null;
  if (verdict.delivery === 'push') {
    const sent = [];
    const ok = await toast({ title: row.title, body: row.body, url: row.url || dashboardUrl(`notification-${row.id}`), actions });
    if (ok) sent.push('toast');
    const chat = await require('./chat').deliver(row).catch(() => ({}));
    if (chat.inbox) sent.push('chat');
    if (chat.nudged) sent.push('chat-nudge');
    if (sent.length) {
      await repo.notifications.markSent(row.id, sent, ok);
      row.channel_sent = sent;
    }
  }
  log.info('notified', { id: row.id, kind, priority, delivery: verdict.delivery, why: verdict.reason });
  return row;
}

// A malformed PA_QUIET_HOURS must not silence everything or crash every
// pass: it is reported by `pa doctor` and treated as no quiet hours.
function quietHours() {
  try {
    return budget.parseQuietHours(config.notify.quietHours);
  } catch {
    return null;
  }
}

async function weightOf(kind) {
  return (await repo.notifications.weight(kind).catch(() => null)) ?? 1;
}

async function pushedSince(start) {
  return repo.notifications.pushedSince(start);
}

async function feed({ limit = 30, unreadOnly = false } = {}) {
  return repo.notifications.feed({ limit, unreadOnly });
}

async function markRead(id) {
  await repo.notifications.markRead(id);
  // The PA chat's INBOX.md lists unread pushes; an acked one leaves it.
  await require('./chat').writeInbox().catch(() => {});
}

/**
 * Your thumb on one notification. Moves the weight of its attention kind
 * (budget.nextWeight: bounded, and changing your mind takes the old step
 * back). `value` is 'up', 'down' or null to clear.
 */
async function feedback(id, value) {
  if (value !== 'up' && value !== 'down' && value !== null) throw new Error('feedback is up, down or null');
  return repo.withTx(async (r) => {
    const n = await r.notifications.lockById(id);
    if (!n) throw new Error(`no notification #${id}`);
    const kind = budget.attentionKind(n);
    const before = (await r.notifications.lockWeight(kind)) ?? 1;
    const after = budget.nextWeight(before, n.feedback || null, value);
    await r.notifications.setFeedback(id, value);
    await r.notifications.setWeight(kind, after);
    log.info('feedback', { id, kind, value, before, after });
    return { id: Number(id), kind, feedback: value, weight: after, previous: before };
  });
}

async function weights() {
  return repo.notifications.weights();
}

module.exports = { notify, feed, markRead, feedback, weights, toast, toastXml, dashboardUrl, quietHours, KINDS };
