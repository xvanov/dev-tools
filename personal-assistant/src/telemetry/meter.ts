'use strict';

// What the Meter page's model-and-latency panels show (plan 7.5):
//   - latency per hop, p50 / p95, from `trace_span`;
//   - spend per day, per model and per purpose, from `llm_spend`;
//   - the Claude credit pool: used, remaining, when it resets.
// GET /api/meter?days=N (src/dashboard/meter.js) returns report(); termhub's
// Meter page reads it through /pa/api/meter. The maths is pure and tested
// (test/telemetry.test.js); report() is the only part that touches the store, and
// each section fails alone, so a table that is not migrated yet blanks one panel.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Group = { usd: number; calls: number; [label: string]: unknown };

/** Nearest-rank percentile of an ascending-sorted array; null when empty. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

/** Rows of {hop, durationMs, ok} -> per hop {hop, calls, failed, p50, p95, max} (ms), slowest p95 first. */
function summariseHops(rows: Row[]) {
  const by = new Map<unknown, { ms: number[]; failed: number }>();
  for (const r of rows) {
    if (!by.has(r.hop)) by.set(r.hop, { ms: [], failed: 0 });
    const h = by.get(r.hop)!;
    h.ms.push(Number(r.durationMs) || 0);
    if (!r.ok) h.failed++;
  }
  const out: { hop: unknown; calls: number; failed: number; p50: number | null; p95: number | null; max: number | undefined }[] = [];
  for (const [hop, h] of by) {
    h.ms.sort((a, b) => a - b);
    out.push({ hop, calls: h.ms.length, failed: h.failed, p50: percentile(h.ms, 50), p95: percentile(h.ms, 95), max: h.ms[h.ms.length - 1] });
  }
  return out.sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0) || (String(a.hop) < String(b.hop) ? -1 : 1));
}

/**
 * Rows of {day, model, purpose, usd, calls} -> {days, models, purposes, totalUsd}.
 * `days` is newest first; models and purposes are most expensive first. A null
 * model is "unknown".
 */
function summariseSpend(rows: Row[]) {
  const group = (keyOf: (r: Row) => string, label: string) => {
    const m = new Map<string, Group>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = m.get(k) || { [label]: k, usd: 0, calls: 0 };
      g.usd += Number(r.usd) || 0;
      g.calls += Number(r.calls) || 0;
      m.set(k, g);
    }
    return [...m.values()];
  };
  const byCost = (a: Group, b: Group) => b.usd - a.usd || b.calls - a.calls;
  return {
    days: group((r: Row) => String(r.day).slice(0, 10), 'day').sort((a, b) => ((a.day as string) < (b.day as string) ? 1 : -1)),
    models: group((r: Row) => String(r.model || 'unknown'), 'model').sort(byCost),
    purposes: group((r: Row) => String(r.purpose || 'unknown'), 'purpose').sort(byCost),
    totalUsd: rows.reduce((s: number, r: Row) => s + (Number(r.usd) || 0), 0),
  };
}

async function section(fn: () => unknown) {
  try {
    return await fn();
  } catch (err) {
    return { error: String((err as Error).message || err).slice(0, 160) };
  }
}

/** The whole Meter payload for the last `days` local days. */
async function report({ days = 7, now = new Date() }: { days?: number; now?: Date } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const budget = require('../budget');
  const repo = require('../repo');
  const since = budget.dayStart(new Date(now.getTime() - (n - 1) * 86400_000));
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })();
  const [latency, spend, pool, limits] = await Promise.all([
    section(async () => summariseHops(await repo.telemetry.hopDurations(since))),
    section(async () => summariseSpend(await repo.spend.dailyBreakdown(since, tz))),
    section(() => require('../claudePool').status({ now })),
    // Each workflow's cost ceiling per run, as the user set it (dashboard/workflowLimits.js: the one source).
    section(async () => require('../dashboard/workflowLimits.ts').effective(require('../dashboard/architecture.ts').load(), await repo.workflowLimits.all())),
  ]);
  return { days: n, since: since.toISOString(), latency, spend, pool, limits };
}

module.exports = { percentile, summariseHops, summariseSpend, report };
