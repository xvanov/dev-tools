// Config for ../scripts/run-tests.js (see its header). Every skip/serial entry needs a reason.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  skip: [],
  serial: [
    // Asserts a wall-clock budget (idle dirty scan well under the ~185 ms window scan); 21 workers
    // beside it push the median past it, so the hook blocks commits whenever the whole suite runs.
    { file: 'ledgerDirty.test.js', reason: 'wall-clock performance budget' },
  ],
  // Git-heavy files made of independent blocks (Windows spawns are ~0.1 s each): run each as parallel shards.
  shards: { 'dispatchStart.test.js': 10, 'remoteExec.test.js': 4 },
  // No test may reach a real Postgres (the work stack's PA database lives on 5433): point the pool
  // at a closed port so a stray query fails at once instead of touching, or waiting on, real data.
  // No test may raise a real desktop toast or phone push either: the pre-commit hook runs these on
  // the machine you are working at, and build.test.js's vanished-session run popped "Build agent #2
  // failed" on every commit. A test of the toast path sets PA_TOASTS itself.
  // Nor reach the live PA chat: the same notice rang the running worker's doorbell (127.0.0.1:7300)
  // and rewrote the live pa-home/INBOX.md, so Jarvis read "notification 1: Build agent #2 failed"
  // aloud after every test run (2026-11-14). PA_CHAT_NUDGE=0 stops the doorbell, and a data dir of
  // the run's own keeps INBOX.md, the default SQLite file and every other file out of the real one.
  // A test that needs either sets it in its own process.
  env: {
    PA_TESTING: '1',
    PA_DATABASE_URL: 'postgres://pa:pa@127.0.0.1:1/blocked_in_tests',
    PA_TOASTS: '0',
    PA_NTFY: 'off',
    PA_CHAT_NUDGE: '0',
    // Named like the real one: stalls.test.js reads logs under a `personal-assistant` folder.
    PA_DATA_DIR: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-test-data-')), 'personal-assistant'),
  },
  // Tests that walk a directory rather than name files: changed-files mode cannot see the edge.
  touches: {
    'syntax.test.js': ['src/', 'bin/'],
    // Scans every repo.<agg>.<method>( call in src and bin (plan 1.2).
    'repoCalls.test.js': ['src/', 'bin/'],
    // Reads every test/contract/*.contract.js and migrates from sql/ (plan 1.3).
    'repoContract.test.js': ['src/repo/', 'src/db/', 'test/contract/', 'sql/', 'sql-sqlite/'],
    // Dry-runs the repo root's install.ps1 (plan 7.7), outside this tool's directory.
    'install.test.js': ['../install.ps1', '../scripts/install-facts.js', 'windows/install.ps1'],
  },
  // Slow end-to-end tests that import the whole app: in --changed mode only their own area selects them.
  narrow: {
    'supervisor.test.js': ['src/supervisor/', 'test/fixtures/supervisorWorker.js'],
    'supervisorBun.test.js': ['src/supervisor/', 'test/fixtures/supervisorWorker.js', '../jarvisd/'],
    'deploy.test.js': ['src/supervisor/', 'windows/redeploy.ps1', 'linux/redeploy.sh'],
  },
};
