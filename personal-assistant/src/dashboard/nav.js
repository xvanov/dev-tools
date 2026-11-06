/* The layer switcher shared by all four Jarvis layers, and the theme toggle.
 *
 *   1 Talk       PA /talk                 (relative: works on :7300 and under termhub's /pa/)
 *   2 Dashboard  PA /
 *   3 Sessions   termhub /
 *   4 Session    termhub /?focus=<PA chat session id>   (one terminal, no termhub chrome)
 *
 * CANONICAL COPY: personal-assistant/src/dashboard/nav.js. termhub/web/nav.js is a
 * byte copy (`npm run sync-theme` in termhub; test/theme.test.js fails on drift).
 *
 * Usage: <script src="nav.js" data-layer="talk|dashboard|termhub"></script> in <head>
 * (synchronous, so the remembered theme is set before first paint), plus an element
 * with [data-jnav] where the switcher goes. termhub pages say "termhub" and the
 * script picks Sessions or Session from ?focus=. Alt+1..4 switches from anywhere,
 * terminal included (captured before xterm sees it).
 *
 * Where the links go:
 *   - on termhub, or on the PA through termhub's /pa/ proxy: one origin, so the PA is
 *     /pa/ and termhub is /;
 *   - on the PA directly (127.0.0.1:7300): termhub is the origin of the chat
 *     session's url (GET api/chat/session), else <meta name="pa-termhub">, else
 *     http://127.0.0.1:7000.
 * Session asks the PA for its chat session (api/chat/session; api/chat/open starts one).
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

  // ---- where everything is -----------------------------------------------------------
  var onTermhub = declared === 'termhub';
  var proxied = /^\/pa(\/|$)/.test(location.pathname);
  var focusId = onTermhub ? new URLSearchParams(location.search).get('focus') : null;
  var current = onTermhub ? (focusId ? 'session' : 'sessions') : declared;
  var paBase = onTermhub ? '/pa/' : new URL('./', location.href).pathname;
  var sameOrigin = onTermhub || proxied;
  var termhub = ''; // origin of termhub; '' = this one
  var chatId = null;
  var paUp = true;

  function termhubBase() {
    if (sameOrigin) return '';
    if (termhub) return termhub;
    var meta = document.querySelector('meta[name="pa-termhub"]');
    return ((meta && meta.content) || 'http://127.0.0.1:7000').replace(/\/$/, '');
  }
  function sessionHref(id) {
    // ?focus= is layer 4; the hash makes an older termhub at least open the session.
    return termhubBase() + '/?focus=' + encodeURIComponent(id) + '#session=' + encodeURIComponent(id);
  }

  var LAYERS = [
    { id: 'talk', key: '1', label: 'Talk', title: 'Talk: the voice face', pa: true },
    { id: 'dashboard', key: '2', label: 'Dashboard', title: 'Dashboard: the board, chat, memory, routines', pa: true },
    { id: 'sessions', key: '3', label: 'Sessions', title: 'Sessions: every terminal in termhub', pa: false },
    { id: 'session', key: '4', label: 'Session', title: "Session: the assistant's own Claude session, full window", pa: true },
  ];

  function hrefFor(id) {
    if (id === 'talk') return paBase + 'talk';
    if (id === 'dashboard') return paBase;
    // From layer 4 back up, keep the session open in the hub.
    if (id === 'sessions') return termhubBase() + '/' + (focusId ? '#session=' + encodeURIComponent(focusId) : '');
    if (id === 'session') return chatId ? sessionHref(chatId) : (focusId ? location.href : '#');
    return '#';
  }

  // ---- the chat session (Session's target) ------------------------------------------
  function fetchSession() {
    return fetch(paBase + 'api/chat/session', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (s) {
        paUp = true;
        chatId = (s && s.sessionId) || null;
        if (!sameOrigin && s && s.url) { try { termhub = new URL(s.url).origin; } catch (e) { /* keep default */ } }
        return chatId;
      }, function () { paUp = !onTermhub; return null; });
  }
  function openSession() {
    if (chatId) return Promise.resolve(chatId);
    return fetch(paBase + 'api/chat/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-PA': '1' },
      body: '{}',
    })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || 'HTTP ' + r.status); return b; }); })
      .then(function (b) { if (!b.sessionId) throw new Error('the assistant named no session'); chatId = b.sessionId; return chatId; });
  }

  // ---- render ---------------------------------------------------------------------------
  var navs = [];
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

  function build(slot, variant) {
    var nav = document.createElement('nav');
    nav.className = 'jnav' + (variant ? ' jnav--' + variant : '');
    nav.setAttribute('aria-label', 'Jarvis layers');
    var brand = '<span class="jnav-brand"><i class="jnav-dot"></i><span class="jnav-brand-word">jarvis</span></span>';
    var rail = '<ol class="jnav-rail">' + LAYERS.map(function (l) {
      return '<li><a class="jnav-seg" data-layer="' + l.id + '" title="' + l.title + ' (Alt+' + l.key + ')"><kbd>' + l.key + '</kbd>' + l.label + '</a></li>';
    }).join('') + '</ol>';
    nav.innerHTML = brand + rail + '<button type="button" class="jnav-theme"></button>';
    var themeBtn = nav.querySelector('.jnav-theme');
    paintTheme(themeBtn);
    themeBtn.addEventListener('click', function () {
      var next = NEXT_THEME[readTheme()];
      writeTheme(next);
      applyTheme(next);
      navs.forEach(function (n) { paintTheme(n.querySelector('.jnav-theme')); });
    });
    nav.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.jnav-seg');
      if (!a) return;
      // Layer 4's tab: a tap on "where you are" opens the switcher on a phone.
      if (variant === 'float' && a.getAttribute('data-layer') === current && !nav.classList.contains('open')) {
        e.preventDefault();
        nav.classList.add('open');
        return;
      }
      var plain = !(e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1);
      if (a.classList.contains('is-off')) { e.preventDefault(); return; }
      if (a.getAttribute('data-layer') === 'session' && !chatId && plain) { e.preventDefault(); go('session'); }
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
    if (id !== 'session' || chatId) { location.href = hrefFor(id); return; }
    navs.forEach(function (n) { var a = n.querySelector('[data-layer="session"]'); a.classList.add('is-busy'); });
    openSession().then(function (sid) { location.href = sessionHref(sid); }, function (err) {
      navs.forEach(function (n) {
        var a = n.querySelector('[data-layer="session"]');
        a.classList.remove('is-busy');
        a.title = 'Could not open the session: ' + err.message;
      });
    });
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

  function mount() {
    var slots = document.querySelectorAll('[data-jnav]');
    if (current === 'session') build(null, 'float');
    for (var i = 0; i < slots.length; i++) build(slots[i], slots[i].getAttribute('data-jnav') || '');
    if (!navs.length) build(null, 'float');
    paint();
    fetchSession().then(paint);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      navs.forEach(function (n) { paintTheme(n.querySelector('.jnav-theme')); });
    });
    // A tab left open: the PA may have started (or ended) its session since.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') fetchSession().then(paint);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.JarvisNav = { go: go, refresh: function () { return fetchSession().then(paint); } };
})();
