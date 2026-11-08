'use strict';

// termhub's own settings file: `KEY=value` lines in termhub/.env, then the
// repo's .env (the personal-assistant's convention). Only the deploy switches
// live here (TERMHUB_FRONT, TERMHUB_PTYD, lib/launch.ts): the process
// environment wins over both files, and nothing here is exported into it.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const fs = require('fs');
const path = require('path');

const TERMHUB = path.join(__dirname, '..');
const FILES = [path.join(TERMHUB, '.env'), path.join(TERMHUB, '..', '.env')];

/** Pure. `KEY=value` lines; `#` comments, `export `, and matching quotes allowed. */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || !m[1]) continue;
    let v = m[2] ?? '';
    const q = /^(["'])(.*)\1$/.exec(v);
    if (q) v = q[2] ?? '';
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** `name` from the first file that sets it, with that file; undefined when none does. */
function lookup(name: string, files: string[] = FILES): { value: string; file: string } | undefined {
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const v = parse(text)[name];
    if (v !== undefined && v !== '') return { value: v, file };
  }
  return undefined;
}

module.exports = { parse, lookup, FILES };
