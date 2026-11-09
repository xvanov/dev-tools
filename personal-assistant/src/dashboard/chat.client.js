'use strict';
// Ask's Text mode (talk.html): the typed side of the PA chat, the same live
// Claude Code session that Ask speaks with and Run shows as a terminal, so it
// is one conversation (src/chat/feed.js). It used to be the dashboard's Chat
// tab. Ask's panel switches between Voice (the face, default) and Text (this
// transcript and a box to type in); the choice is remembered in this browser
// (jarvis.talk.mode). Voice mode has no buttons; in Text mode a pending
// "shall I?" shows its Approve / Deny card (permission.client.js), mounted at
// [data-permission-card].
//
// Self-contained: one function scope, its own helpers, nothing global but
// window.JarvisChat. Every value goes in through textContent, never an HTML
// sink: replies quote other people's messages. Relative URLs, so it works
// under termhub's /pa/ too.

(function jarvisChat() {
  const MODE_KEY = 'jarvis.talk.mode';
  const chat = { ids: new Set(), es: null, status: null, url: null, started: false };
  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }

  async function getJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  async function post(path, body) {
    const meta = document.querySelector('meta[name="pa-page"]');
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PA': '1', 'X-PA-Page': meta ? meta.content : '' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function say(text) {
    const n = $('chat-activity');
    if (n) n.textContent = text;
  }

  function chatTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function add(e) {
    if (!e || !e.id) return;
    if (e.type !== 'user' && e.type !== 'assistant') return;
    // A streamed answer (the SDK engine): partial events carry the text so far
    // under the id the final one will have; the same line is updated in place.
    const shown = chat.lines && chat.lines.get(e.id);
    if (shown) {
      if (shown.partial) {
        shown.node.textContent = String(e.text || '');
        shown.partial = Boolean(e.partial);
      }
      return;
    }
    if (chat.ids.has(e.id)) return;
    chat.ids.add(e.id);
    if (e.partial || e.type === 'assistant') {
      chat.lines = chat.lines || new Map();
      if (chat.lines.size > 200) chat.lines.delete(chat.lines.keys().next().value);
    }
    const log = $('chat-log');
    const empty = log.querySelector('.empty');
    if (empty) empty.remove();
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const meta = [e.type === 'user' ? 'you' : 'Jarvis', chatTime(e.at), e.source === 'voice' ? 'spoken' : null].filter(Boolean).join(' · ');
    const body = el('div', { class: 'chat-text' }, String(e.text || ''));
    log.append(el('div', { class: `chat-msg ${e.type}` }, el('span', { class: 'chat-meta' }, meta), body));
    if (chat.lines && e.type === 'assistant') chat.lines.set(e.id, { node: body, partial: Boolean(e.partial) });
    if (nearBottom || e.type === 'user') log.scrollTop = log.scrollHeight;
  }

  const STATE = { thinking: 'working…', idle: 'idle', offline: 'offline — sending a message starts it' };

  function status(text) {
    chat.status = text;
    const state = $('chat-state');
    state.textContent = STATE[text] || text;
    state.className = `chat-state ${text}`;
    if (text !== 'thinking') say('');
    if (text !== 'offline' && !chat.url) session();
    if (text === 'offline') link(null);
  }

  function link(url) {
    chat.url = url;
    const open = $('chat-open');
    open.hidden = !url;
    if (url) open.href = url;
  }

  async function session() {
    try {
      const s = await getJson('api/chat/session');
      link(s && /^https?:\/\//.test(s.url || '') ? s.url : null);
    } catch { /* the link is a convenience */ }
  }

  async function history() {
    try {
      const r = await getJson('api/chat/history?limit=100');
      const log = $('chat-log');
      const list = (r && r.messages) || [];
      if (!list.length && !chat.ids.size) log.replaceChildren(el('div', { class: 'empty' }, 'No messages yet. Say hello.'));
      for (const m of list) add(m);
      log.scrollTop = log.scrollHeight;
    } catch (err) {
      $('chat-log').replaceChildren(el('div', { class: 'empty' }, `Could not load the conversation: ${err.message}`));
    }
  }

  function connect() {
    if (chat.es || !window.EventSource) return;
    let dropped = false;
    const onmessage = (msg) => {
      let e;
      try { e = JSON.parse(msg.data); } catch { return; }
      if (e.type === 'status') status(e.text);
      else if (e.type === 'activity') say(String(e.text || ''));
      else add(e);
    };
    // EventSource reconnects by itself; fill what was missed while it was down.
    const onopen = () => { if (dropped) history(); dropped = false; };
    const onerror = () => { dropped = true; $('chat-state').textContent = 'reconnecting…'; };
    // The tab's one chat stream (nav.js), shared with Ask's voice page.
    if (window.JarvisNav && window.JarvisNav.streams) {
      chat.es = window.JarvisNav.streams.chat({ onmessage, onopen, onerror });
      return;
    }
    const es = new EventSource('api/chat/stream');
    chat.es = es;
    es.onmessage = onmessage;
    es.onopen = onopen;
    es.onerror = onerror;
  }

  async function send() {
    const input = $('chat-input');
    const button = $('chat-send');
    const text = input.value.trim();
    if (!text) return;
    button.disabled = true;
    // Optimistic: the line shows at once, marked as sending, and is confirmed by the stream.
    const pending = el('div', { class: 'chat-msg user sending' }, el('span', { class: 'chat-meta' }, 'you · sending…'), el('div', { class: 'chat-text' }, text));
    const log = $('chat-log');
    const empty = log.querySelector('.empty');
    if (empty) empty.remove();
    log.append(pending);
    log.scrollTop = log.scrollHeight;
    input.value = '';
    grow();
    try {
      const r = await post('api/chat', { text, source: 'typed' });
      pending.remove();
      add({ id: r.id, type: 'user', text, at: new Date().toISOString(), source: 'typed' });
    } catch (err) {
      pending.remove();
      input.value = text;
      grow();
      say(`Not sent: ${err.message}`);
    } finally {
      button.disabled = false;
      input.focus();
    }
  }

  function grow() {
    const input = $('chat-input');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 2, 200)}px`;
  }

  // History first, then the stream, so messages land in order. Only once Text
  // mode is first shown: in Voice mode the page already follows the stream itself.
  function start() {
    if (chat.started) return;
    chat.started = true;
    history().then(connect);
  }

  // ---- the mode switch ------------------------------------------------------------
  function readMode() { try { return localStorage.getItem(MODE_KEY) === 'text' ? 'text' : 'voice'; } catch { return 'voice'; } }
  function setMode(mode, remember) {
    const text = mode === 'text';
    document.documentElement.setAttribute('data-talk-mode', text ? 'text' : 'voice');
    $('textmode').hidden = !text;
    for (const b of document.querySelectorAll('[data-talk-mode-pick]')) b.setAttribute('aria-pressed', String(b.dataset.talkModePick === (text ? 'text' : 'voice')));
    if (remember) { try { localStorage.setItem(MODE_KEY, text ? 'text' : 'voice'); } catch { /* storage off */ } }
    if (text) {
      start();
      const log = $('chat-log');
      log.scrollTop = log.scrollHeight;
      if (remember) $('chat-input').focus();
    }
  }

  function wire() {
    $('chat-form').addEventListener('submit', (ev) => { ev.preventDefault(); send(); });
    const input = $('chat-input');
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
    });
    input.addEventListener('input', grow);
    for (const b of document.querySelectorAll('[data-talk-mode-pick]')) {
      b.addEventListener('click', () => {
        setMode(b.dataset.talkModePick, true);
        // On a phone the panel covers the page: picking a mode closes it.
        if (window.JarvisNav && matchMedia('(max-width: 760px)').matches) window.JarvisNav.settings.set(false);
      });
    }
    setMode(readMode(), false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.JarvisChat = { setMode, mode: () => (document.documentElement.getAttribute('data-talk-mode') === 'text' ? 'text' : 'voice') };
})();
