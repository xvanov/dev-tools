'use strict';

// The secrets module lives in secrets.ts (strict TypeScript, plan 4.1); this keeps
// require('../secrets') working for every caller.
module.exports = require('./secrets.ts');
