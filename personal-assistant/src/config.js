'use strict';

// config is config.ts (plan 4.1). This shim keeps path-based requires working:
// linux/install.sh, install-voice.sh and units.js run require('./src/config'),
// and Node does not add a .ts extension when it resolves.
module.exports = require('./config.ts');
