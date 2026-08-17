'use strict';

// The idle dashboard (/dashboard) — history for the tracker in lib/idleHub.js.
//
// Everything here is drawn from two endpoints and a lot of arithmetic:
//   GET /api/idle/history                    every recorded day, rolled up
//   GET /api/idle/history?day=&episodes=1    one day, plus its raw episodes
//
// The headline number is the **idle share** — waiting / (waiting + working) —
// not raw idle minutes. Raw minutes punish a long day and flatter a short one,
// which is exactly backwards for something you are meant to want to improve.
// Ten hours of work with forty minutes of waiting is a better day than two
// hours with thirty, and only the ratio says so.

const $ = (sel) => document.querySelector(sel);

// Under this share of engaged time spent waiting, the day counts as a win — the
// bar the streak is measured against. 15% is roughly "one nine-minute gap an
// hour": tight enough to be worth chasing, loose enough to be reachable while
// actually reading what the agent wrote.
const TARGET_SHARE = 0.15;

const state = {
  days: [],        // [{day, working, waiting, limited, handoffs, peakParallel, sessions}]
  byDay: new Map(),
  month: null,     // Date pinned to the 1st of the displayed month
  selected: null,  // 'YYYY-MM-DD'
  detail: null,    // the selected day's rollup + episodes
  live: new Set(), // session ids still alive on the server right now
  restorable: new Set(),
  // Machines. `machine: null` means this one — the server we were served from.
  // Stats are per machine by design: switching machines re-fetches everything
  // below the strip rather than blending anything together.
  machine: null,   // hostname of the peer being viewed, or null for local
  machines: [],    // [{host, machine, online, local, idle}]
};

async function api(path) {
  const res = await fetch(path);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Every data read goes through here, so "which machine am I looking at?" is
// answered in exactly one place. A peer is read through our own front
// (/api/peers/<host>/…) rather than from the browser directly: same origin, and
// it works from a phone that can reach this machine but not necessarily the
// peer's name.
function machineApi(kind, query = '') {
  if (!state.machine) return api(kind === 'idle' ? '/api/idle' : `/api/idle/history${query}`);
  return api(`/api/peers/${encodeURIComponent(state.machine)}/${kind}${query}`);
}

// ---- formatting ------------------------------------------------------------

function hm(ms) {
  const m = Math.round((ms || 0) / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function mmss(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  return hm(ms);
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function share(r) {
  const engaged = (r.working || 0) + (r.waiting || 0);
  return engaged ? (r.waiting || 0) / engaged : 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- the score -------------------------------------------------------------

function renderScore() {
  const r = state.detail;
  const el = $('#score-ring');
  if (!r) return;
  const pct = share(r);
  $('#score-pct').textContent = `${Math.round(pct * 100)}%`;
  el.style.setProperty('--score-deg', `${Math.min(360, pct * 360)}deg`);
  el.style.setProperty('--score-color',
    pct <= TARGET_SHARE ? 'var(--ok)' : pct <= 0.3 ? 'var(--accent-2)' : 'var(--danger)');

  const d = new Date(dayStart(r.day));
  $('#score-day').textContent = d.toLocaleDateString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric' });

  const engaged = (r.working || 0) + (r.waiting || 0);
  $('#score-verdict').textContent = !engaged
    ? 'No agent sessions ran.'
    : `${hm(r.waiting)} waiting out of ${hm(engaged)} engaged`
      + (r.limited ? ` · ${hm(r.limited)} out of tokens (not counted)` : '');

  // The streak is the game: consecutive days, ending today or yesterday, under
  // the target. Days with no sessions at all are skipped rather than breaking
  // it — a weekend off is not a regression.
  $('#score-streak').textContent = streakText();
}

function streakText() {
  const played = state.days.filter((d) => (d.working || 0) + (d.waiting || 0) > 0).sort((a, b) => (a.day < b.day ? 1 : -1));
  let n = 0;
  for (const d of played) {
    if (share(d) > TARGET_SHARE) break;
    n++;
  }
  const best = played.filter((d) => share(d) <= TARGET_SHARE).length;
  if (!played.length) return '';
  return n
    ? `🔥 ${n} day${n === 1 ? '' : 's'} running under ${Math.round(TARGET_SHARE * 100)}% · ${best} in total`
    : `Target is ${Math.round(TARGET_SHARE * 100)}% idle share · ${best} day${best === 1 ? '' : 's'} met it so far`;
}

// ---- tiles -----------------------------------------------------------------

function renderTiles() {
  const r = state.detail;
  const wrap = $('#tiles');
  if (!r) { wrap.innerHTML = ''; return; }
  // Idle per handoff is the fairest single number in here: it asks "when the
  // agent handed the work back, how long did it sit?" — independent of how long
  // the day was and of how much you got done.
  const perHandoff = r.handoffs ? r.waiting / r.handoffs : 0;
  const tiles = [
    { k: 'idle', v: hm(r.waiting), cls: share(r) > TARGET_SHARE ? 'warn' : 'good' },
    { k: 'working', v: hm(r.working), cls: '' },
    { k: 'handoffs', v: String(r.handoffs || 0), cls: '' },
    { k: 'idle per handoff', v: r.handoffs ? mmss(perHandoff) : '—', cls: perHandoff > 5 * 60000 ? 'bad' : '' },
    { k: 'peak parallel', v: `×${r.peakParallel || 0}`, cls: (r.peakParallel || 0) > 1 ? 'good' : '' },
    { k: 'sessions', v: String((r.sessions || []).length), cls: '' },
  ];
  if (r.limited) tiles.push({ k: 'out of tokens', v: hm(r.limited), cls: 'bad' });
  wrap.innerHTML = tiles
    .map((t) => `<div class="tile ${t.cls}"><div class="v">${escapeHtml(t.v)}</div><div class="k">${escapeHtml(t.k)}</div></div>`)
    .join('');
}

// ---- calendar --------------------------------------------------------------

// Five buckets of idle share. Deliberately coarse: the point of the grid is to
// find the bad week at a glance, not to rank two days a percent apart.
function heatClass(r) {
  const engaged = (r.working || 0) + (r.waiting || 0);
  if (!engaged) return '';
  const s = share(r);
  if (s <= 0.10) return 's0';
  if (s <= 0.20) return 's1';
  if (s <= 0.35) return 's2';
  if (s <= 0.50) return 's3';
  return 's4';
}

function renderCalendar() {
  const grid = $('#calendar');
  const month = state.month;
  $('#cal-title').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const lead = first.getDay(); // 0 = Sunday, matching the header row below

  const cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    .map((d) => `<div class="cal-dow">${d}</div>`);
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-day empty"></div>');

  const p = (n) => String(n).padStart(2, '0');
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${month.getFullYear()}-${p(month.getMonth() + 1)}-${p(day)}`;
    const r = state.byDay.get(key);
    const classes = ['cal-day'];
    if (r) classes.push('has-data', heatClass(r));
    if (key === todayKey()) classes.push('today');
    if (key === state.selected) classes.push('selected');
    const amt = r ? hm(r.waiting) : '';
    cells.push(
      `<div class="${classes.join(' ')}" data-day="${key}"`
      + (r ? ` title="${escapeHtml(`${hm(r.waiting)} idle of ${hm((r.working || 0) + (r.waiting || 0))} · ${r.handoffs} handoffs`)}"` : '')
      + `><span>${day}</span><span class="amt">${escapeHtml(amt)}</span></div>`,
    );
  }
  grid.innerHTML = cells.join('');
  for (const cell of grid.querySelectorAll('.cal-day.has-data')) {
    cell.onclick = () => selectDay(cell.dataset.day);
  }
}

// ---- the day's timeline ----------------------------------------------------

// One row per session, bands positioned by wall-clock time across the day. This
// is the view that answers "what was actually going on at 3pm" — a rollup can't,
// and it is where a long amber band makes the number visceral.
function renderTimeline() {
  const wrap = $('#timeline');
  const r = state.detail;
  if (!r || !r.episodes || !r.episodes.length) {
    wrap.innerHTML = '<div class="tl-empty">Nothing ran on this day.</div>';
    return;
  }
  const start = dayStart(r.day);
  const span = 24 * 60 * 60 * 1000;

  const bySession = new Map();
  for (const ep of r.episodes) {
    if (!bySession.has(ep.id)) bySession.set(ep.id, []);
    bySession.get(ep.id).push(ep);
  }

  const hours = [];
  for (let h = 0; h < 24; h += 3) hours.push(`<span>${String(h).padStart(2, '0')}</span>`);

  const rows = [...bySession.entries()].map(([id, eps]) => {
    const meta = (r.sessions || []).find((s) => s.id === id) || {};
    const bands = eps.map((ep) => {
      const left = ((ep.start - start) / span) * 100;
      // Floor the width so a 3-second episode is still visible; without it the
      // busiest sessions render as an empty track.
      const width = Math.max(0.25, ((ep.end - ep.start) / span) * 100);
      const when = new Date(ep.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      return `<div class="tl-band ${ep.state}" style="left:${left}%;width:${width}%" `
        + `title="${escapeHtml(`${ep.state} · ${when} · ${mmss(ep.end - ep.start)}`)}"></div>`;
    }).join('');
    const name = meta.title || id;
    return `<div class="tl-row"><div class="tl-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>`
      + `<div class="tl-track">${bands}</div></div>`;
  });

  wrap.innerHTML = `<div class="tl-hours">${hours.join('')}</div>${rows.join('')}`;
}

// ---- the day's sessions ----------------------------------------------------

function renderDaySessions() {
  const wrap = $('#day-sessions');
  const r = state.detail;
  const sessions = (r && r.sessions) || [];
  if (!sessions.length) { wrap.innerHTML = '<div class="list-note">No agent sessions on this day.</div>'; return; }

  wrap.innerHTML = sessions.map((s) => {
    // "Go back to it" means three different things and the button says which:
    //   live        -> open the terminal that is already running
    //   ended, id   -> reopen: spawn it again with `--resume <conversation>`,
    //                  in the directory it ran in. This is the point of keeping
    //                  the command and the agent id in the episode log — the
    //                  session archive has long since forgotten this session.
    //   ended, none -> reopen in the old directory, but as a fresh conversation;
    //                  the tooltip says so rather than implying history returns.
    const live = state.live.has(s.id);
    const resumable = !!s.agentSessionId;
    // Viewing another machine, neither button can work from here: the session
    // lives in THAT machine's sessiond, and reopening is its supervisor's job.
    // So the row links to that machine's own termhub instead of offering a
    // control that would quietly do nothing — or worse, spawn the session on
    // the wrong box.
    const peer = state.machine && state.machines.find((m) => m.host === state.machine);
    const go = peer
      ? `<a class="ds-go" href="${escapeHtml(peer.url || `https://${state.machine}`)}/#session=${encodeURIComponent(s.id)}"`
        + ` target="_blank" rel="noopener" title="Opens ${escapeHtml(peer.machine)}'s termhub">on ${escapeHtml(peer.machine)} ↗</a>`
      : live
      ? `<a class="ds-go" href="/#session=${encodeURIComponent(s.id)}">open</a>`
      : `<button class="ds-go" data-reopen="${escapeHtml(s.id)}" title="${resumable
          ? 'Reopen this conversation where it left off'
          : 'No conversation id was recorded — reopens in the same directory as a fresh session'}">`
        + `${resumable ? 'reopen' : 'reopen fresh'}</button>`;
    return `<div class="ds-row">`
      + `<div class="ds-main">`
        + `<div class="ds-title">${escapeHtml(s.title || s.id)}</div>`
        + `<div class="ds-cwd">${escapeHtml(s.cwd || '')}</div>`
      + `</div>`
      + `<div class="ds-num"><b>${escapeHtml(hm(s.waiting))}</b> idle</div>`
      + `<div class="ds-num">${escapeHtml(hm(s.working))} working</div>`
      + `<div class="ds-num">${s.handoffs} handoff${s.handoffs === 1 ? '' : 's'}</div>`
      + go
      + `</div>`;
  }).join('');

  for (const btn of wrap.querySelectorAll('[data-reopen]')) {
    btn.onclick = () => reopen(btn.dataset.reopen, btn);
  }
}

// Spawn the session again and go straight to it. The server decides how (see
// POST /api/idle/reopen): the archive when it still holds the entry, the idle
// log when it doesn't.
async function reopen(id, btn) {
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'opening…';
  try {
    const res = await fetch('/api/idle/reopen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    // Hand off to the hub with the NEW id — reopening mints a fresh session.
    location.href = `/#session=${encodeURIComponent(body.id)}`;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = was;
    toast(String(e.message || e));
  }
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

// ---- where the idle went ---------------------------------------------------

function renderProjects() {
  const wrap = $('#projects');
  const projects = (state.detail && state.detail.projects) || [];
  if (!projects.length) { wrap.innerHTML = '<div class="list-note">Nothing to attribute yet.</div>'; return; }
  const worst = Math.max(...projects.map((p) => p.waiting), 1);
  wrap.innerHTML = projects.map((p) => {
    const pct = Math.round((p.waiting / worst) * 100);
    const s = share(p);
    return `<div class="pj-row">`
      + `<div class="pj-cwd" title="${escapeHtml(p.cwd)}">${escapeHtml(p.cwd)}</div>`
      + `<div class="pj-bar"><span style="width:${pct}%"></span></div>`
      + `<div class="pj-num"><b>${escapeHtml(hm(p.waiting))}</b> · ${Math.round(s * 100)}%</div>`
      + `</div>`;
  }).join('');
}

// ---- the trend -------------------------------------------------------------

// Last 14 recorded days as bars of idle share, oldest left. Bars are drawn from
// the SHARE, not the minutes, for the same reason the headline is: a quiet day
// should not look like an improvement.
function renderTrend() {
  const el = $('#trend');
  const played = state.days.filter((d) => (d.working || 0) + (d.waiting || 0) > 0).slice(-14);
  if (played.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = played.map((d) => {
    const s = share(d);
    const h = Math.max(6, Math.min(100, s * 200)); // 50% share = full height
    const cls = s <= TARGET_SHARE ? 'good' : s <= 0.3 ? 'ok' : 'bad';
    const title = `${d.day}: ${Math.round(s * 100)}% idle · ${hm(d.waiting)} of ${hm(d.working + d.waiting)}`;
    return `<span class="trend-bar ${cls}" style="height:${h}%" title="${escapeHtml(title)}"`
      + ` data-day="${d.day}"></span>`;
  }).join('');
  for (const bar of el.querySelectorAll('.trend-bar')) {
    bar.onclick = () => selectDay(bar.dataset.day);
  }
}

// ---- loading ---------------------------------------------------------------

async function selectDay(key) {
  state.selected = key;
  renderCalendar();
  try {
    state.detail = await machineApi('history', `?day=${encodeURIComponent(key)}&episodes=1`);
  } catch {
    state.detail = null;
  }
  renderScore();
  renderTiles();
  renderTrend();
  renderTimeline();
  renderProjects();
  renderDaySessions();
}

async function loadHistory() {
  const h = await machineApi('history').catch(() => ({ days: [], unavailable: true }));
  state.days = h.days || [];
  state.unavailable = !!h.unavailable;
  state.byDay = new Map(state.days.map((d) => [d.day, d]));
  const label = state.machine
    ? (state.machines.find((m) => m.host === state.machine) || {}).machine || state.machine
    : h.machine || '';
  $('#dash-machine').textContent = state.unavailable ? `${label} — no idle data` : label;
  renderNote();
}

// Say why the page is empty, in the one case where empty is not an answer.
function renderNote() {
  const note = $('#dash-note');
  if (!state.unavailable) { note.classList.add('hidden'); return; }
  note.classList.remove('hidden');
  note.innerHTML = state.machine
    ? `<b>This machine isn't tracking idle time yet.</b> Its termhub is running a build from `
      + `before the idle tracker. Update it there (⟳ Update), then restart its supervisor.`
    : `<b>This machine isn't tracking idle time yet.</b> The web tier is up to date, but the `
      + `session supervisor still runs the old build — an update deliberately never restarts it, `
      + `because that ends every live terminal. From a <i>non-termhub</i> PowerShell window:`
      + `<code>cd C:\\repos\\dev-tools\\termhub<br>.\\windows\\restart-sessiond.ps1</code>`
      + `Terminals come back as <b>Restorable</b>, and a claude session resumes its conversation.`;
}

async function loadLiveSessions() {
  // Only meaningful for the local machine: "open" and "reopen" act on THIS
  // server's sessions. Viewing a peer, every row is history — see renderDaySessions.
  state.live = new Set();
  state.restorable = new Set();
  if (state.machine) return;
  try {
    const s = await api('/api/sessions');
    state.live = new Set((s.sessions || []).filter((x) => x.alive).map((x) => x.id));
    state.restorable = new Set((s.restorable || []).map((x) => x.id));
  } catch {
    // the dashboard is still readable without knowing what's live
  }
}

// ---- machines --------------------------------------------------------------

// One card per machine, each showing ITS OWN numbers. Nothing is summed across
// them: which box the idle time happened on is information, and a blended
// figure would throw it away.
async function loadMachines() {
  const local = await api('/api/idle').catch(() => null);
  // The local machine is ALWAYS online — it just served this page. Deriving
  // `online` from whether /api/idle answered was wrong and alarming: on a
  // machine whose front has been updated but whose sessiond hasn't (the normal
  // state right after a front swap, since sessiond is deliberately never
  // restarted by an update) the box you are sitting at reported itself offline.
  // "No tracking yet" and "unreachable" are different problems with different
  // fixes, and the card now says which.
  // The name comes from /api/info when the idle endpoint has nothing to give —
  // reading it back out of the header element (which loadHistory had just
  // written "— no idle data" into) made the card name itself "— no idle data".
  let localName = local && local.machine;
  if (!localName) localName = await api('/api/info').then((i) => i.machine).catch(() => null);
  const cards = [{
    host: null,
    machine: localName || 'this machine',
    online: true,
    local: true,
    idle: local,
  }];

  const { peers = [] } = await api('/api/peers').catch(() => ({ peers: [] }));
  const fetched = await Promise.all(peers.map(async (p) => {
    const host = (() => { try { return new URL(p.url).hostname; } catch { return p.url; } })();
    const idle = p.online ? await api(`/api/peers/${encodeURIComponent(host)}/idle`).catch(() => null) : null;
    // A peer running an older build answers /api/ping without a `machine`, so
    // fall back to the first label of its tailnet name — the full DNSName is
    // three-quarters shared suffix and reads as noise in a card.
    return { host, url: p.url, machine: p.machine || host.split('.')[0], online: !!p.online, local: false, idle };
  }));
  state.machines = cards.concat(fetched);
  renderMachines();
}

function renderMachines() {
  const strip = $('#machine-strip');
  if (state.machines.length < 2) {
    // A single machine gets no strip at all — a chooser with one option is
    // furniture. The "+ find machines" button stays.
    strip.innerHTML = '';
    return;
  }
  strip.innerHTML = state.machines.map((m) => {
    const sel = (m.host || null) === state.machine;
    const t = m.idle && m.idle.today;
    const pct = t ? Math.round(share(t) * 100) : null;
    const cls = pct === null ? '' : pct <= TARGET_SHARE * 100 ? 'good' : pct <= 30 ? 'ok' : 'bad';
    return `<button class="mc${sel ? ' selected' : ''}${m.online ? '' : ' offline'}" `
      + `data-host="${escapeHtml(m.host || '')}">`
      + `<div class="mc-name">${escapeHtml(m.machine)}${m.local ? ' <span class="mc-tag">here</span>' : ''}</div>`
      // Three states, and the middle one is worth spelling out: a machine can
      // be up, reachable and running termhub, and still have no idle data —
      // because it hasn't been updated to a build that measures any. "—" would
      // read as "you were never idle there", which is the opposite of true.
      + (!m.online
        ? `<div class="mc-num off">offline</div><div class="mc-sub">its history lives on it</div>`
        : !m.idle
          ? `<div class="mc-num off">no idle data</div><div class="mc-sub">${m.local
              ? 'restart sessiond to start tracking'
              : 'update termhub on that machine'}</div>`
          : `<div class="mc-num ${cls}">${hm(t.waiting)} idle${pct === null ? '' : ` · ${pct}%`}</div>`
            + `<div class="mc-sub">${m.idle.running} running · ${m.idle.waiting} waiting</div>`)
      + `</button>`;
  }).join('');
  for (const btn of strip.querySelectorAll('.mc')) {
    btn.onclick = () => selectMachine(btn.dataset.host || null);
  }
}

async function selectMachine(host) {
  if ((host || null) === state.machine) return;
  state.machine = host || null;
  renderMachines();
  await loadHistory();
  await loadLiveSessions();
  renderCalendar();
  await selectDay(state.selected || todayKey());
}

// Discovery, on demand. Deliberately not run on page load: this tailnet has 14
// peers and 3 of them run termhub, so an automatic probe is a wall of timeouts
// paid on every visit to answer a question that changes about once a year.
async function findMachines(btn) {
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'scanning…';
  try {
    const r = await api('/api/peers/scan');
    if (!r.available) throw new Error('tailscale status is not available on this machine');
    const known = new Set(state.machines.map((m) => m.machine));
    const fresh = (r.found || []).filter((f) => !known.has(f.machine));
    if (!fresh.length) { toast('No other termhub machines found.'); return; }
    const existing = state.machines.filter((m) => m.host).map((m) => `https://${m.host}`);
    await fetch('/api/peers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peers: existing.concat(fresh.map((f) => f.url)) }),
    });
    toast(`Added ${fresh.map((f) => f.machine).join(', ')}.`);
    await loadMachines();
  } catch (e) {
    toast(String(e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

function shiftMonth(delta) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1);
  renderCalendar();
}

async function boot() {
  const now = new Date();
  state.month = new Date(now.getFullYear(), now.getMonth(), 1);
  $('#cal-prev').onclick = () => shiftMonth(-1);
  $('#cal-next').onclick = () => shiftMonth(1);
  $('#machine-scan').onclick = (e) => findMachines(e.currentTarget);

  // Peers are loaded alongside, never blocking: one unreachable machine must
  // not hold up the numbers for the one you are sitting at.
  loadMachines().catch(() => {});
  await Promise.all([loadHistory(), loadLiveSessions()]);
  renderCalendar();
  // Open on today even when it has no data yet — landing on "nothing ran" for
  // the day you are in is more honest than silently showing you an older one.
  await selectDay(state.selected || todayKey());

  // Today keeps moving while the page is open; anything older never changes.
  setInterval(async () => {
    if (state.selected !== todayKey()) return;
    loadMachines().catch(() => {});   // keep the strip's per-machine numbers live
    await loadHistory();
    await loadLiveSessions();
    renderCalendar();
    await selectDay(todayKey());
  }, 15000);
}

boot();
