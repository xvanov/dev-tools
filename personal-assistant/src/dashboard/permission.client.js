'use strict';

// The dashboard's "Waiting for your yes" card: the PA chat ("Jarvis") parked
// on a permission prompt, at the top of the board, with Approve and Deny for
// the chat's own actions. Talk answers the same prompt by voice; this is the
// click path. Both go to POST /api/chat/permission with X-PA and this page's
// token, and the server reads the session's screen before the one keystroke
// (src/chat/permission.js). Any other prompt (a shell command, an edit) is
// listed with a link to answer it in termhub.
//
// Self-contained: one <script src="permission.js"> in index.html (Plan) and in
// talk.html (Ask's Text mode); the card is made here and put first in
// <main id="today">, or in the page's [data-permission-card]. Text only — no
// HTML sinks.

(function () {
  const STYLE = `
#chatyes { border: 1px solid var(--amber); border-radius: 8px; background: var(--amber-soft); padding: 10px 14px; margin-bottom: 14px; }
#chatyes[hidden] { display: none; }
#chatyes h2 { margin: 0 0 6px; }
#chatyes .what { margin: 0 0 8px; }
#chatyes .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#chatyes button.yes { background: var(--signal); border-color: var(--signal); color: var(--on-signal); }
#chatyes .err { color: var(--bad); }`;

  let card = null;
  let current = null;
  let sessionUrl = null;

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
    card = el('section', { id: 'chatyes', hidden: true });
    card.setAttribute('aria-live', 'polite');
    main.prepend(card);
    return card;
  }

  // Plan's script reads the token once and removes its meta tag (PAGE_TOKEN in
  // index.html), so look there first; Ask keeps the tag.
  function token() {
    if (typeof PAGE_TOKEN === 'string' && PAGE_TOKEN) return PAGE_TOKEN; // eslint-disable-line no-undef
    const m = document.querySelector('meta[name="pa-page"]');
    return m ? m.content : '';
  }

  function render() {
    const c = ensureCard();
    if (!c) return;
    c.replaceChildren();
    if (!current) {
      c.hidden = true;
      return;
    }
    const what = String(current.ask || current.text || 'an action').replace(/…$/, '');
    c.append(el('h2', { textContent: 'Waiting for your yes' }), el('p', { className: 'what', textContent: `Jarvis: ${what}` }));
    const row = el('div', { className: 'row' });
    if (current.approvable) {
      const yes = el('button', { type: 'button', className: 'yes', textContent: 'Approve' });
      const no = el('button', { type: 'button', textContent: 'Deny' });
      const msg = el('span', { className: 'err' });
      const go = async (answer) => {
        yes.disabled = true;
        no.disabled = true;
        msg.textContent = '';
        try {
          const res = await fetch('api/chat/permission', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-PA': '1', 'X-PA-Page': token() },
            body: JSON.stringify({ answer, toolUseId: current.toolUseId, via: 'dashboard' }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          current = null;
          render();
        } catch (err) {
          msg.textContent = `Not answered: ${err.message}`;
          yes.disabled = false;
          no.disabled = false;
        }
      };
      yes.addEventListener('click', () => go('yes'));
      no.addEventListener('click', () => go('no'));
      row.append(yes, no, msg);
    } else {
      row.append(el('span', { textContent: 'Answer this one in termhub.' }));
    }
    if (sessionUrl && /^https?:\/\//.test(sessionUrl)) row.append(el('a', { href: sessionUrl, target: '_blank', rel: 'noopener', textContent: 'open the session' }));
    c.append(row);
    c.hidden = false;
  }

  function show(p) {
    current = p && !p.cleared && p.toolUseId ? p : null;
    render();
  }

  function refresh() {
    fetch('api/chat/session')
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => {
        sessionUrl = s.url || null;
        show(s.permission || null);
      })
      .catch(() => {});
  }

  function connect() {
    if (!window.EventSource) return;
    const es = new EventSource('api/chat/stream');
    es.onmessage = (m) => {
      let ev;
      try {
        ev = JSON.parse(m.data);
      } catch {
        return;
      }
      if (ev && ev.type === 'permission') show(ev);
    };
    es.onopen = refresh;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { refresh(); connect(); });
  else {
    refresh();
    connect();
  }
})();
