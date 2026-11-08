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
  const termhub = require('../dispatch/termhub');
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
  const data = await gather({ horizonDays: 7 });
  const drafts = await repo.drafts.pendingForBoard();
  const health = require('../ingest/health.ts');
  const sources = await health.sources();
  // Sources that keep failing: the board cannot see what was settled there.
  const blind = health.blind(sources);
  // The Memory tab's badge: claims waiting for a human to vouch for them.
  const review = await repo.memory.pendingReviewCount().catch(() => 0);
  const closed = await require('../commitments.ts').recentlyClosed().catch(() => []);
  // Closes the reconciler was not sure enough to make on its own (src/ledger/reconcile.js).
  const looksDone = await require('../ledger/reconcile').proposals().catch(() => []);
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
  out.blocks = await require('../commitments/blocks').forBoard().catch(() => []);
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
  const unsubscribe = require('../chat/feed').feed().subscribe((e: Row) => {
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

async function handle(req: Req, res: Res) {
  if (!hostAllowed(req.headers.host)) return send(res, 403, { error: 'host not allowed' });
  const url = new URL(req.url as string, 'http://localhost');

  // ---- Passkey sessions (plan 7.1, dashboard/auth.js): inert unless PA_PASSKEYS=on.
  // The sign-in routes first, then the gate that demands a session of everything else. ----
  {
    const passkeys = require('./auth.ts');
    if (await passkeys.route(req, res, url, { send, readJson })) return;
    if (await passkeys.gate(req, res, url, { send })) return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, pageHtml(issuePageToken()), 'text/html; charset=utf-8');
  }
  // The destinations' names (nav.js DESTS) as URLs. A relative Location, so it
  // lands right under termhub's /pa/ too.
  const ALIAS: Record<string, string> = { '/ask': 'talk', '/plan': './', '/build': 'factory', '/map': 'architecture' };
  if (req.method === 'GET' && ALIAS[url.pathname]) {
    res.writeHead(302, { Location: ALIAS[url.pathname] + url.search, 'Cache-Control': 'no-store' });
    return res.end();
  }
  // The design system shared by every layer (theme.css) and the layer switcher
  // (nav.js). termhub serves byte copies of both; see the header of theme.css.
  if (req.method === 'GET' && (url.pathname === '/theme.css' || url.pathname === '/nav.js')) {
    const css = url.pathname === '/theme.css';
    return send(res, 200, fs.readFileSync(path.join(__dirname, css ? 'theme.css' : 'nav.js'), 'utf8'), css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
  }

  // ---- The voice page (dashboard/talk.js): /talk, its scripts, and
  // its models (/talk/models/), the local voice service's proxy, and
  // POST /api/talk/transcribe (X-PA guarded there). ----
  if (url.pathname === '/talk' || url.pathname.startsWith('/talk.') || url.pathname.startsWith('/talk/') || url.pathname.startsWith('/api/talk/')) {
    if (await require('./talk.ts').route(req, res, url, { send, issuePageToken })) return;
  }
  // ---- end voice page ----

  // ---- The Factory layer (dashboard/factory.js, factory.html): every factory
  // job from the worker's stored list, and its actions (X-PA guarded there). ----
  if (url.pathname === '/factory' || url.pathname === '/factory.js' || url.pathname === '/api/factory' || url.pathname.startsWith('/api/factory/')) {
    if (await require('./factory.ts').route(req, res, url, { send, readJson, issuePageToken, pageTokenOk })) return;
  }
  // ---- end Factory layer ----

  // ---- The live feed (dashboard/events.js): GET /api/events, an SSE stream of
  // board, run and factory changes with Last-Event-ID replay, and /events.js,
  // the pages' side of it. ----
  if (url.pathname === '/api/events' || url.pathname === '/events.js') {
    if (await require('./events.ts').route(req, res, url, { send })) return;
  }

  // ---- The architecture map (dashboard/architecture.js, architecture.json):
  // read-only page + GET /api/architecture[?health=1]. ----
  if (url.pathname === '/architecture' || url.pathname === '/architecture.client.js' || url.pathname === '/api/architecture') {
    if (await require('./architecture.ts').route(req, res, url, { send })) return;
  }

  // ---- Meter's data (dashboard/meter.js): GET /api/meter (latency per hop, spend,
  // the Claude credit pool) and POST /api/telemetry (the factory's spans and usage). ----
  if (url.pathname === '/api/meter' || url.pathname === '/api/telemetry') {
    if (await require('./meter.ts').route(req, res, url, { send, readJson })) return;
  }

  // The end state a Do would get, before it is pressed: the page shows it,
  // and must send it back as `confirmedLevel` to start an unattended one.
  let pm = req.method === 'GET' && url.pathname.match(/^\/api\/commitments\/(\d+)\/delivery$/);
  if (pm) {
    const D = require('../dispatch/deliveryCore');
    const q = url.searchParams;
    const delivery = q.get('delivery') || null;
    if (delivery && !D.isDelivery(delivery)) return send(res, 400, { error: 'unknown delivery' });
    const r = await require('../dispatch').previewDelivery({ commitmentId: Number(pm[1]), mode: q.get('mode') || undefined, delivery });
    return send(res, 200, { ...r, plain: r.delivery ? D.describe(r.delivery) : null, unattended: D.unattended(r.delivery) });
  }
  // What a typed follow-up time means, before it is set: the card previews it
  // with the same parser the chase uses (src/util/when.ts via chaseCore).
  // Which code this worker serves. Open pages poll it (nav.js) and reload
  // themselves once it changes, so an update reaches every open tab.
  if (req.method === 'GET' && url.pathname === '/healthz') {
    const ok = readiness.ready && !readiness.draining;
    return send(res, ok ? 200 : 503, { ready: ok, draining: readiness.draining, commit: servedCommit(), pid: process.pid });
  }
  if (req.method === 'GET' && url.pathname === '/api/version') {
    return send(res, 200, { commit: servedCommit() });
  }
  if (req.method === 'GET' && url.pathname === '/api/when') {
    const C = require('../durable/tasks/chaseCore');
    const canonical = C.cadenceAnswer(url.searchParams.get('text') || '');
    const when = canonical ? C.chaseAtFor(canonical, new Date()) : undefined;
    return send(res, 200, canonical && when ? { ok: true, canonical, at: when.toISOString() } : { ok: false });
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return send(res, 200, await state());
  }
  // Where a run can go: this machine, and each one in PA_MACHINES.
  if (req.method === 'GET' && url.pathname === '/api/machines') {
    return send(res, 200, {
      machines: [{ name: '', label: 'this machine' }, ...Object.keys(config.termhub.machines).map((name) => ({ name, label: name }))],
      modes: Object.keys(require('../dispatch/modes').MODES),
      defaultMode: require('../dispatch/modes').mode().name,
      // Where the work goes: a Claude session, the software factory, or let
      // the routing rule pick (src/dispatch/routeCore.js). Factory only when configured.
      routes: require('../dispatch/factory').enabled() ? ['claude', 'factory', 'auto'] : ['claude'],
      defaultRoute: require('../dispatch/factory').enabled() ? config.factory.via : 'claude',
      // The end states the operator may pick on Do (src/dispatch/deliveryCore.js);
      // none picked: the repo's default, else PA_DELIVERY_DEFAULT.
      deliveries: require('../dispatch/deliveryCore').DELIVERIES.map((d: string) => ({ value: d, plain: require('../dispatch/deliveryCore').describe(d) })),
      // On the factory route: the job's kind and runtime (JOBS-API v1.2).
      ...(require('../dispatch/factory').enabled() ? require('./factory.ts').pickers() : {}),
    });
  }
  // One commitment with what it came from, so it can be judged before it is
  // dispatched: the ask itself, the thread around it, and any runs so far.
  let cm = req.method === 'GET' && url.pathname.match(/^\/api\/commitments\/(\d+)$/);
  if (cm) return send(res, 200, await commitmentContext(Number(cm[1])));
  // The PA chat (src/chat): termhub's "PA chat" button asks for the session
  // and attaches to it. Starting a Claude Code session is an action, so it
  // takes the same X-PA guard as every other POST.
  if (req.method === 'POST' && url.pathname === '/api/chat/open') {
    if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    return send(res, 200, await require('../chat/feed').openChat());
  }
  // The chat box and the voice page talk to that same session
  // (src/chat/feed.js; contract in the README, "Talking to it").
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body: Row = await readJson(req);
    return send(res, 200, await require('../chat/feed').feed().send({ text: body.text, source: body.source || 'typed' }));
  }
  // Approve / Deny on the chat's permission prompt, from the Talk page. It
  // answers a prompt that may start work, so it needs the page's token as well
  // as X-PA, and src/chat/permission.js checks the screen before one keystroke.
  if (req.method === 'POST' && url.pathname === '/api/chat/permission') {
    if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    if (!pageTokenOk(req)) return send(res, 403, { error: 'answering a permission prompt needs the page token — reload the page' });
    const body: Row = await readJson(req);
    return send(res, 200, await require('../chat/feed').feed().answerPermission({ answer: body.answer, toolUseId: body.toolUseId, via: body.via === 'voice' ? 'voice' : 'dashboard' }));
  }
  // The worker's INBOX doorbell for the SDK chat (src/notify/chat.js): a
  // notification id only; the line typed is fixed (nudgeText), never content.
  if (req.method === 'POST' && url.pathname === '/api/chat/doorbell') {
    if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const f = require('../chat/feed');
    if (f.engine() !== 'sdk') return send(res, 409, { error: 'the doorbell endpoint is for the SDK engine' });
    const body: Row = await readJson(req);
    return send(res, 200, f.feed().doorbell(body.id, { minIdleMs: Number(body.minIdleMs) >= 0 ? Number(body.minIdleMs) : undefined }));
  }
  if (req.method === 'GET' && url.pathname === '/api/chat/history') {
    return send(res, 200, { messages: require('../chat/feed').feed().history(url.searchParams.get('limit') || 50) });
  }
  if (req.method === 'GET' && url.pathname === '/api/chat/session') {
    return send(res, 200, await require('../chat/feed').feed().session());
  }
  if (req.method === 'GET' && url.pathname === '/api/chat/stream') return chatStream(req, res);
  // The board's "Waiting for your yes" card (permission.client.js): the click
  // path for the chat's permission prompt; Talk answers it by voice.
  if (req.method === 'GET' && url.pathname === '/permission.js') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'permission.client.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/chat.js') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'chat.client.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/api/secrets') {
    const r = await require('../secrets').list();
    return send(res, 200, { secrets: r.secrets, pending: r.pending, vaultError: r.vaultError });
  }

  // Workflow cost ceilings (dashboard/workflowLimits.js): GET, and a POST behind X-PA there.
  if (url.pathname === '/api/workflow-limits') {
    if (await require('./workflowLimits.ts').route(req, res, url, { send, readJson })) return;
  }

  // The Memory tab (dashboard/memory.js). Same guards: a POST needs X-PA.
  if (url.pathname.startsWith('/api/memory/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body: Row = req.method === 'POST' ? await readJson(req) : {};
    const out = await require('./memory.ts').route(req.method, url, body);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
  }

  // Pre-meeting briefs (dashboard/meetings.js). Same guards.
  if (url.pathname.startsWith('/api/meetings/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body: Row = req.method === 'POST' ? await readJson(req) : {};
    const out = await require('./meetings.ts').route(req.method, url, body);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
  }

  // Post-meeting debriefs (dashboard/debriefs.js). Undo is a write: same guards.
  if (url.pathname === '/api/debriefs' || url.pathname.startsWith('/api/debriefs/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body: Row = req.method === 'POST' ? await readJson(req) : {};
    const out = await require('./debriefs.ts').route(req.method, url, body);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
  }

  // The Routines tab (dashboard/routines.js, routines.client.js). Its writes
  // run actions on this machine, so the same guards apply.
  if (req.method === 'GET' && url.pathname === '/routines.js') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'routines.client.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (url.pathname === '/api/routines' || url.pathname.startsWith('/api/routines/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body: Row = req.method === 'POST' ? await readJson(req) : {};
    const out = await require('./routines.ts').route(req.method, url, body);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
  }

  // ---- The Repos tab (dashboard/repos.js, repos.client.js): the repo registry. ----
  if (req.method === 'GET' && url.pathname === '/repos.js') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'repos.client.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (url.pathname === '/api/repos' || url.pathname.startsWith('/api/repos/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const out = await require('./repos.ts').route(req.method, url);
    if (out && out.error === 'not found') return send(res, 404, out);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out);
  }
  // ---- end Repos tab ----

  if (req.method === 'POST') {
    if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body: Row = await readJson(req);

    // A pasted secret goes from this body straight into the store. The reply
    // says where it went and never carries the value (AGENT.md, Secrets).
    let m = url.pathname.match(/^\/api\/secrets\/(\d+)\/(fulfil|decline|done)$/);
    if (m) {
      const secrets = require('../secrets');
      const id = Number(m[1]);
      if (m[2] === 'decline') return send(res, 200, { ok: true, ...(await secrets.decline(id)) });
      if (m[2] === 'done') return send(res, 200, { ok: true, ...(await secrets.loginDone(id)) });
      const target = body.target === 'env-file' ? 'env-file' : body.target ? 'credential-manager' : undefined;
      const r = await secrets.fulfil(id, typeof body.value === 'string' ? body.value : '', { target });
      return send(res, 200, { ok: r.ok, stored: r.stored, name: r.name });
    }

    // A thumb on a notification: moves how often its kind interrupts you.
    m = url.pathname.match(/^\/api\/notifications\/(\d+)\/feedback$/);
    if (m) {
      const value = body.value === 'up' || body.value === 'down' ? body.value : null;
      return send(res, 200, await require('../notify').feedback(Number(m[1]), value));
    }

    // A card's Claude session, opened in termhub on the machine it ran on:
    // the live session, or `claude --resume <id>` in its folder.
    m = url.pathname.match(/^\/api\/sessions\/(\d+)\/open$/);
    if (m) return send(res, 200, await require('./cards.ts').openSession(Number(m[1])));

    // The board's "+ task" box: a task because you typed it (src/commitments/request.js).
    if (url.pathname === '/api/tasks') {
      const request = require('../commitments/request');
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      try {
        const r = await request.add({ text: str(body.text), due: str(body.due), for: str(body.for), owedToMe: body.owedToMe === true, via: 'board' });
        return send(res, 200, { ok: true, id: r.id, text: request.describe(r) });
      } catch (e) {
        const err = e as HttpError;
        if (err.status === 400) return send(res, 400, { error: err.message });
        throw err;
      }
    }

    // Your call on what someone owes you: it blocks a task of yours, or not.
    m = url.pathname.match(/^\/api\/commitments\/(\d+)\/block$/);
    if (m) {
      try {
        return send(res, 200, await require('../commitments/blocks').set(Number(m[1]), {
          verdict: String(body.verdict), taskId: body.taskId == null ? null : Number(body.taskId),
        }));
      } catch (e) {
        const err = e as HttpError;
        if (err.status === 400) return send(res, 400, { error: err.message });
        throw err;
      }
    }

    m = url.pathname.match(/^\/api\/commitments\/(\d+)\/status$/);
    if (m) {
      const { setStatus } = require('../commitments.ts');
      return send(res, 200, await setStatus(Number(m[1]), String(body.status)));
    }
    // A proposal answered: yes/no, or the option picked for a question.
    m = url.pathname.match(/^\/api\/proposals\/(\d+)\/(accept|reject)$/);
    if (m) {
      const answer = typeof body.answer === 'string' ? body.answer.slice(0, 200) : null;
      // A dispatch card's end state, picked when accepting: one of the six
      // levels or nothing (the card's own); anything else is refused.
      const D = require('../dispatch/deliveryCore');
      const delivery = typeof body.delivery === 'string' && body.delivery ? body.delivery : null;
      if (delivery && !D.isDelivery(delivery)) return send(res, 400, { error: `unknown delivery "${delivery.slice(0, 40)}"` });
      if (m[2] === 'accept') {
        const p = await repo.proposals.kindAndPayload(Number(m[1]));
        const final = delivery || p?.payload?.delivery || null;
        if (p?.kind === 'dispatch' && D.unattended(final) && !pageTokenOk(req)) {
          return send(res, 403, { error: `accepting a card that ${final === 'push_to_main' ? 'pushes to main' : 'merges'} needs this page's token — reload the dashboard` });
        }
      }
      return send(res, 200, await require('../proposals').decide(Number(m[1]), { accept: m[2] === 'accept', answer, delivery }));
    }
    // A "Looks done?" card answered: accepting closes it as your decision.
    m = url.pathname.match(/^\/api\/ledger\/evidence\/(\d+)\/(accept|reject)$/);
    if (m) return send(res, 200, await require('../ledger/reconcile').decide(Number(m[1]), m[2] === 'accept'));
    m = url.pathname.match(/^\/api\/commitments\/(\d+)\/reply$/);
    if (m) {
      const draft = await require('../draft').composeReply(Number(m[1]));
      return send(res, 200, { id: draft.id });
    }
    m = url.pathname.match(/^\/api\/drafts\/(\d+)\/(edit|deliver|sent|discard)$/);
    if (m) {
      const drafts = require('../draft');
      const id = Number(m[1]);
      if (m[2] === 'edit') return send(res, 200, { id: (await drafts.edit(id, String(body.body || ''))).id });
      if (m[2] === 'discard') return send(res, 200, await drafts.discard(id));
      if (m[2] === 'sent') {
        const row = await drafts.markSent(id, { closeCommitment: body.close === true });
        return send(res, 200, { id: row.id, status: row.status });
      }
      const d = await drafts.delivery(id);
      return send(res, 200, { open: d.open, web: d.web, original: d.original || null, prefilled: d.prefilled, how: d.how, body: d.draft.body });
    }
    m = url.pathname.match(/^\/api\/commitments\/(\d+)\/dispatch$/);
    if (m) {
      const dispatch = require('../dispatch');
      const D = require('../dispatch/deliveryCore');
      const delivery = typeof body.delivery === 'string' && body.delivery ? body.delivery : null;
      if (delivery && !D.isDelivery(delivery)) return send(res, 400, { error: `unknown delivery "${delivery.slice(0, 40)}"` });
      // JOBS-API v1.2, on the factory route only: what kind of work, who does it.
      const F = require('../dispatch/factoryCore');
      let jobKind = null;
      let runtime = null;
      try {
        jobKind = typeof body.kind === 'string' && body.kind ? F.jobKind(body.kind) : null;
        runtime = typeof body.runtime === 'string' && body.runtime ? F.runtime(body.runtime) : null;
      } catch (e) {
        const err = e as HttpError;
        return send(res, 400, { error: err.message });
      }
      // A research/report job delivers its report only: nothing to confirm.
      const resolved = jobKind && jobKind !== 'code'
        ? { delivery: 'none' }
        // What the start will resolve to — a repo default included. Confirmed only
        // when the page showed exactly that level and sent it back, with its token.
        : await dispatch.previewDelivery({ commitmentId: Number(m[1]), mode: body.mode || undefined, delivery });
      const confirmed = D.unattended(resolved.delivery) && body.confirmedLevel === resolved.delivery && pageTokenOk(req);
      if (D.unattended(resolved.delivery) && !confirmed) {
        return send(res, 409, {
          error: `this would ${resolved.delivery === 'push_to_main' ? 'push straight to main' : 'merge automatically'} (${resolved.delivery}) — confirm that level on the page`,
          delivery: resolved.delivery,
          plain: D.describe(resolved.delivery),
        });
      }
      const run = await dispatch.start({
        commitmentId: Number(m[1]),
        mode: body.mode || undefined,
        machine: body.machine ? String(body.machine) : null,
        via: body.via ? String(body.via) : null,
        // The level the page confirmed, pinned: a repo default changing in
        // between cannot swap in another one.
        delivery: jobKind && jobKind !== 'code' ? null : confirmed ? resolved.delivery : delivery,
        confirmedUnattended: confirmed,
        jobKind,
        runtime,
      });
      return send(res, 200, {
        id: run.id, mode: run.mode, machine: run.machine || null, url: run.url, repoPath: run.repoPath,
        route: run.route || 'claude', routeReason: run.routeReason || null, jobId: run.jobId || null, delivery: run.delivery || null,
        jobKind: run.jobKind || null, runtime: run.runtime || null,
        warnings: run.warnings || [],
      });
    }
  }
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
