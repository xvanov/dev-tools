/* The Factory layer's page (served as /factory.js; server side in factory.js).
 *
 * Reads GET api/factory — the worker's stored `factory job list`, never a
 * factory call — whenever the live feed (events.client.js) says it changed,
 * and renders the jobs by group. Everything an
 * agent or another person wrote (titles, whys, reports) is set with
 * textContent; a report arrives as a parsed tree (dashboard/markdown.js).
 * URLs are relative so the page works under termhub's /pa/ proxy too.
 */
(function () {
  'use strict';

  var GROUPS = [
    ['needs_you', 'Needs you'],
    ['running', 'Running'],
    ['delivered', 'Delivered'],
    ['ended', 'Failed / cancelled'],
  ];
  var KIND = { code: 'code', research: 'research', report: 'report', plan: 'plan' };
  var RUNTIME = { api: 'API', claude_session: 'Claude session' };
  var data = null;
  var busyForm = false;

  // Board (default) or List, remembered per browser; a convenience, so storage may fail.
  function view() {
    try { return window.localStorage.getItem('pa.build.view') === 'list' ? 'list' : 'board'; } catch (e) { return 'board'; }
  }
  document.querySelectorAll('[data-view]').forEach(function (b) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view()));
    b.addEventListener('click', function () {
      try { window.localStorage.setItem('pa.build.view', b.getAttribute('data-view')); } catch (e) { /* not kept */ }
      document.querySelectorAll('[data-view]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      if (data) render();
    });
  });

  // This page's token (server.js issuePageToken): kept in memory only.
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
  function link(url, text) {
    return url && /^https?:\/\//.test(url) ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text) : null;
  }
  // A link inside Jarvis (a card in Plan, a session in Run): no new tab, so nav.js
  // switches destination and carries the #card-/#session= anchor along (plan E1).
  function inLink(url, text, title) {
    return url && (/^https?:\/\//.test(url) || /^\.\/#[A-Za-z0-9_.:=&%-]+$/.test(url)) ? el('a', { href: url, title: title || null }, text) : null;
  }
  function money(n) { return '$' + Number(n || 0).toFixed(2); }
  function ago(iso) {
    if (!iso) return '';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + 'm ago';
    if (s < 129600) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
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
  // A click shows it is working, then what happened, or why it failed.
  function clicker(button, fn) {
    button.addEventListener('click', function () {
      var label = button.textContent;
      button.disabled = true;
      button.textContent = label + '…';
      Promise.resolve().then(fn).then(function () { load(); }, function (err) {
        toast(label + ' failed: ' + err.message);
      }).then(function () {
        button.disabled = false;
        // A button may ask to be relabelled for the next click (Approve -> Approve with passkey).
        button.textContent = button.getAttribute('data-next-label') || label;
      });
    });
    return button;
  }

  // ---- the report sheet ---------------------------------------------------------
  function inline(kids) {
    return (kids || []).map(function (k) {
      if (k.t === 'text') return document.createTextNode(k.v);
      if (k.t === 'code') return el('code', { text: k.v });
      if (k.t === 'b') return el.apply(null, ['strong', {}].concat(inline(k.kids)));
      if (k.t === 'i') return el.apply(null, ['em', {}].concat(inline(k.kids)));
      if (k.t === 'ref') return document.createTextNode('#' + k.id);
      if (k.t === 'link' && /^https?:\/\//i.test(k.href)) return el.apply(null, ['a', { href: k.href, target: '_blank', rel: 'noopener noreferrer' }].concat(inline(k.kids)));
      if (k.t === 'link') return el.apply(null, ['span', {}].concat(inline(k.kids)));
      return document.createTextNode('');
    });
  }
  function markdown(blocks) {
    return el.apply(null, ['div', { class: 'md' }].concat((blocks || []).map(function (b) {
      if (b.t === 'h') return el.apply(null, ['h' + Math.min(6, b.level + 2), {}].concat(inline(b.kids)));
      if (b.t === 'p') return el.apply(null, ['p', {}].concat(inline(b.kids)));
      if (b.t === 'quote') return el.apply(null, ['blockquote', {}].concat(inline(b.kids)));
      if (b.t === 'pre') return el('pre', { text: b.text });
      if (b.t === 'hr') return el('hr');
      if (b.t === 'ul' || b.t === 'ol') {
        return el.apply(null, [b.t, {}].concat(b.items.map(function (it) {
          return el.apply(null, ['li', { class: 'd' + it.depth }].concat(inline(it.kids)));
        })));
      }
      return null;
    })));
  }
  var sheet = document.getElementById('sheet');
  function closeSheet() {
    sheet.hidden = true;
    if (held) { held = false; load(); }
  }
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
  function readReport(job) {
    document.getElementById('sheet-title').textContent = (job.report && job.report.title) || job.title;
    document.getElementById('sheet-meta').textContent = 'loading the report from the factory…';
    var body = document.getElementById('sheet-body');
    body.replaceChildren();
    sheet.hidden = false;
    return fetch('api/factory/report?job=' + encodeURIComponent(job.jobId), { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || r.statusText); return d; }); })
      .then(function (r) {
        document.getElementById('sheet-meta').textContent = r.none ? 'No report yet.' : job.jobId + (r.path ? ' · ' + r.path : '');
        body.replaceChildren(markdown(r.blocks));
      }, function (err) {
        document.getElementById('sheet-meta').textContent = 'Could not read it: ' + err.message;
      });
  }

  // ---- one job --------------------------------------------------------------------
  function chip(text, cls, title) { return el('span', { class: 'chip ' + (cls || ''), title: title || null, text: text }); }

  function storyLine(s) {
    var ci = s.ci && s.ci.state && s.ci.state !== 'none'
      ? chip('CI ' + s.ci.state + (s.ci.failing && s.ci.failing.length ? ': ' + s.ci.failing.join(', ') : ''), 'ci-' + s.ci.state)
      : null;
    return el('li', {}, el('span', { class: 'mono', text: 'story ' + s.id }), chip(s.state || '?'),
      s.prUrl ? link(s.prUrl, s.prNumber ? 'PR #' + s.prNumber : 'PR') : null,
      s.prState ? chip(s.prState) : null, ci);
  }

  // One agent step: its id (the factory's run id), story, and its live session in Run.
  function runLine(r) {
    return el('li', { 'data-step': r.id == null ? null : String(r.id) },
      chip(r.state, r.state === 'failed' ? 's-failed' : r.state === 'ok' ? 's-done' : ''),
      r.id != null ? el('span', { class: 'mono', text: 'step ' + r.id }) : null,
      r.storyId != null ? el('span', { class: 'mono', text: 'story ' + r.storyId }) : null,
      el('span', { text: [r.persona, RUNTIME[r.runtime] || r.runtime, r.model].filter(Boolean).join(' · ') }),
      el('span', { class: 'cost', text: money(r.costUsd) + (r.billing === 'subscription' ? ' sub-equiv' : '') }),
      r.session ? inLink(r.session.url, r.state === 'running' ? 'watch live' : 'session', 'This step\'s session in Run' + (r.session.machine ? ' on ' + r.session.machine : '')) : null);
  }

  // A job's buttons (Read report, Approve, Open in termhub, Cancel, back links): the
  // List view's card and the Board view's card (factory.board.client.js) both use them.
  function jobActions(j) {
    var actions = el('div', { class: 'actions' });
    if (j.report) actions.append(clicker(el('button', { class: 'primary', type: 'button', text: 'Read report' }), function () { return readReport(j); }));
    if (j.canApprove) {
      // With PA_PASSKEYS=on a merge or push to main needs a passkey tap first: the server then answers
      // {needsStepUp, approvalId}, this button becomes 'Approve with passkey', and its next click taps, then approves.
      var approveBtn = el('button', { class: 'primary', type: 'button', title: 'Run the approve-direction the factory named for this job', text: 'Approve' });
      var stepUpId = null;
      var approve = function () { return post('api/factory/jobs/' + encodeURIComponent(j.jobId) + '/approve').then(function () { toast(j.jobId + ' approved'); }); };
      actions.append(clicker(approveBtn, function () {
        if (stepUpId && window.paAuth) {
          return window.paAuth.stepUp(stepUpId).then(function () { stepUpId = null; approveBtn.removeAttribute('data-next-label'); return approve(); });
        }
        return approve().catch(function (err) {
          if (err.data && err.data.needsStepUp && window.paAuth) {
            stepUpId = err.data.approvalId;
            approveBtn.setAttribute('data-next-label', 'Approve with passkey');
            throw new Error('this needs your passkey: tap Approve with passkey');
          }
          throw err;
        });
      }));
    }
    actions.append(clicker(el('button', { type: 'button', title: 'Start a termhub session on the factory machine following this job', text: 'Open in termhub' }), function () {
      var tab = window.open('about:blank', '_blank');
      return post('api/factory/jobs/' + encodeURIComponent(j.jobId) + '/open').then(function (r) {
        if (tab && r.url) tab.location.href = r.url;
        else if (tab) tab.close();
        toast('following ' + j.jobId + ' in termhub');
      }, function (err) { if (tab) tab.close(); throw err; });
    }));
    if (j.canCancel) {
      actions.append(clicker(el('button', { class: 'danger', type: 'button', text: 'Cancel' }), function () {
        if (!window.confirm('Cancel ' + j.jobId + '? Its stories are parked; delivered work stays.')) return null;
        return post('api/factory/jobs/' + encodeURIComponent(j.jobId) + '/cancel').then(function (r) { toast(j.jobId + ': ' + (r.state || 'cancel sent')); });
      }));
    }
    // Back up the chain (plan E1): the card in Plan, and the PA run's own session in Run.
    if (j.paRun && j.paRun.card) actions.append(inLink('./#card-' + j.paRun.card, 'card #' + j.paRun.card, 'The card in Plan'));
    if (j.paRun) actions.append(j.paRun.url ? inLink(j.paRun.url, 'run #' + j.paRun.id, 'The run\'s follow session in Run') : chip('run #' + j.paRun.id, 'mono'));
    return actions;
  }

  function jobCard(j) {
    var actions = jobActions(j);
    var running = j.runs.filter(function (r) { return r.state === 'running'; });
    var others = j.runs.filter(function (r) { return r.state !== 'running'; });
    return el('div', { class: 'job ' + j.group, 'data-job': j.jobId },
      el('div', { class: 't', text: j.title }),
      el('div', { class: 'chips' },
        chip(j.jobId, 'mono'),
        chip(KIND[j.kind] || j.kind, 'k-' + j.kind),
        chip(RUNTIME[j.runtime] || j.runtime, 'r-' + j.runtime),
        j.app ? chip(j.app) : null,
        j.base ? chip(j.base.pr ? 'continues PR #' + j.base.pr : 'continues ' + j.base.branch, 'mono base',
          'Adds commits to ' + j.base.branch + (j.base.into ? ' (into ' + j.base.into + ')' : '') + '; opens no new PR') : null,
        j.waiting
          ? chip('waiting: ' + j.waiting, 's-needs_human', 'Nothing ticks this app, so the job stays ' + j.state.replace('_', ' ') + ' until it does')
          : chip(j.state.replace('_', ' '), 's-' + j.state),
        j.canApprove ? chip('waiting for your approval', 's-needs_human', 'Approve below, on Plan, or ask Jarvis') : null,
        j.ciFailing ? chip('CI failing', 'ci-failing') : null,
        j.delivery && j.kind === 'code' ? chip(j.delivery) : null,
        j.updatedAt ? chip(ago(j.updatedAt)) : null),
      j.why ? el('div', { class: 'why', text: j.why }) : null,
      j.stories.length ? el.apply(null, ['ul', { class: 'stories' }].concat(j.stories.slice(0, 6).map(storyLine))) : null,
      j.stories.length > 6 ? el('div', { class: 'meta', text: '… ' + (j.stories.length - 6) + ' more stories' }) : null,
      j.report ? el('div', { class: 'excerpt', title: j.report.words ? j.report.words + ' words' : null, text: j.report.excerpt || '(no excerpt)' }) : null,
      running.length ? el.apply(null, ['ul', { class: 'runs' }].concat(running.map(runLine))) : null,
      others.length ? el('details', { class: 'more' }, el('summary', { text: others.length + ' finished run' + (others.length === 1 ? '' : 's') }),
        el.apply(null, ['ul', { class: 'runs' }].concat(others.map(runLine)))) : null,
      el('div', { class: 'cost', text: money(j.costUsd) + ' metered' + (j.subscriptionEquivUsd ? ' · ' + money(j.subscriptionEquivUsd) + ' subscription-equivalent' : '') }),
      actions);
  }

  // ---- the page ---------------------------------------------------------------------
  function stat(value, label) { return el('div', { class: 'stat' }, el('b', { text: value }), el('span', { text: label })); }

  function render() {
    var board = document.getElementById('board');
    var updated = document.getElementById('updated');
    if (!data.enabled) {
      updated.textContent = 'The factory is not configured — set PA_FACTORY_PATH (and PA_FACTORY_MACHINE), see .env.example.';
      board.replaceChildren();
      document.getElementById('newjob').hidden = true;
      return;
    }
    updated.className = 'meta' + (data.error ? ' bad' : '');
    updated.textContent = data.polledAt
      ? 'jobs as of ' + ago(data.polledAt) + (data.machine ? ' · on ' + data.machine : '') + (data.error ? ' · the last list failed: ' + data.error : '')
      : 'no job list yet — the worker stores one every ' + data.pollSeconds + ' s' + (data.error ? ' (last error: ' + data.error + ')' : '');
    var s = data.spend;
    document.getElementById('spend').replaceChildren(
      stat(s.paToday == null ? '—' : money(s.paToday), 'PA model spend today' + (data.spendCap ? ' (cap ' + money(data.spendCap) + ')' : '')),
      stat(money(s.factoryToday.metered), 'factory metered, ' + s.factoryToday.jobs + ' job(s) touched today'),
      stat(money(s.factoryToday.subscriptionEquiv), 'subscription-equivalent today'),
      stat(money(s.factoryListed.metered), 'metered, all ' + s.factoryListed.jobs + ' listed jobs'));
    // Jarvis's "Waiting for your yes" card (permission.js) lives first in this
    // main; a re-render keeps it.
    var yes = document.getElementById('chatyes');
    // The Board view (plan 8.8.2, factory.board.client.js): progress, the steps on a
    // time axis and each step's turns in the page. The List view is the grouped list below.
    if (view() === 'board' && window.FactoryBoard) {
      board.classList.add('boardview');
      window.FactoryBoard.render(board, data, { actions: jobActions, keep: function () { return document.getElementById('chatyes'); } });
      fillForm();
      // #job=<id>&step=<n> (plan E1) opens that step's turns here.
      var hm = /^#job=([^&]+)&step=(\d+)$/.exec(location.hash || '');
      if (hm && focused !== location.hash) {
        focused = location.hash;
        var jid = decodeURIComponent(hm[1]);
        var all = Object.keys(data.groups || {}).reduce(function (a, k) { return a.concat(data.groups[k]); }, []);
        var job = all.filter(function (x) { return x.jobId === jid; })[0];
        var run = job && job.runs.filter(function (r) { return String(r.id) === hm[2]; })[0];
        if (run) window.FactoryBoard.viewer.open(job, run);
      }
      return;
    }
    board.classList.remove('boardview');
    board.replaceChildren.apply(board, GROUPS.map(function (g) {
      var list = data.groups[g[0]] || [];
      return el.apply(null, ['section', { class: g[0] },
        el('h2', {}, g[1], el('span', { class: 'n', text: String(list.length) }))]
        .concat(list.length ? list.map(jobCard) : [el('div', { class: 'empty', text: g[0] === 'needs_you' ? 'Nothing waits on you.' : 'None.' })]));
    }));
    if (yes) board.prepend(yes);
    fillForm();
    focusFromHash();
  }

  // #job=<id>[&step=<n>] (plan E1: Plan and Run link to a job, or one step of it):
  // that job brought into view and marked, its finished runs unfolded for the step.
  var focused = null;
  function focusFromHash(force) {
    var m = /^#job=([^&]+)(?:&step=([A-Za-z0-9_.-]+))?$/.exec(location.hash || '');
    if (!m || (!force && focused === location.hash)) return;
    var id;
    try { id = decodeURIComponent(m[1]); } catch (e) { return; }
    var card = null;
    document.querySelectorAll('.job[data-job]').forEach(function (n) { if (n.getAttribute('data-job') === id) card = n; });
    if (!card) return;
    focused = location.hash;
    document.querySelectorAll('.job.target, .runs li.target').forEach(function (n) { n.classList.remove('target'); });
    card.classList.add('target');
    var step = null;
    if (m[2]) card.querySelectorAll('.runs li[data-step]').forEach(function (n) { if (n.getAttribute('data-step') === m[2]) step = n; });
    if (step) {
      var fold = step.closest('details');
      if (fold) fold.open = true;
      step.classList.add('target');
    }
    (step || card).scrollIntoView({ block: 'center' });
  }
  window.addEventListener('hashchange', function () {
    if (view() === 'board' && data) render();
    else focusFromHash(true);
  });

  // ---- New job ----------------------------------------------------------------------
  var form = document.getElementById('newform');
  var filled = false;
  function options(select, list, value) {
    select.replaceChildren.apply(select, list.map(function (o) {
      var opt = el('option', { value: o.value, text: o.label });
      if (o.value === value) opt.selected = true;
      return opt;
    }));
  }
  function fillForm() {
    if (filled) return;
    filled = true;
    options(form.elements.kind, data.kinds || [], 'code');
    options(form.elements.runtime, data.runtimes || [], data.defaultRuntime || 'api');
    options(form.elements.delivery, [{ value: '', label: "the repo's default" }].concat((data.deliveries || []).map(function (d) {
      return { value: d.value, label: d.value + ' — ' + d.plain };
    })), '');
    fillRepos();
    kindChanged();
  }
  // Repo: the repos the factory knows (api/factory/apps), plus "Other…" for one it
  // does not yet — a code job to a new owner/name registers it.
  function fillRepos() {
    var sel = form.elements.repo;
    fetch('api/factory/apps', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); }).catch(function () { return {}; })
      .then(function (d) {
        var list = (d.apps || []).filter(function (a) { return a.repo; }).map(function (a) {
          return { value: a.repo, label: a.app + ' — ' + a.repo };
        });
        options(sel, [{ value: '', label: '— pick a repo —' }].concat(list, [{ value: '__other', label: 'Other…' }]), list.length === 1 ? list[0].value : '');
        repoChanged();
      });
  }
  function repoChanged() {
    var other = form.elements.repo.value === '__other';
    form.querySelector('[data-repo-other]').hidden = !other;
    form.elements.repoOther.required = other;
  }
  form.elements.repo.addEventListener('change', repoChanged);
  function kindChanged() {
    var code = form.elements.kind.value === 'code';
    form.querySelector('[data-code]').hidden = !code;
    form.elements.repo.required = code;
    document.getElementById('newhint').textContent = code
      ? 'Starts now on the factory; it delivers at the end state you pick.'
      : 'A ' + form.elements.kind.value + ' job changes nothing: the factory writes a report you read here.';
  }
  form.elements.kind.addEventListener('change', kindChanged);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busyForm) return;
    busyForm = true;
    var f = form.elements;
    var body = {
      title: f.title.value, ask: f.ask.value, kind: f.kind.value, runtime: f.runtime.value,
      repo: (f.repo.value === '__other' ? f.repoOther.value.trim() : f.repo.value) || null, delivery: f.kind.value === 'code' ? f.delivery.value || null : null, done: f.done.value,
    };
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    var send = function (b) {
      return post('api/factory/jobs', b).catch(function (err) {
        // Merging or pushing to main with no human step: confirm that level here.
        if (err.status === 409 && err.data && err.data.delivery && !b.confirmedLevel) {
          if (!window.confirm('End state: ' + err.data.delivery + ' — ' + err.data.plain + '\n\nNo human step after this. Start it?')) throw new Error('not started');
          return send(Object.assign({}, b, { confirmedLevel: err.data.delivery }));
        }
        throw err;
      });
    };
    send(body).then(function (r) {
      toast(r.submitUnknown ? 'run #' + r.id + ' sent; the factory\'s answer was lost — the worker matches it'
        : 'run #' + r.id + ' → factory job ' + r.jobId + ' (' + r.jobKind + ', ' + (RUNTIME[r.runtime] || r.runtime) + ')');
      form.reset();
      filled = false;
      fillForm();
      load();
    }, function (err) { toast('Start job failed: ' + err.message); }).then(function () {
      busyForm = false;
      button.disabled = false;
    });
  });

  function load() {
    return fetch('api/factory', { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || r.statusText); return d; }); })
      .then(function (d) { data = d; render(); }, function (err) {
        var u = document.getElementById('updated');
        u.className = 'meta bad';
        u.textContent = 'could not load: ' + err.message;
      });
  }
  load();
  // Live (dashboard/events.js): the worker's stored job list or a PA run
  // changing refetches the board; the feed polls every 5 min as a fallback.
  // An open report sheet holds the refetch until it is closed.
  var held = false;
  function live() {
    if (!sheet.hidden) { held = true; return; }
    load();
  }
  if (window.PAEvents) window.PAEvents.subscribe({ topics: ['factory', 'run'], onChange: live });
  else setInterval(function () { if (document.visibilityState === 'visible' && sheet.hidden) load(); }, 30000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') load(); });
})();
