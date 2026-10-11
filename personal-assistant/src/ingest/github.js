'use strict';

// GitHub ingest, through the `gh` CLI.
//
// `gh` rather than a token in `.env`: it is already signed in on the machine,
// its token lives in the OS keyring, and refreshing a scope is one command the
// operator runs themselves. The tool never sees the credential.
//
// Same shape as GitLab, for the same reason. **Notifications first** — they are
// GitHub's own answer to "what needs this human": review requests, mentions,
// assignments, failed runs on your branches. Then open PRs and assigned issues
// for *state*. Then Projects v2 items assigned to you, which is where the
// Kanban lives — that needs the `read:project` scope, and without it the rest
// still runs and `pa doctor` says what is missing.

const { execFile } = require('child_process');
const { config } = require('../config');
const { saveItems, getCursor } = require('./store');
const { logger } = require('../log');

const log = logger('github');

function gh(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      config.github.bin,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(`gh ${args[0]} ${args[1] || ''}: ${(stderr || err.message).trim().slice(0, 300)}`);
          e.stderr = stderr || '';
          return reject(e);
        }
        resolve(stdout);
      }
    );
  });
}

async function api(path) {
  return JSON.parse(await gh(['api', path]));
}

async function graphql(query, vars = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push('-F', `${k}=${v}`);
  return JSON.parse(await gh(args));
}

// Signed in, and with which scopes. `gh auth status` is the only place the
// scopes are visible without a request that fails on them.
async function status() {
  try {
    const out = await gh(['auth', 'status', '--active']).catch((e) => {
      throw new Error(e.stderr || e.message);
    });
    const login = out.match(/account (\S+)/)?.[1] || null;
    const scopes = (out.match(/Token scopes: (.*)/)?.[1] || '').replace(/'/g, '').split(/,\s*/).filter(Boolean);
    return { ok: true, login, scopes };
  } catch (err) {
    return { ok: false, error: err.message.split('\n')[0] };
  }
}

function configured() {
  return config.github.enabled;
}

// `https://api.github.com/repos/o/r/pulls/12` → `https://github.com/o/r/pull/12`
function htmlUrl(apiUrl) {
  if (!apiUrl) return null;
  return apiUrl
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace(/\/pulls\/(\d+)$/, '/pull/$1');
}

function notificationItem(n, detail) {
  const subject = n.subject || {};
  const url = htmlUrl(subject.url) || n.repository?.html_url || null;
  const body = [
    detail?.comment ? `Latest comment by ${detail.commentAuthor || 'someone'}:\n${detail.comment}` : '',
    detail?.body ? `Description:\n${detail.body}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    externalId: `notification/${n.id}/${n.updated_at}`,
    threadExternalId: url,
    occurredAt: n.updated_at,
    authorIdentity: detail?.commentAuthor ? `github:${detail.commentAuthor}` : null,
    subject: `${n.reason}: ${subject.title || subject.type}`,
    bodyText: body.slice(0, 8000),
    raw: {
      project: n.repository?.full_name || null,
      action: n.reason,
      targetType: subject.type,
      webUrl: url,
      unread: n.unread,
    },
  };
}

function searchItem(kind, it) {
  const repo = it.repository_url?.replace('https://api.github.com/repos/', '') || null;
  return {
    externalId: `${kind}/${repo}#${it.number}`,
    threadExternalId: it.html_url,
    occurredAt: it.updated_at,
    authorIdentity: it.user?.login ? `github:${it.user.login}` : null,
    subject: `${kind === 'pr' ? 'PR' : 'Issue'} ${repo}#${it.number}: ${it.title}`,
    bodyText: (it.body || '').slice(0, 8000),
    raw: {
      project: repo,
      state: it.state === 'open' ? 'opened' : it.state,
      draft: !!it.draft,
      webUrl: it.html_url,
      labels: (it.labels || []).map((l) => l.name),
      assignees: (it.assignees || []).map((a) => a.login),
    },
  };
}

const PROJECT_ITEMS = `
query($org: String!) {
  organization(login: $org) {
    projectsV2(first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        title url closed
        items(first: 100) {
          nodes {
            id updatedAt isArchived
            status: fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
            content {
              __typename
              ... on Issue { title url body state repository { nameWithOwner } assignees(first: 10) { nodes { login } } author { login } }
              ... on PullRequest { title url body state repository { nameWithOwner } assignees(first: 10) { nodes { login } } author { login } }
              ... on DraftIssue { title body assignees(first: 10) { nodes { login } } }
            }
          }
        }
      }
    }
  }
}`;

function projectItems(project, login) {
  const out = [];
  for (const node of project.items?.nodes || []) {
    const c = node.content;
    if (!c || node.isArchived) continue;
    const assignees = (c.assignees?.nodes || []).map((a) => a.login);
    if (!assignees.includes(login)) continue;
    if (c.state && c.state !== 'OPEN') continue;
    out.push({
      externalId: `project-item/${node.id}`,
      threadExternalId: c.url || project.url,
      occurredAt: node.updatedAt,
      authorIdentity: c.author?.login ? `github:${c.author.login}` : null,
      subject: `[${project.title} · ${node.status?.name || 'no status'}] ${c.title}`,
      bodyText: (c.body || '').slice(0, 8000),
      raw: {
        project: c.repository?.nameWithOwner || null,
        board: project.title,
        boardUrl: project.url,
        status: node.status?.name || null,
        state: 'opened',
        kind: c.__typename,
        webUrl: c.url || project.url,
        assignees,
      },
    });
  }
  return out;
}

// Comment text and description for the notifications that are people talking
// to you. CI noise does not get a second request.
const CONVERSATIONAL = new Set(['mention', 'team_mention', 'comment', 'assign', 'author', 'review_requested', 'manual']);

async function detailFor(n) {
  if (!CONVERSATIONAL.has(n.reason) || !n.subject?.url) return null;
  try {
    const subject = await api(n.subject.url.replace('https://api.github.com', ''));
    let comment = null;
    let commentAuthor = subject.user?.login || null;
    const latest = n.subject.latest_comment_url;
    if (latest && latest !== n.subject.url) {
      const c = await api(latest.replace('https://api.github.com', ''));
      comment = c.body || null;
      commentAuthor = c.user?.login || commentAuthor;
    }
    return { body: (subject.body || '').slice(0, 4000), comment, commentAuthor };
  } catch (err) {
    log.debug('notification detail failed', { id: n.id, message: err.message });
    return null;
  }
}

async function run() {
  if (!configured()) {
    log.debug('skipped — PA_GITHUB=0');
    return 0;
  }
  const auth = await status();
  if (!auth.ok) throw new Error(`gh is not signed in — run \`gh auth login\` (${auth.error})`);

  const cursor = await getCursor('github');
  const since = cursor?.state?.since || new Date(Date.now() - 14 * 86400_000).toISOString();
  const passStarted = new Date().toISOString();
  const login = auth.login;
  if (cursor?.state?.claimed !== login) {
    const user = await api('/user');
    await require('../distill/identity').claimForMe('github_username', login, {
      displayName: user.name || login,
      email: user.email || null,
    });
  }

  const notifications = await api(`/notifications?all=false&per_page=50&since=${encodeURIComponent(since)}`);
  const notifItems = [];
  for (const n of notifications.slice(0, 40)) {
    notifItems.push(notificationItem(n, await detailFor(n)));
  }

  const q = (s) => `/search/issues?per_page=50&q=${encodeURIComponent(s)}`;
  const [authored, reviewing, assigned] = await Promise.all([
    api(q(`is:open is:pr author:${login} archived:false`)),
    api(q(`is:open is:pr review-requested:${login} archived:false`)),
    api(q(`is:open is:issue assignee:${login} archived:false`)),
  ]);
  const prs = new Map();
  for (const it of [...authored.items, ...reviewing.items]) prs.set(it.html_url, it);

  // Projects v2: optional, scope-gated, and never fatal to the rest.
  let boardItems = [];
  let projectsNote = null;
  if (!auth.scopes.includes('read:project') && !auth.scopes.includes('project')) {
    projectsNote = 'needs read:project — run `gh auth refresh -s read:project`';
  } else {
    for (const org of config.github.orgs.length ? config.github.orgs : (await api('/user/orgs')).map((o) => o.login)) {
      try {
        const data = await graphql(PROJECT_ITEMS, { org });
        for (const p of data.data?.organization?.projectsV2?.nodes || []) {
          if (!p.closed) boardItems.push(...projectItems(p, login));
        }
      } catch (err) {
        projectsNote = `org ${org}: ${err.message.slice(0, 120)}`;
        log.warn('project items failed', { org, message: err.message });
      }
    }
  }

  let changed = 0;
  changed += await saveItems('github_notification', notifItems, null);
  changed += await saveItems('github_pr', [...prs.values()].map((it) => searchItem('pr', it)), null);
  changed += await saveItems('github_issue', assigned.items.map((it) => searchItem('issue', it)), null);
  changed += await saveItems('github_project_item', boardItems, null);

  await saveItems('github', [], {
    source: 'github',
    deltaToken: null,
    // Overlap by an hour, as GitLab does: `since` is second-granular and the
    // clocks are not ours.
    state: {
      since: new Date(new Date(passStarted).getTime() - 3600_000).toISOString(),
      login,
      claimed: login,
      projects: projectsNote,
    },
  });

  return changed;
}

module.exports = { run, id: 'github', configured, status, gh, api, notificationItem, searchItem, projectItems, htmlUrl };
