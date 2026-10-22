'use strict';

// Turning speech groups into episodes.
//
// The Python side hands over one sidecar per speech group per stream. This
// pairs the two streams back together: a group of *your* speech that overlaps a
// group of *their* speech is one conversation, and it is worth exactly one
// entry in the store rather than two half-transcripts nobody can align.
//
// Classification is deliberately evidence-based and admits ignorance. An
// episode overlapping a calendar entry is a meeting and inherits its title and
// attendees. One with both streams and no calendar entry is a call. One with
// only the mic is you talking — to someone in the room, or to a dictation
// hotkey. Anything else is ambient, which is a real category and not a failure.

const DEFAULT_GAP_SECONDS = 90;

function ms(iso) {
  return new Date(iso).getTime();
}

function overlaps(a, b, toleranceMs) {
  return ms(a.started_at) - toleranceMs <= ms(b.ended_at) && ms(b.started_at) - toleranceMs <= ms(a.ended_at);
}

/**
 * Groups sidecars from both streams into episodes.
 * @param {Array} sidecars parsed sidecar objects
 * @param {object} options {gapSeconds}
 */
function toEpisodes(sidecars, { gapSeconds = DEFAULT_GAP_SECONDS } = {}) {
  const tolerance = gapSeconds * 1000;
  const sorted = [...sidecars].sort((a, b) => ms(a.started_at) - ms(b.started_at));
  const episodes = [];

  for (const sidecar of sorted) {
    const last = episodes[episodes.length - 1];
    if (last && overlaps(last, sidecar, tolerance)) {
      last.parts.push(sidecar);
      if (ms(sidecar.ended_at) > ms(last.ended_at)) last.ended_at = sidecar.ended_at;
      last.speech_seconds += sidecar.speech_seconds || 0;
    } else {
      episodes.push({
        started_at: sidecar.started_at,
        ended_at: sidecar.ended_at,
        speech_seconds: sidecar.speech_seconds || 0,
        parts: [sidecar],
      });
    }
  }

  return episodes.map((e) => ({
    ...e,
    streams: [...new Set(e.parts.map((p) => p.stream))].sort(),
  }));
}

// A calendar dateTime is zone-less UTC from this connector; an ISO string
// with a zone is read as one. Seven-digit fractions are trimmed to three.
function timeOf(t) {
  if (!t) return null;
  const raw = typeof t === 'string' ? t : t.dateTime;
  if (!raw) return null;
  const base = String(raw).replace(/(\.\d{3})\d*$/, '$1');
  const v = new Date(/Z$|[+-]\d\d:?\d\d$/.test(base) ? base : `${base}Z`).getTime();
  return Number.isFinite(v) ? v : null;
}

function eventRange(event) {
  const start = timeOf(event.raw?.start) ?? ms(event.occurred_at);
  const end = timeOf(event.raw?.end) ?? start + 30 * 60_000;
  return { start, end };
}

const CANCELLED = /^\s*(canceled|cancelled)\s*:/i;

// An event a conversation can belong to: not cancelled, not an all-day
// marker, not a slot you marked free.
function attendable(event) {
  const raw = event.raw || {};
  if (raw.isCancelled === true || CANCELLED.test(event.subject || '')) return false;
  if (raw.isAllDay === true) return false;
  if (String(raw.showAs || '').toLowerCase() === 'free') return false;
  const { start, end } = eventRange(event);
  return end - start < 12 * 3600_000;
}

/**
 * Cuts episodes where a calendar meeting starts in the middle of them.
 *
 * Talking straight from one meeting into the next produces no silence, so
 * the gap rule makes one episode of both — and a debrief then reads a
 * stand-up and a planning session as one meeting, linked to one of them.
 * A cut is made at an event's start when it falls inside the episode and no
 * other event spans it (you were in nothing, or in a meeting that ended
 * there); a meeting you are double-booked against is not a reason to cut.
 * Parts — one speech group of one stream — go to the side their midpoint is
 * on; capture files roll on the quarter-hour, which is where meetings start.
 *
 * @param {Array} episodes from toEpisodes
 * @param {Array} calendarEvents source_item rows for graph_event
 * @param {object} [opts] {edgeMs} how far inside the episode a start must be
 */
function splitAtEvents(episodes, calendarEvents = [], { edgeMs = 120_000 } = {}) {
  const events = calendarEvents.filter(attendable).map(eventRange);
  const out = [];
  for (const episode of episodes) {
    const start = ms(episode.started_at);
    const end = ms(episode.ended_at);
    const cuts = [...new Set(events.map((e) => e.start))]
      .filter((s) => s > start + edgeMs && s < end - edgeMs)
      .filter((s) => !events.some((o) => o.start < s - edgeMs && o.end > s + edgeMs))
      .sort((a, b) => a - b);
    if (!cuts.length) {
      out.push(episode);
      continue;
    }
    const buckets = cuts.map(() => []).concat([[]]);
    for (const part of episode.parts) {
      const mid = (ms(part.started_at) + ms(part.ended_at)) / 2;
      const i = cuts.findIndex((c) => mid < c);
      buckets[i < 0 ? cuts.length : i].push(part);
    }
    for (const parts of buckets) {
      if (!parts.length) continue;
      const sorted = [...parts].sort((a, b) => ms(a.started_at) - ms(b.started_at));
      out.push({
        started_at: sorted[0].started_at,
        ended_at: sorted.reduce((m, p) => (ms(p.ended_at) > ms(m) ? p.ended_at : m), sorted[0].ended_at),
        speech_seconds: sorted.reduce((n, p) => n + (p.speech_seconds || 0), 0),
        parts: sorted,
        streams: [...new Set(sorted.map((p) => p.stream))].sort(),
      });
    }
  }
  return out;
}

/**
 * Does a stored episode row differ from what the sidecars now say? Growth
 * (more speech, a later end), the other stream arriving, or a new calendar
 * link all count; a re-run over unchanged sidecars does not.
 */
function episodeChanged(row, episode, meta) {
  if (!row) return true;
  return (
    Math.abs(ms(row.ended_at) - ms(episode.ended_at)) > 1000 ||
    Math.abs(ms(row.started_at) - ms(episode.started_at)) > 1000 ||
    Math.abs(Number(row.speech_seconds) - episode.speech_seconds) > 1 ||
    row.stream !== episode.streams.join('+') ||
    row.kind !== meta.kind ||
    (row.calendar_event_id || null) !== (meta.calendarEventId || null)
  );
}

/**
 * @param {object} episode from toEpisodes
 * @param {Array} calendarEvents [{external_id, subject, occurred_at, raw:{end:{dateTime}, attendees, categories}}]
 */
function classify(episode, calendarEvents = []) {
  const start = ms(episode.started_at);
  const end = ms(episode.ended_at);

  // The event this conversation overlaps most. A meeting you joined late or
  // left early still overlaps its slot; one that ran into the next meeting
  // belongs to whichever slot holds more of it, not to whichever came first.
  // A brush with a slot — an hour-long conversation whose last four minutes
  // run into a meeting — is not that meeting: the overlap must be at least
  // half of the shorter of the two.
  let best = null;
  let bestOverlap = -1;
  for (const event of calendarEvents) {
    if (!attendable(event)) continue;
    const ev = eventRange(event);
    const overlap = Math.min(end, ev.end) - Math.max(start, ev.start);
    if (overlap < 0) continue;
    if (overlap < 0.5 * Math.min(end - start, ev.end - ev.start)) continue;
    if (overlap > bestOverlap) {
      best = event;
      bestOverlap = overlap;
    }
  }
  if (best) {
    return {
      kind: 'meeting',
      calendarEventId: best.external_id,
      title: best.subject,
      attendees: best.raw?.attendees || [],
    };
  }

  if (episode.streams.includes('loopback') && episode.streams.includes('mic')) {
    return { kind: 'call', calendarEventId: null, title: null, attendees: [] };
  }
  if (episode.streams.length === 1 && episode.streams[0] === 'mic') {
    return { kind: 'ambient', calendarEventId: null, title: null, attendees: [] };
  }
  return { kind: 'unknown', calendarEventId: null, title: null, attendees: [] };
}

// Interleaves the two streams into one readable transcript. Labels rather than
// names: the mic is you with certainty, the loopback is "them" with certainty,
// and guessing which of three people on a call said a line is exactly the kind
// of confident wrongness this design avoids by not mixing the streams.
function renderTranscript(episode) {
  return episode.parts
    .filter((p) => (p.transcript || '').trim())
    .sort((a, b) => ms(a.started_at) - ms(b.started_at))
    .map((p) => `${p.stream === 'mic' ? 'Me' : 'Them'}: ${p.transcript.trim()}`)
    .join('\n\n');
}

function isSubstantial(episode, { minSeconds = 20 } = {}) {
  return (
    episode.speech_seconds >= minSeconds &&
    episode.parts.some((p) => (p.transcript || '').trim().length > 40)
  );
}

module.exports = { toEpisodes, splitAtEvents, episodeChanged, classify, attendable, eventRange, renderTranscript, isSubstantial, DEFAULT_GAP_SECONDS };
