'use strict';

// Jira ingest, through the claude.ai Atlassian connector.
//
// There is no Jira token here. A headless `claude -p` already holds the
// operator's Atlassian sign-in (made once through `/mcp`), so this source asks
// it to run the JQL and hand back JSON. That trades a deterministic REST call
// for a model in the loop, which is why the prompt demands verbatim copying,
// why the reply is parsed and validated rather than trusted, and why the poll
// is slow — a ticket tracker does not need two-minute freshness.

const { config } = require('../config');
const llm = require('../llm');
const { saveItems, getCursor } = require('./store');
const { logger } = require('../log');

const log = logger('jira');

// Both names the claude.ai Atlassian connector has gone by: whichever one the
// operator has signed in to is the one the session can reach.
const TOOLS = ['Atlassian_MCP', 'Atlassian'].flatMap((server) => [
  `mcp__claude_ai_${server}__getAccessibleAtlassianResources`,
  `mcp__claude_ai_${server}__searchJiraIssuesUsingJql`,
]);

function configured() {
  return config.jira.enabled;
}

// Second-granular JQL date, in UTC. Jira compares in the user's timezone, so
// the hour of overlap applied to the cursor covers the difference.
function jqlDate(iso) {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

function buildJql(sinceIso) {
  return (
    `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) ` +
    `AND updated >= "${jqlDate(sinceIso)}" ORDER BY updated DESC`
  );
}

function buildPrompt({ cloudId, jql, max }) {
  return [
    'You are a data relay. Use only the Atlassian tools.',
    cloudId
      ? `cloudId is ${cloudId}.`
      : 'First call getAccessibleAtlassianResources and use the first Jira site\'s cloudId.',
    `Call searchJiraIssuesUsingJql with jql: ${jql}`,
    `maxResults ${max}, and request the fields summary, status, assignee, reporter, priority, updated, duedate, description, comment.`,
    '',
    'Then output ONLY one JSON object, no prose, no code fence:',
    '{"cloudId": string, "site": string (https://<name>.atlassian.net), "issues": [',
    '  {"key": string, "summary": string, "status": string, "statusCategory": string,',
    '   "assignee": string|null, "reporter": string|null, "priority": string|null,',
    '   "updated": ISO string, "due": "YYYY-MM-DD"|null,',
    '   "description": string (plain text, first 1500 chars),',
    '   "lastComment": {"author": string, "created": ISO string, "body": string (first 1500 chars)} | null}',
    ']}',
    'Copy text verbatim from the tool results. Never summarise, paraphrase or invent a field; use null when absent.',
  ].join('\n');
}

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

function parseReply(text) {
  const parsed = llm.extractJson(text);
  if (!parsed || !Array.isArray(parsed.issues)) throw new Error('Jira relay returned no issues array');
  const site = typeof parsed.site === 'string' ? parsed.site.replace(/\/+$/, '') : null;
  const issues = parsed.issues.filter((i) => i && KEY.test(String(i.key || '')) && i.summary);
  return { cloudId: parsed.cloudId || null, site, issues };
}

function issueItem(issue, site) {
  const url = site ? `${site}/browse/${issue.key}` : null;
  const comment = issue.lastComment?.body
    ? `Latest comment by ${issue.lastComment.author || 'someone'}:\n${issue.lastComment.body}`
    : '';
  const body = [comment, issue.description ? `Description:\n${issue.description}` : '']
    .filter(Boolean)
    .join('\n\n');
  // The latest comment is part of the id's content, not the id: the upsert's
  // content hash re-opens the item for distillation when someone replies.
  return {
    externalId: issue.key,
    threadExternalId: url,
    occurredAt: issue.updated || new Date().toISOString(),
    authorIdentity: issue.lastComment?.author || issue.reporter || null,
    subject: `${issue.key} [${issue.status || '?'}]: ${issue.summary}`,
    bodyText: body.slice(0, 8000),
    raw: {
      project: issue.key.split('-')[0],
      state: issue.statusCategory === 'Done' ? 'closed' : 'opened',
      status: issue.status || null,
      assignee: issue.assignee || null,
      reporter: issue.reporter || null,
      priority: issue.priority || null,
      dueDate: issue.due || null,
      webUrl: url,
    },
  };
}

async function run() {
  if (!configured()) {
    log.debug('skipped — PA_JIRA=0');
    return 0;
  }
  const cursor = await getCursor('jira');
  const since = cursor?.state?.since || new Date(Date.now() - 14 * 86400_000).toISOString();
  const passStarted = new Date().toISOString();
  const cloudId = config.jira.cloudId || cursor?.state?.cloudId || null;

  const text = await llm.complete({
    prompt: buildPrompt({ cloudId, jql: buildJql(since), max: 50 }),
    tools: TOOLS,
    effort: 'low',
    timeoutMs: 240_000,
  });
  let parsed;
  try {
    parsed = parseReply(text);
  } catch (err) {
    // The relay explains itself in prose when it cannot reach the connector
    // ("tools aren't available", "still connecting"). That sentence is the
    // diagnosis; "no JSON" is not.
    const said = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(
      /not available|aren't available|connecting|authori[sz]e|\/mcp/i.test(said)
        ? `Atlassian connector unreachable — check /mcp (relay said: ${said})`
        : `${err.message}: ${said}`
    );
  }
  const { cloudId: gotCloud, site, issues } = parsed;

  const changed = await saveItems('jira_issue', issues.map((i) => issueItem(i, site)), {
    source: 'jira',
    deltaToken: null,
    state: {
      since: new Date(new Date(passStarted).getTime() - 3600_000).toISOString(),
      cloudId: gotCloud || cloudId,
      site,
    },
  });
  log.info('relayed', { issues: issues.length, changed });
  return changed;
}

module.exports = { run, id: 'jira', configured, buildJql, buildPrompt, parseReply, issueItem, TOOLS };
