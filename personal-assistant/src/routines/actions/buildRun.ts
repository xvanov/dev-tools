'use strict';

// build_run: on its schedule, start a Build agent run (BUILD-ENRICHMENT E) — the same
// `build.start` the Do button uses, so the profile's model, effort, permission mode,
// tools and caps apply exactly as they do there. The run waits for you like any other:
// a draft PR or a report, never a merge (the agent prompt forbids it, and a run has no
// route to main).
//
// The action only *starts* the run and returns: a run lasts minutes to hours, and the
// routine lock is held while an action runs. The run id goes on the routine_run row
// (detail.buildRunId) and the run carries its origin (src/build/origin.ts), which the
// Build board shows as "scheduled: <routine>".
//
// Three guards, each a recorded skip rather than a failure, so a quiet day or a slow
// run costs one line in the history and not an error storm:
//   - the daily budget (PA_DAILY_BUDGET_USD: model spend + the Build runs' notional cost) is spent
//   - this routine's previous run is still live (no pile-up)
//   - the profile no longer exists (the one skip that toasts: someone should fix the routine)
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../../repo/types.ts').Row;

const { register } = require('./actions.ts');
const { config } = require('../../config.ts');
const { logger } = require('../../log.ts');

const log = logger('build-run-routine');

function clip(s: unknown, n: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

const skip = (why: string, notable = false) => ({ ok: true, summary: `skipped: ${why}`, lines: [why], notable, detail: { skipped: true, reason: why } });

/** Dollars spent today: model calls (llm_spend) plus the notional cost of Build runs started today. */
async function spentToday(): Promise<number> {
  const model: number = await require('../../budget.ts').spentToday();
  const since = require('../../budget.ts').dayStart().getTime();
  const runs: Row[] = await require('../../repo').buildRuns.list({ limit: 200 });
  const build = runs.filter((r) => Date.parse(String(r.started_at)) >= since).reduce((t, r) => t + (Number(r.cost_usd) || 0), 0);
  return model + build;
}

/** The checks that need the store: the profile, the repo, the model and effort. Used when a routine is saved. */
async function verify(p: Row): Promise<void> {
  const B = require('../../build/index.ts');
  await B.profiles().need(String(p.profile));
  if (p.model) B.checkModel(p.model);
  if (p.effort && !B.profiles().EFFORTS.includes(String(p.effort))) throw new Error(`build_run: effort must be ${B.profiles().EFFORTS.join(', ')}`);
  if (p.repo) await require('../../dispatch').knownRepo(String(p.repo));
}

async function run(params: Row, { dryRun = false, routine = null }: { dryRun?: boolean; routine?: Row | null } = {}) {
  const B = require('../../build/index.ts');
  const O = require('../../build/origin.ts');
  const profile = await B.profiles().get(String(params.profile));
  if (!profile) return skip(`profile "${params.profile}" no longer exists — edit or delete this routine`, true);
  if (routine) {
    const live: Row | null = await require('../../repo').buildRuns.liveForOrigin(O.likeRoutine(routine.id));
    if (live) return skip(`the previous run (#${live.id}, ${live.state}) is still going`);
  }
  const cap = config.budget.dailyUsd;
  let spent = 0;
  try {
    spent = await spentToday();
  } catch (err) {
    return skip(`cannot tell what was spent today (${(err as Error).message})`);
  }
  if (Number.isFinite(cap) && spent >= cap) return skip(`today's budget is spent ($${spent.toFixed(2)} of $${cap})`);
  if (dryRun) {
    return {
      ok: true, summary: `would start a ${profile.name} run`, lines: [`task: ${clip(params.prompt, 200)}`, `repo: ${params.repo || '(none)'}`],
      notable: false, detail: { dryRun: true, profile: profile.name },
    };
  }
  const started: Row = await B.start({
    task: String(params.prompt), profile: profile.name, repoPath: params.repo || null, model: params.model || null, effort: params.effort || null,
    origin: routine ? O.ofRoutine(routine) : null,
  });
  log.info('scheduled build run started', { routine: routine?.id, run: started.id, profile: profile.name });
  return {
    ok: true,
    summary: `started run #${started.id} (${profile.name}); the result waits for your review on the Build board`,
    lines: [`task: ${clip(params.prompt, 200)}`, `profile: ${profile.name} · model ${started.model}${started.repo_path ? ` · ${started.repo_path}` : ''}`],
    notable: true,
    detail: { buildRunId: Number(started.id), profile: profile.name, model: started.model, repo: started.repo_path || null },
  };
}

const action = register({
  name: 'build_run',
  summary:
    'Start a Build agent run (a Claude Code agent in its own worktree) with a Build profile and a task prompt. ' +
    'It ends in a draft PR or a report that waits for your review; nothing is merged. Skipped when the daily ' +
    'budget is spent, when the previous run from this routine is still going, or when the profile is gone.',
  changes: 'starts a Claude Code agent in a git worktree (of the named repo) on this machine; it may push a branch and open a draft PR, and costs model usage',
  params: {
    prompt: { type: 'string', required: true, maxLength: 3000, doc: 'the task for the agent, in the user\'s words' },
    profile: { type: 'string', required: true, maxLength: 40, doc: 'a Build profile (pa profile list): the agent\'s model, effort, permissions and caps' },
    repo: { type: 'string', maxLength: 300, doc: 'path of a known repo checkout (pa projects); omit for a task with no repo' },
    model: { type: 'string', maxLength: 20, doc: 'overrides the profile\'s model: haiku, sonnet, opus or fable' },
    effort: { type: 'string', maxLength: 10, doc: 'overrides the profile\'s effort: low, medium, high, xhigh or max' },
  },
  describe: (p: Row) =>
    `Start a ${p.profile} Build agent${p.repo ? ` in ${p.repo}` : ''}${p.model ? ` on ${p.model}` : ''}${p.effort ? ` (${p.effort} effort)` : ''} for "${clip(p.prompt, 140)}" — ` +
    'the result waits for your review (a draft PR or a report), nothing is merged',
  verify,
  run,
});

module.exports = { action, run, verify, spentToday, skip };
