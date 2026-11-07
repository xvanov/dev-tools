/* The layer switcher shared by all four Jarvis layers, and the theme toggle.
 *
 *   1 Talk       PA /talk                 (relative: works on :7300 and under termhub's /pa/)
 *   2 Dashboard  PA /
 *   3 Factory    PA /factory              (every software-factory job: code, research, reports)
 *   4 Sessions   termhub /                (and its /?focus=<id> deep link: one terminal, no chrome)
 *
 * CANONICAL COPY: personal-assistant/src/dashboard/nav.js. termhub/web/nav.js is a
 * byte copy (`npm run sync-theme` in termhub; test/theme.test.js fails on drift).
 *
 * Usage: <script src="nav.js" data-layer="talk|dashboard|factory|termhub"></script> in <head>
 * (synchronous, so the remembered theme and settings state are set before first paint),
 * plus an element with [data-jnav] where the switcher goes (inside <header class="jhead">).
 *
 * Settings: each layer shows only its one thing; its controls live in a [data-jside]
 * panel. When the page has one, the switcher leads with a toggle for it, and nav.js
 * puts the theme toggle and the Architecture link (/architecture, a page of its own,
 * not a layer) at the top of it. Closed by default; the choice is remembered per
 * layer (localStorage jarvis.settings.<layer>) on wide screens only: on a phone the
 * panel is an overlay, so it always starts closed. The state is
 * <html data-settings="open|closed">, and every change fires `jarvis:settings`
 * ({detail: {open}}) on window, which termhub uses to slide its session list. termhub pages say "termhub": that is
 * Sessions, and on its ?focus= view (a link target, not a layer of its own) the
 * switcher shrinks to a tab in the corner. Alt+1..4 switches from anywhere, terminal
 * included (captured before xterm sees it).
 *
 * Where the links go:
 *   - on termhub, or on the PA through termhub's /pa/ proxy: one origin, so the PA is
 *     /pa/ and termhub is /;
 *   - on the PA directly (127.0.0.1:7300): termhub is the origin of the chat
 *     session's url (GET api/chat/session), else <meta name="pa-termhub">, else
 *     http://127.0.0.1:7000.
 * Whether the PA answers (so whether Talk, Dashboard and Factory work from termhub) is
 * read from api/chat/session.
 */
(function () {
  'use strict';
  var KEY = 'jarvis.theme';
  var root = document.documentElement;
  var script = document.currentScript;
  var declared = (script && script.getAttribute('data-layer')) || root.getAttribute('data-layer') || '';

  // ---- theme: system until chosen; remembered per browser ----------------------------
  function readTheme() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function writeTheme(v) {
    try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* private mode */ }
  }
  function applyTheme(v) {
    if (v === 'light' || v === 'dark') root.setAttribute('data-theme', v);
    else root.removeAttribute('data-theme');
  }
  applyTheme(readTheme());

  // ---- settings panel: closed until opened; remembered per layer on wide screens -------
  var NARROW = window.matchMedia ? matchMedia('(max-width: 760px)') : { matches: false };
  var settingsKey = 'jarvis.settings.' + (declared === 'termhub' ? 'sessions' : declared);
  function readSettings() { try { return localStorage.getItem(settingsKey) === '1'; } catch (e) { return false; } }
  var settingsOpen = !NARROW.matches && readSettings();
  root.setAttribute('data-settings', settingsOpen ? 'open' : 'closed');

  // ---- where everything is -----------------------------------------------------------
  var onTermhub = declared === 'termhub';
  var proxied = /^\/pa(\/|$)/.test(location.pathname);
  var focusId = onTermhub ? new URLSearchParams(location.search).get('focus') : null;
  var current = onTermhub ? 'sessions' : declared;
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
  var LAYERS = [
    { id: 'talk', key: '1', label: 'Talk', title: 'Talk: the voice face', pa: true },
    { id: 'dashboard', key: '2', label: 'Dashboard', title: 'Dashboard: the board, chat, memory, routines', pa: true },
    { id: 'factory', key: '3', label: 'Factory', title: 'Factory: every job the software factory runs — code, research, reports', pa: true },
    { id: 'sessions', key: '4', label: 'Sessions', title: 'Sessions: every terminal in termhub; open one to drill in', pa: false },
  ];

  function hrefFor(id) {
    if (id === 'talk') return paBase + 'talk';
    if (id === 'dashboard') return paBase;
    if (id === 'factory') return paBase + 'factory';
    // From a ?focus= view back to the hub, keep that session open there.
    if (id === 'sessions') return termhubBase() + '/' + (focusId ? '#session=' + encodeURIComponent(focusId) : '');
    return '#';
  }

  // ---- is the PA there, and where is termhub ----------------------------------------
  function fetchSession() {
    return fetch(paBase + 'api/chat/session', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (s) {
        paUp = true;
        if (!sameOrigin && s && s.url) { try { termhub = new URL(s.url).origin; } catch (e) { /* keep default */ } }
      }, function () { paUp = !onTermhub; });
  }

  // ---- render ---------------------------------------------------------------------------
  var navs = [];
  var themeBtns = [];
  var toggles = [];
  var THEME_ICON = {
    '': '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" fill="currentColor"/></svg>',
  };
  var THEME_NAME = { '': 'system', light: 'light', dark: 'dark' };
  var NEXT_THEME = { '': 'light', light: 'dark', dark: '' };

  function paintTheme(btn) {
    var t = readTheme();
    var shown = t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    btn.innerHTML = THEME_ICON[t] || THEME_ICON[''];
    btn.title = 'Theme: ' + THEME_NAME[t] + (t ? '' : ' (' + shown + ')') + '. Click for ' + THEME_NAME[NEXT_THEME[t]] + '.';
    btn.setAttribute('aria-label', btn.title);
  }

  var TOGGLE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5L8 8l-4.5 4.5M8.5 3.5L13 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
    b.title = (settingsOpen ? 'Hide' : 'Show') + ' settings';
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

  function build(slot, variant, side) {
    var nav = document.createElement('nav');
    nav.className = 'jnav' + (variant ? ' jnav--' + variant : '');
    nav.setAttribute('aria-label', 'Jarvis layers');
    var brand = '<span class="jnav-brand"><i class="jnav-dot"></i><span class="jnav-brand-word">jarvis</span></span>';
    var rail = '<ol class="jnav-rail">' + LAYERS.map(function (l) {
      return '<li><a class="jnav-seg" data-layer="' + l.id + '" title="' + l.title + ' (Alt+' + l.key + ')"><kbd>' + l.key + '</kbd>' + l.label + '</a></li>';
    }).join('') + '</ol>';
    nav.innerHTML = brand + rail;
    if (variant !== 'float') {
      if (side) {
        var t = document.createElement('button');
        t.type = 'button';
        t.className = 'jnav-icon jnav-toggle';
        t.innerHTML = TOGGLE_ICON;
        if (side.id) t.setAttribute('aria-controls', side.id);
        paintToggle(t);
        t.addEventListener('click', function () { setSettings(!settingsOpen); });
        toggles.push(t);
        nav.insertBefore(t, nav.firstChild);
      } else {
        // No panel on this page: the theme toggle stays in the bar.
        nav.appendChild(themeButton());
      }
    }
    nav.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.jnav-seg');
      if (!a) return;
      // The ?focus= view's tab: a tap on "where you are" opens the switcher on a phone.
      if (variant === 'float' && a.getAttribute('data-layer') === current && !nav.classList.contains('open')) {
        e.preventDefault();
        nav.classList.add('open');
        return;
      }
      if (a.classList.contains('is-off')) e.preventDefault();
    });
    if (variant === 'float') {
      document.addEventListener('pointerdown', function (e) { if (!nav.contains(e.target)) nav.classList.remove('open'); }, true);
    }
    if (slot) slot.replaceWith(nav);
    else document.body.appendChild(nav);
    navs.push(nav);
    return nav;
  }

  function paint() {
    navs.forEach(function (nav) {
      LAYERS.forEach(function (l) {
        var a = nav.querySelector('.jnav-seg[data-layer="' + l.id + '"]');
        a.href = hrefFor(l.id);
        if (l.id === current) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
        var off = l.pa && !paUp && l.id !== current;
        a.classList.toggle('is-off', off);
        a.title = off ? l.label + ': the assistant is not reachable from this termhub' : l.title + ' (Alt+' + l.key + ')';
        if (off) a.setAttribute('aria-disabled', 'true');
        else a.removeAttribute('aria-disabled');
      });
    });
  }

  function go(id) {
    if (id === current) return;
    var layer = LAYERS.filter(function (l) { return l.id === id; })[0];
    if (!layer || (layer.pa && !paUp)) return;
    location.href = hrefFor(id);
  }

  // Capture phase on window: runs before xterm's own key handler on its textarea.
  window.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var m = /^Digit([1-4])$/.exec(e.code || '');
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    go(LAYERS[Number(m[1]) - 1].id);
  }, true);

  // The top of the settings panel: the Architecture page, and the theme toggle.
  function sideTools(side) {
    var tools = document.createElement('div');
    tools.className = 'jside-tools';
    var arch = document.createElement('a');
    arch.href = paBase + 'architecture';
    arch.textContent = 'Architecture';
    arch.title = 'How the four layers fit together';
    tools.appendChild(arch);
    tools.appendChild(themeButton());
    var slot = side.querySelector('[data-jside-tools]');
    if (slot) slot.replaceWith(tools);
    else side.insertBefore(tools, side.firstChild);
  }

  function mount() {
    var side = document.querySelector('[data-jside]');
    var slots = document.querySelectorAll('[data-jnav]');
    if (focusId) build(null, 'float');
    for (var i = 0; i < slots.length; i++) build(slots[i], slots[i].getAttribute('data-jnav') || '', side);
    if (!navs.length) build(null, 'float');
    if (side) sideTools(side);
    paint();
    fetchSession().then(paint);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      themeBtns.forEach(paintTheme);
    });
    // On a phone the panel is an overlay: a tap outside it (and outside the bar) closes it.
    document.addEventListener('pointerdown', function (e) {
      if (!settingsOpen || !NARROW.matches || !side) return;
      if (side.contains(e.target) || (e.target.closest && e.target.closest('.jhead'))) return;
      setSettings(false);
    }, true);
    // A tab left open: the PA may have started (or ended) its session since.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') fetchSession().then(paint);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.JarvisNav = {
    go: go,
    refresh: function () { return fetchSession().then(paint); },
    settings: {
      isOpen: function () { return settingsOpen; },
      set: setSettings,
      toggle: function (opts) { setSettings(!settingsOpen, opts); },
    },
  };
})();
