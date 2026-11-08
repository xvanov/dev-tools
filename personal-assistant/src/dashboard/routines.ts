'use strict';

// The dashboard's Routines tab: JSON over src/routines. Reads are GETs; every
// write is a POST, which server.js only lets through with the X-PA header.
//
// Adding a routine is two requests on purpose: `parse` turns your words into
// a preview and saves nothing; only the second POST, carrying the preview you
// looked at, stores it. A run answers as soon as its run row exists — a
// repo_sync takes minutes — and the page polls until it ends.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type HttpError = import('./types.ts').HttpError;

const routines = () => require('../routines');

function pick(body: Row) {
  return {
    title: String(body.title || ''),
    schedule: String(body.schedule || ''),
    action: String(body.action || ''),
    params: body.params && typeof body.params === 'object' ? body.params : {},
    description: String(body.description || ''),
  };
}

function startRun(id: number | string, { dryRun }: { dryRun?: boolean }) {
  return new Promise((resolve, reject) => {
    let started = false;
    routines()
      .runRoutine(id, {
        dryRun,
        onStarted: (run: Row) => {
          started = true;
          resolve({ runId: run.id, started: true });
        },
      })
      .catch((err: Error) => {
        if (!started) reject(err);
      });
  });
}

async function route(method: string, url: URL, body: Row) {
  const r = routines();
  const p = url.pathname;

  if (method === 'GET' && p === '/api/routines') {
    const [list, history] = await Promise.all([r.list(), r.history({ limit: 40 })]);
    return {
      routines: list.map((x: Row) => ({ ...x, plain: r.plainWords(x), changes: safeChanges(r, x.action) })),
      history,
      actions: r.actions.catalog(),
    };
  }
  if (method !== 'POST') return undefined;

  if (p === '/api/routines/parse') return r.parseWords(String(body.words || ''));
  if (p === '/api/routines/preview') return r.preview(pick(body));
  if (p === '/api/routines') {
    if (body.confirmed !== true) {
      const err: HttpError = new Error('not confirmed');
      err.status = 400;
      throw err;
    }
    const row = await r.create(pick(body));
    return { id: row.id, next_run_at: row.next_run_at };
  }
  if (p === '/api/routines/suggest') {
    const rows = await require('../routines/suggest.ts').suggest();
    return { proposed: rows.map((x: Row) => ({ id: x.id, title: x.title })) };
  }
  const m = p.match(/^\/api\/routines\/(\d+)\/(run|dry-run|pause|resume|accept|reject|delete)$/);
  if (m) {
    const id = Number(m[1]);
    if (m[2] === 'run' || m[2] === 'dry-run') return startRun(id, { dryRun: m[2] === 'dry-run' });
    if (m[2] === 'delete') return r.remove(id);
    const row = await r.setStatus(id, m[2]);
    return { id: row.id, status: row.status, next_run_at: row.next_run_at };
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeChanges(r: any, action: unknown) {
  try {
    return r.actions.get(action).changes;
  } catch {
    return 'unknown action';
  }
}

module.exports = { route, pick };
