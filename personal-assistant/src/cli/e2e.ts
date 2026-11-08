'use strict';

// `pa e2e`: the golden path, headless, against the live stack (plan E4;
// src/e2e/goldenPath.js), and `pa e2e <workflow>` for each workflow in the
// Map (plan 8.2; src/e2e/workflows.js), with evidence in a run folder.
// Prints a table and the JSON report (`--json`: the JSON alone), and exits
// non-zero on any missed hop, failed check or cost over the ceiling.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

const { USAGE } = require('../e2e/goldenPathCore');

const HELP = `${USAGE}

  pa e2e <workflow> [--dry-run] [--keep] [--json]   one workflow from the Map (plan 8.2):
        whats-on | research | deepseek-pr [--model azure/deepseek-v4-pro] | review-fix | teams-ask
        evidence (summary.json, transcripts, screenshots) in <PA data dir>/e2e/<stamp>-<workflow>/
  pa e2e all --dry-run                              every workflow's dry run`;

function make(out: any, fail: any) {
  return {
    async e2e(args: any, flags: any, lists: any) {
      const C = require('../e2e/goldenPathCore');
      const which = args[0] ? String(args[0]) : null;
      if (args.length > 1) return fail(`pa e2e takes one workflow (got "${args.join(' ')}")\n${HELP}`);
      if (which && which !== 'golden') return workflow(which, flags, lists);
      let report;
      try {
        report = await require('../e2e/goldenPath').main(flags, lists);
      } catch (err: any) {
        if (err.usage) return fail(`${err.message}\n${HELP}`);
        throw err;
      }
      const opts = (() => {
        try { return C.parseOptions(flags, lists); } catch { return {}; }
      })();
      if (opts.report) require('../e2e/goldenPath').writeReport(opts.report, report);
      if (opts.json) out(JSON.stringify(report, null, 2));
      else {
        out(C.table(report));
        out(JSON.stringify(report, null, 2));
      }
      if (!report.ok) process.exitCode = 1;
    },
  };

  async function workflow(which: any, flags: any, lists: any) {
    const W = require('../e2e/workflowsCore');
    const runner = require('../e2e/workflows');
    const ids = which === 'all' ? W.workflows(require('../dashboard/architecture.json')) : [which];
    if (which === 'all' && flags['dry-run'] !== true) return fail('pa e2e all runs dry runs only: add --dry-run');
    const all = [];
    for (const id of ids) {
      let s;
      try {
        s = await runner.main(id, flags, lists);
      } catch (err: any) {
        if (err.usage) return fail(`${err.message}\n${HELP}`);
        throw err;
      }
      all.push(s);
      if (flags.json !== true) out(W.table(s));
    }
    const result = ids.length === 1 ? all[0] : { ok: all.every((s) => s.ok), runs: all };
    if (flags.json === true) out(JSON.stringify(result, null, 2));
    else out(`\nsummary: ${all.map((s) => `${s.folder}${require('path').sep}summary.json`).join('\n         ')}`);
    if (!result.ok) process.exitCode = 1;
  }
}

module.exports = { make, HELP };
