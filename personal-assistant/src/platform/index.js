'use strict';

// The platform layer lives in platform.ts (strict TypeScript, plan 4.1); this keeps
// require('../platform') working for every caller.
module.exports = require('./platform.ts');
