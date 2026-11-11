'use strict';

// The dashboard's "Proposed card changes" card: the PA chat ("Jarvis") read
// something (a plan, a thread) and proposed a SET of changes to your cards -
// close these, edit those, add new ones - as one card plan (src/cardplans.ts).
// One yes for the lot: untick what you do not want, press Apply. Each change
// then shows done or failed. Discard drops the plan and changes nothing.
//
// Talks to GET /api/cardplans and POST /api/cardplans/<id>/apply|discard with
// X-PA and this page's token (the same as permission.client.js). Self-contained:
// one <script src="cardplan.js"> in index.html (Plan) and talk.html (Ask); the
// card is made here and put in <main id="today"> or [data-permission-card].
// Text only - no HTML sinks.

(function () {
  const STYLE = `
#cardplans { margin-bottom: 14px; }
#cardplans[hidden] { display: none; }
#cardplans .plan { border: 1px solid var(--amber); border-radius: 8px; background: var(--amber-soft); padding: 10px 14px; margin-bottom: 10px; }
#cardplans h2 { margin: 0 0 6px; }
#cardplans h3 { margin: 0 0 4px; font-size: 1em; }
#cardplans .why, #cardplans .src { margin: 0 0 6px; opacity: 0.85; }
#cardplans ul { list-style: none; margin: 0 0 8px; padding: 0; }
#cardplans li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
#cardplans li.off .line { text-decoration: line-through; opacity: 0.6; }
#cardplans li .mark { width: 1.2em; text-align: center; flex: none; }
#cardplans li.s-applied .mark { color: var(--ok); }
#cardplans li.s-failed .mark, #cardplans li .err { color: var(--bad); }
#cardplans .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#cardplans button.yes { background: var(--signal); border-color: var(--signal); color: var(--on-signal); }
#cardplans .msg { color: var(--bad); }`;

  let card = null;
  let plans = [];
  const finished = new Map(); // plan id -> the apply/discard result, shown until dismissed
  const unticked = new Map(); // plan id -> Set of item numbers
  let busy = false;

  function el(tag, props, kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const k of kids || []) e.append(k);
    return e;
  }

  function ensureCard() {
    if (card) return card;
    const main = document.getElementById('today') || document.querySelector('[data-permission-card]');
    if (!main) return null;
    document.head.append(el('style', { textContent: STYLE }));
    card = el('section', { id: 'cardplans', hidden: true });
    card.setAttribute('aria-live', 'polite');
    main.prepend(card);
    return card;
  }

  const metaAtLoad = document.querySelector('meta[name="pa-page"]');
  const tokenAtLoad = metaAtLoad ? metaAtLoad.content : '';
  function token() {
    if (typeof PAGE_TOKEN === 'string' && PAGE_TOKEN) return PAGE_TOKEN; // eslint-disable-line no-undef
    const m = document.querySelector('meta[name="pa-page"]');
    return m ? m.content : tokenAtLoad;
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PA': '1', 'X-PA-Page': token() },
      body: JSON.stringify(body || {}),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  const MARK = { applied: '✓', failed: '✗', skipped: '–', running: '…', pending: '' };
  const open = (i) => i.status === 'pending' || i.status === 'failed';

  function renderPlan(p, done) {
    const off = unticked.get(p.id) || new Set();
    const box = el('div', { className: 'plan', id: `cardplan-${p.id}` });
    box.append(el('h3', { textContent: `#${p.id} ${p.title}` }));
    if (p.rationale) box.append(el('p', { className: 'why', textContent: p.rationale }));
    if (p.sources && p.sources.length) box.append(el('p', { className: 'src', textContent: `From: ${p.sources.join(' · ')}` }));
    const ul = el('ul');
    for (const i of p.items) {
      const li = el('li', { className: `s-${i.status}${open(i) && off.has(i.n) ? ' off' : ''}` });
      if (!done && open(i)) {
        const cb = el('input', { type: 'checkbox', checked: !off.has(i.n), id: `cardplan-${p.id}-${i.n}` });
        cb.addEventListener('change', () => {
          const s = unticked.get(p.id) || new Set();
          if (cb.checked) s.delete(i.n);
          else s.add(i.n);
          unticked.set(p.id, s);
          render();
        });
        li.append(cb);
      } else li.append(el('span', { className: 'mark', textContent: MARK[i.status] || '' }));
      const text = el('label', { className: 'line', textContent: i.line });
      if (!done && open(i)) text.htmlFor = `cardplan-${p.id}-${i.n}`;
      li.append(text);
      if (i.error) li.append(el('span', { className: 'err', textContent: i.error }));
      ul.append(li);
    }
    box.append(ul);

    const row = el('div', { className: 'row' });
    const msg = el('span', { className: 'msg' });
    if (done) {
      row.append(el('span', { textContent: `${done.applied} applied · ${done.failed} failed · ${done.skipped} left out` }));
      const ok = el('button', { type: 'button', textContent: done.failed ? 'Close' : 'Done' });
      ok.addEventListener('click', () => { finished.delete(p.id); render(); refresh(); });
      row.append(ok);
    } else {
      const pending = p.items.filter((i) => open(i) && !off.has(i.n));
      const yes = el('button', { type: 'button', className: 'yes', textContent: `${p.items.some((i) => i.status === 'failed') ? 'Retry' : 'Apply'} ${pending.length} selected`, disabled: !pending.length || busy });
      const no = el('button', { type: 'button', textContent: 'Discard', disabled: busy });
      const go = async (what, body) => {
        busy = true;
        msg.textContent = '';
        yes.disabled = true;
        no.disabled = true;
        try {
          finished.set(p.id, await post(`api/cardplans/${p.id}/${what}`, body));
          unticked.delete(p.id);
          if (what === 'discard') finished.delete(p.id);
        } catch (err) {
          msg.textContent = `Not done: ${err.message}`;
        }
        busy = false;
        if (!msg.textContent) { render(); refresh(); } else { yes.disabled = false; no.disabled = false; }
      };
      yes.addEventListener('click', () => go('apply', { skip: [...off] }));
      no.addEventListener('click', () => go('discard', {}));
      row.append(yes, no);
    }
    row.append(msg);
    box.append(row);
    return box;
  }

  function render() {
    const c = ensureCard();
    if (!c) return;
    c.replaceChildren();
    const shown = plans.filter((p) => !finished.has(p.id));
    const results = [...finished.values()];
    if (!shown.length && !results.length) {
      c.hidden = true;
      return;
    }
    c.append(el('h2', { textContent: 'Proposed card changes' }));
    for (const p of shown) c.append(renderPlan(p, null));
    for (const r of results) c.append(renderPlan(r, r));
    c.hidden = false;
    const want = /^#cardplan-(\d+)$/.exec(location.hash || '');
    if (want) {
      const t = document.getElementById(`cardplan-${want[1]}`);
      if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest' });
    }
  }

  function refresh() {
    if (busy) return;
    fetch('api/cardplans')
      .then((r) => (r.ok ? r.json() : { plans: [] }))
      .then((s) => {
        if (busy) return;
        plans = Array.isArray(s.plans) ? s.plans : [];
        render();
      })
      .catch(() => {});
  }

  function start() {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
