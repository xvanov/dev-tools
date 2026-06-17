'use strict';

// termhub UI — manages the terminals on THIS machine (one server per machine).

const Term = window.Terminal;
const FitAddonCtor = (window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon)) || null;
const WebglAddonCtor = (window.WebglAddon && (window.WebglAddon.WebglAddon || window.WebglAddon)) || null;

const TERM_THEME = {
  background: '#15171c', foreground: '#d7dae0', cursor: '#6aa9ff',
  black: '#15171c', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
  brightBlack: '#5c6370', brightWhite: '#ffffff',
};

// Escape sequences for the on-screen key bar.
const KEY_SEQ = {
  esc: '\x1b', tab: '\t', 'ctrl-c': '\x03',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
};

const state = {
  machine: '',
  sessions: [],
  open: new Map(), // id -> term object
  activeId: null,
  ctrlArmed: false,
};

const $ = (sel) => document.querySelector(sel);
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---- data refresh ---------------------------------------------------------

let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const s = await api('/api/sessions');
      state.machine = s.machine || '';
      state.sessions = s.sessions || [];
      $('#machine-name').textContent = state.machine;
      const live = state.sessions.filter((x) => x.alive).length;
      $('#status-line').textContent = `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'} (${live} running)`;
    } catch (e) {
      $('#status-line').textContent = 'server unreachable';
    }
    renderSessions();
    renderTabs();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function renderSessions() {
  const list = $('#session-list');
  list.innerHTML = '';
  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'No sessions yet.';
    list.appendChild(empty);
    return;
  }
  for (const s of state.sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.alive ? '' : ' dead') + (s.id === state.activeId ? ' active' : '');
    item.innerHTML =
      `<span class="status${s.busy ? ' busy' : ''}" title="${s.busy ? 'working' : 'idle'}"></span>` +
      `<span class="title">${escapeHtml(s.title || s.id)}</span>` +
      `<button class="rename" title="Rename session">&#9998;</button>` +
      `<button class="kill" title="Kill session">&#10005;</button>`;
    item.querySelector('.title').onclick = () => { openTerminal(s.id, s.title); if (isMobile()) closeDrawer(); };
    item.querySelector('.rename').onclick = (ev) => { ev.stopPropagation(); renameSession(s.id, s.title); };
    item.querySelector('.kill').onclick = (ev) => { ev.stopPropagation(); killSession(s.id); };
    list.appendChild(item);
  }
}

function renderTabs() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  for (const [id, t] of state.open) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === state.activeId ? ' active' : '');
    tab.innerHTML = `<span>${escapeHtml(t.title || id)}</span>` +
      `<button class="tab-close" title="Close tab">&#10005;</button>`;
    tab.onclick = () => setActive(id);
    tab.querySelector('.tab-close').onclick = (ev) => { ev.stopPropagation(); closeTab(id); };
    bar.appendChild(tab);
  }
  $('#empty-state').classList.toggle('hidden', state.open.size > 0);
  const active = state.open.get(state.activeId);
  $('#active-title').textContent = active ? (active.title || active.id) : 'termhub';
}

// ---- terminal lifecycle ---------------------------------------------------

function openTerminal(id, title) {
  if (state.open.has(id)) { setActive(id); return; }

  const pane = document.createElement('div');
  pane.className = 'term-pane';
  $('#terminals').appendChild(pane);

  const term = new Term({
    scrollback: 10000,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: isMobile() ? 12 : 13,
    cursorBlink: true,
    theme: TERM_THEME,
  });
  const fit = FitAddonCtor ? new FitAddonCtor() : null;
  if (fit) term.loadAddon(fit);
  term.open(pane);

  // GPU renderer — far faster redraws on mobile (smoother when Claude repaints on
  // scroll). Falls back to the default DOM renderer if WebGL is unavailable/lost.
  if (WebglAddonCtor) {
    try {
      const webgl = new WebglAddonCtor();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
      term.loadAddon(webgl);
    } catch {}
  }

  const t = { id, title, term, fit, pane, ws: null, attempts: 0, closing: false, reconnectTimer: null, ro: null };
  state.open.set(id, t);
  wireTouchScroll(t);

  // Keep the PTY in lock-step with the rendered size: any layout change (rotate,
  // keyboard open/close, font reflow) refits and pushes a resize. Without this
  // the terminal and PTY drift apart and output gets mangled.
  if (window.ResizeObserver) {
    t.ro = new ResizeObserver(() => scheduleFit(t));
    t.ro.observe(pane);
  }

  term.onData((data) => {
    // Apply a pending Ctrl modifier from the on-screen key bar to the next char.
    if (state.ctrlArmed && data.length === 1) {
      const c = data.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) data = String.fromCharCode(c - 96); // ctrl-a..ctrl-z
      setCtrlArmed(false);
    }
    sendInput(t, data);
  });
  term.onResize(({ cols, rows }) => {
    if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });

  // Make the pane visible and fit it to the device BEFORE connecting, so the
  // very first thing the terminal knows is its real size.
  setActive(id);
  requestAnimationFrame(() => { if (t.fit) { try { t.fit.fit(); } catch {} } connect(t); });
  renderTabs();
  renderSessions();
}

// Debounced refit: coalesces bursts of layout changes (iOS keyboard animations
// fire dozens of resize events) into one fit + one resize message.
const fitTimers = new WeakMap();
function scheduleFit(t) {
  clearTimeout(fitTimers.get(t));
  fitTimers.set(t, setTimeout(() => {
    if (!state.open.has(t.id) || !t.fit) return;
    try { t.fit.fit(); } catch {}
  }, 80));
}

// ---- touch scrolling ------------------------------------------------------
// Full-screen apps (Claude Code, vim, less) run on the alternate screen with
// mouse tracking on. There, xterm.js has no scrollback to swipe and only relays
// raw touch as mouse moves — which feels dead. We instead translate a vertical
// drag into scroll-wheel events (with flick momentum) so the app scrolls its own
// history smoothly. On the normal buffer we leave xterm's native touch scroll be.

const now = () => (window.performance && performance.now ? performance.now() : Date.now());

function appWantsMouse(t) {
  const m = t.term.modes && t.term.modes.mouseTrackingMode;
  return !!m && m !== 'none';
}

function cellSize(t) {
  const d = t.term._core && t.term._core._renderService && t.term._core._renderService.dimensions;
  const css = d && d.css && d.css.cell;
  return { w: (css && css.width) || 9, h: (css && css.height) || 18 };
}

function touchCell(t, touch) {
  const rect = t.term.element.getBoundingClientRect();
  const { w, h } = cellSize(t);
  const col = Math.max(1, Math.min(t.term.cols, Math.floor((touch.clientX - rect.left) / w) + 1));
  const row = Math.max(1, Math.min(t.term.rows, Math.floor((touch.clientY - rect.top) / h) + 1));
  return { col, row };
}

// SGR mouse encoding (mode 1006), which every modern TUI (incl. Claude Code) uses.
function wheelSeq(notchesUp, col, row) {
  const btn = notchesUp > 0 ? 64 : 65; // 64 = wheel up (older), 65 = wheel down
  let seq = '';
  for (let i = 0; i < Math.min(Math.abs(notchesUp), 8); i++) seq += `\x1b[<${btn};${col};${row}M`;
  return seq;
}

function wireTouchScroll(t) {
  const el = t.pane;
  let tracking = false, scrolling = false, startX = 0, startY = 0, lastY = 0, accum = 0;
  let cell = { col: 1, row: 1 }, vel = 0, lastT = 0, raf = 0, startedAt = 0;
  const stopMomentum = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

  function emit(deltaPx) {
    const step = Math.max(8, cellSize(t).h);     // one wheel notch per line of drag
    const notches = Math.trunc(deltaPx / step);
    if (!notches) return 0;
    sendInput(t, wheelSeq(notches, cell.col, cell.row)); // finger down → wheel up (older)
    return notches * step;
  }

  el.addEventListener('touchstart', (e) => {
    if (!appWantsMouse(t) || e.touches.length !== 1) { tracking = false; return; }
    stopMomentum();
    tracking = true; scrolling = false;
    const tch = e.touches[0];
    startX = tch.clientX; startY = lastY = tch.clientY;
    accum = 0; vel = 0; lastT = now(); startedAt = lastT;
    cell = touchCell(t, tch);
    // Don't let xterm relay this as a mouse-down/move; we own the gesture.
    e.stopPropagation();
  }, { capture: true, passive: false });

  el.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const tch = e.touches[0];
    const dy = tch.clientY - lastY;
    const dx = tch.clientX - startX;
    if (!scrolling) {
      // Decide intent on first real movement: mostly-vertical → scroll.
      if (Math.abs(tch.clientY - startY) < 6 && Math.abs(dx) < 6) { e.stopPropagation(); return; }
      if (Math.abs(tch.clientY - startY) <= Math.abs(dx)) { tracking = false; return; }
      scrolling = true;
    }
    e.preventDefault(); e.stopPropagation();
    const tNow = now(); const dt = Math.max(1, tNow - lastT);
    vel = dy / dt; lastT = tNow; lastY = tch.clientY;
    accum += dy;
    accum -= emit(accum);
  }, { capture: true, passive: false });

  function end(e) {
    if (!tracking) return;
    const wasTap = !scrolling && (now() - startedAt) < 250;
    tracking = false;
    if (wasTap) { sendInput(t, `\x1b[<0;${cell.col};${cell.row}M\x1b[<0;${cell.col};${cell.row}m`); return; }
    if (!scrolling) return;
    // Flick momentum: keep emitting wheel events, decaying, until it dies.
    let v = vel; let acc = 0;
    const step = () => {
      if (Math.abs(v) < 0.015) { raf = 0; return; }
      acc += v * 16;                 // px advanced this ~frame
      acc -= emit(acc);
      v *= 0.95;
      raf = requestAnimationFrame(step);
    };
    if (Math.abs(v) > 0.05) step();
  }
  el.addEventListener('touchend', end, { capture: true, passive: false });
  el.addEventListener('touchcancel', () => { tracking = false; stopMomentum(); }, { capture: true });

  t._stopMomentum = stopMomentum;
}

function sendInput(t, data) {
  if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ type: 'input', data }));
}

function connect(t) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term/${encodeURIComponent(t.id)}`);
  t.ws = ws;
  ws.onopen = () => { t.attempts = 0; };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'replay') {
      // Render the buffered bytes at the width the PTY produced them, so wrapping
      // and absolute cursor positioning line up. Then refit to this device and
      // send a resize — full-screen apps (Claude Code, vim) redraw cleanly on the
      // resulting SIGWINCH, and a plain shell just reflows.
      if (msg.cols && msg.rows) { try { t.term.resize(msg.cols, msg.rows); } catch {} }
      t.term.reset();
      t.term.write(msg.data, () => {
        requestAnimationFrame(() => { if (t.fit) { try { t.fit.fit(); } catch {} } });
      });
    }
    else if (msg.type === 'output') t.term.write(msg.data);
    else if (msg.type === 'exit') t.term.write(`\r\n\x1b[90m[process exited${msg.code != null ? ' (' + msg.code + ')' : ''}]\x1b[0m\r\n`);
  };
  ws.onclose = () => {
    if (t.closing) return;
    t.attempts += 1;
    if (t.attempts > 10) { t.term.write('\r\n\x1b[31m[disconnected — session no longer available]\x1b[0m\r\n'); return; }
    t.reconnectTimer = setTimeout(() => connect(t), Math.min(5000, 400 * t.attempts));
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function setActive(id) {
  state.activeId = id;
  for (const [key, t] of state.open) t.pane.classList.toggle('active', key === id);
  const t = state.open.get(id);
  if (t) requestAnimationFrame(() => { if (t.fit) { try { t.fit.fit(); } catch {} } t.term.focus(); });
  renderTabs();
  renderSessions();
}

function closeTab(id) {
  const t = state.open.get(id);
  if (!t) return;
  t.closing = true;
  if (t.reconnectTimer) clearTimeout(t.reconnectTimer);
  if (t._stopMomentum) { try { t._stopMomentum(); } catch {} }
  if (t.ro) { try { t.ro.disconnect(); } catch {} }
  try { t.ws && t.ws.close(); } catch {}
  t.term.dispose();
  t.pane.remove();
  state.open.delete(id);
  if (state.activeId === id) {
    const next = state.open.keys().next();
    state.activeId = next.done ? null : next.value;
    if (state.activeId) setActive(state.activeId);
  }
  renderTabs();
  renderSessions();
}

async function killSession(id) {
  try { await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
  if (state.open.has(id)) closeTab(id);
  refresh();
}

async function renameSession(id, current) {
  const name = window.prompt('Rename session', current || '');
  if (name == null) return;            // cancelled
  const title = name.trim();
  if (!title) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
  } catch {}
  const t = state.open.get(id);        // keep the open tab's label in sync
  if (t) t.title = title;
  refresh();
}

// ---- on-screen key bar ----------------------------------------------------

function setCtrlArmed(on) {
  state.ctrlArmed = on;
  $('#ctrl-key').classList.toggle('armed', on);
}

function handleKey(key) {
  const t = state.open.get(state.activeId);
  if (!t) return;
  if (key === 'ctrl') { setCtrlArmed(!state.ctrlArmed); return; }
  const seq = KEY_SEQ[key];
  if (seq != null) sendInput(t, seq);
  // Deliberately do NOT focus the terminal here. On iOS focusing summons the
  // on-screen keyboard, which resizes the viewport and shifts the key bar
  // mid-tap — that made rapid arrow presses (e.g. cycling a Claude prompt's
  // options) land on the wrong key or get dropped. The ⌨ key opens the
  // keyboard when the user actually wants to type.
}

// ---- paste (mobile) -------------------------------------------------------
// iOS Safari doesn't surface the long-press "Paste" menu over xterm's hidden
// helper textarea (worse with the WebGL renderer + our touch capture), so the
// Paste key reads the clipboard directly (works because Serve gives us HTTPS).
// If the Clipboard API is blocked/denied, fall back to a real textarea the user
// can paste into manually — native paste always works there.
async function doPaste() {
  const t = state.open.get(state.activeId);
  if (!t) return;
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) { sendInput(t, text); t.term.focus(); return; }
    }
    throw new Error('clipboard unavailable');
  } catch {
    pasteFallback(t);
  }
}

function pasteFallback(t) {
  const back = document.createElement('div');
  back.id = 'paste-backdrop';
  back.innerHTML =
    '<div id="paste-box">' +
    '<div class="paste-title">Paste your text below, then tap Send</div>' +
    '<textarea id="paste-area" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>' +
    '<div class="dialog-buttons">' +
    '<button class="secondary" id="paste-cancel">Cancel</button>' +
    '<button id="paste-send">Send</button>' +
    '</div></div>';
  document.body.appendChild(back);
  const ta = back.querySelector('#paste-area');
  const close = () => back.remove();
  back.querySelector('#paste-cancel').onclick = close;
  back.querySelector('#paste-send').onclick = () => {
    const v = ta.value;
    close();
    if (v) sendInput(t, v);
    t.term.focus();
  };
  back.onclick = (e) => { if (e.target === back) close(); };
  setTimeout(() => ta.focus(), 50);
}

// ---- new terminal dialog --------------------------------------------------

const DEFAULT_COMMAND = 'claude --dangerously-skip-permissions';

function openDialog() {
  $('#dialog-title').textContent = 'New terminal';
  $('#dlg-cmd').value = DEFAULT_COMMAND; // editable; clear it for a plain shell
  $('#dlg-preset').value = DEFAULT_COMMAND;
  $('#dlg-cwd').value = '';
  $('#dlg-title').value = '';
  $('#dlg-error').textContent = '';
  loadRecents();
  $('#dialog-backdrop').classList.remove('hidden');
  setTimeout(() => $('#dlg-cwd').focus(), 50);
}

function setDirOptions(values) {
  const dl = $('#dlg-recents');
  dl.innerHTML = '';
  for (const v of values || []) {
    const opt = document.createElement('option');
    opt.value = v;
    dl.appendChild(opt);
  }
}

async function loadRecents() {
  try { setDirOptions((await api('/api/recents')).recents); } catch {}
}

// As the user types a path, suggest matching subdirectories from the filesystem;
// fall back to recents when the field is empty.
let dirSuggestTimer = null;
function scheduleDirSuggest() {
  clearTimeout(dirSuggestTimer);
  dirSuggestTimer = setTimeout(updateDirSuggestions, 140);
}
async function updateDirSuggestions() {
  const v = $('#dlg-cwd').value;
  if (!v.trim()) { loadRecents(); return; }
  try { setDirOptions((await api('/api/dirs?path=' + encodeURIComponent(v))).dirs); } catch {}
}

// Preset dropdown drives the command field; picking "Custom…" just lets the user
// type freely, and typing a command that doesn't match a preset flips the select
// to "Custom…" so the two stay consistent.
function applyPreset() {
  const v = $('#dlg-preset').value;
  if (v === '__custom__') { $('#dlg-cmd').focus(); return; }
  $('#dlg-cmd').value = v;
}
function syncPresetFromCommand() {
  const cmd = $('#dlg-cmd').value;
  const sel = $('#dlg-preset');
  const match = [...sel.options].some((o) => o.value === cmd && o.value !== '__custom__');
  sel.value = match ? cmd : '__custom__';
}

function closeDialog() { $('#dialog-backdrop').classList.add('hidden'); }

async function submitDialog() {
  const cwd = $('#dlg-cwd').value.trim();
  const title = $('#dlg-title').value.trim();
  const command = $('#dlg-cmd').value.trim();
  $('#dlg-open').disabled = true;
  try {
    const body = { cols: 80, rows: 24 };
    if (cwd) body.cwd = cwd;
    if (title) body.title = title;
    if (command) body.command = command;
    const session = await api('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    closeDialog();
    await refresh();
    openTerminal(session.id, session.title);
    if (isMobile()) closeDrawer();
  } catch (e) {
    $('#dlg-error').textContent = e.message;
  } finally {
    $('#dlg-open').disabled = false;
  }
}

// ---- drawer (mobile) ------------------------------------------------------

function openDrawer() { document.body.classList.add('drawer-open'); }
function closeDrawer() { document.body.classList.remove('drawer-open'); }

// ---- misc -----------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function refitActive() {
  const t = state.open.get(state.activeId);
  if (t) scheduleFit(t);
}

// On iOS the on-screen keyboard shrinks the visual viewport but not the layout
// viewport, which pushes the terminal and key bar under the keyboard. Pin the
// app height to the visual viewport so everything stays on-screen and sized right.
function syncViewportHeight() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--vvh', h + 'px');
  refitActive();
}

function wireEvents() {
  $('#new-term-btn').onclick = () => openDialog();
  $('#topbar-new').onclick = () => openDialog();
  $('#dlg-cwd').addEventListener('input', scheduleDirSuggest);
  $('#dlg-preset').addEventListener('change', applyPreset);
  $('#dlg-cmd').addEventListener('input', syncPresetFromCommand);
  $('#menu-btn').onclick = openDrawer;
  $('#sidebar-close').onclick = closeDrawer;
  $('#scrim').onclick = closeDrawer;
  $('#dlg-cancel').onclick = closeDialog;
  $('#dlg-open').onclick = submitDialog;
  $('#dialog-backdrop').onclick = (e) => { if (e.target.id === 'dialog-backdrop') closeDialog(); };

  $('#kbd-key').onclick = () => { const t = state.open.get(state.activeId); if (t) t.term.focus(); };
  // Plain click (not pointerdown) so iOS counts it as the user gesture the
  // Clipboard API requires before it will hand over clipboard contents.
  $('#paste-key').onclick = doPaste;
  document.querySelectorAll('#keybar .key[data-key]').forEach((btn) => {
    // Use pointerdown so focus stays on the terminal and the key registers on phones.
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); handleKey(btn.dataset.key); });
  });

  document.addEventListener('keydown', (e) => {
    const dlgOpen = !$('#dialog-backdrop').classList.contains('hidden');
    if (e.key === 'Escape' && dlgOpen) closeDialog();
    if (e.key === 'Enter' && dlgOpen) submitDialog();
  });

  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('orientationchange', () => setTimeout(syncViewportHeight, 200));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    window.visualViewport.addEventListener('scroll', syncViewportHeight);
  }
}

wireEvents();
syncViewportHeight();
refresh();
setInterval(refresh, 2000); // keep the sidebar "working" status roughly live
