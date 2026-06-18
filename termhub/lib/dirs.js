'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// Directory autocomplete: given a partial path (possibly with a leading ~),
// return matching subdirectories so the UI can suggest them as the user types.
// Suggestions preserve the input's style (keep ~ if the user typed ~) so native
// <datalist> filtering keeps matching.
function suggestDirs(input) {
  const home = os.homedir();
  const raw = String(input || '');
  const usedTilde = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\');

  const rawTrimmed = raw.trim();
  // A trailing separator means "list everything inside"; otherwise treat the last
  // segment as a prefix to match within its parent. Read this off the raw input —
  // path.join() drops a trailing separator (so a bare "~/" would otherwise look
  // like just "~" and list the wrong directory).
  const trailing = rawTrimmed.endsWith('/') || rawTrimmed.endsWith('\\');

  let expanded = rawTrimmed;
  if (expanded === '~') expanded = home;
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = path.join(home, expanded.slice(2));
  if (!expanded) expanded = home;

  let dir, prefix;
  if (trailing) { dir = expanded; prefix = ''; }
  else { dir = path.dirname(expanded); prefix = path.basename(expanded); }

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const plc = prefix.toLowerCase();
  const out = [];
  for (const e of entries) {
    if (plc ? !e.name.toLowerCase().startsWith(plc) : e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; } }
    if (!isDir) continue;
    const display = usedTilde && (full === home || full.startsWith(home + path.sep))
      ? '~' + full.slice(home.length)
      : full;
    out.push(display);
    if (out.length >= 50) break;
  }
  out.sort();
  return out;
}

module.exports = { suggestDirs };
