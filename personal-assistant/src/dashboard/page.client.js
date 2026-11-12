/* Jarvis pages: the one renderer (src/pages). It draws a resolved page — a
 * map of components with flows you can light up, short sections, and the
 * task list with progress — in two places that must look the same:
 *
 *   the dashboard   /pages/<slug>: <div id="page-root" data-src="../api/pages/<slug>">,
 *                   fetched (a relative URL, so termhub's /pa/ proxy works) and
 *                   refreshed every 30 s
 *   the export      one HTML file with this script inlined and the page in
 *                   <script type="application/json" id="page-data">; also what is
 *                   published as a claude.ai Artifact
 *
 * Self-contained: its own CSS tokens (light and dark), no fonts or scripts from
 * anywhere. textContent and createElement only: no HTML sink. */
(function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';
  var STYLE = [
    ':root{--pg-bg:#f7f7f5;--pg-panel:#ffffff;--pg-ink:#1d1f23;--pg-muted:#5f6670;--pg-line:#d9dce1;--pg-band:#eef0f3;',
    '--pg-accent:#2f6fde;--pg-ok:#1f8a4c;--pg-warn:#b7791f;--pg-bad:#c53030;--pg-next:#7c3aed;--pg-dim:0.18;--pg-chip:#eef2f8;}',
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--pg-bg:#14161a;--pg-panel:#1c1f25;--pg-ink:#e6e8eb;',
    '--pg-muted:#9aa3ad;--pg-line:#323842;--pg-band:#20242b;--pg-accent:#6ea0ff;--pg-ok:#4cc382;--pg-warn:#e0a948;--pg-bad:#f07070;--pg-next:#b69cff;--pg-chip:#262b33;}}',
    ':root[data-theme="dark"]{--pg-bg:#14161a;--pg-panel:#1c1f25;--pg-ink:#e6e8eb;--pg-muted:#9aa3ad;--pg-line:#323842;',
    '--pg-band:#20242b;--pg-accent:#6ea0ff;--pg-ok:#4cc382;--pg-warn:#e0a948;--pg-bad:#f07070;--pg-next:#b69cff;--pg-chip:#262b33;}',
    'body{margin:0;background:var(--pg-bg);color:var(--pg-ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
    '.pg{max-width:1100px;margin:0 auto;padding:20px 16px 40px;box-sizing:border-box;}',
    '.pg *{box-sizing:border-box;}',
    '.pg h1{font-size:22px;margin:0 0 4px;line-height:1.25;overflow-wrap:anywhere;}',
    '.pg h2{font-size:16px;margin:28px 0 10px;}',
    '.pg .sum{color:var(--pg-muted);margin:0 0 10px;max-width:70ch;}',
    '.pg .links{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 12px;overflow-wrap:anywhere;}',
    '.pg a{color:var(--pg-accent);}',
    '.pg .bar{height:8px;border-radius:4px;background:var(--pg-band);overflow:hidden;}',
    '.pg .bar>span{display:block;height:100%;background:var(--pg-ok);border-radius:4px;transition:width .3s;}',
    '.pg .prog{background:var(--pg-panel);border:1px solid var(--pg-line);border-radius:10px;padding:12px 14px;}',
    '.pg .prog .nums{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;margin-bottom:8px;}',
    '.pg .prog .pct{font-size:24px;font-weight:650;}',
    '.pg .muted{color:var(--pg-muted);}',
    '.pg .doing{margin-top:8px;}',
    '.pg .map{position:relative;background:var(--pg-panel);border:1px solid var(--pg-line);border-radius:10px;padding:10px;}',
    '.pg .band{position:relative;z-index:1;display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:8px;background:var(--pg-band);margin-bottom:28px;}',
    '.pg .band:last-of-type{margin-bottom:0;}',
    '.pg .band .bl{flex:none;width:96px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--pg-muted);padding-top:6px;}',
    '.pg .band .bn{display:flex;flex-wrap:wrap;gap:10px 14px;flex:1;min-width:0;}',
    '.pg .node{position:relative;background:var(--pg-panel);border:1.5px solid var(--pg-line);border-radius:8px;padding:6px 10px;min-width:110px;max-width:220px;cursor:pointer;transition:opacity .15s,border-color .15s,box-shadow .15s;}',
    '.pg .node .nl{font-weight:600;font-size:13px;line-height:1.3;}',
    '.pg .node .nk{font-size:11px;color:var(--pg-muted);}',
    '.pg .node.s-planned{border-style:dashed;}',
    '.pg .node.s-retiring{opacity:.75;}',
    '.pg .node.s-blocked{border-color:var(--pg-bad);}',
    '.pg .node .dot{position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:var(--pg-ok);}',
    '.pg .node.s-planned .dot{background:var(--pg-muted);}.pg .node.s-retiring .dot{background:var(--pg-warn);}.pg .node.s-blocked .dot{background:var(--pg-bad);}',
    '.pg .node.hot{border-color:var(--pg-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--pg-accent) 25%,transparent);}',
    '.pg .map.dim .node:not(.on){opacity:var(--pg-dim);}',
    '.pg svg.edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;overflow:visible;}',
    '.pg svg.edges path{fill:none;stroke-width:1.8;transition:opacity .15s,stroke-width .15s;}',
    '.pg svg.edges text{font-size:10.5px;fill:var(--pg-muted);paint-order:stroke;stroke:var(--pg-panel);stroke-width:3px;}',
    '.pg .map.dim svg.edges .e:not(.on){opacity:.08;}',
    '.pg .map.dim svg.edges .e.on path{stroke-width:3;}',
    // Labels only on a highlighted flow or node: all of them at once overlap into noise.
    '.pg svg.edges text{display:none;}',
    '.pg .map.dim svg.edges .e.on text{display:inline;fill:var(--pg-ink);}',
    '.pg .legend{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;}',
    '.pg .flow{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--pg-line);background:var(--pg-panel);color:var(--pg-ink);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;}',
    '.pg .flow i{width:10px;height:10px;border-radius:50%;display:inline-block;}',
    '.pg .flow.on{border-color:var(--pg-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--pg-accent) 25%,transparent);}',
    '.pg .flowdesc{margin:6px 0 0;color:var(--pg-muted);min-height:1.5em;}',
    '.pg .detail{margin-top:10px;background:var(--pg-panel);border:1px solid var(--pg-line);border-radius:10px;padding:10px 14px;}',
    '.pg .detail[hidden]{display:none;}',
    '.pg .detail h3{margin:0 0 4px;font-size:15px;}',
    '.pg .detail p{margin:4px 0;}',
    '.pg .detail .x{float:right;border:0;background:none;color:var(--pg-muted);font-size:18px;cursor:pointer;}',
    '.pg .sec p{margin:0 0 8px;max-width:75ch;}.pg .sec ul{margin:0 0 8px;padding-left:20px;max-width:75ch;}',
    '.pg .group{background:var(--pg-panel);border:1px solid var(--pg-line);border-radius:10px;padding:10px 14px;margin-bottom:12px;}',
    '.pg .group .gh{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-bottom:6px;}',
    '.pg .group .gh b{font-size:14px;}',
    '.pg .group .bar{margin-bottom:8px;}',
    // A task row: a status badge (colour AND word, so it reads without colour), a left rule in the
    // same colour for the open states, the title with its owner, then meta and links. Wraps, never scrolls.
    '.pg .task{--st:var(--pg-muted);display:flex;gap:10px;align-items:flex-start;padding:7px 0 7px 8px;border-top:1px solid var(--pg-line);border-left:3px solid transparent;}',
    '.pg .task:first-of-type{border-top:0;}',
    '.pg .t-doing{--st:var(--pg-accent);}.pg .t-next{--st:var(--pg-next);}.pg .t-blocked{--st:var(--pg-bad);}.pg .t-done{--st:var(--pg-ok);}',
    '.pg .t-doing,.pg .t-next,.pg .t-blocked{border-left-color:var(--st);}',
    '.pg .chip{flex:none;min-width:58px;text-align:center;font-size:11px;font-weight:650;border-radius:999px;padding:1px 8px;margin-top:2px;white-space:nowrap;',
    'background:color-mix(in srgb,var(--st) 16%,transparent);color:var(--st);border:1px solid color-mix(in srgb,var(--st) 45%,transparent);}',
    '.pg .t-doing .chip,.pg .t-next .chip,.pg .t-blocked .chip{background:var(--st);color:var(--pg-panel);border-color:var(--st);}',
    '.pg .t-todo .chip{background:var(--pg-chip);color:var(--pg-ink);border-color:var(--pg-line);}',
    '.pg .t-dropped .chip,.pg .t-missing .chip{background:transparent;border-style:dashed;}',
    '.pg .t-dropped .tt,.pg .t-missing .tt{text-decoration:line-through;color:var(--pg-muted);}',
    '.pg .t-done .tt{color:var(--pg-muted);}',
    '.pg .tb{flex:1;min-width:0;}',
    '.pg .th{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;}',
    '.pg .tt{flex:1 1 14em;min-width:0;overflow-wrap:anywhere;}',
    '.pg .t-doing .tt,.pg .t-next .tt,.pg .t-blocked .tt{font-weight:600;}',
    '.pg .ow{flex:none;max-width:100%;font-size:12px;color:var(--pg-ink);background:var(--pg-band);border-radius:4px;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.pg .tm{font-size:12px;color:var(--pg-muted);display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:2px;}',
    '.pg .tm .blk{color:var(--pg-bad);font-weight:600;}',
    '.pg .tl{font-size:12px;display:flex;flex-wrap:wrap;gap:2px 12px;margin-top:2px;}',
    '.pg .tl a{overflow-wrap:anywhere;}',
    '.pg .nchip{border:1px solid var(--pg-line);border-radius:4px;padding:0 5px;font-size:11px;cursor:default;}',
    '.pg .foot{margin-top:28px;font-size:12px;color:var(--pg-muted);}',
    '@media (max-width:640px){.pg .band{flex-direction:column;gap:6px;margin-bottom:22px;}.pg .band .bl{width:auto;padding:0;}',
    '.pg .node{max-width:none;flex:1 1 140px;}.pg h1{font-size:19px;}.pg .group{padding:10px;}.pg .task{gap:8px;}}',
  ].join('');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function sv(tag, attrs) {
    var e = document.createElementNS(SVG, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function bar(pct) {
    var b = el('div', 'bar');
    var s = el('span');
    s.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
    b.appendChild(s);
    b.setAttribute('role', 'progressbar');
    b.setAttribute('aria-valuenow', String(pct));
    b.setAttribute('aria-valuemin', '0');
    b.setAttribute('aria-valuemax', '100');
    return b;
  }
  function safeHref(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : null; }

  var STATUS_LABEL = { doing: 'Doing', next: 'Next', blocked: 'Blocked', todo: 'To do', done: 'Done', dropped: 'Dropped', missing: 'Missing' };
  var OPEN = { doing: 1, next: 1, blocked: 1, todo: 1 };
  /** A task's status; a page resolved before statuses existed has only `state`. */
  function statusOf(t) { return t.status || (t.state === 'todo' && t.blockedOn ? 'blocked' : t.state); }
  function linkEl(l) {
    var href = safeHref(l.url);
    if (!href) return null;
    var a = el('a', null, l.label || href);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = href;
    return a;
  }

  /** Plain text: blank-line paragraphs, "- " bullets. */
  function textBlocks(body) {
    var frag = document.createDocumentFragment();
    String(body || '').split(/\n\s*\n/).forEach(function (para) {
      var lines = para.split('\n').filter(function (l) { return l.trim(); });
      if (!lines.length) return;
      if (lines.every(function (l) { return /^\s*[-*] /.test(l); })) {
        var ul = el('ul');
        lines.forEach(function (l) { ul.appendChild(el('li', null, l.replace(/^\s*[-*] /, ''))); });
        frag.appendChild(ul);
      } else frag.appendChild(el('p', null, lines.join(' ')));
    });
    return frag;
  }

  function render(root, page, opts) {
    opts = opts || {};
    if (!document.getElementById('pg-style')) {
      var st = el('style');
      st.id = 'pg-style';
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    var keep = root.__pg || { flow: null, node: null };
    clear(root);
    var wrap = el('div', 'pg');
    root.appendChild(wrap);
    if (!opts.live) document.title = document.title || page.title;

    // ---- header and overall progress
    wrap.appendChild(el('h1', null, page.title));
    if (page.summary) wrap.appendChild(el('p', 'sum', page.summary));
    if (page.links && page.links.length) {
      var links = el('div', 'links');
      page.links.forEach(function (l) { var a = linkEl(l); if (a) links.appendChild(a); });
      if (links.firstChild) wrap.appendChild(links);
    }
    var p = page.progress || { done: 0, total: 0, percent: 0, doing: [] };
    var prog = el('div', 'prog');
    var nums = el('div', 'nums');
    nums.appendChild(el('span', 'pct', p.percent + '%'));
    nums.appendChild(el('span', 'muted', p.done + ' of ' + p.total + ' tasks done'));
    var open = (page.tasks || []).filter(function (t) { return OPEN[statusOf(t)]; }).length;
    if (open) nums.appendChild(el('span', 'muted', open + ' open'));
    if (p.blocked) nums.appendChild(el('span', 'muted', p.blocked + ' blocked'));
    prog.appendChild(nums);
    prog.appendChild(bar(p.percent));
    if (p.doing && p.doing.length) prog.appendChild(el('div', 'doing', 'Doing: ' + p.doing.join(' · ')));
    if (p.next && p.next.length) prog.appendChild(el('div', 'doing', 'Next: ' + p.next.join(' · ')));
    wrap.appendChild(prog);

    // ---- the map
    var map = page.map || { layers: [], nodes: [], edges: [], flows: [] };
    var boxes = {};
    var mapEl = null;
    var svg = null;
    var detail = null;
    var flowDesc = null;
    var flowsById = {};
    (map.flows || []).forEach(function (f) { flowsById[f.id] = f; });

    function nodeTasks(id) { return (page.tasks || []).filter(function (t) { return (t.nodes || []).indexOf(id) >= 0; }); }
    function edgeColor(e) {
      var f = (e.flows || [])[0] && flowsById[e.flows[0]];
      return (f && f.color) || 'var(--pg-muted)';
    }

    function applyHighlight() {
      if (!mapEl) return;
      var flow = keep.flow;
      var node = keep.node;
      var onNodes = {};
      var any = false;
      Array.prototype.forEach.call(svg ? svg.querySelectorAll('.e') : [], function (g) {
        var e = map.edges[Number(g.getAttribute('data-i'))];
        var on = false;
        if (flow) on = (e.flows || []).indexOf(flow) >= 0;
        else if (node) on = e.from === node || e.to === node;
        g.classList.toggle('on', on);
        if (on) { onNodes[e.from] = 1; onNodes[e.to] = 1; any = true; }
      });
      if (node) { onNodes[node] = 1; any = true; }
      Object.keys(boxes).forEach(function (id) {
        boxes[id].classList.toggle('on', !!onNodes[id]);
        boxes[id].classList.toggle('hot', id === node);
      });
      mapEl.classList.toggle('dim', any);
      Array.prototype.forEach.call(wrap.querySelectorAll('.flow'), function (b) { b.classList.toggle('on', b.getAttribute('data-flow') === flow); });
      if (flowDesc) flowDesc.textContent = flow && flowsById[flow] ? (flowsById[flow].description || '') : '';
    }

    function showDetail(id) {
      if (!detail) return;
      var n = (map.nodes || []).find(function (x) { return x.id === id; });
      clear(detail);
      if (!n) { detail.hidden = true; return; }
      var x = el('button', 'x', '×');
      x.title = 'Close';
      x.onclick = function () { keep.node = null; root.__pg = keep; detail.hidden = true; applyHighlight(); };
      detail.appendChild(x);
      detail.appendChild(el('h3', null, n.label));
      detail.appendChild(el('div', 'muted', [n.kind, n.status].filter(Boolean).join(' · ')));
      if (n.detail) detail.appendChild(textBlocks(n.detail));
      var ts = nodeTasks(id);
      if (ts.length) {
        detail.appendChild(el('p', 'muted', 'Tasks here:'));
        var ul = el('ul');
        ts.forEach(function (t) { ul.appendChild(el('li', null, '#' + t.card + ' ' + t.title + ' (' + (STATUS_LABEL[statusOf(t)] || t.state) + (t.owner ? ', ' + t.owner : '') + ')')); });
        detail.appendChild(ul);
      }
      detail.hidden = false;
    }

    function drawEdges() {
      if (!svg || !mapEl) return;
      clear(svg);
      var defs = sv('defs', {});
      svg.appendChild(defs);
      var markers = {};
      function marker(color) {
        var key = color.replace(/[^a-z0-9]/gi, '');
        if (markers[key]) return 'url(#pgm-' + key + ')';
        var m = sv('marker', { id: 'pgm-' + key, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
        var tri = sv('path', { d: 'M0,0 L10,5 L0,10 z' });
        tri.style.fill = color;
        m.appendChild(tri);
        defs.appendChild(m);
        markers[key] = 1;
        return 'url(#pgm-' + key + ')';
      }
      var base = mapEl.getBoundingClientRect();
      (map.edges || []).forEach(function (e, i) {
        var a = boxes[e.from], b = boxes[e.to];
        if (!a || !b) return;
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        var ax = ra.left - base.left + ra.width / 2, ay = ra.top - base.top + ra.height / 2;
        var bx = rb.left - base.left + rb.width / 2, by = rb.top - base.top + rb.height / 2;
        var p1, p2, d;
        if (Math.abs(by - ay) > 8) {
          // between bands: leave from the bottom/top edge, curve vertically
          var down = by > ay;
          p1 = [ax, down ? ay + ra.height / 2 : ay - ra.height / 2];
          p2 = [bx, down ? by - rb.height / 2 : by + rb.height / 2];
          var my = (p1[1] + p2[1]) / 2;
          d = 'M' + p1[0] + ',' + p1[1] + ' C' + p1[0] + ',' + my + ' ' + p2[0] + ',' + my + ' ' + p2[0] + ',' + p2[1];
        } else {
          // same band: an arc from top edge to top edge, over any box between them
          var top = Math.min(ay - ra.height / 2, by - rb.height / 2);
          p1 = [ax + (bx > ax ? 8 : -8), ay - ra.height / 2];
          p2 = [bx + (bx > ax ? -8 : 8), by - rb.height / 2];
          var lift = top - Math.min(30, 12 + Math.abs(p2[0] - p1[0]) / 12);
          d = 'M' + p1[0] + ',' + p1[1] + ' C' + p1[0] + ',' + lift + ' ' + p2[0] + ',' + lift + ' ' + p2[0] + ',' + p2[1];
          p1 = [p1[0], lift + 6];
          p2 = [p2[0], lift + 6];
        }
        var color = edgeColor(e);
        var g = sv('g', { class: 'e', 'data-i': i });
        var path = sv('path', { d: d });
        path.style.stroke = color;
        if (e.style === 'dashed') path.setAttribute('stroke-dasharray', '5 4');
        path.setAttribute('marker-end', marker(color));
        g.appendChild(path);
        if (e.label) {
          var t = sv('text', { x: (p1[0] + p2[0]) / 2, y: (p1[1] + p2[1]) / 2 - 3, 'text-anchor': 'middle' });
          t.textContent = e.label;
          g.appendChild(t);
        }
        var title = sv('title', {});
        title.textContent = e.label || (e.from + ' → ' + e.to);
        g.appendChild(title);
        svg.appendChild(g);
      });
      applyHighlight();
    }

    if ((map.nodes || []).length) {
      wrap.appendChild(el('h2', null, 'Map'));
      mapEl = el('div', 'map');
      (map.layers || []).forEach(function (l) {
        var nodes = map.nodes.filter(function (n) { return n.layer === l.id; });
        if (!nodes.length) return;
        var band = el('div', 'band');
        band.appendChild(el('div', 'bl', l.label));
        var bn = el('div', 'bn');
        nodes.forEach(function (n) {
          var box = el('div', 'node s-' + (n.status || 'live'));
          box.tabIndex = 0;
          box.appendChild(el('span', 'dot'));
          box.appendChild(el('div', 'nl', n.label));
          var ts = nodeTasks(n.id).filter(function (t) { return OPEN[statusOf(t)]; });
          box.appendChild(el('div', 'nk', [n.kind, ts.length ? ts.length + ' open' : null].filter(Boolean).join(' · ')));
          box.title = n.detail || n.label;
          box.addEventListener('mouseenter', function () { if (!keep.flow && !keep.node) { keep.hover = n.id; boxes[n.id].classList.add('hot'); } });
          box.addEventListener('mouseleave', function () { if (keep.hover === n.id) { keep.hover = null; boxes[n.id].classList.remove('hot'); } });
          var pick = function () {
            keep.flow = null;
            keep.node = keep.node === n.id ? null : n.id;
            root.__pg = keep;
            if (keep.node) showDetail(n.id); else if (detail) detail.hidden = true;
            applyHighlight();
          };
          box.addEventListener('click', pick);
          box.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
          boxes[n.id] = box;
          bn.appendChild(box);
        });
        band.appendChild(bn);
        mapEl.appendChild(band);
      });
      svg = sv('svg', { class: 'edges', 'aria-hidden': 'true' });
      mapEl.appendChild(svg);
      wrap.appendChild(mapEl);
      if ((map.flows || []).length) {
        var legend = el('div', 'legend');
        map.flows.forEach(function (f) {
          var b = el('button', 'flow');
          b.type = 'button';
          b.setAttribute('data-flow', f.id);
          var dot = el('i');
          dot.style.background = f.color || 'var(--pg-muted)';
          b.appendChild(dot);
          b.appendChild(document.createTextNode(f.label));
          b.title = f.description || f.label;
          b.addEventListener('mouseenter', function () { if (!keep.pinFlow) { keep.flow = f.id; applyHighlight(); } });
          b.addEventListener('mouseleave', function () { if (!keep.pinFlow) { keep.flow = null; applyHighlight(); } });
          b.addEventListener('click', function () {
            keep.pinFlow = keep.pinFlow === f.id ? null : f.id;
            keep.flow = keep.pinFlow;
            keep.node = null;
            if (detail) detail.hidden = true;
            root.__pg = keep;
            applyHighlight();
          });
          legend.appendChild(b);
        });
        wrap.appendChild(legend);
        flowDesc = el('p', 'flowdesc');
        wrap.appendChild(flowDesc);
      }
      detail = el('div', 'detail');
      detail.hidden = true;
      wrap.appendChild(detail);
    }

    // ---- sections
    (page.sections || []).forEach(function (s) {
      var sec = el('div', 'sec');
      sec.appendChild(el('h2', null, s.heading));
      sec.appendChild(textBlocks(s.body));
      wrap.appendChild(sec);
    });

    // ---- tasks, by group
    if ((page.groups || []).length) {
      wrap.appendChild(el('h2', null, 'Tasks'));
      page.groups.forEach(function (g) {
        var box = el('div', 'group');
        var gh = el('div', 'gh');
        gh.appendChild(el('b', null, g.name));
        gh.appendChild(el('span', 'muted', g.done + '/' + g.total + ' · ' + g.percent + '%'));
        box.appendChild(gh);
        box.appendChild(bar(g.percent));
        g.tasks.forEach(function (t) {
          var st = statusOf(t);
          var row = el('div', 'task t-' + st);
          row.appendChild(el('span', 'chip', STATUS_LABEL[st] || st));
          var tb = el('div', 'tb');
          var th = el('div', 'th');
          th.appendChild(el('span', 'tt', t.title));
          if (t.owner) {
            var ow = el('span', 'ow', t.owner);
            ow.title = 'Owner: ' + t.owner;
            th.appendChild(ow);
          }
          tb.appendChild(th);
          var tm = el('div', 'tm');
          tm.appendChild(el('span', null, '#' + t.card));
          if (t.due) tm.appendChild(el('span', null, 'due ' + t.due));
          if (t.foldedInto) tm.appendChild(el('span', null, 'folded into #' + t.foldedInto));
          if (t.blockedOn && OPEN[st]) tm.appendChild(el('span', 'blk', 'waiting on ' + t.blockedOn));
          (t.nodes || []).forEach(function (id) {
            var n = (map.nodes || []).find(function (x) { return x.id === id; });
            var c = el('span', 'nchip', n ? n.label : id);
            c.addEventListener('mouseenter', function () { if (boxes[id]) boxes[id].classList.add('hot'); });
            c.addEventListener('mouseleave', function () { if (boxes[id] && keep.node !== id) boxes[id].classList.remove('hot'); });
            tm.appendChild(c);
          });
          tb.appendChild(tm);
          var tl = el('div', 'tl');
          (t.links || []).forEach(function (l) { var a = linkEl(l); if (a) tl.appendChild(a); });
          if (tl.firstChild) tb.appendChild(tl);
          row.appendChild(tb);
          box.appendChild(row);
        });
        wrap.appendChild(box);
      });
    }

    var when = page.resolvedAt ? String(page.resolvedAt).replace('T', ' ').slice(0, 16) + ' UTC' : '';
    wrap.appendChild(el('div', 'foot', opts.live ? 'Live from the board · refreshed ' + when : 'Snapshot ' + (page.resolvedAt || '') + ' · source: Jarvis'));

    root.__pg = keep;
    var redraw = function () { drawEdges(); };
    if (root.__pgResize) window.removeEventListener('resize', root.__pgResize);
    root.__pgResize = redraw;
    window.addEventListener('resize', redraw);
    requestAnimationFrame(function () { drawEdges(); if (keep.node) showDetail(keep.node); });
  }

  window.JarvisPage = { render: render };

  function boot() {
    var root = document.getElementById('page-root');
    if (!root) return;
    var embedded = document.getElementById('page-data');
    if (embedded) {
      render(root, JSON.parse(embedded.textContent || '{}'), { live: false });
      return;
    }
    var src = root.getAttribute('data-src');
    if (!src) return;
    var load = function () {
      fetch(src, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (page) { render(root, page, { live: true }); })
        .catch(function (e) { clear(root); root.appendChild(el('p', 'pg', 'Could not load the page: ' + e.message)); });
    };
    load();
    setInterval(load, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
