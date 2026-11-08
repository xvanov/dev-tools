'use strict';

// The deploy command's entry, kept at this path: windows/redeploy.ps1 and the
// docs run `node src/supervisor/deploy.js [--pull] [--from <commit>] [--dry-run]
// [--json]`. The deploy itself is deploy.ts (plan 4.1).
const deploy = require('./deploy.ts');

module.exports = deploy;

if (require.main === module) deploy.cli();
