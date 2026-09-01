'use strict';

// Calendar ingest.
//
// Two jobs, only one of which is obvious. The obvious one is `pa brief` knowing
// what your day looks like. The second one is classification: an audio episode
// that overlaps a calendar entry is a *meeting* with a title and an attendee
// list, and one that doesn't is ambient. Without the calendar, every recording
// is an anonymous blob of speech.
//
// `calendarView` rather than `/events` because it expands recurrence: a weekly
// stand-up is one event resource and fifty occurrences, and it is the
// occurrence that overlaps this morning's audio.

const { getDelta } = require('../graph/client');
const { saveItems, getCursor } = require('./store');
const { htmlToText } = require('../util/text');

const WINDOW_BACK_DAYS = 7;
const WINDOW_FORWARD_DAYS = 30;

function windowUrl() {
  const start = new Date(Date.now() - WINDOW_BACK_DAYS * 86400_000).toISOString();
  const end = new Date(Date.now() + WINDOW_FORWARD_DAYS * 86400_000).toISOString();
  return `/me/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
}

function toItem(ev) {
  const attendees = (ev.attendees || [])
    .map((a) => a.emailAddress?.address?.toLowerCase())
    .filter(Boolean);
  const body = ev.body?.contentType === 'html' ? htmlToText(ev.body.content) : ev.body?.content || '';

  return {
    externalId: ev.id,
    threadExternalId: ev.seriesMasterId || ev.iCalUId || null,
    occurredAt: ev.start?.dateTime ? `${ev.start.dateTime}Z` : new Date().toISOString(),
    authorIdentity: ev.organizer?.emailAddress?.address?.toLowerCase() || null,
    subject: ev.subject || '(untitled meeting)',
    bodyText: body,
    raw: {
      start: ev.start,
      end: ev.end,
      isOnlineMeeting: !!ev.isOnlineMeeting,
      isCancelled: !!ev.isCancelled,
      showAs: ev.showAs,
      categories: ev.categories || [],
      attendees,
      location: ev.location?.displayName || null,
    },
  };
}

async function run() {
  const cursorKey = 'graph_event';
  const cursor = await getCursor(cursorKey);

  // The delta token encodes the original window. Once the window has drifted
  // far enough that "30 days out" no longer covers next month, start a fresh
  // one — a stale window silently stops returning newly scheduled meetings.
  const state = cursor?.state || {};
  const windowAgeDays = state.openedAt
    ? (Date.now() - new Date(state.openedAt).getTime()) / 86400_000
    : Infinity;
  const reopen = windowAgeDays > 7;

  const { items, deltaLink } = await getDelta(
    windowUrl(),
    reopen ? null : cursor?.delta_token,
    { headers: { Prefer: 'odata.maxpagesize=50' } }
  );

  const usable = items.filter((e) => e.id && !e['@removed']).map(toItem);

  return saveItems('graph_event', usable, {
    source: cursorKey,
    deltaToken: deltaLink,
    state: { openedAt: reopen || !state.openedAt ? new Date().toISOString() : state.openedAt },
  });
}

module.exports = { run, id: 'graph_event', toItem };
