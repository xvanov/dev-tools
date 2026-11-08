'use strict';

// /api/debriefs/* — the dashboard's "Meeting debriefs" section
// (src/meetings/debrief.js). Same guards as every route: server.js has
// already checked Host, and a POST arrives here only with X-PA.
//
//   GET  /api/debriefs                 the last week's debriefs, item by item
//   GET  /api/debriefs/:id             one debrief
//   POST /api/debriefs/:id/undo {index}  take back one applied item
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;

async function route(method: string, url: URL, body: Row) {
  const debrief = require('../meetings/debrief.ts');
  if (method === 'GET' && url.pathname === '/api/debriefs') {
    return debrief.recent({ days: Math.min(Number(url.searchParams.get('days')) || 7, 60) });
  }
  let m = url.pathname.match(/^\/api\/debriefs\/(\d+)$/);
  if (method === 'GET' && m) return debrief.get(Number(m[1]));
  m = url.pathname.match(/^\/api\/debriefs\/(\d+)\/undo$/);
  if (method === 'POST' && m) {
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0) throw Object.assign(new Error('index required'), { status: 400 });
    const r = await debrief.undo(Number(m[1]), index);
    return { ok: true, result: r.already ? 'already undone' : r.result, debrief: await debrief.get(Number(m[1])) };
  }
  if (method === 'POST' && url.pathname === '/api/debriefs/run') {
    const episodeId = Number(body.episodeId);
    if (!Number.isInteger(episodeId) || episodeId <= 0) throw Object.assign(new Error('episodeId required'), { status: 400 });
    const r = await debrief.debrief(episodeId, { deliver: false });
    return debrief.get(r.debrief.id);
  }
  return undefined;
}

module.exports = { route };
