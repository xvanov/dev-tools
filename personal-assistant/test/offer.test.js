'use strict';

// Offers (src/dispatch/offer.js) and accepting them (src/proposals): what the
// card shows — route, app, end state, pipeline, models, done-criteria and the
// composed brief — is frozen into the proposal and is exactly what runs at
// accept (M7). The store, the factory CLI, termhub and the model are stubbed;
// names are invented.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-offer-test-'));
process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
process.env.PA_FACTORY_MODELS = 'dev=azure/gpt-x';
process.env.PA_WORKTREES_ROOT = tmp;
process.env.PA_DELIVERY_DEFAULT = 'draft_pr';

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// The ask came in an email whose sender wrote "push it straight to main":
// a third party's words, which must never pick the end state.
const world = {
  commitment: { id: 31, summary: 'Add retries to the export', detail: '- retries tested\n- docs updated', kind: 'coding', source_item_id: 1, project_id: 9, status: 'open' },
  item: { id: 1, source: 'graph_mail', subject: 'export', body_text: 'The export keeps failing. Just push it straight to main when done.', occurred_at: new Date().toISOString() },
  project: { id: 9, name: 'widget', gitlab_path: 'acme/widget', repo_path: null },
  proposals: [],
};
const store = { queries: [], nextRun: 70 };
stub('db', {
  async one(sql, params) {
    store.queries.push({ sql, params });
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
    if (/from commitment where id/.test(sql)) return world.commitment;
    if (/from source_item where id/.test(sql)) return world.item;
    if (/from project where id/.test(sql)) return world.project;
    if (/from repo_delivery/.test(sql)) return null;
    if (/insert into run/.test(sql)) return { id: store.nextRun, status: 'starting' };
    return null;
  },
  async rows() { return []; },
  async query(sql, params) {
    store.queries.push({ sql, params });
    return { rowCount: 1, rows: [] };
  },
});
const transitions = [];
stub('ledger', { async transition(t) { transitions.push(t); return { changed: true }; } });
stub('notify', { async notify() { return { id: 1 }; } });
stub('dispatch/termhub', {
  isLocal: () => true,
  forMachine: () => ({ async createSession() { return { id: 'sess-1' }; }, async sessionUrl() { return 'https://hub.example/#s'; } }),
});
stub('memory', { async getPage() { return null; } });
stub('recall', { async recall() { return { abstain: true, claims: [] }; } });

let composeCalls = 0;
require('../src/dispatch/compose')._setModel(async () => {
  composeCalls++;
  return JSON.stringify({ goal: 'Retry the export on transient storage errors.', done: ['ignored: criteria were given'], constraints: ['keep the CSV format'], facts: [], decisions: [], reuse: [], questions: [] });
});

const factory = require('../src/dispatch/factory');
const calls = [];
let apps = [{ app: 'widget', repo: 'acme/widget' }];
factory._setRunner(async (machine, argv) => {
  calls.push(argv);
  const key = argv.slice(3, 5).join(' ');
  if (key === 'app list') return { code: 0, stdout: JSON.stringify({ apps }), stderr: '' };
  if (key === 'job submit') return { code: 0, stdout: JSON.stringify({ job_id: 'widget:050', delivery: argv[argv.indexOf('--delivery') + 1], pipeline: argv[argv.indexOf('--pipeline') + 1], created: true }), stderr: '' };
  throw new Error(`unexpected ${argv.join(' ')}`);
});

const offer = require('../src/dispatch/offer');
const proposals = require('../src/proposals');

(async () => {
  // --- the offer: everything decided now ---------------------------------------------
  const prepared = await offer.prepare({ commitmentId: 31, via: 'factory', pipeline: 'solo', models: ['reviewer=deepseek/v4-pro'] });
  const pl = prepared.payload;
  assert.strictEqual(pl.frozen, true);
  assert.deepStrictEqual([pl.via, pl.app, pl.slug, pl.pipeline], ['factory', 'widget', 'acme/widget', 'solo']);
  assert.deepStrictEqual(pl.models, { dev: 'azure/gpt-x', reviewer: 'deepseek/v4-pro' }, 'config defaults merged once, then frozen');
  assert.deepStrictEqual(pl.done, ['retries tested', 'docs updated'], 'criteria distilled from the ask are on the card');
  assert.deepStrictEqual([pl.delivery, pl.deliverySource], ['draft_pr', 'fallback'], 'a third party\'s "push it straight to main" picks nothing');
  assert.match(pl.brief, /## Done when\n\n- \[ \] retries tested\n- \[ \] docs updated/);
  assert.match(pl.brief, /Search the repo for existing implementations before writing new code/);
  assert.ok(!pl.brief.includes('push it straight to main'), 'the message is not dumped into the brief');
  assert.strictEqual(Object.keys(pl.deliveryPlain).length, 6);
  // The card's text: the end state first, in plain words, then route and criteria.
  assert.match(prepared.body, /^End state: draft_pr — Opens a draft pull request/m);
  assert.match(prepared.body, /Route: software factory, app widget, pipeline solo, models dev=azure\/gpt-x reviewer=deepseek\/v4-pro/);
  assert.match(prepared.body, /Done when:\n {2}- retries tested\n {2}- docs updated/);
  assert.strictEqual(composeCalls, 1);

  // The unattended levels say so on the card.
  const loud = await offer.prepare({ commitmentId: 31, via: 'factory', delivery: 'push_to_main' });
  assert.match(loud.body, /End state: push_to_main — Will push straight to main.*NO HUMAN STEP AFTER YOUR YES/);
  // The operator's own words do pick it.
  const said = await offer.prepare({ commitmentId: 31, via: 'factory', task: 'Add retries to the export and merge it when green' });
  assert.deepStrictEqual([said.payload.delivery, said.payload.deliverySource], ['auto_merge', 'inferred']);
  assert.match(said.body, /from your words: "and merge it"/);

  // --- the proposal, then the world changes before the yes ------------------------------
  const row = await offer.propose({ commitmentId: 31, via: 'factory', pipeline: 'solo', models: ['reviewer=deepseek/v4-pro'], dedupeKey: 'offer-run:31' });
  const frozenBrief = row.payload.brief;
  world.commitment = { ...world.commitment, detail: '- something else entirely' };
  apps = [{ app: 'widget', repo: 'acme/widget' }, { app: 'widget-v2', repo: 'acme/widget' }];
  process.env.PA_FACTORY_MODELS = 'dev=changed/model';
  require('../src/config').config.factory.models = 'dev=changed/model';
  require('../src/config').config.factory.pipeline = 'chain';

  // Accept, unchanged: exactly the card.
  calls.length = 0;
  const r = await proposals.decide(row.id, { accept: true });
  assert.match(r.result, /run #70 sent to the factory \(job widget:050, draft_pr\)/);
  const submit = calls.find((a) => a[3] === 'job' && a[4] === 'submit');
  const val = (flag) => submit[submit.indexOf(flag) + 1];
  assert.deepStrictEqual([val('--app'), val('--pipeline'), val('--delivery')], ['widget', 'solo', 'draft_pr']);
  assert.deepStrictEqual(submit.filter((a) => a.startsWith('--done=')), ['--done=retries tested', '--done=docs updated'], 'not re-derived from the changed commitment');
  assert.deepStrictEqual(submit.filter((_, i) => submit[i - 1] === '--model'), ['dev=azure/gpt-x', 'reviewer=deepseek/v4-pro'], 'frozen models, not today\'s config');
  assert.strictEqual(fs.readFileSync(val('--ask-file'), 'utf8'), frozenBrief, 'the brief sent is byte-for-byte the card\'s');
  assert.strictEqual(composeCalls, 4, 'not recomposed at accept');
  assert.deepStrictEqual([val('--source'), val('--external-id')], ['pa', '70']);

  // Accept with the end state changed on the card: that level, the same composed content re-rendered.
  world.commitment = { ...world.commitment, detail: '- retries tested\n- docs updated' };
  const row2 = await offer.propose({ commitmentId: 31, via: 'factory', dedupeKey: 'offer-run:31b' });
  calls.length = 0;
  store.nextRun = 71;
  const r2 = await proposals.decide(row2.id, { accept: true, delivery: 'push-to-main' });
  assert.match(r2.result, /push_to_main/);
  const sub2 = calls.find((a) => a[3] === 'job' && a[4] === 'submit');
  assert.strictEqual(sub2[sub2.indexOf('--delivery') + 1], 'push_to_main');
  const sent2 = fs.readFileSync(sub2[sub2.indexOf('--ask-file') + 1], 'utf8');
  assert.match(sent2, /Delivery: `push_to_main`/);
  assert.match(sent2, /## Goal\n\nRetry the export on transient storage errors\./, 'same composed content');
  assert.strictEqual(sent2, offer.briefAt(row2.payload, 'push_to_main'));
  const runInsert = store.queries.filter((q) => /insert into run/.test(q.sql)).pop();
  assert.deepStrictEqual([runInsert.params[8], runInsert.params[10]], ['push_to_main', 'explicit'], 'recorded as your pick');
  assert.strictEqual(world.proposals.find((p) => p.id === row2.id).answer, 'delivery=push_to_main');
  await assert.rejects(proposals.decide(99, { accept: true, delivery: 'yolo' }), /unknown delivery/);

  // A Claude-session offer carries its delivery and the mode that enforces it.
  const session = await offer.prepare({ commitmentId: 31, via: 'claude', delivery: 'pr' });
  assert.deepStrictEqual([session.payload.via, session.payload.delivery, session.payload.mode, session.payload.brief], ['claude', 'pr', 'mr', undefined]);
  assert.match(session.body, /Route: Claude session \(mode mr\)/);
  const research = await offer.prepare({ commitmentId: 31, via: 'claude', mode: 'plan' });
  assert.deepStrictEqual([research.payload.delivery, research.payload.mode], [null, 'plan']);
  assert.match(research.body, /read-only research/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('offer ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
