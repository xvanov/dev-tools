'use strict';
// The Chat tab: the dashboard's box onto the PA chat — the same live Claude
// Code session as termhub's "PA chat" and the voice page, so all three are
// one conversation (src/chat/feed.js). Loaded after the page's main script
// and uses its helpers (el, post, getJson, toast). Every value goes in through
// textContent, never an HTML sink: replies quote other people's messages.

const chat = { ids: new Set(), es: null, status: null, url: null };

function chatEls() {
  return {
    log: document.getElementById('chat-log'),
    state: document.getElementById('chat-state'),
    activity: document.getElementById('chat-activity'),
    open: document.getElementById('chat-open'),
    input: document.getElementById('chat-input'),
    send: document.getElementById('chat-send'),
    dot: document.getElementById('chatdot'),
  };
}

function chatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function chatAdd(e) {
  if (!e || !e.id || chat.ids.has(e.id)) return;
  if (e.type !== 'user' && e.type !== 'assistant') return;
  chat.ids.add(e.id);
  const { log } = chatEls();
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const meta = [chatTime(e.at), e.source === 'voice' ? 'spoken' : null].filter(Boolean).join(' · ');
  log.append(el('div', { class: `chat-msg ${e.type}` }, String(e.text || ''), el('span', { class: 'chat-meta' }, meta)));
  if (nearBottom || e.type === 'user') log.scrollTop = log.scrollHeight;
}

const CHAT_STATE = { thinking: 'working…', idle: 'idle', offline: 'offline — sending a message starts it' };

function chatStatus(text) {
  chat.status = text;
  const { state, dot, activity } = chatEls();
  state.textContent = CHAT_STATE[text] || text;
  state.className = `chat-state ${text}`;
  dot.className = `dot ${text}`;
  if (text !== 'thinking') activity.textContent = '';
  if (text !== 'offline' && !chat.url) chatSession();
  if (text === 'offline') chatLink(null);
}

function chatLink(url) {
  chat.url = url;
  const { open } = chatEls();
  open.hidden = !url;
  if (url) open.href = url;
}

async function chatSession() {
  try {
    const s = await getJson('api/chat/session');
    chatLink(s && s.url);
  } catch { /* the link is a convenience */ }
}

async function chatHistory() {
  try {
    const r = await getJson('api/chat/history?limit=100');
    const { log } = chatEls();
    const list = (r && r.messages) || [];
    if (!list.length && !chat.ids.size) log.replaceChildren(el('div', { class: 'empty' }, 'No messages yet. Say hello.'));
    for (const m of list) chatAdd(m);
    log.scrollTop = log.scrollHeight;
  } catch (err) {
    chatEls().log.replaceChildren(el('div', { class: 'empty' }, `Could not load the chat: ${err.message}`));
  }
}

function chatConnect() {
  if (chat.es) return;
  const es = new EventSource('api/chat/stream');
  chat.es = es;
  let dropped = false;
  es.onmessage = (msg) => {
    let e;
    try { e = JSON.parse(msg.data); } catch { return; }
    if (e.type === 'status') chatStatus(e.text);
    else if (e.type === 'activity') chatEls().activity.textContent = String(e.text || '');
    else chatAdd(e);
  };
  // EventSource reconnects by itself; fill what was missed while it was down.
  es.onopen = () => { if (dropped) chatHistory(); dropped = false; };
  es.onerror = () => { dropped = true; chatEls().state.textContent = 'reconnecting…'; };
}

async function chatSend() {
  const { input, send } = chatEls();
  const text = input.value.trim();
  if (!text) return;
  send.disabled = true;
  send.textContent = '…';
  try {
    const r = await post('api/chat', { text, source: 'typed' });
    // The stream sends it too; shown here as well in case the stream is down.
    chatAdd({ id: r.id, type: 'user', text, at: new Date().toISOString(), source: 'typed' });
    input.value = '';
    chatGrow();
  } catch (err) {
    toast(err.message);
  } finally {
    send.disabled = false;
    send.textContent = 'Send';
    input.focus();
  }
}

function chatGrow() {
  const { input } = chatEls();
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 2, 200)}px`;
}

// Called by route() whenever the Chat tab is shown.
function chatShown() {
  const { log, input } = chatEls();
  log.scrollTop = log.scrollHeight;
  input.focus();
}

(() => {
  const { input } = chatEls();
  document.getElementById('chat-form').addEventListener('submit', (ev) => { ev.preventDefault(); chatSend(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); chatSend(); }
  });
  input.addEventListener('input', chatGrow);
  // History first, then the stream, so messages land in order. Connected on
  // every tab, so the tab's dot shows when the assistant is working.
  chatHistory().then(chatConnect);
  if ((location.hash || '').startsWith('#chat')) chatEls().input.focus();
})();
