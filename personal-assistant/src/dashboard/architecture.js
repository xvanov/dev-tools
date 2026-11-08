'use strict';

// The architecture map (/architecture): the whole system as one diagram,
// rendered in the browser from ./architecture.json, with live health dots.
//
//   GET /architecture                 the page (architecture.html)
//   GET /architecture.client.js       its script
//   GET /api/architecture             the JSON, plus `live` (non-secret config values)
//   GET /api/architecture?health=1    { health: { <check id>: {state, ms, detail} } }
//
// Health is a separate request so the diagram never waits on a probe. Every
// check is a short-timeout local probe (loopback, or the factory machine's
// termhub from PA_MACHINES), run in parallel and cached for a few seconds.
// The checks are declared in the JSON but resolved here: a check names a
// config key or a loopback URL, never an arbitrary host.
//
// Read-only: no POST, so no X-PA guard is needed. The page renders the JSON
// with textContent only (no HTML sink).

const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');
const { config } = require('../config');
const platform = require('../platform');

const PAGE = path.join(__dirname, 'architecture.html');
const CLIENT = path.join(__dirname, 'architecture.client.js');
const DATA = path.join(__dirname, 'architecture.json');
const TIMEOUT_MS = 1200;
const CACHE_MS = 5000;

function load() {
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}

function pick(obj, dotted) {
  return String(dotted || '').split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function isLoopback(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

/** Pure. A check's target: { kind, url } | { kind, host, port } | { kind } | { error }. */
function resolveCheck(check, cfg = config) {
  if (!check || typeof check !== 'object') return { error: 'no check' };
  if (check.kind === 'self' || check.kind === 'postgres') return { kind: check.kind };
  if (check.kind === 'tcp') {
    const host = pick(cfg, check.hostConfig);
    const port = Number(pick(cfg, check.portConfig));
    if (!host || !port) return { error: 'not configured' };
    if (!isLoopback(`http://${host}`)) return { error: 'not loopback' };
    return { kind: 'tcp', host, port };
  }
  if (check.kind === 'http') {
    let base = check.url || pick(cfg, check.config);
    if (!base) return { error: 'not configured' };
    if (check.origin) base = new URL(base).origin;
    const url = String(base).replace(/\/+$/, '') + (check.path || '');
    if (!isLoopback(url)) return { error: 'not loopback' };
    return { kind: 'http', url };
  }
  if (check.kind === 'machine') {
    const name = pick(cfg, 'factory.machine');
    if (!name) return pick(cfg, 'factory.path') ? { kind: 'self' } : { error: 'no factory configured' };
    const m = (pick(cfg, 'dispatch.machines') || {})[name];
    const base = m && (m.url || m.termhub);
    if (!base) return { error: `machine ${name} not in PA_MACHINES` };
    return { kind: 'http', url: String(base).replace(/\/+$/, '') + '/api/health', remote: true };
  }
  return { error: `unknown check kind ${check.kind}` };
}

function probeHttp(url, timeoutMs) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300 ? { state: 'ok', detail: `HTTP ${res.statusCode}` } : { state: 'down', detail: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ state: 'down', detail: err.code || err.message }));
  });
}

function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (r) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => done({ state: 'down', detail: 'timed out' }));
    sock.once('connect', () => done({ state: 'ok', detail: `listening on ${port}` }));
    sock.once('error', (err) => done({ state: 'down', detail: err.code || err.message }));
  });
}

async function probePostgres(timeoutMs) {
  const timer = new Promise((resolve) => setTimeout(() => resolve({ state: 'down', detail: 'timed out' }), timeoutMs).unref());
  const q = Promise.resolve()
    .then(() => require('../repo').system.ping())
    .then(() => ({ state: 'ok', detail: 'select 1' }))
    .catch((err) => ({ state: 'down', detail: err.code || err.message }));
  return Promise.race([q, timer]);
}

async function runCheck(check, { cfg = config, timeoutMs = TIMEOUT_MS } = {}) {
  const t = resolveCheck(check, cfg);
  const started = Date.now();
  let r;
  if (t.error) r = { state: 'unknown', detail: t.error };
  else if (t.kind === 'self') r = { state: 'ok', detail: 'answering' };
  else if (t.kind === 'postgres') r = await probePostgres(timeoutMs);
  else if (t.kind === 'tcp') r = await probeTcp(t.host, t.port, timeoutMs);
  else r = await probeHttp(t.url, t.remote ? timeoutMs * 2 : timeoutMs);
  return { ...r, ms: Date.now() - started };
}

let cached = null;
async function health({ now = Date.now() } = {}) {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const checks = load().health || {};
  const ids = Object.keys(checks);
  const results = await Promise.all(ids.map((id) => runCheck(checks[id]).catch((err) => ({ state: 'unknown', detail: err.message }))));
  const value = { at: new Date(now).toISOString(), health: Object.fromEntries(ids.map((id, i) => [id, { label: checks[id].label || id, ...results[i] }])) };
  cached = { at: now, value };
  return value;
}

/** Pure. The configured values worth showing next to the diagram; never a secret. */
function liveConfig(cfg = config) {
  let db = null;
  try {
    if (cfg.db === 'sqlite') db = `sqlite:${cfg.sqlitePath}`;
    else {
      const u = new URL(cfg.databaseUrl);
      db = `${u.hostname}:${u.port}${u.pathname}`;
    }
  } catch {
    db = null;
  }
  return {
    // Which stack this dashboard belongs to (health dots apply to it only).
    // PA_ARCH_STACK overrides; today the PA is installed only on the Windows
    // work laptop, so Windows means work.
    stack: process.env.PA_ARCH_STACK || (platform.id === 'windows' ? 'work' : 'personal'),
    machine: require('os').hostname(),
    platform: platform.id,
    chatAgent: pick(cfg, 'chat.agent') || 'claude',
    chatModel: pick(cfg, 'chat.model') || "Claude Code's default",
    fastModel: pick(cfg, 'fastLane.model') || null,
    fastFallback: pick(cfg, 'fastLane.fallback') || null,
    distillModel: pick(cfg, 'anthropic.model') || null,
    dispatchVia: pick(cfg, 'factory.via') || null,
    factoryMachine: pick(cfg, 'factory.machine') || (pick(cfg, 'factory.path') ? 'this machine' : null),
    factoryPath: pick(cfg, 'factory.path') || null,
    factoryRuntime: pick(cfg, 'factory.runtime') || null,
    factoryPipeline: pick(cfg, 'factory.pipeline') || null,
    termhub: pick(cfg, 'termhub.url') || null,
    voice: pick(cfg, 'voice.url') || null,
    database: db,
    dashboard: `http://${pick(cfg, 'dispatch.host')}:${pick(cfg, 'dispatch.port')}`,
  };
}

async function route(req, res, url, { send }) {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/architecture') {
    send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
    return true;
  }
  if (url.pathname === '/architecture.client.js') {
    send(res, 200, fs.readFileSync(CLIENT, 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  if (url.pathname === '/api/architecture') {
    if (url.searchParams.get('health') === '1') send(res, 200, await health());
    else send(res, 200, { ...load(), live: liveConfig() });
    return true;
  }
  return false;
}

module.exports = { route, load, resolveCheck, runCheck, health, liveConfig, isLoopback };
