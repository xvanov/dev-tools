'use strict';

// The dashboard: one page over the same data `pa brief` reads, plus the three
// buttons worth having — done, dismiss, and dispatch.
//
// It can start agents, so it inherits the dispatcher's trust model (AGENT.md):
// loopback only, never tailnet-reachable. Two more guards, because "loopback"
// does not stop a web page in your own browser from talking to it:
//
//  - the Host header must be a loopback name, which defeats DNS rebinding;
//  - every POST must carry `X-PA: 1`. A custom header forces a CORS preflight,
//    which this server never answers, so no other origin can forge a click.
//
// There is no send button, by design. Drafts are shown with a copy button;
// `pa send` stays the only outbound path and stays interactive.

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

async function state() {
  const { gather } = require('../brief');
  const data = await gather({ horizonDays: 7 });
  const drafts = await rows(
    `select d.id, d.run_id, d.channel, d.to_identity, d.subject, d.body, d.status, d.created_at, r.task
       from draft d left join run r on r.id = d.run_id
      where d.status in ('pending','edited')
      order by d.created_at desc limit 20`
  );
  const sources = await rows(
    `select source, last_run_at, last_error from sync_cursor order by source`
  );
  return { ...data, drafts, sources, now: new Date().toISOString() };
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

  if (req.method === 'POST') {
    if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
    const body = await readJson(req);

    let m = url.pathname.match(/^\/api\/commitments\/(\d+)\/status$/);
    if (m) {
      const { setStatus } = require('../commitments');
      return send(res, 200, await setStatus(Number(m[1]), String(body.status)));
    }
    m = url.pathname.match(/^\/api\/commitments\/(\d+)\/dispatch$/);
    if (m) {
      const dispatch = require('../dispatch');
      const run = await dispatch.start({ commitmentId: Number(m[1]), mode: body.mode || undefined });
      return send(res, 200, { id: run.id, mode: run.mode, url: run.url, repoPath: run.repoPath });
    }
  }
  return send(res, 404, { error: 'not found' });
}

function start({ port = config.dispatch.port, host = config.dispatch.host } = {}) {
  if (!hostAllowed(host)) throw new Error(`refusing to bind the dashboard to ${host}: loopback only`);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.warn('request failed', { path: req.url, message: err.message });
      send(res, 500, { error: err.message });
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
