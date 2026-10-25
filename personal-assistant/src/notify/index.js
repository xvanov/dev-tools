'use strict';

// How the assistant speaks first.
//
// Everything proactive — a brief an hour before a meeting, a routine's
// result, a suggested routine, a request for a secret — goes through
// `notify()`: a row in `notification` (the dashboard's feed, so nothing is
// lost if the toast is missed) and a Windows toast that opens the dashboard
// when clicked.
//
// `dedupeKey` makes notify idempotent: passes run every few minutes, and the
// same meeting must not be announced twelve times. A second notify with the
// same key is a no-op and returns null.
//
// Toasts are best effort. A machine with notifications off, a locked
// session, or PowerShell missing still gets the feed row.
//
// Not every row interrupts you. `priority` (urgent | normal | digest) goes
// through the interrupt budget (budget.js): a push is a toast plus the PA
// chat (chat.js — INBOX.md, and a nudge only when the session is provably
// idle); a 'digest' row waits for the next digest (digest.js); a 'feed' row
// is the dashboard's alone. Callers that say nothing are 'normal'. A digest
// row is the digest itself and always pushes: you chose its times.

const { spawn } = require('child_process');
const { config } = require('../config');
const { one, rows, query } = require('../db');
const { logger } = require('../log');
const budget = require('./budget');

const log = logger('notify');

const KINDS = ['meeting_brief', 'meeting_debrief', 'routine', 'suggestion', 'secret_request', 'info', 'digest'];

function dashboardUrl(anchor = '') {
  return `http://${config.dispatch.host}:${config.dispatch.port}/${anchor ? `#${anchor}` : ''}`;
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Toast XML: title, up to ~4 lines of body, a click that opens `url`, and
// optional buttons that each open their own link (a meeting's join link).
function toastXml({ title, body, url, actions = [] }) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n');
  return [
    `<toast activationType="protocol" launch="${xmlEscape(url || dashboardUrl())}">`,
    '<visual><binding template="ToastGeneric">',
    `<text>${xmlEscape(title).slice(0, 120)}</text>`,
    lines ? `<text>${xmlEscape(lines).slice(0, 600)}</text>` : '',
    '</binding></visual>',
    ...(actions.length
      ? [
          '<actions>',
          ...actions
            .filter((a) => a && /^https?:\/\//.test(a.url || ''))
            .slice(0, 3)
            .map((a) => `<action content="${xmlEscape(a.label).slice(0, 40)}" activationType="protocol" arguments="${xmlEscape(a.url)}"/>`),
          '</actions>',
        ]
      : []),
    '</toast>',
  ].join('');
}

// Shows a toast through WinRT from Windows PowerShell, under PowerShell's own
// app id (registered on every Windows install, so no Start-menu shortcut or
// AUMID registration is needed). The XML travels base64-encoded so nothing in
// a title can break out of the script.
function toast({ title, body, url, actions = [] }) {
  if (process.platform !== 'win32' || !config.notify.toasts) return Promise.resolve(false);
  const xml64 = Buffer.from(toastXml({ title, body, url, actions }), 'utf8').toString('base64');
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xml64}'))`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($xml)',
    "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))',
  ].join('; ');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
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
  if (dedupeKey && (await one('select 1 from notification where dedupe_key = $1', [dedupeKey]))) return null;

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

  const row = await one(
    `insert into notification (kind, title, body, url, dedupe_key, priority, delivery)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (dedupe_key) do nothing
     returning *`,
    [kind, String(title).slice(0, 300), String(body).slice(0, 8000), url, dedupeKey, priority, verdict.delivery]
  );
  if (!row) return null;
  if (verdict.delivery === 'push') {
    const sent = [];
    const ok = await toast({ title: row.title, body: row.body, url: row.url || dashboardUrl(`notification-${row.id}`), actions });
    if (ok) sent.push('toast');
    const chat = await require('./chat').deliver(row).catch(() => ({}));
    if (chat.inbox) sent.push('chat');
    if (chat.nudged) sent.push('chat-nudge');
    if (sent.length) {
      await query(
        `update notification set channel_sent = $2::text[], toasted_at = case when $3::boolean then now() else toasted_at end where id = $1`,
        [row.id, sent, ok]
      );
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
  const r = await one('select weight from attention_weight where kind = $1', [kind]).catch(() => null);
  return r ? Number(r.weight) : 1;
}

async function pushedSince(start) {
  const r = await one(
    `select count(*)::int as n from notification where delivery = 'push' and kind <> 'digest' and created_at >= $1`,
    [start]
  );
  return r ? r.n : 0;
}

async function feed({ limit = 30, unreadOnly = false } = {}) {
  return rows(
    `select * from notification ${unreadOnly ? 'where read_at is null' : ''}
      order by created_at desc limit $1`,
    [limit]
  );
}

async function markRead(id) {
  await query('update notification set read_at = coalesce(read_at, now()) where id = $1', [id]);
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
  const { withTx } = require('../db');
  return withTx(async (client) => {
    const { rows: found } = await client.query('select * from notification where id = $1 for update', [id]);
    const n = found[0];
    if (!n) throw new Error(`no notification #${id}`);
    const kind = budget.attentionKind(n);
    const { rows: w } = await client.query('select weight from attention_weight where kind = $1 for update', [kind]);
    const before = w[0] ? Number(w[0].weight) : 1;
    const after = budget.nextWeight(before, n.feedback || null, value);
    await client.query('update notification set feedback = $2, feedback_at = now() where id = $1', [id, value]);
    await client.query(
      `insert into attention_weight (kind, weight, updated_at) values ($1, $2, now())
       on conflict (kind) do update set weight = excluded.weight, updated_at = now()`,
      [kind, after]
    );
    log.info('feedback', { id, kind, value, before, after });
    return { id: Number(id), kind, feedback: value, weight: after, previous: before };
  });
}

async function weights() {
  return rows('select kind, weight, updated_at from attention_weight order by weight, kind');
}

module.exports = { notify, feed, markRead, feedback, weights, toast, toastXml, dashboardUrl, quietHours, KINDS };
