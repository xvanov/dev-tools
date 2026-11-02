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
//   auto_merge    …and squash-merged once every check passed — any repo: the
//                 operator chose it for this run (operator decision 2026-11-02)
//   push_to_main  the commits are pushed onto the default branch, fast-forward
//                 only (dispatch.pushToMain); the agent itself could not push
//
// A run from before delivery levels (delivery null) keeps the old rule: a
// draft PR, opened without asking, and in my own repos (PA_MERGE_REPOS,
// src/dispatch/merge.js) marked ready and merged once its checks pass.

const { TimeoutError } = require('absurd-sdk');
const { one } = require('../../db');

const merger = require('../../dispatch/merge');
const D = require('../../dispatch/deliveryCore');

const name = 'run_review';
const CHECK_ROUNDS = 36;
const CHECK_EVERY_S = 300;
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

  // push_to_main: fast-forward the default branch, nothing else.
  if (plan && plan.toMain) {
    const pushed = await ctx.step('push-main', async () => {
      try {
        const r = await require('../../dispatch').pushToMain(runId);
        return { ok: true, base: r.base };
      } catch (err) {
        return { ok: false, why: String(err.stderr || err.message).trim().slice(0, 200) };
      }
    });
    await ctx.step('say-main', () =>
      require('../../notify').notify({
        kind: 'info',
        title: pushed.ok ? `Run #${runId}: pushed to ${pushed.base}` : `Run #${runId}: NOT pushed to main — ${pushed.why}`,
        body: `${String(found.task).slice(0, 160)}\n${pushed.ok ? `${found.commits.length} commit(s), fast-forward.` : `Its commits are still in the worktree: \`pa review ${runId}\`.`}`,
        dedupeKey: `pushed-main:${runId}`,
      }).then(() => true)
    );
    return { result: pushed.ok ? 'pushed to main' : 'not pushed' };
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

  let state = 'pending';
  for (let i = 0; i < CHECK_ROUNDS && state === 'pending'; i++) {
    if (i) await ctx.sleepFor(`wait-checks-${i}`, CHECK_EVERY_S);
    state = await ctx.step(`checks-${i}`, () => merger.checks(landed.mrUrl).catch(() => 'pending'));
  }
  const merged = await ctx.step('merge', async () => {
    if (state !== 'pass') return { ok: false, why: state === 'fail' ? 'a check failed' : 'checks still running after 3 hours' };
    try {
      await merger.ready(landed.mrUrl);
      await merger.merge(landed.mrUrl);
      // The measured outcome (sql/024, `pa runs stats`).
      await require('../../db').query(`update run set outcome = 'merged', outcome_at = now() where id = $1`, [runId]).catch(() => {});
      return { ok: true };
    } catch (err) {
      return { ok: false, why: String(err.stderr || err.message).trim().slice(0, 200) };
    }
  });
  await ctx.step('say-merged', () =>
    require('../../notify').notify({
      kind: 'info',
      title: merged.ok ? `Run #${runId}: merged into ${may.slug || 'its repo'}` : `Run #${runId}: not merged — ${merged.why}`,
      body: `${String(found.task).slice(0, 160)}\n${landed.mrUrl}`,
      url: landed.mrUrl,
      dedupeKey: `merged:${runId}`,
    }).then(() => true)
  );
  return { result: merged.ok ? 'merged' : 'not merged', mrUrl: landed.mrUrl };
}

module.exports = { name, run };
