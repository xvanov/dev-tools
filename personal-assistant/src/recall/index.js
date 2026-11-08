'use strict';

// The recall module lives in recall.ts (strict TypeScript, plan 4.1); this keeps
// require('../recall') working for every caller.
module.exports = require('./recall.ts');
