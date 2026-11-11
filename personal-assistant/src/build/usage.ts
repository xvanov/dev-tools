'use strict';

// Live Claude subscription limits for the Build board: the 5-hour session, the
// weekly limit, the weekly Fable-scoped limit (each with its reset time) and the
// extra-usage credits. Source: GET https://api.anthropic.com/api/oauth/usage with
// Claude Code's own OAuth token (claudeAiOauth.accessToken in
// ~/.claude/.credentials.json). The endpoint is undocumented, so every field is
// optional and a failure is {ok: false} — the board shows "unavailable", never an
// error. The token is re-read on each fetch (Claude Code refreshes the file), is
// sent only to that URL, and is never logged or returned.
//
//   usage() → {ok, meters: [{kind, label, percent, resets_at, severity, model}], extra, fetched_at}
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS.

type Json = import('../types.ts').Json;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { logger } = require('../log.ts');

const log = logger('build');
const URL_USAGE = 'https://api.anthropic.com/api/oauth/usage';
// The endpoint rate-limits hard (a 15 s poll got 429s within minutes, and it
// kept answering 429 with Retry-After: 0 for 10+ min): a minute between calls;
// after each 429 in a row the wait doubles from 2 min up to 30 min, serving the
// last good numbers marked stale meanwhile. The last good answer is kept on
// disk so a redeploy does not start blind.
const TTL_MS = 60_000;
const BACKOFF_MS = 120_000;
const BACKOFF_MAX_MS = 30 * 60_000;
let strikes = 0;
const lastFile = () => process.env.PA_USAGE_CACHE || path.join(require('../config.ts').config.dataDir, 'usage-last.json');
function readLast(): Json | null {
  try {
    const v = JSON.parse(fs.readFileSync(lastFile(), 'utf8'));
    return v && v.ok ? v : null;
  } catch {
    return null;
  }
}
function writeLast(v: Json) {
  try {
    fs.writeFileSync(lastFile(), JSON.stringify(v));
  } catch {
    /* a convenience only */
  }
}
const TIMEOUT_MS = 8_000;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.max(0, Math.round(n * 10) / 10);
};
const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

const LABEL: Record<string, string> = { session: '5-hour session', weekly_all: 'Weekly', weekly_scoped: 'Weekly' };
const ORDER = ['session', 'weekly_all', 'weekly_scoped'];

/** Pure: severity from a percent when the payload has none. */
function severityOf(percent: number | null, given: unknown): string {
  if (typeof given === 'string' && given) return given;
  if (percent == null) return 'normal';
  return percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal';
}

/**
 * Pure: the usage payload → {meters, extra}. Reads `limits[]` first, and falls
 * back to five_hour / seven_day when `limits` is missing or lacks them. Anything
 * malformed is skipped; a non-object yields no meters.
 */
function parseUsage(raw: unknown): { meters: Json[]; extra: Json | null } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Json;
  const meters: Json[] = [];
  const seen = new Set<string>();
  for (const l of Array.isArray(o.limits) ? o.limits : []) {
    if (!l || typeof l !== 'object' || !ORDER.includes(l.kind)) continue;
    const percent = pct(l.percent);
    if (percent == null) continue;
    const model = typeof l.scope?.model?.display_name === 'string' ? l.scope.model.display_name : null;
    const key = `${l.kind}:${model || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    meters.push({
      kind: l.kind,
      label: l.kind === 'weekly_scoped' ? `Weekly ${model || 'scoped'}` : LABEL[l.kind],
      percent, resets_at: iso(l.resets_at), severity: severityOf(percent, l.severity), model,
    });
  }
  for (const [kind, field] of [['session', 'five_hour'], ['weekly_all', 'seven_day']] as const) {
    if (meters.some((m) => m.kind === kind)) continue;
    const w = o[field];
    const percent = pct(w?.utilization);
    if (percent != null) meters.push({ kind, label: LABEL[kind], percent, resets_at: iso(w.resets_at), severity: severityOf(percent, null), model: null });
  }
  meters.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const e = o.extra_usage;
  const used = num(e?.used_credits);
  const limit = num(e?.monthly_limit);
  const extra = e && typeof e === 'object' && (used != null || limit != null)
    ? { used_usd: used == null ? null : used / 100, limit_usd: limit == null ? null : limit / 100, percent: pct(e.utilization) ?? (used != null && limit ? pct((used / limit) * 100) : null) }
    : null;
  return { meters, extra };
}

/** The OAuth token from Claude Code's credentials file, or null. Never logged. */
function token(): string | null {
  try {
    const file = process.env.PA_CLAUDE_CREDENTIALS || path.join(os.homedir(), '.claude', '.credentials.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8'))?.claudeAiOauth?.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

let cache: { at: number; ttl: number; value: Json } | null = null;
let lastGood: Json | null = null;
let inflight: Promise<Json> | null = null;

async function fetchOnce(): Promise<Json> {
  const t = token();
  const now = new Date().toISOString();
  if (!t) return { ok: false, reason: 'no Claude Code login found', fetched_at: now };
  try {
    const res = await fetch(URL_USAGE, {
      headers: { Authorization: `Bearer ${t}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after')) * 1000;
      return { ok: false, reason: 'usage endpoint rate-limited', fetched_at: now, retry_ms: Math.max(Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** strikes++), Number.isFinite(after) ? Math.min(after, BACKOFF_MAX_MS) : 0) };
    }
    if (!res.ok) return { ok: false, reason: `usage endpoint answered ${res.status}`, fetched_at: now };
    const { meters, extra } = parseUsage(await res.json());
    if (!meters.length && !extra) return { ok: false, reason: 'usage payload had no limits', fetched_at: now };
    return { ok: true, meters, extra, fetched_at: now };
  } catch (e) {
    log.warn('usage fetch failed', { message: (e as Error).message });
    return { ok: false, reason: 'usage endpoint unreachable', fetched_at: now };
  }
}

/**
 * The limits, cached a minute (failures too, so a dead endpoint is not
 * hammered; a 429 waits out its Retry-After); a burst shares one call. While
 * failing, the last good numbers are served with `stale: true` and the reason.
 */
async function usage(): Promise<Json> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.value;
  inflight ??= fetchOnce().then((v) => {
    if (v.ok) {
      lastGood = v;
      strikes = 0;
      writeLast(v);
    }
    lastGood ??= readLast();
    const ttl = Number(v.retry_ms) || TTL_MS;
    const { retry_ms: _drop, ...plain } = v;
    const value = !v.ok && lastGood ? { ...lastGood, stale: true, reason: v.reason } : plain;
    cache = { at: Date.now(), ttl, value };
    return value;
  }).finally(() => { inflight = null; });
  return inflight;
}

/** Ends the cache window but keeps the last good numbers (tests). */
function expireCache() {
  cache = null;
}

function resetCache() {
  cache = null;
  lastGood = null;
  strikes = 0;
  inflight = null;
}

module.exports = { usage, parseUsage, severityOf, resetCache, expireCache, URL_USAGE };
