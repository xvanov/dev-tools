'use strict';

// `pa eval build` — replay finished Build runs on other profiles and score them (BUILD-ENRICHMENT.md F).
// CLI only on purpose: launching it spends the subscription, so there is no dashboard route or chat tool for it
// (the chat reads the results with eval_build_report). The logic is src/eval/buildEval.ts.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;

const { flagInt, flagBool } = require('./parseArgs.ts');

const HELP = `pa eval build — replay finished Build runs on other profiles and score them
    pa eval build --profiles chore,feature,sonnet:high [--runs 12,14 | --since 2026-11-01 | --last 5]
                  [--budget-usd 10] [--wall-min 30] [--no-link-deps] [--yes]
        Takes finished runs that ended with a PR or a report (default: the newest 5), and for each run x profile
        makes a throwaway worktree at the run's base commit, runs claude headless with that profile's flags (no
        push, no PR: tokens stripped, push URLs blocked, git push and gh pr denied), then scores the repo's tests,
        the diff, cost, turns and wall time. Prints the plan and an estimate and runs NOTHING unless --yes is given
        (--dry-run says so too). The budget (default $10, PA_BUILD_EVAL_BUDGET_USD) stops it before the next trial
        that would pass it and is also each claude run's own spend cap. A profile is a name (pa profile list) or a
        model:effort pair. Test commands: the build.eval setting {"tests": {"<repo path or folder>": "<cmd>"}},
        else 'npm test -- --changed' for dev-tools, else 'npm test' where package.json is.
    pa eval build --report [--eval <id>] [-v]   the table: profile, n, pass rate, median cost, median wall time
        Results: <data dir>/build-eval/<id>.jsonl (with each agent's final message) and the build_eval_trial table.`;

/** Pure: the selection and options of `pa eval build` from the flags, or { error }. */
function parse(flags: Json): { error: string } | { runs: number[] | null; since: string | null; last: number | null; profiles: string; budgetUsd: number | null; wallMin: number | null; yes: boolean; dryRun: boolean; noLink: boolean } {
  const str = (k: string): string | null => (typeof flags[k] === 'string' ? String(flags[k]) : null);
  if (typeof flags.profiles !== 'string') return { error: 'usage: pa eval build --profiles a,b[,model:effort] [--runs ids | --since date | --last N] [--budget-usd X] [--yes]   (pa eval build --help)' };
  let runs: number[] | null = null;
  if (flags.runs !== undefined) {
    runs = String(flags.runs === true ? '' : flags.runs).split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!runs.length) return { error: '--runs needs run ids, e.g. --runs 12,14 (pa run list)' };
  }
  const since = str('since');
  if (since && Number.isNaN(Date.parse(since))) return { error: `--since "${since}" is not a date (2026-11-01)` };
  const budget = flags['budget-usd'] !== undefined ? Number(flags['budget-usd']) : null;
  if (budget != null && !(budget > 0)) return { error: '--budget-usd must be a positive number' };
  const wall = flags['wall-min'] !== undefined ? Number(flags['wall-min']) : null;
  if (wall != null && !(wall > 0)) return { error: '--wall-min must be a positive number' };
  return { runs, since, last: flags.last !== undefined ? flagInt(flags, 'last', 5) : null, profiles: String(flags.profiles), budgetUsd: budget, wallMin: wall, yes: flagBool(flags, 'yes'), dryRun: flagBool(flags, 'dry-run'), noLink: flags['link-deps'] === false };
}

/** Pure: the dry-run text: the trials, what is skipped and why, the estimate. */
function formatPlan(r: Json): string[] {
  const E = require('../eval/buildEval.ts');
  const lines: string[] = [];
  const specs = (r.specs as Json[]).map((s) => `${s.label} (${s.model}${s.effort ? `, ${s.effort}` : ''}, cap ${E.money(s.capUsd)}, ${s.wallMin} min)`);
  lines.push(`profiles: ${specs.join(' · ')}`);
  for (const it of r.plan.items) lines.push(`  run #${it.run} [${it.kind}] ${String(it.summary.task).replace(/\s+/g, ' ').slice(0, 70)} · ${it.repo} @ ${it.base.slice(0, 8)} (${it.baseSource}) · orig ${E.money(it.summary.cost_usd)}`);
  for (const s of r.plan.skipped) lines.push(`  skipped run #${s.run}: ${s.reason}`);
  const e = r.estimate;
  lines.push(`${e.trials} trial(s) (${r.plan.items.length} run(s) x ${specs.length} profile(s)): about ${E.money(e.typicalUsd)} typical (the original runs' cost, else the cap), at most ${E.money(e.ceilingUsd)} (the caps); budget ${E.money(r.budget)}, ${e.fits} of ${e.trials} fit it.`);
  return lines;
}

/** `pa eval build ...`; `out` and `fail` are the CLI's. */
async function run(args: string[], flags: Json, out: (s: string) => void, fail: (s: string) => unknown): Promise<unknown> {
  const E = require('../eval/buildEval.ts');
  if (flags.help || args[1] === 'help') return out(HELP);
  if (flagBool(flags, 'report')) {
    const evalId = typeof flags.eval === 'string' ? flags.eval : null;
    const r = await E.reportData({ evalId });
    out(`${evalId ? `eval ${evalId}` : 'all stored trials'} · ${r.trials} trial(s)${r.evals.length ? ` · launches: ${r.evals.join(', ')}` : ''}`);
    for (const l of E.formatTable(r.profiles)) out(l);
    if (flagBool(flags, 'v') || flagBool(flags, 'verbose')) {
      for (const t of r.recent) out(`  ${t.eval} run #${t.run} ${t.profile}: ${t.status}, tests ${t.tests || '-'}, ${t.passed == null ? 'unscored' : t.passed ? 'PASS' : 'FAIL'}, ${E.money(t.cost_usd)}, ${E.secs(t.wall_s)}${t.original_verdict ? `, original PR ${t.original_verdict}` : ''}`);
    }
    return;
  }
  const o = parse(flags);
  if ('error' in o) return fail(o.error);
  let r: Json;
  try {
    r = await E.launch({ ...o, log: out });
  } catch (e) {
    return fail((e as Error).message);
  }
  if (r.dry || !r.trials.length) {
    for (const l of formatPlan(r)) out(l);
    if (!r.plan.items.length) return out('nothing to replay.');
    return out(r.dry ? 'dry run: nothing was launched. Add --yes to run these trials.' : '');
  }
  out('');
  out(`eval ${r.evalId}: ${r.trials.length} trial(s), ${E.money(r.spent)} spent of ${E.money(r.budget)} · ${r.file}`);
  if (r.stopped) out(`stopped early (${r.notRun} trial(s) not run): ${r.stopped}`);
  const report = await E.reportData({ evalId: r.evalId });
  for (const l of E.formatTable(report.profiles)) out(l);
}

module.exports = { run, parse, formatPlan, HELP };
