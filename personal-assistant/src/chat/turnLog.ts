'use strict';

// The turn log: one row in turn_log per thing said to Jarvis (repo aggregate
// `turns`), so a turn can be read back whole: the words, how the fast lane
// routed them (router, route, probabilities, the decision model's other
// signals), what the fast lane said itself, and the PA chat's answer with the
// tools it called. It is also where real eval cases come from (`pa turns
// --eval` writes them in src/eval/router-cases.json's shape).
//
// Two writers:
//   the fast lane (src/chat/fastLane.ts runTurn) opens a voice turn when it
//   decides and finishes it when it is done speaking; a hand-off carries the
//   row on to the PA chat.
//   the SDK chat (src/chat/sdkFeed.ts) opens a turn for a typed message or a
//   doorbell, or takes the voice turn it was handed, and adds the answer and
//   tools when its result arrives. The chat answers its queued messages in
//   order, so the oldest open turn is the one being answered.
//
// Never throws and never waits on the store from a caller's path: a failed
// write is a warning, and a voice turn is spoken whether or not its row is.
// PA_TURN_LOG=off writes nothing (the test runner sets it).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Json = import('../types.ts').Json;
/** A turn's row id once written; null when the log is off or the write failed. */
type TurnRef = Promise<number | null>;

const { config } = require('../config.ts');
const { logger } = require('../log.ts');

const log = logger('turn-log');
const MAX_TEXT = 20_000;
// An open turn older than this when the log is swept never got its answer
// (the process restarted, the chat died): closed as an error.
const STALE_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 6 * 60 * 60_000;

let lastSweep = 0;

function enabled(): boolean {
  return !!config.turnLog.enabled;
}

function repo() {
  return require('../repo');
}

const clip = (s: unknown, n: number = MAX_TEXT) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const flag = (b: unknown) => (b ? 1 : 0);
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

/** Opens a turn: its row id, later. `set` is any settable column (src/repo/turns.ts COLUMNS). */
function open({ channel, text, set = {} }: { channel: string; text: string; set?: Json }): TurnRef {
  if (!enabled() || !String(text || '').trim()) return Promise.resolve(null);
  sweepSoon();
  return repo()
    .turns.insert({ channel, text: clip(text), set })
    .then((r: Row) => Number(r.id))
    .catch((err: any) => {
      log.warn('could not write a turn', { message: err.message });
      return null;
    });
}

/** Sets columns of a turn once its row exists. Fire and forget. */
function patch(ref: TurnRef | null | undefined, set: Json): Promise<void> {
  if (!ref) return Promise.resolve();
  return Promise.resolve(ref)
    .then((id) => (id == null ? 0 : repo().turns.update(id, set)))
    .then(() => {})
    .catch((err: any) => log.warn('could not update a turn', { message: err.message }));
}

// ----------------------------------------------------------------- voice --

/** The fast lane decided: the decision event's fields as a new voice turn. */
function voiceDecided(text: string, ev: Json, { context = '', history = [] }: { context?: string; history?: Json[] } = {}): TurnRef {
  return open({
    channel: 'voice',
    text,
    set: {
      context: context ? clip(context, 8000) : null,
      history: Array.isArray(history) && history.length ? json(history.slice(-2).map((h: Json) => ({ type: h.type, text: clip(h.text, 600) }))) : null,
      router: ev.router || null,
      route: ev.route || null,
      p: json(ev.p),
      signals: json(ev.signals),
      reason: ev.reason ? clip(ev.reason, 500) : null,
      overridden: flag(ev.overridden),
      decision_ms: ev.ms ?? null,
    },
  });
}

/**
 * The fast lane is done: what it said and how long it took. A turn it handed
 * off stays open for the PA chat's answer (its status is the chat's to set);
 * one it answered, or failed to hand off, ends here.
 */
function voiceDone(ref: TurnRef | null, r: Json): Promise<void> {
  const handed = !!(r.handoff && !r.handoff.error);
  const set: Json = {
    fast_say: r.say ? clip(r.say) : null,
    fast_model: r.model || null,
    first_token_ms: r.firstTokenMs ?? null,
    fast_ms: r.ms ?? null,
    fell_back: flag(r.fellBack),
    handed_off: flag(handed),
  };
  if (r.handoff?.error) Object.assign(set, { handoff_error: clip(r.handoff.error, 500), status: 'error', error: 'the hand-off to the PA chat failed', ended_at: new Date().toISOString() });
  else if (!handed) Object.assign(set, { status: r.aborted ? 'error' : 'done', ...(r.aborted ? { error: 'stopped' } : {}), ended_at: new Date().toISOString() });
  return patch(ref, set);
}

// ------------------------------------------------------------- the chat --

type Pending = { ref: TurnRef; t0: number; reply: string[]; tools: string[] };

/**
 * One SDK chat's side of the log. sent() for every message it is given (a
 * voice hand-off passes its turn), text() for each piece of the final answer,
 * tool() for each tool call, result() when the chat finishes a turn, ended()
 * when the session dies with messages still unanswered.
 */
function chatTracker() {
  const queue: Pending[] = [];
  return {
    sent({ text, channel, turn = null }: { text: string; channel: string; turn?: TurnRef | null }) {
      if (!enabled()) return;
      const ref = turn || open({ channel, text });
      queue.push({ ref, t0: Date.now(), reply: [], tools: [] });
      // A session that never answers must not grow this without bound.
      if (queue.length > 50) queue.shift();
    },
    text(t: string) {
      if (queue[0] && t) queue[0].reply.push(String(t));
    },
    tool(name: string) {
      if (queue[0] && name) queue[0].tools.push(String(name));
    },
    result({ ok = true, error = null, turns = null, costUsd = null }: { ok?: boolean; error?: string | null; turns?: number | null; costUsd?: number | null } = {}) {
      const p = queue.shift();
      if (!p) return Promise.resolve();
      return patch(p.ref, {
        reply: p.reply.length ? clip(p.reply.join('\n\n')) : null,
        tools: p.tools.length ? JSON.stringify(p.tools) : null,
        reply_ms: Date.now() - p.t0,
        chat_turns: turns,
        chat_cost_usd: costUsd,
        status: ok ? 'done' : 'error',
        error: ok ? null : clip(error || 'the chat stopped', 500),
        ended_at: new Date().toISOString(),
      });
    },
    ended(reason: string) {
      const all = queue.splice(0);
      return Promise.all(all.map((p) => patch(p.ref, {
        ...(p.reply.length ? { reply: clip(p.reply.join('\n\n')) } : {}),
        ...(p.tools.length ? { tools: JSON.stringify(p.tools) } : {}),
        status: 'error',
        error: clip(reason, 500),
        ended_at: new Date().toISOString(),
      }))).then(() => {});
    },
    pending: () => queue.length,
  };
}

// ---------------------------------------------------------------- upkeep --

/** Deletes turns past PA_TURN_LOG_DAYS and closes stale open ones. At most every 6 hours. */
async function sweep(now: number = Date.now()): Promise<{ pruned: number; closed: number }> {
  lastSweep = now;
  const turns = repo().turns;
  const pruned = await turns.prune(new Date(now - config.turnLog.days * 86_400_000).toISOString());
  const stale: Row[] = await turns.openBefore(new Date(now - STALE_MS).toISOString());
  for (const r of stale) await turns.update(r.id, { status: 'error', error: 'no answer recorded (the chat restarted or died)', ended_at: new Date(now).toISOString() });
  return { pruned, closed: stale.length };
}

function sweepSoon() {
  if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = Date.now();
  setTimeout(() => sweep().catch((err: any) => log.warn('turn log sweep failed', { message: err.message })), 5_000).unref?.();
}

// ------------------------------------------------------------ reading --

/** A row as the API and the CLI show it: JSON columns parsed, flags as booleans. */
function view(r: Row): Json {
  const parse = (s: unknown) => {
    if (s == null || s === '') return null;
    try {
      return JSON.parse(String(s));
    } catch {
      return null;
    }
  };
  return {
    id: Number(r.id),
    at: r.at,
    channel: r.channel,
    text: r.text,
    context: r.context,
    history: parse(r.history),
    router: r.router,
    route: r.route,
    p: parse(r.p),
    signals: parse(r.signals),
    reason: r.reason,
    overridden: !!Number(r.overridden),
    fellBack: !!Number(r.fell_back),
    decisionMs: r.decision_ms == null ? null : Number(r.decision_ms),
    fastSay: r.fast_say,
    fastModel: r.fast_model,
    firstTokenMs: r.first_token_ms == null ? null : Number(r.first_token_ms),
    fastMs: r.fast_ms == null ? null : Number(r.fast_ms),
    handedOff: !!Number(r.handed_off),
    handoffError: r.handoff_error,
    reply: r.reply,
    tools: parse(r.tools) || [],
    replyMs: r.reply_ms == null ? null : Number(r.reply_ms),
    chatTurns: r.chat_turns == null ? null : Number(r.chat_turns),
    chatCostUsd: r.chat_cost_usd == null ? null : Number(r.chat_cost_usd),
    status: r.status,
    error: r.error,
    endedAt: r.ended_at,
  };
}

async function list(filter: Json = {}): Promise<Json[]> {
  return (await repo().turns.list(filter)).map(view);
}

/**
 * A voice turn as an eval case (src/eval/router-cases.json): the words and
 * the route the router took, which a person then confirms or corrects. A
 * turn the chat answered with a tool that changes things is labelled action;
 * one it answered with look-ups only, handoff. Typed turns have no route and
 * are not cases.
 */
function evalCase(t: Json): Json | null {
  if (t.channel !== 'voice' || !t.route) return null;
  const write = (t.tools || []).some((n: string) => /(_add|_edit|_done|_send|_apply|_create|_close|_delete|dispatch|run_start)/.test(n));
  const expect = t.route === 'answer' ? 'answer' : write || t.signals?.actsOutside ? 'action' : 'handoff';
  return {
    origin: 'logged',
    expect,
    text: t.text,
    ...(t.history?.length ? { history: t.history } : {}),
    note: `turn ${t.id}, ${t.at}: routed ${t.route}${t.p ? ` p=${JSON.stringify(t.p)}` : ''}${t.tools?.length ? `, chat tools ${t.tools.join(' ')}` : ''}; label not reviewed`,
  };
}

module.exports = { enabled, open, patch, voiceDecided, voiceDone, chatTracker, sweep, view, list, evalCase };
