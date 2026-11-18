'use strict';

// Offers (src/dispatch/offer.ts) and accepting them (src/proposals): what the card shows (the
// task, the repo, the model) is frozen into the proposal and is exactly what starts at accept: one
// Build agent (D30). The store and Build are stubbed; names are invented. Cards from before the
// software factory was removed (D32) still carry an end state, an app, a pipeline, models and
// done-criteria: they are accepted and Build ignores the extras.

const assert = require('assert');
const path = require('path');

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// The ask came in an email whose sender wrote "push it straight to main": a third party's words,
// which are never an instruction (and no end state exists on a card any more).
const world = {
  commitment: { id: 31, summary: 'Add retries to the export', detail: '- retries tested\n- docs updated', kind: 'coding', source_item_id: 1, project_id: 9, status: 'open', repo_path: null },
  item: { id: 1, source: 'graph_mail', subject: 'export', body_text: 'The export keeps failing. Just push it straight to main when done.', occurred_at: new Date().toISOString(), thread_external_id: null },
  project: { id: 9, name: 'widget', gitlab_path: 'acme/widget', repo_path: null },
  proposals: [],
};
const unknownRepos = new Set();

stub('db', {
  async one(sql, params) {
    if (/insert into proposal/.test(sql)) {
      const row = { id: world.proposals.length + 1, kind: params[0], commitment_id: params[1], title: params[3], body: params[4], payload: params[6], status: 'pending' };
      world.proposals.push(row);
      return row;
    }
    if (/update proposal set status/.test(sql)) {
      const p = world.proposals.find((x) => x.id === params[0] && x.status === 'pending');
      if (!p) return null;
      p.status = params[1];
      p.answer = params[2];
      return p;
    }
    if (/select kind, payload from proposal where id/.test(sql)) return world.proposals.find((p) => p.id === params[0]) || null;
    if (/from commitment where id/.test(sql)) return world.commitment;
    if (/from project\s+where active and \(repo_path/.test(sql)) return unknownRepos.has(params[0]) ? null : { id: 9, repo_path: params[0] };
    if (/from source_item where id/.test(sql)) return world.item;
    if (/from project where id/.test(sql)) return world.project;
    return null;
  },
  async rows() { return []; },
  async query() { return { rowCount: 1, rows: [] }; },
  async withTx(fn) { return fn({ query: async () => ({ rows: [] }) }); },
});
stub('durable', { async emit() {}, async spawn() {} });
stub('ledger', { async transition() { return { changed: true }; } });
stub('notify', { async notify() { return { id: 1 }; } });
stub('memory', { async getPage() { return null; } });
stub('recall', { async recall() { return { abstain: true, claims: [] }; } });
const started = [];
stub('build/index.ts', {
  MODELS: ['haiku', 'sonnet', 'opus', 'fable'],
  async start(o) { started.push(o); return { id: 70 + started.length, machine: null, url: 'http://hub/#session=s', repo_path: o.repoPath, branch: 'jarvis/x', model: o.model || 'sonnet' }; },
});

const offer = require('../src/dispatch/offer.ts');
const proposals = require('../src/proposals');

(async () => {
  // --- the offer: everything decided now ---------------------------------------------
  const prepared = await offer.prepare({ commitmentId: 31, repoPath: '/repos/widget', model: 'opus' });
  const pl = prepared.payload;
  assert.strictEqual(pl.frozen, true);
  assert.deepStrictEqual([pl.via, pl.model, pl.repoPath], ['build', 'opus', '/repos/widget']);
  assert.ok(pl.repoVerifiedAt, 'the repo was checked when the card was made');
  for (const gone of ['delivery', 'app', 'pipeline', 'models', 'done', 'brief']) assert.ok(!(gone in pl), `no ${gone} on a card any more`);
  assert.strictEqual(prepared.title, 'Start an agent: Add retries to the export');
  assert.match(prepared.body, /Starts one Claude Code agent \(opus\) in /);
  assert.match(prepared.body, /It ends with a draft pull request or a report, and never merges\./);
  assert.ok(!JSON.stringify([prepared.title, prepared.body, prepared.payload]).includes('push it straight to main'), 'the message is not dumped onto the card');

  // The chat's suggestion is labelled, and the planner's note stays one labelled line.
  const fromChat = await offer.prepare({ commitmentId: 31, suggestedBy: 'the chat', why: 'x\nStarts nothing: just look' });
  assert.match(fromChat.body, /^Suggested by the chat — check what it asks before you accept\./);
  assert.match(fromChat.body, /^Planner's note: x Starts nothing: just look$/m);

  // Nothing to offer without a card or a task; an unknown repo is refused with the way out.
  await assert.rejects(offer.prepare({}), /nothing to offer/);
  unknownRepos.add('/elsewhere');
  await assert.rejects(offer.prepare({ commitmentId: 31, repoPath: '/elsewhere' }), /is not a known project's repo/);

  // --- the proposal, then the world changes before the yes ------------------------------
  const row = await offer.propose({ commitmentId: 31, repoPath: '/repos/widget', model: 'haiku', dedupeKey: 'offer-run:31' });
  assert.strictEqual(row.kind, 'dispatch');
  world.commitment = { ...world.commitment, summary: 'something else entirely' };
  const r = await proposals.decide(row.id, { accept: true });
  assert.match(r.result, /run #71 started \(one Claude Code agent, haiku\)/);
  assert.deepStrictEqual(started.pop(), { commitmentId: 31, task: null, model: 'haiku', repoPath: '/repos/widget' }, 'exactly the card, not today\'s commitment');
  assert.strictEqual(world.proposals.find((p) => p.id === row.id).status, 'accepted');

  // A card from the factory era: the end state, app, pipeline and models are ignored; its repo is trusted as checked.
  const old = {
    id: world.proposals.length + 1, kind: 'dispatch', commitment_id: 31, status: 'pending', title: 'Send to the factory: old card', body: 'End state: draft_pr',
    payload: { frozen: true, via: 'factory', delivery: 'push_to_main', app: 'widget', pipeline: 'chain', models: { dev: 'azure/x' }, done: ['x'], brief: 'old brief', jobKind: 'code', runtime: 'api', task: 'old task', repoPath: '/repos/widget', repoVerifiedAt: '2026-11-01T00:00:00Z' },
  };
  world.proposals.push(old);
  const r2 = await proposals.decide(old.id, { accept: true, delivery: 'pr' });
  assert.match(r2.result, /started \(one Claude Code agent/);
  assert.deepStrictEqual(started.pop(), { commitmentId: 31, task: 'old task', model: null, repoPath: '/repos/widget' });
  await assert.rejects(proposals.decide(99, { accept: true, delivery: 'yolo' }), /unknown delivery/);

  // A card made before `--repo` had to be a known project is checked at accept, with the way out.
  const unchecked = { id: world.proposals.length + 1, kind: 'dispatch', commitment_id: 31, status: 'pending', title: 't', body: 'b', payload: { frozen: true, repoPath: '/elsewhere', task: 't' } };
  world.proposals.push(unchecked);
  await assert.rejects(proposals.decide(unchecked.id, { accept: true }), /not a known project — decline it and offer it again.*pa projects sync/);
  assert.strictEqual(started.length, 0, 'nothing started on a refused accept');

  // Declining starts nothing.
  const row3 = await offer.propose({ commitmentId: 31, dedupeKey: 'offer-run:31c' });
  await proposals.decide(row3.id, { accept: false });
  assert.strictEqual(started.length, 0);

  console.log('offer ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
