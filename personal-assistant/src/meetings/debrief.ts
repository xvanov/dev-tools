'use strict';

// Post-meeting debriefs: minutes after a recorded meeting or call ends, what
// it means for you — your new to-dos, what others promised you, news about
// work already on your list, and decisions that change it. Nothing else.
//
//   pass()                      the worker's audio pass: roll capture when a
//                               meeting ends, debrief what is over
//   debrief(target, opts)       one debrief, for an episode id or 'last'
//   undo(debriefId, index)      take back one applied item
//   supersede(old, new)         a newer debrief of the episode replaces an older one
//                               (automatic when an episode is debriefed again)
//   recent({days})              debriefs for the dashboard
//   discard(episode)            remove a recording of you alone (see below)
//   soloCandidates({days})      debriefs that look like you alone (`pa meeting solo`)
//
// A recording with nobody else in it is not a meeting. When the model says so
// (others_present: false), nothing is applied and the recording is discarded:
// its transcript, its audio and any earlier debrief of it go, and the episode
// stays only as a 'solo' marker the audio pass will not store again.
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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const llm = require('../llm.ts');
const { config } = require('../config.ts');
const repo = require('../repo');
const { logger } = require('../log.ts');
const { headTail } = require('../memory/claims.ts');
const spool = require('../audio/spool.ts');
const { attendable, eventRange } = require('../audio/episodes.ts');
const core = require('./core.ts');
const D = require('./debriefCore.ts');

const log = logger('debrief');

// A meeting that grows after its debrief is debriefed again only when this
// much more was said; a goodbye is not worth a model call.
const REGROW_CHARS = 1500;
const MAX_TRANSCRIPT = 90_000;

// ------------------------------------------------------------- loading ----

// The episode queries (src/repo/audio.js) own what makes an episode debriefable.
async function loadEpisode(target: any) {
  const t = String(target ?? 'last').trim();
  if (t === 'last') {
    return repo.audio.lastOwned();
  }
  if (!/^\d+$/.test(t)) throw new Error(`episode must be an id or "last", not "${t}"`);
  return repo.audio.withEventById(Number(t));
}

function meetingOf(ep: any) {
  const ev = ep.event_raw ? core.toMeeting({ id: ep.event_item_id, external_id: ep.event_external_id, subject: ep.event_subject, raw: ep.event_raw, occurred_at: ep.event_occurred_at, author_identity: ep.event_organizer, body_text: ep.event_body }) : null;
  return {
    title: ev?.subject || ep.item_subject || 'Recorded conversation',
    seriesKey: ev?.seriesKey || null,
    kind: ep.kind,
    singleStream: !String(ep.stream || '').includes('loopback'),
    // Brought in by `pa meeting import`: a recording the engineer was not in.
    imported: ep.state === 'imported',
    start: new Date(ep.started_at).toISOString(),
    end: new Date(ep.ended_at).toISOString(),
    eventEnd: ev ? ev.end : null,
    attendees: ev?.attendees || [],
  };
}

async function recentChatsAround(startIso: any, endIso: any) {
  const list = await repo.sources.chatsAround(startIso, endIso).catch(() => []);
  const emails = new Set();
  let hadCallLog = false;
  const startMs = new Date(startIso).getTime();
  const chats = [];
  for (const r of list) {
    if (r.subject === 'Teams chat' && /Call Logs for Call/i.test(r.body || '')) {
      if (new Date(r.occurred_at).getTime() >= startMs) hadCallLog = true;
      continue;
    }
    if (!String(r.body || '').trim()) continue;
    if (r.author_identity && r.author_identity.includes('@')) emails.add(r.author_identity.toLowerCase());
    for (const em of r.raw?.memberEmails || []) {
      if (typeof em === 'string' && em.includes('@')) emails.add(em.toLowerCase());
    }
    chats.push({
      subject: r.subject || 'Teams chat',
      author: r.author_identity || '',
      who: r.raw?.fromName || r.author_identity || '',
      occurredAt: r.occurred_at,
      body: r.body,
      chatType: r.raw?.chatType || null,
    });
  }
  return { chats, emails: [...emails], hadCallLog };
}

async function namesFor(emails: any[]) {
  if (!emails.length) return [];
  const found = await repo.people.namesForEmails(emails);
  const byEmail = new Map(found.map((r: any) => [r.email, r.display_name]));
  return emails.map((email) => ({ email, name: byEmail.get(email) || null }));
}

async function openCommitments(attendeeEmails: any) {
  return repo.commitments.openForDebrief(attendeeEmails);
}

async function openTasks(ctx: any) {
  const tasks = [];
  if (ctx.githubLogin) {
    const prs = await repo.sources.openPrsByAuthor(`github:${ctx.githubLogin}`);
    for (const p of prs) tasks.push({ id: p.id, kind: 'pr', label: p.subject, status: p.raw?.draft ? 'draft' : 'open' });
  }
  const mine = [ctx.name, ...ctx.myEmails].filter(Boolean).map((s) => s.toLowerCase());
  const jira = await repo.sources.openJiraAssigned(mine, 20);
  for (const j of jira) tasks.push({ id: j.id, kind: 'jira', label: j.subject, status: j.raw?.status || null });
  return tasks;
}

// ------------------------------------------------------------ resolving ----

async function personFor(counterparty: any, attendees: any) {
  if (!counterparty) return null;
  const identity = require('../distill/identity.ts');
  const c = String(counterparty).trim();
  if (c.includes('@')) return identity.resolve(c.toLowerCase());
  // A name: an attendee whose name or address matches it, else a person
  // whose name is unambiguous. Never a new person from a spoken name.
  const lc = c.toLowerCase();
  const hit = attendees.find((a: any) => (a.name && a.name.toLowerCase().includes(lc)) || a.email.split('@')[0].replace(/[._-]+/g, ' ').includes(lc));
  if (hit) return identity.resolve(hit.email);
  return identity.resolve(c);
}

// ------------------------------------------------------------ planning ----

/**
 * Reads the meeting and decides what to write, without writing it.
 * @returns {Promise<{episode, meeting, plan, parsed}>}
 */
async function prepare(ep: any, { now = new Date() }: { now?: any } = {}) {
  const meetings = require('./index');
  const ctx = await meetings.context();
  const m = meetingOf(ep);
  const around = await recentChatsAround(m.start, m.end);
  const allEmails = [...new Set([...m.attendees, ...around.emails].map((e) => e.toLowerCase()))].filter(
    (a) => !ctx.myEmails.includes(a)
  );
  const attendees = await namesFor(allEmails);
  const commitments = await openCommitments(attendees.map((a) => a.email));
  const tasks = await openTasks(ctx);
  const transcript = String(ep.body_text || '');
  const { prompt, refs } = D.buildPrompt({
    meeting: { ...m, attendees },
    me: { name: ctx.name, emails: ctx.myEmails },
    commitments: commitments.map((c: any) => ({ id: c.id, direction: c.direction, summary: c.summary, due: c.due_at, counterparty: c.counterparty })),
    tasks,
    recentChats: around.chats,
    transcript: headTail(transcript, MAX_TRANSCRIPT),
  });

  const reply = await llm.complete({
    system: D.SYSTEM,
    prompt,
    model: config.meetings.debriefModel,
    effort: config.meetings.debriefEffort,
    maxTokens: 4000,
    purpose: 'debrief',
  });
  const parsed = D.parseDebrief(llm.extractJson(reply), { transcript, refs, meetingStart: m.start });
  // A recording you did not attend (a webinar) is "a video playing" to the model, and
  // nothing in it is you alone: it is never discarded as solo.
  if (m.imported) parsed.solo = false;
  if (parsed.title && (m.kind === 'call' || around.hadCallLog || /^Call\b|^Recorded conversation/i.test(m.title))) {
    m.title = parsed.title;
  }

  const day = new Date(m.start).toISOString().slice(0, 10);
  const plan = { title: m.title, summary: parsed.summary || null, items: [] as any[] as any[] as any[], skipped: [] as any[] as any[], dropped: parsed.dropped };
  const byId = new Map(commitments.map((c: any) => [`C${c.id}`, c]));
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
    const target: any = task ? { task: true, label: `${task.kind === 'pr' ? 'PR' : 'Ticket'} ${task.label}` } : byId.get(u.ref);
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

  return { meeting: m, plan, ctx, attendees, transcriptChars: transcript.length, solo: parsed.solo };
}

// ------------------------------------------------------------- applying ----

// A claim a debrief wrote: clipped, and stamped with the debrief's version.
async function insertClaim(r: any, { subjectKind, subjectId = null, label, kind, text, quote, itemId, validAt }: { subjectKind?: any; subjectId?: any; label?: any; kind?: any; text?: any; quote?: any; itemId?: any; validAt?: any }) {
  return r.memory.insertDebriefClaim({ subjectKind, subjectId, label, kind, text: D.clip(text, 400), quote, itemId, validAt, extractedBy: D.VERSION });
}

async function apply(ep: any, prepared: any) {
  const { meeting: m, plan, ctx, attendees } = prepared;
  // People are resolved before the transaction: resolving may create one.
  for (const it of plan.items) {
    if (it.type === 'todo' || it.type === 'owed_to_me') it.counterpartyPersonId = await personFor(it.counterparty, attendees);
  }
  const day = new Date(m.start).toISOString().slice(0, 10);
  const claimIds: any[] = [];
  const debrief = await repo.withTx(async (r: any) => {
    // A rewrite of the same transcript is a new row, so what the old row applied
    // stays on record for supersedeOlder to adopt or undo, not overwritten.
    const same = (await r.meetings.debriefsForEpisode(ep.id)).find((d: any) => d.content_hash === ep.content_hash && !d.error && !d.superseded_by);
    if (same) await r.meetings.retireHash(same.id);
    for (const it of plan.items) {
      if (it.type === 'todo' || it.type === 'owed_to_me') {
        it.commitmentId = await r.commitments.insertFromDebrief({
          sourceItemId: ep.source_item_id,
          direction: it.direction,
          summary: it.summary,
          detail: `From ${m.title} (${day}): “${D.clip(it.quote, 300)}”`,
          counterpartyPersonId: it.counterpartyPersonId || null,
          dueAt: it.due,
          confidence: it.confidence,
          extractedBy: D.VERSION,
        });
      } else if (it.type === 'update') {
        if (it.set && it.commitmentId) await r.commitments.setDebriefColumns(it.commitmentId, it.set);
        if (it.claim) {
          it.claimId = await insertClaim(r, { subjectKind: 'me', subjectId: ctx.personId, label: 'me', kind: it.claim.kind, text: it.claim.text, quote: it.quote, itemId: ep.source_item_id, validAt: m.start });
          claimIds.push(it.claimId);
        }
      } else if (it.type === 'decision') {
        it.claimId = await insertClaim(r, {
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
    const applied = {
      summary: plan.summary || null,
      items: plan.items.map(({ counterpartyPersonId, ...rest }: any) => rest),
      skipped: plan.skipped,
      dropped: plan.dropped,
    };
    return r.meetings.upsertDebrief({
      episodeId: ep.id,
      eventExternalId: ep.calendar_event_id,
      sourceItemId: ep.source_item_id,
      title: m.title,
      startedAt: m.start,
      endedAt: m.end,
      contentHash: ep.content_hash,
      transcriptChars: prepared.transcriptChars,
      applied,
      dropped: plan.dropped.length,
      extractedBy: D.VERSION,
    });
  });
  if (claimIds.length && config.memory.enabled) {
    await require('../memory/consolidate.ts').consolidateClaims(claimIds).catch((err: Error) => log.warn('consolidate failed', { message: err.message }));
  }
  return debrief;
}

async function deliver(row: any) {
  const items = row.applied?.items || [];
  if (!items.length || row.notification_id) return row;
  const { notify, dashboardUrl } = require('../notify');
  const n = D.renderNotification(row.title, items);
  const url = dashboardUrl(`debrief-${row.id}`);
  const sent = await notify({ kind: 'meeting_debrief', title: n.title, body: n.body, url, dedupeKey: `debrief:${row.id}`, actions: [{ label: 'Open debrief', url }] });
  if (!sent) return row;
  return repo.meetings.markDebriefNotified(row.id, sent.id);
}

async function recordError(ep: any, m: any, err: any) {
  await repo.meetings.recordDebriefError({
    episodeId: ep.id,
    eventExternalId: ep.calendar_event_id,
    sourceItemId: ep.source_item_id,
    title: m.title,
    startedAt: m.start,
    endedAt: m.end,
    contentHash: ep.content_hash,
    transcriptChars: String(ep.body_text || '').length,
    error: String(err.message).slice(0, 500),
    extractedBy: D.VERSION,
  });
}

/**
 * Debriefs one episode.
 * @param {string|number} target episode id or 'last'
 * @param {object} [opts] {dryRun, deliver, now}
 * @returns {Promise<{episode, meeting, plan, debrief}>} debrief is null on a dry run
 */
async function debrief(target: any, { dryRun = false, deliver: shouldDeliver = false, now = new Date() }: { dryRun?: boolean; deliver?: boolean; now?: any } = {}) {
  const ep = typeof target === 'object' && target?.id ? target : await loadEpisode(target);
  if (!ep) throw new Error(`no recorded meeting or call "${target}"`);
  if (!ep.body_text) throw new Error(`episode ${ep.id} has no transcript`);
  const m = meetingOf(ep);
  let prepared;
  try {
    prepared = await prepare(ep, { now });
  } catch (err: any) {
    if (!dryRun) await recordError(ep, m, err);
    throw err;
  }
  if (prepared.solo) {
    // Nobody else in it: not a meeting. Discarded, not listed.
    if (!dryRun) await discard(ep);
    log.info('not a meeting: you alone', { episode: ep.id, discarded: !dryRun });
    return { episode: ep, meeting: prepared.meeting, plan: prepared.plan, debrief: null, solo: true };
  }
  if (dryRun) return { episode: ep, meeting: prepared.meeting, plan: prepared.plan, debrief: null };
  let row = await apply(ep, prepared);
  let sup: any = { ids: [], adopted: 0, undone: 0, notified: false };
  try {
    sup = await supersedeOlder(row);
    if (sup.adopted) row = await repo.meetings.debriefById(row.id);
  } catch (err: any) {
    log.warn('older debriefs not superseded', { episode: ep.id, debrief: row.id, message: err.message });
  }
  // A re-debrief that only restates what you were already told is not news.
  const fresh = (row.applied?.items || []).length - sup.adopted;
  if (shouldDeliver && !(sup.notified && fresh === 0)) row = await deliver(row);
  const c = D.counts(row.applied.items);
  log.info('debriefed', { episode: ep.id, debrief: row.id, ...c, skipped: prepared.plan.skipped.length, dropped: prepared.plan.dropped.length, superseded: sup.ids });
  return { episode: ep, meeting: prepared.meeting, plan: prepared.plan, debrief: row, superseded: sup.ids };
}

// ----------------------------------------------------------- supersede ----

// What a newer debrief's skipped list says it already found on your list: the
// commitments it declined to repeat ("already on your list as #12") and the
// updates it found already made ("C12 done: ..."). The older debrief that wrote
// them keeps them: they are adopted by the newer one, not undone.
function restated(skipped: any[]) {
  const commitments = new Set<number>();
  const updates = new Set<string>();
  for (const s of skipped || []) {
    const dup = /already on your list as #(\d+)/.exec(String(s.reason || ''));
    if (dup) commitments.add(Number(dup[1]));
    const u = s.type === 'update' ? /^(\S+) (\w+):/.exec(String(s.summary || '')) : null;
    if (u) updates.add(`${u[1]} ${u[2]}`);
  }
  return { commitments, updates };
}

/**
 * A newer debrief of an episode replaces the older ones: they stop showing in
 * lists and the CLI, and what they applied is settled. An item the newer one
 * restates (it skipped it as already on your list) is adopted into the newer
 * debrief, so it stays and can still be undone from there; every other item is
 * undone exactly as `pa meeting undo` would. Nothing is deleted but those
 * items: the transcript and audio stay (unlike `discard`).
 * @param {object} row the newer debrief
 * @param {object[]} [olds] the debriefs to replace; by default every live,
 *   non-failed one of the same episode
 * @returns {Promise<{ids: number[], adopted: number, undone: number, notified: boolean}>}
 */
async function supersedeOlder(row: any, olds?: any[]) {
  const list = olds || (await repo.meetings.debriefsForEpisode(row.episode_id)).filter((d: any) => d.id !== row.id && !d.superseded_by && !d.error);
  if (!list.length) return { ids: [], adopted: 0, undone: 0, notified: false };
  const { commitments, updates } = restated(row.applied?.skipped);
  const keeps = (it: any) =>
    ((it.type === 'todo' || it.type === 'owed_to_me') && it.commitmentId != null && commitments.has(Number(it.commitmentId))) ||
    (it.type === 'update' && updates.has(`${it.ref} ${it.kind}`));
  const adopted: any[] = [];
  const doomed: Array<[number, number]> = [];
  for (const d of list) {
    (d.applied?.items || []).forEach((it: any, i: number) => {
      if (it.undone_at) return;
      if (keeps(it)) adopted.push({ ...it, adoptedFrom: d.id });
      else doomed.push([d.id, i]);
    });
  }
  if (adopted.length) {
    const cur = await repo.meetings.debriefById(row.id);
    await repo.meetings.setApplied(row.id, { ...cur.applied, items: [...(cur.applied?.items || []), ...adopted] });
  }
  for (const [id, i] of doomed) await undo(id, i);
  const ids = list.map((d: any) => d.id);
  await repo.meetings.supersede(ids, row.id);
  log.info('older debriefs superseded', { by: row.id, ids, adopted: adopted.length, undone: doomed.length });
  return { ids, adopted: adopted.length, undone: doomed.length, notified: list.some((d: any) => d.notification_id) };
}

/** `pa meeting supersede <old> <new>`: replace one debrief by a newer one of the same episode. */
async function supersede(oldId: any, newId: any) {
  const [old, row] = await Promise.all([repo.meetings.debriefById(oldId), repo.meetings.debriefById(newId)]);
  if (!old) throw new Error(`no debrief #${oldId}`);
  if (!row) throw new Error(`no debrief #${newId}`);
  if (old.id === row.id) throw new Error('a debrief cannot supersede itself');
  if (String(old.episode_id) !== String(row.episode_id)) throw new Error(`#${old.id} is episode ${old.episode_id}, #${row.id} is episode ${row.episode_id}: only debriefs of one meeting can supersede each other`);
  if (row.error || row.superseded_by) throw new Error(`#${row.id} is ${row.error ? 'a failed debrief' : `itself superseded by #${row.superseded_by}`}`);
  if (old.superseded_by) throw new Error(`#${old.id} is already superseded by #${old.superseded_by}`);
  return supersedeOlder(row, [old]);
}

// ---------------------------------------------------------------- undo ----

/**
 * Takes back one applied item: deletes a to-do it created, puts back the
 * columns an update overwrote (unless they have changed since), retracts a
 * claim. Marks the item undone in `applied`.
 */
async function undo(debriefId: any, index: any) {
  const row = await repo.meetings.debriefById(debriefId);
  if (!row) throw new Error(`no debrief #${debriefId}`);
  const items = row.applied?.items || [];
  const it = items[index];
  if (!it) throw new Error(`debrief #${debriefId} has no item ${index}`);
  if (it.undone_at) return { ok: true, already: true, item: it };
  let result = 'undone';
  await repo.withTx(async (r: any) => {
    if ((it.type === 'todo' || it.type === 'owed_to_me') && it.commitmentId) {
      await r.commitments.deleteExtractedBy(it.commitmentId, D.VERSION);
    }
    if (it.type === 'update' && it.commitmentId && it.set && it.before) {
      const cur = await r.commitments.rowForUndo(it.commitmentId);
      if (!cur) result = 'the commitment is gone';
      else if (D.changedSince(cur, it.set)) result = 'changed since the debrief; left as it is';
      else await r.commitments.setDebriefColumns(it.commitmentId, it.before);
    }
    if (it.claimId) await r.memory.retract(it.claimId);
    await r.meetings.markItemUndone(debriefId, index, result);
  });
  log.info('debrief item undone', { debrief: debriefId, index, type: it.type });
  return { ok: true, result, item: it };
}

// ------------------------------------------------------------- discard ----

// The sidecar beside each trimmed speech file (audio/process.py).
function withSidecars(files: string[]) {
  const out = new Set<string>();
  for (const f of files) {
    out.add(f);
    if (/\.speech\.wav$/i.test(f)) out.add(f.replace(/\.wav$/i, '.json'));
  }
  return [...out];
}

/**
 * Removes a recording of you alone that was filed as a meeting or call: undoes
 * every item its debriefs applied, deletes the debriefs, the transcript item
 * and the audio (speech groups and sidecars), and leaves the episode as a
 * 'solo' marker.
 * @param {object|number|string} target episode row or id
 * @returns {Promise<{episodeId, undone: number, files: number}|null>}
 */
async function discard(target: any) {
  const id = typeof target === 'object' && target?.id ? target.id : Number(target);
  const fs = require('fs');
  let undone = 0;
  for (const d of await repo.meetings.debriefsForEpisode(id)) {
    const items = d.applied?.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].undone_at) continue;
      await undo(d.id, i);
      undone++;
    }
  }
  const r = await repo.withTx((tx: any) => tx.audio.discardSolo(id));
  if (!r) return null;
  let files = 0;
  for (const f of withSidecars(r.files)) {
    try {
      fs.unlinkSync(f);
      files++;
    } catch {
      /* already gone */
    }
  }
  log.info('recording of you alone discarded', { episode: id, undone, files });
  return { episodeId: id, undone, files };
}

// Debriefs stored before others_present existed, whose title says it was you
// alone. A list for you to check (`pa meeting solo`), never acted on unasked.
const LOOKS_SOLO = /\bsolo\b|\bdictat(ion|ing|ed)\b|\(no call\)|\bmonologue\b|\bvoice (memo|note)\b|\bvideo playing\b/i;

async function soloCandidates({ days = 30 }: { days?: number } = {}) {
  const list = await repo.meetings.recentDebriefs(days, 1000);
  return list.filter((d: any) => LOOKS_SOLO.test(String(d.title || ''))).map(view);
}

// ---------------------------------------------------------------- views ----

function view(row: any) {
  const items = (row.applied?.items || []).map((i: any, index: any) => ({ ...i, index, line: D.itemLine(i) }));
  return {
    id: row.id,
    episodeId: row.episode_id,
    title: row.title,
    summary: row.applied?.summary || null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    error: row.error,
    notified: !!row.notification_id,
    items,
    decisions: items.filter((i: any) => i.type === 'decision'),
    actions: items.filter((i: any) => i.type !== 'decision'),
    skipped: row.applied?.skipped || [],
    dropped: row.dropped,
    counts: D.counts(row.applied?.items || []),
  };
}

async function recent({ days = 7, limit = 20 }: { days?: number; limit?: number } = {}) {
  const list = await repo.meetings.recentDebriefs(days, limit);
  return list.map(view);
}

async function get(id: any) {
  const row = await repo.meetings.debriefById(id);
  return row ? view(row) : null;
}

// ---------------------------------------------------------------- pass ----

async function lastDebrief(episodeId: any) {
  return repo.meetings.lastDebrief(episodeId);
}

/**
 * Episodes ready for a debrief: owned, recent, with no debrief of their
 * current transcript, and over (debriefCore.debriefDue). A query, not a queue.
 */
async function due({ now = new Date(), coverage = undefined }: { now?: any; coverage?: any } = {}) {
  const cov = coverage !== undefined ? coverage : spool.coverage(config.audioDir, { rollMinutes: config.audio.rollMinutes, now: now.getTime() });
  const paused = require('../audio/gate.ts').readPause().state !== 'on' && !spool.needsProcessing(config.audioDir);
  const list = await repo.audio.awaitingDebrief(now);
  const out = [];
  for (const ep of list) {
    const prev = await lastDebrief(ep.id);
    // Unless it was matched to another calendar event since: its title is wrong.
    const rematched = !!prev && (prev.event_external_id || null) !== (ep.calendar_event_id || null);
    if (prev && !rematched && String(ep.body_text || '').length < prev.transcript_chars + REGROW_CHARS) continue;
    const m = meetingOf(ep);
    const d = D.debriefDue({ endedAt: ep.ended_at, eventEnd: m.eventEnd, coverage: cov, paused, now });
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
async function rollIfUseful({ now = new Date() }: { now?: any } = {}) {
  const last = spool.lastRoll(config.audio.rollFile);
  const nowMs = now.getTime();
  if (nowMs - last < 60_000) return null;
  const events = await repo.sources.calendarBefore(now);
  const ended = events.filter(attendable).map(eventRange).find((e: any) => e.end <= nowMs && e.end > nowMs - 5 * 60_000 && last < e.end);
  let reason = ended ? 'meeting ended' : null;
  if (!reason && nowMs - last >= 90_000) {
    const waiting = await repo.audio.waitingForQuiet(now);
    if (waiting.some((ep: any) => { const end = meetingOf(ep).eventEnd; return !end || new Date(end).getTime() <= nowMs; })) reason = 'debrief waiting for quiet';
  }
  if (!reason) return null;
  spool.requestRoll(config.audio.rollFile, reason);
  log.info('asked capture to roll', { reason });
  return reason;
}

async function pass({ now = new Date() }: { now?: any } = {}) {
  if (!config.meetings.debrief) return { debriefed: 0 };
  let debriefed = 0;
  for (const { ep, why } of await due({ now })) {
    try {
      await debrief(ep, { deliver: true, now });
      debriefed++;
    } catch (err: any) {
      log.warn('debrief failed', { episode: ep.id, why, message: err.message });
    }
  }
  return { debriefed };
}

module.exports = { pass, debrief, due, undo, supersede, supersedeOlder, recent, get, view, rollIfUseful, loadEpisode, discard, soloCandidates, LOOKS_SOLO };
