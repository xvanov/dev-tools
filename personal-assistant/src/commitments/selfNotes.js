'use strict';

// Notes from my own work, kept apart from what people ask of me.
//
// The distiller reads my Claude sessions and my own PRs too, and every agent
// handoff ("verify the banner in a browser before merge", "rebase if the
// merge queue moves") became a to-do on the main list — 114 of 173 at one
// count, three for one PR, half of them a month old. They are real enough to
// keep, but they are notes to myself, not asks. So:
//
//   - SELF_NOTE (SQL) says which commitments are such notes: from a Claude
//     session, or from a GitHub item about my own PR with nobody else in it.
//   - The brief and the dashboard show them in their own section, one group
//     per PR or session (groupKey), not on "On you".
//   - expire() closes the ones nobody touched for EXPIRE_DAYS. A PR merging
//     or closing still closes them first (ingest/githubReconcile.js).

const { query } = require('../db');
const { logger } = require('../log');

const log = logger('self-notes');

const EXPIRE_DAYS = 7;

// Needs `si` (the source item) and `per` (the counterparty person) in scope.
// A GitHub item about my own PR counts only while nobody else is the
// counterparty: an issue someone filed through my key, or a meeting to-do
// where I am recorded as the other party, is still an ask.
const SELF_NOTE = `(
  si.source = 'claude_session'
  or (si.source like 'github%' and (per.id is null or coalesce(per.is_me, false)) and (
        si.raw->>'action' in ('author', 'ci_activity', 'state_change')
        or exists (select 1 from person_identity pi join person me on me.id = pi.person_id and me.is_me
                    where lower(coalesce(si.author_identity, '')) in (lower(pi.value), 'github:' || lower(pi.value)))))
)`;

/** Pure: which group a note belongs to — its PR, else its session or thread. */
function groupKey(c) {
  const text = `${c.thread_external_id || ''} ${c.summary || ''} ${c.detail || ''}`;
  const pr = /github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d+)/.exec(text);
  if (pr) return { key: `${pr[2]}#${pr[3]}`.toLowerCase(), label: `${pr[2]} PR #${pr[3]}` };
  const num = /\bPR\s*#?(\d+)\b/i.exec(c.summary || '');
  if (num && c.project) return { key: `${c.project}#${num[1]}`.toLowerCase(), label: `${c.project} PR #${num[1]}` };
  const thread = c.thread_external_id || `item:${c.id}`;
  return { key: thread, label: c.source === 'claude_session' ? `session${c.project ? ` in ${c.project}` : ''}` : c.subject || c.project || 'other' };
}

/** Pure: notes grouped, newest group first, newest note first within a group. */
function group(notes) {
  const groups = new Map();
  for (const c of notes) {
    const g = groupKey(c);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
    groups.get(g.key).items.push(c);
  }
  const at = (c) => new Date(c.occurred_at || 0).getTime();
  return [...groups.values()]
    .map((g) => ({ ...g, items: g.items.sort((a, b) => at(b) - at(a)) }))
    .sort((a, b) => at(b.items[0]) - at(a.items[0]));
}

/**
 * Closes self-notes nobody touched for EXPIRE_DAYS (dispatched ones are a
 * run's business and are left alone). Returns how many.
 */
async function expire({ days = EXPIRE_DAYS } = {}) {
  const r = await query(
    `update commitment set status = 'dropped', closed_at = now(), closed_reason = $2
      where id in (
        select c.id from commitment c
          join source_item si on si.id = c.source_item_id
          left join person per on per.id = c.counterparty_person_id
         where c.status = 'open' and c.superseded_by is null
           and coalesce(c.touched_at, si.occurred_at) < now() - ($1 || ' days')::interval
           and ${SELF_NOTE})`,
    [String(days), `expired: a note from your own work, untouched for ${days} days`]
  );
  if (r.rowCount) log.info('expired self-notes', { count: r.rowCount });
  return r.rowCount || 0;
}

module.exports = { SELF_NOTE, EXPIRE_DAYS, groupKey, group, expire };
