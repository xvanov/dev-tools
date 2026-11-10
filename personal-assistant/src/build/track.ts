'use strict';

// What a Build run did and what it cost, read from Claude Code's own
// transcripts (PLAN.md D30). A session is
//
//   ~/.claude/projects/<cwd, non-alphanumerics as ->/<session>.jsonl
//   ~/.claude/projects/<cwd…>/<session>/subagents/agent-<id>.jsonl (+ .meta.json)
//
// one JSON object per line. An assistant line carries `message.id`, `model`,
// `usage` (the same message is written once per content block: keep the last
// per id) and tool_use blocks; the matching user line carries the tool_result
// (`is_error`). Per agent (the main one, each subagent) this reads tokens, a
// notional subscription cost at API list prices, tool calls (name, short args,
// ok/err, time) and a state; `tick` stores the summary on the run row (`track`
// JSON, replaced whole), enforces the cost and wall-clock caps, and on the end
// of a run copies the raw logs to <data>/build-logs/run-<id>/ for later analysis.
//
// Pure parts: parseAgent, priceOf, costOf, summarize. The rest reads files.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Row = import('../repo/types.ts').Row;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../config.ts');
const { logger } = require('../log.ts');

const log = logger('build');
const repo = () => require('../repo').buildRuns;
const MAX_CALLS = 300;

/** USD per million tokens at API list prices (input, output); cache write is 1.25x (5 min) or 2x (1 h) input, cache read 0.1x. */
const PRICES: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /haiku/i, in: 1, out: 5 },
  { match: /opus/i, in: 5, out: 25 },
  { match: /sonnet/i, in: 3, out: 15 },
];

/** Pure: the price row for a model id, falling back to the run's alias, then sonnet. */
function priceOf(model: string | null | undefined, fallback?: string | null): { in: number; out: number } {
  for (const name of [model, fallback]) {
    const p = PRICES.find((x) => name && x.match.test(name));
    if (p) return p;
  }
  return PRICES[2] as { in: number; out: number };
}

type Usage = { in: number; out: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

/** Pure: notional dollars for one message's usage. */
function costOf(u: Usage, model: string | null | undefined, fallback?: string | null): number {
  const p = priceOf(model, fallback);
  return (u.in * p.in + u.out * p.out + u.cacheRead * p.in * 0.1 + u.cacheWrite5m * p.in * 1.25 + u.cacheWrite1h * p.in * 2) / 1e6;
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Pure: a tool call's input as a short string. */
function shortArgs(name: string, input: Json | null | undefined): string {
  const i = input || {};
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.subagent_type ?? '';
  const s = String(typeof pick === 'string' ? pick : JSON.stringify(pick)).replace(/\s+/g, ' ').trim();
  return s.length > 100 ? `${s.slice(0, 99)}…` : s;
}

/**
 * Pure: one transcript's text as an agent summary:
 * {tokens, cost_usd, model, turns, started_at, last_at, calls: [{id, name, args, at, ok, ms}]}.
 * A line that is not JSON (a half-written last line) is skipped.
 */
function parseAgent(text: string, fallbackModel?: string | null): Json {
  const msgs = new Map<string, { model: string | null; usage: Usage }>();
  const calls: Json[] = [];
  const byId = new Map<string, Json>();
  let started: string | null = null;
  let last: string | null = null;
  let model: string | null = null;
  let turns = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o: Json;
    try { o = JSON.parse(line); } catch { continue; }
    const at: string | null = o.timestamp || null;
    if (at) { started = started || at; last = at; }
    const m = o.message;
    if (!m || typeof m !== 'object') continue;
    if (o.type === 'assistant') {
      if (m.model && m.model !== '<synthetic>') model = m.model;
      if (m.usage && m.id) {
        const u = m.usage;
        const cc = u.cache_creation || {};
        const w5 = n(cc.ephemeral_5m_input_tokens);
        const w1 = n(cc.ephemeral_1h_input_tokens);
        msgs.set(m.id, {
          model: m.model || null,
          usage: { in: n(u.input_tokens), out: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite5m: w5 + w1 ? w5 : n(u.cache_creation_input_tokens), cacheWrite1h: w1 },
        });
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === 'tool_use' && c.id && !byId.has(c.id)) {
            const call = { id: c.id, name: String(c.name), args: shortArgs(String(c.name), c.input), at, ok: null as boolean | null, ms: null as number | null };
            byId.set(c.id, call);
            calls.push(call);
          }
        }
      }
    } else if (o.type === 'user' && Array.isArray(m.content)) {
      turns++;
      for (const c of m.content) {
        const call = c && c.type === 'tool_result' ? byId.get(c.tool_use_id) : null;
        if (!call) continue;
        call.ok = !c.is_error;
        if (at && call.at) call.ms = Math.max(0, Date.parse(at) - Date.parse(call.at));
      }
    }
  }
  const total: Usage = { in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  let cost = 0;
  for (const { model: mm, usage } of msgs.values()) {
    total.in += usage.in; total.out += usage.out; total.cacheRead += usage.cacheRead;
    total.cacheWrite5m += usage.cacheWrite5m; total.cacheWrite1h += usage.cacheWrite1h;
    cost += costOf(usage, mm || model, fallbackModel);
  }
  return {
    model, turns, started_at: started, last_at: last, cost_usd: cost, messages: msgs.size,
    tokens: { in: total.in, out: total.out, cache_read: total.cacheRead, cache_write: total.cacheWrite5m + total.cacheWrite1h },
    calls,
  };
}

/**
 * Pure: the run's view from its agents' parses: totals, and per agent
 * {id, kind, type, description, model, state, tokens, cost_usd, started_at,
 * ended_at, calls (the last MAX_CALLS), call_count}.
 */
function summarize(agents: Array<{ id: string; kind: 'main' | 'subagent'; type?: string | null; description?: string | null; finished?: boolean; parent_call?: string | null; parsed: Json }>, { runLive, endedAt }: { runLive: boolean; endedAt?: string | null }): Json {
  const out = agents.map((a) => {
    const p = a.parsed;
    const done = a.kind === 'main' ? !runLive : Boolean(a.finished) || !runLive;
    return {
      id: a.id, kind: a.kind, type: a.type || null, description: a.description || null, parent_call: a.parent_call || null,
      model: p.model, state: done ? 'done' : 'running', turns: p.turns, tokens: p.tokens, cost_usd: p.cost_usd,
      started_at: p.started_at, ended_at: done ? p.last_at || endedAt || null : null,
      call_count: p.calls.length, errors: p.calls.filter((c: Json) => c.ok === false).length, calls: p.calls.slice(-MAX_CALLS),
    };
  });
  const sum = (f: (a: Json) => number) => out.reduce((t, a) => t + f(a), 0);
  return {
    agents: out,
    totals: {
      cost_usd: sum((a) => a.cost_usd), in: sum((a) => a.tokens.in), out: sum((a) => a.tokens.out),
      cache_read: sum((a) => a.tokens.cache_read), cache_write: sum((a) => a.tokens.cache_write), calls: sum((a) => a.call_count),
    },
  };
}

/** The transcript file of a run: the stored path, else a search of every project folder for the session id. */
function findTranscript(run: Row): string | null {
  const stored = run.transcript_path ? String(run.transcript_path) : null;
  if (stored && fs.existsSync(stored)) return stored;
  const root = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${run.claude_session}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* no projects folder yet */ }
  return null;
}

const readText = (f: string): string => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f: string): Json => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

const cache = new Map<string, { sig: string; parsed: Json }>();

/** A file's parse, redone only when its size or mtime changed. */
function parseFile(file: string, fallback: string | null): Json {
  let sig = '';
  try { const st = fs.statSync(file); sig = `${st.size}:${st.mtimeMs}`; } catch { return parseAgent('', fallback); }
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return hit.parsed;
  const parsed = parseAgent(readText(file), fallback);
  cache.set(file, { sig, parsed });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return parsed;
}

/** Reads a run's transcripts (the main one and every subagent's) into the summary, or null before there are any. */
function readRun(run: Row): Json | null {
  const main = findTranscript(run);
  if (!main) return null;
  const fallback = String(run.model || '');
  const agents: Parameters<typeof summarize>[0] = [{ id: 'main', kind: 'main', type: 'main', parsed: parseFile(main, fallback) }];
  const subDir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
  let files: string[] = [];
  try { files = fs.readdirSync(subDir).filter((f: string) => f.endsWith('.jsonl')).sort(); } catch { /* none */ }
  for (const f of files) {
    const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const meta = readJson(path.join(subDir, `${f.replace(/\.jsonl$/, '')}.meta.json`));
    agents.push({
      id, kind: 'subagent', type: meta.agentType || null, description: meta.description || null, finished: meta.finished === true,
      parent_call: meta.toolUseId || null, parsed: parseFile(path.join(subDir, f), fallback),
    });
  }
  const live = ['starting', 'running', 'waiting'].includes(String(run.state));
  return { ...summarize(agents, { runLive: live, endedAt: run.ended_at ? String(run.ended_at) : null }), transcript: main };
}

/** Copies the raw transcripts of an ended run to <data>/build-logs/run-<id>/. */
function archive(run: Row): string | null {
  const main = findTranscript(run);
  if (!main) return null;
  const dest = path.join(config.dataDir, 'build-logs', `run-${run.id}`);
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(main, path.join(dest, path.basename(main)));
    const sub = path.join(path.dirname(main), path.basename(main, '.jsonl'));
    if (fs.existsSync(sub)) fs.cpSync(sub, path.join(dest, path.basename(sub)), { recursive: true });
    return dest;
  } catch (err) {
    log.warn('could not archive the transcripts', { run: run.id, message: (err as Error).message });
    return null;
  }
}

/** Pure: why a live run must stop now (cost or wall-clock cap), or null. */
function overCap(run: Row, totals: Json | null, now = Date.now()): string | null {
  const cost = n(totals?.cost_usd);
  const cap = n(run.cost_cap_usd);
  if (cap > 0 && cost >= cap) return `cost cap reached: $${cost.toFixed(2)} of $${cap.toFixed(2)}`;
  const minutes = (now - Date.parse(String(run.started_at))) / 60_000;
  const wall = n(run.wall_cap_min);
  if (wall > 0 && minutes >= wall) return `time cap reached: ${Math.round(minutes)} of ${wall} min`;
  return null;
}

/**
 * One pass over the recent runs: live ones get their numbers refreshed and
 * their caps enforced; one that just ended gets a last read and its logs kept.
 */
async function tick(now = Date.now()): Promise<{ updated: number; stopped: number }> {
  const B = require('./index.ts');
  const runs: Row[] = await repo().list({ limit: 25 });
  let updated = 0;
  let stopped = 0;
  for (const run of runs) {
    const live = B.LIVE.includes(String(run.state));
    let prev: Json | null = null;
    try { prev = run.track ? JSON.parse(String(run.track)) : null; } catch { prev = null; }
    if (!live && prev?.final) continue;
    if (!live && !run.claude_session) continue;
    const view = readRun(run);
    if (!view) {
      if (live) {
        const why = overCap(run, null, now);
        if (why) { await B.stop(run.id, why); stopped++; }
      }
      continue;
    }
    const t = view.totals;
    const track = { ...view, final: !live };
    await repo().update(run.id, {
      cost_usd: t.cost_usd, tokens_in: t.in, tokens_out: t.out, tokens_cache_read: t.cache_read, tokens_cache_write: t.cache_write, track: JSON.stringify(track),
    });
    updated++;
    if (!live) { archive(run); continue; }
    const why = overCap(run, t, now);
    if (why) {
      log.warn('stopping a run over its cap', { run: run.id, why });
      await B.stop(run.id, why);
      stopped++;
    }
  }
  return { updated, stopped };
}

module.exports = { parseAgent, priceOf, costOf, summarize, shortArgs, findTranscript, readRun, archive, overCap, tick, PRICES };
