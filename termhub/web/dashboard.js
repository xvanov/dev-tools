'use strict';

// The agent-time dashboard (/dashboard) — history for the tracker in
// lib/idleHub.js.
//
// Everything here is drawn from two endpoints and a lot of arithmetic:
//   GET /api/idle/history                    every recorded day, rolled up
//   GET /api/idle/history?day=&episodes=1    one day, plus its raw episodes
//
// The headline number is **agent time**: the sum, over every agent session, of
// the time it spent working. Two agents working at once accrue it twice as
// fast; agents sitting idle add nothing. Idle time is still measured and shown,
// but as the secondary number — the idle-share headline this page used to lead
// with judged the human, when the question worth a glance is how much work the
// agents actually did.
//
// Machines: one card per machine, plus an "all machines" card that sums them.
// Picking "all machines" re-points every panel at a merge of every reachable
// machine's data (see fleetApi) — the global view.

const $ = (sel) => document.querySelector(sel);

// Under this share of engaged time spent waiting, the idle tile stays calm and
// the ring stays green. 15% is roughly "one nine-minute gap an hour".
const TARGET_SHARE = 0.15;

const FLEET = '*';

const state = {
  days: [],        // [{day, working, waiting, limited, handoffs, peakParallel, sessions}]
  byDay: new Map(),
  month: null,     // Date pinned to the 1st of the displayed month
  selected: null,  // 'YYYY-MM-DD'
  detail: null,    // the selected day's rollup + episodes
  live: new Set(), // session ids still alive on the server right now
  restorable: new Set(),
  // Machines. `machine: null` means this one — the server we were served from;
  // FLEET means every machine merged. Switching re-fetches everything below
  // the strip.
  machine: null,   // hostname of the peer being viewed, null for local, FLEET for all
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
  if (state.machine === FLEET) return fleetApi(query);
  return sourceApi(state.machine, kind, query);
}

function sourceApi(host, kind, query = '') {
  if (!host) return api(kind === 'idle' ? '/api/idle' : `/api/idle/history${query}`);
  return api(`/api/peers/${encodeURIComponent(host)}/${kind}${query}`);
}

// ---- the fleet (all machines merged) ---------------------------------------

// Every machine that can answer right now: this one, plus each online peer
// with idle data. An offline machine's history lives on it and is missing
// from the sum until it wakes — the header says how many reported.
function fleetSources() {
  return state.machines.filter((m) => m.online && (m.local || m.idle));
}

// Merge the history list (one row per day) or one day's detail across
// machines. Agent time, idle time and handoffs add; sessions keep their
// machine so a row can still link to the box it ran on.
async function fleetApi(query) {
  const parts = await Promise.all(fleetSources().map((m) =>
    sourceApi(m.host, 'history', query).then((r) => ({ m, r })).catch(() => null)));
  const ok = parts.filter((x) => x && x.r);
  if (!query) {
    const byDay = new Map();
    for (const { r } of ok) {
      for (const d of r.days || []) {
        const acc = byDay.get(d.day)
          || { day: d.day, working: 0, waiting: 0, limited: 0, handoffs: 0, peakParallel: 0, sessions: 0 };
        acc.working += d.working || 0; acc.waiting += d.waiting || 0; acc.limited += d.limited || 0;
        acc.handoffs += d.handoffs || 0; acc.sessions += d.sessions || 0;
        // An upper bound at day level: each machine's peak could have coincided.
        // The selected day's detail recomputes it exactly from the episodes.
        acc.peakParallel += d.peakParallel || 0;
        byDay.set(d.day, acc);
      }
    }
    return {
      machine: 'all machines', reporting: ok.length,
      days: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    };
  }
  const day = new URLSearchParams(query).get('day');
  const out = {
    day, machine: 'all machines', reporting: ok.length,
    working: 0, waiting: 0, limited: 0, handoffs: 0, sessions: [], episodes: [],
  };
  for (const { m, r } of ok) {
    // Session ids are per supervisor, so they are namespaced by machine here;
    // `rawId` is what that machine itself calls the session.
    const tag = m.host || 'local';
    out.working += r.working || 0; out.waiting += r.waiting || 0; out.limited += r.limited || 0;
    out.handoffs += r.handoffs || 0;
    for (const sess of r.sessions || []) {
      out.sessions.push({
        ...sess, id: `${tag}:${sess.id}`, rawId: sess.id, host: m.host,
        title: `${m.machine} · ${sess.title || sess.id}`,
        cwd: sess.cwd ? `${m.machine}: ${sess.cwd}` : '',
      });
    }
    for (const ep of r.episodes || []) out.episodes.push({ ...ep, id: `${tag}:${ep.id}` });
  }
  out.sessions.sort((a, b) => b.working - a.working);
  out.episodes.sort((a, b) => a.start - b.start);
  out.peakParallel = sweep(out.episodes).peak;
  out.projects = byProject(out.sessions);
  return out;
}

// Over a day's episodes: the most agents ever working at once, and the
// wall-clock time during which at least one was. Agent time divided by that is
// the average parallelism while anything was running.
function sweep(episodes) {
  const edges = [];
  for (const ep of episodes || []) {
    if (ep.state !== 'working') continue;
    edges.push([ep.start, 1], [ep.end, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at a tie
  let cur = 0; let peak = 0; let busy = 0; let last = 0;
  for (const [t, delta] of edges) {
    if (cur > 0) busy += t - last;
    cur += delta;
    last = t;
    if (cur > peak) peak = cur;
  }
  return { peak, busy };
}

// Same grouping as lib/idleStore.js's byProject, for the merged fleet day.
function byProject(sessions) {
  const out = new Map();
  for (const sess of sessions) {
    const key = sess.cwd || '(unknown)';
    const p = out.get(key) || { cwd: key, working: 0, waiting: 0, limited: 0, handoffs: 0, sessions: 0 };
    p.working += sess.working || 0; p.waiting += sess.waiting || 0; p.limited += sess.limited || 0;
    p.handoffs += sess.handoffs || 0; p.sessions++;
    out.set(key, p);
  }
  return [...out.values()].sort((a, b) => b.working - a.working);
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

// The ring's centre is the day's agent time. Its fill is the share of engaged
// agent time spent working rather than waiting on you (1 − idle share), so a
// full green ring is a day the agents were never left hanging.
function renderScore() {
  const r = state.detail;
  const el = $('#score-ring');
  if (!r) return;
  const engaged = (r.working || 0) + (r.waiting || 0);
  const busyShare = 1 - share(r);
  $('#score-pct').textContent = hm(r.working);
  el.style.setProperty('--score-deg', `${engaged ? Math.min(360, busyShare * 360) : 0}deg`);
  el.style.setProperty('--score-color',
    busyShare >= 1 - TARGET_SHARE ? 'var(--ok)' : busyShare >= 0.7 ? 'var(--accent-2)' : 'var(--danger)');

  const d = new Date(dayStart(r.day));
  $('#score-day').textContent = d.toLocaleDateString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric' });

  const { busy: wall } = sweep(r.episodes);
  $('#score-verdict').textContent = !engaged
    ? 'No agent sessions ran.'
    : `agents worked ${hm(r.working)}`
      + (wall ? ` in ${hm(wall)} of wall-clock (avg ×${(r.working / wall).toFixed(1)})` : '')
      + ` · ${hm(r.waiting)} waiting on you (${Math.round(share(r) * 100)}% idle)`
      + (r.limited ? ` · ${hm(r.limited)} out of tokens` : '');

  $('#score-streak').textContent = allTimeText();
}

// The accumulation: every recorded day's agent time for whatever is selected
// (one machine, or the whole fleet). Today is taken from the live detail when
// it is loaded, since the history list only knows what has hit the log.
function allTimeText() {
  const today = todayKey();
  const liveToday = state.detail && state.detail.day === today ? state.detail.working || 0 : null;
  let total = 0; let days = 0; let since = null;
  const add = (day, w) => {
    total += w;
    if (w > 0) { days++; if (!since || day < since) since = day; }
  };
  for (const d of state.days) add(d.day, d.day === today && liveToday !== null ? liveToday : (d.working || 0));
  if (liveToday !== null && !state.byDay.has(today)) add(today, liveToday);
  if (!total) return '';
  const where = state.machine === FLEET ? 'across all machines' : 'on this machine';
  return `⚡ ${hm(total)} agent time all-time ${where} · ${days} day${days === 1 ? '' : 's'} since ${since}`;
}

// ---- tiles -----------------------------------------------------------------

function renderTiles() {
  const r = state.detail;
  const wrap = $('#tiles');
  if (!r) { wrap.innerHTML = ''; return; }
  // Idle per handoff is still the fairest idle number: when the agent handed
  // the work back, how long did it sit?
  const perHandoff = r.handoffs ? r.waiting / r.handoffs : 0;
  const { busy: wall } = sweep(r.episodes);
  const avg = wall ? r.working / wall : 0;
  const tiles = [
    { k: 'agent time', v: hm(r.working), cls: r.working ? 'good' : '' },
    { k: 'wall-clock with an agent working', v: hm(wall), cls: '' },
    { k: 'avg parallel', v: wall ? `×${avg.toFixed(1)}` : '—', cls: avg > 1.5 ? 'good' : '' },
    { k: 'peak parallel', v: `×${r.peakParallel || 0}`, cls: (r.peakParallel || 0) > 1 ? 'good' : '' },
    { k: 'sessions', v: String((r.sessions || []).length), cls: '' },
    { k: 'idle (waiting on you)', v: hm(r.waiting), cls: share(r) > TARGET_SHARE ? 'warn' : '' },
    { k: 'handoffs', v: String(r.handoffs || 0), cls: '' },
    { k: 'idle per handoff', v: r.handoffs ? mmss(perHandoff) : '—', cls: perHandoff > 5 * 60000 ? 'bad' : '' },
  ];
  if (r.limited) tiles.push({ k: 'out of tokens', v: hm(r.limited), cls: 'bad' });
  wrap.innerHTML = tiles
    .map((t) => `<div class="tile ${t.cls}"><div class="v">${escapeHtml(t.v)}</div><div class="k">${escapeHtml(t.k)}</div></div>`)
    .join('');
}

// ---- calendar --------------------------------------------------------------

// Five buckets of agent time. Deliberately coarse: the point of the grid is to
// see the busy weeks at a glance, not to rank two days ten minutes apart.
function heatClass(r) {
  const h = (r.working || 0) / 3600000;
  if (h <= 0) return '';
  if (h < 1) return 'a0';
  if (h < 3) return 'a1';
  if (h < 6) return 'a2';
  if (h < 10) return 'a3';
  return 'a4';
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
    const amt = r && r.working ? hm(r.working) : '';
    cells.push(
      `<div class="${classes.join(' ')}" data-day="${key}"`
      + (r ? ` title="${escapeHtml(`${hm(r.working)} agent time · ${hm(r.waiting)} idle · ${r.handoffs} handoffs`)}"` : '')
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
// is the view that answers "what was actually going on at 3pm" — a rollup can't.
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
    // In the fleet view a row carries the machine it ran on (`host`, null for
    // this one) and the id that machine knows it by (`rawId`).
    const rawId = s.rawId || s.id;
    const live = !s.host && state.live.has(rawId);
    const resumable = !!s.agentSessionId;
    // A session on another machine can't be opened or reopened from here: it
    // lives in THAT machine's sessiond, and reopening is its supervisor's job.
    // So the row links to that machine's own termhub instead of offering a
    // control that would quietly do nothing — or worse, spawn the session on
    // the wrong box.
    const peerHost = state.machine === FLEET ? s.host : state.machine;
    const peer = peerHost && state.machines.find((m) => m.host === peerHost);
    const go = peer
      ? `<a class="ds-go" href="${escapeHtml(peer.url || `https://${peerHost}`)}/#session=${encodeURIComponent(rawId)}"`
        + ` target="_blank" rel="noopener" title="Opens ${escapeHtml(peer.machine)}'s termhub">on ${escapeHtml(peer.machine)} ↗</a>`
      : live
      ? `<a class="ds-go" href="/#session=${encodeURIComponent(rawId)}">open</a>`
      : `<button class="ds-go" data-reopen="${escapeHtml(rawId)}" title="${resumable
          ? 'Reopen this conversation where it left off'
          : 'No conversation id was recorded — reopens in the same directory as a fresh session'}">`
        + `${resumable ? 'reopen' : 'reopen fresh'}</button>`;
    return `<div class="ds-row">`
      + `<div class="ds-main">`
        + `<div class="ds-title">${escapeHtml(s.title || s.id)}</div>`
        + `<div class="ds-cwd">${escapeHtml(s.cwd || '')}</div>`
      + `</div>`
      + `<div class="ds-num"><b>${escapeHtml(hm(s.working))}</b> agent</div>`
      + `<div class="ds-num">${escapeHtml(hm(s.waiting))} idle</div>`
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

// ---- where the agent time went ---------------------------------------------

function renderProjects() {
  const wrap = $('#projects');
  const projects = (state.detail && state.detail.projects) || [];
  if (!projects.length) { wrap.innerHTML = '<div class="list-note">Nothing to attribute yet.</div>'; return; }
  const most = Math.max(...projects.map((p) => p.working), 1);
  wrap.innerHTML = projects.map((p) => {
    const pct = Math.round((p.working / most) * 100);
    return `<div class="pj-row">`
      + `<div class="pj-cwd" title="${escapeHtml(p.cwd)}">${escapeHtml(p.cwd)}</div>`
      + `<div class="pj-bar"><span style="width:${pct}%"></span></div>`
      + `<div class="pj-num"><b>${escapeHtml(hm(p.working))}</b> agent · ${escapeHtml(hm(p.waiting))} idle</div>`
      + `</div>`;
  }).join('');
}

// ---- the trend -------------------------------------------------------------

// Last 14 recorded days as bars of agent time, oldest left, scaled to the
// busiest of them.
function renderTrend() {
  const el = $('#trend');
  const played = state.days.filter((d) => (d.working || 0) > 0).slice(-14);
  if (played.length < 2) { el.innerHTML = ''; return; }
  const most = Math.max(...played.map((d) => d.working), 1);
  el.innerHTML = played.map((d) => {
    const h = Math.max(6, Math.min(100, (d.working / most) * 100));
    const title = `${d.day}: ${hm(d.working)} agent time · ${hm(d.waiting)} idle`;
    return `<span class="trend-bar good" style="height:${h}%" title="${escapeHtml(title)}"`
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
  const label = state.machine === FLEET
    ? `all machines · ${h.reporting || 0} of ${state.machines.length} reporting`
    : state.machine
      ? (state.machines.find((m) => m.host === state.machine) || {}).machine || state.machine
      : h.machine || '';
  $('#dash-machine').textContent = state.unavailable ? `${label} — no data` : label;
  renderNote();
}

// Say why the page is empty, in the one case where empty is not an answer.
function renderNote() {
  const note = $('#dash-note');
  if (!state.unavailable) { note.classList.add('hidden'); return; }
  note.classList.remove('hidden');
  note.innerHTML = state.machine
    ? `<b>This machine isn't tracking agent time yet.</b> Its termhub is running a build from `
      + `before the tracker. Update it there (⟳ Update), then restart its supervisor.`
    : `<b>This machine isn't tracking agent time yet.</b> The web tier is up to date, but the `
      + `session supervisor still runs the old build — an update deliberately never restarts it, `
      + `because that ends every live terminal. From a <i>non-termhub</i> PowerShell window:`
      + `<code>cd C:\\repos\\dev-tools\\termhub<br>.\\windows\\restart-sessiond.ps1</code>`
      + `Terminals come back as <b>Restorable</b>, and a claude session resumes its conversation.`;
}

async function loadLiveSessions() {
  // Only meaningful for this machine: "open" and "reopen" act on THIS server's
  // sessions. Viewing a peer, every row is history — see renderDaySessions.
  state.live = new Set();
  state.restorable = new Set();
  if (state.machine && state.machine !== FLEET) return;
  try {
    const s = await api('/api/sessions');
    state.live = new Set((s.sessions || []).filter((x) => x.alive).map((x) => x.id));
    state.restorable = new Set((s.restorable || []).map((x) => x.id));
  } catch {
    // the dashboard is still readable without knowing what's live
  }
}

// ---- machines --------------------------------------------------------------

// One card per machine with its own numbers, plus — first — an "all machines"
// card that sums them: the global agent time. Picking it re-points the panels
// below at the merged fleet; picking a machine shows just that box.
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
  // written "— no data" into) made the card name itself "— no data".
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

// The global number: today's and all-time agent time summed over every machine
// that answered. A peer on a build from before the all-time figure contributes
// its today but not its history, and the tag counts who reported at all.
function fleetCard() {
  const live = state.machines.filter((m) => m.online && m.idle && m.idle.today);
  const sum = (f) => live.reduce((a, m) => a + (f(m.idle) || 0), 0);
  const sel = state.machine === FLEET;
  return `<button class="mc fleet${sel ? ' selected' : ''}" data-host="${FLEET}">`
    + `<div class="mc-name">all machines <span class="mc-tag">${live.length}/${state.machines.length}</span></div>`
    + `<div class="mc-num good">⚡ ${hm(sum((i) => i.today.working))} today</div>`
    + `<div class="mc-sub">${sum((i) => i.running)} working now · all-time ${hm(sum((i) => i.allTime && i.allTime.working))}</div>`
    + `</button>`;
}

function renderMachines() {
  const strip = $('#machine-strip');
  if (state.machines.length < 2) {
    // A single machine gets no strip at all — a chooser with one option is
    // furniture. The "+ find machines" button stays.
    strip.innerHTML = '';
    return;
  }
  strip.innerHTML = fleetCard() + state.machines.map((m) => {
    const sel = (m.host || null) === state.machine;
    const t = m.idle && m.idle.today;
    return `<button class="mc${sel ? ' selected' : ''}${m.online ? '' : ' offline'}" `
      + `data-host="${escapeHtml(m.host || '')}">`
      + `<div class="mc-name">${escapeHtml(m.machine)}${m.local ? ' <span class="mc-tag">here</span>' : ''}</div>`
      // Three states, and the middle one is worth spelling out: a machine can
      // be up, reachable and running termhub, and still have no data — because
      // it hasn't been updated to a build that measures any. "0m" would read as
      // "no agent ever ran there", which may be the opposite of true.
      + (!m.online
        ? `<div class="mc-num off">offline</div><div class="mc-sub">its history lives on it</div>`
        : !m.idle
          ? `<div class="mc-num off">no data</div><div class="mc-sub">${m.local
              ? 'restart sessiond to start tracking'
              : 'update termhub on that machine'}</div>`
          : `<div class="mc-num${t.working ? ' good' : ''}">⚡ ${hm(t.working)} today</div>`
            + `<div class="mc-sub">${m.idle.running} working · ${m.idle.waiting} waiting`
            + `${m.idle.allTime ? ` · all-time ${hm(m.idle.allTime.working)}` : ''}</div>`)
      + `</button>`;
  }).join('');
  for (const btn of strip.querySelectorAll('.mc')) {
    btn.onclick = () => selectMachine(btn.dataset.host || null);
  }
}

async function selectMachine(host) {
  if ((host || null) === state.machine) return;
  state.machine = host || null;
  try { history.replaceState(null, '', state.machine === FLEET ? '#all' : location.pathname); } catch { /* cosmetic */ }
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
    const existing = state.machines.filter((m) => m.host).map((m) => m.url || `https://${m.host}`);
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

  // `/dashboard#all` opens straight on the fleet. That has to wait for the
  // machine list (it is what the fleet is merged from); otherwise peers load
  // alongside, never blocking — one unreachable machine must not hold up the
  // numbers for the one you are sitting at.
  const machinesLoaded = loadMachines().catch(() => {});
  if (location.hash === '#all') {
    await machinesLoaded;
    state.machine = FLEET;
    renderMachines();
  }
  await Promise.all([loadHistory(), loadLiveSessions()]);
  renderCalendar();
  // Open on today even when it has no data yet — landing on "nothing ran" for
  // the day you are in is more honest than silently showing you an older one.
  await selectDay(state.selected || todayKey());

  // Today keeps moving while the page is open; anything older never changes.
  setInterval(async () => {
    if (state.selected !== todayKey()) return;
    await loadMachines().catch(() => {});   // keep the strip's per-machine numbers live
    await loadHistory();
    await loadLiveSessions();
    renderCalendar();
    await selectDay(todayKey());
  }, 15000);
}

boot();
