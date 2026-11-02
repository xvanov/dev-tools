'use strict';

// Merging a finished run's PR, in my own repos only (run_review,
// src/durable/tasks/runReview.js).
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

const { execFile } = require('child_process');
const { promisify } = require('util');
const { config } = require('../config');

const exec = promisify(execFile);

function mayMerge(slug, list = config.dispatch.mergeRepos) {
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
function summarize(rows) {
  const buckets = (rows || []).map((r) => r.bucket);
  if (buckets.some((b) => b === 'fail' || b === 'cancel')) return 'fail';
  if (buckets.some((b) => b === 'pending')) return 'pending';
  return 'pass';
}

const gh = (args, cwd) => exec(config.github.bin, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

async function slugOf(dir) {
  const { stdout } = await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], dir);
  return stdout.trim();
}

async function checks(url) {
  try {
    const { stdout } = await gh(['pr', 'checks', url, '--json', 'name,bucket']);
    return summarize(JSON.parse(stdout || '[]'));
  } catch (err) {
    // gh exits non-zero both for "no checks reported" and for failing checks;
    // the JSON on stdout, when there is any, is still the answer.
    const out = String(err.stdout || '').trim();
    if (out.startsWith('[')) return summarize(JSON.parse(out));
    if (/no checks reported/i.test(String(err.stderr || ''))) return 'pass';
    throw err;
  }
}

async function ready(url) {
  await gh(['pr', 'ready', url]);
}

// No --delete-branch: from a checkout it also switches branches there.
async function merge(url) {
  await gh(['pr', 'merge', url, '--squash']);
}


// --- the CI gate on one commit ------------------------------------------------------

const CI_LIMIT_MS = 30 * 60_000;
const CI_POLL_MS = 60_000;
// Checks take a moment to register after a push: "none reported" is believed
// only after this long.
const CI_SETTLE_MS = 3 * 60_000;

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/**
 * Pure. GitHub's check runs and commit statuses for one commit, as one state.
 * @returns {{state: 'none'|'pending'|'pass'|'fail', names: Array<string>, failed: Array<string>}}
 */
function summarizeCommit({ checkRuns = [], statuses = [] } = {}) {
  const names = [];
  const failed = [];
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
 * @param {object} o
 * @param {{state, names, failed}} o.checks   summarizeCommit
 * @param {{known: boolean, contexts: Array<string>}} o.required  the base branch's required checks
 * @param {number} o.elapsedMs   since the gate started
 * @returns {{action: 'proceed'|'wait'|'block', reason?: string, note?: string}}
 */
function ciGate({ checks, required, elapsedMs, limitMs = CI_LIMIT_MS, settleMs = CI_SETTLE_MS }) {
  const late = elapsedMs >= limitMs;
  const mins = Math.round(limitMs / 60_000);
  if (checks.state === 'fail') return { action: 'block', reason: `CI failed: ${checks.failed.slice(0, 5).join(', ')}` };
  const missing = (required.contexts || []).filter((c) => !checks.names.includes(c));
  if (checks.state === 'pass' && !missing.length) return { action: 'proceed' };
  if (checks.state === 'none' && !missing.length) {
    if (elapsedMs < settleMs) return { action: 'wait' };
    if (!required.known) return { action: 'block', reason: 'no CI checks reported, and the assistant could not confirm the repo requires none' };
    return { action: 'proceed', note: 'no CI checks are configured on this repo and none are required — delivered without CI' };
  }
  if (late) {
    if (missing.length && checks.state !== 'pending') return { action: 'block', reason: `required checks never reported in ${mins} min: ${missing.slice(0, 5).join(', ')}` };
    return { action: 'block', reason: `CI still running after ${mins} min` };
  }
  return { action: 'wait' };
}

async function ghJson(args) {
  const { stdout } = await gh(['api', ...args]);
  return JSON.parse(stdout || 'null');
}

async function commitChecks(slug, sha) {
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
async function requiredChecks(slug, base) {
  const contexts = new Set();
  let known = true;
  try {
    const b = await ghJson([`repos/${slug}/branches/${encodeURIComponent(base)}`]);
    const rc = b?.protection?.required_status_checks;
    for (const c of rc?.contexts || []) contexts.add(c);
    for (const c of rc?.checks || []) if (c?.context) contexts.add(c.context);
  } catch {
    known = false;
  }
  try {
    const rules = await ghJson([`repos/${slug}/rules/branches/${encodeURIComponent(base)}`]);
    for (const r of Array.isArray(rules) ? rules : []) {
      if (r.type !== 'required_status_checks') continue;
      for (const c of r.parameters?.required_status_checks || []) if (c?.context) contexts.add(c.context);
    }
  } catch {
    known = false;
  }
  return { known, contexts: [...contexts] };
}

// Only the commit the gate passed is merged: a push after the checks ran is
// refused by GitHub rather than merged unchecked.
async function mergeAt(url, sha) {
  await gh(['pr', 'merge', url, '--squash', '--match-head-commit', sha]);
}

module.exports = {
  mayMerge, summarize, slugOf, checks, ready, merge,
  CI_LIMIT_MS, CI_POLL_MS, CI_SETTLE_MS, summarizeCommit, ciGate, commitChecks, requiredChecks, mergeAt,
};
