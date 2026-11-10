'use strict';

// Merging a finished run's PR, in my own repos only (run_review,
// src/durable/tasks/runReview.ts).
//
// Where other people work, a run's PR stays a draft: when it is marked ready
// and whether it merges is mine to decide. In the repos I own and listed in
// PA_MERGE_REPOS (`owner/repo`, or `owner/*` for everything an account owns),
// the PR is marked ready, its checks are waited for, and it is squash-merged
// once they pass — never with a failing or cancelled check.
//
//   mayMerge(slug, list)   pure: is this repo on the list
//   summarize(checks)      pure: gh's check rows → pending | pass | fail
//   slugOf(dir)            owner/repo of a checkout, from gh
//   checks(url) / ready(url) / merge(url)
//
// The CI gate before a merge or a push to main (run_review, auto_merge and
// push_to_main): the checks on ONE commit, polled for at most CI_LIMIT_MS.
//   summarizeCommit({checkRuns, statuses})  pure: → {state, names}
//   ciGate({...})                           pure: proceed | wait | block, and why
//   commitChecks(slug, sha) / requiredChecks(slug, base)
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Bucket = 'pending' | 'pass' | 'fail';
type CommitState = 'none' | 'pending' | 'pass' | 'fail';
type CommitChecks = { state: CommitState; names: string[]; failed: string[] };
type Required = { known: boolean; contexts: string[]; strict?: boolean };
type GateAction = { action: 'proceed' | 'wait' | 'block'; reason?: string; note?: string };
/** gh's answer for a PR (prState), or a test's stand-in. */
type PrView = { baseRefName?: string; headRefOid?: string; isCrossRepository?: boolean; state?: string };

const { execFile } = require('child_process');
const { promisify } = require('util');
const { config } = require('../config.ts');

const exec = promisify(execFile);

function mayMerge(slug: unknown, list: string[] = config.dispatch.mergeRepos): boolean {
  const s = String(slug || '').toLowerCase();
  if (!s.includes('/')) return false;
  const owner = s.split('/')[0];
  return list.some((entry) => {
    const e = String(entry).trim().toLowerCase();
    return e === s || e === `${owner}/*`;
  });
}

// `gh pr checks --json bucket`: pass, fail, pending, skipping, cancel. No
// checks at all is a pass: there is nothing to wait for.
function summarize(rows: Array<{ bucket?: string }> | null | undefined): Bucket {
  const buckets = (rows || []).map((r) => r.bucket);
  if (buckets.some((b) => b === 'fail' || b === 'cancel')) return 'fail';
  if (buckets.some((b) => b === 'pending')) return 'pending';
  return 'pass';
}

const gh = (args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> =>
  exec(config.github.bin, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

async function slugOf(dir: string): Promise<string> {
  const { stdout } = await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], dir);
  return stdout.trim();
}

async function checks(url: string): Promise<Bucket> {
  try {
    const { stdout } = await gh(['pr', 'checks', url, '--json', 'name,bucket']);
    return summarize(JSON.parse(stdout || '[]'));
  } catch (err) {
    // gh exits non-zero both for "no checks reported" and for failing checks;
    // the JSON on stdout, when there is any, is still the answer.
    const e = err as { stdout?: unknown; stderr?: unknown };
    const out = String(e.stdout || '').trim();
    if (out.startsWith('[')) return summarize(JSON.parse(out));
    if (/no checks reported/i.test(String(e.stderr || ''))) return 'pass';
    throw err;
  }
}

async function ready(url: string): Promise<void> {
  await gh(['pr', 'ready', url]);
}

// No --delete-branch: from a checkout it also switches branches there.
async function merge(url: string): Promise<void> {
  await gh(['pr', 'merge', url, '--squash']);
}


// --- the CI gate on one commit ------------------------------------------------------

const CI_LIMIT_MS = 30 * 60_000;
const CI_POLL_MS = 60_000;
// Checks take a moment to register after a push: "none reported" is believed
// only after this long.
const CI_SETTLE_MS = 3 * 60_000;

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/** Pure. GitHub's check runs and commit statuses for one commit, as one state. */
function summarizeCommit({ checkRuns = [], statuses = [] }: { checkRuns?: Json[] | null; statuses?: Json[] | null } = {}): CommitChecks {
  const names: string[] = [];
  const failed: string[] = [];
  let pending = false;
  for (const r of checkRuns || []) {
    names.push(r.name);
    if (r.status !== 'completed') pending = true;
    else if (BAD.has(r.conclusion)) failed.push(r.name);
  }
  // The combined-status API lists the latest status per context.
  for (const st of statuses || []) {
    names.push(st.context);
    if (st.state === 'failure' || st.state === 'error') failed.push(st.context);
    else if (st.state === 'pending') pending = true;
  }
  const state = failed.length ? 'fail' : pending ? 'pending' : names.length ? 'pass' : 'none';
  return { state, names, failed };
}

/**
 * Pure. What to do now with a commit waiting to be merged or pushed to main.
 * Proceeds only when the commit provably passed:
 *   - the base branch's required checks are KNOWN (unreadable rules → block),
 *     every one of them reported on this commit, and all passed;
 *   - nothing failed, nothing still running;
 *   - at least CI_SETTLE_MS since the gate started (checks register late: a
 *     first poll that shows one green check may be before the others exist);
 *   - with no required checks, the same green set on two polls in a row;
 *   - no checks at all: only when none are required, and noted on the run.
 * `checks` is summarizeCommit's for this poll, `previous` the poll before.
 */
function ciGate({
  checks,
  previous = null,
  required,
  elapsedMs,
  limitMs = CI_LIMIT_MS,
  settleMs = CI_SETTLE_MS,
}: {
  checks: CommitChecks;
  previous?: { state: CommitState; names: string[] } | null;
  required: Required | null | undefined;
  elapsedMs: number;
  limitMs?: number;
  settleMs?: number;
}): GateAction {
  const late = elapsedMs >= limitMs;
  const mins = Math.round(limitMs / 60_000);
  if (checks.state === 'fail') return { action: 'block', reason: `CI failed: ${checks.failed.slice(0, 5).join(', ')}` };
  if (!required || required.known !== true) return { action: 'block', reason: 'could not read which checks the base branch requires — not merging blind' };
  const missing = (required.contexts || []).filter((c) => !checks.names.includes(c));
  if (missing.length || checks.state === 'pending') {
    if (!late) return { action: 'wait' };
    return missing.length && checks.state !== 'pending'
      ? { action: 'block', reason: `required checks never reported in ${mins} min: ${missing.slice(0, 5).join(', ')}` }
      : { action: 'block', reason: `CI still running after ${mins} min` };
  }
  if (elapsedMs < settleMs) return { action: 'wait' };
  if (checks.state === 'none') {
    return { action: 'proceed', note: 'no CI checks are configured on this repo and none are required — delivered without CI' };
  }
  // pass, every required check present and green.
  if ((required.contexts || []).length) return { action: 'proceed' };
  const same = previous && previous.state === 'pass' && [...previous.names].sort().join('\n') === [...checks.names].sort().join('\n');
  if (same) return { action: 'proceed' };
  return late ? { action: 'block', reason: `CI never settled in ${mins} min` } : { action: 'wait' };
}

/**
 * Pure. The last look before an auto_merge: the PR is the one the gate
 * checked. Its base is the default branch, it is not from a fork, its head is
 * the checked commit, and — unless the repo itself requires branches to be up
 * to date (GitHub then refuses a stale merge) — that commit already contains
 * the base as it is NOW (compare: behind_by 0), so the squash GitHub makes is
 * the tree CI tested. Anything unreadable refuses. `behindBy` is the commits
 * on the base the head does not have (null: could not read). Returns why not,
 * or null to merge.
 */
function mergeRefusal({
  pr,
  defaultBranch,
  sha,
  behindBy,
  strict,
}: {
  pr: PrView | null | undefined;
  defaultBranch: string;
  sha: string;
  behindBy: number | null | undefined;
  strict?: boolean;
}): string | null {
  if (!pr) return 'could not read the PR';
  if (pr.baseRefName !== defaultBranch) return `the PR targets ${pr.baseRefName}, not ${defaultBranch}`;
  if (pr.isCrossRepository) return 'the PR comes from another repository';
  if (pr.headRefOid !== sha) return `the PR's head moved to ${String(pr.headRefOid).slice(0, 12)} after CI checked ${String(sha).slice(0, 12)}`;
  if (strict) return null;
  if (behindBy === null || behindBy === undefined || !Number.isFinite(Number(behindBy))) {
    return `could not check that the PR contains the current ${defaultBranch} — not merging blind`;
  }
  if (Number(behindBy) > 0) {
    return `${defaultBranch} has ${behindBy} commit(s) the checked commit does not (the merged result was never tested; the repo does not require up-to-date branches)`;
  }
  return null;
}

// GitHub's REST JSON, read key by key.
async function ghJson(args: string[]): Promise<Json | null> {
  const { stdout } = await gh(['api', ...args]);
  return JSON.parse(stdout || 'null');
}

async function commitChecks(slug: string, sha: string): Promise<CommitChecks> {
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new Error(`not a commit: ${sha}`);
  const [runs, status] = await Promise.all([
    ghJson([`repos/${slug}/commits/${sha}/check-runs?per_page=100`]),
    ghJson([`repos/${slug}/commits/${sha}/status`]),
  ]);
  return summarizeCommit({ checkRuns: runs?.check_runs || [], statuses: status?.statuses || [] });
}

/**
 * The checks the base branch requires: classic branch protection (readable
 * without admin through the branch endpoint) and repository rulesets. Either
 * one unreadable → `known: false`, which never counts as "none required".
 */
async function requiredChecks(slug: string, base: string): Promise<Required & { strict: boolean }> {
  const contexts = new Set<string>();
  let known = true;
  let strict = false;
  try {
    const b = await ghJson([`repos/${slug}/branches/${encodeURIComponent(base)}`]);
    const rc = b?.protection?.required_status_checks;
    for (const c of rc?.contexts || []) contexts.add(c);
    for (const c of rc?.checks || []) if (c?.context) contexts.add(c.context);
    if (rc?.strict) strict = true;
  } catch {
    known = false;
  }
  try {
    const rules = await ghJson([`repos/${slug}/rules/branches/${encodeURIComponent(base)}`]);
    for (const r of Array.isArray(rules) ? rules : []) {
      if (r.type !== 'required_status_checks') continue;
      for (const c of r.parameters?.required_status_checks || []) if (c?.context) contexts.add(c.context);
      if (r.parameters?.strict_required_status_checks_policy) strict = true;
    }
  } catch {
    known = false;
  }
  return { known, contexts: [...contexts], strict };
}

async function prState(url: string): Promise<PrView | null> {
  const { stdout } = await gh(['pr', 'view', url, '--json', 'baseRefName,headRefOid,isCrossRepository,state']);
  return JSON.parse(stdout || 'null');
}

/** Commits on `base` that `sha` does not contain (GitHub compare), or null. */
async function behindBy(slug: string, base: string, sha: string): Promise<number | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) return null;
  const c = await ghJson([`repos/${slug}/compare/${encodeURIComponent(base)}...${sha}`]);
  return Number.isFinite(Number(c?.behind_by)) ? Number(c?.behind_by) : null;
}

// Only the commit the gate passed is merged: a push after the checks ran is
// refused by GitHub rather than merged unchecked.
async function mergeAt(url: string, sha: string): Promise<void> {
  await gh(['pr', 'merge', url, '--squash', '--match-head-commit', sha]);
}

module.exports = {
  mayMerge, summarize, slugOf, checks, ready, merge,
  CI_LIMIT_MS, CI_POLL_MS, CI_SETTLE_MS, summarizeCommit, ciGate, mergeRefusal, commitChecks, requiredChecks, prState, behindBy, mergeAt,
};
