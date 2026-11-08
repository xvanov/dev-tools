'use strict';

// ptyHost's entry, kept at this path: windows/update.ps1 and restart-sessiond.ps1 run
// `node lib/ptyHost.js status`, and linux/ptyd-unit.sh requires './lib/ptyHost'. The
// module itself is ptyHost.ts (plan 4.1).
const host = require('./ptyHost.ts');

module.exports = host;

if (require.main === module) host.cli();
