'use strict';

// /api/meetings/* — the dashboard's "Next meeting" section (src/meetings).
// Same guards as every route: server.js has already checked Host, and a POST
// arrives here only with X-PA.
//
//   GET  /api/meetings/upcoming      the next 24h: kind, skip reason, brief
//   GET  /api/meetings/brief/:id     one brief, with its cited evidence
//   POST /api/meetings/brief {eventId, force}   write a brief now (no toast)

async function route(method, url, body) {
  const meetings = require('../meetings');
  if (method === 'GET' && url.pathname === '/api/meetings/upcoming') {
    return meetings.upcoming({ hours: Math.min(Number(url.searchParams.get('hours')) || 24, 24 * 14) });
  }
  const m = url.pathname.match(/^\/api\/meetings\/brief\/(\d+)$/);
  if (method === 'GET' && m) return meetings.getBrief(Number(m[1]));
  if (method === 'POST' && url.pathname === '/api/meetings/brief') {
    const eventId = String(body.eventId || '').trim();
    if (!eventId) throw Object.assign(new Error('eventId required'), { status: 400 });
    const r = await meetings.brief(eventId, { deliver: false, force: body.force === true });
    return meetings.getBrief(r.brief.id);
  }
  return undefined;
}

module.exports = { route };
