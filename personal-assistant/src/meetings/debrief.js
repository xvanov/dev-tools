'use strict';

// Post-meeting debriefs: minutes after a recorded meeting or call ends, what
// it means for you — your new to-dos, what others promised you, news about
// work already on your list, and decisions that change it. Nothing else.
//
//   pass()                      the worker's audio pass: roll capture when a
//                               meeting ends, debrief what is over
//   debrief(target, opts)       one debrief, for an episode id or 'last'
//   undo(debriefId, index)      take back one applied item
//   recent({days})              debriefs for the dashboard
//
// One model call per meeting (debriefCore.SYSTEM) sees the whole transcript
// with your open commitments, PRs and tickets beside it, so news about an
// existing task becomes an update to it, not a second copy. Every item comes
// back with a verbatim quote, checked against the transcript before anything
// is written; what fails is dropped. Each write is recorded in
// `meeting_debrief.applied` with what it replaced, so any one can be undone.
//
// The meeting-learning step (index.js learnRecent) still reads the same
// transcript for the series profile; this does not repeat it. The generic
// distiller skips these items (distill DEBRIEF_OWNED).

const llm = require('../llm');
const { config } = require('../config');
const { rows, one, query, withTx } = require('../db');
const { logger } = require('../log');
const { headTail } = require('../memory/claims');
const spool = require('../audio/spool');
const { attendable, eventRange } = require('../audio/episodes');
const core = require('./core');
const D = require('./debriefCore');

const log = logger('debrief');

const MIN_CHARS = 400;
// A meeting that grows after its debrief is debriefed again only when this
// much more was said; a goodbye is not worth a model call.
const REGROW_CHARS = 1500;
const MAX_TRANSCRIPT = 90_000;

// ------------------------------------------------------------- loading ----

const EPISODE_SQL = `
  select e.*, si.body_text, si.subject as item_subject, si.content_hash,
         ev.subject as event_subject, ev.raw as event_raw, ev.id as event_item_id, ev.occurred_at as event_occurred_at,
         ev.external_id as event_external_id, ev.author_identity as event_organizer, ev.body_text as event_body
    from audio_episode e
    join source_item si on si.id = e.source_item_id
    left join source_item ev on ev.source = 'graph_event' and ev.external_id = e.calendar_event_id`;

// Both streams, or the "Me:" label would be wrong: a mic-only recording of
// a room puts everyone's words in your mouth, and a to-do read from that is
// someone else's.
const OWNED = `e.kind in ('meeting','call') and e.state <> 'superseded'
   and e.stream like '%loopback%' and e.stream like '%mic%' and length(si.body_text) >= ${MIN_CHARS}`;

async function loadEpisode(target) {
  const t = String(target ?? 'last').trim();
  if (t === 'last') {
    return one(`${EPISODE_SQL} where ${OWNED} order by e.ended_at desc limit 1`);
  }
  if (!/^\d+$/.test(t)) throw new Error(`episode must be an id or "last", not "${t}"`);
  return one(`${EPISODE_SQL} where e.id = $1`, [Number(t)]);
}

function meetingOf(ep) {
  const ev = ep.event_raw ? core.toMeeting({ id: ep.event_item_id, external_id: ep.event_external_id, subject: ep.event_subject, raw: ep.event_raw, occurred_at: ep.event_occurred_at, author_identity: ep.event_organizer, body_text: ep.event_body }) : null;
  return {
    title: ev?.subject || ep.item_subject || 'Recorded conversation',
    seriesKey: ev?.seriesKey || null,
    kind: ep.kind,
    start: new Date(ep.started_at).toISOString(),
    end: new Date(ep.ended_at).toISOString(),
    eventEnd: ev ? ev.end : null,
    attendees: ev?.attendees || [],
  };
}

async function namesFor(emails) {
  if (!emails.length) return [];
  const found = await rows(
    `select lower(coalesce(pi.value, p.primary_email)) as email, p.display_name
       from person p left join person_identity pi on pi.person_id = p.id and pi.kind = 'smtp'
      where lower(p.primary_email) = any($1::text[]) or pi.value = any($1::text[])`,
    [emails]
  );
  const byEmail = new Map(found.map((r) => [r.email, r.display_name]));
  return emails.map((email) => ({ email, name: byEmail.get(email) || null }));
}

async function openCommitments(attendeeEmails) {
  return rows(
    `select c.id, c.direction, c.summary, c.detail, c.due_at, c.status, c.closed_at, c.closed_reason,
            p.display_name as counterparty, lower(p.primary_email) as counterparty_email
       from commitment c left join person p on p.id = c.counterparty_person_id
      where c.status in ('open','dispatched') and c.superseded_by is null
      order by (lower(p.primary_email) = any($1::text[])) desc nulls last, c.due_at nulls last, c.extracted_at desc
      limit 80`,
    [attendeeEmails]
  );
}

async function openTasks(ctx) {
  const tasks = [];
  if (ctx.githubLogin) {
    const prs = await rows(
      `select id, subject, raw from source_item
        where source = 'github_pr' and author_identity = $1 and raw->>'state' = 'opened'
          and occurred_at > now() - interval '60 days'
        order by occurred_at desc limit 15`,
      [`github:${ctx.githubLogin}`]
    );
    for (const p of prs) tasks.push({ id: p.id, kind: 'pr', label: p.subject, status: p.raw?.draft ? 'draft' : 'open' });
  }
  const mine = [ctx.name, ...ctx.myEmails].filter(Boolean).map((s) => s.toLowerCase());
  const jira = await rows(
    `select id, subject, raw from source_item
      where source = 'jira_issue' and raw->>'state' = 'opened' and lower(raw->>'assignee') = any($1::text[])
      order by occurred_at desc limit 20`,
    [mine]
  );
  for (const j of jira) tasks.push({ id: j.id, kind: 'jira', label: j.subject, status: j.raw?.status || null });
  return tasks;
}

// ------------------------------------------------------------ resolving ----

async function personFor(counterparty, attendees) {
  if (!counterparty) return null;
  const identity = require('../distill/identity');
  const c = String(counterparty).trim();
  if (c.includes('@')) return identity.resolve(c.toLowerCase());
  // A name: an attendee whose name or address matches it, else a person
  // whose name is unambiguous. Never a new person from a spoken name.
  const lc = c.toLowerCase();
  const hit = attendees.find((a) => (a.name && a.name.toLowerCase().includes(lc)) || a.email.split('@')[0].replace(/[._-]+/g, ' ').includes(lc));
  if (hit) return identity.resolve(hit.email);
  return identity.resolve(c);
}

// ------------------------------------------------------------ planning ----

/**
 * Reads the meeting and decides what to write, without writing it.
 * @returns {Promise<{episode, meeting, plan, parsed}>}
 */
async function prepare(ep, { now = new Date() } = {}) {
  const meetings = require('./index');
  const ctx = await meetings.context();
  const m = meetingOf(ep);
  const attendees = await namesFor(m.attendees.filter((a) => !ctx.myEmails.includes(a)));
  const commitments = await openCommitments(attendees.map((a) => a.email));
  const tasks = await openTasks(ctx);
  const transcript = String(ep.body_text || '');
  const { prompt, refs } = D.buildPrompt({
    meeting: { ...m, attendees },
    me: { name: ctx.name, emails: ctx.myEmails },
    commitments: commitments.map((c) => ({ id: c.id, direction: c.direction, summary: c.summary, due: c.due_at, counterparty: c.counterparty })),
    tasks,
    transcript: headTail(transcript, MAX_TRANSCRIPT),
  });

  const reply = await llm.complete({
    system: D.SYSTEM,
    prompt,
    model: config.meetings.debriefModel,
    effort: config.meetings.debriefEffort,
    maxTokens: 4000,
  });
  const parsed = D.parseDebrief(llm.extractJson(reply), { transcript, refs, meetingStart: m.start });

  const day = new Date(m.start).toISOString().slice(0, 10);
  const plan = { items: [], skipped: [], dropped: parsed.dropped };
  const byId = new Map(commitments.map((c) => [`C${c.id}`, c]));
  const taskById = new Map(tasks.map((t) => [`T${t.id}`, t]));

  for (const [list, type, direction] of [[parsed.todos, 'todo', 'owed_by_me'], [parsed.owedToMe, 'owed_to_me', 'owed_to_me']]) {
    for (const t of list) {
      const dup = D.duplicateOf(t.summary, direction, commitments);
      if (dup) {
        plan.skipped.push({ type, summary: t.summary, quote: t.quote, reason: `already on your list as #${dup.id}` });
        continue;
      }
      plan.items.push({ type, direction, summary: t.summary, counterparty: t.counterparty, due: t.due, quote: t.quote, confidence: t.confidence });
    }
  }
  for (const u of parsed.updates) {
    const task = taskById.get(u.ref);
    const target = task ? { task: true, label: `${task.kind === 'pr' ? 'PR' : 'Ticket'} ${task.label}` } : byId.get(u.ref);
    const decided = D.planUpdate(u, target, { title: m.title, day, now });
    if (decided.skip) {
      plan.skipped.push({ type: 'update', summary: `${u.ref} ${u.kind}: ${u.note}`, quote: u.quote, reason: decided.skip });
      continue;
    }
    plan.items.push({
      type: 'update',
      ref: u.ref,
      kind: u.kind,
      note: u.note,
      due: u.due,
      quote: u.quote,
      commitmentId: task ? null : Number(u.ref.slice(1)),
      taskItemId: task ? Number(u.ref.slice(1)) : null,
      target: task ? target.label : target.summary,
      set: decided.set || null,
      before: decided.before || null,
      claim: decided.claim || null,
    });
  }
  for (const d of parsed.decisions) plan.items.push({ type: 'decision', text: d.text, quote: d.quote });

  return { meeting: m, plan, ctx, attendees, transcriptChars: transcript.length };
}

// ------------------------------------------------------------- applying ----

const SETTABLE = new Set(['status', 'closed_at', 'closed_reason', 'due_at', 'detail']);

async function setColumns(client, id, set) {
  const cols = Object.keys(set).filter((k) => SETTABLE.has(k));
  if (!cols.length) return;
  await client.query(
    `update commitment set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
    [id, ...cols.map((c) => set[c])]
  );
}

async function insertClaim(client, { subjectKind, subjectId = null, label, kind, text, quote, itemId, validAt }) {
  const r = await client.query(
    `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id, source_kind,
                        confidence, valid_at, status, origin, extracted_by)
     values ($1,$2,$3,$4,$5,$6,$7,'audio',0.8,$8,'active','distill',$9) returning id`,
    [subjectKind, subjectId, label, kind, D.clip(text, 400), quote, itemId, validAt, D.VERSION]
  );
  return r.rows[0].id;
}

async function apply(ep, prepared) {
  const { meeting: m, plan, ctx, attendees } = prepared;
  // People are resolved before the transaction: resolving may create one.
  for (const it of plan.items) {
    if (it.type === 'todo' || it.type === 'owed_to_me') it.counterpartyPersonId = await personFor(it.counterparty, attendees);
  }
  const day = new Date(m.start).toISOString().slice(0, 10);
  const claimIds = [];
  const debrief = await withTx(async (client) => {
    for (const it of plan.items) {
      if (it.type === 'todo' || it.type === 'owed_to_me') {
        const r = await client.query(
          `insert into commitment (source_item_id, direction, summary, detail, counterparty_person_id, due_at, confidence, extracted_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [ep.source_item_id, it.direction, it.summary, `From ${m.title} (${day}): “${D.clip(it.quote, 300)}”`, it.counterpartyPersonId || null, it.due, it.confidence, D.VERSION]
        );
        it.commitmentId = r.rows[0].id;
      } else if (it.type === 'update') {
        if (it.set && it.commitmentId) await setColumns(client, it.commitmentId, it.set);
        if (it.claim) {
          it.claimId = await insertClaim(client, { subjectKind: 'me', subjectId: ctx.personId, label: 'me', kind: it.claim.kind, text: it.claim.text, quote: it.quote, itemId: ep.source_item_id, validAt: m.start });
          claimIds.push(it.claimId);
        }
      } else if (it.type === 'decision') {
        it.claimId = await insertClaim(client, {
          subjectKind: 'topic',
          label: m.seriesKey || core.seriesKey(m.title),
          kind: 'decision',
          text: `Decided in "${D.clip(m.title, 80)}" on ${day}: ${it.text}`,
          quote: it.quote,
          itemId: ep.source_item_id,
          validAt: m.start,
        });
        claimIds.push(it.claimId);
      }
    }
    const applied = { items: plan.items.map(({ counterpartyPersonId, ...rest }) => rest), skipped: plan.skipped, dropped: plan.dropped };
    const r = await client.query(
      `insert into meeting_debrief (episode_id, event_external_id, source_item_id, title, started_at, ended_at, content_hash,
                                    transcript_chars, applied, dropped, error, attempts, extracted_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,1,$11)
       on conflict (episode_id, content_hash) do update set applied = excluded.applied, dropped = excluded.dropped,
         error = null, attempts = meeting_debrief.attempts + 1, updated_at = now()
       returning *`,
      [ep.id, ep.calendar_event_id, ep.source_item_id, m.title, m.start, m.end, ep.content_hash, prepared.transcriptChars,
        JSON.stringify(applied), plan.dropped.length, D.VERSION]
    );
    return r.rows[0];
  });
  if (claimIds.length && config.memory.enabled) {
    await require('../memory/consolidate').consolidateClaims(claimIds).catch((err) => log.warn('consolidate failed', { message: err.message }));
  }
  return debrief;
}

async function deliver(row) {
  const items = row.applied?.items || [];
  if (!items.length || row.notification_id) return row;
  const { notify, dashboardUrl } = require('../notify');
  const n = D.renderNotification(row.title, items);
  const url = dashboardUrl(`debrief-${row.id}`);
  const sent = await notify({ kind: 'meeting_debrief', title: n.title, body: n.body, url, dedupeKey: `debrief:${row.id}`, actions: [{ label: 'Open debrief', url }] });
  if (!sent) return row;
  return one('update meeting_debrief set notification_id = $2 where id = $1 returning *', [row.id, sent.id]);
}

async function recordError(ep, m, err) {
  await query(
    `insert into meeting_debrief (episode_id, event_external_id, source_item_id, title, started_at, ended_at, content_hash,
                                  transcript_chars, error, attempts, extracted_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)
     on conflict (episode_id, content_hash) do update set error = excluded.error,
       attempts = meeting_debrief.attempts + 1, updated_at = now()`,
    [ep.id, ep.calendar_event_id, ep.source_item_id, m.title, m.start, m.end, ep.content_hash, String(ep.body_text || '').length,
      String(err.message).slice(0, 500), D.VERSION]
  );
}

/**
 * Debriefs one episode.
 * @param {string|number} target episode id or 'last'
 * @param {object} [opts] {dryRun, deliver, now}
 * @returns {Promise<{episode, meeting, plan, debrief}>} debrief is null on a dry run
 */
async function debrief(target, { dryRun = false, deliver: shouldDeliver = false, now = new Date() } = {}) {
  const ep = typeof target === 'object' && target?.id ? target : await loadEpisode(target);
  if (!ep) throw new Error(`no recorded meeting or call "${target}"`);
  if (!ep.body_text) throw new Error(`episode ${ep.id} has no transcript`);
  const m = meetingOf(ep);
  let prepared;
  try {
    prepared = await prepare(ep, { now });
  } catch (err) {
    if (!dryRun) await recordError(ep, m, err);
    throw err;
  }
  if (dryRun) return { episode: ep, meeting: prepared.meeting, plan: prepared.plan, debrief: null };
  let row = await apply(ep, prepared);
  if (shouldDeliver) row = await deliver(row);
  const c = D.counts(row.applied.items);
  log.info('debriefed', { episode: ep.id, debrief: row.id, ...c, skipped: prepared.plan.skipped.length, dropped: prepared.plan.dropped.length });
  return { episode: ep, meeting: prepared.meeting, plan: prepared.plan, debrief: row };
}

// ---------------------------------------------------------------- undo ----

/**
 * Takes back one applied item: deletes a to-do it created, puts back the
 * columns an update overwrote (unless they have changed since), retracts a
 * claim. Marks the item undone in `applied`.
 */
async function undo(debriefId, index) {
  const row = await one('select * from meeting_debrief where id = $1', [debriefId]);
  if (!row) throw new Error(`no debrief #${debriefId}`);
  const items = row.applied?.items || [];
  const it = items[index];
  if (!it) throw new Error(`debrief #${debriefId} has no item ${index}`);
  if (it.undone_at) return { ok: true, already: true, item: it };
  let result = 'undone';
  await withTx(async (client) => {
    if ((it.type === 'todo' || it.type === 'owed_to_me') && it.commitmentId) {
      await client.query(`delete from commitment where id = $1 and extracted_by = $2`, [it.commitmentId, D.VERSION]);
    }
    if (it.type === 'update' && it.commitmentId && it.set && it.before) {
      const cur = (await client.query('select * from commitment where id = $1', [it.commitmentId])).rows[0];
      if (!cur) result = 'the commitment is gone';
      else if (D.changedSince(cur, it.set)) result = 'changed since the debrief; left as it is';
      else await setColumns(client, it.commitmentId, it.before);
    }
    if (it.claimId) await client.query(`update claim set status = 'retracted' where id = $1 and status <> 'retracted'`, [it.claimId]);
    await client.query(
      `update meeting_debrief set applied = jsonb_set(applied, $2::text[], (applied #> $2::text[]) || jsonb_build_object('undone_at', now()::text, 'undo', $3::text)),
              updated_at = now() where id = $1`,
      [debriefId, ['items', String(index)], result]
    );
  });
  log.info('debrief item undone', { debrief: debriefId, index, type: it.type });
  return { ok: true, result, item: it };
}

// ---------------------------------------------------------------- views ----

function view(row) {
  return {
    id: row.id,
    episodeId: row.episode_id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    error: row.error,
    notified: !!row.notification_id,
    items: (row.applied?.items || []).map((i, index) => ({ ...i, index, line: D.itemLine(i) })),
    skipped: row.applied?.skipped || [],
    dropped: row.dropped,
    counts: D.counts(row.applied?.items || []),
  };
}

async function recent({ days = 7, limit = 20 } = {}) {
  const list = await rows(
    `select * from meeting_debrief where created_at > now() - ($1 || ' days')::interval and error is null
      order by started_at desc limit $2`,
    [String(days), limit]
  );
  return list.map(view);
}

async function get(id) {
  const row = await one('select * from meeting_debrief where id = $1', [id]);
  return row ? view(row) : null;
}

// ---------------------------------------------------------------- pass ----

async function lastDebrief(episodeId) {
  return one(`select * from meeting_debrief where episode_id = $1 and error is null order by created_at desc limit 1`, [episodeId]);
}

/**
 * Episodes ready for a debrief: owned, recent, with no debrief of their
 * current transcript, and over (debriefCore.debriefDue). A query, not a queue.
 */
async function due({ now = new Date(), coverage = undefined } = {}) {
  const cov = coverage !== undefined ? coverage : spool.coverage(config.audioDir, { rollMinutes: config.audio.rollMinutes, now: now.getTime() });
  const list = await rows(
    `${EPISODE_SQL}
      where ${OWNED} and e.ended_at > $1::timestamptz - interval '12 hours'
        and not exists (select 1 from meeting_debrief d where d.episode_id = e.id and d.content_hash = si.content_hash
                          and (d.error is null or d.attempts >= 3))
      order by e.ended_at`,
    [now]
  );
  const out = [];
  for (const ep of list) {
    const prev = await lastDebrief(ep.id);
    if (prev && String(ep.body_text || '').length < prev.transcript_chars + REGROW_CHARS) continue;
    const m = meetingOf(ep);
    const d = D.debriefDue({ endedAt: ep.ended_at, eventEnd: m.eventEnd, coverage: cov, now });
    if (d.due) out.push({ ep, why: d.why });
  }
  return out;
}

/**
 * Asks capture to finish its files when it would bring a debrief closer: a
 * calendar meeting has just ended, or a meeting or call that is over by the
 * calendar (or has none) is still waiting for quiet audio. At most every
 * five minutes, and never more than once per ending.
 */
async function rollIfUseful({ now = new Date() } = {}) {
  const last = spool.lastRoll(config.audio.rollFile);
  const nowMs = now.getTime();
  if (nowMs - last < 60_000) return null;
  const events = await rows(
    `select external_id, subject, occurred_at, raw from source_item
      where source = 'graph_event' and occurred_at between $1::timestamptz - interval '12 hours' and $1::timestamptz`,
    [now]
  );
  const ended = events.filter(attendable).map(eventRange).find((e) => e.end <= nowMs && e.end > nowMs - 5 * 60_000 && last < e.end);
  let reason = ended ? 'meeting ended' : null;
  if (!reason && nowMs - last >= 5 * 60_000) {
    const waiting = await rows(
      `${EPISODE_SQL}
        where ${OWNED} and e.ended_at > $1::timestamptz - interval '45 minutes'
          and not exists (select 1 from meeting_debrief d where d.episode_id = e.id)`,
      [now]
    );
    if (waiting.some((ep) => { const end = meetingOf(ep).eventEnd; return !end || new Date(end).getTime() <= nowMs; })) reason = 'debrief waiting for quiet';
  }
  if (!reason) return null;
  spool.requestRoll(config.audio.rollFile, reason);
  log.info('asked capture to roll', { reason });
  return reason;
}

async function pass({ now = new Date() } = {}) {
  if (!config.meetings.debrief) return { debriefed: 0 };
  let debriefed = 0;
  for (const { ep, why } of await due({ now })) {
    try {
      await debrief(ep, { deliver: true, now });
      debriefed++;
    } catch (err) {
      log.warn('debrief failed', { episode: ep.id, why, message: err.message });
    }
  }
  return { debriefed };
}

module.exports = { pass, debrief, due, undo, recent, get, rollIfUseful, loadEpisode };
