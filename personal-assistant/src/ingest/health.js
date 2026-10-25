'use strict';

// Whether the board can be trusted: which sources have stopped bringing data.
//
// The reconciler can only close what it can see. When the Microsoft 365
// connector's session expires, chat, mail and calendar stop arriving, the
// board quietly freezes, and nothing said so — it failed for three days in
// October 2026 with only a small red chip to show for it. Now a source that
// keeps failing is a banner on the dashboard and one toast per outage, with
// what to do about it.
//
//   blind(sources, now)   pure: the failing sources worth telling you about
//   pass()                the worker's check: notify once per outage

const { rows } = require('../db');
const { logger } = require('../log');

const log = logger('health');

// A poll can fail once and be fine next time; tell only when it keeps failing.
const GRACE_MINUTES = 20;

const LABEL = {
  graph_chat: 'Teams chats (Microsoft 365)',
  graph_mail: 'Outlook mail (Microsoft 365)',
  graph_event: 'Outlook calendar (Microsoft 365)',
  github: 'GitHub',
  jira: 'Jira',
};

function hintFor(source, error) {
  const e = String(error || '');
  if (/connector|\/mcp|needs-auth|not called/i.test(e)) return 'Run /mcp in Claude Code and reconnect the connector.';
  if (source === 'github' && /auth|401|gh auth/i.test(e)) return 'Run `gh auth login`.';
  return 'See `pa doctor`.';
}

/**
 * @param {Array} sources [{source, last_run_at, last_error, last_item_at}]
 * @returns {Array<{source, label, since, hint, error}>}
 */
function blind(sources, now = new Date()) {
  const out = [];
  for (const s of sources || []) {
    if (!s.last_error) continue;
    // `last_item_at` is the newest item that source ever brought: how long the
    // board has been missing it. With none, the failing run is all we know.
    const since = s.last_item_at ? new Date(s.last_item_at) : new Date(s.last_run_at || now);
    if (now - since < GRACE_MINUTES * 60_000) continue;
    out.push({ source: s.source, label: LABEL[s.source] || s.source, since: since.toISOString(), hint: hintFor(s.source, s.last_error), error: String(s.last_error).slice(0, 200) });
  }
  return out;
}

async function sources() {
  return rows(
    `select sc.source, sc.last_run_at, sc.last_error,
            (select max(si.fetched_at) from source_item si where si.source = sc.source) as last_item_at
       from sync_cursor sc order by sc.source`
  );
}

/** One toast per source per outage: the dedupe key is the newest item it brought. */
async function pass() {
  const list = blind(await sources());
  const { notify } = require('../notify');
  for (const b of list) {
    const n = await notify({
      kind: 'info',
      title: `The board may be out of date: ${b.label} is not syncing`,
      body: `Nothing new since ${new Date(b.since).toLocaleString()}, so open items that were settled there will not close. ${b.hint}`,
      dedupeKey: `health:${b.source}:${b.since}`,
    }).catch(() => null);
    if (n) log.warn('source not syncing', { source: b.source, since: b.since });
  }
  return list;
}

module.exports = { blind, pass, sources, hintFor, GRACE_MINUTES };
