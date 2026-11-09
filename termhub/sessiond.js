'use strict';

// termhub's sessiond entry, kept at this path: windows/start.ps1, the Linux units and
// `npm run sessiond` start `node sessiond.js`. sessiond owns the PTYs, so it runs on Node
// The code is sessiond.ts (plan 4.1). PTYs live in ptyd, not in this process.
const sessiond = require('./sessiond.ts');

module.exports = sessiond;

if (require.main === module) sessiond.run();
