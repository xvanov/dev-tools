'use strict';

// termhub's sessiond entry, kept at this path: windows/start.ps1, the Linux units and
// `npm run sessiond` start `node sessiond.js`. sessiond owns the PTYs, so it runs on Node
// (node-pty aborts Bun). The code is sessiond.ts (plan 4.1).
const sessiond = require('./sessiond.ts');

module.exports = sessiond;

if (require.main === module) sessiond.run();
