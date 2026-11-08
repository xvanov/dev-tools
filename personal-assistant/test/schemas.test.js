'use strict';

// Plan 1.1 (D15): the contract schemas in ../schemas (Job, Run, Card, Event,
// Approval) are one source; TS types are generated from them; the PA's own
// objects validate against them. What earns a test: the generated types are
// current; every schema uses only keywords both validators understand; a
// JOBS-API v1.4 status validates and a broken one does not; the id-chain
// objects (factoryCore.chainOf / runChain), the chat's card and board views,
// the event bus frames and the permission prompt shapes all validate.
// The factory side is software-factory/tests/test_contract_schemas.py.
// Names are invented.

const fake = require('./_fakeDb').install();
// chatTools destructures src/db at load: answer through a table the test swaps.
let answers = {};
fake.one = async (sql) => (/from proposal where id/.test(sql) ? answers.proposal ?? null : /from commitment c/.test(sql) ? answers.commitment ?? null : null);
fake.rows = async (sql) => (/from run where commitment_id/.test(sql) ? answers.runs || []
  : /from proposal where commitment_id/.test(sql) ? answers.offers || []
  : /from run_pr /.test(sql) ? answers.prs || []
  : /from run_step /.test(sql) ? answers.steps || [] : []);
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';

const S = require('../../schemas');
const { generate, OUT } = require('../../schemas/gen-types');
const F = require('../src/dispatch/factoryCore.ts');
const T = require('../src/mcp/chatTools.ts');
const { createBus } = require('../src/events/bus.ts');

const ok = (name, v) => assert.deepStrictEqual(S.validate(name, JSON.parse(JSON.stringify(v))), [], `${name} should validate`);
const bad = (name, v, re) => {
  const errs = S.validate(name, v);
  assert.ok(errs.length, `${name} should NOT validate: ${JSON.stringify(v).slice(0, 120)}`);
  if (re) assert.ok(errs.some((e) => re.test(e)), `expected an error matching ${re}, got ${errs.join('; ')}`);
};

async function main() {
  // --- the generated types are current; every keyword is one both validators know -------
  assert.strictEqual(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), generate(), 'schemas/types.d.ts is stale: run `node schemas/gen-types.js`');
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}[${i}]`));
    for (const k of Object.keys(node)) assert.ok(S.KEYWORDS.has(k), `${at}: keyword "${k}" is not supported by schemas/index.js`);
    for (const k of ['properties', '$defs']) for (const [n, sub] of Object.entries(node[k] || {})) walk(sub, `${at}.${k}.${n}`);
    for (const k of ['items', 'additionalProperties']) if (typeof node[k] === 'object') walk(node[k], `${at}.${k}`);
    for (const sub of node.anyOf || []) walk(sub, `${at}.anyOf`);
  };
  for (const n of S.NAMES) {
    const s = S.schema(n);
    walk(s, n);
    assert.strictEqual(s.$id, `https://github.com/xvanov/dev-tools/schemas/${n}.schema.json`);
    for (const f of fs.readdirSync(S.DIR).filter((x) => x.endsWith('.json'))) {
      assert.notStrictEqual(fs.readFileSync(path.join(S.DIR, f))[0], 0xef, `${f} starts with a BOM`);
    }
  }

  // --- Job: a JOBS-API v1.4 status ----------------------------------------------------
  const job = JSON.parse(fs.readFileSync(path.join(S.DIR, 'examples', 'job-code.json'), 'utf8'));
  ok('job', job);
  ok('job', JSON.parse(fs.readFileSync(path.join(S.DIR, 'examples', 'job-research.json'), 'utf8')));
  bad('job', { ...job, state: 'running' }, /state/);
  bad('job', { ...job, delivery: 'yolo' }, /delivery/);
  bad('job', { ...job, job_id: 'no colon' }, /job_id/);
  bad('job', (({ why, ...rest }) => rest)(job), /missing "why"/);
  bad('job', { ...job, stories: [{ ...job.stories[0], ci: { state: 'red' } }] }, /ci/);
  bad('job', { ...job, runs: [{ ...job.runs[0], billing: 'free' }] }, /billing/);
  ok('job', { ...job, some_v15_field: 1 }); // additive contract: unknown keys pass

  // --- Run: the id chain (plan E1) ----------------------------------------------------
  const chain = F.chainOf(job);
  ok('run#/$defs/chain', chain);
  assert.ok(chain.steps.length && chain.prs.length, 'the example has steps and PRs');
  ok('run#/$defs/chain', F.chainOf(null));
  const run = F.runChain(
    { id: '45', commitment_id: '412', status: 'running', route: 'factory', factory_job_id: job.job_id, factory_state: 'in_progress', termhub_session_id: 'f1', mr_url: 'https://github.com/acme/widget/pull/70' },
    chain,
    { sessionUrl: 'http://127.0.0.1:7000/#session=f1' }
  );
  ok('run', run);
  ok('run', F.runChain({ id: 7, status: 'done' }));
  bad('run', { ...run, run: 'forty-five' }, /run/);
  bad('run', { ...run, extra: 1 }, /unexpected "extra"/);

  // --- Card: the chat's board and card views ---------------------------------------------
  const NOW = new Date(2026, 10, 7, 10, 0, 0).getTime();
  const board = T.boardView({
    onMe: [
      { id: 1, group: 'todo', summary: 'Send the deck', who: 'Ada Example', due_at: new Date(2026, 10, 7, 18), direction: 'owed_by_me', status: 'open', asks: [{ id: 3, kind: 'dispatch', title: 'Do it', payload: { delivery: 'draft_pr' } }, { id: 4, kind: 'close', title: 'Close?' }] },
      { id: 2, group: 'blocked', summary: 'Ship it', blockers: [{ id: 9, who: null, summary: 'waiting on review' }], status: 'dispatched' },
      { id: 'p5', group: 'todo', summary: 'An offer', standalone: true, unblocked: [{ blocker_id: 8, who: 'Bo', summary: 'done now' }] },
      { id: 6, group: 'settled', summary: 'Looks done', settled: { id: 11, confidence: 0.9 }, waitingOn: true, direction: 'owed_to_me' },
    ],
    counts: { waiting: 2 },
  }, { extras: new Map([['1', { slug: 'acme/widget', run: { id: 45, status: 'running', route: 'factory', job: 'widget:031', state: 'in_progress' } }]]), now: NOW });
  for (const g of ['todo', 'blocked', 'unblocked', 'looks_done']) for (const c of board[g]) ok('card#/$defs/compact', c);
  bad('card#/$defs/compact', { id: '1' }, /summary/);

  const commitment = { id: '412', direction: 'owed_by_me', status: 'open', summary: 'Fix the widget', detail: 'More', due_at: null, repo_path: null, project: 'Widget', slug: 'acme/widget', who: 'Ada Example', item_id: '77', source: 'outlook', subject: 'Widget', occurred_at: new Date('2026-11-06T09:00:00Z'), body: 'Please fix the widget.' };
  const storedRun = { id: '45', status: 'running', mode: 'mr', route: 'factory', factory_job_id: job.job_id, factory_state: 'in_progress', delivery: 'draft_pr', cost_usd: '1.5', mr_url: null, termhub_session_id: 'f1', machine: null, started_at: new Date() };
  answers = { commitment, runs: [storedRun], prs: chain.prs.map((p) => ({ run_id: '45', ...p })), steps: chain.steps.map((s) => ({ run_id: '45', ...s })), offers: [{ id: '3', kind: 'dispatch', title: 'Do it', payload: { delivery: 'draft_pr' } }] };
  const card = await T.handle('card', { id: '412' });
  ok('card', card);
  assert.ok(card.runs[0].steps.length && card.runs[0].prs.length && card.offers.length, 'the card carries its run chain and offers');
  answers = { proposal: { id: '37', kind: 'dispatch', title: 'Offer', body: 'Body', payload: { slug: 'acme/widget' }, status: 'pending', commitment_id: null } };
  ok('card', await T.handle('card', { id: 'p37' }));
  bad('card', { id: '412', summary: 'x', direction: 'sideways', status: 'open', source: {} }, /direction|source/);

  // --- Event: what GET /api/events frames carry ---------------------------------------------
  const bus = createBus({ epoch: 'k1' });
  ok('event', bus.publish('run', { table: 'run', op: 'update', id: 45, status: 'running' }));
  ok('event', bus.publish('board', {}));
  ok('event', bus.publish('board', { table: 'notification', op: 'insert', id: 9, seq: 41 }, { gid: 41 }));
  ok('event', require('../src/events').outboxEvent({ seq: '42', topic: 'run', payload: { table: 'run', op: 'update', id: 45, seq: 42, status: 'running' }, at: new Date() }));
  ok('event', { id: bus.lastId(), topic: 'hello', at: new Date().toISOString(), payload: { epoch: bus.epoch } });
  ok('event', { id: bus.lastId(), topic: 'resync', at: new Date().toISOString(), payload: { reason: 'cannot replay from that id' } });
  bad('event', { id: 'x', topic: 'Board!', at: 'now', payload: {} }, /topic|id/);
  bad('event', { id: 'k1-1', topic: 'run', at: 'now', payload: { op: 'truncate' } }, /op/);

  // --- Approval: the prompt the chat waits on, and the answer ----------------------------
  ok('approval', { toolUseId: 'toolu_01', text: 'start a factory job', approvable: true, ask: 'Start a factory job for card 412? Shall I?' });
  ok('approval', { toolUseId: 'toolu_02', text: 'run a shell command', approvable: false, ask: null });
  bad('approval', { toolUseId: '', text: null, approvable: true, ask: null }, /shorter/);
  ok('approval#/$defs/decision', { answer: 'yes', toolUseId: 'toolu_01', via: 'voice' });
  bad('approval#/$defs/decision', { answer: 'maybe', toolUseId: 'toolu_01' }, /answer/);

  // --- assertValid throws with the errors listed -------------------------------------------
  assert.throws(() => S.assertValid('event', {}), /missing "id"/);
  assert.throws(() => S.validate('nope', {}), /no schema/);

  console.log('schemas.test.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
