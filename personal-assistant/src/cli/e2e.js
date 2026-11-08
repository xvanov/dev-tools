'use strict';

// `pa e2e`: the golden path, headless, against the live stack (plan E4;
// src/e2e/goldenPath.js). Prints the hop/timing table and the JSON report
// (`--json`: the JSON alone), and exits non-zero on any hop not reached or any
// link that does not resolve.

const { USAGE: HELP } = require('../e2e/goldenPathCore');

function make(out, fail) {
  return {
    async e2e(args, flags, lists) {
      if (args.length) return fail(`pa e2e takes no positional arguments (got "${args.join(' ')}")\n${HELP}`);
      const C = require('../e2e/goldenPathCore');
      let report;
      try {
        report = await require('../e2e/goldenPath').main(flags, lists);
      } catch (err) {
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
}

module.exports = { make, HELP };
