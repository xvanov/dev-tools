#!/usr/bin/env node
// Claude Code status line: "k@host:/some/dir | Ctx: 30k/200k (15%)".
//
// Claude Code pipes a JSON status payload on stdin and renders our stdout verbatim,
// so this must never throw: a crash means an empty status line with no clue why.
// Every field is therefore optional with a fallback.

let j = {};
try {
  j = JSON.parse(require('fs').readFileSync(0, 'utf8')) || {};
} catch {
  // Unparseable or empty stdin — still print the prompt half below.
}

const GREEN = '\x1b[01;32m';
const BLUE = '\x1b[01;34m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[00m';

const cwd = j.workspace?.current_dir || j.cwd || process.cwd();
const user = process.env.USER || process.env.USERNAME || require('os').userInfo().username;
const host = require('os').hostname().split('.')[0];

// The first render of a session arrives before any tokens are counted, so
// used_percentage is absent. Printing "0k" there would be a lie that looks like
// a working meter; "Ready" says "no data yet" instead.
const total = j.context_window?.context_window_size || 200000;
const pct = j.context_window?.used_percentage;
const totalK = Math.floor(total / 1000);

const ctx =
  typeof pct === 'number'
    ? `Ctx: ${Math.floor((pct * total) / 100 / 1000)}k/${totalK}k (${Math.floor(pct)}%)`
    : 'Ctx: Ready';

console.log(`${GREEN}${user}@${host}${RESET}:${BLUE}${cwd}${RESET} | ${YELLOW}${ctx}${RESET}`);
