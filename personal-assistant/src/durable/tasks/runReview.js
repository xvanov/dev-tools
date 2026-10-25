'use strict';

// From a finished run to a draft PR (durable task `run_review`, one per
// dispatched run on this machine).
//
// The run's session ends (dispatch.reconcile emits `run-ended:<id>`). The task
// reads what the run committed; with nothing committed it says so and ends.
// Otherwise it pushes the branch and opens a *draft* PR through `pa land`'s
// own code, and tells me. It does not ask first: I decided a draft PR is
// always fine to open, since a draft merges nothing and anyone can close it.
// A run made in a mode that may not push (`plan`, `local`) is moved to `mr`
// first. In my own repos (PA_MERGE_REPOS, src/dispatch/merge.js) the PR is
// then marked ready and squash-merged once its checks pass; elsewhere when it
// is marked ready and whether it merges stays mine.

const { TimeoutError } = require('absurd-sdk');
const { one } = require('../../db');

const merger = require('../../dispatch/merge');

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
    const r = await one('select id, status, mode, task, commitment_id, machine, mr_url from run where id = $1', [runId]);
    if (!r || r.machine || r.status === 'landed' || r.status === 'dropped' || r.mr_url) return null;
    const rev = await require('../../dispatch').review(runId);
    const commits = (rev.commits || '').split('\n').filter(Boolean);
    return { mode: r.mode, task: r.task, commitmentId: r.commitment_id, commits, stat: rev.stat || '', uncommitted: rev.uncommitted || 0 };
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

  const landed = await ctx.step('land', async () => {
    const dispatch = require('../../dispatch');
    const modes = require('../../dispatch/modes');
    const r = await one('select mode, status, mr_url from run where id = $1', [runId]);
    if (r.status === 'landed') return { mrUrl: r.mr_url, already: true };
    if (!modes.mode(r.mode).mayPush) await require('../../db').query(`update run set mode = 'mr' where id = $1`, [runId]);
    return dispatch.land(runId, { openMr: true });
  });
  await ctx.step('say-landed', () =>
    require('../../notify').notify({
      kind: 'info',
      title: `Run #${runId}: draft PR opened`,
      body: [String(found.task).slice(0, 160), `${found.commits.length} commit${found.commits.length === 1 ? '' : 's'}${found.uncommitted ? `; ${found.uncommitted} uncommitted file(s) left out` : ''}.`,
        landed.mrUrl || `Branch pushed; the PR could not be opened — see \`pa review ${runId}\`.`].join('\n'),
      url: landed.mrUrl || null,
      dedupeKey: `landed:${runId}`,
    }).then(() => true)
  );
  if (!landed.mrUrl) return { result: 'landed', mrUrl: null };

  // My own repos: ready, checks, merge. Everywhere else the draft is mine.
  const may = await ctx.step('merge-policy', async () => {
    const r = await one('select repo_path from run where id = $1', [runId]);
    const slug = await merger.slugOf(r.repo_path).catch(() => null);
    return { slug, may: merger.mayMerge(slug) };
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
      return { ok: true };
    } catch (err) {
      return { ok: false, why: String(err.stderr || err.message).trim().slice(0, 200) };
    }
  });
  await ctx.step('say-merged', () =>
    require('../../notify').notify({
      kind: 'info',
      title: merged.ok ? `Run #${runId}: merged into ${may.slug}` : `Run #${runId}: not merged — ${merged.why}`,
      body: `${String(found.task).slice(0, 160)}\n${landed.mrUrl}`,
      url: landed.mrUrl,
      dedupeKey: `merged:${runId}`,
    }).then(() => true)
  );
  return { result: merged.ok ? 'merged' : 'not merged', mrUrl: landed.mrUrl };
}

module.exports = { name, run };
