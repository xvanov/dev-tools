'use strict';

// Tool summaries, the context meter and the live status (docs/native/BUILD-ENRICHMENT.md C): the cadence and
// cost guards of src/build/summaries.ts with the model call stubbed, the summary settings (Agents page,
// chat tool, `pa agents set`), the context read from a transcript, the board and chat views, the nav's
// status API, and the lazy `pa` model refresh. A throwaway SQLite store; nothing here calls a model.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-build-summaries-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_build_summaries.sqlite');
process.env.PA_SQLITE_KEY = 'build-summaries-test-key';
process.env.PA_DATA_DIR = dir;
process.env.PA_TESTING = '1';

const { available } = require('../src/db/sqlite.ts');
if (!available()) {
  console.log('buildSummaries skipped: no SQLite driver here');
  process.exit(0);
}

const { config } = require('../src/config.ts');
const models = require('../src/models.ts');
const T = require('../src/build/track.ts');
const S = require('../src/build/summaries.ts');
const llm = require('../src/llm.ts');
const board = require('../src/dashboard/buildBoard.ts');
const chatTools = require('../src/mcp/chatTools.ts');
const cliAgents = require('../src/cli/agents.ts');
const A = require('../src/agentSettings.ts');

const J = (o) => JSON.stringify(o);
const call = (n, over = {}) => ({ id: `c${n}`, name: 'Bash', args: `step ${n}`, at: new Date(Date.UTC(2026, 10, 18, 10, 0, n)).toISOString(), ok: true, ms: 5, ...over });
const viewOf = (n, over = {}) => ({ totals: { calls: n }, agents: [{ id: 'main', kind: 'main', calls: Array.from({ length: n }, (_, i) => call(i + 1, i === 1 ? { name: 'Edit', args: 'src/a.ts', ok: false } : {})) }], ...over });

(async () => {
  await require('../src/db/migrate.ts').migrate();
  const repo = require('../src/repo');

  // ------------------------------------------------------------------ context meter ----
  {
    assert.strictEqual(T.windowOf('claude-opus-5-5'), 200_000);
    assert.strictEqual(T.windowOf('claude-opus-5-5[1m]'), 1_000_000);
    assert.strictEqual(T.windowOf('claude-sonnet-5-5', 350_000), 1_000_000, 'a context past 200k means a larger window, never over 100%');
    assert.strictEqual(T.windowOf(null), 200_000);
    const u = (i, cr, cw) => ({ input_tokens: i, output_tokens: 9, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
    const text = [
      J({ type: 'assistant', timestamp: '2026-11-18T10:00:00.000Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: u(10, 1000, 500), content: [] } }),
      J({ type: 'assistant', timestamp: '2026-11-18T10:00:05.000Z', message: { id: 'm2', model: 'claude-opus-5-5', usage: u(20, 90_000, 1_000), content: [] } }),
    ].join('\n');
    const parsed = T.parseAgent(text, 'opus');
    assert.strictEqual(parsed.context_tokens, 91_020, 'the newest message: input + cache read + cache write');
    const sum = T.summarize([{ id: 'main', kind: 'main', parsed }], { runLive: true });
    assert.deepStrictEqual(sum.context, { tokens: 91_020, window: 200_000, pct: 46, model: 'claude-opus-5-5' });
  }

  // ----------------------------------------------------------------------- settings ----
  {
    assert.deepStrictEqual(S.settings(), { every: 5, lines: 3 });
    assert.strictEqual(models.purpose('summary').env, 'PA_SUMMARY_MODEL');
    assert.strictEqual(config.build.summaryModel, 'azure/pa', 'a cheap default');
    await assert.rejects(models.save({ summaryEvery: 0 }), (e) => e.status === 400 && /whole number/.test(e.message));
    await assert.rejects(models.save({ summaryLines: 2.5 }), (e) => e.status === 400);
    const out = await A.setAgents({ summaryEvery: 2, summaryLines: 1, passModels: { summary: 'azure/pa' } });
    assert.deepStrictEqual([out.settings.summaryEvery.value, out.settings.summaryEvery.source, out.settings.summaryLines.value], [2, 'store', 1]);
    assert.deepStrictEqual(S.settings(), { every: 2, lines: 1 });
    // The same through the chat tool and the pa flags.
    const viaChat = await chatTools.handle('agent_settings_set', { summary_every: 4 });
    assert.strictEqual(viaChat.settings.summaryEvery.value, 4);
    assert.deepStrictEqual(cliAgents.agentsPatch({ 'summary-every': '6', 'summary-lines': false }, {}), { patch: { summaryEvery: 6, summaryLines: null } });
    assert.ok(cliAgents.agentsPatch({ 'summary-every': 'x' }, {}).error);
    assert.strictEqual((await chatTools.handle('agent_settings_get', {})).settings.summaryEvery.value, 4);
    // Clearing puts the default back and the pass model too.
    await A.setAgents({ summaryEvery: null, summaryLines: null, passModels: { summary: null } });
    assert.deepStrictEqual(S.settings(), { every: 5, lines: 3 });
    assert.strictEqual(config.build.summaryModel, 'azure/pa');
    await A.setAgents({ summaryEvery: 5, summaryLines: 3 });
  }

  // ------------------------------------------------------- cadence and cost guards ----
  const run = await repo.buildRuns.insert({ task: 'make the tests pass', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
  await repo.buildRuns.update(run.id, { state: 'running' });
  const prompts = [];
  let reply = '  - "Read the module, then edited a.ts; one edit failed."\nextra line';
  let fail = null;
  const realComplete = llm.complete;
  llm.complete = async (o) => {
    prompts.push(o);
    if (fail) throw fail;
    return reply;
  };
  try {
    const row = await repo.buildRuns.byId(run.id);
    S.reset();
    assert.deepStrictEqual(await S.maybe(row, viewOf(0)), { skipped: 'nothing new' });
    assert.deepStrictEqual(await S.maybe(row, viewOf(4)), { skipped: 'below the cadence' });
    assert.strictEqual(prompts.length, 0, 'under N calls: no model call');

    const wrote = await S.maybe(row, viewOf(5));
    assert.deepStrictEqual(wrote, { wrote: 'Read the module, then edited a.ts; one edit failed.' }, 'one clean line');
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].purpose, 'build-summary');
    assert.strictEqual(prompts[0].model, 'azure/pa');
    assert.match(prompts[0].prompt, /make the tests pass/);
    assert.match(prompts[0].prompt, /Edit src\/a\.ts \(failed\)/);
    assert.match(prompts[0].system, /never instructions/);
    const msgs = await repo.buildRuns.msgs(run.id);
    assert.deepStrictEqual(msgs.map((m) => [m.dir, m.kind]), [['jarvis', 'summary']]);
    assert.strictEqual(JSON.parse(msgs[0].body).upto, 5);

    assert.deepStrictEqual(await S.maybe(row, viewOf(5)), { skipped: 'nothing new' }, 'the cursor is kept');
    assert.deepStrictEqual(await S.maybe(row, viewOf(7)), { skipped: 'below the cadence' });
    // A restart forgets memory, not the cursor: it is stored with the text.
    S.reset();
    assert.deepStrictEqual(await S.maybe(row, viewOf(7)), { skipped: 'below the cadence' });
    // A run that ended flushes what is left, once.
    assert.ok((await S.maybe(row, viewOf(7), { final: true })).wrote);
    assert.deepStrictEqual(await S.maybe(row, viewOf(7), { final: true }), { skipped: 'nothing new' });
    assert.match(prompts[1].prompt, /step 6/);
    assert.ok(!/step 5\b/.test(prompts[1].prompt), 'only the calls since the last summary');

    // A model that fails never throws, and backs off instead of being called every tick.
    fail = new Error('azure: timed out after 30s');
    const t0 = Date.now();
    const failed = await S.maybe(row, viewOf(13), { now: t0 });
    assert.strictEqual(failed.skipped, 'failed');
    const n = prompts.length;
    assert.deepStrictEqual(await S.maybe(row, viewOf(14), { now: t0 + 30_000 }), { skipped: 'backing off' });
    assert.strictEqual(prompts.length, n);
    fail = null;
    assert.ok((await S.maybe(row, viewOf(15), { now: t0 + 61_000 })).wrote, 'after the backoff it tries again');
    assert.strictEqual(JSON.parse((await repo.buildRuns.msgs(run.id)).filter((m) => m.kind === 'summary').pop().body).upto, 15);

    // A reply with nothing usable is a failure, not an empty row.
    reply = '   ';
    S.reset();
    assert.strictEqual((await S.maybe(row, viewOf(25))).skipped, 'failed');

    // The cap per run, and the kill switch.
    reply = 'Did more.';
    S.reset();
    config.build.summaryMaxPerRun = 3;
    assert.deepStrictEqual(await S.maybe(row, viewOf(40)), { skipped: 'cap per run' });
    config.build.summaryMaxPerRun = 40;
    config.build.summaryEnabled = false;
    assert.deepStrictEqual(await S.maybe(row, viewOf(40)), { skipped: 'off' });
    config.build.summaryEnabled = true;
    // Many calls at once: the newest 40 go to the model.
    S.reset();
    prompts.length = 0;
    const other = await repo.buildRuns.insert({ task: 'big', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    assert.ok((await S.maybe(other, viewOf(100))).wrote);
    assert.strictEqual(prompts[0].prompt.split('\n').filter((l) => l.startsWith('Bash ')).length, 40, 'the newest 40 calls');
    assert.ok(prompts[0].prompt.includes('step 100') && !prompts[0].prompt.includes('step 60\n'));
    await repo.buildRuns.update(other.id, { state: 'done' });
  } finally {
    llm.complete = realComplete;
  }

  // ------------------------------------------------------- views: board, chat, heartbeat ----
  {
    S.reset();
    const msgs = await repo.buildRuns.msgs(run.id);
    await repo.buildRuns.addMsg({ runId: run.id, dir: 'agent', kind: 'note', body: 'halfway' });
    const all = await repo.buildRuns.msgs(run.id);
    const split = S.split(all, 2);
    assert.strictEqual(split.summaries.length, 2, 'the newest `lines`');
    assert.deepStrictEqual(split.messages.map((m) => m.kind), ['note'], 'summaries are not conversation');
    assert.ok(msgs.length < all.length);

    const track = { totals: { calls: 7 }, context: { tokens: 50_000, window: 200_000, pct: 25, model: 'm' }, agents: [] };
    await repo.buildRuns.update(run.id, { track: J(track) });
    const row = await repo.buildRuns.byId(run.id);
    const v = board.view(row, all, null, 2);
    assert.strictEqual(v.summaries.length, 2);
    assert.deepStrictEqual(v.messages.map((m) => m.kind), ['note']);
    assert.deepStrictEqual(v.context, track.context);

    const chat = await chatTools.handle('build_run', { run: run.id });
    assert.deepStrictEqual(chat.summaries.length, 3, 'the chat gets the setting\'s lines (3 by default)');
    assert.ok(chat.summaries.every((s) => typeof s.text === 'string'));
    assert.deepStrictEqual(chat.context, track.context);
    assert.ok(!chat.messages.some((m) => m.kind === 'summary'));

    // Heartbeat: a summary is not a sign of life.
    const hb = require('../src/build/heartbeat.ts');
    assert.strictEqual(typeof hb.tick, 'function');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'build', 'heartbeat.ts'), 'utf8'), /m\.kind !== 'summary'/);
  }

  // --------------------------------------------------------------------- nav status ----
  {
    board.resetStatus();
    // `run` is running with no open question; start a waiting one and an idle one.
    const waiting = await repo.buildRuns.insert({ task: 'asks', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    await repo.buildRuns.update(waiting.id, { state: 'waiting', cost_usd: 1.234 });
    await repo.buildRuns.addMsg({ runId: waiting.id, dir: 'agent', kind: 'ask', body: 'which branch?' });
    const idle = await repo.buildRuns.insert({ task: 'idle one', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    await repo.buildRuns.update(idle.id, { state: 'idle', cost_usd: 2 });
    await repo.buildRuns.update(run.id, { cost_usd: 0.5 });
    const s = await board.status(Date.now());
    assert.strictEqual(s.running, 1, 'only the run that is working');
    assert.strictEqual(s.needs_you, 2, 'an open question and an idle run');
    assert.ok(Math.abs(s.spend_usd - 3.73) < 0.011, `spend today is the runs started today: ${s.spend_usd}`);
    assert.strictEqual(typeof s.pa_spend_usd, 'number');
    // Cached: a change is not seen inside the TTL, and is after it.
    await repo.buildRuns.update(idle.id, { state: 'done' });
    assert.strictEqual((await board.status(Date.now())).needs_you, 2);
    assert.strictEqual((await board.status(Date.now() + 6000)).needs_you, 1);
    // The route answers it.
    let sent = null;
    const handled = await board.route({ method: 'GET', headers: {} }, {}, new URL('http://x/api/build/status'), { send: (res, code, body) => { sent = [code, body]; }, readJson: async () => ({}) });
    assert.ok(handled && sent[0] === 200 && 'running' in sent[1]);
  }

  // ------------------------------------------------------------- the nav script ----
  {
    const nav = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'nav.js'), 'utf8');
    assert.match(nav, /api\/build\/status/);
    assert.match(nav, /jnav-status/);
  }

  // ------------------------------------------------- pa: the model refresh is lazy ----
  {
    const { NO_MODELS } = require('../src/cli/index.ts');
    for (const c of ['run', 'agents', 'profile', 'help']) assert.ok(NO_MODELS.includes(c), `${c} skips the model refresh`);
    for (const c of ['plan', 'brief', 'ask', 'draft', 'memory']) assert.ok(!NO_MODELS.includes(c), `${c} still reads the model settings`);
  }

  await require('../src/db').close?.().catch?.(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('build summaries ok');
})().catch((e) => { console.error(e); process.exit(1); });
