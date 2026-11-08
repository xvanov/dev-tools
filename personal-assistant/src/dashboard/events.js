'use strict';

// GET /api/events: the live feed every view subscribes to (plan items 0.4, E3),
// as Server-Sent Events over the process's bus (src/events).
//
//   ?topics=board,run,factory   only these topics (plus `resync`, always)
//   Last-Event-ID / ?lastEventId=   replay what came after it
//
// Each event is one `id:` + `data:` frame; data is the event's JSON
// {id, topic, at, payload}. The first frame is a `hello` carrying the newest
// id, so a reconnect always has a Last-Event-ID to send even when nothing has
// happened yet. A Last-Event-ID the bus can no longer replay (another worker
// generation — the supervisor closes streams on drain — a restart, or older
// than the ring) gets a `resync` frame instead: the page refetches its state
// once. Payloads are ids and states, never content: a page reads what changed
// through its own API, under its own rules.
//
// GET /events.js is the page side (events.client.js).

const fs = require('fs');
const path = require('path');
const events = require('../events');
const { TOPIC } = require('../events/bus');

const CLIENT = path.join(__dirname, 'events.client.js');
const PING_MS = 20_000;

/** Pure. `?topics=` as a list, or null for all; unknown shapes are dropped. */
function topicsParam(raw) {
  if (raw == null || raw === '') return null;
  const list = String(raw).split(',').map((t) => t.trim()).filter((t) => TOPIC.test(t)).slice(0, 20);
  return list.length ? [...new Set([...list, 'resync'])] : null;
}

function frame(e) {
  return `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`;
}

function stream(req, res, url, { bus = events.bus(), listen = events.listen, pingMs = PING_MS } = {}) {
  try {
    listen();
  } catch {
    // No feed from Postgres: the stream still carries this process's events.
  }
  const topics = topicsParam(url.searchParams.get('topics'));
  const lastId = req.headers['last-event-id'] || url.searchParams.get('lastEventId') || null;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write('retry: 2000\n\n');
  // since() and subscribe() are synchronous: nothing can be published between
  // the replay and the subscription.
  if (lastId) {
    const r = bus.since(lastId, { topics });
    if (r.gap) res.write(frame({ id: bus.lastId(), topic: 'resync', at: new Date().toISOString(), payload: { reason: 'cannot replay from that id' } }));
    else for (const e of r.events) res.write(frame(e));
  } else {
    res.write(frame({ id: bus.lastId(), topic: 'hello', at: new Date().toISOString(), payload: { epoch: bus.epoch } }));
  }
  const unsubscribe = bus.subscribe((e) => res.write(frame(e)), { topics });
  const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
  ping.unref?.();
  const done = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', done);
  res.on('error', done);
}

async function route(req, res, url, { send }) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    stream(req, res, url);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/events.js') {
    send(res, 200, fs.readFileSync(CLIENT, 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  return false;
}

module.exports = { route, stream, topicsParam };
