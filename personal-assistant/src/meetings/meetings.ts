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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const llm = require('../llm.ts');
const { config } = require('../config.ts');
const repo = require('../repo');
const { logger } = require('../log.ts');
const core = require('./core.ts');
const P = require('./prompt.ts');

const log = logger('meetings');
const LEARN_VERSION = 'meeting-learn-v1';
const DAY = 86400_000;

// ------------------------------------------------------------ identity ----

async function context() {
  const me = await repo.people.me();
  const ids = me ? await repo.people.identitiesOf(me.id) : [];
  const cursor = await repo.sources.cursorState('m365').catch(() => null);
  const gh = await repo.sources.cursorState('github').catch(() => null);
  const emails = new Set(
    [me?.primary_email, cursor?.state?.me?.mail, ...ids.filter((i: any) => i.kind === 'smtp').map((i: any) => i.value)]
      .filter(Boolean)
      .map((e) => e.toLowerCase())
  );
  const githubLogin = ids.find((i: any) => i.kind === 'github_username')?.value || gh?.state?.login || null;
  return {
    personId: me?.id ?? null,
    name: me?.display_name || null,
    myEmails: [...emails],
    githubLogin,
    domain: core.domainOf([...emails][0]),
  };
}

// ------------------------------------------------------------- events -----

async function eventsBetween(from: any, to: any) {
  const list = await repo.sources.eventsBetween(new Date(from), new Date(to));
  return list.map(core.toMeeting);
}

async function seriesOccurrences(seriesKey: any) {
  // The subject filter narrows; seriesKey decides (it strips "Canceled:").
  const words = seriesKey.split(' ').filter((w: any) => w.length > 2).slice(0, 3);
  const like = words.length ? `%${words.join('%')}%` : '%';
  const list = await repo.sources.eventsBySubject(like);
  return list.map(core.toMeeting).filter((m: any) => m.seriesKey === seriesKey);
}

async function resolveTarget(target: any, { now = new Date(), ctx }: { now?: any; ctx?: any } = {}) {
  const t = String(target ?? 'next').trim();
  if (t === 'next') {
    const list = await eventsBetween(now, new Date(now.getTime() + 14 * DAY));
    const next = list.find((m: any) => new Date(m.start) > now && core.eligibility(m, eligibilityOpts(ctx)).ok);
    if (!next) throw new Error('no upcoming meeting that would be briefed in the next 14 days');
    return next;
  }
  const row = /^\d+$/.test(t) ? await repo.sources.eventById(Number(t)) : await repo.sources.eventByExternalId(t);
  if (!row) throw new Error(`no calendar event "${t}"`);
  return core.toMeeting(row);
}

function eligibilityOpts(ctx: any) {
  return {
    myEmails: ctx?.myEmails || [],
    maxAttendees: config.meetings.maxAttendees,
    focusBlocks: config.meetings.focusBlocks,
  };
}

// ------------------------------------------------------ classification ----

async function seriesRow(m: any) {
  return repo.meetings.seriesByKey(m.seriesKey);
}

async function saveSeries(m: any, patch: any) {
  return repo.meetings.saveSeries({
    seriesKey: m.seriesKey,
    label: core.seriesLabel(m.subject),
    kind: patch.kind ?? null,
    kindSource: patch.kindSource ?? null,
    profile: patch.profile ?? null,
  });
}

async function classify(m: any, ctx: any, { allowModel = true }: { allowModel?: boolean } = {}) {
  const cached = await seriesRow(m);
  if (cached?.kind && (cached.kind_source === 'manual' || cached.kind_source === 'model')) {
    return { kind: cached.kind, source: cached.kind_source };
  }
  const occurrences = await seriesOccurrences(m.seriesKey);
  const det = core.classifyDeterministic(m, { myEmails: ctx.myEmails, seriesStarts: occurrences.map((o: any) => o.start) });
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
  } catch (err: any) {
    log.warn('classification failed', { message: err.message });
    return { kind: 'other', source: 'default' };
  }
}

async function setKind(seriesOrEvent: any, kind: string) {
  const k = core.normaliseKind(kind);
  if (k !== kind) throw new Error(`kind must be one of ${core.KINDS.join(', ')}`);
  const key = core.seriesKey(seriesOrEvent);
  const row = await repo.meetings.setSeriesKind(key, k);
  if (row) return row;
  return saveSeries({ seriesKey: key, subject: String(seriesOrEvent) }, { kind: k, kindSource: 'manual' });
}

// ------------------------------------------------------------ evidence ----

const item = (key: any, text: string, extra: any = {}) => ({ key, text, ...extra });

async function ghSearch(q: string) {
  if (!config.github.enabled) return [];
  const { api } = require('../ingest/github.ts');
  try {
    const r = await api(`/search/issues?per_page=20&q=${encodeURIComponent(q)}`);
    return r.items || [];
  } catch (err: any) {
    log.debug('github search failed', { message: err.message });
    return [];
  }
}

// A PR under my account that an AI agent wrote — Claude Code's footer or
// co-author trailer in its description. Agents (dispatched runs, cloud or
// remote sessions) open PRs as me; a brief that says "I shipped X" about one
// is putting words in my mouth.
const AGENT_MADE = /generated with \[?claude code|co-authored-by:\s*claude|🤖 generated with/i;

function agentMade(body: any) {
  return AGENT_MADE.test(String(body || ''));
}

function ghLabel(it: any) {
  const repo = String(it.repository_url || '').split('/').slice(-1)[0];
  return `${repo}#${it.number}: ${it.title}`;
}

function isoSec(d: any) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// What I did in a window: the "Yesterday" of a stand-up, and the recent work
// a review or retro draws on.
// The opening of a PR description or a session's first prompt: what the work
// actually was, so a stand-up line can say what changed and not just a title.
function gist(text: string, prefix: string = '') {
  const t = String(text || '')
    .replace(/^>>\s*/gm, '')
    .replace(/^#+\s*\w+\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? ` — ${prefix}${t.slice(0, 220)}` : '';
}

async function doneSince(ctx: any, from: any, to: string) {
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
    const prs = await repo.sources.prsByAuthorBetween(`github:${ctx.githubLogin}`, from, to, 'generated with \\[?claude code|co-authored-by:\\s*claude');
    for (const p of prs) {
      const whose = p.agent ? 'Agent PR on my account (an AI agent wrote it; not my own work)' : `Activity on my ${p.raw?.draft ? 'draft ' : ''}PR`;
      out.push(item(`gh:${p.raw?.webUrl || p.id}`, `${whose}: ${p.subject}${gist(p.body)}`, { url: p.raw?.webUrl, when: p.occurred_at }));
    }
  }
  const jira = await repo.sources.jiraAssignedBetween(from, to, [ctx.name, ...ctx.myEmails].filter(Boolean).map((s) => s.toLowerCase()));
  for (const j of jira) out.push(item(`item:${j.id}`, `Ticket ${j.subject} — now ${j.raw?.status || '?'}`, { url: j.raw?.webUrl, when: j.occurred_at }));

  const closed = await repo.commitments.closedByMeBetween(from, to).catch(() => []);
  for (const c of closed) {
    out.push(item(`commitment:${c.id}`, `Closed: ${c.summary}${c.closed_reason ? ` (${c.closed_reason})` : ''}`, { when: c.closed_at }));
  }

  const sessions = await repo.sources.claudeSessionsBetween(from, to);
  for (const s of sessions) {
    const where = [s.raw?.cwd ? String(s.raw.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null, s.raw?.gitBranch && s.raw.gitBranch !== 'HEAD' ? s.raw.gitBranch : null]
      .filter(Boolean)
      .join(' @ ');
    out.push(item(`item:${s.id}`, `Coding session: ${s.subject}${where ? ` (${where})` : ''}${gist(s.body, 'I asked: ')}`, { when: s.occurred_at }));
  }
  return out;
}

async function todayItems(ctx: any, now: any) {
  const out = [];
  const due = await repo.commitments.dueSoonOwedByMe(now);
  for (const c of due) out.push(item(`commitment:${c.id}`, `${new Date(c.due_at) < now ? 'Overdue' : 'Due'} ${c.due_at.toISOString().slice(0, 10)}: ${c.summary}`));
  const fresh = await repo.commitments.freshAsksOwedByMe(now);
  for (const c of fresh) out.push(item(`commitment:${c.id}`, `New ask: ${c.summary}`));

  const jira = await repo.sources.openJiraAssigned([ctx.name, ...ctx.myEmails].filter(Boolean).map((s) => s.toLowerCase()), 5);
  for (const j of jira) out.push(item(`item:${j.id}`, `Ticket ${j.subject} (${j.raw?.status || 'open'})`, { url: j.raw?.webUrl }));

  if (ctx.githubLogin) {
    const mine = await repo.sources.openPrsRecent(`github:${ctx.githubLogin}`, now, 'generated with \\[?claude code|co-authored-by:\\s*claude');
    for (const p of mine) {
      const whose = p.agent ? 'Agent PR on my account waiting for me to review and merge' : `My open ${p.raw?.draft ? 'draft ' : ''}PR`;
      out.push(item(`gh:${p.raw?.webUrl || p.id}`, `${whose}: ${p.subject}`, { url: p.raw?.webUrl }));
    }
    const asked = await ghSearch(`is:open is:pr user-review-requested:${ctx.githubLogin} archived:false`);
    for (const it of asked.slice(0, 5)) out.push(item(`gh:${it.html_url}`, `Review asked of me: ${ghLabel(it)}`, { url: it.html_url }));
  }
  return out;
}

async function blockerItems(ctx: any, now: any) {
  const claims = await repo.memory.activeBlockers(now).catch(() => []);
  const out = claims.map((c: any) => item(`claim:${c.id}`, `${c.text}${c.quote ? ` — "${String(c.quote).slice(0, 120)}"` : ''}`));
  if (ctx.githubLogin) {
    const blocked = await repo.sources.blockedPrs(`github:${ctx.githubLogin}`);
    for (const p of blocked) out.push(item(`gh:${p.raw?.webUrl || p.id}`, `Blocked label on ${p.subject}`, { url: p.raw?.webUrl }));
  }
  return out;
}

async function personFor(email: string) {
  return repo.people.otherByEmail(email);
}

async function personPageItem(person: any) {
  const memory = require('../memory');
  const page = await memory.getPage({ kind: 'person', id: person.id }).catch(() => null);
  return page ? item(`page:person:${person.id}`, `${person.display_name}'s page: ${String(page.body).slice(0, 700)}`) : null;
}

async function oneOnOneSections(m: any, ctx: any, now: any) {
  const otherEmail = m.attendees.find((a: any) => !ctx.myEmails.includes(a));
  const person = otherEmail ? await personFor(otherEmail) : null;
  if (!person) {
    // Not (yet) a person in the store: their own messages by address, and
    // whatever recall finds for the meeting and their name.
    const threads = otherEmail ? await repo.sources.threadsFromAddress(otherEmail, now) : [];
    const name = otherEmail ? otherEmail.split('@')[0].replace(/[._-]+/g, ' ') : '';
    return [
      { title: 'Recent threads with them', items: threads.map((t: any) => item(`item:${t.id}`, `${t.subject || t.source}: ${t.snippet}`, { when: t.occurred_at })) },
      ...(await generalSections({ ...m, subject: `${m.subject} ${name}`.trim() }, ctx)),
    ];
  }
  const commitments = await repo.commitments.openWithPerson(person.id);
  const due = (c: any) => (c.due_at ? ` (due ${c.due_at.toISOString().slice(0, 10)})` : '');
  const idents = await repo.people.identitiesOf(person.id);
  const threads = await repo.sources.threadsFromIdentities(idents.map((i: any) => i.value), now);
  const claims = await repo.memory.activeForPerson(person.id);
  const page = await personPageItem(person);
  return [
    { title: `I owe ${person.display_name}`, items: commitments.filter((c: any) => c.direction === 'owed_by_me').map((c: any) => item(`commitment:${c.id}`, `${c.summary}${due(c)}`)) },
    { title: `${person.display_name} owes me`, items: commitments.filter((c: any) => c.direction === 'owed_to_me').map((c: any) => item(`commitment:${c.id}`, `${c.summary}${due(c)}`)) },
    { title: 'Recent threads with them', items: threads.map((t: any) => item(`item:${t.id}`, `${t.subject || t.source}: ${t.snippet}`, { when: t.occurred_at })) },
    { title: 'What memory holds about them', items: [page, ...claims.map((c: any) => item(`claim:${c.id}`, c.text))].filter(Boolean) },
  ];
}

async function generalSections(m: any, ctx: any) {
  const { recall } = require('../recall');
  const q = `${m.subject} ${m.description}`.trim().slice(0, 300);
  const r = await recall(q, { limit: 6 }).catch((err: Error) => {
    log.warn('recall failed', { message: err.message });
    return { items: [], claims: [] };
  });
  const related = [
    ...r.items.filter((it: any) => it.source !== 'graph_event').map((it: any) => item(`item:${it.id}`, `${it.subject || it.source}: ${it.snippet || ''}`, { when: it.occurred_at })),
    ...r.claims.map((c: any) => item(`claim:${c.id}`, `${c.subject ? `${c.subject}: ` : ''}${c.text}`)),
  ];
  const pages = [];
  if (m.attendees.length <= 15) {
    for (const email of m.attendees.filter((a: any) => !ctx.myEmails.includes(a)).slice(0, 10)) {
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

function profileSections(profile: any) {
  const out = [];
  if (profile?.asks?.length) {
    out.push({ title: 'Usually asked in this meeting (from past transcripts)', items: profile.asks.slice(0, 4).map((a: any, i: any) => item(`ask:${i}`, `${a.text} — "${a.quote}"`)) });
  }
  if (profile?.lastSaid?.items?.length) {
    const when = String(profile.lastSaid.start || '').slice(0, 10);
    out.push({
      title: `Said last time (${when}, from the transcript)`,
      items: profile.lastSaid.items.map((s: any, i: any) => item(`said:${i}`, `${s.promise ? 'Promised' : 'Reported'}: ${s.text} — "${s.quote}"`)),
    });
  }
  return out;
}

/**
 * Everything the brief may say, as labelled sections. Exported for
 * `pa meeting brief --evidence`.
 */
async function gatherEvidence(m: any, kind: string, ctx: any, { now = new Date() }: { now?: any } = {}) {
  const series = await seriesRow(m);
  const profile = series?.profile || {};
  const meeting = {
    title: m.subject,
    kind,
    start: m.start,
    minutes: m.minutes,
    description: m.description,
    attendees: m.attendees.filter((a: any) => !ctx.myEmails.includes(a)),
  };
  let sections = [];
  let window = null;

  if (kind === 'standup') {
    // Briefed an hour ahead, the meeting is the anchor. Asked days ahead (a
    // test, or "brief me now" on Friday for Monday), now is: the work to
    // report is the work done so far.
    const anchor = +new Date(m.start) - now <= 12 * 3600_000 ? new Date(m.start) : now;
    const previous = (await seriesOccurrences(m.seriesKey))
      .filter((o: any) => !o.cancelled && new Date(o.start) < anchor && new Date(o.start) < now)
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

async function briefRow(key: any) {
  return repo.meetings.briefByKey(key);
}

async function writeBrief(m: any, kind: string, ctx: any, { now }: { now?: any }) {
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
  for (const p of [...rendered.points, ...rendered.context]) for (const r of p.refs) (cited as any)[r] = refs[r];
  return { rendered, refs: cited };
}

/**
 * @param {string|number} target  event external id, graph_event item id, or 'next'
 * @param {object} [opts]
 * @param {boolean} [opts.deliver=false] notify (toast + feed)
 * @param {boolean} [opts.force=false]   rewrite even if a fresh brief exists
 */
async function brief(target: any, { deliver = false, force = false, now = new Date() }: { deliver?: boolean; force?: boolean; now?: any } = {}) {
  const ctx = await context();
  const m = typeof target === 'object' && target?.eventId ? target : await resolveTarget(target, { now, ctx });
  const { kind, source } = await classify(m, ctx);
  const key = core.dedupeKey(m);
  let row = await briefRow(key);
  const fresh = row && !row.error && row.body && now - +new Date(row.updated_at) < 45 * 60_000;

  if (!fresh || force) {
    try {
      const { rendered, refs } = await writeBrief(m, kind, ctx, { now });
      row = await repo.meetings.upsertBrief({
        key,
        eventId: m.eventId,
        itemId: m.itemId,
        startsAt: m.start,
        seriesKey: m.seriesKey,
        kind,
        title: m.subject,
        headline: rendered.headline,
        body: rendered.body,
        points: { points: rendered.points, context: rendered.context },
        refs,
        joinUrl: m.joinUrl,
      });
      log.info('briefed', { brief: row.id, kind, words: rendered.words, refs: Object.keys(refs).length });
    } catch (err: any) {
      await repo.meetings.recordBriefError({
        key,
        eventId: m.eventId,
        itemId: m.itemId,
        startsAt: m.start,
        seriesKey: m.seriesKey,
        kind,
        title: m.subject,
        error: String(err.message).slice(0, 500),
      });
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
      // A meeting about to start cannot wait for a digest; one an hour out can.
      priority: new Date(m.start).getTime() - now.getTime() <= 30 * 60_000 ? 'urgent' : 'normal',
      actions: [{ label: 'Open brief', url: dashboardUrl(`brief-${row.id}`) }, ...(m.joinUrl ? [{ label: 'Join', url: m.joinUrl }] : [])],
    });
    if (n) row = await repo.meetings.markBriefNotified(row.id, n.id);
  }
  return { meeting: m, kind, kindSource: source, brief: row };
}

// ------------------------------------------------------------ learning ----

async function transcriptsFor(m: any) {
  return repo.audio.transcriptsFor(m.eventId, m.start, m.end);
}

function sourceOf(quote: string, items: any[], verify: any) {
  const hit = items.find((it) => {
    const v = verify(quote, it.body_text);
    return v === 'exact' || v === 'fragments';
  });
  return hit || items[0];
}

async function learnOccurrence(m: any, kind: string, items: any[]) {
  const { verifyQuote, headTail } = require('../memory/claims.ts');
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
  const asks = [...learned.asks.map((a: any) => ({ ...a, start: m.start })), ...(profile.asks || [])];
  const seen = new Set();
  profile.asks = asks.filter((a) => !seen.has(a.text.toLowerCase()) && seen.add(a.text.toLowerCase())).slice(0, 8);
  if (!profile.lastSaid || new Date(profile.lastSaid.start) <= new Date(m.start)) {
    profile.lastSaid = { eventId: m.eventId, start: m.start, items: learned.said };
  }
  profile.learnedFrom = [key, ...(profile.learnedFrom || []).filter((k: any) => k !== key)].slice(0, 30);
  profile.learnedAt = new Date().toISOString();
  await saveSeries(m, { profile });

  // Memory carries its evidence: every claim here holds a quote that was just
  // verified against the transcript it came from.
  const label = m.seriesKey;
  const day = m.start.slice(0, 10);
  const claims = [
    ...(learned.format && learned.formatQuote ? [{ kind: 'workflow', text: `The "${m.subject}" meeting: ${learned.format}`, quote: learned.formatQuote }] : []),
    ...learned.asks.map((a: any) => ({ kind: 'workflow', text: `In "${m.subject}", I get asked: ${a.text}`, quote: a.quote })),
    ...learned.said.map((s: any) => ({ kind: 'status', text: `In "${m.subject}" on ${day} I ${s.promise ? 'promised' : 'reported'}: ${s.text}`, quote: s.quote })),
  ];
  const ids = [];
  for (const c of claims) {
    const src = sourceOf(c.quote, items, verifyQuote);
    const row = await repo.memory.insertTopicClaim({
      label,
      kind: c.kind,
      text: c.text,
      quote: c.quote,
      sourceItemId: src?.id ?? null,
      validAt: m.start,
      extractedBy: LEARN_VERSION,
    });
    ids.push(row.id);
  }
  if (ids.length && config.memory.enabled) {
    await require('../memory/consolidate.ts').consolidateClaims(ids).catch((err: Error) => log.warn('consolidate failed', { message: err.message }));
  }
  log.info('learned', { asks: learned.asks.length, said: learned.said.length, claims: ids.length });
  return { learned, claims: ids.length };
}

// Occurrences that ended in the last three days and have a transcript we have
// not learned from. A transcript can lag the meeting by an hour (the audio
// pass is half-hourly), so an occurrence without one is retried, not marked.
async function learnRecent({ now = new Date(), limit = 3 }: { now?: any; limit?: number } = {}) {
  const ctx = await context();
  const past = (await eventsBetween(new Date(now.getTime() - 3 * DAY), now)).filter(
    (m: any) => new Date(m.end) < now && core.eligibility(m, eligibilityOpts(ctx)).ok
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
    } catch (err: any) {
      log.warn('learning failed', { message: err.message });
    }
  }
  return done;
}

// ----------------------------------------------------------- upcoming -----

async function upcoming({ hours = 24, now = new Date(), limit = 10 }: { hours?: number; now?: any; limit?: number } = {}) {
  const ctx = await context();
  const list = (await eventsBetween(new Date(now.getTime() - 15 * 60_000), new Date(now.getTime() + hours * 3600_000)))
    .filter((m: any) => new Date(m.end) > now)
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

function briefView(b: any) {
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

async function getBrief(id: any) {
  const b = await repo.meetings.briefById(id);
  return b ? briefView(b) : null;
}

/**
 * Everything the Meetings tab shows: upcoming meetings (with what to say) and
 * recorded / past meetings and ad-hoc calls (with summary, decisions, action
 * items and transcript). By default `days = 1` covers today (since local
 * midnight).
 */
async function overview({ days = 1, hours = 24, now = new Date() }: { days?: number; hours?: number; now?: any } = {}) {
  const debriefMod = require('./debrief.ts');
  const ctx = await context();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const since = days <= 1 ? startOfToday : new Date(now.getTime() - Math.min(days, 90) * DAY);

  const upcomingList = await upcoming({ hours, now, limit: 15 });

  const epRows = await repo.audio.overviewSince(since);

  const epIds = epRows.map((r: any) => r.id);
  const debriefRows = epIds.length ? await repo.meetings.bestForEpisodes(epIds) : [];
  const debriefByEp = new Map(debriefRows.map((d: any) => [String(d.episode_id), debriefMod.view(d)]));

  const recordedEventIds = new Set();
  const past = [];

  for (const r of epRows) {
    if (r.calendar_event_id) recordedEventIds.add(r.calendar_event_id);
    const ev = r.event_raw
      ? core.toMeeting({
          id: r.event_item_id,
          external_id: r.event_external_id,
          subject: r.event_subject,
          raw: r.event_raw,
          occurred_at: r.event_occurred_at,
          author_identity: r.event_organizer,
          body_text: r.event_body,
        })
      : null;
    const deb: any = debriefByEp.get(String(r.id)) || null;
    const meetingKind = ev ? (await classify(ev, ctx, { allowModel: false })).kind : null;
    const b = ev ? await briefRow(core.dedupeKey(ev)) : null;
    const isAdHoc = r.kind === 'call' || (deb?.title && ev?.subject && deb.title !== ev.subject);
    past.push({
      episodeId: Number(r.id),
      eventId: r.calendar_event_id || null,
      recorded: true,
      kind: isAdHoc ? 'call' : r.kind,
      meetingKind: isAdHoc ? 'call' : meetingKind || r.kind,
      title: deb?.title || ev?.subject || r.item_subject || 'Recorded call',
      startedAt: r.started_at,
      endedAt: r.ended_at,
      speechSeconds: Math.round(Number(r.speech_seconds) || 0),
      streams: String(r.stream || '').split('+').filter(Boolean),
      attendees: ev ? ev.attendees.filter((a: any) => !ctx.myEmails.includes(a)) : [],
      debrief: deb,
      brief: b && !isAdHoc ? briefView(b) : null,
      transcript: r.transcript || '',
    });
  }

  // Past calendar meetings in the window that have no recorded episode.
  const calPast = (await eventsBetween(since, now)).filter(
    (m: any) => new Date(m.end) <= now && !recordedEventIds.has(m.eventId) && core.eligibility(m, eligibilityOpts(ctx)).ok
  );
  for (const m of calPast) {
    const { kind } = await classify(m, ctx, { allowModel: false });
    const b = await briefRow(core.dedupeKey(m));
    past.push({
      episodeId: null,
      eventId: m.eventId,
      recorded: false,
      kind: 'meeting',
      meetingKind: kind,
      title: m.subject,
      startedAt: m.start,
      endedAt: m.end,
      speechSeconds: 0,
      streams: [],
      attendees: m.attendees.filter((a: any) => !ctx.myEmails.includes(a)),
      debrief: null,
      brief: b ? briefView(b) : null,
      transcript: null,
    });
  }

  past.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  const pauseState = require('../audio/gate.ts').readPause().state;
  return {
    days,
    since: since.toISOString(),
    upcoming: upcomingList,
    past,
    capture: {
      enabled: config.audio.enabled,
      gate: config.audio.gate.enabled,
      state: pauseState,
    },
  };
}

// ---------------------------------------------------------------- pass ----

async function pass({ now = new Date() }: { now?: any } = {}) {
  if (!config.meetings.enabled) return { briefed: 0 };
  await learnRecent({ now }).catch((err: Error) => log.warn('learn pass failed', { message: err.message }));

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
    } catch (err: any) {
      log.warn('brief failed', { message: err.message });
    }
  }
  return { briefed };
}

module.exports = {
  pass,
  brief,
  upcoming,
  overview,
  getBrief,
  learnRecent,
  gatherEvidence,
  classify,
  setKind,
  context,
  resolveTarget,
  transcriptsFor,
};
