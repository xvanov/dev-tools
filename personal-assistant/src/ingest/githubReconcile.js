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
// Only commitments that point at a PR are touched, and only on GitHub's own
// state: merged, closed, reviewed by you, or never requested from you.

const { rows, query } = require('../db');
const { logger } = require('../log');

const log = logger('github');

const PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function prRef(text) {
  const m = PR_URL.exec(String(text || ''));
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}` } : null;
}

const REVIEW_ASK = /\breview/i;

/**
 * What to do with one open commitment, given the PR it is about.
 * @param {object} c       {summary, action} — action is the source item's raw.action
 * @param {object} pr      {state, merged, requestedLogins: string[], authorLogin}
 * @param {string[]} myReviewStates  states of reviews the user submitted on it
 * @param {string} login
 * @returns {{status:'done'|'dropped', reason:string}|null}
 */
function verdict(c, pr, myReviewStates, login) {
  if (!pr) return null;
  if (pr.merged) return { status: 'done', reason: 'PR merged' };
  if (pr.state === 'closed') return { status: 'dropped', reason: 'PR closed without merging' };

  const isReview = c.action === 'review_requested' || c.action === 'team_review_requested' || REVIEW_ASK.test(c.summary || '');
  if (!isReview || pr.authorLogin === login) return null;

  const stillRequested = pr.requestedLogins.includes(login);
  if (stillRequested) return null;
  if (myReviewStates.length) return { status: 'done', reason: 'you reviewed it' };
  return { status: 'dropped', reason: 'review was requested from a team, not from you' };
}

async function reconcile({ api, login }) {
  const open = await rows(
    `select c.id, c.summary, si.raw->>'action' as action,
            coalesce(si.raw->>'webUrl', si.thread_external_id, '') as url
       from commitment c join source_item si on si.id = c.source_item_id
      where c.status = 'open' and c.superseded_by is null
        and si.source like 'github%'
        and coalesce(si.raw->>'webUrl', si.thread_external_id, '') ~ 'github\\.com/[^/]+/[^/]+/pull/[0-9]+'`
  );
  if (!open.length) return { checked: 0, closed: 0 };

  const byPr = new Map();
  for (const c of open) {
    const ref = prRef(c.url);
    if (!ref) continue;
    if (!byPr.has(ref.key)) byPr.set(ref.key, { ref, commitments: [] });
    byPr.get(ref.key).commitments.push(c);
  }

  let closed = 0;
  for (const { ref, commitments } of byPr.values()) {
    let pr;
    let mine = [];
    try {
      const p = await api(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
      pr = {
        state: p.state,
        merged: Boolean(p.merged || p.merged_at),
        requestedLogins: (p.requested_reviewers || []).map((u) => u.login),
        authorLogin: p.user?.login || null,
      };
      if (!pr.merged && pr.state === 'open' && !pr.requestedLogins.includes(login)) {
        const reviews = await api(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`);
        mine = reviews.filter((r) => r.user?.login === login).map((r) => r.state);
      }
    } catch (err) {
      log.debug('reconcile: PR lookup failed', { pr: ref.key, message: err.message });
      continue;
    }
    for (const c of commitments) {
      const v = verdict(c, pr, mine, login);
      if (!v) continue;
      await query(
        `update commitment set status = $2, closed_reason = $3, closed_at = now()
          where id = $1 and status = 'open'`,
        [c.id, v.status, v.reason]
      );
      closed++;
    }
  }
  if (closed) log.info('closed settled commitments', { closed, prs: byPr.size });
  return { checked: byPr.size, closed };
}

module.exports = { reconcile, verdict, prRef };
