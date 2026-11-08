'use strict';

// termhub's single-process entry (dev, and the Linux unit), kept at this path:
// `node server.js` / `npm start`. The code is server.ts (plan 4.1).
const server = require('./server.ts');

module.exports = server;

if (require.main === module) server.main();
