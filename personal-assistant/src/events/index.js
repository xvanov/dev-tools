'use strict';

// The events module lives in events.ts (strict TypeScript, plan 4.1); this keeps
// require('../events') working for every caller.
module.exports = require('./events.ts');
