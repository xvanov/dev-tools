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
//
// It refuses to start when a two-tier deployment is already live, because the
// two layouts overlap on the sessiond port and this one wins by accident. Left
// running, it becomes the machine's de-facto supervisor: it answers
// /api/ping on 7010, so an update believes sessiond is healthy and never starts
// the real one, then deploys a fresh front against a supervisor running whatever
// code this process was launched with. That produces the worst possible symptom
// — a fully updated UI over stale sessiond behaviour — so it's a hard refusal.
// It also holds the publish port, which is why `http://127.0.0.1:7000` can serve
// a different (older) build than the tailnet URL for the same port.

const { startSessiond } = require('./sessiond');
const { startFront } = require('./front');
const { DEFAULT_SESSIOND_PORT } = require('./lib/state');
const { probeSessiond, probeFront } = require('./lib/probe');
const { ensureWatchdog } = require('./lib/watchdogSetup');

const FRONT_PORT = Number(process.env.TERMHUB_PORT) || 7000;
const SESSIOND_PORT = DEFAULT_SESSIOND_PORT;

function refuse(lines) {
  for (const line of lines) console.error(`[termhub] ${line}`);
  process.exit(3);
}

async function main() {
  const liveSessiond = await probeSessiond(SESSIOND_PORT);
  if (liveSessiond) {
    return refuse([
      `127.0.0.1:${SESSIOND_PORT} is already serving `
        + `${liveSessiond.entry === 'server' ? 'another `node server.js`' : 'a two-tier sessiond'} `
        + `(pid ${liveSessiond.pid ?? '?'}, ${liveSessiond.sessions ?? '?'} session(s)).`,
      'server.js is the DEV entrypoint and would shadow it. Not starting.',
      'For a dev instance alongside the real one, give it ports nothing else holds:',
      `  TERMHUB_PORT=7100 TERMHUB_SESSIOND_PORT=7110 node server.js`,
    ]);
  }

  const liveFront = await probeFront(FRONT_PORT);
  if (liveFront) {
    return refuse([
      `127.0.0.1:${FRONT_PORT} is already serving a termhub front (pid ${liveFront.self?.pid ?? '?'}).`,
      'Not starting. Pick another port with TERMHUB_PORT.',
    ]);
  }

  startSessiond({ port: SESSIOND_PORT, entry: 'server' });
  startFront({ port: FRONT_PORT, sessiondPort: SESSIOND_PORT });

  // server.js is the entrypoint the Linux systemd unit runs, so this is where a
  // Linux machine becomes self-supervising: see lib/watchdogSetup.js for why the
  // hook lives at startup rather than only in the updater (it is the only thing that
  // runs on the first ⟳ Update from a build that predates linux/update.sh).
  ensureWatchdog();
}

main();
