'use strict';

// A Plan card's dispatch settings, behind its ☰ button (plan 8.6.4, D28).
// Every Do is a factory job, so what is left to choose is runtime, mode, end
// state, job kind and app/repo: the card shows one read-only line of what Do
// will send ("Claude · full · draft PR · code (auto)") and the ☰ opens a small
// menu with one select per setting, each saying whether it is the default,
// inferred or set on this card, with a reset. The settings are the server's
// (src/dispatch/settings.ts): GET /api/commitments/<id>/dispatch-settings,
// POST the same path {field: value | null} — Do sends nothing of its own, so
// the start uses exactly what the menu shows.
//
// Instant: each card's settings are fetched once in the background (two at a
// time) and kept here across the board's re-renders; a change is applied to
// the cached copy and drawn at once, then POSTed — a failure puts the old
// value back and says why. Nothing here rebuilds the board.
//
// The pure half (labels, the summary line, the menu's rows, an optimistic
// patch) is required by test/dispatchMenu.test.js; the browser gets
// window.DispatchMenu. Text only — no HTML sinks.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DispatchMenu = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FIELDS = ['runtime', 'mode', 'delivery', 'jobKind', 'app'];
  const RUNTIME = { claude_session: 'Claude', api: 'API' };
  const RUNTIME_LONG = { claude_session: 'Claude session (subscription)', api: 'API models (metered)' };
  const DELIVERY = { none: 'nothing pushed', branch: 'branch', draft_pr: 'draft PR', pr: 'PR', auto_merge: 'auto-merge', push_to_main: 'push to main' };
  const MODE = {
    plan: 'plan — read and write a plan, change nothing',
    local: 'local — commit in its worktree, push blocked',
    branch: 'branch — commit and push the branch',
    mr: 'mr — push and open a draft PR',
    full: 'full — push, draft PR, and draft a reply to the asker',
  };
  const KIND = { code: 'code', research: 'research — answer a question', report: 'report — write a document', plan: 'plan — a read-only plan' };
  const SOURCE = {
    given: 'this start', card: 'set on this card', default: 'default', inferred: 'inferred',
    app_default: "the app's default", repo_default: "the repo's default", fallback: 'default',
    kind: 'set by the kind', commitment: "the card's repo", repo: "the repo's app", none: 'none',
  };
  const LABEL = { runtime: 'Runtime', mode: 'Mode', delivery: 'End state', jobKind: 'Job kind', app: 'Repo / app' };

  const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null;

  /** The one line a card shows: "Claude · full · draft PR · code (auto)". */
  function summary(s) {
    if (!s || !s.settings) return 'dispatch settings…';
    const v = s.settings;
    const src = s.source || {};
    const kind = `${v.jobKind || 'code'}${src.jobKind === 'inferred' ? ' (auto)' : ''}`;
    return [
      RUNTIME[v.runtime] || v.runtime,
      v.mode,
      v.jobKind && v.jobKind !== 'code' ? 'report' : DELIVERY[v.delivery] || v.delivery,
      kind,
    ].filter(Boolean).join(' · ');
  }

  /** Where a field's value came from, in words. */
  function badge(s, field) {
    if (field === 'app') {
      if (has(s.overrides, 'app') || has(s.overrides, 'repo')) return SOURCE.card;
      return s.settings.app ? SOURCE[s.source.app] || s.source.app : 'no factory app';
    }
    if (has(s.overrides, field)) return SOURCE.card;
    if (field === 'jobKind' && s.settings.mode === 'plan' && s.settings.jobKind === 'plan') return 'plan mode';
    return SOURCE[s.source[field]] || s.source[field] || 'default';
  }

  /**
   * What each field's default is, kept while it is not overridden: once a
   * field is set on the card the server answers only the override, and the
   * menu still wants to say what "reset" goes back to.
   */
  function rememberDefaults(prev, s) {
    const out = Object.assign({}, prev || {});
    for (const f of FIELDS) {
      const overridden = f === 'app' ? has(s.overrides, 'app') || has(s.overrides, 'repo') : has(s.overrides, f);
      if (overridden) continue;
      out[f] = { value: s.settings[f], source: s.source[f], why: f === 'jobKind' ? s.why.jobKind : f === 'delivery' ? s.why.delivery : null };
      if (f === 'app') out.repo = { value: s.settings.repo, source: s.source.repo };
    }
    return out;
  }

  /**
   * The menu's rows, pure: for each field its label, the select's options and
   * value ('' = the default), where the value came from, and whether it is
   * set on this card (so it can be reset).
   */
  function rows(s, defaults) {
    const d = defaults || {};
    const o = s.options || {};
    const dflt = (f, show) => (d[f] && d[f].value != null ? `default: ${show(d[f].value)}` : 'default');
    const out = [];
    out.push({
      field: 'runtime', label: LABEL.runtime, value: s.overrides.runtime || '',
      options: [{ value: '', label: dflt('runtime', (v) => RUNTIME_LONG[v] || v) }, ...(o.runtimes || []).map((r) => ({ value: r, label: RUNTIME_LONG[r] || r }))],
    });
    out.push({
      field: 'mode', label: LABEL.mode, value: s.overrides.mode || '',
      options: [{ value: '', label: dflt('mode', (v) => v) }, ...(o.modes || []).map((m) => ({ value: m, label: MODE[m] || m }))],
    });
    // The kind's default is the ask's inference, with its reason.
    const auto = d.jobKind && d.jobKind.value
      ? (d.jobKind.source === 'inferred' ? `auto: ${d.jobKind.value} — ${d.jobKind.why}` : `default: ${d.jobKind.value} — ${d.jobKind.why}`)
      : 'auto: decided from the ask';
    out.push({
      field: 'jobKind', label: LABEL.jobKind, value: s.overrides.jobKind || '',
      options: [{ value: '', label: auto }, ...(o.jobKinds || []).map((k) => ({ value: k, label: KIND[k] || k }))],
    });
    // A research, report or plan job delivers a report: no end state to pick.
    const report = s.settings.jobKind && s.settings.jobKind !== 'code';
    out.push({
      field: 'delivery', label: LABEL.delivery, value: report ? '' : s.overrides.delivery || '',
      disabled: report, note: report ? s.why.delivery : null,
      options: [
        { value: '', label: report ? 'a report — no code' : d.delivery && d.delivery.value ? `default: ${DELIVERY[d.delivery.value] || d.delivery.value} — ${d.delivery.why}` : 'default' },
        ...(o.deliveries || []).map((x) => ({ value: x.value, label: `${DELIVERY[x.value] || x.value} — ${x.plain}` })),
      ],
    });
    const appName = (a) => (a.repo ? `${a.app} (${a.repo})` : a.app);
    const dApp = d.app && d.app.value ? `default: ${d.app.value}${d.repo && d.repo.value ? ` (${d.repo.value})` : ''}` : d.repo && d.repo.value ? `default: ${d.repo.value} — no factory app` : 'default: the card\'s repo';
    out.push({
      field: 'app', label: LABEL.app, value: s.overrides.app || '',
      options: [{ value: '', label: dApp }, ...(o.apps || []).map((a) => ({ value: a.app, label: appName(a) }))],
    });
    for (const r of out) {
      r.badge = badge(s, r.field);
      r.overridden = r.field === 'app' ? has(s.overrides, 'app') || has(s.overrides, 'repo') : has(s.overrides, r.field);
      // A stored value the options no longer list is still shown, not silently dropped.
      if (r.value && !r.options.some((x) => x.value === r.value)) r.options.push({ value: r.value, label: r.value });
    }
    return out;
  }

  /**
   * The POST body for a select's new value ('' resets). Picking an app sets
   * its repo with it; resetting the app clears both.
   */
  function patchFor(s, field, value) {
    if (field !== 'app') return { [field]: value || null };
    if (!value) return { app: null, repo: null };
    const a = ((s.options && s.options.apps) || []).find((x) => x.app === value);
    return { app: value, repo: a && a.repo ? a.repo : null };
  }

  /** The settings as they will be once `patch` is stored: drawn before the server answers. */
  function optimistic(s, patch, defaults) {
    const d = defaults || {};
    const n = JSON.parse(JSON.stringify(s));
    for (const [f, v] of Object.entries(patch)) {
      if (v == null || v === '') {
        delete n.overrides[f];
        if (d[f]) {
          n.settings[f] = d[f].value;
          n.source[f] = d[f].source;
          if (f === 'jobKind' && d[f].why) n.why.jobKind = d[f].why;
        }
      } else {
        n.overrides[f] = v;
        n.settings[f] = v;
        n.source[f] = 'card';
      }
    }
    if (n.settings.mode === 'plan' && !has(n.overrides, 'jobKind')) n.settings.jobKind = 'plan';
    if (n.settings.jobKind && n.settings.jobKind !== 'code') {
      n.settings.delivery = 'none';
      n.source.delivery = 'kind';
    } else if (n.settings.delivery === 'none' && !has(n.overrides, 'delivery') && d.delivery && d.delivery.value && d.delivery.value !== 'none') {
      n.settings.delivery = d.delivery.value;
      n.source.delivery = d.delivery.source;
    }
    return n;
  }

  // ---- The browser half --------------------------------------------------

  /**
   * One per page. `getJson(path)` and `post(path, body)` are the page's own
   * (post sends X-PA and the page token); `setEditing(bool)` holds the board's
   * refresh while a menu is open.
   */
  function controller({ getJson, post, toast, setEditing }) {
    const cache = new Map(); // id → { data, defaults, at, pending }
    const queue = [];
    let inflight = 0;
    let open = null; // { id, wrap, menu, button, render }

    const url = (id) => `api/commitments/${id}/dispatch-settings`;

    function store(id, data) {
      const e = cache.get(id) || {};
      e.data = data;
      e.defaults = rememberDefaults(e.defaults, data);
      e.at = Date.now();
      e.error = null;
      cache.set(id, e);
      paint(id);
      return e;
    }

    function load(id) {
      const e = cache.get(id) || {};
      if (e.pending) return e.pending;
      // A change made while this was on its way wins: its own answer is newer.
      const seq = e.seq || 0;
      e.pending = getJson(url(id)).then((data) => ((e.seq || 0) === seq ? store(id, data) : e)).finally(() => { e.pending = null; });
      cache.set(id, e);
      return e.pending;
    }

    function pump() {
      while (inflight < 2 && queue.length) {
        const id = queue.shift();
        inflight += 1;
        load(id).catch(() => {}).finally(() => { inflight -= 1; pump(); });
      }
    }

    /** Fetch a card's settings in the background unless they are fresh. */
    function prefetch(id) {
      const e = cache.get(id);
      if (e && (e.pending || (e.data && Date.now() - e.at < 5 * 60_000))) return;
      if (!queue.includes(id)) queue.push(id);
      setTimeout(pump, 0);
    }

    // Every summary line on the page for this card (the board may have drawn it again).
    function paint(id) {
      const e = cache.get(id);
      for (const n of document.querySelectorAll(`[data-dispatch-summary="${id}"]`)) {
        n.textContent = summary(e && e.data);
        n.title = e && e.data ? `What Do sends — ${e.data.why.jobKind}${e.data.settings.jobKind === 'code' ? `; end state: ${e.data.why.delivery}` : ''}` : '';
      }
      if (open && open.id === id) open.render();
    }

    function h(tag, props, ...kids) {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
      for (const k of kids) if (k != null) n.append(k);
      return n;
    }

    function close(restoreFocus) {
      if (!open) return;
      const o = open;
      open = null;
      o.menu.remove();
      o.button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      setEditing(false);
      if (restoreFocus) o.button.focus();
    }
    function outside(ev) {
      if (open && !open.wrap.contains(ev.target)) close(false);
    }
    function onKey(ev) {
      if (open && ev.key === 'Escape') {
        ev.preventDefault();
        close(true);
      }
    }

    // Store one change: drawn now, POSTed, the server's answer kept — or the
    // old settings back and a toast. Only the newest answer is applied.
    async function change(id, field, value) {
      const e = cache.get(id);
      if (!e || !e.data) return;
      const before = e.data;
      const patch = patchFor(before, field, value);
      e.data = optimistic(before, patch, e.defaults);
      const seq = (e.seq = (e.seq || 0) + 1);
      paint(id);
      try {
        const data = await post(url(id), patch);
        if (e.seq === seq) store(id, data);
      } catch (err) {
        if (e.seq === seq) {
          e.data = before;
          paint(id);
        }
        toast(`could not change ${LABEL[field].toLowerCase()}: ${err.message}`);
      }
    }

    function renderMenu(id, menu) {
      const e = cache.get(id);
      const focused = document.activeElement && menu.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null;
      menu.replaceChildren();
      menu.append(h('div', { class: 'dmenu-head' }, h('strong', { text: `Do #${id} sends` }), h('span', { class: 'dmenu-hint', text: 'saved on this card' })));
      if (!e || !e.data) {
        menu.append(h('div', { class: 'dmenu-hint', text: e && e.error ? `could not load: ${e.error}` : 'loading…' }));
        return;
      }
      if (!e.data.factory) menu.append(h('div', { class: 'dmenu-warn', text: 'The software factory is not set up here (PA_FACTORY_PATH): Do cannot start anything.' }));
      for (const r of rows(e.data, e.defaults)) {
        const sel = h('select', { id: `dm-${id}-${r.field}`, 'data-focus': r.field, disabled: r.disabled || null });
        for (const o of r.options) {
          const opt = h('option', { value: o.value, text: o.label });
          if (o.value === r.value) opt.selected = true;
          sel.append(opt);
        }
        sel.addEventListener('change', () => change(id, r.field, sel.value));
        const reset = r.overridden
          ? h('button', { type: 'button', class: 'dmenu-reset', 'data-focus': `${r.field}-reset`, title: `Back to the default ${r.label.toLowerCase()}`, text: 'reset' })
          : null;
        reset?.addEventListener('click', () => change(id, r.field, ''));
        menu.append(h('div', { class: 'dmenu-row' },
          h('label', { for: sel.id }, r.label, h('span', { class: r.overridden ? 'dmenu-src set' : 'dmenu-src', text: r.badge })),
          h('div', { class: 'dmenu-ctl' }, sel, reset),
          r.note ? h('div', { class: 'dmenu-hint', text: r.note }) : null));
      }
      const again = focused && menu.querySelector(`[data-focus="${focused}"]`);
      (again || (focused && focused.endsWith('-reset') && menu.querySelector(`[data-focus="${focused.slice(0, -6)}"]`)))?.focus();
    }

    function toggle(id, wrap, button) {
      if (open && open.id === id && open.wrap === wrap) return close(true);
      close(false);
      const menu = h('div', { class: 'dmenu', role: 'dialog', 'aria-label': `Dispatch settings for #${id}`, id: `dmenu-${id}` });
      open = { id, wrap, menu, button, render: () => renderMenu(id, menu) };
      wrap.append(menu);
      button.setAttribute('aria-expanded', 'true');
      setEditing(true);
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
      open.render();
      // Kept on the screen at phone width: shifted left when it would run off the right edge.
      const r = menu.getBoundingClientRect();
      const over = r.right - (document.documentElement.clientWidth - 8);
      if (over > 0) menu.style.left = `${-Math.max(0, Math.min(over, r.left - 8))}px`;
      menu.querySelector('select:not([disabled])')?.focus();
      const e = cache.get(id);
      // Shown from the cache at once; checked against the server behind it
      // when it is more than a few seconds old.
      if (e && e.data && Date.now() - e.at < 15_000) return;
      load(id).catch((err) => {
        const c = cache.get(id) || {};
        c.error = err.message;
        cache.set(id, c);
        if (!(e && e.data)) paint(id);
      });
    }

    /** The card's pieces: its summary line and the ☰ button with its menu. */
    function parts(id) {
      const line = h('div', { class: 'dsum', 'data-dispatch-summary': String(id) });
      const e = cache.get(id);
      line.textContent = summary(e && e.data);
      const button = h('button', {
        type: 'button', class: 'dmenu-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': `dmenu-${id}`,
        title: 'Dispatch settings: runtime, mode, end state, job kind, repo', 'aria-label': `Dispatch settings for #${id}`, text: '☰',
      });
      const wrap = h('span', { class: 'dmenu-wrap' }, button);
      button.addEventListener('click', () => toggle(id, wrap, button));
      prefetch(id);
      return { line, button: wrap };
    }

    return { parts, prefetch, close, isOpen: () => Boolean(open), _cache: cache };
  }

  return { FIELDS, LABEL, summary, badge, rememberDefaults, rows, patchFor, optimistic, controller };
});
