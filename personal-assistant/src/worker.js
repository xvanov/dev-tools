'use strict';

// The worker's entry, kept at this path: the pa-worker task or unit, the
// supervisor's Node generations and `node src/worker.js` start it. The worker
// itself is worker.ts (plan 4.1, docs/native/JARVISD.md).
//
// `node src/worker.js` started by anything but the supervisor — an install
// whose pa-worker task or unit predates it, which a non-elevated deploy cannot
// rewrite — becomes the supervisor (src/supervisor), which then runs this
// file as its generations (PA_SUPERVISED=1). Nothing below is loaded in the
// supervisor process. PA_NO_SUPERVISOR=1 runs the bare worker.
if (require.main === module && process.env.PA_SUPERVISED !== '1' && process.env.PA_NO_SUPERVISOR !== '1') {
  require('./supervisor')
    .cli(['run'])
    .catch((err) => {
      process.stderr.write(`supervisor failed: ${err.message}\n`);
      process.exit(1);
    });
  return;
}

const worker = require('./worker.ts');

module.exports = worker;

if (require.main === module) worker.run();
