'use strict';

// What the model costs, durably, and a ceiling on the part of it that is optional
// (DURABLE.md §2.4, "Cost cap").
//
// Every model call src/llm.js makes leaves an `llm_spend` row: when, for which
// pass (`purpose`), on which model and backend, what it cost, and whether it
// worked. Before this the only record was an in-memory sum that died with the
// process, so nothing could say what yesterday cost, let alone stop tomorrow
// from costing ten times more.
//
// The cap is per local day (PA_DAILY_BUDGET_USD) and splits purposes in two:
//
//  - **essential** — distill, reconcile, connector, reply-close. These keep the
//    board true. They are counted but never refused: a cap that stopped
//    ingesting mail would save money by making the assistant wrong.
//  - **discretionary** — eager, research, digest, planner: work done ahead of
//    me on speculation. Once today's spend reaches the cap, `allow` says no
//    and the worker says so once, in the log.
//
// A purpose in neither list (draft, memory-*, meeting-brief, ...) predates the
// cap and is not gated by it; it still counts towards the total. New
// speculative work must ask `allow(purpose)` before it spends — the cap is
// enforced where the call is decided, not requested of the model.
//
// The rule itself is `decide`, pure and tested (test/budget.test.js). The rest
// is a query and a best-effort insert: recording never throws into a caller.

const { config } = require('./config');
const { logger } = require('./log');

const log = logger('budget');

function db() {
  return require('./db');
}

// ------------------------------------------------------------- the rule ----

// `entry` covers `purpose` exactly or as a dash prefix: 'eager' covers
// 'eager-draft', 'memory' would cover 'memory-extract'.
function matches(list, purpose) {
  const p = String(purpose || '');
  return (list || []).some((e) => p === e || p.startsWith(`${e}-`));
}

// May a call for `purpose` go ahead, with `spent` dollars already spent today
// against `cap`? `essential` is the list of purposes that are never refused
// (or a boolean saying whether this one is); `discretionary` the list that the
// cap applies to. `estimateUsd` is what the caller expects this call to cost,
// so a large speculative job is refused before it overshoots, not after.
function decide({
  spent,
  cap,
  purpose,
  essential = config.budget.essential,
  discretionary = config.budget.discretionary,
  estimateUsd = 0,
}) {
  const isEssential = typeof essential === 'boolean' ? essential : matches(essential, purpose);
  if (isEssential) return true;
  if (!matches(discretionary, purpose)) return true;
  const limit = Number(cap);
  if (cap == null || !Number.isFinite(limit)) return true;
  const total = (Number(spent) || 0) + Math.max(0, Number(estimateUsd) || 0);
  return total < limit;
}

// Local midnight: "today" is my day, not UTC's — at 01:00 the cap
// must have reset, not still count yesterday evening.
function dayStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// Rows of {day, purpose, usd, calls, failed, unknown} → one entry per day,
// newest first, with its purposes by cost. `unknown` counts calls whose cost
// was not reported: a total with many of them is a floor, and says so.
function summarise(rows) {
  const days = new Map();
  for (const r of rows) {
    const day = String(r.day instanceof Date ? isoDay(r.day) : r.day).slice(0, 10);
    if (!days.has(day)) days.set(day, { day, usd: 0, calls: 0, failed: 0, unknown: 0, purposes: [] });
    const d = days.get(day);
    const usd = Number(r.usd) || 0;
    d.usd += usd;
    d.calls += Number(r.calls) || 0;
    d.failed += Number(r.failed) || 0;
    d.unknown += Number(r.unknown) || 0;
    d.purposes.push({ purpose: r.purpose, usd, calls: Number(r.calls) || 0 });
  }
  const out = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const d of out) d.purposes.sort((a, b) => b.usd - a.usd || b.calls - a.calls);
  return out;
}

function isoDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function usd(n) {
  const v = Number(n) || 0;
  return v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

// ----------------------------------------------------------- the store ----

// One row per model call. Best effort by contract: an unmigrated store or a
// dropped connection costs the row, never the caller's result. No prompt or
// reply text is passed in, so none can reach the table or the log.
let recordWarned = false;
async function record({ purpose, model, backend, costUsd = null, inputTokens = null, outputTokens = null, durationMs = null, ok }) {
  try {
    await db().query(
      `insert into llm_spend (purpose, model, backend, cost_usd, input_tokens, output_tokens, duration_ms, ok)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        String(purpose || 'unknown').slice(0, 64),
        model || null,
        backend,
        Number.isFinite(costUsd) ? costUsd : null,
        Number.isFinite(inputTokens) ? Math.round(inputTokens) : null,
        Number.isFinite(outputTokens) ? Math.round(outputTokens) : null,
        Number.isFinite(durationMs) ? Math.round(durationMs) : null,
        Boolean(ok),
      ]
    );
    spentCache = null;
  } catch (err) {
    if (!recordWarned) {
      recordWarned = true;
      log.warn('model spend not recorded — is the store migrated?', { message: err.message });
    }
  }
}

// Dollars recorded since local midnight. Cached briefly: an eager pass may ask
// before every call, and the answer moves by cents.
let spentCache = null;
async function spentToday() {
  const start = dayStart();
  if (spentCache && spentCache.day === start.getTime() && Date.now() - spentCache.at < 15_000) return spentCache.usd;
  const r = await db().one(`select coalesce(sum(cost_usd), 0)::float8 as usd from llm_spend where at >= $1`, [start]);
  const value = Number(r?.usd) || 0;
  spentCache = { day: start.getTime(), at: Date.now(), usd: value };
  return value;
}

// Today's spend by purpose, most expensive first.
async function todayByPurpose() {
  return db().rows(
    `select purpose, coalesce(sum(cost_usd), 0)::float8 as usd, count(*)::int as calls
       from llm_spend where at >= $1
      group by purpose order by usd desc, calls desc`,
    [dayStart()]
  );
}

// The last `days` local days, per day and purpose (`pa spend`).
async function daily({ days = 7 } = {}) {
  const n = Math.max(1, Math.min(366, Number(days) || 7));
  const since = dayStart(new Date(Date.now() - (n - 1) * 86400_000));
  const rows = await db().rows(
    `select to_char((at at time zone $2)::date, 'YYYY-MM-DD') as day, purpose,
            coalesce(sum(cost_usd), 0)::float8 as usd, count(*)::int as calls,
            count(*) filter (where not ok)::int as failed,
            count(*) filter (where cost_usd is null)::int as unknown
       from llm_spend where at >= $1
      group by 1, 2`,
    [since, timeZone()]
  );
  return summarise(rows);
}

// For `pa doctor` and the dashboard.
async function status() {
  const purposes = await todayByPurpose();
  const today = purposes.reduce((s, p) => s + (Number(p.usd) || 0), 0);
  return { today, cap: config.budget.dailyUsd, purposes };
}

// The gate in front of discretionary work. Fails closed for discretionary
// purposes when the store cannot say what was spent: not knowing is not a
// licence to spend more.
let blockedDay = null;
let unknownWarnedAt = 0;
async function allow(purpose, { estimateUsd = 0 } = {}) {
  const cap = config.budget.dailyUsd;
  // Only discretionary purposes are gated; everything else skips the query.
  if (matches(config.budget.essential, purpose) || !matches(config.budget.discretionary, purpose)) return true;
  let spent;
  try {
    spent = await spentToday();
  } catch (err) {
    if (Date.now() - unknownWarnedAt > 600_000) {
      unknownWarnedAt = Date.now();
      log.warn('spend unknown — refusing discretionary work', { purpose, message: err.message });
    }
    return decide({ spent: Infinity, cap, purpose, estimateUsd });
  }
  const ok = decide({ spent, cap, purpose, estimateUsd });
  const day = dayStart().getTime();
  if (!ok && blockedDay !== day) {
    blockedDay = day;
    log.warn('daily model budget reached — discretionary work paused until midnight', {
      spentUsd: Number(spent.toFixed(2)),
      capUsd: cap,
      purpose,
    });
  }
  return ok;
}

module.exports = { decide, matches, dayStart, summarise, usd, record, spentToday, todayByPurpose, daily, status, allow };
