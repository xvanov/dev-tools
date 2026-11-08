'use strict';

// The live feed (plan items 0.4 and E3): the bus and its replay, the Postgres
// bridge, GET /api/events end to end on port 0, the pages' client, and the
// factory pass's pacing. No database: the bridge runs against a fake client.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createBus } = require('../src/events/bus.ts');
const events = require('../src/events');
const endpoint = require('../src/dashboard/events.ts');
const pace = require('../src/dispatch/factoryPace');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// Wait for a condition rather than sleeping and hoping: a loaded machine stretches every timer.
async function until(cond, what, ms = 15000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail('timed out waiting for: ' + what);
    await tick(5);
  }
}

// ---- the bus -------------------------------------------------------------------
{
  const bus = createBus({ capacity: 3, epoch: 'e1' });
  assert.strictEqual(bus.lastId(), 'e1-0');
  const seen = [];
  const boardOnly = [];
  const off = bus.subscribe((e) => seen.push(e));
  bus.subscribe((e) => boardOnly.push(e.topic), { topics: ['board'] });
  bus.subscribe(() => { throw new Error('a broken subscriber'); });
  const a = bus.publish('board', { id: 1 });
  assert.deepStrictEqual([a.id, a.topic, a.payload], ['e1-1', 'board', { id: 1 }]);
  assert.ok(!Number.isNaN(Date.parse(a.at)));
  bus.publish('run', { id: 2 });
  assert.deepStrictEqual(seen.map((e) => e.id), ['e1-1', 'e1-2'], 'every subscriber, even after a broken one');
  assert.deepStrictEqual(boardOnly, ['board'], 'topic filter');
  off();
  bus.publish('run', {});
  assert.strictEqual(seen.length, 2, 'unsubscribed');
  assert.throws(() => bus.publish('Bad Topic', {}), /bad event topic/);

  // Replay: everything after an id still in the ring.
  assert.deepStrictEqual(bus.since('e1-1').events.map((e) => e.id), ['e1-2', 'e1-3']);
  assert.deepStrictEqual(bus.since('e1-1', { topics: ['run'] }).events.map((e) => e.id), ['e1-2', 'e1-3']);
  assert.deepStrictEqual(bus.since('e1-3'), { gap: false, events: [] }, 'up to date');
  // A gap: another epoch (a restart or the next worker generation), the future,
  // garbage, or older than the ring.
  assert.strictEqual(bus.since('zz-1').gap, true);
  assert.strictEqual(bus.since('e1-9').gap, true);
  assert.strictEqual(bus.since('nonsense').gap, true);
  bus.publish('board', {});
  bus.publish('board', {}); // ring now holds 3..5
  assert.strictEqual(bus.since('e1-1').gap, true, 'e1-2 was evicted');
  assert.strictEqual(bus.since('e1-2').gap, false, 'e1-3 onwards is all there');
  // A fresh bus: its own zero id replays nothing and is no gap.
  const fresh = createBus({ epoch: 'f' });
  assert.deepStrictEqual(fresh.since(fresh.lastId()), { gap: false, events: [] });
}

// ---- across worker generations (Z6): `g<seq>` ids from the database feed ----
{
  // Generation A listened from seq 10; B (the next) from seq 12. Both hear
  // every NOTIFY after that, in the same order.
  const a = createBus({ epoch: 'aa' });
  const b = createBus({ epoch: 'bb' });
  a.setBaseline('10');
  b.setBaseline('12');
  assert.strictEqual(b.lastId(), 'g12', 'an empty ring with a baseline names it');
  const feed = (n) => [a, b].forEach((x, i) => (i === 0 || n > 12) && x.publish('board', { seq: n }, { gid: n }));
  [11, 12, 13, 15, 14].forEach(feed); // commit order, not sequence order
  assert.deepStrictEqual(a.since('g13').events.map((e) => e.id), ['g15', 'g14']);
  // A client that last saw g13 on A reconnects to B: replayed from there.
  assert.deepStrictEqual(b.since('g13').events.map((e) => e.id), ['g15', 'g14']);
  // ... and one that last saw g11 (before B listened): all of B's ring.
  assert.deepStrictEqual(b.since('g11').events.map((e) => e.id), ['g13', 'g15', 'g14']);
  assert.deepStrictEqual(b.since(a.lastId()), { gap: false, events: [] });
  // A g-id past the baseline that B never heard is a gap.
  assert.strictEqual(b.since('g99').gap, true);
  // Without a baseline (no sequence yet), an unknown g-id is a gap.
  assert.strictEqual(createBus({ epoch: 'cc' }).since('g1').gap, true);
  // Once the ring drops events, "everything here is newer" no longer holds.
  const small = createBus({ epoch: 'dd', capacity: 2 });
  small.setBaseline('5');
  [6, 7, 8].forEach((n) => small.publish('board', {}, { gid: n }));
  assert.strictEqual(small.since('g4').gap, true);
  assert.deepStrictEqual(small.since('g7').events.map((e) => e.id), ['g8']);
}

// ---- NOTIFY payloads ---------------------------------------------------------------
assert.deepStrictEqual(events.fromNotify('{"topic":"run","table":"run","op":"update","id":7,"status":"running"}'),
  { topic: 'run', payload: { table: 'run', op: 'update', id: 7, status: 'running' } });
assert.strictEqual(events.fromNotify('not json'), null);
assert.strictEqual(events.fromNotify('{"topic":"BAD TOPIC"}'), null);
assert.strictEqual(events.fromNotify('{"id":1}'), null);

// ---- endpoint helpers ------------------------------------------------------------
assert.strictEqual(endpoint.topicsParam(null), null);
assert.strictEqual(endpoint.topicsParam(''), null);
assert.deepStrictEqual(endpoint.topicsParam('board, run,board,<x>'), ['board', 'run', 'resync']);

/** An SSE reader: GET path, collects parsed frames. */
function sse(port, pathAndQuery, headers = {}) {
  const frames = [];
  const waiters = [];
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port, path: pathAndQuery, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        const id = (block.split('\n').find((l) => l.startsWith('id: ')) || '').slice(4);
        if (!data) continue;
        frames.push({ id, ...JSON.parse(data), receivedAt: process.hrtime.bigint() });
        for (const w of waiters.splice(0)) w();
      }
    });
  });
  return {
    frames,
    req,
    async waitFor(n, ms = 20000) {
      const until = Date.now() + ms;
      while (frames.length < n) {
        if (Date.now() > until) throw new Error(`waited for ${n} frames, got ${frames.length}: ${JSON.stringify(frames.map(({ receivedAt, ...f }) => f))}`);
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
      return frames;
    },
    close: () => req.destroy(),
  };
}

(async () => {
  // ---- GET /api/events end to end, on its own server --------------------------
  {
    const bus = createBus({ epoch: 'g1' });
    let listens = 0;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      endpoint.stream(req, res, url, { bus, listen: () => listens++ });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    // First connect: a hello carrying the newest id, then live events.
    const a = sse(port, '/api/events?topics=board');
    await a.waitFor(1);
    assert.deepStrictEqual([a.frames[0].topic, a.frames[0].id], ['hello', 'g1-0']);
    assert.strictEqual(listens, 1, 'the stream starts the Postgres feed');
    // Latency: publish -> frame parsed by the client, over loopback.
    const lat = [];
    for (let i = 0; i < 20; i++) {
      bus.publish('run', { i }); // filtered out
      const t0 = process.hrtime.bigint();
      bus.publish('board', { i });
      await a.waitFor(2 + i);
      lat.push(Number(a.frames[1 + i].receivedAt - t0) / 1e6);
    }
    assert.ok(a.frames.slice(1).every((f) => f.topic === 'board'), 'only the topics asked for');
    lat.sort((x, y) => x - y);
    console.log(`  bus -> SSE client latency over loopback: p50 ${lat[10].toFixed(2)} ms, max ${lat[19].toFixed(2)} ms`);
    // ~1 ms idle. A ceiling that still fails for a poll-based feed (the old 30 s polls), not for a busy machine.
    assert.ok(lat[19] < 5000, `an event reaches the client promptly (max ${lat[19]} ms)`);
    const lastSeen = a.frames[a.frames.length - 1].id;
    a.close();

    // Missed while away: a reconnect with Last-Event-ID gets exactly those.
    bus.publish('board', { missed: 1 });
    bus.publish('board', { missed: 2 });
    const b = sse(port, '/api/events?topics=board', { 'Last-Event-ID': lastSeen });
    await b.waitFor(2);
    assert.deepStrictEqual(b.frames.map((f) => f.payload.missed), [1, 2], 'replayed, no hello');
    b.close();
    // ?lastEventId= works the same (a page that had to open a new EventSource).
    const c = sse(port, `/api/events?topics=board&lastEventId=${encodeURIComponent(lastSeen)}`);
    await c.waitFor(2);
    assert.deepStrictEqual(c.frames.map((f) => f.payload.missed), [1, 2]);
    c.close();
    // An id from another generation: one resync frame, carrying an id to resume from.
    const d = sse(port, '/api/events', { 'Last-Event-ID': 'oldgen-41' });
    await d.waitFor(1);
    assert.strictEqual(d.frames[0].topic, 'resync');
    assert.strictEqual(d.frames[0].id, bus.lastId());
    bus.publish('factory', { id: 1 });
    await d.waitFor(2);
    assert.strictEqual(d.frames[1].topic, 'factory', 'no topics: everything');
    d.close();
    // The server sees each close when the socket's FIN arrives: 20 ms was not
    // always enough on a loaded machine. Wait for it, up to 5 s.
    for (let i = 0; i < 250 && bus.subscribers() > 0; i++) await tick(20);
    assert.strictEqual(bus.subscribers(), 0, 'closed streams unsubscribe');
    server.close();
  }

  // ---- through the dashboard server ----------------------------------------------
  {
    events._setListen(() => {});
    const dash = require('../src/dashboard/server');
    const server = await dash.start({ port: 0, host: '127.0.0.1' });
    const { port } = server.address();
    const js = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/events.js', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      }).on('error', reject);
    });
    assert.strictEqual(js.status, 200);
    assert.match(js.type, /javascript/);
    assert.match(js.body, /PAEvents/);
    const s = sse(port, '/api/events?topics=board');
    await s.waitFor(1);
    assert.strictEqual(s.frames[0].topic, 'hello');
    events.publish('board', { via: 'server' });
    await s.waitFor(2);
    assert.strictEqual(s.frames[1].payload.via, 'server');
    // The loopback guard holds for the stream too.
    const refused = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.strictEqual(refused, 403);
    s.close();
    server.close();
    events._setListen(null);
  }

  // ---- the Postgres bridge, against a fake client -------------------------------------
  {
    const clients = [];
    const got = [];
    let reconnects = 0;
    const l = events.createListener({
      connect: async () => {
        const c = Object.assign(new EventEmitter(), {
          queries: [],
          ended: false,
          query: async (q) => c.queries.push(q),
          end: async () => { c.ended = true; },
        });
        clients.push(c);
        if (clients.length === 2) throw new Error('database restarting');
        return c;
      },
      onEvent: (e) => got.push(e),
      onReconnect: () => reconnects++,
      retryMs: [5],
    });
    await until(() => clients.length >= 1 && clients[0].queries.length >= 1 && l.connected(), 'the listener connects and LISTENs');
    assert.deepStrictEqual(clients[0].queries, ['listen pa_events']);
    assert.ok(l.connected());
    clients[0].emit('notification', { channel: 'pa_events', payload: '{"topic":"run","id":3,"status":"waiting"}' });
    clients[0].emit('notification', { channel: 'other', payload: '{"topic":"run"}' });
    clients[0].emit('notification', { channel: 'pa_events', payload: 'garbage' });
    assert.deepStrictEqual(got, [{ topic: 'run', payload: { id: 3, status: 'waiting' } }]);
    assert.strictEqual(reconnects, 0, 'the first connect is not a reconnect');
    // The connection drops; the next attempt fails; the one after holds.
    clients[0].emit('error', new Error('terminated'));
    assert.ok(clients[0].ended);
    await until(() => clients.length >= 3 && l.connected(), 'a failed attempt, then a held reconnect');
    assert.strictEqual(clients.length, 3);
    assert.ok(l.connected());
    assert.strictEqual(reconnects, 1, 'a reconnect asks the pages to refetch (notifications were lost)');
    await l.stop();
    assert.ok(clients[2].ended);
  }

  // ---- the outbox (plan 1.4): replay and backfill past the ring ------------------------
  {
    const row = (seq, extra = {}) => ({ seq: String(seq), topic: 'board', payload: { table: 'notification', op: 'insert', id: seq * 10, seq, ...extra }, at: new Date(Date.UTC(2026, 10, 8, 0, 0, seq)) });
    const store = ({ rows = [], oldest = rows.length ? rows[0].seq : null, head = rows.length ? rows[rows.length - 1].seq : '0', fail = null, delay = 0 } = {}) => ({
      calls: [],
      async after(seq, o) {
        this.calls.push([String(seq), o]);
        if (delay) await tick(delay);
        if (fail) throw fail;
        const list = rows.filter((r) => BigInt(r.seq) > BigInt(seq) && (!o.topics || o.topics.includes(r.topic)));
        return { events: list.slice(0, o.limit), more: list.length > o.limit };
      },
      async oldest() { return oldest; },
      async head() { return head; },
    });
    assert.deepStrictEqual(events.outboxEvent(row(7)), { id: 'g7', topic: 'board', at: '2026-11-08T00:00:07.000Z', payload: row(7).payload });

    // What came after g<n>, from the table.
    const s = store({ rows: [row(5), row(6), row(8)] });
    assert.deepStrictEqual((await events.fromOutbox('5', { store: s })).events.map((e) => e.id), ['g6', 'g8'], 'holes (rolled-back numbers) are fine');
    assert.deepStrictEqual(await events.fromOutbox('8', { store: s }), { gap: false, events: [] }, 'up to date');
    assert.strictEqual((await events.fromOutbox('4', { store: s })).gap, false, 'the event just before the oldest kept: nothing lost');
    assert.strictEqual((await events.fromOutbox('3', { store: s })).gap, true, 'older than what is kept: maybe pruned, resync');
    assert.strictEqual((await events.fromOutbox('5', { store: s, limit: 1 })).gap, true, 'more than the limit waiting: resync');
    assert.deepStrictEqual(s.calls[0][1].topics, null);
    assert.strictEqual((await events.fromOutbox('3', { store: store({ rows: [], head: '9' }) })).gap, true, 'an empty outbox behind the sequence (pruned, or before 036)');
    assert.deepStrictEqual(await events.fromOutbox('9', { store: store({ rows: [], head: '9' }) }), { gap: false, events: [] });
    await assert.rejects(events.fromOutbox('1', { store: store({ fail: new Error('no db') }) }), /no db/);

    // A listener that reconnects backfills from the bus's highest number.
    const b = createBus({ epoch: 'bf' });
    const seen = [];
    b.subscribe((e) => seen.push(e.id));
    b.setBaseline('5');
    b.publish('board', { seq: 6 }, { gid: 6 });
    assert.strictEqual(b.highGid(), '6');
    assert.strictEqual(await events.backfill({ b, store: store({ rows: [row(5), row(6), row(7), row(9)] }) }), 2);
    assert.deepStrictEqual(seen, ['g6', 'g7', 'g9'], 'only what came after, in order');
    // The live NOTIFY of an event the backfill already published is not sent twice.
    assert.strictEqual(b.publish('board', { seq: 9 }, { gid: 9 }).id, 'g9');
    assert.deepStrictEqual(seen, ['g6', 'g7', 'g9']);
    assert.ok(b.holds('g7') && !b.holds('g8'));
    // Cannot backfill (no database, nothing to start from, too far behind): resync.
    assert.strictEqual(await events.backfill({ b, store: store({ fail: new Error('down') }) }), null);
    assert.strictEqual(seen[seen.length - 1].startsWith('bf-'), true);
    assert.strictEqual(await events.backfill({ b: createBus({ epoch: 'nb' }), store: store() }), null);

    // GET /api/events: a g<n> the ring does not hold (a restart, another
    // generation) replays from the outbox; live events that arrive meanwhile
    // follow it, each id once.
    const bus = createBus({ epoch: 'ob' });
    bus.setBaseline('7');
    let outbox = (n, o) => events.fromOutbox(n, { ...o, store: store({ rows: [row(5), row(6), row(7)], delay: 40 }) });
    const server = http.createServer((req, res) => endpoint.stream(req, res, new URL(req.url, 'http://localhost'), { bus, listen: () => {}, outbox: (n, o) => outbox(n, o) }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const r1 = sse(port, '/api/events?topics=board', { 'Last-Event-ID': 'g5' });
    while (bus.subscribers() < 1) await tick(2); // subscribed, the outbox read still running
    bus.publish('board', { seq: 7 }, { gid: 7 }); // also in the outbox read
    bus.publish('board', { seq: 8 }, { gid: 8 });
    await r1.waitFor(3);
    await tick(20);
    assert.deepStrictEqual(r1.frames.map((f) => f.id), ['g6', 'g7', 'g8'], 'replayed, then live, no duplicate');
    r1.close();
    // A g-id the ring holds is answered from the ring, without the table.
    let asked = 0;
    outbox = () => { asked++; return Promise.reject(new Error('unused')); };
    const r2 = sse(port, '/api/events', { 'Last-Event-ID': 'g7' });
    await r2.waitFor(1);
    assert.deepStrictEqual([r2.frames.map((f) => f.id), asked], [['g8'], 0]);
    r2.close();
    // The table cannot be read: what the ring can say (Z6's baseline rule).
    const r3 = sse(port, '/api/events', { 'Last-Event-ID': 'g4' });
    await r3.waitFor(2);
    assert.deepStrictEqual(r3.frames.map((f) => f.id), ['g7', 'g8']);
    r3.close();
    // Too far behind the table: one resync.
    outbox = (n, o) => events.fromOutbox(n, { ...o, store: store({ rows: [row(6), row(7)] }) });
    const r4 = sse(port, '/api/events', { 'Last-Event-ID': 'g2' });
    await r4.waitFor(1);
    assert.strictEqual(r4.frames[0].topic, 'resync');
    r4.close();
    await until(() => bus.subscribers() === 0, 'closed streams unsubscribe');
    assert.strictEqual(bus.subscribers(), 0);
    server.close();
  }

  // ---- the pages' client (events.client.js) in a sandbox ---------------------------------
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'events.client.js'), 'utf8');
    const sources = [];
    class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        sources.push(this);
      }
      close() { this.readyState = 2; }
      emit(e, id) { this.onmessage({ data: JSON.stringify(e), lastEventId: id || '' }); }
    }
    const window = { EventSource: FakeEventSource };
    const ctx = vm.createContext({ window, document: { visibilityState: 'visible' }, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON, Math });
    vm.runInContext(src, ctx, { filename: 'events.client.js' });
    let board = 0;
    let fact = 0;
    const seen = [];
    const s1 = window.PAEvents.subscribe({ topics: ['board', 'run'], onChange: () => board++, onEvent: (e) => seen.push(e.topic), debounceMs: 5, minGapMs: 0 });
    const s2 = window.PAEvents.subscribe({ topics: ['factory'], onChange: () => fact++, debounceMs: 5, minGapMs: 0 });
    assert.strictEqual(sources.length, 1, 'one EventSource per page, however many subscribers');
    assert.strictEqual(sources[0].url, 'api/events', 'relative: works under /pa/');
    const es = sources[0];
    es.emit({ topic: 'hello', id: 'x-0' }, 'x-0');
    es.emit({ topic: 'board', id: 'x-1' }, 'x-1');
    es.emit({ topic: 'run', id: 'x-2' }, 'x-2');
    es.emit({ topic: 'board', id: 'x-3' }, 'x-3');
    await until(() => board >= 1, 'the burst refetches');
    await tick(30); // and not a second time
    assert.strictEqual(board, 1, 'a burst is one refetch');
    assert.strictEqual(fact, 0, 'other topics do not wake it');
    assert.deepStrictEqual(seen, ['board', 'run', 'board']);
    es.emit({ topic: 'resync', id: 'y-9' }, 'y-9');
    await until(() => board >= 2 && fact >= 1, 'resync refetches everything');
    assert.deepStrictEqual([board, fact], [2, 1], 'resync refetches everything');
    // The browser gave up (a 502 during a roll): reopened with the last id.
    es.readyState = 2;
    es.onerror();
    await until(() => sources.length >= 2, 'the page reopens the stream after the error', 30000);
    assert.strictEqual(sources.length, 2);
    assert.strictEqual(sources[1].url, 'api/events?lastEventId=y-9');
    s1.close();
    s2.close();
    assert.strictEqual(sources[1].readyState, 2, 'the last subscriber closes the stream');
  }

  // ---- Plan, Build and Routines use the feed, not the 30 s polls --------------------
  {
    const dir = path.join(__dirname, '..', 'src', 'dashboard');
    const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const build = fs.readFileSync(path.join(dir, 'factory.html'), 'utf8');
    const buildJs = fs.readFileSync(path.join(dir, 'factory.client.js'), 'utf8');
    const routines = fs.readFileSync(path.join(dir, 'routines.client.js'), 'utf8');
    assert.ok(index.indexOf('<script src="events.js"></script>') < index.search(/<script>\r?\n/), 'Plan loads events.js before its own script');
    assert.match(index, /PAEvents\.subscribe\(\{ topics: \['board', 'run'\]/);
    assert.match(build, /<script src="events\.js"><\/script>[\s\S]*<script src="permission\.js"><\/script>[\s\S]*<script src="factory\.js"><\/script>/, 'Build: the feed, then Jarvis\'s permission card, then its script');
    assert.match(build, /data-permission-card/);
    assert.match(buildJs, /PAEvents\.subscribe\(\{ topics: \['factory', 'run'\]/);
    assert.match(buildJs, /waiting for your approval/);
    assert.match(index, /waiting for your approval/);
    assert.match(index, /api\/factory\/jobs\/\$\{encodeURIComponent\(r\.factory_job_id\)\}\/approve/, 'Plan can approve a factory job');
    assert.match(routines, /PAEvents\.subscribe\(\{ topics: \['routine'\]/);
    for (const [name, s] of [['index.html', index], ['factory.client.js', buildJs], ['routines.client.js', routines]]) {
      assert.ok(!/setInterval\([^)]*,\s*30000\)\s*;\s*$/m.test(s.replace(/else setInterval[^\n]*/g, '')), `${name}: no unconditional 30 s poll left`);
    }
  }

  // ---- the migration: every table it hangs a trigger on exists -----------------------
  {
    const sqlDir = path.join(__dirname, '..', 'sql');
    const all = fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(path.join(sqlDir, f), 'utf8')).join('\n');
    const mig = fs.readFileSync(path.join(sqlDir, '034_events_notify.sql'), 'utf8');
    const tables = [...mig.matchAll(/create or replace trigger \w+ after [\w ]+ on (\w+)/g)].map((m) => m[1]);
    assert.ok(tables.length >= 10, tables.join());
    for (const t of tables) assert.match(all, new RegExp(`create table if not exists ${t} \\(`), `${t} exists`);
    for (const t of ['commitment', 'run', 'proposal', 'draft', 'factory_board']) assert.ok(tables.includes(t), `${t} is on the feed`);
    assert.match(mig, /pg_notify\('pa_events'/);
    assert.strictEqual(events.CHANNEL, 'pa_events');
  }

  // ---- the factory pass's pacing (factoryPace.js) ---------------------------------------
  {
    assert.strictEqual(pace.moving([{ state: 'done' }, { state: 'needs_human' }]), false, 'parked on a human is not moving');
    assert.strictEqual(pace.moving([{ state: 'done' }, { state: 'in_progress' }]), true);
    assert.strictEqual(pace.moving(null), false);
    assert.strictEqual(pace.nextDelayMs({ jobs: [{ state: 'queued' }], slowSeconds: 120, fastSeconds: 5 }), 5000);
    assert.strictEqual(pace.nextDelayMs({ jobs: [{ state: 'done' }], slowSeconds: 120, fastSeconds: 5 }), 120000);
    assert.strictEqual(pace.nextDelayMs({ jobs: [{ state: 'triaging' }], slowSeconds: 3, fastSeconds: 5 }), 3000, 'never slower than the slow poll');

    const yes = () => true;
    assert.strictEqual(pace.localStateDir({ path: '/f', machine: '' }, { hostname: 'me', exists: yes }), path.join('/f', 'state'));
    assert.strictEqual(pace.localStateDir({ path: '/f', machine: 'ME' }, { hostname: 'me', exists: yes }), path.join('/f', 'state'), 'this machine by name');
    assert.strictEqual(pace.localStateDir({ path: '/f', machine: 'linux-box' }, { hostname: 'me', exists: yes }), null, 'a remote factory is polled');
    assert.strictEqual(pace.localStateDir({ path: '', machine: '' }, { hostname: 'me', exists: yes }), null);
    assert.strictEqual(pace.localStateDir({ path: '/f', machine: '' }, { hostname: 'me', exists: () => false }), null);

    // The pacer, on fake time.
    let now = 0;
    const timers = [];
    const fake = {
      setTimeout: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.live = false; },
    };
    const advance = async (ms) => {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((x, y) => x.at - y.at)[0];
        if (!due) break;
        now = due.at;
        due.live = false;
        due.fn();
        await tick();
        await tick();
      }
      now = end;
    };
    let runs = 0;
    let release = null;
    let jobs = [{ state: 'done' }];
    const pacer = pace.createPacer({
      run: async () => { runs++; if (release === 'hold') await new Promise((r) => (release = r)); },
      nextMs: async () => pace.nextDelayMs({ jobs, slowSeconds: 120, fastSeconds: 5 }),
      minGapMs: 500,
      timers: fake,
      clock: () => now,
    });
    pacer.start(1000);
    await advance(1000);
    assert.strictEqual(runs, 1);
    await advance(119_000);
    assert.strictEqual(runs, 1, 'idle: the slow cadence');
    await advance(1000);
    assert.strictEqual(runs, 2);
    // A local factory wrote its state: the pass runs at once (after the min gap).
    now += 10_000;
    pacer.kick();
    await advance(0);
    assert.strictEqual(runs, 3, 'kick runs now');
    pacer.kick();
    await advance(499);
    assert.strictEqual(runs, 3, 'kicks keep a min gap after a pass');
    await advance(1);
    assert.strictEqual(runs, 4);
    // A kick during a pass: one more right after it, not two at once.
    jobs = [{ state: 'in_progress' }];
    release = 'hold';
    pacer.kick();
    await advance(500);
    assert.strictEqual(runs, 5);
    assert.ok(pacer.busy(), 'busy during a pass (the watcher ignores our own writes)');
    pacer.kick();
    pacer.kick();
    const r = release;
    release = null;
    r();
    await tick();
    await tick();
    await advance(500);
    assert.strictEqual(runs, 6, 'the kicks during it collapse into one');
    // A job is moving: the fast cadence.
    await advance(5000);
    assert.strictEqual(runs, 7);
    // hurry() only ever pulls a slow wait in.
    jobs = [{ state: 'done' }];
    await advance(5000);
    assert.strictEqual(runs, 8, 'the pass that sees it stop');
    pacer.hurry(5000);
    await advance(5000);
    assert.strictEqual(runs, 9, 'a job just submitted: polled within the fast interval');
    pacer.hurry(5000);
    pacer.hurry(5000);
    await advance(5000);
    assert.strictEqual(runs, 10, 'hurry never makes it faster than the interval it names');
    pacer.stop();
    await advance(300_000);
    assert.strictEqual(runs, 10, 'stopped');

    // A factory's pushed statuses (POST /api/factory/events): cleaned, whitelisted.
    const { pushedPatches } = require('../src/dispatch/factory');
    assert.deepStrictEqual(pushedPatches({ job_id: 'app:t-1', state: 'needs_human', why: 'pick a direction', title: 'ignored', stories: [] }),
      [{ jobId: 'app:t-1', patch: { state: 'needs_human', why: 'pick a direction' } }]);
    assert.deepStrictEqual(pushedPatches({ jobs: [
      { job_id: 'app:t-2', state: 'in_progress', updated_at: '2026-11-07T10:00:00Z' },
      { job_id: 'not a job id', state: 'done' },
      { job_id: 'app:t-3', state: 'exploded' },
      { job_id: 'app:t-4', state: 'done', updated_at: 'yesterday' },
    ] }), [
      { jobId: 'app:t-2', patch: { state: 'in_progress', updated_at: '2026-11-07T10:00:00Z' } },
      { jobId: 'app:t-4', patch: { state: 'done' } },
    ]);
    assert.deepStrictEqual(pushedPatches(null), []);
    assert.strictEqual(pushedPatches({ jobs: Array.from({ length: 80 }, (_, i) => ({ job_id: `a:t-${i}`, state: 'done' })) }).length, 50);

    // The watcher: only factory.db* writes, and not while ignore() says they are ours.
    let cb = null;
    let closed = false;
    let ours = false;
    let changes = 0;
    const stop = pace.watchState('/f/state', {
      onChange: () => changes++,
      ignore: () => ours,
      watch: (dir, opts, fn) => { assert.strictEqual(opts.persistent, false); cb = fn; return { on() {}, close: () => (closed = true) }; },
    });
    cb('change', 'factory.db-wal');
    cb('change', 'locks');
    cb('rename', 'factory.db');
    ours = true;
    cb('change', 'factory.db-wal');
    assert.strictEqual(changes, 2);
    stop();
    assert.ok(closed);
    assert.strictEqual(pace.watchState('/missing', { onChange() {}, watch: () => { throw new Error('ENOENT'); } }), null);
  }

  console.log('events: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
