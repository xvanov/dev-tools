'use strict';

// SQLite twin of src/repo/cardPlans.ts: its SQL is portable (ISO text times,
// 0/1 flags, no dialect functions), so the twin is the same code.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

module.exports = require('../cardPlans.ts');
