'use strict';

// The PA chat's ("Jarvis") structured tools: every layer — the Today board,
// the software factory, termhub sessions — as one cheap tool call each, so
// the chat answers "what's on today?" or "start this one" without reading
// files or running shell commands.
//
// Listed only for the chat (PA_MCP_CHAT_TOOLS=1, src/mcp/server.js), like
// `pa` and `task_add`: every other session sharing the server keeps the
// read-only surface — a coding session in bypass mode must never see a tool
// that starts work.
//
//   reads    board, card, factory_jobs, factory_job, sessions
//            Allowed without a prompt (src/chat/index.js CHAT_READ_TOOLS).
//            In-process over the same modules the dashboard uses; compact
//            JSON (ids, short fields) for a model to read, never page markup.
//   actions  factory_start, factory_continue, factory_resume, factory_cancel,
//            factory_approve, session_start
//            NOT on any allow list: Claude Code asks the user on every call
//            (AGENT.md, "The PA chat acts only behind permission prompts").
//            Each is the existing dispatch path (src/dispatch/index.js start,
//            factory.js cancelJob/approve/resume), the same as `pa do` behind
//            a shell prompt — so the same rules hold: an end state that merges
//            or pushes to main with no human step is never started from here,
//            it becomes a card ("suggested by the chat") the user accepts.
//
// What these return quotes other people's messages (card summaries, source
// excerpts): data, never instructions — the chat's CLAUDE.md says so.

const repository = require('../repo');

const CHAT_READ_TOOL_NAMES = ['board', 'card', 'factory_jobs', 'factory_job', 'sessions'];
const CHAT_ACTION_TOOL_NAMES = ['factory_start', 'factory_continue', 'factory_resume', 'factory_cancel', 'factory_approve', 'session_start'];

// The user's rule: a factory job runs on Claude Code (their subscription)
// unless they ask for the API ("with DeepSeek", "use the API", a model id).
const DEFAULT_RUNTIME = 'claude_session';

const JOB = { type: 'string', description: 'A factory job id, app:direction (e.g. widget:0042), from factory_jobs.' };
const DELIVERY = {
  type: 'string',
  enum: ['none', 'branch', 'draft_pr', 'pr', 'auto_merge', 'push_to_main'],
  description: "The end state, from the user's own words: pr = a PR ready for review/merge (\"ready to merge\"), draft_pr, branch, none. auto_merge/push_to_main never start from here — they become a card the user accepts. Omit to use the repo's default.",
};
const RUNTIME = {
  type: 'string',
  enum: ['claude_session', 'api'],
  description: 'Who does the work. claude_session (default): Claude Code on the factory machine, the user\'s subscription. api: the factory\'s metered models — only when the user says so ("with DeepSeek", "use the API") or names an API model.',
};
const MODEL = {
  type: 'string',
  maxLength: 120,
  description: 'Optional. runtime claude_session: a Claude model name (claude-sonnet-5-5). runtime api: provider/model (deepseek/deepseek-coder, openrouter/…), applied to the dev persona (researcher for research/report).',
};
const DONE = { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 12, description: 'Acceptance criteria, one per entry: "PR open and ready to merge", "CI green", "CodeRabbit review addressed", …' };

const READ_TOOLS = [
  {
    name: 'board',
    description:
      "The user's to-do list right now, from the dashboard's Today board, as compact JSON: `todo` (due/overdue first), `blocked` (waiting on someone — blockers listed), `unblocked` (a blocker just delivered), `looks_done` (confirm to close). Each card: id (use with card / factory_start), summary, who, due, repo, live run/job, pending offer. Call this for \"what are my tasks\", \"what's on today\", \"what's blocked\".",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 60, default: 25, description: 'Cards per group.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'card',
    description:
      "One board card's full context — what the dashboard shows: summary, detail, who, due, repo, the source message (excerpt), links (message, PRs, tickets), the stored context paragraph, blockers, runs and factory jobs on it (each run with its job, steps and their live sessions, and every PR number with its CI), and pending offers. `id` is a card id from board (a number, or p<id> for a standalone offer). Call before starting work on a card.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 20, description: 'Card id from board, e.g. "412" or "p37".' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'factory_jobs',
    description:
      'Software-factory jobs from the worker\'s last stored list (no factory call): grouped needs_you / running / delivered / ended, each with id, state, kind, runtime, title, why, cost, PRs, CI, and the PA run that started it. Plus today\'s spend.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', enum: ['needs_you', 'running', 'delivered', 'ended', 'active', 'all'], default: 'active', description: 'active = needs_you + running.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'factory_job',
    description:
      'One factory job in detail: state and why, stories with PR number/CI, runs (each a step: id, story, persona, model, cost, live termhub link and session id), the card it came from, metered cost and subscription-equivalent, the report excerpt (research/report), whether it waits on an approval, and the termhub link to follow it. `fresh: true` asks the factory now instead of the stored list.',
    inputSchema: {
      type: 'object',
      properties: { job: JOB, fresh: { type: 'boolean', default: false } },
      required: ['job'],
      additionalProperties: false,
    },
  },
  {
    name: 'sessions',
    description:
      'Live termhub sessions (this machine, or `machine`): id, title, folder, whether it is working / waiting / on a prompt, what it belongs to (card, run, job, step: from stored ids), and its link.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', maxLength: 80, description: 'A PA_MACHINES name; omit for this machine.' },
        all: { type: 'boolean', default: false, description: 'Include ended sessions.' },
      },
      additionalProperties: false,
    },
  },
];

const ACTION_TOOLS = [
  {
    name: 'factory_start',
    description:
      "Start software-factory work — the user approves each call. From a board card (`card`: its full context becomes the brief, composed server-side) and/or the user's words (`ask`). kind code (default) changes a repo; research/report write a report. Default runtime claude_session; api only when the user asks. `delivery` from their words (\"ready to merge\" → pr). Put requirements like CI green / review passed in `done`. auto_merge and push_to_main become a card instead. Returns the run and job ids and the follow link.",
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string', maxLength: 20, description: 'A board card id (commitment).' },
        ask: { type: 'string', maxLength: 4000, description: "The user's own words about what to do, beyond the card." },
        title: { type: 'string', maxLength: 200 },
        kind: { type: 'string', enum: ['code', 'research', 'report'], default: 'code' },
        repo: { type: 'string', maxLength: 300, description: 'owner/name or a known checkout; defaults to the card\'s repo.' },
        runtime: RUNTIME,
        model: MODEL,
        delivery: DELIVERY,
        done: DONE,
        pipeline: { type: 'string', enum: ['solo', 'chain', 'auto'] },
        register: { type: 'boolean', default: false, description: 'Register a repo the factory does not know yet.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'factory_continue',
    description:
      'Continue existing work in the factory: a new job on an existing `branch` or `pr` of a repo (fix review comments, make CI green, finish it) — the user approves each call. Same options as factory_start. Fails clearly if the factory does not support continuing yet.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', maxLength: 300, description: 'owner/name or a known checkout.' },
        branch: { type: 'string', maxLength: 200 },
        pr: { type: 'integer', minimum: 1 },
        card: { type: 'string', maxLength: 20 },
        ask: { type: 'string', maxLength: 4000, description: 'What to do on it, in the user\'s words.' },
        title: { type: 'string', maxLength: 200 },
        runtime: RUNTIME,
        model: MODEL,
        delivery: DELIVERY,
        done: DONE,
        pipeline: { type: 'string', enum: ['solo', 'chain', 'auto'] },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'factory_resume',
    description: 'Resume a factory job that stopped — failed, cancelled, needs you, or stalled (factory_jobs marks stalled) — keeping finished stories and continuing the rest on their branch/PR (`factory job resume`). The user approves each call.',
    inputSchema: { type: 'object', properties: { job: JOB }, required: ['job'], additionalProperties: false },
  },
  {
    name: 'factory_cancel',
    description: 'Cancel a factory job (a PA run holding it is dropped too). The user approves each call.',
    inputSchema: { type: 'object', properties: { job: JOB }, required: ['job'], additionalProperties: false },
  },
  {
    name: 'factory_approve',
    description: 'Approve the direction a needs_human job waits on — only the approval the factory itself named (factory_job says can_approve). The user approves each call.',
    inputSchema: { type: 'object', properties: { job: JOB }, required: ['job'], additionalProperties: false },
  },
  {
    name: 'session_start',
    description:
      'Start a Claude Code session in termhub on a repo, in its own worktree and branch, briefed with `prompt` — the user approves each call. For hands-on or exploratory work the user wants to watch or join; `mode: plan` for read-only investigation. Returns the run id and the session link.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', maxLength: 300, description: 'owner/name or a known checkout; defaults to the card\'s repo.' },
        prompt: { type: 'string', maxLength: 4000, description: "What the session should do, in the user's words." },
        card: { type: 'string', maxLength: 20 },
        mode: { type: 'string', enum: ['plan', 'local', 'branch', 'mr'], description: 'plan = read-only. Omit to follow delivery.' },
        delivery: DELIVERY,
        model: { type: 'string', maxLength: 120, description: 'Optional Claude model for the session.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

const ALL = [...READ_TOOLS, ...ACTION_TOOLS];

// ------------------------------------------------------------- helpers ----

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isoDay(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Pure. A due date as the chat says it: overdue, today, tomorrow, or the date. */
function dueLabel(dueAt, now = Date.now()) {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  const today = isoDay(now);
  const day = isoDay(d);
  if (day < today) return `overdue (${day})`;
  if (day === today) return 'today';
  if (day === isoDay(new Date(now).getTime() + 86400_000)) return 'tomorrow';
  return day;
}

/** Pure. A card id from the chat: a commitment id (number) or p<id> (a standalone offer). */
function parseCardId(id) {
  const s = String(id ?? '').trim();
  let m = /^#?(\d{1,12})$/.exec(s);
  if (m) return { commitment: Number(m[1]) };
  m = /^p(\d{1,12})$/i.exec(s);
  if (m) return { proposal: Number(m[1]) };
  throw new Error(`"${s}" is not a card id — a number from board (or p<id> for an offer)`);
}

function repoOf(c, extra) {
  return extra?.slug || (c.repo_path ? String(c.repo_path).split(/[\\/]/).filter(Boolean).pop() : null) || null;
}

/** Pure. One board card as the chat reads it. `extra`: {slug, run} by card id. */
function compactCard(c, extra = {}, now = Date.now()) {
  const out = { id: String(c.id) };
  out.summary = clip(c.summary, 160);
  if (c.who) out.who = clip(c.who, 60);
  const due = dueLabel(c.due_at, now);
  if (due) out.due = due;
  const repo = repoOf(c, extra);
  if (repo) out.repo = repo;
  if (c.project && c.project !== repo) out.project = clip(c.project, 60);
  if (c.direction === 'owed_to_me') out.owed_by = out.who || 'someone';
  if (c.status === 'dispatched') out.dispatched = true;
  if (extra.run) out.run = extra.run;
  if (c.blockers?.length) out.blockers = c.blockers.map((b) => ({ id: String(b.id), who: b.who ? clip(b.who, 50) : null, summary: clip(b.summary, 100) }));
  if (c.unblocked?.length) out.unblocked = c.unblocked.map((b) => ({ id: String(b.blocker_id), who: b.who ? clip(b.who, 50) : null, summary: clip(b.summary, 100) }));
  if (c.waitingOn) out.waiting_on = true;
  const offers = (c.asks || []).filter((p) => p && p.kind === 'dispatch');
  if (offers.length) out.offer = { proposal: Number(offers[0].id), title: clip(offers[0].title, 100), delivery: offers[0].payload?.delivery || null };
  const other = (c.asks || []).filter((p) => p && p.kind !== 'dispatch');
  if (other.length) out.asks = other.map((p) => ({ proposal: Number(p.id), kind: p.kind, title: clip(p.title, 100) }));
  if (c.settled) out.looks_done = { proposal: Number(c.settled.id), confidence: c.settled.confidence ?? null };
  if (c.standalone) out.standalone = true;
  return out;
}

/** Pure. The board (dashboard/board.js build()) as the chat's grouped list. */
function boardView(board, { extras = new Map(), limit = 25, now = Date.now() } = {}) {
  const onMe = board?.onMe || [];
  const card = (c) => compactCard(c, extras.get(String(c.id)) || {}, now);
  const unblocked = onMe.filter((c) => c.group === 'todo' && c.unblocked?.length);
  const todo = onMe.filter((c) => c.group === 'todo' && !c.unblocked?.length);
  const groups = {
    todo: todo.map(card),
    blocked: onMe.filter((c) => c.group === 'blocked').map(card),
    unblocked: unblocked.map(card),
    looks_done: onMe.filter((c) => c.group === 'settled').map(card),
  };
  const out = { as_of: new Date(now).toISOString(), counts: {} };
  for (const [g, list] of Object.entries(groups)) {
    out.counts[g] = list.length;
    out[g] = list.slice(0, limit);
    if (list.length > limit) out[`${g}_more`] = list.length - limit;
  }
  out.counts.waiting_on_others = board?.counts?.waiting ?? 0;
  return out;
}

/** Pure. One factory job (factoryCore.jobView) for the list. */
function jobRow(v, raw = null) {
  const out = { job: v.jobId, state: v.state, group: v.group, kind: v.kind, runtime: v.runtime, title: clip(v.title, 120) };
  // v1.3: no progress for hours (factory_resume can pick it up), and the branch/PR it continues.
  if (raw?.stalled === true) out.stalled = true;
  if (raw?.base && typeof raw.base === 'object' && raw.base.branch) out.continues = { branch: String(raw.base.branch), pr: raw.base.pr ?? null };
  if (v.app) out.app = v.app;
  if (v.why) out.why = clip(v.why, 200);
  const prs = v.stories.map((s) => s.prUrl).filter(Boolean);
  if (prs.length) out.prs = prs.slice(0, 5);
  if (v.ciFailing) out.ci_failing = true;
  if (v.costUsd) out.cost_usd = Math.round(v.costUsd * 100) / 100;
  if (v.subscriptionEquivUsd) out.subscription_equiv_usd = Math.round(v.subscriptionEquivUsd * 100) / 100;
  if (v.paRun) out.pa_run = v.paRun.id;
  if (v.canApprove) out.can_approve = true;
  if (v.updatedAt) out.updated = v.updatedAt;
  return out;
}

/** Pure. One factory job in detail. */
function jobDetail(v, { followUrl = null, raw = null } = {}) {
  const out = jobRow(v, raw);
  out.delivery = v.delivery;
  out.pipeline = v.pipeline;
  out.terminal = v.terminal;
  out.cost_usd = Math.round(v.costUsd * 100) / 100;
  out.subscription_equiv_usd = Math.round(v.subscriptionEquivUsd * 100) / 100;
  out.stories = v.stories.map((s) => {
    const o = { id: s.id, state: s.state };
    if (s.prUrl) o.pr = s.prUrl;
    if (s.prNumber) o.pr_number = s.prNumber;
    if (s.prState) o.pr_state = s.prState;
    if (s.ci) o.ci = s.ci.failing.length ? `${s.ci.state}: ${s.ci.failing.join(', ')}` : s.ci.state;
    return o;
  });
  // Each step (the factory's run id) with its story and live session (plan E1).
  out.runs = v.runs.slice(0, 10).map((r) => {
    const o = { id: r.id, persona: r.persona, state: r.state, runtime: r.runtime, model: r.model, cost_usd: r.costUsd, billing: r.billing };
    if (r.storyId != null) o.story = r.storyId;
    if (r.session?.url) o.session = r.session.url;
    if (r.session?.id) o.session_id = r.session.id;
    return o;
  });
  if (v.paRun?.card) out.card = v.paRun.card;
  if (v.report) out.report = { title: v.report.title, words: v.report.words, excerpt: clip(v.report.excerpt, 600) };
  if (v.merged) out.merged = true;
  out.can_cancel = v.canCancel;
  if (followUrl) out.follow = followUrl;
  return out;
}

/**
 * Pure. A run's steps and PRs (factoryCore.runChain) as the chat reads them:
 * `steps` [{step, story?, persona?, state?, session?, session_id?}] and `prs`
 * [{number?, url, state?, ci?}]; empty lists left out.
 */
function chainFields(chain) {
  const out = {};
  const steps = (chain?.steps || []).slice(0, 10).map((s) => {
    const o = { step: s.step };
    if (s.story != null) o.story = s.story;
    if (s.persona) o.persona = s.persona;
    if (s.runtime) o.runtime = s.runtime;
    if (s.state) o.state = s.state;
    if (s.session?.url) o.session = s.session.url;
    if (s.session?.id) o.session_id = s.session.id;
    return o;
  });
  if (steps.length) out.steps = steps;
  const prs = (chain?.prs || []).slice(0, 10).map((p) => {
    const o = { url: p.url };
    if (p.number) o.number = p.number;
    if (p.state) o.state = p.state;
    if (p.ci) o.ci = p.ciFailing?.length ? `${p.ci}: ${p.ciFailing.join(', ')}` : p.ci;
    return o;
  });
  if (prs.length) out.prs = prs;
  return out;
}

/** Pure. A termhub session as the chat reads it. */
function sessionRow(s, { runs = new Map(), base = null } = {}) {
  const out = { id: String(s.id), title: clip(s.title || '', 80) };
  if (s.cwd) out.cwd = String(s.cwd);
  if (s.kind) out.kind = s.kind;
  const state = s.alive === false ? 'ended' : s.idleState === 'working' ? 'working'
    : s.idleState === 'waiting' && (s.idleReason === 'blocked' || s.idleReason === 'question') ? 'needs_answer'
      : s.idleState || (s.busy ? 'working' : 'idle');
  out.state = state;
  const run = runs.get(String(s.id));
  if (run) out.run = run;
  // What termhub says the session belongs to (plan E1: stored ids, not the title).
  const links = require('../dispatch/termhub').sessionLinks(s.links);
  if (links) out.links = links;
  if (base) out.url = `${base}/#session=${encodeURIComponent(s.id)}`;
  return out;
}

/**
 * Pure. Model overrides for a factory job from the tool's `model`: on
 * claude_session a Claude model name (`claude_session=<name>`), on api a
 * provider/model id for the persona that does the work (`dev`, or
 * `researcher` for research/report). Validated by factoryCore.parseModels.
 */
function modelOverrides({ runtime, kind = 'code', model = null }) {
  if (!model) return null;
  const m = String(model).trim();
  const F = require('../dispatch/factoryCore');
  if (runtime === 'claude_session') {
    if (m.includes('/') && !/^(anthropic|cli)\//.test(m)) {
      throw new Error(`"${m}" is an API model — pass runtime "api" with it, or a Claude model name for claude_session`);
    }
    const name = m.replace(/^(anthropic|cli)\//, '');
    F.parseModels(`claude_session=${name}`);
    return [`claude_session=${name}`];
  }
  if (!m.includes('/')) throw new Error(`on the api runtime a model is provider/model (e.g. deepseek/deepseek-coder), not "${m}"`);
  const persona = kind === 'code' ? 'dev' : 'researcher';
  F.parseModels(`${persona}=${m}`);
  return [`${persona}=${m}`];
}

/** Pure. A branch name the factory may be told to continue: a plain git ref. */
function branchName(b) {
  const s = String(b || '').trim();
  if (!require('../dispatch/factoryCore').BRANCH.test(s)) throw new Error(`"${s}" is not a branch name`);
  return s;
}

/**
 * Pure. A factory_start / factory_continue call → dispatch.start's options.
 * Throws on what cannot be a job.
 */
function factoryPlan(args = {}, { card = null } = {}) {
  const F = require('../dispatch/factoryCore');
  const kind = F.jobKind(args.kind || 'code');
  const runtime = F.runtime(args.runtime || DEFAULT_RUNTIME);
  const commitmentId = card ? card.commitment : null;
  const ask = args.ask ? String(args.ask).trim() : null;
  if (!commitmentId && !ask) throw new Error('give a card id or the ask in the user\'s words');
  const done = (Array.isArray(args.done) ? args.done : []).map((d) => String(d).trim()).filter(Boolean).slice(0, 12);
  if (args.branch != null && args.pr != null) throw new Error('give a branch or a PR, not both');
  const o = {
    commitmentId,
    task: ask,
    title: args.title ? String(args.title).trim() : null,
    via: 'factory',
    jobKind: kind,
    runtime,
    repoPath: args.repo ? String(args.repo).trim() : null,
    delivery: args.delivery || null,
    pipeline: args.pipeline || null,
    models: modelOverrides({ runtime, kind, model: args.model }),
    done: done.length ? done : null,
    register: args.register === true,
  };
  if (args.branch != null) o.branch = branchName(args.branch);
  if (args.pr != null) {
    const n = Number(args.pr);
    if (!Number.isInteger(n) || n < 1) throw new Error(`"${args.pr}" is not a PR number`);
    o.pr = n;
  }
  if ((o.branch || o.pr) && kind !== 'code') throw new Error('continuing a branch or PR is a code job');
  if ((o.branch || o.pr) && !o.repoPath) throw new Error('name the repo the branch or PR is on');
  return o;
}

// --------------------------------------------------------------- reads ----

function hubBase(machine = null) {
  try {
    return require('../dispatch/termhub').forMachine(machine).base;
  } catch {
    return null;
  }
}

async function boardTool({ limit = 25 } = {}) {
  // The parts of the dashboard's state() (src/dashboard/server.js) the board
  // is built from — not drafts, sources, notifications or spend.
  const { gather } = require('../brief');
  const data = await gather({ horizonDays: 7 });
  const s = { ...data };
  s.looksDone = await require('../ledger/reconcile').proposals().catch(() => []);
  s.needsYou = await require('../proposals').pending().catch(() => []);
  await require('../dashboard/cards.ts').enrich(s).catch(() => {});
  s.blocks = await require('../commitments/blocks').forBoard().catch(() => []);
  const board = require('../dashboard/board.ts').build(s);
  const ids = board.onMe.filter((c) => !c.standalone).map((c) => Number(c.id)).filter(Number.isFinite);
  const extras = new Map();
  if (ids.length) {
    const found = await repository.commitments.boardExtras(ids).catch(() => []);
    for (const f of found) extras.set(String(f.id), { slug: f.slug || null, run: f.run || null });
  }
  return boardView(board, { extras, limit });
}

async function cardTool({ id }) {
  const ref = parseCardId(id);
  const { sourceLabel } = require('../dispatch/brief');
  if (ref.proposal) {
    const p = await repository.proposals.rowForChat(ref.proposal);
    if (!p) throw new Error(`no offer p${ref.proposal}`);
    return {
      id: `p${p.id}`, offer: { proposal: Number(p.id), kind: p.kind, status: p.status, title: clip(p.title, 200), body: clip(p.body, 1500), delivery: p.payload?.delivery || null, repo: p.payload?.slug || p.payload?.repoPath || null },
      card: p.commitment_id ? String(p.commitment_id) : null,
    };
  }
  const c = await repository.commitments.cardForChat(ref.commitment);
  if (!c) throw new Error(`no card ${ref.commitment}`);
  const [info, runs, offers, blocks] = await Promise.all([
    require('../dashboard/cards.ts').forCommitments([c.id]).then((r) => r.byId.get(String(c.id)) || null).catch(() => null),
    repository.runs.cardRuns(c.id).catch(() => []),
    repository.proposals.pendingOfCommitment(c.id).catch(() => []),
    repository.commitments.blocksOf(c.id).catch(() => []),
  ]);
  const out = {
    id: String(c.id),
    summary: clip(c.summary, 300),
    direction: c.direction,
    status: c.status,
  };
  if (c.detail) out.detail = clip(c.detail, 800);
  if (c.who) out.who = c.who;
  const due = dueLabel(c.due_at);
  if (due) out.due = due;
  if (c.slug || c.repo_path) out.repo = c.slug || c.repo_path;
  if (c.project) out.project = c.project;
  out.source = { item: Number(c.item_id), kind: sourceLabel(c.source), subject: c.subject ? clip(c.subject, 200) : null, at: c.occurred_at, excerpt: clip(c.body, 1500) };
  if (info?.context) out.context = clip(info.context, 800);
  const links = (info?.links || []).slice(0, 12).map((l) => ({ kind: l.kind, label: clip(l.label || '', 80), url: l.url }));
  if (links.length) out.links = links;
  const sessions = (info?.sessions || []).slice(0, 4).map((x) => ({ role: x.role || null, label: clip(x.label || x.title || '', 80), url: x.url || null }));
  if (sessions.length) out.sessions = sessions;
  const blockers = blocks.filter((b) => b.task_id === String(c.id) && b.verdict === 'blocks');
  if (blockers.length) out.blockers = blockers.map((b) => ({ id: b.blocker_id, who: b.who || null, summary: clip(b.summary, 120), status: b.status }));
  const holds = blocks.filter((b) => b.blocker_id === String(c.id) && b.verdict === 'blocks' && b.task_id);
  if (holds.length) out.blocks_task = holds.map((b) => b.task_id);
  if (runs.length) {
    // Plan E1: each run's steps (with their sessions) and every PR with its CI.
    const stored = await require('../dispatch/factory').chains(runs.map((r) => r.id)).catch(() => new Map());
    out.runs = runs.map((r) => {
      const o = { run: Number(r.id), status: r.status, route: r.route || 'claude', mode: r.mode };
      if (r.factory_job_id) o.job = r.factory_job_id;
      if (r.factory_state) o.job_state = r.factory_state;
      if (r.delivery) o.delivery = r.delivery;
      if (r.mr_url) o.pr = r.mr_url;
      if (r.cost_usd != null) o.cost_usd = Number(r.cost_usd);
      if (r.termhub_session_id) {
        o.session_id = String(r.termhub_session_id);
        const base = hubBase(r.machine);
        if (base) o.session = `${base}/#session=${encodeURIComponent(r.termhub_session_id)}`;
      }
      Object.assign(o, chainFields(require('../dispatch/factoryCore').runChain(r, stored.get(String(r.id)))));
      return o;
    });
  }
  if (offers.length) out.offers = offers.map((p) => ({ proposal: Number(p.id), kind: p.kind, title: clip(p.title, 120), delivery: p.payload?.delivery || null }));
  return out;
}

async function factoryJobsTool({ group = 'active', limit = 15 } = {}) {
  const factory = require('../dispatch/factory');
  const F = require('../dispatch/factoryCore');
  if (!factory.enabled()) return { enabled: false, note: 'the factory is not configured (PA_FACTORY_PATH)' };
  const snap = await factory.snapshot();
  const runs = await repository.runs.factoryJobs().catch(() => []);
  const b = F.board(snap.jobs, { paRuns: new Map(runs.map((r) => [r.factory_job_id, { id: Number(r.id), url: null }])) });
  const want = group === 'all' ? F.GROUPS : group === 'active' ? ['needs_you', 'running'] : [group];
  const out = { as_of: snap.polledAt, counts: Object.fromEntries(F.GROUPS.map((g) => [g, b.groups[g].length])) };
  if (snap.error) out.last_error = clip(snap.error, 200);
  if (b.spend?.factoryToday) out.spend_today = { metered_usd: b.spend.factoryToday.metered, subscription_equiv_usd: b.spend.factoryToday.subscriptionEquiv };
  for (const g of want) {
    const byId = new Map(snap.jobs.map((j) => [j.job_id, j]));
    out[g] = b.groups[g].slice(0, limit).map((v) => jobRow(v, byId.get(v.jobId)));
    if (b.groups[g].length > limit) out[`${g}_more`] = b.groups[g].length - limit;
  }
  return out;
}

function checkJob(job) {
  const F = require('../dispatch/factoryCore');
  if (!F.JOB_ID.test(String(job || ''))) throw new Error(`"${job}" is not a factory job id (app:direction) — factory_jobs lists them`);
  return String(job);
}

async function factoryJobTool({ job, fresh = false }) {
  const id = checkJob(job);
  const factory = require('../dispatch/factory');
  const F = require('../dispatch/factoryCore');
  let raw = fresh ? null : await factory.snapshotJob(id);
  let source = 'stored list';
  if (!raw) {
    raw = await factory.call(['job', 'status', id, '--json']);
    source = 'factory';
  }
  const run = await repository.runs.newestOfJob(id).catch(() => null);
  const v = F.jobView(raw, run ? { id: Number(run.id), url: null, card: run.commitment_id } : null);
  let followUrl = null;
  if (run?.termhub_session_id) {
    const base = hubBase(run.machine);
    if (base) followUrl = `${base}/#session=${encodeURIComponent(run.termhub_session_id)}`;
  }
  return { ...jobDetail(v, { followUrl, raw }), from: source };
}

async function sessionsTool({ machine = null, all = false } = {}) {
  const termhub = require('../dispatch/termhub');
  const { config } = require('../config');
  if (machine && !config.termhub.machines[machine]) throw new Error(`"${machine}" is not in PA_MACHINES`);
  const hub = termhub.forMachine(machine);
  const list = await hub.listSessions();
  const runs = await repository.runs.withSessions().catch(() => []);
  const byId = new Map(runs.map((r) => [String(r.termhub_session_id), {
    run: Number(r.id), status: r.status, ...(r.factory_job_id ? { job: r.factory_job_id } : {}), ...(r.commitment_id ? { card: String(r.commitment_id) } : {}),
  }]));
  // A factory step's own session (plan E1, sql/033 run_step): its run, job and step.
  const ids = list.map((s) => String(s.id)).filter((x) => !byId.has(x));
  const steps = ids.length
    ? await repository.runs.stepsBySessions(ids).catch(() => [])
    : [];
  for (const s of steps) {
    byId.set(String(s.termhub_session_id), { run: Number(s.run_id), status: s.status, job: s.job_id, step: s.step_id, ...(s.commitment_id ? { card: String(s.commitment_id) } : {}) });
  }
  const shown = list.filter((s) => all || s.alive !== false).map((s) => sessionRow(s, { runs: byId, base: hub.base }));
  return { machine: machine || 'this machine', count: shown.length, sessions: shown.slice(0, 60) };
}

// ------------------------------------------------------------- actions ----

// An end state with no human step after the yes never starts from the chat
// (AGENT.md; D.requireConfirmed): it goes on a card the user accepts in the
// dashboard or a terminal, exactly as `pa do` does for a non-interactive caller.
async function startOrCard(o) {
  const dispatch = require('../dispatch');
  const D = require('../dispatch/deliveryCore');
  const kind = require('../dispatch/factoryCore').jobKind(o.jobKind);
  const pre = kind !== 'code' ? { delivery: 'none' } : await dispatch.previewDelivery(o);
  if (D.unattended(pre.delivery)) {
    if (o.branch || o.pr) {
      throw new Error(`${pre.delivery} on an existing branch or PR is not started from the chat — ask for pr (ready for review) and merge it yourself, or start it from the dashboard`);
    }
    const row = await require('../dispatch/offer').propose({
      ...o, useModel: await require('../budget').allow('propose').catch(() => false), suggestedBy: 'the chat',
    });
    return {
      started: false,
      card: row ? { proposal: Number(row.id), title: clip(row.title, 120) } : null,
      note: row
        ? `${pre.delivery} ${pre.delivery === 'push_to_main' ? 'pushes to main' : 'merges'} with no human step, so it is not started from the chat: it is on a card (dashboard → On me) for the user to accept`
        : 'not started: an identical card is already waiting on the dashboard',
    };
  }
  const r = await dispatch.start(o);
  return startedView(r);
}

/** Pure. dispatch.start's result as the chat reports it. */
function startedView(r) {
  if (r.route === 'factory') {
    if (r.submitUnknown) return { started: 'unconfirmed', run: r.id, note: r.note };
    const out = { started: true, run: r.id, job: r.jobId, kind: r.jobKind || 'code', runtime: r.runtime, delivery: r.delivery, pipeline: r.pipeline };
    if (r.app) out.app = r.app;
    if (r.created === false) out.already_submitted = true;
    if (r.delivery !== r.deliveryRequested) out.warning = `asked for ${r.deliveryRequested}; the factory reports ${r.delivery}`;
    if (r.warnings?.length) out.warnings = r.warnings.slice(0, 5);
    if (r.base) out.continues = { branch: r.base.branch || null, pr: r.base.pr ?? null, into: r.base.into || null };
    out.follow = r.url || null;
    return out;
  }
  return { started: true, run: r.id, route: 'claude', mode: r.mode, delivery: r.delivery || null, branch: r.branch || null, session: r.url || null, repo: r.repoPath || null };
}

async function factoryStartTool(args, { requireBranchOrPr = false } = {}) {
  const card = args.card != null ? parseCardId(args.card) : null;
  if (card?.proposal) throw new Error(`p${card.proposal} is an offer, not a card — accept it in the dashboard, or start from its card`);
  if (requireBranchOrPr && args.branch == null && args.pr == null) throw new Error('name the branch or the PR to continue');
  const o = factoryPlan(args, { card });
  o.routeReason = o.branch || o.pr ? `the chat continued ${o.branch ? `branch ${o.branch}` : `PR #${o.pr}`}` : 'the chat started it';
  return startOrCard(o);
}

async function sessionStartTool(args) {
  const card = args.card != null ? parseCardId(args.card) : null;
  if (card?.proposal) throw new Error(`p${card.proposal} is an offer, not a card`);
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('a session needs a prompt');
  const o = {
    commitmentId: card ? card.commitment : null,
    task: prompt,
    via: 'claude',
    repoPath: args.repo ? String(args.repo).trim() : null,
    mode: args.mode || undefined,
    delivery: args.mode === 'plan' ? null : args.delivery || null,
    model: args.model || null,
    routeReason: 'the chat started a session',
  };
  return startOrCard(o);
}

async function handle(name, args = {}) {
  const factory = () => require('../dispatch/factory');
  switch (name) {
    case 'board': return boardTool(args);
    case 'card': return cardTool(args);
    case 'factory_jobs': return factoryJobsTool(args);
    case 'factory_job': return factoryJobTool(args);
    case 'sessions': return sessionsTool(args);
    case 'factory_start': return factoryStartTool(args);
    case 'factory_continue': return factoryStartTool(args, { requireBranchOrPr: true });
    case 'factory_resume': {
      const r = await factory().resume(checkJob(args.job));
      const raw = r.raw || {};
      const n = (x) => (Array.isArray(x) ? x.length : 0);
      return { job: r.jobId, resumed: true, state: r.state || null, was: raw.was || null, stories_resumed: n(raw.resumed), stories_kept: n(raw.kept), stories_left: n(raw.stories_left), ...(r.why ? { why: r.why } : {}) };
    }
    case 'factory_cancel': {
      const r = await factory().cancelJob(checkJob(args.job));
      return { job: r.jobId, state: r.state || 'cancel sent', ...(r.run ? { run_dropped: r.run } : {}), ...(r.storiesParked != null ? { stories_parked: r.storiesParked } : {}) };
    }
    case 'factory_approve': {
      const r = await factory().approve(checkJob(args.job), { channel: 'chat' });
      return { job: r.jobId, approved: true, output: r.output || null };
    }
    case 'session_start': return sessionStartTool(args);
    default: return undefined;
  }
}

module.exports = {
  READ_TOOLS, ACTION_TOOLS, ALL, CHAT_READ_TOOL_NAMES, CHAT_ACTION_TOOL_NAMES, DEFAULT_RUNTIME,
  handle, dueLabel, parseCardId, compactCard, boardView, jobRow, jobDetail, sessionRow, chainFields, modelOverrides, branchName, factoryPlan, startedView,
};
