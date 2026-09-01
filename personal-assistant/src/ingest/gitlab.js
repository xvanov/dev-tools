'use strict';

// GitLab ingest.
//
// The interesting choice here is **todos first**. GitLab's `/todos` endpoint is
// already the server's own answer to "what needs this human's attention" —
// review requests, mentions, assignments, failed pipelines on your MRs — and it
// is per-user, small, and cheap. Reconstructing that from raw notes and MR
// events would be a lot of requests to arrive somewhere worse.
//
// Merge requests and issues are then pulled for *state*, not for text: whether
// a branch is open, whose review it waits on, which pipeline failed. That state
// is what `pa brief` reports and what the dispatcher checks before landing a
// run.

const { config } = require('../config');
const { saveItems, getCursor } = require('./store');
const { htmlToText } = require('../util/text');
const { logger } = require('../log');

const log = logger('gitlab');

function configured() {
  return Boolean(config.gitlab.token);
}

async function api(pathAndQuery) {
  const url = `${config.gitlab.url.replace(/\/+$/, '')}/api/v4${pathAndQuery}`;
  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': config.gitlab.token, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitLab ${res.status} on ${pathAndQuery}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function todoItem(todo) {
  const target = todo.target || {};
  const body = [
    todo.body || '',
    target.description ? htmlToText(target.description).slice(0, 4000) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    externalId: `todo/${todo.id}`,
    threadExternalId: target.web_url || todo.target_url || null,
    occurredAt: todo.created_at,
    authorIdentity: todo.author?.username ? `gitlab:${todo.author.username}` : null,
    subject: `${todo.action_name}: ${target.title || todo.target_type}`,
    bodyText: body,
    raw: {
      project: todo.project?.path_with_namespace || null,
      action: todo.action_name,
      targetType: todo.target_type,
      targetUrl: todo.target_url,
      state: todo.state,
      authorName: todo.author?.name || null,
    },
  };
}

function mrItem(mr) {
  return {
    externalId: `mr/${mr.project_id}/${mr.iid}`,
    threadExternalId: mr.web_url,
    occurredAt: mr.updated_at,
    authorIdentity: mr.author?.username ? `gitlab:${mr.author.username}` : null,
    subject: `MR !${mr.iid}: ${mr.title}`,
    bodyText: (mr.description || '').slice(0, 8000),
    raw: {
      project: mr.references?.full?.split('!')[0] || null,
      state: mr.state,
      draft: !!mr.draft,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      webUrl: mr.web_url,
      reviewers: (mr.reviewers || []).map((r) => r.username),
      assignees: (mr.assignees || []).map((a) => a.username),
      mergeStatus: mr.detailed_merge_status || mr.merge_status,
      pipeline: mr.head_pipeline?.status || null,
    },
  };
}

function issueItem(issue) {
  return {
    externalId: `issue/${issue.project_id}/${issue.iid}`,
    threadExternalId: issue.web_url,
    occurredAt: issue.updated_at,
    authorIdentity: issue.author?.username ? `gitlab:${issue.author.username}` : null,
    subject: `Issue #${issue.iid}: ${issue.title}`,
    bodyText: (issue.description || '').slice(0, 8000),
    raw: {
      project: issue.references?.full?.split('#')[0] || null,
      state: issue.state,
      labels: issue.labels || [],
      webUrl: issue.web_url,
      dueDate: issue.due_date || null,
      assignees: (issue.assignees || []).map((a) => a.username),
    },
  };
}

async function run() {
  if (!configured()) {
    log.debug('skipped — PA_GITLAB_TOKEN not set');
    return 0;
  }

  const cursorKey = 'gitlab';
  const cursor = await getCursor(cursorKey);
  const since = cursor?.state?.updatedAfter || new Date(Date.now() - 14 * 86400_000).toISOString();
  const passStarted = new Date().toISOString();

  const me = await api('/user');

  const [todos, mrsAssigned, mrsAuthored, mrsReviewing, issues] = await Promise.all([
    api('/todos?state=pending&per_page=100'),
    api(`/merge_requests?scope=assigned_to_me&state=opened&updated_after=${since}&per_page=100`),
    api(`/merge_requests?scope=created_by_me&state=opened&updated_after=${since}&per_page=100`),
    api(`/merge_requests?reviewer_id=${me.id}&state=opened&updated_after=${since}&per_page=100`),
    api(`/issues?scope=assigned_to_me&state=opened&updated_after=${since}&per_page=100`),
  ]);

  const mrById = new Map();
  for (const mr of [...mrsAssigned, ...mrsAuthored, ...mrsReviewing]) {
    mrById.set(`${mr.project_id}/${mr.iid}`, mr);
  }

  let changed = 0;
  changed += await saveItems('gitlab_todo', todos.map(todoItem), null);
  changed += await saveItems('gitlab_mr', [...mrById.values()].map(mrItem), null);
  changed += await saveItems('gitlab_issue', issues.map(issueItem), null);

  await saveItems('gitlab', [], {
    source: cursorKey,
    deltaToken: null,
    // Overlap by an hour: GitLab's `updated_after` is inclusive of the second,
    // and clock skew between here and the instance is real.
    state: {
      updatedAfter: new Date(new Date(passStarted).getTime() - 3600_000).toISOString(),
      username: me.username,
      userId: me.id,
    },
  });

  return changed;
}

module.exports = { run, id: 'gitlab', configured, api, todoItem, mrItem, issueItem };
