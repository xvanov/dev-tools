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

const { spawn } = require('child_process');
const { config } = require('../config');
const { one, rows, query } = require('../db');
const { logger } = require('../log');

const log = logger('notify');

const KINDS = ['meeting_brief', 'meeting_debrief', 'routine', 'suggestion', 'secret_request', 'info'];

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
 * @param {boolean} [n.toast=true]
 * @param {Array<{label, url}>} [n.actions] toast buttons (not stored; put the link in the body too)
 * @returns {Promise<object|null>} the row, or null when deduplicated
 */
async function notify({ kind, title, body = '', url = null, dedupeKey = null, toast: show = true, actions = [] }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown notification kind "${kind}"`);
  const row = await one(
    `insert into notification (kind, title, body, url, dedupe_key)
     values ($1,$2,$3,$4,$5)
     on conflict (dedupe_key) do nothing
     returning *`,
    [kind, String(title).slice(0, 300), String(body).slice(0, 8000), url, dedupeKey]
  );
  if (!row) return null;
  if (show) {
    const ok = await toast({ title: row.title, body: row.body, url: row.url || dashboardUrl(`notification-${row.id}`), actions });
    if (ok) await query('update notification set toasted_at = now() where id = $1', [row.id]);
  }
  log.info('notified', { id: row.id, kind });
  return row;
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
}

module.exports = { notify, feed, markRead, toast, toastXml, dashboardUrl, KINDS };
