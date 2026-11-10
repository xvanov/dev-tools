'use strict';

// /api/debriefs/* — the dashboard's "Meeting debriefs" section
// (src/meetings/debrief.js). Same guards as every route: server.js has
// already checked Host, and a POST arrives here only with X-PA.
//
//   GET  /api/debriefs                 the last week's debriefs, item by item
//   GET  /api/debriefs/:id             one debrief
//   POST /api/debriefs/:id/undo {index}  take back one applied item
//   POST /api/debriefs/import?name=&event=&title=&at=   a recording or transcript as the raw body
//                                        (X-PA); starts an import in the background, 202 with its job
//   GET  /api/debriefs/imports           the imports, newest first, with their state
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
    // Nobody else in it: discarded, so there is no debrief to show.
    if (r.solo) return { ok: true, solo: true, discarded: true, episodeId };
    return debrief.get(r.debrief.id);
  }
  if (method === 'GET' && url.pathname === '/api/debriefs/imports') return require('../meetings/import.ts').jobs();
  return undefined;
}

// The upload: the body is the file, streamed to disk (an hour of video is far
// past the JSON body limit), and what it names is imported in the background.
// Called by server.ts before the JSON routes, behind the same Host and X-PA guards.
async function upload(req: Req, res: Res, url: URL, { send }: { send: (res: Res, status: number, body: unknown) => void }) {
  if (req.headers['x-pa'] !== '1') return send(res, 403, { error: 'missing X-PA header' });
  const imp = require('../meetings/import.ts');
  const { config } = require('../config.ts');
  const name = String(url.searchParams.get('name') || '').trim();
  if (!name || !imp.kindOf(name)) return send(res, 400, { error: `"${name}" is not an audio, video or .txt/.vtt/.srt file` });
  const limit = config.audio.import.maxMb * 1024 * 1024;
  if (Number(req.headers['content-length']) > limit) return send(res, 413, { error: `over the ${config.audio.import.maxMb} MB upload limit (PA_IMPORT_MAX_MB); \`pa meeting import <file>\` has none` });
  const fs = require('fs');
  const file = imp.uploadPath(name);
  let size = 0;
  const out = fs.createWriteStream(file);
  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) reject(Object.assign(new Error(`over the ${config.audio.import.maxMb} MB upload limit (PA_IMPORT_MAX_MB)`), { status: 413 }));
      });
      req.on('error', reject);
      req.on('aborted', () => reject(new Error('upload aborted')));
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (err: any) {
    out.destroy();
    fs.rm(file, { force: true }, () => {});
    return send(res, err.status || 400, { error: err.message });
  }
  if (!size) {
    fs.rm(file, { force: true }, () => {});
    return send(res, 400, { error: 'empty upload' });
  }
  const opt = (k: string) => String(url.searchParams.get(k) || '').trim() || null;
  const job = imp.start({ file, name, eventId: opt('event'), title: opt('title'), at: opt('at') });
  return send(res, 202, job);
}

module.exports = { route, upload };
