'use strict';

// The idle event log — append-only JSONL, one file per local day, under
// <dataDir>/idle/YYYY-MM-DD.jsonl.
//
// One line per finished *episode*: a stretch during which one session held one
// state. `{start, end, state, reason, id, title, cwd, kind}`. That shape is
// chosen so the dashboard's questions are all answerable by reading files and
// doing arithmetic — no database, no index, no daemon:
//
//   how much idle time today?      sum ms of state=waiting
//   how many turns did I finish?   count of waiting episodes (one per handoff)
//   how parallel was I?            max overlapping working episodes (sweep)
//   what was I doing on the 3rd?   read that day's file
//
// A day file is a few hundred lines. Nothing is ever rewritten, so a corrupt
// or half-written line costs exactly that line — every reader skips what it
// can't parse rather than failing the day.
//
// Episodes are filed by the LOCAL day they START in. An episode that runs
// across midnight is therefore in yesterday's file while overlapping today, so
// readDay() also scans the previous day and clips (see `clip`). Filing by start
// keeps the writer a pure append — splitting at midnight would mean the writer
// owning a timezone-aware clock it has no other use for.

const fs = require('fs');
const path = require('path');
const { ensureDataDir } = require('./paths');

function idleDir() {
  const dir = path.join(ensureDataDir(), 'idle');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Local (not UTC) day key. The user's question is "what did I do on Tuesday",
// and Tuesday is a wall-clock fact where they are sitting.
function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayBounds(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  const start = new Date(y, (m || 1) - 1, d || 1).getTime();
  const end = new Date(y, (m || 1) - 1, (d || 1) + 1).getTime();
  return { start, end };
}

function prevDayKey(key) {
  const { start } = dayBounds(key);
  return dayKey(start - 1);
}

function dayFile(key) {
  return path.join(idleDir(), `${key}.jsonl`);
}

// Append one finished episode. Never throws: the tracker calls this from a
// 1 s tick inside the process that owns every terminal on the machine, and a
// full disk must not be able to take that down.
function append(episode) {
  if (!episode || !episode.start || !episode.end) return false;
  try {
    fs.appendFileSync(dayFile(dayKey(episode.start)), `${JSON.stringify(episode)}\n`);
    return true;
  } catch {
    return false;
  }
}

function readFileLines(key) {
  let raw;
  try { raw = fs.readFileSync(dayFile(key), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.start && e.end && e.state) out.push(e);
    } catch {
      // a torn final line from a killed process — skip it, keep the day
    }
  }
  return out;
}

// Clip an episode to [from, to), or null if it doesn't overlap at all.
function clip(ep, from, to) {
  const start = Math.max(ep.start, from);
  const end = Math.min(ep.end, to);
  if (end <= start) return null;
  return { ...ep, start, end, ms: end - start };
}

// Every episode overlapping one local day, clipped to it. Reads the previous
// day too, for the episode that started before midnight.
function readDay(key) {
  const { start, end } = dayBounds(key);
  const raw = [...readFileLines(prevDayKey(key)), ...readFileLines(key)];
  const out = [];
  for (const ep of raw) {
    const c = clip(ep, start, end);
    if (c) out.push(c);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Peak parallelism: the most sessions ever *working* at the same instant.
// A sweep over episode edges, not a sample — sampling would miss the burst
// that is exactly what this number is for.
function peakParallel(episodes) {
  const edges = [];
  for (const ep of episodes) {
    if (ep.state !== 'working') continue;
    edges.push([ep.start, 1], [ep.end, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at a tie
  let cur = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    cur += delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

// One day reduced to the numbers the header and the dashboard show.
//
// `handoffs` counts waiting episodes: every time an agent stopped and put the
// ball back in your court. It is the denominator of the whole game — idle
// minutes per handoff is "how fast do I turn work around", which is the thing
// being minimised, whereas raw idle minutes just punishes a long day.
function rollup(key, extra = []) {
  const episodes = [...readDay(key), ...extra];
  const totals = { working: 0, waiting: 0, limited: 0 };
  const sessions = new Map();
  let handoffs = 0;
  for (const ep of episodes) {
    const ms = ep.ms || (ep.end - ep.start);
    if (totals[ep.state] === undefined) totals[ep.state] = 0;
    totals[ep.state] += ms;
    // `cont` marks the second and later slices of one long episode (the tracker
    // checkpoints every 5 min so a crash can't lose the stretch). Counting
    // those would turn one forgotten terminal into a dozen fake handoffs — the
    // exact opposite of what the number is for.
    if (ep.state === 'waiting' && !ep.cont) handoffs++;
    if (!ep.id) continue;
    let s = sessions.get(ep.id);
    if (!s) {
      s = { id: ep.id, title: ep.title || ep.id, cwd: ep.cwd || '', kind: ep.kind || '',
        command: ep.command || null, agentSessionId: ep.agentSessionId || null,
        working: 0, waiting: 0, limited: 0, handoffs: 0, first: ep.start, last: ep.end };
      sessions.set(ep.id, s);
    }
    // Both are learned late for opencode (the id arrives on its event stream),
    // so the newest non-null wins rather than whatever the first episode had.
    if (ep.agentSessionId) s.agentSessionId = ep.agentSessionId;
    if (ep.command) s.command = ep.command;
    if (s[ep.state] === undefined) s[ep.state] = 0;
    s[ep.state] += ms;
    if (ep.state === 'waiting' && !ep.cont) s.handoffs++;
    if (ep.start < s.first) s.first = ep.start;
    if (ep.end > s.last) s.last = ep.end;
    if (ep.title) s.title = ep.title;   // a renamed session keeps its newest name
  }
  const list = [...sessions.values()].sort((a, b) => b.waiting - a.waiting);
  return {
    day: key,
    working: totals.working,
    waiting: totals.waiting,
    limited: totals.limited,
    handoffs,
    peakParallel: peakParallel(episodes),
    sessions: list,
    projects: byProject(list),
  };
}

// Where the idle time actually goes, grouped by working directory. Two sessions
// on the same repo are one project's problem, and "which repo am I slowest to
// answer?" is a question you can act on in a way that a per-session list isn't —
// it survives the sessions themselves.
function byProject(sessions) {
  const out = new Map();
  for (const s of sessions) {
    const key = s.cwd || '(unknown)';
    let p = out.get(key);
    if (!p) { p = { cwd: key, working: 0, waiting: 0, limited: 0, handoffs: 0, sessions: 0 }; out.set(key, p); }
    p.working += s.working; p.waiting += s.waiting; p.limited += s.limited;
    p.handoffs += s.handoffs; p.sessions++;
  }
  return [...out.values()].sort((a, b) => b.waiting - a.waiting);
}

// Find a session's last-known metadata anywhere in the log, newest day first.
// This is what makes a date on the calendar actionable: sessions.json forgets an
// entry as soon as it's killed, so weeks later the episode log is the only place
// that still knows the cwd, the command and the agent's conversation id.
//
// Bounded to `maxDays` files rather than the whole directory — the answer is
// almost always in the day you clicked, and an unbounded scan would grow
// without limit as the log accumulates.
function findSession(id, maxDays = 120) {
  if (!id) return null;
  const all = days().reverse().slice(0, maxDays);
  for (const day of all) {
    let found = null;
    for (const ep of readFileLines(day)) {
      if (ep.id !== id) continue;
      // Keep scanning the day: later episodes carry the better metadata (a
      // renamed title, an opencode id that only arrived mid-session).
      found = {
        id, title: ep.title || id, cwd: ep.cwd || '', kind: ep.kind || '',
        command: ep.command || found?.command || null,
        agentSessionId: ep.agentSessionId || found?.agentSessionId || null,
        last: ep.end,
      };
    }
    if (found) return found;
  }
  return null;
}

// Which days have any record at all — the calendar's month grid is drawn from
// this rather than from a date range, so an empty day is empty because nothing
// ran, not because a file was missing.
function days() {
  try {
    return fs.readdirSync(idleDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, -6))
      .sort();
  } catch {
    return [];
  }
}

module.exports = {
  append, readDay, rollup, days, dayKey, dayBounds, peakParallel, byProject, findSession, idleDir,
};
