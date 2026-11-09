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
  assert.deepStrictEqual(r.settings, {
    runtime: 'claude_session', mode: 'full', delivery: 'pr', jobKind: 'code', app: 'widget', repo: 'acme/widget',
    review: 'auto', budgetUsd: '30', wallClockH: '4', maxRounds: '20',
  });
  assert.deepStrictEqual(r.source, {
    mode: 'default', jobKind: 'inferred', runtime: 'default', repo: 'commitment', app: 'repo', delivery: 'app_default',
    review: 'default', budgetUsd: 'default', wallClockH: 'default', maxRounds: 'default',
  });
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

// JOBS-API v1.9: review and the job caps. The factory app's defaults, else auto / $30 / 4 h / 20;
// the card's and this start's choices win; only those are sent (policyArgs).
{
  const withPolicy = [{ app: 'widget', repo: 'acme/widget', delivery: { default: 'auto_merge' }, review: { default: 'on' }, caps: { budget_usd: 12, wall_clock_h: 2, max_rounds: 8 } }];
  const r = S.resolve({ ...base, apps: withPolicy, text: 'Fix the export' });
  assert.deepStrictEqual([r.settings.review, r.source.review], ['on', 'app_default']);
  assert.deepStrictEqual([r.settings.budgetUsd, r.settings.wallClockH, r.settings.maxRounds], ['12', '2', '8']);
  assert.strictEqual(r.source.budgetUsd, 'app_default');
  assert.deepStrictEqual(S.policyArgs(r), { review: null, caps: null }, 'app defaults are the factory\'s to apply');

  const card = S.resolve({ ...base, apps: withPolicy, text: 'x', stored: { review: 'off', budgetUsd: '50' }, given: { maxRounds: '0' } });
  assert.deepStrictEqual([card.settings.review, card.source.review, card.settings.budgetUsd, card.source.budgetUsd], ['off', 'card', '50', 'card']);
  assert.deepStrictEqual(S.policyArgs(card), { review: 'off', caps: { budget_usd: 50, max_rounds: 0 } });

  // A report job has no review step: never sent, shown as set by the kind.
  const rep = S.resolve({ ...base, text: 'x', stored: { review: 'on', jobKind: 'research' } });
  assert.deepStrictEqual([rep.settings.review, rep.source.review], [null, 'kind']);
  assert.strictEqual(S.policyArgs(rep).review, null);

  // Checked like every field; round-trips through checkPatch.
  assert.deepStrictEqual(S.checkPatch({ review: 'AUTO', budgetUsd: '$25', wallClockH: '1.5', maxRounds: '10' }),
    { review: 'auto', budgetUsd: '25', wallClockH: '1.5', maxRounds: '10' });
  assert.deepStrictEqual(S.checkPatch({ review: null, budgetUsd: '' }), { review: null, budgetUsd: null });
  assert.throws(() => S.checkPatch({ review: 'maybe' }), /unknown review/);
  assert.throws(() => S.checkPatch({ budgetUsd: '-1' }), /0 or more/);
  assert.throws(() => S.checkPatch({ maxRounds: '2.5' }), /whole number/);
  const o = S.options([]);
  assert.deepStrictEqual(o.reviews, ['off', 'on', 'auto']);
  assert.ok(o.budgetsUsd.includes(30) && o.wallClocksH.includes(4) && o.maxRounds.includes(20));
}

// The one failover policy (src/dispatch/failover.ts): off by default, threshold, always says why.
{
  const FO = require('../src/dispatch/failover.ts');
  const now = new Date('2026-11-09T10:00:00Z');
  const in5h = new Date('2026-11-09T15:00:00Z');
  assert.deepStrictEqual(FO.decide({ requested: 'claude_session', limitedUntil: null, now, enabled: true }),
    { runtime: 'claude_session', fellBack: false, reason: null, waitMin: null });
  const off = FO.decide({ requested: 'claude_session', limitedUntil: in5h, now, enabled: false });
  assert.deepStrictEqual([off.runtime, off.fellBack], ['claude_session', false]);
  assert.match(off.reason, /failover is off/);
  const on = FO.decide({ requested: 'claude_session', limitedUntil: in5h, now, enabled: true, minWaitMin: 30, why: 'Claude limit' });
  assert.deepStrictEqual([on.runtime, on.fellBack, on.waitMin], ['api', true, 300]);
  assert.match(on.reason, /failed over from claude_session to api/);
  const soon = FO.decide({ requested: 'claude_session', limitedUntil: new Date('2026-11-09T10:20:00Z'), now, enabled: true, minWaitMin: 30 });
  assert.deepStrictEqual([soon.runtime, soon.fellBack], ['claude_session', false]);
  assert.match(soon.reason, /under the failover threshold/);
  assert.strictEqual(FO.decide({ requested: 'api', limitedUntil: 'unknown', now, enabled: true }).runtime, 'claude_session');
  assert.strictEqual(FO.decide({ requested: 'api', limitedUntil: new Date('2026-11-09T09:00:00Z'), now, enabled: true }).fellBack, false);
}

console.log('dispatch settings v1.9: ok');

