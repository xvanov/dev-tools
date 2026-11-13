'use strict';

// When does a terminal stop streaming?
//
// Every open terminal used to hold a WebSocket and parse all of its output, shown
// or not; five or six Claude Code sessions made the browser lag. Now a terminal
// that is not in front is detached after HIDDEN_DETACH_MS and re-attached (served
// from sessiond's screen snapshot, the same `replay` a first open gets) when it is
// shown again. The delay is what keeps a quick tab flip live: flip away and back
// inside it and nothing was ever closed.
//
// This file is only the timing rule, pure so it is unit-tested off the browser
// (test/termVisibility.test.js). Loads as a plain <script> (window.TermVisibility)
// and as CommonJS. app.js owns what "detach" and "attach" actually do.
(function (root) {
  const HIDDEN_DETACH_MS = 15000;

  // Visible = the active terminal in a page that is itself visible. There is one
  // terminal pane on screen at a time (no split layout).
  function isVisible(id, activeId, documentVisible) {
    return documentVisible && id === activeId;
  }

  // update(id, visible) is called whenever visibility may have changed; it is
  // idempotent. A hidden id gets ONE timer (not restarted by repeated calls, so a
  // chatty caller cannot postpone the detach forever); a visible id cancels it.
  function createScheduler(opts) {
    const delayMs = opts.delayMs != null ? opts.delayMs : HIDDEN_DETACH_MS;
    const setT = opts.setTimer || setTimeout;
    const clearT = opts.clearTimer || clearTimeout;
    const timers = new Map();
    return {
      update(id, visible) {
        if (visible) { this.cancel(id); return; }
        if (timers.has(id)) return;
        timers.set(id, setT(() => { timers.delete(id); opts.onDetach(id); }, delayMs));
      },
      cancel(id) {
        if (!timers.has(id)) return;
        clearT(timers.get(id));
        timers.delete(id);
      },
      pending(id) { return timers.has(id); },
    };
  }

  const api = { HIDDEN_DETACH_MS, isVisible, createScheduler };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TermVisibility = api;
}(typeof self !== 'undefined' ? self : this));
