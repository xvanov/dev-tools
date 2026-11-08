'use strict';

// The event bus behind GET /api/events (plan item 0.4): an in-memory pub/sub
// with a bounded ring of recent events, so a client that reconnects with
// `Last-Event-ID` gets what it missed instead of refetching everything.
//
// An event is {id, topic, at, payload} (schemas/event.schema.json). Ids are
// opaque to clients: `g<n>` for a change the database numbered (sql/035), the
// same in every process, or `<epoch>-<seq>` for one published in this process
// only, where the epoch is this bus's start. What the ring cannot replay,
// `since` reports as `gap: true`. For a `g<n>` the endpoint then replays from
// the outbox table (sql/036, plan 1.4: src/dashboard/events.js), so a restart
// or a roll loses nothing; anything else makes the client refetch once.
//
// Pure: no I/O, no timers. src/events/index.js holds the process's bus and
// feeds it from Postgres; this file is unit-tested on its own.

const TOPIC = /^[a-z][a-z0-9_.-]{0,39}$/;
const DEFAULT_CAPACITY = 1000;

function createBus({ capacity = DEFAULT_CAPACITY, epoch = Date.now().toString(36), now = () => new Date() } = {}) {
  if (!/^[a-z0-9]+$/.test(epoch)) throw new Error(`bus epoch must be [a-z0-9]+, got "${epoch}"`);
  const ring = []; // [{seq, gid, event}], oldest first
  const subs = new Set();
  let seq = 0;
  // Cross-generation replay (Z6). An event that came from the database's
  // feed carries a global sequence number (sql/035: pa_event_seq) and the id
  // `g<n>`, the same in every worker generation, since each generation LISTENs
  // to the same notifications in the same (commit) order. So a client that
  // reconnects to the next generation after a roll, with a `g<n>` it got from
  // the previous one, is replayed from there instead of told to resync.
  // `baseline` is the sequence's value when this bus's feed began: a `g<n>`
  // at or under it that the ring never held was committed before the feed
  // began, so the whole ring is what came after it — unless the ring has
  // dropped events since (`overflowed`).
  let baseline = null;
  let overflowed = false;
  // The highest global number published (or the baseline): where a listener
  // that reconnects backfills from (src/events, plan 1.4).
  let high = null;

  const idOf = (n) => `${epoch}-${n}`;

  function publish(topic, payload = {}, { gid = null } = {}) {
    if (typeof topic !== 'string' || !TOPIC.test(topic)) throw new Error(`bad event topic "${String(topic).slice(0, 40)}"`);
    const g = gid != null && /^\d+$/.test(String(gid)) ? String(gid) : null;
    if (g) {
      // Once per global number: a listener's backfill from the outbox (1.4)
      // and the live NOTIFY can both bring the same event.
      const held = ring.find((r) => r.gid === g);
      if (held) return held.event;
      if (high == null || BigInt(g) > BigInt(high)) high = g;
    }
    ++seq;
    const event = { id: g ? `g${g}` : idOf(seq), topic, at: now().toISOString(), payload: payload ?? {} };
    ring.push({ seq, gid: g, event });
    while (ring.length > capacity) {
      ring.shift();
      overflowed = true;
    }
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
    const want = topics ? new Set(topics) : null;
    const after = (n) => ({ gap: false, events: ring.filter((r) => r.seq > n && (!want || want.has(r.event.topic))).map((r) => r.event) });
    const g = /^g(\d+)$/.exec(String(lastId || ''));
    if (g) {
      const hit = ring.find((r) => r.gid === g[1]);
      if (hit) return after(hit.seq);
      // Never held: older than this bus's feed? Then everything here is newer.
      if (baseline != null && !overflowed && BigInt(g[1]) <= BigInt(baseline)) return after(0);
      return { gap: true, events: [] };
    }
    const m = /^([a-z0-9]+)-(\d+)$/.exec(String(lastId || ''));
    if (!m || m[1] !== epoch) return { gap: true, events: [] };
    const n = Number(m[2]);
    if (n > seq) return { gap: true, events: [] };
    const oldest = ring.length ? ring[0].seq : seq + 1;
    if (n < oldest - 1) return { gap: true, events: [] };
    return after(n);
  }

  return {
    publish,
    subscribe,
    since,
    epoch,
    /** The newest id: a client told this has seen everything so far. */
    // With nothing in the ring yet, `g<baseline>` says "everything up to where
    // the feed began", which the next generation can also answer.
    lastId: () => {
      if (ring.length && ring[ring.length - 1].seq === seq) return ring[ring.length - 1].event.id;
      if (!seq && baseline != null) return `g${baseline}`;
      return idOf(seq);
    },
    /** The feed's sequence value when it began (see `baseline` above); once. */
    setBaseline: (b) => {
      if (baseline == null && b != null && /^\d+$/.test(String(b))) {
        baseline = String(b);
        if (high == null || BigInt(baseline) > BigInt(high)) high = baseline;
      }
    },
    /** Whether the ring still holds the event with this id. */
    holds: (id) => ring.some((r) => r.event.id === id),
    /** The highest global number seen (published or the baseline), or null. */
    highGid: () => high,
    subscribers: () => subs.size,
  };
}

module.exports = { createBus, TOPIC, DEFAULT_CAPACITY };
