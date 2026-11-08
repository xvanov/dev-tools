'use strict';

// launch's entry, kept at this path: windows/*.ps1 and linux/update.sh run
// `node lib/launch.js ...`. The module itself is launch.ts.
const launch = require('./launch.ts');

module.exports = launch;

if (require.main === module) launch.cli();
