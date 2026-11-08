'use strict';

// Which items may put a task on the board: only what a person said or did.
//
// The distiller used to read everything ingested, and half the board was the
// assistant's own work — handoff steps from Claude sessions ("send the test
// checklist", "wire in local voice"), CodeRabbit and Snyk comments, dependabot
// PRs. The rule now is the user's: a task comes from what people say to you
// (Teams, mail, meetings), from a person on GitHub or Jira asking you for
// something, or from you telling the assistant to make one (`pa task add`,
// source `pa_request`). Everything else is still ingested — it is evidence the
// reconciler closes cards with, and memory and search read it — but it never
// creates a commitment, and the distiller is not even called for it.
//
// Two layers:
//
//   source   PA_COMMITMENT_SOURCES lists the sources (or groups) that may
//            create commitments. `claude_session`, `cursor_session` and any
//            source not listed never do. Checked in SQL (distill.pending,
//            dedupe), so excluded items cost nothing.
//   person   within an allowed source, the item must come from a human:
//            mail and chat not from an automated sender (m365.isAutomated),
//            GitHub and Jira only when a person other than you is asking you
//            (a review requested by name, a mention, a comment on your PR, an
//            issue assigned to you) — never a bot (`[bot]` logins, CodeRabbit,
//            Snyk, dependabot, CI) and never your own activity. Checked per
//            item before the model call (judge()).
//
// Pure, apart from reading config: the tests feed it items.

const { config } = require('../config.ts');

// Groups the setting may name, and what each stands for.
const GROUPS = {
  teams: ['graph_chat'],
  mail: ['graph_mail'],
  meetings: ['audio', 'graph_event'],
  github: ['github_notification', 'github_pr', 'github_issue', 'github_project_item'],
  jira: ['jira_issue'],
  requests: ['pa_request'],
  sessions: ['claude_session', 'cursor_session'],
};

const DEFAULT_SPEC = 'teams,mail,meetings,github,jira,requests';

// Created whole by `pa task add`: never distilled, whatever the policy says.
const DIRECT = new Set(['pa_request']);

const SOURCE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Pure. The setting → the set of source names allowed to create commitments.
 * Entries are group names (above), source names, or `-name` to take one out
 * ("default,-github"). Unknown words are kept as source names if they look
 * like one, and reported.
 * @returns {{sources: Set<string>, unknown: string[]}}
 */
function parseSpec(spec) {
  const text = String(spec == null || String(spec).trim() === '' ? 'default' : spec);
  const sources = new Set();
  const unknown = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const neg = raw.startsWith('-');
    const word = (neg ? raw.slice(1) : raw).toLowerCase();
    const names = word === 'default' ? parseSpec(DEFAULT_SPEC).sources : GROUPS[word] || (SOURCE_NAME.test(word) ? [word] : null);
    if (!names) {
      unknown.push(raw);
      continue;
    }
    if (!GROUPS[word] && word !== 'default' && !Object.values(GROUPS).some((g) => g.includes(word))) unknown.push(raw);
    for (const n of names) (neg ? sources.delete(n) : sources.add(n));
  }
  return { sources, unknown };
}

function allowedSources() {
  return parseSpec(config.commitments?.sources).sources;
}

/** Pure. A SQL boolean for "this source may create commitments" — names are validated, so inlined. */
function sourceSql(column, sources = allowedSources()) {
  const list = [...sources].filter((s) => SOURCE_NAME.test(s));
  if (!list.length) return 'false';
  return `${column} in (${list.map((s) => `'${s}'`).join(', ')})`;
}

/** Pure. The sources the distiller reads: allowed, less the ones created whole. */
function distillSources(sources = allowedSources()) {
  return new Set([...sources].filter((s) => !DIRECT.has(s)));
}

// ------------------------------------------------------------ people --

// GitHub accounts that are software, not people. `[bot]` covers apps
// (coderabbitai[bot], snyk-io[bot], dependabot[bot], github-actions[bot]);
// the names cover the same apps where GitHub shows them without the suffix.
const GITHUB_BOT =
  /\[bot\]$|(^|[-_])bot$|^(coderabbit(ai)?|dependabot(-preview)?|renovate|github-actions|snyk(-io|-bot)?|sonarcloud|sonarqubecloud|codecov|vercel|netlify|copilot(-pull-request-reviewer|-swe-agent)?|mergify|gitguardian|deepsource(-autofix)?|sentry(-io)?|linear|imgbot|allcontributors|azure-pipelines|codeql|semgrep|lgtm-com|claude)$/i;

// Jira's own automation and the apps that post as users.
const JIRA_BOT = /^(automation( for jira)?|jira( (automation|service management|software))?|github( for jira)?|bitbucket|confluence|system|.*\bbot\b.*|.*\[bot\])$/i;

function githubLogin(identity) {
  if (!identity) return null;
  const s = String(identity).trim();
  return (s.toLowerCase().startsWith('github:') ? s.slice(7) : s) || null;
}

function isGithubBot(login) {
  return !!login && GITHUB_BOT.test(String(login).trim());
}

function sameLogin(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// Notification reasons where someone named you. A team's review queue, CI,
// a state change, a deployment approval or a subscription is nobody asking.
const GITHUB_ASKS = new Set(['review_requested', 'mention', 'assign', 'comment', 'author', 'manual']);

/**
 * Pure. Whether a person other than you is asking you for something on this
 * GitHub item. `login` is your GitHub login (null: not known, so only bots
 * and the reason are judged).
 */
function githubAsk(item, login) {
  const raw = item.raw || {};
  const human = (who, role) => {
    if (!who) return { ok: false, why: `no ${role} on record` };
    if (isGithubBot(who)) return { ok: false, why: `${role} is a bot (${who})` };
    if (sameLogin(who, login)) return { ok: false, why: 'your own activity' };
    return { ok: true, why: `${role} ${who}` };
  };
  const latest = githubLogin(item.author_identity);
  switch (item.source) {
    case 'github_notification': {
      const reason = raw.action || '';
      if (!GITHUB_ASKS.has(reason)) return { ok: false, why: `notification "${reason || 'unknown'}" is nobody asking you` };
      // A review request is the PR's author asking; with no author recorded,
      // whoever wrote the latest comment stands in.
      if (reason === 'review_requested') {
        if (raw.requestedMe === false) return { ok: false, why: 'review requested from a team, not you' };
        return human(raw.author || latest, 'requester');
      }
      // Activity on your own PR or a thread you are in: only a person's comment asks.
      return human(latest, 'commenter');
    }
    case 'github_pr':
      if (raw.reviewRequested !== true) return { ok: false, why: 'a PR nobody asked you to review' };
      return human(latest, 'author');
    case 'github_issue':
      return human(latest, 'author');
    case 'github_project_item': {
      const assigned = Array.isArray(raw.assignees) && raw.assignees.some((a) => sameLogin(a, login));
      if (login && !assigned) return { ok: false, why: 'a board card not assigned to you' };
      return human(latest, 'author');
    }
    default:
      return { ok: false, why: `unknown GitHub source ${item.source}` };
  }
}

function sameName(a, b) {
  const n = (s) => String(s || '').trim().toLowerCase();
  return !!n(a) && n(a) === n(b);
}

/** Pure. A person other than you wrote or last commented on the Jira issue. */
function jiraAsk(item, me = {}) {
  const who = item.author_identity || item.raw?.reporter || null;
  if (!who) return { ok: false, why: 'no author on record' };
  if (JIRA_BOT.test(String(who).trim())) return { ok: false, why: `author is automation (${who})` };
  if (sameName(who, me.name) || sameName(who, me.email)) return { ok: false, why: 'your own activity' };
  return { ok: true, why: `author ${who}` };
}

/**
 * Pure. May this item create commitments? {ok, why}.
 * @param item a source_item row (source, author_identity, raw)
 * @param {{sources?: Set<string>, login?: string|null, me?: {name?, email?}, isAutomated?: (addr) => boolean}} o
 */
function judge(item, { sources = allowedSources(), login = null, me = {}, isAutomated = null } = {}) {
  if (!item) return { ok: false, why: 'no item' };
  if (!sources.has(item.source)) return { ok: false, why: `source ${item.source} does not create tasks (PA_COMMITMENT_SOURCES)` };
  const automated = isAutomated || require('../ingest/m365').isAutomated;
  switch (item.source) {
    case 'graph_mail':
      if (automated(item.author_identity)) return { ok: false, why: 'automated sender' };
      return { ok: true, why: 'mail from a person' };
    case 'graph_chat':
    case 'graph_event': {
      // Chat ingest already drops bots and cards; an author recorded only by
      // display name or AAD id is a person. An address that reads as a
      // mailer is not.
      const a = String(item.author_identity || '');
      if (a.includes('@') && automated(a)) return { ok: false, why: 'automated sender' };
      return { ok: true, why: item.source === 'graph_chat' ? 'Teams message from a person' : 'invite from a person' };
    }
    case 'jira_issue':
      return jiraAsk(item, me);
    default:
      if (item.source.startsWith('github')) return githubAsk(item, login);
      return { ok: true, why: `source ${item.source}` };
  }
}

/** For `pa doctor` and `pa policy`: the setting as read. */
function describe(spec = config.commitments?.sources) {
  const { sources, unknown } = parseSpec(spec);
  const all = new Set(Object.values(GROUPS).flat());
  return {
    spec: spec || 'default',
    allowed: [...sources].sort(),
    excluded: [...all].filter((s) => !sources.has(s)).sort(),
    unknown,
  };
}

module.exports = {
  GROUPS,
  DEFAULT_SPEC,
  DIRECT,
  parseSpec,
  allowedSources,
  sourceSql,
  distillSources,
  judge,
  githubAsk,
  jiraAsk,
  isGithubBot,
  describe,
};
