'use strict';

// What a Build agent and Jarvis say to each other (PLAN.md D30), in build_msg.
//
//   agent → Jarvis   note(run, text)        progress or an FYI; never waits
//                    ask(run, text)         needs a human: blocks (a poll of the
//                                           row) until answered or ~30 min, then
//                                           returns the answer; the run is
//                                           `waiting` meanwhile and a notice
//                                           names it ("needs you")
//                    done                   src/build/index.ts
//   Jarvis → agent   reply(run, text)       the answer to the open ask
//                    send(run, text)        typed into the live termhub session
//
// `pa run note|ask|done|reply|send` (src/cli/run.ts) and the chat's build_*
// tools are thin callers. Names and text here are the agent's own words: data.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;

const { logger } = require('../log.ts');
const log = logger('build');

const repo = () => require('../repo').buildRuns;
const LIVE = ['starting', 'running', 'waiting'];
const ASK_TIMEOUT_MS = 30 * 60_000;
const MAX = 4000;

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
 * The agent asks Jarvis. Resolves {answered, answer, id}: answered false after
 * the timeout (the agent decides for itself), or when the run was stopped.
 * `sleep` and `timeoutMs` are for tests.
 */
async function ask(
  runId: number | string,
  text: unknown,
  { timeoutMs = ASK_TIMEOUT_MS, pollMs = 2000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}
): Promise<{ answered: boolean; answer: string | null; id: number }> {
  const run = await liveRun(runId);
  const q = await repo().addMsg({ runId, dir: 'agent', kind: 'ask', body: clean(text) });
  await repo().update(runId, { state: 'waiting' });
  await announce(run, q).catch((err: Error) => log.warn('could not announce the ask', { run: runId, message: err.message }));
  const until = Date.now() + timeoutMs;
  try {
    for (;;) {
      const row: Row | null = await repo().msgById(q.id);
      if (row?.answered_at) return { answered: true, answer: String(row.answer ?? ''), id: q.id };
      const r: Row | null = await repo().byId(runId);
      if (!r || !LIVE.includes(String(r.state))) return { answered: false, answer: null, id: q.id };
      if (Date.now() >= until) return { answered: false, answer: null, id: q.id };
      await sleep(pollMs);
    }
  } finally {
    // Back to work, unless the run ended while it waited.
    const r: Row | null = await repo().byId(runId);
    if (r && r.state === 'waiting') await repo().update(runId, { state: 'running' });
  }
}

/** The "needs you" notice for an open ask (the feed and a toast; the board lists it too). */
async function announce(run: Row, q: Row): Promise<void> {
  await require('../notify/notify.ts').notify({
    kind: 'info', priority: 'urgent',
    title: `Build agent #${run.id} needs you`,
    body: `${String(run.task).slice(0, 100)}\n\n${String(q.body).slice(0, 500)}\n\nAnswer: pa run reply ${run.id} "…" (or ask Jarvis)`,
    url: require('../notify/notify.ts').dashboardUrl('') + 'factory',
    dedupeKey: `build-ask:${q.id}`,
  });
}

/** Jarvis answers the run's open ask (the oldest, or `askId`). */
async function reply(runId: number | string, text: unknown, askId: number | string | null = null): Promise<Row> {
  const body = clean(text);
  const open: Row[] = (await repo().openAsks()).filter((a: Row) => String(a.run_id) === String(runId));
  const target = askId != null ? open.find((a) => String(a.id) === String(askId)) : open[0];
  if (!target) throw new Error(askId != null ? `ask #${askId} is not open on run #${runId}` : `run #${runId} has no open question — use send to type at it`);
  if (!(await repo().answer(target.id, body))) throw new Error(`ask #${target.id} was just answered`);
  await repo().addMsg({ runId, dir: 'jarvis', kind: 'reply', body });
  return { ...target, answer: body };
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
    out.push({ id: a.id, run: run.id, task: run.task, question: a.body, asked_at: a.created_at });
  }
  return out;
}

module.exports = { note, ask, reply, send, needsYou, ASK_TIMEOUT_MS };
