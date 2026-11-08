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
// happened yet. A `g<n>` Last-Event-ID (a change the database numbered) that
// the ring does not hold (a restart, another worker generation, older than the
// ring) is replayed from the outbox table (sql/036, plan 1.4). Any other id the
// bus cannot replay, or a client too far behind the outbox, gets a `resync`
// frame instead: the page refetches its state once. Payloads are ids and states, never content: a page reads what changed
// through its own API, under its own rules.
//
// GET /events.js is the page side (events.client.js).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;

/** The in-process bus (src/events/bus.ts) as this stream uses it. */
type BusEvent = { id: string; topic: string; at: string; payload?: unknown };
type Topics = string[] | null;
type Replay = { gap?: boolean; events: BusEvent[] };
interface Bus {
  epoch: unknown;
  lastId(): string;
  holds(id: string): boolean;
  since(id: string, o: { topics: Topics }): Replay;
  subscribe(fn: (e: BusEvent) => void, o: { topics: Topics }): () => void;
}
type Outbox = (n: number | string, o: { topics: Topics }) => Promise<Replay>;

const fs = require('fs');
const path = require('path');
const events = require('../events');
const { TOPIC } = require('../events/bus.ts');

const CLIENT = path.join(__dirname, 'events.client.js');
const PING_MS = 20_000;

/** Pure. `?topics=` as a list, or null for all; unknown shapes are dropped. */
function topicsParam(raw: unknown) {
  if (raw == null || raw === '') return null;
  const list = String(raw).split(',').map((t) => t.trim()).filter((t) => TOPIC.test(t)).slice(0, 20);
  return list.length ? [...new Set([...list, 'resync'])] : null;
}

function frame(e: Row) {
  return `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`;
}

const resyncFrame = (bus: Bus) => frame({ id: bus.lastId(), topic: 'resync', at: new Date().toISOString(), payload: { reason: 'cannot replay from that id' } });

/**
 * A `g<n>` the ring does not hold (a restart, another generation, older than
 * the ring): replay from the outbox (plan 1.4), then go live. Live events are
 * held while the outbox is read and sent after it, each id once. When the
 * outbox cannot be read, falls back to what the ring can say.
 */
function replayFromOutbox(res: Res, n: number | string, lastId: string, { bus, topics, outbox }: { bus: Bus; topics: Topics; outbox: Outbox }) {
  const held: BusEvent[] = [];
  let replaying = true;
  const sent = new Set();
  const write = (e: BusEvent) => {
    if (sent.has(e.id)) return;
    sent.add(e.id);
    res.write(frame(e));
  };
  const unsubscribe = bus.subscribe((e) => (replaying ? held.push(e) : write(e)), { topics });
  const finish = (r: Replay) => {
    if (r.gap) res.write(resyncFrame(bus));
    else for (const e of r.events) write(e);
    replaying = false;
    for (const e of held.splice(0)) write(e);
  };
  Promise.resolve()
    .then(() => outbox(n, { topics }))
    .then(finish, () => finish(bus.since(lastId, { topics })))
    .catch(() => {});
  return unsubscribe;
}

function stream(req: Req, res: Res, url: URL, { bus = events.bus(), listen = events.listen, pingMs = PING_MS, outbox = events.fromOutbox }: { bus?: Bus; listen?: () => void; pingMs?: number; outbox?: Outbox | null } = {}) {
  try {
    listen();
  } catch {
    // No feed from Postgres: the stream still carries this process's events.
  }
  const topics = topicsParam(url.searchParams.get('topics'));
  const lastId = (req.headers['last-event-id'] as string | undefined) || url.searchParams.get('lastEventId') || null;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write('retry: 2000\n\n');
  // since() and subscribe() are synchronous: nothing can be published between
  // the replay and the subscription. The outbox path holds live events instead.
  const g = lastId ? /^g(\d+)$/.exec(String(lastId)) : null;
  let unsubscribe: () => void;
  if (g && lastId && outbox && !bus.holds(lastId)) {
    unsubscribe = replayFromOutbox(res, g[1] ?? '', lastId, { bus, topics, outbox });
  } else {
    if (lastId) {
      const r = bus.since(lastId, { topics });
      if (r.gap) res.write(resyncFrame(bus));
      else for (const e of r.events) res.write(frame(e));
    } else {
      res.write(frame({ id: bus.lastId(), topic: 'hello', at: new Date().toISOString(), payload: { epoch: bus.epoch } }));
    }
    unsubscribe = bus.subscribe((e) => res.write(frame(e)), { topics });
  }
  const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
  ping.unref?.();
  const done = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', done);
  res.on('error', done);
}

async function route(req: Req, res: Res, url: URL, { send }: { send: Ctx['send'] }) {
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
