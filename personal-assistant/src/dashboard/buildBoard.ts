'use strict';

// The Build board's API (PLAN.md D30; the page is factory.html at /factory,
// build.board.client.js at /build-board.js): one card per Build agent run, with
// its agents' timeline, tool calls, cost, messages and result.
//
//   GET  /api/build?page=1&limit=10     {runs, total, live, needs_you, today_usd, now}
//   POST /api/build/runs                {task, model?, repo?, costCapUsd?, wallCapMin?}: a run with no card
//   POST /api/build/<id>/stop           kill its session
//   POST /api/build/<id>/reply          {text}: answer its open question
//   POST /api/build/<id>/send           {text}: type into its session
//
// POSTs carry X-PA like every dashboard action. What an agent wrote (task,
// notes, tool arguments) is data: the page sets it with textContent only.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;
type Row = import('../repo/types.ts').Row;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, 'build.board.client.js');
const CALLS_SHOWN = 40;

/** Pure: a run row, its messages and its parsed track as the card's view. */
function view(r: Row, msgs: Row[], url: string | null): Json {
  let track: Json | null = null;
  try { track = r.track ? JSON.parse(String(r.track)) : null; } catch { track = null; }
  const agents = ((track?.agents as Json[]) || []).map((a) => ({ ...a, calls: (a.calls || []).slice(-CALLS_SHOWN) }));
  return {
    id: Number(r.id), card: r.commitment_id ? Number(r.commitment_id) : null, task: r.task, model: r.model, state: r.state,
    repo: r.repo_path || null, branch: r.branch || null, result: r.result || null, error: r.error || null,
    cost_usd: Number(r.cost_usd || 0), cost_cap_usd: Number(r.cost_cap_usd || 0), wall_cap_min: Number(r.wall_cap_min || 0),
    tokens: { in: Number(r.tokens_in || 0), out: Number(r.tokens_out || 0), cache_read: Number(r.tokens_cache_read || 0), cache_write: Number(r.tokens_cache_write || 0) },
    started_at: r.started_at, ended_at: r.ended_at || null, url, agents, calls_total: Number(track?.totals?.calls || 0),
    messages: msgs.map((m) => ({ id: Number(m.id), run: Number(m.run_id), from: m.dir, kind: m.kind, text: m.body, answer: m.answer || null, answered: Boolean(m.answered_at), at: m.created_at })),
  };
}

/** The board's data: one page of runs, what needs you, today's notional spend. */
async function data(url: URL): Promise<Json> {
  const repo = require('../repo').buildRuns;
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const [rows, total, live]: [Row[], number, number] = await Promise.all([repo.list({ limit, offset: (page - 1) * limit }), repo.count(), repo.count({ live: true })]);
  const msgs: Row[] = await repo.msgsFor(rows.map((r) => r.id));
  const by = new Map<string, Row[]>();
  for (const m of msgs) by.set(String(m.run_id), [...(by.get(String(m.run_id)) || []), m]);
  const base = require('../dispatch/termhub.ts');
  const hub = await base.sessionUrl('x').then((u: string) => u.replace(/#session=x$/, '')).catch(() => null);
  const runs = rows.map((r) => view(r, by.get(String(r.id)) || [], r.session_id && hub ? `${hub}#session=${encodeURIComponent(String(r.session_id))}` : null));
  const since = Date.now() - 24 * 3600_000;
  const recent: Row[] = await repo.list({ limit: 100 });
  const today = recent.filter((r) => Date.parse(String(r.started_at)) >= since).reduce((t, r) => t + Number(r.cost_usd || 0), 0);
  return { runs, total, live, page, limit, needs_you: await require('../build/messages.ts').needsYou(), today_usd: today, now: new Date().toISOString() };
}

async function route(req: Req, res: Res, url: URL, { send, readJson }: { send: Ctx['send']; readJson: Ctx['readJson'] }): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/build-board.js') {
    send(res, 200, fs.readFileSync(CLIENT, 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/build') {
    send(res, 200, await data(url));
    return true;
  }
  if (req.method !== 'POST' || !url.pathname.startsWith('/api/build/')) return false;
  if (req.headers['x-pa'] !== '1') {
    send(res, 403, { error: 'missing X-PA header' });
    return true;
  }
  const body: Json = await readJson(req);
  const B = require('../build/index.ts');
  const M = require('../build/messages.ts');
  try {
    if (url.pathname === '/api/build/runs') {
      if (!String(body.task || '').trim()) return send(res, 400, { error: 'say what the agent should do' }), true;
      const run = await B.start({ task: String(body.task).trim(), model: body.model || null, repoPath: body.repo ? String(body.repo).trim() : null, costCapUsd: body.costCapUsd || null, wallCapMin: body.wallCapMin || null });
      send(res, 200, { id: run.id, model: run.model, state: run.state, url: run.url, branch: run.branch });
      return true;
    }
    const m = /^\/api\/build\/(\d+)\/(stop|reply|send)$/.exec(url.pathname);
    if (!m) return false;
    const id = Number(m[1]);
    if (m[2] === 'stop') {
      const r = await B.stop(id);
      send(res, 200, { id: r.id, state: r.state });
    } else if (m[2] === 'reply') {
      await M.reply(id, body.text);
      send(res, 200, { id, answered: true });
    } else {
      await M.send(id, body.text);
      send(res, 200, { id, sent: true });
    }
    return true;
  } catch (e) {
    const err = e as Error & { status?: number };
    send(res, err.status || 400, { error: err.message });
    return true;
  }
}

module.exports = { route, data, view };
