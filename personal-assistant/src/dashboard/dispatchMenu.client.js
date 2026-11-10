'use strict';

// A Plan card's build settings, behind its ☰ button (PLAN.md D30). Do starts
// ONE Claude Code agent (src/build): what is left to choose is the model
// (haiku, sonnet or opus; default sonnet) and, optionally, the run's caps — a
// dollar cap and a wall-clock cap that stop the session. The card shows one
// read-only line of what Do will start ("sonnet · $5 · 2 h"); the ☰ opens a
// small menu, each setting saying whether it is the default or set on this
// card, with a reset. The settings are the server's (src/build/index.ts):
// GET /api/commitments/<id>/build-settings, POST the same path
// {field: value | null}.
//
// Instant: each card's settings are fetched once in the background (two at a
// time) and kept across the board's re-renders; a change is drawn at once,
// then POSTed — a failure puts the old value back and says why.
//
// The pure half (summary, rows, patchFor, optimistic) is required by
// test/dispatchMenu.test.js; the browser gets window.DispatchMenu. Text only.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DispatchMenu = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FIELDS = ['model', 'costCapUsd', 'wallCapMin'];
  const LABEL = { model: 'Model', costCapUsd: 'Cost cap ($)', wallCapMin: 'Time cap (minutes)' };
  const MODEL = { haiku: 'haiku — fast and cheap', sonnet: 'sonnet — the default', opus: 'opus — the most capable' };

  const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null;
  const hours = (min) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);

  /** The one line a card shows: "sonnet · $5 · 2 h". */
  function summary(s) {
    if (!s || !s.settings) return 'build settings…';
    const v = s.settings;
    return [v.model, `$${v.costCapUsd}`, hours(Number(v.wallCapMin))].join(' · ');
  }

  /** The menu's rows, pure: label, value ('' = the default), options for a select, where it came from. */
  function rows(s) {
    const d = (s.options && s.options.defaults) || {};
    return FIELDS.map((f) => {
      const overridden = has(s.overrides, f);
      return {
        field: f,
        label: LABEL[f],
        value: overridden ? s.overrides[f] : '',
        overridden,
        badge: overridden ? 'set on this card' : 'default',
        options: f === 'model'
          ? [{ value: '', label: `default (${d.model || 'sonnet'})` }].concat(((s.options && s.options.models) || []).map((m) => ({ value: m, label: MODEL[m] || m })))
          : null,
        placeholder: d[f] != null ? String(d[f]) : '',
      };
    });
  }

  /** The POST body for one change; '' clears it. */
  function patchFor(_s, field, value) {
    if (value === '' || value == null) return { [field]: null };
    return { [field]: field === 'model' ? String(value) : Number(value) };
  }

  /** The settings as they will look once `patch` is stored: drawn before the server answers. */
  function optimistic(s, patch) {
    const d = (s.options && s.options.defaults) || {};
    const overrides = Object.assign({}, s.overrides);
    const settings = Object.assign({}, s.settings);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) { delete overrides[k]; settings[k] = d[k]; } else { overrides[k] = v; settings[k] = v; }
    }
    return Object.assign({}, s, { overrides, settings });
  }

  function controller({ getJson, post, toast, setEditing }) {
    const cache = new Map(); // id → { data, at, pending, seq }
    const queue = [];
    let inflight = 0;
    let open = null; // { id, wrap, menu, button, render }

    const url = (id) => `api/commitments/${id}/build-settings`;

    function store(id, data) {
      const e = cache.get(id) || {};
      e.data = data;
      e.at = Date.now();
      e.error = null;
      cache.set(id, e);
      paint(id);
      return e;
    }

    function load(id) {
      const e = cache.get(id) || {};
      if (e.pending) return e.pending;
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

    function prefetch(id) {
      const e = cache.get(id);
      if (e && (e.pending || (e.data && Date.now() - e.at < 5 * 60_000))) return;
      if (!queue.includes(id)) queue.push(id);
      setTimeout(pump, 0);
    }

    function paint(id) {
      const e = cache.get(id);
      for (const n of document.querySelectorAll(`[data-dispatch-summary="${id}"]`)) {
        n.textContent = summary(e && e.data);
        n.title = 'What Do starts: one Claude Code agent on this model, stopped at these caps';
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

    async function change(id, field, value) {
      const e = cache.get(id);
      if (!e || !e.data) return;
      const before = e.data;
      const patch = patchFor(before, field, value);
      e.data = optimistic(before, patch);
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
      menu.replaceChildren();
      menu.append(h('div', { class: 'dmenu-head' }, h('strong', { text: `Do #${id} starts` }), h('span', { class: 'dmenu-hint', text: 'saved on this card' })));
      if (!e || !e.data) {
        menu.append(h('div', { class: 'dmenu-hint', text: e && e.error ? `could not load: ${e.error}` : 'loading…' }));
        return;
      }
      for (const r of rows(e.data)) {
        const ctl = r.options
          ? h('select', { id: `dm-${id}-${r.field}`, 'data-focus': r.field })
          : h('input', { id: `dm-${id}-${r.field}`, 'data-focus': r.field, type: 'number', min: '1', step: 'any', placeholder: r.placeholder || null, value: r.overridden ? String(r.value) : null });
        if (r.options) {
          for (const o of r.options) {
            const opt = h('option', { value: o.value, text: o.label });
            if (o.value === r.value) opt.selected = true;
            ctl.append(opt);
          }
        }
        ctl.addEventListener('change', () => change(id, r.field, ctl.value));
        const reset = r.overridden ? h('button', { type: 'button', class: 'dmenu-reset', title: 'Back to the default', text: 'reset' }) : null;
        reset?.addEventListener('click', () => change(id, r.field, ''));
        menu.append(h('div', { class: 'dmenu-row' },
          h('label', { for: ctl.id }, r.label, h('span', { class: r.overridden ? 'dmenu-src set' : 'dmenu-src', text: r.badge })),
          h('div', { class: 'dmenu-ctl' }, ctl, reset)));
      }
    }

    function toggle(id, wrap, button) {
      if (open && open.id === id && open.wrap === wrap) return close(true);
      close(false);
      const menu = h('div', { class: 'dmenu', role: 'dialog', 'aria-label': `Build settings for #${id}`, id: `dmenu-${id}` });
      open = { id, wrap, menu, button, render: () => renderMenu(id, menu) };
      wrap.append(menu);
      button.setAttribute('aria-expanded', 'true');
      setEditing(true);
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
      open.render();
      const r = menu.getBoundingClientRect();
      const over = r.right - (document.documentElement.clientWidth - 8);
      if (over > 0) menu.style.left = `${-Math.max(0, Math.min(over, r.left - 8))}px`;
      menu.querySelector('select, input')?.focus();
      const e = cache.get(id);
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
        title: 'Build settings: model and caps', 'aria-label': `Build settings for #${id}`, text: '☰',
      });
      const wrap = h('span', { class: 'dmenu-wrap' }, button);
      button.addEventListener('click', () => toggle(id, wrap, button));
      prefetch(id);
      return { line, button: wrap };
    }

    return { parts, prefetch, close, isOpen: () => Boolean(open), _cache: cache };
  }

  return { FIELDS, LABEL, summary, rows, patchFor, optimistic, controller };
});
