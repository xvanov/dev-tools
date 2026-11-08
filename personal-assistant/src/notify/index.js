'use strict';

// The notify module lives in notify.ts (strict TypeScript, plan 4.1); this keeps
// require('../notify') working for every caller.
module.exports = require('./notify.ts');
