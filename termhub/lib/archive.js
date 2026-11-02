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
// sessiond is the only writer, so the trivial read-modify-write below is safe.
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

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(data)) return data.filter((e) => e && typeof e === 'object' && e.id);
  } catch {
    // missing or corrupt — start fresh
  }
  return [];
}

function save(list) {
  const f = file();
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE); // `mode` only applies on create; a stale tmp keeps its own
    fs.renameSync(tmp, f);
  } catch {
    // best-effort; persistence is a convenience, never block a session on it
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

function list() {
  return load();
}

function get(id) {
  return load().find((e) => e.id === id) || null;
}

// Insert or replace an entry, newest first, capped at MAX_ENTRIES.
function upsert(entry) {
  if (!entry || !entry.id) return;
  const rest = load().filter((e) => e.id !== entry.id);
  rest.unshift(entry);
  save(rest.slice(0, MAX_ENTRIES));
}

// Merge fields into an existing entry (no-op if it's gone).
function patch(id, fields) {
  const all = load();
  const e = all.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, fields);
  save(all);
}

function remove(id) {
  save(load().filter((e) => e.id !== id));
}

// Append a typed command line to a shell session's history, deduping immediate
// repeats and capping length. Lines arrive infrequently (one per Enter), so the
// per-line read-modify-write is cheap enough.
function addHistory(id, line) {
  const clean = String(line || '').trim();
  if (!clean) return;
  const all = load();
  const e = all.find((x) => x.id === id);
  if (!e) return;
  if (!Array.isArray(e.history)) e.history = [];
  if (e.history[e.history.length - 1] === clean) return; // skip an immediate repeat
  e.history.push(clean);
  if (e.history.length > MAX_HISTORY) e.history = e.history.slice(-MAX_HISTORY);
  save(all);
}

module.exports = { list, get, upsert, patch, remove, addHistory, MAX_HISTORY, FILE_MODE };
