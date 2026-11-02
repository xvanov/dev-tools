'use strict';

// From a finished run to its end state (durable task `run_review`, one per
// dispatched run on this machine).
//
// The run's session ends (dispatch.reconcile emits `run-ended:<id>`). The task
// reads what the run committed; with nothing committed it says so and ends.
// Otherwise it carries out the run's DELIVERY — the end state the operator
// chose (src/dispatch/deliveryCore.js finishPlan), recorded on the run:
//
//   none          nothing is pushed; I am told the work is in the worktree
//   branch        the branch is pushed
//   draft_pr      pushed, and a draft PR opened (or the agent's own found)
//   pr            …and marked ready for review
//   auto_merge    …and squash-merged at the checked commit — any repo: the
//                 operator chose it for this run (operator decision 2026-11-02)
//   push_to_main  the branch is pushed, then the default branch fast-forwarded
//                 to that commit (dispatch.pushBranch / pushToMain); the agent
//                 itself could not push
//
// Neither merge nor main moves before CI passed on that commit (ciWait,
// merge.ciGate: one poll a minute, at most 30 minutes). Red, late, or a main
// that moved on: the branch / PR stay, the run is `blocked`, I am told why.
//
// A run from before delivery levels (delivery null) keeps the old rule: a
// draft PR, opened without asking, and in my own repos (PA_MERGE_REPOS,
// src/dispatch/merge.js) marked ready and merged once its checks pass.

const { TimeoutError } = require('absurd-sdk');
const { one } = require('../../db');

const merger = require('../../dispatch/merge');
const D = require('../../dispatch/deliveryCore');

const name = 'run_review';
const WAIT_RUN_DAYS = 14;

async function awaitOr(ctx, event, stepName, days) {
  try {
    return await ctx.awaitEvent(event, { stepName, timeout: days * 86400 });
  } catch (err) {
    if (err instanceof TimeoutError) return null;
    throw err;
  }
}

async function run({ runId }, ctx) {
  const ended = await awaitOr(ctx, `run-ended:${runId}`, 'wait-run', WAIT_RUN_DAYS);
  if (!ended) return { result: 'run never ended' };

  const found = await ctx.step('review', async () => {
    const r = await one('select id, status, mode, task, commitment_id, machine, mr_url, delivery from run where id = $1', [runId]);
    // Local runs record this machine's hostname: only another machine's run is skipped.
    const local = require('../../dispatch/termhub').isLocal(r?.machine);
    if (!r || !local || r.status === 'landed' || r.status === 'dropped' || r.mr_url) return null;
    const rev = await require('../../dispatch').review(runId);
    const commits = (rev.commits || '').split('\n').filter(Boolean);
    return { mode: r.mode, task: r.task, commitmentId: r.commitment_id, commits, stat: rev.stat || '', uncommitted: rev.uncommitted || 0, delivery: r.delivery || null };
  });
  if (!found) return { result: 'nothing to land' };
  if (!found.commits.length) {
    await ctx.step('say-empty', () =>
      require('../../notify').notify({
        kind: 'info',
        title: `Run #${runId} ended without commits`,
        body: `${String(found.task).slice(0, 160)}\nOpen its session or \`pa drop ${runId}\`.`,
        dedupeKey: `run-empty:${runId}`,
      }).then(() => true)
    );
    return { result: 'no commits' };
  }
  // A research run (`plan`) is there to write up findings, not to change code:
  // nothing to open a PR for.
  if (found.mode === 'plan') {
    await ctx.step('say-research', () =>
      require('../../notify').notify({
        kind: 'info',
        title: `Research run #${runId} finished`,
        body: `${String(found.task).slice(0, 160)}\nRead its findings: \`pa review ${runId}\`.`,
        dedupeKey: `run-research:${runId}`,
      }).then(() => true)
    );
    return { result: 'research done' };
  }

  const plan = D.finishPlan(found.delivery);

  // none: the operator chose to keep it local.
  if (plan && !plan.push && !plan.toMain) {
    await ctx.step('say-local', () =>
      require('../../notify').notify({
        kind: 'info',
        title: `Run #${runId} finished — kept local`,
        body: `${String(found.task).slice(0, 160)}\n${found.commits.length} commit(s) in its worktree; nothing pushed (delivery none). \`pa review ${runId}\`, then \`pa land ${runId}\` or \`pa drop ${runId}\`.`,
        dedupeKey: `run-local:${runId}`,
      }).then(() => true)
    );
    return { result: 'kept local' };
  }

  // push_to_main: push the branch, wait for CI on that commit, then
  // fast-forward the default branch to exactly it. Red or too slow: the
  // branch stays, the run is blocked, and I am told why.
  if (plan && plan.toMain) {
    const pushed = await ctx.step('push-branch', async () => {
      try {
        const r = await require('../../dispatch').pushBranch(runId);
        const rr = await one('select repo_path from run where id = $1', [runId]);
        return { ok: true, sha: r.sha, base: r.base, branch: r.branch, slug: await merger.slugOf(rr.repo_path).catch(() => null) };
      } catch (err) {
        return { ok: false, why: String(err.stderr || err.message).trim().slice(0, 200) };
      }
    });
    if (!pushed.ok) return blocked(ctx, runId, found, `the branch could not be pushed: ${pushed.why}`, null);
    const gate = await ciWait(ctx, { slug: pushed.slug, sha: pushed.sha, base: pushed.base });
    if (gate.action !== 'proceed') return blocked(ctx, runId, found, `${gate.reason} — branch ${pushed.branch} left as it is; main not touched`, null);
    const main = await ctx.step('push-main', async () => {
      try {
        const r = await require('../../dispatch').pushToMain(runId, { sha: pushed.sha, note: gate.note || null });
        return { ok: true, base: r.base };
      } catch (err) {
        return { ok: false, why: String(err.stderr || err.message).trim().slice(0, 200) };
      }
    });
    if (!main.ok) return blocked(ctx, runId, found, `CI passed, but ${pushed.base} did not take the fast-forward (${main.why}) — rebase branch ${pushed.branch}`, null);
    await ctx.step('say-main', () =>
      require('../../notify').notify({
        kind: 'info',
        title: `Run #${runId}: pushed to ${main.base}`,
        body: `${String(found.task).slice(0, 160)}\n${found.commits.length} commit(s), fast-forward, after CI${gate.note ? ` (${gate.note})` : ' passed'}.`,
        dedupeKey: `pushed-main:${runId}`,
      }).then(() => true)
    );
    return { result: 'pushed to main' };
  }

  const landed = await ctx.step('land', async () => {
    const dispatch = require('../../dispatch');
    const modes = require('../../dispatch/modes');
    const r = await one('select mode, status, mr_url from run where id = $1', [runId]);
    if (r.status === 'landed') return { mrUrl: r.mr_url, already: true };
    if (!modes.mode(r.mode).mayPush) await require('../../db').query(`update run set mode = 'mr' where id = $1`, [runId]);
    return dispatch.land(runId, { openMr: plan ? plan.pr !== null : true });
  });
  await ctx.step('say-landed', () =>
    require('../../notify').notify({
      kind: 'info',
      title: plan && !plan.pr ? `Run #${runId}: branch pushed` : `Run #${runId}: draft PR opened`,
      body: [String(found.task).slice(0, 160), `${found.commits.length} commit${found.commits.length === 1 ? '' : 's'}${found.uncommitted ? `; ${found.uncommitted} uncommitted file(s) left out` : ''}.`,
        landed.mrUrl || (plan && !plan.pr ? `Branch pushed (delivery branch).` : `Branch pushed; the PR could not be opened — see \`pa review ${runId}\`.`)].join('\n'),
      url: landed.mrUrl || null,
      dedupeKey: `landed:${runId}`,
    }).then(() => true)
  );
  if (!landed.mrUrl) return { result: 'landed', mrUrl: null };

  // pr: ready for review, never merged.
  if (plan && plan.ready && !plan.merge) {
    const ready = await ctx.step('ready', () => merger.ready(landed.mrUrl).then(() => ({ ok: true }), (err) => ({ ok: false, why: String(err.stderr || err.message).trim().slice(0, 200) })));
    await ctx.step('say-ready', () =>
      require('../../notify').notify({
        kind: 'info',
        title: ready.ok ? `Run #${runId}: PR ready for review` : `Run #${runId}: PR left as draft — ${ready.why}`,
        body: `${String(found.task).slice(0, 160)}\n${landed.mrUrl}`,
        url: landed.mrUrl,
        dedupeKey: `ready:${runId}`,
      }).then(() => true)
    );
    return { result: ready.ok ? 'ready' : 'draft', mrUrl: landed.mrUrl };
  }

  // Merging: the operator chose auto_merge for this run, or — a run from
  // before delivery levels — the repo is one of mine (PA_MERGE_REPOS).
  const may = await ctx.step('merge-policy', async () => {
    const r = await one('select repo_path from run where id = $1', [runId]);
    const slug = await merger.slugOf(r.repo_path).catch(() => null);
    return { slug, may: plan ? plan.merge : merger.mayMerge(slug) };
  });
  if (!may.may) return { result: 'landed', mrUrl: landed.mrUrl };

  // Never before CI passed on the PR's own commit (bounded wait), and only that commit.
  const sha = await ctx.step('head', () => require('../../dispatch').headOf(runId).catch(() => null));
  const base = await ctx.step('base', async () => {
    const r = await one('select repo_path from run where id = $1', [runId]);
    return require('../../dispatch').defaultBranch(r.repo_path).catch(() => 'main');
  });
  if (!sha || !may.slug) return blocked(ctx, runId, found, 'could not read the PR\'s commit or repo to check its CI — the PR is left open', landed.mrUrl);
  const baseAtCi = await ctx.step('base-at-ci', () => merger.branchSha(may.slug, base).catch(() => null));
  const gate = await ciWait(ctx, { slug: may.slug, sha, base });
  if (gate.action !== 'proceed') return blocked(ctx, runId, found, `${gate.reason} — the PR is left open, not merged`, landed.mrUrl);
  const refusal = await ctx.step('pre-merge', async () => {
    const [pr, baseNow, req] = await Promise.all([
      merger.prState(landed.mrUrl).catch(() => null),
      merger.branchSha(may.slug, base).catch(() => null),
      merger.requiredChecks(may.slug, base).catch(() => ({ strict: false })),
    ]);
    return merger.mergeRefusal({ pr, defaultBranch: base, sha, baseShaAtCi: baseAtCi, baseShaNow: baseNow, strict: Boolean(req.strict) });
  });
  if (refusal) return blocked(ctx, runId, found, `${refusal} — the PR is left open, not merged`, landed.mrUrl);
  const merged = await ctx.step('merge', async () => {
    try {
      await merger.ready(landed.mrUrl).catch(() => {});
      await merger.mergeAt(landed.mrUrl, sha);
      // The measured outcome (sql/024, `pa runs stats`).
      await require('../../db').query(`update run set outcome = 'merged', outcome_at = now(), exit_note = coalesce($2, exit_note) where id = $1`, [runId, gate.note || null]).catch(() => {});
      return { ok: true };
    } catch (err) {
      return { ok: false, why: String(err.stderr || err.message).trim().slice(0, 200) };
    }
  });
  if (!merged.ok) return blocked(ctx, runId, found, `CI passed, but the merge failed: ${merged.why}`, landed.mrUrl);
  await ctx.step('say-merged', () =>
    require('../../notify').notify({
      kind: 'info',
      title: `Run #${runId}: merged into ${may.slug}`,
      body: `${String(found.task).slice(0, 160)}\n${landed.mrUrl}${gate.note ? `\n${gate.note}` : ''}`,
      url: landed.mrUrl,
      dedupeKey: `merged:${runId}`,
    }).then(() => true)
  );
  return { result: 'merged', mrUrl: landed.mrUrl };
}

/**
 * Polls one commit's CI, each poll a checkpointed step, for at most
 * merge.CI_LIMIT_MS (merge.ciGate decides). Elapsed time is counted in polls,
 * not read from the clock, so a replayed task decides the same way.
 */
async function ciWait(ctx, { slug, sha, base }) {
  const required = await ctx.step('ci-required', () => merger.requiredChecks(slug, base).catch(() => ({ known: false, contexts: [] })));
  const rounds = Math.ceil(merger.CI_LIMIT_MS / merger.CI_POLL_MS) + 1;
  let previous = null;
  for (let i = 0; i < rounds; i++) {
    if (i) await ctx.sleepFor(`ci-wait-${i}`, merger.CI_POLL_MS / 1000);
    const checks = await ctx.step(`ci-${i}`, () => merger.commitChecks(slug, sha).catch(() => ({ state: 'pending', names: [], failed: [] })));
    const g = merger.ciGate({ checks, previous, required, elapsedMs: i * merger.CI_POLL_MS });
    if (g.action !== 'wait') return g;
    previous = checks;
  }
  return { action: 'block', reason: `CI still running after ${Math.round(merger.CI_LIMIT_MS / 60_000)} min` };
}

async function blocked(ctx, runId, found, reason, url) {
  await ctx.step('blocked', () => require('../../dispatch').blockRun(runId, reason).then(() => true));
  await ctx.step('say-blocked', () =>
    require('../../notify').notify({
      kind: 'info',
      title: `Run #${runId} blocked: ${reason}`.slice(0, 200),
      body: `${String(found.task).slice(0, 160)}\n${url || `\`pa review ${runId}\``}`,
      url: url || null,
      dedupeKey: `blocked:${runId}`,
    }).then(() => true)
  );
  return { result: 'blocked', reason, mrUrl: url };
}

module.exports = { name, run };
