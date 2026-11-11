'use strict';

// The dashboard: one page over the same data `pa brief` reads, plus the three
// buttons worth having — done, dismiss, and dispatch — and a Memory tab
// (/api/memory/*, dashboard/memory.js) over the memory layer.
//
// It can start agents, so it inherits the dispatcher's trust model (AGENT.md):
// loopback only, never tailnet-reachable. Two more guards, because "loopback"
// does not stop a web page in your own browser from talking to it:
//
//  - the Host header must be a loopback name, which defeats DNS rebinding;
//  - every POST must carry `X-PA: 1`. A custom header forces a CORS preflight,
//    which this server never answers, so no other origin can forge a click.
//
// Its Send button does not send. It asks for the draft's delivery links and
// opens the reply, already written, in Teams or Outlook; the human presses
// Send there, then tells the page they did. This tool has no path that puts a
// message on the wire (see draft/deliver.js).
//
// Its credential panel ("Needs a credential or sign-in") answers secret requests (src/secrets). A pasted value
// arrives in one POST, goes straight to the OS keyring (src/secrets/vault.js) or `.env`, and the
// reply is `{ok, stored, name}`. No route here returns a value.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;
type HttpError = import('./types.ts').HttpError;
type Route = import('./types.ts').Route;
type RouteCtx = import('./types.ts').RouteCtx;

const fs = require('fs');
const path = require('path');
const http = require('http');
const { config } = require('../config.ts');
const repo = require('../repo');
const { logger } = require('../log.ts');

const log = logger('dashboard');
const PAGE = path.join(__dirname, 'index.html');

function hostAllowed(host: unknown) {
  const name = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

async function commitmentContext(id: number | string) {
  const c = await repo.commitments.contextForDashboard(id);
  if (!c) return { error: `no commitment #${id}` };
  const thread = c.thread_external_id ? await repo.sources.threadItems(c.thread_external_id) : [];
  const termhub = require('../dispatch/termhub.ts');
  const runs = (await repo.runs.detailsForCommitment(id)).map((r: Row) => ({
    ...r,
    url: r.termhub_session_id ? `${termhub.forMachine(r.machine).base}/#session=${encodeURIComponent(r.termhub_session_id as string)}` : null,
  }));
  // Plan E1: each run's job, steps (with their sessions) and PRs, from stored ids.
  const chain = (await require('./cards.ts').chainsFor([id], { perCard: 10 }).catch(() => new Map())).get(String(id)) || [];
  return { ...c, thread: thread.reverse(), runs, chain };
}

async function state() {
  const { gather } = require('../brief');
  const data = await gather({ horizonDays: 7, reviews: false });
  const drafts = await repo.drafts.pendingForBoard();
  const health = require('../ingest/health.ts');
  const sources = await health.sources();
  // Sources that keep failing: the board cannot see what was settled there.
  const blind = health.blind(sources);
  // The Memory tab's badge: claims waiting for a human to vouch for them.
  const review = await repo.memory.pendingReviewCount().catch(() => 0);
  const closed = await require('../commitments.ts').recentlyClosed().catch(() => []);
  // Closes the reconciler was not sure enough to make on its own (src/ledger/reconcile.js).
  const looksDone = await require('../ledger/reconcile.ts').proposals().catch(() => []);
  // Prepared actions and questions waiting on you (src/proposals).
  const needsYou = await require('../proposals').pending().catch(() => []);
  // Secret and login requests: names and guidance only — the table holds no values.
  const secretRequests = await require('../secrets').pending().catch(() => []);
  // What the assistant said, pushed or held back, with your thumbs on it (src/notify).
  const notifications = await require('../notify').feed({ limit: 30 }).catch(() => []);
  // Today's model spend against the daily cap (src/budget.js); null until migrated.
  const spend = await require('../budget.ts')
    .status()
    .then((s: Row) => ({ today: s.today, cap: s.cap }))
    .catch(() => null);
  const out = { ...data, drafts, sources, blind, closed, looksDone, needsYou, memoryPending: review, secretRequests, spend, notifications, now: new Date().toISOString() };
  // Every card's links (the message, the person, the repo, the PRs it names,
  // the Claude session) and its stored cause-and-effect paragraph
  // (dashboard/cards.js). A failure here costs the links, not the page.
  await require('./cards.ts')
    .enrich(out)
    .catch((err: Error) => log.warn('card links failed', { message: err.message }));
  // Which of what people owe you blocks one of your tasks (commitments/blocks.js).
  out.blocks = await require('../commitments/blocks.ts').forBoard().catch(() => []);
  // The Today board's columns, one card per commitment (dashboard/board.js).
  out.board = require('./board.ts').build(out);
  // Inputs the page no longer draws: a note from your own work reaches it only
  // through the board (when it needs you), and the open GitHub/Jira items are
  // on the Repos view (GET api/repos, dashboard/repos.js).
  delete out.selfNotes;
  delete out.reviews;
  return out;
}

function send(res: Res, status: number, body: unknown, type: string = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // A page may be framed only by a page of its own origin: nav.js's shell, which
    // hosts the other destinations in frames (under termhub's /pa/ that origin is
    // termhub's, so its Sessions page can host these too). Nothing else can.
    ...(/^text\/html/.test(type) ? { 'Content-Security-Policy': "frame-ancestors 'self'" } : {}),
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : (body as string | Buffer));
}

function readJson(req: Req) {
  return new Promise<Row>((resolve, reject) => {
    let raw = '';
    req.on('data', (d: Buffer) => {
      raw += d;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

// Page tokens: a random value issued with each page load and kept by that
// page in memory only (never on disk, never in a cookie). Starting or
// accepting work that merges or pushes to main with no human step after it
// needs one, on top of X-PA. A dispatched agent runs as the same OS user and
// can send X-PA itself; it now has to deliberately scrape a page for a token
// too. Defence in depth, not a boundary: the boundary is a separate OS user.
const PAGE_TOKEN_TTL_MS = 12 * 3600_000;
const PAGE_TOKENS_MAX = 20;
const pageTokens = new Map<string, number>();

function issuePageToken(now: number = Date.now()) {
  for (const [t, at] of pageTokens) if (now - at > PAGE_TOKEN_TTL_MS) pageTokens.delete(t);
  while (pageTokens.size >= PAGE_TOKENS_MAX) pageTokens.delete(pageTokens.keys().next().value as string);
  const t = require('crypto').randomBytes(24).toString('base64url');
  pageTokens.set(t, now);
  return t;
}

function pageTokenOk(req: Req, now: number = Date.now()) {
  const t = String(req.headers['x-pa-page'] || '');
  const at = t ? pageTokens.get(t) : undefined;
  return at !== undefined && now - at <= PAGE_TOKEN_TTL_MS;
}

function pageHtml(token: string) {
  return fs.readFileSync(PAGE, 'utf8').replace('</head>', `<meta name="pa-page" content="${token}">\n</head>`);
}

// Server-Sent Events: one `data:` JSON chat event per message. A comment line
// every 20 s keeps proxies (termhub's /pa/) and the browser from timing out.
function chatStream(req: Req, res: Res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write('retry: 3000\n\n');
  const unsubscribe = require('../chat/feed.ts').feed().subscribe((e: Row) => {
    res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  const done = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', done);
  res.on('error', done);
}

// Answers a module route's JSON (memory, meetings, debriefs, routines): its
// value, or 404 when it does not know the path. A POST needs X-PA. `load` is a
// literal require: the compiled jarvisd cannot resolve a computed one.
async function jsonModule(c: RouteCtx, load: () => { route(method: string | undefined, url: URL, body: Row): unknown }) {
  const { req, res, url, send } = c;
  if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
  const body: Row = req.method === 'POST' ? await c.body() : {};
  const out = await load().route(req.method, url, body);
  return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
}

// A 400 an action threw (a bad argument), as the reply; anything else goes up.
async function badRequestAs400<T>(c: RouteCtx, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 400) return c.send(c.res, 400, { error: err.message });
    throw err;
  }
}

const startsWith = (...prefixes: string[]) => (url: URL) => prefixes.some((p) => url.pathname.startsWith(p));
const oneOf = (...paths: string[]) => (url: URL) => paths.includes(url.pathname);
const file = (name: string, type: string) => (c: RouteCtx) => c.send(c.res, 200, fs.readFileSync(path.join(__dirname, name), 'utf8'), type);
const JS = 'text/javascript; charset=utf-8';

// The destinations' names (nav.js DESTS) as URLs. A relative Location, so it
// lands right under termhub's /pa/ too.
const ALIAS: Record<string, string> = { '/ask': 'talk', '/plan': './', '/build': 'factory', '/map': 'architecture' };

/**
 * Every route, in the order the old if-chain tried them (router.ts). A handler
 * that returns false passes the request on.
 */
const ROUTES: Route[] = [
  // ---- Passkey sessions (plan 7.1, dashboard/auth.ts): inert unless PA_PASSKEYS=on.
  // The sign-in routes first, then the gate that demands a session of everything else. ----
  { path: () => true, handle: (c) => require('./auth.ts').route(c.req, c.res, c.url, c) },
  { path: () => true, handle: (c) => require('./auth.ts').gate(c.req, c.res, c.url, c) },

  { method: 'GET', path: '/', handle: (c) => c.send(c.res, 200, pageHtml(issuePageToken()), 'text/html; charset=utf-8') },
  {
    method: 'GET',
    path: (url) => Boolean(ALIAS[url.pathname]),
    handle: ({ res, url }) => {
      res.writeHead(302, { Location: ALIAS[url.pathname] + url.search, 'Cache-Control': 'no-store' });
      res.end();
    },
  },
  // The design system shared by every layer (theme.css) and the layer switcher
  // (nav.js). termhub serves byte copies of both; see the header of theme.css.
  { method: 'GET', path: '/theme.css', handle: file('theme.css', 'text/css; charset=utf-8') },
  { method: 'GET', path: '/nav.js', handle: file('nav.js', JS) },

  // The voice page (dashboard/talk.ts): /talk, its scripts, its models
  // (/talk/models/), the local voice service's proxy, and POST
  // /api/talk/transcribe (X-PA guarded there).
  {
    path: (url) => url.pathname === '/talk' || startsWith('/talk.', '/talk/', '/api/talk/')(url),
    handle: (c) => require('./talk.ts').route(c.req, c.res, c.url, c),
  },
  // The Build board (dashboard/buildBoard.ts, D30): one card per Build agent run.
  {
    path: (url) => oneOf('/build-board.js', '/api/build')(url) || url.pathname.startsWith('/api/build/'),
    handle: (c) => require('./buildBoard.ts').route(c.req, c.res, c.url, c),
  },
  // The Factory layer (dashboard/factory.ts, factory.html): every factory job
  // from the worker's stored list, and its actions (X-PA guarded there).
  {
    path: (url) => oneOf('/factory', '/factory.js', '/factory-apps.js', '/factory-board.js', '/api/factory')(url) || url.pathname.startsWith('/api/factory/'),
    handle: (c) => require('./factory.ts').route(c.req, c.res, c.url, c),
  },
  // The live feed (dashboard/events.ts): GET /api/events, an SSE stream of
  // board, run and factory changes with Last-Event-ID replay, and /events.js.
  { path: oneOf('/api/events', '/events.js'), handle: (c) => require('./events.ts').route(c.req, c.res, c.url, c) },
  // The architecture map (dashboard/architecture.ts, architecture.json).
  {
    path: oneOf('/architecture', '/architecture.client.js', '/api/architecture'),
    handle: (c) => require('./architecture.ts').route(c.req, c.res, c.url, c),
  },
  // Meter's data (dashboard/meter.ts): GET /api/meter, POST /api/telemetry.
  { path: oneOf('/api/meter', '/api/telemetry'), handle: (c) => require('./meter.ts').route(c.req, c.res, c.url, c) },

  // The end state a Do would get, before it is pressed: the page shows it,
  // and must send it back as `confirmedLevel` to start an unattended one.
  {
    method: 'GET',
    path: /^\/api\/commitments\/(\d+)\/delivery$/,
    handle: async ({ res, url, m, send }) => {
      const D = require('../dispatch/deliveryCore.ts');
      const q = url.searchParams;
      const delivery = q.get('delivery') || null;
      if (delivery && !D.isDelivery(delivery)) return send(res, 400, { error: 'unknown delivery' });
      let jobKind: string | null = null;
      try {
        jobKind = q.get('kind') ? require('../dispatch/factoryCore.ts').jobKind(q.get('kind')) : null;
      } catch (e) {
        return send(res, 400, { error: (e as HttpError).message });
      }
      const r = await require('../dispatch').previewDelivery({ commitmentId: Number(m?.[1]), mode: q.get('mode') || undefined, delivery, jobKind });
      return send(res, 200, { ...r, plain: r.delivery ? D.describe(r.delivery) : null, unattended: D.unattended(r.delivery) });
    },
  },
  // Which code this worker serves. Open pages poll it (nav.js) and reload
  // themselves once it changes, so an update reaches every open tab.
  {
    method: 'GET',
    path: '/healthz',
    handle: ({ res, send }) => {
      const ok = readiness.ready && !readiness.draining;
      return send(res, ok ? 200 : 503, { ready: ok, draining: readiness.draining, commit: servedCommit(), pid: process.pid });
    },
  },
  { method: 'GET', path: '/api/version', handle: ({ res, send }) => send(res, 200, { commit: servedCommit() }) },
  // What a typed follow-up time means, before it is set: the card previews it
  // with the same parser the chase uses (src/util/when.ts via chaseCore).
  {
    method: 'GET',
    path: '/api/when',
    handle: ({ res, url, send }) => {
      const C = require('../durable/tasks/chaseCore.ts');
      const canonical = C.cadenceAnswer(url.searchParams.get('text') || '');
      const when = canonical ? C.chaseAtFor(canonical, new Date()) : undefined;
      return send(res, 200, canonical && when ? { ok: true, canonical, at: when.toISOString() } : { ok: false });
    },
  },
  { method: 'GET', path: '/api/state', handle: async ({ res, send }) => send(res, 200, await state()) },
  // One commitment with what it came from, so it can be judged before it is
  // dispatched: the ask itself, the thread around it, and any runs so far.
  { method: 'GET', path: /^\/api\/commitments\/(\d+)$/, handle: async ({ res, m, send }) => send(res, 200, await commitmentContext(Number(m?.[1]))) },
  // The PA chat (src/chat): termhub's "PA chat" button asks for the session
  // and attaches to it. Starting a Claude Code session is an action, so it
  // takes the same X-PA guard as every other POST.
  {
    method: 'POST',
    path: '/api/chat/open',
    handle: async ({ req, res, send }) => {
      if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
      return send(res, 200, await require('../chat/feed.ts').openChat());
    },
  },
  // The chat box and the voice page talk to that same session
  // (src/chat/feed.ts; contract in the README, "Talking to it").
  {
    method: 'POST',
    path: '/api/chat',
    handle: async (c) => {
      const { req, res, send } = c;
      if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
      const body = await c.body();
      return send(res, 200, await require('../chat/feed.ts').feed().send({ text: body.text, source: body.source || 'typed' }));
    },
  },
  // Approve / Deny on the chat's permission prompt, from the Talk page. It
  // answers a prompt that may start work, so it needs the page's token as well
  // as X-PA, and src/chat/permission.ts checks the screen before one keystroke.
  {
    method: 'POST',
    path: '/api/chat/permission',
    handle: async (c) => {
      const { req, res, send } = c;
      if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
      if (!pageTokenOk(req)) return send(res, 403, { error: 'answering a permission prompt needs the page token — reload the page' });
      const body = await c.body();
      return send(res, 200, await require('../chat/feed.ts').feed().answerPermission({ answer: body.answer, toolUseId: body.toolUseId, via: body.via === 'voice' ? 'voice' : 'dashboard' }));
    },
  },
  // The worker's INBOX doorbell for the SDK chat (src/notify/chat): a
  // notification id only; the line typed is fixed (nudgeText), never content.
  {
    method: 'POST',
    path: '/api/chat/doorbell',
    handle: async (c) => {
      const { req, res, send } = c;
      if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
      const f = require('../chat/feed.ts');
      if (f.engine() !== 'sdk') return send(res, 409, { error: 'the doorbell endpoint is for the SDK engine' });
      const body = await c.body();
      return send(res, 200, f.feed().doorbell(body.id, { minIdleMs: Number(body.minIdleMs) >= 0 ? Number(body.minIdleMs) : undefined }));
    },
  },
  {
    method: 'GET',
    path: '/api/chat/history',
    handle: ({ res, url, send }) => send(res, 200, { messages: require('../chat/feed.ts').feed().history(url.searchParams.get('limit') || 50) }),
  },
  { method: 'GET', path: '/api/chat/session', handle: async ({ res, send }) => send(res, 200, await require('../chat/feed.ts').feed().session()) },
  { method: 'GET', path: '/api/chat/stream', handle: ({ req, res }) => chatStream(req, res) },
  // The board's "Waiting for your yes" card (permission.client.js): the click
  // path for the chat's permission prompt; Talk answers it by voice.
  { method: 'GET', path: '/permission.js', handle: file('permission.client.js', JS) },
  { method: 'GET', path: '/chat.js', handle: file('chat.client.js', JS) },
  // A Plan card's ☰ dispatch settings menu (reads and writes …/dispatch-settings below).
  { method: 'GET', path: '/dispatchMenu.js', handle: file('dispatchMenu.client.js', JS) },
  {
    method: 'GET',
    path: '/api/secrets',
    handle: async ({ res, send }) => {
      const r = await require('../secrets').list();
      return send(res, 200, { secrets: r.secrets, pending: r.pending, vaultError: r.vaultError });
    },
  },

  // Workflow cost ceilings (dashboard/workflowLimits.ts): GET, and a POST behind X-PA there.
  { path: '/api/workflow-limits', handle: (c) => require('./workflowLimits.ts').route(c.req, c.res, c.url, c) },
  // The Memory tab, pre-meeting briefs and post-meeting debriefs. A POST needs X-PA.
  { path: startsWith('/api/memory/'), handle: (c) => jsonModule(c, () => require('./memory.ts')) },
  { path: startsWith('/api/meetings/'), handle: (c) => jsonModule(c, () => require('./meetings.ts')) },
  // An upload is the raw body, streamed to disk, so it is answered before any JSON body is read.
  { method: 'POST', path: '/api/debriefs/import', handle: (c) => require('./debriefs.ts').upload(c.req, c.res, c.url, c) },
  { path: (url) => url.pathname === '/api/debriefs' || url.pathname.startsWith('/api/debriefs/'), handle: (c) => jsonModule(c, () => require('./debriefs.ts')) },
  // The Routines tab (dashboard/routines.ts, routines.client.js). Its writes
  // run actions on this machine, so the same guards apply.
  { method: 'GET', path: '/routines.js', handle: file('routines.client.js', JS) },
  { path: (url) => url.pathname === '/api/routines' || url.pathname.startsWith('/api/routines/'), handle: (c) => jsonModule(c, () => require('./routines.ts')) },
  // The Repos tab (dashboard/repos.ts, repos.client.js): the repo registry.
  { method: 'GET', path: '/repos.js', handle: file('repos.client.js', JS) },
  {
    path: (url) => url.pathname === '/api/repos' || url.pathname.startsWith('/api/repos/'),
    handle: async ({ req, res, url, send }) => {
      if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
      const out = await require('./repos.ts').route(req.method, url);
      if (out && out.error === 'not found') return send(res, 404, out);
      return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out);
    },
  },

  // Every other POST: X-PA, and a JSON body, before its route is looked for.
  {
    method: 'POST',
    path: () => true,
    handle: async (c) => {
      if (c.req.headers['x-pa'] !== '1') return c.send(c.res, 403, { error: 'missing X-PA header' });
      await c.body();
      return false;
    },
  },
  // A pasted secret goes from this body straight into the store. The reply
  // says where it went and never carries the value (AGENT.md, Secrets).
  {
    method: 'POST',
    path: /^\/api\/secrets\/(\d+)\/(fulfil|decline|done)$/,
    handle: async (c) => {
      const { res, m, send } = c;
      const secrets = require('../secrets');
      const id = Number(m?.[1]);
      if (m?.[2] === 'decline') return send(res, 200, { ok: true, ...(await secrets.decline(id)) });
      if (m?.[2] === 'done') return send(res, 200, { ok: true, ...(await secrets.loginDone(id)) });
      const body = await c.body();
      const target = body.target === 'env-file' ? 'env-file' : body.target ? 'credential-manager' : undefined;
      const r = await secrets.fulfil(id, typeof body.value === 'string' ? body.value : '', { target });
      return send(res, 200, { ok: r.ok, stored: r.stored, name: r.name });
    },
  },
  // A thumb on a notification: moves how often its kind interrupts you.
  {
    method: 'POST',
    path: /^\/api\/notifications\/(\d+)\/feedback$/,
    handle: async (c) => {
      const body = await c.body();
      const value = body.value === 'up' || body.value === 'down' ? body.value : null;
      return c.send(c.res, 200, await require('../notify').feedback(Number(c.m?.[1]), value));
    },
  },
  // A card's Claude session, opened in termhub on the machine it ran on:
  // the live session, or `claude --resume <id>` in its folder.
  { method: 'POST', path: /^\/api\/sessions\/(\d+)\/open$/, handle: async ({ res, m, send }) => send(res, 200, await require('./cards.ts').openSession(Number(m?.[1]))) },
  // The board's "+ task" box: a task because you typed it (src/commitments/request.ts).
  {
    method: 'POST',
    path: '/api/tasks',
    handle: (c) =>
      badRequestAs400(c, async () => {
        const body = await c.body();
        const request = require('../commitments/request.ts');
        const str = (v: unknown) => (typeof v === 'string' ? v : null);
        const r = await request.add({ text: str(body.text), due: str(body.due), for: str(body.for), owedToMe: body.owedToMe === true, via: 'board' });
        return c.send(c.res, 200, { ok: true, id: r.id, text: request.describe(r) });
      }),
  },
  // Your call on what someone owes you: it blocks a task of yours, or not.
  {
    method: 'POST',
    path: /^\/api\/commitments\/(\d+)\/block$/,
    handle: (c) =>
      badRequestAs400(c, async () => {
        const body = await c.body();
        return c.send(c.res, 200, await require('../commitments/blocks.ts').set(Number(c.m?.[1]), {
          verdict: String(body.verdict), taskId: body.taskId == null ? null : Number(body.taskId),
        }));
      }),
  },
  {
    method: 'POST',
    path: /^\/api\/commitments\/(\d+)\/status$/,
    handle: async (c) => {
      const body = await c.body();
      const { setStatus } = require('../commitments.ts');
      return c.send(c.res, 200, await setStatus(Number(c.m?.[1]), String(body.status)));
    },
  },
  // A card edited in place (title, due date, a note, details, project): src/commitments.ts editCard.
  {
    method: 'POST',
    path: /^\/api\/commitments\/(\d+)\/edit$/,
    handle: async (c) => {
      const body = await c.body();
      const edit: Row = {};
      for (const k of ['title', 'details', 'due', 'project', 'note', 'reason']) if (body[k] !== undefined) edit[k] = body[k];
      try {
        return c.send(c.res, 200, await require('../commitments.ts').editCard(Number(c.m?.[1]), edit));
      } catch (e) {
        const msg = (e as Error).message;
        return c.send(c.res, /^no commitment/.test(msg) ? 404 : 400, { error: msg });
      }
    },
  },
  // A proposal answered: yes/no, or the option picked for a question.
  {
    method: 'POST',
    path: /^\/api\/proposals\/(\d+)\/(accept|reject)$/,
    handle: async (c) => {
      const { req, res, m, send } = c;
      const body = await c.body();
      const answer = typeof body.answer === 'string' ? body.answer.slice(0, 200) : null;
      // A dispatch card's end state, picked when accepting: one of the six
      // levels or nothing (the card's own); anything else is refused.
      const D = require('../dispatch/deliveryCore.ts');
      const delivery = typeof body.delivery === 'string' && body.delivery ? body.delivery : null;
      if (delivery && !D.isDelivery(delivery)) return send(res, 400, { error: `unknown delivery "${delivery.slice(0, 40)}"` });
      if (m?.[2] === 'accept') {
        const p = await repo.proposals.kindAndPayload(Number(m[1]));
        const final = delivery || p?.payload?.delivery || null;
        if (p?.kind === 'dispatch' && D.unattended(final) && !pageTokenOk(req)) {
          return send(res, 403, { error: `accepting a card that ${final === 'push_to_main' ? 'pushes to main' : 'merges'} needs this page's token — reload the dashboard` });
        }
      }
      return send(res, 200, await require('../proposals').decide(Number(m?.[1]), { accept: m?.[2] === 'accept', answer, delivery }));
    },
  },
  // A "Looks done?" card answered: accepting closes it as your decision.
  {
    method: 'POST',
    path: /^\/api\/ledger\/evidence\/(\d+)\/(accept|reject)$/,
    handle: async ({ res, m, send }) => send(res, 200, await require('../ledger/reconcile.ts').decide(Number(m?.[1]), m?.[2] === 'accept')),
  },
  {
    method: 'POST',
    path: /^\/api\/commitments\/(\d+)\/reply$/,
    handle: async ({ res, m, send }) => {
      const draft = await require('../draft').composeReply(Number(m?.[1]));
      return send(res, 200, { id: draft.id });
    },
  },
  {
    method: 'POST',
    path: /^\/api\/drafts\/(\d+)\/(edit|deliver|sent|discard)$/,
    handle: async (c) => {
      const { res, m, send } = c;
      const body = await c.body();
      const drafts = require('../draft');
      const id = Number(m?.[1]);
      if (m?.[2] === 'edit') return send(res, 200, { id: (await drafts.edit(id, String(body.body || ''))).id });
      if (m?.[2] === 'discard') return send(res, 200, await drafts.discard(id));
      if (m?.[2] === 'sent') {
        const row = await drafts.markSent(id, { closeCommitment: body.close === true });
        return send(res, 200, { id: row.id, status: row.status });
      }
      const d = await drafts.delivery(id);
      return send(res, 200, { open: d.open, web: d.web, original: d.original || null, prefilled: d.prefilled, how: d.how, body: d.draft.body });
    },
  },
  // A card's build settings (src/build/index.ts, D30): the model and the run's
  // caps, where each came from, and the options. POST {field: value | null}
  // stores the card's overrides (null clears one) and answers the same shape.
  {
    method: 'GET',
    path: /^\/api\/commitments\/(\d+)\/build-settings$/,
    handle: async ({ res, m, send }) => send(res, 200, await require('../build/index.ts').forCard(Number(m?.[1]))),
  },
  {
    method: 'POST',
    path: /^\/api\/commitments\/(\d+)\/build-settings$/,
    handle: async (c) => {
      const { res, m, send } = c;
      const body = await c.body();
      try {
        return send(res, 200, await require('../build/index.ts').setForCard(Number(m?.[1]), body));
      } catch (e) {
        const err = e as HttpError & { status?: number };
        return send(res, err.status || 400, { error: err.message });
      }
    },
  },
  // Do: starts ONE Claude Code agent for the card with its build settings
  // (src/build/index.ts); a body may override model, costCapUsd, wallCapMin.
  {
    method: 'POST',
    path: /^\/api\/commitments\/(\d+)\/dispatch$/,
    handle: async (c) => {
      const { res, m, send } = c;
      const body = await c.body();
      try {
        const run = await require('../build/index.ts').start({
          commitmentId: Number(m?.[1]), model: body.model || null, costCapUsd: body.costCapUsd || null, wallCapMin: body.wallCapMin || null,
        });
        return send(res, 200, { id: run.id, model: run.model, state: run.state, url: run.url, branch: run.branch, repoPath: run.repo_path });
      } catch (e) {
        const err = e as HttpError & { status?: number };
        return send(res, err.status || (/no commitment/.test(err.message) ? 404 : 400), { error: err.message });
      }
    },
  },
];

async function handle(req: Req, res: Res) {
  if (!hostAllowed(req.headers.host)) return send(res, 403, { error: 'host not allowed' });
  const url = new URL(req.url as string, 'http://localhost');
  if (await require('./router.ts').dispatch(ROUTES, { req, res, url, send, readJson, issuePageToken, pageTokenOk })) return;
  return send(res, 404, { error: 'not found' });
}

// The commit this process started from; read once, at start() (a pull without
// a restart does not change what is served). Falls back to the start time.
let commitCache: string | undefined;
function servedCommit() {
  if (commitCache !== undefined) return commitCache;
  try {
    commitCache = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    commitCache = 'started-' + Date.now();
  }
  return commitCache;
}

// GET /healthz: ready only once the process that serves this has finished
// starting (src/worker.js calls markReady), and no longer once the supervisor
// has moved routing away (markDraining). The supervisor (src/supervisor)
// flips to a new generation on this, never on "the port answers".
const readiness = { ready: false, draining: false };
const markReady = () => {
  readiness.ready = true;
};
// Undone (markDraining(false)) when a rollback moves routing back here.
const markDraining = (on: boolean = true) => {
  readiness.draining = on;
};

function start({ port = config.dispatch.port, host = config.dispatch.host }: { port?: unknown; host?: unknown } = {}) {
  if (!hostAllowed(host)) throw new Error(`refusing to bind the dashboard to ${host}: loopback only`);
  // Now, not at the first request: a generation kept for a rollback is first
  // asked after the pull, and must still name the commit it started from.
  servedCommit();
  const server = http.createServer((req: Req, res: Res) => {
    handle(req, res).catch((err: HttpError) => {
      log.warn('request failed', { path: String(req.url).split('?')[0], message: err.message });
      if (!res.headersSent) send(res, err.status || 500, require('../auth/stepup.ts').errorBody(err));
    });
  });
  // Idle keep-alive sockets live 65 s, not Node's 5: the supervisor pools
  // them, and reusing one this side had just closed failed the request.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.info('listening', { url: `http://${host}:${server.address().port}/` });
      resolve(server);
    });
  });
}

module.exports = { start, hostAllowed, state, handle, issuePageToken, pageTokenOk, markReady, markDraining };
