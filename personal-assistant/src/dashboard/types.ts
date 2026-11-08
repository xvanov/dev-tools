// Types for the dashboard's server modules (plan 4.1). Types only: no module
// requires this file at runtime; they bring its types in by type query,
// `type Ctx = import('./types.ts').Ctx;` (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;

export type Req = import('http').IncomingMessage;
export type Res = import('http').ServerResponse;

/** server.js's send(): writes a JSON (or `type`) response. */
export type Send = (res: Res, status: number, body: unknown, type?: string) => unknown;

/** What server.js hands a route module. */
export interface Ctx {
  send: Send;
  readJson: (req: Req) => Promise<Row>;
  issuePageToken: (now?: number) => string;
  pageTokenOk: (req: Req, now?: number) => boolean;
}

/** A repository set (repo/index.ts). */
export type Repos = import('../repo/types.ts').Repos;

/** A JS module's exports, loosely typed until that module is TypeScript. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Module = Record<string, any>;

/** An Error a route throws with the HTTP status to answer. */
export type HttpError = Error & { status?: number; code?: string };

/** What a route handler gets (router.ts): the request, its URL, the path's match, the helpers. */
export type RouteCtx = Ctx & {
  req: Req;
  res: Res;
  url: URL;
  /** The path RegExp's match (groups as m[1], ...), or null for an exact or predicate path. */
  m: RegExpMatchArray | null;
  /** The JSON body, read once however many routes ask for it. */
  body(): Promise<Row>;
};

/** A route's path: exact, a RegExp (groups in c.m), or a predicate. */
export type Path = string | RegExp | ((url: URL, req: Req) => boolean);

/** One entry of the dashboard's route table (server.ts ROUTES). */
export interface Route {
  /** 'GET', 'POST', ...; omitted: any method. */
  method?: string;
  path: Path;
  /** Answers the request; `false` passes it on to the next route. */
  handle(c: RouteCtx): unknown;
}
