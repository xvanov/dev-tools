'use strict';

// The telemetry module lives in telemetry.ts (strict TypeScript, plan 4.1); this keeps
// require('../telemetry') working for every caller.
module.exports = require('./telemetry.ts');
