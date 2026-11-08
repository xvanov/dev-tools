/* The live feed's page side (served as /events.js; server side in events.js).
 *
 *   PAEvents.subscribe({ topics, onChange, onEvent, fallbackMs })
 *
 * Calls onChange() shortly after any event on `topics`, coalesced (a burst of
 * row changes is one refetch), and on a `resync` (the server could not replay
 * what this page missed: another worker generation, a restart). A slow
 * fallback poll (fallbackMs, 5 min by default) covers whatever the feed misses.
 *
 * One EventSource per page, whatever the number of subscribers: over plain
 * HTTP/1.1 a browser allows six connections per host, and Plan, Build and Ask
 * stay open side by side in nav.js's frames, each with its chat stream too.
 * The browser reconnects by itself and sends Last-Event-ID; when it gives up
 * (a non-200 answer while the supervisor rolls), a new one is opened with
 * ?lastEventId= after a backoff. URLs are relative so the page works under
 * termhub's /pa/ proxy too.
 */
(function () {
  'use strict';

  var subs = [];
  var lastId = null;
  var es = null;
  var retry = 0;
  var reopen = null;

  function open() {
    clearTimeout(reopen);
    reopen = null;
    if (!window.EventSource || es || !subs.length) return;
    var source = new window.EventSource('api/events' + (lastId ? '?lastEventId=' + encodeURIComponent(lastId) : ''));
    es = source;
    source.onmessage = function (m) {
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
    };
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
    if (!es && !reopen) open();
    var poll = setInterval(function () {
      if (document.visibilityState === 'visible') changed();
    }, opts.fallbackMs || 300000);

    return {
      close: function () {
        clearInterval(poll);
        clearTimeout(timer);
        subs = subs.filter(function (s) { return s !== sub; });
        if (!subs.length && es) {
          es.close();
          es = null;
        }
      },
    };
  }

  window.PAEvents = { subscribe: subscribe };
})();
