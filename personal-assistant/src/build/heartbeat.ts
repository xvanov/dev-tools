'use strict';

// Build run heartbeat (PLAN.md D30): every ~10 s, for each active run, sample
// cheap signs of life: the transcript's and subagents' size and mtime (stat
// only, nothing parsed), the termhub session (one sessiond list call per pass:
// alive, busy = the PTY wrote in the last 1.5 s) and the run's newest build_msg.
// The newest of them is `last_activity_at`; `activity` says active or idle.
//
//   dead session, no `pa run done`   failed at once
//   open `pa run ask` (waiting)      never idle: the agent is waiting on you
//   silent past the run's idle_after_s   state idle, an urgent notice, and in
//                                    `activity` what Jarvis decides from: the
//                                    last tool call, the last output line, how long
//   life returns                     back to running
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Row = import('../repo/types.ts').Row;

const fs = require('fs');
const path = require('path');
const { logger } = require('../log.ts');

const log = logger('build');
const repo = () => require('../repo').buildRuns;
const termhub = require('../dispatch/termhub.ts');

/** Stat only: newest mtime (ms) of a run's transcript and its subagents', or 0. */
function transcriptMtime(run: Row): number {
  const main = require('./track.ts').findTranscript(run);
  if (!main) return 0;
  let t = 0;
  const stat = (f: string) => { try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch { /* gone */ } };
  stat(main);
  const subDir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
  try { for (const f of fs.readdirSync(subDir)) stat(path.join(subDir, f)); } catch { /* none */ }
  return t;
}

/** Pure: seconds idle and whether that is past the limit, from the newest sign of life. */
function idleness(lastMs: number, now: number, limitS: number): { idle_s: number; over: boolean } {
  const idle_s = Math.max(0, Math.floor((now - lastMs) / 1000));
  return { idle_s, over: idle_s >= limitS };
}

/** The last tool call of the run's newest agent, from the track the 15 s tick stores. */
function lastTool(run: Row): string | null {
  try {
    const t = JSON.parse(String(run.track));
    const calls = ((t.agents || []) as Json[]).flatMap((a) => a.calls || []).sort((a: Json, b: Json) => String(a.at).localeCompare(String(b.at)));
    const c = calls[calls.length - 1];
    return c ? `${c.name}${c.args ? ` ${c.args}` : ''}${c.ok === false ? ' (failed)' : ''}`.slice(0, 200) : null;
  } catch { return null; }
}

async function lastLine(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const text = String(await termhub.screen(sessionId, { tailChars: 2000, timeoutMs: 3000 }));
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return (lines[lines.length - 1] || '').slice(0, 200) || null;
  } catch { return null; }
}

/** One pass. Cheap when nothing is live: no termhub call. */
async function tick(now = Date.now()): Promise<{ sampled: number; idle: number; failed: number }> {
  const B = require('./index.ts');
  const live: Row[] = await repo().list({ live: true, limit: 50 });
  if (!live.length) return { sampled: 0, idle: 0, failed: 0 };
  let sessions: Json[] | null = null;
  try { sessions = await termhub.listSessions(); } catch { /* termhub away: stat signals only */ }
  const bySession = new Map((sessions || []).map((s) => [String(s.id), s]));
  const msgs: Row[] = await repo().msgsFor(live.map((r) => r.id));
  const newestMsg = new Map<string, number>();
  for (const m of msgs) newestMsg.set(String(m.run_id), Math.max(newestMsg.get(String(m.run_id)) || 0, Date.parse(String(m.created_at)) || 0));

  const failed = sessions ? (await B.reconcile(sessions)).failed : 0;
  let idle = 0;
  let sampled = 0;
  for (const run of live) {
    if (run.state === 'starting') continue;
    const sess = run.session_id ? bySession.get(String(run.session_id)) : null;
    if (sessions && run.session_id && !sess) continue; // reconcile just failed it
    sampled++;
    const stored = Date.parse(String(run.last_activity_at)) || Date.parse(String(run.started_at)) || now;
    const last = Math.max(stored, transcriptMtime(run), newestMsg.get(String(run.id)) || 0, sess?.busy ? now : 0);
    const { idle_s, over } = idleness(last, now, Number(run.idle_after_s) || 240);
    const patch: Row = {};
    if (last !== Date.parse(String(run.last_activity_at))) patch.last_activity_at = new Date(last).toISOString();
    if (run.state === 'waiting') {
      patch.activity = JSON.stringify({ state: 'waiting' });
    } else if (over && run.state === 'running') {
      await repo().update(run.id, patch);
      await B.markIdle(run.id, { since: new Date(last).toISOString(), idle_s, last_tool: lastTool(run), last_line: await lastLine(run.session_id) });
      idle++;
      continue;
    } else if (!over) {
      if (run.state === 'idle') await B.unidle(run.id);
      patch.activity = JSON.stringify({ state: 'active' });
    }
    const changed = Object.keys(patch).some((k) => String(patch[k]) !== String(run[k]));
    if (changed) await repo().update(run.id, patch).catch((e: Error) => log.warn('heartbeat write failed', { run: run.id, message: e.message }));
  }
  return { sampled, idle, failed };
}

module.exports = { tick, idleness, transcriptMtime, lastTool };
