'use strict';

// The event bus behind GET /api/events (plan item 0.4): an in-memory pub/sub
// with a bounded ring of recent events, so a client that reconnects with
// `Last-Event-ID` gets what it missed instead of refetching everything.
//
// An event is {id, topic, at, payload}. Item 1.4 moves the ring to an outbox
// table; keep this shape (topic, id, payload) so the endpoint and the pages do
// not change when it does. Ids are opaque to clients: `<epoch>-<seq>`, where
// the epoch is this bus's start. An id from another epoch (a worker restart, a
// supervisor roll to the next generation) or one older than the ring cannot be
// replayed, and `since` says so (`gap: true`): the client refetches its state
// once. Replay across generations waits for 1.4's outbox.
//
// Pure: no I/O, no timers. src/events/index.js holds the process's bus and
// feeds it from Postgres; this file is unit-tested on its own.

const TOPIC = /^[a-z][a-z0-9_.-]{0,39}$/;
const DEFAULT_CAPACITY = 1000;

function createBus({ capacity = DEFAULT_CAPACITY, epoch = Date.now().toString(36), now = () => new Date() } = {}) {
  if (!/^[a-z0-9]+$/.test(epoch)) throw new Error(`bus epoch must be [a-z0-9]+, got "${epoch}"`);
  const ring = []; // [{seq, event}], oldest first
  const subs = new Set();
  let seq = 0;

  const idOf = (n) => `${epoch}-${n}`;

  function publish(topic, payload = {}) {
    if (typeof topic !== 'string' || !TOPIC.test(topic)) throw new Error(`bad event topic "${String(topic).slice(0, 40)}"`);
    const event = { id: idOf(++seq), topic, at: now().toISOString(), payload: payload ?? {} };
    ring.push({ seq, event });
    while (ring.length > capacity) ring.shift();
    for (const s of [...subs]) {
      if (s.topics && !s.topics.has(topic)) continue;
      try {
        s.fn(event);
      } catch {
        // One broken subscriber (a closed socket) must not starve the others.
      }
    }
    return event;
  }

  /** Calls fn(event) for each new event (on `topics` only, if given); returns the unsubscribe. */
  function subscribe(fn, { topics = null } = {}) {
    const s = { fn, topics: topics ? new Set(topics) : null };
    subs.add(s);
    return () => subs.delete(s);
  }

  /**
   * What came after `lastId`: {gap: false, events} when every event since is
   * still in the ring, else {gap: true, events: []}: the caller cannot know
   * what it missed and must refetch.
   */
  function since(lastId, { topics = null } = {}) {
    const m = /^([a-z0-9]+)-(\d+)$/.exec(String(lastId || ''));
    if (!m || m[1] !== epoch) return { gap: true, events: [] };
    const after = Number(m[2]);
    if (after > seq) return { gap: true, events: [] };
    const oldest = ring.length ? ring[0].seq : seq + 1;
    if (after < oldest - 1) return { gap: true, events: [] };
    const want = topics ? new Set(topics) : null;
    return { gap: false, events: ring.filter((r) => r.seq > after && (!want || want.has(r.event.topic))).map((r) => r.event) };
  }

  return {
    publish,
    subscribe,
    since,
    epoch,
    /** The newest id: a client told this has seen everything so far. */
    lastId: () => idOf(seq),
    subscribers: () => subs.size,
  };
}

module.exports = { createBus, TOPIC, DEFAULT_CAPACITY };
