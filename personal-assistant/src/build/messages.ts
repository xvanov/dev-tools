'use strict';

// What a Build agent and Jarvis say to each other (PLAN.md D30), in build_msg.
//
//   agent → Jarvis   note(run, text)        progress or an FYI; never waits
//                    ask(run, text | {questions})  needs a human: blocks (a poll of the
//                                           row) until answered or PA_BUILD_ASK_TIMEOUT_MIN
//                                           (default 4 h), then returns the answer; the run
//                                           is `waiting` meanwhile (off the wall-clock cap,
//                                           never idle) and a notice names it ("needs you").
//                                           A questionnaire is one ask: src/build/decisions.ts
//                    done                   src/build/index.ts
//   Jarvis → agent   reply(run, text)       the answer to the open ask
//                    send(run, text)        typed into the live termhub session
//
// `pa run note|ask|done|reply|send` (src/cli/run.ts) and the chat's build_*
// tools are thin callers. Names and text here are the agent's own words: data.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Json = import('../types.ts').Json;

const { logger } = require('../log.ts');
const log = logger('build');

const repo = () => require('../repo').buildRuns;
const LIVE = ['starting', 'running', 'waiting', 'idle'];
const DEFAULT_ASK_TIMEOUT_MIN = 240;
const TIMED_OUT = '(timed out: nobody answered, the agent went on without)';
const MAX = 4000;
type Question = { id: string; text: string; options: string[]; allowFree: boolean };
const D = () => require('./decisions.ts');

const clean = (text: unknown): string => {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('say something: the text is empty');
  return t.slice(0, MAX);
};

async function liveRun(runId: number | string): Promise<Row> {
  const r: Row | null = await repo().byId(runId);
  if (!r) throw Object.assign(new Error(`no run #${runId}`), { status: 404 });
  if (!LIVE.includes(String(r.state))) throw new Error(`run #${runId} is ${r.state}`);
  return r;
}

/** The agent's progress line. */
async function note(runId: number | string, text: unknown): Promise<Row> {
  await liveRun(runId);
  return repo().addMsg({ runId, dir: 'agent', kind: 'note', body: clean(text) });
}

/**
 * How long an ask blocks before the agent is told to decide for itself: PA_BUILD_ASK_TIMEOUT_MIN (default
 * four hours). The run is parked meanwhile — `waiting`, off the wall-clock cap, never idle — so a long
 * wait costs nothing but the agent's patience.
 */
function askTimeoutMs(): number {
  const min = Number(process.env.PA_BUILD_ASK_TIMEOUT_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_ASK_TIMEOUT_MIN) * 60_000;
}

/**
 * The agent asks Jarvis: plain text, or a questionnaire ({questions:[{id, text, options?, allowFree?}]},
 * see decisions.ts). Resolves {answered, answer, answers, id}: `answer` is what the agent prints (the plain
 * answer, or each question with its answer and one JSON line); answered false after the timeout (the agent
 * decides for itself; the ask is closed so it stops needing you), or when the run was stopped.
 * `sleep` and `timeoutMs` are for tests.
 */
async function ask(
  runId: number | string,
  what: unknown,
  { timeoutMs = askTimeoutMs(), pollMs = 2000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}
): Promise<{ answered: boolean; answer: string | null; answers: Record<string, string> | null; id: number }> {
  const run = await liveRun(runId);
  const questions: Question[] | null = typeof what === 'string' || what == null ? null : D().normalize(what);
  const q = await repo().addMsg({ runId, dir: 'agent', kind: 'ask', body: questions ? D().encode(questions) : clean(what) });
  // Waiting time is not the agent's: note when it began (an ask already open keeps its own start).
  await repo().update(runId, { state: 'waiting', ...(run.waiting_since ? {} : { waiting_since: new Date().toISOString() }) });
  await announce(run, q).catch((err: Error) => log.warn('could not announce the ask', { run: runId, message: err.message }));
  const until = Date.now() + timeoutMs;
  const got = (row: Row) => {
    const a = questions ? D().parseAnswer(row.answer) : null;
    return { answered: true, answer: questions && a ? D().readable(questions, a) : String(row.answer ?? ''), answers: a ? a.answers : null, id: q.id };
  };
  const none = { answered: false, answer: null, answers: null, id: q.id };
  try {
    for (;;) {
      const row: Row | null = await repo().msgById(q.id);
      if (row?.answered_at) return got(row);
      const r: Row | null = await repo().byId(runId);
      if (!r || !LIVE.includes(String(r.state))) return none;
      if (Date.now() >= until) {
        // Close it so it leaves Needs you; an answer that landed in this instant still wins.
        if (await repo().answer(q.id, TIMED_OUT)) return none;
        return got((await repo().msgById(q.id)) as Row);
      }
      await sleep(pollMs);
    }
  } finally {
    // Back to work, unless the run ended while it waited; either way the wait comes off the wall clock.
    const r: Row | null = await repo().byId(runId);
    if (r) {
      const since = Date.parse(String(r.waiting_since));
      const patch: Row = { waiting_since: null };
      if (Number.isFinite(since)) patch.waiting_ms = Number(r.waiting_ms || 0) + Math.max(0, Date.now() - since);
      if (r.state === 'waiting') patch.state = 'running';
      await repo().update(runId, patch);
    }
  }
}

/** The "needs you" notice for an open ask (the feed and a toast; the board lists it too). Normal priority: it spends the interrupt budget and respects quiet hours like any push. */
async function announce(run: Row, q: Row): Promise<void> {
  const qs: Question[] | null = D().decode(q.body);
  const what = qs ? `${qs.length} decision${qs.length === 1 ? '' : 's'}:\n${D().summary(qs)}` : String(q.body);
  await require('../notify/notify.ts').notify({
    kind: 'info', priority: 'normal',
    title: qs ? `Build agent #${run.id} needs ${qs.length} decision${qs.length === 1 ? '' : 's'}` : `Build agent #${run.id} needs you`,
    body: `${String(run.task).slice(0, 100)}\n\n${what.slice(0, 700)}\n\nAnswer on the Build board, or: pa run reply ${run.id} ${qs ? '--answer <id>=… ' : '"…"'}(or tell Jarvis)`,
    url: require('../notify/notify.ts').dashboardUrl('') + 'factory',
    dedupeKey: `build-ask:${q.id}`,
  });
}

/**
 * Jarvis answers the run's open ask (the oldest, or `askId`). A plain ask takes `text`; a questionnaire takes
 * `answers` ({id: answer}) and/or a free-text `text` (decisions.answerFrom), all in one reply.
 */
async function reply(runId: number | string, text: unknown, askId: number | string | null = null, answers: unknown = null): Promise<Row> {
  const open: Row[] = (await repo().openAsks()).filter((a: Row) => String(a.run_id) === String(runId));
  const target = askId != null ? open.find((a) => String(a.id) === String(askId)) : open[0];
  if (!target) throw new Error(askId != null ? `ask #${askId} is not open on run #${runId}` : `run #${runId} has no open question — use send to type at it`);
  const questions: Question[] | null = D().decode(target.body);
  let stored: string;
  let said: string;
  if (questions) {
    const a = D().answerFrom(questions, { answers, text });
    stored = JSON.stringify(a);
    said = questions.filter((q) => a.answers[q.id] != null).map((q) => `${q.id}: ${a.answers[q.id]}`).concat(a.text ? [a.text] : []).join('\n');
  } else {
    if (answers && Object.keys(answers as object).length) throw new Error(`ask #${target.id} is a plain question: answer it with text`);
    stored = said = clean(text);
  }
  if (!(await repo().answer(target.id, stored))) throw new Error(`ask #${target.id} was just answered`);
  await repo().addMsg({ runId, dir: 'jarvis', kind: 'reply', body: said.slice(0, MAX) });
  return { ...target, answer: stored };
}

/** Jarvis types a message into the live session (and presses return). */
async function send(runId: number | string, text: unknown): Promise<Row> {
  const body = clean(text);
  const r = await liveRun(runId);
  if (!r.session_id) throw new Error(`run #${runId} has no session yet`);
  await require('../dispatch/termhub.ts').say(r.session_id, body, { submit: true });
  return repo().addMsg({ runId, dir: 'jarvis', kind: 'send', body });
}

/** Every open ask with its run's task: what needs you. */
async function needsYou(): Promise<Row[]> {
  const asks: Row[] = await repo().openAsks();
  const out: Row[] = [];
  for (const a of asks) {
    const run: Row | null = await repo().byId(a.run_id);
    if (!run || !LIVE.includes(String(run.state))) continue;
    const questions: Question[] | null = D().decode(a.body);
    out.push({ id: a.id, run: run.id, task: run.task, kind: questions ? 'decisions' : 'ask', question: questions ? D().summary(questions) : a.body, questions, asked_at: a.created_at });
  }
  // An idle agent needs you as much as one with a question: look in, nudge it or stop it.
  for (const r of await repo().list({ live: true, limit: 50 })) {
    if (r.state !== 'idle') continue;
    let a: Json = {};
    try { a = JSON.parse(String(r.activity)) || {}; } catch { /* none */ }
    out.push({ id: null, run: r.id, task: r.task, kind: 'idle', question: `Idle ${Math.round(Number(a.idle_s || 0) / 60)} min. Last tool call: ${a.last_tool || 'none'}. Last output: ${a.last_line || '(blank)'}`, ...a, asked_at: a.since || r.updated_at });
  }
  return out;
}

module.exports = { note, ask, reply, send, needsYou, askTimeoutMs, TIMED_OUT };
