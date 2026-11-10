/* The Build board (served as /build-board.js; PLAN.md D30).
 *
 * One card per Build agent run: state, model, cost against its cap, duration,
 * the result, "Open in termhub" and Stop; a timeline with a lane for the main
 * agent and one per subagent (tool calls as ticks, red when one failed; a lane
 * pulses only while its agent works, an ended one is a static bar); the tool
 * calls as steps; and the messages the agent and Jarvis exchanged (notes,
 * asks, replies), an open ask with its reply box. Runs the agents asked about
 * are lifted into "Needs you". Ten runs a page.
 *
 * Data: GET api/build (src/dashboard/buildBoard.ts), re-read every 5 s while an
 * agent is live, every 30 s otherwise, and at once on an action. Everything an
 * agent wrote is set with textContent only: no HTML sinks. URLs are relative
 * (termhub's /pa/ proxy).
 *
 * The pure half (dur, money, lanes, resultLink, pageCount) is required by
 * test/buildBoard.test.js; the browser gets window.BuildBoard.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuildBoard = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIVE = ['starting', 'running', 'waiting'];
  var PAGE = 10;

  // ---- the pure half ------------------------------------------------------------

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }

  /** Milliseconds as "45s", "12m", "1h 05m". */
  function dur(ms) {
    var s = Math.max(0, Math.round(num(ms) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    var m = Math.round((s % 3600) / 60);
    return Math.floor(s / 3600) + 'h ' + (m < 10 ? '0' : '') + m + 'm';
  }
  function money(n) { return '$' + num(n).toFixed(2); }
  function isLive(run) { return LIVE.indexOf(run.state) >= 0; }

  /** How long a run took, or has taken so far. */
  function elapsed(run, now) {
    var t0 = Date.parse(run.started_at);
    var t1 = run.ended_at ? Date.parse(run.ended_at) : Date.parse(now) || Date.now();
    return Number.isFinite(t0) ? Math.max(0, t1 - t0) : 0;
  }

  /** A result that is a URL becomes a link; a path or a sentence stays text. */
  function resultLink(text) {
    var m = /^https?:\/\/\S+$/.exec(String(text || '').trim());
    return m ? m[0] : null;
  }

  function pageCount(total, size) { return Math.max(1, Math.ceil(num(total) / (size || PAGE))); }

  /**
   * The timeline: one lane per agent on a shared time axis from the run's
   * start to its end (or now). A lane's bar runs from its agent's first line to
   * its last (to now while it works); each tool call is a tick at its time.
   * Percentages of the axis; `live` lanes pulse, the rest are static.
   */
  function lanes(run, now) {
    var t0 = Date.parse(run.started_at);
    var t1 = run.ended_at ? Date.parse(run.ended_at) : Date.parse(now) || Date.now();
    var agents = run.agents || [];
    agents.forEach(function (a) {
      var s = Date.parse(a.started_at); var e = Date.parse(a.ended_at);
      if (Number.isFinite(s) && s < t0) t0 = s;
      if (Number.isFinite(e) && e > t1) t1 = e;
    });
    var span = Math.max(1, t1 - t0);
    var pct = function (t) { return Math.min(100, Math.max(0, ((t - t0) / span) * 100)); };
    return {
      t0: t0, t1: t1,
      lanes: agents.map(function (a) {
        var s = Date.parse(a.started_at);
        var e = a.state === 'running' ? t1 : Date.parse(a.ended_at);
        var left = Number.isFinite(s) ? pct(s) : 0;
        var right = Number.isFinite(e) ? pct(e) : left;
        return {
          id: a.id,
          label: a.kind === 'main' ? 'main' : (a.type || 'subagent') + (a.description ? ': ' + a.description : ''),
          live: a.state === 'running' && isLive(run),
          failed: a.errors > 0,
          left: left, width: Math.max(0.8, right - left),
          ticks: (a.calls || []).map(function (c) {
            var at = Date.parse(c.at);
            return { pct: Number.isFinite(at) ? pct(at) : left, name: c.name, ok: c.ok, args: c.args };
          }),
        };
      }),
    };
  }

  /** Needs-you asks first, then live runs, then the rest, each newest first. */
  function order(runs) {
    var rank = function (r) { return r.messages.some(function (m) { return m.kind === 'ask' && !m.answered; }) ? 0 : isLive(r) ? 1 : 2; };
    return runs.slice().sort(function (a, b) { return rank(a) - rank(b) || b.id - a.id; });
  }

  var pure = { dur: dur, money: money, elapsed: elapsed, resultLink: resultLink, pageCount: pageCount, lanes: lanes, order: order, isLive: isLive, PAGE: PAGE };
  if (typeof document === 'undefined') return pure;

  // ---- the browser half ------------------------------------------------------------

  var PAGE_TOKEN = (function () {
    var m = document.querySelector('meta[name="pa-page"]');
    var t = m ? m.getAttribute('content') : '';
    if (m) m.remove();
    return t;
  })();

  function el(tag, props) {
    var n = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      if (k === 'class') n.className = p[k];
      else if (k === 'text') n.textContent = p[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), p[k]);
      else if (p[k] != null) n.setAttribute(k, p[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      n.append(kid);
    }
    return n;
  }
  function chip(text, cls, title) { return el('span', { class: 'chip ' + (cls || ''), title: title || null, text: text }); }
  function clock(iso) {
    var d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  }
  function toast(text) {
    var t = document.getElementById('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove('show'); }, 5000);
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PA': '1', 'X-PA-Page': PAGE_TOKEN },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status, data: d });
        return d;
      });
    });
  }

  var state = { data: null, page: 1, timer: null, open: {} };

  function load() {
    return fetch('api/build?page=' + state.page + '&limit=' + PAGE).then(function (r) { return r.json(); }).then(function (d) {
      state.data = d;
      draw();
      var up = document.getElementById('updated');
      if (up) up.textContent = 'updated ' + clock(d.now) + ' · ' + d.live + ' live of ' + d.total;
      schedule();
    }).catch(function (e) {
      var up = document.getElementById('updated');
      if (up) { up.textContent = 'could not load: ' + e.message; up.classList.add('bad'); }
      schedule();
    });
  }
  function schedule() {
    clearTimeout(state.timer);
    var live = state.data && state.data.live > 0;
    state.timer = setTimeout(load, live ? 5000 : 30000);
  }

  // A redraw rebuilds the cards: not while you are typing in one.
  function typing() {
    var a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && document.getElementById('board').contains(a);
  }

  function act(button, fn, done) {
    button.addEventListener('click', function () {
      button.disabled = true;
      fn().then(function (r) { if (done) toast(done(r)); return load(); }).catch(function (e) { toast(e.message); }).then(function () { button.disabled = false; });
    });
  }

  function msgRow(m) {
    var who = m.from === 'agent' ? 'agent' : 'Jarvis';
    var kind = m.kind === 'ask' ? (m.answered ? 'asked' : 'asks') : m.kind === 'send' ? 'typed' : m.kind === 'reply' ? 'replied' : m.kind === 'done' ? 'done' : 'note';
    return el('li', { class: 'msg k-' + m.kind },
      el('span', { class: 'meta', text: clock(m.at) + ' · ' + who + ' ' + kind }),
      el('div', { class: 'mt', text: m.text }),
      m.answer ? el('div', { class: 'mt ans', text: '→ ' + m.answer }) : null);
  }

  function askBox(run, ask) {
    var input = el('input', { type: 'text', placeholder: 'Answer ' + 'the agent', 'aria-label': 'Answer to run ' + run.id, class: 'replyin' });
    var btn = el('button', { type: 'button', class: 'primary', text: 'Reply' });
    act(btn, function () { return post('api/build/' + run.id + '/reply', { text: input.value }); }, function () { return 'answered run #' + run.id; });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
    return el('div', { class: 'askbox' }, el('div', { class: 'mt', text: ask.text }), el('div', { class: 'row' }, input, btn));
  }

  function timeline(run, now) {
    var L = lanes(run, now);
    if (!L.lanes.length) return null;
    return el.apply(null, ['div', { class: 'trace' }].concat(L.lanes.map(function (l) {
      var bar = el('div', { class: 'blk' + (l.live ? ' running' : '') + (l.failed ? ' failed' : ''), style: 'left:' + l.left + '%;width:' + l.width + '%', title: l.label });
      var ticks = l.ticks.map(function (t) {
        return el('i', { class: 'tick' + (t.ok === false ? ' err' : ''), style: 'left:' + t.pct + '%', title: t.name + (t.args ? ': ' + t.args : '') });
      });
      return el('div', { class: 'lane' }, el('div', { class: 'lname', text: l.label, title: l.label }), el.apply(null, ['div', { class: 'track' }, bar].concat(ticks)));
    })));
  }

  function steps(run) {
    var rows = [];
    (run.agents || []).forEach(function (a) {
      (a.calls || []).forEach(function (c) { rows.push({ a: a, c: c }); });
    });
    rows.sort(function (x, y) { return String(x.c.at).localeCompare(String(y.c.at)); });
    if (!rows.length) return null;
    var shown = rows.slice(-60).reverse();
    var d = el('details', { class: 'calls' }, el('summary', { text: run.calls_total + ' tool calls' }));
    if (state.open[run.id + ':calls']) d.setAttribute('open', '');
    d.addEventListener('toggle', function () { state.open[run.id + ':calls'] = d.open; });
    d.append(el.apply(null, ['ul', { class: 'steps' }].concat(shown.map(function (r) {
      return el('li', { class: r.c.ok === false ? 'err' : '' },
        el('span', { class: 'tres ' + (r.c.ok === false ? 'err' : r.c.ok ? 'ok' : 'pending'), text: r.c.ok === false ? '✗' : r.c.ok ? '✓' : '…' }),
        el('span', { class: 'tname', text: r.c.name }),
        el('span', { class: 'targ', text: r.c.args, title: r.c.args }),
        r.a.kind === 'subagent' ? el('span', { class: 'chip', text: r.a.type || 'sub' }) : null,
        el('span', { class: 'meta', text: clock(r.c.at) + (r.c.ms != null ? ' · ' + dur(r.c.ms) : '') }));
    }))));
    return d;
  }

  function card(run, now) {
    var live = isLive(run);
    var open = run.messages.filter(function (m) { return m.kind === 'ask' && !m.answered; });
    var cap = run.cost_cap_usd ? ' / ' + money(run.cost_cap_usd) : '';
    var link = resultLink(run.result);
    var sendIn = el('input', { type: 'text', placeholder: 'Type into its session', 'aria-label': 'Message to run ' + run.id, class: 'replyin' });
    var sendBtn = el('button', { type: 'button', text: 'Send' });
    act(sendBtn, function () { return post('api/build/' + run.id + '/send', { text: sendIn.value }); }, function () { return 'sent to run #' + run.id; });
    sendIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendBtn.click(); });
    var stop = el('button', { type: 'button', class: 'danger', text: 'Stop' });
    act(stop, function () { return post('api/build/' + run.id + '/stop', {}); }, function () { return 'run #' + run.id + ' stopped'; });
    var subs = (run.agents || []).filter(function (a) { return a.kind === 'subagent'; }).length;
    return el('article', { class: 'job run s-' + run.state + (open.length ? ' needs' : ''), id: 'run-' + run.id },
      el('div', { class: 't' }, el('span', { class: 'mono', text: '#' + run.id + ' ' }), el('span', { text: run.task })),
      el('div', { class: 'chips' },
        chip(open.length ? 'needs you' : run.state, open.length ? 's-needs_human' : 's-' + run.state),
        chip(run.model, 'mono'),
        chip(money(run.cost_usd) + cap + ' notional', 'mono', 'What this would cost at API prices; the subscription is not billed per run'),
        chip(dur(elapsed(run, now)) + (run.wall_cap_min ? ' / ' + dur(run.wall_cap_min * 60000) : ''), 'mono'),
        chip(Math.round((run.tokens.in + run.tokens.out + run.tokens.cache_read + run.tokens.cache_write) / 1000) + 'k tokens', 'mono',
          'in ' + run.tokens.in + ' · out ' + run.tokens.out + ' · cache read ' + run.tokens.cache_read + ' · cache write ' + run.tokens.cache_write),
        subs ? chip(subs + ' subagent' + (subs > 1 ? 's' : ''), 'mono') : null,
        run.branch ? chip(run.branch, 'mono') : null),
      run.result ? el('div', { class: 'why result' }, 'Result: ', link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: link }) : el('span', { text: run.result })) : null,
      run.error ? el('div', { class: 'why err', text: run.error }) : null,
      el('div', { class: 'actions' },
        run.url ? el('a', { class: 'btn', href: run.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open in termhub' }) : null,
        live ? stop : null),
      open.map(function (a) { return askBox(run, a); }),
      timeline(run, now),
      steps(run),
      run.messages.length ? el.apply(null, ['ul', { class: 'msgs' }].concat(run.messages.map(msgRow))) : null,
      live ? el('div', { class: 'row' }, sendIn, sendBtn) : null);
  }

  function pager(total) {
    var pages = pageCount(total, PAGE);
    if (pages < 2) return null;
    function go(n) { return function () { state.page = n; load(); }; }
    var kids = [el('button', { type: 'button', class: 'linkish', text: 'Prev', disabled: state.page > 1 ? null : 'disabled', onclick: go(state.page - 1) })];
    for (var n = 1; n <= pages; n++) {
      kids.push(el('button', { type: 'button', class: 'linkish' + (n === state.page ? ' cur' : ''), text: String(n), 'aria-current': n === state.page ? 'page' : null, onclick: go(n) }));
    }
    kids.push(el('button', { type: 'button', class: 'linkish', text: 'Next', disabled: state.page < pages ? null : 'disabled', onclick: go(state.page + 1) }));
    return el.apply(null, ['nav', { class: 'bpager', 'aria-label': 'Pages' }].concat(kids));
  }

  function draw() {
    var d = state.data;
    if (!d || typing()) return;
    var board = document.getElementById('board');
    var runs = order(d.runs);
    var needs = d.needs_you || [];
    board.replaceChildren(
      needs.length ? el.apply(null, ['section', { class: 'needs_you' }, el('h2', {}, 'Needs you', el('span', { class: 'n', text: String(needs.length) }))].concat(needs.map(function (n) {
        return el('div', { class: 'job' }, el('div', { class: 't', text: '#' + n.run + ' ' + n.task }), el('div', { class: 'why', text: n.question }),
          el('a', { class: 'btn', href: '#run-' + n.run, text: 'Answer on its card' }));
      }))) : null,
      el.apply(null, ['section', { class: 'runsec' }, el('h2', {}, 'Agents', el('span', { class: 'n', text: String(d.total) }))].concat(
        runs.length ? runs.map(function (r) { return card(r, d.now); }) : [el('div', { class: 'empty', text: 'No agent runs yet. Do on a Plan card starts one.' })])),
      pager(d.total));
    var spend = document.getElementById('spend');
    if (spend) spend.replaceChildren(
      el('div', { class: 'stat' }, el('b', { text: String(d.live) }), el('span', { text: 'live agents' })),
      el('div', { class: 'stat' }, el('b', { text: money(d.today_usd) }), el('span', { text: 'notional, last 24 h' })));
  }

  // The New run form: a task with no card.
  var form = document.getElementById('newform');
  if (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var hint = document.getElementById('newhint');
      var f = new FormData(form);
      var body = { task: String(f.get('task') || ''), model: String(f.get('model') || 'sonnet'), repo: String(f.get('repo') || '') || null };
      hint.textContent = 'starting…';
      post('api/build/runs', body).then(function (r) {
        hint.textContent = '';
        form.reset();
        toast('run #' + r.id + ' started on ' + r.model);
        return load();
      }).catch(function (e) { hint.textContent = e.message; });
    });
  }

  load();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  return Object.assign({ load: load }, pure);
});
