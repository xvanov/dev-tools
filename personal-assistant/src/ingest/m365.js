'use strict';

// Microsoft 365, through the claude.ai connector.
//
// There is no Entra app registration here and no Graph token: the operator's
// claude.ai Microsoft 365 connector (connected once with `/mcp`) already holds
// a delegated sign-in, and a headless `claude -p` can call its tools. What the
// connector grants is decided by IT on its enterprise app, not by this code —
// `pa doctor` asks it with get_granted_scopes.
//
// Every call goes through `llm.toolCalls`, which returns the tools' own
// results from the event stream. The model picks the calls (it has to — that
// is the only way to reach the connector) but never retypes the data, so a
// message body arrives exactly as Graph returned it.
//
// The pattern each source follows: one session to search since the cursor,
// then one session to read the full bodies the search only previewed. Search
// results carry a ~250-character summary; anything that does not fit is read
// with read_resource, up to a cap, and the rest keep their summary and are
// marked `partial` rather than dropped.

const llm = require('../llm');
const identity = require('../distill/identity');
const { getCursor, saveItems } = require('./store');
const { logger } = require('../log');

const log = logger('m365');

const PREFIX = 'mcp__claude_ai_Microsoft_365__';
const tool = (name) => PREFIX + name;

// The search tools return at most 25 per page. A pass reads at most this many
// pages, so a backlog (first run, a week offline) drains over several passes
// instead of one ten-minute session.
const MAX_PAGES = 8;
const MAX_READS = 40;

// What the model may see of a result (see llm.toolCalls): a search page must
// be visible so it can follow `nextOffset`; a read never needs to be, so it
// spills to disk and leaves the session's context empty.
const SEARCH_VISIBLE_TOKENS = 40_000;
const READ_VISIBLE_TOKENS = 500;

// Senders whose mail is either noise or already ingested from its own source:
// GitHub and Jira notifications come in through `gh` and the Atlassian relay.
const AUTOMATED_SENDER =
  /(^|[.@])(notifications@github\.com|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|jira@|confluence@)|@(atlassian\.net|teams\.microsoft\.com|github\.com)$/i;

function isAutomated(address) {
  return !address || AUTOMATED_SENDER.test(String(address));
}

// "Since" with an hour of overlap, as the other sources do: search filters are
// second-granular and the content hash makes a re-read row a no-op.
function sinceFrom(cursor, { firstRunDays }) {
  const since = cursor?.state?.since;
  return since || new Date(Date.now() - firstRunDays * 86400_000).toISOString();
}

function nextSince(passStarted) {
  return new Date(new Date(passStarted).getTime() - 3600_000).toISOString();
}

// Paged search prompt. The paging rule is spelled out because the connector's
// own note tells the model to page "if the user asked about everything", and a
// relay has no user to ask.
function searchPrompt(toolName, params) {
  return [
    'You are a data relay with no user. Use only the Microsoft 365 tools named below.',
    `Call ${toolName} with exactly these arguments: ${JSON.stringify({ ...params, offset: 0 })}`,
    `If the last item of a result has "nextOffset", call ${toolName} again with the same arguments and that offset.`,
    `Stop after ${MAX_PAGES} calls in total, or when a result has no "nextOffset".`,
    'Do not call any other tool. When finished, reply with the single word: done',
  ].join('\n');
}

function readPrompt(uris) {
  return [
    'You are a data relay with no user. Use only the read_resource tool.',
    'Call read_resource once for each URI below, passing it verbatim. Make the calls in parallel.',
    'Results may be saved to a file instead of shown; that is expected — do not open the file.',
    'Do not call any other tool and do not retry a URI that fails. When finished, reply with the single word: done',
    '',
    ...uris,
  ].join('\n');
}

// Flattens a paged search into its items, dropping the paging trailer objects
// ({nextOffset}, {totalResultCount}, {moreResults}). `more` says whether the
// last page still pointed at another one — the pass was cut short by the cap.
// A failed page costs that page, not the pass: the connector's backend has
// transient "Error POSTing to endpoint" failures, and only when every call
// failed is the search an error.
function searchResults(calls, toolName) {
  const seen = new Set();
  const items = [];
  let more = false;
  let errors = 0;
  const mine = calls.filter((c) => c.name === tool(toolName));
  for (const call of mine) {
    if (call.error) {
      errors++;
      continue;
    }
    more = false;
    for (const r of call.results) {
      if (!r || typeof r !== 'object') continue;
      if (r.nextOffset !== undefined || r.nextCursor) more = true;
      if (!r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      items.push(r);
    }
  }
  if (mine.length && errors === mine.length) {
    throw new Error(`${toolName}: ${mine[mine.length - 1].error}`);
  }
  return { items, more: more || errors > 0 };
}

async function searchOnce(toolName, params, timeoutMs) {
  const calls = await llm.toolCalls({
    prompt: searchPrompt(toolName, params),
    tools: [tool(toolName)],
    timeoutMs,
    visibleTokens: SEARCH_VISIBLE_TOKENS,
  });
  if (!calls.some((c) => c.name === tool(toolName))) {
    throw new Error(`${toolName} was not called — is the Microsoft 365 connector connected? Run /mcp in Claude Code.`);
  }
  return searchResults(calls, toolName);
}

// A search since the cursor, for results that come back newest first (mail
// and Teams both do). When a session's pages run out before reaching `since`,
// the next round asks for everything before the oldest item seen, so a
// backlog is walked from the top down instead of silently losing its older
// half. `dateKey` names the item's timestamp field.
async function search(toolName, params, { dateKey = null, maxRounds = 4, timeoutMs = 300_000 } = {}) {
  const all = new Map();
  let before = params.beforeDateTime || null;
  for (let round = 0; round < maxRounds; round++) {
    const { items, more } = await searchOnce(
      toolName,
      before ? { ...params, beforeDateTime: before } : params,
      timeoutMs
    );
    for (const it of items) all.set(it.id, it);
    if (!more || !dateKey || !items.length) return [...all.values()];
    const oldest = items.map((i) => i[dateKey]).filter(Boolean).sort()[0];
    if (!oldest || oldest === before) break;
    before = oldest;
  }
  log.warn('search cut short — older items in this window were skipped', { tool: toolName, before });
  return [...all.values()];
}

// Reads full resources by URI. Returns a Map uri → resource; a URI that failed
// is simply absent, and its item keeps the search summary.
async function readAll(uris, { timeoutMs = 300_000 } = {}) {
  const out = new Map();
  if (!uris.length) return out;
  const calls = await llm.toolCalls({
    prompt: readPrompt(uris),
    tools: [tool('read_resource')],
    timeoutMs,
    visibleTokens: READ_VISIBLE_TOKENS,
  });
  for (const call of calls) {
    if (call.name !== tool('read_resource') || call.error) continue;
    const result = call.results.find((r) => r && typeof r === 'object');
    if (result) out.set(call.input.uri, result);
  }
  return out;
}

// Who "me" is, from the connector's own profile. Cached on the `m365` cursor so
// it costs one call per install, and bound to the `is_me` person under both the
// address (mail, calendar) and the AAD object id (Teams `from.id`).
async function whoAmI() {
  const cursor = await getCursor('m365');
  if (cursor?.state?.me?.mail) return cursor.state.me;
  const calls = await llm.toolCalls({
    prompt: 'Call get_me once. Then reply with the single word: done',
    tools: [tool('get_me')],
    timeoutMs: 120_000,
  });
  const me = calls.find((c) => c.name === tool('get_me'))?.results.find((r) => r && r.id);
  if (!me) throw new Error('get_me returned nothing — is the Microsoft 365 connector connected? Run /mcp in Claude Code.');
  const profile = {
    id: me.id,
    displayName: me.displayName || null,
    mail: String(me.mail || me.userPrincipalName || '').toLowerCase(),
  };
  await identity.claimForMe('smtp', profile.mail, { displayName: profile.displayName, email: profile.mail });
  await identity.claimForMe('aad_oid', profile.id);
  await saveItems('m365', [], { source: 'm365', deltaToken: null, state: { ...(cursor?.state || {}), me: profile } });
  log.info('signed in', { as: profile.mail });
  return profile;
}

async function grantedScopes() {
  const calls = await llm.toolCalls({
    prompt: 'Call get_granted_scopes once. Then reply with the single word: done',
    tools: [tool('get_granted_scopes')],
    timeoutMs: 120_000,
  });
  const call = calls.find((c) => c.name === tool('get_granted_scopes'));
  if (!call) throw new Error('the Microsoft 365 connector is not available — run /mcp in Claude Code');
  if (call.error) throw new Error(call.error);
  return call.results.find((r) => r && Array.isArray(r.grantedScopes))?.grantedScopes || [];
}

module.exports = {
  PREFIX,
  tool,
  MAX_PAGES,
  MAX_READS,
  isAutomated,
  sinceFrom,
  nextSince,
  searchPrompt,
  readPrompt,
  searchResults,
  search,
  readAll,
  whoAmI,
  grantedScopes,
};
