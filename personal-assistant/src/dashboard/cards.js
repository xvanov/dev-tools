'use strict';

// What every card on the dashboard needs to be acted on without guessing:
// links to where it came from (dashboard/links.js, pure) and the stored
// cause-and-effect paragraph (src/commitments/context.js, written by the
// worker). Read-only and model-free: this runs on every /api/state.
//
//   enrich(state)   adds `links` and `context` to board, Needs-you and
//                   Looks-done cards, in place, with a few batched queries
//   openSession(id) opens a Claude session item in termhub (a POST: it can
//                   start `claude --resume`, so it takes the X-PA guard)

const { config } = require('../config');
const { rows } = require('../db');
const L = require('./links');

function hubs() {
  const machines = {};
  for (const m of Object.values(config.termhub.machines || {})) machines[m.name] = m.url;
  return { local: config.termhub.url, machines };
}

const DETAIL_COLS = `c.id, c.summary, c.detail, p.gitlab_path, p.name as project_name,
       per.display_name as who, coalesce(per.is_me, false) as who_is_me,
       coalesce((select pi.value from person_identity pi where pi.person_id = per.id and pi.kind = 'smtp' order by pi.id limit 1),
                per.primary_email) as who_email,
       (select pi.value from person_identity pi where pi.person_id = per.id and pi.kind in ('github_username','github') order by pi.id limit 1) as who_github,
       si.id as item_id, si.source, si.external_id, si.thread_external_id, si.subject, si.occurred_at,
       si.raw - 'members' - 'memberEmails' - 'audioPaths' as raw,
       case when si.source = 'claude_session' then '' else left(si.body_text, 20000) end as body,
       -- The next few messages in the thread: the PR someone posted after the
       -- ask is the link the card most needs. A session's thread is its
       -- folder (other sessions), so not for those.
       case when si.source = 'claude_session' or si.thread_external_id is null then '' else
         (select string_agg(left(t.body_text, 4000), E'\\n' order by t.occurred_at)
            from (select t.body_text, t.occurred_at from source_item t
                   where t.source = si.source and t.thread_external_id = si.thread_external_id
                     and t.occurred_at > si.occurred_at
                   order by t.occurred_at limit 8) t) end as later`;

async function details(ids) {
  const from = `from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = any($1::bigint[])`;
  try {
    return await rows(`select ${DETAIL_COLS}, c.context, c.context_at ${from}`, [ids]);
  } catch (err) {
    // Before `pa migrate` has added sql/023: links still work.
    if (!/column .*context/.test(err.message)) throw err;
    return rows(`select ${DETAIL_COLS} ${from}`, [ids]);
  }
}

function itemOf(d) {
  return {
    id: d.item_id, source: d.source, external_id: d.external_id, thread_external_id: d.thread_external_id,
    subject: d.subject, occurred_at: d.occurred_at, raw: d.raw || {},
  };
}

/** Links and context for a set of commitment ids, keyed by id. */
async function forCommitments(ids, { evidenceIds = [] } = {}) {
  const want = [...new Set(ids.filter((x) => x != null).map(Number))];
  const out = new Map();
  if (!want.length) return { byId: out, evidence: new Map() };
  const [found, runs, ev] = await Promise.all([
    details(want),
    rows(`select id, commitment_id, mr_url from run where commitment_id = any($1::bigint[]) and mr_url is not null order by started_at desc`, [want]).catch(() => []),
    evidenceIds.length
      ? rows(
          `select e.id as evidence_id, si.id, si.source, si.external_id, si.thread_external_id, si.subject, si.occurred_at,
                  si.raw - 'members' - 'memberEmails' - 'audioPaths' as raw
             from ledger_evidence e join source_item si on si.id = e.source_item_id
            where e.id = any($1::bigint[])`,
          [evidenceIds.map(Number)]
        ).catch(() => [])
      : [],
  ]);
  const h = hubs();
  for (const d of found) {
    const text = [d.summary, d.detail, d.body, d.later].filter(Boolean).join('\n');
    const built = L.cardLinks({
      item: itemOf(d),
      text,
      person: d.who ? { name: d.who, email: d.who_email, github: d.who_github, is_me: d.who_is_me } : null,
      project: d.gitlab_path,
      runs: runs.filter((r) => String(r.commitment_id) === String(d.id)),
      hubs: h,
    });
    out.set(String(d.id), {
      ...built,
      context: d.context || null,
      context_at: d.context_at || null,
      who: d.who_is_me ? null : d.who,
      project: d.project_name,
      source: d.source,
      occurred_at: d.occurred_at,
      item: itemOf(d),
    });
  }
  const evidence = new Map(ev.map((e) => [String(e.evidence_id), e]));
  return { byId: out, evidence, hubs: h };
}

function attach(card, info) {
  if (!info) return card;
  card.links = info.links;
  card.sessions = info.sessions;
  card.context = info.context;
  card.context_at = info.context_at;
  if (card.who === undefined) card.who = info.who;
  if (card.project === undefined) card.project = info.project;
  if (card.source === undefined) card.source = info.source;
  if (card.occurred_at === undefined) card.occurred_at = info.occurred_at;
  return card;
}

/** Adds links and context to the cards in a dashboard state, in place. */
async function enrich(s) {
  const board = [...(s.commitments || []), ...(s.selfNotes || []).flatMap((g) => g.items || [])];
  const ids = [
    ...board.map((c) => c.id),
    ...(s.needsYou || []).map((p) => p.commitment_id),
    ...(s.looksDone || []).map((p) => p.commitment_id),
  ];
  const { byId, evidence, hubs: h } = await forCommitments(ids, { evidenceIds: (s.looksDone || []).map((p) => p.id) });
  for (const c of board) attach(c, byId.get(String(c.id)));
  for (const p of s.needsYou || []) {
    if (p.commitment_id != null) attach(p, byId.get(String(p.commitment_id)));
  }
  for (const p of s.looksDone || []) {
    const info = byId.get(String(p.commitment_id));
    const e = evidence.get(String(p.id));
    if (!info) continue;
    // The commitment's own links, then the item that suggests it is settled.
    const more = e ? L.cardLinks({ item: info.item, evidence: e, hubs: h }) : { links: [], sessions: [] };
    attach(p, {
      ...info,
      links: dedupe([...info.links, ...more.links.filter((l) => l.kind === 'evidence')]),
      sessions: [...info.sessions, ...more.sessions.filter((x) => x.role === 'evidence')],
    });
  }
  return s;
}

/**
 * Opens one of my Claude sessions in termhub on the machine it ran on: the live
 * termhub session if one is already running that conversation, else a new one
 * that resumes it (`claude --resume <id>` in its folder). The command is fixed
 * and the id must be a UUID: nothing from the item's text reaches a shell.
 */
async function openSession(itemId) {
  const { one } = require('../db');
  const item = await one(
    `select id, source, external_id, subject, occurred_at, raw from source_item where id = $1 and source = 'claude_session'`,
    [itemId]
  );
  if (!item) return { ok: false, error: `no Claude session item #${itemId}` };
  const info = L.sessionInfo(item, hubs());
  if (!info.id || !info.cwd) return { ok: false, error: 'this session has no id or folder to resume' };
  const machine = item.raw?.machine || null;
  // termhub.forMachine falls back to this machine for a name it does not know;
  // resuming another machine's folder here would start in the wrong place.
  if (machine && !config.termhub.machines[machine]) {
    return { ok: false, error: `${machine} is not in PA_MACHINES — run \`${info.resume}\` in ${info.cwd} on ${machine}` };
  }
  const hub = require('../dispatch/termhub').forMachine(machine);
  const open = (await hub.listSessions().catch(() => [])).find((s) => s.agentSessionId === info.id);
  if (open) return { ok: true, url: `${hub.base}/#session=${encodeURIComponent(open.id)}`, resumed: false };
  const exe = String(config.termhub.claudeCommand || 'claude').trim().split(/\s+/)[0] || 'claude';
  const created = await hub.createSession({
    cwd: info.cwd,
    command: `${exe} --resume ${info.id}`,
    title: String(item.subject || 'Claude session').slice(0, 60),
  });
  return { ok: true, url: `${hub.base}/#session=${encodeURIComponent(created.id)}`, resumed: true };
}

function dedupe(links) {
  const seen = new Set();
  return links.filter((l) => {
    const k = l.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { enrich, forCommitments, hubs, openSession };
