'use strict';

//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const os = require('os');

// termhub's servers sit between your keystrokes and the agents' output, so they
// must not lose the CPU to the agents' own work. On Windows every logon task
// (Termhub, termhub-ptyd, the watchdog) starts at task priority 7, which is
// BELOW_NORMAL, and a process started from one inherits it: sessiond and front ran
// at the same priority as a 22-process `dotnet build` in a session and the whole
// stream stalled behind it. So each server raises itself to Normal at boot,
// whatever started it. Raising to Normal needs no privilege. Sessions are held
// BELOW_NORMAL by ptyd's job objects (ptyd/README.md), so this never lifts them.
//
// Never lowers a process that is already above Normal, and never throws.
function raiseToNormal(log: (msg: string) => void = () => {}) {
  try {
    const cur = os.getPriority(0);
    // os priorities: lower number = higher priority; NORMAL is 0.
    if (cur > os.constants.priority.PRIORITY_NORMAL) {
      os.setPriority(0, os.constants.priority.PRIORITY_NORMAL);
      log(`priority raised to normal (was ${cur})`);
    }
    return true;
  } catch (e: any) {
    log(`could not raise priority: ${e && e.message}`);
    return false;
  }
}

module.exports = { raiseToNormal };
