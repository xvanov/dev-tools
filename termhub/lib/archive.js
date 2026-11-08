'use strict';

// termhub session archive — the bit of state that OUTLIVES a reboot.
//
// sessiond keeps live terminals (PTYs) only in memory, so a machine restart
// wipes them and the sidebar comes up empty. This module mirrors each session's
// *metadata* (cwd, the command it was started with, its kind, and — for shell
// sessions — the command lines typed in it) to `sessions.json` in the data dir.
// After a reboot those entries become "restorable": the UI offers to re-open a
// Claude session with `--resume`, or a shell with its recorded history printed
// so the user can rebuild state by hand. PTYs themselves can't be resurrected;
// this is the next best thing.
//
// sessiond is the only writer, so it can keep the list in memory and only write
// it out (see "The archive lives in memory" below).
//
// The file is PRIVATE (mode 0600): a shell session's history is every command
// line typed in it, which routinely includes tokens and passwords pasted on a
// command line. It is written to a temp file created 0600 and renamed over the
// old one (so a crash mid-write cannot leave half a file either), and an
// existing file from before this rule is chmod'ed to 0600 the first time it is
// touched. On Windows the mode is a no-op; the data dir under %LOCALAPPDATA% is
// already per-user.

const fs = require('fs');
const path = require('path');
const { ensureDataDir } = require('./paths');

const MAX_ENTRIES = 40;   // cap the restorable list so it can't grow without bound
const MAX_HISTORY = 200;  // command lines kept per shell session

const FILE_MODE = 0o600;
let tightened = null; // the path already chmod'ed this process

function file() {
  const f = path.join(ensureDataDir(), 'sessions.json');
  if (tightened !== f) {
    tightened = f;
    try { fs.chmodSync(f, FILE_MODE); } catch { /* not there yet */ }
  }
  return f;
}

// The archive lives in memory and is written to disk in the background.
//
// It used to be a synchronous read-modify-write of sessions.json on every
// create, exit and typed command line. On Windows each writeFileSync+renameSync
// measured 250-1350 ms (the file is rescanned on every rename), and it ran on
// sessiond's event loop, so every request queued behind it: a session create
// that lands behind a few of them took seconds (2026-11-08, a factory follow
// session ~8.8 s). Now the file is read once, every change is made in memory,
// and the write happens off the loop: coalesced (one write per WRITE_DELAY_MS
// burst) and never two at once. flushSync() writes immediately; it runs on
// process exit, so an orderly stop (SIGINT/SIGTERM, which sessiond turns into
// process.exit) loses nothing. A hard kill (TerminateProcess on Windows,
// SIGKILL) loses what changed in the last ~100 ms plus the write in flight: a
// rename or a typed line made in the same instant as the kill.
const WRITE_DELAY_MS = 100;

let cache = null;        // { file, entries }
let timer = null;
let writing = null;      // the in-flight async write
let dirtyAgain = false;  // changed while a write was in flight
let exitHooked = false;

function readDisk(f) {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(data)) return data.filter((e) => e && typeof e === 'object' && e.id);
  } catch {
    // missing or corrupt — start fresh
  }
  return [];
}

function entries() {
  const f = file();
  if (!cache || cache.file !== f) cache = { file: f, entries: readDisk(f) };
  return cache.entries;
}

function serialize() {
  return JSON.stringify(cache.entries, null, 2);
}

function writeSync(f, data) {
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE); // `mode` only applies on create; a stale tmp keeps its own
    fs.renameSync(tmp, f);
  } catch {
    // best-effort; persistence is a convenience, never block a session on it
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

async function writeAsync(f, data) {
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, { mode: FILE_MODE });
    await fs.promises.chmod(tmp, FILE_MODE);
    await fs.promises.rename(tmp, f);
  } catch {
    try { await fs.promises.unlink(tmp); } catch { /* nothing to clean */ }
  }
}

function startWrite() {
  timer = null;
  if (!cache) return;
  if (writing) { dirtyAgain = true; return; }
  const { file: f } = cache;
  writing = writeAsync(f, serialize()).finally(() => {
    writing = null;
    if (dirtyAgain) { dirtyAgain = false; schedule(); }
  });
}

function schedule() {
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', flushSync);
  }
  if (!timer) {
    timer = setTimeout(startWrite, WRITE_DELAY_MS);
    if (timer.unref) timer.unref();
  }
}

/** Write the archive now, synchronously (process exit, tests). */
function flushSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  dirtyAgain = false;
  if (cache) writeSync(cache.file, serialize());
}

/** Resolves once everything changed so far is on disk. */
async function flush() {
  for (;;) {
    if (timer) { clearTimeout(timer); startWrite(); }
    if (!writing) return;
    await writing; // a change made meanwhile schedules another write; loop for it
  }
}

const copy = (e) => JSON.parse(JSON.stringify(e));

function list() {
  return entries().map(copy);
}

function get(id) {
  const e = entries().find((x) => x.id === id);
  return e ? copy(e) : null;
}

// Insert or replace an entry, newest first, capped at MAX_ENTRIES.
function upsert(entry) {
  if (!entry || !entry.id) return;
  const rest = entries().filter((e) => e.id !== entry.id);
  rest.unshift(copy(entry));
  cache.entries = rest.slice(0, MAX_ENTRIES);
  schedule();
}

// Merge fields into an existing entry (no-op if it's gone).
function patch(id, fields) {
  const e = entries().find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, copy(fields));
  schedule();
}

function remove(id) {
  const all = entries();
  const rest = all.filter((e) => e.id !== id);
  if (rest.length === all.length) return;
  cache.entries = rest;
  schedule();
}

// Append a typed command line to a shell session's history, deduping immediate
// repeats and capping length.
function addHistory(id, line) {
  const clean = String(line || '').trim();
  if (!clean) return;
  const e = entries().find((x) => x.id === id);
  if (!e) return;
  if (!Array.isArray(e.history)) e.history = [];
  if (e.history[e.history.length - 1] === clean) return; // skip an immediate repeat
  e.history.push(clean);
  if (e.history.length > MAX_HISTORY) e.history = e.history.slice(-MAX_HISTORY);
  schedule();
}

module.exports = { list, get, upsert, patch, remove, addHistory, flush, flushSync, MAX_HISTORY, FILE_MODE, WRITE_DELAY_MS };
