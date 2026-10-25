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

module.exports = { mayMerge, summarize, slugOf, checks, ready, merge };
