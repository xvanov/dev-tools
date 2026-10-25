'use strict';

// Claude sessions from the other machines in PA_MACHINES, read through each
// machine's termhub.
//
// A run dispatched with `--machine` does its work on that machine's disk: the
// fix branch, the PR it opened, what it said it did. Its transcript stays
// there, so until now none of it could count as evidence that a commitment was
// done (DURABLE.md §1 point 3). termhub is already reachable on every machine
// and serves `~/.claude/projects/` read-only (`GET /api/claude/transcripts`,
// `GET /api/claude/transcript?id=`, termhub/lib/transcripts.js), so this pass
// reads them from there and stores them exactly as the local pass does —
// same parser, same item (claudeSessions.parseTranscript / toItem) — with
// `raw.machine` set and ids prefixed `<machine>:` so they cannot collide.
//
// Incremental: each machine has its own cursor, `claude_session@<machine>`,
// whose state remembers the mtime and size of every transcript it read. Only a
// transcript that is new or changed is fetched again. A machine that is off,
// unreachable, or running a termhub too old to have the route is a skipped
// pass with `last_error` on its own cursor — never a failure of the others,
// and never a crash.
//
//   plan(listing, known, max)   pure: which transcripts to fetch, what to keep
//   describeError(err, name)    pure: what `pa doctor` should say
//   run()                       the worker's pass

const os = require('os');
const { config } = require('../config');
const { saveItems, saveCursor, getCursor, recordError } = require('./store');
const { parseTranscript, toItem } = require('./claudeSessions');
const { logger } = require('../log');

const log = logger('remote-sessions');

const LIST_LIMIT = 100;
// Fetching is the cost; a first pass against a machine with a long history is
// spread over several passes, newest first, rather than done in one.
const MAX_FETCH_PER_PASS = 20;

const cursorKey = (machine) => `claude_session@${machine}`;

/**
 * Pure. `listing` is termhub's [{id, mtimeMs, size}] (newest first); `known`
 * is the cursor's {id: {mtimeMs, size}}. Returns the entries to fetch (new or
 * changed, at most `max`) and the state to carry forward: what was already
 * known and is still listed, unchanged. A fetched transcript is added to the
 * state by the caller only once it has been read, so a failed fetch is retried.
 * A transcript that fell out of the listing is forgotten — it is old, and if
 * it changes again its new mtime puts it back at the top.
 */
// Only sessions touched in the last week. A machine's first pass once read its
// hundred newest transcripts back to August and made 79 to-dos out of them —
// an automation VM's long-finished work among them.
const MAX_AGE_MS = 7 * 86400_000;

function plan(listing, known = {}, max = MAX_FETCH_PER_PASS, now = Date.now()) {
  const fetch = [];
  const keep = {};
  for (const t of listing || []) {
    if (!t || typeof t.id !== 'string') continue;
    if (!(now - Number(t.mtimeMs) <= MAX_AGE_MS)) continue;
    const k = known[t.id];
    if (k && k.mtimeMs === t.mtimeMs && k.size === t.size) {
      keep[t.id] = k;
    } else if (fetch.length < max) {
      fetch.push(t);
    } else if (k) {
      // Changed, but over this pass's budget: keep the old mark so it is still
      // seen as changed next pass.
      keep[t.id] = k;
    }
  }
  return { fetch, keep };
}

/** Pure: the one line `pa doctor` shows for a machine whose pass was skipped. */
function describeError(err, machine) {
  const status = err && err.status;
  const message = String((err && err.message) || err || 'unknown error');
  if (status === 404 && /not found/i.test(message)) {
    return `termhub on ${machine} is too old to serve transcripts — update it (termhub/windows/update.ps1 on that machine)`;
  }
  if (!status) return `termhub on ${machine} unreachable: ${message}`.slice(0, 500);
  return `termhub on ${machine}: ${message}`.slice(0, 500);
}

/** Pure: the remote machines to read — PA_MACHINES minus this one. */
function machinesToRead(machines = config.termhub.machines, hostname = os.hostname()) {
  return Object.values(machines || {}).filter((m) => m && m.name && m.name !== hostname);
}

async function runMachine(machine, termhub) {
  const key = cursorKey(machine.name);
  const hub = termhub.client(machine.url);
  const listing = await hub.claudeTranscripts({ limit: LIST_LIMIT });
  const cursor = await getCursor(key);
  const { fetch, keep } = plan(listing, cursor?.state?.files || {});

  const items = [];
  let failed = 0;
  for (const t of fetch) {
    let text;
    try {
      text = await hub.claudeTranscript(t.id);
    } catch (err) {
      // One unreadable file (deleted, over the size cap) does not cost the rest.
      failed++;
      log.debug('transcript fetch failed', { machine: machine.name, status: err.status || null });
      if (err.status === 413) keep[t.id] = { mtimeMs: t.mtimeMs, size: t.size }; // will not get smaller
      continue;
    }
    keep[t.id] = { mtimeMs: t.mtimeMs, size: t.size };
    const parsed = parseTranscript(text);
    if (parsed.turns.length) items.push(toItem(parsed, t.id, { machine: machine.name }));
  }

  const state = { files: keep, listed: listing.length, fetched: fetch.length - failed, failed };
  if (items.length) return saveItems('claude_session', items, { source: key, deltaToken: null, state });
  await saveCursor({ source: key, deltaToken: null, state });
  return 0;
}

async function run() {
  const termhub = require('../dispatch/termhub');
  let changed = 0;
  for (const machine of machinesToRead()) {
    try {
      changed += await runMachine(machine, termhub);
    } catch (err) {
      const message = describeError(err, machine.name);
      log.warn('machine skipped', { machine: machine.name, message });
      await recordError(cursorKey(machine.name), message).catch(() => {});
    }
  }
  return changed;
}

module.exports = { run, id: 'claude_session_remote', plan, describeError, machinesToRead, cursorKey, runMachine, MAX_FETCH_PER_PASS };
