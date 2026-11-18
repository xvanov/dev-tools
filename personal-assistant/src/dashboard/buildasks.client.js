'use strict';

// The dashboard's "Build agents need you" card (Plan): open asks of live Build agents, with their questions,
// at the top of <main id="today"> next to "Waiting for your yes". A decisions questionnaire is answered here
// (click an option or type, one Submit); a plain question takes a typed reply. Both POST the board's own
// reply route (api/build/<run>/reply, same as the Build board, `pa run reply` and the chat's build_reply),
// so whoever answers first wins and the other gets the server's "was just answered" message.
//
// Reads GET api/build/needs. Self-contained: one <script src="buildasks.js"> in index.html. Text only - the
// agent's question and options are data, set with textContent, never as HTML.

(function () {
  const STYLE = `
#buildasks { margin-bottom: 14px; }
#buildasks[hidden] { display: none; }
#buildasks .ask { border: 1px solid var(--amber); border-radius: 8px; background: var(--amber-soft); padding: 10px 14px; margin-bottom: 10px; display: grid; gap: 8px; }
#buildasks h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--ink); }
#buildasks .dq { display: grid; gap: 4px; }
#buildasks .opt { display: flex; gap: 6px; align-items: center; }
#buildasks input[type=text] { font: inherit; padding: 4px 8px; min-width: 0; }
#buildasks .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#buildasks button.yes { background: var(--signal); border-color: var(--signal); color: var(--on-signal); }
#buildasks .err { color: var(--bad); }`;

  let card = null;
  let needs = [];
  let signature = '';
  const drafts = {}; // ask id -> {question id: {opt, text}}

  function el(tag, props, kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const k of kids || []) if (k) e.append(k);
    return e;
  }

  function ensureCard() {
    if (card) return card;
    const main = document.getElementById('today');
    if (!main) return null;
    document.head.append(el('style', { textContent: STYLE }));
    card = el('section', { id: 'buildasks', hidden: true });
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

  async function reply(run, body) {
    const res = await fetch(`api/build/${run}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PA': '1', 'X-PA-Page': token() },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }

  /** Per question the typed text (when free text is allowed), else the picked option; unanswered ones are left out. */
  function answersOf(n) {
    const draft = drafts[n.id] || {};
    const answers = {};
    for (const q of n.questions) {
      const d = draft[q.id] || {};
      const text = String(d.text || '').trim();
      const v = q.allowFree !== false && text ? text : d.opt || '';
      if (v) answers[q.id] = v;
    }
    return answers;
  }

  function send(n, button, msg, body) {
    button.disabled = true;
    msg.textContent = '';
    reply(n.run, { ...body, ask: n.id })
      .then(() => {
        delete drafts[n.id];
        needs = needs.filter((x) => x.id !== n.id);
        render(true);
      })
      .catch((err) => {
        msg.textContent = `Not sent: ${err.message}`;
        button.disabled = false;
        refresh(); // someone else may have answered it already
      });
  }

  function renderAsk(n) {
    const box = el('div', { className: 'ask' });
    const msg = el('span', { className: 'err' });
    const go = el('button', { type: 'button', className: 'yes', textContent: n.questions ? 'Submit answers' : 'Reply' });
    box.append(el('h2', { textContent: `Build agent #${n.run}: ${n.task}` }));
    if (n.questions) {
      const draft = (drafts[n.id] = drafts[n.id] || {});
      for (const q of n.questions) {
        const d = (draft[q.id] = draft[q.id] || { opt: '', text: '' });
        const row = el('div', { className: 'dq' }, [el('div', { textContent: q.text })]);
        for (const o of q.options || []) {
          const radio = el('input', { type: 'radio', name: `ba-${n.id}-${q.id}`, value: o, checked: d.opt === o });
          radio.addEventListener('change', () => { d.opt = o; });
          row.append(el('label', { className: 'opt' }, [radio, el('span', { textContent: o })]));
        }
        if (q.allowFree !== false) {
          const free = el('input', { type: 'text', value: d.text || '', placeholder: (q.options || []).length ? 'or type your own' : 'Your answer' });
          free.setAttribute('aria-label', q.text);
          free.addEventListener('input', () => { d.text = free.value; });
          free.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
          row.append(free);
        }
        box.append(row);
      }
      go.addEventListener('click', () => {
        const answers = answersOf(n);
        if (!Object.keys(answers).length) { msg.textContent = 'Answer at least one question.'; return; }
        send(n, go, msg, { answers });
      });
    } else {
      box.append(el('div', { textContent: n.question }));
      const input = el('input', { type: 'text', placeholder: 'Answer the agent' });
      input.setAttribute('aria-label', `Answer to run ${n.run}`);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
      go.addEventListener('click', () => {
        if (!input.value.trim()) { msg.textContent = 'Type an answer first.'; return; }
        send(n, go, msg, { text: input.value });
      });
      box.append(input);
    }
    box.append(el('div', { className: 'row' }, [go, msg]));
    return box;
  }

  function render(force) {
    const c = ensureCard();
    if (!c) return;
    const sig = JSON.stringify(needs.map((n) => [n.id, n.question]));
    // A poll that changed nothing, or that lands while a field is being typed in, must not wipe the draft.
    if (!force && (sig === signature || c.contains(document.activeElement))) return;
    signature = sig;
    c.replaceChildren(...needs.map(renderAsk));
    c.hidden = !needs.length;
  }

  function refresh() {
    fetch('api/build/needs', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        needs = (j.needs_you || []).filter((n) => n.id != null && (n.kind === 'ask' || n.kind === 'decisions'));
        render(false);
      })
      .catch(() => {});
  }

  function start() {
    refresh();
    setInterval(refresh, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
