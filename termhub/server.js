'use strict';

// termhub — local-dev / single-process entrypoint.
//
// Production runs two processes: a persistent `sessiond` (owns the PTYs) and a
// swappable `front` (serves the UI + proxies to sessiond), so terminals survive
// updates — see windows/start.ps1 and windows/update.ps1.
//
// For local development and smoke tests, this launches BOTH tiers in ONE process
// so `node server.js` (npm start) behaves like the old single server: front on
// $TERMHUB_PORT (default 7000), sessiond on loopback $TERMHUB_SESSIOND_PORT
// (default 7010). Restarting this process loses terminals (one process) — that's
// fine for dev; use the two-process layout in production for survival.

const { startSessiond } = require('./sessiond');
const { startFront } = require('./front');
const { DEFAULT_SESSIOND_PORT } = require('./lib/state');

const FRONT_PORT = Number(process.env.TERMHUB_PORT) || 7000;
const SESSIOND_PORT = DEFAULT_SESSIOND_PORT;

startSessiond({ port: SESSIOND_PORT });
startFront({ port: FRONT_PORT, sessiondPort: SESSIOND_PORT });
