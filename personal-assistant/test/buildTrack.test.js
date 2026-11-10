'use strict';

// Transcript tracking (src/build/track.ts): the parse of Claude Code's session
// JSONL (usage deduped by message id, tool calls with ok/err and timing,
// subagent transcripts beside the session), the notional price, the caps, and
// a tick over a real folder layout on a throwaway SQLite store.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-build-track-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_build_track.sqlite');
process.env.PA_SQLITE_KEY = 'build-track-test-key';
process.env.PA_WORKTREES_ROOT = dir;
process.env.PA_DATA_DIR = path.join(dir, 'data');

const T = require('../src/build/track.ts');
const { available } = require('../src/db/sqlite.ts');

const J = (o) => JSON.stringify(o);
const usage = (i, o, cr, cw5, cw1 = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw5 + cw1, cache_creation: { ephemeral_5m_input_tokens: cw5, ephemeral_1h_input_tokens: cw1 } });
const asst = (at, id, model, u, content) => J({ type: 'assistant', timestamp: at, message: { id, model, usage: u, content } });
const result = (at, id, isError) => J({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });

const MAIN = [
  J({ type: 'user', timestamp: '2026-11-10T10:00:00.000Z', message: { role: 'user', content: 'go' } }),
  // one message written twice (a thinking block, then the tool_use): counted once
  asst('2026-11-10T10:00:02.000Z', 'm1', 'claude-sonnet-5-5', usage(10, 100, 1000, 2000), [{ type: 'thinking' }]),
  asst('2026-11-10T10:00:02.500Z', 'm1', 'claude-sonnet-5-5', usage(10, 100, 1000, 2000), [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git   status\n--short' } }]),
  result('2026-11-10T10:00:04.000Z', 't1', false),
  asst('2026-11-10T10:00:06.000Z', 'm2', 'claude-sonnet-5-5', usage(5, 50, 3000, 0), [{ type: 'tool_use', id: 't2', name: 'Agent', input: { description: 'survey', prompt: 'look at things' } }, { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/x/y.md' } }]),
  result('2026-11-10T10:00:07.000Z', 't3', true),
  '{"type":"assistant","timestamp":"2026-11-10T10:00:09.000Z","message":{"id":"m3","usa', // half-written last line
].join('\n');

// ---- pure --------------------------------------------------------------------

{
  const p = T.parseAgent(MAIN, 'sonnet');
  assert.deepStrictEqual(p.tokens, { in: 15, out: 150, cache_read: 4000, cache_write: 2000 });
  assert.strictEqual(p.messages, 2, 'a message id counts once');
  assert.deepStrictEqual(p.calls.map((c) => [c.name, c.args, c.ok]), [['Bash', 'git status --short', true], ['Agent', 'survey', null], ['Read', '/x/y.md', false]]);
  assert.strictEqual(p.calls[0].ms, 1500);
  assert.strictEqual(p.started_at, '2026-11-10T10:00:00.000Z');
  // sonnet $3/$15 per M, cache read 0.1x, 5-minute cache write 1.25x
  const want = (10 * 3 + 100 * 15 + 1000 * 0.3 + 2000 * 3.75 + 5 * 3 + 50 * 15 + 3000 * 0.3) / 1e6;
  assert.ok(Math.abs(p.cost_usd - want) < 1e-9, `${p.cost_usd} vs ${want}`);
}
assert.deepStrictEqual([T.priceOf('claude-haiku-4-5').in, T.priceOf('claude-opus-5-5').out, T.priceOf('weird', 'opus').in, T.priceOf(null).in], [1, 25, 5, 3]);
assert.ok(Math.abs(T.costOf({ in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 1e6 }, 'sonnet') - 6) < 1e-9, 'a 1 h cache write is 2x input');
assert.strictEqual(T.shortArgs('Bash', { command: 'x'.repeat(300) }).length, 100);

{
  const caps = { cost_cap_usd: 5, wall_cap_min: 120, started_at: new Date(Date.now() - 10 * 60_000).toISOString() };
  assert.strictEqual(T.overCap(caps, { cost_usd: 1 }), null);
  assert.match(T.overCap(caps, { cost_usd: 5.2 }), /cost cap reached: \$5\.20 of \$5\.00/);
  assert.match(T.overCap({ ...caps, started_at: new Date(Date.now() - 121 * 60_000).toISOString() }, { cost_usd: 0 }), /time cap reached/);
}

// ---- files and the tick -------------------------------------------------------

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP build track: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  const B = require('../src/build/index.ts');
  const termhub = require('../src/dispatch/termhub.ts');
  const killed = [];
  termhub.killSession = async (id) => { killed.push(id); return true; };
  termhub.sessionUrl = async () => null;
  const home = path.join(dir, 'home');
  const proj = path.join(home, '.claude', 'projects', 'C--w-build-1');
  const os_ = require('os');
  os_.homedir = () => home;
  try {
    await require('../src/db/migrate.ts').migrate();
    const session = 'aaaaaaaa-0000-4000-8000-000000000001';
    fs.mkdirSync(path.join(proj, session, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(proj, `${session}.jsonl`), MAIN);
    const sub = [
      asst('2026-11-10T10:00:10.000Z', 's1', 'claude-haiku-4-5', usage(100, 20, 0, 5000), [{ type: 'tool_use', id: 'u1', name: 'Grep', input: { pattern: 'foo' } }]),
      result('2026-11-10T10:00:11.000Z', 'u1', false),
    ].join('\n');
    fs.writeFileSync(path.join(proj, session, 'subagents', 'agent-abc123.jsonl'), sub);
    fs.writeFileSync(path.join(proj, session, 'subagents', 'agent-abc123.meta.json'), J({ agentType: 'general-purpose', description: 'survey', toolUseId: 't2', finished: true }));

    const run = await repo.buildRuns.insert({ task: 'track me', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    await repo.buildRuns.update(run.id, { state: 'running', session_id: 'sess-t', claude_session: session, transcript_path: path.join(proj, `${session}.jsonl`) });

    const t1 = await T.tick();
    assert.deepStrictEqual(t1, { updated: 1, stopped: 0 });
    const row = await repo.buildRuns.byId(run.id);
    const track = JSON.parse(row.track);
    assert.deepStrictEqual(track.agents.map((a) => [a.id, a.kind, a.type, a.state, a.call_count]), [['main', 'main', 'main', 'running', 3], ['abc123', 'subagent', 'general-purpose', 'done', 1]]);
    assert.strictEqual(track.agents[1].parent_call, 't2');
    assert.strictEqual(track.agents[0].errors, 1);
    const subCost = (100 * 1 + 20 * 5 + 5000 * 1.25) / 1e6;
    assert.ok(Math.abs(Number(row.cost_usd) - (track.agents[0].cost_usd + subCost)) < 1e-9, 'the run is main + subagents');
    assert.strictEqual(Number(row.tokens_in), 115);
    assert.strictEqual(track.final, false);

    // Over its cost cap: stopped, its session killed.
    await repo.buildRuns.update(run.id, { cost_cap_usd: 0.000001 });
    assert.deepStrictEqual(await T.tick(), { updated: 1, stopped: 1 });
    const stopped = await repo.buildRuns.byId(run.id);
    assert.deepStrictEqual([stopped.state, killed], ['stopped', ['sess-t']]);
    assert.match(stopped.error, /cost cap reached/);

    // The tick after the end reads once more, marks the view final and keeps the raw logs.
    assert.deepStrictEqual(await T.tick(), { updated: 1, stopped: 0 });
    assert.strictEqual(JSON.parse((await repo.buildRuns.byId(run.id)).track).final, true);
    const kept = path.join(dir, 'data', 'build-runs', `run-${run.id}`);
    assert.ok(fs.existsSync(path.join(kept, 'summary.json')) && fs.existsSync(path.join(kept, 'messages.json')));
    assert.ok(fs.existsSync(path.join(kept, `${session}.jsonl`)));
    assert.ok(fs.existsSync(path.join(kept, session, 'subagents', 'agent-abc123.jsonl')));
    assert.deepStrictEqual(await T.tick(), { updated: 0, stopped: 0 }, 'a final view is left alone');

    // A run with no transcript yet still honours the wall clock.
    const slow = await repo.buildRuns.insert({ task: 'no transcript', model: 'haiku', costCapUsd: 5, wallCapMin: 1 });
    await repo.buildRuns.update(slow.id, { state: 'running', session_id: 'sess-s', claude_session: 'no-such-session' });
    await db.query('update build_run set started_at = $2 where id = $1', [slow.id, new Date(Date.now() - 5 * 60_000).toISOString()]);
    assert.deepStrictEqual(await T.tick(), { updated: 0, stopped: 1 });
    assert.match((await repo.buildRuns.byId(slow.id)).error, /time cap reached/);
    assert.ok(B.LIVE.includes('waiting'));
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('build track ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
