'use strict';

// Terminal performance overlay: what the browser is actually paying for output.
//
// Off by default and free when off: app.js only calls recv()/wrote() behind an
// `if (TermPerf.on)` check, and nothing here runs (no timer, no observer, no DOM)
// until enable(). Turn it on with `?perf=1` in the URL or Ctrl+Alt+Shift+P
// (toggles; the shortcut is a chord browsers and shells leave alone).
//
// Per terminal, over the last second: output bytes/s and messages/s received over
// its WebSocket, and the average and max time term.write() took to parse a message
// (write -> its completion callback, so it includes queueing behind earlier writes
// — the number that grows when the main thread is the bottleneck). Page-wide: the
// count and total ms of 'longtask' entries (main-thread tasks over 50 ms) in the
// last second and since the overlay opened.
//
// Pure apart from the injected `doc`/`PerformanceObserver`/`now`, so the numbers
// are unit-tested in node (test/termPerf.test.js). Loads as a plain <script>
// (window.TermPerf) and as CommonJS.
(function (root) {
  function create(env) {
    env = env || {};
    const now = env.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const doc = env.doc || (typeof document !== 'undefined' ? document : null);
    const PO = env.PerformanceObserver || (typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null);
    const setTimer = env.setInterval || ((typeof setInterval !== 'undefined') ? setInterval : null);
    const clearTimer = env.clearInterval || ((typeof clearInterval !== 'undefined') ? clearInterval : null);

    const api = { on: false, rows: [], longTasks: { count: 0, ms: 0, totalCount: 0, totalMs: 0 } };
    let terms = new Map();      // id -> window counters
    let longWin = { count: 0, ms: 0 };
    let windowStart = 0;
    let timer = null;
    let observer = null;
    let el = null;
    let listTerminals = () => [];

    const fresh = () => ({ bytes: 0, msgs: 0, wSum: 0, wN: 0, wMax: 0 });

    api.recv = function (id, bytes) {
      let s = terms.get(id);
      if (!s) { s = fresh(); terms.set(id, s); }
      s.bytes += bytes; s.msgs += 1;
    };
    api.wrote = function (id, ms) {
      let s = terms.get(id);
      if (!s) { s = fresh(); terms.set(id, s); }
      s.wSum += ms; s.wN += 1; if (ms > s.wMax) s.wMax = ms;
    };

    // Close the current window: turn the counters into rows, start a new one.
    api.tick = function () {
      const t = now();
      const dt = Math.max(1, t - windowStart) / 1000;
      windowStart = t;
      const known = listTerminals();
      const ids = new Set([...terms.keys(), ...known.map((k) => k.id)]);
      const rows = [];
      for (const id of ids) {
        const s = terms.get(id) || fresh();
        const meta = known.find((k) => k.id === id);
        rows.push({
          id, title: meta ? meta.title : id, state: meta ? meta.state : 'closed',
          bytesPerSec: Math.round(s.bytes / dt), msgsPerSec: Math.round(s.msgs / dt),
          avgMs: s.wN ? s.wSum / s.wN : 0, maxMs: s.wMax,
        });
      }
      terms = new Map();
      api.longTasks.count = longWin.count; api.longTasks.ms = Math.round(longWin.ms);
      longWin = { count: 0, ms: 0 };
      api.rows = rows;
      return rows;
    };

    function render() {
      if (!el) return;
      const f = (n) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1));
      const lt = api.longTasks;
      const lines = [`longtasks ${lt.count} / ${lt.ms} ms per s  (total ${lt.totalCount} / ${Math.round(lt.totalMs)} ms)`];
      for (const r of api.rows) {
        lines.push(`${(r.title || r.id).slice(0, 18).padEnd(18)} ${r.state.padEnd(8)} ${String(r.bytesPerSec).padStart(7)} B/s `
          + `${String(r.msgsPerSec).padStart(5)} msg/s  avg ${f(r.avgMs)} max ${f(r.maxMs)} ms`);
      }
      el.textContent = lines.join('\n');
    }

    api.enable = function (opts) {
      if (api.on) return;
      api.on = true;
      listTerminals = (opts && opts.terminals) || listTerminals;
      windowStart = now();
      api.longTasks.totalCount = 0; api.longTasks.totalMs = 0;
      if (PO) {
        try {
          observer = new PO((list) => {
            for (const e of list.getEntries()) {
              longWin.count += 1; longWin.ms += e.duration;
              api.longTasks.totalCount += 1; api.longTasks.totalMs += e.duration;
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
        } catch { observer = null; }   // not every browser (Safari) has 'longtask'
      }
      if (doc && doc.createElement) {
        el = doc.createElement('pre');
        el.id = 'term-perf';
        el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;margin:0;padding:6px 8px;'
          + 'font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#d6f5d6;background:rgba(0,0,0,.82);'
          + 'border:1px solid #3a6;border-radius:6px;pointer-events:none;white-space:pre;max-width:96vw;overflow:hidden';
        doc.body.appendChild(el);
      }
      if (setTimer) timer = setTimer(() => { api.tick(); render(); }, 1000);
      api.tick(); render();
    };

    api.disable = function () {
      if (!api.on) return;
      api.on = false;
      if (timer !== null && clearTimer) clearTimer(timer);
      timer = null;
      if (observer) { try { observer.disconnect(); } catch { /* gone */ } observer = null; }
      if (el && el.remove) el.remove();
      el = null; terms = new Map(); api.rows = [];
    };

    api.toggle = function (opts) { if (api.on) api.disable(); else api.enable(opts); };

    // Ctrl+Alt+Shift+P.
    api.isShortcut = function (e) {
      return !!e && e.ctrlKey && e.altKey && e.shiftKey && (e.key === 'P' || e.key === 'p' || e.code === 'KeyP');
    };

    return api;
  }

  const mod = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.TermPerfFactory = mod;
}(typeof self !== 'undefined' ? self : this));
