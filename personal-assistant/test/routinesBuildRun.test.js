'use strict';

// The `build_run` routine action (src/routines/actions/buildRun.ts, BUILD-ENRICHMENT E): saved only
// with a profile that exists, starts a Build run through build.start with the routine as its origin,
// records the run id on the routine_run row, and skips (a recorded reason, not a failure) when the
// daily budget is spent, when its previous run is still live, or when the profile is gone.
// Also the dashboard's pinned parse, the board's "scheduled:" label and summary.json's origin.
// SQLite store; build.start, the model and the spend query stubbed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-routine-build-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_routine_build.sqlite');
process.env.PA_SQLITE_KEY = 'routine-build-test-key';
process.env.PA_WORKTREES_ROOT = dir;
process.env.PA_DATA_DIR = path.join(dir, 'data');

const routines = require('../src/routines');
const actions = require('../src/routines/actions');
const B = require('../src/build/index.ts');
const O = require('../src/build/origin.ts');
const budget = require('../src/budget.ts');
const llm = require('../src/llm.ts');
const { available } = require('../src/db/sqlite.ts');

// Pure: the registry entry and the origin text.
{
  assert.ok(actions.names().includes('build_run'));
  assert.throws(() => actions.validateParams('build_run', { profile: 'chore' }), /"prompt" is required/);
  assert.throws(() => actions.validateParams('build_run', { prompt: 'x' }), /"profile" is required/);
  const p = routines.preview({ title: 'Nightly docs', schedule: '0 7 * * 1-5', action: 'build_run', params: { prompt: 'tidy the docs', profile: 'chore', repo: 'C:/x' } });
  assert.match(p.plain, /Weekdays.*chore Build agent in C:\/x.*tidy the docs.*nothing is merged/s);
  assert.strictEqual(p.nextRuns.length, 3);
  assert.match(p.changes, /Claude Code agent/);

  assert.strictEqual(O.ofRoutine({ id: 12, title: '  Nightly   docs ' }), 'routine:12:Nightly docs');
  assert.deepStrictEqual(O.parse('routine:12:Nightly docs'), { routine: 12, name: 'Nightly docs' });
  assert.strictEqual(O.label('routine:12:Nightly docs'), 'scheduled: Nightly docs');
  assert.strictEqual(O.label('routine:12:'), 'scheduled: routine #12');
  assert.strictEqual(O.label(null), null);
  assert.strictEqual(O.parse('manual'), null);
  assert.strictEqual(O.likeRoutine(12), 'routine:12:%');
}

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP routine build_run: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  let spend = 0;
  budget.spentToday = async () => spend;
  let starts = [];
  B.start = async (o) => {
    starts.push(o);
    const r = await repo.buildRuns.insert({ task: o.task, model: o.model || 'sonnet', costCapUsd: 1, wallCapMin: 10, profile: o.profile, origin: o.origin });
    return { ...(await repo.buildRuns.byId(r.id)), repo_path: o.repoPath || null };
  };
  const detail = (x) => (typeof x.detail === 'string' ? JSON.parse(x.detail) : x.detail) || {};
  try {
    await require('../src/db/migrate.ts').migrate();
    const input = { title: 'Nightly docs', schedule: '0 7 * * 1-5', action: 'build_run', params: { prompt: 'tidy the docs', profile: 'chore' } };

    // Saved only with a profile that exists, a valid model and effort.
    await assert.rejects(() => routines.create({ ...input, params: { ...input.params, profile: 'ghost' } }), /no profile "ghost"/);
    await assert.rejects(() => routines.create({ ...input, params: { ...input.params, model: 'gpt-9' } }), /model must be/);
    await assert.rejects(() => routines.create({ ...input, params: { ...input.params, effort: 'extreme' } }), /effort must be/);
    await assert.rejects(() => routines.previewChecked({ ...input, params: { ...input.params, profile: 'ghost' } }), /no profile "ghost"/);
    const routine = await routines.create(input);
    assert.strictEqual(routine.action, 'build_run');

    // A fire starts one run, through build.start, with the routine as its origin.
    const first = await routines.runRoutine(routine.id, { scheduled: true });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(starts.length, 1);
    assert.deepStrictEqual([starts[0].task, starts[0].profile, starts[0].origin], ['tidy the docs', 'chore', `routine:${routine.id}:Nightly docs`]);
    const [hist] = await routines.history({ routineId: routine.id, limit: 1 });
    const runId = detail(hist).buildRunId;
    assert.ok(runId, 'the run id is on the routine_run row');
    assert.match(hist.summary, new RegExp(`started run #${runId} \\(chore\\)`));
    const run = await repo.buildRuns.byId(runId);
    assert.strictEqual(run.origin, `routine:${routine.id}:Nightly docs`);

    // The board card and the kept summary name the routine.
    const view = require('../src/dashboard/buildBoard.ts').view(run, [], null);
    assert.strictEqual(view.origin, 'scheduled: Nightly docs');
    assert.strictEqual(require('../src/dashboard/buildBoard.ts').view({ ...run, origin: null }, [], null).origin, null);

    // The previous run is still live: skipped, with the reason, as a quiet success.
    const again = await routines.runRoutine(routine.id, { scheduled: true });
    assert.strictEqual(again.ok, true);
    assert.match(again.summary, new RegExp(`skipped: the previous run \\(#${runId}, starting\\) is still going`));
    assert.strictEqual(starts.length, 1, 'no pile-up');
    // Another routine's live run does not block this one.
    assert.strictEqual(await repo.buildRuns.liveForOrigin(O.likeRoutine(routine.id + 1000)), null);

    // The run ends: the budget (model spend plus the Build runs' notional cost today) gates the next one.
    await repo.buildRuns.update(runId, { state: 'done', cost_usd: 2, ended_at: new Date().toISOString() });
    spend = 13.5; // 13.5 + 2 of today's Build cost = 15.5 >= the default $15 cap
    const broke = await routines.runRoutine(routine.id, { scheduled: true });
    assert.strictEqual(broke.ok, true);
    assert.match(broke.summary, /skipped: today's budget is spent \(\$15\.50 of \$15\)/);
    assert.strictEqual(starts.length, 1);
    spend = 1;
    const second = await routines.runRoutine(routine.id, { scheduled: true });
    assert.match(second.summary, /started run #/);
    assert.strictEqual(starts.length, 2);
    await repo.buildRuns.update(detail((await routines.history({ routineId: routine.id, limit: 1 }))[0]).buildRunId, { state: 'done' });

    // Cannot tell what was spent: not a licence to spend.
    budget.spentToday = async () => { throw new Error('store away'); };
    assert.match((await routines.runRoutine(routine.id, { scheduled: true })).summary, /skipped: cannot tell what was spent/);
    budget.spentToday = async () => spend;

    // A dry run starts nothing.
    const dry = await routines.runRoutine(routine.id, { dryRun: true });
    assert.match(dry.summary, /dry run: would start a chore run/);
    assert.strictEqual(starts.length, 2);

    // A profile deleted since the routine was saved: skipped and said loudly (notable), never a crash.
    const gone = await actions.get('build_run').run({ prompt: 'x', profile: 'ghost' }, { routine });
    assert.deepStrictEqual([gone.ok, gone.notable, gone.detail.skipped], [true, true, true]);
    assert.match(gone.summary, /profile "ghost" no longer exists/);

    // The dashboard's pinned parse: the words give only the schedule; the action and params cannot be changed.
    llm.complete = async () => '{"title":"Docs at seven","schedule":"0 7 * * *","action":"repo_sync","params":{}}';
    const dash = require('../src/dashboard/routines.ts');
    const pinned = await dash.route('POST', new URL('http://x/api/routines/parse'), { words: 'every day at 7', pin: { action: 'build_run', params: { prompt: 'tidy the docs', profile: 'chore' } } });
    assert.deepStrictEqual([pinned.action, pinned.params.profile, pinned.schedule, pinned.title], ['build_run', 'chore', '0 7 * * *', 'Docs at seven']);
    await assert.rejects(() => dash.route('POST', new URL('http://x/api/routines/parse'), { words: 'daily', pin: { action: 'build_run', params: { prompt: 'x' } } }), /"profile" is required/);
    await assert.rejects(() => dash.route('POST', new URL('http://x/api/routines/parse'), { words: 'daily', pin: { action: 'build_run', params: { prompt: 'x', profile: 'ghost' } } }), /no profile "ghost"/);
    const listing = await dash.route('GET', new URL('http://x/api/routines'), {});
    assert.ok(listing.profiles.some((p) => p.name === 'chore'), 'the form can offer the profiles');
    assert.ok(listing.actions.some((a) => a.action === 'build_run'));

    // The CLI: typed flags give the action's params; --schedule skips the model.
    const lines = [];
    const cli = require('../src/cli/routine.ts').make((s) => lines.push(s), (s) => { throw new Error(s); });
    await cli.routine(['add', 'weekday mornings'], { action: 'build_run', profile: 'chore', prompt: 'tidy the docs', schedule: '0 8 * * 1-5', title: 'Docs at eight', yes: true });
    assert.match(lines.join('\n'), /Docs at eight/);
    assert.match(lines.join('\n'), /saved routine #/);
    const saved = (await routines.list()).find((r) => r.title === 'Docs at eight');
    assert.deepStrictEqual([saved.action, saved.params.profile, saved.params.prompt, saved.schedule], ['build_run', 'chore', 'tidy the docs', '0 8 * * 1-5']);
    await assert.rejects(() => cli.routine(['add', 'x'], { action: 'build_run', prompt: 'p', yes: true }), /"profile" is required/);
    await assert.rejects(() => cli.routine(['add', 'x'], { action: 'run_shell', yes: true }), /unknown action/);

    // summary.json keeps where the run came from.
    const T = require('../src/build/track.ts');
    await T.tick();
    const kept = path.join(dir, 'data', 'build-runs', `run-${runId}`, 'summary.json');
    const sum = JSON.parse(fs.readFileSync(kept, 'utf8'));
    assert.deepStrictEqual([sum.origin, sum.routine], ['scheduled: Nightly docs', routine.id]);
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('routine build_run ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
