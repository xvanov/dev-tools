'use strict';

// The planner: the assistant doing things ahead of me (DURABLE.md §2.4).
//
// The board used to wait for me: every ask sat there until I opened it and
// decided what to do. The planner looks at each new open ask once, says what
// kind of work it is (commitment.kind), and acts within strict limits:
//
//   investigate + known repo  → starts a `plan`-mode research run on its own
//                               (reads, writes findings, changes nothing),
//                               at most PA_EAGER_RUNS_PER_DAY a day, and
//                               tells me it did;
//   coding + known repo       → a "start a run?" card in Needs you;
//   no repo, but clearly code → "which repo?" with buttons; my answer sets
//                               the project and the ask is planned again;
//   anything else             → just the kind.
//
// Replies are not its business: chat and mail asks already get a draft
// (src/draft autoDraft). Notes from my own work are skipped, and so is
// anything older than a week — a surprise run on a stale ask is noise — or
// that the reconciler thinks is already done, or that already has a run. One
// model call per batch, and only while the daily budget allows discretionary
// work (src/budget.js).

const llm = require('../llm.ts');
const { config } = require('../config.ts');
const repo = require('../repo');
const { logger } = require('../log.ts');
const P = require('./plannerCore');

const log = logger('planner');

const BATCH = 6;

async function due(limit) {
  return repo.commitments.toPlan(limit);
}

async function researchToday() {
  return repo.commitments.researchStartedToday();
}

async function act(p) {
  const c = p.todo;
  const plan = { kind: p.kind, action: p.action, brief: p.brief, at: new Date().toISOString() };
  if (p.action === 'research') {
    const budget = require('../budget.ts');
    const ok = P.mayResearch({
      startedToday: await researchToday(),
      perDay: config.planner.researchPerDay,
      budgetOk: await budget.allow('eager').catch(() => false),
    });
    if (ok) {
      try {
        // Always a Claude session: plan mode is read-only, and the factory
        // only builds — nothing the planner starts alone may change code.
        const run = await require('../dispatch').start({
          commitmentId: c.id, task: p.brief, mode: 'plan', via: 'claude', routeReason: 'planner research run (read-only)',
        });
        plan.researchRunId = Number(run.id);
        await require('../notify').notify({
          kind: 'info',
          title: `Started research on: ${c.summary}`.slice(0, 200),
          body: `${p.brief}\nRun #${run.id} in ${c.project}, read-only. Open it, or let it finish and read its findings.`,
          url: run.url || null,
          dedupeKey: `research:${c.id}`,
        });
      } catch (err) {
        plan.error = String(err.message).slice(0, 200);
        log.warn('research run not started', { commitment: Number(c.id), message: plan.error });
      }
    } else {
      // Over today's allowance: offered instead of started.
      p.action = 'offer_run';
      plan.action = 'offer_run';
      plan.mode = 'plan';
    }
  }
  if (p.action === 'offer_run') {
    // Everything the card shows is decided now and frozen into the proposal
    // (src/dispatch/offer.js): route, app, the end state, pipeline, models,
    // done-criteria and the composed brief — accepting runs exactly that. A
    // factory job changes code, so it is only ever offered, never started
    // here. The end state is the repo's default (or PA_DELIVERY_DEFAULT): it
    // is never inferred from the ask's text, which someone else wrote.
    const offer = require('../dispatch/offer');
    const useModel = await require('../budget.ts').allow('planner').catch(() => false);
    const o = {
      commitmentId: c.id,
      kind: p.kind,
      via: plan.mode === 'plan' ? 'claude' : 'auto',
      mode: plan.mode === 'plan' ? 'plan' : null,
      useModel,
      why: p.brief,
      dedupeKey: `offer-run:${c.id}`,
      expiresAt: new Date(Date.now() + 5 * 86400_000),
    };
    const row = await offer.propose(o).catch(async (err) => {
      // A route or composition failure still leaves an offer: a Claude session.
      log.warn('offer not prepared; offering a Claude session', { commitment: Number(c.id), message: String(err.message).slice(0, 160) });
      return offer.propose({ ...o, via: 'claude' }).catch(() => null);
    });
    plan.route = row?.payload?.via || 'claude';
    plan.routeReason = row?.payload?.routeReason || null;
    plan.mode = row?.payload?.mode || plan.mode || null;
    plan.delivery = row?.payload?.delivery || null;
  }
  if (p.action === 'ask_repo') {
    await require('../proposals').create({
      kind: 'question',
      commitmentId: c.id,
      title: `Which repo is this in? ${c.summary}`.slice(0, 280),
      options: [...p.repos.map((r) => ({ value: r, label: r })), { value: 'none', label: 'None of these' }],
      payload: { on: 'project' },
      dedupeKey: `ask-repo:${c.id}`,
      expiresAt: new Date(Date.now() + 5 * 86400_000),
    });
  }
  await repo.commitments.setPlan(c.id, p.kind, plan);
  return plan;
}

// What is already known to have happened: the reconciler's "progresses"
// quotes, and my PRs in the ask's repo since it was made. The planner once
// offered a run to build a button that had merged four days earlier.
async function background(todos) {
  const ids = todos.map((t) => t.id);
  const progress = await repo.ledger.progressQuotes(ids);
  const shipped = await repo.commitments.shippedSinceAsk(ids);
  const by = (list, field) => {
    const m = new Map();
    for (const r of list) {
      const k = String(r.commitment_id);
      if (!m.has(k)) m.set(k, []);
      if (m.get(k).length < 8) m.get(k).push(r[field]);
    }
    return m;
  };
  const p = by(progress, 'quote');
  const s = by(shipped, 'subject');
  return todos.map((t) => ({ ...t, progress: p.get(String(t.id)) || [], recentPrs: s.get(String(t.id)) || [] }));
}

async function pass({ limit = BATCH } = {}) {
  let todos = await due(limit);
  if (!todos.length) return { planned: 0 };
  if (!(await require('../budget.ts').allow('planner').catch(() => false))) return { planned: 0, skipped: 'budget' };
  // Judged first: an ask already answered or delivered gets no plan at all.
  await require('../ledger/reconcile').pass({ ids: todos.map((t) => Number(t.id)) }).catch(() => null);
  todos = await due(limit);
  if (!todos.length) return { planned: 0 };
  todos = await background(todos);

  const repos = (await require('../projects').candidates()).map((p) => p.name);
  const { prompt, refs } = P.buildPrompt(todos, repos);
  const reply = await llm.complete({
    system: P.SYSTEM,
    prompt,
    model: config.planner.model,
    effort: 'low',
    maxTokens: 1500,
    purpose: 'planner',
  });
  const plans = P.parsePlans(llm.extractJson(reply), refs, repos);
  const done = new Set();
  const counts = {};
  for (const p of plans) {
    await act(p);
    done.add(String(p.todo.id));
    counts[p.action] = (counts[p.action] || 0) + 1;
  }
  // An ask the model skipped is marked planned too, or it would be asked about forever.
  for (const t of todos) {
    if (!done.has(String(t.id))) await repo.commitments.markPlannedOther(t.id);
  }
  log.info('planned', { todos: todos.length, ...counts });
  return { planned: todos.length, ...counts };
}

module.exports = { pass, due, background };
