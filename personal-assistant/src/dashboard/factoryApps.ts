'use strict';

// The Build page's Repos section: the repos registered with the factory, their
// gates, delivery and pipeline defaults and gate readiness; add a repo; edit it.
//
//   GET  /api/factory/apps            the registered apps, from the PA's cached `factory app list`
//                                     (answers at once; ?fresh=1 asks the factory)
//   GET  /api/factory/apps/<app>      `factory app show <app>`: gates, readiness and the gates
//                                     detection suggests (incl. ones mirrored from the repo's CI)
//   POST /api/factory/apps            {repo, path?, delivery?} -> `factory app add`
//   POST /api/factory/apps/<app>      {delivery?, pipeline?, gates?: {test: "cmd"|"none"|""},
//                                      requires?: {test: ["lychee"]}} -> `factory app set`
//
// A gate is a shell command, `none` (the repo has no such check: skipped) or ""
// (not configured). Commands go to the factory as one argv element each
// (`--gate=test=<cmd>`), never through a shell here. POSTs are behind the
// dashboard's guards (loopback, X-PA), checked by factory.ts before this runs.
// Apps' configs stay on the factory machine (apps/<app>/ is local-only).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;

const APP = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const GATES = ['lint', 'format_check', 'type_check', 'test'];
const PIPELINES = ['chain', 'solo', 'auto'];
const MAX_CMD = 2000;

function bad(msg: string): Error {
  return Object.assign(new Error(msg), { status: 400 });
}

/** Pure. One gate command: a line of text, `none`, or "" (unset). */
function gateValue(gate: string, v: unknown): string {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(`gate ${gate}: a command, "none" or empty`);
  const s = v.trim();
  if (/[\r\n\0]/.test(s)) throw bad(`gate ${gate}: one line (join commands with &&)`);
  if (s.length > MAX_CMD) throw bad(`gate ${gate}: at most ${MAX_CMD} characters`);
  return s.toLowerCase() === 'none' ? 'none' : s;
}

/** Pure. A gate's required tools: a list or "a, b". */
function toolList(gate: string, v: unknown): string[] {
  const items = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out = items.map((t) => String(t).trim()).filter(Boolean);
  for (const t of out) if (!TOOL.test(t)) throw bad(`requires.${gate}: "${t}" is not a program name`);
  return [...new Set(out)];
}

/** Pure. The edit form, checked, as `factory app set` argv — or throws a 400. */
function setArgv(app: string, body: Json): string[] {
  if (!APP.test(String(app || ''))) throw bad('not an app name');
  const D = require('../dispatch/deliveryCore.ts');
  const argv = ['app', 'set', app, '--json'];
  if (body?.delivery) {
    if (!D.isDelivery(body.delivery)) throw bad(`unknown delivery "${body.delivery}"`);
    argv.push(`--delivery-default=${body.delivery}`);
  }
  if (body?.pipeline) {
    if (!PIPELINES.includes(body.pipeline)) throw bad(`pipeline is one of ${PIPELINES.join(', ')}`);
    argv.push(`--pipeline-default=${body.pipeline}`);
  }
  const gates = body?.gates && typeof body.gates === 'object' ? body.gates : {};
  for (const [gate, v] of Object.entries(gates)) {
    if (!GATES.includes(gate)) throw bad(`unknown gate "${gate}"`);
    argv.push(`--gate=${gate}=${gateValue(gate, v)}`);
  }
  const requires = body?.requires && typeof body.requires === 'object' ? body.requires : {};
  for (const [gate, v] of Object.entries(requires)) {
    if (!GATES.includes(gate)) throw bad(`unknown gate "${gate}"`);
    argv.push(`--requires=${gate}=${toolList(gate, v).join(',')}`);
  }
  if (argv.length === 4) throw bad('nothing to change');
  return argv;
}

/** Pure. The add form, checked: {repo, path, delivery}. */
function addInput(body: Json): { repo: string; path: string | null; deliveryDefault: string | null } {
  const repo = String(body?.repo || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!SLUG.test(repo)) throw bad('a repo is owner/name');
  const p = typeof body?.path === 'string' ? body.path.trim() : '';
  if (/[\r\n\0]/.test(p) || p.length > 500) throw bad('one local path');
  const delivery = typeof body?.delivery === 'string' && body.delivery ? body.delivery : null;
  if (delivery && !require('../dispatch/deliveryCore.ts').isDelivery(delivery)) throw bad(`unknown delivery "${delivery}"`);
  return { repo, path: p || null, deliveryDefault: delivery };
}

/** Pure. A row of `app list` as the page shows it (an old factory's rows have no gates). */
function row(a: Json): Json {
  if (a?.error) return { app: a.app, error: String(a.error) };
  const r = a?.readiness || null;
  return {
    app: a.app,
    repo: a.repo,
    path: a.path,
    delivery: a.delivery?.default || null,
    pipeline: a.pipeline_default || null,
    ticked: a.ticked ?? null,
    gates: a.gates || null,
    readiness: r ? { status: r.status, blocking: r.blocking || null, warnings: r.warnings || [], missingTools: r.missing_tools || {} } : null,
  };
}

function pickers(): Json {
  const D = require('../dispatch/deliveryCore.ts');
  return {
    deliveries: D.DELIVERIES.map((d: string) => ({ value: d, plain: D.describe(d) })),
    pipelines: PIPELINES,
    gates: GATES,
  };
}

async function list(fresh: boolean): Promise<Json> {
  const factory = require('../dispatch/factory.ts');
  if (!factory.enabled()) return { enabled: false, apps: [], ...pickers() };
  const apps = await factory.apps(fresh ? { fresh: true } : { stale: true });
  return { enabled: true, apps: apps.map(row), ...pickers() };
}

/** Errors from the factory come back as a 400 with its message, not a 500. */
async function factoryCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as Error & { code?: string; status?: number };
    if (e.status) throw e;
    throw Object.assign(new Error(e.message), { status: e.name === 'FactoryError' ? 400 : 502, code: e.code });
  }
}

function appFromPath(pathname: string): string | null {
  const m = /^\/api\/factory\/apps\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  let app = '';
  try {
    app = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return APP.test(app) ? app : null;
}

/** GET /api/factory/apps[/<app>]: the answer, or undefined when not ours. */
async function get(url: URL): Promise<Json | undefined> {
  if (url.pathname === '/api/factory/apps') return list(url.searchParams.get('fresh') === '1');
  if (!url.pathname.startsWith('/api/factory/apps/')) return undefined;
  const app = appFromPath(url.pathname);
  if (!app) throw bad('not an app name');
  const factory = require('../dispatch/factory.ts');
  return factoryCall(() => factory.call(['app', 'show', app, '--json']));
}

/** POST /api/factory/apps[/<app>]: the answer, or undefined when not ours. */
async function post(pathname: string, body: Json): Promise<Json | undefined> {
  const factory = require('../dispatch/factory.ts');
  if (pathname === '/api/factory/apps') {
    const input = addInput(body);
    const r = await factoryCall(() => factory.addApp(input));
    return r;
  }
  if (!pathname.startsWith('/api/factory/apps/')) return undefined;
  const app = appFromPath(pathname);
  if (!app) throw bad('not an app name');
  const r = await factoryCall(() => factory.call(setArgv(app, body)));
  await factory.forgetApps();
  return r;
}

module.exports = { get, post, setArgv, addInput, row, gateValue, toolList };
