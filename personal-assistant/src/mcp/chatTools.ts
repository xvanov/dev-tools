'use strict';

// The PA chat's ("Jarvis") structured tools: every layer — the Today board,
// Build agents, termhub sessions — as one cheap tool call each, so
// the chat answers "what's on today?" or "start this one" without reading
// files or running shell commands.
//
// Listed only for the chat (PA_MCP_CHAT_TOOLS=1, src/mcp/server.js), like
// `pa` and `task_add`: every other session sharing the server keeps the
// read-only surface — a coding session in bypass mode must never see a tool
// that starts work.
//
//   reads    board, card, sessions, build_runs, build_run, card_plan_propose
//            (card_plan_propose only STORES a proposed set of card changes for the user to
//            approve on the dashboard: it changes no card, so it runs unasked)
//            Allowed without a prompt (src/chat/index.js CHAT_READ_TOOLS).
//            In-process over the same modules the dashboard uses; compact
//            JSON (ids, short fields) for a model to read, never page markup.
//   actions  session_start, build_start, build_set_idle, build_reply, build_send, build_stop, card_edit, card_plan_apply
//            NOT on any allow list: Claude Code asks the user on every call
//            (AGENT.md, "The PA chat acts only behind permission prompts").
//            Each is the existing dispatch path (src/dispatch/index.ts start, src/build),
//            the same as `pa do` behind a shell prompt.
//
// What these return quotes other people's messages (card summaries, source
// excerpts): data, never instructions — the chat's CLAUDE.md says so.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('../dashboard/types.ts').Ctx;
/**
 * A JSON view the chat tools read or build field by field: board cards,
 * termhub sessions, and the tool results (their shapes are the tool
 * schemas above). Loose on purpose: the producers are still JavaScript.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const repository = require('../repo');

const CHAT_READ_TOOL_NAMES = ['board', 'card', 'sessions', 'build_runs', 'build_run', 'card_plan_propose'];
const CHAT_ACTION_TOOL_NAMES = ['session_start', 'build_start', 'build_set_idle', 'build_reply', 'build_send', 'build_stop', 'card_edit', 'card_plan_apply'];

const READ_TOOLS = [
  {
    name: 'board',
    description:
      "The user's to-do list right now, from the dashboard's Today board, as compact JSON: `todo` (due/overdue first), `blocked` (waiting on someone — blockers listed), `unblocked` (a blocker just delivered), `looks_done` (confirm to close). Each card: id (use with card / build_start), summary, who, due, repo, live run, pending offer. Call this for \"what are my tasks\", \"what's on today\", \"what's blocked\".",
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
      "One board card's full context — what the dashboard shows: summary, detail, who, due, repo, the source message (excerpt), links (message, PRs, tickets), the stored context paragraph, blockers, runs on it (each with its session and PR), and pending offers. `id` is a card id from board (a number, or p<id> for a standalone offer). Call before starting work on a card.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 20, description: 'Card id from board, e.g. "412" or "p37".' } },
      required: ['id'],
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
  {
    name: 'build_start',
    description:
      "Start a Build agent (one Claude Code agent per task) — the user approves each call. From a Plan card (`card`: its summary and context become the brief and the card moves to dispatched) and/or the user's words (`task`). The agent works in a fresh worktree when the card or `repo` names a repo, may open a draft PR, never merges. `model`: haiku (docs, reports), sonnet (default), opus (hard), fable (claude-fable-5-1, the strongest; it has its own weekly limit). Returns the run; follow it with build_runs / build_run.",
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string', maxLength: 20, description: 'A Plan card id (commitment).' },
        task: { type: 'string', maxLength: 4000, description: "What to do, in the user's words; needed without a card." },
        repo: { type: 'string', maxLength: 300, description: "A known checkout; defaults to the card's repo." },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus', 'fable'] },
        idle_after_s: { type: 'integer', minimum: 30, maximum: 21600, description: 'Seconds of silence (no transcript, terminal or message activity) before the run counts as idle and you are told. Default 240; quick tasks 120; long builds or research 900+.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'build_set_idle',
    description: "Change how long a Build agent may be silent before it is flagged idle (the user approves each call). Use it after build_run shows a long step is fine, or to tighten a quick task. A run waiting on its own question is never idle.",
    inputSchema: { type: 'object', properties: { run: { type: 'integer' }, seconds: { type: 'integer', minimum: 30, maximum: 21600 } }, required: ['run', 'seconds'], additionalProperties: false },
  },
  {
    name: 'build_runs',
    description:
      'Build agents (one Claude Code agent per task, started by Do): the live ones and the recent ones, each with state (running, waiting = it asked a question, done, failed, stopped), model, notional cost, branch, result, and `needs_you`: the open questions agents are blocked on (answer one with build_reply) and idle agents (state idle: last tool call, last output, how long; decide: build_run to look, build_send to nudge, build_set_idle if the wait is fine, build_stop). Call this for "what are the agents doing", "is anything waiting on me".',
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', default: false, description: 'Include ended runs (the last 15).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'build_run',
    description:
      'One Build agent run in detail: state, cost and tokens, its agents (main and subagents) and last tool calls, and every message it and Jarvis exchanged (notes, asks, replies), plus the termhub link.',
    inputSchema: { type: 'object', properties: { run: { type: 'integer', minimum: 1 } }, required: ['run'], additionalProperties: false },
  },
  {
    name: 'card_plan_propose',
    description:
      "Propose SEVERAL card changes as ONE plan the user approves once (and can trim) on the dashboard's \"Proposed card changes\" card. Use it instead of calling card_edit / done / task_add one by one whenever the user wants more than one change (\"update our cards from Drew's plan\"): read and analyze first, then send all the changes here. This only STORES the proposal and changes no card, so it runs without a prompt. Each item: `op` edit | close | create. edit: `card` + any of title, details, due, project, note. close: `card` (+ `as`: dismiss = not needed (default) or done). create: `title` (+ details, due, project). Every item takes a short `reason` (the user sees it). `card` ids come from board and must be open; `due` is words like friday, tomorrow 3pm, 2d, 2026-11-20 (not past). Everything is checked first and all problems come back together: fix and send again. Returns the plan id and its link. Then tell the user it waits on the dashboard, or ask \"apply all N?\" and call card_plan_apply.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200, description: 'What the plan is from, e.g. "Drew\'s VM migration plan".' },
        rationale: { type: 'string', maxLength: 4000, description: 'The analysis in a few sentences: why these changes.' },
        sources: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 }, description: 'Links or names of what you read.' },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 60,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['edit', 'close', 'create'] },
              card: { type: 'string', maxLength: 20, description: 'A board card id, for edit and close.' },
              title: { type: 'string', maxLength: 500 },
              details: { type: ['string', 'null'], maxLength: 8000 },
              due: { type: ['string', 'null'], maxLength: 80, description: 'null clears the date (edit).' },
              project: { type: ['string', 'null'], maxLength: 120 },
              note: { type: 'string', maxLength: 2000, description: 'Edit only: appended to the details as a dated line.' },
              as: { type: 'string', enum: ['dismiss', 'done'], description: 'Close only; default dismiss.' },
              reason: { type: 'string', maxLength: 300, description: 'Why, in a few words (shown to the user and kept in the ledger).' },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'items'],
      additionalProperties: false,
    },
  },
];

const ACTION_TOOLS = [
  {
    name: 'card_plan_apply',
    description:
      "Apply a stored card plan (from card_plan_propose): ONE approval for all its changes (the user approves the call, which names how many). Use it when the user says yes in the conversation (\"apply all 6\"); `skip` lists item numbers (1-based, as shown in the plan) the user wants left out. Items run in order as the user's own changes; one that fails is recorded and the rest go on; an applied item never runs twice. Returns each item's result.",
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'integer', minimum: 1, description: 'The plan id card_plan_propose returned.' },
        skip: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Item numbers to leave out.' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'card_edit',
    description:
      "Edit a board card in place instead of dismissing it and making a new one (the user approves each call). Change any of: `title` (the one-line summary), `details` (the longer description; replaces it), `due` (\"friday\", \"tomorrow 3pm\", \"2d\", \"2026-11-20\"; null clears it; not a date in the past), `project` (a name from `pa projects`; null clears it), `note` (appended to the details as a dated line, keeping what is there). Give only the fields to change. The card keeps its id, source and history; the edit is recorded in its ledger with `reason`, and the card is then left as the user set it. To close a card use `pa done`, not this. Returns what changed (before and after).",
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string', maxLength: 20, description: 'A board card id (commitment), from board.' },
        title: { type: 'string', maxLength: 200 },
        details: { type: ['string', 'null'], maxLength: 8000 },
        due: { type: ['string', 'null'], maxLength: 80, description: 'A date in the words when.ts reads, or null to clear.' },
        project: { type: ['string', 'null'], maxLength: 120 },
        note: { type: 'string', maxLength: 2000 },
        reason: { type: 'string', maxLength: 200, description: 'Why, in a few words (the ledger keeps it).' },
      },
      required: ['card'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_reply',
    description:
      "Answer a Build agent's open question (the user approves each call). The agent is blocked on `pa run ask` and carries on with this answer. `run` from build_runs.needs_you.",
    inputSchema: {
      type: 'object',
      properties: { run: { type: 'integer', minimum: 1 }, text: { type: 'string', maxLength: 4000 } },
      required: ['run', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_send',
    description:
      "Type a message into a running Build agent's terminal session (the user approves each call): an instruction, a correction, a nudge. Use build_reply instead when the agent asked a question.",
    inputSchema: {
      type: 'object',
      properties: { run: { type: 'integer', minimum: 1 }, text: { type: 'string', maxLength: 4000 } },
      required: ['run', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_stop',
    description: 'Stop a Build agent: kills its terminal session and marks the run stopped (the user approves each call).',
    inputSchema: { type: 'object', properties: { run: { type: 'integer', minimum: 1 } }, required: ['run'], additionalProperties: false },
  },
  {
    name: 'session_start',
    description:
      "Start one Claude Code agent on a task — the user approves each call. The same Build agent as build_start (shown on Build, in a termhub session the user can watch), briefed with `prompt` and, from a card, its context.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', maxLength: 300, description: "A known checkout; defaults to the card's repo." },
        prompt: { type: 'string', maxLength: 4000, description: "What the agent should do, in the user's words." },
        card: { type: 'string', maxLength: 20 },
        model: { type: 'string', maxLength: 120, description: 'Optional Build model: haiku, sonnet, opus or fable.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

const ALL = [...READ_TOOLS, ...ACTION_TOOLS];

// ------------------------------------------------------------- helpers ----

function clip(s: unknown, n: number) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isoDay(d: Date | string | number) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Pure. A due date as the chat says it: overdue, today, tomorrow, or the date. */
function dueLabel(dueAt: Date | string | number, now: Date | string | number = Date.now()) {
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
function parseCardId(id: number | string | null | undefined) {
  const s = String(id ?? '').trim();
  let m = /^#?(\d{1,12})$/.exec(s);
  if (m) return { commitment: Number(m[1]) };
  m = /^p(\d{1,12})$/i.exec(s);
  if (m) return { proposal: Number(m[1]) };
  throw new Error(`"${s}" is not a card id — a number from board (or p<id> for an offer)`);
}

function repoOf(c: Json, extra: Json) {
  return extra?.slug || (c.repo_path ? String(c.repo_path).split(/[\\/]/).filter(Boolean).pop() : null) || null;
}

/** Pure. One board card as the chat reads it. `extra`: {slug, run} by card id. */
function compactCard(c: Json, extra: Json = {}, now: Date | string | number = Date.now()) {
  const out: Json = { id: String(c.id) };
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
  if (c.blockers?.length) out.blockers = c.blockers.map((b: Json) => ({ id: String(b.id), who: b.who ? clip(b.who, 50) : null, summary: clip(b.summary, 100) }));
  if (c.unblocked?.length) out.unblocked = c.unblocked.map((b: Json) => ({ id: String(b.blocker_id), who: b.who ? clip(b.who, 50) : null, summary: clip(b.summary, 100) }));
  if (c.waitingOn) out.waiting_on = true;
  const offers = (c.asks || []).filter((p: Json) => p && p.kind === 'dispatch');
  if (offers.length) out.offer = { proposal: Number(offers[0].id), title: clip(offers[0].title, 100) };
  const other = (c.asks || []).filter((p: Json) => p && p.kind !== 'dispatch');
  if (other.length) out.asks = other.map((p: Json) => ({ proposal: Number(p.id), kind: p.kind, title: clip(p.title, 100) }));
  if (c.settled) out.looks_done = { proposal: Number(c.settled.id), confidence: c.settled.confidence ?? null };
  if (c.standalone) out.standalone = true;
  return out;
}

/** Pure. The board (dashboard/board.js build()) as the chat's grouped list. */
function boardView(board: Json | null | undefined, { extras = new Map(), limit = 25, now = Date.now() }: { extras?: Map<string, Json>; limit?: number; now?: Date | string | number } = {}) {
  const onMe = board?.onMe || [];
  const card = (c: Json) => compactCard(c, extras.get(String(c.id)) || {}, now);
  const unblocked = onMe.filter((c: Json) => c.group === 'todo' && c.unblocked?.length);
  const todo = onMe.filter((c: Json) => c.group === 'todo' && !c.unblocked?.length);
  const groups = {
    todo: todo.map(card),
    blocked: onMe.filter((c: Json) => c.group === 'blocked').map(card),
    unblocked: unblocked.map(card),
    looks_done: onMe.filter((c: Json) => c.group === 'settled').map(card),
  };
  const out: Json = { as_of: new Date(now).toISOString(), counts: {} };
  for (const [g, list] of Object.entries(groups)) {
    out.counts[g] = list.length;
    out[g] = list.slice(0, limit);
    if (list.length > limit) out[`${g}_more`] = list.length - limit;
  }
  out.counts.waiting_on_others = board?.counts?.waiting ?? 0;
  return out;
}

/** Pure. A termhub session as the chat reads it. */
function sessionRow(s: Json, { runs = new Map(), base = null }: { runs?: Map<string, unknown>; base?: unknown } = {}) {
  const out: Json = { id: String(s.id), title: clip(s.title || '', 80) };
  if (s.cwd) out.cwd = String(s.cwd);
  if (s.kind) out.kind = s.kind;
  const state = s.alive === false ? 'ended' : s.idleState === 'working' ? 'working'
    : s.idleState === 'waiting' && (s.idleReason === 'blocked' || s.idleReason === 'question') ? 'needs_answer'
      : s.idleState || (s.busy ? 'working' : 'idle');
  out.state = state;
  const run = runs.get(String(s.id));
  if (run) out.run = run;
  // What termhub says the session belongs to (plan E1: stored ids, not the title).
  const links = require('../dispatch/termhub.ts').sessionLinks(s.links);
  if (links) out.links = links;
  if (base) out.url = `${base}/#session=${encodeURIComponent(s.id)}`;
  return out;
}

// --------------------------------------------------------------- reads ----

function hubBase(machine: string | null = null) {
  try {
    return require('../dispatch/termhub.ts').forMachine(machine).base;
  } catch {
    return null;
  }
}

async function boardTool({ limit = 25 }: { limit?: number } = {}) {
  // The parts of the dashboard's state() (src/dashboard/server.js) the board
  // is built from — not drafts, sources, notifications or spend.
  const { gather } = require('../brief');
  const data = await gather({ horizonDays: 7 });
  const s = { ...data };
  s.looksDone = await require('../ledger/reconcile.ts').proposals().catch(() => []);
  s.needsYou = await require('../proposals').pending().catch(() => []);
  await require('../dashboard/cards.ts').enrich(s).catch(() => {});
  s.blocks = await require('../commitments/blocks.ts').forBoard().catch(() => []);
  const board = require('../dashboard/board.ts').build(s);
  const ids = board.onMe.filter((c: Json) => !c.standalone).map((c: Json) => Number(c.id)).filter(Number.isFinite);
  const extras = new Map();
  if (ids.length) {
    const found = await repository.commitments.boardExtras(ids).catch(() => []);
    for (const f of found) extras.set(String(f.id), { slug: f.slug || null, run: f.run || null });
  }
  return boardView(board, { extras, limit });
}

async function cardTool({ id }: { id?: number | string | null }) {
  const ref = parseCardId(id);
  const { sourceLabel } = require('../dispatch/brief.ts');
  if (ref.proposal) {
    const p = await repository.proposals.rowForChat(ref.proposal);
    if (!p) throw new Error(`no offer p${ref.proposal}`);
    return {
      id: `p${p.id}`, offer: { proposal: Number(p.id), kind: p.kind, status: p.status, title: clip(p.title, 200), body: clip(p.body, 1500), repo: p.payload?.slug || p.payload?.repoPath || null },
      card: p.commitment_id ? String(p.commitment_id) : null,
    };
  }
  const c = await repository.commitments.cardForChat(ref.commitment);
  if (!c) throw new Error(`no card ${ref.commitment}`);
  const [info, runs, offers, blocks] = await Promise.all([
    require('../dashboard/cards.ts').forCommitments([c.id]).then((r: Json) => r.byId.get(String(c.id)) || null).catch(() => null),
    repository.runs.cardRuns(c.id).catch(() => []),
    repository.proposals.pendingOfCommitment(c.id).catch(() => []),
    repository.commitments.blocksOf(c.id).catch(() => []),
  ]);
  const out: Json = {
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
  const links = (info?.links || []).slice(0, 12).map((l: Json) => ({ kind: l.kind, label: clip(l.label || '', 80), url: l.url }));
  if (links.length) out.links = links;
  const sessions = (info?.sessions || []).slice(0, 4).map((x: Json) => ({ role: x.role || null, label: clip(x.label || x.title || '', 80), url: x.url || null }));
  if (sessions.length) out.sessions = sessions;
  const blockers = blocks.filter((b: Json) => b.task_id === String(c.id) && b.verdict === 'blocks');
  // owner: who it is really on (sql/040) — 'system' or 'me' is a step on you, not someone's debt.
  if (blockers.length) out.blockers = blockers.map((b: Json) => ({ id: b.blocker_id, who: b.who || null, owner: b.owner || 'person', summary: clip(b.summary, 120), status: b.status }));
  const holds = blocks.filter((b: Json) => b.blocker_id === String(c.id) && b.verdict === 'blocks' && b.task_id);
  if (holds.length) out.blocks_task = holds.map((b: Json) => b.task_id);
  if (runs.length) {
    out.runs = runs.map((r: Json) => {
      const o: Json = { run: Number(r.id), status: r.status, route: r.route || 'claude', mode: r.mode };
      if (r.delivery) o.delivery = r.delivery;
      if (r.mr_url) o.pr = r.mr_url;
      if (r.cost_usd != null) o.cost_usd = Number(r.cost_usd);
      if (r.termhub_session_id) {
        o.session_id = String(r.termhub_session_id);
        const base = hubBase(r.machine);
        if (base) o.session = base + '/#session=' + encodeURIComponent(r.termhub_session_id);
      }
      return o;
    });
  }
  if (offers.length) out.offers = offers.map((p: Json) => ({ proposal: Number(p.id), kind: p.kind, title: clip(p.title, 120) }));
  return out;
}

async function sessionsTool({ machine = null, all = false }: { machine?: string | null; all?: boolean } = {}) {
  const termhub = require('../dispatch/termhub.ts');
  const { config } = require('../config.ts');
  if (machine && !config.termhub.machines[machine]) throw new Error(`"${machine}" is not in PA_MACHINES`);
  const hub = termhub.forMachine(machine);
  const list = await hub.listSessions();
  const runs = await repository.runs.withSessions().catch(() => []);
  const byId = new Map<string, unknown>(runs.map((r: Json) => [String(r.termhub_session_id), {
    run: Number(r.id), status: r.status, ...(r.commitment_id ? { card: String(r.commitment_id) } : {}),
  }]));
  const shown = list.filter((s: Json) => all || s.alive !== false).map((s: Json) => sessionRow(s, { runs: byId, base: hub.base }));
  return { machine: machine || 'this machine', count: shown.length, sessions: shown.slice(0, 60) };
}

// ------------------------------------------------------------- actions ----

/** Pure. dispatch.start's result as the chat reports it. */
function startedView(r: Json) {
  return { started: true, run: r.id, route: r.route || 'build', model: r.model || null, branch: r.branch || null, session: r.url || null, repo: r.repoPath || null };
}

async function sessionStartTool(args: Json) {
  const card = args.card != null ? parseCardId(args.card) : null;
  if (card?.proposal) throw new Error(`p${card.proposal} is an offer, not a card`);
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('a session needs a prompt');
  const o: Json = {
    commitmentId: card ? card.commitment : null,
    task: prompt,
    repoPath: args.repo ? String(args.repo).trim() : null,
    model: args.model || null,
    routeReason: 'the chat started a session',
  };
  return startedView(await require('../dispatch').start(o));
}

function parseJson(v: unknown): Json | null {
  try { return v ? JSON.parse(String(v)) : null; } catch { return null; }
}

function runView(r: Row): Json {
  return {
    id: r.id, state: r.state, task: String(r.task).slice(0, 160), model: r.model, cost_usd: Number(r.cost_usd || 0), branch: r.branch || null,
    result: r.result || null, error: r.error || null, idle_after_s: Number(r.idle_after_s || 0), activity: parseJson(r.activity), last_activity_at: r.last_activity_at || null, started_at: r.started_at, ended_at: r.ended_at || null, card: r.commitment_id || null,
  };
}

async function buildRunsTool({ all = false }: { all?: boolean } = {}) {
  const B = require('../build/index.ts');
  const runs: Row[] = await B.list({ live: !all, limit: 15 });
  return { runs: runs.map(runView), needs_you: await require('../build/messages.ts').needsYou() };
}

async function buildRunTool({ run }: { run?: number }) {
  const B = require('../build/index.ts');
  const r: Row | null = await B.get(Number(run));
  if (!r) throw new Error(`no run #${run}`);
  let track: Json | null = null;
  try { track = r.track ? JSON.parse(String(r.track)) : null; } catch { /* a half-written view: none */ }
  const msgs: Row[] = await repository.buildRuns.msgs(r.id);
  return {
    ...runView(r), url: r.url || null, tokens: { in: Number(r.tokens_in), out: Number(r.tokens_out), cache_read: Number(r.tokens_cache_read), cache_write: Number(r.tokens_cache_write) },
    caps: { cost_usd: Number(r.cost_cap_usd), wall_min: Number(r.wall_cap_min) },
    agents: track?.agents || [],
    messages: msgs.map((m) => ({ id: m.id, from: m.dir, kind: m.kind, text: m.body, answer: m.answer || null, at: m.created_at })),
  };
}

async function handle(name: string, args: Json = {}) {
  switch (name) {
    case 'board': return boardTool(args);
    case 'card': return cardTool(args);
    case 'sessions': return sessionsTool(args);
    case 'session_start': return sessionStartTool(args);
    case 'build_start': {
      const card = args.card != null ? parseCardId(args.card) : null;
      if (card?.proposal) throw new Error(`p${card.proposal} is an offer, not a card`);
      const r = await require('../build/index.ts').start({ commitmentId: card ? card.commitment : null, task: args.task ? String(args.task) : null, repoPath: args.repo ? String(args.repo).trim() : null, model: args.model || null, idleAfterS: args.idle_after_s || null });
      return { ...runView(r), url: r.url || null };
    }
    case 'build_set_idle': {
      const r = await require('../build/index.ts').setIdle(Number(args.run), args.seconds);
      return { run: r.id, idle_after_s: r.idle_after_s };
    }
    case 'build_runs': return buildRunsTool(args);
    case 'build_run': return buildRunTool(args as { run?: number });
    case 'build_reply': {
      const r = await require('../build/messages.ts').reply(Number(args.run), args.text);
      return { run: Number(args.run), answered: r.id };
    }
    case 'build_send': {
      await require('../build/messages.ts').send(Number(args.run), args.text);
      return { run: Number(args.run), sent: true };
    }
    case 'card_plan_propose': {
      const r = await require('../cardplans.ts').propose({ title: args.title, rationale: args.rationale, sources: args.sources, items: args.items, via: 'chat' });
      return { plan: r.id, items: r.items, link: r.link, waiting: 'on the dashboard (Proposed card changes), or apply it here with card_plan_apply' };
    }
    case 'card_plan_apply': {
      const r = await require('../cardplans.ts').apply(Number(args.plan), { skip: args.skip || [] });
      return { plan: r.id, status: r.status, applied: r.applied, failed: r.failed, skipped: r.skipped, items: r.items.map((i: Json) => ({ n: i.n, status: i.status, line: i.line, ...(i.error ? { error: i.error } : {}), ...(i.result?.created ? { card: i.result.created } : {}) })) };
    }
    case 'card_edit': {
      const card = parseCardId(args.card);
      if (card.proposal) throw new Error(`p${card.proposal} is an offer, not a card`);
      const { editCard } = require('../commitments.ts');
      const edit: Json = {};
      for (const k of ['title', 'details', 'due', 'project', 'note', 'reason']) if (args[k] !== undefined) edit[k] = args[k];
      const r = await editCard(card.commitment, edit);
      return { card: r.id, changed: r.changed, before: r.before, after: r.after, summary: r.card?.summary ?? null };
    }
    case 'build_stop': {
      const r = await require('../build/index.ts').stop(Number(args.run), 'stopped from the chat');
      return { run: r.id, state: r.state };
    }
    default: return undefined;
  }
}

module.exports = {
  READ_TOOLS, ACTION_TOOLS, ALL, CHAT_READ_TOOL_NAMES, CHAT_ACTION_TOOL_NAMES,
  handle, dueLabel, parseCardId, compactCard, boardView, sessionRow, startedView,
};
