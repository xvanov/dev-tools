'use strict';

// Everything the worker starts — every headless `claude -p`, the audio pass,
// git — runs below normal priority, so it yields to whatever you are typing
// into: a model call at Normal priority once made a terminal lag by seconds.
//
// The worker process itself stays at Normal. It used to lower itself, and its
// children inherited that, but it also serves the dashboard: whenever other
// work filled every core (a parallel test run), a below-normal worker got no
// CPU at all, its event loop "stalled" for up to 173 s, /healthz did not
// answer, and a deploy's health watch rolled a healthy generation back. So
// the priority is set on each child as it starts, instead.
//
// Every async way of starting a process (spawn, execFile, exec, fork) goes
// through ChildProcess.prototype.spawn; the sync ones (spawnSync,
// execFileSync) do not and keep Normal, which is fine — they are short, and
// the worker avoids them on any repeated path.

const os = require('os');
const { ChildProcess } = require('child_process');

let installed = false;

function lowerChildren({ priority = os.constants.priority.PRIORITY_BELOW_NORMAL, setPriority = os.setPriority } = {}) {
  if (installed) return false;
  installed = true;
  const original = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function spawnLowered(...args) {
    const r = original.apply(this, args);
    if (this.pid) {
      try {
        setPriority(this.pid, priority);
      } catch {
        /* exited already, or not permitted: leave it */
      }
    }
    return r;
  };
  return true;
}

// The serving processes — the supervisor and each worker generation — run
// above normal. This machine also runs agents' test pools, (cores - 1)
// processes at Normal: at Normal the dashboard got a 1-in-20 share of a busy
// CPU, stalled for seconds, and live deploys failed their health watch and
// rolled back. Their own work is light (the heavy work is in children, which
// lowerChildren keeps below normal), so this costs the machine nothing.
function serveAboveNormal({ setPriority = os.setPriority } = {}) {
  try {
    setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL);
    return true;
  } catch {
    return false; // not permitted here: run at the default
  }
}

module.exports = { lowerChildren, serveAboveNormal };
