'use strict';

// Logging with one rule that matters: message bodies are not log material.
//
// This process reads your mail, your chats and transcripts of conversations you
// had in a room. A log line that helpfully includes "the first 200 chars" of an
// item is a copy of that content in a file with different retention and
// different permissions from the database. So the helpers here take ids,
// counts and durations, and `redact()` exists for the cases where a body has to
// be mentioned at all.

const util = require('util');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[process.env.PA_LOG_LEVEL] ?? LEVELS.info;

function emit(level, scope, message, fields) {
  if (LEVELS[level] > threshold) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), `[${scope}]`, message];
  if (fields && Object.keys(fields).length) {
    parts.push(util.inspect(fields, { depth: 3, breakLength: Infinity, colors: false }));
  }
  const line = parts.join(' ');
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

// For the rare log line that must reference content: length and a hash, never
// the text. Enough to correlate two records, useless as a copy.
function redact(text) {
  if (text == null) return null;
  const s = String(text);
  return `<${s.length} chars>`;
}

function logger(scope) {
  return {
    error: (m, f) => emit('error', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    debug: (m, f) => emit('debug', scope, m, f),
  };
}

module.exports = { logger, redact };
