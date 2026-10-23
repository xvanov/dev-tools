'use strict';

// Closing commitments GitHub has already answered.
//
// "Review PR #889" stays open in the store long after the PR merged, or after
// you reviewed it, because nothing told the store. And a review requested
// only from a team you belong to was never yours to begin with. After each
// GitHub pass this looks at the PRs behind open commitments and closes the
// ones that are settled, recording why — the dashboard shows the reason
// rather than a card that silently disappears.
//
// Which PR a commitment is about comes from, in order: the GitHub item it was
// read from; a PR URL in its own text; or "PR #N" in a review/merge ask whose
// project is a known repo (asks made in chat, mail or a Claude session). The
// last two settle only on merged or closed — "you reviewed it" and "requested
// from a team" are about GitHub's review requests, which a chat ask is not.
//
// It also folds repeated review asks for one PR into one: each notification
// about a PR used to be distilled into a fresh "Review PR …" card. The older
// ones are marked `superseded_by` the newest, as consolidation does for any
// restatement; nothing is deleted.

const { rows, query } = require('../db');
const { logger } = require('../log');

const log = logger('github');

const PR_URL = /github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d+)/;

function prRef(text) {
  const m = PR_URL.exec(String(text || ''));
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() } : null;
}

const REVIEW_ASK = /\breview/i;
// An ask about the PR itself: review it, approve it, merge it, land it.
const PR_ACTION = /^(?:re-?)?(?:review|approve|merge|rebase(?:\s+and\s+merge)?|land)\b/i;
const PR_NUMBER = /\b(?:PR|pull request)\s*#?(\d+)\b/gi;

/**
 * Which PR an open commitment is about, or null.
 * @param {object} c  {summary, detail, url (the GitHub item's own URL, '' otherwise), projectPath (owner/repo of its project)}
 * @returns {{ref, fromText: boolean}|null}
 */
function refFor(c) {
  const own = prRef(c.url);
  if (own) return { ref: own, fromText: false };
  const summary = String(c.summary || '');
  const inText = prRef(`${summary}\n${c.detail || ''}`);
  if (inText && PR_ACTION.test(summary)) return { ref: inText, fromText: true };
  if (!PR_ACTION.test(summary) || /\bPRs\b/i.test(summary) || !c.projectPath || !/^[^/\s]+\/[^/\s]+$/.test(c.projectPath)) return null;
  const numbers = [...new Set([...summary.matchAll(PR_NUMBER)].map((m) => Number(m[1])))];
  // "Merge PR 8 before PR 9" names two PRs; which one settles it is not ours to guess.
  if (numbers.length !== 1) return null;
  const [owner, repo] = c.projectPath.split('/');
  return { ref: { owner, repo, number: numbers[0], key: `${owner}/${repo}#${numbers[0]}`.toLowerCase() }, fromText: true };
}

function day(iso) {
  return iso ? ` ${String(iso).slice(0, 10)}` : '';
}

/**
 * What to do with one open commitment, given the PR it is about.
 * @param {object} c       {summary, action, fromText} — action is the source item's raw.action
 * @param {object} pr      {state, merged, mergedAt, closedAt, requestedLogins: string[], authorLogin}
 * @param {string[]} myReviewStates  states of reviews the user submitted on it
 * @param {string} login
 * @returns {{status:'done'|'dropped', reason:string}|null}
 */
function verdict(c, pr, myReviewStates, login) {
  if (!pr) return null;
  if (pr.merged) return { status: 'done', reason: `PR merged${day(pr.mergedAt)}` };
  if (pr.state === 'closed') return { status: 'dropped', reason: `PR closed without merging${day(pr.closedAt)}` };
  if (c.fromText) return null;

  const isReview = c.action === 'review_requested' || c.action === 'team_review_requested' || REVIEW_ASK.test(c.summary || '');
  if (!isReview || pr.authorLogin === login) return null;

  const stillRequested = pr.requestedLogins.includes(login);
  if (stillRequested) return null;
  if (myReviewStates.length) return { status: 'done', reason: 'you reviewed it' };
  return { status: 'dropped', reason: 'review was requested from a team, not from you' };
}

/**
 * Repeated review asks for one PR, folded into one.
 * @param {Array} list  [{id, key, direction, summary, status, supersededBy}] open commitments with a PR key
 * @returns {Array} [{id, supersededBy}] — older review asks point at the newest
 *   (a dispatched one is kept in preference, and is never superseded)
 */
function duplicatePlan(list) {
  const groups = new Map();
  for (const c of list) {
    if (c.supersededBy != null || !c.key || !PR_ACTION.test(c.summary || '') || !REVIEW_ASK.test(c.summary || '')) continue;
    const k = `${c.direction || ''} ${c.key}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => Number(a.id) - Number(b.id));
    const keep = sorted.filter((c) => c.status === 'dispatched').pop() || sorted[sorted.length - 1];
    for (const c of sorted) if (c !== keep && c.status !== 'dispatched') out.push({ id: c.id, supersededBy: keep.id });
  }
  return out;
}

async function openWithRefs() {
  const list = await rows(
    `select c.id, c.summary, c.detail, c.direction, c.status, c.superseded_by, si.raw->>'action' as action,
            case when si.source like 'github%' then coalesce(si.raw->>'webUrl', si.thread_external_id, '') else '' end as url,
            p.gitlab_path as project_path
       from commitment c
       join source_item si on si.id = c.source_item_id
       left join project p on p.id = c.project_id and p.active
      where c.status in ('open','dispatched')
        and (si.source like 'github%' or c.summary ~* '(github\\.com/|\\mPR\\M|pull request)' or c.detail ~* 'github\\.com/[^/]+/[^/]+/pull/')`
  );
  const out = [];
  for (const c of list) {
    const r = refFor({ summary: c.summary, detail: c.detail, url: c.url, projectPath: c.project_path });
    if (r) out.push({ ...c, ref: r.ref, fromText: r.fromText });
  }
  return out;
}

async function lookup(api, ref, login) {
  const p = await api(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  const pr = {
    state: p.state,
    merged: Boolean(p.merged || p.merged_at),
    mergedAt: p.merged_at || null,
    closedAt: p.closed_at || null,
    requestedLogins: (p.requested_reviewers || []).map((u) => u.login),
    authorLogin: p.user?.login || null,
  };
  let mine = [];
  if (!pr.merged && pr.state === 'open' && !pr.requestedLogins.includes(login)) {
    const reviews = await api(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`);
    mine = reviews.filter((r) => r.user?.login === login).map((r) => r.state);
  }
  return { pr, mine };
}

/**
 * What a reconcile pass would change, without changing it.
 * Superseded rows are included: a hidden duplicate of a merged PR's review is
 * as finished as the one on the list, and used to stay "open" forever.
 * Dispatched ones are never closed here — a run owns them.
 * @returns {{checked, closes: [{id, status, reason, pr}], duplicates: [{id, supersededBy, pr}]}}
 */
async function plan({ api, login }) {
  const open = await openWithRefs();
  const byPr = new Map();
  for (const c of open) {
    if (!byPr.has(c.ref.key)) byPr.set(c.ref.key, { ref: c.ref, commitments: [] });
    byPr.get(c.ref.key).commitments.push(c);
  }

  const closes = [];
  const settled = new Set();
  for (const { ref, commitments } of byPr.values()) {
    let looked;
    try {
      looked = await lookup(api, ref, login);
    } catch (err) {
      log.debug('reconcile: PR lookup failed', { pr: ref.key, message: err.message });
      continue;
    }
    for (const c of commitments) {
      if (c.status !== 'open') continue;
      const v = verdict(c, looked.pr, looked.mine, login);
      if (!v) continue;
      closes.push({ id: c.id, status: v.status, reason: v.reason, pr: ref.key });
      settled.add(String(c.id));
    }
  }

  const duplicates = duplicatePlan(
    open
      .filter((c) => !settled.has(String(c.id)))
      .map((c) => ({ id: c.id, key: c.ref.key, direction: c.direction, summary: c.summary, status: c.status, supersededBy: c.superseded_by }))
  ).map((d) => ({ ...d, pr: open.find((c) => String(c.id) === String(d.id)).ref.key }));

  return { checked: byPr.size, closes, duplicates };
}

async function reconcile({ api, login }) {
  const { checked, closes, duplicates } = await plan({ api, login });
  let closed = 0;
  for (const c of closes) {
    const r = await query(
      `update commitment set status = $2, closed_reason = $3, closed_at = now()
        where id = $1 and status = 'open'`,
      [c.id, c.status, c.reason]
    );
    closed += r.rowCount || 0;
  }
  let folded = 0;
  for (const d of duplicates) {
    const r = await query(
      `update commitment set superseded_by = $2
        where id = $1 and superseded_by is null and status = 'open'`,
      [d.id, d.supersededBy]
    );
    folded += r.rowCount || 0;
  }
  if (closed || folded) log.info('reconciled commitments', { closed, folded, prs: checked });
  return { checked, closed, folded };
}

module.exports = { reconcile, plan, verdict, prRef, refFor, duplicatePlan };
