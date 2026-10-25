'use strict';

// Pre-meeting briefs: about an hour before a meeting, a short numbered note of
// what is worth saying in it.
//
//   pass()                    the worker's 5-minute pass: learn from meetings
//                             that just happened, brief the ones starting soon
//   brief(target, opts)       one brief, for an event id, a source item id or 'next'
//   upcoming({hours})         the next meetings, with kind, eligibility and brief
//   learnRecent()             transcripts of past occurrences → series profiles
//
// The flow per meeting: classify it (keywords, then the series' shape, then
// one cheap model call cached per series) → gather the evidence that kind of
// meeting needs → one model call writes the brief from that evidence only →
// notify(). The pure parts — classification, windows, prompt assembly, the
// word cap — live in core.js and prompt.js.
//
// Learning: a recurring meeting's past occurrences are matched to recorded
// transcripts (audio items linked to the event, or overlapping its slot), and
// what was asked and what you said or promised is kept on the series, each
// line with its verbatim quote, and mirrored into memory as claims about
// `topic:<series>`. The next brief checks last time's promises against the
// evidence.

const path = require('path');
const llm = require('../llm');
const { config } = require('../config');
const { rows, one, query } = require('../db');
const { logger } = require('../log');
const core = require('./core');
const P = require('./prompt');

const log = logger('meetings');
const LEARN_VERSION = 'meeting-learn-v1';
const DAY = 86400_000;

// ------------------------------------------------------------ identity ----

async function context() {
  const me = await one('select id, display_name, primary_email from person where is_me limit 1');
  const ids = me
    ? await rows(`select kind, value from person_identity where person_id = $1`, [me.id])
    : [];
  const cursor = await one(`select state from sync_cursor where source = 'm365'`).catch(() => null);
  const gh = await one(`select state from sync_cursor where source = 'github'`).catch(() => null);
  const emails = new Set(
    [me?.primary_email, cursor?.state?.me?.mail, ...ids.filter((i) => i.kind === 'smtp').map((i) => i.value)]
      .filter(Boolean)
      .map((e) => e.toLowerCase())
  );
  const githubLogin = ids.find((i) => i.kind === 'github_username')?.value || gh?.state?.login || null;
  return {
    personId: me?.id ?? null,
    name: me?.display_name || null,
    myEmails: [...emails],
    githubLogin,
    domain: core.domainOf([...emails][0]),
  };
}

// ------------------------------------------------------------- events -----

const EVENT_COLS = 'id, external_id, subject, body_text, occurred_at, author_identity, raw';

async function eventsBetween(from, to) {
  const list = await rows(
    `select ${EVENT_COLS} from source_item
      where source = 'graph_event' and occurred_at between $1 and $2
      order by occurred_at`,
    [new Date(from), new Date(to)]
  );
  return list.map(core.toMeeting);
}

async function seriesOccurrences(seriesKey) {
  // The subject filter narrows; seriesKey decides (it strips "Canceled:").
  const words = seriesKey.split(' ').filter((w) => w.length > 2).slice(0, 3);
  const like = words.length ? `%${words.join('%')}%` : '%';
  const list = await rows(
    `select ${EVENT_COLS} from source_item
      where source = 'graph_event' and subject ilike $1
      order by occurred_at`,
    [like]
  );
  return list.map(core.toMeeting).filter((m) => m.seriesKey === seriesKey);
}

async function resolveTarget(target, { now = new Date(), ctx } = {}) {
  const t = String(target ?? 'next').trim();
  if (t === 'next') {
    const list = await eventsBetween(now, new Date(now.getTime() + 14 * DAY));
    const next = list.find((m) => new Date(m.start) > now && core.eligibility(m, eligibilityOpts(ctx)).ok);
    if (!next) throw new Error('no upcoming meeting that would be briefed in the next 14 days');
    return next;
  }
  const row = /^\d+$/.test(t)
    ? await one(`select ${EVENT_COLS} from source_item where source = 'graph_event' and id = $1`, [Number(t)])
    : await one(`select ${EVENT_COLS} from source_item where source = 'graph_event' and external_id = $1`, [t]);
  if (!row) throw new Error(`no calendar event "${t}"`);
  return core.toMeeting(row);
}

function eligibilityOpts(ctx) {
  return {
    myEmails: ctx?.myEmails || [],
    maxAttendees: config.meetings.maxAttendees,
    focusBlocks: config.meetings.focusBlocks,
  };
}

// ------------------------------------------------------ classification ----

async function seriesRow(m) {
  return one('select * from meeting_series where series_key = $1', [m.seriesKey]);
}

async function saveSeries(m, patch) {
  return one(
    `insert into meeting_series (series_key, label, kind, kind_source, profile)
     values ($1, $2, $3, $4, coalesce($5::jsonb, '{}'::jsonb))
     on conflict (series_key) do update set
       label = excluded.label,
       kind = coalesce($3, meeting_series.kind),
       kind_source = coalesce($4, meeting_series.kind_source),
       profile = coalesce($5::jsonb, meeting_series.profile),
       updated_at = now()
     returning *`,
    [m.seriesKey, core.seriesLabel(m.subject), patch.kind ?? null, patch.kindSource ?? null, patch.profile ? JSON.stringify(patch.profile) : null]
  );
}

async function classify(m, ctx, { allowModel = true } = {}) {
  const cached = await seriesRow(m);
  if (cached?.kind && (cached.kind_source === 'manual' || cached.kind_source === 'model')) {
    return { kind: cached.kind, source: cached.kind_source };
  }
  const occurrences = await seriesOccurrences(m.seriesKey);
  const det = core.classifyDeterministic(m, { myEmails: ctx.myEmails, seriesStarts: occurrences.map((o) => o.start) });
  if (det) {
    if (cached?.kind !== det.kind) await saveSeries(m, { kind: det.kind, kindSource: det.source });
    return det;
  }
  if (!allowModel) return { kind: 'other', source: 'default' };
  try {
    const reply = await llm.complete({
      system: P.CLASSIFY_SYSTEM,
      prompt: P.buildClassifyPrompt(m, { occurrences: occurrences.length, myDomain: ctx.domain }),
      model: config.meetings.classifyModel,
      effort: 'low',
      maxTokens: 200,
      purpose: 'meeting-brief',
    });
    const kind = core.normaliseKind(llm.extractJson(reply).kind);
    await saveSeries(m, { kind, kindSource: 'model' });
    return { kind, source: 'model' };
  } catch (err) {
    log.warn('classification failed', { message: err.message });
    return { kind: 'other', source: 'default' };
  }
}

async function setKind(seriesOrEvent, kind) {
  const k = core.normaliseKind(kind);
  if (k !== kind) throw new Error(`kind must be one of ${core.KINDS.join(', ')}`);
  const key = core.seriesKey(seriesOrEvent);
  const row = await one(
    `update meeting_series set kind = $2, kind_source = 'manual', updated_at = now() where series_key = $1 returning *`,
    [key, k]
  );
  if (row) return row;
  return saveSeries({ seriesKey: key, subject: String(seriesOrEvent) }, { kind: k, kindSource: 'manual' });
}

// ------------------------------------------------------------ evidence ----

const item = (key, text, extra = {}) => ({ key, text, ...extra });

async function ghSearch(q) {
  if (!config.github.enabled) return [];
  const { api } = require('../ingest/github');
  try {
    const r = await api(`/search/issues?per_page=20&q=${encodeURIComponent(q)}`);
    return r.items || [];
  } catch (err) {
    log.debug('github search failed', { message: err.message });
    return [];
  }
}

// A PR under my account that an AI agent wrote — Claude Code's footer or
// co-author trailer in its description. Agents (dispatched runs, cloud or
// remote sessions) open PRs as me; a brief that says "I shipped X" about one
// is putting words in my mouth.
const AGENT_MADE = /generated with \[?claude code|co-authored-by:\s*claude|🤖 generated with/i;

function agentMade(body) {
  return AGENT_MADE.test(String(body || ''));
}

function ghLabel(it) {
  const repo = String(it.repository_url || '').split('/').slice(-1)[0];
  return `${repo}#${it.number}: ${it.title}`;
}

function isoSec(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// What I did in a window: the "Yesterday" of a stand-up, and the recent work
// a review or retro draws on.
// The opening of a PR description or a session's first prompt: what the work
// actually was, so a stand-up line can say what changed and not just a title.
function gist(text, prefix = '') {
  const t = String(text || '')
    .replace(/^>>\s*/gm, '')
    .replace(/^#+\s*\w+\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? ` — ${prefix}${t.slice(0, 220)}` : '';
}

async function doneSince(ctx, from, to) {
  const out = [];
  if (ctx.githubLogin) {
    // One after the other: concurrent search calls trip GitHub's secondary
    // rate limit, which then fails the ingest pass's searches too.
    const merged = await ghSearch(`is:pr author:${ctx.githubLogin} merged:>=${isoSec(from)}`);
    const reviewed = await ghSearch(`is:pr reviewed-by:${ctx.githubLogin} -author:${ctx.githubLogin} updated:>=${isoSec(from)}`);
    for (const it of merged.slice(0, 6)) {
      const what = agentMade(it.body) ? 'Agent PR merged (an AI agent wrote it under my account; not my own work)' : 'Merged PR';
      out.push(item(`gh:${it.html_url}`, `${what} ${ghLabel(it)}`, { url: it.html_url, when: it.closed_at }));
    }
    for (const it of reviewed.slice(0, 5)) {
      const whose = it.user?.login ? `${it.user.login}'s ` : '';
      out.push(item(`gh:${it.html_url}`, `Reviewed ${whose}PR ${ghLabel(it)} (someone else's work)`, { url: it.html_url, when: it.updated_at }));
    }
  }
  if (ctx.githubLogin) {
    const prs = await rows(
      `select id, subject, occurred_at, raw, left(body_text, 600) as body,
              body_text ~* $4 as agent from source_item
        where source = 'github_pr' and author_identity = $1 and occurred_at between $2 and $3
        order by occurred_at desc limit 6`,
      [`github:${ctx.githubLogin}`, from, to, 'generated with \\[?claude code|co-authored-by:\\s*claude']
    );
    for (const p of prs) {
      const whose = p.agent ? 'Agent PR on my account (an AI agent wrote it; not my own work)' : `Activity on my ${p.raw?.draft ? 'draft ' : ''}PR`;
      out.push(item(`gh:${p.raw?.webUrl || p.id}`, `${whose}: ${p.subject}${gist(p.body)}`, { url: p.raw?.webUrl, when: p.occurred_at }));
    }
  }
  const jira = await rows(
    `select id, subject, occurred_at, raw from source_item
      where source = 'jira_issue' and occurred_at between $1 and $2
        and (lower(raw->>'assignee') = any($3::text[]))
      order by occurred_at desc limit 6`,
    [from, to, [ctx.name, ...ctx.myEmails].filter(Boolean).map((s) => s.toLowerCase())]
  );
  for (const j of jira) out.push(item(`item:${j.id}`, `Ticket ${j.subject} — now ${j.raw?.status || '?'}`, { url: j.raw?.webUrl, when: j.occurred_at }));

  const closed = await rows(
    `select id, summary, closed_reason, closed_at from commitment
      where direction = 'owed_by_me' and status = 'done' and closed_at between $1 and $2
        -- Only what I closed or did. "PR merged" is someone else's PR landing
        -- (githubReconcile closing a review ask), not my work to report.
        and (closed_reason is null or closed_reason in ('you marked it done', 'you reviewed it'))
      order by closed_at desc limit 6`,
    [from, to]
  ).catch(() => []);
  for (const c of closed) {
    out.push(item(`commitment:${c.id}`, `Closed: ${c.summary}${c.closed_reason ? ` (${c.closed_reason})` : ''}`, { when: c.closed_at }));
  }

  const sessions = await rows(
    `select id, subject, occurred_at, raw, left(body_text, 600) as body from source_item
      where source = 'claude_session' and occurred_at between $1 and $2
      order by coalesce((raw->>'turns')::int, 0) desc limit 8`,
    [from, to]
  );
  for (const s of sessions) {
    const where = [s.raw?.cwd ? path.basename(String(s.raw.cwd)) : null, s.raw?.gitBranch && s.raw.gitBranch !== 'HEAD' ? s.raw.gitBranch : null]
      .filter(Boolean)
      .join(' @ ');
    out.push(item(`item:${s.id}`, `Coding session: ${s.subject}${where ? ` (${where})` : ''}${gist(s.body, 'I asked: ')}`, { when: s.occurred_at }));
  }
  return out;
}

async function todayItems(ctx, now) {
  const out = [];
  const due = await rows(
    `select id, summary, due_at from commitment
      where direction = 'owed_by_me' and status in ('open','dispatched') and superseded_by is null
        and due_at is not null and due_at < $1::timestamptz + interval '2 days'
        and due_at > $1::timestamptz - interval '14 days'
      order by due_at limit 6`,
    [now]
  );
  for (const c of due) out.push(item(`commitment:${c.id}`, `${new Date(c.due_at) < now ? 'Overdue' : 'Due'} ${c.due_at.toISOString().slice(0, 10)}: ${c.summary}`));
  const fresh = await rows(
    `select id, summary from commitment
      where direction = 'owed_by_me' and status = 'open' and superseded_by is null and due_at is null
        and extracted_at > $1::timestamptz - interval '1 day' and coalesce(confidence, 0) >= 0.6
      order by extracted_at desc limit 4`,
    [now]
  );
  for (const c of fresh) out.push(item(`commitment:${c.id}`, `New ask: ${c.summary}`));

  const jira = await rows(
    `select id, subject, raw from source_item
      where source = 'jira_issue' and raw->>'state' = 'opened' and lower(raw->>'assignee') = any($1::text[])
      order by occurred_at desc limit 5`,
    [[ctx.name, ...ctx.myEmails].filter(Boolean).map((s) => s.toLowerCase())]
  );
  for (const j of jira) out.push(item(`item:${j.id}`, `Ticket ${j.subject} (${j.raw?.status || 'open'})`, { url: j.raw?.webUrl }));

  if (ctx.githubLogin) {
    const mine = await rows(
      `select id, subject, raw, body_text ~* $3 as agent from source_item
        where source = 'github_pr' and author_identity = $1 and raw->>'state' = 'opened'
          and occurred_at > $2::timestamptz - interval '14 days'
        order by occurred_at desc limit 5`,
      [`github:${ctx.githubLogin}`, now, 'generated with \\[?claude code|co-authored-by:\\s*claude']
    );
    for (const p of mine) {
      const whose = p.agent ? 'Agent PR on my account waiting for me to review and merge' : `My open ${p.raw?.draft ? 'draft ' : ''}PR`;
      out.push(item(`gh:${p.raw?.webUrl || p.id}`, `${whose}: ${p.subject}`, { url: p.raw?.webUrl }));
    }
    const asked = await ghSearch(`is:open is:pr user-review-requested:${ctx.githubLogin} archived:false`);
    for (const it of asked.slice(0, 5)) out.push(item(`gh:${it.html_url}`, `Review asked of me: ${ghLabel(it)}`, { url: it.html_url }));
  }
  return out;
}

async function blockerItems(ctx, now) {
  const claims = await rows(
    `select id, text, quote from claim
      where status = 'active' and kind = 'blocker' and subject_kind = 'me'
        and valid_at > $1::timestamptz - interval '21 days' and invalid_at is null
      order by valid_at desc limit 3`,
    [now]
  ).catch(() => []);
  const out = claims.map((c) => item(`claim:${c.id}`, `${c.text}${c.quote ? ` — "${String(c.quote).slice(0, 120)}"` : ''}`));
  if (ctx.githubLogin) {
    const blocked = await rows(
      `select id, subject, raw from source_item
        where source = 'github_pr' and author_identity = $1 and raw->>'state' = 'opened'
          and exists (select 1 from jsonb_array_elements_text(coalesce(raw->'labels','[]'::jsonb)) l where l ilike '%block%')
        limit 3`,
      [`github:${ctx.githubLogin}`]
    );
    for (const p of blocked) out.push(item(`gh:${p.raw?.webUrl || p.id}`, `Blocked label on ${p.subject}`, { url: p.raw?.webUrl }));
  }
  return out;
}

async function personFor(email) {
  return one(
    `select p.id, p.display_name from person p
      where not p.is_me and (lower(p.primary_email) = $1
         or p.id in (select person_id from person_identity where kind = 'smtp' and value = $1))
      limit 1`,
    [email]
  );
}

async function personPageItem(person) {
  const memory = require('../memory');
  const page = await memory.getPage({ kind: 'person', id: person.id }).catch(() => null);
  return page ? item(`page:person:${person.id}`, `${person.display_name}'s page: ${String(page.body).slice(0, 700)}`) : null;
}

async function oneOnOneSections(m, ctx, now) {
  const otherEmail = m.attendees.find((a) => !ctx.myEmails.includes(a));
  const person = otherEmail ? await personFor(otherEmail) : null;
  if (!person) {
    // Not (yet) a person in the store: their own messages by address, and
    // whatever recall finds for the meeting and their name.
    const threads = otherEmail
      ? await rows(
          `select id, source, subject, occurred_at, left(body_text, 220) as snippet from source_item
            where source in ('graph_chat','graph_mail') and lower(author_identity) = $1
              and occurred_at > $2::timestamptz - interval '21 days'
            order by occurred_at desc limit 6`,
          [otherEmail, now]
        )
      : [];
    const name = otherEmail ? otherEmail.split('@')[0].replace(/[._-]+/g, ' ') : '';
    return [
      { title: 'Recent threads with them', items: threads.map((t) => item(`item:${t.id}`, `${t.subject || t.source}: ${t.snippet}`, { when: t.occurred_at })) },
      ...(await generalSections({ ...m, subject: `${m.subject} ${name}`.trim() }, ctx)),
    ];
  }
  const commitments = await rows(
    `select id, direction, summary, due_at from commitment
      where counterparty_person_id = $1 and status in ('open','dispatched') and superseded_by is null
      order by due_at nulls last, extracted_at desc limit 12`,
    [person.id]
  );
  const due = (c) => (c.due_at ? ` (due ${c.due_at.toISOString().slice(0, 10)})` : '');
  const idents = await rows('select value from person_identity where person_id = $1', [person.id]);
  const threads = await rows(
    `select id, source, subject, occurred_at, left(body_text, 220) as snippet from source_item
      where source in ('graph_chat','graph_mail') and author_identity = any($1::text[])
        and occurred_at > $2::timestamptz - interval '21 days'
      order by occurred_at desc limit 6`,
    [idents.map((i) => i.value), now]
  );
  const claims = await rows(
    `select id, text from claim where subject_kind = 'person' and subject_id = $1 and status = 'active'
      order by valid_at desc limit 5`,
    [person.id]
  );
  const page = await personPageItem(person);
  return [
    { title: `I owe ${person.display_name}`, items: commitments.filter((c) => c.direction === 'owed_by_me').map((c) => item(`commitment:${c.id}`, `${c.summary}${due(c)}`)) },
    { title: `${person.display_name} owes me`, items: commitments.filter((c) => c.direction === 'owed_to_me').map((c) => item(`commitment:${c.id}`, `${c.summary}${due(c)}`)) },
    { title: 'Recent threads with them', items: threads.map((t) => item(`item:${t.id}`, `${t.subject || t.source}: ${t.snippet}`, { when: t.occurred_at })) },
    { title: 'What memory holds about them', items: [page, ...claims.map((c) => item(`claim:${c.id}`, c.text))].filter(Boolean) },
  ];
}

async function generalSections(m, ctx) {
  const { recall } = require('../recall');
  const q = `${m.subject} ${m.description}`.trim().slice(0, 300);
  const r = await recall(q, { limit: 6 }).catch((err) => {
    log.warn('recall failed', { message: err.message });
    return { items: [], claims: [] };
  });
  const related = [
    ...r.items.filter((it) => it.source !== 'graph_event').map((it) => item(`item:${it.id}`, `${it.subject || it.source}: ${it.snippet || ''}`, { when: it.occurred_at })),
    ...r.claims.map((c) => item(`claim:${c.id}`, `${c.subject ? `${c.subject}: ` : ''}${c.text}`)),
  ];
  const pages = [];
  if (m.attendees.length <= 15) {
    for (const email of m.attendees.filter((a) => !ctx.myEmails.includes(a)).slice(0, 10)) {
      const person = await personFor(email);
      const page = person ? await personPageItem(person) : null;
      if (page) pages.push({ ...page, text: page.text.slice(0, 400) });
      if (pages.length >= 3) break;
    }
  }
  return [
    { title: 'Related from mail, chat, tickets and memory', items: related.slice(0, 8) },
    { title: 'Attendees memory knows', items: pages },
  ];
}

function profileSections(profile) {
  const out = [];
  if (profile?.asks?.length) {
    out.push({ title: 'Usually asked in this meeting (from past transcripts)', items: profile.asks.slice(0, 4).map((a, i) => item(`ask:${i}`, `${a.text} — "${a.quote}"`)) });
  }
  if (profile?.lastSaid?.items?.length) {
    const when = String(profile.lastSaid.start || '').slice(0, 10);
    out.push({
      title: `Said last time (${when}, from the transcript)`,
      items: profile.lastSaid.items.map((s, i) => item(`said:${i}`, `${s.promise ? 'Promised' : 'Reported'}: ${s.text} — "${s.quote}"`)),
    });
  }
  return out;
}

/**
 * Everything the brief may say, as labelled sections. Exported for
 * `pa meeting brief --evidence`.
 */
async function gatherEvidence(m, kind, ctx, { now = new Date() } = {}) {
  const series = await seriesRow(m);
  const profile = series?.profile || {};
  const meeting = {
    title: m.subject,
    kind,
    start: m.start,
    minutes: m.minutes,
    description: m.description,
    attendees: m.attendees.filter((a) => !ctx.myEmails.includes(a)),
  };
  let sections = [];
  let window = null;

  if (kind === 'standup') {
    // Briefed an hour ahead, the meeting is the anchor. Asked days ahead (a
    // test, or "brief me now" on Friday for Monday), now is: the work to
    // report is the work done so far.
    const anchor = new Date(m.start) - now <= 12 * 3600_000 ? new Date(m.start) : now;
    const previous = (await seriesOccurrences(m.seriesKey))
      .filter((o) => !o.cancelled && new Date(o.start) < anchor && new Date(o.start) < now)
      .pop();
    window = core.standupWindow(anchor, { now, previousStart: previous?.start });
    sections = [
      { title: 'Done since the last stand-up', items: await doneSince(ctx, window.from, window.to) },
      { title: 'On my plate today', items: await todayItems(ctx, now) },
      { title: 'Possible blockers', items: await blockerItems(ctx, now) },
    ];
  } else if (kind === 'one_on_one') {
    sections = await oneOnOneSections(m, ctx, now);
  } else {
    sections = await generalSections(m, ctx);
    if (kind === 'review' || kind === 'retro' || kind === 'planning') {
      const from = new Date(now.getTime() - 7 * DAY);
      window = { from, to: now, basis: 'workday' };
      sections.unshift({ title: 'My work in the last week', items: (await doneSince(ctx, from, now)).slice(0, 10) });
    }
  }
  sections.push(...profileSections(profile));
  return { meeting, sections, window, profile };
}

// --------------------------------------------------------------- brief ----

async function briefRow(key) {
  return one('select * from meeting_brief where dedupe_key = $1', [key]);
}

async function writeBrief(m, kind, ctx, { now }) {
  const ev = await gatherEvidence(m, kind, ctx, { now });
  const { prompt, refs } = P.buildBriefPrompt(ev);
  const reply = await llm.complete({
    system: P.BRIEF_SYSTEM,
    prompt,
    model: config.meetings.model,
    effort: config.meetings.effort,
    maxTokens: 2000,
    purpose: 'meeting-brief',
  });
  const rendered = P.renderBrief(llm.extractJson(reply), refs, { joinUrl: m.joinUrl });
  // Keep only the refs the brief cites, with their evidence text, for the view.
  const cited = {};
  for (const p of [...rendered.points, ...rendered.context]) for (const r of p.refs) cited[r] = refs[r];
  return { rendered, refs: cited };
}

/**
 * @param {string|number} target  event external id, graph_event item id, or 'next'
 * @param {object} [opts]
 * @param {boolean} [opts.deliver=false] notify (toast + feed)
 * @param {boolean} [opts.force=false]   rewrite even if a fresh brief exists
 */
async function brief(target, { deliver = false, force = false, now = new Date() } = {}) {
  const ctx = await context();
  const m = typeof target === 'object' && target?.eventId ? target : await resolveTarget(target, { now, ctx });
  const { kind, source } = await classify(m, ctx);
  const key = core.dedupeKey(m);
  let row = await briefRow(key);
  const fresh = row && !row.error && row.body && now - new Date(row.updated_at) < 45 * 60_000;

  if (!fresh || force) {
    try {
      const { rendered, refs } = await writeBrief(m, kind, ctx, { now });
      row = await one(
        `insert into meeting_brief (dedupe_key, event_external_id, source_item_id, starts_at, series_key, kind, title,
                                    headline, body, points, refs, join_url, error, attempts)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,1)
         on conflict (dedupe_key) do update set kind = excluded.kind, title = excluded.title,
           headline = excluded.headline, body = excluded.body, points = excluded.points, refs = excluded.refs,
           join_url = excluded.join_url, error = null, attempts = meeting_brief.attempts + 1, updated_at = now()
         returning *`,
        [key, m.eventId, m.itemId, m.start, m.seriesKey, kind, m.subject, rendered.headline, rendered.body,
          JSON.stringify({ points: rendered.points, context: rendered.context }), JSON.stringify(refs), m.joinUrl]
      );
      log.info('briefed', { brief: row.id, kind, words: rendered.words, refs: Object.keys(refs).length });
    } catch (err) {
      await query(
        `insert into meeting_brief (dedupe_key, event_external_id, source_item_id, starts_at, series_key, kind, title, error, attempts)
         values ($1,$2,$3,$4,$5,$6,$7,$8,1)
         on conflict (dedupe_key) do update set error = excluded.error, attempts = meeting_brief.attempts + 1, updated_at = now()`,
        [key, m.eventId, m.itemId, m.start, m.seriesKey, kind, m.subject, String(err.message).slice(0, 500)]
      );
      throw err;
    }
  }

  if (deliver && !row.notification_id) {
    const { notify, dashboardUrl } = require('../notify');
    const at = new Date(m.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const n = await notify({
      kind: 'meeting_brief',
      title: `${at} ${m.subject} · ${core.KIND_LABEL[kind] || kind}`,
      body: row.body,
      url: dashboardUrl(`brief-${row.id}`),
      dedupeKey: key,
      actions: [{ label: 'Open brief', url: dashboardUrl(`brief-${row.id}`) }, ...(m.joinUrl ? [{ label: 'Join', url: m.joinUrl }] : [])],
    });
    if (n) row = await one('update meeting_brief set notification_id = $2 where id = $1 returning *', [row.id, n.id]);
  }
  return { meeting: m, kind, kindSource: source, brief: row };
}

// ------------------------------------------------------------ learning ----

async function transcriptsFor(m) {
  return rows(
    `select si.id, si.body_text, si.occurred_at from source_item si
      where si.source = 'audio' and length(si.body_text) > 40
        -- A superseded episode's speech lives in another row (ingest/audio.js).
        and not exists (select 1 from audio_episode x where x.source_item_id = si.id and x.state = 'superseded')
        and (
            si.thread_external_id = $1
         or si.id in (select source_item_id from audio_episode where calendar_event_id = $1 and source_item_id is not null)
         or si.occurred_at between $2::timestamptz - interval '10 minutes' and $3::timestamptz)
      order by si.occurred_at`,
    [m.eventId, m.start, m.end]
  );
}

function sourceOf(quote, items, verify) {
  const hit = items.find((it) => {
    const v = verify(quote, it.body_text);
    return v === 'exact' || v === 'fragments';
  });
  return hit || items[0];
}

async function learnOccurrence(m, kind, items) {
  const { verifyQuote, headTail } = require('../memory/claims');
  const transcript = items.map((i) => i.body_text).join('\n\n');
  const reply = await llm.complete({
    system: P.LEARN_SYSTEM,
    prompt: P.buildLearnPrompt({ title: m.subject, kind, start: m.start, transcript: headTail(transcript, 24000) }),
    model: config.meetings.model,
    effort: 'low',
    maxTokens: 2000,
    purpose: 'meeting-learn',
  });
  const learned = P.parseLearn(llm.extractJson(reply), { transcript, myLines: P.myLinesOf(transcript), verify: verifyQuote });

  const series = await seriesRow(m);
  const profile = { ...(series?.profile || {}) };
  const key = core.dedupeKey(m);
  if (learned.format) {
    profile.format = learned.format;
    profile.formatQuote = learned.formatQuote;
  }
  const asks = [...learned.asks.map((a) => ({ ...a, start: m.start })), ...(profile.asks || [])];
  const seen = new Set();
  profile.asks = asks.filter((a) => !seen.has(a.text.toLowerCase()) && seen.add(a.text.toLowerCase())).slice(0, 8);
  if (!profile.lastSaid || new Date(profile.lastSaid.start) <= new Date(m.start)) {
    profile.lastSaid = { eventId: m.eventId, start: m.start, items: learned.said };
  }
  profile.learnedFrom = [key, ...(profile.learnedFrom || []).filter((k) => k !== key)].slice(0, 30);
  profile.learnedAt = new Date().toISOString();
  await saveSeries(m, { profile });

  // Memory carries its evidence: every claim here holds a quote that was just
  // verified against the transcript it came from.
  const label = m.seriesKey;
  const day = m.start.slice(0, 10);
  const claims = [
    ...(learned.format && learned.formatQuote ? [{ kind: 'workflow', text: `The "${m.subject}" meeting: ${learned.format}`, quote: learned.formatQuote }] : []),
    ...learned.asks.map((a) => ({ kind: 'workflow', text: `In "${m.subject}", I get asked: ${a.text}`, quote: a.quote })),
    ...learned.said.map((s) => ({ kind: 'status', text: `In "${m.subject}" on ${day} I ${s.promise ? 'promised' : 'reported'}: ${s.text}`, quote: s.quote })),
  ];
  const ids = [];
  for (const c of claims) {
    const src = sourceOf(c.quote, items, verifyQuote);
    const row = await one(
      `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id, source_kind,
                          confidence, valid_at, status, origin, extracted_by)
       values ('topic', null, $1, $2, $3, $4, $5, 'audio', 0.8, $6, 'active', 'distill', $7) returning id`,
      [label, c.kind, c.text, c.quote, src?.id ?? null, m.start, LEARN_VERSION]
    );
    ids.push(row.id);
  }
  if (ids.length && config.memory.enabled) {
    await require('../memory/consolidate').consolidateClaims(ids).catch((err) => log.warn('consolidate failed', { message: err.message }));
  }
  log.info('learned', { asks: learned.asks.length, said: learned.said.length, claims: ids.length });
  return { learned, claims: ids.length };
}

// Occurrences that ended in the last three days and have a transcript we have
// not learned from. A transcript can lag the meeting by an hour (the audio
// pass is half-hourly), so an occurrence without one is retried, not marked.
async function learnRecent({ now = new Date(), limit = 3 } = {}) {
  const ctx = await context();
  const past = (await eventsBetween(new Date(now.getTime() - 3 * DAY), now)).filter(
    (m) => new Date(m.end) < now && core.eligibility(m, eligibilityOpts(ctx)).ok
  );
  let done = 0;
  for (const m of past.reverse()) {
    if (done >= limit) break;
    const series = await seriesRow(m);
    if ((series?.profile?.learnedFrom || []).includes(core.dedupeKey(m))) continue;
    const items = await transcriptsFor(m);
    if (!items.length) continue;
    const { kind } = await classify(m, ctx);
    try {
      await learnOccurrence(m, kind, items);
      done++;
    } catch (err) {
      log.warn('learning failed', { message: err.message });
    }
  }
  return done;
}

// ----------------------------------------------------------- upcoming -----

async function upcoming({ hours = 24, now = new Date(), limit = 10 } = {}) {
  const ctx = await context();
  const list = (await eventsBetween(new Date(now.getTime() - 15 * 60_000), new Date(now.getTime() + hours * 3600_000)))
    .filter((m) => new Date(m.end) > now)
    .slice(0, limit);
  const out = [];
  for (const m of list) {
    const elig = core.eligibility(m, eligibilityOpts(ctx));
    const { kind } = await classify(m, ctx, { allowModel: false });
    const b = await briefRow(core.dedupeKey(m));
    out.push({
      eventId: m.eventId,
      itemId: m.itemId,
      subject: m.subject,
      start: m.start,
      end: m.end,
      kind,
      eligible: elig.ok,
      skipReason: elig.reason,
      joinUrl: m.joinUrl,
      brief: b ? briefView(b) : null,
    });
  }
  return out;
}

function briefView(b) {
  return {
    id: b.id,
    title: b.title,
    kind: b.kind,
    startsAt: b.starts_at,
    headline: b.headline,
    body: b.body,
    points: b.points?.points || [],
    context: b.points?.context || [],
    refs: b.refs || {},
    joinUrl: b.join_url,
    error: b.error,
    notified: !!b.notification_id,
    updatedAt: b.updated_at,
  };
}

async function getBrief(id) {
  const b = await one('select * from meeting_brief where id = $1', [id]);
  return b ? briefView(b) : null;
}

// ---------------------------------------------------------------- pass ----

async function pass({ now = new Date() } = {}) {
  if (!config.meetings.enabled) return { briefed: 0 };
  await learnRecent({ now }).catch((err) => log.warn('learn pass failed', { message: err.message }));

  const ctx = await context();
  const soon = await eventsBetween(now, new Date(now.getTime() + config.meetings.leadMinutes * 60_000));
  let briefed = 0;
  for (const m of soon) {
    if (!core.dueForBrief(m, { now, leadMinutes: config.meetings.leadMinutes })) continue;
    if (!core.eligibility(m, eligibilityOpts(ctx)).ok) continue;
    const existing = await briefRow(core.dedupeKey(m));
    if (existing?.notification_id) continue;
    if (existing?.error && existing.attempts >= 3) continue;
    try {
      await brief(m, { deliver: true, now });
      briefed++;
    } catch (err) {
      log.warn('brief failed', { message: err.message });
    }
  }
  return { briefed };
}

module.exports = {
  pass,
  brief,
  upcoming,
  getBrief,
  learnRecent,
  gatherEvidence,
  classify,
  setKind,
  context,
  resolveTarget,
  transcriptsFor,
};
