'use strict';

// The ingest registry, and the rule that one broken source does not stop the
// others: a tenant that refuses `Chat.Read` should not also cost you GitHub.
// Each source records its own error against its own cursor, and `pa doctor`
// reads those back.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const graphMail = require('./graphMail.ts');
const graphCalendar = require('./graphCalendar.ts');
const graphChat = require('./graphChat.ts');
const teamsLocal = require('./teamsLocal.ts');
const github = require('./github.ts');
const jira = require('./jira.ts');
const claudeSessions = require('./claudeSessions.ts');
const remoteSessions = require('./remoteSessions.ts');
const audio = require('./audio.ts');
const { recordError } = require('./store.ts');
const { logger } = require('../log.ts');

const log = logger('ingest');

const SOURCES = [graphMail, graphCalendar, teamsLocal, graphChat, github, jira, claudeSessions, remoteSessions, audio];

function byId(id: any) {
  return SOURCES.find((s) => s.id === id) || null;
}

async function runOne(source: any) {
  const started = Date.now();
  try {
    const changed = await source.run();
    return { source: source.id, changed, ms: Date.now() - started, error: null as any };
  } catch (err: any) {
    await recordError(source.id, err.message).catch(() => {});
    log.warn('source failed', { source: source.id, message: err.message });
    return { source: source.id, changed: 0, ms: Date.now() - started, error: err.message };
  }
}

async function runAll(only: any) {
  const selected = only && only.length ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
  const results: any[] = [];
  for (const source of selected) {
    results.push(await runOne(source));
  }
  return results;
}

module.exports = { SOURCES, runAll, runOne, byId };
