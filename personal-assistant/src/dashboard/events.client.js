/* The live feed's page side (served as /events.js; server side in events.js).
 *
 *   PAEvents.subscribe({ topics, onChange, onEvent, fallbackMs })
 *
 * Calls onChange() shortly after any event on `topics`, coalesced (a burst of
 * row changes is one refetch), and on a `resync` (the server could not replay
 * what this page missed: another worker generation, a restart). A slow
 * fallback poll (fallbackMs, 5 min by default) covers whatever the feed misses.
 *
 * One EventSource for the whole tab when nav.js's shared hub is there (Ask,
 * Plan and Build stay open side by side; a socket each would fill the
 * browser's six connections and the next tab would never finish loading).
 * Without the hub, one EventSource per page, whatever the number of
 * subscribers. The browser reconnects by itself and sends Last-Event-ID;
 * when it gives up (a non-200 answer while the supervisor rolls), a new one
 * is opened with ?lastEventId= after a backoff. URLs are relative so the
 * page works under termhub's /pa/ proxy too.
 */
(function () {
  'use strict';

  var subs = [];
  var lastId = null;
  var es = null;
  var retry = 0;
  var reopen = null;
  var release = null; // the tab hub, one registration for every subscriber here

  function takeMessage(m) {
    retry = 0;
    if (m.lastEventId) lastId = m.lastEventId;
    var e;
    try {
      e = JSON.parse(m.data);
    } catch (err) {
      return;
    }
    if (!e || e.topic === 'hello') return;
    subs.slice().forEach(function (s) { s.take(e); });
  }

  // The tab's one feed, owned by the top window (nav.js). Null when this
  // page is open on its own, in which case open() holds the socket.
  function hub() {
    var nav = window.JarvisNav;
    return nav && nav.streams ? nav.streams : null;
  }

  function open() {
    clearTimeout(reopen);
    reopen = null;
    if (hub() || !window.EventSource || es || !subs.length) return;
    var source = new window.EventSource('api/events' + (lastId ? '?lastEventId=' + encodeURIComponent(lastId) : ''));
    es = source;
    source.onmessage = takeMessage;
    source.onerror = function () {
      if (source.readyState !== 2) return; // CONNECTING: the browser is retrying itself
      if (es === source) es = null;
      if (!reopen) reopen = setTimeout(open, Math.min(15000, 1000 * Math.pow(2, retry++)));
    };
  }

  function subscribe(opts) {
    var topics = opts.topics || [];
    var debounceMs = opts.debounceMs == null ? 80 : opts.debounceMs;
    var minGapMs = opts.minGapMs == null ? 750 : opts.minGapMs;
    var timer = null;
    var lastRun = 0;

    function changed() {
      if (timer) return;
      var wait = Math.max(debounceMs, lastRun + minGapMs - Date.now());
      timer = setTimeout(function () {
        timer = null;
        lastRun = Date.now();
        opts.onChange();
      }, wait);
    }

    var sub = {
      take: function (e) {
        if (e.topic !== 'resync' && topics.indexOf(e.topic) < 0) return;
        if (opts.onEvent) opts.onEvent(e);
        changed();
      },
    };
    subs.push(sub);
    var shared = hub();
    if (shared) { if (!release) release = shared.events({ onmessage: takeMessage }); }
    else if (!es && !reopen) open();
    var poll = setInterval(function () {
      if (document.visibilityState === 'visible') changed();
    }, opts.fallbackMs || 300000);

    return {
      close: function () {
        clearInterval(poll);
        clearTimeout(timer);
        subs = subs.filter(function (s) { return s !== sub; });
        if (!subs.length && release) { release(); release = null; }
        if (!subs.length && es) {
          es.close();
          es = null;
        }
      },
    };
  }

  window.PAEvents = { subscribe: subscribe };
})();
