'use strict';

// The end state of a piece of work (src/dispatch/deliveryCore.js,
// delivery.js, index.sessionDelivery) and what the PA does with it when a
// Claude session ends (src/durable/tasks/runReview.js). Store, git and gh are
// stubbed; names are invented.

const assert = require('assert');
const path = require('path');

process.env.PA_DELIVERY_DEFAULT = 'draft_pr';
const D = require('../src/dispatch/deliveryCore');

// --- the vocabulary -----------------------------------------------------------------

assert.deepStrictEqual(D.DELIVERIES, ['none', 'branch', 'draft_pr', 'pr', 'auto_merge', 'push_to_main'], 'the factory\'s order (JOBS-API.md)');
assert.strictEqual(D.delivery('Draft PR'), 'draft_pr');
assert.strictEqual(D.delivery('push-to-main'), 'push_to_main');
assert.strictEqual(D.delivery('auto-merge'), 'auto_merge');
assert.throws(() => D.delivery('yolo'), /unknown delivery/);
assert.deepStrictEqual(D.DELIVERIES.filter(D.unattended), ['auto_merge', 'push_to_main']);
// Plain words; the unattended two say so outright.
assert.match(D.describe('auto_merge'), /merge to main automatically/);
assert.match(D.describe('push_to_main'), /straight to main/);
assert.match(D.describe('push_to_main', { route: 'claude' }), /when the session ends.*no gates/);
assert.match(D.describe('none'), /nothing is pushed/);
for (const d of D.DELIVERIES) assert.ok(D.describe(d).length > 10, d);

// Legacy modes, read as levels; levels mapped to the session's enforced mode.
assert.deepStrictEqual(['local', 'branch', 'mr', 'full', 'plan'].map(D.deliveryForMode), ['none', 'branch', 'draft_pr', 'draft_pr', null]);
assert.deepStrictEqual(D.DELIVERIES.map(D.modeFor), ['local', 'branch', 'mr', 'mr', 'mr', 'local']);
assert.strictEqual(D.modeFor('push_to_main'), 'local', 'the agent can never push to main itself; only the PA\'s end step does');

// --- inference from the operator's own words ---------------------------------------

const said = (t) => D.infer(t)?.delivery || null;
assert.strictEqual(said('fix the export, just open a draft'), 'draft_pr');
assert.strictEqual(said('fix it and merge it'), 'auto_merge');
assert.strictEqual(said('merge when green'), 'auto_merge');
assert.strictEqual(said('auto-merge this one'), 'auto_merge');
assert.strictEqual(said('push straight to main'), 'push_to_main');
assert.strictEqual(said('commit directly to master please'), 'push_to_main');
assert.strictEqual(said("don't push, I want to look first"), 'none');
assert.strictEqual(said('keep it local'), 'none');
assert.strictEqual(said('just push the branch'), 'branch');
assert.strictEqual(said('push a branch, no PR'), 'branch');
assert.strictEqual(said('open a PR for review'), 'pr');
assert.strictEqual(said('open a PR, not a draft'), 'pr', 'negated draft');
assert.strictEqual(said("open a PR but don't merge it"), 'pr', 'negated merge is not auto_merge');
assert.strictEqual(said("don't push to main"), 'none', 'negated push_to_main');
assert.strictEqual(said('rename the export function'), null, 'nothing said');
assert.strictEqual(said(''), null);
assert.strictEqual(said(null), null);
assert.deepStrictEqual(D.infer('ok, merge it when CI passes'), { delivery: 'auto_merge', phrase: 'merge it when' });

// --- resolution order: explicit > mode > words > repo default > fallback -------------

assert.deepStrictEqual(D.choose({ explicit: 'pr', mode: 'local', operatorText: 'merge it', repoDefault: 'none' }), { delivery: 'pr', source: 'explicit', phrase: null });
assert.deepStrictEqual(D.choose({ mode: 'local', operatorText: 'merge it', repoDefault: 'pr' }), { delivery: 'none', source: 'mode', phrase: null });
assert.strictEqual(D.choose({ operatorText: 'merge it', repoDefault: 'none' }).source, 'inferred');
assert.deepStrictEqual(D.choose({ operatorText: 'add retries', repoDefault: 'branch' }), { delivery: 'branch', source: 'repo_default', phrase: null });
assert.deepStrictEqual(D.choose({ repoDefault: 'garbage', fallback: 'pr' }), { delivery: 'pr', source: 'fallback', phrase: null });
assert.deepStrictEqual(D.choose({}), { delivery: 'draft_pr', source: 'fallback', phrase: null }, 'nothing at all: a draft PR');
assert.strictEqual(D.choose({ fallback: 'bogus' }).delivery, 'draft_pr');
assert.match(D.sourceLine('inferred', 'merge it'), /your words: "merge it"/);
assert.match(D.sourceLine('repo_default', null, 'acme/widget'), /acme\/widget/);

// --- what the PA does when a session ends -------------------------------------------

assert.deepStrictEqual(D.finishPlan('none'), { push: false, pr: null, ready: false, merge: false, toMain: false });
assert.deepStrictEqual(D.finishPlan('branch'), { push: true, pr: null, ready: false, merge: false, toMain: false });
assert.deepStrictEqual(D.finishPlan('draft_pr'), { push: true, pr: 'draft', ready: false, merge: false, toMain: false });
assert.deepStrictEqual(D.finishPlan('pr'), { push: true, pr: 'draft', ready: true, merge: false, toMain: false });
assert.deepStrictEqual(D.finishPlan('auto_merge'), { push: true, pr: 'draft', ready: true, merge: true, toMain: false });
assert.deepStrictEqual(D.finishPlan('push_to_main'), { push: false, pr: null, ready: false, merge: false, toMain: true });
assert.strictEqual(D.finishPlan(null), null, 'a run from before delivery levels keeps the old behaviour');

// --- stubs: the store, git/gh, notify ------------------------------------------------

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const store = { queries: [], repoDefaults: {}, run: null };
stub('db', {
  async one(sql, params) {
    store.queries.push({ sql, params });
    if (/from repo_delivery/.test(sql)) return store.repoDefaults[params[0]] ? { delivery: store.repoDefaults[params[0]] } : null;
    if (/from run where id/.test(sql)) return store.run;
    if (/from commitment where id/.test(sql)) return { id: params[0], summary: 'Add retries', source_item_id: 1, repo_path: null, project_id: 9 };
    if (/from project where id/.test(sql)) return { id: 9, name: 'widget', gitlab_path: 'acme/widget' };
    if (/from source_item where id/.test(sql)) return { id: 1, body_text: 'please push it straight to main' };
    return null;
  },
  async rows() { return []; },
  async query(sql, params) {
    store.queries.push({ sql, params });
    if (/insert into repo_delivery/.test(sql)) store.repoDefaults[params[0]] = params[1];
    if (/delete from repo_delivery/.test(sql)) {
      const had = Boolean(store.repoDefaults[params[0]]);
      delete store.repoDefaults[params[0]];
      return { rowCount: had ? 1 : 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  },
});
const notes = [];
stub('notify', { async notify(n) { notes.push(n); return { id: notes.length }; } });

const store2 = require('../src/dispatch/delivery');
const dispatch = require('../src/dispatch');

async function repoDefaults() {
  assert.deepStrictEqual(await store2.setDefault('Acme/Widget.git', 'auto-merge'), { repo: 'acme/widget', delivery: 'auto_merge' });
  assert.strictEqual(await store2.defaultFor('ACME/widget'), 'auto_merge');
  await assert.rejects(store2.setDefault('acme/widget', 'merge everything'), /unknown delivery/);
  await assert.rejects(store2.setDefault('not a repo', 'pr'), /owner\/name/);
  // The repo's default applies when nothing was said…
  assert.deepStrictEqual(await store2.resolve({ operatorText: 'add retries', slug: 'acme/widget' }), { delivery: 'auto_merge', source: 'repo_default', phrase: null });
  // …and never over the operator's own words or an explicit choice.
  assert.strictEqual((await store2.resolve({ operatorText: 'just open a draft', slug: 'acme/widget' })).delivery, 'draft_pr');
  assert.strictEqual((await store2.resolve({ explicit: 'none', slug: 'acme/widget' })).delivery, 'none');
  assert.strictEqual(await store2.clearDefault('acme/widget'), true);
  assert.deepStrictEqual(await store2.resolve({ slug: 'acme/widget' }), { delivery: 'draft_pr', source: 'fallback', phrase: null });
}

async function sessionDelivery() {
  const sd = (o) => dispatch.sessionDelivery({ modeName: undefined, delivery: null, task: null, commitmentId: null, repoPath: null, ...o });
  // Plan mode delivers nothing; it cannot be asked to.
  assert.deepStrictEqual(await sd({ modeName: 'plan' }), { mode: 'plan', delivery: null, source: null, phrase: null });
  await assert.rejects(sd({ modeName: 'plan', delivery: 'pr' }), /read-only/);
  // A delivery picks the session's enforced mode.
  assert.deepStrictEqual(await sd({ delivery: 'push_to_main' }), { mode: 'local', delivery: 'push_to_main', source: 'explicit', phrase: null });
  assert.strictEqual((await sd({ delivery: 'auto_merge' })).mode, 'mr');
  assert.strictEqual((await sd({ delivery: 'none' })).mode, 'local');
  // An explicit mode keeps its old meaning…
  assert.deepStrictEqual(await sd({ modeName: 'branch' }), { mode: 'branch', delivery: 'branch', source: 'mode', phrase: null });
  // …and a mode that pushes cannot carry `none`.
  await assert.rejects(sd({ modeName: 'mr', delivery: 'none' }), /pushes, but the delivery is `none`/);
  // The operator's words in --task.
  assert.deepStrictEqual(await sd({ task: 'fix the typo and push straight to main' }), { mode: 'local', delivery: 'push_to_main', source: 'inferred', phrase: 'push straight to main' });
  // A commitment: the third party's message ("push it straight to main") is never read for it;
  // the repo default (none set) → fallback.
  const fromAsk = await sd({ commitmentId: 5 });
  assert.deepStrictEqual([fromAsk.delivery, fromAsk.source], ['draft_pr', 'fallback'], 'someone else\'s words never pick the end state');
  store.repoDefaults['acme/widget'] = 'branch';
  assert.deepStrictEqual([(await sd({ commitmentId: 5 })).delivery, (await sd({ commitmentId: 5 })).source], ['branch', 'repo_default']);
  delete store.repoDefaults['acme/widget'];
}

// --- run_review carries out the recorded delivery -------------------------------------

async function runReview() {
  const merge = require('../src/dispatch/merge');
  const did = [];
  merge.ready = async (url) => did.push(['ready', url]);
  merge.merge = async (url) => did.push(['merge', url]);
  merge.checks = async () => 'pass';
  merge.slugOf = async () => 'acme/widget';
  merge.mayMerge = () => false; // not one of "my" repos: only an explicit auto_merge may merge
  dispatch.review = async () => ({ commits: 'abc1 add retries', stat: '1 file', uncommitted: 0 });
  dispatch.land = async (id, o) => { did.push(['land', o.openMr]); return { mrUrl: o.openMr ? 'https://github.com/acme/widget/pull/5' : null }; };
  dispatch.pushToMain = async () => { did.push(['main']); return { pushed: true, base: 'main' }; };
  const task = require('../src/durable/tasks/runReview');
  const ctx = {
    awaitEvent: async () => ({ note: null }),
    step: async (_name, fn) => fn(),
    sleepFor: async () => {},
  };
  const os = require('os');
  const go = async (delivery, mode = D.modeFor(delivery)) => {
    did.length = 0;
    store.run = { id: 1, status: 'done', mode, task: 'Add retries', commitment_id: null, machine: os.hostname(), mr_url: null, delivery, repo_path: '/r' };
    const r = await task.run({ runId: 1 }, ctx);
    return [r.result, did.map((d) => d.join(':'))];
  };
  assert.deepStrictEqual(await go('none'), ['kept local', []], 'none pushes nothing');
  assert.deepStrictEqual(await go('branch'), ['landed', ['land:false']]);
  assert.deepStrictEqual(await go('draft_pr'), ['landed', ['land:true']], 'a draft is never readied');
  assert.deepStrictEqual(await go('pr'), ['ready', ['land:true', 'ready:https://github.com/acme/widget/pull/5']], 'ready, never merged');
  assert.deepStrictEqual(await go('auto_merge'), ['merged', ['land:true', 'ready:https://github.com/acme/widget/pull/5', 'merge:https://github.com/acme/widget/pull/5']], 'the operator chose it: merged in any repo');
  assert.deepStrictEqual(await go('push_to_main'), ['pushed to main', ['main']]);
  // A run from before delivery levels: a draft, and merged only on PA_MERGE_REPOS.
  assert.deepStrictEqual(await go(null, 'local'), ['landed', ['land:true']]);
  // A run on this machine records its hostname; only another machine's is skipped.
  did.length = 0;
  store.run = { id: 1, status: 'done', mode: 'mr', task: 't', machine: 'some-other-box', delivery: 'pr' };
  const { config } = require('../src/config');
  config.termhub.machines['some-other-box'] = { name: 'some-other-box', url: 'http://x' };
  assert.deepStrictEqual((await task.run({ runId: 1 }, ctx)).result, 'nothing to land');
  // A failing check never merges, even on auto_merge.
  merge.checks = async () => 'fail';
  assert.deepStrictEqual((await go('auto_merge'))[0], 'not merged');
}

(async () => {
  await repoDefaults();
  await sessionDelivery();
  await runReview();
  console.log('delivery ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
