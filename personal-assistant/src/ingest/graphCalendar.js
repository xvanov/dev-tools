'use strict';

// Calendar ingest, through the Microsoft 365 connector (see m365.js).
//
// Two jobs, only one of which is obvious. The obvious one is `pa brief` knowing
// what your day looks like. The second one is classification: an audio episode
// that overlaps a calendar entry is a *meeting* with a title and an attendee
// list, and one that doesn't is ambient. Without the calendar, every recording
// is an anonymous blob of speech.
//
// A window, not a cursor: a week back and a month forward, re-read each pass.
// Meetings move, and the content hash makes an unchanged occurrence a no-op.
// The search expands recurrence, so a weekly stand-up arrives as this week's
// occurrence — the one that overlaps this morning's audio.
//
// Teams meeting transcripts would be the better record of a meeting, and the
// connector is granted the scope, but this tenant switches Graph transcript
// access off — so meetings are captured by the local audio streams instead.

const m365 = require('./m365');
const { saveItems } = require('./store');
const { logger } = require('../log');

const log = logger('calendar');

const WINDOW_BACK_DAYS = 7;
const WINDOW_FORWARD_DAYS = 30;

// {dateTime, timeZone} → ISO. The connector reports the mailbox zone or UTC;
// only UTC (and its spellings) can be read without a zone database, which is
// what this mailbox returns.
function isoOf(t) {
  if (!t?.dateTime) return null;
  const zone = String(t.timeZone || 'UTC');
  const base = t.dateTime.replace(/\.\d+$/, '');
  return /^(utc|gmt|etc\/utc)$/i.test(zone) ? `${base}Z` : base;
}

function toItem(ev) {
  const attendees = (ev.attendees || []).map((a) => String(a).toLowerCase()).filter((a) => a.includes('@'));
  const start = isoOf(ev.start);
  return {
    externalId: ev.id,
    threadExternalId: ev.seriesMasterId || null,
    occurredAt: start || new Date().toISOString(),
    authorIdentity: ev.organizer ? String(ev.organizer).toLowerCase() : null,
    subject: ev.subject || '(untitled meeting)',
    bodyText: ev.summary || '',
    raw: {
      start: ev.start,
      end: ev.end,
      isOnlineMeeting: /teams/i.test(String(ev.location || '')),
      isCancelled: !!ev.isCancelled,
      showAs: ev.showAs,
      categories: ev.categories || [],
      attendees,
      location: ev.location || null,
      webLink: ev.webLink || null,
    },
  };
}

async function run() {
  await m365.whoAmI();
  const after = new Date(Date.now() - WINDOW_BACK_DAYS * 86400_000).toISOString();
  const before = new Date(Date.now() + WINDOW_FORWARD_DAYS * 86400_000).toISOString();
  const events = await m365.search('outlook_calendar_search', {
    query: '*',
    afterDateTime: after,
    beforeDateTime: before,
    order: 'oldest',
    limit: 25,
  });
  const changed = await saveItems('graph_event', events.map(toItem), {
    source: 'graph_event',
    deltaToken: null,
    state: { window: [after, before] },
  });
  log.info('relayed', { events: events.length, changed });
  return changed;
}

module.exports = { run, id: 'graph_event', toItem, isoOf };
