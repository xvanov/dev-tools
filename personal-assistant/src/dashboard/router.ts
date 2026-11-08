'use strict';

// The dashboard's one typed router (plan 4.1, docs/native/JARVISD.md stage 6).
//
// server.ts declares every route in one ordered table: a method (or any), a
// path (exact, a RegExp whose groups the handler reads as `c.m`, or a
// predicate), and a handler. The first route that matches and does not
// return `false` answers the request; `false` means "not mine after all, go
// on" (a module route such as talk.ts that only answers some of its paths, or
// a guard that let the request through). Order is the old if-chain's, so the
// table changes no behaviour.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS.

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;
type Route = import('./types.ts').Route;
type Path = import('./types.ts').Path;

function matchPath(path: Path, url: URL, req: Req): RegExpMatchArray | true | null {
  if (typeof path === 'string') return url.pathname === path ? true : null;
  if (path instanceof RegExp) return url.pathname.match(path);
  return path(url, req) ? true : null;
}

/**
 * Runs the table for one request. Resolves true when a route answered, false
 * when none did (the caller answers 404).
 */
async function dispatch(routes: Route[], base: Ctx & { req: Req; res: Res; url: URL }): Promise<boolean> {
  let body: Promise<Row> | null = null;
  const readBody = () => (body ||= base.readJson(base.req));
  for (const r of routes) {
    if (r.method && r.method !== base.req.method) continue;
    const hit = matchPath(r.path, base.url, base.req);
    if (!hit) continue;
    const out = await r.handle({ ...base, m: hit === true ? null : hit, body: readBody });
    if (out !== false) return true;
  }
  return false;
}

module.exports = { dispatch, matchPath };
