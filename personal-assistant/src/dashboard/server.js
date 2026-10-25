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
// Its Needs-you panel answers secret requests (src/secrets). A pasted value
// arrives in one POST, goes straight to Credential Manager or `.env`, and the
// reply is `{ok, stored, name}`. No route here returns a value.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { config } = require('../config');
const { rows } = require('../db');
const { logger } = require('../log');

const log = logger('dashboard');
const PAGE = path.join(__dirname, 'index.html');

function hostAllowed(host) {
  const name = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

async function commitmentContext(id) {
  const { one } = require('../db');
  const c = await one(
    `select c.id, c.direction, c.status, c.summary, c.detail, c.due_at, c.repo_path, c.project_rationale,
            p.name as project, per.display_name as who,
            si.source, si.subject, si.occurred_at, si.thread_external_id, si.author_identity,
            left(si.body_text, 4000) as body, si.raw->>'webUrl' as web_url, si.raw->>'webLink' as web_link
       from commitment c
       left join project p on p.id = c.project_id
       left join person per on per.id = c.counterparty_person_id
       join source_item si on si.id = c.source_item_id
      where c.id = $1`,
    [id]
  );
  if (!c) return { error: `no commitment #${id}` };
  const thread = c.thread_external_id
    ? await rows(
        `select id, author_identity, occurred_at, left(body_text, 600) as body from source_item
          where thread_external_id = $1 order by occurred_at desc limit 12`,
        [c.thread_external_id]
      )
    : [];
  const termhub = require('../dispatch/termhub');
  const runs = (
    await rows(
      `select id, status, mode, machine, branch, started_at, termhub_session_id from run
        where commitment_id = $1 order by started_at desc`,
      [id]
    )
  ).map((r) => ({
    ...r,
    url: r.termhub_session_id ? `${termhub.forMachine(r.machine).base}/?session=${encodeURIComponent(r.termhub_session_id)}` : null,
  }));
  return { ...c, thread: thread.reverse(), runs };
}

async function state() {
  const { gather } = require('../brief');
  const data = await gather({ horizonDays: 7 });
  const drafts = await rows(
    `select d.id, d.run_id, d.commitment_id, d.channel, d.to_identity, d.subject, d.body, d.status,
            d.origin, d.created_at, r.task, c.summary as ask, si.raw->>'webUrl' as ask_url,
            si.raw->>'webLink' as ask_link, si.body_text as ask_text
       from draft d
       left join run r on r.id = d.run_id
       left join commitment c on c.id = d.commitment_id
       left join source_item si on si.id = d.source_item_id
      where d.status in ('pending','edited')
      order by d.created_at desc limit 30`
  );
  const health = require('../ingest/health');
  const sources = await health.sources();
  // Sources that keep failing: the board cannot see what was settled there.
  const blind = health.blind(sources);
  // The Memory tab's badge: claims waiting for a human to vouch for them.
  const review = await rows(`select count(*)::int as n from claim where status = 'pending_review'`).catch(() => [{ n: 0 }]);
  const closed = await require('../commitments').recentlyClosed().catch(() => []);
  // Closes the reconciler was not sure enough to make on its own (src/ledger/reconcile.js).
  const looksDone = await require('../ledger/reconcile').proposals().catch(() => []);
  // Secret and login requests: names and guidance only — the table holds no values.
  const secretRequests = await require('../secrets').pending().catch(() => []);
  return { ...data, drafts, sources, blind, closed, looksDone, memoryPending: review[0].n, secretRequests, now: new Date().toISOString() };
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
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

async function handle(req, res) {
  if (!hostAllowed(req.headers.host)) return send(res, 403, { error: 'host not allowed' });
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
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
    return send(res, 200, await require('../chat').ensureSession());
  }
  if (req.method === 'GET' && url.pathname === '/api/secrets') {
    const r = await require('../secrets').list();
    return send(res, 200, { secrets: r.secrets, pending: r.pending, vaultError: r.vaultError });
  }

  // The Memory tab (dashboard/memory.js). Same guards: a POST needs X-PA.
  if (url.pathname.startsWith('/api/memory/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body = req.method === 'POST' ? await readJson(req) : {};
    const out = await require('./memory').route(req.method, url, body);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
  }

  // Pre-meeting briefs (dashboard/meetings.js). Same guards.
  if (url.pathname.startsWith('/api/meetings/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body = req.method === 'POST' ? await readJson(req) : {};
    const out = await require('./meetings').route(req.method, url, body);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
  }

  // Post-meeting debriefs (dashboard/debriefs.js). Undo is a write: same guards.
  if (url.pathname === '/api/debriefs' || url.pathname.startsWith('/api/debriefs/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body = req.method === 'POST' ? await readJson(req) : {};
    const out = await require('./debriefs').route(req.method, url, body);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
  }

  // The Routines tab (dashboard/routines.js, routines.client.js). Its writes
  // run actions on this machine, so the same guards apply.
  if (req.method === 'GET' && url.pathname === '/routines.js') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'routines.client.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (url.pathname === '/api/routines' || url.pathname.startsWith('/api/routines/')) {
    if (req.method === 'POST' && req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body = req.method === 'POST' ? await readJson(req) : {};
    const out = await require('./routines').route(req.method, url, body);
    return out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out ?? null);
  }

  if (req.method === 'POST') {
    if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body = await readJson(req);

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

    m = url.pathname.match(/^\/api\/commitments\/(\d+)\/status$/);
    if (m) {
      const { setStatus } = require('../commitments');
      return send(res, 200, await setStatus(Number(m[1]), String(body.status)));
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
      const run = await dispatch.start({
        commitmentId: Number(m[1]),
        mode: body.mode || undefined,
        machine: body.machine ? String(body.machine) : null,
      });
      return send(res, 200, { id: run.id, mode: run.mode, machine: run.machine || null, url: run.url, repoPath: run.repoPath });
    }
  }
  return send(res, 404, { error: 'not found' });
}

function start({ port = config.dispatch.port, host = config.dispatch.host } = {}) {
  if (!hostAllowed(host)) throw new Error(`refusing to bind the dashboard to ${host}: loopback only`);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.warn('request failed', { path: String(req.url).split('?')[0], message: err.message });
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.info('listening', { url: `http://${host}:${port}/` });
      resolve(server);
    });
  });
}

module.exports = { start, hostAllowed, state };
