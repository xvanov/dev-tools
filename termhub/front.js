'use strict';

// termhub's front entry, kept at this path: windows/start.ps1 and update.ps1, the
// Linux units and `npm run front` start `node front.js`. The front itself is
// front.ts (strict TypeScript, plan 4.1); jarvisd's `front` role loads it too.
const front = require('./front.ts');

module.exports = front;

if (require.main === module) front.run();
