'use strict';

// Logging with one rule that matters: message bodies are not log material.
//
// This process reads your mail, your chats and transcripts of conversations you
// had in a room. A log line that helpfully includes "the first 200 chars" of an
// item is a copy of that content in a file with different retention and
// different permissions from the database. So the helpers here take ids,
// counts and durations, and `redact()` exists for the cases where a body has to
// be mentioned at all.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Level = 'error' | 'warn' | 'info' | 'debug';
type Fields = Record<string, unknown> | null | undefined;

const util = require('util');

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[process.env.PA_LOG_LEVEL ?? ''] ?? 2;

function emit(level: Level, scope: string, message: string, fields: Fields) {
  if ((LEVELS[level] as number) > threshold) return;
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
function redact(text: unknown) {
  if (text == null) return null;
  const s = String(text);
  return `<${s.length} chars>`;
}

function logger(scope: string) {
  return {
    error: (m: string, f?: Fields) => emit('error', scope, m, f),
    warn: (m: string, f?: Fields) => emit('warn', scope, m, f),
    info: (m: string, f?: Fields) => emit('info', scope, m, f),
    debug: (m: string, f?: Fields) => emit('debug', scope, m, f),
  };
}

module.exports = { logger, redact };
