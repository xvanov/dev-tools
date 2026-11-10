'use strict';

// Build's Board view (plan 8.8.2): the factory at a glance and one step's
// turns, read from the factory's JOBS-API v1.11 verbs.
//
//   GET /api/factory/board                       `factory job board --json`, cached 2 s here
//   GET /api/factory/steps/<id>/events?cursor=&limit=&wait=&at=
//                                                `factory job step <id> --json ...`
//
// Both go through dispatch/factory.call: `factory serve` on this machine
// (warm, milliseconds; the step read's `wait` is a long poll there, so a live
// step streams with no timer re-reading anything), else the CLI. Every query
// value is checked here before it becomes one argv element. The events are
// agent-written text: the page builds them with textContent only.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = Record<string, any>;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;
type CallFn = (sub: string[], opts?: { timeoutMs?: number }) => Promise<Json>;

const STEP_ID = /^\d{1,12}$/;
const CURSOR = /^\d{1,4}:\d{1,15}$/;
const MAX_WAIT_S = 20;
const BOARD_TTL_MS = 2000;

let callOverride: CallFn | null = null;
function call(sub: string[], opts?: { timeoutMs?: number }): Promise<Json> {
  if (callOverride) return callOverride(sub, opts);
  return require('../dispatch/factory.ts').call(sub, opts);
}
/** Tests: replace the factory call (null restores it). */
function _setCall(fn: CallFn | null): void {
  callOverride = fn;
  cache = null;
}

/** Pure. The step route's path -> step id, or null. */
function stepPath(pathname: unknown): string | null {
  const m = /^\/api\/factory\/steps\/([^/]+)\/events$/.exec(String(pathname || ''));
  return m && STEP_ID.test(m[1] ?? '') ? (m[1] as string) : null;
}

/**
 * Pure. `factory job step` argv from the query, or throws a 400. `wait` is
 * clamped to 0..20 s; a cursor and `at` are `<file>:<offset>`.
 */
function stepArgv(id: string, q: URLSearchParams): { argv: string[]; waitS: number } {
  const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
  if (!STEP_ID.test(id)) throw bad('not a step id');
  const argv = ['job', 'step', id, '--json'];
  const at = q.get('at');
  if (at) {
    if (!CURSOR.test(at)) throw bad('at is <file>:<offset>');
    return { argv: [...argv, '--at', at], waitS: 0 };
  }
  const cursor = q.get('cursor');
  if (cursor) {
    if (!CURSOR.test(cursor)) throw bad('a cursor is <file>:<offset>');
    argv.push('--cursor', cursor);
  }
  const limit = q.get('limit');
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw bad('limit is 1..1000');
    argv.push('--limit', String(n));
  }
  let waitS = 0;
  const wait = q.get('wait');
  if (wait) {
    const n = Number(wait);
    if (!Number.isFinite(n) || n < 0) throw bad('wait is seconds');
    waitS = Math.min(MAX_WAIT_S, Math.floor(n));
    if (waitS > 0) argv.push('--wait', String(waitS));
  }
  return { argv, waitS };
}

// One board read at a time; a burst of page loads (every live event of every
// open Build tab) shares it, and an answer up to 2 s old is answered as is.
let cache: { at: number; body: Json } | null = null;
let inflight: Promise<Json> | null = null;
async function board(now: number = Date.now()): Promise<Json> {
  const factory = require('../dispatch/factory.ts');
  if (!callOverride && !factory.enabled()) return { enabled: false };
  if (cache && now - cache.at < BOARD_TTL_MS) return cache.body;
  if (!inflight) {
    inflight = call(['job', 'board', '--json'], { timeoutMs: 20_000 })
      .then((b) => {
        const body = { enabled: true, ...b };
        cache = { at: Date.now(), body };
        return body;
      })
      .catch((err: Error & { code?: string }) => {
        // A factory from before v1.11 has no `job board`: the page says so.
        const old = err?.code === 'unsupported_command' || /no such command|not allowed/i.test(String(err?.message));
        return { enabled: true, error: old ? 'this factory has no `job board` (JOBS-API v1.11): update it' : String(err?.message || err) };
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

async function stepEvents(id: string, q: URLSearchParams): Promise<{ status: number; body: Json }> {
  const { argv, waitS } = stepArgv(id, q);
  try {
    return { status: 200, body: await call(argv, { timeoutMs: (waitS + 15) * 1000 }) };
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err?.code === 'not_found') return { status: 404, body: { error: 'not_found', message: err.message } };
    if (err?.code === 'invalid_cursor' || err?.code === 'invalid_step_id') return { status: 400, body: { error: err.code, message: err.message } };
    return { status: 502, body: { error: err?.code || 'factory', message: String(err?.message || err) } };
  }
}

async function route(req: Req, res: Res, url: URL, { send }: { send: Ctx['send'] }): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/factory/board') {
    send(res, 200, await board());
    return true;
  }
  if (url.pathname.startsWith('/api/factory/steps/')) {
    const id = stepPath(url.pathname);
    if (!id) {
      send(res, 400, { error: 'not a step id' });
      return true;
    }
    const r = await stepEvents(id, url.searchParams);
    send(res, r.status, r.body);
    return true;
  }
  return false;
}

module.exports = { route, board, stepEvents, stepArgv, stepPath, _setCall };
