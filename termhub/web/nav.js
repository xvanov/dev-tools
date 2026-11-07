/* Jarvis navigation: the destinations, the settings panel, and the shell that
 * switches between them without a page load.
 *
 * CANONICAL COPY: personal-assistant/src/dashboard/nav.js. termhub/web/nav.js is a
 * byte copy (`npm run sync-theme` in termhub; test/theme.test.js fails on drift).
 *
 * Usage: <script src="nav.js" data-layer="talk|dashboard|factory|termhub|agenttime|architecture">
 * in <head> (synchronous, so the remembered theme and panel state apply before first
 * paint). A page puts its own controls in an element marked [data-jside] (theme.css
 * .jside); nav.js prepends the navigation to it. A page without one gets a panel that
 * holds the navigation only.
 *
 * The page itself shows only its one thing. A small » toggle in the top-left corner
 * opens the panel: closed by default, remembered per destination (localStorage
 * jarvis.settings.<id>) on wide screens; on a phone the panel slides over the page and
 * always starts closed. State: <html data-settings="open|closed">; each change fires
 * `jarvis:settings` ({detail: {open}}) on window (termhub drives its drawer from it).
 *
 * Switching is instant. The page you loaded is the shell: every other destination
 * opens in an iframe laid over it, created on first use (most are prefetched once
 * the page is idle) and kept alive, so going back and forth is a show/hide, and a
 * page you leave keeps running (Talk keeps listening). The shell's own page is
 * hidden with visibility, not display, so nothing in it resizes. Inside a frame,
 * nav.js only forwards: a click in its panel, Alt+1..6 or a link to a destination
 * posts {jarvis: 'go', id} to the top window, which checks it came from one of its
 * frames. The URL is the shell's own plus ?jx=<id> while another destination shows
 * (never a different path: a PA page's relative fetches resolve against it), so a
 * reload or a shared link opens the same view, and Back/Forward step through the
 * switches. A modified click (new tab) is left to the browser.
 *
 * Where the destinations live:
 *   - on termhub, or on the PA through termhub's /pa/ proxy: one origin, so the PA is
 *     /pa/ and termhub is /, and every frame is same-origin;
 *   - on the PA directly (127.0.0.1:7300): termhub is the origin of the chat session's
 *     url (GET api/chat/session), else <meta name="pa-termhub">, else
 *     http://127.0.0.1:7000, framed cross-origin (termhub allows the PA as a frame
 *     ancestor; its own API calls stay same-origin to it).
 * Whether the PA answers (so whether its destinations work from termhub) is read from
 * api/chat/session.
 *
 * termhub's ?focus=<id> view (one terminal, a link target rather than a destination)
 * gets no panel: a small switcher floats in the top-right corner instead.
 */
(function () {
  'use strict';

  // ---- The destinations. Names live here and nowhere else: rename one on its line. ----
  // id: the stable key (storage, ?jx=, data-layer); label: what you see.
  // host: which server serves it. path: under the PA's base (pa) or termhub's origin
  // (the PA also answers /ask /plan /build /map, termhub /run /meter, as aliases).
  // Alt+<n> follows the order.
  var DESTS = [
    { id: 'talk', label: 'Ask', about: 'talk to Jarvis', host: 'pa', path: 'talk' },
    { id: 'dashboard', label: 'Plan', about: 'the board, chat, memory, routines', host: 'pa', path: '' },
    { id: 'factory', label: 'Build', about: 'every job the software factory runs', host: 'pa', path: 'factory' },
    { id: 'sessions', label: 'Run', about: 'every terminal in termhub', host: 'termhub', path: '/' },
    { id: 'agenttime', label: 'Meter', about: 'how long agents worked, and waited on you', host: 'termhub', path: '/dashboard' },
    { id: 'architecture', label: 'Map', about: 'how the parts fit together', host: 'pa', path: 'architecture' },
  ];
  // Opening Ask (Talk) starts the microphone on a desktop with the wake word on, so it is
  // never opened behind your back: only once you point at it or go to it.
  var NO_PREFETCH = { talk: true };

  var THEME_KEY = 'jarvis.theme';
  var root = document.documentElement;
  var script = document.currentScript;
  var declared = (script && script.getAttribute('data-layer')) || root.getAttribute('data-layer') || '';
  var current = declared === 'termhub' ? 'sessions' : declared;
  function dest(id) { for (var i = 0; i < DESTS.length; i++) if (DESTS[i].id === id) return DESTS[i]; return null; }

  var framed = false;
  try { framed = window.top !== window; } catch (e) { framed = true; }
  root.toggleAttribute('data-framed', framed);

  // ---- theme: system until chosen; remembered per browser ----------------------------
  function readTheme() { try { return localStorage.getItem(THEME_KEY) || ''; } catch (e) { return ''; } }
  function writeTheme(v) {
    try { if (v) localStorage.setItem(THEME_KEY, v); else localStorage.removeItem(THEME_KEY); } catch (e) { /* private mode */ }
  }
  function applyTheme(v) {
    if (v === 'light' || v === 'dark') root.setAttribute('data-theme', v);
    else root.removeAttribute('data-theme');
  }
  applyTheme(readTheme());

  // ---- the settings panel: closed until opened; remembered per destination, wide only --
  var NARROW = window.matchMedia ? matchMedia('(max-width: 760px)') : { matches: false };
  var settingsKey = 'jarvis.settings.' + current;
  function readSettings() { try { return localStorage.getItem(settingsKey) === '1'; } catch (e) { return false; } }
  var settingsOpen = !NARROW.matches && readSettings();
  root.setAttribute('data-settings', settingsOpen ? 'open' : 'closed');

  // ---- where everything is -----------------------------------------------------------
  var onTermhub = !!(dest(current) && dest(current).host === 'termhub');
  var proxied = /^\/pa(\/|$)/.test(location.pathname);
  var focusId = current === 'sessions' ? new URLSearchParams(location.search).get('focus') : null;
  var paBase = onTermhub ? '/pa/' : new URL('./', location.href).pathname;
  var sameOrigin = onTermhub || proxied;
  var termhub = ''; // origin of termhub; '' = this one
  var paUp = true;

  function termhubBase() {
    if (sameOrigin) return '';
    if (termhub) return termhub;
    var meta = document.querySelector('meta[name="pa-termhub"]');
    return ((meta && meta.content) || 'http://127.0.0.1:7000').replace(/\/$/, '');
  }
  function hrefFor(id) {
    var d = dest(id);
    if (!d) return '#';
    if (d.host === 'pa') return paBase + d.path;
    // From a ?focus= view back to the hub, keep that session open there.
    return termhubBase() + d.path + (id === 'sessions' && focusId ? '#session=' + encodeURIComponent(focusId) : '');
  }
  function reachable(id) { var d = dest(id); return !!d && !(d.host === 'pa' && !paUp && id !== current); }

  // ---- is the PA there, and where is termhub ----------------------------------------
  var sessionChecked = null;
  function fetchSession() {
    sessionChecked = fetch(paBase + 'api/chat/session', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (s) {
        paUp = true;
        if (!sameOrigin && s && s.url) { try { termhub = new URL(s.url).origin; } catch (e) { /* keep default */ } }
      }, function () { paUp = !onTermhub; });
    return sessionChecked;
  }

  // ---- the shell: kept-alive frames, switched by show/hide ---------------------------
  var frames = {};      // id -> iframe
  var showing = current;
  var layer = null;     // the element that holds the frames
  var baseTitle = document.title;

  function urlWith(id) {
    var u = new URL(location.href);
    if (id === current) u.searchParams.delete('jx');
    else u.searchParams.set('jx', id);
    return u.pathname + u.search + u.hash;
  }
  function frameFor(id) {
    if (frames[id]) return frames[id];
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'jx-frames';
      document.body.appendChild(layer);
    }
    var f = document.createElement('iframe');
    f.className = 'jx-frame';
    f.title = dest(id).label;
    // What the pages inside need from the browser: Talk and termhub's mic, termhub's paste.
    f.setAttribute('allow', 'microphone; clipboard-read; clipboard-write; autoplay; fullscreen');
    f.src = hrefFor(id);
    f.addEventListener('load', function () { if (showing === id) titleFrom(id); });
    f.jxVersion = latest[dest(id).host] || '';
    layer.appendChild(f);
    frames[id] = f;
    return f;
  }
  function titleFrom(id) {
    if (id === current) { document.title = baseTitle; return; }
    var t = '';
    try { t = frames[id].contentDocument.title; } catch (e) { /* cross-origin */ }
    document.title = t || dest(id).label;
  }
  function show(id, opts) {
    opts = opts || {};
    if (!dest(id) || !reachable(id)) return false;
    if (id === showing) return true;
    // Switching to an out-of-date page: load the new code instead of showing the old.
    if (id === current && isStale(current)) { history.replaceState(null, '', urlWith(id)); location.reload(); return true; }
    var leaving = showing;
    if (id !== current) {
      var f = frameFor(id);
      f.classList.add('on');
    }
    for (var k in frames) if (k !== id) frames[k].classList.remove('on');
    root.classList.toggle('jx-away', id !== current);
    if (showing === current) baseTitle = document.title;
    showing = id;
    if (leaving !== current && frames[leaving] && isStale(leaving)) dropFrame(leaving);
    titleFrom(id);
    if (!opts.fromHistory) history.pushState({ jx: id }, '', urlWith(id));
    // Keys go where the eyes are: a terminal takes typing at once.
    try { if (id !== current) frames[id].contentWindow.focus(); else window.focus(); } catch (e) { /* ignore */ }
    paint();
    return true;
  }
  function fromUrl() {
    var id = new URLSearchParams(location.search).get('jx');
    return id && dest(id) ? id : current;
  }

  // One way to go anywhere, from the panel, a key, or a link.
  function go(id) {
    if (!dest(id)) return;
    if (framed) {
      try { window.top.postMessage({ jarvis: 'go', id: id }, '*'); } catch (e) { location.href = hrefFor(id); }
      return;
    }
    if (!show(id)) return;
    if (NARROW.matches && id !== current) setSettings(false);
  }

  // Hovering a destination you have not opened yet starts loading it (Talk included:
  // you are about to go there).
  function warm(id) {
    if (!dest(id) || id === current) return;
    if (framed) { try { window.top.postMessage({ jarvis: 'warm', id: id }, '*'); } catch (e) { /* ignore */ } return; }
    if (!frames[id] && reachable(id)) frameFor(id);
  }

  // ---- staying current: an update reaches pages that are already open -------------
  // The shell asks each server which commit it serves (api/version) every minute and
  // when the window comes back. Once one changes, frames you are not looking at are
  // dropped (they reload when next opened), and the page you are looking at reloads
  // the next time it is safe: when the tab is hidden, or when you switch to it.
  var latest = {};      // host -> the commit it serves now
  var loadedWith = {};  // host -> the commit the shell page itself loaded with
  function versionUrl(host) { return host === 'pa' ? paBase + 'api/version' : termhubBase() + '/api/version'; }
  function hostsInUse() {
    var used = {};
    used[dest(current).host] = true;
    for (var k in frames) used[dest(k).host] = true;
    return Object.keys(used);
  }
  function checkVersions() {
    if (framed) return;
    hostsInUse().forEach(function (host) {
      if (host === 'pa' && !paUp) return;
      fetch(versionUrl(host), { cache: 'no-store', credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (v) {
          if (!v || !v.commit) return;
          var changed = latest[host] && latest[host] !== v.commit;
          latest[host] = v.commit;
          if (!loadedWith[host] && host === dest(current).host) loadedWith[host] = v.commit;
          for (var k in frames) if (dest(k).host === host && !frames[k].jxVersion) frames[k].jxVersion = v.commit;
          if (changed) refreshStale();
        }, function () { /* offline or restarting: try again next time */ });
    });
  }
  function isStale(id) {
    var host = dest(id).host;
    if (!latest[host]) return false;
    if (id === current) return !!loadedWith[host] && loadedWith[host] !== latest[host];
    return !!frames[id] && !!frames[id].jxVersion && frames[id].jxVersion !== latest[host];
  }
  function dropFrame(id) { frames[id].remove(); delete frames[id]; }
  // Out-of-date pages you are not looking at go now; the one you are looking at
  // waits until the tab is hidden, so nothing reloads under your hands.
  function refreshStale() {
    if (document.hidden && isStale(current)) { location.reload(); return; }
    for (var k in frames) {
      if (!isStale(k)) continue;
      if (k !== showing) dropFrame(k);
      else if (document.hidden) { frames[k].jxVersion = latest[dest(k).host]; frames[k].src = hrefFor(k); }
    }
  }
  if (!framed) {
    setInterval(checkVersions, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) refreshStale(); else checkVersions();
    });
    window.addEventListener('focus', checkVersions);
    setTimeout(checkVersions, 3000);
  }

  function prefetch() {
    if (framed) return;
    var queue = DESTS.filter(function (d) { return d.id !== current && !NO_PREFETCH[d.id] && reachable(d.id); });
    (function next() {
      var d = queue.shift();
      if (!d) return;
      if (!frames[d.id]) frameFor(d.id);
      setTimeout(next, 400);
    })();
  }

  // ---- render ---------------------------------------------------------------------------
  var themeBtns = [];
  var toggles = [];
  var navLists = [];
  var THEME_ICON = {
    '': '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" fill="currentColor"/></svg>',
  };
  var THEME_NAME = { '': 'system', light: 'light', dark: 'dark' };
  var NEXT_THEME = { '': 'light', light: 'dark', dark: '' };
  var TOGGLE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5L8 8l-4.5 4.5M8.5 3.5L13 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function paintTheme(btn) {
    var t = readTheme();
    var shown = t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    btn.innerHTML = THEME_ICON[t] || THEME_ICON[''];
    btn.title = 'Theme: ' + THEME_NAME[t] + (t ? '' : ' (' + shown + ')') + '. Click for ' + THEME_NAME[NEXT_THEME[t]] + '.';
    btn.setAttribute('aria-label', btn.title);
  }
  function themeButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'jnav-icon jnav-theme';
    paintTheme(b);
    b.addEventListener('click', function () {
      var next = NEXT_THEME[readTheme()];
      writeTheme(next);
      applyTheme(next);
      themeBtns.forEach(paintTheme);
    });
    themeBtns.push(b);
    return b;
  }

  function paintToggle(b) {
    b.setAttribute('aria-expanded', settingsOpen ? 'true' : 'false');
    b.title = (settingsOpen ? 'Hide' : 'Show') + ' navigation and settings';
    b.setAttribute('aria-label', b.title);
  }
  // open: boolean. opts.persist === false: do not remember it (termhub's drawer).
  function setSettings(open, opts) {
    open = !!open;
    if (!(opts && opts.persist === false) && !NARROW.matches) {
      try { localStorage.setItem(settingsKey, open ? '1' : '0'); } catch (e) { /* private mode */ }
    }
    if (open === settingsOpen) return;
    settingsOpen = open;
    root.setAttribute('data-settings', open ? 'open' : 'closed');
    toggles.forEach(paintToggle);
    try { window.dispatchEvent(new CustomEvent('jarvis:settings', { detail: { open: open } })); } catch (e) { /* old browser */ }
  }

  // The navigation at the top of the panel: every destination, then the theme.
  function panelNav() {
    var box = document.createElement('nav');
    box.className = 'jpanel-nav';
    box.setAttribute('aria-label', 'Jarvis');
    var top = document.createElement('div');
    top.className = 'jpanel-top';
    top.appendChild(themeButton());
    var list = document.createElement('ol');
    list.className = 'jpanel-list';
    list.innerHTML = DESTS.map(function (d, i) {
      return '<li><a class="jpanel-link" data-dest="' + d.id + '"><span>' + d.label + '</span><kbd>Alt+' + (i + 1) + '</kbd></a></li>';
    }).join('');
    list.addEventListener('pointerover', function (e) {
      var a = e.target.closest && e.target.closest('[data-dest]');
      if (a) warm(a.getAttribute('data-dest'));
    });
    box.appendChild(top);
    box.appendChild(list);
    navLists.push(list);
    return box;
  }

  // termhub's ?focus= view: a small tab in the corner showing where you are.
  function floatNav() {
    var nav = document.createElement('nav');
    nav.className = 'jnav jnav--float';
    nav.setAttribute('aria-label', 'Jarvis');
    nav.innerHTML = '<ol class="jnav-rail">' + DESTS.map(function (d) {
      return '<li><a class="jnav-seg jpanel-link" data-dest="' + d.id + '">' + d.label + '</a></li>';
    }).join('') + '</ol>';
    nav.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-dest]');
      if (a && a.getAttribute('data-dest') === current && !nav.classList.contains('open')) {
        e.preventDefault();
        e.stopPropagation();
        nav.classList.add('open');
      }
    }, true);
    document.addEventListener('pointerdown', function (e) { if (!nav.contains(e.target)) nav.classList.remove('open'); }, true);
    document.body.appendChild(nav);
    navLists.push(nav);
  }

  function paint() {
    var here = framed ? current : showing;
    navLists.forEach(function (list) {
      DESTS.forEach(function (d, i) {
        var a = list.querySelector('[data-dest="' + d.id + '"]');
        if (!a) return;
        a.href = hrefFor(d.id);
        if (d.id === here) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
        var off = !reachable(d.id);
        a.classList.toggle('is-off', off);
        a.title = off ? d.label + ': the assistant is not reachable from here' : d.label + ': ' + d.about + ' (Alt+' + (i + 1) + ')';
        if (off) a.setAttribute('aria-disabled', 'true');
        else a.removeAttribute('aria-disabled');
      });
    });
  }

  // A plain left click on a link to a destination switches instead of loading a page:
  // the panel's own links, and any a page has (termhub's "agent time" bar, its back link).
  // Only a link to ANOTHER destination is a switch. A link into this page (a view
  // like #memory, an anchor, a hash route) is the page's own business and must
  // reach it untouched: Plan's views are such links.
  function destOfHref(href) {
    var u;
    try { u = new URL(href, location.href); } catch (e) { return null; }
    if (u.search) return null;
    for (var i = 0; i < DESTS.length; i++) {
      var id = DESTS[i].id;
      var t = new URL(hrefFor(id), location.href);
      if (t.origin === u.origin && t.pathname.replace(/\/$/, '') === u.pathname.replace(/\/$/, '')) return id === current ? null : id;
    }
    return null;
  }
  function destOfLink(a) {
    return a.getAttribute('data-dest') || destOfHref(a.getAttribute('href') || '');
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self')) return;
    var id = destOfLink(a);
    if (!id) return;
    e.preventDefault();
    if (a.classList.contains('is-off')) return;
    go(id);
  });

  // Alt+1..6 from anywhere. Capture phase on window: runs before xterm's own key
  // handler on its textarea. In a frame it is forwarded to the shell.
  window.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var m = /^Digit([1-9])$/.exec(e.code || '');
    if (!m || !DESTS[Number(m[1]) - 1]) return;
    e.preventDefault();
    e.stopPropagation();
    go(DESTS[Number(m[1]) - 1].id);
  }, true);

  if (!framed) {
    // A frame asks to go somewhere. Only our own frames may.
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || (d.jarvis !== 'go' && d.jarvis !== 'warm') || typeof d.id !== 'string') return;
      var mine = false;
      for (var k in frames) if (frames[k].contentWindow === e.source) mine = true;
      if (!mine) return;
      if (d.jarvis === 'go') go(d.id);
      else warm(d.id);
    });
    window.addEventListener('popstate', function () { show(fromUrl(), { fromHistory: true }); });
  }
  // The theme chosen in one page applies to the others of the same origin at once.
  window.addEventListener('storage', function (e) {
    if (e.key !== THEME_KEY) return;
    applyTheme(readTheme());
    themeBtns.forEach(paintTheme);
  });

  function mount() {
    if (focusId) {
      floatNav();
    } else {
      var side = document.querySelector('[data-jside]');
      if (!side) {
        // No controls of its own: a panel that holds the navigation only.
        side = document.createElement('aside');
        side.className = 'jside jside--auto';
        side.setAttribute('data-jside', '');
        side.id = 'jarvis-panel';
        document.body.appendChild(side);
      }
      if (!side.id) side.id = 'jarvis-panel';
      var slot = side.querySelector('[data-jside-nav]');
      var nav = panelNav();
      if (slot) slot.replaceWith(nav);
      else side.insertBefore(nav, side.firstChild);

      var t = document.createElement('button');
      t.type = 'button';
      t.className = 'jnav-icon jnav-toggle';
      t.innerHTML = TOGGLE_ICON;
      t.setAttribute('aria-controls', side.id);
      paintToggle(t);
      t.addEventListener('click', function () { setSettings(!settingsOpen); });
      toggles.push(t);
      document.body.appendChild(t);

      // On a phone the panel is an overlay: a tap outside it (and off the toggle) closes it.
      document.addEventListener('pointerdown', function (e) {
        if (!settingsOpen || !NARROW.matches) return;
        if (side.contains(e.target) || t.contains(e.target)) return;
        setSettings(false);
      }, true);
    }
    paint();
    var first = fromUrl();
    if (!framed && first !== current) show(first, { fromHistory: true });
    fetchSession().then(function () {
      paint();
      if (framed) return;
      // Warm the other destinations once this page has painted and gone quiet.
      var idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 1200); };
      idle(prefetch, { timeout: 3000 });
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { themeBtns.forEach(paintTheme); });
    // A tab left open: the PA may have started (or ended) its session since.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') fetchSession().then(paint);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.JarvisNav = {
    destinations: DESTS,
    go: go,
    linkTarget: destOfHref, // which destination a link switches to, or null (test/nav.test.js)
    refresh: function () { return fetchSession().then(paint); },
    settings: {
      isOpen: function () { return settingsOpen; },
      set: setSettings,
      toggle: function (opts) { setSettings(!settingsOpen, opts); },
    },
  };
})();
