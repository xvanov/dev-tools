'use strict';

// Jira ingest, two ways, both ending in the same `issueItem` shape.
//
// **REST, when there is an API token.** `PA_JIRA_API_TOKEN` (a secret — see
// config.secret(), stored in Windows Credential Manager through the
// dashboard) plus the account email, Basic auth against
// `/rest/api/3/search/jql`. Deterministic, fast, and no model in the loop.
//
// **The claude.ai Atlassian connector, otherwise.** A headless `claude -p`
// already holds the operator's Atlassian sign-in (made once through `/mcp`),
// so this source asks it to run the JQL and hand back JSON. That trades a
// deterministic REST call for a model in the loop, which is why the prompt
// demands verbatim copying, why the reply is parsed and validated rather than
// trusted, and why the poll is slow. The connector also times out often
// enough that when it fails and there is no token, the pass opens a secret
// request for one (requestCredentials) — the dashboard asks the human.

const path = require('path');
const { config, secret, secretSource, parseEnvFile } = require('../config');
const db = require('../db');
const llm = require('../llm');
const { saveItems, getCursor } = require('./store');
const { logger } = require('../log');

const TOKEN = 'PA_JIRA_API_TOKEN';
const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const FIELDS = ['summary', 'status', 'assignee', 'reporter', 'priority', 'updated', 'duedate', 'description', 'comment'];

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

// ------------------------------------------------------------------ REST --

// `acme`, `acme.atlassian.net` or `https://acme.atlassian.net/` → the origin.
function normaliseSite(site) {
  if (!site) return null;
  let s = String(site).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s.includes('.') ? s : `${s}.atlassian.net`}`;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

// Atlassian Document Format → plain text. Only the node kinds that carry
// words matter; everything else contributes its children.
function adfText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfText).join('');
  const kids = adfText(node.content);
  switch (node.type) {
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text || '@someone';
    case 'emoji': return node.attrs?.text || node.attrs?.shortName || '';
    case 'inlineCard': case 'blockCard': return node.attrs?.url || '';
    case 'listItem': return `- ${kids.trim()}\n`;
    case 'paragraph': case 'heading': case 'blockquote': case 'codeBlock': case 'panel': return `${kids}\n`;
    case 'rule': return '\n';
    default: return kids;
  }
}

function plain(adf, max = 1500) {
  return adfText(adf).replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

// Jira's `2026-10-10T10:00:00.000+0000` → ISO.
function isoTime(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// One issue from /rest/api/3/search/jql → the relay's issue shape, so both
// routes feed issueItem() identically.
function restIssue(raw) {
  const f = raw?.fields || {};
  const comments = Array.isArray(f.comment?.comments) ? f.comment.comments : [];
  const last = comments[comments.length - 1];
  return {
    key: raw?.key,
    summary: f.summary || '',
    status: f.status?.name || null,
    statusCategory: f.status?.statusCategory?.name || null,
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    priority: f.priority?.name || null,
    updated: isoTime(f.updated),
    due: f.duedate || null,
    description: plain(f.description) || null,
    lastComment: last
      ? { author: last.author?.displayName || null, created: isoTime(last.created), body: plain(last.body) }
      : null,
  };
}

function parseRest(json) {
  const issues = (Array.isArray(json?.issues) ? json.issues : [])
    .map(restIssue)
    .filter((i) => KEY.test(String(i.key || '')) && i.summary);
  return { issues, nextPageToken: json?.nextPageToken || null, isLast: json?.isLast !== false || !json?.nextPageToken };
}

// Non-secret Jira settings the dashboard may have just written to .env:
// re-read the files rather than trust the copy config took at startup.
function freshEnv(name) {
  return (
    process.env[name] ||
    parseEnvFile(path.join(config.toolDir, '.env'))[name] ||
    parseEnvFile(path.join(config.repoRoot, '.env'))[name] ||
    null
  );
}

// The email the token belongs to: PA_JIRA_EMAIL, else the Microsoft 365
// address `pa login` recorded (the same person, nearly always the same
// address), else the is_me person's.
async function accountEmail() {
  const set = config.jira.email || freshEnv('PA_JIRA_EMAIL');
  if (set) return set;
  const m365 = await db.one(`select state->'me'->>'mail' as mail from sync_cursor where source = 'm365'`).catch(() => null);
  if (m365?.mail) return m365.mail;
  const me = await db.one('select primary_email from person where is_me and primary_email is not null limit 1').catch(() => null);
  return me?.primary_email || null;
}

// What the REST route has and lacks. `source` says where the token lives;
// the token itself is only read inside searchRest().
async function restAuth(cursor) {
  const site = normaliseSite(config.jira.site || freshEnv('PA_JIRA_SITE') || cursor?.state?.site);
  const email = await accountEmail();
  const source = secretSource(TOKEN);
  const missing = [];
  if (!site) missing.push('PA_JIRA_SITE');
  if (!email) missing.push('PA_JIRA_EMAIL');
  if (!source) missing.push(TOKEN);
  return { ok: missing.length === 0, site, email, source, missing };
}

async function searchRest({ site, email }, jql, { max = 100, fetchImpl = fetch } = {}) {
  const token = secret(TOKEN);
  if (!token) throw new Error(`${TOKEN} is not configured`);
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const issues = [];
  let next = null;
  do {
    const res = await fetchImpl(`${site}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, fields: FIELDS, maxResults: 50, ...(next ? { nextPageToken: next } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      // Status only: Jira's error body can echo request details, and a 401
      // is the whole diagnosis anyway.
      const why = res.status === 401 || res.status === 403
        ? `Jira rejected the API token (HTTP ${res.status}) — \`pa secret set ${TOKEN}\` to replace it, and check PA_JIRA_EMAIL`
        : `Jira search failed: HTTP ${res.status}`;
      throw Object.assign(new Error(why), { status: res.status });
    }
    const page = parseRest(await res.json());
    issues.push(...page.issues);
    next = page.isLast ? null : page.nextPageToken;
  } while (next && issues.length < max);
  return issues.slice(0, max);
}

/**
 * Neither route worked: ask the human for what the REST route lacks. The
 * token is a secret (Credential Manager); site and email are not, so they
 * are asked for as .env values.
 */
async function requestCredentials(auth, requestedBy = 'ingest:jira') {
  const secrets = require('../secrets');
  const asks = [];
  if (auth.missing.includes(TOKEN)) {
    asks.push(secrets.requestSecret({
      name: TOKEN,
      purpose: 'Jira ingest: the Atlassian connector keeps timing out',
      hint: `Create one at ${TOKEN_URL} (any label, e.g. "personal-assistant"), copy it, and paste it here.`,
      url: TOKEN_URL,
      requestedBy,
    }));
  }
  if (auth.missing.includes('PA_JIRA_EMAIL')) {
    asks.push(secrets.requestSecret({
      name: 'PA_JIRA_EMAIL',
      purpose: 'Jira ingest: the email of the Atlassian account the API token belongs to',
      hint: 'Not a secret — it goes in personal-assistant/.env.',
      requestedBy,
      target: 'env-file',
    }));
  }
  if (auth.missing.includes('PA_JIRA_SITE')) {
    asks.push(secrets.requestSecret({
      name: 'PA_JIRA_SITE',
      purpose: 'Jira ingest: your Jira site',
      hint: 'Not a secret — e.g. acme or https://acme.atlassian.net. It goes in personal-assistant/.env.',
      requestedBy,
      target: 'env-file',
    }));
  }
  return Promise.all(asks);
}

async function save(issues, site, state) {
  return saveItems('jira_issue', issues.map((i) => issueItem(i, site)), {
    source: 'jira',
    deltaToken: null,
    state,
  });
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
  const nextSince = new Date(new Date(passStarted).getTime() - 3600_000).toISOString();

  const auth = await restAuth(cursor);
  if (auth.ok) {
    const issues = await searchRest(auth, buildJql(since));
    const changed = await save(issues, auth.site, { ...(cursor?.state || {}), since: nextSince, site: auth.site, via: 'rest' });
    log.info('fetched', { via: 'rest', issues: issues.length, changed });
    return changed;
  }

  try {
    return await relay({ cursor, since, cloudId, nextSince });
  } catch (err) {
    await requestCredentials(auth).catch((e) => log.warn('could not open a secret request', { message: e.message }));
    throw err;
  }
}

async function relay({ since, cloudId, nextSince }) {
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

  const changed = await save(issues, site, { since: nextSince, cloudId: gotCloud || cloudId, site, via: 'connector' });
  log.info('relayed', { issues: issues.length, changed });
  return changed;
}

module.exports = {
  run,
  id: 'jira',
  configured,
  buildJql,
  buildPrompt,
  parseReply,
  issueItem,
  restIssue,
  parseRest,
  adfText,
  normaliseSite,
  restAuth,
  searchRest,
  requestCredentials,
  TOOLS,
  TOKEN,
};
