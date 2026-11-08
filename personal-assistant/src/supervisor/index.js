'use strict';

// The supervisor is src/supervisor/index.ts (strict TypeScript, plan 4.4); this
// file keeps `node src/supervisor ...` and requiring the directory working.
const sup = require('./index.ts');

module.exports = sup;

if (require.main === module) {
  sup.cli(process.argv.slice(2)).catch((err) => {
    sup.log('error', 'supervisor failed', { message: err.message });
    process.exit(1);
  });
}