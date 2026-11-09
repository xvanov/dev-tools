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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;

/** A health check from architecture.json. */
type Check = { kind?: string; hostConfig?: string; portConfig?: string; url?: string; config?: string; origin?: boolean; path?: string; label?: string; headers?: Record<string, string> };
/** What resolveCheck() makes of one. */
type Target = { error: string } | { kind: 'self' } | { kind: 'postgres' } | { kind: 'tcp'; host: unknown; port: number } | { kind: 'http'; url: string; remote?: boolean; headers?: Record<string, string> };
type Probe = { state: string; detail: string };
type NetError = Error & { code?: string };

const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');
const { config } = require('../config.ts');
const platform = require('../platform');

const PAGE = path.join(__dirname, 'architecture.html');
const CLIENT = path.join(__dirname, 'architecture.client.js');
const DATA = path.join(__dirname, 'architecture.json');
const TIMEOUT_MS = 1200;
const CACHE_MS = 5000;

function load() {
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}

function pick(obj: unknown, dotted: unknown): unknown {
  return String(dotted || '').split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Row)[k]), obj);
}

function isLoopback(u: unknown) {
  try {
    const h = new URL(u as string).hostname.replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

/** Pure. A check's target: { kind, url } | { kind, host, port } | { kind } | { error }. */
function resolveCheck(check: Check | null | undefined, cfg: unknown = config): Target {
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
    if (check.origin) base = new URL(base as string).origin;
    const url = String(base).replace(/\/+$/, '') + (check.path || '');
    if (!isLoopback(url)) return { error: 'not loopback' };
    // headers: factory serve's /api/health refuses a GET without X-Factory.
    return check.headers ? { kind: 'http', url, headers: check.headers } : { kind: 'http', url };
  }
  if (check.kind === 'machine') {
    const name = pick(cfg, 'factory.machine');
    // Empty or "local" is this machine's factory (PA_FACTORY_MACHINE=local), not a PA_MACHINES entry.
    if (!name || String(name).toLowerCase() === 'local') return pick(cfg, 'factory.path') ? { kind: 'self' } : { error: 'no factory configured' };
    const m = ((pick(cfg, 'dispatch.machines') || {}) as Record<string, { url?: string; termhub?: string } | undefined>)[String(name)];
    const base = m && (m.url || m.termhub);
    if (!base) return { error: `machine ${name} not in PA_MACHINES` };
    return { kind: 'http', url: String(base).replace(/\/+$/, '') + '/api/health', remote: true };
  }
  return { error: `unknown check kind ${check.kind}` };
}

function probeHttp(url: string, timeoutMs: number, headers?: Record<string, string>) {
  return new Promise<Probe>((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const opts: { timeout: number; headers?: Record<string, string> } = { timeout: timeoutMs };
    if (headers) opts.headers = headers;
    const req = lib.get(url, opts, (res: import('http').IncomingMessage) => {
      res.resume();
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300 ? { state: 'ok', detail: `HTTP ${res.statusCode}` } : { state: 'down', detail: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err: NetError) => resolve({ state: 'down', detail: err.code || err.message }));
  });
}

function probeTcp(host: unknown, port: number, timeoutMs: number) {
  return new Promise<Probe>((resolve) => {
    const sock = net.connect({ host, port });
    const done = (r: Probe) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => done({ state: 'down', detail: 'timed out' }));
    sock.once('connect', () => done({ state: 'ok', detail: `listening on ${port}` }));
    sock.once('error', (err: NetError) => done({ state: 'down', detail: err.code || err.message }));
  });
}

async function probePostgres(timeoutMs: number) {
  const timer = new Promise<Probe>((resolve) => setTimeout(() => resolve({ state: 'down', detail: 'timed out' }), timeoutMs).unref());
  const q = Promise.resolve()
    .then(() => require('../repo').system.ping())
    .then(() => ({ state: 'ok', detail: 'select 1' }))
    .catch((err: NetError) => ({ state: 'down', detail: err.code || err.message }));
  return Promise.race([q, timer]);
}

async function runCheck(check: Check | null | undefined, { cfg = config, timeoutMs = TIMEOUT_MS }: { cfg?: unknown; timeoutMs?: number } = {}) {
  const t = resolveCheck(check, cfg);
  const started = Date.now();
  let r: Probe;
  if ('error' in t) r = { state: 'unknown', detail: t.error };
  else if (t.kind === 'self') r = { state: 'ok', detail: 'answering' };
  else if (t.kind === 'postgres') r = await probePostgres(timeoutMs);
  else if (t.kind === 'tcp') r = await probeTcp(t.host, t.port, timeoutMs);
  else r = await probeHttp(t.url, t.remote ? timeoutMs * 2 : timeoutMs, t.headers);
  return { ...r, ms: Date.now() - started };
}

let cached: { at: number; value: { at: string; health: Record<string, unknown> } } | null = null;
async function health({ now = Date.now() }: { now?: number } = {}) {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const checks = load().health || {};
  const ids = Object.keys(checks);
  const results = await Promise.all(ids.map((id) => runCheck(checks[id]).catch((err: Error) => ({ state: 'unknown', detail: err.message }))));
  const value = { at: new Date(now).toISOString(), health: Object.fromEntries(ids.map((id, i) => [id, { label: checks[id].label || id, ...results[i] }])) };
  cached = { at: now, value };
  return value;
}

/** Pure. The configured values worth showing next to the diagram; never a secret. */
function liveConfig(cfg: Row = config) {
  let db: string | null = null;
  try {
    if (cfg.db === 'sqlite') db = `sqlite:${cfg.sqlitePath}`;
    else {
      const u = new URL(cfg.databaseUrl as string);
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

async function route(req: Req, res: Res, url: URL, { send }: { send: Ctx['send'] }) {
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
