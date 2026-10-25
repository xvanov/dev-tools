'use strict';

// From a finished run to a draft PR, with me in between (durable task
// `run_review`, one per dispatched run on this machine).
//
// The run's session ends (dispatch.reconcile emits `run-ended:<id>`). The task
// reads what the run committed; with nothing committed it says so and ends.
// Otherwise it puts one proposal in "Needs you" — "Run #N finished, 3 commits:
// open a draft PR?" with the diffstat — and waits up to a week. Accepting
// pushes the branch and opens a *draft* PR through `pa land`'s own code; a run
// made in a mode that may not push (`plan`, `local`) is moved to `mr` first,
// because my accept is exactly the decision `pa land` exists to record.
// Declined or expired: the worktree stays for `pa review` / `pa drop`.

const { TimeoutError } = require('absurd-sdk');
const { one } = require('../../db');

const name = 'run_review';
const WAIT_RUN_DAYS = 14;
const WAIT_ANSWER_DAYS = 7;

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

  const proposal = await ctx.step('propose', async () => {
    const p = await require('../../proposals').create({
      kind: 'land',
      runId,
      commitmentId: found.commitmentId,
      title: `Run #${runId} finished — ${found.commits.length} commit${found.commits.length === 1 ? '' : 's'}. Open a draft PR?`,
      body: [found.task, '', ...found.commits.slice(0, 10), '', found.stat, found.uncommitted ? `\n${found.uncommitted} uncommitted file(s) will not be included.` : '']
        .join('\n')
        .trim(),
      payload: { task: name },
      dedupeKey: `land:${runId}`,
      expiresAt: new Date(Date.now() + WAIT_ANSWER_DAYS * 86400_000),
    });
    const id = p ? Number(p.id) : Number((await one('select id from proposal where dedupe_key = $1', [`land:${runId}`])).id);
    await require('../../notify').notify({
      kind: 'info',
      title: `Run #${runId} finished — open a draft PR?`,
      body: String(found.task).slice(0, 200),
      dedupeKey: `land-proposed:${runId}`,
    });
    return { id };
  });

  const answer = await awaitOr(ctx, `proposal:${proposal.id}`, 'wait-answer', WAIT_ANSWER_DAYS + 1);
  if (!answer || !answer.accepted) return { result: answer?.expired ? 'expired' : 'declined' };

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
      body: landed.mrUrl || `Branch pushed; the PR could not be opened — see \`pa review ${runId}\`.`,
      url: landed.mrUrl || null,
      dedupeKey: `landed:${runId}`,
    }).then(() => true)
  );
  return { result: 'landed', mrUrl: landed.mrUrl || null };
}

module.exports = { name, run };
