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

/**
 * @param {object} episode from toEpisodes
 * @param {Array} calendarEvents [{external_id, subject, occurred_at, raw:{end:{dateTime}, attendees, categories}}]
 */
function classify(episode, calendarEvents = []) {
  const start = ms(episode.started_at);
  const end = ms(episode.ended_at);

  for (const event of calendarEvents) {
    const evStart = ms(event.occurred_at);
    const evEndRaw = event.raw?.end?.dateTime;
    const evEnd = evEndRaw ? ms(`${evEndRaw}Z`.replace(/Z+$/, 'Z')) : evStart + 30 * 60_000;
    // A meeting you joined late or left early still overlaps its slot.
    if (start <= evEnd && evStart <= end) {
      return {
        kind: 'meeting',
        calendarEventId: event.external_id,
        title: event.subject,
        attendees: event.raw?.attendees || [],
      };
    }
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

module.exports = { toEpisodes, classify, renderTranscript, isSubstantial, DEFAULT_GAP_SECONDS };
