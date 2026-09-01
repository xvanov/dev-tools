'use strict';

// The ingest registry, and the rule that one broken source does not stop the
// others: a tenant that refuses `Chat.Read` should not also cost you GitLab.
// Each source records its own error against its own cursor, and `pa doctor`
// reads those back.

const graphMail = require('./graphMail');
const graphCalendar = require('./graphCalendar');
const graphChat = require('./graphChat');
const gitlab = require('./gitlab');
const claudeSessions = require('./claudeSessions');
const audio = require('./audio');
const { recordError } = require('./store');
const { logger } = require('../log');

const log = logger('ingest');

const SOURCES = [graphMail, graphCalendar, graphChat, gitlab, claudeSessions, audio];

function byId(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

async function runOne(source) {
  const started = Date.now();
  try {
    const changed = await source.run();
    return { source: source.id, changed, ms: Date.now() - started, error: null };
  } catch (err) {
    await recordError(source.id, err.message).catch(() => {});
    log.warn('source failed', { source: source.id, message: err.message });
    return { source: source.id, changed: 0, ms: Date.now() - started, error: err.message };
  }
}

async function runAll(only) {
  const selected = only && only.length ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
  const results = [];
  for (const source of selected) {
    results.push(await runOne(source));
  }
  return results;
}

module.exports = { SOURCES, runAll, runOne, byId };
