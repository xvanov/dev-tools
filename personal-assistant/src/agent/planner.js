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

const llm = require('../llm');
const { config } = require('../config');
const { rows, one, query } = require('../db');
const { logger } = require('../log');
const P = require('./plannerCore');

const log = logger('planner');

const BATCH = 6;

async function due(limit) {
  const { SELF_NOTE } = require('../commitments/selfNotes');
  return rows(
    `select c.id, c.summary, c.detail, c.repo_path, c.project_id, pr.name as project,
            per.display_name as who, si.source, left(si.body_text, 800) as ask_text
       from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
       left join project pr on pr.id = c.project_id and pr.active
      where c.status = 'open' and c.direction = 'owed_by_me' and c.superseded_by is null
        and c.planned_at is null
        -- Probably done already (a "Looks done?" card waits) or already has a run.
        and not exists (select 1 from ledger_evidence e where e.commitment_id = c.id
                         and e.effect in ('closes','moot') and e.decision is null)
        and not exists (select 1 from run r where r.commitment_id = c.id)
        and si.occurred_at > now() - interval '7 days'
        and not ${SELF_NOTE}
      order by si.occurred_at desc
      limit $1`,
    [limit]
  );
}

async function researchToday() {
  const r = await one(
    `select count(*)::int as n from commitment
      where plan->>'researchRunId' is not null and planned_at >= date_trunc('day', now())`
  );
  return r.n;
}

async function act(p) {
  const c = p.todo;
  const plan = { kind: p.kind, action: p.action, brief: p.brief, at: new Date().toISOString() };
  if (p.action === 'research') {
    const budget = require('../budget');
    const ok = P.mayResearch({
      startedToday: await researchToday(),
      perDay: config.planner.researchPerDay,
      budgetOk: await budget.allow('eager').catch(() => false),
    });
    if (ok) {
      try {
        const run = await require('../dispatch').start({ commitmentId: c.id, task: p.brief, mode: 'plan' });
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
    await require('../proposals').create({
      kind: 'dispatch',
      commitmentId: c.id,
      title: `Start a ${plan.mode === 'plan' ? 'research' : 'coding'} session on: ${c.summary}`.slice(0, 280),
      body: `${p.brief}\n\nIn ${c.project}. ${plan.mode === 'plan' ? 'Read-only: it writes up findings.' : 'Local mode: it commits in its own worktree and never pushes.'}`,
      payload: { mode: plan.mode || 'local' },
      dedupeKey: `offer-run:${c.id}`,
      expiresAt: new Date(Date.now() + 5 * 86400_000),
    });
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
  await query('update commitment set kind = $2, plan = $3, planned_at = now() where id = $1', [c.id, p.kind, plan]);
  return plan;
}

async function pass({ limit = BATCH } = {}) {
  const todos = await due(limit);
  if (!todos.length) return { planned: 0 };
  if (!(await require('../budget').allow('planner').catch(() => false))) return { planned: 0, skipped: 'budget' };

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
    if (!done.has(String(t.id))) await query(`update commitment set kind = 'other', planned_at = now() where id = $1`, [t.id]);
  }
  log.info('planned', { todos: todos.length, ...counts });
  return { planned: todos.length, ...counts };
}

module.exports = { pass, due };
