'use strict';

// Who a GitHub item's commitments may belong to — decided from GitHub's own
// records, after the model has spoken.
//
// GitHub tells you about far more than is yours: a review requested from a
// team you are in, a CODEOWNERS rule, a repo you watch, a pod board card no
// one has taken. The distiller reads a PR description that says "the frontend
// lands in a follow-up PR" and, with the reader as the only person it knows,
// writes "Deliver frontend PR" as owed by the reader. Nothing in the item asked
// them for anything. So this is not left to the prompt:
//
//   - Nothing is owed by or to you from an item you are not personally in:
//     author, assignee, reviewer requested by name (not through a team),
//     @mentioned by login, or in the thread yourself. A team's queue is
//     context; its facts are kept, its commitments are not.
//   - On a PR or issue you neither wrote nor are assigned, the work it
//     describes is its author's. A "ship the follow-up PR" the model put on
//     you goes to the author, as owed to you; with no author known it goes.
//   - When the only thing tying you to it is a review request, what you owe
//     is the review: any other owed_by_me is the author's or nobody's.
//
// Pure: no I/O. `involvement` reads the stored item; the cleanup and the
// tests feed it items enriched from the live API.

const SOURCES = new Set(['github_notification', 'github_pr', 'github_issue', 'github_project_item']);

// Notification reasons that name you, not a team or a subscription.
// https://docs.github.com/en/rest/activity/notifications#about-notification-reasons
const REASON_ROLE = {
  author: 'author',
  assign: 'assignee',
  review_requested: 'reviewer',
  mention: 'mentioned',
  comment: 'commented',
  state_change: 'actor',
  ci_activity: 'actor',
  approval_requested: 'actor',
};

const OWNS_WORK = new Set(['author', 'assignee', 'actor']);

const REVIEW_SHAPED = /\b(re-?review|review|approve|approval|sign[- ]?off|look (?:at|over)|feedback on)\b/i;

// "Ship the follow-up PR", "deliver frontend PR", "open a PR for ...".
const DELIVERY_SHAPED =
  /\b(deliver|ship|open|raise|submit|land|finish|complete|implement|build|write|create|send)\b[^.]{0,60}\b(prs?|pull requests?|follow[- ]?ups?)\b|\bfollow[- ]?up (?:pr|pull request|change)s?\b/i;

function handleOf(identity) {
  const m = /^github:(.+)$/i.exec(String(identity || ''));
  return m ? m[1].toLowerCase() : null;
}

function sameLogin(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

function mentions(text, login) {
  if (!text || !login) return false;
  const esc = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w/-])@${esc}(?![\\w-])`, 'i').test(text);
}

/**
 * The ways `login` is personally part of a stored GitHub item.
 * @returns {{roles: Set<string>, personal: boolean, ownsWork: boolean, author: string|null}}
 */
function involvement(item, login) {
  const raw = item.raw || {};
  const roles = new Set();
  const has = (list) => Array.isArray(list) && list.some((u) => sameLogin(u, login));

  let author = null;
  if (item.source === 'github_notification') {
    // A notification's author_identity is whoever wrote the latest comment.
    const role = REASON_ROLE[raw.action];
    if (role && !(role === 'reviewer' && raw.requestedMe === false)) roles.add(role);
    if (sameLogin(handleOf(item.author_identity), login)) roles.add('commented');
    author = raw.author ? String(raw.author).toLowerCase() : null;
  } else {
    author = handleOf(item.author_identity);
  }

  if (sameLogin(author, login)) roles.add('author');
  if (has(raw.assignees)) roles.add('assignee');
  if (raw.reviewRequested === true || has(raw.requestedReviewers)) roles.add('reviewer');
  if (has(raw.commenters) || has(raw.reviewers)) roles.add('commented');
  if (mentions(item.body_text, login) || mentions(item.subject, login)) roles.add('mentioned');

  return {
    roles,
    personal: roles.size > 0,
    ownsWork: [...roles].some((r) => OWNS_WORK.has(r)),
    author: author && !sameLogin(author, login) ? author : null,
  };
}

/**
 * Applies the rule to the distiller's commitments for one item.
 * @param item       a source_item row (source, raw, author_identity, subject, body_text)
 * @param commitments parsed commitments ({direction, summary, counterparty, ...})
 * @param {{login: string|null}} me  your GitHub login; without it nothing is judged
 * @returns {{commitments: object[], dropped: {c: object, why: string}[], moved: object[]}}
 */
function gate(item, commitments, { login } = {}) {
  const out = { commitments, dropped: [], moved: [] };
  if (!SOURCES.has(item?.source) || !login || !commitments?.length) return out;

  const inv = involvement(item, login);
  if (!inv.personal) {
    out.dropped = commitments.map((c) => ({ c, why: 'not personally involved (team, watch or subscription only)' }));
    out.commitments = [];
    return out;
  }
  if (inv.ownsWork) return out;

  const reviewOnly = [...inv.roles].every((r) => r === 'reviewer');
  const kept = [];
  for (const c of commitments) {
    if (c.direction !== 'owed_by_me') {
      kept.push(c);
      continue;
    }
    const text = `${c.summary || ''} ${c.detail || ''}`;
    if (DELIVERY_SHAPED.test(c.summary || '')) {
      if (inv.author) {
        const moved = { ...c, direction: 'owed_to_me', counterparty: `github:${inv.author}` };
        kept.push(moved);
        out.moved.push(moved);
      } else {
        out.dropped.push({ c, why: "the item's own work, and its author is unknown" });
      }
      continue;
    }
    if (reviewOnly && !REVIEW_SHAPED.test(text)) {
      out.dropped.push({ c, why: 'only a reviewer here; the work is the author’s' });
      continue;
    }
    kept.push(c);
  }
  out.commitments = kept;
  return out;
}

module.exports = { gate, involvement, mentions, SOURCES, DELIVERY_SHAPED, REVIEW_SHAPED };
