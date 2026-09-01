'use strict';

// `pa brief` — the one command that has to be worth typing every morning.
//
// The ordering rule is the whole design: **overdue, then due, then asked but
// undated, then waiting on other people.** A brief sorted by arrival time is
// just your inbox again, and you already have one of those.
//
// Formatting is split from fetching so the layout can be tested without a
// database, and so the MCP server can return the same structure as text.

const { rows } = require('../db');

const DAY = 86400_000;

async function gather({ horizonDays = 7 } = {}) {
  const commitments = await rows(
    `select c.id, c.summary, c.detail, c.direction, c.due_at, c.status, c.confidence,
            c.project_confidence, c.repo_path,
            p.name as project, per.display_name as who, si.source, si.subject,
            si.occurred_at, si.thread_external_id
       from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.status in ('open','dispatched') and c.superseded_by is null
      order by c.due_at nulls last, c.extracted_at desc
      limit 60`
  );

  const meetings = await rows(
    `select subject, occurred_at, raw
       from source_item
      where source = 'graph_event'
        and occurred_at between now() - interval '2 hours' and now() + interval '1 day'
      order by occurred_at
      limit 20`
  );

  const reviews = await rows(
    `select subject, raw, occurred_at
       from source_item
      where source in ('gitlab_mr','gitlab_todo')
        and occurred_at > now() - interval '21 days'
      order by occurred_at desc
      limit 20`
  );

  const runsActive = await rows(
    `select id, task, mode, status, repo_path, termhub_session_id, started_at
       from run where status in ('starting','running','waiting')
      order by started_at desc limit 10`
  );

  const runsReview = await rows(
    `select id, task, mode, repo_path, mr_url, ended_at
       from run where status = 'done'
      order by ended_at desc nulls last limit 10`
  );

  return { commitments, meetings, reviews, runsActive, runsReview, horizonDays };
}

function bucket(commitment, now) {
  if (commitment.direction === 'owed_to_me') return 'waiting';
  if (!commitment.due_at) return 'undated';
  const due = new Date(commitment.due_at).getTime();
  if (due < now) return 'overdue';
  return 'due';
}

function relativeDue(due, now) {
  if (!due) return '';
  const diff = new Date(due).getTime() - now;
  const days = Math.round(diff / DAY);
  if (days < -1) return `${Math.abs(days)}d overdue`;
  if (days === -1 || (days === 0 && diff < 0)) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return `in ${days}d`;
  return new Date(due).toISOString().slice(0, 10);
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBrief(data, { now = Date.now() } = {}) {
  const lines = [];
  const buckets = { overdue: [], due: [], undated: [], waiting: [] };
  for (const c of data.commitments) buckets[bucket(c, now)].push(c);

  const section = (title, items, render) => {
    if (!items.length) return;
    lines.push('');
    lines.push(title);
    for (const item of items) lines.push(render(item));
  };

  lines.push(`Brief — ${new Date(now).toDateString()}`);

  section('OVERDUE', buckets.overdue, (c) =>
    `  ${String(c.id).padStart(4)}  ${c.summary}${c.who ? `  (${c.who})` : ''}  [${relativeDue(c.due_at, now)}]${flag(c)}`
  );
  section('DUE SOON', buckets.due.slice(0, 10), (c) =>
    `  ${String(c.id).padStart(4)}  ${c.summary}${c.who ? `  (${c.who})` : ''}  [${relativeDue(c.due_at, now)}]${flag(c)}`
  );
  section('ASKED OF YOU, NO DATE', buckets.undated.slice(0, 10), (c) =>
    `  ${String(c.id).padStart(4)}  ${c.summary}${c.who ? `  (${c.who})` : ''}${flag(c)}`
  );
  section('WAITING ON OTHERS', buckets.waiting.slice(0, 8), (c) =>
    `  ${String(c.id).padStart(4)}  ${c.summary}${c.who ? `  (${c.who})` : ''}`
  );

  section('TODAY', data.meetings, (m) => {
    const attendees = (m.raw?.attendees || []).length;
    return `  ${timeOf(m.occurred_at)}  ${m.subject}${attendees ? `  (${attendees} people)` : ''}`;
  });

  const openMrs = data.reviews.filter((r) => r.raw?.state === 'opened' || r.raw?.action);
  section('GITLAB', openMrs.slice(0, 8), (r) =>
    `  ${r.subject}${r.raw?.pipeline ? `  [pipeline ${r.raw.pipeline}]` : ''}`
  );

  section('RUNS IN FLIGHT', data.runsActive, (r) =>
    `  #${r.id}  ${r.status.padEnd(8)} ${r.mode.padEnd(6)} ${r.task}`
  );
  section('WAITING FOR YOUR REVIEW', data.runsReview, (r) =>
    `  #${r.id}  ${r.task}${r.mr_url ? `  ${r.mr_url}` : ''}`
  );

  if (lines.length === 1) lines.push('', '  Nothing outstanding. Either you are on top of it or ingest has not run.');

  return lines.join('\n');
}

// A commitment the distiller was unsure about, or whose project it guessed,
// carries a marker. Confidence you cannot see is confidence you cannot correct.
function flag(c) {
  const marks = [];
  if (c.confidence !== null && c.confidence < 0.5) marks.push('?');
  if (c.project_confidence !== null && c.project_confidence < 0.6) marks.push('?repo');
  else if (c.project) marks.push(c.project);
  return marks.length ? `  {${marks.join(' ')}}` : '';
}

async function brief(options) {
  return formatBrief(await gather(options), options);
}

module.exports = { brief, gather, formatBrief, bucket, relativeDue };
