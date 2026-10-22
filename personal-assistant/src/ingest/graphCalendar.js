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

function occurrenceId(ev) {
  return `${ev.id}@${isoOf(ev.start) || 'unknown'}`;
}

function toItem(ev) {
  const attendees = (ev.attendees || []).map((a) => String(a).toLowerCase()).filter((a) => a.includes('@'));
  const start = isoOf(ev.start);
  // Every occurrence of a recurring meeting comes back with the series' id,
  // so the id alone made each occurrence overwrite the last — the store kept
  // one row per series, dated at its furthest occurrence, and "today's
  // stand-up" did not exist. The start time makes an occurrence an occurrence;
  // the bare id threads them into a series.
  return {
    externalId: occurrenceId(ev),
    threadExternalId: ev.seriesMasterId || (ev.recurrence ? ev.id : null),
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

// The windows a pass reads. One search over five weeks silently lost the
// current week — the connector pages 25 at a time and the relay does not
// reliably walk every page of a wide range — and the current week is the one
// that matters (briefs, audio classification). So: the near window (two days
// back, eight forward) every pass, and the rest of the five weeks in week-sized
// slices at most hourly. Pure, so the split is testable.
const NEAR_BACK_DAYS = 2;
const NEAR_FORWARD_DAYS = 8;
const FAR_EVERY_MS = 3600_000;

function windows(now, { lastFarAt = null } = {}) {
  const day = 86400_000;
  const t = now.getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const out = [[iso(t - NEAR_BACK_DAYS * day), iso(t + NEAR_FORWARD_DAYS * day)]];
  const far = !lastFarAt || t - new Date(lastFarAt).getTime() >= FAR_EVERY_MS;
  if (far) {
    out.push([iso(t - WINDOW_BACK_DAYS * day), iso(t - NEAR_BACK_DAYS * day)]);
    for (let start = NEAR_FORWARD_DAYS; start < WINDOW_FORWARD_DAYS; start += 7) {
      out.push([iso(t + start * day), iso(t + Math.min(start + 7, WINDOW_FORWARD_DAYS) * day)]);
    }
  }
  return { windows: out, far };
}

async function run() {
  await m365.whoAmI();
  const now = new Date();
  const cursor = await require('./store').getCursor('graph_event');
  const plan = windows(now, { lastFarAt: cursor?.state?.lastFarAt });

  const byId = new Map();
  for (const [after, before] of plan.windows) {
    const events = await m365.search('outlook_calendar_search', {
      query: '*',
      afterDateTime: after,
      beforeDateTime: before,
      order: 'oldest',
      limit: 25,
    });
    for (const ev of events) byId.set(occurrenceId(ev), ev);
  }
  const events = [...byId.values()];
  const changed = await saveItems('graph_event', events.map(toItem), {
    source: 'graph_event',
    deltaToken: null,
    state: {
      window: [plan.windows[0][0], plan.windows[0][1]],
      lastFarAt: plan.far ? now.toISOString() : cursor?.state?.lastFarAt || null,
    },
  });
  log.info('relayed', { events: events.length, windows: plan.windows.length, changed });
  return changed;
}

module.exports = { run, id: 'graph_event', toItem, isoOf, windows, occurrenceId };
