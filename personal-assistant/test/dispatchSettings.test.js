'use strict';

// A card's dispatch settings (src/dispatch/settings.ts, decision D28): every
// dispatch is a factory job, so a card resolves runtime, mode, end state, job
// kind and app/repo — the start's own choice over the card's stored override
// over the defaults. Pure resolution and patch checks here; the store and the
// factory are not touched. Names are invented.

const assert = require('assert');

const S = require('../src/dispatch/settings.ts');

const apps = [
  { app: 'widget', repo: 'acme/widget', delivery: { default: 'pr' } },
  { app: 'docs', repo: 'acme/docs', delivery: { default: null } },
];
const base = { slug: 'acme/widget', apps, configuredRuntime: 'claude_session', configuredMode: 'full', fallbackDelivery: 'draft_pr' };

// The defaults: claude_session, mode full, the kind from the ask, the end state from the factory app.
{
  const r = S.resolve({ ...base, text: 'Fix the flaky export test' });
  assert.deepStrictEqual(r.settings, { runtime: 'claude_session', mode: 'full', delivery: 'pr', jobKind: 'code', app: 'widget', repo: 'acme/widget' });
  assert.deepStrictEqual(r.source, { mode: 'default', jobKind: 'inferred', runtime: 'default', repo: 'commitment', app: 'repo', delivery: 'app_default' });
  assert.match(r.why.delivery, /factory app widget's delivery.default/);
  assert.strictEqual(r.phrase, null);
}

// An app without a delivery default: the repo's (pa delivery), else PA_DELIVERY_DEFAULT; a fallback never merges.
{
  const docs = { ...base, slug: 'acme/docs', text: 'Fix the typo' };
  assert.deepStrictEqual([S.resolve(docs).settings.delivery, S.resolve(docs).source.delivery], ['draft_pr', 'fallback']);
  assert.deepStrictEqual([S.resolve({ ...docs, repoDefault: 'branch' }).settings.delivery, S.resolve({ ...docs, repoDefault: 'branch' }).source.delivery], ['branch', 'repo_default']);
  assert.strictEqual(S.resolve({ ...docs, fallbackDelivery: 'auto_merge' }).settings.delivery, 'draft_pr');
}

// Your own words for this start may name a level (up to pr); the commitment's text never does.
{
  const said = S.resolve({ ...base, slug: 'acme/docs', text: 'x', operatorText: 'Add retries, ready for review' });
  assert.deepStrictEqual([said.settings.delivery, said.source.delivery], ['pr', 'inferred']);
  assert.ok(said.phrase);
  const third = S.resolve({ ...base, slug: 'acme/docs', text: 'Just push it straight to main', operatorText: null });
  assert.strictEqual(third.settings.delivery, 'draft_pr');
}

// The kind: decided from the ask, plan mode is a plan job, research/report/plan deliver none.
{
  const q = S.resolve({ ...base, text: 'Why does the nightly build take 40 minutes?' });
  assert.deepStrictEqual([q.settings.jobKind, q.settings.delivery, q.source.delivery], ['research', 'none', 'kind']);
  const plan = S.resolve({ ...base, configuredRuntime: 'api', text: 'Fix it', given: { mode: 'plan' } });
  assert.deepStrictEqual([plan.settings.jobKind, plan.settings.runtime, plan.settings.delivery], ['plan', 'claude_session', 'none']);
  assert.strictEqual(plan.why.jobKind, 'plan mode is read-only');
  const planned = S.resolve({ ...base, text: 'why is it slow?', commitmentKind: 'coding' });
  assert.strictEqual(planned.settings.jobKind, 'code', "the planner's kind beats the words");
  assert.strictEqual(S.resolve({ ...base, configuredRuntime: 'api', text: 'Fix it' }).settings.runtime, 'api', 'PA_FACTORY_RUNTIME=api moves code jobs to the API');
}

// Precedence: this start's choice > the card's override > the default.
{
  const stored = { runtime: 'api', delivery: 'branch', jobKind: 'report', app: 'docs' };
  const card = S.resolve({ ...base, text: 'Fix it', stored });
  assert.deepStrictEqual([card.settings.runtime, card.settings.jobKind, card.settings.app, card.settings.delivery], ['api', 'report', 'docs', 'none']);
  assert.deepStrictEqual([card.source.runtime, card.source.jobKind, card.source.app], ['card', 'card', 'card']);
  const code = S.resolve({ ...base, text: 'Fix it', stored: { ...stored, jobKind: 'code' } });
  assert.deepStrictEqual([code.settings.delivery, code.source.delivery], ['branch', 'card']);
  const given = S.resolve({ ...base, text: 'Fix it', stored: { ...stored, jobKind: 'code' }, given: { delivery: 'none', runtime: 'claude_session' } });
  assert.deepStrictEqual([given.settings.delivery, given.source.delivery, given.settings.runtime, given.source.runtime], ['none', 'given', 'claude_session', 'given']);
  // A repo override picks that repo's app; an unknown app name is kept, with no app default.
  assert.strictEqual(S.resolve({ ...base, text: 'Fix it', stored: { repo: 'acme/docs' } }).settings.app, 'docs');
  assert.strictEqual(S.resolve({ ...base, text: 'Fix it', stored: { app: 'ghost' } }).settings.app, 'ghost');
}

// The POST body: only known fields, each checked; null or '' clears one.
{
  assert.deepStrictEqual(S.checkPatch({ runtime: 'claude', mode: 'MR', delivery: 'push-to-main', jobKind: 'Plan', app: 'widget', repo: 'acme/widget' }),
    { runtime: 'claude_session', mode: 'mr', delivery: 'push_to_main', jobKind: 'plan', app: 'widget', repo: 'acme/widget' });
  assert.deepStrictEqual(S.checkPatch({ runtime: null, delivery: '' }), { runtime: null, delivery: null });
  assert.throws(() => S.checkPatch({ via: 'claude' }), /unknown dispatch setting "via"/);
  assert.throws(() => S.checkPatch({ mode: 'yolo' }), /unknown mode/);
  assert.throws(() => S.checkPatch({ jobKind: 'poem' }), /unknown kind/);
  assert.throws(() => S.checkPatch({ app: 'a b; rm' }), /not a factory app name/);
  assert.throws(() => S.checkPatch([]), /object/);
}

// The options the page picks from.
{
  const o = S.options(apps);
  assert.deepStrictEqual(o.runtimes, ['api', 'claude_session']);
  assert.deepStrictEqual(o.jobKinds, ['code', 'research', 'report', 'plan']);
  assert.ok(o.modes.includes('full') && o.modes.includes('plan'));
  assert.deepStrictEqual(o.apps[0], { app: 'widget', repo: 'acme/widget', deliveryDefault: 'pr' });
  assert.ok(o.deliveries.every((d) => d.value && d.plain));
}

console.log('dispatchSettings ok');
