'use strict';

// The turn log page (/turns): GET /api/turns, newest first, filtered by channel,
// route and words; "Older" pages by id; a turn's "What the router saw" loads
// GET /api/turns/<id> (the snapshot and the last turns). Refreshes the first
// page every 10 s while it is showing. Text only - no HTML sinks.

(function () {
  const list = document.getElementById('list');
  const more = document.getElementById('more');
  const state = { channel: '', route: '', q: '', oldest: null };
  let timer = null;

  function el(tag, props, kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const k of kids || []) if (k != null) e.append(k);
    return e;
  }

  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? String(iso || '') : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const secs = (ms) => (ms == null ? null : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

  function line(cls, label, text) {
    return el('div', { className: `line ${cls}` }, [el('b', { textContent: label }), el('span', { textContent: text })]);
  }

  function routeLine(t) {
    const box = el('span', { className: 'route' });
    box.append(`${t.route === 'answer' ? 'answered here' : 'handed off'}${t.overridden ? ' (guard: looks like an action)' : ''} · ${t.router || '?'}${t.decisionMs != null ? ` · ${t.decisionMs} ms` : ''}${t.fellBack ? ' · fell back' : ''}`);
    if (t.p) {
      const bars = el('div', { className: 'bars' });
      for (const [k, label] of [['answer_here', 'answer'], ['hand_off', 'look up'], ['action', 'action']]) {
        if (t.p[k] == null) continue;
        const v = Number(t.p[k]);
        const fill = el('em');
        fill.style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
        bars.append(el('span', { className: 'pbar' }, [label, el('i', {}, [fill]), v.toFixed(2)]));
      }
      box.append(bars);
    }
    if (t.signals) {
      const s = t.signals;
      const chips = el('div');
      if (s.tool) chips.append(el('span', { className: 'chip', textContent: `tool: ${s.tool}${s.toolConfidence != null ? ` ${Number(s.toolConfidence).toFixed(2)}` : ''}` }));
      if (s.effort != null) chips.append(el('span', { className: 'chip', textContent: `effort: ${s.effort}` }));
      if (s.actsOutside != null) chips.append(el('span', { className: 'chip', textContent: `acts outside: ${Number(s.actsOutside).toFixed(2)}` }));
      box.append(chips);
    }
    return el('div', { className: 'line' }, [el('b', { textContent: 'route' }), box]);
  }

  function card(t) {
    const meta = el('div', { className: 'meta' }, [
      el('span', { textContent: `#${t.id}` }),
      el('span', { textContent: when(t.at) }),
      el('span', { textContent: t.channel }),
      el('span', { className: `st-${t.status}`, textContent: t.status === 'open' ? 'waiting for the chat' : t.status }),
      t.fastMs != null ? el('span', { textContent: `fast lane ${secs(t.fastMs)}` }) : null,
      t.replyMs != null ? el('span', { textContent: `chat ${secs(t.replyMs)}` }) : null,
      t.chatCostUsd != null ? el('span', { textContent: `$${Number(t.chatCostUsd).toFixed(3)} equiv.` }) : null,
    ]);
    const box = el('article', { className: `turn s-${t.status}` }, [meta, line('you', 'you', t.text)]);
    if (t.route) box.append(routeLine(t));
    if (t.fastSay) box.append(line('fast', 'jarvis', t.fastSay));
    if (t.tools && t.tools.length) {
      const chips = el('span');
      for (const n of t.tools) chips.append(el('span', { className: 'chip', textContent: n }));
      box.append(el('div', { className: 'line' }, [el('b', { textContent: 'tools' }), chips]));
    }
    if (t.reply) box.append(line('chat', 'chat', t.reply));
    if (t.error) box.append(line('err', 'error', `${t.error}${t.handoffError ? ` (${t.handoffError})` : ''}`));
    if (t.channel === 'voice') {
      const d = el('details', {}, [el('summary', { textContent: 'What the router saw' })]);
      d.addEventListener('toggle', () => {
        if (!d.open || d.dataset.loaded) return;
        d.dataset.loaded = '1';
        fetch(`api/turns/${t.id}`).then((r) => r.json()).then((full) => {
          if (full.reason) d.append(el('pre', { textContent: `reason: ${full.reason}` }));
          for (const h of full.history || []) d.append(el('pre', { textContent: `before (${h.type}): ${h.text}` }));
          d.append(el('pre', { textContent: full.context || '(no snapshot)' }));
        }).catch((e) => d.append(el('pre', { textContent: `could not load: ${e.message}` })));
      });
      box.append(d);
    }
    return box;
  }

  async function load({ append = false } = {}) {
    const q = new URLSearchParams({ limit: '50' });
    if (state.channel) q.set('channel', state.channel);
    if (state.route) q.set('route', state.route);
    if (state.q) q.set('q', state.q);
    if (append && state.oldest) q.set('before', String(state.oldest));
    let data;
    try {
      data = await (await fetch(`api/turns?${q}`)).json();
    } catch (e) {
      if (!append) list.replaceChildren(el('p', { className: 'muted', textContent: `Could not load the turn log: ${e.message}` }));
      return;
    }
    const turns = data.turns || [];
    if (!append) {
      // Keep open "What the router saw" panels across a refresh by leaving an unchanged page alone.
      const sig = JSON.stringify(turns.map((t) => [t.id, t.status, t.reply && t.reply.length, t.fastSay]));
      if (list.dataset.sig === sig) return;
      list.dataset.sig = sig;
      list.replaceChildren();
      if (!turns.length) list.append(el('p', { className: 'muted', textContent: data.enabled === false ? 'The turn log is off (PA_TURN_LOG=off).' : 'Nothing logged yet. Say something to Jarvis.' }));
    }
    for (const t of turns) list.append(card(t));
    if (turns.length) state.oldest = turns[turns.length - 1].id;
    more.hidden = turns.length < 50;
  }

  function seg(id, key) {
    const g = document.getElementById(id);
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const x of g.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      state[key] = b.dataset.v;
      list.dataset.sig = '';
      load();
    });
  }
  seg('channel', 'channel');
  seg('route', 'route');
  let typing = null;
  document.getElementById('q').addEventListener('input', (e) => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.q = e.target.value.trim();
      list.dataset.sig = '';
      load();
    }, 250);
  });
  more.addEventListener('click', () => load({ append: true }));

  load();
  timer = setInterval(() => {
    if (!document.hidden && window.scrollY < 200) load();
  }, 10_000);
  window.addEventListener('pagehide', () => clearInterval(timer));
})();
