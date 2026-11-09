/* The architecture map's client (/architecture). Renders architecture.json:
 * layers as bands, components as boxes, edges as an SVG overlay measured from
 * the boxes, live health dots, a pinned details panel and walk-throughs that
 * light up their path. textContent only: no HTML sink. URLs are relative so
 * the page works under termhub's /pa/ proxy too. */
(function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';
  var KEY = 'jarvis.arch.stack';
  var data = null;
  var health = {};
  var stack = 'work';
  var pinned = null; // component id
  var limits = {}; // workflow id -> {default, override, effective, custom} (api/workflow-limits)
  var example = null; // example id (pinned)
  var hoverEx = null;
  var hoverComp = null;
  var boxes = {}; // id -> element

  try { stack = localStorage.getItem(KEY) || 'work'; } catch (e) { /* private mode */ }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }

  function comp(id) { return data.components.find(function (c) { return c.id === id; }); }
  function statusOf(c) { return (c.stacks || {})[stack] || null; }
  function visible(c) { return !!statusOf(c); }
  function edgeVisible(e) {
    if (e.stacks && e.stacks.indexOf(stack) < 0) return false;
    var a = comp(e.from), b = comp(e.to);
    return a && b && visible(a) && visible(b);
  }
  function whereOf(c) { return (c.where && (c.where[stack] || c.where.work || c.where.personal)) || ''; }

  // Health is measured from the machine serving this page, so it only means
  // something on that machine's stack.
  function homeStack() { return (data.live && data.live.stack) || 'work'; }
  function dotClass(c) {
    if (statusOf(c) === 'planned') return 'dot planned';
    if (!c.health || stack !== homeStack()) return 'dot';
    var h = health[c.health];
    if (!h) return 'dot wait';
    return 'dot' + (h.state === 'ok' ? ' ok' : h.state === 'down' ? ' down' : '');
  }
  function healthText(c) {
    if (statusOf(c) === 'planned') return 'planned: not installed on this stack';
    if (!c.health) return 'no live check';
    if (stack !== homeStack()) return 'not measured: this page runs on the ' + homeStack() + ' stack';
    var h = health[c.health];
    if (!h) return 'checking…';
    return (h.label || c.health) + ': ' + h.state + (h.detail ? ' (' + h.detail + ')' : '') + (h.ms != null ? ', ' + h.ms + ' ms' : '');
  }

  // ---------------------------------------------------------------- render ----
  function renderHeader() {
    $('intro').textContent = data.intro;
    $('maint').textContent = data.maintenance;
    var live = $('live');
    clear(live);
    var L = data.live || {};
    var shown = [['machine', L.machine], ['chat', L.chatAgent + ' · ' + L.chatModel], ['fast lane', L.fastModel + ' → ' + L.fastFallback],
      ['dispatch', L.dispatchVia], ['factory', L.factoryMachine ? L.factoryMachine + (L.factoryPath ? ':' + L.factoryPath : '') : 'not configured'],
      ['factory runtime', L.factoryRuntime + ' / ' + L.factoryPipeline], ['termhub', L.termhub], ['store', L.database], ['dashboard', L.dashboard]];
    var cap = el('span', 'chip');
    cap.textContent = 'Configured here:';
    live.appendChild(cap);
    shown.forEach(function (p) {
      if (!p[1]) return;
      var c = el('span', 'chip');
      c.appendChild(document.createTextNode(p[0] + ' '));
      c.appendChild(el('b', null, p[1]));
      live.appendChild(c);
    });
  }

  function renderStacks() {
    var s = $('stacks');
    clear(s);
    data.stacks.forEach(function (st) {
      var card = el('section', 'stack' + (st.id === stack ? ' on' : ''));
      card.appendChild(el('h2', null, st.name));
      card.appendChild(el('div', 'small muted', st.machine + ' · GitHub: ' + st.identity));
      var ul = el('ul');
      st.runs.forEach(function (r) { ul.appendChild(el('li', null, r)); });
      card.appendChild(ul);
      card.appendChild(el('div', 'xs muted', 'Ingests: ' + st.ingests));
      s.appendChild(card);
    });
    document.querySelectorAll('[data-stack]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-stack') === stack)); });
  }

  function renderLayers() {
    var root = $('layers');
    clear(root);
    boxes = {};
    data.layers.forEach(function (layer) {
      var comps = data.components.filter(function (c) { return c.layer === layer.id && visible(c); });
      if (!comps.length) return;
      var row = el('section', 'layer');
      var head = el('div');
      var name = el('div', 'lname');
      name.appendChild(el('span', null, layer.n));
      name.appendChild(document.createTextNode(layer.name));
      head.appendChild(name);
      head.appendChild(el('div', 'lsum', layer.summary));
      row.appendChild(head);
      var wrap = el('div', 'boxes');
      comps.forEach(function (c) {
        var st = statusOf(c);
        var b = el('button', 'comp' + (st === 'planned' ? ' planned' : ''));
        b.type = 'button';
        b.setAttribute('data-id', c.id);
        b.appendChild(el('span', 'step'));
        var n = el('div', 'cname');
        var d = el('i', dotClass(c));
        d.setAttribute('data-dot', c.id);
        n.appendChild(d);
        n.appendChild(document.createTextNode(c.name));
        if (st !== 'live') n.appendChild(el('span', 'badge ' + st, st));
        b.appendChild(n);
        b.appendChild(el('div', 'crole', c.role));
        b.addEventListener('mouseenter', function (ev) { hoverComp = c.id; showTip(c, ev); highlight(); });
        b.addEventListener('mousemove', moveTip);
        b.addEventListener('mouseleave', function () { hoverComp = null; hideTip(); highlight(); });
        b.addEventListener('focus', function () { hoverComp = c.id; highlight(); });
        b.addEventListener('blur', function () { hoverComp = null; highlight(); });
        b.addEventListener('click', function () { pin(pinned === c.id ? null : c.id); });
        boxes[c.id] = b;
        wrap.appendChild(b);
      });
      row.appendChild(wrap);
      root.appendChild(row);
    });
  }

  function refreshDots() {
    Object.keys(boxes).forEach(function (id) {
      var d = boxes[id].querySelector('[data-dot]');
      if (d) d.className = dotClass(comp(id));
    });
  }

  // ----------------------------------------------------------------- edges ----
  function drawEdges() {
    if (!data) return;
    var svg = $('edges');
    clear(svg);
    var host = $('diagram').getBoundingClientRect();
    svg.setAttribute('viewBox', '0 0 ' + host.width + ' ' + host.height);
    var lines = data.edges.filter(edgeVisible).map(function (e) { return { e: e }; });
    var ex = activeExample();
    if (ex) {
      // A walk-through step with no declared edge still gets a dashed link.
      var ids = ex.steps.map(function (s) { return s.c; });
      for (var i = 1; i < ids.length; i++) {
        var a = ids[i - 1], b = ids[i];
        if (a === b || !boxes[a] || !boxes[b]) continue;
        var known = lines.some(function (l) { return (l.e.from === a && l.e.to === b) || (l.e.from === b && l.e.to === a); });
        if (!known) lines.push({ e: { from: a, to: b, label: 'step ' + (i + 1) }, ghost: true });
      }
    }
    lines.forEach(function (l) {
      var A = boxes[l.e.from], B = boxes[l.e.to];
      if (!A || !B) return;
      var ra = rel(A.getBoundingClientRect(), host), rb = rel(B.getBoundingClientRect(), host);
      var p = route(ra, rb);
      var path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', p.d);
      path.setAttribute('data-from', l.e.from);
      path.setAttribute('data-to', l.e.to);
      if (l.ghost) path.setAttribute('class', 'ghost');
      svg.appendChild(path);
      if (l.e.label) {
        var g = document.createElementNS(SVG, 'g');
        g.setAttribute('class', 'lbl');
        g.setAttribute('data-from', l.e.from);
        g.setAttribute('data-to', l.e.to);
        var t = document.createElementNS(SVG, 'text');
        t.textContent = l.e.label;
        t.setAttribute('x', p.mx);
        t.setAttribute('y', p.my + 4);
        t.setAttribute('text-anchor', 'middle');
        var r = document.createElementNS(SVG, 'rect');
        var w = Math.min(320, l.e.label.length * 6.1 + 12);
        r.setAttribute('x', p.mx - w / 2);
        r.setAttribute('y', p.my - 9);
        r.setAttribute('width', w);
        r.setAttribute('height', 18);
        r.setAttribute('rx', 4);
        g.appendChild(r);
        g.appendChild(t);
        svg.appendChild(g);
      }
    });
    highlight();
  }
  function rel(r, host) { return { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height }; }
  function route(a, b) {
    var ax = a.x + a.w / 2, bx = b.x + b.w / 2;
    if (Math.abs(a.y - b.y) < 10) {
      // Same row: leave from the top and arc over.
      var y = Math.min(a.y, b.y);
      var lift = 18 + Math.min(40, Math.abs(ax - bx) / 8);
      return { d: 'M' + ax + ',' + y + ' C' + ax + ',' + (y - lift) + ' ' + bx + ',' + (y - lift) + ' ' + bx + ',' + y, mx: (ax + bx) / 2, my: y - lift * 0.75 };
    }
    var up = a.y < b.y ? a : b, down = a.y < b.y ? b : a;
    var ux = up.x + up.w / 2, dx = down.x + down.w / 2;
    var y1 = up.y + up.h, y2 = down.y;
    var k = Math.max(30, (y2 - y1) / 2);
    return { d: 'M' + ux + ',' + y1 + ' C' + ux + ',' + (y1 + k) + ' ' + dx + ',' + (y2 - k) + ' ' + dx + ',' + y2, mx: (ux + dx) / 2, my: (y1 + y2) / 2 };
  }

  // ------------------------------------------------------------ highlight ----
  function activeExample() {
    var id = hoverEx || example;
    return id ? data.examples.find(function (x) { return x.id === id; }) : null;
  }
  function highlight() {
    var ex = activeExample();
    var focus = hoverComp || pinned;
    var hotComps = {};
    var steps = {};
    if (ex) ex.steps.forEach(function (s, i) { hotComps[s.c] = true; (steps[s.c] = steps[s.c] || []).push(i + 1); });
    else if (focus) {
      hotComps[focus] = true;
      data.edges.filter(edgeVisible).forEach(function (e) {
        if (e.from === focus) hotComps[e.to] = true;
        if (e.to === focus) hotComps[e.from] = true;
      });
    }
    var any = Object.keys(hotComps).length > 0;
    Object.keys(boxes).forEach(function (id) {
      var b = boxes[id];
      b.classList.toggle('hot', !!hotComps[id] && any);
      b.classList.toggle('dim', any && !hotComps[id]);
      b.classList.toggle('pinned', pinned === id);
      var s = b.querySelector('.step');
      s.textContent = steps[id] ? steps[id].join(',') : '';
      s.classList.toggle('on', !!steps[id]);
    });
    var pairs = {};
    if (ex) for (var i = 1; i < ex.steps.length; i++) { pairs[ex.steps[i - 1].c + '>' + ex.steps[i].c] = true; pairs[ex.steps[i].c + '>' + ex.steps[i - 1].c] = true; }
    $('edges').querySelectorAll('[data-from]').forEach(function (n) {
      var f = n.getAttribute('data-from'), t = n.getAttribute('data-to');
      var hot = ex ? !!pairs[f + '>' + t] : focus ? (f === focus || t === focus) : false;
      n.classList.toggle('hot', hot);
      if (n.tagName.toLowerCase() === 'path') n.classList.toggle('dim', any && !hot);
    });
  }

  // ------------------------------------------------------------- tooltip ----
  function showTip(c, ev) {
    var tip = $('tip');
    clear(tip);
    tip.appendChild(el('b', null, c.name));
    tip.appendChild(el('div', 'muted', whereOf(c)));
    tip.appendChild(el('div', null, c.role));
    tip.appendChild(el('div', 'muted', healthText(c)));
    tip.appendChild(el('div', 'muted', 'Click to pin the details.'));
    tip.style.display = 'block';
    moveTip(ev);
  }
  function moveTip(ev) {
    var tip = $('tip');
    if (tip.style.display !== 'block' || !ev) return;
    var x = ev.clientX + 14, y = ev.clientY + 14;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { $('tip').style.display = 'none'; }

  // -------------------------------------------------------------- details ----
  function addList(parent, items, cls) {
    var ul = el('ul', cls || null);
    items.forEach(function (v) { ul.appendChild(el('li', null, v)); });
    parent.appendChild(ul);
  }
  function addChips(panel, title, items, cls) {
    if (!items || !items.length) return;
    panel.appendChild(el('h3', null, title + ' (' + items.length + ')'));
    var box = el('div', 'chips');
    items.forEach(function (v) { box.appendChild(el('span', 'chip' + (cls ? ' ' + cls : ''), v)); });
    panel.appendChild(box);
  }
  function pin(id) {
    pinned = id;
    var p = $('details');
    clear(p);
    if (!id) {
      p.appendChild(el('h2', null, 'Details'));
      p.appendChild(el('p', 'muted small', 'Click a component to pin its details here.'));
      highlight();
      return;
    }
    var c = comp(id);
    var layer = data.layers.find(function (l) { return l.id === c.layer; });
    var h = el('h2');
    var d = el('i', dotClass(c));
    h.appendChild(d);
    h.appendChild(document.createTextNode(c.name));
    var x = el('button', 'x', 'close');
    x.type = 'button';
    x.addEventListener('click', function () { pin(null); });
    h.appendChild(x);
    p.appendChild(h);
    p.appendChild(el('div', 'xs muted', 'Layer ' + layer.n + ' · ' + layer.name + ' · ' + Object.keys(c.stacks).map(function (s) { return s + ': ' + c.stacks[s]; }).join(', ')));
    p.appendChild(el('p', 'small', c.role));
    var dl = el('dl');
    var where = whereOf(c);
    if (where) { dl.appendChild(el('dt', null, 'Where')); dl.appendChild(el('dd', null, where)); }
    dl.appendChild(el('dt', null, 'Live'));
    dl.appendChild(el('dd', null, healthText(c)));
    Object.keys(c.details || {}).forEach(function (k) {
      dl.appendChild(el('dt', null, k));
      var v = c.details[k];
      var dd = el('dd');
      if (Array.isArray(v)) addList(dd, v);
      else dd.textContent = v;
      dl.appendChild(dd);
    });
    p.appendChild(dl);
    if (c.tools) {
      if (c.tools.allowed) { addChips(p, 'Tools allowed without a prompt', c.tools.allowed); addChips(p, 'Tools that ask first', c.tools.ask, 'ask'); }
      if (c.tools.shared) { addChips(p, 'Tools for every session', c.tools.shared); addChips(p, 'Tools for the PA chat only', c.tools.chat_only); }
    }
    if (c.pa_verbs) { addChips(p, '`pa` verbs through the read-only tool', c.pa_verbs.read); addChips(p, '`pa` verbs in the shell (ask)', c.pa_verbs.ask, 'ask'); }
    addChips(p, 'Worker passes', c.passes);
    addChips(p, 'Tables', c.tables);
    addChips(p, 'Personas', c.personas);
    addChips(p, 'Models', c.models);
    if (c.env && c.env.length) {
      p.appendChild(el('h3', null, 'Configuration (default)'));
      var tb = el('table');
      c.env.forEach(function (e) {
        var tr = el('tr');
        tr.appendChild(el('td', null, e.name));
        tr.appendChild(el('td', null, e.default == null ? '(unset)' : e.default === '' ? '(empty)' : e.default));
        tb.appendChild(tr);
      });
      p.appendChild(tb);
    }
    var links = data.edges.filter(function (e) { return (e.from === id || e.to === id) && (!e.stacks || e.stacks.indexOf(stack) >= 0); });
    if (links.length) {
      p.appendChild(el('h3', null, 'Connections'));
      var ul = el('ul', 'plain');
      links.forEach(function (e) {
        var other = comp(e.from === id ? e.to : e.from);
        var li = el('li', 'small');
        li.appendChild(document.createTextNode(e.from === id ? '→ ' : '← '));
        var b = el('button', 'linkish', other.name);
        b.type = 'button';
        b.addEventListener('click', function () { pin(other.id); });
        li.appendChild(b);
        li.appendChild(el('span', 'muted', ': ' + e.label));
        ul.appendChild(li);
      });
      p.appendChild(ul);
    }
    if (c.code && c.code.length) {
      p.appendChild(el('h3', null, 'Code'));
      addList(p, c.code, 'plain mono xs');
    }
    highlight();
  }

  // ------------------------------------------------------------- examples ----
  // What "done" means for a walk-through (PLAN.md 8.1), plus the latest verdict
  // that the Phase 8 reviewers fill (null until then). textContent only.
  function verdictText(v) {
    if (!v || !v.result) return 'not yet reviewed';
    return v.result + (v.date ? ' on ' + v.date : '');
  }
  // The cost ceiling: the JSON's number is the default; the user can override
  // it (stored by the PA, GET/POST api/workflow-limits). Clicks and keys here
  // must not toggle the walk-through card around them.
  function money(n) { return '$' + Number(n).toString(); }
  function costRow(id, cost) {
    var lim = limits[id] || { default: cost.max_usd, override: null, effective: cost.max_usd, custom: false };
    var row = el('div', 'acc-row acc-cost');
    ['click', 'keydown'].forEach(function (t) { row.addEventListener(t, function (ev) { ev.stopPropagation(); }); });
    row.appendChild(el('b', null, 'Cost ceiling: '));
    row.appendChild(document.createTextNode(money(lim.effective) + ' '));
    row.appendChild(el('span', 'verdict ' + (lim.custom ? 'custom' : 'none'), lim.custom ? 'custom (default ' + money(lim.default) + ')' : 'default'));
    row.appendChild(document.createTextNode(' — ' + cost.basis + ' '));
    var input = el('input', 'acc-input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.01';
    input.value = String(lim.effective);
    input.setAttribute('aria-label', 'Cost ceiling in USD for ' + id);
    var save = el('button', null, 'Save');
    var reset = el('button', null, 'Reset to default');
    reset.disabled = !lim.custom;
    var msg = el('span', 'acc-msg');
    function post(value) {
      msg.textContent = 'saving…';
      fetch('api/workflow-limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PA': '1' },
        body: JSON.stringify({ workflow: id, max_usd: value }),
      })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; }); })
        .then(function (j) { limits = j.limits || limits; renderExamples(); })
        .catch(function (err) { msg.textContent = 'not saved: ' + err.message; });
    }
    save.addEventListener('click', function () {
      var n = input.value === '' ? NaN : Number(input.value);
      if (!isFinite(n) || n < 0) { msg.textContent = 'enter a number of USD, 0 or more'; return; }
      post(n);
    });
    reset.addEventListener('click', function () { post(null); });
    [input, save, reset, msg].forEach(function (e) { row.appendChild(document.createTextNode(' ')); row.appendChild(e); });
    return row;
  }

  function loadLimits() {
    fetch('api/workflow-limits', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { limits = j.limits || {}; if (data) renderExamples(); })
      .catch(function () { /* the defaults from architecture.json stand */ });
  }

  function acceptanceBlock(a, id) {
    var box = el('div', 'acc');
    if (!a) return box;
    if (a.outOfScope) {
      box.appendChild(el('div', 'acc-head', 'Acceptance: out of scope'));
      box.appendChild(el('div', 'acc-note', a.outOfScope));
      return box;
    }
    var head = el('div', 'acc-head');
    head.appendChild(document.createTextNode('Acceptance '));
    head.appendChild(el('span', 'verdict ' + (a.verdict && a.verdict.result || 'none'), verdictText(a.verdict)));
    box.appendChild(head);
    var rows = [['Outcome', a.outcome]];
    rows.push(['Shows in', a.views.map(function (v) { return v.charAt(0).toUpperCase() + v.slice(1); }).join(', ')]);
    rows.push(['Approvals', a.approvals.length ? a.approvals.join(', ') : 'none']);
    rows.forEach(function (r) {
      var d = el('div', 'acc-row');
      d.appendChild(el('b', null, r[0] + ': '));
      d.appendChild(document.createTextNode(r[1]));
      box.appendChild(d);
    });
    var hops = el('ol', 'acc-list');
    a.hops.forEach(function (h) {
      var c = comp(h.c);
      var item = el('li');
      item.appendChild(el('b', null, c ? c.name : h.c));
      item.appendChild(document.createTextNode(': ' + h.what + ' — ' + (h.max_ms != null ? 'under ' + h.max_ms + ' ms' : h.unbounded)));
      hops.appendChild(item);
    });
    box.appendChild(costRow(id, a.cost));
    box.appendChild(el('div', 'acc-sub', 'Hops'));
    box.appendChild(hops);
    var rub = el('ul', 'acc-list');
    a.rubric.forEach(function (r) { rub.appendChild(el('li', null, r.check)); });
    box.appendChild(el('div', 'acc-sub', 'Quality rubric'));
    box.appendChild(rub);
    return box;
  }

  function renderExamples() {
    var ul = $('examples');
    clear(ul);
    data.examples.forEach(function (x) {
      var li = el('li', 'ex' + (example === x.id ? ' on' : ''));
      li.tabIndex = 0;
      li.appendChild(el('div', null, x.title)).style.fontWeight = '600';
      li.appendChild(el('div', 'say', x.say));
      // The latest acceptance verdict, visible without opening the walk-through.
      var a = x.acceptance;
      var st = el('div', 'acc-status');
      if (a && a.outOfScope) st.appendChild(el('span', 'verdict', 'out of scope'));
      else st.appendChild(el('span', 'verdict ' + ((a && a.verdict && a.verdict.result) || 'none'), 'Verdict: ' + verdictText(a && a.verdict)));
      li.appendChild(st);
      var ol = el('ol');
      x.steps.forEach(function (s) {
        var c = comp(s.c);
        var item = el('li');
        item.appendChild(el('b', null, c ? c.name : s.c));
        item.appendChild(document.createTextNode(': ' + s.t));
        ol.appendChild(item);
      });
      li.appendChild(ol);
      li.appendChild(acceptanceBlock(x.acceptance, x.id));
      li.addEventListener('mouseenter', function () { hoverEx = x.id; drawEdges(); });
      li.addEventListener('mouseleave', function () { hoverEx = null; drawEdges(); });
      var toggle = function () { example = example === x.id ? null : x.id; renderExamples(); drawEdges(); };
      li.addEventListener('click', toggle);
      li.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
      ul.appendChild(li);
    });
  }

  // ----------------------------------------------------------------- data ----
  function renderAll() {
    renderStacks();
    renderLayers();
    renderExamples();
    if (pinned && !(comp(pinned) && visible(comp(pinned)))) pinned = null;
    pin(pinned);
    requestAnimationFrame(drawEdges);
  }

  function loadHealth() {
    fetch('api/architecture?health=1', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        health = (j && j.health) || {};
        $('checked').textContent = j && j.at ? 'checked ' + new Date(j.at).toLocaleTimeString() + ' from this machine' : '';
        refreshDots();
        renderStacks();
        if (pinned) pin(pinned);
      })
      .catch(function () { $('checked').textContent = 'health unavailable'; });
  }

  document.querySelectorAll('[data-stack]').forEach(function (b) {
    b.addEventListener('click', function () {
      stack = b.getAttribute('data-stack');
      try { localStorage.setItem(KEY, stack); } catch (e) { /* private mode */ }
      renderAll();
    });
  });
  var raf = 0;
  function redraw() { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawEdges); }
  window.addEventListener('resize', redraw);
  if (window.ResizeObserver) new ResizeObserver(redraw).observe($('diagram'));

  fetch('api/architecture', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (j) {
      data = j;
      if (!data.stacks.some(function (s) { return s.id === stack; })) stack = 'work';
      renderHeader();
      renderAll();
      loadHealth();
      loadLimits();
      setInterval(loadHealth, 30000);
    })
    .catch(function (err) {
      var e = $('err');
      e.hidden = false;
      e.textContent = 'Could not load the architecture: ' + err.message;
    });
})();
