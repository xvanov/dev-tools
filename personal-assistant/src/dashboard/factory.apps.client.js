/* The Build page's Repos section (served as /factory-apps.js; server side in
 * factoryApps.ts).
 *
 * Lists the repos registered with the factory and their gate readiness from the
 * PA's cached `factory app list` (instant), then refreshes it from the factory
 * behind the render. "Add repo" registers one (`factory app add`) and opens its
 * editor; the editor sets delivery, pipeline, the solo review default and the
 * per-job caps (JOBS-API v1.9), and each gate — a command, `none`
 * (the repo has no such check: skipped) or not configured — plus the programs a
 * gate needs on PATH (`factory app set`). Suggested gates (detection, including
 * the repo's CI workflows) are prefilled for gates that are not configured, and
 * only saved when you press Save.
 *
 * Text that came from a repo or the factory is set with textContent; URLs are
 * relative so the page works under termhub's /pa/ proxy too.
 */
(function () {
  'use strict';

  var GATE_LABEL = { lint: 'Lint', format_check: 'Format check', type_check: 'Type check', test: 'Test' };
  var STATUS_LABEL = { configured: 'configured', not_configured: 'not configured', missing_tool: 'missing tool' };
  var REVIEW_LABEL = {
    auto: 'auto — only when nothing human gates the merge (auto-merge, push to main)',
    on: 'on — every solo job',
    off: 'off — no review',
  };
  var CAP_LABEL = { budget_usd: 'Budget per job ($)', wall_clock_h: 'Wall clock per job (h)', max_rounds: 'Agent rounds per job' };
  var state = { apps: [], deliveries: [], pipelines: ['chain', 'solo', 'auto'], gates: ['lint', 'format_check', 'type_check', 'test'], enabled: true };
  var editing = null; // app name in the sheet

  function el(tag, props) {
    var n = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      if (k === 'class') n.className = p[k];
      else if (k === 'text') n.textContent = p[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), p[k]);
      else if (p[k] != null && p[k] !== false) n.setAttribute(k, p[k] === true ? '' : p[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      n.append(kid);
    }
    return n;
  }
  function toast(text) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove('show'); }, 6000);
  }
  function getJson(path) {
    return fetch(path, { headers: { Accept: 'application/json' } }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) throw new Error(d.error || res.statusText);
        return d;
      });
    });
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PA': '1' },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) throw new Error(d.error || res.statusText);
        return d;
      });
    });
  }

  // ---------------------------------------------------------------- the list --

  function gateSummary(gates) {
    if (!gates) return null;
    return state.gates.map(function (g) {
      var x = gates[g] || {};
      var mark = x.state === 'command' ? (x.missing && x.missing.length ? '!' : '✓') : x.state === 'none' ? '–' : '?';
      return GATE_LABEL[g].split(' ')[0].toLowerCase() + ' ' + mark;
    }).join(' · ');
  }

  function renderList() {
    var ul = document.getElementById('repolist');
    var n = document.getElementById('repos-n');
    ul.replaceChildren();
    if (!state.enabled) {
      ul.append(el('li', { class: 'empty', text: 'The factory is not configured (PA_FACTORY_PATH).' }));
      n.textContent = '';
      return;
    }
    n.textContent = state.apps.length ? String(state.apps.length) : '';
    if (!state.apps.length) {
      ul.append(el('li', { class: 'empty', text: 'No repos registered yet.' }));
      return;
    }
    state.apps.forEach(function (a) {
      if (a.error) {
        ul.append(el('li', null, el('span', { class: 'nm', text: a.app }), el('span', { class: 'chip rd-missing_tool', text: 'broken config' }), el('div', { class: 'why', text: a.error })));
        return;
      }
      var r = a.readiness;
      var status = r ? r.status : null;
      ul.append(el('li', null,
        el('span', { class: 'nm', text: a.app, title: a.repo + (a.path ? ' · ' + a.path : '') }),
        el('span', { class: 'chip rd-' + (status || 'unknown'), text: status ? STATUS_LABEL[status] || status : 'readiness unknown' }),
        a.delivery ? el('span', { class: 'chip', text: a.delivery }) : null,
        a.pipeline ? el('span', { class: 'chip', text: a.pipeline }) : null,
        a.review && a.review.default ? el('span', { class: 'chip', text: 'review ' + a.review.default }) : null,
        a.caps ? el('span', { class: 'chip', title: 'per-job caps (0 = none)', text: '$' + a.caps.budget_usd + ' · ' + a.caps.wall_clock_h + 'h · ' + a.caps.max_rounds + ' rounds' }) : null,
        el('button', { type: 'button', text: 'Edit', onclick: function () { openEditor(a.app, null); } }),
        a.gates ? el('div', { class: 'meta', text: gateSummary(a.gates) }) : null,
        r && r.blocking ? el('div', { class: 'why', text: r.blocking }) : null
      ));
    });
  }

  function load(fresh) {
    return getJson('api/factory/apps' + (fresh ? '?fresh=1' : '')).then(function (d) {
      state.enabled = d.enabled !== false;
      state.apps = d.apps || [];
      if (d.deliveries) state.deliveries = d.deliveries;
      if (d.pipelines) state.pipelines = d.pipelines;
      if (d.gates) state.gates = d.gates;
      renderList();
      return d;
    });
  }

  // -------------------------------------------------------------- the editor --

  function rowOf(app) {
    for (var i = 0; i < state.apps.length; i++) if (state.apps[i].app === app) return state.apps[i];
    return null;
  }

  function select(name, options, value) {
    var s = el('select', { name: name });
    options.forEach(function (o) {
      var opt = el('option', { value: o.value, text: o.label });
      if (o.value === value) opt.selected = true;
      s.append(opt);
    });
    return s;
  }

  // One gate: mode (command / none / not configured), the command, the programs
  // it needs, and the suggestion when there is one.
  function gateFields(g, cur) {
    var mode = cur && cur.state === 'command' ? 'command' : cur && cur.state === 'none' ? 'none' : 'unset';
    var modeSel = select('mode-' + g, [
      { value: 'command', label: 'command' },
      { value: 'none', label: 'none — the repo has no such check' },
      { value: 'unset', label: 'not configured' },
    ], mode);
    var cmd = el('input', { name: 'cmd-' + g, class: 'cmd', placeholder: 'shell command, run in the repo', value: (cur && cur.command) || '' });
    var req = el('input', { name: 'req-' + g, placeholder: 'programs it needs on PATH, e.g. docker, lychee', value: ((cur && cur.requires) || []).join(', ') });
    var sug = el('div', { class: 'sug', 'data-sug': g });
    var miss = cur && cur.missing && cur.missing.length
      ? el('div', { class: 'why', text: 'needs ' + cur.missing.join(', ') + ' — not on the factory machine\'s PATH' })
      : null;
    function sync() { cmd.disabled = modeSel.value !== 'command'; }
    modeSel.addEventListener('change', function () { modeSel.dataset.touched = '1'; sync(); });
    cmd.addEventListener('input', function () { cmd.dataset.touched = '1'; });
    sync();
    return el('fieldset', { 'data-gate': g },
      el('legend', { text: GATE_LABEL[g] }),
      el('div', { class: 'gaterow' }, modeSel, cmd),
      req,
      miss,
      sug
    );
  }

  // Suggestions for gates that are not configured yet: prefilled unless the
  // user already changed that gate; always offered with a Use button.
  function applySuggestions(sugs) {
    var form = document.getElementById('appform');
    state.gates.forEach(function (g) {
      var s = sugs && (sugs[g + '_command'] || sugs[g]);
      var box = form.querySelector('[data-sug="' + g + '"]');
      if (!box) return;
      box.replaceChildren();
      if (!s) return;
      var modeSel = form.elements['mode-' + g];
      var cmd = form.elements['cmd-' + g];
      var req = form.elements['req-' + g];
      function use() {
        if (s.command === 'none') { modeSel.value = 'none'; } else { modeSel.value = 'command'; cmd.value = s.command; }
        if (s.requires && s.requires.length) req.value = s.requires.join(', ');
        cmd.disabled = modeSel.value !== 'command';
      }
      box.append(document.createTextNode('suggested (' + s.source + '): ' + s.command + (s.requires && s.requires.length ? '  · needs ' + s.requires.join(', ') : '')),
        el('button', { type: 'button', text: 'Use', onclick: use }));
      if (modeSel.value === 'unset' && !modeSel.dataset.touched && !cmd.dataset.touched) {
        use();
        box.prepend(el('b', { text: 'Prefilled — Save to confirm. ' }));
      }
    });
  }

  function openEditor(app, suggestions) {
    editing = app;
    var a = rowOf(app) || { app: app };
    var sheet = document.getElementById('appsheet');
    var form = document.getElementById('appform');
    document.getElementById('appsheet-title').textContent = app;
    document.getElementById('appsheet-meta').textContent = (a.repo || '') + (a.path ? ' · ' + a.path : '');
    var keep = { value: '', label: '(unknown — leave as is)' };
    var deliveries = state.deliveries.map(function (d) { return { value: d.value, label: d.value + ' — ' + d.plain }; });
    var pipelines = state.pipelines.map(function (p) { return { value: p, label: p }; });
    var reviews = ['auto', 'on', 'off'].map(function (r) { return { value: r, label: REVIEW_LABEL[r] }; });
    var rv = a.review || {};
    var caps = a.caps || {};
    function num(name, value, step) {
      return el('input', { name: name, type: 'number', min: '0', step: step, value: value == null ? '' : String(value), placeholder: 'unknown' });
    }
    form.replaceChildren(
      el('div', { class: 'two' },
        el('label', null, 'Delivery default', select('delivery', a.delivery ? deliveries : [keep].concat(deliveries), a.delivery || '')),
        el('label', null, 'Pipeline default', select('pipeline', a.pipeline ? pipelines : [keep].concat(pipelines), a.pipeline || ''))
      ),
      el('div', { class: 'two' },
        el('label', null, 'Review (solo jobs)', select('review', rv.default ? reviews : [keep].concat(reviews), rv.default || '')),
        el('label', null, 'Under auto, also review diffs of at least (lines; 0 = never)', num('reviewMinDiffLines', rv.autoMinDiffLines, '1'))
      ),
      el('div', { class: 'two' },
        el('label', null, CAP_LABEL.budget_usd, num('cap-budget_usd', caps.budget_usd, '0.5')),
        el('label', null, CAP_LABEL.wall_clock_h, num('cap-wall_clock_h', caps.wall_clock_h, '0.5')),
        el('label', null, CAP_LABEL.max_rounds, num('cap-max_rounds', caps.max_rounds, '1'))
      ),
      el('div', { class: 'meta', text: 'A job that reaches a cap stops for you (needs you), with its work saved; Continue gives it the caps again. 0 = no cap.' })
    );
    var gates = a.gates || {};
    state.gates.forEach(function (g) { form.append(gateFields(g, gates[g])); });
    var hint = el('span', { class: 'meta', id: 'apphint', text: suggestions ? '' : 'looking for suggested gates…' });
    form.append(el('div', { class: 'row' }, el('button', { class: 'primary', type: 'submit', text: 'Save' }), hint));
    sheet.hidden = false;
    if (suggestions) {
      applySuggestions(suggestions);
      return;
    }
    // Suggestions read the checkout on the factory machine: fetched after the
    // form is already usable.
    getJson('api/factory/apps/' + encodeURIComponent(app)).then(function (d) {
      if (editing !== app) return;
      applySuggestions(d.suggested_gates || {});
      hint.textContent = d.docs_only ? 'docs-only repo' : '';
      if (d.readiness && d.readiness.blocking) hint.textContent = d.readiness.blocking;
    }).catch(function (err) {
      if (editing === app) hint.textContent = 'no suggestions: ' + err.message;
    });
  }

  function closeEditor() {
    editing = null;
    document.getElementById('appsheet').hidden = true;
  }

  function save(ev) {
    ev.preventDefault();
    var form = ev.target;
    var app = editing;
    var row = rowOf(app) || {};
    var body = { gates: {}, requires: {} };
    // Only what changed: a row from an older factory has no delivery to show,
    // and the select's first option must not overwrite it.
    if (form.elements.delivery.value && form.elements.delivery.value !== row.delivery) body.delivery = form.elements.delivery.value;
    if (form.elements.pipeline.value && form.elements.pipeline.value !== row.pipeline) body.pipeline = form.elements.pipeline.value;
    var rv = row.review || {};
    if (form.elements.review.value && form.elements.review.value !== rv.default) body.review = form.elements.review.value;
    var mdl = form.elements.reviewMinDiffLines.value.trim();
    if (mdl !== '' && Number(mdl) !== rv.autoMinDiffLines) body.reviewMinDiffLines = Number(mdl);
    var caps = {};
    ['budget_usd', 'wall_clock_h', 'max_rounds'].forEach(function (k) {
      var v = form.elements['cap-' + k].value.trim();
      if (v !== '' && Number(v) !== (row.caps || {})[k]) caps[k] = Number(v);
    });
    if (Object.keys(caps).length) body.caps = caps;
    state.gates.forEach(function (g) {
      var mode = form.elements['mode-' + g].value;
      var cmd = form.elements['cmd-' + g].value.trim();
      body.gates[g] = mode === 'none' ? 'none' : mode === 'command' ? cmd : '';
      body.requires[g] = form.elements['req-' + g].value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    });
    var bad = state.gates.filter(function (g) { return form.elements['mode-' + g].value === 'command' && !body.gates[g]; });
    if (bad.length) {
      toast('A command gate needs a command: ' + bad.map(function (g) { return GATE_LABEL[g]; }).join(', '));
      return;
    }
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    post('api/factory/apps/' + encodeURIComponent(app), body).then(function (r) {
      var rd = r.readiness || {};
      toast(app + ': saved' + (r.changed && r.changed.length ? ' (' + r.changed.join(', ') + ')' : ' (nothing changed)') + ' — ' + (STATUS_LABEL[rd.status] || rd.status || ''));
      closeEditor();
      return load(true);
    }).catch(function (err) {
      toast(app + ': ' + err.message);
    }).finally(function () { btn.disabled = false; });
  }

  function add(ev) {
    ev.preventDefault();
    var form = ev.target;
    var hint = document.getElementById('addhint');
    var repo = form.elements.repo.value.trim();
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    hint.textContent = 'registering (a clone can take a while)…';
    post('api/factory/apps', { repo: repo, path: form.elements.path.value.trim() }).then(function (r) {
      hint.textContent = '';
      form.reset();
      toast('Registered ' + r.app + ' — confirm its gates');
      // Show it at once from the add result, then refresh from the factory.
      state.apps = state.apps.filter(function (a) { return a.app !== r.app; }).concat([{
        app: r.app, repo: r.repo, path: r.path, delivery: r.delivery && r.delivery.default, pipeline: r.pipeline_default,
        gates: null, readiness: r.readiness ? { status: r.readiness.status, blocking: r.readiness.blocking } : null,
      }]);
      renderList();
      load(true).then(function () { openEditor(r.app, r.suggested_gates || {}); }, function () { openEditor(r.app, r.suggested_gates || {}); });
    }).catch(function (err) {
      hint.textContent = err.message;
    }).finally(function () { btn.disabled = false; });
  }

  document.getElementById('appform').addEventListener('submit', save);
  document.getElementById('addrepo').addEventListener('submit', add);
  document.getElementById('appsheet-close').addEventListener('click', closeEditor);
  document.getElementById('appsheet').addEventListener('click', function (ev) { if (ev.target.id === 'appsheet') closeEditor(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && editing) closeEditor(); });

  // The cached list first (no factory call), then the factory's current view.
  load(false).then(function () { return load(true); }).catch(function (err) {
    var ul = document.getElementById('repolist');
    ul.replaceChildren(el('li', { class: 'empty', text: 'Repos unavailable: ' + err.message }));
  });
})();
