'use strict';

// The policy engine lives in policy.ts (strict TypeScript, plan 4.1); this keeps
// require('../policy') working for every caller.
module.exports = require('./policy.ts');
