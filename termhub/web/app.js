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
  platform: '',    // sessiond host's process.platform, from /api/info
  limits: null,    // upload size caps from /api/info: {imageBytes, fileBytes}
  sessions: [],
  restorable: [],  // sessions from a previous run (e.g. before a reboot)
  open: new Map(), // id -> term object
  activeId: null,
  ctrlArmed: false,
};

const $ = (sel) => document.querySelector(sel);
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

// Write text to the local clipboard, working in BOTH secure and insecure
// contexts. navigator.clipboard only exists over HTTPS/localhost — on a plain
// HTTP origin (e.g. termhub bound to a tailnet IP with no Serve) it's undefined,
// so we fall back to the legacy execCommand('copy') trick via a hidden textarea.
// The fallback needs a fresh user gesture in some browsers; it lands when the
// copy round-trips quickly, which is the common case for OSC 52 from a TUI.
function copyToClipboard(text) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => execCopyFallback(text));
    return;
  }
  execCopyFallback(text);
}

function execCopyFallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Keep it out of view and out of the layout, but still selectable.
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {}
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---- data refresh ---------------------------------------------------------

// A cheap fingerprint of everything the sidebar renders from. The 2s poll
// rebuilt the whole sidebar DOM every tick even when nothing changed —
// steady-state layout/paint churn that competed with the terminal's own redraws
// and showed up as input that "spazzes out" for a moment after a tap. Now we
// only rebuild when this signature actually changes.
function uiSignature() {
  const live = state.sessions
    .map((s) => `${s.id}:${s.alive ? 1 : 0}:${s.busy ? 1 : 0}:${s.title || ''}:${s.modelLabel || ''}:${voice.armed.has(s.id) ? 1 : 0}`).join('|');
  const rest = state.restorable
    .map((r) => `${r.id}:${r.kind}:${(r.history || []).length}`).join('|');
  const open = [...state.open.values()].map((t) => `${t.id}:${t.title || ''}`).join(',');
  return `${state.activeId}|${voice.unlocked ? 1 : 0}||${live}||${rest}||${open}`;
}

// Redraw the sidebar right now and keep the poll's change detector in step, so
// the next 2 s tick doesn't immediately redraw it a second time.
function syncSidebar() { renderSessions(); lastUiSig = uiSignature(); }

let lastUiSig = '';
let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const s = await api('/api/sessions');
      state.machine = s.machine || '';
      state.sessions = s.sessions || [];
      state.restorable = s.restorable || [];
      // /api/sessions is the authority on which sessions are armed; the `armed`
      // WS event only makes a change instant. Rebuilding here every poll means a
      // missed socket message can't leave the 🔊 toggles lying. Non-Claude
      // sessions are filtered out: they have no transcript, so an armed flag on
      // one can only ever be a lie the sidebar would have to render.
      voice.armed = new Set(state.sessions.filter((x) => x.voiceArmed && x.kind === 'claude').map((x) => x.id));
      $('#machine-name').textContent = state.machine;
      const n = state.sessions.length;
      const live = state.sessions.filter((x) => x.alive).length;
      const r = state.restorable.length;
      $('#status-line').textContent =
        `${n} session${n === 1 ? '' : 's'} (${live} running)` + (r ? ` · ${r} restorable` : '');
    } catch (e) {
      $('#status-line').textContent = 'server unreachable';
    }
    const sig = uiSignature();
    if (sig !== lastUiSig) { lastUiSig = sig; renderSessions(); updateChrome(); renderVoice(); }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function renderSessions() {
  const list = $('#session-list');
  list.innerHTML = '';
  if (!state.sessions.length && !state.restorable.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'No sessions yet.';
    list.appendChild(empty);
    return;
  }
  for (const s of state.sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.alive ? '' : ' dead')
      + (state.open.has(s.id) ? ' open' : '')
      + (s.id === state.activeId ? ' active' : '');
    // Claude sessions get a second, dim line under the title showing which
    // model they're currently talking to (read from Claude's own transcript —
    // see lib/claudeModel.js). Absent for shells and for Claude sessions whose
    // model isn't known yet (just spawned, or launched with a hand-typed
    // --resume/--continue whose resulting conversation id we can't predict).
    // 🔊 arms spoken announcements for the session. Only Claude sessions have a
    // transcript to read, so on anything else it's dimmed — but still tappable,
    // because a control that does nothing and says nothing is worse than one
    // that explains itself.
    const canSpeak = s.kind === 'claude';
    // A non-Claude session can never announce anything, so never paint one as
    // armed even if the API let something arm it.
    const armed = canSpeak && voice.armed.has(s.id);
    const voiceTitle = !canSpeak
      ? 'Spoken announcements need a Claude session'
      : armed
        ? (voice.unlocked ? 'Speaking this session — tap to stop' : 'Armed, but audio is locked — tap "Enable voice" below')
        : 'Speak this session when it needs you';
    item.innerHTML =
      `<span class="status${s.busy ? ' busy' : ''}" title="${s.busy ? 'working' : 'idle'}"></span>` +
      `<span class="title-wrap">` +
        `<span class="title">${escapeHtml(s.title || s.id)}</span>` +
        (s.modelLabel ? `<span class="model-badge">${escapeHtml(s.modelLabel)}</span>` : '') +
      `</span>` +
      `<button class="voice${canSpeak ? '' : ' unsupported'}${armed ? (voice.unlocked ? ' armed' : ' armed locked') : ''}"` +
        ` title="${escapeHtml(voiceTitle)}">&#128266;</button>` +
      `<button class="rename" title="Rename session">&#9998;</button>` +
      `<button class="kill" title="Kill session">&#10005;</button>`;
    // The whole row opens the terminal — clicking anywhere but the buttons
    // (which stop propagation) counts, so you don't have to hit the text exactly.
    item.onclick = () => { openTerminal(s.id, s.title, s.kind); if (isMobile()) closeDrawer(); };
    item.querySelector('.voice').onclick = (ev) => {
      ev.stopPropagation();
      if (!canSpeak) { toast('Spoken announcements only work for Claude sessions', 'err').close(4000); return; }
      toggleVoiceArm(s.id, !armed);
    };
    item.querySelector('.rename').onclick = (ev) => { ev.stopPropagation(); renameSession(s.id, s.title); };
    item.querySelector('.kill').onclick = (ev) => { ev.stopPropagation(); killSession(s.id); };
    list.appendChild(item);
  }

  if (state.restorable.length) {
    const head = document.createElement('div');
    head.className = 'list-section';
    head.textContent = 'Restorable (after restart)';
    list.appendChild(head);
    for (const r of state.restorable) list.appendChild(renderRestorable(r));
  }
}

// A session that survived a reboot only as metadata. Restore re-spawns it:
// Claude sessions with `--resume`, opencode sessions with `--session`/
// `--continue`, shell sessions with their recorded command history printed so
// the user can rebuild state by hand. ✕ forgets it.
const RESTORE_KIND_META = {
  claude: { icon: '◈', label: 'Claude session — resumes' },
  opencode: { icon: '◆', label: 'opencode session — resumes' },
};
function renderRestorable(r) {
  const meta = RESTORE_KIND_META[r.kind] || { icon: '$', label: 'shell session' };
  const isShell = !RESTORE_KIND_META[r.kind];
  const item = document.createElement('div');
  item.className = 'restore-item';
  item.innerHTML =
    `<div class="restore-row">` +
      `<span class="restore-kind ${isShell ? 'shell' : r.kind}" title="${meta.label}">${meta.icon}</span>` +
      `<span class="restore-title">${escapeHtml(r.title || r.id)}</span>` +
      `<button class="restore-go" title="Restore session">&#8635;</button>` +
      `<button class="restore-forget" title="Forget">&#10005;</button>` +
    `</div>` +
    `<div class="restore-sub" title="${escapeHtml(r.cwd || '')}">${escapeHtml(r.cwd || '')}</div>`;

  if (isShell && r.history && r.history.length) {
    const n = r.history.length;
    const label = (open) => `${open ? '▾' : '▸'} ${n} command${n === 1 ? '' : 's'}`;
    const toggle = document.createElement('button');
    toggle.className = 'restore-hist-toggle';
    toggle.textContent = label(false);
    const box = document.createElement('div');
    box.className = 'restore-hist';
    box.hidden = true;
    box.innerHTML = r.history.map((h) => `<code>${escapeHtml(h)}</code>`).join('');
    toggle.onclick = () => { box.hidden = !box.hidden; toggle.textContent = label(!box.hidden); };
    item.appendChild(toggle);
    item.appendChild(box);
  }

  item.querySelector('.restore-go').onclick = () => restoreSession(r.id);
  item.querySelector('.restore-forget').onclick = () => forgetSession(r.id);
  return item;
}

// The top tab strip is gone — the sidebar's session list is now the only way
// to switch terminals (it already showed an "open" indicator per session
// independent of any tab strip, and its ✕ actually kills the session, unlike
// the old tab-close which only detached — a common point of confusion). This
// just keeps the mobile topbar's title and the terminal area's empty-state in
// sync with what's open.
function updateChrome() {
  $('#empty-state').classList.toggle('hidden', state.open.size > 0);
  const active = state.open.get(state.activeId);
  $('#active-title').textContent = active ? (active.title || active.id) : 'termhub';
}

// ---- terminal lifecycle ---------------------------------------------------

function openTerminal(id, title, kind) {
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

  // Bridge the remote clipboard to THIS browser's clipboard. Full-screen TUIs
  // (Claude Code, vim, tmux) that run over SSH can't reach your local clipboard
  // directly, so they emit OSC 52 ("set clipboard") escape sequences. xterm.js
  // ignores those by default; we decode the base64 payload and write it to the
  // local clipboard so "copied to clipboard" in a remote Claude session actually
  // lands on the machine where you're viewing termhub. (Selection copy in a
  // mouse-mode TUI still works too: hold Shift while dragging to force a browser
  // selection, then Ctrl/Cmd-C.)
  try {
    term.parser.registerOscHandler(52, (payload) => {
      // payload is "<selection>;<base64|?>" e.g. "c;SGVsbG8=". "?" is a read
      // query, which we can't answer from the browser — let it pass through.
      const semi = payload.indexOf(';');
      const b64 = semi >= 0 ? payload.slice(semi + 1) : payload;
      if (!b64 || b64 === '?') return false;
      try {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        copyToClipboard(text);
      } catch {}
      return true; // handled — don't let the raw sequence hit the screen
    });
  } catch {}

  const t = { id, title, kind, term, fit, pane, ws: null, attempts: 0, closing: false, reconnectTimer: null, ro: null };
  state.open.set(id, t);
  wireTouchScroll(t);
  wireAttachments(t);

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
  updateChrome();
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

// ---- toasts ----------------------------------------------------------------
// Short-lived status strip for things the terminal can't tell you about: an
// upload that's still going, one that failed. It has to live in the DOM rather
// than be written into the terminal, because a full-screen TUI (Claude Code,
// vim) repaints the whole screen and would wipe the line within a frame.

// Picking 20 files should not paper the terminal over with 20 notices, least of
// all on a phone — keep the newest few and let the older ones go. A dropped
// toast's handle still works, it just updates an element nobody can see.
const MAX_TOASTS = 4;

function toast(text, kind) {
  const box = $('#toasts');
  while (box.children.length >= MAX_TOASTS) box.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = text;
  // Tap to dismiss — an error can be several lines long, and the user needs a
  // way to get it off the screen once they've read it.
  el.addEventListener('click', () => el.remove());
  box.appendChild(el);
  let timer = null;
  const handle = {
    set(next, nextKind) {
      el.textContent = next;
      el.className = 'toast' + (nextKind ? ' ' + nextKind : '');
      return handle;
    },
    close(afterMs) {
      clearTimeout(timer);
      if (afterMs) timer = setTimeout(() => el.remove(), afterMs);
      else el.remove();
    },
  };
  return handle;
}

// ---- file paste / drop / attach (images + generic attachments) --------------
// A screenshot (or any other file) copied on THIS (browser) machine can't reach
// a remote terminal the way pasted text can — there's no character stream to
// carry file bytes. Both paths below upload the file to sessiond so it lands
// on the REMOTE host, then get it in front of the running agent:
//  - images: staged onto the remote's own OS clipboard, then we fire whichever
//    hotkey the running agent listens for to pick up a clipboard image, so it
//    attaches exactly as a local paste would. Claude Code uses Alt+V on native
//    Windows (Ctrl+V is reserved there for normal text paste) and Ctrl+V
//    elsewhere; opencode uses Ctrl+V on every OS (confirmed against a real
//    install — no platform split). On a host with no clipboard at all (a
//    headless Linux box has no display for one to live on) sessiond saves the
//    image as a file instead and says so in its reply — then we take the path
//    route below, which both agents understand just as well.
//  - everything else (PDF, .md, .txt, …): saved into the session's own working
//    directory, then its path is typed into the terminal input — same as what
//    a native OS drag-and-drop of a file onto a terminal does — so the running
//    shell or agent can pick it up by reference.
//
// Three ways in, one path through: the 📎 key, a paste, and a drop all end up
// in sendAttachment().
const IMAGE_TYPE_RE = /^image\//;
const BROWSER_PLACEHOLDER_IMAGE_RE = /^image\.(png|jpe?g|gif|webp|bmp)$/i;

function pasteImageSeq(t) {
  if (t && t.kind === 'opencode') return '\x16';
  return state.platform === 'win32' ? '\x1bv' : '\x16';
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// A clipboard image has no filename of its own — every browser calls it
// "image.png" — so stamp it with the time instead, which is what the user will
// have to recognise it by later. Real files (dropped, or picked with 📎) keep
// their own name.
function namedForUpload(file) {
  if (!IMAGE_TYPE_RE.test(file.type)) return file;
  if (file.name && !BROWSER_PLACEHOLDER_IMAGE_RE.test(file.name)) return file;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // Local time, matching the name sessiond falls back to (lib/uploads.js) — a
  // UTC stamp on a file the user has to find later is just a puzzle.
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  try { return new File([file], `pasted-image-${stamp}.${ext}`, { type: file.type }); }
  catch { return file; }   // very old Safari: no File constructor — let the server name it
}

function filesFromClipboard(cd) {
  if (!cd) return [];
  const out = [];
  for (const item of cd.items || []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  // Some browsers populate only clipboardData.files (and Safari populates both,
  // hence the de-dupe by name+size).
  for (const file of cd.files || []) {
    if (!out.some((f) => f.name === file.name && f.size === file.size)) out.push(file);
  }
  return out;
}

function filesFromDrop(dt) {
  if (!dt || !dt.files) return [];
  return Array.from(dt.files);
}

// fetch() cannot report upload progress, and a phone pushing a 5 MB photo over
// cellular takes long enough that silence reads as "nothing happened" — XHR is
// the only browser API that says how many bytes have gone out.
function uploadWithProgress(url, headers, file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch {}
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, body: null });
    xhr.onabort = () => resolve({ ok: false, status: 0, body: null });
    xhr.send(file);
  });
}

// Type a path into the terminal input line (without pressing Enter) so the user
// can finish the prompt around it — same as a native OS file drag-drop.
function insertPath(t, p) {
  const needsQuoting = /\s/.test(p);
  sendInput(t, needsQuoting ? `"${p}" ` : `${p} `);
}

function errorText(res, fallback) {
  if (res.body && res.body.error) return res.body.error;
  if (!res.status) return 'upload failed — connection lost';
  return `${fallback} (HTTP ${res.status})`;
}

async function sendImage(t, file, note) {
  const res = await uploadWithProgress(
    `/api/sessions/${encodeURIComponent(t.id)}/clipboard-image`,
    { 'Content-Type': file.type || 'image/png', 'X-File-Name': encodeURIComponent(file.name || '') },
    file,
    (frac) => note.set(`${file.name} — ${Math.round(frac * 100)}%`),
  );
  if (!res.ok) { note.set(errorText(res, 'image upload failed'), 'err').close(6000); return; }
  if (!stillOpen(t, note)) return;
  // sessiond decides what actually happened to the image: staged on the host's
  // clipboard (fire the agent's paste hotkey) or written to a file (type its
  // path). Either way it prints its own notice into the terminal.
  if (res.body && res.body.kind === 'file' && res.body.path) {
    insertPath(t, res.body.path);
    note.set(`saved ${res.body.name} — path inserted`, 'ok').close(4000);
  } else {
    sendInput(t, pasteImageSeq(t));
    note.set('image pasted', 'ok').close(2500);
  }
  t.term.focus();
}

// Upload a non-image file to sessiond, which drops it into the session's cwd
// on the REMOTE machine, then type its path in.
async function sendFile(t, file, note) {
  const res = await uploadWithProgress(
    `/api/sessions/${encodeURIComponent(t.id)}/upload-file`,
    {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'upload'),
    },
    file,
    (frac) => note.set(`${file.name} — ${Math.round(frac * 100)}%`),
  );
  if (!res.ok) { note.set(errorText(res, 'upload failed'), 'err').close(6000); return; }
  if (!stillOpen(t, note)) return;
  if (res.body && res.body.path) {
    insertPath(t, res.body.path);
    note.set(`saved ${res.body.name} — path inserted`, 'ok').close(4000);
  } else {
    note.close(0);
  }
  t.term.focus();
}

// An upload can outlive the terminal it was for — a multi-megabyte photo on a
// phone takes long enough for the user to kill the session first. The socket is
// gone by then, so the path insertion silently goes nowhere while the toast
// still claims "path inserted"; say what actually happened instead. (Calling
// focus() on the disposed xterm turns out not to throw with the vendored
// build — measured — but there is no reason to keep poking at it either.)
function stillOpen(t, note) {
  if (state.open.has(t.id)) return true;
  note.set('terminal closed — upload discarded', 'err').close(5000);
  return false;
}

function sendAttachment(t, file) {
  const isImage = IMAGE_TYPE_RE.test(file.type);
  // Refuse an over-cap file here rather than after a long upload the server was
  // always going to reject. The caps come from /api/info, which reports the cap
  // that actually applies to THIS host — an image goes by the file cap where
  // there's no clipboard to squeeze it through. If we never got them, let the
  // server be the judge.
  const cap = state.limits && (isImage ? state.limits.imageBytes : state.limits.fileBytes);
  if (cap && file.size > cap) {
    toast(`${file.name || 'file'} is ${humanBytes(file.size)} — over the ${humanBytes(cap)} limit`, 'err').close(8000);
    return;
  }
  const named = namedForUpload(file);
  const note = toast(`${named.name} — uploading…`);
  // Nothing awaits these, so an unexpected throw would otherwise surface as an
  // unhandled rejection and the toast would hang on "uploading…" forever.
  const done = isImage ? sendImage(t, named, note) : sendFile(t, named, note);
  done.catch((e) => note.set(`upload failed: ${e && e.message ? e.message : e}`, 'err').close(6000));
}

// Capture in the CAPTURE phase so this runs before xterm's own paste listener
// on its hidden textarea — for a file we fully take over the event; for plain
// text (the common case) we do nothing and let xterm's native handling proceed.
function wireAttachments(t) {
  t.pane.addEventListener('paste', (e) => {
    // Text wins. A rich-text paste (from a doc, a chat client, a web page)
    // routinely carries an inline image alongside the words, and since we
    // preventDefault() the moment we decide to take a file, treating that as an
    // attachment would upload the decoration and silently swallow the text the
    // user actually meant to paste. If there's text, let xterm have the event.
    let text = '';
    try { text = (e.clipboardData && e.clipboardData.getData('text/plain')) || ''; } catch {}
    if (text) return;

    const files = filesFromClipboard(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    for (const file of files) sendAttachment(t, file);
  }, true);

  t.pane.addEventListener('dragover', (e) => { e.preventDefault(); });
  t.pane.addEventListener('drop', (e) => {
    const files = filesFromDrop(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) sendAttachment(t, file);
  });
}

// The 📎 key. Pasting a file is unreliable on desktop and impossible on a phone,
// so this is the sanctioned way in: a plain file picker, no `accept` filter (see
// index.html), routed through exactly the same code as a drop.
function openFilePicker() {
  if (!state.open.get(state.activeId)) {
    toast('Open a terminal first', 'err').close(3000);
    return;
  }
  $('#file-input').click();
}

function onFilesPicked(input) {
  const t = state.open.get(state.activeId);
  const files = Array.from(input.files || []);
  input.value = '';   // so picking the same file twice in a row fires again
  if (!t) return;
  for (const file of files) sendAttachment(t, file);
}

function setActive(id) {
  state.activeId = id;
  for (const [key, t] of state.open) t.pane.classList.toggle('active', key === id);
  const t = state.open.get(id);
  if (t) requestAnimationFrame(() => { if (t.fit) { try { t.fit.fit(); } catch {} } t.term.focus(); });
  updateChrome();
  renderSessions();
  updateMouseHint();
}

// Local-only cleanup after a session is killed server-side: tear down its
// xterm instance and websocket and drop it from state.open. No longer exposed
// as its own user-facing action (there used to be a top tab-bar ✕ for this —
// removed because "closes the tab but doesn't kill the session" was exactly
// the confusing half-close the sidebar's ✕ didn't have).
function detachTerminal(id) {
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
  updateChrome();
  renderSessions();
}

async function killSession(id) {
  try { await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
  if (state.open.has(id)) detachTerminal(id);
  refresh();
}

// Re-open a session archived from a previous run, then focus it.
async function restoreSession(id) {
  try {
    const session = await api(`/api/sessions/${encodeURIComponent(id)}/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    await refresh();
    openTerminal(session.id, session.title, session.kind);
    if (isMobile()) closeDrawer();
  } catch (e) {
    window.alert('Restore failed: ' + e.message);
  }
}

// Drop a restorable entry without re-opening it (a DELETE forgets the archive).
async function forgetSession(id) {
  try { await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
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
  const t = state.open.get(id);        // keep the open terminal's label in sync
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

// ---- combobox (custom autocomplete) ---------------------------------------
// A suggestion dropdown we fully control. The native <datalist> popup is
// unreliable for filesystem paths — on Windows it routinely fails to surface
// backslash paths as you type — so we render and filter the list ourselves.
// Used for both the directory field (async, server-backed) and the command
// field (static presets). The input stays free-text: type a new value, pick one,
// or leave it blank.
function makeCombobox(input, listEl, opts) {
  const getItems = opts.getItems;          // (value) => string[] | Promise<string[]>
  const keepOpenOnPick = !!opts.keepOpenOnPick;
  let items = [];
  let active = -1;
  let token = 0;                           // guards against out-of-order async results

  function close() { listEl.hidden = true; active = -1; }

  function render() {
    listEl.innerHTML = '';
    if (!items.length) { close(); return; }
    items.forEach((val, i) => {
      const row = document.createElement('div');
      row.className = 'combo-item' + (i === active ? ' active' : '');
      row.textContent = val;
      // mousedown (not click) so it fires before the input's blur closes the list.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(val); });
      listEl.appendChild(row);
    });
    listEl.hidden = false;
  }

  function pick(val) {
    if (keepOpenOnPick) {
      // Dirs: append the path separator so the next suggestion lists its children
      // and the user can keep drilling in. Infer the separator from the value
      // (backslash on Windows, slash elsewhere).
      const sep = val.includes('\\') ? '\\' : '/';
      input.value = val.endsWith(sep) ? val : val + sep;
      input.focus();
      update();
    } else {
      input.value = val;
      close();
      input.focus();
    }
  }

  async function update() {
    const my = ++token;
    let result;
    try { result = await getItems(input.value); } catch { result = []; }
    if (my !== token) return;              // a newer query superseded this one
    items = (result || []).slice(0, 50);
    active = -1;
    render();
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => setTimeout(close, 120)); // let a click land first
  input.addEventListener('keydown', (e) => {
    if (listEl.hidden || !items.length) {
      if (e.key === 'ArrowDown') update();
      return;                              // let Enter/Escape bubble (submit/close dialog)
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopPropagation(); pick(items[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); } // close list, not dialog
  });

  return { update, close };
}

// ---- new terminal dialog --------------------------------------------------

const DEFAULT_COMMAND = 'claude --dangerously-skip-permissions';
const COMMAND_PRESETS = [
  'claude --dangerously-skip-permissions',
  'claude --dangerously-skip-permissions --resume',
  'claude',
  'claude --resume',
  'opencode',
  'opencode --auto',
];

let cwdCombo = null;
let cmdCombo = null;

// Suggestions for the directory field: recents when empty, else live filesystem
// subdirectories matching what's typed.
async function dirItems(value) {
  if (!value.trim()) {
    try { return (await api('/api/recents')).recents || []; } catch { return []; }
  }
  try { return (await api('/api/dirs?path=' + encodeURIComponent(value))).dirs || []; }
  catch { return []; }
}

// Suggestions for the command field: the presets, filtered by what's typed.
function commandItems(value) {
  const v = value.trim().toLowerCase();
  const matches = COMMAND_PRESETS.filter((c) => c.toLowerCase().includes(v));
  // Don't bother showing a lone suggestion identical to what's already typed.
  if (matches.length === 1 && matches[0].toLowerCase() === v) return [];
  return matches;
}

function openDialog() {
  $('#dialog-title').textContent = 'New terminal';
  $('#dlg-cmd').value = DEFAULT_COMMAND; // editable; clear it for a plain shell
  $('#dlg-cwd').value = '';
  $('#dlg-title').value = '';
  $('#dlg-error').textContent = '';
  if (cwdCombo) cwdCombo.close();
  if (cmdCombo) cmdCombo.close();
  $('#dialog-backdrop').classList.remove('hidden');
  setTimeout(() => $('#dlg-cwd').focus(), 50);
}

function closeDialog() {
  $('#dialog-backdrop').classList.add('hidden');
  if (cwdCombo) cwdCombo.close();
  if (cmdCombo) cmdCombo.close();
}

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
    openTerminal(session.id, session.title, session.kind);
    if (isMobile()) closeDrawer();
  } catch (e) {
    $('#dlg-error').textContent = e.message;
  } finally {
    $('#dlg-open').disabled = false;
  }
}

// ---- update check ---------------------------------------------------------
// Asks the front (which owns the git checkout) whether HEAD is behind upstream
// and whether termhub itself changed. Runs once a day in the background to nudge
// the user; the panel lets them check on demand and apply. Applying just opens a
// terminal running the platform updater (windows/update.ps1) — the blue-green
// swap survives the front being replaced under it, so the update is visible and
// the running terminals keep their sessions.

const UPDATE_POLL_MS = 24 * 60 * 60 * 1000; // once a day
let lastUpdateInfo = null;

async function fetchUpdate(force) {
  const info = await api('/api/update/check' + (force ? '?force=1' : ''));
  lastUpdateInfo = info;
  reflectUpdateButton(info);
  return info;
}

function reflectUpdateButton(info) {
  const btn = $('#update-btn');
  if (btn) {
    const avail = !!(info && info.available);
    btn.classList.toggle('available', avail);
    btn.textContent = avail ? '⟳ Update ●' : '⟳ Update';
    btn.title = avail
      ? `Update available (${info.behind} commit${info.behind === 1 ? '' : 's'})`
      : 'Check for updates';
  }
  const ver = $('#version-line');
  if (ver) ver.textContent = info && info.version ? info.version : '';
}

async function backgroundUpdateCheck() {
  try { await fetchUpdate(false); } catch {}
}

function renderUpdatePanel(info, loading) {
  const status = $('#update-status');
  const commits = $('#update-commits');
  const apply = $('#update-apply');
  commits.innerHTML = '';
  apply.disabled = true;
  status.className = '';
  if (loading) { status.textContent = 'Checking…'; return; }
  if (!info) { status.textContent = 'Could not check for updates.'; return; }
  if (info.error) {
    status.className = 'warn';
    status.textContent = 'Update check unavailable: ' + info.error;
    return;
  }
  if (!info.available) {
    status.className = 'ok';
    status.textContent = `Up to date — ${info.version || info.current}.`
      + (info.fetchOk === false ? ' (offline — compared cached refs)' : '');
    return;
  }
  status.className = 'warn';
  status.textContent =
    `${info.behind} commit${info.behind === 1 ? '' : 's'} behind ${info.upstream || 'upstream'} — `
    + (info.toolChanged ? 'termhub itself changed.' : 'no termhub changes (other tools in the repo).');
  if (info.subjects && info.subjects.length) {
    const ul = document.createElement('ul');
    ul.className = 'commit-list';
    for (const c of info.subjects) {
      const li = document.createElement('li');
      li.innerHTML = `<code>${escapeHtml(c.hash)}</code> ${escapeHtml(c.subject)}`;
      ul.appendChild(li);
    }
    commits.appendChild(ul);
  }
  apply.disabled = false;
}

async function openUpdatePanel() {
  $('#update-backdrop').classList.remove('hidden');
  renderUpdatePanel(lastUpdateInfo, !lastUpdateInfo); // show cached info immediately
  try { await fetchUpdate(false); } catch {}
  renderUpdatePanel(lastUpdateInfo, false);
}

function closeUpdatePanel() { $('#update-backdrop').classList.add('hidden'); }

async function recheckUpdate() {
  renderUpdatePanel(null, true);
  try { await fetchUpdate(true); } catch {}
  renderUpdatePanel(lastUpdateInfo, false);
}

async function applyUpdate() {
  const info = lastUpdateInfo;
  if (!info || !info.command) return;
  $('#update-apply').disabled = true;
  try {
    const body = { cols: 80, rows: 24, command: info.command, title: 'termhub update' };
    if (info.cwd) body.cwd = info.cwd;
    const session = await api('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    closeUpdatePanel();
    await refresh();
    openTerminal(session.id, session.title, session.kind);
    if (isMobile()) closeDrawer();
  } catch (e) {
    $('#update-status').className = 'warn';
    $('#update-status').textContent = 'Could not start update: ' + e.message;
    $('#update-apply').disabled = false;
  }
}

// ---- voice: spoken announcements + hands-free replies -----------------------
// Two halves that share one strip of UI:
//   OUT — sessiond says an armed Claude session is waiting on you (`/ws/voice`),
//         we chime, ask /api/tts for a WAV and play it.
//   IN  — once the clip ends we open the mic, transcribe with the Web Speech
//         API, read the first few words back, and after a 3 s undo window type
//         the text into that session's terminal.
//
// Everything here is measured against the user's actual iPhone (iOS 18.7 /
// Safari 26.5.2), and three of those measurements shape the whole design:
//   1. Gesture-free `recognition.start()` works, so the loop can genuinely run
//      hands-free — but the FIRST start of a page load costs 3.05 s, so we spend
//      that inside the "Enable voice" tap.
//   2. `onerror: 'aborted'` and `'no-speech'` are the normal rhythm of that loop
//      (they fire whenever a recogniser is stopped or hears nothing), not
//      failures. Treating them as failures kills the feature on the first quiet
//      moment.
//   3. `continuous` is ignored: each recognition is exactly one utterance, so we
//      re-arm on every `onend`.
// And one hardware fact: the user is on Bluetooth headphones, where opening the
// mic flips iOS to the mono HFP route. Never hold the mic open while audio is
// playing, and don't re-open it more often than the conversation needs.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

// termhub answers on two URLs at once: plain HTTP on the tailnet IP, and HTTPS
// via Tailscale Serve. Only the second is a secure context, and the Web Speech
// API lives only there — so an old bookmark on the HTTP address can hear
// announcements (an <audio> element doesn't care) but can never talk back.
// Rather than let the mic silently do nothing, we say so and hand over the
// address to switch to. navigator.clipboard has exactly the same constraint;
// see execCopyFallback near the top of this file.
const SERVE_HTTPS_PORT = 7443;   // the port Tailscale Serve publishes this host on
const SECURE = window.isSecureContext !== false;
const secureUrl = () => `https://${location.hostname}:${SERVE_HTTPS_PORT}${location.pathname}`;
const canListen = () => !!SpeechRec && SECURE;

// Matched against INTERIM results. The final transcript lands ~1.9 s after the
// last word on device — most of a 3 s window — so waiting for it would make
// saying "stop" useless.

// ---- voice diagnostics ------------------------------------------------------
// The voice loop's failure mode is invisible: the strip says "listening" while
// no recogniser is actually live, and there is no console on a phone. Append
// `?voicedebug=1` to the URL for an on-screen event log that can be read (or
// screenshotted) straight off the device. Off — and free — otherwise.
const VOICE_DEBUG = /[?&]voicedebug=1\b/.test(location.search);
const vlogLines = [];
function vlog(msg) {
  if (!VOICE_DEBUG) return;
  const t = new Date().toISOString().slice(14, 23);
  vlogLines.push(`${t} ${msg} [want=${rec.want ? 1 : 0} sr=${rec.sr ? 1 : 0} play=${voice.playing ? 1 : 0}`
    + ` draft=${voice.draft ? voice.draft.text.length : 0} q=${voice.queue.length}]`);
  while (vlogLines.length > 40) vlogLines.shift();
  const box = document.getElementById('voice-debug');
  if (box) { box.textContent = vlogLines.join('\n'); box.scrollTop = 1e9; }
}

// How long a silence ends your turn. Measured against real speech: iOS returns
// a final transcript ~1.9 s after your last word, so anything under ~3 s cuts
// people off mid-thought. Four seconds leaves room to think without making the
// end of every turn feel like a wait.
const SEND_SILENCE_MS = 4000;
// A ceiling on an open mic MID-DICTATION — words are banked but nothing more
// has been heard for this long, which means the recogniser wedged rather than
// that the user is thinking. Waiting to *start* talking is unlimited (see
// bumpIdle). Hitting this sends the draft; it never discards it.
const LISTEN_IDLE_MS = 45000;
const REARM_MS = 250;          // breathing room for iOS to release the mic
// How long a freshly-opened mic is immune to a `busy` closing it (see onBusy).
const BUSY_GRACE_MS = 2500;
const VOICE_PING_MS = 25000;
const SPOKEN_TURNS_MAX = 200;  // bound on the reconnect-dedupe set
// Arming several already-idle sessions in a row makes the server announce each
// one's last turn at once. Two summaries back to back is a briefing; four is
// noise you tune out — past this the rest collapse into a single line.
const QUEUE_SPEAK_MAX = 2;

const voice = {
  ws: null, attempts: 0, pingTimer: null, reconnectTimer: null,
  unlocked: false,       // the one required user gesture has happened
  pumping: false,        // guards the queue against two concurrent drains
  ctx: null,             // AudioContext kept alive purely for the chime
  audio: null,           // the single <audio> element every announcement uses
  tts: { available: false, voice: '' },
  armed: new Set(),      // session ids, mirrored from /api/sessions + `armed` events
  queue: [],             // pending `waiting` messages, spoken one at a time
  playing: false,
  spokenTurns: new Set(),
  draft: null,           // {sessionId, text, timer} — dictation accumulating between silences
  editing: null,         // {sessionId} while the aborted-text editor is open
  status: '',
  line: '',              // the 🔊/🎤 line under the status
};

const rec = {
  sr: null,              // the live SpeechRecognition, or null between utterances
  want: false,           // we want the mic open (survives across re-arms)
  sessionId: null,       // where a transcript would be sent
  idleUntil: 0,
  idleTimer: null,
  openedAt: 0,           // when this listening stretch began (see onBusy)
  restartTimer: null,
  errors: 0,             // consecutive REAL errors ('aborted'/'no-speech' don't count)
  denied: false,
  warmed: false,
};

// ---- audio out --------------------------------------------------------------

// Real (silent) 8-bit PCM samples. Played through the very <audio> element every
// announcement will use, from inside the unlock gesture — belt and braces over
// the AudioContext ritual below, and cheaper than shipping an audio asset.
function silentWav(ms) {
  const rate = 8000;
  const n = Math.round((rate * ms) / 1000);
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const put = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); v.setUint32(4, 36 + n, true); put(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  put(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit PCM silence is 0x80, not 0
  return new Blob([buf], { type: 'audio/wav' });
}

// The chime is load-bearing, not decoration. From "Claude finished" to "audio
// starts" is ~7.5 s whenever the turn is long enough to go through the
// summariser model, which is the common case; seven seconds of dead air reads
// as broken. So this fires synchronously the instant the event lands — before
// the /api/tts round-trip, and independent of whatever the playback queue is
// doing — and it's an oscillator rather than a file so there's nothing to load.
function chime() {
  const ctx = voice.ctx;
  if (!ctx) return;
  // iOS suspends the context when the tab is backgrounded. Nudging it is free,
  // and the notes below are scheduled on the clock, so they land on resume.
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
  try {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t0);          // two quick notes, rising:
    osc.frequency.setValueAtTime(1318.5, t0 + 0.09); // reads as "ready", not "error"
    // Quiet, and shaped rather than square, because this fires often and lands
    // straight in the user's headphones.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.2);
  } catch {}
}

// A single soft note on send. The user asked for the spoken "sending: …"
// read-back to go away, but silence after speaking reads as "did that work?" —
// so acknowledge with a sound that costs no time.
function sendBlip() {
  const ctx = voice.ctx;
  if (!ctx) return;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
  try {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t0);   // one note, falling away — "gone"
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.16);
  } catch {}
}

// The one gesture iOS demands. Must stay fully synchronous: every unlock here
// only counts while we're still inside the tap's call stack.
function enableVoice() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx && !voice.ctx) { try { voice.ctx = new Ctx(); } catch {} }
  if (voice.ctx) {
    try { voice.ctx.resume(); } catch {}
    // Producing one buffer inside a gesture is what flips the context from
    // `suspended` to `running` for the rest of the page's life.
    try {
      const src = voice.ctx.createBufferSource();
      src.buffer = voice.ctx.createBuffer(1, 1, 22050);
      src.connect(voice.ctx.destination);
      src.start(0);
    } catch {}
  }
  if (!voice.audio) {
    const el = document.createElement('audio');
    el.setAttribute('playsinline', '');
    el.preload = 'auto';
    document.body.appendChild(el);
    voice.audio = el;
    playBlob(silentWav(60));
  }
  warmUpRecognition();
  voice.unlocked = true;
  // "Enable voice" is one button, so it had better mean voice is on. Requiring
  // a second, separate 🔊 tap on the session row is a distinction the user does
  // not have in their head — they turned voice on, then sat waiting for an
  // announcement that was never armed. Arm whatever they're looking at. The
  // per-session 🔊 stays for running several sessions and choosing between them.
  armActiveSessionForVoice();
  voice.status = voice.tts.available
    ? 'voice ready'
    : 'voice ready — no speech synthesis on this machine, announcements will be text only';
  // Playback works fine on the plain-HTTP origin; only the microphone doesn't.
  // Say which half the user is getting, and where the other half lives.
  if (!SECURE) voice.line = `🎤 Voice input needs the secure address: ${secureUrl()}`;
  else if (!SpeechRec) voice.line = '🎤 This browser has no speech recognition — 🎤 opens a text box instead';
  renderVoice();
  syncSidebar();
}

// Absorb the measured 3.05 s cost of a page's first `start()` here, in the tap,
// so it can't land in the middle of a conversation later. Every start after
// this one was ~10 ms on device.
function warmUpRecognition() {
  if (!SpeechRec || rec.warmed) return;
  rec.warmed = true;
  let sr;
  try { sr = new SpeechRec(); } catch { return; }
  sr.continuous = false;
  sr.interimResults = false;
  sr.onerror = () => {};                // 'aborted' is the expected outcome here
  sr.onstart = () => { setTimeout(() => { try { sr.abort(); } catch {} }, 50); };
  try { sr.start(); } catch { rec.warmed = false; return; }
  // If onstart never comes (permission prompt dismissed, engine unavailable),
  // don't leave a recogniser sitting on the mic.
  setTimeout(() => { try { sr.abort(); } catch {} }, 4000);
}

function playBlob(blob) {
  return new Promise((resolve) => {
    const el = voice.audio;
    if (!el) return resolve();
    const url = URL.createObjectURL(blob);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      el.removeEventListener('ended', done);
      el.removeEventListener('error', done);
      URL.revokeObjectURL(url);
      resolve();
    };
    // A clip that never fires `ended` (a decode that quietly stalls) would wedge
    // the queue for good, so cap it well past any plausible announcement.
    const guard = setTimeout(done, 90000);
    el.addEventListener('ended', done);
    el.addEventListener('error', done);
    el.src = url;
    const p = el.play();
    if (p && p.catch) p.catch(() => done());
  });
}

// Synthesize and play, start to finish. Returns when the audio has stopped —
// the mic is never opened before that (see the echo-guard note at the top).
// Returns 'ok', 'skip' (nothing to say, or no synthesis on this machine) or
// 'fail' (we tried and got nothing audible) so callers can tell the user which.
async function speak(text) {
  const say = (text || '').trim();
  if (!say || !voice.unlocked || !voice.tts.available) return 'skip';
  stopListening();
  voice.playing = true;
  vlog('speak start');
  renderVoice();
  try {
    const res = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: say }),
    });
    if (!res.ok) {
      // 503 means piper went away under us — stop asking, and keep announcing on
      // screen. A 400 is this one string's problem (empty, or over the cap), so
      // leave synthesis enabled for the next announcement.
      if (res.status === 503) voice.tts.available = false;
      return 'fail';
    }
    await playBlob(await res.blob());
    return 'ok';
  } catch {
    return 'fail';   // connection lost mid-synthesis; the summary is on screen
  } finally {
    voice.playing = false;
    vlog('speak done');
    renderVoice();
  }
}

// ---- announcement queue -----------------------------------------------------

// A summary can legitimately come back empty — a reply that was nothing but a
// fenced code block flattens to "" — and /api/tts rejects an empty string with
// a 400. Announcing "it's done" is still the useful half of the message, so
// never let an empty summary turn into silence.
function speakableSummary(msg) {
  const s = (msg.summary || '').trim();
  if (s) return s;
  return `${msg.title ? msg.title + ' is' : 'Claude is'} waiting on you.`;
}

function onWaiting(msg) {
  if (!msg.turnUuid) return;
  // The server already announces a turn exactly once; this second guard makes a
  // browser reconnect (or two tabs' worth of history) equally harmless.
  if (voice.spokenTurns.has(msg.turnUuid)) return;
  voice.spokenTurns.add(msg.turnUuid);
  while (voice.spokenTurns.size > SPOKEN_TURNS_MAX) {
    voice.spokenTurns.delete(voice.spokenTurns.values().next().value);
  }
  const summary = speakableSummary(msg);
  if (!voice.unlocked) {
    // Nothing can play yet. Queueing it would mean an announcement arriving
    // minutes stale whenever the user finally taps, so show it instead.
    voice.line = `🔊 ${msg.title ? msg.title + ': ' : ''}${summary}`;
    renderVoice();
    return;
  }
  // Before anything else, and before the /api/tts round-trip: the gap between
  // the turn ending and audio starting is ~7.5 s whenever the summariser model
  // runs, and this is what fills it.
  chime();
  // A newer turn for the same session supersedes an older unspoken one — the
  // stale one is only ever going to confuse.
  voice.queue = voice.queue.filter((m) => m.sessionId !== msg.sessionId);
  voice.queue.push({ sessionId: msg.sessionId, title: msg.title, turnUuid: msg.turnUuid, summary });
  pumpQueue();
}

async function pumpQueue() {
  // `voice.playing` alone isn't enough: when there's no synthesis to do, speak()
  // returns without ever setting it, and two announcements landing together
  // would each drain the queue.
  if (voice.pumping || voice.playing || voice.draft || voice.editing || !voice.queue.length) return;
  voice.pumping = true;
  try { await drainQueue(); } finally { voice.pumping = false; }
}

async function drainQueue() {
  if (!voice.queue.length) return;
  // Absorb a burst (arming several idle sessions at once) rather than reading
  // every summary at the user. The collapsed entry has no sessionId, so it
  // can't open the mic — you go look at the sidebar for those.
  if (voice.queue.length > QUEUE_SPEAK_MAX) {
    const rest = voice.queue.splice(QUEUE_SPEAK_MAX);
    const names = rest.map((m) => m.title).filter(Boolean).join(', ');
    voice.queue.push({
      sessionId: null, title: '', turnUuid: null,
      summary: `${rest.length} more sessions are waiting${names ? ': ' + names : ''}.`,
    });
  }
  const item = voice.queue.shift();
  // Only say whose turn it is when it's ambiguous — a title on every single
  // announcement gets old fast when you're only listening to one session.
  const prefix = voice.armed.size > 1 && item.title ? `${item.title}. ` : '';
  voice.status = `speaking${item.title ? ' — ' + item.title : ''}`;
  voice.line = `🔊 ${item.summary}`;
  const spoke = await speak(prefix + item.summary);
  // Speech can fail (piper gone, a 400, a dropped connection) long after the
  // chime already promised something. Mark the line so the user knows the text
  // on screen is all they're getting, instead of waiting for audio.
  if (spoke === 'fail') voice.line = `🔊 (couldn't speak this) ${item.summary}`;
  // Anything queued behind this one speaks first: opening the mic just to shut
  // it again for the next clip would flip the Bluetooth route twice for nothing.
  if (voice.queue.length) return drainQueue();
  if (!item.sessionId || !voice.armed.has(item.sessionId)) { voice.status = 'voice ready'; renderVoice(); return; }
  listenFor(item.sessionId);
}

function onBusy(sessionId) {
  voice.queue = voice.queue.filter((m) => m.sessionId !== sessionId);
  // The user is driving that session by hand — get off its mic. (Our own
  // committed text also makes the PTY chatter, but `pending` is already cleared
  // and the mic already closed by then, so this can't cancel our own send.)
  //
  // The grace window is not paranoia: `busy` is driven off PTY output, and
  // Claude Code repaints its own status line for a beat after finishing a turn.
  // A real run here produced a `busy` 117 ms after the announcement started
  // playing. Landing one of those just as the mic opens would close it before
  // the user got a word out, and they'd have no idea why.
  const micSettled = rec.openedAt && Date.now() - rec.openedAt > BUSY_GRACE_MS;
  if (rec.want && rec.sessionId === sessionId && micSettled) stopListening('busy');
  renderVoice();
}

// "Read that again" — recompute the current summary for whichever session we
// last heard from and speak it. Cheap when the server still has it cached.
async function readAgain() {
  const id = rec.sessionId || state.activeId;
  if (!id) return;
  stopListening();
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(id)}/voice/summary`);
    if (!r.summary) { voice.line = '🔊 nothing to read back'; renderVoice(); return; }
    voice.line = `🔊 ${r.summary}`;
    renderVoice();
    await speak(r.summary);
    listenFor(id);
  } catch {
    voice.line = '🔊 could not re-read that turn';
    renderVoice();
  }
}

// `hello` says who is armed, not who is currently waiting — and the server
// won't re-announce a turn it has already announced once. So a page reload (or
// iOS discarding the tab in the background) while a session sits waiting means
// that `waiting` never arrives again. Ask each armed session directly instead.
// Sequentially: each of these can spawn a summariser on the server.
async function catchUpArmed(ids) {
  for (const id of ids) {
    try {
      const r = await api(`/api/sessions/${encodeURIComponent(id)}/voice/summary`);
      if (!r.waiting || !r.turnUuid) continue;
      const s = state.sessions.find((x) => x.id === id);
      // Straight through onWaiting, so the uuid dedupe applies and a reconnect
      // that happens to race a live `waiting` can't announce the turn twice.
      onWaiting({ sessionId: id, title: (s && s.title) || '', turnUuid: r.turnUuid, summary: r.summary });
    } catch {
      // session gone, or the summariser failed — nothing to catch up on
    }
  }
}

// ---- speech in --------------------------------------------------------------

// Push the idle deadline out. Two mechanisms on purpose: `idleUntil` is checked
// on every `onend` (the cheap path, since iOS ends a recognition after each
// utterance anyway), and `idleTimer` is a watchdog for the case where a
// recogniser never ends at all — without it a stuck engine would sit on the
// microphone indefinitely, which is exactly the failure the user can't see.
// The watchdog only applies ONCE YOU HAVE STARTED TALKING. Before that the mic
// waits indefinitely: after an announcement you may want a minute to think, and
// a mic that quietly gives up while you are thinking is the same failure as one
// that never opened. Once there is a draft, the deadline exists purely to catch
// a recogniser that wedged mid-dictation — and even then stopListening('idle')
// SENDS what was said rather than binning it.
function bumpIdle() {
  const dictating = !!(voice.draft && voice.draft.text);
  clearTimeout(rec.idleTimer);
  if (!dictating) {
    rec.idleUntil = Infinity;   // thinking time is unlimited by design
    rec.idleTimer = null;
    return;
  }
  rec.idleUntil = Date.now() + LISTEN_IDLE_MS;
  rec.idleTimer = setTimeout(() => { if (rec.want) stopListening('idle'); }, LISTEN_IDLE_MS + 500);
}

function listenFor(sessionId) {
  vlog('listenFor');
  if (!canListen() || rec.denied || !sessionId || !voice.unlocked) { renderVoice(); return; }
  if (!rec.want) rec.openedAt = Date.now();   // a new stretch, not a re-arm
  rec.want = true;
  rec.sessionId = sessionId;
  rec.errors = 0;
  bumpIdle();
  armRecognition();
  renderVoice();
}

function armRecognition() {
  if (!rec.want) return;
  // Our own audio is still playing and the mic must never open over it. This is
  // transient, so come BACK — returning here would be a dead end: the only
  // things that call armRecognition are listenFor() and an onend that has
  // already fired, so bailing leaves rec.want true with nothing scheduled. The
  // user sees a mic stuck on "listening" that can never hear anything, forever.
  if (voice.playing) {
    clearTimeout(rec.restartTimer);
    rec.restartTimer = setTimeout(armRecognition, REARM_MS);
    vlog('rearm deferred: audio still playing');
    return;
  }
  // A recogniser is already live — safe to return, because its own onend
  // re-arms, and the idle watchdog catches it if it never ends.
  if (rec.sr) { vlog('rearm skipped: recogniser already live'); return; }
  let sr;
  try { sr = new SpeechRec(); } catch { rec.want = false; renderVoice(); return; }
  sr.lang = navigator.language || 'en-US';
  sr.continuous = false;     // ignored on iOS anyway — one utterance per start
  sr.interimResults = true;  // the undo window is driven off these
  sr.maxAlternatives = 1;
  rec.sr = sr;

  sr.onstart = () => { vlog('onstart'); renderVoice(); };
  sr.onaudiostart = () => vlog('onaudiostart (mic live)');
  sr.onresult = (ev) => handleResult(ev);
  sr.onerror = (ev) => {
    const err = ev && ev.error;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      // The only genuinely terminal one: the user (or the OS) said no.
      rec.denied = true;
      rec.want = false;
      voice.status = 'microphone blocked for this site';
      return;
    }
    // 'aborted' is what you get for stopping a recogniser that heard nothing,
    // and 'no-speech' is a quiet room. Both are ordinary punctuation in a
    // hands-free loop — re-arm (in onend) and say nothing about it.
    vlog('onerror ' + err);
    if (err !== 'aborted' && err !== 'no-speech') rec.errors += 1;
  };
  sr.onend = () => {
    vlog('onend');
    if (rec.sr === sr) rec.sr = null;   // a newer instance may already be live
    if (!rec.want) { renderVoice(); return; }
    if (Date.now() > rec.idleUntil) { stopListening('idle'); return; }
    if (rec.errors >= 5) { stopListening('error'); return; }
    // Back off on real errors so a broken speech service can't become a spin
    // loop; otherwise just enough of a pause for iOS to hand the mic back.
    const delay = rec.errors ? Math.min(4000, 500 * rec.errors) : REARM_MS;
    rec.restartTimer = setTimeout(armRecognition, delay);
  };

  try { sr.start(); vlog('start() called'); }
  catch { vlog('start() THREW'); rec.sr = null; rec.restartTimer = setTimeout(armRecognition, 500); }
}

function stopListening(reason) {
  // The 45 s watchdog firing mid-dictation must not bin what was already said —
  // send it rather than lose it. (sendDraft calls back in here with no reason,
  // after clearing the draft, so this can't recurse.)
  if (reason === 'idle' && voice.draft && voice.draft.text) { sendDraft(); return; }
  const wasOn = rec.want;
  rec.want = false;
  clearTimeout(rec.restartTimer);
  clearTimeout(rec.idleTimer);
  rec.restartTimer = null;
  rec.idleTimer = null;
  const sr = rec.sr;
  rec.sr = null;
  if (sr) { try { (sr.abort || sr.stop).call(sr); } catch {} }  // → onerror 'aborted', benign
  if (reason === 'idle' && wasOn) {
    voice.status = 'mic off — quiet for a while. Tap 🎤 to talk';
    toast('Mic closed after 45s of silence — tap 🎤 to talk', 'ok').close(6000);
  } else if (reason === 'error' && wasOn) {
    voice.status = 'speech recognition keeps failing — tap 🎤 to retry';
  } else if (reason === 'off' && wasOn) {
    voice.status = 'mic off';
  }
  renderVoice();
}

function handleResult(ev) {
  let interim = '';
  let final = '';
  for (let i = ev.resultIndex; i < ev.results.length; i++) {
    const r = ev.results[i];
    const txt = (r[0] && r[0].transcript) || '';
    if (r.isFinal) final += txt; else interim += txt;
  }
  rec.errors = 0;
  bumpIdle();                       // someone's talking; keep the mic open
  const heard = (final || interim).trim();
  if (!heard) return;

  // Any speech at all — even a half-word interim — means the user is still
  // going, so push the send back. This is what makes a mid-sentence pause safe.
  if (final.trim()) addToDraft(rec.sessionId, final.trim());
  else showDraft(interim.trim());
  restartSendTimer();
}

// ---- dictation draft: accumulate across utterances, send after a silence -----
//
// iOS ends a recognition after every utterance, so a natural pause mid-sentence
// arrives as `onend` + a brand-new recogniser rather than as one continuous
// result. Committing on each final transcript therefore sent half a sentence
// every time the user drew breath. Instead, text accumulates HERE, across
// recogniser instances, and is only sent once SEND_SILENCE_MS passes with
// nothing new heard. A pause extends the window; it never ends the turn.

function addToDraft(sessionId, text) {
  if (!sessionId) return;
  const d = voice.draft;
  if (d && d.sessionId === sessionId) d.text = `${d.text} ${text}`.trim();
  else voice.draft = { sessionId, text, timer: null };
  showDraft('');
}

// The line under the status shows what's banked plus whatever is being said
// right now, so the user can watch their sentence build.
function showDraft(interim) {
  const banked = voice.draft ? voice.draft.text : '';
  const shown = [banked, interim].filter(Boolean).join(' ');
  voice.line = shown ? '🎤 ' + shown : '';
  voice.status = banked ? 'listening — will send when you stop' : 'listening';
  renderVoice();
}

function restartSendTimer() {
  const d = voice.draft;
  if (!d) return;
  clearTimeout(d.timer);
  d.timer = setTimeout(() => sendDraft(), SEND_SILENCE_MS);
}

function cancelDraft() {
  if (!voice.draft) return;
  clearTimeout(voice.draft.timer);
  voice.draft = null;
}

async function sendDraft() {
  const d = voice.draft;
  if (!d || !d.text) return;
  clearTimeout(d.timer);
  voice.draft = null;
  // Close the mic before typing: our own text makes the PTY chatter, and an
  // open mic would also catch the room while the send is in flight.
  stopListening();
  voice.status = 'sending';
  renderVoice();
  const t = await ensureTerminal(d.sessionId);
  if (!t) {
    // Don't lose the words just because the terminal went away.
    openVoiceEditor(d.sessionId, d.text);
    toast('Could not reach that session — text kept below', 'err').close(6000);
    return;
  }
  typeAndSubmit(t, d.text);
  sendBlip();            // the only feedback on send; no spoken read-back
  vlog('sent: ' + d.text.slice(0, 40));
  voice.status = 'sent';
  voice.line = '';
  renderVoice();
  // Don't leave "sent" as the standing label — the next thing to happen is the
  // session going busy, and the strip should read as idle-and-ready by then.
  setTimeout(() => { if (voice.status === 'sent') { voice.status = 'voice ready'; renderVoice(); } }, 4000);
}

// ---- sending ----------------------------------------------------------------

// Voice replies go out over the session's own terminal WebSocket, which only
// exists once the terminal is open in this page — an announcement can easily
// arrive for a session the user hasn't opened, so open it and wait for the
// socket rather than dropping the text.
// Claude Code's TUI treats a large input burst as a *paste*, so a "\r" riding
// along in the same write lands as a newline inside the prompt box instead of
// submitting it. Measured against a live session on this machine: 96 characters
// plus "\r" in one write sat there unsent; the identical text with the "\r" as
// its own write 150 ms later went straight through. Voice transcripts are
// routinely that long, so always send the Enter separately.
const SUBMIT_DELAY_MS = 200;
function typeAndSubmit(t, text) {
  sendInput(t, text);
  setTimeout(() => sendInput(t, '\r'), SUBMIT_DELAY_MS);
}

function ensureTerminal(id) {
  let t = state.open.get(id);
  if (!t) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s || !s.alive) return Promise.resolve(null);
    openTerminal(id, s.title, s.kind);
    t = state.open.get(id);
  }
  if (!t) return Promise.resolve(null);
  if (t.ws && t.ws.readyState === WebSocket.OPEN) return Promise.resolve(t);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (t.ws && t.ws.readyState === WebSocket.OPEN) { clearInterval(poll); resolve(t); }
      else if (Date.now() - started > 5000) { clearInterval(poll); resolve(null); }
    }, 100);
  });
}

function openVoiceEditor(sessionId, text) {
  if (!sessionId) { toast('Open a terminal first', 'err').close(3000); return; }
  voice.editing = { sessionId };
  $('#voice-edit-text').value = text || '';
  voice.line = '';   // the words are in the box now; don't print them twice
  renderVoice();
  setTimeout(() => $('#voice-edit-text').focus(), 50);
}

async function sendVoiceEditor() {
  const ed = voice.editing;
  if (!ed) return;
  const text = $('#voice-edit-text').value.trim();
  voice.editing = null;
  voice.line = '';
  voice.status = text ? 'sent' : 'voice ready';
  renderVoice();
  if (!text) return;
  const t = await ensureTerminal(ed.sessionId);
  if (!t) { toast('That session is gone — nothing sent', 'err').close(5000); return; }
  typeAndSubmit(t, text);
  pumpQueue();  // an announcement may have queued up behind the editor
}

function discardVoiceEditor() {
  voice.editing = null;
  voice.line = '';
  voice.status = 'voice ready';
  renderVoice();
  pumpQueue();
}

// ---- arming -----------------------------------------------------------------

// Called from "Enable voice" so that one tap is genuinely all it takes. Only
// claude sessions can announce (nothing else writes a transcript), so a shell
// is skipped silently rather than reported as a failure — the strip already
// says voice is ready, and there is nothing the user did wrong.
function armActiveSessionForVoice() {
  const id = state.activeId;
  if (!id || voice.armed.has(id)) return;
  const info = state.sessions.find((s) => s.id === id);
  if (!info || info.kind !== 'claude') return;
  toggleVoiceArm(id, true);
}

async function toggleVoiceArm(id, on) {
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(id)}/voice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ armed: on }),
    });
    if (r.armed) voice.armed.add(id); else voice.armed.delete(id);
  } catch (e) {
    toast('Could not change announcements: ' + e.message, 'err').close(5000);
    return;
  }
  if (!on) onBusy(id);   // disarming drops anything queued for it, same as busy
  syncSidebar();
  renderVoice();
}

// ---- the voice strip --------------------------------------------------------

function renderVoice() {
  if (VOICE_DEBUG) {
    const dbg = document.getElementById('voice-debug');
    if (dbg) dbg.classList.remove('hidden');
  }
  const bar = $('#voice-bar');
  if (!bar) return;
  const show = voice.armed.size > 0 || rec.want || !!voice.draft || !!voice.editing || voice.playing;
  bar.classList.toggle('hidden', !show);
  if (!show) return;

  const locked = !voice.unlocked;
  bar.classList.toggle('locked', locked);

  let status;
  if (locked) {
    const n = voice.armed.size;
    status = n
      ? `${n} session${n === 1 ? '' : 's'} armed — audio is locked until you tap`
      : 'audio is locked until you tap';
  } else if (voice.draft) {
    // showDraft() owns the wording while dictation is accumulating.
    status = voice.status || 'listening';
  } else if (rec.want) status = 'listening…';
  else status = voice.status || 'voice ready';
  $('#voice-status').textContent = status;

  $('#voice-unlock').classList.toggle('hidden', !locked);
  $('#voice-off').classList.toggle('hidden', !rec.want);
  $('#voice-again').classList.toggle('hidden', locked || !voice.tts.available || !rec.sessionId);

  const heard = $('#voice-heard');
  heard.textContent = voice.line;
  heard.classList.toggle('hidden', !voice.line);

  $('#voice-edit').classList.toggle('hidden', !voice.editing);

  const mic = $('#mic-key');
  if (mic) mic.classList.toggle('armed', rec.want);
  $('#voice-dot').className =
    locked ? 'locked' : rec.want ? 'listening' : voice.playing ? 'speaking' : 'ready';
  measureChrome();
}

// Toasts sit above the bottom chrome, which is now the key bar *plus* however
// tall the voice strip currently is (it grows an editor). Measured rather than
// guessed, because a toast landing on top of the voice status is at its most
// annoying exactly when both have something to say.
function measureChrome() {
  const bar = $('#voice-bar');
  const keys = $('#keybar');
  const h = (keys ? keys.offsetHeight : 0) + (bar && !bar.classList.contains('hidden') ? bar.offsetHeight : 0);
  document.documentElement.style.setProperty('--chrome-h', h + 'px');
}

function onMicKey() {
  // This tap is a user gesture — the only place the audio unlock can happen —
  // so do it here too rather than making the user find the other button.
  if (!voice.unlocked) enableVoice();
  if (rec.want) { stopListening('off'); return; }
  // Whatever you're looking at is what you're talking to; only fall back to the
  // last-announced session when nothing is open in front of you. Checked before
  // anything else so "open a terminal first" can't shout over a more specific
  // explanation below.
  const target = state.activeId
    || (rec.sessionId && state.sessions.some((s) => s.id === rec.sessionId && s.alive) ? rec.sessionId : null);
  if (!target) { toast('Open a terminal first', 'err').close(3000); return; }
  if (!canListen()) {
    // No Web Speech at all (desktop Firefox), or an insecure origin where the
    // API simply isn't exposed. Either way: fall back to typing into the same
    // box a cancelled utterance lands in — same destination, same Enter.
    if (!SECURE) toast(`Voice input needs ${secureUrl()}`, 'err').close(9000);
    else toast('This browser has no speech recognition — type it instead', 'err').close(6000);
    openVoiceEditor(target, '');
    return;
  }
  // A tap after fixing the permission is the user asking again — clear the
  // sticky refusal and let the browser answer, rather than making them reload.
  if (rec.denied) { rec.denied = false; toast('Asking for microphone access again…').close(3000); }
  voice.line = '';
  listenFor(target);
}

// ---- /ws/voice --------------------------------------------------------------

// Same reconnect shape as the terminal socket (see connect() above), with one
// deliberate difference: no attempt cap. A terminal socket gives up because its
// session can genuinely be gone; the voice feed belongs to the page, so it
// should still be trying when the laptop comes back from sleep.
function connectVoice() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/voice`);
  voice.ws = ws;
  ws.onopen = () => {
    voice.attempts = 0;
    clearInterval(voice.pingTimer);
    voice.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, VOICE_PING_MS);
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello') {
      voice.tts = msg.tts || { available: false, voice: '' };
      voice.armed = new Set((msg.sessions || []).filter((s) => s.armed).map((s) => s.id));
      syncSidebar();
      renderVoice();
      catchUpArmed([...voice.armed]);
    } else if (msg.type === 'waiting') onWaiting(msg);
    else if (msg.type === 'busy') onBusy(msg.sessionId);
    else if (msg.type === 'armed') {
      if (msg.armed) voice.armed.add(msg.sessionId); else { voice.armed.delete(msg.sessionId); onBusy(msg.sessionId); }
      syncSidebar();
      renderVoice();
    }
  };
  ws.onclose = () => {
    clearInterval(voice.pingTimer);
    voice.attempts += 1;
    voice.reconnectTimer = setTimeout(connectVoice, Math.min(5000, 400 * voice.attempts));
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// ---- drawer (mobile) ------------------------------------------------------

function openDrawer() { document.body.classList.add('drawer-open'); }
function closeDrawer() { document.body.classList.remove('drawer-open'); }

// ---- sidebar collapse (desktop) --------------------------------------------
// Desktop-only max-real-estate toggle — mobile already keeps the sidebar out of
// the way by default via the drawer above. Remembered across reloads the same
// way the mouse-select hint dismissal is (see HINT_DISMISSED below).
const SIDEBAR_COLLAPSED_KEY = 'termhub-sidebar-collapsed';
function setSidebarCollapsed(on) {
  document.body.classList.toggle('sidebar-collapsed', on);
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, on ? '1' : '0'); } catch {}
}

// ---- misc -----------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function refitActive() {
  const t = state.open.get(state.activeId);
  if (t) scheduleFit(t);
}

// Nudge the user about Shift-select, but only when it's actually relevant: on
// desktop (Shift-drag is meaningless on touch) and while the active terminal is
// running a full-screen app that has grabbed the mouse, so a plain drag won't
// select text. Dismissing it hides it for good on this browser.
const HINT_DISMISSED = 'termhub-hide-mouse-hint';
function updateMouseHint() {
  const el = $('#mouse-hint');
  if (!el) return;
  let show = false;
  if (!isMobile() && localStorage.getItem(HINT_DISMISSED) !== '1') {
    const t = state.open.get(state.activeId);
    show = !!(t && appWantsMouse(t));
  }
  el.classList.toggle('hidden', !show);
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
  cwdCombo = makeCombobox($('#dlg-cwd'), $('#dlg-cwd-list'), { getItems: dirItems, keepOpenOnPick: true });
  cmdCombo = makeCombobox($('#dlg-cmd'), $('#dlg-cmd-list'), { getItems: commandItems, keepOpenOnPick: false });
  $('#menu-btn').onclick = openDrawer;
  $('#sidebar-close').onclick = closeDrawer;
  $('#scrim').onclick = closeDrawer;
  $('#sidebar-collapse').onclick = () => setSidebarCollapsed(true);
  $('#sidebar-expand').onclick = () => setSidebarCollapsed(false);
  $('#dlg-cancel').onclick = closeDialog;
  $('#dlg-open').onclick = submitDialog;
  $('#dialog-backdrop').onclick = (e) => { if (e.target.id === 'dialog-backdrop') closeDialog(); };

  $('#update-btn').onclick = openUpdatePanel;
  $('#update-close').onclick = closeUpdatePanel;
  $('#update-check').onclick = recheckUpdate;
  $('#update-apply').onclick = applyUpdate;
  $('#update-backdrop').onclick = (e) => { if (e.target.id === 'update-backdrop') closeUpdatePanel(); };

  $('#mouse-hint-dismiss').onclick = () => {
    try { localStorage.setItem(HINT_DISMISSED, '1'); } catch {}
    updateMouseHint();
  };

  $('#kbd-key').onclick = () => { const t = state.open.get(state.activeId); if (t) t.term.focus(); };
  // Plain click (not pointerdown) so iOS counts it as the user gesture the
  // Clipboard API requires before it will hand over clipboard contents. Same
  // for 📎: Safari only opens a file picker from inside a real click.
  $('#paste-key').onclick = doPaste;
  $('#attach-key').onclick = openFilePicker;
  // Voice buttons are all plain clicks on purpose: iOS only counts a real click
  // as the gesture that unlocks audio and the microphone.
  $('#mic-key').onclick = onMicKey;
  $('#voice-unlock').onclick = enableVoice;
  $('#voice-off').onclick = () => stopListening('off');
  $('#voice-again').onclick = readAgain;
  $('#voice-edit-send').onclick = sendVoiceEditor;
  $('#voice-edit-discard').onclick = discardVoiceEditor;
  $('#file-input').onchange = (e) => onFilesPicked(e.target);
  document.querySelectorAll('#keybar .key[data-key]').forEach((btn) => {
    // Use pointerdown so focus stays on the terminal and the key registers on phones.
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); handleKey(btn.dataset.key); });
  });

  document.addEventListener('keydown', (e) => {
    const dlgOpen = !$('#dialog-backdrop').classList.contains('hidden');
    if (e.key === 'Escape' && dlgOpen) closeDialog();
    if (e.key === 'Enter' && dlgOpen) submitDialog();
    if (e.key === 'Escape' && !$('#update-backdrop').classList.contains('hidden')) closeUpdatePanel();
    // Escape is the desktop equivalent of saying "stop" during the undo window.
  });

  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('orientationchange', () => setTimeout(syncViewportHeight, 200));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    window.visualViewport.addEventListener('scroll', syncViewportHeight);
  }
}

// Learn the sessiond host's OS and upload caps once at startup — the OS
// determines which hotkey triggers Claude Code's clipboard-image paste, the caps
// let us reject a too-big file before uploading it (see sendAttachment above).
api('/api/info').then((info) => {
  state.platform = info.platform || '';
  state.limits = info.limits || null;
}).catch(() => {});

// Restore a persisted sidebar-collapse choice — desktop-only concept (see
// setSidebarCollapsed above), so it's a no-op on mobile regardless of what's stored.
if (!isMobile() && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') setSidebarCollapsed(true);

wireEvents();
syncViewportHeight();
// One voice feed for the whole page (not one per terminal): `waiting` is about
// a session, but the speaker and the microphone belong to the browser.
connectVoice();
renderVoice();
refresh();
setInterval(refresh, 2000); // keep the sidebar "working" status roughly live
setInterval(updateMouseHint, 1000); // reflect entering/leaving a full-screen app
backgroundUpdateCheck();
setInterval(backgroundUpdateCheck, UPDATE_POLL_MS); // nudge ~once a day
