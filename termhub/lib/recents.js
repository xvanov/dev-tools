'use strict';

// Most-recently-used directories ("open here" / new terminal), recents.json in
// the data dir. Read once, kept in memory, written off the event loop: add()
// runs on every session create, and a synchronous read+write of this file
// measured over a second on a loaded Windows laptop, stalling every request
// behind it (see lib/archive.js, same fix). A deliberate stop flushes.

const fs = require('fs');
const path = require('path');
const { ensureDataDir } = require('./paths');

const MAX_RECENTS = 50;

let cache = null;     // { file, list }
let writing = null;
let again = false;
let exitHooked = false;

function file() {
  return path.join(ensureDataDir(), 'recents.json');
}

function load() {
  const f = file();
  if (cache && cache.file === f) return cache.list;
  let list = [];
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(data)) list = data.filter((d) => typeof d === 'string');
  } catch {
    // missing or corrupt — start fresh
  }
  cache = { file: f, list };
  return list;
}

function flushSync() {
  if (!cache) return;
  try {
    fs.writeFileSync(cache.file, JSON.stringify(cache.list, null, 2));
  } catch {
    // best-effort; recents are non-critical
  }
}

function save() {
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', flushSync);
  }
  if (writing) { again = true; return; }
  const { file: f, list } = cache;
  writing = fs.promises.writeFile(f, JSON.stringify(list, null, 2))
    .catch(() => { /* best-effort; recents are non-critical */ })
    .finally(() => {
      writing = null;
      if (again) { again = false; save(); }
    });
}

/** Resolves once everything added so far is on disk (tests). */
async function flush() {
  while (writing) await writing;
}

function list() {
  return [...load()];
}

function add(dir) {
  if (!dir || typeof dir !== 'string') return list();
  const normalized = dir.trim();
  if (!normalized) return list();
  const current = load().filter((d) => d !== normalized);
  current.unshift(normalized);
  cache.list = current.slice(0, MAX_RECENTS);
  save();
  return [...cache.list];
}

module.exports = { list, add, flush, flushSync };
