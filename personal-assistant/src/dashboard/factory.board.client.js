/* Build's Board view (plan 8.8.2; served as /factory-board.js).
 *
 * The factory as a board: a strip with active/idle, spend today and over 7
 * days on both runtimes (a Claude Code run's cost is notional: what it would
 * cost at API prices; the subscription is not billed per run) and any runtime
 * paused at a provider limit; then one card per job with its progress (the
 * TUI's handler ratio), the persona at work, its state and why, the EBS ETA,
 * PR / CI / CodeRabbit, cost against its cap and one dot per step. A card
 * opens its trace: the steps on a time axis, one lane per persona (the layout
 * of the sssf visualizer). A step opens the run viewer: its turns in the page
 * (model text, each tool call with its arguments folded and its result,
 * diffs, gates, usage, the end), streaming while the step runs.
 *
 * Data: GET api/factory (the stored job list, factory.client.js) and GET
 * api/factory/board (`factory job board`); a step's turns from GET
 * api/factory/steps/<id>/events, read from a cursor and long-polled
 * (`wait`), so nothing is ever read twice. Agent-written text is set with
 * textContent only: no HTML sinks. URLs are relative (termhub's /pa/ proxy).
 *
 * The pure half (progress, ETA text, caps, CodeRabbit, the lanes, pairing a
 * tool call with its result) is required by test/factoryBoardView.test.js; the
 * browser gets window.FactoryBoard.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FactoryBoard = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RUNTIME = { api: 'API', claude_session: 'Claude' };
  var DONE_STORY = /^(delivered_|deployed|deploy_pending|ready_for_merge|ci_green|pr_open|ci_pending|closed_by_operator|superseded_by_sibling)/;

  // ---- the pure half ------------------------------------------------------------

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }

  /** Seconds as "45s", "12m", "1h 05m", "2d 3h". */
  function dur(s) {
    s = Math.max(0, Math.round(num(s)));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) { var m = Math.round((s % 3600) / 60); return Math.floor(s / 3600) + 'h ' + (m < 10 ? '0' : '') + m + 'm'; }
    return Math.floor(s / 86400) + 'd ' + Math.round((s % 86400) / 3600) + 'h';
  }

  /** The board's direction for a job (code jobs in flight), or null. */
  function directionOf(snap, jobId) {
    var dirs = (snap && snap.directions) || [];
    for (var i = 0; i < dirs.length; i++) if (dirs[i].job_id === jobId) return dirs[i];
    return null;
  }

  /**
   * 0..1 or null. A direction in flight: the TUI's ratio (handlers done over
   * all handlers). Otherwise from the job: done is 1; a job with stories,
   * the share past delivery; a running task job is unknown (null).
   */
  function progressOf(job, dir) {
    if (dir && dir.progress != null) return Math.max(0, Math.min(1, num(dir.progress)));
    if (job.state === 'done') return 1;
    var st = job.stories || [];
    if (st.length) return st.filter(function (s) { return DONE_STORY.test(s.state || ''); }).length / st.length;
    return null;
  }

  /** "P50 12m · P75 20m · P95 45m", or why there is none. */
  function etaText(eta) {
    if (!eta) return null;
    if (eta.insufficient) return 'ETA: ' + (eta.reason || 'not enough history yet');
    return 'P50 ' + dur(eta.p50_s) + ' · P75 ' + dur(eta.p75_s) + ' · P95 ' + dur(eta.p95_s);
  }

  /**
   * Cost against the job's budget cap: the factory counts metered spend plus
   * each Claude Code run's notional cost (JOBS-API v1.9), so does this.
   */
  function capLine(job) {
    var caps = job.caps;
    var spent = caps && caps.used ? num(caps.used.spendUsd) : num(job.costUsd) + num(job.subscriptionEquivUsd);
    var budget = caps && caps.budgetUsd ? num(caps.budgetUsd) : null;
    return {
      spent: Math.round(spent * 100) / 100,
      metered: Math.round(num(job.costUsd) * 100) / 100,
      notional: Math.round(num(job.subscriptionEquivUsd) * 100) / 100,
      budget: budget,
      ratio: budget ? Math.min(1, spent / budget) : null,
      rounds: caps && caps.used ? num(caps.used.rounds) : null,
      maxRounds: caps ? caps.maxRounds : null,
    };
  }

  /**
   * CodeRabbit on the job's open PRs, from the CI rollup's check names:
   * failing | pending | ignored | null (not named: passed, or not installed;
   * the rollup lists only the checks that are not green).
   */
  function coderabbit(job) {
    var order = { failing: 3, pending: 2, ignored: 1 };
    var best = null;
    (job.stories || []).forEach(function (s) {
      var ci = s.ci;
      if (!ci) return;
      [['failing', ci.failing], ['pending', ci.pending], ['ignored', ci.ignored]].forEach(function (p) {
        if ((p[1] || []).some(function (n) { return /coderabbit/i.test(String(n)); }) && (!best || order[p[0]] > order[best])) best = p[0];
      });
    });
    return best;
  }

  /** The persona at work on a job now (the board's live heartbeats), or null. */
  function liveOf(snap, job) {
    var live = (snap && snap.live) || [];
    var storyIds = (job.stories || []).map(function (s) { return s.id; });
    for (var i = 0; i < live.length; i++) {
      var h = live[i];
      if (h.job_id === job.jobId || (h.story_id != null && storyIds.indexOf(h.story_id) >= 0)) return h;
    }
    var running = (job.runs || []).filter(function (r) { return r.state === 'running'; })[0];
    return running ? { persona: running.persona, story_id: running.storyId, elapsed_s: running.startedAt ? (Date.now() - Date.parse(running.startedAt)) / 1000 : null } : null;
  }

  /**
   * The trace: a job's steps on one time axis, one lane per persona (first
   * seen first). Each block's left and width are % of the axis; a running
   * step runs to `now`.
   */
  function lanes(runs, now) {
    now = now == null ? Date.now() : now;
    var steps = (runs || []).filter(function (r) { return r.startedAt && Number.isFinite(Date.parse(r.startedAt)); })
      .map(function (r) {
        var t0 = Date.parse(r.startedAt);
        var t1 = r.endedAt && Number.isFinite(Date.parse(r.endedAt)) ? Date.parse(r.endedAt) : (r.state === 'running' ? now : t0);
        return { run: r, t0: t0, t1: Math.max(t0, t1) };
      })
      .sort(function (a, b) { return a.t0 - b.t0; });
    if (!steps.length) return { t0: null, t1: null, lanes: [] };
    var t0 = steps[0].t0;
    var t1 = Math.max.apply(null, steps.map(function (s) { return s.t1; }));
    var span = Math.max(1000, t1 - t0);
    var byName = {};
    var out = [];
    steps.forEach(function (s) {
      var name = s.run.persona || 'step';
      if (!byName[name]) { byName[name] = { name: name, blocks: [] }; out.push(byName[name]); }
      var left = ((s.t0 - t0) / span) * 100;
      byName[name].blocks.push({
        id: s.run.id, state: s.run.state, storyId: s.run.storyId, runtime: s.run.runtime,
        left: Math.round(left * 100) / 100,
        width: Math.round(Math.max(0.8, Math.min(100 - left, ((s.t1 - s.t0) / span) * 100)) * 100) / 100,
        seconds: (s.t1 - s.t0) / 1000,
      });
    });
    return { t0: t0, t1: t1, lanes: out };
  }

  /**
   * Turns for display: a tool call and its result become one `tool` item (an
   * api result names its call by tool_use_id; a Claude one too); everything
   * else stays as is. `byCall` lets a result that arrives later find its call.
   */
  function pairTurns(events, byCall) {
    byCall = byCall || {};
    var out = [];
    (events || []).forEach(function (e) {
      if (e.kind === 'tool_call') {
        var item = { kind: 'tool', call: e, result: null };
        if (e.id) byCall[e.id] = item;
        out.push(item);
      } else if (e.kind === 'tool_result' && e.tool_use_id && byCall[e.tool_use_id] && !byCall[e.tool_use_id].result) {
        byCall[e.tool_use_id].result = e;
        out.push({ kind: 'attach', to: byCall[e.tool_use_id], result: e });
      } else {
        out.push(e);
      }
    });
    return out;
  }

  /** One line for a tool call's arguments: the most telling value, short. */
  function argSummary(input) {
    var obj = null;
    try { obj = JSON.parse(input || '{}'); } catch (e) { return String(input || '').slice(0, 120); }
    if (!obj || typeof obj !== 'object') return String(obj).slice(0, 120);
    var keys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];
    for (var i = 0; i < keys.length; i++) if (obj[keys[i]] != null) return String(obj[keys[i]]).replace(/\s+/g, ' ').slice(0, 140);
    var k = Object.keys(obj)[0];
    return k ? (k + ': ' + JSON.stringify(obj[k])).slice(0, 140) : '';
  }

  /** Job ids worth a timeline refresh: any not terminal. */
  function anyLive(jobs) {
    return (jobs || []).some(function (j) { return !j.terminal; });
  }

  var core = { dur: dur, directionOf: directionOf, progressOf: progressOf, etaText: etaText, capLine: capLine,
    coderabbit: coderabbit, liveOf: liveOf, lanes: lanes, pairTurns: pairTurns, argSummary: argSummary, anyLive: anyLive };
  if (typeof document === 'undefined') return core;

  // ---- the page ------------------------------------------------------------------

  function el(tag, props) {
    var n = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      if (k === 'class') n.className = p[k];
      else if (k === 'text') n.textContent = p[k];
      else if (k === 'style') n.setAttribute('style', p[k]);
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
  function money(n) { return '$' + num(n).toFixed(2); }
  function clock(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var today = new Date().toDateString() === d.toDateString();
    return (today ? '' : d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function getJson(url, signal) {
    return fetch(url, { cache: 'no-store', signal: signal }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw Object.assign(new Error(d.message || d.error || r.statusText), { status: r.status });
        return d;
      });
    });
  }

  var snap = null;
  var snapAt = 0;
  var snapError = null;
  var loading = null;
  var last = null; // {container, data, opts}
  var open = {}; // jobId -> true: its trace is unfolded
  var timer = null;

  function refresh(force) {
    if (loading || (!force && Date.now() - snapAt < 2000)) return;
    loading = getJson('api/factory/board').then(function (d) {
      snap = d; snapAt = Date.now(); snapError = d.error || null;
    }, function (err) { snapError = err.message; snapAt = Date.now(); }).then(function () {
      loading = null;
      if (last && last.container.isConnected) draw();
    });
  }

  // The snapshot changes with the factory's own state (a persona starting, an
  // ETA moving) as well as with job states, which is all the live feed carries.
  // So while a job is live and the page is seen, it is re-read every 10 s; the
  // feed's events re-read it at once.
  function pace() {
    clearInterval(timer);
    timer = null;
    if (last && anyLive(last.data.jobs)) {
      timer = setInterval(function () {
        if (document.visibilityState === 'visible' && last && last.container.isConnected) refresh(true);
      }, 10000);
    }
  }

  function strip() {
    var s = snap || {};
    var sp = s.spend;
    var bits = [
      chip(s.active ? 'active' : 'idle', s.active ? 's-done' : '', s.mode && s.mode !== 'normal' ? 'mode ' + s.mode : null),
      s.mode && s.mode !== 'normal' ? chip('mode: ' + s.mode, 's-blocked') : null,
    ];
    var spend = sp ? el('div', { class: 'bstats' },
      el('div', { class: 'stat' }, el('b', { text: money(sp.today.metered_usd) }), el('span', { text: 'metered today (API keys)' + (s.spend_cap_usd ? ' · cap ' + money(s.spend_cap_usd) : '') })),
      el('div', { class: 'stat' }, el('b', { text: money(sp.today.notional_usd) }), el('span', { text: 'Claude today: notional, not billed' })),
      el('div', { class: 'stat' }, el('b', { text: money(sp.week.metered_usd) }), el('span', { text: 'metered, 7 days' })),
      el('div', { class: 'stat' }, el('b', { text: money(sp.week.notional_usd) }), el('span', { text: 'Claude, 7 days: notional' }))) : null;
    var paused = (s.paused || []).map(function (p) {
      return chip((RUNTIME[p.runtime] || p.runtime) + ' paused' + (p.until ? ' until ' + clock(p.until) : ''), 's-needs_human',
        (p.why || '') + (p.reset_known ? '' : ' (reset time not given: backing off)'));
    });
    return el('section', { class: 'bstrip' },
      el.apply(null, ['div', { class: 'chips' }].concat(bits, paused,
        snapError ? [chip('board: ' + snapError, 's-failed')] : [],
        s.as_of ? [chip('as of ' + clock(s.as_of))] : [])),
      spend);
  }

  var STILL = ['cancelled', 'failed', 'done', 'needs_human', 'delivered'];
  function still(job) {
    return Boolean(job.terminal) || STILL.indexOf(job.state) >= 0 || job.group === 'ended' || job.group === 'delivered';
  }
  function bar(ratio, cls, isStill) {
    var b = el('div', { class: 'pbar ' + (cls || '') });
    var fill = el('span');
    fill.style.width = ratio == null ? (isStill ? '100%' : '0%') : Math.max(2, Math.round(ratio * 100)) + '%';
    if (ratio == null && !isStill) b.classList.add('unknown');
    else if (ratio == null) b.classList.add('still');
    b.append(fill);
    return b;
  }

  function dots(job) {
    var runs = (job.runs || []).slice().reverse();
    return el.apply(null, ['span', { class: 'dots', title: runs.length + ' step(s)' }].concat(runs.slice(-24).map(function (r) {
      return el('button', { type: 'button', class: 'dot ' + r.state, title: 'step ' + r.id + ' · ' + (r.persona || '') + ' · ' + r.state,
        onclick: function (e) { e.stopPropagation(); viewer.open(job, r); } });
    })));
  }

  function card(job, opts) {
    var dir = directionOf(snap, job.jobId);
    var p = progressOf(job, dir);
    var live = liveOf(snap, job);
    var eta = dir ? etaText(dir.eta) : null;
    var cap = capLine(job);
    var cr = coderabbit(job);
    var prs = (job.stories || []).filter(function (s) { return s.prUrl; });
    var head = el('div', { class: 'bhead' },
      el('div', { class: 't', text: job.title }),
      el('div', { class: 'chips' },
        chip(job.jobId, 'mono'),
        chip(job.kind, 'k-' + job.kind),
        chip(RUNTIME[job.runtime] || job.runtime, 'r-' + job.runtime),
        chip(job.paused ? 'paused' : job.state.replace('_', ' '), job.paused ? 's-needs_human' : 's-' + job.state),
        job.canApprove ? chip('waiting for your approval', 's-needs_human') : null,
        job.failover ? chip('moved ' + job.failover.from + ' → ' + job.failover.to, 's-blocked', job.failover.why) : null));
    var progress = el('div', { class: 'bprog' },
      bar(p, job.group, still(job)),
      el('span', { class: 'mono', text: p == null ? (still(job) ? '' : 'running') : Math.round(p * 100) + '%' }),
      dir ? el('span', { class: 'meta', text: dir.completed_stories + '/' + dir.total_stories + ' stories · ' + dir.completed_handlers + '/' + dir.total_handlers + ' handlers' }) : null);
    var now = live && live.persona ? el('div', { class: 'bnow' },
      el('span', { class: 'pulse' }), el('b', { text: live.persona }),
      el('span', { text: (live.story_id != null ? ' on story ' + live.story_id : '') + (live.elapsed_s != null ? ' · ' + dur(live.elapsed_s) : '') })) : null;
    var why = job.paused ? (job.paused.why || 'paused at a provider limit') : job.why;
    var delivery = prs.length || cr ? el.apply(null, ['div', { class: 'chips' }].concat(prs.slice(0, 4).map(function (s) {
      return el('a', { href: s.prUrl, target: '_blank', rel: 'noopener noreferrer', class: 'chip', text: (s.prNumber ? 'PR #' + s.prNumber : 'PR') + (s.prState ? ' ' + s.prState : '') });
    }), prs.map(function (s) {
      return s.ci && s.ci.state && s.ci.state !== 'none' ? chip('CI ' + s.ci.state, 'ci-' + s.ci.state, (s.ci.failing || []).join(', ') || null) : null;
    }), [cr ? chip('CodeRabbit ' + cr, cr === 'failing' ? 'ci-failing' : '') : (prs.length ? chip('CodeRabbit —', '', 'not among the checks still running or failing: passed, or not installed on this repo') : null)])) : null;
    var costs = el('div', { class: 'bcost' },
      cap.budget ? bar(cap.ratio, cap.ratio >= 0.8 ? 'warn' : '') : null,
      el('span', { class: 'mono', text: money(cap.spent) + (cap.budget ? ' of ' + money(cap.budget) : '') + ' · ' + money(cap.metered) + ' metered' + (cap.notional ? ' + ' + money(cap.notional) + ' Claude notional' : '') + (cap.maxRounds ? ' · rounds ' + cap.rounds + '/' + cap.maxRounds : '') }));
    var node = el('div', { class: 'bcard ' + job.group + (open[job.jobId] ? ' open' : ''), 'data-job': job.jobId },
      head, progress, now,
      why ? el('div', { class: 'why', text: why }) : null,
      eta ? el('div', { class: 'meta', text: eta }) : null,
      delivery, costs,
      el('div', { class: 'brow' }, dots(job),
        el('button', { type: 'button', class: 'linkish', text: open[job.jobId] ? 'hide steps' : 'steps (' + (job.runs || []).length + ')',
          onclick: function () { open[job.jobId] = !open[job.jobId]; draw(); } })),
      open[job.jobId] ? trace(job) : null,
      opts.actions ? opts.actions(job) : null);
    return node;
  }

  // The trace: the job's steps on one time axis, a lane per persona.
  function trace(job) {
    var L = lanes(job.runs, Date.now());
    if (!L.lanes.length) return el('div', { class: 'meta', text: 'No steps yet.' });
    var rows = L.lanes.map(function (lane) {
      var track = el('div', { class: 'track' });
      lane.blocks.forEach(function (b) {
        var r = (job.runs || []).filter(function (x) { return x.id === b.id; })[0];
        var blk = el('button', { type: 'button', class: 'blk ' + b.state + (viewer.stepId === b.id ? ' sel' : ''),
          title: 'step ' + b.id + (b.storyId != null ? ' · story ' + b.storyId : '') + ' · ' + (RUNTIME[b.runtime] || b.runtime || '') + ' · ' + dur(b.seconds) + ' · ' + b.state,
          onclick: function () { viewer.open(job, r); } }, el('span', { text: dur(b.seconds) }));
        blk.style.left = b.left + '%';
        blk.style.width = b.width + '%';
        track.append(blk);
      });
      return el('div', { class: 'lane' }, el('div', { class: 'lname', text: lane.name }), track);
    });
    return el.apply(null, ['div', { class: 'trace' },
      el('div', { class: 'axis meta', text: clock(new Date(L.t0).toISOString()) + ' → ' + clock(new Date(L.t1).toISOString()) + ' (' + dur((L.t1 - L.t0) / 1000) + ')' })].concat(rows));
  }

  function recentPanel() {
    var s = snap || {};
    var allRuns = s.recent_runs || [];
    var pg = pager('steps', allRuns.length, draw);
    var runs = allRuns.slice((page.steps - 1) * PAGE, page.steps * PAGE);
    var vel = s.velocity || [];
    return el('section', { class: 'brecent' },
      el('h2', { text: 'Recent steps' }),
      runs.length ? el.apply(null, ['ul', { class: 'runs' }].concat(runs.map(function (r) {
        return el('li', {},
          chip(r.state, r.state === 'failed' ? 's-failed' : r.state === 'ok' ? 's-done' : ''),
          el('button', { type: 'button', class: 'linkish mono', text: 'step ' + r.id, disabled: r.viewable ? null : 'disabled',
            title: r.viewable ? 'Show this step\'s turns' : 'This step has no turn stream',
            onclick: function () { viewer.open({ jobId: r.job_id, title: r.job_id || '' }, { id: r.id, persona: r.persona, runtime: r.runtime, model: r.model, state: r.state, session: r.session, viewable: r.viewable }); } }),
          el('span', { text: [r.persona, RUNTIME[r.runtime] || r.runtime, r.job_id].filter(Boolean).join(' · ') }),
          el('span', { class: 'cost', text: r.runtime === 'claude_session' ? money(r.subscription_equiv_usd) + ' notional' : money(r.cost_usd) }),
          r.duration_s ? el('span', { class: 'meta', text: dur(r.duration_s) }) : null);
      }))) : el('div', { class: 'empty', text: 'No steps yet.' }),
      pg,
      vel.length ? el('h2', { text: 'Velocity (estimate ÷ actual, 30 days)' }) : null,
      vel.length ? el.apply(null, ['ul', { class: 'runs' }].concat(vel.map(function (v) {
        return el('li', {}, el('b', { text: v.persona }), el('span', { class: 'meta', text: v.model_tier }),
          el('span', { class: 'mono', text: '×' + v.median + ' (P25 ×' + v.p25 + ', P75 ×' + v.p75 + ') · n=' + v.samples }));
      }))) : null);
  }

  var PAGE = 10;
  var page = { jobs: 1, steps: 1 };
  function pager(key, total, redo) {
    var pages = Math.max(1, Math.ceil(total / PAGE));
    if (page[key] > pages) page[key] = pages;
    if (pages < 2) return null;
    function go(n) { return function () { page[key] = n; redo(); }; }
    var cur = page[key];
    var kids = [el('button', { type: 'button', class: 'linkish', text: 'Prev', disabled: cur > 1 ? null : 'disabled', onclick: go(cur - 1) })];
    var last = 0;
    for (var n = 1; n <= pages; n++) {
      if (n !== 1 && n !== pages && Math.abs(n - cur) > 1) continue;
      if (last && n - last > 1) kids.push(el('span', { class: 'meta', text: '…' }));
      kids.push(el('button', { type: 'button', class: 'linkish' + (n === cur ? ' cur' : ''), text: String(n), 'aria-current': n === cur ? 'page' : null,
        'aria-pressed': String(n === cur), onclick: go(n) }));
      last = n;
    }
    kids.push(el('button', { type: 'button', class: 'linkish', text: 'Next', disabled: cur < pages ? null : 'disabled', onclick: go(cur + 1) }));
    return el.apply(null, ['nav', { class: 'bpager', 'aria-label': 'Pages' }].concat(kids));
  }

  function draw() {
    if (!last) return;
    var c = last.container;
    var jobs = (last.data.groups ? Object.keys(last.data.groups).reduce(function (a, k) { return a.concat(last.data.groups[k]); }, []) : []);
    var rank = { needs_you: 0, running: 1, delivered: 2, ended: 3 };
    jobs.sort(function (a, b) { return (rank[a.group] - rank[b.group]) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    last.data.jobs = jobs;
    var keep = last.opts.keep ? last.opts.keep() : null;
    var pg = pager('jobs', jobs.length, draw);
    var shown = jobs.slice((page.jobs - 1) * PAGE, page.jobs * PAGE);
    c.replaceChildren(el('div', { class: 'btop' }, strip(), recentPanel()),
      el.apply(null, ['section', { class: 'bcards' }].concat(shown.length ? shown.map(function (j) { return card(j, last.opts); }) : [el('div', { class: 'empty', text: 'No jobs.' })])),
      pg);
    if (keep) c.prepend(keep);
    pace();
  }

  /** factory.client.js calls this with the stored job list on every (re)load. */
  function render(container, data, opts) {
    last = { container: container, data: data, opts: opts || {} };
    draw();
    refresh(false);
  }

  // ---- the run viewer: one step's turns, streaming --------------------------------

  var viewer = (function () {
    var pane = null;
    var list = null;
    var head = null;
    var state = null; // {stepId, cursor, abort, done, byCall, nodes}

    function build() {
      if (pane) return;
      head = el('div', { class: 'vhead' });
      list = el('div', { class: 'vlist' });
      pane = el('aside', { class: 'fviewer', hidden: 'hidden', 'aria-label': 'Step viewer' },
        el('div', { class: 'vbar' }, el('b', { text: 'Step' }), el('button', { type: 'button', text: 'Close', onclick: close })), head, list);
      document.body.append(pane);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pane && !pane.hidden) close(); });
    }

    function close() {
      if (state && state.abort) state.abort.abort();
      state = null;
      api.stepId = null;
      if (pane) pane.hidden = true;
      document.body.classList.remove('viewing');
    }

    function header(step, job) {
      var s = step || {};
      var notional = s.runtime === 'claude_session';
      head.replaceChildren(
        el('div', { class: 't', text: (job && job.title) || s.job_id || '' }),
        el('div', { class: 'chips' },
          chip('step ' + s.id, 'mono'),
          s.story_id != null ? chip('story ' + s.story_id, 'mono') : null,
          s.persona ? chip(s.persona) : null,
          chip(RUNTIME[s.runtime] || s.runtime || '?', 'r-' + s.runtime),
          s.model ? chip(s.model, 'mono') : null,
          s.state ? chip(s.state, s.state === 'failed' ? 's-failed' : s.state === 'ok' ? 's-done' : 's-running') : null),
        el('div', { class: 'cost', text: (s.tokens_in || s.tokens_out ? (s.tokens_in || 0) + ' in / ' + (s.tokens_out || 0) + ' out · ' : '') +
          (notional ? money(s.subscription_equiv_usd) + ' notional (Claude subscription, not billed)' : money(s.cost_usd) + ' metered') +
          (s.duration_s ? ' · ' + dur(s.duration_s) : '') }),
        s.error ? el('div', { class: 'why', text: s.error }) : null,
        s.session && s.session.url && /^https?:\/\//.test(s.session.url)
          ? el('div', { class: 'actions' }, el('a', { href: s.session.url, title: 'This step\'s terminal in Run', text: 'Open in termhub' })) : null);
    }

    function pre(text, full, ev) {
      var p = el('pre', { class: 'vtext', text: text || '' });
      if (!full) return p;
      var more = el('button', { type: 'button', class: 'linkish', text: 'show all (' + full + ' chars)' });
      more.addEventListener('click', function () {
        more.disabled = true;
        getJson('api/factory/steps/' + state.stepId + '/events?at=' + encodeURIComponent(ev.at)).then(function (d) {
          var match = (d.events || []).filter(function (x) { return x.kind === ev.kind; })[0] || (d.events || [])[0];
          if (match) { p.textContent = ev.kind === 'tool_call' ? match.input : match.text; more.remove(); }
        }, function (err) { more.textContent = 'could not read it: ' + err.message; });
      });
      return el('div', {}, p, more);
    }

    function node(item) {
      var k = item.kind;
      if (k === 'tool') {
        var c = item.call;
        var det = el('details', { class: 'vtool' },
          el('summary', {}, el('span', { class: 'tname', text: c.name }), el('span', { class: 'targ', text: argSummary(c.input) }), el('span', { class: 'tres pending', text: '…' })),
          el('div', { class: 'vlabel', text: 'arguments' }), pre(c.input, c.full_len, c));
        item.dom = det;
        if (item.result) attach(item, item.result);
        return det;
      }
      if (k === 'attach') { attach(item.to, item.result); return null; }
      if (k === 'text') return el('div', { class: 'vturn' }, pre(item.text, item.full_len, item));
      if (k === 'thinking') return el('details', { class: 'vthink' }, el('summary', { text: 'thinking' }), pre(item.text, item.full_len, item));
      if (k === 'prompt') return el('details', { class: 'vprompt' }, el('summary', { text: 'prompt' + (item.source ? ' (' + item.source + ')' : '') }), pre(item.text, item.full_len, item));
      if (k === 'tool_result') return el('div', { class: 'vtool orphan' + (item.is_error ? ' err' : '') }, el('div', { class: 'vlabel', text: (item.is_error ? '✗ ' : '✓ ') + (item.name || 'result') }), pre(item.text, item.full_len, item));
      if (k === 'init') return el('div', { class: 'vmeta', text: '── ' + (item.runtime === 'api' ? 'API run' : 'Claude Code session') + ' ' + (item.session_id || '') + (item.model ? ' · ' + item.model : '') + (item.cwd ? ' · ' + item.cwd : '') });
      if (k === 'usage') return el('div', { class: 'vmeta', text: '· ' + item.tokens_in + ' in (' + item.cached_input_tokens + ' cached) / ' + item.tokens_out + ' out · ' + money(item.cost_usd) });
      if (k === 'diff') {
        var files = (item.files || []).map(function (f) { return el('li', {}, el('span', { class: 'mono', text: f.path }), el('span', { class: 'add', text: ' +' + f.added }), el('span', { class: 'del', text: ' -' + f.deleted })); })
          .concat((item.untracked || []).map(function (p) { return el('li', {}, el('span', { class: 'mono', text: p }), el('span', { class: 'add', text: ' new' })); }));
        return el('details', { class: 'vdiff' }, el('summary', { text: '± ' + (item.files || []).length + ' changed, ' + (item.untracked || []).length + ' new, +' + item.insertions + '/-' + item.deletions }),
          files.length ? el.apply(null, ['ul', {}].concat(files)) : el('div', { class: 'meta', text: 'no changes vs HEAD' }));
      }
      if (k === 'gate') return el('div', { class: 'vgate ' + (item.passed ? 'pass' : 'fail') }, el('b', { text: 'gate round ' + (item.round == null ? '?' : item.round) + ': ' + (item.passed ? 'PASS' : 'FAIL') }),
        item.checks && item.checks.length ? el('span', { class: 'mono', text: ' [' + item.checks.join(', ') + ']' }) : null, item.reason ? el('div', { text: item.reason }) : null);
      if (k === 'error') return el('div', { class: 'vgate fail' }, el('b', { text: 'error ' + (item.code || '') }), el('div', { text: item.text }));
      if (k === 'note') return el('div', { class: 'vmeta', text: '── ' + item.text });
      if (k === 'result') return el('div', { class: 'vresult ' + (item.ok ? 'pass' : 'fail') },
        el('b', { text: (item.ok ? 'done' : 'ended: ' + (item.subtype || 'error')) + (item.stop_reason ? ' (' + item.stop_reason + ')' : '') }),
        el('span', { class: 'mono', text: ' · ' + item.turns + ' turns · ' + item.tokens_in + ' in / ' + item.tokens_out + ' out · ' + money(item.cost_usd) + (item.billing === 'notional' ? ' notional' : ' metered') + (item.duration_ms ? ' · ' + dur(item.duration_ms / 1000) : '') }),
        item.text && !item.ok ? el('div', { text: item.text }) : null);
      return null;
    }

    function attach(item, res) {
      if (!item.dom) return;
      var mark = item.dom.querySelector('.tres');
      mark.className = 'tres ' + (res.is_error ? 'err' : 'ok');
      mark.textContent = res.is_error ? '✗' : '✓';
      if (res.is_error) item.dom.classList.add('err');
      item.dom.append(el('div', { class: 'vlabel', text: 'result' }), pre(res.text, res.full_len, res));
    }

    function append(events) {
      var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      pairTurns(events, state.byCall).forEach(function (item) {
        var n = node(item);
        if (n) list.append(n);
      });
      if (atBottom) list.scrollTop = list.scrollHeight;
    }

    function pump(my) {
      if (state !== my) return;
      var running = !my.done;
      var url = 'api/factory/steps/' + my.stepId + '/events?limit=300' + (my.cursor ? '&cursor=' + encodeURIComponent(my.cursor) : '') + (my.started && running ? '&wait=15' : '');
      my.started = true;
      getJson(url, my.abort.signal).then(function (d) {
        if (state !== my) return;
        header(d.step, my.job);
        if (!d.has_stream && !my.cursor) list.replaceChildren(el('div', { class: 'empty', text: 'This step has no turn stream (it ran before Build could show turns, or never reached a model). Its terminal, if any, is linked above.' }));
        my.cursor = d.cursor;
        append(d.events || []);
        my.done = Boolean(d.done);
        if (d.more || !d.done) pump(my);
        else list.append(el('div', { class: 'vmeta', text: '── end of the step' }));
      }, function (err) {
        if (state !== my || err.name === 'AbortError') return;
        // A refusal (no such step, a bad cursor) will not change: stop. Anything else retries.
        var final = err.status >= 400 && err.status < 500;
        list.append(el('div', { class: 'vgate fail', text: 'could not read the step: ' + err.message + (final ? '' : ' (retrying)') }));
        if (!final) setTimeout(function () { pump(my); }, 3000);
      });
    }

    var api = {
      stepId: null,
      open: function (job, run) {
        if (!run || run.id == null) return;
        build();
        if (state && state.abort) state.abort.abort();
        state = { stepId: run.id, job: job, cursor: null, done: false, byCall: {}, abort: new AbortController() };
        api.stepId = run.id;
        header({ id: run.id, persona: run.persona, runtime: run.runtime, model: run.model, state: run.state, session: run.session, story_id: run.storyId }, job);
        list.replaceChildren();
        pane.hidden = false;
        document.body.classList.add('viewing');
        pump(state);
        if (last) draw();
      },
      close: close,
    };
    return api;
  })();

  core.render = render;
  core.resetPage = function () { page.jobs = 1; page.steps = 1; };
  core.refresh = refresh;
  core.viewer = viewer;
  return core;
});
