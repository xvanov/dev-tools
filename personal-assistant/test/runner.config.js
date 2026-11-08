// Config for ../scripts/run-tests.js (see its header). Every skip/serial entry needs a reason.
module.exports = {
  skip: [],
  serial: [],
  // Git-heavy files made of independent blocks (Windows spawns are ~0.1 s each): run each as parallel shards.
  shards: { 'dispatchStart.test.js': 5, 'remoteExec.test.js': 4 },
  // No test may reach a real Postgres (the work stack's PA database lives on 5433): point the pool
  // at a closed port so a stray query fails at once instead of touching, or waiting on, real data.
  env: { PA_TESTING: '1', PA_DATABASE_URL: 'postgres://pa:pa@127.0.0.1:1/blocked_in_tests' },
  // Tests that walk a directory rather than name files: changed-files mode cannot see the edge.
  touches: {
    'syntax.test.js': ['src/', 'bin/'],
    // Reads every test/contract/*.contract.js and migrates from sql/ (plan 1.3).
    'repoContract.test.js': ['src/repo/', 'src/db/', 'test/contract/', 'sql/'],
  },
  // Slow end-to-end tests that import the whole app: in --changed mode only their own area selects them.
  narrow: {
    'supervisor.test.js': ['src/supervisor/', 'test/fixtures/supervisorWorker.js'],
    'deploy.test.js': ['src/supervisor/', 'windows/redeploy.ps1', 'linux/redeploy.sh'],
  },
};
