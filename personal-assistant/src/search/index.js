'use strict';

// The search module lives in search.ts (strict TypeScript, plan 4.1); this keeps
// require('../search') working for every caller.
module.exports = require('./search.ts');
