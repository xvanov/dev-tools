'use strict';

// Routines: recurring typed actions on a cron schedule.
//
//   words ──parse──▶ preview (plain words + next 3 runs) ──you confirm──▶ routine
//   worker, every 60 s: active routines with next_run_at <= now, one at a time
//   each run ──▶ routine_run row + notify(kind 'routine')
//
// Scheduling is a query, like everything in this tool. A routine's
// `next_run_at` is moved to its next future slot *before* it runs, computed
// from now — so after a day of downtime a daily routine runs once, not once
// per missed day, and a crash mid-run cannot make it run twice.
//
// One routine at a time across every process (the worker, the dashboard, a
// `pa routine run` in a terminal): a Postgres advisory lock held for the run.

const db = require('../db');
const { logger } = require('../log');
const cron = require('./cron');
const actions = require('./actions');

const log = logger('routines');
const LOCK_KEY = 7301;
const PARSE_MODEL = 'claude-sonnet-5-5';

// ------------------------------------------------------------ preview ----

function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The one sentence a routine is shown as: "Weekdays 08:00 — Pull main on …". */
function plainWords(r) {
  let what;
  try {
    what = actions.describe(r.action, r.params);
  } catch (err) {
    what = `${r.action} (${err.message})`;
  }
  return `${cron.describe(r.schedule)} — ${what}`;
}

/**
 * Validates a candidate routine and shows it back: the plain-words sentence,
 * what it changes on the machine, and the next three run times. Throws with a
 * readable message on anything invalid. Nothing is written.
 */
function preview({ title, schedule, action, params, description = '' }, { now = new Date() } = {}) {
  const a = actions.get(action);
  const clean = actions.validateParams(action, params);
  const sched = cron.parse(schedule).source;
  const next = cron.upcoming(sched, 3, now);
  if (!next.length) throw new Error(`"${schedule}" never runs`);
  const t = String(title || '').trim().slice(0, 80) || a.name;
  return {
    title: t,
    description: String(description || '').slice(0, 2000),
    schedule: sched,
    action: a.name,
    params: clean,
    plain: plainWords({ schedule: sched, action: a.name, params: clean }),
    changes: a.changes,
    nextRuns: next.map((d) => d.toISOString()),
  };
}

const PARSE_SYSTEM = `You turn a person's request for a recurring task into a routine for their personal assistant.

Choose the action ONLY from the catalog you are given. If no action in the catalog does what they asked,
reply {"error": "<one short sentence saying what is not supported>"} — never stretch an action to fit.

The schedule is a standard 5-field cron expression in the person's LOCAL time:
minute hour day-of-month month day-of-week (0 = Sunday, 1-5 = Monday-Friday).
Vague times: "first thing in the morning" / "morning" = 08:00, "lunchtime" = 12:00, "end of day" = 17:00,
"evening" = 19:00, "night" = 22:00. "weekday" = 1-5. No day given = every day.

Reply with ONLY JSON:
{"title": "<at most 60 characters>", "schedule": "<cron>", "action": "<catalog name>", "params": { ... }}
Only include params the request actually specifies; defaults fill the rest.`;

/** Plain words → preview. A model call; nothing is saved. */
async function parseWords(words, { now = new Date() } = {}) {
  const text = String(words || '').trim();
  if (!text) throw new Error('say what the routine should do and when');
  const { complete, extractJson } = require('../llm');
  const prompt = [
    `Now (local): ${now.toString()}`,
    `Catalog:\n${JSON.stringify(actions.catalog(), null, 2)}`,
    `Request:\n${text.slice(0, 1000)}`,
  ].join('\n\n');
  const reply = await complete({ system: PARSE_SYSTEM, prompt, model: PARSE_MODEL, effort: 'low', timeoutMs: 120_000, purpose: 'routine' });
  const parsed = extractJson(reply);
  if (parsed.error) throw new Error(`not a routine I can run: ${parsed.error}`);
  return preview({ ...parsed, description: text }, { now });
}

// -------------------------------------------------------------- store ----

async function create(input, { origin = 'user', status = 'active', why = null, evidence = [], now = new Date() } = {}) {
  const p = preview(input, { now });
  const active = status === 'active';
  return db.one(
    `insert into routine (title, description, schedule, action, params, enabled, origin, status, why, evidence, next_run_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [p.title, p.description, p.schedule, p.action, p.params, active, origin, status, why, JSON.stringify(evidence),
      active ? cron.next(p.schedule, now) : null]
  );
}

async function getRoutine(id) {
  const r = await db.one('select * from routine where id = $1', [Number(id)]);
  if (!r) throw new Error(`no routine #${id}`);
  return r;
}

async function list({ statuses = null } = {}) {
  const where = statuses ? 'where r.status = any($1)' : '';
  return db.rows(
    `select r.*, lr.id as last_run_id, lr.ok as last_ok, lr.summary as last_summary, lr.ended_at as last_ended_at,
            lr.dry_run as last_dry_run, (lr.id is not null and lr.ended_at is null) as running
       from routine r
       left join lateral (select * from routine_run x where x.routine_id = r.id
                           order by x.started_at desc limit 1) lr on true
       ${where}
      order by case r.status when 'proposed' then 0 when 'active' then 1 when 'paused' then 2 else 3 end, r.id`,
    statuses ? [statuses] : []
  );
}

async function history({ routineId = null, limit = 30 } = {}) {
  return db.rows(
    `select x.*, r.title, r.action from routine_run x join routine r on r.id = x.routine_id
      ${routineId ? 'where x.routine_id = $2' : ''}
      order by x.started_at desc limit $1`,
    routineId ? [limit, Number(routineId)] : [limit]
  );
}

const TRANSITIONS = {
  accept: { from: ['proposed'], to: 'active' },
  reject: { from: ['proposed'], to: 'rejected' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
};

/** accept | reject | pause | resume. Only a human calls these. */
async function setStatus(id, verb, { now = new Date() } = {}) {
  const t = TRANSITIONS[verb];
  if (!t) throw new Error(`unknown routine verb "${verb}"`);
  const r = await getRoutine(id);
  if (!t.from.includes(r.status)) throw new Error(`routine #${r.id} is ${r.status}; cannot ${verb} it`);
  const active = t.to === 'active';
  return db.one(
    `update routine set status = $2, enabled = $3, next_run_at = $4 where id = $1 returning *`,
    [r.id, t.to, active, active ? cron.next(r.schedule, now) : null]
  );
}

// Deleting a suggestion marks it rejected instead, so the nightly pass never
// proposes the same thing again.
async function remove(id) {
  const r = await getRoutine(id);
  if (r.origin === 'suggested') {
    await db.query(`update routine set status = 'rejected', enabled = false, next_run_at = null where id = $1`, [r.id]);
    return { id: r.id, deleted: false, status: 'rejected' };
  }
  await db.query('delete from routine where id = $1', [r.id]);
  return { id: r.id, deleted: true };
}

// ---------------------------------------------------------------- run ----

async function withLock(fn) {
  const client = await db.getPool().connect();
  try {
    const { rows } = await client.query('select pg_try_advisory_lock($1) as ok', [LOCK_KEY]);
    if (!rows[0].ok) {
      const err = new Error('another routine is running — try again when it finishes');
      err.status = 409;
      throw err;
    }
    try {
      // Holding the lock means nothing else is running: an open run row is
      // one a crash left behind.
      await client.query(
        `update routine_run set ended_at = now(), ok = false, summary = 'interrupted (the process running it stopped)'
          where ended_at is null`
      );
      return await fn();
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

function numbered(lines, max = 25) {
  const shown = lines.slice(0, max).map((l, i) => `${i + 1}. ${l}`);
  if (lines.length > max) shown.push(`… and ${lines.length - max} more in the dashboard`);
  return shown.join('\n');
}

/**
 * Runs one routine now. `dryRun` asks the action what it would do and changes
 * nothing (repo_sync still fetches — remote-tracking refs only — unless
 * `fetch: false`). `onStarted(run)` fires once the run row exists, so the
 * dashboard can answer before a long action finishes.
 */
async function runRoutine(id, { dryRun = false, fetch = true, onStarted = null, scheduled = false } = {}) {
  const r = await getRoutine(id);
  if (!scheduled && r.status === 'rejected') throw new Error(`routine #${r.id} was rejected; accept it first`);
  return withLock(async () => {
    const run = await db.one(
      `insert into routine_run (routine_id, dry_run) values ($1, $2) returning *`,
      [r.id, dryRun]
    );
    if (onStarted) onStarted(run);
    const t0 = Date.now();
    let result;
    try {
      const a = actions.get(r.action);
      const params = actions.validateParams(r.action, r.params);
      result = await a.run(params, { dryRun, fetch, routine: r });
    } catch (err) {
      log.warn('routine failed', { id: r.id, action: r.action, message: err.message });
      result = { ok: false, summary: `failed: ${err.message}`, lines: [], notable: true, detail: { error: err.message } };
    }
    const summary = `${dryRun ? 'dry run: ' : ''}${result.summary}`;
    const done = await db.one(
      `update routine_run set ended_at = now(), ok = $2, summary = $3, detail = $4 where id = $1 returning *`,
      [run.id, result.ok !== false, summary.slice(0, 1000), { ...(result.detail || {}), lines: result.lines || [], ms: Date.now() - t0 }]
    );
    if (!dryRun) {
      await db.query('update routine set last_run_at = now() where id = $1', [r.id]);
      try {
        const { notify, dashboardUrl } = require('../notify');
        await notify({
          kind: 'routine',
          title: `${r.title}: ${result.summary}`,
          body: numbered(result.lines || []),
          url: dashboardUrl('routines'),
          dedupeKey: `routine-run:${run.id}`,
          // A quiet run is still in the feed; it just does not pop up.
          toast: result.notable !== false,
        });
      } catch (err) {
        log.warn('notify failed', { id: r.id, message: err.message });
      }
    }
    log.info('routine ran', { id: r.id, action: r.action, dryRun, ok: done.ok, ms: Date.now() - t0 });
    return { ...done, lines: result.lines || [] };
  });
}

/**
 * The worker pass. Claims each due routine by moving `next_run_at` to its next
 * future slot (a compare-and-set, so two passes cannot both take it), then runs
 * it. Downtime therefore costs at most one catch-up run per routine.
 */
async function runDue({ now = () => new Date() } = {}) {
  const due = await db.rows(
    `select id, schedule, next_run_at from routine
      where status = 'active' and enabled and next_run_at is not null and next_run_at <= now()
      order by next_run_at`
  );
  let ran = 0;
  for (const r of due) {
    let next = null;
    try {
      next = cron.next(r.schedule, now());
    } catch (err) {
      log.warn('bad schedule', { id: r.id, message: err.message });
    }
    if (!next) {
      await db.query(`update routine set status = 'paused', enabled = false, next_run_at = null where id = $1`, [r.id]);
      log.warn('routine paused: its schedule never runs again', { id: r.id });
      continue;
    }
    const claimed = await db.one(
      `update routine set next_run_at = $2 where id = $1 and next_run_at = $3 returning id`,
      [r.id, next, r.next_run_at]
    );
    if (!claimed) continue;
    try {
      await runRoutine(r.id, { scheduled: true });
      ran++;
    } catch (err) {
      // Lock busy (a manual run): put it back so the next pass takes it.
      if (err.status === 409) await db.query('update routine set next_run_at = $2 where id = $1', [r.id, r.next_run_at]);
      log.warn('scheduled run did not happen', { id: r.id, message: err.message });
    }
  }
  return { due: due.length, ran };
}

module.exports = {
  preview,
  parseWords,
  plainWords,
  create,
  getRoutine,
  list,
  history,
  setStatus,
  remove,
  runRoutine,
  runDue,
  stableJson,
  numbered,
  actions,
  cron,
};
