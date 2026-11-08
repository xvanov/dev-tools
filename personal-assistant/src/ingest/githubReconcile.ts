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
// last two settle on merged or closed, and a review ask also on a review the
// user submitted after it was asked ("can you review #1814" in chat is done
// once you have reviewed #1814). "Requested from a team" is about GitHub's
// review requests, which a chat ask is not. An ask naming several PRs ("Have
// Brannoc approve ERP PRs 2023, 2064 and 2076", "Address the comments on PRs
// #2064 and #2056") settles only when every one of them is merged or closed.
//
// It also folds repeated review asks for one PR into one: each notification
// about a PR used to be distilled into a fresh "Review PR …" card. The older
// ones are marked `superseded_by` the newest, as consolidation does for any
// restatement; nothing is deleted.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const repo = require('../repo');
const ledger = require('../ledger');
const { logger } = require('../log.ts');

const log = logger('github');

const PR_URL = /github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d+)/;

function prRef(text: any) {
  const m = PR_URL.exec(String(text || '')) as any;
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
function refFor(c: any) {
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

// "Have Quill Ashby re-review ERP PR #2021" is the same ask as "re-review PR
// #2021", owed to me instead of by me.
const HAVE_SOMEONE = /^[Hh]ave\s+(?:[A-Z][\w'.-]*\s+){1,3}(?=(?:re-?)?(?:review|approve|merge)\b)/;
// "Address the review comments on PRs #2064 and #2056" is moot once they merged.
const COMMENTS_ASK = /^(?:finish\s+)?(?:address|fix(?:ing)?|resolve|answer)\b.*\bcomments?\b/i;
const PR_WORD = /\b(?:PRs?|pull\s+requests?)\b/i;
// A PR number in a list: "#2062", "2023," — not "134.1.0", "5a" or "PR-5".
const LIST_NUMBER = /(?<![\w.\-])#?(\d{1,6})(?![\w\-]|\.\d)/g;

/**
 * Every PR a commitment is about, for asks that name several ("Review and
 * approve ERP PRs #2062 and #2056", "Have Brannoc review ERP PRs 2023, 2064,
 * and 2076") or name the PR without the word ("Finish fixing the review
 * comments on ERP #2062"), which refFor does not guess at. A multi-PR ask is
 * settled only once every PR it names is merged or closed — see `settledAll`.
 * @param {object} c  as refFor, plus projectName (the project's short name, e.g. "erp")
 * @returns {{refs: Array, fromText: true}|null}
 */
function refsFor(c: any) {
  const single = refFor(c);
  if (single) return { refs: [single.ref], fromText: single.fromText };
  const summary = String(c.summary || '').replace(HAVE_SOMEONE, '');
  if (!PR_ACTION.test(summary) && !COMMENTS_ASK.test(summary)) return null;
  if (!c.projectPath || !/^[^/\s]+\/[^/\s]+$/.test(c.projectPath)) return null;
  const name = String(c.projectName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = name ? new RegExp(`${PR_WORD.source}|\\b${name}\\b(?=\\s+#?\\d)`, 'i') : PR_WORD;
  const at = summary.search(marker);
  if (at < 0) return null;
  const numbers = [...new Set([...summary.slice(at).matchAll(LIST_NUMBER)].map((m) => Number(m[1])))];
  if (!numbers.length) return null;
  const [owner, repo] = c.projectPath.split('/');
  return {
    refs: numbers.map((n) => ({ owner, repo, number: n, key: `${owner}/${repo}#${n}`.toLowerCase() })),
    fromText: true,
  };
}

/**
 * A multi-PR ask, given every PR it names: done once all are merged or closed
 * and at least one merged; dropped if all closed unmerged; otherwise open.
 * @param {Array} list  [{ref, pr}] with pr as in verdict
 */
function settledAll(list: any) {
  if (!list.length || list.some(({ pr }: any) => !pr || (!pr.merged && pr.state !== 'closed'))) return null;
  const nums = list.map(({ ref }: any) => `#${ref.number}`).join(', ');
  const merged = list.filter(({ pr }: any) => pr.merged);
  if (!merged.length) return { status: 'dropped', reason: `PRs ${nums} closed without merging` };
  const last = merged.map(({ pr }: any) => pr.mergedAt).filter(Boolean).sort().pop();
  return { status: 'done', reason: `PRs ${nums} merged or closed${day(last)}` };
}

function day(iso: any) {
  return iso ? ` ${String(iso).slice(0, 10)}` : '';
}

/**
 * What to do with one open commitment, given the PR it is about.
 * @param {object} c       {summary, action, fromText} — action is the source item's raw.action
 * @param {object} pr      {state, merged, mergedAt, closedAt, requestedLogins: string[], authorLogin}
 * @param {Array} myReviews  the user's reviews on it: [{state, submittedAt}] (bare states accepted)
 * @param {string} login
 * @returns {{status:'done'|'dropped', reason:string}|null}
 */
function verdict(c: any, pr: any, myReviews: any, login: any) {
  if (!pr) return null;
  if (pr.merged) return { status: 'done', reason: `PR merged${day(pr.mergedAt)}` };
  if (pr.state === 'closed') return { status: 'dropped', reason: `PR closed without merging${day(pr.closedAt)}` };

  const isReview = c.action === 'review_requested' || c.action === 'team_review_requested' || REVIEW_ASK.test(c.summary || '');
  const reviews = (myReviews || []).map((r: any) => (typeof r === 'string' ? { state: r, submittedAt: null as any } : r));
  // A review submitted after the ask was made answers it, however it was asked.
  const askedAt = c.askedAt ? new Date(c.askedAt).getTime() : null;
  const answering = reviews.filter(
    (r: any) => r.state !== 'PENDING' && (askedAt == null || !r.submittedAt || new Date(r.submittedAt).getTime() > askedAt)
  );
  if (c.fromText) {
    if (!isReview || pr.authorLogin === login || !answering.length) return null;
    return { status: 'done', reason: `you reviewed it${day(answering[answering.length - 1].submittedAt)}` };
  }
  if (!isReview || pr.authorLogin === login) return null;

  const stillRequested = pr.requestedLogins.includes(login);
  if (stillRequested) return null;
  if (reviews.length) return { status: 'done', reason: 'you reviewed it' };
  return { status: 'dropped', reason: 'review was requested from a team, not from you' };
}

/**
 * Repeated review asks for one PR, folded into one.
 * @param {Array} list  [{id, key, direction, summary, status, supersededBy}] open commitments with a PR key
 * @returns {Array} [{id, supersededBy}] — older review asks point at the newest
 *   (a dispatched one is kept in preference, and is never superseded)
 */
function duplicatePlan(list: any) {
  const groups = new Map<any, any>();
  for (const c of list) {
    if (c.supersededBy != null || !c.key || !PR_ACTION.test(c.summary || '') || !REVIEW_ASK.test(c.summary || '')) continue;
    const k = `${c.direction || ''} ${c.key}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out: any[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => Number(a.id) - Number(b.id));
    const keep = sorted.filter((c) => c.status === 'dispatched').pop() || sorted[sorted.length - 1];
    for (const c of sorted) if (c !== keep && c.status !== 'dispatched') out.push({ id: c.id, supersededBy: keep.id });
  }
  return out;
}

async function openWithRefs() {
  const list = await repo.commitments.withPrRefs();
  const out: any[] = [];
  for (const c of list) {
    const r = refsFor({ summary: c.summary, detail: c.detail, url: c.url, projectPath: c.project_path, projectName: c.project_name });
    if (r) out.push({ ...c, askedAt: c.asked_at, refs: r.refs, ref: r.refs.length === 1 ? r.refs[0] : null, fromText: r.fromText });
  }
  return out;
}

async function lookup(api: any, ref: any, login: any) {
  const p = await api(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  const pr = {
    state: p.state,
    merged: Boolean(p.merged || p.merged_at),
    mergedAt: p.merged_at || null,
    closedAt: p.closed_at || null,
    requestedLogins: (p.requested_reviewers || []).map((u: any) => u.login),
    authorLogin: p.user?.login || null,
  };
  let mine: any[] = [];
  if (!pr.merged && pr.state === 'open') {
    const reviews = await api(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`);
    mine = reviews
      .filter((r: any) => r.user?.login === login)
      .map((r: any) => ({ state: r.state, submittedAt: r.submitted_at || null }));
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
async function plan({ api, login }: { api?: any | null; login?: any | null }) {
  const open = await openWithRefs();
  // One lookup per PR, however many commitments name it.
  const looks = new Map<any, any>();
  const look = (ref: any) => {
    if (!looks.has(ref.key)) {
      looks.set(
        ref.key,
        lookup(api, ref, login).catch((err: any) => {
          log.debug('reconcile: PR lookup failed', { pr: ref.key, message: err.message });
          return null;
        })
      );
    }
    return looks.get(ref.key);
  };

  const closes: any[] = [];
  const settled = new Set<any>();
  for (const c of open) {
    const looked = await Promise.all(c.refs.map(look));
    if (c.status !== 'open' || looked.some((l) => !l)) continue;
    const v =
      c.refs.length === 1
        ? verdict(c, looked[0].pr, looked[0].mine, login)
        : settledAll(c.refs.map((ref: any, i: any) => ({ ref, pr: looked[i].pr })));
    if (!v) continue;
    closes.push({ id: c.id, status: v.status, reason: v.reason, pr: c.refs.map((r: any) => r.key).join(' ') });
    settled.add(String(c.id));
  }

  const duplicates = duplicatePlan(
    open
      .filter((c) => c.ref && !settled.has(String(c.id)))
      .map((c) => ({ id: c.id, key: c.ref.key, direction: c.direction, summary: c.summary, status: c.status, supersededBy: c.superseded_by }))
  ).map((d) => ({ ...d, pr: open.find((c) => String(c.id) === String(d.id)).ref.key }));

  return { checked: looks.size, closes, duplicates };
}

async function reconcile({ api, login }: { api?: any | null; login?: any | null }) {
  const { checked, closes, duplicates } = await plan({ api, login });
  let closed = 0;
  for (const c of closes) {
    const r = await ledger.transition({ commitmentId: c.id, to: c.status, actor: 'github', reason: c.reason, from: ['open'] });
    if (r.changed) closed++;
  }
  let folded = 0;
  for (const d of duplicates) {
    folded += await repo.commitments.foldOpen(d.id, d.supersededBy);
  }
  if (closed || folded) log.info('reconciled commitments', { closed, folded, prs: checked });
  return { checked, closed, folded };
}

module.exports = { reconcile, plan, verdict, prRef, refFor, refsFor, settledAll, duplicatePlan };
