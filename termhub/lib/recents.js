'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDataDir } = require('./paths');

const MAX_RECENTS = 50;

function file() {
  return path.join(ensureDataDir(), 'recents.json');
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(data)) return data.filter((d) => typeof d === 'string');
  } catch {
    // missing or corrupt — start fresh
  }
  return [];
}

function save(list) {
  try {
    fs.writeFileSync(file(), JSON.stringify(list, null, 2));
  } catch {
    // best-effort; recents are non-critical
  }
}

// Most-recently-used list of directories visited via "open here" / new terminal.
function list() {
  return load();
}

function add(dir) {
  if (!dir || typeof dir !== 'string') return list();
  const normalized = dir.trim();
  if (!normalized) return list();
  const current = load().filter((d) => d !== normalized);
  current.unshift(normalized);
  const trimmed = current.slice(0, MAX_RECENTS);
  save(trimmed);
  return trimmed;
}

module.exports = { list, add };
